/**
 * Payables: vendor bills, vendor credits (debit notes) and vendor payments.
 *
 *  bill:          draft ──post──▶ open ──payments / credits──▶ partially_paid ─▶ paid      (void if nothing applied)
 *  vendor credit: draft ──post──▶ open ──applied to bills──▶ paid
 *  payment:       paid (allocated to bills; the rest is an advance) ──▶ void
 *
 * Tax: the vendor's state (GSTIN) against your own decides CGST+SGST or IGST. Reverse-charge
 * bills carry no GST from the supplier; you self-assess it (input credit + RCM liability).
 * TDS is deducted on the taxable value at the section's rate and is not paid to the vendor.
 */
import { financialYear, splitTax, stateCode, TDS_SECTIONS } from '@synapse/shared';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors';
import { assertApproved, reevaluate } from '../approvals';
import { billingSettings } from '../billing';
import { nextFyNumber } from '../numbering';
import { computeLines, letterhead, lineSchema } from '../quotes';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, toDto } from '../records';
import { lineDto } from '../lines';
import { r2, d10 } from './ledger';
import { repost } from './posting';

export const billLineSchema = lineSchema.extend({
  accountId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  poLineId: z.string().uuid().nullish(),
});
export type BillLineInput = z.infer<typeof billLineSchema>;


export async function billLines(ctx: RecordCtx, id: string) {
  return ctx.tx.query<Record<string, any>>(
    `select l.*, a.name as account_name from bill_lines l left join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id where l.tenant_id = $1 and l.order_id = $2 order by l.position`,
    [ctx.tenantId, id],
  );
}

async function assertPostingAccounts(ctx: RecordCtx, ids: (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return;
  const rows = await ctx.tx.query<{ id: string; subtype: string; is_active: boolean }>(`select id, subtype, is_active from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, want]);
  if (rows.length !== want.length) throw badRequest('An account on a line does not exist');
  for (const r of rows) {
    if (!r.is_active) throw badRequest('An account on a line is inactive');
    if (['accounts_receivable', 'accounts_payable', 'bank', 'cash', 'credit_card', 'tax_payable', 'retained_earnings'].includes(r.subtype)) throw badRequest('Choose an expense, asset or inventory account for bill lines');
  }
}

/** Replaces a draft bill's lines and recomputes it. */
export async function saveBillLines(ctx: RecordCtx, id: string, input: BillLineInput[]): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'bill', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('Only draft bills can be edited');
  if (input.length > 300) throw badRequest('A bill can have at most 300 lines');
  await assertPostingAccounts(ctx, input.map((l) => l.accountId));
  const pids = [...new Set(input.map((l) => l.productId).filter((x): x is string => !!x))];
  if (pids.length) {
    const found = await ctx.tx.query(`select id from products where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, pids]);
    if (found.length !== pids.length) throw badRequest('A product on this bill no longer exists');
  }
  const c = computeLines(input);
  await ctx.tx.query(`delete from bill_lines where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id]);
  for (const l of c.lines) {
    const src = input[l.position - 1]!;
    await ctx.tx.query(
      `insert into bill_lines (tenant_id, order_id, position, product_id, po_line_id, account_id, name, description, hsn_sac, unit, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total, project_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [ctx.tenantId, id, l.position, l.productId ?? null, src.poLineId ?? null, src.accountId ?? null, l.name, l.description ?? null, l.hsnSac ?? null, l.unit ?? null, l.quantity, l.unitPrice, l.discountPct, l.taxRate, l.lineSubtotal, l.lineTax, l.lineTotal, src.projectId ?? null],
    );
  }
  await recomputeBill(ctx, id);
  return [{ objectKey: 'bill', recordId: id, kind: 'updated' }];
}

