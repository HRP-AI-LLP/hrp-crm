/**
 * Purchasing: purchase orders (approval like quotes), goods receipts that bring stock in, back-to-
 * back POs from sales orders, and vendor performance from the receipt history.
 */
import { badRequest, notFound } from '../lib/errors';
import { assertApproved, reevaluate } from './approvals';
import { assertCanMoveStock, defaultWarehouse, moveStock } from './inventory';
import { LINE_DOCS, readLines, replaceLines } from './lines';
import { letterhead, type LineInput } from './quotes';
import { createRecord, loadRow, nextDocumentNumber, type RecordCtx, type RecordEvent, toDto } from './records';

const DOC = LINE_DOCS.purchase_order!;

export async function getPurchaseOrder(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'purchase_order', id, 'read');
  const vendor = row.vendor_id
    ? await ctx.tx.one<Record<string, unknown>>(`select id, name, gstin, address, city, state, email, phone, contact_person, payment_terms_days from vendors where tenant_id = $1 and id = $2`, [ctx.tenantId, row.vendor_id])
    : null;
  const receipts = await ctx.tx.query(
    `select g.id, g.receipt_number, g.received_on, g.vendor_invoice, g.notes, g.created_at, w.name as warehouse_name, u.full_name as received_by,
            coalesce((select jsonb_agg(jsonb_build_object('poLineId', l.po_line_id, 'received', l.qty_received, 'rejected', l.qty_rejected, 'reason', l.rejection_reason)) from goods_receipt_lines l where l.tenant_id = g.tenant_id and l.receipt_id = g.id), '[]') as lines
       from goods_receipts g join warehouses w on w.tenant_id = g.tenant_id and w.id = g.warehouse_id left join users u on u.tenant_id = g.tenant_id and u.id = g.created_by
      where g.tenant_id = $1 and g.po_id = $2 order by g.created_at desc`,
    [ctx.tenantId, id],
  );
  return { po: toDto(obj, row, ctx.principal.permissions), lines: await readLines(ctx, DOC, id), vendor, receipts, company: await letterhead(ctx) };
}

