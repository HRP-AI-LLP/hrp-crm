import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { payeeKey } from '../src/services/books/desk';
import { razorpayxRow } from '../src/services/books/feeds';
import { booksDailySweep } from '../src/services/books/sweep';
import { hmacSha256Hex } from '../src/lib/crypto';
import { makeHarness, PW } from './harness';

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
const VENDOR = gstin('09AABCV5678P1Z');
const BUYER = gstin('09AACCS9012Q1Z');
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const sysAcc: Record<string, string> = {};
let tenantId = '';

// a fake RazorpayX
const realFetch = globalThis.fetch;
const RZP_KEY = 'rzp_live_TESTKEY123';
const RZP_SECRET = 'secret-secret-123';
const rzpCalls: { path: string; query: Record<string, string> }[] = [];
let rzpItems: any[] = [];
const PG_KEY = 'rzp_live_GATEWAY123';
const PG_SECRET = 'gateway-secret-1';
let settlements: any[] = [];

async function newInvoice(name: string, unitPrice: number) {
  const inv = await api('POST', '/api/v1/records/invoice', { name, account_id: ids.customer });
  await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name: 'IoT monitoring', hsnSac: '998314', quantity: 1, unitPrice, taxRate: 18 }] });
  const i = await api('POST', `/api/v1/invoices/${inv.json.id}/issue`);
  expect(i.status, JSON.stringify(i.json)).toBe(200);
  return { id: inv.json.id as string, number: (i.json.invoice ?? i.json).invoice_number as string };
}
const statement = (rows: { date: string; description: string; amount: number; reference?: string }[]) => api('POST', `/api/v1/books/bank-accounts/${ids.bank}/statement`, { rows, toDesk: true });
const queue = async () => (await api('GET', '/api/v1/books/desk/proposals')).json as any[];

