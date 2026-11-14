/**
 * Sales orders: created from accepted quotes (or by hand), confirmed (stock reserved, approval
 * checked), moved through production → dispatch → delivery → installation, and paid against
 * milestones. Deliveries and invoices (other apps) update the same order.
 */
import { badRequest, conflict, notFound } from '../lib/errors';
import { assertApproved, reevaluate } from './approvals';
import { moveStock } from './inventory';
import { LINE_DOCS, readLines, replaceLines } from './lines';
import { letterhead, type LineInput } from './quotes';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, readRowSystem, toDto } from './records';
import { milestonePlan } from './solutions';

const DOC = LINE_DOCS.sales_order!;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Allowed manual status changes (deliveries move dispatched/delivered/installed automatically too). */
const NEXT: Record<string, string[]> = {
  confirmed: ['in_production', 'ready', 'dispatched', 'cancelled'],
  in_production: ['ready', 'cancelled'],
  ready: ['dispatched', 'in_production', 'cancelled'],
  dispatched: ['delivered'],
  delivered: ['installed', 'completed'],
  installed: ['completed'],
  completed: [],
  cancelled: [],
  draft: ['cancelled'],
};
export const MILESTONE_ON_STATUS: Record<string, string> = { confirmed: 'on_confirmation', ready: 'before_dispatch', delivered: 'on_delivery', installed: 'on_installation' };