export async function savePoLines(ctx: RecordCtx, id: string, lines: LineInput[]) {
  const { row } = await loadRow(ctx, 'purchase_order', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('Only draft purchase orders can be changed');
  const events = await replaceLines(ctx, DOC, id, row, lines);
  await reevaluate(ctx, 'purchase_order', id);
  return events;
}

/** Draft → sent (approval enforced). Sending by email happens from the PO page with a template. */
export async function issuePo(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'purchase_order', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('This purchase order was already issued');
  const n = await ctx.tx.one<{ n: string }>(`select count(*) n from purchase_order_lines where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id]);
  if (!Number(n?.n)) throw badRequest('Add at least one line first');
  if (!row.vendor_id) throw badRequest('Choose the vendor first');
  const v = await ctx.tx.one<{ status: string; name: string }>(`select status, name from vendors where tenant_id = $1 and id = $2`, [ctx.tenantId, row.vendor_id]);
  if (v?.status === 'blocked') throw badRequest(`${v.name} is blocked; purchase orders cannot be issued to it`);
  if (row.approval_status === 'not_required' || row.approval_status === 'required') row.approval_status = await reevaluate(ctx, 'purchase_order', id);
  assertApproved(row, 'purchase order');
  await ctx.tx.query(`update purchase_orders set status = 'sent', sent_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'purchase_order',$3)`, [ctx.tenantId, `Issued to ${v?.name ?? 'vendor'}`, id]);
  return [{ objectKey: 'purchase_order', recordId: id, kind: 'updated', changes: { status: ['draft', 'sent'] } }];
}

export async function closePo(ctx: RecordCtx, id: string, cancel: boolean, reason: string | null): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'purchase_order', id, 'update', true);
  const from = String(row.status);
  if (cancel) {
    if (!['draft', 'sent'].includes(from)) throw badRequest('Goods were received against this PO; close it instead of cancelling');
  } else if (!['sent', 'partially_received'].includes(from)) throw badRequest('Only open purchase orders can be closed');
  const to = cancel ? 'cancelled' : 'closed';
  await ctx.tx.query(`update purchase_orders set status = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, to]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id) values ($1,'system',$2,$3,'purchase_order',$4)`, [ctx.tenantId, cancel ? 'Cancelled' : 'Closed short', reason, id]);
  return [{ objectKey: 'purchase_order', recordId: id, kind: 'updated', changes: { status: [from, to] } }];
}

export interface ReceiptInput {
  warehouseId?: string | null;
  receivedOn?: string | null;
  vendorInvoice?: string | null;
  notes?: string | null;
  lines: { poLineId: string; received: number; rejected?: number; reason?: string | null }[];
}

/** Goods receipt note: accepted quantities go into stock; rejections are recorded for vendor quality. */
export async function receiveGoods(ctx: RecordCtx, poId: string, input: ReceiptInput) {
  assertCanMoveStock(ctx);
  const { row } = await loadRow(ctx, 'purchase_order', poId, 'update', true);
  if (!['sent', 'partially_received'].includes(String(row.status))) throw badRequest('Issue the purchase order before receiving goods');
  const lines = await readLines(ctx, DOC, poId);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const wh = input.warehouseId ?? (row.warehouse_id as string | null) ?? (await defaultWarehouse(ctx));
  const take = input.lines.filter((l) => l.received > 0 || (l.rejected ?? 0) > 0);
  if (!take.length) throw badRequest('Enter the quantities received');
  for (const l of take) {
    const pl = byId.get(l.poLineId);
    if (!pl) throw badRequest('A line does not belong to this purchase order');
    if (l.received < 0 || (l.rejected ?? 0) < 0) throw badRequest('Quantities cannot be negative');
    const open = Number(pl.quantity) - Number(pl.receivedQty ?? 0);
    if (l.received > open + 1e-9) throw badRequest(`${pl.name}: only ${open} still to receive`);
  }
  const number = await nextDocumentNumber(ctx, 'grn', 'GRN');
  const grn = await ctx.tx.one<{ id: string }>(
    `insert into goods_receipts (tenant_id, receipt_number, po_id, warehouse_id, received_on, vendor_invoice, notes) values ($1,$2,$3,$4,coalesce($5::date, current_date),$6,$7) returning id`,
    [ctx.tenantId, number, poId, wh, input.receivedOn ?? null, input.vendorInvoice ?? null, input.notes ?? null],
  );
  for (const l of take) {
    const pl = byId.get(l.poLineId)!;
    await ctx.tx.query(`insert into goods_receipt_lines (tenant_id, receipt_id, po_line_id, product_id, qty_received, qty_rejected, rejection_reason) values ($1,$2,$3,$4,$5,$6,$7)`, [
      ctx.tenantId, grn!.id, pl.id, pl.productId, l.received, l.rejected ?? 0, l.reason ?? null,
    ]);
    await ctx.tx.query(`update purchase_order_lines set received_qty = received_qty + $3, rejected_qty = rejected_qty + $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, pl.id, l.received, l.rejected ?? 0]);
    if (pl.productId && l.received > 0) {
      const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2`, [ctx.tenantId, pl.productId]);
      if (p?.product_type === 'goods') {
        await moveStock(ctx, { productId: pl.productId, warehouseId: wh, type: 'in', qty: l.received, unitCost: pl.unitPrice, ref: { object: 'purchase_order', id: poId, label: `${number} · ${row.po_number}` } });
        // last purchase price becomes the cost price (stock valuation, margins)
        await ctx.tx.query(`update products set cost_price = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, pl.productId, pl.unitPrice]);
      }
    }
  }
  const t = await ctx.tx.one<{ q: string; r: string }>(`select sum(quantity) q, sum(received_qty) r from purchase_order_lines where tenant_id = $1 and order_id = $2`, [ctx.tenantId, poId]);
  const done = Number(t!.r) + 1e-9 >= Number(t!.q);
  const to = done ? 'received' : 'partially_received';
  await ctx.tx.query(`update purchase_orders set status = $3, received_at = case when $4 then now() else received_at end where tenant_id = $1 and id = $2`, [ctx.tenantId, poId, to, done]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id) values ($1,'system',$2,$3,'purchase_order',$4)`, [
    ctx.tenantId, `Goods received (${number})`, input.notes ?? null, poId,
  ]);
  const events: RecordEvent[] = [{ objectKey: 'purchase_order', recordId: poId, kind: 'updated', changes: { status: [row.status, to] } }];
  return { receiptId: grn!.id, receiptNumber: number, events };
}

/** Back-to-back purchase order for (some of) a sales order's lines, at cost price. */
export async function poFromOrder(ctx: RecordCtx, orderId: string, vendorId: string, lineIds: string[] | null) {
  const { row: so } = await loadRow(ctx, 'sales_order', orderId, 'read');
  const v = await ctx.tx.one<{ name: string; lead_time_days: number | null }>(`select name, lead_time_days from vendors where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, vendorId]);
  if (!v) throw notFound('Vendor not found');
  const lines = (await readLines(ctx, LINE_DOCS.sales_order!, orderId)).filter((l) => !lineIds || lineIds.includes(l.id));
  if (!lines.length) throw badRequest('Pick at least one line');
  const r = await createRecord(ctx, 'purchase_order', {
    name: `${so.name} — ${v.name}`,
    vendor_id: vendorId,
    sales_order_id: orderId,
    ...(v.lead_time_days ? { expected_date: new Date(Date.now() + v.lead_time_days * 86_400_000).toISOString().slice(0, 10) } : {}),
  });
  const input: LineInput[] = [];
  for (const l of lines) {
    const p = l.productId ? await ctx.tx.one<{ cost_price: string | null }>(`select cost_price from products where tenant_id = $1 and id = $2`, [ctx.tenantId, l.productId]) : null;
    input.push({ productId: l.productId, name: l.name, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: l.quantity, unitPrice: Number(p?.cost_price ?? 0), discountPct: 0, taxRate: l.taxRate });
  }
  const events = [...r.events, ...(await savePoLines(ctx, r.record.id, input))];
  return { id: r.record.id, events };
}

