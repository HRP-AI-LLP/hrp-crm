/**
 * Coding agents (Claude Code, Codex) working the project's backlog over MCP, with a person in the loop.
 *
 *   SanchalanOS                                   the developer's machine
 *   ───────────                                   ──────────────────────
 *   story / task / bug created or changed  ─→  queued job
 *                                               next_work (claims it; the project is cloned if new)
 *                                               implement on a branch, run the tests
 *   comments + timeline on the item        ←─  report_progress
 *   "Review" on the item: summary, tests,  ←─  request_review
 *    how to verify  →  Approve / Changes   ─→  review_status
 *                                               commit, push (PR), release
 *   item done, links to commit / PR        ←─  complete
 *
 * Every agent call runs as the API key's person, with their project access; changes the agent makes
 * are marked (app.agent) so they never queue the item again.
 */
import { z } from 'zod';
import type { Tx } from '../lib/db';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { comment, createItem, getItem } from './it/work';
import { notify, projectAccess, updateTask } from './projects';
import type { RecordCtx } from './records';

const OPEN = ['queued', 'claimed', 'working', 'testing', 'awaiting_review', 'approved', 'changes_requested', 'committed', 'pushed'];

/* ───────────────────────── settings (people) ───────────────────────── */

export const settingsSchema = z.object({
  enabled: z.boolean(),
  workTypes: z.array(z.enum(['story', 'task', 'bug', 'subtask', 'spike', 'improvement', 'epic', 'feature'])).min(1).max(10),
  onCreate: z.boolean(),
  onUpdate: z.boolean(),
  autoPush: z.boolean(),
  localFolder: z.string().trim().max(300).nullish(),
  instructions: z.string().max(8000).nullish(),
  releaseCommand: z.string().trim().max(500).nullish(),
  /** 'one': an item at a time, reviewed before the next; 'batch': everything queued at once, then one review round */
  workMode: z.enum(['one', 'batch']).optional(),
  batchSize: z.number().int().min(1).max(50).optional(),
});

