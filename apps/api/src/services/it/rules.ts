/**
 * Automation rules (Jira Automation / Azure DevOps rules): WHEN something happens to a work item,
 * IF it matches a work query, THEN do things.
 *
 *   triggers:   created · state changed (from / to state or category) · field changed (priority,
 *               assignee, sprint, severity, type, points, labels, due) · commented · scheduled
 *               (daily at an hour, over the items its query finds)
 *   actions:    move to state · set a field · assign (person, reporter, component lead, round-robin,
 *               least busy) · comment · notify (assignee, reporter, watchers, manager, people) by app
 *               and email · post to Teams / Slack / Google Chat · create a child item · add watchers
 *   smart values in texts: {{key}} {{summary}} {{type}} {{state}} {{priority}} {{assignee}}
 *               {{reporter}} {{project}} {{link}} {{due}}
 *
 * Rules run inside the change's transaction (their effects land with it). A rule's own changes can
 * fire other rules, three levels deep at most. Each rule runs in a savepoint: a failing rule is logged
 * and switched off after repeated errors, never undoing the person's change.
 */
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { projectAccess } from '../projects';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { currentState, pickWorkflow, projectWorkflows, statusOf, WORK_TYPES, type WorkType } from '../work-types';
import { queueChat, workNotify } from './alerts';
import { compileWql } from './wql';

export type Trigger = 'created' | 'state_changed' | 'field_changed' | 'commented' | 'scheduled';
export interface TriggerConfig {
  types?: string[];
  fromState?: string | null;
  toState?: string | null;
  toCategory?: string | null;
  field?: string | null;
  to?: string | null;
  hour?: number | null;
}
export type Action =
  | { type: 'transition'; to: string }
  | { type: 'set'; field: 'priority' | 'severity' | 'points' | 'sprint' | 'release' | 'due_in_days' | 'add_label' | 'remove_label' | 'add_component' | 'type'; value: string | number | null }
  | { type: 'assign'; mode: 'user' | 'reporter' | 'component_lead' | 'round_robin' | 'least_busy' | 'unassign'; userId?: string | null }
  | { type: 'comment'; body: string }
  | { type: 'notify'; to: ('assignee' | 'reporter' | 'watchers' | 'manager')[]; userIds?: string[]; title?: string | null; body?: string | null }
  | { type: 'chat'; integrationId: string; message: string }
  | { type: 'create_child'; workType: WorkType; name: string; assignToParent?: boolean }
  | { type: 'watch'; userIds: string[] };

export interface RuleInput {
  name: string;
  enabled?: boolean;
  trigger: Trigger;
  triggerConfig: TriggerConfig;
  condition?: string | null;
  actions: Action[];
}

export interface WorkEvent {
  kind: Trigger;
  fromState?: string | null;
  toState?: string | null;
  toCategory?: string | null;
  field?: string | null;
  to?: string | null;
}

/* ───────────────────────── CRUD ───────────────────────── */

export async function listRules(ctx: RecordCtx, projectId: string) {
  const { level } = await projectAccess(ctx, projectId, 'view');
  const rules = await ctx.tx.query(
    `select r.id, r.name, r.enabled, r.trigger, r.trigger_config, r.condition, r.actions, r.run_count, r.last_run_at, r.last_error, r.updated_at, u.full_name as created_by_name
       from pm_rules r left join users u on u.tenant_id = r.tenant_id and u.id = r.created_by where r.tenant_id = $1 and r.project_id = $2 order by r.created_at`,
    [ctx.tenantId, projectId],
  );
  const runs = await ctx.tx.query(
    `select x.id, x.rule_id, x.status, x.detail, x.at, t.task_number, p.work_key from pm_rule_runs x join pm_rules r on r.tenant_id = x.tenant_id and r.id = x.rule_id
       left join project_tasks t on t.tenant_id = x.tenant_id and t.id = x.task_id left join projects p on p.tenant_id = r.tenant_id and p.id = r.project_id
      where x.tenant_id = $1 and r.project_id = $2 and x.status <> 'no_match' order by x.at desc limit 50`,
    [ctx.tenantId, projectId],
  );
  return { rules, runs, canEdit: level === 'manage' };
}

