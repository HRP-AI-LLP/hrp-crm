/**
 * Agile delivery inside a project: a ranked backlog of stories, bugs and epics with story points; sprints
 * (plan → start → close, carrying unfinished work over); burndown and velocity; releases with release
 * notes written from the work done; pull requests, commits and branches linked to tasks.
 *
 * Access follows the project (services/projects.ts): members plan and move work, managers run sprints
 * and releases.
 */
import { badRequest, conflict, notFound } from '../../lib/errors';
import { d10, r2 } from '../books/ledger';
import { projectAccess } from '../projects';
import type { RecordCtx } from '../records';

const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

import { checkParent, refreshEpics, type WorkType } from '../work-types';
export type { WorkType };

/* ───────────── board data ───────────── */

/** Sprints, releases, epics and the backlog of a project. */
export async function agileBoard(ctx: RecordCtx, projectId: string) {
  const { level } = await projectAccess(ctx, projectId);
  const sprints = await ctx.tx.query(
    `select s.id, s.name, s.goal, s.start_date::text, s.end_date::text, s.status, s.capacity_points::float8 as capacity_points,
            s.committed_points::float8 as committed_points, s.completed_points::float8 as completed_points, s.started_at, s.closed_at,
            coalesce(sum(t.story_points), 0)::float8 as points, coalesce(sum(t.story_points) filter (where t.status = 'done'), 0)::float8 as done_points,
            count(t.id)::int as items, count(t.id) filter (where t.status = 'done')::int as done_items
       from project_sprints s left join project_tasks t on t.tenant_id = s.tenant_id and t.sprint_id = s.id and t.work_type <> 'epic'
      where s.tenant_id = $1 and s.project_id = $2
      group by s.id order by case s.status when 'active' then 0 when 'planned' then 1 else 2 end, s.start_date`,
    [ctx.tenantId, projectId],
  );
  const releases = await ctx.tx.query(
    `select r.id, r.name, r.version, r.target_date::text, r.status, r.released_at::text, r.notes,
            count(t.id)::int as items, count(t.id) filter (where t.status = 'done')::int as done_items,
            coalesce(sum(t.story_points), 0)::float8 as points
       from project_releases r left join project_tasks t on t.tenant_id = r.tenant_id and t.release_id = r.id
      where r.tenant_id = $1 and r.project_id = $2 group by r.id order by coalesce(r.target_date, '2100-01-01'), r.created_at`,
    [ctx.tenantId, projectId],
  );
  const epics = await ctx.tx.query(
    `select e.id, e.task_number, e.name, e.status,
            count(c.id)::int as items, count(c.id) filter (where c.status = 'done')::int as done_items,
            coalesce(sum(c.story_points), 0)::float8 as points, coalesce(sum(c.story_points) filter (where c.status = 'done'), 0)::float8 as done_points
       from project_tasks e left join project_tasks c on c.tenant_id = e.tenant_id and c.epic_id = e.id
      where e.tenant_id = $1 and e.project_id = $2 and e.work_type = 'epic' group by e.id order by e.task_number`,
    [ctx.tenantId, projectId],
  );
  const items = await ctx.tx.query(
    `select t.id, t.task_number, t.name, t.status, t.priority, t.assignees, t.work_type, t.story_points::float8 as story_points, t.sprint_id, t.release_id, t.epic_id,
            t.backlog_rank, t.due_date::text, t.parent_id,
            (select count(*)::int from project_task_links l where l.tenant_id = t.tenant_id and l.task_id = t.id) as links
       from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and t.work_type <> 'epic' and t.parent_id is null
      order by t.backlog_rank, t.task_number limit 3000`,
    [ctx.tenantId, projectId],
  );
  return { level, sprints, releases, epics, items };
}

/* ───────────── planning a work item ───────────── */

export interface AgileInput {
  workType?: WorkType;
  storyPoints?: number | null;
  sprintId?: string | null;
  releaseId?: string | null;
  epicId?: string | null;
  backlogRank?: number;
}

