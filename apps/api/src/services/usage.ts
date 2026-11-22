/**
 * Usage & costs: what the platform uses of every outside service, and what it costs.
 *
 *  · usage: counted as it happens (lib/meter.ts) — calls and errors per service, AI tokens per model
 *    service, WhatsApp template messages, emails, Worker requests and jobs, database queries, stored
 *    bytes and the database's size;
 *  · cost this month: the usage priced with an editable price list (plan fees + unit prices, USD or
 *    INR), projected to the month's end;
 *  · bills: what the services actually charged, from the bills in Books (GitHub, Cloudflare, Neon,
 *    OpenAI… receipts read from mail), month by month, next to the estimate.
 *
 * A workspace's admins see their workspace; platform admins can see the whole platform.
 */
import { z } from 'zod';
import type { Db, Tx } from '../lib/db';
import { flushMeter, gauge, takeCounts } from '../lib/meter';

export const PLATFORM_KEY = '00000000-0000-0000-0000-000000000000';

type Unit = { per: number; price: number; free?: number; label: string };
export type ServicePrice = { label: string; group: string; currency: 'USD' | 'INR'; monthly: number; units: Record<string, Unit>; vendor?: string };
export type Prices = { usdInr: number; services: Record<string, ServicePrice> };

const GB = 1024 ** 3;
/**
 * Defaults: list prices as published in 2026 for the plans a small SaaS on this stack uses. They are
 * estimates — set your own in the price list (your plan, your contract, the INR rate your card uses).
 */
export const DEFAULT_PRICES: Prices = {
  usdInr: 88,
  services: {
    workers: { label: 'Cloudflare Workers', group: 'Hosting', currency: 'USD', monthly: 5, vendor: 'cloudflare', units: { request: { per: 1e6, price: 0.3, free: 10e6, label: 'requests' }, job: { per: 1e6, price: 0, label: 'queue jobs' }, cron: { per: 1, price: 0, label: 'cron runs' } } },
    r2: { label: 'Cloudflare R2 (files)', group: 'Hosting', currency: 'USD', monthly: 0, vendor: 'cloudflare', units: { stored_bytes: { per: GB, price: 0.015, free: 10 * GB, label: 'stored' } } },
    neon: { label: 'Neon Postgres', group: 'Database', currency: 'USD', monthly: 0, vendor: 'neon', units: { query: { per: 1e6, price: 0, label: 'queries' }, db_bytes: { per: GB, price: 0.35, free: 0.5 * GB, label: 'database size' } } },
    'ai:groq': { label: 'Groq (AI)', group: 'AI models', currency: 'USD', monthly: 0, vendor: 'groq', units: { input_tokens: { per: 1e6, price: 0.59, label: 'input tokens' }, output_tokens: { per: 1e6, price: 0.79, label: 'output tokens' } } },
    'ai:gemini': { label: 'Google Gemini (AI)', group: 'AI models', currency: 'USD', monthly: 0, vendor: 'google', units: { input_tokens: { per: 1e6, price: 0.3, label: 'input tokens' }, output_tokens: { per: 1e6, price: 2.5, label: 'output tokens' } } },
    'ai:openai': { label: 'OpenAI (AI)', group: 'AI models', currency: 'USD', monthly: 0, vendor: 'openai', units: { input_tokens: { per: 1e6, price: 0.4, label: 'input tokens' }, output_tokens: { per: 1e6, price: 1.6, label: 'output tokens' } } },
    'ai:anthropic': { label: 'Anthropic (AI)', group: 'AI models', currency: 'USD', monthly: 0, vendor: 'anthropic', units: { input_tokens: { per: 1e6, price: 3, label: 'input tokens' }, output_tokens: { per: 1e6, price: 15, label: 'output tokens' } } },
    'ai:workers-ai': { label: 'Workers AI', group: 'AI models', currency: 'USD', monthly: 0, vendor: 'cloudflare', units: { input_tokens: { per: 1e6, price: 0, label: 'input tokens' }, output_tokens: { per: 1e6, price: 0, label: 'output tokens' } } },
    resend: { label: 'Resend (email)', group: 'Messaging', currency: 'USD', monthly: 0, vendor: 'resend', units: { email: { per: 1000, price: 0.9, free: 3000, label: 'emails' } } },
    meta: { label: 'Meta / WhatsApp', group: 'Messaging', currency: 'INR', monthly: 0, vendor: 'meta', units: { whatsapp_template: { per: 1, price: 0.8, label: 'template messages' }, whatsapp_message: { per: 1, price: 0, label: 'replies in the 24 h window' } } },
    exotel: { label: 'Exotel (calls)', group: 'Messaging', currency: 'INR', monthly: 0, vendor: 'exotel', units: {} },
    razorpay: { label: 'Razorpay & RazorpayX (bank feed)', group: 'Payments & banking', currency: 'INR', monthly: 0, vendor: 'razorpay', units: { payment_link: { per: 1, price: 0, label: 'payment link calls' }, bank_feed: { per: 1, price: 0, label: 'bank feed calls' } } },
    gst_api: { label: 'GST APIs (GSP / GSTIN lookup)', group: 'Compliance', currency: 'INR', monthly: 0, vendor: 'gst', units: { call: { per: 1, price: 0, label: 'calls' } } },
    google: { label: 'Google (Gmail, Calendar, Meet)', group: 'Mail & meetings', currency: 'USD', monthly: 0, vendor: 'google', units: {} },
    microsoft: { label: 'Microsoft (Outlook, Teams)', group: 'Mail & meetings', currency: 'USD', monthly: 0, vendor: 'microsoft', units: {} },
    zoom: { label: 'Zoom', group: 'Mail & meetings', currency: 'USD', monthly: 0, vendor: 'zoom', units: {} },
    github: { label: 'GitHub', group: 'Development', currency: 'USD', monthly: 0, vendor: 'github', units: {} },
    cloudflare: { label: 'Cloudflare API', group: 'Hosting', currency: 'USD', monthly: 0, vendor: 'cloudflare', units: {} },
  },
};

