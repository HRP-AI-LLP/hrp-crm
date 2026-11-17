/** Record panels for the Books app: bills / vendor credits, vendor payments, expenses and claims. */
import { hasAdmin } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money2 } from '../../lib/format';
import { type DocLine, LinesEditor, toLineInput } from '../ops/LinesEditor';
import { Modal, useToast } from '../ui';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const BILL_CLS: Record<string, string> = { draft: '', open: 'info', partially_paid: 'warn', paid: 'good', void: 'bad' };
const EXP_CLS: Record<string, string> = { draft: '', submitted: 'info', approved: 'warn', recorded: 'good', reimbursed: 'good', rejected: 'bad', void: 'bad' };
export const PAY_MODES: [string, string][] = [['bank_transfer', 'Bank transfer / NEFT'], ['upi', 'UPI'], ['cheque', 'Cheque'], ['cash', 'Cash'], ['card', 'Card'], ['other', 'Other']];

export function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r ?? true;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

/** Bank, cash and card accounts for "paid through" pickers (books admins only; others get the default). */
export function usePaymentAccounts(enabled = true) {
  return useQuery({
    queryKey: ['books', 'expense-categories'],
    queryFn: () => get<Json[]>('/api/v1/books/expense-categories'),
    enabled,
    staleTime: 60_000,
  });
}

function Reason({ title, label = 'Reason', onClose, onSave }: { title: string; label?: string; onClose: () => void; onSave: (reason: string) => Promise<unknown> }) {
  const [v, setV] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <button className="btn danger" disabled={v.trim().length < 3} onClick={async () => (await onSave(v.trim())) && onClose()}>
          Confirm
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          {label}
          <textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} autoFocus />
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── bills and vendor credits ───────────────────────── */

