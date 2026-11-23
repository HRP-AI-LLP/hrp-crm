/**
 * A project's costs and expenses: what it earns and makes (for its managers), expenses filed on it
 * (claims and company-paid) with an "Add expense" form, vendor bills booked to it, and the matching
 * of bills, expenses, invoices, receipts and bank lines to it.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { ReconcilePanel } from '../books/Reconcile';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export function ProjectCosts({ id, manage }: { id: string; manage: boolean }) {
  const { data, refetch } = useQuery({ queryKey: ['project', id, 'costs'], queryFn: () => get<Json>(`/api/v1/projects/${id}/costs`) });
  const [adding, setAdding] = useState(false);
  if (!data) return <Spinner />;
  const e = data.economics as Json | null;
  return (
    <div className="stack">
      {e && (
        <div className="kpis">
          <Kpi l="Invoiced" v={e.bases.invoiced} sub={`collected ${money2(e.bases.collected)}`} />
          <Kpi l="Direct costs" v={e.directCosts} sub={`bills ${money2(e.bills)} · expenses ${money2(e.expenses)}`} />
          <Kpi l="Gross profit" v={e.bases.gross_profit} sub="invoiced − direct costs" />
          <Kpi l="Team cost" v={e.teamCost} sub={`time ${money2(e.timeCost)} · fixed ${money2(e.fixedPay)}`} />
          <Kpi l="Net profit" v={e.bases.net_profit} sub="gross − team cost" />
          <Kpi l="Profit after all expenses" v={e.bases.profit_after_all} sub={`collected − all costs${e.commission ? ` · commissions ${money2(e.commission)}` : ''}`} />
        </div>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Expenses</h2>
          <button className="btn sm primary" onClick={() => setAdding(true)}>
            Add expense
          </button>
        </div>
        {!data.expenses.length ? (
          <div className="panel-body">
            <Empty title="No expenses on this project">Travel, hotel, software, hardware, a freelancer — paid by you (a claim) or by the company.</Empty>
          </div>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>What</th>
                <th>By</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {(data.expenses as Json[]).map((x) => (
                <tr key={x.id}>
                  <td>{date(x.date)}</td>
                  <td>
                    <Link to={`/o/expense/${x.id}`}>{x.name}</Link>
                    <div className="small muted">
                      {[x.category, x.vendor_name, x.is_claim ? 'claim' : 'paid by the company', x.billable ? (x.invoice_id ? 'billed to the client' : 'to bill the client') : null].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="small">{x.who}</td>
                  <td>
                    <span className="chip">{x.status}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{money2(x.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {manage && (
        <section className="panel">
          <div className="panel-head">
            <h2>Vendor bills booked to the project</h2>
          </div>
          {!data.bills.length ? (
            <div className="panel-body muted small">None yet. Bills from mail, or entered in Books, can be put on the project from the suggestions below or on the bill.</div>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Bill</th>
                  <th>Vendor</th>
                  <th>Line</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th style={{ textAlign: 'right' }}>Unpaid</th>
                </tr>
              </thead>
              <tbody>
                {(data.bills as Json[]).map((b, i) => (
                  <tr key={`${b.id}-${i}`}>
                    <td>{date(b.date)}</td>
                    <td>
                      <Link to={`/o/bill/${b.id}`}>{b.number ?? 'Bill'}</Link>
                    </td>
                    <td>{b.vendor}</td>
                    <td className="small">{b.line}</td>
                    <td style={{ textAlign: 'right' }}>{money2(b.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{money2(b.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {manage && (
        <section className="panel">
          <div className="panel-head">
            <h2>Match & reconcile for this project</h2>
          </div>
          <div className="panel-body">
            <ReconcilePanel focus={`project:${id}`} onDone={() => refetch()} />
          </div>
        </section>
      )}
      {adding && <AddExpense projectId={id} onClose={() => setAdding(false)} onSaved={() => refetch()} />}
    </div>
  );
}

function Kpi({ l, v, sub }: { l: string; v: number; sub?: string }) {
  return (
    <div className="panel kpi">
      <div className="l">{l}</div>
      <div className={`v ${v < 0 ? 'tone-bad' : ''}`}>{money2(v)}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

function AddExpense({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: '', date: today(), amount: '', taxRate: '0', vendor: '', claim: true, billable: false, notes: '', submit: true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await post<{ id: string }>('/api/v1/records/expense', {
        name: f.name,
        expense_date: f.date,
        amount: Number(f.amount),
        tax_rate: Number(f.taxRate) || 0,
        vendor_name: f.vendor || null,
        is_claim: f.claim,
        billable: f.billable,
        notes: f.notes || null,
        project_id: projectId,
      });
      if (f.submit) {
        try {
          await post(`/api/v1/books/expenses/${r.id}/submit`);
        } catch (e) {
          toast(`Saved as a draft: ${(e as Error).message}`, true);
        }
      }
      toast(f.submit ? 'Expense filed for approval' : 'Expense saved as a draft');
      onSaved();
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add a project expense"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || !(Number(f.amount) > 0)} onClick={save}>
            {f.submit ? 'File for approval' : 'Save draft'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          What was it for
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Train to Delhi for the FCI demo" autoFocus />
        </label>
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Amount (with GST) ₹
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          GST rate
          <select value={f.taxRate} onChange={(e) => setF({ ...f, taxRate: e.target.value })}>
            {['0', '5', '12', '18', '28'].map((r) => (
              <option key={r} value={r}>
                {r}%
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Paid to (vendor)
          <input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} />
        </label>
        <label className="field wide">
          Notes
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label className="check-row">
          <input type="checkbox" checked={f.claim} onChange={(e) => setF({ ...f, claim: e.target.checked })} /> I paid it — reimburse me (a claim)
        </label>
        <label className="check-row">
          <input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Bill it to the client
        </label>
        <label className="check-row wide">
          <input type="checkbox" checked={f.submit} onChange={(e) => setF({ ...f, submit: e.target.checked })} /> File it for approval now
        </label>
        <p className="wide small muted" style={{ margin: 0 }}>
          Attach the receipt on the expense after saving. Approved expenses go to the books; the bank payment that settles them is matched under Match & reconcile.
        </p>
      </div>
    </Modal>
  );
}
