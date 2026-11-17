import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let tenantId = '';
let ownerId = '';
let repId = '';
const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** A Zoho-style page as the browser reads it (wide gaps as tabs). */
const zohoPage = (no: string, date: string, amount: string, inclusive: boolean) =>
  [
    'HRP AI LLP',
    'GSTIN 09AASFH6805J1ZT',
    'harsha.rani@hrpai.in',
    '\tTAX INVOICE',
    `# : ${no}\tPlace Of Supply : Uttar Pradesh (09)`,
    `Invoice Date : ${date}`,
    'Terms : Due end of the month',
    'P.O.# : HRP-Web-001',
    'Bill To\tShip To',
    'Ms. Shalini Pathak\tRavi Enclave',
    'Ravi Enclave\tSector-87',
    'Subject :',
    'Monthly Maintenance Charge For Sindhu-Manthan (NGO) Website',
    '# Item & Description\tHSN /SAC\tQty\tRate\tCGST % Amt\tSGST % Amt\tAmount',
    `1 Monthly maintenance charge -\t998313\t1.00\t${amount}\t9%\t${inclusive ? '91.53' : '270.00'}\t9%\t${inclusive ? '91.53' : '270.00'}\t${amount}`,
    'website',
    `\tSub Total\t${amount}`,
    inclusive ? '\t(Tax Inclusive)' : '',
    `Indian Rupee Only\tCGST9 (9%)\t${inclusive ? '91.53' : '270.00'}`,
    `Notes\tSGST9 (9%)\t${inclusive ? '91.53' : '270.00'}`,
    `Thanks for your business.\tTotal\t₹${inclusive ? amount : '3,540.00'}`,
    `\tPayment Made\t(-) ${inclusive ? amount : '3,540.00'}`,
    'Terms & Conditions\tBalance Due\t₹0.00',
  ].join('\n');

beforeAll(async () => {
  h = await makeHarness('synapse_test_deal_billing');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  tenantId = me.tenant.id;
  ownerId = me.user.id;
  for (const a of ['orders', 'billing', 'purchasing', 'books', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: '09AASFH6805J1ZT', address: 'Noida' } } });
  const bs = await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: '2026-04-01' });
  expect(bs.status, JSON.stringify(bs.json)).toBe(200);
  const u = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  repId = u.json.id;
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  ids.account = (await api('POST', '/api/v1/records/account', { name: 'Sindhu Manthan Foundation', account_type: 'ngo', state: 'Uttar Pradesh', payment_terms: 'end_of_month' })).json.id;
  const meta = (await api('GET', '/api/v1/meta')).json;
  const pipe = meta.pipelines.find((p: any) => p.objectKey === 'deal');
  ids.won = pipe.stages.find((s: any) => s.category === 'won').id;
  ids.open = pipe.stages.find((s: any) => s.category === 'open').id;
  const d = await api('POST', '/api/v1/records/deal', { name: 'Sindhu Manthan website', account_id: ids.account, source: 'Social circle', stage_id: ids.open });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  ids.deal = d.json.id;
}, 120_000);

