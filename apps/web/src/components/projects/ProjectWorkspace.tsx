/** The inside of a project: overview, tasks (list / board), Gantt, milestones, issues, time, billing, team. */
import { SideTabs } from '../SideTabs';
import { ViewSignButton } from '../DocumentViewer';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { uploadFile } from '../Files';
import { del, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date, money2 } from '../../lib/format';
import { useUsers } from '../../lib/hooks';
import { BarChart } from '../charts';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { AgileTab, ChangesTab, ReleasesTab } from './Agile';
import { ProjectCalls } from './ProjectCalls';
import { MailThreadSearch, MilestoneMailList } from './MilestoneMail';
import { ProjectChats } from './ProjectChats';
import { ProjectBilling } from './ProjectBilling';
import { ProjectRules } from './IdeaStudio';
import { ProjectDocs } from './ProjectDocs';
import { CodingAgent } from './CodingAgent';
import { BoardsTab, DashboardsTab, HierarchyTab, QueriesView, TestsTab, WorkSetupTab } from './Work';
import { AutomationTab, useLiveWork } from './WorkPlus';
import { WorkItemModal } from './WorkItem';
import { MilestoneMoney } from './MilestoneMoney';

const ProjectCosts = lazy(() => import('./ProjectCosts').then((m) => ({ default: m.ProjectCosts })));
const SdlcPanel = lazy(() => import('../sdlc/Sdlc').then((m) => ({ default: m.SdlcPanel })));