export async function getOrder(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'sales_order', id, 'read');
  const order = toDto(obj, row, ctx.principal.permissions);
  const account = row.account_id
    ? await ctx.tx.one<Record<string, unknown>>(`select id, name, gstin, address, city, state, pincode, phone from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, row.account_id])
    : null;
  const milestones = await ctx.tx.query(
    `select id, position, name, percent::float8 as percent, amount::float8 as amount, trigger, due_date, status, amount_paid::float8 as amount_paid, paid_at, invoice_id, notes
       from order_milestones where tenant_id = $1 and order_id = $2 order by position`,
    [ctx.tenantId, id],
  );
  return {
    order: { ...order, bill_to: row.bill_to ?? null, ship_to: row.ship_to ?? null },
    lines: await readLines(ctx, DOC, id),
    milestones,
    account,
    company: await letterhead(ctx),
    milestonePlan: await milestonePlan(ctx),
  };
}

export async function saveOrderLines(ctx: RecordCtx, id: string, lines: LineInput[]) {
  const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('Only draft orders can be changed. Reopen the order as a draft first.');
  const events = await replaceLines(ctx, DOC, id, row, lines);
  await reevaluate(ctx, 'sales_order', id);
  await rescaleMilestones(ctx, id);
  return events;
}

/** Converts an accepted quote into a draft order (one active order per quote). */
export async function orderFromQuote(ctx: RecordCtx, quoteId: string, opts: { allowUnaccepted?: boolean } = {}) {
  const { row: q } = await loadRow(ctx, 'quote', quoteId, 'read');
  if (q.status !== 'accepted' && !(opts.allowUnaccepted && q.status === 'sent')) throw badRequest('Only accepted quotes become orders');
  const existing = await ctx.tx.one<{ id: string; order_number: string }>(
    `select id, order_number from sales_orders where tenant_id = $1 and quote_id = $2 and deleted_at is null and status <> 'cancelled'`,
    [ctx.tenantId, quoteId],
  );
  if (existing) throw conflict(`This quote is already order ${existing.order_number}`, { orderId: existing.id });
  const billTo = (q.bill_to as Record<string, string> | null) ?? {};
  const r = await createRecord(ctx, 'sales_order', {
    name: String(q.name),
    account_id: q.account_id ?? null,
    contact_id: q.contact_id ?? null,
    deal_id: q.deal_id ?? null,
    currency: q.currency ?? 'INR',
    ...(q.terms ? { terms: q.terms } : {}),
    ...(billTo.address ? { site_address: billTo.address } : {}),
  });
  const id = r.record.id;
  await ctx.tx.query(`update sales_orders set quote_id = $3, bill_to = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, quoteId, q.bill_to ? JSON.stringify(q.bill_to) : null]);
  await ctx.tx.query(
    `insert into sales_order_lines (tenant_id, order_id, position, product_id, name, description, hsn_sac, unit, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total)
     select tenant_id, $3, position, product_id, name, description, hsn_sac, unit, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total
       from quote_lines where tenant_id = $1 and quote_id = $2`,
    [ctx.tenantId, quoteId, id],
  );
  await ctx.tx.query(
    `update sales_orders o set subtotal = q.subtotal, discount_total = q.discount_total, tax_total = q.tax_total, grand_total = q.grand_total, max_discount_pct = q.max_discount_pct,
            -- the discount was approved on the quote already
            approval_status = case when q.approval_status = 'approved' then 'approved' else o.approval_status end
       from quotes q where o.tenant_id = $1 and o.id = $2 and q.tenant_id = $1 and q.id = $3`,
    [ctx.tenantId, id, quoteId],
  );
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'quote',$3), ($1,'system',$4,'sales_order',$5)`, [
    ctx.tenantId, `Converted to order ${r.record.order_number}`, quoteId, `Created from quote ${q.quote_number}`, id,
  ]);
  // the workspace's usual payment plan (e.g. 50 / 40 / 10) is applied to every new order
  const plan = await milestonePlan(ctx);
  if (plan?.length) {
    // a plan that does not fit (permissions, totals) is skipped: the person sets milestones by hand
    await ctx.tx.query('savepoint milestone_plan');
    try {
      await setMilestones(ctx, id, plan.map((m) => ({ name: m.name, percent: m.percent, trigger: m.trigger as MilestoneInput['trigger'] })));
      await ctx.tx.query('release savepoint milestone_plan');
    } catch {
      await ctx.tx.query('rollback to savepoint milestone_plan');
    }
  }
  return { id, events: r.events };
}

async function setStatus(ctx: RecordCtx, id: string, from: string, to: string, extra: string[] = []): Promise<RecordEvent[]> {
  await ctx.tx.query(`update sales_orders set status = $3${extra.length ? `, ${extra.join(', ')}` : ''} where tenant_id = $1 and id = $2`, [ctx.tenantId, id, to]);
  const trig = MILESTONE_ON_STATUS[to];
  if (trig) await ctx.tx.query(`update order_milestones set status = 'due', due_date = coalesce(due_date, current_date) where tenant_id = $1 and order_id = $2 and trigger = $3 and status = 'pending'`, [ctx.tenantId, id, trig]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id, metadata) values ($1,'stage_change',$2,'sales_order',$3,$4)`, [
    ctx.tenantId, `Order ${to.replace(/_/g, ' ')}`, id, JSON.stringify({ from, to }),
  ]);
  return [{ objectKey: 'sales_order', recordId: id, kind: 'updated', changes: { status: [from, to] } }];
}