export async function getSettings(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const s = await ctx.tx.one<Record<string, any>>(`select * from coding_agent_settings where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]);
  return {
    enabled: s?.enabled ?? false,
    workTypes: (s?.work_types as string[] | undefined) ?? ['story', 'task', 'bug'],
    onCreate: s?.on_create ?? true,
    onUpdate: s?.on_update ?? true,
    autoPush: s?.auto_push ?? false,
    localFolder: s?.local_folder ?? null,
    instructions: s?.instructions ?? null,
    releaseCommand: s?.release_command ?? null,
    workMode: (s?.work_mode as 'one' | 'batch' | undefined) ?? 'one',
    batchSize: Number(s?.batch_size ?? 20),
  };
}

export async function saveSettings(ctx: RecordCtx, projectId: string, s: z.infer<typeof settingsSchema>) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(
    `insert into coding_agent_settings (tenant_id, project_id, enabled, work_types, on_create, on_update, auto_push, local_folder, instructions, release_command, work_mode, batch_size, updated_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11, 'one'),coalesce($12, 20),now())
     on conflict (tenant_id, project_id) do update set enabled = excluded.enabled, work_types = excluded.work_types, on_create = excluded.on_create, on_update = excluded.on_update,
       auto_push = excluded.auto_push, local_folder = excluded.local_folder, instructions = excluded.instructions, release_command = excluded.release_command,
       work_mode = coalesce($11, coding_agent_settings.work_mode), batch_size = coalesce($12, coding_agent_settings.batch_size), updated_by = app.current_user_id(), updated_at = now()`,
    [ctx.tenantId, projectId, s.enabled, s.workTypes, s.onCreate, s.onUpdate, s.autoPush, s.localFolder || null, s.instructions || null, s.releaseCommand || null, s.workMode ?? null, s.batchSize ?? null],
  );
  return getSettings(ctx, projectId);
}

async function event(tx: Tx, tenantId: string, jobId: string, actor: 'agent' | 'person' | 'system', stage: string, message: string | null, data: Record<string, unknown> = {}) {
  await tx.query(`insert into coding_agent_events (tenant_id, job_id, actor, stage, message, data) values ($1,$2,$3,$4,$5,$6)`, [tenantId, jobId, actor, stage, message?.slice(0, 20000) ?? null, JSON.stringify(data)]);
}

/** "Send to the coding agent" on an item, by hand (also when automatic queueing is off). */
export async function queueItem(ctx: RecordCtx, projectId: string, taskId: string, note?: string | null) {
  await projectAccess(ctx, projectId, 'member');
  const t = await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, taskId, projectId]);
  if (!t) throw notFound('Item not found');
  const j = await ctx.tx.one<{ id: string }>(
    `insert into coding_agent_jobs (tenant_id, project_id, task_id, reason, requested_by) values ($1,$2,$3,'requested',$4)
     on conflict (tenant_id, task_id) where status not in ('released','failed','cancelled') do update set revision = coding_agent_jobs.revision + 1, updated_at = now()
     returning id`,
    [ctx.tenantId, projectId, taskId, ctx.principal.user.id],
  );
  await event(ctx.tx, ctx.tenantId, j!.id, 'person', 'queued', note ?? `Sent to the coding agent by ${ctx.principal.user.fullName}`);
  return { jobId: j!.id };
}

/* ───────────────────────── a key for the project's repository ───────────────────────── */

/**
 * A key for one project's repository, acting as the person who makes it: it works only for the
 * coding agent (MCP) and only on this project, whatever else that person may do.
 */
export async function createProjectKey(ctx: RecordCtx, projectId: string, tenantSlug: string, name: string) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  const { randomToken, sha256Hex } = await import('../lib/crypto');
  const key = `syn_${tenantSlug}_${randomToken(32)}`;
  const row = await ctx.tx.one<{ id: string }>(
    `insert into api_keys (tenant_id, name, prefix, key_hash, user_id, scopes, rate_limit_per_min, project_id) values ($1,$2,$3,$4,$5,'{read,write}',600,$6) returning id`,
    [ctx.tenantId, name.slice(0, 80), `${key.slice(0, 12 + tenantSlug.length)}…`, await sha256Hex(key), ctx.principal.user.id, projectId],
  );
  return { id: row!.id, key, project: { id: projectId, key: project.work_key ?? null, name: project.name } };
}

/** The project's repository keys: the person's own, or all of them for its managers. */
export async function projectKeys(ctx: RecordCtx, projectId: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  return ctx.tx.query(
    `select k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, u.full_name as user_name from api_keys k join users u on u.tenant_id = k.tenant_id and u.id = k.user_id
      where k.tenant_id = $1 and k.project_id = $2 and ($3::boolean or k.user_id = $4) order by k.revoked_at nulls first, k.created_at desc`,
    [ctx.tenantId, projectId, level === 'manage', ctx.principal.user.id],
  );
}

export async function revokeProjectKey(ctx: RecordCtx, projectId: string, keyId: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const r = await ctx.tx.one(
    `update api_keys set revoked_at = now() where tenant_id = $1 and id = $2 and project_id = $3 and revoked_at is null and ($4::boolean or user_id = $5) returning id`,
    [ctx.tenantId, keyId, projectId, level === 'manage', ctx.principal.user.id],
  );
  if (!r) throw notFound('Key not found');
  return { ok: true };
}

export const queueOpenSchema = z.object({
  workTypes: z.array(z.enum(['story', 'task', 'bug', 'subtask', 'spike', 'improvement', 'epic', 'feature'])).min(1).max(10).optional(),
  /** only these items (keys like FLEET-12), else every open one of the types */
  keys: z.array(z.string().trim().max(40)).max(200).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

/**
 * Everything still open on the board (not done or cancelled) of the given types — the project's
 * agent types by default — queued for the agent; items it already has stay as they are. Bugs first,
 * then by priority and age.
 */
export async function queueOpen(ctx: RecordCtx, projectRef: string, input: z.infer<typeof queueOpenSchema>) {
  if (!projectRef && pinOf(ctx)) projectRef = pinOf(ctx)!.id;
  const p = (await projectsFor(ctx)).find((x) => x.id === projectRef || (x.work_key && x.work_key.toLowerCase() === projectRef.toLowerCase()) || x.name.toLowerCase() === projectRef.toLowerCase());
  if (!p) throw notFound('No such project (or no access)');
  await projectAccess(ctx, p.id, 'member');
  const types = input.workTypes ?? (await getSettings(ctx, p.id)).workTypes;
  const nums = (input.keys ?? []).map((k) => Number(k.replace(/^.*-/, ''))).filter((n) => Number.isInteger(n) && n > 0);
  const items = await ctx.tx.query<{ id: string; task_number: number; name: string; work_type: string }>(
    `select t.id, t.task_number, t.name, t.work_type from project_tasks t
      where t.tenant_id = $1 and t.project_id = $2 and t.status not in ('done','cancelled') and t.work_type = any($3::text[])
        and (cardinality($4::int[]) = 0 or t.task_number = any($4::int[])) and ($5::text is null or t.priority = $5)
        and not exists (select 1 from coding_agent_jobs j where j.tenant_id = t.tenant_id and j.task_id = t.id and j.status not in ('released','failed','cancelled'))
      order by (t.work_type = 'bug') desc, case t.priority when 'urgent' then 0 when 'high' then 1 when 'medium' then 2 else 3 end, t.created_at
      limit $6`,
    [ctx.tenantId, p.id, types, input.keys?.length ? nums : [], input.priority ?? null, input.limit],
  );
  for (const it of items) await queueItem(ctx, p.id, it.id, `Sent with the board's open items by ${ctx.principal.user.fullName}`);
  return { project: p.work_key ?? p.name, queued: items.length, items: items.map((i) => ({ key: p.work_key ? `${p.work_key}-${i.task_number}` : `#${i.task_number}`, type: i.work_type, title: i.name })) };
}

