/**
 * GST billing.
 *
 *  draft ──issue──▶ issued ──payments──▶ partially_paid ─▶ paid
 *    │                 └──cancel (no payments / credit notes)──▶ cancelled
 *    └─ lines editable; numbers are assigned only at issue (gap-free FY series)
 *
 * Tax: place of supply (customer state) vs the seller's state decides CGST+SGST or IGST. Buyer
 * and seller details are snapshotted at issue; the database refuses later edits of an issued
 * document (only payment state, e-invoice details and cancellation may change).
 */
import { splitTax, stateCode, stateName, supplyType, validGstin } from '@synapse/shared';
import { badRequest, conflict, notFound } from '../lib/errors';
import { assertApproved, reevaluate } from './approvals';
import { enabledApps } from './apps';
import { assertProducts } from './lines';
import { nextFyNumber } from './numbering';
import { computeLines, letterhead, type LineInput } from './quotes';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, readRowSystem, toDto } from './records';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface BillingSettings {
  invoicePrefix: string;
  creditNotePrefix: string;
  receiptPrefix: string;
  dueDays: number;
  roundOff: boolean;
  bankDetails: string;
  ledgers: { sales: string; cgst: string; sgst: string; igst: string; roundOff: string; bank: string };
}

export async function billingSettings(ctx: RecordCtx): Promise<BillingSettings> {
  const r = await ctx.tx.one<{ b: Partial<BillingSettings> | null }>(`select settings -> 'billing' as b from tenants where id = $1`, [ctx.tenantId]);
  const b = r?.b ?? {};
  return {
    invoicePrefix: b.invoicePrefix || 'INV',
    creditNotePrefix: b.creditNotePrefix || 'CN',
    receiptPrefix: b.receiptPrefix || 'RCPT',
    dueDays: Number.isFinite(Number(b.dueDays)) ? Number(b.dueDays) : 15,
    roundOff: b.roundOff !== false,
    bankDetails: b.bankDetails ?? '',
    ledgers: { sales: 'Sales', cgst: 'Output CGST', sgst: 'Output SGST', igst: 'Output IGST', roundOff: 'Round Off', bank: 'Bank', ...(b.ledgers ?? {}) },
  };
}

interface InvLineRow {
  id: string;
  position: number;
  product_id: string | null;
  order_line_id: string | null;
  name: string;
  description: string | null;
  hsn_sac: string | null;
  unit: string | null;
  is_service: boolean;
  quantity: string;
  unit_price: string;
  discount_pct: string;
  tax_rate: string;
  line_subtotal: string;
  line_tax: string;
  line_total: string;
  line_cgst: string;
  line_sgst: string;
  line_igst: string;
}

const lineDto = (l: InvLineRow) => ({
  id: l.id,
  position: l.position,
  productId: l.product_id,
  orderLineId: l.order_line_id,
  name: l.name,
  description: l.description,
  hsnSac: l.hsn_sac,
  unit: l.unit,
  isService: l.is_service,
  quantity: Number(l.quantity),
  unitPrice: Number(l.unit_price),
  discountPct: Number(l.discount_pct),
  taxRate: Number(l.tax_rate),
  lineSubtotal: Number(l.line_subtotal),
  lineTax: Number(l.line_tax),
  lineTotal: Number(l.line_total),
  cgst: Number(l.line_cgst),
  sgst: Number(l.line_sgst),
  igst: Number(l.line_igst),
});

export async function invoiceLines(ctx: RecordCtx, id: string) {
  return (await ctx.tx.query<InvLineRow>(`select * from invoice_lines where tenant_id = $1 and order_id = $2 order by position`, [ctx.tenantId, id])).map(lineDto);
}

