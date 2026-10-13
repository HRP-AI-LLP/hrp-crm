import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { del, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, number, relative } from '../../lib/format';
import { useMeta, useUsers } from '../../lib/hooks';
import { describeFilter, type Filter, FilterBuilder } from '../ListTools';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;

// ------------------------------------------------------------------------------------- security policy
export function SecurityPolicyTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data } = useQuery({ queryKey: ['admin-security'], queryFn: () => get<{ policy: { requireMfa: boolean }; stats: { users: number; mfa: number; invited: number }; mailer: boolean }>('/api/admin/security') });
  if (!data) return <Spinner />;
  const pct = data.stats.users ? Math.round((data.stats.mfa / data.stats.users) * 100) : 0;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="kpis">
        <div className="panel kpi">
          <div className="l">Active people</div>
          <div className="v">{data.stats.users}</div>
        </div>
        <div className="panel kpi">
          <div className="l">Using two-factor</div>
          <div className="v">
            {data.stats.mfa} <span className="muted small">({pct}%)</span>
          </div>
        </div>
        <div className="panel kpi">
          <div className="l">Invitations pending</div>
          <div className="v">{data.stats.invited}</div>
        </div>
      </div>
      <section className="panel">
        <div className="panel-body stack">
          <label className="row" style={{ alignItems: 'flex-start' }}>
            <span className="switch" style={{ marginTop: 2 }}>
              <input
                type="checkbox"
                checked={data.policy.requireMfa}
                onChange={async (e) => {
                  try {
                    await put('/api/admin/security', { requireMfa: e.target.checked });
                    toast(e.target.checked ? 'Two-factor sign-in is now required' : 'Two-factor sign-in is optional');
                    qc.invalidateQueries({ queryKey: ['admin-security'] });
                  } catch (err) {
                    toast((err as Error).message, true);
                  }
                }}
                aria-label="Require two-factor sign-in"
              />
              <span />
            </span>
            <span>
              <b>Require two-factor sign-in for everyone</b>
              <div className="muted small">People without it are asked to set it up before they can use Synapse. API keys are not affected.</div>
              {!me?.security?.mfaEnabled && (
                <div className="small" style={{ marginTop: 4 }}>
                  Turn it on for yourself first in <Link to="/account">My account</Link>.
                </div>
              )}
            </span>
          </label>
          <hr className="sep" />
          <div>
            <b>Always on</b>
            <ul className="muted small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Passwords: at least 10 characters with mixed character types, stored as PBKDF2 hashes.</li>
              <li>Five wrong passwords lock the account for 15 minutes; every attempt is in the audit log.</li>
              <li>Sessions rotate on every refresh; a reused refresh token signs that device out.</li>
              <li>Every workspace is isolated by Postgres row-level security.</li>
              <li>Email delivery for invitations: {data.mailer ? 'configured' : <>not configured — links are shown to admins instead (add <code>RESEND_API_KEY</code> to enable)</>}.</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------- teams
