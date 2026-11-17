/**
 * Live bank feeds: transactions pulled from a provider's API into bank_transactions, so the accounts
 * desk works on them without anyone downloading a statement.
 *
 * RazorpayX is the first provider (GET /v1/transactions for a RazorpayX current account or Lite
 * account, basic auth with the key id and secret). A bank's own corporate API (ICICI, HDFC, Axis…)
 * plugs in the same way once the bank onboards the workspace: implement FeedProvider.fetch.
 *
 * Credentials are sealed with DATA_ENCRYPTION_KEY (bound to the workspace) and never returned.
 * Provider calls happen outside database transactions.
 */
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { ApiError, badRequest, notFound } from '../../lib/errors';
import { activeOf, readSecret } from '../integrations';
import type { RazorpaySecret } from '../payments-online';
import type { RecordCtx } from '../records';
import { bankAccount, importStatement, type StatementRow } from './banking';
import { assertBooksAdmin } from './ledger';

export type FeedProviderId = 'razorpayx';

export interface FeedSecrets {
  keyId: string;
  keySecret: string;
}
export interface FeedFetch {
  rows: StatementRow[];
  /** where the next sync starts (provider-specific) */
  cursor: string | null;
  more: boolean;
}
interface FeedProvider {
  id: FeedProviderId;
  label: string;
  /** a cheap call that proves the credentials and account work */
  check(env: Env, s: FeedSecrets, accountRef: string): Promise<{ balance: number | null }>;
  fetch(env: Env, s: FeedSecrets, accountRef: string, from: Date, cursor: string | null): Promise<FeedFetch>;
}

const rzpBase = (env: Env) => (env.RAZORPAYX_BASE_URL ?? 'https://api.razorpay.com').replace(/\/+$/, '');

