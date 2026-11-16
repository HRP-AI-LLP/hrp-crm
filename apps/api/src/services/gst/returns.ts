/**
 * Provider-neutral GST returns: builds the GST portal's JSON for GSTR-1, GSTR-3B and ITC-04 from
 * Synapse's own records, and the filing calendar with due dates. The JSON is what the portal's
 * offline tool and every GSP accept (keys and formats as in GSTN's API schema), so it can be saved
 * through WhiteBooks or downloaded and uploaded on gst.gov.in by hand.
 *
 * Amounts are in rupees (foreign-currency invoices at their exchange rate), dates dd-mm-yyyy and
 * periods MMYYYY.
 */
import { stateCode } from '@synapse/shared';
import { badRequest } from '../../lib/errors';
import { gstr3b as gstr3bReport } from '../books/reports';
import type { RecordCtx } from '../records';

const r2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const dmy = (d: unknown) => {
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}`;
};

/** "2026-04" → "042026" */
export const toRetPeriod = (month: string) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('Month must be YYYY-MM');
  return `${month.slice(5, 7)}${month.slice(0, 4)}`;
};
/** "042026" → "2026-04" */
export const fromRetPeriod = (p: string) => {
  if (!/^(0[1-9]|1[0-2])\d{4}$/.test(p)) throw badRequest('Return period must be MMYYYY');
  return `${p.slice(2)}-${p.slice(0, 2)}`;
};
const monthRange = (month: string) => {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  return { from, to };
};

/** GST unit quantity codes (UQC) for the commonest units; anything else is OTH. */
const UQC: Record<string, string> = { nos: 'NOS', no: 'NOS', pcs: 'PCS', pc: 'PCS', set: 'SET', sets: 'SET', kg: 'KGS', kgs: 'KGS', mtr: 'MTR', m: 'MTR', sqft: 'SQF', 'sq.ft': 'SQF', sqm: 'SQM', box: 'BOX', ltr: 'LTR', l: 'LTR', ton: 'TON', tonne: 'TON', mt: 'MTS', bag: 'BAG', bags: 'BAG', roll: 'ROL', pair: 'PRS', doz: 'DOZ' };
export const uqc = (u: string | null | undefined) => UQC[(u ?? '').toLowerCase().replace(/\s+/g, '')] ?? 'OTH';

/** Inter-state supplies to unregistered buyers above this go to B2CL (₹1 lakh since 1 Aug 2024). */
export const B2CL_LIMIT = 100000;

interface InvRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  doc_type: 'tax_invoice' | 'credit_note';
  status: string;
  buyer_gstin: string | null;
  pos_code: string | null;
  supply_type: 'intra' | 'inter' | 'export' | null;
  reverse_charge: boolean;
  grand_total: number;
  fx: number;
  igst_total: number;
  tax_total: number;
}
interface LineRow {
  invoice_id: string;
  rate: number;
  hsn: string;
  description: string;
  unit: string | null;
  is_service: boolean;
  qty: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
}

/**
 * GSTR-1 for a month from issued invoices and credit notes (proformas and drafts are left out;
 * cancelled documents only count in the documents-issued table).
 */
export async function buildGstr1(ctx: RecordCtx, gstin: string, month: string) {
  const fp = toRetPeriod(month);
  const { from, to } = monthRange(month);
  const invs = await ctx.tx.query<InvRow>(
    `select id, invoice_number, invoice_date::text, doc_type, status, nullif(trim(buyer_gstin), '') as buyer_gstin, pos_code, supply_type, reverse_charge,
            grand_total::float8 as grand_total, exchange_rate::float8 as fx, igst_total::float8 as igst_total, tax_total::float8 as tax_total
       from invoices where tenant_id = $1 and deleted_at is null and doc_type in ('tax_invoice', 'credit_note') and status <> 'draft'
        and invoice_number is not null and invoice_date between $2::date and $3::date
      order by invoice_date, invoice_number`,
    [ctx.tenantId, from, to],
  );
  const live = invs.filter((i) => i.status !== 'cancelled');
  const lines = live.length
    ? await ctx.tx.query<LineRow>(
        `select l.order_id as invoice_id, l.tax_rate::float8 as rate, coalesce(nullif(trim(l.hsn_sac), ''), '') as hsn, l.name as description, l.unit,
                coalesce(p.product_type = 'service', false) as is_service,
                l.quantity::float8 as qty, (l.line_subtotal * i.exchange_rate)::float8 as txval,
                (l.line_igst * i.exchange_rate)::float8 as iamt, (l.line_cgst * i.exchange_rate)::float8 as camt, (l.line_sgst * i.exchange_rate)::float8 as samt
           from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.order_id
           left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
          where l.tenant_id = $1 and l.order_id = any($2::uuid[])`,
        [ctx.tenantId, live.map((i) => i.id)],
      )
    : [];
  const byInv = new Map<string, LineRow[]>();
  for (const l of lines) byInv.set(l.invoice_id, [...(byInv.get(l.invoice_id) ?? []), l]);

  const warnings: string[] = [];
  /** item rows grouped by rate */
  const items = (inv: InvRow, opts: { flat?: boolean; igstOnly?: boolean } = {}) => {
    const byRate = new Map<number, { txval: number; iamt: number; camt: number; samt: number }>();
    for (const l of byInv.get(inv.id) ?? []) {
      const g = byRate.get(l.rate) ?? { txval: 0, iamt: 0, camt: 0, samt: 0 };
      g.txval += l.txval;
      g.iamt += l.iamt;
      g.camt += l.camt;
      g.samt += l.samt;
      byRate.set(l.rate, g);
    }
    return [...byRate.entries()].map(([rt, g], i) => {
      const det: Record<string, number> = { txval: r2(g.txval), rt };
      if (opts.igstOnly || g.iamt) det.iamt = r2(g.iamt);
      if (!opts.igstOnly && (g.camt || g.samt)) {
        det.camt = r2(g.camt);
        det.samt = r2(g.samt);
      }
      det.csamt = 0;
      return opts.flat ? det : { num: i + 1, itm_det: det };
    });
  };
  const pos = (i: InvRow, sellerState: string) => i.pos_code ?? (i.buyer_gstin ? stateCode(i.buyer_gstin) : null) ?? sellerState;
  const sellerState = gstin.slice(0, 2);
  const inter = (i: InvRow) => i.supply_type === 'inter' || (i.supply_type == null && pos(i, sellerState) !== sellerState);

  const b2b = new Map<string, any[]>();
  const cdnr = new Map<string, any[]>();
  const b2cl = new Map<string, any[]>();
  const b2cs = new Map<string, { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number }>();
  const exp: Record<'WPAY' | 'WOPAY', any[]> = { WPAY: [], WOPAY: [] };
  const cdnurExp: any[] = [];
  const nil = new Map<string, number>();

  for (const i of live) {
    const val = r2(i.grand_total * i.fx);
    const p = pos(i, sellerState)!;
    if (!(byInv.get(i.id) ?? []).length) {
      warnings.push(`${i.invoice_number} has no lines`);
      continue;
    }
    if (i.supply_type === 'export') {
      if (i.doc_type === 'credit_note') {
        cdnurExp.push({ ntty: 'C', nt_num: i.invoice_number, nt_dt: dmy(i.invoice_date), val, typ: i.igst_total > 0 ? 'EXPWP' : 'EXPWOP', itms: items(i, { igstOnly: true }) });
      } else {
        exp[i.igst_total > 0 ? 'WPAY' : 'WOPAY'].push({ inum: i.invoice_number, idt: dmy(i.invoice_date), val, itms: items(i, { flat: true, igstOnly: true }) });
      }
      continue;
    }
    if (i.tax_total === 0 && i.doc_type === 'tax_invoice') {
      const key = `${inter(i) ? 'INTR' : 'INTRA'}${i.buyer_gstin ? 'B2B' : 'B2C'}`;
      nil.set(key, r2((nil.get(key) ?? 0) + (byInv.get(i.id) ?? []).reduce((s, l) => s + l.txval, 0)));
      continue;
    }
    if (i.buyer_gstin) {
      if (i.buyer_gstin === gstin) warnings.push(`${i.invoice_number} is billed to your own GSTIN`);
      const doc =
        i.doc_type === 'tax_invoice'
          ? { inum: i.invoice_number, idt: dmy(i.invoice_date), val, pos: p, rchrg: i.reverse_charge ? 'Y' : 'N', inv_typ: 'R', itms: items(i) }
          : { ntty: 'C', nt_num: i.invoice_number, nt_dt: dmy(i.invoice_date), val, pos: p, rchrg: i.reverse_charge ? 'Y' : 'N', inv_typ: 'R', itms: items(i) };
      const m = i.doc_type === 'tax_invoice' ? b2b : cdnr;
      m.set(i.buyer_gstin, [...(m.get(i.buyer_gstin) ?? []), doc]);
      continue;
    }
    // unregistered buyer
    if (i.doc_type === 'tax_invoice' && inter(i) && val > B2CL_LIMIT) {
      b2cl.set(p, [...(b2cl.get(p) ?? []), { inum: i.invoice_number, idt: dmy(i.invoice_date), val, itms: items(i, { igstOnly: true }) }]);
      continue;
    }
    // B2CS: net of credit notes, by place of supply and rate
    const sign = i.doc_type === 'credit_note' ? -1 : 1;
    for (const l of byInv.get(i.id) ?? []) {
      const k = `${inter(i) ? 'INTER' : 'INTRA'}|${p}|${l.rate}`;
      const g = b2cs.get(k) ?? { sply_ty: inter(i) ? 'INTER' : 'INTRA', pos: p, typ: 'OE', rt: l.rate, txval: 0, iamt: 0, camt: 0, samt: 0 };
      g.txval += sign * l.txval;
      g.iamt += sign * l.iamt;
      g.camt += sign * l.camt;
      g.samt += sign * l.samt;
      b2cs.set(k, g);
    }
  }

  // HSN summary, split B2B / B2C as the portal requires
  const hsn = { b2b: new Map<string, any>(), b2c: new Map<string, any>() };
  for (const i of live) {
    if ((byInv.get(i.id) ?? []).length === 0) continue;
    const sign = i.doc_type === 'credit_note' ? -1 : 1;
    const side = i.buyer_gstin ? hsn.b2b : hsn.b2c;
    for (const l of byInv.get(i.id) ?? []) {
      if (!l.hsn) warnings.push(`${i.invoice_number}: "${l.description}" has no HSN/SAC`);
      const k = `${l.hsn}|${l.rate}|${uqc(l.unit)}`;
      const g = side.get(k) ?? { hsn_sc: l.hsn, desc: l.description.slice(0, 30), uqc: l.is_service || /^99/.test(l.hsn) ? 'NA' : uqc(l.unit), rt: l.rate, qty: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      g.qty += g.uqc === 'NA' ? 0 : sign * l.qty;
      g.txval += sign * l.txval;
      g.iamt += sign * l.iamt;
      g.camt += sign * l.camt;
      g.samt += sign * l.samt;
      side.set(k, g);
    }
  }
  const hsnRows = (m: Map<string, any>) =>
    [...m.values()].map((g, n) => ({ num: n + 1, hsn_sc: g.hsn_sc, desc: g.desc, uqc: g.uqc, qty: Math.round(g.qty * 1000) / 1000, rt: g.rt, txval: r2(g.txval), iamt: r2(g.iamt), camt: r2(g.camt), samt: r2(g.samt), csamt: 0 }));

  // documents issued: one row per series (the prefix before the running number), cancelled included
  const docRows = (type: 'tax_invoice' | 'credit_note') => {
    const series = new Map<string, InvRow[]>();
    for (const i of invs.filter((x) => x.doc_type === type)) {
      const key = i.invoice_number.replace(/\d+\D*$/, '');
      series.set(key, [...(series.get(key) ?? []), i]);
    }
    return [...series.values()].map((list, n) => {
      const sorted = [...list].sort((a, b) => a.invoice_number.localeCompare(b.invoice_number, 'en', { numeric: true }));
      const cancel = sorted.filter((x) => x.status === 'cancelled').length;
      return { num: n + 1, from: sorted[0]!.invoice_number, to: sorted[sorted.length - 1]!.invoice_number, totnum: sorted.length, cancel, net_issue: sorted.length - cancel };
    });
  };
  const docDet = [
    { doc_num: 1, doc_typ: 'Invoices for outward supply', docs: docRows('tax_invoice') },
    { doc_num: 5, doc_typ: 'Credit Note', docs: docRows('credit_note') },
  ].filter((d) => d.docs.length);

  const payload: Record<string, unknown> = { gstin, fp };
  if (b2b.size) payload.b2b = [...b2b.entries()].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2cl.size) payload.b2cl = [...b2cl.entries()].map(([p, inv]) => ({ pos: p, inv }));
  const b2csRows = [...b2cs.values()].filter((g) => Math.abs(g.txval) >= 0.01);
  if (b2csRows.length)
    payload.b2cs = b2csRows.map((g) =>
      g.sply_ty === 'INTER' ? { sply_ty: g.sply_ty, pos: g.pos, typ: g.typ, rt: g.rt, txval: r2(g.txval), iamt: r2(g.iamt), csamt: 0 } : { sply_ty: g.sply_ty, pos: g.pos, typ: g.typ, rt: g.rt, txval: r2(g.txval), camt: r2(g.camt), samt: r2(g.samt), csamt: 0 },
    );
  if (cdnr.size) payload.cdnr = [...cdnr.entries()].map(([ctin, nt]) => ({ ctin, nt }));
  if (cdnurExp.length) payload.cdnur = cdnurExp;
  const expRows = (['WPAY', 'WOPAY'] as const).filter((t) => exp[t].length).map((t) => ({ exp_typ: t, inv: exp[t] }));
  if (expRows.length) payload.exp = expRows;
  if (nil.size) payload.nil = { inv: [...nil.entries()].map(([sply_ty, amt]) => ({ sply_ty, nil_amt: amt, expt_amt: 0, ngsup_amt: 0 })) };
  if (hsn.b2b.size || hsn.b2c.size) payload.hsn = { ...(hsn.b2b.size ? { hsn_b2b: hsnRows(hsn.b2b) } : {}), ...(hsn.b2c.size ? { hsn_b2c: hsnRows(hsn.b2c) } : {}) };
  if (docDet.length) payload.doc_issue = { doc_det: docDet };

  const totals = live.reduce(
    (t, i) => {
      const s = i.doc_type === 'credit_note' ? -1 : 1;
      for (const l of byInv.get(i.id) ?? []) {
        t.taxable += s * l.txval;
        t.igst += s * l.iamt;
        t.cgst += s * l.camt;
        t.sgst += s * l.samt;
      }
      return t;
    },
    { taxable: 0, igst: 0, cgst: 0, sgst: 0 },
  );
  return {
    payload,
    counts: { b2b: [...b2b.values()].reduce((n, a) => n + a.length, 0), b2cl: [...b2cl.values()].reduce((n, a) => n + a.length, 0), b2cs: b2csRows.length, cdnr: [...cdnr.values()].reduce((n, a) => n + a.length, 0), exp: exp.WPAY.length + exp.WOPAY.length, cancelled: invs.length - live.length },
    totals: { taxable: r2(totals.taxable), igst: r2(totals.igst), cgst: r2(totals.cgst), sgst: r2(totals.sgst) },
    warnings: [...new Set(warnings)].slice(0, 200),
  };
}

const z5 = () => ({ iamt: 0, camt: 0, samt: 0, csamt: 0 });

/** GSTR-3B for a month from the books' GSTR-3B working (invoices, bills, expenses, reverse charge). */
export async function buildGstr3b(ctx: RecordCtx, gstin: string, month: string) {
  const ret_period = toRetPeriod(month);
  const g = await gstr3bReport(ctx, month);
  const { from, to } = monthRange(month);
  // 3.2: inter-state supplies to unregistered persons, by place of supply
  const unreg = await ctx.tx.query<{ pos: string; txval: number; iamt: number }>(
    `select pos_code as pos, sum(s * taxable_total * exchange_rate)::float8 as txval, sum(s * igst_total * exchange_rate)::float8 as iamt
       from (select *, case when doc_type = 'credit_note' then -1 else 1 end as s from invoices
              where tenant_id = $1 and doc_type in ('tax_invoice','credit_note') and status not in ('draft','cancelled') and deleted_at is null
                and invoice_date between $2::date and $3::date and supply_type = 'inter' and nullif(trim(buyer_gstin), '') is null and pos_code is not null) x
      group by pos_code having abs(sum(s * taxable_total * exchange_rate)) >= 0.01 order by pos_code`,
    [ctx.tenantId, from, to],
  );
  const fb = g.itc.fromBills ?? { igst: 0, cgst: 0, sgst: 0 };
  const fe = g.itc.fromExpenses ?? { igst: 0, cgst: 0, sgst: 0 };
  const itcOther = {
    iamt: r2(fb.igst + fe.igst),
    camt: r2(fb.cgst + fe.cgst),
    samt: r2(fb.sgst + fe.sgst),
    csamt: 0,
  };
  const rc = g.itc.reverseCharge as { igst: number; cgst: number; sgst: number };
  const payload = {
    gstin,
    ret_period,
    sup_details: {
      osup_det: { txval: r2(g.outward.taxable), iamt: r2(g.outward.igst), camt: r2(g.outward.cgst), samt: r2(g.outward.sgst), csamt: 0 },
      osup_zero: { txval: r2(g.zeroRated.taxable), iamt: r2(g.zeroRated.igst), csamt: 0 },
      osup_nil_exmp: { txval: r2(g.nilExempt) },
      isup_rev: { txval: r2(g.inwardReverseCharge!.taxable), iamt: r2(g.inwardReverseCharge!.igst), camt: r2(g.inwardReverseCharge!.cgst), samt: r2(g.inwardReverseCharge!.sgst), csamt: 0 },
      osup_nongst: { txval: 0 },
    },
    inter_sup: { unreg_details: unreg.map((u) => ({ pos: u.pos, txval: r2(u.txval), iamt: r2(u.iamt) })), comp_details: [], uin_details: [] },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...z5() },
        { ty: 'IMPS', ...z5() },
        { ty: 'ISRC', iamt: r2(rc.igst), camt: r2(rc.cgst), samt: r2(rc.sgst), csamt: 0 },
        { ty: 'ISD', ...z5() },
        { ty: 'OTH', ...itcOther },
      ],
      itc_rev: [
        { ty: 'RUL', ...z5() },
        { ty: 'OTH', ...z5() },
      ],
      itc_net: { iamt: r2(g.itc.total.igst), camt: r2(g.itc.total.cgst), samt: r2(g.itc.total.sgst), csamt: 0 },
      itc_inelg: [
        { ty: 'RUL', ...z5() },
        { ty: 'OTH', ...z5() },
      ],
    },
    inward_sup: {
      isup_details: [
        { ty: 'GST', inter: 0, intra: 0 },
        { ty: 'NONGST', inter: 0, intra: 0 },
      ],
    },
    intr_ltfee: { intr_details: { ...z5() } },
  };
  return { payload, working: g, warnings: [] as string[] };
}

/**
 * ITC-04 (goods sent to and received from job workers) for a period, from manufacturing's job work.
 * period is the last month of the reporting period (MMYYYY); from/to are the dates it covers.
 */
export async function buildItc04(ctx: RecordCtx, gstin: string, period: string, from: string, to: string) {
  const sellerState = gstin.slice(0, 2);
  const sent = await ctx.tx.query<{ challan: string; date: string; gstin: string | null; state: string | null; product: string; unit: string | null; qty: number; val: number; rate: number }>(
    `select j.challan_number as challan, g.log_date::text as date, nullif(trim(v.gstin), '') as gstin, v.state, p.name as product, p.unit,
            l.sent_qty::float8 as qty, round(l.sent_qty * l.unit_cost, 2)::float8 as val, coalesce(p.tax_rate, 0)::float8 as rate
       from job_work_logs g join job_works j on j.tenant_id = g.tenant_id and j.id = g.job_work_id
       join vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id
       join job_work_lines l on l.tenant_id = j.tenant_id and l.job_work_id = j.id
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where g.tenant_id = $1 and g.kind = 'send' and g.log_date between $2::date and $3::date order by g.log_date, j.challan_number`,
    [ctx.tenantId, from, to],
  );
  const received = await ctx.tx.query<{ challan: string; sent_date: string; jw_challan: string | null; date: string; gstin: string | null; product: string; unit: string | null; qty: number }>(
    `select j.challan_number as challan, j.sent_date::text as sent_date, g.challan_ref as jw_challan, g.log_date::text as date, nullif(trim(v.gstin), '') as gstin,
            coalesce(op.name, p0.name) as product, coalesce(op.unit, p0.unit) as unit, coalesce(g.output_qty, 0)::float8 as qty
       from job_work_logs g join job_works j on j.tenant_id = g.tenant_id and j.id = g.job_work_id
       join vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id
       left join products op on op.tenant_id = j.tenant_id and op.id = j.output_product_id
       left join lateral (select p.name, p.unit from job_work_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
                           where l.tenant_id = j.tenant_id and l.job_work_id = j.id limit 1) p0 on true
      where g.tenant_id = $1 and g.kind = 'receive' and g.log_date between $2::date and $3::date order by g.log_date`,
    [ctx.tenantId, from, to],
  );
  const warnings: string[] = [];
  const stcd = (g: string | null, state: string | null) => (g ? g.slice(0, 2) : stateCode(state ?? '') ?? sellerState);
  const byChallan = new Map<string, any>();
  for (const s of sent) {
    const jw = stcd(s.gstin, s.state);
    const intra = jw === sellerState;
    const tax = r2((s.val * s.rate) / 100);
    const c = byChallan.get(s.challan) ?? { ...(s.gstin ? { ctin: s.gstin } : {}), jw_stcd: jw, flag: 'N', chnum: s.challan, chdt: dmy(s.date), itms: [] };
    c.itms.push({ goods_ty: '5a', desc: s.product.slice(0, 30), uqc: uqc(s.unit), qty: s.qty, val: s.val, tx_c: intra ? r2(tax / 2) : 0, tx_s: intra ? r2(tax - r2(tax / 2)) : 0, tx_i: intra ? 0 : tax, tx_cs: 0 });
    byChallan.set(s.challan, c);
  }
  const back = new Map<string, any>();
  for (const r of received) {
    if (!r.jw_challan) warnings.push(`Receipt against ${r.challan} on ${r.date} has no job worker's challan number`);
    const k = r.gstin ?? 'URP';
    const c = back.get(k) ?? { ...(r.gstin ? { ctin: r.gstin } : {}), jw_stcd: r.gstin ? r.gstin.slice(0, 2) : sellerState, flag: 'N', items: [] };
    c.items.push({ o_chnum: r.challan, o_chdt: dmy(r.sent_date), jw2_chnum: r.jw_challan ?? r.challan, jw2_chdt: dmy(r.date), nat_jw: 'Job work', desc: (r.product ?? '').slice(0, 30), uqc: uqc(r.unit), qty: r.qty, lwqty: 0, lwuqc: 'OTH' });
    back.set(k, c);
  }
  const payload: Record<string, unknown> = { gstin, fp: period };
  if (byChallan.size) payload.m2jw = [...byChallan.values()];
  if (back.size) payload.table5A = [...back.values()];
  return { payload, counts: { challansSent: byChallan.size, receipts: received.length }, warnings };
}

