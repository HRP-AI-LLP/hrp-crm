import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { get, post, put } from '../../lib/api';
import { date, dateTime, money2 } from '../../lib/format';
import { useMeta } from '../../lib/hooks';
import { Modal, useToast } from '../ui';
import { type DocLine, LinesEditor, toLineInput } from './LinesEditor';

type Json = Record<string, any>;
const PO_LABEL: Record<string, string> = { draft: 'Draft', sent: 'Issued', partially_received: 'Partly received', received: 'Received', closed: 'Closed', cancelled: 'Cancelled' };

/** Purchase order workspace: lines at cost, issue (approval-aware), goods receipts. */
export function PoPanel({ poId, canEdit }: { poId: string; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['po', poId], queryFn: () => get<Json>(`/api/v1/purchase-orders/${poId}`) });
  const [receiving, setReceiving] = useState(false);
  if (!data) return null;
  const p = data.po;
  const status = String(p.status);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['po', poId] });
    qc.invalidateQueries({ queryKey: ['record', 'purchase_order', poId] });
    qc.invalidateQueries({ queryKey: ['timeline', 'purchase_order', poId] });
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
  const blocked = ['required', 'pending', 'rejected'].includes(String(p.approval_status));
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {p.po_number} <span className={`chip ${status === 'received' ? 'good' : status === 'cancelled' ? 'bad' : 'info'}`}>{PO_LABEL[status]}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <a className="btn sm" href={`/print/purchase_order/${poId}`} target="_blank" rel="noreferrer">
            Preview / PDF
          </a>
          {canEdit && status === 'draft' && (
            <button className="btn sm primary" disabled={blocked || !data.lines.length} title={blocked ? 'Needs approval first' : undefined} onClick={() => act(() => post(`/api/v1/purchase-orders/${poId}/issue`), 'Purchase order issued')}>
              Issue to vendor
            </button>
          )}
          {canEdit && ['sent', 'partially_received'].includes(status) && (
            <button className="btn sm primary" onClick={() => setReceiving(true)}>
              Receive goods
            </button>
          )}
          {canEdit && ['sent', 'partially_received'].includes(status) && (
            <button className="btn sm" onClick={() => window.confirm('Close this PO? Quantities not received are dropped.') && act(() => post(`/api/v1/purchase-orders/${poId}/close`, { cancel: false }), 'Purchase order closed')}>
              Close short
            </button>
          )}
          {canEdit && ['draft', 'sent'].includes(status) && (
            <button
              className="btn sm danger"
              onClick={() => {
                const reason = window.prompt('Why is this purchase order cancelled?');
                if (reason) void act(() => post(`/api/v1/purchase-orders/${poId}/close`, { cancel: true, reason }), 'Purchase order cancelled');
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {data.vendor && (
          <p className="small" style={{ margin: 0 }}>
            Vendor: <b>{data.vendor.name}</b>
            {data.vendor.gstin ? ` · GSTIN ${data.vendor.gstin}` : ''}
            {data.vendor.payment_terms_days ? ` · pays in ${data.vendor.payment_terms_days} days` : ''}
            {p.expected_date ? ` · expected ${date(p.expected_date)}` : ''}
          </p>
        )}
        <LinesEditor
          lines={data.lines as DocLine[]}
          locked={!canEdit || status !== 'draft'}
          priceFrom="cost_price"
          currency={p.currency}
          extraCols={status === 'draft' ? [] : [{ key: 'receivedQty', label: 'Received' }, { key: 'rejectedQty', label: 'Rejected' }]}
          saveLabel="Save PO"
          onSave={async (lines) => {
            await act(() => put(`/api/v1/purchase-orders/${poId}/lines`, { lines: lines.map(toLineInput) }), 'Purchase order saved');
          }}
        />
        {data.receipts.length > 0 && (
          <>
            <h3>Goods receipts</h3>
            <table className="data">
              <thead>
                <tr>
                  <th>Receipt</th>
                  <th>Received</th>
                  <th>Into</th>
                  <th>Vendor invoice</th>
                  <th>Lines</th>
                </tr>
              </thead>
              <tbody>
                {data.receipts.map((g: Json) => (
                  <tr key={g.id}>
                    <td>
                      <b>{g.receipt_number}</b>
                      <div className="muted small">{g.received_by ?? ''} · {dateTime(g.created_at)}</div>
                    </td>
                    <td>{date(g.received_on)}</td>
                    <td>{g.warehouse_name}</td>
                    <td>{g.vendor_invoice ?? '—'}</td>
                    <td className="small">
                      {g.lines.map((l: Json, i: number) => {
                        const pl = data.lines.find((x: Json) => x.id === l.poLineId);
                        return (
                          <div key={i}>
                            {pl?.name ?? 'Item'}: {Number(l.received)} accepted{Number(l.rejected) ? `, ${Number(l.rejected)} rejected${l.reason ? ` (${l.reason})` : ''}` : ''}
                          </div>
                        );
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      {receiving && <ReceiveModal po={p} lines={data.lines} onClose={() => setReceiving(false)} onDone={() => { setReceiving(false); refresh(); }} />}
    </section>
  );
}

function ReceiveModal({ po, lines, onClose, onDone }: { po: Json; lines: Json[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { data: meta } = useMeta();
  const whChoices = meta?.objects.find((o) => o.key === 'purchase_order')?.fields.find((f) => f.key === 'warehouse_id')?.options?.choices ?? [];
  const [wh, setWh] = useState<string>(po.warehouse_id ?? whChoices[0]?.value ?? '');
  const [invoice, setInvoice] = useState('');
  const [rows, setRows] = useState(lines.map((l) => ({ id: l.id, name: l.name, open: Number(l.quantity) - Number(l.receivedQty ?? 0), received: String(Math.max(0, Number(l.quantity) - Number(l.receivedQty ?? 0))), rejected: '', reason: '' })));
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Receive goods"
      wide
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ receiptNumber: string }>(`/api/v1/purchase-orders/${po.id}/receive`, {
                warehouseId: wh || null,
                vendorInvoice: invoice || null,
                lines: rows.map((r) => ({ poLineId: r.id, received: Number(r.received) || 0, rejected: Number(r.rejected) || 0, reason: r.reason || null })),
              });
              toast(`${r.receiptNumber} saved — stock updated`);
              onDone();
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
      <div className="modal-body" style={{ display: 'block' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          <label className="field" style={{ minWidth: 220 }}>
            Into warehouse
            <select value={wh} onChange={(e) => setWh(e.target.value)}>
              {whChoices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 200 }}>
            Vendor invoice / challan no.
            <input value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </label>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Open</th>
              <th className="num">Accepted</th>
              <th className="num">Rejected</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td className="num">{r.open}</td>
                <td>
                  <input className="num" inputMode="decimal" aria-label={`Accepted ${r.name}`} value={r.received} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, received: e.target.value } : x)))} />
                </td>
                <td>
                  <input className="num" inputMode="decimal" aria-label={`Rejected ${r.name}`} value={r.rejected} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, rejected: e.target.value } : x)))} />
                </td>
                <td>
                  <input aria-label={`Reason ${r.name}`} value={r.reason} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} placeholder="Damaged, wrong size…" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">Accepted quantities go into stock at the PO rate (which also becomes the product's cost price). Rejections count against the vendor's quality score.</p>
      </div>
    </Modal>
  );
}

