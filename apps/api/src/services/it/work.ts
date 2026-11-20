/**
 * Work management inside a project, in the manner of Jira and Azure DevOps (see migration 0061):
 * work item keys, the hierarchy, workflows with transitions, items with components / custom fields /
 * watchers / relations / history, bulk edit, queries, boards, dashboards and flow reports.
 * Code links (GitHub / Azure Repos) are in ./devlinks.ts and test plans in ./tests.ts.
 *
 * Access follows the project (services/projects.ts): viewers read; members work items; managers
 * configure workflows, boards, components and fields.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import type { Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { d10 } from '../books/ledger';
import { addComment, createTask, deleteTask, projectAccess, refreshProgress, updateTask, type TaskInput } from '../projects';
import type { RecordCtx } from '../records';
import {
  CATEGORIES,
  type Category,
  checkParent,
  currentState,
  DEFAULT_WORKFLOW,
  LEVEL,
  movesFrom,
  pickWorkflow,
  projectWorkflows,
  refreshEpics,
  statusOf,
  WORK_TYPES,
  type WfState,
  type WfTransition,
  type Workflow,
  type WorkType,
} from '../work-types';
import { workNotify } from './alerts';
import { fireRules } from './rules';
import { compileWql, type WqlContext } from './wql';

type Role = 'manager' | 'member';
const roleOf = (level: string): Role => (level === 'manage' ? 'manager' : 'member');

/* ───────────────────────── keys ───────────────────────── */

/** The project's work item key prefix (FLEET), made from its code or name the first time it is needed. */
export async function workKey(tx: Tx, tenantId: string, project: Record<string, any>): Promise<string> {
  if (project.work_key) return project.work_key;
  const fromCode = String(project.project_code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const words = String(project.name ?? 'PRJ').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let base = /^[A-Z][A-Z0-9]{1,9}$/.test(fromCode) ? fromCode : words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 6) : (words[0] ?? 'PRJ').slice(0, 5);
  if (!/^[A-Z]/.test(base)) base = `P${base}`;
  if (base.length < 2) base = `${base}X`;
  base = base.slice(0, 8);
  for (let n = 0; n < 50; n++) {
    const k = n ? `${base}${n + 1}`.slice(0, 10) : base;
    const taken = await tx.one(`select 1 from projects where tenant_id = $1 and work_key = $2`, [tenantId, k]);
    if (!taken) {
      await tx.query(`update projects set work_key = $3 where tenant_id = $1 and id = $2 and work_key is null`, [tenantId, project.id, k]);
      project.work_key = k;
      return k;
    }
  }
  throw badRequest('Could not pick a key for the project');
}

export async function setWorkKey(ctx: RecordCtx, projectId: string, key: string) {
  await projectAccess(ctx, projectId, 'manage');
  const k = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(k)) throw badRequest('A key is 2–10 letters or digits, starting with a letter');
  if (await ctx.tx.one(`select 1 from projects where tenant_id = $1 and work_key = $2 and id <> $3`, [ctx.tenantId, k, projectId])) throw badRequest(`${k} is used by another project`);
  await ctx.tx.query(`update projects set work_key = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId, k]);
  return { key: k };
}

/* ───────────────────────── settings: workflows, components, fields ───────────────────────── */

export interface WorkSettings {
  estimation?: 'points' | 'hours';
  /** a project with no code (consulting, events…): exempt from the "every project has a repository" rule */
  noCode?: boolean;
  autoTransitions?: { branch?: string | null; prOpened?: string | null; prMerged?: string | null; buildFailed?: string | null };
}

export async function workSetup(ctx: RecordCtx, projectId: string) {
  const { project, level } = await projectAccess(ctx, projectId);
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  return {
    level,
    key,
    settings: (project.work_settings ?? {}) as WorkSettings,
    workflows: await projectWorkflows(ctx.tx, ctx.tenantId, projectId),
    defaultWorkflow: DEFAULT_WORKFLOW,
    components: await ctx.tx.query(
      `select c.id, c.name, c.description, c.lead_id, c.assign_lead, u.full_name as lead_name,
              (select count(*)::int from project_tasks t where t.tenant_id = c.tenant_id and c.id = any(t.component_ids) and t.status not in ('done','cancelled')) as open_items
         from project_components c left join users u on u.tenant_id = c.tenant_id and u.id = c.lead_id where c.tenant_id = $1 and c.project_id = $2 order by c.name`,
      [ctx.tenantId, projectId],
    ),
    fields: await fieldDefs(ctx.tx, ctx.tenantId, projectId),
    types: WORK_TYPES,
  };
}

export async function saveSettings(ctx: RecordCtx, projectId: string, s: WorkSettings) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`update projects set work_settings = work_settings || $3::jsonb where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId, JSON.stringify(s)]);
  return { ok: true };
}

export interface WorkflowInput {
  name: string;
  workTypes: string[];
  states: WfState[];
  transitions: WfTransition[];
}