beforeAll(async () => {
  h = await makeHarness('synapse_test_desk');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'api.razorpay.com') return realFetch(input, init);
    const auth = (init?.headers as Record<string, string>).authorization;
    const query = Object.fromEntries(url.searchParams.entries());
    rzpCalls.push({ path: url.pathname, query });
    // the payment gateway (its own keys): payment links and settlements
    if (auth === `Basic ${btoa(`${PG_KEY}:${PG_SECRET}`)}`) {
      const j = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/v1/payment_links' && (init?.method ?? 'GET') === 'GET') return j({ items: [] });
      if (url.pathname === '/v1/payment_links') return j({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' });
      if (url.pathname === '/v1/settlements') return j({ entity: 'collection', count: settlements.length, items: settlements });
      return j({});
    }
    if (auth !== `Basic ${btoa(`${RZP_KEY}:${RZP_SECRET}`)}`) return new Response(JSON.stringify({ error: { description: 'The api key provided is invalid' } }), { status: 401 });
    const from = Number(query.from ?? 0);
    const items = rzpItems.filter((t) => t.created_at >= from).slice(Number(query.skip ?? 0), Number(query.skip ?? 0) + Number(query.count ?? 10));
    return new Response(JSON.stringify({ entity: 'collection', count: items.length, items }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  const s = await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sysAcc[a.system_key] = a.id;
  const u = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  expect(u.status).toBe(201);
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);

  ids.customer = (await api('POST', '/api/v1/records/account', { name: 'Sharma Homes', gstin: BUYER, state: 'Uttar Pradesh' })).json.id;
  ids.vendor = (await api('POST', '/api/v1/records/vendor', { name: 'Sai Plywood', gstin: VENDOR, state: 'Uttar Pradesh' })).json.id;
  const b = await api('POST', '/api/v1/records/bill', { name: 'Plywood', vendor_id: ids.vendor, vendor_ref: 'SP/101', bill_date: daysAgo(5) });
  ids.bill = b.json.id;
  await api('PUT', `/api/v1/books/bills/${ids.bill}/lines`, { lines: [{ name: 'Plywood 18mm', hsnSac: '4412', quantity: 1, unitPrice: 10000, taxRate: 18 }] });
  expect((await api('POST', `/api/v1/books/bills/${ids.bill}/post`)).status).toBe(200);
  ids.bank = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((x) => x.gl_account_id === sysAcc.bank).id;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('reading a bank narration', () => {
  it('reduces it to who was paid', () => {
    expect(payeeKey('UPI/412345678901/AIRTEL PAYMENTS/airtel@ybl/Bill')).toBe('AIRTEL PAYMENTS AIRTEL BILL');
    expect(payeeKey('NEFT CR-HDFC0000001-SHARMA HOMES PVT LTD-N123456')).toBe('SHARMA HOMES');
    expect(payeeKey('anything', 'Ravi Kumar')).toBe('RAVI KUMAR');
  });
  it('turns RazorpayX transactions into statement lines', () => {
    expect(razorpayxRow({ id: 'txn_1', credit: 1180000, debit: 0, balance: 5000000, created_at: 1_760_000_000, source: { entity: 'bank_transfer', mode: 'NEFT', payer_name: 'Sharma Homes', bank_reference: 'N123' } })).toMatchObject({
      amount: 11800,
      balance: 50000,
      externalId: 'rzpx:txn_1',
      counterparty: 'Sharma Homes',
      reference: 'N123',
    });
    expect(razorpayxRow({ id: 'txn_2', credit: 0, debit: 5900, created_at: 1_760_000_000, source: { entity: 'payout', mode: 'IMPS', utr: 'U1', fund_account: { contact: { name: 'Airtel' } } } })).toMatchObject({ amount: -59, counterparty: 'Airtel' });
  });
});

describe('the bookkeeper', () => {
  it('books what is sure and queues the rest', async () => {
    expect((await rep('GET', '/api/v1/books/desk')).status).toBe(403);
    const o = await api('GET', '/api/v1/books/desk');
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(o.json.settings).toMatchObject({ autonomy: 'auto_sure', enabled: true });
    expect(o.json.agents.map((a: any) => a.key)).toEqual(['bank_clerk', 'bookkeeper', 'compliance', 'controller']);

    const i1 = await newInvoice('Pilot', 10000);
    const i2 = await newInvoice('Rollout', 10000);
    ids.i1 = i1.id;
    ids.i2 = i2.id;
    const r = await statement([
      { date: daysAgo(2), description: `NEFT CR-SBIN0000001-SHARMA HOMES-${i1.number}`, amount: 11800, reference: 'N1' },
      { date: daysAgo(1), description: 'NEFT CR-SHARMA HOMES', amount: 10800, reference: 'N2' },
      { date: daysAgo(1), description: 'NEFT DR SAI PLYWOOD SP/101', amount: -11800, reference: 'N3' },
      { date: daysAgo(1), description: 'SMS ALERT CHGS QTR', amount: -59 },
      { date: daysAgo(1), description: 'UPI/412345678901/AIRTEL PAYMENTS/airtel@ybl', amount: -1179 },
      { date: daysAgo(1), description: 'MISC XYZ 99', amount: -777 },
    ]);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ added: 6, autoCategorized: 0, bookkeeper: { lines: 6, applied: 2, waiting: 3, noIdea: 1 } });

    // the receipt and the vendor payment were recorded and matched
    const inv1 = await api('GET', `/api/v1/invoices/${i1.id}`);
    expect((inv1.json.invoice ?? inv1.json).status).toBe('paid');
    const bill = await api('GET', `/api/v1/books/bills/${ids.bill}`);
    expect((bill.json.bill ?? bill.json).status).toBe('paid');
    const done = (await api('GET', '/api/v1/books/desk/proposals?status=applied')).json as any[];
    expect(done.map((p) => p.kind).sort()).toEqual(['receipt', 'vendor_payment']);
    expect(done.every((p) => p.applied_by === 'agent' && p.txn_status === 'matched')).toBe(true);

    const q = await queue();
    expect(q).toHaveLength(3);
    const tdsReceipt = q.find((p) => p.kind === 'receipt');
    expect(tdsReceipt).toMatchObject({ source: 'invoice', payload: { invoiceId: i2.id, tdsAmount: 1000 } });
    expect(tdsReceipt.confidence).toBeCloseTo(0.8, 2);
    expect(q.find((p) => p.description.startsWith('SMS'))).toMatchObject({ kind: 'categorize', source: 'keyword', payload: { accountId: sysAcc.bank_charges } });
    expect(q.find((p) => p.description.includes('AIRTEL'))).toMatchObject({ kind: 'categorize', payload: { accountId: sysAcc.telephone } });

    const tb = await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`);
    expect(tb.json.totals.balanced).toBe(true);
  });

  it('applies what a person approves, learns rules, and respects a rejection', async () => {
    const q = await queue();
    const tdsReceipt = q.find((p) => p.kind === 'receipt');
    const ok = await api('POST', `/api/v1/books/desk/proposals/${tdsReceipt.id}`, { decision: 'approve' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await api('GET', `/api/v1/invoices/${ids.i2}`)).json).toMatchObject(expect.objectContaining({}));
    const inv2 = (await api('GET', `/api/v1/invoices/${ids.i2}`)).json;
    expect((inv2.invoice ?? inv2).status).toBe('paid');

    const sms = q.find((p) => p.description.startsWith('SMS'));
    const a = await api('POST', `/api/v1/books/desk/proposals/${sms.id}`, { decision: 'approve', makeRule: { contains: 'SMS ALERT' } });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(((await api('GET', '/api/v1/books/bank-rules')).json as any[]).some((r) => r.contains === 'SMS ALERT' && r.account_id === sysAcc.bank_charges)).toBe(true);

    const airtel = q.find((p) => p.description.includes('AIRTEL'));
    expect((await api('POST', `/api/v1/books/desk/proposals/${airtel.id}`, { decision: 'reject' })).status).toBe(200);
    expect((await api('POST', `/api/v1/books/desk/proposals/${airtel.id}`, { decision: 'approve' })).status).toBe(409);

    // a person books the unknown line; the next one like it is suggested from that history
    const misc = ((await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/transactions?status=unmatched`)).json as any[]).find((t) => t.description.startsWith('MISC'));
    expect((await api('POST', `/api/v1/books/bank-transactions/${misc.id}/categorize`, { accountId: sysAcc.office })).status).toBe(200);

    const r = await statement([
      { date: today, description: 'SMS ALERT CHGS NOV', amount: -59 },
      { date: today, description: 'MISC XYZ 100', amount: -500 },
    ]);
    expect(r.json.bookkeeper).toMatchObject({ lines: 3, applied: 1 });
    const nq = await queue();
    // the rejected Airtel suggestion is not offered again
    expect(nq.find((p) => p.description.includes('AIRTEL'))).toBeUndefined();
    expect(nq.find((p) => p.description.startsWith('MISC'))).toMatchObject({ kind: 'categorize', source: 'history', payload: { accountId: sysAcc.office } });
  });

  it('lets a person change the suggestion before it is applied', async () => {
    const misc = (await queue()).find((p) => p.description.startsWith('MISC'));
    const r = await api('POST', `/api/v1/books/desk/proposals/${misc.id}`, { decision: 'approve', change: { kind: 'categorize', accountId: sysAcc.stationery, narration: 'Printer paper' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const all = (await api('GET', '/api/v1/books/desk/proposals?status=all')).json as any[];
    expect(all.find((p) => p.source === 'person' && p.status === 'applied')).toMatchObject({ payload: { accountId: sysAcc.stationery } });
  });

  it('only suggests when told to', async () => {
    expect((await api('PUT', '/api/v1/books/desk/settings', { autonomy: 'suggest' })).json).toMatchObject({ autonomy: 'suggest' });
    const i3 = await newInvoice('Support', 5000);
    const r = await statement([{ date: today, description: `NEFT CR SHARMA HOMES ${i3.number}`, amount: 5900 }]);
    expect(r.json.bookkeeper).toMatchObject({ applied: 0, waiting: 1 });
    const p = (await queue()).find((x) => x.kind === 'receipt');
    expect(p.confidence).toBeGreaterThanOrEqual(0.95);
    // approve in bulk
    const many = await api('POST', '/api/v1/books/desk/proposals/approve', { ids: [p.id] });
    expect(many.json).toMatchObject({ approved: 1 });
    await api('PUT', '/api/v1/books/desk/settings', { autonomy: 'auto_sure' });
  });
});

describe('the compliance clerk and the controller', () => {
  it('flags bank lines nobody booked, and closes the month with figures', async () => {
    await statement([{ date: daysAgo(20), description: 'CASH DEP BRANCH', amount: 2000 }]);
    const run = await api('POST', '/api/v1/books/desk/run', { agents: ['compliance', 'controller'], period: today.slice(0, 7) });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.compliance.error).toBeUndefined();
    expect(run.json.controller.error).toBeUndefined();
    const f = (await api('GET', '/api/v1/books/desk/findings')).json as any[];
    expect(f.find((x) => x.key === 'bank:stale')).toMatchObject({ agent: 'compliance', severity: 'warn' });
    expect(f.find((x) => x.key === `close:${today.slice(0, 7)}:bank-unhandled`)).toMatchObject({ agent: 'controller' });
    expect(run.json.controller.figures).toMatchObject({ balanced: true });
    expect(run.json.controller.figures.income).toBeGreaterThan(0);
    expect(run.json.controller.summary).toMatch(/net (profit|loss)/);

    // dismissed stays dismissed on the next run; a fixed one closes by itself
    const stale = f.find((x) => x.key === 'bank:stale');
    expect((await api('POST', `/api/v1/books/desk/findings/${stale.id}`, { status: 'dismissed' })).status).toBe(200);
    await api('POST', '/api/v1/books/desk/run', { agents: ['compliance'] });
    expect(((await api('GET', '/api/v1/books/desk/findings')).json as any[]).find((x) => x.key === 'bank:stale')).toBeUndefined();

    const o = (await api('GET', '/api/v1/books/desk')).json;
    expect(o.lastClose).toMatchObject({ period: today.slice(0, 7) });
    expect(o.agents.find((a: any) => a.key === 'controller').lastRun).toBeTruthy();
  });
});

describe('resolving what the agents find', () => {
  it('says how to fix each finding and fixes it from there', async () => {
    // a GSTR-2B month with a supplier invoice that is not in the books
    const ym = today.slice(0, 7);
    const period = `${ym.slice(5, 7)}${ym.slice(0, 4)}`;
    const imp = await api('POST', '/api/v1/books/gstr-2b', { period, rows: [{ supplierGstin: gstin('09AAGCS1111B1Z'), supplierName: 'Steel Traders', docNumber: 'ST/77', docDate: daysAgo(3), taxable: 5000, cgst: 450, sgst: 450 }] });
    expect(imp.status, JSON.stringify(imp.json)).toBe(200);
    await api('POST', '/api/v1/books/desk/run', { agents: ['compliance'] });
    let f = ((await api('GET', '/api/v1/books/desk/findings')).json as any[]).find((x) => x.key === `gst:2b-unmatched:${period}`);
    expect(f.resolution.steps.join(' ')).toMatch(/Enter them as bills|Add to books|bills/);
    expect(f.resolution.actions.map((a: any) => a.key)).toEqual(expect.arrayContaining(['gstr2b_rematch', 'gstr2b_add_all']));
    expect((await api('POST', `/api/v1/books/desk/findings/${f.id}/fix`, { action: 'nope' })).status).toBe(400);
    const fix = await api('POST', `/api/v1/books/desk/findings/${f.id}/fix`, { action: 'gstr2b_add_all' });
    expect(fix.status, JSON.stringify(fix.json)).toBe(200);
    expect(fix.json).toMatchObject({ cleared: true });
    expect(fix.json.message).toMatch(/1 bill\(s\) entered, 1 posted, 1 new supplier/);

    // unplaced bank lines: book a whole payee group at once and keep it as a rule
    await statement([
      { date: daysAgo(2), description: 'UPI/1111/ZOMATO LTD/zomato@hdfc', amount: -350 },
      { date: daysAgo(1), description: 'UPI/2222/ZOMATO LTD/zomato@hdfc', amount: -420 },
    ]);
    const stale = ((await api('GET', '/api/v1/books/desk/findings')).json as any[]).find((x) => x.kind === 'bank_unhandled');
    if (stale) expect(stale.resolution.actions.map((a: any) => a.key)).toContain('bookkeeper');
    const groups = (await api('GET', '/api/v1/books/desk/unbooked')).json as any[];
    const z = groups.find((g) => g.key.startsWith('ZOMATO'));
    expect(z).toMatchObject({ count: 2, total: 770, inflow: false, ruleText: 'ZOMATO' });
    const b = await api('POST', '/api/v1/books/desk/unbooked/book', { txnIds: z.txnIds, accountId: sysAcc.meals, rule: { contains: 'ZOMATO', direction: 'out' } });
    expect(b.json).toMatchObject({ booked: 2, failed: 0, rule: true });
    const r = await statement([{ date: today, description: 'UPI/3333/ZOMATO LTD/zomato@hdfc', amount: -199 }]);
    expect(r.json.bookkeeper).toMatchObject({ applied: 1 });
  });
});

describe('creating what is missing and reconciling', () => {
  it('proposes a new customer for money nobody in the books explains, and records it as an advance', async () => {
    const r = await statement([{ date: daysAgo(1), description: 'NEFT CR-HDFC0000123-RAVI ENTERPRISES-ADVANCE', amount: 15000 }]);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const p = (await queue()).find((x) => x.kind === 'new_party');
    expect(p).toMatchObject({ source: 'missing', payload: { partyType: 'customer', partyId: null, name: 'Ravi Enterprises' } });
    // the person edits the name before approving
    const ok = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve', change: { kind: 'new_party', partyType: 'customer', partyName: 'Ravi Enterprises Pvt Ltd' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const acc = (await api('GET', '/api/v1/records/account?limit=50')).json.items.find((a: any) => a.name === 'Ravi Enterprises Pvt Ltd');
    expect(acc).toBeTruthy();
    const txn = ((await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/transactions?status=all`)).json as any[]).find((t) => t.description.includes('RAVI'));
    expect(txn.status).toBe('matched');
    expect((await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`)).json.totals.balanced).toBe(true);
  });

  it('brings the opening balance from the statement and then reconciles the account by itself', async () => {
    const nb = await api('POST', '/api/v1/books/bank-accounts', { name: 'Yes Bank Current', kind: 'bank' });
    expect(nb.status, JSON.stringify(nb.json)).toBe(201);
    const yes = nb.json.id;
    const d1 = `${today.slice(0, 7)}-01`;
    const imp = await api('POST', `/api/v1/books/bank-accounts/${yes}/statement`, {
      toDesk: true,
      rows: [
        { date: d1, description: 'INT.PD SB', amount: 1000, balance: 51000 },
        { date: d1, description: 'AMB CHRGS FOR OCT', amount: -200, balance: 50800 },
      ],
    });
    expect(imp.json.added).toBe(2);
    // book both (approve whatever is waiting for this account)
    const waiting = (await queue()).filter((x) => x.bank_account === 'Yes Bank Current').map((x) => x.id);
    expect((await api('POST', '/api/v1/books/desk/proposals/approve', { ids: waiting })).json.approved).toBe(2);
    const run = await api('POST', '/api/v1/books/desk/run', { agents: ['controller'], period: today.slice(0, 7) });
    expect(run.json.controller.error).toBeUndefined();
    const f = ((await api('GET', '/api/v1/books/desk/findings')).json as any[]).find((x) => x.kind === 'close_bank_balance' && x.title.startsWith('Yes Bank Current'));
    expect(f).toBeTruthy();
    expect(f.resolution.actions.map((a: any) => a.key)).toContain('opening');
    const fix = await api('POST', `/api/v1/books/desk/findings/${f.id}/fix`, { action: 'opening' });
    expect(fix.status, JSON.stringify(fix.json)).toBe(200);
    expect(fix.json.message).toMatch(/50,000\.00 brought forward/);
    expect(fix.json.cleared).toBe(true);
    const acct = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((x) => x.id === yes);
    expect(acct).toMatchObject({ book_balance: 50800, reconciled_to: expect.stringMatching(/^\d{4}-\d{2}-01/) });
    expect((await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`)).json.totals.balanced).toBe(true);
  });
});

describe('the bank clerk and live feeds', () => {
  it('connects RazorpayX only with working keys and never shows them again', async () => {
    const bad = await api('POST', '/api/v1/books/feeds', { bankAccountId: ids.bank, provider: 'razorpayx', accountRef: '2323230000001111', keyId: RZP_KEY, keySecret: 'wrong-secret-1' });
    expect(bad.status).toBe(502);
    expect(bad.json.error?.message ?? bad.json.message).toMatch(/refused/);
    const ok = await api('POST', '/api/v1/books/feeds', { bankAccountId: ids.bank, provider: 'razorpayx', accountRef: '2323230000001111', keyId: RZP_KEY, keySecret: RZP_SECRET, syncFrom: daysAgo(10) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    ids.feed = ok.json.id;
    const list = await api('GET', '/api/v1/books/feeds');
    expect(JSON.stringify(list.json)).not.toContain(RZP_SECRET);
    expect(list.json.feeds[0]).toMatchObject({ provider: 'razorpayx', accountRef: '••••1111', status: 'active' });
  });

  it('pulls new transactions once and hands them to the bookkeeper', async () => {
    const at = Math.floor(Date.parse(`${daysAgo(1)}T10:00:00+05:30`) / 1000);
    rzpItems = [
      { id: 'txn_A', credit: 0, debit: 5900, balance: 100000, created_at: at, source: { entity: 'payout', mode: 'IMPS', utr: 'UTR1', narration: 'SMS ALERT CHGS' } },
      { id: 'txn_B', credit: 25000, debit: 0, balance: 125000, created_at: at + 60, source: { entity: 'bank_transfer', mode: 'UPI', payer_name: 'Walk-in buyer', bank_reference: 'R9' } },
    ];
    const s = await api('POST', `/api/v1/books/feeds/${ids.feed}/sync`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ fetched: 2, added: 2 });
    // the SMS rule booked one straight away
    expect(s.json.bookkeeper).toMatchObject({ applied: 1 });
    const again = await api('POST', `/api/v1/books/feeds/${ids.feed}/sync`);
    expect(again.json).toMatchObject({ added: 0 });
    const txns = (await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/transactions?status=all`)).json as any[];
    expect(txns.filter((t) => t.source === 'feed')).toHaveLength(2);
    expect(rzpCalls.every((c) => c.query.account_number === '2323230000001111')).toBe(true);
  });

  it('books a Razorpay settlement as net to bank, fee and GST, against the gateway clearing', async () => {
    const i = await api('POST', '/api/admin/integrations/razorpay', { keyId: PG_KEY, keySecret: PG_SECRET, webhookSecret: 'whsecret123' });
    expect(i.status, JSON.stringify(i.json)).toBe(201);
    const hookPath = new URL(i.json.urls.webhook).pathname;
    const inv = await newInvoice('Online', 10000);
    expect((await api('POST', '/api/v1/payment-links', { invoiceId: inv.id })).status).toBe(201);
    const raw = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', status: 'paid' } }, payment: { entity: { id: 'pay_1', amount: 1180000, method: 'upi', vpa: 'x@okicici' } } } });
    const hook = await h.app.request(`http://synapse.test${hookPath}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': await hmacSha256Hex('whsecret123', raw) } }, h.env);
    expect(hook.status).toBe(200);
    const gl = async (key: string) => (await api('GET', `/api/v1/books/reports/general-ledger?accountId=${sysAcc[key]}&from=${fyStart}&to=${today}`)).json.closing as number;
    // the receipt waits in the clearing account, not the bank
    expect(await gl('gateway_clearing')).toBeCloseTo(11800, 2);

    // Razorpay pays out 11,800 less a 236 fee (200 + 36 GST)
    settlements = [{ id: 'setl_1', entity: 'settlement', amount: 1156400, fees: 23600, tax: 3600, utr: 'UTRX12345678', status: 'processed', created_at: Math.floor(Date.parse(`${daysAgo(1)}T09:00:00+05:30`) / 1000) }];
    const charges = await gl('bank_charges');
    const igst = await gl('input_igst');
    await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/statement`, { rows: [{ date: today, description: 'NEFT CR RAZORPAY SOFTWARE PVT LTD UTRX12345678', amount: 11564 }] });
    const run = await api('POST', '/api/v1/books/desk/run', { agents: ['bank_clerk', 'bookkeeper'] });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.bank_clerk).toMatchObject({ settlements: 1 });
    const applied = (await api('GET', '/api/v1/books/desk/proposals?status=applied')).json as any[];
    expect(applied.find((p) => p.kind === 'settlement')).toMatchObject({ source: 'gateway', applied_by: 'agent' });
    expect(await gl('gateway_clearing')).toBeCloseTo(0, 2);
    expect((await gl('bank_charges')) - charges).toBeCloseTo(200, 2);
    expect((await gl('input_igst')) - igst).toBeCloseTo(36, 2);
    expect((await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`)).json.totals.balanced).toBe(true);
  });

  it('runs the daily round on its own', async () => {
    const db = Db.fromEnv(h.env);
    try {
      await booksDailySweep(h.env, db, tenantId);
    } finally {
      await db.close();
    }
    const runs = (await api('GET', '/api/v1/books/desk/runs')).json as any[];
    expect(runs.filter((r) => r.trigger === 'schedule').map((r) => r.agent).sort()).toEqual(expect.arrayContaining(['bank_clerk', 'bookkeeper', 'compliance']));
  });
});
