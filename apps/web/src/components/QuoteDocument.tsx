import { date, money2, rupeesInWords } from '../lib/format';

export interface QuoteLine {
  id?: string;
  productId?: string | null;
  name: string;
  description?: string | null;
  hsnSac?: string | null;
  unit?: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  lineSubtotal?: number;
  lineTax?: number;
  lineTotal?: number;
}

export interface QuoteDoc {
  quote: Record<string, any>;
  lines: QuoteLine[];
  account: { name: string; billing_address?: Record<string, string> | string | null } | null;
  contact: { name: string; email?: string | null; phone?: string | null } | null;
  company: { name: string; address: string; state: string; gstin: string; email: string; phone: string; website: string };
}

const addr = (a: unknown): string => {
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') return Object.values(a as Record<string, string>).filter(Boolean).join(', ');
  return '';
};

/** True when supplier and customer are in the same state → CGST + SGST, else IGST. */
export function intraState(companyState: string, customerState?: string | null) {
  const n = (s?: string | null) => (s ?? '').trim().toLowerCase();
  return !!n(companyState) && !!n(customerState) && n(companyState) === n(customerState);
}

/** A4 quotation, GST-ready: HSN/SAC, CGST/SGST vs IGST split, amount in words. */
export interface DocLabels {
  title: string;
  numberLabel: string;
  number: string | null;
  /** extra header rows, e.g. [['Delivery by', '12 Nov 2026']] */
  rows?: [string, string][];
  party?: string;
  showValidity?: boolean;
  /** text printed under the totals (e.g. bank details on invoices) */
  footerNote?: string | null;
  /** saved signatures put on the document; each prints with a code anyone can check */
  signatures?: { signerName: string; designation: string | null; image: string; signedAt: string; verifyCode: string; valid: boolean; revoked?: boolean }[];
  /** where a signature code is checked */
  verifyBase?: string | null;
}

/** A document template (Settings → Document templates); null prints the classic design. */
export interface DocTemplate {
  id?: string;
  name?: string;
  base: 'classic' | 'modern' | 'compact' | 'gst_detailed' | 'letterhead' | 'html';
  settings: {
    accent: string;
    accent2: string;
    text: string;
    font: 'sans' | 'serif' | 'mono' | 'rounded' | 'condensed';
    fontSize: number;
    logo?: string | null;
    logoPosition: 'left' | 'right' | 'none';
    showCompany: boolean;
    showGstSummary: boolean;
    showWords: boolean;
    showBank: boolean;
    showSignature: boolean;
    showQr: boolean;
    columns: { hsn: boolean; qty: boolean; rate: boolean; discount: boolean; taxable: boolean; gst: boolean };
    labels: { title?: string | null; billTo?: string | null; subject?: string | null; total?: string | null };
    headerNote?: string | null;
    footerNote?: string | null;
    margins: { top: number; bottom: number; left: number; right: number };
  };
  letterhead?: string | null;
  html?: string | null;
}

export const FONTS: Record<DocTemplate['settings']['font'], string> = {
  sans: 'Inter, "Segoe UI", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"IBM Plex Mono", Consolas, monospace',
  rounded: 'Nunito, "Segoe UI", system-ui, sans-serif',
  condensed: '"Roboto Condensed", "Arial Narrow", sans-serif',
};