const JOB_COLS = `j.id, j.project_id, j.task_id, j.status, j.reason, j.revision, j.seen_revision, j.agent, j.claimed_at, j.heartbeat_at, j.branch, j.commit_sha, j.pr_url, j.summary, j.test_report, j.how_to_verify,
  j.review_note, j.reviewed_at, j.created_at, j.updated_at, t.task_number, t.name, t.work_type, t.status as item_status, p.work_key, p.name as project,
  (select full_name from users u where u.tenant_id = j.tenant_id and u.id = j.reviewed_by) as reviewer`;

export async function listJobs(ctx: RecordCtx, projectId: string, opts: { open?: boolean } = {}) {
  await projectAccess(ctx, projectId, 'view');
  return ctx.tx.query(
    `select ${JOB_COLS} from coding_agent_jobs j join project_tasks t on t.tenant_id = j.tenant_id and t.id = j.task_id join projects p on p.tenant_id = j.tenant_id and p.id = j.project_id
      where j.tenant_id = $1 and j.project_id = $2 ${opts.open ? `and j.status = any($3::text[])` : ''} order by (j.status = 'awaiting_review') desc, j.updated_at desc limit 200`,
    opts.open ? [ctx.tenantId, projectId, OPEN] : [ctx.tenantId, projectId],
  );
}

export async function jobDetail(ctx: RecordCtx, jobId: string) {
  const j = await ctx.tx.one<Record<string, any>>(
    `select ${JOB_COLS} from coding_agent_jobs j join project_tasks t on t.tenant_id = j.tenant_id and t.id = j.task_id join projects p on p.tenant_id = j.tenant_id and p.id = j.project_id where j.tenant_id = $1 and j.id = $2`,
    [ctx.tenantId, jobId],
  );
  if (!j) throw notFound('Job not found');
  await projectAccess(ctx, j.project_id, 'view');
  const events = await ctx.tx.query(`select id, at, actor, stage, message, data from coding_agent_events where tenant_id = $1 and job_id = $2 order by at, id`, [ctx.tenantId, jobId]);
  return { job: { ...j, key: j.work_key ? `${j.work_key}-${j.task_number}` : `#${j.task_number}` }, events };
}

/** A person's verdict on the agent's work: approve (commit & push), ask for changes, or stop it. */
export const reviewSchema = z.object({ verdict: z.enum(['approve', 'changes', 'cancel']), note: z.string().max(8000).nullish() });
export async function review(ctx: RecordCtx, jobId: string, input: z.infer<typeof reviewSchema>) {
  const j = await ctx.tx.one<{ project_id: string; task_id: string; status: string; agent: string | null }>(`select project_id, task_id, status, agent from coding_agent_jobs where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, jobId]);
  if (!j) throw notFound('Job not found');
  await projectAccess(ctx, j.project_id, 'manage');
  if (input.verdict === 'cancel') {
    if (!OPEN.includes(j.status)) throw conflict('This job is already finished');
    await ctx.tx.query(`update coding_agent_jobs set status = 'cancelled', review_note = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, jobId, input.note ?? null, ctx.principal.user.id]);
    await event(ctx.tx, ctx.tenantId, jobId, 'person', 'cancelled', input.note ?? `Stopped by ${ctx.principal.user.fullName}`);
    return { status: 'cancelled' };
  }
  if (j.status !== 'awaiting_review') throw conflict('The agent has not asked for review yet');
  if (input.verdict === 'changes' && !input.note?.trim()) throw badRequest('Say what to change');
  const status = input.verdict === 'approve' ? 'approved' : 'changes_requested';
  await ctx.tx.query(
    `update coding_agent_jobs set status = $3, review_note = $4, reviewed_by = $5, reviewed_at = now(), reason = case when $3 = 'changes_requested' then 'changes_requested' else reason end, updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, jobId, status, input.note ?? null, ctx.principal.user.id],
  );
  await event(ctx.tx, ctx.tenantId, jobId, 'person', status, input.note ?? (status === 'approved' ? `Approved by ${ctx.principal.user.fullName}: commit and push` : null));
  await comment(ctx, j.project_id, j.task_id, `🤖 Coding agent: ${status === 'approved' ? 'approved — committing and pushing' : `changes requested — ${input.note}`}`).catch(() => undefined);
  return { status };
}

/* ───────────────────────── the agent's side (MCP tools) ───────────────────────── */

/** Marks the transaction as the agent's: its edits never queue the item again. */
export async function asAgent(tx: Tx) {
  await tx.query(`select set_config('app.agent', '1', true)`);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/**
 * A coding agent's session can be tied to one project — by its key (made for one project's
 * repository) or by the repository's MCP settings (X-Sanchalan-Project): it then sees, claims,
 * reads and changes that project's items only.
 */
export type AgentCtx = RecordCtx & { agentProject?: { id: string; name: string } | null };
function pinOf(ctx: RecordCtx) {
  return (ctx as AgentCtx).agentProject ?? null;
}
function inPin(ctx: RecordCtx, projectId: string) {
  const pin = pinOf(ctx);
  if (pin && pin.id !== projectId) throw forbidden(`This repository is linked to the project “${pin.name}” only`);
}
export { inPin as assertAgentProject };

/** The project named by the repository's settings (id, key or name), for this person. */
export async function resolveAgentProject(ctx: RecordCtx, ref: string) {
  const r = ref.trim();
  const p = (await projectsFor({ ...ctx, agentProject: null } as AgentCtx)).find((x) => x.id === r || (x.work_key && x.work_key.toLowerCase() === r.toLowerCase()) || x.name.toLowerCase() === r.toLowerCase());
  if (!p) throw notFound(`The project “${r}” in this repository's SanchalanOS settings was not found, or you are not on it`);
  return { id: p.id as string, name: p.name as string };
}

