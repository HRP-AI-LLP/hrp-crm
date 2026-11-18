import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, get, post, put } from '../lib/api';
import { money2 } from '../lib/format';
import { EmailComposer } from './EmailComposer';
import type { QuoteDoc, QuoteLine } from './QuoteDocument';
import { intraState } from './QuoteDocument';
import { useToast } from './ui';

interface PriceBook {
  id: string;
  name: string;
  currency: string;
  is_default: boolean;
  is_active: boolean;
}
interface Entry {
  product_id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  tax_rate: number;
  hsn_sac: string | null;
  list_price: number | null;
  unit_price: number | null;
  is_active: boolean;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Same arithmetic as the API (discount per line, then GST on the discounted amount). */
/** Same arithmetic as the server; `taxInclusive`: prices already include GST. */
export function computeLines(lines: QuoteLine[], taxInclusive = false) {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const out = lines.map((l) => {
    const gross = r2((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0));
    const disc = r2((gross * (Number(l.discountPct) || 0)) / 100);
    const net = r2(gross - disc);
    if (taxInclusive) {
      const k = 1 + (Number(l.taxRate) || 0) / 100;
      const taxable = r2(net / k);
      const grossEx = r2(gross / k);
      const t = r2(net - taxable);
      subtotal += grossEx;
      discount += r2(grossEx - taxable);
      tax += t;
      return { ...l, lineSubtotal: taxable, lineTax: t, lineTotal: net };
    }
    const t = r2((net * (Number(l.taxRate) || 0)) / 100);
    subtotal += gross;
    discount += disc;
    tax += t;
    return { ...l, lineSubtotal: net, lineTax: t, lineTotal: r2(net + t) };
  });
  return { lines: out, subtotal: r2(subtotal), discountTotal: r2(discount), taxTotal: r2(tax), grandTotal: r2(subtotal - discount + tax) };
}

const blank = (): QuoteLine => ({ name: '', quantity: 1, unitPrice: 0, discountPct: 0, taxRate: 18 });

/** Line-item editor shown on quote records. */
export function QuoteEditor({ quoteId, canEdit }: { quoteId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['quote', quoteId], queryFn: () => get<QuoteDoc>(`/api/v1/quotes/${quoteId}`) });
  const books = useQuery({ queryKey: ['price-books'], queryFn: () => get<{ items: PriceBook[] }>('/api/v1/price-books'), staleTime: 60_000 });
  const [lines, setLines] = useState<QuoteLine[]>([]);
  const [bookId, setBookId] = useState<string>('');
  const [billTo, setBillTo] = useState<Record<string, string>>({});
  const [inclusive, setInclusive] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const entries = useQuery({ queryKey: ['price-book-entries', bookId], queryFn: () => get<{ items: Entry[] }>(`/api/v1/price-books/${bookId}/entries`), enabled: !!bookId, staleTime: 60_000 });

  useEffect(() => {
    if (!data) return;
    setLines(data.lines.length ? data.lines : []);
    setBookId(String(data.quote.price_book_id ?? books.data?.items.find((b) => b.is_default)?.id ?? ''));
    setBillTo((data.quote.bill_to as Record<string, string>) ?? {});
    setInclusive(!!data.quote.tax_inclusive);
    setDirty(false);
  }, [data, books.data]);

  const calc = useMemo(() => computeLines(lines, inclusive), [lines, inclusive]);
  if (!data) return null;
  const q = data.quote;
  const locked = (q.status !== 'draft' && q.status !== 'rfq') || !canEdit;
  const cur = String(q.currency ?? 'INR');
  const intra = intraState(data.company.state, billTo.state);

  const edit = (i: number, patch: Partial<QuoteLine>) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const pickProduct = (i: number, productId: string) => {
    const e = entries.data?.items.find((x) => x.product_id === productId);
    if (!e) return edit(i, { productId: null });
    edit(i, { productId, name: e.name, unit: e.unit, hsnSac: e.hsn_sac, taxRate: e.tax_rate, unitPrice: e.unit_price ?? e.list_price ?? 0 });
  };

