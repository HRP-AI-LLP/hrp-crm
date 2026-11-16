/**
 * The GST portal through the WhiteBooks GSP: connecting a GSTIN (OTP), the session, what the
 * portal holds (ledgers, liabilities, filed returns, notices, challans, GSTR-2B, GSTR-2X) and
 * filing returns (save → status → proceed/submit → summary → offset → file with EVC or DSC).
 *
 * Calls to WhiteBooks never run inside a database transaction: each step reads what it needs in
 * one short transaction, calls the GSP, and records the outcome in another.
 *
 * Access: books or billing admins. Credentials (e-invoice / e-way bill passwords) and the session
 * (txn, IRP token) are stored encrypted and never returned.
 */
import { hasAdmin, validGstin } from '@synapse/shared';
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { importGstr2b, type Gstr2bRow } from '../books/setup';
import type { RecordCtx } from '../records';
import { BUILDABLE, buildGstr1, buildGstr3b, buildItc04, filingCalendar, fromRetPeriod } from './returns';
import { GspError, pick, requireConfig, wbCall, wbConfig, type WbCall, type WbResult } from './whitebooks';

export interface GstDeps {
  env: Env;
  /** the user's IP address (GSTN wants the end user's) */
  ip: string;
  run: <T>(fn: (ctx: RecordCtx) => Promise<T>) => Promise<T>;
}

export function assertGstAdmin(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (!hasAdmin(p, 'books') && !hasAdmin(p, 'billing')) throw forbidden('The GST portal needs the books or billing permission');
}

/* ───────────────────────── forms ───────────────────────── */

interface Form {
  label: string;
  path: string;
  /** EVC OTP form type */
  evc: string;
  /** how saved data becomes a summary: GSTR-1 "proceed to file", GSTR-6 "submit" */
  proceed?: 'r1' | 'r1a' | 'submit';
  offset?: boolean;
  save?: { method: 'PUT' | 'POST'; path: string };
}
export const FORMS: Record<string, Form> = {
  GSTR1: { label: 'GSTR-1', path: '/gstr1', evc: 'R1', proceed: 'r1' },
  GSTR1A: { label: 'GSTR-1A', path: '/gstr1a', evc: 'R1A', proceed: 'r1a' },
  GSTR3B: { label: 'GSTR-3B', path: '/gstr3b', evc: 'R3B', offset: true },
  GSTR7: { label: 'GSTR-7 (TDS deducted)', path: '/gstr7', evc: 'R7' },
  GSTR2X: { label: 'GSTR-2X (TDS/TCS credit received)', path: '/gstr2x', evc: 'R2X' },
  ITC04: { label: 'ITC-04 (job work)', path: '/itc04', evc: 'ITC04' },
  GSTR9: { label: 'GSTR-9 (annual)', path: '/gstr9', evc: 'R9' },
  GSTR9C: { label: 'GSTR-9C (reconciliation)', path: '/gstr9c', evc: 'R9C' },
  GSTR6: { label: 'GSTR-6 (ISD)', path: '/gstr6', evc: 'R6', proceed: 'submit' },
  GSTR8: { label: 'GSTR-8 (e-commerce TCS)', path: '/gstr8', evc: 'R8' },
  CMP08: { label: 'CMP-08 (composition)', path: '/cmp', evc: 'CMP08', save: { method: 'POST', path: '/cmp/savecmp' } },
};
export type ReturnType = keyof typeof FORMS;

/* ───────────────────────── connections ───────────────────────── */

interface ConnRow {
  id: string;
  tenant_id: string;
  gstin: string;
  legal_name: string | null;
  gst_username: string | null;
  signatory_pan: string | null;
  filing_frequency: 'monthly' | 'quarterly';
  einv_username: string | null;
  ewb_username: string | null;
  secret_ciphertext: string | null;
  session_ciphertext: string | null;
  status: 'disconnected' | 'otp_sent' | 'active' | 'expired';
  otp_sent_at: string | null;
  session_started_at: string | null;
  session_expires_at: string | null;
  einv_token_expires_at: string | null;
  ewb_ready: boolean;
  last_error: string | null;
  updated_at: string;
}
export interface Secrets {
  einvPassword?: string;
  ewbPassword?: string;
}
export interface Session {
  txn?: string;
  einvToken?: string;
  ewbAt?: string;
}

const key = (env: Env) => {
  if (!env.DATA_ENCRYPTION_KEY) throw badRequest('This server has no DATA_ENCRYPTION_KEY, so GST portal credentials cannot be stored');
  return env.DATA_ENCRYPTION_KEY;
};
export async function seal(env: Env, tenantId: string, v: object) {
  return encryptSecret(key(env), JSON.stringify(v), tenantId);
}
export async function unseal<T>(env: Env, tenantId: string, s: string | null): Promise<T> {
  if (!s) return {} as T;
  try {
    return JSON.parse(await decryptSecret(key(env), s, tenantId)) as T;
  } catch {
    return {} as T;
  }
}

/** What the browser may see of a connection. */
export function connDto(c: ConnRow, now = Date.now()) {
  const exp = c.session_expires_at ? Date.parse(c.session_expires_at) : 0;
  const live = c.status === 'active' && exp > now;
  return {
    id: c.id,
    gstin: c.gstin,
    legalName: c.legal_name,
    gstUsername: c.gst_username,
    signatoryPan: c.signatory_pan,
    filingFrequency: c.filing_frequency,
    einvUsername: c.einv_username,
    ewbUsername: c.ewb_username,
    hasEinvPassword: false as boolean,
    hasEwbPassword: false as boolean,
    status: c.status === 'active' && !live ? 'expired' : c.status,
    sessionExpiresAt: live ? c.session_expires_at : null,
    otpSentAt: c.otp_sent_at,
    einvReady: !!c.einv_token_expires_at && Date.parse(c.einv_token_expires_at) > now,
    lastError: c.last_error,
  };
}

async function loadConn(ctx: RecordCtx, id: string, lock = false) {
  const c = await ctx.tx.one<ConnRow>(`select * from gst_connections where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`, [ctx.tenantId, id]);
  if (!c) throw notFound('GST registration not found');
  return c;
}

export async function logEvent(ctx: RecordCtx, e: { connectionId?: string | null; filingId?: string | null; invoiceId?: string | null; action: string; ok: boolean; message?: string | null }) {
  await ctx.tx.query(`insert into gst_events (tenant_id, connection_id, filing_id, invoice_id, action, ok, message) values ($1,$2,$3,$4,$5,$6,$7)`, [
    ctx.tenantId,
    e.connectionId ?? null,
    e.filingId ?? null,
    e.invoiceId ?? null,
    e.action.slice(0, 60),
    e.ok,
    e.message ? e.message.slice(0, 2000) : null,
  ]);
}

export async function listConnections(deps: GstDeps) {
  const cfg = wbConfig(deps.env);
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const rows = await ctx.tx.query<ConnRow>(`select * from gst_connections where tenant_id = $1 order by created_at`, [ctx.tenantId]);
    const out = [];
    for (const r of rows) {
      const s = await unseal<Secrets>(deps.env, ctx.tenantId, r.secret_ciphertext);
      out.push({ ...connDto(r), hasEinvPassword: !!s.einvPassword, hasEwbPassword: !!s.ewbPassword });
    }
    return { gsp: { provider: 'WhiteBooks', configured: !!cfg, sandbox: cfg?.sandbox ?? true }, connections: out };
  });
}

export interface ConnInput {
  gstin: string;
  legalName?: string | null;
  gstUsername?: string | null;
  signatoryPan?: string | null;
  filingFrequency?: 'monthly' | 'quarterly';
  einvUsername?: string | null;
  einvPassword?: string | null;
  ewbUsername?: string | null;
  ewbPassword?: string | null;
}