/** Tax split, totals, TDS and round-off of a draft bill. */
export async function recomputeBill(ctx: RecordCtx, id: string) {
  const b = await ctx.tx.one<Record<string, any>>(`select * from bills where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!b) throw notFound();
  const company = await letterhead(ctx);
  const ours = stateCode(company.gstin) ?? stateCode(company.state);
  const vendor = await ctx.tx.one<{ state: string | null; gstin: string | null }>(`select state, gstin from vendors where tenant_id = $1 and id = $2`, [ctx.tenantId, b.vendor_id]);
  const theirs = stateCode(b.vendor_gstin ?? vendor?.gstin ?? null) ?? stateCode(b.place_of_supply ?? vendor?.state ?? null);
  const type = b.supply_type === 'import' ? 'inter' : !ours || !theirs || ours === theirs ? 'intra' : 'inter';
  const lines = await billLines(ctx, id);
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  for (const l of lines) {
    const s = splitTax(Number(l.line_tax), type);
    cgst += s.cgst;
    sgst += s.sgst;
    igst += s.igst;
    await ctx.tx.query(`update bill_lines set line_cgst = $3, line_sgst = $4, line_igst = $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, s.cgst, s.sgst, s.igst]);
  }
  const subtotal = r2(lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unit_price), 0));
  const taxable = r2(lines.reduce((a, l) => a + Number(l.line_subtotal), 0));
  const tax = r2(cgst + sgst + igst);
  // under reverse charge the supplier charges no GST: you pay it to the government yourself
  const exact = r2(taxable + (b.reverse_charge ? 0 : tax));
  const settings = await billingSettings(ctx);
  const total = settings.roundOff ? Math.round(exact) : exact;
  const section = b.tds_section ? TDS_SECTIONS.find((s) => s.section === b.tds_section) : null;
  const tdsRate = b.doc_type === 'vendor_credit' ? 0 : Number(b.tds_rate) || section?.rate || 0;
  const tds = r2((taxable * tdsRate) / 100);
  await ctx.tx.query(
    `update bills set subtotal = $3, discount_total = $4, taxable_total = $5, cgst_total = $6, sgst_total = $7, igst_total = $8, tax_total = $9, round_off = $10, grand_total = $11,
            tds_rate = $12, tds_amount = $13, supply_type = coalesce(nullif(supply_type, 'import'), $14), pos_code = $15, max_discount_pct = $16
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, subtotal, r2(subtotal - taxable), taxable, r2(cgst), r2(sgst), r2(igst), tax, r2(total - exact), total, tdsRate, tds, type, ours, Math.max(0, ...lines.map((l) => Number(l.discount_pct)))],
  );
}

export async function getBill(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'bill', id, 'read');
  const lines = await billLines(ctx, id);
  const payments = await ctx.tx.query(
    `select p.id, p.payment_number, p.payment_date, p.mode, p.reference, a.amount::float8 as amount from vendor_payment_allocations a join vendor_payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
      where a.tenant_id = $1 and a.bill_id = $2 and p.status = 'paid' order by p.payment_date`,
    [ctx.tenantId, id],
  );
  const credits = await ctx.tx.query(
    `select c.id, c.bill_number, c.bill_date, x.amount::float8 as amount from vendor_credit_applications x join bills c on c.tenant_id = x.tenant_id and c.id = ${row.doc_type === 'vendor_credit' ? 'x.bill_id' : 'x.credit_id'}
      where x.tenant_id = $1 and ${row.doc_type === 'vendor_credit' ? 'x.credit_id' : 'x.bill_id'} = $2`,
    [ctx.tenantId, id],
  );
  const journal = await ctx.tx.one<{ id: string }>(`select id from journals where tenant_id = $1 and source_id = $2 and source_type in ('bill','vendor_credit') and status = 'posted'`, [ctx.tenantId, id]);
  const dtoLines = lines.map((l) => ({ ...lineDto(l, []), accountId: l.account_id ?? null, accountName: l.account_name ?? null, projectId: l.project_id ?? null, poLineId: l.po_line_id ?? null }));
  const bill = { ...toDto(obj, row, ctx.principal.permissions), supply_type: row.supply_type ?? null, round_off: Number(row.round_off ?? 0) };
  return { bill, lines: dtoLines, payments, credits, journalId: journal?.id ?? null, voidReason: row.void_reason ?? null };
}

/** Moves stock cost: the bill's price becomes part of the item's moving average cost. */
async function updateItemCosts(ctx: RecordCtx, id: string, rate: number) {
  const rows = await ctx.tx.query<{ product_id: string; quantity: string; line_subtotal: string }>(
    `select l.product_id, l.quantity, l.line_subtotal from bill_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = $1 and l.order_id = $2 and p.product_type = 'goods'`,
    [ctx.tenantId, id],
  );
  for (const r of rows) {
    const qty = Number(r.quantity);
    const unit = (Number(r.line_subtotal) * rate) / qty;
    await ctx.tx.query(
      `update products p set purchase_price = round($3::numeric, 2),
              avg_cost = case when coalesce(p.avg_cost, 0) = 0 then $3::numeric
                              else round(((greatest(coalesce((select sum(on_hand) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0) - $4::numeric, 0) * p.avg_cost) + $4::numeric * $3::numeric)
                                         / greatest(coalesce((select sum(on_hand) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0), $4::numeric), 4) end
        where p.tenant_id = $1 and p.id = $2`,
      [ctx.tenantId, r.product_id, unit, qty],
    );
  }
}

export async function postBill(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'bill', id, 'update', true);
  if (row.status !== 'draft') throw badRequest('This bill was already posted');
  const lines = await billLines(ctx, id);
  if (!lines.length) throw badRequest('Add at least one line');
  if (row.approval_status === 'not_required' || row.approval_status === 'required') row.approval_status = await reevaluate(ctx, 'bill', id);
  assertApproved(row, row.doc_type === 'vendor_credit' ? 'vendor credit' : 'bill');
  await recomputeBill(ctx, id);
  if (row.doc_type === 'vendor_credit') {
    const orig = row.original_bill_id ? await ctx.tx.one<{ grand_total: string; vendor_id: string }>(`select grand_total, vendor_id from bills where tenant_id = $1 and id = $2`, [ctx.tenantId, row.original_bill_id]) : null;
    if (orig && orig.vendor_id !== row.vendor_id) throw badRequest('The vendor credit must be for the same vendor as the bill');
  }
  const date = d10(row.bill_date);
  const n = await nextFyNumber(ctx, row.doc_type === 'vendor_credit' ? 'vendor_credit' : 'bill', date, row.doc_type === 'vendor_credit' ? 'VC' : 'BILL');
  await ctx.tx.query(`update bills set status = 'open', bill_number = $3, financial_year = $4, posted_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, n.number, financialYear(date)]);
  if (row.doc_type === 'bill') await updateItemCosts(ctx, id, Number(row.exchange_rate ?? 1));
  await refreshBillPaid(ctx, id);
  await repost(ctx.tx, ctx.tenantId, row.doc_type === 'vendor_credit' ? 'vendor_credit' : 'bill', id);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'bill',$3)`, [ctx.tenantId, `Posted as ${n.number}`, id]);
  return [{ objectKey: 'bill', recordId: id, kind: 'updated', changes: { status: ['draft', 'open'] } }];
}

export async function voidBill(ctx: RecordCtx, id: string, reason: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'bill', id, 'update', true);
  if (row.status === 'draft') throw badRequest('Delete the draft instead');
  if (row.status === 'void') throw badRequest('Already void');
  const used = await ctx.tx.one<{ n: number }>(
    `select (select count(*) from vendor_payment_allocations a join vendor_payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id where a.tenant_id = $1 and a.bill_id = $2 and p.status = 'paid')
          + (select count(*) from vendor_credit_applications where tenant_id = $1 and (bill_id = $2 or credit_id = $2)) as n`,
    [ctx.tenantId, id],
  );
  if (Number(used?.n)) throw badRequest('Payments or credits are applied to this document; remove them first');
  await ctx.tx.query(`update bills set status = 'void', void_reason = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason.slice(0, 500)]);
  await repost(ctx.tx, ctx.tenantId, row.doc_type === 'vendor_credit' ? 'vendor_credit' : 'bill', id);
  return [{ objectKey: 'bill', recordId: id, kind: 'updated', changes: { status: [row.status, 'void'] } }];
}