export async function setAgile(ctx: RecordCtx, projectId: string, taskId: string, input: AgileInput) {
  await projectAccess(ctx, projectId, 'member');
  const t = await ctx.tx.one<{ id: string; work_type: string; sprint_id: string | null; parent_id: string | null }>(`select id, work_type, sprint_id, parent_id from project_tasks where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, taskId, projectId]);
  if (!t) throw notFound('Task not found');
  if (input.workType && input.workType !== t.work_type && t.parent_id) await checkParent(ctx.tx, ctx.tenantId, projectId, input.workType, t.parent_id, taskId);
  if (input.sprintId) {
    const s = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.sprintId, projectId]);
    if (!s) throw badRequest('Sprint not found');
    if (s.status === 'closed') throw badRequest('That sprint is closed');
  }
  if (input.releaseId && !(await ctx.tx.one(`select 1 from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.releaseId, projectId]))) throw badRequest('Release not found');
  if (input.epicId) {
    if (input.epicId === taskId) throw badRequest('An item cannot be its own epic');
    const e = await ctx.tx.one<{ work_type: string }>(`select work_type from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.epicId, projectId]);
    if (!e || e.work_type !== 'epic') throw badRequest('Choose an epic of this project');
  }
  const type = input.workType ?? t.work_type;
  if (type === 'epic' && (input.sprintId || input.epicId)) throw badRequest('An epic groups stories; plan its stories into sprints instead');
  if (type === 'epic' && t.work_type !== 'epic') {
    // an epic is not itself planned into a sprint
    await ctx.tx.query(`update project_tasks set sprint_id = null, epic_id = null where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]);
  }
  if (type !== 'epic' && t.work_type === 'epic') await ctx.tx.query(`update project_tasks set epic_id = null where tenant_id = $1 and epic_id = $2`, [ctx.tenantId, taskId]);
  await ctx.tx.query(
    `update project_tasks set work_type = $3,
            story_points = case when $4::boolean then $5::numeric else story_points end,
            sprint_id = case when $6::boolean then $7::uuid else sprint_id end,
            release_id = case when $8::boolean then $9::uuid else release_id end,
            epic_id = case when $10::boolean then $11::uuid else epic_id end,
            backlog_rank = coalesce($12, backlog_rank), updated_at = now()
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, taskId, type, input.storyPoints !== undefined, input.storyPoints ?? null, input.sprintId !== undefined, input.sprintId ?? null,
      input.releaseId !== undefined, input.releaseId ?? null, input.epicId !== undefined, input.epicId ?? null, input.backlogRank ?? null,
    ],
  );
  if (input.workType !== undefined || input.epicId !== undefined) await refreshEpics(ctx.tx, ctx.tenantId, taskId);
  // sub-tasks follow their story into the sprint
  if (input.sprintId !== undefined) await ctx.tx.query(`update project_tasks set sprint_id = $3 where tenant_id = $1 and parent_id = $2`, [ctx.tenantId, taskId, input.sprintId ?? null]);
}

/** Orders the backlog as given (top first). */
export async function rankBacklog(ctx: RecordCtx, projectId: string, ids: string[]) {
  await projectAccess(ctx, projectId, 'member');
  for (const [i, id] of ids.entries())
    await ctx.tx.query(`update project_tasks set backlog_rank = $4 where tenant_id = $1 and project_id = $2 and id = $3`, [ctx.tenantId, projectId, id, (i + 1) * 10]);
}

/* ───────────── sprints ───────────── */

export interface SprintInput {
  name: string;
  goal?: string | null;
  startDate: string;
  endDate: string;
  capacityPoints?: number | null;
}

export async function saveSprint(ctx: RecordCtx, projectId: string, id: string | null, input: SprintInput) {
  await projectAccess(ctx, projectId, 'manage');
  if (input.endDate < input.startDate) throw badRequest('The sprint ends before it starts');
  if (id) {
    const s = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
    if (!s) throw notFound('Sprint not found');
    if (s.status === 'closed') throw badRequest('A closed sprint cannot change');
    await ctx.tx.query(`update project_sprints set name = $4, goal = $5, start_date = $6, end_date = $7, capacity_points = $8 where tenant_id = $1 and id = $2 and project_id = $3`, [
      ctx.tenantId, id, projectId, input.name, input.goal ?? null, input.startDate, input.endDate, input.capacityPoints ?? null,
    ]);
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into project_sprints (tenant_id, project_id, name, goal, start_date, end_date, capacity_points) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [ctx.tenantId, projectId, input.name, input.goal ?? null, input.startDate, input.endDate, input.capacityPoints ?? null],
  );
  return { id: r!.id };
}

/** The next sprint after the last one: same length, starting the day after. */
export async function nextSprintDraft(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId);
  const last = await ctx.tx.one<{ name: string; start_date: string; end_date: string }>(
    `select name, start_date::text, end_date::text from project_sprints where tenant_id = $1 and project_id = $2 order by end_date desc limit 1`,
    [ctx.tenantId, projectId],
  );
  const n = (await ctx.tx.one<{ n: number }>(`select count(*)::int as n from project_sprints where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]))!.n + 1;
  if (!last) return { name: `Sprint ${n}`, startDate: today(), endDate: addDays(today(), 13) };
  const len = Math.round((Date.parse(last.end_date) - Date.parse(last.start_date)) / 86_400_000);
  const start = addDays(last.end_date, 1);
  return { name: `Sprint ${n}`, startDate: start, endDate: addDays(start, len) };
}