async function validate(ctx: RecordCtx, projectId: string, r: RuleInput) {
  if (r.condition?.trim()) compileWql(r.condition, await (await import('./work')).wqlContext(ctx, [projectId]), [ctx.tenantId, [projectId]]);
  if (r.trigger === 'scheduled' && !r.condition?.trim()) throw badRequest('A scheduled rule needs a query for the items it works on');
  if (!r.actions.length) throw badRequest('Add at least one action');
  const states = new Set((await projectWorkflows(ctx.tx, ctx.tenantId, projectId)).flatMap((w) => w.states.map((s) => s.key)));
  const defaults = ['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled'];
  for (const a of r.actions) {
    if (a.type === 'transition' && !states.has(a.to) && !defaults.includes(a.to)) throw badRequest(`No state ${a.to} in this project's workflows`);
    if (a.type === 'chat' && !(await ctx.tx.one(`select 1 from integrations where tenant_id = $1 and id = $2 and provider in ('teams','slack','gchat')`, [ctx.tenantId, a.integrationId]))) throw badRequest('Choose a Teams, Slack or Google Chat connection');
    if (a.type === 'create_child' && !WORK_TYPES.includes(a.workType)) throw badRequest('Unknown item type');
  }
}

export async function saveRule(ctx: RecordCtx, projectId: string, id: string | null, r: RuleInput) {
  await projectAccess(ctx, projectId, 'manage');
  await validate(ctx, projectId, r);
  const vals = [r.name, r.enabled ?? true, r.trigger, JSON.stringify(r.triggerConfig ?? {}), r.condition?.trim() || null, JSON.stringify(r.actions)];
  if (id) {
    const x = await ctx.tx.one(
      `update pm_rules set name = $4, enabled = $5, trigger = $6, trigger_config = $7, condition = $8, actions = $9, last_error = null, updated_at = now() where tenant_id = $1 and id = $2 and project_id = $3 returning id`,
      [ctx.tenantId, id, projectId, ...vals],
    );
    if (!x) throw notFound('Rule not found');
    return { id };
  }
  const x = await ctx.tx.one<{ id: string }>(`insert into pm_rules (tenant_id, project_id, name, enabled, trigger, trigger_config, condition, actions) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [ctx.tenantId, projectId, ...vals]);
  return { id: x!.id };
}

export async function deleteRule(ctx: RecordCtx, projectId: string, id: string) {
  await projectAccess(ctx, projectId, 'manage');
  await ctx.tx.query(`delete from pm_rules where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, id, projectId]);
  return { ok: true };
}

/* ───────────────────────── running ───────────────────────── */

// how deep rule-made changes are firing rules, per transaction
const depth = new WeakMap<object, number>();

function matchesTrigger(rule: { trigger: Trigger; trigger_config: TriggerConfig }, ev: WorkEvent, type: string) {
  const c = rule.trigger_config ?? {};
  if (rule.trigger !== ev.kind) return false;
  if (c.types?.length && !c.types.includes(type)) return false;
  if (ev.kind === 'state_changed') {
    if (c.toState && c.toState !== ev.toState) return false;
    if (c.fromState && c.fromState !== ev.fromState) return false;
    if (c.toCategory && c.toCategory !== ev.toCategory) return false;
  }
  if (ev.kind === 'field_changed') {
    if (c.field && c.field !== ev.field) return false;
    if (c.to && String(c.to).toLowerCase() !== String(ev.to ?? '').toLowerCase()) return false;
  }
  return true;
}