export function BillPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['bill', id], queryFn: () => get<Json>(`/api/v1/books/bills/${id}`) });
  const act = useAct([['bill', id], ['record', 'bill', id], ['timeline', 'bill', id], ['records', 'bill']]);
  const [modal, setModal] = useState<null | 'pay' | 'void' | 'credit' | 'apply'>(null);
  if (!data) return null;
  const b = data.bill;
  const status = String(b.status);
  const draft = status === 'draft';
  const isVc = b.doc_type === 'vendor_credit';
  const blocked = ['required', 'pending', 'rejected'].includes(String(b.approval_status));
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {isVc ? 'Vendor credit' : 'Bill'} {b.bill_number ?? '(draft)'} <span className={`chip ${BILL_CLS[status] ?? ''}`}>{status.replace(/_/g, ' ')}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {canEdit && draft && (
            <button
              className="btn sm primary"
              disabled={blocked || !data.lines.length}
              title={blocked ? 'Needs approval first' : undefined}
              onClick={() => window.confirm(`Post this ${isVc ? 'vendor credit' : 'bill'}? It is numbered, updates item costs and posts to the ledger; it can no longer be edited.`) && act(() => post(`/api/v1/books/bills/${id}/post`), 'Posted')}
            >
              Post {isVc ? 'credit' : 'bill'}
            </button>
          )}
          {canEdit && !isVc && ['open', 'partially_paid'].includes(status) && (
            <button className="btn sm primary" onClick={() => setModal('pay')}>
              Record payment
            </button>
          )}
          {canEdit && isVc && ['open', 'partially_paid'].includes(status) && (
            <button className="btn sm primary" onClick={() => setModal('apply')}>
              Apply to bills
            </button>
          )}
          {canEdit && !isVc && ['open', 'partially_paid', 'paid'].includes(status) && (
            <button className="btn sm" onClick={() => setModal('credit')}>
              Vendor credit
            </button>
          )}
          {canEdit && !draft && status !== 'void' && (
            <button className="btn sm danger" onClick={() => setModal('void')}>
              Void
            </button>
          )}
          {!isVc && status !== 'void' && <MakeRecurring kind="bill" rec={b} />}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span>
            Supply: <b>{b.supply_type === 'intra' ? 'CGST + SGST' : b.supply_type === 'inter' ? 'IGST' : b.supply_type === 'import' ? 'Import' : '—'}</b>
          </span>
          {b.reverse_charge && <span className="chip warn">Reverse charge</span>}
          {b.itc_eligible === false && <span className="chip">No input credit</span>}
          {b.tds_section && (
            <span>
              TDS {b.tds_section} @ {b.tds_rate ?? '—'}%
            </span>
          )}
          {b.due_date && !isVc && <span>Due {date(b.due_date)}</span>}
          {b.purchase_order_id && (
            <span>
              From <Link to={`/o/purchase_order/${b.purchase_order_id}`}>purchase order</Link>
            </span>
          )}
          {b.original_bill_id && (
            <span>
              Against <Link to={`/o/bill/${b.original_bill_id}`}>bill</Link>
            </span>
          )}
          {data.journalId && <span className="muted">Posted to the ledger</span>}
          {data.voidReason && <span className="chip bad">Void: {data.voidReason}</span>}
        </div>
        <LinesEditor
          lines={data.lines as DocLine[]}
          locked={!canEdit || !draft}
          priceFrom="cost_price"
          currency={b.currency}
          saveLabel="Save bill"
          hideTotals
          taxInclusive={!!b.tax_inclusive}
          onSave={async (lines, taxInclusive) => {
            await act(() => put(`/api/v1/books/bills/${id}/lines`, { taxInclusive, lines: lines.map((l) => ({ ...toLineInput(l), accountId: (l as Json).accountId ?? null, projectId: (l as Json).projectId ?? null, poLineId: (l as Json).poLineId ?? null })) }), 'Bill saved');
          }}
        />
        {data.lines.length > 0 && <LineAccounts billId={id} lines={data.lines} locked={!canEdit || !draft} onSaved={() => act(async () => undefined, 'Accounts saved')} />}
        <div className="spread" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 16 }}>
          <table className="data" style={{ maxWidth: 420 }}>
            <tbody>
              <Row l="Taxable value" v={b.taxable_total} />
              {b.supply_type === 'intra' ? (
                <>
                  <Row l="CGST" v={b.cgst_total} />
                  <Row l="SGST" v={b.sgst_total} />
                </>
              ) : (
                <Row l="IGST" v={b.igst_total} />
              )}
              {Number(b.round_off) !== 0 && <Row l="Round off" v={b.round_off} />}
              <Row l={<b>Total</b>} v={b.grand_total} bold />
              {Number(b.tds_amount) > 0 && <Row l={`Less TDS (${b.tds_section ?? ''})`} v={-Number(b.tds_amount)} />}
              {!draft && (
                <>
                  <Row l="Paid" v={b.amount_paid} />
                  {Number(b.amount_credited) > 0 && <Row l={isVc ? 'Applied' : 'Credits'} v={-Number(b.amount_credited)} />}
                  <Row l={<b>Balance due</b>} v={b.balance_due} bold />
                </>
              )}
            </tbody>
          </table>
          {(data.payments.length > 0 || data.credits.length > 0) && (
            <table className="data" style={{ maxWidth: 460 }}>
              <thead>
                <tr>
                  <th>{isVc ? 'Applied to' : 'Settled by'}</th>
                  <th>Date</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p: Json) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/o/vendor_payment/${p.id}`}>{p.payment_number}</Link> <span className="muted small">{p.mode?.replace(/_/g, ' ')}</span>
                    </td>
                    <td>{date(p.payment_date)}</td>
                    <td className="num">{money2(p.amount)}</td>
                  </tr>
                ))}
                {data.credits.map((c: Json) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/o/bill/${c.id}`}>{c.bill_number}</Link>
                    </td>
                    <td>{date(c.bill_date)}</td>
                    <td className="num">{money2(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {modal === 'pay' && <VendorPaymentModal vendorId={b.vendor_id} bill={b} onClose={() => setModal(null)} onDone={() => act(async () => undefined, 'Payment saved')} />}
      {modal === 'void' && <Reason title={`Void ${isVc ? 'vendor credit' : 'bill'}`} onClose={() => setModal(null)} onSave={(reason) => act(() => post(`/api/v1/books/bills/${id}/void`, { reason }), 'Voided')} />}
      {modal === 'credit' && (
        <Reason
          title="Raise a vendor credit"
          label="Why (returned goods, rate difference …)"
          onClose={() => setModal(null)}
          onSave={async (reason) => {
            const r = (await act(() => post<{ id: string }>(`/api/v1/books/bills/${id}/vendor-credit`, { reason }), 'Draft vendor credit created')) as { id: string } | null;
            if (r?.id) window.location.assign(`/o/bill/${r.id}`);
            return r;
          }}
        />
      )}
      {modal === 'apply' && <ApplyCreditModal credit={b} onClose={() => setModal(null)} onDone={() => act(async () => undefined, 'Credit applied')} />}
    </section>
  );
}

