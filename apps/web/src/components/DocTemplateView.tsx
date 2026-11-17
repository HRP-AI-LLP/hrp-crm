/**
 * A document in its template: the built-in designs and letterheads through QuoteDocument, HTML templates
 * through Mustache placeholders. HTML templates are sanitised (no scripts, handlers or frames) and drawn
 * in a shadow root so their CSS stays inside the document.
 */
import DOMPurify from 'dompurify';
import Mustache from 'mustache';
import { useEffect, useMemo, useRef } from 'react';
import { date, money2, rupeesInWords } from '../lib/format';
import { type DocLabels, type DocTemplate, intraState, QuoteDocument, type QuoteDoc } from './QuoteDocument';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What an HTML template's placeholders read. */
export function templateView(doc: QuoteDoc, labels?: DocLabels, template?: DocTemplate | null) {
  const { quote: q, lines, company } = doc;
  const cur = String(q.currency ?? 'INR');
  const billTo = (q.bill_to ?? {}) as Record<string, string>;
  const intra = intraState(company.state, billTo.state);
  const tax = Number(q.tax_total ?? 0);
  const rows = Object.fromEntries(labels?.rows ?? []);
  const sigs = (labels?.signatures ?? []).filter((s) => !s.revoked);
  const signatures_html = sigs.length
    ? sigs
        .map(
          (s) =>
            `<div class="sig"><div>For ${esc(company.name)}</div>${s.image ? `<img src="${esc(s.image)}" alt="" style="height:48px;max-width:170px;object-fit:contain;display:block">` : ''}<div class="sig-name">${esc(s.signerName)}${s.designation ? `, ${esc(s.designation)}` : ''}</div><div class="sig-meta">Digitally signed ${esc(new Date(s.signedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }))}</div><div class="sig-meta">Verify: ${esc(labels?.verifyBase ? `${labels.verifyBase}/${s.verifyCode}` : s.verifyCode)}</div></div>`,
        )
        .join('')
    : `<div class="sig"><div>For ${esc(company.name)}</div><div style="margin-top:36px;border-top:1px solid #94a3b8">Authorised signatory</div></div>`;
  return {
    company: { ...company, logo_img: template?.settings.logo ? `<img src="${esc(template.settings.logo)}" alt="" style="max-height:64px;max-width:160px">` : '' },
    doc: {
      title: template?.settings.labels?.title || labels?.title || 'Tax invoice',
      number: (labels ? labels.number : q.quote_number) ?? '',
      date: date(q.doc_date ?? q.created_at),
      due_date: rows['Due date'] ?? '',
      subject: q.subject || q.name || '',
      place_of_supply: rows['Place of supply'] ?? billTo.state ?? '',
      reference: rows["Buyer's order / contract"] ?? '',
      terms_label: rows.Terms ?? '',
      rows: (labels?.rows ?? []).map(([k, v]) => ({ label: k, value: v })),
    },
    bill_to: { name: billTo.name || doc.account?.name || '', address: billTo.address || '', state: billTo.state || '', gstin: billTo.gstin || '' },
    lines: lines.map((l, i) => ({
      n: i + 1,
      name: l.name,
      description: l.description ?? '',
      hsn: l.hsnSac ?? '',
      qty: Number(l.quantity).toLocaleString('en-IN'),
      unit: l.unit ?? '',
      rate: money2(l.unitPrice, cur),
      discount: l.discountPct ? `${l.discountPct}%` : '',
      taxable: money2(l.lineSubtotal ?? 0, cur),
      gst_rate: `${l.taxRate}%`,
      gst: money2(l.lineTax ?? 0, cur),
      amount: money2(l.lineTotal ?? 0, cur),
    })),
    totals: {
      subtotal: money2(q.subtotal, cur),
      discount: Number(q.discount_total) > 0 ? money2(q.discount_total, cur) : '',
      cgst: intra ? money2(tax / 2, cur) : '',
      sgst: intra ? money2(tax / 2, cur) : '',
      igst: intra ? '' : money2(tax, cur),
      tax: money2(tax, cur),
      round_off: Number(q.round_off ?? 0) ? money2(q.round_off, cur) : '',
      total: money2(q.grand_total, cur),
      in_words: cur === 'INR' ? rupeesInWords(Number(q.grand_total ?? 0)) : '',
      intra,
      tax_inclusive: !!q.tax_inclusive,
    },
    notes: q.notes ?? '',
    terms: q.terms ?? '',
    bank_details: labels?.footerNote ?? '',
    signatures_html,
    qr_html: '',
  };
}

export function renderHtmlTemplate(html: string, view: ReturnType<typeof templateView>) {
  const out = Mustache.render(html, view);
  return DOMPurify.sanitize(out, { ADD_TAGS: ['style'], FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'base'], FORCE_BODY: true });
}

function HtmlDocument({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>:host{display:block;background:#fff;color:#0f172a;font-family:Inter,"Segoe UI",Arial,sans-serif;font-size:12.5px;padding:12mm}</style>${html}`;
  }, [html]);
  return <div ref={ref} className="qdoc-html" />;
}

export function TemplatedDocument({ doc, labels, template }: { doc: QuoteDoc; labels?: DocLabels; template?: DocTemplate | null }) {
  const html = useMemo(() => (template?.base === 'html' && template.html ? renderHtmlTemplate(template.html, templateView(doc, labels, template)) : null), [doc, labels, template]);
  if (html != null) return <HtmlDocument html={html} />;
  return <QuoteDocument doc={doc} labels={labels} template={template} />;
}
