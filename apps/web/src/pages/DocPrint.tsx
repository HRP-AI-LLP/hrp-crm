import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Link, useParams } from 'react-router-dom';
import { type DocLabels, type DocTemplate, type QuoteDoc } from '../components/QuoteDocument';
import { TemplatedDocument } from '../components/DocTemplateView';
import { Spinner } from '../components/ui';
import { get } from '../lib/api';
import { date } from '../lib/format';
import { useAuth } from '../lib/auth';

type Json = Record<string, any>;

const TERMS: Record<string, string> = { due_on_receipt: 'Due on receipt', end_of_month: 'Due end of the month', end_of_next_month: 'Due end of next month' };
for (const n of [7, 15, 30, 45, 60]) TERMS[`net_${n}`] = `Net ${n} days`;

/** Builds the printable document (shared A4 layout) for orders, purchase orders and invoices. */
export function shape(kind: string, d: Json): { doc: QuoteDoc; labels: DocLabels; back: string } | null {
  if (kind === 'sales_order') {
    const o = d.order;
    const acc = d.account;
    const billTo = { ...(o.bill_to ?? {}), name: acc?.name ?? o.bill_to?.name, state: o.bill_to?.state ?? acc?.state ?? '', gstin: o.bill_to?.gstin ?? acc?.gstin ?? '', address: o.site_address ?? o.bill_to?.address ?? acc?.address ?? '' };
    return {
      doc: { quote: { ...o, bill_to: billTo, doc_date: o.order_date }, lines: d.lines, account: acc, contact: null, company: d.company },
      labels: {
        title: 'Order confirmation',
        numberLabel: 'Order #',
        number: o.order_number,
        party: 'Customer',
        rows: [
          ...(o.customer_ref ? ([["Your order / contract", `${o.customer_ref}${o.customer_ref_date ? ` dt. ${date(o.customer_ref_date)}` : ''}`]] as [string, string][]) : []),
          ...(o.expected_delivery_date ? ([['Delivery by', date(o.expected_delivery_date)]] as [string, string][]) : []),
        ],
      },
      back: `/o/sales_order/${o.id}`,
    };
  }
  if (kind === 'purchase_order') {
    const p = d.po;
    const v = d.vendor ?? {};
    return {
      doc: { quote: { ...p, bill_to: { name: v.name, address: [v.address, v.city].filter(Boolean).join(', '), state: v.state ?? '', gstin: v.gstin ?? '' }, doc_date: p.order_date }, lines: d.lines, account: null, contact: null, company: d.company },
      labels: {
        title: 'Purchase order',
        numberLabel: 'PO #',
        number: p.po_number,
        party: 'Vendor',
        rows: [...(p.expected_date ? ([['Deliver by', date(p.expected_date)]] as [string, string][]) : []), ...(v.payment_terms_days ? ([['Payment terms', `${v.payment_terms_days} days`]] as [string, string][]) : [])],
      },
      back: `/o/purchase_order/${p.id}`,
    };
  }
  if (kind === 'invoice') {
    const i = d.invoice;
    const cn = i.doc_type === 'credit_note';
    const billTo = { name: i.buyer_name ?? d.account?.name, address: i.buyer_address ?? [d.account?.address, d.account?.city].filter(Boolean).join(', '), state: i.place_of_supply ?? i.buyer_state ?? d.account?.state ?? '', gstin: i.buyer_gstin ?? d.account?.gstin ?? '' };
    const rows: [string, string][] = [];
    if (i.customer_ref) rows.push(["Buyer's order / contract", `${i.customer_ref}${i.customer_ref_date ? ` dt. ${date(i.customer_ref_date)}` : ''}`]);
    if (i.payment_terms && i.payment_terms !== 'custom' && !cn) rows.push(['Terms', TERMS[i.payment_terms] ?? String(i.payment_terms).replace(/_/g, ' ')]);
    if (i.due_date && !cn) rows.push(['Due date', date(i.due_date)]);
    if (i.place_of_supply) rows.push(['Place of supply', `${i.place_of_supply}${i.pos_code ? ` (${i.pos_code})` : ''}`]);
    if (i.reverse_charge) rows.push(['Reverse charge', 'Yes']);
    if (i.irn && !i.irn_cancelled_at) {
      if (!i.irn_qr) rows.push(['IRN', `${String(i.irn).slice(0, 20)}…`]);
      if (i.ack_no) rows.push(['Ack no. / date', `${i.ack_no}${i.ack_date ? ` · ${date(i.ack_date)}` : ''}`]);
    }
    if (i.ewb_no) rows.push(['E-way bill', `${i.ewb_no}${i.ewb_date ? ` · ${date(i.ewb_date)}` : ''}`]);
    // the letterhead's state must be the seller state snapshot so CGST/SGST vs IGST prints as issued
    const company = { ...d.company, state: i.seller_state ?? d.company.state, gstin: i.seller_gstin ?? d.company.gstin };
    // a subject that describes what is billed, not the customer's name (e.g. "Maintenance" or "Website, Hosting")
    const lineNames = [...new Set((d.lines as Json[]).map((l) => String(l.name ?? '').trim()).filter(Boolean))];
    const subject = (i.subject && String(i.subject).trim()) || (lineNames.length ? lineNames.slice(0, 3).join(', ') + (lineNames.length > 3 ? '…' : '') : cn ? 'Credit note' : 'Tax invoice');
    return {
      doc: { quote: { ...i, bill_to: billTo, doc_date: i.invoice_date, status: 'issued', valid_until: null, subject }, lines: d.lines, account: d.account, contact: null, company },
      labels: {
        title: cn ? 'Credit note' : i.doc_type === 'proforma' ? 'Proforma invoice' : i.status === 'draft' ? 'Tax invoice (draft)' : 'Tax invoice',
        numberLabel: cn ? 'Credit note #' : 'Invoice #',
        number: i.invoice_number ?? 'DRAFT',
        party: 'Bill to',
        rows,
        footerNote: [i.supply_type === 'intra' ? 'Supply within the state: CGST + SGST' : i.supply_type === 'inter' ? 'Inter-state supply: IGST' : '', d.bankDetails ? `\n${d.bankDetails}` : ''].join(''),
        upi: d.upi ?? null,
      },
      back: `/o/invoice/${i.id}`,
    };
  }
  if (kind === 'job_work') {
    // delivery challan for goods sent for job work (CGST rule 55; ITC-04 reports it)
    const j = d.jobWork;
    const v = d.vendor ?? {};
    const lines = (d.lines as Json[]).map((l) => {
      const taxable = Math.round(Number(l.sent_qty || l.quantity) * Number(l.unit_cost) * 100) / 100;
      // no tax is charged on goods sent for job work: the rate is shown, the value is the taxable value only
      return { name: l.product, hsnSac: l.hsn_sac, unit: l.unit, quantity: Number(l.sent_qty || l.quantity), unitPrice: Number(l.unit_cost), discountPct: 0, taxRate: Number(l.tax_rate ?? 0), lineSubtotal: taxable, lineTax: 0, lineTotal: taxable };
    });
    const subtotal = lines.reduce((s, l) => s + l.lineSubtotal, 0);
    const rows: [string, string][] = [['Purpose', 'Sent for job work (not a supply)']];
    if (j.process) rows.push(['Process', j.process]);
    if (j.expected_date) rows.push(['Expected back', date(j.expected_date)]);
    if (j.vehicle_number) rows.push(['Vehicle no.', j.vehicle_number]);
    return {
      doc: {
        quote: { ...j, bill_to: { name: v.name, address: [v.address, v.city].filter(Boolean).join(', '), state: v.state ?? '', gstin: v.gstin ?? '' }, doc_date: j.sent_date, subtotal, tax_total: 0, grand_total: subtotal, discount_total: 0, round_off: 0, status: 'issued', valid_until: null },
        lines,
        account: null,
        contact: null,
        company: d.company,
      },
      labels: { title: 'Delivery challan', numberLabel: 'Challan #', number: j.challan_number ?? 'Not sent yet', party: 'Job worker', rows, footerNote: `Goods sent under section 143 of the CGST Act for processing and return. No tax is charged; values are the taxable value of the goods.${j.challan_number ? '' : '\nDRAFT: not sent yet.'}` },
      back: `/o/job_work/${j.id}`,
    };
  }
  return null;
}

