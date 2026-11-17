/**
 * gstinapi.in as the GST provider (https://www.gstinapi.in/docs).
 *
 * One API key (x-api-key). The GST Suvidha Provider behind it handles GSTN's encryption and keeps
 * the portal session: a GSTIN is connected once with the portal OTP and the session is refreshed
 * on their side for the API-access duration chosen on gst.gov.in (6 hours to 30 days).
 *
 *  - GSTR-1: save (saves, proceeds to file, returns the summary and sends the EVC OTP), file.
 *  - GSTR-3B: save (summary, checksum, system liability), offset, EVC OTP, file (by checksum).
 *  - GSTR-2B fetch; public return-filing history; taxpayer search.
 *  - E-invoice (IRN, cancel, details, by document) and e-way bill (generate, from IRN, cancel,
 *    vehicle update) with the IRP / EWB API users passed per call (not stored by them).
 *
 * Saving, OTPs and the offset are free; a filing costs 1 credit when it succeeds. With
 * GSTINAPI_TEST_MODE=true every call that allows it gets test_mode: synthetic answers in the live
 * shape, nothing reaches the GST network, nothing is charged (connecting still sends a real OTP).
 */
import type { Env } from '../../env';
import { ApiError } from '../../lib/errors';
import type { EwbOp, GspConn, GspProvider, GspResult, GstOp, IrpOp, NicStep, Secrets, Session } from './provider';

export const GSTINAPI_BASE = 'https://www.gstinapi.in';

interface GiConfig {
  base: string;
  key: string;
  test: boolean;
}

export function giConfig(env: Env): GiConfig | null {
  const key = env.GSTINAPI_KEY?.trim();
  if (!key) return null;
  let base = (env.GSTINAPI_BASE_URL?.trim() || GSTINAPI_BASE).replace(/\/+$/, '');
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) base = GSTINAPI_BASE;
  return { base, key, test: /^(1|true|yes)$/i.test(env.GSTINAPI_TEST_MODE ?? '') };
}

const ok = (data: any, raw: unknown): GspResult => ({ ok: true, httpStatus: 200, data, header: null, raw, message: 'OK', code: null });
const bad = (message: string, code: string | null, raw: unknown, httpStatus = 400): GspResult => ({ ok: false, httpStatus, data: null, header: null, raw, message, code });

async function send(cfg: GiConfig, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, unknown>, query?: Record<string, string | undefined>): Promise<GspResult> {
  if (!/^\/v1\/[A-Za-z0-9_./{}-]+$/.test(path) || path.includes('..')) throw new Error('bad GSP path');
  const url = new URL(cfg.base + path);
  for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers: { accept: 'application/json', 'x-api-key': cfg.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new ApiError(504, 'gsp_unreachable', timeout ? 'The GST network did not answer in time. Try again in a minute (retrying a save or an IRN is safe).' : 'Could not reach gstinapi.in');
  }
  const text = await res.text();
  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }
  // 401 is also the answer to a wrong or expired OTP (RET13509)
  if (res.status === 401 && !/otp|RET13509/i.test(String(j?.error ?? j?.message ?? '') + String(j?.code ?? '')))
    throw new ApiError(502, 'gsp_error', 'gstinapi.in refused the API key (GSTINAPI_KEY). Check it in your gstinapi.in dashboard.');
  if (res.status === 402) throw new ApiError(402, 'gsp_credits', 'Your gstinapi.in credits are used up. Buy a credit pack in the gstinapi.in dashboard.');
  if (res.status === 429) throw new ApiError(429, 'rate_limited', 'Too many calls to gstinapi.in this minute; wait a moment and try again.');
  if (res.ok && j && j.success !== false) return ok(j, j);
  const msg = String(j?.error ?? j?.message ?? `gstinapi.in answered HTTP ${res.status}`);
  const fix = j?.fix ? ` ${j.fix}` : '';
  const code = j?.code ?? j?.error_code ?? (/\b(RET\d{5}|AUTH\d{4}|RT-[A-Z0-9-]+)\b/.exec(msg)?.[1] ?? null);
  if (res.status === 502 || res.status === 504) return bad(`The GST network is not answering right now (${msg}). Try again in a few minutes.`, code, j, res.status);
  if (res.status === 503) return bad(`${msg}${fix}`.trim() || 'Live filing is not switched on for your gstinapi.in account yet.', code ?? 'NOT_ENABLED', j, 503);
  return bad(`${msg}${fix}`, code ? String(code) : null, j, res.status);
}