/** On-time delivery, rejection rate, lead time and spend for a vendor. */
export async function vendorPerformance(ctx: RecordCtx, vendorId: string) {
  await loadRow(ctx, 'vendor', vendorId, 'read');
  const r = await ctx.tx.one<Record<string, unknown>>(
    `with pos as (
       select * from purchase_orders where tenant_id = $1 and vendor_id = $2 and deleted_at is null and status <> 'cancelled'
     ), lines as (
       select l.* from purchase_order_lines l join pos on pos.id = l.order_id where l.tenant_id = $1
     ), firsts as (
       select g.po_id, min(g.received_on) as first_receipt from goods_receipts g join pos on pos.id = g.po_id where g.tenant_id = $1 group by g.po_id
     )
     select (select count(*) from pos)::int as orders,
            (select count(*) from pos where status in ('sent', 'partially_received'))::int as open_orders,
            (select coalesce(sum(grand_total), 0) from pos where status <> 'draft')::float8 as spend,
            (select max(order_date) from pos) as last_order,
            (select count(*) from pos where status in ('received', 'closed') and expected_date is not null)::int as completed_with_due,
            (select count(*) from pos where status in ('received', 'closed') and expected_date is not null and received_at::date <= expected_date)::int as on_time,
            (select round(avg(f.first_receipt - p.order_date)::numeric, 1) from pos p join firsts f on f.po_id = p.id)::float8 as avg_lead_days,
            (select coalesce(sum(received_qty), 0) from lines)::float8 as received,
            (select coalesce(sum(rejected_qty), 0) from lines)::float8 as rejected,
            (select count(*) from pos where status in ('sent', 'partially_received') and expected_date < current_date)::int as overdue`,
    [ctx.tenantId, vendorId],
  );
  const onTimePct = Number(r!.completed_with_due) ? Math.round((Number(r!.on_time) / Number(r!.completed_with_due)) * 100) : null;
  const inspected = Number(r!.received) + Number(r!.rejected);
  const rejectionPct = inspected ? Math.round((Number(r!.rejected) / inspected) * 1000) / 10 : null;
  // simple 5-star rating: punctuality and quality weigh equally
  const parts = [onTimePct, rejectionPct === null ? null : 100 - Math.min(100, rejectionPct * 5)].filter((x): x is number => x !== null);
  const rating = parts.length ? Math.round((parts.reduce((a, b) => a + b, 0) / parts.length / 20) * 10) / 10 : null;
  return { ...r, onTimePct, rejectionPct, rating };
}