/** amount_paid from payment allocations; amount_credited from vendor credits; status follows. */
export async function refreshBillPaid(ctx: RecordCtx, id: string) {
  await ctx.tx.query(
    `update bills b set amount_paid = coalesce((select sum(a.amount) from vendor_payment_allocations a join vendor_payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id where a.tenant_id = b.tenant_id and a.bill_id = b.id and p.status = 'paid'), 0),
            amount_credited = case when b.doc_type = 'bill' then coalesce((select sum(amount) from vendor_credit_applications x where x.tenant_id = b.tenant_id and x.bill_id = b.id), 0)
                                   else coalesce((select sum(amount) from vendor_credit_applications x where x.tenant_id = b.tenant_id and x.credit_id = b.id), 0) end
      where b.tenant_id = $1 and b.id = $2`,
    [ctx.tenantId, id],
  );
  await ctx.tx.query(
    `update bills set status = case when balance_due <= 0.009 then 'paid' when amount_paid > 0 or amount_credited > 0 then 'partially_paid' else 'open' end
      where tenant_id = $1 and id = $2 and status in ('open', 'partially_paid', 'paid')`,
    [ctx.tenantId, id],
  );
}

/** Draft bill from a purchase order: what was received and not yet billed (or every line). */
export async function billFromPo(ctx: RecordCtx, poId: string) {
  const { row: po } = await loadRow(ctx, 'purchase_order', poId, 'read');
  if (!['sent', 'partially_received', 'received', 'closed'].includes(String(po.status))) throw badRequest('Send the purchase order first');
  const lines = await ctx.tx.query<Record<string, any>>(
    `select l.*, coalesce((select sum(bl.quantity) from bill_lines bl join bills b on b.tenant_id = bl.tenant_id and b.id = bl.order_id where bl.tenant_id = l.tenant_id and bl.po_line_id = l.id and b.status <> 'void' and b.doc_type = 'bill' and b.deleted_at is null), 0) as billed
       from purchase_order_lines l where l.tenant_id = $1 and l.order_id = $2 order by l.position`,
    [ctx.tenantId, poId],
  );
  const input: BillLineInput[] = [];
  for (const l of lines) {
    const basis = Number(l.received_qty) > 0 ? Number(l.received_qty) : Number(l.quantity);
    const qty = r2(basis - Number(l.billed));
    if (qty <= 0) continue;
    input.push({ productId: l.product_id, poLineId: l.id, name: l.name, description: l.description, hsnSac: l.hsn_sac, unit: l.unit, quantity: qty, unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), taxRate: Number(l.tax_rate) });
  }
  if (!input.length) throw badRequest('Everything on this purchase order is already billed');
  const r = await createRecord(ctx, 'bill', { name: `Bill for ${po.po_number ?? po.name}`, vendor_id: po.vendor_id, purchase_order_id: poId });
  const events = [...r.events, ...(await saveBillLines(ctx, r.record.id, input))];
  return { id: r.record.id, events };
}

