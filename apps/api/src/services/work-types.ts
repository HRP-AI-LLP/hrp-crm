/**
 * Work item types and their hierarchy (shared by projects.ts and it/work.ts):
 *   epic (1) → feature (2) → story / bug / task / spike / chore (3) → sub-task (4)
 * A story or bug may sit under an epic or a feature; tasks and chores may also sit under a story,
 * bug, task or spike (one level), the way Azure DevOps puts tasks under a user story and Jira puts
 * sub-tasks under any issue.
 */
import type { Tx } from '../lib/db';
import { badRequest } from '../lib/errors';

export const WORK_TYPES = ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'chore', 'subtask'] as const;
export type WorkType = (typeof WORK_TYPES)[number];
export const LEVEL: Record<WorkType, number> = { epic: 1, feature: 2, story: 3, bug: 3, task: 3, spike: 3, chore: 3, subtask: 4 };

/** Which parent types a type may have. */
export function parentTypesFor(t: WorkType): WorkType[] {
  if (t === 'epic') return [];
  if (t === 'feature') return ['epic'];
  if (t === 'story' || t === 'bug' || t === 'spike') return ['epic', 'feature'];
  if (t === 'task' || t === 'chore') return ['epic', 'feature', 'story', 'bug', 'task', 'spike', 'chore'];
  return ['story', 'bug', 'task', 'spike', 'chore', 'feature'];
}

/**
 * Checks a parent for an item of `type` (selfId when the item exists): same project, an allowed
 * parent type, no cycle, at most four levels. Returns the epic the item rolls up to.
 */
