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
export function QuoteDocument({ doc }: { doc: QuoteDoc }) {
  const { quote: q, lines, account, contact, company } = doc;
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
  return (
    <article className="qdoc">
      <header className="qdoc-head">
        <div>
          <h1>{company.name}</h1>
          {company.address && <p>{company.address}</p>}
          <p>
            {[company.phone, company.email, company.website].filter(Boolean).join(' · ')}
          </p>
          {company.gstin && <p>GSTIN: {company.gstin}{company.state ? ` · ${company.state}` : ''}</p>}
        </div>
        <div className="qdoc-title">
          <h2>Quotation</h2>
          <table>
            <tbody>
              <tr>
                <th>Quote #</th>
                <td>{q.quote_number ?? '—'}</td>
              </tr>
              <tr>
                <th>Date</th>
                <td>{date(q.created_at)}</td>
              </tr>
              {q.valid_until && (
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
          <h3>Bill to</h3>
          <b>{billTo.name || account?.name || contact?.name || '—'}</b>
          {(billTo.address || addr(account?.billing_address)) && <p>{billTo.address || addr(account?.billing_address)}</p>}
          {billTo.state && <p>State: {billTo.state}</p>}
          {billTo.gstin && <p>GSTIN: {billTo.gstin}</p>}
          {contact && <p>Attn: {contact.name}</p>}
        </div>
        <div>
          <h3>Subject</h3>
          <b>{q.name}</b>
        </div>
      </section>

      <table className="qdoc-lines">
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>HSN/SAC</th>
            <th className="num">Qty</th>
            <th className="num">Rate</th>
            <th className="num">Disc.</th>
            <th className="num">Taxable</th>
            <th className="num">GST</th>
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
              <td>{l.hsnSac ?? ''}</td>
              <td className="num">
                {l.quantity.toLocaleString('en-IN')} {l.unit ?? ''}
              </td>
              <td className="num">{money2(l.unitPrice, cur)}</td>
              <td className="num">{l.discountPct ? `${l.discountPct}%` : '—'}</td>
              <td className="num">{money2(l.lineSubtotal ?? 0, cur)}</td>
              <td className="num">{l.taxRate}%</td>
              <td className="num">{money2(l.lineTotal ?? 0, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <section className="qdoc-bottom">
        <div className="qdoc-gst">
          {lines.length > 0 && tax > 0 && (
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
          {cur === 'INR' && <p className="qdoc-words">{rupeesInWords(Number(q.grand_total ?? 0))}</p>}
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
            <tr className="grand">
              <th>Total</th>
              <td>{money2(q.grand_total, cur)}</td>
            </tr>
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
      <footer className="qdoc-sign">
        {q.status === 'accepted' && q.accepted_by ? (
          <p className="qdoc-accepted">
            Accepted by <b>{q.accepted_by}</b> on {date(q.accepted_at)}
          </p>
        ) : (
          <span />
        )}
        <div>
          <p>For {company.name}</p>
          <div className="qdoc-sigline">Authorised signatory</div>
        </div>
      </footer>
    </article>
  );
}