export async function saveConnection(deps: GstDeps, id: string | null, input: ConnInput) {
  const gstin = input.gstin.trim().toUpperCase();
  if (!validGstin(gstin)) throw badRequest('That GSTIN is not valid (check the 15 characters)');
  const pan = input.signatoryPan?.trim().toUpperCase() || null;
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw badRequest('The signatory PAN is not valid');
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const old = id ? await loadConn(ctx, id, true) : null;
    if (old && old.gstin !== gstin) {
      const used = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from gst_filings where tenant_id = $1 and connection_id = $2`, [ctx.tenantId, old.id]);
      if (used!.n > 0) throw conflict('Returns have been prepared for this GSTIN; add the other GSTIN as a new registration instead');
    }
    const secrets = old ? await unseal<Secrets>(deps.env, ctx.tenantId, old.secret_ciphertext) : {};
    if (input.einvPassword !== undefined) secrets.einvPassword = input.einvPassword || undefined;
    if (input.ewbPassword !== undefined) secrets.ewbPassword = input.ewbPassword || undefined;
    const sealed = secrets.einvPassword || secrets.ewbPassword ? await seal(deps.env, ctx.tenantId, secrets) : null;
    const changedLogin = old && (old.gstin !== gstin || (input.gstUsername !== undefined && (input.gstUsername || null) !== old.gst_username));
    const changedEinv = old && ((input.einvUsername !== undefined && (input.einvUsername || null) !== old.einv_username) || input.einvPassword !== undefined);
    const changedEwb = old && ((input.ewbUsername !== undefined && (input.ewbUsername || null) !== old.ewb_username) || input.ewbPassword !== undefined);
    let row: ConnRow;
    if (old) {
      const session = await unseal<Session>(deps.env, ctx.tenantId, old.session_ciphertext);
      if (changedLogin) delete session.txn;
      if (changedEinv) delete session.einvToken;
      if (changedEwb) delete session.ewbAt;
      row = (await ctx.tx.one<ConnRow>(
        `update gst_connections set gstin = $3, legal_name = $4, gst_username = $5, signatory_pan = $6, filing_frequency = $7, einv_username = $8, ewb_username = $9,
                secret_ciphertext = $10, session_ciphertext = $11,
                status = case when $12 then 'disconnected' else status end,
                session_expires_at = case when $12 then null else session_expires_at end,
                einv_token_expires_at = case when $13 then null else einv_token_expires_at end,
                ewb_ready = case when $14 then false else ewb_ready end
          where tenant_id = $1 and id = $2 returning *`,
        [
          ctx.tenantId,
          old.id,
          gstin,
          input.legalName === undefined ? old.legal_name : input.legalName?.trim() || null,
          input.gstUsername === undefined ? old.gst_username : input.gstUsername?.trim() || null,
          input.signatoryPan === undefined ? old.signatory_pan : pan,
          input.filingFrequency ?? old.filing_frequency,
          input.einvUsername === undefined ? old.einv_username : input.einvUsername?.trim() || null,
          input.ewbUsername === undefined ? old.ewb_username : input.ewbUsername?.trim() || null,
          sealed,
          Object.keys(session).length ? await seal(deps.env, ctx.tenantId, session) : null,
          !!changedLogin,
          !!changedEinv,
          !!changedEwb,
        ],
      ))!;
    } else {
      row = (await ctx.tx.one<ConnRow>(
        `insert into gst_connections (tenant_id, gstin, legal_name, gst_username, signatory_pan, filing_frequency, einv_username, ewb_username, secret_ciphertext)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
        [ctx.tenantId, gstin, input.legalName?.trim() || null, input.gstUsername?.trim() || null, pan, input.filingFrequency ?? 'monthly', input.einvUsername?.trim() || null, input.ewbUsername?.trim() || null, sealed],
      ))!;
    }
    await logEvent(ctx, { connectionId: row.id, action: old ? 'connection.update' : 'connection.create', ok: true });
    return { ...connDto(row), hasEinvPassword: !!secrets.einvPassword, hasEwbPassword: !!secrets.ewbPassword };
  });
}

