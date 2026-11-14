import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { booksDailySweep } from '../src/services/books/sweep';
import { nextRun } from '../src/services/books/setup';
import { gstSetOff } from '../src/services/books/reports';
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
const SELLER = gstin('27AAACH1234M1Z');
const VENDOR = gstin('27AABCV5678P1Z');
const BUYER = gstin('29AACCS9012Q1Z');
const today = new Date().toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let mgr: ReturnType<typeof h.as>;
let acc: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let tenantId = '';
const sysAcc: Record<string, string> = {};

async function tb() {
  const r = await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.totals.balanced, JSON.stringify(r.json.totals)).toBe(true);
  return r.json;
}
async function balanceOf(key: string) {
  const r = await api('GET', `/api/v1/books/reports/general-ledger?accountId=${sysAcc[key]}&from=${fyStart}&to=${today}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.closing as number;
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_books');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  for (const a of ['orders', 'inventory', 'purchasing', 'billing']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Elvm Craft LLP', state: 'Maharashtra', gstin: SELLER, address: 'Andheri East, Mumbai' } } });
  for (const [email, role] of [['rep@acme.test', 'sales_rep'], ['mgr@acme.test', 'sales_manager']] as const) {
    const u = await api('POST', '/api/admin/users', { email, fullName: email.split('@')[0], password: PW, roles: [role] });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
  }
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  mgr = h.as('acme', (await h.login('acme', 'mgr@acme.test')).token);
  ids.vendor = (await api('POST', '/api/v1/records/vendor', { name: 'Sai Plywood', gstin: VENDOR, state: 'Maharashtra', payment_terms_days: 30, pan: 'AABCV5678P' })).json.id;
  ids.customer = (await api('POST', '/api/v1/records/account', { name: 'Sharma Homes', gstin: BUYER, state: 'Karnataka', city: 'Bengaluru' })).json.id;
  ids.ply = (await api('POST', '/api/v1/records/product', { name: 'Plywood 18mm', hsn_sac: '4412', tax_rate: 18, list_price: 3000, unit: 'Nos', product_type: 'goods', track_inventory: true })).json.id;
}, 120_000);

describe('switching books on', () => {
  it('needs billing and purchasing, then creates the chart', async () => {
    const r = await api('POST', '/api/admin/apps/books/enable');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const s = await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart, tan: 'MUMA12345B' });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.config).toMatchObject({ enabled: true, books_of_record: 'synapse', tan: 'MUMA12345B' });
    expect(s.json.accounts).toBeGreaterThan(60);
    const accts = (await api('GET', '/api/v1/books/accounts')).json as any[];
    for (const a of accts) if (a.system_key) sysAcc[a.system_key] = a.id;
    expect(sysAcc.ar && sysAcc.ap && sysAcc.input_cgst && sysAcc.tds_payable).toBeTruthy();
  });

  it('keeps books screens to people with the books permission', async () => {
    expect((await rep('GET', '/api/v1/books/reports/trial-balance')).status).toBe(403);
    expect((await rep('GET', '/api/v1/books/accounts')).status).toBe(403);
    expect((await rep('PUT', '/api/v1/books/settings', { enabled: false })).status).toBe(403);
    expect((await rep('GET', '/api/v1/books/expense-categories')).status).toBe(200);
  });
});

describe('bills and vendor payments', () => {
  it('posts a bill with ITC and TDS; the ledger balances', async () => {
    const b = await api('POST', '/api/v1/records/bill', { name: 'Plywood lot', vendor_id: ids.vendor, vendor_ref: 'SP/101', tds_section: '194C', bill_date: today });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    ids.bill = b.json.id;
    expect(b.json.due_date).toBeTruthy();
    const l = await api('PUT', `/api/v1/books/bills/${ids.bill}/lines`, { lines: [{ productId: ids.ply, name: 'Plywood 18mm', hsnSac: '4412', quantity: 4, unitPrice: 2500, taxRate: 18, unit: 'Nos' }] });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    expect(l.json.bill).toMatchObject({ taxable_total: 10000, cgst_total: 900, sgst_total: 900, grand_total: 11800, tds_amount: 200, balance_due: 11600 });
    const p = await api('POST', `/api/v1/books/bills/${ids.bill}/post`);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.bill.status).toBe('open');
    expect(p.json.bill.bill_number).toMatch(/^BILL\/\d{2}-\d{2}\/0001$/);
    expect(p.json.journalId).toBeTruthy();
    const j = await api('GET', `/api/v1/books/journals/${p.json.journalId}`);
    const dr = j.json.lines.reduce((s: number, x: any) => s + x.debit, 0);
    const cr = j.json.lines.reduce((s: number, x: any) => s + x.credit, 0);
    expect(dr).toBeCloseTo(11800, 2);
    expect(cr).toBeCloseTo(11800, 2);
    expect(await balanceOf('ap')).toBeCloseTo(11600, 2);
    expect(await balanceOf('tds_payable')).toBeCloseTo(200, 2);
    expect(await balanceOf('input_cgst')).toBeCloseTo(900, 2);
    await tb();
    // the same vendor bill number cannot be entered twice
    const dup = await api('POST', '/api/v1/records/bill', { name: 'Again', vendor_id: ids.vendor, vendor_ref: 'SP/101' });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    // posted bills cannot change
    expect((await api('PUT', `/api/v1/books/bills/${ids.bill}/lines`, { lines: [] })).status).toBe(400);
  });

  it('pays the bill; the payable clears', async () => {
    const r = await api('POST', '/api/v1/books/vendor-payments', { vendorId: ids.vendor, amount: 11600, date: today, mode: 'bank_transfer', reference: 'NEFT-1', allocations: 'auto' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.vpay = r.json.id;
    const b = await api('GET', `/api/v1/books/bills/${ids.bill}`);
    expect(b.json.bill).toMatchObject({ status: 'paid', balance_due: 0, amount_paid: 11600 });
    expect(await balanceOf('ap')).toBeCloseTo(0, 2);
    expect(await balanceOf('bank')).toBeCloseTo(-11600, 2);
    await tb();
  });

  it('voiding the payment re-opens the bill and reverses the entry', async () => {
    expect((await api('POST', `/api/v1/books/vendor-payments/${ids.vpay}/void`, { reason: 'Bounced' })).status).toBe(200);
    expect((await api('GET', `/api/v1/books/bills/${ids.bill}`)).json.bill.status).toBe('open');
    expect(await balanceOf('bank')).toBeCloseTo(0, 2);
    const again = await api('POST', '/api/v1/books/vendor-payments', { vendorId: ids.vendor, amount: 11600, date: today, allocations: 'auto' });
    expect(again.status).toBe(201);
  });
});

describe('sales side', () => {
  it('an issued invoice posts revenue, output tax and cost of goods; a receipt with TDS clears it', async () => {
    const inv = await api('POST', '/api/v1/records/invoice', { name: 'Plywood supply', account_id: ids.customer });
    ids.inv = inv.json.id;
    await api('PUT', `/api/v1/invoices/${ids.inv}/lines`, { lines: [{ productId: ids.ply, name: 'Plywood 18mm', hsnSac: '4412', quantity: 2, unitPrice: 4000, taxRate: 18, unit: 'Nos' }] });
    const i = await api('POST', `/api/v1/invoices/${ids.inv}/issue`);
    expect(i.status, JSON.stringify(i.json)).toBe(200);
    expect(i.json.invoice.igst_total).toBe(1440);
    expect(await balanceOf('ar')).toBeCloseTo(9440, 2);
    expect(await balanceOf('output_igst')).toBeCloseTo(1440, 2);
    expect(await balanceOf('cogs')).toBeCloseTo(5000, 2); // 2 × moving average 2500
    const p = await api('POST', '/api/v1/payments', { accountId: ids.customer, amount: 9440, date: today, mode: 'bank_transfer', tdsAmount: 160, bankCharges: 10, allocations: 'auto' });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    expect(await balanceOf('ar')).toBeCloseTo(0, 2);
    expect(await balanceOf('tds_receivable')).toBeCloseTo(160, 2);
    expect(await balanceOf('bank_charges')).toBeCloseTo(10, 2);
    await tb();
  });

  it('writes off what is left on an invoice as a bad debt', async () => {
    const inv = await api('POST', '/api/v1/records/invoice', { name: 'Small job', account_id: ids.customer });
    await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name: 'Polish', hsnSac: '998719', quantity: 1, unitPrice: 1000, taxRate: 18 }] });
    await api('POST', `/api/v1/invoices/${inv.json.id}/issue`);
    expect((await rep('POST', `/api/v1/books/invoices/${inv.json.id}/write-off`, { reason: 'Customer closed' })).status).toBe(403);
    const w = await api('POST', `/api/v1/books/invoices/${inv.json.id}/write-off`, { reason: 'Customer closed' });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const g = await api('GET', `/api/v1/invoices/${inv.json.id}`);
    expect(g.json.invoice).toMatchObject({ status: 'paid', balance_due: 0 });
    expect(await balanceOf('bad_debts')).toBeCloseTo(1180, 2);
    expect(await balanceOf('ar')).toBeCloseTo(0, 2);
    await tb();
  });
});

describe('expenses and claims', () => {
  it('a rep files a claim, cannot approve it; the manager approves; the books admin reimburses', async () => {
    const e = await rep('POST', '/api/v1/records/expense', { name: 'Client lunch', amount: 1180, amount_is_inclusive: true, tax_rate: 18, supply_type: 'intra', is_claim: true, itc_eligible: true, expense_date: today });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    ids.claim = e.json.id;
    expect(e.json).toMatchObject({ status: 'draft', taxable_amount: 1000, tax_amount: 180, total: 1180 });
    const cats = (await rep('GET', '/api/v1/books/expense-categories')).json as any[];
    const meals = cats.find((c) => c.name.toLowerCase().includes('meal'));
    expect((await rep('PUT', `/api/v1/books/expenses/${ids.claim}/accounts`, { accountId: meals.id, paidThroughId: null })).status).toBe(200);
    expect((await rep('POST', `/api/v1/books/expenses/${ids.claim}/submit`, {})).status).toBe(200);
    expect((await rep('POST', `/api/v1/books/expenses/${ids.claim}/approve`, {})).status).toBe(403);
    // cannot edit once submitted? (the amount trigger locks after approval)
    // a sales manager approves their team's claims only (the rep is not in their team)
    expect((await mgr('POST', `/api/v1/books/expenses/${ids.claim}/approve`, {})).status).toBe(404);
    const a = await api('POST', `/api/v1/books/expenses/${ids.claim}/approve`, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(await balanceOf('employee_payable')).toBeCloseTo(1180, 2);
    expect((await rep('PATCH', `/api/v1/records/expense/${ids.claim}`, { amount: 5000 })).status).toBeGreaterThanOrEqual(400);
    expect((await rep('POST', `/api/v1/books/expenses/${ids.claim}/reimburse`, {})).status).toBe(403);
    const r = await api('POST', `/api/v1/books/expenses/${ids.claim}/reimburse`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await balanceOf('employee_payable')).toBeCloseTo(0, 2);
    const notes = await rep('GET', '/api/v1/notifications');
    expect(JSON.stringify(notes.json)).toContain('Client lunch');
    await tb();
  });

  it('a rep cannot see other people\'s expenses', async () => {
    const own = await api('POST', '/api/v1/records/expense', { name: 'Courier', amount: 300, is_claim: false, expense_date: today });
    expect(own.status).toBe(201);
    expect((await rep('GET', `/api/v1/records/expense/${own.json.id}`)).status).toBe(404);
    const rec = await api('POST', `/api/v1/books/expenses/${own.json.id}/record`, {});
    expect(rec.status, JSON.stringify(rec.json)).toBe(200);
    await tb();
  });
});

describe('review hardening', () => {
  it('keeps money postings with the right people and checks their accounts', async () => {
    // sales reps cannot raise bills or pay vendors
    expect((await rep('POST', '/api/v1/records/bill', { name: 'x', vendor_id: ids.vendor })).status).toBe(403);
    expect((await rep('POST', '/api/v1/books/vendor-payments', { vendorId: ids.vendor, amount: 10 })).status).toBe(403);
    // receipts: deposit account must be bank or cash, and TDS etc. need the billing or books permission
    const cust = ids.customer;
    expect((await api('POST', '/api/v1/payments', { accountId: cust, amount: 100, depositAccountId: sysAcc.capital })).status).toBe(400);
    expect((await api('POST', '/api/v1/payments', { accountId: cust, amount: 100, tdsAmount: 90, bankCharges: 20 })).status).toBe(400);
    // a foreign-currency payment cannot settle an INR bill
    const b = await api('POST', '/api/v1/records/bill', { name: 'Hinges', vendor_id: ids.vendor, vendor_ref: 'SP/300', bill_date: today });
    await api('PUT', `/api/v1/books/bills/${b.json.id}/lines`, { lines: [{ name: 'Hinges', quantity: 1, unitPrice: 100, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/books/bills/${b.json.id}/post`)).status).toBe(200);
    const fx = await api('POST', '/api/v1/books/vendor-payments', { vendorId: ids.vendor, amount: 100, currency: 'USD', exchangeRate: 1000000, allocations: [{ billId: b.json.id, amount: 100 }] });
    expect(fx.status).toBe(400);
    // payments and vendor payments are not plain records, and posted ones do not change or merge
    expect((await api('POST', '/api/v1/records/vendor_payment', { name: 'x', vendor_id: ids.vendor, amount: 5 })).status).toBe(400);
    expect((await api('POST', '/api/v1/records/payment', { name: 'x', account_id: cust, amount: 5 })).status).toBe(400);
    const vp = await api('POST', '/api/v1/books/vendor-payments', { vendorId: ids.vendor, amount: 50, date: today });
    expect((await api('PATCH', `/api/v1/records/vendor_payment/${vp.json.id}`, { amount: 5000 })).status).toBe(400);
    expect((await api('POST', '/api/v1/records/bill/merge', { masterId: b.json.id, duplicateIds: [ids.bill] })).status).toBe(400);
    expect((await api('DELETE', `/api/v1/records/bill/${b.json.id}`)).status).toBe(400);
    // a payables summary is for the books team
    expect((await rep('GET', '/api/v1/books/payables')).status).toBe(403);
    expect((await rep('GET', '/api/v1/books/recurring')).status).toBe(403);
    // impossible dates are refused cleanly
    expect((await api('POST', '/api/v1/books/journals', { date: '2025-13-45', lines: [{ accountId: sysAcc.rent, debit: 1 }, { accountId: sysAcc.cash, credit: 1 }] })).status).toBe(400);
    await tb();
  });

  it('company-paid expenses by a rep go through approval and post only to expense categories', async () => {
    const e = await rep('POST', '/api/v1/records/expense', { name: 'Taxi', amount: 500, is_claim: false, expense_date: today });
    expect(e.status).toBe(201);
    expect((await rep('PUT', `/api/v1/books/expenses/${e.json.id}/accounts`, { accountId: sysAcc.inventory, paidThroughId: null })).status).toBe(400);
    expect((await rep('PUT', `/api/v1/books/expenses/${e.json.id}/accounts`, { accountId: sysAcc.travel, paidThroughId: null })).status).toBe(200);
    expect((await rep('POST', `/api/v1/books/expenses/${e.json.id}/record`, {})).status).toBe(403);
    expect((await rep('POST', `/api/v1/books/expenses/${e.json.id}/submit`, {})).status).toBe(200);
    // once submitted, nothing about it can change
    expect((await rep('PATCH', `/api/v1/records/expense/${e.json.id}`, { amount: 5 })).status).toBe(400);
    const ok = await api('POST', `/api/v1/books/expenses/${e.json.id}/approve`, {});
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await api('GET', `/api/v1/records/expense/${e.json.id}`)).json.status).toBe('recorded');
    // nobody approves what they filed, even in someone else's name
    const c = await api('POST', '/api/v1/records/expense', { name: 'Hotel', amount: 900, is_claim: true, expense_date: today });
    const me = (await api('GET', '/api/auth/me')).json;
    const repId = (await rep('GET', '/api/auth/me')).json.user.id;
    expect(me.user.id).not.toBe(repId);
    await api('PATCH', `/api/v1/records/expense/${c.json.id}`, { owner_id: repId });
    expect((await api('POST', `/api/v1/books/expenses/${c.json.id}/submit`, {})).status).toBe(200);
    expect((await api('POST', `/api/v1/books/expenses/${c.json.id}/approve`, {})).status).toBe(403);
    await tb();
  });
});

