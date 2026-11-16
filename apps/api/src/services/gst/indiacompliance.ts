/**
 * India Compliance (Resilient Tech) as the GST Suvidha Provider: https://asp.resilient.tech.
 *
 * - Returns, ledgers and the portal session use GSTN's standard API, passed through as is, so the
 *   app does GSTN's encryption: the app key goes to GSTN under its public certificate (RSA), the
 *   OTP and data under AES-256 keys, with HMACs; responses come back encrypted with a per-response
 *   key. There is no returns sandbox: calls reach the live GST portal.
 * - E-invoice and e-way bill use the provider's "enriched" API (it encrypts); these have a test
 *   mode with the provider's own test taxpayer (INDIA_COMPLIANCE_TEST_MODE=true).
 * - Billing is per call (1 credit = 1 call to the government system).
 *
 * The API key (INDIA_COMPLIANCE_API_SECRET) comes from an India Compliance account; see
 * `pnpm gst:ic-account`.
 */
import type { Env } from '../../env';
import { ApiError } from '../../lib/errors';
import { aesEcbDecrypt, aesEcbEncrypt, fromB64, fromUtf8, hmacSha256B64, newAppKey, readRsaPublicKey, rsaPkcs1Encrypt, toB64, utf8, type RsaPublicKey } from './gstn-crypto';
import type { EwbOp, Form, GspConn, GspProvider, GspResult, GstOp, IrpOp, NicStep, Secrets, Session } from './provider';

export const IC_BASE = 'https://asp.resilient.tech';

interface IcConfig {
  base: string;
  key: string;
  nicTest: boolean;
}

export function icConfig(env: Env): IcConfig | null {
  const key = env.INDIA_COMPLIANCE_API_SECRET?.trim();
  if (!key) return null;
  let base = (env.INDIA_COMPLIANCE_BASE_URL?.trim() || IC_BASE).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) base = IC_BASE;
  return { base, key, nicTest: /^(1|true|yes)$/i.test(env.INDIA_COMPLIANCE_TEST_MODE ?? '') };
}

const rid = (n = 12) => {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return 'IC' + Array.from(crypto.getRandomValues(new Uint8Array(n - 2)), (x) => a[x % 36]).join('');
};

/** The provider's own test taxpayers for e-invoice and e-way bill (published in its open-source app). */
const NIC_TEST = {
  einv: { gstin: '02AMBPG7773M002', username: 'adqgsphpusr1', password: 'Gsp@1234' },
  ewb: { gstin: '05AAACG2115R1ZN', username: '05AAACG2115R1ZN', password: 'abc123@@' },
};

interface Raw {
  status: number;
  json: any;
}

