/**
 * GST exports generated from issued invoices:
 *  - e-invoice JSON (IRP schema 1.1) for upload to the Invoice Registration Portal / a GSP
 *  - GSTR-1 sections (B2B, B2CS, CDNR, HSN summary) as CSV for the GST offline tool
 *  - Tally XML (sales vouchers + receipts) for import into Tally Prime / ERP 9
 * Every export needs the billing admin area (accounts), and every call is audited.
 */
import { stateCode } from '@synapse/shared';
import { badRequest, notFound } from '../lib/errors';
import { billingSettings, invoiceLines } from './billing';
import { letterhead } from './quotes';
import type { RecordCtx } from './records';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const dmy = (d: unknown) => {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
};
const ymd = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** GST unit quantity codes for the commonest units; anything else is OTH. */
const UQC: Record<string, string> = { nos: 'NOS', no: 'NOS', pcs: 'PCS', pc: 'PCS', set: 'SET', sets: 'SET', kg: 'KGS', kgs: 'KGS', mtr: 'MTR', m: 'MTR', sqft: 'SQF', 'sq.ft': 'SQF', sqm: 'SQM', box: 'BOX', ltr: 'LTR', l: 'LTR', lot: 'OTH', hrs: 'OTH', hours: 'OTH' };
const uqc = (u: string | null) => UQC[(u ?? '').toLowerCase().replace(/\s+/g, '')] ?? 'OTH';

async function audit(ctx: RecordCtx, what: string, details: Record<string, unknown>) {
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'export', $2, $3)`, [ctx.tenantId, what, JSON.stringify(details)]);
}

// ---------------------------------------------------------------------------------- e-invoice
export async function eInvoiceJson(ctx: RecordCtx, id: string) {
  const inv = await ctx.tx.one<Record<string, any>>(`select * from invoices where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!inv) throw notFound();
  if (inv.status === 'draft' || inv.status === 'cancelled') throw badRequest('Only issued invoices can be registered');
  if (!inv.seller_gstin) throw badRequest('Add your company GSTIN in Settings → Sales setup');
  if (!inv.buyer_gstin) throw badRequest('E-invoices are for registered (B2B) customers; this customer has no GSTIN');
  const company = await letterhead(ctx);
  const lines = await invoiceLines(ctx, id);
  const sellerPin = /\b\d{6}\b/.exec(company.address ?? '')?.[0];
  const out = {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: inv.supply_type === 'export' ? 'EXPWOP' : 'B2B', RegRev: inv.reverse_charge ? 'Y' : 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: inv.doc_type === 'credit_note' ? 'CRN' : 'INV', No: inv.invoice_number, Dt: dmy(inv.invoice_date) },
    SellerDtls: { Gstin: inv.seller_gstin, LglNm: company.name, Addr1: (company.address || company.name).slice(0, 100), Loc: (inv.seller_state ?? '').slice(0, 50) || 'NA', Pin: Number(sellerPin ?? 0) || undefined, Stcd: stateCode(inv.seller_gstin) },
    BuyerDtls: {
      Gstin: inv.buyer_gstin,
      LglNm: inv.buyer_name,
      Pos: inv.pos_code ?? stateCode(inv.buyer_gstin),
      Addr1: (inv.buyer_address || inv.buyer_name || 'NA').slice(0, 100),
      Loc: (inv.buyer_state ?? 'NA').slice(0, 50),
      Pin: Number(inv.buyer_pincode ?? 0) || undefined,
      Stcd: stateCode(inv.buyer_gstin),
    },
    ItemList: lines.map((l, i) => ({
      SlNo: String(i + 1),
      PrdDesc: l.name.slice(0, 300),
      IsServc: l.isService ? 'Y' : 'N',
      HsnCd: l.hsnSac ?? '',
      Qty: l.quantity,
      Unit: uqc(l.unit),
      UnitPrice: l.unitPrice,
      TotAmt: r2(l.quantity * l.unitPrice),
      Discount: r2(l.quantity * l.unitPrice - l.lineSubtotal),
      AssAmt: l.lineSubtotal,
      GstRt: l.taxRate,
      IgstAmt: l.igst,
      CgstAmt: l.cgst,
      SgstAmt: l.sgst,
      TotItemVal: l.lineTotal,
    })),
    ValDtls: {
      AssVal: Number(inv.taxable_total),
      CgstVal: Number(inv.cgst_total),
      SgstVal: Number(inv.sgst_total),
      IgstVal: Number(inv.igst_total),
      RndOffAmt: Number(inv.round_off),
      TotInvVal: Number(inv.grand_total),
    },
  };
  const missing = out.ItemList.filter((x) => !x.HsnCd).map((x) => x.PrdDesc);
  await audit(ctx, 'einvoice', { invoice: inv.invoice_number });
  return { json: out, warnings: missing.length ? [`HSN/SAC missing on: ${missing.join(', ')}`] : [] };
}

