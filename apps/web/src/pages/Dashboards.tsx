import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { type ReportDefinition, type ReportResult, ReportView } from '../components/ReportView';
import { Empty, Modal, Spinner, useToast } from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/hooks';
import type { SavedReport } from './Reports';

interface Widget {
  reportId: string;
  size: 's' | 'm' | 'l';
  title?: string;
}
interface Dashboard {
  id: string;
  name: string;
  description: string | null;
  widgets: Widget[];
  is_shared: boolean;
  mine: boolean;
}

export function DashboardsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['dashboards'], queryFn: () => get<{ items: Dashboard[] }>('/api/v1/dashboards') });
  const [creating, setCreating] = useState(false);
  const items = data?.items ?? [];
  const current = items.find((d) => d.id === id) ?? (!id ? items[0] : undefined);

  useEffect(() => {
    if (!id && items[0]) nav(`/dashboards/${items[0].id}`, { replace: true });
  }, [id, items, nav]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Dashboards</h1>
          <p>Saved reports side by side, refreshed every time you open them.</p>
        </div>
        <div className="row">
          {items.length > 0 && (
            <select value={current?.id ?? ''} onChange={(e) => nav(`/dashboards/${e.target.value}`)} style={{ width: 'auto' }} aria-label="Dashboard">
              {items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.is_shared ? ' (shared)' : ''}
                </option>
              ))}
            </select>
          )}
          <Link className="btn" to="/reports">
            Reports
          </Link>
          <button className="btn primary" onClick={() => setCreating(true)}>
            New dashboard
          </button>
        </div>
      </div>
      {!data ? (
        <Spinner />
      ) : current ? (
        <DashboardView key={current.id} dash={current} canEdit={current.mine || can('reports')} />
      ) : (
        <section className="panel">
          <Empty title="No dashboards yet" action={<button className="btn primary" onClick={() => setCreating(true)}>Create a dashboard</button>}>
            Build a few reports first, then pin them here.
          </Empty>
        </section>
      )}
      {creating && (
        <NameModal
          title="New dashboard"
          canShare={can('reports')}
          onClose={() => setCreating(false)}
          onSave={async (name, isShared) => {
            try {
              const d = await post<Dashboard>('/api/v1/dashboards', { name, isShared, widgets: [] });
              await qc.invalidateQueries({ queryKey: ['dashboards'] });
              setCreating(false);
              nav(`/dashboards/${d.id}?edit=1`);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        />
      )}
    </>
  );
}

function DashboardView({ dash, canEdit }: { dash: Dashboard; canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [editing, setEditing] = useState(() => new URLSearchParams(location.search).has('edit'));
  const [widgets, setWidgets] = useState<Widget[]>(dash.widgets);
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const reports = useQuery({ queryKey: ['reports'], queryFn: () => get<{ items: SavedReport[] }>('/api/v1/reports') });

  const save = async (next: Widget[]) => {
    try {
      await put(`/api/v1/dashboards/${dash.id}`, { name: dash.name, description: dash.description, isShared: dash.is_shared, widgets: next });
      qc.invalidateQueries({ queryKey: ['dashboards'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const update = (next: Widget[]) => {
    setWidgets(next);
    void save(next);
  };

  return (
    <>
      {canEdit && (
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 12 }}>
          {editing && (
            <>
              <button className="btn" onClick={() => setAdding(true)}>
                Add report
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  if (!window.confirm(`Delete the dashboard “${dash.name}”? The reports stay.`)) return;
                  await del(`/api/v1/dashboards/${dash.id}`);
                  await qc.invalidateQueries({ queryKey: ['dashboards'] });
                  nav('/dashboards');
                }}
              >
                Delete dashboard
              </button>
            </>
          )}
          {!editing && (
            <button className="btn" onClick={() => setLinking(true)}>
              Share link
            </button>
          )}
          <button className={`btn${editing ? ' primary' : ''}`} onClick={() => setEditing((e) => !e)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        </div>
      )}
      {linking && <ShareLinkModal dash={dash} onClose={() => setLinking(false)} />}
      {widgets.length ? (
        <div className="dash-grid">
          {widgets.map((w, i) => (
            <WidgetCard
              key={`${w.reportId}-${i}`}
              widget={w}
              editing={editing}
              onSize={(size) => update(widgets.map((x, j) => (j === i ? { ...x, size } : x)))}
              onRemove={() => update(widgets.filter((_, j) => j !== i))}
              onMove={(d) => {
                const j = i + d;
                if (j < 0 || j >= widgets.length) return;
                const n = [...widgets];
                [n[i], n[j]] = [n[j]!, n[i]!];
                update(n);
              }}
            />
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty title="This dashboard is empty" action={canEdit ? <button className="btn primary" onClick={() => { setEditing(true); setAdding(true); }}>Add a report</button> : undefined} />
        </section>
      )}
      {adding && (
        <Modal title="Add a report" onClose={() => setAdding(false)}>
          <div className="modal-body" style={{ display: 'block' }}>
            {!reports.data?.items.length ? (
              <p>
                No saved reports yet. <Link to="/reports/new">Build one first</Link>.
              </p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {reports.data.items.map((r) => (
                  <button
                    key={r.id}
                    className="step-option"
                    onClick={() => {
                      update([...widgets, { reportId: r.id, size: r.definition.type === 'chart' && r.definition.chart === 'number' ? 's' : 'm' }]);
                      setAdding(false);
                    }}
                  >
                    <span className="flow-icon">{r.definition.type === 'table' ? '≡' : r.definition.type === 'summary' ? 'Σ' : '▮'}</span>
                    <span>
                      {r.name}
                      <span className="muted small"> · {r.object_key}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

function WidgetCard({ widget, editing, onSize, onRemove, onMove }: { widget: Widget; editing: boolean; onSize: (s: Widget['size']) => void; onRemove: () => void; onMove: (d: -1 | 1) => void }) {
  const { data: meta } = useMeta();
  const { data, error, isLoading } = useQuery({
    queryKey: ['report-run', widget.reportId],
    queryFn: () => get<{ name: string; objectKey: string; definition: ReportDefinition; result: ReportResult }>(`/api/v1/reports/${widget.reportId}/run`),
    staleTime: 60_000,
    retry: false,
  });
  const obj = meta?.objects.find((o) => o.key === data?.objectKey);
  const stageOrder = meta?.pipelines.filter((p) => p.objectKey === data?.objectKey).flatMap((p) => p.stages.map((s) => s.id));
  return (
    <section className={`panel widget size-${widget.size}`}>
      <div className="panel-head">
        <h2 style={{ fontSize: 15 }}>{widget.title ?? data?.name ?? 'Report'}</h2>
        {editing ? (
          <span className="row" style={{ gap: 2 }}>
            <div className="seg" role="group" aria-label="Widget size">
              {(['s', 'm', 'l'] as const).map((s) => (
                <button key={s} aria-pressed={widget.size === s} onClick={() => onSize(s)}>
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            <button className="btn ghost sm" aria-label="Move left" onClick={() => onMove(-1)}>
              ←
            </button>
            <button className="btn ghost sm" aria-label="Move right" onClick={() => onMove(1)}>
              →
            </button>
            <button className="btn ghost sm" aria-label="Remove widget" onClick={onRemove}>
              ✕
            </button>
          </span>
        ) : (
          <Link className="small" to={`/reports/${widget.reportId}`}>
            Open
          </Link>
        )}
      </div>
      <div className="panel-body">
        {isLoading ? <Spinner /> : error ? <span className="muted small">This report is no longer available.</span> : data && obj ? <ReportView obj={obj} def={data.definition} result={data.result} stageOrder={stageOrder} compact /> : null}
      </div>
    </section>
  );
}

function NameModal({ title, canShare, onSave, onClose }: { title: string; canShare: boolean; onSave: (name: string, shared: boolean) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [shared, setShared] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={<button className="btn primary" disabled={!name.trim()} onClick={() => onSave(name.trim(), shared)}>Create</button>}>
      <div className="modal-body">
        <label className="field wide">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Weekly sales review" />
        </label>
        {canShare && (
          <label className="row wide">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with everyone
          </label>
        )}
      </div>
    </Modal>
  );
}

function ShareLinkModal({ dash, onClose }: { dash: Dashboard; onClose: () => void }) {
  const toast = useToast();
  const [days, setDays] = useState(30);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const create = async () => {
    try {
      setLink(await post<{ url: string; expiresAt: string }>(`/api/v1/dashboards/${dash.id}/share-link`, { days }));
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const revoke = async () => {
    try {
      await del(`/api/v1/dashboards/${dash.id}/share-link`);
      setLink(null);
      toast('Link switched off');
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal title={`Share “${dash.name}” by link`} onClose={onClose}>
      <div className="modal-body stack">
        <p className="small">Anyone with the link sees this dashboard read-only, with the numbers you can see, until it expires. Use it for a partner, an investor or a TV in the office. Creating a new link switches the old one off.</p>
        <div className="row">
          <label className="field" style={{ margin: 0 }}>
            Expires after
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[1, 7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} {d === 1 ? 'day' : 'days'}
                </option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={create}>
            {link ? 'New link' : 'Create link'}
          </button>
          <button className="btn danger" onClick={revoke}>
            Switch off
          </button>
        </div>
        {link && (
          <label className="field">
            Link (expires {new Date(link.expiresAt).toLocaleDateString('en-IN')})
            <div className="row">
              <input readOnly value={link.url} onFocus={(e) => e.target.select()} className="mono small" />
              <button className="btn sm" onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast('Copied'))}>
                Copy
              </button>
            </div>
          </label>
        )}
      </div>
    </Modal>
  );
}

/** A dashboard opened from a share link: no sign-in, read-only. */
export function SharedDashboardPage() {
  const { token = '' } = useParams();
  const { data, error } = useQuery({
    queryKey: ['shared-dash', token],
    queryFn: async () => {
      const r = await fetch(`/api/public/dashboards/${encodeURIComponent(token)}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error?.message ?? 'This link is not valid');
      return j as Record<string, any>;
    },
    refetchInterval: 300_000,
    retry: false,
  });
  useEffect(() => {
    if (data) document.title = `${data.name} — ${data.company}`;
  }, [data]);
  if (error) return <div className="public-wrap"><p>{(error as Error).message}</p></div>;
  if (!data) return <div className="public-wrap"><Spinner /></div>;
  return (
    <div className="shared-dash">
      <header className="cp-head">
        <b>{data.company}</b>
        <span className="muted small">{data.name} · read-only · updates every 5 minutes</span>
      </header>
      <div className="dash-grid" style={{ marginTop: 16 }}>
        {(data.widgets as Record<string, any>[]).map((w, i) => {
          const obj = (data.objects as Record<string, any>[]).find((o) => o.key === w.objectKey);
          const stageOrder = (data.pipelines as Record<string, any>[]).filter((p) => p.objectKey === w.objectKey).flatMap((p) => p.stages.map((s: { id: string }) => s.id));
          return (
            <section key={i} className={`panel widget size-${w.size}`}>
              <div className="panel-head">
                <h2 style={{ fontSize: 15 }}>{w.title}</h2>
              </div>
              <div className="panel-body">{obj ? <ReportView obj={obj as never} def={w.definition} result={w.result} stageOrder={stageOrder} compact /> : null}</div>
            </section>
          );
        })}
      </div>
      {data.omitted > 0 && <p className="muted small" style={{ marginTop: 12 }}>{data.omitted === 1 ? 'One detailed list is' : `${data.omitted} detailed lists are`} shown only inside the app, not on shared links.</p>}
    </div>
  );
}
