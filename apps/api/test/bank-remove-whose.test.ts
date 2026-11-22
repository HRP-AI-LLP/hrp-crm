import { beforeAll, describe, expect, it } from 'vitest';
import { whoseDocument } from '../src/services/intake/receipt';
import { makeHarness } from './harness';

const OWN_GSTIN = '09AAKFH1234C1Z5';
const own = (t: string) => whoseDocument(t, [OWN_GSTIN], ['HRP AI LLP']);

describe('whose document a mailed PDF is', () => {
  it("a vendor's receipt addressed to us by name is a bill we paid, not our invoice", () => {
    const github = ['GitHub', 'Payment Receipt for HRP-AI-LLP', 'Date 2026-11-21', 'Account billed: HRP-AI-LLP (organization)', 'Payment method Visa **** 9814', 'Total $4.00 USD'].join('\n');
    expect(own(github)).toBe('theirs');
    // only "Receipt for <us>" on it
    expect(own(['GitHub, Inc.', 'Receipt for HRP AI LLP', 'Copilot Business  $4.00'].join('\n'))).toBe('theirs');
    // paid with our card, no buyer heading, our name nowhere near a label
    expect(own(['HRP AI LLP', 'Acme Cloud Pte Ltd', 'Invoice 9921', 'Charged to Visa ending 4242', 'Total 12.00'].join('\n'))).toBe('theirs');
    // our name alone at the top is not enough to call it ours
    expect(own(['HRP AI LLP', 'Thanks for your order', 'Amount 499.00'].join('\n'))).toBeNull();
  });

  it('our own invoice (our GSTIN at the top, the customer under Bill To) stays ours', () => {
    const zoho = ['HRP AI LLP', `GSTIN ${OWN_GSTIN}`, 'TAX INVOICE', '# : INV-2026000010', 'Bill To\tShip To', 'Ms. Shalini Pathak\tRavi Enclave', 'Total Rs.1,200.00'].join('\n');
    expect(own(zoho)).toBe('ours');
    expect(own(['HRP AI LLP', `GSTIN ${OWN_GSTIN}`, 'TAX INVOICE', 'INV-11', 'Total 1,180.00'].join('\n'))).toBe('ours');
    // a supplier's bill with us under "Bill to" is theirs
    expect(own(['Sai Plywood', 'GSTIN 27AABCV5678P1ZX', 'Bill to', 'HRP AI LLP', `GSTIN ${OWN_GSTIN}`].join('\n'))).toBe('theirs');
  });
});

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const sys: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_bankremove');
  await h.signup('remco', 'owner@remco.test');
  api = h.as('remco', (await h.login('remco', 'owner@remco.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  const today = new Date().toISOString().slice(0, 10);
  const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sys[a.system_key] = a.id;
}, 120_000);

describe('removing a bank account that is not real', () => {
  it('moves its balance and its default role to the real account, keeps history, and hides it', async () => {
    const list = async () => (await api('GET', '/api/v1/books/bank-accounts')).json as any[];
    const placeholder = (await list()).find((a) => a.gl_account_id === sys.bank);
    expect(placeholder).toMatchObject({ name: 'Bank', is_default: true });
    const real = await api('POST', '/api/v1/books/bank-accounts', { name: 'Yes Bank Current Account', kind: 'bank', last4: '2111' });
    expect(real.status, JSON.stringify(real.json)).toBe(201);
    // money that went to the placeholder: cash moved into "Bank"
    const t = await api('POST', '/api/v1/books/transfers', { fromId: sys.cash, toId: sys.bank, amount: 26276, date: new Date().toISOString().slice(0, 10) });
    expect(t.status, JSON.stringify(t.json)).toBeLessThan(300);

    // without a target it says why
    const no = await api('POST', `/api/v1/books/bank-accounts/${placeholder.id}/remove`, {});
    expect(no.status).toBe(400);
    expect(no.json.error.message).toMatch(/choose the account/);
    // a card can't take a bank's balance
    const card = await api('POST', '/api/v1/books/bank-accounts', { name: 'Company card', kind: 'credit_card' });
    expect((await api('POST', `/api/v1/books/bank-accounts/${placeholder.id}/remove`, { moveToId: card.json.id })).status).toBe(400);

    const r = await api('POST', `/api/v1/books/bank-accounts/${placeholder.id}/remove`, { moveToId: real.json.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ moved: 26276, defaultMovedTo: 'Yes Bank Current Account' });

    const after = await list();
    expect(after.find((a) => a.id === placeholder.id)).toBeUndefined();
    const yes = after.find((a) => a.id === real.json.id);
    expect(yes).toMatchObject({ book_balance: 26276, is_default: true });
    // the books' default bank is now the real one; the old account is inactive but its history is still there
    const accts = (await api('GET', '/api/v1/books/accounts?all=1')).json as any[];
    expect(accts.find((a) => a.system_key === 'bank')?.id).toBe(real.json.glAccountId);
    const tb = await api('GET', `/api/v1/books/reports/trial-balance?to=${new Date().toISOString().slice(0, 10)}`);
    expect(tb.json.totals.balanced).toBe(true);
    // removed once: removing again is refused
    expect((await api('POST', `/api/v1/books/bank-accounts/${placeholder.id}/remove`, { moveToId: real.json.id })).status).toBe(400);
  });

  it('an unused account goes without a target', async () => {
    const w = await api('POST', '/api/v1/books/bank-accounts', { name: 'Old wallet', kind: 'wallet' });
    const r = await api('POST', `/api/v1/books/bank-accounts/${w.json.id}/remove`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.moved).toBe(0);
  });
});
