/**
 * A project's billing — the accounts module's billing, for one project: its invoices (booked to it or
 * raised for its milestones), the receipts against them (with the TDS and GST TDS the customer kept),
 * vendor bills booked to it (whole bills or their lines) and what was paid on them, the GST in and
 * out, and the bank lines the accounts desk matched to its invoices and bills — applied by itself when
 * sure (the desk's autonomy setting), else waiting for a person. Everything here is the same invoice,
 * payment, bill and vendor payment as in Billing and Books: nothing is copied.
 */
import { hasAdmin } from '@synapse/shared';
import { badRequest } from '../lib/errors';
import { PROJECT_INVOICES, projectAccess } from './projects';
import type { RecordCtx } from './records';

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function projectBilling(ctx: RecordCtx, projectId: string) {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

  const invoices = await ctx.tx.query<Record<string, any>>(
    `select i.id, i.invoice_number, i.doc_type, i.status, i.invoice_date::text as invoice_date, i.due_date::text as due_date, i.account_id, a.name as customer,
            i.taxable_total::float8 as taxable, i.cgst_total::float8 as cgst, i.sgst_total::float8 as sgst, i.igst_total::float8 as igst, i.tax_total::float8 as tax,
            i.grand_total::float8 as total, i.amount_paid::float8 as paid, i.balance_due::float8 as balance, i.exchange_rate::float8 as fx, i.currency, i.irn is not null as e_invoiced,
            (select m.name from project_milestones m where m.tenant_id = i.tenant_id and (m.invoice_id = i.id or m.id = i.milestone_id) limit 1) as milestone
       from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and ${PROJECT_INVOICES} and i.deleted_at is null
      order by i.invoice_date desc nulls first, i.created_at desc limit 500`,
    [ctx.tenantId, projectId],
  );
  const invIds = invoices.map((i) => i.id as string);

  const receipts = invIds.length
    ? await ctx.tx.query<Record<string, any>>(
        `select p.id, p.payment_number, p.payment_date::text as date, p.mode, p.reference, p.status, p.amount::float8 as amount,
                coalesce(p.tds_amount, 0)::float8 as tds, coalesce(p.gst_tds_amount, 0)::float8 as gst_tds,
                sum(pa.amount)::float8 as to_project, string_agg(coalesce(i.invoice_number, 'draft'), ', ' order by i.invoice_number) as invoices,
                exists (select 1 from acct_proposals ap where ap.tenant_id = p.tenant_id and ap.status = 'applied' and ap.result ->> 'paymentId' = p.id::text) as from_bank
           from payment_allocations pa join payments p on p.tenant_id = pa.tenant_id and p.id = pa.payment_id join invoices i on i.tenant_id = pa.tenant_id and i.id = pa.invoice_id
          where pa.tenant_id = $1 and pa.invoice_id = any($2::uuid[]) and p.deleted_at is null
          group by p.id order by p.payment_date desc limit 500`,
        [ctx.tenantId, invIds],
      )
    : [];

  // bills: the whole bill when booked to the project, else only its lines that are
  const bills = await ctx.tx.query<Record<string, any>>(
    `select b.id, coalesce(b.bill_number, b.vendor_ref) as number, b.doc_type, b.status, b.bill_date::text as date, b.due_date::text as due_date, v.name as vendor, b.vendor_id,
            b.itc_eligible, b.reverse_charge, b.grand_total::float8 as total, b.amount_paid::float8 as paid, b.balance_due::float8 as balance, coalesce(b.tds_amount, 0)::float8 as tds,
            b.project_id = $2 as whole,
            case when b.project_id = $2 then b.taxable_total else (select sum(l.line_subtotal) from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id = $2) end::float8 as taxable,
            case when b.project_id = $2 then b.cgst_total else (select sum(l.line_cgst) from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id = $2) end::float8 as cgst,
            case when b.project_id = $2 then b.sgst_total else (select sum(l.line_sgst) from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id = $2) end::float8 as sgst,
            case when b.project_id = $2 then b.igst_total else (select sum(l.line_igst) from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id = $2) end::float8 as igst
       from bills b left join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.deleted_at is null
        and (b.project_id = $2 or exists (select 1 from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id = $2))
      order by b.bill_date desc nulls first, b.created_at desc limit 500`,
    [ctx.tenantId, projectId],
  );
  const billIds = bills.map((b) => b.id as string);
  const paymentsOut = billIds.length
    ? await ctx.tx.query<Record<string, any>>(
        `select p.id, p.payment_number, p.payment_date::text as date, p.mode, p.reference, p.status, p.amount::float8 as amount, v.name as vendor,
                sum(pa.amount)::float8 as to_project, string_agg(coalesce(b.bill_number, b.vendor_ref, 'bill'), ', ') as bills,
                exists (select 1 from acct_proposals ap where ap.tenant_id = p.tenant_id and ap.status = 'applied' and ap.result ->> 'paymentId' = p.id::text) as from_bank
           from vendor_payment_allocations pa join vendor_payments p on p.tenant_id = pa.tenant_id and p.id = pa.payment_id join bills b on b.tenant_id = pa.tenant_id and b.id = pa.bill_id
           left join vendors v on v.tenant_id = p.tenant_id and v.id = p.vendor_id
          where pa.tenant_id = $1 and pa.bill_id = any($2::uuid[]) and p.deleted_at is null
          group by p.id, v.name order by p.payment_date desc limit 500`,
        [ctx.tenantId, billIds],
      )
    : [];

  // bank lines the accounts desk tied to these invoices and bills
  const bank =
    invIds.length || billIds.length
      ? await ctx.tx.query<Record<string, any>>(
          `select ap.id, ap.kind, ap.title, ap.reason, ap.status, ap.applied_by, ap.confidence::float8 as confidence, ap.payload, ap.decided_at, ap.created_at,
                  t.id as txn_id, t.txn_date::text as txn_date, t.description, t.reference, t.amount::float8 as amount, ga.name as bank_account
             from acct_proposals ap join bank_transactions t on t.tenant_id = ap.tenant_id and t.id = ap.bank_txn_id
             join bank_accounts ba on ba.tenant_id = t.tenant_id and ba.id = t.bank_account_id join gl_accounts ga on ga.tenant_id = ba.tenant_id and ga.id = ba.gl_account_id
            where ap.tenant_id = $1 and ap.status in ('pending','applied') and ap.kind in ('receipt','vendor_payment')
              and ((ap.payload ->> 'invoiceId') = any($2::text[]) or (ap.payload ->> 'billId') = any($3::text[]))
            order by (ap.status = 'pending') desc, t.txn_date desc limit 200`,
          [ctx.tenantId, invIds, billIds],
        )
      : [];

  /* ── totals (in rupees: foreign-currency invoices at their rate) ── */
  const live = invoices.filter((i) => !['draft', 'cancelled', 'void'].includes(String(i.status)));
  const sign = (i: Record<string, any>) => (i.doc_type === 'credit_note' ? -1 : 1) * Number(i.fx ?? 1);
  const sum = (xs: Record<string, any>[], k: string, f: (x: Record<string, any>) => number = () => 1) => r2(xs.reduce((a, x) => a + Number(x[k] ?? 0) * f(x), 0));
  const tax = live.filter((i) => i.doc_type !== 'credit_note');
  const sales = {
    invoices: live.length,
    drafts: invoices.filter((i) => i.status === 'draft').length,
    taxable: sum(live, 'taxable', sign),
    cgst: sum(live, 'cgst', sign),
    sgst: sum(live, 'sgst', sign),
    igst: sum(live, 'igst', sign),
    total: sum(live, 'total', sign),
    received: sum(tax, 'paid', sign),
    outstanding: sum(tax, 'balance', sign),
    overdue: sum(tax.filter((i) => i.due_date && i.due_date < today && Number(i.balance) > 0.5), 'balance', sign),
    // what the customer deducted, in proportion to what each receipt paid of this project's invoices
    // (a receipt's amount is what it settles; the TDS and GST TDS kept are part of it)
    tds: r2(receipts.reduce((a, p) => a + (Number(p.amount) > 0 ? (Number(p.tds) * Number(p.to_project)) / Number(p.amount) : 0), 0)),
    gstTds: r2(receipts.reduce((a, p) => a + (Number(p.amount) > 0 ? (Number(p.gst_tds) * Number(p.to_project)) / Number(p.amount) : 0), 0)),
  };
  const posted = bills.filter((b) => !['draft', 'void', 'cancelled'].includes(String(b.status)));
  const bs = (b: Record<string, any>) => (b.doc_type === 'debit_note' ? -1 : 1);
  const itc = posted.filter((b) => b.itc_eligible !== false);
  const purchases = {
    bills: posted.length,
    drafts: bills.filter((b) => b.status === 'draft').length,
    taxable: sum(posted, 'taxable', bs),
    gst: r2(sum(posted, 'cgst', bs) + sum(posted, 'sgst', bs) + sum(posted, 'igst', bs)),
    itc: r2(sum(itc, 'cgst', bs) + sum(itc, 'sgst', bs) + sum(itc, 'igst', bs)),
    paid: sum(posted.filter((b) => b.whole), 'paid', bs),
    payable: sum(posted.filter((b) => b.whole), 'balance', bs),
    tds: sum(posted.filter((b) => b.whole), 'tds', bs),
  };
  const outputGst = r2(sales.cgst + sales.sgst + sales.igst);
  const gst = { output: outputGst, input: purchases.itc, gstTdsCredit: sales.gstTds, net: r2(outputGst - purchases.itc - sales.gstTds) };

  let desk: { enabled: boolean; autonomy: string; booksOn: boolean; canDecide: boolean } = { enabled: false, autonomy: 'suggest', booksOn: false, canDecide: false };
  const booksOn = await ctx.tx.one<{ enabled: boolean }>(`select enabled from books_config where tenant_id = $1`, [ctx.tenantId]);
  const booksAdmin = hasAdmin(ctx.principal.permissions, 'books') || !!ctx.principal.user.isOwner;
  if (booksOn?.enabled && booksAdmin) {
    const { getSettings } = await import('./books/desk');
    const s = await getSettings(ctx);
    desk = { enabled: s.enabled, autonomy: s.autonomy, booksOn: true, canDecide: true };
  }

  if (booksOn?.enabled && !booksAdmin) desk = { ...desk, booksOn: true };
  return {
    project: { id: project.id, name: project.name, accountId: project.account_id ?? null, billingMethod: project.billing_method ?? null, currency: project.currency ?? 'INR' },
    sales,
    purchases,
    gst,
    invoices,
    receipts,
    bills,
    paymentsOut,
    bank: bank.map((b) => ({ ...b, ref: b.payload?.invoiceNumber ?? b.payload?.billNumber ?? null })),
    desk,
    today,
  };
}

/** A new draft invoice or bill booked to the project (filled in on its own page). */
export async function newDocument(ctx: RecordCtx, projectId: string, kind: 'invoice' | 'bill', vendorId?: string | null) {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  const { createRecord } = await import('./records');
  if (kind === 'invoice') {
    if (!project.account_id) throw badRequest('Set the project’s customer first (Edit details)');
    const r = await createRecord(ctx, 'invoice', { name: `${project.name} — invoice`, account_id: project.account_id });
    await ctx.tx.query(`update invoices set project_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, projectId]);
    return { object: 'invoice', id: String(r.record.id) };
  }
  if (!vendorId) throw badRequest('Choose the vendor of the bill');
  const r = await createRecord(ctx, 'bill', { name: `${project.name} — bill`, vendor_id: vendorId });
  // booked to the project (its lines can also be put on other projects)
  await ctx.tx.query(`update bills set project_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, projectId]);
  return { object: 'bill', id: String(r.record.id) };
}
