/** LLP compliance calendar, payroll with PF / ESI / PT / TDS, TDS challans and the 26Q / 24Q worksheet, and the books audit trail. */
import { beforeAll, describe, expect, it } from 'vitest';
import { dueList } from '../src/services/books/compliance';
import { computePayslip, incomeTax, professionalTax } from '../src/services/books/payroll';
import { lateInterest, quarterMonths } from '../src/services/books/tds-returns';
import { makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_compliance');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  const org = (await api('GET', '/api/v1/organisation')).json;
  expect((await api('PUT', '/api/v1/organisation', { ...org.profile, constitution: 'llp', gstin: '09AAKFH1234M1Z5', pan: 'AAKFH1234M', tan: 'MRTH12345A' })).status).toBe(200);
  await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: '2026-04-01', tdsEnabled: true, tan: 'MRTH12345A' }).catch(() => null);
  await api('POST', '/api/v1/organisation/people', { name: 'Prashant Srivastava', role: 'partner', din: '12345678', identifiers: [] });
  ids.bank = (await api('POST', '/api/v1/books/bank-accounts', { name: 'Yes Bank Current', kind: 'bank' })).json.id;
}, 120_000);

describe('the arithmetic', () => {
  it('income tax under both regimes', () => {
    expect(incomeTax(1200000, 'new')).toBe(0); // rebate up to ₹12 lakh
    expect(incomeTax(1600000, 'new')).toBe(Math.round((20000 + 40000 + 60000) * 1.04));
    expect(incomeTax(500000, 'old')).toBe(0);
    expect(incomeTax(1000000, 'old')).toBe(Math.round((12500 + 100000) * 1.04));
  });
  it('professional tax by state', () => {
    expect(professionalTax('Uttar Pradesh', 50000, 5)).toBe(0);
    expect(professionalTax('Maharashtra', 30000, 2)).toBe(300);
    expect(professionalTax('Karnataka', 30000, 5)).toBe(200);
  });
  it('a payslip with PF on capped basic, ESI out of range, TDS spread over the year', () => {
    const e = { id: 'x', name: 'A', basic: 40000, hra: 16000, special: 24000, other_allowances: [], pf_enabled: true, pf_on_full_basic: false, esi_enabled: true, pt_enabled: false, state: 'Uttar Pradesh', tax_regime: 'new' as const, annual_deductions: 0 };
    const p = computePayslip(e, '2026-11', 30);
    expect(p.gross).toBe(80000);
    expect(p.employeePf).toBe(1800);
    expect(p.employerPf).toBe(1950);
    expect(p.employeeEsi).toBe(0);
    // 9,60,000 − 75,000 standard deduction = 8,85,000 → within the ₹12 lakh rebate
    expect(p.tds).toBe(0);
    expect(p.net).toBe(78200);
    const half = computePayslip(e, '2026-11', 15);
    expect(half.gross).toBe(40000);
  });
  it('a small salary gets ESI', () => {
    const e = { id: 'y', name: 'B', basic: 12000, hra: 4000, special: 2000, other_allowances: [], pf_enabled: true, pf_on_full_basic: false, esi_enabled: true, pt_enabled: false, state: null, tax_regime: 'new' as const, annual_deductions: 0 };
    const p = computePayslip(e, '2026-11', 30);
    expect(p.employeeEsi).toBe(135);
    expect(p.employerEsi).toBe(585);
  });
  it('TDS quarters and late interest', () => {
    expect(quarterMonths(2026, 4)).toEqual(['2027-01', '2027-02', '2027-03']);
    expect(lateInterest(10000, '2026-05-10', '2026-06-05', '2026-05')).toBe(0);
    expect(lateInterest(10000, '2026-05-10', '2026-06-20', '2026-05')).toBe(300);
  });
  it('an LLP calendar', () => {
    const list = dueList({ fyStart: 2026, constitution: 'llp', gst: true, tds: true, pf: true, esi: false, pt: false, payroll: true, partners: [{ id: 'p1', name: 'Prashant' }], turnover: 30_00_000, settings: { gstReturns: 'monthly', audit: 'auto', taxAudit: 'auto', staffPf: false, staffEsi: false, staffPt: false, salaryTds: false, payrollHere: false } });
    const by = (k: string) => list.filter((x) => x.key === k);
    expect(by('llp_form11')[0]!.due).toBe('2027-05-30');
    expect(by('llp_form8')[0]!.due).toBe('2027-10-30');
    expect(by('llp_audit')).toHaveLength(0); // turnover under ₹40 lakh
    expect(by('itr')[0]!.due).toBe('2027-07-31');
    expect(by('gstr3b')).toHaveLength(12);
    expect(by('tds_deposit').find((x) => x.period === '2027-03')!.due).toBe('2027-04-30');
    expect(by('tds_26q').map((x) => x.due)).toEqual(['2026-07-31', '2026-10-31', '2027-01-31', '2027-05-31']);
    expect(by('dir3kyc:p1')[0]!.due).toBe('2027-09-30');
    expect(by('pf_ecr')).toHaveLength(12);
    const big = dueList({ fyStart: 2026, constitution: 'llp', gst: false, tds: false, pf: false, esi: false, pt: false, payroll: false, partners: [], turnover: 1_50_00_000, settings: { gstReturns: 'monthly', audit: 'auto', taxAudit: 'auto', staffPf: false, staffEsi: false, staffPt: false, salaryTds: false, payrollHere: false } });
    expect(big.find((x) => x.key === 'llp_audit')).toBeTruthy();
    expect(big.find((x) => x.key === 'tax_audit')!.due).toBe('2027-09-30');
    expect(big.find((x) => x.key === 'itr')!.due).toBe('2027-10-31');
  });
});