/** Which ledger account each bill line posts to (lines for stocked items always go to inventory). */
function LineAccounts({ billId, lines, locked, onSaved }: { billId: string; lines: Json[]; locked: boolean; onSaved: () => void }) {
  const toast = useToast();
  const cats = usePaymentAccounts();
  const opts = (cats.data ?? []).filter((a) => a.type === 'expense' || ['fixed_asset', 'current_asset'].includes(a.subtype));
  const [acc, setAcc] = useState<Record<string, string>>({});
  const dirty = Object.keys(acc).length > 0;
  return (
    <details>
      <summary className="small muted" style={{ cursor: 'pointer' }}>
        Posting accounts {lines.some((l) => l.accountName) ? '' : '(lines without an item go to Purchases)'}
      </summary>
      <table className="data" style={{ maxWidth: 640 }}>
        <tbody>
          {lines.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              <td style={{ width: 280 }}>
                <select disabled={locked} value={acc[l.id] ?? l.accountId ?? ''} onChange={(e) => setAcc({ ...acc, [l.id]: e.target.value })}>
                  <option value="">{l.productId ? 'Item default (stock / purchases)' : 'Purchases'}</option>
                  {opts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!locked && dirty && (
        <button
          className="btn sm primary"
          onClick={async () => {
            try {
              await put(`/api/v1/books/bills/${billId}/lines`, { lines: lines.map((l) => ({ ...toLineInput(l as DocLine), accountId: (acc[l.id] ?? l.accountId) || null, projectId: l.projectId ?? null, poLineId: l.poLineId ?? null })) });
              setAcc({});
              onSaved();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save accounts
        </button>
      )}
    </details>
  );
}

function Row({ l, v, bold }: { l: React.ReactNode; v: unknown; bold?: boolean }) {
  return (
    <tr>
      <td>{l}</td>
      <td className="num">{bold ? <b>{money2(v)}</b> : money2(v)}</td>
    </tr>
  );
}

function ApplyCreditModal({ credit, onClose, onDone }: { credit: Json; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['open-bills', credit.vendor_id], queryFn: () => get<{ items: Json[] }>(`/api/v1/records/bill?limit=100&filters=${encodeURIComponent(JSON.stringify([{ field: 'vendor_id', op: 'eq', value: credit.vendor_id }]))}`) });
  const bills = (data?.items ?? []).filter((b) => b.doc_type === 'bill' && ['open', 'partially_paid'].includes(String(b.status)));
  const [amt, setAmt] = useState<Record<string, string>>({});
  const total = Object.values(amt).reduce((s, v) => s + (Number(v) || 0), 0);
  return (
    <Modal
      title={`Apply ${credit.bill_number}`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!total || total > Number(credit.balance_due) + 0.005}
          onClick={async () => {
            try {
              await post(`/api/v1/books/bills/${credit.id}/apply-credit`, { plan: Object.entries(amt).filter(([, v]) => Number(v) > 0).map(([billId, v]) => ({ billId, amount: Number(v) })) });
              onDone();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Apply {money2(total)}
        </button>
      }
    >
      <div className="modal-body">
        <p className="muted small">Credit available: {money2(credit.balance_due)}</p>
        {!bills.length && <p className="muted">No open bills for this vendor.</p>}
        <table className="data">
          <tbody>
            {bills.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.bill_number} <span className="muted small">{b.vendor_ref}</span>
                </td>
                <td className="num">{money2(b.balance_due)}</td>
                <td style={{ width: 130 }}>
                  <input inputMode="decimal" value={amt[b.id] ?? ''} onChange={(e) => setAmt({ ...amt, [b.id]: e.target.value })} placeholder="0" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

/** Pays a vendor: the chosen bill, or the oldest bills first. */
export function VendorPaymentModal({ vendorId, bill, onClose, onDone }: { vendorId: string; bill?: Json | null; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  const isBooks = !!me && hasAdmin(me.permissions, 'books');
  const accts = usePaymentAccounts(isBooks);
  const through = (accts.data ?? []).filter((a) => ['bank', 'cash', 'credit_card'].includes(a.subtype));
  const [f, setF] = useState({ amount: bill ? String(bill.balance_due) : '', date: today(), mode: 'bank_transfer', reference: '', through: '', apply: bill ? 'this' : 'auto' });
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Pay vendor"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !(Number(f.amount) > 0)}
          onClick={async () => {
            setBusy(true);
            try {
              const amount = Number(f.amount);
              const allocations = f.apply === 'this' && bill ? [{ billId: bill.id, amount: Math.min(amount, Number(bill.balance_due)) }] : f.apply === 'auto' ? 'auto' : null;
              const r = await post<{ number: string }>('/api/v1/books/vendor-payments', { vendorId, amount, date: f.date, mode: f.mode, reference: f.reference || null, paidThroughId: f.through || null, allocations });
              toast(`Payment ${r.number} saved`);
              onDone?.();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save payment
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Amount (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
        </label>
        <label className="field">
          Paid on
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Mode
          <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            {PAY_MODES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {isBooks && (
          <label className="field">
            Paid from
            <select value={f.through} onChange={(e) => setF({ ...f, through: e.target.value })}>
              <option value="">Default ({f.mode === 'cash' ? 'cash' : 'bank'})</option>
              {through.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Reference (UTR / cheque no.)
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
        </label>
        <label className="field">
          Apply to
          <select value={f.apply} onChange={(e) => setF({ ...f, apply: e.target.value })}>
            {bill && <option value="this">This bill</option>}
            <option value="auto">Oldest bills first</option>
            <option value="none">Keep as advance</option>
          </select>
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── vendor payments ───────────────────────── */

export function VendorPaymentPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['vendor-payment', id], queryFn: () => get<Json>(`/api/v1/books/vendor-payments/${id}`) });
  const act = useAct([['vendor-payment', id], ['record', 'vendor_payment', id], ['records', 'vendor_payment']]);
  const [voiding, setVoiding] = useState(false);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  if (!data) return null;
  const p = data.payment;
  const allocated = data.allocations.reduce((s: number, a: Json) => s + Number(a.amount), 0);
  const left = Math.round((Number(p.amount) - allocated) * 100) / 100;
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          Payment {p.payment_number} <span className={`chip ${p.status === 'void' ? 'bad' : 'good'}`}>{p.status}</span>
        </h2>
        {canEdit && p.status === 'paid' && (
          <button className="btn sm danger" onClick={() => setVoiding(true)}>
            Void
          </button>
        )}
      </div>
      <div className="panel-body stack">
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span>
            Amount <b>{money2(p.amount)}</b>
          </span>
          <span>Unapplied {money2(left)}</span>
          {p.void_reason && <span className="chip bad">Void: {p.void_reason}</span>}
        </div>
        {data.allocations.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Date</th>
                <th className="num">Applied</th>
              </tr>
            </thead>
            <tbody>
              {data.allocations.map((a: Json) => (
                <tr key={a.bill_id}>
                  <td>
                    <Link to={`/o/bill/${a.bill_id}`}>{a.bill_number}</Link> <span className="muted small">{a.vendor_ref}</span>
                  </td>
                  <td>{date(a.bill_date)}</td>
                  <td className="num">{money2(a.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && p.status === 'paid' && left > 0 && data.openBills.length > 0 && (
          <>
            <h3 style={{ margin: 0 }}>Apply the rest</h3>
            <table className="data">
              <tbody>
                {data.openBills.map((b: Json) => (
                  <tr key={b.id}>
                    <td>
                      {b.bill_number} <span className="muted small">{b.vendor_ref}</span>
                    </td>
                    <td>Due {date(b.due_date)}</td>
                    <td className="num">{money2(b.balance_due)}</td>
                    <td style={{ width: 130 }}>
                      <input inputMode="decimal" value={alloc[b.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [b.id]: e.target.value })} placeholder="0" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="row">
              <button
                className="btn sm primary"
                onClick={() =>
                  act(
                    () =>
                      post(`/api/v1/books/vendor-payments/${id}/allocate`, {
                        allocations: [
                          ...data.allocations.map((a: Json) => ({ billId: a.bill_id, amount: Number(a.amount) })),
                          ...Object.entries(alloc)
                            .filter(([, v]) => Number(v) > 0)
                            .map(([billId, v]) => ({ billId, amount: Number(v) })),
                        ],
                      }),
                    'Applied',
                  ).then(() => setAlloc({}))
                }
              >
                Apply
              </button>
              <button className="btn sm" onClick={() => act(() => post(`/api/v1/books/vendor-payments/${id}/allocate`, { allocations: 'auto' }), 'Applied oldest first')}>
                Oldest first
              </button>
            </div>
          </>
        )}
      </div>
      {voiding && <Reason title="Void payment" onClose={() => setVoiding(false)} onSave={(reason) => act(() => post(`/api/v1/books/vendor-payments/${id}/void`, { reason }), 'Payment voided')} />}
    </section>
  );
}

/* ───────────────────────── expenses and claims ───────────────────────── */

export function ExpensePanel({ rec, canEdit }: { rec: Json; canEdit: boolean }) {
  const { me } = useAuth();
  const id = String(rec.id);
  const act = useAct([['record', 'expense', id], ['timeline', 'expense', id], ['records', 'expense'], ['expense-books', id]]);
  const cats = usePaymentAccounts();
  const { data: bx } = useQuery({ queryKey: ['expense-books', id, rec.version], queryFn: () => get<Json>(`/api/v1/books/expenses/${id}`) });
  const [modal, setModal] = useState<null | 'reject' | 'void' | 'reimburse'>(null);
  const [through, setThrough] = useState('');
  const status = String(rec.status);
  const mine = rec.owner_id === me?.user.id;
  const isBooks = !!me && hasAdmin(me.permissions, 'books');
  const editable = canEdit && ['draft', 'rejected'].includes(status);
  const all = cats.data ?? [];
  const categories = all.filter((a) => a.type === 'expense' || ['fixed_asset', 'current_asset'].includes(a.subtype));
  const payFrom = all.filter((a) => ['bank', 'cash', 'credit_card'].includes(a.subtype));
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {rec.is_claim ? 'Claim' : 'Expense'} {rec.expense_number ?? ''} <span className={`chip ${EXP_CLS[status] ?? ''}`}>{status}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {editable && (rec.is_claim || !isBooks) && (
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/books/expenses/${id}/submit`), 'Submitted for approval')}>
              Submit for approval
            </button>
          )}
          {editable && !rec.is_claim && isBooks && status === 'draft' && (
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/books/expenses/${id}/record`), 'Recorded')}>
              Record expense
            </button>
          )}
          {status === 'submitted' && !mine && rec.created_by !== me?.user.id && (
            <>
              <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/books/expenses/${id}/approve`), 'Approved')}>
                Approve
              </button>
              <button className="btn sm danger" onClick={() => setModal('reject')}>
                Reject
              </button>
            </>
          )}
          {status === 'approved' && rec.is_claim && isBooks && (
            <button className="btn sm primary" onClick={() => setModal('reimburse')}>
              Reimburse
            </button>
          )}
          {['approved', 'recorded', 'reimbursed'].includes(status) && isBooks && (
            <button className="btn sm danger" onClick={() => setModal('void')}>
              Void
            </button>
          )}
          {!rec.is_claim && status !== 'void' && <MakeRecurring kind="expense" rec={rec} />}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span>
            Before tax <b>{money2(rec.taxable_amount)}</b>
          </span>
          <span>GST {money2(rec.tax_amount)}</span>
          <span>
            Total <b>{money2(rec.total)}</b>
          </span>
          {bx?.rejectReason && status === 'rejected' && <span className="chip bad">Rejected: {bx.rejectReason}</span>}
          {bx?.approvedBy && <span className="muted">Approved by {bx.approvedBy}</span>}
          {bx?.reimbursedAt && <span className="muted">Reimbursed {date(bx.reimbursedAt)}{bx.reimbursedThrough ? ` from ${bx.reimbursedThrough}` : ''}</span>}
        </div>
        <div className="grid2" style={{ maxWidth: 640 }}>
          <label className="field">
            Category
            <select
              disabled={!editable}
              value={bx?.accountId ?? ''}
              onChange={(e) => act(() => put(`/api/v1/books/expenses/${id}/accounts`, { accountId: e.target.value || null, paidThroughId: bx?.paidThroughId ?? null }), 'Category saved')}
            >
              <option value="">Uncategorised</option>
              {categories.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          {!rec.is_claim && (
            <label className="field">
              Paid through
              <select
                disabled={!editable}
                value={bx?.paidThroughId ?? ''}
                onChange={(e) => act(() => put(`/api/v1/books/expenses/${id}/accounts`, { accountId: bx?.accountId ?? null, paidThroughId: e.target.value || null }), 'Saved')}
              >
                <option value="">Default (bank)</option>
                {payFrom.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>
      {modal === 'reject' && <Reason title="Reject claim" label="Tell them why" onClose={() => setModal(null)} onSave={(reason) => act(() => post(`/api/v1/books/expenses/${id}/reject`, { reason }), 'Rejected')} />}
      {modal === 'void' && <Reason title="Void expense" onClose={() => setModal(null)} onSave={(reason) => act(() => post(`/api/v1/books/expenses/${id}/void`, { reason }), 'Voided')} />}
      {modal === 'reimburse' && (
        <Modal
          title="Reimburse claim"
          onClose={() => setModal(null)}
          footer={
            <button className="btn primary" onClick={async () => (await act(() => post(`/api/v1/books/expenses/${id}/reimburse`, { throughId: through || null }), 'Reimbursed')) && setModal(null)}>
              Reimburse {money2(rec.total)}
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Paid from
              <select value={through} onChange={(e) => setThrough(e.target.value)}>
                <option value="">Default bank account</option>
                {payFrom
                  .filter((a) => a.subtype !== 'credit_card')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ───────────────────────── make recurring ───────────────────────── */

const KEEP: Record<'invoice' | 'bill' | 'expense', string[]> = {
  invoice: ['name', 'subject', 'account_id', 'contact_id', 'deal_id', 'customer_ref', 'doc_type', 'place_of_supply', 'currency', 'exchange_rate', 'tax_inclusive', 'payment_terms', 'notes', 'terms'],
  bill: ['name', 'vendor_id', 'place_of_supply', 'tax_inclusive', 'reverse_charge', 'itc_eligible', 'currency', 'exchange_rate', 'tds_section', 'tds_rate', 'notes'],
  expense: ['name', 'amount', 'amount_is_inclusive', 'tax_rate', 'supply_type', 'itc_eligible', 'vendor_id', 'vendor_name', 'vendor_gstin', 'billable', 'customer_id', 'notes'],
};

/** Saves a document as the template of a recurring profile (books admins). */
export function MakeRecurring({ kind, rec }: { kind: 'invoice' | 'bill' | 'expense'; rec: Json }) {
  const { me } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ frequency: 'monthly', startDate: today(), endDate: '', autoIssue: false });
  if (!me || !hasAdmin(me.permissions, 'books')) return null;
  return (
    <>
      <button className="btn sm ghost" onClick={() => setOpen(true)}>
        Make recurring
      </button>
      {open && (
        <Modal
          title={`Repeat this ${kind}`}
          onClose={() => setOpen(false)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const values = Object.fromEntries(KEEP[kind].filter((k) => rec[k] !== undefined && rec[k] !== null).map((k) => [k, rec[k]]));
                  if (kind === 'expense') values.is_claim = false;
                  const template: Json = { values };
                  if (kind === 'invoice') template.lines = ((await get<Json>(`/api/v1/invoices/${rec.id}`)).lines as DocLine[]).map((l) => toLineInput(l));
                  if (kind === 'bill') template.lines = ((await get<Json>(`/api/v1/books/bills/${rec.id}`)).lines as DocLine[]).map((l) => ({ ...toLineInput(l), accountId: (l as Json).accountId ?? null }));
                  if (kind === 'expense') {
                    const bx = await get<Json>(`/api/v1/books/expenses/${rec.id}`);
                    template.accountId = bx.accountId;
                    template.paidThroughId = bx.paidThroughId;
                  }
                  await post('/api/v1/books/recurring', { name: String(rec.name ?? rec.title ?? kind).slice(0, 150), kind, template, frequency: f.frequency, startDate: f.startDate, endDate: f.endDate || null, autoIssue: f.autoIssue });
                  toast('Recurring profile saved (Books → Recurring)');
                  setOpen(false);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Repeats
              <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="half_yearly">Half-yearly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
            <label className="field">
              Next one on
              <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
            </label>
            <label className="field">
              Ends (optional)
              <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
            </label>
            <label className="row field">
              <input type="checkbox" checked={f.autoIssue} onChange={(e) => setF({ ...f, autoIssue: e.target.checked })} /> {kind === 'invoice' ? 'Issue automatically' : kind === 'bill' ? 'Post automatically' : 'Record automatically'} (otherwise a draft is created)
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Writes off what is left on an invoice as a bad debt (books admins). */
export function WriteOffButton({ invoice }: { invoice: Json }) {
  const { me } = useAuth();
  const act = useAct([['invoice', String(invoice.id)], ['record', 'invoice', String(invoice.id)], ['records', 'invoice']]);
  const [open, setOpen] = useState(false);
  if (!me || !hasAdmin(me.permissions, 'books')) return null;
  return (
    <>
      <button className="btn sm ghost" onClick={() => setOpen(true)}>
        Write off
      </button>
      {open && (
        <Reason
          title={`Write off ${money2(invoice.balance_due)} as a bad debt`}
          onClose={() => setOpen(false)}
          onSave={(reason) => act(() => post(`/api/v1/books/invoices/${invoice.id}/write-off`, { reason }), 'Written off')}
        />
      )}
    </>
  );
}
