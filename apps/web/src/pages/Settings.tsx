import type { FieldDef } from '@synapse/shared';
import type { RolePermissions } from '@synapse/shared';
import { RoleEditor } from '../components/admin/RoleEditor';
import { ConnectorsTab } from '../components/admin/Connectors';
import { ConnectionKeysTab, Guide, GuidesDirectory } from '../components/admin/ConnectionKeys';
import { IntegrationsTab } from '../components/admin/IntegrationsAdmin';
import { PrivacyTab } from '../components/admin/PrivacyAdmin';
import { SolutionsPanel } from '../components/admin/SolutionsAdmin';
import { AgentsAdmin, CompetitorsAdmin } from '../components/admin/IntelAdmin';
import { QuickReplies, TemplatesModal } from '../components/admin/WhatsAppAdmin';
import { ChannelActions, ChannelStatus } from '../components/admin/ChannelManage';
import { useOAuthReturn } from '../lib/oauthReturn';
import { OrganisationTab } from './Organisation';
import { DocTemplatesTab } from '../components/admin/DocTemplates';
import { AutomationsTab } from '../components/builders/AutomationBuilder';
import { FieldEditor, TYPE_LABELS } from '../components/builders/FieldEditor';
import { LayoutBuilder } from '../components/builders/LayoutBuilder';
import { RulesEditor } from '../components/builders/RulesEditor';
import { SalesSetup } from '../components/SalesSetup';
import { PeopleTab } from '../components/admin/People';
import { RoutingTab } from '../components/admin/RoutingAdmin';
import { AppsTab } from '../components/admin/AppsAdmin';
import { ServiceSettingsTab } from '../components/ops/ServicePanels';
import { ApiKeysTab, SecurityPolicyTab, SharingRulesTab, TeamsTab, UsageTab } from '../components/admin/SecurityAdmin';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { UsageCostsTab } from '../components/admin/UsageCosts';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, download, get, patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { useMeta } from '../lib/hooks';

type Json = Record<string, any>;

const GROUPS: [string, [string, string, string][]][] = [
  ['Company', [
    ['organisation', 'Organisation', 'organisation'],
    ['templates', 'Document templates', 'billing'],
  ]],
  ['Customise', [
    ['fields', 'Objects & fields', 'metadata'],
    ['pipelines', 'Pipelines', 'metadata'],
    ['workflows', 'Automations', 'workflows'],
    ['routing', 'Routing & approvals', 'workflows'],
    ['service', 'Service & delivery', 'workflows'],
    ['forms', 'Web forms', 'metadata'],
    ['sales', 'Sales setup', 'metadata'],
    ['apps', 'Apps', 'modules'],
    ['modules', 'Industry modules', 'modules'],
  ]],
  ['People & access', [
    ['users', 'Users', 'users'],
    ['teams', 'Teams', 'users'],
    ['roles', 'Roles & access', 'roles'],
    ['sharing', 'Sharing rules', 'roles'],
    ['security', 'Security', 'users'],
  ]],
  ['Intelligence', [
    ['agents', 'AI agents', 'ai'],
    ['competitors', 'Competitors', 'ai'],
  ]],
  ['Connect', [
    ['guides', 'Setup guides', '*'],
    ['keys', 'Connection keys', 'channels'],
    ['ai', 'AI models', 'ai'],
    ['integrations', 'Integrations', 'channels'],
    ['connectors', 'Connectors (Teams, Jira, ERP)', 'developers'],
    ['channels', 'Channels', 'channels'],
    ['apikeys', 'API keys', 'users'],
    ['domains', 'Domains', 'domains'],
  ]],
  ['Monitor', [
    ['privacy', 'Privacy & DPDP', 'privacy'],
    ['usage', 'Usage', 'users'],
    ['costs', 'Usage & costs', 'metadata'],
    ['audit', 'Audit log', 'audit'],
  ]],
];