/** Supply type for a draft from its place of supply and the company's state. */
async function taxContext(ctx: RecordCtx, row: Record<string, unknown>) {
  const company = await letterhead(ctx);
  const seller = stateCode(company.gstin) ?? stateCode(company.state);
  let pos = stateCode(String(row.place_of_supply ?? '')) ?? stateCode(String(row.buyer_gstin ?? ''));
  if (!pos && row.account_id) {
    const a = await ctx.tx.one<{ state: string | null; gstin: string | null }>(`select state, gstin from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, row.account_id]);
    pos = stateCode(a?.gstin ?? null) ?? stateCode(a?.state ?? null);
  }
  pos ??= seller;
  return { company, seller, pos, type: supplyType(seller, pos) };
}

/** Recomputes lines' tax split and the header totals (draft only). */
async function recompute(ctx: RecordCtx, id: string, row: Record<string, unknown>) {
  const tc = await taxContext(ctx, row);
  const settings = await billingSettings(ctx);
  const lines = await invoiceLines(ctx, id);
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const l of lines) {
    const s = splitTax(l.lineTax, tc.type);
    cgst += s.cgst;
    sgst += s.sgst;
    igst += s.igst;
    await ctx.tx.query(`update invoice_lines set line_cgst = $3, line_sgst = $4, line_igst = $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, s.cgst, s.sgst, s.igst]);
  }
  const c = computeLines(lines.map((l) => ({ ...l, discountPct: l.discountPct, taxRate: l.taxRate })) as LineInput[]);
  const exact = r2(c.subtotal - c.discountTotal + c.taxTotal);
  const total = settings.roundOff ? Math.round(exact) : exact;
  await ctx.tx.query(
    `update invoices set subtotal = $3, discount_total = $4, taxable_total = $5, cgst_total = $6, sgst_total = $7, igst_total = $8, tax_total = $9,
            round_off = $10, grand_total = $11, max_discount_pct = $12, pos_code = $13, supply_type = $14
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, c.subtotal, c.discountTotal, r2(c.subtotal - c.discountTotal), r2(cgst), r2(sgst), r2(igst), c.taxTotal, r2(total - exact), total, Math.max(0, ...lines.map((l) => l.discountPct)), tc.pos, tc.type],
  );
}

export async function getInvoice(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'invoice', id, 'read');
  const payments = await ctx.tx.query(
    `select p.id, p.payment_number, p.payment_date, p.mode, p.reference, a.amount::float8 as amount
       from payment_allocations a join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
      where a.tenant_id = $1 and a.invoice_id = $2 and p.status = 'received' order by p.payment_date`,
    [ctx.tenantId, id],
  );
  const credits = await ctx.tx.query(
    `select id, invoice_number, status, grand_total::float8 as grand_total, invoice_date from invoices where tenant_id = $1 and original_invoice_id = $2 and deleted_at is null order by created_at`,
    [ctx.tenantId, id],
  );
  const account = row.account_id ? await ctx.tx.one<Record<string, unknown>>(`select id, name, gstin, address, city, state, pincode from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, row.account_id]) : null;
  const settings = await billingSettings(ctx);
  return {
    invoice: { ...toDto(obj, row, ctx.principal.permissions), buyer_name: row.buyer_name, buyer_address: row.buyer_address, buyer_state: row.buyer_state, buyer_pincode: row.buyer_pincode, seller_gstin: row.seller_gstin, seller_state: row.seller_state, pos_code: row.pos_code, round_off: Number(row.round_off), ack_no: row.ack_no, ack_date: row.ack_date, financial_year: row.financial_year, subtotal: Number(row.subtotal), discount_total: Number(row.discount_total), tax_total: Number(row.tax_total) },
    lines: await invoiceLines(ctx, id),
    payments,
    credits,
    account,
    company: await letterhead(ctx),
    bankDetails: settings.bankDetails,
  };
}

