import type { FieldDef, ObjectMeta } from '@synapse/shared';
import { useState } from 'react';
import { ApiError, post } from '../lib/api';
import { downloadText, parseCsv, toCsv } from '../lib/csv';
import { FieldInput } from './fields';
import { Modal, useToast } from './ui';

export interface Filter {
  field: string;
  op: string;
  value?: unknown;
}

const OPS_BY_TYPE: Record<string, [string, string][]> = {
  text: [['contains', 'contains'], ['eq', 'is'], ['neq', 'is not'], ['starts_with', 'starts with'], ['is_null', 'is empty'], ['not_null', 'is not empty']],
  number: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['is_null', 'is empty'], ['not_null', 'is not empty']],
  date: [['eq', 'on'], ['gt', 'after'], ['lt', 'before'], ['gte', 'on or after'], ['lte', 'on or before'], ['is_null', 'is empty'], ['not_null', 'is not empty']],
  choice: [['eq', 'is'], ['neq', 'is not'], ['is_null', 'is empty'], ['not_null', 'is not empty']],
  multi: [['contains', 'includes'], ['is_null', 'is empty'], ['not_null', 'is not empty']],
  bool: [['eq', 'is']],
};

export function opsFor(f: FieldDef): [string, string][] {
  switch (f.type) {
    case 'number':
    case 'currency':
    case 'percent':
      return OPS_BY_TYPE.number!;
    case 'date':
    case 'datetime':
      return OPS_BY_TYPE.date!;
    case 'picklist':
    case 'lookup':
    case 'user':
      return OPS_BY_TYPE.choice!;
    case 'multipicklist':
      return OPS_BY_TYPE.multi!;
    case 'boolean':
      return OPS_BY_TYPE.bool!;
    default:
      return OPS_BY_TYPE.text!;
  }
}

export function describeFilter(obj: ObjectMeta, f: Filter): string {
  const def = obj.fields.find((x) => x.key === f.field);
  const op = def ? opsFor(def).find(([k]) => k === f.op)?.[1] ?? f.op : f.op;
  if (f.op === 'is_null' || f.op === 'not_null') return `${def?.label ?? f.field} ${op}`;
  let v = f.value === '$me' ? 'me' : f.value;
  if (def?.type === 'picklist') v = def.options?.choices?.find((c) => c.value === v)?.label ?? v;
  if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
  return `${def?.label ?? f.field} ${op} ${String(v ?? '')}`;
}

