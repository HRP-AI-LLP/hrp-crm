/**
 * WhiteBooks GSP client (developer.whitebooks.in): the GST API (returns, ledgers, notices,
 * payments), the e-invoice API (IRN) and the e-way bill API.
 *
 * Every call carries the platform's client id and secret (from the Worker's secrets) and the
 * registered email; GST API calls also carry the taxpayer's portal username, state code, the user's
 * IP address and, once the OTP is verified, the session's txn. Nothing here logs headers or bodies:
 * they hold credentials and tax data.
 */
import type { Env } from '../../env';
import { ApiError } from '../../lib/errors';
import type { EwbOp, GspConn, GspProvider, GstOp, IrpOp, NicStep, Secrets, Session } from './provider';

export type WbProduct = 'gst' | 'einvoice' | 'ewaybill';

export interface WbConfig {
  base: string;
  sandbox: boolean;
  email: string;
  keys: Record<WbProduct, { id: string; secret: string }>;
}

export const SANDBOX_URL = 'https://apisandbox.whitebooks.in';
export const PRODUCTION_URL = 'https://api.whitebooks.in';

/** The platform's WhiteBooks settings, or null when they are not configured. */
export function wbConfig(env: Env): WbConfig | null {
  const id = env.WHITEBOOKS_CLIENT_ID?.trim();
  const secret = env.WHITEBOOKS_CLIENT_SECRET?.trim();
  const email = env.WHITEBOOKS_EMAIL?.trim();
  if (!id || !secret || !email) return null;
  const sandbox = (env.WHITEBOOKS_ENV ?? 'sandbox').trim().toLowerCase() !== 'production';
  let base = env.WHITEBOOKS_BASE_URL?.trim() || (sandbox ? SANDBOX_URL : PRODUCTION_URL);
  base = base.replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) base = sandbox ? SANDBOX_URL : PRODUCTION_URL;
  const pick = (a?: string, b?: string) => ({ id: a?.trim() || id, secret: b?.trim() || secret });
  return {
    base,
    sandbox,
    email,
    keys: {
      gst: { id, secret },
      einvoice: pick(env.WHITEBOOKS_EINVOICE_CLIENT_ID, env.WHITEBOOKS_EINVOICE_CLIENT_SECRET),
      ewaybill: pick(env.WHITEBOOKS_EWAYBILL_CLIENT_ID, env.WHITEBOOKS_EWAYBILL_CLIENT_SECRET),
    },
  };
}

export function requireConfig(env: Env): WbConfig {
  const c = wbConfig(env);
  if (!c) throw new ApiError(503, 'gsp_not_configured', 'The GST portal connection is not set up on this server (WHITEBOOKS_CLIENT_ID, WHITEBOOKS_CLIENT_SECRET and WHITEBOOKS_EMAIL)');
  return c;
}

export interface WbResult {
  ok: boolean;
  httpStatus: number;
  /** the response's data (already JSON-parsed when it came as a string) */
  data: any;
  header: any;
  raw: any;
  message: string;
  code: string | null;
}

/** A GSP or portal error, shown to the user as is (it never holds credentials). */
export class GspError extends ApiError {
  constructor(message: string, public gspCode: string | null, public result?: WbResult) {
    super(502, 'gsp_error', message, gspCode ? { code: gspCode } : undefined);
  }
}

const parseMaybe = (v: unknown) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
};

/** Pulls a readable message and code out of the many shapes GSTN, the IRP and the EWB system use. */
export function errorOf(raw: any): { message: string; code: string | null } {
  if (!raw || typeof raw !== 'object') return { message: typeof raw === 'string' && raw ? raw.slice(0, 500) : 'The GST system returned an error', code: null };
  const e = parseMaybe(raw.error);
  if (e && typeof e === 'object') {
    const m = e.message ?? e.error_message ?? e.desc ?? e.ErrorMessage;
    const c = e.error_cd ?? e.errorCodes ?? e.error_code ?? e.ErrorCode ?? null;
    if (m || c) return { message: String(m ?? c), code: c != null ? String(c) : null };
  }
  if (typeof e === 'string' && e) return { message: e.slice(0, 500), code: null };
  const d = parseMaybe(raw.status_desc ?? raw.ErrorDetails ?? raw.message);
  if (Array.isArray(d) && d.length) {
    const msgs = d.map((x: any) => (typeof x === 'object' ? `${x.ErrorCode ?? x.errorCode ?? ''}${x.ErrorCode || x.errorCode ? ': ' : ''}${x.ErrorMessage ?? x.errorMessage ?? x.message ?? ''}` : String(x)));
    return { message: msgs.join('; ').slice(0, 1000), code: String(d[0]?.ErrorCode ?? d[0]?.errorCode ?? '') || null };
  }
  if (typeof d === 'string' && d) return { message: d.slice(0, 1000), code: raw.error_cd ? String(raw.error_cd) : null };
  return { message: 'The GST system returned an error', code: null };
}

