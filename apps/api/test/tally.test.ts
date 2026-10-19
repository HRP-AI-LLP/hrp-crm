import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { type Json, makeHarness, PW } from './harness';
// the connector that runs on the accountant's PC
import { parseImportResponse, parseReceipts, receiptsRequest } from '../../web/public/downloads/synapse-tally.mjs';

const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(body14: string) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CH.indexOf(body14[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return body14 + CH[(36 - (sum % 36)) % 36];
}

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let url = '';
let token = '';
const ids: Record<string, string> = {};
const conn = (path: string, body?: unknown, tok = token) => h.call(body === undefined ? 'GET' : 'POST', `${new URL(url).pathname}${path}`, { body, headers: { authorization: `Bearer ${tok}` } });

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_tally');
  await h.signup('tly', 'owner@tly.test');
  api = h.as('tly', (await h.login('tly', 'owner@tly.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  for (const a of ['orders', 'billing']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Tally Test LLP', state: 'Maharashtra', gstin: gstin('27AAACH1234M1Z'), address: 'Pune' } } });
  await api('POST', '/api/admin/users', { email: 'rep@tly.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('tly', (await h.login('tly', 'rep@tly.test')).token);
  ids.acc = (await api('POST', '/api/v1/records/account', { name: 'Kulkarni & Sons', gstin: gstin('27AABCK5678P1Z'), state: 'Maharashtra', address: 'FC Road, Pune', pincode: '411004' })).json.id;
  const inv = await api('POST', '/api/v1/records/invoice', { name: 'Kitchen', account_id: ids.acc });
  ids.inv = inv.json.id;
  await api('PUT', `/api/v1/invoices/${ids.inv}/lines`, { lines: [{ name: 'Modular kitchen', hsnSac: '9403', quantity: 1, unitPrice: 100000, taxRate: 18, unit: 'Nos' }] });
  const iss = await api('POST', `/api/v1/invoices/${ids.inv}/issue`);
  expect(iss.status, JSON.stringify(iss.json)).toBe(200);
  ids.invNo = iss.json.invoice.invoice_number;
}, 90_000);

describe('connecting', () => {
  it('needs billing admin; the token is shown once and verified by hash', async () => {
    expect((await rep('POST', '/api/admin/tally/connect')).status).toBe(403);
    const r = await api('POST', '/api/admin/tally/connect');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    url = r.json.connectorUrl;
    token = r.json.token;
    expect(token).toMatch(/^tly_/);
    expect(JSON.stringify(await sql(`select secret_ciphertext from integrations where provider = 'tally'`))).not.toContain(token);
    expect((await conn('/hello', undefined, 'tly_' + 'x'.repeat(40))).status).toBe(401);
    const hi = await conn('/hello');
    expect(hi.status).toBe(200);
    expect(hi.json.config.syncFrom).toMatch(/^\d{4}-04-01$/);
  });
});

describe('Synapse → Tally', () => {
  it('sends the customer ledger first, then the invoice with its bill reference', async () => {
    const p = await conn('/pull', { limit: 50 });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.items.map((i: Json) => i.kind)).toEqual(['ledger', 'sales']);
    const [ledger, sale] = p.json.items;
    expect(ledger.xml).toContain('<PARENT>Sundry Debtors</PARENT>');
    expect(ledger.xml).toContain('<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>');
    expect(ledger.alterXml).toContain('ACTION="Alter"');
    expect(sale.xml).toContain(`REMOTEID="synapse-${ids.inv}"`);
    expect(sale.xml).toContain(`<BILLALLOCATIONS.LIST><NAME>${ids.invNo}</NAME><BILLTYPE>New Ref</BILLTYPE>`);
    // unacknowledged items are not offered again straight away
    expect((await conn('/pull', {})).json.items).toHaveLength(0);
    const ack = await conn('/ack', { results: [{ kind: 'ledger', id: ledger.id, ok: true }, { kind: 'sales', id: sale.id, ok: false, error: 'Ledger "Sales" does not exist' }] });
    expect(ack.json).toEqual({ ok: 1, failed: 1 });
    const st = await api('GET', '/api/admin/tally');
    expect(st.json.problems[0]).toMatchObject({ kind: 'sales', status: 'failed' });
    // failures wait for the accountant to fix Tally and retry
    expect((await conn('/pull', {})).json.items).toHaveLength(0);
    expect((await api('POST', '/api/admin/tally/retry')).json.requeued).toBe(1);
    const again = await conn('/pull', {});
    expect(again.json.items.map((i: Json) => i.kind)).toEqual(['sales']);
    await conn('/ack', { results: [{ kind: 'sales', id: sale.id, ok: true }] });
  });

  it('pushes receipts with their allocations, and flags invoices cancelled after sync', async () => {
    const pay = await api('POST', '/api/v1/payments', { accountId: ids.acc, amount: 50000, mode: 'upi', reference: 'UTR1', allocations: [{ invoiceId: ids.inv, amount: 50000 }] });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const p = await conn('/pull', {});
    expect(p.json.items.map((i: Json) => i.kind)).toEqual(['receipt']);
    expect(p.json.items[0].xml).toContain(`<BILLTYPE>Agst Ref</BILLTYPE>`);
    await conn('/ack', { results: [{ kind: 'receipt', id: p.json.items[0].id, ok: true }] });
    // an issued invoice with a receipt cannot be cancelled, so cancel a second one
    const inv2 = (await api('POST', '/api/v1/records/invoice', { name: 'Wardrobe', account_id: ids.acc })).json.id;
    await api('PUT', `/api/v1/invoices/${inv2}/lines`, { lines: [{ name: 'Wardrobe', hsnSac: '9403', quantity: 1, unitPrice: 20000, taxRate: 18 }] });
    await api('POST', `/api/v1/invoices/${inv2}/issue`);
    const p2 = await conn('/pull', {});
    await conn('/ack', { results: p2.json.items.map((i: Json) => ({ kind: i.kind, id: i.id, ok: true })) });
    expect((await api('POST', `/api/v1/invoices/${inv2}/cancel`, { reason: 'Customer changed design' })).status).toBe(200);
    expect((await conn('/pull', {})).json.items).toHaveLength(0);
    const st = await api('GET', '/api/admin/tally');
    expect(st.json.problems.find((x: Json) => x.status === 'needs_attention').error).toMatch(/cancel voucher/);
  });
});

