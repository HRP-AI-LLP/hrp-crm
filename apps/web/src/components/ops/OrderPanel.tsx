import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { useMeta } from '../../lib/hooks';
import { Modal, useToast } from '../ui';
import { type DocLine, LinesEditor, toLineInput } from './LinesEditor';
import { OrderFulfilment } from './FieldPanels';
import { OrderBilling } from './BillingPanels';

type Json = Record<string, any>;
const FLOW = ['draft', 'confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed', 'completed'];
const LABEL: Record<string, string> = {
  draft: 'Draft', confirmed: 'Confirmed', in_production: 'In production', ready: 'Ready', dispatched: 'Dispatched',
  delivered: 'Delivered', installed: 'Installed', completed: 'Completed', cancelled: 'Cancelled',
};
const NEXT: Record<string, string[]> = {
  confirmed: ['in_production', 'ready', 'dispatched'],
  in_production: ['ready'],
  ready: ['dispatched'],
  dispatched: ['delivered'],
  delivered: ['installed', 'completed'],
  installed: ['completed'],
};
const TRIGGER: Record<string, string> = { on_confirmation: 'On confirmation', before_dispatch: 'Before dispatch', on_delivery: 'On delivery', on_installation: 'After installation', on_date: 'On a date' };

export function useApps() {
  const { data: meta } = useMeta();
  return new Set((meta?.modules ?? []).filter((m) => m.enabled && m.key.startsWith('app.')).map((m) => m.key.slice(4)));
}

