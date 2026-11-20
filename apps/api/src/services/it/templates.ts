/**
 * Project templates: a project's way of working — workflows, boards, custom fields, components,
 * automation rules, dashboards, shared queries and settings — saved once and applied to new projects.
 * Built-in templates cover a Scrum software team, a Kanban support desk and bug tracking.
 * Applying merges: whatever the project already has by the same name (or type, for workflows) stays.
 */
import { badRequest, notFound } from '../../lib/errors';
import { projectAccess } from '../projects';
import type { RecordCtx } from '../records';
import type { WfState, WfTransition } from '../work-types';

export interface TemplateConfig {
  workflows: { name: string; workTypes: string[]; states: WfState[]; transitions: WfTransition[] }[];
  fields: { key: string; label: string; type: string; options: string[]; workTypes: string[]; required: boolean }[];
  components: { name: string; description?: string | null }[];
  boards: { name: string; kind: string; columns: unknown; swimlane: string; filter: string | null; quickFilters: unknown; cardFields: string[] }[];
  rules: { name: string; enabled: boolean; trigger: string; triggerConfig: unknown; condition: string | null; actions: unknown }[];
  dashboards: { name: string; widgets: unknown }[];
  queries: { name: string; query: string; columns: string[] }[];
  settings: Record<string, unknown>;
}

const scrumStates: WfState[] = [
  { key: 'backlog', label: 'Backlog', category: 'todo' },
  { key: 'ready', label: 'Ready', category: 'todo' },
  { key: 'in_progress', label: 'In progress', category: 'in_progress' },
  { key: 'code_review', label: 'Code review', category: 'review' },
  { key: 'qa', label: 'QA', category: 'review' },
  { key: 'done', label: 'Done', category: 'done' },
  { key: 'wont_do', label: "Won't do", category: 'cancelled' },
];
const bugStates: WfState[] = [
  { key: 'new', label: 'New', category: 'todo' },
  { key: 'triaged', label: 'Triaged', category: 'todo' },
  { key: 'fixing', label: 'Fixing', category: 'in_progress' },
  { key: 'verify', label: 'Ready for QA', category: 'review' },
  { key: 'closed', label: 'Closed', category: 'done' },
  { key: 'rejected', label: 'Rejected', category: 'cancelled' },
];
const bugMoves: WfTransition[] = [
  { from: 'new', to: 'triaged' },
  { from: 'new', to: 'rejected', require: ['resolution'] },
  { from: 'triaged', to: 'fixing', require: ['assignee'] },
  { from: 'fixing', to: 'verify' },
  { from: 'verify', to: 'fixing', name: 'Reopen' },
  { from: 'verify', to: 'closed', require: ['resolution'] },
  { from: 'closed', to: 'fixing', name: 'Reopen', roles: ['manager'] },
];
const columnsScrum = [
  { name: 'To do', states: ['backlog', 'ready', 'new', 'triaged'], categories: ['todo'], wip: null },
  { name: 'In progress', states: ['in_progress', 'fixing'], categories: ['in_progress', 'blocked'], wip: 5 },
  { name: 'Review', states: ['code_review'], categories: [], wip: 3 },
  { name: 'QA', states: ['qa', 'verify'], categories: ['review'], wip: 3 },
  { name: 'Done', states: ['done', 'closed'], categories: ['done'], wip: null },
];

