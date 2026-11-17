import { beforeAll, describe, expect, it } from 'vitest';
import { parseInvoiceText, parseSheet, splitInvoices } from '../src/services/books/doc-import';
import { makeHarness } from './harness';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(body14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CH.indexOf(body14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body14 + CH[(36 - (sum % 36)) % 36];
}
const SELLER = gstin('09AASFH6805J1Z');
const BUYER = gstin('09AACCS9012Q1Z');
const DELHI = gstin('07AABCD1234E1Z');

const zoho = (no: string, buyer: string, bg: string, paid: boolean) => `HRP AI LLP
Noida Uttar Pradesh 201301
GSTIN ${SELLER}
TAX INVOICE
# : ${no}
Invoice Date : 12/10/2026
Terms : Due on Receipt
Due Date : 27/10/2026
Place Of Supply : Uttar Pradesh (09)
Bill To
${buyer}
B-12 Sector 62, Noida
Uttar Pradesh 201301
GSTIN ${bg}
Kind Attn: Ravi Sharma
ravi@sharmahomes.in
# Item & Description HSN/SAC Qty Rate CGST % Amt SGST % Amt Amount
1 IoT monitoring subscription 998314 1.00 10,000.00 9% 900.00 9% 900.00 10,000.00
Sub Total 10,000.00
CGST9 (9%) 900.00
SGST9 (9%) 900.00
Total ₹11,800.00
${paid ? 'Payment Made (-) 11,800.00\nBalance Due ₹0.00' : 'Balance Due ₹11,800.00'}
Total In Words Indian Rupee Eleven Thousand Eight Hundred Only`;

const tally = `TAX INVOICE
Invoice No. HRP/26-27/045 Dated 5-Nov-2026
Buyer (Bill to)
Delta Foods Pvt Ltd
Connaught Place, New Delhi
GSTIN/UIN : ${DELHI}
Sl Description of Goods HSN/SAC Quantity Rate Amount
1 Sensor kit 85176290 2 nos 5,000.00 10,000.00
IGST 1,800.00
Total ₹ 11,800.00
Amount Chargeable (in words) INR Eleven Thousand Eight Hundred Only`;

describe('reading invoices', () => {
  it('reads a Zoho invoice: number, date, customer, lines, tax and payment', () => {
    const r = parseInvoiceText(zoho('INV-000012', 'Sharma Homes', BUYER, true), [SELLER]);
    expect(r.data).toMatchObject({
      number: 'INV-000012',
      date: '2026-10-12',
      dueDate: '2026-10-27',
      customer: { name: 'Sharma Homes', gstin: BUYER, state: 'Uttar Pradesh', email: 'ravi@sharmahomes.in', contact: 'Ravi Sharma' },
      taxable: 10000,
      cgst: 900,
      sgst: 900,
      igst: 0,
      total: 11800,
      paid: { status: 'paid', amount: 11800 },
    });
    expect(r.data.lines).toEqual([expect.objectContaining({ description: 'IoT monitoring subscription', hsn: '998314', amount: 10000, taxRate: 18 })]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(parseInvoiceText(zoho('INV-000013', 'X', BUYER, false), [SELLER]).data.paid.status).toBe('unpaid');
  });

  it('reads a Tally invoice with IGST', () => {
    const r = parseInvoiceText(tally, [SELLER]);
    expect(r.data).toMatchObject({ number: 'HRP/26-27/045', date: '2026-11-05', customer: { name: 'Delta Foods Pvt Ltd', gstin: DELHI, state: 'Delhi' }, taxable: 10000, igst: 1800, total: 11800 });
    expect(r.data.lines[0]).toMatchObject({ hsn: '85176290', amount: 10000 });
  });

  it('does not take a word on the next line for the invoice number', () => {
    const t = zoho('INV-000021', 'Sharma Homes', BUYER, true).replace('HRP AI LLP\nNoida', 'HRP AI LLP TAX INVOICE\nNoida');
    expect(parseInvoiceText(t, [SELLER]).data.number).toBe('INV-000021');
  });

  it('splits a file with several invoices by invoice number', () => {
    const segs = splitInvoices([zoho('INV-1', 'A', BUYER, true), 'continued terms page', zoho('INV-2', 'B', BUYER, false)]);
    expect(segs.map((s) => s.pages)).toEqual(['1-2', '3']);
  });

  it('reads a Zoho export with one row per invoice line', () => {
    const rows = [
      ['Invoice Date', 'Invoice Number', 'Invoice Status', 'Customer Name', 'GST Identification Number (GSTIN)', 'Item Name', 'HSN/SAC', 'Quantity', 'Item Price', 'Item Tax %', 'Item Total', 'SubTotal', 'Total', 'Balance'],
      ['2026-09-01', 'INV-000010', 'Paid', 'Sharma Homes', BUYER, 'Install', '998719', 1, 2000, 18, 2000, 5000, 5900, 0],
      ['2026-09-01', 'INV-000010', 'Paid', 'Sharma Homes', BUYER, 'Sensors', '85176290', 3, 1000, 18, 3000, 5000, 5900, 0],
      ['2026-09-15', 'INV-000011', 'Overdue', 'Delta Foods', DELHI, 'Audit', '998311', 1, 1000, 18, 1000, 1000, 1180, 1180],
    ];
    const r = parseSheet(rows, [SELLER]);
    expect(r).toHaveLength(2);
    expect(r[0]!.data).toMatchObject({ number: 'INV-000010', date: '2026-09-01', taxable: 5000, total: 5900, cgst: 450, sgst: 450, paid: { status: 'paid' } });
    expect(r[0]!.data.lines).toHaveLength(2);
    expect(r[1]!.data).toMatchObject({ igst: 180, paid: { status: 'unpaid' }, customer: { state: 'Delhi' } });
  });
});

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const sysAcc: Record<string, string> = {};
const today = new Date().toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

beforeAll(async () => {
  h = await makeHarness('synapse_test_doc_import');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status, a).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: '2026-04-01' })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sysAcc[a.system_key] = a.id;
  ids.bank = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((x) => x.gl_account_id === sysAcc.bank).id;
  // the receipt for INV-000012 is already in the bank
  await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/statement`, { rows: [{ date: '2026-10-20', description: 'NEFT CR-SHARMA HOMES-INV-000012', amount: 11800 }], toDesk: true });
}, 120_000);

describe('importing with approval', () => {
  it('stages every invoice of every file with a plan, and creates nothing before approval', async () => {
    const b = await api('POST', '/api/v1/books/imports', { name: 'Old invoices' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    ids.batch = b.json.id;
    const f1 = await api('POST', `/api/v1/books/imports/${ids.batch}/files`, { fileName: 'zoho-oct.pdf', pages: [zoho('INV-000012', 'Sharma Homes', BUYER, true), zoho('INV-000013', 'Sharma Homes', BUYER, false)] });
    expect(f1.status, JSON.stringify(f1.json)).toBe(200);
    expect(f1.json).toMatchObject({ invoices: 2 });
    const f2 = await api('POST', `/api/v1/books/imports/${ids.batch}/files`, { fileName: 'tally.pdf', pages: [tally] });
    expect(f2.json.invoices).toBe(1);
    const scan = await api('POST', `/api/v1/books/imports/${ids.batch}/files`, { fileName: 'bill.jpg', images: [{ mime: 'image/jpeg', data: 'AAAA' }] });
    expect(scan.json).toMatchObject({ invoices: 0, note: expect.stringMatching(/AI model/) });

    const items = (await api('GET', `/api/v1/books/imports/${ids.batch}`)).json as any[];
    expect(items).toHaveLength(3);
    const i12 = items.find((x) => x.data.number === 'INV-000012');
    expect(i12.plan).toMatchObject({ customer: { new: true, name: 'Sharma Homes' }, contact: { name: 'Ravi Sharma', email: 'ravi@sharmahomes.in' }, payment: { mode: 'bank', bank: { amount: 11800, tds: 0 } } });
    expect(items.find((x) => x.data.number === 'INV-000013').plan.payment.mode).toBe('later');
    expect((await api('GET', '/api/v1/records/account?limit=50')).json.items).toHaveLength(0);
    ids.i12 = i12.id;
    ids.i13 = items.find((x) => x.data.number === 'INV-000013').id;
    ids.tally = items.find((x) => x.data.number === 'HRP/26-27/045').id;
  });

  it('lets the person correct it, then creates the customer, contact, project, invoice and receipt', async () => {
    const items = (await api('GET', `/api/v1/books/imports/${ids.batch}`)).json as any[];
    const i12 = items.find((x) => x.id === ids.i12);
    const edited = { ...i12.data, customer: { ...i12.data.customer, name: 'Sharma Homes Pvt Ltd' } };
    const u = await api('PATCH', `/api/v1/books/imports/items/${ids.i12}`, { data: edited, choices: { newProject: 'Noida IoT rollout' } });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.plan).toMatchObject({ customer: { new: true, name: 'Sharma Homes Pvt Ltd' }, project: { name: 'Noida IoT rollout', new: true } });
    // the Tally one is rejected
    expect((await api('POST', `/api/v1/books/imports/items/${ids.tally}/reject`)).status).toBe(200);

    const a = await api('POST', '/api/v1/books/imports/items/approve', { ids: [ids.i12, ids.i13] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.results.filter((r: any) => !r.ok)).toEqual([]);
    expect(a.json.approved).toBe(2);
    const accounts = (await api('GET', '/api/v1/records/account?limit=50')).json.items as any[];
    // INV-000013's customer was found by GSTIN: one customer, not two
    expect(accounts.map((x) => x.name)).toEqual(['Sharma Homes Pvt Ltd']);
    const invs = (await api('GET', '/api/v1/records/invoice?limit=50')).json.items as any[];
    const inv12 = invs.find((x) => x.invoice_number === 'INV-000012');
    const inv13 = invs.find((x) => x.invoice_number === 'INV-000013');
    expect(inv12).toMatchObject({ status: 'paid', invoice_date: expect.stringMatching(/^2026-10-12/) });
    expect(inv13.status).toBe('issued');
    const full = (await api('GET', `/api/v1/invoices/${inv12.id}`)).json;
    expect(full.invoice ?? full).toMatchObject({ imported: true, import_source: 'zoho-oct.pdf', grand_total: 11800 });
    const txn = ((await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/transactions?status=all`)).json as any[])[0];
    expect(txn.status).toBe('matched');
    expect((await api('GET', '/api/v1/records/contact?limit=50')).json.items.map((x: any) => x.email)).toEqual(['ravi@sharmahomes.in']);
    // the same invoice can't come in twice
    const again = await api('POST', `/api/v1/books/imports/${ids.batch}/files`, { fileName: 'zoho-oct.pdf', pages: [zoho('INV-000012', 'Sharma Homes', BUYER, true)] });
    const dupId = again.json.ids[0];
    const dup = ((await api('GET', `/api/v1/books/imports/${ids.batch}`)).json as any[]).find((x) => x.id === dupId);
    expect(dup.plan.invoice.duplicate).toBe(true);
    const tb = await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`);
    expect(tb.json.totals.balanced).toBe(true);
    void fyStart;
  });

});
