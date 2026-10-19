/** Email digests: Business health, a dashboard or a report, delivered on a schedule. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';
import { useUsers } from '../lib/hooks';
import { Empty, Modal, useToast } from './ui';

type Json = Record<string, any>;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const hour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'am' : 'pm'}`;

export function DigestsPanel() {
  const { me } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['digests'], queryFn: () => get<{ items: Json[] }>('/api/v1/digests') });
  const [edit, setEdit] = useState<Json | null>(null);
  const describe = (d: Json) => (d.frequency === 'daily' ? `Every day at ${hour(d.send_hour)}` : d.frequency === 'weekly' ? `Every ${DAYS[(d.weekday ?? 1) - 1]} at ${hour(d.send_hour)}` : `On day ${d.monthday ?? 1} of each month at ${hour(d.send_hour)}`);
  return (
    <section className="panel" id="digests" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <div>
          <h2>Email digests</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Business health, a dashboard or a report in the inbox. Each person gets the numbers they can see.
          </p>
        </div>
        <button className="btn" onClick={() => setEdit({ name: 'Morning numbers', kind: 'health', targetId: null, frequency: 'daily', sendHour: 8, weekday: 1, monthday: 1, recipients: me ? [me.user.id] : [], isEnabled: true })}>
          New digest
        </button>
      </div>
      {!q.data?.items.length ? (
        <Empty title="No digests">Get Business health every morning, or the sales dashboard every Monday.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {q.data.items.map((d) => (
              <tr key={d.id}>
                <td>
                  <b>{d.name}</b>
                  <div className="muted small">
                    {describe(d)} · {(d.recipient_names ?? []).join(', ')}
                  </div>
                  {d.last_error && <div className="small bad-text">{d.last_error}</div>}
                </td>
                <td className="small muted">{d.is_enabled ? `Next ${dateTime(d.next_run_at)}` : 'Paused'}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  {d.owner_id === me?.user.id ? (
                    <>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          try {
                            const r = await post<{ sent: number; error?: string }>(`/api/v1/digests/${d.id}/send-now`);
                            toast(r.sent ? `Sent to ${r.sent}` : (r.error ?? 'Nothing to send'), !r.sent);
                          } catch (e) {
                            toast((e as Error).message, true);
                          }
                        }}
                      >
                        Send now
                      </button>
                      <button className="btn sm" onClick={() => setEdit({ id: d.id, name: d.name, kind: d.kind, targetId: d.target_id, frequency: d.frequency, sendHour: d.send_hour, weekday: d.weekday ?? 1, monthday: d.monthday ?? 1, recipients: d.recipients, isEnabled: d.is_enabled })}>
                        Edit
                      </button>
                    </>
                  ) : null}
                  <button
                    className="btn sm ghost"
                    onClick={async () => {
                      await del(`/api/v1/digests/${d.id}`);
                      qc.invalidateQueries({ queryKey: ['digests'] });
                    }}
                  >
                    {d.owner_id === me?.user.id ? 'Delete' : 'Unsubscribe'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <DigestModal value={edit} onClose={() => setEdit(null)} />}
    </section>
  );
}

function DigestModal({ value, onClose }: { value: Json; onClose: () => void }) {
  const { me, can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useUsers();
  const [f, setF] = useState(value);
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => get<{ items: Json[] }>('/api/v1/reports') });
  const dashboards = useQuery({ queryKey: ['dashboards'], queryFn: () => get<{ items: Json[] }>('/api/v1/dashboards') });
  const manager = can('users');
  const targets = f.kind === 'report' ? reports.data?.items : f.kind === 'dashboard' ? dashboards.data?.items : [];
  const save = async () => {
    try {
      const body: Json = { ...f, targetId: f.kind === 'health' ? null : f.targetId, weekday: f.frequency === 'weekly' ? f.weekday : null, monthday: f.frequency === 'monthly' ? f.monthday : null };
      delete body.id;
      if (f.id) await put(`/api/v1/digests/${f.id}`, body);
      else await post('/api/v1/digests', body);
      qc.invalidateQueries({ queryKey: ['digests'] });
      toast('Digest saved');
      onClose();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title={f.id ? 'Edit digest' : 'New digest'}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!f.name || !f.recipients.length || (f.kind !== 'health' && !f.targetId)} onClick={save}>
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label className="field">
          What
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value, targetId: null })}>
            <option value="health">Business health</option>
            <option value="dashboard">A dashboard</option>
            <option value="report">A report</option>
          </select>
        </label>
        {f.kind !== 'health' ? (
          <label className="field">
            {f.kind === 'dashboard' ? 'Dashboard' : 'Report'}
            <select value={f.targetId ?? ''} onChange={(e) => setF({ ...f, targetId: e.target.value || null })}>
              <option value="">Choose…</option>
              {targets?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_shared ? '' : ' (private)'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span />
        )}
        <label className="field">
          How often
          <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="monthly">Every month</option>
          </select>
        </label>
        <label className="field">
          At (India time)
          <select value={f.sendHour} onChange={(e) => setF({ ...f, sendHour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {hour(h)}
              </option>
            ))}
          </select>
        </label>
        {f.frequency === 'weekly' && (
          <label className="field">
            On
            <select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        )}
        {f.frequency === 'monthly' && (
          <label className="field">
            Day of the month
            <input type="number" min={1} max={28} value={f.monthday} onChange={(e) => setF({ ...f, monthday: Number(e.target.value) })} />
          </label>
        )}
        <div className="field wide">
          <span>Send to</span>
          {manager ? (
            <div className="recipient-pick">
              {users.data?.items.map((u) => (
                <label key={u.id} className="check small">
                  <input type="checkbox" checked={f.recipients.includes(u.id)} onChange={(e) => setF({ ...f, recipients: e.target.checked ? [...f.recipients, u.id] : f.recipients.filter((x: string) => x !== u.id) })} /> {u.full_name}
                </label>
              ))}
            </div>
          ) : (
            <span className="muted small">You ({me?.user.email})</span>
          )}
          {f.kind !== 'health' && targets?.find((t) => t.id === f.targetId && !t.is_shared) && f.recipients.some((r: string) => r !== me?.user.id) && <span className="small warn-text">This {f.kind} is private: only you will receive it. Share it first to send it to others.</span>}
        </div>
        <label className="check wide">
          <input type="checkbox" checked={f.isEnabled} onChange={(e) => setF({ ...f, isEnabled: e.target.checked })} /> Active
        </label>
      </div>
    </Modal>
  );
}
