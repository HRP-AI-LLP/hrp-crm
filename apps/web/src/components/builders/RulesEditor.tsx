import type { ObjectMeta, ValidationRule } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, del, post, put } from '../../lib/api';
import { Empty, Modal, useToast } from '../ui';
import { FormulaInput } from './FormulaInput';

const EXAMPLES: [string, string, string][] = [
  ['Won deals need an amount', 'stage_category = "won" && BLANKVALUE(amount, 0) <= 0', 'Enter the amount before marking the deal won'],
  ['Close date cannot be in the past', 'NOT ISBLANK(close_date) && close_date < TODAY() && stage_category = "open"', 'Move the close date to today or later'],
  ['Indian mobile numbers', 'NOT ISBLANK(phone) && NOT REGEX(SUBSTITUTE(SUBSTITUTE(phone, " ", ""), "+91", ""), "[6-9][0-9]{9}")', 'Enter a 10-digit Indian mobile number'],
  ['Email locked once set', 'ISCHANGED(email) && NOT ISBLANK(PRIORVALUE(email))', 'The email cannot be changed after it is set'],
];

/** Validation rules: a save is blocked whenever the rule's condition is TRUE. */
export function RulesEditor({ obj }: { obj: ObjectMeta }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<ValidationRule | 'new' | null>(null);
  const rules = obj.validationRules ?? [];
  const label = (k: string | null) => (k ? (obj.fields.find((f) => f.key === k)?.label ?? k) : 'Top of the form');

  const toggle = async (r: ValidationRule) => {
    try {
      await put(`/api/admin/objects/${obj.key}/validation-rules/${r.id}`, { ...r, active: !r.active });
      qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <p className="muted small" style={{ margin: 0 }}>
          A rule blocks a save when its condition is <b>true</b>, and shows your message. Rules run on every create, edit, import and bulk update by people; automations skip them.
        </p>
        <button className="btn primary" onClick={() => setEditing('new')}>
          New rule
        </button>
      </div>
      {rules.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Rule</th>
                <th>Blocks the save when</th>
                <th>Message shown at</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.name}</b>
                    <div className="muted small">{r.message}</div>
                  </td>
                  <td>
                    <code className="mono small">{r.condition}</code>
                  </td>
                  <td>{label(r.field)}</td>
                  <td>
                    <input type="checkbox" checked={r.active} onChange={() => toggle(r)} aria-label={`${r.name} active`} />
                  </td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => setEditing(r)}>
                      Edit
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={async () => {
                        if (!window.confirm(`Delete the rule “${r.name}”?`)) return;
                        await del(`/api/admin/objects/${obj.key}/validation-rules/${r.id}`).catch((e) => toast((e as Error).message, true));
                        qc.invalidateQueries({ queryKey: ['meta'] });
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No validation rules yet">Keep data clean: for example, require an amount before a deal is marked won.</Empty>
      )}
      {editing && <RuleModal obj={obj} rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function RuleModal({ obj, rule, onClose }: { obj: ObjectMeta; rule: ValidationRule | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(rule?.name ?? '');
  const [condition, setCondition] = useState(rule?.condition ?? '');
  const [message, setMessage] = useState(rule?.message ?? '');
  const [field, setField] = useState(rule?.field ?? '');
  const [active, setActive] = useState(rule?.active ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { name, condition, message, field: field || null, active };
    try {
      if (rule) await put(`/api/admin/objects/${obj.key}/validation-rules/${rule.id}`, body);
      else await post(`/api/admin/objects/${obj.key}/validation-rules`, body);
      toast('Rule saved');
      await qc.invalidateQueries({ queryKey: ['meta'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the rule');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={rule ? 'Edit validation rule' : 'New validation rule'}
      wide
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="field-error" style={{ marginRight: 'auto' }}>
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !name.trim() || !condition.trim() || !message.trim()}>
            Save rule
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Rule name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="row" style={{ alignSelf: 'end', height: 34 }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
        <div className="field wide">
          <span>Block the save when this is true</span>
          <FormulaInput obj={obj} value={condition} onChange={setCondition} kind="condition" rows={3} />
          {!rule && !condition && (
            <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
              <span className="muted">Start from an example:</span>
              {EXAMPLES.filter(([, c]) => c.match(/[a-z_]+/g)!.some((w) => obj.fields.some((f) => f.key === w))).map(([n, c, m]) => (
                <button
                  key={n}
                  className="btn sm"
                  onClick={() => {
                    setName(n);
                    setCondition(c);
                    setMessage(m);
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="field wide">
          Message
          <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={300} placeholder="Tell people how to fix it" />
        </label>
        <label className="field">
          Show the message at
          <select value={field} onChange={(e) => setField(e.target.value)}>
            <option value="">Top of the form</option>
            {obj.fields
              .filter((f) => !f.readOnly)
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}
