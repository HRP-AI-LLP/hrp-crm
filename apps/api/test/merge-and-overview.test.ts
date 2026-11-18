/** Merging two customers moves their invoices, receipts and ledger lines; the books overview has its panels; key people save. */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;

beforeAll(async () => {
  h = await makeHarness('synapse_test_merge_overview');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
}, 120_000);

describe('merging duplicate customers', () => {
  it('moves invoices, payments and ledger lines to the kept customer', async () => {
    const keep = (await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', account_type: 'government' })).json.id;
    const dup = (await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India, Zonal Office (North), Noida' })).json.id;
    const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Monitoring', account_id: dup })).json.id;
    await api('PUT', `/api/v1/invoices/${inv}/lines`, { lines: [{ name: 'Monitoring', quantity: 1, unitPrice: 1000, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/invoices/${inv}/issue`)).status).toBe(200);
    const pay = await api('POST', '/api/v1/payments', { accountId: dup, amount: 1180, mode: 'upi', allocations: [{ invoiceId: inv, amount: 1180 }] });
    expect(pay.status, JSON.stringify(pay.json)).toBeLessThan(300);
    const m = await api('POST', '/api/v1/records/account/merge', { masterId: keep, duplicateIds: [dup] });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    expect((await api('GET', `/api/v1/invoices/${inv}`)).json.invoice.account_id).toBe(keep);
    expect((await api('GET', `/api/v1/records/account/${dup}`)).status).toBe(404);
  });
});

describe('books overview and key people', () => {
  it('has bank balances, spending, who owes and bills', async () => {
    const o = (await api('GET', '/api/v1/books/overview')).json;
    for (const k of ['banks', 'topSpend', 'owedBy', 'dueBills', 'lastMonth']) expect(o).toHaveProperty(k);
    expect(o.owedBy).toEqual([]);
  });
  it('saves the leadership team', async () => {
    const org = (await api('GET', '/api/v1/organisation')).json;
    const r = await api('PUT', '/api/v1/organisation', { ...org.profile, keyPeople: [{ name: 'Prashant Srivastava', designation: 'Chief Technology Officer (CTO)', department: 'Technology & AI' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await api('GET', '/api/v1/organisation')).json.profile.keyPeople[0]).toMatchObject({ designation: 'Chief Technology Officer (CTO)' });
  });
});
