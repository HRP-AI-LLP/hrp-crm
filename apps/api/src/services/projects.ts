/**
 * Projects and timesheets.
 *
 * Access to a project's insides (tasks, issues, time) follows from the project:
 *   manage  — projects admins, anyone who can edit the project record, and members with the manager role
 *   member  — project members: work on tasks and issues, log their own time
 *   view    — anyone who can read the project record, and viewer members
 * Time is approved by someone who manages the project, never by the person who logged it.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import type { Tx } from '../lib/db';
import { saveInvoiceLines } from './billing';
import { d10, r2 } from './books/ledger';
import { checkParent, refreshEpics, stateForStatus, type WorkType } from './work-types';
import { createRecord, loadRow, Params, type RecordCtx, type RecordEvent, toDto, visibilityWhere } from './records';

export type Level = 'manage' | 'member' | 'view';
const RANK: Record<Level, number> = { view: 1, member: 2, manage: 3 };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/* ───────────────────────── access ───────────────────────── */

export async function projectAccess(ctx: RecordCtx, projectId: string, need: Level = 'view') {
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw notFound('Project not found');
  const p = await ctx.tx.one<Record<string, any>>(`select * from projects where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, projectId]);
  if (!p) throw notFound('Project not found');
  let level: Level | null = null;
  if (hasAdmin(ctx.principal.permissions, 'projects')) level = 'manage';
  if (!level) {
    const m = await ctx.tx.one<{ role: string }>(`select role from project_members where tenant_id = $1 and project_id = $2 and user_id = $3`, [ctx.tenantId, projectId, ctx.principal.user.id]);
    if (m) level = m.role === 'manager' ? 'manage' : m.role === 'member' ? 'member' : 'view';
  }
  // the owner manages; so do people who may edit every project
  const perm = objectPerm(ctx.principal.permissions, 'project');
  if (level !== 'manage' && (p.owner_id === ctx.principal.user.id || perm.update === 'all')) level = 'manage';
  if (!level && perm.read !== 'none') {
    try {
      await loadRow(ctx, 'project', projectId, 'read');
      level = 'view';
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
    }
  }
  if (!level) throw notFound('Project not found');
  if (RANK[level] < RANK[need]) throw forbidden(need === 'manage' ? 'Only the project manager can do that' : 'Only project members can do that');
  return { project: p, level };
}

/** Projects the person can see: by record visibility or by membership. */
function visibleProjectsSql(ctx: RecordCtx, p: Params) {
  if (hasAdmin(ctx.principal.permissions, 'projects')) return `r.tenant_id = ${p.add(ctx.tenantId)} and r.deleted_at is null`;
  const me = p.add(ctx.principal.user.id);
  const member = `r.id in (select project_id from project_members m where m.tenant_id = r.tenant_id and m.user_id = ${me})`;
  let vis: string | null = null;
  try {
    vis = visibilityWhere(ctx, 'project', p).filter(Boolean).join(' and ');
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
  }
  return `r.tenant_id = ${p.add(ctx.tenantId)} and r.deleted_at is null and (${member}${vis ? ` or (${vis})` : ''})`;
}

/** Projects the person manages (for approvals and reports). */
async function managedProjectIds(ctx: RecordCtx): Promise<string[] | 'all'> {
  if (hasAdmin(ctx.principal.permissions, 'projects')) return 'all';
  const rows = await ctx.tx.query<{ id: string }>(
    `select id from projects where tenant_id = $1 and deleted_at is null and (owner_id = $2 or id in (select project_id from project_members where tenant_id = $1 and user_id = $2 and role = 'manager'))`,
    [ctx.tenantId, ctx.principal.user.id],
  );
  const ids = rows.map((r) => r.id);
  if (objectPerm(ctx.principal.permissions, 'project').update === 'all') {
    const all = await ctx.tx.query<{ id: string }>(`select id from projects where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
    return [...new Set([...ids, ...all.map((r) => r.id)])];
  }
  return ids;
}

async function notify(ctx: RecordCtx, userIds: (string | null | undefined)[], title: string, link: string, body: string | null = null) {
  const me = ctx.principal.user.id;
  for (const u of new Set(userIds.filter((x): x is string => !!x && x !== me)))
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'project',$3,$4,$5)`, [ctx.tenantId, u, title.slice(0, 200), body, link]);
}

/* ───────────────────────── projects ───────────────────────── */

export async function listProjects(ctx: RecordCtx, q: { status?: string | null; search?: string | null; mine?: boolean }) {
  const p = new Params();
  const where = [visibleProjectsSql(ctx, p)];
  if (q.status) where.push(`r.status = ${p.add(q.status)}`);
  if (q.search) {
    const s = p.add(`%${q.search.replace(/[%_\\]/g, '')}%`);
    where.push(`(r.name ilike ${s} or r.project_code ilike ${s})`);
  }
  if (q.mine) {
    const me = p.add(ctx.principal.user.id);
    where.push(`(r.owner_id = ${me} or r.id in (select project_id from project_members m where m.tenant_id = r.tenant_id and m.user_id = ${me}))`);
  }
  return ctx.tx.query(
    `select r.id, r.name, r.project_code, r.status, r.start_date, r.end_date, r.billing_method, r.budget_type,
            r.budget_hours::float8 as budget_hours, r.progress::float8 as progress, r.owner_id,
            (select full_name from users u where u.tenant_id = r.tenant_id and u.id = r.owner_id) as manager,
            (select name from accounts a where a.tenant_id = r.tenant_id and a.id = r.account_id) as customer,
            (select count(*)::int from project_tasks t where t.tenant_id = r.tenant_id and t.project_id = r.id and t.status not in ('done','cancelled')) as open_tasks,
            (select count(*)::int from project_tasks t where t.tenant_id = r.tenant_id and t.project_id = r.id and t.status not in ('done','cancelled') and t.due_date < current_date) as overdue_tasks,
            (select coalesce(sum(minutes), 0)::float8 / 60 from time_entries e where e.tenant_id = r.tenant_id and e.project_id = r.id) as hours,
            (select count(*)::int from project_repos g where g.tenant_id = r.tenant_id and g.project_id = r.id) as repos
       from projects r where ${where.join(' and ')}
      order by case r.status when 'active' then 0 when 'planning' then 1 when 'on_hold' then 2 else 3 end, coalesce(r.end_date, '9999-12-31'), r.name limit 500`,
    p.values,
  );
}

export async function getProject(ctx: RecordCtx, id: string) {
  const { project, level } = await projectAccess(ctx, id);
  const obj = ctx.meta.objects.find((o) => o.key === 'project')!;
  const members = await ctx.tx.query(
    `select m.user_id, u.full_name, u.email, m.role, m.bill_rate::float8 as bill_rate, m.cost_rate::float8 as cost_rate from project_members m join users u on u.tenant_id = m.tenant_id and u.id = m.user_id
      where m.tenant_id = $1 and m.project_id = $2 order by m.role, u.full_name`,
    [ctx.tenantId, id],
  );
  const showRates = level === 'manage';
  const milestones = await ctx.tx.query(
    `select id, name, start_date, due_date, status, amount::float8 as amount, invoice_id, owner_id, position, accepted_on, acceptance_ref, approval_file_id, approval_activity_id, approval_note, approved_at,
            (select count(*)::int from project_tasks t where t.tenant_id = m.tenant_id and t.milestone_id = m.id) as tasks,
            (select count(*)::int from project_tasks t where t.tenant_id = m.tenant_id and t.milestone_id = m.id and t.status = 'done') as done
       from project_milestones m where tenant_id = $1 and project_id = $2 order by position, due_date nulls last`,
    [ctx.tenantId, id],
  );
  const lists = await ctx.tx.query(`select id, name, milestone_id, position from project_task_lists where tenant_id = $1 and project_id = $2 order by position, created_at`, [ctx.tenantId, id]);
  const owner = project.owner_id ? await ctx.tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [ctx.tenantId, project.owner_id]) : null;
  const dto: Record<string, unknown> = { ...toDto(obj, project, ctx.principal.permissions), manager: owner?.full_name ?? null };
  // rates, fees and money budgets are for the people who run the project
  if (level !== 'manage') for (const k of ['project_rate', 'fixed_fee', 'budget_amount']) dto[k] = null;
  // the client portal link is shared by the people who run the project
  if (level === 'manage') dto.portal_token = project.portal_token ?? null;
  return {
    project: dto,
    level,
    members: members.map((m: any) => (showRates ? m : { ...m, bill_rate: undefined, cost_rate: undefined })),
    milestones,
    lists,
  };
}

/** People who can be assigned work: the manager and members (not viewers). */
async function workers(tx: Tx, tenantId: string, project: Record<string, any>) {
  const rows = await tx.query<{ user_id: string }>(`select user_id from project_members where tenant_id = $1 and project_id = $2 and role <> 'viewer'`, [tenantId, project.id]);
  return new Set([...rows.map((r) => r.user_id), ...(project.owner_id ? [project.owner_id] : [])]);
}

export async function setMembers(ctx: RecordCtx, id: string, members: { userId: string; role: 'manager' | 'member' | 'viewer'; billRate?: number | null; costRate?: number | null }[]) {
  const { project } = await projectAccess(ctx, id, 'manage');
  const ids = [...new Set(members.map((m) => m.userId))];
  if (ids.length !== members.length) throw badRequest('Each person once');
  const users = await ctx.tx.query<{ id: string }>(`select id from users where tenant_id = $1 and id = any($2::uuid[]) and status in ('active', 'invited', 'profile')`, [ctx.tenantId, ids]);
  if (users.length !== ids.length) throw badRequest('Add people from this workspace (active or invited)');
  const before = await ctx.tx.query<{ user_id: string }>(`select user_id from project_members where tenant_id = $1 and project_id = $2`, [ctx.tenantId, id]);
  await ctx.tx.query(`delete from project_members where tenant_id = $1 and project_id = $2`, [ctx.tenantId, id]);
  for (const m of members)
    await ctx.tx.query(`insert into project_members (tenant_id, project_id, user_id, role, bill_rate, cost_rate) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, id, m.userId, m.role, m.billRate ?? null, m.costRate ?? null]);
  const added = ids.filter((u) => !before.some((b) => b.user_id === u));
  await notify(ctx, added, `You were added to project ${project.name}`, `/projects/${id}`);
}