export async function saveInvoiceLines(ctx: RecordCtx, id: string, input: (LineInput & { orderLineId?: string | null; isService?: boolean })[]): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'invoice', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('Issued invoices cannot be changed. Raise a credit note instead.');
  if (input.length > 300) throw badRequest('An invoice can have at most 300 lines');
  await assertProducts(ctx, input);
  const c = computeLines(input);
  await ctx.tx.query(`delete from invoice_lines where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id]);
  for (const [i, l] of c.lines.entries()) {
    const src = input[i]!;
    let isService = !!src.isService;
    if (src.productId && src.isService === undefined) {
      const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2`, [ctx.tenantId, src.productId]);
      isService = p?.product_type === 'service';
    }
    await ctx.tx.query(
      `insert into invoice_lines (tenant_id, order_id, position, product_id, order_line_id, name, description, hsn_sac, unit, is_service, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [ctx.tenantId, id, l.position, l.productId ?? null, src.orderLineId ?? null, l.name, l.description ?? null, l.hsnSac ?? null, l.unit ?? null, isService, l.quantity, l.unitPrice, l.discountPct, l.taxRate, l.lineSubtotal, l.lineTax, l.lineTotal],
    );
  }
  await recompute(ctx, id, row);
  await reevaluate(ctx, 'invoice', id);
  return [{ objectKey: 'invoice', recordId: id, kind: 'updated', changes: { lines: [null, input.length] } }];
}

/** Re-derives the tax split after header changes (place of supply) on a draft. */
export async function refreshDraft(ctx: RecordCtx, id: string) {
  const row = await readRowSystem(ctx, 'invoice', id);
  if (row?.status === 'draft') await recompute(ctx, id, row);
}

/**
 * Draft invoice from an order: everything not yet invoiced, or one payment milestone (each order
 * line billed at the milestone's share, keeping HSN and GST rates).
 */
export async function invoiceFromOrder(ctx: RecordCtx, orderId: string, opts: { milestoneId?: string | null }) {
  const { row: o } = await loadRow(ctx, 'sales_order', orderId, 'read');
  if (['draft', 'cancelled'].includes(String(o.status))) throw badRequest('Confirm the order before invoicing it');
  const lines = await ctx.tx.query<{ id: string; product_id: string | null; name: string; description: string | null; hsn_sac: string | null; unit: string | null; quantity: string; unit_price: string; discount_pct: string; tax_rate: string; invoiced_qty: string; line_subtotal: string }>(
    `select * from sales_order_lines where tenant_id = $1 and order_id = $2 order by position`,
    [ctx.tenantId, orderId],
  );
  const settings = await billingSettings(ctx);
  let input: (LineInput & { orderLineId?: string | null })[];
  let milestone: { id: string; name: string; amount: string; invoice_id: string | null } | null = null;
  if (opts.milestoneId) {
    milestone = await ctx.tx.one(`select id, name, amount, invoice_id from order_milestones where tenant_id = $1 and order_id = $2 and id = $3`, [ctx.tenantId, orderId, opts.milestoneId]);
    if (!milestone) throw notFound('Milestone not found');
    if (milestone.invoice_id) {
      const inv = await ctx.tx.one<{ status: string }>(`select status from invoices where tenant_id = $1 and id = $2`, [ctx.tenantId, milestone.invoice_id]);
      if (inv && inv.status !== 'cancelled') throw conflict('This milestone already has an invoice', { invoiceId: milestone.invoice_id });
    }
    const share = Number(milestone.amount) / Number(o.grand_total);
    if (!(share > 0)) throw badRequest('The milestone has no amount');
    input = lines.map((l) => ({
      productId: l.product_id,
      orderLineId: l.id,
      name: `${milestone!.name}: ${l.name}`,
      description: `${Math.round(share * 10000) / 100}% of ${Number(l.quantity)} ${l.unit ?? 'Nos'} — order ${o.order_number}`,
      hsnSac: l.hsn_sac,
      unit: 'Lot',
      quantity: 1,
      unitPrice: r2(Number(l.line_subtotal) * share),
      discountPct: 0,
      taxRate: Number(l.tax_rate),
    }));
  } else {
    input = lines
      .map((l) => ({ l, q: Number(l.quantity) - Number(l.invoiced_qty) }))
      .filter((x) => x.q > 1e-9)
      .map(({ l, q }) => ({ productId: l.product_id, orderLineId: l.id, name: l.name, description: l.description, hsnSac: l.hsn_sac, unit: l.unit, quantity: q, unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), taxRate: Number(l.tax_rate) }));
    if (!input.length) throw badRequest('Everything on this order is already invoiced');
  }
  const acc = o.account_id ? await ctx.tx.one<{ state: string | null }>(`select state from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, o.account_id]) : null;
  const billTo = (o.bill_to as Record<string, string> | null) ?? {};
  const r = await createRecord(ctx, 'invoice', {
    name: milestone ? `${o.name} — ${milestone.name}` : String(o.name),
    account_id: o.account_id ?? null,
    contact_id: o.contact_id ?? null,
    place_of_supply: billTo.state || acc?.state || null,
    shipping_address: o.site_address ?? null,
    due_date: new Date(Date.now() + settings.dueDays * 86_400_000).toISOString().slice(0, 10),
    ...(o.terms ? { terms: o.terms } : {}),
  });
  await ctx.tx.query(`update invoices set sales_order_id = $3, milestone_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, orderId, milestone?.id ?? null]);
  const events = [...r.events, ...(await saveInvoiceLines(ctx, r.record.id, input))];
  if (milestone) await ctx.tx.query(`update order_milestones set invoice_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, milestone.id, r.record.id]);
  return { id: r.record.id, events };
}