describe('manual journals and controls', () => {
  it('refuses unbalanced or receivable lines without a party; posts, reverses and voids', async () => {
    expect((await api('POST', '/api/v1/books/journals', { date: today, lines: [{ accountId: sysAcc.rent, debit: 100 }, { accountId: sysAcc.cash, credit: 90 }] })).status).toBe(400);
    expect((await api('POST', '/api/v1/books/journals', { date: today, lines: [{ accountId: sysAcc.ar, debit: 100 }, { accountId: sysAcc.sales, credit: 100 }] })).status).toBe(400);
    const j = await api('POST', '/api/v1/books/journals', { date: today, narration: 'Office rent', lines: [{ accountId: sysAcc.rent, debit: 25000 }, { accountId: sysAcc.bank, credit: 25000 }] });
    expect(j.status, JSON.stringify(j.json)).toBe(201);
    const got = await api('GET', `/api/v1/books/journals/${j.json.id}`);
    expect(got.json.number).toMatch(/^JV\/\d{2}-\d{2}\/\d{4}$/);
    const rev = await api('POST', `/api/v1/books/journals/${j.json.id}/reverse`, { date: today });
    expect(rev.status).toBe(201);
    expect(await balanceOf('rent')).toBeCloseTo(0, 2);
    expect((await api('POST', `/api/v1/books/journals/${rev.json.id}/void`, { reason: 'Mistake' })).status).toBe(200);
    expect(await balanceOf('rent')).toBeCloseTo(25000, 2);
    // a document's journal is voided through the document only
    const billJ = (await api('GET', `/api/v1/books/bills/${ids.bill}`)).json.journalId;
    expect((await api('POST', `/api/v1/books/journals/${billJ}/void`, { reason: 'x x x' })).status).toBe(400);
    await tb();
  });

  it('the database refuses edits and deletes of posted lines', async () => {
    const db = new Db(h.env.DATABASE_URL!);
    try {
      const err = await db.tx({ tenantId }, (tx) => tx.query(`update journal_lines set debit = debit + 1 where tenant_id = $1`, [tenantId])).catch((e) => e as Error);
      expect(String(err)).toMatch(/cannot be changed|permission denied/);
      const del = await db.tx({ tenantId }, (tx) => tx.query(`delete from journals where tenant_id = $1`, [tenantId])).catch((e) => e as Error);
      expect(String(del)).toMatch(/cannot be deleted|permission denied/);
      const unbal = await db
        .tx({ tenantId }, async (tx) => {
          const j = await tx.one<{ id: string }>(`insert into journals (tenant_id, entry_date, source_type) values ($1, current_date, 'manual') returning id`, [tenantId]);
          await tx.query(`insert into journal_lines (tenant_id, journal_id, account_id, debit, entry_date) values ($1,$2,$3,10,current_date)`, [tenantId, j!.id, sysAcc.rent]);
        })
        .catch((e) => e as Error);
      expect(String(unbal)).toMatch(/does not balance/);
    } finally {
      await db.close();
    }
  });

  it('the lock date stops back-dated entries', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect((await api('PUT', '/api/v1/books/settings', { lockDate: yesterday })).status).toBe(200);
    const r = await api('POST', '/api/v1/books/journals', { date: yesterday, lines: [{ accountId: sysAcc.rent, debit: 1 }, { accountId: sysAcc.cash, credit: 1 }] });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(/locked/);
    expect((await api('PUT', '/api/v1/books/settings', { lockDate: null })).status).toBe(200);
    // the start date cannot move once documents are posted
    expect((await api('PUT', '/api/v1/books/settings', { startDate: '2020-04-01' })).status).toBe(400);
  });
});