async function projectsFor(ctx: RecordCtx) {
  const rows = await ctx.tx.query<Record<string, any>>(
    `select p.id, p.name, p.work_key, p.status, p.ai_rules, s.enabled, s.local_folder, s.instructions, s.release_command, s.auto_push, s.work_types, s.work_mode, s.batch_size,
            coalesce((select json_agg(json_build_object('provider', r.provider, 'repo', r.repo, 'defaultBranch', r.default_branch)) from project_repos r where r.tenant_id = p.tenant_id and r.project_id = p.id), '[]') as repos,
            (select count(*)::int from coding_agent_jobs j where j.tenant_id = p.tenant_id and j.project_id = p.id and j.status in ('queued','changes_requested')) as waiting
       from projects p left join coding_agent_settings s on s.tenant_id = p.tenant_id and s.project_id = p.id
      where p.tenant_id = $1 and p.deleted_at is null and p.status in ('active','planning') order by coalesce(s.enabled, false) desc, p.name limit 200`,
    [ctx.tenantId],
  );
  const out = [];
  const pin = pinOf(ctx);
  for (const r of rows) {
    if (pin && r.id !== pin.id) continue;
    try {
      await projectAccess(ctx, r.id, 'view');
      out.push(r);
    } catch {
      /* not theirs */
    }
  }
  return out;
}

function setupOf(p: Record<string, any>) {
  const repos = (p.repos as { provider: string; repo: string; defaultBranch: string }[]).map((r) => ({
    ...r,
    cloneUrl: r.provider === 'github' ? `https://github.com/${r.repo}.git` : `https://dev.azure.com/${r.repo.split('/')[0]}/_git/${r.repo.split('/').slice(1).join('/')}`,
    folder: r.repo.split('/').pop(),
  }));
  return {
    project: { id: p.id, name: p.name, key: p.work_key },
    localFolder: p.local_folder || (repos[0] ? repos[0].folder : slug(p.work_key || p.name)),
    repos,
    instructions: p.instructions ?? null,
    /** the project's rules: follow every one */
    rules: p.ai_rules ?? null,
    releaseCommand: p.release_command ?? null,
    autoPush: !!p.auto_push,
    workMode: p.work_mode ?? 'one',
    steps: repos.length
      ? [`If the folder does not exist: git clone ${repos[0]!.cloneUrl} ${p.local_folder || repos[0]!.folder}`, `git fetch && git checkout ${repos[0]!.defaultBranch} && git pull`]
      : [`If the folder does not exist: create it, git init, and scaffold the project from the epic / story descriptions (no repository is linked in SanchalanOS yet — link one under Project → Repos)`],
  };
}

export async function agentProjects(ctx: RecordCtx) {
  return (await projectsFor(ctx)).map((p) => ({ ...setupOf(p), enabled: !!p.enabled, waiting: p.waiting }));
}

export async function projectSetup(ctx: RecordCtx, projectRef: string) {
  const pin = pinOf(ctx);
  if (!projectRef && pin) projectRef = pin.id;
  if (!projectRef) throw badRequest('Name the project (id, key or name)');
  const p = (await projectsFor(ctx)).find((x) => x.id === projectRef || (x.work_key && x.work_key.toLowerCase() === projectRef.toLowerCase()) || x.name.toLowerCase() === projectRef.toLowerCase());
  if (!p) throw notFound('No such project (or no access)');
  return setupOf(p);
}