/** Called by work.ts after a change to an item: runs the project's matching rules. */
export async function fireRules(ctx: RecordCtx, projectId: string, taskId: string, ev: WorkEvent) {
  const d = depth.get(ctx.tx) ?? 0;
  if (d >= 3) return;
  const rules = await ctx.tx.query<{ id: string; name: string; trigger: Trigger; trigger_config: TriggerConfig; condition: string | null; actions: Action[] }>(
    `select id, name, trigger, trigger_config, condition, actions from pm_rules where tenant_id = $1 and project_id = $2 and enabled and trigger = $3 order by created_at`,
    [ctx.tenantId, projectId, ev.kind],
  );
  if (!rules.length) return;
  const t = await ctx.tx.one<{ work_type: string }>(`select work_type from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]);
  if (!t) return;
  for (const r of rules) {
    if (!matchesTrigger(r, ev, t.work_type)) continue;
    await runRule(ctx, projectId, r, taskId);
  }
}

async function runRule(ctx: RecordCtx, projectId: string, r: { id: string; name: string; condition: string | null; actions: Action[] }, taskId: string) {
  const d = depth.get(ctx.tx) ?? 0;
  await ctx.tx.query('savepoint pm_rule');
  depth.set(ctx.tx, d + 1);
  try {
    if (r.condition?.trim()) {
      const { runQuery } = await import('./work');
      const key = await keyOf(ctx.tx, ctx.tenantId, taskId);
      const hit = await runQuery(ctx, { projectId, query: r.condition, extra: `key = ${key}`, limit: 1 });
      if (!hit.total) {
        await ctx.tx.query('release savepoint pm_rule');
        return false;
      }
    }
    const done: string[] = [];
    for (const a of r.actions) done.push(await act(ctx, projectId, taskId, a, r.name));
    await ctx.tx.query('release savepoint pm_rule');
    await ctx.tx.query(`update pm_rules set run_count = run_count + 1, last_run_at = now(), last_error = null where tenant_id = $1 and id = $2`, [ctx.tenantId, r.id]);
    await ctx.tx.query(`insert into pm_rule_runs (tenant_id, rule_id, task_id, status, detail) values ($1,$2,$3,'done',$4)`, [ctx.tenantId, r.id, taskId, done.join(' · ').slice(0, 1000)]);
    return true;
  } catch (e) {
    await ctx.tx.query('rollback to savepoint pm_rule');
    const msg = (e as Error).message.slice(0, 500);
    // five errors in a row switch the rule off
    await ctx.tx.query(
      `update pm_rules set last_error = $3, last_run_at = now(), enabled = enabled and (select count(*) from (select status from pm_rule_runs where tenant_id = $1 and rule_id = $2 order by at desc limit 4) x where x.status = 'error') < 4 where tenant_id = $1 and id = $2`,
      [ctx.tenantId, r.id, msg],
    );
    await ctx.tx.query(`insert into pm_rule_runs (tenant_id, rule_id, task_id, status, detail) values ($1,$2,$3,'error',$4)`, [ctx.tenantId, r.id, taskId, msg]);
    return false;
  } finally {
    depth.set(ctx.tx, d);
  }
}

async function keyOf(tx: Tx, tenantId: string, taskId: string) {
  const r = await tx.one<{ k: string }>(`select coalesce(p.work_key, 'X') || '-' || t.task_number as k from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and t.id = $2`, [tenantId, taskId]);
  return r!.k;
}

/** {{key}} {{summary}} … filled from the item. */
async function smart(ctx: RecordCtx, projectId: string, taskId: string, text: string) {
  if (!text.includes('{{')) return text;
  const t = await ctx.tx.one<Record<string, any>>(
    `select t.*, p.work_key, p.name as project_name,
            (select string_agg(u.full_name, ', ') from users u where u.tenant_id = t.tenant_id and u.id = any(t.assignees)) as assignee_names,
            (select full_name from users u where u.tenant_id = t.tenant_id and u.id = t.reporter_id) as reporter_name
       from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id where t.tenant_id = $1 and t.id = $2`,
    [ctx.tenantId, taskId],
  );
  const wf = pickWorkflow(await projectWorkflows(ctx.tx, ctx.tenantId, projectId), t!.work_type);
  const v: Record<string, string> = {
    key: `${t!.work_key}-${t!.task_number}`, summary: t!.name, type: t!.work_type, state: currentState(wf, t!.state, t!.status).label, priority: t!.priority,
    assignee: t!.assignee_names ?? 'Unassigned', reporter: t!.reporter_name ?? '', project: t!.project_name, link: `/projects/${projectId}?item=${taskId}`, due: t!.due_date ? String(t!.due_date).slice(0, 10) : '',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => v[k] ?? m);
}

async function act(ctx: RecordCtx, projectId: string, taskId: string, a: Action, ruleName: string): Promise<string> {
  const w = await import('./work');
  const t = (await ctx.tx.one<Record<string, any>>(`select * from project_tasks where tenant_id = $1 and id = $2`, [ctx.tenantId, taskId]))!;
  switch (a.type) {
    case 'transition': {
      const wf = pickWorkflow(await projectWorkflows(ctx.tx, ctx.tenantId, projectId), t.work_type);
      const target = wf.states.find((s) => s.key === a.to) ?? wf.states.find((s) => statusOf(s.category) === a.to);
      if (!target) return `no state ${a.to} for a ${t.work_type}`;
      if (currentState(wf, t.state, t.status).key === target.key) return `already ${target.label}`;
      await w.transition(ctx, projectId, taskId, { to: target.key }, { system: true });
      return `moved to ${target.label}`;
    }
    case 'set': {
      const patch: Record<string, unknown> = {};
      if (a.field === 'priority') patch.priority = a.value;
      else if (a.field === 'severity') patch.severity = a.value || null;
      else if (a.field === 'points') patch.storyPoints = a.value === null || a.value === '' ? null : Number(a.value);
      else if (a.field === 'type') patch.workType = a.value;
      else if (a.field === 'sprint') {
        patch.sprintId =
          a.value === 'active'
            ? ((await ctx.tx.one<{ id: string }>(`select id from project_sprints where tenant_id = $1 and project_id = $2 and status = 'active'`, [ctx.tenantId, projectId]))?.id ?? null)
            : a.value === 'next'
              ? ((await ctx.tx.one<{ id: string }>(`select id from project_sprints where tenant_id = $1 and project_id = $2 and status = 'planned' order by start_date limit 1`, [ctx.tenantId, projectId]))?.id ?? null)
              : a.value || null;
        if (a.value && !patch.sprintId) return 'no such sprint';
      } else if (a.field === 'release') patch.releaseId = a.value || null;
      else if (a.field === 'due_in_days') patch.dueDate = new Date(Date.now() + Number(a.value ?? 0) * 86_400_000).toISOString().slice(0, 10);
      else if (a.field === 'add_label') patch.tags = [...new Set([...t.tags, String(a.value).toLowerCase()])].slice(0, 20);
      else if (a.field === 'remove_label') patch.tags = (t.tags as string[]).filter((x) => x !== String(a.value).toLowerCase());
      else if (a.field === 'add_component') {
        const c = await ctx.tx.one<{ id: string }>(`select id from project_components where tenant_id = $1 and project_id = $2 and (id::text = $3 or lower(name) = lower($3))`, [ctx.tenantId, projectId, String(a.value)]);
        if (!c) return `no component ${a.value}`;
        patch.componentIds = [...new Set([...t.component_ids, c.id])];
      }
      await w.updateItem(ctx, projectId, taskId, patch);
      return `set ${a.field.replace(/_/g, ' ')}`;
    }
    case 'assign': {
      let who: string | null = null;
      if (a.mode === 'unassign') {
        await w.updateItem(ctx, projectId, taskId, { assignees: [] });
        return 'unassigned';
      }
      if (a.mode === 'user') who = a.userId ?? null;
      else if (a.mode === 'reporter') who = t.reporter_id;
      else if (a.mode === 'component_lead')
        who = (await ctx.tx.one<{ lead_id: string }>(`select lead_id from project_components where tenant_id = $1 and id = any($2::uuid[]) and lead_id is not null order by name limit 1`, [ctx.tenantId, t.component_ids]))?.lead_id ?? null;
      else {
        const team = await ctx.tx.query<{ user_id: string; open: number; last: Date | null }>(
          `select m.user_id,
                  (select count(*)::int from project_tasks x where x.tenant_id = m.tenant_id and x.project_id = m.project_id and m.user_id = any(x.assignees) and x.status not in ('done','cancelled')) as open,
                  (select max(h.at) from project_task_history h where h.tenant_id = m.tenant_id and h.project_id = m.project_id and h.field = 'assignees' and h.new_value like '%' || m.user_id::text || '%') as last
             from project_members m join users u on u.tenant_id = m.tenant_id and u.id = m.user_id where m.tenant_id = $1 and m.project_id = $2 and m.role <> 'viewer' and u.status = 'active' order by m.user_id`,
          [ctx.tenantId, projectId],
        );
        if (!team.length) return 'no team members to assign';
        who = a.mode === 'least_busy' ? [...team].sort((x, y) => x.open - y.open)[0]!.user_id : [...team].sort((x, y) => (x.last ? new Date(x.last).getTime() : 0) - (y.last ? new Date(y.last).getTime() : 0))[0]!.user_id;
      }
      if (!who) return 'nobody to assign';
      if (t.assignees.length === 1 && t.assignees[0] === who) return 'already assigned';
      await w.updateItem(ctx, projectId, taskId, { assignees: [who] });
      return 'assigned';
    }
    case 'comment': {
      const body = await smart(ctx, projectId, taskId, a.body);
      await w.comment(ctx, projectId, taskId, `🤖 ${ruleName}: ${body}`);
      return 'commented';
    }
    case 'notify': {
      const to = new Set<string>(a.userIds ?? []);
      if (a.to.includes('assignee')) for (const u of t.assignees) to.add(u);
      if (a.to.includes('reporter') && t.reporter_id) to.add(t.reporter_id);
      if (a.to.includes('watchers')) for (const x of await ctx.tx.query<{ user_id: string }>(`select user_id from project_task_watchers where tenant_id = $1 and task_id = $2`, [ctx.tenantId, taskId])) to.add(x.user_id);
      if (a.to.includes('manager')) {
        const p = await ctx.tx.one<{ owner_id: string | null }>(`select owner_id from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]);
        if (p?.owner_id) to.add(p.owner_id);
      }
      const title = await smart(ctx, projectId, taskId, a.title?.trim() || '{{key}} {{summary}}');
      const body = a.body ? await smart(ctx, projectId, taskId, a.body) : `Rule: ${ruleName}`;
      await workNotify(ctx, [...to], 'rule', { title, body, link: `/projects/${projectId}?item=${taskId}` }, { includeSelf: true });
      return `notified ${to.size}`;
    }
    case 'chat': {
      await queueChat(ctx.tx, ctx.tenantId, a.integrationId, { title: await smart(ctx, projectId, taskId, '{{key}} {{summary}}'), body: await smart(ctx, projectId, taskId, a.message), link: `/projects/${projectId}?item=${taskId}` });
      return 'posted to chat';
    }
    case 'create_child': {
      const name = (await smart(ctx, projectId, taskId, a.name)).slice(0, 300);
      const kid = await w.createItem(ctx, projectId, { name, workType: a.workType, parentId: taskId, assignees: a.assignToParent ? t.assignees : [] }, { skipRequired: true });
      return `created ${kid.key}`;
    }
    case 'watch':
      await w.watch(ctx.tx, ctx.tenantId, taskId, a.userIds);
      return 'watchers added';
  }
}