export async function deleteConnection(deps: GstDeps, id: string) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id, true);
    const filed = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from gst_filings where tenant_id = $1 and connection_id = $2 and status = 'filed'`, [ctx.tenantId, id]);
    if (filed!.n > 0) throw conflict('Returns have been filed for this GSTIN; disconnect it instead of removing it');
    await ctx.tx.query(`delete from gst_connections where tenant_id = $1 and id = $2`, [ctx.tenantId, c.id]);
    return { ok: true };
  });
}

/* ───────────────────────── portal session ───────────────────────── */

const SESSION_MINUTES = 360;
const REFRESH_WITHIN_MS = 45 * 60_000;

function baseHeaders(c: ConnRow, ip: string, txn?: string): Record<string, string | undefined> {
  return { gst_username: c.gst_username ?? undefined, state_cd: c.gstin.slice(0, 2), ip_address: ip, txn };
}

const sessionGone = (r: WbResult) => /^AUTH4/i.test(r.code ?? '') || /invalid session|session (has )?expired|auth(entication)? token (has )?expired|invalid (auth )?token/i.test(r.message);

/** Asks the GST portal to send an OTP to the taxpayer's registered mobile and email. */
export async function requestOtp(deps: GstDeps, id: string) {
  const cfg = requireConfig(deps.env);
  const c = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return loadConn(ctx, id);
  });
  if (!c.gst_username) throw badRequest('Enter the GST portal username for this GSTIN first');
  const r = await wbCall(cfg, 'gst', 'GET', '/authentication/otprequest', { headers: baseHeaders(c, deps.ip) });
  const txn = r.ok ? pick(r, 'txn') : undefined;
  return deps.run(async (ctx) => {
    if (!r.ok || !txn) {
      const msg = r.ok ? 'The GST system did not return a transaction id' : r.message;
      await ctx.tx.query(`update gst_connections set last_error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, msg.slice(0, 1000)]);
      await logEvent(ctx, { connectionId: id, action: 'otp.request', ok: false, message: msg });
      throw new GspError(msg, r.code, r);
    }
    const cur = await loadConn(ctx, id, true);
    const session = await unseal<Session>(deps.env, ctx.tenantId, cur.session_ciphertext);
    session.txn = String(txn);
    await ctx.tx.query(
      `update gst_connections set status = 'otp_sent', otp_sent_at = now(), session_ciphertext = $3, session_expires_at = null, last_error = null where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id, await seal(deps.env, ctx.tenantId, session)],
    );
    await logEvent(ctx, { connectionId: id, action: 'otp.request', ok: true, message: cfg.sandbox ? 'Sandbox: the OTP is 575757' : null });
    return { ok: true, sandbox: cfg.sandbox };
  });
}

/** Verifies the OTP and starts a 6-hour portal session. */
export async function verifyOtp(deps: GstDeps, id: string, otp: string) {
  if (!/^\d{4,8}$/.test(otp)) throw badRequest('Enter the OTP from the GST portal');
  const cfg = requireConfig(deps.env);
  const { c, txn } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    const s = await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext);
    if (c.status !== 'otp_sent' || !s.txn) throw badRequest('Request an OTP first');
    if (c.otp_sent_at && Date.now() - Date.parse(c.otp_sent_at) > 15 * 60_000) throw badRequest('The OTP has expired; request a new one');
    return { c, txn: s.txn };
  });
  const r = await wbCall(cfg, 'gst', 'GET', '/authentication/authtoken', { query: { otp }, headers: baseHeaders(c, deps.ip, txn) });
  return deps.run(async (ctx) => {
    if (!r.ok) {
      await ctx.tx.query(`update gst_connections set last_error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, r.message.slice(0, 1000)]);
      await logEvent(ctx, { connectionId: id, action: 'otp.verify', ok: false, message: r.message });
      throw new GspError(r.message, r.code, r);
    }
    const cur = await loadConn(ctx, id, true);
    const session = await unseal<Session>(deps.env, ctx.tenantId, cur.session_ciphertext);
    session.txn = String(pick(r, 'txn') ?? txn);
    const minutes = Number(pick(r, 'expiry')) > 0 ? Math.min(Number(pick(r, 'expiry')), SESSION_MINUTES) : SESSION_MINUTES;
    const row = (await ctx.tx.one<ConnRow>(
      `update gst_connections set status = 'active', session_started_at = now(), session_expires_at = now() + make_interval(mins => $4), session_ciphertext = $3, last_error = null
        where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, await seal(deps.env, ctx.tenantId, session), minutes],
    ))!;
    await logEvent(ctx, { connectionId: id, action: 'otp.verify', ok: true });
    return connDto(row);
  });
}

export async function disconnect(deps: GstDeps, id: string) {
  const cfg = wbConfig(deps.env);
  const { c, txn } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    return { c, txn: (await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext)).txn };
  });
  if (cfg && txn && c.status === 'active') await wbCall(cfg, 'gst', 'GET', '/authentication/logout', { headers: baseHeaders(c, deps.ip, txn) }).catch(() => null);
  return deps.run(async (ctx) => {
    const cur = await loadConn(ctx, id, true);
    const session = await unseal<Session>(deps.env, ctx.tenantId, cur.session_ciphertext);
    delete session.txn;
    await ctx.tx.query(`update gst_connections set status = 'disconnected', session_expires_at = null, session_ciphertext = $3 where tenant_id = $1 and id = $2`, [
      ctx.tenantId,
      id,
      Object.keys(session).length ? await seal(deps.env, ctx.tenantId, session) : null,
    ]);
    await logEvent(ctx, { connectionId: id, action: 'disconnect', ok: true });
    return { ok: true };
  });
}

/** The live session: refreshed when it has under 45 minutes left; an error when there is none. */
async function liveSession(deps: GstDeps, id: string): Promise<{ c: ConnRow; txn: string }> {
  const cfg = requireConfig(deps.env);
  const { c, txn } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    return { c, txn: (await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext)).txn };
  });
  const exp = c.session_expires_at ? Date.parse(c.session_expires_at) : 0;
  if (c.status !== 'active' || !txn || exp <= Date.now()) throw new ApiError(409, 'gst_session_required', 'Connect to the GST portal first: request an OTP and enter it (the session lasts 6 hours)');
  if (exp - Date.now() > REFRESH_WITHIN_MS) return { c, txn };
  const r = await wbCall(cfg, 'gst', 'GET', '/authentication/refreshtoken', { headers: baseHeaders(c, deps.ip, txn) });
  return deps.run(async (ctx) => {
    if (!r.ok) {
      await logEvent(ctx, { connectionId: id, action: 'session.refresh', ok: false, message: r.message });
      return { c, txn }; // the old session still has some time; the next call may refresh again
    }
    const cur = await loadConn(ctx, id, true);
    const session = await unseal<Session>(deps.env, ctx.tenantId, cur.session_ciphertext);
    session.txn = String(pick(r, 'txn') ?? txn);
    const row = (await ctx.tx.one<ConnRow>(
      `update gst_connections set session_expires_at = now() + make_interval(mins => $4), session_ciphertext = $3 where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, await seal(deps.env, ctx.tenantId, session), SESSION_MINUTES],
    ))!;
    await logEvent(ctx, { connectionId: id, action: 'session.refresh', ok: true });
    return { c: row, txn: session.txn };
  });
}

