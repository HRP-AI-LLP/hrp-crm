/**
 * GST portal through the WhiteBooks GSP, against a fake GSP: connecting a GSTIN with an OTP,
 * GSTR-1 built from invoices and filed (save → status → proceed → summary → EVC), GSTR-3B with the
 * offset, GSTR-2B into reconciliation, ledgers and notices, e-invoice IRN and e-way bill.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { buildGstr1, filingCalendar, toRetPeriod } from '../src/services/gst/returns';
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
const SELLER = gstin('09AAACH1234M1Z'); // Uttar Pradesh
const FCI = '07AAACF0000A1ZV'; // Delhi
const LOCAL = gstin('09AABCK5678P1Z'); // Uttar Pradesh
const month = new Date().toISOString().slice(0, 7);
const PERIOD = toRetPeriod(month);

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

/* ───────── the fake GSP ───────── */
type Call = { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: any };
const calls: Call[] = [];
const realFetch = globalThis.fetch;
const state = { saved: new Map<string, any>(), filed: new Set<string>(), otpTxn: 'TXN-OTP-1', sessionTxn: 'TXN-LIVE-1', failNextStatus: false, irnSeq: 0 };

function gsp(path: string, q: Record<string, string>, hd: Record<string, string>, body: any): any {
  const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ status_cd: '1', status_desc: 'Success', data, ...extra });
  const fail = (message: string, code = 'RET191') => ({ status_cd: '0', status_desc: message, error: { message, error_cd: code } });
  if (path === '/authentication/otprequest') return hd.gst_username === 'acme_up' ? { status_cd: '1', header: { txn: state.otpTxn } } : fail('Username does not exist', 'AUTH4037');
  if (path === '/authentication/authtoken') return q.otp === '575757' && hd.txn === state.otpTxn ? { status_cd: '1', header: { txn: state.sessionTxn } } : fail('Invalid OTP', 'AUTH4033');
  if (path === '/authentication/otpforevc') return ok({ message: 'OTP sent' });
  if (path === '/public/search') return ok({ gstin: q.gstin, lgnm: 'FOOD CORPORATION OF INDIA', tradeNam: 'FCI', sts: 'Active', dty: 'Regular', pradr: { addr: { bnm: '16-20 Barakhamba Lane', loc: 'New Delhi', stcd: 'Delhi', pncd: '110001' } } });
  if (hd.txn !== state.sessionTxn && !path.startsWith('/einvoice') && !path.startsWith('/ewaybillapi')) return fail('Invalid Session', 'AUTH4033');
  if (path === '/ledgers/bal') return ok({ gstin: q.gstin, cash_bal: { igst_tot_bal: 1000, cgst_tot_bal: 500, sgst_tot_bal: 500, cess_tot_bal: 0 }, itc_bal: { igst_bal: 5000, cgst_bal: 200, sgst_bal: 0, cess_bal: 0 } });
  if (path === '/notices/noticelist') return ok({ notices: [{ refId: 'ZA0901', type: 'ASMT-10', date: '01-04-2026' }] });
  if (path === '/gstr/rettrack') return ok({ EFiledlist: [{ rtntype: 'GSTR3B', ret_prd: q.returnperiod, arn: 'AA0904PORTAL', dof: '18-05-2026', status: 'Filed' }] });
  if (/^\/(gstr1|gstr3b)\/retsave$/.test(path)) {
    expect(hd.gstin).toBe(SELLER);
    expect(hd.ret_period).toBe(PERIOD);
    state.saved.set(path, body);
    return ok({ reference_id: `REF-${path.split('/')[1]}` });
  }
  if (path === '/gstr/retstatus') return state.failNextStatus ? ((state.failNextStatus = false), ok({ status_cd: 'ER', error_report: { error_msg: 'Invalid POS' } })) : ok({ status_cd: 'P' });
  if (path === '/all/newproceedfile') return ok({ reference_id: 'REF-PROCEED' });
  if (path === '/gstr1/retsum') return ok({ gstin: q.gstin, ret_period: q.retperiod, sec_sum: [{ sec_nm: 'B2B', ttl_rec: 1, ttl_val: 118000 }], chksum: 'abc' });
  if (path === '/gstr3b/retsum')
    return ok({
      gstin: q.gstin,
      ret_period: q.retperiod,
      tx_pmt: {
        tx_py: [
          { trans_typ: 30002, liab_ldg_id: 111, igst: { tx: 18000, intr: 0 }, cgst: { tx: 900, intr: 0, fee: 0 }, sgst: { tx: 900, intr: 0, fee: 0 }, cess: { tx: 0, intr: 0 } },
          { trans_typ: 30003, liab_ldg_id: 222, igst: { tx: 0, intr: 0 }, cgst: { tx: 0, intr: 0, fee: 0 }, sgst: { tx: 0, intr: 0, fee: 0 }, cess: { tx: 0, intr: 0 } },
        ],
      },
    });
  if (path === '/gstr3b/retoffset') {
    state.saved.set(path, body);
    return ok({ message: 'offset done' });
  }
  if (/\/retevcfile$/.test(path)) {
    expect(q.evcotp).toBe('575757');
    expect(q.pan).toBe('ABCDE1234F');
    expect(body?.ret_period ?? body?.gstin).toBeTruthy();
    state.filed.add(path);
    return ok({ ack_num: `AA09${path.includes('3b') ? '3B' : '01'}26000001` });
  }
  if (path === '/gstr2b/all')
    return ok({
      data: {
        fc: 1,
        docdata: {
          b2b: [{ ctin: gstin('09AAGCS1111B1Z'), trdnm: 'Steel Supplies', inv: [{ inum: 'SS/101', dt: `05-${PERIOD.slice(0, 2)}-${PERIOD.slice(2)}`, val: 11800, txval: 10000, igst: 0, cgst: 900, sgst: 900, cess: 0, itcavl: 'Y' }] }],
          cdnr: [],
        },
      },
    });
  if (path === '/payment/generateChallan') return ok({ cpin: '26090100012345', chln_exp_dt: '30-06-2026' });
  // e-invoice
  if (path === '/einvoice/authenticate') {
    expect(hd.username).toBe('acme_api');
    expect(hd.password).toBe('irp-secret');
    return { status_cd: 'Sucess', data: { AuthToken: 'IRPTOKEN', TokenExpiry: '2099-01-01 00:00:00' } };
  }
  if (path === '/einvoice/type/GENERATE/version/V1_03') {
    expect(hd['auth-token']).toBe('IRPTOKEN');
    expect(body.DocDtls.No).toBeTruthy();
    state.irnSeq++;
    return { status_cd: '1', data: { AckNo: 112010000000123, AckDt: '2026-05-10 12:00:00', Irn: 'a'.repeat(63) + String(state.irnSeq), SignedQRCode: 'eyJhbGciOi.QR' } };
  }
  if (path === '/einvoice/type/GENERATE_EWAYBILL/version/V1_03') return { status_cd: '1', data: { EwbNo: 391001234567, EwbDt: '2026-05-10 12:05:00', EwbValidTill: '2026-05-11 23:59:00' } };
  if (path === '/ewaybillapi/v1.03/authenticate') return { status_cd: '1', status_desc: 'Success' };
  if (path === '/ewaybillapi/v1.03/ewayapi/genewaybill') {
    expect(body.toGstin).toBe(LOCAL);
    expect(body.itemList.length).toBe(1);
    return { status_cd: '1', data: { ewayBillNo: 391009999999, ewayBillDate: '10/05/2026 12:10:00 PM', validUpto: '11/05/2026 11:59:00 PM' } };
  }
  return fail(`unknown path ${path}`, 'X404');
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_gst');
  Object.assign(h.env, { WHITEBOOKS_CLIENT_ID: 'wb-client', WHITEBOOKS_CLIENT_SECRET: 'wb-secret', WHITEBOOKS_EMAIL: 'gsp@acme.test', WHITEBOOKS_ENV: 'sandbox' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'apisandbox.whitebooks.in') return realFetch(input, init);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    expect(headers.client_id).toBe('wb-client');
    expect(headers.client_secret).toBe('wb-secret');
    expect(url.searchParams.get('email')).toBe('gsp@acme.test');
    const query = Object.fromEntries(url.searchParams.entries());
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname, query, headers, body });
    return new Response(JSON.stringify(gsp(url.pathname, query, headers, body)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'purchasing', 'books']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'HRP AI LLP', state: 'Uttar Pradesh', gstin: SELLER, address: 'B-12 Sector 62, Noida 201301' } } });
  const fci = await api('POST', '/api/v1/records/account', { name: 'Food Corporation of India', account_type: 'government', gstin: FCI, state: 'Delhi' });
  expect(fci.status, JSON.stringify(fci.json)).toBe(201);
  ids.fci = fci.json.id;
  const loc = await api('POST', '/api/v1/records/account', { name: 'Kanpur Traders', gstin: LOCAL, state: 'Uttar Pradesh', address: '7 Mall Road, Kanpur', pincode: '208001' });
  expect(loc.status, JSON.stringify(loc.json)).toBe(201);
  ids.local = loc.json.id;
  const walkin = await api('POST', '/api/v1/records/account', { name: 'Walk-in Delhi buyer', state: 'Delhi' });
  expect(walkin.status, JSON.stringify(walkin.json)).toBe(201);
  ids.walkin = walkin.json.id;

  async function invoice(account: string, lines: unknown[]) {
    const inv = await api('POST', '/api/v1/records/invoice', { name: 'Supply', account_id: account });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    const l = await api('PUT', `/api/v1/invoices/${inv.json.id}/lines`, { lines });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    const iss = await api('POST', `/api/v1/invoices/${inv.json.id}/issue`);
    expect(iss.status, JSON.stringify(iss.json)).toBe(200);
    return inv.json.id as string;
  }
  ids.inv1 = await invoice(ids.fci!, [{ name: 'IoT monitoring — milestone 1', hsnSac: '998314', quantity: 1, unitPrice: 100000, taxRate: 18 }]);
  ids.inv2 = await invoice(ids.local!, [{ name: 'Sensor kit', hsnSac: '8531', quantity: 10, unitPrice: 1000, taxRate: 18, unit: 'nos' }]);
  ids.inv3 = await invoice(ids.walkin!, [{ name: 'Gateway', hsnSac: '8517', quantity: 1, unitPrice: 150000, taxRate: 18, unit: 'nos' }]); // B2CL (> ₹1 lakh inter-state)
  ids.inv4 = await invoice(ids.walkin!, [{ name: 'Cable', hsnSac: '8544', quantity: 2, unitPrice: 500, taxRate: 18, unit: 'nos' }]); // B2CS
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('GST portal through WhiteBooks', () => {
  it('builds GSTR-1 in the portal format from issued invoices', async () => {
    const db = new Db(h.env.DATABASE_URL!);
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    const g = await db.tx({ tenantId: tenant }, (tx) =>
      buildGstr1({ tx, tenantId: tenant, meta: null as never, principal: { permissions: { admin: ['*'] } } as never }, SELLER, month),
    );
    await db.close();
    const p = g.payload as any;
    expect(p.gstin).toBe(SELLER);
    expect(p.fp).toBe(PERIOD);
    expect(p.b2b.map((x: any) => x.ctin).sort()).toEqual([FCI, LOCAL].sort());
    const fciInv = p.b2b.find((x: any) => x.ctin === FCI).inv[0];
    expect(fciInv).toMatchObject({ val: 118000, pos: '07', rchrg: 'N', inv_typ: 'R' });
    expect(fciInv.itms[0]).toEqual({ num: 1, itm_det: { txval: 100000, rt: 18, iamt: 18000, csamt: 0 } });
    const localInv = p.b2b.find((x: any) => x.ctin === LOCAL).inv[0];
    expect(localInv.itms[0].itm_det).toEqual({ txval: 10000, rt: 18, camt: 900, samt: 900, csamt: 0 });
    expect(p.b2cl).toEqual([{ pos: '07', inv: [expect.objectContaining({ val: 177000, itms: [{ num: 1, itm_det: { txval: 150000, rt: 18, iamt: 27000, csamt: 0 } }] })] }]);
    expect(p.b2cs).toEqual([{ sply_ty: 'INTER', pos: '07', typ: 'OE', rt: 18, txval: 1000, iamt: 180, csamt: 0 }]);
    expect(p.hsn.hsn_b2b.find((x: any) => x.hsn_sc === '998314')).toMatchObject({ uqc: 'NA', qty: 0, txval: 100000, iamt: 18000 });
    expect(p.hsn.hsn_b2c.length).toBe(2);
    expect(p.doc_issue.doc_det[0]).toMatchObject({ doc_num: 1, docs: [expect.objectContaining({ totnum: 4, cancel: 0, net_issue: 4 })] });
  });

  it('adds the GSTIN, refuses a bad one and never returns the stored passwords', async () => {
    expect((await api('POST', '/api/v1/gst/connections', { gstin: '09AAACH1234M1ZZ' })).status).toBe(400);
    const c = await api('POST', '/api/v1/gst/connections', { gstin: SELLER, gstUsername: 'acme_up', signatoryPan: 'ABCDE1234F', einvUsername: 'acme_api', einvPassword: 'irp-secret', ewbUsername: 'acme_ewb', ewbPassword: 'ewb-secret' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    ids.conn = c.json.id;
    expect(c.json).toMatchObject({ gstin: SELLER, status: 'disconnected', hasEinvPassword: true, hasEwbPassword: true });
    const list = await api('GET', '/api/v1/gst/connections');
    expect(list.json.gsp).toMatchObject({ provider: 'WhiteBooks', id: 'whitebooks', configured: true, sandbox: true, challan: true, dsc: true });
    expect(list.text).not.toContain('irp-secret');
    expect(list.text).not.toContain('ewb-secret');
    // the public taxpayer search needs no OTP
    const s = await api('GET', `/api/v1/gst/search/${FCI}`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json).toMatchObject({ legalName: 'FOOD CORPORATION OF INDIA', status: 'Active', pincode: '110001' });
  });

  it('needs the OTP before any portal call, then keeps a 6-hour session', async () => {
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/views/ledger_balance`, { period: PERIOD })).status).toBe(409);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '575757' })).status).toBe(400); // no OTP requested yet
    const otp = await api('POST', `/api/v1/gst/connections/${ids.conn}/otp`);
    expect(otp.status, JSON.stringify(otp.json)).toBe(200);
    expect(calls.at(-1)!.headers).toMatchObject({ gst_username: 'acme_up', state_cd: '09' });
    const bad = await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '111111' });
    expect(bad.status).toBe(502);
    expect(bad.json.error.message).toMatch(/Invalid OTP/);
    // a username the sandbox does not know gets the sandbox hint
    await api('PATCH', `/api/v1/gst/connections/${ids.conn}`, { gstin: SELLER, gstUsername: 'real_user' });
    const unknown = await api('POST', `/api/v1/gst/connections/${ids.conn}/otp`);
    expect(unknown.json.error.message).toMatch(/does not exist.*SANDBOX/);
    await api('PATCH', `/api/v1/gst/connections/${ids.conn}`, { gstin: SELLER, gstUsername: 'acme_up' });
    await api('POST', `/api/v1/gst/connections/${ids.conn}/otp`);
    const v = await api('POST', `/api/v1/gst/connections/${ids.conn}/verify`, { otp: '575757' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.status).toBe('active');
    expect(Date.parse(v.json.sessionExpiresAt) - Date.now()).toBeGreaterThan(5.9 * 3600_000);
    expect(JSON.stringify(v.json)).not.toContain('TXN-');
  });

  it('shows ledgers, notices and returns already filed on the portal', async () => {
    const bal = await api('POST', `/api/v1/gst/connections/${ids.conn}/views/ledger_balance`, { period: PERIOD });
    expect(bal.status, JSON.stringify(bal.json)).toBe(200);
    expect(bal.json.data.itc_bal.igst_bal).toBe(5000);
    expect(calls.at(-1)!.headers.txn).toBe('TXN-LIVE-1');
    const notices = await api('POST', `/api/v1/gst/connections/${ids.conn}/views/notices`, { from: '2026-04-01' });
    expect(notices.status).toBe(200);
    expect(calls.at(-1)!.query.date).toBe('01-04-2026'); // sent as dd-mm-yyyy
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/views/nope`, {})).status).toBe(400);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/views/notices`, { from: "1'; drop" })).status).toBe(400);
    await api('POST', `/api/v1/gst/connections/${ids.conn}/views/return_track`, { period: PERIOD });
    const ov = await api('GET', `/api/v1/gst/connections/${ids.conn}/overview`);
    expect(ov.status, JSON.stringify(ov.json)).toBe(200);
    expect(ov.json.ledgerBalance.data.cash_bal.igst_tot_bal).toBe(1000);
    const threeB = ov.json.calendar.find((x: any) => x.returnType === 'GSTR3B' && x.period === PERIOD);
    expect(threeB).toMatchObject({ status: 'filed', arn: 'AA0904PORTAL', source: 'portal' });
  });

  it('files GSTR-1: save, status, proceed to file, summary, EVC', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR1', period: PERIOD });
    expect(prep.status, JSON.stringify(prep.json)).toBe(201);
    ids.r1 = prep.json.id;
    expect(prep.json.counts).toMatchObject({ b2b: 2, b2cl: 1, b2cs: 1 });
    // filing before the summary is refused
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: '575757', declaration: true })).status).toBe(409);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/save`)).json).toMatchObject({ status: 'saving', refId: 'REF-gstr1' });
    expect(state.saved.get('/gstr1/retsave').b2b.length).toBe(2);
    // an error on the portal is shown with its report, and the data can be saved again
    state.failNextStatus = true;
    const err = await api('POST', `/api/v1/gst/filings/${ids.r1}/status`);
    expect(err.json).toMatchObject({ status: 'error', portalStatus: 'ER', errorReport: { error_msg: 'Invalid POS' } });
    await api('POST', `/api/v1/gst/filings/${ids.r1}/save`);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/status`)).json.status).toBe('saved');
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/proceed`)).json.status).toBe('submitted');
    expect(calls.at(-1)!.query).toMatchObject({ type: 'R1', isNil: 'N', retperiod: PERIOD });
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/status`)).json.status).toBe('submitted');
    const sum = await api('POST', `/api/v1/gst/filings/${ids.r1}/summary`);
    expect(sum.json.summary.sec_sum[0].sec_nm).toBe('B2B');
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/evc-otp`, {})).status).toBe(200);
    expect(calls.at(-1)!.query).toMatchObject({ pan: 'ABCDE1234F', form_type: 'R1' });
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: '575757' })).status).toBe(400); // no declaration
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r1}/file`, { mode: 'evc', otp: '575757', declaration: true });
    expect(filed.status, JSON.stringify(filed.json)).toBe(200);
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA090126000001', filingMode: 'evc' });
    expect(calls.at(-1)!.body.sec_sum).toBeTruthy(); // the summary is what gets filed
    // a filed return cannot be prepared or saved again
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR1', period: PERIOD })).status).toBe(409);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r1}/save`)).status).toBe(409);
    const detail = await api('GET', `/api/v1/gst/filings/${ids.r1}`);
    expect(detail.json.events.map((e: any) => e.action)).toEqual(expect.arrayContaining(['prepare', 'save', 'status', 'proceed', 'summary', 'evc.otp', 'file.evc']));
  });

  it('files GSTR-3B after offsetting the liability from ITC and cash', async () => {
    const prep = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR3B', period: PERIOD });
    expect(prep.status, JSON.stringify(prep.json)).toBe(201);
    ids.r3b = prep.json.id;
    const p = prep.json.payload;
    expect(p.sup_details.osup_det).toMatchObject({ txval: 261000, iamt: 18000 + 27000 + 180, camt: 900, samt: 900 });
    expect(p.inter_sup.unreg_details).toEqual([{ pos: '07', txval: 151000, iamt: 27180 }]);
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/save`);
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/status`);
    await api('POST', `/api/v1/gst/filings/${ids.r3b}/summary`);
    expect((await api('POST', `/api/v1/gst/filings/${ids.r3b}/file`, { mode: 'evc', otp: '575757', declaration: true })).json.error.message).toMatch(/Offset/);
    const prop = await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset/propose`);
    expect(prop.status, JSON.stringify(prop.json)).toBe(200);
    // ITC: IGST 5000 (IGST first), CGST 200; the rest from cash
    expect(prop.json.offset.pditc).toMatchObject({ liab_ldg_id: 111, trans_typ: 30002, i_pdi: 5000, i_pdc: 0, i_pds: 0, c_pdc: 200 });
    expect(prop.json.offset.pdcash[0]).toMatchObject({ liab_ldg_id: 111, ipd: 13000, cpd: 700, spd: 900 });
    expect(prop.json.shortfall).toEqual({ igst: 12000, cgst: 200, sgst: 400, cess: 0 });
    expect((await api('POST', `/api/v1/gst/filings/${ids.r3b}/offset`, prop.json.offset)).json.status).toBe('offset');
    expect(state.saved.get('/gstr3b/retoffset').pditc.i_pdi).toBe(5000);
    const filed = await api('POST', `/api/v1/gst/filings/${ids.r3b}/file`, { mode: 'evc', otp: '575757', declaration: true });
    expect(filed.json).toMatchObject({ status: 'filed', arn: 'AA093B26000001' });
  });

  it('creates a challan for the cash shortfall', async () => {
    const ch = await api('POST', `/api/v1/gst/connections/${ids.conn}/challans`, { period: PERIOD, mode: 'NEFT', email: 'tax@acme.test', mobile: '9876543210', amounts: { igst: { tax: 12000 }, cgst: { tax: 200 }, sgst: { tax: 400 } } });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    expect(ch.json).toMatchObject({ cpin: '26090100012345', total: 12600 });
    expect(calls.at(-1)!.body).toMatchObject({ igst_tax_amt: 12000, igst_tot_amt: 12000, total_amt: 12600, chln_prd: PERIOD, payment_mod: 'NEFT' });
  });

  it('brings GSTR-2B into the purchase reconciliation', async () => {
    expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: `${month}-01` })).status).toBe(200);
    const r = await api('POST', `/api/v1/gst/connections/${ids.conn}/gstr2b`, { period: PERIOD });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.fetched).toBe(1);
    const rep = await api('GET', `/api/v1/books/reports/gstr-2b?period=${PERIOD}`);
    expect(rep.status, JSON.stringify(rep.json)).toBe(200);
    expect(JSON.stringify(rep.json)).toContain('SS/101');
  });

  it('accepts uploaded portal JSON for other returns, but only for the same GSTIN', async () => {
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR7', period: PERIOD })).status).toBe(400);
    expect((await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR7', period: PERIOD, payload: { gstin: FCI, fp: PERIOD, tds: [] } })).status).toBe(400);
    const ok = await api('POST', `/api/v1/gst/connections/${ids.conn}/filings`, { returnType: 'GSTR7', period: PERIOD, payload: { gstin: SELLER, fp: PERIOD, tds: [] } });
    expect(ok.status).toBe(201);
    expect(ok.json.source).toBe('upload');
  });

  it('generates the IRN and the e-way bill for an invoice', async () => {
    const irn = await api('POST', `/api/v1/gst/invoices/${ids.inv1}/irn`);
    expect(irn.status, JSON.stringify(irn.json)).toBe(200);
    expect(irn.json).toMatchObject({ ackNo: 112010000000123, qr: true });
    expect((await api('POST', `/api/v1/gst/invoices/${ids.inv1}/irn`)).status).toBe(409);
    const ewb = await api('POST', `/api/v1/gst/invoices/${ids.inv1}/eway-bill`, { distance: 0, mode: 'road', vehicleNo: 'UP16 AB 1234' });
    expect(ewb.status, JSON.stringify(ewb.json)).toBe(200);
    expect(ewb.json.ewbNo).toBe('391001234567');
    expect(calls.at(-1)!.body).toMatchObject({ Distance: 0, TransMode: '1', VehNo: 'UP16AB1234' });
    const st = await api('GET', `/api/v1/gst/invoices/${ids.inv1}`);
    expect(st.json).toMatchObject({ irn: expect.stringMatching(/^a{63}1$/), ewbNo: '391001234567', qr: 'eyJhbGciOi.QR' });
    // an invoice without IRN goes straight to the e-way bill system
    const direct = await api('POST', `/api/v1/gst/invoices/${ids.inv2}/eway-bill`, { distance: 85, mode: 'road', vehicleNo: 'UP78CD5678' });
    expect(direct.status, JSON.stringify(direct.json)).toBe(200);
    expect(direct.json.ewbNo).toBe('391009999999');
    // the IRN can't be cancelled while the e-way bill is live
    expect((await api('POST', `/api/v1/gst/invoices/${ids.inv1}/irn/cancel`, { reason: 'data_entry_mistake', remark: 'wrong rate' })).json.error.message).toMatch(/e-way bill first/);
    // the issued-invoice guard still protects the tax content
    const db = new Db(h.env.DATABASE_URL!);
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
    await expect(db.tx({ tenantId: tenant }, (tx) => tx.query(`update invoices set grand_total = 1 where id = $1`, [ids.inv1]))).rejects.toThrow(/cannot be changed/);
    await db.close();
  });

  it('keeps the GST portal to books and billing admins', async () => {
    const r = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: 'Str0ng-Passw0rd!', roles: ['sales_rep'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
    expect((await rep('GET', '/api/v1/gst/connections')).status).toBe(403);
    expect((await rep('POST', `/api/v1/gst/invoices/${ids.inv2}/irn`)).status).toBe(403);
  });

  it('lists due dates by filing frequency', () => {
    const m = filingCalendar(SELLER, 'monthly', '2026-04', '2026-06');
    expect(m.filter((x) => x.returnType === 'GSTR3B').map((x) => x.dueDate)).toEqual(['2026-05-20', '2026-06-20', '2026-07-20']);
    const q = filingCalendar(SELLER, 'quarterly', '2026-04', '2026-06');
    expect(q.map((x) => [x.returnType, x.dueDate])).toEqual([
      ['GSTR1', '2026-07-13'],
      ['GSTR3B', '2026-07-24'], // Uttar Pradesh: 24th
    ]);
    expect(filingCalendar(gstin('27AAACH1234M1Z'), 'quarterly', '2026-06', '2026-06').find((x) => x.returnType === 'GSTR3B')!.dueDate).toBe('2026-07-22');
  });
});