async function itemBrief(ctx: RecordCtx, projectId: string, taskId: string) {
  const it = (await getItem(ctx, projectId, taskId)) as Record<string, any>;
  const t = it.item as Record<string, any>;
  return {
    key: t.key,
    type: t.workType,
    title: t.name,
    description: t.description ?? '',
    status: t.status,
    state: t.stateLabel,
    priority: t.priority,
    severity: t.severity ?? null,
    storyPoints: t.storyPoints,
    acceptanceCriteria: t.custom?.acceptance_criteria ?? t.custom?.acceptanceCriteria ?? null,
    custom: t.custom ?? {},
    tags: t.tags ?? [],
    parent: it.parent ? { key: it.parent.key, title: it.parent.name, type: it.parent.work_type } : null,
    epic: it.epic ? { key: it.epic.key, title: it.epic.name } : null,
    children: (it.children ?? []).slice(0, 50).map((c: any) => ({ key: c.key, title: c.name, type: c.work_type, status: c.status })),
    relations: (it.relations ?? []).map((r: any) => ({ label: r.label, key: r.item.key, title: r.item.name, status: r.item.status })),
    comments: (it.comments ?? []).slice(-20).map((c: any) => ({ by: c.full_name, at: c.created_at, body: c.body })),
    links: (it.links ?? []).slice(0, 20).map((l: any) => ({ kind: l.kind, url: l.url, title: l.title })),
    tests: (it.tests ?? []).map((c: any) => ({ case: c.case_number, title: c.title, last: c.last_result })),
  };
}

async function jobFor(ctx: RecordCtx, jobId: string, lock = false) {
  const j = await ctx.tx.one<Record<string, any>>(`select * from coding_agent_jobs where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`, [ctx.tenantId, jobId]);
  if (!j) throw notFound('No such job');
  inPin(ctx, j.project_id);
  await projectAccess(ctx, j.project_id, 'member');
  return j;
}

/** The next job for this agent (oldest first; asked-for changes before new work), claimed. Null when none. */
/**
 * Everything queued at once (requested changes first), up to the project's batch size: the agent
 * implements them all, asks for review of each, then waits for one review round.
 */
export async function claimBatch(ctx: RecordCtx, agent: string, project?: string | null, limit?: number | null) {
  await asAgent(ctx.tx);
  const projects = (await projectsFor(ctx)).filter((p) => p.enabled || project);
  const chosen = projects.filter((p) => !project || p.id === project || p.work_key?.toLowerCase() === project.toLowerCase() || p.name.toLowerCase() === project.toLowerCase());
  if (!chosen.length) return { jobs: [] };
  await ctx.tx.query(`update coding_agent_jobs set status = 'queued', agent = null where tenant_id = $1 and status in ('claimed','working','testing') and heartbeat_at < now() - interval '30 minutes'`, [ctx.tenantId]);
  // one project per batch (one repository, one branch)
  const first = await ctx.tx.one<{ project_id: string }>(
    `select project_id from coding_agent_jobs where tenant_id = $1 and project_id = any($2::uuid[]) and status in ('queued','changes_requested') order by (status = 'changes_requested') desc, created_at limit 1`,
    [ctx.tenantId, chosen.map((p) => p.id)],
  );
  if (!first) return { jobs: [] };
  const p = chosen.find((x) => x.id === first.project_id)!;
  const n = Math.max(1, Math.min(50, limit ?? Number(p.batch_size ?? 20)));
  const rows = await ctx.tx.query<Record<string, any>>(
    `select * from coding_agent_jobs where tenant_id = $1 and project_id = $2 and status in ('queued','changes_requested')
      order by (status = 'changes_requested') desc, created_at for update skip locked limit $3`,
    [ctx.tenantId, p.id, n],
  );
  const jobs = [];
  for (const j of rows) {
    await ctx.tx.query(`update coding_agent_jobs set status = 'claimed', agent = $3, claimed_at = now(), heartbeat_at = now(), seen_revision = revision, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, j.id, agent.slice(0, 120)]);
    await event(ctx.tx, ctx.tenantId, j.id, 'agent', 'claimed', `${agent} picked it up with ${rows.length - 1} other item${rows.length === 2 ? '' : 's'}${j.reason === 'changes_requested' ? ', to make the requested changes' : ''}`);
    await updateTask(ctx, j.project_id, j.task_id, { status: 'in_progress' }).catch(() => undefined);
    jobs.push({ jobId: j.id, reason: j.reason, revision: j.revision, reviewNote: j.status === 'changes_requested' ? j.review_note : null, branch: j.branch ?? null, item: await itemBrief(ctx, j.project_id, j.task_id) });
  }
  return {
    jobs,
    setup: setupOf(p),
    next: `Work them all, then one review round: set up the folder if needed; implement every item (one branch for the batch, e.g. agent/batch-${new Date().toISOString().slice(0, 10)}, or a branch per item); run the tests; call report_progress per jobId as you go; call request_review for each jobId with what changed for that item. Then wait with review_status_all until none is awaiting_review: commit and push the approved ones (complete each), redo the changes_requested ones (their notes say what) and ask for review again. Do not commit or push before an item is approved (unless setup.autoPush).`,
  };
}

/** The verdicts on every item of this agent's batch (or all open jobs of a project). */
export async function reviewStatusAll(ctx: RecordCtx, project?: string | null) {
  const projects = await projectsFor(ctx);
  const ids = projects.filter((p) => !project || p.id === project || p.work_key?.toLowerCase() === project.toLowerCase() || p.name.toLowerCase() === project.toLowerCase()).map((p) => p.id);
  if (!ids.length) return { jobs: [], awaiting: 0 };
  const rows = await ctx.tx.query<Record<string, any>>(
    `select j.id, j.status, j.review_note, j.reviewed_at, j.branch, t.task_number, t.name, p.work_key from coding_agent_jobs j join project_tasks t on t.tenant_id = j.tenant_id and t.id = j.task_id join projects p on p.tenant_id = j.tenant_id and p.id = j.project_id
      where j.tenant_id = $1 and j.project_id = any($2::uuid[]) and j.status in ('claimed','working','testing','awaiting_review','approved','changes_requested','committed') order by j.created_at limit 100`,
    [ctx.tenantId, ids],
  );
  await ctx.tx.query(`update coding_agent_jobs set heartbeat_at = now() where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, rows.map((r) => r.id)]);
  return {
    jobs: rows.map((r) => ({ jobId: r.id, key: r.work_key ? `${r.work_key}-${r.task_number}` : `#${r.task_number}`, title: r.name, status: r.status, note: r.review_note ?? null, branch: r.branch ?? null })),
    awaiting: rows.filter((r) => r.status === 'awaiting_review').length,
  };
}