/** One GST API call in the connection's session; an expired session marks the connection expired. */
async function portalCall(
  deps: GstDeps,
  id: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  call: WbCall,
  log: { action: string; filingId?: string | null; quiet?: boolean },
): Promise<WbResult> {
  const cfg = requireConfig(deps.env);
  const { c, txn } = await liveSession(deps, id);
  const r = await wbCall(cfg, 'gst', method, path, { ...call, headers: { ...baseHeaders(c, deps.ip, txn), ...(call.headers ?? {}) } });
  if (!r.ok || !log.quiet)
    await deps.run(async (ctx) => {
      if (!r.ok && sessionGone(r)) await ctx.tx.query(`update gst_connections set status = 'expired', session_expires_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      await logEvent(ctx, { connectionId: id, filingId: log.filingId, action: log.action, ok: r.ok, message: r.ok ? null : r.message });
    });
  if (!r.ok) {
    if (sessionGone(r)) throw new ApiError(409, 'gst_session_required', `The GST portal session has ended (${r.message}). Request a new OTP.`);
    throw new GspError(r.message, r.code, r);
  }
  return r;
}

/* ───────────────────────── what the portal holds ───────────────────────── */

type View = { path: string; params: string[]; optional?: string[]; dates?: string[]; label: string };
/** Read-only portal views the dashboard can fetch. Dates are given as YYYY-MM-DD and sent dd-mm-yyyy. */
export const VIEWS: Record<string, View> = {
  ledger_balance: { label: 'Cash and ITC balance', path: '/ledgers/bal', params: ['retperiod'] },
  cash_ledger: { label: 'Electronic cash ledger', path: '/ledgers/cashdtl', params: ['frdt', 'todt'], dates: ['frdt', 'todt'] },
  itc_ledger: { label: 'Electronic credit ledger', path: '/ledgers/itc', params: ['frdt', 'todt'], dates: ['frdt', 'todt'] },
  liability_ledger: { label: 'Electronic liability ledger', path: '/ledgers/tax', params: ['frdt', 'todt'], dates: ['frdt', 'todt'] },
  rcm_ledger: { label: 'RCM ledger', path: '/ledgers/rcmldg', params: ['frdt', 'todt'], dates: ['frdt', 'todt'] },
  tax_payable: { label: 'Tax payable', path: '/ledgers/taxpayable', params: ['retperiod', 'rettype'] },
  return_track: { label: 'Returns filed', path: '/gstr/rettrack', params: ['returnperiod'], optional: ['type'] },
  return_status: { label: 'Return status', path: '/gstr/retstatus', params: ['returnperiod', 'refid'] },
  notices: { label: 'Notices and orders', path: '/notices/noticelist', params: ['date'], dates: ['date'] },
  notice: { label: 'Notice', path: '/notices/noticedetails', params: ['refId'] },
  challans: { label: 'Challans', path: '/payment/chllnlst', params: ['fromdate', 'todate'], dates: ['fromdate', 'todate'] },
  challan: { label: 'Challan', path: '/payment/chllnsum', params: ['cpin'] },
  gstr1_summary: { label: 'GSTR-1 summary', path: '/gstr1/retsum', params: ['retperiod'] },
  gstr3b_summary: { label: 'GSTR-3B summary', path: '/gstr3b/retsum', params: ['retperiod'] },
  gstr3b_autoliab: { label: 'GSTR-3B auto-calculated liability', path: '/gstr3b/autoliab', params: ['retperiod'] },
  gstr3b_interest: { label: 'GSTR-3B interest', path: '/gstr3b/syscalcintrst', params: ['retperiod'] },
  late_fee: { label: 'Late fee', path: '/all/latefee', params: ['retperiod', 'rettype'] },
  gstr2b: { label: 'GSTR-2B', path: '/gstr2b/all', params: ['rtnprd'], optional: ['filenum'] },
  gstr2x: { label: 'TDS/TCS credits (GSTR-2X)', path: '/gstr2x/tdstcs', params: ['retperiod', 'rectype'], optional: ['fromtime'] },
  gstr7_summary: { label: 'GSTR-7 summary', path: '/gstr7/retsum', params: ['retperiod'] },
  itc04_summary: { label: 'ITC-04 summary', path: '/itc04/retsum', params: ['retperiod'] },
  gstr9_autocalc: { label: 'GSTR-9 auto-calculated', path: '/gstr9/getautocal', params: ['retperiod'] },
  gstr9_details: { label: 'GSTR-9 details', path: '/gstr9/getdet', params: ['retperiod'] },
  einvoices: { label: 'E-invoices reported (IRNs)', path: '/gst/einvoice/irnlist', params: ['suptyp', 'rtnprd'] },
};
const PARAM_RE = /^[A-Za-z0-9_.\-/ ]{1,64}$/;
const toDmy = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : s);

/** Fetches one portal view and keeps the latest copy for the dashboard. */
export async function fetchView(deps: GstDeps, id: string, kind: string, params: Record<string, string>) {
  const v = VIEWS[kind];
  if (!v) throw badRequest('Unknown GST portal view');
  const query: Record<string, string> = {};
  for (const p of [...v.params, ...(v.optional ?? [])]) {
    const val = params[p];
    if (val === undefined || val === '') {
      if (v.params.includes(p)) throw badRequest(`${p} is required`);
      continue;
    }
    if (!PARAM_RE.test(val)) throw badRequest(`${p} is not valid`);
    query[p] = v.dates?.includes(p) ? toDmy(val) : val;
  }
  const gstin = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return (await loadConn(ctx, id)).gstin;
  });
  const r = await portalCall(deps, id, 'GET', v.path, { query: { gstin, ...query } }, { action: `view.${kind}`, quiet: true });
  const cacheKey = Object.values(query).join('|').slice(0, 60);
  await deps.run(async (ctx) => {
    await ctx.tx.query(
      `insert into gst_portal_cache (tenant_id, connection_id, kind, key, data) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, connection_id, kind, key) do update set data = excluded.data, fetched_at = now()`,
      [ctx.tenantId, id, kind, cacheKey, JSON.stringify(r.data ?? r.raw ?? null)],
    );
  });
  return { kind, label: v.label, params: query, data: r.data ?? null, fetchedAt: new Date().toISOString() };
}

/** Public taxpayer search (no OTP needed): legal name, trade name, status, address of any GSTIN. */
export async function searchTaxpayer(deps: GstDeps, gstin: string) {
  const g = gstin.trim().toUpperCase();
  if (!validGstin(g)) throw badRequest('That GSTIN is not valid');
  const cfg = requireConfig(deps.env);
  await deps.run(async (ctx) => {
    if (!hasAdmin(ctx.principal.permissions, 'books') && !hasAdmin(ctx.principal.permissions, 'billing') && !hasAdmin(ctx.principal.permissions, 'accounts')) {
      throw forbidden();
    }
  });
  const r = await wbCall(cfg, 'gst', 'GET', '/public/search', { query: { gstin: g } });
  if (!r.ok) throw new GspError(r.message, r.code, r);
  const d = r.data ?? {};
  const addr = d.pradr?.addr ?? {};
  return {
    gstin: d.gstin ?? g,
    legalName: d.lgnm ?? null,
    tradeName: d.tradeNam ?? null,
    status: d.sts ?? null,
    type: d.dty ?? null,
    registeredOn: d.rgdt ?? null,
    cancelledOn: d.cxdt || null,
    address: [addr.bno, addr.flno, addr.bnm, addr.st, addr.loc, addr.dst, addr.stcd, addr.pncd].filter(Boolean).join(', ') || null,
    state: addr.stcd ?? null,
    pincode: addr.pncd ?? null,
    einvoiceStatus: d.einvoiceStatus ?? null,
  };
}

/* ───────────────────────── dashboard and calendar ───────────────────────── */

const fyOf = (d: Date) => {
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return { start: y, label: `${y}-${String(y + 1).slice(2)}` };
};

/**
 * Filing calendar for the GSTIN: due dates from April of this FY to next month, with status from
 * Synapse's own filings and, if fetched, the portal's return track. No portal call is made here.
 */
export async function overview(deps: GstDeps, id: string, today = new Date()) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    const fy = fyOf(today);
    const next = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    const flags = await ctx.tx.one<{ job_work: boolean }>(`select exists (select 1 from job_works where tenant_id = $1) as job_work`, [ctx.tenantId]).catch(() => ({ job_work: false }));
    const due = filingCalendar(c.gstin, c.filing_frequency, `${fy.start}-04`, `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`, { jobWork: !!flags?.job_work });
    const filings = await ctx.tx.query<{ id: string; return_type: string; period: string; status: string; arn: string | null; filed_at: string | null; updated_at: string }>(
      `select id, return_type, period, status, arn, filed_at, updated_at from gst_filings where tenant_id = $1 and connection_id = $2`,
      [ctx.tenantId, id],
    );
    const track = await ctx.tx.query<{ key: string; data: any; fetched_at: string }>(`select key, data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = 'return_track'`, [ctx.tenantId, id]);
    const portalFiled = new Map<string, { arn: string | null; date: string | null; status: string | null }>();
    for (const t of track) {
      const list: any[] = t.data?.EFiledlist ?? t.data?.efiledlist ?? (Array.isArray(t.data) ? t.data : []);
      for (const x of list) {
        const rt = String(x.rtntype ?? x.rtn_typ ?? '').replace(/-/g, '').toUpperCase();
        const per = String(x.ret_prd ?? x.retprd ?? '');
        if (rt && per) portalFiled.set(`${rt}|${per}`, { arn: x.arn ?? null, date: x.dof ?? null, status: x.status ?? null });
      }
    }
    const todayStr = today.toISOString().slice(0, 10);
    const items = due.map((d) => {
      const f = filings.find((x) => x.return_type === d.returnType && x.period === d.period);
      const p = portalFiled.get(`${d.returnType}|${d.period}`);
      const filed = f?.status === 'filed' || (!!p && /filed/i.test(p.status ?? 'filed'));
      return {
        ...d,
        filingId: f?.id ?? null,
        status: filed ? 'filed' : f ? f.status : d.dueDate < todayStr ? 'overdue' : 'due',
        arn: f?.arn ?? p?.arn ?? null,
        filedOn: f?.filed_at ?? p?.date ?? null,
        source: f?.status === 'filed' ? 'synapse' : p ? 'portal' : null,
      };
    });
    const cache = await ctx.tx.query<{ kind: string; key: string; data: any; fetched_at: string }>(
      `select kind, key, data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind in ('ledger_balance', 'notices', 'challans', 'tax_payable') order by fetched_at desc`,
      [ctx.tenantId, id],
    );
    const latest = (k: string) => cache.find((x) => x.kind === k) ?? null;
    return {
      connection: connDto(c),
      fy: fy.label,
      calendar: items,
      // the returns that matter now: due in the next month, or missed in the last two (older ones show in the full calendar)
      pending: items.filter((i) => i.status !== 'filed' && i.dueDate <= new Date(today.getTime() + 31 * 86_400_000).toISOString().slice(0, 10) && i.dueDate >= new Date(today.getTime() - 62 * 86_400_000).toISOString().slice(0, 10)),
      overdueEarlier: items.filter((i) => i.status === 'overdue' && i.dueDate < new Date(today.getTime() - 62 * 86_400_000).toISOString().slice(0, 10)).length,
      ledgerBalance: latest('ledger_balance'),
      taxPayable: latest('tax_payable'),
      notices: latest('notices'),
      challans: latest('challans'),
      returnTrackFetchedAt: track[0]?.fetched_at ?? null,
    };
  });
}

/** Fetches the portal's record of returns filed for each month of a financial year (for the calendar). */
export async function syncReturnTrack(deps: GstDeps, id: string, fyStart: number) {
  const out: { period: string; ok: boolean; message?: string }[] = [];
  for (let k = 0; k < 12; k++) {
    const m = ((3 + k) % 12) + 1;
    const y = m >= 4 ? fyStart : fyStart + 1;
    const d = new Date(Date.UTC(y, m - 1, 1));
    if (d > new Date()) break;
    const period = `${String(m).padStart(2, '0')}${y}`;
    try {
      await fetchView(deps, id, 'return_track', { returnperiod: period });
      out.push({ period, ok: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'gst_session_required') throw e;
      out.push({ period, ok: false, message: e instanceof Error ? e.message : 'failed' });
    }
  }
  return out;
}

/* ───────────────────────── filings ───────────────────────── */

interface FilingRow {
  id: string;
  connection_id: string;
  return_type: ReturnType;
  period: string;
  status: 'prepared' | 'saving' | 'saved' | 'error' | 'submitted' | 'offset' | 'filed';
  payload: any;
  payload_source: string | null;
  ref_id: string | null;
  portal_status: string | null;
  error_report: any;
  summary: any;
  arn: string | null;
  filed_at: string | null;
  filing_mode: string | null;
  updated_at: string;
}

function filingDto(f: FilingRow, withPayload = false) {
  const form = FORMS[f.return_type];
  return {
    id: f.id,
    connectionId: f.connection_id,
    returnType: f.return_type,
    label: form?.label ?? f.return_type,
    period: f.period,
    status: f.status,
    source: f.payload_source,
    refId: f.ref_id,
    portalStatus: f.portal_status,
    errorReport: f.error_report,
    summary: f.summary,
    arn: f.arn,
    filedAt: f.filed_at,
    filingMode: f.filing_mode,
    updatedAt: f.updated_at,
    canOffset: !!form?.offset,
    needsProceed: !!form?.proceed,
    ...(withPayload ? { payload: f.payload } : {}),
  };
}

async function loadFiling(ctx: RecordCtx, id: string, lock = false) {
  const f = await ctx.tx.one<FilingRow>(`select * from gst_filings where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`, [ctx.tenantId, id]);
  if (!f) throw notFound('Return not found');
  return f;
}

export async function listFilings(deps: GstDeps, connectionId: string) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const rows = await ctx.tx.query<FilingRow>(`select * from gst_filings where tenant_id = $1 and connection_id = $2 order by right(period, 4) desc, left(period, 2) desc, return_type`, [ctx.tenantId, connectionId]);
    return rows.map((r) => filingDto(r));
  });
}

export async function getFiling(deps: GstDeps, id: string) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const f = await loadFiling(ctx, id);
    const events = await ctx.tx.query(
      `select e.action, e.ok, e.message, e.created_at, u.full_name as by from gst_events e left join users u on u.id = e.created_by where e.tenant_id = $1 and e.filing_id = $2 order by e.created_at`,
      [ctx.tenantId, id],
    );
    return { ...filingDto(f, true), events };
  });
}

const MAX_PAYLOAD = 5_000_000;

export interface PrepareInput {
  returnType: ReturnType;
  /** MMYYYY (for ITC-04 and GSTR-9: the last month of the period) */
  period: string;
  /** portal JSON prepared elsewhere (any form) */
  payload?: Record<string, unknown> | null;
  /** ITC-04 date range (YYYY-MM-DD) */
  from?: string;
  to?: string;
}

/** Prepares a return from Synapse's records (GSTR-1, GSTR-3B, ITC-04) or from uploaded portal JSON. */
export async function prepareFiling(deps: GstDeps, connectionId: string, input: PrepareInput) {
  if (!FORMS[input.returnType]) throw badRequest('Unknown return type');
  fromRetPeriod(input.period);
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, connectionId);
    let payload: Record<string, unknown>;
    let source: 'synapse' | 'upload';
    let extra: Record<string, unknown> = {};
    if (input.payload) {
      const size = JSON.stringify(input.payload).length;
      if (size > MAX_PAYLOAD) throw badRequest('That JSON is too large (5 MB at most)');
      const g = (input.payload as any).gstin;
      if (g && String(g).toUpperCase() !== c.gstin) throw badRequest(`That JSON is for ${g}, not ${c.gstin}`);
      payload = input.payload;
      source = 'upload';
    } else if ((BUILDABLE as readonly string[]).includes(input.returnType)) {
      const month = fromRetPeriod(input.period);
      if (input.returnType === 'GSTR1') {
        const b = await buildGstr1(ctx, c.gstin, month);
        payload = b.payload;
        extra = { counts: b.counts, totals: b.totals, warnings: b.warnings };
      } else if (input.returnType === 'GSTR3B') {
        const b = await buildGstr3b(ctx, c.gstin, month);
        payload = b.payload;
        extra = { working: b.working, warnings: b.warnings };
      } else {
        const to = input.to ?? new Date(Date.UTC(Number(input.period.slice(2)), Number(input.period.slice(0, 2)), 0)).toISOString().slice(0, 10);
        const from = input.from ?? `${Number(input.period.slice(2)) - (Number(input.period.slice(0, 2)) <= 3 ? 1 : 0)}-04-01`;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw badRequest('Choose the dates the ITC-04 covers');
        const b = await buildItc04(ctx, c.gstin, input.period, from, to);
        payload = b.payload;
        extra = { counts: b.counts, warnings: b.warnings, from, to };
      }
      source = 'synapse';
    } else {
      throw badRequest(`${FORMS[input.returnType]!.label} is prepared outside Synapse: upload the portal JSON, or start from the portal's own figures`);
    }
    const old = await ctx.tx.one<FilingRow>(`select * from gst_filings where tenant_id = $1 and connection_id = $2 and return_type = $3 and period = $4 for update`, [
      ctx.tenantId,
      connectionId,
      input.returnType,
      input.period,
    ]);
    if (old?.status === 'filed') throw conflict(`${FORMS[input.returnType]!.label} for ${input.period} has already been filed`);
    if (old && ['submitted', 'offset'].includes(old.status)) throw conflict('This return has already been submitted on the portal; its figures can no longer be changed');
    const row = old
      ? (await ctx.tx.one<FilingRow>(
          `update gst_filings set payload = $3, payload_source = $4, status = 'prepared', ref_id = null, portal_status = null, error_report = null, summary = null where tenant_id = $1 and id = $2 returning *`,
          [ctx.tenantId, old.id, JSON.stringify(payload), source],
        ))!
      : (await ctx.tx.one<FilingRow>(
          `insert into gst_filings (tenant_id, connection_id, return_type, period, payload, payload_source) values ($1,$2,$3,$4,$5,$6) returning *`,
          [ctx.tenantId, connectionId, input.returnType, input.period, JSON.stringify(payload), source],
        ))!;
    await logEvent(ctx, { connectionId, filingId: row.id, action: 'prepare', ok: true, message: source === 'upload' ? 'From uploaded JSON' : 'From Synapse records' });
    return { ...filingDto(row, true), ...extra };
  });
}

