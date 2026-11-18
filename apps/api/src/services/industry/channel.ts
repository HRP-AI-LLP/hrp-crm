/**
 * Selling through dealers and distributors: dealer performance (deals they referred, what they buy,
 * outstanding, territory and tier), schemes that pay a percentage of their won deals or purchases,
 * territory sales, and the dealer portal (their orders, invoices, referred deals, scheme earnings and
 * price list, plus registering a new lead) behind a private link.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { randomToken } from '../../lib/crypto';
import type { Tx } from '../../lib/db';
import { createRecord, type RecordCtx } from '../records';
import { r2, todayIst } from './core';
import { bookFor } from './pricing';

const num = (v: unknown) => Number(v ?? 0) || 0;
export const DEALER_TYPES = ['dealer', 'distributor', 'partner'];

function assertChannelRead(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'channel') || hasAdmin(p, 'analytics') || objectPerm(p, 'account').read === 'all') return;
  throw forbidden('Dealer reports need the "Dealers & schemes" permission');
}
function assertChannelAdmin(ctx: RecordCtx) {
  if (!hasAdmin(ctx.principal.permissions, 'channel')) throw forbidden('Needs the "Dealers & schemes" permission');
}

/** Each dealer's numbers for a period. */
export async function dealerPerformance(tx: Tx, tenantId: string, q: { from: string; to: string; dealerId?: string | null }) {
  return tx.query<{
    id: string; name: string; account_type: string; dealer_tier: string | null; territory: string | null; city: string | null; portal: boolean;
    referred: number; won: number; won_value: string; lost: number; open_value: string; purchases: string; outstanding: string; leads: number;
  }>(
    `select a.id, a.name, a.account_type, a.dealer_tier, a.territory, a.city, (a.public_token is not null) as portal,
            (select count(*)::int from deals d where d.tenant_id = a.tenant_id and d.referred_by_id = a.id and d.deleted_at is null and d.created_at::date between $2::date and $3::date) as referred,
            (select count(*)::int from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.referred_by_id = a.id and d.deleted_at is null and s.category = 'won' and d.closed_at::date between $2::date and $3::date) as won,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.referred_by_id = a.id and d.deleted_at is null and s.category = 'won' and d.closed_at::date between $2::date and $3::date) as won_value,
            (select count(*)::int from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.referred_by_id = a.id and d.deleted_at is null and s.category = 'lost' and d.closed_at::date between $2::date and $3::date) as lost,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.referred_by_id = a.id and d.deleted_at is null and s.category = 'open') as open_value,
            (select coalesce(sum(case when i.doc_type = 'credit_note' then -1 else 1 end * i.taxable_total * coalesce(i.exchange_rate, 1)), 0) from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date between $2::date and $3::date) as purchases,
            (select coalesce(sum(i.balance_due), 0) from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid')) as outstanding,
            (select count(*)::int from leads l where l.tenant_id = a.tenant_id and l.referred_by_id = a.id and l.deleted_at is null and l.created_at::date between $2::date and $3::date) as leads
       from accounts a where a.tenant_id = $1 and a.deleted_at is null and a.account_type = any($4::text[]) and ($5::uuid is null or a.id = $5)
      order by a.name`,
    [tenantId, q.from, q.to, DEALER_TYPES, q.dealerId ?? null],
  );
}

async function activeSchemes(tx: Tx, tenantId: string, from: string, to: string) {
  return tx.query<{ id: string; name: string; starts_on: string; ends_on: string; basis: 'won_deals' | 'invoices'; dealer_tier: string | null; rate_pct: string; min_value: string; status: string }>(
    `select id, name, starts_on::text, ends_on::text, basis, dealer_tier, rate_pct, min_value, status from dealer_schemes where tenant_id = $1 and starts_on <= $3::date and ends_on >= $2::date order by starts_on`,
    [tenantId, from, to],
  );
}

/** What a scheme pays each eligible dealer (base in the scheme's own dates). */
async function payouts(tx: Tx, tenantId: string, scheme: Awaited<ReturnType<typeof activeSchemes>>[number], dealerId?: string | null) {
  const perf = await dealerPerformance(tx, tenantId, { from: scheme.starts_on, to: scheme.ends_on, dealerId });
  return perf
    .filter((d) => !scheme.dealer_tier || d.dealer_tier === scheme.dealer_tier)
    .map((d) => {
      const base = scheme.basis === 'won_deals' ? num(d.won_value) : num(d.purchases);
      const qualifies = base >= num(scheme.min_value) && base > 0;
      return { dealerId: d.id, dealer: d.name, tier: d.dealer_tier, base: r2(base), qualifies, payout: qualifies ? r2((base * num(scheme.rate_pct)) / 100) : 0, gap: qualifies ? 0 : r2(num(scheme.min_value) - base) };
    });
}

