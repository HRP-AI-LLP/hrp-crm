/**
 * A project's billing: the accounts module's billing, for this project only — its invoices (and its
 * milestones' invoices), receipts with the TDS the customer kept, vendor bills booked to it and what
 * was paid on them, GST out and in, the bank lines the accounts desk matched to them (applied by
 * itself when sure), and approved time and expenses not yet billed. The same invoices, payments,
 * bills and vendor payments as in Billing and Books.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { PaymentModal } from '../ops/BillingPanels';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
type Section = 'overview' | 'invoices' | 'receipts' | 'bills' | 'bank' | 'unbilled';

const INV_STATUS: Record<string, string> = { draft: '', issued: 'info', sent: 'info', partially_paid: 'warn', paid: 'good', overdue: 'bad', cancelled: '', void: '' };
const MODE: Record<string, string> = { bank_transfer: 'Bank transfer', neft: 'NEFT', rtgs: 'RTGS', imps: 'IMPS', upi: 'UPI', cheque: 'Cheque', cash: 'Cash', card: 'Card', gateway: 'Payment gateway', other: 'Other' };
const AUTONOMY: Record<string, string> = {
  suggest: 'Bank lines are matched and wait for a person to approve.',
  auto_sure: 'Sure matches from the bank (amount, party and reference agree) are applied by themselves; the rest wait here.',
  auto_all: 'Every match above the desk’s confidence is applied by itself.',
};

export function ProjectBilling({ id, unbilled }: { id: string; unbilled: ReactNode }) {
  const key = ['project', id, 'billing'];
  const { data, refetch } = useQuery({ queryKey: key, queryFn: () => get<Json>(`/api/v1/projects/${id}/billing`) });
  const [sec, setSec] = useState<Section>('overview');
  const [pay, setPay] = useState<Json | null>(null);
  const [newBill, setNewBill] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const s = data.sales as Json;
  const pu = data.purchases as Json;
  const g = data.gst as Json;
  const pending = (data.bank as Json[]).filter((b) => b.status === 'pending');
  const newInvoice = async () => {
    try {
      const r = await post<Json>(`/api/v1/projects/${id}/billing/new`, { kind: 'invoice' });
      nav(`/o/invoice/${r.id}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const refresh = () => {
    refetch();
    qc.invalidateQueries({ queryKey: ['project', id] });
  };
  const tabs: [Section, string, number | null][] = [
    ['overview', 'Overview', null],
    ['invoices', 'Invoices', (data.invoices as Json[]).length],
    ['receipts', 'Payments received', (data.receipts as Json[]).length],
    ['bills', 'Bills & payments made', (data.bills as Json[]).length],
    ['bank', 'Bank matches', pending.length || null],
    ['unbilled', 'Unbilled time & expenses', null],
  ];
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {tabs.map(([k, l, n]) => (
            <button key={k} type="button" className={`chip-btn ${sec === k ? 'on' : ''}`} onClick={() => setSec(k)}>
              {l}
              {n ? ` ${n}` : ''}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn sm primary" onClick={newInvoice} disabled={!data.project.accountId} title={data.project.accountId ? 'A draft invoice for the project’s customer, booked to the project' : 'Set the project’s customer first (Edit details)'}>
            + New invoice
          </button>
          <button className="btn sm" onClick={() => setNewBill(true)}>
            + New bill
          </button>
        </div>
      </div>

      {sec === 'overview' && (
        <>
          <div className="kpis" style={{ margin: 0 }}>
            <Kpi l="Invoiced (before GST)" v={s.taxable} sub={`${s.invoices} invoice${s.invoices === 1 ? '' : 's'}${s.drafts ? ` · ${s.drafts} draft` : ''} · with GST ${money2(s.total)}`} />
            <Kpi l="Received" v={s.received} sub={s.tds || s.gstTds ? `incl. TDS ${money2(s.tds)}${s.gstTds ? ` · GST TDS ${money2(s.gstTds)}` : ''} kept by the customer` : undefined} />
            <Kpi l="Outstanding" v={s.outstanding} tone={s.overdue > 0 ? 'bad' : undefined} sub={s.overdue > 0 ? `${money2(s.overdue)} overdue` : 'nothing overdue'} />
            <Kpi l="Bills (before GST)" v={pu.taxable} sub={`${pu.bills} bill${pu.bills === 1 ? '' : 's'} · paid ${money2(pu.paid)} · to pay ${money2(pu.payable)}`} />
          </div>
          <section className="panel">
            <div className="panel-head">
              <h2>GST on this project</h2>
              <Link className="btn sm ghost" to="/billing">
                GST returns →
              </Link>
            </div>
            <table className="data">
              <tbody>
                <tr>
                  <td>Output GST on invoices</td>
                  <td className="small muted">CGST {money2(s.cgst)} · SGST {money2(s.sgst)} · IGST {money2(s.igst)}</td>
                  <td className="num">{money2(g.output)}</td>
                </tr>
                <tr>
                  <td>Input tax credit on bills</td>
                  <td className="small muted">eligible GST on vendor bills booked to the project{pu.gst !== pu.itc ? ` (of ${money2(pu.gst)} charged)` : ''}</td>
                  <td className="num">− {money2(g.input)}</td>
                </tr>
                {g.gstTdsCredit > 0 && (
                  <tr>
                    <td>GST TDS credit</td>
                    <td className="small muted">deposited by the government buyer (section 51) — claimed in the GST cash ledger</td>
                    <td className="num">− {money2(g.gstTdsCredit)}</td>
                  </tr>
                )}
                <tr>
                  <td>
                    <b>Net GST from this project</b>
                  </td>
                  <td className="small muted">indicative — the return is filed for the whole GSTIN</td>
                  <td className="num">
                    <b>{money2(g.net)}</b>
                  </td>
                </tr>
                {s.tds > 0 && (
                  <tr>
                    <td>Income-tax TDS deducted by the customer</td>
                    <td className="small muted">claimed against advance tax once it shows in Form 26AS</td>
                    <td className="num">{money2(s.tds)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
          <BankNote data={data} onChanged={refresh} open={() => setSec('bank')} />
        </>
      )}

      {sec === 'invoices' &&
        (!(data.invoices as Json[]).length ? (
          <Empty title="No invoices yet">Raise one here, from a milestone (Milestones), or from approved time (Unbilled time & expenses).</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Due</th>
                  <th className="num">Before GST</th>
                  <th className="num">GST</th>
                  <th className="num">Total</th>
                  <th className="num">Balance</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(data.invoices as Json[]).map((i) => {
                  const overdue = i.due_date && i.due_date < data.today && Number(i.balance) > 0.5 && !['draft', 'cancelled'].includes(i.status);
                  return (
                    <tr key={i.id}>
                      <td>
                        <Link to={`/o/invoice/${i.id}`}>{i.invoice_number ?? 'Draft'}</Link>
                        {i.doc_type === 'credit_note' && <span className="chip" style={{ marginLeft: 6 }}>credit note</span>}
                        <div className="small muted">{[i.customer, i.milestone ? `milestone: ${i.milestone}` : null, i.e_invoiced ? 'e-invoice' : null].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td>{i.invoice_date ? date(i.invoice_date) : '—'}</td>
                      <td className={overdue ? 'bad-text' : ''}>{i.due_date ? date(i.due_date) : '—'}</td>
                      <td className="num">{money2(i.taxable)}</td>
                      <td className="num" title={`CGST ${money2(i.cgst)} · SGST ${money2(i.sgst)} · IGST ${money2(i.igst)}`}>
                        {money2(i.tax)}
                      </td>
                      <td className="num">{money2(i.total)}</td>
                      <td className="num">{Number(i.balance) > 0.5 ? <b>{money2(i.balance)}</b> : '—'}</td>
                      <td>
                        <span className={`chip ${overdue ? 'bad' : (INV_STATUS[i.status] ?? '')}`}>{overdue ? 'overdue' : String(i.status).replace('_', ' ')}</span>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {Number(i.balance) > 0.5 && !['draft', 'cancelled'].includes(i.status) && i.doc_type !== 'credit_note' && (
                          <button className="btn sm" onClick={() => setPay(i)}>
                            Record payment
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}

      {sec === 'receipts' &&
        (!(data.receipts as Json[]).length ? (
          <Empty title="No payments received yet">Record one on an invoice, or let the accounts desk find it in the bank statement.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Date</th>
                  <th>How</th>
                  <th>Against</th>
                  <th className="num">Settles</th>
                  <th className="num">TDS kept</th>
                  <th className="num">GST TDS</th>
                  <th className="num">For this project</th>
                </tr>
              </thead>
              <tbody>
                {(data.receipts as Json[]).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/o/payment/${p.id}`}>{p.payment_number ?? 'Receipt'}</Link>
                      {p.from_bank && (
                        <span className="chip info" style={{ marginLeft: 6 }} title="Found in the bank statement by the accounts desk">
                          from the bank
                        </span>
                      )}
                      {p.reference && <div className="small muted">{p.reference}</div>}
                    </td>
                    <td>{date(p.date)}</td>
                    <td className="small">{MODE[p.mode] ?? p.mode ?? '—'}</td>
                    <td className="small">{p.invoices}</td>
                    <td className="num">{money2(p.amount)}</td>
                    <td className="num">{p.tds ? money2(p.tds) : '—'}</td>
                    <td className="num">{p.gst_tds ? money2(p.gst_tds) : '—'}</td>
                    <td className="num">{money2(p.to_project)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {sec === 'bills' && (
        <>
          {!(data.bills as Json[]).length ? (
            <Empty title="No bills booked to this project">Add one here, or put a bill (or some of its lines) on the project in Books — Match & reconcile suggests them.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Date</th>
                    <th className="num">Before GST</th>
                    <th className="num">GST</th>
                    <th className="num">Paid</th>
                    <th className="num">To pay</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.bills as Json[]).map((b) => (
                    <tr key={b.id}>
                      <td>
                        <Link to={`/o/bill/${b.id}`}>{b.number ?? 'Draft bill'}</Link>
                        <div className="small muted">
                          {[b.vendor, b.whole ? null : 'some lines on this project', b.itc_eligible === false ? 'no input credit' : null, b.reverse_charge ? 'reverse charge' : null].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td>{b.date ? date(b.date) : '—'}</td>
                      <td className="num">{money2(b.taxable ?? 0)}</td>
                      <td className="num">{money2(Number(b.cgst ?? 0) + Number(b.sgst ?? 0) + Number(b.igst ?? 0))}</td>
                      <td className="num">{b.whole ? money2(b.paid) : '—'}</td>
                      <td className="num">{b.whole && Number(b.balance) > 0.5 ? <b>{money2(b.balance)}</b> : '—'}</td>
                      <td>
                        <span className={`chip ${b.status === 'paid' ? 'good' : b.status === 'draft' ? '' : Number(b.balance) > 0.5 ? 'warn' : ''}`}>{String(b.status).replace('_', ' ')}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3 style={{ margin: '8px 0 0' }}>Payments made</h3>
          {!(data.paymentsOut as Json[]).length ? (
            <p className="small muted" style={{ margin: 0 }}>None yet. Pay a bill from its page, or let the accounts desk find the payment in the bank statement.</p>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Date</th>
                  <th>To</th>
                  <th>For</th>
                  <th className="num">For this project</th>
                </tr>
              </thead>
              <tbody>
                {(data.paymentsOut as Json[]).map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/o/vendor_payment/${p.id}`}>{p.payment_number ?? 'Payment'}</Link>
                      {p.from_bank && (
                        <span className="chip info" style={{ marginLeft: 6 }}>
                          from the bank
                        </span>
                      )}
                    </td>
                    <td>{date(p.date)}</td>
                    <td>{p.vendor}</td>
                    <td className="small">{p.bills}</td>
                    <td className="num">{money2(p.to_project)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {sec === 'bank' && <BankMatches data={data} onChanged={refresh} />}
      {sec === 'unbilled' && unbilled}

      {pay && (
        <PaymentModal
          accountId={pay.account_id}
          invoice={{ id: pay.id, invoice_number: pay.invoice_number, balance_due: pay.balance, taxable_total: pay.taxable }}
          onClose={() => setPay(null)}
          onDone={() => (setPay(null), refresh())}
        />
      )}
      {newBill && <NewBill projectId={id} onClose={() => setNewBill(false)} onMade={(bid) => nav(`/o/bill/${bid}`)} />}
    </div>
  );
}

function Kpi({ l, v, sub, tone }: { l: string; v: number; sub?: string; tone?: string }) {
  return (
    <div className="panel kpi">
      <div className="l">{l}</div>
      <div className={`v ${tone === 'bad' || v < 0 ? 'tone-bad' : ''}`}>{money2(v)}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

/** How bank lines reach the project's invoices and bills, and what waits for a person. */
function BankNote({ data, onChanged, open }: { data: Json; onChanged: () => void; open: () => void }) {
  const d = data.desk as Json;
  const pending = (data.bank as Json[]).filter((b) => b.status === 'pending');
  const applied = (data.bank as Json[]).filter((b) => b.status === 'applied');
  if (!d.booksOn) return <p className="small muted">Switch on Books (Settings) to have payments found in the bank statement and invoices and bills marked paid by themselves.</p>;
  return (
    <section className="callout">
      <b>From the bank statement</b>
      <p className="small muted" style={{ margin: '4px 0' }}>
        {d.canDecide ? AUTONOMY[d.autonomy] ?? '' : 'The accounts desk matches bank lines to these invoices and bills.'} {applied.length ? `${applied.length} bank line${applied.length === 1 ? '' : 's'} applied to this project.` : ''}
      </p>
      {pending.length > 0 && (
        <button className="btn sm primary" onClick={open}>
          {pending.length} waiting for approval
        </button>
      )}
      {d.canDecide && <AutonomySwitch autonomy={d.autonomy} onChanged={onChanged} />}
    </section>
  );
}