const OK_CODES = new Set(['1', 'sucess', 'success', 'p', 'true', 'ok']);

export interface WbCall {
  query?: Record<string, string | number | null | undefined>;
  headers?: Record<string, string | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

/** One call to WhiteBooks. Throws GspError for transport failures; returns ok=false for API errors. */
export async function wbCall(cfg: WbConfig, product: WbProduct, method: 'GET' | 'POST' | 'PUT', path: string, call: WbCall = {}): Promise<WbResult> {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(path) || path.includes('..')) throw new Error('bad GSP path');
  const url = new URL(cfg.base + path);
  url.searchParams.set('email', cfg.email);
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const key = cfg.keys[product];
  const headers: Record<string, string> = { accept: 'application/json', client_id: key.id, client_secret: key.secret };
  for (const [k, v] of Object.entries(call.headers ?? {})) if (v !== undefined && v !== null && v !== '') headers[k] = String(v);
  if (call.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
      signal: AbortSignal.timeout(call.timeoutMs ?? 45_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new GspError(timeout ? 'The GST system did not answer in time. Try again in a minute.' : 'Could not reach the GST Suvidha Provider (WhiteBooks)', null);
  }
  const text = await res.text();
  let raw: any = null;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = text.slice(0, 500);
  }
  const statusCd = raw && typeof raw === 'object' ? raw.status_cd : undefined;
  const flagged = statusCd !== undefined && statusCd !== null && !OK_CODES.has(String(statusCd).trim().toLowerCase());
  const ok = res.ok && raw !== null && typeof raw === 'object' && !flagged && !(raw.error && !raw.data);
  const data = raw && typeof raw === 'object' ? parseMaybe(raw.data ?? raw.Data ?? null) : null;
  const header = raw && typeof raw === 'object' ? (raw.header ?? null) : null;
  if (ok) return { ok, httpStatus: res.status, data, header, raw, message: String(raw?.status_desc ?? 'OK'), code: null };
  const err = res.status === 401 || res.status === 403 ? { message: 'WhiteBooks refused the platform credentials (check WHITEBOOKS_CLIENT_ID / SECRET / EMAIL and the sandbox/production setting)', code: String(res.status) } : errorOf(raw);
  return { ok: false, httpStatus: res.status, data, header, raw, message: err.message, code: err.code };
}

/** Like wbCall, but throws when the API reports an error. */
export async function wbMust(cfg: WbConfig, product: WbProduct, method: 'GET' | 'POST' | 'PUT', path: string, call: WbCall = {}): Promise<WbResult> {
  const r = await wbCall(cfg, product, method, path, call);
  if (!r.ok) throw new GspError(r.message, r.code, r);
  return r;
}

/** Finds a value by any of these keys anywhere in the first two levels of a response. */
export function pick(r: Pick<WbResult, 'data' | 'header' | 'raw'>, ...keys: string[]): any {
  const places = [r.data, r.header, r.raw, r.data?.data, r.raw?.data];
  for (const p of places) {
    if (!p || typeof p !== 'object') continue;
    for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
  }
  return undefined;
}

/* ───────────────────────── the WhiteBooks provider ───────────────────────── */