export function QuoteDocument({ doc, labels, template }: { doc: QuoteDoc; labels?: DocLabels; template?: DocTemplate | null }) {
  const { quote: q, lines, account, contact, company } = doc;
  const t = template && template.base !== 'html' ? template : null;
  const st = t?.settings;
  const col = st?.columns ?? { hsn: true, qty: true, rate: true, discount: true, taxable: true, gst: true };
  const detailed = t?.base === 'gst_detailed';
  const letterhead = t?.base === 'letterhead' && t.letterhead ? t.letterhead : null;
  const showCompany = st ? st.showCompany && !(letterhead && st.showCompany === undefined) : true;
  const cur = String(q.currency ?? 'INR');
  const billTo = (q.bill_to ?? {}) as Record<string, string>;
  const intra = intraState(company.state, billTo.state);
  const tax = Number(q.tax_total ?? 0);
  // tax per rate for the GST summary
  const byRate = new Map<number, { taxable: number; tax: number }>();
  for (const l of lines) {
    const r = byRate.get(l.taxRate) ?? { taxable: 0, tax: 0 };
    r.taxable += l.lineSubtotal ?? 0;
    r.tax += l.lineTax ?? 0;
    byRate.set(l.taxRate, r);
  }
  const style = st
    ? ({ '--acc': st.accent, '--acc2': st.accent2, '--txt': st.text, fontFamily: FONTS[st.font] ?? FONTS.sans, fontSize: `${st.fontSize}px`, color: st.text } as React.CSSProperties)
    : undefined;
  const logo = st?.logo && st.logoPosition !== 'none' ? <img className="qdoc-logo" src={st.logo} alt="" /> : null;
  const body = (
    <>
      {st?.headerNote && <p className="qdoc-headnote">{st.headerNote}</p>}
      <header className={`qdoc-head${showCompany ? '' : ' no-company'}`}>
        {showCompany ? (
        <div className={`qdoc-co${st?.logoPosition === 'right' ? ' logo-right' : ''}`}>
          {logo}
          <div>
          <h1>{company.name}</h1>
          {company.address && <p>{company.address}</p>}
          <p>
            {[company.phone, company.email, company.website].filter(Boolean).join(' · ')}
          </p>
          {company.gstin && <p>GSTIN: {company.gstin}{company.state ? ` · ${company.state}` : ''}</p>}
          </div>
        </div>
        ) : (
          <div>{company.gstin && <p className="small">GSTIN: {company.gstin}</p>}</div>
        )}
        <div className="qdoc-title">
          <h2>{st?.labels?.title || labels?.title || 'Quotation'}</h2>
          <table>
            <tbody>
              <tr>
                <th>{labels?.numberLabel ?? 'Quote #'}</th>
                <td>{(labels ? labels.number : q.quote_number) ?? '—'}</td>
              </tr>
              <tr>
                <th>Date</th>
                <td>{date(q.doc_date ?? q.created_at)}</td>
              </tr>
              {labels?.rows?.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td>{v}</td>
                </tr>
              ))}
              {(!labels || labels.showValidity) && q.valid_until && (
                <tr>
                  <th>Valid until</th>
                  <td>{date(q.valid_until)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </header>

      <section className="qdoc-parties">
        <div>
          <h3>{(labels?.party === 'Bill to' && st?.labels?.billTo) || labels?.party || 'Bill to'}</h3>
          <b>{billTo.name || account?.name || contact?.name || '—'}</b>
          {(billTo.address || addr(account?.billing_address)) && <p>{billTo.address || addr(account?.billing_address)}</p>}
          {billTo.state && <p>State: {billTo.state}</p>}
          {billTo.gstin && <p>GSTIN: {billTo.gstin}</p>}
          {contact && <p>Attn: {contact.name}</p>}
        </div>
        <div>
          <h3>{st?.labels?.subject || 'Subject'}</h3>
          <b>{q.subject || q.name}</b>
        </div>
      </section>

      <table className="qdoc-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            {col.hsn && <th>HSN/SAC</th>}
            {col.qty && <th className="num">Qty</th>}
            {col.rate && <th className="num">Rate</th>}
            {col.discount && <th className="num">Disc.</th>}
            {col.taxable && <th className="num">Taxable</th>}
            {col.gst && <th className="num">GST</th>}
            {detailed && (intra ? (<><th className="num">CGST</th><th className="num">SGST</th></>) : <th className="num">IGST</th>)}
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={l.id ?? i}>
              <td>{i + 1}</td>
              <td>
                <b>{l.name}</b>
                {l.description && <div className="qdoc-desc">{l.description}</div>}
              </td>
              {col.hsn && <td>{l.hsnSac ?? ''}</td>}
              {col.qty && (
                <td className="num">
                  {Number(l.quantity).toLocaleString('en-IN')} {l.unit ?? ''}
                </td>
              )}
              {col.rate && <td className="num">{money2(l.unitPrice, cur)}</td>}
              {col.discount && <td className="num">{l.discountPct ? `${l.discountPct}%` : '—'}</td>}
              {col.taxable && <td className="num">{money2(l.lineSubtotal ?? 0, cur)}</td>}
              {col.gst && <td className="num">{l.taxRate}%</td>}
              {detailed &&
                (intra ? (
                  <>
                    <td className="num">{money2((l.lineTax ?? 0) / 2, cur)}</td>
                    <td className="num">{money2((l.lineTax ?? 0) / 2, cur)}</td>
                  </>
                ) : (
                  <td className="num">{money2(l.lineTax ?? 0, cur)}</td>
                ))}
              <td className="num">{money2(l.lineTotal ?? 0, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="qdoc-bottom">
        <div className="qdoc-gst">
          {lines.length > 0 && tax > 0 && (st?.showGstSummary ?? true) && (
            <table>
              <thead>
                <tr>
                  <th>GST rate</th>
                  <th className="num">Taxable</th>
                  {intra ? (
                    <>
                      <th className="num">CGST</th>
                      <th className="num">SGST</th>
                    </>
                  ) : (
                    <th className="num">IGST</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {[...byRate.entries()]
                  .filter(([, v]) => v.tax > 0)
                  .map(([rate, v]) => (
                    <tr key={rate}>
                      <td>{rate}%</td>
                      <td className="num">{money2(v.taxable, cur)}</td>
                      {intra ? (
                        <>
                          <td className="num">{money2(v.tax / 2, cur)}</td>
                          <td className="num">{money2(v.tax / 2, cur)}</td>
                        </>
                      ) : (
                        <td className="num">{money2(v.tax, cur)}</td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
          {cur === 'INR' && (st?.showWords ?? true) && <p className="qdoc-words">{rupeesInWords(Number(q.grand_total ?? 0))}</p>}
          {labels?.footerNote && (st?.showBank ?? true) && <p className="qdoc-desc" style={{ whiteSpace: 'pre-wrap' }}>{labels.footerNote}</p>}
        </div>
        <table className="qdoc-totals">
          <tbody>
            <tr>
              <th>Subtotal</th>
              <td>{money2(q.subtotal, cur)}</td>
            </tr>
            {Number(q.discount_total) > 0 && (
              <tr>
                <th>Discount</th>
                <td>− {money2(q.discount_total, cur)}</td>
              </tr>
            )}
            {intra ? (
              <>
                <tr>
                  <th>CGST</th>
                  <td>{money2(tax / 2, cur)}</td>
                </tr>
                <tr>
                  <th>SGST</th>
                  <td>{money2(tax / 2, cur)}</td>
                </tr>
              </>
            ) : (
              <tr>
                <th>{billTo.state || company.state ? 'IGST' : 'GST'}</th>
                <td>{money2(tax, cur)}</td>
              </tr>
            )}
            {Number(q.round_off ?? 0) !== 0 && (
              <tr>
                <th>Round off</th>
                <td>{money2(q.round_off, cur)}</td>
              </tr>
            )}
            <tr className="grand">
              <th>{st?.labels?.total || 'Total'}</th>
              <td>{money2(q.grand_total, cur)}</td>
            </tr>
            {!!q.tax_inclusive && (
              <tr>
                <td colSpan={2} className="muted small" style={{ textAlign: 'right' }}>
                  Prices include GST
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {q.notes && (
        <section className="qdoc-note">
          <h3>Notes</h3>
          <p>{q.notes}</p>
        </section>
      )}
      {q.terms && (
        <section className="qdoc-note">
          <h3>Terms &amp; conditions</h3>
          <p>{q.terms}</p>
        </section>
      )}
      {(st?.showSignature ?? true) && <footer className="qdoc-sign">
        {q.status === 'accepted' && q.accepted_by ? (
          <p className="qdoc-accepted">
            Accepted by <b>{q.accepted_by}</b> on {date(q.accepted_at)}
          </p>
        ) : (
          <span />
        )}
        <div style={{ display: 'flex', gap: 24, alignItems: 'flex-end' }}>
          {(labels?.signatures ?? []).filter((s) => !s.revoked).length ? (
            (labels?.signatures ?? [])
              .filter((s) => !s.revoked)
              .map((s) => (
                <div key={s.verifyCode} className="qdoc-signed" style={{ maxWidth: 320 }}>
                  <p>For {company.name}</p>
                  <img src={s.image} alt={`Signature of ${s.signerName}`} style={{ height: 48, maxWidth: 170, objectFit: 'contain', display: 'block' }} />
                  <div className="qdoc-sigline">
                    {s.signerName}
                    {s.designation ? `, ${s.designation}` : ''}
                  </div>
                  <p className="small" style={{ margin: 0 }}>
                    Digitally signed {new Date(s.signedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}
                  </p>
                  <p className="small" style={{ margin: 0 }}>
                    Verify: {labels?.verifyBase ? `${labels.verifyBase}/${s.verifyCode}` : s.verifyCode}
                  </p>
                </div>
              ))
          ) : (
            <div>
              <p>For {company.name}</p>
              <div className="qdoc-sigline">Authorised signatory</div>
            </div>
          )}
        </div>
      </footer>}
      {st?.footerNote && <p className="qdoc-footnote">{st.footerNote}</p>}
    </>
  );
  const cls = `qdoc t-${t?.base ?? 'classic'}${letterhead ? ' has-lh' : ''}`;
  if (!letterhead) return <article className={cls} style={style}>{body}</article>;
  const m = st!.margins;
  return (
    <article className={cls} style={{ ...style, paddingLeft: `${m.left}mm`, paddingRight: `${m.right}mm` }}>
      <style>{`@media print { @page { size: A4; margin: 0 } .qdoc.has-lh { padding: 0 ${m.right}mm 0 ${m.left}mm !important } }`}</style>
      <img className="qdoc-lh" src={letterhead} alt="" />
      {/* the header and footer space repeat on every printed page, clear of the letterhead artwork */}
      <table className="qdoc-lh-wrap">
        <thead>
          <tr>
            <td style={{ height: `${m.top}mm` }} />
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td style={{ height: `${m.bottom}mm` }} />
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td>{body}</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