/** Draft → confirmed: approval check, stock reserved for tracked products, milestones due. */
export async function confirmOrder(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('Only draft orders can be confirmed');
  const lines = await readLines(ctx, DOC, id);
  if (!lines.length) throw badRequest('Add at least one line before confirming');
  if (row.approval_status === 'not_required' || row.approval_status === 'required') row.approval_status = await reevaluate(ctx, 'sales_order', id);
  assertApproved(row, 'order');
  const label = `Order ${row.order_number}`;
  if (row.warehouse_id) {
    for (const l of lines) {
      if (!l.productId) continue;
      const p = await ctx.tx.one<{ track_inventory: boolean; product_type: string; make_or_buy: string | null }>(`select track_inventory, product_type, make_or_buy from products where tenant_id = $1 and id = $2`, [ctx.tenantId, l.productId]);
      if (!p?.track_inventory || p.product_type !== 'goods') continue;
      let qty = Number(l.quantity);
      // made-to-order items reserve what is on the shelf; production reserves the rest as it is made
      if (p.make_or_buy && p.make_or_buy !== 'buy') {
        const lvl = await ctx.tx.one<{ free: string }>(`select greatest(on_hand - reserved, 0) as free from stock_levels where tenant_id = $1 and product_id = $2 and warehouse_id = $3`, [ctx.tenantId, l.productId, row.warehouse_id]);
        qty = Math.min(qty, Number(lvl?.free ?? 0));
        if (qty <= 0) continue;
      }
      await moveStock(ctx, { productId: l.productId, warehouseId: String(row.warehouse_id), type: 'reserve', reserved: qty, ref: { object: 'sales_order', id, label } });
      await ctx.tx.query(`update sales_order_lines set reserved_qty = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, qty]);
    }
  }
  const events = await setStatus(ctx, id, 'draft', 'confirmed', ['confirmed_at = now()']);
  // the deal behind the order is won
  if (row.deal_id) {
    const won = await ctx.tx.one<{ id: string; stage_id: string; won: string | null; cat: string | null }>(
      `select d.id, d.stage_id, (select s2.id from pipeline_stages s2 where s2.tenant_id = d.tenant_id and s2.pipeline_id = d.pipeline_id and s2.category = 'won' order by s2.position limit 1) as won,
              (select s.category from pipeline_stages s where s.tenant_id = d.tenant_id and s.id = d.stage_id) as cat
         from deals d where d.tenant_id = $1 and d.id = $2 and d.deleted_at is null`,
      [ctx.tenantId, row.deal_id],
    );
    if (won?.won && won.cat === 'open') {
      await ctx.tx.query(`update deals set stage_id = $3, closed_at = now(), probability = 100 where tenant_id = $1 and id = $2`, [ctx.tenantId, row.deal_id, won.won]);
      await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'stage_change',$2,'deal',$3)`, [ctx.tenantId, `Won — ${label} confirmed`, row.deal_id]);
      events.push({ objectKey: 'deal', recordId: String(row.deal_id), kind: 'stage_changed', changes: { stage_id: [won.stage_id, won.won] } });
    }
  }
  return events;
}

async function releaseReservations(ctx: RecordCtx, row: Record<string, unknown>, id: string, why: string) {
  if (!row.warehouse_id) return;
  for (const l of await readLines(ctx, DOC, id)) {
    const left = Number(l.reservedQty ?? 0);
    if (!l.productId || left <= 0) continue;
    await moveStock(ctx, { productId: l.productId, warehouseId: String(row.warehouse_id), type: 'release', reserved: -left, reason: why, ref: { object: 'sales_order', id, label: `Order ${row.order_number}` } });
    await ctx.tx.query(`update sales_order_lines set reserved_qty = 0 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id]);
  }
}

export async function changeStatus(ctx: RecordCtx, id: string, to: string, reason: string | null): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
  const from = String(row.status);
  if (to === 'confirmed') return confirmOrder(ctx, id);
  if (!(NEXT[from] ?? []).includes(to)) throw badRequest(`An order that is ${from.replace(/_/g, ' ')} cannot become ${to.replace(/_/g, ' ')}`);
  if (to === 'cancelled') {
    if (!reason?.trim()) throw badRequest('Give a reason for cancelling');
    if (row.fulfilment_status !== 'unfulfilled') throw badRequest('Part of this order was delivered already; it cannot be cancelled');
    await releaseReservations(ctx, row, id, `Cancelled: ${reason}`);
    await ctx.tx.query(`update order_milestones set status = 'waived' where tenant_id = $1 and order_id = $2 and status in ('pending', 'due')`, [ctx.tenantId, id]);
    await ctx.tx.query(`update sales_orders set cancelled_at = now(), cancel_reason = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason.trim().slice(0, 500)]);
    return setStatus(ctx, id, from, to);
  }
  return setStatus(ctx, id, from, to);
}

/** Confirmed/in-production order back to draft (to edit lines): reservations are released. */
export async function reopenOrder(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
  if (!['confirmed', 'in_production', 'ready'].includes(String(row.status))) throw badRequest('Only confirmed orders that have not shipped can be reopened');
  if (row.fulfilment_status !== 'unfulfilled') throw badRequest('Part of this order was delivered already');
  await releaseReservations(ctx, row, id, 'Reopened for changes');
  await ctx.tx.query(`update order_milestones set status = 'pending' where tenant_id = $1 and order_id = $2 and status = 'due' and amount_paid = 0`, [ctx.tenantId, id]);
  return setStatus(ctx, id, String(row.status), 'draft', ['confirmed_at = null']);
}