export async function saveWorkflow(ctx: RecordCtx, projectId: string, id: string | null, w: WorkflowInput) {
  await projectAccess(ctx, projectId, 'manage');
  const keys = new Set<string>();
  for (const s of w.states) {
    if (keys.has(s.key)) throw badRequest(`State key ${s.key} is used twice`);
    keys.add(s.key);
  }
  for (const c of ['todo', 'done'] as Category[]) if (!w.states.some((s) => s.category === c)) throw badRequest(`A workflow needs at least one ${c === 'todo' ? '“To do”' : '“Done”'} state`);
  for (const t of w.transitions) {
    if (t.from !== '*' && !keys.has(t.from)) throw badRequest(`Transition from unknown state ${t.from}`);
    if (!keys.has(t.to)) throw badRequest(`Transition to unknown state ${t.to}`);
  }
  const others = (await projectWorkflows(ctx.tx, ctx.tenantId, projectId)).filter((x) => x.id !== id);
  for (const t of w.workTypes) if (others.some((o) => o.workTypes.includes(t))) throw badRequest(`Another workflow already covers ${t}`);
  if (!w.workTypes.length && others.some((o) => !o.workTypes.length)) throw badRequest('Only one workflow can cover all remaining types');
  if (id) {
    const before = await ctx.tx.one<{ states: WfState[]; work_types: string[] }>(`select states, work_types from pm_workflows where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, id, projectId]);
    if (!before) throw notFound('Workflow not found');
    // items in a state that is going away fall back to the first state of their category
    const gone = before.states.filter((s) => !keys.has(s.key)).map((s) => s.key);
    if (gone.length) await ctx.tx.query(`update project_tasks set state = null where tenant_id = $1 and project_id = $2 and state = any($3::text[])`, [ctx.tenantId, projectId, gone]);
    await ctx.tx.query(`update pm_workflows set name = $3, work_types = $4, states = $5, transitions = $6, updated_at = now() where tenant_id = $1 and id = $2`, [
      ctx.tenantId, id, w.name, w.workTypes, JSON.stringify(w.states), JSON.stringify(w.transitions),
    ]);
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_workflows (tenant_id, project_id, name, work_types, states, transitions) values ($1,$2,$3,$4,$5,$6) returning id`, [
    ctx.tenantId, projectId, w.name, w.workTypes, JSON.stringify(w.states), JSON.stringify(w.transitions),
  ]);
  return { id: r!.id };
}

export async function deleteWorkflow(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const w = await ctx.tx.one<{ states: WfState[] }>(`delete from pm_workflows where tenant_id = $1 and id = $2 and project_id = $3 returning states`, [ctx.tenantId, id, projectId]);
  if (!w) throw notFound('Workflow not found');
  await ctx.tx.query(`update project_tasks set state = null where tenant_id = $1 and project_id = $2 and state = any($3::text[])`, [ctx.tenantId, projectId, w.states.map((s) => s.key)]);
  return { ok: true };
}

export async function saveComponent(ctx: RecordCtx, projectId: string, id: string | null, c: { name: string; description?: string | null; leadId?: string | null; assignLead?: boolean }) {
  await projectAccess(ctx, projectId, 'manage');
  if (c.leadId && !(await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2`, [ctx.tenantId, c.leadId]))) throw badRequest('Lead not found');
  if (id) {
    const r = await ctx.tx.one(`update project_components set name = $4, description = $5, lead_id = $6, assign_lead = $7 where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [
      ctx.tenantId, id, projectId, c.name, c.description ?? null, c.leadId ?? null, c.assignLead ?? false,
    ]);
    if (!r) throw notFound('Component not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into project_components (tenant_id, project_id, name, description, lead_id, assign_lead) values ($1,$2,$3,$4,$5,$6) returning id`, [
    ctx.tenantId, projectId, c.name, c.description ?? null, c.leadId ?? null, c.assignLead ?? false,
  ]);
  return { id: r!.id };
}

export async function deleteComponent(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`update project_tasks set component_ids = array_remove(component_ids, $3::uuid) where tenant_id = $1 and project_id = $2 and $3::uuid = any(component_ids)`, [ctx.tenantId, projectId, id]);
  await ctx.tx.query(`delete from project_components where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  return { ok: true };
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select' | 'multiselect' | 'user' | 'checkbox' | 'url';
  options: string[];
  work_types: string[];
  required: boolean;
  position: number;
}
export async function fieldDefs(tx: Tx, tenantId: string, projectId: string) {
  return tx.query<FieldDef>(`select id, key, label, type, options, work_types, required, position from pm_field_defs where tenant_id = $1 and project_id = $2 order by position, label`, [tenantId, projectId]);
}

export async function saveField(ctx: RecordCtx, projectId: string, id: string | null, f: Omit<FieldDef, 'id' | 'work_types' | 'position'> & { workTypes: string[]; position?: number }) {
  await projectAccess(ctx, projectId, 'manage');
  if ((f.type === 'select' || f.type === 'multiselect') && !f.options.length) throw badRequest('Give the options for a choice field');
  if (id) {
    const r = await ctx.tx.one(`update pm_field_defs set label = $4, type = $5, options = $6, work_types = $7, required = $8, position = coalesce($9, position) where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [
      ctx.tenantId, id, projectId, f.label, f.type, f.options, f.workTypes, f.required, f.position ?? null,
    ]);
    if (!r) throw notFound('Field not found');
    return { id };
  }
  if (await ctx.tx.one(`select 1 from pm_field_defs where tenant_id = $1 and project_id = $2 and key = $3`, [ctx.tenantId, projectId, f.key])) throw badRequest(`A field ${f.key} exists`);
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_field_defs (tenant_id, project_id, key, label, type, options, work_types, required, position) values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, 0)) returning id`, [
    ctx.tenantId, projectId, f.key, f.label, f.type, f.options, f.workTypes, f.required, f.position ?? null,
  ]);
  return { id: r!.id };
}

export async function deleteField(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const f = await ctx.tx.one<{ key: string }>(`delete from pm_field_defs where tenant_id = $1 and id = $2 and project_id = $3 returning key`, [ctx.tenantId, id, projectId]);
  if (f) await ctx.tx.query(`update project_tasks set custom = custom - $3 where tenant_id = $1 and project_id = $2 and custom ? $3`, [ctx.tenantId, projectId, f.key]);
  return { ok: true };
}

/** Validates custom values for an item type; returns the cleaned object (unknown keys dropped). */
async function cleanCustom(tx: Tx, tenantId: string, projectId: string, type: string, values: Record<string, unknown>, merged: Record<string, unknown>, skipRequired = false) {
  const defs = (await fieldDefs(tx, tenantId, projectId)).filter((d) => !d.work_types.length || d.work_types.includes(type));
  const out: Record<string, unknown> = { ...merged };
  for (const d of defs) {
    if (!(d.key in values)) continue;
    let v = values[d.key];
    if (v === '' || v === undefined) v = null;
    if (v !== null) {
      if (d.type === 'number') {
        v = Number(v);
        if (!Number.isFinite(v as number)) throw badRequest(`${d.label} must be a number`);
      } else if (d.type === 'date') {
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`${d.label} must be a date`);
      } else if (d.type === 'checkbox') v = !!v;
      else if (d.type === 'select') {
        if (!d.options.includes(String(v))) throw badRequest(`${d.label}: choose one of ${d.options.join(', ')}`);
        v = String(v);
      } else if (d.type === 'multiselect') {
        if (!Array.isArray(v) || v.some((x) => !d.options.includes(String(x)))) throw badRequest(`${d.label}: choose from ${d.options.join(', ')}`);
      } else if (d.type === 'user') {
        if (typeof v !== 'string' || !(await tx.one(`select 1 from users where tenant_id = $1 and id = $2`, [tenantId, v]))) throw badRequest(`${d.label}: person not found`);
      } else if (d.type === 'url') {
        if (typeof v !== 'string' || !/^https?:\/\//.test(v)) throw badRequest(`${d.label} must be a link`);
      } else v = String(v).slice(0, 2000);
    }
    if (v === null) delete out[d.key];
    else out[d.key] = v;
  }
  if (!skipRequired) for (const d of defs) if (d.required && (out[d.key] === undefined || out[d.key] === null || (Array.isArray(out[d.key]) && !(out[d.key] as unknown[]).length))) throw badRequest(`${d.label} is required for a ${type}`);
  return out;
}

/* ───────────────────────── watchers & notifications ───────────────────────── */

export async function watch(tx: Tx, tenantId: string, taskId: string, userIds: (string | null | undefined)[]) {
  for (const u of new Set(userIds.filter(Boolean) as string[])) await tx.query(`insert into project_task_watchers (tenant_id, task_id, user_id) values ($1,$2,$3) on conflict do nothing`, [tenantId, taskId, u]);
}

async function notifyWatchers(ctx: RecordCtx, taskId: string, title: string, link: string, body: string | null, skip: string[] = []) {
  const rows = await ctx.tx.query<{ user_id: string }>(`select user_id from project_task_watchers w join users u on u.tenant_id = w.tenant_id and u.id = w.user_id where w.tenant_id = $1 and w.task_id = $2 and u.status = 'active'`, [ctx.tenantId, taskId]);
  await workNotify(ctx, rows.map((r) => r.user_id).filter((u) => !skip.includes(u)), 'watching', { title, body, link });
}

export async function setWatching(ctx: RecordCtx, projectId: string, taskId: string, on: boolean, userId?: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const who = userId ?? ctx.principal.user.id;
  if (who !== ctx.principal.user.id && level === 'view') throw forbidden('Only project members add watchers');
  await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  if (on) await watch(ctx.tx, ctx.tenantId, taskId, [who]);
  else await ctx.tx.query(`delete from project_task_watchers where tenant_id = $1 and task_id = $2 and user_id = $3`, [ctx.tenantId, taskId, who]);
  return { ok: true };
}

const itemLink = (projectId: string, taskId: string) => `/projects/${projectId}?item=${taskId}`;

async function itemRow(tx: Tx, tenantId: string, projectId: string, taskId: string, lock = false) {
  const t = await tx.one<Record<string, any>>(`select * from project_tasks where tenant_id = $1 and id = $2 and project_id = $3${lock ? ' for update' : ''}`, [tenantId, taskId, projectId]);
  if (!t) throw notFound('Work item not found');
  return t;
}

/* ───────────────────────── transitions ───────────────────────── */

export interface TransitionInput {
  to: string;
  comment?: string | null;
  resolution?: string | null;
  assignee?: string | null;
}

/**
 * Moves an item to a workflow state. `system` moves (code events) skip role checks and requirements
 * but still follow a defined transition when the workflow has transitions.
 */
export async function transition(ctx: RecordCtx, projectId: string, taskId: string, input: TransitionInput, opts: { system?: boolean } = {}) {
  const { project, level } = opts.system ? { project: (await ctx.tx.one<Record<string, any>>(`select * from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]))!, level: 'manage' } : await projectAccess(ctx, projectId, 'member');
  const t = await itemRow(ctx.tx, ctx.tenantId, projectId, taskId, true);
  const wf = pickWorkflow(await projectWorkflows(ctx.tx, ctx.tenantId, projectId), t.work_type);
  const cur = currentState(wf, t.state, t.status);
  const target = wf.states.find((s) => s.key === input.to);
  if (!target) throw badRequest(`No state ${input.to} in the ${wf.name} workflow`);
  if (target.key === cur.key) return { state: cur.key, status: t.status };
  const move = movesFrom(wf, cur.key, roleOf(level)).find((m) => m.to === target.key);
  if (!move) {
    const exists = wf.transitions.some((m) => (m.from === '*' || m.from === cur.key) && m.to === target.key);
    throw (exists ? forbidden(`Only the project manager can move it to ${target.label}`) : badRequest(`The ${wf.name} workflow has no move from ${cur.label} to ${target.label}`));
  }
  let assignees: string[] = t.assignees;
  if (input.assignee) {
    if (!(await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2`, [ctx.tenantId, input.assignee]))) throw badRequest('Assignee not found');
    assignees = [input.assignee];
  }
  if (!opts.system)
    for (const r of move.require ?? []) {
      if (r === 'assignee' && !assignees.length) throw badRequest(`Assign it before moving to ${target.label}`);
      if (r === 'resolution' && !(input.resolution ?? t.resolution)) throw badRequest(`Give a resolution to move it to ${target.label}`);
      if (r === 'comment' && !input.comment?.trim()) throw badRequest(`Add a comment to move it to ${target.label}`);
      if (r === 'points' && t.story_points === null) throw badRequest(`Estimate story points before ${target.label}`);
      if (r === 'estimate' && t.estimate_hours === null) throw badRequest(`Give an hours estimate before ${target.label}`);
    }
  const status = statusOf(target.category);
  if (status === 'done' && t.status !== 'done') {
    const open = await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and parent_id = $2 and status not in ('done','cancelled') limit 1`, [ctx.tenantId, taskId]);
    if (open) throw badRequest('Finish or cancel the child items first');
  }
  await ctx.tx.query(
    `update project_tasks set state = $3, status = $4, assignees = $5, resolution = case when $4 in ('done','cancelled') then coalesce($6, resolution, case when $4 = 'done' then 'Done' else 'Won''t do' end) else null end,
            progress = case when $4 = 'done' then 100 else progress end, remaining_hours = case when $4 = 'done' then 0 else remaining_hours end,
            completed_at = case when $4 = 'done' and status <> 'done' then now() when $4 <> 'done' then null else completed_at end, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, taskId, target.key, status, assignees, input.resolution ?? null],
  );
  await refreshProgress(ctx.tx, ctx.tenantId, projectId);
  if (input.comment?.trim() && !opts.system) await comment(ctx, projectId, taskId, input.comment.trim());
  if (!opts.system) await watch(ctx.tx, ctx.tenantId, taskId, [ctx.principal.user.id]);
  const key = `${await workKey(ctx.tx, ctx.tenantId, project)}-${t.task_number}`;
  await notifyWatchers(ctx, taskId, `${key} ${t.name} → ${target.label}`, itemLink(projectId, taskId), null);
  await fireRules(ctx, projectId, taskId, { kind: 'state_changed', fromState: cur.key, toState: target.key, toCategory: target.category });
  return { state: target.key, status };
}

/* ───────────────────────── items ───────────────────────── */

export interface ItemInput {
  name?: string;
  description?: string | null;
  workType?: WorkType;
  priority?: TaskInput['priority'];
  severity?: 'minor' | 'major' | 'critical' | 'blocker' | null;
  assignees?: string[];
  reporterId?: string | null;
  storyPoints?: number | null;
  estimateHours?: number | null;
  remainingHours?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  sprintId?: string | null;
  releaseId?: string | null;
  parentId?: string | null;
  epicId?: string | null;
  componentIds?: string[];
  tags?: string[];
  custom?: Record<string, unknown>;
  state?: string;
}

async function checkPlan(tx: Tx, tenantId: string, projectId: string, i: ItemInput) {
  if (i.sprintId) {
    const s = await tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [tenantId, i.sprintId, projectId]);
    if (!s) throw badRequest('Sprint not found');
    if (s.status === 'closed') throw badRequest('That sprint is closed');
  }
  if (i.releaseId && !(await tx.one(`select 1 from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [tenantId, i.releaseId, projectId]))) throw badRequest('Release not found');
  if (i.componentIds?.length) {
    const n = await tx.one<{ n: number }>(`select count(*)::int as n from project_components where tenant_id = $1 and project_id = $2 and id = any($3::uuid[])`, [tenantId, projectId, [...new Set(i.componentIds)]]);
    if (n!.n !== new Set(i.componentIds).size) throw badRequest('Component not found');
  }
  if (i.epicId) {
    const e = await tx.one<{ work_type: string }>(`select work_type from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [tenantId, i.epicId, projectId]);
    if (e?.work_type !== 'epic') throw badRequest('Choose an epic of this project');
  }
}

export async function createItem(ctx: RecordCtx, projectId: string, i: ItemInput & { name: string; workType: WorkType }, opts: { skipRequired?: boolean } = {}) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  await assertRepoRule(ctx, project);
  await checkPlan(ctx.tx, ctx.tenantId, projectId, i);
  if (i.workType === 'epic' && (i.parentId || i.sprintId)) throw badRequest('An epic is not planned into a sprint or put under another item');
  if (i.workType === 'subtask' && !i.parentId) throw badRequest('A sub-task needs a parent');
  let epicId = i.epicId ?? null;
  if (i.parentId) epicId = (await checkParent(ctx.tx, ctx.tenantId, projectId, i.workType, i.parentId)).epicId ?? epicId;
  const custom = await cleanCustom(ctx.tx, ctx.tenantId, projectId, i.workType, i.custom ?? {}, {}, opts.skipRequired);
  let assignees = i.assignees ?? [];
  if (!assignees.length && i.componentIds?.length) {
    const lead = await ctx.tx.one<{ lead_id: string }>(`select lead_id from project_components where tenant_id = $1 and id = any($2::uuid[]) and assign_lead and lead_id is not null order by name limit 1`, [ctx.tenantId, i.componentIds]);
    if (lead) assignees = [lead.lead_id];
  }
  // sub-items follow their parent's sprint
  let sprintId = i.sprintId ?? null;
  if (!sprintId && i.parentId && (i.workType === 'subtask' || i.workType === 'task')) sprintId = (await ctx.tx.one<{ sprint_id: string | null }>(`select sprint_id from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, i.parentId]))?.sprint_id ?? null;
  const t = await createTask(ctx, projectId, {
    name: i.name, description: i.description ?? null, priority: i.priority ?? 'medium', assignees, startDate: i.startDate ?? null, dueDate: i.dueDate ?? null,
    estimateHours: i.estimateHours ?? null, tags: i.tags ?? [], status: 'open', workType: i.workType, parentId: i.parentId ?? null,
  });
  await ctx.tx.query(
    `update project_tasks set story_points = $3, sprint_id = $4, release_id = $5, epic_id = coalesce(epic_id, $6), component_ids = $7, custom = $8, severity = $9, remaining_hours = $10,
            reporter_id = coalesce($11, reporter_id), backlog_rank = (select coalesce(max(backlog_rank), 0) + 10 from project_tasks where tenant_id = $1 and project_id = $12)
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, t.id, i.storyPoints ?? null, sprintId, i.releaseId ?? null, i.workType === 'epic' ? null : epicId, [...new Set(i.componentIds ?? [])], JSON.stringify(custom), i.severity ?? null,
      i.remainingHours ?? i.estimateHours ?? null, i.reporterId ?? null, projectId],
  );
  await watch(ctx.tx, ctx.tenantId, t.id, [ctx.principal.user.id, ...assignees]);
  if (i.state) await transition(ctx, projectId, t.id, { to: i.state });
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  await fireRules(ctx, projectId, t.id, { kind: 'created' });
  return { id: t.id, number: t.number, key: `${key}-${t.number}` };
}

export async function updateItem(ctx: RecordCtx, projectId: string, taskId: string, i: ItemInput) {
  const { level } = await projectAccess(ctx, projectId, 'member');
  const cur = await itemRow(ctx.tx, ctx.tenantId, projectId, taskId, true);
  await checkPlan(ctx.tx, ctx.tenantId, projectId, i);
  const type: WorkType = i.workType ?? cur.work_type;
  if (i.workType && i.workType !== cur.work_type) {
    // a type change must still fit the hierarchy, both upwards and downwards
    const parent = i.parentId !== undefined ? i.parentId : cur.parent_id;
    if (parent) await checkParent(ctx.tx, ctx.tenantId, projectId, type, parent, taskId);
    const kids = await ctx.tx.query<{ work_type: WorkType }>(`select distinct work_type from project_tasks where tenant_id = $1 and parent_id = $2`, [ctx.tenantId, taskId]);
    for (const k of kids) if (LEVEL[k.work_type] <= LEVEL[type]) throw badRequest(`It has ${k.work_type} children, which cannot sit under a ${type}`);
    if (type === 'epic' && parent) throw badRequest('An epic cannot sit under another item');
  }
  if (i.parentId && i.parentId !== cur.parent_id) await checkParent(ctx.tx, ctx.tenantId, projectId, type, i.parentId, taskId);
  if (type === 'subtask' && !(i.parentId !== undefined ? i.parentId : cur.parent_id)) throw badRequest('A sub-task needs a parent');
  if (type !== cur.work_type) await ctx.tx.query(`update project_tasks set work_type = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId, type]);
  const core: TaskInput = {};
  for (const k of ['name', 'description', 'priority', 'assignees', 'startDate', 'dueDate', 'estimateHours', 'tags'] as const) if (i[k] !== undefined) (core as Record<string, unknown>)[k] = i[k];
  if (i.parentId !== undefined) core.parentId = i.parentId;
  // parent changes are checked above with the item's type; projects.updateTask checks again with it
  if (Object.keys(core).length) await updateTask(ctx, projectId, taskId, core);
  const custom = i.custom ? await cleanCustom(ctx.tx, ctx.tenantId, projectId, type, i.custom, cur.custom ?? {}) : i.workType && i.workType !== cur.work_type ? await cleanCustom(ctx.tx, ctx.tenantId, projectId, type, {}, cur.custom ?? {}) : null;
  if (type === 'epic' && (i.sprintId || (cur.sprint_id && i.sprintId === undefined))) i.sprintId = null;
  await ctx.tx.query(
    `update project_tasks set work_type = $3,
            story_points = case when $4::boolean then $5::numeric else story_points end,
            sprint_id = case when $6::boolean then $7::uuid else sprint_id end,
            release_id = case when $8::boolean then $9::uuid else release_id end,
            component_ids = coalesce($10, component_ids), custom = coalesce($11, custom),
            severity = case when $12::boolean then $13 else severity end,
            remaining_hours = case when $14::boolean then $15::numeric else remaining_hours end,
            reporter_id = case when $16::boolean then $17::uuid else reporter_id end,
            epic_id = case when $18::boolean and parent_id is null then $19::uuid else epic_id end, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, taskId, type, i.storyPoints !== undefined, i.storyPoints ?? null, i.sprintId !== undefined, i.sprintId ?? null, i.releaseId !== undefined, i.releaseId ?? null,
      i.componentIds ? [...new Set(i.componentIds)] : null, custom ? JSON.stringify(custom) : null, i.severity !== undefined, i.severity ?? null,
      i.remainingHours !== undefined, i.remainingHours ?? null, i.reporterId !== undefined, i.reporterId ?? null, i.epicId !== undefined, i.epicId ?? null,
    ],
  );
  if (type === 'epic' && cur.work_type !== 'epic') await ctx.tx.query(`update project_tasks set epic_id = null where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]);
  if (cur.work_type === 'epic' && type !== 'epic') await ctx.tx.query(`update project_tasks set epic_id = null where tenant_id = $1 and epic_id = $2`, [ctx.tenantId, taskId]);
  if (i.parentId !== undefined || i.workType !== undefined || i.epicId !== undefined) await refreshEpics(ctx.tx, ctx.tenantId, taskId);
  // sub-items follow the parent into a sprint
  if (i.sprintId !== undefined) await ctx.tx.query(`update project_tasks set sprint_id = $3 where tenant_id = $1 and parent_id = $2 and work_type in ('subtask','task','chore')`, [ctx.tenantId, taskId, i.sprintId ?? null]);
  if (i.state) await transition(ctx, projectId, taskId, { to: i.state });
  await watch(ctx.tx, ctx.tenantId, taskId, [ctx.principal.user.id]);
  if (i.assignees?.length) await watch(ctx.tx, ctx.tenantId, taskId, i.assignees);
  void level;
  // rules on changed fields
  const after = (await ctx.tx.one<Record<string, any>>(`select priority, assignees, sprint_id, severity, work_type, story_points, tags, due_date::text as due_date from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]))!;
  const was: Record<string, unknown> = { priority: cur.priority, assignee: cur.assignees[0] ?? null, sprint: cur.sprint_id, severity: cur.severity, type: cur.work_type, points: cur.story_points === null ? null : Number(cur.story_points), labels: [...cur.tags].sort().join(','), due: cur.due_date ? d10(cur.due_date) : null };
  const now: Record<string, unknown> = { priority: after.priority, assignee: after.assignees[0] ?? null, sprint: after.sprint_id, severity: after.severity, type: after.work_type, points: after.story_points === null ? null : Number(after.story_points), labels: [...after.tags].sort().join(','), due: after.due_date };
  for (const f of Object.keys(now)) if (String(was[f] ?? '') !== String(now[f] ?? '')) await fireRules(ctx, projectId, taskId, { kind: 'field_changed', field: f, to: now[f] === null ? null : String(now[f]) });
  return { ok: true };
}

/** Everything about one work item, for its full view. */
export async function getItem(ctx: RecordCtx, projectId: string, taskId: string) {
  const { project, level } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const t = await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const wfs = await projectWorkflows(ctx.tx, ctx.tenantId, projectId);
  const wf = pickWorkflow(wfs, t.work_type);
  const state = currentState(wf, t.state, t.status);
  const brief = `t.id, t.task_number, t.name, t.work_type, t.status, t.state, t.assignees, t.story_points::float8 as story_points, t.priority, t.project_id`;
  const parent = await (t.parent_id ? ctx.tx.one(`select ${brief} from project_tasks t where t.tenant_id = $1 and t.id = $2`, [ctx.tenantId, t.parent_id]) : null);
  // open children first; a parent with thousands of children shows the first 300 and the counts
  const children = await (ctx.tx.query(`select ${brief} from project_tasks t where t.tenant_id = $1 and t.parent_id = $2 order by (t.status in ('done','cancelled')), t.backlog_rank, t.task_number limit 300`, [ctx.tenantId, taskId]));
  const childStats = await ctx.tx.one<{ total: number; closed: number }>(`select count(*)::int as total, count(*) filter (where status in ('done','cancelled'))::int as closed from project_tasks where tenant_id = $1 and parent_id = $2`, [ctx.tenantId, taskId]);
  const epic = await (t.epic_id ? ctx.tx.one(`select ${brief} from project_tasks t where t.tenant_id = $1 and t.id = $2`, [ctx.tenantId, t.epic_id]) : null);
  const relations = await (ctx.tx.query(
      `select r.id, r.kind, (r.task_id = $2) as outward, o.id as item_id, o.task_number, o.name, o.status, o.work_type, op.work_key, o.project_id
         from project_task_relations r join project_tasks o on o.tenant_id = r.tenant_id and o.id = case when r.task_id = $2 then r.other_id else r.task_id end
         join projects op on op.tenant_id = o.tenant_id and op.id = o.project_id
        where r.tenant_id = $1 and (r.task_id = $2 or r.other_id = $2) order by r.created_at`,
      [ctx.tenantId, taskId],
    ));
  const links = await (ctx.tx.query(`select id, kind, url, title, status, source, author, repo, occurred_at, created_at from project_task_links where tenant_id = $1 and task_id = $2 order by coalesce(occurred_at, created_at) desc limit 200`, [ctx.tenantId, taskId]));
  const watchers = await (ctx.tx.query<{ user_id: string; full_name: string }>(`select w.user_id, u.full_name from project_task_watchers w join users u on u.tenant_id = w.tenant_id and u.id = w.user_id where w.tenant_id = $1 and w.task_id = $2 order by u.full_name`, [ctx.tenantId, taskId]));
  const comments = await (ctx.tx.query(`select c.id, c.body, c.created_at, c.user_id, u.full_name from project_comments c left join users u on u.tenant_id = c.tenant_id and u.id = c.user_id where c.tenant_id = $1 and c.task_id = $2 order by c.created_at limit 500`, [ctx.tenantId, taskId]));
  const history = await (ctx.tx.query(`select h.id, h.field, h.old_value, h.new_value, h.at, h.actor_id, u.full_name as actor from project_task_history h left join users u on u.tenant_id = h.tenant_id and u.id = h.actor_id where h.tenant_id = $1 and h.task_id = $2 order by h.at desc limit 300`, [ctx.tenantId, taskId]));
  const tests = await (ctx.tx.query(
      `select c.id, c.case_number, c.title, (select r.result from pm_test_runs r where r.tenant_id = c.tenant_id and r.case_id = c.id and r.result <> 'untested' order by r.run_at desc nulls last limit 1) as last_result
         from pm_test_cases c where c.tenant_id = $1 and $2::uuid = any(c.item_ids) and c.status <> 'obsolete' order by c.case_number`,
      [ctx.tenantId, taskId],
    ));
  const worklog = await (ctx.tx.one<{ minutes: number }>(`select coalesce(sum(minutes), 0)::int as minutes from time_entries where tenant_id = $1 and task_id = $2`, [ctx.tenantId, taskId]));

  // history values that are ids, as names
  const ids = new Set<string>();
  for (const h of history as Record<string, any>[]) for (const v of [h.old_value, h.new_value]) for (const m of String(v ?? '').matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) ids.add(m[0]);
  const names = new Map<string, string>();
  if (ids.size) {
    const list = [...ids];
    for (const r of await ctx.tx.query<{ id: string; n: string }>(
      `select id, full_name as n from users where tenant_id = $1 and id = any($2::uuid[])
       union all select id, name from project_sprints where tenant_id = $1 and id = any($2::uuid[])
       union all select id, name from project_releases where tenant_id = $1 and id = any($2::uuid[])
       union all select id, name from project_components where tenant_id = $1 and id = any($2::uuid[])
       union all select t.id, coalesce(p.work_key, 'ITEM') || '-' || t.task_number || ' ' || t.name from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and t.id = any($2::uuid[])`,
      [ctx.tenantId, list],
    ))
      names.set(r.id, r.n);
  }
  const stateLabel = (k: string | null) => (k ? wfs.flatMap((w) => w.states).find((s) => s.key === k)?.label ?? DEFAULT_WORKFLOW.states.find((s) => s.key === k)?.label ?? k : null);
  const pretty = (field: string, v: string | null) => {
    if (v === null || v === '') return null;
    if (field === 'state' || field === 'status' || field === 'created') return stateLabel(v);
    return v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (m) => names.get(m) ?? 'removed').replace(/^\{(.*)\}$/, '$1').replace(/"/g, '');
  };
  const userNames = await ctx.tx.query<{ id: string; full_name: string }>(`select id, full_name from users where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, [...t.assignees, ...(t.reporter_id ? [t.reporter_id] : [])]]);
  return {
    item: {
      id: t.id, key: `${key}-${t.task_number}`, number: t.task_number, name: t.name, description: t.description, workType: t.work_type, status: t.status, state: state.key, stateLabel: state.label, category: state.category,
      priority: t.priority, severity: t.severity, resolution: t.resolution, assignees: t.assignees, reporterId: t.reporter_id, storyPoints: t.story_points === null ? null : Number(t.story_points),
      estimateHours: t.estimate_hours === null ? null : Number(t.estimate_hours), remainingHours: t.remaining_hours === null ? null : Number(t.remaining_hours), loggedHours: Math.round(((worklog?.minutes ?? 0) / 60) * 100) / 100,
      startDate: t.start_date ? d10(t.start_date) : null, dueDate: t.due_date ? d10(t.due_date) : null, sprintId: t.sprint_id, releaseId: t.release_id, parentId: t.parent_id, epicId: t.epic_id,
      componentIds: t.component_ids, tags: t.tags, custom: t.custom, createdAt: t.created_at, updatedAt: t.updated_at, completedAt: t.completed_at, startedAt: t.started_at, createdBy: t.created_by,
      externalKey: t.external_key, externalUrl: t.external_url,
    },
    people: Object.fromEntries(userNames.map((u) => [u.id, u.full_name])),
    workflow: { name: wf.name, states: wf.states, moves: level === 'view' ? [] : movesFrom(wf, state.key, roleOf(level)).map((m) => ({ to: m.to, label: m.name || m.toState.label, category: m.toState.category, require: m.require ?? [] })) },
    parent: parent ? withKey(parent, key) : null,
    epic: epic ? withKey(epic, key) : null,
    children: (children as Record<string, any>[]).map((c) => withKey(c, key)),
    childStats: childStats ?? { total: 0, closed: 0 },
    relations: (relations as Record<string, any>[]).map((r) => ({ id: r.id, kind: r.kind, outward: r.outward, label: relationLabel(r.kind, r.outward), item: { id: r.item_id, key: `${r.work_key ?? key}-${r.task_number}`, name: r.name, status: r.status, workType: r.work_type, projectId: r.project_id } })),
    links,
    watchers,
    watching: watchers.some((w) => w.user_id === ctx.principal.user.id),
    comments,
    history: (history as Record<string, any>[]).map((h) => ({ id: h.id, field: h.field, from: pretty(h.field, h.old_value), to: pretty(h.field, h.new_value), at: h.at, actor: h.actor ?? 'Synapse' })),
    tests,
    level,
    branchName: `${t.work_type === 'bug' ? 'bugfix' : 'feature'}/${key}-${t.task_number}-${String(t.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`,
  };
}