/** Approves every item waiting for review in a project at once. */
export async function approveAll(ctx: RecordCtx, projectId: string, note?: string | null) {
  await projectAccess(ctx, projectId, 'manage');
  const rows = await ctx.tx.query<{ id: string }>(`select id from coding_agent_jobs where tenant_id = $1 and project_id = $2 and status = 'awaiting_review' order by created_at`, [ctx.tenantId, projectId]);
  for (const r of rows) await review(ctx, r.id, { verdict: 'approve', note: note ?? null });
  return { approved: rows.length };
}

export async function claimNext(ctx: RecordCtx, agent: string, project?: string | null) {
  await asAgent(ctx.tx);
  const projects = (await projectsFor(ctx)).filter((p) => p.enabled || project);
  const ids = projects.filter((p) => !project || p.id === project || p.work_key?.toLowerCase() === project.toLowerCase() || p.name.toLowerCase() === project.toLowerCase()).map((p) => p.id);
  if (!ids.length) return null;
  // a job whose agent went quiet for 30 minutes goes back to the queue
  await ctx.tx.query(`update coding_agent_jobs set status = 'queued', agent = null where tenant_id = $1 and status in ('claimed','working','testing') and heartbeat_at < now() - interval '30 minutes'`, [ctx.tenantId]);
  const j = await ctx.tx.one<Record<string, any>>(
    `select * from coding_agent_jobs where tenant_id = $1 and project_id = any($2::uuid[]) and status in ('queued','changes_requested')
      order by (status = 'changes_requested') desc, created_at for update skip locked limit 1`,
    [ctx.tenantId, ids],
  );
  if (!j) return null;
  await ctx.tx.query(`update coding_agent_jobs set status = 'claimed', agent = $3, claimed_at = now(), heartbeat_at = now(), seen_revision = revision, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, j.id, agent.slice(0, 120)]);
  await event(ctx.tx, ctx.tenantId, j.id, 'agent', 'claimed', `${agent} picked it up${j.reason === 'changes_requested' ? ' to make the requested changes' : ''}`);
  await updateTask(ctx, j.project_id, j.task_id, { status: 'in_progress' }).catch(() => undefined);
  const p = projects.find((x) => x.id === j.project_id)!;
  return {
    jobId: j.id,
    reason: j.reason,
    revision: j.revision,
    reviewNote: j.status === 'changes_requested' ? j.review_note : null,
    branch: j.branch ?? null,
    item: await itemBrief(ctx, j.project_id, j.task_id),
    setup: setupOf(p),
    next: 'Set up the project folder if needed, create or reuse the branch, implement, run the tests, call report_progress as you go, then request_review. Do not commit or push before review_status says approved (unless setup.autoPush).',
  };
}

export const progressSchema = z.object({
  jobId: z.string().uuid(),
  stage: z.enum(['working', 'testing', 'tests_passed', 'tests_failed', 'note']),
  message: z.string().min(1).max(8000),
  branch: z.string().max(200).nullish(),
});
export async function reportProgress(ctx: RecordCtx, input: z.infer<typeof progressSchema>) {
  await asAgent(ctx.tx);
  const j = await jobFor(ctx, input.jobId, true);
  if (!OPEN.includes(j.status)) throw conflict(`This job is ${j.status}`);
  const status = input.stage === 'working' ? 'working' : input.stage.startsWith('test') ? 'testing' : j.status === 'claimed' ? 'working' : j.status;
  await ctx.tx.query(`update coding_agent_jobs set status = $3, heartbeat_at = now(), branch = coalesce($4, branch), updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, j.id, status, input.branch ?? null]);
  await event(ctx.tx, ctx.tenantId, j.id, 'agent', input.stage, input.message, input.branch ? { branch: input.branch } : {});
  // the item changed while the agent was on it: say so
  const fresh = await ctx.tx.one<{ revision: number; seen_revision: number }>(`select revision, seen_revision from coding_agent_jobs where tenant_id = $1 and id = $2`, [ctx.tenantId, j.id]);
  return { ok: true, itemChanged: (fresh?.revision ?? 0) > (fresh?.seen_revision ?? 0) ? 'The item was edited since you started: call get_work_item and include the change.' : null };
}