/** Draft vendor credit (debit note) against a posted bill. */
export async function vendorCreditFrom(ctx: RecordCtx, billId: string, reason: string) {
  const { row } = await loadRow(ctx, 'bill', billId, 'read');
  if (row.doc_type !== 'bill' || !['open', 'partially_paid', 'paid'].includes(String(row.status))) throw badRequest('Vendor credits can only be raised against posted bills');
  const lines = await billLines(ctx, billId);
  const r = await createRecord(ctx, 'bill', { name: `Vendor credit — ${row.bill_number}`, vendor_id: row.vendor_id, notes: reason, reverse_charge: row.reverse_charge, itc_eligible: row.itc_eligible, place_of_supply: row.place_of_supply });
  await ctx.tx.query(`update bills set doc_type = 'vendor_credit', original_bill_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, billId]);
  const events = [
    ...r.events,
    ...(await saveBillLines(
      ctx,
      r.record.id,
      lines.map((l) => ({ productId: l.product_id, accountId: l.account_id, name: l.name, description: l.description, hsnSac: l.hsn_sac, unit: l.unit, quantity: Number(l.quantity), unitPrice: Number(l.unit_price), discountPct: Number(l.discount_pct), taxRate: Number(l.tax_rate) })),
    )),
  ];
  return { id: r.record.id, events };
}

/** Applies an open vendor credit to the same vendor's open bills. */
export async function applyVendorCredit(ctx: RecordCtx, creditId: string, plan: { billId: string; amount: number }[]): Promise<RecordEvent[]> {
  const { row: c } = await loadRow(ctx, 'bill', creditId, 'update', true);
  if (c.doc_type !== 'vendor_credit' || !['open', 'partially_paid'].includes(String(c.status))) throw badRequest('Only an open vendor credit can be applied');
  let left = r2(Number(c.balance_due));
  for (const p of plan) {
    if (!(p.amount > 0)) throw badRequest('Amounts must be positive');
    if (p.amount > left + 0.009) throw badRequest(`Only ${left} of this credit is left`);
    const b = await ctx.tx.one<{ vendor_id: string; doc_type: string; status: string; balance_due: string }>(`select vendor_id, doc_type, status, balance_due from bills where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, p.billId]);
    if (!b || b.doc_type !== 'bill') throw badRequest('Bill not found');
    if (b.vendor_id !== c.vendor_id) throw badRequest('The bill belongs to another vendor');
    if (!['open', 'partially_paid'].includes(b.status)) throw badRequest('Only open bills take credits');
    if (p.amount > Number(b.balance_due) + 0.009) throw badRequest(`That is more than the bill balance (${Number(b.balance_due)})`);
    await ctx.tx.query(
      `insert into vendor_credit_applications (tenant_id, credit_id, bill_id, amount) values ($1,$2,$3,$4) on conflict (tenant_id, credit_id, bill_id) do update set amount = vendor_credit_applications.amount + excluded.amount`,
      [ctx.tenantId, creditId, p.billId, r2(p.amount)],
    );
    left = r2(left - p.amount);
    await refreshBillPaid(ctx, p.billId);
  }
  await refreshBillPaid(ctx, creditId);
  return [{ objectKey: 'bill', recordId: creditId, kind: 'updated' }];
}