export async function refreshProgress(tx: Tx, tenantId: string, projectId: string) {
  // weighted by estimate when tasks have one; sub-tasks count through their parents
  await tx.query(
    `update projects p set progress = coalesce((
        select round(sum(case when t.status = 'done' then 100 else t.progress end * coalesce(nullif(t.estimate_hours, 0), 1)) / nullif(sum(coalesce(nullif(t.estimate_hours, 0), 1)), 0), 2)
          from project_tasks t where t.tenant_id = p.tenant_id and t.project_id = p.id and t.parent_id is null and t.status <> 'cancelled'), 0)
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, projectId],
  );
}

/** Copies a project's milestones, lists, tasks and dependencies (dates shifted to a new start). */
export async function duplicateProject(ctx: RecordCtx, id: string, input: { name: string; startDate?: string | null; accountId?: string | null }) {
  const { project } = await projectAccess(ctx, id, 'manage');
  const size = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from project_tasks where tenant_id = $1 and project_id = $2`, [ctx.tenantId, id]);
  if ((size?.n ?? 0) > 2000) throw badRequest('Projects with more than 2,000 tasks cannot be copied');
  const shift = input.startDate && project.start_date ? dayDiff(d10(project.start_date), input.startDate) : 0;
  const mv = (d: unknown) => (d ? addDays(d10(d), shift) : null);
  const r = await createRecord(ctx, 'project', {
    name: input.name,
    account_id: input.accountId ?? project.account_id,
    status: 'planning',
    start_date: mv(project.start_date),
    end_date: mv(project.end_date),
    billing_method: project.billing_method,
    project_rate: project.project_rate,
    fixed_fee: project.fixed_fee,
    budget_type: project.budget_type,
    budget_hours: project.budget_hours,
    budget_amount: project.budget_amount,
    tax_rate: project.tax_rate,
    hsn_sac: project.hsn_sac,
    description: project.description,
  });
  const nid = String(r.record.id);
  const map = new Map<string, string>();
  for (const m of await ctx.tx.query<Record<string, any>>(`select * from project_milestones where tenant_id = $1 and project_id = $2`, [ctx.tenantId, id])) {
    const n = await ctx.tx.one<{ id: string }>(`insert into project_milestones (tenant_id, project_id, name, start_date, due_date, amount, position) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [ctx.tenantId, nid, m.name, mv(m.start_date), mv(m.due_date), m.amount, m.position]);
    map.set(m.id, n!.id);
  }
  for (const l of await ctx.tx.query<Record<string, any>>(`select * from project_task_lists where tenant_id = $1 and project_id = $2`, [ctx.tenantId, id])) {
    const n = await ctx.tx.one<{ id: string }>(`insert into project_task_lists (tenant_id, project_id, milestone_id, name, position) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, nid, l.milestone_id ? map.get(l.milestone_id) ?? null : null, l.name, l.position]);
    map.set(l.id, n!.id);
  }
  const tasks = await ctx.tx.query<Record<string, any>>(`select * from project_tasks where tenant_id = $1 and project_id = $2 order by parent_id nulls first, task_number`, [ctx.tenantId, id]);
  for (const t of tasks) {
    const n = await ctx.tx.one<{ id: string }>(
      `insert into project_tasks (tenant_id, project_id, list_id, milestone_id, parent_id, task_number, name, description, priority, start_date, due_date, estimate_hours, billable, rate, tags, position)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
      [ctx.tenantId, nid, t.list_id ? map.get(t.list_id) ?? null : null, t.milestone_id ? map.get(t.milestone_id) ?? null : null, t.parent_id ? map.get(t.parent_id) ?? null : null, t.task_number, t.name, t.description, t.priority, mv(t.start_date), mv(t.due_date), t.estimate_hours, t.billable, t.rate, t.tags, t.position],
    );
    map.set(t.id, n!.id);
  }
  for (const d of await ctx.tx.query<Record<string, any>>(`select d.* from project_task_deps d join project_tasks t on t.tenant_id = d.tenant_id and t.id = d.task_id where d.tenant_id = $1 and t.project_id = $2`, [ctx.tenantId, id]))
    await ctx.tx.query(`insert into project_task_deps (tenant_id, task_id, depends_on_id, kind, lag_days) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, map.get(d.task_id), map.get(d.depends_on_id), d.kind, d.lag_days]);
  return { id: nid, events: r.events };
}

/* ───────────────────────── milestones and lists ───────────────────────── */

export interface MilestoneInput {
  name: string;
  startDate?: string | null;
  dueDate?: string | null;
  amount?: number | null;
  ownerId?: string | null;
  status?: 'open' | 'in_progress' | 'done';
  position?: number;
  /** acceptance by the customer: e.g. GeM CRAC, inspection or completion certificate */
  acceptedOn?: string | null;
  acceptanceRef?: string | null;
  /** the customer's approval: a letter (a file on the project) and/or their email (an activity) */
  approvalFileId?: string | null;
  approvalActivityId?: string | null;
  approvalNote?: string | null;
}

/** Checks the approval evidence points at this project's file / an email from this customer. */
async function checkEvidence(ctx: RecordCtx, project: Record<string, any>, fileId: string | null | undefined, activityId: string | null | undefined) {
  if (fileId && !(await ctx.tx.one(`select 1 from files where tenant_id = $1 and id = $2 and deleted_at is null and object_key = 'project' and record_id = $3`, [ctx.tenantId, fileId, project.id]))) {
    throw badRequest('The approval letter must be a file on this project');
  }
  if (activityId && !(await ctx.tx.one(`select 1 from activities where tenant_id = $1 and id = $2 and kind = 'email'`, [ctx.tenantId, activityId]))) throw badRequest('That email was not found');
}

export async function saveMilestone(ctx: RecordCtx, projectId: string, id: string | null, input: MilestoneInput) {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  if (input.ownerId && !(await workers(ctx.tx, ctx.tenantId, project)).has(input.ownerId)) throw badRequest('The milestone owner must be on the project');
  if (input.startDate && input.dueDate && input.dueDate < input.startDate) throw badRequest('The due date is before the start');
  await checkEvidence(ctx, project, input.approvalFileId, input.approvalActivityId);
  const ev = input.approvalFileId !== undefined || input.approvalActivityId !== undefined || input.approvalNote !== undefined;
  if (id) {
    const cur = await ctx.tx.one<{ invoice_id: string | null; amount: string | null; status: string; approval_file_id: string | null; approval_activity_id: string | null; accepted_on: string | null }>(
      `select invoice_id, amount, status, approval_file_id, approval_activity_id, accepted_on::text from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`,
      [ctx.tenantId, id, projectId],
    );
    if (!cur) throw notFound('Milestone not found');
    if (cur.invoice_id && input.amount !== undefined && Number(input.amount ?? 0) !== Number(cur.amount ?? 0)) throw badRequest('This milestone is invoiced; its amount cannot change');
    // closing needs the customer's approval on record: their letter or their email
    if (input.status === 'done' && cur.status !== 'done') {
      const file = input.approvalFileId !== undefined ? input.approvalFileId : cur.approval_file_id;
      const mail = input.approvalActivityId !== undefined ? input.approvalActivityId : cur.approval_activity_id;
      if (!file && !mail) throw badRequest('Attach the customer\'s approval letter or link their approval email before marking the milestone done');
    }
    const acceptedOn = input.status === 'done' && cur.status !== 'done' && !(input.acceptedOn ?? cur.accepted_on) ? new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10) : undefined;
    await ctx.tx.query(
      `update project_milestones set name = $4, start_date = $5, due_date = $6, amount = $7, owner_id = $8, status = coalesce($9, status), position = coalesce($10, position),
              completed_at = case when $9 = 'done' and status <> 'done' then now() when $9 in ('open','in_progress') then null else completed_at end,
              accepted_on = case when $11 then $12::date else accepted_on end, acceptance_ref = case when $11 then $13 else acceptance_ref end,
              approval_file_id = case when $14 then $15::uuid else approval_file_id end, approval_activity_id = case when $14 then $16::uuid else approval_activity_id end,
              approval_note = case when $14 then $17 else approval_note end,
              approved_by = case when $9 = 'done' and status <> 'done' then $18::uuid when $9 in ('open','in_progress') then null else approved_by end,
              approved_at = case when $9 = 'done' and status <> 'done' then now() when $9 in ('open','in_progress') then null else approved_at end
        where tenant_id = $1 and id = $2 and project_id = $3`,
      [
        ctx.tenantId, id, projectId, input.name, input.startDate ?? null, input.dueDate ?? null, input.amount ?? null, input.ownerId ?? null, input.status ?? null, input.position ?? null,
        input.acceptedOn !== undefined || input.acceptanceRef !== undefined || acceptedOn !== undefined, input.acceptedOn ?? acceptedOn ?? cur.accepted_on ?? null, input.acceptanceRef ?? null,
        ev, input.approvalFileId !== undefined ? input.approvalFileId : cur.approval_file_id, input.approvalActivityId !== undefined ? input.approvalActivityId : cur.approval_activity_id, input.approvalNote ?? null,
        ctx.principal.user.id,
      ],
    );
    return { id };
  }
  if (input.status === 'done' && !input.approvalFileId && !input.approvalActivityId) throw badRequest('Attach the customer\'s approval letter or link their approval email before marking the milestone done');
  return ctx.tx.one<{ id: string }>(
    `insert into project_milestones (tenant_id, project_id, name, start_date, due_date, amount, owner_id, position, accepted_on, acceptance_ref, status, approval_file_id, approval_activity_id, approval_note, completed_at, approved_by, approved_at)
     values ($1,$2,$3,$4,$5,$6,$7, coalesce($8, (select coalesce(max(position), 0) + 1 from project_milestones where tenant_id = $1 and project_id = $2)), $9, $10, coalesce($11, 'open'), $12, $13, $14,
             case when $11 = 'done' then now() end, case when $11 = 'done' then $15::uuid end, case when $11 = 'done' then now() end) returning id`,
    [
      ctx.tenantId, projectId, input.name, input.startDate ?? null, input.dueDate ?? null, input.amount ?? null, input.ownerId ?? null, input.position ?? null, input.acceptedOn ?? null, input.acceptanceRef ?? null,
      input.status ?? null, input.approvalFileId ?? null, input.approvalActivityId ?? null, input.approvalNote ?? null, ctx.principal.user.id,
    ],
  );
}

/* ── milestone approval evidence and the money it produced ── */

const LINK_TABLE = { invoice: 'invoices', payment: 'payments', bill: 'bills', vendor_payment: 'vendor_payments' } as const;
export type MilestoneLinkKind = keyof typeof LINK_TABLE;

/** One milestone with its approval (letter / email) and linked invoices, receipts, bills and vendor payments. */
export async function milestoneDetail(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId);
  const m = await ctx.tx.one<Record<string, any>>(
    `select m.*, f.name as approval_file_name, a.subject as approval_email_subject, a.occurred_at as approval_email_at, a.metadata ->> 'from' as approval_email_from, u.full_name as approved_by_name
       from project_milestones m left join files f on f.tenant_id = m.tenant_id and f.id = m.approval_file_id
       left join activities a on a.tenant_id = m.tenant_id and a.id = m.approval_activity_id left join users u on u.tenant_id = m.tenant_id and u.id = m.approved_by
      where m.tenant_id = $1 and m.id = $2 and m.project_id = $3`,
    [ctx.tenantId, id, projectId],
  );
  if (!m) throw notFound('Milestone not found');
  const links = await ctx.tx.query(
    `select l.kind, l.target_id as id, l.linked_at,
            coalesce(i.invoice_number, p.payment_number, b.bill_number, vp.payment_number) as number,
            coalesce(i.invoice_date, p.payment_date, b.bill_date, vp.payment_date)::text as date,
            coalesce(i.grand_total, p.amount, b.grand_total, vp.amount)::float8 as amount,
            coalesce(i.status, p.status, b.status, vp.status) as status
       from milestone_links l
       left join invoices i on l.kind = 'invoice' and i.tenant_id = l.tenant_id and i.id = l.target_id
       left join payments p on l.kind = 'payment' and p.tenant_id = l.tenant_id and p.id = l.target_id
       left join bills b on l.kind = 'bill' and b.tenant_id = l.tenant_id and b.id = l.target_id
       left join vendor_payments vp on l.kind = 'vendor_payment' and vp.tenant_id = l.tenant_id and vp.id = l.target_id
      where l.tenant_id = $1 and l.milestone_id = $2 order by l.kind, date`,
    [ctx.tenantId, id],
  );
  return { milestone: m, links };
}