/** Vendor scorecard: punctuality, quality, lead time, spend. */
export function VendorScorecard({ vendorId }: { vendorId: string }) {
  const { data } = useQuery({ queryKey: ['vendor-perf', vendorId], queryFn: () => get<Json>(`/api/v1/vendors/${vendorId}/performance`) });
  if (!data) return null;
  const stars = data.rating === null ? null : Math.round(data.rating);
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>Vendor performance</h2>
        {stars !== null && (
          <span title={`${data.rating} / 5`} aria-label={`Rating ${data.rating} out of 5`} style={{ color: '#f59e0b', letterSpacing: 2 }}>
            {'★'.repeat(stars)}
            <span style={{ color: 'var(--line)' }}>{'★'.repeat(5 - stars)}</span>
          </span>
        )}
      </div>
      <div className="kpis" style={{ margin: 0, padding: 14 }}>
        <div className="kpi">
          <div className="l">On-time deliveries</div>
          <div className="v">{data.onTimePct === null ? '—' : `${data.onTimePct}%`}</div>
          <div className="muted small">{data.overdue ? `${data.overdue} open POs overdue` : 'No overdue POs'}</div>
        </div>
        <div className="kpi">
          <div className="l">Rejection rate</div>
          <div className="v">{data.rejectionPct === null ? '—' : `${data.rejectionPct}%`}</div>
          <div className="muted small">
            {data.rejected} of {data.received + data.rejected} units
          </div>
        </div>
        <div className="kpi">
          <div className="l">Avg. lead time</div>
          <div className="v">{data.avg_lead_days === null ? '—' : `${data.avg_lead_days} d`}</div>
          <div className="muted small">PO date → first receipt</div>
        </div>
        <div className="kpi">
          <div className="l">Purchases</div>
          <div className="v">{money2(data.spend)}</div>
          <div className="muted small">
            {data.orders} POs{data.last_order ? ` · last ${date(data.last_order)}` : ''}
          </div>
        </div>
      </div>
    </section>
  );
}