export const reviewRequestSchema = z.object({
  jobId: z.string().uuid(),
  summary: z.string().min(1).max(20000),
  branch: z.string().min(1).max(200),
  testReport: z.string().max(40000).nullish(),
  howToVerify: z.string().max(8000).nullish(),
  changedFiles: z.array(z.string().max(300)).max(500).nullish(),
});
export async function requestReview(ctx: RecordCtx, input: z.infer<typeof reviewRequestSchema>) {
  await asAgent(ctx.tx);
  const j = await jobFor(ctx, input.jobId, true);
  if (!OPEN.includes(j.status) || ['approved', 'committed', 'pushed'].includes(j.status)) throw conflict(`This job is ${j.status}`);
  const s = await ctx.tx.one<{ auto_push: boolean }>(`select auto_push from coding_agent_settings where tenant_id = $1 and project_id = $2`, [ctx.tenantId, j.project_id]);
  const status = s?.auto_push ? 'approved' : 'awaiting_review';
  await ctx.tx.query(
    `update coding_agent_jobs set status = $3, summary = $4, branch = $5, test_report = $6, how_to_verify = $7, heartbeat_at = now(), seen_revision = revision, updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, j.id, status, input.summary, input.branch, input.testReport ?? null, input.howToVerify ?? null],
  );
  await event(ctx.tx, ctx.tenantId, j.id, 'agent', 'review_requested', input.summary, { branch: input.branch, changedFiles: input.changedFiles ?? [] });
  await updateTask(ctx, j.project_id, j.task_id, { status: 'review' }).catch(() => undefined);
  await comment(ctx, j.project_id, j.task_id, `🤖 Coding agent: ready for review on branch \`${input.branch}\`.\n\n${input.summary.slice(0, 3000)}${input.howToVerify ? `\n\n**How to verify**\n${input.howToVerify.slice(0, 2000)}` : ''}`).catch(() => undefined);
  const p = await ctx.tx.one<{ owner_id: string | null; name: string }>(`select owner_id, name from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, j.project_id]);
  const t = await ctx.tx.one<{ created_by: string | null; reporter_id: string | null; name: string }>(`select created_by, reporter_id, name from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, j.task_id]);
  await notify(ctx, [p?.owner_id, t?.reporter_id, t?.created_by].filter((x): x is string => !!x), `Review the coding agent's work: ${t?.name ?? ''}`, `/projects/${j.project_id}?s_project=agent&job=${j.id}`).catch(() => undefined);
  return { status, next: status === 'approved' ? 'Auto-push is on for this project: commit, push and call complete.' : 'Wait for a person: call review_status (it waits up to 25 s per call) until approved or changes_requested.' };
}

