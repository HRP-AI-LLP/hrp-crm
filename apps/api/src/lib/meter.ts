/**
 * Usage metering: every call the platform makes to an outside service (AI models, email, WhatsApp /
 * Meta, Razorpay and bank feeds, GST APIs, Google, Microsoft, Zoom, GitHub, Cloudflare…), every
 * request the Worker serves and every database query, counted per workspace and day.
 *
 * `installMeter()` wraps the global fetch once; a request (or job) runs inside `metered()`, which
 * keeps its counts in memory and writes them in one statement at the end (`flushMeter`), so the
 * cost is a map increment per call and one upsert per request.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type Bucket = { calls: number; errors: number; units: number; ms: number; gauge?: boolean };
type Store = { tenantId: string | null; buf: Map<string, Bucket> };

const als = new AsyncLocalStorage<Store>();
/** Counts made outside any request or job (rare): kept until the next flush. */
const loose: Store = { tenantId: null, buf: new Map() };

const RULES: [RegExp, string][] = [
  [/(^|\.)api\.openai\.com$/, 'openai'],
  [/(^|\.)api\.anthropic\.com$/, 'anthropic'],
  [/^generativelanguage\.googleapis\.com$/, 'gemini'],
  [/(^|\.)api\.groq\.com$/, 'groq'],
  [/(^|\.)openrouter\.ai$/, 'openrouter'],
  [/(^|\.)api\.resend\.com$/, 'resend'],
  [/(^|\.)graph\.facebook\.com$/, 'meta'],
  [/(^|\.)api\.razorpay\.com$/, 'razorpay'],
  [/(^|\.)(gstinapi\.in|whitebooks\.in|resilient\.tech)$/, 'gst_api'],
  [/(^|\.)(googleapis\.com|accounts\.google\.com)$/, 'google'],
  [/(^|\.)(graph\.microsoft\.com|login\.microsoftonline\.com|dynamics\.com)$/, 'microsoft'],
  [/(^|\.)zoom\.us$/, 'zoom'],
  [/(^|\.)exotel\.(com|in)$/, 'exotel'],
  [/(^|\.)(api\.github\.com|github\.com)$/, 'github'],
  [/(^|\.)dev\.azure\.com$/, 'azure_devops'],
  [/(^|\.)api\.cloudflare\.com$/, 'cloudflare'],
  [/(^|\.)(hooks\.slack\.com|slack\.com)$/, 'slack'],
  [/(^|\.)app\.asana\.com$/, 'asana'],
  [/(^|\.)gem\.gov\.in$/, 'gem'],
  [/(^|\.)incometax\.gov\.in$/, 'income_tax'],
  [/(^|\.)api\.frankfurter\.dev$/, 'fx_rates'],
];

/** The service a URL belongs to, and what kind of call it is (for the few services billed per kind). */
export function classify(url: string, body?: unknown): { provider: string; kind: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.endsWith('.internal') || u.hostname === 'localhost' || u.hostname === '127.0.0.1') return null;
  const provider = RULES.find(([re]) => re.test(u.hostname))?.[1] ?? 'other';
  let kind = 'call';
  if (provider === 'meta' && /\/messages$/.test(u.pathname)) kind = typeof body === 'string' && /"type"\s*:\s*"template"/.test(body) ? 'whatsapp_template' : 'whatsapp_message';
  else if (provider === 'razorpay' && /\/(transactions|settlements|accounts)/.test(u.pathname)) kind = 'bank_feed';
  else if (provider === 'razorpay' && /payment_links/.test(u.pathname)) kind = 'payment_link';
  else if (provider === 'resend' && /\/emails/.test(u.pathname)) kind = 'email';
  else if (provider === 'google' && u.hostname === 'gmail.googleapis.com') kind = 'gmail';
  else if (provider === 'google' && u.hostname === 'fcm.googleapis.com') kind = 'push';
  return { provider: provider === 'other' ? `other:${u.hostname}`.slice(0, 80) : provider, kind };
}