const shapeOrNull = (kind: string, data: Json | undefined) => (data ? shape(kind, data) : null);

export const SOURCES: Record<string, (id: string) => string> = {
  sales_order: (id) => `/api/v1/orders/${id}`,
  purchase_order: (id) => `/api/v1/purchase-orders/${id}`,
  invoice: (id) => `/api/v1/invoices/${id}`,
  job_work: (id) => `/api/v1/mfg/job-works/${id}`,
};

export function DocPrintPage() {
  const { kind = '', id = '' } = useParams();
  const src = SOURCES[kind];
  const { data, error } = useQuery({ queryKey: ['print', kind, id], queryFn: () => get<Json>(src!(id)), enabled: !!src });
  const signable = ['invoice', 'sales_order', 'purchase_order'].includes(kind);
  const sigs = useQuery({ queryKey: ['doc-signatures', kind, id], queryFn: () => get<Json[]>(`/api/v1/documents/${kind}/${id}/signatures`), enabled: signable, staleTime: 30_000 });
  const { me } = useAuth();
  const [tplId, setTplId] = useState<string>(() => new URLSearchParams(location.search).get('template') ?? '');
  const tplKind = ['invoice', 'sales_order', 'purchase_order'].includes(kind) ? kind : null;
  const tpl = useQuery({ queryKey: ['doc-template', tplKind, tplId], queryFn: () => get<DocTemplate | null>(`/api/v1/doc-templates/for/${tplKind}${tplId ? `?id=${tplId}` : ''}`), enabled: !!tplKind, staleTime: 60_000 });
  const tplList = useQuery({ queryKey: ['doc-templates'], queryFn: () => get<{ templates: Json[] }>('/api/v1/doc-templates'), enabled: !!tplKind, staleTime: 60_000 });
  const base = shapeOrNull(kind, data);
  const s = base && signable ? { ...base, labels: { ...base.labels, signatures: (sigs.data ?? []) as NonNullable<DocLabels['signatures']>, verifyBase: me?.tenant?.id ? `${location.origin}/verify/${me.tenant.id}` : null } } : base;
  useEffect(() => {
    if (s) document.title = `${s.labels.number ?? s.labels.title} — ${s.doc.quote.name}`;
  }, [s]);
  if (!src || error) return <p style={{ padding: 32 }}>This document is not available.</p>;
  if (!s) return <div style={{ padding: 32 }}><Spinner /></div>;
  return (
    <div className="print-page">
      <div className="print-bar no-print">
        <Link to={s.back}>← Back</Link>
        <span className="muted small">Tip: choose “Save as PDF” as the printer to download a PDF.</span>
        {tplKind && (tplList.data?.templates.length ?? 0) > 0 && (
          <select aria-label="Template" value={tplId} onChange={(e) => setTplId(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">Default template</option>
            {tplList.data!.templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>
      <TemplatedDocument doc={s.doc} labels={s.labels} template={tpl.data ?? null} />
      {kind === 'invoice' && data?.invoice?.irn_qr && <IrnQr qr={data.invoice.irn_qr} irn={data.invoice.irn} />}
    </div>
  );
}

/** The e-invoice's signed QR code from the IRP (rule 48(4)): verifiable with the GST "Verify QR" app. */
function IrnQr({ qr, irn }: { qr: string; irn: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'L');
    q.addData(qr);
    q.make();
    return q.createSvgTag({ cellSize: 2, margin: 1, scalable: true });
  }, [qr]);
  return (
    <div className="upi-qr">
      <div className="qr" role="img" aria-label="E-invoice QR code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div>
        <b>E-invoice (signed by the Invoice Registration Portal)</b>
        <div className="small" style={{ wordBreak: 'break-all' }}>IRN {irn}</div>
      </div>
    </div>
  );
}

/** Customer view of an invoice or order from a signed link (WhatsApp, email). No sign-in. */
export function PublicDocPage() {
  const { token = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['public-doc', token],
    queryFn: async () => {
      const r = await fetch(`/api/public/docs/${encodeURIComponent(token)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? 'This link is not valid');
      return j as { kind: string; data: Json };
    },
    retry: false,
  });
  const s = data ? shape(data.kind, data.data) : null;
  useEffect(() => {
    if (s) document.title = `${s.labels.number ?? s.labels.title} — ${s.doc.company?.name ?? ''}`;
  }, [s]);
  if (error) return <p style={{ padding: 32 }}>{(error as Error).message}</p>;
  if (!s || !data) return <div style={{ padding: 32 }}><Spinner /></div>;
  return (
    <div className="print-page">
      <div className="print-bar no-print">
        <span className="muted small">{s.doc.company?.name}</span>
        <div className="row">
          {data.data.payUrl && (
            <a className="btn primary" href={data.data.payUrl} target="_blank" rel="noopener noreferrer">
              Pay online
            </a>
          )}
          <button className="btn" onClick={() => window.print()}>
            Download PDF
          </button>
        </div>
      </div>
      <TemplatedDocument doc={s.doc} labels={{ ...s.labels, signatures: (data.data.signatures ?? []) as NonNullable<DocLabels['signatures']>, verifyBase: data.data.verifyBase ?? null }} template={data.data.template ?? null} />
      {data.kind === 'invoice' && data.data.invoice?.irn_qr && <IrnQr qr={data.data.invoice.irn_qr} irn={data.data.invoice.irn} />}
    </div>
  );
}
