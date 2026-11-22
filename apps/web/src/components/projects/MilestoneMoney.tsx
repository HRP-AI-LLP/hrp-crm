/**
 * A milestone's invoice and money. SanchalanOS looks for the invoice already raised (by value, by the
 * number named in the milestone's emails, or as a PDF in its kept mail) and for the money received
 * (open receipts, bank credits not yet booked). Nothing is linked or booked until it is approved here;
 * any other receipts or bank lines can be found and added too.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

export function MilestoneMoney({ projectId, milestoneId, onClose }: { projectId: string; milestoneId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<Record<string, Json>>({});
  const [touched, setTouched] = useState(false);
  const base = `/api/v1/projects/${projectId}/milestones/${milestoneId}/billing`;
  const { data, refetch, isFetching } = useQuery({ queryKey: ['ms-billing', milestoneId, term], queryFn: () => get<Json>(`${base}${term ? `?q=${encodeURIComponent(term)}` : ''}`) });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      setPick({});
      setTouched(false);
      await refetch();
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  if (!data) return (
    <Modal title="Invoice & payments" onClose={onClose} wide>
      <div className="modal-body">
        <Spinner />
      </div>
    </Modal>
  );
  const inv = data.invoice as Json | null;
  // the likeliest money is ticked until the person changes anything
  const suggested: Record<string, Json> = {};
  if (inv && !touched && inv.balance_due > 0) {
    let left = inv.balance_due;
    for (const r of data.receipts as Json[]) if (r.suggested && left > 0) (suggested[`r:${r.id}`] = { kind: 'receipt', id: r.id }), (left -= r.unallocated);
    for (const b of data.bankLines as Json[]) if (b.score >= 6 && left > 0 && !q) (suggested[`b:${b.id}`] = { kind: 'bank', id: b.id, tdsAmount: b.suggestedTds || 0 }), (left -= b.amount + (b.suggestedTds || 0));
  }
  const chosen = touched ? pick : suggested;
  const toggle = (key: string, item: Json) => {
    const next = { ...chosen };
    if (next[key]) delete next[key];
    else next[key] = item;
    setPick(next);
    setTouched(true);
  };
  const setTds = (key: string, v: string) => {
    if (!chosen[key]) return;
    setPick({ ...chosen, [key]: { ...chosen[key], tdsAmount: Number(v) || 0 } });
    setTouched(true);
  };
  const total = Object.entries(chosen).reduce((s, [k, it]) => {
    if (it.kind === 'receipt') return s + Number((data.receipts as Json[]).find((r) => `r:${r.id}` === k)?.unallocated ?? 0);
    const b = (data.bankLines as Json[]).find((x) => `b:${x.id}` === k);
    return s + Number(b?.amount ?? 0) + Number(it.tdsAmount ?? 0);
  }, 0);
  return (
    <Modal title={`${data.milestone.name}: invoice & payments`} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="small muted">Milestone value {money2(data.milestone.amount)} (before GST){data.milestone.dueDate ? ` · due ${date(data.milestone.dueDate)}` : ''}</div>

        {/* ── the invoice ── */}
        {inv ? (
          <div className="panel spread" style={{ padding: 10, gap: 8 }}>
            <div className="small">
              <b>Invoice {inv.invoice_number ?? '(draft)'}</b> · {date(inv.invoice_date)} · {inv.account ?? ''}
              <div className="muted">
                Total {money2(inv.grand_total)} · paid {money2(inv.amount_paid)} · <b>{inv.balance_due > 0 ? `${money2(inv.balance_due)} due` : 'fully paid'}</b>
              </div>
            </div>
            <div className="row" style={{ gap: 6 }}>
              <Link className="btn sm ghost" to={`/o/invoice/${inv.id}`}>
                Open
              </Link>
              <button className="btn sm ghost" disabled={busy} onClick={() => run(() => post(`${base}/unlink`), 'Invoice unlinked from the milestone')}>
                Unlink
              </button>
            </div>
          </div>
        ) : (
          <>
            <h3 style={{ margin: 0 }}>Is this the invoice?</h3>
            {!(data.candidates as Json[]).length && !(data.pdfs as Json[]).length && (
              <p className="small muted" style={{ margin: 0 }}>
                No invoice in the books matches this milestone. Keep its mail thread here (Milestones → Find the mail thread) so the invoice number or PDF in it can be found, or create the invoice from Billing.
              </p>
            )}
            {(data.candidates as Json[]).map((c) => (
              <div key={c.id} className="panel spread" style={{ padding: 10, gap: 8, borderColor: c.id === data.best ? 'var(--accent)' : undefined }}>
                <div className="small" style={{ minWidth: 0 }}>
                  <b>{c.invoice_number ?? '(draft)'}</b> · {date(c.invoice_date)} · {c.account ?? ''} {c.id === data.best && <span className="chip good">likely</span>}
                  <div className="muted">
                    Value {money2(c.taxable_total)} · total {money2(c.grand_total)} · {c.balance_due > 0 ? `${money2(c.balance_due)} due` : 'paid'} · {c.status.replace(/_/g, ' ')}
                  </div>
                  <div className="muted">Why: {(c.reasons as string[]).join('; ')}</div>
                </div>
                <button className="btn sm primary" disabled={busy} onClick={() => run(() => post(`${base}/link`, { invoiceId: c.id }), `Invoice ${c.invoice_number ?? ''} linked to ${data.milestone.name}`)}>
                  Approve & link
                </button>
              </div>
            ))}
            {(data.pdfs as Json[]).map((f) => (
              <div key={f.file_id} className="panel spread" style={{ padding: 10, gap: 8 }}>
                <div className="small">
                  📎 <b>{f.name}</b>
                  <div className="muted">In the milestone's mail, not in the books yet. Importing reads it as your invoice to the customer, adds it to the books and links it here.</div>
                </div>
                <button
                  className="btn sm primary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const r = await post<Json>(`${base}/import`, { fileId: f.file_id });
                      if (!r.ok) throw new Error(`${r.error ?? 'Could not import it'} — finish it in Books → Import documents`);
                    }, 'Invoice imported and linked')
                  }
                >
                  {busy ? 'Reading…' : 'Import & link'}
                </button>
              </div>
            ))}
          </>
        )}

        {/* ── the money ── */}
        {(inv || data.target) && (
          <>
            <div className="spread">
              <h3 style={{ margin: 0 }}>Money received{inv ? '' : ` (for ${data.target.number ?? 'the likely invoice'}, once linked)`}</h3>
            </div>
            {(data.applied as Json[]).length > 0 && (
              <table className="data">
                <tbody>
                  {(data.applied as Json[]).map((p) => (
                    <tr key={p.id}>
                      <td>
                        <span className="chip good">applied</span>
                      </td>
                      <td>{date(p.date)}</td>
                      <td>
                        Receipt {p.number ?? ''} <span className="muted small">{p.reference ?? ''}</span>
                      </td>
                      <td className="num">{money2(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {inv && inv.balance_due > 0 && (
              <>
                <div className="row" style={{ gap: 6 }}>
                  <input placeholder="Find other bank lines: words in the narration, or an exact amount" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setTerm(q.trim())} />
                  <button className="btn sm" onClick={() => setTerm(q.trim())}>
                    Search
                  </button>
                  {term && (
                    <button className="btn sm ghost" onClick={() => (setQ(''), setTerm(''))}>
                      Clear
                    </button>
                  )}
                </div>
                {isFetching && <Spinner />}
                {!(data.receipts as Json[]).length && !(data.bankLines as Json[]).length && <p className="small muted" style={{ margin: 0 }}>No open receipt or unbooked bank credit fits yet. Import the bank statement in Books → Banking, or search above.</p>}
                <table className="data">
                  <tbody>
                    {(data.receipts as Json[]).map((r) => (
                      <tr key={r.id}>
                        <td style={{ width: 30 }}>
                          <input type="checkbox" checked={!!chosen[`r:${r.id}`]} onChange={() => toggle(`r:${r.id}`, { kind: 'receipt', id: r.id })} aria-label="Apply" />
                        </td>
                        <td>{date(r.date)}</td>
                        <td>
                          Receipt {r.number ?? ''} (not applied yet) <span className="muted small">{r.reference ?? ''}</span>
                        </td>
                        <td />
                        <td className="num">{money2(r.unallocated)}</td>
                      </tr>
                    ))}
                    {(data.bankLines as Json[]).map((b) => {
                      const key = `b:${b.id}`;
                      return (
                        <tr key={b.id}>
                          <td style={{ width: 30 }}>
                            <input type="checkbox" disabled={!data.canBook} checked={!!chosen[key]} onChange={() => toggle(key, { kind: 'bank', id: b.id, tdsAmount: b.suggestedTds || 0 })} aria-label="Book against the invoice" />
                          </td>
                          <td>{date(b.date)}</td>
                          <td className="small">
                            {b.description}
                            <div className="muted">
                              {b.bank}
                              {(b.reasons as string[]).length ? ` · ${(b.reasons as string[]).join('; ')}` : ''}
                            </div>
                          </td>
                          <td style={{ width: 130 }}>
                            {chosen[key] && (
                              <label className="small">
                                TDS kept ₹
                                <input inputMode="decimal" value={chosen[key].tdsAmount ?? 0} onChange={(e) => setTds(key, e.target.value)} style={{ width: 90 }} />
                              </label>
                            )}
                          </td>
                          <td className="num">{money2(b.amount)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!data.canBook && (data.bankLines as Json[]).length > 0 && <p className="small muted" style={{ margin: 0 }}>Booking bank lines needs the books permission.</p>}
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <button
                    className="btn primary"
                    disabled={busy || !Object.keys(chosen).length}
                    onClick={() =>
                      run(async () => {
                        const r = await post<Json>(`${base}/map`, { items: Object.values(chosen) });
                        const bad = (r.results as Json[]).filter((x) => !x.ok);
                        if (bad.length) throw new Error(bad.map((x) => x.error).join('; '));
                      }, 'Payments mapped to the invoice')
                    }
                  >
                    Approve & map {Object.keys(chosen).length || ''}
                  </button>
                  {Object.keys(chosen).length > 0 && (
                    <span className="small muted">
                      {money2(total)} against {money2(inv.balance_due)} due
                    </span>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