const store = () => als.getStore() ?? loose;
const key = (provider: string, kind: string) => `${provider}\u0000${kind}`;

/** Adds to a counter of the current request / job. */
export function meter(provider: string, kind: string, add: Partial<Bucket> = {}) {
  const s = store();
  const k = key(provider, kind);
  const b = s.buf.get(k) ?? { calls: 0, errors: 0, units: 0, ms: 0 };
  b.calls += add.calls ?? 1;
  b.errors += add.errors ?? 0;
  b.units += add.units ?? 0;
  b.ms += add.ms ?? 0;
  if (add.gauge) b.gauge = true;
  s.buf.set(k, b);
}

/** A level that is set, not added (stored bytes, database size): the day keeps the latest. */
export function gauge(provider: string, kind: string, value: number, tenantId?: string | null) {
  const s = tenantId === undefined ? store() : { tenantId, buf: new Map<string, Bucket>() };
  s.buf.set(key(provider, kind), { calls: 0, errors: 0, units: value, ms: 0, gauge: true });
  return s;
}

/** Which workspace the current request turned out to be for (known after the tenant is resolved). */
export function meterTenant(tenantId: string | null) {
  const s = als.getStore();
  if (s && tenantId) s.tenantId = tenantId;
}

let installed = false;
/** Wraps the global fetch so every outside call is counted. Safe to call more than once. */
export function installMeter() {
  if (installed) return;
  installed = true;
  const inner = globalThis.fetch;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const c = classify(url, init?.body);
    if (!c) return inner(input, init);
    const t0 = Date.now();
    try {
      const res = await inner(input, init);
      meter(c.provider, c.kind, { errors: res.status >= 400 ? 1 : 0, ms: Date.now() - t0 });
      return res;
    } catch (e) {
      meter(c.provider, c.kind, { errors: 1, ms: Date.now() - t0 });
      throw e;
    }
  };
  // tests stub fetch after install: keep calling whatever is current underneath
  globalThis.fetch = wrapped as typeof fetch;
}

/** Runs a request or job with its own counters. */
export function metered<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
  return als.run({ tenantId, buf: new Map() }, fn);
}

export function takeCounts(s: Store = store()) {
  const rows = [...s.buf].map(([k, b]) => {
    const [provider, kind] = k.split('\u0000') as [string, string];
    return { tenantId: s.tenantId, provider, kind, ...b };
  });
  s.buf.clear();
  if (s !== loose && loose.buf.size) rows.push(...takeCounts(loose));
  return rows;
}

type Sql = { platform: (sql: string, params: unknown[]) => Promise<unknown[]> };

/** Writes the counts of the current request / job (and any loose ones) in one statement. */
export async function flushMeter(db: Sql, rows = takeCounts()) {
  if (!rows.length) return;
  const day = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10); // India's day
  await db.platform(
    `insert into usage_daily (day, tenant_key, provider, kind, calls, errors, units, ms)
     select $1::date, coalesce(t, '00000000-0000-0000-0000-000000000000'::uuid), p, k, c, e, u, m
       from unnest($2::uuid[], $3::text[], $4::text[], $5::bigint[], $6::bigint[], $7::numeric[], $8::bigint[], $9::boolean[]) as x(t, p, k, c, e, u, m, g)
     on conflict (day, tenant_key, provider, kind) do update set
       calls = usage_daily.calls + excluded.calls, errors = usage_daily.errors + excluded.errors, ms = usage_daily.ms + excluded.ms,
       units = case when usage_daily.kind like '%\\_bytes' then excluded.units else usage_daily.units + excluded.units end`,
    [
      day,
      rows.map((r) => r.tenantId),
      rows.map((r) => r.provider),
      rows.map((r) => r.kind),
      rows.map((r) => Math.round(r.calls)),
      rows.map((r) => Math.round(r.errors)),
      rows.map((r) => r.units),
      rows.map((r) => Math.round(r.ms)),
      rows.map((r) => !!r.gauge),
    ],
  );
}
