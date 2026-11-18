/**
 * The accounts desk recognising who a bank line is from or to, on lines from a real Yes Bank statement:
 * a partner by the name in the partner list, a customer's contact, a customer by the phone in a UPI id or
 * by what they are billed, fixed deposits, account checks, professional fees — and creating the right
 * records when approved.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(today) - n * 86_400_000).toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const sysAcc: Record<string, string> = {};

const L = {
  fci: 'NEFT Cr-SBIN0004266-FOOD CORPORATION OF INDIA-HRP AI LLP-SBIN326314464479',
  harshaOut: 'IMPS/NA/XXXX9042/RRN:532270204198/PC211125587441487/HDFC BANK/Harsha Rani/IFB',
  harshaIn: 'NEFT Cr-HDFC0000001-HARSHA RANI-HRP AI LLP-HDFCH01368824497',
  shalini1: 'IMPS/Shalini Pathak/XXX7885/RRN:603810452909/',
  shalini2: 'IMPS/Shalini Pathak/XXX7885/RRN:610323775737/',
  phonepe: 'UPI/550012053407/From:XXXXXX7936-3@ybl/To:XXXXXX4463-7@ybl/Payment from PhonePe',
  fd: 'NET-New FD-HRP AI LLP-119840400013083 -1-SECTOR 78 NOIDA',
  penny: 'IMPS/API Banking EB/XXX6172/RRN:605199043331/',
  ca: 'IMPS/NA/XXXX8730/RRN:604457001938/PC2802637134271896/HDFC BANK/Deepanshu Agarwal/GST Fees',
  upiSettle: '115063600001082/763175492 UPI Collection Settlement/HRP AI LLP/CBS PAYABLE ACC',
  refund: 'REFUND:250927:MICROSOFTBUS\\10TH FLOOR 10',
  stranger: 'IMPS/Ramesh Gupta/XXX1111/RRN:600000000001/',
  // before the books start
  fciOld: 'NEFT Cr-SBIN0004266-FOOD CORPORATION OF INDIA-HRP AI LLP-SBIN326314400001',
  // debit-card purchases
  msft: 'PCA:2640:MICROSBUSEVE:MICROSBUSEVE MUMBAI IND27-SEP-25 12:07:13',
  perfection: 'PCA:2640:PERFPERFE108890:PERFECTION CONSULTING DELHI IND01-OCT-25 15:19:01',
  bms1: 'PCA:2640:BOOKMYS12665290:BOOK MY SHOW SMART GAT MUMBAI IND13-DEC-25 15:01:48',
  bms2: 'PCA:2640:BOOKMYSHOW10580:PAY*BOOKMYSHOW COM GURGAON IND13-DEC-25 14:58:28',
  shop: 'PCA:2640:KRISHNA00123:KRISHNA HARDWARE NOIDA IND02-JAN-26 11:00:00',
};
const beforeStart = (n: number) => new Date(Date.parse(fyStart) - n * 86_400_000).toISOString().slice(0, 10);

const proposals = async () => (await api('GET', '/api/v1/books/desk/proposals')).json as any[];
const forLine = async (d: string) => (await proposals()).find((p) => p.description === d);

beforeAll(async () => {
  h = await makeHarness('synapse_test_desk_parties');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'Noida' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sysAcc[a.system_key] = a.id;
  ids.yes = ((await api('GET', '/api/v1/books/bank-accounts')).json as any[]).find((x) => x.gl_account_id === sysAcc.bank).id;

  // Harsha Rani is a partner (no bank identifiers given)
  const hr = await api('POST', '/api/v1/books/desk/own/persons', { name: 'Harsha Rani', identifiers: [] });
  expect(hr.status, JSON.stringify(hr.json)).toBe(200);
  // FCI: a customer with an open deal, no invoice
  ids.fci = (await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', account_type: 'government' })).json.id;
  const fd = await api('POST', '/api/v1/records/deal', { name: 'FCI warehouse monitoring', account_id: ids.fci, amount: 500000 });
  expect(fd.status, JSON.stringify(fd.json)).toBe(201);
  ids.fciDeal = fd.json.id;
  // Sindhu Manthan: the trustee's phone, a ₹3,000 invoice open, and ₹1,200 a month maintenance on the deal
  ids.sm = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', account_type: 'ngo', phone: '7838247936' })).json.id;
  await api('POST', '/api/v1/records/contact', { last_name: 'Trustee', account_id: ids.sm, phone: '+91-7838247936' });
  const smDeal = (await api('POST', '/api/v1/records/deal', { name: 'Sindhu Manthan website', account_id: ids.sm })).json.id;
  expect((await api('PUT', `/api/v1/deals/${smDeal}/charges`, { charges: [{ kind: 'recurring', name: 'Maintenance', hsnSac: '998313', unitPrice: 1200, taxRate: 18, taxInclusive: true, frequency: 'monthly', startDate: daysAgo(60) }] })).status).toBe(200);
  const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: ids.sm })).json.id;
  await api('PUT', `/api/v1/invoices/${inv}/lines`, { taxInclusive: true, lines: [{ name: 'Maintenance', quantity: 1, unitPrice: 3000, taxRate: 18 }] });
  expect((await api('POST', `/api/v1/invoices/${inv}/issue`)).status).toBe(200);
  ids.smInvoice = inv;

  const r = await api('POST', `/api/v1/books/bank-accounts/${ids.yes}/statement`, {
    toDesk: true,
    rows: [
      { date: daysAgo(9), description: L.fci, amount: 171000 },
      { date: daysAgo(9), description: L.harshaOut, amount: -5000 },
      { date: daysAgo(8), description: L.harshaIn, amount: 65000 },
      { date: daysAgo(8), description: L.shalini1, amount: 3000 },
      { date: daysAgo(7), description: L.shalini2, amount: 1200 },
      { date: daysAgo(7), description: L.phonepe, amount: 2400 },
      { date: daysAgo(6), description: L.fd, amount: -30000 },
      { date: daysAgo(6), description: L.penny, amount: 1 },
      { date: daysAgo(5), description: L.ca, amount: -4000 },
      { date: daysAgo(5), description: L.upiSettle, amount: 50000 },
      { date: daysAgo(4), description: L.refund, amount: 2 },
      { date: daysAgo(4), description: L.stranger, amount: 7777 },
      { date: beforeStart(40), description: L.fciOld, amount: 25000 },
      { date: beforeStart(30), description: L.msft, amount: -359.31 },
      { date: daysAgo(3), description: L.perfection, amount: -2999 },
      { date: daysAgo(3), description: L.bms1, amount: -51.74 },
      { date: daysAgo(3), description: L.bms2, amount: -455.46 },
      { date: daysAgo(2), description: L.shop, amount: -1250 },
    ],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}, 180_000);

describe('who a bank line is from', () => {
  it('a partner by the name in the partner list: own money, not a vendor', async () => {
    for (const d of [L.harshaOut, L.harshaIn]) {
      const p = await forLine(d);
      expect(p, d).toBeTruthy();
      expect(p.kind).toBe('categorize');
      expect(p.payload.ownPersonId).toBeTruthy();
      expect(p.title).toMatch(/Harsha Rani/);
      expect(p.reason).toMatch(/partner list/);
    }
  });

  it('a known customer without an invoice: an advance, linked to their open deal', async () => {
    const p = await forLine(L.fci);
    expect(p).toMatchObject({ kind: 'new_party' });
    expect(p.payload).toMatchObject({ role: 'existing_customer', partyId: ids.fci, dealId: ids.fciDeal });
    expect(p.title).toMatch(/Advance from Food Corporation of India \(existing customer\)/);
    expect((await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' })).status).toBe(200);
  });

  it("a stranger paying a customer's invoice: the receipt, and they become the customer's contact", async () => {
    const p = await forLine(L.shalini1);
    expect(p).toMatchObject({ kind: 'receipt' });
    expect(p.payload).toMatchObject({ invoiceId: ids.smInvoice, payerName: 'Shalini Pathak' });
    const before = await forLine(L.shalini2);
    // ₹1,200 is what Sindhu Manthan is billed each month
    expect(before.payload).toMatchObject({ role: 'paid_for_customer', partyId: ids.sm, contactName: 'Shalini Pathak' });
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const contacts = (await api('GET', `/api/v1/records/contact?limit=50`)).json.items as any[];
    expect(contacts.find((c) => c.full_name === 'Shalini Pathak' && c.account_id === ids.sm)).toBeTruthy();
    // her other payment is now recognised through the contact just added
    const after = await forLine(L.shalini2);
    expect(after.payload).toMatchObject({ role: 'existing_customer', partyId: ids.sm });
    expect(after.reason).toMatch(/Shalini Pathak is a contact at Sindhu Manthan Foundation/);
  });

  it("a UPI id with the customer's phone digits", async () => {
    const p = await forLine(L.phonepe);
    expect(p.payload).toMatchObject({ partyId: ids.sm });
    expect(p.reason).toMatch(/ends in 7936/);
  });
});

describe('one receipt for several invoices, or for the work', () => {
  it('pays two monthly invoices at once, the rest kept as an advance', async () => {
    const mk = async (amount: number) => {
      const id = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: ids.sm })).json.id;
      await api('PUT', `/api/v1/invoices/${id}/lines`, { taxInclusive: true, lines: [{ name: 'Monthly maintenance', quantity: 1, unitPrice: amount, taxRate: 18 }] });
      expect((await api('POST', `/api/v1/invoices/${id}/issue`)).status).toBe(200);
      return id;
    };
    const a = await mk(1000);
    const b = await mk(1000);
    const docs = (await api('GET', '/api/v1/books/desk/open-documents')).json;
    expect(docs.invoices.filter((i: any) => [a, b].includes(i.id)).map((i: any) => i.status)).toEqual(['issued', 'issued']);
    expect(docs.deals.some((d: any) => d.id === ids.fciDeal)).toBe(true);
    // ₹2,400 from the trustee's PhonePe: ₹1,000 + ₹1,000 and ₹400 ahead
    const p = await forLine(L.phonepe);
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, {
      decision: 'approve',
      change: { kind: 'receipt', allocations: [{ invoiceId: a, amount: 1000 }, { invoiceId: b, amount: 1000 }], customerId: ids.sm },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    for (const id of [a, b]) expect((await api('GET', `/api/v1/invoices/${id}`)).json.invoice.status).toBe('paid');
    // invoices of two customers cannot share one receipt
    const fciInv = (await api('POST', '/api/v1/records/invoice', { name: 'Monitoring', account_id: ids.fci })).json.id;
    await api('PUT', `/api/v1/invoices/${fciInv}/lines`, { lines: [{ name: 'Monitoring', quantity: 1, unitPrice: 100, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/invoices/${fciInv}/issue`)).status).toBe(200);
  });

  it('one bank line is the money of two receipts already recorded (imported as paid)', async () => {
    const mk = async () => {
      const id = (await api('POST', '/api/v1/records/invoice', { name: 'Maintenance', account_id: ids.sm })).json.id;
      await api('PUT', `/api/v1/invoices/${id}/lines`, { taxInclusive: true, lines: [{ name: 'Monthly maintenance', quantity: 1, unitPrice: 1200, taxRate: 18 }] });
      expect((await api('POST', `/api/v1/invoices/${id}/issue`)).status).toBe(200);
      const pay = await api('POST', '/api/v1/payments', { accountId: ids.sm, amount: 1200, mode: 'upi', allocations: [{ invoiceId: id, amount: 1200 }] });
      expect(pay.status, JSON.stringify(pay.json)).toBeLessThan(300);
      return { id, pay: pay.json.id as string };
    };
    const [a, b] = [await mk(), await mk()];
    let docs = (await api('GET', '/api/v1/books/desk/open-documents')).json;
    expect(docs.invoices.filter((i: any) => [a.id, b.id].includes(i.id) && i.unbanked).length).toBe(2);
    const line = 'IMPS/PhonePe/two months/RRN 999111';
    expect((await api('POST', `/api/v1/books/bank-accounts/${ids.yes}/statement`, { toDesk: true, rows: [{ date: daysAgo(1), description: line, amount: 2400 }] })).status).toBe(200);
    const p = await forLine(line);
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve', change: { kind: 'receipt', paymentIds: [a.pay, b.pay] } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    docs = (await api('GET', '/api/v1/books/desk/open-documents')).json;
    expect(docs.invoices.filter((i: any) => [a.id, b.id].includes(i.id) && i.unbanked).length).toBe(0);
  });
});

describe('a government payment less TDS and GST TDS', () => {
  it('settles the invoice in full with both deductions', async () => {
    const acc = (await api('POST', '/api/v1/records/account', { name: 'Central Warehousing Corporation, Regional Office Noida', account_type: 'government' })).json.id;
    const inv = (await api('POST', '/api/v1/records/invoice', { name: '30% milestone', account_id: acc })).json.id;
    await api('PUT', `/api/v1/invoices/${inv}/lines`, { lines: [{ name: 'Development - Data Conversion', quantity: 1, unitPrice: 150000, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/invoices/${inv}/issue`)).status).toBe(200);
    const docs = (await api('GET', '/api/v1/books/desk/open-documents')).json;
    expect(docs.invoices.find((i: any) => i.id === inv)).toMatchObject({ taxable: 150000, total: 177000, government: true });
    const line = 'NEFT Cr-SBIN0004266-CENTRAL WAREHOUSING CORP-HRP AI LLP-SBIN326314469999';
    expect((await api('POST', `/api/v1/books/bank-accounts/${ids.yes}/statement`, { toDesk: true, rows: [{ date: daysAgo(1), description: line, amount: 171000 }] })).status).toBe(200);
    const p = await forLine(line);
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve', change: { kind: 'receipt', allocations: [{ invoiceId: inv, amount: 177000 }], tdsAmount: 3000, gstTdsAmount: 3000 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await api('GET', `/api/v1/invoices/${inv}`)).json.invoice).toMatchObject({ status: 'paid' });
  });
});

describe('lines that are not customers or vendors', () => {
  it('fixed deposit, account check, UPI collections, refund', async () => {
    expect((await forLine(L.fd)).payload.accountId).toBe((await api('GET', '/api/v1/books/accounts')).json.find((a: any) => a.system_key === 'fixed_deposits').id);
    expect((await forLine(L.penny)).payload.accountId).toBe(sysAcc.other_income);
    expect((await forLine(L.upiSettle)).payload.accountId).toBe(sysAcc.customer_advances);
    expect((await forLine(L.refund)).payload.accountId).toBe(sysAcc.software);
  });

  it("the CA's fees: professional fees, with the CA added as a vendor on approval", async () => {
    const p = await forLine(L.ca);
    expect(p).toMatchObject({ kind: 'categorize' });
    expect(p.payload).toMatchObject({ accountId: sysAcc.professional_fees, newParty: { type: 'vendor', name: 'Deepanshu Agarwal' } });
    expect((await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' })).status).toBe(200);
    const vendors = (await api('GET', '/api/v1/records/vendor?limit=50')).json.items as any[];
    expect(vendors.map((v) => v.title)).toContain('Deepanshu Agarwal');
  });

  it('an unknown person can be made a partner from the review', async () => {
    const p = await forLine(L.stranger);
    expect(p).toMatchObject({ kind: 'new_party', title: 'New customer: Ramesh Gupta' });
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve', change: { kind: 'partner', personName: 'Ramesh Gupta', personRole: 'partner' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const own = (await api('GET', '/api/v1/books/desk/own')).json.persons as any[];
    expect(own.map((x) => x.name)).toEqual(expect.arrayContaining(['Harsha Rani', 'Ramesh Gupta']));
  });
});

describe('card purchases and lines before the books start', () => {
  it('card purchases are expenses with the merchant as vendor, never advances', async () => {
    const want: [string, string, string][] = [
      [L.msft, 'software', 'Microsoft'],
      [L.perfection, 'professional_fees', 'Perfection Consulting'],
      [L.bms1, 'meals', 'BookMyShow'],
      [L.bms2, 'meals', 'BookMyShow'],
      [L.shop, 'uncategorised', 'Krishna Hardware'],
    ];
    for (const [d, key, name] of want) {
      const p = await forLine(d);
      expect(p, d).toMatchObject({ kind: 'categorize' });
      expect(p.payload, d).toMatchObject({ accountId: sysAcc[key] ?? expect.any(String), newParty: { type: 'vendor', name } });
    }
  });

  it('a card purchase before the books start is approved (vendor created)', async () => {
    const p = await forLine(L.msft);
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const vendors = (await api('GET', '/api/v1/records/vendor?limit=50')).json.items as any[];
    expect(vendors.map((v) => v.title)).toContain('Microsoft');
  });

  it("a line from an earlier financial year brings the books back to that year; the advance is a payment", async () => {
    const p = await forLine(L.fciOld);
    expect(p).toMatchObject({ kind: 'new_party' });
    expect(p.payload).toMatchObject({ partyId: ids.fci });
    const r = await api('POST', `/api/v1/books/desk/proposals/${p.id}`, { decision: 'approve' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await forLine(L.fciOld)).toBeFalsy();
    const prev = beforeStart(40);
    const fy = Number(prev.slice(5, 7)) >= 4 ? `${prev.slice(0, 4)}-04-01` : `${Number(prev.slice(0, 4)) - 1}-04-01`;
    expect((await api('GET', '/api/v1/books/settings')).json.config.start_date).toBe(fy);
    const pays = (await api('GET', '/api/v1/records/payment?limit=50')).json.items as any[];
    expect(pays.some((x) => x.title.includes('FOOD CORPORATION') || Number(x.amount) === 25000)).toBe(true);
  });

  it('expense lines become Expense records; earlier bank entries are moved to Expenses', async () => {
    const exps = (await api('GET', '/api/v1/records/expense?limit=50')).json.items as any[];
    // the CA's fees and the Microsoft card line approved above
    expect(exps.map((e) => e.title)).toEqual(expect.arrayContaining(['Professional fees · Deepanshu Agarwal', 'Software and subscriptions · Microsoft']));
    // a card line booked by hand in Banking as a bank entry
    const txns = (await api('GET', `/api/v1/books/bank-accounts/${ids.yes}/transactions?status=unmatched`)).json as any[];
    const shop = txns.find((x: any) => x.description === L.shop);
    expect((await api('POST', `/api/v1/books/bank-transactions/${shop.id}/categorize`, { accountId: sysAcc.office })).status).toBe(200);
    const run = await api('POST', '/api/v1/books/desk/run', { agents: ['bookkeeper'] });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    const after = (await api('GET', '/api/v1/records/expense?limit=50')).json.items as any[];
    expect(after.map((e) => e.title)).toContain('Office expenses');
    const all = (await api('GET', `/api/v1/books/bank-accounts/${ids.yes}/transactions?status=all`)).json as any[];
    expect(all.find((x: any) => x.description === L.shop).status).toBe('matched');
  });
});
