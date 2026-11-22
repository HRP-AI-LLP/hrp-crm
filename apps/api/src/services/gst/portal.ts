/**
 * The GST portal through a GST Suvidha Provider (see provider.ts): connecting a GSTIN (OTP), the session, what the
 * portal holds (ledgers, liabilities, filed returns, notices, challans, GSTR-2B, GSTR-2X) and
 * filing returns (save → status → proceed/submit → summary → offset → file with EVC or DSC).
 *
 * Calls to the GSP never run inside a database transaction: each step reads what it needs in
 * one short transaction, calls the GSP, and records the outcome in another.
 *
 * Access: books or billing admins. Credentials (e-invoice / e-way bill passwords) and the session
 * (txn, IRP token) are stored encrypted and never returned.
 */
import { hasAdmin, validGstin } from '@synapse/shared';
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { gstr2bReport, importGstr2b, type Gstr2bRow } from '../books/setup';
import type { RecordCtx } from '../records';
import { BUILDABLE, buildGstr1, buildGstr3b, buildItc04, filingCalendar, fromRetPeriod } from './returns';
import { getProvider, requireProvider, type Form as FormCode, type GspConn, type GspProvider, type GstOp, type Secrets, type Session } from './provider';
import { GspError, pick, type WbResult } from './whitebooks';

export type { Secrets, Session } from './provider';

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

interface FormInfo {
  label: string;
  /** GSTR-3B: the liability is paid from the ledgers before filing */
  offset?: boolean;
}
export const FORMS: Record<FormCode, FormInfo> = {
  GSTR1: { label: 'GSTR-1' },
  GSTR1A: { label: 'GSTR-1A' },
  GSTR3B: { label: 'GSTR-3B', offset: true },
  GSTR7: { label: 'GSTR-7 (TDS deducted)' },
  GSTR2X: { label: 'GSTR-2X (TDS/TCS credit received)' },
  ITC04: { label: 'ITC-04 (job work)' },
  GSTR9: { label: 'GSTR-9 (annual)' },
  GSTR9C: { label: 'GSTR-9C (reconciliation)' },
  GSTR6: { label: 'GSTR-6 (ISD)' },
  GSTR8: { label: 'GSTR-8 (e-commerce TCS)' },
  CMP08: { label: 'CMP-08 (composition)' },
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
export const gspConn = (c: Pick<ConnRow, 'id' | 'gstin' | 'gst_username' | 'einv_username' | 'ewb_username'>): GspConn => ({
  id: c.id,
  gstin: c.gstin,
  gstUsername: c.gst_username,
  einvUsername: c.einv_username,
  ewbUsername: c.ewb_username,
});

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

/** Keeps a provider's answer with the event, up to 1 MB (the paid answers are never thrown away). */
export function keepable(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  const j = JSON.stringify(data);
  return j.length <= 1_000_000 ? j : JSON.stringify({ truncated: true, bytes: j.length });
}

export async function logEvent(
  ctx: RecordCtx,
  e: { connectionId?: string | null; filingId?: string | null; invoiceId?: string | null; action: string; ok: boolean; message?: string | null; provider?: string | null; data?: unknown },
) {
  await ctx.tx.query(`insert into gst_events (tenant_id, connection_id, filing_id, invoice_id, action, ok, message, provider, data) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    ctx.tenantId,
    e.connectionId ?? null,
    e.filingId ?? null,
    e.invoiceId ?? null,
    e.action.slice(0, 60),
    e.ok,
    e.message ? e.message.slice(0, 2000) : null,
    e.provider ?? null,
    keepable(e.data),
  ]);
}

/* ───────────────────────── our own copy of what the APIs returned ───────────────────────── */

export interface CacheHit<T> {
  data: T;
  /** true when served from the database without calling the provider */
  cached: boolean;
  fetchedAt: string;
}

/**
 * Reads (taxpayer details, return history, …) come from gst_api_cache when we have them; the
 * provider is called only when nothing is stored or `refresh` is asked for (the Refresh buttons).
 */
export async function cachedLookup<T>(deps: GstDeps, spec: { scope: string; kind: string; key?: string }, refresh: boolean, fetch: () => Promise<T>): Promise<CacheHit<T>> {
  const key = (spec.key ?? '').slice(0, 120);
  if (!refresh) {
    const hit = await deps.run(async (ctx) => {
      const row = await ctx.tx.one<{ data: T; fetched_at: string }>(
        `update gst_api_cache set hits = hits + 1 where tenant_id = $1 and scope = $2 and kind = $3 and key = $4 returning data, fetched_at`,
        [ctx.tenantId, spec.scope, spec.kind, key],
      );
      return row;
    });
    if (hit) return { data: hit.data, cached: true, fetchedAt: new Date(hit.fetched_at).toISOString() };
  }
  const data = await fetch();
  const provider = getProvider(deps.env)?.id ?? null;
  await deps.run((ctx) =>
    ctx.tx.query(
      `insert into gst_api_cache (tenant_id, scope, kind, key, provider, data) values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant_id, scope, kind, key) do update set data = excluded.data, provider = excluded.provider, fetched_at = now(), fetched_by = app.current_user_id()`,
      [ctx.tenantId, spec.scope, spec.kind, key, provider, keepable(data) ?? 'null'],
    ),
  );
  return { data, cached: false, fetchedAt: new Date().toISOString() };
}

export async function listConnections(deps: GstDeps) {
  const gp = getProvider(deps.env);
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const rows = await ctx.tx.query<ConnRow>(`select * from gst_connections where tenant_id = $1 order by created_at`, [ctx.tenantId]);
    const out = [];
    for (const r of rows) {
      const s = await unseal<Secrets>(deps.env, ctx.tenantId, r.secret_ciphertext);
      out.push({ ...connDto(r), hasEinvPassword: !!s.einvPassword, hasEwbPassword: !!s.ewbPassword });
    }
    return {
      gsp: gp
        ? {
            provider: gp.label,
            id: gp.id,
            configured: true,
            sandbox: gp.sandbox,
            nicSandbox: gp.nicSandbox,
            forms: gp.forms,
            challan: gp.challan,
            dsc: gp.dsc,
            views: gp.views,
            steps: gp.steps ?? { status: true, summary: true },
            publicTrack: !!gp.returnTrack,
          }
        : { provider: null, id: null, configured: false, sandbox: false, nicSandbox: false, forms: [], challan: false, dsc: false, views: [], steps: { status: true, summary: true }, publicTrack: false },
      connections: out,
    };
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

async function saveSession(ctx: RecordCtx, env: Env, id: string, session: Session, set = '') {
  await ctx.tx.query(`update gst_connections set session_ciphertext = $3${set} where tenant_id = $1 and id = $2`, [
    ctx.tenantId,
    id,
    Object.keys(session).length ? await seal(env, ctx.tenantId, session) : null,
  ]);
}

/** Asks the GST portal to send an OTP to the taxpayer's registered mobile and email. */
export async function requestOtp(deps: GstDeps, id: string) {
  const gp = requireProvider(deps.env);
  const { c, session } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    return { c, session: await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext) };
  });
  if (!c.gst_username) throw badRequest('Enter the GST portal username for this GSTIN first');
  const step = await gp.requestOtp(gspConn(c), session, deps.ip);
  return deps.run(async (ctx) => {
    if (!step.result.ok) {
      const msg = gp.hint(step.result.message);
      await ctx.tx.query(`update gst_connections set last_error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, msg.slice(0, 1000)]);
      await logEvent(ctx, { connectionId: id, action: 'otp.request', ok: false, message: msg });
      throw new GspError(msg, step.result.code, step.result);
    }
    await loadConn(ctx, id, true);
    await saveSession(ctx, deps.env, id, step.session, `, status = 'otp_sent', otp_sent_at = now(), session_expires_at = null, last_error = null`);
    await logEvent(ctx, { connectionId: id, action: 'otp.request', ok: true, message: gp.sandbox ? 'Sandbox: the OTP is 575757' : null });
    return { ok: true, sandbox: gp.sandbox };
  });
}

