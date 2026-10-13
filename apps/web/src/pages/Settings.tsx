import { FIELD_TYPES, type FieldType } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';

type Json = Record<string, any>;

const TABS = [
  ['fields', 'Fields', 'metadata'],
  ['pipelines', 'Pipelines', 'metadata'],
  ['users', 'Users', 'users'],
  ['roles', 'Roles & access', 'roles'],
  ['modules', 'Industry modules', 'modules'],
  ['workflows', 'Automations', 'workflows'],
  ['forms', 'Web forms', 'metadata'],
  ['channels', 'Channels', 'channels'],
  ['domains', 'Domains', 'domains'],
  ['audit', 'Audit log', 'audit'],
] as const;

export function SettingsPage() {
  const { can } = useAuth();
  const tabs = TABS.filter(([, , area]) => can(area));
  const [tab, setTab] = useState<string>(tabs[0]?.[0] ?? 'fields');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Shape Synapse to how your business sells.</p>
        </div>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist" style={{ overflowX: 'auto' }}>
          {tabs.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'fields' && <FieldsTab />}
          {tab === 'pipelines' && <PipelinesTab />}
          {tab === 'users' && <UsersTab />}
          {tab === 'roles' && <RolesTab />}
          {tab === 'modules' && <ModulesTab />}
          {tab === 'workflows' && <WorkflowsTab />}
          {tab === 'forms' && <FormsTab />}
          {tab === 'channels' && <ChannelsTab />}
          {tab === 'domains' && <DomainsTab />}
          {tab === 'audit' && <AuditTab />}
        </div>
      </section>
    </>
  );
}

