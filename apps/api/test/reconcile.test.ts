/** Match & reconcile: suggestions across receipts, invoices, milestones, projects, bills and expenses; saved only on approval. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { type Json, makeHarness } from './harness';

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
const BUYER = gstin('09AACCF9012Q1Z');
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, any> = {};
const sql = async (q: string, p: unknown[] = []) => {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, p));
  } finally {
    await db.close();
  }
};
async function invoice(account: string, name: string, price: number, project?: string) {
  const inv = await api('POST', '/api/v1/records/invoice', { name, account_id: account, ...(project ? { project_id: project } : {}) });
  expect(inv.status, JSON.stringify(inv.json)).toBe(201);
  await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name, hsnSac: '998314', quantity: 1, unitPrice: price, taxRate: 18 }] });
  const iss = await api('POST', `/api/v1/invoices/${inv.json.id}/issue`);
  expect(iss.status, JSON.stringify(iss.json)).toBe(200);
  return inv.json.id as string;
}
async function receipt(account: string, amount: number, reference: string) {
  const r = await api('POST', '/api/v1/payments', { accountId: account, amount, reference, date: today });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}
const list = async (q = '') => (await api('GET', `/api/v1/reconcile${q}`)).json as { items: Json[]; counts: Record<string, number>; errors: string[] };

beforeAll(async () => {
  h = await makeHarness('synapse_test_reconcile');
  await h.signup('rec', 'owner@rec.test');
  api = h.as('rec', (await h.login('rec', 'owner@rec.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ids.tenant = me.tenant.id;
  for (const a of ['orders', 'billing', 'purchasing', 'books', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  ids.fci = (await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', gstin: BUYER, state: 'Uttar Pradesh' })).json.id;
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'Grain tracking portal', account_id: ids.fci, billing_method: 'fixed_price' })).json.id;
  ids.ms = (await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Milestone-1 design', amount: 150000 })).json.id;
  // raised outside the project: ₹1,50,000 + GST = ₹1,77,000
  ids.inv = await invoice(ids.fci, 'Software development — milestone 1', 150000);
  // FCI paid ₹1,71,000: 2% income-tax TDS and 2% GST TDS kept
  ids.pay = await receipt(ids.fci, 171000, 'NEFT YESBANK FCI');
  ids.acme = (await api('POST', '/api/v1/records/account', { name: 'Acme Traders' })).json.id;
  ids.a1 = await invoice(ids.acme, 'AMC October', 10000);
  ids.a2 = await invoice(ids.acme, 'AMC November', 20000);
  ids.payAcme = await receipt(ids.acme, 35400, 'UPI ACME'); // 11,800 + 23,600
}, 120_000);

describe('match & reconcile', () => {
  it('finds the milestone’s invoice, then applies the short receipt with the TDS the buyer kept — only on approval', async () => {
    let r = await list();
    expect(r.errors).toEqual([]);
    const link = r.items.find((s) => s.kind === 'milestone_invoice')!;
    expect(link).toMatchObject({ left: { id: ids.ms }, right: [{ id: ids.inv }] });
    expect(link.reasons).toEqual(expect.arrayContaining(['value before GST equals the milestone amount']));
    const fci = r.items.find((s) => s.kind === 'receipt_invoice' && s.left.id === ids.pay)!;
    expect(fci.title).toMatch(/record ₹6,000.00 deducted/);
    expect(fci.action).toMatchObject({ allocations: [{ invoiceId: ids.inv, amount: 177000 }], tds: 3000, gstTds: 3000 });
    // 4% of the value before GST: TDS 2% and GST TDS 2%
    expect(fci.reasons[0]).toMatch(/TDS 2% \+ GST TDS 2%/);
    // nothing is saved before approval
    expect((await sql(`select unallocated::float8 u from payments where id = $1`, [ids.pay]))[0]!.u).toBe(171000);

    // a person approves both, adjusting the split the screen shows
    const ok = await api('POST', '/api/v1/reconcile/apply', {
      items: [
        { key: link.key, kind: link.kind, action: link.action },
        { key: fci.key, kind: fci.kind, action: { ...fci.action, tds: 3000, gstTds: 3000 } },
      ],
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.results.every((x: Json) => x.ok)).toBe(true);
    expect((await sql(`select invoice_id from project_milestones where id = $1`, [ids.ms]))[0]!.invoice_id).toBe(ids.inv);
    const p = (await sql(`select amount::float8 a, tds_amount::float8 t, gst_tds_amount::float8 g, unallocated::float8 u from payments where id = $1`, [ids.pay]))[0]!;
    expect(p).toEqual({ a: 177000, t: 3000, g: 3000, u: 0 });
    expect((await sql(`select status, balance_due::float8 b from invoices where id = $1`, [ids.inv]))[0]).toEqual({ status: 'paid', b: 0 });
    // the books: the bank got 1,71,000, TDS receivable 3,000 and GST TDS 3,000
    const j = await sql(`select sum(debit)::float8 d, sum(credit)::float8 c from journal_lines l join journals j on j.id = l.journal_id where j.source_type = 'payment' and j.source_id = $1 and l.posted`, [ids.pay]);
    expect(j[0]).toEqual({ d: 177000, c: 177000 });
    r = await list();
    expect(r.items.some((s) => s.left.id === ids.pay || s.left.id === ids.ms)).toBe(false);
  });

  it('progress follows the milestones, not the tasks; invoiced counts the milestones’ invoices', async () => {
    // a second milestone of ₹50,000: one of ₹2,00,000 in all
    const m2 = (await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Milestone-2 go-live', amount: 50000 })).json.id;
    let s = (await api('GET', `/api/v1/projects/${ids.project}/summary`)).json;
    expect(s.progress).toBe(0);
    expect(s.milestones).toEqual({ total: 2, done: 0 });
    // the customer's approval mail closes milestone 1: three quarters of the value delivered, with no tasks at all
    const mail = (await sql(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1, 'email', 'Milestone-1 accepted', 'project', $2) returning id`, [ids.tenant, ids.project]))[0]!.id;
    const done = await api('PUT', `/api/v1/projects/${ids.project}/milestones/${ids.ms}`, { name: 'Milestone-1 design', amount: 150000, status: 'done', approvalActivityId: mail });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    s = (await api('GET', `/api/v1/projects/${ids.project}/summary`)).json;
    expect(s.progress).toBe(75);
    expect(s.milestones).toEqual({ total: 2, done: 1 });
    expect(s.tasks).toEqual({});
    // the invoice on milestone 1 counts even when it was never booked to the project itself
    await sql(`update invoices set project_id = null where id = $1`, [ids.inv]);
    s = (await api('GET', `/api/v1/projects/${ids.project}/summary`)).json;
    expect(s.money.revenue).toBe(150000);
    expect(s.money.milestonesUninvoiced).toBe(0);
    await sql(`update invoices set project_id = $2 where id = $1`, [ids.inv, ids.project]);
    // without amounts, milestones count equally
    await sql(`update project_milestones set amount = null where id = $1`, [m2]);
    await api('PUT', `/api/v1/projects/${ids.project}/milestones/${m2}`, { name: 'Milestone-2 go-live' });
    expect((await api('GET', `/api/v1/projects/${ids.project}/summary`)).json.progress).toBe(50);
    expect((await api('DELETE', `/api/v1/projects/${ids.project}/milestones/${m2}`)).status).toBeLessThan(300);
    expect((await api('GET', `/api/v1/projects/${ids.project}/summary`)).json.progress).toBe(100);
  });

  it('a receipt that pays several invoices together; a rejected suggestion stays hidden', async () => {
    let r = await list(`?focus=payment:${ids.payAcme}`);
    const two = r.items.find((s) => s.kind === 'receipt_invoice')!;
    expect(two.right.map((x: Json) => x.id).sort()).toEqual([ids.a1, ids.a2].sort());
    expect(two.confidence).toBeGreaterThan(0.8);
    expect((await api('POST', '/api/v1/reconcile/reject', { keys: [two.key] })).status).toBe(200);
    r = await list(`?focus=payment:${ids.payAcme}`);
    expect(r.items.find((s) => s.key === two.key)).toBeUndefined();
    // approving a stale or wrong one fails on its own, the rest still go through
    const bad = await api('POST', '/api/v1/reconcile/apply', { items: [{ key: 'x', kind: 'receipt_invoice', action: { paymentId: ids.payAcme, allocations: [{ invoiceId: ids.inv, amount: 10 }] } }] });
    expect(bad.json.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/open invoices|another customer/) });
  });

  it('puts invoices, bills and expenses on the project they belong to', async () => {
    const inv = await invoice(ids.fci, 'Grain tracking portal — change request 3', 20000);
    const exp = await api('POST', '/api/v1/records/expense', { name: 'Travel to FCI Delhi', amount: 4200, expense_date: today, notes: 'Grain tracking portal demo' });
    expect(exp.status, JSON.stringify(exp.json)).toBe(201);
    const r = await list(`?focus=project:${ids.project}`);
    const i = r.items.find((s) => s.kind === 'invoice_project' && s.left.id === inv)!;
    expect(i.reasons).toEqual(['the invoice names the project']);
    const e = r.items.find((s) => s.kind === 'expense_project' && s.left.id === exp.json.id)!;
    expect(e).toBeTruthy();
    const ok = await api('POST', '/api/v1/reconcile/apply', { items: [i, e].map((s) => ({ key: s.key, kind: s.kind, action: s.action })) });
    expect(ok.json.results.every((x: Json) => x.ok)).toBe(true);
    expect((await sql(`select project_id from invoices where id = $1`, [inv]))[0]!.project_id).toBe(ids.project);
    expect((await sql(`select project_id from expenses where id = $1`, [exp.json.id]))[0]!.project_id).toBe(ids.project);
    // the project's costs show the expense, and what the project makes
    const c = (await api('GET', `/api/v1/projects/${ids.project}/costs`)).json;
    expect(c.expenses.map((x: Json) => x.name)).toEqual(['Travel to FCI Delhi']);
    expect(c.economics.bases).toMatchObject({ invoiced: 170000, collected: 150000 });
  });

  it('commissions on profit: gross, net and after every expense, with the amount worked out', async () => {
    const dev = await api('POST', '/api/admin/users', { email: 'dev@rec.test', fullName: 'Nandan', password: 'Passw0rd!Passw0rd', roles: ['project_member'] });
    const pm = await api('POST', '/api/admin/users', { email: 'pm@rec.test', fullName: 'Aditya', password: 'Passw0rd!Passw0rd', roles: ['project_member'] });
    const put = await api('PUT', `/api/v1/projects/${ids.project}/members`, {
      members: [
        { userId: dev.json.id, role: 'member', payBasis: 'commission', commissionPct: 10, commissionOn: 'net_profit' },
        { userId: pm.json.id, role: 'member', payBasis: 'fixed', payAmount: 25000 },
      ],
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const g = (await api('GET', `/api/v1/projects/${ids.project}`)).json;
    const nb = g.members.find((m: Json) => m.full_name === 'Nandan');
    // invoiced 1,70,000 − expenses 4,200 (before GST) = gross; − fixed pay 25,000 = net
    const gross = g.economics.bases.gross_profit;
    expect(g.economics.bases.net_profit).toBe(gross - 25000);
    expect(nb.commission_now).toEqual({ base: 'net_profit', baseAmount: gross - 25000, amount: Math.round((gross - 25000) * 10) / 100 });
    expect((await api('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: dev.json.id, role: 'member', payBasis: 'commission', commissionPct: 5, commissionOn: 'profit_after_all' }] })).status).toBe(200);
    const g2 = (await api('GET', `/api/v1/projects/${ids.project}`)).json;
    expect(g2.members.find((m: Json) => m.full_name === 'Nandan').commission_now.base).toBe('profit_after_all');
    expect(g2.economics.bases.profit_after_all).toBe(Math.round((150000 - (170000 - gross)) * 100) / 100);
  });

  it('the project’s billing: its invoices (also through milestones), receipts with the TDS kept, GST out, and a new invoice for its customer', async () => {
    const b = await api('GET', `/api/v1/projects/${ids.project}/billing`);
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    const inv = b.json.invoices.find((i: Json) => i.id === ids.inv);
    expect(inv).toMatchObject({ milestone: 'Milestone-1 design', taxable: 150000, total: 177000, balance: 0, status: 'paid' });
    const rec = b.json.receipts.find((p: Json) => p.id === ids.pay);
    expect(rec).toMatchObject({ amount: 177000, tds: 3000, gst_tds: 3000, to_project: 177000 });
    expect(b.json.sales).toMatchObject({ tds: 3000, gstTds: 3000 });
    expect(b.json.sales.taxable).toBeGreaterThanOrEqual(150000);
    // GST out on the invoices (intra-state: CGST + SGST), less the GST TDS the government buyer deposited for us
    expect(b.json.gst.output).toBe(Math.round((b.json.sales.cgst + b.json.sales.sgst + b.json.sales.igst) * 100) / 100);
    expect(b.json.gst.net).toBe(Math.round((b.json.gst.output - b.json.gst.input - 3000) * 100) / 100);
    expect(b.json.desk).toMatchObject({ booksOn: true, canDecide: true, autonomy: 'auto_sure' });
    // a new draft invoice for the project's customer, booked to the project
    const n = await api('POST', `/api/v1/projects/${ids.project}/billing/new`, { kind: 'invoice' });
    expect(n.status, JSON.stringify(n.json)).toBe(201);
    expect((await sql(`select project_id, account_id, status from invoices where id = $1`, [n.json.id]))[0]).toEqual({ project_id: ids.project, account_id: ids.fci, status: 'draft' });
    const again = (await api('GET', `/api/v1/projects/${ids.project}/billing`)).json;
    expect(again.sales.drafts).toBeGreaterThanOrEqual(1);
    // a bill for the project
    expect((await api('POST', `/api/v1/projects/${ids.project}/billing/new`, { kind: 'bill' })).status).toBe(400);
    const vendor = (await api('POST', '/api/v1/records/vendor', { name: 'Cloud Hosting Pvt Ltd' })).json.id;
    const bill = await api('POST', `/api/v1/projects/${ids.project}/billing/new`, { kind: 'bill', vendorId: vendor });
    expect(bill.status, JSON.stringify(bill.json)).toBe(201);
    expect((await api('GET', `/api/v1/projects/${ids.project}/billing`)).json.bills.some((x: Json) => x.id === bill.json.id && x.whole)).toBe(true);
  });
});