export async function deleteSprint(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const s = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!s) throw notFound('Sprint not found');
  if (s.status !== 'planned') throw badRequest('Only a sprint that has not started can be deleted');
  await ctx.tx.query(`delete from project_sprints where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

export async function startSprint(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const s = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, id, projectId]);
  if (!s) throw notFound('Sprint not found');
  if (s.status !== 'planned') throw badRequest('Only a planned sprint can start');
  if (await ctx.tx.one(`select 1 from project_sprints where tenant_id = $1 and project_id = $2 and status = 'active'`, [ctx.tenantId, projectId])) throw conflict('Close the running sprint first');
  const pts = await ctx.tx.one<{ p: number; n: number }>(
    `select coalesce(sum(story_points), 0)::float8 as p, count(*)::int as n from project_tasks where tenant_id = $1 and sprint_id = $2 and parent_id is null and work_type <> 'epic'`,
    [ctx.tenantId, id],
  );
  if (!pts!.n) throw badRequest('Plan some work into the sprint first');
  await ctx.tx.query(`update project_sprints set status = 'active', committed_points = $3, started_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, pts!.p]);
  return { committedPoints: pts!.p };
}

/** Closes the running sprint; unfinished work goes back to the backlog or into the given sprint. */
export async function closeSprint(ctx: RecordCtx, projectId: string, id: string, moveTo: string | null) {
  await projectAccess(ctx, projectId, 'manage');
  const s = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, id, projectId]);
  if (!s) throw notFound('Sprint not found');
  if (s.status !== 'active') throw badRequest('Only the running sprint can be closed');
  if (moveTo) {
    const n = await ctx.tx.one<{ status: string }>(`select status from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, moveTo, projectId]);
    if (!n || n.status !== 'planned' || moveTo === id) throw badRequest('Move unfinished work to a planned sprint');
  }
  const done = await ctx.tx.one<{ p: number; n: number }>(
    `select coalesce(sum(story_points) filter (where status = 'done'), 0)::float8 as p, count(*) filter (where status not in ('done','cancelled'))::int as n
       from project_tasks where tenant_id = $1 and sprint_id = $2 and parent_id is null and work_type <> 'epic'`,
    [ctx.tenantId, id],
  );
  const moved = await ctx.tx.query<{ id: string }>(`update project_tasks set sprint_id = $3 where tenant_id = $1 and sprint_id = $2 and status not in ('done','cancelled') returning id`, [ctx.tenantId, id, moveTo]);
  await ctx.tx.query(`update project_sprints set status = 'closed', completed_points = $3, closed_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, done!.p]);
  return { completedPoints: done!.p, carriedOver: moved.filter(Boolean).length };
}