export const BUILT_IN: { key: string; name: string; description: string; config: TemplateConfig }[] = [
  {
    key: 'scrum',
    name: 'Scrum software team',
    description: 'Backlog → Ready → In progress → Code review → QA → Done for stories and tasks, a stricter bug flow, a scrum board with WIP limits, components, a release-blocker rule and a team dashboard.',
    config: {
      workflows: [
        { name: 'Delivery', workTypes: [], states: scrumStates, transitions: [] },
        { name: 'Bugs', workTypes: ['bug'], states: bugStates, transitions: bugMoves },
      ],
      fields: [
        { key: 'acceptance', label: 'Acceptance criteria', type: 'text', options: [], workTypes: ['story', 'feature'], required: false },
        { key: 'environment', label: 'Environment', type: 'select', options: ['Production', 'Staging', 'Development'], workTypes: ['bug'], required: true },
        { key: 'customer_impact', label: 'Customer impact', type: 'select', options: ['None', 'Some', 'Many', 'All'], workTypes: ['bug'], required: false },
      ],
      components: [{ name: 'Frontend' }, { name: 'Backend' }, { name: 'Mobile' }, { name: 'Infrastructure' }],
      boards: [{ name: 'Sprint board', kind: 'scrum', columns: columnsScrum, swimlane: 'parent', filter: null, quickFilters: [{ name: 'Mine', query: 'assignee = currentUser()' }, { name: 'Bugs', query: 'type = bug' }], cardFields: ['points', 'assignee', 'priority', 'children'] }],
      rules: [
        { name: 'Critical bug in production → urgent and tell the manager', enabled: true, trigger: 'created', triggerConfig: { types: ['bug'] }, condition: 'environment = Production AND severity in (critical, blocker)', actions: [{ type: 'set', field: 'priority', value: 'urgent' }, { type: 'set', field: 'sprint', value: 'active' }, { type: 'notify', to: ['manager'], title: 'Production bug: {{key}} {{summary}}' }] },
        { name: 'All sub-tasks done → parent to QA', enabled: false, trigger: 'state_changed', triggerConfig: { types: ['subtask'], toCategory: 'done' }, condition: null, actions: [{ type: 'comment', body: 'Sub-task {{key}} is done.' }] },
        { name: 'New bug → round-robin to the team', enabled: true, trigger: 'created', triggerConfig: { types: ['bug'] }, condition: 'assignee is empty', actions: [{ type: 'assign', mode: 'round_robin' }] },
      ],
      dashboards: [
        {
          name: 'Team',
          widgets: [
            { id: 't1', type: 'count', title: 'Open in sprint', query: 'sprint in openSprints() AND status not in (done, cancelled)', size: 'small' },
            { id: 't2', type: 'count', title: 'Open bugs', query: 'type = bug AND status not in (done, cancelled)', size: 'small' },
            { id: 't3', type: 'count', title: 'Unestimated stories', query: 'type = story AND points is empty AND status != done', size: 'small' },
            { id: 't4', type: 'sprint', title: 'Sprint report', size: 'large' },
            { id: 't5', type: 'cfd', title: 'Cumulative flow', days: 30, size: 'large' },
            { id: 't6', type: 'time_in_status', title: 'Time in status', days: 60, size: 'medium' },
            { id: 't7', type: 'breakdown', title: 'Open work by person', query: 'status not in (done, cancelled)', groupBy: 'assignee', size: 'medium' },
          ],
        },
      ],
      queries: [
        { name: 'My open work', query: 'assignee = currentUser() AND status not in (done, cancelled) ORDER BY priority DESC', columns: [] },
        { name: 'Ready for QA', query: 'state in (qa, verify) ORDER BY priority DESC', columns: [] },
      ],
      settings: { estimation: 'points', autoTransitions: { branch: 'in_progress', prOpened: 'code_review', prMerged: 'qa' } },
    },
  },
  {
    key: 'kanban',
    name: 'Kanban support desk',
    description: 'A continuous-flow board (New → Working → Waiting on customer → Resolved) with WIP limits, a response-time rule and a weekly flow dashboard.',
    config: {
      workflows: [
        {
          name: 'Support',
          workTypes: [],
          states: [
            { key: 'new', label: 'New', category: 'todo' },
            { key: 'working', label: 'Working', category: 'in_progress' },
            { key: 'waiting', label: 'Waiting on customer', category: 'blocked' },
            { key: 'resolved', label: 'Resolved', category: 'done' },
            { key: 'closed_wontfix', label: "Won't fix", category: 'cancelled' },
          ],
          transitions: [],
        },
      ],
      fields: [
        { key: 'customer', label: 'Customer', type: 'text', options: [], workTypes: [], required: false },
        { key: 'channel', label: 'Channel', type: 'select', options: ['Email', 'Phone', 'Portal', 'Chat'], workTypes: [], required: false },
      ],
      components: [{ name: 'Access & login' }, { name: 'Billing' }, { name: 'Data' }],
      boards: [
        {
          name: 'Support board',
          kind: 'kanban',
          columns: [
            { name: 'New', states: ['new'], categories: ['todo'], wip: null },
            { name: 'Working', states: ['working'], categories: ['in_progress'], wip: 6 },
            { name: 'Waiting', states: ['waiting'], categories: ['blocked'], wip: null },
            { name: 'Resolved', states: ['resolved'], categories: ['done'], wip: null },
          ],
          swimlane: 'priority',
          filter: null,
          quickFilters: [{ name: 'Mine', query: 'assignee = currentUser()' }, { name: 'Urgent', query: 'priority = urgent' }],
          cardFields: ['assignee', 'priority', 'due'],
        },
      ],
      rules: [
        { name: 'New item → least busy agent, due in 2 days', enabled: true, trigger: 'created', triggerConfig: {}, condition: 'assignee is empty', actions: [{ type: 'assign', mode: 'least_busy' }, { type: 'set', field: 'due_in_days', value: 2 }] },
        { name: 'Daily: nudge on overdue items', enabled: true, trigger: 'scheduled', triggerConfig: { hour: 10 }, condition: 'due < now() AND status not in (done, cancelled)', actions: [{ type: 'notify', to: ['assignee', 'manager'], title: 'Overdue: {{key}} {{summary}}', body: 'Due {{due}}, now {{state}}.' }] },
      ],
      dashboards: [
        {
          name: 'Desk',
          widgets: [
            { id: 'k1', type: 'count', title: 'Open', query: 'status not in (done, cancelled)', size: 'small' },
            { id: 'k2', type: 'count', title: 'Overdue', query: 'due < now() AND status not in (done, cancelled)', size: 'small' },
            { id: 'k3', type: 'count', title: 'Waiting on customer', query: 'state = waiting', size: 'small' },
            { id: 'k4', type: 'cycle', title: 'Resolution time', days: 30, size: 'medium' },
            { id: 'k5', type: 'created_resolved', title: 'Created vs resolved', days: 30, size: 'medium' },
            { id: 'k6', type: 'time_in_status', title: 'Time in status', days: 30, size: 'large' },
          ],
        },
      ],
      queries: [{ name: 'Unassigned', query: 'assignee is empty AND status not in (done, cancelled) ORDER BY created ASC', columns: [] }],
      settings: { estimation: 'hours' },
    },
  },
  {
    key: 'bugs',
    name: 'Bug tracking',
    description: 'Triage → fix → verify for bugs with severity and environment, auto-assignment to the component lead, and a quality dashboard.',
    config: {
      workflows: [{ name: 'Bugs', workTypes: ['bug'], states: bugStates, transitions: bugMoves }],
      fields: [
        { key: 'environment', label: 'Environment', type: 'select', options: ['Production', 'Staging', 'Development'], workTypes: ['bug'], required: true },
        { key: 'browser', label: 'Browser / device', type: 'text', options: [], workTypes: ['bug'], required: false },
      ],
      components: [{ name: 'Web' }, { name: 'API' }, { name: 'Mobile' }],
      boards: [{ name: 'Bug board', kind: 'kanban', columns: columnsScrum, swimlane: 'priority', filter: 'type = bug', quickFilters: [{ name: 'Production', query: 'environment = Production' }], cardFields: ['assignee', 'priority', 'labels'] }],
      rules: [
        { name: 'New bug → component lead', enabled: true, trigger: 'created', triggerConfig: { types: ['bug'] }, condition: 'assignee is empty', actions: [{ type: 'assign', mode: 'component_lead' }] },
        { name: 'Reopened → tell the reporter', enabled: true, trigger: 'state_changed', triggerConfig: { types: ['bug'], fromState: 'verify', toState: 'fixing' }, condition: null, actions: [{ type: 'notify', to: ['reporter'], title: '{{key}} was reopened' }] },
      ],
      dashboards: [
        {
          name: 'Quality',
          widgets: [
            { id: 'b1', type: 'count', title: 'Open bugs', query: 'type = bug AND status not in (done, cancelled)', size: 'small' },
            { id: 'b2', type: 'count', title: 'Critical', query: 'type = bug AND severity in (critical, blocker) AND status != done', size: 'small' },
            { id: 'b3', type: 'breakdown', title: 'By component', query: 'type = bug AND status != done', groupBy: 'component', size: 'medium' },
            { id: 'b4', type: 'created_resolved', title: 'Found vs fixed', days: 60, size: 'medium' },
          ],
        },
      ],
      queries: [{ name: 'Untriaged bugs', query: 'type = bug AND state = new ORDER BY created ASC', columns: [] }],
      settings: {},
    },
  },
];