const withKey = (r: Record<string, any>, key: string) => ({ id: r.id, key: `${key}-${r.task_number}`, number: r.task_number, name: r.name, workType: r.work_type, status: r.status, state: r.state, assignees: r.assignees, storyPoints: r.story_points, priority: r.priority });

const REL: Record<string, [string, string]> = {
  relates: ['relates to', 'relates to'],
  blocks: ['blocks', 'is blocked by'],
  duplicates: ['duplicates', 'is duplicated by'],
  clones: ['clones', 'is cloned by'],
  causes: ['causes', 'is caused by'],
  tests: ['tests', 'is tested by'],
};
const relationLabel = (kind: string, outward: boolean) => REL[kind]?.[outward ? 0 : 1] ?? kind;

export async function addRelation(ctx: RecordCtx, projectId: string, taskId: string, kind: string, otherKey: string) {
  await projectAccess(ctx, projectId, 'member');
  await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const other = await findByKey(ctx, otherKey, projectId);
  if (!other) throw badRequest(`No work item ${otherKey} you can see`);
  if (other.id === taskId) throw badRequest('An item cannot relate to itself');
  await ctx.tx.query(`insert into project_task_relations (tenant_id, task_id, other_id, kind) values ($1,$2,$3,$4) on conflict do nothing`, [ctx.tenantId, taskId, other.id, kind]);
  return { ok: true, other };
}