describe('banking', () => {
  it('imports a statement once, matches, categorises and reconciles', async () => {
    const list = (await api('GET', '/api/v1/books/bank-accounts')).json as any[];
    const bank = list.find((b) => b.gl_account_id === sysAcc.bank);
    ids.bank = bank.id;
    const rows = [
      { date: today, description: 'NEFT SAI PLYWOOD', reference: 'NEFT-2', amount: -11600 },
      { date: today, description: 'BANK CHG GST', amount: -59 },
      { date: today, description: 'INTEREST CREDIT', amount: 42.5 },
    ];
    const imp = await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/statement`, { rows });
    expect(imp.json).toMatchObject({ added: 3, autoMatched: 1 });
    expect(imp.status, JSON.stringify(imp.json)).toBe(200);
    const again = await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/statement`, { rows });
    expect(again.json).toMatchObject({ added: 0, skipped: 3 });
    // a rule for interest
    expect((await api('POST', '/api/v1/books/bank-rules', { name: 'Interest', direction: 'in', contains: 'interest', accountId: sysAcc.interest_income })).status).toBe(201);
    const auto = await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/auto`);
    expect(auto.status, JSON.stringify(auto.json)).toBe(200);
    expect(auto.json.categorized).toBe(1);
    const open = (await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/transactions?status=unmatched`)).json as any[];
    expect(open).toHaveLength(1);
    const c = await api('POST', `/api/v1/books/bank-transactions/${open[0].id}/categorize`, { accountId: sysAcc.bank_charges });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    await tb();
    const un = await api('GET', `/api/v1/books/bank-accounts/${ids.bank}/unreconciled?upTo=${today}`);
    const lines = un.json.lines as any[];
    const book = lines.reduce((s, l) => s + l.debit - l.credit, 0);
    const bad = await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/reconcile`, { statementDate: today, closingBalance: book + 1, lineIds: lines.map((l) => l.id) });
    expect(bad.status).toBe(400);
    const ok = await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/reconcile`, { statementDate: today, closingBalance: Math.round(book * 100) / 100, lineIds: lines.map((l) => l.id) });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await api('POST', `/api/v1/books/bank-accounts/${ids.bank}/undo-reconciliation`)).status).toBe(200);
  });

  it('transfers between accounts', async () => {
    const t = await api('POST', '/api/v1/books/transfers', { fromId: sysAcc.bank, toId: sysAcc.petty_cash, amount: 5000, date: today });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    expect(await balanceOf('petty_cash')).toBeCloseTo(5000, 2);
  });
});