/** Bill vendors → the service they bill for (the names suppliers put on their receipts). */
const VENDORS: [RegExp, string][] = [
  [/github/i, 'github'],
  [/cloudflare/i, 'cloudflare'],
  [/\bneon\b|neon\s*(inc|database|tech)/i, 'neon'],
  [/openai/i, 'openai'],
  [/anthropic/i, 'anthropic'],
  [/\bgroq\b/i, 'groq'],
  [/google|gsuite|workspace/i, 'google'],
  [/microsoft|azure|office\s*365/i, 'microsoft'],
  [/meta\s*platforms|facebook|whatsapp/i, 'meta'],
  [/razorpay/i, 'razorpay'],
  [/resend/i, 'resend'],
  [/\bzoom\b/i, 'zoom'],
  [/exotel/i, 'exotel'],
  [/whitebooks|gstinapi|resilient|masters\s*india|cleartax/i, 'gst'],
];
export const vendorService = (name: string) => VENDORS.find(([re]) => re.test(name))?.[1] ?? null;

/** Which price entry a counted provider falls under (the AI model APIs' raw calls count with their token row). */
function serviceOf(provider: string) {
  const own = provider.endsWith(':own_key');
  const p = own ? provider.slice(0, -':own_key'.length) : provider;
  const alias: Record<string, string> = { groq: 'ai:groq', gemini: 'ai:gemini', openai: 'ai:openai', anthropic: 'ai:anthropic', openrouter: 'ai:openrouter' };
  return { key: alias[p] ?? p, own };
}

export async function getPrices(db: Db): Promise<Prices> {
  const r = await db.platform<{ data: Partial<Prices> }>(`select data from usage_prices where id = 1`);
  const saved = r[0]?.data ?? {};
  const services = { ...DEFAULT_PRICES.services };
  for (const [k, v] of Object.entries(saved.services ?? {})) services[k] = { ...(services[k] ?? { label: k, group: 'Other', currency: 'USD', monthly: 0, units: {} }), ...v, units: { ...(services[k]?.units ?? {}), ...(v.units ?? {}) } };
  return { usdInr: Number(saved.usdInr ?? DEFAULT_PRICES.usdInr), services };
}

export const pricesSchema = z.object({
  usdInr: z.number().positive().max(1000),
  services: z.record(
    z.string().max(100),
    z.object({
      label: z.string().max(100).optional(),
      group: z.string().max(60).optional(),
      currency: z.enum(['USD', 'INR']).optional(),
      monthly: z.number().min(0).max(1e9).optional(),
      units: z.record(z.string().max(60), z.object({ per: z.number().positive(), price: z.number().min(0), free: z.number().min(0).optional(), label: z.string().max(60) })).optional(),
    }),
  ),
});

export async function savePrices(db: Db, userId: string, input: z.infer<typeof pricesSchema>) {
  await db.platform(`insert into usage_prices (id, data, updated_by, updated_at) values (1, $1, $2, now()) on conflict (id) do update set data = excluded.data, updated_by = excluded.updated_by, updated_at = now()`, [
    JSON.stringify(input),
    userId,
  ]);
  return getPrices(db);
}

