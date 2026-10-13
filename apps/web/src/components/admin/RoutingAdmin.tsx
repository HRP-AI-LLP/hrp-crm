import type { ObjectMeta } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { del, get, post, put } from '../../lib/api';
import { useMeta } from '../../lib/hooks';
import { describeFilter, type Filter, FilterBuilder } from '../ListTools';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

const STRATEGY: Record<string, string> = { round_robin: 'Round robin', load_balanced: 'Fewest open records', fixed: 'Always the first person' };
const APPROVER: Record<string, string> = { manager: "Requester's manager", user: 'A specific person', role: 'Anyone with a role', owner: 'Workspace owner' };

function Criteria({ obj, value, empty }: { obj: ObjectMeta | undefined; value: Filter[]; empty: string }) {
  if (!value.length) return <span className="muted small">{empty}</span>;
  return (
    <span className="criteria">
      {value.map((c, i) => (
        <span key={i} className="chip filter-chip">
          {obj ? describeFilter(obj, c) : c.field}
        </span>
      ))}
    </span>
  );
}

function useLookups() {
  const users = useQuery({ queryKey: ['users'], queryFn: () => get<{ items: Json[] }>('/api/v1/users'), staleTime: 60_000 });
  const teams = useQuery({ queryKey: ['admin-teams'], queryFn: () => get<{ items: Json[] }>('/api/admin/teams') });
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  return { users: users.data?.items ?? [], teams: teams.data?.items ?? [], roles: roles.data?.items ?? [] };
}

/** Settings → Routing & approvals: assignment rules, lead scoring and approval rules. */
export function RoutingTab() {
  const { data, isLoading } = useQuery({ queryKey: ['admin-rules'], queryFn: () => get<Json>('/api/admin/rules') });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="stack" style={{ gap: 28 }}>
      <AssignmentRules items={data.assignment} />
      <ScoringRules items={data.scoring} bands={data.bands} />
      <ApprovalRules items={data.approval} approvable={data.approvable} />
    </div>
  );
}