// ------------------------------------------------------------------------------------- vendor payments
export interface VendorPaymentInput {
  vendorId: string;
  amount: number;
  date?: string | null;
  mode?: string | null;
  paidThroughId?: string | null;
  reference?: string | null;
  notes?: string | null;
  currency?: string;
  exchangeRate?: number;
  allocations?: { billId: string; amount: number }[] | 'auto' | null;
}

export async function recordVendorPayment(ctx: RecordCtx, input: VendorPaymentInput) {
  if (input.paidThroughId) {
    const a = await ctx.tx.one<{ subtype: string }>(`select subtype from gl_accounts where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, input.paidThroughId]);
    if (!a || !['bank', 'cash', 'credit_card'].includes(a.subtype)) throw badRequest('Pay from a bank, cash or card account');
  }
  const r = await createRecord(ctx, 'vendor_payment', {
    name: input.reference ? `Payment ${input.reference}` : 'Vendor payment',
    vendor_id: input.vendorId,
    amount: input.amount,
    payment_date: input.date ?? new Date().toISOString().slice(0, 10),
    mode: input.mode ?? 'bank_transfer',
    reference: input.reference ?? null,
    notes: input.notes ?? null,
  });
  const id = r.record.id;
  await ctx.tx.query(`update vendor_payments set name = $3, paid_through_id = $4, currency = $5, exchange_rate = $6 where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, `${r.record.payment_number}${input.reference ? ` · ${input.reference}` : ''}`, input.paidThroughId ?? null, input.currency ?? 'INR', input.exchangeRate ?? 1,
  ]);
  const events = [...r.events];
  if (input.allocations) events.push(...(await allocateVendorPayment(ctx, id, input.allocations, false)));
  await repost(ctx.tx, ctx.tenantId, 'vendor_payment', id);
  return { id, number: r.record.payment_number as string, events };
}

export async function allocateVendorPayment(ctx: RecordCtx, paymentId: string, allocations: { billId: string; amount: number }[] | 'auto', post = true): Promise<RecordEvent[]> {
  const { row: p } = await loadRow(ctx, 'vendor_payment', paymentId, 'update', true);
  if (p.status !== 'paid') throw badRequest('This payment is void');
  let left = r2(Number(p.amount) - Number(p.amount_allocated));
  let plan: { billId: string; amount: number }[] = [];
  if (allocations === 'auto') {
    const open = await ctx.tx.query<{ id: string; balance_due: string }>(
      `select id, balance_due from bills where tenant_id = $1 and vendor_id = $2 and doc_type = 'bill' and status in ('open','partially_paid') and deleted_at is null order by due_date nulls last, bill_date`,
      [ctx.tenantId, p.vendor_id],
    );
    let room = left;
    for (const b of open) {
      if (room <= 0) break;
      const a = r2(Math.min(room, Number(b.balance_due)));
      if (a > 0) (plan.push({ billId: b.id, amount: a }), (room = r2(room - a)));
    }
  } else {
    const merged = new Map<string, number>();
    for (const a of allocations) {
      if (!(a.amount > 0)) throw badRequest('Allocation amounts must be positive');
      merged.set(a.billId, r2((merged.get(a.billId) ?? 0) + a.amount));
    }
    plan = [...merged].map(([billId, amount]) => ({ billId, amount }));
  }
  if (r2(plan.reduce((s, a) => s + a.amount, 0)) > left + 0.009) throw badRequest(`Only ${left} of this payment is left to apply`);
  for (const a of plan) {
    const b = await ctx.tx.one<{ vendor_id: string; doc_type: string; status: string; balance_due: string }>(`select vendor_id, doc_type, status, balance_due from bills where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, a.billId]);
    if (!b || b.doc_type !== 'bill') throw badRequest('Bill not found');
    if (b.vendor_id !== p.vendor_id) throw badRequest('The bill belongs to another vendor');
    if (!['open', 'partially_paid'].includes(b.status)) throw badRequest('Only open bills take payments');
    if (a.amount > Number(b.balance_due) + 0.009) throw badRequest(`That is more than the bill balance (${Number(b.balance_due)})`);
    await ctx.tx.query(
      `insert into vendor_payment_allocations (tenant_id, payment_id, bill_id, amount) values ($1,$2,$3,$4) on conflict (tenant_id, payment_id, bill_id) do update set amount = vendor_payment_allocations.amount + excluded.amount`,
      [ctx.tenantId, paymentId, a.billId, a.amount],
    );
    left = r2(left - a.amount);
    await refreshBillPaid(ctx, a.billId);
  }
  await ctx.tx.query(`update vendor_payments set amount_allocated = (select coalesce(sum(amount), 0) from vendor_payment_allocations where tenant_id = $1 and payment_id = $2) where tenant_id = $1 and id = $2`, [ctx.tenantId, paymentId]);
  if (post && p.currency !== 'INR') await repost(ctx.tx, ctx.tenantId, 'vendor_payment', paymentId);
  return [{ objectKey: 'vendor_payment', recordId: paymentId, kind: 'updated' }];
}

export async function voidVendorPayment(ctx: RecordCtx, id: string, reason: string): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'vendor_payment', id, 'update', true);
  if (row.status === 'void') throw badRequest('Already void');
  const bills = await ctx.tx.query<{ bill_id: string }>(`delete from vendor_payment_allocations where tenant_id = $1 and payment_id = $2 returning bill_id`, [ctx.tenantId, id]);
  await ctx.tx.query(`update vendor_payments set status = 'void', amount_allocated = 0, void_reason = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason.slice(0, 500)]);
  for (const b of bills) await refreshBillPaid(ctx, b.bill_id);
  await repost(ctx.tx, ctx.tenantId, 'vendor_payment', id);
  return [{ objectKey: 'vendor_payment', recordId: id, kind: 'updated', changes: { status: ['paid', 'void'] } }];
}

