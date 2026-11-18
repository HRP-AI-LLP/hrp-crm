/**
 * The role editor as a permission matrix: every record type grouped by module with View / Create /
 * Edit / Delete (none, own, team, all), field-level access per record type, and every admin area and
 * feature switch grouped by module, with select-all per group and per column. The raw JSON stays
 * under "Advanced".
 */
import type { ObjectMeta, RolePermissions } from '@synapse/shared';
import { APPS, PERMISSION_GROUPS } from '@synapse/shared';
import { Fragment, useMemo, useState } from 'react';
import { useMeta } from '../../lib/hooks';

type Access = 'none' | 'own' | 'team' | 'all';
type Perm = { read: Access; create: boolean; update: Access; delete: Access };
const LEVELS: Access[] = ['none', 'own', 'team', 'all'];
const LEVEL_LABEL: Record<Access, string> = { none: '—', own: 'Own', team: 'Team', all: 'All' };
const NONE: Perm = { read: 'none', create: false, update: 'none', delete: 'none' };
const FULL: Perm = { read: 'all', create: true, update: 'all', delete: 'all' };

const APP_LABEL: Record<string, string> = {
  crm: 'CRM & sales', orders: 'Orders', inventory: 'Inventory', purchasing: 'Purchasing', delivery: 'Delivery & installation', service: 'Service',
  billing: 'Billing', books: 'Books', manufacturing: 'Manufacturing', projects: 'Projects & IT', other: 'Custom modules',
};

function groupObjects(objects: ObjectMeta[]) {
  const appOf = new Map<string, string>();
  for (const [k, a] of Object.entries(APPS)) for (const o of a.objects) appOf.set(o.key, k);
  const groups = new Map<string, ObjectMeta[]>();
  for (const o of objects) {
    const g = appOf.get(o.key) ?? (o.isStandard ? 'crm' : o.moduleKey?.startsWith('app.') ? o.moduleKey.slice(4) : 'other');
    groups.set(g, [...(groups.get(g) ?? []), o]);
  }
  const order = ['crm', 'orders', 'inventory', 'purchasing', 'delivery', 'service', 'billing', 'books', 'manufacturing', 'projects', 'other'];
  return [...groups.entries()].sort((a, b) => (order.indexOf(a[0]) + 100) % 100 - ((order.indexOf(b[0]) + 100) % 100));
}