describe('a deal with one-time and recurring charges', () => {
  it('values the deal from its charges', async () => {
    const r = await api('PUT', `/api/v1/deals/${ids.deal}/charges`, {
      charges: [
        { kind: 'one_time', name: 'Website development', hsnSac: '998314', unitPrice: 10000, taxRate: 18 },
        { kind: 'one_time', name: '.COM domain (sindhumanthan.com)', hsnSac: '998319', unitPrice: 2200, taxRate: 18 },
        { kind: 'recurring', name: 'Monthly maintenance charge - website', hsnSac: '998313', unitPrice: 3000, taxRate: 18, frequency: 'monthly', startDate: '2026-12-01' },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.totals).toEqual({ oneTime: 12200, recurringMonthly: 3000, firstYearRecurring: 36000, amount: 48200 });
    const deal = (await api('GET', `/api/v1/records/deal/${ids.deal}`)).json;
    expect(deal).toMatchObject({ amount: 48200, one_time_total: 12200, recurring_monthly: 3000, source: 'social_circle' });
    // only a won deal is set up for billing
    expect((await api('POST', `/api/v1/deals/${ids.deal}/setup-billing`, {})).status).toBe(400);
  });

  it('once won, sets up the project, the first invoice and the monthly invoice', async () => {
    expect((await api('PATCH', `/api/v1/records/deal/${ids.deal}`, { stage_id: ids.won })).status).toBe(200);
    const s = await api('POST', `/api/v1/deals/${ids.deal}/setup-billing`, { autoIssue: true });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.projectId).toBeTruthy();
    expect(s.json.invoiceId).toBeTruthy();
    expect(s.json.profileIds).toHaveLength(1);
    ids.profile = s.json.profileIds[0];
    const inv = (await api('GET', `/api/v1/invoices/${s.json.invoiceId}`)).json.invoice;
    expect(inv).toMatchObject({ status: 'draft', deal_id: ids.deal, taxable_total: 12200, payment_terms: 'end_of_month' });
    expect((await api('POST', `/api/v1/deals/${ids.deal}/setup-billing`, {})).status).toBe(409);
    const view = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json;
    expect(view.setup.projects).toHaveLength(1);
    expect(view.setup.profiles[0]).toMatchObject({ frequency: 'monthly', auto_issue: true });
  });

  it('changes the monthly price from a date, and the invoices follow', async () => {
    const pc = await api('POST', `/api/v1/recurring-invoices/${ids.profile}/price-changes`, {
      effectiveFrom: '2027-01-01',
      taxInclusive: true,
      note: 'Reduced to ₹1,200 including GST',
      lines: [{ name: 'Monthly maintenance charge - website', hsnSac: '998313', quantity: 1, unitPrice: 1200, taxRate: 18 }],
    });
    expect(pc.status, JSON.stringify(pc.json)).toBe(200);
    expect(pc.json).toHaveLength(1);
    // the December invoice: the old price; January: the new one
    const dec = await api('POST', `/api/v1/recurring-invoices/${ids.profile}/run`);
    expect(dec.status, JSON.stringify(dec.json)).toBe(200);
    const d1 = (await api('GET', `/api/v1/invoices/${dec.json.id}`)).json.invoice;
    expect(d1).toMatchObject({ status: 'issued', grand_total: 3540, tax_inclusive: false, deal_id: ids.deal });
    const jan = await api('POST', `/api/v1/recurring-invoices/${ids.profile}/run`);
    const j1 = (await api('GET', `/api/v1/invoices/${jan.json.id}`)).json.invoice;
    expect(j1).toMatchObject({ grand_total: 1200, taxable_total: 1016.95, tax_inclusive: true });
    const view = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json;
    expect(view.invoices.filter((i: any) => i.recurring_profile_id === ids.profile)).toHaveLength(2);
  });
});

describe('the organisation profile and signatures', () => {
  it('lets admins name who manages the profile', async () => {
    const p = await api('PUT', '/api/v1/organisation', {
      legalName: 'HRP AI LLP',
      constitution: 'llp',
      pan: 'AASFH6805J',
      gstin: '09AASFH6805J1ZT',
      address: 'UG-1, Shubh Building, Ravi Enclave, Sector-87',
      city: 'Noida',
      state: 'Uttar Pradesh',
      phones: [{ label: 'Office', number: '+91 93114 21118' }],
      emails: [{ label: 'Accounts', email: 'accounts@hrpai.in' }],
      contacts: [{ name: 'Harsha Rani', role: 'Accounts', phone: '', email: 'harsha.rani@hrpai.in' }],
      managers: [repId],
    });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.profile).toMatchObject({ constitution: 'llp', phone: '+91 93114 21118', email: 'accounts@hrpai.in' });
    // the named person can edit it, but not change who manages it
    const r = await rep('PUT', '/api/v1/organisation', { ...p.json.profile, managers: undefined, tradeName: 'HRP AI' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rep('PUT', '/api/v1/organisation', { ...p.json.profile, managers: [] })).status).toBe(403);
    const partner = await rep('POST', '/api/v1/organisation/people', { name: 'Prashant', role: 'partner', designation: 'Designated partner', sharePct: 50, identifiers: [{ kind: 'mobile', value: '9311421118' }] });
    expect(partner.status, JSON.stringify(partner.json)).toBe(200);
    const bank = await rep('POST', '/api/v1/organisation/bank-accounts', { name: 'Yes Bank current', bankName: 'Yes Bank', accountNumber: '017384600001234', ifsc: 'YESB0000173' });
    expect(bank.status, JSON.stringify(bank.json)).toBe(201);
    const people = (await rep('GET', '/api/v1/organisation/people')).json;
    expect(people.persons[0]).toMatchObject({ name: 'Prashant', designation: 'Designated partner', share_pct: 50 });
    expect(people.banks.find((b: any) => b.name === 'Yes Bank current').identifiers[0].value).toBe('017384600001234');
  });

  it('signs an issued invoice with a saved signature and verifies it publicly', async () => {
    const sig = await api('POST', '/api/v1/organisation/signatures', { signerName: 'Harsha Rani', designation: 'Partner', image: PNG, userIds: [ownerId] });
    expect(sig.status, JSON.stringify(sig.json)).toBe(201);
    ids.sig = sig.json.id;
    const list = (await api('GET', '/api/v1/invoices?limit=5').catch(() => null)) ?? null;
    void list;
    const inv = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json.invoices.find((i: any) => i.status === 'issued');
    // the rep is not one of Harsha's signers
    expect((await rep('POST', `/api/v1/documents/invoice/${inv.id}/sign`, { signatureId: ids.sig })).status).toBe(403);
    const s = await api('POST', `/api/v1/documents/invoice/${inv.id}/sign`, { signatureId: ids.sig });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json[0]).toMatchObject({ signerName: 'Harsha Rani', valid: true });
    const code = s.json[0].verifyCode;
    const v = await h.call('GET', `/api/public/verify/${tenantId}/${code}`, {});
    expect(v.json).toMatchObject({ found: true, valid: true, signer: { name: 'Harsha Rani' }, document: { type: 'invoice', total: 3540 } });
    // a draft can't be signed
    const draft = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json.invoices.find((i: any) => i.status === 'draft');
    expect((await api('POST', `/api/v1/documents/invoice/${draft.id}/sign`, { signatureId: ids.sig })).status).toBe(400);
  });

  it('signs every invoice as it is issued when billing says so', async () => {
    expect((await api('PUT', '/api/admin/billing/settings', { autoSignId: ids.sig })).status).toBe(200);
    const draft = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json.invoices.find((i: any) => i.status === 'draft');
    expect((await api('POST', `/api/v1/invoices/${draft.id}/issue`)).status).toBe(200);
    const sigs = (await api('GET', `/api/v1/documents/invoice/${draft.id}/signatures`)).json;
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({ signerName: 'Harsha Rani', valid: true });
  });
});