export async function channelOverview(ctx: RecordCtx, q: { from: string; to: string }) {
  assertChannelRead(ctx);
  const perf = await dealerPerformance(ctx.tx, ctx.tenantId, q);
  const schemes = await activeSchemes(ctx.tx, ctx.tenantId, q.from, q.to);
  const earned = new Map<string, number>();
  for (const s of schemes) for (const p of await payouts(ctx.tx, ctx.tenantId, s)) earned.set(p.dealerId, (earned.get(p.dealerId) ?? 0) + p.payout);
  const dealers = perf.map((d) => ({
    id: d.id, name: d.name, type: d.account_type, tier: d.dealer_tier, territory: d.territory, city: d.city, portal: d.portal,
    referred: d.referred, won: d.won, lost: d.lost, wonValue: r2(num(d.won_value)), openValue: r2(num(d.open_value)), purchases: r2(num(d.purchases)), outstanding: r2(num(d.outstanding)), leads: d.leads,
    conversion: d.won + d.lost ? Math.round((d.won / (d.won + d.lost)) * 1000) / 10 : null,
    incentive: r2(earned.get(d.id) ?? 0),
  }));
  const byTerritory = new Map<string, { territory: string; dealers: number; wonValue: number; purchases: number }>();
  for (const d of dealers) {
    const k = d.territory ?? '(no territory)';
    const t = byTerritory.get(k) ?? { territory: k, dealers: 0, wonValue: 0, purchases: 0 };
    t.dealers++;
    t.wonValue += d.wonValue;
    t.purchases += d.purchases;
    byTerritory.set(k, t);
  }
  const sum = (f: (d: (typeof dealers)[number]) => number) => r2(dealers.reduce((s, d) => s + f(d), 0));
  return {
    from: q.from,
    to: q.to,
    dealers: dealers.sort((a, b) => b.wonValue + b.purchases - (a.wonValue + a.purchases)),
    byTerritory: [...byTerritory.values()].map((t) => ({ ...t, wonValue: r2(t.wonValue), purchases: r2(t.purchases) })).sort((a, b) => b.wonValue + b.purchases - (a.wonValue + a.purchases)),
    totals: { dealers: dealers.length, active: dealers.filter((d) => d.won || d.purchases || d.referred).length, wonValue: sum((d) => d.wonValue), purchases: sum((d) => d.purchases), incentive: sum((d) => d.incentive), outstanding: sum((d) => d.outstanding) },
  };
}

/* ───────────── schemes ───────────── */

export interface SchemeInput {
  name: string;
  startsOn: string;
  endsOn: string;
  basis: 'won_deals' | 'invoices';
  dealerTier?: string | null;
  ratePct: number;
  minValue?: number;
  status?: 'active' | 'closed';
}

export async function listSchemes(ctx: RecordCtx) {
  assertChannelRead(ctx);
  const list = await ctx.tx.query<Awaited<ReturnType<typeof activeSchemes>>[number]>(
    `select id, name, starts_on::text, ends_on::text, basis, dealer_tier, rate_pct, min_value, status from dealer_schemes where tenant_id = $1 order by status, ends_on desc`,
    [ctx.tenantId],
  );
  const out = [];
  for (const s of list) {
    const p = await payouts(ctx.tx, ctx.tenantId, s);
    out.push({ ...s, rate_pct: num(s.rate_pct), min_value: num(s.min_value), payouts: p.filter((x) => x.base > 0 || x.gap > 0).sort((a, b) => b.payout - a.payout), total: r2(p.reduce((t, x) => t + x.payout, 0)) });
  }
  return out;
}

