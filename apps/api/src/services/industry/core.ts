/**
 * Customer-level views that cut across sales, billing and delivery: the parent / child company tree
 * with roll-ups, customer profitability (revenue less goods, labour, direct purchases, expenses and
 * free spare parts), win / loss analysis with loss reasons and competitors, and credit control
 * (limit and hold, checked when an order is confirmed, with an approval to let one through).
 */
import { hasAdmin, LOSS_REASONS, objectPerm } from '@synapse/shared';
import { ApiError, badRequest, forbidden, notFound } from '../../lib/errors';
import type { Tx } from '../../lib/db';
import type { RecordCtx, RecordEvent } from '../records';
import { updateRecord } from '../records';

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => Number(v ?? 0) || 0;
export const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** Start of the Indian financial year a date falls in. */
export function fyStart(d = todayIst()) {
  const y = Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1;
  return `${y}-04-01`;
}

export function assertAccountRead(ctx: RecordCtx) {
  if (objectPerm(ctx.principal.permissions, 'account').read === 'none') throw forbidden('You cannot see accounts');
}

/** Costs and margins: finance, project, manufacturing or operations admins, or people who see every invoice. */
export function canSeeMargins(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  return ['books', 'billing', 'projects', 'manufacturing', 'operations', 'margins'].some((a) => hasAdmin(p, a as 'books'));
}
export function assertMargins(ctx: RecordCtx) {
  if (!canSeeMargins(ctx)) throw forbidden('Margins need finance access');
}

/** The account and everything under it (ids), at most 12 levels deep. */
export async function familyIds(tx: Tx, tenantId: string, rootId: string): Promise<string[]> {
  const rows = await tx.query<{ id: string }>(
    `with recursive t(id, depth) as (
       select id, 0 from accounts where tenant_id = $1 and id = $2 and deleted_at is null
       union all
       select a.id, t.depth + 1 from accounts a join t on a.parent_account_id = t.id where a.tenant_id = $1 and a.deleted_at is null and t.depth < 12)
     select distinct id from t`,
    [tenantId, rootId],
  );
  return rows.map((r) => r.id);
}

/* ───────────── parent / child companies ───────────── */

export async function accountFamily(ctx: RecordCtx, id: string) {
  assertAccountRead(ctx);
  const self = await ctx.tx.one<{ id: string; name: string; parent_account_id: string | null }>(`select id, name, parent_account_id from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!self) throw notFound('Account not found');
  // walk up to the top of the group
  const parents: { id: string; name: string }[] = [];
  let cur = self.parent_account_id;
  while (cur && parents.length < 12) {
    const p = await ctx.tx.one<{ id: string; name: string; parent_account_id: string | null }>(`select id, name, parent_account_id from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, cur]);
    if (!p) break;
    parents.unshift({ id: p.id, name: p.name });
    cur = p.parent_account_id;
  }
  const topId = parents[0]?.id ?? self.id;
  const nodes = await ctx.tx.query<{ id: string; name: string; parent_account_id: string | null; city: string | null; account_type: string | null; depth: number }>(
    `with recursive t(id, depth) as (
       select id, 0 from accounts where tenant_id = $1 and id = $2 and deleted_at is null
       union all
       select a.id, t.depth + 1 from accounts a join t on a.parent_account_id = t.id where a.tenant_id = $1 and a.deleted_at is null and t.depth < 12)
     select a.id, a.name, a.parent_account_id, a.city, a.account_type, t.depth from t join accounts a on a.tenant_id = $1 and a.id = t.id order by t.depth, a.name`,
    [ctx.tenantId, topId],
  );
  const ids = nodes.map((n) => n.id);
  const from = fyStart();
  const stats = await ctx.tx.query<{ id: string; open_pipeline: string; won_fy: string; billed_fy: string; outstanding: string; contacts: number }>(
    `select a.id,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.account_id = a.id and d.deleted_at is null and s.category = 'open') as open_pipeline,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = a.tenant_id and d.account_id = a.id and d.deleted_at is null and s.category = 'won' and d.closed_at >= $3::date) as won_fy,
            (select coalesce(sum(case when i.doc_type = 'credit_note' then -1 else 1 end * i.taxable_total * coalesce(i.exchange_rate, 1)), 0) from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date >= $3::date) as billed_fy,
            (select coalesce(sum(i.balance_due), 0) from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid')) as outstanding,
            (select count(*)::int from contacts c where c.tenant_id = a.tenant_id and c.account_id = a.id and c.deleted_at is null) as contacts
       from accounts a where a.tenant_id = $1 and a.id = any($2::uuid[])`,
    [ctx.tenantId, ids, from],
  );
  const by = new Map(stats.map((s) => [s.id, s]));
  const out = nodes.map((n) => {
    const s = by.get(n.id);
    return { id: n.id, name: n.name, parentId: n.parent_account_id, city: n.city, type: n.account_type, depth: n.depth, openPipeline: num(s?.open_pipeline), wonFy: num(s?.won_fy), billedFy: num(s?.billed_fy), outstanding: num(s?.outstanding), contacts: s?.contacts ?? 0 };
  });
  // group totals: each node with everything under it
  const children = new Map<string, string[]>();
  for (const n of out) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const byId = new Map(out.map((n) => [n.id, n]));
  const roll = (nid: string, seen = new Set<string>()): { openPipeline: number; wonFy: number; billedFy: number; outstanding: number } => {
    const n = byId.get(nid)!;
    seen.add(nid);
    const t = { openPipeline: n.openPipeline, wonFy: n.wonFy, billedFy: n.billedFy, outstanding: n.outstanding };
    for (const c of children.get(nid) ?? []) {
      if (seen.has(c)) continue;
      const k = roll(c, seen);
      t.openPipeline += k.openPipeline;
      t.wonFy += k.wonFy;
      t.billedFy += k.billedFy;
      t.outstanding += k.outstanding;
    }
    return t;
  };
  return { selfId: self.id, topId, parents, nodes: out.map((n) => ({ ...n, group: roll(n.id) })), fyFrom: from };
}

