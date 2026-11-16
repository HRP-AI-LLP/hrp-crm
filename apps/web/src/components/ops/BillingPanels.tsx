import { hasAdmin, type RecordDto } from '@synapse/shared';
import { useAuth } from '../../lib/auth';
import { useApps } from './OrderPanel';
import { PaymentLinks } from './PayOnline';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { download, get, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { Modal, useToast } from '../ui';
import { type DocLine, LinesEditor, toLineInput } from './LinesEditor';
import { TallySync } from './TallySync';
import { Deposits } from '../books/Deposits';

type Json = Record<string, any>;
const STATUS_CLS: Record<string, string> = { draft: '', issued: 'info', partially_paid: 'warn', paid: 'good', cancelled: 'bad' };
const MODES: [string, string][] = [['bank_transfer', 'Bank transfer / NEFT'], ['upi', 'UPI'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['card', 'Card'], ['other', 'Other']];

function useAct(keys: unknown[][]) {
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

const DEDUCTIONS: [string, string, string][] = [
  ['tds', 'Income-tax TDS', 'Deducted under 194C / 194J; claim against Form 26AS'],
  ['gstTds', 'GST TDS (section 51)', 'Government buyers deduct 2% of the taxable value on contracts above ₹2.5 lakh'],
  ['ld', 'Liquidated damages / penalty', 'Kept by the buyer: booked as an expense'],
  ['retention', 'Retention / security withheld', 'Still yours: tracked under Deposits & guarantees until released'],
  ['charges', 'Bank charges', ''],
];

/** Records a payment (receipt) for a customer, applied to chosen invoices or the oldest first, with any deductions the customer made. */
export function PaymentModal({ accountId, orderId, invoice, onClose, onDone }: { accountId?: string | null; orderId?: string | null; invoice?: Json | null; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const { me } = useAuth();
  const apps = useApps();
  const canDeduct = !!me && (hasAdmin(me.permissions, 'billing') || hasAdmin(me.permissions, 'books'));
  const books = canDeduct && apps.has('books') && !!me && hasAdmin(me.permissions, 'books');
  const banks = useQuery({ queryKey: ['books', 'bank-accounts'], queryFn: () => get<Json[]>('/api/v1/books/bank-accounts'), enabled: books, retry: false });
  const [f, setF] = useState({ amount: invoice ? String(invoice.balance_due) : '', date: new Date().toISOString().slice(0, 10), mode: 'bank_transfer', reference: '', apply: invoice ? 'this' : 'auto', bank: '' });
  const [d, setD] = useState<Record<string, string>>({});
  const [showDed, setShowDed] = useState(false);
  const [busy, setBusy] = useState(false);
  const num = (k: string) => Math.max(0, Number(d[k]) || 0);
  const totalDed = Math.round(DEDUCTIONS.reduce((s, [k]) => s + num(k), 0) * 100) / 100;
  const net = Math.round(((Number(f.amount) || 0) - totalDed) * 100) / 100;
  /** suggests 2% TDS / 2% GST TDS on the invoice's taxable value */
  const suggest = (k: 'tds' | 'gstTds') => {
    const taxable = Number(invoice?.taxable_total ?? 0);
    if (taxable > 0) setD({ ...d, [k]: String(Math.round(taxable * 0.02 * 100) / 100) });
  };
  return (
    <Modal
      title="Record payment"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !(Number(f.amount) > 0) || net < 0}
          onClick={async () => {
            setBusy(true);
            try {
              const amount = Number(f.amount);
              const allocations = f.apply === 'this' && invoice ? [{ invoiceId: invoice.id, amount: Math.min(amount, Number(invoice.balance_due)) }] : f.apply === 'auto' ? 'auto' : null;
              const extra = canDeduct
                ? {
                    ...(num('tds') ? { tdsAmount: num('tds') } : {}),
                    ...(num('gstTds') ? { gstTdsAmount: num('gstTds') } : {}),
                    ...(num('ld') ? { ldAmount: num('ld') } : {}),
                    ...(num('retention') ? { retentionAmount: num('retention') } : {}),
                    ...(num('charges') ? { bankCharges: num('charges') } : {}),
                    ...(f.bank ? { depositAccountId: f.bank } : {}),
                  }
                : {};
              const r = await post<{ number: string }>('/api/v1/payments', { accountId: accountId ?? null, salesOrderId: orderId ?? null, amount, date: f.date, mode: f.mode, reference: f.reference || null, allocations, ...extra });
              toast(`Receipt ${r.number} saved`);
              onDone?.();
              onClose();
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save receipt
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          Amount settled (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus />
        </label>
        <label className="field">
          Received on
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Mode
          <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>
            {MODES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Reference
          <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="UTR, cheque no., UPI ref, PFMS ref" />
        </label>
        {books && (
          <label className="field">
            Deposited to
            <select value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })}>
              <option value="">Default for the mode</option>
              {(banks.data ?? [])
                .filter((b) => b.is_active && b.kind !== 'credit_card')
                .map((b) => (
                  <option key={b.gl_account_id} value={b.gl_account_id}>
                    {b.name}
                    {b.account_last4 ? ` ·${b.account_last4}` : ''}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field wide">
          Apply to
          <select value={f.apply} onChange={(e) => setF({ ...f, apply: e.target.value })}>
            {invoice && <option value="this">This invoice ({invoice.invoice_number ?? 'draft'})</option>}
            <option value="auto">Oldest open invoices first</option>
            <option value="none">Keep as an advance (apply later)</option>
          </select>
        </label>
        {canDeduct && (
          <div className="wide">
            <label className="check">
              <input type="checkbox" checked={showDed || totalDed > 0} onChange={(e) => setShowDed(e.target.checked)} /> The customer deducted something (TDS, GST TDS, penalty, retention, bank charges)
            </label>
            {(showDed || totalDed > 0) && (
              <table className="data" style={{ marginTop: 6 }}>
                <tbody>
                  {DEDUCTIONS.map(([k, l, help]) => (
                    <tr key={k}>
                      <td>
                        {l}
                        {help && <div className="small muted" style={{ whiteSpace: 'normal' }}>{help}</div>}
                      </td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        {(k === 'tds' || k === 'gstTds') && Number(invoice?.taxable_total ?? 0) > 0 && (
                          <button type="button" className="btn ghost sm" onClick={() => suggest(k)} title="2% of the taxable value">
                            2%
                          </button>
                        )}
                        <input inputMode="decimal" style={{ width: 110 }} value={d[k] ?? ''} onChange={(e) => setD({ ...d, [k]: e.target.value })} aria-label={l} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td>
                      <b>Credited to the bank</b>
                    </td>
                    <td className={`num${net < 0 ? ' tone-bad' : ''}`}>
                      <b>{money2(net)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Tax invoice / credit note workspace. */
export function InvoicePanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const nav = useNavigate();
  const { data } = useQuery({ queryKey: ['invoice', id], queryFn: () => get<Json>(`/api/v1/invoices/${id}`) });
  const act = useAct([['invoice', id], ['record', 'invoice', id], ['timeline', 'invoice', id], ['records', 'invoice']]);
  const [modal, setModal] = useState<null | 'pay' | 'cancel' | 'credit' | 'irn'>(null);
  const [f, setF] = useState<Json>({});
  if (!data) return null;
  const inv = data.invoice;
  const status = String(inv.status);
  const isCn = inv.doc_type === 'credit_note';
  const draft = status === 'draft';
  const blocked = ['required', 'pending', 'rejected'].includes(String(inv.approval_status));
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {isCn ? 'Credit note' : inv.doc_type === 'proforma' ? 'Proforma' : 'Tax invoice'} {inv.invoice_number ?? '(draft)'} <span className={`chip ${STATUS_CLS[status]}`}>{status.replace(/_/g, ' ')}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn sm" href={`/print/invoice/${id}`} target="_blank" rel="noreferrer">
            {draft ? 'Preview' : 'Print / PDF'}
          </a>
          {canEdit && draft && (
            <button className="btn sm primary" disabled={blocked || !data.lines.length} title={blocked ? 'Needs approval first' : undefined} onClick={() => window.confirm('Issue this invoice? It gets its GST number and can no longer be edited.') && act(() => post(`/api/v1/invoices/${id}/issue`), 'Invoice issued')}>
              Issue {isCn ? 'credit note' : 'invoice'}
            </button>
          )}
          {canEdit && !isCn && ['issued', 'partially_paid'].includes(status) && (
            <button className="btn sm primary" onClick={() => setModal('pay')}>
              Record payment
            </button>
          )}
          {canEdit && !isCn && ['issued', 'partially_paid', 'paid'].includes(status) && (
            <button className="btn sm" onClick={() => { setF({ reason: '', qty: Object.fromEntries(data.lines.map((l: Json) => [l.id, String(l.quantity)])) }); setModal('credit'); }}>
              Credit note
            </button>
          )}
          {!draft && status !== 'cancelled' && inv.buyer_gstin && (
            <>
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    const r = await get<{ json: Json; warnings: string[] }>(`/api/v1/invoices/${id}/einvoice`);
                    const blob = new Blob([JSON.stringify([r.json], null, 2)], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = `${String(inv.invoice_number).replace(/\//g, '-')}-einvoice.json`;
                    a.click();
                    if (r.warnings.length) window.alert(r.warnings.join('\n'));
                  } catch (e) {
                    window.alert((e as Error).message);
                  }
                }}
              >
                E-invoice JSON
              </button>
              {!inv.irn && canEdit && (
                <button className="btn sm ghost" onClick={() => { setF({ irn: '', ackNo: '' }); setModal('irn'); }}>
                  Add IRN
                </button>
              )}
            </>
          )}
          {canEdit && ['issued'].includes(status) && (
            <button className="btn sm danger" onClick={() => { setF({ reason: '' }); setModal('cancel'); }}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {!isCn && ['issued', 'partially_paid', 'paid'].includes(status) && <PaymentLinks invoiceId={id} due={Number(inv.balance_due)} canCreate={canEdit && status !== 'paid'} />}
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span>
            Place of supply: <b>{inv.place_of_supply ?? '—'}</b> ({inv.supply_type === 'intra' ? 'CGST + SGST' : inv.supply_type === 'inter' ? 'IGST' : '—'})
          </span>
          {inv.buyer_gstin && <span>Customer GSTIN {inv.buyer_gstin}</span>}
          {inv.due_date && !isCn && <span>Due {date(inv.due_date)}</span>}
          {inv.irn && <span title={inv.irn}>IRN {String(inv.irn).slice(0, 12)}…</span>}
          {isCn && inv.original_invoice_id && (
            <span>
              Against <Link to={`/o/invoice/${inv.original_invoice_id}`}>original invoice</Link>
            </span>
          )}
        </div>
        <LinesEditor
          lines={data.lines as DocLine[]}
          locked={!canEdit || !draft}
          priceFrom="list_price"
          currency={inv.currency}
          saveLabel="Save invoice"
          hideTotals
          onSave={async (lines) => {
            await act(() => put(`/api/v1/invoices/${id}/lines`, { lines: lines.map((l) => ({ ...toLineInput(l), orderLineId: (l as Json).orderLineId ?? null })) }), 'Invoice saved');
          }}
        />
        <div className="spread" style={{ alignItems: 'flex-start' }}>
          <table className="data" style={{ maxWidth: 420 }}>
            <tbody>
              <tr>
                <td>Taxable value</td>
                <td className="num">{money2(inv.taxable_total)}</td>
              </tr>
              {inv.supply_type === 'inter' ? (
                <tr>
                  <td>IGST</td>
                  <td className="num">{money2(inv.igst_total)}</td>
                </tr>
              ) : (
                <>
                  <tr>
                    <td>CGST</td>
                    <td className="num">{money2(inv.cgst_total)}</td>
                  </tr>
                  <tr>
                    <td>SGST</td>
                    <td className="num">{money2(inv.sgst_total)}</td>
                  </tr>
                </>
              )}
              {Number(inv.round_off) !== 0 && (
                <tr>
                  <td>Round off</td>
                  <td className="num">{money2(inv.round_off)}</td>
                </tr>
              )}
              <tr>
                <td>
                  <b>Total</b>
                </td>
                <td className="num">
                  <b>{money2(inv.grand_total)}</b>
                </td>
              </tr>
              {!isCn && !draft && (
                <>
                  <tr>
                    <td>Received</td>
                    <td className="num">{money2(inv.amount_paid)}</td>
                  </tr>
                  {Number(inv.amount_credited) > 0 && (
                    <tr>
                      <td>Credit notes</td>
                      <td className="num">− {money2(inv.amount_credited)}</td>
                    </tr>
                  )}
                  <tr>
                    <td>
                      <b>Balance due</b>
                    </td>
                    <td className="num">
                      <b style={{ color: Number(inv.balance_due) > 0 ? 'var(--bad)' : 'var(--good)' }}>{money2(inv.balance_due)}</b>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
          <div className="stack" style={{ minWidth: 260 }}>
            {data.payments.length > 0 && (
              <div>
                <h3>Payments</h3>
                {data.payments.map((p: Json) => (
                  <div key={p.id} className="small">
                    <Link to={`/o/payment/${p.id}`}>{p.payment_number}</Link> · {date(p.payment_date)} · {money2(p.amount)}
                  </div>
                ))}
              </div>
            )}
            {data.credits.length > 0 && (
              <div>
                <h3>Credit notes</h3>
                {data.credits.map((c: Json) => (
                  <div key={c.id} className="small">
                    <Link to={`/o/invoice/${c.id}`}>{c.invoice_number ?? 'Draft'}</Link> · {c.status} · {money2(c.grand_total)}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {modal === 'pay' && <PaymentModal accountId={inv.account_id} orderId={inv.sales_order_id} invoice={inv} onClose={() => setModal(null)} onDone={() => act(async () => undefined, 'Updated')} />}
      {modal === 'cancel' && (
        <Modal title="Cancel invoice" onClose={() => setModal(null)} footer={<button className="btn danger" disabled={(f.reason ?? '').trim().length < 3} onClick={async () => (await act(() => post(`/api/v1/invoices/${id}/cancel`, { reason: f.reason }), 'Invoice cancelled')) && setModal(null)}>Cancel invoice</button>}>
          <div className="modal-body" style={{ display: 'block' }}>
            <p style={{ marginTop: 0 }}>Cancel only invoices that should never have been issued (and before filing GSTR-1). Use a credit note for returns or price corrections.</p>
            <label className="field">
              Reason
              <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus />
            </label>
          </div>
        </Modal>
      )}
      {modal === 'irn' && (
        <Modal title="Record IRN" onClose={() => setModal(null)} footer={<button className="btn primary" disabled={!/^[0-9a-f]{64}$/i.test(f.irn)} onClick={async () => (await act(() => put(`/api/v1/invoices/${id}/irn`, { irn: f.irn, ackNo: f.ackNo || null }), 'IRN saved')) && setModal(null)}>Save</button>}>
          <div className="modal-body">
            <label className="field wide">
              IRN (64 characters from the IRP)
              <input className="mono small" value={f.irn} onChange={(e) => setF({ ...f, irn: e.target.value.trim() })} autoFocus />
            </label>
            <label className="field">
              Ack. no.
              <input value={f.ackNo} onChange={(e) => setF({ ...f, ackNo: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
      {modal === 'credit' && (
        <Modal
          title="Raise a credit note"
          wide
          onClose={() => setModal(null)}
          footer={
            <button
              className="btn primary"
              disabled={(f.reason ?? '').trim().length < 3}
              onClick={async () => {
                const lines = Object.entries(f.qty as Record<string, string>).map(([lineId, q]) => ({ lineId, quantity: Number(q) })).filter((l) => l.quantity > 0);
                const r = (await act(() => post<{ id: string }>(`/api/v1/invoices/${id}/credit-note`, { reason: f.reason, lines }), 'Draft credit note created')) as { id: string } | null;
                if (r?.id) nav(`/o/invoice/${r.id}`);
              }}
            >
              Create draft
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              Reason (printed on the credit note)
              <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Goods returned, price correction, damage…" autoFocus />
            </label>
            <table className="data wide">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Invoiced</th>
                  <th className="num">Credit qty</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l: Json) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="num">{l.quantity}</td>
                    <td>
                      <input className="num" inputMode="decimal" aria-label={`Credit ${l.name}`} value={f.qty[l.id]} onChange={(e) => setF({ ...f, qty: { ...f.qty, [l.id]: e.target.value } })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** Payment record: where the money went, and applying the rest. */
export function PaymentPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['payment', id], queryFn: () => get<Json>(`/api/v1/payments/${id}`) });
  const act = useAct([['payment', id], ['record', 'payment', id], ['invoice']]);
  const [apply, setApply] = useState<Record<string, string>>({});
  if (!data) return null;
  const p = data.payment;
  const left = Number(p.unallocated);
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          Receipt {p.payment_number} <span className={`chip ${p.status === 'void' ? 'bad' : left > 0 ? 'warn' : 'good'}`}>{p.status === 'void' ? 'void' : left > 0 ? `${money2(left)} unapplied` : 'fully applied'}</span>
        </h2>
        <div className="row">
          {canEdit && p.status === 'received' && left > 0 && (
            <button className="btn sm" onClick={() => act(() => post(`/api/v1/payments/${id}/allocate`, { allocations: 'auto' }), 'Applied to the oldest invoices')}>
              Apply automatically
            </button>
          )}
          {canEdit && p.status === 'received' && (
            <button
              className="btn sm danger"
              onClick={() => {
                const reason = window.prompt('Why is this payment void? (e.g. cheque bounced)');
                if (reason && reason.trim().length >= 3) void act(() => post(`/api/v1/payments/${id}/void`, { reason }), 'Payment voided');
              }}
            >
              Void
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {p.status === 'void' && <div className="notice small">Void: {p.void_reason}</div>}
        {data.allocations.length > 0 && (
          <table className="data">
            <thead>
              <tr>
                <th>Applied to</th>
                <th className="num">Amount</th>
                <th className="num">Invoice balance</th>
              </tr>
            </thead>
            <tbody>
              {data.allocations.map((a: Json) => (
                <tr key={a.invoice_id}>
                  <td>
                    <Link to={`/o/invoice/${a.invoice_id}`}>{a.invoice_number}</Link> · {date(a.invoice_date)}
                  </td>
                  <td className="num">{money2(a.amount)}</td>
                  <td className="num">{money2(a.balance_due)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {canEdit && p.status === 'received' && left > 0 && data.openInvoices.length > 0 && (
          <>
            <h3>Open invoices of this customer</h3>
            <table className="data">
              <tbody>
                {data.openInvoices.map((i: Json) => (
                  <tr key={i.id}>
                    <td>
                      <Link to={`/o/invoice/${i.id}`}>{i.invoice_number}</Link>
                      <div className="muted small">Due {i.due_date ? date(i.due_date) : '—'}</div>
                    </td>
                    <td className="num">{money2(i.balance_due)} due</td>
                    <td style={{ width: 140 }}>
                      <input className="num" inputMode="decimal" placeholder="Apply ₹" aria-label={`Apply to ${i.invoice_number}`} value={apply[i.id] ?? ''} onChange={(e) => setApply({ ...apply, [i.id]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div>
              <button
                className="btn primary sm"
                disabled={!Object.values(apply).some((v) => Number(v) > 0)}
                onClick={async () => {
                  const allocations = Object.entries(apply).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) })).filter((a) => a.amount > 0);
                  if (await act(() => post(`/api/v1/payments/${id}/allocate`, { allocations }), 'Payment applied')) setApply({});
                }}
              >
                Apply
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** Invoices of an order, with "invoice the rest" and per-milestone invoicing. */
export function OrderBilling({ order, milestones, canEdit }: { order: Json; milestones: Json[]; canEdit: boolean }) {
  const nav = useNavigate();
  const orderId = String(order.id);
  const flt = encodeURIComponent(JSON.stringify([{ field: 'sales_order_id', op: 'eq', value: orderId }]));
  const invs = useQuery({ queryKey: ['order-invoices', orderId], queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/invoice?filters=${flt}&sort=created_at&dir=asc`) });
  const act = useAct([['order-invoices', orderId], ['order', orderId]]);
  const [paying, setPaying] = useState(false);
  const status = String(order.status);
  const open = !['draft', 'cancelled'].includes(status);
  const make = async (milestoneId?: string) => {
    const r = (await act(() => post<{ id: string }>(`/api/v1/orders/${orderId}/invoices`, milestoneId ? { milestoneId } : {}), 'Draft invoice created')) as { id: string } | null;
    if (r?.id) nav(`/o/invoice/${r.id}`);
  };
  return (
    <div className="stack">
      <div className="spread">
        <h3>Invoices &amp; payments</h3>
        {canEdit && open && (
          <div className="row">
            <button className="btn sm" onClick={() => setPaying(true)}>
              Record payment
            </button>
            <button className="btn sm" onClick={() => make()}>
              Invoice remaining items
            </button>
          </div>
        )}
      </div>
      {invs.data?.items.length ? (
        <table className="data">
          <tbody>
            {invs.data.items.map((i) => (
              <tr key={i.id}>
                <td>
                  <Link to={`/o/invoice/${i.id}`}>{String(i.invoice_number ?? 'Draft')}</Link> <span className="muted small">{i.doc_type === 'credit_note' ? 'credit note' : ''}</span>
                </td>
                <td>
                  <span className={`chip ${STATUS_CLS[String(i.status)]}`}>{String(i.status).replace(/_/g, ' ')}</span>
                </td>
                <td className="num">{money2(i.grand_total)}</td>
                <td className="num small">{Number(i.balance_due) > 0 && i.status !== 'draft' ? `${money2(i.balance_due)} due` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {open ? 'Not invoiced yet. Invoice per milestone from the table below, or invoice the remaining items.' : 'Confirm the order to invoice it.'}
        </p>
      )}
      {canEdit && open && milestones.some((m) => !m.invoice_id && m.status !== 'waived') && (
        <div className="row small" style={{ flexWrap: 'wrap' }}>
          Invoice a milestone:
          {milestones
            .filter((m) => !m.invoice_id && m.status !== 'waived')
            .map((m) => (
              <button key={m.id} className="btn sm ghost" onClick={() => make(m.id)}>
                {m.name} ({money2(m.amount)})
              </button>
            ))}
        </div>
      )}
      {open && <PaymentLinks salesOrderId={orderId} milestones={milestones} due={Number(order.balance_due ?? 0)} canCreate={canEdit} />}
      {paying && <PaymentModal orderId={orderId} accountId={order.account_id} onClose={() => setPaying(false)} onDone={() => act(async () => undefined, 'Order updated')} />}
    </div>
  );
}

/** /billing — receivables, GST returns, Tally sync and export, and billing settings. */
export function BillingPage({ isAccounts }: { isAccounts: boolean }) {
  const [tab, setTab] = useState<'ar' | 'gst' | 'deposits' | 'tally' | 'settings'>('ar');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Billing</h1>
          <p>Receivables, GST returns and accounting exports.</p>
        </div>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist">
          {(
            [
              ['ar', 'Receivables'],
              ['gst', 'GST returns'],
              ['deposits', 'Deposits & guarantees'],
              ['tally', 'Tally'],
              ['settings', 'Settings'],
            ] as const
          )
            .filter(([k]) => k === 'ar' || isAccounts)
            .map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
        </div>
        {tab === 'ar' && <Receivables />}
        {tab === 'gst' && <GstReturns />}
        {tab === 'deposits' && (
          <div className="panel-body">
            <Deposits />
          </div>
        )}
        {tab === 'tally' && (
          <>
            <TallySync />
            <h3 style={{ margin: '0 16px' }}>Manual export</h3>
            <TallyExport />
          </>
        )}
        {tab === 'settings' && <BillingSettingsForm />}
      </section>
    </>
  );
}

function Receivables() {
  const { data } = useQuery({ queryKey: ['receivables'], queryFn: () => get<{ items: Json[]; totals: Json }>('/api/v1/billing/receivables') });
  if (!data) return <div className="panel-body">Loading…</div>;
  const t = data.totals;
  const cols: [string, string][] = [['not_due', 'Not due'], ['d1_30', '1–30 days'], ['d31_60', '31–60'], ['d61_90', '61–90'], ['d90', '90+']];
  return (
    <div className="panel-body stack">
      <div className="kpis" style={{ margin: 0 }}>
        <div className="panel kpi">
          <div className="l">Outstanding</div>
          <div className="v">{money2(t.outstanding ?? 0)}</div>
        </div>
        <div className="panel kpi">
          <div className="l">Overdue 30+ days</div>
          <div className="v" style={{ color: (t.d31_60 ?? 0) + (t.d61_90 ?? 0) + (t.d90 ?? 0) > 0 ? 'var(--bad)' : undefined }}>{money2((t.d31_60 ?? 0) + (t.d61_90 ?? 0) + (t.d90 ?? 0))}</div>
        </div>
        <div className="panel kpi">
          <div className="l">Advances not yet applied</div>
          <div className="v">{money2(t.unapplied ?? 0)}</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Customer</th>
              <th className="num">Outstanding</th>
              {cols.map(([, l]) => (
                <th key={l} className="num">
                  {l}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => (
              <tr key={r.account_id}>
                <td>
                  <Link to={`/o/account/${r.account_id}`}>{r.name}</Link>
                  <div className="muted small">{r.invoices} open invoices</div>
                </td>
                <td className="num">
                  <b>{money2(r.outstanding)}</b>
                </td>
                {cols.map(([k]) => (
                  <td key={k} className="num" style={{ color: k !== 'not_due' && r[k] ? 'var(--bad)' : undefined }}>
                    {r[k] ? money2(r[k]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
            {!data.items.length && (
              <tr>
                <td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
                  Nothing outstanding.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GstReturns() {
  const toast = useToast();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data } = useQuery({ queryKey: ['gstr1', month], queryFn: () => get<Json>(`/api/v1/billing/gstr1?month=${month}`) });
  const dl = (section: string) => download(`/api/v1/billing/gstr1?month=${month}&section=${section}`, `GSTR1-${section}-${month}.csv`).catch((e) => toast((e as Error).message, true));
  return (
    <div className="panel-body stack">
      <label className="field" style={{ maxWidth: 200 }}>
        Return period
        <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
      </label>
      {data && (
        <div className="kpis" style={{ margin: 0 }}>
          <div className="panel kpi">
            <div className="l">Invoices</div>
            <div className="v">{data.invoices}</div>
            <div className="muted small">
              {data.b2b} B2B · {data.b2c} B2C · {data.credit_notes} credit notes
            </div>
          </div>
          <div className="panel kpi">
            <div className="l">Taxable value</div>
            <div className="v">{money2(data.taxable)}</div>
          </div>
          <div className="panel kpi">
            <div className="l">CGST + SGST</div>
            <div className="v">{money2(data.cgst + data.sgst)}</div>
          </div>
          <div className="panel kpi">
            <div className="l">IGST</div>
            <div className="v">{money2(data.igst)}</div>
          </div>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {[
          ['b2b', 'B2B invoices (4A)'],
          ['b2cs', 'B2C small (7)'],
          ['cdnr', 'Credit notes, registered (9B)'],
          ['hsn', 'HSN summary (12)'],
        ].map(([k, l]) => (
          <button key={k} className="btn" onClick={() => dl(k!)}>
            Download {l}
          </button>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        CSV files in the GST offline tool's format. Review them with your CA before filing; cancelled and draft invoices are excluded.
      </p>
    </div>
  );
}

function TallyExport() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  return (
    <div className="panel-body stack">
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label className="field">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div>
        <button className="btn primary" onClick={() => download(`/api/v1/billing/tally?from=${from}&to=${to}`, `tally-${from}-to-${to}.xml`).catch((e) => toast((e as Error).message, true))}>
          Download Tally XML
        </button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Sales, credit-note and receipt vouchers with party, sales and GST ledgers. In Tally: Gateway → Import → Vouchers. Ledger names come from Settings; create matching ledgers in Tally first.
      </p>
    </div>
  );
}

function BillingSettingsForm() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['billing-settings'], queryFn: () => get<Json>('/api/v1/billing/settings') });
  const [f, setF] = useState<Json | null>(null);
  if (!data) return <div className="panel-body">Loading…</div>;
  const v = f ?? data;
  const set = (k: string, val: unknown) => setF({ ...v, [k]: val });
  const setL = (k: string, val: string) => setF({ ...v, ledgers: { ...v.ledgers, [k]: val } });
  return (
    <div className="panel-body stack" style={{ maxWidth: 720 }}>
      <div className="grid2">
        <label className="field">
          Invoice prefix
          <input value={v.invoicePrefix} maxLength={5} onChange={(e) => set('invoicePrefix', e.target.value)} />
        </label>
        <label className="field">
          Credit note prefix
          <input value={v.creditNotePrefix} maxLength={5} onChange={(e) => set('creditNotePrefix', e.target.value)} />
        </label>
        <label className="field">
          Receipt prefix
          <input value={v.receiptPrefix} maxLength={5} onChange={(e) => set('receiptPrefix', e.target.value)} />
        </label>
        <label className="field">
          Payment terms (days)
          <input type="number" min={0} value={v.dueDays} onChange={(e) => set('dueDays', Number(e.target.value))} />
        </label>
        <label className="row wide">
          <input type="checkbox" checked={v.roundOff} onChange={(e) => set('roundOff', e.target.checked)} /> Round invoice totals to the nearest rupee
        </label>
        <label className="field wide">
          Bank details (printed on invoices)
          <textarea value={v.bankDetails} onChange={(e) => set('bankDetails', e.target.value)} placeholder={'Bank: HDFC Bank, Andheri East\nA/c: 50200012345678 · IFSC: HDFC0000123\nUPI: elvmcraft@hdfcbank'} />
        </label>
        <label className="field">
          UPI ID for the pay-by-QR on invoices
          <input value={v.upiVpa ?? ''} onChange={(e) => set('upiVpa', e.target.value.trim())} placeholder="business@okhdfcbank" />
        </label>
        <label className="field">
          Payee name shown in UPI apps
          <input value={v.upiPayee ?? ''} maxLength={50} onChange={(e) => set('upiPayee', e.target.value)} placeholder="Your business name" />
        </label>
        <h3 className="wide">Tally ledger names</h3>
        {(
          [
            ['sales', 'Sales'],
            ['cgst', 'CGST'],
            ['sgst', 'SGST'],
            ['igst', 'IGST'],
            ['roundOff', 'Round off'],
            ['bank', 'Bank (receipts)'],
            ['tds', 'TDS deducted by customers'],
            ['gstTds', 'GST TDS (section 51)'],
            ['ld', 'Liquidated damages / penalty'],
            ['retention', 'Retention money'],
            ['bankCharges', 'Bank charges'],
          ] as const
        ).map(([k, l]) => (
          <label key={k} className="field">
            {l}
            <input value={v.ledgers[k] ?? ''} onChange={(e) => setL(k, e.target.value)} />
          </label>
        ))}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        Numbers run per financial year (INV/26-27/0001) and restart every April. Your GSTIN, state and address come from Settings → Sales setup.
      </p>
      <div>
        <button
          className="btn primary"
          disabled={!f}
          onClick={async () => {
            try {
              await put('/api/admin/billing/settings', { invoicePrefix: v.invoicePrefix, creditNotePrefix: v.creditNotePrefix, receiptPrefix: v.receiptPrefix, dueDays: v.dueDays, roundOff: v.roundOff, bankDetails: v.bankDetails, upiVpa: v.upiVpa ?? '', upiPayee: v.upiPayee ?? '', ledgers: v.ledgers });
              toast('Billing settings saved');
              setF(null);
              qc.invalidateQueries({ queryKey: ['billing-settings'] });
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Save settings
        </button>
      </div>
    </div>
  );
}