type Json = Record<string, any>;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const d10 = (v: unknown) => (v ? String(v).slice(0, 10) : '');
const hrs = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, '0')}`;
export const TASK_STATUSES: [string, string][] = [['open', 'Open'], ['in_progress', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done'], ['cancelled', 'Cancelled']];
const PRIORITY: Record<string, string> = { urgent: 'bad', high: 'warn', medium: 'info', low: '', none: '' };
const STATUS_CLS: Record<string, string> = { open: '', in_progress: 'info', review: 'warn', blocked: 'bad', done: 'good', cancelled: '' };

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

const COMMISSION_ON: [string, string][] = [
  ['invoiced', 'invoiced'],
  ['collected', 'collected'],
  ['gross_profit', 'gross profit'],
  ['net_profit', 'net profit'],
  ['profit_after_all', 'profit after all expenses'],
];
const COMMISSION_HELP: Record<string, string> = {
  invoiced: 'Revenue invoiced on the project, before GST',
  collected: 'The part of the invoiced revenue received',
  gross_profit: 'Invoiced − direct costs (vendor bills and expenses on the project)',
  net_profit: 'Gross profit − team cost (time at cost, day / month pay, fixed pay)',
  profit_after_all: 'Collected − direct costs − team cost − commissions on invoiced / collected',
};

type Tab = 'overview' | 'docs' | 'tasks' | 'boards' | 'agile' | 'hierarchy' | 'queries' | 'releases' | 'changes' | 'gantt' | 'milestones' | 'calls' | 'whatsapp' | 'agent' | 'delivery' | 'issues' | 'tests' | 'dashboards' | 'time' | 'billing' | 'costs' | 'team' | 'worksetup' | 'automation' | 'rules';

const PROJECT_ICON: Record<string, string> = { docs: 'folder', boards: 'board', hierarchy: 'layers', queries: 'search', tests: 'check', dashboards: 'chart', worksetup: 'gear', automation: 'repeat', overview: 'gauge', tasks: 'check', agile: 'repeat', releases: 'layers', changes: 'contract', gantt: 'board', milestones: 'target', calls: 'video', whatsapp: 'inbox', agent: 'spark', delivery: 'layers', rules: 'contract', issues: 'ticket', time: 'clock', billing: 'rupee', costs: 'wallet', team: 'users' };

export function ProjectWorkspace({ id }: { id: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['project', id], queryFn: () => get<Json>(`/api/v1/projects/${id}`) });
  const [tab, setTab] = useState<Tab>('overview');
  const [params, setParams] = useSearchParams();
  const item = params.get('item');
  // boards, backlog and items follow other people's changes without a refresh
  useLiveWork(id);
  const openItem = (x: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (x) n.set('item', x);
        else n.delete('item');
        return n;
      },
      { preventScrollReset: true },
    );
  if (isLoading) return <Spinner />;
  if (error || !data) return null;
  const manage = data.level === 'manage';
  const member = manage || data.level === 'member';
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'], ['tasks', 'Tasks'], ['boards', 'Boards'], ['agile', 'Backlog & sprints'], ['hierarchy', 'Epics & hierarchy'], ['queries', 'Queries'], ['releases', 'Releases'], ['gantt', 'Gantt'],
    ['docs', 'Client documents'], ['milestones', 'Milestones'], ['changes', 'Changes & portal'], ['calls', 'Calls'], ['whatsapp', 'WhatsApp'], ['delivery', 'AI delivery'], ['rules', 'Rules for the AI'], ['agent', 'Coding agent'], ['issues', 'Issues'], ['tests', 'Test plans'], ['dashboards', 'Dashboards'], ['time', 'Time'],
    ...(manage ? ([['billing', 'Billing']] as [Tab, string][]) : []), ['costs', 'Costs & expenses'], ['team', 'Team'], ['automation', 'Automation'], ['worksetup', 'Work setup'],
  ];
  const GROUP: Record<string, string> = { overview: 'Work', tasks: 'Work', boards: 'Work', agile: 'Work', hierarchy: 'Work', queries: 'Work', releases: 'Work', gantt: 'Work', docs: 'Delivery', milestones: 'Delivery', changes: 'Delivery', calls: 'Delivery', whatsapp: 'Delivery', agent: 'Delivery', delivery: 'Delivery', rules: 'Delivery', issues: 'Delivery', tests: 'Delivery', dashboards: 'Insights', time: 'People & money', billing: 'People & money', costs: 'People & money', team: 'People & money', automation: 'Settings', worksetup: 'Settings' };
  return (
    <div style={{ marginBottom: 20 }}>
    <RepoBanner id={id} manage={manage} status={data.project.status} onOpen={() => setTab('worksetup')} />
    <SideTabs
      id="project"
      title="Project"
      value={tab}
      onChange={setTab}
      items={tabs.map(([k, l]) => ({ key: k, label: l, icon: PROJECT_ICON[k], group: GROUP[k] }))}
    >
      <div className="panel-body">
        {tab === 'overview' && <Overview id={id} data={data} />}
        {tab === 'tasks' && <Tasks id={id} data={data} member={member} manage={manage} />}
        {tab === 'agile' && <AgileTab id={id} manage={manage} member={member} />}
        {tab === 'releases' && <ReleasesTab id={id} manage={manage} />}
        {tab === 'changes' && <ChangesTab id={id} data={data} manage={manage} member={member} />}
        {tab === 'gantt' && <Gantt id={id} data={data} member={member} />}
        {tab === 'milestones' && <Milestones id={id} data={data} manage={manage} />}
        {tab === 'calls' && <ProjectCalls id={id} />}
        {tab === 'whatsapp' && <ProjectChats id={id} />}
        {tab === 'docs' && <ProjectDocs projectId={id} />}
        {tab === 'agent' && <CodingAgent id={id} manage={manage} />}
        {tab === 'rules' && <ProjectRules id={id} />}
        {tab === 'delivery' && (
          <Suspense fallback={<Spinner />}>
            <SdlcPanel projectId={id} />
          </Suspense>
        )}
        {tab === 'boards' && <BoardsTab id={id} manage={manage} member={member} onOpen={openItem} />}
        {tab === 'hierarchy' && <HierarchyTab id={id} member={member} onOpen={openItem} />}
        {tab === 'queries' && <QueriesView projectId={id} member={member} />}
        {tab === 'tests' && <TestsTab id={id} member={member} onOpen={openItem} />}
        {tab === 'dashboards' && <DashboardsTab id={id} onOpen={openItem} />}
        {tab === 'worksetup' && <WorkSetupTab id={id} manage={manage} />}
        {tab === 'automation' && <AutomationTab id={id} manage={manage} />}
        {tab === 'issues' && <Issues id={id} data={data} member={member} />}
        {tab === 'time' && <ProjectTime id={id} data={data} member={member} />}
        {tab === 'billing' && manage && <ProjectBilling id={id} unbilled={<Billing id={id} />} />}
        {tab === 'costs' && (
          <Suspense fallback={<Spinner />}>
            <ProjectCosts id={id} manage={manage} />
          </Suspense>
        )}
        {tab === 'team' && <Team id={id} data={data} manage={manage} />}
      </div>
    </SideTabs>
    {item && /^[0-9a-f-]{36}$/i.test(item) && <WorkItemModal projectId={id} id={item} onClose={() => openItem(null)} onOpen={openItem} />}
    </div>
  );
}

/** Every project should be linked to its code repository. */
function RepoBanner({ id, manage, status, onOpen }: { id: string; manage: boolean; status: string; onOpen: () => void }) {
  const { data } = useQuery({ queryKey: ['work', id, 'repos'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/repos`), staleTime: 60_000 });
  if (!data || data.repos.length || ['completed', 'cancelled'].includes(status)) return null;
  return (
    <div className="callout warn small row" style={{ justifyContent: 'space-between', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
      <span>
        <strong>No code repository linked.</strong> Link the GitHub or Azure DevOps repository so every commit and pull request is tied to a work item of this project.
      </span>
      {manage && (
        <button className="btn small" onClick={onOpen}>
          Link repository
        </button>
      )}
    </div>
  );
}

/* ───────────────────────── overview ───────────────────────── */

function Overview({ id, data }: { id: string; data: Json }) {
  const { data: s } = useQuery({ queryKey: ['project', id, 'summary'], queryFn: () => get<Json>(`/api/v1/projects/${id}/summary`) });
  const nav = useNavigate();
  const toast = useToast();
  if (!s) return <Spinner />;
  const t = s.tasks as Record<string, number>;
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  const chart = { categories: (s.weekly as Json[]).map((w) => w.week.slice(5)), series: [{ label: 'Hours', values: (s.weekly as Json[]).map((w) => Number(w.hours)) }, { label: 'Billable', values: (s.weekly as Json[]).map((w) => Number(w.billable ?? 0)) }] };
  return (
    <div className="stack">
      <div className="kpis" style={{ margin: 0 }}>
        <Kpi
          l="Progress"
          v={`${Math.round(s.progress)}%`}
          sub={s.milestones?.total ? `${s.milestones.done} of ${s.milestones.total} milestones done · ${t.done ?? 0} of ${total} tasks` : `${t.done ?? 0} of ${total} tasks done (add milestones to track delivery)`}
        />
        <Kpi l="Overdue tasks" v={String(s.overdueTasks)} tone={s.overdueTasks ? 'bad' : undefined} sub={`${s.issues?.open ?? 0} open issues (${s.issues?.critical ?? 0} critical)`} />
        <Kpi l="Hours logged" v={String(s.hours.logged)} sub={`${s.hours.billable} billable · ${s.hours.estimated} estimated`} />
        {s.budget && <Kpi l={`Budget (${s.budget.type})`} v={s.budget.pct != null ? `${s.budget.pct}%` : '—'} tone={s.budget.pct > 100 ? 'bad' : undefined} sub={`${s.budget.type === 'hours' ? s.budget.used : money2(s.budget.used)} of ${s.budget.type === 'hours' ? s.budget.planned : money2(s.budget.planned)}`} />}
        {s.schedule && <Kpi l="Days left" v={String(s.schedule.daysLeft)} tone={s.schedule.daysLeft < 0 ? 'bad' : undefined} sub={`Ends ${date(s.schedule.endDate)}`} />}
      </div>
      {s.money && data.project.project_kind === 'in_house' && (
        <div className="kpis" style={{ margin: 0 }}>
          <Kpi l="Spent on it" v={money2(s.money.cost)} sub={`Team ${money2(s.money.labourCost)} · expenses ${money2(s.money.expenses)} · bills ${money2(s.money.bills)}`} />
        </div>
      )}
      {s.money && data.project.project_kind !== 'in_house' && (
        <div className="kpis" style={{ margin: 0 }}>
          <Kpi
            l="Invoiced"
            v={money2(s.money.revenue)}
            sub={[s.money.milestonesUninvoiced ? `${money2(s.money.milestonesUninvoiced)} of milestones done, not invoiced` : null, s.money.unbilled ? `${money2(s.money.unbilled)} of time approved, not billed` : null].filter(Boolean).join(' · ') || 'Before GST; invoices of the project and its milestones'}
          />
          <Kpi l="Cost" v={money2(s.money.cost)} sub={`Labour ${money2(s.money.labourCost)}${s.money.fixedPay ? ` (fixed pay ${money2(s.money.fixedPay)})` : ''}${s.money.commission ? ` (commission ${money2(s.money.commission)})` : ''} · expenses ${money2(s.money.expenses)} · bills ${money2(s.money.bills)}`} />
          <Kpi l="Profit" v={money2(s.money.profit)} tone={s.money.profit < 0 ? 'bad' : 'good'} sub={s.money.margin != null ? `Margin ${s.money.margin}%` : undefined} />
        </div>
      )}
      {data.project.description && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{data.project.description}</p>}
      <div className="panel" style={{ padding: 14 }}>
        <h3 style={{ marginTop: 0 }}>Hours by week</h3>
        {chart.categories.length ? <BarChart data={chart} stacked={false} fmt={(n) => `${Math.round(n)}h`} /> : <p className="muted">No time logged yet.</p>}
      </div>
      {data.level === 'manage' && (
        <div>
          <button
            className="btn"
            onClick={async () => {
              const name = window.prompt('Name of the new project (tasks, lists, milestones and dependencies are copied)', `${data.project.title} (copy)`);
              if (!name) return;
              const start = window.prompt('Start date of the new project (YYYY-MM-DD); dates shift to match', today()) || null;
              try {
                const r = await post<{ id: string }>(`/api/v1/projects/${id}/duplicate`, { name, startDate: start });
                nav(`/projects/${r.id}`);
              } catch (e) {
                toast((e as Error).message, true);
              }
            }}
          >
            Use as template
          </button>
        </div>
      )}
    </div>
  );
}

function Kpi({ l, v, sub, tone }: { l: string; v: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="panel kpi">
      <div className="l">{l}</div>
      <div className={`v${tone ? ` tone-${tone}` : ''}`}>{v}</div>
      {sub && <div className="small muted">{sub}</div>}
    </div>
  );
}

/* ───────────────────────── tasks ───────────────────────── */

function useTasks(id: string) {
  return useQuery({ queryKey: ['project', id, 'tasks'], queryFn: () => get<{ tasks: Json[]; deps: Json[]; total?: number; truncated?: boolean }>(`/api/v1/projects/${id}/tasks`) });
}

function people(data: Json) {
  const m = new Map<string, string>();
  for (const x of data.members as Json[]) if (x.role !== 'viewer') m.set(x.user_id, x.full_name);
  if (data.project.owner_id && data.project.manager) m.set(data.project.owner_id, data.project.manager);
  // HRP AI can take a plain task too — it is the default assignee unless changed
  if (data.agent?.id) m.set(data.agent.id, `🤖 ${data.agent.name}`);
  return m;
}

function Tasks({ id, data, member, manage }: { id: string; data: Json; member: boolean; manage: boolean }) {
  const { data: t } = useTasks(id);
  const { me } = useAuth();
  const [view, setView] = useState<'list' | 'board'>('list');
  const [filter, setFilter] = useState({ mine: false, status: 'open_all' });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['project', id]]);
  const who = people(data);
  if (!t) return <Spinner />;
  const tasks = t.tasks.filter((x) => (!filter.mine || (x.assignees as string[]).includes(me!.user.id)) && (filter.status === 'all' || (filter.status === 'open_all' ? !['done', 'cancelled'].includes(x.status) : x.status === filter.status)));
  const top = tasks.filter((x) => !x.parent_id);
  const subs = (pid: string) => tasks.filter((x) => x.parent_id === pid);
  const lists: Json[] = [...data.lists, { id: null, name: 'No list' }];
  const row = (x: Json, sub = false) => (
    <tr key={x.id} id={`task-${x.id}`} className="click" onClick={() => setEdit(x)}>
      <td style={{ paddingLeft: sub ? 32 : 12 }} onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          disabled={!member}
          checked={x.status === 'done'}
          onChange={(e) => act(() => patch(`/api/v1/projects/${id}/tasks/${x.id}`, { status: e.target.checked ? 'done' : 'open' }))}
          aria-label="Done"
        />
      </td>
      <td style={{ whiteSpace: 'normal' }}>
        <span className="muted small">#{x.task_number}</span> <span style={x.status === 'done' ? { textDecoration: 'line-through', color: 'var(--ink-3)' } : undefined}>{x.name}</span>
        {x.comments > 0 && <span className="muted small"> · 💬 {x.comments}</span>}
      </td>
      <td>{(x.assignees as string[]).map((a) => who.get(a) ?? '—').join(', ')}</td>
      <td>
        <span className={`chip ${STATUS_CLS[x.status]}`}>{x.status.replace('_', ' ')}</span>
      </td>
      <td>{x.priority !== 'none' && <span className={`chip ${PRIORITY[x.priority]}`}>{x.priority}</span>}</td>
      <td style={x.due_date && d10(x.due_date) < today() && !['done', 'cancelled'].includes(x.status) ? { color: 'var(--bad)' } : undefined}>{date(x.due_date)}</td>
      <td className="num">
        {x.logged_hours ? `${Math.round(x.logged_hours * 10) / 10}h` : ''}
        {x.estimate_hours ? ` / ${x.estimate_hours}h` : ''}
      </td>
    </tr>
  );
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap' }}>
        {member && (
          <button className="btn primary" onClick={() => setEdit({})}>
            New task
          </button>
        )}
        {member && (
          <button
            className="btn"
            onClick={async () => {
              const name = window.prompt('Name of the task list');
              if (name) await act(() => post(`/api/v1/projects/${id}/lists`, { name }), 'List added');
            }}
          >
            New list
          </button>
        )}
        <div className="row" role="group">
          <button className={`btn sm${view === 'list' ? ' primary' : ' ghost'}`} onClick={() => setView('list')}>
            List
          </button>
          <button className={`btn sm${view === 'board' ? ' primary' : ' ghost'}`} onClick={() => setView('board')}>
            Board
          </button>
        </div>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })} style={{ width: 'auto' }}>
          <option value="open_all">Not done</option>
          <option value="all">All</option>
          {TASK_STATUSES.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <label className="row small">
          <input type="checkbox" checked={filter.mine} onChange={(e) => setFilter({ ...filter, mine: e.target.checked })} /> Mine
        </label>
      </div>
      {t.truncated && <div className="callout small">This project has {Number(t.total).toLocaleString()} items — the {t.tasks.length.toLocaleString()} open and recently closed ones are listed here. Use Queries or the backlog for the rest.</div>}
      {view === 'list' ? (
        !t.tasks.length ? (
          <Empty title="No tasks yet">Break the work into lists and tasks; give them dates to see them on the Gantt chart.</Empty>
        ) : (
          lists.map((l) => {
            const xs = top.filter((x) => (x.list_id ?? null) === l.id);
            if (!xs.length && l.id === null) return null;
            return (
              <div key={l.id ?? 'none'}>
                <div className="spread">
                  <h3 style={{ margin: '8px 0' }}>{l.name}</h3>
                  {l.id && manage && (
                    <button className="btn sm ghost" onClick={() => window.confirm(`Delete the list "${l.name}"? Its tasks stay, without a list.`) && act(() => del(`/api/v1/projects/${id}/lists/${l.id}`), 'List deleted')}>
                      Delete list
                    </button>
                  )}
                </div>
                <table className="data">
                  <tbody>{xs.flatMap((x) => [row(x), ...subs(x.id).map((s) => row(s, true))])}</tbody>
                </table>
              </div>
            );
          })
        )
      ) : (
        <Board id={id} tasks={top} who={who} member={member} onOpen={setEdit} />
      )}
      {edit && <TaskModal id={id} data={data} task={edit} tasks={t.tasks} deps={t.deps} member={member} manage={manage} onClose={() => setEdit(null)} />}
    </div>
  );
}