export function SettingsPage() {
  const { can } = useAuth();
  useOAuthReturn();
  const groups = GROUPS.map(([g, items]) => [g, items.filter(([, , area]) => area === '*' || can(area))] as const).filter(([, items]) => items.length);
  const all = groups.flatMap(([, items]) => items);
  const initial = (() => {
    const qs = new URLSearchParams(window.location.search);
    const h = qs.get('integration') ? 'integrations' : qs.get('keys') ? 'keys' : window.location.hash.slice(1);
    return all.some(([k]) => k === h) ? h : (all[0]?.[0] ?? 'fields');
  })();
  const [tab, setTabState] = useState<string>(initial);
  const setTab = (k: string) => {
    setTabState(k);
    history.replaceState(null, '', `#${k}`);
  };
  const current = all.find(([k]) => k === tab);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Shape SanchalanOS to how your business sells.</p>
        </div>
        <select className="settings-select" value={tab} onChange={(e) => setTab(e.target.value)} aria-label="Settings section">
          {groups.map(([g, items]) => (
            <optgroup key={g} label={g}>
              {items.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {groups.map(([g, items]) => (
            <div key={g}>
              <div className="settings-group">{g}</div>
              {items.map(([k, l]) => (
                <button key={k} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
                  {l}
                </button>
              ))}
            </div>
          ))}
        </nav>
      <section className="panel" aria-label={current?.[1]}>
        <div className="panel-head">
          <h2>{current?.[1]}</h2>
        </div>
        <div className="panel-body">
          {tab === 'organisation' && <OrganisationTab />}
          {tab === 'templates' && <DocTemplatesTab />}
          {tab === 'fields' && <ObjectsTab />}
          {tab === 'pipelines' && <PipelinesTab />}
          {tab === 'sales' && <SalesSetup />}
          {tab === 'users' && <PeopleTab />}
          {tab === 'teams' && <TeamsTab />}
          {tab === 'sharing' && <SharingRulesTab />}
          {tab === 'security' && <SecurityPolicyTab />}
          {tab === 'apikeys' && <ApiKeysTab />}
          {tab === 'usage' && <UsageTab />}
          {tab === 'costs' && <UsageCostsTab />}
          {tab === 'roles' && <RolesTab />}
          {tab === 'modules' && <ModulesTab />}
          {tab === 'apps' && <AppsTab />}
          {tab === 'ai' && <AiModelsTab />}
          {tab === 'agents' && <AgentsAdmin />}
          {tab === 'competitors' && <CompetitorsAdmin />}
          {tab === 'workflows' && <AutomationsTab />}
          {tab === 'routing' && <RoutingTab />}
          {tab === 'service' && <ServiceSettingsTab />}
          {tab === 'forms' && <FormsTab />}
          {tab === 'guides' && <GuidesDirectory />}
          {tab === 'keys' && <ConnectionKeysTab />}
          {tab === 'integrations' && <IntegrationsTab />}
          {tab === 'connectors' && <ConnectorsTab />}
          {tab === 'channels' && <ChannelsTab />}
          {tab === 'domains' && <DomainsTab />}
          {tab === 'audit' && <AuditTab />}
          {tab === 'privacy' && <PrivacyTab />}
        </div>
      </section>
      </div>
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

// ------------------------------------------------------------------ objects: fields, page layout, validation rules
function ObjectsTab() {
  const { data: meta } = useMeta();
  const run = useRun();
  const [objectKey, setObjectKey] = useState('lead');
  const [sub, setSub] = useState<'fields' | 'layout' | 'rules'>('fields');
  const [editing, setEditing] = useState<FieldDef | 'new' | null>(null);
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
        <div className="seg" role="tablist" aria-label="Object settings">
          {([['fields', 'Fields'], ['layout', 'Page layout'], ['rules', 'Validation rules']] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={sub === k} aria-pressed={sub === k} onClick={() => setSub(k)}>
              {l}
              {k === 'rules' && obj?.validationRules?.length ? ` (${obj.validationRules.length})` : ''}
            </button>
          ))}
        </div>
      </div>
      {obj && sub === 'fields' && (
        <>
          <div className="spread">
            <p className="muted small" style={{ margin: 0 }}>
              {obj.fields.length} fields · {obj.fields.filter((f) => !f.standard).length} custom
            </p>
            <div className="row">
              {obj.fields.some((f) => f.type === 'formula' || f.type === 'rollup') && (
                <button className="btn" onClick={() => run(() => post(`/api/admin/objects/${objectKey}/recalculate`), 'Recalculating formulas and roll-ups')}>
                  Recalculate
                </button>
              )}
              <button className="btn primary" onClick={() => setEditing('new')}>
                Add field
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>API name</th>
                  <th>Type</th>
                  <th>Details</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {obj.fields.map((f) => (
                  <tr key={f.key}>
                    <td>
                      <b>{f.label}</b>
                    </td>
                    <td className="muted mono small">{f.key}</td>
                    <td>{TYPE_LABELS[f.type]}</td>
                    <td className="small" style={{ whiteSpace: 'normal' }}>
                      {[
                        f.standard && 'standard',
                        f.required && 'required',
                        f.options?.requiredWhen && 'conditionally required',
                        f.options?.visibleWhen && 'conditionally shown',
                        f.options?.controlling && `depends on ${obj.fields.find((x) => x.key === f.options!.controlling!.field)?.label ?? f.options.controlling.field}`,
                        f.indexed && 'filterable',
                        f.pii && 'personal data',
                        f.type === 'formula' && f.options?.expression && <code key="e" className="mono">= {f.options.expression}</code>,
                        f.moduleKey && `module: ${f.moduleKey}`,
                      ]
                        .filter(Boolean)
                        .map((x, i) => (
                          <span key={i}>
                            {i > 0 && ' · '}
                            {x}
                          </span>
                        ))}
                    </td>
                    <td>
                      {!f.standard && (
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn sm" onClick={() => setEditing(f)}>
                            Edit
                          </button>
                          <button className="btn danger sm" onClick={() => window.confirm(`Remove "${f.label}"? Existing values are kept but hidden.`) && run(() => del(`/api/admin/objects/${objectKey}/fields/${f.key}`), 'Field removed', [['meta']])}>
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {obj && sub === 'layout' && <LayoutBuilder obj={obj} />}
      {obj && sub === 'rules' && <RulesEditor obj={obj} />}
      {obj && editing && <FieldEditor obj={obj} field={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {newObject && <NewObjectModal onClose={() => setNewObject(false)} onCreated={(k) => setObjectKey(k)} />}
    </div>
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
function RolesTab() {
  const run = useRun();
  const { data, isLoading } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles') });
  const [edit, setEdit] = useState<{ id?: string; key: string; name: string; perms: RolePermissions; json: string; advanced: boolean } | null>(null);
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Record access: none, own, team (you and your direct reports) or all. Fields can be hidden or read-only per role, and conditions like <code>{'{"field":"city","op":"eq","value":"$user.region"}'}</code> limit rows by user attributes.
        </p>
        <button className="btn primary" onClick={() => {
            const perms: RolePermissions = { objects: { '*': { read: 'all', create: true, update: 'own', delete: 'none' } }, fields: {}, conditions: {}, admin: [] };
            setEdit({ key: '', name: '', perms, json: JSON.stringify(perms, null, 2), advanced: false });
          }}>
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
                  <button className="btn sm" onClick={() => setEdit({ id: r.id, key: r.key, name: r.name, perms: r.permissions as RolePermissions, json: JSON.stringify(r.permissions, null, 2), advanced: false })}>
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
                let permissions: unknown = edit.perms;
                if (edit.advanced) {
                  try {
                    permissions = JSON.parse(edit.json);
                  } catch {
                    window.alert('Permissions must be valid JSON');
                    return;
                  }
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
            <div className="wide" style={{ gridColumn: '1 / -1' }}>
            <div className="spread" style={{ margin: '10px 0 6px' }}>
              <b>Permissions</b>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={edit.advanced}
                  onChange={(e) => {
                    if (e.target.checked) setEdit({ ...edit, advanced: true, json: JSON.stringify(edit.perms, null, 2) });
                    else {
                      try {
                        setEdit({ ...edit, advanced: false, perms: JSON.parse(edit.json) });
                      } catch {
                        window.alert('Fix the JSON first');
                      }
                    }
                  }}
                />{' '}
                Advanced (JSON, with row conditions)
              </label>
            </div>
            {edit.advanced ? (
              <textarea value={edit.json} onChange={(e) => setEdit({ ...edit, json: e.target.value })} style={{ minHeight: 300, width: '100%', fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }} spellCheck={false} />
            ) : (
              <RoleEditor value={edit.perms} onChange={(perms) => setEdit({ ...edit, perms })} />
            )}
            </div>
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
    <div className="stack">
    <SolutionsPanel />
    <h3 style={{ margin: '12px 0 0' }}>Other industry modules</h3>
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
    </div>
  );
}

// ------------------------------------------------------------------ workflows
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
  const [c, setC] = useState<{ channel: string; name: string; from: string; phoneNumberId: string; wabaId?: string; url: string; s1: string; s2: string; s3: string } | null>(null);
  const [templatesFor, setTemplatesFor] = useState<Json | null>(null);
  const save = async () => {
    if (!c) return;
    const body =
      c.channel === 'email'
        ? { channel: 'email', name: c.name, provider: 'resend', config: { from: c.from }, secrets: { apiKey: c.s1 } }
        : c.channel === 'whatsapp'
          ? { channel: 'whatsapp', name: c.name, provider: 'meta_cloud', config: { phoneNumberId: c.phoneNumberId, ...(c.wabaId ? { wabaId: c.wabaId } : {}) }, secrets: { accessToken: c.s1, appSecret: c.s2, verifyToken: c.s3 } }
          : c.channel === 'instagram'
            ? { channel: 'instagram', name: c.name, provider: 'meta_cloud', config: { pageId: c.phoneNumberId }, secrets: { accessToken: c.s1, appSecret: c.s2, verifyToken: c.s3 } }
            : { channel: 'webhook', name: c.name, provider: 'generic', config: { url: c.url }, secrets: c.s1 ? { signingSecret: c.s1 } : {} };
    if (await run(() => post('/api/admin/channels', body), 'Channel connected', [['admin-channels']])) setC(null);
  };
  return (
    <div className="stack">
      <div className="spread">
        <p className="muted" style={{ margin: 0 }}>
          Connect email, WhatsApp and Instagram so automations can message customers, new enquiries become leads (routed by your assignment rules) and replies land on the right timeline.
        </p>
        <button className="btn primary" onClick={() => setC({ channel: 'whatsapp', name: '', from: '', phoneNumberId: '', url: '', s1: '', s2: '', s3: '' })}>
          Connect channel
        </button>
      </div>
      <table className="data">
        <tbody>
          {data?.items.map((x) => (
            <tr key={x.id} style={x.status === 'disabled' ? { opacity: 0.6 } : undefined}>
              <td style={{ whiteSpace: 'normal' }}>
                <b>{x.name}</b>
                <div className="muted small">
                  {x.channel} via {x.provider}
                </div>
                <ChannelStatus x={x} />
              </td>
              <td className="small" style={{ whiteSpace: 'normal', wordBreak: 'break-all' }}>
                Inbound URL: <code>{x.inboundUrl}</code>
              </td>
              <td>
                <div className="row" style={{ justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6 }}>
                  <ChannelActions x={x} onTemplates={x.channel === 'whatsapp' ? () => setTemplatesFor(x) : undefined} />
                  <button className="btn sm danger" onClick={() => confirm(`Remove ${x.name}? Its conversations stay; it stops sending and receiving.`) && run(() => del(`/api/admin/channels/${x.id}`), 'Channel removed', [['admin-channels']])}>
                    Remove
                  </button>
                </div>
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
                <option value="instagram">Instagram Direct (Meta)</option>
                <option value="email">Email (Resend)</option>
                <option value="webhook">Webhook</option>
              </select>
            </label>
            <label className="field">
              Name
              <input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
            </label>
            <div className="wide">
              <Guide id={({ whatsapp: 'whatsapp', instagram: 'instagram', email: 'email_channel', webhook: 'webhook_channel' } as Record<string, string>)[c.channel]!} open />
            </div>
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
            {(c.channel === 'whatsapp' || c.channel === 'instagram') && (
              <>
                <label className="field">
                  {c.channel === 'instagram' ? 'Facebook page ID (linked to the Instagram account)' : 'Phone number ID'}
                  <input value={c.phoneNumberId} onChange={(e) => setC({ ...c, phoneNumberId: e.target.value })} />
                </label>
                {c.channel === 'whatsapp' && (
                  <label className="field">
                    WhatsApp Business Account ID (for templates)
                    <input value={c.wabaId ?? ''} onChange={(e) => setC({ ...c, wabaId: e.target.value })} />
                  </label>
                )}
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
      {templatesFor && <TemplatesModal account={templatesFor} onClose={() => setTemplatesFor(null)} />}
      <QuickReplies />
    </div>
  );
}

function DomainsTab() {
  const run = useRun();
  const { me } = useAuth();
  const { data } = useQuery({ queryKey: ['admin-domains'], queryFn: () => get<{ items: Json[] }>('/api/admin/domains') });
  const { data: probe } = useQuery({ queryKey: ['tenant-probe'], queryFn: () => get<{ vanityDomains: string | null; appHost: string | null }>('/api/public/tenant'), staleTime: Infinity });
  const [host, setHost] = useState('');
  const vanity = probe?.vanityDomains && me ? `${me.tenant.slug}.${probe.vanityDomains}` : null;
  const hasVanity = vanity && data?.items.some((d) => d.hostname === vanity && d.status === 'active');
  return (
    <div className="stack">
      {probe?.appHost && (
        <p className="muted" style={{ margin: 0 }}>
          Your team signs in at <b>{probe.appHost}</b> with workspace ID <b>{me?.tenant.slug}</b>.
        </p>
      )}
      {vanity && !hasVanity && (
        <div className="row">
          <button className="btn" onClick={() => run(() => post('/api/admin/domains/workspace-subdomain'), `${vanity} is ready`, [['admin-domains']])}>
            Give this workspace its own address: {vanity}
          </button>
        </div>
      )}
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

function AuditExport() {
  const toast = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const [head, setHead] = useState<string | null>(null);
  return (
    <div className="row audit-export" style={{ flexWrap: 'wrap' }}>
      <span className="small muted">Tamper-evident export (each line carries the hash of the one before):</span>
      <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="From" style={{ width: 'auto' }} />
      <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} aria-label="To" style={{ width: 'auto' }} />
      <button
        className="btn sm"
        onClick={async () => {
          try {
            const h = await download(`/api/admin/audit/export?from=${from}&to=${to}`, `audit-${from}-to-${to}.ndjson`);
            setHead(h.get('x-audit-head'));
          } catch (e) {
            toast((e as Error).message, true);
          }
        }}
      >
        Download
      </button>
      {head && <span className="small mono" title="Keep this fingerprint: recomputing the chain must end with it">Final hash {head.slice(0, 16)}…</span>}
    </div>
  );
}

function AuditTab() {
  const { data, isLoading } = useQuery({ queryKey: ['admin-audit'], queryFn: () => get<{ items: Json[] }>('/api/admin/audit?limit=200') });
  if (isLoading) return <Spinner />;
  return (
    <div className="stack">
    <AuditExport />
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
    </div>
  );
}

// ------------------------------------------------------------------ AI models (bring your own keys)
const AI_PROVIDERS: { key: string; label: string; model: string; note: string }[] = [
  { key: 'openai', label: 'OpenAI', model: 'gpt-4.1-mini', note: 'platform.openai.com → API keys' },
  { key: 'anthropic', label: 'Anthropic (Claude)', model: 'claude-haiku-5-5', note: 'console.anthropic.com → API keys' },
  { key: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', note: 'aistudio.google.com → Get API key' },
  { key: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile', note: 'console.groq.com → API keys' },
  { key: 'openrouter', label: 'OpenRouter', model: 'openrouter/auto', note: 'openrouter.ai → Keys' },
  { key: 'openai_compatible', label: 'Other OpenAI-compatible endpoint', model: '', note: 'Together, Mistral, Azure OpenAI, a self-hosted vLLM…' },
];

function AiModelsTab() {
  const run = useRun();
  const toast = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['admin-ai'], queryFn: () => get<{ items: Json[]; settings: { platformFallback: boolean }; encryptionConfigured: boolean }>('/api/admin/ai/providers') });
  const [adding, setAdding] = useState<{ provider: string; model: string; apiKey: string; baseUrl: string; allowPii: boolean; label: string } | null>(null);
  const [rotating, setRotating] = useState<Json | null>(null);
  const [newKey, setNewKey] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  if (isLoading) return <Spinner />;
  const def = AI_PROVIDERS.find((p) => p.key === adding?.provider);

  const test = async (id: string) => {
    setTesting(id);
    try {
      const r = await post<{ ok: boolean; error?: string; latencyMs?: number }>(`/api/admin/ai/providers/${id}/test`);
      toast(r.ok ? `Connected (${r.latencyMs} ms)` : `Connection failed: ${r.error}`, !r.ok);
    } finally {
      setTesting(null);
      qc.invalidateQueries({ queryKey: ['admin-ai'] });
    }
  };

  return (
    <div className="stack">
      <Guide id="ai_models" />
      <p className="muted" style={{ margin: 0, maxWidth: '75ch' }}>
        Use your own model accounts for SanchalanOS AI. Your keys are tried first, in the order below; the built-in models are used as a backup unless you turn that off.
        Keys are encrypted before they are stored and are never shown again, only their last four characters.
      </p>
      {!data?.encryptionConfigured && <div className="field-error">This deployment has no encryption key configured, so keys cannot be saved. Ask your platform administrator to set DATA_ENCRYPTION_KEY.</div>}
      <div className="spread">
        <label className="row">
          <input
            type="checkbox"
            checked={data?.settings.platformFallback ?? true}
            onChange={(e) => run(() => put('/api/admin/ai/settings', { platformFallback: e.target.checked }), e.target.checked ? 'Built-in models enabled as backup' : 'Only your own keys will be used', [['admin-ai']])}
          />
          Use built-in models when my keys fail or are not set
        </label>
        <button className="btn primary" disabled={!data?.encryptionConfigured} onClick={() => setAdding({ provider: 'openai', model: 'gpt-4.1-mini', apiKey: '', baseUrl: '', allowPii: false, label: '' })}>
          Add API key
        </button>
      </div>
      {data?.items.length ? (
        <table className="data">
          <thead>
            <tr>
              <th>Order</th>
              <th>Provider</th>
              <th>Model</th>
              <th>Key</th>
              <th>Personal data</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.items.map((p, i) => (
              <tr key={p.id}>
                <td>
                  <div className="row">
                    {i + 1}
                    {i > 0 && (
                      <button className="btn ghost sm" aria-label="Move up" onClick={() => run(() => patch(`/api/admin/ai/providers/${p.id}`, { priority: Math.max(1, data.items[i - 1]!.priority - 1) }), 'Order updated', [['admin-ai']])}>
                        ↑
                      </button>
                    )}
                  </div>
                </td>
                <td>
                  <b>{p.label}</b>
                  {p.base_url && <div className="muted small">{p.base_url}</div>}
                </td>
                <td>
                  <button
                    className="btn ghost sm"
                    onClick={() => {
                      const m = window.prompt('Model name', p.model);
                      if (m && m !== p.model) run(() => patch(`/api/admin/ai/providers/${p.id}`, { model: m }), 'Model updated', [['admin-ai']]);
                    }}
                  >
                    {p.model}
                  </button>
                </td>
                <td className="muted">{p.key_hint}</td>
                <td>
                  <label className="row small">
                    <input type="checkbox" checked={p.allow_pii} onChange={(e) => run(() => patch(`/api/admin/ai/providers/${p.id}`, { allowPii: e.target.checked }), 'Saved', [['admin-ai']])} />
                    Allowed
                  </label>
                </td>
                <td className="small" style={{ whiteSpace: 'normal', maxWidth: 220 }}>
                  {!p.is_enabled ? <span className="chip">Paused</span> : p.last_error ? <span className="field-error">{p.last_error}</span> : p.last_used_at ? <span className="chip good">Used {relative(p.last_used_at)}</span> : <span className="muted">Not used yet</span>}
                </td>
                <td>
                  <div className="row">
                    <button className="btn sm" disabled={testing === p.id} onClick={() => test(p.id)}>
                      {testing === p.id ? 'Testing…' : 'Test'}
                    </button>
                    <button className="btn sm" onClick={() => { setRotating(p); setNewKey(''); }}>
                      Replace key
                    </button>
                    <button className="btn sm" onClick={() => run(() => patch(`/api/admin/ai/providers/${p.id}`, { isEnabled: !p.is_enabled }), p.is_enabled ? 'Paused' : 'Resumed', [['admin-ai']])}>
                      {p.is_enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn sm danger" onClick={() => window.confirm(`Remove the ${p.label} key?`) && run(() => del(`/api/admin/ai/providers/${p.id}`), 'Key removed', [['admin-ai']])}>
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty title="No API keys yet">SanchalanOS AI runs on the built-in models until you add your own.</Empty>
      )}

      {adding && (
        <Modal
          title="Add AI API key"
          onClose={() => setAdding(null)}
          footer={
            <>
              <button className="btn" onClick={() => setAdding(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={adding.apiKey.length < 8 || !adding.model || (adding.provider === 'openai_compatible' && !adding.baseUrl)}
                onClick={async () => {
                  const r = (await run(
                    () => post<{ id: string }>('/api/admin/ai/providers', { provider: adding.provider, model: adding.model, apiKey: adding.apiKey, baseUrl: adding.baseUrl || undefined, allowPii: adding.allowPii, label: adding.label || undefined, priority: (data?.items.length ?? 0) * 10 + 10 }),
                    'Key saved',
                    [['admin-ai']],
                  )) as { id: string } | null;
                  if (r) {
                    setAdding(null);
                    test(r.id);
                  }
                }}
              >
                Save and test
              </button>
            </>
          }
        >
          <div className="modal-body">
            <label className="field">
              Provider
              <select value={adding.provider} onChange={(e) => setAdding({ ...adding, provider: e.target.value, model: AI_PROVIDERS.find((p) => p.key === e.target.value)?.model ?? '' })}>
                {AI_PROVIDERS.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Model
              <input value={adding.model} onChange={(e) => setAdding({ ...adding, model: e.target.value })} placeholder="model name" />
            </label>
            {(adding.provider === 'openai_compatible' || adding.provider === 'openai') && (
              <label className="field wide">
                {adding.provider === 'openai' ? 'Base URL (optional, e.g. Azure OpenAI)' : 'Base URL'}
                <input value={adding.baseUrl} onChange={(e) => setAdding({ ...adding, baseUrl: e.target.value })} placeholder="https://api.example.com/v1" />
              </label>
            )}
            <label className="field wide">
              API key
              <input type="password" autoComplete="off" value={adding.apiKey} onChange={(e) => setAdding({ ...adding, apiKey: e.target.value })} />
              <span className="muted small">Where to find it: {def?.note}</span>
            </label>
            <label className="field wide">
              Name (optional)
              <input value={adding.label} onChange={(e) => setAdding({ ...adding, label: e.target.value })} placeholder={def?.label} />
            </label>
            <label className="row wide" style={{ alignItems: 'flex-start' }}>
              <input type="checkbox" checked={adding.allowPii} onChange={(e) => setAdding({ ...adding, allowPii: e.target.checked })} style={{ marginTop: 3 }} />
              <span>
                Allow customer personal data (names, emails, phone numbers, message text) to be sent to this provider.
                <span className="muted small" style={{ display: 'block' }}>
                  Turn this on only if your agreement with the provider covers it. Without it, this key is used for tasks that send no personal data, such as lead scoring and next-best-action.
                </span>
              </span>
            </label>
          </div>
        </Modal>
      )}

      {rotating && (
        <Modal
          title={`Replace ${rotating.label} key`}
          onClose={() => setRotating(null)}
          footer={
            <button
              className="btn primary"
              disabled={newKey.length < 8}
              onClick={async () => {
                if (await run(() => patch(`/api/admin/ai/providers/${rotating.id}`, { apiKey: newKey }), 'Key replaced', [['admin-ai']])) {
                  const id = rotating.id as string;
                  setRotating(null);
                  test(id);
                }
              }}
            >
              Replace and test
            </button>
          }
        >
          <div className="modal-body">
            <label className="field wide">
              New API key
              <input type="password" autoComplete="off" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