/** Starts a return from the portal's own figures (GSTR-9 auto-calculation, GSTR-2X credits to accept). */
export async function prepareFromPortal(deps: GstDeps, connectionId: string, returnType: 'GSTR9' | 'GSTR2X', period: string) {
  fromRetPeriod(period);
  const gstin = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return (await loadConn(ctx, connectionId)).gstin;
  });
  let payload: Record<string, unknown>;
  if (returnType === 'GSTR9') {
    const r = await portalCall(deps, connectionId, 'GET', '/gstr9/getautocal', { query: { gstin, retperiod: period } }, { action: 'view.gstr9_autocalc' });
    const d = r.data ?? {};
    payload = { ...d, gstin, fp: period };
  } else {
    const rows: any[] = [];
    for (const rectype of ['TDS', 'TCS'] as const) {
      const r = await portalCall(deps, connectionId, 'GET', '/gstr2x/tdstcs', { query: { gstin, retperiod: period, rectype } }, { action: 'view.gstr2x' }).catch((e) => {
        if (e instanceof ApiError && e.code === 'gst_session_required') throw e;
        return null;
      });
      const list: any[] = r?.data?.[rectype.toLowerCase()] ?? r?.data?.tdstcs ?? [];
      for (const x of list) rows.push({ rectype, ...x });
    }
    if (!rows.length) throw badRequest('The portal shows no TDS or TCS credits for this period');
    const entry = (x: any) => ({ flag: 'A', ctin: x.ctin ?? x.gstin_ded ?? x.gstin_ecom, ...(x.month ? { month: x.month } : {}), ...(x.omonth ? { omonth: x.omonth } : {}), chksum: x.chksum });
    payload = { gstin, fp: period };
    const tds = rows.filter((x) => x.rectype === 'TDS').map(entry);
    const tcs = rows.filter((x) => x.rectype === 'TCS').map(entry);
    if (tds.length) payload.tds = tds;
    if (tcs.length) payload.tcs = tcs;
  }
  return deps.run(async (ctx) => {
    const old = await ctx.tx.one<FilingRow>(`select * from gst_filings where tenant_id = $1 and connection_id = $2 and return_type = $3 and period = $4 for update`, [ctx.tenantId, connectionId, returnType, period]);
    if (old?.status === 'filed') throw conflict('This return has already been filed');
    const row = old
      ? (await ctx.tx.one<FilingRow>(
          `update gst_filings set payload = $3, payload_source = 'portal', status = 'prepared', ref_id = null, portal_status = null, error_report = null, summary = null where tenant_id = $1 and id = $2 returning *`,
          [ctx.tenantId, old.id, JSON.stringify(payload)],
        ))!
      : (await ctx.tx.one<FilingRow>(`insert into gst_filings (tenant_id, connection_id, return_type, period, payload, payload_source) values ($1,$2,$3,$4,$5,'portal') returning *`, [
          ctx.tenantId,
          connectionId,
          returnType,
          period,
          JSON.stringify(payload),
        ]))!;
    await logEvent(ctx, { connectionId, filingId: row.id, action: 'prepare', ok: true, message: 'From the portal' });
    return filingDto(row, true);
  });
}