describe('reports', () => {
  it('balance sheet balances; P&L and cash flow add up', async () => {
    const bs = await api('GET', `/api/v1/books/reports/balance-sheet?to=${today}`);
    expect(bs.status, JSON.stringify(bs.json)).toBe(200);
    expect(bs.json.totals.balanced, JSON.stringify(bs.json.totals)).toBe(true);
    const pl = await api('GET', `/api/v1/books/reports/profit-and-loss?from=${fyStart}&to=${today}`);
    expect(pl.status).toBe(200);
    const eq = bs.json.groups.find((g: any) => g.key === 'equity');
    expect(eq.accounts.find((a: any) => a.id === 'current_year').amount).toBeCloseTo(pl.json.netProfit, 2);
    const cf = await api('GET', `/api/v1/books/reports/cash-flow?from=${fyStart}&to=${today}`);
    expect(cf.status).toBe(200);
    const cash = (await balanceOf('bank')) + (await balanceOf('cash')) + (await balanceOf('petty_cash'));
    expect(cf.json.closingCash).toBeCloseTo(cash, 2);
    expect(cf.json.other).toBeCloseTo(0, 2);
  });

  it('GSTR-3B nets output tax against input credit', async () => {
    const g = await api('GET', `/api/v1/books/reports/gstr-3b?month=${today.slice(0, 7)}`);
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json.outward.igst).toBeCloseTo(1440 + 180, 2);
    expect(g.json.itc.total.cgst).toBeCloseTo(900 + 90 + 9, 2); // plywood bill, lunch claim, hinges bill
    // IGST liability 1620 is set off by CGST credit (999) and then SGST credit (621); 378 SGST credit is carried forward
    expect(g.json.payableInCash).toEqual({ igst: 0, cgst: 0, sgst: 0 });
    expect(g.json.creditCarriedForward).toEqual({ igst: 0, cgst: 0, sgst: 378 });
    // IGST credit goes where CGST/SGST credit falls short
    expect(gstSetOff({ igst: 0, cgst: 100, sgst: 100 }, { igst: 100, cgst: 100, sgst: 0 }).due).toEqual({ igst: 0, cgst: 0, sgst: 0 });
    // CGST credit never pays SGST
    expect(gstSetOff({ igst: 0, cgst: 0, sgst: 100 }, { igst: 0, cgst: 100, sgst: 0 }).due).toEqual({ igst: 0, cgst: 0, sgst: 100 });
  });

  it('TDS, statements, day book and CSV export', async () => {
    const t = await api('GET', `/api/v1/books/reports/tds?from=${fyStart}&to=${today}`);
    expect(t.json.bySection).toEqual([{ section: '194C', tds: 200 }]);
    expect(t.json.receivable[0].tds).toBe(160);
    const s = await api('GET', `/api/v1/books/reports/vendor-statement?partyId=${ids.vendor}&from=${fyStart}&to=${today}`);
    expect(s.status).toBe(200);
    expect(s.json.closing).toBeCloseTo(118 - 50, 2); // the hinges bill less an unapplied advance
    const csv = await api('GET', `/api/v1/books/reports/day-book?from=${fyStart}&to=${today}&format=csv`, undefined, { raw: true });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('account');
    const ov = await api('GET', '/api/v1/books/overview');
    expect(ov.status, JSON.stringify(ov.json)).toBe(200);
  });
});

