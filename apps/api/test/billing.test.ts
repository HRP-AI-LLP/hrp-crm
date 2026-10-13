import { financialYear, splitTax, stateCode, validGstin } from '@synapse/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { sweepTenant } from '../src/services/reminders';
import { type Json, makeHarness, PW } from './harness';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Appends the GSTN check character to a 14-character GSTIN body. */
function gstin(body14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CH.indexOf(body14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body14 + CH[(36 - (sum % 36)) % 36];
}
const SELLER = gstin('27AAACH1234M1Z'); // Maharashtra
const BUYER_MH = gstin('27AABCK5678P1Z');
const BUYER_KA = gstin('29AACCS9012Q1Z');

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let acct: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let tenantId = '';

beforeAll(async () => {
  h = await makeHarness('synapse_test_billing');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  for (const a of ['orders', 'billing']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Elvm Craft LLP', state: 'Maharashtra', gstin: SELLER, address: 'Plot 4, Andheri East, Mumbai 400069' } } });
  const u = await api('POST', '/api/admin/users', { email: 'acc@acme.test', fullName: 'Anil Accounts', password: PW, roles: ['accounts'] });
  expect(u.status, JSON.stringify(u.json)).toBe(201);
  acct = h.as('acme', (await h.login('acme', 'acc@acme.test')).token);
  await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  ids.mh = (await api('POST', '/api/v1/records/account', { name: 'Kapoor Interiors', gstin: BUYER_MH, state: 'Maharashtra', address: 'Bandra West', city: 'Mumbai', pincode: '400050' })).json.id;
  ids.ka = (await api('POST', '/api/v1/records/account', { name: 'Sharma Homes', gstin: BUYER_KA, state: 'Karnataka', city: 'Bengaluru' })).json.id;
  ids.b2c = (await api('POST', '/api/v1/records/account', { name: 'Walk-in Customer', state: 'Maharashtra' })).json.id;
  ids.sofa = (await api('POST', '/api/v1/records/product', { name: 'Sofa', hsn_sac: '9401', tax_rate: 18, list_price: 50000, unit: 'Nos' })).json.id;
  ids.fit = (await api('POST', '/api/v1/records/product', { name: 'Fitting service', hsn_sac: '995479', tax_rate: 18, list_price: 5000, product_type: 'service' })).json.id;
}, 90_000);

describe('GST helpers', () => {
  it('validate GSTINs, map states and split tax', () => {
    expect(validGstin(SELLER)).toBe(true);
    expect(validGstin(SELLER.slice(0, 14) + (SELLER[14] === 'A' ? 'B' : 'A'))).toBe(false);
    expect(validGstin('27AAACH1234M1Z')).toBe(false);
    expect(stateCode('Maharashtra')).toBe('27');
    expect(stateCode('karnataka ')).toBe('29');
    expect(stateCode(BUYER_KA)).toBe('29');
    expect(stateCode('New Delhi')).toBe('07');
    expect(financialYear('2026-03-31')).toBe('2025-26');
    expect(financialYear('2026-04-01')).toBe('2026-27');
    expect(splitTax(9000.01, 'intra')).toEqual({ cgst: 4500.01, sgst: 4500, igst: 0 });
    expect(splitTax(9000, 'inter')).toEqual({ cgst: 0, sgst: 0, igst: 9000 });
  });
});

describe('invoices', () => {
  it('an intra-state invoice splits CGST + SGST; numbers are given at issue in the FY series', async () => {
    const inv = await acct('POST', '/api/v1/records/invoice', { name: 'Living room furniture', account_id: ids.mh });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    ids.inv1 = inv.json.id;
    expect(inv.json).toMatchObject({ status: 'draft', invoice_number: null, place_of_supply: 'Maharashtra' });
    const l = await acct('PUT', `/api/v1/invoices/${ids.inv1}/lines`, {
      lines: [
        { productId: ids.sofa, name: 'Sofa', hsnSac: '9401', quantity: 2, unitPrice: 50000.4, discountPct: 0, taxRate: 18, unit: 'Nos' },
        { productId: ids.fit, name: 'Fitting', hsnSac: '995479', quantity: 1, unitPrice: 5000, taxRate: 18 },
      ],
    });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    const i = l.json.invoice;
    expect(i).toMatchObject({ supply_type: 'intra', taxable_total: 105000.8, cgst_total: 9450.07, sgst_total: 9450.07, igst_total: 0 });
    expect(i.grand_total).toBe(123901); // rounded to the rupee
    expect(i.round_off).toBeCloseTo(123901 - 123900.94, 2);
    expect(l.json.lines[1].isService).toBe(true);
    const iss = await acct('POST', `/api/v1/invoices/${ids.inv1}/issue`);
    expect(iss.status, JSON.stringify(iss.json)).toBe(200);
    const fy = financialYear(new Date());
    expect(iss.json.invoice.invoice_number).toBe(`INV/${fy.slice(2, 4)}-${fy.slice(5)}/0001`);
    expect(iss.json.invoice).toMatchObject({ status: 'issued', buyer_gstin: BUYER_MH, seller_gstin: SELLER, place_of_supply: 'Maharashtra', pos_code: '27' });
    expect(iss.json.invoice.due_date).toBeTruthy();
    // issued documents are frozen
    expect((await acct('PUT', `/api/v1/invoices/${ids.inv1}/lines`, { lines: [] })).status).toBe(400);
    expect((await acct('PATCH', `/api/v1/records/invoice/${ids.inv1}`, { account_id: ids.ka })).status).toBe(400);
    expect((await acct('DELETE', `/api/v1/records/invoice/${ids.inv1}`)).status).toBe(400);
    expect((await acct('POST', `/api/v1/invoices/${ids.inv1}/issue`)).status).toBe(400);
  });

  it('an inter-state invoice is IGST; a bad customer GSTIN blocks issue', async () => {
    const inv = await acct('POST', '/api/v1/records/invoice', { name: 'Bedroom set', account_id: ids.ka });
    ids.inv2 = inv.json.id;
    const l = await acct('PUT', `/api/v1/invoices/${ids.inv2}/lines`, { lines: [{ name: 'Bed', hsnSac: '9403', quantity: 1, unitPrice: 40000, taxRate: 18 }] });
    expect(l.json.invoice).toMatchObject({ supply_type: 'inter', igst_total: 7200, cgst_total: 0, grand_total: 47200, place_of_supply: 'Karnataka' });
    // the place of supply can be changed on a draft (goods shipped to Maharashtra)
    const pos = await acct('PATCH', `/api/v1/records/invoice/${ids.inv2}`, { place_of_supply: 'Maharashtra' });
    expect(pos.json).toMatchObject({ supply_type: 'intra', cgst_total: 3600, sgst_total: 3600, igst_total: 0 });
    await acct('PATCH', `/api/v1/records/invoice/${ids.inv2}`, { place_of_supply: 'Karnataka' });
    const bad = await api('POST', '/api/v1/records/account', { name: 'Bad GST', gstin: '27AABCK5678P1ZZ', state: 'Maharashtra' });
    const inv3 = await acct('POST', '/api/v1/records/invoice', { name: 'x', account_id: bad.json.id });
    await acct('PUT', `/api/v1/invoices/${inv3.json.id}/lines`, { lines: [{ name: 'x', quantity: 1, unitPrice: 10, taxRate: 18 }] });
    const blocked = await acct('POST', `/api/v1/invoices/${inv3.json.id}/issue`);
    expect(blocked.status).toBe(400);
    expect(blocked.json.error.message).toMatch(/not valid/);
    expect((await acct('POST', `/api/v1/invoices/${ids.inv2}/issue`)).json.invoice.invoice_number).toMatch(/\/0002$/);
  });

  it('reps without billing access cannot run GST exports', async () => {
    expect((await rep('GET', `/api/v1/billing/gstr1?month=${new Date().toISOString().slice(0, 7)}`)).status).toBe(403);
  });
});

describe('payments and receivables', () => {
  it('payments apply to invoices (explicitly or oldest first) and drive the status', async () => {
    const p = await acct('POST', '/api/v1/payments', { accountId: ids.mh, amount: 50000, mode: 'upi', reference: 'UTR123', allocations: [{ invoiceId: ids.inv1, amount: 50000 }] });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(p.json.number).toMatch(/^RCPT\/\d{2}-\d{2}\/0001$/);
    let inv = (await acct('GET', `/api/v1/invoices/${ids.inv1}`)).json;
    expect(inv.invoice).toMatchObject({ status: 'partially_paid', amount_paid: 50000, balance_due: 73901 });
    expect(inv.payments[0]).toMatchObject({ payment_number: p.json.number, amount: 50000 });
    // over-application and wrong customer are refused
    const p2 = await acct('POST', '/api/v1/payments', { accountId: ids.mh, amount: 100000 });
    expect((await acct('POST', `/api/v1/payments/${p2.json.id}/allocate`, { allocations: [{ invoiceId: ids.inv1, amount: 80000 }] })).status).toBe(400);
    expect((await acct('POST', `/api/v1/payments/${p2.json.id}/allocate`, { allocations: [{ invoiceId: ids.inv2, amount: 10 }] })).status).toBe(400);
    const auto = await acct('POST', `/api/v1/payments/${p2.json.id}/allocate`, { allocations: 'auto' });
    expect(auto.status, JSON.stringify(auto.json)).toBe(200);
    expect(auto.json.payment).toMatchObject({ amount_allocated: 73901, unallocated: 26099 });
    inv = (await acct('GET', `/api/v1/invoices/${ids.inv1}`)).json;
    expect(inv.invoice).toMatchObject({ status: 'paid', balance_due: 0 });
    // voiding a payment re-opens the invoice
    expect((await acct('POST', `/api/v1/payments/${p.json.id}/void`, { reason: 'Bounced' })).status).toBe(200);
    expect((await acct('GET', `/api/v1/invoices/${ids.inv1}`)).json.invoice).toMatchObject({ status: 'partially_paid', amount_paid: 73901 });
    const ar = (await acct('GET', '/api/v1/billing/receivables')).json;
    expect(ar.items.map((r: Json) => r.name).sort()).toEqual(['Kapoor Interiors', 'Sharma Homes']);
    expect(ar.totals.outstanding).toBe(50000 + 47200);
    expect(ar.totals.unapplied).toBe(26099);
  });

  it('cancelling is only possible without payments; credit notes reduce the balance', async () => {
    expect((await acct('POST', `/api/v1/invoices/${ids.inv1}/cancel`, { reason: 'Wrong customer' })).status).toBe(400);
    const cn = await acct('POST', `/api/v1/invoices/${ids.inv2}/credit-note`, { reason: 'One leg damaged', lines: [] });
    expect(cn.status, JSON.stringify(cn.json)).toBe(201);
    ids.cnFull = cn.json.id;
    const inv2 = (await acct('GET', `/api/v1/invoices/${ids.inv2}`)).json;
    const partial = await acct('POST', `/api/v1/invoices/${ids.inv2}/credit-note`, { reason: 'Discount after delivery', lines: [{ lineId: inv2.lines[0].id, quantity: 0.25 }] });
    expect(partial.status, JSON.stringify(partial.json)).toBe(201);
    const issued = await acct('POST', `/api/v1/invoices/${partial.json.id}/issue`);
    expect(issued.json.invoice).toMatchObject({ doc_type: 'credit_note', grand_total: 11800, igst_total: 1800 });
    expect(issued.json.invoice.invoice_number).toMatch(/^CN\/\d{2}-\d{2}\/0001$/);
    expect((await acct('GET', `/api/v1/invoices/${ids.inv2}`)).json.invoice).toMatchObject({ status: 'partially_paid', amount_credited: 11800, balance_due: 35400 });
    expect((await acct('POST', `/api/v1/invoices/${ids.inv2}/cancel`, { reason: 'x' })).status).toBe(400); // too short and credit notes exist
    expect((await acct('POST', `/api/v1/invoices/${ids.inv2}/cancel`, { reason: 'Customer cancelled' })).status).toBe(400);
  });

  it('credit notes can never exceed the invoice, and one payment cannot be applied twice', async () => {
    // the full-invoice draft from before no longer fits: a quarter was credited since
    const full = await acct('POST', `/api/v1/invoices/${ids.cnFull}/issue`);
    expect(full.status).toBe(400);
    expect(full.json.error.message).toMatch(/left to credit/);
    const inv2 = (await acct('GET', `/api/v1/invoices/${ids.inv2}`)).json;
    const over = await acct('POST', `/api/v1/invoices/${ids.inv2}/credit-note`, { reason: 'Second discount', lines: [{ lineId: inv2.lines[0].id, quantity: 0.8 }] });
    expect(over.status).toBe(400);
    expect(over.json.error.message).toContain('0.75');
    // a draft whose lines are inflated afterwards is caught at issue
    const d = await acct('POST', `/api/v1/invoices/${ids.inv2}/credit-note`, { reason: 'Small goodwill credit', lines: [{ lineId: inv2.lines[0].id, quantity: 0.1 }] });
    expect(d.status).toBe(201);
    const l0 = inv2.lines[0];
    await acct('PUT', `/api/v1/invoices/${d.json.id}/lines`, { lines: [{ productId: l0.productId, name: l0.name, hsnSac: l0.hsnSac, quantity: 5, unitPrice: l0.unitPrice, taxRate: l0.taxRate }] });
    expect((await acct('POST', `/api/v1/invoices/${d.json.id}/issue`)).status).toBe(400);
    await acct('DELETE', `/api/v1/records/invoice/${d.json.id}`);
    // duplicate allocation lines are added up before the balance check
    const p = await acct('POST', '/api/v1/payments', { accountId: ids.ka, amount: 60000 });
    const dup = await acct('POST', `/api/v1/payments/${p.json.id}/allocate`, { allocations: [{ invoiceId: ids.inv2, amount: 20000 }, { invoiceId: ids.inv2, amount: 20000 }] });
    expect(dup.status).toBe(400);
    expect((await acct('GET', `/api/v1/invoices/${ids.inv2}`)).json.invoice).toMatchObject({ balance_due: 35400 });
    expect((await acct('POST', `/api/v1/payments/${p.json.id}/void`, { reason: 'Test receipt' })).status).toBe(200);
  });

  it('orders bill per milestone and pick up payments; the order shows what was received', async () => {
    const o = await api('POST', '/api/v1/records/sales_order', { name: 'B2C living room', account_id: ids.b2c });
    ids.order = o.json.id;
    await api('PUT', `/api/v1/orders/${ids.order}/lines`, { lines: [{ productId: ids.sofa, name: 'Sofa', hsnSac: '9401', quantity: 2, unitPrice: 50000, taxRate: 18 }] });
    await api('PUT', `/api/v1/orders/${ids.order}/milestones`, { milestones: [{ name: 'Advance', percent: 50, trigger: 'on_confirmation' }, { name: 'Balance', percent: 50, trigger: 'on_delivery' }] });
    expect((await api('POST', `/api/v1/orders/${ids.order}/invoices`, {})).status).toBe(400); // draft order
    await api('POST', `/api/v1/orders/${ids.order}/confirm`);
    const ms = (await api('GET', `/api/v1/orders/${ids.order}`)).json.milestones;
    const mi = await acct('POST', `/api/v1/orders/${ids.order}/invoices`, { milestoneId: ms[0].id });
    expect(mi.status, JSON.stringify(mi.json)).toBe(201);
    expect((await acct('POST', `/api/v1/orders/${ids.order}/invoices`, { milestoneId: ms[0].id })).status).toBe(409);
    const draft = (await acct('GET', `/api/v1/invoices/${mi.json.id}`)).json;
    expect(draft.lines[0]).toMatchObject({ name: 'Advance: Sofa', quantity: 1, unitPrice: 50000, hsnSac: '9401', taxRate: 18 });
    expect(draft.invoice.grand_total).toBe(59000);
    await acct('POST', `/api/v1/invoices/${mi.json.id}/issue`);
    // the customer pays the advance against the milestone
    const rc = await acct('POST', `/api/v1/orders/${ids.order}/milestones/${ms[0].id}/receipt`, { amount: 59000, note: 'NEFT 889' });
    expect(rc.status, JSON.stringify(rc.json)).toBe(201);
    expect((await acct('GET', `/api/v1/invoices/${mi.json.id}`)).json.invoice.status).toBe('paid');
    let ord = (await api('GET', `/api/v1/orders/${ids.order}`)).json;
    expect(ord.order).toMatchObject({ payment_status: 'partially_paid', amount_paid: 59000 });
    expect(ord.milestones[0]).toMatchObject({ status: 'paid', amount_paid: 59000 });
    // the rest of the order is invoiced by lines (not by milestone) — nothing was line-invoiced yet
    const rest = await acct('POST', `/api/v1/orders/${ids.order}/invoices`, {});
    expect(rest.status).toBe(201);
    await acct('POST', `/api/v1/invoices/${rest.json.id}/issue`);
    expect((await api('GET', `/api/v1/orders/${ids.order}`)).json.lines[0].invoicedQty).toBe(2);
    expect((await acct('POST', `/api/v1/orders/${ids.order}/invoices`, {})).status).toBe(400); // fully invoiced
    // an advance paid against the order (not yet applied) still counts as received
    await acct('POST', '/api/v1/payments', { salesOrderId: ids.order, amount: 1000, mode: 'cash' });
    ord = (await api('GET', `/api/v1/orders/${ids.order}`)).json;
    expect(ord.order.amount_paid).toBe(60000);
  });

  it('overdue invoices remind their owner once', async () => {
    // issued invoices are frozen, so the due date is set on the draft
    const inv = await acct('POST', '/api/v1/records/invoice', { name: 'Old balance', account_id: ids.ka, due_date: new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10) });
    await acct('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name: 'Repair', hsnSac: '998719', quantity: 1, unitPrice: 1000, taxRate: 18 }] });
    expect((await acct('POST', `/api/v1/invoices/${inv.json.id}/issue`)).status).toBe(200);
    const db = Db.fromEnv(h.env);
    try {
      await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
      await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
    } finally {
      await db.close();
    }
    const n = (await acct('GET', '/api/v1/notifications')).json.items.filter((x: Json) => x.kind === 'invoice');
    expect(n.length).toBe(1);
    expect(n[0].title).toMatch(/^Overdue: INV\//);
  });
});

describe('exports', () => {
  const month = new Date().toISOString().slice(0, 7);

  it('e-invoice JSON follows the IRP schema; the IRN can be recorded', async () => {
    const r = await acct('GET', `/api/v1/invoices/${ids.inv1}/einvoice`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const j = r.json.json;
    expect(j).toMatchObject({ Version: '1.1', TranDtls: { TaxSch: 'GST', SupTyp: 'B2B' }, DocDtls: { Typ: 'INV' }, SellerDtls: { Gstin: SELLER, Stcd: '27', Pin: 400069 }, BuyerDtls: { Gstin: BUYER_MH, Pos: '27', Pin: 400050 } });
    expect(j.ItemList[0]).toMatchObject({ SlNo: '1', HsnCd: '9401', IsServc: 'N', Unit: 'NOS', Qty: 2, GstRt: 18 });
    expect(j.ItemList[1].IsServc).toBe('Y');
    expect(j.ValDtls).toMatchObject({ AssVal: 105000.8, CgstVal: 9450.07, SgstVal: 9450.07, TotInvVal: 123901 });
    expect((await acct('GET', `/api/v1/invoices/${ids.inv2}/einvoice`)).json.json.ItemList[0].IgstAmt).toBe(7200);
    expect((await acct('PUT', `/api/v1/invoices/${ids.inv1}/irn`, { irn: 'x' })).status).toBe(400);
    expect((await acct('PUT', `/api/v1/invoices/${ids.inv1}/irn`, { irn: 'a'.repeat(64), ackNo: '112010000000001' })).status).toBe(200);
    expect((await acct('GET', `/api/v1/records/invoice/${ids.inv1}`)).json.irn).toBe('a'.repeat(64));
  });

  it('GSTR-1 sections come out as CSV for the offline tool', async () => {
    const sum = (await acct('GET', `/api/v1/billing/gstr1?month=${month}`)).json;
    expect(sum).toMatchObject({ invoices: 5, credit_notes: 1, b2b: 3, b2c: 2 });
    const b2b = await acct('GET', `/api/v1/billing/gstr1?month=${month}&section=b2b`, undefined, { raw: true });
    expect(b2b.headers.get('content-type')).toMatch(/text\/csv/);
    const rows = b2b.text.replace(/^﻿/, '').split('\r\n');
    expect(rows[0]).toMatch(/^GSTIN\/UIN of Recipient,Receiver Name,Invoice Number/);
    expect(rows.some((r) => r.startsWith(`${BUYER_KA},Sharma Homes,INV/`) && r.includes('29-Karnataka'))).toBe(true);
    const b2cs = (await acct('GET', `/api/v1/billing/gstr1?month=${month}&section=b2cs`, undefined, { raw: true })).text;
    expect(b2cs).toMatch(/OE,27-Maharashtra,,18,100000,0/);
    const cdnr = (await acct('GET', `/api/v1/billing/gstr1?month=${month}&section=cdnr`, undefined, { raw: true })).text;
    expect(cdnr).toMatch(/,C,29-Karnataka,N,Regular B2B,11800,,18,10000,0/);
    const hsn = (await acct('GET', `/api/v1/billing/gstr1?month=${month}&section=hsn`, undefined, { raw: true })).text;
    expect(hsn.split('\r\n').some((r) => r.startsWith('9403,'))).toBe(true);
  });

  it('Tally XML carries sales, credit-note and receipt vouchers with GST ledgers', async () => {
    const from = `${month}-01`;
    const to = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const r = await acct('GET', `/api/v1/billing/tally?from=${from}&to=${to}`, undefined, { raw: true });
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/^<\?xml version="1.0"/);
    expect(r.text).toMatch(/<VOUCHER VCHTYPE="Sales"/);
    expect(r.text).toMatch(/<VOUCHER VCHTYPE="Credit Note"/);
    expect(r.text).toMatch(/<VOUCHER VCHTYPE="Receipt"/);
    expect(r.text).toMatch(/<LEDGERNAME>Output IGST<\/LEDGERNAME>/);
    expect(r.text).toMatch(/<PARTYGSTIN>.{15}<\/PARTYGSTIN>/);
    const logs = (await api('GET', '/api/admin/audit?action=export')).json;
    expect(JSON.stringify(logs)).toMatch(/tally/);
  });
});