async function send(cfg: IcConfig, method: 'GET' | 'POST' | 'PUT', path: string, opts: { query?: Record<string, string | undefined>; headers?: Record<string, string | undefined>; body?: unknown; timeoutMs?: number } = {}): Promise<Raw> {
  if (!/^[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) throw new Error('bad GSP path');
  const url = new URL(`${cfg.base}/${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  const headers: Record<string, string> = { accept: 'application/json', 'x-api-key': cfg.key };
  for (const [k, v] of Object.entries(opts.headers ?? {})) if (v !== undefined && v !== null && v !== '') headers[k] = v;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url.toString(), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ApiError(504, 'gsp_unreachable', timeout ? 'The GST system did not answer in time. Try again in a minute.' : 'Could not reach India Compliance');
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (res.status === 429) throw new ApiError(402, 'gsp_credits', 'Your India Compliance API credits are used up. Buy more credits on your India Compliance account.');
  if (res.status === 401 || (res.status === 403 && json?.error === 'access_denied'))
    throw new ApiError(502, 'gsp_error', 'India Compliance could not connect to the GSP. Write to api-support@indiacompliance.app if this continues.');
  if (res.status === 403) throw new ApiError(502, 'gsp_error', 'India Compliance refused the API key (INDIA_COMPLIANCE_API_SECRET). Check it, or sign in again with pnpm gst:ic-account.');
  if (res.status === 502 || res.status === 503 || res.status === 504) throw new ApiError(504, 'gsp_unreachable', 'The GST system is not answering right now. Try again in a few minutes.');
  if (!res.ok && !json) throw new ApiError(502, 'gsp_error', `India Compliance answered HTTP ${res.status}`);
  return { status: res.status, json };
}

const bad = (message: string, code: string | null, raw: unknown): GspResult => ({ ok: false, httpStatus: 200, data: null, header: null, raw, message: message || 'The GST system returned an error', code });
const good = (data: any, raw: unknown): GspResult => ({ ok: true, httpStatus: 200, data, header: null, raw, message: 'OK', code: null });
const asBool = (v: unknown) => !(v === false || v === 'false' || v === 'False' || v === 0);

/* ───────────────────────── GSTN public certificate ───────────────────────── */

let certCache: { key: RsaPublicKey; at: number } | null = null;
async function gstnKey(cfg: IcConfig, force = false): Promise<RsaPublicKey> {
  if (!force && certCache && Date.now() - certCache.at < 24 * 3600_000 && (!certCache.key.notAfter || certCache.key.notAfter.getTime() > Date.now())) return certCache.key;
  const r = await send(cfg, 'GET', 'static/gstn_public_certificate');
  const pem = r.json?.message ?? r.json?.result?.message ?? r.json?.result;
  if (typeof pem !== 'string' || !pem.includes('BEGIN')) throw new ApiError(502, 'gsp_error', "Could not get GSTN's public certificate from India Compliance");
  certCache = { key: readRsaPublicKey(pem), at: Date.now() };
  return certCache.key;
}

/* ───────────────────────── GSTN standard API ───────────────────────── */

const FORM_PATH: Partial<Record<Form, string>> = { GSTR1: 'returns/gstr1', GSTR3B: 'returns/gstr3b' };
const EVC_TYPE: Partial<Record<Form, string>> = { GSTR1: 'R1', GSTR3B: 'R3B' };

/** Error codes that mean "log in again with an OTP". */
const SESSION_CODES = new Set(['AUTH4033', 'AUTH4038', 'AUTH158', 'RET11402', 'RET2B1010', 'RT-R1R3BAV-1007', 'RETOTPREQUEST']);
/** Error codes that only mean "nothing there". */
const EMPTY_CODES = new Set(['RET11416', 'RET12501', 'RET13508', 'RET13509', 'RET13510', 'RET2B1016', 'RT-3BAS1009', 'RET11417', 'RETWEB_04', 'RET11417', 'GTR2B-002', 'GTR2B-001', 'RET2B1023', 'RTNECO-01']);

interface GstnCall {
  method: 'GET' | 'POST' | 'PUT';
  endpoint: string;
  action?: string;
  query?: Record<string, string | undefined>;
  period?: string;
  returnType?: string;
  /** body: { action, data, ... }; `data` is encrypted with the session key */
  body?: Record<string, unknown>;
  /** EVC filing: sign the data with "PAN|OTP" instead of the HMAC */
  evcSid?: string;
  auth?: boolean;
}

async function gstn(cfg: IcConfig, c: GspConn, s: Session, ip: string, call: GstnCall): Promise<GspResult> {
  const ic = s.ic;
  const sek = ic?.sek ? fromB64(ic.sek) : null;
  const headers: Record<string, string | undefined> = {
    gstin: c.gstin,
    'state-cd': c.gstin.slice(0, 2),
    username: c.gstUsername ?? undefined,
    txn: rid(32),
    'ip-usr': ic?.ip ?? ip,
  };
  if (call.auth !== false) headers['auth-token'] = ic?.authToken;
  if (call.period) headers.ret_period = call.period;
  if (call.returnType) {
    headers.rtn_typ = call.returnType;
    headers.userrole = call.returnType;
  }
  const query: Record<string, string | undefined> = call.method === 'GET' ? { action: call.action, gstin: c.gstin, ...(call.query ?? {}) } : { ...(call.query ?? {}) };
  let body: Record<string, unknown> | undefined;
  if (call.body) {
    body = { ...call.body };
    if (body.data !== undefined) {
      if (!sek) throw new ApiError(409, 'gst_session_required', 'Connect to the GST portal first (OTP)');
      const b64 = toB64(utf8(JSON.stringify(body.data)));
      body.data = aesEcbEncrypt(utf8(b64), sek);
      if (call.evcSid) {
        body.st = 'EVC';
        body.sid = call.evcSid;
        body.sign = await hmacSha256B64(utf8(b64), utf8(call.evcSid));
      } else {
        body.hmac = await hmacSha256B64(utf8(b64), sek);
      }
    }
  }
  const r = await send(cfg, call.method, `standard/gstn_/${call.endpoint}`, { query, headers, body });
  const j = r.json ?? {};
  if (!asBool(j.success)) return bad(String(j.message ?? 'India Compliance returned an error'), null, j);
  if (String(j.status_cd ?? '1') === '0') {
    const err = j.error ?? {};
    return bad(String(err.message ?? j.message ?? 'The GST portal returned an error'), err.error_cd ? String(err.error_cd) : null, j);
  }
  // decrypt: data under the response key (rek), itself under the session key
  if (typeof j.data === 'string' && j.data) {
    if (!sek) return bad('The GST portal session key is missing; connect again', 'AUTH4033', j);
    const key = j.rek ? aesEcbDecrypt(j.rek, sek) : sek;
    const dec = aesEcbDecrypt(j.data, key);
    if (j.hmac && (await hmacSha256B64(dec, key)) !== j.hmac) return bad('The response failed its integrity check (HMAC); try again', 'HMAC', null);
    let result: any;
    try {
      result = JSON.parse(fromUtf8(fromB64(fromUtf8(dec))));
    } catch {
      return bad('Could not read the decrypted response', 'PARSE', null);
    }
    const { data: _d, rek: _r, hmac: _h, ...meta } = j;
    return { ...good(result, meta), header: meta };
  }
  return good(j.result ?? j, j);
}

/* ───────────────────────── the provider ───────────────────────── */

export function indiaComplianceProvider(env: Env): GspProvider | null {
  const cfg = icConfig(env);
  if (!cfg) return null;

  async function publicIp(): Promise<string> {
    const r = await send(cfg!, 'GET', 'get-public-ip');
    const ip = r.json?.ip ?? r.json?.result?.ip ?? r.json?.message?.ip;
    if (!ip) throw new ApiError(502, 'gsp_error', 'Could not get the public IP address from India Compliance');
    return String(ip);
  }

  async function auth(c: GspConn, s: Session, ip: string, body: Record<string, unknown>) {
    const r = await send(cfg!, 'POST', 'standard/gstn_/authenticate', {
      headers: { gstin: c.gstin, 'state-cd': c.gstin.slice(0, 2), username: c.gstUsername ?? undefined, txn: rid(32), 'ip-usr': s.ic?.ip ?? ip },
      body: { ...body, username: c.gstUsername },
    });
    const j = r.json ?? {};
    if (!asBool(j.success)) return bad(String(j.message ?? 'India Compliance returned an error'), null, j);
    if (String(j.status_cd ?? '1') === '0') return bad(String(j.error?.message ?? 'The GST portal returned an error'), j.error?.error_cd ? String(j.error.error_cd) : null, j);
    return good(j.result ?? j, { status_cd: j.status_cd, expiry: j.expiry });
  }

  function takeToken(r: GspResult, s: Session): { session: Session; minutes: number } | null {
    const d = r.data ?? {};
    const token = d.auth_token;
    const sek = d.sek;
    if (!token || !sek || !s.ic) return null;
    const key = aesEcbDecrypt(String(sek), utf8(s.ic.appKey));
    const minutes = Number(d.expiry) > 0 ? Math.min(Number(d.expiry), 360) : 360;
    return { session: { ...s, ic: { ...s.ic, authToken: String(token), sek: toB64(key) } }, minutes };
  }

  const p: GspProvider = {
    id: 'indiacompliance',
    label: 'India Compliance',
    sandbox: false,
    nicSandbox: cfg.nicTest,
    views: ['ledger_balance', 'cash_ledger', 'itc_ledger', 'liability_ledger', 'return_track', 'return_status', 'gstr1_summary', 'gstr3b_summary', 'gstr3b_autoliab', 'gstr3b_interest', 'gstr2b'],
    forms: ['GSTR1', 'GSTR3B'],
    proceed: (form) => (form === 'GSTR1' ? 'r1' : form === 'GSTR3B' ? 'submit' : null),
    challan: false,
    dsc: false,
    hint: (m) => m,
    sessionGone: (r) => SESSION_CODES.has(r.code ?? '') || /invalid session|session (has )?expired|auth(entication)? token/i.test(r.message),

    async requestOtp(c, s, ip) {
      const appKey = newAppKey();
      const realIp = await publicIp().catch(() => ip);
      const fresh: Session = { ...s, ic: { appKey, ip: realIp } };
      const key = await gstnKey(cfg);
      let r = await auth(c, fresh, ip, { action: 'OTPREQUEST', app_key: rsaPkcs1Encrypt(utf8(appKey), key) });
      if (!r.ok && r.code === 'TEC4002') {
        // GSTN changed its certificate
        r = await auth(c, fresh, ip, { action: 'OTPREQUEST', app_key: rsaPkcs1Encrypt(utf8(appKey), await gstnKey(cfg, true)) });
      }
      return { result: r, session: fresh };
    },
    async verifyOtp(c, s, otp, ip) {
      if (!s.ic) return { result: bad('Request an OTP first', null, null), session: s };
      const key = await gstnKey(cfg);
      const r = await auth(c, s, ip, { action: 'AUTHTOKEN', app_key: rsaPkcs1Encrypt(utf8(s.ic.appKey), key), otp: aesEcbEncrypt(utf8(otp), utf8(s.ic.appKey)) });
      if (!r.ok) return { result: r, session: s };
      const t = takeToken(r, s);
      if (!t) return { result: bad('The GST portal did not return a session', null, null), session: s };
      return { result: r, session: t.session, minutes: t.minutes };
    },
    async refresh(c, s, ip) {
      if (!s.ic?.sek || !s.ic.authToken) return { result: bad('No session to refresh', 'AUTH4033', null), session: s };
      const r = await auth(c, s, ip, { action: 'REFRESHTOKEN', app_key: aesEcbEncrypt(utf8(s.ic.appKey), fromB64(s.ic.sek)), auth_token: s.ic.authToken });
      if (!r.ok) return { result: r, session: s };
      const t = takeToken(r, s);
      return t ? { result: r, session: t.session, minutes: t.minutes } : { result: bad('The GST portal did not return a session', null, null), session: s };
    },
    async logout() {
      // GSTN sessions simply expire; nothing to call
    },

    async call(c, s, ip, op: GstOp) {
      const q = (x: Record<string, string | undefined>) => x;
      switch (op.op) {
        case 'view': {
          const v = op.q;
          const m: Record<string, GstnCall> = {
            ledger_balance: { method: 'GET', endpoint: 'ledgers', action: 'BAL', query: q({ ret_period: v.period }), period: v.period },
            cash_ledger: { method: 'GET', endpoint: 'ledgers', action: 'CASH', query: q({ fr_dt: v.from, to_dt: v.to }) },
            itc_ledger: { method: 'GET', endpoint: 'ledgers', action: 'ITC', query: q({ fr_dt: v.from, to_dt: v.to }) },
            liability_ledger: { method: 'GET', endpoint: 'ledgers', action: 'TAX', query: q({ fr_dt: v.from, to_dt: v.to }) },
            return_track: { method: 'GET', endpoint: 'returns', action: 'RETTRACK', query: q({ ret_period: v.period, type: v.type }) },
            return_status: { method: 'GET', endpoint: 'returns', action: 'RETSTATUS', query: q({ ret_period: v.period, ref_id: v.refId }), period: v.period },
            gstr1_summary: { method: 'GET', endpoint: 'returns/gstr1', action: 'RETSUM', query: q({ ret_period: v.period }), period: v.period },
            gstr3b_summary: { method: 'GET', endpoint: 'returns/gstr3b', action: 'RETSUM', query: q({ ret_period: v.period }), period: v.period },
            gstr3b_autoliab: { method: 'GET', endpoint: 'returns/gstr3b', action: 'AUTOLIAB', query: q({ ret_period: v.period }), period: v.period },
            gstr3b_interest: { method: 'GET', endpoint: 'returns/gstr3b', action: 'RETINT', query: q({ ret_period: v.period }), period: v.period },
            gstr2b: { method: 'GET', endpoint: 'returns/gstr2b', action: 'GET2B', query: q({ rtnprd: v.period, file_num: v.fileNo }), period: v.period },
          };
          const call = m[op.kind];
          if (!call) throw new ApiError(400, 'bad_request', 'This view is not available with India Compliance');
          const r = await gstn(cfg, c, s, ip, call);
          return !r.ok && EMPTY_CODES.has(r.code ?? '') ? good({}, r.raw) : r;
        }
        case 'save': {
          const ep = FORM_PATH[op.form];
          if (!ep) throw new ApiError(400, 'bad_request', `${op.form} cannot be sent through India Compliance; download the JSON and upload it on the GST portal`);
          return gstn(cfg, c, s, ip, { method: 'PUT', endpoint: ep, period: op.period, body: { action: 'RETSAVE', data: op.body } });
        }
        case 'status':
          return gstn(cfg, c, s, ip, { method: 'GET', endpoint: 'returns', action: 'RETSTATUS', period: op.period, query: { ret_period: op.period, ref_id: op.refId } });
        case 'proceed': {
          if (op.form === 'GSTR3B')
            return gstn(cfg, c, s, ip, { method: 'POST', endpoint: 'returns/gstr3b', period: op.period, body: { action: 'RETSUBMIT', data: { gstin: c.gstin, ret_period: op.period } } });
          const r = await gstn(cfg, c, s, ip, {
            method: 'POST',
            endpoint: 'returns/gstrptf',
            period: op.period,
            returnType: op.form,
            body: { action: 'RETNEWPTF', data: { gstin: c.gstin, ret_period: op.period, ...(op.nil ? { isnil: 'Y' } : {}) } },
          });
          // "Return Form already ready to be filed"
          return !r.ok && r.code === 'RET00003' ? good({}, r.raw) : r;
        }
        case 'summary': {
          const ep = FORM_PATH[op.form];
          if (!ep) throw new ApiError(400, 'bad_request', `${op.form} is not available through India Compliance`);
          return gstn(cfg, c, s, ip, { method: 'GET', endpoint: ep, action: 'RETSUM', period: op.period, query: { ret_period: op.period } });
        }
        case 'offset':
          return gstn(cfg, c, s, ip, { method: 'PUT', endpoint: 'returns/gstr3b', period: op.period, body: { action: 'RETOFFSET', data: op.body } });
        case 'evcOtp': {
          const r = await gstn(cfg, c, s, ip, { method: 'GET', endpoint: 'authenticate', action: 'EVCOTP', query: { pan: op.pan, form_type: EVC_TYPE[op.form] ?? op.form } });
          // the portal answers "OTP requested" as an error code
          return !r.ok && (r.code === 'EVCREQUEST' || r.code === 'RETOTPREQUEST') ? good({ sent: true }, r.raw) : r;
        }
        case 'file': {
          const ep = FORM_PATH[op.form];
          if (!ep) throw new ApiError(400, 'bad_request', `${op.form} is not available through India Compliance`);
          if (op.mode !== 'evc') throw new ApiError(400, 'bad_request', 'India Compliance files with EVC (OTP) only');
          return gstn(cfg, c, s, ip, { method: 'POST', endpoint: ep, period: op.period, body: { action: 'RETFILE', data: op.summary }, evcSid: `${op.pan}|${op.otp ?? ''}` });
        }
        case 'reset':
          if (op.form !== 'GSTR1') throw new ApiError(400, 'bad_request', 'Only GSTR-1 can be reset');
          return gstn(cfg, c, s, ip, { method: 'POST', endpoint: 'returns/gstr1', period: op.period, body: { action: 'RESET', data: { gstin: c.gstin, ret_period: op.period } } });
        case 'challan':
          throw new ApiError(400, 'bad_request', 'Challans are created on the GST portal (Services → Payments) when using India Compliance');
      }
    },

    async search(gstin) {
      const r = await send(cfg, 'GET', 'commonapi/search', { query: { action: 'TP', gstin }, headers: { requestid: rid() } });
      const j = r.json ?? {};
      if (!asBool(j.success)) return bad(String(j.message ?? 'Taxpayer search failed'), null, j);
      if (j.errorCode || j.result?.errorCode) return bad(String(j.message ?? j.result?.message ?? 'No such GSTIN'), String(j.errorCode ?? j.result?.errorCode), j);
      return good(j.result ?? j, j);
    },
    async returnTrack(gstin, fy) {
      const r = await send(cfg, 'GET', 'commonapi/returns', { query: { action: 'RETTRACK', gstin, fy }, headers: { requestid: rid() } });
      const j = r.json ?? {};
      if (!asBool(j.success)) return bad(String(j.message ?? 'Return track failed'), null, j);
      return good(j.result ?? j, j);
    },

    async irp(c, secrets, _s, _ip, op: IrpOp): Promise<NicStep> {
      const t = cfg.nicTest ? NIC_TEST.einv : null;
      if (!t && (!c.einvUsername || !secrets.einvPassword)) throw new ApiError(400, 'bad_request', 'Add the e-invoice API username and password on the GST registration first');
      const headers = { gstin: t?.gstin ?? c.gstin, user_name: t?.username ?? c.einvUsername!, password: t?.password ?? secrets.einvPassword!, requestid: rid() };
      const prefix = cfg.nicTest ? 'test/ei/api' : 'ei/api';
      const nic = async (method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => {
        const r = await send(cfg, method, `${prefix}/${path}`, { headers, body, query, timeoutMs: 45_000 });
        const j = r.json ?? {};
        if (!asBool(j.success)) {
          const m = String(j.message ?? 'The IRP returned an error').trim();
          return bad(m, /^(\d{4})/.exec(m)?.[1] ?? null, j);
        }
        return good(j.result ?? j, j);
      };
      switch (op.op) {
        case 'generate': {
          const body = t ? { ...op.body, SellerDtls: { ...op.body.SellerDtls, Gstin: t.gstin } } : op.body;
          let r = await nic('POST', 'invoice', body);
          // duplicate: the IRP returns the existing IRN in its info; fetch the full e-invoice
          const info = Array.isArray(r.data) ? r.data : Array.isArray(r.raw && (r.raw as any).info) ? (r.raw as any).info : null;
          const dup = info?.find((x: any) => x?.InfCd === 'DUPIRN')?.Desc;
          if ((r.ok && !r.data?.Irn && dup?.Irn) || (!r.ok && r.code === '2150' && dup?.Irn)) r = await nic('GET', 'invoice/irn', undefined, { irn: dup.Irn });
          return { result: r };
        }
        case 'byIrn':
          return { result: await nic('GET', 'invoice/irn', undefined, { irn: op.irn }) };
        case 'byDoc':
          return { result: bad('This IRN was generated elsewhere; enter it with "Add IRN"', null, null) };
        case 'cancel':
          return { result: await nic('POST', 'invoice/cancel', op.body) };
        case 'ewb':
          return { result: await nic('POST', 'ewaybill', op.body) };
      }
    },

    async ewb(c, secrets, _s, _ip, op: EwbOp): Promise<NicStep> {
      const t = cfg.nicTest ? NIC_TEST.ewb : null;
      if (!t && (!c.ewbUsername || !secrets.ewbPassword)) throw new ApiError(400, 'bad_request', 'Add the e-way bill API username and password on the GST registration first');
      const action = op.op === 'generate' ? 'GENEWAYBILL' : op.op === 'cancel' ? 'CANEWB' : 'VEHEWB';
      const body = t && op.op === 'generate' ? { ...op.body, fromGstin: t.gstin } : op.body;
      const r = await send(cfg, 'POST', cfg.nicTest ? 'test/ewb/ewayapi' : 'ewb/ewayapi', {
        query: { action },
        headers: { gstin: t?.gstin ?? c.gstin, username: t?.username ?? c.ewbUsername!, password: t?.password ?? secrets.ewbPassword!, requestid: rid() },
        body,
        timeoutMs: 45_000,
      });
      const j = r.json ?? {};
      if (!asBool(j.success)) return { result: bad(String(j.message ?? 'The e-way bill system returned an error'), null, j) };
      return { result: good(j.result ?? j, j), ewbReady: true };
    },
  };
  return p;
}
