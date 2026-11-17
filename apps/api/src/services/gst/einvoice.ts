/**
 * E-invoice (IRN from the Invoice Registration Portal) and e-way bills, through the GST Suvidha
 * Provider (see provider.ts).
 *
 * The IRP and the e-way bill system have their own API users (created on einvoice1.gst.gov.in /
 * ewaybillgst.gov.in → API registration → "through GSP" → the provider's GSP). Their usernames
 * and passwords are stored on the GST registration (encrypted). Any token the provider needs is
 * kept in the encrypted session.
 */
import { stateCode } from "@synapse/shared";
import { ApiError, badRequest, conflict, notFound } from "../../lib/errors";
import { invoiceLines } from "../billing";
import { eInvoiceJson } from "../gst-exports";
import { letterhead } from "../quotes";
import type { RecordCtx } from "../records";
import { uqc } from "./returns";
import {
  assertGstAdmin,
  gspConn,
  logEvent,
  seal,
  unseal,
  type GstDeps,
} from "./portal";
import {
  requireProvider,
  type EwbOp,
  type IrpOp,
  type Secrets,
  type Session,
} from "./provider";
import { GspError, pick, type WbResult } from "./whitebooks";

interface Conn {
  id: string;
  gstin: string;
  gst_username: string | null;
  einv_username: string | null;
  ewb_username: string | null;
  secret_ciphertext: string | null;
  session_ciphertext: string | null;
  einv_token_expires_at: string | null;
  ewb_ready: boolean;
}

