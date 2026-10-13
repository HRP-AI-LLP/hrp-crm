import { checkFormula, evalCondition, evalFormula, FORMULA_FUNCTIONS, type ObjectMeta, type RecordDto, type TenantMeta } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';
import { get } from '../../lib/api';
import { useMeta } from '../../lib/hooks';

export const EXTRA_FORMULA_FIELDS: [string, string][] = [
  ['stage', 'Stage name'],
  ['stage_category', 'Stage category (open/won/lost)'],
  ['title', 'Record name'],
  ['created_at', 'Created at'],
  ['updated_at', 'Updated at'],
  ['id', 'Record id'],
];

export function formulaNames(obj: ObjectMeta) {
  return [...obj.fields.map((f) => f.key), ...EXTRA_FORMULA_FIELDS.map(([k]) => k)];
}

function sampleValues(meta: TenantMeta | undefined, rec: RecordDto | undefined): Record<string, unknown> {
  if (!rec) return {};
  const v: Record<string, unknown> = { ...rec };
  for (const p of meta?.pipelines ?? []) {
    const s = p.stages.find((x) => x.id === rec.stage_id);
    if (s) {
      v.stage = s.label;
      v.stage_category = s.category;
    }
  }
  return v;
}

/**
 * Formula editor: monospace input with field + function pickers that insert at the cursor,
 * live syntax checking, and a preview evaluated against a real record of the object.
 */
export function FormulaInput({
  obj,
  value,
  onChange,
  placeholder,
  kind = 'value',
  rows = 3,
  exclude,
  id,
}: {
  obj: ObjectMeta;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 'condition' previews true/false */
  kind?: 'value' | 'condition';
  rows?: number;
  exclude?: string;
  id?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const { data: meta } = useMeta();
  const sample = useQuery({
    queryKey: ['formula-sample', obj.key],
    queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/${obj.key}?limit=1`),
    staleTime: 60_000,
  });
  const rec = sample.data?.items[0];
  const names = formulaNames(obj).filter((k) => k !== exclude);
  const error = value.trim() ? checkFormula(value, names) : null;
  const env = { get: (k: string) => sampleValues(meta, rec)[k] as never };
  const preview = !error && value.trim() && rec ? (kind === 'condition' ? evalCondition(value, env) : evalFormula(value, env)) : undefined;

  const insert = (text: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + (text.endsWith('()') ? text.length - 1 : text.length);
      el?.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="formula">
      <textarea
        id={id}
        ref={ref}
        rows={rows}
        spellCheck={false}
        className="mono"
        value={value}
        placeholder={placeholder ?? (kind === 'condition' ? 'e.g. amount > 100000 && ISBLANK(close_date)' : 'e.g. ROUND(amount * probability / 100, 0)')}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
      />
      <div className="formula-bar">
        <select aria-label="Insert field" value="" onChange={(e) => e.target.value && insert(e.target.value)}>
          <option value="">Insert field…</option>
          {obj.fields
            .filter((f) => f.key !== exclude)
            .map((f) => (
              <option key={f.key} value={f.key}>
                {f.label} ({f.key})
              </option>
            ))}
          {EXTRA_FORMULA_FIELDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l} ({k})
            </option>
          ))}
        </select>
        <select aria-label="Insert function" value="" onChange={(e) => e.target.value && insert(`${e.target.value}()`)}>
          <option value="">Insert function…</option>
          {FORMULA_FUNCTIONS.map((f) => (
            <option key={f.name} value={f.name} title={f.doc}>
              {f.doc}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {value.trim() &&
          (error ? (
            <span className="field-error small" role="alert">
              {error}
            </span>
          ) : (
            <span className="small formula-ok">
              ✓ Valid
              {rec && (
                <>
                  {' '}
                  · on “{rec.title || 'first record'}”:{' '}
                  <b>{kind === 'condition' ? (preview ? 'true' : 'false') : preview === null || preview === undefined || preview === '' ? 'blank' : Array.isArray(preview) ? preview.join(', ') : String(preview)}</b>
                </>
              )}
            </span>
          ))}
      </div>
    </div>
  );
}