/** Invoices, receipts, bills and vendor payments that could belong to the milestone (this project or its customer). */
export async function milestoneCandidates(ctx: RecordCtx, projectId: string, kind: MilestoneLinkKind) {
  const { project } = await projectAccess(ctx, projectId);
  const sql = {
    invoice: `select id, invoice_number as number, invoice_date::text as date, grand_total::float8 as amount, status from invoices where tenant_id = $1 and deleted_at is null and status <> 'cancelled' and doc_type <> 'proforma' and (project_id = $2 or account_id = $3) order by invoice_date desc limit 100`,
    payment: `select id, payment_number as number, payment_date::text as date, amount::float8 as amount, status from payments where tenant_id = $1 and deleted_at is null and status <> 'void' and (project_id = $2 or account_id = $3) order by payment_date desc limit 100`,
    bill: `select id, bill_number as number, bill_date::text as date, grand_total::float8 as amount, status from bills where tenant_id = $1 and deleted_at is null and status <> 'void' and (project_id = $2 or exists (select 1 from bill_lines l where l.tenant_id = bills.tenant_id and l.order_id = bills.id and (l.project_id = $2 or l.billable_account_id = $3))) order by bill_date desc limit 100`,
    vendor_payment: `select id, payment_number as number, payment_date::text as date, amount::float8 as amount, status from vendor_payments where tenant_id = $1 and deleted_at is null and status <> 'void' order by payment_date desc limit 100`,
  }[kind];
  return ctx.tx.query(sql, [ctx.tenantId, projectId, project.account_id ?? null]);
}

export async function linkMilestone(ctx: RecordCtx, projectId: string, id: string, kind: MilestoneLinkKind, targetId: string, on: boolean) {
  await projectAccess(ctx, projectId, 'manage');
  const m = await ctx.tx.one<{ status: string }>(`select status from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!m) throw notFound('Milestone not found');
  if (on) {
    if (m.status !== 'done') throw badRequest('Mark the milestone done (with the customer\'s approval) before linking invoices and payments');
    if (!(await ctx.tx.one(`select 1 from ${LINK_TABLE[kind]} where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, targetId]))) throw notFound('Document not found');
    await ctx.tx.query(`insert into milestone_links (tenant_id, milestone_id, kind, target_id) values ($1,$2,$3,$4) on conflict do nothing`, [ctx.tenantId, id, kind, targetId]);
  } else await ctx.tx.query(`delete from milestone_links where tenant_id = $1 and milestone_id = $2 and kind = $3 and target_id = $4`, [ctx.tenantId, id, kind, targetId]);
  return { ok: true };
}

/**
 * Emails to read for an approval: what the mailbox sync logged against the project's customer, its
 * contacts or the project, newest first. scan = only ones that read like an approval (approved,
 * accepted, completion, CRAC, sign-off…) or mention the milestone.
 */
export async function approvalEmails(ctx: RecordCtx, projectId: string, q: { milestoneId?: string | null; search?: string | null; scan?: boolean }) {
  const { project } = await projectAccess(ctx, projectId);
  const ms = q.milestoneId ? await ctx.tx.one<{ name: string }>(`select name from project_milestones where tenant_id = $1 and id = $2`, [ctx.tenantId, q.milestoneId]) : null;
  const rows = await ctx.tx.query<{ id: string; subject: string | null; body: string | null; direction: string | null; occurred_at: string; from: string | null; related_object: string; related_id: string }>(
    `select a.id, a.subject, left(a.body, 20000) as body, a.direction, a.occurred_at, a.metadata ->> 'from' as from, a.related_object, a.related_id
       from activities a
      where a.tenant_id = $1 and a.kind = 'email'
        and ((a.related_object = 'project' and a.related_id = $2)
          or ($3::uuid is not null and a.related_object = 'account' and a.related_id = $3)
          or ($3::uuid is not null and a.related_object = 'contact' and a.related_id in (select id from contacts where tenant_id = $1 and account_id = $3))
          or ($3::uuid is not null and a.related_object = 'deal' and a.related_id in (select id from deals where tenant_id = $1 and account_id = $3)))
        and ($4::text is null or a.subject ilike '%' || $4 || '%' or a.body ilike '%' || $4 || '%')
      order by a.occurred_at desc limit 200`,
    [ctx.tenantId, projectId, project.account_id ?? null, q.search?.trim() || null],
  );
  const words = /\b(approv|accept|sign[- ]?off|signed off|complet|crac|inspection|certif|go[- ]?ahead|satisf|confirm)/i;
  const name = ms?.name?.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 3) ?? [];
  const scored = rows.map((r) => {
    const text = `${r.subject ?? ''} ${r.body ?? ''}`;
    let score = 0;
    if (words.test(r.subject ?? '')) score += 3;
    if (words.test(r.body ?? '')) score += 2;
    if (r.direction === 'in') score += 1;
    for (const w of name) if (text.toLowerCase().includes(w)) score += 1;
    return { ...r, body: r.body, score, looksLikeApproval: score >= 3 };
  });
  const list = q.scan ? scored.filter((r) => r.score >= 3).sort((a, b) => b.score - a.score) : scored;
  return { items: list.slice(0, 100), mailboxConnected: !!(await ctx.tx.one(`select 1 from integrations where tenant_id = $1 and provider in ('google','microsoft') and status = 'active' and user_id is not null limit 1`, [ctx.tenantId])) };
}