/**
 * Moves order lines through fulfilment (quantities per line; null = everything still open):
 *   'ship'    goods leave the warehouse: stock out (from the reservation), shipped_qty grows
 *   'deliver' the customer has them: delivered_qty grows, fulfilment / status refresh
 *   'both'    "deliver from stock" in one step
 * Used per shipment by the delivery app and by "Deliver from stock" without it.
 */
export async function shipLines(
  ctx: RecordCtx,
  id: string,
  qtyByLine: Record<string, number> | null,
  ref: { object: string; id: string; label: string },
  warehouseId?: string | null,
  mode: 'ship' | 'deliver' | 'both' = 'both',
): Promise<RecordEvent[]> {
  const row = await readRowSystem(ctx, 'sales_order', id);
  if (!row) throw notFound();
  if (mode !== 'deliver' && !['confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed'].includes(String(row.status))) throw badRequest('Confirm the order before shipping it');
  const lines = await readLines(ctx, DOC, id);
  const wh = warehouseId ?? (row.warehouse_id as string | null);
  let moved = 0;
  for (const l of lines) {
    const shipped = Number(l.shippedQty ?? 0);
    const delivered = Number(l.deliveredQty ?? 0);
    const open = mode === 'deliver' ? shipped - delivered : Number(l.quantity) - shipped;
    const q = qtyByLine ? Number(qtyByLine[l.id] ?? 0) : open;
    if (q <= 0) continue;
    if (q > open + 1e-9) throw badRequest(`${l.name}: only ${open} left to ${mode === 'deliver' ? 'deliver' : 'ship'}`);
    if (mode !== 'deliver' && l.productId && wh) {
      const p = await ctx.tx.one<{ track_inventory: boolean; product_type: string }>(`select track_inventory, product_type from products where tenant_id = $1 and id = $2`, [ctx.tenantId, l.productId]);
      if (p?.track_inventory && p.product_type === 'goods') {
        const fromReserved = Math.min(q, Number(l.reservedQty ?? 0));
        // reserved stock leaves the shelf: on_hand and reserved both drop
        await moveStock(ctx, { productId: l.productId, warehouseId: wh, type: 'out', qty: -q, reserved: -fromReserved, ref });
        await ctx.tx.query(`update sales_order_lines set reserved_qty = reserved_qty - $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, fromReserved]);
      }
    }
    await ctx.tx.query(
      `update sales_order_lines set shipped_qty = shipped_qty + $3, delivered_qty = delivered_qty + $4 where tenant_id = $1 and id = $2`,
      [ctx.tenantId, l.id, mode === 'deliver' ? 0 : q, mode === 'ship' ? 0 : q],
    );
    moved += q;
  }
  if (!moved) throw badRequest(mode === 'deliver' ? 'Nothing to deliver' : 'Nothing to ship');
  const events: RecordEvent[] = [];
  if (mode === 'ship' && ['confirmed', 'in_production', 'ready'].includes(String(row.status))) events.push(...(await setStatus(ctx, id, String(row.status), 'dispatched')));
  if (mode !== 'ship') events.push(...(await refreshFulfilment(ctx, id)));
  return events;
}

/** Goods come back (failed delivery): stock in again and re-reserved for the order. */
export async function returnLines(ctx: RecordCtx, id: string, qtyByLine: Record<string, number>, ref: { object: string; id: string; label: string }, warehouseId: string | null, reason: string) {
  const row = await readRowSystem(ctx, 'sales_order', id);
  if (!row) throw notFound();
  const wh = warehouseId ?? (row.warehouse_id as string | null);
  for (const l of await readLines(ctx, DOC, id)) {
    const q = Number(qtyByLine[l.id] ?? 0);
    if (q <= 0) continue;
    if (l.productId && wh) {
      const p = await ctx.tx.one<{ track_inventory: boolean; product_type: string }>(`select track_inventory, product_type from products where tenant_id = $1 and id = $2`, [ctx.tenantId, l.productId]);
      if (p?.track_inventory && p.product_type === 'goods') {
        await moveStock(ctx, { productId: l.productId, warehouseId: wh, type: 'in', qty: q, reserved: q, reason: `Returned: ${reason}`, ref });
        await ctx.tx.query(`update sales_order_lines set reserved_qty = reserved_qty + $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, q]);
      }
    }
    await ctx.tx.query(`update sales_order_lines set shipped_qty = greatest(shipped_qty - $3, 0) where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, q]);
  }
}

/** Installation finished: a delivered order becomes installed (milestones follow). Internal, no permission check. */
export async function markInstalled(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const row = await readRowSystem(ctx, 'sales_order', id);
  if (!row || row.status !== 'delivered') return [];
  return setStatus(ctx, id, 'delivered', 'installed');
}

/** Recomputes fulfilment status (and moves the order to delivered when everything arrived). */
export async function refreshFulfilment(ctx: RecordCtx, id: string, deliveredConfirmed = true): Promise<RecordEvent[]> {
  const t = await ctx.tx.one<{ q: string; d: string; status: string }>(
    `select coalesce(sum(l.quantity), 0) q, coalesce(sum(l.delivered_qty), 0) d, o.status from sales_orders o left join sales_order_lines l on l.tenant_id = o.tenant_id and l.order_id = o.id
      where o.tenant_id = $1 and o.id = $2 group by o.status`,
    [ctx.tenantId, id],
  );
  if (!t) return [];
  const fs = Number(t.d) <= 0 ? 'unfulfilled' : Number(t.d) + 1e-9 >= Number(t.q) ? 'delivered' : 'partially_delivered';
  await ctx.tx.query(`update sales_orders set fulfilment_status = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, fs]);
  if (fs === 'delivered' && deliveredConfirmed && ['confirmed', 'in_production', 'ready', 'dispatched'].includes(t.status)) return setStatus(ctx, id, t.status, 'delivered');
  return [];
}