/* ───────────── customer profitability ───────────── */

export interface ProfitRow {
  accountId: string;
  name: string;
  revenue: number;
  goods: number;
  labour: number;
  purchases: number;
  expenses: number;
  service: number;
  cost: number;
  margin: number;
  marginPct: number | null;
  invoices: number;
  outstanding: number;
}

export async function profitability(ctx: RecordCtx, q: { from: string; to: string; accountId?: string | null; includeChildren?: boolean; limit?: number }) {
  assertMargins(ctx);
  const ids = q.accountId ? (q.includeChildren ? await familyIds(ctx.tx, ctx.tenantId, q.accountId) : [q.accountId]) : null;
  const p = [ctx.tenantId, q.from, q.to, ids];
  const filt = (col: string) => `($4::uuid[] is null or ${col} = any($4::uuid[]))`;
  const rev = await ctx.tx.query<{ account_id: string; revenue: string; invoices: number }>(
    `select account_id, sum(case when doc_type = 'credit_note' then -1 else 1 end * taxable_total * coalesce(exchange_rate, 1)) as revenue, count(*) filter (where doc_type = 'tax_invoice')::int as invoices
       from invoices where tenant_id = $1 and deleted_at is null and doc_type <> 'proforma' and status not in ('draft','cancelled') and invoice_date between $2::date and $3::date and account_id is not null and ${filt('account_id')}
      group by account_id`,
    p,
  );
  const goods = await ctx.tx.query<{ account_id: string; v: string }>(
    `select i.account_id, sum(case when i.doc_type = 'credit_note' then -1 else 1 end * l.quantity * coalesce(nullif(pr.avg_cost, 0), nullif(pr.purchase_price, 0), pr.cost_price, 0)) as v
       from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.order_id join products pr on pr.tenant_id = l.tenant_id and pr.id = l.product_id
      where l.tenant_id = $1 and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date between $2::date and $3::date and ${filt('i.account_id')}
      group by i.account_id`,
    p,
  );
  const labour = await ctx.tx.query<{ account_id: string; v: string }>(
    `select pj.account_id, sum(t.minutes / 60.0 * coalesce(t.cost_rate, 0)) as v
       from time_entries t join projects pj on pj.tenant_id = t.tenant_id and pj.id = t.project_id
      where t.tenant_id = $1 and t.work_date between $2::date and $3::date and pj.account_id is not null and ${filt('pj.account_id')}
      group by pj.account_id`,
    p,
  );
  const purchases = await ctx.tx.query<{ account_id: string; v: string }>(
    `select coalesce(l.billable_account_id, pj.account_id) as account_id, sum(l.line_subtotal * coalesce(b.exchange_rate, 1)) as v
       from bill_lines l join bills b on b.tenant_id = l.tenant_id and b.id = l.order_id
       left join projects pj on pj.tenant_id = l.tenant_id and pj.id = coalesce(l.project_id, b.project_id)
      where l.tenant_id = $1 and b.deleted_at is null and b.doc_type = 'bill' and b.status not in ('draft','void') and b.bill_date between $2::date and $3::date
        and coalesce(l.billable_account_id, pj.account_id) is not null and ${filt('coalesce(l.billable_account_id, pj.account_id)')}
      group by 1`,
    p,
  );
  const expenses = await ctx.tx.query<{ account_id: string; v: string }>(
    `select coalesce(e.customer_id, pj.account_id) as account_id, sum(coalesce(e.taxable_amount, e.amount) * coalesce(e.exchange_rate, 1)) as v
       from expenses e left join projects pj on pj.tenant_id = e.tenant_id and pj.id = e.project_id
      where e.tenant_id = $1 and e.deleted_at is null and e.status not in ('draft','rejected','void') and e.expense_date between $2::date and $3::date
        and coalesce(e.customer_id, pj.account_id) is not null and ${filt('coalesce(e.customer_id, pj.account_id)')}
      group by 1`,
    p,
  );
  const service = await ctx.tx.query<{ account_id: string; v: string }>(
    `select t.account_id, sum(tp.quantity * coalesce(nullif(pr.avg_cost, 0), nullif(pr.purchase_price, 0), pr.cost_price, 0)) as v
       from ticket_parts tp join tickets t on t.tenant_id = tp.tenant_id and t.id = tp.ticket_id join products pr on pr.tenant_id = tp.tenant_id and pr.id = tp.product_id
      where tp.tenant_id = $1 and not tp.chargeable and tp.issued_at::date between $2::date and $3::date and t.account_id is not null and ${filt('t.account_id')}
      group by t.account_id`,
    p,
  );
  const rows = new Map<string, ProfitRow>();
  const row = (id: string) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { accountId: id, name: '', revenue: 0, goods: 0, labour: 0, purchases: 0, expenses: 0, service: 0, cost: 0, margin: 0, marginPct: null, invoices: 0, outstanding: 0 }));
    return r;
  };
  for (const x of rev) Object.assign(row(x.account_id), { revenue: num(x.revenue), invoices: x.invoices });
  for (const x of goods) row(x.account_id).goods = num(x.v);
  for (const x of labour) row(x.account_id).labour = num(x.v);
  for (const x of purchases) row(x.account_id).purchases = num(x.v);
  for (const x of expenses) row(x.account_id).expenses = num(x.v);
  for (const x of service) row(x.account_id).service = num(x.v);
  if (!rows.size) return { from: q.from, to: q.to, rows: [] as ProfitRow[], totals: totalsOf([]) };
  const names = await ctx.tx.query<{ id: string; name: string; outstanding: string }>(
    `select a.id, a.name, (select coalesce(sum(i.balance_due), 0) from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid')) as outstanding
       from accounts a where a.tenant_id = $1 and a.id = any($2::uuid[])`,
    [ctx.tenantId, [...rows.keys()]],
  );
  for (const n of names) Object.assign(row(n.id), { name: n.name, outstanding: num(n.outstanding) });
  const list = [...rows.values()]
    .filter((r) => r.name)
    .map((r) => {
      const cost = r.goods + r.labour + r.purchases + r.expenses + r.service;
      const margin = r.revenue - cost;
      return { ...r, revenue: r2(r.revenue), goods: r2(r.goods), labour: r2(r.labour), purchases: r2(r.purchases), expenses: r2(r.expenses), service: r2(r.service), cost: r2(cost), margin: r2(margin), marginPct: r.revenue > 0 ? Math.round((margin / r.revenue) * 1000) / 10 : null };
    })
    .sort((a, b) => b.margin - a.margin);
  return { from: q.from, to: q.to, rows: list.slice(0, q.limit ?? 500), totals: totalsOf(list) };
}