describe('Tally → Synapse', () => {
  it('records receipts entered in Tally once, against the invoices they name', async () => {
    const before = Number((await sql(`select balance_due from invoices where id = $1`, [ids.inv]))[0]!.balance_due);
    const receipts = [
      { guid: 'guid-1', date: new Date().toISOString().slice(0, 10), number: 'R-77', party: 'Kulkarni & Sons', amount: 30000, bills: [{ name: ids.invNo, amount: 30000 }] },
      { guid: 'guid-2', remoteId: 'synapse-whatever', date: new Date().toISOString().slice(0, 10), party: 'Kulkarni & Sons', amount: 10 },
      { guid: 'guid-3', date: new Date().toISOString().slice(0, 10), party: 'Unknown Traders', amount: 999 },
    ];
    const r = await conn('/receipts', { receipts });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ imported: 1, skipped: 1 });
    expect(r.json.unmatched[0]).toMatch(/Unknown Traders/);
    expect(Number((await sql(`select balance_due from invoices where id = $1`, [ids.inv]))[0]!.balance_due)).toBe(before - 30000);
    expect((await conn('/receipts', { receipts })).json.imported).toBe(0);
    // the imported receipt is not sent back to Tally
    expect((await conn('/pull', {})).json.items).toHaveLength(0);
  });
});

describe('connector parsing', () => {
  it('reads Tally import answers', () => {
    expect(parseImportResponse('<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS></RESPONSE>').ok).toBe(true);
    const bad = parseImportResponse('<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><LINEERROR>Ledger &apos;Kulkarni&apos; already exists</LINEERROR><ERRORS>1</ERRORS></RESPONSE>');
    expect(bad).toMatchObject({ ok: false, messages: ["Ledger 'Kulkarni' already exists"] });
    expect(parseImportResponse('').ok).toBe(false);
  });
  it('reads receipt vouchers with bill allocations', () => {
    const xml = `<ENVELOPE><BODY><DATA><COLLECTION>
      <VOUCHER REMOTEID="abc-1" VCHTYPE="Receipt"><DATE>20261018</DATE><GUID>guid-9</GUID><VOUCHERNUMBER>R-1</VOUCHERNUMBER><PARTYLEDGERNAME>Kulkarni &amp; Sons</PARTYLEDGERNAME><NARRATION>NEFT</NARRATION>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>HDFC Bank</LEDGERNAME><AMOUNT>-15000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>Kulkarni &amp; Sons</LEDGERNAME><AMOUNT>15000.00</AMOUNT>
          <BILLALLOCATIONS.LIST><NAME>INV/26-27/0001</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>12000.00</AMOUNT></BILLALLOCATIONS.LIST>
          <BILLALLOCATIONS.LIST><NAME>adv</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>3000.00</AMOUNT></BILLALLOCATIONS.LIST>
        </ALLLEDGERENTRIES.LIST></VOUCHER></COLLECTION></DATA></BODY></ENVELOPE>`;
    expect(parseReceipts(xml)).toEqual([{ guid: 'guid-9', remoteId: 'abc-1', date: '2026-10-18', number: 'R-1', party: 'Kulkarni & Sons', amount: 15000, narration: 'NEFT', bills: [{ name: 'INV/26-27/0001', amount: 12000 }] }]);
    expect(receiptsRequest('Acme & Co', '20260401', '20261019')).toContain('<SVCURRENTCOMPANY>Acme &amp; Co</SVCURRENTCOMPANY>');
  });
});
