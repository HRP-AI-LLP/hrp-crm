import { type ObjectMeta, valueType } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { describeFilter, FilterBuilder } from '../components/ListTools';
import { fieldOf, type ReportDefinition, type ReportResult, ReportView } from '../components/ReportView';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { ApiError, del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { useMeta } from '../lib/hooks';

export interface SavedReport {
  id: string;
  name: string;
  description: string | null;
  object_key: string;
  definition: ReportDefinition;
  folder: string | null;
  is_shared: boolean;
  mine: boolean;
  owner_name: string | null;
  updated_at: string;
}

const CHARTS: [NonNullable<ReportDefinition['chart']>, string][] = [
  ['bar', 'Columns'],
  ['hbar', 'Bars'],
  ['line', 'Line'],
  ['pie', 'Donut'],
  ['funnel', 'Funnel'],
  ['number', 'Single number'],
];

export const emptyDefinition = (): ReportDefinition => ({ type: 'chart', chart: 'bar', filters: [], columns: [], groupBy: null, groupBy2: null, dateBucket: 'month', measure: { agg: 'count' }, limit: 50, sort: null });

export function ReportsPage() {
  const { data } = useQuery({ queryKey: ['reports'], queryFn: () => get<{ items: SavedReport[] }>('/api/v1/reports') });
  const { data: meta } = useMeta();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const items = (data?.items ?? []).filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()));
  const folders = [...new Set(items.map((r) => r.folder ?? ''))].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Reports</h1>
          <p>Ask questions of your data: totals by stage, owner, month or any field — as tables or charts.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/dashboards">
            Dashboards
          </Link>
          <button className="btn primary" onClick={() => nav('/reports/new')}>
            New report
          </button>
        </div>
      </div>
      <section className="panel">
        <div className="toolbar">
          <input type="search" placeholder="Search reports" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search reports" />
        </div>
        {!data ? (
          <div className="panel-body">
            <Spinner />
          </div>
        ) : !items.length ? (
          <Empty title="No reports yet" action={<button className="btn primary" onClick={() => nav('/reports/new')}>Build your first report</button>}>
            For example: pipeline value by stage, leads by source this quarter, or won deals by owner.
          </Empty>
        ) : (
          folders.map((f) => (
            <div key={f || 'none'}>
              <div className="folder-head">{f || 'Unfiled'}</div>
              <table className="data">
                <tbody>
                  {items
                    .filter((r) => (r.folder ?? '') === f)
                    .map((r) => (
                      <tr key={r.id} className="click" onClick={() => nav(`/reports/${r.id}`)}>
                        <td>
                          <Link to={`/reports/${r.id}`} onClick={(e) => e.stopPropagation()} style={{ fontWeight: 600 }}>
                            {r.name}
                          </Link>
                          {r.description && <div className="muted small">{r.description}</div>}
                        </td>
                        <td className="muted">{meta?.objects.find((o) => o.key === r.object_key)?.plural ?? r.object_key}</td>
                        <td>{r.is_shared ? <span className="chip">Shared</span> : <span className="muted small">Only me</span>}</td>
                        <td className="muted small">{r.owner_name}</td>
                        <td className="muted small">{relative(r.updated_at)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))
        )}
      </section>
    </>
  );
}

/** Report builder with live preview. */
export function ReportBuilderPage() {
  const { id } = useParams();
  const isNew = !id || id === 'new';
  const { data: meta } = useMeta();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ queryKey: ['report', id], queryFn: () => get<{ name: string; objectKey: string; definition: ReportDefinition }>(`/api/v1/reports/${id}/run`), enabled: !isNew });
  const list = useQuery({ queryKey: ['reports'], queryFn: () => get<{ items: SavedReport[] }>('/api/v1/reports') });
  const record = list.data?.items.find((r) => r.id === id);

  const [objectKey, setObjectKey] = useState('deal');
  const [def, setDef] = useState<ReportDefinition>(emptyDefinition);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [dialog, setDialog] = useState<null | 'filter' | 'save'>(null);

  useEffect(() => {
    if (saved.data) {
      setObjectKey(saved.data.objectKey);
      setDef({ ...emptyDefinition(), ...saved.data.definition });
    }
  }, [saved.data]);

  const obj = meta?.objects.find((o) => o.key === objectKey);
  const stageOrder = useMemo(() => meta?.pipelines.filter((p) => p.objectKey === objectKey).flatMap((p) => p.stages.map((s) => s.id)) ?? [], [meta, objectKey]);

  // live preview, debounced
  useEffect(() => {
    if (!obj) return;
    const t = setTimeout(async () => {
      setRunning(true);
      try {
        setResult(await post<ReportResult>('/api/v1/reports/run', { objectKey, definition: def }));
        setError(null);
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Could not run the report');
        setResult(null);
      } finally {
        setRunning(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [objectKey, def, obj]);

  if (!meta || (!isNew && !saved.data && !saved.error)) return <Spinner />;
  if (saved.error) return <Empty title="This report is not available" />;
  if (!obj) return <Spinner />;

  const set = (patch: Partial<ReportDefinition>) => setDef((d) => ({ ...d, ...patch }));
  const groupable = obj.fields.filter((f) => !['textarea', 'multipicklist'].includes(valueType(f)) && f.key !== 'full_name');
  const numeric = obj.fields.filter((f) => ['number', 'currency', 'percent'].includes(valueType(f)));
  const dateGroup = (k?: string | null) => {
    const f = fieldOf(obj, k);
    return !!f && ['date', 'datetime'].includes(valueType(f));
  };
  const canEdit = isNew || record?.mine || can('reports');

  return (
    <>
      <div className="page-head">
        <div>
          <p className="small">
            <Link to="/reports">Reports</Link> /
          </p>
          <h1>{isNew ? 'New report' : saved.data?.name}</h1>
        </div>
        <div className="row">
          {!isNew && canEdit && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!window.confirm('Delete this report? Dashboards that show it will lose the widget.')) return;
                await del(`/api/v1/reports/${id}`).catch((e) => toast((e as Error).message, true));
                qc.invalidateQueries({ queryKey: ['reports'] });
                nav('/reports');
              }}
            >
              Delete
            </button>
          )}
          {canEdit && (
            <button className="btn primary" onClick={() => setDialog('save')}>
              {isNew ? 'Save report' : 'Save changes'}
            </button>
          )}
        </div>
      </div>
      <div className="rb-grid">
        <aside className="panel rb-config">
          <div className="panel-body stack">
            <label className="field">
              Records
              <select value={objectKey} onChange={(e) => { setObjectKey(e.target.value); setDef(emptyDefinition()); }}>
                {meta.objects.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.plural}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Show as</span>
              <div className="seg" role="group" aria-label="Report type">
                {(['chart', 'summary', 'table'] as const).map((t) => (
                  <button key={t} aria-pressed={def.type === t} onClick={() => set({ type: t })}>
                    {t === 'chart' ? 'Chart' : t === 'summary' ? 'Summary' : 'List'}
                  </button>
                ))}
              </div>
            </div>
            {def.type === 'chart' && (
              <label className="field">
                Chart
                <select value={def.chart ?? 'bar'} onChange={(e) => set({ chart: e.target.value as ReportDefinition['chart'] })}>
                  {CHARTS.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {def.type !== 'table' ? (
              <>
                <label className="field">
                  Measure
                  <select
                    value={def.measure.agg === 'count' ? 'count' : `${def.measure.agg}:${def.measure.field}`}
                    onChange={(e) => {
                      const [agg, field] = e.target.value.split(':');
                      set({ measure: { agg: agg as ReportDefinition['measure']['agg'], field: field ?? null } });
                    }}
                  >
                    <option value="count">Number of records</option>
                    {numeric.flatMap((f) =>
                      (['sum', 'avg', 'max', 'min'] as const).map((a) => (
                        <option key={`${a}:${f.key}`} value={`${a}:${f.key}`}>
                          {{ sum: 'Total', avg: 'Average', max: 'Highest', min: 'Lowest' }[a]} {f.label.toLowerCase()}
                        </option>
                      )),
                    )}
                  </select>
                </label>
                {(def.type !== 'chart' || def.chart !== 'number') && (
                  <label className="field">
                    Group by
                    <select value={def.groupBy ?? ''} onChange={(e) => set({ groupBy: e.target.value || null, groupBy2: e.target.value ? def.groupBy2 : null })}>
                      <option value="">{def.type === 'summary' ? 'No grouping (grand total)' : 'Choose a field…'}</option>
                      {groupable.map((f) => (
                        <option key={f.key} value={f.key}>
                          {f.label}
                        </option>
                      ))}
                      <option value="created_at">Created date</option>
                    </select>
                  </label>
                )}
                {(dateGroup(def.groupBy) || dateGroup(def.groupBy2)) && (
                  <label className="field">
                    Date grouping
                    <select value={def.dateBucket ?? 'month'} onChange={(e) => set({ dateBucket: e.target.value as ReportDefinition['dateBucket'] })}>
                      {['day', 'week', 'month', 'quarter', 'year'].map((b) => (
                        <option key={b} value={b}>
                          By {b}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {def.groupBy && (def.type === 'summary' || def.chart === 'bar' || def.chart === 'line') && (
                  <label className="field">
                    {def.type === 'summary' ? 'Columns by (optional)' : 'Split by (optional)'}
                    <select value={def.groupBy2 ?? ''} onChange={(e) => set({ groupBy2: e.target.value || null })}>
                      <option value="">—</option>
                      {groupable
                        .filter((f) => f.key !== def.groupBy)
                        .map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <span>Columns</span>
                  <div className="col-picks">
                    {obj.fields
                      .filter((f) => f.key !== 'full_name')
                      .map((f) => (
                        <label key={f.key} className="row small">
                          <input
                            type="checkbox"
                            checked={def.columns.includes(f.key)}
                            onChange={(e) => set({ columns: e.target.checked ? [...def.columns, f.key] : def.columns.filter((c) => c !== f.key) })}
                          />
                          {f.label}
                        </label>
                      ))}
                  </div>
                </div>
                <label className="field">
                  Sort by
                  <select value={def.sort ? `${def.sort.field}:${def.sort.dir}` : ''} onChange={(e) => set({ sort: e.target.value ? { field: e.target.value.split(':')[0]!, dir: e.target.value.split(':')[1] as 'asc' | 'desc' } : null })}>
                    <option value="">Last updated</option>
                    {obj.fields.flatMap((f) => [
                      <option key={`${f.key}:desc`} value={`${f.key}:desc`}>
                        {f.label} (high → low / Z → A)
                      </option>,
                      <option key={`${f.key}:asc`} value={`${f.key}:asc`}>
                        {f.label} (low → high / A → Z)
                      </option>,
                    ])}
                  </select>
                </label>
                <label className="field">
                  Rows
                  <select value={def.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
                    {[10, 25, 50, 100, 200].map((n) => (
                      <option key={n} value={n}>
                        Top {n}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <div className="field">
              <span className="spread">
                Filters
                <button className="link" style={{ padding: 0 }} onClick={() => setDialog('filter')}>
                  {def.filters.length ? 'Edit' : 'Add'}
                </button>
              </span>
              {def.filters.length ? (
                <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
                  {def.filters.map((f, i) => (
                    <span key={i} className="chip filter-chip">
                      {describeFilter(obj, f)}
                      <button aria-label="Remove filter" onClick={() => set({ filters: def.filters.filter((_, j) => j !== i) })}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <span className="muted small">All {obj.plural.toLowerCase()} you can see</span>
              )}
            </div>
          </div>
        </aside>
        <section className="panel rb-preview">
          <div className="panel-head">
            <h2>Preview</h2>
            {running && <span className="muted small">Updating…</span>}
          </div>
          <div className="panel-body">
            {error ? (
              <div className="field-error">{error}</div>
            ) : def.type === 'chart' && def.chart !== 'number' && !def.groupBy ? (
              <Empty title="Choose what to group by">Charts compare groups — for example stage, owner, source or month.</Empty>
            ) : result ? (
              <ReportView obj={obj} def={def} result={result} stageOrder={stageOrder} />
            ) : (
              <Spinner />
            )}
          </div>
        </section>
      </div>
      {dialog === 'filter' && (
        <FilterBuilder
          obj={obj}
          value={def.filters}
          onClose={() => setDialog(null)}
          onChange={(filters) => {
            set({ filters });
            setDialog(null);
          }}
        />
      )}
      {dialog === 'save' && (
        <SaveReportModal
          obj={obj}
          initial={{ name: saved.data?.name ?? '', folder: record?.folder ?? '', description: record?.description ?? '', isShared: record?.is_shared ?? false }}
          canShare={can('reports')}
          onClose={() => setDialog(null)}
          onSave={async (m) => {
            try {
              const body = { ...m, objectKey, definition: def };
              const r = isNew ? await post<{ id: string }>('/api/v1/reports', body) : await put<{ id: string }>(`/api/v1/reports/${id}`, body);
              toast('Report saved');
              await qc.invalidateQueries({ queryKey: ['reports'] });
              qc.invalidateQueries({ queryKey: ['report', id] });
              setDialog(null);
              if (isNew) nav(`/reports/${r.id}`, { replace: true });
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        />
      )}
    </>
  );
}

function SaveReportModal({ obj, initial, canShare, onSave, onClose }: { obj: ObjectMeta; initial: { name: string; folder: string; description: string; isShared: boolean }; canShare: boolean; onSave: (m: { name: string; folder: string | null; description: string | null; isShared: boolean }) => Promise<void>; onClose: () => void }) {
  const [m, setM] = useState(initial);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Save report"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!m.name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            await onSave({ name: m.name.trim(), folder: m.folder.trim() || null, description: m.description.trim() || null, isShared: m.isShared });
            setBusy(false);
          }}
        >
          Save
        </button>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          Name
          <input value={m.name} onChange={(e) => setM({ ...m, name: e.target.value })} placeholder={`e.g. ${obj.plural} by owner`} maxLength={120} />
        </label>
        <label className="field">
          Folder
          <input value={m.folder} onChange={(e) => setM({ ...m, folder: e.target.value })} placeholder="e.g. Sales" maxLength={60} />
        </label>
        <label className="field">
          Description
          <input value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} maxLength={500} />
        </label>
        {canShare && (
          <label className="row wide">
            <input type="checkbox" checked={m.isShared} onChange={(e) => setM({ ...m, isShared: e.target.checked })} /> Share with everyone (each person still sees only records they can access)
          </label>
        )}
      </div>
    </Modal>
  );
}