export async function saveScheme(ctx: RecordCtx, id: string | null, input: SchemeInput) {
  assertChannelAdmin(ctx);
  if (input.endsOn < input.startsOn) throw badRequest('The scheme ends before it starts');
  const vals = [input.name, input.startsOn, input.endsOn, input.basis, input.dealerTier ?? null, input.ratePct, input.minValue ?? 0, input.status ?? 'active'];
  if (id) {
    const r = await ctx.tx.one(`update dealer_schemes set name = $3, starts_on = $4, ends_on = $5, basis = $6, dealer_tier = $7, rate_pct = $8, min_value = $9, status = $10 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, ...vals]);
    if (!r) throw notFound('Scheme not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into dealer_schemes (tenant_id, name, starts_on, ends_on, basis, dealer_tier, rate_pct, min_value, status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`, [ctx.tenantId, ...vals]);
  return { id: r!.id };
}

export async function deleteScheme(ctx: RecordCtx, id: string) {
  assertChannelAdmin(ctx);
  await ctx.tx.query(`delete from dealer_schemes where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/* ───────────── dealer portal ───────────── */

export async function setDealerPortal(ctx: RecordCtx, accountId: string, on: boolean) {
  assertChannelAdmin(ctx);
  const a = await ctx.tx.one<{ account_type: string | null; public_token: string | null }>(`select account_type, public_token from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, accountId]);
  if (!a) throw notFound('Account not found');
  if (on && !DEALER_TYPES.includes(a.account_type ?? '')) throw badRequest('Set the account type to dealer, distributor or partner first');
  const token = on ? (a.public_token ?? randomToken(24)) : null;
  await ctx.tx.query(`update accounts set public_token = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, accountId, token]);
  return { token };
}

/** What a dealer sees on their portal. */
export async function dealerPortal(tx: Tx, tenantId: string, accountId: string) {
  const a = await tx.one<{ name: string; dealer_tier: string | null; territory: string | null; company: string }>(
    `select a.name, a.dealer_tier, a.territory, t.name as company from accounts a join tenants t on t.id = a.tenant_id where a.tenant_id = $1 and a.id = $2 and a.deleted_at is null`,
    [tenantId, accountId],
  );
  if (!a) throw notFound();
  const from = `${todayIst().slice(0, 4)}-01-01`;
  const to = todayIst();
  const [orders, invoices, deals, perf] = await Promise.all([
    tx.query(
      `select order_number, status, fulfilment_status, order_date::text, expected_delivery_date::text, grand_total::float8 as grand_total, balance_due::float8 as balance_due from sales_orders
        where tenant_id = $1 and account_id = $2 and deleted_at is null and status <> 'draft' order by order_date desc limit 50`,
      [tenantId, accountId],
    ),
    tx.query(
      `select invoice_number, invoice_date::text, due_date::text, grand_total::float8 as grand_total, balance_due::float8 as balance_due, status from invoices
        where tenant_id = $1 and account_id = $2 and deleted_at is null and doc_type = 'tax_invoice' and status not in ('draft','cancelled') order by invoice_date desc limit 50`,
      [tenantId, accountId],
    ),
    tx.query(
      `select d.name, s.label as stage, s.category, d.amount::float8 as amount, d.created_at::date::text as created, d.closed_at::date::text as closed from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
        where d.tenant_id = $1 and d.referred_by_id = $2 and d.deleted_at is null order by d.created_at desc limit 50`,
      [tenantId, accountId],
    ),
    dealerPerformance(tx, tenantId, { from, to, dealerId: accountId }),
  ]);
  const schemes = [];
  for (const s of await activeSchemes(tx, tenantId, from, to)) {
    if (s.status !== 'active') continue;
    const p = (await payouts(tx, tenantId, s, accountId))[0];
    if (!p) continue;
    schemes.push({ name: s.name, endsOn: s.ends_on, ratePct: num(s.rate_pct), minValue: num(s.min_value), basis: s.basis, base: p.base, earned: p.payout, gap: p.gap });
  }
  const book = await bookFor(tx, tenantId, accountId, to);
  const prices = book
    ? await tx.query(
        `select p.name, p.sku, p.unit, e.min_qty::float8 as min_qty, e.unit_price::float8 as unit_price from price_book_entries e join products p on p.tenant_id = e.tenant_id and p.id = e.product_id
          where e.tenant_id = $1 and e.price_book_id = $2 and p.deleted_at is null and p.is_active order by p.name, e.min_qty limit 500`,
        [tenantId, book],
      )
    : [];
  const d = perf[0];
  return {
    company: a.company,
    dealer: { name: a.name, tier: a.dealer_tier, territory: a.territory },
    summary: { wonValue: num(d?.won_value), purchases: num(d?.purchases), outstanding: num(d?.outstanding), openValue: num(d?.open_value), referred: d?.referred ?? 0, leads: d?.leads ?? 0 },
    orders,
    invoices,
    deals,
    schemes,
    prices,
  };
}

/** A lead registered by a dealer from their portal (credited to them). */
export async function dealerLead(ctx: RecordCtx, accountId: string, input: { name: string; company?: string | null; phone?: string | null; email?: string | null; city?: string | null; requirement?: string | null }) {
  const [first, ...rest] = input.name.trim().split(/\s+/);
  const r = await createRecord(
    ctx,
    'lead',
    { first_name: first, last_name: rest.join(' ') || null, company: input.company ?? null, phone: input.phone ?? null, email: input.email ?? null, source: 'dealer', source_detail: [input.city, input.requirement].filter(Boolean).join(' · ').slice(0, 500) || 'Dealer portal', referred_by_id: accountId },
    { bypassPermissions: true, viaService: true, autoAssign: true },
  );
  return { id: String(r.record.id), events: r.events };
}
