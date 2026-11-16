/**
 * India Compliance as the GSP, against a fake asp.resilient.tech that plays GSTN's side of the
 * encryption with Node's OpenSSL: the app key under GSTN's certificate (RSA PKCS#1 v1.5), the OTP
 * under the app key, data under the session key with HMACs, responses under a per-response key,
 * the EVC signature with "PAN|OTP". Then GSTR-1 and GSTR-3B are filed, the public return track
 * fills the calendar, and the IRN and e-way bill go through the enriched NIC API.
 */
import { constants, createCipheriv, createDecipheriv, createHmac, privateDecrypt, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aesEcbDecrypt, aesEcbEncrypt, fromB64, readRsaPublicKey, rsaPkcs1Encrypt, utf8 } from '../src/services/gst/gstn-crypto';
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
const CERT = readFileSync(join(__dirname, 'fixtures/gstn-test-cert.pem'), 'utf8');
const KEY = readFileSync(join(__dirname, 'fixtures/gstn-test-key.pem'), 'utf8');
const API_KEY = 'ic-test-secret';

/* ───────── OpenSSL side ───────── */
const enc = (data: Buffer | string, key: Buffer) => {
  const c = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([c.update(typeof data === 'string' ? Buffer.from(data) : data), c.final()]).toString('base64');
};
const dec = (b64: string, key: Buffer) => {
  const d = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]);
};
const hmac = (data: Buffer | string, key: Buffer | string) => createHmac('sha256', key).update(data).digest('base64');

const gstn = {
  appKey: null as Buffer | null,
  sek: randomBytes(32),
  authToken: 'AUTH-' + randomBytes(6).toString('hex'),
  saved: new Map<string, any>(),
  filed: new Map<string, string>(),
  evcPan: 'ABCDE1234F',
  evcOtp: '123456',
};
type Call = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: any };
const calls: Call[] = [];

/** a GSTN-style encrypted success response */
function encrypted(result: unknown) {
  const rek = randomBytes(32);
  const b64 = Buffer.from(JSON.stringify(result)).toString('base64');
  return { status_cd: '1', rek: enc(rek, gstn.sek), data: enc(b64, rek), hmac: hmac(Buffer.from(b64), rek) };
}
/** reads an encrypted request body and checks its HMAC (or the EVC signature) */
function readBody(body: any) {
  const b64 = dec(body.data, gstn.sek).toString();
  if (body.st === 'EVC') expect(body.sign).toBe(hmac(Buffer.from(b64), Buffer.from(body.sid)));
  else expect(body.hmac).toBe(hmac(Buffer.from(b64), gstn.sek));
  return JSON.parse(Buffer.from(b64, 'base64').toString());
}
const err = (code: string, message: string) => ({ status_cd: 0, error: { error_cd: code, message } });