// ---------------------------------------------------------------------------------- milestones
export interface MilestoneInput {
  name: string;
  percent?: number | null;
  amount?: number | null;
  trigger: 'on_confirmation' | 'before_dispatch' | 'on_delivery' | 'on_installation' | 'on_date';
  dueDate?: string | null;
  notes?: string | null;
}

export async function setMilestones(ctx: RecordCtx, id: string, input: MilestoneInput[]) {
  const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
  if (['cancelled', 'completed'].includes(String(row.status))) throw badRequest('This order is closed');
  if (input.length > 12) throw badRequest('At most 12 milestones');
  const paid = await ctx.tx.one<{ n: string }>(`select count(*) n from order_milestones where tenant_id = $1 and order_id = $2 and amount_paid > 0`, [ctx.tenantId, id]);
  if (Number(paid?.n)) throw badRequest('Payments were recorded against these milestones; edit them one by one instead');
  const total = Number(row.grand_total);
  const amounts = input.map((m) => (m.percent ? r2((total * m.percent) / 100) : r2(Number(m.amount ?? 0))));
  const sum = r2(amounts.reduce((a, b) => a + b, 0));
  if (sum > total + 0.01) throw badRequest(`Milestones add up to more than the order total (${sum} > ${total})`);
  for (const m of input) if (m.trigger === 'on_date' && !m.dueDate) throw badRequest(`“${m.name}” needs a due date`);
  await ctx.tx.query(`delete from order_milestones where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id]);
  const statusNow = String(row.status);
  const reached = new Set(Object.entries(MILESTONE_ON_STATUS).filter(([s]) => orderReached(statusNow, s)).map(([, t]) => t));
  for (const [i, m] of input.entries()) {
    await ctx.tx.query(
      `insert into order_milestones (tenant_id, order_id, position, name, percent, amount, trigger, due_date, status, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [ctx.tenantId, id, i + 1, m.name, m.percent ?? null, amounts[i], m.trigger, m.dueDate ?? null, reached.has(m.trigger) ? 'due' : 'pending', m.notes ?? null],
    );
  }
  return { total: sum };
}