export async function reviewStatus(ctx: RecordCtx, jobId: string) {
  const j = await jobFor(ctx, jobId);
  await ctx.tx.query(`update coding_agent_jobs set heartbeat_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, jobId]);
  return { status: j.status, note: j.review_note ?? null, reviewedAt: j.reviewed_at ?? null };
}

export const completeSchema = z.object({
  jobId: z.string().uuid(),
  stage: z.enum(['committed', 'pushed', 'released']),
  message: z.string().max(8000).nullish(),
  commitSha: z.string().max(64).nullish(),
  prUrl: z.string().url().max(500).nullish(),
  branch: z.string().max(200).nullish(),
});
export async function complete(ctx: RecordCtx, input: z.infer<typeof completeSchema>) {
  await asAgent(ctx.tx);
  const j = await jobFor(ctx, input.jobId, true);
  const s = await ctx.tx.one<{ auto_push: boolean }>(`select auto_push from coding_agent_settings where tenant_id = $1 and project_id = $2`, [ctx.tenantId, j.project_id]);
  if (!['approved', 'committed', 'pushed'].includes(j.status) && !s?.auto_push) throw forbidden('Not approved yet: a person must approve the work before it is committed and pushed');
  await ctx.tx.query(
    `update coding_agent_jobs set status = $3, commit_sha = coalesce($4, commit_sha), pr_url = coalesce($5, pr_url), branch = coalesce($6, branch), heartbeat_at = now(), updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, j.id, input.stage, input.commitSha ?? null, input.prUrl ?? null, input.branch ?? null],
  );
  await event(ctx.tx, ctx.tenantId, j.id, 'agent', input.stage, input.message ?? null, { commit: input.commitSha ?? null, pr: input.prUrl ?? null });
  // the pull request on the item (a commit shows in the comment and the job)
  if (input.prUrl && !(await ctx.tx.one(`select 1 from project_task_links where tenant_id = $1 and task_id = $2 and url = $3`, [ctx.tenantId, j.task_id, input.prUrl])))
    await ctx.tx.query(`insert into project_task_links (tenant_id, task_id, kind, url, title, status) values ($1,$2,'pr',$3,$4,$5)`, [
      ctx.tenantId,
      j.task_id,
      input.prUrl,
      `Pull request by the coding agent (${input.branch ?? j.branch ?? ''})`.slice(0, 300),
      input.stage === 'released' ? 'merged' : 'open',
    ]);
  if (input.stage === 'released') await updateTask(ctx, j.project_id, j.task_id, { status: 'done' }).catch(() => undefined);
  await comment(ctx, j.project_id, j.task_id, `🤖 Coding agent: ${input.stage}${input.commitSha ? ` ${input.commitSha.slice(0, 10)}` : ''}${input.prUrl ? ` — ${input.prUrl}` : ''}${input.message ? `\n\n${input.message.slice(0, 2000)}` : ''}`).catch(() => undefined);
  return { ok: true, status: input.stage };
}

export async function fail(ctx: RecordCtx, jobId: string, message: string) {
  await asAgent(ctx.tx);
  const j = await jobFor(ctx, jobId, true);
  await ctx.tx.query(`update coding_agent_jobs set status = 'failed', updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, j.id]);
  await event(ctx.tx, ctx.tenantId, j.id, 'agent', 'failed', message);
  await comment(ctx, j.project_id, j.task_id, `🤖 Coding agent could not finish: ${message.slice(0, 3000)}`).catch(() => undefined);
  return { ok: true };
}

/** An item by its key (FLEET-12), as the agent sees it. */
export async function itemByKey(ctx: RecordCtx, key: string) {
  const m = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})$/.exec(key.trim());
  if (!m) throw badRequest('Give the item key, e.g. FLEET-12');
  const t = await ctx.tx.one<{ id: string; project_id: string }>(
    `select t.id, t.project_id from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and upper(p.work_key) = $2 and t.task_number = $3`,
    [ctx.tenantId, m[1]!.toUpperCase(), Number(m[2])],
  );
  if (!t) throw notFound('No such item');
  inPin(ctx, t.project_id);
  return { projectId: t.project_id, taskId: t.id, item: await itemBrief(ctx, t.project_id, t.id) };
}

export async function agentComment(ctx: RecordCtx, key: string, body: string) {
  await asAgent(ctx.tx);
  const { projectId, taskId } = await itemByKey(ctx, key);
  return comment(ctx, projectId, taskId, `🤖 ${body}`);
}

export const newItemSchema = z.object({
  project: z.string().min(1).max(100),
  type: z.enum(['story', 'task', 'bug', 'subtask', 'spike', 'improvement']),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).nullish(),
  parentKey: z.string().max(20).nullish(),
});
export async function agentCreateItem(ctx: RecordCtx, input: z.infer<typeof newItemSchema>) {
  await asAgent(ctx.tx);
  const setup = await projectSetup(ctx, input.project);
  const parent = input.parentKey ? (await itemByKey(ctx, input.parentKey)).taskId : null;
  return createItem(ctx, setup.project.id, { name: input.title, description: input.description ?? null, workType: input.type as never, parentId: parent }, { skipRequired: true });
}
