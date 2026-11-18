/**
 * Quote-to-order for manufacturers: RFQs (a quote that starts as the customer's request), price lists
 * with quantity tiers and customer-specific lists, re-pricing a quote at the customer's prices, cost
 * and margin of a quote from BOM roll-ups, available-to-promise and promise dates per order line,
 * and rebate agreements with what has been earned so far.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { Tx } from '../../lib/db';
import { bomCost } from '../manufacturing';
import { getQuote, saveLines } from '../quotes';
import { createRecord, updateRecord, type RecordCtx, type RecordEvent } from '../records';
import { canSeeMargins, familyIds, r2, todayIst } from './core';

const num = (v: unknown) => Number(v ?? 0) || 0;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function assertPricingAdmin(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'pricing') || objectPerm(p, 'product').update === 'all') return;
  throw forbidden('Managing price lists needs the "Price lists & rebates" permission');
}

/* ───────────── RFQs ───────────── */

export async function createRfq(ctx: RecordCtx, input: { name: string; accountId: string; contactId?: string | null; dealId?: string | null; rfqNumber?: string | null; receivedOn?: string | null; dueOn?: string | null; customerRef?: string | null; notes?: string | null }) {
  const r = await createRecord(ctx, 'quote', {
    name: input.name,
    account_id: input.accountId,
    contact_id: input.contactId ?? null,
    deal_id: input.dealId ?? null,
    status: 'rfq',
    rfq_number: input.rfqNumber ?? null,
    rfq_received_on: input.receivedOn ?? todayIst(),
    rfq_due_on: input.dueOn ?? null,
    customer_ref: input.customerRef ?? null,
    notes: input.notes ?? null,
  });
  // customer's own price list first, else their assigned one, else the default
  const pb = await bookFor(ctx.tx, ctx.tenantId, input.accountId, todayIst());
  if (pb) await ctx.tx.query(`update quotes set price_book_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, pb]);
  return { id: String(r.record.id), events: r.events };
}

export async function listRfqs(ctx: RecordCtx, q: { open?: boolean }) {
  if (objectPerm(ctx.principal.permissions, 'quote').read === 'none') throw forbidden();
  return ctx.tx.query(
    `select q.id, q.name, q.quote_number, q.status, q.rfq_number, q.rfq_received_on, q.rfq_due_on, q.customer_ref, q.grand_total::float8 as grand_total, a.name as account, q.account_id,
            u.full_name as owner, (q.rfq_due_on is not null and q.rfq_due_on < current_date and q.status = 'rfq') as overdue,
            (select count(*)::int from quote_lines l where l.tenant_id = q.tenant_id and l.quote_id = q.id) as lines
       from quotes q left join accounts a on a.tenant_id = q.tenant_id and a.id = q.account_id left join users u on u.tenant_id = q.tenant_id and u.id = q.owner_id
      where q.tenant_id = $1 and q.deleted_at is null and (q.status = 'rfq' or (q.rfq_number is not null and not $2::boolean))
      order by (q.status = 'rfq') desc, q.rfq_due_on nulls last, q.created_at desc limit 300`,
    [ctx.tenantId, !!q.open],
  );
}

/** The RFQ has been priced: it becomes a draft quote ready for approval and sending. */
export async function rfqToQuote(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const q = await ctx.tx.one<{ status: string }>(`select status from quotes where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!q) throw notFound('Quote not found');
  if (q.status !== 'rfq') throw badRequest('This is no longer an RFQ');
  return (await updateRecord(ctx, 'quote', id, { status: 'draft' })).events;
}

/* ───────────── price lists and tiers ───────────── */

