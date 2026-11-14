/** My week (grid + timer), approvals for project managers, and time / utilisation reports. */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { parseHours } from '../components/projects/ProjectWorkspace';
import { useApps } from '../components/ops/OrderPanel';
import { Empty, Spinner, useToast } from '../components/ui';
import { get, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date } from '../lib/format';

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const fmt = (m: number) => (m ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Tab = 'week' | 'tasks' | 'approvals' | 'reports';

export function TimesheetPage() {
  const { me } = useAuth();
  const apps = useApps();
  const [tab, setTab] = useState<Tab>(() => (['week', 'tasks', 'approvals', 'reports'].find((k) => `#${k}` === window.location.hash) as Tab) ?? 'week');
  if (!me) return null;
  if (!apps.has('projects')) return <Navigate to="/" replace />;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Timesheet</h1>
          <p>Log your hours, submit your week, approve your team's time.</p>
        </div>
        <Link className="btn" to="/o/project">
          Projects
        </Link>
      </div>
      <section className="panel">
        <div className="tabs" role="tablist">
          {(
            [
              ['week', 'My week'],
              ['tasks', 'My tasks'],
              ['approvals', 'Approvals'],
              ['reports', 'Reports'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => {
                setTab(k);
                window.history.replaceState(null, '', `#${k}`);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'week' && <Week />}
          {tab === 'tasks' && <MyTasks />}
          {tab === 'approvals' && <Approvals />}
          {tab === 'reports' && <Reports />}
        </div>
      </section>
    </>
  );
}

interface Row {
  key: string;
  projectId: string;
  taskId: string;
  cells: string[];
}

function Week() {
  const [ws, setWs] = useState(mondayOf(today()));
  const qc = useQueryClient();
  const toast = useToast();
  const { data, refetch } = useQuery({ queryKey: ['timesheet', ws], queryFn: () => get<Json>(`/api/v1/timesheet?date=${ws}`) });
  const projects = useQuery({ queryKey: ['projects', 'mine'], queryFn: () => get<Json[]>('/api/v1/projects?mine=1&status=active') });
  const timer = useQuery({ queryKey: ['timer'], queryFn: () => get<Json | null>('/api/v1/time/timer'), refetchInterval: 30_000 });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [tasksBy, setTasksBy] = useState<Record<string, Json[]>>({});
  const locked = ['submitted', 'approved'].includes(data?.timesheet?.status);
  // entries already submitted / approved / invoiced (or a running timer) are shown but not part of the grid
  const fixedEntries = (data?.entries ?? []).filter((e: Json) => !['draft', 'rejected'].includes(e.status) || e.timer_started_at);
  const initial = useMemo(() => {
    const map = new Map<string, Row>();
    for (const e of (data?.entries ?? []) as Json[]) {
      if (!['draft', 'rejected'].includes(e.status) || e.timer_started_at) continue;
      const key = `${e.project_id}|${e.task_id ?? ''}`;
      const r = map.get(key) ?? { key, projectId: e.project_id, taskId: e.task_id ?? '', cells: Array(7).fill('') };
      const i = Math.round((Date.parse(`${String(e.work_date).slice(0, 10)}T00:00:00Z`) - Date.parse(`${ws}T00:00:00Z`)) / 86_400_000);
      const prev = parseHours(r.cells[i] ?? '');
      r.cells[i] = fmt(prev + e.minutes);
      map.set(key, r);
    }
    return [...map.values()];
  }, [data, ws]);
  useEffect(() => setRows(null), [ws, data]);
  const grid = rows ?? initial;
  const loadTasks = async (pid: string) => {
    if (!pid || tasksBy[pid]) return;
    try {
      const t = await get<{ tasks: Json[] }>(`/api/v1/projects/${pid}/tasks`);
      setTasksBy((x) => ({ ...x, [pid]: t.tasks.filter((k) => !['done', 'cancelled'].includes(k.status)) }));
    } catch {
      /* not a member: general time only */
    }
  };
  useEffect(() => {
    for (const r of grid) loadTasks(r.projectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid.length]);
  const total = (i: number) => grid.reduce((s, r) => s + parseHours(r.cells[i] ?? ''), 0) + fixedEntries.filter((e: Json) => String(e.work_date).slice(0, 10) === addDays(ws, i)).reduce((s: number, e: Json) => s + e.minutes, 0);
  const weekTotal = DAYS.reduce((s, _, i) => s + total(i), 0);
  const projName = (id: string) => (projects.data ?? []).find((p) => p.id === id)?.name ?? (data?.entries ?? []).find((e: Json) => e.project_id === id)?.project ?? '—';
  const save = async () => {
    try {
      await put('/api/v1/timesheet', { date: ws, rows: grid.filter((r) => r.projectId).map((r) => ({ projectId: r.projectId, taskId: r.taskId || null, minutes: r.cells.map((c) => parseHours(c)) })) });
      toast('Week saved');
      setRows(null);
      refetch();
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  return (
    <div className="stack">
      {timer.data && (
        <div className="notice">
          <span>
            ⏱ Timer running on <b>{timer.data.project}</b>
            {timer.data.task ? ` · ${timer.data.task}` : ''} since {new Date(timer.data.timer_started_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}
          </span>
          <button
            className="btn sm primary"
            onClick={async () => {
              try {
                const r = await post<Json>('/api/v1/time/timer/stop');
                toast(`Logged ${fmt(r.minutes)}`);
                timer.refetch();
                refetch();
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            ■ Stop
          </button>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn sm" onClick={() => setWs(addDays(ws, -7))} aria-label="Previous week">
          ←
        </button>
        <b>Week of {date(ws)}</b>
        <button className="btn sm" onClick={() => setWs(addDays(ws, 7))} aria-label="Next week">
          →
        </button>
        <button className="btn sm ghost" onClick={() => setWs(mondayOf(today()))}>
          This week
        </button>
        <span className={`chip ${data?.timesheet?.status === 'approved' ? 'good' : data?.timesheet?.status === 'rejected' ? 'bad' : data?.timesheet?.status === 'submitted' ? 'info' : ''}`}>{data?.timesheet?.status ?? 'draft'}</span>
        {data?.timesheet?.reject_reason && data.timesheet.status === 'rejected' && <span className="small" style={{ color: 'var(--bad)' }}>Returned: {data.timesheet.reject_reason}</span>}
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Project</th>
                <th>Task</th>
                {DAYS.map((d, i) => (
                  <th key={d} className="num" style={addDays(ws, i) === today() ? { color: 'var(--accent-ink)' } : undefined}>
                    {d} {addDays(ws, i).slice(8)}
                  </th>
                ))}
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grid.map((r, ri) => {
                const set = (p: Partial<Row>) => setRows(grid.map((x, j) => (j === ri ? { ...x, ...p } : x)));
                return (
                  <tr key={ri}>
                    <td style={{ minWidth: 180 }}>
                      <select
                        disabled={locked}
                        value={r.projectId}
                        onChange={(e) => {
                          set({ projectId: e.target.value, taskId: '' });
                          loadTasks(e.target.value);
                        }}
                      >
                        <option value="">Choose project</option>
                        {(projects.data ?? []).map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.project_code ? `${p.project_code} · ` : ''}
                            {p.name}
                          </option>
                        ))}
                        {r.projectId && !(projects.data ?? []).some((p) => p.id === r.projectId) && <option value={r.projectId}>{projName(r.projectId)}</option>}
                      </select>
                    </td>
                    <td style={{ minWidth: 160 }}>
                      <select disabled={locked || !r.projectId} value={r.taskId} onChange={(e) => set({ taskId: e.target.value })}>
                        <option value="">General</option>
                        {(tasksBy[r.projectId] ?? []).map((t) => (
                          <option key={t.id} value={t.id}>
                            #{t.task_number} {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {r.cells.map((c, i) => (
                      <td key={i} style={{ width: 70 }}>
                        <input disabled={locked} value={c} onChange={(e) => set({ cells: r.cells.map((x, j) => (j === i ? e.target.value : x)) })} placeholder="0:00" aria-label={`${DAYS[i]} hours`} style={{ textAlign: 'right' }} />
                      </td>
                    ))}
                    <td className="num">{fmt(r.cells.reduce((s, c) => s + parseHours(c), 0))}</td>
                    <td>
                      {!locked && (
                        <button className="btn sm ghost" onClick={() => setRows(grid.filter((_, j) => j !== ri))} aria-label="Remove row">
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {fixedEntries.map((e: Json) => (
                <tr key={e.id} className="muted">
                  <td>{e.project}</td>
                  <td>{e.task ? `#${e.task_number} ${e.task}` : 'General'}</td>
                  {DAYS.map((_, i) => (
                    <td key={i} className="num">
                      {String(e.work_date).slice(0, 10) === addDays(ws, i) ? fmt(e.minutes) || (e.timer_started_at ? '⏱' : '') : ''}
                    </td>
                  ))}
                  <td className="num">{fmt(e.minutes)}</td>
                  <td className="small">{e.timer_started_at ? 'running' : e.status}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  {!locked && (
                    <button className="btn sm" onClick={() => setRows([...grid, { key: String(Math.random()), projectId: '', taskId: '', cells: Array(7).fill('') }])}>
                      Add row
                    </button>
                  )}
                </td>
                {DAYS.map((_, i) => (
                  <td key={i} className="num">
                    <b>{fmt(total(i))}</b>
                  </td>
                ))}
                <td className="num">
                  <b>{fmt(weekTotal)}</b>
                </td>
                <td className="small muted">of {data.capacityHours}h</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      {!locked && (
        <div className="row">
          <button className="btn" disabled={!rows} onClick={save}>
            Save week
          </button>
          <button
            className="btn primary"
            disabled={!weekTotal}
            onClick={async () => {
              if (rows && !(await save())) return;
              try {
                await post('/api/v1/timesheet/submit', { date: ws });
                toast('Submitted for approval');
                qc.invalidateQueries({ queryKey: ['timesheet'] });
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Submit week for approval
          </button>
        </div>
      )}
    </div>
  );
}

function MyTasks() {
  const { data } = useQuery({ queryKey: ['my-tasks'], queryFn: () => get<Json[]>('/api/v1/my-tasks') });
  if (!data) return <Spinner />;
  if (!data.length) return <Empty title="No open tasks assigned to you" />;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Task</th>
          <th>Project</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Due</th>
        </tr>
      </thead>
      <tbody>
        {data.map((t) => (
          <tr key={t.id}>
            <td>
              <Link to={`/o/project/${t.project_id}`}>
                #{t.task_number} {t.name}
              </Link>
            </td>
            <td>{t.project}</td>
            <td>{t.status.replace('_', ' ')}</td>
            <td>{t.priority}</td>
            <td style={t.due_date && String(t.due_date).slice(0, 10) < today() ? { color: 'var(--bad)' } : undefined}>{date(t.due_date)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Approvals() {
  const { data, refetch } = useQuery({ queryKey: ['timesheet', 'approvals'], queryFn: () => get<Json[]>('/api/v1/timesheet/approvals') });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const toast = useToast();
  if (!data) return <Spinner />;
  if (!data.length) return <Empty title="Nothing waiting for you">Submitted time on projects you manage appears here.</Empty>;
  const groups = new Map<string, Json[]>();
  for (const e of data) {
    const k = `${e.full_name} · week of ${String(e.week_start ?? e.work_date).slice(0, 10)}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  const decide = async (decision: 'approve' | 'reject') => {
    const reason = decision === 'reject' ? window.prompt('Why is this time being returned?') : null;
    if (decision === 'reject' && !reason?.trim()) return;
    try {
      await post('/api/v1/timesheet/decide', { entryIds: [...sel], decision, reason });
      toast(decision === 'approve' ? 'Approved' : 'Returned to the person');
      setSel(new Set());
      refetch();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <div className="stack">
      <div className="row">
        <button className="btn primary" disabled={!sel.size} onClick={() => decide('approve')}>
          Approve {sel.size || ''}
        </button>
        <button className="btn danger" disabled={!sel.size} onClick={() => decide('reject')}>
          Reject
        </button>
        <button className="btn ghost" onClick={() => setSel(new Set(data.map((e) => e.id)))}>
          Select all
        </button>
      </div>
      {[...groups].map(([k, es]) => (
        <div key={k}>
          <h3 style={{ margin: '8px 0' }}>
            {k} <span className="muted small">({fmt(es.reduce((s, e) => s + e.minutes, 0))} h)</span>
          </h3>
          <table className="data">
            <tbody>
              {es.map((e) => (
                <tr key={e.id}>
                  <td style={{ width: 30 }}>
                    <input
                      type="checkbox"
                      checked={sel.has(e.id)}
                      onChange={(ev) => {
                        const n = new Set(sel);
                        if (ev.target.checked) n.add(e.id);
                        else n.delete(e.id);
                        setSel(n);
                      }}
                      aria-label="Select"
                    />
                  </td>
                  <td>{date(e.work_date)}</td>
                  <td>{e.project}</td>
                  <td>{e.task ?? 'General'}</td>
                  <td className="small muted">{e.notes}</td>
                  <td>{e.billable ? <span className="chip info">billable</span> : ''}</td>
                  <td className="num">{fmt(e.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Reports() {
  const [q, setQ] = useState({ from: addDays(today(), -27), to: today(), groupBy: 'person' });
  const rep = useQuery({ queryKey: ['time-report', q], queryFn: () => get<Json[]>(`/api/v1/project-reports/time?from=${q.from}&to=${q.to}&groupBy=${q.groupBy}`) });
  const ut = useQuery({ queryKey: ['utilisation', q.from, q.to], queryFn: () => get<Json[]>(`/api/v1/project-reports/utilisation?from=${q.from}&to=${q.to}`), retry: false });
  const r1 = (n: number) => Math.round(n * 10) / 10;
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          From
          <input type="date" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} />
        </label>
        <label className="field">
          To
          <input type="date" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} />
        </label>
        <label className="field">
          By
          <select value={q.groupBy} onChange={(e) => setQ({ ...q, groupBy: e.target.value })}>
            <option value="person">Person</option>
            <option value="project">Project</option>
            <option value="task">Task</option>
            <option value="day">Day</option>
          </select>
        </label>
      </div>
      <h3 style={{ margin: 0 }}>Hours</h3>
      {!rep.data ? (
        <Spinner />
      ) : !rep.data.length ? (
        <Empty title="No time in this range" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>{q.groupBy}</th>
              <th className="num">Hours</th>
              <th className="num">Billable</th>
              <th className="num">Billable %</th>
              <th className="num">Awaiting approval</th>
            </tr>
          </thead>
          <tbody>
            {rep.data.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{r1(r.hours)}</td>
                <td className="num">{r1(r.billable_hours)}</td>
                <td className="num">{r.hours ? Math.round((r.billable_hours / r.hours) * 100) : 0}%</td>
                <td className="num">{r.awaiting_approval || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {ut.data && (
        <>
          <h3 style={{ margin: 0 }}>Utilisation</h3>
          <table className="data">
            <thead>
              <tr>
                <th>Person</th>
                <th className="num">Available</th>
                <th className="num">Logged</th>
                <th className="num">Utilisation</th>
                <th className="num">Billable</th>
                <th className="num">Open task estimates</th>
              </tr>
            </thead>
            <tbody>
              {ut.data.map((u) => {
                const pct = u.capacity ? Math.round((u.logged / u.capacity) * 100) : 0;
                return (
                  <tr key={u.user_id}>
                    <td>{u.full_name}</td>
                    <td className="num">{r1(u.capacity)}</td>
                    <td className="num">{r1(u.logged)}</td>
                    <td className="num">
                      <span className={`chip ${pct > 110 ? 'bad' : pct >= 70 ? 'good' : 'warn'}`}>{pct}%</span>
                    </td>
                    <td className="num">{u.logged ? Math.round((u.billable / u.logged) * 100) : 0}%</td>
                    <td className="num">{r1(u.open_estimate)}h</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