function useSave() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (fn: () => Promise<unknown>, ok: string) => {
    try {
      const r = await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['admin-rules'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
      return r ?? true;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

// ------------------------------------------------------------------------------------ assignment
function AssignmentRules({ items }: { items: Json[] }) {
  const { data: meta } = useMeta();
  const { users, teams } = useLookups();
  const save = useSave();
  const [edit, setEdit] = useState<Json | null>(null);
  const [filtering, setFiltering] = useState(false);
  const obj = meta?.objects.find((o) => o.key === (edit?.object_key ?? 'lead'));
  const name = (id: string) => users.find((u) => u.id === id)?.full_name ?? '—';

  const submit = async () => {
    const e = edit!;
    const body = { objectKey: e.object_key, name: e.name, criteria: e.criteria, strategy: e.strategy, userIds: e.user_ids, teamId: e.team_id || null, isActive: e.is_active };
    if (await save(() => (e.id ? put(`/api/admin/rules/assignment/${e.id}`, body) : post('/api/admin/rules/assignment', body)), 'Assignment rule saved')) setEdit(null);
  };
  const move = (i: number, d: number) => {
    const ids = items.map((r) => r.id);
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void save(() => put('/api/admin/rules/assignment-order', { ids }), 'Order saved');
  };

  return (
    <section className="stack">
      <div className="spread">
        <div>
          <h3>Assignment rules</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            New leads from web forms, WhatsApp, Instagram, imports and integrations go to the first rule that matches. People can also tick “Assign by rules” when they add a record.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ object_key: 'lead', name: '', criteria: [], strategy: 'round_robin', user_ids: [], team_id: '', is_active: true })}>
          New rule
        </button>
      </div>
      {!items.length ? (
        <Empty title="No assignment rules">Without rules, new leads go to the form's owner or the workspace owner.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 60 }}>Order</th>
              <th>Rule</th>
              <th>When</th>
              <th>Goes to</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => {
              const o = meta?.objects.find((x) => x.key === r.object_key);
              return (
                <tr key={r.id} className={r.is_active ? undefined : 'muted-row'}>
                  <td>
                    <div className="row" style={{ gap: 2 }}>
                      <button className="btn ghost sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                        ↑
                      </button>
                      <button className="btn ghost sm" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                        ↓
                      </button>
                    </div>
                  </td>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted small">
                      {o?.plural ?? r.object_key} · {STRATEGY[r.strategy]}
                      {r.is_active ? '' : ' · off'}
                    </div>
                  </td>
                  <td>
                    <Criteria obj={o} value={r.criteria} empty="Every new record" />
                  </td>
                  <td className="small">
                    {[...r.user_ids.map(name), ...(r.team_id ? [`Team ${teams.find((t) => t.id === r.team_id)?.name ?? ''}`] : [])].join(', ')}
                  </td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setEdit({ ...r, team_id: r.team_id ?? '' })}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={() => window.confirm(`Delete “${r.name}”?`) && save(() => del(`/api/admin/rules/assignment/${r.id}`), 'Rule deleted')}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {edit && obj && !filtering && (
        <Modal title={edit.id ? 'Edit assignment rule' : 'New assignment rule'} wide onClose={() => setEdit(null)} footer={<button className="btn primary" disabled={!edit.name.trim() || (!edit.user_ids.length && !edit.team_id)} onClick={submit}>Save rule</button>}>
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Instagram enquiries to the social desk" autoFocus />
            </label>
            <label className="field">
              Records
              <select value={edit.object_key} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, object_key: e.target.value, criteria: [] })}>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.plural}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              How to pick
              <select value={edit.strategy} onChange={(e) => setEdit({ ...edit, strategy: e.target.value })}>
                {Object.entries(STRATEGY).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <div className="field wide">
              <span>When</span>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Criteria obj={obj} value={edit.criteria} empty="Every new record" />
                <button className="link" onClick={() => setFiltering(true)}>
                  {edit.criteria.length ? 'Edit conditions' : 'Add conditions'}
                </button>
              </div>
            </div>
            <div className="field wide">
              <span>People</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
                {users.map((u) => (
                  <label key={u.id} className="row small">
                    <input type="checkbox" checked={edit.user_ids.includes(u.id)} onChange={(e) => setEdit({ ...edit, user_ids: e.target.checked ? [...edit.user_ids, u.id] : edit.user_ids.filter((x: string) => x !== u.id) })} />
                    {u.full_name}
                  </label>
                ))}
              </div>
            </div>
            <label className="field">
              …and/or everyone in a team
              <select value={edit.team_id} onChange={(e) => setEdit({ ...edit, team_id: e.target.value })}>
                <option value="">No team</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ alignSelf: 'end', height: 34 }}>
              <input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
      {edit && obj && filtering && (
        <FilterBuilder
          obj={obj}
          value={edit.criteria}
          onClose={() => setFiltering(false)}
          onChange={(criteria) => {
            setEdit({ ...edit, criteria });
            setFiltering(false);
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ scoring
function ScoringRules({ items, bands }: { items: Json[]; bands: { hot: number; warm: number } }) {
  const { data: meta } = useMeta();
  const save = useSave();
  const [edit, setEdit] = useState<Json | null>(null);
  const [filtering, setFiltering] = useState(false);
  const [b, setB] = useState(bands);
  const obj = meta?.objects.find((o) => o.key === 'lead');
  const submit = async () => {
    const e = edit!;
    const body = { objectKey: 'lead', name: e.name, criteria: e.criteria, points: Number(e.points), isActive: e.is_active };
    if (await save(() => (e.id ? put(`/api/admin/rules/scoring/${e.id}`, body) : post('/api/admin/rules/scoring', body)), 'Scoring rule saved')) setEdit(null);
  };
  return (
    <section className="stack">
      <div className="spread">
        <div>
          <h3>Lead scoring</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            Points add up (0–100) every time a lead is saved. Hot and warm thresholds set the rating shown on leads. AI scoring still runs separately when AI is configured.
          </p>
        </div>
        <button className="btn primary" onClick={() => setEdit({ name: '', criteria: [], points: 10, is_active: true })}>
          New scoring rule
        </button>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
        <label className="field" style={{ width: 120 }}>
          Hot from
          <input type="number" min={1} max={100} value={b.hot} onChange={(e) => setB({ ...b, hot: Number(e.target.value) })} />
        </label>
        <label className="field" style={{ width: 120 }}>
          Warm from
          <input type="number" min={0} max={99} value={b.warm} onChange={(e) => setB({ ...b, warm: Number(e.target.value) })} />
        </label>
        <button className="btn" style={{ alignSelf: 'end' }} onClick={() => save(() => put('/api/admin/rules/scoring-bands', b), 'Thresholds saved')}>
          Save thresholds
        </button>
        <button
          className="btn"
          style={{ alignSelf: 'end' }}
          disabled={!items.length}
          onClick={async () => {
            const r = (await save(() => post<{ updated: number }>('/api/admin/rules/scoring/rescore'), 'Leads re-scored')) as { updated: number } | null;
            if (r && typeof r === 'object') window.alert(`${r.updated} open leads changed score.`);
          }}
        >
          Re-score open leads
        </button>
      </div>
      {!items.length ? (
        <Empty title="No scoring rules">Example: +40 when the source is Architect, +20 when the budget is above ₹5 lakh, −30 when the city is outside your service area.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {items.map((r) => (
              <tr key={r.id} className={r.is_active ? undefined : 'muted-row'}>
                <td style={{ width: 70 }}>
                  <span className={`chip ${r.points >= 0 ? 'good' : 'bad'}`}>
                    {r.points > 0 ? '+' : ''}
                    {r.points}
                  </span>
                </td>
                <td>
                  <b>{r.name}</b>
                </td>
                <td>
                  <Criteria obj={obj} value={r.criteria} empty="—" />
                </td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => setEdit(r)}>
                    Edit
                  </button>
                  <button className="btn sm danger" onClick={() => window.confirm(`Delete “${r.name}”?`) && save(() => del(`/api/admin/rules/scoring/${r.id}`), 'Rule deleted')}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && obj && !filtering && (
        <Modal title={edit.id ? 'Edit scoring rule' : 'New scoring rule'} onClose={() => setEdit(null)} footer={<button className="btn primary" disabled={!edit.name.trim() || !edit.criteria.length} onClick={submit}>Save rule</button>}>
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Referred by an architect" autoFocus />
            </label>
            <label className="field">
              Points
              <input type="number" min={-100} max={100} value={edit.points} onChange={(e) => setEdit({ ...edit, points: e.target.value })} />
            </label>
            <label className="row" style={{ alignSelf: 'end', height: 34 }}>
              <input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active
            </label>
            <div className="field wide">
              <span>When the lead</span>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Criteria obj={obj} value={edit.criteria} empty="Add at least one condition" />
                <button className="link" onClick={() => setFiltering(true)}>
                  {edit.criteria.length ? 'Edit conditions' : 'Add conditions'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
      {edit && obj && filtering && (
        <FilterBuilder
          obj={obj}
          value={edit.criteria}
          onClose={() => setFiltering(false)}
          onChange={(criteria) => {
            setEdit({ ...edit, criteria });
            setFiltering(false);
          }}
        />
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------ approvals
function ApprovalRules({ items, approvable }: { items: Json[]; approvable: string[] }) {
  const { data: meta } = useMeta();
  const { users, roles } = useLookups();
  const save = useSave();
  const [edit, setEdit] = useState<Json | null>(null);
  const [filtering, setFiltering] = useState(false);
  const obj = meta?.objects.find((o) => o.key === edit?.object_key);
  const submit = async () => {
    const e = edit!;
    const body = { objectKey: e.object_key, name: e.name, criteria: e.criteria, approverType: e.approver_type, approverId: e.approver_id || null, approverRole: e.approver_role || null, isActive: e.is_active };
    if (await save(() => (e.id ? put(`/api/admin/rules/approval/${e.id}`, body) : post('/api/admin/rules/approval', body)), 'Approval rule saved')) setEdit(null);
  };
  const approverText = (r: Json) =>
    r.approver_type === 'user' ? users.find((u) => u.id === r.approver_id)?.full_name ?? 'a person' : r.approver_type === 'role' ? `role ${roles.find((x) => x.key === r.approver_role)?.name ?? r.approver_role}` : APPROVER[r.approver_type];
  return (
    <section className="stack">
      <div className="spread">
        <div>
          <h3>Approval rules</h3>
          <p className="muted small" style={{ margin: '4px 0 0' }}>
            A matching record must be approved before it goes out — e.g. quotes with a line discount above 10%, or purchase orders over ₹5 lakh. Any change after approval asks again.
          </p>
        </div>
        <button className="btn primary" disabled={!approvable.length} onClick={() => setEdit({ object_key: approvable[0], name: '', criteria: [], approver_type: 'manager', approver_id: '', approver_role: '', is_active: true })}>
          New approval rule
        </button>
      </div>
      {!items.length ? (
        <Empty title="No approval rules">Records go out without approval.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {items.map((r) => {
              const o = meta?.objects.find((x) => x.key === r.object_key);
              return (
                <tr key={r.id} className={r.is_active ? undefined : 'muted-row'}>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted small">{o?.plural ?? r.object_key}</div>
                  </td>
                  <td>
                    <Criteria obj={o} value={r.criteria} empty="—" />
                  </td>
                  <td className="small">Approver: {approverText(r)}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setEdit({ ...r, approver_id: r.approver_id ?? '', approver_role: r.approver_role ?? '' })}>
                      Edit
                    </button>
                    <button className="btn sm danger" onClick={() => window.confirm(`Delete “${r.name}”?`) && save(() => del(`/api/admin/rules/approval/${r.id}`), 'Rule deleted')}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {edit && obj && !filtering && (
        <Modal
          title={edit.id ? 'Edit approval rule' : 'New approval rule'}
          wide
          onClose={() => setEdit(null)}
          footer={
            <button className="btn primary" disabled={!edit.name.trim() || !edit.criteria.length || (edit.approver_type === 'user' && !edit.approver_id) || (edit.approver_type === 'role' && !edit.approver_role)} onClick={submit}>
              Save rule
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="e.g. Discount above 10%" autoFocus />
            </label>
            <label className="field">
              Records
              <select value={edit.object_key} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, object_key: e.target.value, criteria: [] })}>
                {approvable.map((k) => (
                  <option key={k} value={k}>
                    {meta?.objects.find((o) => o.key === k)?.plural ?? k}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Approver
              <select value={edit.approver_type} onChange={(e) => setEdit({ ...edit, approver_type: e.target.value })}>
                {Object.entries(APPROVER).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {edit.approver_type === 'user' && (
              <label className="field">
                Person
                <select value={edit.approver_id} onChange={(e) => setEdit({ ...edit, approver_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {edit.approver_type === 'role' && (
              <label className="field">
                Role
                <select value={edit.approver_role} onChange={(e) => setEdit({ ...edit, approver_role: e.target.value })}>
                  <option value="">Choose…</option>
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="field wide">
              <span>Needs approval when</span>
              <div className="row" style={{ flexWrap: 'wrap' }}>
                <Criteria obj={obj} value={edit.criteria} empty="Add at least one condition" />
                <button className="link" onClick={() => setFiltering(true)}>
                  {edit.criteria.length ? 'Edit conditions' : 'Add conditions'}
                </button>
              </div>
              <span className="muted small">Useful fields: Highest line discount %, Grand total, Discount.</span>
            </div>
            <label className="row" style={{ height: 34 }}>
              <input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
      {edit && obj && filtering && (
        <FilterBuilder
          obj={obj}
          value={edit.criteria}
          onClose={() => setFiltering(false)}
          onChange={(criteria) => {
            setEdit({ ...edit, criteria });
            setFiltering(false);
          }}
        />
      )}
    </section>
  );
}
