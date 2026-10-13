import type { RecordDto } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../lib/api';
import { date, dateTime, relative } from '../../lib/format';
import { useUsers } from '../../lib/hooks';
import { FilesPanel } from '../Files';
import { Modal, useToast } from '../ui';

type Json = Record<string, any>;
const SHIP_FLOW = ['planned', 'packed', 'dispatched', 'delivered'];
const JOB_LABEL: Record<string, string> = { scheduled: 'Scheduled', in_progress: 'In progress', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const ISSUES: Record<string, string> = {
  site_not_ready: 'Site not ready', customer_unavailable: 'Customer unavailable', missing_parts: 'Missing parts', damaged_item: 'Damaged item', measurement_mismatch: 'Measurement mismatch', other: 'Other',
};

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
}

function CopyLink({ path, label }: { path: string; label: string }) {
  const toast = useToast();
  return (
    <button
      className="btn sm"
      onClick={async () => {
        await navigator.clipboard?.writeText(`${location.origin}${path}`).catch(() => undefined);
        toast('Link copied — send it to the customer on WhatsApp or SMS');
      }}
    >
      {label}
    </button>
  );
}

// ------------------------------------------------------------------------------------- shipment
export function ShipmentPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['shipment', id], queryFn: () => get<Json>(`/api/v1/shipments/${id}`) });
  const act = useAct([['shipment', id], ['record', 'shipment', id], ['timeline', 'shipment', id]]);
  const [modal, setModal] = useState<null | 'dispatch' | 'deliver' | 'fail'>(null);
  const [f, setF] = useState<Json>({});
  if (!data) return null;
  const s = data.shipment;
  const status = String(s.status);
  const idx = SHIP_FLOW.indexOf(status);
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {s.shipment_number} <span className={`chip ${status === 'delivered' ? 'good' : status === 'failed' || status === 'cancelled' ? 'bad' : 'info'}`}>{status}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {['dispatched', 'delivered'].includes(status) && s.share_token && <CopyLink path={`/d/${s.share_token}`} label="Copy customer link" />}
          {canEdit && status === 'planned' && (
            <button className="btn sm" onClick={() => act(() => post(`/api/v1/shipments/${id}/pack`), 'Marked packed')}>
              Mark packed
            </button>
          )}
          {canEdit && ['planned', 'packed'].includes(status) && (
            <button className="btn sm primary" onClick={() => { setF({ vehicleNo: s.vehicle_no ?? '', driverName: s.driver_name ?? '', driverPhone: s.driver_phone ?? '', trackingRef: s.tracking_ref ?? '' }); setModal('dispatch'); }}>
              Dispatch
            </button>
          )}
          {canEdit && status === 'dispatched' && (
            <>
              <button className="btn sm primary" onClick={() => { setF({ receivedBy: '', notes: '' }); setModal('deliver'); }}>
                Mark delivered
              </button>
              <button className="btn sm danger" onClick={() => { setF({ reason: '' }); setModal('fail'); }}>
                Delivery failed
              </button>
            </>
          )}
          {canEdit && ['planned', 'packed'].includes(status) && (
            <button className="btn sm ghost" onClick={() => window.confirm('Cancel this delivery?') && act(() => post(`/api/v1/shipments/${id}/cancel`), 'Delivery cancelled')}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {idx >= 0 && (
          <ol className="order-flow">
            {SHIP_FLOW.map((x, i) => (
              <li key={x} className={i < idx ? 'done' : i === idx ? 'current' : ''}>
                {x[0]!.toUpperCase() + x.slice(1)}
              </li>
            ))}
          </ol>
        )}
        {status === 'failed' && <div className="notice small">Delivery failed: {s.exception_reason}. The goods are back in stock and reserved for the order — plan a new delivery from the order.</div>}
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          {s.planned_date && <span>Planned {date(s.planned_date)}</span>}
          {s.vehicle_no && <span>Vehicle {s.vehicle_no}</span>}
          {s.driver_name && (
            <span>
              Driver {s.driver_name}
              {s.driver_phone ? ` · ${s.driver_phone}` : ''}
            </span>
          )}
          {s.dispatched_at && <span>Dispatched {dateTime(s.dispatched_at)}</span>}
          {s.delivered_at && <span>Delivered {dateTime(s.delivered_at)}{s.received_by ? ` to ${s.received_by}` : ''}</span>}
        </div>
        <table className="data">
          <tbody>
            {data.lines.map((l: Json) => (
              <tr key={l.id}>
                <td>{l.name}</td>
                <td className="num">
                  {l.quantity} {l.unit ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.confirmed_at && (
          <p className="notice small" style={{ margin: 0 }}>
            Confirmed by {s.confirmed_by} {relative(s.confirmed_at)}
            {s.customer_rating ? ` · ${'★'.repeat(s.customer_rating)}` : ''}
            {s.customer_feedback ? ` — “${s.customer_feedback}”` : ''}
          </p>
        )}
      </div>
      {['dispatched', 'delivered'].includes(status) && <FilesPanel object="shipment" id={id} canEdit={canEdit} title="Proof of delivery — drop photos or the signed challan" />}
      {modal && (
        <Modal
          title={modal === 'dispatch' ? 'Dispatch' : modal === 'deliver' ? 'Mark delivered' : 'Delivery failed'}
          onClose={() => setModal(null)}
          footer={
            <button
              className={`btn ${modal === 'fail' ? 'danger' : 'primary'}`}
              disabled={modal === 'fail' && (f.reason ?? '').trim().length < 3}
              onClick={async () => {
                const ok = await act(() => post(`/api/v1/shipments/${id}/${modal}`, f), modal === 'dispatch' ? 'Dispatched — stock updated' : modal === 'deliver' ? 'Delivered' : 'Recorded; goods back in stock');
                if (ok) setModal(null);
              }}
            >
              {modal === 'dispatch' ? 'Dispatch now' : modal === 'deliver' ? 'Mark delivered' : 'Record failure'}
            </button>
          }
        >
          <div className="modal-body">
            {modal === 'dispatch' &&
              (
                [
                  ['vehicleNo', 'Vehicle no.'],
                  ['driverName', 'Driver'],
                  ['driverPhone', 'Driver phone'],
                  ['trackingRef', 'Tracking / LR no.'],
                ] as const
              ).map(([k, l]) => (
                <label key={k} className="field">
                  {l}
                  <input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
                </label>
              ))}
            {modal === 'deliver' && (
              <>
                <label className="field">
                  Received by
                  <input value={f.receivedBy} onChange={(e) => setF({ ...f, receivedBy: e.target.value })} autoFocus />
                </label>
                <label className="field wide">
                  Notes
                  <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
                </label>
                <p className="wide muted small">Upload photos of the delivered goods or the signed challan as proof afterwards.</p>
              </>
            )}
            {modal === 'fail' && (
              <label className="field wide">
                What went wrong
                <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Customer not at home, wrong address, damaged in transit…" autoFocus />
              </label>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------- installation
export function InstallationPanel({ id, canEdit }: { id: string; canEdit: boolean }) {
  const { data } = useQuery({ queryKey: ['installation', id], queryFn: () => get<Json>(`/api/v1/installations/${id}`) });
  const act = useAct([['installation', id], ['record', 'installation', id], ['timeline', 'installation', id]]);
  const users = useUsers();
  const [modal, setModal] = useState<null | 'hold' | 'complete' | 'cancel' | 'crew'>(null);
  const [f, setF] = useState<Json>({});
  if (!data) return null;
  const j = data.installation;
  const status = String(j.status);
  const items: { label: string; done: boolean }[] = j.checklist ?? [];
  const closed = ['completed', 'cancelled'].includes(status);
  const toggle = (i: number) => act(() => put(`/api/v1/installations/${id}/checklist`, { items: items.map((x, k) => (k === i ? { ...x, done: !x.done } : x)) }), 'Checklist saved');
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>
          {j.job_number} <span className={`chip ${status === 'completed' ? 'good' : status === 'on_hold' ? 'warn' : status === 'cancelled' ? 'bad' : 'info'}`}>{JOB_LABEL[status]}</span>
        </h2>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {!['cancelled'].includes(status) && j.share_token && <CopyLink path={`/i/${j.share_token}`} label="Copy sign-off link" />}
          {canEdit && ['scheduled', 'on_hold'].includes(status) && (
            <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/installations/${id}/start`), 'Job started')}>
              {status === 'on_hold' ? 'Resume' : 'Start job'}
            </button>
          )}
          {canEdit && status === 'in_progress' && (
            <button className="btn sm primary" onClick={() => { setF({ notes: '' }); setModal('complete'); }}>
              Complete
            </button>
          )}
          {canEdit && ['scheduled', 'in_progress'].includes(status) && (
            <button className="btn sm" onClick={() => { setF({ issueType: 'site_not_ready', notes: '' }); setModal('hold'); }}>
              Report a problem
            </button>
          )}
          {canEdit && !closed && (
            <button className="btn sm" onClick={() => { setF({ crewIds: (j.crew ?? []).map((c: Json) => c.id) }); setModal('crew'); }}>
              Crew
            </button>
          )}
          {canEdit && !closed && (
            <button className="btn sm ghost" onClick={() => { setF({ reason: '' }); setModal('cancel'); }}>
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        <div className="row small" style={{ gap: 18, flexWrap: 'wrap' }}>
          {j.scheduled_start && (
            <span>
              {dateTime(j.scheduled_start)}
              {j.scheduled_end ? ` – ${dateTime(j.scheduled_end)}` : ''}
            </span>
          )}
          {j.crew?.length > 0 && <span>Crew: {j.crew.map((c: Json) => c.full_name).join(', ')}</span>}
          {j.started_at && <span>Started {dateTime(j.started_at)}</span>}
          {j.completed_at && <span>Completed {dateTime(j.completed_at)}</span>}
        </div>
        {status === 'on_hold' && (
          <div className="notice small">
            On hold — {ISSUES[j.issue_type] ?? j.issue_type}: {j.issue_notes}
          </div>
        )}
        <div>
          <h3 style={{ marginBottom: 6 }}>
            Checklist ({items.filter((x) => x.done).length}/{items.length})
          </h3>
          <ul className="checklist">
            {items.map((c, i) => (
              <li key={i}>
                <label className="row">
                  <input type="checkbox" checked={c.done} disabled={!canEdit || closed} onChange={() => toggle(i)} />
                  <span style={{ textDecoration: c.done ? 'line-through' : undefined }}>{c.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        {j.completion_notes && <p className="small" style={{ margin: 0 }}>Notes: {j.completion_notes}</p>}
        {j.confirmed_at && (
          <p className="notice small" style={{ margin: 0 }}>
            Signed off by {j.confirmed_by} {relative(j.confirmed_at)}
            {j.customer_rating ? ` · ${'★'.repeat(j.customer_rating)}` : ''}
            {j.customer_feedback ? ` — “${j.customer_feedback}”` : ''}
          </p>
        )}
      </div>
      <FilesPanel object="installation" id={id} canEdit={canEdit} title="Before / after photos" />
      {modal && (
        <Modal
          title={modal === 'hold' ? 'Report a problem' : modal === 'complete' ? 'Complete the job' : modal === 'crew' ? 'Crew' : 'Cancel the job'}
          onClose={() => setModal(null)}
          footer={
            <button
              className={`btn ${modal === 'cancel' ? 'danger' : 'primary'}`}
              disabled={(modal === 'hold' && (f.notes ?? '').trim().length < 3) || (modal === 'cancel' && (f.reason ?? '').trim().length < 3)}
              onClick={async () => {
                const ok =
                  modal === 'crew'
                    ? await act(() => put(`/api/v1/installations/${id}/crew`, { crewIds: f.crewIds }), 'Crew updated')
                    : await act(() => post(`/api/v1/installations/${id}/${modal}`, f), modal === 'hold' ? 'Job on hold — the team is notified' : modal === 'complete' ? 'Job completed' : 'Job cancelled');
                if (ok) setModal(null);
              }}
            >
              {modal === 'hold' ? 'Put on hold' : modal === 'complete' ? 'Complete' : modal === 'crew' ? 'Save crew' : 'Cancel job'}
            </button>
          }
        >
          <div className="modal-body">
            {modal === 'hold' && (
              <>
                <label className="field">
                  Problem
                  <select value={f.issueType} onChange={(e) => setF({ ...f, issueType: e.target.value })}>
                    {Object.entries(ISSUES).map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field wide">
                  Details
                  <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} autoFocus />
                </label>
              </>
            )}
            {modal === 'complete' && (
              <label className="field wide">
                Completion notes
                <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} placeholder="Anything the customer or the office should know" />
              </label>
            )}
            {modal === 'cancel' && (
              <label className="field wide">
                Reason
                <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus />
              </label>
            )}
            {modal === 'crew' && (
              <div className="field wide">
                <span>Helpers on this job (they can see and update it)</span>
                <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                  {(users.data?.items ?? [])
                    .filter((u) => u.id !== j.owner_id)
                    .map((u) => (
                      <label key={u.id} className="row small">
                        <input type="checkbox" checked={f.crewIds.includes(u.id)} onChange={(e) => setF({ ...f, crewIds: e.target.checked ? [...f.crewIds, u.id] : f.crewIds.filter((x: string) => x !== u.id) })} />
                        {u.full_name}
                      </label>
                    ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------- on the order
/** Deliveries and installations of an order, with planning and scheduling. */
export function OrderFulfilment({ order, lines, canEdit }: { order: Json; lines: Json[]; canEdit: boolean }) {
  const orderId = String(order.id);
  const flt = (f: string) => encodeURIComponent(JSON.stringify([{ field: f, op: 'eq', value: orderId }]));
  const ships = useQuery({ queryKey: ['order-shipments', orderId], queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/shipment?filters=${flt('sales_order_id')}&sort=created_at&dir=asc`) });
  const jobs = useQuery({ queryKey: ['order-jobs', orderId], queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/installation?filters=${flt('sales_order_id')}&sort=created_at&dir=asc`) });
  const act = useAct([['order-shipments', orderId], ['order-jobs', orderId], ['order', orderId]]);
  const users = useUsers();
  const [plan, setPlan] = useState<Json | null>(null);
  const [sched, setSched] = useState<Json | null>(null);
  const status = String(order.status);
  const canPlan = canEdit && ['confirmed', 'in_production', 'ready', 'dispatched', 'delivered'].includes(status) && lines.some((l) => Number(l.quantity) > Number(l.shippedQty ?? 0));
  return (
    <div className="stack">
      <div className="spread">
        <h3>Deliveries</h3>
        {canPlan && (
          <button className="btn sm" onClick={() => setPlan({ plannedDate: '', carrier: '', qty: Object.fromEntries(lines.map((l) => [l.id, String(Math.max(0, Number(l.quantity) - Number(l.shippedQty ?? 0)))])) })}>
            Plan delivery
          </button>
        )}
      </div>
      {ships.data?.items.length ? (
        <table className="data">
          <tbody>
            {ships.data.items.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/o/shipment/${s.id}`}>{String(s.shipment_number)}</Link>
                </td>
                <td>
                  <span className={`chip ${s.status === 'delivered' ? 'good' : s.status === 'failed' ? 'bad' : 'info'}`}>{String(s.status)}</span>
                </td>
                <td className="small">{s.planned_date ? `Planned ${date(s.planned_date)}` : ''}</td>
                <td className="small">{s.delivered_at ? `Delivered ${dateTime(s.delivered_at)}` : s.dispatched_at ? `Dispatched ${dateTime(s.dispatched_at)}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          {status === 'draft' ? 'Confirm the order to plan deliveries.' : 'No deliveries planned yet.'}
        </p>
      )}
      {(order.installation_required || !!jobs.data?.items.length) && (
        <>
          <div className="spread">
            <h3>Installation</h3>
            {canEdit && status !== 'draft' && status !== 'cancelled' && (
              <button className="btn sm" onClick={() => setSched({ start: '', end: '', technicianId: '', siteAddress: order.site_address ?? '' })}>
                Schedule installation
              </button>
            )}
          </div>
          {jobs.data?.items.length ? (
            <table className="data">
              <tbody>
                {jobs.data.items.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <Link to={`/o/installation/${j.id}`}>{String(j.job_number)}</Link>
                    </td>
                    <td>
                      <span className={`chip ${j.status === 'completed' ? 'good' : j.status === 'on_hold' ? 'warn' : 'info'}`}>{JOB_LABEL[String(j.status)]}</span>
                    </td>
                    <td className="small">{j.scheduled_start ? dateTime(j.scheduled_start) : ''}</td>
                    <td className="small">{users.data?.items.find((u) => u.id === j.owner_id)?.full_name ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small" style={{ margin: 0 }}>
              Not scheduled yet.
            </p>
          )}
        </>
      )}
      {plan && (
        <Modal
          title="Plan a delivery"
          wide
          onClose={() => setPlan(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                const ls = Object.entries(plan.qty as Record<string, string>).map(([orderLineId, q]) => ({ orderLineId, quantity: Number(q) })).filter((l) => l.quantity > 0);
                const ok = await act(() => post(`/api/v1/orders/${orderId}/shipments`, { lines: ls, plannedDate: plan.plannedDate || null, carrier: plan.carrier || null, ownerId: plan.ownerId || null }), 'Delivery planned');
                if (ok) setPlan(null);
              }}
            >
              Plan delivery
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Delivery date
              <input type="date" value={plan.plannedDate} onChange={(e) => setPlan({ ...plan, plannedDate: e.target.value })} />
            </label>
            <label className="field">
              Carrier / vehicle
              <input value={plan.carrier} onChange={(e) => setPlan({ ...plan, carrier: e.target.value })} placeholder="Own tempo, VRL, Porter…" />
            </label>
            <label className="field">
              Coordinator
              <select value={plan.ownerId ?? ''} onChange={(e) => setPlan({ ...plan, ownerId: e.target.value })}>
                <option value="">Me</option>
                {users.data?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <table className="data wide">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">Ordered</th>
                  <th className="num">Shipped</th>
                  <th className="num">This delivery</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.name}</td>
                    <td className="num">{l.quantity}</td>
                    <td className="num">{l.shippedQty ?? 0}</td>
                    <td>
                      <input className="num" inputMode="decimal" aria-label={`Quantity of ${l.name}`} value={plan.qty[l.id]} onChange={(e) => setPlan({ ...plan, qty: { ...plan.qty, [l.id]: e.target.value } })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
      {sched && (
        <Modal
          title="Schedule installation"
          onClose={() => setSched(null)}
          footer={
            <button
              className="btn primary"
              disabled={!sched.start || !sched.technicianId}
              onClick={async () => {
                const ok = await act(
                  () =>
                    post('/api/v1/installations', {
                      orderId,
                      start: new Date(sched.start).toISOString(),
                      end: sched.end ? new Date(sched.end).toISOString() : null,
                      technicianId: sched.technicianId,
                      siteAddress: sched.siteAddress || null,
                      contactPhone: sched.contactPhone || null,
                    }),
                  'Installation scheduled — the technician is notified',
                );
                if (ok) setSched(null);
              }}
            >
              Schedule
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Starts
              <input type="datetime-local" value={sched.start} onChange={(e) => setSched({ ...sched, start: e.target.value })} />
            </label>
            <label className="field">
              Ends
              <input type="datetime-local" value={sched.end} onChange={(e) => setSched({ ...sched, end: e.target.value })} />
            </label>
            <label className="field">
              Technician
              <select value={sched.technicianId} onChange={(e) => setSched({ ...sched, technicianId: e.target.value })}>
                <option value="">Choose…</option>
                {users.data?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Site contact phone
              <input value={sched.contactPhone ?? ''} onChange={(e) => setSched({ ...sched, contactPhone: e.target.value })} />
            </label>
            <label className="field wide">
              Site address
              <input value={sched.siteAddress} onChange={(e) => setSched({ ...sched, siteAddress: e.target.value })} />
            </label>
            <p className="wide muted small">The job gets the checklist from Settings → Service & delivery. Add helpers from the job page.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}
