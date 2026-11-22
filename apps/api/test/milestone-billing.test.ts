/** A milestone's invoice and money found and mapped with approval; team members paid by salary, fixed fee or commission. */
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
const BUYER = gstin('09AACCS9012Q1Z');
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const sql = async (q: string, p: unknown[] = []) => {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, p));
  } finally {
    await db.close();
  }
};

beforeAll(async () => {
  h = await makeHarness('synapse_test_msbilling');
  await h.signup('msb', 'owner@msb.test');
  api = h.as('msb', (await h.login('msb', 'owner@msb.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ids.tenant = me.tenant.id;
  ids.owner = me.user.id;
  for (const a of ['orders', 'billing', 'purchasing', 'books', 'projects']) {
    const r = await api('POST', `/api/admin/apps/${a}/enable`);
    expect(r.status, a + JSON.stringify(r.json)).toBe(200);
  }
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  ids.customer = (await api('POST', '/api/v1/records/account', { name: 'Coal Corporation', gstin: BUYER, state: 'Uttar Pradesh' })).json.id;
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'CPF data conversion', account_id: ids.customer, billing_method: 'fixed_price' })).json.id;
  ids.ms = (await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Milestone-1', amount: 177000 })).json.id;
  // the invoice was raised from Billing → invoices directly, not from the project
  const inv = await api('POST', '/api/v1/records/invoice', { name: '30% milestone payment', account_id: ids.customer });
  await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name: 'Software development — 30% milestone', hsnSac: '998314', quantity: 1, unitPrice: 177000, taxRate: 18 }] });
  const iss = await api('POST', `/api/v1/invoices/${inv.json.id}/issue`);
  expect(iss.status, JSON.stringify(iss.json)).toBe(200);
  ids.invoice = inv.json.id;
  ids.number = (iss.json.invoice ?? iss.json).invoice_number;
  // another invoice of the same value for someone else: not offered
  const other = (await api('POST', '/api/v1/records/account', { name: 'Another Buyer' })).json.id;
  const inv2 = await api('POST', '/api/v1/records/invoice', { name: 'Other', account_id: other });
  await api('PUT', `/api/v1/invoices/${inv2.json.id}/lines`, { lines: [{ name: 'Other work', hsnSac: '998314', quantity: 1, unitPrice: 177000, taxRate: 18 }] });
  await api('POST', `/api/v1/invoices/${inv2.json.id}/issue`);
}, 120_000);