async function invoiceAndConn(ctx: RecordCtx, invoiceId: string) {
  assertGstAdmin(ctx);
  const inv = await ctx.tx.one<Record<string, any>>(
    `select * from invoices where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, invoiceId],
  );
  if (!inv) throw notFound();
  if (!inv.seller_gstin) throw badRequest("This invoice has no seller GSTIN");
  const conn = await ctx.tx.one<Conn>(
    `select * from gst_connections where tenant_id = $1 and gstin = $2`,
    [ctx.tenantId, inv.seller_gstin],
  );
  if (!conn)
    throw badRequest(
      `Add the GST registration ${inv.seller_gstin} under Billing & GST → GST portal first`,
    );
  return { inv, conn };
}

/* ───────────────────────── IRP token ───────────────────────── */

const parseExpiry = (v: unknown) => {
  const t = Date.parse(
    String(v ?? "").replace(" ", "T") +
      (/[zZ+]/.test(String(v ?? "").slice(-6)) ? "" : "+05:30"),
  );
  return Number.isFinite(t)
    ? new Date(t)
    : new Date(Date.now() + 5.5 * 3600_000);
};

/** One call to the IRP or the e-way bill system; keeps whatever session the provider renewed. */
async function nic(
  deps: GstDeps,
  conn: Conn,
  invoiceId: string,
  kind: "irp" | "ewb",
  op: IrpOp | EwbOp,
): Promise<WbResult> {
  const gp = requireProvider(deps.env);
  const { session, secrets } = await deps.run(async (ctx) => ({
    session: await unseal<Session>(
      deps.env,
      ctx.tenantId,
      conn.session_ciphertext,
    ),
    secrets: await unseal<Secrets>(
      deps.env,
      ctx.tenantId,
      conn.secret_ciphertext,
    ),
  }));
  let step;
  try {
    step =
      kind === "irp"
        ? await gp.irp(gspConn(conn), secrets, session, deps.ip, op as IrpOp)
        : await gp.ewb(gspConn(conn), secrets, session, deps.ip, op as EwbOp);
  } catch (e) {
    if (e instanceof GspError)
      await deps.run((ctx) =>
        logEvent(ctx, {
          connectionId: conn.id,
          invoiceId,
          action: `${kind === "irp" ? "einvoice" : "ewb"}.auth`,
          ok: false,
          message: e.message,
        }),
      );
    throw e;
  }
  if (step.session || step.einvTokenExpires || step.ewbReady) {
    await deps.run(async (ctx) => {
      const cur = await ctx.tx.one<{ session_ciphertext: string | null }>(
        `select session_ciphertext from gst_connections where tenant_id = $1 and id = $2 for update`,
        [ctx.tenantId, conn.id],
      );
      const s = await unseal<Session>(
        deps.env,
        ctx.tenantId,
        cur?.session_ciphertext ?? null,
      );
      const n = step.session ?? {};
      const merged: Session = {
        ...s,
        ...(n.einvToken
          ? { einvToken: n.einvToken, einvTokenExp: n.einvTokenExp }
          : {}),
        ...(n.ewbAt ? { ewbAt: n.ewbAt } : {}),
      };
      await ctx.tx.query(
        `update gst_connections set session_ciphertext = $3, einv_token_expires_at = coalesce($4, einv_token_expires_at), ewb_ready = ewb_ready or $5 where tenant_id = $1 and id = $2`,
        [
          ctx.tenantId,
          conn.id,
          Object.keys(merged).length
            ? await seal(deps.env, ctx.tenantId, merged)
            : null,
          step.einvTokenExpires?.toISOString() ?? null,
          !!step.ewbReady,
        ],
      );
    });
  }
  // keep what came back (IRN, signed QR, e-way bill…) with the event
  await deps.run((ctx) =>
    logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: `${kind}.${op.op}.call`,
      ok: step.result.ok,
      message: step.result.ok ? null : step.result.message,
      provider: gp.id,
      data: step.result.ok ? step.result.data : step.result.raw,
    }),
  );
  return step.result;
}

/* ───────────────────────── IRN ───────────────────────── */

export async function generateIrn(deps: GstDeps, invoiceId: string) {
  const { inv, conn, json } = await deps.run(async (ctx) => {
    const { inv, conn } = await invoiceAndConn(ctx, invoiceId);
    if (inv.irn && !inv.irn_cancelled_at)
      throw conflict("This invoice already has an IRN");
    const { json, warnings } = await eInvoiceJson(ctx, invoiceId);
    if (warnings.length) throw badRequest(warnings.join("; "));
    return { inv, conn, json };
  });
  let r = await nic(deps, conn, invoiceId, "irp", {
    op: "generate",
    body: json,
  });
  // already registered (e.g. from the IRP portal): fetch it by the document details
  if (!r.ok && /2150|duplicate irn/i.test(`${r.code ?? ""} ${r.message}`)) {
    r = await nic(deps, conn, invoiceId, "irp", {
      op: "byDoc",
      docType: inv.doc_type === "credit_note" ? "CRN" : "INV",
      docNo: inv.invoice_number,
      docDate: json.DocDtls.Dt,
    });
  }
  const irn = r.ok ? pick(r, "Irn", "irn") : undefined;
  return deps.run(async (ctx) => {
    if (!r.ok || !irn) {
      await logEvent(ctx, {
        connectionId: conn.id,
        invoiceId,
        action: "irn.generate",
        ok: false,
        message: r.ok ? "No IRN returned" : r.message,
      });
      throw new GspError(
        r.ok ? "The IRP did not return an IRN" : r.message,
        r.code,
        r,
      );
    }
    const ackNo = pick(r, "AckNo", "ackNo");
    const ackDt = pick(r, "AckDt", "ackDt");
    const qr = pick(r, "SignedQRCode", "signedQRCode");
    await ctx.tx.query(
      `update invoices set irn = $3, ack_no = $4, ack_date = $5, irn_qr = $6, irn_cancelled_at = null,
              ewb_no = coalesce($7, ewb_no), ewb_date = coalesce($8, ewb_date), ewb_valid_until = coalesce($9, ewb_valid_until)
        where tenant_id = $1 and id = $2`,
      [
        ctx.tenantId,
        invoiceId,
        String(irn).toLowerCase(),
        ackNo != null ? String(ackNo).slice(0, 30) : null,
        ackDt ? parseExpiry(ackDt).toISOString() : null,
        qr ? String(qr).slice(0, 4000) : null,
        pick(r, "EwbNo") ? String(pick(r, "EwbNo")) : null,
        pick(r, "EwbDt") ? parseExpiry(pick(r, "EwbDt")).toISOString() : null,
        pick(r, "EwbValidTill")
          ? parseExpiry(pick(r, "EwbValidTill")).toISOString()
          : null,
      ],
    );
    await logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: "irn.generate",
      ok: true,
      message: `IRN ${String(irn).slice(0, 12)}…, ack ${ackNo ?? ""}`,
    });
    return {
      irn: String(irn).toLowerCase(),
      ackNo: ackNo ?? null,
      ackDate: ackDt ?? null,
      qr: !!qr,
    };
  });
}

export const IRN_CANCEL_REASONS = {
  duplicate: "1",
  data_entry_mistake: "2",
  order_cancelled: "3",
  other: "4",
} as const;

/** Cancels the IRN (allowed within 24 hours of generation, and only if there is no live e-way bill). */
export async function cancelIrn(
  deps: GstDeps,
  invoiceId: string,
  reason: keyof typeof IRN_CANCEL_REASONS,
  remark: string,
) {
  const { inv, conn } = await deps.run(async (ctx) =>
    invoiceAndConn(ctx, invoiceId),
  );
  if (!inv.irn || inv.irn_cancelled_at)
    throw badRequest("This invoice has no live IRN");
  if (inv.ewb_no && !inv.ewb_cancelled_at)
    throw badRequest("Cancel the e-way bill first");
  if (inv.ack_date && Date.now() - Date.parse(inv.ack_date) > 24 * 3600_000)
    throw badRequest(
      "An IRN can only be cancelled within 24 hours; issue a credit note instead",
    );
  const r = await nic(deps, conn, invoiceId, "irp", {
    op: "cancel",
    body: {
      Irn: inv.irn,
      CnlRsn: IRN_CANCEL_REASONS[reason],
      CnlRem: remark.slice(0, 100),
    },
  });
  return deps.run(async (ctx) => {
    await logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: "irn.cancel",
      ok: r.ok,
      message: r.ok ? remark : r.message,
    });
    if (!r.ok) throw new GspError(r.message, r.code, r);
    await ctx.tx.query(
      `update invoices set irn_cancelled_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, invoiceId],
    );
    return {
      ok: true,
      note: "The IRN is cancelled. Cancel the invoice in Synapse too (or issue a corrected one).",
    };
  });
}