export async function removeRelation(ctx: RecordCtx, projectId: string, taskId: string, relationId: string) {
  await projectAccess(ctx, projectId, 'member');
  await ctx.tx.query(`delete from project_task_relations where tenant_id = $1 and id = $2 and (task_id = $3 or other_id = $3)`, [ctx.tenantId, relationId, taskId]);
  return { ok: true };
}

/** A work item by key (FLEET-12) or number within the current project, in a project the person can see. */
export async function findByKey(ctx: RecordCtx, raw: string, projectId: string): Promise<{ id: string; projectId: string } | null> {
  const s = raw.trim().toUpperCase();
  const m = /^([A-Z][A-Z0-9]{1,9})-(\d{1,7})$/.exec(s);
  const row = m
    ? await ctx.tx.one<{ id: string; project_id: string }>(`select t.id, t.project_id from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and p.work_key = $2 and t.task_number = $3`, [ctx.tenantId, m[1], Number(m[2])])
    : /^#?\d{1,7}$/.test(s)
      ? await ctx.tx.one<{ id: string; project_id: string }>(`select id, project_id from project_tasks where tenant_id = $1 and project_id = $2 and task_number = $3`, [ctx.tenantId, projectId, Number(s.replace('#', ''))])
      : null;
  if (!row) return null;
  try {
    await projectAccess(ctx, row.project_id, 'view');
  } catch {
    return null;
  }
  return { id: row.id, projectId: row.project_id };
}

/* ───────────────────────── comments with @mentions ───────────────────────── */

/** Comments on an item; @[Name](user-id) and @Full Name of a project person notify them. */
export async function comment(ctx: RecordCtx, projectId: string, taskId: string, body: string) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  const t = await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const c = await addComment(ctx, projectId, { taskId }, body);
  const team = await ctx.tx.query<{ id: string; full_name: string }>(
    `select u.id, u.full_name from users u where u.tenant_id = $1 and u.status = 'active' and (u.id = $3 or u.id in (select user_id from project_members where tenant_id = $1 and project_id = $2))`,
    [ctx.tenantId, projectId, project.owner_id ?? null],
  );
  const mentioned = new Set<string>();
  for (const m of body.matchAll(/@\[[^\]]{1,80}\]\(([0-9a-f-]{36})\)/g)) if (team.some((u) => u.id === m[1])) mentioned.add(m[1]!);
  const lower = body.toLowerCase();
  for (const u of team) if (u.full_name && lower.includes(`@${u.full_name.toLowerCase()}`)) mentioned.add(u.id);
  mentioned.delete(ctx.principal.user.id);
  const key = `${await workKey(ctx.tx, ctx.tenantId, project)}-${t.task_number}`;
  const plain = body.replace(/@\[([^\]]+)\]\([0-9a-f-]{36}\)/g, '@$1');
  await workNotify(ctx, [...mentioned], 'mentioned', { title: `${ctx.principal.user.fullName || 'Someone'} mentioned you on ${key} ${t.name}`, body: plain.slice(0, 300), link: itemLink(projectId, taskId) });
  await watch(ctx.tx, ctx.tenantId, taskId, [ctx.principal.user.id, ...mentioned]);
  // addComment already told the assignees and the creator
  await notifyWatchers(ctx, taskId, `New comment on ${key} ${t.name}`, itemLink(projectId, taskId), plain, [...mentioned, ...t.assignees, t.created_by].filter(Boolean));
  if (!body.startsWith('🤖')) await fireRules(ctx, projectId, taskId, { kind: 'commented' });
  return { id: c!.id, mentioned: [...mentioned] };
}

/* ───────────────────────── bulk edit ───────────────────────── */

export interface BulkInput {
  ids: string[];
  set?: { state?: string; status?: string; assignee?: string | null; priority?: TaskInput['priority']; sprintId?: string | null; releaseId?: string | null; storyPoints?: number | null; parentId?: string | null; addLabels?: string[]; removeLabels?: string[]; addComponent?: string; dueDate?: string | null };
  remove?: boolean;
  watch?: boolean;
}

export async function bulkEdit(ctx: RecordCtx, projectId: string, b: BulkInput) {
  await projectAccess(ctx, projectId, 'member');
  const done: string[] = [];
  const failed: { id: string; key: string; error: string }[] = [];
  const rows = await ctx.tx.query<{ id: string; task_number: number; tags: string[]; component_ids: string[]; work_type: string; state: string | null; status: string }>(
    `select id, task_number, tags, component_ids, work_type, state, status from project_tasks where tenant_id = $1 and project_id = $2 and id = any($3::uuid[]) order by task_number`,
    [ctx.tenantId, projectId, b.ids],
  );
  if (rows.length !== new Set(b.ids).size) throw badRequest('Some items are not in this project');
  const project = (await projectAccess(ctx, projectId)).project;
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  for (const r of rows) {
    // each item in its own savepoint: one refusal does not undo the others
    await ctx.tx.query('savepoint bulk_item');
    try {
      if (b.remove) await deleteTask(ctx, projectId, r.id);
      else {
        const s = b.set ?? {};
        const patch: ItemInput = {};
        if (s.assignee !== undefined) patch.assignees = s.assignee ? [s.assignee] : [];
        if (s.priority) patch.priority = s.priority;
        if (s.sprintId !== undefined) patch.sprintId = s.sprintId;
        if (s.releaseId !== undefined) patch.releaseId = s.releaseId;
        if (s.storyPoints !== undefined) patch.storyPoints = s.storyPoints;
        if (s.parentId !== undefined) patch.parentId = s.parentId;
        if (s.dueDate !== undefined) patch.dueDate = s.dueDate;
        if (s.addLabels?.length || s.removeLabels?.length) patch.tags = [...new Set([...r.tags.filter((x) => !(s.removeLabels ?? []).includes(x)), ...(s.addLabels ?? [])])].slice(0, 20);
        if (s.addComponent) patch.componentIds = [...new Set([...r.component_ids, s.addComponent])];
        if (Object.keys(patch).length) await updateItem(ctx, projectId, r.id, patch);
        if (s.state) await transition(ctx, projectId, r.id, { to: s.state });
        else if (s.status) {
          const wf = pickWorkflow(await projectWorkflows(ctx.tx, ctx.tenantId, projectId), r.work_type);
          const target = wf.id ? movesFrom(wf, currentState(wf, r.state, r.status).key, 'manager').find((m) => statusOf(m.toState.category) === s.status)?.to : s.status;
          if (!target) throw badRequest(`No move to ${s.status} in the ${wf.name} workflow`);
          await transition(ctx, projectId, r.id, { to: target });
        }
        if (b.watch !== undefined) await setWatching(ctx, projectId, r.id, b.watch);
      }
      await ctx.tx.query('release savepoint bulk_item');
      done.push(r.id);
    } catch (e) {
      await ctx.tx.query('rollback to savepoint bulk_item');
      failed.push({ id: r.id, key: `${key}-${r.task_number}`, error: (e as Error).message });
    }
  }
  return { done: done.length, failed };
}

/* ───────────────────────── queries ───────────────────────── */

/** Projects the person can query across (admins: all; others: member, owner or allowed to read every project). */
async function visibleProjectIds(ctx: RecordCtx): Promise<string[]> {
  const all = hasAdmin(ctx.principal.permissions, 'projects') || objectPerm(ctx.principal.permissions, 'project').read === 'all';
  const rows = await ctx.tx.query<{ id: string }>(
    `select id from projects p where tenant_id = $1 and deleted_at is null and ($2::boolean or owner_id = $3 or exists (select 1 from project_members m where m.tenant_id = p.tenant_id and m.project_id = p.id and m.user_id = $3))`,
    [ctx.tenantId, all, ctx.principal.user.id],
  );
  return rows.map((r) => r.id);
}

export async function wqlContext(ctx: RecordCtx, projectIds: string[]): Promise<WqlContext> {
  const cf = await ctx.tx.query<{ key: string; label: string; type: string }>(`select distinct on (key) key, label, type from pm_field_defs where tenant_id = $1 and project_id = any($2::uuid[]) order by key`, [ctx.tenantId, projectIds]);
  const wf = await ctx.tx.query<{ states: WfState[] }>(`select states from pm_workflows where tenant_id = $1 and project_id = any($2::uuid[])`, [ctx.tenantId, projectIds]);
  const labels = new Map<string, string[]>();
  for (const w of wf) for (const s of w.states) labels.set(s.label.toLowerCase(), [...(labels.get(s.label.toLowerCase()) ?? []), s.key]);
  for (const s of DEFAULT_WORKFLOW.states) labels.set(s.label.toLowerCase(), [...(labels.get(s.label.toLowerCase()) ?? []), s.key]);
  return { userId: ctx.principal.user.id, customFields: cf.map((c) => ({ ...c, label: c.label.toLowerCase() })), stateLabels: labels };
}

const ITEM_SELECT = `t.id, t.project_id, p.work_key, p.name as project_name, t.task_number, t.name, t.work_type, t.status, t.state, t.priority, t.severity, t.assignees, t.reporter_id,
  t.story_points::float8 as story_points, t.estimate_hours::float8 as estimate_hours, t.remaining_hours::float8 as remaining_hours, t.sprint_id, s.name as sprint_name, t.release_id, r.name as release_name,
  t.epic_id, e.task_number as epic_number, e.name as epic_name, t.parent_id, pa.task_number as parent_number, t.component_ids, t.tags, t.due_date::text as due_date, t.created_at, t.updated_at, t.completed_at,
  t.backlog_rank, t.custom, t.resolution,
  (select array_agg(u.full_name order by u.full_name) from users u where u.tenant_id = t.tenant_id and u.id = any(t.assignees)) as assignee_names,
  (select count(*)::int from project_tasks c where c.tenant_id = t.tenant_id and c.parent_id = t.id) as child_count,
  (select count(*)::int from project_tasks c where c.tenant_id = t.tenant_id and c.parent_id = t.id and c.status in ('done','cancelled')) as child_done`;
const ITEM_FROM = `from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
  left join project_sprints s on s.tenant_id = t.tenant_id and s.id = t.sprint_id left join project_releases r on r.tenant_id = t.tenant_id and r.id = t.release_id
  left join project_tasks e on e.tenant_id = t.tenant_id and e.id = t.epic_id left join project_tasks pa on pa.tenant_id = t.tenant_id and pa.id = t.parent_id`;