describe('assets, budgets, GSTR-2B, recurring, opening balances', () => {
  it('depreciates an asset month by month and disposes of it', async () => {
    const a = await api('POST', '/api/v1/books/assets', { name: 'CNC router', purchaseDate: fyStart, cost: 120000, method: 'slm', lifeMonths: 60, paidThroughId: sysAcc.bank });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const d = await api('POST', '/api/v1/books/assets/depreciate', { upTo: today });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const months = (Number(today.slice(0, 4)) - Number(fyStart.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - 4 + 1;
    expect(d.json.total).toBeCloseTo(2000 * months, 2);
    const again = await api('POST', '/api/v1/books/assets/depreciate', { upTo: today });
    expect(again.json.total).toBe(0);
    // undoing the run puts the asset back; running again charges the same
    expect((await api('POST', `/api/v1/books/journals/${d.json.journalId}/void`, { reason: 'Wrong rate' })).status).toBe(200);
    const reg = (await api('GET', '/api/v1/books/assets')).json as any[];
    expect(reg[0]).toMatchObject({ accumulated: 0, depreciated_to: null });
    const third = await api('POST', '/api/v1/books/assets/depreciate', { upTo: today });
    expect(third.json.total).toBeCloseTo(2000 * months, 2);
    // a disposal before the depreciated month is refused
    expect((await api('POST', `/api/v1/books/assets/${a.json.id}/dispose`, { date: fyStart, amount: 1 })).status).toBe(400);
    const x = await api('POST', `/api/v1/books/assets/${a.json.id}/dispose`, { date: today, amount: 50000 });
    expect(x.status, JSON.stringify(x.json)).toBe(200);
    await tb();
    const bs = await api('GET', `/api/v1/books/reports/balance-sheet?to=${today}`);
    expect(bs.json.totals.balanced).toBe(true);
  });

  it('budget vs actual', async () => {
    const fy = `${fyStart.slice(0, 4)}-${String((Number(fyStart.slice(0, 4)) + 1) % 100).padStart(2, '0')}`;
    const b = await api('POST', '/api/v1/books/budgets', { name: 'Overheads', financialYear: fy, lines: [{ accountId: sysAcc.rent, months: Array(12).fill(20000) }] });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const r = await api('GET', `/api/v1/books/reports/budget-vs-actual?budgetId=${b.json.id}`);
    expect(r.json.rows[0]).toMatchObject({ budgetTotal: 240000, actualTotal: 25000 });
  });

  it('matches GSTR-2B against bills', async () => {
    const period = `${today.slice(5, 7)}${today.slice(0, 4)}`;
    const g = await api('POST', '/api/v1/books/gstr-2b', {
      period,
      rows: [
        { supplierGstin: VENDOR, docNumber: 'sp-101', taxable: 10000, cgst: 900, sgst: 900 },
        { supplierGstin: VENDOR, docNumber: 'SP/999', taxable: 500, cgst: 45, sgst: 45 },
      ],
    });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json).toMatchObject({ matched: 1, unmatched: 1 });
    const r = await api('GET', `/api/v1/books/reports/gstr-2b?period=${period}`);
    expect(r.json.missingInGstr2b.map((b: any) => b.vendor_ref)).toEqual(['SP/300']);
  });

  it('recurring journals run on schedule', async () => {
    expect(nextRun('2026-01-31', 'monthly')).toBe('2026-02-28');
    expect(nextRun('2026-01-15', 'quarterly')).toBe('2026-04-15');
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const p = await api('POST', '/api/v1/books/recurring', { name: 'Rent', kind: 'journal', frequency: 'monthly', startDate: yesterday, template: { lines: [{ accountId: sysAcc.rent, debit: 1000 }, { accountId: sysAcc.bank, credit: 1000 }] } });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const before = await balanceOf('rent');
    const db = new Db(h.env.DATABASE_URL!);
    try {
      const r = await booksDailySweep(h.env, db, tenantId);
      expect(r.created).toBe(1);
    } finally {
      await db.close();
    }
    expect(await balanceOf('rent')).toBeCloseTo(before + 1000, 2);
    const list = (await api('GET', '/api/v1/books/recurring')).json as any[];
    expect(list[0]).toMatchObject({ runs: 1 });
    expect(list[0].next_date > today || String(list[0].next_date).slice(0, 10) > today).toBe(true);
  });

  it('opening balances go in the day before the start date, balanced by opening equity', async () => {
    const o = await api('PUT', '/api/v1/books/opening-balances', { accounts: [{ accountId: sysAcc.cash, debit: 15000 }, { accountId: sysAcc.loans, credit: 100000 }], customers: [{ partyId: ids.customer, amount: 50000 }], vendors: [{ partyId: ids.vendor, amount: 20000 }] });
    expect(o.status, JSON.stringify(o.json)).toBe(200);
    expect(o.json.date < fyStart).toBe(true);
    await tb();
    const bs = await api('GET', `/api/v1/books/reports/balance-sheet?to=${today}`);
    expect(bs.json.totals.balanced).toBe(true);
    // re-entering replaces, not adds
    await api('PUT', '/api/v1/books/opening-balances', { accounts: [{ accountId: sysAcc.cash, debit: 15000 }] });
    const ar = await api('GET', `/api/v1/books/reports/general-ledger?accountId=${sysAcc.ar}&from=${fyStart}&to=${today}`);
    expect(ar.json.opening).toBeCloseTo(0, 2);
  });
});

describe('Tally as the books of record', () => {
  it('stops posting journals; documents still work', async () => {
    expect((await api('PUT', '/api/v1/books/settings', { booksOfRecord: 'tally' })).status).toBe(200);
    const before = ((await api('GET', `/api/v1/books/journals?limit=500`)).json as any[]).length;
    const e = await api('POST', '/api/v1/records/expense', { name: 'Tea', amount: 100, expense_date: today });
    expect((await api('POST', `/api/v1/books/expenses/${e.json.id}/record`, {})).status).toBe(200);
    const after = ((await api('GET', `/api/v1/books/journals?limit=500`)).json as any[]).length;
    expect(after).toBe(before);
  });
});
