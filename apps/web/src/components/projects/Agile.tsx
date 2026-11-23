/**
 * Agile delivery inside a project: backlog and sprints (plan, start, burndown, close), releases with
 * release notes, change requests with the client portal link, and estimates against actuals.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { del, get, patch, post, put } from '../../lib/api';
import { date, money2 } from '../../lib/format';
import { BarChart, LineChart } from '../charts';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { WorkItemModal } from './WorkItem';

type Json = Record<string, any>;
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

export const WORK_TYPES: [string, string, string][] = [
  ['story', 'Story', '📗'],
  ['bug', 'Bug', '🐞'],
  ['task', 'Task', '☑️'],
  ['spike', 'Spike', '🔬'],
  ['chore', 'Chore', '🧹'],
  ['epic', 'Epic', '⚡'],
  ['feature', 'Feature', '🧩'],
  ['subtask', 'Sub-task', '↳'],
];
const typeIcon = (t: string) => WORK_TYPES.find((w) => w[0] === t)?.[2] ?? '☑️';
const STATUS_CLS: Record<string, string> = {
  open: '',
  in_progress: 'info',
  review: 'warn',
  blocked: 'bad',
  done: 'good',
  cancelled: '',
};
const POINTS = [0, 0.5, 1, 2, 3, 5, 8, 13, 21];

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

/* ───────────────────────── backlog and sprints ───────────────────────── */

