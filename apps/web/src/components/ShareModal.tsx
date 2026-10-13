import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post } from '../lib/api';
import { relative } from '../lib/format';
import { useUsers } from '../lib/hooks';
import { Modal, Spinner, useToast } from './ui';

interface Share {
  user_id: string | null;
  team_id: string | null;
  access: 'read' | 'edit';
  created_at: string;
  user_name: string | null;
  team_name: string | null;
}

/** Share one record with a person or a team, on top of what their role allows. */
export function ShareModal({ object, id, title, onClose }: { object: string; id: string; title: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: users } = useUsers();
  const teams = useQuery({ queryKey: ['teams-list'], queryFn: () => get<{ items: { id: string; name: string }[] }>('/api/v1/teams') });
  const { data } = useQuery({ queryKey: ['shares', object, id], queryFn: () => get<{ items: Share[] }>(`/api/v1/records/${object}/${id}/shares`) });
  const [target, setTarget] = useState('');
  const [access, setAccess] = useState<'read' | 'edit'>('read');

  const add = async () => {
    const [kind, tid] = target.split(':');
    try {
      await post(`/api/v1/records/${object}/${id}/shares`, kind === 'team' ? { teamId: tid, access } : { userId: tid, access });
      setTarget('');
      qc.invalidateQueries({ queryKey: ['shares', object, id] });
      toast('Shared');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={`Share “${title}”`} onClose={onClose}>
      <div className="modal-body" style={{ display: 'block' }}>
        <p className="muted small" style={{ marginTop: 0 }}>
          People already see this record if their role allows it. Sharing adds access for someone who otherwise could not see or edit it.
        </p>
        <div className="row" style={{ marginBottom: 12 }}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Share with">
            <option value="">Choose a person or team…</option>
            <optgroup label="People">
              {users?.items.map((u) => (
                <option key={u.id} value={`user:${u.id}`}>
                  {u.full_name}
                </option>
              ))}
            </optgroup>
            {!!teams.data?.items.length && (
              <optgroup label="Teams">
                {teams.data.items.map((t) => (
                  <option key={t.id} value={`team:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <select value={access} onChange={(e) => setAccess(e.target.value as 'read' | 'edit')} style={{ width: 'auto' }} aria-label="Access">
            <option value="read">Can view</option>
            <option value="edit">Can edit</option>
          </select>
          <button className="btn primary" disabled={!target} onClick={add}>
            Share
          </button>
        </div>
        {!data ? (
          <Spinner />
        ) : !data.items.length ? (
          <p className="muted small">Not shared with anyone individually.</p>
        ) : (
          <table className="data">
            <tbody>
              {data.items.map((s) => (
                <tr key={(s.user_id ?? s.team_id)!}>
                  <td>
                    <b>{s.user_name ?? `Team: ${s.team_name}`}</b>
                    <div className="muted small">since {relative(s.created_at)}</div>
                  </td>
                  <td>{s.access === 'edit' ? 'Can edit' : 'Can view'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        await del(`/api/v1/records/${object}/${id}/shares?${s.user_id ? `userId=${s.user_id}` : `teamId=${s.team_id}`}`).catch((e) => toast((e as Error).message, true));
                        qc.invalidateQueries({ queryKey: ['shares', object, id] });
                      }}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
}