/** Verifies the OTP and starts a 6-hour portal session. */
export async function verifyOtp(deps: GstDeps, id: string, otp: string) {
  if (!/^\d{4,8}$/.test(otp)) throw badRequest('Enter the OTP from the GST portal');
  const gp = requireProvider(deps.env);
  const { c, session } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    if (c.status !== 'otp_sent') throw badRequest('Request an OTP first');
    if (c.otp_sent_at && Date.now() - Date.parse(c.otp_sent_at) > 15 * 60_000) throw badRequest('The OTP has expired; request a new one');
    return { c, session: await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext) };
  });
  const step = await gp.verifyOtp(gspConn(c), session, otp, deps.ip);
  return deps.run(async (ctx) => {
    if (!step.result.ok) {
      await ctx.tx.query(`update gst_connections set last_error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, step.result.message.slice(0, 1000)]);
      await logEvent(ctx, { connectionId: id, action: 'otp.verify', ok: false, message: step.result.message });
      throw new GspError(step.result.message, step.result.code, step.result);
    }
    await loadConn(ctx, id, true);
    const minutes = step.minutes ?? SESSION_MINUTES;
    await saveSession(ctx, deps.env, id, step.session, `, status = 'active', session_started_at = now(), session_expires_at = now() + make_interval(mins => ${Math.round(minutes)}), last_error = null`);
    await logEvent(ctx, { connectionId: id, action: 'otp.verify', ok: true });
    return connDto((await loadConn(ctx, id))!);
  });
}

export async function disconnect(deps: GstDeps, id: string) {
  const gp = getProvider(deps.env);
  const { c, session } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    return { c, session: await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext) };
  });
  if (gp && c.status === 'active') await gp.logout(gspConn(c), session, deps.ip).catch(() => null);
  return deps.run(async (ctx) => {
    await loadConn(ctx, id, true);
    const { txn: _t, ic: _i, ...rest } = session;
    await saveSession(ctx, deps.env, id, rest, `, status = 'disconnected', session_expires_at = null`);
    await logEvent(ctx, { connectionId: id, action: 'disconnect', ok: true });
    return { ok: true };
  });
}

/** The live session: refreshed when it has under 45 minutes left; an error when there is none. */
async function liveSession(deps: GstDeps, gp: GspProvider, id: string): Promise<{ c: ConnRow; session: Session }> {
  const { c, session } = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    return { c, session: await unseal<Session>(deps.env, ctx.tenantId, c.session_ciphertext) };
  });
  const exp = c.session_expires_at ? Date.parse(c.session_expires_at) : 0;
  if (c.status !== 'active' || exp <= Date.now()) throw new ApiError(409, 'gst_session_required', 'Connect to the GST portal first: request an OTP and enter it (the session lasts 6 hours)');
  if (exp - Date.now() > REFRESH_WITHIN_MS) return { c, session };
  const step = await gp.refresh(gspConn(c), session, deps.ip);
  return deps.run(async (ctx) => {
    if (!step.result.ok) {
      await logEvent(ctx, { connectionId: id, action: 'session.refresh', ok: false, message: step.result.message });
      return { c, session }; // the old session still has some time; the next call may refresh again
    }
    await loadConn(ctx, id, true);
    await saveSession(ctx, deps.env, id, step.session, `, session_expires_at = now() + make_interval(mins => ${Math.round(step.minutes ?? SESSION_MINUTES)})`);
    await logEvent(ctx, { connectionId: id, action: 'session.refresh', ok: true });
    return { c: (await loadConn(ctx, id))!, session: step.session };
  });
}

/** One GST API call in the connection's session; an expired session marks the connection expired. */
async function portalOp(deps: GstDeps, id: string, op: GstOp, log: { action: string; filingId?: string | null; quiet?: boolean }): Promise<WbResult> {
  const gp = requireProvider(deps.env);
  const { c, session } = await liveSession(deps, gp, id);
  const r = await gp.call(gspConn(c), session, deps.ip, op);
  const gone = !r.ok && gp.sessionGone(r);
  // every call is recorded with what came back, so nothing paid for is lost
  await deps.run(async (ctx) => {
    if (gone) await ctx.tx.query(`update gst_connections set status = 'expired', session_expires_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    await logEvent(ctx, { connectionId: id, filingId: log.filingId, action: log.action, ok: r.ok, message: r.ok ? null : r.message, provider: gp.id, data: r.ok ? r.data : r.raw });
  });
  if (!r.ok) {
    if (gone) throw new ApiError(409, 'gst_session_required', `The GST portal session has ended (${r.message}). Request a new OTP.`);
    throw new GspError(gp.hint(r.message), r.code, r);
  }
  return r;
}

/* ───────────────────────── what the portal holds ───────────────────────── */

type View = { params: string[]; optional?: string[]; dates?: string[]; label: string };
/** Read-only portal views the dashboard can fetch (the provider says which it has). Dates are given as YYYY-MM-DD and sent dd-mm-yyyy; periods are MMYYYY. */
export const VIEWS: Record<string, View> = {
  ledger_balance: { label: 'Cash and ITC balance', params: ['period'] },
  cash_ledger: { label: 'Electronic cash ledger', params: ['from', 'to'], dates: ['from', 'to'] },
  itc_ledger: { label: 'Electronic credit ledger', params: ['from', 'to'], dates: ['from', 'to'] },
  liability_ledger: { label: 'Electronic liability ledger', params: ['from', 'to'], dates: ['from', 'to'] },
  rcm_ledger: { label: 'RCM ledger', params: ['from', 'to'], dates: ['from', 'to'] },
  tax_payable: { label: 'Tax payable', params: ['period', 'returnType'] },
  return_track: { label: 'Returns filed', params: ['period'], optional: ['type'] },
  return_status: { label: 'Return status', params: ['period', 'refId'] },
  notices: { label: 'Notices and orders', params: ['from'], dates: ['from'] },
  notice: { label: 'Notice', params: ['refId'] },
  challans: { label: 'Challans', params: ['from', 'to'], dates: ['from', 'to'] },
  challan: { label: 'Challan', params: ['cpin'] },
  gstr1_summary: { label: 'GSTR-1 summary', params: ['period'] },
  gstr3b_summary: { label: 'GSTR-3B summary', params: ['period'] },
  gstr3b_autoliab: { label: 'GSTR-3B auto-calculated liability', params: ['period'] },
  gstr3b_interest: { label: 'GSTR-3B interest', params: ['period'] },
  late_fee: { label: 'Late fee', params: ['period', 'returnType'] },
  gstr2b: { label: 'GSTR-2B', params: ['period'], optional: ['fileNo'] },
  gstr2x: { label: 'TDS/TCS credits (GSTR-2X)', params: ['period', 'recType'], optional: ['fromTime'] },
  gstr7_summary: { label: 'GSTR-7 summary', params: ['period'] },
  itc04_summary: { label: 'ITC-04 summary', params: ['period'] },
  gstr9_autocalc: { label: 'GSTR-9 auto-calculated', params: ['period'] },
  gstr9_details: { label: 'GSTR-9 details', params: ['period'] },
  einvoices: { label: 'E-invoices reported (IRNs)', params: ['supplyType', 'period'] },
};
export function viewsFor(env: Env) {
  const gp = getProvider(env);
  const have = new Set(gp?.views ?? Object.keys(VIEWS));
  return Object.entries(VIEWS)
    .filter(([k]) => have.has(k))
    .map(([k, v]) => ({ kind: k, label: v.label, params: v.params, optional: v.optional ?? [], dates: v.dates ?? [] }));
}
const PARAM_RE = /^[A-Za-z0-9_.\-/ ]{1,64}$/;
const toDmy = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : s);

