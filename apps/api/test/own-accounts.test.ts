import { beforeAll, describe, expect, it } from 'vitest';
import { findOwn, identMatches, matchKey } from '../src/services/books/own-accounts';
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
const SELLER = gstin('09AASFH6805J1Z'); // an LLP: the PAN's 4th letter is F
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

describe('reading identifiers', () => {
  it('normalises what people type', () => {
    expect(matchKey('mobile', '+91 93114-21118')).toBe('9311421118');
    expect(matchKey('mobile', '09311421118')).toBe('9311421118');
    expect(() => matchKey('mobile', '12345')).toThrow();
    expect(matchKey('upi', ' Prashant@YBL ')).toBe('prashant@ybl');
    expect(matchKey('account', '5020 0012 345678')).toBe('50200012345678');
    expect(matchKey('name', 'prashant k. srivastava')).toBe('PRASHANT K SRIVASTAVA');
  });
  it('finds a mobile number only where it stands alone', () => {
    const m = { kind: 'mobile' as const, match_key: '9311421118' };
    expect(identMatches(m, 'UPI/CR/432112345678/PRASHANT/YESB/9311421118@ybl/Pay')).toBe(true);
    expect(identMatches(m, 'IMPS/P2A/919311421118/Self')).toBe(true);
    expect(identMatches(m, 'MOB 93114 21118')).toBe(false);
    expect(identMatches(m, 'REF 19311421118')).toBe(false);
    expect(identMatches(m, 'REF 93114211185')).toBe(false);
    expect(identMatches({ kind: 'account', match_key: '50200012345678' }, 'NEFT TO 5020-0012-345678 SELF')).toBe(true);
    expect(identMatches({ kind: 'name', match_key: 'RAHUL VERMA' }, 'NEFT CR RAHUL VERMA HDFC')).toBe(true);
    expect(identMatches({ kind: 'name', match_key: 'RAHUL VERMA' }, 'NEFT CR RAHUL VERMAN')).toBe(false);
  });
  it('prefers numbers to names and ignores an account naming itself', () => {
    const own = {
      persons: [
        { id: 'p1', name: 'Prashant', role: 'partner' as const, account_in: 'a1', account_out: 'a1', is_active: true },
        { id: 'p2', name: 'Rahul', role: 'partner' as const, account_in: 'a2', account_out: 'a2', is_active: true },
      ],
      idents: [
        { id: 'i1', person_id: 'p2', bank_account_id: null, kind: 'name' as const, value: 'Prashant', match_key: 'PRASHANT' },
        { id: 'i2', person_id: 'p1', bank_account_id: null, kind: 'mobile' as const, value: '9311421118', match_key: '9311421118' },
        { id: 'i3', person_id: null, bank_account_id: 'b2', kind: 'account' as const, value: '111122223333', match_key: '111122223333' },
      ],
      banks: [{ id: 'b1', gl_account_id: 'g1', name: 'Yes Bank' }, { id: 'b2', gl_account_id: 'g2', name: 'HDFC' }],
    };
    expect(findOwn(own, { bank_account_id: 'b1', description: 'UPI/PRASHANT/9311421118@ybl' })).toMatchObject({ type: 'person', person: { id: 'p1' } });
    expect(findOwn(own, { bank_account_id: 'b1', description: 'NEFT 111122223333' })).toMatchObject({ type: 'company', bank: { id: 'b2' } });
    expect(findOwn(own, { bank_account_id: 'b2', description: 'INT CR 111122223333' })).toBeNull();
  });
});

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids = {} as Record<'yes' | 'hdfc' | 'hdfcGl' | 'prashantLedger', string>;
const sysAcc: Record<string, string> = {};
const statement = (bank: string, rows: { date: string; description: string; amount: number }[]) => api('POST', `/api/v1/books/bank-accounts/${bank}/statement`, { rows, toDesk: true });
const txns = async (bank: string) => (await api('GET', `/api/v1/books/bank-accounts/${bank}/transactions?status=all`)).json as any[];
const tb = async () => (await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`)).json;
const balanceOf = async (id: string) => {
  const r = (await tb()).rows.find((x: any) => x.id === id);
  return r ? r.credit - r.debit : 0;
};

beforeAll(async () => {
  h = await makeHarness('synapse_test_own');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sysAcc[a.system_key] = a.id;
  ids.yes = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((x) => x.gl_account_id === sysAcc.bank).id;
  const hd = await api('POST', '/api/v1/books/bank-accounts', { name: 'HDFC Current', kind: 'bank' });
  ids.hdfc = hd.json.id;
  ids.hdfcGl = hd.json.glAccountId;
}, 120_000);

describe('own accounts on the accounts desk', () => {
  it('books money to and from a partner by their mobile number, to their own current account', async () => {
    const p = await api('POST', '/api/v1/books/desk/own/persons', { name: 'Prashant', identifiers: [{ kind: 'mobile', value: '9311421118' }, { kind: 'upi', value: 'prashant@okaxis' }] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const list = (await api('GET', '/api/v1/books/desk/own')).json;
    expect(list.defaultRole).toBe('partner');
    const person = list.persons[0];
    expect(person).toMatchObject({ name: 'Prashant', role: 'partner', account_in_name: "Prashant — partner's current account" });
    expect(person.account_in).toBe(person.account_out);
    ids.prashantLedger = person.account_in;

    const r = await statement(ids.yes, [
      { date: daysAgo(4), description: 'UPI/CR/432112345678/PRASHANT K/YESB/9311421118@ybl/capital', amount: 50000 },
      { date: daysAgo(3), description: 'IMPS/P2A/611234567890/919311421118/Self', amount: -20000 },
      { date: daysAgo(3), description: 'UPI/DR/499999999999/PRASHANT/prashant@okaxis/salary', amount: -5000 },
      { date: daysAgo(2), description: 'UPI/DR/412345678901/ZOMATO/93114211189@paytm', amount: -300 },
    ]);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const t = await txns(ids.yes);
    for (const d of ['capital', 'Self', 'salary']) expect(t.find((x) => x.description.includes(d)).status, d).toBe('categorized');
    expect(t.find((x) => x.description.includes('ZOMATO')).status).toBe('unmatched');
    expect(await balanceOf(ids.prashantLedger)).toBe(25000);
    expect((await tb()).totals.balanced).toBe(true);
  });

  it('books a transfer to another company account once, and the other side matches it', async () => {
    const s = await api('PUT', `/api/v1/books/desk/own/banks/${ids.hdfc}`, { identifiers: [{ kind: 'account', value: '50200012345678' }] });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    await statement(ids.yes, [{ date: daysAgo(2), description: 'NEFT DR TO 50200012345678 HDFC0001234 FUNDS', amount: -100000 }]);
    const out = (await txns(ids.yes)).find((x) => x.description.includes('50200012345678'));
    expect(out.status).toBe('categorized');
    await statement(ids.hdfc, [{ date: daysAgo(1), description: 'NEFT CR FROM HRP AI LLP YESB', amount: 100000 }]);
    // no identifier on this side: the matching entry already booked on HDFC is found by amount and date
    const q = (await api('GET', '/api/v1/books/desk/proposals')).json as any[];
    const inn = (await txns(ids.hdfc))[0];
    const prop = q.find((p) => p.bank_txn_id === inn.id || p.description?.includes('NEFT CR FROM'));
    if (inn.status !== 'matched') {
      expect(prop).toMatchObject({ kind: 'match', source: 'ledger' });
      expect((await api('POST', `/api/v1/books/desk/proposals/${prop.id}`, { decision: 'approve' })).status).toBe(200);
    }
    expect((await txns(ids.hdfc))[0].status).toBe('matched');
    expect(await balanceOf(ids.hdfcGl)).toBe(-100000); // a debit balance of ₹1,00,000
    expect((await tb()).totals.balanced).toBe(true);
  });

  it('suggests a transfer between company accounts by amount, and waits for approval', async () => {
    await statement(ids.hdfc, [{ date: daysAgo(1), description: 'IMPS TRANSFER TO OWN AC', amount: -7000 }]);
    await statement(ids.yes, [{ date: today, description: 'IMPS CR 611111 HDFC', amount: 7000 }]);
    const q = (await api('GET', '/api/v1/books/desk/proposals')).json as any[];
    const p = q.find((x) => x.description === 'IMPS CR 611111 HDFC');
    expect(p).toMatchObject({ kind: 'categorize', source: 'own', payload: { accountId: ids.hdfcGl } });
    expect(p.confidence).toBeLessThan(0.95);
  });

  it('re-books a line booked as a new customer before the partner was listed', async () => {
    await statement(ids.yes, [{ date: daysAgo(1), description: 'NEFT CR-HDFC0000123-RAHUL VERMA-9876543210', amount: 15000 }]);
    const np = ((await api('GET', '/api/v1/books/desk/proposals')).json as any[]).find((x) => x.kind === 'new_party' && x.description.includes('RAHUL'));
    expect(np).toBeTruthy();
    expect((await api('POST', `/api/v1/books/desk/proposals/${np.id}`, { decision: 'approve' })).status).toBe(200);
    expect((await txns(ids.yes)).find((x) => x.description.includes('RAHUL')).status).toBe('matched');

    const p = await api('POST', '/api/v1/books/desk/own/persons', { name: 'Rahul Verma', identifiers: [{ kind: 'mobile', value: '9876543210' }] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    // the same number can't be listed twice
    expect((await api('POST', '/api/v1/books/desk/own/persons', { name: 'Someone', identifiers: [{ kind: 'mobile', value: '+91 98765 43210' }] })).status).toBe(409);

    const mis = (await api('GET', '/api/v1/books/desk/own/misbooked')).json.lines as any[];
    const line = mis.find((l) => l.description.includes('RAHUL'));
    expect(line).toMatchObject({ owner: 'Rahul Verma', canRebook: true, status: 'matched' });
    expect(line.bookedTo).toMatch(/Customer receipt/);
    const rb = await api('POST', '/api/v1/books/desk/own/rebook', { txnIds: [line.id] });
    expect(rb.status, JSON.stringify(rb.json)).toBe(200);
    expect(rb.json).toMatchObject({ undone: 1, applied: 1 });
    expect((await txns(ids.yes)).find((x) => x.description.includes('RAHUL')).status).toBe('categorized');
    const rahul = (await api('GET', '/api/v1/books/desk/own')).json.persons.find((x: any) => x.name === 'Rahul Verma');
    expect(await balanceOf(rahul.account_in)).toBe(15000);
    expect(await balanceOf(sysAcc.customer_advances!)).toBe(0);
    expect(((await api('GET', '/api/v1/books/desk/own/misbooked')).json.lines as any[]).length).toBe(0);
    expect((await tb()).totals.balanced).toBe(true);
  });
});