/** Records the IRN / acknowledgement returned by the IRP (or a GSP) on the invoice. */
export async function saveIrn(ctx: RecordCtx, id: string, irn: string, ackNo: string | null, ackDate: string | null) {
  const r = await ctx.tx.one(`update invoices set irn = $3, ack_no = $4, ack_date = $5 where tenant_id = $1 and id = $2 and status <> 'draft' returning id`, [ctx.tenantId, id, irn, ackNo, ackDate]);
  if (!r) throw notFound();
  return { ok: true };
}

// ---------------------------------------------------------------------------------- GSTR-1
const csv = (rows: (string | number | null | undefined)[][]) =>
  rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\r\n');

export async function gstr1(ctx: RecordCtx, month: string, section: 'b2b' | 'b2cs' | 'cdnr' | 'hsn' | 'summary') {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Month must be YYYY-MM');
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
  const base = `i.tenant_id = $1 and i.invoice_date >= $2::date and i.invoice_date < $3::date and i.status <> 'draft' and i.status <> 'cancelled' and i.deleted_at is null`;
  const vals = [ctx.tenantId, from, to];
  await audit(ctx, 'gstr1', { month, section });
  const posLabel = (code: string | null, name: string | null) => (code ? `${code}-${name ?? ''}` : '');

  if (section === 'b2b' || section === 'cdnr') {
    const rows = await ctx.tx.query<Record<string, any>>(
      `select i.*, l.tax_rate::float8 as rate, sum(l.line_subtotal)::float8 as taxable
         from invoices i join invoice_lines l on l.tenant_id = i.tenant_id and l.order_id = i.id
        where ${base} and i.buyer_gstin is not null and i.doc_type = $4
        group by i.id, l.tax_rate order by i.invoice_date, i.invoice_number`,
      [...vals, section === 'b2b' ? 'tax_invoice' : 'credit_note'],
    );
    const head =
      section === 'b2b'
        ? ['GSTIN/UIN of Recipient', 'Receiver Name', 'Invoice Number', 'Invoice date', 'Invoice Value', 'Place Of Supply', 'Reverse Charge', 'Applicable % of Tax Rate', 'Invoice Type', 'E-Commerce GSTIN', 'Rate', 'Taxable Value', 'Cess Amount']
        : ['GSTIN/UIN of Recipient', 'Receiver Name', 'Note Number', 'Note Date', 'Note Type', 'Place Of Supply', 'Reverse Charge', 'Note Supply Type', 'Note Value', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount'];
    const body = rows.map((r) =>
      section === 'b2b'
        ? [r.buyer_gstin, r.buyer_name, r.invoice_number, dmy(r.invoice_date), Number(r.grand_total), posLabel(r.pos_code, r.place_of_supply), r.reverse_charge ? 'Y' : 'N', '', 'Regular B2B', '', r.rate, r2(r.taxable), 0]
        : [r.buyer_gstin, r.buyer_name, r.invoice_number, dmy(r.invoice_date), 'C', posLabel(r.pos_code, r.place_of_supply), r.reverse_charge ? 'Y' : 'N', 'Regular B2B', Number(r.grand_total), '', r.rate, r2(r.taxable), 0],
    );
    return { filename: `GSTR1-${section}-${month}.csv`, content: csv([head, ...body]), count: body.length };
  }
  if (section === 'b2cs') {
    const rows = await ctx.tx.query<{ pos_code: string | null; place_of_supply: string | null; rate: number; taxable: number; supply_type: string }>(
      `select i.pos_code, max(i.place_of_supply) as place_of_supply, i.supply_type, l.tax_rate::float8 as rate,
              sum(case when i.doc_type = 'credit_note' then -l.line_subtotal else l.line_subtotal end)::float8 as taxable
         from invoices i join invoice_lines l on l.tenant_id = i.tenant_id and l.order_id = i.id
        where ${base} and i.buyer_gstin is null and i.doc_type in ('tax_invoice', 'credit_note')
        group by i.pos_code, i.supply_type, l.tax_rate order by i.pos_code, l.tax_rate`,
      vals,
    );
    const body = rows.map((r) => ['OE', posLabel(r.pos_code, r.place_of_supply), '', r.rate, r2(r.taxable), 0, '']);
    return { filename: `GSTR1-b2cs-${month}.csv`, content: csv([['Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN'], ...body]), count: body.length };
  }
  if (section === 'hsn') {
    const rows = await ctx.tx.query<Record<string, any>>(
      `select coalesce(l.hsn_sac, '') as hsn, max(l.name) as description, max(l.unit) as unit, l.tax_rate::float8 as rate,
              sum(sgn * l.quantity)::float8 as qty, sum(sgn * l.line_total)::float8 as total, sum(sgn * l.line_subtotal)::float8 as taxable,
              sum(sgn * l.line_igst)::float8 as igst, sum(sgn * l.line_cgst)::float8 as cgst, sum(sgn * l.line_sgst)::float8 as sgst
         from invoices i join invoice_lines l on l.tenant_id = i.tenant_id and l.order_id = i.id
         cross join lateral (select case when i.doc_type = 'credit_note' then -1 else 1 end as sgn) s
        where ${base} and i.doc_type in ('tax_invoice', 'credit_note')
        group by coalesce(l.hsn_sac, ''), l.tax_rate order by 1`,
      vals,
    );
    const body = rows.map((r) => [r.hsn, r.description, `${uqc(r.unit)}-${uqc(r.unit) === 'NOS' ? 'NUMBERS' : 'OTHERS'}`, r2(r.qty), r2(r.total), r.rate, r2(r.taxable), r2(r.igst), r2(r.cgst), r2(r.sgst), 0]);
    return { filename: `GSTR1-hsn-${month}.csv`, content: csv([['HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value', 'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount'], ...body]), count: body.length };
  }
  // summary (for the screen)
  const s = await ctx.tx.one<Record<string, any>>(
    `select count(*) filter (where i.doc_type = 'tax_invoice')::int as invoices,
            count(*) filter (where i.doc_type = 'credit_note')::int as credit_notes,
            count(*) filter (where i.doc_type = 'tax_invoice' and i.buyer_gstin is not null)::int as b2b,
            count(*) filter (where i.doc_type = 'tax_invoice' and i.buyer_gstin is null)::int as b2c,
            coalesce(sum(case when i.doc_type = 'credit_note' then -i.taxable_total else i.taxable_total end) filter (where i.doc_type <> 'proforma'), 0)::float8 as taxable,
            coalesce(sum(case when i.doc_type = 'credit_note' then -i.cgst_total else i.cgst_total end) filter (where i.doc_type <> 'proforma'), 0)::float8 as cgst,
            coalesce(sum(case when i.doc_type = 'credit_note' then -i.sgst_total else i.sgst_total end) filter (where i.doc_type <> 'proforma'), 0)::float8 as sgst,
            coalesce(sum(case when i.doc_type = 'credit_note' then -i.igst_total else i.igst_total end) filter (where i.doc_type <> 'proforma'), 0)::float8 as igst
       from invoices i where ${base}`,
    vals,
  );
  return { month, ...s };
}

// ---------------------------------------------------------------------------------- Tally
export const x = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const amt = (n: number) => r2(n).toFixed(2);
export type TallyLedgers = {
  sales: string; cgst: string; sgst: string; igst: string; roundOff: string; bank: string;
  /** deductions on receipts (income-tax TDS, GST TDS, liquidated damages, retention, bank charges) */
  tds: string; gstTds: string; ld: string; retention: string; bankCharges: string;
};

const entry = (ledger: string, amount: number, debit: boolean, bills?: { name: string; type: 'New Ref' | 'Agst Ref'; amount: number }[]) =>
  `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${x(ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amt(debit ? -amount : amount)}</AMOUNT>` +
  (bills ?? []).map((b) => `<BILLALLOCATIONS.LIST><NAME>${x(b.name)}</NAME><BILLTYPE>${b.type}</BILLTYPE><AMOUNT>${amt(debit ? -b.amount : b.amount)}</AMOUNT></BILLALLOCATIONS.LIST>`).join('') +
  `</ALLLEDGERENTRIES.LIST>`;

/** A sales invoice or credit note as an accounting voucher; the party entry carries the bill reference. */
export function salesVoucherXml(L: TallyLedgers, i: Record<string, any>, opts: { remoteId?: string; billWise?: boolean; action?: 'Create' | 'Alter' } = {}) {
  const credit = i.doc_type === 'credit_note';
  const total = Number(i.grand_total);
  // sales: party debit / sales + taxes credit; credit notes are the mirror image
  const lines = [
    entry(i.buyer_name, total, !credit, opts.billWise ? [{ name: String(credit ? (i.original_invoice_number ?? i.invoice_number) : i.invoice_number), type: credit ? 'Agst Ref' : 'New Ref', amount: total }] : undefined),
    entry(L.sales, Number(i.taxable_total), credit),
    ...(Number(i.cgst_total) ? [entry(L.cgst, Number(i.cgst_total), credit)] : []),
    ...(Number(i.sgst_total) ? [entry(L.sgst, Number(i.sgst_total), credit)] : []),
    ...(Number(i.igst_total) ? [entry(L.igst, Number(i.igst_total), credit)] : []),
    ...(Number(i.round_off) ? [entry(L.roundOff, Math.abs(Number(i.round_off)), credit ? Number(i.round_off) > 0 : Number(i.round_off) < 0)] : []),
  ];
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER${opts.remoteId ? ` REMOTEID="${x(opts.remoteId)}"` : ''} VCHTYPE="${credit ? 'Credit Note' : 'Sales'}" ACTION="${opts.action ?? 'Create'}" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${ymd(i.invoice_date).replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${credit ? 'Credit Note' : 'Sales'}</VOUCHERTYPENAME><VOUCHERNUMBER>${x(i.invoice_number)}</VOUCHERNUMBER>` +
    `<PARTYLEDGERNAME>${x(i.buyer_name)}</PARTYLEDGERNAME><PARTYGSTIN>${x(i.buyer_gstin ?? '')}</PARTYGSTIN><PLACEOFSUPPLY>${x(i.place_of_supply ?? '')}</PLACEOFSUPPLY>` +
    `<NARRATION>${x(i.name)}</NARRATION>${lines.join('')}</VOUCHER></TALLYMESSAGE>`
  );
}

/** A receipt; with bill-wise details it settles the invoices it was allocated to. */
export function receiptVoucherXml(L: TallyLedgers, p: Record<string, any>, party: string, bills: { name: string; amount: number }[] = [], remoteId?: string, action: 'Create' | 'Alter' = 'Create') {
  const amount = Number(p.amount);
  const allocated = bills.reduce((a, b) => a + b.amount, 0);
  const refs: { name: string; type: 'New Ref' | 'Agst Ref'; amount: number }[] = bills.map((b) => ({ name: b.name, type: 'Agst Ref', amount: b.amount }));
  // anything not allocated to an invoice stays as an advance (on account) in Tally
  if (bills.length && amount - allocated > 0.009) refs.push({ name: `${p.payment_number} advance`, type: 'New Ref', amount: r2(amount - allocated) });
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER${remoteId ? ` REMOTEID="${x(remoteId)}"` : ''} VCHTYPE="Receipt" ACTION="${action}" OBJVIEW="Accounting Voucher View">` +
    `<DATE>${ymd(p.payment_date).replace(/-/g, '')}</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><VOUCHERNUMBER>${x(p.payment_number)}</VOUCHERNUMBER>` +
    `<PARTYLEDGERNAME>${x(party)}</PARTYLEDGERNAME><NARRATION>${x([p.mode, p.reference].filter(Boolean).join(' '))}</NARRATION>` +
    deductionEntries(L, p, amount) +
    entry(party, amount, false, refs.length ? refs : undefined) +
    `</VOUCHER></TALLYMESSAGE>`
  );
}

/** The bank gets the net; each deduction the customer made goes to its own ledger. */
function deductionEntries(L: TallyLedgers, p: Record<string, any>, amount: number) {
  const d: [string, number][] = [
    [L.tds, Number(p.tds_amount ?? 0)],
    [L.gstTds, Number(p.gst_tds_amount ?? 0)],
    [L.ld, Number(p.ld_amount ?? 0)],
    [L.retention, Number(p.retention_amount ?? 0)],
    [L.bankCharges, Number(p.bank_charges ?? 0)],
  ];
  const net = r2(amount - d.reduce((s, [, v]) => s + v, 0));
  return entry(L.bank, net, true) + d.filter(([, v]) => v > 0).map(([l, v]) => entry(l, v, true)).join('');
}

/** A customer ledger under Sundry Debtors, with GST registration and address. */
export function ledgerXml(l: { name: string; gstin?: string | null; state?: string | null; address?: string | null; pincode?: string | null; parent?: string }, action: 'Create' | 'Alter' = 'Create') {
  return (
    `<TALLYMESSAGE xmlns:UDF="TallyUDF"><LEDGER NAME="${x(l.name)}" ACTION="${action}"><NAME.LIST><NAME>${x(l.name)}</NAME></NAME.LIST><PARENT>${x(l.parent ?? 'Sundry Debtors')}</PARENT>` +
    `<ISBILLWISEON>Yes</ISBILLWISEON><AFFECTSSTOCK>No</AFFECTSSTOCK>` +
    `<GSTREGISTRATIONTYPE>${l.gstin ? 'Regular' : 'Unregistered/Consumer'}</GSTREGISTRATIONTYPE>${l.gstin ? `<PARTYGSTIN>${x(l.gstin)}</PARTYGSTIN>` : ''}` +
    `${l.state ? `<LEDSTATENAME>${x(l.state)}</LEDSTATENAME><STATENAME>${x(l.state)}</STATENAME>` : ''}<COUNTRYNAME>India</COUNTRYNAME>` +
    `${l.address ? `<ADDRESS.LIST>${String(l.address).split(/\n|, /).slice(0, 4).map((a) => `<ADDRESS>${x(a.trim())}</ADDRESS>`).join('')}</ADDRESS.LIST>` : ''}${l.pincode ? `<PINCODE>${x(l.pincode)}</PINCODE>` : ''}` +
    `</LEDGER></TALLYMESSAGE>`
  );
}

export function tallyEnvelope(company: string, messages: string[]) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
    `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${x(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${messages.join('\n')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`
  );
}