/** Fetches one portal view and keeps the latest copy for the dashboard. */
export async function fetchView(deps: GstDeps, id: string, kind: string, params: Record<string, string>, refresh = false) {
  const v = VIEWS[kind];
  if (!v) throw badRequest('Unknown GST portal view');
  if (!requireProvider(deps.env).views.includes(kind)) throw badRequest(`${v.label} is not available with this GST Suvidha Provider`);
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
  const cacheKey = Object.values(query).join('|').slice(0, 60);
  const stored = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    await loadConn(ctx, id);
    if (refresh) return null;
    return ctx.tx.one<{ data: any; fetched_at: string }>(`select data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = $3 and key = $4`, [ctx.tenantId, id, kind, cacheKey]);
  });
  if (stored) return { kind, label: v.label, params: query, data: stored.data, fetchedAt: new Date(stored.fetched_at).toISOString(), cached: true };
  const r = await portalOp(deps, id, { op: 'view', kind, q: query }, { action: `view.${kind}`, quiet: true });
  await deps.run(async (ctx) => {
    await ctx.tx.query(
      `insert into gst_portal_cache (tenant_id, connection_id, kind, key, data) values ($1,$2,$3,$4,$5)
       on conflict (tenant_id, connection_id, kind, key) do update set data = excluded.data, fetched_at = now()`,
      [ctx.tenantId, id, kind, cacheKey, JSON.stringify(r.data ?? r.raw ?? null)],
    );
  });
  return { kind, label: v.label, params: query, data: r.data ?? null, fetchedAt: new Date().toISOString(), cached: false };
}

