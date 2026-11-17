/**
 * gstinapi.in as the GST provider, against a fake www.gstinapi.in: connecting with the OTP,
 * GSTR-1 (save → file) and GSTR-3B (save → offset → OTP → file by checksum), GSTR-2B, return
 * history, IRN and e-way bill. Also: every answer is kept in our database and read from there
 * until someone asks for a refresh, so paid calls are not repeated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { toRetPeriod } from '../src/services/gst/returns';
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
const SELLER = gstin('09AAACH1234M1Z');
const FCI = '07AAACF0000A1ZV';
const month = new Date().toISOString().slice(0, 7);
const PERIOD = toRetPeriod(month);
const KEY = 'gak_test_key';

type Call = { method: string; path: string; query: Record<string, string>; body: any };
const calls: Call[] = [];
const state = { testMode: false, connected: false, otpPending: false, saved: new Map<string, any>(), chksum3b: 'CK-SAVE' };
const count = (path: string) => calls.filter((c) => c.path === path).length;

function api_(method: string, path: string, q: Record<string, string>, body: any): [number, any] {
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}) => [status, { success: false, error, ...extra }] as [number, any];
  if (path === `/v1/gstin/${FCI}`) return [200, { success: true, gstin: FCI, credits_remaining: 70, data: { gstin: FCI, legal_name: 'FOOD CORPORATION OF INDIA', status: 'Active', taxpayer_type: 'Regular', state_code: '07', address: '16-20 Barakhamba Lane', city: 'New Delhi', pincode: '110001' } }];
  if (path === `/v1/gstin/${SELLER}/returns`)
    return [200, { success: true, returns: [{ return_type: 'GSTR3B', return_period: `${PERIOD.slice(2)}-${PERIOD.slice(0, 2)}`, filing_status: 'Filed', filing_date: '2026-05-20', arn: 'AA090GI00001' }] }];
  if (path === '/v1/gst/filing/connections' && method === 'POST') {
    expect(body).toEqual({ gstin: SELLER, gst_username: 'acme_up' });
    state.otpPending = true;
    return [200, { success: true, gstin: SELLER, expires_in: 600 }];
  }
  if (path === `/v1/gst/filing/connections/${SELLER}/verify`) {
    if (!state.otpPending) return fail(409, 'No OTP request is pending', { code: 'NO_PENDING_OTP' });
    if (body.otp !== '123456') return fail(401, 'Wrong or expired OTP (RET13509): request a new one');
    state.connected = true;
    return [200, { success: true, connection: { gstin: SELLER, status: 'active', connected_at: '2026-11-17 08:00:00', expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() } }];
  }
  if (path === '/v1/gst/filing/connections' && method === 'GET') return [200, { success: true, connections: state.connected ? [{ gstin: SELLER, status: 'active', expires_at: new Date(Date.now() + 24 * 3600_000).toISOString() }] : [] }];
  if (path.startsWith('/v1/gstr') && !state.connected) return fail(409, 'This GSTIN is not connected for filing');
  if (state.testMode && path === '/v1/gstr1/save') return [200, { success: true, test_mode: true, summary: { gstin: SELLER, ret_period: PERIOD, note: 'synthetic' }, ref_id: 'TEST-REF-0000', awaiting_evc_otp: true }];
  if (state.testMode && path === '/v1/gstr1/file') return [200, { success: true, test_mode: true, filed: false, ref_id: 'TEST-REF-FILE', note: 'synthetic — nothing was filed' }];
  if (path === '/v1/gstr1/save') {
    expect(body).toMatchObject({ gstin: SELLER, ret_period: PERIOD, pan: 'ABCDE1234F' });
    state.saved.set('r1', body.payload);
    return [200, { success: true, ref_id: 'REF-R1', awaiting_evc_otp: true, summary: { gstin: SELLER, ret_period: PERIOD, sec_sum: [{ sec_nm: 'B2B', ttl_val: 118000 }], chksum: 'CK-R1' } }];
  }
  if (path === '/v1/gstr1/file') {
    expect(body).toMatchObject({ pan: 'ABCDE1234F', evc_otp: '654321', summary: { chksum: 'CK-R1' } });
    return [200, { success: true, filed: true, ref_id: 'REF-R1F', upstream: { ack_num: 'AA0901GIFILED' }, credits_charged: 1, credits_remaining: 69 }];
  }
  if (path === '/v1/gstr3b/save') {
    state.saved.set('3b', body.payload);
    return [
      200,
      {
        success: true,
        chksum: 'CK-SAVE',
        summary: {
          gstin: SELLER,
          ret_period: PERIOD,
          itc_elg: { itc_net: { iamt: 5000, camt: 0, samt: 0, csamt: 0 } },
          tx_pmt: { tx_py: [{ trans_typ: 30002, liab_ldg_id: 77, igst: { tx: 18000, intr: 0 }, cgst: { tx: 0, intr: 0, fee: 0 }, sgst: { tx: 0, intr: 0, fee: 0 }, cess: { tx: 0, intr: 0 } }] },
        },
        auto_liability: { igst: 18000 },
        system_interest: null,
      },
    ];
  }
  if (path === '/v1/gstr3b/offset') {
    expect(body.payload.pditc).toMatchObject({ i_pdi: 5000 });
    state.chksum3b = 'CK-OFFSET';
    return [200, { success: true, offset: true, chksum: 'CK-OFFSET' }];
  }
  if (path === '/v1/gstr3b/evc-otp') return [200, { success: true, requested: true }];
  if (path === '/v1/gstr3b/file') {
    if (body.chksum !== state.chksum3b) return fail(409, 'CHECKSUM_CHANGED');
    return [200, { success: true, filed: true, ref_id: 'REF-3B', upstream: { ack_num: 'AA093BGIFILED' }, credits_charged: 1 }];
  }
  if (path === '/v1/gstr2b/fetch')
    return [200, { success: true, credits_charged: 3, data: { data: { docdata: { b2b: [{ ctin: gstin('09AAGCS1111B1Z'), trdnm: 'Steel', inv: [{ inum: 'SS/9', dt: `05-${PERIOD.slice(0, 2)}-${PERIOD.slice(2)}`, val: 11800, txval: 10000, igst: 0, cgst: 900, sgst: 900 }] }] } } } }];
  if (path === '/v1/einvoice') {
    expect(body).toMatchObject({ gstin: SELLER, einv_username: 'acme_api', password: 'irp-secret', txn_type: 'INV' });
    return [200, { success: true, irn: 'c'.repeat(64), ack_no: '182610000000999', ack_date: '2026-11-17 08:30:00', qr_code_image: 'eyJ.QR.GI', signed_invoice: 'eyJ.INV', ewaybill_status: 'not_requested', credits_remaining: 66 }];
  }
  if (path === '/v1/ewaybill/from-irn') {
    expect(body).toMatchObject({ irn: 'c'.repeat(64), distance: 0, trans_mode: '1', vehicle_no: 'UP16AB1234' });
    return [200, { success: true, irn: body.irn, ewaybill_no: '381000000777', ewaybill_date: '2026-11-17 08:35:00', ewaybill_valid_upto: '2026-11-18 23:59:00' }];
  }
  return fail(404, `unknown ${method} ${path}`);
}

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await makeHarness('synapse_test_gst_gi');
  Object.assign(h.env, { GSTINAPI_KEY: KEY, GST_PROVIDER: 'gstinapi' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'www.gstinapi.in') return realFetch(input, init);
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    const query = Object.fromEntries(url.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query, body });
    const [status, json] = api_(init?.method ?? 'GET', url.pathname, query, body);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'B-12 Sector 62, Noida 201301' } } });
  const fci = await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', account_type: 'government', gstin: FCI, state: 'Delhi' });
  const inv = await api('POST', '/api/v1/records/invoice', { name: 'Supply', account_id: fci.json.id });
  await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines: [{ name: 'IoT monitoring', hsnSac: '998314', quantity: 1, unitPrice: 100000, taxRate: 18 }] });
  expect((await api('POST', `/api/v1/invoices/${inv.json.id}/issue`)).status).toBe(200);
  ids.inv = inv.json.id;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('GST through gstinapi.in', () => {
  it('is the provider, and a taxpayer lookup is paid for once then read from our database', async () => {
    const c = await api('POST', '/api/v1/gst/connections', { gstin: SELLER, gstUsername: 'acme_up', signatoryPan: 'ABCDE1234F', einvUsername: 'acme_api', einvPassword: 'irp-secret' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    ids.conn = c.json.id;
    const list = await api('GET', '/api/v1/gst/connections');
    expect(list.json.gsp).toMatchObject({ provider: 'gstinapi.in', id: 'gstinapi', forms: ['GSTR1', 'GSTR3B'], steps: { status: false, summary: false, gstr1OtpOnSave: true }, publicTrack: true });
    const a = await api('GET', `/api/v1/gst/search/${FCI}`);
    expect(a.json).toMatchObject({ legalName: 'FOOD CORPORATION OF INDIA', pincode: '110001', cached: false });
    const b = await api('GET', `/api/v1/gst/search/${FCI}`);
    expect(b.json).toMatchObject({ legalName: 'FOOD CORPORATION OF INDIA', cached: true });
    expect(count(`/v1/gstin/${FCI}`)).toBe(1);
    const fresh = await api('GET', `/api/v1/gst/search/${FCI}?refresh=1`);
    expect(fresh.json.cached).toBe(false);
    expect(count(`/v1/gstin/${FCI}`)).toBe(2);
  });

  it('connects with the portal OTP', async () => {
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/otp`)).status).toBe(200);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '000000' })).json.error.message).toMatch(/Wrong or expired OTP/);
    const v = await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '123456' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.status).toBe('active');
    expect(Date.parse(v.json.sessionExpiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
  });

  it('files GSTR-1: save brings the summary and the OTP, then file', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR1', period: PERIOD });
    ids.r1 = prep.json.id;
    const saved = await api('POST', `/api/v1/gst/filings/${ids.r1}/save`);
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    expect(saved.json).toMatchObject({ status: 'submitted', refId: 'REF-R1', summary: { chksum: 'CK-R1' } });
    expect(state.saved.get('r1').b2b[0].ctin).toBe(FCI);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/status`)).status).toBe(400);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/evc-otp`, {})).json.error.message).toMatch(/sent when you save/);
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: '654321', declaration: true });
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA0901GIFILED' });
  });

  it('files GSTR-3B: save, offset (fresh checksum), OTP, file', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR3B', period: PERIOD });
    ids.r3b = prep.json.id;
    const saved = await api('POST', `/api/v1/gst/filings/${ids.r3b}/save`);
    expect(saved.json).toMatchObject({ status: 'saved', summary: { chksum: 'CK-SAVE' } });
    const prop = await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset/propose`);
    expect(prop.status, JSON.stringify(prop.json)).toBe(200);
    expect(prop.json.offset.pditc).toMatchObject({ liab_ldg_id: 77, i_pdi: 5000 });
    expect(prop.json.cashNeeded.igst).toBe(13000);
    expect(prop.json.shortfall).toBeNull(); // no ledger API: the cash ledger is checked on the portal
    expect(prop.json.note).toMatch(/credit ledger may hold more/);
    const off = await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset`, prop.json.offset);
    expect(off.json).toMatchObject({ status: 'offset', summary: { chksum: 'CK-OFFSET', ret_period: PERIOD } });
    expect((await api('POST', `/api/v1/gst/filings/${ids.r3b}/evc-otp`, {})).status).toBe(200);
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r3b}/file`, { mode: 'evc', otp: '654321', declaration: true });
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA093BGIFILED' });
  });

  it('matches GSTR-2B from the saved copy until refreshed, and keeps the return history', async () => {
    expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: `${month}-01` })).status).toBe(200);
    const one = await api('POST', `/api/v1/gst/connections/${ids.conn}/gstr2b`, { period: PERIOD });
    expect(one.status, JSON.stringify(one.json)).toBe(200);
    expect(one.json).toMatchObject({ fetched: 1, cached: false });
    const two = await api('POST', `/api/v1/gst/connections/${ids.conn}/gstr2b`, { period: PERIOD });
    expect(two.json).toMatchObject({ fetched: 1, cached: true });
    expect(count('/v1/gstr2b/fetch')).toBe(1);
    await api('POST', `/api/v1/gst/connections/${ids.conn}/gstr2b`, { period: PERIOD, refresh: true });
    expect(count('/v1/gstr2b/fetch')).toBe(2);

    const fy = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    await api('POST', `/api/v1/gst/connections/${ids.conn}/sync-returns`, { fyStart: fy, refresh: false });
    await api('POST', `/api/v1/gst/connections/${ids.conn}/sync-returns`, { fyStart: fy, refresh: false });
    expect(count(`/v1/gstin/${SELLER}/returns`)).toBe(1);
    const ov = await api('GET', `/api/v1/gst/connections/${ids.conn}/overview`);
    expect(ov.json.calendar.find((x: any) => x.returnType === 'GSTR3B' && x.period === PERIOD)).toMatchObject({ status: 'filed' });
  });

  it('generates the IRN and the e-way bill from it', async () => {
    const irn = await api('POST', `/api/v1/gst/invoices/${ids.inv}/irn`);
    expect(irn.status, JSON.stringify(irn.json)).toBe(200);
    expect(irn.json).toMatchObject({ irn: 'c'.repeat(64), qr: true });
    const ewb = await api('POST', `/api/v1/gst/invoices/${ids.inv}/eway-bill`, { distance: 0, mode: 'road', vehicleNo: 'UP16 AB 1234' });
    expect(ewb.status, JSON.stringify(ewb.json)).toBe(200);
    expect(ewb.json.ewbNo).toBe('381000000777');
  });

  it('keeps every answer in our database (never the credentials)', async () => {
    const db = new Db(h.env.DATABASE_URL!);
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    const rows = await db.tx({ tenantId: tenant }, (tx) => tx.query<{ action: string; provider: string; data: any }>(`select action, provider, data from gst_events where data is not null order by created_at`));
    const cache = await db.tx({ tenantId: tenant }, (tx) => tx.query<{ kind: string; hits: number }>(`select kind, hits from gst_api_cache`));
    await db.close();
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['search', 'save', 'file.evc', 'offset', 'view.gstr2b', 'irp.generate.call', 'irp.ewb.call']));
    expect(rows.every((r) => r.provider === 'gstinapi')).toBe(true);
    expect(rows.find((r) => r.action === 'irp.generate.call')!.data.SignedQRCode).toBe('eyJ.QR.GI');
    expect(JSON.stringify(rows)).not.toContain('irp-secret');
    expect(cache.find((c) => c.kind === 'taxpayer')!.hits).toBe(1);
  });

  it('in test mode, nothing is marked filed and the return can be prepared again', async () => {
    const db = new Db(h.env.DATABASE_URL!);
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    await db.tx({ tenantId: tenant }, (tx) => tx.query(`update gst_filings set status = 'prepared', arn = null, filed_at = null where return_type = 'GSTR1'`));
    await db.close();
    state.testMode = true;
    const saved = await api('POST', `/api/v1/gst/filings/${ids.r1}/save`);
    expect(saved.json).toMatchObject({ status: 'submitted', portalStatus: 'TEST' });
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: '654321', declaration: true });
    expect(filed.json).toMatchObject({ status: 'submitted', testMode: true });
    expect(filed.json.note).toMatch(/nothing was filed/);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR1', period: PERIOD })).status).toBe(201);
    state.testMode = false;
  });

  it('marks the connection expired when gstinapi.in says it is not connected', async () => {
    state.connected = false;
    const r = await api('POST', `/api/v1/gst/connections/${ids.conn}/gstr2b`, { period: PERIOD, refresh: true });
    expect(r.status).toBe(409);
    expect((await api('GET', '/api/v1/gst/connections')).json.connections[0].status).toBe('expired');
  });
});
