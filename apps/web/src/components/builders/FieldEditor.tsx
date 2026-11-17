import { type FieldDef, type FieldOptions, type FieldType, isComputed, type ObjectMeta, type PicklistChoice, RETURN_TYPES, ROLLUP_AGGREGATES, type RollupSpec, valueType } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, put } from '../../lib/api';
import { useMeta } from '../../lib/hooks';
import { Modal, useToast } from '../ui';
import { FormulaInput } from './FormulaInput';

type Json = Record<string, any>;

export const TYPE_LABELS: Record<FieldType, string> = {
  text: 'Text',
  textarea: 'Long text',
  number: 'Number',
  currency: 'Currency (₹)',
  percent: 'Percent',
  date: 'Date',
  datetime: 'Date & time',
  boolean: 'Checkbox',
  picklist: 'Picklist',
  multipicklist: 'Multi-select picklist',
  email: 'Email',
  phone: 'Phone',
  url: 'Website / URL',
  lookup: 'Link to another record',
  user: 'User',
  formula: 'Formula (calculated)',
  rollup: 'Roll-up summary',
};

const TYPE_GROUPS: [string, FieldType[]][] = [
  ['Basic', ['text', 'textarea', 'number', 'currency', 'percent', 'date', 'datetime', 'boolean']],
  ['Choices', ['picklist', 'multipicklist']],
  ['Contact', ['email', 'phone', 'url']],
  ['Relationships', ['lookup', 'user']],
  ['Calculated', ['formula', 'rollup']],
];

const AGG_LABELS: Record<string, string> = { count: 'Count of records', sum: 'Sum of', avg: 'Average of', min: 'Smallest', max: 'Largest' };

const keyFrom = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f_$1')
    .slice(0, 40);

function choicesToText(c: PicklistChoice[] | undefined) {
  return (c ?? []).map((x) => (keyFrom(x.label) === x.value ? x.label : `${x.label} = ${x.value}`)).join('\n');
}
function textToChoices(t: string): PicklistChoice[] {
  const seen = new Set<string>();
  const lines = t.includes('\n') || t.includes('=') ? t.split('\n') : t.split(',');
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, value] = line.split('=').map((x) => x.trim());
      return { label: label!, value: value || keyFrom(label!) || label! };
    })
    .filter((c) => (seen.has(c.value) ? false : (seen.add(c.value), true)));
}