/** Public taxpayer search (no OTP needed): legal name, trade name, status, address of any GSTIN. */
export async function searchTaxpayer(deps: GstDeps, gstin: string, refresh = false) {
  const g = gstin.trim().toUpperCase();
  if (!validGstin(g)) throw badRequest('That GSTIN is not valid');
  const gp = requireProvider(deps.env);
  await deps.run(async (ctx) => {
    if (!hasAdmin(ctx.principal.permissions, 'books') && !hasAdmin(ctx.principal.permissions, 'billing') && !hasAdmin(ctx.principal.permissions, 'accounts')) {
      throw forbidden();
    }
  });
  const hit = await cachedLookup(deps, { scope: g, kind: 'taxpayer' }, refresh, async () => {
    const r = await gp.search(g);
    await deps.run((ctx) => logEvent(ctx, { action: 'search', ok: r.ok, message: r.ok ? g : r.message, provider: gp.id, data: r.ok ? r.data : r.raw }));
    if (!r.ok) throw new GspError(gp.hint(r.message), r.code, r);
    return r.data ?? {};
  });
  const d: any = hit.data ?? {};
  const addr = d.pradr?.addr ?? {};
  return {
    cached: hit.cached,
    fetchedAt: hit.fetchedAt,
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
 * SanchalanOS's own filings and, if fetched, the portal's return track. No portal call is made here.
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
    const portalFiled = portalRecords(track);
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
        portal: p ?? null,
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

type PortalRecord = { arn: string | null; date: string | null; status: string | null; mode: string | null; valid: string | null; raw: Record<string, unknown>; fetchedAt: string };
/** The portal's filed-returns list (return_track cache), keyed `RETURNTYPE|MMYYYY`. */
function portalRecords(track: { data: any; fetched_at: string }[]) {
  const out = new Map<string, PortalRecord>();
  for (const t of track) {
    const list: any[] = t.data?.EFiledlist ?? t.data?.efiledlist ?? (Array.isArray(t.data) ? t.data : []);
    for (const x of list) {
      const rt = String(x.rtntype ?? x.rtn_typ ?? '').replace(/-/g, '').toUpperCase();
      const per = String(x.ret_prd ?? x.retprd ?? '');
      if (rt && per)
        out.set(`${rt}|${per}`, { arn: x.arn ?? null, date: x.dof ?? null, status: x.status ?? null, mode: x.mof ?? null, valid: x.valid ?? null, raw: x, fetchedAt: t.fetched_at });
    }
  }
  return out;
}

/**
 * One return for one period, as the calendar shows it: the portal's record of it (from the stored
 * filed-returns list, no provider call), SanchalanOS's filing if there is one, and what the books show for
 * that period (worked out here, free) so a return filed on the portal can be checked against the books.
 */
export async function returnDetail(deps: GstDeps, id: string, returnType: string, period: string) {
  if (!FORMS[returnType as FormCode]) throw badRequest('Unknown return type');
  const month = fromRetPeriod(period);
  const gp = getProvider(deps.env);
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const c = await loadConn(ctx, id);
    const track = await ctx.tx.query<{ data: any; fetched_at: string }>(`select data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = 'return_track' order by fetched_at`, [ctx.tenantId, id]);
    const portal = portalRecords(track).get(`${returnType}|${period}`) ?? null;
    const f = await ctx.tx.one<FilingRow>(`select * from gst_filings where tenant_id = $1 and connection_id = $2 and return_type = $3 and period = $4`, [ctx.tenantId, id, returnType, period]);
    let books: Record<string, unknown> | null = null;
    if (returnType === 'GSTR1') {
      const b = await buildGstr1(ctx, c.gstin, month);
      books = { kind: 'GSTR1', counts: b.counts, totals: b.totals, warnings: b.warnings };
    } else if (returnType === 'GSTR3B') {
      const g = (await buildGstr3b(ctx, c.gstin, month)).working as any;
      books = {
        kind: 'GSTR3B',
        outward: g.outward,
        zeroRated: g.zeroRated,
        nilExempt: g.nilExempt,
        inwardReverseCharge: g.inwardReverseCharge,
        itc: g.itc?.total,
        liability: g.liability,
        payableInCash: g.payableInCash,
        creditCarriedForward: g.creditCarriedForward,
      };
    }
    const summaryView = returnType === 'GSTR1' ? 'gstr1_summary' : returnType === 'GSTR3B' ? 'gstr3b_summary' : null;
    const portalSummary =
      summaryView && (!gp || gp.views.includes(summaryView))
        ? await ctx.tx.one<{ data: any; fetched_at: string }>(`select data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = $3 and key = $4`, [ctx.tenantId, id, summaryView, period])
        : null;
    return {
      returnType,
      label: FORMS[returnType as FormCode]!.label,
      period,
      gstin: c.gstin,
      portal,
      filing: f ? filingDto(f, gp, true) : null,
      books,
      // the portal's own figures, only where the provider can fetch them (a paid call, so on request)
      portalSummaryView: summaryView && gp?.views.includes(summaryView) ? summaryView : null,
      portalSummary: portalSummary ? { data: portalSummary.data, fetchedAt: portalSummary.fetched_at } : null,
    };
  });
}