describe('importing past invoices into the deal', () => {
  it('reads tax-inclusive Zoho invoices, finds the NGO behind the person, and links them to the deal', async () => {
    const b = await api('POST', '/api/v1/books/imports', { name: 'Sindhu Manthan' });
    const f = await api('POST', `/api/v1/books/imports/${b.json.id}/files`, { fileName: 'InvoicesNew.pdf', pages: [zohoPage('INV-2026000010', '01/11/2026', '1,200.00', true), zohoPage('INV-2026000003', '01/05/2026', '3,000.00', false)] });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    const items = (await api('GET', `/api/v1/books/imports/${b.json.id}`)).json as any[];
    const nov = items.find((x) => x.data.number === 'INV-2026000010');
    expect(nov.data).toMatchObject({ taxInclusive: true, total: 1200, subject: 'Monthly Maintenance Charge For Sindhu-Manthan (NGO) Website', customerRef: 'HRP-Web-001', paymentTerms: 'end_of_month' });
    expect(nov.data.customer.email).toBeNull(); // the seller's own email is not the customer's
    expect(nov.plan).toMatchObject({ customer: { id: ids.account }, contact: { name: 'Shalini Pathak' }, deal: { id: ids.deal }, recurring: { id: ids.profile } });
    const a = await api('POST', '/api/v1/books/imports/items/approve', { ids: items.map((x) => x.id) });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.results.filter((r: any) => !r.ok)).toEqual([]);
    const view = (await api('GET', `/api/v1/deals/${ids.deal}/charges`)).json;
    const imported = view.invoices.find((i: any) => i.invoice_number === 'INV-2026000010');
    expect(imported).toMatchObject({ grand_total: 1200, recurring_profile_id: ids.profile });
    const full = (await api('GET', `/api/v1/invoices/${imported.id}`)).json.invoice;
    expect(full).toMatchObject({ tax_inclusive: true, customer_ref: 'HRP-Web-001', subject: expect.stringContaining('Sindhu-Manthan'), imported: true });
    // one contact for the person, however many invoices
    const contacts = (await api('GET', '/api/v1/records/contact?limit=50')).json.items as any[];
    expect(contacts.filter((c) => c.last_name === 'Pathak')).toHaveLength(1);
  });
});