/** Return types the app can prepare from its own records; the others are uploaded as portal JSON. */
export const BUILDABLE = ['GSTR1', 'GSTR3B', 'ITC04'] as const;

/* ───────────────────────── filing calendar ───────────────────────── */

export interface DueItem {
  returnType: string;
  label: string;
  period: string; // MMYYYY
  periodLabel: string;
  dueDate: string; // YYYY-MM-DD
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
/** States and UTs whose quarterly GSTR-3B is due on the 22nd (the rest: 24th). */
const DUE_22 = new Set(['22', '23', '24', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '25', '26', '28', '97']);

/**
 * Due dates for the returns a regular taxpayer files, for the months in [from, to] (YYYY-MM).
 * Monthly filers: GSTR-1 on the 11th, GSTR-3B on the 20th. Quarterly (QRMP): both after each
 * quarter (13th; 22nd or 24th by state). GSTR-7 on the 10th (only for TDS deductors), ITC-04
 * yearly on 25 April, GSTR-9 on 31 December. Dates the government extends are not known here.
 */
export function filingCalendar(gstin: string, frequency: 'monthly' | 'quarterly', from: string, to: string, opts: { tdsDeductor?: boolean; jobWork?: boolean } = {}): DueItem[] {
  const out: DueItem[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  let guard = 0;
  while ((y < ty || (y === ty && m <= tm)) && guard++ < 60) {
    const period = `${String(m).padStart(2, '0')}${y}`;
    const label = `${MONTHS[m - 1]} ${y}`;
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    if (frequency === 'monthly') {
      out.push({ returnType: 'GSTR1', label: 'GSTR-1', period, periodLabel: label, dueDate: ymd(ny, nm, 11) });
      out.push({ returnType: 'GSTR3B', label: 'GSTR-3B', period, periodLabel: label, dueDate: ymd(ny, nm, 20) });
    } else if (m % 3 === 0) {
      const ql = `${MONTHS[m - 3]}–${MONTHS[m - 1]} ${y}`;
      out.push({ returnType: 'GSTR1', label: 'GSTR-1 (quarterly)', period, periodLabel: ql, dueDate: ymd(ny, nm, 13) });
      out.push({ returnType: 'GSTR3B', label: 'GSTR-3B (quarterly)', period, periodLabel: ql, dueDate: ymd(ny, nm, DUE_22.has(gstin.slice(0, 2)) ? 22 : 24) });
    }
    if (opts.tdsDeductor) out.push({ returnType: 'GSTR7', label: 'GSTR-7', period, periodLabel: label, dueDate: ymd(ny, nm, 10) });
    if (m === 3) {
      if (opts.jobWork) out.push({ returnType: 'ITC04', label: 'ITC-04 (yearly)', period, periodLabel: `FY ${y - 1}-${String(y).slice(2)}`, dueDate: ymd(y, 4, 25) });
      out.push({ returnType: 'GSTR9', label: 'GSTR-9 (annual)', period, periodLabel: `FY ${y - 1}-${String(y).slice(2)}`, dueDate: ymd(y, 12, 31) });
    }
    [y, m] = [ny, nm];
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.returnType.localeCompare(b.returnType));
}