export async function deleteMilestone(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  const m = await ctx.tx.one<{ invoice_id: string | null }>(`select invoice_id from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  if (!m) throw notFound('Milestone not found');
  if (m.invoice_id) throw badRequest('This milestone is invoiced');
  await ctx.tx.query(`delete from project_milestones where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

export async function saveList(ctx: RecordCtx, projectId: string, id: string | null, input: { name: string; milestoneId?: string | null; position?: number }) {
  await projectAccess(ctx, projectId, 'member');
  if (input.milestoneId && !(await ctx.tx.one(`select 1 from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.milestoneId, projectId]))) throw badRequest('Milestone not found');
  if (id) {
    const r = await ctx.tx.one(`update project_task_lists set name = $4, milestone_id = $5, position = coalesce($6, position) where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [ctx.tenantId, id, projectId, input.name, input.milestoneId ?? null, input.position ?? null]);
    if (!r) throw notFound('List not found');
    return { id };
  }
  return ctx.tx.one<{ id: string }>(
    `insert into project_task_lists (tenant_id, project_id, milestone_id, name, position) values ($1,$2,$3,$4, coalesce($5, (select coalesce(max(position), 0) + 1 from project_task_lists where tenant_id = $1 and project_id = $2))) returning id`,
    [ctx.tenantId, projectId, input.milestoneId ?? null, input.name, input.position ?? null],
  );
}

export async function deleteList(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`delete from project_task_lists where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
}

/* ───────────────────────── tasks ───────────────────────── */

export interface TaskInput {
  name?: string;
  description?: string | null;
  listId?: string | null;
  milestoneId?: string | null;
  parentId?: string | null;
  status?: 'open' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
  priority?: 'none' | 'low' | 'medium' | 'high' | 'urgent';
  assignees?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  estimateHours?: number | null;
  progress?: number;
  billable?: boolean;
  rate?: number | null;
  tags?: string[];
  position?: number;
  workType?: WorkType;
}

const TASK_COLS = `t.id, t.project_id, t.list_id, t.milestone_id, t.parent_id, t.task_number, t.name, t.description, t.status, t.priority, t.assignees, t.start_date, t.due_date,
  t.estimate_hours::float8 as estimate_hours, t.progress, t.billable, t.rate::float8 as rate, t.tags, t.position, t.completed_at, t.created_by, t.created_at, t.updated_at,
  t.work_type, t.story_points::float8 as story_points, t.sprint_id, t.release_id, t.epic_id, t.backlog_rank`;

export async function listTasks(ctx: RecordCtx, projectId: string, q: { assignee?: string | null; status?: string | null; listId?: string | null } = {}) {
  const { level } = await projectAccess(ctx, projectId);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select ${TASK_COLS},
            (select coalesce(sum(minutes), 0)::float8 / 60 from time_entries e where e.tenant_id = t.tenant_id and e.task_id = t.id) as logged_hours,
            (select count(*)::int from project_comments c where c.tenant_id = t.tenant_id and c.task_id = t.id) as comments
       from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and ($3::uuid is null or $3 = any(t.assignees)) and ($4::text is null or t.status = $4) and ($5::uuid is null or t.list_id = $5)
      order by t.position, t.task_number limit 3000`,
    [ctx.tenantId, projectId, q.assignee ?? null, q.status ?? null, q.listId ?? null],
  );
  const deps = await ctx.tx.query(
    `select d.task_id, d.depends_on_id, d.kind, d.lag_days from project_task_deps d join project_tasks t on t.tenant_id = d.tenant_id and t.id = d.task_id where d.tenant_id = $1 and t.project_id = $2`,
    [ctx.tenantId, projectId],
  );
  if (level !== 'manage') for (const r of rows) delete r.rate;
  return { tasks: rows, deps };
}

async function checkTaskRefs(ctx: RecordCtx, project: Record<string, any>, input: TaskInput, selfId?: string) {
  const pid = project.id;
  if (input.listId && !(await ctx.tx.one(`select 1 from project_task_lists where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.listId, pid]))) throw badRequest('Task list not found');
  if (input.milestoneId && !(await ctx.tx.one(`select 1 from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.milestoneId, pid]))) throw badRequest('Milestone not found');
  if (input.parentId) {
    const type = selfId ? ((await ctx.tx.one<{ work_type: WorkType }>(`select work_type from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, selfId]))?.work_type ?? 'task') : (input.workType ?? 'task');
    await checkParent(ctx.tx, ctx.tenantId, pid, type, input.parentId, selfId);
  }
  if (input.assignees?.length) {
    const ok = await workers(ctx.tx, ctx.tenantId, project);
    if (input.assignees.some((a) => !ok.has(a))) throw badRequest('Assign tasks to project members');
  }
  if (input.startDate && input.dueDate && input.dueDate < input.startDate) throw badRequest('The due date is before the start');
}

export async function createTask(ctx: RecordCtx, projectId: string, input: TaskInput & { name: string }) {
  const { project, level } = await projectAccess(ctx, projectId, 'member');
  if (input.rate !== undefined && input.rate !== null && level !== 'manage') throw forbidden('Only the project manager sets task rates');
  await checkTaskRefs(ctx, project, input);
  await ctx.tx.query(`select 1 from projects where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, projectId]);
  const n = await ctx.tx.one<{ n: number }>(`select coalesce(max(task_number), 0) + 1 as n from project_tasks where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]);
  const t = await ctx.tx.one<{ id: string }>(
    `insert into project_tasks (tenant_id, project_id, list_id, milestone_id, parent_id, task_number, name, description, status, priority, assignees, start_date, due_date, estimate_hours, progress, billable, rate, tags, position, completed_at, work_type, reporter_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
             coalesce($19, (select coalesce(max(position), 0) + 1 from project_tasks where tenant_id = $1 and project_id = $2)), case when $9 = 'done' then now() end, $20, $21) returning id`,
    [
      ctx.tenantId, projectId, input.listId ?? null, input.milestoneId ?? null, input.parentId ?? null, n!.n, input.name, input.description ?? null, input.status ?? 'open', input.priority ?? 'medium',
      input.assignees ?? [], input.startDate ?? null, input.dueDate ?? null, input.estimateHours ?? null, input.status === 'done' ? 100 : input.progress ?? 0, input.billable ?? project.billing_method !== 'non_billable', input.rate ?? null,
      input.tags ?? [], input.position ?? null, input.workType ?? 'task', ctx.principal.user.id,
    ],
  );
  if (input.parentId) await refreshEpics(ctx.tx, ctx.tenantId, t!.id);
  await refreshProgress(ctx.tx, ctx.tenantId, projectId);
  await notify(ctx, input.assignees ?? [], `New task in ${project.name}: ${input.name}`, `/projects/${projectId}#task-${t!.id}`);
  return { id: t!.id, number: n!.n };
}

export async function updateTask(ctx: RecordCtx, projectId: string, taskId: string, input: TaskInput) {
  const { project, level } = await projectAccess(ctx, projectId, 'member');
  const cur = await ctx.tx.one<Record<string, any>>(`select * from project_tasks where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, taskId, projectId]);
  if (!cur) throw notFound('Task not found');
  if (input.rate !== undefined && level !== 'manage') throw forbidden('Only the project manager sets task rates');
  if (input.billable !== undefined && input.billable !== cur.billable && level !== 'manage') throw forbidden('Only the project manager decides what is billable');
  const next = {
    listId: input.listId !== undefined ? input.listId : cur.list_id,
    milestoneId: input.milestoneId !== undefined ? input.milestoneId : cur.milestone_id,
    parentId: input.parentId !== undefined ? input.parentId : cur.parent_id,
    startDate: input.startDate !== undefined ? input.startDate : cur.start_date ? d10(cur.start_date) : null,
    dueDate: input.dueDate !== undefined ? input.dueDate : cur.due_date ? d10(cur.due_date) : null,
    assignees: input.assignees,
  };
  await checkTaskRefs(ctx, project, { ...next, assignees: input.assignees?.filter((a) => !(cur.assignees as string[]).includes(a)) }, taskId);
  const status = input.status ?? cur.status;
  const nextState = status !== cur.status ? await stateForStatus(ctx.tx, ctx.tenantId, projectId, cur as never, status, level === 'manage' ? 'manager' : 'member') : cur.state;
  if (status === 'done' && cur.status !== 'done') {
    const open = await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and parent_id = $2 and status not in ('done','cancelled') limit 1`, [ctx.tenantId, taskId]);
    if (open) throw badRequest('Finish or cancel the sub-tasks first');
  }
  await ctx.tx.query(
    `update project_tasks set name = coalesce($3, name), description = case when $4::boolean then $5 else description end, list_id = $6, milestone_id = $7, parent_id = $8,
            status = $9, priority = coalesce($10, priority), assignees = coalesce($11, assignees), start_date = $12, due_date = $13,
            estimate_hours = case when $14::boolean then $15 else estimate_hours end, progress = case when $9 = 'done' then 100 else coalesce($16, progress) end,
            billable = coalesce($17, billable), rate = case when $18::boolean then $19 else rate end, tags = coalesce($20, tags), position = coalesce($21, position),
            completed_at = case when $9 = 'done' and status <> 'done' then now() when $9 <> 'done' then null else completed_at end, state = $22
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, taskId, input.name ?? null, input.description !== undefined, input.description ?? null, next.listId, next.milestoneId, next.parentId, status, input.priority ?? null,
      input.assignees ?? null, next.startDate, next.dueDate, input.estimateHours !== undefined, input.estimateHours ?? null, input.progress ?? null, input.billable ?? null,
      input.rate !== undefined, input.rate ?? null, input.tags ?? null, input.position ?? null, nextState ?? null,
    ],
  );
  if (input.parentId !== undefined && input.parentId !== cur.parent_id) await refreshEpics(ctx.tx, ctx.tenantId, taskId);
  if (input.dueDate !== undefined || input.startDate !== undefined) await reschedule(ctx.tx, ctx.tenantId, taskId);
  await refreshProgress(ctx.tx, ctx.tenantId, projectId);
  const added = (input.assignees ?? []).filter((a) => !(cur.assignees as string[]).includes(a));
  await notify(ctx, added, `Task assigned in ${project.name}: ${input.name ?? cur.name}`, `/projects/${projectId}#task-${taskId}`);
  if (status !== cur.status && (status === 'done' || status === 'review'))
    await notify(ctx, [cur.created_by, project.owner_id], `${input.name ?? cur.name} is ${status === 'done' ? 'done' : 'ready for review'}`, `/projects/${projectId}#task-${taskId}`);
}

export async function deleteTask(ctx: RecordCtx, projectId: string, taskId: string) {
  const { level } = await projectAccess(ctx, projectId, 'member');
  const t = await ctx.tx.one<{ created_by: string | null }>(`select created_by from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, taskId, projectId]);
  if (!t) throw notFound('Task not found');
  if (level !== 'manage' && t.created_by !== ctx.principal.user.id) throw forbidden('Only the project manager or the task creator can delete it');
  const time = await ctx.tx.one(`select 1 from time_entries where tenant_id = $1 and (task_id = $2 or task_id in (select id from project_tasks where tenant_id = $1 and parent_id = $2)) and status in ('submitted','approved','invoiced') limit 1`, [ctx.tenantId, taskId]);
  if (time) throw badRequest('Submitted or approved time is logged against this task; mark it cancelled instead');
  await ctx.tx.query(`delete from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]);
  await refreshProgress(ctx.tx, ctx.tenantId, projectId);
}

/** Adds a dependency; refuses cycles and links across projects. */
export async function addDependency(ctx: RecordCtx, projectId: string, taskId: string, dependsOnId: string, kind: 'fs' | 'ss' | 'ff' | 'sf' = 'fs', lagDays = 0) {
  await projectAccess(ctx, projectId, 'member');
  const both = await ctx.tx.query<{ id: string }>(`select id from project_tasks where tenant_id = $1 and project_id = $2 and id = any($3::uuid[])`, [ctx.tenantId, projectId, [taskId, dependsOnId]]);
  if (both.length !== 2) throw badRequest('Both tasks must be in this project');
  // would dependsOn (transitively) depend on task?
  const loop = await ctx.tx.one(
    `with recursive up(id) as (select depends_on_id from project_task_deps where tenant_id = $1 and task_id = $2
       union select d.depends_on_id from project_task_deps d join up on d.task_id = up.id where d.tenant_id = $1)
     select 1 from up where id = $3 limit 1`,
    [ctx.tenantId, dependsOnId, taskId],
  );
  if (loop) throw badRequest('That would make a circular dependency');
  await ctx.tx.query(
    `insert into project_task_deps (tenant_id, task_id, depends_on_id, kind, lag_days) values ($1,$2,$3,$4,$5) on conflict (tenant_id, task_id, depends_on_id) do update set kind = excluded.kind, lag_days = excluded.lag_days`,
    [ctx.tenantId, taskId, dependsOnId, kind, lagDays],
  );
  await reschedule(ctx.tx, ctx.tenantId, dependsOnId);
}

export async function removeDependency(ctx: RecordCtx, projectId: string, taskId: string, dependsOnId: string) {
  await projectAccess(ctx, projectId, 'member');
  await ctx.tx.query(
    `delete from project_task_deps d using project_tasks t where d.tenant_id = $1 and d.task_id = $2 and d.depends_on_id = $3 and t.tenant_id = d.tenant_id and t.id = d.task_id and t.project_id = $4`,
    [ctx.tenantId, taskId, dependsOnId, projectId],
  );
}

/**
 * Pushes successors later when a task's dates move so that every dependency still holds
 * (finish-to-start, start-to-start, finish-to-finish, start-to-finish, with lag). Durations are kept;
 * nothing is pulled earlier. Bounded to 500 moves.
 */
async function reschedule(tx: Tx, tenantId: string, fromTask: string) {
  const queue = [fromTask];
  let moves = 0;
  while (queue.length && moves < 500) {
    const id = queue.shift()!;
    const t = await tx.one<{ start_date: string | null; due_date: string | null }>(`select start_date, due_date from project_tasks where tenant_id = $1 and id = $2`, [tenantId, id]);
    if (!t) continue;
    const succ = await tx.query<{ task_id: string; kind: string; lag_days: number; start_date: string | null; due_date: string | null; status: string }>(
      `select d.task_id, d.kind, d.lag_days, s.start_date, s.due_date, s.status from project_task_deps d join project_tasks s on s.tenant_id = d.tenant_id and s.id = d.task_id where d.tenant_id = $1 and d.depends_on_id = $2`,
      [tenantId, id],
    );
    for (const s of succ) {
      if (s.status === 'done' || s.status === 'cancelled' || !s.start_date) continue;
      const start = d10(s.start_date);
      const due = s.due_date ? d10(s.due_date) : start;
      const dur = dayDiff(start, due);
      const pStart = t.start_date ? d10(t.start_date) : null;
      const pDue = t.due_date ? d10(t.due_date) : pStart;
      let minStart: string | null = null;
      if (s.kind === 'fs' && pDue) minStart = addDays(pDue, 1 + s.lag_days);
      if (s.kind === 'ss' && pStart) minStart = addDays(pStart, s.lag_days);
      if (s.kind === 'ff' && pDue) minStart = addDays(addDays(pDue, s.lag_days), -dur);
      if (s.kind === 'sf' && pStart) minStart = addDays(addDays(pStart, s.lag_days), -dur);
      if (minStart && minStart > start) {
        await tx.query(`update project_tasks set start_date = $3, due_date = $4 where tenant_id = $1 and id = $2`, [tenantId, s.task_id, minStart, addDays(minStart, dur)]);
        queue.push(s.task_id);
        moves++;
      }
    }
  }
}

export async function listComments(ctx: RecordCtx, projectId: string, target: { taskId?: string; issueId?: string }) {
  await projectAccess(ctx, projectId);
  return ctx.tx.query(
    `select c.id, c.body, c.created_at, c.user_id, u.full_name from project_comments c left join users u on u.tenant_id = c.tenant_id and u.id = c.user_id
      where c.tenant_id = $1 and c.project_id = $2 and (c.task_id = $3 or c.issue_id = $4) order by c.created_at limit 500`,
    [ctx.tenantId, projectId, target.taskId ?? null, target.issueId ?? null],
  );
}

export async function addComment(ctx: RecordCtx, projectId: string, target: { taskId?: string; issueId?: string }, body: string) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  const row = target.taskId
    ? await ctx.tx.one<{ name: string; assignees: string[]; created_by: string | null }>(`select name, assignees, created_by from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, target.taskId, projectId])
    : await ctx.tx.one<{ name: string; assignees: string[]; created_by: string | null }>(
        `select title as name, array_remove(array[assignee_id], null) as assignees, reporter_id as created_by from project_issues where tenant_id = $1 and id = $2 and project_id = $3`,
        [ctx.tenantId, target.issueId, projectId],
      );
  if (!row) throw notFound();
  const c = await ctx.tx.one<{ id: string }>(`insert into project_comments (tenant_id, project_id, task_id, issue_id, body) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, projectId, target.taskId ?? null, target.issueId ?? null, body]);
  const team = await workers(ctx.tx, ctx.tenantId, project);
  await notify(ctx, [...row.assignees, row.created_by].filter((u) => u && team.has(u)), `New comment on ${row.name}`, `/projects/${project.id}`, body.slice(0, 200));
  return c;
}

/* ───────────────────────── issues ───────────────────────── */

export interface IssueInput {
  title?: string;
  description?: string | null;
  severity?: 'minor' | 'major' | 'critical' | 'blocker';
  status?: 'open' | 'in_progress' | 'fixed' | 'closed' | 'reopened' | 'wont_fix';
  assigneeId?: string | null;
  taskId?: string | null;
  milestoneId?: string | null;
  dueDate?: string | null;
}

export async function listIssues(ctx: RecordCtx, projectId: string, status?: string | null) {
  await projectAccess(ctx, projectId);
  return ctx.tx.query(
    `select i.id, i.issue_number, i.title, i.description, i.severity, i.status, i.assignee_id, a.full_name as assignee, i.reporter_id, r.full_name as reporter, i.task_id, i.milestone_id, i.due_date, i.closed_at, i.created_at, i.updated_at
       from project_issues i left join users a on a.tenant_id = i.tenant_id and a.id = i.assignee_id left join users r on r.tenant_id = i.tenant_id and r.id = i.reporter_id
      where i.tenant_id = $1 and i.project_id = $2 and ($3::text is null or i.status = $3) order by case i.status when 'closed' then 1 when 'wont_fix' then 1 else 0 end, i.issue_number desc limit 2000`,
    [ctx.tenantId, projectId, status ?? null],
  );
}

export async function saveIssue(ctx: RecordCtx, projectId: string, id: string | null, input: IssueInput) {
  const { project } = await projectAccess(ctx, projectId, 'member');
  if (input.assigneeId && !(await workers(ctx.tx, ctx.tenantId, project)).has(input.assigneeId)) throw badRequest('Assign issues to project members');
  if (input.taskId && !(await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.taskId, projectId]))) throw badRequest('Task not found');
  if (input.milestoneId && !(await ctx.tx.one(`select 1 from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.milestoneId, projectId]))) throw badRequest('Milestone not found');
  if (id) {
    const cur = await ctx.tx.one<{ assignee_id: string | null; title: string; reporter_id: string | null; status: string }>(`select assignee_id, title, reporter_id, status from project_issues where tenant_id = $1 and id = $2 and project_id = $3 for update`, [ctx.tenantId, id, projectId]);
    if (!cur) throw notFound('Issue not found');
    await ctx.tx.query(
      `update project_issues set title = coalesce($4, title), description = case when $5::boolean then $6 else description end, severity = coalesce($7, severity), status = coalesce($8, status),
              assignee_id = case when $9::boolean then $10::uuid else assignee_id end, task_id = case when $11::boolean then $12::uuid else task_id end,
              milestone_id = case when $13::boolean then $14::uuid else milestone_id end, due_date = case when $15::boolean then $16::date else due_date end,
              closed_at = case when coalesce($8, status) in ('closed','wont_fix') then coalesce(closed_at, now()) else null end
        where tenant_id = $1 and id = $2 and project_id = $3`,
      [
        ctx.tenantId, id, projectId, input.title ?? null, input.description !== undefined, input.description ?? null, input.severity ?? null, input.status ?? null,
        input.assigneeId !== undefined, input.assigneeId ?? null, input.taskId !== undefined, input.taskId ?? null, input.milestoneId !== undefined, input.milestoneId ?? null, input.dueDate !== undefined, input.dueDate ?? null,
      ],
    );
    if (input.assigneeId && input.assigneeId !== cur.assignee_id) await notify(ctx, [input.assigneeId], `Issue assigned in ${project.name}: ${input.title ?? cur.title}`, `/projects/${projectId}`);
    if (input.status && input.status !== cur.status && ['fixed', 'closed'].includes(input.status)) await notify(ctx, [cur.reporter_id], `${input.title ?? cur.title} is ${input.status}`, `/projects/${projectId}`);
    return { id };
  }
  if (!input.title) throw badRequest('Give the issue a title');
  await ctx.tx.query(`select 1 from projects where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, projectId]);
  const n = await ctx.tx.one<{ n: number }>(`select coalesce(max(issue_number), 0) + 1 as n from project_issues where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into project_issues (tenant_id, project_id, issue_number, title, description, severity, status, assignee_id, task_id, milestone_id, due_date) values ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10) returning id`,
    [ctx.tenantId, projectId, n!.n, input.title, input.description ?? null, input.severity ?? 'major', input.assigneeId ?? null, input.taskId ?? null, input.milestoneId ?? null, input.dueDate ?? null],
  );
  await notify(ctx, [input.assigneeId, project.owner_id], `New issue in ${project.name}: ${input.title}`, `/projects/${projectId}`);
  return { id: r!.id, number: n!.n };
}