export async function tallyXml(ctx: RecordCtx, from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw badRequest('Dates must be YYYY-MM-DD');
  const s = await billingSettings(ctx);
  const L = s.ledgers;
  const invs = await ctx.tx.query<Record<string, any>>(
    `select * from invoices where tenant_id = $1 and invoice_date between $2::date and $3::date and status <> 'draft' and status <> 'cancelled' and doc_type <> 'proforma' and deleted_at is null order by invoice_date, invoice_number`,
    [ctx.tenantId, from, to],
  );
  const pays = await ctx.tx.query<Record<string, any>>(
    `select p.*, a.name as account_name from payments p left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where p.tenant_id = $1 and p.payment_date between $2::date and $3::date and p.status = 'received' and p.deleted_at is null order by p.payment_date, p.payment_number`,
    [ctx.tenantId, from, to],
  );
  const vouchers: string[] = [];
  for (const i of invs) vouchers.push(salesVoucherXml(L, i));
  for (const p of pays) vouchers.push(receiptVoucherXml(L, p, p.account_name));
  const company = await letterhead(ctx);
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>` +
    `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${x(company.name)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>` +
    `<REQUESTDATA>${vouchers.join('\n')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  await audit(ctx, 'tally', { from, to, invoices: invs.length, payments: pays.length });
  return { filename: `tally-${from}-to-${to}.xml`, content: xml, invoices: invs.length, payments: pays.length };
}