/** Fetches the portal's record of returns filed for each month of a financial year (for the calendar). */
export async function syncReturnTrack(deps: GstDeps, id: string, fyStart: number, refresh = true) {
  const gp = requireProvider(deps.env);
  if (gp.returnTrack) {
    // one public call for the whole year, no OTP needed
    const fy = `${fyStart}-${String(fyStart + 1).slice(2)}`;
    const { gstin, stored } = await deps.run(async (ctx) => {
      assertGstAdmin(ctx);
      const gstin = (await loadConn(ctx, id)).gstin;
      const stored = refresh
        ? null
        : await ctx.tx.one<{ fetched_at: string }>(`select fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = 'return_track' and key = $3`, [ctx.tenantId, id, `fy ${fy}`]);
      return { gstin, stored };
    });
    if (stored) return [{ period: fy, ok: true, cached: true, fetchedAt: stored.fetched_at }];
    const r = await gp.returnTrack(gstin, fy);
    await deps.run(async (ctx) => {
      await logEvent(ctx, { connectionId: id, action: 'view.return_track', ok: r.ok, message: r.ok ? `FY ${fy}` : r.message, provider: gp.id, data: r.ok ? r.data : r.raw });
      if (r.ok)
        await ctx.tx.query(
          `insert into gst_portal_cache (tenant_id, connection_id, kind, key, data) values ($1,$2,'return_track',$3,$4)
           on conflict (tenant_id, connection_id, kind, key) do update set data = excluded.data, fetched_at = now()`,
          [ctx.tenantId, id, `fy ${fy}`, JSON.stringify(r.data ?? null)],
        );
    });
    if (!r.ok) throw new GspError(r.message, r.code, r);
    return [{ period: fy, ok: true }];
  }
  const out: { period: string; ok: boolean; message?: string }[] = [];
  for (let k = 0; k < 12; k++) {
    const m = ((3 + k) % 12) + 1;
    const y = m >= 4 ? fyStart : fyStart + 1;
    const d = new Date(Date.UTC(y, m - 1, 1));
    if (d > new Date()) break;
    const period = `${String(m).padStart(2, '0')}${y}`;
    try {
      await fetchView(deps, id, 'return_track', { period }, refresh);
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

function filingDto(f: FilingRow, gp: GspProvider | null, withPayload = false) {
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
    needsProceed: !!gp?.proceed(f.return_type),
    canSend: !!gp?.forms.includes(f.return_type),
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
    return rows.map((r) => filingDto(r, getProvider(deps.env)));
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
    return { ...filingDto(f, getProvider(deps.env), true), events };
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

/** Prepares a return from SanchalanOS's records (GSTR-1, GSTR-3B, ITC-04) or from uploaded portal JSON. */
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
      throw badRequest(`${FORMS[input.returnType]!.label} is prepared outside SanchalanOS: upload the portal JSON, or start from the portal's own figures`);
    }
    const old = await ctx.tx.one<FilingRow>(`select * from gst_filings where tenant_id = $1 and connection_id = $2 and return_type = $3 and period = $4 for update`, [
      ctx.tenantId,
      connectionId,
      input.returnType,
      input.period,
    ]);
    if (old?.status === 'filed') throw conflict(`${FORMS[input.returnType]!.label} for ${input.period} has already been filed`);
    if (old && ['submitted', 'offset'].includes(old.status) && old.portal_status !== 'TEST') throw conflict('This return has already been submitted on the portal; its figures can no longer be changed');
    const row = old
      ? (await ctx.tx.one<FilingRow>(
          `update gst_filings set payload = $3, payload_source = $4, status = 'prepared', ref_id = null, portal_status = null, error_report = null, summary = null where tenant_id = $1 and id = $2 returning *`,
          [ctx.tenantId, old.id, JSON.stringify(payload), source],
        ))!
      : (await ctx.tx.one<FilingRow>(
          `insert into gst_filings (tenant_id, connection_id, return_type, period, payload, payload_source) values ($1,$2,$3,$4,$5,$6) returning *`,
          [ctx.tenantId, connectionId, input.returnType, input.period, JSON.stringify(payload), source],
        ))!;
    await logEvent(ctx, { connectionId, filingId: row.id, action: 'prepare', ok: true, message: source === 'upload' ? 'From uploaded JSON' : 'From SanchalanOS records' });
    return { ...filingDto(row, getProvider(deps.env), true), ...extra };
  });
}

/** Starts a return from the portal's own figures (GSTR-9 auto-calculation, GSTR-2X credits to accept). */
export async function prepareFromPortal(deps: GstDeps, connectionId: string, returnType: 'GSTR9' | 'GSTR2X', period: string) {
  fromRetPeriod(period);
  const kind = returnType === 'GSTR9' ? 'gstr9_autocalc' : 'gstr2x';
  if (!requireProvider(deps.env).views.includes(kind)) throw badRequest(`${FORMS[returnType].label} can't be started from the portal with this GST Suvidha Provider; upload its JSON instead`);
  const gstin = await deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    return (await loadConn(ctx, connectionId)).gstin;
  });
  let payload: Record<string, unknown>;
  if (returnType === 'GSTR9') {
    const r = await portalOp(deps, connectionId, { op: 'view', kind: 'gstr9_autocalc', q: { period } }, { action: 'view.gstr9_autocalc' });
    const d = r.data ?? {};
    payload = { ...d, gstin, fp: period };
  } else {
    const rows: any[] = [];
    for (const rectype of ['TDS', 'TCS'] as const) {
      const r = await portalOp(deps, connectionId, { op: 'view', kind: 'gstr2x', q: { period, recType: rectype } }, { action: 'view.gstr2x' }).catch((e: unknown) => {
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
    return filingDto(row, getProvider(deps.env), true);
  });
}

async function filingContext(deps: GstDeps, id: string, allowed: FilingRow['status'][]) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    const f = await loadFiling(ctx, id);
    if (!allowed.includes(f.status)) throw conflict(`Not possible while the return is ${f.status}`);
    const c = await loadConn(ctx, f.connection_id);
    return { f, c, form: FORMS[f.return_type]!, gp: requireProvider(deps.env) };
  });
}

