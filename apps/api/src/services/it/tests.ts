/**
 * Test management in a project (Azure Test Plans / Jira test-case apps): test cases with steps and
 * the work items they cover, test plans for a sprint or release, runs with per-step results, and a
 * bug raised from a failed run with the steps that failed.
 */
import type { Tx } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { projectAccess } from '../projects';
import type { RecordCtx } from '../records';
import { createItem, workKey } from './work';

export interface CaseInput {
  title: string;
  suite?: string | null;
  preconditions?: string | null;
  steps: { action: string; expected?: string | null }[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  status?: 'draft' | 'ready' | 'obsolete';
  itemIds?: string[];
  automated?: boolean;
}

async function checkItems(tx: Tx, tenantId: string, projectId: string, ids: string[]) {
  if (!ids.length) return;
  const n = await tx.one<{ n: number }>(`select count(*)::int as n from project_tasks where tenant_id = $1 and project_id = $2 and id = any($3::uuid[])`, [tenantId, projectId, [...new Set(ids)]]);
  if (n!.n !== new Set(ids).size) throw badRequest('Covered items must be in this project');
}

export async function listCases(ctx: RecordCtx, projectId: string) {
  const { project, level } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select c.id, c.case_number, c.title, c.suite, c.preconditions, c.steps, c.priority, c.status, c.item_ids, c.automated, c.updated_at,
            (select r.result from pm_test_runs r where r.tenant_id = c.tenant_id and r.case_id = c.id and r.result <> 'untested' order by r.run_at desc nulls last limit 1) as last_result,
            (select array_agg('${key}-' || t.task_number) from project_tasks t where t.tenant_id = c.tenant_id and t.id = any(c.item_ids)) as item_keys
       from pm_test_cases c where c.tenant_id = $1 and c.project_id = $2 order by coalesce(c.suite, ''), c.case_number`,
    [ctx.tenantId, projectId],
  );
  return { cases: rows.map((r) => ({ ...r, key: `TC-${r.case_number}` })), canEdit: level !== 'view' };
}

export async function saveCase(ctx: RecordCtx, projectId: string, id: string | null, c: CaseInput) {
  await projectAccess(ctx, projectId, 'member');
  await checkItems(ctx.tx, ctx.tenantId, projectId, c.itemIds ?? []);
  const steps = c.steps.filter((s) => s.action.trim()).map((s) => ({ action: s.action.trim().slice(0, 2000), expected: (s.expected ?? '').trim().slice(0, 2000) || null }));
  const vals = [c.title, c.suite ?? null, c.preconditions ?? null, JSON.stringify(steps), c.priority ?? 'medium', c.status ?? 'ready', [...new Set(c.itemIds ?? [])], c.automated ?? false];
  if (id) {
    const r = await ctx.tx.one(
      `update pm_test_cases set title = $4, suite = $5, preconditions = $6, steps = $7, priority = $8, status = $9, item_ids = $10, automated = $11, updated_at = now() where tenant_id = $1 and id = $2 and project_id = $3 returning id`,
      [ctx.tenantId, id, projectId, ...vals],
    );
    if (!r) throw notFound('Test case not found');
    return { id };
  }
  await ctx.tx.query(`select 1 from projects where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, projectId]);
  const r = await ctx.tx.one<{ id: string; case_number: number }>(
    `insert into pm_test_cases (tenant_id, project_id, case_number, title, suite, preconditions, steps, priority, status, item_ids, automated)
     values ($1,$2,(select coalesce(max(case_number), 0) + 1 from pm_test_cases where tenant_id = $1 and project_id = $2),$3,$4,$5,$6,$7,$8,$9,$10) returning id, case_number`,
    [ctx.tenantId, projectId, ...vals],
  );
  return { id: r!.id, key: `TC-${r!.case_number}` };
}