/** A project's configuration as a template. */
export async function captureConfig(ctx: RecordCtx, projectId: string): Promise<TemplateConfig> {
  const { project } = await projectAccess(ctx, projectId, 'view');
  const q = <T extends Record<string, any>>(sql: string) => ctx.tx.query<T>(sql, [ctx.tenantId, projectId]);
  return {
    workflows: (await q<{ name: string; work_types: string[]; states: WfState[]; transitions: WfTransition[] }>(`select name, work_types, states, transitions from pm_workflows where tenant_id = $1 and project_id = $2`)).map((w) => ({ name: w.name, workTypes: w.work_types, states: w.states, transitions: w.transitions })),
    fields: (await q<{ key: string; label: string; type: string; options: string[]; work_types: string[]; required: boolean }>(`select key, label, type, options, work_types, required from pm_field_defs where tenant_id = $1 and project_id = $2 order by position`)).map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, workTypes: f.work_types, required: f.required })),
    components: await q<{ name: string; description: string | null }>(`select name, description from project_components where tenant_id = $1 and project_id = $2 order by name`),
    boards: (await q<Record<string, any>>(`select name, kind, columns, swimlane, filter, quick_filters, card_fields from project_boards where tenant_id = $1 and project_id = $2 order by position`)).map((b) => ({ name: b.name, kind: b.kind, columns: b.columns, swimlane: b.swimlane, filter: b.filter, quickFilters: b.quick_filters, cardFields: b.card_fields })),
    rules: (await q<Record<string, any>>(`select name, enabled, trigger, trigger_config, condition, actions from pm_rules where tenant_id = $1 and project_id = $2 order by created_at`))
      // people-specific actions do not travel between projects
      .map((r) => ({ name: r.name, enabled: r.enabled, trigger: r.trigger, triggerConfig: r.trigger_config, condition: r.condition, actions: (r.actions as Record<string, any>[]).filter((a) => !(a.type === 'assign' && a.mode === 'user') && a.type !== 'watch' && a.type !== 'chat').map((a) => (a.type === 'notify' ? { ...a, userIds: [] } : a)) })),
    dashboards: await q<{ name: string; widgets: unknown }>(`select name, widgets from pm_dashboards where tenant_id = $1 and project_id = $2 and shared`),
    queries: await q<{ name: string; query: string; columns: string[] }>(`select name, query, columns from pm_queries where tenant_id = $1 and project_id = $2 and shared`),
    settings: { ...(project.work_settings ?? {}) },
  };
}