async function updateFiling(deps: GstDeps, id: string, set: Record<string, unknown>) {
  return deps.run(async (ctx) => {
    const cols = Object.keys(set);
    const row = await ctx.tx.one<FilingRow>(
      `update gst_filings set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, ...cols.map((k) => (set[k] !== null && typeof set[k] === 'object' ? JSON.stringify(set[k]) : set[k]))],
    );
    return filingDto(row!, getProvider(deps.env), false);
  });
}

/** Saves the prepared data to the portal. GSTN processes it in the background: check its status next. */
export async function saveFiling(deps: GstDeps, id: string) {
  const { f, c, form, gp } = await filingContext(deps, id, ['prepared', 'error', 'saved']);
  if (!f.payload) throw badRequest('Prepare the return first');
  if (!gp.forms.includes(f.return_type)) throw badRequest(`${form.label} can't be sent through ${gp.label}. Download the JSON and upload it on the GST portal.`);
  const r = await portalOp(deps, c.id, { op: 'save', form: f.return_type, period: f.period, body: f.payload, pan: c.signatory_pan }, { action: 'save', filingId: id });
  const ref = pick(r, 'reference_id', 'ref_id', 'refid', 'referenceId', 'reference_no');
  // providers that save, proceed and summarise in one call (gstinapi.in) hand back the summary
  const summary = r.data && typeof r.data === 'object' && 'summary' in r.data ? r.data.summary : undefined;
  if (summary !== undefined && gp.steps && !gp.steps.status)
    return updateFiling(deps, id, {
      status: r.data.proceeded ? 'submitted' : 'saved',
      ref_id: ref ? String(ref) : null,
      // a test-mode run: nothing reached the portal, so it can be prepared again later
      portal_status: r.data.test ? 'TEST' : 'P',
      error_report: null,
      summary: summary ?? null,
    });
  return updateFiling(deps, id, ref ? { status: 'saving', ref_id: String(ref), portal_status: 'REC', error_report: null } : { status: 'saved', portal_status: 'P', error_report: null });
}

const STATUS_TEXT: Record<string, string> = { P: 'Processed', PE: 'Processed with errors', ER: 'Error', IP: 'In progress', REC: 'Received' };

/** Asks the portal how the last save (or proceed) went. */
export async function checkFiling(deps: GstDeps, id: string) {
  const { f, c, gp } = await filingContext(deps, id, ['saving', 'saved', 'error', 'submitted', 'offset']);
  if (gp.steps && !gp.steps.status) throw badRequest(`${gp.label} reports the outcome when you save; there is no separate status to check`);
  if (!f.ref_id) throw badRequest('Nothing is being processed on the portal for this return');
  const r = await portalOp(deps, c.id, { op: 'status', form: f.return_type, period: f.period, refId: f.ref_id }, { action: 'status', filingId: id });
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
  const { f, c, form, gp } = await filingContext(deps, id, ['saved', 'prepared']);
  const how = gp.proceed(f.return_type);
  if (!how) throw badRequest(`${form.label} does not need this step`);
  if (f.status === 'prepared' && !opts.nil) throw badRequest('Save the return to the portal first');
  const r = await portalOp(deps, c.id, { op: 'proceed', form: f.return_type, period: f.period, nil: !!opts.nil }, { action: how === 'submit' ? 'submit' : 'proceed', filingId: id });
  const ref = pick(r, 'reference_id', 'ref_id', 'refid', 'referenceId');
  return updateFiling(deps, id, ref ? { status: 'submitted', ref_id: String(ref), portal_status: 'PROCEED' } : { status: 'submitted', portal_status: 'P' });
}

/** Fetches the return summary from the portal; it is what gets filed. */
export async function summaryFiling(deps: GstDeps, id: string) {
  const { f, c, gp } = await filingContext(deps, id, ['saved', 'submitted', 'offset', 'error', 'filed']);
  if (gp.steps && !gp.steps.summary) throw badRequest(`With ${gp.label} the summary comes back when you save; save the return again to refresh it`);
  const r = await portalOp(deps, c.id, { op: 'summary', form: f.return_type, period: f.period }, { action: 'summary', filingId: id });
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
  const { f, c, gp } = await filingContext(deps, id, ['saved', 'submitted', 'error']);
  if (f.return_type !== 'GSTR3B') throw badRequest('Only GSTR-3B is offset');
  if (!f.summary) throw badRequest('Fetch the return summary first');
  let credit: { i: number; c: number; s: number; cs: number };
  let cashAvail: { i: number; c: number; s: number; cs: number } | null;
  if (gp.views.includes('ledger_balance')) {
    const bal = await portalOp(deps, c.id, { op: 'view', kind: 'ledger_balance', q: { period: f.period } }, { action: 'view.ledger_balance', quiet: true });
    const itcBal = bal.data?.itc_bal ?? {};
    credit = { i: n(itcBal.igst_bal), c: n(itcBal.cgst_bal), s: n(itcBal.sgst_bal), cs: n(itcBal.cess_bal) };
    const cashBal = bal.data?.cash_bal ?? {};
    cashAvail = { i: n(cashBal.igst_tot_bal ?? cashBal.igst?.tot), c: n(cashBal.cgst_tot_bal ?? cashBal.cgst?.tot), s: n(cashBal.sgst_tot_bal ?? cashBal.sgst?.tot), cs: n(cashBal.cess_tot_bal ?? cashBal.cess?.tot) };
  } else {
    // no ledger API: use this return's net ITC (the credit ledger may hold more — check it on gst.gov.in)
    const net = f.summary?.itc_elg?.itc_net ?? f.payload?.itc_elg?.itc_net ?? {};
    credit = { i: n(net.iamt), c: n(net.camt), s: n(net.samt), cs: n(net.csamt) };
    cashAvail = null;
  }
  const rows: any[] = f.summary?.tx_pmt?.tx_py ?? f.summary?.tx_pmt?.txpy ?? [];
  if (!rows.length) throw badRequest('The summary has no tax payable (tx_pmt) with the ledger ids the portal needs; save GSTR-3B again, or offset on gst.gov.in');
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
  const shortfall = cashAvail
    ? { igst: rr(Math.max(0, cashNeed.i - cashAvail.i)), cgst: rr(Math.max(0, cashNeed.c - cashAvail.c)), sgst: rr(Math.max(0, cashNeed.s - cashAvail.s)), cess: rr(Math.max(0, cashNeed.cs - cashAvail.cs)) }
    : null;
  return {
    offset: { pdcash, ...(pditc ? { pditc } : {}) },
    cashNeeded: { igst: cashNeed.i, cgst: cashNeed.c, sgst: cashNeed.s, cess: cashNeed.cs },
    cashAvailable: cashAvail ? { igst: cashAvail.i, cgst: cashAvail.c, sgst: cashAvail.s, cess: cashAvail.cs } : null,
    shortfall,
    note: cashAvail ? null : "ITC here is this return's own credit; your credit ledger may hold more. Check the cash ledger on gst.gov.in covers what is paid in cash.",
  };
}

/** Sends the reviewed offset (GSTR-3B): pays the liability from the ledgers. */
export async function offsetFiling(deps: GstDeps, id: string, body: { pdcash: unknown[]; pditc?: unknown }) {
  const { f, c } = await filingContext(deps, id, ['saved', 'submitted', 'error']);
  if (f.return_type !== 'GSTR3B') throw badRequest('Only GSTR-3B is offset');
  if (!Array.isArray(body.pdcash)) throw badRequest('pdcash is required');
  const r = await portalOp(deps, c.id, { op: 'offset', period: f.period, body }, { action: 'offset', filingId: id });
  // a fresh summary (and checksum) after paying, when the provider returns one
  let summary = r.data && typeof r.data === 'object' && r.data.summary ? r.data.summary : null;
  // only a fresh checksum came back: keep the reviewed summary with the new checksum
  if (!summary && r.data?.chksum && f.summary && typeof f.summary === 'object') summary = { ...f.summary, chksum: r.data.chksum };
  return updateFiling(deps, id, { status: 'offset', ...(summary ? { summary } : {}), ...(r.data?.test ? { portal_status: 'TEST' } : {}) });
}

/* filing */

export async function requestEvcOtp(deps: GstDeps, id: string, pan?: string | null) {
  const { f, c } = await filingContext(deps, id, ['saved', 'submitted', 'offset']);
  const p = (pan ?? c.signatory_pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p)) throw badRequest("Enter the authorised signatory's PAN");
  await portalOp(deps, c.id, { op: 'evcOtp', form: f.return_type, pan: p }, { action: 'evc.otp', filingId: f.id });
  return { ok: true };
}

/**
 * Files the return with the summary as fetched. EVC needs the OTP sent to the signatory; DSC needs
 * the signatory's DSC registered on the GST portal (and the provider's signer; not every provider has DSC).
 */
export async function fileFiling(deps: GstDeps, id: string, input: { mode: 'evc' | 'dsc'; pan?: string | null; otp?: string | null }) {
  const { f, c, form, gp } = await filingContext(deps, id, ['saved', 'submitted', 'offset']);
  if (!f.summary) throw badRequest('Fetch and check the return summary first');
  if (input.mode === 'dsc' && !gp.dsc) throw badRequest(`${gp.label} files with EVC only`);
  if (gp.proceed(f.return_type) && f.status === 'saved') throw badRequest('Proceed to file first, then fetch the summary again');
  if (form.offset && f.status !== 'offset') throw badRequest('Offset the liability first');
  const pan = (input.pan ?? c.signatory_pan ?? '').trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw badRequest("Enter the authorised signatory's PAN");
  if (input.mode === 'evc' && !/^\d{6}$/.test(input.otp ?? '')) throw badRequest('Enter the 6-digit EVC OTP');
  const r = await portalOp(deps, c.id, { op: 'file', form: f.return_type, period: f.period, mode: input.mode, pan, otp: input.otp ?? null, summary: f.summary }, { action: `file.${input.mode}`, filingId: id });
  if (r.data?.test) {
    // test mode: the call went through, but nothing was filed — keep the return open
    const dto = await updateFiling(deps, id, { portal_status: 'TEST' });
    return { ...dto, testMode: true, note: `Test mode: nothing was filed (${r.data.note ?? 'synthetic answer'}). Remove GSTINAPI_TEST_MODE and restart to file for real.` };
  }
  const arn = pick(r, 'ack_num', 'arn', 'ackNum', 'ack_no', 'ARN');
  return deps.run(async (ctx) => {
    const row = (await ctx.tx.one<FilingRow>(
      `update gst_filings set status = 'filed', arn = $3, filed_at = now(), filed_by = app.current_user_id(), filing_mode = $4 where tenant_id = $1 and id = $2 returning *`,
      [ctx.tenantId, id, arn ? String(arn).slice(0, 40) : null, input.mode],
    ))!;
    await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'gst_file', $2, $3)`, [ctx.tenantId, 'gst_filing', JSON.stringify({ gstin: c.gstin, form: f.return_type, period: f.period, arn, mode: input.mode })]);
    if (pan !== c.signatory_pan) await ctx.tx.query(`update gst_connections set signatory_pan = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, c.id, pan]);
    return filingDto(row, getProvider(deps.env));
  });
}