/** Dashboard views: WhiteBooks path and its names for the app's parameters. */
const WB_VIEWS: Record<string, { path: string; q: Record<string, string> }> = {
  ledger_balance: { path: '/ledgers/bal', q: { period: 'retperiod' } },
  cash_ledger: { path: '/ledgers/cashdtl', q: { from: 'frdt', to: 'todt' } },
  itc_ledger: { path: '/ledgers/itc', q: { from: 'frdt', to: 'todt' } },
  liability_ledger: { path: '/ledgers/tax', q: { from: 'frdt', to: 'todt' } },
  rcm_ledger: { path: '/ledgers/rcmldg', q: { from: 'frdt', to: 'todt' } },
  tax_payable: { path: '/ledgers/taxpayable', q: { period: 'retperiod', returnType: 'rettype' } },
  return_track: { path: '/gstr/rettrack', q: { period: 'returnperiod', type: 'type' } },
  return_status: { path: '/gstr/retstatus', q: { period: 'returnperiod', refId: 'refid' } },
  notices: { path: '/notices/noticelist', q: { from: 'date' } },
  notice: { path: '/notices/noticedetails', q: { refId: 'refId' } },
  challans: { path: '/payment/chllnlst', q: { from: 'fromdate', to: 'todate' } },
  challan: { path: '/payment/chllnsum', q: { cpin: 'cpin' } },
  gstr1_summary: { path: '/gstr1/retsum', q: { period: 'retperiod' } },
  gstr3b_summary: { path: '/gstr3b/retsum', q: { period: 'retperiod' } },
  gstr3b_autoliab: { path: '/gstr3b/autoliab', q: { period: 'retperiod' } },
  gstr3b_interest: { path: '/gstr3b/syscalcintrst', q: { period: 'retperiod' } },
  late_fee: { path: '/all/latefee', q: { period: 'retperiod', returnType: 'rettype' } },
  gstr2b: { path: '/gstr2b/all', q: { period: 'rtnprd', fileNo: 'filenum' } },
  gstr2x: { path: '/gstr2x/tdstcs', q: { period: 'retperiod', recType: 'rectype', fromTime: 'fromtime' } },
  gstr7_summary: { path: '/gstr7/retsum', q: { period: 'retperiod' } },
  itc04_summary: { path: '/itc04/retsum', q: { period: 'retperiod' } },
  gstr9_autocalc: { path: '/gstr9/getautocal', q: { period: 'retperiod' } },
  gstr9_details: { path: '/gstr9/getdet', q: { period: 'retperiod' } },
  einvoices: { path: '/gst/einvoice/irnlist', q: { supplyType: 'suptyp', period: 'rtnprd' } },
};
const WB_PATH: Record<string, string> = {
  GSTR1: '/gstr1',
  GSTR1A: '/gstr1a',
  GSTR3B: '/gstr3b',
  GSTR7: '/gstr7',
  GSTR2X: '/gstr2x',
  ITC04: '/itc04',
  GSTR9: '/gstr9',
  GSTR9C: '/gstr9c',
  GSTR6: '/gstr6',
  GSTR8: '/gstr8',
  CMP08: '/cmp',
};
const WB_EVC: Record<string, string> = { GSTR1: 'R1', GSTR1A: 'R1A', GSTR3B: 'R3B', GSTR7: 'R7', GSTR2X: 'R2X', ITC04: 'ITC04', GSTR9: 'R9', GSTR9C: 'R9C', GSTR6: 'R6', GSTR8: 'R8', CMP08: 'CMP08' };
const EINV = '/einvoice/type';
const EWB = '/ewaybillapi/v1.03';

