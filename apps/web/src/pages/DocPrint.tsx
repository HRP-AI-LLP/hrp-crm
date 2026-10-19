import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import qrcode from 'qrcode-generator';
import { Link, useParams } from 'react-router-dom';
import { type DocLabels, QuoteDocument, type QuoteDoc } from '../components/QuoteDocument';
import { Spinner } from '../components/ui';
import { get } from '../lib/api';
import { date } from '../lib/format';

type Json = Record<string, any>;

/** Builds the printable document (shared A4 layout) for orders, purchase orders and invoices. */
function shape(kind: string, d: Json): { doc: QuoteDoc; labels: DocLabels; back: string } | null {
  if (kind === 'sales_order') {
    const o = d.order;
    const acc = d.account;
    const billTo = { ...(o.bill_to ?? {}), name: acc?.name ?? o.bill_to?.name, state: o.bill_to?.state ?? acc?.state ?? '', gstin: o.bill_to?.gstin ?? acc?.gstin ?? '', address: o.site_address ?? o.bill_to?.address ?? acc?.address ?? '' };
    return {
      doc: { quote: { ...o, bill_to: billTo, doc_date: o.order_date }, lines: d.lines, account: acc, contact: null, company: d.company },
      labels: { title: 'Order confirmation', numberLabel: 'Order #', number: o.order_number, party: 'Customer', rows: o.expected_delivery_date ? [['Delivery by', date(o.expected_delivery_date)]] : [] },
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
    if (i.due_date && !cn) rows.push(['Due date', date(i.due_date)]);
    if (i.place_of_supply) rows.push(['Place of supply', `${i.place_of_supply}${i.pos_code ? ` (${i.pos_code})` : ''}`]);
    if (i.reverse_charge) rows.push(['Reverse charge', 'Yes']);
    if (i.irn) rows.push(['IRN', `${String(i.irn).slice(0, 20)}…`]);
    // the letterhead's state must be the seller state snapshot so CGST/SGST vs IGST prints as issued
    const company = { ...d.company, state: i.seller_state ?? d.company.state, gstin: i.seller_gstin ?? d.company.gstin };
    return {
      doc: { quote: { ...i, bill_to: billTo, doc_date: i.invoice_date, status: 'issued', valid_until: null }, lines: d.lines, account: d.account, contact: null, company },
      labels: {
        title: cn ? 'Credit note' : i.doc_type === 'proforma' ? 'Proforma invoice' : i.status === 'draft' ? 'Tax invoice (draft)' : 'Tax invoice',
        numberLabel: cn ? 'Credit note #' : 'Invoice #',
        number: i.invoice_number ?? 'DRAFT',
        party: 'Bill to',
        rows,
        footerNote: [i.supply_type === 'intra' ? 'Supply within the state: CGST + SGST' : i.supply_type === 'inter' ? 'Inter-state supply: IGST' : '', d.bankDetails ? `\n${d.bankDetails}` : ''].join(''),
      },
      back: `/o/invoice/${i.id}`,
    };
  }
  return null;
}

const SOURCES: Record<string, (id: string) => string> = {
  sales_order: (id) => `/api/v1/orders/${id}`,
  purchase_order: (id) => `/api/v1/purchase-orders/${id}`,
  invoice: (id) => `/api/v1/invoices/${id}`,
};

export function DocPrintPage() {
  const { kind = '', id = '' } = useParams();
  const src = SOURCES[kind];
  const { data, error } = useQuery({ queryKey: ['print', kind, id], queryFn: () => get<Json>(src!(id)), enabled: !!src });
  const s = data ? shape(kind, data) : null;
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
        <button className="btn primary" onClick={() => window.print()}>
          Print / Save PDF
        </button>
      </div>
      <QuoteDocument doc={s.doc} labels={s.labels} />
      {kind === 'invoice' && data?.upi && <UpiQr upi={data.upi} />}
    </div>
  );
}

/** Pay-by-UPI QR for the balance (built locally; scanned by any UPI app). */
function UpiQr({ upi }: { upi: { vpa: string; payee: string; amount: number; note: string } }) {
  const link = `upi://pay?${new URLSearchParams({ pa: upi.vpa, pn: upi.payee.slice(0, 50), am: upi.amount.toFixed(2), cu: 'INR', tn: upi.note.slice(0, 50) })}`;
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(link);
    q.make();
    return q.createSvgTag({ cellSize: 3, margin: 1, scalable: true });
  }, [link]);
  return (
    <div className="upi-qr">
      <div className="qr" role="img" aria-label="UPI payment QR code" dangerouslySetInnerHTML={{ __html: svg }} />
      <div>
        <b>Scan to pay ₹{upi.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })} with any UPI app</b>
        <div className="small">
          {upi.payee} · {upi.vpa}
        </div>
        <div className="small muted">Reference: {upi.note}</div>
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
      <QuoteDocument doc={s.doc} labels={s.labels} />
      {data.kind === 'invoice' && data.data.upi && <UpiQr upi={data.data.upi} />}
    </div>
  );
}