/* ───────────────────────── time ───────────────────────── */

/** Bill and cost rate for a person's hour on a project (and task), by the project's billing method. */
async function rates(tx: Tx, tenantId: string, project: Record<string, any>, userId: string, taskId: string | null) {
  const m = await tx.one<{ bill_rate: string | null; cost_rate: string | null }>(`select bill_rate, cost_rate from project_members where tenant_id = $1 and project_id = $2 and user_id = $3`, [tenantId, project.id, userId]);
  const task = taskId ? await tx.one<{ rate: string | null; billable: boolean }>(`select rate, billable from project_tasks where tenant_id = $1 and id = $2`, [tenantId, taskId]) : null;
  const pr = Number(project.project_rate ?? 0);
  const bill =
    project.billing_method === 'time_project_rate' ? pr
    : project.billing_method === 'time_staff_rate' ? Number(m?.bill_rate ?? pr)
    : project.billing_method === 'time_task_rate' ? Number(task?.rate ?? pr)
    : 0;
  return { bill, cost: Number(m?.cost_rate ?? 0), billableDefault: project.billing_method !== 'non_billable' && project.billing_method !== 'fixed_price' && (task ? task.billable : true) };
}

export interface TimeInput {
  projectId: string;
  taskId?: string | null;
  issueId?: string | null;
  userId?: string | null;
  date: string;
  minutes: number;
  notes?: string | null;
  billable?: boolean;
}

async function timeTarget(ctx: RecordCtx, input: TimeInput) {
  const { project, level } = await projectAccess(ctx, input.projectId, 'member');
  if (!['active', 'planning'].includes(project.status)) throw badRequest(`Time cannot be logged on a ${String(project.status).replace('_', ' ')} project`);
  const userId = input.userId ?? ctx.principal.user.id;
  if (userId !== ctx.principal.user.id) {
    if (level !== 'manage') throw forbidden('Only the project manager logs time for others');
    if (!(await workers(ctx.tx, ctx.tenantId, project)).has(userId)) throw badRequest('That person is not on the project');
  }
  if (input.taskId && !(await ctx.tx.one(`select 1 from project_tasks where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.taskId, input.projectId]))) throw badRequest('Task not found');
  if (input.issueId && !(await ctx.tx.one(`select 1 from project_issues where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, input.issueId, input.projectId]))) throw badRequest('Issue not found');
  if (input.date > addDays(today(), 7)) throw badRequest('Time cannot be logged more than a week ahead');
  return { project, userId };
}

async function weekOpen(tx: Tx, tenantId: string, userId: string, date: string) {
  const ws = weekStart(date);
  const s = await tx.one<{ status: string }>(`select status from timesheets where tenant_id = $1 and user_id = $2 and week_start = $3`, [tenantId, userId, ws]);
  if (s && ['submitted', 'approved'].includes(s.status)) throw badRequest(`The week of ${ws} is already ${s.status}`);
}

export function weekStart(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -dow);
}

export async function logTime(ctx: RecordCtx, input: TimeInput) {
  const { project, userId } = await timeTarget(ctx, input);
  await weekOpen(ctx.tx, ctx.tenantId, userId, input.date);
  const r = await rates(ctx.tx, ctx.tenantId, project, userId, input.taskId ?? null);
  const daySum = await ctx.tx.one<{ m: number }>(`select coalesce(sum(minutes), 0)::int as m from time_entries where tenant_id = $1 and user_id = $2 and work_date = $3`, [ctx.tenantId, userId, input.date]);
  if ((daySum?.m ?? 0) + input.minutes > 1440) throw badRequest('That is more than 24 hours on one day');
  return ctx.tx.one<{ id: string }>(
    `insert into time_entries (tenant_id, project_id, task_id, issue_id, user_id, work_date, minutes, notes, billable, bill_rate, cost_rate) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, input.projectId, input.taskId ?? null, input.issueId ?? null, userId, input.date, input.minutes, input.notes ?? null, input.billable ?? r.billableDefault, r.bill, r.cost],
  );
}

async function ownEditableEntry(ctx: RecordCtx, id: string) {
  const e = await ctx.tx.one<Record<string, any>>(`select * from time_entries where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!e) throw notFound('Time entry not found');
  const { level } = await projectAccess(ctx, e.project_id, 'member');
  if (e.user_id !== ctx.principal.user.id && level !== 'manage') throw forbidden('That is someone else\'s time');
  if (!['draft', 'rejected'].includes(e.status)) throw badRequest('Submitted or approved time cannot change');
  return e;
}

