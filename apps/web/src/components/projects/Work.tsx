/**
 * Work management sections of a project (Jira / Azure DevOps style): boards, queries with bulk edit,
 * the hierarchy (epics → features → stories → tasks), dashboards and flow reports, test plans, and
 * the work setup (key, workflows, components, custom fields, automation, code connections).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useEffect, useMemo, useState } from 'react';
import { del, download, get, patch as patch_, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { date } from '../../lib/format';
import { Chart } from '../charts';
import { Empty, Modal, Spinner, useToast } from '../ui';
import { AppRepoPicker, BurnupView, GitHubAppSection, RequireCheckButton, SprintReportView, TemplatesSection, TimeInStatusView } from './WorkPlus';
import { Guide } from '../admin/ConnectionKeys';
import { CAT_CLS, CreateItemModal, type Json, priIcon, PRIORITIES, Progress, StateChip, typeIcon, typeLabel, TYPES, usePlanning, useTeam, useWorkSetup, WorkItemModal } from './WorkItem';

const CATS: [string, string][] = [['todo', 'To do'], ['in_progress', 'In progress'], ['review', 'Review'], ['blocked', 'Blocked'], ['done', 'Done'], ['cancelled', 'Cancelled']];

function useRun() {
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

/* ───────────────────────── boards ───────────────────────── */