const ORDER_SEQ = ['draft', 'confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed', 'completed'];
function orderReached(current: string, target: string) {
  const a = ORDER_SEQ.indexOf(current);
  const b = ORDER_SEQ.indexOf(target);
  return a >= 0 && b >= 0 && a >= b;
}

/** Percent-based milestones follow the order total when lines change. */
async function rescaleMilestones(ctx: RecordCtx, id: string) {
  await ctx.tx.query(
    `update order_milestones m set amount = round(o.grand_total * m.percent / 100, 2)
       from sales_orders o where m.tenant_id = $1 and m.order_id = $2 and o.tenant_id = $1 and o.id = $2 and m.percent is not null and m.amount_paid = 0`,
    [ctx.tenantId, id],
  );
}

/** Records money received against a milestone (cash, UPI, cheque …) and updates the order. */
export async function recordMilestonePayment(ctx: RecordCtx, orderId: string, milestoneId: string, amount: number, note: string | null, opts: { asAccounts?: boolean } = {}) {
  // accounts staff (billing) record receipts on orders they may only read
  if (opts.asAccounts) await loadRow(ctx, 'sales_order', orderId, 'read');
  else await loadRow(ctx, 'sales_order', orderId, 'update', true);
  const m = await ctx.tx.one<{ amount: string; amount_paid: string; name: string }>(`select amount, amount_paid, name from order_milestones where tenant_id = $1 and order_id = $2 and id = $3 for update`, [ctx.tenantId, orderId, milestoneId]);
  if (!m) throw notFound();
  if (!(amount > 0)) throw badRequest('Amount must be positive');
  const paid = r2(Number(m.amount_paid) + amount);
  if (paid > Number(m.amount) + 0.01) throw badRequest(`That is more than the milestone (${Number(m.amount) - Number(m.amount_paid)} outstanding)`);
  await ctx.tx.query(`update order_milestones set amount_paid = $4, status = case when $4 >= amount - 0.01 then 'paid' else status end, paid_at = case when $4 >= amount - 0.01 then now() else paid_at end where tenant_id = $1 and order_id = $2 and id = $3`, [
    ctx.tenantId, orderId, milestoneId, paid,
  ]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, metadata) values ($1,'system',$2,$3,'sales_order',$4,$5)`, [
    ctx.tenantId, `Payment received: ₹${amount.toLocaleString('en-IN')} (${m.name})`, note, orderId, JSON.stringify({ milestoneId, amount }),
  ]);
  return refreshPayments(ctx, orderId);
}

/** amount_paid = milestone payments + invoice payments (billing app); sets payment_status. */
export async function refreshPayments(ctx: RecordCtx, orderId: string): Promise<RecordEvent[]> {
  const before = await ctx.tx.one<{ payment_status: string; amount_paid: string }>(`select payment_status, amount_paid from sales_orders where tenant_id = $1 and id = $2`, [ctx.tenantId, orderId]);
  const r = await ctx.tx.one<{ payment_status: string; amount_paid: string }>(
    `update sales_orders o set amount_paid = x.paid,
            payment_status = case when x.paid <= 0 then 'unpaid' when x.paid >= o.grand_total - 0.01 then 'paid' else 'partially_paid' end
       from (select coalesce(sum(amount_paid), 0) as paid from order_milestones where tenant_id = $1 and order_id = $2) x
      where o.tenant_id = $1 and o.id = $2 returning o.payment_status, o.amount_paid`,
    [ctx.tenantId, orderId],
  );
  if (!r || !before || (before.payment_status === r.payment_status && Number(before.amount_paid) === Number(r.amount_paid))) return [];
  return [{ objectKey: 'sales_order', recordId: orderId, kind: 'updated', changes: { amount_paid: [Number(before.amount_paid), Number(r.amount_paid)], payment_status: [before.payment_status, r.payment_status] } }];
}
