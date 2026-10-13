import type { ObjectMeta } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { ApiError, del, get, post, put } from '../../lib/api';
import { dateTime, relative } from '../../lib/format';
import { useMeta, useUsers } from '../../lib/hooks';
import { Empty, Modal, useToast } from '../ui';
import { FormulaInput } from './FormulaInput';

type Json = Record<string, any>;
interface Cond {
  field: string;
  op: string;
  value?: unknown;
}
type Step = Json & { type: string };
interface Workflow {
  id?: string;
  name: string;
  objectKey: string;
  triggerEvent: 'created' | 'updated' | 'stage_changed' | 'deleted';
  conditions: Cond[];
  actions: Step[];
  isEnabled: boolean;
}

const TRIGGERS: [Workflow['triggerEvent'], string][] = [
  ['created', 'is created'],
  ['updated', 'is updated'],
  ['stage_changed', 'moves to a new stage'],
  ['deleted', 'is deleted'],
];

const OPS: [string, string][] = [
  ['eq', 'is'],
  ['neq', 'is not'],
  ['gt', 'is greater than'],
  ['lt', 'is less than'],
  ['contains', 'contains'],
  ['is_empty', 'is empty'],
  ['not_empty', 'is not empty'],
  ['changed', 'was changed'],
  ['changed_to', 'changed to'],
  ['formula', 'matches formula'],
];
const NO_VALUE = new Set(['is_empty', 'not_empty', 'changed']);

export const STEP_TYPES: { type: string; label: string; icon: string; make: () => Step }[] = [
  { type: 'create_task', label: 'Create a task', icon: '✓', make: () => ({ type: 'create_task', title: 'Follow up with {{title}}', dueInHours: 24, priority: 'normal', assignTo: 'owner' }) },
  { type: 'update_field', label: 'Update a field', icon: '✎', make: () => ({ type: 'update_field', field: '', value: '' }) },
  { type: 'assign_owner', label: 'Assign owner (round robin)', icon: '⟳', make: () => ({ type: 'assign_owner', userIds: [] }) },
  { type: 'send_email', label: 'Send an email', icon: '@', make: () => ({ type: 'send_email', to: 'field:email', subject: '', body: 'Hi {{first_name}},\n\n' }) },
  { type: 'send_whatsapp', label: 'Send a WhatsApp message', icon: 'W', make: () => ({ type: 'send_whatsapp', to: 'field:phone', body: 'Hi {{first_name}}, ' }) },
  { type: 'create_record', label: 'Create a record', icon: '+', make: () => ({ type: 'create_record', object: 'deal', values: { name: '{{title}}' } }) },
  { type: 'add_note', label: 'Add a timeline note', icon: 'N', make: () => ({ type: 'add_note', subject: '', body: '' }) },
  { type: 'send_webhook', label: 'Call a webhook', icon: '⇄', make: () => ({ type: 'send_webhook', url: 'https://' }) },
  { type: 'ai_score', label: 'Rescore with AI', icon: 'AI', make: () => ({ type: 'ai_score' }) },
  { type: 'branch', label: 'If / else branch', icon: '⑂', make: () => ({ type: 'branch', label: '', conditions: [{ field: '', op: 'eq', value: '' }], then: [], else: [] }) },
];
const stepMeta = (t: string) => STEP_TYPES.find((s) => s.type === t) ?? { label: t, icon: '•' };

/** First thing that would stop the automation from saving or running, in plain words. */
function problemIn(steps: Step[], where = ''): string | null {
  for (const [i, s] of steps.entries()) {
    const at = `${where}step ${i + 1} (${stepMeta(s.type).label})`;
    const need = (msg: string) => `${at[0]!.toUpperCase()}${at.slice(1)}: ${msg}`;
    switch (s.type) {
      case 'create_task':
        if (!String(s.title ?? '').trim()) return need('give the task a title');
        break;
      case 'update_field':
        if (!s.field) return need('choose the field to update');
        break;
      case 'assign_owner':
        if (!s.userIds?.length) return need('pick at least one person to rotate between');
        break;
      case 'send_email':
        if (!String(s.to ?? '').trim()) return need('choose who receives it');
        if (!String(s.subject ?? '').trim()) return need('add a subject');
        break;
      case 'send_whatsapp':
        if (!String(s.to ?? '').trim()) return need('choose who receives it');
        if (!String(s.body ?? '').trim()) return need('write the message');
        break;
      case 'send_webhook':
        if (!/^https:\/\/.+/.test(String(s.url ?? ''))) return need('enter an https:// address');
        break;
      case 'add_note':
        if (!String(s.subject ?? '').trim()) return need('give the note a title');
        break;
      case 'branch': {
        if ((s.conditions ?? []).some((c: Cond) => c.op !== 'formula' && !c.field)) return need('choose a field for every condition');
        const name = s.label ? `“${s.label}”` : `the branch at step ${i + 1}`;
        const inner = problemIn(s.then ?? [], `${where}the Yes path of ${name}, `) ?? problemIn(s.else ?? [], `${where}the No path of ${name}, `);
        if (inner) return inner;
      }
    }
  }
  return null;
}