async function filingContext(deps: GstDeps, id: string, allowed: FilingRow['status'][]) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const f = await loadFiling(ctx, id);
    if (!allowed.includes(f.status)) throw conflict(`Not possible while the return is ${f.status}`);
    const c = await loadConn(ctx, f.connection_id);
    return { f, c, form: FORMS[f.return_type]! };
  });
}

async function updateFiling(deps: GstDeps, id: string, set: Record<string, unknown>) {
  return deps.run(async (ctx) => {
    const cols = Object.keys(set);
    const row = await ctx.tx.one<FilingRow>(
      `update gst_filings set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, ...cols.map((k) => (set[k] !== null && typeof set[k] === 'object' ? JSON.stringify(set[k]) : set[k]))],
    );
    return filingDto(row!, false);
  });
}

/** Saves the prepared data to the portal. GSTN processes it in the background: check its status next. */
export async function saveFiling(deps: GstDeps, id: string) {
  const { f, c, form } = await filingContext(deps, id, ['prepared', 'error', 'saved']);
  if (!f.payload) throw badRequest('Prepare the return first');
  const save = form.save ?? { method: 'PUT' as const, path: `${form.path}/retsave` };
  const r = await portalCall(deps, c.id, save.method, save.path, { headers: { gstin: c.gstin, ret_period: f.period }, body: f.payload }, { action: 'save', filingId: id });
  const ref = pick(r, 'reference_id', 'ref_id', 'refid', 'referenceId', 'reference_no');
  return updateFiling(deps, id, ref ? { status: 'saving', ref_id: String(ref), portal_status: 'REC', error_report: null } : { status: 'saved', portal_status: 'P', error_report: null });
}

const STATUS_TEXT: Record<string, string> = { P: 'Processed', PE: 'Processed with errors', ER: 'Error', IP: 'In progress', REC: 'Received' };

/** Asks the portal how the last save (or proceed) went. */
export async function checkFiling(deps: GstDeps, id: string) {
  const { f, c } = await filingContext(deps, id, ['saving', 'saved', 'error', 'submitted', 'offset']);
  if (!f.ref_id) throw badRequest('Nothing is being processed on the portal for this return');
  const r = await portalCall(deps, c.id, 'GET', '/gstr/retstatus', { query: { gstin: c.gstin, returnperiod: f.period, refid: f.ref_id } }, { action: 'status', filingId: id });
  const st = String(pick(r, 'status_cd') ?? '').toUpperCase();
  const code = STATUS_TEXT[st] ? st : 'IP';
  const report = r.data?.error_report ?? r.data?.errorReport ?? null;
  const proceeded = f.status === 'submitted' || f.status === 'offset' || f.portal_status === 'PROCEED';
  const next: FilingRow['status'] =
    code === 'P' ? (f.status === 'offset' ? 'offset' : proceeded ? 'submitted' : 'saved') : code === 'PE' || code === 'ER' ? 'error' : proceeded ? f.status === 'offset' ? 'offset' : 'submitted' : 'saving';
  const out = await updateFiling(deps, id, { status: next, portal_status: code, error_report: report });
  return { ...out, statusText: STATUS_TEXT[code] };
}

/** GSTR-1 / 1A "proceed to file" (and GSTR-6 submit): the portal freezes the data and builds the summary. */
export async function proceedFiling(deps: GstDeps, id: string, opts: { nil?: boolean } = {}) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'prepared']);
  if (!form.proceed) throw badRequest(`${form.label} does not need this step`);
  if (f.status === 'prepared' && !opts.nil) throw badRequest('Save the return to the portal first');
  let r: WbResult;
  if (form.proceed === 'r1') r = await portalCall(deps, c.id, 'GET', '/all/newproceedfile', { query: { gstin: c.gstin, retperiod: f.period, type: 'R1', isNil: opts.nil ? 'Y' : 'N' } }, { action: 'proceed', filingId: id });
  else if (form.proceed === 'r1a') r = await portalCall(deps, c.id, 'GET', '/gstr1a/proceedfile', { query: { gstin: c.gstin, retperiod: f.period, isNil: opts.nil ? 'Y' : 'N' } }, { action: 'proceed', filingId: id });
  else r = await portalCall(deps, c.id, 'POST', `${form.path}/retsubmit`, { headers: { gstin: c.gstin, ret_period: f.period }, body: { gstin: c.gstin, ret_period: f.period } }, { action: 'submit', filingId: id });
  const ref = pick(r, 'reference_id', 'ref_id', 'refid', 'referenceId');
  return updateFiling(deps, id, ref ? { status: 'submitted', ref_id: String(ref), portal_status: 'PROCEED' } : { status: 'submitted', portal_status: 'P' });
}

/** Fetches the return summary from the portal; it is what gets filed. */
export async function summaryFiling(deps: GstDeps, id: string) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'submitted', 'offset', 'error', 'filed']);
  const r = await portalCall(deps, c.id, 'GET', `${form.path}/retsum`, { query: { gstin: c.gstin, retperiod: f.period } }, { action: 'summary', filingId: id });
  if (r.data == null) throw new GspError('The portal returned no summary yet; try again in a minute', null, r);
  return updateFiling(deps, id, { summary: r.data });
}

/* GSTR-3B offset */

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const rr = (x: number) => Math.round(x * 100) / 100;

/**
 * Proposes how to pay GSTR-3B's liability: forward-charge tax from ITC (IGST credit first, then
 * CGST / SGST credit; CGST and SGST credit never cross), the rest, reverse-charge tax, interest and
 * late fee from the cash ledger. Reads the liability from the summary's tx_pmt and the balances
 * from the portal; the user reviews it before it is sent.
 */
export async function proposeOffset(deps: GstDeps, id: string) {
  const { f, c } = await filingContext(deps, id, ['saved', 'submitted', 'error']);
  if (f.return_type !== 'GSTR3B') throw badRequest('Only GSTR-3B is offset');
  if (!f.summary) throw badRequest('Fetch the return summary first');
  const bal = await portalCall(deps, c.id, 'GET', '/ledgers/bal', { query: { gstin: c.gstin, retperiod: f.period } }, { action: 'view.ledger_balance', quiet: true });
  const itcBal = bal.data?.itc_bal ?? {};
  const credit = { i: n(itcBal.igst_bal), c: n(itcBal.cgst_bal), s: n(itcBal.sgst_bal), cs: n(itcBal.cess_bal) };
  const cashBal = bal.data?.cash_bal ?? {};
  const cashAvail = { i: n(cashBal.igst_tot_bal ?? cashBal.igst?.tot), c: n(cashBal.cgst_tot_bal ?? cashBal.cgst?.tot), s: n(cashBal.sgst_tot_bal ?? cashBal.sgst?.tot), cs: n(cashBal.cess_tot_bal ?? cashBal.cess?.tot) };
  const rows: any[] = f.summary?.tx_pmt?.tx_py ?? f.summary?.tx_pmt?.txpy ?? [];
  if (!rows.length) throw badRequest('The summary has no tax payable (tx_pmt); fetch it again after saving GSTR-3B');
  const pdcash: any[] = [];
  let pditc: any = null;
  const cashNeed = { i: 0, c: 0, s: 0, cs: 0 };
  for (const t of rows) {
    const tax = { i: n(t.igst?.tx), c: n(t.cgst?.tx), s: n(t.sgst?.tx), cs: n(t.cess?.tx) };
    const intr = { i: n(t.igst?.intr), c: n(t.cgst?.intr), s: n(t.sgst?.intr), cs: n(t.cess?.intr) };
    const fee = { c: n(t.cgst?.fee), s: n(t.sgst?.fee) };
    const forward = Number(t.trans_typ) === 30002;
    let due = { ...tax };
    if (forward) {
      const used = { i_pdi: 0, i_pdc: 0, i_pds: 0, c_pdi: 0, c_pdc: 0, s_pdi: 0, s_pds: 0, cs_pdcs: 0 };
      const take = (from: 'i' | 'c' | 's' | 'cs', to: 'i' | 'c' | 's' | 'cs', k: keyof typeof used, cap = Infinity) => {
        const x = rr(Math.max(0, Math.min(credit[from], due[to], cap)));
        credit[from] = rr(credit[from] - x);
        due[to] = rr(due[to] - x);
        used[k] = rr(used[k] + x);
      };
      take('i', 'i', 'i_pdi');
      take('i', 'c', 'i_pdc', due.c - credit.c);
      take('i', 's', 'i_pds', due.s - credit.s);
      take('i', 'c', 'i_pdc');
      take('i', 's', 'i_pds');
      take('c', 'c', 'c_pdc');
      take('c', 'i', 'c_pdi');
      take('s', 's', 's_pds');
      take('s', 'i', 's_pdi');
      take('cs', 'cs', 'cs_pdcs');
      pditc = { liab_ldg_id: t.liab_ldg_id, trans_typ: Number(t.trans_typ), ...used };
    }
    due = { i: rr(due.i), c: rr(due.c), s: rr(due.s), cs: rr(due.cs) };
    for (const k of ['i', 'c', 's', 'cs'] as const) cashNeed[k] = rr(cashNeed[k] + due[k] + intr[k] + (k === 'c' ? fee.c : k === 's' ? fee.s : 0));
    pdcash.push({
      liab_ldg_id: t.liab_ldg_id,
      trans_typ: Number(t.trans_typ),
      ipd: due.i,
      cpd: due.c,
      spd: due.s,
      cspd: due.cs,
      i_intrpd: intr.i,
      c_intrpd: intr.c,
      s_intrpd: intr.s,
      cs_intrpd: intr.cs,
      c_lfeepd: fee.c,
      s_lfeepd: fee.s,
    });
  }
  const shortfall = { igst: rr(Math.max(0, cashNeed.i - cashAvail.i)), cgst: rr(Math.max(0, cashNeed.c - cashAvail.c)), sgst: rr(Math.max(0, cashNeed.s - cashAvail.s)), cess: rr(Math.max(0, cashNeed.cs - cashAvail.cs)) };
  return { offset: { pdcash, ...(pditc ? { pditc } : {}) }, cashNeeded: { igst: cashNeed.i, cgst: cashNeed.c, sgst: cashNeed.s, cess: cashNeed.cs }, cashAvailable: { igst: cashAvail.i, cgst: cashAvail.c, sgst: cashAvail.s, cess: cashAvail.cs }, shortfall };
}

/** Sends the reviewed offset (GSTR-3B): pays the liability from the ledgers. */
export async function offsetFiling(deps: GstDeps, id: string, body: { pdcash: unknown[]; pditc?: unknown }) {
  const { f, c } = await filingContext(deps, id, ['saved', 'submitted', 'error']);
  if (f.return_type !== 'GSTR3B') throw badRequest('Only GSTR-3B is offset');
  if (!Array.isArray(body.pdcash)) throw badRequest('pdcash is required');
  await portalCall(deps, c.id, 'PUT', '/gstr3b/retoffset', { headers: { gstin: c.gstin, ret_period: f.period }, body }, { action: 'offset', filingId: id });
  return updateFiling(deps, id, { status: 'offset' });
}

/* filing */

export async function requestEvcOtp(deps: GstDeps, id: string, pan?: string | null) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'submitted', 'offset']);
  const p = (pan ?? c.signatory_pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) throw badRequest("Enter the authorised signatory's PAN");
  await portalCall(deps, c.id, 'GET', '/authentication/otpforevc', { query: { gstin: c.gstin, pan: p, form_type: form.evc } }, { action: 'evc.otp', filingId: f.id });
  return { ok: true };
}

/**
 * Files the return with the summary as fetched. EVC needs the OTP sent to the signatory; DSC needs
 * the signatory's DSC registered on the GST portal (and WhiteBooks' signer).
 */
export async function fileFiling(deps: GstDeps, id: string, input: { mode: 'evc' | 'dsc'; pan?: string | null; otp?: string | null }) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'submitted', 'offset']);
  if (!f.summary) throw badRequest('Fetch and check the return summary first');
  if (form.proceed && f.status === 'saved') throw badRequest('Proceed to file first, then fetch the summary again');
  if (form.offset && f.status !== 'offset') throw badRequest('Offset the liability first');
  const pan = (input.pan ?? c.signatory_pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw badRequest("Enter the authorised signatory's PAN");
  if (input.mode === 'evc' && !/^\d{6}$/.test(input.otp ?? '')) throw badRequest('Enter the 6-digit EVC OTP');
  const r =
    input.mode === 'evc'
      ? await portalCall(deps, c.id, 'POST', `${form.path}/retevcfile`, { query: { pan, evcotp: input.otp! }, headers: { gstin: c.gstin, ret_period: f.period }, body: f.summary }, { action: 'file.evc', filingId: id })
      : await portalCall(deps, c.id, 'POST', `${form.path}/retfile`, { query: { pan }, headers: { gstin: c.gstin, ret_period: f.period }, body: f.summary }, { action: 'file.dsc', filingId: id });
  const arn = pick(r, 'ack_num', 'arn', 'ackNum', 'ack_no', 'ARN');
  return deps.run(async (ctx) => {
    const row = (await ctx.tx.one<FilingRow>(
      `update gst_filings set status = 'filed', arn = $3, filed_at = now(), filed_by = app.current_user_id(), filing_mode = $4 where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, arn ? String(arn).slice(0, 40) : null, input.mode],
    ))!;
    await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'gst_file', $2, $3)`, [ctx.tenantId, 'gst_filing', JSON.stringify({ gstin: c.gstin, form: f.return_type, period: f.period, arn, mode: input.mode })]);
    if (pan !== c.signatory_pan) await ctx.tx.query(`update gst_connections set signatory_pan = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, c.id, pan]);
    return filingDto(row);
  });
}