function totalsOf(list: ProfitRow[]) {
  const t = list.reduce((s, r) => ({ revenue: s.revenue + r.revenue, cost: s.cost + r.cost, margin: s.margin + r.margin }), { revenue: 0, cost: 0, margin: 0 });
  return { revenue: r2(t.revenue), cost: r2(t.cost), margin: r2(t.margin), marginPct: t.revenue > 0 ? Math.round((t.margin / t.revenue) * 1000) / 10 : null, customers: list.length, lossMaking: list.filter((r) => r.margin < 0).length };
}

/* ───────────── win / loss ───────────── */

export async function lossReasons(ctx: RecordCtx) {
  const f = ctx.meta.objects.find((o) => o.key === 'deal')?.fields.find((x) => x.key === 'loss_reason');
  return (f?.options?.choices as { value: string; label: string }[] | undefined) ?? LOSS_REASONS.map((v) => ({ value: v, label: v }));
}

/** Moves a deal to its pipeline's lost stage with the reason (and the competitor that won it). */
export async function markLost(ctx: RecordCtx, dealId: string, input: { reason: string; lostTo?: string | null; note?: string | null }): Promise<RecordEvent[]> {
  const d = await ctx.tx.one<{ pipeline_id: string; version: number }>(`select pipeline_id, version from deals where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, dealId]);
  if (!d) throw notFound('Deal not found');
  const lost = await ctx.tx.one<{ id: string }>(`select id from pipeline_stages where tenant_id = $1 and pipeline_id = $2 and category = 'lost' order by position limit 1`, [ctx.tenantId, d.pipeline_id]);
  if (!lost) throw badRequest('This pipeline has no lost stage');
  const r = await updateRecord(ctx, 'deal', dealId, { stage_id: lost.id, loss_reason: input.reason, lost_to: input.lostTo ?? null, loss_note: input.note ?? null });
  return r.events;
}

export async function winLoss(ctx: RecordCtx, q: { from: string; to: string; ownerId?: string | null; pipelineId?: string | null }) {
  if (objectPerm(ctx.principal.permissions, 'deal').read === 'none') throw forbidden('You cannot see deals');
  const rows = await ctx.tx.query<{ id: string; name: string; amount: string | null; cat: string; loss_reason: string | null; lost_to: string | null; owner: string | null; source: string | null; days: number | null; closed: string; account: string | null }>(
    `select d.id, d.name, d.amount, s.category as cat, d.loss_reason, nullif(trim(d.lost_to), '') as lost_to, u.full_name as owner, d.source,
            greatest(0, (coalesce(d.closed_at, d.updated_at)::date - d.created_at::date))::int as days, to_char(coalesce(d.closed_at, d.updated_at), 'YYYY-MM') as closed, a.name as account
       from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
       left join users u on u.tenant_id = d.tenant_id and u.id = d.owner_id
       left join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id
      where d.tenant_id = $1 and d.deleted_at is null and s.category in ('won','lost')
        and coalesce(d.closed_at, d.updated_at)::date between $2::date and $3::date
        and ($4::uuid is null or d.owner_id = $4) and ($5::uuid is null or d.pipeline_id = $5)`,
    [ctx.tenantId, q.from, q.to, q.ownerId ?? null, q.pipelineId ?? null],
  );
  const won = rows.filter((r) => r.cat === 'won');
  const lost = rows.filter((r) => r.cat === 'lost');
  const sum = (l: typeof rows) => r2(l.reduce((s, r) => s + num(r.amount), 0));
  const avg = (l: number[]) => (l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null);
  const group = (key: (r: (typeof rows)[number]) => string | null, l = rows) => {
    const m = new Map<string, { key: string; won: number; lost: number; wonValue: number; lostValue: number }>();
    for (const r of l) {
      const k = key(r) ?? '(not set)';
      const g = m.get(k) ?? { key: k, won: 0, lost: 0, wonValue: 0, lostValue: 0 };
      if (r.cat === 'won') {
        g.won++;
        g.wonValue += num(r.amount);
      } else {
        g.lost++;
        g.lostValue += num(r.amount);
      }
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, wonValue: r2(g.wonValue), lostValue: r2(g.lostValue), winRate: g.won + g.lost ? Math.round((g.won / (g.won + g.lost)) * 1000) / 10 : null })).sort((a, b) => b.won + b.lost - (a.won + a.lost));
  };
  const reasons = await lossReasons(ctx);
  const label = (v: string | null) => (v ? (reasons.find((x) => x.value === v)?.label ?? v) : null);
  return {
    from: q.from,
    to: q.to,
    won: won.length,
    lost: lost.length,
    wonValue: sum(won),
    lostValue: sum(lost),
    winRate: rows.length ? Math.round((won.length / rows.length) * 1000) / 10 : null,
    winRateByValue: sum(rows) > 0 ? Math.round((sum(won) / sum(rows)) * 1000) / 10 : null,
    avgWon: won.length ? r2(sum(won) / won.length) : null,
    avgLost: lost.length ? r2(sum(lost) / lost.length) : null,
    cycleWon: avg(won.map((r) => r.days ?? 0)),
    cycleLost: avg(lost.map((r) => r.days ?? 0)),
    byReason: group((r) => label(r.loss_reason), lost),
    byCompetitor: group((r) => r.lost_to, lost),
    byOwner: group((r) => r.owner),
    bySource: group((r) => r.source),
    byMonth: group((r) => r.closed).sort((a, b) => a.key.localeCompare(b.key)),
    recentLost: lost.sort((a, b) => b.closed.localeCompare(a.closed)).slice(0, 25).map((r) => ({ id: r.id, name: r.name, account: r.account, amount: num(r.amount), reason: label(r.loss_reason), lostTo: r.lost_to })),
  };
}

/* ───────────── credit control ───────────── */

/** The account whose limit applies: its own, else the nearest parent company that has one. */
async function limitHolder(tx: Tx, tenantId: string, accountId: string) {
  let cur: string | null = accountId;
  for (let i = 0; cur && i < 12; i++) {
    const a: { id: string; name: string; credit_limit: string | null; credit_hold: boolean; parent_account_id: string | null } | null = await tx.one(
      `select id, name, credit_limit, credit_hold, parent_account_id from accounts where tenant_id = $1 and id = $2 and deleted_at is null`,
      [tenantId, cur],
    );
    if (!a) return null;
    if (a.credit_limit != null || a.credit_hold) return a;
    cur = a.parent_account_id;
  }
  return null;
}

export async function creditStatus(ctx: RecordCtx, accountId: string, excludeOrderId?: string | null) {
  const holder = await limitHolder(ctx.tx, ctx.tenantId, accountId);
  const ids = holder ? await familyIds(ctx.tx, ctx.tenantId, holder.id) : [accountId];
  const rec = await ctx.tx.one<{ v: string; overdue: string }>(
    `select coalesce(sum(balance_due), 0) as v, coalesce(sum(balance_due) filter (where due_date < current_date), 0) as overdue
       from invoices where tenant_id = $1 and account_id = any($2::uuid[]) and deleted_at is null and doc_type = 'tax_invoice' and status in ('issued','partially_paid')`,
    [ctx.tenantId, ids],
  );
  const open = await ctx.tx.one<{ v: string }>(
    `select coalesce(sum(greatest(o.grand_total - coalesce((select sum(i.grand_total) from invoices i where i.tenant_id = o.tenant_id and i.sales_order_id = o.id and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status not in ('draft','cancelled')), 0), 0)), 0) as v
       from sales_orders o where o.tenant_id = $1 and o.account_id = any($2::uuid[]) and o.deleted_at is null
        and o.status in ('confirmed','in_production','ready','dispatched','delivered','installed') and ($3::uuid is null or o.id <> $3)`,
    [ctx.tenantId, ids, excludeOrderId ?? null],
  );
  const limit = holder?.credit_limit != null ? num(holder.credit_limit) : null;
  const exposure = r2(num(rec?.v) + num(open?.v));
  return {
    accountId,
    limitAccountId: holder?.id ?? null,
    limitAccountName: holder && holder.id !== accountId ? holder.name : null,
    limit,
    hold: !!holder?.credit_hold,
    receivables: r2(num(rec?.v)),
    overdue: r2(num(rec?.overdue)),
    openOrders: r2(num(open?.v)),
    exposure,
    available: limit == null ? null : r2(limit - exposure),
  };
}

/** Called when an order is confirmed: over the limit or on hold needs an approval first. */
export async function assertCredit(ctx: RecordCtx, order: Record<string, unknown>) {
  if (!order.account_id || order.credit_approved_at) return;
  const s = await creditStatus(ctx, String(order.account_id), String(order.id));
  if (s.hold) throw new ApiError(409, 'credit_hold', 'This customer is on credit hold. Ask finance to approve the order on credit.', s);
  if (s.limit != null && s.exposure + num(order.grand_total) > s.limit + 0.005) {
    throw new ApiError(409, 'credit_limit', `This order takes the customer past the credit limit (₹${s.limit.toLocaleString('en-IN')}; owed and on order ₹${s.exposure.toLocaleString('en-IN')}). Ask finance to approve it.`, s);
  }
}

export function canApproveCredit(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  return hasAdmin(p, 'books') || hasAdmin(p, 'billing') || hasAdmin(p, 'credit');
}

export async function approveCredit(ctx: RecordCtx, orderId: string, note: string | null) {
  if (!canApproveCredit(ctx)) throw forbidden('Approving credit needs the "Approve credit" permission');
  const r = await ctx.tx.one<{ id: string }>(
    `update sales_orders set credit_approved_by = $3, credit_approved_at = now(), credit_note = $4 where tenant_id = $1 and id = $2 and deleted_at is null and status = 'draft' returning id`,
    [ctx.tenantId, orderId, ctx.principal.user.id, note],
  );
  if (!r) throw badRequest('Only draft orders can be approved on credit');
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, actor_id) values ($1,'system','Approved on credit',$3,'sales_order',$2,$4)`, [ctx.tenantId, orderId, note, ctx.principal.user.id]);
  return { ok: true };
}