  const save = async () => {
    setBusy(true);
    try {
      const clean = lines.filter((l) => l.name.trim());
      const r = await put<QuoteDoc>(`/api/v1/quotes/${quoteId}/lines`, {
        lines: clean.map((l) => ({ productId: l.productId ?? null, name: l.name.trim(), description: l.description || null, hsnSac: l.hsnSac || null, unit: l.unit || null, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), discountPct: Number(l.discountPct) || 0, taxRate: Number(l.taxRate) || 0 })),
        priceBookId: bookId || null,
        billTo,
        taxInclusive: inclusive,
      });
      qc.setQueryData(['quote', quoteId], r);
      qc.invalidateQueries({ queryKey: ['record', 'quote', quoteId] });
      qc.invalidateQueries({ queryKey: ['records', 'quote'] });
      toast('Quote saved');
      setDirty(false);
    } catch (e) {
      toast(e instanceof ApiError ? (e.details?.[0] ? `${e.details[0].path ?? ''} ${e.details[0].message}` : e.message) : 'Could not save', true);
    } finally {
      setBusy(false);
    }
  };

  const link = q.share_token && q.status !== 'draft' ? `${location.origin}/q/${q.share_token}` : null;

  return (
    <section className="panel quote-editor">
      <div className="panel-head">
        <h2>Line items</h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn sm" href={`/print/quote/${quoteId}`} target="_blank" rel="noreferrer">
            Preview / PDF
          </a>
          {link && (
            <button
              className="btn sm"
              onClick={async () => {
                await navigator.clipboard?.writeText(link).catch(() => undefined);
                toast('Customer link copied');
              }}
            >
              Copy customer link
            </button>
          )}
          {q.deal_id && canEdit && (
            <button
              className="btn sm"
              onClick={async () => {
                try {
                  await post(`/api/v1/quotes/${quoteId}/sync-deal`);
                  toast('Deal amount updated to the quote total');
                  qc.invalidateQueries({ queryKey: ['record', 'deal', q.deal_id] });
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Update deal amount
            </button>
          )}
          {canEdit && ['sent', 'rejected', 'expired'].includes(String(q.status)) && (
            <button
              className="btn sm"
              title="Copy this quote into a new draft revision; this one is marked superseded"
              onClick={async () => {
                if (!window.confirm('Create a new revision? The customer link of this version stops working.')) return;
                try {
                  const r = await post<{ id: string }>(`/api/v1/quotes/${quoteId}/revise`);
                  toast('New revision created');
                  qc.invalidateQueries({ queryKey: ['records', 'quote'] });
                  nav(`/o/quote/${r.id}`);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Create revision
            </button>
          )}
          {canEdit && !['accepted', 'superseded'].includes(String(q.status)) && (
            <button
              className="btn sm primary"
              disabled={dirty || !data.lines.length || ['required', 'pending', 'rejected'].includes(String(q.approval_status))}
              title={dirty ? 'Save your changes first' : !data.lines.length ? 'Add lines first' : ['required', 'pending', 'rejected'].includes(String(q.approval_status)) ? 'Needs approval first' : undefined}
              onClick={() => setSending(true)}
            >
              {q.status === 'draft' ? 'Send to customer' : 'Send again'}
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {q.status === 'accepted' && <div className="notice">Accepted by {String(q.accepted_by ?? 'the customer')} — the lines are locked.</div>}
        {canEdit && ['sent', 'rejected', 'expired'].includes(String(q.status)) && <div className="notice small">This version went to the customer, so its lines are locked. Use “Create revision” to change prices or items.</div>}
        {q.status === 'superseded' && <div className="notice small">A newer revision replaced this version.</div>}
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="field" style={{ minWidth: 200 }}>
            Price book
            <select value={bookId} disabled={locked} onChange={(e) => { setBookId(e.target.value); setDirty(true); }}>
              <option value="">No price book (type prices)</option>
              {books.data?.items
                .filter((b) => b.is_active)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 160 }}>
            Customer state (for GST)
            <input value={billTo.state ?? ''} disabled={locked} onChange={(e) => { setBillTo({ ...billTo, state: e.target.value }); setDirty(true); }} placeholder="e.g. Karnataka" list="in-states" />
          </label>
          <label className="field" style={{ minWidth: 190 }}>
            Customer GSTIN
            <input value={billTo.gstin ?? ''} disabled={locked} onChange={(e) => { setBillTo({ ...billTo, gstin: e.target.value.toUpperCase() }); setDirty(true); }} maxLength={15} className="mono" />
          </label>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            Billing address (optional)
            <input value={billTo.address ?? ''} disabled={locked} onChange={(e) => { setBillTo({ ...billTo, address: e.target.value }); setDirty(true); }} />
          </label>
        </div>
        {(!locked || inclusive) && (
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" disabled={locked} checked={inclusive} onChange={(e) => { setInclusive(e.target.checked); setDirty(true); }} />
            Prices include GST
            {inclusive && <span className="muted">— the rate is what the customer pays; the taxable value is worked back from it</span>}
          </label>
        )}
        <datalist id="in-states">
          {IN_STATES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="table-wrap">
          <table className="data qlines">
            <thead>
              <tr>
                <th style={{ width: 28 }}>#</th>
                <th style={{ minWidth: 220 }}>Product / description</th>
                <th style={{ width: 90 }}>HSN/SAC</th>
                <th style={{ width: 80 }} className="num">Qty</th>
                <th style={{ width: 120 }} className="num">Rate</th>
                <th style={{ width: 72 }} className="num">Disc %</th>
                <th style={{ width: 72 }} className="num">GST %</th>
                <th style={{ width: 120 }} className="num">Amount</th>
                <th style={{ width: 70 }} />
              </tr>
            </thead>
            <tbody>
              {calc.lines.map((l, i) => (
                <tr key={i}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    {bookId && !locked && (
                      <select aria-label={`Product for line ${i + 1}`} value={l.productId ?? ''} onChange={(e) => pickProduct(i, e.target.value)}>
                        <option value="">Custom item</option>
                        {entries.data?.items
                          .filter((e) => e.is_active || e.product_id === l.productId)
                          .map((e) => (
                            <option key={e.product_id} value={e.product_id}>
                              {e.name}
                              {e.sku ? ` (${e.sku})` : ''}
                              {e.unit_price === null ? ' — not in this price book' : ''}
                            </option>
                          ))}
                      </select>
                    )}
                    <input aria-label={`Item name, line ${i + 1}`} value={l.name} disabled={locked} onChange={(e) => edit(i, { name: e.target.value })} placeholder="Item name" />
                    <input aria-label={`Description, line ${i + 1}`} className="small" value={l.description ?? ''} disabled={locked} onChange={(e) => edit(i, { description: e.target.value })} placeholder="Description (optional)" />
                  </td>
                  <td>
                    <input aria-label={`HSN/SAC, line ${i + 1}`} value={l.hsnSac ?? ''} disabled={locked} onChange={(e) => edit(i, { hsnSac: e.target.value })} />
                  </td>
                  <td>
                    <input aria-label={`Quantity, line ${i + 1}`} className="num" inputMode="decimal" value={l.quantity} disabled={locked} onChange={(e) => edit(i, { quantity: e.target.value as unknown as number })} />
                  </td>
                  <td>
                    <input aria-label={`Rate, line ${i + 1}`} className="num" inputMode="decimal" value={l.unitPrice} disabled={locked} onChange={(e) => edit(i, { unitPrice: e.target.value as unknown as number })} />
                  </td>
                  <td>
                    <input aria-label={`Discount, line ${i + 1}`} className="num" inputMode="decimal" value={l.discountPct} disabled={locked} onChange={(e) => edit(i, { discountPct: e.target.value as unknown as number })} />
                  </td>
                  <td>
                    <select aria-label={`GST, line ${i + 1}`} value={String(l.taxRate)} disabled={locked} onChange={(e) => edit(i, { taxRate: Number(e.target.value) })}>
                      {[...new Set([0, 5, 12, 18, 28, Number(l.taxRate)])].sort((a, b) => a - b).map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num">
                    <b>{money2(l.lineTotal, cur)}</b>
                  </td>
                  <td>
                    {!locked && (
                      <span className="row" style={{ gap: 0 }}>
                        <button className="btn ghost sm" aria-label={`Move line ${i + 1} up`} onClick={() => { setLines((ls) => { if (!i) return ls; const n = [...ls]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; return n; }); setDirty(true); }}>
                          ↑
                        </button>
                        <button className="btn ghost sm" aria-label={`Remove line ${i + 1}`} onClick={() => { setLines((ls) => ls.filter((_, j) => j !== i)); setDirty(true); }}>
                          ✕
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          {!locked ? (
            <div className="row">
              <button className="btn" onClick={() => { setLines((ls) => [...ls, blank()]); setDirty(true); }}>
                Add line
              </button>
              <button className="btn primary" disabled={!dirty || busy} onClick={save}>
                {busy ? 'Saving…' : dirty ? 'Save quote' : 'Saved'}
              </button>
            </div>
          ) : (
            <span />
          )}
          <table className="qtotals">
            <tbody>
              <tr>
                <th>Subtotal</th>
                <td>{money2(calc.subtotal, cur)}</td>
              </tr>
              {calc.discountTotal > 0 && (
                <tr>
                  <th>Discount</th>
                  <td>− {money2(calc.discountTotal, cur)}</td>
                </tr>
              )}
              <tr>
                <th>{intra ? 'CGST + SGST' : billTo.state ? 'IGST' : 'GST'}</th>
                <td>{money2(calc.taxTotal, cur)}</td>
              </tr>
              <tr className="grand">
                <th>Total</th>
                <td>{money2(calc.grandTotal, cur)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      {sending && (
        <EmailComposer
          object="quote"
          recordId={quoteId}
          templateName="Quote sent"
          sendLabel="Send quote"
          onClose={() => setSending(false)}
          onSend={async (m) => {
            const r = await post<{ link: string; emailed: boolean }>(`/api/v1/quotes/${quoteId}/send`, m ?? {});
            qc.invalidateQueries({ queryKey: ['quote', quoteId] });
            qc.invalidateQueries({ queryKey: ['record', 'quote', quoteId] });
            qc.invalidateQueries({ queryKey: ['timeline', 'quote', quoteId] });
            await navigator.clipboard?.writeText(r.link).catch(() => undefined);
            toast(r.emailed ? 'Quote emailed — link copied too' : 'Quote marked as sent — customer link copied');
          }}
        />
      )}
    </section>
  );
}

const IN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala',
  'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];
export { IN_STATES };