/** Assigns the GST number, snapshots the parties and locks the document. */
export async function issueInvoice(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'invoice', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('This invoice was already issued');
  const lines = await invoiceLines(ctx, id);
  if (!lines.length) throw badRequest('Add at least one line');
  if (!row.account_id) throw badRequest('Choose the customer');
  if (row.approval_status === 'not_required' || row.approval_status === 'required') row.approval_status = await reevaluate(ctx, 'invoice', id);
  assertApproved(row, row.doc_type === 'credit_note' ? 'credit note' : 'invoice');
  const acc = await ctx.tx.one<{ name: string; gstin: string | null; address: string | null; city: string | null; state: string | null; pincode: string | null }>(
    `select name, gstin, address, city, state, pincode from accounts where tenant_id = $1 and id = $2`,
    [ctx.tenantId, row.account_id],
  );
  if (!acc) throw badRequest('The customer no longer exists');
  if (acc.gstin && !validGstin(acc.gstin)) throw badRequest(`The customer's GSTIN ${acc.gstin} is not valid (check digit). Fix it on the account first.`);
  await recompute(ctx, id, row);
  const tc = await taxContext(ctx, row);
  if (tc.company.gstin && !validGstin(tc.company.gstin)) throw badRequest('Your company GSTIN in Sales setup is not valid');
  const settings = await billingSettings(ctx);
  const date = row.invoice_date instanceof Date ? (row.invoice_date as Date).toISOString().slice(0, 10) : String(row.invoice_date).slice(0, 10);
  const series = row.doc_type === 'credit_note' ? 'credit_note' : row.doc_type === 'proforma' ? 'proforma' : 'invoice';
  const n = await nextFyNumber(ctx, series, date, series === 'credit_note' ? settings.creditNotePrefix : series === 'proforma' ? 'PI' : settings.invoicePrefix);
  const due = row.due_date ?? new Date(new Date(`${date}T00:00:00Z`).getTime() + settings.dueDays * 86_400_000).toISOString().slice(0, 10);
  await ctx.tx.query(
    `update invoices set status = 'issued', invoice_number = $3, financial_year = $4, issued_at = now(), due_date = $5,
            buyer_name = $6, buyer_gstin = $7, buyer_address = $8, buyer_state = $9, buyer_pincode = $10,
            seller_gstin = $11, seller_state = $12, place_of_supply = coalesce(place_of_supply, $13)
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, id, n.number, n.fy, due,
      acc.name, acc.gstin, [acc.address, acc.city].filter(Boolean).join(', ') || null, acc.state, acc.pincode,
      tc.company.gstin || null, tc.company.state || null, stateName(tc.pos),
    ],
  );
  // order lines are now (partly) invoiced; a milestone invoice covers its share of each line
  for (const l of lines) if (l.orderLineId) await ctx.tx.query(invoicedSql(!!row.milestone_id, 1), [ctx.tenantId, l.orderLineId, row.milestone_id ? l.lineSubtotal : l.quantity]);
  const events: RecordEvent[] = [{ objectKey: 'invoice', recordId: id, kind: 'updated', changes: { status: ['draft', 'issued'] } }];
  if (row.doc_type === 'credit_note' && row.original_invoice_id) events.push(...(await applyCredit(ctx, String(row.original_invoice_id))));
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'invoice',$3)`, [ctx.tenantId, `Issued as ${n.number}`, id]);
  if (row.sales_order_id) await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'sales_order',$3)`, [ctx.tenantId, `${series === 'credit_note' ? 'Credit note' : 'Invoice'} ${n.number} issued`, row.sales_order_id]);
  return events;
}

/** invoiced_qty moves by a quantity, or (milestone invoices) by the value share of the line. */
function invoicedSql(byValue: boolean, sign: 1 | -1) {
  const delta = byValue ? `round(quantity * $3 / nullif(line_subtotal, 0), 3)` : `$3`;
  return `update sales_order_lines set invoiced_qty = least(quantity, greatest(invoiced_qty ${sign > 0 ? '+' : '-'} ${delta}, 0)) where tenant_id = $1 and id = $2`;
}

/** Credit notes reduce what the original invoice still owes. */
async function applyCredit(ctx: RecordCtx, invoiceId: string): Promise<RecordEvent[]> {
  await ctx.tx.query(
    `update invoices i set amount_credited = least(i.grand_total, coalesce((select sum(c.grand_total) from invoices c where c.tenant_id = i.tenant_id and c.original_invoice_id = i.id and c.doc_type = 'credit_note' and c.status <> 'draft' and c.status <> 'cancelled' and c.deleted_at is null), 0))
      where i.tenant_id = $1 and i.id = $2`,
    [ctx.tenantId, invoiceId],
  );
  return refreshInvoicePaid(ctx, invoiceId);
}

/** amount_paid from allocations of received payments; status follows the balance. */
export async function refreshInvoicePaid(ctx: RecordCtx, invoiceId: string): Promise<RecordEvent[]> {
  const before = await ctx.tx.one<{ status: string; amount_paid: string; sales_order_id: string | null }>(`select status, amount_paid, sales_order_id from invoices where tenant_id = $1 and id = $2`, [ctx.tenantId, invoiceId]);
  if (!before || before.status === 'draft' || before.status === 'cancelled') return [];
  const r = await ctx.tx.one<{ status: string; amount_paid: string }>(
    `update invoices i set amount_paid = x.paid,
            status = case when x.paid + i.amount_credited >= i.grand_total - 0.009 then 'paid' when x.paid > 0 or i.amount_credited > 0 then 'partially_paid' else 'issued' end
       from (select coalesce(sum(a.amount), 0) as paid from payment_allocations a join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
              where a.tenant_id = $1 and a.invoice_id = $2 and p.status = 'received') x
      where i.tenant_id = $1 and i.id = $2 and i.doc_type <> 'credit_note' returning i.status, i.amount_paid`,
    [ctx.tenantId, invoiceId],
  );
  const events: RecordEvent[] = [];
  if (r && r.status !== before.status) events.push({ objectKey: 'invoice', recordId: invoiceId, kind: 'updated', changes: { status: [before.status, r.status] } });
  // a milestone invoice keeps its milestone in step
  await ctx.tx.query(
    `update order_milestones m set amount_paid = least(m.amount, i.amount_paid + i.amount_credited),
            status = case when i.amount_paid + i.amount_credited >= m.amount - 0.009 then 'paid' when m.status = 'paid' then 'due' else m.status end,
            paid_at = case when i.amount_paid + i.amount_credited >= m.amount - 0.009 then coalesce(m.paid_at, now()) else null end
       from invoices i where i.tenant_id = $1 and i.id = $2 and m.tenant_id = $1 and m.id = i.milestone_id`,
    [ctx.tenantId, invoiceId],
  );
  if (before.sales_order_id) events.push(...(await refreshOrderPaid(ctx, before.sales_order_id)));
  return events;
}

/**
 * With billing on, an order's paid amount comes from money actually received: allocations to its
 * invoices plus the unapplied part of payments taken against the order (advances).
 */
export async function refreshOrderPaid(ctx: RecordCtx, orderId: string): Promise<RecordEvent[]> {
  const before = await ctx.tx.one<{ payment_status: string; amount_paid: string }>(`select payment_status, amount_paid from sales_orders where tenant_id = $1 and id = $2`, [ctx.tenantId, orderId]);
  if (!before) return [];
  const r = await ctx.tx.one<{ payment_status: string; amount_paid: string }>(
    `update sales_orders o set amount_paid = x.paid,
            payment_status = case when x.paid <= 0 then 'unpaid' when x.paid >= o.grand_total - 0.01 then 'paid' else 'partially_paid' end
       from (select
               coalesce((select sum(a.amount) from payment_allocations a join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
                          join invoices i on i.tenant_id = a.tenant_id and i.id = a.invoice_id
                         where a.tenant_id = $1 and i.sales_order_id = $2 and p.status = 'received' and i.status <> 'cancelled'), 0)
             + coalesce((select sum(p.unallocated) from payments p where p.tenant_id = $1 and p.sales_order_id = $2 and p.status = 'received' and p.deleted_at is null), 0) as paid) x
      where o.tenant_id = $1 and o.id = $2 returning o.payment_status, o.amount_paid`,
    [ctx.tenantId, orderId],
  );
  if (!r || (r.payment_status === before.payment_status && Number(r.amount_paid) === Number(before.amount_paid))) return [];
  return [{ objectKey: 'sales_order', recordId: orderId, kind: 'updated', changes: { amount_paid: [Number(before.amount_paid), Number(r.amount_paid)], payment_status: [before.payment_status, r.payment_status] } }];
}

export async function cancelInvoice(ctx: RecordCtx, id: string, reason: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'invoice', id, 'update', true);
  if (row.status === 'draft') throw badRequest('Delete the draft instead');
  if (row.status === 'cancelled') throw badRequest('Already cancelled');
  const paid = await ctx.tx.one<{ n: string }>(`select count(*) n from payment_allocations a join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id where a.tenant_id = $1 and a.invoice_id = $2 and p.status = 'received'`, [ctx.tenantId, id]);
  if (Number(paid?.n)) throw badRequest('Payments are applied to this invoice; remove them first or raise a credit note');
  const cn = await ctx.tx.one<{ n: string }>(`select count(*) n from invoices where tenant_id = $1 and original_invoice_id = $2 and status <> 'cancelled' and status <> 'draft' and deleted_at is null`, [ctx.tenantId, id]);
  if (Number(cn?.n)) throw badRequest('Credit notes exist against this invoice');
  await ctx.tx.query(`update invoices set status = 'cancelled', cancelled_at = now(), cancel_reason = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason]);
  for (const l of await invoiceLines(ctx, id)) if (l.orderLineId) await ctx.tx.query(invoicedSql(!!row.milestone_id, -1), [ctx.tenantId, l.orderLineId, row.milestone_id ? l.lineSubtotal : l.quantity]);
  if (row.milestone_id) await ctx.tx.query(`update order_milestones set invoice_id = null where tenant_id = $1 and id = $2 and invoice_id = $3`, [ctx.tenantId, row.milestone_id, id]);
  const events: RecordEvent[] = [{ objectKey: 'invoice', recordId: id, kind: 'updated', changes: { status: [row.status, 'cancelled'] } }];
  if (row.doc_type === 'credit_note' && row.original_invoice_id) events.push(...(await applyCredit(ctx, String(row.original_invoice_id))));
  if (row.sales_order_id) events.push(...(await refreshOrderPaid(ctx, String(row.sales_order_id))));
  return events;
}