export function BoardsTab({ id, manage, member, onOpen }: { id: string; manage: boolean; member: boolean; onOpen: (itemId: string) => void }) {
  const { data: boards } = useQuery({ queryKey: ['work', id, 'boards'], queryFn: () => get<Json[]>(`/api/v1/projects/${id}/work/boards`) });
  const [boardId, setBoardId] = useState<string | null>(null);
  const [quick, setQuick] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [edit, setEdit] = useState<Json | null>(null);
  const [create, setCreate] = useState(false);
  const qc = useQueryClient();
  const run = useRun();
  const board = boards?.find((b) => b.id === boardId) ?? boards?.[0];
  const key = ['work', id, 'board', board?.id ?? 'default', quick.join(','), search];
  const { data } = useQuery({ queryKey: key, enabled: !!boards, queryFn: () => get<Json>(`/api/v1/projects/${id}/work/board?${new URLSearchParams({ ...(board?.id ? { boardId: board.id } : {}), quick: quick.join(','), search })}`) });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const drop = async (e: DragEvent, col: number) => {
    e.preventDefault();
    setOver(null);
    const tid = drag ?? e.dataTransfer.getData('text/plain');
    setDrag(null);
    if (!tid) return;
    // optimistic: show the card in the new column straight away
    qc.setQueryData(key, (old: Json | undefined) => (old ? { ...old, items: old.items.map((i: Json) => (i.id === tid ? { ...i, column: col } : i)) } : old));
    await run(() => post(`/api/v1/projects/${id}/work/board/move`, { boardId: board?.id ?? null, taskId: tid, column: col }));
    qc.invalidateQueries({ queryKey: ['work', id] });
  };
  if (!boards || !data) return <Spinner />;
  const lanes = laneOf(data.board.swimlane, data.items);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 8, justifyContent: 'space-between' }}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {boards.length > 1 && (
            <select value={board?.id ?? ''} onChange={(e) => (setBoardId(e.target.value), setQuick([]))} aria-label="Board">
              {boards.map((b) => (
                <option key={b.id ?? 'default'} value={b.id ?? ''}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search the board" style={{ width: 180 }} aria-label="Search the board" />
          {(data.board.quick_filters as Json[]).map((q, i) => (
            <button key={i} className={`btn small${quick.includes(i) ? ' primary' : ''}`} aria-pressed={quick.includes(i)} onClick={() => setQuick(quick.includes(i) ? quick.filter((x) => x !== i) : [...quick, i])}>
              {q.name}
            </button>
          ))}
        </div>
        <div className="row" style={{ gap: 6 }}>
          {member && (
            <button className="btn primary small" onClick={() => setCreate(true)}>
              + Create
            </button>
          )}
          {manage && (
            <>
              <button className="btn small" onClick={() => setEdit(board?.id ? board : { ...board, id: null, name: board?.name ?? 'Team board' })}>
                Board settings
              </button>
              <button className="btn small" onClick={() => setEdit({ id: null, name: 'New board', kind: 'kanban', columns: data.board.columns, swimlane: 'none', filter: '', quick_filters: [], card_fields: ['points', 'assignee', 'priority'], fresh: true })}>
                New board
              </button>
            </>
          )}
        </div>
      </div>
      {data.board.kind === 'scrum' &&
        (data.sprint ? (
          <div className="callout small">
            <strong>{data.sprint.name}</strong> · {date(data.sprint.start_date)} – {date(data.sprint.end_date)}
            {data.sprint.goal && <> · Goal: {data.sprint.goal}</>}
          </div>
        ) : (
          <Empty title="No active sprint">Start a sprint under Sprints to work it on this board.</Empty>
        ))}
      <div className="kanban" style={{ gridTemplateColumns: `repeat(${data.columns.length}, minmax(220px, 1fr))` }}>
        {(data.columns as Json[]).map((c, ci) => (
          <div key={ci} className={`kb-head${c.over ? ' over' : ''}`}>
            <span>{c.name}</span>
            <span className="muted small">
              {c.count}
              {c.wip ? ` / ${c.wip}` : ''}
            </span>
          </div>
        ))}
        {lanes.map((lane) => (
          <LaneRow key={lane.key} lane={lane} columns={data.columns} showHead={lanes.length > 1 || data.board.swimlane !== 'none'} onOpen={onOpen} fields={data.board.card_fields} canMove={data.canMove} over={over} setOver={setOver} onDrop={drop} onDrag={setDrag} />
        ))}
      </div>
      {!data.items.length && <p className="muted small">No items on this board{quick.length || search ? ' for these filters' : ''}.</p>}
      {edit && <BoardEditor projectId={id} board={edit} onClose={() => setEdit(null)} onSaved={(bid) => (setEdit(null), bid && setBoardId(bid), qc.invalidateQueries({ queryKey: ['work', id] }))} />}
      {create && <CreateItemModal projectId={id} defaults={data.sprint ? { sprintId: data.sprint.id } : {}} onClose={() => setCreate(false)} onCreated={(r) => (setCreate(false), onOpen(r.id))} />}
    </div>
  );
}

function laneOf(by: string, items: Json[]) {
  if (by === 'none') return [{ key: 'all', label: '', items }];
  const m = new Map<string, { key: string; label: string; items: Json[] }>();
  const keyOf = (i: Json): [string, string] =>
    by === 'assignee' ? [i.assignees[0] ?? 'none', i.assigneeNames[0] ?? 'Unassigned'] : by === 'epic' ? [i.epicId ?? 'none', i.epicName ? `⚡ ${i.epicKey} ${i.epicName}` : 'No epic'] : by === 'parent' ? [i.parentId ?? 'none', i.parentKey ?? 'No parent'] : by === 'priority' ? [i.priority, `${priIcon(i.priority)} ${i.priority}`] : [i.workType, `${typeIcon(i.workType)} ${typeLabel(i.workType)}`];
  for (const i of items) {
    const [k, l] = keyOf(i);
    if (!m.has(k)) m.set(k, { key: k, label: l, items: [] });
    m.get(k)!.items.push(i);
  }
  const order = by === 'priority' ? PRIORITIES : null;
  return [...m.values()].sort((a, b) => (order ? order.indexOf(a.key) - order.indexOf(b.key) : a.key === 'none' ? 1 : b.key === 'none' ? -1 : a.label.localeCompare(b.label)));
}

function LaneRow({ lane, columns, showHead, onOpen, fields, canMove, over, setOver, onDrop, onDrag }: { lane: Json; columns: Json[]; showHead: boolean; onOpen: (id: string) => void; fields: string[]; canMove: boolean; over: number | null; setOver: (n: number | null) => void; onDrop: (e: DragEvent, col: number) => void; onDrag: (id: string | null) => void }) {
  return (
    <>
      {showHead && (
        <div className="kb-lane" style={{ gridColumn: `1 / span ${columns.length}` }}>
          {lane.label} <span className="muted small">· {lane.items.length}</span>
        </div>
      )}
      {columns.map((_, ci) => (
        <div
          key={ci}
          className={`kb-col${over === ci ? ' drop' : ''}`}
          onDragOver={(e) => canMove && (e.preventDefault(), setOver(ci))}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => onDrop(e, ci)}
        >
          {(lane.items as Json[])
            .filter((i) => i.column === ci)
            .map((i) => (
              <button
                key={i.id}
                type="button"
                className="kb-card"
                draggable={canMove}
                onDragStart={(e) => (e.dataTransfer.setData('text/plain', i.id), onDrag(i.id))}
                onDragEnd={() => onDrag(null)}
                onClick={() => onOpen(i.id)}
              >
                <div className="kb-title">{i.name}</div>
                <div className="kb-meta">
                  <span title={typeLabel(i.workType)}>{typeIcon(i.workType)}</span>
                  <span className="mono small">{i.key}</span>
                  {fields.includes('priority') && <span title={i.priority}>{priIcon(i.priority)}</span>}
                  {i.state !== i.status && i.stateLabel && <span className={`chip ${CAT_CLS[i.category]}`}>{i.stateLabel}</span>}
                  {fields.includes('epic') && i.epicName && <span className="chip">⚡ {i.epicName}</span>}
                  {fields.includes('labels') && (i.tags as string[]).map((t) => <span key={t} className="chip">{t}</span>)}
                  {fields.includes('due') && i.dueDate && <span className={`small${i.dueDate < new Date().toISOString().slice(0, 10) && i.category !== 'done' ? ' bad-text' : ' muted'}`}>{date(i.dueDate)}</span>}
                  {fields.includes('children') && i.childCount > 0 && <span className="small muted">☑ {i.childDone}/{i.childCount}</span>}
                  <span style={{ flex: 1 }} />
                  {fields.includes('points') && i.storyPoints !== null && <span className="kb-points">{i.storyPoints}</span>}
                  {fields.includes('assignee') && <Avatar name={i.assigneeNames[0]} />}
                </div>
              </button>
            ))}
        </div>
      ))}
    </>
  );
}

export function Avatar({ name }: { name?: string | null }) {
  if (!name) return null;
  const ini = name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <span className="wk-avatar" title={name}>
      {ini}
    </span>
  );
}

function BoardEditor({ projectId, board, onClose, onSaved }: { projectId: string; board: Json; onClose: () => void; onSaved: (id: string | null) => void }) {
  const { data: setup } = useWorkSetup(projectId);
  const run = useRun();
  const [b, setB] = useState<Json>({ ...board, filter: board.filter ?? '', columns: (board.columns as Json[]).map((c) => ({ states: [], categories: [], wip: null, ...c })), quick_filters: board.quick_filters ?? [] });
  const states: Json[] = useMemo(() => {
    const all = [...((setup?.workflows ?? []) as Json[]), ...(setup?.workflows?.length ? [] : [setup?.defaultWorkflow].filter(Boolean))].flatMap((w: Json) => w.states.map((s: Json) => ({ ...s, wf: w.name })));
    return all;
  }, [setup]);
  const setCol = (i: number, p: Json) => setB({ ...b, columns: b.columns.map((c: Json, ix: number) => (ix === i ? { ...c, ...p } : c)) });
  const save = async () => {
    const body = { name: b.name, kind: b.kind, columns: b.columns.map((c: Json) => ({ name: c.name, states: c.states, categories: c.categories, wip: c.wip || null })), swimlane: b.swimlane, filter: b.filter || null, quickFilters: b.quick_filters, cardFields: b.card_fields };
    const r = await run(() => (b.id ? put<Json>(`/api/v1/projects/${projectId}/work/boards/${b.id}`, body) : post<Json>(`/api/v1/projects/${projectId}/work/boards`, body)), 'Board saved');
    if (r) onSaved(r.id);
  };
  return (
    <Modal
      title={b.id ? 'Board settings' : 'New board'}
      onClose={onClose}
      xl
      footer={
        <>
          {b.id && (
            <button className="btn danger" onClick={async () => window.confirm('Delete this board? Items stay.') && (await run(() => del(`/api/v1/projects/${projectId}/work/boards/${b.id}`), 'Deleted')) && onSaved(null)}>
              Delete board
            </button>
          )}
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Name
            <input value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />
          </label>
          <label className="field">
            Kind
            <select value={b.kind} onChange={(e) => setB({ ...b, kind: e.target.value })}>
              <option value="kanban">Kanban — continuous flow</option>
              <option value="scrum">Scrum — the active sprint</option>
            </select>
          </label>
          <label className="field">
            Swimlanes
            <select value={b.swimlane} onChange={(e) => setB({ ...b, swimlane: e.target.value })}>
              {[['none', 'None'], ['assignee', 'By assignee'], ['epic', 'By epic'], ['parent', 'By parent (stories)'], ['priority', 'By priority'], ['type', 'By type']].map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Board filter (query)
            <input value={b.filter} onChange={(e) => setB({ ...b, filter: e.target.value })} placeholder='e.g. component = "Mobile app"' className="mono" />
          </label>
        </div>
        <div>
          <h3 className="section-label">Columns</h3>
          <table className="data compact">
            <thead>
              <tr>
                <th>Column</th>
                <th>Status categories</th>
                <th>Or exact states</th>
                <th>WIP limit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(b.columns as Json[]).map((c, i) => (
                <tr key={i}>
                  <td>
                    <input value={c.name} onChange={(e) => setCol(i, { name: e.target.value })} style={{ width: 130 }} aria-label="Column name" />
                  </td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {CATS.map(([k, l]) => (
                        <label key={k} className="row small" style={{ gap: 3 }}>
                          <input type="checkbox" checked={c.categories.includes(k)} onChange={(e) => setCol(i, { categories: e.target.checked ? [...c.categories, k] : c.categories.filter((x: string) => x !== k) })} /> {l}
                        </label>
                      ))}
                    </div>
                  </td>
                  <td>
                    <select multiple value={c.states} onChange={(e) => setCol(i, { states: [...e.target.selectedOptions].map((o) => o.value) })} style={{ minWidth: 150, height: 64 }} aria-label="States">
                      {states.map((s) => (
                        <option key={`${s.wf}-${s.key}`} value={s.key}>
                          {s.label} ({s.wf})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input type="number" min={1} value={c.wip ?? ''} onChange={(e) => setCol(i, { wip: e.target.value ? Number(e.target.value) : null })} style={{ width: 70 }} aria-label="WIP limit" />
                  </td>
                  <td className="nowrap">
                    <button className="link-btn small" disabled={i === 0} onClick={() => setB({ ...b, columns: swap(b.columns, i, i - 1) })} aria-label="Move left">
                      ←
                    </button>{' '}
                    <button className="link-btn small" disabled={i === b.columns.length - 1} onClick={() => setB({ ...b, columns: swap(b.columns, i, i + 1) })} aria-label="Move right">
                      →
                    </button>{' '}
                    <button className="link-btn small" onClick={() => setB({ ...b, columns: b.columns.filter((_: Json, ix: number) => ix !== i) })} aria-label="Remove column">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link-btn small" onClick={() => setB({ ...b, columns: [...b.columns, { name: 'New column', states: [], categories: [], wip: null }] })}>
            + Add column
          </button>
        </div>
        <div className="grid2">
          <div>
            <h3 className="section-label">Quick filters</h3>
            {(b.quick_filters as Json[]).map((q, i) => (
              <div key={i} className="row" style={{ gap: 4, marginBottom: 4 }}>
                <input value={q.name} onChange={(e) => setB({ ...b, quick_filters: b.quick_filters.map((x: Json, ix: number) => (ix === i ? { ...x, name: e.target.value } : x)) })} style={{ width: 110 }} aria-label="Filter name" />
                <input className="mono" value={q.query} onChange={(e) => setB({ ...b, quick_filters: b.quick_filters.map((x: Json, ix: number) => (ix === i ? { ...x, query: e.target.value } : x)) })} style={{ flex: 1 }} aria-label="Filter query" />
                <button className="link-btn small" onClick={() => setB({ ...b, quick_filters: b.quick_filters.filter((_: Json, ix: number) => ix !== i) })} aria-label="Remove">
                  ✕
                </button>
              </div>
            ))}
            <button className="link-btn small" onClick={() => setB({ ...b, quick_filters: [...b.quick_filters, { name: 'Mine', query: 'assignee = currentUser()' }] })}>
              + Add quick filter
            </button>
          </div>
          <div>
            <h3 className="section-label">On the cards</h3>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              {[['points', 'Points'], ['assignee', 'Assignee'], ['priority', 'Priority'], ['due', 'Due date'], ['epic', 'Epic'], ['labels', 'Labels'], ['children', 'Child progress']].map(([k, l]) => (
                <label key={k} className="row small" style={{ gap: 4 }}>
                  <input type="checkbox" checked={b.card_fields.includes(k)} onChange={(e) => setB({ ...b, card_fields: e.target.checked ? [...b.card_fields, k] : b.card_fields.filter((x: string) => x !== k) })} /> {l}
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
const swap = <T,>(a: T[], i: number, j: number) => {
  const c = [...a];
  [c[i], c[j]] = [c[j]!, c[i]!];
  return c;
};

/* ───────────────────────── queries ───────────────────────── */

const EXAMPLES: [string, string][] = [
  ['My open items', 'assignee = currentUser() AND status not in (done, cancelled) ORDER BY priority DESC'],
  ['Open bugs by severity', 'type = bug AND status != done ORDER BY priority DESC, created ASC'],
  ['This sprint', 'sprint in openSprints() ORDER BY rank'],
  ['Updated this week', 'updated >= startOfWeek() ORDER BY updated DESC'],
  ['Overdue', 'due < now() AND status not in (done, cancelled)'],
  ['Unestimated stories', 'type = story AND points is empty AND status != done'],
];

export function QueriesView({ projectId, member }: { projectId: string | null; member: boolean }) {
  const base = projectId ? `/api/v1/projects/${projectId}/work` : '/api/v1/work';
  const [text, setText] = useState(EXAMPLES[0]![1]);
  const [ran, setRan] = useState(EXAMPLES[0]![1]);
  const [sel, setSel] = useState<string[]>([]);
  const [open, setOpen] = useState<Json | null>(null);
  const [bulk, setBulk] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const qc = useQueryClient();
  const run = useRun();
  const { data: saved } = useQuery({ queryKey: ['work', projectId ?? 'all', 'queries'], queryFn: () => get<Json[]>(`${base}/queries`) });
  const { data, error, isFetching } = useQuery({ queryKey: ['work', projectId ?? 'all', 'query', ran], queryFn: () => get<Json>(`${base}/query?limit=500&q=${encodeURIComponent(ran)}`), retry: false });
  useEffect(() => setSel([]), [ran]);
  const items = (data?.items ?? []) as Json[];
  const go = () => setRan(text);
  const saveAs = async () => {
    const name = window.prompt('Name this query', saved?.find((s) => s.id === savedId)?.name ?? '');
    if (!name) return;
    const shared = window.confirm('Share it with the team? (Cancel keeps it private)');
    const r = await run(() => post<Json>(`${base}/queries`, { name, query: text, shared }), 'Query saved');
    if (r) (setSavedId(r.id), qc.invalidateQueries({ queryKey: ['work', projectId ?? 'all', 'queries'] }));
  };
  return (
    <div className="queries">
      <aside className="q-side">
        <h3 className="section-label">Saved</h3>
        {(saved ?? []).map((s) => (
          <div key={s.id} className={`q-item${savedId === s.id ? ' on' : ''}`}>
            <button className="link-btn" onClick={() => (setSavedId(s.id), setText(s.query), setRan(s.query))}>
              {s.name}
            </button>
            <span className="muted small">{s.mine ? (s.shared ? 'shared' : 'private') : s.owner_name}</span>
            {s.mine && (
              <button className="link-btn small" aria-label={`Delete ${s.name}`} onClick={async () => window.confirm(`Delete “${s.name}”?`) && (await run(() => del(`${base}/queries/${s.id}`))) !== null && qc.invalidateQueries({ queryKey: ['work', projectId ?? 'all', 'queries'] })}>
                ✕
              </button>
            )}
          </div>
        ))}
        {!saved?.length && <p className="muted small">Save a query to keep it here.</p>}
        <h3 className="section-label" style={{ marginTop: 14 }}>
          Starters
        </h3>
        {EXAMPLES.map(([n, q]) => (
          <button key={n} className="link-btn small q-ex" onClick={() => (setSavedId(null), setText(q), setRan(q))}>
            {n}
          </button>
        ))}
      </aside>
      <div className="stack" style={{ minWidth: 0 }}>
        <div className="q-bar">
          <textarea className="mono" rows={2} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' && (e.ctrlKey || e.metaKey) ? (e.preventDefault(), go()) : null)} aria-label="Query" spellCheck={false} />
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary" onClick={go}>
              Run
            </button>
            <button className="btn" onClick={saveAs}>
              Save as…
            </button>
            {savedId && saved?.find((s) => s.id === savedId)?.mine && (
              <button className="btn" onClick={async () => (await run(() => put(`${base}/queries/${savedId}`, { name: saved.find((s) => s.id === savedId)!.name, query: text }), 'Saved')) && qc.invalidateQueries({ queryKey: ['work', projectId ?? 'all', 'queries'] })}>
                Save
              </button>
            )}
            <button className="btn" onClick={() => run(() => download(`${base}/query/export?q=${encodeURIComponent(ran)}`, 'work-items.csv'))}>
              Export CSV
            </button>
          </div>
        </div>
        <QueryHelp />
        {error ? (
          <div className="callout bad-text small">{(error as Error).message}</div>
        ) : !data ? (
          <Spinner />
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted small">
                {data.total} item{data.total === 1 ? '' : 's'} · {data.points} points{isFetching ? ' · updating…' : ''}
                {data.total > items.length && ` · showing ${items.length}`}
              </span>
              {member && projectId && sel.length > 0 && (
                <button className="btn small primary" onClick={() => setBulk(true)}>
                  Bulk change {sel.length}
                </button>
              )}
            </div>
            {!items.length ? (
              <Empty title="No matching items" />
            ) : (
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      {member && projectId && (
                        <th style={{ width: 28 }}>
                          <input type="checkbox" aria-label="Select all" checked={sel.length === items.length} onChange={(e) => setSel(e.target.checked ? items.map((i) => i.id) : [])} />
                        </th>
                      )}
                      <th>Key</th>
                      <th>Summary</th>
                      <th>State</th>
                      <th>Assignee</th>
                      <th>Priority</th>
                      <th className="num">Points</th>
                      <th>Sprint</th>
                      <th>Epic / parent</th>
                      {!projectId && <th>Project</th>}
                      <th>Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((i) => (
                      <tr key={i.id} className="click" onClick={() => setOpen(i)}>
                        {member && projectId && (
                          <td onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" aria-label={`Select ${i.key}`} checked={sel.includes(i.id)} onChange={(e) => setSel(e.target.checked ? [...sel, i.id] : sel.filter((x) => x !== i.id))} />
                          </td>
                        )}
                        <td className="nowrap">
                          {typeIcon(i.workType)} <span className="mono small">{i.key}</span>
                        </td>
                        <td style={{ whiteSpace: 'normal' }}>
                          {i.name}
                          {(i.tags as string[]).map((t) => (
                            <span key={t} className="chip" style={{ marginLeft: 4 }}>
                              {t}
                            </span>
                          ))}
                        </td>
                        <td>
                          <StateChip label={i.stateLabel} category={i.category} />
                        </td>
                        <td>{i.assigneeNames.join(', ') || <span className="muted">—</span>}</td>
                        <td title={i.priority}>
                          {priIcon(i.priority)} {i.priority}
                        </td>
                        <td className="num">{i.storyPoints ?? ''}</td>
                        <td className="small">{i.sprintName ?? ''}</td>
                        <td className="small">{i.parentKey ?? (i.epicName ? `⚡ ${i.epicName}` : '')}</td>
                        {!projectId && <td className="small">{i.projectName}</td>}
                        <td className="small nowrap">{date(i.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
      {open && <OpenItem projectId={open.projectId} id={open.id} onClose={() => setOpen(null)} />}
      {bulk && projectId && <BulkModal projectId={projectId} ids={sel} onClose={() => setBulk(false)} onDone={() => (setBulk(false), setSel([]), qc.invalidateQueries({ queryKey: ['work'] }))} />}
    </div>
  );
}

function OpenItem({ projectId, id, onClose }: { projectId: string; id: string; onClose: () => void }) {
  const [cur, setCur] = useState(id);
  return <WorkItemModal projectId={projectId} id={cur} onClose={onClose} onOpen={setCur} />;
}

function QueryHelp() {
  const [open, setOpen] = useState(false);
  return (
    <div className="small">
      <button className="link-btn small" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Query help'}
      </button>
      {open && (
        <div className="callout small q-help">
          <p style={{ margin: '0 0 6px' }}>
            Combine <code>field operator value</code> with <code>AND</code>, <code>OR</code>, <code>NOT</code> and brackets; end with <code>ORDER BY field DESC</code>. Ctrl+Enter runs.
          </p>
          <div className="grid2">
            <div>
              <strong>Fields</strong>: project, key, type, status, state, assignee, reporter, watcher, priority, severity, points, estimate, remaining, sprint, release, epic, parent, component, labels, text,
              summary, description, resolution, created, updated, due, resolved, started, and your custom fields by key.
            </div>
            <div>
              <strong>Operators</strong>: = != &gt; &gt;= &lt; &lt;= ~ (contains) !~ IN (…) NOT IN (…) IS EMPTY, IS NOT EMPTY. <strong>Values</strong>: currentUser(), openSprints(), currentSprint(), unreleasedVersions(), dates like
              2026-12-01, -7d, -2w, startOfWeek(), now(). Keys like FLEET-12.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BulkModal({ projectId, ids, onClose, onDone }: { projectId: string; ids: string[]; onClose: () => void; onDone: () => void }) {
  const team = useTeam(projectId);
  const { data: plan } = usePlanning(projectId);
  const { data: setup } = useWorkSetup(projectId);
  const toast = useToast();
  const [f, setF] = useState<Json>({ status: '', assignee: '-', priority: '', sprintId: '-', releaseId: '-', addLabels: '', removeLabels: '', addComponent: '', storyPoints: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (remove = false) => {
    if (remove && !window.confirm(`Delete ${ids.length} items? This cannot be undone.`)) return;
    const set: Json = {};
    if (f.status) set.status = f.status;
    if (f.assignee !== '-') set.assignee = f.assignee || null;
    if (f.priority) set.priority = f.priority;
    if (f.sprintId !== '-') set.sprintId = f.sprintId || null;
    if (f.releaseId !== '-') set.releaseId = f.releaseId || null;
    if (f.storyPoints !== '') set.storyPoints = Number(f.storyPoints);
    const add = String(f.addLabels).split(/[\s,]+/).filter(Boolean);
    const rem = String(f.removeLabels).split(/[\s,]+/).filter(Boolean);
    if (add.length) set.addLabels = add;
    if (rem.length) set.removeLabels = rem;
    if (f.addComponent) set.addComponent = f.addComponent;
    setBusy(true);
    try {
      const r = await post<{ done: number; failed: Json[] }>(`/api/v1/projects/${projectId}/work/bulk`, remove ? { ids, remove: true } : { ids, set });
      toast(`${r.done} changed${r.failed.length ? ` · ${r.failed.length} not: ${r.failed.map((x) => `${x.key} (${x.error})`).join('; ')}` : ''}`, r.failed.length > 0);
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const keep = <option value="-">— leave as is —</option>;
  return (
    <Modal
      title={`Change ${ids.length} items`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn danger" disabled={busy} onClick={() => submit(true)}>
            Delete
          </button>
          <button className="btn primary" disabled={busy} onClick={() => submit()}>
            Apply
          </button>
        </>
      }
    >
      <div className="modal-body grid2">
        <label className="field">
          Status (each through its workflow)
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="">— leave as is —</option>
            {CATS.map(([k, l]) => (
              <option key={k} value={k === 'todo' ? 'open' : k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Assignee
          <select value={f.assignee} onChange={(e) => setF({ ...f, assignee: e.target.value })}>
            {keep}
            <option value="">Unassigned</option>
            {team.map(([id, n]) => (
              <option key={id} value={id}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Priority
          <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
            <option value="">— leave as is —</option>
            {PRIORITIES.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Story points
          <input value={f.storyPoints} inputMode="decimal" onChange={(e) => setF({ ...f, storyPoints: e.target.value })} placeholder="leave as is" />
        </label>
        <label className="field">
          Sprint
          <select value={f.sprintId} onChange={(e) => setF({ ...f, sprintId: e.target.value })}>
            {keep}
            <option value="">Backlog</option>
            {((plan?.sprints ?? []) as Json[])
              .filter((s) => s.status !== 'closed')
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          Release
          <select value={f.releaseId} onChange={(e) => setF({ ...f, releaseId: e.target.value })}>
            {keep}
            <option value="">None</option>
            {((plan?.releases ?? []) as Json[]).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Add labels
          <input value={f.addLabels} onChange={(e) => setF({ ...f, addLabels: e.target.value })} />
        </label>
        <label className="field">
          Remove labels
          <input value={f.removeLabels} onChange={(e) => setF({ ...f, removeLabels: e.target.value })} />
        </label>
        <label className="field">
          Add component
          <select value={f.addComponent} onChange={(e) => setF({ ...f, addComponent: e.target.value })}>
            <option value="">—</option>
            {((setup?.components ?? []) as Json[]).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </Modal>
  );
}

/* ───────────────────────── hierarchy ───────────────────────── */

export function HierarchyTab({ id, member, onOpen }: { id: string; member: boolean; onOpen: (itemId: string) => void }) {
  const [open, setOpen] = useState(true);
  const { data } = useQuery({ queryKey: ['work', id, 'hierarchy', open], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/hierarchy?open=${open ? 1 : 0}`) });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [create, setCreate] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const toggle = (k: string) => setCollapsed((s) => (s.has(k) ? (s.delete(k), new Set(s)) : new Set(s.add(k))));
  const rows: { n: Json; depth: number }[] = [];
  const walk = (n: Json, depth: number) => {
    rows.push({ n, depth });
    if (!collapsed.has(n.id)) for (const c of n.children) walk(c, depth + 1);
  };
  for (const r of data.roots) walk(r, 0);
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Hide finished stories and tasks
        </label>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => setCollapsed(new Set(rows.filter((r) => r.n.children.length).map((r) => r.n.id)))}>
            Collapse all
          </button>
          <button className="btn small" onClick={() => setCollapsed(new Set())}>
            Expand all
          </button>
          {member && (
            <button className="btn primary small" onClick={() => setCreate({ workType: 'epic' })}>
              + Epic
            </button>
          )}
        </div>
      </div>
      {data.truncated && (
        <div className="callout small">
          This project has {data.total.toLocaleString()} items — showing {data.shown.toLocaleString()} (epics, features and open work first). Totals and progress count every item; use Queries to find the rest.
        </div>
      )}
      {!rows.length ? (
        <Empty title="Nothing planned yet">Start with an epic, break it into features and stories, then tasks.</Empty>
      ) : (
        <table className="data tree">
          <thead>
            <tr>
              <th>Item</th>
              <th>State</th>
              <th>Assignee</th>
              <th className="num">Points</th>
              <th style={{ width: 160 }}>Progress</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map(({ n, depth }) => (
              <tr key={n.id}>
                <td>
                  <div className="tree-cell" style={{ paddingLeft: depth * 20 }}>
                    {n.children.length ? (
                      <button className="link-btn tree-tog" aria-label={collapsed.has(n.id) ? 'Expand' : 'Collapse'} aria-expanded={!collapsed.has(n.id)} onClick={() => toggle(n.id)}>
                        {collapsed.has(n.id) ? '▸' : '▾'}
                      </button>
                    ) : (
                      <span className="tree-tog" />
                    )}
                    <span aria-hidden>{typeIcon(n.work_type)}</span>
                    <button className="link-btn" style={{ textAlign: 'left' }} onClick={() => onOpen(n.id)}>
                      <span className="mono small">{n.key}</span> {n.name}
                    </button>
                  </div>
                </td>
                <td>
                  <span className={`chip ${CAT_CLS[n.status] ?? ''}`}>{n.stateLabel}</span>
                </td>
                <td className="small">{(n.assignee_names ?? []).join(', ')}</td>
                <td className="num">{n.rollPoints || ''}</td>
                <td>{n.rollItems > 0 && <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><Progress done={n.rollClosed} total={n.rollItems} /> <span className="muted small nowrap">{n.rollClosed}/{n.rollItems}</span></div>}</td>
                <td>
                  {member && (CHILD_OF[n.work_type] ?? []).length > 0 && (
                    <button className="link-btn small" onClick={() => setCreate({ workType: CHILD_OF[n.work_type]![0], parentId: n.id, parentKey: `${n.key} ${n.name}` })}>
                      + child
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {create && <CreateItemModal projectId={id} defaults={create} onClose={() => setCreate(null)} onCreated={() => setCreate(null)} />}
    </div>
  );
}
const CHILD_OF: Record<string, string[]> = { epic: ['feature', 'story'], feature: ['story', 'bug'], story: ['subtask', 'task'], bug: ['subtask', 'task'], task: ['subtask'], spike: ['subtask'], chore: ['subtask'] };

/* ───────────────────────── dashboards & reports ───────────────────────── */

const WIDGET_TYPES: [string, string][] = [
  ['count', 'Number from a query'],
  ['breakdown', 'Breakdown of a query'],
  ['list', 'Item list from a query'],
  ['cfd', 'Cumulative flow'],
  ['cycle', 'Cycle & lead time'],
  ['created_resolved', 'Created vs resolved'],
  ['workload', 'Workload by person'],
  ['sprint', 'Sprint report (scope change)'],
  ['time_in_status', 'Time in each state'],
  ['release_burnup', 'Release burn-up'],
];

export function DashboardsTab({ id, onOpen }: { id: string; onOpen: (itemId: string) => void }) {
  const { data } = useQuery({ queryKey: ['work', id, 'dashboards'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/dashboards`) });
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<Json | null>(null);
  const run = useRun();
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const list = data.dashboards as Json[];
  const dash = list.find((d) => d.id === sel) ?? list[0] ?? { id: null, name: 'Project overview', widgets: data.starter, starter: true };
  const saveDash = async (d: Json) => {
    const body = { name: d.name, widgets: d.widgets, shared: d.shared ?? true };
    const r = await run(() => (d.id ? put<Json>(`/api/v1/projects/${id}/work/dashboards/${d.id}`, body) : post<Json>(`/api/v1/projects/${id}/work/dashboards`, body)), 'Dashboard saved');
    if (r) (setSel(r.id), setEditing(null), qc.invalidateQueries({ queryKey: ['work', id, 'dashboards'] }));
  };
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="row" style={{ gap: 6 }}>
          {list.length > 1 ? (
            <select value={dash.id ?? ''} onChange={(e) => setSel(e.target.value)} aria-label="Dashboard">
              {list.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          ) : (
            <strong>{dash.name}</strong>
          )}
          {dash.starter && <span className="muted small">starter layout — save it to change it</span>}
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => setEditing({ ...dash, widgets: [...dash.widgets] })}>
            {dash.starter ? 'Customise' : 'Edit'}
          </button>
          <button className="btn small" onClick={() => setEditing({ id: null, name: 'New dashboard', widgets: [], shared: true })}>
            New dashboard
          </button>
        </div>
      </div>
      <div className="dash-grid">
        {(dash.widgets as Json[]).map((w) => (
          <WidgetCard key={w.id} projectId={id} w={w} onOpen={onOpen} />
        ))}
      </div>
      {editing && (
        <Modal
          title="Dashboard"
          onClose={() => setEditing(null)}
          wide
          footer={
            <>
              {editing.id && editing.mine && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this dashboard?') && (await run(() => del(`/api/v1/projects/${id}/work/dashboards/${editing.id}`), 'Deleted')) !== null && (setEditing(null), setSel(null), qc.invalidateQueries({ queryKey: ['work', id, 'dashboards'] }))}>
                  Delete
                </button>
              )}
              <button className="btn primary" onClick={() => saveDash(editing)}>
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="grid2">
              <label className="field">
                Name
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </label>
              <label className="row small" style={{ gap: 6, alignSelf: 'end' }}>
                <input type="checkbox" checked={editing.shared ?? true} onChange={(e) => setEditing({ ...editing, shared: e.target.checked })} /> Shared with the team
              </label>
            </div>
            {(editing.widgets as Json[]).map((w, i) => (
              <div key={w.id} className="callout">
                <div className="grid2">
                  <label className="field">
                    Title
                    <input value={w.title} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, title: e.target.value } : x)) })} />
                  </label>
                  <label className="field">
                    Widget
                    <select value={w.type} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, type: e.target.value } : x)) })}>
                      {WIDGET_TYPES.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  {['count', 'breakdown', 'list'].includes(w.type) && (
                    <label className="field wide">
                      Query
                      <input className="mono" value={w.query ?? ''} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, query: e.target.value } : x)) })} />
                    </label>
                  )}
                  {w.type === 'breakdown' && (
                    <label className="field">
                      Group by
                      <select value={w.groupBy ?? 'status'} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, groupBy: e.target.value } : x)) })}>
                        {['status', 'state', 'assignee', 'type', 'priority', 'sprint', 'component', 'epic', 'release', 'labels'].map((g) => (
                          <option key={g}>{g}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {['cfd', 'cycle', 'created_resolved'].includes(w.type) && (
                    <label className="field">
                      Days
                      <input type="number" min={7} max={365} value={w.days ?? 30} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, days: Number(e.target.value) } : x)) })} />
                    </label>
                  )}
                  <label className="field">
                    Size
                    <select value={w.size ?? 'medium'} onChange={(e) => setEditing({ ...editing, widgets: editing.widgets.map((x: Json, ix: number) => (ix === i ? { ...x, size: e.target.value } : x)) })}>
                      {['small', 'medium', 'large'].map((g) => (
                        <option key={g}>{g}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="link-btn small" disabled={i === 0} onClick={() => setEditing({ ...editing, widgets: swap(editing.widgets, i, i - 1) })}>
                    Move up
                  </button>
                  <button className="link-btn small" onClick={() => setEditing({ ...editing, widgets: editing.widgets.filter((_: Json, ix: number) => ix !== i) })}>
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button className="btn small" onClick={() => setEditing({ ...editing, widgets: [...editing.widgets, { id: `w${Date.now()}`, type: 'count', title: 'New widget', query: 'status != done', size: 'small' }] })}>
              + Add widget
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const CAT_LABEL: Record<string, string> = { todo: 'To do', open: 'To do', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done', cancelled: 'Cancelled' };

function WidgetCard({ projectId, w, onOpen }: { projectId: string; w: Json; onOpen: (id: string) => void }) {
  const { data, error } = useQuery({ queryKey: ['work', projectId, 'widget', w], queryFn: () => post<Json>(`/api/v1/projects/${projectId}/work/widget`, w), retry: false });
  return (
    <section className={`panel dash-w ${w.size ?? 'medium'}`}>
      <div className="panel-head">
        <h3 style={{ margin: 0, fontSize: 14 }}>{w.title}</h3>
      </div>
      <div className="panel-body">{error ? <span className="bad-text small">{(error as Error).message}</span> : !data ? <Spinner /> : <WidgetBody w={w} d={data} onOpen={onOpen} projectId={projectId} />}</div>
    </section>
  );
}

function WidgetBody({ w, d, onOpen }: { w: Json; d: Json; onOpen: (id: string) => void; projectId: string }) {
  if (w.type === 'count') return <div className="dash-num">{d.total}</div>;
  if (w.type === 'breakdown')
    return d.groups.length ? (
      <Chart id={`w-${w.id}`} height={220} initial={d.groups.length <= 6 ? 'donut' : 'hbar'} data={{ categories: d.groups.map((g: Json) => (w.groupBy === 'status' ? CAT_LABEL[g.label] ?? g.label : g.label)), series: [{ label: 'Items', values: d.groups.map((g: Json) => g.count) }] }} />
    ) : (
      <p className="muted small">Nothing matches.</p>
    );
  if (w.type === 'list')
    return (
      <table className="data compact">
        <tbody>
          {(d.items as Json[]).map((i) => (
            <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
              <td className="nowrap">
                {typeIcon(i.workType)} <span className="mono small">{i.key}</span>
              </td>
              <td style={{ whiteSpace: 'normal' }}>{i.name}</td>
              <td>
                <StateChip label={i.stateLabel} category={i.category} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  if (w.type === 'cfd') return <CfdChart d={d} id={`w-${w.id}`} />;
  if (w.type === 'cycle') return <CycleView d={d} onOpen={onOpen} id={`w-${w.id}`} />;
  if (w.type === 'created_resolved')
    return <Chart id={`w-${w.id}`} height={220} initial="line" data={{ categories: d.rows.map((r: Json) => date(r.period)), series: [{ label: 'Created', values: d.rows.map((r: Json) => r.created) }, { label: 'Resolved', values: d.rows.map((r: Json) => r.resolved) }] }} />;
  if (w.type === 'workload') return <WorkloadTable rows={d.rows} />;
  if (w.type === 'sprint') return <SprintReportView d={d} onOpen={onOpen} />;
  if (w.type === 'time_in_status') return <TimeInStatusView d={d} id={`w-${w.id}`} />;
  if (w.type === 'release_burnup') return <BurnupView d={d} id={`w-${w.id}`} />;
  return null;
}

function CfdChart({ d, id }: { d: Json; id: string }) {
  const order = ['open', 'in_progress', 'blocked', 'review', 'done'];
  const series = order.map((s) => (d.series as Json[]).find((x) => x.status === s)).filter(Boolean) as Json[];
  return <Chart id={id} height={240} initial="stacked" data={{ categories: d.days.map((x: string) => date(x)), series: series.map((s) => ({ label: CAT_LABEL[s.status] ?? s.status, values: s.values })) }} />;
}

function CycleView({ d, onOpen, id }: { d: Json; onOpen: (id: string) => void; id: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="stack">
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <Stat label="Cycle time (avg)" v={d.cycle.avg} />
        <Stat label="85% within" v={d.cycle.p85} />
        <Stat label="Lead time (avg)" v={d.lead.avg} />
        <Stat label="Finished" v={d.items.length} unit="" />
      </div>
      {d.throughput.length > 0 && <Chart id={id} height={160} initial="bar" switcher={false} data={{ categories: d.throughput.map((t: Json) => `wk ${date(t.week)}`), series: [{ label: 'Finished', values: d.throughput.map((t: Json) => t.n) }] }} />}
      {d.items.length > 0 && (
        <button className="link-btn small" onClick={() => setShow(!show)}>
          {show ? 'Hide items' : 'Show items'}
        </button>
      )}
      {show && (
        <table className="data compact">
          <tbody>
            {(d.items as Json[])
              .slice()
              .reverse()
              .map((i) => (
                <tr key={i.id} className="click" onClick={() => onOpen(i.id)}>
                  <td className="mono small">{i.key}</td>
                  <td style={{ whiteSpace: 'normal' }}>{i.name}</td>
                  <td className="num small">{i.cycleDays} d</td>
                  <td className="num small muted">{i.leadDays} d</td>
                </tr>
              ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, v, unit = ' d' }: { label: string; v: number | null; unit?: string }) {
  return (
    <div>
      <div className="muted small">{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>{v === null || v === undefined ? '—' : `${v}${unit}`}</div>
    </div>
  );
}

function WorkloadTable({ rows }: { rows: Json[] }) {
  if (!rows.length) return <p className="muted small">No open work.</p>;
  return (
    <table className="data compact">
      <thead>
        <tr>
          <th>Person</th>
          <th className="num">Items</th>
          <th className="num">In progress</th>
          <th className="num">Points</th>
          <th className="num">Hours left</th>
          <th className="num">Overdue</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.person}>
            <td>{r.person}</td>
            <td className="num">{r.items}</td>
            <td className="num">{r.in_progress}</td>
            <td className="num">{r.points}</td>
            <td className="num">{Math.round(r.hours * 10) / 10}</td>
            <td className={`num${r.overdue ? ' bad-text' : ''}`}>{r.overdue || ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ───────────────────────── tests ───────────────────────── */

const RESULT_CLS: Record<string, string> = { passed: 'good', failed: 'bad', blocked: 'warn', skipped: '', untested: '' };

export function TestsTab({ id, member, onOpen }: { id: string; member: boolean; onOpen: (itemId: string) => void }) {
  const [view, setView] = useState<'plans' | 'cases' | 'coverage'>('plans');
  const [plan, setPlan] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="seg">
        {(
          [
            ['plans', 'Test plans'],
            ['cases', 'Test cases'],
            ['coverage', 'Coverage'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={view === k ? 'on' : ''} onClick={() => (setView(k), setPlan(null))}>
            {l}
          </button>
        ))}
      </div>
      {view === 'plans' && (plan ? <PlanRun id={id} planId={plan} member={member} onBack={() => setPlan(null)} onOpen={onOpen} /> : <Plans id={id} member={member} onOpen={setPlan} />)}
      {view === 'cases' && <Cases id={id} member={member} />}
      {view === 'coverage' && <Coverage id={id} onOpen={onOpen} />}
    </div>
  );
}

function Plans({ id, member, onOpen }: { id: string; member: boolean; onOpen: (planId: string) => void }) {
  const { data } = useQuery({ queryKey: ['work', id, 'test-plans'], queryFn: () => get<Json[]>(`/api/v1/projects/${id}/work/tests/plans`) });
  const { data: cases } = useQuery({ queryKey: ['work', id, 'test-cases'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/tests/cases`) });
  const { data: plan } = usePlanning(id);
  const [f, setF] = useState<Json | null>(null);
  const run = useRun();
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const suites = [...new Set(((cases?.cases ?? []) as Json[]).map((c) => c.suite).filter(Boolean))];
  return (
    <div className="stack">
      {member && (
        <div>
          <button className="btn primary small" onClick={() => setF({ name: '', sprintId: '', releaseId: '', suite: '', covering: true })}>
            + Test plan
          </button>
        </div>
      )}
      {!data.length ? (
        <Empty title="No test plans">A plan groups test cases for a sprint or a release; testers record pass / fail per step and raise bugs.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Plan</th>
              <th>For</th>
              <th style={{ width: 200 }}>Results</th>
              <th className="num">Cases</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.id} className="click" onClick={() => onOpen(p.id)}>
                <td>{p.name}</td>
                <td className="small">{p.sprint_name ?? p.release_name ?? '—'}</td>
                <td>
                  <ResultBar p={p} />
                </td>
                <td className="num">{p.cases}</td>
                <td>
                  <span className="chip">{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f && (
        <Modal
          title="New test plan"
          onClose={() => setF(null)}
          footer={
            <button
              className="btn primary"
              disabled={!f.name.trim()}
              onClick={async () => {
                const r = await run(() => post<Json>(`/api/v1/projects/${id}/work/tests/plans`, { name: f.name, sprintId: f.sprintId || null, releaseId: f.releaseId || null, suite: f.suite || null }), 'Plan created');
                if (r && f.covering && (f.sprintId || f.releaseId)) await run(() => post(`/api/v1/projects/${id}/work/tests/plans/${r.id}/cases`, { caseIds: [], covering: true }));
                if (r) (setF(null), qc.invalidateQueries({ queryKey: ['work', id] }), onOpen(r.id));
              }}
            >
              Create
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Name
              <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Sprint 4 regression" />
            </label>
            <label className="field">
              Sprint
              <select value={f.sprintId} onChange={(e) => setF({ ...f, sprintId: e.target.value })}>
                <option value="">—</option>
                {((plan?.sprints ?? []) as Json[]).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Release
              <select value={f.releaseId} onChange={(e) => setF({ ...f, releaseId: e.target.value })}>
                <option value="">—</option>
                {((plan?.releases ?? []) as Json[]).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Add a whole suite
              <select value={f.suite} onChange={(e) => setF({ ...f, suite: e.target.value })}>
                <option value="">—</option>
                {suites.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={f.covering} onChange={(e) => setF({ ...f, covering: e.target.checked })} /> Add the cases covering the sprint’s / release’s items
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ResultBar({ p }: { p: Json }) {
  const total = p.cases || 1;
  const seg = (n: number, cls: string, l: string) => (n ? <span className={`rb ${cls}`} style={{ width: `${(n / total) * 100}%` }} title={`${n} ${l}`} /> : null);
  return (
    <div className="result-bar" aria-label={`${p.passed} passed, ${p.failed} failed, ${p.blocked} blocked, ${p.untested} not run`}>
      {seg(p.passed, 'good', 'passed')}
      {seg(p.failed, 'bad', 'failed')}
      {seg(p.blocked, 'warn', 'blocked')}
      {seg(p.skipped, 'skip', 'skipped')}
    </div>
  );
}

function PlanRun({ id, planId, member, onBack, onOpen }: { id: string; planId: string; member: boolean; onBack: () => void; onOpen: (itemId: string) => void }) {
  const { data } = useQuery({ queryKey: ['work', id, 'test-plan', planId], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/tests/plans/${planId}`) });
  const { data: cases } = useQuery({ queryKey: ['work', id, 'test-cases'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/tests/cases`) });
  const [runCase, setRunCase] = useState<Json | null>(null);
  const [adding, setAdding] = useState(false);
  const run = useRun();
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const inPlan = new Set((data.runs as Json[]).map((r) => r.case_id));
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <button className="link-btn small" onClick={onBack}>
            ← Test plans
          </button>
          <h3 style={{ margin: '4px 0 0' }}>{data.plan.name}</h3>
        </div>
        {member && (
          <button className="btn small" onClick={() => setAdding(true)}>
            + Add cases
          </button>
        )}
      </div>
      {!data.runs.length ? (
        <Empty title="No cases in this plan" />
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Case</th>
              <th>Suite</th>
              <th>Result</th>
              <th>Tester</th>
              <th>Bug</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data.runs as Json[]).map((r) => (
              <tr key={r.id}>
                <td style={{ whiteSpace: 'normal' }}>
                  <span className="mono small">{r.key}</span> {r.title}
                </td>
                <td className="small">{r.suite ?? ''}</td>
                <td>
                  <span className={`chip ${RESULT_CLS[r.result]}`}>{r.result}</span>
                </td>
                <td className="small">
                  {r.tester ?? ''}
                  {r.run_at && <div className="muted">{date(r.run_at)}</div>}
                </td>
                <td>{r.bug_id && <button className="link-btn small" onClick={() => onOpen(r.bug_id)}>🐞 {r.bugKey}</button>}</td>
                <td className="nowrap">
                  {member && (
                    <>
                      <button className="btn small primary" onClick={() => setRunCase(r)}>
                        Run
                      </button>{' '}
                      <button className="link-btn small" aria-label="Remove from plan" onClick={async () => (await run(() => del(`/api/v1/projects/${id}/work/tests/plans/${planId}/cases/${r.case_id}`))) !== null && qc.invalidateQueries({ queryKey: ['work', id] })}>
                        ✕
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {runCase && <RunDialog id={id} planId={planId} r={runCase} onClose={() => setRunCase(null)} onDone={() => (setRunCase(null), qc.invalidateQueries({ queryKey: ['work', id] }))} />}
      {adding && (
        <Modal title="Add cases" onClose={() => setAdding(false)} wide>
          <div className="modal-body">
            <table className="data compact">
              <tbody>
                {((cases?.cases ?? []) as Json[])
                  .filter((c) => c.status !== 'obsolete' && !inPlan.has(c.id))
                  .map((c) => (
                    <tr key={c.id}>
                      <td className="mono small">{c.key}</td>
                      <td style={{ whiteSpace: 'normal' }}>{c.title}</td>
                      <td className="small">{c.suite}</td>
                      <td>
                        <button className="btn small" onClick={async () => (await run(() => post(`/api/v1/projects/${id}/work/tests/plans/${planId}/cases`, { caseIds: [c.id] }))) !== null && qc.invalidateQueries({ queryKey: ['work', id] })}>
                          Add
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RunDialog({ id, planId, r, onClose, onDone }: { id: string; planId: string; r: Json; onClose: () => void; onDone: () => void }) {
  const steps = r.steps as Json[];
  const [res, setRes] = useState<(string | null)[]>(() => steps.map((_, i) => (r.step_results ?? [])[i] ?? null));
  const [notes, setNotes] = useState(r.notes ?? '');
  const [bug, setBug] = useState(true);
  const run = useRun();
  const auto = res.includes('failed') ? 'failed' : steps.length && res.every((x) => x === 'passed') ? 'passed' : null;
  const save = async (result: string) => {
    const out = await run(() => put<Json>(`/api/v1/projects/${id}/work/tests/plans/${planId}/runs/${r.case_id}`, { result, notes: notes || null, stepResults: res, createBug: result === 'failed' && bug && !r.bug_id }), result === 'failed' && bug && !r.bug_id ? 'Failed — bug raised' : `Marked ${result}`);
    if (out) onDone();
  };
  return (
    <Modal
      title={`${r.key} ${r.title}`}
      onClose={onClose}
      wide
      footer={
        <>
          {['blocked', 'skipped'].map((x) => (
            <button key={x} className="btn" onClick={() => save(x)}>
              {x === 'blocked' ? 'Blocked' : 'Skip'}
            </button>
          ))}
          <button className="btn danger" onClick={() => save('failed')}>
            Fail
          </button>
          <button className={`btn${auto === 'passed' ? ' primary' : ''}`} onClick={() => save('passed')}>
            Pass
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        {r.preconditions && <div className="callout small">Preconditions: {r.preconditions}</div>}
        <table className="data">
          <thead>
            <tr>
              <th>#</th>
              <th>Action</th>
              <th>Expected</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td style={{ whiteSpace: 'normal' }}>{s.action}</td>
                <td style={{ whiteSpace: 'normal' }}>{s.expected}</td>
                <td className="nowrap">
                  {(['passed', 'failed'] as const).map((x) => (
                    <button key={x} className={`btn small${res[i] === x ? (x === 'passed' ? ' primary' : ' danger') : ''}`} aria-pressed={res[i] === x} onClick={() => setRes(res.map((v, ix) => (ix === i ? (v === x ? null : x) : v)))}>
                      {x === 'passed' ? '✓' : '✗'}
                    </button>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <label className="field">
          Notes
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {!r.bug_id && (
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={bug} onChange={(e) => setBug(e.target.checked)} /> Raise a bug if it fails (with the steps)
          </label>
        )}
      </div>
    </Modal>
  );
}

function Cases({ id, member }: { id: string; member: boolean }) {
  const { data } = useQuery({ queryKey: ['work', id, 'test-cases'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/tests/cases`) });
  const [f, setF] = useState<Json | null>(null);
  const run = useRun();
  const qc = useQueryClient();
  if (!data) return <Spinner />;
  const save = async () => {
    const body = { title: f!.title, suite: f!.suite || null, preconditions: f!.preconditions || null, steps: f!.steps, priority: f!.priority, status: f!.status, itemIds: f!.itemIds, automated: f!.automated };
    const r = await run(() => (f!.id ? put(`/api/v1/projects/${id}/work/tests/cases/${f!.id}`, body) : post(`/api/v1/projects/${id}/work/tests/cases`, body)), 'Test case saved');
    if (r) (setF(null), qc.invalidateQueries({ queryKey: ['work', id] }));
  };
  return (
    <div className="stack">
      {member && (
        <div>
          <button className="btn primary small" onClick={() => setF({ title: '', suite: '', preconditions: '', steps: [{ action: '', expected: '' }], priority: 'medium', status: 'ready', itemIds: [], itemKeys: [], automated: false })}>
            + Test case
          </button>
        </div>
      )}
      {!data.cases.length ? (
        <Empty title="No test cases">Write steps with expected results and link the stories they verify.</Empty>
      ) : (
        <table className="data">
          <thead>
            <tr>
              <th>Case</th>
              <th>Suite</th>
              <th>Covers</th>
              <th>Steps</th>
              <th>Last result</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(data.cases as Json[]).map((c) => (
              <tr key={c.id} className={member ? 'click' : ''} onClick={() => member && setF({ ...c, steps: c.steps.length ? c.steps : [{ action: '', expected: '' }], itemIds: c.item_ids, itemKeys: c.item_keys ?? [] })}>
                <td style={{ whiteSpace: 'normal' }}>
                  <span className="mono small">{c.key}</span> {c.title} {c.automated && <span className="chip info">automated</span>}
                </td>
                <td className="small">{c.suite}</td>
                <td className="small">{(c.item_keys ?? []).join(', ')}</td>
                <td className="num">{c.steps.length}</td>
                <td>{c.last_result ? <span className={`chip ${RESULT_CLS[c.last_result]}`}>{c.last_result}</span> : <span className="muted small">not run</span>}</td>
                <td>
                  <span className="chip">{c.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {f && (
        <Modal
          title={f.id ? f.key : 'New test case'}
          onClose={() => setF(null)}
          xl
          footer={
            <>
              {f.id && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this case? (A case already run becomes obsolete instead.)') && (await run(() => del(`/api/v1/projects/${id}/work/tests/cases/${f.id}`), 'Removed')) !== null && (setF(null), qc.invalidateQueries({ queryKey: ['work', id] }))}>
                  Delete
                </button>
              )}
              <button className="btn primary" disabled={!f.title.trim()} onClick={save}>
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <div className="grid2">
              <label className="field wide">
                Title
                <input autoFocus value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
              </label>
              <label className="field">
                Suite
                <input value={f.suite ?? ''} onChange={(e) => setF({ ...f, suite: e.target.value })} placeholder="e.g. Maps" />
              </label>
              <label className="field">
                Priority
                <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>
                  {['critical', 'high', 'medium', 'low'].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="field wide">
                Preconditions
                <input value={f.preconditions ?? ''} onChange={(e) => setF({ ...f, preconditions: e.target.value })} />
              </label>
            </div>
            <table className="data compact">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Action</th>
                  <th>Expected result</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(f.steps as Json[]).map((s, i) => (
                  <tr key={i}>
                    <td>{i + 1}</td>
                    <td>
                      <input value={s.action} onChange={(e) => setF({ ...f, steps: f.steps.map((x: Json, ix: number) => (ix === i ? { ...x, action: e.target.value } : x)) })} aria-label={`Step ${i + 1} action`} style={{ width: '100%' }} />
                    </td>
                    <td>
                      <input value={s.expected ?? ''} onChange={(e) => setF({ ...f, steps: f.steps.map((x: Json, ix: number) => (ix === i ? { ...x, expected: e.target.value } : x)) })} aria-label={`Step ${i + 1} expected`} style={{ width: '100%' }} />
                    </td>
                    <td>
                      <button className="link-btn small" onClick={() => setF({ ...f, steps: f.steps.filter((_: Json, ix: number) => ix !== i) })} aria-label="Remove step">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="link-btn small" onClick={() => setF({ ...f, steps: [...f.steps, { action: '', expected: '' }] })}>
              + Step
            </button>
            <CoversPicker projectId={id} ids={f.itemIds} keys={f.itemKeys} onChange={(ids, keys) => setF({ ...f, itemIds: ids, itemKeys: keys })} />
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={!!f.automated} onChange={(e) => setF({ ...f, automated: e.target.checked })} /> Automated
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CoversPicker({ projectId, ids, keys, onChange }: { projectId: string; ids: string[]; keys: string[]; onChange: (ids: string[], keys: string[]) => void }) {
  const [s, setS] = useState('');
  const q = `type in (story, feature, bug) AND status != cancelled${s.trim() ? ` AND text ~ ${JSON.stringify(s.trim())}` : ''}`;
  const { data } = useQuery({ queryKey: ['work', projectId, 'covers', q], queryFn: () => get<Json>(`/api/v1/projects/${projectId}/work/query?limit=12&q=${encodeURIComponent(q)}`) });
  return (
    <div className="field">
      Covers (requirements)
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {ids.map((x, i) => (
          <span key={x} className="chip">
            {keys[i] ?? 'item'}{' '}
            <button className="link-btn" aria-label="Remove" onClick={() => onChange(ids.filter((y) => y !== x), keys.filter((_, ix) => ix !== i))}>
              ✕
            </button>
          </span>
        ))}
      </div>
      <input value={s} onChange={(e) => setS(e.target.value)} placeholder="Find a story" />
      <div className="pick-list" style={{ maxHeight: 130 }}>
        {((data?.items ?? []) as Json[])
          .filter((x) => !ids.includes(x.id))
          .map((x) => (
            <button key={x.id} type="button" className="link-btn small" style={{ textAlign: 'left' }} onClick={() => onChange([...ids, x.id], [...keys, x.key])}>
              {typeIcon(x.workType)} {x.key} {x.name}
            </button>
          ))}
      </div>
    </div>
  );
}

function Coverage({ id, onOpen }: { id: string; onOpen: (itemId: string) => void }) {
  const { data } = useQuery({ queryKey: ['work', id, 'coverage'], queryFn: () => get<Json[]>(`/api/v1/projects/${id}/work/tests/coverage`) });
  if (!data) return <Spinner />;
  const uncovered = data.filter((r) => !r.cases).length;
  return (
    <div className="stack">
      <p className="muted small" style={{ margin: 0 }}>
        {data.length - uncovered} of {data.length} stories, features and bugs have test cases.
      </p>
      <table className="data">
        <thead>
          <tr>
            <th>Item</th>
            <th>State</th>
            <th className="num">Cases</th>
            <th className="num">Passed</th>
            <th className="num">Failed</th>
            <th className="num">Not run</th>
          </tr>
        </thead>
        <tbody>
          {data.map((r) => (
            <tr key={r.id} className="click" onClick={() => onOpen(r.id)}>
              <td style={{ whiteSpace: 'normal' }}>
                {typeIcon(r.work_type)} <span className="mono small">{r.key}</span> {r.name}
              </td>
              <td>
                <span className={`chip ${CAT_CLS[r.status]}`}>{r.status.replace('_', ' ')}</span>
              </td>
              <td className={`num${!r.cases ? ' warn-text' : ''}`}>{r.cases || 'none'}</td>
              <td className="num">{r.passed || ''}</td>
              <td className={`num${r.failed ? ' bad-text' : ''}`}>{r.failed || ''}</td>
              <td className="num">{r.not_run || ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── setup ───────────────────────── */

export function WorkSetupTab({ id, manage }: { id: string; manage: boolean }) {
  const { data } = useWorkSetup(id);
  const { can } = useAuth();
  const team = useTeam(id);
  const run = useRun();
  const qc = useQueryClient();
  const reload = () => qc.invalidateQueries({ queryKey: ['work', id] });
  const [wf, setWf] = useState<Json | null>(null);
  const [key, setKey] = useState('');
  const [comp, setComp] = useState<Json | null>(null);
  const [field, setField] = useState<Json | null>(null);
  useEffect(() => setKey(data?.key ?? ''), [data?.key]);
  if (!data) return <Spinner />;
  const auto = (data.settings.autoTransitions ?? {}) as Json;
  const states = [...new Map(((data.workflows.length ? data.workflows : [data.defaultWorkflow]) as Json[]).flatMap((w) => w.states.map((s: Json) => [s.key, s]))).values()] as Json[];
  const isAdmin = can('developers');
  return (
    <div className="stack" data-export="off">
      <section className="callout">
        <div className="grid2">
          <div>
            <h3 className="section-label">Work item key</h3>
            <div className="row" style={{ gap: 6 }}>
              <input className="mono" value={key} disabled={!manage} onChange={(e) => setKey(e.target.value.toUpperCase())} style={{ width: 120 }} aria-label="Key" />
              {manage && key !== data.key && (
                <button className="btn small" onClick={async () => (await run(() => put(`/api/v1/projects/${id}/work/key`, { key }), 'Key changed')) && reload()}>
                  Save
                </button>
              )}
            </div>
            <p className="muted small">Items are numbered {data.key}-1, {data.key}-2 … Mention a key in a branch, commit or PR to link code.</p>
          </div>
          <div>
            <h3 className="section-label">Automation from code</h3>
            {(
              [
                ['branch', 'Branch created'],
                ['prOpened', 'Pull request opened'],
                ['prMerged', 'Pull request merged'],
                ['buildFailed', 'Build failed'],
              ] as const
            ).map(([k, l]) => (
              <label key={k} className="row small" style={{ gap: 6, marginBottom: 4 }}>
                <span style={{ width: 150 }}>{l} →</span>
                <select disabled={!manage} value={auto[k] ?? ''} onChange={async (e) => (await run(() => put(`/api/v1/projects/${id}/work/settings`, { autoTransitions: { ...auto, [k]: e.target.value || null } }), 'Saved')) && reload()}>
                  <option value="">Do nothing</option>
                  {states.map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 className="section-label">Workflows</h3>
          {manage && (
            <button className="btn small" onClick={() => setWf({ id: null, name: 'New workflow', workTypes: [], states: data.defaultWorkflow.states.map((s: Json) => ({ ...s })), transitions: [] })}>
              + Workflow
            </button>
          )}
        </div>
        <table className="data compact">
          <thead>
            <tr>
              <th>Workflow</th>
              <th>Types</th>
              <th>States</th>
              <th>Moves</th>
            </tr>
          </thead>
          <tbody>
            {(data.workflows.length ? data.workflows : [{ ...data.defaultWorkflow, isDefault: true }]).map((w: Json) => (
              <tr key={w.id ?? 'default'} className={manage ? 'click' : ''} onClick={() => manage && setWf(w.isDefault ? { ...w, id: null, name: 'Custom', isDefault: false } : w)}>
                <td>{w.name}</td>
                <td className="small">{w.workTypes.length ? w.workTypes.map(typeLabel).join(', ') : 'All other types'}</td>
                <td>
                  <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
                    {w.states.map((s: Json) => (
                      <span key={s.key} className={`chip ${CAT_CLS[s.category]}`}>
                        {s.label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="small">{w.transitions.length ? `${w.transitions.length} defined` : 'Any → any'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <div className="grid2">
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="section-label">Components</h3>
            {manage && (
              <button className="btn small" onClick={() => setComp({ name: '', description: '', leadId: '', assignLead: false })}>
                + Component
              </button>
            )}
          </div>
          {!data.components.length ? (
            <p className="muted small">Areas of the product (Mobile app, API, Billing) with a lead who can take new items.</p>
          ) : (
            <table className="data compact">
              <tbody>
                {(data.components as Json[]).map((c) => (
                  <tr key={c.id} className={manage ? 'click' : ''} onClick={() => manage && setComp({ ...c, leadId: c.lead_id ?? '', assignLead: c.assign_lead })}>
                    <td>{c.name}</td>
                    <td className="small">{c.lead_name ?? '—'}{c.assign_lead && ' · auto-assign'}</td>
                    <td className="num small">{c.open_items} open</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 className="section-label">Custom fields</h3>
            {manage && (
              <button className="btn small" onClick={() => setField({ key: '', label: '', type: 'text', options: '', workTypes: [], required: false })}>
                + Field
              </button>
            )}
          </div>
          {!data.fields.length ? (
            <p className="muted small">Extra fields per item type — e.g. Browser on bugs, Customer on stories. Queryable by key.</p>
          ) : (
            <table className="data compact">
              <tbody>
                {(data.fields as Json[]).map((f) => (
                  <tr key={f.id} className={manage ? 'click' : ''} onClick={() => manage && setField({ ...f, options: f.options.join(', '), workTypes: f.work_types })}>
                    <td>
                      {f.label} <span className="mono small muted">{f.key}</span>
                    </td>
                    <td className="small">{f.type}{f.required && ' · required'}</td>
                    <td className="small">{f.work_types.length ? f.work_types.map(typeLabel).join(', ') : 'All types'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <ReposSection id={id} manage={manage} />
      {manage && (
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={!!data.settings.noCode} onChange={async (e) => (await run(() => put(`/api/v1/projects/${id}/work/settings`, { noCode: e.target.checked }), 'Saved')) && reload()} />
          This project has no code (exempt from the workspace rule that every project needs a repository)
        </label>
      )}

      <TemplatesSection id={id} manage={manage} />

      {isAdmin && <GitHubAppSection />}
      {isAdmin && <DevConnections />}

      {wf && <WorkflowEditor projectId={id} wf={wf} onClose={() => setWf(null)} onSaved={() => (setWf(null), reload())} />}
      {comp && (
        <Modal
          title={comp.id ? comp.name : 'New component'}
          onClose={() => setComp(null)}
          footer={
            <>
              {comp.id && (
                <button className="btn danger" onClick={async () => (await run(() => del(`/api/v1/projects/${id}/work/components/${comp.id}`), 'Deleted')) !== null && (setComp(null), reload())}>
                  Delete
                </button>
              )}
              <button className="btn primary" disabled={!comp.name.trim()} onClick={async () => (await run(() => (comp.id ? put(`/api/v1/projects/${id}/work/components/${comp.id}`, { name: comp.name, description: comp.description || null, leadId: comp.leadId || null, assignLead: comp.assignLead }) : post(`/api/v1/projects/${id}/work/components`, { name: comp.name, description: comp.description || null, leadId: comp.leadId || null, assignLead: comp.assignLead })), 'Saved')) && (setComp(null), reload())}>
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Name
              <input autoFocus value={comp.name} onChange={(e) => setComp({ ...comp, name: e.target.value })} />
            </label>
            <label className="field">
              Description
              <input value={comp.description ?? ''} onChange={(e) => setComp({ ...comp, description: e.target.value })} />
            </label>
            <label className="field">
              Lead
              <select value={comp.leadId} onChange={(e) => setComp({ ...comp, leadId: e.target.value })}>
                <option value="">—</option>
                {team.map(([uid, n]) => (
                  <option key={uid} value={uid}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={comp.assignLead} onChange={(e) => setComp({ ...comp, assignLead: e.target.checked })} /> New unassigned items in this component go to the lead
            </label>
          </div>
        </Modal>
      )}
      {field && (
        <Modal
          title={field.id ? field.label : 'New field'}
          onClose={() => setField(null)}
          footer={
            <>
              {field.id && (
                <button className="btn danger" onClick={async () => window.confirm('Delete this field and its values on every item?') && (await run(() => del(`/api/v1/projects/${id}/work/fields/${field.id}`), 'Deleted')) !== null && (setField(null), reload())}>
                  Delete
                </button>
              )}
              <button
                className="btn primary"
                disabled={!field.label.trim()}
                onClick={async () => {
                  const body = { key: field.key || field.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^(\d)/, 'f$1').slice(0, 40) || 'field', label: field.label, type: field.type, options: String(field.options).split(',').map((x: string) => x.trim()).filter(Boolean), workTypes: field.workTypes, required: field.required };
                  if ((await run(() => (field.id ? put(`/api/v1/projects/${id}/work/fields/${field.id}`, body) : post(`/api/v1/projects/${id}/work/fields`, body)), 'Saved')) !== null) (setField(null), reload());
                }}
              >
                Save
              </button>
            </>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Label
              <input autoFocus value={field.label} onChange={(e) => setField({ ...field, label: e.target.value })} />
            </label>
            {!field.id && (
              <label className="field">
                Key (used in queries)
                <input className="mono" value={field.key} onChange={(e) => setField({ ...field, key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') })} placeholder="browser" />
              </label>
            )}
            <label className="field">
              Type
              <select value={field.type} onChange={(e) => setField({ ...field, type: e.target.value })}>
                {['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url'].map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            {(field.type === 'select' || field.type === 'multiselect') && (
              <label className="field">
                Options (comma separated)
                <input value={field.options} onChange={(e) => setField({ ...field, options: e.target.value })} />
              </label>
            )}
            <div className="field">
              For types (none = all)
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {TYPES.map(([k, l]) => (
                  <label key={k} className="row small" style={{ gap: 3 }}>
                    <input type="checkbox" checked={field.workTypes.includes(k)} onChange={(e) => setField({ ...field, workTypes: e.target.checked ? [...field.workTypes, k] : field.workTypes.filter((x: string) => x !== k) })} /> {l}
                  </label>
                ))}
              </div>
            </div>
            <label className="row small" style={{ gap: 6 }}>
              <input type="checkbox" checked={field.required} onChange={(e) => setField({ ...field, required: e.target.checked })} /> Required
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function WorkflowEditor({ projectId, wf, onClose, onSaved }: { projectId: string; wf: Json; onClose: () => void; onSaved: () => void }) {
  const run = useRun();
  const [w, setW] = useState<Json>({ ...wf, states: wf.states.map((s: Json) => ({ ...s })), transitions: wf.transitions.map((t: Json) => ({ roles: [], require: [], ...t })) });
  const [restrict, setRestrict] = useState(wf.transitions.length > 0);
  const keyOf = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').replace(/^(\d)/, 's$1').slice(0, 40) || 'state';
  const setState = (i: number, p: Json) => setW({ ...w, states: w.states.map((s: Json, ix: number) => (ix === i ? { ...s, ...p } : s)) });
  const has = (from: string, to: string) => w.transitions.find((t: Json) => t.from === from && t.to === to);
  const toggleMove = (from: string, to: string) => setW({ ...w, transitions: has(from, to) ? w.transitions.filter((t: Json) => !(t.from === from && t.to === to)) : [...w.transitions, { from, to, roles: [], require: [] }] });
  const save = async () => {
    const body = { name: w.name, workTypes: w.workTypes, states: w.states.map((s: Json) => ({ key: s.key, label: s.label, category: s.category })), transitions: restrict ? w.transitions.map((t: Json) => ({ from: t.from, to: t.to, name: t.name || null, roles: t.roles?.length ? t.roles : undefined, require: t.require?.length ? t.require : undefined })) : [] };
    const r = await run(() => (w.id ? put(`/api/v1/projects/${projectId}/work/workflows/${w.id}`, body) : post(`/api/v1/projects/${projectId}/work/workflows`, body)), 'Workflow saved');
    if (r) onSaved();
  };
  return (
    <Modal
      title={w.id ? `Workflow · ${w.name}` : 'New workflow'}
      onClose={onClose}
      xl
      footer={
        <>
          {w.id && (
            <button className="btn danger" onClick={async () => window.confirm('Delete this workflow? Its items fall back to the default workflow.') && (await run(() => del(`/api/v1/projects/${projectId}/work/workflows/${w.id}`), 'Deleted')) !== null && onSaved()}>
              Delete
            </button>
          )}
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="modal-body stack">
        <div className="grid2">
          <label className="field">
            Name
            <input value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />
          </label>
          <div className="field">
            For types (none = all others)
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {TYPES.map(([k, l]) => (
                <label key={k} className="row small" style={{ gap: 3 }}>
                  <input type="checkbox" checked={w.workTypes.includes(k)} onChange={(e) => setW({ ...w, workTypes: e.target.checked ? [...w.workTypes, k] : w.workTypes.filter((x: string) => x !== k) })} /> {l}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div>
          <h3 className="section-label">States</h3>
          <table className="data compact">
            <thead>
              <tr>
                <th>State</th>
                <th>Key</th>
                <th>Counts as</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(w.states as Json[]).map((s, i) => (
                <tr key={i}>
                  <td>
                    <input value={s.label} onChange={(e) => setState(i, { label: e.target.value, ...(s.fresh ? { key: keyOf(e.target.value) } : {}) })} aria-label="State name" />
                  </td>
                  <td className="mono small">{s.key}</td>
                  <td>
                    <select value={s.category} onChange={(e) => setState(i, { category: e.target.value })} aria-label="Category">
                      {CATS.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="nowrap">
                    <button className="link-btn small" disabled={i === 0} onClick={() => setW({ ...w, states: swap(w.states, i, i - 1) })} aria-label="Up">
                      ↑
                    </button>{' '}
                    <button className="link-btn small" onClick={() => setW({ ...w, states: w.states.filter((_: Json, ix: number) => ix !== i), transitions: w.transitions.filter((t: Json) => t.from !== s.key && t.to !== s.key) })} aria-label="Remove">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link-btn small" onClick={() => setW({ ...w, states: [...w.states, { key: `state_${w.states.length + 1}`, label: 'New state', category: 'in_progress', fresh: true }] })}>
            + State
          </button>
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={restrict} onChange={(e) => setRestrict(e.target.checked)} /> Only allow the moves ticked below (otherwise any state to any state)
        </label>
        {restrict && (
          <div className="table-scroll">
            <table className="data compact wf-matrix">
              <thead>
                <tr>
                  <th>From ↓ / to →</th>
                  {(w.states as Json[]).map((s) => (
                    <th key={s.key}>{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[{ key: '*', label: 'Any state' }, ...w.states].map((f: Json) => (
                  <tr key={f.key}>
                    <th>{f.label}</th>
                    {(w.states as Json[]).map((t) => (
                      <td key={t.key} style={{ textAlign: 'center' }}>
                        {f.key !== t.key && <input type="checkbox" aria-label={`${f.label} to ${t.label}`} checked={!!has(f.key, t.key)} onChange={() => toggleMove(f.key, t.key)} />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {restrict && w.transitions.length > 0 && (
          <div>
            <h3 className="section-label">Rules on moves</h3>
            <table className="data compact">
              <thead>
                <tr>
                  <th>Move</th>
                  <th>Button name</th>
                  <th>Only managers</th>
                  <th>Needs</th>
                </tr>
              </thead>
              <tbody>
                {(w.transitions as Json[]).map((t, i) => (
                  <tr key={`${t.from}-${t.to}`}>
                    <td className="small">
                      {t.from === '*' ? 'Any' : w.states.find((s: Json) => s.key === t.from)?.label} → {w.states.find((s: Json) => s.key === t.to)?.label}
                    </td>
                    <td>
                      <input value={t.name ?? ''} onChange={(e) => setW({ ...w, transitions: w.transitions.map((x: Json, ix: number) => (ix === i ? { ...x, name: e.target.value } : x)) })} style={{ width: 110 }} aria-label="Button name" />
                    </td>
                    <td>
                      <input type="checkbox" checked={(t.roles ?? []).length === 1 && t.roles[0] === 'manager'} onChange={(e) => setW({ ...w, transitions: w.transitions.map((x: Json, ix: number) => (ix === i ? { ...x, roles: e.target.checked ? ['manager'] : [] } : x)) })} aria-label="Only managers" />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {[['assignee', 'Assignee'], ['resolution', 'Resolution'], ['comment', 'Comment'], ['points', 'Points'], ['estimate', 'Estimate']].map(([k, l]) => (
                          <label key={k} className="row small" style={{ gap: 3 }}>
                            <input type="checkbox" checked={(t.require ?? []).includes(k)} onChange={(e) => setW({ ...w, transitions: w.transitions.map((x: Json, ix: number) => (ix === i ? { ...x, require: e.target.checked ? [...(x.require ?? []), k] : (x.require ?? []).filter((y: string) => y !== k) } : x)) })} /> {l}
                          </label>
                        ))}
                      </div>
                    </td>
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

function DevConnections() {
  const { data, refetch } = useQuery({ queryKey: ['dev-connections'], queryFn: () => get<Json[]>('/api/admin/work/dev-connections'), retry: false });
  const [made, setMade] = useState<Json | null>(null);
  const run = useRun();
  if (!data) return null;
  const add = async (provider: 'github' | 'azure_repos') => {
    const label = window.prompt(provider === 'github' ? 'Name (e.g. the repository or organisation)' : 'Name (e.g. the Azure DevOps project)');
    if (!label) return;
    const r = await run(() => post<Json>('/api/admin/work/dev-connections', { provider, label }));
    if (r) (setMade({ ...r, provider }), refetch());
  };
  return (
    <section>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 className="section-label">Code connections (whole workspace)</h3>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn small" onClick={() => add('github')}>
            + GitHub
          </button>
          <button className="btn small" onClick={() => add('azure_repos')}>
            + Azure DevOps
          </button>
        </div>
      </div>
      {!data.length ? (
        <p className="muted small">Connect GitHub or Azure Repos / Pipelines so branches, commits, pull requests and builds that mention a key link to the item.</p>
      ) : (
        <table className="data compact">
          <tbody>
            {data.map((c) => (
              <tr key={c.id}>
                <td>{c.provider === 'github' ? 'GitHub' : 'Azure DevOps'} · {c.label}</td>
                <td className="mono small" style={{ wordBreak: 'break-all' }}>{c.webhookUrl}</td>
                <td className="small">{c.lastEventAt ? `last event ${date(c.lastEventAt)}` : 'no events yet'}</td>
                <td>
                  <button className="link-btn small" onClick={async () => window.confirm('Remove this connection?') && (await run(() => del(`/api/admin/work/dev-connections/${c.id}`), 'Removed')) !== null && refetch()}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {made && (
        <Modal title="Connection created" onClose={() => setMade(null)}>
          <div className="modal-body stack small">
            <p style={{ margin: 0 }}>Copy these now — the secret is not shown again.</p>
            <div>
              <div className="section-label">Payload URL</div>
              <code className="mono" style={{ wordBreak: 'break-all' }}>{made.webhookUrl}</code>
            </div>
            {made.provider === 'github' ? (
              <>
                <div>
                  <div className="section-label">Secret</div>
                  <code className="mono">{made.secret}</code>
                </div>
                <Guide id="dev_github" open />
              </>
            ) : (
              <>
                <div>
                  <div className="section-label">Basic authentication</div>
                  user <code className="mono">synapse</code> · password <code className="mono">{made.secret}</code>
                </div>
                <Guide id="dev_azure" open />
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

/* ───────────────────────── repositories and the code policy ───────────────────────── */

const POLICY: [string, string, string][] = [
  ['enforce', 'Enforce', 'The CI check and the commit hook fail until a work item is named'],
  ['auto_create', 'Auto-create', 'An item is created from the commit message (feat → story, fix → bug, cr → change request …)'],
  ['warn', 'Warn', 'Unlinked commits are only recorded here'],
  ['off', 'Off', 'No check'],
];

export function ReposSection({ id, manage }: { id: string; manage: boolean }) {
  const { data, refetch } = useQuery({ queryKey: ['work', id, 'repos'], queryFn: () => get<Json>(`/api/v1/projects/${id}/work/repos`) });
  const run = useRun();
  const [add, setAdd] = useState<Json | null>(null);
  const [files, setFiles] = useState<Json | null>(null);
  const [resolve, setResolve] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  if (!data) return null;
  const openSetup = async (repoId: string, token?: string) => {
    const f = await run(() => get<Json>(`/api/v1/projects/${id}/work/repos/${repoId}/setup`));
    if (f) setFiles({ ...f, repoId, token });
  };
  return (
    <section>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3 className="section-label">Code repositories &amp; policy</h3>
        {manage && (
          <button className="btn small primary" onClick={() => setAdd({ provider: 'github', repo: '', defaultBranch: 'main', policy: 'enforce', autoSprint: true, picked: [] })}>
            + Link {data.repos.length ? 'more repositories' : 'repositories'}
          </button>
        )}
      </div>
      {!data.repos.length ? (
        <div className="callout warn small">
          <strong>No repository linked.</strong> Link the project’s GitHub or Azure DevOps repository so every push and pull request names one of its work items — or gets one created automatically.
        </div>
      ) : (
        <table className="data compact">
          <thead>
            <tr>
              <th>Repository</th>
              <th>Policy</th>
              <th className="num">Last 30 days</th>
              <th>Last check</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data.repos as Json[]).map((r) => (
              <tr key={r.id}>
                <td>
                  {r.provider === 'github' ? 'GitHub' : 'Azure DevOps'} · <span className="mono">{r.repo}</span> <span className="muted small">({r.default_branch})</span>
                  {r.installation_id && <span className="chip good small" title="Checks are posted on pull requests by the GitHub App">App</span>}
                </td>
                <td>
                  <select style={{ minWidth: 130 }} disabled={!manage} value={r.policy} onChange={async (e) => (await run(() => patch_(`/api/v1/projects/${id}/work/repos/${r.id}`, { policy: e.target.value }), 'Policy saved')) !== null && refetch()} aria-label="Policy">
                    {POLICY.map(([k, l]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num small">
                  {r.events ? (
                    <>
                      <span className="good-text">{r.linked} linked</span> · {r.created} created · <span className={r.missing ? 'bad-text' : ''}>{r.missing} without item</span>
                    </>
                  ) : (
                    <span className="muted">no commits yet</span>
                  )}
                </td>
                <td className="small">{r.last_check_at ? date(r.last_check_at) : <span className="warn-text">CI check not run yet</span>}</td>
                <td>
                  <button className="link-btn small" onClick={() => openSetup(r.id)}>
                    Setup files
                  </button>
                  {manage && r.installation_id && (
                    <>
                      {' · '}
                      <RequireCheckButton projectId={id} repo={r} />
                    </>
                  )}
                  {manage && (
                    <>
                      {' · '}
                      <button className="link-btn small" onClick={async () => window.confirm('Make a new token? The old one stops working; update the SYNAPSE_TOKEN secret.') && (async () => { const t = await run(() => post<Json>(`/api/v1/projects/${id}/work/repos/${r.id}/rotate`, {})); if (t) openSetup(r.id, t.token); })()}>
                        New token
                      </button>
                      {' · '}
                      <button className="link-btn small" onClick={async () => window.confirm(`Unlink ${r.repo}?`) && (await run(() => del(`/api/v1/projects/${id}/work/repos/${r.id}`), 'Unlinked')) !== null && refetch()}>
                        Unlink
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {(data.missing as Json[]).length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h3 className="section-label">Commits and pull requests without a work item</h3>
          <table className="data compact">
            <tbody>
              {(data.missing as Json[]).map((m) => (
                <tr key={m.id}>
                  <td className="small nowrap">{date(m.at)}</td>
                  <td style={{ whiteSpace: 'normal' }}>
                    {m.url ? (
                      <a href={m.url} target="_blank" rel="noreferrer">
                        {m.title || m.kind}
                      </a>
                    ) : (
                      m.title
                    )}
                    <div className="muted small">
                      {m.kind === 'pr' ? 'Pull request' : 'Commit'} · {m.repo}
                      {m.branch && ` · ${m.branch}`}
                      {m.author && ` · ${m.author}`}
                    </div>
                  </td>
                  <td className="nowrap">
                    <button className="btn small" onClick={() => setResolve({ ...m, key: '' })}>
                      Link…
                    </button>{' '}
                    <button className="btn small" onClick={async () => { const r = await run(() => post<Json>(`/api/v1/projects/${id}/work/code-events/${m.id}/resolve`, { create: true })); if (r) (refetch(), window.setTimeout(() => undefined)); }}>
                      Create item
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {add && (
        <Modal
          title="Link repositories"
          onClose={() => setAdd(null)}
          footer={
            <button
              className="btn primary"
              disabled={busy || (!add.picked.length && !add.repo.trim())}
              onClick={async () => {
                setBusy(true);
                const base = { provider: add.provider, policy: add.policy, autoSprint: add.autoSprint };
                const todo: Json[] =
                  add.provider === 'github' && add.picked.length
                    ? add.picked.map((r: Json) => ({ ...base, repo: r.fullName, defaultBranch: r.defaultBranch, installationId: r.installationId }))
                    : [{ ...base, repo: add.repo.trim(), defaultBranch: add.defaultBranch, installationId: add.installationId ?? null }];
                const done: Json[] = [];
                const failed: string[] = [];
                for (const t of todo) {
                  try {
                    done.push({ ...(await post<Json>(`/api/v1/projects/${id}/work/repos`, t)), viaApp: !!t.installationId });
                  } catch (e) {
                    failed.push(`${t.repo}: ${(e as Error).message}`);
                  }
                }
                setBusy(false);
                refetch();
                qc.invalidateQueries({ queryKey: ['github-app-repo-list'] });
                if (failed.length) window.alert(`${done.length} linked. Not linked:\n${failed.join('\n')}`);
                setAdd(null);
                // a repository typed in (no GitHub App) needs the CI check / hooks: show their setup once
                if (done.length === 1 && !done[0]!.viaApp) openSetup(done[0]!.id, done[0]!.token);
              }}
            >
              {busy ? 'Linking…' : add.provider === 'github' && add.picked.length ? `Link ${add.picked.length} repositor${add.picked.length === 1 ? 'y' : 'ies'}` : 'Link'}
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Host
              <select value={add.provider} onChange={(e) => setAdd({ ...add, provider: e.target.value, picked: [] })}>
                <option value="github">GitHub</option>
                <option value="azure_repos">Azure DevOps (Repos + Pipelines)</option>
              </select>
            </label>
            {add.provider === 'github' && <AppRepoPicker projectId={id} picked={add.picked} onChange={(picked) => setAdd({ ...add, picked })} />}
            {!(add.provider === 'github' && add.picked.length) && (
              <>
                <label className="field">
                  {add.provider === 'github' ? 'Or type a repository' : 'Repository'}
                  <input className="mono" value={add.repo} onChange={(e) => setAdd({ ...add, repo: e.target.value, installationId: null })} placeholder={add.provider === 'github' ? 'acme/fleet-portal or its URL' : 'Project/repo, e.g. Fleet/fleet-api'} />
                </label>
                <label className="field">
                  Main branch
                  <input className="mono" value={add.defaultBranch} onChange={(e) => setAdd({ ...add, defaultBranch: e.target.value })} />
                </label>
              </>
            )}
            <div className="field">
              Policy {add.picked.length > 1 ? '(for all of them; each can be changed later)' : ''}
              {POLICY.map(([k, l, d]) => (
                <label key={k} className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
                  <input type="radio" name="policy" checked={add.policy === k} onChange={() => setAdd({ ...add, policy: k })} />
                  <span>
                    <strong>{l}</strong> — {d}
                  </span>
                </label>
              ))}
            </div>
            {add.policy === 'auto_create' && (
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={add.autoSprint} onChange={(e) => setAdd({ ...add, autoSprint: e.target.checked })} /> Put auto-created items in the active sprint
              </label>
            )}
            <p className="small muted" style={{ margin: 0 }}>
              A project can have any number of repositories (an app, its API, its infrastructure…): link more at any time.
            </p>
          </div>
        </Modal>
      )}
      {files && <SetupFiles f={files} onClose={() => setFiles(null)} />}
      {resolve && (
        <Modal
          title="Link to a work item"
          onClose={() => setResolve(null)}
          footer={
            <button className="btn primary" disabled={!resolve.key.trim()} onClick={async () => (await run(() => post(`/api/v1/projects/${id}/work/code-events/${resolve.id}/resolve`, { key: resolve.key.trim() }), 'Linked')) !== null && (setResolve(null), refetch())}>
              Link
            </button>
          }
        >
          <div className="modal-body stack">
            <p className="small" style={{ margin: 0 }}>{resolve.title}</p>
            <label className="field">
              Work item or change request key
              <input autoFocus className="mono" value={resolve.key} onChange={(e) => setResolve({ ...resolve, key: e.target.value.toUpperCase() })} placeholder="FLEET-12 or FLEET-CR-3" />
            </label>
          </div>
        </Modal>
      )}
    </section>
  );
}

function SetupFiles({ f, onClose }: { f: Json; onClose: () => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<'ci' | 'hook'>('ci');
  const copy = (t: string, what: string) => navigator.clipboard.writeText(t).then(() => toast(`${what} copied`), () => toast('Copy failed', true));
  const gh = f.provider === 'github';
  const ci = gh ? f.githubWorkflow : f.azurePipeline;
  return (
    <Modal title={`Set up ${f.repo}`} onClose={onClose} xl>
      <div className="modal-body stack small">
        {f.token && (
          <div className="callout warn">
            <strong>Repository token — copy it now, it is not shown again.</strong>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <code className="mono" style={{ wordBreak: 'break-all' }}>{f.token}</code>
              <button className="btn small" onClick={() => copy(f.token, 'Token')}>
                Copy
              </button>
            </div>
            <div style={{ marginTop: 6 }}>{gh ? 'Add it as the repository secret SYNAPSE_TOKEN (Settings → Secrets and variables → Actions).' : 'Add it as the secret pipeline variable SYNAPSE_TOKEN.'}</div>
          </div>
        )}
        <ol className="bullets" style={{ listStyle: 'decimal' }}>
          {gh ? (
            <>
              <li>Commit the workflow below as <code className="mono">.github/workflows/synapse-work-items.yml</code>.</li>
              <li>Settings → Branches → protect the main branch: <em>Require status checks to pass</em> and pick <strong>SanchalanOS work items / work-item</strong>. Pull requests then cannot merge until every commit names a work item.</li>
              <li>Optional, for instant feedback: install the commit hook on each developer machine (second tab). Commits on a branch like <code className="mono">{f.branchExample}</code> get the key added automatically.</li>
              <li>Add a GitHub connection under <em>Code connections</em> so pushes, PRs and builds also link in real time.</li>
            </>
          ) : (
            <>
              <li>Commit the pipeline below as <code className="mono">azure-pipelines-synapse.yml</code> and create a pipeline from it.</li>
              <li>Repos → Branches → main → Branch policies → <em>Build validation</em>: add this pipeline as <strong>required</strong>. Pull requests cannot complete until every commit names a work item.</li>
              <li>Optional: install the commit hook on each developer machine (second tab).</li>
              <li>Add an Azure DevOps connection under <em>Code connections</em> so pushes, PRs and builds also link in real time.</li>
            </>
          )}
        </ol>
        <p className="muted" style={{ margin: 0 }}>
          GitHub and Azure DevOps cannot refuse a push from an outside service; the required check blocks merging, and the commit hook stops an unlinked commit on the developer’s machine.
          {f.policy === 'auto_create' && ' With auto-create, unlinked commits get an item made from their message instead, so checks pass.'}
        </p>
        <div className="seg">
          <button className={tab === 'ci' ? 'on' : ''} onClick={() => setTab('ci')}>
            {gh ? 'GitHub Actions workflow' : 'Azure Pipeline'}
          </button>
          <button className={tab === 'hook' ? 'on' : ''} onClick={() => setTab('hook')}>
            commit-msg hook
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn small" onClick={() => copy(tab === 'ci' ? ci : f.commitMsgHook, tab === 'ci' ? 'Workflow' : 'Hook')}>
            Copy
          </button>
        </div>
        <pre className="transcript" style={{ maxHeight: 360 }}>
          {tab === 'ci' ? ci : f.commitMsgHook}
        </pre>
      </div>
    </Modal>
  );
}