/** Daily: what each workspace keeps in file storage, and the database's size (levels, not sums). */
export async function storageGauges(db: Db, tenantIds: string[]) {
  for (const t of tenantIds) {
    const r = await db.tx({ tenantId: t, readOnly: true }, (tx) => tx.one<{ b: string }>(`select coalesce(sum(size_bytes), 0) as b from files where tenant_id = $1 and deleted_at is null`, [t]));
    await flushMeter(db, takeCounts(gauge('r2', 'stored_bytes', Number(r?.b ?? 0), t)));
  }
  const size = await db.platform<{ b: string }>(`select pg_database_size(current_database()) as b`);
  await flushMeter(db, takeCounts(gauge('neon', 'db_bytes', Number(size[0]?.b ?? 0), null)));
  await db.platform(`delete from usage_daily where day < current_date - 400`);
}

const monthOf = (d: string) => d.slice(0, 7);
const indiaToday = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

type Row = { month: string; provider: string; kind: string; calls: number; errors: number; units: number; ms: number };

/**
 * The report: per month and service, the usage, the estimated cost in INR and (for the workspace's own
 * books) the bills received. `tenantKey` null = the whole platform.
 */
export type BillRow = { id: string; bill_number: string | null; vendor_ref: string | null; vendor: string; bill_date: string; currency: string; total: number; inr: number };

/** The workspace's bills from its suppliers (the services' own invoices and receipts, read into Books). */
export async function booksBills(tx: Tx, tenantId: string, months: number): Promise<BillRow[]> {
  return tx.query<BillRow>(
    `select b.id, b.bill_number, b.vendor_ref, v.name as vendor, b.bill_date::text as bill_date, b.currency, b.grand_total::float8 as total, (b.grand_total * b.exchange_rate)::float8 as inr
       from bills b join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.status <> 'void' and b.deleted_at is null and b.bill_date >= (date_trunc('month', current_date) - make_interval(months => $2))::date
      order by b.bill_date desc limit 2000`,
    [tenantId, months],
  );
}

export async function usageReport(db: Db, opts: { tenantKey: string | null; months: number; bills?: BillRow[] }) {
  const prices = await getPrices(db);
  const today = indiaToday();
  const from = new Date(Date.parse(`${today.slice(0, 7)}-01T00:00:00Z`));
  from.setUTCMonth(from.getUTCMonth() - (opts.months - 1));
  const since = from.toISOString().slice(0, 10);
  // sums for counters; the latest level of the month for the *_bytes gauges
  const rows = (await db.platform(
    `with d as (select day, provider, kind, sum(calls) as calls, sum(errors) as errors, sum(units) as units, sum(ms) as ms from usage_daily
                 where day >= $1::date and ($2::uuid is null or tenant_key = $2::uuid) group by day, provider, kind)
     select to_char(day, 'YYYY-MM') as month, provider, kind, sum(calls)::float8 as calls, sum(errors)::float8 as errors,
            (case when kind like '%\\_bytes' then (array_agg(units order by day desc))[1] else sum(units) end)::float8 as units, sum(ms)::float8 as ms
       from d group by 1, 2, 3 order by 1 desc, 2, 3`,
    [since, opts.tenantKey],
  )) as Row[];

  const months: string[] = [];
  for (let i = 0; i < opts.months; i++) {
    const m = new Date(from);
    m.setUTCMonth(from.getUTCMonth() + i);
    months.unshift(m.toISOString().slice(0, 7));
  }
  const current = today.slice(0, 7);
  const dayOfMonth = Number(today.slice(8, 10));
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const inr = (v: number, cur: 'USD' | 'INR') => (cur === 'USD' ? v * prices.usdInr : v);

  type Svc = { key: string; label: string; group: string; ownKey: boolean; months: Record<string, { calls: number; errors: number; ms: number; units: Record<string, number>; cost: number }> };
  const svcs = new Map<string, Svc>();
  for (const r of rows) {
    const { key, own } = serviceOf(r.provider);
    const id = own ? `${key}:own_key` : key;
    const p = prices.services[key];
    const s = svcs.get(id) ?? { key: id, label: `${p?.label ?? r.provider.replace(/^other:/, '')}${own ? ' — workspace’s own key' : ''}`, group: p?.group ?? (r.provider.startsWith('other:') ? 'Other' : 'Other'), ownKey: own, months: {} };
    const m = (s.months[r.month] ??= { calls: 0, errors: 0, ms: 0, units: {}, cost: 0 });
    // token rows carry units only; the raw API calls of a model service carry the call counts
    if (!['input_tokens', 'output_tokens', 'stored_bytes', 'db_bytes'].includes(r.kind)) {
      m.calls += r.calls;
      m.errors += r.errors;
      m.ms += r.ms;
    }
    m.units[r.kind] = (m.units[r.kind] ?? 0) + (r.units || (['input_tokens', 'output_tokens', 'stored_bytes', 'db_bytes'].includes(r.kind) ? 0 : r.calls));
    svcs.set(id, s);
  }
  // price it: plan fee + units above the free allowance (a workspace's own AI key is billed to it, not to the platform)
  for (const s of svcs.values()) {
    const p = prices.services[s.key.replace(/:own_key$/, '')];
    if (!p || s.ownKey) continue;
    for (const [month, m] of Object.entries(s.months)) {
      let c = 0;
      for (const [kind, u] of Object.entries(p.units)) {
        const used = m.units[kind] ?? 0;
        c += (Math.max(0, used - (u.free ?? 0)) / u.per) * u.price;
      }
      m.cost = inr(c, p.currency);
      void month;
    }
  }
  // plan fees: every month, for every priced service with a fee (whether or not it was used)
  if (!opts.tenantKey)
    for (const [key, p] of Object.entries(prices.services)) {
      if (!p.monthly) continue;
      const s = svcs.get(key) ?? { key, label: p.label, group: p.group, ownKey: false, months: {} };
      for (const month of months) {
        const m = (s.months[month] ??= { calls: 0, errors: 0, ms: 0, units: {}, cost: 0 });
        m.cost += inr(p.monthly, p.currency);
      }
      svcs.set(key, s);
    }

  const bills = (opts.bills ?? []).filter((b) => b.bill_date >= since);
  const billed = bills.map((b) => ({ ...b, service: vendorService(b.vendor), month: monthOf(b.bill_date) })).filter((b) => b.service);

  const services = [...svcs.values()]
    .map((s) => ({
      ...s,
      thisMonth: s.months[current] ?? null,
      projected: s.months[current] ? Math.round((s.months[current]!.cost * (s.ownKey ? 0 : 1) * daysInMonth) / Math.max(1, dayOfMonth)) : 0,
    }))
    .sort((a, b) => (b.thisMonth?.cost ?? 0) - (a.thisMonth?.cost ?? 0) || (b.thisMonth?.calls ?? 0) - (a.thisMonth?.calls ?? 0));
  const byMonth = months.map((month) => ({
    month,
    estimate: Math.round(services.reduce((t, s) => t + (s.ownKey ? 0 : (s.months[month]?.cost ?? 0)), 0)),
    billed: Math.round(billed.filter((b) => b.month === month).reduce((t, b) => t + b.inr, 0)),
    calls: services.reduce((t, s) => t + (s.months[month]?.calls ?? 0), 0),
  }));
  const fixedFees = Object.values(prices.services).reduce((t, p) => t + (opts.tenantKey ? 0 : inr(p.monthly, p.currency)), 0);
  const usageSoFar = services.reduce((t, s) => t + (s.ownKey ? 0 : (s.months[current]?.cost ?? 0)), 0) - fixedFees;
  return {
    current,
    dayOfMonth,
    daysInMonth,
    months,
    totals: {
      thisMonth: Math.round(usageSoFar + fixedFees),
      projected: Math.round(fixedFees + (usageSoFar * daysInMonth) / Math.max(1, dayOfMonth)),
      lastMonthBilled: byMonth[1]?.billed ?? 0,
      lastMonthEstimate: byMonth[1]?.estimate ?? 0,
      callsThisMonth: byMonth[0]?.calls ?? 0,
      errorsThisMonth: services.reduce((t, s) => t + (s.months[current]?.errors ?? 0), 0),
    },
    byMonth,
    services,
    bills: billed,
    prices,
  };
}