function useRun() {
  const toast = useToast();
  const qc = useQueryClient();
  return async (fn: () => Promise<unknown>, ok: string, keys: string[][] = []) => {
    try {
      const r = await fn();
      toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

// ------------------------------------------------------------------ fields & objects
function FieldsTab() {
  const { data: meta } = useMeta();
  const run = useRun();
  const [objectKey, setObjectKey] = useState('lead');
  const [adding, setAdding] = useState(false);
  const [newObject, setNewObject] = useState(false);
  const obj = meta?.objects.find((o) => o.key === objectKey);
  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          <select value={objectKey} onChange={(e) => setObjectKey(e.target.value)} style={{ width: 'auto' }} aria-label="Object">
            {meta?.objects.map((o) => (
              <option key={o.key} value={o.key}>
                {o.plural}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => setNewObject(true)}>
            New object
          </button>
        </div>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add field
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Label</th>
            <th>Key</th>
            <th>Type</th>
            <th>Options</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {obj?.fields.map((f) => (
            <tr key={f.key}>
              <td>{f.label}</td>
              <td className="muted">{f.key}</td>
              <td>{f.type}</td>
              <td className="small">
                {[f.standard && 'standard', f.required && 'required', f.indexed && 'filterable', f.pii && 'personal data', f.moduleKey && `module: ${f.moduleKey}`].filter(Boolean).join(', ')}
              </td>
              <td>
                {!f.standard && (
                  <button className="btn danger sm" onClick={() => window.confirm(`Remove "${f.label}"? Existing values are kept but hidden.`) && run(() => del(`/api/admin/objects/${objectKey}/fields/${f.key}`), 'Field removed', [['meta']])}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {adding && <AddFieldModal objectKey={objectKey} onClose={() => setAdding(false)} />}
      {newObject && <NewObjectModal onClose={() => setNewObject(false)} onCreated={(k) => setObjectKey(k)} />}
    </div>
  );
}

function AddFieldModal({ objectKey, onClose }: { objectKey: string; onClose: () => void }) {
  const run = useRun();
  const { data: meta } = useMeta();
  const [f, setF] = useState({ label: '', key: '', type: 'text' as FieldType, required: false, indexed: false, pii: false, choices: '', lookupObject: 'account' });
  const keyFrom = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
  const save = async () => {
    const options: Json = {};
    if (f.type === 'picklist' || f.type === 'multipicklist') options.choices = f.choices.split(',').map((c) => c.trim()).filter(Boolean).map((c) => ({ value: keyFrom(c) || c, label: c }));
    if (f.type === 'lookup') options.lookupObject = f.lookupObject;
    const r = await run(() => put(`/api/admin/objects/${objectKey}/fields/${f.key}`, { label: f.label, type: f.type, required: f.required, indexed: f.indexed, pii: f.pii, options }), 'Field added', [['meta']]);
    if (r) onClose();
  };
  return (
    <Modal
      title="Add field"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!f.label || !f.key}>
            Add field
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Label
          <input value={f.label} onChange={(e) => setF((s) => ({ ...s, label: e.target.value, key: s.key && s.key !== keyFrom(s.label) ? s.key : keyFrom(e.target.value) }))} />
        </label>
        <label className="field">
          API key
          <input value={f.key} onChange={(e) => setF((s) => ({ ...s, key: e.target.value }))} />
        </label>
        <label className="field">
          Type
          <select value={f.type} onChange={(e) => setF((s) => ({ ...s, type: e.target.value as FieldType }))}>
            {FIELD_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {f.type === 'lookup' && (
          <label className="field">
            Links to
            <select value={f.lookupObject} onChange={(e) => setF((s) => ({ ...s, lookupObject: e.target.value }))}>
              {meta?.objects.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {(f.type === 'picklist' || f.type === 'multipicklist') && (
          <label className="field wide">
            Choices (comma separated)
            <input value={f.choices} onChange={(e) => setF((s) => ({ ...s, choices: e.target.value }))} placeholder="Hot, Warm, Cold" />
          </label>
        )}
        <div className="wide stack" style={{ gap: 6 }}>
          <label className="row">
            <input type="checkbox" checked={f.required} onChange={(e) => setF((s) => ({ ...s, required: e.target.checked }))} /> Required
          </label>
          <label className="row">
            <input type="checkbox" checked={f.indexed} onChange={(e) => setF((s) => ({ ...s, indexed: e.target.checked }))} /> Filterable (indexed for fast filters and sorting)
          </label>
          <label className="row">
            <input type="checkbox" checked={f.pii} onChange={(e) => setF((s) => ({ ...s, pii: e.target.checked }))} /> Personal data (kept out of AI providers that may train on prompts)
          </label>
        </div>
      </div>
    </Modal>
  );
}

function NewObjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (k: string) => void }) {
  const run = useRun();
  const [o, setO] = useState({ label: '', plural: '', key: '' });
  const keyFrom = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const save = async () => {
    const r = await run(() => post('/api/admin/objects', o), 'Object created', [['meta']]);
    if (r) {
      onCreated(o.key);
      onClose();
    }
  };
  return (
    <Modal
      title="New object"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={!o.label || !o.key || !o.plural}>
            Create object
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Singular label
          <input value={o.label} placeholder="Vehicle" onChange={(e) => setO((s) => ({ ...s, label: e.target.value, key: keyFrom(e.target.value), plural: s.plural || `${e.target.value}s` }))} />
        </label>
        <label className="field">
          Plural label
          <input value={o.plural} onChange={(e) => setO((s) => ({ ...s, plural: e.target.value }))} />
        </label>
        <label className="field wide">
          API key
          <input value={o.key} onChange={(e) => setO((s) => ({ ...s, key: e.target.value }))} />
        </label>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ pipelines
function PipelinesTab() {
  const { data: meta } = useMeta();
  const run = useRun();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  return (
    <div className="stack">
      {meta?.pipelines.map((p) => (
        <div key={p.id} className="panel">
          <div className="panel-head">
            <div>
              <h3>{p.name}</h3>
              <span className="muted small">
                {meta.objects.find((o) => o.key === p.objectKey)?.plural} {p.isDefault ? '· default' : ''}
              </span>
            </div>
            <div className="row">
              {!p.isDefault && (
                <button className="btn sm" onClick={() => run(() => patch(`/api/admin/pipelines/${p.id}`, { isDefault: true }), 'Default pipeline changed', [['meta']])}>
                  Make default
                </button>
              )}
              <button
                className="btn sm"
                onClick={() => {
                  setEditing(p.id);
                  setDraft(p.stages.map((s) => `${s.label} | ${s.probability} | ${s.category}`).join('\n'));
                }}
              >
                Edit stages
              </button>
            </div>
          </div>
          <div className="panel-body row" style={{ flexWrap: 'wrap' }}>
            {p.stages.map((s) => (
              <span key={s.id} className={`chip${s.category === 'won' ? ' good' : s.category === 'lost' ? ' bad' : ''}`}>
                <span className="dot" style={{ background: s.color ?? '#7b8796' }} />
                {s.label} · {s.probability}%
              </span>
            ))}
          </div>
          {editing === p.id && (
            <div className="panel-body stack">
              <label className="field">
                One stage per line: label | probability | open, won or lost
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} style={{ minHeight: 160 }} />
              </label>
              <div className="row">
                <button
                  className="btn primary"
                  onClick={async () => {
                    const stages = draft
                      .split('\n')
                      .map((l) => l.split('|').map((x) => x.trim()))
                      .filter((x) => x[0])
                      .map(([label, prob, cat]) => {
                        const existing = p.stages.find((s) => s.label === label);
                        return { key: existing?.key ?? label!.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1'), label: label!, probability: Number(prob ?? 0) || 0, category: ['won', 'lost'].includes(cat ?? '') ? cat : 'open', color: existing?.color ?? undefined };
                      });
                    if (await run(() => put(`/api/admin/pipelines/${p.id}/stages`, stages), 'Stages saved', [['meta']])) setEditing(null);
                  }}
                >
                  Save stages
                </button>
                <button className="btn" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ users & roles
function UsersTab() {
  const run = useRun();
  const { data, isLoading } = useQuery({ queryKey: ['admin-users'], queryFn: () => get<{ items: Json[] }>('/api/admin/users') });
  const { data: roles } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  const [inv, setInv] = useState<{ email: string; fullName: string; role: string } | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Attributes like region or branch drive attribute-based access rules.
        </p>
        <button className="btn primary" onClick={() => setInv({ email: '', fullName: '', role: 'sales_rep' })}>
          Invite user
        </button>
      </div>
      <table className="data">
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Attributes</th>
            <th>Last sign-in</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((u) => (
            <tr key={u.id}>
              <td>
                <b>{u.full_name}</b> {u.is_owner && <span className="chip">owner</span>}
                <div className="muted small">{u.email}</div>
              </td>
              <td>
                <select value={u.roles[0] ?? ''} onChange={(e) => run(() => patch(`/api/admin/users/${u.id}`, { roles: [e.target.value] }), 'Role updated', [['admin-users']])} style={{ width: 'auto' }} aria-label="Role">
                  {roles?.items.map((r) => (
                    <option key={r.id} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="small">
                <button
                  className="btn ghost sm"
                  onClick={() => {
                    const v = window.prompt('Attributes as JSON, e.g. {"region":"west"}', JSON.stringify(u.attributes ?? {}));
                    if (v !== null) {
                      try {
                        const parsed = JSON.parse(v);
                        run(() => patch(`/api/admin/users/${u.id}`, { attributes: parsed }), 'Attributes saved', [['admin-users']]);
                      } catch {
                        window.alert('That is not valid JSON');
                      }
                    }
                  }}
                >
                  {Object.keys(u.attributes ?? {}).length ? Object.entries(u.attributes).map(([k, v]) => `${k}: ${v}`).join(', ') : 'Add attributes'}
                </button>
              </td>
              <td className="muted">{u.last_login_at ? relative(u.last_login_at) : 'Never'}</td>
              <td>
                {!u.is_owner && (
                  <div className="row">
                    <button className="btn sm" onClick={async () => {
                      const r = (await run(() => post(`/api/admin/users/${u.id}/reset-password`), 'Password reset')) as { temporaryPassword: string } | null;
                      if (r) setTemp(r.temporaryPassword);
                    }}>
                      Reset password
                    </button>
                    <button className="btn sm danger" onClick={() => run(() => patch(`/api/admin/users/${u.id}`, { status: u.status === 'disabled' ? 'active' : 'disabled' }), u.status === 'disabled' ? 'User enabled' : 'User disabled', [['admin-users']])}>
                      {u.status === 'disabled' ? 'Enable' : 'Disable'}
                    </button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {inv && (
        <Modal
          title="Invite user"
          onClose={() => setInv(null)}
          footer={
            <button
              className="btn primary"
              disabled={!inv.email || !inv.fullName}
              onClick={async () => {
                const r = (await run(() => post('/api/admin/users', { email: inv.email, fullName: inv.fullName, roles: [inv.role] }), 'User invited', [['admin-users'], ['users']])) as { temporaryPassword?: string } | null;
                if (r) {
                  setInv(null);
                  if (r.temporaryPassword) setTemp(r.temporaryPassword);
                }
              }}
            >
              Invite user
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Full name
              <input value={inv.fullName} onChange={(e) => setInv({ ...inv, fullName: e.target.value })} />
            </label>
            <label className="field">
              Email
              <input type="email" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
            </label>
            <label className="field wide">
              Role
              <select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
                {roles?.items.map((r) => (
                  <option key={r.id} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </Modal>
      )}
      {temp && (
        <Modal title="Temporary password" onClose={() => setTemp(null)} footer={<button className="btn primary" onClick={() => setTemp(null)}>Done</button>}>
          <div className="modal-body">
            <p className="wide">Share this password privately. It is shown only once; ask the user to change it after signing in.</p>
            <input className="wide" readOnly value={temp} onFocus={(e) => e.target.select()} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function RolesTab() {
  const run = useRun();
  const { data, isLoading } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  const [edit, setEdit] = useState<{ id?: string; key: string; name: string; json: string } | null>(null);
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Record access: none, own, team (you and your direct reports) or all. Fields can be hidden or read-only per role, and conditions like <code>{'{"field":"city","op":"eq","value":"$user.region"}'}</code> limit rows by user attributes.
        </p>
        <button className="btn primary" onClick={() => setEdit({ key: '', name: '', json: JSON.stringify({ objects: { '*': { read: 'all', create: true, update: 'own', delete: 'none' } }, fields: {}, conditions: {} }, null, 2) })}>
          New role
        </button>
      </div>
      <table className="data">
        <tbody>
          {data?.items.map((r) => (
            <tr key={r.id}>
              <td>
                <b>{r.name}</b> {r.is_system && <span className="chip">built-in</span>}
                <div className="muted small">{r.description}</div>
              </td>
              <td className="muted">{r.user_count} users</td>
              <td>
                {r.key !== 'admin' && (
                  <button className="btn sm" onClick={() => setEdit({ id: r.id, key: r.key, name: r.name, json: JSON.stringify(r.permissions, null, 2) })}>
                    Edit access
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal
          title={edit.id ? `Edit ${edit.name}` : 'New role'}
          wide
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                let permissions: unknown;
                try {
                  permissions = JSON.parse(edit.json);
                } catch {
                  window.alert('Permissions must be valid JSON');
                  return;
                }
                const ok = edit.id
                  ? await run(() => patch(`/api/admin/roles/${edit.id}`, { name: edit.name, permissions }), 'Role saved', [['admin-roles']])
                  : await run(() => post('/api/admin/roles', { key: edit.key, name: edit.name, permissions }), 'Role created', [['admin-roles']]);
                if (ok) setEdit(null);
              }}
            >
              Save role
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value, key: edit.id ? edit.key : e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') })} />
            </label>
            <label className="field">
              Key
              <input value={edit.key} disabled={!!edit.id} onChange={(e) => setEdit({ ...edit, key: e.target.value })} />
            </label>
            <label className="field wide">
              Permissions
              <textarea value={edit.json} onChange={(e) => setEdit({ ...edit, json: e.target.value })} style={{ minHeight: 300, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }} spellCheck={false} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ modules
function ModulesTab() {
  const run = useRun();
  const { data } = useQuery({ queryKey: ['admin-modules'], queryFn: () => get<{ items: Json[] }>('/api/admin/modules') });
  return (
    <table className="data">
      <tbody>
        {data?.items.map((m) => (
          <tr key={m.key}>
            <td style={{ whiteSpace: 'normal' }}>
              <b>{m.name}</b>
              <div className="muted">{m.description}</div>
              <div className="small muted">Adds: {m.objects.join(', ') || 'fields and pipelines'}</div>
            </td>
            <td style={{ width: 160 }}>
              {m.installed ? (
                <span className="chip good">Installed v{m.installedVersion}</span>
              ) : (
                <button className="btn primary sm" onClick={() => run(() => post(`/api/admin/modules/${m.key}/install`), `${m.name} installed`, [['admin-modules'], ['meta']])}>
                  Install
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ workflows
function WorkflowsTab() {
  const run = useRun();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['admin-workflows'], queryFn: () => get<{ items: Json[] }>('/api/admin/workflows') });
  const [w, setW] = useState<{ name: string; objectKey: string; triggerEvent: string; field: string; op: string; value: string; action: string; title: string; text: string } | null>(null);
  const save = async () => {
    if (!w) return;
    const action =
      w.action === 'create_task'
        ? { type: 'create_task', title: w.title, dueInHours: 24, assignTo: 'owner' }
        : w.action === 'send_email'
          ? { type: 'send_email', to: 'field:email', subject: w.title, body: w.text }
          : w.action === 'send_whatsapp'
            ? { type: 'send_whatsapp', to: 'field:phone', body: w.text }
            : { type: 'ai_score' };
    const body = { name: w.name, objectKey: w.objectKey, triggerEvent: w.triggerEvent, conditions: w.field ? [{ field: w.field, op: w.op, value: w.value }] : [], actions: [action] };
    if (await run(() => post('/api/admin/workflows', body), 'Automation created', [['admin-workflows']])) setW(null);
  };
  const obj = meta?.objects.find((o) => o.key === w?.objectKey);
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          When something happens to a record and the condition matches, Synapse runs the action. Use {'{{field_key}}'} to insert record values.
        </p>
        <button className="btn primary" onClick={() => setW({ name: '', objectKey: 'lead', triggerEvent: 'created', field: '', op: 'eq', value: '', action: 'create_task', title: 'Call {{full_name}}', text: '' })}>
          New automation
        </button>
      </div>
      {data?.items.length ? (
        <table className="data">
          <tbody>
            {data.items.map((x) => (
              <tr key={x.id}>
                <td>
                  <b>{x.name}</b>
                  <div className="muted small">
                    When a {x.object_key} is {x.trigger_event.replace('_', ' ')} · {x.actions.map((a: Json) => a.type.replace('_', ' ')).join(', ')} · ran {x.run_count} times
                  </div>
                </td>
                <td style={{ width: 200 }}>
                  <div className="row">
                    <button className="btn sm" onClick={() => run(() => put(`/api/admin/workflows/${x.id}`, { name: x.name, objectKey: x.object_key, triggerEvent: x.trigger_event, conditions: x.conditions, actions: x.actions, isEnabled: !x.is_enabled }), x.is_enabled ? 'Automation paused' : 'Automation resumed', [['admin-workflows']])}>
                      {x.is_enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/workflows/${x.id}`), 'Automation deleted', [['admin-workflows']])}>
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No automations yet">Start with “when a lead is created from a referral, create a call task”.</Empty>
      )}
      {w && (
        <Modal title="New automation" onClose={() => setW(null)} footer={<button className="btn primary" onClick={save} disabled={!w.name}>Create automation</button>}>
          <div className="modal-body">
            <label className="field wide">
              Name
              <input value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />
            </label>
            <label className="field">
              When a
              <select value={w.objectKey} onChange={(e) => setW({ ...w, objectKey: e.target.value, field: '' })}>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              is
              <select value={w.triggerEvent} onChange={(e) => setW({ ...w, triggerEvent: e.target.value })}>
                <option value="created">created</option>
                <option value="updated">updated</option>
                <option value="stage_changed">moved to a new stage</option>
              </select>
            </label>
            <label className="field">
              and field (optional)
              <select value={w.field} onChange={(e) => setW({ ...w, field: e.target.value })}>
                <option value="">Any record</option>
                {obj?.fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            {w.field && (
              <label className="field">
                <select value={w.op} onChange={(e) => setW({ ...w, op: e.target.value })} aria-label="Operator">
                  <option value="eq">equals</option>
                  <option value="neq">does not equal</option>
                  <option value="gt">is greater than</option>
                  <option value="lt">is less than</option>
                  <option value="contains">contains</option>
                  <option value="changed_to">changes to</option>
                </select>
                <input value={w.value} onChange={(e) => setW({ ...w, value: e.target.value })} placeholder="value" aria-label="Value" />
              </label>
            )}
            <label className="field wide">
              Then
              <select value={w.action} onChange={(e) => setW({ ...w, action: e.target.value })}>
                <option value="create_task">Create a task for the owner</option>
                <option value="send_email">Send an email to the record</option>
                <option value="send_whatsapp">Send a WhatsApp message</option>
                <option value="ai_score">Rescore with AI (leads)</option>
              </select>
            </label>
            {(w.action === 'create_task' || w.action === 'send_email') && (
              <label className="field wide">
                {w.action === 'create_task' ? 'Task title' : 'Subject'}
                <input value={w.title} onChange={(e) => setW({ ...w, title: e.target.value })} />
              </label>
            )}
            {(w.action === 'send_email' || w.action === 'send_whatsapp') && (
              <label className="field wide">
                Message
                <textarea value={w.text} onChange={(e) => setW({ ...w, text: e.target.value })} placeholder="Hi {{first_name}}, thanks for your interest…" />
              </label>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ forms
function FormsTab() {
  const run = useRun();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['admin-forms'], queryFn: () => get<{ items: Json[] }>('/api/admin/forms') });
  const [f, setF] = useState<{ name: string; objectKey: string; fields: string[] } | null>(null);
  const obj = meta?.objects.find((o) => o.key === f?.objectKey);
  const origin = window.location.origin;
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Public forms create records straight from your website. Only the fields you place on a form are accepted.
        </p>
        <button className="btn primary" onClick={() => setF({ name: 'Website enquiry', objectKey: 'lead', fields: ['first_name', 'last_name', 'email', 'phone'] })}>
          New web form
        </button>
      </div>
      <table className="data">
        <tbody>
          {data?.items.map((x) => (
            <tr key={x.id}>
              <td>
                <b>{x.name}</b>
                <div className="muted small">Creates a {x.object_key}</div>
              </td>
              <td className="small">{x.public_key ? <a href={`${origin}/f/${x.public_key}`} target="_blank" rel="noreferrer">{`${origin}/f/${x.public_key}`}</a> : 'Internal layout'}</td>
              <td>
                <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/forms/${x.id}`), 'Form deleted', [['admin-forms']])}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {f && (
        <Modal
          title="New web form"
          onClose={() => setF(null)}
          footer={
            <button className="btn primary" disabled={!f.fields.length} onClick={async () => (await run(() => post('/api/admin/forms', { name: f.name, objectKey: f.objectKey, kind: 'public', layout: { sections: [{ fields: f.fields }] } }), 'Form created', [['admin-forms']])) && setF(null)}>
              Create form
            </button>
          }
        >
          <div className="modal-body">
            <label className="field">
              Name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            </label>
            <label className="field">
              Creates
              <select value={f.objectKey} onChange={(e) => setF({ ...f, objectKey: e.target.value, fields: [] })}>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="wide" style={{ border: '1px solid var(--line)', borderRadius: 8 }}>
              <legend className="small muted">Fields on the form</legend>
              {obj?.fields
                .filter((x) => !x.readOnly && !['owner_id', 'pipeline_id', 'stage_id'].includes(x.key))
                .map((x) => (
                  <label key={x.key} className="row" style={{ padding: '3px 0' }}>
                    <input type="checkbox" checked={f.fields.includes(x.key)} onChange={(e) => setF({ ...f, fields: e.target.checked ? [...f.fields, x.key] : f.fields.filter((k) => k !== x.key) })} />
                    {x.label} {x.required && <span className="muted small">(required)</span>}
                  </label>
                ))}
            </fieldset>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ channels, domains, audit
function ChannelsTab() {
  const run = useRun();
  const { data } = useQuery({ queryKey: ['admin-channels'], queryFn: () => get<{ items: Json[] }>('/api/admin/channels') });
  const [c, setC] = useState<{ channel: string; name: string; from: string; phoneNumberId: string; url: string; s1: string; s2: string; s3: string } | null>(null);
  const save = async () => {
    if (!c) return;
    const body =
      c.channel === 'email'
        ? { channel: 'email', name: c.name, provider: 'resend', config: { from: c.from }, secrets: { apiKey: c.s1 } }
        : c.channel === 'whatsapp'
          ? { channel: 'whatsapp', name: c.name, provider: 'meta_cloud', config: { phoneNumberId: c.phoneNumberId }, secrets: { accessToken: c.s1, appSecret: c.s2, verifyToken: c.s3 } }
          : { channel: 'webhook', name: c.name, provider: 'generic', config: { url: c.url }, secrets: c.s1 ? { signingSecret: c.s1 } : {} };
    if (await run(() => post('/api/admin/channels', body), 'Channel connected', [['admin-channels']])) setC(null);
  };
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Connect email and WhatsApp so automations can message customers and replies land on the right timeline.
        </p>
        <button className="btn primary" onClick={() => setC({ channel: 'whatsapp', name: '', from: '', phoneNumberId: '', url: '', s1: '', s2: '', s3: '' })}>
          Connect channel
        </button>
      </div>
      <table className="data">
        <tbody>
          {data?.items.map((x) => (
            <tr key={x.id}>
              <td>
                <b>{x.name}</b>
                <div className="muted small">
                  {x.channel} via {x.provider}
                </div>
              </td>
              <td className="small" style={{ whiteSpace: 'normal' }}>
                Inbound URL: <code>{x.inboundUrl}</code>
              </td>
              <td>
                <button className="btn sm danger" onClick={() => run(() => del(`/api/admin/channels/${x.id}`), 'Channel removed', [['admin-channels']])}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {c && (
        <Modal title="Connect channel" onClose={() => setC(null)} footer={<button className="btn primary" onClick={save} disabled={!c.name}>Connect</button>}>
          <div className="modal-body">
            <label className="field">
              Channel
              <select value={c.channel} onChange={(e) => setC({ ...c, channel: e.target.value })}>
                <option value="whatsapp">WhatsApp (Cloud API)</option>
                <option value="email">Email (Resend)</option>
                <option value="webhook">Webhook</option>
              </select>
            </label>
            <label className="field">
              Name
              <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
            </label>
            {c.channel === 'email' && (
              <>
                <label className="field">
                  From address
                  <input value={c.from} onChange={(e) => setC({ ...c, from: e.target.value })} placeholder="Sales <sales@yourco.in>" />
                </label>
                <label className="field">
                  Resend API key
                  <input type="password" value={c.s1} onChange={(e) => setC({ ...c, s1: e.target.value })} />
                </label>
              </>
            )}
            {c.channel === 'whatsapp' && (
              <>
                <label className="field">
                  Phone number ID
                  <input value={c.phoneNumberId} onChange={(e) => setC({ ...c, phoneNumberId: e.target.value })} />
                </label>
                <label className="field">
                  Access token
                  <input type="password" value={c.s1} onChange={(e) => setC({ ...c, s1: e.target.value })} />
                </label>
                <label className="field">
                  App secret
                  <input type="password" value={c.s2} onChange={(e) => setC({ ...c, s2: e.target.value })} />
                </label>
                <label className="field">
                  Webhook verify token
                  <input value={c.s3} onChange={(e) => setC({ ...c, s3: e.target.value })} />
                </label>
              </>
            )}
            {c.channel === 'webhook' && (
              <>
                <label className="field">
                  Endpoint URL
                  <input value={c.url} onChange={(e) => setC({ ...c, url: e.target.value })} placeholder="https://" />
                </label>
                <label className="field">
                  Signing secret
                  <input type="password" value={c.s1} onChange={(e) => setC({ ...c, s1: e.target.value })} />
                </label>
              </>
            )}
            <p className="wide muted small">Credentials are encrypted before they are stored.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DomainsTab() {
  const run = useRun();
  const { data } = useQuery({ queryKey: ['admin-domains'], queryFn: () => get<{ items: Json[] }>('/api/admin/domains') });
  const [host, setHost] = useState('');
  return (
    <div className="stack">
      <form
        className="row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => post('/api/admin/domains', { hostname: host }), 'Domain added. Add the DNS records shown to finish.', [['admin-domains']])) setHost('');
        }}
      >
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="crm.yourcompany.com" aria-label="Domain" style={{ maxWidth: 320 }} />
        <button className="btn primary" disabled={!host}>
          Add domain
        </button>
      </form>
      <table className="data">
        <tbody>
          {data?.items.map((d) => (
            <tr key={d.hostname}>
              <td>
                <b>{d.hostname}</b>
                <div className="muted small">{d.kind === 'subdomain' ? 'Included workspace address' : 'Custom domain'}</div>
                {d.verification?.cname && d.status !== 'active' && <div className="small">{d.verification.cname}</div>}
              </td>
              <td>
                <span className={`chip${d.status === 'active' ? ' good' : ''}`}>{d.status}</span>
              </td>
              <td>
                {d.kind === 'custom' && d.status !== 'active' && (
                  <button className="btn sm" onClick={() => run(() => post(`/api/admin/domains/${d.hostname}/refresh`), 'Status refreshed', [['admin-domains']])}>
                    Check status
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AuditTab() {
  const { data, isLoading } = useQuery({ queryKey: ['admin-audit'], queryFn: () => get<{ items: Json[] }>('/api/admin/audit?limit=200') });
  if (isLoading) return <Spinner />;
  return (
    <div className="table-wrap" style={{ maxHeight: '65vh' }}>
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>Action</th>
            <th>What</th>
            <th>Changes</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((a) => (
            <tr key={a.id}>
              <td className="muted">{dateTime(a.created_at)}</td>
              <td>{a.actor_name ?? 'System'}</td>
              <td>{a.action.replace(/_/g, ' ')}</td>
              <td>{a.object_key}</td>
              <td className="small muted" title={JSON.stringify(a.changes)}>
                {a.action === 'update' && a.changes ? Object.keys(a.changes).join(', ') : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
