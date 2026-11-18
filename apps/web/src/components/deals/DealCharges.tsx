/**
 * Deal → Charges & billing, in the deal's currency: one-time, hourly (rate × estimated hours) and recurring charges (each priced before or including GST), the
 * deal's value from them, and — once won — setting up the project, the invoice for the one-time charges
 * and the recurring invoices; then the invoices raised for the deal and price changes on its recurring
 * invoices.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCIES } from '@synapse/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { Empty, Modal, useToast } from '../ui';

type Json = Record<string, any>;
interface Charge {
  kind: 'one_time' | 'recurring' | 'hourly';
  name: string;
  hsnSac: string | null;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxInclusive: boolean;
  frequency: 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | null;
  startDate: string | null;
  periods: number | null;
}
const FREQ: Record<string, string> = { monthly: 'Monthly', quarterly: 'Quarterly', half_yearly: 'Half-yearly', yearly: 'Yearly' };
const blank = (kind: Charge['kind']): Charge => ({ kind, name: '', hsnSac: '', quantity: 1, unitPrice: 0, taxRate: 18, taxInclusive: false, frequency: kind === 'recurring' ? 'monthly' : null, startDate: null, periods: null });
const r2 = (n: number) => Math.round(n * 100) / 100;
const taxable = (c: Charge) => r2(c.taxInclusive ? (c.quantity * c.unitPrice) / (1 + c.taxRate / 100) : c.quantity * c.unitPrice);

export function DealCharges({ dealId, canEdit }: { dealId: string; canEdit: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['deal-charges', dealId], queryFn: () => get<Json>(`/api/v1/deals/${dealId}/charges`) });
  const [rows, setRows] = useState<Charge[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [change, setChange] = useState<Json | null>(null);
  const [currency, setCurrency] = useState('INR');
  useEffect(() => {
    if (q.data) {
      setRows(q.data.charges);
      setCurrency(q.data.currency ?? 'INR');
      setDirty(false);
    }
  }, [q.data]);
  const m = (n: unknown) => money2(n, currency);
  if (q.isLoading || !q.data) return null;
  const d = q.data;
  const locked = !canEdit || !!d.setup;
  const edit = (i: number, p: Partial<Charge>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['deal-charges', dealId] });
    qc.invalidateQueries({ queryKey: ['record', 'deal', dealId] });
  };
  const save = async () => {
    setBusy(true);
    try {
      await put(`/api/v1/deals/${dealId}/charges`, { currency, charges: rows.filter((r) => r.name.trim()).map((r) => ({ ...r, hsnSac: r.hsnSac || null, quantity: Number(r.quantity), unitPrice: Number(r.unitPrice), taxRate: Number(r.taxRate), periods: r.periods ? Number(r.periods) : null, startDate: r.startDate || null })) });
      toast('Charges saved; the deal amount follows them');
      refresh();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const oneTime = r2(rows.filter((r) => r.kind === 'one_time').reduce((a, r) => a + taxable(r), 0));
  const months = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 } as const;
  const hourly = r2(rows.filter((r) => r.kind === 'hourly').reduce((a, r) => a + taxable(r), 0));
  const hours = r2(rows.filter((r) => r.kind === 'hourly').reduce((a, r) => a + Number(r.quantity || 0), 0));
  const monthly = r2(rows.filter((r) => r.kind === 'recurring').reduce((a, r) => a + taxable(r) / months[r.frequency ?? 'monthly'], 0));

  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>Charges &amp; billing</h2>
        <div className="row">
          {locked ? (
            <span className="chip">{currency}</span>
          ) : (
            <label className="row small" style={{ gap: 6 }}>
              Currency
              <select
                aria-label="Currency"
                style={{ width: 'auto' }}
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setDirty(true);
                }}
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
          )}
          {!d.setup && d.won && rows.length > 0 && canEdit && !dirty && (
            <button className="btn primary sm" onClick={() => setSetup(true)}>
              Set up billing
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {!rows.length && locked ? (
          <Empty title="No charges">A deal's one-time and recurring charges set its value and its invoices.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Charge</th>
                  <th style={{ width: 90 }}>SAC/HSN</th>
                  <th style={{ width: 80 }} className="num">
                    Qty / hours
                  </th>
                  <th style={{ width: 130 }} className="num">
                    Price / rate ({currency})
                  </th>
                  <th style={{ width: 80 }}>GST %</th>
                  <th style={{ width: 110 }}>Price is</th>
                  <th style={{ width: 210 }}>Billed</th>
                  {!locked && <th style={{ width: 40 }} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{locked ? <b>{r.name}</b> : <input aria-label="Charge" value={r.name} placeholder={r.kind === 'recurring' ? 'e.g. Monthly maintenance' : r.kind === 'hourly' ? 'e.g. Development (per hour)' : 'e.g. Website development'} onChange={(e) => edit(i, { name: e.target.value })} />}</td>
                    <td>{locked ? r.hsnSac || '—' : <input aria-label="SAC" value={r.hsnSac ?? ''} onChange={(e) => edit(i, { hsnSac: e.target.value })} />}</td>
                    <td className="num">{locked ? `${r.quantity}${r.kind === 'hourly' ? ' h' : ''}` : <input className="num" aria-label={r.kind === 'hourly' ? 'Hours (estimate)' : 'Quantity'} title={r.kind === 'hourly' ? 'Hours (estimate)' : undefined} value={r.quantity} onChange={(e) => edit(i, { quantity: e.target.value as unknown as number })} />}</td>
                     <td className="num">{locked ? `${m(r.unitPrice)}${r.kind === 'hourly' ? '/h' : ''}` : <input className="num" aria-label={r.kind === 'hourly' ? 'Rate per hour' : 'Price'} value={r.unitPrice} onChange={(e) => edit(i, { unitPrice: e.target.value as unknown as number })} />}</td>
                    <td>
                      {locked ? (
                        `${r.taxRate}%`
                      ) : (
                        <select aria-label="GST rate" value={String(r.taxRate)} onChange={(e) => edit(i, { taxRate: Number(e.target.value) })}>
                          {[0, 5, 12, 18, 28].map((x) => (
                            <option key={x} value={x}>
                              {x}%
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td>
                      {locked ? (
                        r.taxInclusive ? 'incl. GST' : '+ GST'
                      ) : (
                        <select aria-label="Price includes GST" value={r.taxInclusive ? 'in' : 'ex'} onChange={(e) => edit(i, { taxInclusive: e.target.value === 'in' })}>
                          <option value="ex">+ GST</option>
                          <option value="in">incl. GST</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {r.kind === 'one_time' ? (
                        'Once'
                      ) : r.kind === 'hourly' ? (
                        <span className="small">Per hour, from approved timesheets</span>
                      ) : locked ? (
                        <span className="small">
                          {FREQ[r.frequency ?? 'monthly']}
                          {r.startDate ? ` from ${date(r.startDate)}` : ''}
                          {r.periods ? `, ${r.periods} times` : ', until stopped'}
                        </span>
                      ) : (
                        <div className="stack" style={{ gap: 4 }}>
                          <select aria-label="How often" value={r.frequency ?? 'monthly'} onChange={(e) => edit(i, { frequency: e.target.value as Charge['frequency'] })}>
                            {Object.entries(FREQ).map(([k, l]) => (
                              <option key={k} value={k}>
                                {l}
                              </option>
                            ))}
                          </select>
                          <input type="date" aria-label="First invoice on" title="First invoice on (default: the 1st of next month)" value={r.startDate ?? ''} onChange={(e) => edit(i, { startDate: e.target.value || null })} />
                          <input className="num" aria-label="Times" placeholder="Times (empty: until stopped)" value={r.periods ?? ''} onChange={(e) => edit(i, { periods: e.target.value ? (e.target.value as unknown as number) : null })} />
                        </div>
                      )}
                    </td>
                    {!locked && (
                      <td>
                        <button className="btn ghost sm" aria-label="Remove charge" onClick={() => { setRows((rs) => rs.filter((_, j) => j !== i)); setDirty(true); }}>
                          ✕
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
          {!locked ? (
            <div className="row">
              <button className="btn sm" onClick={() => { setRows((rs) => [...rs, blank('one_time')]); setDirty(true); }}>
                + One-time charge
              </button>
              <button className="btn sm" onClick={() => { setRows((rs) => [...rs, blank('hourly')]); setDirty(true); }}>
                + Hourly charge
              </button>
              <button className="btn sm" onClick={() => { setRows((rs) => [...rs, blank('recurring')]); setDirty(true); }}>
                + Recurring charge
              </button>
              <button className="btn primary sm" disabled={!dirty || busy} onClick={save}>
                {busy ? 'Saving…' : dirty ? 'Save charges' : 'Saved'}
              </button>
            </div>
          ) : (
            <span className="muted small">{d.setup ? `Billing set up on ${date(d.setup.at)}.` : ''}</span>
          )}
          <div className="row small" style={{ gap: 16 }}>
            <span>
              One-time <b>{m(oneTime)}</b>
            </span>
            {hourly > 0 && (
              <span>
                Hourly <b>{m(hourly)}</b> ({hours} h estimated)
              </span>
            )}
            <span>
              Recurring <b>{m(monthly)}</b>/month
            </span>
            <span className="muted">before GST</span>
          </div>
        </div>
        {!d.setup && rows.length > 0 && !d.won && <p className="muted small" style={{ margin: 0 }}>When the deal is won, “Set up billing” creates the project, the invoice for the one-time charges and the recurring invoices.</p>}

        {d.setup && (
          <>
            {d.setup.projects.map((p: Json) => (
              <div key={p.id} className="small">
                Project: <Link to={`/o/project/${p.id}`}>{p.name}</Link>
              </div>
            ))}
            {d.setup.profiles.map((p: Json) => (
              <div key={p.id} className="row small" style={{ gap: 10, flexWrap: 'wrap' }}>
                <span>
                  🔁 <b>{p.name}</b> · {FREQ[p.frequency]} · next {date(p.next_date)} · {p.runs} raised · {p.status}
                  {p.auto_issue ? ' · issued automatically' : ' · left as drafts'}
                </span>
                {(p.changes ?? []).map((c: Json) => (
                  <span key={c.from} className="chip">
                    from {date(c.from)}: {money2(c.lines.reduce((a: number, l: Json) => a + l.quantity * l.unitPrice, 0))} {c.taxInclusive ? 'incl. GST' : '+ GST'}
                  </span>
                ))}
                {canEdit && (
                  <button className="btn ghost sm" onClick={() => setChange(p)}>
                    Change price from…
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {d.invoices.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Status</th>
                  <th className="num">Total</th>
                  <th className="num">Due</th>
                </tr>
              </thead>
              <tbody>
                {d.invoices.map((i: Json) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/o/invoice/${i.id}`}>{i.invoice_number ?? 'Draft'}</Link>
                      {i.recurring_profile_id && <span className="muted small"> · recurring</span>}
                    </td>
                    <td>{date(i.invoice_date)}</td>
                    <td>{i.status.replace(/_/g, ' ')}</td>
                    <td className="num">{m(i.grand_total)}</td>
                    <td className="num">{m(i.balance_due)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {setup && <SetupModal dealId={dealId} charges={rows} onClose={() => setSetup(false)} onDone={refresh} />}
      {change && <PriceChange profile={change} onClose={() => setChange(null)} onDone={refresh} />}
    </section>
  );
}

function SetupModal({ dealId, charges, onClose, onDone }: { dealId: string; charges: Charge[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ project: true, oneTimeInvoice: true, autoIssue: true });
  const [busy, setBusy] = useState(false);
  const oneTime = charges.filter((c) => c.kind === 'one_time');
  const rec = charges.filter((c) => c.kind === 'recurring');
  return (
    <Modal
      title="Set up billing for this deal"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<Json>(`/api/v1/deals/${dealId}/setup-billing`, f);
                toast(`Set up: ${[r.projectId && 'project', r.invoiceId && 'draft invoice', r.profileIds.length && `${r.profileIds.length} recurring invoice(s)`].filter(Boolean).join(', ')}`);
                onDone();
                onClose();
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Setting up…' : 'Set up'}
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.project} onChange={(e) => setF({ ...f, project: e.target.checked })} />
          {charges.some((c) => c.kind === 'hourly') ? 'A project billed by the hour (from approved timesheets) at the deal’s rate' : 'A fixed-price project for the work'}
        </label>
        {oneTime.length > 0 && (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={f.oneTimeInvoice} onChange={(e) => setF({ ...f, oneTimeInvoice: e.target.checked })} />A draft invoice for the one-time charges ({oneTime.map((c) => c.name).join(', ')}) to check and issue
          </label>
        )}
        {rec.length > 0 && (
          <>
            <div className="small">
              Recurring invoices:{' '}
              {rec.map((c) => `${c.name} — ${money2(c.unitPrice)} ${c.taxInclusive ? 'incl. GST' : '+ GST'}, ${(FREQ[c.frequency ?? 'monthly'] ?? '').toLowerCase()} from ${c.startDate ? date(c.startDate) : 'the 1st of next month'}`).join('; ')}
            </div>
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={f.autoIssue} onChange={(e) => setF({ ...f, autoIssue: e.target.checked })} />
              Issue each recurring invoice when it is created (numbered, in the books, signed if billing signs invoices). Off: they wait as drafts.
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}

function PriceChange({ profile, onClose, onDone }: { profile: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const tl = (profile.template?.lines ?? []) as Json[];
  const nextMonth = (() => {
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 1)).toISOString().slice(0, 10);
  })();
  const [f, setF] = useState({ effectiveFrom: nextMonth, taxInclusive: true, note: '', lines: (tl.length ? tl : [{ name: profile.name, quantity: 1, unitPrice: 0, taxRate: 18 }]).map((l) => ({ ...l })) });
  return (
    <Modal
      title={`Change the price of “${profile.name}”`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await post(`/api/v1/recurring-invoices/${profile.id}/price-changes`, { ...f, note: f.note || null, lines: f.lines.map((l) => ({ ...l, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice), taxRate: Number(l.taxRate) })) });
                toast('Price change saved');
                onDone();
                onClose();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <label className="field">
          From (invoices for this date onward)
          <input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
        </label>
        {f.lines.map((l, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input style={{ flex: 1 }} aria-label="Item" value={l.name} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <input className="num" style={{ width: 120 }} aria-label="New price" value={l.unitPrice} onChange={(e) => setF({ ...f, lines: f.lines.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)) })} />
            <span className="small">{l.taxRate}% GST</span>
          </div>
        ))}
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={f.taxInclusive} onChange={(e) => setF({ ...f, taxInclusive: e.target.checked })} />
          The new price includes GST
        </label>
        <label className="field">
          Note (optional)
          <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Reduced as agreed in May" />
        </label>
      </div>
    </Modal>
  );
}