/** Resets saved GSTR-1 data on the portal (before it is filed). */
export async function resetFiling(deps: GstDeps, id: string) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'error', 'saving']);
  if (!['GSTR1', 'GSTR1A'].includes(f.return_type)) throw badRequest(`${form.label} cannot be reset this way`);
  await portalCall(deps, c.id, 'POST', `${form.path}/reset`, { headers: { gstin: c.gstin, ret_period: f.period }, body: { gstin: c.gstin, ret_period: f.period } }, { action: 'reset', filingId: id });
  return updateFiling(deps, id, { status: 'prepared', ref_id: null, portal_status: null, error_report: null, summary: null });
}

/* ───────────────────────── GSTR-2B into reconciliation ───────────────────────── */

export function gstr2bRows(data: any): Gstr2bRow[] {
  const doc = data?.data?.docdata ?? data?.docdata ?? {};
  const out: Gstr2bRow[] = [];
  const dt = (s: unknown) => {
    const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(s ?? ''));
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  };
  for (const s of doc.b2b ?? [])
    for (const i of s.inv ?? [])
      out.push({ supplierGstin: s.ctin, supplierName: s.trdnm ?? null, docNumber: String(i.inum), docDate: dt(i.dt), docType: 'invoice', taxable: n(i.txval), igst: n(i.igst), cgst: n(i.cgst), sgst: n(i.sgst), itcAvailable: (i.itcavl ?? 'Y') !== 'N' });
  for (const s of doc.b2ba ?? [])
    for (const i of s.inv ?? [])
      out.push({ supplierGstin: s.ctin, supplierName: s.trdnm ?? null, docNumber: String(i.inum), docDate: dt(i.dt), docType: 'invoice', taxable: n(i.txval), igst: n(i.igst), cgst: n(i.cgst), sgst: n(i.sgst), itcAvailable: (i.itcavl ?? 'Y') !== 'N' });
  for (const s of doc.cdnr ?? [])
    for (const x of s.nt ?? []) {
      const sign = (x.typ ?? 'C') === 'C' ? -1 : 1;
      out.push({ supplierGstin: s.ctin, supplierName: s.trdnm ?? null, docNumber: String(x.ntnum), docDate: dt(x.dt), docType: sign < 0 ? 'credit_note' : 'debit_note', taxable: sign * n(x.txval), igst: sign * n(x.igst), cgst: sign * n(x.cgst), sgst: sign * n(x.sgst), itcAvailable: (x.itcavl ?? 'Y') !== 'N' });
    }
  return out.filter((r) => r.supplierGstin && r.docNumber);
}