export async function updateTime(ctx: RecordCtx, id: string, input: Partial<TimeInput>) {
  const e = await ownEditableEntry(ctx, id);
  const merged: TimeInput = { projectId: e.project_id, taskId: input.taskId !== undefined ? input.taskId : e.task_id, issueId: input.issueId !== undefined ? input.issueId : e.issue_id, userId: e.user_id, date: input.date ?? d10(e.work_date), minutes: input.minutes ?? e.minutes, notes: input.notes !== undefined ? input.notes : e.notes, billable: input.billable ?? e.billable };
  const { project } = await timeTarget(ctx, merged);
  await weekOpen(ctx.tx, ctx.tenantId, e.user_id, merged.date);
  const r = await rates(ctx.tx, ctx.tenantId, project, e.user_id, merged.taskId ?? null);
  await ctx.tx.query(
    `update time_entries set task_id = $3, issue_id = $4, work_date = $5, minutes = $6, notes = $7, billable = $8, bill_rate = $9, cost_rate = $10, status = 'draft', entered_by = $11 where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, merged.taskId ?? null, merged.issueId ?? null, merged.date, merged.minutes, merged.notes ?? null, merged.billable, r.bill, r.cost, ctx.principal.user.id],
  );
}

export async function deleteTime(ctx: RecordCtx, id: string) {
  await ownEditableEntry(ctx, id);
  await ctx.tx.query(`delete from time_entries where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

export async function startTimer(ctx: RecordCtx, input: { projectId: string; taskId?: string | null; issueId?: string | null; notes?: string | null }) {
  const running = await ctx.tx.one(`select 1 from time_entries where tenant_id = $1 and user_id = $2 and timer_started_at is not null`, [ctx.tenantId, ctx.principal.user.id]);
  if (running) throw badRequest('A timer is already running; stop it first');
  const e = await logTime(ctx, { ...input, date: today(), minutes: 0 });
  await ctx.tx.query(`update time_entries set timer_started_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, e!.id]);
  return e;
}

export async function stopTimer(ctx: RecordCtx) {
  const e = await ctx.tx.one<{ id: string; minutes: number; secs: number; work_date: string }>(
    `select id, minutes, extract(epoch from now() - timer_started_at)::int as secs, work_date from time_entries where tenant_id = $1 and user_id = $2 and timer_started_at is not null for update`,
    [ctx.tenantId, ctx.principal.user.id],
  );
  if (!e) throw badRequest('No timer is running');
  const day = await ctx.tx.one<{ m: number }>(`select coalesce(sum(minutes), 0)::int as m from time_entries where tenant_id = $1 and user_id = $2 and work_date = $3 and id <> $4`, [ctx.tenantId, ctx.principal.user.id, e.work_date, e.id]);
  const room = 1440 - (day?.m ?? 0);
  const minutes = Math.min(room, Math.max(1, e.minutes + Math.ceil(e.secs / 60)));
  if (minutes <= 0) {
    await ctx.tx.query(`delete from time_entries where tenant_id = $1 and id = $2`, [ctx.tenantId, e.id]);
    throw badRequest('The day already has 24 hours logged; the timer was discarded');
  }
  await ctx.tx.query(`update time_entries set minutes = $3, timer_started_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, e.id, minutes]);
  return { id: e.id, minutes };
}

export async function runningTimer(ctx: RecordCtx) {
  return ctx.tx.one(
    `select e.id, e.project_id, p.name as project, e.task_id, t.name as task, e.timer_started_at, e.minutes from time_entries e join projects p on p.tenant_id = e.tenant_id and p.id = e.project_id
       left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id where e.tenant_id = $1 and e.user_id = $2 and e.timer_started_at is not null`,
    [ctx.tenantId, ctx.principal.user.id],
  );
}

/** A person's week: entries, totals and status. Others' weeks need to manage one of the projects (entries filtered to those). */
export async function getWeek(ctx: RecordCtx, date: string, userId?: string | null) {
  const ws = weekStart(date);
  const who = userId ?? ctx.principal.user.id;
  let projectFilter: string[] | null = null;
  if (who !== ctx.principal.user.id) {
    const m = await managedProjectIds(ctx);
    if (m !== 'all') {
      const shared = await ctx.tx.one(
        `select 1 where exists (select 1 from project_members where tenant_id = $1 and user_id = $2 and project_id = any($3::uuid[]))
                     or exists (select 1 from time_entries where tenant_id = $1 and user_id = $2 and project_id = any($3::uuid[]))`,
        [ctx.tenantId, who, m],
      );
      if (!shared) throw forbidden('You can see the timesheets of people on projects you manage');
      projectFilter = m;
    }
  }
  const entries = await ctx.tx.query(
    `select e.id, e.project_id, p.name as project, p.project_code, e.task_id, t.name as task, t.task_number, e.issue_id, e.work_date, e.minutes, e.notes, e.billable, e.status, e.timer_started_at, e.invoice_id
       from time_entries e join projects p on p.tenant_id = e.tenant_id and p.id = e.project_id left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
      where e.tenant_id = $1 and e.user_id = $2 and e.work_date between $3::date and $4::date and ($5::uuid[] is null or e.project_id = any($5::uuid[])) order by e.work_date, p.name, t.task_number`,
    [ctx.tenantId, who, ws, addDays(ws, 6), projectFilter],
  );
  const sheet = await ctx.tx.one(`select id, status, submitted_at, decided_at, reject_reason from timesheets where tenant_id = $1 and user_id = $2 and week_start = $3`, [ctx.tenantId, who, ws]);
  const cap = await ctx.tx.one<{ weekly_hours: number }>(`select weekly_hours::float8 as weekly_hours from resource_capacity where tenant_id = $1 and user_id = $2`, [ctx.tenantId, who]);
  return { weekStart: ws, userId: who, entries, timesheet: sheet ?? { status: 'draft' }, capacityHours: cap?.weekly_hours ?? 40 };
}

/**
 * Applies a weekly grid (one row per project / task, seven days of minutes) to the person's draft or
 * rejected time. Existing entries keep their notes, billable flag and issue link: a cell that grew
 * gets an extra entry for the difference, a cell that shrank takes minutes off its latest entries,
 * and a project / task no longer in the grid loses its draft time.
 */
export async function saveWeek(ctx: RecordCtx, date: string, rows: { projectId: string; taskId?: string | null; billable?: boolean; notes?: string | null; minutes: number[] }[]) {
  const ws = weekStart(date);
  const me = ctx.principal.user.id;
  await weekOpen(ctx.tx, ctx.tenantId, me, ws);
  const existing = await ctx.tx.query<{ id: string; project_id: string; task_id: string | null; work_date: string; minutes: number }>(
    `select id, project_id, task_id, work_date::text as work_date, minutes from time_entries
      where tenant_id = $1 and user_id = $2 and work_date between $3::date and $4::date and status in ('draft','rejected') and timer_started_at is null
      order by created_at for update`,
    [ctx.tenantId, me, ws, addDays(ws, 6)],
  );
  const want = new Map<string, number>();
  const meta = new Map<string, { projectId: string; taskId: string | null; billable?: boolean; notes?: string | null; date: string }>();
  for (const r of rows) {
    if (r.minutes.length !== 7) throw badRequest('Each row has seven days');
    for (let i = 0; i < 7; i++) {
      const k = `${r.projectId}|${r.taskId ?? ''}|${addDays(ws, i)}`;
      want.set(k, (want.get(k) ?? 0) + Math.max(0, Math.round(r.minutes[i] ?? 0)));
      meta.set(k, { projectId: r.projectId, taskId: r.taskId ?? null, billable: r.billable, notes: r.notes, date: addDays(ws, i) });
    }
  }
  const have = new Map<string, typeof existing>();
  for (const e of existing) {
    const k = `${e.project_id}|${e.task_id ?? ''}|${e.work_date}`;
    have.set(k, [...(have.get(k) ?? []), e]);
  }
  let changed = 0;
  // shrink or remove first (frees room under the 24-hour cap), then grow
  for (const [k, es] of have) {
    let excess = es.reduce((s2, e) => s2 + e.minutes, 0) - (want.get(k) ?? 0);
    for (const e of [...es].reverse()) {
      if (excess <= 0) break;
      const take = Math.min(e.minutes, excess);
      excess -= take;
      changed++;
      if (take === e.minutes) await ctx.tx.query(`delete from time_entries where tenant_id = $1 and id = $2`, [ctx.tenantId, e.id]);
      else await ctx.tx.query(`update time_entries set minutes = minutes - $3, status = 'draft', entered_by = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, e.id, take, me]);
    }
  }
  for (const [k, minutes] of want) {
    const extra = minutes - (have.get(k) ?? []).reduce((s2, e) => s2 + e.minutes, 0);
    if (extra <= 0) continue;
    const m = meta.get(k)!;
    await logTime(ctx, { projectId: m.projectId, taskId: m.taskId, date: m.date, minutes: extra, notes: m.notes ?? null, billable: m.billable });
    changed++;
  }
  return { changed };
}

export async function submitWeek(ctx: RecordCtx, date: string) {
  const ws = weekStart(date);
  const me = ctx.principal.user.id;
  if (await ctx.tx.one(`select 1 from time_entries where tenant_id = $1 and user_id = $2 and timer_started_at is not null and work_date between $3::date and $4::date`, [ctx.tenantId, me, ws, addDays(ws, 6)])) throw badRequest('Stop the running timer first');
  const sheet = await ctx.tx.one<{ id: string; status: string }>(
    `insert into timesheets (tenant_id, user_id, week_start, status, submitted_at) values ($1,$2,$3,'submitted', now())
     on conflict (tenant_id, user_id, week_start) do update set status = 'submitted', submitted_at = now(), reject_reason = null, decided_by = null, decided_at = null
       where timesheets.status in ('draft','rejected') returning id, status`,
    [ctx.tenantId, me, ws],
  );
  if (!sheet) throw badRequest('This week is already submitted');
  const moved = await ctx.tx.query<{ project_id: string }>(
    `update time_entries set status = 'submitted', timesheet_id = $5 where tenant_id = $1 and user_id = $2 and work_date between $3::date and $4::date and status in ('draft','rejected') returning project_id`,
    [ctx.tenantId, me, ws, addDays(ws, 6), sheet.id],
  );
  if (!moved.length) throw badRequest('There is no time to submit this week');
  const managers = await ctx.tx.query<{ user_id: string }>(
    `select owner_id as user_id from projects where tenant_id = $1 and id = any($2::uuid[]) and owner_id is not null
     union select user_id from project_members where tenant_id = $1 and project_id = any($2::uuid[]) and role = 'manager'`,
    [ctx.tenantId, [...new Set(moved.map((m) => m.project_id))]],
  );
  await notify(ctx, managers.map((m) => m.user_id), `${ctx.principal.user.fullName} submitted time for the week of ${ws}`, `/timesheet#approvals`);
  return { entries: moved.length };
}

/** Submitted time waiting for the current person, grouped by person and week. */
export async function pendingApprovals(ctx: RecordCtx) {
  const managed = await managedProjectIds(ctx);
  if (managed !== 'all' && !managed.length) return [];
  return ctx.tx.query(
    `select e.id, e.user_id, u.full_name, e.project_id, p.name as project, e.task_id, t.name as task, e.work_date, e.minutes, e.notes, e.billable, e.timesheet_id, s.week_start
       from time_entries e join users u on u.tenant_id = e.tenant_id and u.id = e.user_id join projects p on p.tenant_id = e.tenant_id and p.id = e.project_id
       left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id left join timesheets s on s.tenant_id = e.tenant_id and s.id = e.timesheet_id
      where e.tenant_id = $1 and e.status = 'submitted' and e.user_id <> $2 and ($3::uuid[] is null or e.project_id = any($3::uuid[]))
      order by u.full_name, e.work_date limit 3000`,
    [ctx.tenantId, ctx.principal.user.id, managed === 'all' ? null : managed],
  );
}

export async function decideTime(ctx: RecordCtx, entryIds: string[], decision: 'approve' | 'reject', reason?: string | null) {
  if (decision === 'reject' && !reason?.trim()) throw badRequest('Say why the time is rejected');
  const managed = await managedProjectIds(ctx);
  const rows = await ctx.tx.query<{ id: string; user_id: string; project_id: string; status: string; timesheet_id: string | null; entered_by: string | null }>(
    `select id, user_id, project_id, status, timesheet_id, entered_by from time_entries where tenant_id = $1 and id = any($2::uuid[]) for update`,
    [ctx.tenantId, entryIds],
  );
  if (rows.length !== new Set(entryIds).size) throw notFound('Time entry not found');
  for (const r of rows) {
    if (r.user_id === ctx.principal.user.id || (decision === 'approve' && r.entered_by === ctx.principal.user.id)) throw forbidden('You cannot approve time you logged or changed');
    if (managed !== 'all' && !managed.includes(r.project_id)) throw forbidden('Only the project manager approves this time');
    if (r.status !== 'submitted') throw badRequest('Only submitted time can be approved or rejected');
  }
  await ctx.tx.query(
    `update time_entries set status = $3, approved_by = case when $3 = 'approved' then $4::uuid end, approved_at = case when $3 = 'approved' then now() end where tenant_id = $1 and id = any($2::uuid[])`,
    [ctx.tenantId, entryIds, decision === 'approve' ? 'approved' : 'rejected', ctx.principal.user.id],
  );
  // a timesheet is approved when all its time is; rejected (back to the person) when any is
  for (const sid of new Set(rows.map((r) => r.timesheet_id).filter((x): x is string => !!x))) {
    await ctx.tx.query(
      `update timesheets s set status = case when exists (select 1 from time_entries e where e.tenant_id = s.tenant_id and e.user_id = s.user_id and e.work_date between s.week_start and s.week_start + 6 and e.status in ('rejected','draft')) then 'rejected'
                                            when not exists (select 1 from time_entries e where e.tenant_id = s.tenant_id and e.user_id = s.user_id and e.work_date between s.week_start and s.week_start + 6 and e.status = 'submitted') then 'approved' else s.status end,
              decided_by = $3, decided_at = now(), reject_reason = case when $4::text is not null then $4 else reject_reason end
        where s.tenant_id = $1 and s.id = $2`,
      [ctx.tenantId, sid, ctx.principal.user.id, decision === 'reject' ? reason!.slice(0, 1000) : null],
    );
    await ctx.tx.query(`update timesheets set reject_reason = null where tenant_id = $1 and id = $2 and status = 'approved'`, [ctx.tenantId, sid]);
  }
  for (const u of new Set(rows.map((r) => r.user_id)))
    await notify(ctx, [u], decision === 'approve' ? 'Your time was approved' : 'Some of your time was rejected', '/timesheet', decision === 'reject' ? reason ?? null : null);
  return { decided: rows.length };
}

/* ───────────────────────── billing ───────────────────────── */

export async function unbilled(ctx: RecordCtx, projectId: string, upTo = today()) {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  const time = await ctx.tx.query(
    `select e.id, e.work_date, e.minutes, e.bill_rate::float8 as bill_rate, round(e.minutes * e.bill_rate / 60.0, 2)::float8 as amount, e.notes, e.user_id, u.full_name, e.task_id, t.name as task, t.task_number
       from time_entries e join users u on u.tenant_id = e.tenant_id and u.id = e.user_id left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
      where e.tenant_id = $1 and e.project_id = $2 and e.status = 'approved' and e.billable and e.invoice_id is null and e.work_date <= $3::date order by e.work_date`,
    [ctx.tenantId, projectId, upTo],
  );
  const expenses = await ctx.tx.query(
    `select id, expense_number, name, expense_date, taxable_amount::float8 as amount from expenses
      where tenant_id = $1 and project_id = $2 and billable and invoice_id is null and status in ('approved','recorded','reimbursed') and deleted_at is null and expense_date <= $3::date order by expense_date`,
    [ctx.tenantId, projectId, upTo],
  );
  const milestones = await ctx.tx.query(
    `select id, name, due_date, status, amount::float8 as amount, accepted_on, acceptance_ref from project_milestones where tenant_id = $1 and project_id = $2 and amount > 0 and invoice_id is null order by position`,
    [ctx.tenantId, projectId],
  );
  const invoiced = await ctx.tx.one<{ v: number }>(
    `select coalesce(sum(case when doc_type = 'credit_note' then -taxable_total else taxable_total end), 0)::float8 as v from invoices where tenant_id = $1 and project_id = $2 and status not in ('draft','cancelled') and deleted_at is null`,
    [ctx.tenantId, projectId],
  );
  return { project: { id: project.id, billing_method: project.billing_method, fixed_fee: Number(project.fixed_fee ?? 0), account_id: project.account_id }, time, expenses, milestones, invoicedToDate: invoiced?.v ?? 0 };
}

/**
 * A draft GST invoice for the project's customer from chosen approved time (grouped by task, person
 * or one line), billable expenses (at cost), milestones and an optional fixed amount. The time,
 * expenses and milestones are marked as invoiced; cancelling the invoice releases them.
 */
export async function invoiceProject(
  ctx: RecordCtx,
  projectId: string,
  input: { entryIds?: string[]; expenseIds?: string[]; milestoneIds?: string[]; groupBy?: 'task' | 'person' | 'project' | 'entry'; fixedAmount?: number | null; fixedLabel?: string | null },
): Promise<{ id: string; events: RecordEvent[] }> {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  if (!objectPerm(ctx.principal.permissions, 'invoice').create) throw forbidden('You cannot create invoices');
  if (!project.account_id) throw badRequest('Set the project\'s customer first');
  const tax = Number(project.tax_rate ?? 18);
  const sac = String(project.hsn_sac ?? '998311');
  const lines: { name: string; description?: string | null; hsnSac: string; quantity: number; unitPrice: number; taxRate: number; unit?: string; isService: boolean }[] = [];
  const entryIds = [...new Set(input.entryIds ?? [])];
  const entries = entryIds.length
    ? await ctx.tx.query<{ id: string; minutes: number; bill_rate: string; full_name: string; task: string | null; task_number: number | null; work_date: string; notes: string | null }>(
        `select e.id, e.minutes, e.bill_rate, u.full_name, t.name as task, t.task_number, e.work_date, e.notes from time_entries e join users u on u.tenant_id = e.tenant_id and u.id = e.user_id
           left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
          where e.tenant_id = $1 and e.project_id = $2 and e.id = any($3::uuid[]) and e.status = 'approved' and e.billable and e.invoice_id is null for update of e`,
        [ctx.tenantId, projectId, entryIds],
      )
    : [];
  if (entries.length !== entryIds.length) throw badRequest('Some of the time is not approved, not billable or already invoiced');
  const groups = new Map<string, { name: string; minutes: number; amount: number }>();
  for (const e of entries) {
    const key = input.groupBy === 'person' ? e.full_name : input.groupBy === 'project' ? project.name : input.groupBy === 'entry' ? e.id : e.task ? `#${e.task_number} ${e.task}` : 'General work';
    const name = input.groupBy === 'entry' ? `${d10(e.work_date)} · ${e.full_name}${e.task ? ` · ${e.task}` : ''}${e.notes ? ` — ${e.notes}` : ''}` : key;
    const g = groups.get(key) ?? { name, minutes: 0, amount: 0 };
    g.minutes += e.minutes;
    g.amount = r2(g.amount + (e.minutes * Number(e.bill_rate)) / 60);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const hours = r2(g.minutes / 60);
    if (!hours) continue;
    lines.push({ name: g.name.slice(0, 300), hsnSac: sac, quantity: hours, unitPrice: r2(g.amount / hours), taxRate: tax, unit: 'Hrs', isService: true });
  }
  const expenseIds = [...new Set(input.expenseIds ?? [])];
  const exps = expenseIds.length
    ? await ctx.tx.query<{ id: string; name: string; taxable_amount: string; expense_number: string | null }>(
        `select id, name, taxable_amount, expense_number from expenses where tenant_id = $1 and project_id = $2 and id = any($3::uuid[]) and billable and invoice_id is null and status in ('approved','recorded','reimbursed') and deleted_at is null for update`,
        [ctx.tenantId, projectId, expenseIds],
      )
    : [];
  if (exps.length !== expenseIds.length) throw badRequest('Some expenses are not billable, not approved or already invoiced');
  for (const x of exps) lines.push({ name: `Expense: ${x.name}`.slice(0, 300), description: x.expense_number, hsnSac: sac, quantity: 1, unitPrice: Number(x.taxable_amount), taxRate: tax, isService: true });
  const msIds = [...new Set(input.milestoneIds ?? [])];
  const ms = msIds.length
    ? await ctx.tx.query<{ id: string; name: string; amount: string; accepted_on: string | null; acceptance_ref: string | null }>(`select id, name, amount, accepted_on::text, acceptance_ref from project_milestones where tenant_id = $1 and project_id = $2 and id = any($3::uuid[]) and amount > 0 and invoice_id is null for update`, [ctx.tenantId, projectId, msIds])
    : [];
  if (ms.length !== msIds.length) throw badRequest('Some milestones have no amount or are already invoiced');
  for (const m of ms)
    lines.push({
      name: `Milestone: ${m.name}`.slice(0, 300),
      description: m.acceptance_ref || m.accepted_on ? `Accepted${m.acceptance_ref ? `: ${m.acceptance_ref}` : ''}${m.accepted_on ? ` on ${m.accepted_on.split('-').reverse().join('-')}` : ''}` : null,
      hsnSac: sac,
      quantity: 1,
      unitPrice: Number(m.amount),
      taxRate: tax,
      isService: true,
    });
  if (input.fixedAmount && input.fixedAmount > 0) lines.push({ name: (input.fixedLabel || `${project.name} — fixed fee`).slice(0, 300), hsnSac: sac, quantity: 1, unitPrice: r2(input.fixedAmount), taxRate: tax, isService: true });
  if (!lines.length) throw badRequest('Choose time, expenses, milestones or an amount to invoice');
  const r = await createRecord(ctx, 'invoice', {
    name: `${project.name}${project.project_code ? ` (${project.project_code})` : ''}`.slice(0, 200),
    account_id: project.account_id,
    currency: project.currency ?? 'INR',
  });
  const id = String(r.record.id);
  await ctx.tx.query(`update invoices set project_id = $3, customer_ref = $4, customer_ref_date = $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, projectId, project.customer_ref ?? null, project.customer_ref_date ?? null]);
  const events = [...r.events, ...(await saveInvoiceLines(ctx, id, lines.map((l) => ({ ...l, discountPct: 0 })) as never))];
  await ctx.tx.query(`update invoice_lines set project_id = $3 where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id, projectId]);
  if (entries.length) await ctx.tx.query(`update time_entries set status = 'invoiced', invoice_id = $3 where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, entries.map((e) => e.id), id]);
  if (exps.length) await ctx.tx.query(`update expenses set invoice_id = $3 where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, exps.map((e) => e.id), id]);
  if (ms.length) await ctx.tx.query(`update project_milestones set invoice_id = $3 where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, ms.map((m) => m.id), id]);
  return { id, events };
}

export { releaseInvoice } from './project-links';

/* ───────────────────────── reports ───────────────────────── */

/** Health of one project: tasks, time, budget, money (revenue, labour and other costs, profit). */
export async function projectSummary(ctx: RecordCtx, projectId: string) {
  const { project, level } = await projectAccess(ctx, projectId);
  const tasks = await ctx.tx.query<{ status: string; n: number }>(`select status, count(*)::int as n from project_tasks where tenant_id = $1 and project_id = $2 group by status`, [ctx.tenantId, projectId]);
  const overdue = await ctx.tx.one<{ n: number }>(`select count(*)::int as n from project_tasks where tenant_id = $1 and project_id = $2 and status not in ('done','cancelled') and due_date < current_date`, [ctx.tenantId, projectId]);
  const issues = await ctx.tx.one<{ open: number; critical: number }>(
    `select count(*) filter (where status not in ('closed','wont_fix','fixed'))::int as open, count(*) filter (where status not in ('closed','wont_fix','fixed') and severity in ('critical','blocker'))::int as critical from project_issues where tenant_id = $1 and project_id = $2`,
    [ctx.tenantId, projectId],
  );
  const time = await ctx.tx.one<{ hours: number; billable_hours: number; approved_hours: number; labour_cost: number; unbilled_amount: number; billable_value: number }>(
    `select coalesce(sum(minutes), 0)::float8 / 60 as hours, coalesce(sum(minutes) filter (where billable), 0)::float8 / 60 as billable_hours,
            coalesce(sum(minutes) filter (where status in ('approved','invoiced')), 0)::float8 / 60 as approved_hours,
            coalesce(sum(round(minutes * cost_rate / 60.0, 2)) filter (where status in ('approved','invoiced')), 0)::float8 as labour_cost,
            coalesce(sum(round(minutes * bill_rate / 60.0, 2)) filter (where status = 'approved' and billable and invoice_id is null), 0)::float8 as unbilled_amount,
            coalesce(sum(round(minutes * bill_rate / 60.0, 2)) filter (where billable and status in ('approved','invoiced')), 0)::float8 as billable_value
       from time_entries where tenant_id = $1 and project_id = $2`,
    [ctx.tenantId, projectId],
  );
  const est = await ctx.tx.one<{ v: number }>(`select coalesce(sum(estimate_hours), 0)::float8 as v from project_tasks where tenant_id = $1 and project_id = $2 and parent_id is null and status <> 'cancelled'`, [ctx.tenantId, projectId]);
  const revenue = await ctx.tx.one<{ v: number }>(
    `select coalesce(sum(case when doc_type = 'credit_note' then -taxable_total else taxable_total end * exchange_rate), 0)::float8 as v from invoices where tenant_id = $1 and project_id = $2 and status not in ('draft','cancelled') and deleted_at is null`,
    [ctx.tenantId, projectId],
  );
  const otherCosts = await ctx.tx.one<{ expenses: number; bills: number }>(
    `select (select coalesce(sum(taxable_amount * exchange_rate), 0) from expenses where tenant_id = $1 and project_id = $2 and status in ('approved','recorded','reimbursed') and deleted_at is null)::float8 as expenses,
            (select coalesce(sum(case when b.doc_type = 'vendor_credit' then -l.line_subtotal else l.line_subtotal end * b.exchange_rate), 0) from bill_lines l join bills b on b.tenant_id = l.tenant_id and b.id = l.order_id
              where l.tenant_id = $1 and l.project_id = $2 and b.status not in ('draft','void') and b.deleted_at is null)::float8 as bills`,
    [ctx.tenantId, projectId],
  );
  const weekly = await ctx.tx.query(
    `select to_char(date_trunc('week', work_date), 'YYYY-MM-DD') as week, (sum(minutes)::float8 / 60) as hours, (sum(minutes) filter (where billable))::float8 / 60 as billable
       from time_entries where tenant_id = $1 and project_id = $2 and work_date >= current_date - 7 * 12 group by 1 order by 1`,
    [ctx.tenantId, projectId],
  );
  const cost = r2(time!.labour_cost + otherCosts!.expenses + otherCosts!.bills);
  const budget =
    project.budget_type === 'hours' ? { type: 'hours', planned: Number(project.budget_hours ?? 0), used: r2(time!.hours) }
    : project.budget_type === 'cost' ? { type: 'cost', planned: Number(project.budget_amount ?? 0), used: cost }
    : project.budget_type === 'revenue' ? { type: 'revenue', planned: Number(project.budget_amount ?? 0), used: r2(revenue!.v + time!.unbilled_amount) }
    : null;
  const money = level === 'manage' ? { revenue: r2(revenue!.v), unbilled: r2(time!.unbilled_amount), labourCost: r2(time!.labour_cost), expenses: r2(otherCosts!.expenses), bills: r2(otherCosts!.bills), cost, profit: r2(revenue!.v - cost), margin: revenue!.v ? r2(((revenue!.v - cost) / revenue!.v) * 100) : null } : null;
  // cost and revenue budgets reveal money: only managers see them
  const showBudget = budget && (level === 'manage' || budget.type === 'hours');
  return {
    progress: Number(project.progress),
    tasks: Object.fromEntries(tasks.map((t) => [t.status, t.n])),
    overdueTasks: overdue?.n ?? 0,
    issues,
    hours: { logged: r2(time!.hours), billable: r2(time!.billable_hours), approved: r2(time!.approved_hours), estimated: r2(est?.v ?? 0) },
    budget: showBudget && budget ? { ...budget, pct: budget.planned ? r2((budget.used / budget.planned) * 100) : null } : null,
    money,
    weekly,
    schedule: project.end_date ? { endDate: d10(project.end_date), daysLeft: dayDiff(today(), d10(project.end_date)) } : null,
  };
}

/** Hours by person, project or task over a range, for the time the viewer may see. */
export async function timeReport(ctx: RecordCtx, q: { from: string; to: string; groupBy: 'person' | 'project' | 'task' | 'day'; projectId?: string | null; userId?: string | null }) {
  const managed = await managedProjectIds(ctx);
  const me = ctx.principal.user.id;
  const key = { person: `u.full_name`, project: `p.name`, task: `coalesce('#' || t.task_number || ' ' || t.name, '(no task)')`, day: `to_char(e.work_date, 'YYYY-MM-DD')` }[q.groupBy];
  return ctx.tx.query(
    `select ${key} as label, (sum(e.minutes)::float8 / 60) as hours, (coalesce(sum(e.minutes) filter (where e.billable), 0)::float8 / 60) as billable_hours,
            case when bool_and($6::boolean or e.project_id = any($8::uuid[])) then coalesce(sum(round(e.minutes * e.bill_rate / 60.0, 2)) filter (where e.billable), 0)::float8 end as billable_value,
            case when bool_and($6::boolean or e.project_id = any($8::uuid[])) then coalesce(sum(round(e.minutes * e.cost_rate / 60.0, 2)), 0)::float8 end as cost,
            count(*) filter (where e.status = 'submitted')::int as awaiting_approval
       from time_entries e join users u on u.tenant_id = e.tenant_id and u.id = e.user_id join projects p on p.tenant_id = e.tenant_id and p.id = e.project_id
       left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
      where e.tenant_id = $1 and e.work_date between $2::date and $3::date and ($4::uuid is null or e.project_id = $4) and ($5::uuid is null or e.user_id = $5)
        and ($6::boolean or e.user_id = $7 or e.project_id = any($8::uuid[]))
      group by 1 order by 2 desc limit 1000`,
    [ctx.tenantId, q.from, q.to, q.projectId ?? null, q.userId ?? null, managed === 'all', me, managed === 'all' ? [] : managed],
  );
}

/** Every time entry on one project in a date range: managers see everyone's, others their own. */
export async function projectTimeEntries(ctx: RecordCtx, projectId: string, q: { from: string; to: string; userId?: string | null }) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const me = ctx.principal.user.id;
  const rows = await ctx.tx.query<Record<string, any>>(
    `select e.id, e.work_date, e.minutes, e.notes, e.billable, e.status, e.user_id, u.full_name as person, e.task_id, e.issue_id,
            case when t.id is not null then '#' || t.task_number || ' ' || t.name end as task, e.timer_started_at, e.created_at
       from time_entries e join users u on u.tenant_id = e.tenant_id and u.id = e.user_id
       left join project_tasks t on t.tenant_id = e.tenant_id and t.id = e.task_id
      where e.tenant_id = $1 and e.project_id = $2 and e.work_date between $3::date and $4::date and ($5::uuid is null or e.user_id = $5) and ($6::boolean or e.user_id = $7)
      order by e.work_date desc, e.created_at desc limit 2000`,
    [ctx.tenantId, projectId, q.from, q.to, q.userId ?? null, level === 'manage', me],
  );
  return rows.map((r) => ({ ...r, work_date: d10(r.work_date), canEdit: ['draft', 'rejected'].includes(r.status) && (r.user_id === me || level === 'manage') && (level !== 'view' || r.user_id === me) }));
}

/** Logged vs available hours per person (projects admins: everyone; managers: their project members). */
export async function utilisation(ctx: RecordCtx, from: string, to: string) {
  const managed = await managedProjectIds(ctx);
  if (managed !== 'all' && !managed.length) throw forbidden('Utilisation is for project managers');
  const weeks = Math.max(1, (dayDiff(from, to) + 1) / 7);
  return ctx.tx.query(
    `with people as (
        select u.id, u.full_name from users u where u.tenant_id = $1 and u.status = 'active'
          and ($4::boolean or u.id in (select user_id from project_members where tenant_id = $1 and project_id = any($5::uuid[])) or u.id in (select owner_id from projects where tenant_id = $1 and id = any($5::uuid[])))
      )
     select p.id as user_id, p.full_name, coalesce(c.weekly_hours, 40)::float8 * $6 as capacity,
            coalesce(sum(e.minutes), 0)::float8 / 60 as logged, coalesce(sum(e.minutes) filter (where e.billable), 0)::float8 / 60 as billable,
            (select coalesce(sum(t.estimate_hours), 0)::float8 from project_tasks t where t.tenant_id = $1 and p.id = any(t.assignees) and t.status not in ('done','cancelled') and ($4::boolean or t.project_id = any($5::uuid[]))) as open_estimate
       from people p left join resource_capacity c on c.tenant_id = $1 and c.user_id = p.id
       left join time_entries e on e.tenant_id = $1 and e.user_id = p.id and e.work_date between $2::date and $3::date and ($4::boolean or e.project_id = any($5::uuid[]))
      group by p.id, p.full_name, c.weekly_hours order by p.full_name`,
    [ctx.tenantId, from, to, managed === 'all', managed === 'all' ? [] : managed, r2(weeks)],
  );
}

export async function setCapacity(ctx: RecordCtx, userId: string, weeklyHours: number) {
  if (!hasAdmin(ctx.principal.permissions, 'projects')) throw forbidden('Requires the "projects" admin permission');
  const u = await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2`, [ctx.tenantId, userId]);
  if (!u) throw notFound('User not found');
  await ctx.tx.query(`insert into resource_capacity (tenant_id, user_id, weekly_hours) values ($1,$2,$3) on conflict (tenant_id, user_id) do update set weekly_hours = excluded.weekly_hours`, [ctx.tenantId, userId, weeklyHours]);
}

/** Open tasks assigned to me across projects (my work). */
export async function myTasks(ctx: RecordCtx) {
  return ctx.tx.query(
    `select t.id, t.project_id, t.task_number, t.name, t.status, t.priority, t.start_date, t.due_date, t.estimate_hours::float8 as estimate_hours, t.progress, p.name as project
       from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
      where t.tenant_id = $1 and $2 = any(t.assignees) and t.status not in ('done','cancelled') and p.deleted_at is null and p.status in ('active','planning','on_hold')
        and (p.owner_id = $2 or exists (select 1 from project_members m where m.tenant_id = t.tenant_id and m.project_id = t.project_id and m.user_id = $2 and m.role <> 'viewer'))
      order by t.due_date nulls last, array_position(array['urgent','high','medium','low','none'], t.priority) limit 500`,
    [ctx.tenantId, ctx.principal.user.id],
  );
}
