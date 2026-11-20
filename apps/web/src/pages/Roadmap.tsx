/**
 * Portfolio roadmap: epics and features of every project I can see on one timeline. Bars come from
 * the item's own start / due dates, else from its children (and their sprints); drag a bar to move
 * it, drag its ends to change the dates — that sets the item's own dates.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type PointerEvent as RPointerEvent, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type Json, typeIcon } from '../components/projects/WorkItem';
import { Empty, Spinner, useToast } from '../components/ui';
import { get, patch } from '../lib/api';
import { date } from '../lib/format';

const DAY = 86_400_000;
const d10 = (t: number) => new Date(t).toISOString().slice(0, 10);
const parse = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const SPAN: [string, string, number][] = [
  ['quarter', '3 months', 92],
  ['half', '6 months', 183],
  ['year', '12 months', 366],
];

interface Drag {
  id: string;
  mode: 'move' | 'start' | 'end';
  x0: number;
  start: number;
  end: number;
  dx: number;
}

export function RoadmapPage() {
  const { data: projects } = useQuery({ queryKey: ['projects-pick'], queryFn: () => get<Json>('/api/v1/records/project?limit=200').catch(() => ({ items: [] })), staleTime: 60_000 });
  const [pick, setPick] = useState<string[]>([]);
  const { data, isLoading } = useQuery({ queryKey: ['work', 'roadmap', pick], queryFn: () => get<Json>(`/api/v1/work/roadmap${pick.length ? `?projects=${pick.join(',')}` : ''}`) });
  const [span, setSpan] = useState<'quarter' | 'half' | 'year'>('half');
  const [from, setFrom] = useState(() => {
    const n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1);
  });
  const [features, setFeatures] = useState(true);
  const [drag, setDrag] = useState<Drag | null>(null);
  const track = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const days = SPAN.find((s) => s[0] === span)![2];
  const to = from + days * DAY;
  const pct = (t: number) => ((t - from) / (to - from)) * 100;
  const months = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    const d = new Date(from);
    for (let m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).getTime(); m < to; ) {
      const x = new Date(m);
      out.push({ t: m, label: x.toLocaleString('en-IN', { month: 'short', year: x.getUTCMonth() === 0 || !out.length ? '2-digit' : undefined, timeZone: 'UTC' }) });
      m = Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 1);
    }
    return out;
  }, [from, to]);
  const groups = useMemo(() => {
    const items = ((data?.items ?? []) as Json[]).filter((i) => features || i.workType === 'epic');
    const byProject = new Map<string, { name: string; rows: Json[] }>();
    const epics = items.filter((i) => i.workType === 'epic');
    const placed = new Set<string>();
    for (const e of epics) {
      const g = byProject.get(e.projectId) ?? byProject.set(e.projectId, { name: e.projectName, rows: [] }).get(e.projectId)!;
      g.rows.push({ ...e, depth: 0 });
      placed.add(e.id);
      for (const f of items.filter((x) => x.workType === 'feature' && x.parentId === e.id)) {
        g.rows.push({ ...f, depth: 1 });
        placed.add(f.id);
      }
    }
    for (const f of items.filter((x) => !placed.has(x.id))) {
      const g = byProject.get(f.projectId) ?? byProject.set(f.projectId, { name: f.projectName, rows: [] }).get(f.projectId)!;
      g.rows.push({ ...f, depth: 0 });
    }
    return [...byProject.entries()];
  }, [data, features]);

  const save = async (it: Json, start: number, end: number) => {
    try {
      await patch(`/api/v1/projects/${it.projectId}/work/items/${it.id}`, { startDate: d10(start), dueDate: d10(end) });
      toast(`${it.key}: ${date(d10(start))} – ${date(d10(end))}`);
      qc.invalidateQueries({ queryKey: ['work', 'roadmap'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const onDown = (e: RPointerEvent, it: Json, mode: Drag['mode']) => {
    if (!it.start && !it.due) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const s = parse(it.start ?? it.due);
    const en = parse(it.due ?? it.start);
    setDrag({ id: it.id, mode, x0: e.clientX, start: s, end: Math.max(s, en), dx: 0 });
  };
  const shift = (dr: Drag) => {
    const w = track.current?.getBoundingClientRect().width ?? 1;
    return Math.round(((dr.dx / w) * (to - from)) / DAY) * DAY;
  };
  const live = (it: Json): [number, number] | null => {
    const dr = drag;
    if (!dr || dr.id !== it.id) {
      if (!it.start && !it.due) return null;
      const s = parse(it.start ?? it.due);
      return [s, Math.max(s, parse(it.due ?? it.start))];
    }
    const k = shift(dr);
    if (dr.mode === 'move') return [dr.start + k, dr.end + k];
    if (dr.mode === 'start') return [Math.min(dr.start + k, dr.end), dr.end];
    return [dr.start, Math.max(dr.end + k, dr.start)];
  };
  const today = Date.now();

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Roadmap</h1>
          <p>Epics and features across your projects. Drag a bar to move it, or its ends to change the dates.</p>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <Link to="/work" className="btn small">
            Work items
          </Link>
        </div>
      </div>
      <section className="panel">
        <div className="panel-body stack">
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small" onClick={() => setFrom(from - (days / 3) * DAY)} aria-label="Earlier">
                ←
              </button>
              <button
                className="btn small"
                onClick={() => {
                  const n = new Date();
                  setFrom(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() - 1, 1));
                }}
              >
                Today
              </button>
              <button className="btn small" onClick={() => setFrom(from + (days / 3) * DAY)} aria-label="Later">
                →
              </button>
              <div className="seg small">
                {SPAN.map(([k, l]) => (
                  <button key={k} className={span === k ? 'on' : ''} onClick={() => setSpan(k as typeof span)}>
                    {l}
                  </button>
                ))}
              </div>
              <label className="row small" style={{ gap: 4 }}>
                <input type="checkbox" checked={features} onChange={(e) => setFeatures(e.target.checked)} /> Features
              </label>
            </div>
            <select
              multiple={false}
              value=""
              onChange={(e) => e.target.value && setPick(pick.includes(e.target.value) ? pick : [...pick, e.target.value])}
              aria-label="Show only projects"
              style={{ maxWidth: 260 }}
            >
              <option value="">{pick.length ? '+ Add a project' : 'All projects — pick to narrow'}</option>
              {((projects?.items ?? []) as Json[]).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {pick.length > 0 && (
            <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
              {pick.map((p) => (
                <span key={p} className="chip">
                  {((projects?.items ?? []) as Json[]).find((x) => x.id === p)?.name ?? 'Project'}{' '}
                  <button className="link-btn" aria-label="Remove" onClick={() => setPick(pick.filter((x) => x !== p))}>
                    ✕
                  </button>
                </span>
              ))}
              <button className="link-btn small" onClick={() => setPick([])}>
                All projects
              </button>
            </div>
          )}
          {isLoading ? (
            <Spinner />
          ) : !groups.length ? (
            <Empty title="No epics yet">Add epics (and features under them) to your projects’ work items and they show up here.</Empty>
          ) : (
            <div className="roadmap" onPointerMove={(e) => drag && setDrag({ ...drag, dx: e.clientX - drag.x0 })} onPointerUp={() => {
              if (!drag) return;
              const it = ((data?.items ?? []) as Json[]).find((x) => x.id === drag.id);
              const span = live(it ?? {});
              setDrag(null);
              if (it && span && shift(drag) !== 0) void save(it, span[0], span[1]);
            }}>
              <div className="rm-head">
                <div className="rm-name" />
                <div className="rm-track" ref={track}>
                  {months.map((m) => (
                    <span key={m.t} className="rm-month" style={{ left: `${Math.max(0, pct(m.t))}%` }}>
                      {m.label}
                    </span>
                  ))}
                </div>
              </div>
              {groups.map(([pid, g]) => (
                <div key={pid} className="rm-group">
                  <div className="rm-project">
                    <Link to={`/projects/${pid}`}>{g.name}</Link>
                  </div>
                  {g.rows.map((it) => {
                    const span = live(it);
                    const left = span ? pct(span[0]) : 0;
                    const right = span ? pct(span[1] + DAY) : 0;
                    const visible = span && right > 0 && left < 100;
                    const progress = it.total ? Math.round((it.closed / it.total) * 100) : null;
                    return (
                      <div key={it.id} className="rm-row">
                        <div className="rm-name" style={{ paddingLeft: 8 + it.depth * 16 }}>
                          <button className="link-btn" onClick={() => nav(`/projects/${it.projectId}?item=${it.id}`)} title={it.name}>
                            {typeIcon(it.workType)} <span className="mono small">{it.key}</span> {it.name}
                          </button>
                        </div>
                        <div className="rm-track">
                          {months.map((m) => (
                            <span key={m.t} className="rm-grid" style={{ left: `${pct(m.t)}%` }} />
                          ))}
                          {today >= from && today <= to && <span className="rm-today" style={{ left: `${pct(today)}%` }} />}
                          {visible ? (
                            <div
                              className={`rm-bar ${it.workType} ${it.status === 'done' ? 'done' : ''} ${it.datesOwn ? '' : 'derived'}`}
                              style={{ left: `${Math.max(0, left)}%`, width: `${Math.max(0.8, Math.min(100, right) - Math.max(0, left))}%` }}
                              title={`${it.key} ${it.name}\n${date(d10(span![0]))} – ${date(d10(span![1]))}${it.datesOwn ? '' : ' (from its items)'}${progress !== null ? `\n${it.closed} of ${it.total} done` : ''}`}
                              onPointerDown={(e) => onDown(e, it, 'move')}
                            >
                              <span className="rm-handle l" onPointerDown={(e) => onDown(e, it, 'start')} />
                              {progress !== null && <span className="rm-progress" style={{ width: `${progress}%` }} />}
                              <span className="rm-label">{progress !== null ? `${progress}%` : ''}</span>
                              <span className="rm-handle r" onPointerDown={(e) => onDown(e, it, 'end')} />
                            </div>
                          ) : !span ? (
                            <button
                              className="rm-nodate"
                              onClick={() => {
                                const s = Math.max(from, Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
                                void save(it, s, s + 30 * DAY);
                              }}
                            >
                              No dates — click to plan from today
                            </button>
                          ) : (
                            <span className="rm-nodate muted">{span[1] < from ? '← earlier' : 'later →'}</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