export async function listTemplates(ctx: RecordCtx) {
  const mine = await ctx.tx.query<{ id: string; name: string; description: string | null; created_at: string; config: TemplateConfig; created_by_name: string | null }>(
    `select t.id, t.name, t.description, t.created_at, t.config, u.full_name as created_by_name from pm_templates t left join users u on u.tenant_id = t.tenant_id and u.id = t.created_by where t.tenant_id = $1 order by t.name`,
    [ctx.tenantId],
  );
  const sum = (c: TemplateConfig) => ({ workflows: c.workflows.length, boards: c.boards.length, fields: c.fields.length, components: c.components.length, rules: c.rules.length, dashboards: c.dashboards.length, queries: c.queries.length });
  return [
    ...BUILT_IN.map((b) => ({ id: `builtin:${b.key}`, name: b.name, description: b.description, builtIn: true, summary: sum(b.config) })),
    ...mine.map((m) => ({ id: m.id, name: m.name, description: m.description, builtIn: false, createdBy: m.created_by_name, createdAt: m.created_at, summary: sum(m.config) })),
  ];
}

export async function saveAsTemplate(ctx: RecordCtx, projectId: string, input: { name: string; description?: string | null }) {
  await projectAccess(ctx, projectId, 'manage');
  const config = await captureConfig(ctx, projectId);
  if (await ctx.tx.one(`select 1 from pm_templates where tenant_id = $1 and lower(name) = lower($2)`, [ctx.tenantId, input.name])) throw badRequest(`A template “${input.name}” exists`);
  const r = await ctx.tx.one<{ id: string }>(`insert into pm_templates (tenant_id, name, description, config) values ($1,$2,$3,$4) returning id`, [ctx.tenantId, input.name, input.description ?? null, JSON.stringify(config)]);
  return { id: r!.id };
}

