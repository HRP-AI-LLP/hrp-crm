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
