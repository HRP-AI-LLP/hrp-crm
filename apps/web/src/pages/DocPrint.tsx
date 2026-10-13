import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
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
  return null;
}

const SOURCES: Record<string, (id: string) => string> = {
  sales_order: (id) => `/api/v1/orders/${id}`,
  purchase_order: (id) => `/api/v1/purchase-orders/${id}`,
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
    </div>
  );
}