/** Which price book applies to a customer on a date. */
export async function bookFor(tx: Tx, tenantId: string, accountId: string | null, date: string): Promise<string | null> {
  if (accountId) {
    const own = await tx.one<{ id: string }>(
      `select id from price_books where tenant_id = $1 and account_id = $2 and is_active and (valid_from is null or valid_from <= $3::date) and (valid_to is null or valid_to >= $3::date) order by valid_from desc nulls last limit 1`,
      [tenantId, accountId, date],
    );
    if (own) return own.id;
    // a parent company's list covers its plants and branches
    const chain = await tx.query<{ id: string; price_book_id: string | null; depth: number }>(
      `with recursive up(id, parent, depth) as (select id, parent_account_id, 0 from accounts where tenant_id = $1 and id = $2
         union all select a.id, a.parent_account_id, up.depth + 1 from accounts a join up on a.id = up.parent where a.tenant_id = $1 and up.depth < 12)
       select up.id, a.price_book_id, up.depth from up join accounts a on a.tenant_id = $1 and a.id = up.id order by up.depth`,
      [tenantId, accountId],
    );
    for (const a of chain) {
      if (a.depth > 0) {
        const pb = await tx.one<{ id: string }>(
          `select id from price_books where tenant_id = $1 and account_id = $2 and is_active and (valid_from is null or valid_from <= $3::date) and (valid_to is null or valid_to >= $3::date) limit 1`,
          [tenantId, a.id, date],
        );
        if (pb) return pb.id;
      }
      if (a.price_book_id) return a.price_book_id;
    }
  }
  const d = await tx.one<{ id: string }>(`select id from price_books where tenant_id = $1 and is_default and is_active limit 1`, [tenantId]);
  return d?.id ?? null;
}

export async function priceFor(tx: Tx, tenantId: string, q: { productId: string; accountId?: string | null; qty: number; date?: string; priceBookId?: string | null }) {
  const date = q.date ?? todayIst();
  const book = q.priceBookId ?? (await bookFor(tx, tenantId, q.accountId ?? null, date));
  const p = await tx.one<{ list_price: string | null; name: string }>(`select list_price, name from products where tenant_id = $1 and id = $2`, [tenantId, q.productId]);
  if (!p) throw notFound('Product not found');
  if (book) {
    const e = await tx.one<{ unit_price: string; min_qty: string; book: string }>(
      `select e.unit_price, e.min_qty, b.name as book from price_book_entries e join price_books b on b.tenant_id = e.tenant_id and b.id = e.price_book_id
        where e.tenant_id = $1 and e.price_book_id = $2 and e.product_id = $3 and e.min_qty <= $4 order by e.min_qty desc limit 1`,
      [tenantId, book, q.productId, Math.max(q.qty, 0.001)],
    );
    if (e) return { unitPrice: num(e.unit_price), priceBookId: book, priceBook: e.book, tierFrom: num(e.min_qty), source: 'price_book' as const };
  }
  return { unitPrice: num(p.list_price), priceBookId: book, priceBook: null, tierFrom: null, source: 'list_price' as const };
}

export async function tiersOf(ctx: RecordCtx, productId: string) {
  return ctx.tx.query(
    `select b.id as price_book_id, b.name as price_book, b.account_id, a.name as account, b.is_default, e.min_qty::float8 as min_qty, e.unit_price::float8 as unit_price
       from price_book_entries e join price_books b on b.tenant_id = e.tenant_id and b.id = e.price_book_id left join accounts a on a.tenant_id = b.tenant_id and a.id = b.account_id
      where e.tenant_id = $1 and e.product_id = $2 order by b.is_default desc, b.name, e.min_qty`,
    [ctx.tenantId, productId],
  );
}