/** Points left each day of a sprint, against the ideal straight line. */
export async function burndown(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId);
  const s = await ctx.tx.one<{ start_date: string; end_date: string; status: string; committed_points: number | null }>(
    `select start_date::text, end_date::text, status, committed_points::float8 as committed_points from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`,
    [ctx.tenantId, id, projectId],
  );
  if (!s) throw notFound('Sprint not found');
  const tasks = await ctx.tx.query<{ points: number; done_on: string | null }>(
    `select coalesce(story_points, 0)::float8 as points, case when status = 'done' and completed_at is not null then to_char(completed_at + interval '5 hours 30 minutes', 'YYYY-MM-DD') end as done_on
       from project_tasks where tenant_id = $1 and sprint_id = $2 and parent_id is null and work_type <> 'epic'`,
    [ctx.tenantId, id],
  );
  const total = r2(tasks.reduce((a, t) => a + t.points, 0));
  const scope = Math.max(total, s.committed_points ?? 0);
  const days: string[] = [];
  for (let d = s.start_date; d <= s.end_date && days.length < 120; d = addDays(d, 1)) days.push(d);
  const now = today();
  const span = Math.max(1, days.length - 1);
  return {
    total: scope,
    days: days.map((d, i) => ({
      date: d,
      ideal: r2(scope - (scope * i) / span),
      remaining: d > now ? null : r2(scope - tasks.filter((t) => t.done_on && t.done_on <= d).reduce((a, t) => a + t.points, 0)),
    })),
  };
}

/** Points committed and completed in the last closed sprints, with the average. */
export async function velocity(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId);
  const rows = await ctx.tx.query<{ name: string; committed: number; completed: number; end_date: string }>(
    `select name, coalesce(committed_points, 0)::float8 as committed, coalesce(completed_points, 0)::float8 as completed, end_date::text
       from project_sprints where tenant_id = $1 and project_id = $2 and status = 'closed' order by end_date desc limit 10`,
    [ctx.tenantId, projectId],
  );
  const last = rows.slice(0, 3);
  return { sprints: rows.reverse(), average: last.length ? r2(last.reduce((a, r) => a + r.completed, 0) / last.length) : 0 };
}

/* ───────────── releases ───────────── */

export interface ReleaseInput {
  name: string;
  version?: string | null;
  targetDate?: string | null;
  status?: 'planned' | 'in_progress' | 'released' | 'cancelled';
  notes?: string | null;
}

export async function saveRelease(ctx: RecordCtx, projectId: string, id: string | null, input: ReleaseInput) {
  await projectAccess(ctx, projectId, 'manage');
  if (input.status === 'released') throw badRequest('Use “Mark released” to release a version');
  if (id) {
    const r = await ctx.tx.one(`update project_releases set name = $4, version = $5, target_date = $6, status = coalesce($7, status), notes = coalesce($8, notes) where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [
      ctx.tenantId, id, projectId, input.name, input.version ?? null, input.targetDate ?? null, input.status ?? null, input.notes ?? null,
    ]);
    if (!r) throw notFound('Release not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into project_releases (tenant_id, project_id, name, version, target_date, status, notes) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [
    ctx.tenantId, projectId, input.name, input.version ?? null, input.targetDate ?? null, input.status ?? 'planned', input.notes ?? null,
  ]);
  return { id: r!.id };
}

export async function deleteRelease(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await ctx.tx.one<{ status: string }>(`select status from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!r) throw notFound('Release not found');
  if (r.status === 'released') throw badRequest('A released version is kept');
  await ctx.tx.query(`delete from project_releases where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

const SECTIONS: [string, WorkType[]][] = [
  ['New', ['story']],
  ['Fixed', ['bug']],
  ['Improved', ['task', 'chore', 'spike']],
];

/** Release notes written from the finished work in the release (Markdown). */
export async function draftReleaseNotes(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId);
  const r = await ctx.tx.one<{ name: string; version: string | null }>(`select name, version from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!r) throw notFound('Release not found');
  const items = await ctx.tx.query<{ task_number: number; name: string; work_type: WorkType }>(
    `select task_number, name, work_type from project_tasks where tenant_id = $1 and release_id = $2 and status = 'done' and work_type <> 'epic' order by work_type, task_number`,
    [ctx.tenantId, id],
  );
  const out = [`# ${r.name}${r.version ? ` (${r.version})` : ''}`, ''];
  for (const [title, types] of SECTIONS) {
    const xs = items.filter((i) => types.includes(i.work_type));
    if (!xs.length) continue;
    out.push(`## ${title}`, ...xs.map((x) => `- ${x.name} (#${x.task_number})`), '');
  }
  if (!items.length) out.push('_No finished work is in this release yet._');
  return { notes: out.join('\n').trim(), items: items.length };
}

/** Marks a version released (today, or the given date); unfinished work in it moves to the next release or out. */
export async function markReleased(ctx: RecordCtx, projectId: string, id: string, input: { date?: string | null; notes?: string | null }) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await ctx.tx.one<{ status: string; notes: string | null }>(`select status, notes from project_releases where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, id, projectId]);
  if (!r) throw notFound('Release not found');
  if (r.status === 'released') throw badRequest('Already released');
  const notes = input.notes ?? r.notes ?? (await draftReleaseNotes(ctx, projectId, id)).notes;
  const open = await ctx.tx.query<{ id: string }>(`update project_tasks set release_id = null where tenant_id = $1 and release_id = $2 and status not in ('done','cancelled') returning id`, [ctx.tenantId, id]);
  await ctx.tx.query(`update project_releases set status = 'released', released_at = $3, notes = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, input.date ?? today(), notes]);
  // roadmap items shipped in it are released too
  await ctx.tx.query(`update pm_items set status = 'released', updated_at = now() where tenant_id = $1 and release_id = $2 and status <> 'declined'`, [ctx.tenantId, id]);
  return { movedOut: open.length };
}