const dmyToIso = (s: unknown) => {
  const m = /^(\d{2})[/-](\d{2})[/-](\d{4})(.*)$/.exec(String(s ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4] ?? ''}` : (s as string | null) ?? null;
};
const ymToPeriod = (s: unknown) => {
  const m = /^(\d{4})-(\d{2})$/.exec(String(s ?? ''));
  return m ? `${m[2]}${m[1]}` : String(s ?? '');
};

export function gstinapiProvider(env: Env): GspProvider | null {
  const cfg = giConfig(env);
  if (!cfg) return null;
  const t = cfg.test ? { test_mode: true } : {};

  /** the connection's status on gstinapi.in's side */
  async function connection(gstin: string): Promise<{ r: GspResult; conn: any }> {
    const r = await send(cfg!, 'GET', '/v1/gst/filing/connections');
    const list: any[] = r.data?.connections ?? [];
    return { r, conn: list.find((x) => String(x.gstin).toUpperCase() === gstin) ?? null };
  }
  const minutesTo = (iso: unknown) => {
    const t = Date.parse(String(iso ?? ''));
    return Number.isFinite(t) ? Math.max(1, Math.round((t - Date.now()) / 60_000)) : 360;
  };
  const summaryOf = (d: any) => {
    const s = d?.summary ?? null;
    if (!s) return null;
    return typeof s === 'object' && d?.chksum && !s.chksum ? { ...s, chksum: d.chksum } : s;
  };

  const p: GspProvider = {
    id: 'gstinapi',
    label: 'gstinapi.in',
    sandbox: cfg.test,
    nicSandbox: cfg.test,
    views: ['gstr2b'],
    forms: ['GSTR1', 'GSTR3B'],
    proceed: () => null,
    steps: { status: false, summary: false, gstr1OtpOnSave: true },
    challan: false,
    dsc: false,
    hint: (m) => m,
    sessionGone: (r) => r.httpStatus === 409 && /not connected|session|expired|connect/i.test(r.message),

    async requestOtp(c, s) {
      const r = await send(cfg, 'POST', '/v1/gst/filing/connections', { gstin: c.gstin, gst_username: c.gstUsername });
      if (!r.ok && r.httpStatus === 403)
        r.message = `${r.message} — on gst.gov.in: My Profile → Manage API Access → Yes, with a duration, and select the GSP-ASP combination gstinapi.in lists at gstinapi.in/gst-portal-api-access.`;
      return { result: r, session: s };
    },
    async verifyOtp(c, s, otp) {
      const r = await send(cfg, 'POST', `/v1/gst/filing/connections/${c.gstin}/verify`, { otp });
      return { result: r, session: s, minutes: r.ok ? minutesTo(r.data?.connection?.expires_at) : undefined };
    },
    async refresh(c, s) {
      // gstinapi.in refreshes the session itself; read how long it now lasts
      const { r, conn } = await connection(c.gstin);
      if (!r.ok) return { result: r, session: s };
      if (!conn || conn.status !== 'active') return { result: bad('The GST portal session has ended; connect again with a new OTP', 'EXPIRED', conn, 409), session: s };
      return { result: r, session: s, minutes: minutesTo(conn.expires_at) };
    },
    async logout(c) {
      await send(cfg, 'DELETE', `/v1/gst/filing/connections/${c.gstin}`).catch(() => null);
    },

    async call(c, _s, _ip, op: GstOp) {
      const g = { gstin: c.gstin };
      switch (op.op) {
        case 'view': {
          if (op.kind !== 'gstr2b') throw new ApiError(400, 'bad_request', 'This view is not available with gstinapi.in');
          const r = await send(cfg, 'POST', '/v1/gstr2b/fetch', { ...g, ret_period: op.q.period, ...(op.q.fileNo ? { file_num: op.q.fileNo } : {}), ...t });
          return r.ok ? ok(r.data?.data ?? r.data, r.raw) : r;
        }
        case 'save': {
          if (op.form === 'GSTR1') {
            if (!op.pan) throw new ApiError(400, 'bad_request', "Enter the authorised signatory's PAN under Registration first: saving GSTR-1 sends the filing OTP to them");
            const r = await send(cfg, 'POST', '/v1/gstr1/save', { ...g, ret_period: op.period, pan: op.pan, payload: op.body, ...t });
            return r.ok ? ok({ reference_id: r.data?.ref_id ?? null, summary: summaryOf(r.data), proceeded: true, otpSent: !!r.data?.awaiting_evc_otp }, r.raw) : r;
          }
          if (op.form === 'GSTR3B') {
            const r = await send(cfg, 'POST', '/v1/gstr3b/save', { ...g, ret_period: op.period, payload: op.body, ...t });
            return r.ok ? ok({ summary: summaryOf(r.data), autoLiability: r.data?.auto_liability ?? null, interest: r.data?.system_interest ?? null }, r.raw) : r;
          }
          throw new ApiError(400, 'bad_request', `${op.form} can't be sent through gstinapi.in; download the JSON and upload it on the GST portal`);
        }
        case 'offset': {
          const r = await send(cfg, 'POST', '/v1/gstr3b/offset', { ...g, ret_period: op.period, payload: op.body, ...t });
          return r.ok ? ok({ summary: summaryOf(r.data), offset: r.data?.offset ?? null }, r.raw) : r;
        }
        case 'evcOtp': {
          if (op.form === 'GSTR1') throw new ApiError(400, 'bad_request', 'For GSTR-1 the OTP is sent when you save it. Save it again to get a new OTP.');
          return send(cfg, 'POST', '/v1/gstr3b/evc-otp', { ...g, pan: op.pan, ...t });
        }
        case 'file': {
          if (op.mode !== 'evc') throw new ApiError(400, 'bad_request', 'gstinapi.in files with EVC (OTP) only');
          const body =
            op.form === 'GSTR1'
              ? { ...g, ret_period: op.period, pan: op.pan, evc_otp: op.otp, summary: op.summary, ...t }
              : { ...g, ret_period: op.period, pan: op.pan, evc_otp: op.otp, chksum: (op.summary as any)?.chksum, ...t };
          if (op.form === 'GSTR3B' && !(body as any).chksum) throw new ApiError(400, 'bad_request', 'The reviewed checksum is missing; save GSTR-3B again');
          const r = await send(cfg, 'POST', op.form === 'GSTR1' ? '/v1/gstr1/file' : '/v1/gstr3b/file', body);
          if (!r.ok) return r;
          const up = r.data?.upstream ?? {};
          return ok({ ack_num: up.ack_num ?? up.arn ?? r.data?.arn ?? r.data?.ref_id ?? null, filed: r.data?.filed, credits: r.data?.credits_remaining }, r.raw);
        }
        case 'status':
        case 'summary':
        case 'proceed':
        case 'reset':
        case 'challan':
          throw new ApiError(400, 'bad_request', `gstinapi.in doesn't offer this step (${op.op})`);
      }
    },

    async search(gstin) {
      const r = await send(cfg, 'GET', `/v1/gstin/${gstin}`, undefined, { include: 'profile' });
      if (!r.ok) return r;
      const d = r.data?.data ?? {};
      const a = d.address_details ?? {};
      // in the GST portal's own shape, as the app reads it
      return ok(
        {
          gstin: d.gstin,
          lgnm: d.legal_name,
          tradeNam: d.trade_name,
          sts: d.status,
          dty: d.taxpayer_type,
          rgdt: d.registration_date,
          cxdt: d.cancellation_date ?? null,
          einvoiceStatus: d.einvoice_status ?? null,
          pradr: { addr: { bnm: d.address, loc: d.city, dst: a.district ?? d.district, stcd: d.state ?? a.state ?? d.state_code, pncd: d.pincode ?? a.pincode } },
        },
        r.raw,
      );
    },
    async returnTrack(gstin, fy) {
      const r = await send(cfg, 'GET', `/v1/gstin/${gstin}/returns`, undefined, { fy });
      if (!r.ok) return r;
      const list: any[] = r.data?.returns ?? [];
      return ok(
        {
          EFiledlist: list.map((x) => ({
            rtntype: ((t: string) => (/^R\d/.test(t) ? `GST${t}` : t))(String(x.return_type ?? '').replace(/[-\s]/g, '').toUpperCase()),
            ret_prd: ymToPeriod(x.return_period),
            arn: x.arn ?? null,
            dof: x.filing_date ?? null,
            status: x.filing_status ?? 'Filed',
          })),
        },
        r.raw,
      );
    },

    async irp(c, secrets, _s, _ip, op: IrpOp): Promise<NicStep> {
      if (!cfg.test && (!c.einvUsername || !secrets.einvPassword)) throw new ApiError(400, 'bad_request', 'Add the e-invoice API username and password on the GST registration first');
      const cred = { gstin: c.gstin, einv_username: c.einvUsername ?? 'test', password: secrets.einvPassword ?? 'test', ...t };
      const irpShape = (d: any) => ({
        Irn: d.irn,
        AckNo: d.ack_no,
        AckDt: d.ack_date,
        SignedQRCode: d.qr_code_image ?? d.signed_qr_code ?? null,
        SignedInvoice: d.signed_invoice ?? null,
        EwbNo: d.ewaybill_no ?? null,
        EwbDt: d.ewaybill_date ?? null,
        EwbValidTill: d.ewaybill_valid_upto ?? null,
        Status: d.status_code ?? null,
      });
      switch (op.op) {
        case 'generate': {
          const r = await send(cfg, 'POST', '/v1/einvoice', { ...cred, payload: op.body, txn_type: op.body?.DocDtls?.Typ === 'CRN' ? 'CDN' : op.body?.DocDtls?.Typ === 'DBN' ? 'DBN' : 'INV' });
          return { result: r.ok ? ok(irpShape(r.data), r.raw) : r };
        }
        case 'byIrn': {
          const r = await send(cfg, 'POST', '/v1/einvoice/details', { ...cred, irn: op.irn });
          return { result: r.ok ? ok(irpShape(r.data), r.raw) : r };
        }
        case 'byDoc': {
          const r = await send(cfg, 'POST', '/v1/einvoice/by-document', { ...cred, doc_type: op.docType, doc_no: op.docNo, doc_date: op.docDate });
          return { result: r.ok ? ok(irpShape(r.data), r.raw) : r };
        }
        case 'cancel': {
          const r = await send(cfg, 'POST', '/v1/einvoice/cancel', { ...cred, irn: op.body.Irn, cancel_reason: op.body.CnlRsn, cancel_remark: op.body.CnlRem });
          return { result: r };
        }
        case 'ewb': {
          const b = op.body ?? {};
          const r = await send(cfg, 'POST', '/v1/ewaybill/from-irn', {
            ...cred,
            irn: b.Irn,
            distance: Number(b.Distance ?? 0),
            ...(b.TransMode ? { trans_mode: String(b.TransMode) } : {}),
            ...(b.VehNo ? { vehicle_no: b.VehNo, vehicle_type: b.VehType ?? 'R' } : {}),
            ...(b.TransId ? { trans_id: b.TransId } : {}),
            ...(b.TransName ? { trans_name: b.TransName } : {}),
            ...(b.TransDocNo ? { trans_doc_no: b.TransDocNo } : {}),
            ...(b.TransDocDt ? { trans_doc_date: b.TransDocDt } : {}),
          });
          return { result: r.ok ? ok({ EwbNo: r.data?.ewaybill_no, EwbDt: r.data?.ewaybill_date, EwbValidTill: r.data?.ewaybill_valid_upto }, r.raw) : r };
        }
      }
    },

    async ewb(c, secrets, _s, _ip, op: EwbOp): Promise<NicStep> {
      if (!cfg.test && (!c.ewbUsername || !secrets.ewbPassword)) throw new ApiError(400, 'bad_request', 'Add the e-way bill API username and password on the GST registration first');
      const cred = { gstin: c.gstin, gstin_username: c.ewbUsername ?? 'test', password: secrets.ewbPassword ?? 'test', ...t };
      const b = op.body ?? {};
      if (op.op === 'generate') {
        const r = await send(cfg, 'POST', '/v1/ewaybill', { ...cred, payload: b });
        return { result: r.ok ? ok({ ewayBillNo: r.data?.ewaybill_no, ewayBillDate: dmyToIso(r.data?.ewaybill_date), validUpto: dmyToIso(r.data?.valid_upto) }, r.raw) : r, ewbReady: r.ok };
      }
      if (op.op === 'cancel') {
        const r = await send(cfg, 'POST', '/v1/ewaybill/cancel', { ...cred, ewaybill_no: String(b.ewbNo), ...(b.cancelRsnCode ? { cancel_reason_code: String(b.cancelRsnCode) } : {}), ...(b.cancelRmrk ? { cancel_remark: b.cancelRmrk } : {}) });
        return { result: r };
      }
      const r = await send(cfg, 'POST', '/v1/ewaybill/update-vehicle', {
        ...cred,
        ewaybill_no: String(b.ewbNo),
        ...(b.vehicleNo ? { vehicle_no: b.vehicleNo } : {}),
        from_place: b.fromPlace,
        from_state: Number(b.fromState),
        reason_code: String(b.reasonCode),
        ...(b.reasonRem ? { reason_remark: b.reasonRem } : {}),
        ...(b.transMode ? { trans_mode: String(b.transMode) } : {}),
        ...(b.transDocNo ? { trans_doc_no: b.transDocNo } : {}),
        ...(b.transDocDate ? { trans_doc_date: b.transDocDate } : {}),
      });
      return { result: r.ok ? ok({ validUpto: dmyToIso(r.data?.valid_upto) }, r.raw) : r };
    },
  };
  return p;
}

export type { Secrets, Session, GspConn };