export function RoleEditor({ value, onChange }: { value: RolePermissions; onChange: (v: RolePermissions) => void }) {
  const { data: meta } = useMeta();
  const [open, setOpen] = useState<string | null>(null);
  const objects = useMemo(() => (meta?.objects ?? []).filter((o) => o.key !== 'activity'), [meta]);
  const groups = useMemo(() => groupObjects(objects), [objects]);
  const base: Perm = { ...NONE, ...(value.objects?.['*'] ?? {}) } as Perm;
  const permOf = (k: string): Perm => ({ ...base, ...(value.objects?.[k] ?? {}) }) as Perm;
  const setPerms = (patch: Record<string, Perm>) => onChange({ ...value, objects: { ...(value.objects ?? {}), ...patch } });
  const setOne = (k: string, p: Partial<Perm>) => setPerms({ [k]: { ...permOf(k), ...p } });
  const admin = new Set(value.admin ?? []);
  const fullAdmin = admin.has('*');
  const setAdmin = (keys: string[], on: boolean) => {
    const n = new Set(admin);
    for (const k of keys) on ? n.add(k) : n.delete(k);
    onChange({ ...value, admin: [...n] });
  };
  const allObjKeys = objects.map((o) => o.key);
  const col = (keys: string[], field: keyof Perm, v: Access | boolean) => setPerms(Object.fromEntries(keys.map((k) => [k, { ...permOf(k), [field]: v }])));

  const Sel = ({ k, f }: { k: string; f: 'read' | 'update' | 'delete' }) => (
    <select className={`perm-sel lv-${permOf(k)[f]}`} value={permOf(k)[f]} onChange={(e) => setOne(k, { [f]: e.target.value as Access, ...(f === 'read' && e.target.value === 'none' ? { create: false, update: 'none', delete: 'none' } : {}) })} aria-label={`${f} ${k}`}>
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {LEVEL_LABEL[l]}
        </option>
      ))}
    </select>
  );
  const ColSet = ({ keys, f }: { keys: string[]; f: 'read' | 'update' | 'delete' }) => (
    <select className="perm-sel" value="" onChange={(e) => e.target.value && col(keys, f, e.target.value as Access)} aria-label={`Set ${f} for the group`} title="Set for every row in this group">
      <option value="">set…</option>
      {LEVELS.map((l) => (
        <option key={l} value={l}>
          {LEVEL_LABEL[l]}
        </option>
      ))}
    </select>
  );

  return (
    <div className="stack">
      <section>
        <div className="spread" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Records</h3>
          <div className="row small" style={{ gap: 6 }}>
            <button type="button" className="btn sm ghost" onClick={() => setPerms(Object.fromEntries(allObjKeys.map((k) => [k, FULL])))}>
              Full access to everything
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setPerms(Object.fromEntries(allObjKeys.map((k) => [k, { read: 'all', create: false, update: 'none', delete: 'none' }])))}>
              Read-only everything
            </button>
            <button type="button" className="btn sm ghost" onClick={() => onChange({ ...value, objects: { '*': NONE } })}>
              Clear
            </button>
          </div>
        </div>
        <p className="muted small" style={{ margin: '0 0 8px' }}>
          Own = records they own · Team = theirs and their direct reports' · All = everyone's. Expand a row (▸) for field-level access.
        </p>
        <div className="table-wrap">
          <table className="data perm-matrix">
            <thead>
              <tr>
                <th>Record type</th>
                <th>View</th>
                <th>Create</th>
                <th>Edit</th>
                <th>Delete</th>
                <th title="Everything on this row">Full</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(([g, objs]) => {
                const keys = objs.map((o) => o.key);
                const allFull = keys.every((k) => JSON.stringify(permOf(k)) === JSON.stringify(FULL));
                const allCreate = keys.every((k) => permOf(k).create);
                return (
                  <Fragment key={g}>
                    <tr className="perm-group">
                      <td>
                        <b>{APP_LABEL[g] ?? g}</b>
                      </td>
                      <td>
                        <ColSet keys={keys} f="read" />
                      </td>
                      <td>
                        <input type="checkbox" checked={allCreate} onChange={(e) => col(keys, 'create', e.target.checked)} aria-label={`Create in ${APP_LABEL[g] ?? g}`} />
                      </td>
                      <td>
                        <ColSet keys={keys} f="update" />
                      </td>
                      <td>
                        <ColSet keys={keys} f="delete" />
                      </td>
                      <td>
                        <input type="checkbox" checked={allFull} onChange={(e) => setPerms(Object.fromEntries(keys.map((k) => [k, e.target.checked ? FULL : NONE])))} aria-label={`Full access to ${APP_LABEL[g] ?? g}`} />
                      </td>
                    </tr>
                    {objs.map((o) => {
                      const p = permOf(o.key);
                      const full = JSON.stringify(p) === JSON.stringify(FULL);
                      const restricted = Object.keys(value.fields?.[o.key] ?? {}).length;
                      return (
                        <Fragment key={o.key}>
                          <tr>
                            <td style={{ paddingLeft: 18 }}>
                              <button type="button" className="link-btn" onClick={() => setOpen(open === o.key ? null : o.key)} aria-expanded={open === o.key}>
                                {open === o.key ? '▾' : '▸'} {o.plural}
                              </button>
                              {restricted ? <span className="chip" style={{ marginLeft: 6 }}>{restricted} field rule{restricted > 1 ? 's' : ''}</span> : null}
                            </td>
                            <td>
                              <Sel k={o.key} f="read" />
                            </td>
                            <td>
                              <input type="checkbox" checked={p.create} disabled={p.read === 'none'} onChange={(e) => setOne(o.key, { create: e.target.checked })} aria-label={`Create ${o.plural}`} />
                            </td>
                            <td>
                              <Sel k={o.key} f="update" />
                            </td>
                            <td>
                              <Sel k={o.key} f="delete" />
                            </td>
                            <td>
                              <input type="checkbox" checked={full} onChange={(e) => setOne(o.key, e.target.checked ? FULL : NONE)} aria-label={`Full access to ${o.plural}`} />
                            </td>
                          </tr>
                          {open === o.key && (
                            <tr>
                              <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                                <FieldMatrix obj={o} value={value} onChange={onChange} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="spread" style={{ marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>Administration and features</h3>
          <label className="check-row">
            <input type="checkbox" checked={fullAdmin} onChange={(e) => setAdmin(['*'], e.target.checked)} /> Full administrator (everything below)
          </label>
        </div>
        <div className="perm-areas">
          {PERMISSION_GROUPS.map((g) => {
            const keys = g.items.map((i) => i.key);
            const all = fullAdmin || keys.every((k) => admin.has(k));
            return (
              <fieldset key={g.key} className="panel perm-area" disabled={fullAdmin}>
                <legend>
                  <label className="check-row">
                    <input type="checkbox" checked={all} onChange={(e) => setAdmin(keys, e.target.checked)} /> <b>{g.label}</b>
                  </label>
                </legend>
                {g.items.map((i) => (
                  <label key={i.key} className="perm-item">
                    <input type="checkbox" checked={fullAdmin || admin.has(i.key)} onChange={(e) => setAdmin([i.key], e.target.checked)} />
                    <span>
                      {i.label}
                      <span className="muted small"> — {i.help}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function FieldMatrix({ obj, value, onChange }: { obj: ObjectMeta; value: RolePermissions; onChange: (v: RolePermissions) => void }) {
  const rules = value.fields?.[obj.key] ?? {};
  const set = (k: string, v: 'hidden' | 'read' | 'edit') => {
    const next = { ...rules };
    if (v === 'edit') delete next[k];
    else next[k] = v;
    onChange({ ...value, fields: { ...(value.fields ?? {}), [obj.key]: next } });
  };
  const all = (v: 'hidden' | 'read' | 'edit') => onChange({ ...value, fields: { ...(value.fields ?? {}), [obj.key]: v === 'edit' ? {} : Object.fromEntries(obj.fields.filter((f) => !f.required).map((f) => [f.key, v])) } });
  return (
    <div style={{ padding: '6px 4px' }}>
      <div className="row small" style={{ gap: 6, marginBottom: 6 }}>
        <span className="muted">All fields:</span>
        <button type="button" className="btn sm ghost" onClick={() => all('edit')}>
          Edit
        </button>
        <button type="button" className="btn sm ghost" onClick={() => all('read')}>
          Read-only
        </button>
        <button type="button" className="btn sm ghost" onClick={() => all('hidden')}>
          Hidden
        </button>
      </div>
      <div className="perm-fields">
        {obj.fields.map((f) => {
          const v = rules[f.key] ?? 'edit';
          return (
            <div key={f.key} className="perm-field">
              <span title={f.key}>{f.label}</span>
              <span className="seg" role="radiogroup" aria-label={f.label}>
                {(['edit', 'read', 'hidden'] as const).map((x) => (
                  <button key={x} type="button" role="radio" aria-checked={v === x} className={v === x ? 'on' : ''} disabled={!!f.required && x === 'hidden'} onClick={() => set(f.key, x)}>
                    {x === 'edit' ? 'Edit' : x === 'read' ? 'Read' : 'Hide'}
                  </button>
                ))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