/** Asks the people who may approve credit (books / billing admins, else the workspace owner). */
export async function requestCredit(ctx: RecordCtx, orderId: string, note: string | null) {
  const o = await ctx.tx.one<{ order_number: string; account: string | null; grand_total: string }>(
    `select o.order_number, a.name as account, o.grand_total from sales_orders o left join accounts a on a.tenant_id = o.tenant_id and a.id = o.account_id where o.tenant_id = $1 and o.id = $2`,
    [ctx.tenantId, orderId],
  );
  if (!o) throw notFound('Order not found');
  const to = await ctx.tx.query<{ id: string }>(
    `select distinct u.id from users u
      where u.tenant_id = $1 and u.status = 'active' and (u.is_owner or exists (
        select 1 from user_roles ur join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
         where ur.tenant_id = u.tenant_id and ur.user_id = u.id and (r.permissions -> 'admin' ? 'books' or r.permissions -> 'admin' ? 'billing' or r.permissions -> 'admin' ? 'credit' or r.permissions -> 'admin' ? '*')))`,
    [ctx.tenantId],
  );
  for (const u of to) {
    if (u.id === ctx.principal.user.id) continue;
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'approval',$3,$4,$5)`, [
      ctx.tenantId, u.id, `Credit approval: ${o.order_number}`, `${o.account ?? ''} · ₹${num(o.grand_total).toLocaleString('en-IN')}${note ? ` — ${note}` : ''}`, `/o/sales_order/${orderId}`,
    ]);
  }
  return { asked: to.length };
}

/** Customers over their limit or on hold (for the credit desk). */
export async function creditWatch(ctx: RecordCtx) {
  assertAccountRead(ctx);
  const list = await ctx.tx.query<{ id: string; name: string }>(`select id, name from accounts where tenant_id = $1 and deleted_at is null and (credit_limit is not null or credit_hold) order by name limit 500`, [ctx.tenantId]);
  const out = [];
  for (const a of list) out.push({ name: a.name, ...(await creditStatus(ctx, a.id)) });
  const drafts = await ctx.tx.query<{ id: string; order_number: string; grand_total: number; account: string; account_id: string }>(
    `select o.id, o.order_number, o.grand_total::float8 as grand_total, a.name as account, o.account_id from sales_orders o join accounts a on a.tenant_id = o.tenant_id and a.id = o.account_id
      where o.tenant_id = $1 and o.status = 'draft' and o.deleted_at is null and o.credit_approved_at is null order by o.created_at desc limit 200`,
    [ctx.tenantId],
  );
  // a draft needs approval when its customer (or a parent company) is on hold or would go past the limit
  const pending = [];
  for (const o of drafts) {
    const s = await creditStatus(ctx, o.account_id, o.id);
    if (s.hold || (s.limit != null && s.exposure + o.grand_total > s.limit + 0.005)) pending.push({ ...o, limit: s.limit, exposure: s.exposure, hold: s.hold });
  }
  return { accounts: out.sort((a, b) => (a.available ?? 0) - (b.available ?? 0)), draftOrders: pending, canApprove: canApproveCredit(ctx) };
}