/** Sales order workspace: status flow, lines, payment milestones and follow-on actions. */
export function OrderPanel({ orderId, canEdit }: { orderId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const apps = useApps();
  const { data } = useQuery({ queryKey: ['order', orderId], queryFn: () => get<Json>(`/api/v1/orders/${orderId}`) });
  const [ms, setMs] = useState<Json[] | null>(null);
  const [paying, setPaying] = useState<Json | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [poFor, setPoFor] = useState(false);
  if (!data) return null;
  const o = data.order;
  const status = String(o.status);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['order', orderId] });
    qc.invalidateQueries({ queryKey: ['record', 'sales_order', orderId] });
    qc.invalidateQueries({ queryKey: ['timeline', 'sales_order', orderId] });
    qc.invalidateQueries({ queryKey: ['records', 'sales_order'] });
  };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      refresh();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  const idx = FLOW.indexOf(status);

  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          Order {o.order_number} <span className={`chip ${status === 'cancelled' ? 'bad' : status === 'completed' ? 'good' : 'info'}`}>{LABEL[status]}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn sm" href={`/print/sales_order/${orderId}`} target="_blank" rel="noreferrer">
            Order confirmation / PDF
          </a>
          {canEdit && status === 'draft' && (
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/orders/${orderId}/confirm`), 'Order confirmed')}>
              Confirm order
            </button>
          )}
          {canEdit &&
            (NEXT[status] ?? [])
              // with the delivery app, deliveries move the order to dispatched / delivered
              .filter((s) => !apps.has('delivery') || !['dispatched', 'delivered'].includes(s))
              .map((s) => (
              <button key={s} className="btn sm" onClick={() => act(() => post(`/api/v1/orders/${orderId}/status`, { status: s }), `Marked ${LABEL[s]!.toLowerCase()}`)}>
                Mark {LABEL[s]!.toLowerCase()}
              </button>
            ))}
          {canEdit && ['confirmed', 'in_production', 'ready', 'dispatched'].includes(status) && !apps.has('delivery') && (
            <button className="btn sm" title="Ship everything still open from the order's warehouse" onClick={() => window.confirm('Ship all open items from stock and mark the order delivered?') && act(() => post(`/api/v1/orders/${orderId}/deliver`), 'Delivered from stock')}>
              Deliver from stock
            </button>
          )}
          {canEdit && ['confirmed', 'in_production', 'ready'].includes(status) && o.fulfilment_status === 'unfulfilled' && (
            <button className="btn sm ghost" onClick={() => window.confirm('Back to draft to change lines? Reserved stock is released.') && act(() => post(`/api/v1/orders/${orderId}/reopen`), 'Back to draft')}>
              Reopen
            </button>
          )}
          {canEdit && apps.has('purchasing') && !['draft', 'cancelled', 'completed'].includes(status) && (
            <button className="btn sm" onClick={() => setPoFor(true)}>
              Order from vendor
            </button>
          )}
          {canEdit && !['cancelled', 'completed', 'delivered', 'installed'].includes(status) && o.fulfilment_status === 'unfulfilled' && (
            <button className="btn sm danger" onClick={() => setCancelling(true)}>
              Cancel order
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {status !== 'cancelled' && (
          <ol className="order-flow" aria-label="Order progress">
            {FLOW.filter((s) => s !== 'installed' || o.installation_required || status === 'installed').map((s) => (
              <li key={s} className={FLOW.indexOf(s) < idx ? 'done' : s === status ? 'current' : ''}>
                {LABEL[s]}
              </li>
            ))}
          </ol>
        )}
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <span className="small">
            Fulfilment: <b>{String(o.fulfilment_status).replace(/_/g, ' ')}</b>
          </span>
          <span className="small">
            Payment: <b>{String(o.payment_status).replace(/_/g, ' ')}</b> · paid {money2(o.amount_paid)} of {money2(o.grand_total)}
          </span>
          {o.expected_delivery_date && <span className="small">Expected delivery {date(o.expected_delivery_date)}</span>}
        </div>
        <LinesEditor
          lines={data.lines as DocLine[]}
          locked={!canEdit || status !== 'draft'}
          priceFrom="list_price"
          currency={o.currency}
          extraCols={status === 'draft' ? [] : [{ key: 'reservedQty', label: 'Reserved' }, { key: 'shippedQty', label: 'Shipped' }, { key: 'deliveredQty', label: 'Delivered' }]}
          saveLabel="Save order"
          onSave={async (lines) => {
            await act(() => put(`/api/v1/orders/${orderId}/lines`, { lines: lines.map(toLineInput) }), 'Order saved');
          }}
        />

        {apps.has('delivery') && <OrderFulfilment order={o} lines={data.lines} canEdit={canEdit} />}
        {apps.has('billing') && <OrderBilling order={o} milestones={data.milestones} canEdit={canEdit} />}
        <div className="spread" style={{ marginTop: 6 }}>
          <h3>Payment milestones</h3>
          {canEdit && !['cancelled', 'completed'].includes(status) && (
            <button className="btn sm" onClick={() => setMs(data.milestones.length ? data.milestones.map((m: Json) => ({ ...m, dueDate: m.due_date ? String(m.due_date).slice(0, 10) : '' })) : [{ name: 'Advance', percent: 50, trigger: 'on_confirmation' }, { name: 'Before dispatch', percent: 40, trigger: 'before_dispatch' }, { name: 'After installation', percent: 10, trigger: 'on_installation' }])}>
              {data.milestones.length ? 'Edit milestones' : 'Plan milestones'}
            </button>
          )}
        </div>
        {data.milestones.length ? (
          <table className="data">
            <thead>
              <tr>
                <th>Milestone</th>
                <th>When</th>
                <th className="num">Amount</th>
                <th className="num">Received</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.milestones.map((m: Json) => (
                <tr key={m.id}>
                  <td>
                    <b>{m.name}</b>
                    {m.percent ? <span className="muted small"> · {m.percent}%</span> : null}
                  </td>
                  <td className="small">
                    {TRIGGER[m.trigger]}
                    {m.due_date ? ` · ${date(m.due_date)}` : ''}
                  </td>
                  <td className="num">{money2(m.amount)}</td>
                  <td className="num">{money2(m.amount_paid)}</td>
                  <td>
                    <span className={`chip ${m.status === 'paid' ? 'good' : m.status === 'due' ? 'warn' : ''}`}>{m.status}</span>
                  </td>
                  <td>
                    {canEdit && m.status !== 'paid' && m.status !== 'waived' && (
                      <button
                        className="btn sm"
                        onClick={() => {
                          setPaying(m);
                          setAmount(String(Math.round((m.amount - m.amount_paid) * 100) / 100));
                          setNote('');
                        }}
                      >
                        Record payment
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small" style={{ margin: 0 }}>
            No milestones yet — e.g. 50% advance, 40% before dispatch, 10% after installation.
          </p>
        )}
      </div>

      {ms && (
        <Modal
          title="Payment milestones"
          wide
          onClose={() => setMs(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                const ok = await act(
                  () =>
                    put(`/api/v1/orders/${orderId}/milestones`, {
                      milestones: ms.map((m) => ({ name: m.name, percent: m.percent ? Number(m.percent) : null, amount: m.percent ? null : Number(m.amount ?? 0), trigger: m.trigger, dueDate: m.dueDate || null })),
                    }),
                  'Milestones saved',
                );
                if (ok) setMs(null);
              }}
            >
              Save milestones
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <p className="muted small" style={{ marginTop: 0 }}>
              Order total {money2(o.grand_total)}. Use a percentage (follows the total) or a fixed amount. Total so far: {ms.reduce((s, m) => s + Number(m.percent || 0), 0)}%
            </p>
            {ms.map((m, i) => (
              <div key={i} className="filter-row" style={{ gridTemplateColumns: '1.4fr 80px 110px 1.2fr 130px 34px' }}>
                <input aria-label="Name" value={m.name} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <input aria-label="Percent" placeholder="%" inputMode="decimal" value={m.percent ?? ''} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, percent: e.target.value, amount: null } : x)))} />
                <input aria-label="Amount" placeholder="or ₹" inputMode="decimal" value={m.percent ? '' : (m.amount ?? '')} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, amount: e.target.value, percent: null } : x)))} />
                <select aria-label="When" value={m.trigger} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, trigger: e.target.value } : x)))}>
                  {Object.entries(TRIGGER).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <input aria-label="Due date" type="date" value={m.dueDate ?? ''} onChange={(e) => setMs(ms.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
                <button className="btn ghost sm" aria-label="Remove" onClick={() => setMs(ms.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setMs([...ms, { name: '', percent: '', trigger: 'on_date' }])}>
              Add milestone
            </button>
          </div>
        </Modal>
      )}
      {paying && (
        <Modal
          title={`Payment for “${paying.name}”`}
          onClose={() => setPaying(null)}
          footer={
            <button
              className="btn primary"
              disabled={!(Number(amount) > 0)}
              onClick={async () =>
                (await act(() => post(`/api/v1/orders/${orderId}/milestones/${paying.id}/${apps.has('billing') ? 'receipt' : 'payments'}`, { amount: Number(amount), note: note || null }), apps.has('billing') ? 'Receipt saved' : 'Payment recorded')) &&
                setPaying(null)
              }
            >
              Record payment
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Amount received (₹)
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </label>
            <label className="field">
              Reference
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="UPI ref, cheque no., bank transfer…" />
            </label>
          </div>
        </Modal>
      )}
      {cancelling && (
        <Modal
          title="Cancel order"
          onClose={() => setCancelling(false)}
          footer={
            <button className="btn danger" disabled={!reason.trim()} onClick={async () => (await act(() => post(`/api/v1/orders/${orderId}/status`, { status: 'cancelled', reason }), 'Order cancelled')) && setCancelling(false)}>
              Cancel order
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <p style={{ marginTop: 0 }}>Reserved stock goes back to available, and open milestones are waived.</p>
            <label className="field">
              Reason
              <input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
            </label>
          </div>
        </Modal>
      )}
      {poFor && <PoFromOrderModal orderId={orderId} lines={data.lines} onClose={() => setPoFor(false)} onDone={(id) => nav(`/o/purchase_order/${id}`)} />}
    </section>
  );
}

function PoFromOrderModal({ orderId, lines, onClose, onDone }: { orderId: string; lines: Json[]; onClose: () => void; onDone: (id: string) => void }) {
  const toast = useToast();
  const { data: vendors } = useQuery({ queryKey: ['records', 'vendor', 'all'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/vendor?limit=200') });
  const [vendorId, setVendorId] = useState('');
  const [picked, setPicked] = useState<string[]>(lines.map((l) => l.id));
  return (
    <Modal
      title="Order from a vendor"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!vendorId || !picked.length}
          onClick={async () => {
            try {
              const r = await post<{ id: string }>(`/api/v1/purchase-orders/from-order/${orderId}`, { vendorId, lineIds: picked });
              toast('Purchase order drafted');
              onDone(r.id);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Draft purchase order
        </button>
      }
    >
      <div className="modal-body" style={{ display: 'block' }}>
        <label className="field">
          Vendor
          <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Choose…</option>
            {vendors?.items.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title}
              </option>
            ))}
          </select>
        </label>
        <div className="stack" style={{ gap: 6, marginTop: 12 }}>
          {lines.map((l) => (
            <label key={l.id} className="row small">
              <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />
              {l.name} × {l.quantity}
            </label>
          ))}
        </div>
        <p className="muted small">Lines are copied at each product's cost price; adjust them on the purchase order.</p>
      </div>
    </Modal>
  );
}