/** Resets saved GSTR-1 data on the portal (before it is filed). */
export async function resetFiling(deps: GstDeps, id: string) {
  const { f, c, form } = await filingContext(deps, id, ['saved', 'error', 'saving']);
  if (!['GSTR1', 'GSTR1A'].includes(f.return_type)) throw badRequest(`${form.label} cannot be reset this way`);
  await portalOp(deps, c.id, { op: 'reset', form: f.return_type, period: f.period }, { action: 'reset', filingId: id });
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
export async function importGstr2bFromPortal(deps: GstDeps, connectionId: string, period: string, refresh = false) {
  fromRetPeriod(period);
  const first = await fetchView(deps, connectionId, 'gstr2b', { period }, refresh);
  const rows = gstr2bRows(first.data);
  const fc = n(first.data?.data?.fc ?? first.data?.fc);
  for (let k = 2; k <= Math.min(fc, 50); k++) {
    const r = await fetchView(deps, connectionId, 'gstr2b', { period, fileNo: String(k) }, refresh);
    rows.push(...gstr2bRows(r.data));
  }
  return deps.run(async (ctx) => ({ ...(await importGstr2b(ctx, period, rows)), fetched: rows.length, cached: first.cached, fetchedAt: first.fetchedAt }));
}

/**
 * Every GSTR-2B month already kept for this connection (no provider call): when it was fetched, how many
 * files, and the latest match against bills. Lets the screen show what a range will cost before fetching.
 */
export async function gstr2bSaved(deps: GstDeps, connectionId: string) {
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    await loadConn(ctx, connectionId);
    const cache = await ctx.tx.query<{ key: string; fetched_at: string }>(
      `select key, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = 'gstr2b' order by key`,
      [ctx.tenantId, connectionId],
    );
    const imports = await ctx.tx.query<{ period: string; created_at: string; lines: number; matched: number; mismatch: number }>(
      `select i.period, i.created_at, i.lines,
              count(*) filter (where l.match_status = 'matched')::int as matched,
              count(*) filter (where l.match_status = 'mismatch')::int as mismatch
         from gstr2b_imports i left join gstr2b_lines l on l.tenant_id = i.tenant_id and l.import_id = i.id
        where i.tenant_id = $1 group by i.id`,
      [ctx.tenantId],
    );
    const months = new Map<string, { period: string; fetchedAt: string; files: number }>();
    for (const r of cache) {
      const period = r.key.split('|')[0]!;
      if (!/^\d{6}$/.test(period)) continue;
      const m = months.get(period);
      if (!m) months.set(period, { period, fetchedAt: r.fetched_at, files: 1 });
      else {
        m.files++;
        if (r.fetched_at > m.fetchedAt) m.fetchedAt = r.fetched_at;
      }
    }
    const sortKey = (p: string) => p.slice(2) + p.slice(0, 2);
    return [...months.values()]
      .sort((a, b) => sortKey(b.period).localeCompare(sortKey(a.period)))
      .map((m) => {
        const i = imports.find((x) => x.period === m.period);
        return { ...m, match: i ? { at: i.created_at, lines: i.lines, matched: i.matched, mismatch: i.mismatch, unmatched: i.lines - i.matched - i.mismatch } : null };
      });
  });
}