/** Runs a rule now (from the editor) on one item, or on what a scheduled rule's query finds. */
export async function runNow(ctx: RecordCtx, projectId: string, ruleId: string, taskId?: string | null) {
  await projectAccess(ctx, projectId, 'manage');
  const r = await ctx.tx.one<{ id: string; name: string; trigger: Trigger; condition: string | null; actions: Action[] }>(`select id, name, trigger, condition, actions from pm_rules where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, ruleId, projectId]);
  if (!r) throw notFound('Rule not found');
  if (taskId) return { ran: (await runRule(ctx, projectId, r, taskId)) ? 1 : 0 };
  if (!r.condition) throw badRequest('Pick an item to run the rule on');
  const { runQuery } = await import('./work');
  const items = await runQuery(ctx, { projectId, query: r.condition, limit: 100 });
  let ran = 0;
  for (const it of items.items) if (await runRule(ctx, projectId, { ...r, condition: null }, it.id)) ran++;
  return { ran, matched: items.total };
}

/** Hourly: scheduled rules whose hour (India time) has come and that have not run today. */
export async function scheduledRulesSweep(env: Env, db: Db) {
  const istHour = new Date(Date.now() + 5.5 * 3_600_000).getUTCHours();
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  for (const t of tenants) {
    const due = await db.tx({ tenantId: t.tenant_id, readOnly: true }, (tx) =>
      tx.query<{ id: string; project_id: string }>(
        `select id, project_id from pm_rules where tenant_id = $1 and enabled and trigger = 'scheduled' and coalesce((trigger_config ->> 'hour')::int, 9) <= $2
            and (last_run_at is null or (last_run_at at time zone 'Asia/Kolkata')::date < (now() at time zone 'Asia/Kolkata')::date) limit 50`,
        [t.tenant_id, istHour],
      ),
    );
    for (const r of due)
      await db
        .tx({ tenantId: t.tenant_id }, async (tx) => {
          const ctx = await systemCtxFor(env, tx, t.tenant_id);
          if (!ctx) return;
          await tx.query(`update pm_rules set last_run_at = now() where tenant_id = $1 and id = $2`, [t.tenant_id, r.id]);
          await runNow(ctx, r.project_id, r.id, null);
        })
        .catch((e) => console.error(JSON.stringify({ level: 'error', job: 'pm-rules', tenant: t.tenant_id, msg: (e as Error).message })));
  }
}