/** Create or edit a field, including formulas, roll-ups and field dependencies. */
export function FieldEditor({ obj, field, onClose }: { obj: ObjectMeta; field?: FieldDef; onClose: () => void }) {
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const editing = !!field;
  const o: FieldOptions = field?.options ?? {};
  const [label, setLabel] = useState(field?.label ?? '');
  const [key, setKey] = useState(field?.key ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [helpText, setHelpText] = useState(field?.helpText ?? '');
  const [required, setRequired] = useState(!!field?.required);
  const [indexed, setIndexed] = useState(!!field?.indexed);
  const [pii, setPii] = useState(!!field?.pii);
  const [choicesText, setChoicesText] = useState(choicesToText(o.choices));
  const [addable, setAddable] = useState(o.addable !== false);
  const [lookupObject, setLookupObject] = useState(o.lookupObject ?? 'account');
  const [min, setMin] = useState(o.min?.toString() ?? '');
  const [max, setMax] = useState(o.max?.toString() ?? '');
  const [precision, setPrecision] = useState(o.precision?.toString() ?? '');
  const [maxLength, setMaxLength] = useState(o.maxLength?.toString() ?? '');
  const [expression, setExpression] = useState(o.expression ?? '');
  const [returnType, setReturnType] = useState(o.returnType ?? 'number');
  const [rollup, setRollup] = useState<RollupSpec>(o.rollup ?? { object: '', via: '', aggregate: 'count' });
  const [visibleWhen, setVisibleWhen] = useState(o.visibleWhen ?? '');
  const [requiredWhen, setRequiredWhen] = useState(o.requiredWhen ?? '');
  const [controlling, setControlling] = useState(o.controlling ?? null);
  const [showRules, setShowRules] = useState(!!(o.visibleWhen || o.requiredWhen || o.controlling));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = textToChoices(choicesText);
  const isPick = type === 'picklist' || type === 'multipicklist';
  const computed = isComputed({ type });
  // children that can be rolled up: objects with a lookup pointing at this object
  const childOptions = (meta?.objects ?? []).flatMap((c) => c.fields.filter((f) => f.type === 'lookup' && f.options?.lookupObject === obj.key).map((f) => ({ obj: c, via: f })));
  const child = meta?.objects.find((c) => c.key === rollup.object);
  const controllers = obj.fields.filter((f) => (f.type === 'picklist' || f.type === 'boolean') && f.key !== key);
  const ctlField = controllers.find((f) => f.key === controlling?.field);
  const ctlValues: PicklistChoice[] = ctlField?.type === 'boolean' ? [{ value: 'true', label: 'Checked' }, { value: 'false', label: 'Unchecked' }] : (ctlField?.options?.choices ?? []);

  const save = async () => {
    setBusy(true);
    setError(null);
    const options: Json = {};
    if (isPick) {
      options.choices = choices;
      options.addable = addable;
    }
    if (type === 'lookup') options.lookupObject = lookupObject;
    if (['number', 'currency', 'percent'].includes(type)) {
      if (min !== '') options.min = Number(min);
      if (max !== '') options.max = Number(max);
    }
    if (['number', 'currency', 'percent', 'formula', 'rollup'].includes(type) && precision !== '') options.precision = Number(precision);
    if (type === 'text' && maxLength) options.maxLength = Number(maxLength);
    if (type === 'formula') {
      options.expression = expression;
      options.returnType = returnType;
    }
    if (type === 'rollup') options.rollup = { ...rollup, field: rollup.aggregate === 'count' ? undefined : rollup.field, filters: rollup.filters?.filter((f) => f.field) };
    if (!computed) {
      if (visibleWhen.trim()) options.visibleWhen = visibleWhen.trim();
      if (requiredWhen.trim()) options.requiredWhen = requiredWhen.trim();
      if (isPick && controlling?.field) options.controlling = controlling;
    }
    // keep options this editor does not manage (e.g. defaults set by modules)
    const merged = { ...Object.fromEntries(Object.entries(o).filter(([k]) => !['choices', 'addable', 'lookupObject', 'min', 'max', 'precision', 'maxLength', 'expression', 'returnType', 'rollup', 'visibleWhen', 'requiredWhen', 'controlling'].includes(k))), ...options };
    try {
      await put(`/api/admin/objects/${obj.key}/fields/${key}`, { label, type, required: computed ? false : required, indexed, pii, helpText: helpText || null, position: field?.position, options: merged });
      toast(editing ? 'Field saved' : 'Field added');
      await qc.invalidateQueries({ queryKey: ['meta'] });
      if (computed) toast('Existing records are being recalculated');
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save the field');
    } finally {
      setBusy(false);
    }
  };

  const invalid = !label.trim() || !/^[a-z][a-z0-9_]{1,40}$/.test(key) || (isPick && !choices.length) || (type === 'formula' && !expression.trim()) || (type === 'rollup' && (!rollup.object || !rollup.via || (rollup.aggregate !== 'count' && !rollup.field)));

  return (
    <Modal
      title={editing ? `Edit “${field!.label}”` : `New ${obj.label.toLowerCase()} field`}
      wide
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="field-error" style={{ marginRight: 'auto' }} role="alert">
              {error}
            </span>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || invalid}>
            {busy ? 'Saving…' : editing ? 'Save field' : 'Add field'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Label
          <input value={label} onChange={(e) => {
            setLabel(e.target.value);
            if (!editing && (!key || key === keyFrom(label))) setKey(keyFrom(e.target.value));
          }} autoFocus />
        </label>
        <label className="field">
          API name
          <input value={key} onChange={(e) => setKey(e.target.value)} disabled={editing} className="mono" />
        </label>
        <label className="field">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as FieldType)} disabled={editing}>
            {TYPE_GROUPS.map(([g, types]) => (
              <optgroup key={g} label={g}>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          Help text
          <input value={helpText} onChange={(e) => setHelpText(e.target.value)} placeholder="Shown under the field" maxLength={300} />
        </label>

        {type === 'lookup' && (
          <label className="field">
            Links to
            <select value={lookupObject} onChange={(e) => setLookupObject(e.target.value)} disabled={editing}>
              {meta?.objects.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {isPick && (
          <label className="field wide">
            Choices — one per line (write “Label = value” to set the stored value)
            <textarea rows={4} value={choicesText} onChange={(e) => setChoicesText(e.target.value)} placeholder={'Hot\nWarm\nCold'} />
            <span className="muted small">{choices.length} choice{choices.length === 1 ? '' : 's'}{editing ? '. Changing a stored value does not update existing records.' : ''}</span>
          </label>
        )}
        {isPick && (
          <label className="row wide" style={{ gap: 8 }}>
            <input type="checkbox" checked={addable} onChange={(e) => setAddable(e.target.checked)} />
            People can pick “Other…” and type a new value, which is added to these choices for everyone
          </label>
        )}
        {['number', 'currency', 'percent'].includes(type) && (
          <>
            <label className="field">
              Minimum
              <input type="number" value={min} onChange={(e) => setMin(e.target.value)} />
            </label>
            <label className="field">
              Maximum
              <input type="number" value={max} onChange={(e) => setMax(e.target.value)} />
            </label>
          </>
        )}
        {type === 'text' && (
          <label className="field">
            Maximum length
            <input type="number" min={1} max={100000} value={maxLength} onChange={(e) => setMaxLength(e.target.value)} placeholder="255" />
          </label>
        )}

        {type === 'formula' && (
          <>
            <label className="field">
              Result type
              <select value={returnType} onChange={(e) => setReturnType(e.target.value as typeof returnType)}>
                {RETURN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABELS[t as FieldType] ?? t}
                  </option>
                ))}
              </select>
            </label>
            {['number', 'currency', 'percent'].includes(returnType) && (
              <label className="field">
                Decimal places
                <input type="number" min={0} max={6} value={precision} onChange={(e) => setPrecision(e.target.value)} placeholder="2" />
              </label>
            )}
            <div className="field wide">
              <span>Formula</span>
              <FormulaInput obj={obj} value={expression} onChange={setExpression} exclude={key} rows={4} />
              <span className="muted small">Use field API names, operators (+ − * / &amp; = != &lt; &gt; &amp;&amp; ||) and functions. Text goes in "quotes". Recalculated on every save.</span>
            </div>
          </>
        )}

        {type === 'rollup' && (
          <>
            <label className="field">
              Summarise
              <select
                value={rollup.object && rollup.via ? `${rollup.object}.${rollup.via}` : ''}
                onChange={(e) => {
                  const [object, via] = e.target.value.split('.');
                  setRollup({ object: object ?? '', via: via ?? '', aggregate: rollup.aggregate });
                }}
                disabled={editing}
              >
                <option value="">Choose related records…</option>
                {childOptions.map((c) => (
                  <option key={`${c.obj.key}.${c.via.key}`} value={`${c.obj.key}.${c.via.key}`}>
                    {c.obj.plural} (by {c.via.label})
                  </option>
                ))}
              </select>
              {!childOptions.length && <span className="muted small">No object links to {obj.plural.toLowerCase()} yet. Add a “Link to another record” field on the child object first.</span>}
            </label>
            <label className="field">
              Calculation
              <select value={rollup.aggregate} onChange={(e) => setRollup((r) => ({ ...r, aggregate: e.target.value as RollupSpec['aggregate'] }))}>
                {ROLLUP_AGGREGATES.map((a) => (
                  <option key={a} value={a}>
                    {AGG_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
            {rollup.aggregate !== 'count' && child && (
              <label className="field">
                Field
                <select value={rollup.field ?? ''} onChange={(e) => setRollup((r) => ({ ...r, field: e.target.value }))}>
                  <option value="">Choose…</option>
                  {child.fields
                    .filter((f) => ['number', 'currency', 'percent'].includes(valueType(f)) || (['min', 'max'].includes(rollup.aggregate) && ['date', 'datetime'].includes(valueType(f))))
                    .map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {child && (
              <div className="field wide">
                <span>Only include {child.plural.toLowerCase()} where (optional)</span>
                {(rollup.filters ?? []).map((flt, i) => (
                  <div key={i} className="filter-row">
                    <select aria-label="Field" value={flt.field} onChange={(e) => setRollup((r) => ({ ...r, filters: r.filters!.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)) }))}>
                      {child.fields.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <select aria-label="Condition" value={flt.op} onChange={(e) => setRollup((r) => ({ ...r, filters: r.filters!.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) }))}>
                      {[['eq', 'is'], ['neq', 'is not'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['contains', 'contains'], ['not_null', 'is not empty'], ['is_null', 'is empty']].map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <input aria-label="Value" value={String(flt.value ?? '')} disabled={flt.op === 'is_null' || flt.op === 'not_null'} onChange={(e) => setRollup((r) => ({ ...r, filters: r.filters!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) }))} />
                    <button className="btn ghost sm" aria-label="Remove condition" onClick={() => setRollup((r) => ({ ...r, filters: r.filters!.filter((_, j) => j !== i) }))}>
                      ✕
                    </button>
                  </div>
                ))}
                <button className="btn sm" style={{ justifySelf: 'start' }} onClick={() => setRollup((r) => ({ ...r, filters: [...(r.filters ?? []), { field: child.fields[0]?.key ?? '', op: 'eq', value: '' }] }))}>
                  Add condition
                </button>
              </div>
            )}
          </>
        )}

        <div className="wide row" style={{ flexWrap: 'wrap', gap: 18 }}>
          {!computed && (
            <label className="row">
              <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Always required
            </label>
          )}
          <label className="row">
            <input type="checkbox" checked={indexed} onChange={(e) => setIndexed(e.target.checked)} /> Filterable &amp; sortable (indexed)
          </label>
          {!computed && (
            <label className="row">
              <input type="checkbox" checked={pii} onChange={(e) => setPii(e.target.checked)} /> Personal data
            </label>
          )}
        </div>

        {!computed && (
          <div className="wide">
            <button className="link" style={{ padding: 0 }} onClick={() => setShowRules((x) => !x)} aria-expanded={showRules}>
              {showRules ? '▾' : '▸'} Conditional behaviour {visibleWhen || requiredWhen || controlling ? '(set)' : ''}
            </button>
          </div>
        )}
        {!computed && showRules && (
          <>
            <div className="field wide">
              <span>Show this field only when</span>
              <FormulaInput obj={obj} value={visibleWhen} onChange={setVisibleWhen} kind="condition" rows={1} exclude={key} placeholder='e.g. source = "referral"   (leave empty to always show)' />
            </div>
            {!required && (
              <div className="field wide">
                <span>Require this field when</span>
                <FormulaInput obj={obj} value={requiredWhen} onChange={setRequiredWhen} kind="condition" rows={1} exclude={key} placeholder="e.g. stage_category = &quot;won&quot;" />
              </div>
            )}
            {isPick && (
              <div className="field wide">
                <span>Dependent picklist — limit choices by</span>
                <select value={controlling?.field ?? ''} onChange={(e) => setControlling(e.target.value ? { field: e.target.value, map: {} } : null)}>
                  <option value="">No controlling field</option>
                  {controllers.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {controlling && ctlValues.length > 0 && choices.length > 0 && (
                  <div className="table-wrap" style={{ maxHeight: 280 }}>
                    <table className="data dep-matrix">
                      <thead>
                        <tr>
                          <th>When {ctlField?.label} is…</th>
                          {choices.map((c) => (
                            <th key={c.value}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ctlValues.map((cv) => (
                          <tr key={cv.value}>
                            <td>
                              <b>{cv.label}</b>
                            </td>
                            {choices.map((c) => {
                              const on = (controlling.map[cv.value] ?? []).includes(c.value);
                              return (
                                <td key={c.value}>
                                  <input
                                    type="checkbox"
                                    aria-label={`Allow ${c.label} when ${cv.label}`}
                                    checked={on}
                                    onChange={(e) =>
                                      setControlling((ctl) => {
                                        const cur = new Set(ctl!.map[cv.value] ?? []);
                                        if (e.target.checked) cur.add(c.value);
                                        else cur.delete(c.value);
                                        return { ...ctl!, map: { ...ctl!.map, [cv.value]: [...cur] } };
                                      })
                                    }
                                  />
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