describe('in the workspace', () => {
  it('generates the calendar and files an item', async () => {
    const g = await api('POST', '/api/v1/books/compliance/generate', { fy: 2026 });
    expect(g.status, JSON.stringify(g.json)).toBe(200);
    expect(g.json.facts).toMatchObject({ constitution: 'llp', gst: true, partners: 1 });
    const items = (await api('GET', '/api/v1/books/compliance?from=2026-04-01&to=2027-12-31')).json as any[];
    const f11 = items.find((i) => i.key === 'llp_form11');
    expect(f11).toMatchObject({ due_date: '2027-05-30', status: 'pending', authority: 'MCA' });
    expect((await api('PATCH', `/api/v1/books/compliance/items/${f11.id}`, { status: 'filed', reference: 'SRN F12345678', amountPaid: 50 })).status).toBe(200);
    expect(((await api('GET', '/api/v1/books/compliance?from=2027-05-01&to=2027-05-31')).json as any[]).find((i) => i.key === 'llp_form11')).toMatchObject({ status: 'filed', reference: 'SRN F12345678' });
    expect((await api('POST', '/api/v1/books/compliance/generate', { fy: 2026 })).json.added).toBe(0);
  });

  it('runs payroll, posts it, pays it, and the 24Q worksheet shows the TDS', async () => {
    const e = await api('POST', '/api/v1/books/employees', { name: 'Senior Engineer', pan: 'ABCDE1234F', basic: 80000, hra: 32000, special: 48000, state: 'Uttar Pradesh', pfEnabled: true, esiEnabled: true });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    const r = await api('POST', '/api/v1/books/payroll', { period: '2026-10' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const slip = r.json.slips[0];
    expect(slip).toMatchObject({ gross: 160000, employee_pf: 1800 });
    expect(slip.tds).toBeGreaterThan(0);
    const half = await api('PUT', `/api/v1/books/payroll/${r.json.id}/slips/${slip.id}`, { paidDays: 31, otherDeductions: 500 });
    expect(half.json.slips[0].net).toBe(slip.net - 500);
    const posted = await api('POST', `/api/v1/books/payroll/${r.json.id}/post`);
    expect(posted.status, JSON.stringify(posted.json)).toBe(200);
    expect(posted.json.status).toBe('posted');
    const paid = await api('POST', `/api/v1/books/payroll/${r.json.id}/pay`, { bankAccountId: ids.bank, date: '2026-11-01' });
    expect(paid.json.status).toBe('paid');
    const ret = (await api('GET', '/api/v1/books/tds/return?fy=2026&q=3&form=24Q')).json;
    expect(ret.rows).toHaveLength(1);
    expect(ret.byMonth.find((m: any) => m.month === '2026-10')).toMatchObject({ deducted: slip.tds, deposited: 0 });
    expect(ret.warnings.join(' ')).toMatch(/not deposited/);
    const ch = await api('POST', '/api/v1/books/tds/challans', { nature: 'salary', section: '192', period: '2026-10', depositedOn: '2026-11-06', tax: slip.tds, bsrCode: '0510308', challanNo: '12345', bankAccountId: ids.bank });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const after = (await api('GET', '/api/v1/books/tds/return?fy=2026&q=3&form=24Q')).json;
    expect(after.byMonth.find((m: any) => m.month === '2026-10')).toMatchObject({ short: 0, interestDue: 0 });
    const csv = await api('GET', '/api/v1/books/tds/return?fy=2026&q=3&form=24Q&format=csv');
    expect(csv.text).toContain('ABCDE1234F');
  });

  it('Form 11 / Form 8 working from the books', async () => {
    const r = await api('GET', '/api/v1/books/compliance/llp-working?fy=2026');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.form11.partners[0]).toMatchObject({ name: 'Prashant Srivastava', designated: true, din: '12345678' });
    expect(r.json.form11.warnings.join(' ')).toMatch(/two designated partners/);
    expect(r.json.form8.incomeAndExpenditure.expenses).toBeGreaterThan(0); // the salary posted
  });

  it('files can be kept with a filing', async () => {
    const items = (await api('GET', '/api/v1/books/compliance?from=2026-04-01&to=2027-12-31')).json as any[];
    const r = await api('GET', `/api/v1/files?object=compliance_item&id=${items[0].id}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('the audit trail shows payroll and the books', async () => {
    const r = await api('GET', '/api/v1/books/audit-trail?limit=50');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const kinds = new Set((r.json as any[]).map((x) => x.object_key));
    expect(kinds.has('payroll_run')).toBe(true);
    expect(kinds.has('compliance_item')).toBe(true);
    const csv = await api('GET', '/api/v1/books/audit-trail?format=csv&object=employee');
    expect(csv.text).toContain('Senior Engineer');
  });
});

describe('the CA portal', () => {
  let caApi: ReturnType<typeof h.as>;
  let itemId = '';
  it('invites the CA, who gets only the compliance side', async () => {
    const r = await api('POST', '/api/v1/books/accountants', { email: 'ca@firm.test', fullName: 'CA Rakesh Gupta', firm: 'Gupta & Co', assignFilings: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ invited: true });
    expect(r.json.inviteUrl).toMatch(/accept-invite/);
    const token = new URL(r.json.inviteUrl).searchParams.get('token');
    const acc = await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: 'Str0ng-Passw0rd!', fullName: 'CA Rakesh Gupta' } });
    expect(acc.status, JSON.stringify(acc.json)).toBeLessThan(300);
    caApi = h.as('acme', (await h.login('acme', 'ca@firm.test')).token);
    expect(((await api('GET', '/api/v1/books/accountants')).json as any[])[0]).toMatchObject({ email: 'ca@firm.test', status: 'active' });
  });
  it('the CA sees the filings, statements, TDS and audit trail', async () => {
    const items = (await caApi('GET', '/api/v1/books/compliance?from=2026-04-01&to=2027-12-31')).json as any[];
    expect(items.length).toBeGreaterThan(10);
    expect(items.every((i) => i.status !== 'pending' || i.assignee === 'CA Rakesh Gupta')).toBe(true);
    itemId = items.find((i) => i.key === 'llp_form8').id;
    expect((await caApi('GET', '/api/v1/books/reports/profit-and-loss?from=2026-04-01&to=2027-03-31')).status).toBe(200);
    expect((await caApi('GET', '/api/v1/books/tds/return?fy=2026&q=3&form=24Q')).status).toBe(200);
    expect((await caApi('GET', '/api/v1/books/audit-trail')).status).toBe(200);
    expect((await caApi('GET', '/api/v1/books/compliance/llp-working?fy=2026')).status).toBe(200);
    expect((await caApi('GET', `/api/v1/files?object=compliance_item&id=${itemId}`)).status).toBe(200);
  });
  it('but not the CRM, payroll, settings or the CA list', async () => {
    expect((await caApi('GET', '/api/v1/records/lead')).status).toBe(403);
    expect((await caApi('GET', '/api/v1/books/payroll')).status).toBe(403);
    expect((await caApi('PUT', '/api/v1/books/compliance/settings', { gstReturns: 'none' })).status).toBe(403);
    expect((await caApi('GET', '/api/v1/books/accountants')).status).toBe(403);
    expect((await caApi('GET', '/api/v1/books/bank-accounts')).status).toBe(403);
  });
  it('they talk on a filing, and the business is told when the CA files', async () => {
    expect((await api('POST', `/api/v1/books/compliance/items/${itemId}/comments`, { body: 'Please file Form 8 this week.' })).status).toBe(201);
    expect((await caApi('POST', `/api/v1/books/compliance/items/${itemId}/comments`, { body: 'Need the bank statement for March.' })).status).toBe(201);
    const thread = (await caApi('GET', `/api/v1/books/compliance/items/${itemId}/comments`)).json as any[];
    expect(thread.map((t) => t.from_ca)).toEqual([false, true]);
    expect((await caApi('PATCH', `/api/v1/books/compliance/items/${itemId}`, { status: 'filed', reference: 'SRN F98765432' })).status).toBe(200);
    const notes = (await api('GET', '/api/v1/notifications')).json;
    const titles = JSON.stringify(notes);
    expect(titles).toMatch(/Filed by your CA/);
    expect(titles).toMatch(/CA Rakesh Gupta wrote/);
  });
  it('removing the CA switches the login off', async () => {
    const list = (await api('GET', '/api/v1/books/accountants')).json as any[];
    const r = await api('DELETE', `/api/v1/books/accountants/${list[0].id}`);
    expect(r.json).toMatchObject({ disabled: true });
  });
});
