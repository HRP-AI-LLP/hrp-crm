import type { FieldDef, ObjectMeta, RecordDto } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, get, post } from '../lib/api';
import { relative } from '../lib/format';
import { FieldValue } from './fields';
import { Empty, Modal, Spinner, useToast } from './ui';

interface RelatedGroup {
  object: string;
  label: string;
  field: string;
  fieldLabel: string;
  total: number;
  items: RecordDto[];
}

export interface DuplicateMatch {
  id: string;
  title: string;
  reasons: string[];
  score: number;
}

/** Every record elsewhere that points at this one through a lookup field. */
export function RelatedPanel({ object, id }: { object: string; id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['related', object, id], queryFn: () => get<{ groups: RelatedGroup[] }>(`/api/v1/records/${object}/${id}/related`) });
  if (isLoading) {
    return (
      <div className="panel-body">
        <Spinner />
      </div>
    );
  }
  if (!data?.groups.length) return <Empty title="Nothing linked yet">Records that reference this one through a lookup field appear here.</Empty>;
  return (
    <div className="panel-body stack">
      {data.groups.map((g) => (
        <div key={`${g.object}.${g.field}`}>
          <div className="spread" style={{ marginBottom: 6 }}>
            <h3 style={{ margin: 0, fontSize: 14 }}>
              {g.label} <span className="muted small">· {g.total} via {g.fieldLabel}</span>
            </h3>
            {g.total > g.items.length && (
              <Link className="small" to={`/o/${g.object}?filter=${encodeURIComponent(JSON.stringify([{ field: g.field, op: 'eq', value: id }]))}`}>
                View all
              </Link>
            )}
          </div>
          <ul className="related-list">
            {g.items.map((r) => (
              <li key={r.id}>
                <Link to={`/o/${g.object}/${r.id}`}>{r.title || 'Untitled'}</Link>
                <span className="muted small">{relative(r.updated_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

const dismissKey = (object: string, id: string) => `synapse.dupes.dismissed.${object}.${id}`;

export function DuplicateBanner({ obj, record }: { obj: ObjectMeta; record: RecordDto }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(dismissKey(obj.key, record.id)) === '1';
    } catch {
      return false;
    }
  });
  const [merging, setMerging] = useState(false);
  const { data } = useQuery({
    queryKey: ['duplicates', obj.key, record.id],
    queryFn: () => get<{ matches: DuplicateMatch[] }>(`/api/v1/records/${obj.key}/${record.id}/duplicates`),
    staleTime: 60_000,
    enabled: !dismissed,
  });
  const matches = data?.matches ?? [];
  if (dismissed || !matches.length) return null;
  return (
    <>
      <div className="notice" role="status">
        <div>
          <b>
            {matches.length === 1 ? 'This looks like a duplicate' : `${matches.length} possible duplicates`}:{' '}
          </b>
          {matches.slice(0, 3).map((m, i) => (
            <span key={m.id}>
              {i > 0 && ', '}
              <Link to={`/o/${obj.key}/${m.id}`}>{m.title || 'Untitled'}</Link> <span className="muted small">({m.reasons.join(', ')})</span>
            </span>
          ))}
        </div>
        <div className="row">
          <button className="btn sm primary" onClick={() => setMerging(true)}>
            Review and merge
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              try {
                sessionStorage.setItem(dismissKey(obj.key, record.id), '1');
              } catch {
                /* ignore */
              }
              setDismissed(true);
            }}
          >
            Not a duplicate
          </button>
        </div>
      </div>
      {merging && <MergeModal obj={obj} master={record} candidates={matches} onClose={() => setMerging(false)} />}
    </>
  );
}

const SKIP = new Set(['full_name', 'pipeline_id', 'ai_score']);

/** Pick which duplicates to fold into this record, then which value wins for each differing field. */
export function MergeModal({ obj, master, candidates, onClose }: { obj: ObjectMeta; master: RecordDto; candidates: DuplicateMatch[]; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [picked, setPicked] = useState<string[]>(candidates.slice(0, 1).map((c) => c.id));
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [extra, setExtra] = useState<DuplicateMatch[]>([]);
  const others = useQuery({
    queryKey: ['merge-pick', obj.key],
    queryFn: () => get<{ items: RecordDto[] }>(`/api/v1/records/${obj.key}?limit=200`),
  });
  const offered = [...candidates, ...extra];
  const dupes = useQuery({
    queryKey: ['merge-candidates', obj.key, picked.join(',')],
    queryFn: () => Promise.all(picked.map((id) => get<RecordDto>(`/api/v1/records/${obj.key}/${id}`))),
    enabled: picked.length > 0,
  });
  const records: RecordDto[] = [master, ...(dupes.data ?? [])];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const differing: FieldDef[] = obj.fields.filter((f) => !SKIP.has(f.key) && !f.readOnly && records.some((r) => !same(r[f.key], master[f.key])));
  // default: keep the master's value, unless it is empty and a duplicate has one
  const chosen = (f: FieldDef) => {
    if (choices[f.key]) return choices[f.key]!;
    const empty = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
    if (!empty(master[f.key])) return master.id;
    return records.find((r) => !empty(r[f.key]))?.id ?? master.id;
  };

  const submit = async () => {
    setBusy(true);
    try {
      const all = Object.fromEntries(differing.map((f) => [f.key, chosen(f)]).filter(([, id]) => id !== master.id));
      await post(`/api/v1/records/${obj.key}/merge`, { masterId: master.id, duplicateIds: picked, choices: all });
      toast(`Merged ${picked.length} ${picked.length === 1 ? 'record' : 'records'} into this one`);
      qc.invalidateQueries({ queryKey: ['record', obj.key, master.id] });
      qc.invalidateQueries({ queryKey: ['duplicates', obj.key, master.id] });
      qc.invalidateQueries({ queryKey: ['records', obj.key] });
      qc.invalidateQueries({ queryKey: ['timeline', obj.key, master.id] });
      onClose();
      nav(`/o/${obj.key}/${master.id}`);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Merge failed', true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Merge ${obj.plural.toLowerCase()}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted small" style={{ marginRight: 'auto' }}>
            Tasks, activities and links move to the kept record. Merged records are removed.
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.length || busy || dupes.isLoading} onClick={submit}>
            {busy ? 'Merging…' : `Merge ${picked.length + 1} records`}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ display: 'block' }}>
        <div className="row" style={{ gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span className="muted small">Add another {obj.label.toLowerCase()} that is the same:</span>
          <select
            value=""
            style={{ maxWidth: 360 }}
            onChange={(e) => {
              const r = (others.data?.items ?? []).find((x) => x.id === e.target.value);
              if (!r) return;
              setExtra((x) => [...x, { id: r.id, title: String(r.title ?? r.name ?? ''), reasons: ['chosen'] } as unknown as DuplicateMatch]);
              setPicked((p) => [...p, r.id]);
            }}
          >
            <option value="">Choose…</option>
            {(others.data?.items ?? [])
              .filter((r) => r.id !== master.id && !offered.some((c) => c.id === r.id))
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {String(r.title ?? r.name ?? 'Untitled')}
                </option>
              ))}
          </select>
        </div>
        {offered.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 14, marginBottom: 12 }}>
            <span className="muted small">Merge into this record:</span>
            {offered.map((c) => (
              <label key={c.id} className="row">
                <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
                {c.title || 'Untitled'}
              </label>
            ))}
          </div>
        )}
        {!picked.length ? (
          <p className="muted">Choose the {obj.label.toLowerCase()} to merge into this one. Its invoices, payments, deals, contacts and history move here; it is then removed.</p>
        ) : dupes.isLoading ? (
          <Spinner />
        ) : !differing.length ? (
          <p>All fields already match. Merging just combines their history.</p>
        ) : (
          <div className="table-wrap" style={{ maxHeight: '55vh' }}>
            <table className="data merge">
              <thead>
                <tr>
                  <th>Field</th>
                  {records.map((r, i) => (
                    <th key={r.id}>{i === 0 ? 'This record (kept)' : r.title || 'Duplicate'}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {differing.map((f) => (
                  <tr key={f.key}>
                    <td>
                      <b>{f.label}</b>
                    </td>
                    {records.map((r) => (
                      <td key={r.id}>
                        <label className="row" style={{ alignItems: 'flex-start' }}>
                          <input type="radio" name={`m-${f.key}`} checked={chosen(f) === r.id} onChange={() => setChoices((c) => ({ ...c, [f.key]: r.id }))} />
                          <span>
                            <FieldValue field={f} record={r} />
                          </span>
                        </label>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Shown in the create form when the values look like an existing record. */
export function DuplicateWarning({ objectKey, matches }: { objectKey: string; matches: DuplicateMatch[] }) {
  return (
    <div className="notice wide" role="alert">
      <div>
        <b>This may already exist:</b>{' '}
        {matches.slice(0, 3).map((m, i) => (
          <span key={m.id}>
            {i > 0 && ', '}
            <a href={`/o/${objectKey}/${m.id}`} target="_blank" rel="noreferrer">
              {m.title || 'Untitled'}
            </a>{' '}
            <span className="muted small">({m.reasons.join(', ')})</span>
          </span>
        ))}
      </div>
    </div>
  );
}