/** Replaces a product's quantity tiers in one price book (the base price is the tier from 1). */
export async function saveTiers(ctx: RecordCtx, priceBookId: string, productId: string, tiers: { minQty: number; unitPrice: number }[]) {
  assertPricingAdmin(ctx);
  const pb = await ctx.tx.one(`select 1 from price_books where tenant_id = $1 and id = $2`, [ctx.tenantId, priceBookId]);
  if (!pb) throw notFound('Price book not found');
  const seen = new Set<number>();
  for (const t of tiers) {
    if (seen.has(t.minQty)) throw badRequest(`Two tiers start at ${t.minQty}`);
    seen.add(t.minQty);
  }
  await ctx.tx.query(`delete from price_book_entries where tenant_id = $1 and price_book_id = $2 and product_id = $3`, [ctx.tenantId, priceBookId, productId]);
  for (const t of tiers) {
    await ctx.tx.query(`insert into price_book_entries (tenant_id, price_book_id, product_id, min_qty, unit_price) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, priceBookId, productId, t.minQty, t.unitPrice]);
  }
  return { ok: true, tiers: tiers.length };
}

/** Price lists (with the customer they belong to and validity). */
export async function priceLists(ctx: RecordCtx) {
  return ctx.tx.query(
    `select b.id, b.name, b.description, b.currency, b.is_default, b.is_active, b.account_id, a.name as account, b.valid_from, b.valid_to,
            (select count(distinct e.product_id)::int from price_book_entries e where e.tenant_id = b.tenant_id and e.price_book_id = b.id) as products,
            (select count(*)::int from price_book_entries e where e.tenant_id = b.tenant_id and e.price_book_id = b.id and e.min_qty > 1) as tiers,
            (select count(*)::int from accounts x where x.tenant_id = b.tenant_id and x.price_book_id = b.id and x.deleted_at is null) as customers
       from price_books b left join accounts a on a.tenant_id = b.tenant_id and a.id = b.account_id
      where b.tenant_id = $1 order by b.is_default desc, b.account_id nulls first, b.name`,
    [ctx.tenantId],
  );
}

export async function savePriceListScope(ctx: RecordCtx, id: string, input: { accountId?: string | null; validFrom?: string | null; validTo?: string | null }) {
  assertPricingAdmin(ctx);
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) throw badRequest('The end date is before the start');
  const r = await ctx.tx.one(`update price_books set account_id = $3, valid_from = $4, valid_to = $5, updated_at = now() where tenant_id = $1 and id = $2 returning id`, [
    ctx.tenantId, id, input.accountId ?? null, input.validFrom ?? null, input.validTo ?? null,
  ]);
  if (!r) throw notFound('Price list not found');
  return { ok: true };
}

/** Puts the customer's prices (their list, quantity tiers) on every product line of a quote that can still change. */
export async function repriceQuote(ctx: RecordCtx, quoteId: string): Promise<{ changed: number; events: RecordEvent[] }> {
  const doc = await getQuote(ctx, quoteId);
  const q = doc.quote as Record<string, unknown>;
  if (!['draft', 'rfq'].includes(String(q.status))) throw badRequest('Only drafts and RFQs can be re-priced');
  const accountId = (q.account_id as string | null) ?? null;
  const book = await bookFor(ctx.tx, ctx.tenantId, accountId, todayIst());
  let changed = 0;
  const lines = [];
  for (const l of doc.lines as any[]) {
    let unitPrice = Number(l.unitPrice);
    if (l.productId) {
      const p = await priceFor(ctx.tx, ctx.tenantId, { productId: l.productId, accountId, qty: Number(l.quantity), priceBookId: book });
      if (Math.abs(p.unitPrice - unitPrice) > 0.004) {
        unitPrice = p.unitPrice;
        changed++;
      }
    }
    lines.push({ productId: l.productId ?? null, name: l.name, description: l.description ?? null, hsnSac: l.hsnSac ?? null, unit: l.unit ?? null, quantity: Number(l.quantity), unitPrice, discountPct: Number(l.discountPct) || 0, taxRate: Number(l.taxRate) || 0 });
  }
  const events = await saveLines(ctx, quoteId, lines, { priceBookId: book });
  return { changed, events };
}

/* ───────────── cost and margin of a quote ───────────── */

export async function unitCost(tx: Tx, tenantId: string, productId: string, memo = new Map()) {
  const p = await tx.one<{ make_or_buy: string | null; avg_cost: string | null; purchase_price: string | null; cost_price: string | null }>(
    `select make_or_buy, avg_cost, purchase_price, cost_price from products where tenant_id = $1 and id = $2`,
    [tenantId, productId],
  );
  if (!p) return { cost: 0, basis: 'none' as const };
  if (p.make_or_buy && p.make_or_buy !== 'buy') {
    const bom = await tx.one<{ id: string }>(`select id from boms where tenant_id = $1 and product_id = $2 and status = 'active' order by is_default desc, revision desc limit 1`, [tenantId, productId]);
    if (bom) {
      const c = await bomCost(tx, tenantId, bom.id, 0, memo);
      if (c.perUnit > 0) return { cost: c.perUnit, basis: 'bom' as const, material: c.material, operations: c.operations };
    }
  }
  const v = num(p.avg_cost) || num(p.purchase_price) || num(p.cost_price);
  return { cost: v, basis: v ? ('average' as const) : ('none' as const) };
}

export async function quoteCosting(ctx: RecordCtx, quoteId: string) {
  if (!canSeeMargins(ctx)) throw forbidden('Margins need finance access');
  const lines = await ctx.tx.query<{ id: string; name: string; product_id: string | null; quantity: string; line_subtotal: string; unit_price: string; discount_pct: string }>(
    `select id, name, product_id, quantity, line_subtotal, unit_price, discount_pct from quote_lines where tenant_id = $1 and quote_id = $2 order by position`,
    [ctx.tenantId, quoteId],
  );
  const memo = new Map();
  const out = [];
  let revenue = 0;
  let cost = 0;
  for (const l of lines) {
    const c = l.product_id ? await unitCost(ctx.tx, ctx.tenantId, l.product_id, memo) : { cost: 0, basis: 'none' as const };
    const qty = num(l.quantity);
    const rev = num(l.line_subtotal);
    const lc = r2(c.cost * qty);
    revenue += rev;
    cost += lc;
    out.push({ id: l.id, name: l.name, quantity: qty, net: rev, unitCost: Math.round(c.cost * 100) / 100, cost: lc, basis: c.basis, margin: r2(rev - lc), marginPct: rev > 0 ? Math.round(((rev - lc) / rev) * 1000) / 10 : null });
  }
  const floor = await ctx.tx.one<{ v: string | null }>(`select settings -> 'pricing' ->> 'minMarginPct' as v from tenants where id = $1`, [ctx.tenantId]);
  const minMarginPct = floor?.v != null ? Number(floor.v) : null;
  const marginPct = revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null;
  return { lines: out, revenue: r2(revenue), cost: r2(cost), margin: r2(revenue - cost), marginPct, minMarginPct, belowFloor: minMarginPct != null && marginPct != null && marginPct < minMarginPct, uncosted: out.filter((l) => l.basis === 'none').length };
}

/* ───────────── available to promise ───────────── */

export async function availability(ctx: RecordCtx, productId: string, qty: number, opts: { warehouseId?: string | null; excludeOrderId?: string | null } = {}) {
  const p = await ctx.tx.one<{ name: string; lead_time_days: number | null; make_or_buy: string | null; track_inventory: boolean; product_type: string }>(
    `select name, lead_time_days, make_or_buy, track_inventory, product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, productId],
  );
  if (!p) throw notFound('Product not found');
  const today = todayIst();
  if (!p.track_inventory || p.product_type !== 'goods') return { productId, name: p.name, qty, onHand: null, reserved: null, free: null, supply: [], promiseDate: today, from: 'not_stocked' as const, shortBy: 0 };
  const lvl = await ctx.tx.one<{ on_hand: string; reserved: string }>(
    `select coalesce(sum(on_hand), 0) as on_hand, coalesce(sum(reserved), 0) as reserved from stock_levels where tenant_id = $1 and product_id = $2 and ($3::uuid is null or warehouse_id = $3)`,
    [ctx.tenantId, productId, opts.warehouseId ?? null],
  );
  // committed to other confirmed orders but not yet reserved (made-to-order shortfalls)
  const free = Math.max(0, num(lvl?.on_hand) - num(lvl?.reserved));
  const supply = await ctx.tx.query<{ kind: string; ref: string; id: string; date: string | null; qty: string }>(
    `select 'purchase' as kind, po.po_number as ref, po.id, coalesce(po.expected_date, po.order_date + 7)::text as date, greatest(l.quantity - l.received_qty, 0) as qty
       from purchase_order_lines l join purchase_orders po on po.tenant_id = l.tenant_id and po.id = l.order_id
      where l.tenant_id = $1 and l.product_id = $2 and po.deleted_at is null and po.status not in ('draft','received','closed','cancelled') and l.quantity > l.received_qty
     union all
     select 'production', wo.wo_number, wo.id, coalesce(wo.planned_end, current_date + 7)::text, greatest(wo.quantity - wo.produced_qty - wo.scrapped_qty, 0)
       from work_orders wo where wo.tenant_id = $1 and wo.product_id = $2 and wo.deleted_at is null and wo.status in ('draft','released','in_progress') and ($3::uuid is null or wo.sales_order_id is distinct from $3)
     order by 4 nulls last`,
    [ctx.tenantId, productId, opts.excludeOrderId ?? null],
  );
  let have = free;
  let promise: string | null = have >= qty ? today : null;
  let from: 'stock' | 'purchase' | 'production' | 'lead_time' = 'stock';
  for (const s of supply) {
    if (promise) break;
    have += num(s.qty);
    if (have >= qty) {
      promise = s.date && s.date > today ? s.date : today;
      from = s.kind as 'purchase';
    }
  }
  if (!promise) {
    promise = addDays(today, p.lead_time_days ?? 14);
    from = 'lead_time';
  }
  return {
    productId,
    name: p.name,
    qty,
    onHand: num(lvl?.on_hand),
    reserved: num(lvl?.reserved),
    free,
    supply: supply.map((s) => ({ kind: s.kind, ref: s.ref, id: s.id, date: s.date, qty: num(s.qty) })),
    promiseDate: promise,
    from,
    shortBy: Math.max(0, qty - free),
  };
}