/* ───────────────────────── e-way bill ───────────────────────── */

export interface TransportInput {
  /** km; 0 lets the system work out the PIN-to-PIN distance */
  distance: number;
  mode: "road" | "rail" | "air" | "ship";
  transporterId?: string | null;
  transporterName?: string | null;
  vehicleNo?: string | null;
  vehicleType?: "regular" | "odc";
  docNo?: string | null;
  docDate?: string | null; // YYYY-MM-DD
}
const MODE = { road: "1", rail: "2", air: "3", ship: "4" } as const;
const dmySlash = (d: string) =>
  `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

function checkTransport(t: TransportInput) {
  if (t.mode === "road" && !t.vehicleNo && !t.transporterId)
    throw badRequest(
      "Enter the vehicle number, or the transporter ID (Part B can be added later)",
    );
  if (t.mode !== "road" && (!t.docNo || !t.docDate))
    throw badRequest("Enter the transport document number and date");
  if (
    t.vehicleNo &&
    !/^[A-Z0-9]{4,15}$/.test(t.vehicleNo.replace(/[\s-]/g, "").toUpperCase())
  )
    throw badRequest("The vehicle number is not valid");
  if (
    t.transporterId &&
    !/^[0-9]{2}[A-Z0-9]{13}$/.test(t.transporterId.toUpperCase())
  )
    throw badRequest("The transporter ID is a 15-character GSTIN or TRANSIN");
}

async function saveEwb(
  deps: GstDeps,
  conn: Conn,
  invoiceId: string,
  r: WbResult,
) {
  const no = pick(r, "EwbNo", "ewayBillNo", "ewbNo");
  return deps.run(async (ctx) => {
    if (!r.ok || !no) {
      await logEvent(ctx, {
        connectionId: conn.id,
        invoiceId,
        action: "ewb.generate",
        ok: false,
        message: r.ok ? "No e-way bill number returned" : r.message,
      });
      throw new GspError(
        r.ok ? "No e-way bill number was returned" : r.message,
        r.code,
        r,
      );
    }
    const dt = pick(r, "EwbDt", "ewayBillDate");
    const till = pick(r, "EwbValidTill", "validUpto");
    await ctx.tx.query(
      `update invoices set ewb_no = $3, ewb_date = $4, ewb_valid_until = $5, ewb_cancelled_at = null where tenant_id = $1 and id = $2`,
      [
        ctx.tenantId,
        invoiceId,
        String(no).slice(0, 20),
        dt
          ? parseExpiry(
              String(dt).replace(/^(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1"),
            ).toISOString()
          : new Date().toISOString(),
        till
          ? parseExpiry(
              String(till).replace(/^(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1"),
            ).toISOString()
          : null,
      ],
    );
    await logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: "ewb.generate",
      ok: true,
      message: `E-way bill ${no}`,
    });
    return { ewbNo: String(no), ewbDate: dt ?? null, validUntil: till ?? null };
  });
}

/**
 * E-way bill for an invoice. With a live IRN it is generated through the IRP from the e-invoice;
 * otherwise directly on the e-way bill system from the invoice's details.
 */
export async function generateEwayBill(
  deps: GstDeps,
  invoiceId: string,
  t: TransportInput,
) {
  checkTransport(t);
  const vehicle = t.vehicleNo
    ? t.vehicleNo.replace(/[\s-]/g, "").toUpperCase()
    : null;
  const { inv, conn, lines, company } = await deps.run(async (ctx) => {
    const { inv, conn } = await invoiceAndConn(ctx, invoiceId);
    if (inv.status === "draft" || inv.status === "cancelled")
      throw badRequest("Only issued invoices get an e-way bill");
    if (inv.ewb_no && !inv.ewb_cancelled_at)
      throw conflict("This invoice already has an e-way bill");
    return {
      inv,
      conn,
      lines: await invoiceLines(ctx, invoiceId),
      company: await letterhead(ctx),
    };
  });
  if (inv.irn && !inv.irn_cancelled_at) {
    const r = await nic(deps, conn, invoiceId, "irp", {
      op: "ewb",
      body: {
        Irn: inv.irn,
        Distance: Math.round(t.distance),
        TransMode: MODE[t.mode],
        ...(t.transporterId ? { TransId: t.transporterId.toUpperCase() } : {}),
        ...(t.transporterName
          ? { TransName: t.transporterName.slice(0, 100) }
          : {}),
        ...(t.docNo ? { TransDocNo: t.docNo.slice(0, 15) } : {}),
        ...(t.docDate ? { TransDocDt: dmySlash(t.docDate) } : {}),
        ...(vehicle
          ? { VehNo: vehicle, VehType: t.vehicleType === "odc" ? "O" : "R" }
          : {}),
      },
    });
    return saveEwb(deps, conn, invoiceId, r);
  }
  const goods = lines.filter((l) => !l.isService);
  if (!goods.length)
    throw badRequest(
      "An e-way bill is for goods; this invoice has only services",
    );
  const pin = (s: unknown) =>
    Number(/\b\d{6}\b/.exec(String(s ?? ""))?.[0] ?? 0);
  const fromPin = pin(company.address);
  const toPin = pin(inv.buyer_pincode) || pin(inv.buyer_address);
  if (!fromPin)
    throw badRequest(
      "Add your PIN code to the company address (Settings → Sales setup)",
    );
  if (!toPin)
    throw badRequest("Add the customer's PIN code to the invoice address");
  const fromState = Number(stateCode(conn.gstin));
  const toState = Number(
    inv.pos_code ?? stateCode(inv.buyer_gstin ?? inv.buyer_state) ?? fromState,
  );
  const inter = inv.supply_type === "inter" || inv.supply_type === "export";
  const body = {
    supplyType: "O",
    subSupplyType: inv.supply_type === "export" ? "3" : "1",
    docType: inv.doc_type === "credit_note" ? "CHL" : "INV",
    docNo: inv.invoice_number,
    docDate: dmySlash(
      String(
        inv.invoice_date instanceof Date
          ? inv.invoice_date.toISOString()
          : inv.invoice_date,
      ).slice(0, 10),
    ),
    fromGstin: conn.gstin,
    fromTrdName: company.name.slice(0, 100),
    fromAddr1: (company.address || company.name).slice(0, 120),
    fromPlace: (company.state || "").slice(0, 50) || "NA",
    fromPincode: fromPin,
    actFromStateCode: fromState,
    fromStateCode: fromState,
    toGstin: inv.buyer_gstin || "URP",
    toTrdName: String(inv.buyer_name ?? "").slice(0, 100),
    toAddr1: String(inv.buyer_address ?? inv.buyer_name ?? "").slice(0, 120),
    toPlace: String(inv.buyer_state ?? "").slice(0, 50) || "NA",
    toPincode: toPin,
    actToStateCode: toState,
    toStateCode: inv.supply_type === "export" ? 99 : toState,
    transactionType: 1,
    totalValue: Number(inv.taxable_total),
    cgstValue: Number(inv.cgst_total),
    sgstValue: Number(inv.sgst_total),
    igstValue: Number(inv.igst_total),
    cessValue: 0,
    cessNonAdvolValue: 0,
    otherValue: Number(inv.round_off ?? 0),
    totInvValue: Number(inv.grand_total),
    transMode: MODE[t.mode],
    transDistance: String(Math.round(t.distance)),
    ...(t.transporterId
      ? { transporterId: t.transporterId.toUpperCase() }
      : {}),
    ...(t.transporterName
      ? { transporterName: t.transporterName.slice(0, 100) }
      : {}),
    ...(t.docNo ? { transDocNo: t.docNo.slice(0, 15) } : {}),
    ...(t.docDate ? { transDocDate: dmySlash(t.docDate) } : {}),
    ...(vehicle
      ? { vehicleNo: vehicle, vehicleType: t.vehicleType === "odc" ? "O" : "R" }
      : {}),
    itemList: goods.map((l) => ({
      productName: l.name.slice(0, 100),
      productDesc: l.name.slice(0, 100),
      hsnCode: Number(String(l.hsnSac ?? "").replace(/\D/g, "")) || 0,
      quantity: l.quantity,
      qtyUnit: uqc(l.unit),
      cgstRate: inter ? 0 : l.taxRate / 2,
      sgstRate: inter ? 0 : l.taxRate / 2,
      igstRate: inter ? l.taxRate : 0,
      cessRate: 0,
      taxableAmount: l.lineSubtotal,
    })),
  };
  if (body.itemList.some((i) => !i.hsnCode))
    throw badRequest("Every item needs an HSN code for the e-way bill");
  const r = await nic(deps, conn, invoiceId, "ewb", { op: "generate", body });
  return saveEwb(deps, conn, invoiceId, r);
}

export const EWB_CANCEL_REASONS = {
  duplicate: 1,
  order_cancelled: 2,
  data_entry_mistake: 3,
  other: 4,
} as const;

export async function cancelEwayBill(
  deps: GstDeps,
  invoiceId: string,
  reason: keyof typeof EWB_CANCEL_REASONS,
  remark: string,
) {
  const { inv, conn } = await deps.run(async (ctx) =>
    invoiceAndConn(ctx, invoiceId),
  );
  if (!inv.ewb_no || inv.ewb_cancelled_at)
    throw badRequest("This invoice has no live e-way bill");
  if (inv.ewb_date && Date.now() - Date.parse(inv.ewb_date) > 24 * 3600_000)
    throw badRequest("An e-way bill can only be cancelled within 24 hours");
  const r = await nic(deps, conn, invoiceId, "ewb", {
    op: "cancel",
    body: {
      ewbNo: Number(inv.ewb_no),
      cancelRsnCode: EWB_CANCEL_REASONS[reason],
      cancelRmrk: remark.slice(0, 50),
    },
  });
  return deps.run(async (ctx) => {
    await logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: "ewb.cancel",
      ok: r.ok,
      message: r.ok ? remark : r.message,
    });
    if (!r.ok) throw new GspError(r.message, r.code, r);
    await ctx.tx.query(
      `update invoices set ewb_cancelled_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, invoiceId],
    );
    return { ok: true };
  });
}

