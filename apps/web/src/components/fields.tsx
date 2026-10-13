import type { FieldDef, ObjectMeta, RecordDto } from '@synapse/shared';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, get, post } from '../lib/api';
import { date, dateTime, money, number } from '../lib/format';
import { stageLookup, useMeta, usePipelines, useUsers } from '../lib/hooks';
import { Modal, ScoreRing, StageChip, useToast } from './ui';

/** Read-only rendering of any field value by type. */
export function FieldValue({ field, record }: { field: FieldDef; record: RecordDto }) {
  const { data: meta } = useMeta();
  const { data: users } = useUsers();
  const v = record[field.key];
  if (field.key === 'stage_id') return <StageChip stage={stageLookup(meta).get(String(v))} />;
  if (field.key === 'pipeline_id') return <>{meta?.pipelines.find((p) => p.id === v)?.name ?? '—'}</>;
  if (field.key === 'ai_score') return <ScoreRing value={v as number | null} />;
  if (v === null || v === undefined || v === '') return <span className="muted">—</span>;
  switch (field.type) {
    case 'currency':
      return <>{money(v, String(record.currency ?? 'INR'))}</>;
    case 'number':
      return <>{number(v)}</>;
    case 'percent':
      return <>{number(v)}%</>;
    case 'date':
      return <>{date(v)}</>;
    case 'datetime':
      return <>{dateTime(v)}</>;
    case 'boolean':
      return <>{v ? 'Yes' : 'No'}</>;
    case 'user':
      return <>{users?.items.find((u) => u.id === v)?.full_name ?? 'Unknown user'}</>;
    case 'lookup':
      return field.options?.lookupObject ? <LookupLink objectKey={field.options.lookupObject} id={String(v)} /> : <>{String(v)}</>;
    case 'email':
      return <a href={`mailto:${String(v)}`}>{String(v)}</a>;
    case 'phone':
      return <a href={`tel:${String(v).replace(/\s/g, '')}`}>{String(v)}</a>;
    case 'url':
      return (
        <a href={String(v)} target="_blank" rel="noreferrer noopener">
          {String(v).replace(/^https?:\/\//, '')}
        </a>
      );
    case 'picklist':
      return <>{field.options?.choices?.find((c) => c.value === v)?.label ?? String(v)}</>;
    case 'multipicklist':
      return <>{(v as string[]).map((x) => field.options?.choices?.find((c) => c.value === x)?.label ?? x).join(', ')}</>;
    default:
      return <>{String(v)}</>;
  }
}

function LookupLink({ objectKey, id }: { objectKey: string; id: string }) {
  const { data } = useQuery({ queryKey: ['record', objectKey, id], queryFn: () => get<RecordDto>(`/api/v1/records/${objectKey}/${id}`), staleTime: 60_000, retry: false });
  return <Link to={`/o/${objectKey}/${id}`}>{data?.title || 'Open record'}</Link>;
}

/** Editable input for any field type. */
export function FieldInput({ field, value, onChange, objectKey }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; objectKey: string }) {
  const { data: users } = useUsers();
  const pipelines = usePipelines(objectKey);
  const id = `f-${field.key}`;
  const str = value === null || value === undefined ? '' : String(value);

  if (field.key === 'stage_id') {
    return (
      <select id={id} value={str} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Default stage</option>
        {pipelines.map((p) => (
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
  if (field.key === 'pipeline_id') {
    return (
      <select id={id} value={str} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Default pipeline</option>
        {pipelines.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    );
  }
  switch (field.type) {
    case 'textarea':
      return <textarea id={id} value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'number':
    case 'currency':
    case 'percent':
      return <input id={id} type="number" inputMode="decimal" value={str} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
    case 'date':
      return <input id={id} type="date" value={str.slice(0, 10)} onChange={(e) => onChange(e.target.value || null)} />;
    case 'datetime':
      return <input id={id} type="datetime-local" value={str ? toLocalInput(str) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'boolean':
      return <input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
    case 'picklist':
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {field.options?.choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'multipicklist':
      return (
        <select id={id} multiple value={(value as string[]) ?? []} onChange={(e) => onChange([...e.target.selectedOptions].map((o) => o.value))}>
          {field.options?.choices?.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      );
    case 'user':
      return (
        <select id={id} value={str} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {users?.items.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name}
            </option>
          ))}
        </select>
      );
    case 'lookup':
      return <LookupPicker id={id} objectKey={field.options?.lookupObject ?? ''} value={str} onChange={onChange} />;
    case 'email':
      return <input id={id} type="email" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'phone':
      return <input id={id} type="tel" value={str} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <input id={id} type="url" placeholder="https://" value={str} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input id={id} value={str} onChange={(e) => onChange(e.target.value)} />;
  }
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function LookupPicker({ id, objectKey, value, onChange }: { id: string; objectKey: string; value: string; onChange: (v: unknown) => void }) {
  const [q, setQ] = useState('');
  const { data } = useQuery({
    queryKey: ['lookup', objectKey, q],
    queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/${objectKey}?limit=20${q ? `&q=${encodeURIComponent(q)}` : ''}`),
    enabled: !!objectKey,
    staleTime: 30_000,
  });
  const { data: current } = useQuery({ queryKey: ['record', objectKey, value], queryFn: () => get<RecordDto>(`/api/v1/records/${objectKey}/${value}`), enabled: !!value, retry: false });
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input placeholder="Type to search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search records" />
      <select id={id} value={value} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {current && !data?.items.some((i) => i.id === current.id) && <option value={current.id}>{current.title}</option>}
        {data?.items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.title}
          </option>
        ))}
      </select>
    </div>
  );
}

const WIDE_TYPES = new Set(['textarea', 'multipicklist', 'lookup']);

/** Create form generated from metadata. */
export function RecordFormModal({ object, onClose, onSaved, initial }: { object: ObjectMeta; onClose: () => void; onSaved: (r: RecordDto) => void; initial?: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, unknown>>(initial ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const hasPipeline = usePipelines(object.key).length > 0;
  const fields = object.fields.filter((f) => !f.readOnly && f.key !== 'pipeline_id' && (hasPipeline || f.key !== 'stage_id'));

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const body = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '' && v !== undefined));
      const r = await post<RecordDto>(`/api/v1/records/${object.key}`, body);
      toast(`${object.label} created`);
      onSaved(r);
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) {
        setErrors(Object.fromEntries(err.details.map((d) => [d.field ?? d.path ?? '', d.message])));
      } else toast((err as Error).message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New ${object.label.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => submit()} disabled={busy}>
            {busy ? 'Saving…' : `Create ${object.label.toLowerCase()}`}
          </button>
        </>
      }
    >
      <form className="modal-body" onSubmit={submit}>
        {fields.map((f) => (
          <label key={f.key} className={`field${WIDE_TYPES.has(f.type) ? ' wide' : ''}`} htmlFor={`f-${f.key}`}>
            <span>
              {f.label} {f.required && <span className="req">*</span>}
            </span>
            <FieldInput field={f} objectKey={object.key} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
            {f.helpText && <span className="muted small">{f.helpText}</span>}
            {errors[f.key] && <span className="field-error">{errors[f.key]}</span>}
          </label>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