/** Platform view: the workspaces that use the most this month. */
export async function topWorkspaces(db: Db) {
  const month = `${indiaToday().slice(0, 7)}-01`;
  return db.platform<{ tenant_key: string; name: string | null; calls: number; tokens: number; requests: number }>(
    `select u.tenant_key, t.name,
            sum(u.calls) filter (where u.provider not in ('neon','workers'))::float8 as calls,
            sum(u.units) filter (where u.kind in ('input_tokens','output_tokens'))::float8 as tokens,
            sum(u.calls) filter (where u.provider = 'workers')::float8 as requests
       from usage_daily u left join tenants t on t.id = u.tenant_key
      where u.day >= $1::date group by u.tenant_key, t.name order by 3 desc nulls last limit 50`,
    [month],
  );
}

/** CSV of the report: one row per month and service. */
export function reportCsv(r: Awaited<ReturnType<typeof usageReport>>) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['month', 'service', 'group', 'calls', 'errors', 'usage', 'estimated cost (INR)', 'billed (INR)'].join(',')];
  for (const month of r.months)
    for (const s of r.services) {
      const m = s.months[month];
      if (!m) continue;
      const svcBills = r.bills.filter((b) => b.month === month && s.key.includes(b.service ?? '~')).reduce((t, b) => t + b.inr, 0);
      const usage = Object.entries(m.units)
        .map(([k, v]) => `${k}=${Math.round(v)}`)
        .join('; ');
      lines.push([month, s.label, s.group, m.calls, m.errors, usage, Math.round(m.cost), Math.round(svcBills)].map(esc).join(','));
    }
  return lines.join('\n');
}