export const VEHICLE_REASONS = {
  breakdown: "1",
  transhipment: "2",
  other: "3",
  first_time: "4",
} as const;

/** Part B: a new vehicle (or the first one) for the e-way bill. */
export async function updateVehicle(
  deps: GstDeps,
  invoiceId: string,
  v: {
    vehicleNo: string;
    fromPlace: string;
    reason: keyof typeof VEHICLE_REASONS;
    remark: string;
    mode?: TransportInput["mode"];
    docNo?: string | null;
    docDate?: string | null;
  },
) {
  const { inv, conn, company } = await deps.run(async (ctx) => {
    const x = await invoiceAndConn(ctx, invoiceId);
    return { ...x, company: await letterhead(ctx) };
  });
  if (!inv.ewb_no || inv.ewb_cancelled_at)
    throw badRequest("This invoice has no live e-way bill");
  const vehicle = v.vehicleNo.replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z0-9]{4,15}$/.test(vehicle))
    throw badRequest("The vehicle number is not valid");
  const r = await nic(deps, conn, invoiceId, "ewb", {
    op: "vehicle",
    body: {
      ewbNo: Number(inv.ewb_no),
      vehicleNo: vehicle,
      fromPlace: v.fromPlace.slice(0, 50) || company.state || "NA",
      fromState: Number(stateCode(conn.gstin)),
      reasonCode: VEHICLE_REASONS[v.reason],
      reasonRem: v.remark.slice(0, 50),
      transMode: MODE[v.mode ?? "road"],
      ...(v.docNo ? { transDocNo: v.docNo } : {}),
      ...(v.docDate ? { transDocDate: dmySlash(v.docDate) } : {}),
    },
  });
  return deps.run(async (ctx) => {
    await logEvent(ctx, {
      connectionId: conn.id,
      invoiceId,
      action: "ewb.vehicle",
      ok: r.ok,
      message: r.ok ? vehicle : r.message,
    });
    if (!r.ok) throw new GspError(r.message, r.code, r);
    const till = pick(r, "validUpto");
    if (till)
      await ctx.tx.query(
        `update invoices set ewb_valid_until = $3 where tenant_id = $1 and id = $2`,
        [
          ctx.tenantId,
          invoiceId,
          parseExpiry(
            String(till).replace(/^(\d{2})\/(\d{2})\/(\d{4})/, "$3-$2-$1"),
          ).toISOString(),
        ],
      );
    return { ok: true, validUntil: till ?? null };
  });
}