describe('a milestone’s invoice and money', () => {
  it('finds the invoice raised elsewhere and links it only when approved', async () => {
    const b = await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing`);
    expect(b.status, JSON.stringify(b.json)).toBe(200);
    expect(b.json.invoice).toBeNull();
    expect(b.json.candidates.map((c: Json) => c.id)).toEqual([ids.invoice]);
    expect(b.json.best).toBe(ids.invoice);
    expect(b.json.candidates[0].reasons).toEqual(expect.arrayContaining(['value before GST equals the milestone amount', 'the project’s customer']));
    // nothing linked yet
    expect((await sql(`select invoice_id from project_milestones where id = $1`, [ids.ms]))[0]!.invoice_id).toBeNull();
    const ln = await api('POST', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing/link`, { invoiceId: ids.invoice });
    expect(ln.status, JSON.stringify(ln.json)).toBe(200);
    const u = (await api('GET', `/api/v1/projects/${ids.project}/unbilled`)).json;
    expect(u.milestones).toEqual([]);
    expect(u.invoicedMilestones).toEqual([expect.objectContaining({ id: ids.ms, invoice_number: ids.number, balance_due: 208860 })]);
    expect(u.invoicedToDate).toBe(177000);
  });

  it('maps a receipt and a bank credit (less TDS) to the invoice', async () => {
    const p = await api('POST', '/api/v1/payments', { accountId: ids.customer, amount: 100000, reference: 'UTR-A' });
    expect(p.status, JSON.stringify(p.json)).toBeLessThan(300);
    const bank = ((await api('GET', '/api/v1/books/bank-accounts')).json as Json[])[0]!.id;
    // the rest arrives with 10% income-tax TDS on the value kept: 108860 - 17700 = 91160
    const st = await api('POST', `/api/v1/books/bank-accounts/${bank}/statement`, { rows: [{ date: daysAgo(0), description: 'NEFT CR-SBIN0001-COAL CORPORATION-CPF', amount: 91160, reference: 'N77' }] });
    expect(st.status, JSON.stringify(st.json)).toBeLessThan(300);
    const b = (await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing`)).json;
    expect(b.receipts.map((r: Json) => r.unallocated)).toEqual([100000]);
    const line = b.bankLines.find((x: Json) => x.amount === 91160);
    expect(line).toBeTruthy();
    expect(line.reasons).toEqual(expect.arrayContaining(['names the customer']));
    const m1 = await api('POST', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing/map`, { items: [{ kind: 'receipt', id: p.json.id }] });
    expect(m1.json.results).toEqual([expect.objectContaining({ ok: true })]);
    expect(m1.json.invoice.balance_due).toBe(108860);
    const b2 = (await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing`)).json;
    const l2 = b2.bankLines.find((x: Json) => x.amount === 91160);
    expect(l2.suggestedTds).toBe(17700);
    const m2 = await api('POST', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing/map`, { items: [{ kind: 'bank', id: l2.id, tdsAmount: 17700 }] });
    expect(m2.json.results, JSON.stringify(m2.json)).toEqual([expect.objectContaining({ ok: true })]);
    expect(m2.json.invoice).toMatchObject({ balance_due: 0, status: 'paid' });
    const b3 = (await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/billing`)).json;
    expect(b3.applied.map((x: Json) => x.amount).sort()).toEqual([100000, 108860]);
  });
});

describe('how team members are paid', () => {
  it('turns salary and day rates into hourly cost, and adds fixed pay and commission to labour cost', async () => {
    const add = (email: string, name: string) => api('POST', '/api/admin/users', { email, fullName: name, password: 'Passw0rd!Passw0rd', roles: ['sales_rep'] }).then((r) => r.json.id as string);
    const a = await add('a@msb.test', 'Asha Salaried');
    const d = await add('d@msb.test', 'Dev Daily');
    const f = await add('f@msb.test', 'Farah Fixed');
    const c = await add('c@msb.test', 'Chirag Commission');
    const t = await api('PUT', `/api/v1/projects/${ids.project}/members`, {
      members: [
        { userId: ids.owner, role: 'manager', payBasis: 'none' },
        { userId: a, role: 'member', payBasis: 'monthly', payAmount: 86666.67 },
        { userId: d, role: 'member', payBasis: 'daily', payAmount: 4000 },
        { userId: f, role: 'member', payBasis: 'fixed', payAmount: 50000 },
        { userId: c, role: 'member', payBasis: 'commission', commissionPct: 5, commissionOn: 'invoiced' },
      ],
    });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect((await api('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: a, role: 'member', payBasis: 'monthly' }] })).status).toBe(400);
    const team = (await api('GET', `/api/v1/projects/${ids.project}`)).json.members as Json[];
    expect(team.find((m) => m.user_id === f)).toMatchObject({ pay_basis: 'fixed', pay_amount: 50000 });
    // 86666.67 a month over 8 h × 5 days × 52/12 = 500 an hour; 4000 a day over 8 h = 500 an hour
    for (const [u, mins] of [[a, 120], [d, 60]] as const) {
      const r = await api('POST', '/api/v1/time', { projectId: ids.project, date: daysAgo(1), minutes: mins, userId: u });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    expect((await sql(`select u.full_name, e.cost_rate::float8 as c from time_entries e join users u on u.id = e.user_id where e.project_id = $1 order by u.full_name`, [ids.project])).map((x) => [x.full_name, x.c])).toEqual([
      ['Asha Salaried', 500],
      ['Dev Daily', 500],
    ]);
    await sql(`update time_entries set status = 'approved' where project_id = $1`, [ids.project]);
    const s = (await api('GET', `/api/v1/projects/${ids.project}/summary`)).json.money;
    // 1500 of time + 50000 fixed + 5% of 177000 invoiced
    expect(s).toMatchObject({ fixedPay: 50000, commission: 8850, labourCost: 60350 });
  });
});
