import type { RecordDto } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, patch, post, put } from '../../lib/api';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

function dueText(due: unknown, doneAt: unknown) {
  if (!due) return null;
  const d = new Date(String(due)).getTime();
  if (doneAt) {
    const late = new Date(String(doneAt)).getTime() > d;
    return { text: late ? 'met late' : 'met', cls: late ? 'warn' : 'good' };
  }
  const mins = Math.round((d - Date.now()) / 60_000);
  if (mins < 0) return { text: `overdue by ${fmtMins(-mins)}`, cls: 'bad' };
  return { text: `due in ${fmtMins(mins)}`, cls: mins < 60 ? 'warn' : 'info' };
}
const fmtMins = (m: number) => (m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`);

/** SLA clocks, quick status changes and the customer link on a ticket. */
export function TicketBar({ ticket, canEdit }: { ticket: RecordDto; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState(String(ticket.resolution ?? ''));
  const status = String(ticket.status);
  const fr = dueText(ticket.first_response_due, ticket.first_responded_at);
  const rs = dueText(ticket.resolution_due, ticket.resolved_at);
  const set = async (body: Json, ok: string) => {
    try {
      const r = await patch<RecordDto>(`/api/v1/records/ticket/${ticket.id}`, body);
      qc.setQueryData(['record', 'ticket', ticket.id], r);
      qc.invalidateQueries({ queryKey: ['timeline', 'ticket', ticket.id] });
      toast(ok);
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  return (
    <div className="approval-bar" style={{ borderColor: ticket.sla_breached ? '#fcd9b6' : undefined }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <span className={`chip ${status === 'resolved' || status === 'closed' ? 'good' : 'info'}`}>{status.replace(/_/g, ' ')}</span>
        <span className={`chip ${ticket.priority === 'urgent' ? 'bad' : ticket.priority === 'high' ? 'warn' : ''}`}>{String(ticket.priority)}</span>
        {fr && <span className={`chip ${fr.cls}`}>First response {fr.text}</span>}
        {rs && <span className={`chip ${rs.cls}`}>Resolution {rs.text}</span>}
        {ticket.sla_breached ? <span className="chip bad">SLA breached</span> : null}
        {ticket.satisfaction ? <span className="chip good">{'★'.repeat(Number(ticket.satisfaction))}</span> : null}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button
          className="btn sm"
          onClick={async () => {
            const r = await get<{ link: string }>(`/api/v1/tickets/${ticket.id}/link`);
            await navigator.clipboard?.writeText(r.link).catch(() => undefined);
            toast('Status link copied — the customer can follow and reply there');
          }}
        >
          Copy status link
        </button>
        {canEdit && status === 'new' && (
          <button className="btn sm" onClick={() => set({ status: 'in_progress' }, 'Working on it')}>
            Start working
          </button>
        )}
        {canEdit && ['open', 'in_progress'].includes(status) && (
          <button className="btn sm" onClick={() => set({ status: 'waiting_customer' }, 'Waiting for the customer')}>
            Waiting on customer
          </button>
        )}
        {canEdit && !['resolved', 'closed'].includes(status) && (
          <button className="btn sm primary" onClick={() => setResolving(true)}>
            Resolve
          </button>
        )}
        {canEdit && status === 'resolved' && (
          <button className="btn sm" onClick={() => set({ status: 'closed' }, 'Ticket closed')}>
            Close
          </button>
        )}
        {canEdit && ['resolved', 'closed'].includes(status) && (
          <button className="btn sm ghost" onClick={() => set({ status: 'open' }, 'Ticket reopened')}>
            Reopen
          </button>
        )}
      </div>
      {resolving && (
        <Modal title="Resolve ticket" onClose={() => setResolving(false)} footer={<button className="btn primary" disabled={!resolution.trim()} onClick={async () => (await set({ status: 'resolved', resolution }, 'Resolved — the customer can now rate the service')) && setResolving(false)}>Resolve</button>}>
          <div className="modal-body" style={{ display: 'block' }}>
            <label className="field">
              Resolution (the customer sees this)
              <textarea value={resolution} onChange={(e) => setResolution(e.target.value)} autoFocus />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** "Raise ticket" from a customer, contact or order page (prefilled). */
export function RaiseTicketButton({ object, record }: { object: string; record: RecordDto }) {
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', category: 'defect', priority: 'normal', description: '' });
  const link: Json = object === 'account' ? { account_id: record.id } : object === 'contact' ? { contact_id: record.id } : object === 'sales_order' ? { sales_order_id: record.id, account_id: record.account_id ?? null } : {};
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Raise ticket
      </button>
      {open && (
        <Modal
          title="Raise a service ticket"
          onClose={() => setOpen(false)}
          footer={
            <button
              className="btn primary"
              disabled={!f.name.trim()}
              onClick={async () => {
                try {
                  const t = await post<RecordDto>('/api/v1/records/ticket?assign=1', { ...f, ...link, channel: 'phone' });
                  toast(`Ticket ${t.ticket_number} raised`);
                  nav(`/o/ticket/${t.id}`);
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Raise ticket
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              Subject
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="e.g. Sofa leg broken on delivery" />
            </label>
            <label className="field">
              Category
              <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
                {['damage', 'defect', 'installation', 'delivery', 'warranty', 'billing', 'feedback', 'other'].map((c) => (
                  <option key={c} value={c}>
                    {c[0]!.toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Priority
              <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                {['low', 'normal', 'high', 'urgent'].map((c) => (
                  <option key={c} value={c}>
                    {c[0]!.toUpperCase() + c.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field wide">
              Details
              <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Settings → Service & delivery: SLA policies and the installation checklist template. */
export function ServiceSettingsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const sla = useQuery({ queryKey: ['admin-sla'], queryFn: () => get<{ items: Json[] }>('/api/admin/sla-policies') });
  const cl = useQuery({ queryKey: ['admin-checklist'], queryFn: () => get<{ items: string[] | null }>('/api/admin/installation-checklist') });
  const [edit, setEdit] = useState<Json | null>(null);
  const [items, setItems] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string, key: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: [key] });
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  if (!sla.data || !cl.data) return <Spinner />;
  const hm = (m: number) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
  const text = items ?? (cl.data.items ?? ['Check items against the order', 'Assemble and install', 'Level, align and fix securely', 'Clean the site and remove packing', 'Demonstrate use and care to the customer']).join('\n');
  return (
    <div className="stack" style={{ gap: 28 }}>
      <section className="stack">
        <div className="spread">
          <div>
            <h3>Service levels (SLA)</h3>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              Each new ticket takes the most specific matching policy (priority + category first). Overdue tickets are flagged and the assignee and their manager are notified.
            </p>
          </div>
          <button className="btn primary" onClick={() => setEdit({ name: '', priority: '', category: '', fr: 240, rs: 2880, isActive: true })}>
            New policy
          </button>
        </div>
        {!sla.data.items.length ? (
          <Empty title="No SLA policies">Tickets have no due times until you add one — e.g. Urgent: respond in 30 min, resolve in 4 h.</Empty>
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Applies to</th>
                <th>First response</th>
                <th>Resolution</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sla.data.items.map((p) => (
                <tr key={p.id} className={p.is_active ? undefined : 'muted-row'}>
                  <td>
                    <b>{p.name}</b>
                  </td>
                  <td className="small">{[p.priority ? `${p.priority} priority` : null, p.category ? `${p.category} tickets` : null].filter(Boolean).join(', ') || 'All tickets'}</td>
                  <td>{hm(p.first_response_minutes)}</td>
                  <td>{hm(p.resolution_minutes)}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setEdit({ id: p.id, name: p.name, priority: p.priority ?? '', category: p.category ?? '', fr: p.first_response_minutes, rs: p.resolution_minutes, isActive: p.is_active })}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={() => window.confirm(`Delete “${p.name}”?`) && run(() => del(`/api/admin/sla-policies/${p.id}`), 'Policy deleted', 'admin-sla')}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="stack">
        <h3>Installation checklist</h3>
        <p className="muted small" style={{ margin: 0 }}>
          Every new installation job starts with these steps (one per line). Technicians tick them off; a job can't be completed with open steps.
        </p>
        <textarea value={text} onChange={(e) => setItems(e.target.value)} rows={7} aria-label="Checklist steps" />
        <div>
          <button className="btn" disabled={items === null} onClick={() => run(() => put('/api/admin/installation-checklist', { items: text.split('\n').map((x) => x.trim()).filter(Boolean) }), 'Checklist saved', 'admin-checklist').then(() => setItems(null))}>
            Save checklist
          </button>
        </div>
      </section>
      {edit && (
        <Modal
          title={edit.id ? 'Edit SLA policy' : 'New SLA policy'}
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              disabled={!edit.name.trim()}
              onClick={async () => {
                const body = { name: edit.name, priority: edit.priority || null, category: edit.category || null, firstResponseMinutes: Number(edit.fr), resolutionMinutes: Number(edit.rs), isActive: edit.isActive };
                if (await run(() => (edit.id ? put(`/api/admin/sla-policies/${edit.id}`, body) : post('/api/admin/sla-policies', body)), 'Policy saved', 'admin-sla')) setEdit(null);
              }}
            >
              Save
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus />
            </label>
            <label className="field">
              Priority
              <select value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>
                <option value="">Any</option>
                {['low', 'normal', 'high', 'urgent'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Category
              <select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>
                <option value="">Any</option>
                {['damage', 'defect', 'installation', 'delivery', 'warranty', 'billing', 'feedback', 'other'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              First response (minutes)
              <input type="number" min={5} value={edit.fr} onChange={(e) => setEdit({ ...edit, fr: e.target.value })} />
            </label>
            <label className="field">
              Resolve within (minutes)
              <input type="number" min={15} value={edit.rs} onChange={(e) => setEdit({ ...edit, rs: e.target.value })} />
            </label>
            <label className="row">
              <input type="checkbox" checked={edit.isActive} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Home dashboard card: service desk health. */
export function ServiceInsights() {
  const { data } = useQuery({ queryKey: ['insights', 'service'], queryFn: () => get<Json>('/api/v1/insights/service?days=30'), staleTime: 60_000 });
  if (!data) return null;
  return (
    <div className="kpis" style={{ marginTop: 20 }}>
      <div className="panel kpi">
        <div className="l">Open tickets</div>
        <div className="v">{data.open}</div>
        <div className="muted small">{data.high_open} high or urgent</div>
      </div>
      <div className="panel kpi">
        <div className="l">SLA breached (open)</div>
        <div className="v" style={{ color: data.breached_open ? 'var(--bad)' : undefined }}>
          {data.breached_open}
        </div>
        <div className="muted small">{data.sla_met_pct === null ? '—' : `${data.sla_met_pct}% met in 30 days`}</div>
      </div>
      <div className="panel kpi">
        <div className="l">Avg. first response</div>
        <div className="v">{data.avg_first_response_min === null ? '—' : fmtMins(data.avg_first_response_min)}</div>
        <div className="muted small">Resolution avg {data.avg_resolution_hours ?? '—'} h</div>
      </div>
      <div className="panel kpi">
        <div className="l">Customer satisfaction</div>
        <div className="v">{data.csat === null ? '—' : `${data.csat} / 5`}</div>
        <div className="muted small">{data.resolved} resolved in 30 days</div>
      </div>
    </div>
  );
}

