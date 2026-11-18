/**
 * A government contract end to end (a GeM order from FCI): EMD for the bid, performance security,
 * a project with the contract number, an accepted milestone billed, and a receipt net of TDS, GST
 * TDS, liquidated damages and retention; then retention released and part of the security forfeited.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { receiptVoucherXml } from '../src/services/gst-exports';
import { makeHarness } from './harness';

const today = new Date().toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const acc: Record<string, string> = {};

async function balance(key: string) {
  const r = await api('GET', `/api/v1/books/reports/general-ledger?accountId=${acc[key]}&from=${fyStart}&to=${addDays(today, 400)}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.closing as number;
}
async function balanced() {
  const r = await api('GET', `/api/v1/books/reports/trial-balance?to=${addDays(today, 400)}`);
  expect(r.json.totals.balanced, JSON.stringify(r.json.totals)).toBe(true);
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_gov');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh' } } });
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) acc[a.system_key] = a.id;
  const fci = await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', account_type: 'government', gstin: '07AAACF0000A1ZV', state: 'Delhi' });
  expect(fci.status, JSON.stringify(fci.json)).toBe(201);
  ids.fci = fci.json.id;
  const deal = await api('POST', '/api/v1/records/deal', { name: 'FCI warehouse IoT — GeM bid', account_id: ids.fci, amount: 1000000, source: 'gem' });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  ids.deal = deal.json.id;
}, 120_000);

describe('a GeM contract with FCI', () => {
  it('records the EMD for the bid and releases it after the award', async () => {
    const emd = await api('POST', '/api/v1/deposits', { kind: 'emd', instrument: 'online', accountId: ids.fci, dealId: ids.deal, reference: 'GEM/2026/B/1234567', amount: 20000, paidFrom: acc.bank });
    expect(emd.status, JSON.stringify(emd.json)).toBe(201);
    expect(emd.json.number).toMatch(/^SD-/);
    expect(await balance('emd_deposits')).toBeCloseTo(20000, 2);
    // money must come from a bank or cash account
    expect((await api('POST', '/api/v1/deposits', { kind: 'emd', instrument: 'online', accountId: ids.fci, amount: 1, paidFrom: acc.sales })).status).toBe(400);
    expect((await api('POST', `/api/v1/deposits/${emd.json.id}/release`, { bankAccountId: acc.bank })).status).toBe(200);
    expect(await balance('emd_deposits')).toBeCloseTo(0, 2);
    const d = (await api('GET', `/api/v1/deposits/${emd.json.id}`)).json;
    expect(d.deposit.status).toBe('closed');
    expect(d.events.map((e: any) => e.kind)).toEqual(['place', 'release']);
  });

  it('records performance security as an ePBG with margin money and a reminder before expiry', async () => {
    const pbg = await api('POST', '/api/v1/deposits', {
      kind: 'performance_security', instrument: 'epbg', accountId: ids.fci, reference: 'EPBG/SBI/0042', issuingBank: 'State Bank of India',
      amount: 50000, marginAmount: 10000, paidFrom: acc.bank, issueDate: today, expiryDate: addDays(today, 20), claimUntil: addDays(today, 50),
    });
    expect(pbg.status, JSON.stringify(pbg.json)).toBe(201);
    ids.pbg = pbg.json.id;
    expect(await balance('bg_margin')).toBeCloseTo(10000, 2); // only the margin moves; the guarantee is contingent
    const exp = (await api('GET', '/api/v1/deposits?expiringDays=30')).json;
    expect(exp.map((x: any) => x.id)).toContain(ids.pbg);
    // a guarantee's margin is the only money involved; extension keeps it active
    expect((await api('POST', `/api/v1/deposits/${ids.pbg}/extend`, { expiryDate: addDays(today, 200), claimUntil: addDays(today, 260) })).status).toBe(200);
    expect((await api('GET', `/api/v1/deposits/${ids.pbg}`)).json.deposit.expiry_date.slice(0, 10)).toBe(addDays(today, 200));
  });

  it('runs the project with the contract number, accepts the milestone and bills it', async () => {
    const p = await api('POST', '/api/v1/records/project', {
      name: 'FCI warehouse monitoring', account_id: ids.fci, deal_id: ids.deal, customer_ref: 'GEMC-511687712345678', customer_ref_date: fyStart,
      billing_method: 'fixed_price', fixed_fee: 1000000, tax_rate: 18, hsn_sac: '998314',
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.project = p.json.id;
    const m = await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Phase 1: sensors installed at 10 depots', amount: 400000, dueDate: today });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    ids.ms = m.json.id;
    // closing needs the customer's approval: without it, refused
    const noProof = await api('PUT', `/api/v1/projects/${ids.project}/milestones/${ids.ms}`, { name: 'Phase 1: sensors installed at 10 depots', amount: 400000, dueDate: today, status: 'done', acceptedOn: today, acceptanceRef: 'CRAC 4411' });
    expect(noProof.status).toBe(400);
    expect(noProof.json.error.message).toMatch(/approval/i);
    // in progress is fine
    expect((await api('PUT', `/api/v1/projects/${ids.project}/milestones/${ids.ms}`, { name: 'Phase 1: sensors installed at 10 depots', amount: 400000, dueDate: today, status: 'in_progress' })).status).toBe(200);
    // the customer's approval email (as the mailbox sync logs it) is found by the scan and linked
    const mail = await api('POST', `/api/v1/records/account/${ids.fci}/activities`, { kind: 'email', direction: 'in', subject: 'Phase 1 approved — CRAC issued', body: 'Dear Sir, the sensors installed at 10 depots are accepted. CRAC 4411 is issued.' });
    expect(mail.status, JSON.stringify(mail.json)).toBe(201);
    const scan = await api('GET', `/api/v1/projects/${ids.project}/approval-emails?milestone=${ids.ms}&scan=1`);
    expect(scan.status, JSON.stringify(scan.json)).toBe(200);
    expect(scan.json.items[0].id).toBe(mail.json.id);
    expect(scan.json.items[0].looksLikeApproval).toBe(true);
    expect(
      (await api('PUT', `/api/v1/projects/${ids.project}/milestones/${ids.ms}`, { name: 'Phase 1: sensors installed at 10 depots', amount: 400000, dueDate: today, status: 'done', acceptedOn: today, acceptanceRef: 'CRAC 4411', approvalActivityId: mail.json.id })).status,
    ).toBe(200);
    const md = await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}`);
    expect(md.json.milestone.approval_email_subject).toBe('Phase 1 approved — CRAC issued');
    expect(md.json.milestone.approved_by).toBeTruthy();
    const inv = await api('POST', `/api/v1/projects/${ids.project}/invoice`, { milestoneIds: [ids.ms] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    ids.invoice = inv.json.id;
    let g = (await api('GET', `/api/v1/invoices/${ids.invoice}`)).json;
    expect(g.invoice.customer_ref).toBe('GEMC-511687712345678');
    expect(g.lines[0].description).toContain('CRAC 4411');
    expect((await api('POST', `/api/v1/invoices/${ids.invoice}/issue`)).status).toBe(200);
    g = (await api('GET', `/api/v1/invoices/${ids.invoice}`)).json;
    expect(g.invoice.igst_total).toBeCloseTo(72000, 2); // Delhi buyer, UP seller
    expect(g.invoice.grand_total).toBeCloseTo(472000, 2);
    // the contract number is frozen once issued
    expect((await api('PATCH', `/api/v1/records/invoice/${ids.invoice}`, { customer_ref: 'X' })).status).toBe(400);
  });

  it('takes the payment net of TDS, GST TDS, LD and retention', async () => {
    const r = await api('POST', '/api/v1/payments', {
      accountId: ids.fci, amount: 472000, date: today, mode: 'bank_transfer', reference: 'PFMS UTR 998877', depositAccountId: acc.bank,
      allocations: [{ invoiceId: ids.invoice, amount: 472000 }], tdsAmount: 8000, gstTdsAmount: 8000, ldAmount: 2000, retentionAmount: 20000,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.payment = r.json.id;
    expect((await api('GET', `/api/v1/invoices/${ids.invoice}`)).json.invoice.status).toBe('paid');
    expect(await balance('gst_tds_receivable')).toBeCloseTo(8000, 2);
    expect(await balance('tds_receivable')).toBeCloseTo(8000, 2);
    expect(await balance('liquidated_damages')).toBeCloseTo(2000, 2);
    expect(await balance('retention_receivable')).toBeCloseTo(20000, 2);
    expect(await balance('ar')).toBeCloseTo(0, 2);
    await balanced();
    // retention is in the register, linked to the project
    const ret = ((await api('GET', '/api/v1/deposits?status=active')).json as any[]).find((d) => d.kind === 'retention');
    expect(ret).toMatchObject({ amount: 20000, project_id: ids.project, instrument: 'withheld' });
    ids.retention = ret.id;
    // deductions can't exceed what is settled
    expect((await api('POST', '/api/v1/payments', { accountId: ids.fci, amount: 100, tdsAmount: 60, gstTdsAmount: 60 })).status).toBe(400);
    // the TDS report lists them for 26AS / GSTR-2X
    const t = (await api('GET', `/api/v1/books/reports/tds?from=${fyStart}&to=${today}`)).json;
    expect(t.receivable[0]).toMatchObject({ tds: 8000, gst_tds: 8000, ld: 2000, retention: 20000, gstin: '07AAACF0000A1ZV' });
  });

  it('releases retention, forfeits part of the guarantee, and keeps the receipt from being voided after that', async () => {
    expect((await api('POST', `/api/v1/deposits/${ids.retention}/release`, { amount: 15000, bankAccountId: acc.bank })).status).toBe(200);
    expect(await balance('retention_receivable')).toBeCloseTo(5000, 2);
    expect((await api('POST', `/api/v1/payments/${ids.payment}/void`, { reason: 'test' })).status).toBe(400);
    // the buyer invokes 12,000 of the guarantee: margin covers 10,000, the bank pays 2,000
    expect((await api('POST', `/api/v1/deposits/${ids.pbg}/forfeit`, { amount: 12000, bankAccountId: acc.bank, reason: 'Late delivery at 2 depots' })).status).toBe(200);
    expect(await balance('bg_margin')).toBeCloseTo(0, 2);
    expect(await balance('liquidated_damages')).toBeCloseTo(14000, 2);
    expect((await api('POST', `/api/v1/deposits/${ids.pbg}/forfeit`, { amount: 50000, reason: 'too much' })).status).toBe(400);
    // release the rest of the guarantee: nothing left in margin, so no money moves
    expect((await api('POST', `/api/v1/deposits/${ids.pbg}/release`, {})).status).toBe(200);
    expect((await api('GET', `/api/v1/deposits/${ids.pbg}`)).json.deposit.status).toBe('closed');
    await balanced();
  });

  it('a receipt without released retention can be voided and takes its retention entry with it', async () => {
    const inv = (await api('POST', '/api/v1/records/invoice', { name: 'AMC', account_id: ids.fci })).json.id;
    const ln = await api('PUT', `/api/v1/invoices/${inv}/lines`, { lines: [{ name: 'AMC', quantity: 1, unitPrice: 10000, discountPct: 0, taxRate: 18, hsnSac: '998713' }] });
    expect(ln.status, JSON.stringify(ln.json)).toBe(200);
    const is = await api('POST', `/api/v1/invoices/${inv}/issue`);
    expect(is.status, JSON.stringify(is.json)).toBe(200);
    const r = await api('POST', '/api/v1/payments', { accountId: ids.fci, amount: 11800, depositAccountId: acc.bank, allocations: [{ invoiceId: inv, amount: 11800 }], retentionAmount: 1000 });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await api('POST', `/api/v1/payments/${r.json.id}/void`, { reason: 'wrong customer' })).status).toBe(200);
    const all = (await api('GET', '/api/v1/deposits')).json as any[];
    expect(all.filter((d) => d.payment_id === r.json.id)[0].status).toBe('cancelled');
    expect(await balance('retention_receivable')).toBeCloseTo(5000, 2);
    await balanced();
  });

  it('refuses dates before the deposit, and deductions on foreign-currency receipts', async () => {
    const d = (await api('POST', '/api/v1/deposits', { kind: 'security_deposit', instrument: 'online', accountId: ids.fci, amount: 5000, paidFrom: acc.bank, issueDate: today })).json.id;
    expect((await api('POST', `/api/v1/deposits/${d}/release`, { date: addDays(today, -3), bankAccountId: acc.bank })).status).toBe(400);
    expect((await api('POST', `/api/v1/deposits/${d}/release`, { bankAccountId: acc.bank })).status).toBe(200);
    expect((await api('POST', '/api/v1/payments', { accountId: ids.fci, amount: 100, currency: 'USD', exchangeRate: 83, retentionAmount: 10 })).status).toBe(400);
  });

  it('a deposit from before the books is released without a journal', async () => {
    await api('PUT', '/api/v1/books/settings', { enabled: false, booksOfRecord: 'synapse', startDate: fyStart });
    const d = (await api('POST', '/api/v1/deposits', { kind: 'emd', instrument: 'dd', accountId: ids.fci, amount: 7000 })).json.id;
    await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart });
    const before = await balance('emd_deposits');
    expect((await api('POST', `/api/v1/deposits/${d}/release`, { bankAccountId: acc.bank })).status).toBe(200);
    expect(await balance('emd_deposits')).toBeCloseTo(before, 2);
    await balanced();
  });

  it('only billing or books admins see the register', async () => {
    const u = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: 'Str0ng-Passw0rd!', roles: ['sales_rep'] });
    expect(u.status).toBe(201);
    const rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
    expect((await rep('GET', '/api/v1/deposits')).status).toBe(403);
    expect((await rep('POST', '/api/v1/deposits', { kind: 'emd', instrument: 'online', accountId: ids.fci, amount: 1 })).status).toBe(403);
  });
});

describe('Tally receipt voucher', () => {
  it('sends the bank the net amount and each deduction to its own ledger', () => {
    const L = { sales: 'Sales', cgst: 'CGST', sgst: 'SGST', igst: 'IGST', roundOff: 'RO', bank: 'SBI', tds: 'TDS Receivable', gstTds: 'GST TDS Receivable', ld: 'LD', retention: 'Retention', bankCharges: 'Bank Charges' };
    const xml = receiptVoucherXml(L, { payment_number: 'RCPT-1', payment_date: today, amount: 472000, tds_amount: 8000, gst_tds_amount: 8000, ld_amount: 2000, retention_amount: 20000, bank_charges: 0 }, 'FCI', [{ name: 'INV-1', amount: 472000 }]);
    expect(xml).toContain('<LEDGERNAME>SBI</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-434000.00</AMOUNT>');
    for (const [l, a] of [['TDS Receivable', '8000.00'], ['GST TDS Receivable', '8000.00'], ['LD', '2000.00'], ['Retention', '20000.00']]) expect(xml).toContain(`<LEDGERNAME>${l}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-${a}</AMOUNT>`);
    expect(xml).not.toContain('Bank Charges');
    expect(xml).toContain('<LEDGERNAME>FCI</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>472000.00</AMOUNT>');
  });
});