/** Field / operator / value rows. Value inputs reuse the record field editors. */
export function FilterBuilder({ obj, value, onChange, onClose }: { obj: ObjectMeta; value: Filter[]; onChange: (f: Filter[]) => void; onClose: () => void }) {
  const [rows, setRows] = useState<Filter[]>(value.length ? value : [{ field: obj.fields[0]?.key ?? '', op: 'contains', value: '' }]);
  const fields = obj.fields.filter((f) => f.type !== 'textarea');
  const set = (i: number, patch: Partial<Filter>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Modal
      title="Filter records"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={() => onChange([])}>
            Clear all
          </button>
          <button className="btn primary" onClick={() => onChange(rows.filter((r) => r.field && (r.op === 'is_null' || r.op === 'not_null' || (r.value !== '' && r.value !== null && r.value !== undefined))))}>
            Apply filters
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ display: 'block' }}>
        <p className="muted small" style={{ marginTop: 0 }}>
          Records must match every condition.
        </p>
        <div className="stack" style={{ gap: 8 }}>
          {rows.map((r, i) => {
            const def = fields.find((f) => f.key === r.field);
            const needsValue = r.op !== 'is_null' && r.op !== 'not_null';
            return (
              <div key={i} className="filter-row">
                <select
                  aria-label="Field"
                  value={r.field}
                  onChange={(e) => {
                    const nd = fields.find((f) => f.key === e.target.value);
                    set(i, { field: e.target.value, op: nd ? opsFor(nd)[0]![0] : 'eq', value: nd?.type === 'boolean' ? true : '' });
                  }}
                >
                  {fields.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select aria-label="Condition" value={r.op} onChange={(e) => set(i, { op: e.target.value })}>
                  {(def ? opsFor(def) : OPS_BY_TYPE.text!).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <div>
                  {needsValue && def ? (
                    def.type === 'user' ? (
                      <div className="row">
                        <FieldInput field={def} objectKey={obj.key} value={r.value === '$me' ? '' : r.value} onChange={(v) => set(i, { value: v })} />
                        <button className={`btn sm${r.value === '$me' ? ' primary' : ''}`} onClick={() => set(i, { value: '$me' })}>
                          Me
                        </button>
                      </div>
                    ) : (
                      <FieldInput field={{ ...def, type: def.type === 'multipicklist' ? 'picklist' : def.type === 'textarea' ? 'text' : def.type }} objectKey={obj.key} value={r.value} onChange={(v) => set(i, { value: v })} />
                    )
                  ) : (
                    <span className="muted small">—</span>
                  )}
                </div>
                <button className="btn ghost sm" aria-label="Remove condition" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setRows((r) => [...r, { field: fields[0]?.key ?? '', op: fields[0] ? opsFor(fields[0])[0]![0] : 'eq', value: '' }])}>
          Add condition
        </button>
      </div>
    </Modal>
  );
}

export function ColumnPicker({ obj, value, onChange, onClose }: { obj: ObjectMeta; value: string[]; onChange: (cols: string[]) => void; onClose: () => void }) {
  const [cols, setCols] = useState<string[]>(value);
  const move = (k: string, d: -1 | 1) =>
    setCols((c) => {
      const i = c.indexOf(k);
      const j = i + d;
      if (i < 0 || j < 0 || j >= c.length) return c;
      const n = [...c];
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });
  return (
    <Modal title="Choose columns" onClose={onClose} footer={<button className="btn primary" onClick={() => onChange(cols)}>Show columns</button>}>
      <div className="modal-body" style={{ display: 'block' }}>
        <div className="stack" style={{ gap: 4 }}>
          {[...cols.map((k) => obj.fields.find((f) => f.key === k)!).filter(Boolean), ...obj.fields.filter((f) => !cols.includes(f.key) && f.key !== 'full_name')].map((f) => {
            const on = cols.includes(f.key);
            return (
              <div key={f.key} className="spread" style={{ padding: '4px 0' }}>
                <label className="row">
                  <input type="checkbox" checked={on} onChange={(e) => setCols((c) => (e.target.checked ? [...c, f.key] : c.filter((x) => x !== f.key)))} />
                  {f.label}
                </label>
                {on && (
                  <span className="row" style={{ gap: 2 }}>
                    <button className="btn ghost sm" aria-label={`Move ${f.label} up`} onClick={() => move(f.key, -1)}>
                      ↑
                    </button>
                    <button className="btn ghost sm" aria-label={`Move ${f.label} down`} onClick={() => move(f.key, 1)}>
                      ↓
                    </button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

export function BulkEditModal({ obj, count, onApply, onClose }: { obj: ObjectMeta; count: number; onApply: (patch: Record<string, unknown>) => Promise<void>; onClose: () => void }) {
  const editable = obj.fields.filter((f) => !f.readOnly && f.key !== 'pipeline_id');
  const [field, setField] = useState(editable[0]?.key ?? '');
  const [value, setValue] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const def = editable.find((f) => f.key === field);
  return (
    <Modal
      title={`Edit ${count} ${count === 1 ? obj.label.toLowerCase() : obj.plural.toLowerCase()}`}
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !def}
          onClick={async () => {
            setBusy(true);
            await onApply({ [field]: value === '' ? null : value });
            setBusy(false);
          }}
        >
          {busy ? 'Updating…' : `Update ${count}`}
        </button>
      }
    >
      <div className="modal-body">
        <label className="field">
          Field
          <select
            value={field}
            onChange={(e) => {
              setField(e.target.value);
              setValue(null);
            }}
          >
            {editable.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          New value
          {def && <FieldInput field={def} objectKey={obj.key} value={value} onChange={setValue} />}
        </label>
        <p className="muted small wide">Leave the value empty to clear the field. Records you are not allowed to edit are skipped and listed afterwards.</p>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------- import
const BATCH = 50;

function guessField(header: string, fields: FieldDef[]): string {
  const h = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const aliases: Record<string, string> = { 'e mail': 'email', mail: 'email', mobile: 'phone', 'phone number': 'phone', 'mobile number': 'phone', 'contact number': 'phone', 'company name': 'company', organisation: 'company', organization: 'company', 'first': 'first_name', 'last': 'last_name', surname: 'last_name', 'lead source': 'source', owner: 'owner_id', 'assigned to': 'owner_id', stage: 'stage_id', status: 'stage_id', 'deal value': 'amount', value: 'amount', 'expected close': 'close_date' };
  if (aliases[h]) return fields.some((f) => f.key === aliases[h]) ? aliases[h]! : '';
  const f = fields.find((x) => x.label.toLowerCase() === h || x.key.replace(/_/g, ' ') === h || x.key === h.replace(/ /g, '_'));
  if (f) return f.key;
  if (h === 'name' && fields.some((x) => x.key === 'name')) return 'name';
  return '';
}

type Step = 'pick' | 'map' | 'run' | 'done';

export function ImportWizard({ obj, onClose, onDone }: { obj: ObjectMeta; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fields = obj.fields.filter((f) => !f.readOnly && f.key !== 'pipeline_id');
  const [step, setStep] = useState<Step>('pick');
  const [fileName, setFileName] = useState('');
  const [header, setHeader] = useState<string[]>([]);
  const [data, setData] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [mode, setMode] = useState<'create' | 'upsert'>('create');
  const [matchField, setMatchField] = useState('email');
  const [progress, setProgress] = useState({ done: 0, created: 0, updated: 0, failed: [] as { row: number; error: string; details?: unknown }[] });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast('That file is larger than 10 MB. Split it into smaller files.', true);
      return;
    }
    const rows = parseCsv(await file.text());
    if (rows.length < 2) {
      toast('The file needs a header row and at least one data row.', true);
      return;
    }
    const [h, ...rest] = rows;
    setFileName(file.name);
    setHeader(h!);
    setData(rest.slice(0, 50_000));
    setMapping(h!.map((c) => guessField(c, fields)));
    setMatchField(fields.some((f) => f.key === 'email') ? 'email' : 'name');
    setStep('map');
  };

  const run = async () => {
    setStep('run');
    try {
      const job = await post<{ id: string }>(`/api/v1/import/${obj.key}/jobs`, { fileName, mode, matchField: mode === 'upsert' ? matchField : null, totalRows: data.length });
      let done = 0;
      let created = 0;
      let updated = 0;
      const failed: { row: number; error: string; details?: unknown }[] = [];
      for (let i = 0; i < data.length; i += BATCH) {
        const chunk = data.slice(i, i + BATCH).map((r) => {
          const o: Record<string, string> = {};
          mapping.forEach((k, ci) => {
            if (k && r[ci] !== undefined && r[ci] !== '') o[k] = r[ci]!;
          });
          return o;
        });
        const res = await post<{ created: number; updated: number; failed: { row: number; error: string; details?: unknown }[] }>(`/api/v1/import/${obj.key}/jobs/${job.id}/rows`, { startRow: i + 2, rows: chunk });
        created += res.created;
        updated += res.updated;
        failed.push(...res.failed);
        done = Math.min(i + BATCH, data.length);
        setProgress({ done, created, updated, failed: [...failed] });
      }
      await post(`/api/v1/import/${obj.key}/jobs/${job.id}/finish`);
      setStep('done');
      onDone();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Import stopped unexpectedly', true);
      setStep('done');
    }
  };

  const errorDetail = (f: { error: string; details?: unknown }) =>
    Array.isArray(f.details) && f.details.length ? (f.details as { field?: string; message: string }[]).map((d) => `${d.field ?? ''} ${d.message}`.trim()).join('; ') : f.error;

  const mappedCount = mapping.filter(Boolean).length;
  const missingRequired = fields.filter((f) => f.required && !mapping.includes(f.key));

  return (
    <Modal
      title={`Import ${obj.plural.toLowerCase()}`}
      wide
      onClose={step === 'run' ? () => undefined : onClose}
      footer={
        step === 'map' ? (
          <>
            <button className="btn" onClick={() => setStep('pick')}>
              Back
            </button>
            <button className="btn primary" disabled={!mappedCount || (mode === 'create' && missingRequired.length > 0)} onClick={run}>
              Import {data.length.toLocaleString('en-IN')} rows
            </button>
          </>
        ) : step === 'done' ? (
          <>
            {progress.failed.length > 0 && (
              <button
                className="btn"
                onClick={() =>
                  downloadText(
                    `${obj.key}-import-errors.csv`,
                    toCsv([['Row', 'Problem', ...header], ...progress.failed.map((f) => [f.row, errorDetail(f), ...(data[f.row - 2] ?? [])])]),
                  )
                }
              >
                Download rows that failed
              </button>
            )}
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </>
        ) : undefined
      }
    >
      <div className="modal-body" style={{ display: 'block' }}>
        {step === 'pick' && (
          <div className="stack">
            <p style={{ margin: 0 }}>Choose a CSV file. The first row must contain column names. Excel files can be saved as CSV from File → Save As.</p>
            <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} aria-label="CSV file" />
            <p className="muted small" style={{ margin: 0 }}>
              Dates like 31/12/2026, amounts like ₹12,50,000, Yes/No values, owner emails and stage names are understood. Up to 50,000 rows.
            </p>
          </div>
        )}
        {step === 'map' && (
          <div className="stack">
            <div className="stack" style={{ gap: 6 }}>
              <label className="row">
                <input type="radio" checked={mode === 'create'} onChange={() => setMode('create')} /> Create new records
              </label>
              <label className="row">
                <input type="radio" checked={mode === 'upsert'} onChange={() => setMode('upsert')} /> Update existing records when
                <select value={matchField} onChange={(e) => setMatchField(e.target.value)} style={{ width: 'auto' }} disabled={mode !== 'upsert'} aria-label="Match field">
                  {fields.filter((f) => ['text', 'email', 'phone', 'url'].includes(f.type)).map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                matches, otherwise create
              </label>
            </div>
            {missingRequired.length > 0 && mode === 'create' && <div className="field-error">Map a column to: {missingRequired.map((f) => f.label).join(', ')}</div>}
            <div className="table-wrap" style={{ maxHeight: '50vh' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Column in your file</th>
                    <th>Example</th>
                    <th>Import into</th>
                  </tr>
                </thead>
                <tbody>
                  {header.map((h, i) => (
                    <tr key={i}>
                      <td>
                        <b>{h || `Column ${i + 1}`}</b>
                      </td>
                      <td className="muted">{data.find((r) => r[i])?.[i] ?? ''}</td>
                      <td>
                        <select value={mapping[i] ?? ''} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Map ${h}`}>
                          <option value="">Don't import</option>
                          {fields.map((f) => (
                            <option key={f.key} value={f.key} disabled={mapping.includes(f.key) && mapping[i] !== f.key}>
                              {f.label}
                              {f.required ? ' *' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {(step === 'run' || step === 'done') && (
          <div className="stack">
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={data.length} aria-valuenow={progress.done}>
              <div style={{ width: `${(progress.done / Math.max(data.length, 1)) * 100}%` }} />
            </div>
            <p style={{ margin: 0 }}>
              {step === 'run' ? 'Importing' : 'Finished'}: {progress.done.toLocaleString('en-IN')} of {data.length.toLocaleString('en-IN')} rows — {progress.created} created, {progress.updated} updated, {progress.failed.length} failed.
            </p>
            {progress.failed.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: 220 }}>
                <table className="data">
                  <tbody>
                    {progress.failed.slice(0, 50).map((f) => (
                      <tr key={f.row}>
                        <td style={{ width: 70 }}>Row {f.row}</td>
                        <td style={{ whiteSpace: 'normal' }} className="field-error">
                          {errorDetail(f)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
