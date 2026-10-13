import type { FieldDef } from '@synapse/shared';
import { objectPerm } from '@synapse/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FieldValue, RecordFormModal } from '../components/fields';
import { Empty, Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { useObject, usePipelines, useRecords } from '../lib/hooks';

const HIDDEN_COLUMNS = new Set(['first_name', 'last_name', 'pipeline_id', 'name', 'full_name']);

export function RecordListPage() {
  const { object = '' } = useParams();
  const obj = useObject(object);
  const pipelines = usePipelines(object);
  const nav = useNavigate();
  const qc = useQueryClient();
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<{ field?: string; dir: 'asc' | 'desc' }>({ dir: 'desc' });
  const [stage, setStage] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setCursor(undefined);
  }, [debounced, sort, stage, object]);

  const { data, isLoading, error } = useRecords(object, { q: debounced, sort: sort.field, dir: sort.field ? sort.dir : undefined, stage: stage || undefined, cursor });

  if (!obj) return <Spinner />;
  const canCreate = !!me && objectPerm(me.permissions, object).create;
  const columns: FieldDef[] = obj.fields.filter((f) => !HIDDEN_COLUMNS.has(f.key) && f.type !== 'textarea').slice(0, 7);

  const header = (f: FieldDef) => (
    <th key={f.key} className={['number', 'currency', 'percent'].includes(f.type) ? 'num' : undefined} aria-sort={sort.field === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button onClick={() => setSort((s) => ({ field: f.key, dir: s.field === f.key && s.dir === 'desc' ? 'asc' : 'desc' }))}>
        {f.label}
        {sort.field === f.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{obj.plural}</h1>
          {obj.moduleKey && <p className="small">Added by the {obj.moduleKey.replace(/_/g, ' ')} module</p>}
        </div>
        <div className="row">
          {pipelines.length > 0 && (
            <button className="btn" onClick={() => nav(`/pipeline/${object}`)}>
              Board view
            </button>
          )}
          {canCreate && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              New {obj.label.toLowerCase()}
            </button>
          )}
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <input type="search" placeholder={`Search ${obj.plural.toLowerCase()}`} value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Search ${obj.plural}`} />
          {pipelines.length > 0 && (
            <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
              <option value="">All stages</option>
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
          )}
        </div>
        {error && <div className="panel-body field-error">{(error as Error).message}</div>}
        {isLoading ? (
          <div className="panel-body">
            <Spinner />
          </div>
        ) : data?.items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Name</th>
                  {columns.map(header)}
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={r.id} className="click" onClick={() => nav(`/o/${object}/${r.id}`)}>
                    <td>
                      <a href={`/o/${object}/${r.id}`} onClick={(e) => e.preventDefault()} style={{ fontWeight: 600 }}>
                        {r.title || 'Untitled'}
                      </a>
                    </td>
                    {columns.map((f) => (
                      <td key={f.key} className={['number', 'currency', 'percent'].includes(f.type) ? 'num' : undefined}>
                        <FieldValue field={f} record={r} />
                      </td>
                    ))}
                    <td className="muted">{relative(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={debounced || stage ? 'Nothing matches these filters' : `No ${obj.plural.toLowerCase()} yet`}
            action={
              canCreate && !debounced && !stage ? (
                <button className="btn primary" onClick={() => setCreating(true)}>
                  Add the first {obj.label.toLowerCase()}
                </button>
              ) : undefined
            }
          />
        )}
        {(cursor || data?.nextCursor) && (
          <div className="toolbar" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--line-2)', borderBottom: 0 }}>
            {cursor && (
              <button className="btn sm" onClick={() => setCursor(undefined)}>
                First page
              </button>
            )}
            {data?.nextCursor && (
              <button className="btn sm" onClick={() => setCursor(data.nextCursor!)}>
                Next page
              </button>
            )}
          </div>
        )}
      </section>
      {creating && (
        <RecordFormModal
          object={obj}
          onClose={() => setCreating(false)}
          onSaved={(r) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['records', object] });
            nav(`/o/${object}/${r.id}`);
          }}
        />
      )}
    </>
  );
}