export async function deleteCase(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'member');
  const ran = await ctx.tx.one(`select 1 from pm_test_runs where tenant_id = $1 and case_id = $2 and result <> 'untested' limit 1`, [ctx.tenantId, id]);
  if (ran) {
    await ctx.tx.query(`update pm_test_cases set status = 'obsolete', updated_at = now() where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
    return { ok: true, obsolete: true };
  }
  await ctx.tx.query(`delete from pm_test_cases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  return { ok: true, obsolete: false };
}

export async function listPlans(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  return ctx.tx.query(
    `select p.id, p.name, p.status, p.sprint_id, s.name as sprint_name, p.release_id, r.name as release_name, p.created_at,
            count(x.id)::int as cases, count(x.id) filter (where x.result = 'passed')::int as passed, count(x.id) filter (where x.result = 'failed')::int as failed,
            count(x.id) filter (where x.result = 'blocked')::int as blocked, count(x.id) filter (where x.result = 'skipped')::int as skipped, count(x.id) filter (where x.result = 'untested')::int as untested
       from pm_test_plans p left join pm_test_runs x on x.tenant_id = p.tenant_id and x.plan_id = p.id
       left join project_sprints s on s.tenant_id = p.tenant_id and s.id = p.sprint_id left join project_releases r on r.tenant_id = p.tenant_id and r.id = p.release_id
      where p.tenant_id = $1 and p.project_id = $2 group by p.id, s.name, r.name order by p.created_at desc`,
    [ctx.tenantId, projectId],
  );
}

export async function savePlan(ctx: RecordCtx, projectId: string, id: string | null, p: { name: string; sprintId?: string | null; releaseId?: string | null; status?: 'planned' | 'active' | 'done'; caseIds?: string[]; suite?: string | null }) {
  await projectAccess(ctx, projectId, 'member');
  if (p.sprintId && !(await ctx.tx.one(`select 1 from project_sprints where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, p.sprintId, projectId]))) throw badRequest('Sprint not found');
  if (p.releaseId && !(await ctx.tx.one(`select 1 from project_releases where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, p.releaseId, projectId]))) throw badRequest('Release not found');
  let planId = id;
  if (id) {
    const r = await ctx.tx.one(`update pm_test_plans set name = $4, sprint_id = $5, release_id = $6, status = coalesce($7, status) where tenant_id = $1 and id = $2 and project_id = $3 returning id`, [
      ctx.tenantId, id, projectId, p.name, p.sprintId ?? null, p.releaseId ?? null, p.status ?? null,
    ]);
    if (!r) throw notFound('Test plan not found');
  } else {
    const r = await ctx.tx.one<{ id: string }>(`insert into pm_test_plans (tenant_id, project_id, name, sprint_id, release_id, status) values ($1,$2,$3,$4,$5,coalesce($6,'active')) returning id`, [
      ctx.tenantId, projectId, p.name, p.sprintId ?? null, p.releaseId ?? null, p.status ?? null,
    ]);
    planId = r!.id;
  }
  if (p.caseIds?.length || p.suite) await addCases(ctx, projectId, planId!, { caseIds: p.caseIds ?? [], suite: p.suite ?? null });
  return { id: planId };
}

/** Adds cases to a plan: given ones, a whole suite, or (with a sprint / release) the cases covering its items. */
export async function addCases(ctx: RecordCtx, projectId: string, planId: string, q: { caseIds: string[]; suite?: string | null; covering?: boolean }) {
  await projectAccess(ctx, projectId, 'member');
  const plan = await ctx.tx.one<{ sprint_id: string | null; release_id: string | null }>(`select sprint_id, release_id from pm_test_plans where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, planId, projectId]);
  if (!plan) throw notFound('Test plan not found');
  const r = await ctx.tx.query(
    `insert into pm_test_runs (tenant_id, plan_id, case_id)
     select $1, $2, c.id from pm_test_cases c where c.tenant_id = $1 and c.project_id = $3 and c.status <> 'obsolete'
        and (c.id = any($4::uuid[]) or ($5::text is not null and c.suite = $5)
             or ($6::boolean and exists (select 1 from project_tasks t where t.tenant_id = c.tenant_id and t.id = any(c.item_ids) and (t.sprint_id = $7 or t.release_id = $8))))
     on conflict (tenant_id, plan_id, case_id) do nothing returning id`,
    [ctx.tenantId, planId, projectId, q.caseIds, q.suite ?? null, !!q.covering, plan.sprint_id, plan.release_id],
  );
  return { added: r.length };
}

export async function removeCase(ctx: RecordCtx, projectId: string, planId: string, caseId: string) {
  await projectAccess(ctx, projectId, 'member');
  await ctx.tx.query(`delete from pm_test_runs r using pm_test_plans p where r.tenant_id = $1 and r.plan_id = $2 and r.case_id = $3 and p.tenant_id = r.tenant_id and p.id = r.plan_id and p.project_id = $4`, [ctx.tenantId, planId, caseId, projectId]);
  return { ok: true };
}

export async function deletePlan(ctx: RecordCtx, projectId: string, planId: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`delete from pm_test_plans where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, planId, projectId]);
  return { ok: true };
}