export async function getVendorPayment(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'vendor_payment', id, 'read');
  const allocations = await ctx.tx.query(
    `select a.bill_id, a.amount::float8 as amount, b.bill_number, b.vendor_ref, b.bill_date, b.grand_total::float8 as grand_total, b.balance_due::float8 as balance_due
       from vendor_payment_allocations a join bills b on b.tenant_id = a.tenant_id and b.id = a.bill_id where a.tenant_id = $1 and a.payment_id = $2`,
    [ctx.tenantId, id],
  );
  const open =
    row.status === 'paid'
      ? await ctx.tx.query(
          `select id, bill_number, vendor_ref, bill_date, due_date, grand_total::float8 as grand_total, balance_due::float8 as balance_due from bills
            where tenant_id = $1 and vendor_id = $2 and doc_type = 'bill' and status in ('open','partially_paid') and deleted_at is null order by due_date nulls last, bill_date`,
          [ctx.tenantId, row.vendor_id],
        )
      : [];
  return { payment: { ...toDto(obj, row, ctx.principal.permissions), paid_through_id: row.paid_through_id ?? null, void_reason: row.void_reason ?? null }, allocations, openBills: open };
}

/** Bills owed, by age. */
export async function payables(ctx: RecordCtx, asOf = new Date().toISOString().slice(0, 10)) {
  const rows = await ctx.tx.query<{ vendor_id: string; vendor: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90: string; total: string }>(
    `select b.vendor_id, v.name as vendor,
            sum(b.balance_due) filter (where coalesce(b.due_date, b.bill_date) >= $2::date) as current,
            sum(b.balance_due) filter (where $2::date - coalesce(b.due_date, b.bill_date) between 1 and 30) as d1_30,
            sum(b.balance_due) filter (where $2::date - coalesce(b.due_date, b.bill_date) between 31 and 60) as d31_60,
            sum(b.balance_due) filter (where $2::date - coalesce(b.due_date, b.bill_date) between 61 and 90) as d61_90,
            sum(b.balance_due) filter (where $2::date - coalesce(b.due_date, b.bill_date) > 90) as d90,
            sum(b.balance_due) as total
       from bills b join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.doc_type = 'bill' and b.status in ('open','partially_paid') and b.deleted_at is null and b.bill_date <= $2::date
      group by b.vendor_id, v.name order by sum(b.balance_due) desc limit 500`,
    [ctx.tenantId, asOf],
  );
  const n = (v: string | null) => Number(v ?? 0);
  return rows.map((r) => ({ vendorId: r.vendor_id, vendor: r.vendor, current: n(r.current), d1_30: n(r.d1_30), d31_60: n(r.d31_60), d61_90: n(r.d61_90), d90: n(r.d90), total: n(r.total) }));
}