/** Draft credit note against an issued invoice (all lines, or chosen quantities). */
export async function creditNoteFrom(ctx: RecordCtx, invoiceId: string, opts: { lines?: { lineId: string; quantity: number }[] | null; reason: string }) {
  const { row } = await loadRow(ctx, 'invoice', invoiceId, 'read');
  if (row.doc_type !== 'tax_invoice' || !['issued', 'partially_paid', 'paid'].includes(String(row.status))) throw badRequest('Credit notes can only be raised against issued tax invoices');
  const lines = await invoiceLines(ctx, invoiceId);
  const pick = opts.lines?.length ? opts.lines : lines.map((l) => ({ lineId: l.id, quantity: l.quantity }));
  const input: LineInput[] = [];
  for (const p of pick) {
    const l = lines.find((x) => x.id === p.lineId);
    if (!l) throw badRequest('A line does not belong to this invoice');
    if (!(p.quantity > 0) || p.quantity > l.quantity + 1e-9) throw badRequest(`${l.name}: credit between 0 and ${l.quantity}`);
    input.push({ productId: l.productId, name: l.name, description: l.description, hsnSac: l.hsnSac, unit: l.unit, quantity: p.quantity, unitPrice: l.unitPrice, discountPct: l.discountPct, taxRate: l.taxRate });
  }
  const r = await createRecord(ctx, 'invoice', {
    name: `Credit note — ${row.invoice_number}`,
    account_id: row.account_id ?? null,
    contact_id: row.contact_id ?? null,
    place_of_supply: row.place_of_supply ?? null,
    notes: opts.reason,
  });
  await ctx.tx.query(`update invoices set doc_type = 'credit_note', original_invoice_id = $3, sales_order_id = $4, due_date = null where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, invoiceId, row.sales_order_id ?? null]);
  const events = [...r.events, ...(await saveInvoiceLines(ctx, r.record.id, input))];
  return { id: r.record.id, events };
}

// ---------------------------------------------------------------------------------- payments
export interface PaymentInput {
  accountId?: string | null;
  salesOrderId?: string | null;
  milestoneId?: string | null;
  amount: number;
  date?: string | null;
  mode?: string | null;
  reference?: string | null;
  notes?: string | null;
  /** explicit allocations, or 'auto' (oldest due first) */
  allocations?: { invoiceId: string; amount: number }[] | 'auto' | null;
}

export async function recordPayment(ctx: RecordCtx, input: PaymentInput) {
  let accountId = input.accountId ?? null;
  if (!accountId && input.salesOrderId) {
    const o = await readRowSystem(ctx, 'sales_order', input.salesOrderId);
    if (!o) throw notFound('Order not found');
    accountId = (o.account_id as string | null) ?? null;
  }
  if (!accountId) throw badRequest('The order has no customer; choose the customer for this payment');
  const r = await createRecord(ctx, 'payment', {
    name: input.reference ? `Payment ${input.reference}` : 'Payment',
    account_id: accountId,
    sales_order_id: input.salesOrderId ?? null,
    amount: input.amount,
    payment_date: input.date ?? new Date().toISOString().slice(0, 10),
    mode: input.mode ?? 'bank_transfer',
    reference: input.reference ?? null,
    notes: input.notes ?? null,
  });
  const id = r.record.id;
  const events: RecordEvent[] = [...r.events];
  if (input.milestoneId) await ctx.tx.query(`update payments set milestone_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, input.milestoneId]);
  await ctx.tx.query(`update payments set name = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, `${r.record.payment_number}${input.reference ? ` · ${input.reference}` : ''}`]);
  if (input.allocations) events.push(...(await allocatePayment(ctx, id, input.allocations)));
  if (input.salesOrderId) events.push(...(await refreshOrderPaid(ctx, input.salesOrderId)));
  return { id, number: r.record.payment_number as string, events };
}

export async function allocatePayment(ctx: RecordCtx, paymentId: string, allocations: { invoiceId: string; amount: number }[] | 'auto'): Promise<RecordEvent[]> {
  const { row: p } = await loadRow(ctx, 'payment', paymentId, 'update', true);
  if (p.status !== 'received') throw badRequest('This payment is void');
  let left = r2(Number(p.amount) - Number(p.amount_allocated));
  let plan: { invoiceId: string; amount: number }[];
  if (allocations === 'auto') {
    const open = await ctx.tx.query<{ id: string; balance_due: string }>(
      `select id, balance_due from invoices where tenant_id = $1 and account_id = $2 and doc_type = 'tax_invoice' and status in ('issued', 'partially_paid') and deleted_at is null
         and ($3::uuid is null or sales_order_id = $3::uuid) order by due_date nulls last, invoice_date, invoice_number`,
      [ctx.tenantId, p.account_id, p.sales_order_id ?? null],
    );
    plan = [];
    for (const inv of open) {
      if (left <= 0) break;
      const a = r2(Math.min(left, Number(inv.balance_due)));
      if (a > 0) {
        plan.push({ invoiceId: inv.id, amount: a });
        left = r2(left - a);
      }
    }
    left = r2(Number(p.amount) - Number(p.amount_allocated));
  } else plan = allocations;
  const total = r2(plan.reduce((s, a) => s + a.amount, 0));
  if (total > left + 0.009) throw badRequest(`Only ${left} of this payment is left to apply`);
  const touched = new Set<string>();
  for (const a of plan) {
    if (!(a.amount > 0)) continue;
    const inv = await ctx.tx.one<{ account_id: string | null; status: string; balance_due: string; doc_type: string }>(
      `select account_id, status, balance_due, doc_type from invoices where tenant_id = $1 and id = $2 and deleted_at is null for update`,
      [ctx.tenantId, a.invoiceId],
    );
    if (!inv || inv.doc_type !== 'tax_invoice') throw badRequest('Invoice not found');
    if (inv.account_id !== p.account_id) throw badRequest('The invoice belongs to another customer');
    if (!['issued', 'partially_paid'].includes(inv.status)) throw badRequest('Only open invoices take payments');
    if (a.amount > Number(inv.balance_due) + 0.009) throw badRequest(`That is more than the invoice balance (${Number(inv.balance_due)})`);
    await ctx.tx.query(
      `insert into payment_allocations (tenant_id, payment_id, invoice_id, amount) values ($1,$2,$3,$4)
       on conflict (tenant_id, payment_id, invoice_id) do update set amount = payment_allocations.amount + excluded.amount`,
      [ctx.tenantId, paymentId, a.invoiceId, a.amount],
    );
    touched.add(a.invoiceId);
  }
  await ctx.tx.query(`update payments set amount_allocated = (select coalesce(sum(amount), 0) from payment_allocations where tenant_id = $1 and payment_id = $2) where tenant_id = $1 and id = $2`, [ctx.tenantId, paymentId]);
  const events: RecordEvent[] = [];
  for (const i of touched) events.push(...(await refreshInvoicePaid(ctx, i)));
  if (p.sales_order_id) events.push(...(await refreshOrderPaid(ctx, String(p.sales_order_id))));
  return events;
}

export async function voidPayment(ctx: RecordCtx, id: string, reason: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'payment', id, 'update', true);
  if (row.status === 'void') throw badRequest('Already void');
  const invs = await ctx.tx.query<{ invoice_id: string }>(`delete from payment_allocations where tenant_id = $1 and payment_id = $2 returning invoice_id`, [ctx.tenantId, id]);
  await ctx.tx.query(`update payments set status = 'void', amount_allocated = 0, void_reason = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason]);
  if (row.milestone_id) {
    await ctx.tx.query(`update order_milestones set amount_paid = greatest(amount_paid - $3, 0), status = case when status = 'paid' then 'due' else status end, paid_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, row.milestone_id, row.amount]);
  }
  const events: RecordEvent[] = [{ objectKey: 'payment', recordId: id, kind: 'updated', changes: { status: ['received', 'void'] } }];
  for (const i of invs) events.push(...(await refreshInvoicePaid(ctx, i.invoice_id)));
  if (row.sales_order_id) events.push(...(await refreshOrderPaid(ctx, String(row.sales_order_id))));
  return events;
}

export async function getPayment(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'payment', id, 'read');
  const allocations = await ctx.tx.query(
    `select a.invoice_id, a.amount::float8 as amount, i.invoice_number, i.invoice_date, i.grand_total::float8 as grand_total, i.balance_due::float8 as balance_due
       from payment_allocations a join invoices i on i.tenant_id = a.tenant_id and i.id = a.invoice_id where a.tenant_id = $1 and a.payment_id = $2`,
    [ctx.tenantId, id],
  );
  const open = row.status === 'received'
    ? await ctx.tx.query(
        `select id, invoice_number, invoice_date, due_date, grand_total::float8 as grand_total, balance_due::float8 as balance_due from invoices
          where tenant_id = $1 and account_id = $2 and doc_type = 'tax_invoice' and status in ('issued', 'partially_paid') and deleted_at is null order by due_date nulls last, invoice_date`,
        [ctx.tenantId, row.account_id],
      )
    : [];
  return { payment: { ...toDto(obj, row, ctx.principal.permissions), void_reason: row.void_reason ?? null, milestone_id: row.milestone_id ?? null }, allocations, openInvoices: open };
}

/** Milestone payment with the billing app on: a receipt against the order, applied to the milestone's invoice when there is one. */
export async function milestoneReceipt(ctx: RecordCtx, orderId: string, milestoneId: string, amount: number, note: string | null) {
  const m = await ctx.tx.one<{ invoice_id: string | null; name: string }>(`select invoice_id, name from order_milestones where tenant_id = $1 and order_id = $2 and id = $3`, [ctx.tenantId, orderId, milestoneId]);
  if (!m) throw notFound();
  let alloc: { invoiceId: string; amount: number }[] | null = null;
  if (m.invoice_id) {
    const inv = await ctx.tx.one<{ status: string; balance_due: string }>(`select status, balance_due from invoices where tenant_id = $1 and id = $2`, [ctx.tenantId, m.invoice_id]);
    if (inv && ['issued', 'partially_paid'].includes(inv.status)) alloc = [{ invoiceId: m.invoice_id, amount: r2(Math.min(amount, Number(inv.balance_due))) }];
  }
  return recordPayment(ctx, { salesOrderId: orderId, milestoneId, amount, reference: note, notes: `Milestone: ${m.name}`, allocations: alloc });
}

// ---------------------------------------------------------------------------------- receivables
export async function receivables(ctx: RecordCtx) {
  const rows = await ctx.tx.query<Record<string, unknown>>(
    `select a.id as account_id, a.name, count(*)::int as invoices,
            sum(i.balance_due)::float8 as outstanding,
            sum(i.balance_due) filter (where i.due_date >= current_date or i.due_date is null)::float8 as not_due,
            sum(i.balance_due) filter (where current_date - i.due_date between 1 and 30)::float8 as d1_30,
            sum(i.balance_due) filter (where current_date - i.due_date between 31 and 60)::float8 as d31_60,
            sum(i.balance_due) filter (where current_date - i.due_date between 61 and 90)::float8 as d61_90,
            sum(i.balance_due) filter (where current_date - i.due_date > 90)::float8 as d90,
            min(i.due_date) as oldest_due
       from invoices i join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and i.doc_type = 'tax_invoice' and i.status in ('issued', 'partially_paid') and i.deleted_at is null and i.balance_due > 0
      group by a.id, a.name order by outstanding desc limit 500`,
    [ctx.tenantId],
  );
  const unapplied = await ctx.tx.one<{ v: string }>(`select coalesce(sum(unallocated), 0) v from payments where tenant_id = $1 and status = 'received' and deleted_at is null`, [ctx.tenantId]);
  const totals = rows.reduce<Record<string, number>>((t, r) => {
    for (const k of ['outstanding', 'not_due', 'd1_30', 'd31_60', 'd61_90', 'd90']) t[k] = r2((t[k] ?? 0) + Number(r[k] ?? 0));
    return t;
  }, {});
  return { items: rows, totals: { ...totals, unapplied: Number(unapplied?.v ?? 0) } };
}

/** Overdue reminders (cron): one notification per invoice to its owner. */
export async function sweepOverdue(ctx: { tx: RecordCtx['tx'] }, tenantId: string) {
  const rows = await ctx.tx.query<{ id: string; invoice_number: string; buyer_name: string | null; owner_id: string | null; balance_due: string }>(
    `update invoices set overdue_notified_at = now()
      where tenant_id = $1 and status in ('issued', 'partially_paid') and doc_type = 'tax_invoice' and due_date < current_date and overdue_notified_at is null and deleted_at is null and balance_due > 0
      returning id, invoice_number, buyer_name, owner_id, balance_due`,
    [tenantId],
  );
  for (const r of rows) {
    if (!r.owner_id) continue;
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'invoice',$3,$4,$5)`, [
      tenantId, r.owner_id, `Overdue: ${r.invoice_number}`, `${r.buyer_name ?? ''} · ₹${Number(r.balance_due).toLocaleString('en-IN')} outstanding`, `/o/invoice/${r.id}`,
    ]);
  }
}

export function billingEnabled(ctx: RecordCtx) {
  return enabledApps(ctx.meta).has('billing');
}