/* ───────────── code and document links ───────────── */

export function linkKind(url: string): 'pr' | 'commit' | 'branch' | 'doc' | 'design' | 'other' {
  if (/\/(pull|pulls|merge_requests|pullrequest)\/\d+/i.test(url)) return 'pr';
  if (/\/commits?\/[0-9a-f]{7,40}/i.test(url)) return 'commit';
  if (/\/(tree|branch|branches|src)\/[^/]+/i.test(url) && /github|gitlab|bitbucket|dev\.azure/i.test(url)) return 'branch';
  if (/figma\.com/i.test(url)) return 'design';
  if (/docs\.google|notion\.so|confluence|sharepoint|\.pdf($|\?)/i.test(url)) return 'doc';
  return 'other';
}

export async function listLinks(ctx: RecordCtx, projectId: string, taskId: string) {
  await projectAccess(ctx, projectId);
  return ctx.tx.query(
    `select l.id, l.kind, l.url, l.title, l.status, l.created_at from project_task_links l join project_tasks t on t.tenant_id = l.tenant_id and t.id = l.task_id
      where l.tenant_id = $1 and l.task_id = $2 and t.project_id = $3 order by l.created_at`,
    [ctx.tenantId, taskId, projectId],
  );
}

export async function addLink(ctx: RecordCtx, projectId: string, taskId: string, input: { url: string; title?: string | null; kind?: string | null; status?: string | null }) {
  await projectAccess(ctx, projectId, 'member');
  if (!(await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, taskId, projectId]))) throw notFound('Task not found');
  const kind = input.kind ?? linkKind(input.url);
  const title = input.title ?? (() => {
    const m = /github\.com\/[^/]+\/([^/]+)\/(pull|commit)\/(\w+)/i.exec(input.url) ?? /gitlab\.com\/.+\/([^/]+)\/-\/(merge_requests|commit)\/(\w+)/i.exec(input.url);
    return m ? `${m[1]} ${m[2] === 'commit' ? m[3]!.slice(0, 7) : `#${m[3]}`}` : null;
  })();
  const r = await ctx.tx.one<{ id: string }>(`insert into project_task_links (tenant_id, task_id, kind, url, title, status) values ($1,$2,$3,$4,$5,$6) returning id`, [
    ctx.tenantId, taskId, kind, input.url, title, input.status ?? (kind === 'pr' ? 'open' : null),
  ]);
  return { id: r!.id, kind, title };
}

export async function updateLink(ctx: RecordCtx, projectId: string, linkId: string, status: 'open' | 'merged' | 'closed' | 'draft') {
  await projectAccess(ctx, projectId, 'member');
  const r = await ctx.tx.one(
    `update project_task_links l set status = $4 from project_tasks t where l.tenant_id = $1 and l.id = $2 and t.tenant_id = l.tenant_id and t.id = l.task_id and t.project_id = $3 returning l.id`,
    [ctx.tenantId, linkId, projectId, status],
  );
  if (!r) throw notFound('Link not found');
}

export async function deleteLink(ctx: RecordCtx, projectId: string, linkId: string) {
  await projectAccess(ctx, projectId, 'member');
  await ctx.tx.query(`delete from project_task_links l using project_tasks t where l.tenant_id = $1 and l.id = $2 and t.tenant_id = l.tenant_id and t.id = l.task_id and t.project_id = $3`, [ctx.tenantId, linkId, projectId]);
}