export function TeamsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-teams'], queryFn: () => get<{ items: Json[] }>('/api/admin/teams') });
  const { data: users } = useUsers();
  const [editing, setEditing] = useState<Json | null>(null);
  const save = async () => {
    const body = { name: editing!.name, description: editing!.description || null, leadId: editing!.lead_id || null, memberIds: editing!.member_ids };
    try {
      if (editing!.id) await put(`/api/admin/teams/${editing!.id}`, body);
      else await post('/api/admin/teams', body);
      toast('Team saved');
      qc.invalidateQueries({ queryKey: ['admin-teams'] });
      setEditing(null);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Teams group people by branch, territory or product line. A team lead with “team” access sees every member’s records. Teams can also receive sharing rules.
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', description: '', lead_id: '', member_ids: [] })}>
          New team
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.items.length ? (
        <Empty title="No teams yet">For example: “Pune branch”, “Enterprise”, “Inside sales”.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {data.items.map((t) => (
              <tr key={t.id}>
                <td>
                  <b>{t.name}</b>
                  {t.description && <div className="muted small">{t.description}</div>}
                </td>
                <td>{t.lead_name ? `Lead: ${t.lead_name}` : <span className="muted">No lead</span>}</td>
                <td className="small">{t.member_ids.map((id: string) => users?.items.find((u) => u.id === id)?.full_name).filter(Boolean).join(', ') || <span className="muted">No members</span>}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => setEditing({ ...t })}>
                    Edit
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete the team “${t.name}”? Sharing rules for it are removed too.`)) return;
                      await del(`/api/admin/teams/${t.id}`).catch((e) => toast((e as Error).message, true));
                      qc.invalidateQueries({ queryKey: ['admin-teams'] });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <Modal title={editing.id ? 'Edit team' : 'New team'} onClose={() => setEditing(null)} footer={<button className="btn primary" disabled={!editing.name.trim()} onClick={save}>Save team</button>}>
          <div className="modal-body">
            <label className="field">
              Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} autoFocus maxLength={80} />
            </label>
            <label className="field">
              Team lead
              <select value={editing.lead_id ?? ''} onChange={(e) => setEditing({ ...editing, lead_id: e.target.value })}>
                <option value="">—</option>
                {users?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field wide">
              Description
              <input value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
            </label>
            <div className="field wide">
              <span>Members</span>
              <div className="col-picks" style={{ maxHeight: 260 }}>
                {users?.items.map((u) => (
                  <label key={u.id} className="row small">
                    <input type="checkbox" checked={editing.member_ids.includes(u.id)} onChange={(e) => setEditing({ ...editing, member_ids: e.target.checked ? [...editing.member_ids, u.id] : editing.member_ids.filter((x: string) => x !== u.id) })} />
                    {u.full_name}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------- sharing rules
export function SharingRulesTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['admin-sharing'], queryFn: () => get<{ items: Json[] }>('/api/admin/sharing-rules') });
  const { data: teams } = useQuery({ queryKey: ['admin-teams'], queryFn: () => get<{ items: Json[] }>('/api/admin/teams') });
  const { data: roles } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  const [editing, setEditing] = useState<Json | null>(null);
  const [filtering, setFiltering] = useState(false);
  const obj = meta?.objects.find((o) => o.key === editing?.object_key);

  const save = async () => {
    const e = editing!;
    const body = { objectKey: e.object_key, name: e.name, criteria: e.criteria, teamId: e.target === 'team' ? e.team_id : null, roleKey: e.target === 'role' ? e.role_key : null, access: e.access, isActive: e.is_active };
    try {
      if (e.id) await put(`/api/admin/sharing-rules/${e.id}`, body);
      else await post('/api/admin/sharing-rules', body);
      toast('Sharing rule saved');
      qc.invalidateQueries({ queryKey: ['admin-sharing'] });
      setEditing(null);
    } catch (err) {
      toast((err as Error).message, true);
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Roles with “own” or “team” access see only their records. Sharing rules open up records that match conditions to a team or role — for example, all referral leads to the Referral desk.
        </p>
        <button className="btn primary" onClick={() => setEditing({ object_key: 'lead', name: '', criteria: [], target: 'team', team_id: teams?.items[0]?.id ?? '', role_key: 'sales_rep', access: 'read', is_active: true })}>
          New rule
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.items.length ? (
        <Empty title="No sharing rules">Everyone sees exactly what their role allows.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Rule</th>
              <th>Records</th>
              <th>Shared with</th>
              <th>Access</th>
              <th>Active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((r) => {
              const o = meta?.objects.find((x) => x.key === r.object_key);
              return (
                <tr key={r.id}>
                  <td>
                    <b>{r.name}</b>
                  </td>
                  <td className="small">
                    {o?.plural ?? r.object_key}
                    {r.criteria.length ? ` where ${o ? r.criteria.map((c: Filter) => describeFilter(o, c)).join(' and ') : '…'}` : ' (all)'}
                  </td>
                  <td>{r.team_name ? `Team: ${r.team_name}` : `Role: ${roles?.items.find((x) => x.key === r.role_key)?.name ?? r.role_key}`}</td>
                  <td>{r.access === 'edit' ? 'Read & edit' : 'Read only'}</td>
                  <td>{r.is_active ? 'Yes' : 'No'}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setEditing({ ...r, target: r.team_id ? 'team' : 'role' })}>
                      Edit
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        if (!window.confirm(`Delete “${r.name}”?`)) return;
                        await del(`/api/admin/sharing-rules/${r.id}`);
                        qc.invalidateQueries({ queryKey: ['admin-sharing'] });
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {editing && obj && !filtering && (
        <Modal title={editing.id ? 'Edit sharing rule' : 'New sharing rule'} wide onClose={() => setEditing(null)} footer={<button className="btn primary" disabled={!editing.name.trim() || (editing.target === 'team' && !editing.team_id)} onClick={save}>Save rule</button>}>
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. Referral leads to the Referral desk" autoFocus />
            </label>
            <label className="field">
              Records
              <select value={editing.object_key} onChange={(e) => setEditing({ ...editing, object_key: e.target.value, criteria: [] })}>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.plural}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Matching</span>
              <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                {editing.criteria.length ? editing.criteria.map((c: Filter, i: number) => <span key={i} className="chip filter-chip">{describeFilter(obj, c)}</span>) : <span className="muted small">All {obj.plural.toLowerCase()}</span>}
                <button className="link" onClick={() => setFiltering(true)}>
                  {editing.criteria.length ? 'Edit' : 'Add conditions'}
                </button>
              </div>
            </div>
            <label className="field">
              Share with
              <select value={editing.target} onChange={(e) => setEditing({ ...editing, target: e.target.value })}>
                <option value="team">A team</option>
                <option value="role">Everyone with a role</option>
              </select>
            </label>
            {editing.target === 'team' ? (
              <label className="field">
                Team
                <select value={editing.team_id ?? ''} onChange={(e) => setEditing({ ...editing, team_id: e.target.value })}>
                  <option value="">Choose…</option>
                  {teams?.items.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field">
                Role
                <select value={editing.role_key ?? ''} onChange={(e) => setEditing({ ...editing, role_key: e.target.value })}>
                  {roles?.items.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Access
              <select value={editing.access} onChange={(e) => setEditing({ ...editing, access: e.target.value })}>
                <option value="read">Read only</option>
                <option value="edit">Read and edit</option>
              </select>
            </label>
            <label className="row" style={{ alignSelf: 'end', height: 34 }}>
              <input type="checkbox" checked={editing.is_active} onChange={(e) => setEditing({ ...editing, is_active: e.target.checked })} /> Active
            </label>
          </div>
        </Modal>
      )}
      {editing && obj && filtering && (
        <FilterBuilder
          obj={obj}
          value={editing.criteria}
          onClose={() => setFiltering(false)}
          onChange={(criteria) => {
            setEditing({ ...editing, criteria });
            setFiltering(false);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------- API keys
export function ApiKeysTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['admin-api-keys'], queryFn: () => get<{ items: Json[] }>('/api/admin/api-keys') });
  const { data: users } = useUsers();
  const { me } = useAuth();
  const [creating, setCreating] = useState<{ name: string; userId: string; write: boolean; expires: string } | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const origin = window.location.origin;
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          Keys let other systems (your website, Zapier, Make, n8n, a data warehouse) use the <code>/api/v1</code> API as a chosen person, with that person’s access. Read keys can only read.
        </p>
        <button className="btn primary" onClick={() => setCreating({ name: '', userId: me?.user.id ?? '', write: false, expires: '365' })}>
          New API key
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.items.length ? (
        <Empty title="No API keys yet" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Key</th>
              <th>Acts as</th>
              <th>Access</th>
              <th>Last used</th>
              <th>Expires</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((k) => (
              <tr key={k.id} className={k.revoked_at ? 'muted-row' : undefined}>
                <td>
                  <b>{k.name}</b>
                  <div className="mono small muted">{k.prefix}</div>
                </td>
                <td>{k.user_name}</td>
                <td>{k.scopes.includes('write') ? 'Read & write' : 'Read only'}</td>
                <td className="small">{k.last_used_at ? `${relative(k.last_used_at)} · ${number(k.use_count)} calls` : 'Never'}</td>
                <td className="small">{k.revoked_at ? <span className="chip bad">Revoked</span> : k.expires_at ? date(k.expires_at) : 'Never'}</td>
                <td>
                  {!k.revoked_at && (
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        if (!window.confirm(`Revoke “${k.name}”? Anything using it stops working immediately.`)) return;
                        await del(`/api/admin/api-keys/${k.id}`);
                        qc.invalidateQueries({ queryKey: ['admin-api-keys'] });
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <details className="panel" style={{ padding: '10px 14px' }}>
        <summary>
          <b>How to call the API</b>
        </summary>
        <pre className="code-block">{`curl ${origin}/api/v1/records/lead?limit=10 \\
  -H "Authorization: Bearer syn_${me?.tenant.slug ?? 'workspace'}_…"

curl -X POST ${origin}/api/v1/records/lead \\
  -H "Authorization: Bearer syn_${me?.tenant.slug ?? 'workspace'}_…" \\
  -H "Content-Type: application/json" \\
  -d '{"first_name":"Asha","last_name":"Rao","email":"asha@example.in","source":"website"}'`}</pre>
        <p className="muted small">Endpoints: /records/:object (list, filters, create), /records/:object/:id (get, patch, delete), /records/:object/:id/timeline, /tasks, /reports/:id/run, /export/:object. Errors come back as JSON with a code and message.</p>
      </details>
      {creating && (
        <Modal
          title="New API key"
          onClose={() => setCreating(null)}
          footer={
            <button
              className="btn primary"
              disabled={!creating.name.trim()}
              onClick={async () => {
                try {
                  const r = await post<{ key: string }>('/api/admin/api-keys', { name: creating.name.trim(), userId: creating.userId, scopes: creating.write ? ['read', 'write'] : ['read'], expiresInDays: creating.expires ? Number(creating.expires) : null });
                  setCreating(null);
                  setShown(r.key);
                  qc.invalidateQueries({ queryKey: ['admin-api-keys'] });
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Create key
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="e.g. Website lead sync" autoFocus />
            </label>
            <label className="field">
              Acts as
              <select value={creating.userId} onChange={(e) => setCreating({ ...creating, userId: e.target.value })}>
                {users?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Expires
              <select value={creating.expires} onChange={(e) => setCreating({ ...creating, expires: e.target.value })}>
                <option value="30">In 30 days</option>
                <option value="90">In 90 days</option>
                <option value="365">In 1 year</option>
                <option value="">Never</option>
              </select>
            </label>
            <label className="row wide">
              <input type="checkbox" checked={creating.write} onChange={(e) => setCreating({ ...creating, write: e.target.checked })} /> Allow creating, changing and deleting records
            </label>
          </div>
        </Modal>
      )}
      {shown && (
        <Modal title="Copy your API key" onClose={() => setShown(null)} footer={<button className="btn primary" onClick={() => setShown(null)}>I have stored it</button>}>
          <div className="modal-body" style={{ display: 'block' }}>
            <p style={{ marginTop: 0 }}>
              This is the only time the full key is shown. Store it in your integration’s secret settings — never in a web page or a shared document.
            </p>
            <div className="row">
              <input readOnly value={shown} className="mono small" onFocus={(e) => e.target.select()} aria-label="API key" />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(shown)}>
                Copy
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------- usage
export function UsageTab() {
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['admin-usage'], queryFn: () => get<Json>('/api/admin/usage') });
  if (!data) return <Spinner />;
  const label = (k: string) => meta?.objects.find((o) => o.key === k)?.plural ?? k;
  return (
    <div className="stack">
      <div className="kpis">
        {[
          ['Active people', data.users.active, `${data.users.invited} invited · ${data.users.disabled} disabled`],
          ['Records', data.totalRecords, `${number(data.activities)} timeline entries`],
          ['Automation runs', data.automationsThisMonth, 'this month'],
          ['AI requests', data.aiThisMonth.reduce((a: number, x: Json) => a + x.calls, 0), 'this month'],
          ['API keys', data.apiKeys.active, `${number(data.apiKeys.calls)} calls`],
        ].map(([l, v, sub]) => (
          <div key={l as string} className="panel kpi">
            <div className="l">{l}</div>
            <div className="v">{number(v)}</div>
            <div className="muted small">{sub}</div>
          </div>
        ))}
      </div>
      <div className="two-col">
        <section className="panel">
          <div className="panel-head">
            <h2>Records by object</h2>
          </div>
          <table className="data">
            <tbody>
              {Object.entries(data.records as Record<string, number>)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <tr key={k}>
                    <td>{label(k)}</td>
                    <td className="num">{number(n)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>This month</h2>
          </div>
          <table className="data">
            <tbody>
              {data.aiThisMonth.map((a: Json) => (
                <tr key={a.provider}>
                  <td>AI · {a.provider}</td>
                  <td className="num">
                    {number(a.calls)} requests · {number(a.tokens)} tokens
                  </td>
                </tr>
              ))}
              {data.messagesThisMonth.map((m: Json) => (
                <tr key={m.channel + m.direction}>
                  <td>
                    {m.channel} {m.direction === 'out' ? 'sent' : 'received'}
                  </td>
                  <td className="num">{number(m.count)}</td>
                </tr>
              ))}
              <tr>
                <td>Open tasks</td>
                <td className="num">{number(data.tasksOpen)}</td>
              </tr>
              <tr>
                <td>Knowledge-base documents</td>
                <td className="num">{number(data.kbDocuments)}</td>
              </tr>
              <tr>
                <td>Custom-field data</td>
                <td className="num">{(data.storageBytes / 1024 / 1024).toFixed(2)} MB</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
      <p className="muted small">
        Synapse runs on free tiers (Cloudflare Workers, Neon Postgres 0.5 GB, Workers AI). Usage here helps you see when a workspace is getting close to those limits.
      </p>
    </div>
  );
}
