import { beforeAll, describe, expect, it } from 'vitest';
import { computeLines } from '../src/services/quotes';
import { dueFromTerms } from '../src/services/hooks';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_charges');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', address: 'Noida' } } });
  const a = await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', account_type: 'ngo', state: 'Uttar Pradesh', payment_terms: 'end_of_month' });
  expect(a.status, JSON.stringify(a.json)).toBe(201);
  ids.account = a.json.id;
}, 120_000);

describe('prices that include GST', () => {
  it('works the taxable value back from the amount', () => {
    const c = computeLines([{ name: 'Maintenance', quantity: 1, unitPrice: 1200, discountPct: 0, taxRate: 18 }], true);
    expect(c.lines[0]).toMatchObject({ lineSubtotal: 1016.95, lineTax: 183.05, lineTotal: 1200 });
    expect(c.grandTotal).toBe(1200);
    const d = computeLines([{ name: 'A', quantity: 3, unitPrice: 999, discountPct: 10, taxRate: 18 }], true);
    expect(d.grandTotal).toBe(2697.3);
    expect(d.subtotal - d.discountTotal + d.taxTotal).toBeCloseTo(d.grandTotal, 2);
  });

  it('bills ₹1,200 including GST on an invoice, split into CGST and SGST', async () => {
    const inv = await api('POST', '/api/v1/records/invoice', { name: 'Maintenance Nov', account_id: ids.account, invoice_date: '2026-11-01', subject: 'Monthly maintenance charge for the Sindhu Manthan website' });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    // the customer's terms: due at the end of the month
    expect(inv.json).toMatchObject({ payment_terms: 'end_of_month', due_date: '2026-11-30' });
    const r = await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { taxInclusive: true, lines: [{ name: 'Monthly maintenance charge - website', hsnSac: '998313', quantity: 1, unitPrice: 1200, taxRate: 18 }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice).toMatchObject({ tax_inclusive: true, grand_total: 1200, taxable_total: 1016.95 });
    expect(r.json.invoice.cgst_total + r.json.invoice.sgst_total).toBeCloseTo(183.05, 2);
    // switching it off on the draft works the lines out again
    const p = await api('PATCH', `/api/v1/records/invoice/${inv.json.id}`, { tax_inclusive: false });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json).toMatchObject({ grand_total: 1416, taxable_total: 1200 });
  });

  it('keeps the setting from quote to order', async () => {
    const q = await api('POST', '/api/v1/records/quote', { name: 'Website', account_id: ids.account });
    const l = await api('PUT', `/api/v1/quotes/${q.json.id}/lines`, { taxInclusive: true, lines: [{ name: 'Website development', quantity: 1, unitPrice: 11800, taxRate: 18 }] });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    expect(l.json.quote).toMatchObject({ tax_inclusive: true, grand_total: 11800, subtotal: 10000 });
  });
});

describe('payment terms', () => {
  it('dates invoices from their terms', () => {
    expect(dueFromTerms('due_on_receipt', '2026-09-14')).toBe('2026-09-14');
    expect(dueFromTerms('net_15', '2026-09-14')).toBe('2026-09-29');
    expect(dueFromTerms('end_of_month', '2026-02-10')).toBe('2026-02-28');
    expect(dueFromTerms('end_of_next_month', '2026-12-10')).toBe('2027-01-31');
    expect(dueFromTerms('custom', '2026-12-10')).toBeNull();
  });
  it('moves the due date when the terms or the date change, and keeps a date set by hand', async () => {
    const inv = await api('POST', '/api/v1/records/invoice', { name: 'Data conversion', account_id: ids.account, invoice_date: '2026-09-14', payment_terms: 'due_on_receipt' });
    expect(inv.json.due_date).toBe('2026-09-14');
    const a = await api('PATCH', `/api/v1/records/invoice/${inv.json.id}`, { payment_terms: 'net_30' });
    expect(a.json.due_date).toBe('2026-10-14');
    const b = await api('PATCH', `/api/v1/records/invoice/${inv.json.id}`, { payment_terms: 'custom', due_date: '2026-12-31' });
    expect(b.json.due_date).toBe('2026-12-31');
  });
});