export async function deleteTemplate(ctx: RecordCtx, id: string) {
  const r = await ctx.tx.one(`delete from pm_templates where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound('Template not found');
  return { ok: true };
}

/** Applies a template to a project, keeping what the project already has. */
export async function applyTemplate(ctx: RecordCtx, projectId: string, templateId: string) {
  await projectAccess(ctx, projectId, 'manage');
  let config: TemplateConfig;
  if (templateId.startsWith('builtin:')) {
    const b = BUILT_IN.find((x) => `builtin:${x.key}` === templateId);
    if (!b) throw notFound('Template not found');
    config = b.config;
  } else {
    const t = await ctx.tx.one<{ config: TemplateConfig }>(`select config from pm_templates where tenant_id = $1 and id = $2`, [ctx.tenantId, templateId]);
    if (!t) throw notFound('Template not found');
    config = t.config;
  }
  const w = await import('./work');
  const { saveRule } = await import('./rules');
  const out = { workflows: 0, fields: 0, components: 0, boards: 0, rules: 0, dashboards: 0, queries: 0, skipped: [] as string[] };
  const existingWf = await ctx.tx.query<{ name: string; work_types: string[] }>(`select name, work_types from pm_workflows where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]);
  for (const wf of config.workflows) {
    const clash = existingWf.some((e) => e.name === wf.name || (wf.workTypes.length ? wf.workTypes.some((t) => e.work_types.includes(t)) : !e.work_types.length));
    if (clash) {
      out.skipped.push(`workflow ${wf.name}`);
      continue;
    }
    await w.saveWorkflow(ctx, projectId, null, wf as never);
    out.workflows++;
  }
  for (const f of config.fields) {
    if (await ctx.tx.one(`select 1 from pm_field_defs where tenant_id = $1 and project_id = $2 and key = $3`, [ctx.tenantId, projectId, f.key])) {
      out.skipped.push(`field ${f.label}`);
      continue;
    }
    await w.saveField(ctx, projectId, null, { ...f, type: f.type as never });
    out.fields++;
  }
  for (const c of config.components) {
    if (await ctx.tx.one(`select 1 from project_components where tenant_id = $1 and project_id = $2 and lower(name) = lower($3)`, [ctx.tenantId, projectId, c.name])) continue;
    await w.saveComponent(ctx, projectId, null, { name: c.name, description: c.description ?? null });
    out.components++;
  }
  for (const b of config.boards) {
    if (await ctx.tx.one(`select 1 from project_boards where tenant_id = $1 and project_id = $2 and name = $3`, [ctx.tenantId, projectId, b.name])) continue;
    await w.saveBoard(ctx, projectId, null, b as never);
    out.boards++;
  }
  for (const r of config.rules) {
    if (await ctx.tx.one(`select 1 from pm_rules where tenant_id = $1 and project_id = $2 and name = $3`, [ctx.tenantId, projectId, r.name])) continue;
    try {
      await ctx.tx.query('savepoint tpl_rule');
      await saveRule(ctx, projectId, null, r as never);
      await ctx.tx.query('release savepoint tpl_rule');
      out.rules++;
    } catch (e) {
      await ctx.tx.query('rollback to savepoint tpl_rule');
      out.skipped.push(`rule ${r.name} (${(e as Error).message})`);
    }
  }
  for (const d of config.dashboards) {
    if (await ctx.tx.one(`select 1 from pm_dashboards where tenant_id = $1 and project_id = $2 and name = $3`, [ctx.tenantId, projectId, d.name])) continue;
    await w.saveDashboard(ctx, projectId, null, { name: d.name, widgets: d.widgets as never, shared: true });
    out.dashboards++;
  }
  for (const q of config.queries) {
    if (await ctx.tx.one(`select 1 from pm_queries where tenant_id = $1 and project_id = $2 and name = $3`, [ctx.tenantId, projectId, q.name])) continue;
    await w.saveQuery(ctx, projectId, null, { name: q.name, query: q.query, columns: q.columns.length ? q.columns : undefined, shared: true });
    out.queries++;
  }
  if (Object.keys(config.settings ?? {}).length) await w.saveSettings(ctx, projectId, config.settings as never);
  return out;
}