function Board({ id, tasks, who, member, onOpen }: { id: string; tasks: Json[]; who: Map<string, string>; member: boolean; onOpen: (t: Json) => void }) {
  const act = useAct([['project', id]]);
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${TASK_STATUSES.length - 1}, minmax(200px, 1fr))`, gap: 10, overflowX: 'auto' }}>
      {TASK_STATUSES.filter(([k]) => k !== 'cancelled').map(([k, l]) => (
        <div
          key={k}
          className="panel"
          style={{ padding: 8, minHeight: 200, background: '#f7fafb' }}
          onDragOver={(e) => member && e.preventDefault()}
          onDrop={() => {
            if (drag && member) act(() => patch(`/api/v1/projects/${id}/tasks/${drag}`, { status: k }));
            setDrag(null);
          }}
        >
          <div className="spread small" style={{ marginBottom: 6 }}>
            <b>{l}</b>
            <span className="muted">{tasks.filter((t) => t.status === k).length}</span>
          </div>
          {tasks
            .filter((t) => t.status === k)
            .map((t) => (
              <div key={t.id} className="panel" draggable={member} onDragStart={() => setDrag(t.id)} onClick={() => onOpen(t)} style={{ padding: 8, marginBottom: 6, cursor: 'pointer' }}>
                <div className="small muted">#{t.task_number}</div>
                <div>{t.name}</div>
                <div className="row small" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {t.priority !== 'none' && <span className={`chip ${PRIORITY[t.priority]}`}>{t.priority}</span>}
                  {t.due_date && <span className="muted">{date(t.due_date)}</span>}
                  <span className="muted">{(t.assignees as string[]).map((a) => who.get(a)?.split(' ')[0] ?? '').join(', ')}</span>
                </div>
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

function TaskModal({ id, data, task, tasks, deps, member, manage, onClose }: { id: string; data: Json; task: Json; tasks: Json[]; deps: Json[]; member: boolean; manage: boolean; onClose: () => void }) {
  const act = useAct([['project', id]]);
  const who = people(data);
  const isNew = !task.id;
  const [f, setF] = useState<Json>({
    name: task.name ?? '',
    description: task.description ?? '',
    listId: task.list_id ?? '',
    milestoneId: task.milestone_id ?? '',
    parentId: task.parent_id ?? '',
    status: task.status ?? 'open',
    priority: task.priority ?? 'medium',
    assignees: task.assignees ?? [],
    startDate: d10(task.start_date),
    dueDate: d10(task.due_date),
    estimateHours: task.estimate_hours ?? '',
    billable: task.billable ?? true,
    rate: task.rate ?? '',
  });
  const comments = useQuery({ queryKey: ['project', id, 'comments', task.id], queryFn: () => get<Json[]>(`/api/v1/projects/${id}/tasks/${task.id}/comments`), enabled: !isNew });
  const [comment, setComment] = useState('');
  const [dep, setDep] = useState('');
  const mine = deps.filter((d) => d.task_id === task.id);
  const save = async () => {
    const body: Json = {
      name: f.name,
      description: f.description || null,
      listId: f.listId || null,
      milestoneId: f.milestoneId || null,
      parentId: f.parentId || null,
      status: f.status,
      priority: f.priority,
      assignees: f.assignees,
      startDate: f.startDate || null,
      dueDate: f.dueDate || null,
      estimateHours: f.estimateHours === '' ? null : Number(f.estimateHours),
      billable: f.billable,
      ...(manage ? { rate: f.rate === '' ? null : Number(f.rate) } : {}),
    };
    const r = isNew ? await act(() => post(`/api/v1/projects/${id}/tasks`, body), 'Task added') : await act(() => patch(`/api/v1/projects/${id}/tasks/${task.id}`, body), 'Saved');
    if (r) onClose();
  };
  return (
    <Modal
      title={isNew ? 'New task' : `#${task.task_number} ${task.name}`}
      onClose={onClose}
      wide
      footer={
        member ? (
          <>
            {!isNew && (
              <button className="btn danger" onClick={async () => window.confirm('Delete this task and its sub-tasks?') && (await act(() => del(`/api/v1/projects/${id}/tasks/${task.id}`), 'Deleted')) && onClose()}>
                Delete
              </button>
            )}
            <button className="btn primary" disabled={!f.name.trim()} onClick={save}>
              Save
            </button>
          </>
        ) : undefined
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field wide">
            Task
            <input value={f.name} disabled={!member} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </label>
          <label className="field">
            Status
            <select value={f.status} disabled={!member} onChange={(e) => setF({ ...f, status: e.target.value })}>
              {TASK_STATUSES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Priority
            <select value={f.priority} disabled={!member} onChange={(e) => setF({ ...f, priority: e.target.value })}>
              {['urgent', 'high', 'medium', 'low', 'none'].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Start
            <input type="date" disabled={!member} value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
          </label>
          <label className="field">
            Due
            <input type="date" disabled={!member} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          </label>
          <label className="field">
            List
            <select value={f.listId} disabled={!member} onChange={(e) => setF({ ...f, listId: e.target.value })}>
              <option value="">No list</option>
              {(data.lists as Json[]).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Milestone
            <select value={f.milestoneId} disabled={!member} onChange={(e) => setF({ ...f, milestoneId: e.target.value })}>
              <option value="">None</option>
              {(data.milestones as Json[]).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Sub-task of
            <select value={f.parentId} disabled={!member} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
              <option value="">—</option>
              {tasks
                .filter((x) => !x.parent_id && x.id !== task.id)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    #{x.task_number} {x.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            Estimate (hours)
            <input inputMode="decimal" disabled={!member} value={f.estimateHours} onChange={(e) => setF({ ...f, estimateHours: e.target.value })} />
          </label>
          {manage && (
            <label className="field">
              Rate per hour (task-rate billing)
              <input inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            </label>
          )}
          <label className="row field">
            <input type="checkbox" disabled={!member} checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable
          </label>
          <div className="field wide">
            Assigned to
            <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
              {[...who].map(([uid, name]) => (
                <label key={uid} className="row small" style={{ fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    disabled={!member}
                    checked={(f.assignees as string[]).includes(uid)}
                    onChange={(e) => setF({ ...f, assignees: e.target.checked ? [...f.assignees, uid] : (f.assignees as string[]).filter((a) => a !== uid) })}
                  />
                  {name}
                </label>
              ))}
            </div>
          </div>
          <label className="field wide">
            Description
            <textarea rows={4} disabled={!member} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </label>
        </div>
        {!isNew && (
          <>
            <div>
              <b>Waits for</b>
              {mine.map((d) => {
                const pre = tasks.find((x) => x.id === d.depends_on_id);
                return (
                  <div key={d.depends_on_id} className="row small">
                    <span>
                      #{pre?.task_number} {pre?.name} ({d.kind.toUpperCase()}
                      {d.lag_days ? `, ${d.lag_days > 0 ? '+' : ''}${d.lag_days}d` : ''})
                    </span>
                    {member && (
                      <button className="btn sm ghost" onClick={() => act(() => del(`/api/v1/projects/${id}/tasks/${task.id}/deps/${d.depends_on_id}`))}>
                        Remove
                      </button>
                    )}
                  </div>
                );
              })}
              {member && (
                <div className="row" style={{ marginTop: 6 }}>
                  <select value={dep} onChange={(e) => setDep(e.target.value)} style={{ maxWidth: 320 }}>
                    <option value="">Add a task this one waits for…</option>
                    {tasks
                      .filter((x) => x.id !== task.id && !mine.some((d) => d.depends_on_id === x.id))
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          #{x.task_number} {x.name}
                        </option>
                      ))}
                  </select>
                  <button className="btn sm" disabled={!dep} onClick={async () => (await act(() => post(`/api/v1/projects/${id}/tasks/${task.id}/deps`, { dependsOnId: dep }), 'Dependency added')) && setDep('')}>
                    Add (finish → start)
                  </button>
                </div>
              )}
            </div>
            <div>
              <b>Comments</b>
              {(comments.data ?? []).map((c) => (
                <div key={c.id} className="small" style={{ margin: '6px 0' }}>
                  <b>{c.full_name}</b> <span className="muted">{date(c.created_at)}</span>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                </div>
              ))}
              {member && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment" />
                  <button
                    className="btn sm"
                    disabled={!comment.trim()}
                    onClick={async () => {
                      if (await act(() => post(`/api/v1/projects/${id}/tasks/${task.id}/comments`, { body: comment.trim() }))) {
                        setComment('');
                        comments.refetch();
                      }
                    }}
                  >
                    Post
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── gantt ───────────────────────── */

function Gantt({ id, data, member }: { id: string; data: Json; member: boolean }) {
  const { data: t } = useTasks(id);
  const [open, setOpen] = useState<Json | null>(null);
  const [zoom, setZoom] = useState(18);
  const rows = useMemo(() => (t?.tasks ?? []).filter((x) => x.start_date || x.due_date).sort((a, b) => (d10(a.start_date || a.due_date) < d10(b.start_date || b.due_date) ? -1 : 1)), [t]);
  if (!t) return <Spinner />;
  const ms = (data.milestones as Json[]).filter((m) => m.due_date);
  const dates = [...rows.flatMap((r) => [d10(r.start_date || r.due_date), d10(r.due_date || r.start_date)]), ...ms.map((m) => d10(m.due_date)), today()];
  if (!rows.length) return <Empty title="Nothing to chart">Give tasks start and due dates to see them here.</Empty>;
  const min = addDays(dates.reduce((a, b) => (a < b ? a : b)), -2);
  const max = addDays(dates.reduce((a, b) => (a > b ? a : b)), 3);
  const days = Math.round((Date.parse(`${max}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / 86_400_000) + 1;
  const x = (d: string) => (Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${min}T00:00:00Z`)) / 86_400_000)) * zoom;
  const ROW = 28;
  const LABEL = 240;
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const width = days * zoom;
  const height = (rows.length + 1) * ROW + 10;
  return (
    <div className="stack">
      <div className="row">
        <span className="small muted">Zoom</span>
        {[10, 18, 30].map((z) => (
          <button key={z} className={`btn sm${zoom === z ? ' primary' : ' ghost'}`} onClick={() => setZoom(z)}>
            {z === 10 ? 'Months' : z === 18 ? 'Weeks' : 'Days'}
          </button>
        ))}
        <span className="small muted">Moving a task's dates pushes the tasks that wait for it.</span>
      </div>
      <div style={{ display: 'flex', overflowX: 'auto', border: '1px solid var(--line)', borderRadius: 8 }}>
        <div style={{ minWidth: LABEL, borderRight: '1px solid var(--line)' }}>
          <div style={{ height: ROW, borderBottom: '1px solid var(--line)' }} />
          {rows.map((r) => (
            <div key={r.id} className="small" style={{ height: ROW, lineHeight: `${ROW}px`, padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' }} onClick={() => setOpen(r)}>
              <span className="muted">#{r.task_number}</span> {r.parent_id ? '↳ ' : ''}
              {r.name}
            </div>
          ))}
        </div>
        <svg width={width} height={height} role="img" aria-label="Gantt chart" style={{ display: 'block', flex: 'none' }}>
          {Array.from({ length: days }, (_, i) => {
            const d = addDays(min, i);
            const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
            return (
              <g key={d}>
                {(dow === 0 || dow === 6) && <rect x={i * zoom} y={ROW} width={zoom} height={height - ROW} fill="#f4f6f8" />}
                {(dow === 1 || zoom >= 30) && (
                  <text x={i * zoom + 2} y={18} fontSize="10" fill="#7b8796">
                    {d.slice(8)}/{d.slice(5, 7)}
                  </text>
                )}
              </g>
            );
          })}
          <line x1={x(today()) + zoom / 2} x2={x(today()) + zoom / 2} y1={ROW} y2={height} stroke="#dc2626" strokeDasharray="3 3" />
          {t.deps.map((d, i) => {
            const a = index.get(d.depends_on_id);
            const b = index.get(d.task_id);
            if (a === undefined || b === undefined) return null;
            const pa = rows[a]!;
            const pb = rows[b]!;
            const x1 = x(d10(pa.due_date || pa.start_date)) + zoom;
            const y1 = ROW + a * ROW + ROW / 2;
            const x2 = x(d10(pb.start_date || pb.due_date));
            const y2 = ROW + b * ROW + ROW / 2;
            return <path key={i} d={`M${x1},${y1} h6 V${y2} H${x2}`} fill="none" stroke="#94a3b8" markerEnd="url(#arrow)" />;
          })}
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8" />
            </marker>
          </defs>
          {rows.map((r, i) => {
            const s = d10(r.start_date || r.due_date);
            const e = d10(r.due_date || r.start_date);
            const w = Math.max(zoom, x(e) - x(s) + zoom);
            const late = e < today() && !['done', 'cancelled'].includes(r.status);
            const color = r.status === 'done' ? '#059669' : late ? '#dc2626' : '#0f8dde';
            return (
              <g key={r.id} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                <rect x={x(s)} y={ROW + i * ROW + 6} width={w} height={ROW - 12} rx={4} fill={color} opacity={0.25} />
                <rect x={x(s)} y={ROW + i * ROW + 6} width={(w * (r.status === 'done' ? 100 : r.progress)) / 100} height={ROW - 12} rx={4} fill={color} />
                <title>{`#${r.task_number} ${r.name}: ${s} → ${e}${r.progress ? ` (${r.progress}%)` : ''}`}</title>
              </g>
            );
          })}
          {ms.map((m) => {
            const mx = x(d10(m.due_date)) + zoom / 2;
            return (
              <g key={m.id}>
                <line x1={mx} x2={mx} y1={ROW} y2={height} stroke="#075492" strokeOpacity={0.3} />
                <path d={`M${mx},${ROW - 2} l6,-6 l-6,-6 l-6,6 z`} fill="#075492">
                  <title>{`Milestone: ${m.name} (${d10(m.due_date)})`}</title>
                </path>
              </g>
            );
          })}
        </svg>
      </div>
      {open && t && <TaskModal id={id} data={data} task={open} tasks={t.tasks} deps={t.deps} member={member} manage={data.level === 'manage'} onClose={() => setOpen(null)} />}
    </div>
  );
}

/* ───────────────────────── milestones ───────────────────────── */

function Milestones({ id, data, manage }: { id: string; data: Json; manage: boolean }) {
  const act = useAct([['project', id]]);
  const [edit, setEdit] = useState<Json | null>(null);
  return (
    <div className="stack">
      {manage && (
        <div>
          <button className="btn primary" onClick={() => setEdit({})}>
            New milestone
          </button>
        </div>
      )}
      {!data.milestones.length ? (
        <Empty title="No milestones">Phases such as design sign-off, site handover or go-live. Give them an amount to bill fixed-price work by milestone.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Milestone</th>
              <th>Start</th>
              <th>Due</th>
              <th>Tasks</th>
              <th className="num">Amount</th>
              <th>Accepted</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data.milestones as Json[]).map((m) => (
              <tr key={m.id} className={manage ? 'click' : undefined} onClick={() => manage && setEdit(m)}>
                <td>{m.name}</td>
                <td>{date(m.start_date)}</td>
                <td>{date(m.due_date)}</td>
                <td>
                  {m.done}/{m.tasks}
                </td>
                <td className="num">{m.amount ? money2(m.amount) : ''}</td>
                <td className="small">
                  {m.accepted_on ? date(m.accepted_on) : ''}
                  {m.acceptance_ref ? <div className="muted">{m.acceptance_ref}</div> : null}
                </td>
                <td>
                  <span className={`chip ${m.status === 'done' ? 'good' : m.status === 'in_progress' ? 'info' : ''}`}>{m.status === 'in_progress' ? 'in progress' : m.status}</span> {m.invoice_id && <span className="chip info">invoiced</span>}
                  {m.status === 'done' && (m.approval_file_id || m.approval_activity_id) ? <span className="chip good" title="Customer approval on record">✓ approved</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <MilestoneModal
          projectId={id}
          m={edit}
          who={people(data)}
          onClose={() => setEdit(null)}
          onSave={async (body, remove) => {
            const r = remove
              ? await act(() => del(`/api/v1/projects/${id}/milestones/${edit.id}`), 'Deleted')
              : edit.id
                ? await act(() => put(`/api/v1/projects/${id}/milestones/${edit.id}`, body), 'Saved')
                : await act(() => post(`/api/v1/projects/${id}/milestones`, body), 'Milestone added');
            if (r) setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function MilestoneModal({ m, who, onClose, onSave, projectId }: { m: Json; who: Map<string, string>; onClose: () => void; onSave: (b: Json, remove?: boolean) => void; projectId: string }) {
  const [f, setF] = useState({
    name: m.name ?? '', startDate: d10(m.start_date), dueDate: d10(m.due_date), amount: m.amount ?? '', ownerId: m.owner_id ?? '', status: m.status ?? 'open',
    acceptedOn: d10(m.accepted_on), acceptanceRef: m.acceptance_ref ?? '', approvalFileId: m.approval_file_id ?? '', approvalActivityId: m.approval_activity_id ?? '', approvalNote: m.approval_note ?? '',
  });
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['milestone', m.id], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/milestones/${m.id}`), enabled: !!m.id });
  const files = useQuery({ queryKey: ['files', 'project', projectId], queryFn: () => get<{ items: Json[] }>(`/api/v1/files?object=project&id=${projectId}`) });
  const [mails, setMails] = useState<{ scan: boolean; q: string } | null>(null);
  const [thread, setThread] = useState(false);
  const [reading, setReading] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const det = detail.data?.milestone;
  const hasProof = !!(f.approvalFileId || f.approvalActivityId);
  const closing = f.status === 'done' && m.status !== 'done';
  const fileName = (files.data?.items ?? []).find((x) => x.id === f.approvalFileId)?.name ?? det?.approval_file_name;
  return (
    <Modal
      title={m.id ? m.name : 'New milestone'}
      wide
      onClose={onClose}
      footer={
        <>
          {m.id && !m.invoice_id && (
            <button className="btn danger" onClick={() => window.confirm('Delete this milestone?') && onSave({}, true)}>
              Delete
            </button>
          )}
          <button
            className="btn primary"
            disabled={!f.name.trim() || (closing && !hasProof)}
            title={closing && !hasProof ? "Attach the customer's approval letter or link their email first" : undefined}
            onClick={() =>
              onSave({
                name: f.name.trim(), startDate: f.startDate || null, dueDate: f.dueDate || null, amount: f.amount === '' ? null : Number(f.amount), ownerId: f.ownerId || null, status: f.status,
                acceptedOn: f.acceptedOn || null, acceptanceRef: f.acceptanceRef.trim() || null,
                approvalFileId: f.approvalFileId || null, approvalActivityId: f.approvalActivityId || null, approvalNote: f.approvalNote.trim() || null,
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          Start
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </label>
        <label className="field">
          Due
          <input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </label>
        <label className="field">
          Amount to bill (₹, optional)
          <input inputMode="decimal" disabled={!!m.invoice_id} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Owner
          <select value={f.ownerId} onChange={(e) => setF({ ...f, ownerId: e.target.value })}>
            <option value="">—</option>
            {[...who].map(([uid, n]) => (
              <option key={uid} value={uid}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <div className="field wide">
          Status
          <div className="row" style={{ gap: 6 }}>
            {[
              ['open', 'Open'],
              ['in_progress', 'In progress'],
              ['done', 'Done (customer approved)'],
            ].map(([k, l]) => (
              <button key={k} type="button" className={`btn sm${f.status === k ? ' primary' : ''}`} onClick={() => setF({ ...f, status: k! })}>
                {l}
              </button>
            ))}
          </div>
        </div>

        <div className="wide panel" style={{ padding: 10, borderColor: closing && !hasProof ? 'var(--warn)' : undefined }}>
          <div className="spread">
            <b>Customer's approval</b>
            {hasProof ? <span className="chip good">on record</span> : <span className="chip warn">needed to mark done</span>}
          </div>
          <p className="small muted" style={{ margin: '4px 0 8px' }}>
            Attach their approval letter / completion certificate, or link the email in which they approved it.
          </p>
          <div className="grid2">
            <div className="field">
              Approval letter
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <select value={f.approvalFileId} onChange={(e) => setF({ ...f, approvalFileId: e.target.value })} style={{ minWidth: 0 }}>
                  <option value="">— none —</option>
                  {(files.data?.items ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <label className="btn sm">
                  {busy ? 'Uploading…' : 'Upload'}
                  <input
                    type="file"
                    hidden
                    accept="application/pdf,image/*,.docx,.eml,.msg"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      setBusy(true);
                      try {
                        const up = await uploadFile('project', projectId, file, 'proof', `Approval — ${f.name}`);
                        qc.invalidateQueries({ queryKey: ['files', 'project', projectId] });
                        setF((x) => ({ ...x, approvalFileId: up.id }));
                        toast('Approval letter attached');
                      } catch (err) {
                        toast((err as Error).message, true);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </label>
              </div>
              {fileName && f.approvalFileId && <ViewSignButton fileId={f.approvalFileId} name={fileName} label={`📄 ${fileName} — view`} className="link-btn small" />}
            </div>
            <div className="field">
              Approval email
              {f.approvalActivityId ? (
                <div className="row small" style={{ gap: 6 }}>
                  <span>✉️ {mailSubject(f.approvalActivityId, det)}</span>
                  <button type="button" className="btn sm ghost" onClick={() => setReading({ id: f.approvalActivityId, fromDetail: true })}>
                    Read
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => setF({ ...f, approvalActivityId: '' })}>
                    Unlink
                  </button>
                </div>
              ) : (
                <div className="row" style={{ gap: 6 }}>
                  <button type="button" className="btn sm primary" onClick={() => setMails({ scan: true, q: '' })}>
                    Scan emails for approvals
                  </button>
                  <button type="button" className="btn sm" onClick={() => setMails({ scan: false, q: '' })}>
                    Browse emails
                  </button>
                  {m.id && (
                    <button type="button" className="btn sm" title="Search every mailbox, any date, and keep the whole thread with its attachments on this milestone" onClick={() => setThread(true)}>
                      Find the mail thread
                    </button>
                  )}
                </div>
              )}
            </div>
            {m.id && <MilestoneMailList projectId={projectId} milestoneId={m.id} />}
            <label className="field">
              Accepted by the customer on
              <input type="date" value={f.acceptedOn} onChange={(e) => setF({ ...f, acceptedOn: e.target.value })} />
            </label>
            <label className="field">
              Acceptance ref. (CRAC / inspection / completion certificate)
              <input value={f.acceptanceRef} maxLength={100} onChange={(e) => setF({ ...f, acceptanceRef: e.target.value })} placeholder="e.g. GeM CRAC number" />
            </label>
            <label className="field wide">
              Note
              <input value={f.approvalNote} maxLength={2000} onChange={(e) => setF({ ...f, approvalNote: e.target.value })} placeholder="Who approved, any conditions…" />
            </label>
          </div>
          {det?.approved_at && (
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              Closed by {det.approved_by_name ?? '—'} on {date(det.approved_at)}.
            </p>
          )}
        </div>
        {m.id && m.status === 'done' && <MilestoneLinks projectId={projectId} milestoneId={m.id} links={detail.data?.links ?? []} />}
        <p className="small muted wide" style={{ margin: 0 }}>
          The acceptance reference and date are printed under the milestone line on its invoice.
        </p>
      </div>
      {mails && (
        <ApprovalMailPicker
          projectId={projectId}
          milestoneId={m.id ?? null}
          scan={mails.scan}
          onClose={() => setMails(null)}
          onRead={(x) => setReading(x)}
          onPick={(x) => {
            setF((v) => ({ ...v, approvalActivityId: x.id, acceptedOn: v.acceptedOn || String(x.occurred_at).slice(0, 10) }));
            pickedMails.set(x.id, x.subject ?? '(no subject)');
            setMails(null);
          }}
        />
      )}
      {reading && <ReadMail mail={reading} projectId={projectId} onClose={() => setReading(null)} />}
      {thread && m.id && (
        <MailThreadSearch
          projectId={projectId}
          milestoneId={m.id}
          initial={m.name ?? ''}
          onClose={() => setThread(false)}
          onApproval={(x) => {
            setF((v) => ({ ...v, approvalActivityId: x.id, acceptedOn: v.acceptedOn || String(x.date ?? '').slice(0, 10) }));
            pickedMails.set(x.id, x.subject || '(no subject)');
          }}
        />
      )}
    </Modal>
  );
}

const pickedMails = new Map<string, string>();
const mailSubject = (id: string, det: Json | undefined) => pickedMails.get(id) ?? (det?.approval_activity_id === id ? det.approval_email_subject : null) ?? 'Linked email';

function ApprovalMailPicker({ projectId, milestoneId, scan: scan0, onClose, onPick, onRead }: { projectId: string; milestoneId: string | null; scan: boolean; onClose: () => void; onPick: (x: Json) => void; onRead: (x: Json) => void }) {
  const [scan, setScan] = useState(scan0);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const { data, isFetching } = useQuery({
    queryKey: ['approval-emails', projectId, milestoneId, scan, term],
    queryFn: () => get<{ items: Json[]; mailboxConnected: boolean }>(`/api/v1/projects/${projectId}/approval-emails?scan=${scan ? 1 : 0}${milestoneId ? `&milestone=${milestoneId}` : ''}${term ? `&q=${encodeURIComponent(term)}` : ''}`),
  });
  return (
    <Modal title={scan ? 'Emails that look like an approval' : "The customer's emails"} wide onClose={onClose}>
      <div className="modal-body stack">
        <div className="row" style={{ gap: 6 }}>
          <input placeholder="Search subject and text…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setTerm(q.trim())} />
          <button className="btn sm" onClick={() => setTerm(q.trim())}>
            Search
          </button>
          <label className="check-row" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={scan} onChange={(e) => setScan(e.target.checked)} /> Only approvals
          </label>
        </div>
        {data && !data.mailboxConnected && <p className="notice small">Connect your Gmail or Outlook (Settings → Integrations) so customer emails sync here automatically. Emails logged by hand also appear.</p>}
        {data && <p className="small muted" style={{ margin: 0 }}>Only emails already on the timeline are listed here. Not finding it? Close this and use <b>Find the mail thread</b>: it searches every mailbox, any date, and keeps the whole thread with its attachments.</p>}
        {isFetching && !data ? <Spinner /> : null}
        {data && !data.items.length && <p className="muted small">No {scan ? 'approval-looking ' : ''}emails from this customer yet.</p>}
        {(data?.items ?? []).map((x) => (
          <div key={x.id} className="panel" style={{ padding: 10 }}>
            <div className="spread" style={{ gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <b>{x.subject ?? '(no subject)'}</b> {x.looksLikeApproval && <span className="chip good">looks like approval</span>}
                <div className="muted small">
                  {x.direction === 'in' ? 'From the customer' : 'Sent by us'}
                  {x.from ? ` · ${x.from}` : ''} · {date(x.occurred_at)}
                </div>
                <div className="small" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {String(x.body ?? '').slice(0, 300)}
                </div>
              </div>
              <div className="row" style={{ gap: 4, flexShrink: 0 }}>
                <button className="btn sm" onClick={() => onRead(x)}>
                  Read
                </button>
                <button className="btn sm primary" onClick={() => onPick(x)}>
                  Use as approval
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ReadMail({ mail, projectId, onClose }: { mail: Json; projectId: string; onClose: () => void }) {
  // a linked email is read back from the milestone's project emails
  const { data } = useQuery({
    queryKey: ['approval-emails', projectId, 'all'],
    queryFn: () => get<{ items: Json[] }>(`/api/v1/projects/${projectId}/approval-emails?scan=0`),
    enabled: !mail.body,
  });
  const m = mail.body ? mail : (data?.items ?? []).find((x) => x.id === mail.id);
  return (
    <Modal title={m?.subject ?? 'Email'} wide onClose={onClose}>
      <div className="modal-body">
        {!m ? (
          <Spinner />
        ) : (
          <>
            <div className="muted small" style={{ marginBottom: 8 }}>
              {m.direction === 'in' ? 'From the customer' : 'Sent by us'}
              {m.from ? ` · ${m.from}` : ''} · {date(m.occurred_at)}
            </div>
            <div className="pre-wrap" style={{ maxHeight: '60vh', overflow: 'auto' }}>
              {m.body ?? ''}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const LINK_KINDS: [string, string, string][] = [
  ['invoice', 'Invoices', 'invoice'],
  ['payment', 'Receipts', 'payment'],
  ['bill', 'Vendor bills', 'bill'],
  ['vendor_payment', 'Vendor payments', 'vendor_payment'],
];

function MilestoneLinks({ projectId, milestoneId, links }: { projectId: string; milestoneId: string; links: Json[] }) {
  const [kind, setKind] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const cand = useQuery({ queryKey: ['ms-cand', projectId, kind], queryFn: () => get<{ items: Json[] }>(`/api/v1/projects/${projectId}/milestone-candidates?kind=${kind}`), enabled: !!kind });
  const link = async (k: string, targetId: string, on: boolean) => {
    try {
      await put(`/api/v1/projects/${projectId}/milestones/${milestoneId}/links`, { kind: k, targetId, on });
      qc.invalidateQueries({ queryKey: ['milestone', milestoneId] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const linked = new Set(links.map((l) => `${l.kind}:${l.id}`));
  return (
    <div className="wide panel" style={{ padding: 10 }}>
      <div className="spread">
        <b>Invoices and payments for this milestone</b>
        <div className="row" style={{ gap: 4 }}>
          {LINK_KINDS.map(([k, l]) => (
            <button key={k} type="button" className={`btn sm${kind === k ? ' primary' : ''}`} onClick={() => setKind(kind === k ? null : k)}>
              + {l}
            </button>
          ))}
        </div>
      </div>
      {links.length > 0 ? (
        <table className="data" style={{ marginTop: 6 }}>
          <tbody>
            {links.map((l) => (
              <tr key={`${l.kind}:${l.id}`}>
                <td>{LINK_KINDS.find((x) => x[0] === l.kind)?.[1].replace(/s$/, '')}</td>
                <td>
                  <Link to={`/o/${l.kind}/${l.id}`}>{l.number ?? 'Draft'}</Link>
                </td>
                <td>{date(l.date)}</td>
                <td className="num">{money2(l.amount)}</td>
                <td>{l.status}</td>
                <td>
                  <button type="button" className="btn sm ghost" onClick={() => link(l.kind, l.id, false)}>
                    Unlink
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Nothing linked yet.
        </p>
      )}
      {kind && (
        <div style={{ marginTop: 8, maxHeight: 220, overflow: 'auto' }}>
          {(cand.data?.items ?? []).filter((x) => !linked.has(`${kind}:${x.id}`)).map((x) => (
            <div key={x.id} className="spread small" style={{ padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span>
                {x.number ?? 'Draft'} · {date(x.date)} · {money2(x.amount)} · {x.status}
              </span>
              <button type="button" className="btn sm" onClick={() => link(kind, x.id, true)}>
                Link
              </button>
            </div>
          ))}
          {cand.data && !cand.data.items.length && <p className="muted small">None found for this project or customer.</p>}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── issues ───────────────────────── */

const SEV: Record<string, string> = { minor: '', major: 'warn', critical: 'bad', blocker: 'bad' };

function Issues({ id, data, member }: { id: string; data: Json; member: boolean }) {
  const { data: list } = useQuery({ queryKey: ['project', id, 'issues'], queryFn: () => get<Json[]>(`/api/v1/projects/${id}/issues`) });
  const [edit, setEdit] = useState<Json | null>(null);
  const act = useAct([['project', id]]);
  const who = people(data);
  if (!list) return <Spinner />;
  return (
    <div className="stack">
      {member && (
        <div>
          <button className="btn primary" onClick={() => setEdit({})}>
            Report an issue
          </button>
        </div>
      )}
      {!list.length ? (
        <Empty title="No issues">Snags, defects and bugs found on the job, with severity and an owner.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Issue</th>
              <th>Severity</th>
              <th>Status</th>
              <th>Assigned</th>
              <th>Reported by</th>
              <th>Due</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => (
              <tr key={i.id} className="click" onClick={() => setEdit(i)}>
                <td>{i.issue_number}</td>
                <td style={{ whiteSpace: 'normal' }}>{i.title}</td>
                <td>
                  <span className={`chip ${SEV[i.severity]}`}>{i.severity}</span>
                </td>
                <td>{i.status.replace('_', ' ')}</td>
                <td>{i.assignee ?? '—'}</td>
                <td>{i.reporter}</td>
                <td>{date(i.due_date)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && (
        <IssueModal
          issue={edit}
          who={who}
          member={member}
          projectId={id}
          onClose={() => setEdit(null)}
          onSave={async (body) => {
            const r = edit.id ? await act(() => patch(`/api/v1/projects/${id}/issues/${edit.id}`, body), 'Saved') : await act(() => post(`/api/v1/projects/${id}/issues`, body), 'Issue reported');
            if (r) setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function IssueModal({ issue, who, member, projectId, onClose, onSave }: { issue: Json; who: Map<string, string>; member: boolean; projectId: string; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({ title: issue.title ?? '', description: issue.description ?? '', severity: issue.severity ?? 'major', status: issue.status ?? 'open', assigneeId: issue.assignee_id ?? '', dueDate: d10(issue.due_date) });
  const comments = useQuery({ queryKey: ['project', projectId, 'issue-comments', issue.id], queryFn: () => get<Json[]>(`/api/v1/projects/${projectId}/issues/${issue.id}/comments`), enabled: !!issue.id });
  const [c, setC] = useState('');
  const toast = useToast();
  return (
    <Modal
      title={issue.id ? `Issue #${issue.issue_number}` : 'Report an issue'}
      onClose={onClose}
      wide
      footer={
        member ? (
          <button className="btn primary" disabled={!f.title.trim()} onClick={() => onSave({ title: f.title.trim(), description: f.description || null, severity: f.severity, ...(issue.id ? { status: f.status } : {}), assigneeId: f.assigneeId || null, dueDate: f.dueDate || null })}>
            Save
          </button>
        ) : undefined
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field wide">
            Title
            <input value={f.title} disabled={!member} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />
          </label>
          <label className="field">
            Severity
            <select value={f.severity} disabled={!member} onChange={(e) => setF({ ...f, severity: e.target.value })}>
              {['minor', 'major', 'critical', 'blocker'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {issue.id && (
            <label className="field">
              Status
              <select value={f.status} disabled={!member} onChange={(e) => setF({ ...f, status: e.target.value })}>
                {['open', 'in_progress', 'fixed', 'closed', 'reopened', 'wont_fix'].map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            Assigned to
            <select value={f.assigneeId} disabled={!member} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}>
              <option value="">—</option>
              {[...who].map(([uid, n]) => (
                <option key={uid} value={uid}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Due
            <input type="date" disabled={!member} value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          </label>
          <label className="field wide">
            Details
            <textarea rows={4} disabled={!member} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
          </label>
        </div>
        {issue.id && (
          <div>
            <b>Comments</b>
            {(comments.data ?? []).map((x) => (
              <div key={x.id} className="small" style={{ margin: '6px 0' }}>
                <b>{x.full_name}</b> <span className="muted">{date(x.created_at)}</span>
                <div style={{ whiteSpace: 'pre-wrap' }}>{x.body}</div>
              </div>
            ))}
            {member && (
              <div className="row">
                <input value={c} onChange={(e) => setC(e.target.value)} placeholder="Write a comment" />
                <button
                  className="btn sm"
                  disabled={!c.trim()}
                  onClick={async () => {
                    try {
                      await post(`/api/v1/projects/${projectId}/issues/${issue.id}/comments`, { body: c.trim() });
                      setC('');
                      comments.refetch();
                    } catch (e) {
                      toast((e as Error).message, true);
                    }
                  }}
                >
                  Post
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── time ───────────────────────── */

function ProjectTime({ id, data, member }: { id: string; data: Json; member: boolean }) {
  const [from, setFrom] = useState(addDays(today(), -30));
  const [to, setTo] = useState(today());
  const [view, setView] = useState<'entries' | 'person' | 'task' | 'day'>(() => {
    try {
      return (localStorage.getItem('synapse.project.timeView') as 'entries') || 'entries';
    } catch {
      return 'entries';
    }
  });
  const [who, setWho] = useState('');
  const pickView = (v: typeof view) => {
    setView(v);
    try {
      localStorage.setItem('synapse.project.timeView', v);
    } catch {
      /* ignore */
    }
  };
  const { data: rep } = useQuery({
    queryKey: ['project', id, 'time', from, to, view, who],
    enabled: view !== 'entries',
    queryFn: () => get<Json[]>(`/api/v1/project-reports/time?projectId=${id}&from=${from}&to=${to}&groupBy=${view}${who ? `&userId=${who}` : ''}`),
  });
  const { data: entries } = useQuery({
    queryKey: ['project', id, 'time-entries', from, to, who],
    enabled: view === 'entries',
    queryFn: () => get<Json[]>(`/api/v1/projects/${id}/time-entries?from=${from}&to=${to}${who ? `&userId=${who}` : ''}`),
  });
  const [editEntry, setEditEntry] = useState<Json | null>(null);
  const team = people(data);
  const { data: t } = useTasks(id);
  const act = useAct([['project', id], ['timesheet']]);
  const [f, setF] = useState({ date: today(), hours: '', taskId: '', notes: '', billable: data.project.billing_method !== 'non_billable' && data.project.billing_method !== 'fixed_price' });
  return (
    <div className="stack">
      {member && ['active', 'planning'].includes(data.project.status) && (
        <div className="panel" style={{ padding: 12 }}>
          <b>Log time</b>
          <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 6 }}>
            <label className="field">
              Date
              <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            </label>
            <label className="field">
              Hours (e.g. 1.5 or 1:30)
              <input value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} style={{ width: 120 }} />
            </label>
            <label className="field">
              Task
              <select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })}>
                <option value="">General</option>
                {(t?.tasks ?? [])
                  .filter((x) => !['done', 'cancelled'].includes(x.status))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      #{x.task_number} {x.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="field" style={{ minWidth: 220 }}>
              Notes
              <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
            </label>
            <label className="row small">
              <input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable
            </label>
            <button
              className="btn primary"
              disabled={!parseHours(f.hours)}
              onClick={async () => (await act(() => post('/api/v1/time', { projectId: id, taskId: f.taskId || null, date: f.date, minutes: parseHours(f.hours), notes: f.notes || null, billable: f.billable }), 'Time logged')) && setF({ ...f, hours: '', notes: '' })}
            >
              Log
            </button>
            <button className="btn" onClick={() => act(() => post('/api/v1/time/timer/start', { projectId: id, taskId: f.taskId || null, notes: f.notes || null }), 'Timer started')}>
              ▶ Start timer
            </button>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            Submit your week for approval on the <a href="/timesheet">Timesheet</a> page.
          </p>
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end', gap: 10 }}>
        <div className="field">
          View
          <div className="seg" role="radiogroup" aria-label="Time view">
            {(
              [
                ['entries', 'Detailed'],
                ['person', 'By person'],
                ['task', 'By task'],
                ['day', 'By day'],
              ] as const
            ).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={view === k} className={view === k ? 'on' : ''} onClick={() => pickView(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <label className="field">
          From
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          To
          <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </label>
        {team.size > 1 && (
          <label className="field">
            Person
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Everyone</option>
              {[...team].map(([uid, name]) => (
                <option key={uid} value={uid}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {view === 'entries' ? (
        !entries ? (
          <Spinner />
        ) : !entries.length ? (
          <Empty title="No time in this range" />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Date</th>
                <th>Person</th>
                <th>Task</th>
                <th>Notes</th>
                <th className="num">Hours</th>
                <th>Billable</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={e.canEdit ? 'click' : ''} onClick={() => e.canEdit && setEditEntry(e)} title={e.canEdit ? 'Edit' : ''}>
                  <td className="nowrap">{date(e.work_date)}</td>
                  <td>{e.person}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.task ?? <span className="muted">General</span>}</td>
                  <td style={{ whiteSpace: 'normal' }}>{e.notes ?? ''}</td>
                  <td className="num">{e.timer_started_at ? <span className="chip info">running</span> : hrs(e.minutes)}</td>
                  <td>{e.billable ? 'Yes' : <span className="muted">No</span>}</td>
                  <td>
                    <span className={`chip ${e.status === 'approved' || e.status === 'invoiced' ? 'good' : e.status === 'submitted' ? 'info' : e.status === 'rejected' ? 'bad' : ''}`}>{e.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={4}>
                  <strong>Total</strong> · {entries.length} entr{entries.length === 1 ? 'y' : 'ies'}
                </td>
                <td className="num">
                  <strong>{hrs(entries.reduce((n, e) => n + e.minutes, 0))}</strong>
                </td>
                <td colSpan={2} className="muted small">
                  billable {hrs(entries.filter((e) => e.billable).reduce((n, e) => n + e.minutes, 0))}
                </td>
              </tr>
            </tfoot>
          </table>
        )
      ) : !rep ? (
        <Spinner />
      ) : !rep.length ? (
        <Empty title="No time in this range" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>{view === 'person' ? 'Person' : view === 'task' ? 'Task' : 'Day'}</th>
              <th className="num">Hours</th>
              <th className="num">Billable</th>
              <th className="num">Awaiting approval</th>
            </tr>
          </thead>
          <tbody>
            {rep.map((r) => (
              <tr key={r.label}>
                <td>{view === 'day' ? date(r.label) : r.label}</td>
                <td className="num">{Math.round(r.hours * 100) / 100}</td>
                <td className="num">{Math.round(r.billable_hours * 100) / 100}</td>
                <td className="num">{r.awaiting_approval || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editEntry && <TimeEntryModal entry={editEntry} tasks={t?.tasks ?? []} onClose={() => setEditEntry(null)} act={act} />}
    </div>
  );
}

function TimeEntryModal({ entry, tasks, onClose, act }: { entry: Json; tasks: Json[]; onClose: () => void; act: ReturnType<typeof useAct> }) {
  const [f, setF] = useState({ date: entry.work_date as string, hours: hrs(entry.minutes), taskId: (entry.task_id as string) ?? '', notes: (entry.notes as string) ?? '', billable: !!entry.billable });
  return (
    <Modal
      title={`Time · ${entry.person}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn danger" onClick={async () => window.confirm('Delete this entry?') && (await act(() => del(`/api/v1/time/${entry.id}`), 'Deleted')) && onClose()}>
            Delete
          </button>
          <button
            className="btn primary"
            disabled={!parseHours(f.hours)}
            onClick={async () => (await act(() => patch(`/api/v1/time/${entry.id}`, { date: f.date, minutes: parseHours(f.hours), taskId: f.taskId || null, notes: f.notes || null, billable: f.billable }), 'Saved')) && onClose()}
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Hours
          <input value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
        </label>
        <label className="field wide">
          Task
          <select value={f.taskId} onChange={(e) => setF({ ...f, taskId: e.target.value })}>
            <option value="">General</option>
            {tasks.map((x) => (
              <option key={x.id} value={x.id}>
                #{x.task_number} {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          Notes
          <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label className="row small">
          <input type="checkbox" checked={f.billable} onChange={(e) => setF({ ...f, billable: e.target.checked })} /> Billable
        </label>
      </div>
    </Modal>
  );
}

export function parseHours(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : Math.round(Number(t.replace(',', '.')) * 60);
  return Number.isFinite(minutes) && minutes > 0 && minutes <= 1440 ? minutes : 0;
}

/* ───────────────────────── billing ───────────────────────── */

function Billing({ id }: { id: string }) {
  const { data, refetch } = useQuery({ queryKey: ['project', id, 'unbilled'], queryFn: () => get<Json>(`/api/v1/projects/${id}/unbilled`) });
  const [sel, setSel] = useState<{ t: Set<string>; e: Set<string>; m: Set<string> } | null>(null);
  const [groupBy, setGroupBy] = useState('task');
  const [fixed, setFixed] = useState('');
  const [money, setMoney] = useState<string | null>(null);
  const nav = useNavigate();
  const toast = useToast();
  if (!data) return <Spinner />;
  const s = sel ?? { t: new Set((data.time as Json[]).map((x) => x.id)), e: new Set((data.expenses as Json[]).map((x) => x.id)), m: new Set<string>() };
  const flip = (k: 't' | 'e' | 'm', v: string) => {
    const n = { t: new Set(s.t), e: new Set(s.e), m: new Set(s.m) };
    if (n[k].has(v)) n[k].delete(v);
    else n[k].add(v);
    setSel(n);
  };
  const total =
    (data.time as Json[]).filter((x) => s.t.has(x.id)).reduce((a, x) => a + x.amount, 0) +
    (data.expenses as Json[]).filter((x) => s.e.has(x.id)).reduce((a, x) => a + x.amount, 0) +
    (data.milestones as Json[]).filter((x) => s.m.has(x.id)).reduce((a, x) => a + x.amount, 0) +
    (Number(fixed) || 0);
  return (
    <div className="stack">
      <div className="row small" style={{ gap: 16, flexWrap: 'wrap' }}>
        <span>
          Billing: <b>{String(data.project.billing_method).replace(/_/g, ' ')}</b>
        </span>
        {data.project.fixed_fee > 0 && <span>Fixed fee {money2(data.project.fixed_fee)}</span>}
        <span>Invoiced so far {money2(data.invoicedToDate)}</span>
      </div>
      {!data.project.account_id && <div className="notice">Set the project's customer before invoicing.</div>}
      <h3 style={{ margin: 0 }}>Approved time not yet billed</h3>
      {!data.time.length ? (
        <p className="muted small">None. Time is billable once its timesheet is approved.</p>
      ) : (
        <table className="data">
          <tbody>
            {(data.time as Json[]).map((x) => (
              <tr key={x.id}>
                <td style={{ width: 30 }}>
                  <input type="checkbox" checked={s.t.has(x.id)} onChange={() => flip('t', x.id)} aria-label="Include" />
                </td>
                <td>{date(x.work_date)}</td>
                <td>{x.full_name}</td>
                <td>{x.task ? `#${x.task_number} ${x.task}` : 'General'}</td>
                <td className="small muted">{x.notes}</td>
                <td className="num">{hrs(x.minutes)}</td>
                <td className="num">{money2(x.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data.expenses.length > 0 && (
        <>
          <h3 style={{ margin: 0 }}>Billable expenses</h3>
          <table className="data">
            <tbody>
              {(data.expenses as Json[]).map((x) => (
                <tr key={x.id}>
                  <td style={{ width: 30 }}>
                    <input type="checkbox" checked={s.e.has(x.id)} onChange={() => flip('e', x.id)} aria-label="Include" />
                  </td>
                  <td>{date(x.expense_date)}</td>
                  <td>{x.name}</td>
                  <td className="num">{money2(x.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data.milestones.length > 0 && (
        <>
          <h3 style={{ margin: 0 }}>Milestones</h3>
          <table className="data">
            <tbody>
              {(data.milestones as Json[]).map((x) => (
                <tr key={x.id}>
                  <td style={{ width: 30 }}>
                    <input type="checkbox" checked={s.m.has(x.id)} onChange={() => flip('m', x.id)} aria-label="Include" />
                  </td>
                  <td>
                    {x.name}
                    {(x.acceptance_ref || x.accepted_on) && <div className="small muted">Accepted {x.acceptance_ref ?? ''} {x.accepted_on ? date(x.accepted_on) : ''}</div>}
                  </td>
                  <td>{x.status === 'done' ? <span className="chip good">done</span> : <span className="chip">open</span>}</td>
                  <td className="num">{money2(x.amount)}</td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" title="Invoiced already (here or elsewhere)? Find the invoice and its payments" onClick={() => setMoney(x.id)}>
                      Already invoiced?
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {(data.invoicedMilestones as Json[] | undefined)?.length ? (
        <>
          <h3 style={{ margin: 0 }}>Invoiced milestones</h3>
          <table className="data">
            <tbody>
              {(data.invoicedMilestones as Json[]).map((x) => (
                <tr key={x.id}>
                  <td>{x.name}</td>
                  <td className="small">Invoice {x.invoice_number ?? '(draft)'}</td>
                  <td>{x.balance_due > 0 ? <span className="chip warn">{money2(x.balance_due)} due</span> : <span className="chip good">paid</span>}</td>
                  <td className="num">{money2(x.grand_total)}</td>
                  <td style={{ width: 1, whiteSpace: 'nowrap' }}>
                    <button className="btn sm ghost" onClick={() => setMoney(x.id)}>
                      Payments
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {money && <MilestoneMoney projectId={id} milestoneId={money} onClose={() => (setMoney(null), refetch())} />}
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="field">
          Time lines
          <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            <option value="task">One line per task</option>
            <option value="person">One line per person</option>
            <option value="project">One line for all</option>
            <option value="entry">One line per entry</option>
          </select>
        </label>
        <label className="field">
          Plus a fixed amount (₹)
          <input inputMode="decimal" value={fixed} onChange={(e) => setFixed(e.target.value)} placeholder="e.g. 30% advance" />
        </label>
        <button
          className="btn primary"
          disabled={!total || !data.project.account_id}
          onClick={async () => {
            try {
              const r = await post<{ id: string }>(`/api/v1/projects/${id}/invoice`, { entryIds: [...s.t], expenseIds: [...s.e], milestoneIds: [...s.m], groupBy, fixedAmount: Number(fixed) || null });
              toast('Draft invoice created');
              refetch();
              nav(`/o/invoice/${r.id}`);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Create draft invoice ({money2(total)} + GST)
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── team ───────────────────────── */

function Team({ id, data, manage }: { id: string; data: Json; manage: boolean }) {
  const { data: users } = useUsers();
  const act = useAct([['project', id]]);
  const [rows, setRows] = useState<Json[] | null>(null);
  const list =
    rows ??
    (data.members as Json[]).map((m) => ({
      userId: m.user_id,
      role: m.role,
      billRate: m.bill_rate ?? '',
      costRate: m.cost_rate ?? '',
      payBasis: m.pay_basis ?? 'hourly',
      payAmount: m.pay_amount ?? '',
      commissionPct: m.commission_pct ?? '',
      commissionOn: m.commission_on ?? 'invoiced',
    }));
  const set = (i: number, p: Json) => setRows(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v));
  const payload = (l: Json[]) => ({
    members: l.map((m) => ({
      userId: m.userId,
      role: m.role,
      billRate: num(m.billRate),
      costRate: num(m.costRate),
      payBasis: m.payBasis ?? 'hourly',
      payAmount: num(m.payAmount),
      commissionPct: num(m.commissionPct),
      commissionOn: m.commissionOn ?? 'invoiced',
    })),
  });
  const blank = { billRate: '', costRate: '', payBasis: 'hourly', payAmount: '', commissionPct: '', commissionOn: 'invoiced' };
  const [add, setAdd] = useState('');
  const [invite, setInvite] = useState(false);
  const nameOf = (u: string) => users?.items.find((x) => x.id === u)?.full_name ?? (data.members as Json[]).find((m) => m.user_id === u)?.full_name ?? '—';
  return (
    <div className="stack">
      <p className="small muted" style={{ margin: 0 }}>
        Project manager: <b>{data.project.manager ?? '—'}</b> (the record owner). Managers plan the work and approve time; members work on tasks and log time; viewers only look.
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            {manage && <th className="num" title="What the customer is charged per hour (projects billed by staff rate)">Bill rate / h</th>}
            {manage && <th title="How this person is paid for the project: it decides the project's labour cost">Paid by</th>}
            {manage && <th>Pay</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((m, i) => (
            <tr key={m.userId}>
              <td>{nameOf(m.userId)}</td>
              <td>
                <select disabled={!manage} value={m.role} onChange={(e) => setRows(list.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))} style={{ width: 'auto' }}>
                  <option value="manager">Manager</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              </td>
              {manage && (
                <td style={{ width: 130 }}>
                  <input inputMode="decimal" value={m.billRate} onChange={(e) => setRows(list.map((x, j) => (j === i ? { ...x, billRate: e.target.value } : x)))} />
                </td>
              )}
              {manage && (
                <td style={{ width: 150 }}>
                  <select value={m.payBasis} onChange={(e) => set(i, { payBasis: e.target.value })} aria-label="Paid by">
                    <option value="hourly">Hourly rate</option>
                    <option value="daily">Day rate</option>
                    <option value="monthly">Monthly salary</option>
                    <option value="fixed">Fixed for the project</option>
                    <option value="commission">Commission</option>
                    <option value="none">Not paid here</option>
                  </select>
                </td>
              )}
              {manage && (
                <td style={{ minWidth: 220 }}>
                  {m.payBasis === 'hourly' && (
                    <div className="row" style={{ gap: 4 }}>
                      <span className="muted small">₹</span>
                      <input inputMode="decimal" value={m.costRate} onChange={(e) => set(i, { costRate: e.target.value })} aria-label="Cost per hour" style={{ width: 110 }} />
                      <span className="muted small">/ hour</span>
                    </div>
                  )}
                  {(m.payBasis === 'daily' || m.payBasis === 'monthly' || m.payBasis === 'fixed') && (
                    <div className="row" style={{ gap: 4 }}>
                      <span className="muted small">₹</span>
                      <input inputMode="decimal" value={m.payAmount} onChange={(e) => set(i, { payAmount: e.target.value })} aria-label="Amount" style={{ width: 120 }} />
                      <span className="muted small">{m.payBasis === 'daily' ? '/ day' : m.payBasis === 'monthly' ? '/ month' : 'for the project'}</span>
                    </div>
                  )}
                  {m.payBasis === 'commission' && (
                    <div className="row" style={{ gap: 4 }}>
                      <input inputMode="decimal" value={m.commissionPct} onChange={(e) => set(i, { commissionPct: e.target.value })} aria-label="Commission %" style={{ width: 70 }} />
                      <span className="muted small">% of</span>
                      <select value={m.commissionOn} onChange={(e) => set(i, { commissionOn: e.target.value })} aria-label="Commission on" style={{ width: 'auto' }}>
                        {COMMISSION_ON.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                            {data.economics ? ` (${money2(data.economics.bases[k] ?? 0)})` : ''}
                          </option>
                        ))}
                      </select>
                      {(() => {
                        const cur = (data.members as Json[]).find((x) => x.user_id === m.userId)?.commission_now as Json | null | undefined;
                        const base = data.economics?.bases?.[m.commissionOn] ?? null;
                        const pct = Number(m.commissionPct);
                        const amount = base != null && pct > 0 ? Math.round(Math.max(0, base) * pct) / 100 : cur?.amount ?? null;
                        return amount != null ? (
                          <span className="small" title={COMMISSION_HELP[m.commissionOn]}>
                            = <b>{money2(amount)}</b> so far
                          </span>
                        ) : null;
                      })()}
                    </div>
                  )}
                  {m.payBasis === 'none' && <span className="muted small">No cost on this project</span>}
                </td>
              )}
              <td>
                {manage && (
                  <button className="btn sm ghost" onClick={() => setRows(list.filter((_, j) => j !== i))}>
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manage && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <select
            value={add}
            onChange={(e) => {
              if (e.target.value === '__new') setInvite(true);
              else setAdd(e.target.value);
            }}
            style={{ maxWidth: 280 }}
          >
            <option value="">Add a person…</option>
            <option value="__new">+ Someone new (invite them)…</option>
            {(users?.items ?? [])
              .filter((u) => !list.some((m) => m.userId === u.id))
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name}
                </option>
              ))}
          </select>
          <button className="btn sm" disabled={!add} onClick={() => (setRows([...list, { userId: add, role: 'member', ...blank }]), setAdd(''))}>
            Add
          </button>
          <button
            className="btn primary"
            disabled={!rows}
            onClick={async () =>
              (await act(
                () => put(`/api/v1/projects/${id}/members`, payload(list)),
                'Team saved',
              )) && setRows(null)
            }
          >
            Save team
          </button>
        </div>
      )}
      {invite && (
        <InvitePerson
          onClose={() => setInvite(false)}
          onInvited={async (userId) => {
            // added to the team and saved straight away
            const next = [...list, { userId, role: 'member', ...blank }];
            setRows(null);
            await act(
              () => put(`/api/v1/projects/${id}/members`, payload(next)),
              'Invited and added to the team',
            );
          }}
        />
      )}
    </div>
  );
}

/** Invites a new person to the workspace (they get a sign-in link) so they can join the project. */
function InvitePerson({ onClose, onInvited }: { onClose: () => void; onInvited: (userId: string) => Promise<void> }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: roles, error } = useQuery({ queryKey: ['admin-roles'], queryFn: () => get<{ items: Json[] }>('/api/admin/roles'), retry: false });
  const [f, setF] = useState({ fullName: '', email: '', role: '', invite: true });
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const choices = (roles?.items ?? []).filter((r) => r.key !== 'admin');
  // the least access by default: only the projects they are added to
  const role = f.role || choices.find((r) => r.key === 'project_member')?.key || choices.find((r) => /member/i.test(`${r.key} ${r.name}`))?.key || '';
  const chosen = choices.find((r) => r.key === role);
  if (link)
    return (
      <Modal title="Invitation link" onClose={onClose}>
        <div className="modal-body stack">
          <p className="small">No mail is set up, so send {f.fullName} this sign-in link yourself (valid for 7 days). They are already on the team.</p>
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => toast('Copied'))}>
            Copy link
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title="Add someone new to the team"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || !f.fullName.trim() || (f.email.trim() !== '' && !/^\S+@\S+\.\S+$/.test(f.email.trim())) || !role}
          onClick={async () => {
            setBusy(true);
            try {
              const onboard = f.invite && !!f.email.trim();
              const r = await post<{ id: string; inviteUrl: string | null; emailed: boolean }>('/api/admin/users/invite', { email: f.email.trim() || null, fullName: f.fullName.trim(), roles: [role], teamIds: [], invite: onboard });
              qc.invalidateQueries({ queryKey: ['users'] });
              await onInvited(r.id);
              if (!r.inviteUrl) {
                toast(`${f.fullName.trim()} added to the team. Give them a login later from Settings → People.`);
                onClose();
              } else if (r.emailed) {
                toast(`Invitation emailed to ${f.email}`);
                onClose();
              } else setLink(r.inviteUrl);
            } catch (e) {
              toast((e as Error).message, true);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Adding…' : f.invite && f.email.trim() ? 'Add and invite' : 'Add to team'}
        </button>
      }
    >
      <div className="modal-body stack">
        {error ? (
          <p className="small" style={{ color: 'var(--bad)' }}>
            Only workspace admins can invite people. Ask an admin to invite them (Settings → People), then add them here.
          </p>
        ) : (
          <>
            <label className="field">
              Full name
              <input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} autoFocus />
            </label>
            <label className="field">
              Email <span className="muted small">(optional)</span>
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={f.invite && !!f.email.trim()} disabled={!f.email.trim()} onChange={(e) => setF({ ...f, invite: e.target.checked })} />
              Give them a login now (send the invitation)
            </label>
            <label className="field">
              Access in the workspace
              <select value={role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                {choices.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name ?? r.key}
                  </option>
                ))}
                {!role && <option value="">Choose…</option>}
              </select>
              {chosen?.description && <small className="muted">{chosen.description}</small>}
              {chosen && (chosen.permissions?.apps ?? ['*']).includes('*') && (
                <small style={{ color: 'var(--bad)' }}>This role reaches every part of the workspace (CRM, billing, books…). For someone working only on projects choose “Project team member”.</small>
              )}
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              Without an email they join the team as a profile (time, tasks and rates work); add the email and onboard them to the CRM any time from Settings → People. Their role on this project (member, manager, viewer) and their rates are set in the team list.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}