/** Runs a query over one project or every project the person can see. */
export async function runQuery(ctx: RecordCtx, q: { projectId: string | null; query: string; limit?: number; offset?: number; extra?: string | null }) {
  let ids: string[];
  if (q.projectId) {
    await projectAccess(ctx, q.projectId, 'view');
    ids = [q.projectId];
  } else ids = await visibleProjectIds(ctx);
  const wctx = await wqlContext(ctx, ids);
  const main = compileWql(q.query, wctx, [ctx.tenantId, ids]);
  let where = main.where;
  let params = main.params;
  if (q.extra?.trim()) {
    const ex = compileWql(q.extra, wctx, params);
    where = `(${where}) and (${ex.where})`;
    params = ex.params;
  }
  const order = main.order || 't.backlog_rank, t.task_number';
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
  const base = `${ITEM_FROM} where t.tenant_id = $1 and t.project_id = any($2::uuid[]) and p.deleted_at is null and (${where})`;
  const total = await ctx.tx.one<{ n: number; points: number }>(`select count(*)::int as n, coalesce(sum(t.story_points), 0)::float8 as points ${base}`, params);
  const rows = await ctx.tx.query<Record<string, any>>(`select ${ITEM_SELECT} ${base} order by ${order}, t.task_number limit ${limit} offset ${Math.max(0, q.offset ?? 0)}`, params);
  // workflow state labels per project / type
  const wfByProject = new Map<string, Workflow[]>();
  for (const pid of new Set(rows.map((r) => r.project_id))) wfByProject.set(pid, await projectWorkflows(ctx.tx, ctx.tenantId, pid));
  const keys = new Map<string, string>();
  for (const pid of new Set(rows.filter((r) => !r.work_key).map((r) => r.project_id))) {
    const pr = await ctx.tx.one<Record<string, any>>(`select * from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, pid]);
    keys.set(pid, await workKey(ctx.tx, ctx.tenantId, pr!));
  }
  return {
    total: total!.n,
    points: total!.points,
    items: rows.map((r) => {
      const k = r.work_key ?? keys.get(r.project_id);
      const st = currentState(pickWorkflow(wfByProject.get(r.project_id) ?? [], r.work_type), r.state, r.status);
      return {
        id: r.id, projectId: r.project_id, projectName: r.project_name, key: `${k}-${r.task_number}`, number: r.task_number, name: r.name, workType: r.work_type, status: r.status, state: st.key, stateLabel: st.label,
        category: st.category, priority: r.priority, severity: r.severity, assignees: r.assignees, assigneeNames: r.assignee_names ?? [], storyPoints: r.story_points, estimateHours: r.estimate_hours, remainingHours: r.remaining_hours,
        sprintId: r.sprint_id, sprintName: r.sprint_name, releaseId: r.release_id, releaseName: r.release_name, epicId: r.epic_id, epicKey: r.epic_number ? `${k}-${r.epic_number}` : null, epicName: r.epic_name,
        parentId: r.parent_id, parentKey: r.parent_number ? `${k}-${r.parent_number}` : null, componentIds: r.component_ids, tags: r.tags, dueDate: r.due_date, createdAt: r.created_at, updatedAt: r.updated_at,
        completedAt: r.completed_at, rank: r.backlog_rank, custom: r.custom, resolution: r.resolution, childCount: r.child_count, childDone: r.child_done,
      };
    }),
  };
}

/** Counts of a query's items by a field (dashboard widgets). */
export async function groupQuery(ctx: RecordCtx, projectId: string, query: string, by: 'status' | 'state' | 'assignee' | 'type' | 'priority' | 'sprint' | 'component' | 'epic' | 'release' | 'labels') {
  const { items } = await runQuery(ctx, { projectId, query, limit: 2000 });
  const m = new Map<string, { label: string; count: number; points: number }>();
  const comps = by === 'component' ? new Map((await ctx.tx.query<{ id: string; name: string }>(`select id, name from project_components where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId])).map((c) => [c.id, c.name])) : null;
  for (const it of items) {
    const keys: string[] =
      by === 'status' ? [it.category] : by === 'state' ? [it.stateLabel] : by === 'assignee' ? (it.assigneeNames.length ? it.assigneeNames : ['Unassigned']) : by === 'type' ? [it.workType] : by === 'priority' ? [it.priority]
      : by === 'sprint' ? [it.sprintName ?? 'Backlog'] : by === 'release' ? [it.releaseName ?? 'No release'] : by === 'epic' ? [it.epicName ?? 'No epic'] : by === 'labels' ? (it.tags.length ? it.tags : ['No label'])
      : it.componentIds.length ? it.componentIds.map((c: string) => comps!.get(c) ?? 'Removed') : ['No component'];
    for (const k of keys) {
      const g = m.get(k) ?? { label: k, count: 0, points: 0 };
      g.count++;
      g.points += Number(it.storyPoints ?? 0);
      m.set(k, g);
    }
  }
  const order = by === 'status' ? CATEGORIES : by === 'priority' ? ['urgent', 'high', 'medium', 'low', 'none'] : null;
  const groups = [...m.values()].sort((a, b) => (order ? order.indexOf(a.label as never) - order.indexOf(b.label as never) : b.count - a.count));
  return { total: items.length, groups };
}

export async function listQueries(ctx: RecordCtx, projectId: string | null) {
  if (projectId) await projectAccess(ctx, projectId, 'view');
  return ctx.tx.query(
    `select q.id, q.project_id, q.name, q.query, q.columns, q.shared, q.owner_id, u.full_name as owner_name, (q.owner_id = $3) as mine
       from pm_queries q left join users u on u.tenant_id = q.tenant_id and u.id = q.owner_id
      where q.tenant_id = $1 and (q.project_id is not distinct from $2::uuid) and (q.owner_id = $3 or q.shared) order by lower(q.name)`,
    [ctx.tenantId, projectId, ctx.principal.user.id],
  );
}

export async function saveQuery(ctx: RecordCtx, projectId: string | null, id: string | null, q: { name: string; query: string; columns?: string[]; shared?: boolean }) {
  if (projectId) await projectAccess(ctx, projectId, 'view');
  // must compile
  const ids = projectId ? [projectId] : await visibleProjectIds(ctx);
  compileWql(q.query, await wqlContext(ctx, ids), [ctx.tenantId, ids]);
  if (id) {
    const r = await ctx.tx.one(`update pm_queries set name = $4, query = $5, columns = coalesce($6, columns), shared = coalesce($7, shared), updated_at = now() where tenant_id = $1 and id = $2 and owner_id = $3 returning id`, [
      ctx.tenantId, id, ctx.principal.user.id, q.name, q.query, q.columns ?? null, q.shared ?? null,
    ]);
    if (!r) throw notFound('Only the owner changes a saved query');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_queries (tenant_id, project_id, name, query, columns, shared) values ($1,$2,$3,$4,coalesce($5, '{key,type,name,state,assignee,priority,points}'::text[]),$6) returning id`, [
    ctx.tenantId, projectId, q.name, q.query, q.columns ?? null, q.shared ?? false,
  ]);
  return { id: r!.id };
}

export async function deleteQuery(ctx: RecordCtx, id: string) {
  const r = await ctx.tx.one(`delete from pm_queries where tenant_id = $1 and id = $2 and owner_id = $3 returning id`, [ctx.tenantId, id, ctx.principal.user.id]);
  if (!r) throw notFound('Only the owner deletes a saved query');
  return { ok: true };
}

/** CSV of a query's results. */
export async function exportQuery(ctx: RecordCtx, projectId: string | null, query: string) {
  const { items } = await runQuery(ctx, { projectId, query, limit: 2000 });
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
  };
  const head = ['Key', 'Type', 'Summary', 'State', 'Status', 'Assignee', 'Priority', 'Points', 'Sprint', 'Release', 'Epic', 'Parent', 'Labels', 'Due', 'Created', 'Updated', 'Resolved', 'Project'];
  const lines = [head.join(',')];
  for (const i of items) lines.push([i.key, i.workType, i.name, i.stateLabel, i.category, i.assigneeNames, i.priority, i.storyPoints, i.sprintName, i.releaseName, i.epicKey, i.parentKey, i.tags, i.dueDate, d10(i.createdAt), d10(i.updatedAt), i.completedAt ? d10(i.completedAt) : '', i.projectName].map(esc).join(','));
  return lines.join('\r\n');
}

/* ───────────────────────── boards ───────────────────────── */

export interface BoardColumn {
  name: string;
  states: string[];
  categories?: Category[];
  wip?: number | null;
}
export interface BoardInput {
  name: string;
  kind: 'scrum' | 'kanban';
  columns: BoardColumn[];
  swimlane: 'none' | 'assignee' | 'epic' | 'parent' | 'priority' | 'type';
  filter?: string | null;
  quickFilters: { name: string; query: string }[];
  cardFields: string[];
}

const DEFAULT_COLUMNS: BoardColumn[] = [
  { name: 'To do', states: [], categories: ['todo'], wip: null },
  { name: 'In progress', states: [], categories: ['in_progress', 'blocked'], wip: null },
  { name: 'Review', states: [], categories: ['review'], wip: null },
  { name: 'Done', states: [], categories: ['done'], wip: null },
];

export async function listBoards(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const rows = await ctx.tx.query(`select id, name, kind, columns, swimlane, filter, quick_filters, card_fields, position from project_boards where tenant_id = $1 and project_id = $2 order by position, created_at`, [ctx.tenantId, projectId]);
  return rows.length ? rows : [defaultBoard()];
}
const defaultBoard = () => ({ id: null, name: 'Team board', kind: 'kanban', columns: DEFAULT_COLUMNS, swimlane: 'none', filter: null, quick_filters: [{ name: 'Only my items', query: 'assignee = currentUser()' }, { name: 'Bugs', query: 'type = bug' }], card_fields: ['points', 'assignee', 'priority'], position: 0 });

export async function saveBoard(ctx: RecordCtx, projectId: string, id: string | null, b: BoardInput) {
  await projectAccess(ctx, projectId, 'manage');
  if (b.filter) compileWql(b.filter, await wqlContext(ctx, [projectId]), [ctx.tenantId, [projectId]]);
  for (const q of b.quickFilters) compileWql(q.query, await wqlContext(ctx, [projectId]), [ctx.tenantId, [projectId]]);
  const vals = [b.name, b.kind, JSON.stringify(b.columns), b.swimlane, b.filter ?? null, JSON.stringify(b.quickFilters), b.cardFields];
  if (id) {
    const r = await ctx.tx.one(`update project_boards set name = $4, kind = $5, columns = $6, swimlane = $7, filter = $8, quick_filters = $9, card_fields = $10 where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [ctx.tenantId, id, projectId, ...vals]);
    if (!r) throw notFound('Board not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into project_boards (tenant_id, project_id, name, kind, columns, swimlane, filter, quick_filters, card_fields, position)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,(select coalesce(max(position), 0) + 1 from project_boards where tenant_id = $1 and project_id = $2)) returning id`,
    [ctx.tenantId, projectId, ...vals],
  );
  return { id: r!.id };
}

export async function deleteBoard(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`delete from project_boards where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  return { ok: true };
}

function columnOf(cols: BoardColumn[], state: string, category: Category): number {
  const byState = cols.findIndex((c) => c.states.includes(state));
  if (byState >= 0) return byState;
  return cols.findIndex((c) => (c.categories ?? []).includes(category));
}

/** A board: its columns with the items in them (scrum boards show the active sprint). */
export async function boardData(ctx: RecordCtx, projectId: string, boardId: string | null, quick: number[], search: string | null) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const board = boardId
    ? await ctx.tx.one<Record<string, any>>(`select id, name, kind, columns, swimlane, filter, quick_filters, card_fields from project_boards where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, boardId, projectId])
    : (await listBoards(ctx, projectId))[0];
  if (!board) throw notFound('Board not found');
  const sprint = board.kind === 'scrum' ? await ctx.tx.one<Record<string, any>>(`select id, name, goal, start_date::text, end_date::text from project_sprints where tenant_id = $1 and project_id = $2 and status = 'active'`, [ctx.tenantId, projectId]) : null;
  const parts = [board.filter || ''];
  for (const i of quick) if (board.quick_filters[i]) parts.push(`(${board.quick_filters[i].query})`);
  let q = parts.filter(Boolean).join(' AND ');
  if (search?.trim()) q = `${q ? `${q} AND ` : ''}text ~ ${JSON.stringify(search.trim())}`;
  const scope = board.kind === 'scrum' ? (sprint ? `sprint = ${JSON.stringify(sprint.id)}` : `sprint = "none-active"`) : `type not in (epic, feature) AND (status != done OR resolved >= -14d) AND status != cancelled`;
  const r = await runQuery(ctx, { projectId, query: q ? `(${q}) AND ${scope}` : scope, limit: 1500, extra: null });
  const cols: BoardColumn[] = board.columns;
  const items = r.items.filter((i) => i.workType !== 'epic' || board.kind === 'scrum').map((i) => ({ ...i, column: columnOf(cols, i.state, i.category as Category) })).filter((i) => i.column >= 0);
  const wfs = await projectWorkflows(ctx.tx, ctx.tenantId, projectId);
  return {
    board,
    sprint,
    canMove: level !== 'view',
    columns: cols.map((c, ix) => ({ ...c, count: items.filter((i) => i.column === ix).length, over: !!c.wip && items.filter((i) => i.column === ix).length > c.wip })),
    items,
    workflows: wfs.length ? wfs : [DEFAULT_WORKFLOW],
  };
}