function summarise(steps: Step[]): string {
  return steps
    .map((s) => (s.type === 'branch' ? `if (${summarise(s.then) || '—'} / ${summarise(s.else) || '—'})` : stepMeta(s.type).label.toLowerCase()))
    .join(', ');
}

// ------------------------------------------------------------------------------------- list
export function AutomationsTab() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['admin-workflows'], queryFn: () => get<{ items: Json[] }>('/api/admin/workflows') });
  const [editing, setEditing] = useState<Workflow | null>(null);

  const fromRow = (x: Json): Workflow => ({ id: x.id, name: x.name, objectKey: x.object_key, triggerEvent: x.trigger_event, conditions: x.conditions ?? [], actions: x.actions ?? [], isEnabled: x.is_enabled });
  const toggle = async (x: Json) => {
    try {
      await put(`/api/admin/workflows/${x.id}`, { ...fromRow(x), isEnabled: !x.is_enabled, id: undefined });
      qc.invalidateQueries({ queryKey: ['admin-workflows'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  if (editing) return <AutomationEditor initial={editing} onClose={() => setEditing(null)} />;

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          When something happens to a record, Synapse checks your conditions and runs the steps — with if/else branches for different paths.
        </p>
        <button className="btn primary" onClick={() => setEditing({ name: '', objectKey: 'lead', triggerEvent: 'created', conditions: [], actions: [STEP_TYPES[0]!.make()], isEnabled: true })}>
          New automation
        </button>
      </div>
      {data?.items.length ? (
        <div className="auto-list">
          {data.items.map((x) => {
            const obj = meta?.objects.find((o) => o.key === x.object_key);
            return (
              <div key={x.id} className={`auto-card${x.is_enabled ? '' : ' off'}`}>
                <div>
                  <b>{x.name}</b>
                  <div className="muted small">
                    When a {obj?.label.toLowerCase() ?? x.object_key} {TRIGGERS.find(([k]) => k === x.trigger_event)?.[1]}
                    {x.conditions?.length ? ` and ${x.conditions.length} condition${x.conditions.length > 1 ? 's' : ''} match` : ''} → {summarise(x.actions)}
                  </div>
                  <div className="muted small">
                    Ran {x.run_count} time{x.run_count === 1 ? '' : 's'}
                    {x.last_run_at ? ` · last ${relative(x.last_run_at)}` : ''}
                    {x.module_key ? ` · from the ${x.module_key.replace(/_/g, ' ')} module` : ''}
                  </div>
                </div>
                <div className="row">
                  <label className="switch" title={x.is_enabled ? 'On' : 'Off'}>
                    <input type="checkbox" checked={x.is_enabled} onChange={() => toggle(x)} aria-label={`${x.name} enabled`} />
                    <span />
                  </label>
                  <button className="btn sm" onClick={() => setEditing(fromRow(x))}>
                    Edit
                  </button>
                  <button className="btn sm" onClick={() => setEditing({ ...fromRow(x), id: undefined, name: `${x.name} (copy)`, isEnabled: false })}>
                    Duplicate
                  </button>
                  <button
                    className="btn sm danger"
                    onClick={async () => {
                      if (!window.confirm(`Delete “${x.name}”? Its run history is deleted too.`)) return;
                      await del(`/api/admin/workflows/${x.id}`).catch((e) => toast((e as Error).message, true));
                      qc.invalidateQueries({ queryKey: ['admin-workflows'] });
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty title="No automations yet">Start with “when a lead is created from a referral, create a call task for the owner”.</Empty>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------ editor
function AutomationEditor({ initial, onClose }: { initial: Workflow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const [w, setW] = useState<Workflow>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ path: (string | number)[]; index: number } | null>(null);
  const obj = meta?.objects.find((o) => o.key === w.objectKey);

  /** immutable update of the nested steps at `path` (e.g. ['actions', 2, 'then']) */
  const editList = (path: (string | number)[], fn: (list: Step[]) => Step[]) =>
    setW((cur) => {
      const next = structuredClone(cur) as Json;
      let node = next;
      for (const p of path.slice(0, -1)) node = node[p];
      const last = path[path.length - 1]!;
      node[last] = fn(node[last] ?? []);
      return next as Workflow;
    });

  const save = async () => {
    const problem = problemIn(w.actions) ?? (w.conditions.some((c) => c.op !== 'formula' && !c.field && (c.value ?? '') !== '') ? 'Choose a field for every condition' : null);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const body = { name: w.name, objectKey: w.objectKey, triggerEvent: w.triggerEvent, conditions: w.conditions.filter((c) => c.field || c.op === 'formula'), actions: w.actions, isEnabled: w.isEnabled };
    try {
      if (w.id) await put(`/api/admin/workflows/${w.id}`, body);
      else await post('/api/admin/workflows', body);
      toast('Automation saved');
      qc.invalidateQueries({ queryKey: ['admin-workflows'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? (e.details?.[0] ? `${e.details[0].path ?? e.details[0].field ?? ''} ${e.details[0].message}`.trim() : e.message) : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const renderSteps = (steps: Step[], path: (string | number)[], depth: number) => (
    <div className="flow-steps">
      <AddButton onClick={() => setAdding({ path, index: 0 })} />
      {steps.map((s, i) => (
        <Fragment key={i}>
          <StepCard
            step={s}
            obj={obj}
            onChange={(ns) => editList(path, (l) => l.map((x, j) => (j === i ? ns : x)))}
            onRemove={() => editList(path, (l) => l.filter((_, j) => j !== i))}
            onMove={(d) => editList(path, (l) => {
              const j = i + d;
              if (j < 0 || j >= l.length) return l;
              const n = [...l];
              [n[i], n[j]] = [n[j]!, n[i]!];
              return n;
            })}
          >
            {s.type === 'branch' && (
              <div className="flow-branches">
                <div className="lane yes">
                  <div className="lane-head">Yes — conditions match</div>
                  {renderSteps(s.then ?? [], [...path, i, 'then'], depth + 1)}
                </div>
                <div className="lane no">
                  <div className="lane-head">No — otherwise</div>
                  {renderSteps(s.else ?? [], [...path, i, 'else'], depth + 1)}
                </div>
              </div>
            )}
          </StepCard>
          <AddButton onClick={() => setAdding({ path, index: i + 1 })} />
        </Fragment>
      ))}
      {!steps.length && depth > 0 && <div className="muted small lane-empty">Nothing happens on this path</div>}
    </div>
  );

  return (
    <div className="flow-editor">
      <div className="spread flow-top">
        <div className="row" style={{ gap: 10, flex: 1, minWidth: 260 }}>
          <button className="btn ghost sm" onClick={onClose} aria-label="Back to automations">
            ← Back
          </button>
          <input className="flow-name" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} placeholder="Name this automation" aria-label="Automation name" maxLength={120} />
        </div>
        <div className="row">
          <label className="row small">
            <input type="checkbox" checked={w.isEnabled} onChange={(e) => setW({ ...w, isEnabled: e.target.checked })} /> On
          </label>
          <button className="btn primary" onClick={save} disabled={busy || !w.name.trim() || !w.actions.length}>
            {busy ? 'Saving…' : 'Save automation'}
          </button>
        </div>
      </div>
      {error && (
        <div className="field-error" role="alert" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}
      <div className="flow-grid">
        <div className="flow-canvas">
          <div className="flow-card trigger">
            <div className="flow-card-head">
              <span className="flow-icon">⚡</span> Trigger
            </div>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              When a
              <select value={w.objectKey} onChange={(e) => setW({ ...w, objectKey: e.target.value })} style={{ width: 'auto' }} aria-label="Object">
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select value={w.triggerEvent} onChange={(e) => setW({ ...w, triggerEvent: e.target.value as Workflow['triggerEvent'] })} style={{ width: 'auto' }} aria-label="Event">
                {TRIGGERS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flow-line" />
          <div className="flow-card filter">
            <div className="flow-card-head">
              <span className="flow-icon">⧩</span> Only continue if {w.conditions.length ? 'all of these match' : '(optional)'}
            </div>
            {obj && <ConditionsEditor obj={obj} value={w.conditions} onChange={(conditions) => setW({ ...w, conditions })} />}
          </div>
          {renderSteps(w.actions, ['actions'], 0)}
          <div className="flow-end">End</div>
        </div>
        {w.id && <RunHistory id={w.id} />}
      </div>
      {adding && (
        <Modal title="Add a step" onClose={() => setAdding(null)}>
          <div className="modal-body step-picker">
            {STEP_TYPES.filter((t) => t.type !== 'branch' || adding.path.length < 7).map((t) => (
              <button
                key={t.type}
                className="step-option"
                onClick={() => {
                  editList(adding.path, (l) => [...l.slice(0, adding.index), t.make(), ...l.slice(adding.index)]);
                  setAdding(null);
                }}
              >
                <span className="flow-icon">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="flow-add">
      <span className="flow-line" />
      <button className="add-dot" onClick={onClick} aria-label="Add a step here" title="Add a step here">
        +
      </button>
    </div>
  );
}

function ConditionsEditor({ obj, value, onChange }: { obj: ObjectMeta; value: Cond[]; onChange: (c: Cond[]) => void }) {
  const set = (i: number, patch: Partial<Cond>) => onChange(value.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <div className="stack" style={{ gap: 6 }}>
      {value.map((c, i) =>
        c.op === 'formula' ? (
          <div key={i} className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <FormulaInput obj={obj} value={String(c.value ?? '')} onChange={(v) => set(i, { value: v })} kind="condition" rows={1} />
            </div>
            <button className="btn ghost sm" aria-label="Remove condition" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ) : (
          <div key={i} className="filter-row">
            <select aria-label="Field" value={c.field} onChange={(e) => set(i, { field: e.target.value })}>
              <option value="">Choose field…</option>
              {obj.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
            <select aria-label="Condition" value={c.op} onChange={(e) => set(i, { op: e.target.value, ...(e.target.value === 'formula' ? { field: '*', value: '' } : {}) })}>
              {OPS.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
            <ValueInput obj={obj} field={c.field} value={c.value} disabled={NO_VALUE.has(c.op)} onChange={(v) => set(i, { value: v })} />
            <button className="btn ghost sm" aria-label="Remove condition" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ),
      )}
      <div className="row">
        <button className="btn sm" onClick={() => onChange([...value, { field: '', op: 'eq', value: '' }])}>
          Add condition
        </button>
        <button className="btn sm" onClick={() => onChange([...value, { field: '*', op: 'formula', value: '' }])}>
          Add formula condition
        </button>
      </div>
    </div>
  );
}

/** Value box that knows picklists, stages, users and checkboxes. */
function ValueInput({ obj, field, value, onChange, disabled }: { obj: ObjectMeta; field: string; value: unknown; onChange: (v: unknown) => void; disabled?: boolean }) {
  const { data: meta } = useMeta();
  const { data: users } = useUsers();
  const f = obj.fields.find((x) => x.key === field);
  const str = value === null || value === undefined ? '' : String(value);
  if (disabled) return <input disabled aria-label="Value" value="" />;
  if (field === 'stage_id') {
    return (
      <select aria-label="Value" value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose stage…</option>
        {meta?.pipelines
          .filter((p) => p.objectKey === obj.key)
          .map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
    );
  }
  if (f?.type === 'picklist' || f?.type === 'multipicklist') {
    return (
      <select aria-label="Value" value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {f.options?.choices?.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>
    );
  }
  if (f?.type === 'user') {
    return (
      <select aria-label="Value" value={str} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose user…</option>
        {users?.items.map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name}
          </option>
        ))}
      </select>
    );
  }
  if (f?.type === 'boolean') {
    return (
      <select aria-label="Value" value={str} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  return <input aria-label="Value" value={str} onChange={(e) => onChange(e.target.value)} placeholder="value" />;
}

function TemplateField({ obj, value, onChange, multiline, label, placeholder }: { obj?: ObjectMeta; value: string; onChange: (v: string) => void; multiline?: boolean; label: string; placeholder?: string }) {
  return (
    <label className="field">
      <span className="spread">
        {label}
        {obj && (
          <select className="mini" aria-label={`Insert a field into ${label}`} value="" onChange={(e) => e.target.value && onChange(`${value}{{${e.target.value}}}`)}>
            <option value="">+ field</option>
            <option value="title">Record name</option>
            {obj.fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        )}
      </span>
      {multiline ? <textarea rows={3} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} /> : <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}
    </label>
  );
}

function StepCard({ step, obj, onChange, onRemove, onMove, children }: { step: Step; obj?: ObjectMeta; onChange: (s: Step) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; children?: React.ReactNode }) {
  const { data: meta } = useMeta();
  const { data: users } = useUsers();
  const m = stepMeta(step.type);
  const set = (patch: Json) => onChange({ ...step, ...patch });
  const target = meta?.objects.find((o) => o.key === step.object);
  return (
    <div className={`flow-card step ${step.type}`}>
      <div className="flow-card-head spread">
        <span className="row" style={{ gap: 8 }}>
          <span className="flow-icon">{m.icon}</span>
          {step.type === 'branch' ? (
            <input className="flow-inline" value={step.label ?? ''} onChange={(e) => set({ label: e.target.value })} placeholder="If / else — name this decision" aria-label="Branch name" />
          ) : (
            m.label
          )}
        </span>
        <span className="row" style={{ gap: 2 }}>
          <button className="btn ghost sm" onClick={() => onMove(-1)} aria-label="Move step up">
            ↑
          </button>
          <button className="btn ghost sm" onClick={() => onMove(1)} aria-label="Move step down">
            ↓
          </button>
          <button className="btn ghost sm" onClick={onRemove} aria-label="Remove step">
            ✕
          </button>
        </span>
      </div>
      <div className="flow-card-body">
        {step.type === 'branch' && obj && <ConditionsEditor obj={obj} value={step.conditions ?? []} onChange={(conditions) => set({ conditions })} />}
        {step.type === 'create_task' && (
          <div className="grid2">
            <TemplateField obj={obj} label="Task title" value={step.title ?? ''} onChange={(v) => set({ title: v })} />
            <label className="field">
              Assign to
              <select value={step.assignTo ?? 'owner'} onChange={(e) => set({ assignTo: e.target.value })}>
                <option value="owner">Record owner</option>
                <option value="creator">Whoever created the record</option>
                {users?.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Due in (hours)
              <input type="number" min={0} value={step.dueInHours ?? ''} onChange={(e) => set({ dueInHours: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </label>
            <label className="field">
              Priority
              <select value={step.priority ?? 'normal'} onChange={(e) => set({ priority: e.target.value })}>
                {['low', 'normal', 'high', 'urgent'].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {step.type === 'update_field' && obj && (
          <div className="grid2">
            <label className="field">
              Field
              <select value={step.field} onChange={(e) => set({ field: e.target.value, value: '' })}>
                <option value="">Choose…</option>
                {obj.fields
                  .filter((f) => !f.readOnly)
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field">
              New value
              <ValueInput obj={obj} field={step.field} value={step.value} onChange={(v) => set({ value: v })} />
            </label>
          </div>
        )}
        {step.type === 'assign_owner' && (
          <div className="field">
            <span>Rotate between</span>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              {users?.items.map((u) => (
                <label key={u.id} className="row">
                  <input
                    type="checkbox"
                    checked={(step.userIds ?? []).includes(u.id)}
                    onChange={(e) => set({ userIds: e.target.checked ? [...(step.userIds ?? []), u.id] : (step.userIds ?? []).filter((x: string) => x !== u.id) })}
                  />
                  {u.full_name}
                </label>
              ))}
            </div>
          </div>
        )}
        {(step.type === 'send_email' || step.type === 'send_whatsapp') && (
          <div className="grid2">
            <label className="field">
              To
              <select value={String(step.to ?? '').startsWith('field:') ? step.to : '__custom'} onChange={(e) => set({ to: e.target.value === '__custom' ? '' : e.target.value })}>
                {obj?.fields
                  .filter((f) => f.type === (step.type === 'send_email' ? 'email' : 'phone'))
                  .map((f) => (
                    <option key={f.key} value={`field:${f.key}`}>
                      The record’s {f.label.toLowerCase()}
                    </option>
                  ))}
                <option value="__custom">A fixed address…</option>
              </select>
              {!String(step.to ?? '').startsWith('field:') && <input value={step.to ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder={step.type === 'send_email' ? 'sales@company.in' : '+91…'} />}
            </label>
            {step.type === 'send_email' && <TemplateField obj={obj} label="Subject" value={step.subject ?? ''} onChange={(v) => set({ subject: v })} />}
            <div className="wide">
              <TemplateField obj={obj} label="Message" multiline value={step.body ?? ''} onChange={(v) => set({ body: v })} />
            </div>
          </div>
        )}
        {step.type === 'add_note' && (
          <div className="grid2">
            <TemplateField obj={obj} label="Title" value={step.subject ?? ''} onChange={(v) => set({ subject: v })} />
            <TemplateField obj={obj} label="Text" value={step.body ?? ''} onChange={(v) => set({ body: v })} />
          </div>
        )}
        {step.type === 'send_webhook' && (
          <div className="grid2">
            <label className="field">
              HTTPS URL
              <input value={step.url ?? ''} onChange={(e) => set({ url: e.target.value })} />
            </label>
            <label className="field">
              Signing secret (optional)
              <input value={step.secret ?? ''} onChange={(e) => set({ secret: e.target.value || undefined })} />
            </label>
          </div>
        )}
        {step.type === 'create_record' && (
          <div className="stack" style={{ gap: 6 }}>
            <label className="field">
              Object
              <select value={step.object} onChange={(e) => set({ object: e.target.value, values: {} })}>
                {meta?.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {Object.entries((step.values ?? {}) as Record<string, unknown>).map(([k, v]) => (
              <div key={k} className="filter-row" style={{ gridTemplateColumns: 'minmax(120px,1fr) 2fr auto' }}>
                <span className="small">{target?.fields.find((f) => f.key === k)?.label ?? k}</span>
                <input value={String(v ?? '')} onChange={(e) => set({ values: { ...step.values, [k]: e.target.value } })} aria-label={`Value for ${k}`} placeholder="text or {{field}}" />
                <button
                  className="btn ghost sm"
                  aria-label={`Remove ${k}`}
                  onClick={() => {
                    const n = { ...step.values };
                    delete n[k];
                    set({ values: n });
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            {target && (
              <select
                aria-label="Set another field"
                value=""
                onChange={(e) => e.target.value && set({ values: { ...step.values, [e.target.value]: e.target.value.endsWith('_id') && target.fields.find((f) => f.key === e.target.value)?.options?.lookupObject === obj?.key ? '{{id}}' : '' } })}
              >
                <option value="">Set a field…</option>
                {target.fields
                  .filter((f) => !f.readOnly && !(f.key in (step.values ?? {})))
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
              </select>
            )}
            <span className="muted small">Use {'{{id}}'} in a link field to connect the new record to this one.</span>
          </div>
        )}
        {step.type === 'ai_score' && <span className="muted small">Re-scores the lead with your AI model (leads only).</span>}
        {children}
      </div>
    </div>
  );
}

function RunHistory({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: ['wf-runs', id], queryFn: () => get<{ items: Json[] }>(`/api/admin/workflows/${id}/runs`) });
  return (
    <aside className="flow-runs">
      <h3>Recent runs</h3>
      {!data?.items.length && <p className="muted small">No runs yet.</p>}
      {data?.items.slice(0, 25).map((r) => (
        <div key={r.id} className={`run ${r.status}`}>
          <div className="spread">
            <b className="small">{r.status === 'success' ? 'Succeeded' : 'Failed'}</b>
            <span className="muted small" title={dateTime(r.started_at)}>
              {relative(r.started_at)}
            </span>
          </div>
          {r.error && <div className="field-error small">{r.error}</div>}
          {Array.isArray(r.output) && (
            <ol className="small run-steps">
              {r.output.map((o: Json, i: number) => (
                <li key={i}>
                  {o.branch ? `${o.branch} → ${o.result === 'then' ? 'Yes' : 'No'}` : `${o.type ? stepMeta(o.type).label : 'Step'}${o.skipped ? ` (skipped: ${o.skipped})` : ''}`}
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </aside>
  );
}