async function rzp(env: Env, s: FeedSecrets, path: string, q: Record<string, string>) {
  const url = new URL(rzpBase(env) + path);
  for (const [k, v] of Object.entries(q)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString(), { headers: { accept: 'application/json', authorization: `Basic ${btoa(`${s.keyId}:${s.keySecret}`)}` }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ApiError(504, 'feed_unreachable', 'Could not reach RazorpayX; try again in a minute');
  }
  const j: any = await res.json().catch(() => null);
  if (res.status === 401) throw new ApiError(502, 'feed_auth', 'RazorpayX refused the key id or secret (Settings → API Keys in the RazorpayX dashboard)');
  if (res.status === 429) throw new ApiError(429, 'rate_limited', 'RazorpayX is rate-limiting; try again in a minute');
  if (!res.ok) throw new ApiError(502, 'feed_error', `RazorpayX: ${String(j?.error?.description ?? `HTTP ${res.status}`).slice(0, 300)}`);
  return j;
}

/** A RazorpayX transaction as a statement line (amounts are in paise; credit is money in). */
export function razorpayxRow(t: any): StatementRow | null {
  const credit = Number(t.credit ?? 0);
  const debit = Number(t.debit ?? 0);
  const amount = (credit > 0 ? credit : -(debit > 0 ? debit : Number(t.amount ?? 0))) / 100;
  if (!amount || !t.id) return null;
  const at = new Date(Number(t.created_at) * 1000 + 5.5 * 3_600_000); // IST date
  const src = t.source ?? {};
  let description: string;
  let counterparty: string | null = null;
  let reference: string | null = null;
  if (src.entity === 'payout') {
    counterparty = src.fund_account?.contact?.name ?? src.notes?.name ?? null;
    reference = src.utr ?? null;
    description = ['Payout', src.mode, counterparty, src.narration ?? src.purpose, src.utr].filter(Boolean).join(' ');
  } else if (src.entity === 'bank_transfer') {
    counterparty = src.payer_name ?? null;
    reference = src.bank_reference ?? null;
    description = [src.mode ?? 'Transfer', 'from', counterparty ?? src.payer_account, src.bank_reference].filter(Boolean).join(' ');
  } else {
    description = [src.entity ?? 'Transaction', src.description ?? src.notes?.description, src.utr ?? src.bank_reference].filter(Boolean).join(' ');
    reference = src.utr ?? src.bank_reference ?? null;
  }
  return {
    date: at.toISOString().slice(0, 10),
    description: description.slice(0, 500) || t.id,
    reference,
    amount: Math.round(amount * 100) / 100,
    balance: t.balance != null ? Number(t.balance) / 100 : null,
    externalId: `rzpx:${t.id}`,
    counterparty,
  };
}

const PROVIDERS: Record<FeedProviderId, FeedProvider> = {
  razorpayx: {
    id: 'razorpayx',
    label: 'RazorpayX',
    async check(env, s, accountRef) {
      const j = await rzp(env, s, '/v1/transactions', { account_number: accountRef, count: '1' });
      const t = j?.items?.[0];
      return { balance: t?.balance != null ? Number(t.balance) / 100 : null };
    },
    async fetch(env, s, accountRef, from, cursor) {
      // cursor = unix seconds of the newest line already fetched; RazorpayX lists newest first
      const since = cursor ? Number(cursor) : Math.floor(from.getTime() / 1000);
      const rows: StatementRow[] = [];
      let newest = since;
      let skip = 0;
      let more = false;
      for (let page = 0; page < 20; page++) {
        const j = await rzp(env, s, '/v1/transactions', { account_number: accountRef, from: String(since), count: '100', skip: String(skip) });
        const items: any[] = Array.isArray(j?.items) ? j.items : [];
        for (const t of items) {
          const r = razorpayxRow(t);
          if (r) rows.push(r);
          newest = Math.max(newest, Number(t.created_at) || 0);
        }
        if (items.length < 100) break;
        skip += 100;
        if (page === 19) more = true;
      }
      // overlap by a minute next time: the line ids keep duplicates out
      return { rows, cursor: String(Math.max(since, newest - 60)), more };
    },
  },
};

export const feedProviders = () => Object.values(PROVIDERS).map((p) => ({ id: p.id, label: p.label }));

const encKey = (env: Env) => {
  if (!env.DATA_ENCRYPTION_KEY) throw badRequest('This server has no DATA_ENCRYPTION_KEY, so bank feed keys cannot be stored');
  return env.DATA_ENCRYPTION_KEY;
};

type FeedRow = { id: string; bank_account_id: string; provider: FeedProviderId; label: string | null; account_ref: string; secret_ciphertext: string; status: string; synced_from: string | null; cursor: string | null; last_synced_at: string | null; last_error: string | null };

const feedDto = (f: FeedRow & { account?: string }) => ({
  id: f.id,
  bankAccountId: f.bank_account_id,
  account: f.account ?? null,
  provider: f.provider,
  providerLabel: PROVIDERS[f.provider]?.label ?? f.provider,
  label: f.label,
  accountRef: `••••${f.account_ref.slice(-4)}`,
  status: f.status,
  syncedFrom: f.synced_from,
  lastSyncedAt: f.last_synced_at,
  lastError: f.last_error,
});

export interface FeedDeps {
  env: Env;
  run<T>(fn: (ctx: RecordCtx) => Promise<T>): Promise<T>;
}

export async function listFeeds(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  const rows = await ctx.tx.query<FeedRow & { account: string }>(
    `select f.*, to_char(f.synced_from, 'YYYY-MM-DD') as synced_from, a.name as account from bank_feeds f join bank_accounts b on b.tenant_id = f.tenant_id and b.id = f.bank_account_id
       join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where f.tenant_id = $1 order by f.created_at`,
    [ctx.tenantId],
  );
  return rows.map(feedDto);
}

/** Connects a feed: the credentials are checked with the provider before anything is stored. */
export async function connectFeed(deps: FeedDeps, input: { bankAccountId: string; provider: FeedProviderId; accountRef: string; keyId: string; keySecret: string; label?: string | null; syncFrom?: string | null }) {
  const p = PROVIDERS[input.provider];
  if (!p) throw badRequest('Unknown bank feed provider');
  await deps.run(async (ctx) => {
    await assertBooksAdmin(ctx);
    const b = await bankAccount(ctx, input.bankAccountId);
    if (b.kind !== 'bank') throw badRequest('Connect a feed to a bank account');
  });
  const secrets: FeedSecrets = { keyId: input.keyId.trim(), keySecret: input.keySecret.trim() };
  const checked = await p.check(deps.env, secrets, input.accountRef.trim());
  const sealed = await deps.run(async (ctx) => encryptSecret(encKey(deps.env), JSON.stringify(secrets), ctx.tenantId));
  const from = input.syncFrom ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
  const row = await deps.run(async (ctx) => {
    const r = await ctx.tx.one<FeedRow>(
      `insert into bank_feeds (tenant_id, bank_account_id, provider, label, account_ref, secret_ciphertext, synced_from)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tenant_id, provider, account_ref) do update set bank_account_id = excluded.bank_account_id, label = excluded.label, secret_ciphertext = excluded.secret_ciphertext, status = 'active', last_error = null
       returning *, to_char(synced_from, 'YYYY-MM-DD') as synced_from`,
      [ctx.tenantId, input.bankAccountId, input.provider, input.label ?? null, input.accountRef.trim(), sealed, from],
    );
    return r!;
  });
  return { ...feedDto(row), balance: checked.balance };
}

export async function updateFeed(ctx: RecordCtx, id: string, input: { status?: 'active' | 'paused' }) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one(`update bank_feeds set status = coalesce($3, status), last_error = case when $3 = 'active' then null else last_error end where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, input.status ?? null]);
  if (!r) throw notFound('Feed not found');
  return { ok: true };
}

export async function deleteFeed(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  await ctx.tx.query(`delete from bank_feeds where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Pulls new lines from one feed into the bank account (no rules applied: the accounts desk decides). */
export async function syncFeed(deps: FeedDeps, id: string) {
  const f = await deps.run(async (ctx) => {
    await assertBooksAdmin(ctx);
    const r = await ctx.tx.one<FeedRow>(`select *, to_char(synced_from, 'YYYY-MM-DD') as synced_from from bank_feeds where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (!r) throw notFound('Feed not found');
    return { ...r, secrets: JSON.parse(await decryptSecret(encKey(deps.env), r.secret_ciphertext, ctx.tenantId)) as FeedSecrets };
  });
  const p = PROVIDERS[f.provider];
  let got: FeedFetch;
  try {
    got = await p.fetch(deps.env, f.secrets, f.account_ref, new Date(`${f.synced_from ?? new Date().toISOString().slice(0, 10)}T00:00:00+05:30`), f.cursor);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 1000);
    await deps.run((ctx) => ctx.tx.query(`update bank_feeds set status = 'error', last_error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, msg]));
    throw e;
  }
  return deps.run(async (ctx) => {
    const r = got.rows.length ? await importStatement(ctx, f.bank_account_id, got.rows, { source: 'feed', auto: false }) : { added: 0, skipped: 0, batch: null };
    await ctx.tx.query(`update bank_feeds set cursor = $3, last_synced_at = now(), status = 'active', last_error = null where tenant_id = $1 and id = $2`, [ctx.tenantId, id, got.cursor]);
    return { feedId: id, bankAccountId: f.bank_account_id, fetched: got.rows.length, added: r.added, skipped: r.skipped, more: got.more };
  });
}

/** Every active feed of the workspace (the bank clerk's job); one failing feed doesn't stop the others. */
export async function syncAllFeeds(deps: FeedDeps) {
  const ids = await deps.run(async (ctx) => (await ctx.tx.query<{ id: string }>(`select id from bank_feeds where tenant_id = $1 and status in ('active','error') order by created_at`, [ctx.tenantId])).map((x) => x.id));
  const out: { feedId: string; added?: number; fetched?: number; error?: string }[] = [];
  for (const id of ids) {
    try {
      out.push(await syncFeed(deps, id));
    } catch (e) {
      out.push({ feedId: id, error: (e as Error).message });
    }
  }
  return out;
}

/* ───────────── payment gateway settlements (Razorpay) ───────────── */

/**
 * Razorpay pays out online collections as one net settlement (collections − fee − GST on the fee).
 * The bank clerk keeps each settlement so the bookkeeper can book the bank credit against the gateway
 * clearing account the receipts went to. Uses the workspace's Razorpay integration (Settings →
 * Integrations); without one there is nothing to do.
 */
export async function syncGatewaySettlements(deps: FeedDeps) {
  const got = await deps.run(async (ctx) => {
    const i = await activeOf(ctx.tx, ctx.tenantId, 'razorpay').catch(() => null);
    if (!i) return null;
    const s = await readSecret<RazorpaySecret>(deps.env, i);
    const last = await ctx.tx.one<{ at: string | null }>(`select max(settled_at)::text as at from gateway_settlements where tenant_id = $1 and provider = 'razorpay'`, [ctx.tenantId]);
    return { keyId: i.account_ref as string, keySecret: s.keySecret, since: last?.at ? Date.parse(last.at) - 3 * 86_400_000 : Date.now() - 60 * 86_400_000 };
  });
  if (!got) return { connected: false, fetched: 0, added: 0 };
  const items: any[] = [];
  for (let page = 0, skip = 0; page < 10; page++, skip += 100) {
    const j = await rzp(deps.env, { keyId: got.keyId, keySecret: got.keySecret }, '/v1/settlements', { from: String(Math.floor(got.since / 1000)), count: '100', skip: String(skip) });
    const xs: any[] = Array.isArray(j?.items) ? j.items : [];
    items.push(...xs);
    if (xs.length < 100) break;
  }
  return deps.run(async (ctx) => {
    let added = 0;
    for (const x of items) {
      if (!x?.id) continue;
      const r = await ctx.tx.one(
        `insert into gateway_settlements (tenant_id, provider, settlement_id, amount, fees, tax, utr, status, settled_at)
         values ($1,'razorpay',$2,$3,$4,$5,$6,$7,to_timestamp($8))
         on conflict (tenant_id, provider, settlement_id) do update set status = excluded.status, utr = coalesce(excluded.utr, gateway_settlements.utr) returning (xmax = 0) as inserted`,
        [ctx.tenantId, String(x.id), Number(x.amount ?? 0) / 100, Number(x.fees ?? 0) / 100, Number(x.tax ?? 0) / 100, x.utr ?? null, String(x.status ?? 'processed'), Number(x.created_at) || Math.floor(Date.now() / 1000)],
      );
      if ((r as any)?.inserted) added++;
    }
    return { connected: true, fetched: items.length, added };
  });
}
