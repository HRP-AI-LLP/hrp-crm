import type { FieldDef } from '@synapse/shared';
import { hasAdmin, objectPerm } from '@synapse/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FieldValue, RecordFormModal } from '../components/fields';
import { BulkEditModal, ColumnPicker, describeFilter, type Filter, FilterBuilder, ImportWizard } from '../components/ListTools';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { ApiError, del, download, get, getText, post, put } from '../lib/api';
import { parseCsv } from '../lib/csv';
import { exportReportPdf } from '../lib/table-pdf';
import { useAuth } from '../lib/auth';
import { relative } from '../lib/format';
import { useObject, usePipelines, useRecords } from '../lib/hooks';

const HIDDEN_COLUMNS = new Set(['first_name', 'last_name', 'pipeline_id', 'name', 'full_name']);

interface SavedView {
  id: string;
  name: string;
  is_shared: boolean;
  mine: boolean;
  filters: Filter[];
  columns: string[];
  sort: { field: string; dir: 'asc' | 'desc' } | null;
}

type ViewKey = 'all' | 'mine' | string;

export function RecordListPage() {
  const { object = '' } = useParams();
  const obj = useObject(object);
  const pipelines = usePipelines(object);
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sort, setSort] = useState<{ field?: string; dir: 'asc' | 'desc' }>({ dir: 'desc' });
  const [stage, setStage] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [view, setView] = useState<ViewKey>('all');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [cols, setCols] = useState<string[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<null | 'create' | 'filter' | 'columns' | 'bulk' | 'import' | 'save' | 'delete'>(null);
  const [exportMenu, setExportMenu] = useState(false);
  // "New …" from the command palette opens the form straight away
  useEffect(() => {
    if (params.get('new') === '1') setDialog('create');
  }, [object, params]);
  useEffect(() => {
    if (!exportMenu) return;
    const close = (e: MouseEvent) => !(e.target as Element).closest?.('.export-menu') && setExportMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [exportMenu]);

  const views = useQuery({ queryKey: ['views', object], queryFn: () => get<{ items: SavedView[] }>(`/api/v1/views/${object}`), enabled: !!object });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setCursor(undefined);
    setSelected(new Set());
  }, [debounced, sort, stage, object, filters]);
  // switching objects resets everything view-related
  useEffect(() => {
    setView('all');
    let initial: Filter[] = [];
    try {
      const raw = params.get('filter');
      if (raw) initial = (JSON.parse(raw) as Filter[]).filter((f) => f && typeof f.field === 'string' && typeof f.op === 'string').slice(0, 20);
    } catch {
      /* ignore a malformed link */
    }
    setFilters(initial);
    setCols(null);
    setDirty(false);
    setSort({ dir: 'desc' });
    setStage('');
    setQ('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [object]);

  const effectiveFilters = useMemo(() => (view === 'mine' ? [{ field: 'owner_id', op: 'eq', value: '$me' }, ...filters] : filters), [view, filters]);
  const listParams = {
    q: debounced,
    sort: sort.field,
    dir: sort.field ? sort.dir : undefined,
    stage: stage || undefined,
    cursor,
    filters: effectiveFilters.length ? JSON.stringify(effectiveFilters) : undefined,
    count: '1',
  };
  const { data, isLoading, error } = useRecords(object, listParams);

  if (!obj) return <Spinner />;
  const perm = me ? objectPerm(me.permissions, object) : null;
  const canCreate = !!perm?.create;
  const canEdit = !!perm && perm.update !== 'none';
  const canDelete = !!perm && perm.delete !== 'none';
  const isAdmin = !!me && hasAdmin(me.permissions, 'metadata');
  const defaultCols = obj.fields.filter((f) => !HIDDEN_COLUMNS.has(f.key) && f.type !== 'textarea').slice(0, 7).map((f) => f.key);
  const columns: FieldDef[] = (cols ?? defaultCols).map((k) => obj.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f);
  const saved = views.data?.items ?? [];
  const current = saved.find((v) => v.id === view);
  const items = data?.items ?? [];
  const allOnPage = items.length > 0 && items.every((r) => selected.has(r.id));

  const applyView = (key: ViewKey) => {
    setView(key);
    setDirty(false);
    const v = saved.find((x) => x.id === key);
    setFilters(v?.filters ?? []);
    setCols(v?.columns.length ? v.columns : null);
    setSort(v?.sort ? { field: v.sort.field, dir: v.sort.dir } : { dir: 'desc' });
  };
  const change = <T,>(setter: (x: T) => void) => (x: T) => {
    setter(x);
    setDirty(true);
  };

  const viewBody = (name: string, isShared: boolean) => ({
    name,
    isShared,
    filters: effectiveFilters.map((f) => ({ field: f.field, op: f.op, value: f.value })),
    columns: cols ?? [],
    sort: sort.field ? { field: sort.field, dir: sort.dir } : null,
  });

  const saveCurrent = async () => {
    if (!current) return;
    try {
      await put(`/api/v1/views/${object}/${current.id}`, viewBody(current.name, current.is_shared));
      setDirty(false);
      toast('View saved');
      qc.invalidateQueries({ queryKey: ['views', object] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const exportQuery = (ids?: string[]) => {
    const p = new URLSearchParams();
    if (debounced) p.set('q', debounced);
    const f = [...effectiveFilters, ...(stage ? [{ field: 'stage_id', op: 'eq', value: stage }] : [])];
    if (f.length) p.set('filters', JSON.stringify(f));
    if (sort.field) {
      p.set('sort', sort.field);
      p.set('dir', sort.dir);
    }
    p.set('columns', ['title', ...columns.map((c) => c.key)].join(','));
    if (ids?.length) p.set('ids', ids.join(','));
    return p;
  };
  const exportNow = async (ids?: string[]) => {
    setExportMenu(false);
    const p = exportQuery(ids);
    try {
      const h = await download(`/api/v1/export/${object}?${p}`, `${object}.csv`);
      if (h.get('x-export-truncated') === 'true') toast(`Exported the first ${h.get('x-export-rows')} rows. Narrow the filters to export the rest.`, true);
      else toast(`Exported ${h.get('x-export-rows') ?? ''} rows`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  /** The same rows as the CSV (every match, not just this page), as a PDF report for management. */
  const exportPdf = async (ids?: string[]) => {
    setExportMenu(false);
    try {
      const q = exportQuery(ids);
      q.set('format', 'display');
      const { text, headers } = await getText(`/api/v1/export/${object}?${q}`);
      const rows = parseCsv(text);
      const [head = [], ...body] = rows;
      const notes = [
        ids?.length ? `${ids.length} selected` : null,
        view === 'mine' ? 'My records' : null,
        debounced ? `Search: “${debounced}”` : null,
        ...filters.map((f) => describeFilter(obj, f)),
        stage ? `Stage: ${pipelines.flatMap((p) => p.stages).find((s) => s.id === stage)?.label ?? stage}` : null,
        sort.field ? `Sorted by ${obj.fields.find((f) => f.key === sort.field)?.label ?? sort.field} (${sort.dir === 'desc' ? 'high to low' : 'low to high'})` : null,
        headers.get('x-export-truncated') === 'true' ? `First ${headers.get('x-export-rows')} rows only: narrow the filters for the rest` : null,
      ].filter(Boolean);
      const name = await exportReportPdf({ title: obj.plural, subtitle: notes.length ? notes.join('  ·  ') : 'All records', head, body: body.filter((r) => r.some((c) => c.trim())) });
      toast(`Saved ${name}`);
    } catch (e) {
      toast((e as Error).message, true);
    }
  };

  const bulk = async (action: 'update' | 'delete', patch?: Record<string, unknown>) => {
    try {
      const r = await post<{ succeeded: number; failed: { id: string; error: string }[] }>(`/api/v1/records/${object}/bulk`, { action, ids: [...selected], patch });
      const verb = action === 'delete' ? 'Deleted' : 'Updated';
      toast(r.failed.length ? `${verb} ${r.succeeded}; ${r.failed.length} skipped (${r.failed[0]!.error})` : `${verb} ${r.succeeded} ${r.succeeded === 1 ? obj.label.toLowerCase() : obj.plural.toLowerCase()}`, r.failed.length > 0);
      setSelected(new Set());
      setDialog(null);
      qc.invalidateQueries({ queryKey: ['records', object] });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Bulk action failed', true);
    }
  };

  const header = (f: FieldDef) => (
    <th key={f.key} className={['number', 'currency', 'percent'].includes(f.type) ? 'num' : undefined} aria-sort={sort.field === f.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button onClick={() => change(setSort)({ field: f.key, dir: sort.field === f.key && sort.dir === 'desc' ? 'asc' : 'desc' })}>
        {f.label}
        {sort.field === f.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  const filtered = !!(debounced || stage || effectiveFilters.length);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{obj.plural}</h1>
          <p className="small">
            {data?.total !== undefined ? `${data.total.toLocaleString('en-IN')} ${data.total === 1 ? obj.label.toLowerCase() : obj.plural.toLowerCase()}` : ''}
            {obj.moduleKey ? ` · added by the ${obj.moduleKey.replace(/_/g, ' ')} module` : ''}
          </p>
        </div>
        <div className="row">
          {pipelines.length > 0 && (
            <button className="btn" onClick={() => nav(`/pipeline/${object}`)}>
              Board view
            </button>
          )}
          {canCreate && (
            <button className="btn" onClick={() => setDialog('import')}>
              Import
            </button>
          )}
          <div className="export-menu" style={{ position: 'relative' }}>
            <button className="btn" aria-haspopup="menu" aria-expanded={exportMenu} onClick={() => setExportMenu(!exportMenu)}>
              Export ▾
            </button>
            {exportMenu && (
              <div className="menu" role="menu" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 30, minWidth: 220 }}>
                <button role="menuitem" onClick={() => exportPdf()}>
                  PDF report (for sharing)
                </button>
                <button role="menuitem" onClick={() => exportNow()}>
                  CSV (for Excel)
                </button>
              </div>
            )}
          </div>
          {canCreate && (
            <button className="btn primary" onClick={() => setDialog('create')}>
              New {obj.label.toLowerCase()}
            </button>
          )}
        </div>
      </div>

      <nav className="viewbar" aria-label="Saved views">
        <button className={view === 'all' ? 'on' : ''} onClick={() => applyView('all')}>
          All {obj.plural.toLowerCase()}
        </button>
        {obj.fields.some((f) => f.key === 'owner_id') && (
          <button className={view === 'mine' ? 'on' : ''} onClick={() => applyView('mine')}>
            My {obj.plural.toLowerCase()}
          </button>
        )}
        {saved.map((v) => (
          <button key={v.id} className={view === v.id ? 'on' : ''} onClick={() => applyView(v.id)} title={v.is_shared ? 'Shared with everyone' : 'Only you can see this view'}>
            {v.name}
            {v.is_shared && <span className="tag">shared</span>}
          </button>
        ))}
        <span className="spacer" />
        {current && dirty && (current.mine || isAdmin) && (
          <button className="link" onClick={saveCurrent}>
            Save changes
          </button>
        )}
        {(dirty || filters.length > 0 || view === 'mine' || cols) && (
          <button className="link" onClick={() => setDialog('save')}>
            Save as new view
          </button>
        )}
        {current && (current.mine || isAdmin) && (
          <button className="link danger" onClick={() => setDialog('delete')}>
            Delete view
          </button>
        )}
      </nav>

      <section className="panel">
        {selected.size > 0 ? (
          <div className="toolbar bulkbar" role="region" aria-label="Bulk actions">
            <b>{selected.size} selected</b>
            {canEdit && (
              <button className="btn sm" onClick={() => setDialog('bulk')}>
                Edit field
              </button>
            )}
            <button className="btn sm" onClick={() => exportNow([...selected])}>
              Export selected (CSV)
            </button>
            <button className="btn sm" onClick={() => exportPdf([...selected])}>
              Selected as PDF
            </button>
            {canDelete && (
              <button
                className="btn sm danger"
                onClick={() => {
                  if (window.confirm(`Delete ${selected.size} records? They can be restored by an admin from the audit log.`)) void bulk('delete');
                }}
              >
                Delete
              </button>
            )}
            <span className="spacer" />
            <button className="btn ghost sm" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
        ) : (
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
            <button className={`btn sm${filters.length ? ' active' : ''}`} onClick={() => setDialog('filter')}>
              Filter{filters.length ? ` (${filters.length})` : ''}
            </button>
            <button className="btn sm" onClick={() => setDialog('columns')}>
              Columns
            </button>
            {filters.map((f, i) => (
              <span key={i} className="chip filter-chip">
                {describeFilter(obj, f)}
                <button aria-label="Remove filter" onClick={() => change(setFilters)(filters.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {error && <div className="panel-body field-error">{(error as Error).message}</div>}
        {isLoading ? (
          <div className="panel-body">
            <Spinner />
          </div>
        ) : items.length ? (
          <div className="table-wrap">
            <table className="data" data-export="off">
              <thead>
                <tr>
                  <th className="check">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={allOnPage}
                      onChange={(e) => setSelected((s) => {
                        const n = new Set(s);
                        for (const r of items) e.target.checked ? n.add(r.id) : n.delete(r.id);
                        return n;
                      })}
                    />
                  </th>
                  <th>Name</th>
                  {columns.map(header)}
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} className={`click${selected.has(r.id) ? ' selected' : ''}`} onClick={() => nav(`/o/${object}/${r.id}`)}>
                    <td className="check" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.title || 'record'}`}
                        checked={selected.has(r.id)}
                        onChange={(e) => setSelected((s) => {
                          const n = new Set(s);
                          e.target.checked ? n.add(r.id) : n.delete(r.id);
                          return n;
                        })}
                      />
                    </td>
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
            title={filtered ? 'Nothing matches these filters' : `No ${obj.plural.toLowerCase()} yet`}
            action={
              canCreate && !filtered ? (
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button className="btn primary" onClick={() => setDialog('create')}>
                    Add the first {obj.label.toLowerCase()}
                  </button>
                  <button className="btn" onClick={() => setDialog('import')}>
                    Import from CSV
                  </button>
                </div>
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

      {dialog === 'create' && (
        <RecordFormModal
          object={obj}
          onClose={() => setDialog(null)}
          onSaved={(r) => {
            setDialog(null);
            qc.invalidateQueries({ queryKey: ['records', object] });
            nav(`/o/${object}/${r.id}`);
          }}
        />
      )}
      {dialog === 'filter' && (
        <FilterBuilder
          obj={obj}
          value={filters}
          onClose={() => setDialog(null)}
          onChange={(f) => {
            change(setFilters)(f);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'columns' && (
        <ColumnPicker
          obj={obj}
          value={columns.map((c) => c.key)}
          onClose={() => setDialog(null)}
          onChange={(c) => {
            change(setCols)(c);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'bulk' && <BulkEditModal obj={obj} count={selected.size} onClose={() => setDialog(null)} onApply={(p) => bulk('update', p)} />}
      {dialog === 'import' && <ImportWizard obj={obj} onClose={() => setDialog(null)} onDone={() => qc.invalidateQueries({ queryKey: ['records', object] })} />}
      {dialog === 'save' && (
        <SaveViewModal
          canShare={isAdmin}
          onClose={() => setDialog(null)}
          onSave={async (name, isShared) => {
            try {
              const v = await post<SavedView>(`/api/v1/views/${object}`, viewBody(name, isShared));
              await qc.invalidateQueries({ queryKey: ['views', object] });
              setView(v.id);
              setFilters(effectiveFilters);
              setDirty(false);
              setDialog(null);
              toast('View saved');
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        />
      )}
      {dialog === 'delete' && current && (
        <Modal
          title="Delete view"
          onClose={() => setDialog(null)}
          footer={
            <button
              className="btn danger"
              onClick={async () => {
                await del(`/api/v1/views/${object}/${current.id}`).catch((e) => toast((e as Error).message, true));
                await qc.invalidateQueries({ queryKey: ['views', object] });
                setDialog(null);
                applyView('all');
              }}
            >
              Delete “{current.name}”
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            {current.is_shared ? 'This view is shared, so it disappears for everyone. Records are not affected.' : 'Records are not affected.'}
          </div>
        </Modal>
      )}
    </>
  );
}

function SaveViewModal({ canShare, onSave, onClose }: { canShare: boolean; onSave: (name: string, shared: boolean) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Save view"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            await onSave(name.trim(), shared);
            setBusy(false);
          }}
        >
          Save view
        </button>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          View name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Hot leads this month" />
        </label>
        <p className="muted small wide" style={{ margin: 0 }}>
          The view keeps the current filters, columns and sort order.
        </p>
        {canShare && (
          <label className="row wide">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone in the workspace
          </label>
        )}
      </div>
    </Modal>
  );
}