const parseNicDate = (v: unknown) => {
  const s = String(v ?? '').replace(/^(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1');
  const t = Date.parse(s.replace(' ', 'T') + (/[zZ+]/.test(s.slice(-6)) ? '' : '+05:30'));
  return Number.isFinite(t) ? new Date(t) : new Date(Date.now() + 5.5 * 3600_000);
};

export function whitebooksProvider(env: Env): GspProvider | null {
  const cfg = wbConfig(env);
  if (!cfg) return null;
  const hd = (c: GspConn, ip: string, txn?: string) => ({ gst_username: c.gstUsername ?? undefined, state_cd: c.gstin.slice(0, 2), ip_address: ip, txn });
  const gst = (method: 'GET' | 'POST' | 'PUT', path: string, c: GspConn, s: Session, ip: string, call: WbCall = {}) =>
    wbCall(cfg, 'gst', method, path, { ...call, headers: { ...hd(c, ip, s.txn), ...(call.headers ?? {}) } });

  async function einvToken(c: GspConn, secrets: Secrets, s: Session, ip: string, force: boolean) {
    if (!force && s.einvToken && s.einvTokenExp && Date.parse(s.einvTokenExp) - Date.now() > 10 * 60_000) return { token: s.einvToken };
    if (!c.einvUsername || !secrets.einvPassword) throw new ApiError(400, 'bad_request', 'Add the e-invoice API username and password on the GST registration first');
    const r = await wbCall(cfg!, 'einvoice', 'GET', '/einvoice/authenticate', { headers: { username: c.einvUsername, password: secrets.einvPassword, ip_address: ip, gstin: c.gstin } });
    const token = r.ok ? pick(r, 'AuthToken', 'authToken', 'auth_token') : undefined;
    if (!r.ok || !token) throw new GspError(r.ok ? 'The IRP did not return a token' : `E-invoice login failed: ${r.message}`, r.code, r);
    const expires = parseNicDate(pick(r, 'TokenExpiry', 'tokenExpiry'));
    return { token: String(token), fresh: { ...s, einvToken: String(token), einvTokenExp: expires.toISOString() } as Session, expires };
  }

  const p: GspProvider = {
    id: 'whitebooks',
    label: 'WhiteBooks',
    sandbox: cfg.sandbox,
    nicSandbox: cfg.sandbox,
    views: Object.keys(WB_VIEWS),
    forms: ['GSTR1', 'GSTR1A', 'GSTR3B', 'GSTR7', 'GSTR2X', 'ITC04', 'GSTR9', 'GSTR9C', 'GSTR6', 'GSTR8', 'CMP08'],
    proceed: (form) => (form === 'GSTR1' ? 'r1' : form === 'GSTR1A' ? 'r1a' : form === 'GSTR6' ? 'submit' : null),
    challan: true,
    dsc: true,
    hint(message) {
      if (!cfg.sandbox) return message;
      return `${message}. This server uses WhiteBooks' SANDBOX, which only knows the test taxpayers WhiteBooks gives you (test GSTIN and username), not real ones. For your real GSTIN use production keys with WHITEBOOKS_ENV=production.`;
    },
    sessionGone: (r) => /^AUTH4/i.test(r.code ?? '') || /invalid session|session (has )?expired|auth(entication)? token (has )?expired|invalid (auth )?token/i.test(r.message),

    async requestOtp(c, s, ip) {
      const r = await wbCall(cfg, 'gst', 'GET', '/authentication/otprequest', { headers: hd(c, ip) });
      const txn = r.ok ? pick(r, 'txn') : undefined;
      if (r.ok && !txn) return { result: { ...r, ok: false, message: 'The GST system did not return a transaction id' }, session: s };
      return { result: r, session: txn ? { ...s, txn: String(txn) } : s };
    },
    async verifyOtp(c, s, otp, ip) {
      const r = await wbCall(cfg, 'gst', 'GET', '/authentication/authtoken', { query: { otp }, headers: hd(c, ip, s.txn) });
      const minutes = Number(pick(r, 'expiry')) > 0 ? Math.min(Number(pick(r, 'expiry')), 360) : 360;
      return { result: r, session: r.ok ? { ...s, txn: String(pick(r, 'txn') ?? s.txn) } : s, minutes };
    },
    async refresh(c, s, ip) {
      const r = await wbCall(cfg, 'gst', 'GET', '/authentication/refreshtoken', { headers: hd(c, ip, s.txn) });
      return { result: r, session: r.ok ? { ...s, txn: String(pick(r, 'txn') ?? s.txn) } : s, minutes: 360 };
    },
    async logout(c, s, ip) {
      if (s.txn) await wbCall(cfg, 'gst', 'GET', '/authentication/logout', { headers: hd(c, ip, s.txn) }).catch(() => null);
    },

    async call(c, s, ip, op: GstOp) {
      const rp = (period: string) => ({ gstin: c.gstin, ret_period: period });
      switch (op.op) {
        case 'view': {
          const v = WB_VIEWS[op.kind];
          if (!v) throw new ApiError(400, 'bad_request', 'This view is not available with WhiteBooks');
          const query: Record<string, string> = { gstin: c.gstin };
          for (const [k, val] of Object.entries(op.q)) if (v.q[k]) query[v.q[k]!] = val;
          return gst('GET', v.path, c, s, ip, { query });
        }
        case 'save':
          return op.form === 'CMP08'
            ? gst('POST', '/cmp/savecmp', c, s, ip, { headers: rp(op.period), body: op.body })
            : gst('PUT', `${WB_PATH[op.form]}/retsave`, c, s, ip, { headers: rp(op.period), body: op.body });
        case 'status':
          return gst('GET', '/gstr/retstatus', c, s, ip, { query: { gstin: c.gstin, returnperiod: op.period, refid: op.refId } });
        case 'proceed': {
          const how = p.proceed(op.form);
          if (how === 'r1') return gst('GET', '/all/newproceedfile', c, s, ip, { query: { gstin: c.gstin, retperiod: op.period, type: 'R1', isNil: op.nil ? 'Y' : 'N' } });
          if (how === 'r1a') return gst('GET', '/gstr1a/proceedfile', c, s, ip, { query: { gstin: c.gstin, retperiod: op.period, isNil: op.nil ? 'Y' : 'N' } });
          return gst('POST', `${WB_PATH[op.form]}/retsubmit`, c, s, ip, { headers: rp(op.period), body: rp(op.period) });
        }
        case 'summary':
          return gst('GET', `${WB_PATH[op.form]}/retsum`, c, s, ip, { query: { gstin: c.gstin, retperiod: op.period } });
        case 'offset':
          return gst('PUT', '/gstr3b/retoffset', c, s, ip, { headers: rp(op.period), body: op.body });
        case 'evcOtp':
          return gst('GET', '/authentication/otpforevc', c, s, ip, { query: { gstin: c.gstin, pan: op.pan, form_type: WB_EVC[op.form] ?? op.form } });
        case 'file':
          return op.mode === 'evc'
            ? gst('POST', `${WB_PATH[op.form]}/retevcfile`, c, s, ip, { query: { pan: op.pan, evcotp: op.otp ?? '' }, headers: rp(op.period), body: op.summary })
            : gst('POST', `${WB_PATH[op.form]}/retfile`, c, s, ip, { query: { pan: op.pan }, headers: rp(op.period), body: op.summary });
        case 'reset':
          return gst('POST', `${WB_PATH[op.form]}/reset`, c, s, ip, { headers: rp(op.period), body: rp(op.period) });
        case 'challan':
          return gst('POST', '/payment/generateChallan', c, s, ip, { headers: rp(op.period), body: op.body });
      }
    },

    search: (gstin) => wbCall(cfg, 'gst', 'GET', '/public/search', { query: { gstin } }),

    async irp(c, secrets, s, ip, op: IrpOp): Promise<NicStep> {
      let t = await einvToken(c, secrets, s, ip, false);
      let session = t.fresh;
      let expires = t.expires;
      const go = (token: string) => {
        const h = { username: c.einvUsername!, 'auth-token': token, gstin: c.gstin, ip_address: ip };
        switch (op.op) {
          case 'generate':
            return wbCall(cfg, 'einvoice', 'POST', `${EINV}/GENERATE/version/V1_03`, { headers: h, body: op.body });
          case 'byDoc':
            return wbCall(cfg, 'einvoice', 'GET', `${EINV}/GETIRNBYDOCDETAILS/version/V1_03`, { query: { param1: op.docType }, headers: { ...h, docnum: op.docNo, docdate: op.docDate } });
          case 'byIrn':
            return wbCall(cfg, 'einvoice', 'GET', `${EINV}/GETIRN/version/V1_03`, { query: { param1: op.irn }, headers: h });
          case 'cancel':
            return wbCall(cfg, 'einvoice', 'POST', `${EINV}/CANCEL/version/V1_03`, { headers: h, body: op.body });
          case 'ewb':
            return wbCall(cfg, 'einvoice', 'POST', `${EINV}/GENERATE_EWAYBILL/version/V1_03`, { headers: h, body: op.body });
        }
      };
      let r = await go(t.token);
      if (!r.ok && /1005|invalid token|token expired/i.test(`${r.code ?? ''} ${r.message}`)) {
        t = await einvToken(c, secrets, s, ip, true);
        session = t.fresh;
        expires = t.expires;
        r = await go(t.token);
      }
      return { result: r, session, einvTokenExpires: expires };
    },

    async ewb(c, secrets, s, ip, op: EwbOp): Promise<NicStep> {
      let session: Session | undefined;
      const login = async () => {
        if (!c.ewbUsername || !secrets.ewbPassword) throw new ApiError(400, 'bad_request', 'Add the e-way bill API username and password on the GST registration first');
        const r = await wbCall(cfg, 'ewaybill', 'GET', `${EWB}/authenticate`, { query: { username: c.ewbUsername, password: secrets.ewbPassword }, headers: { gstin: c.gstin, ip_address: ip } });
        if (!r.ok) throw new GspError(`E-way bill login failed: ${r.message}`, r.code, r);
        session = { ...s, ewbAt: new Date().toISOString() };
      };
      if (!s.ewbAt || Date.now() - Date.parse(s.ewbAt) > 5 * 3600_000) await login();
      const path = op.op === 'generate' ? 'genewaybill' : op.op === 'cancel' ? 'canewb' : 'vehewb';
      const go = () => wbCall(cfg, 'ewaybill', 'POST', `${EWB}/ewayapi/${path}`, { headers: { username: c.ewbUsername!, gstin: c.gstin, ip_address: ip }, body: op.body });
      let r = await go();
      if (!r.ok && /238|invalid auth|auth token|session/i.test(`${r.code ?? ''} ${r.message}`)) {
        await login();
        r = await go();
      }
      return { result: r, session, ewbReady: true };
    },
  };
  return p;
}