export async function planDetail(ctx: RecordCtx, projectId: string, planId: string) {
  const { project, level } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const plan = await ctx.tx.one(`select id, name, status, sprint_id, release_id from pm_test_plans where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, planId, projectId]);
  if (!plan) throw notFound('Test plan not found');
  const runs = await ctx.tx.query<Record<string, any>>(
    `select r.id, r.case_id, r.result, r.notes, r.step_results, r.bug_id, r.history, r.run_at, u.full_name as tester, c.case_number, c.title, c.suite, c.steps, c.preconditions, c.priority, c.item_ids,
            b.task_number as bug_number, b.status as bug_status
       from pm_test_runs r join pm_test_cases c on c.tenant_id = r.tenant_id and c.id = r.case_id
       left join users u on u.tenant_id = r.tenant_id and u.id = r.tester_id left join project_tasks b on b.tenant_id = r.tenant_id and b.id = r.bug_id
      where r.tenant_id = $1 and r.plan_id = $2 order by coalesce(c.suite, ''), c.case_number`,
    [ctx.tenantId, planId],
  );
  return { plan, canRun: level !== 'view', runs: runs.map((r) => ({ ...r, key: `TC-${r.case_number}`, bugKey: r.bug_number ? `${key}-${r.bug_number}` : null })) };
}

export async function recordRun(ctx: RecordCtx, projectId: string, planId: string, caseId: string, input: { result: 'untested' | 'passed' | 'failed' | 'blocked' | 'skipped'; notes?: string | null; stepResults?: (string | null)[]; createBug?: boolean; bugTitle?: string | null }) {
  await projectAccess(ctx, projectId, 'member');
  const run = await ctx.tx.one<Record<string, any>>(
    `select r.*, c.title, c.steps, c.preconditions, c.item_ids, c.case_number, p.sprint_id, p.release_id from pm_test_runs r join pm_test_cases c on c.tenant_id = r.tenant_id and c.id = r.case_id
       join pm_test_plans p on p.tenant_id = r.tenant_id and p.id = r.plan_id where r.tenant_id = $1 and r.plan_id = $2 and r.case_id = $3 and p.project_id = $4 for update of r`,
    [ctx.tenantId, planId, caseId, projectId],
  );
  if (!run) throw notFound('That case is not in the plan');
  const history = [...(run.history ?? []), ...(run.result !== 'untested' ? [{ result: run.result, by: run.tester_id, at: run.run_at, notes: run.notes }] : [])].slice(-30);
  let bugId: string | null = run.bug_id;
  let bugKey: string | null = null;
  if (input.result === 'failed' && input.createBug && !bugId) {
    const steps = (run.steps as { action: string; expected: string | null }[]).map((s, i) => `${i + 1}. ${s.action}${s.expected ? ` → expected: ${s.expected}` : ''}${input.stepResults?.[i] === 'failed' ? '  ✗ FAILED' : ''}`).join('\n');
    const b = await createItem(ctx, projectId, {
      name: (input.bugTitle?.trim() || `Test failed: ${run.title}`).slice(0, 300),
      workType: 'bug',
      priority: 'high',
      severity: 'major',
      description: [`Found by TC-${run.case_number} in a test run.`, run.preconditions ? `Preconditions: ${run.preconditions}` : '', `Steps:\n${steps}`, input.notes ? `Notes: ${input.notes}` : ''].filter(Boolean).join('\n\n'),
      sprintId: run.sprint_id,
      releaseId: run.release_id,
    }, { skipRequired: true });
    bugId = b.id;
    bugKey = b.key;
    for (const item of run.item_ids as string[]) await ctx.tx.query(`insert into project_task_relations (tenant_id, task_id, other_id, kind) values ($1,$2,$3,'relates') on conflict do nothing`, [ctx.tenantId, b.id, item]);
  }
  await ctx.tx.query(
    `update pm_test_runs set result = $4, notes = $5, step_results = $6, tester_id = $7, run_at = case when $4 = 'untested' then null else now() end, bug_id = $8, history = $9 where tenant_id = $1 and plan_id = $2 and case_id = $3`,
    [ctx.tenantId, planId, caseId, input.result, input.notes ?? null, JSON.stringify(input.stepResults ?? []), ctx.principal.user.id, bugId, JSON.stringify(history)],
  );
  return { ok: true, bugId, bugKey };
}

/** Requirements coverage: stories / features / bugs with their cases and last results. */
export async function coverage(ctx: RecordCtx, projectId: string) {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const key = await workKey(ctx.tx, ctx.tenantId, project);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select t.id, t.task_number, t.name, t.work_type, t.status,
            count(c.id)::int as cases,
            count(c.id) filter (where lr.result = 'passed')::int as passed, count(c.id) filter (where lr.result = 'failed')::int as failed,
            count(c.id) filter (where lr.result is null)::int as not_run
       from project_tasks t
       left join pm_test_cases c on c.tenant_id = t.tenant_id and t.id = any(c.item_ids) and c.status <> 'obsolete'
       left join lateral (select r.result from pm_test_runs r where r.tenant_id = c.tenant_id and r.case_id = c.id and r.result <> 'untested' order by r.run_at desc nulls last limit 1) lr on true
      where t.tenant_id = $1 and t.project_id = $2 and t.work_type in ('story','feature','bug') and t.status <> 'cancelled'
      group by t.id order by t.task_number`,
    [ctx.tenantId, projectId],
  );
  return rows.map((r) => ({ ...r, key: `${key}-${r.task_number}` }));
}