/** Works out a promise date for each line of an order (and the order's expected delivery if empty). */
export async function promiseOrder(ctx: RecordCtx, orderId: string, apply: boolean) {
  const o = await ctx.tx.one<{ warehouse_id: string | null; expected_delivery_date: string | null; status: string }>(
    `select warehouse_id, expected_delivery_date::text, status from sales_orders where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, orderId],
  );
  if (!o) throw notFound('Order not found');
  if (apply && objectPerm(ctx.principal.permissions, 'sales_order').update === 'none') throw forbidden();
  const lines = await ctx.tx.query<{ id: string; name: string; product_id: string | null; quantity: string; reserved_qty: string; delivered_qty: string; promise_date: string | null }>(
    `select id, name, product_id, quantity, reserved_qty, delivered_qty, promise_date::text from sales_order_lines where tenant_id = $1 and order_id = $2 order by position`,
    [ctx.tenantId, orderId],
  );
  const out = [];
  let latest: string | null = null;
  for (const l of lines) {
    const open = num(l.quantity) - num(l.delivered_qty);
    let promise = todayIst();
    let detail = null;
    if (l.product_id && open > 0) {
      // what this order already holds counts as free for it
      const need = Math.max(0, open - num(l.reserved_qty));
      detail = await availability(ctx, l.product_id, need, { warehouseId: o.warehouse_id, excludeOrderId: orderId });
      promise = detail.promiseDate;
    }
    if (!latest || promise > latest) latest = promise;
    out.push({ id: l.id, name: l.name, open, promiseDate: promise, current: l.promise_date, from: detail?.from ?? 'stock', shortBy: detail?.shortBy ?? 0 });
    if (apply) await ctx.tx.query(`update sales_order_lines set promise_date = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, promise]);
  }
  if (apply && latest && !o.expected_delivery_date) await ctx.tx.query(`update sales_orders set expected_delivery_date = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, orderId, latest]);
  return { lines: out, promiseDate: latest };
}

/* ───────────── rebates ───────────── */

export interface RebateInput {
  accountId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  basis: 'value' | 'quantity';
  productId?: string | null;
  slabs: { from: number; pct: number }[];
  status?: 'active' | 'settled' | 'cancelled';
  notes?: string | null;
}

export async function saveRebate(ctx: RecordCtx, id: string | null, input: RebateInput) {
  assertPricingAdmin(ctx);
  if (input.endsOn < input.startsOn) throw badRequest('The agreement ends before it starts');
  if (!input.slabs.length) throw badRequest('Add at least one slab');
  const slabs = [...input.slabs].sort((a, b) => a.from - b.from);
  const vals = [input.accountId, input.name, input.startsOn, input.endsOn, input.basis, input.productId ?? null, JSON.stringify(slabs), input.status ?? 'active', input.notes ?? null];
  if (id) {
    const r = await ctx.tx.one<{ id: string }>(
      `update rebate_agreements set account_id = $3, name = $4, starts_on = $5, ends_on = $6, basis = $7, product_id = $8, slabs = $9::jsonb, status = $10, notes = $11 where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals],
    );
    if (!r) throw notFound('Agreement not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into rebate_agreements (tenant_id, account_id, name, starts_on, ends_on, basis, product_id, slabs, status, notes) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) returning id`,
    [ctx.tenantId, ...vals],
  );
  return { id: r!.id };
}