/**
 * One GSTR-2B month in full, from our database (no provider call): every supplier document with its match
 * against bills, the bills the suppliers have not reported, and what else the kept GSTR-2B holds (sections
 * and the ITC summary). `raw` adds the kept portal answer itself, for download.
 */
export async function gstr2bDetail(deps: GstDeps, connectionId: string, period: string, raw = false) {
  fromRetPeriod(period);
  return deps.run(async (ctx) => {
    assertGstAdmin(ctx);
    await loadConn(ctx, connectionId);
    const files = await ctx.tx.query<{ key: string; data: any; fetched_at: string }>(
      `select key, data, fetched_at from gst_portal_cache where tenant_id = $1 and connection_id = $2 and kind = 'gstr2b' and (key = $3 or key like $4) order by key`,
      [ctx.tenantId, connectionId, period, `${period}|%`],
    );
    const report = await gstr2bReport(ctx, period);
    const sections: Record<string, number> = {};
    let itcSummary: unknown = null;
    let generatedOn: string | null = null;
    for (const f of files) {
      const d = f.data?.data ?? f.data ?? {};
      generatedOn ??= d.gendt ?? null;
      itcSummary ??= d.itcsumm ?? null;
      for (const [k, v] of Object.entries(d.docdata ?? {})) {
        if (!Array.isArray(v)) continue;
        const docs = v.reduce((n: number, x: any) => n + (Array.isArray(x?.inv) ? x.inv.length : Array.isArray(x?.nt) ? x.nt.length : Array.isArray(x?.doclist) ? x.doclist.length : 1), 0);
        sections[k] = (sections[k] ?? 0) + docs;
      }
    }
    return {
      period,
      fetchedAt: files.reduce<string | null>((a, f) => (!a || f.fetched_at > a ? f.fetched_at : a), null),
      files: files.length,
      generatedOn,
      sections,
      itcSummary,
      importedAt: report?.importedAt ?? null,
      lines: report?.lines ?? [],
      missingInGstr2b: report?.missingInGstr2b ?? [],
      ...(raw ? { raw: files.map((f) => f.data) } : {}),
    };
  });
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
  const gp = requireProvider(deps.env);
  if (!gp.challan) throw badRequest(`Create the challan on the GST portal (Services → Payments → Create Challan); ${gp.label} doesn't offer it`);
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
  const r = await portalOp(deps, connectionId, { op: 'challan', period: input.period, body }, { action: 'challan.create' });
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