/** Moves a card into a board column: the first state of that column that the item's workflow reaches. */
export async function moveCard(ctx: RecordCtx, projectId: string, boardId: string | null, taskId: string, column: number, rankAfter?: string | null) {
  const { level } = await projectAccess(ctx, projectId, 'member');
  const board = boardId ? await ctx.tx.one<{ columns: BoardColumn[] }>(`select columns from project_boards where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, boardId, projectId]) : { columns: DEFAULT_COLUMNS };
  const col = board?.columns[column];
  if (!col) throw badRequest('No such column');
  const t = await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const wf = pickWorkflow(await projectWorkflows(ctx.tx, ctx.tenantId, projectId), t.work_type);
  const cur = currentState(wf, t.state, t.status);
  if (columnOf(board!.columns, cur.key, cur.category) !== column) {
    const moves = movesFrom(wf, cur.key, roleOf(level));
    const target = moves.find((m) => col.states.includes(m.to)) ?? moves.find((m) => (col.categories ?? []).includes(m.toState.category) && !board!.columns.some((c) => c.states.includes(m.to)));
    if (!target) {
      const any = wf.states.find((s) => col.states.includes(s.key) || (col.categories ?? []).includes(s.category));
      throw badRequest(any ? `The ${wf.name} workflow has no move from ${cur.label} to ${col.name}` : `${col.name} has no state of the ${wf.name} workflow`);
    }
    await transition(ctx, projectId, taskId, { to: target.to });
  }
  if (rankAfter !== undefined) {
    const after = rankAfter ? await ctx.tx.one<{ backlog_rank: number }>(`select backlog_rank from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, rankAfter]) : null;
    const rank = after ? after.backlog_rank + 1 : 0;
    await ctx.tx.query(`update project_tasks set backlog_rank = backlog_rank + 2 where tenant_id = $1 and project_id = $2 and backlog_rank >= $3 and id <> $4`, [ctx.tenantId, projectId, rank, taskId]);
    await ctx.tx.query(`update project_tasks set backlog_rank = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId, rank]);
  }
  return { ok: true };
}

/* ───────────────────────── hierarchy view ───────────────────────── */

/** Epics → features → stories → tasks with roll-ups (points and progress). */
export async function hierarchy(ctx: RecordCtx, projectId: string, q: { open?: boolean }) {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  // roll-ups come from every item (a light read); only up to SHOW items are sent with their details,
  // open work first, so a project with tens of thousands of items still opens quickly
  const SHOW = 2500;
  const all = await ctx.tx.query<{ id: string; parent_id: string | null; epic_id: string | null; status: string; story_points: number | null; work_type: string }>(
    `select id, parent_id, epic_id, status, story_points::float8 as story_points, work_type from project_tasks where tenant_id = $1 and project_id = $2 limit 100000`,
    [ctx.tenantId, projectId],
  );
  const kids = new Map<string, string[]>();
  const light = new Map(all.map((r) => [r.id, r]));
  for (const r of all) {
    const p = r.parent_id && light.has(r.parent_id) ? r.parent_id : r.epic_id && light.has(r.epic_id) && r.epic_id !== r.id ? r.epic_id : null;
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(r.id);
  }
  const rolled = new Map<string, { points: number; done: number; items: number; closed: number }>();
  const rollOf = (id: string, depth = 0): { points: number; done: number; items: number; closed: number } => {
    const hit = rolled.get(id);
    if (hit) return hit;
    let points = 0;
    let done = 0;
    let items = 0;
    let closed = 0;
    for (const c of depth > 20 ? [] : kids.get(id) ?? []) {
      const r = rollOf(c, depth + 1);
      const row = light.get(c)!;
      points += r.points;
      done += r.done;
      items += r.items + 1;
      closed += r.closed + (['done', 'cancelled'].includes(row.status) ? 1 : 0);
    }
    const n = light.get(id)!;
    // estimates sit at the story level: a node's own points count when its children carry none
    if (!points && n.story_points) {
      points = Number(n.story_points);
      done = n.status === 'done' ? points : 0;
    }
    const out = { points, done, items, closed };
    rolled.set(id, out);
    return out;
  };
  const rows = await ctx.tx.query<Record<string, any>>(
    `select t.id, t.task_number, t.name, t.work_type, t.status, t.state, t.parent_id, t.epic_id, t.assignees, t.story_points::float8 as story_points, t.priority, t.sprint_id, t.backlog_rank, t.due_date::text as due_date,
            (select array_agg(u.full_name) from users u where u.tenant_id = t.tenant_id and u.id = any(t.assignees)) as assignee_names
       from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and ($3::boolean is not true or t.status not in ('done','cancelled') or t.work_type in ('epic','feature'))
      order by (t.work_type in ('epic','feature')) desc, (t.status in ('done','cancelled') and coalesce(t.completed_at, t.updated_at) < now() - interval '30 days'), t.backlog_rank, t.task_number limit ${SHOW + 1}`,
    [ctx.tenantId, projectId, q.open ?? false],
  );
  const truncated = rows.length > SHOW;
  if (truncated) rows.length = SHOW;
  const wfs = await projectWorkflows(ctx.tx, ctx.tenantId, projectId);
  const byId = new Map<string, any>(rows.map((r) => [r.id, { ...r, key: `${key}-${r.task_number}`, stateLabel: currentState(pickWorkflow(wfs, r.work_type), r.state, r.status).label, children: [] as any[] }]));
  const roots: any[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id) : n.epic_id ? byId.get(n.epic_id) : undefined;
    if (parent && parent !== n) parent.children.push(n);
    else roots.push(n);
  }
  for (const n of byId.values()) {
    const r = light.has(n.id) ? rollOf(n.id) : { points: 0, done: 0, items: 0, closed: 0 };
    Object.assign(n, { rollPoints: r.points, rollDone: r.done, rollItems: r.items, rollClosed: r.closed, hidden: Math.max(0, (kids.get(n.id)?.length ?? 0) - n.children.length) });
  }
  const sortKids = (n: any) => {
    n.children.sort((a: any, b: any) => a.backlog_rank - b.backlog_rank || a.task_number - b.task_number);
    n.children.forEach(sortKids);
  };
  roots.forEach(sortKids);
  const rank = (n: any) => LEVEL[n.work_type as WorkType] ?? 3;
  roots.sort((a, b) => rank(a) - rank(b) || a.backlog_rank - b.backlog_rank || a.task_number - b.task_number);
  return { roots, total: all.length, shown: rows.length, truncated };
}

/* ───────────────────────── reports ───────────────────────── */

/** Cumulative flow: how many items were in each status category at the end of each day. */
export async function cumulativeFlow(ctx: RecordCtx, projectId: string, days: number) {
  await projectAccess(ctx, projectId, 'view');
  const n = Math.min(Math.max(days, 7), 180);
  // Each item's status over time as segments [from, to); a segment counts on the days it spans,
  // added up with +1 / −1 at its ends — one pass over the history, however many days are shown.
  // right after a bulk import the table has no statistics yet and the planner guesses one row,
  // which turns the CTE joins into nested loops (minutes); hash joins are right at any size
  await ctx.tx.query(`set local enable_nestloop = off`);
  const rows = await ctx.tx.query<{ day: string; status: string; n: number }>(
    `with t as (select id, created_at, status from project_tasks where tenant_id = $1 and project_id = $2 and work_type <> 'epic'),
          h as (select h.task_id, h.at, h.old_value, h.new_value, h.field,
                       row_number() over (partition by h.task_id order by h.at, h.id) as rn,
                       lead(h.at) over (partition by h.task_id order by h.at, h.id) as next_at
                  from project_task_history h join t on t.id = h.task_id
                 where h.tenant_id = $1 and h.project_id = $2 and h.field in ('status', 'created')),
          firsts as (select task_id, min(at) as first_at, (array_agg(old_value order by at, rn) filter (where field = 'status'))[1] as first_old from h group by task_id),
          seg as (
            -- before the first recorded change: the status it had then (items older than the history: today's)
            select t.created_at as from_at, f.first_at as to_at, coalesce(f.first_old, t.status) as status from t left join firsts f on f.task_id = t.id
            union all
            select h.at, h.next_at, h.new_value from h),
          bounds as (select current_date - ($3::int - 1) as lo, current_date as hi),
          deltas as (
            select greatest(from_at::date, b.lo) as day, status, 1 as d from seg, bounds b where from_at::date <= b.hi and (to_at is null or to_at::date > from_at::date)
            union all
            select greatest(to_at::date, b.lo), status, -1 from seg, bounds b where to_at is not null and to_at::date > from_at::date and to_at::date <= b.hi),
          per_day as (select day, status, sum(d)::int as d from deltas group by day, status),
          grid as (select g::date as day, s.status from bounds b, generate_series(b.lo, b.hi, interval '1 day') g, (select distinct status from per_day) s)
     select g.day::text as day, g.status, (sum(coalesce(p.d, 0)) over (partition by g.status order by g.day))::int as n
       from grid g left join per_day p on p.day = g.day and p.status = g.status
      order by g.day`,
    [ctx.tenantId, projectId, n],
  );
  await ctx.tx.query(`set local enable_nestloop = on`);
  const dayList = (await ctx.tx.query<{ day: string }>(`select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date::text as day`, [n])).map((r) => r.day);
  const cats = ['done', 'review', 'in_progress', 'blocked', 'open'];
  return {
    days: dayList,
    series: cats.map((c) => ({ status: c, values: dayList.map((d) => rows.find((r) => r.day === d && r.status === c)?.n ?? 0) })),
  };
}

/** Cycle time (first start → done) and lead time (created → done) for items finished in the period. */
export async function cycleTime(ctx: RecordCtx, projectId: string, days: number) {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const rows = await ctx.tx.query<{ id: string; task_number: number; name: string; work_type: string; story_points: number | null; completed_at: Date; cycle: number | null; lead: number }>(
    `select id, task_number, name, work_type, story_points::float8 as story_points, completed_at,
            extract(epoch from (completed_at - started_at)) / 86400 as cycle, extract(epoch from (completed_at - created_at)) / 86400 as lead
       from project_tasks where tenant_id = $1 and project_id = $2 and status = 'done' and completed_at >= now() - make_interval(days => $3) and work_type <> 'epic'
      order by completed_at`,
    [ctx.tenantId, projectId, Math.min(Math.max(days, 7), 365)],
  );
  const pct = (xs: number[], p: number) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
  };
  const cyc = rows.map((r) => Number(r.cycle ?? r.lead));
  const lead = rows.map((r) => Number(r.lead));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  // throughput per week
  const weeks = new Map<string, number>();
  for (const r of rows) {
    const d = new Date(r.completed_at);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const k = d.toISOString().slice(0, 10);
    weeks.set(k, (weeks.get(k) ?? 0) + 1);
  }
  return {
    items: rows.map((r) => ({ id: r.id, key: `${key}-${r.task_number}`, name: r.name, workType: r.work_type, completedAt: r.completed_at, cycleDays: Math.round(Number(r.cycle ?? r.lead) * 10) / 10, leadDays: Math.round(Number(r.lead) * 10) / 10 })),
    cycle: { avg: avg(cyc), p50: pct(cyc, 50), p85: pct(cyc, 85) },
    lead: { avg: avg(lead), p50: pct(lead, 50), p85: pct(lead, 85) },
    throughput: [...weeks.entries()].map(([week, n]) => ({ week, n })),
  };
}

/** Items created vs resolved per day or week. */
export async function createdResolved(ctx: RecordCtx, projectId: string, days: number) {
  await projectAccess(ctx, projectId, 'view');
  const n = Math.min(Math.max(days, 7), 365);
  const unit = n > 60 ? 'week' : 'day';
  return ctx.tx.query(
    `with b as (select generate_series(date_trunc($4, now() - make_interval(days => $3)), date_trunc($4, now()), ('1 ' || $4)::interval) as s)
     select b.s::date::text as period,
            (select count(*)::int from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and date_trunc($4, t.created_at) = b.s) as created,
            (select count(*)::int from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and t.status = 'done' and date_trunc($4, t.completed_at) = b.s) as resolved
       from b order by b.s`,
    [ctx.tenantId, projectId, n, unit],
  );
}

/** Open work per person: items, points, hours remaining, overdue. */
export async function workload(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  return ctx.tx.query(
    `select coalesce(u.full_name, 'Unassigned') as person, a.uid as user_id, count(*)::int as items, coalesce(sum(t.story_points), 0)::float8 as points,
            coalesce(sum(coalesce(t.remaining_hours, t.estimate_hours)), 0)::float8 as hours, count(*) filter (where t.due_date < current_date)::int as overdue,
            count(*) filter (where t.status = 'in_progress')::int as in_progress
       from project_tasks t left join lateral unnest(case when cardinality(t.assignees) = 0 then array[null::uuid] else t.assignees end) a(uid) on true
       left join users u on u.tenant_id = t.tenant_id and u.id = a.uid
      where t.tenant_id = $1 and t.project_id = $2 and t.status not in ('done','cancelled') and t.work_type not in ('epic','feature')
      group by 1, 2 order by items desc`,
    [ctx.tenantId, projectId],
  );
}

/* ───────────────────────── dashboards ───────────────────────── */

export interface Widget {
  id: string;
  type: 'count' | 'breakdown' | 'list' | 'cfd' | 'cycle' | 'created_resolved' | 'workload' | 'velocity' | 'burndown' | 'sprint' | 'time_in_status' | 'release_burnup';
  sprintId?: string | null;
  releaseId?: string | null;
  title: string;
  query?: string | null;
  groupBy?: Parameters<typeof groupQuery>[3];
  days?: number;
  size?: 'small' | 'medium' | 'large';
}

export async function listDashboards(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const rows = await ctx.tx.query(`select id, name, widgets, shared, owner_id, (owner_id = $3) as mine from pm_dashboards where tenant_id = $1 and project_id = $2 and (shared or owner_id = $3) order by created_at`, [ctx.tenantId, projectId, ctx.principal.user.id]);
  return rows;
}

export const STARTER_WIDGETS: Widget[] = [
  { id: 'w1', type: 'count', title: 'Open items', query: 'status not in (done, cancelled)', size: 'small' },
  { id: 'w2', type: 'count', title: 'Open bugs', query: 'type = bug AND status not in (done, cancelled)', size: 'small' },
  { id: 'w3', type: 'count', title: 'Assigned to me', query: 'assignee = currentUser() AND status not in (done, cancelled)', size: 'small' },
  { id: 'w4', type: 'breakdown', title: 'Open work by person', query: 'status not in (done, cancelled)', groupBy: 'assignee', size: 'medium' },
  { id: 'w5', type: 'cfd', title: 'Cumulative flow', days: 30, size: 'large' },
  { id: 'w6', type: 'cycle', title: 'Cycle time', days: 60, size: 'medium' },
  { id: 'w7', type: 'created_resolved', title: 'Created vs resolved', days: 30, size: 'medium' },
];

export async function saveDashboard(ctx: RecordCtx, projectId: string, id: string | null, d: { name: string; widgets: Widget[]; shared: boolean }) {
  await projectAccess(ctx, projectId, 'view');
  const wctx = await wqlContext(ctx, [projectId]);
  for (const w of d.widgets) if (w.query) compileWql(w.query, wctx, [ctx.tenantId, [projectId]]);
  if (id) {
    const r = await ctx.tx.one(`update pm_dashboards set name = $4, widgets = $5, shared = $6, updated_at = now() where tenant_id = $1 and id = $2 and project_id = $3 and (owner_id = $7 or shared) returning id`, [
      ctx.tenantId, id, projectId, d.name, JSON.stringify(d.widgets), d.shared, ctx.principal.user.id,
    ]);
    if (!r) throw notFound('Dashboard not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_dashboards (tenant_id, project_id, name, widgets, shared) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, projectId, d.name, JSON.stringify(d.widgets), d.shared]);
  return { id: r!.id };
}

export async function deleteDashboard(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'view');
  const r = await ctx.tx.one(`delete from pm_dashboards where tenant_id = $1 and id = $2 and project_id = $3 and owner_id = $4 returning id`, [ctx.tenantId, id, projectId, ctx.principal.user.id]);
  if (!r) throw notFound('Only the owner deletes a dashboard');
  return { ok: true };
}

export async function widgetData(ctx: RecordCtx, projectId: string, w: Widget) {
  switch (w.type) {
    case 'count':
      return { total: (await runQuery(ctx, { projectId, query: w.query ?? '', limit: 1 })).total };
    case 'breakdown':
      return groupQuery(ctx, projectId, w.query ?? '', w.groupBy ?? 'status');
    case 'list':
      return runQuery(ctx, { projectId, query: w.query ?? '', limit: 10 });
    case 'cfd':
      return cumulativeFlow(ctx, projectId, w.days ?? 30);
    case 'cycle':
      return cycleTime(ctx, projectId, w.days ?? 60);
    case 'created_resolved':
      return { rows: await createdResolved(ctx, projectId, w.days ?? 30) };
    case 'workload':
      return { rows: await workload(ctx, projectId) };
    case 'sprint':
      return sprintReport(ctx, projectId, w.sprintId ?? null);
    case 'time_in_status':
      return timeInStatus(ctx, projectId, w.days ?? 60);
    case 'release_burnup':
      return releaseBurnup(ctx, projectId, w.releaseId ?? null);
    default:
      return {};
  }
}

/* ───────────────────────── my work (across projects) ───────────────────────── */

export async function myWork(ctx: RecordCtx) {
  return runQuery(ctx, { projectId: null, query: 'assignee = currentUser() AND status not in (done, cancelled) ORDER BY priority DESC, due ASC', limit: 300 });
}


/* ───────────────────────── workspace rule: every project has its repository ───────────────────────── */

export async function repoRule(ctx: RecordCtx) {
  const t = await ctx.tx.one<{ v: string | null }>(`select settings ->> 'requireRepo' as v from tenants where id = $1`, [ctx.tenantId]);
  return t?.v === 'true';
}

export async function setRepoRule(ctx: RecordCtx, on: boolean) {
  await ctx.tx.query(`update tenants set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('requireRepo', $2::boolean) where id = $1`, [ctx.tenantId, on]);
  return { requireRepo: on };
}

/** With the workspace rule on, work items are planned only in projects linked to code (or marked as having none). */
async function assertRepoRule(ctx: RecordCtx, project: Record<string, any>) {
  if ((project.work_settings ?? {}).noCode) return;
  if (!(await repoRule(ctx))) return;
  const has = await ctx.tx.one(`select 1 from project_repos where tenant_id = $1 and project_id = $2 limit 1`, [ctx.tenantId, project.id]);
  if (!has) throw badRequest(`Link ${project.name}'s code repository first (Work setup → Code repositories) — your workspace requires every project to have one. A project with no code can be marked so there.`);
}

/* ───────────────────────── live updates ───────────────────────── */

/** A cheap fingerprint of a project's work: changes when any item, comment or link changes. */
export async function workStamp(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const r = await ctx.tx.one<{ s: string }>(
    `select concat_ws(':',
        (select extract(epoch from max(updated_at))::text || '/' || count(*) from project_tasks where tenant_id = $1 and project_id = $2),
        (select extract(epoch from max(created_at))::text from project_comments where tenant_id = $1 and project_id = $2),
        (select extract(epoch from max(h.at))::text from project_task_history h where h.tenant_id = $1 and h.project_id = $2),
        (select extract(epoch from max(at))::text from pm_code_events where tenant_id = $1 and project_id = $2)) as s`,
    [ctx.tenantId, projectId],
  );
  return { stamp: r!.s };
}

/* ───────────────────────── attachments on work items ───────────────────────── */

export async function itemFiles(ctx: RecordCtx, env: import('../../env').Env, projectId: string, taskId: string) {
  await projectAccess(ctx, projectId, 'view');
  await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const rows = await ctx.tx.query<{ id: string; name: string; content_type: string; size_bytes: string; created_at: string; uploader: string | null }>(
    `select f.id, f.name, f.content_type, f.size_bytes, f.created_at, u.full_name as uploader from files f left join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
      where f.tenant_id = $1 and f.object_key = 'work_item' and f.record_id = $2 and f.deleted_at is null order by f.created_at`,
    [ctx.tenantId, taskId],
  );
  const { signedFileUrl } = await import('../files');
  const out = [];
  for (const r of rows) out.push({ id: r.id, name: r.name, type: r.content_type, size: Number(r.size_bytes), createdAt: r.created_at, uploader: r.uploader, url: await signedFileUrl(env, ctx.tenantId, r.id, true), downloadUrl: await signedFileUrl(env, ctx.tenantId, r.id, false) });
  return out;
}

export async function attachToItem(ctx: RecordCtx, env: import('../../env').Env, projectId: string, taskId: string, name: string, bytes: Uint8Array) {
  await projectAccess(ctx, projectId, 'member');
  await itemRow(ctx.tx, ctx.tenantId, projectId, taskId);
  const { saveFile } = await import('../files');
  const f = await saveFile(ctx, env, { objectKey: 'work_item', recordId: taskId, name, bytes, kind: 'attachment' }, { system: true });
  await ctx.tx.query(`insert into project_task_history (tenant_id, project_id, task_id, actor_id, field, new_value) values ($1,$2,$3,$4,'attachment',$5)`, [ctx.tenantId, projectId, taskId, ctx.principal.user.id, name.slice(0, 200)]);
  return { id: f.id, name: f.name ?? name };
}

export async function removeItemFile(ctx: RecordCtx, projectId: string, taskId: string, fileId: string) {
  await projectAccess(ctx, projectId, 'member');
  const f = await ctx.tx.one<{ name: string }>(`update files set deleted_at = now() where tenant_id = $1 and id = $2 and object_key = 'work_item' and record_id = $3 and deleted_at is null returning name`, [ctx.tenantId, fileId, taskId]);
  if (!f) throw notFound('Attachment not found');
  await ctx.tx.query(`insert into project_task_history (tenant_id, project_id, task_id, actor_id, field, old_value) values ($1,$2,$3,$4,'attachment',$5)`, [ctx.tenantId, projectId, taskId, ctx.principal.user.id, f.name]);
  return { ok: true };
}

/* ───────────────────────── more reports ───────────────────────── */

/** How long items spend in each state (from the history), for items active in the period. */
export async function timeInStatus(ctx: RecordCtx, projectId: string, days: number) {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const n = Math.min(Math.max(days, 7), 365);
  await ctx.tx.query(`set local enable_nestloop = off`);
  const rows = await ctx.tx.query<{ task_id: string; task_number: number; name: string; work_type: string; state: string; secs: number }>(
    `with changes as (
       select h.task_id, coalesce(h.new_value, 'open') as v, h.field, h.at,
              lead(h.at) over (partition by h.task_id order by h.at, h.id) as next_at
         from project_task_history h where h.tenant_id = $1 and h.project_id = $2 and h.field in ('created','status','state')),
     spans as (
       select c.task_id, c.v, c.field, greatest(c.at, now() - make_interval(days => $3)) as s, coalesce(c.next_at, now()) as e from changes c
        where coalesce(c.next_at, now()) > now() - make_interval(days => $3))
     select t.id as task_id, t.task_number, t.name, t.work_type, sp.v as state, sum(extract(epoch from (sp.e - sp.s)))::float8 as secs
       from spans sp join project_tasks t on t.tenant_id = $1 and t.id = sp.task_id
      where sp.e > sp.s and t.work_type <> 'epic'
      group by t.id, t.task_number, t.name, t.work_type, sp.v`,
    [ctx.tenantId, projectId, n],
  );
  await ctx.tx.query(`set local enable_nestloop = on`);
  // a "state" row of null / a status value: show the workflow label
  const wfs = await projectWorkflows(ctx.tx, ctx.tenantId, projectId);
  const labelOf = (v: string, type: string) => {
    const wf = pickWorkflow(wfs, type);
    return wf.states.find((s) => s.key === v)?.label ?? currentState(wf, null, ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled'].includes(v) ? v : 'open').label;
  };
  const per = new Map<string, { label: string; total: number; items: Set<string> }>();
  const items = new Map<string, { key: string; name: string; workType: string; states: Record<string, number> }>();
  for (const r of rows) {
    const l = labelOf(r.state, r.work_type);
    const g = per.get(l) ?? { label: l, total: 0, items: new Set<string>() };
    g.total += r.secs;
    g.items.add(r.task_id);
    per.set(l, g);
    const it = items.get(r.task_id) ?? { key: `${key}-${r.task_number}`, name: r.name, workType: r.work_type, states: {} };
    it.states[l] = Math.round(((it.states[l] ?? 0) + r.secs / 86400) * 10) / 10;
    items.set(r.task_id, it);
  }
  const states = [...per.values()].map((g) => ({ state: g.label, items: g.items.size, avgDays: Math.round((g.total / g.items.size / 86400) * 10) / 10, totalDays: Math.round((g.total / 86400) * 10) / 10 })).sort((a, b) => b.totalDays - a.totalDays);
  return { states, items: [...items.entries()].slice(0, 200).map(([id, v]) => ({ id, ...v })) };
}

/** Sprint report: committed at the start, added and removed during the sprint, completed or not. */
export async function sprintReport(ctx: RecordCtx, projectId: string, sprintId: string | null) {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const sprint = sprintId
    ? await ctx.tx.one<Record<string, any>>(`select * from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, sprintId, projectId])
    : ((await ctx.tx.one<Record<string, any>>(`select * from project_sprints where tenant_id = $1 and project_id = $2 and status = 'active'`, [ctx.tenantId, projectId])) ??
      (await ctx.tx.one<Record<string, any>>(`select * from project_sprints where tenant_id = $1 and project_id = $2 and status = 'closed' order by closed_at desc nulls last limit 1`, [ctx.tenantId, projectId])));
  const sprints = await ctx.tx.query(`select id, name, status from project_sprints where tenant_id = $1 and project_id = $2 order by start_date desc`, [ctx.tenantId, projectId]);
  if (!sprint) return { sprint: null, sprints, items: [], totals: null };
  const started = sprint.started_at ? new Date(sprint.started_at) : new Date(`${d10(sprint.start_date)}T00:00:00Z`);
  const ended = sprint.closed_at ? new Date(sprint.closed_at) : new Date();
  // every item that was in the sprint at some point
  const rows = await ctx.tx.query<{ id: string; task_number: number; name: string; work_type: string; status: string; sprint_id: string | null; story_points: number | null; completed_at: Date | null; created_at: Date }>(
    `select t.id, t.task_number, t.name, t.work_type, t.status, t.sprint_id, t.story_points::float8 as story_points, t.completed_at, t.created_at from project_tasks t
      where t.tenant_id = $1 and t.project_id = $2 and (t.sprint_id = $3 or exists (select 1 from project_task_history h where h.tenant_id = t.tenant_id and h.task_id = t.id and h.field = 'sprint_id' and (h.old_value = $3::text or h.new_value = $3::text)))`,
    [ctx.tenantId, projectId, sprint.id],
  );
  const hist = await ctx.tx.query<{ task_id: string; old_value: string | null; new_value: string | null; at: Date }>(
    `select task_id, old_value, new_value, at from project_task_history where tenant_id = $1 and project_id = $2 and field = 'sprint_id' and (old_value = $3::text or new_value = $3::text) order by at`,
    [ctx.tenantId, projectId, sprint.id],
  );
  const items = rows.map((r) => {
    const h = hist.filter((x) => x.task_id === r.id);
    // in the sprint at its start: the last sprint change before the start put it in (or it was created into it before the start)
    const before = h.filter((x) => new Date(x.at) <= started).pop();
    const inAtStart = before ? before.new_value === sprint.id : h.length ? h[0]!.old_value === sprint.id : r.sprint_id === sprint.id && new Date(r.created_at) <= started;
    const added = !inAtStart && h.some((x) => x.new_value === sprint.id && new Date(x.at) > started && new Date(x.at) <= ended);
    const inAtEnd = sprint.status === 'closed' ? (h.filter((x) => new Date(x.at) <= ended).pop()?.new_value ?? r.sprint_id) === sprint.id : r.sprint_id === sprint.id;
    const done = r.status === 'done' && r.completed_at !== null && new Date(r.completed_at) <= ended && (inAtEnd || h.some((x) => x.old_value === sprint.id && new Date(x.at) >= new Date(r.completed_at!)));
    return { id: r.id, key: `${key}-${r.task_number}`, name: r.name, workType: r.work_type, points: r.story_points, committed: inAtStart, added, removed: !inAtEnd && !done, done };
  });
  const pts = (f: (i: (typeof items)[number]) => boolean) => Math.round(items.filter(f).reduce((a, i) => a + Number(i.points ?? 0), 0) * 10) / 10;
  return {
    sprint: { id: sprint.id, name: sprint.name, status: sprint.status, goal: sprint.goal, start: d10(sprint.start_date), end: d10(sprint.end_date) },
    sprints,
    items,
    totals: {
      committed: pts((i) => i.committed), added: pts((i) => i.added), removed: pts((i) => i.removed), completed: pts((i) => i.done), notCompleted: pts((i) => !i.done && !i.removed),
      committedItems: items.filter((i) => i.committed).length, completedItems: items.filter((i) => i.done).length,
    },
  };
}

/** Release burn-up: scope (points in the release) against points done, day by day. */
export async function releaseBurnup(ctx: RecordCtx, projectId: string, releaseId: string | null) {
  await projectAccess(ctx, projectId, 'view');
  const releases = await ctx.tx.query<{ id: string; name: string; status: string; release_date: string | null }>(`select id, name, status, coalesce(released_at, target_date)::text as release_date from project_releases where tenant_id = $1 and project_id = $2 order by coalesce(released_at, target_date, '2999-01-01') desc`, [ctx.tenantId, projectId]);
  const rel = releaseId ? releases.find((r) => r.id === releaseId) : releases.find((r) => r.status !== 'released') ?? releases[0];
  if (!rel) return { release: null, releases, days: [], scope: [], done: [] };
  const items = await ctx.tx.query<{ id: string; points: number; created_at: Date; release_id: string | null }>(
    `select t.id, coalesce(t.story_points, 1)::float8 as points, t.created_at, t.release_id from project_tasks t
      where t.tenant_id = $1 and t.project_id = $2 and t.work_type not in ('epic','feature') and (t.release_id = $3 or exists (select 1 from project_task_history h where h.tenant_id = t.tenant_id and h.task_id = t.id and h.field = 'release_id' and (h.old_value = $3::text or h.new_value = $3::text)))`,
    [ctx.tenantId, projectId, rel.id],
  );
  if (!items.length) return { release: rel, releases, days: [], scope: [], done: [] };
  const hist = await ctx.tx.query<{ task_id: string; field: string; old_value: string | null; new_value: string | null; at: Date }>(
    `select task_id, field, old_value, new_value, at from project_task_history where tenant_id = $1 and task_id = any($2::uuid[]) and field in ('release_id','status','created') order by at`,
    [ctx.tenantId, items.map((i) => i.id)],
  );
  let firstMs = Infinity;
  for (const i of items) firstMs = Math.min(firstMs, new Date(i.created_at).getTime());
  for (const h of hist) if (h.field === 'release_id' && h.new_value === rel.id) firstMs = Math.min(firstMs, new Date(h.at).getTime());
  const first = new Date(firstMs);
  const last = rel.release_date && new Date(rel.release_date) > new Date() ? new Date(rel.release_date) : new Date();
  const days: string[] = [];
  for (let d = new Date(first.toISOString().slice(0, 10)); d <= last && days.length < 366; d = new Date(d.getTime() + 86_400_000)) days.push(d.toISOString().slice(0, 10));
  const today = new Date().toISOString().slice(0, 10);
  const ends = days.filter((d) => d <= today).map((d) => Date.parse(`${d}T23:59:59Z`));
  const sc = new Array<number>(ends.length).fill(0);
  const dn = new Array<number>(ends.length).fill(0);
  const byTask = new Map<string, typeof hist>();
  for (const x of hist) (byTask.get(x.task_id) ?? byTask.set(x.task_id, []).get(x.task_id)!).push(x);
  // one pass per item over its own (time-ordered) history, day by day
  for (const it of items) {
    const h = byTask.get(it.id) ?? [];
    const relEv = h.filter((x) => x.field === 'release_id');
    const stEv = h.filter((x) => x.field === 'status' || x.field === 'created');
    const startIn = relEv.length ? relEv[0]!.old_value === rel.id : it.release_id === rel.id;
    const created = new Date(it.created_at).getTime();
    let ri = 0;
    let si = 0;
    let inRel = startIn;
    let st: string | null = null;
    for (let k = 0; k < ends.length; k++) {
      const end = ends[k]!;
      while (ri < relEv.length && new Date(relEv[ri]!.at).getTime() <= end) inRel = relEv[ri++]!.new_value === rel.id;
      while (si < stEv.length && new Date(stEv[si]!.at).getTime() <= end) st = stEv[si++]!.new_value;
      if (!(ri > 0 ? inRel : created <= end && startIn)) continue;
      sc[k]! += it.points;
      if (st === 'done') dn[k]! += it.points;
    }
  }
  const scope = sc.map((x) => Math.round(x * 10) / 10);
  const done = dn.map((x) => Math.round(x * 10) / 10);
  return { release: rel, releases, days, scope, done };
}

/* ───────────────────────── portfolio roadmap ───────────────────────── */

/** Epics and features across the projects the person can see, with dates (own, else from their children) and progress. */
export async function roadmap(ctx: RecordCtx, q: { projectIds?: string[] | null }) {
  let ids = await visibleProjectIds(ctx);
  if (q.projectIds?.length) ids = ids.filter((i) => q.projectIds!.includes(i));
  const rows = await ctx.tx.query<Record<string, any>>(
    `select t.id, t.project_id, p.name as project_name, p.work_key, t.task_number, t.name, t.work_type, t.status, t.state, t.parent_id, t.epic_id, t.priority,
            t.start_date::text as own_start, t.due_date::text as own_due,
            (select min(coalesce(c.start_date, c.created_at::date))::text from project_tasks c where c.tenant_id = t.tenant_id and (c.parent_id = t.id or c.epic_id = t.id)) as kid_start,
            (select max(coalesce(c.due_date, s.end_date))::text from project_tasks c left join project_sprints s on s.tenant_id = c.tenant_id and s.id = c.sprint_id where c.tenant_id = t.tenant_id and (c.parent_id = t.id or c.epic_id = t.id)) as kid_due,
            (select count(*)::int from project_tasks c where c.tenant_id = t.tenant_id and (c.parent_id = t.id or c.epic_id = t.id) and c.work_type not in ('epic','feature')) as total,
            (select count(*)::int from project_tasks c where c.tenant_id = t.tenant_id and (c.parent_id = t.id or c.epic_id = t.id) and c.work_type not in ('epic','feature') and c.status in ('done','cancelled')) as closed,
            (select string_agg(u.full_name, ', ') from users u where u.tenant_id = t.tenant_id and u.id = any(t.assignees)) as owner
       from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
      where t.tenant_id = $1 and t.project_id = any($2::uuid[]) and t.work_type in ('epic','feature') and p.deleted_at is null and t.status <> 'cancelled'
      order by p.name, t.work_type, t.backlog_rank, t.task_number limit 1000`,
    [ctx.tenantId, ids],
  );
  return {
    items: rows.map((r) => ({
      id: r.id, projectId: r.project_id, projectName: r.project_name, key: `${r.work_key ?? 'X'}-${r.task_number}`, name: r.name, workType: r.work_type, status: r.status, priority: r.priority, owner: r.owner,
      parentId: r.parent_id ?? (r.work_type === 'feature' ? r.epic_id : null), start: r.own_start ?? r.kid_start, due: r.own_due ?? r.kid_due, datesOwn: !!(r.own_start || r.own_due), total: r.total, closed: r.closed,
    })),
  };
}