export async function deleteRebate(ctx: RecordCtx, id: string) {
  assertPricingAdmin(ctx);
  await ctx.tx.query(`delete from rebate_agreements where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Each agreement with what the customer (and their plants) bought in the period and the rebate earned. */
export async function rebates(ctx: RecordCtx, q: { accountId?: string | null } = {}) {
  if (objectPerm(ctx.principal.permissions, 'account').read === 'none') throw forbidden();
  const list = await ctx.tx.query<{ id: string; account_id: string; account: string; name: string; starts_on: string; ends_on: string; basis: 'value' | 'quantity'; product_id: string | null; product: string | null; slabs: { from: number; pct: number }[]; status: string; notes: string | null }>(
    `select r.id, r.account_id, a.name as account, r.name, r.starts_on::text, r.ends_on::text, r.basis, r.product_id, p.name as product, r.slabs, r.status, r.notes
       from rebate_agreements r join accounts a on a.tenant_id = r.tenant_id and a.id = r.account_id left join products p on p.tenant_id = r.tenant_id and p.id = r.product_id
      where r.tenant_id = $1 and ($2::uuid is null or r.account_id = $2) order by r.status, r.ends_on desc`,
    [ctx.tenantId, q.accountId ?? null],
  );
  const out = [];
  for (const r of list) {
    const ids = await familyIds(ctx.tx, ctx.tenantId, r.account_id);
    const a = await ctx.tx.one<{ value: string; qty: string }>(
      `select coalesce(sum(case when i.doc_type = 'credit_note' then -1 else 1 end * l.line_subtotal * coalesce(i.exchange_rate, 1)), 0) as value,
              coalesce(sum(case when i.doc_type = 'credit_note' then -1 else 1 end * l.quantity), 0) as qty
         from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.order_id
        where l.tenant_id = $1 and i.account_id = any($2::uuid[]) and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled')
          and i.invoice_date between $3::date and $4::date and ($5::uuid is null or l.product_id = $5)`,
      [ctx.tenantId, ids, r.starts_on, r.ends_on, r.product_id],
    );
    const achieved = r.basis === 'value' ? num(a?.value) : num(a?.qty);
    const slabs = [...r.slabs].sort((x, y) => x.from - y.from);
    const reached = [...slabs].reverse().find((s) => achieved >= s.from) ?? null;
    const next = slabs.find((s) => achieved < s.from) ?? null;
    const value = num(a?.value);
    out.push({
      ...r,
      achieved: r2(achieved),
      value: r2(value),
      ratePct: reached?.pct ?? 0,
      earned: r2((value * (reached?.pct ?? 0)) / 100),
      next: next ? { from: next.from, pct: next.pct, gap: r2(next.from - achieved), earnedThen: r2((value * next.pct) / 100) } : null,
      daysLeft: Math.max(0, Math.round((Date.parse(`${r.ends_on}T00:00:00Z`) - Date.parse(`${todayIst()}T00:00:00Z`)) / 86_400_000)),
    });
  }
  return { items: out, accrued: r2(out.filter((x) => x.status === 'active').reduce((s, x) => s + x.earned, 0)) };
}