export async function checkParent(tx: Tx, tenantId: string, projectId: string, type: WorkType, parentId: string, selfId?: string): Promise<{ epicId: string | null }> {
  if (parentId === selfId) throw badRequest('An item cannot be its own parent');
  const p = await tx.one<{ work_type: WorkType; parent_id: string | null; epic_id: string | null }>(`select work_type, parent_id, epic_id from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [tenantId, parentId, projectId]);
  if (!p) throw badRequest('Parent not found in this project');
  const allowed = parentTypesFor(type);
  if (!allowed.includes(p.work_type)) throw badRequest(type === 'epic' ? 'An epic is the top of the hierarchy' : `A ${label(type)} can sit under ${allowed.map(label).join(', ')} — not a ${label(p.work_type)}`);
  // a task under a task: only one level of that
  if ((type === 'task' || type === 'chore') && (p.work_type === 'task' || p.work_type === 'chore') && p.parent_id) {
    const gp = await tx.one<{ work_type: WorkType }>(`select work_type from project_tasks where tenant_id = $1 and id = $2`, [tenantId, p.parent_id]);
    if (gp && (gp.work_type === 'task' || gp.work_type === 'chore')) throw badRequest('Sub-tasks go one level deep');
  }
  if (selfId) {
    const loop = await tx.one(
      `with recursive up(id, parent_id) as (select id, parent_id from project_tasks where tenant_id = $1 and id = $2
         union all select t.id, t.parent_id from project_tasks t join up on t.id = up.parent_id where t.tenant_id = $1)
       select 1 from up where id = $3 limit 1`,
      [tenantId, parentId, selfId],
    );
    if (loop) throw badRequest('That would put the item under its own child');
    // its children must still fit under it
    const deepest = await tx.one<{ d: number }>(
      `with recursive down(id, d) as (select id, 1 from project_tasks where tenant_id = $1 and parent_id = $2
         union all select t.id, down.d + 1 from project_tasks t join down on t.parent_id = down.id where t.tenant_id = $1 and down.d < 6)
       select coalesce(max(d), 0)::int as d from down`,
      [tenantId, selfId],
    );
    const depth = await tx.one<{ d: number }>(
      `with recursive up(id, parent_id, d) as (select id, parent_id, 1 from project_tasks where tenant_id = $1 and id = $2
         union all select t.id, t.parent_id, up.d + 1 from project_tasks t join up on t.id = up.parent_id where t.tenant_id = $1 and up.d < 6)
       select max(d)::int as d from up`,
      [tenantId, parentId],
    );
    if ((depth?.d ?? 1) + 1 + (deepest?.d ?? 0) > 4) throw badRequest('The hierarchy goes four levels deep');
  }
  return { epicId: p.work_type === 'epic' ? parentId : p.epic_id };
}

export function label(t: string) {
  return t === 'subtask' ? 'sub-task' : t;
}

/** After an item's parent changes: it and everything under it roll up to the right epic. */
export async function refreshEpics(tx: Tx, tenantId: string, rootId: string) {
  await tx.query(
    `with recursive tree(id, epic) as (
        select t.id, case when t.work_type = 'epic' then t.id when p.work_type = 'epic' then p.id when p.id is not null then p.epic_id else t.epic_id end
          from project_tasks t left join project_tasks p on p.tenant_id = t.tenant_id and p.id = t.parent_id where t.tenant_id = $1 and t.id = $2
        union all
        select c.id, case when c.work_type = 'epic' then c.id else tree.epic end from project_tasks c join tree on c.parent_id = tree.id where c.tenant_id = $1)
     update project_tasks t set epic_id = case when t.work_type = 'epic' then null else tree.epic end from tree
      where t.tenant_id = $1 and t.id = tree.id and t.epic_id is distinct from (case when t.work_type = 'epic' then null else tree.epic end)`,
    [tenantId, rootId],
  );
}

/* ───────────── workflows ───────────── */

export type Category = 'todo' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
export const CATEGORIES: Category[] = ['todo', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
export const statusOf = (c: Category) => (c === 'todo' ? 'open' : c);
export const categoryOf = (status: string): Category => (status === 'open' ? 'todo' : (status as Category));

export interface WfState {
  key: string;
  label: string;
  category: Category;
  color?: string | null;
}
export interface WfTransition {
  from: string; // state key or '*'
  to: string;
  name?: string | null;
  roles?: ('manager' | 'member')[];
  require?: ('assignee' | 'resolution' | 'comment' | 'points' | 'estimate')[];
}
export interface Workflow {
  id: string | null;
  name: string;
  workTypes: string[];
  states: WfState[];
  transitions: WfTransition[];
}

export const DEFAULT_WORKFLOW: Workflow = {
  id: null,
  name: 'Default',
  workTypes: [],
  states: [
    { key: 'open', label: 'To do', category: 'todo' },
    { key: 'in_progress', label: 'In progress', category: 'in_progress' },
    { key: 'review', label: 'In review', category: 'review' },
    { key: 'blocked', label: 'Blocked', category: 'blocked' },
    { key: 'done', label: 'Done', category: 'done' },
    { key: 'cancelled', label: 'Cancelled', category: 'cancelled' },
  ],
  transitions: [],
};

export async function projectWorkflows(tx: Tx, tenantId: string, projectId: string): Promise<Workflow[]> {
  const rows = await tx.query<{ id: string; name: string; work_types: string[]; states: WfState[]; transitions: WfTransition[] }>(
    `select id, name, work_types, states, transitions from pm_workflows where tenant_id = $1 and project_id = $2 order by created_at`,
    [tenantId, projectId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, workTypes: r.work_types, states: r.states, transitions: r.transitions }));
}

/** The workflow for one type: the one naming the type, else the project's catch-all, else the default. */
export function pickWorkflow(list: Workflow[], type: string): Workflow {
  return list.find((w) => w.workTypes.includes(type)) ?? list.find((w) => !w.workTypes.length) ?? DEFAULT_WORKFLOW;
}

/** The item's current state: its key, or the first state of its status category. */
export function currentState(wf: Workflow, state: string | null, status: string): WfState {
  const cat = categoryOf(status);
  return (state ? wf.states.find((s) => s.key === state && s.category === cat) : undefined) ?? wf.states.find((s) => s.category === cat) ?? { key: status, label: status, category: cat };
}

/** Transitions open from a state to the given role (no transitions defined = any move). */
export function movesFrom(wf: Workflow, from: string, role: 'manager' | 'member'): (WfTransition & { toState: WfState })[] {
  const list = wf.transitions.length ? wf.transitions.filter((t) => t.from === '*' || t.from === from) : wf.states.filter((s) => s.key !== from).map((s) => ({ from, to: s.key }) as WfTransition);
  return list
    .filter((t) => t.to !== from && (!t.roles?.length || t.roles.includes(role) || role === 'manager'))
    .map((t) => ({ ...t, toState: wf.states.find((s) => s.key === t.to)! }))
    .filter((t) => t.toState);
}

/**
 * A status set directly (task list, board of categories, bulk edit): which workflow state that is.
 * Refuses when the workflow has no move from the current state into that category.
 */
export async function stateForStatus(tx: Tx, tenantId: string, projectId: string, task: { work_type: string; state: string | null; status: string }, status: string, role: 'manager' | 'member'): Promise<string | null> {
  const wf = pickWorkflow(await projectWorkflows(tx, tenantId, projectId), task.work_type);
  if (!wf.id) return null;
  const cur = currentState(wf, task.state, task.status);
  const cat = categoryOf(status);
  if (cur.category === cat) return cur.key;
  const move = movesFrom(wf, cur.key, role).find((t) => t.toState.category === cat);
  if (!move) throw badRequest(`The “${wf.name}” workflow has no move from ${cur.label} to ${cat.replace('_', ' ')}`);
  return move.to;
}