/** Fetches GSTR-2B for a period and matches it against bills (the reconciliation in Books). */
export async function importGstr2bFromPortal(deps: GstDeps, connectionId: string, period: string) {
  fromRetPeriod(period);
  const gstin = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return (await loadConn(ctx, connectionId)).gstin;
  });
  const first = await portalCall(deps, connectionId, 'GET', '/gstr2b/all', { query: { gstin, rtnprd: period } }, { action: 'view.gstr2b' });
  const rows = gstr2bRows(first.data);
  const fc = n(first.data?.data?.fc ?? first.data?.fc);
  for (let k = 2; k <= Math.min(fc, 50); k++) {
    const r = await portalCall(deps, connectionId, 'GET', '/gstr2b/all', { query: { gstin, rtnprd: period, filenum: k } }, { action: 'view.gstr2b', quiet: true });
    rows.push(...gstr2bRows(r.data));
  }
  return deps.run(async (ctx) => ({ ...(await importGstr2b(ctx, period, rows)), fetched: rows.length }));
}

/* ───────────────────────── challan ───────────────────────── */

export interface ChallanInput {
  period: string;
  mode: 'EPY' | 'NEFT' | 'OTC' | 'UPI';
  bankCode?: string | null;
  email: string;
  mobile: string;
  reason?: string;
  amounts: Partial<Record<'igst' | 'cgst' | 'sgst' | 'cess', { tax?: number; interest?: number; fee?: number; penalty?: number; other?: number }>>;
}

/** Creates a GST payment challan (PMT-06) on the portal; pay it with the CPIN at the bank. */
export async function createChallan(deps: GstDeps, connectionId: string, input: ChallanInput) {
  fromRetPeriod(input.period);
  const { c, company } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, connectionId);
    const t = await ctx.tx.one<{ name: string; settings: any }>(`select name, settings from tenants where id = $1`, [ctx.tenantId]);
    return { c, company: (t?.settings?.company ?? {}) as Record<string, string>, name: t?.name };
  });
  const body: Record<string, unknown> = {
    gstin: c.gstin,
    email_id: input.email,
    mobile_num: input.mobile,
    tp_name: c.legal_name ?? company.legalName ?? '',
    address: (company.address ?? '').slice(0, 200),
    payment_mod: input.mode,
    ...(input.bankCode ? { bank_cd: input.bankCode } : {}),
    ipAddr: deps.ip,
    chln_rsn: input.reason ?? 'AOP',
    chln_prd: input.period,
  };
  let total = 0;
  for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
    const a = input.amounts[head] ?? {};
    const v = { tax: rr(n(a.tax)), int: rr(n(a.interest)), fee: rr(n(a.fee)), pen: rr(n(a.penalty)), oth: rr(n(a.other)) };
    const tot = rr(v.tax + v.int + v.fee + v.pen + v.oth);
    Object.assign(body, { [`${head}_tax_amt`]: v.tax, [`${head}_int_amt`]: v.int, [`${head}_fee_amt`]: v.fee, [`${head}_pen_amt`]: v.pen, [`${head}_oth_amt`]: v.oth, [`${head}_tot_amt`]: tot });
    total = rr(total + tot);
  }
  if (!(total > 0)) throw badRequest('Enter the amounts to pay');
  body.total_amt = total;
  const r = await portalCall(deps, connectionId, 'POST', '/payment/generateChallan', { headers: { gstin: c.gstin, ret_period: input.period }, body }, { action: 'challan.create' });
  return { cpin: pick(r, 'cpin', 'CPIN') ?? null, total, expiresOn: pick(r, 'chln_exp_dt', 'expiry') ?? null, data: r.data };
}

/* ───────────────────────── log ───────────────────────── */

export async function connectionLog(deps: GstDeps, connectionId: string) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return ctx.tx.query(
      `select e.action, e.ok, e.message, e.created_at, e.filing_id, e.invoice_id, u.full_name as by from gst_events e left join users u on u.id = e.created_by
        where e.tenant_id = $1 and e.connection_id = $2 order by e.created_at desc limit 200`,
      [ctx.tenantId, connectionId],
    );
  });
}