/** What the invoice page shows: IRN, QR, e-way bill and the log. */
export async function invoiceGstStatus(deps: GstDeps, invoiceId: string) {
  return deps.run(async (ctx) => {
    const { inv, conn } = await invoiceAndConn(ctx, invoiceId).catch((e) => {
      if (e instanceof ApiError && e.status === 400)
        return { inv: null, conn: null };
      throw e;
    });
    const row =
      inv ??
      (await ctx.tx.one<Record<string, any>>(
        `select irn, ack_no, ack_date, irn_qr, irn_cancelled_at, ewb_no, ewb_date, ewb_valid_until, ewb_cancelled_at from invoices where tenant_id = $1 and id = $2`,
        [ctx.tenantId, invoiceId],
      ));
    if (!row) throw notFound();
    const events = await ctx.tx.query(
      `select action, ok, message, created_at from gst_events where tenant_id = $1 and invoice_id = $2 order by created_at desc limit 20`,
      [ctx.tenantId, invoiceId],
    );
    return {
      connected: !!conn,
      einvoiceReady: !!conn?.einv_username,
      ewayBillReady: !!conn?.ewb_username,
      irn: row.irn,
      ackNo: row.ack_no,
      ackDate: row.ack_date,
      qr: row.irn_qr,
      irnCancelledAt: row.irn_cancelled_at,
      ewbNo: row.ewb_no,
      ewbDate: row.ewb_date,
      ewbValidUntil: row.ewb_valid_until,
      ewbCancelledAt: row.ewb_cancelled_at,
      events,
    };
  });
}