function AutonomySwitch({ autonomy, onChanged }: { autonomy: string; onChanged: () => void }) {
  const toast = useToast();
  return (
    <label className="row small" style={{ gap: 6, marginTop: 6 }}>
      <input
        type="checkbox"
        checked={autonomy !== 'suggest'}
        onChange={async (e) => {
          try {
            await put('/api/v1/books/desk/settings', { autonomy: e.target.checked ? 'auto_sure' : 'suggest' });
            toast(e.target.checked ? 'Sure bank matches will be applied by themselves' : 'Every bank match waits for approval');
            onChanged();
          } catch (err) {
            toast((err as Error).message, true);
          }
        }}
      />
      Mark invoices and bills paid by themselves when the bank line surely matches (for the whole company)
    </label>
  );
}

function BankMatches({ data, onChanged }: { data: Json; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const d = data.desk as Json;
  const rows = data.bank as Json[];
  const decide = async (pid: string, decision: 'approve' | 'reject') => {
    setBusy(pid);
    try {
      await post(`/api/v1/books/desk/proposals/${pid}`, { decision });
      toast(decision === 'approve' ? 'Applied: the payment is recorded and the document marked paid' : 'Set aside');
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  const look = async () => {
    setBusy('run');
    try {
      await post('/api/v1/books/desk/run', { agents: ['bookkeeper'] });
      toast('Looked at the new bank lines');
      onChanged();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <p className="small muted" style={{ margin: 0 }}>
          Bank lines the accounts desk tied to this project’s invoices and bills. Approving one records the receipt or payment against the document, marks it paid (or part paid) and posts it to the books — GST and TDS included.
        </p>
        {d.canDecide && (
          <button className="btn sm" disabled={busy === 'run'} onClick={look}>
            {busy === 'run' ? 'Looking…' : 'Look at new bank lines now'}
          </button>
        )}
      </div>
      {d.canDecide && <AutonomySwitch autonomy={d.autonomy} onChanged={onChanged} />}
      {!rows.length ? (
        <Empty title="No bank lines matched yet">{d.booksOn ? 'Import or connect the bank statement in Books → Banking; receipts and payments for this project show up here.' : 'Switch on Books to match the bank statement.'}</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Bank line</th>
              <th>Matched to</th>
              <th className="num">Amount</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  {date(b.txn_date)} · {b.bank_account}
                  <div className="small muted">{[b.description, b.reference].filter(Boolean).join(' · ')}</div>
                </td>
                <td>
                  {b.title}
                  {b.reason && <div className="small muted">{b.reason}</div>}
                </td>
                <td className="num">{money2(Math.abs(Number(b.amount)))}</td>
                <td>
                  {b.status === 'applied' ? (
                    <span className="chip good">{b.applied_by === 'agent' ? 'applied by itself' : 'approved'}</span>
                  ) : (
                    <span className="chip warn">{Math.round(Number(b.confidence) * 100)}% sure</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {b.status === 'pending' && d.canDecide && (
                    <>
                      <button className="btn sm primary" disabled={!!busy} onClick={() => decide(b.id, 'approve')}>
                        Approve
                      </button>{' '}
                      <button className="btn sm ghost" disabled={!!busy} onClick={() => decide(b.id, 'reject')}>
                        Not this
                      </button>
                    </>
                  )}
                  {b.status === 'pending' && !d.canDecide && <span className="small muted">waits for the accountant</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function NewBill({ projectId, onClose, onMade }: { projectId: string; onClose: () => void; onMade: (id: string) => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['records', 'vendor', 'all'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200') });
  const [vendor, setVendor] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="New bill for this project"
      onClose={onClose}
      footer={
        <>
          <Link className="btn ghost" to="/o/vendor">
            Add a vendor
          </Link>
          <button
            className="btn primary"
            disabled={!vendor || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await post<Json>(`/api/v1/projects/${projectId}/billing/new`, { kind: 'bill', vendorId: vendor });
                onMade(r.id);
              } catch (e) {
                toast((e as Error).message, true);
              } finally {
                setBusy(false);
              }
            }}
          >
            Create the bill
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          Vendor
          <select value={vendor} onChange={(e) => setVendor(e.target.value)} autoFocus>
            <option value="">Choose…</option>
            {(data?.items ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.title ?? v.name}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted wide" style={{ margin: 0 }}>
          The bill is booked to this project: enter its lines, GST and TDS on the next page. Its input GST counts here, and paying it (or the bank line that pays it) marks it paid.
        </p>
      </div>
    </Modal>
  );
}