export function AgileTab({ id, manage, member }: { id: string; manage: boolean; member: boolean }) {
  const key = ['agile', id];
  const { data: b } = useQuery({
    queryKey: key,
    queryFn: () => get<Json>(`/api/v1/projects/${id}/agile`),
  });
  const act = useAct([key, ['project', id]]);
  const toast = useToast();
  const [open, setOpen] = useState<Json | null>(null);
  const [sprintEdit, setSprintEdit] = useState<Json | null>(null);
  const [closing, setClosing] = useState<Json | null>(null);
  const [newItem, setNewItem] = useState('');
  const [newType, setNewType] = useState('story');
  const [show, setShow] = useState<'board' | 'backlog'>('backlog');
  if (!b) return <Spinner />;
  const sprints = b.sprints as Json[];
  const active = sprints.find((s) => s.status === 'active');
  const planned = sprints.filter((s) => s.status === 'planned');
  const closed = sprints.filter((s) => s.status === 'closed');
  const items = b.items as Json[];
  const backlog = items.filter((i) => !i.sprint_id && !['done', 'cancelled'].includes(i.status));
  const epics = new Map((b.epics as Json[]).map((e) => [e.id, e]));
  const move = (item: Json, sprintId: string | null) => act(() => put(`/api/v1/projects/${id}/agile/tasks/${item.id}`, { sprintId }));
  const rank = (list: Json[], from: number, to: number) => {
    const ids = list.map((x) => x.id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    void act(() => put(`/api/v1/projects/${id}/agile/backlog`, { ids }));
  };
  const add = async () => {
    const r = await act(() =>
      post<{ id: string }>(`/api/v1/projects/${id}/tasks`, {
        name: newItem.trim(),
      }),
    );
    if (r) {
      await act(
        () =>
          put(`/api/v1/projects/${id}/agile/tasks/${r.id}`, {
            workType: newType,
          }),
        'Added to the backlog',
      );
      setNewItem('');
    }
  };

  const Row = ({ i, list, idx, sprint }: { i: Json; list: Json[]; idx: number; sprint?: Json }) => (
    <tr className="click" onClick={() => setOpen(i)}>
      <td style={{ width: 28 }} title={i.work_type}>
        {typeIcon(i.work_type)}
      </td>
      <td>
        <span className="muted small">#{i.task_number}</span> {i.name}
        {i.epic_id && epics.get(i.epic_id) && (
          <span className="chip" style={{ marginLeft: 6 }}>
            {epics.get(i.epic_id)!.name}
          </span>
        )}
        {i.links > 0 && <span className="muted small"> · 🔗 {i.links}</span>}
      </td>
      <td>
        <span className={`chip ${STATUS_CLS[i.status] ?? ''}`}>{String(i.status).replace('_', ' ')}</span>
      </td>
      <td className="num">{i.story_points ?? '—'}</td>
      {member && (
        <td className="num" onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
          {!sprint && idx > 0 && (
            <button className="btn sm ghost" title="Move up" onClick={() => rank(list, idx, idx - 1)}>
              ↑
            </button>
          )}
          {!sprint && idx < list.length - 1 && (
            <button className="btn sm ghost" title="Move down" onClick={() => rank(list, idx, idx + 1)}>
              ↓
            </button>
          )}
          <select className="sm" aria-label="Sprint" value={i.sprint_id ?? ''} onChange={(e) => move(i, e.target.value || null)}>
            <option value="">Backlog</option>
            {[...(active ? [active] : []), ...planned].map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </td>
      )}
    </tr>
  );

  const SprintBox = ({ s }: { s: Json }) => {
    const list = items.filter((i) => i.sprint_id === s.id);
    const over = s.capacity_points != null && s.points > s.capacity_points;
    return (
      <div
        className="panel"
        style={{
          padding: 12,
          marginBottom: 12,
          borderLeft: s.status === 'active' ? '3px solid var(--accent)' : undefined,
        }}
      >
        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
          <div>
            <b>{s.name}</b> <span className={`chip ${s.status === 'active' ? 'info' : ''}`}>{s.status}</span>{' '}
            <span className="muted small">
              {date(s.start_date)} – {date(s.end_date)} · {s.points} pts
              {s.capacity_points != null ? ` of ${s.capacity_points}` : ''} · {s.done_items}/{s.items} done
            </span>
            {over && (
              <span className="chip warn" style={{ marginLeft: 6 }}>
                Over capacity
              </span>
            )}
            {s.goal && <div className="small muted">Goal: {s.goal}</div>}
          </div>
          {manage && (
            <div className="row">
              {s.status === 'planned' && (
                <>
                  <button className="btn sm" onClick={() => setSprintEdit(s)}>
                    Edit
                  </button>
                  <button
                    className="btn sm primary"
                    disabled={!!active || !list.length}
                    title={active ? 'Close the running sprint first' : ''}
                    onClick={() => act(() => post(`/api/v1/projects/${id}/agile/sprints/${s.id}/start`), 'Sprint started')}
                  >
                    Start sprint
                  </button>
                </>
              )}
              {s.status === 'active' && (
                <button className="btn sm primary" onClick={() => setClosing(s)}>
                  Complete sprint
                </button>
              )}
            </div>
          )}
        </div>
        {s.status === 'active' && <Burndown id={id} sprintId={s.id} />}
        {list.length ? (
          <table className="data" data-export-title={`${s.name} — sprint items`} style={{ marginTop: 8 }}>
            <tbody>
              {list.map((i, idx) => (
                <Row key={i.id} i={i} list={list} idx={idx} sprint={s} />
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted small">Move items here from the backlog.</p>
        )}
      </div>
    );
  };

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="row" role="group">
          <button className={`btn sm${show === 'backlog' ? ' primary' : ' ghost'}`} onClick={() => setShow('backlog')}>
            Backlog & sprints
          </button>
          <button className={`btn sm${show === 'board' ? ' primary' : ' ghost'}`} onClick={() => setShow('board')} disabled={!active}>
            Sprint board
          </button>
        </div>
        {manage && (
          <button
            className="btn sm"
            onClick={async () => {
              const d = await get<Json>(`/api/v1/projects/${id}/agile/next-sprint`);
              setSprintEdit({
                name: d.name,
                start_date: d.startDate,
                end_date: d.endDate,
              });
            }}
          >
            + Plan a sprint
          </button>
        )}
      </div>

      {show === 'board' && active ? (
        <SprintBoard id={id} sprint={active} items={items.filter((i) => i.sprint_id === active.id)} onOpen={setOpen} member={member} />
      ) : (
        <>
          {active && <SprintBox s={active} />}
          {planned.map((s) => (
            <SprintBox key={s.id} s={s} />
          ))}
          <div className="panel" style={{ padding: 12 }}>
            <div className="spread">
              <b>Backlog</b>
              <span className="muted small">
                {backlog.length} items · {backlog.reduce((a, i) => a + (i.story_points ?? 0), 0)} pts · top of the list first
              </span>
            </div>
            {member && (
              <div className="row" style={{ margin: '8px 0', gap: 6 }}>
                <select value={newType} onChange={(e) => setNewType(e.target.value)} aria-label="Type">
                  {WORK_TYPES.map(([k, l, ic]) => (
                    <option key={k} value={k}>
                      {ic} {l}
                    </option>
                  ))}
                </select>
                <input
                  style={{ flex: 1 }}
                  placeholder="As a donor, I want to… (press Enter)"
                  value={newItem}
                  onChange={(e) => setNewItem(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && newItem.trim() && add()}
                />
                <button className="btn sm primary" disabled={!newItem.trim()} onClick={add}>
                  Add
                </button>
              </div>
            )}
            {backlog.length ? (
              <table className="data" data-export-title="Product backlog">
                <thead>
                  <tr>
                    <th />
                    <th>Item</th>
                    <th>Status</th>
                    <th className="num">Points</th>
                    {member && <th className="num">Plan</th>}
                  </tr>
                </thead>
                <tbody>
                  {backlog.map((i, idx) => (
                    <Row key={i.id} i={i} list={backlog} idx={idx} />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted small">The backlog is empty.</p>
            )}
          </div>
          {(b.epics as Json[]).length > 0 && (
            <div className="panel" style={{ padding: 12 }}>
              <b>Epics</b>
              <table className="data" data-export-title="Epics" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Epic</th>
                    <th className="num">Items</th>
                    <th className="num">Points done</th>
                    <th style={{ width: '30%' }}>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {(b.epics as Json[]).map((e) => {
                    const pct = e.points ? Math.round((e.done_points / e.points) * 100) : e.items ? Math.round((e.done_items / e.items) * 100) : 0;
                    return (
                      <tr key={e.id} className="click" onClick={() => setOpen({ ...e, work_type: 'epic' })}>
                        <td>
                          ⚡ <span className="muted small">#{e.task_number}</span> {e.name}
                        </td>
                        <td className="num">
                          {e.done_items}/{e.items}
                        </td>
                        <td className="num">
                          {e.done_points}/{e.points}
                        </td>
                        <td>
                          <div
                            aria-label={`${pct}%`}
                            title={`${pct}%`}
                            style={{
                              height: 8,
                              borderRadius: 4,
                              background: 'var(--line)',
                            }}
                          >
                            <div
                              style={{
                                width: `${pct}%`,
                                height: 8,
                                borderRadius: 4,
                                background: 'var(--accent)',
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Velocity id={id} closed={closed.length} />
        </>
      )}

      {open && <WorkItemModal projectId={id} id={open.id} onClose={() => setOpen(null)} onOpen={(x) => setOpen({ id: x })} />}
      {sprintEdit && (
        <SprintModal
          s={sprintEdit}
          onClose={() => setSprintEdit(null)}
          onSave={async (body, remove) => {
            const r = remove
              ? await act(() => del(`/api/v1/projects/${id}/agile/sprints/${sprintEdit.id}`), 'Sprint deleted')
              : sprintEdit.id
                ? await act(() => put(`/api/v1/projects/${id}/agile/sprints/${sprintEdit.id}`, body), 'Saved')
                : await act(() => post(`/api/v1/projects/${id}/agile/sprints`, body), 'Sprint planned');
            if (r) setSprintEdit(null);
          }}
        />
      )}
      {closing && (
        <CloseSprint
          s={closing}
          planned={planned}
          open={items.filter((i) => i.sprint_id === closing.id && !['done', 'cancelled'].includes(i.status)).length}
          onClose={() => setClosing(null)}
          onDone={async (moveTo) => {
            const r = await act(() => post<Json>(`/api/v1/projects/${id}/agile/sprints/${closing.id}/close`, { moveTo }));
            if (r) {
              setClosing(null);
              toast(`${closing.name} closed: ${r.completedPoints} points done, ${r.carriedOver} item(s) carried over`);
            }
          }}
        />
      )}
    </div>
  );
}

function SprintBoard({ id, sprint, items, onOpen, member }: { id: string; sprint: Json; items: Json[]; onOpen: (i: Json) => void; member: boolean }) {
  const act = useAct([
    ['agile', id],
    ['project', id],
  ]);
  const [drag, setDrag] = useState<string | null>(null);
  const cols: [string, string][] = [
    ['open', 'To do'],
    ['in_progress', 'In progress'],
    ['review', 'Review'],
    ['blocked', 'Blocked'],
    ['done', 'Done'],
  ];
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        {sprint.name} · {date(sprint.start_date)} – {date(sprint.end_date)} {sprint.goal ? `· ${sprint.goal}` : ''}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols.length}, minmax(170px, 1fr))`,
          gap: 8,
          overflowX: 'auto',
        }}
      >
        {cols.map(([k, l]) => (
          <div
            key={k}
            className="panel"
            style={{
              padding: 8,
              minHeight: 200,
              background: 'var(--bg-2, #f6f8fa)',
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => drag && member && act(() => patch(`/api/v1/projects/${id}/tasks/${drag}`, { status: k }))}
          >
            <div className="spread small" style={{ marginBottom: 6 }}>
              <b>{l}</b>
              <span className="muted">
                {items.filter((t) => t.status === k).length} · {items.filter((t) => t.status === k).reduce((a, t) => a + (t.story_points ?? 0), 0)} pts
              </span>
            </div>
            {items
              .filter((t) => t.status === k)
              .map((t) => (
                <div key={t.id} className="panel" draggable={member} onDragStart={() => setDrag(t.id)} onClick={() => onOpen(t)} style={{ padding: 8, marginBottom: 6, cursor: 'pointer' }}>
                  <div className="small muted">
                    {typeIcon(t.work_type)} #{t.task_number} {t.story_points != null && <span className="chip">{t.story_points} pts</span>}
                  </div>
                  <div>{t.name}</div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Burndown({ id, sprintId }: { id: string; sprintId: string }) {
  const { data } = useQuery({
    queryKey: ['agile', id, 'burndown', sprintId],
    queryFn: () => get<Json>(`/api/v1/projects/${id}/agile/sprints/${sprintId}/burndown`),
  });
  if (!data || !data.days.length) return null;
  const days = data.days as Json[];
  return (
    <div style={{ margin: '8px 0' }} data-export-title="Sprint burndown">
      <div className="small muted">Burndown — points left each day against the ideal line</div>
      <LineChart
        height={180}
        fmt={(n) => `${Math.round(n * 10) / 10}`}
        data={{
          categories: days.map((d) => date(d.date).slice(0, 6)),
          series: [
            { label: 'Ideal', values: days.map((d) => d.ideal) },
            {
              label: 'Remaining',
              values: days.map((d) => (d.remaining == null ? Number.NaN : d.remaining)),
            },
          ],
        }}
      />
    </div>
  );
}

function Velocity({ id, closed }: { id: string; closed: number }) {
  const { data } = useQuery({
    queryKey: ['agile', id, 'velocity', closed],
    queryFn: () => get<Json>(`/api/v1/projects/${id}/agile/velocity`),
  });
  if (!data || !data.sprints.length) return null;
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div className="spread">
        <b>Velocity</b>
        <span className="muted small">Average of the last 3 sprints: {data.average} points</span>
      </div>
      <BarChart
        height={200}
        stacked={false}
        fmt={(n) => `${n}`}
        data={{
          categories: data.sprints.map((s: Json) => s.name),
          series: [
            {
              label: 'Committed',
              values: data.sprints.map((s: Json) => s.committed),
            },
            {
              label: 'Completed',
              values: data.sprints.map((s: Json) => s.completed),
            },
          ],
        }}
      />
    </div>
  );
}

function SprintModal({ s, onClose, onSave }: { s: Json; onClose: () => void; onSave: (b: Json, remove?: boolean) => void }) {
  const [f, setF] = useState({
    name: s.name ?? '',
    goal: s.goal ?? '',
    startDate: s.start_date ?? today(),
    endDate: s.end_date ?? '',
    capacity: s.capacity_points ?? '',
  });
  return (
    <Modal
      title={s.id ? s.name : 'Plan a sprint'}
      onClose={onClose}
      footer={
        <>
          {s.id && s.status === 'planned' && (
            <button className="btn danger" onClick={() => window.confirm('Delete this sprint? Its items go back to the backlog.') && onSave({}, true)}>
              Delete
            </button>
          )}
          <button
            className="btn primary"
            disabled={!f.name.trim() || !f.startDate || !f.endDate}
            onClick={() =>
              onSave({
                name: f.name.trim(),
                goal: f.goal.trim() || null,
                startDate: f.startDate,
                endDate: f.endDate,
                capacityPoints: f.capacity === '' ? null : Number(f.capacity),
              })
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
        </label>
        <label className="field">
          Capacity (story points, optional)
          <input inputMode="decimal" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} />
        </label>
        <label className="field">
          Starts
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        </label>
        <label className="field">
          Ends
          <input type="date" value={f.endDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} />
        </label>
        <label className="field wide">
          Sprint goal
          <input value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} placeholder="What the team commits to deliver" />
        </label>
      </div>
    </Modal>
  );
}

function CloseSprint({ s, planned, open, onClose, onDone }: { s: Json; planned: Json[]; open: number; onClose: () => void; onDone: (moveTo: string | null) => void }) {
  const [to, setTo] = useState(planned[0]?.id ?? '');
  return (
    <Modal
      title={`Complete ${s.name}`}
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={() => onDone(to || null)}>
          Complete sprint
        </button>
      }
    >
      <div className="modal-body">
        <p>
          {s.done_points} of {s.points} points are done. {open ? `${open} unfinished item(s) move to:` : 'Everything is finished.'}
        </p>
        {open > 0 && (
          <label className="field">
            Move unfinished work to
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">The backlog</option>
              {planned.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}

/** Type, points, sprint, release, epic and code links of one work item. */
/** The earlier planning dialog (kept for reference; the full work item view replaced it). */
export function ItemModal({ id, item, board, member, onClose }: { id: string; item: Json; board: Json; member: boolean; onClose: () => void }) {
  const act = useAct([
    ['agile', id],
    ['project', id],
  ]);
  const [f, setF] = useState({
    workType: item.work_type ?? 'task',
    storyPoints: item.story_points ?? '',
    sprintId: item.sprint_id ?? '',
    releaseId: item.release_id ?? '',
    epicId: item.epic_id ?? '',
  });
  const [url, setUrl] = useState('');
  const links = useQuery({
    queryKey: ['agile', id, 'links', item.id],
    queryFn: () => get<Json[]>(`/api/v1/projects/${id}/agile/tasks/${item.id}/links`),
  });
  const save = async () => {
    const r = await act(
      () =>
        put(`/api/v1/projects/${id}/agile/tasks/${item.id}`, {
          workType: f.workType,
          storyPoints: f.storyPoints === '' ? null : Number(f.storyPoints),
          ...(f.workType === 'epic' ? {} : { sprintId: f.sprintId || null, epicId: f.epicId || null }),
          releaseId: f.releaseId || null,
        }),
      'Saved',
    );
    if (r !== null) onClose();
  };
  const sprints = (board.sprints as Json[]).filter((s) => s.status !== 'closed');
  return (
    <Modal
      title={`${typeIcon(f.workType)} #${item.task_number} ${item.name}`}
      onClose={onClose}
      wide
      footer={
        member ? (
          <button className="btn primary" onClick={save}>
            Save
          </button>
        ) : undefined
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Type
          <select disabled={!member} value={f.workType} onChange={(e) => setF({ ...f, workType: e.target.value })}>
            {WORK_TYPES.map(([k, l, ic]) => (
              <option key={k} value={k}>
                {ic} {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Story points
          <select disabled={!member} value={String(f.storyPoints)} onChange={(e) => setF({ ...f, storyPoints: e.target.value })}>
            <option value="">—</option>
            {POINTS.map((p) => (
              <option key={p} value={String(p)}>
                {p}
              </option>
            ))}
          </select>
        </label>
        {f.workType !== 'epic' && (
          <>
            <label className="field">
              Sprint
              <select disabled={!member} value={f.sprintId} onChange={(e) => setF({ ...f, sprintId: e.target.value })}>
                <option value="">Backlog</option>
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.status})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Epic
              <select disabled={!member} value={f.epicId} onChange={(e) => setF({ ...f, epicId: e.target.value })}>
                <option value="">—</option>
                {(board.epics as Json[])
                  .filter((e) => e.id !== item.id)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <label className="field">
          Release
          <select disabled={!member} value={f.releaseId} onChange={(e) => setF({ ...f, releaseId: e.target.value })}>
            <option value="">—</option>
            {(board.releases as Json[])
              .filter((r) => r.status !== 'released' || r.id === item.release_id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.version ? ` ${r.version}` : ''}
                </option>
              ))}
          </select>
        </label>
        <div className="wide">
          <b className="small">Pull requests, commits and documents</b>
          {(links.data ?? []).map((l) => (
            <div
              key={l.id}
              className="spread small"
              style={{
                padding: '4px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span>
                <span className="chip">{l.kind}</span>{' '}
                <a href={l.url} target="_blank" rel="noreferrer noopener">
                  {l.title || l.url}
                </a>
              </span>
              {member && (
                <span className="row">
                  {l.kind === 'pr' && (
                    <select
                      className="sm"
                      value={l.status ?? 'open'}
                      onChange={(e) =>
                        act(() =>
                          put(`/api/v1/projects/${id}/agile/links/${l.id}`, {
                            status: e.target.value,
                          }),
                        )
                      }
                      aria-label="PR status"
                    >
                      <option value="draft">Draft</option>
                      <option value="open">Open</option>
                      <option value="merged">Merged</option>
                      <option value="closed">Closed</option>
                    </select>
                  )}
                  <button className="btn sm ghost" onClick={() => act(() => del(`/api/v1/projects/${id}/agile/links/${l.id}`))} aria-label="Remove link">
                    ✕
                  </button>
                </span>
              )}
            </div>
          ))}
          {member && (
            <div className="row" style={{ marginTop: 6 }}>
              <input style={{ flex: 1 }} placeholder="Paste a GitHub / GitLab / Bitbucket PR, commit, branch or document link" value={url} onChange={(e) => setUrl(e.target.value)} />
              <button
                className="btn sm"
                disabled={!/^https?:\/\/\S+$/.test(url.trim())}
                onClick={async () => {
                  if (await act(() => post(`/api/v1/projects/${id}/agile/tasks/${item.id}/links`, { url: url.trim() }))) setUrl('');
                }}
              >
                Link
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────── releases ───────────────────────── */

export { ReleasesTab } from './Releases';

/* ───────────────────────── change requests, estimates, client portal ───────────────────────── */

const CR_CLS: Record<string, string> = {
  draft: '',
  submitted: 'warn',
  approved: 'good',
  rejected: 'bad',
  implemented: 'info',
};

export function ChangesTab({ id, data, manage, member }: { id: string; data: Json; manage: boolean; member: boolean }) {
  const key = ['agile', id, 'crs'];
  const { data: crs } = useQuery({
    queryKey: key,
    queryFn: () => get<Json[]>(`/api/v1/projects/${id}/agile/change-requests`),
  });
  const est = useQuery({
    queryKey: ['agile', id, 'estimates'],
    queryFn: () => get<Json>(`/api/v1/projects/${id}/agile/estimates`),
  });
  const act = useAct([key, ['project', id]]);
  const [edit, setEdit] = useState<Json | null>(null);
  const [token, setToken] = useState<string | null>(data.project?.portal_token ?? null);
  const portalUrl = token ? `${window.location.origin}/portal/${token}` : null;
  const worst = useMemo(
    () =>
      ((est.data?.tasks ?? []) as Json[])
        .filter((t) => t.variance != null)
        .sort((a, b) => b.variance - a.variance)
        .slice(0, 15),
    [est.data],
  );
  return (
    <div className="stack">
      {manage && (
        <div className="panel" style={{ padding: 12 }}>
          <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
            <div>
              <b>Client portal</b>
              <div className="small muted">A read-only page for the customer: progress, milestones, the running sprint, releases with notes, and change requests they can approve.</div>
            </div>
            <div className="row">
              {portalUrl && (
                <button className="btn sm" onClick={() => navigator.clipboard?.writeText(portalUrl)}>
                  Copy link
                </button>
              )}
              <button
                className={`btn sm${token ? ' danger' : ' primary'}`}
                onClick={async () => {
                  const r = await act(
                    () =>
                      post<Json>(`/api/v1/projects/${id}/agile/portal`, {
                        on: !token,
                      }),
                    token ? 'Portal link turned off' : 'Portal link created',
                  );
                  if (r) setToken(r.token);
                }}
              >
                {token ? 'Turn off' : 'Create portal link'}
              </button>
            </div>
          </div>
          {portalUrl && (
            <p className="small" style={{ marginBottom: 0 }}>
              <a href={portalUrl} target="_blank" rel="noreferrer">
                {portalUrl}
              </a>
            </p>
          )}
        </div>
      )}

      <div className="spread">
        <b>Change requests</b>
        {member && (
          <button className="btn primary sm" onClick={() => setEdit({})}>
            + Change request
          </button>
        )}
      </div>
      {crs?.length ? (
        <table className="data" data-export-title="Change requests">
          <thead>
            <tr>
              <th>CR</th>
              <th>Change</th>
              <th className="num">Hours</th>
              <th className="num">Cost</th>
              <th className="num">Days</th>
              <th>Status</th>
              <th>Decided by</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {crs.map((c) => (
              <tr key={c.id}>
                <td>CR-{c.cr_number}</td>
                <td>
                  {c.title}
                  {c.requested_by && <div className="small muted">Asked by {c.requested_by}</div>}
                </td>
                <td className="num">{c.impact_hours}</td>
                <td className="num">{money2(c.impact_amount)}</td>
                <td className="num">{c.impact_days}</td>
                <td>
                  <span className={`chip ${CR_CLS[c.status] ?? ''}`}>{c.status}</span>
                </td>
                <td className="small">
                  {c.decided_by ?? '—'}
                  {c.decision_note && <div className="muted">{c.decision_note}</div>}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {c.status === 'draft' && member && (
                    <>
                      <button className="btn sm ghost" onClick={() => setEdit(c)}>
                        Edit
                      </button>
                      <button className="btn sm" onClick={() => act(() => post(`/api/v1/projects/${id}/agile/change-requests/${c.id}/submit`), 'Sent for approval')}>
                        Submit
                      </button>
                    </>
                  )}
                  {c.status === 'submitted' && manage && (
                    <>
                      <button className="btn sm primary" onClick={() => act(() => post(`/api/v1/projects/${id}/agile/change-requests/${c.id}/approve`), 'Approved; added to the budget')}>
                        Approve
                      </button>
                      <button
                        className="btn sm danger"
                        onClick={() => {
                          const note = window.prompt('Why is it rejected?');
                          if (note?.trim()) void act(() => post(`/api/v1/projects/${id}/agile/change-requests/${c.id}/reject`, { note }), 'Rejected');
                        }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                  {c.status === 'approved' && manage && (
                    <button className="btn sm" onClick={() => act(() => post(`/api/v1/projects/${id}/agile/change-requests/${c.id}/implemented`), 'Marked implemented')}>
                      Implemented
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">No change requests. Approved changes add their hours to the budget, their cost to the fixed fee (or budget) and their days to the end date.</p>
      )}

      {est.data && (
        <div className="panel" style={{ padding: 12 }}>
          <div className="spread" style={{ flexWrap: 'wrap' }}>
            <b>Estimates against actuals</b>
            <span className="small muted">
              Estimated {est.data.totals.estimate} h · logged {est.data.totals.actual} h{est.data.accuracy != null && ` · estimate accuracy on finished work ${est.data.accuracy}%`}
              {est.data.totals.unestimated > 0 && ` · ${est.data.totals.unestimated} item(s) with time but no estimate`}
            </span>
          </div>
          {worst.length > 0 && (
            <table className="data" data-export-title="Estimates against actuals" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Status</th>
                  <th className="num">Estimate (h)</th>
                  <th className="num">Actual (h)</th>
                  <th className="num">Over / under</th>
                </tr>
              </thead>
              <tbody>
                {worst.map((t) => (
                  <tr key={t.id}>
                    <td>
                      {typeIcon(t.work_type)} #{t.task_number} {t.name}
                    </td>
                    <td>{String(t.status).replace('_', ' ')}</td>
                    <td className="num">{t.estimate}</td>
                    <td className="num">{t.actual}</td>
                    <td
                      className="num"
                      style={{
                        color: t.variance > 0 ? 'var(--bad)' : 'var(--good)',
                      }}
                    >
                      {t.variance > 0 ? `+${t.variance}` : t.variance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {edit && (
        <CrModal
          c={edit}
          onClose={() => setEdit(null)}
          onSave={async (body) => {
            const r = edit.id
              ? await act(() => put(`/api/v1/projects/${id}/agile/change-requests/${edit.id}`, body), 'Saved')
              : await act(() => post(`/api/v1/projects/${id}/agile/change-requests`, body), 'Change request added');
            if (r) setEdit(null);
          }}
        />
      )}
    </div>
  );
}

function CrModal({ c, onClose, onSave }: { c: Json; onClose: () => void; onSave: (b: Json) => void }) {
  const [f, setF] = useState({
    title: c.title ?? '',
    description: c.description ?? '',
    reason: c.reason ?? '',
    requestedBy: c.requested_by ?? '',
    hours: c.impact_hours ?? '',
    amount: c.impact_amount ?? '',
    days: c.impact_days ?? '',
  });
  return (
    <Modal
      title={c.id ? `CR-${c.cr_number}` : 'New change request'}
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!f.title.trim()}
          onClick={() =>
            onSave({
              title: f.title.trim(),
              description: f.description.trim() || null,
              reason: f.reason.trim() || null,
              requestedBy: f.requestedBy.trim() || null,
              impactHours: Number(f.hours || 0),
              impactAmount: Number(f.amount || 0),
              impactDays: Math.round(Number(f.days || 0)),
            })
          }
        >
          Save
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          What changes
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus />
        </label>
        <label className="field wide">
          Details
          <textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={4} />
        </label>
        <label className="field">
          Why
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        </label>
        <label className="field">
          Asked by
          <input value={f.requestedBy} onChange={(e) => setF({ ...f, requestedBy: e.target.value })} placeholder="Customer's person" />
        </label>
        <label className="field">
          Extra hours
          <input inputMode="decimal" value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} />
        </label>
        <label className="field">
          Extra cost to the customer (₹)
          <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Schedule slip (days)
          <input inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}