function asp(method: string, path: string, q: Record<string, string>, hd: Record<string, string>, body: any): any {
  expect(hd['x-api-key']).toBe(API_KEY);
  if (path === '/static/gstn_public_certificate') return { success: true, message: CERT };
  if (path === '/get-public-ip') return { success: true, ip: '203.0.113.7' };
  if (path === '/commonapi/search') return { success: true, result: { gstin: q.gstin, lgnm: 'FOOD CORPORATION OF INDIA', sts: 'Active', pradr: { addr: { loc: 'New Delhi', stcd: 'Delhi', pncd: '110001' } } } };
  if (path === '/commonapi/returns')
    return { success: true, result: { EFiledlist: [{ rtntype: 'GSTR3B', ret_prd: PERIOD, arn: 'AA090PUBLIC1', dof: '20-05-2026', status: 'Filed', valid: 'Y' }] } };
  if (path === '/standard/gstn_/authenticate' && method === 'POST') {
    expect(hd.gstin).toBe(SELLER);
    expect(hd['state-cd']).toBe('09');
    expect(hd.username).toBe('acme_up');
    expect(hd['ip-usr']).toBe('203.0.113.7');
    if (body.action === 'OTPREQUEST') {
      gstn.appKey = privateDecrypt({ key: KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(body.app_key, 'base64'));
      expect(gstn.appKey.length).toBe(32);
      return { status_cd: 1 };
    }
    if (body.action === 'AUTHTOKEN') {
      const ak = privateDecrypt({ key: KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(body.app_key, 'base64'));
      expect(ak.equals(gstn.appKey!)).toBe(true);
      const otp = dec(body.otp, gstn.appKey!).toString();
      if (otp !== '575757') return err('AUTH4034', 'Invalid OTP');
      return { status_cd: 1, auth_token: gstn.authToken, expiry: 360, sek: enc(gstn.sek, gstn.appKey!) };
    }
    if (body.action === 'REFRESHTOKEN') {
      expect(dec(body.app_key, gstn.sek).equals(gstn.appKey!)).toBe(true);
      return { status_cd: 1, auth_token: gstn.authToken, expiry: 360, sek: enc(gstn.sek, gstn.appKey!) };
    }
  }
  // everything else needs the session
  if (path.startsWith('/standard/gstn_/')) {
    if (hd['auth-token'] !== gstn.authToken) return err('AUTH4033', 'Invalid Session');
    const ep = path.slice('/standard/gstn_/'.length);
    if (ep === 'authenticate' && q.action === 'EVCOTP') {
      expect(q).toMatchObject({ pan: gstn.evcPan, form_type: expect.stringMatching(/^R(1|3B)$/) });
      return err('EVCREQUEST', 'OTP sent to the authorised signatory');
    }
    if (ep === 'ledgers' && q.action === 'BAL')
      return encrypted({ gstin: SELLER, cash_bal: { igst_tot_bal: 0, cgst_tot_bal: 1000, sgst_tot_bal: 1000, cess_tot_bal: 0 }, itc_bal: { igst_bal: 20000, cgst_bal: 0, sgst_bal: 0, cess_bal: 0 } });
    if (ep === 'returns' && q.action === 'RETSTATUS') return encrypted({ status_cd: 'P' });
    if ((ep === 'returns/gstr1' || ep === 'returns/gstr3b') && method === 'PUT' && body.action === 'RETSAVE') {
      expect(hd.ret_period).toBe(PERIOD);
      gstn.saved.set(ep, readBody(body));
      return encrypted({ reference_id: `REF-${ep.split('/')[1]}` });
    }
    if (ep === 'returns/gstrptf' && body.action === 'RETNEWPTF') {
      expect(hd.rtn_typ).toBe('GSTR1');
      expect(readBody(body)).toEqual({ gstin: SELLER, ret_period: PERIOD });
      return encrypted({ reference_id: 'REF-PTF' });
    }
    if (ep === 'returns/gstr3b' && body?.action === 'RETSUBMIT') {
      readBody(body);
      return encrypted({ reference_id: 'REF-3BSUB' });
    }
    if (ep === 'returns/gstr1' && q.action === 'RETSUM') return encrypted({ gstin: SELLER, ret_period: PERIOD, sec_sum: [{ sec_nm: 'B2B', ttl_rec: 1, ttl_val: 118000 }], chksum: 'c1' });
    if (ep === 'returns/gstr3b' && q.action === 'RETSUM')
      return encrypted({
        gstin: SELLER,
        ret_period: PERIOD,
        tx_pmt: { tx_py: [{ trans_typ: 30002, liab_ldg_id: 501, igst: { tx: 18000, intr: 0 }, cgst: { tx: 0, intr: 0, fee: 0 }, sgst: { tx: 0, intr: 0, fee: 0 }, cess: { tx: 0, intr: 0 } }] },
      });
    if (ep === 'returns/gstr3b' && body?.action === 'RETOFFSET') {
      gstn.saved.set('offset', readBody(body));
      return encrypted({});
    }
    if ((ep === 'returns/gstr1' || ep === 'returns/gstr3b') && body?.action === 'RETFILE') {
      expect(body.sid).toBe(`${gstn.evcPan}|${gstn.evcOtp}`);
      const summary = readBody(body);
      expect(summary.ret_period).toBe(PERIOD);
      const ack = `AA09${ep.endsWith('3b') ? '3B' : '01'}PORTAL`;
      gstn.filed.set(ep, ack);
      return encrypted({ ack_num: ack });
    }
    if (ep === 'returns/gstr2b' && q.action === 'GET2B') return err('RET2B1016', 'No document found');
  }
  // enriched NIC
  if (path === '/ei/api/invoice') {
    expect(hd).toMatchObject({ gstin: SELLER, user_name: 'acme_api', password: 'irp-secret' });
    return { success: true, message: 'IRN generated', result: { AckNo: 182610000000555, AckDt: '2026-11-16 15:00:00', Irn: 'b'.repeat(64), SignedQRCode: 'eyJ.QR.IC' } };
  }
  if (path === '/ei/api/ewaybill') return { success: true, result: { EwbNo: 381009990000, EwbDt: '2026-11-16 15:05:00', EwbValidTill: '2026-11-17 23:59:00' } };
  return { success: false, message: `unknown ${method} ${path} ${q.action ?? ''}` };
}

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await makeHarness('synapse_test_gst_ic');
  Object.assign(h.env, { INDIA_COMPLIANCE_API_SECRET: API_KEY, GST_PROVIDER: 'indiacompliance' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'asp.resilient.tech') return realFetch(input, init);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const query = Object.fromEntries(url.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query, headers, body });
    return new Response(JSON.stringify(asp(init?.method ?? 'GET', url.pathname, query, headers, body)), { status: 200, headers: { 'content-type': 'application/json' } });
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

describe('GSTN encryption', () => {
  it('matches OpenSSL', () => {
    const key = randomBytes(32);
    for (const len of [0, 5, 16, 33, 4096]) {
      const data = randomBytes(len);
      expect(aesEcbEncrypt(new Uint8Array(data), new Uint8Array(key))).toBe(enc(data, key));
      expect(Buffer.from(aesEcbDecrypt(enc(data, key), new Uint8Array(key))).equals(data)).toBe(true);
    }
    const pub = readRsaPublicKey(CERT);
    expect(pub.bytes).toBe(256);
    expect(pub.notAfter!.getTime()).toBeGreaterThan(Date.now());
    const c = rsaPkcs1Encrypt(utf8('k'.repeat(32)), pub);
    expect(privateDecrypt({ key: KEY, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(fromB64(c))).toString()).toBe('k'.repeat(32));
    expect(() => aesEcbDecrypt(enc('hello', key), new Uint8Array(randomBytes(32)))).toThrow();
  });
});

describe('GST portal through India Compliance', () => {
  it('says which provider is in use and what it can do', async () => {
    const c = await api('POST', '/api/v1/gst/connections', { gstin: SELLER, gstUsername: 'acme_up', signatoryPan: 'ABCDE1234F', einvUsername: 'acme_api', einvPassword: 'irp-secret' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    ids.conn = c.json.id;
    const list = await api('GET', '/api/v1/gst/connections');
    expect(list.json.gsp).toMatchObject({ provider: 'India Compliance', id: 'indiacompliance', sandbox: false, challan: false, dsc: false, forms: ['GSTR1', 'GSTR3B'] });
    const views = await api('GET', '/api/v1/gst/views');
    expect(views.json.map((v: any) => v.kind)).toContain('ledger_balance');
    expect(views.json.map((v: any) => v.kind)).not.toContain('notices');
    const s = await api('GET', `/api/v1/gst/search/${FCI}`);
    expect(s.json).toMatchObject({ legalName: 'FOOD CORPORATION OF INDIA', pincode: '110001' });
  });

  it('logs in with the OTP: app key under GSTN\'s certificate, session key back under the app key', async () => {
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/otp`)).status).toBe(200);
    const bad = await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '111111' });
    expect(bad.json.error.message).toMatch(/Invalid OTP/);
    const ok = await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '575757' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.status).toBe('active');
    expect(JSON.stringify(ok.json)).not.toContain(gstn.authToken);
  });

  it('reads the ledgers (decrypting the response) and the public return track', async () => {
    const bal = await api('POST', `/api/v1/gst/connections/${ids.conn}/views/ledger_balance`, { period: PERIOD });
    expect(bal.status, JSON.stringify(bal.json)).toBe(200);
    expect(bal.json.data.itc_bal.igst_bal).toBe(20000);
    expect(calls.at(-1)!.query).toMatchObject({ action: 'BAL', gstin: SELLER, ret_period: PERIOD });
    // nothing there is not an error
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/views/gstr2b`, { period: PERIOD })).status).toBe(200);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/views/notices`, { from: '2026-04-01' })).status).toBe(400);
    const fy = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const sync = await api('POST', `/api/v1/gst/connections/${ids.conn}/sync-returns`, { fyStart: fy });
    expect(sync.status, JSON.stringify(sync.json)).toBe(200);
    expect(calls.at(-1)!.path).toBe('/commonapi/returns');
    const ov = await api('GET', `/api/v1/gst/connections/${ids.conn}/overview`);
    expect(ov.json.calendar.find((x: any) => x.returnType === 'GSTR3B' && x.period === PERIOD)).toMatchObject({ status: 'filed', arn: 'AA090PUBLIC1' });
  });

  it('files GSTR-1 with EVC', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR1', period: PERIOD });
    ids.r1 = prep.json.id;
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/save`)).json).toMatchObject({ status: 'saving', refId: 'REF-gstr1' });
    expect(gstn.saved.get('returns/gstr1').b2b[0].ctin).toBe(FCI); // the portal got (and could decrypt) the data
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/status`)).json.status).toBe('saved');
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/proceed`)).json.status).toBe('submitted');
    await api('POST', `/api/v1/gst/filings/${ids.r1}/status`);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/summary`)).json.summary.chksum).toBe('c1');
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'dsc', pan: 'ABCDE1234F', declaration: true })).json.error.message).toMatch(/EVC only/);
    const otp = await api('POST', `/api/v1/gst/filings/${ids.r1}/evc-otp`, {});
    expect(otp.status, JSON.stringify(otp.json)).toBe(200);
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: gstn.evcOtp, declaration: true });
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA0901PORTAL' });
  });

  it('files GSTR-3B: save, submit, offset from ITC, EVC', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR3B', period: PERIOD });
    ids.r3b = prep.json.id;
    expect(prep.json.needsProceed).toBe(true);
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/save`);
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/status`);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r3b}/proceed`)).json.status).toBe('submitted');
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/summary`);
    const prop = await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset/propose`);
    expect(prop.json.offset.pditc).toMatchObject({ liab_ldg_id: 501, i_pdi: 18000 });
    expect(prop.json.shortfall).toEqual({ igst: 0, cgst: 0, sgst: 0, cess: 0 });
    expect((await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset`, prop.json.offset)).json.status).toBe('offset');
    expect(gstn.saved.get('offset').pditc.i_pdi).toBe(18000);
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r3b}/file`, { mode: 'evc', otp: gstn.evcOtp, declaration: true });
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA093BPORTAL' });
  });

  it('keeps other returns to the JSON download, and challans to the portal', async () => {
    const r7 = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR7', period: PERIOD, payload: { gstin: SELLER, fp: PERIOD } });
    expect((await api('POST', `/api/v1/gst/filings/${r7.json.id}/save`)).json.error.message).toMatch(/Download the JSON/);
    const ch = await api('POST', `/api/v1/gst/connections/${ids.conn}/challans`, { period: PERIOD, mode: 'NEFT', email: 'a@b.co', mobile: '9876543210', amounts: { igst: { tax: 1 } } });
    expect(ch.json.error.message).toMatch(/GST portal/);
  });

  it('generates the IRN and e-way bill through the enriched API', async () => {
    const irn = await api('POST', `/api/v1/gst/invoices/${ids.inv}/irn`);
    expect(irn.status, JSON.stringify(irn.json)).toBe(200);
    expect(irn.json).toMatchObject({ ackNo: 182610000000555, qr: true });
    const ewb = await api('POST', `/api/v1/gst/invoices/${ids.inv}/eway-bill`, { distance: 0, mode: 'road', vehicleNo: 'UP16AB1234' });
    expect(ewb.status, JSON.stringify(ewb.json)).toBe(200);
    expect(ewb.json.ewbNo).toBe('381009990000');
  });

  it('ends the session when the portal says so', async () => {
    gstn.authToken = 'ROTATED';
    const r = await api('POST', `/api/v1/gst/connections/${ids.conn}/views/ledger_balance`, { period: PERIOD });
    expect(r.status).toBe(409);
    const list = await api('GET', '/api/v1/gst/connections');
    expect(list.json.connections[0].status).toBe('expired');
  });
});
