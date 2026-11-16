/**
 * GST Suvidha Providers behind one interface. The app works in GST terms (save a return, check
 * its status, offset, file with EVC, fetch the cash ledger, generate an IRN); each provider turns
 * that into its own API calls:
 *
 *  - indiacompliance: India Compliance (Resilient Tech) — GSTN's standard API passed through, so
 *    the app does GSTN's encryption itself; e-invoice and e-way bill with the GSP doing it.
 *    Pay per call. Returns always go to the live GST portal (there is no returns sandbox).
 *  - whitebooks: WhiteBooks — a GSP that encrypts for us; has a sandbox.
 *
 * GST_PROVIDER picks one; otherwise whichever has keys (India Compliance first).
 */
import type { Env } from '../../env';
import { ApiError } from '../../lib/errors';
import { indiaComplianceProvider } from './indiacompliance';
import { whitebooksProvider, type WbResult } from './whitebooks';

export type GspResult = WbResult;

/** The encrypted per-connection session (stored sealed in gst_connections.session_ciphertext). */
export interface Session {
  /** WhiteBooks: the GST API transaction id */
  txn?: string;
  /** WhiteBooks: the IRP token */
  einvToken?: string;
  einvTokenExp?: string;
  /** WhiteBooks: when the e-way bill login was last renewed */
  ewbAt?: string;
  /** India Compliance: the GSTN session */
  ic?: { appKey: string; sek?: string; authToken?: string; ip?: string };
}
export interface Secrets {
  einvPassword?: string;
  ewbPassword?: string;
}
export interface GspConn {
  id: string;
  gstin: string;
  gstUsername: string | null;
  einvUsername: string | null;
  ewbUsername: string | null;
}

/** Return types the providers know (portal form codes, as in gst_filings.return_type). */
export type Form = 'GSTR1' | 'GSTR1A' | 'GSTR3B' | 'GSTR7' | 'GSTR2X' | 'ITC04' | 'GSTR9' | 'GSTR9C' | 'GSTR6' | 'GSTR8' | 'CMP08';

export type GstOp =
  | { op: 'view'; kind: string; q: Record<string, string> }
  | { op: 'save'; form: Form; period: string; body: unknown }
  | { op: 'status'; form: Form; period: string; refId: string }
  | { op: 'proceed'; form: Form; period: string; nil: boolean }
  | { op: 'summary'; form: Form; period: string }
  | { op: 'offset'; period: string; body: unknown }
  | { op: 'evcOtp'; form: Form; pan: string }
  | { op: 'file'; form: Form; period: string; mode: 'evc' | 'dsc'; pan: string; otp?: string | null; summary: unknown }
  | { op: 'reset'; form: Form; period: string }
  | { op: 'challan'; period: string; body: unknown };

export type IrpOp =
  | { op: 'generate'; body: any }
  | { op: 'byDoc'; docType: 'INV' | 'CRN' | 'DBN'; docNo: string; docDate: string }
  | { op: 'byIrn'; irn: string }
  | { op: 'cancel'; body: { Irn: string; CnlRsn: string; CnlRem: string } }
  | { op: 'ewb'; body: any };
export type EwbOp = { op: 'generate'; body: any } | { op: 'cancel'; body: any } | { op: 'vehicle'; body: any };

export interface SessionStep {
  result: GspResult;
  session: Session;
  /** session length in minutes, when a session was (re)started */
  minutes?: number;
}
export interface NicStep {
  result: GspResult;
  /** set when the provider changed the session (a new IRP token, an e-way bill login) */
  session?: Session;
  einvTokenExpires?: Date;
  ewbReady?: boolean;
}

export interface GspProvider {
  id: 'whitebooks' | 'indiacompliance';
  label: string;
  /** returns go to a test system */
  sandbox: boolean;
  /** e-invoice and e-way bill go to a test system */
  nicSandbox: boolean;
  /** dashboard views it can fetch */
  views: readonly string[];
  /** return types it can save and file */
  forms: readonly Form[];
  /** the step between saving and filing, if any */
  proceed(form: Form): 'r1' | 'r1a' | 'submit' | null;
  challan: boolean;
  dsc: boolean;
  /** advice to add to an error from the GSP */
  hint(message: string): string;

  requestOtp(c: GspConn, s: Session, ip: string): Promise<SessionStep>;
  verifyOtp(c: GspConn, s: Session, otp: string, ip: string): Promise<SessionStep>;
  refresh(c: GspConn, s: Session, ip: string): Promise<SessionStep>;
  logout(c: GspConn, s: Session, ip: string): Promise<void>;
  /** one call in a live session */
  call(c: GspConn, s: Session, ip: string, op: GstOp): Promise<GspResult>;
  /** an error that means the portal session is gone */
  sessionGone(r: GspResult): boolean;

  /** public taxpayer search (no OTP) */
  search(gstin: string): Promise<GspResult>;
  /** public return track for a financial year like 2026-27 (no OTP), when the provider has it */
  returnTrack?(gstin: string, fy: string): Promise<GspResult>;

  irp(c: GspConn, secrets: Secrets, s: Session, ip: string, op: IrpOp): Promise<NicStep>;
  ewb(c: GspConn, secrets: Secrets, s: Session, ip: string, op: EwbOp): Promise<NicStep>;
}

export function getProvider(env: Env): GspProvider | null {
  const want = (env.GST_PROVIDER ?? '').trim().toLowerCase();
  const ic = indiaComplianceProvider(env);
  const wb = whitebooksProvider(env);
  if (want === 'indiacompliance' || want === 'india_compliance') return ic;
  if (want === 'whitebooks') return wb;
  return ic ?? wb;
}

export function requireProvider(env: Env): GspProvider {
  const p = getProvider(env);
  if (!p)
    throw new ApiError(
      503,
      'gsp_not_configured',
      'No GST Suvidha Provider is set up on this server. Add INDIA_COMPLIANCE_API_SECRET (or the WHITEBOOKS_* keys) to .env and restart.',
    );
  return p;
}
