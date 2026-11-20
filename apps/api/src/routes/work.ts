/**
 * Work management API (Jira / Azure DevOps style), mounted at /api/v1; code-link webhooks at /api/public;
 * code connections at /api/admin. See services/it/work.ts, devlinks.ts and tests.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { enabledApps } from '../services/apps';
import * as ghapp from '../services/github-app';
import * as al from '../services/it/alerts';
import * as cp from '../services/it/codepolicy';
import * as rl from '../services/it/rules';
import * as tpl from '../services/it/templates';
import * as dev from '../services/it/devlinks';
import * as ts from '../services/it/tests';
import * as wk from '../services/it/work';
import type { RecordCtx } from '../services/records';
import { CATEGORIES, WORK_TYPES } from '../services/work-types';
import { resolveRoute } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
const needProjects = async (c: { var: AppEnv['Variables'] }, next: () => Promise<void>) => {
  if (!enabledApps(c.var.meta).has('projects')) throw notFound('Projects is switched off for the workspace');
  await next();
};
const base = (c: { req: { url: string }; env: AppEnv['Bindings'] }) => (c.env.APP_HOST ? `https://${c.env.APP_HOST}` : new URL(c.req.url).origin);

const workType = z.enum(WORK_TYPES);
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const stateKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, 'State keys are lower-case letters, digits and _');
const itemSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().max(20000).nullable(),
    workType,
    priority,
    severity: z.enum(['minor', 'major', 'critical', 'blocker']).nullable(),
    assignees: z.array(uuid).max(20),
    reporterId: uuid.nullable(),
    storyPoints: z.number().min(0).max(1000).nullable(),
    estimateHours: z.number().min(0).max(100000).nullable(),
    remainingHours: z.number().min(0).max(100000).nullable(),
    startDate: dateStr.nullable(),
    dueDate: dateStr.nullable(),
    sprintId: uuid.nullable(),
    releaseId: uuid.nullable(),
    parentId: uuid.nullable(),
    epicId: uuid.nullable(),
    componentIds: z.array(uuid).max(20),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    custom: z.record(z.string(), z.unknown()),
    state: stateKey,
  })
  .partial()
  .strict();
const workflowSchema = z.object({
  name: z.string().trim().min(1).max(80),
  workTypes: z.array(workType).max(8).default([]),
  states: z.array(z.object({ key: stateKey, label: z.string().trim().min(1).max(40), category: z.enum(CATEGORIES as [string, ...string[]]), color: z.string().max(20).nullish() })).min(2).max(20),
  transitions: z
    .array(
      z.object({
        from: z.union([z.literal('*'), stateKey]),
        to: stateKey,
        name: z.string().trim().max(40).nullish(),
        roles: z.array(z.enum(['manager', 'member'])).max(2).optional(),
        require: z.array(z.enum(['assignee', 'resolution', 'comment', 'points', 'estimate'])).max(5).optional(),
      }),
    )
    .max(200)
    .default([]),
});
const boardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['scrum', 'kanban']),
  columns: z.array(z.object({ name: z.string().trim().min(1).max(40), states: z.array(stateKey).max(20).default([]), categories: z.array(z.enum(CATEGORIES as [string, ...string[]])).max(6).default([]), wip: z.number().int().min(1).max(999).nullish() })).min(1).max(12),
  swimlane: z.enum(['none', 'assignee', 'epic', 'parent', 'priority', 'type']).default('none'),
  filter: z.string().max(2000).nullish(),
  quickFilters: z.array(z.object({ name: z.string().trim().min(1).max(40), query: z.string().trim().min(1).max(1000) })).max(12).default([]),
  cardFields: z.array(z.enum(['points', 'assignee', 'priority', 'due', 'epic', 'labels', 'type', 'children'])).max(8).default(['points', 'assignee', 'priority']),
});
const widgetSchema = z.object({
  id: z.string().max(40),
  type: z.enum(['count', 'breakdown', 'list', 'cfd', 'cycle', 'created_resolved', 'workload', 'velocity', 'burndown', 'sprint', 'time_in_status', 'release_burnup']),
  sprintId: z.string().uuid().nullish(),
  releaseId: z.string().uuid().nullish(),
  title: z.string().trim().min(1).max(80),
  query: z.string().max(2000).nullish(),
  groupBy: z.enum(['status', 'state', 'assignee', 'type', 'priority', 'sprint', 'component', 'epic', 'release', 'labels']).optional(),
  days: z.number().int().min(7).max(365).optional(),
  size: z.enum(['small', 'medium', 'large']).optional(),
});
const querySchema = z.object({ name: z.string().trim().min(1).max(120), query: z.string().max(4000), columns: z.array(z.string().max(40)).max(20).optional(), shared: z.boolean().optional() });
const caseSchema = z.object({
  title: z.string().trim().min(1).max(300),
  suite: z.string().trim().max(120).nullish(),
  preconditions: z.string().max(4000).nullish(),
  steps: z.array(z.object({ action: z.string().max(2000), expected: z.string().max(2000).nullish() })).max(100).default([]),
  priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(['draft', 'ready', 'obsolete']).optional(),
  itemIds: z.array(uuid).max(50).optional(),
  automated: z.boolean().optional(),
});
const planSchema = z.object({ name: z.string().trim().min(1).max(120), sprintId: uuid.nullish(), releaseId: uuid.nullish(), status: z.enum(['planned', 'active', 'done']).optional(), caseIds: z.array(uuid).max(1000).optional(), suite: z.string().max(120).nullish() });

const q = (c: { req: { query: (k: string) => string | undefined } }, k: string) => c.req.query(k) ?? '';
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().optional(),
  trigger: z.enum(['created', 'state_changed', 'field_changed', 'commented', 'scheduled']),
  triggerConfig: z
    .object({ types: z.array(workType).max(8).optional(), fromState: stateKey.nullish(), toState: stateKey.nullish(), toCategory: z.enum(CATEGORIES as [string, ...string[]]).nullish(), field: z.enum(['priority', 'assignee', 'sprint', 'severity', 'type', 'points', 'labels', 'due']).nullish(), to: z.string().max(100).nullish(), hour: z.number().int().min(0).max(23).nullish() })
    .default({}),
  condition: z.string().max(2000).nullish(),
  actions: z.array(z.discriminatedUnion('type', [
  z.object({ type: z.literal('transition'), to: stateKey }),
  z.object({ type: z.literal('set'), field: z.enum(['priority', 'severity', 'points', 'sprint', 'release', 'due_in_days', 'add_label', 'remove_label', 'add_component', 'type']), value: z.union([z.string().max(100), z.number(), z.null()]) }),
  z.object({ type: z.literal('assign'), mode: z.enum(['user', 'reporter', 'component_lead', 'round_robin', 'least_busy', 'unassign']), userId: uuid.nullish() }),
  z.object({ type: z.literal('comment'), body: z.string().trim().min(1).max(4000) }),
  z.object({ type: z.literal('notify'), to: z.array(z.enum(['assignee', 'reporter', 'watchers', 'manager'])).max(4), userIds: z.array(uuid).max(20).optional(), title: z.string().max(200).nullish(), body: z.string().max(1000).nullish() }),
  z.object({ type: z.literal('chat'), integrationId: uuid, message: z.string().trim().min(1).max(1000) }),
  z.object({ type: z.literal('create_child'), workType: workType, name: z.string().trim().min(1).max(300), assignToParent: z.boolean().optional() }),
  z.object({ type: z.literal('watch'), userIds: z.array(uuid).min(1).max(20) }),
])).min(1).max(10),
});
const MAX_ATTACHMENT = 25 * 1024 * 1024;

export const workRoutes = new Hono<AppEnv>()
  .use('/projects/:id/work/*', needProjects)
  .use('/work/*', needProjects)
  .use('/projects/:id/work/*', async (c, next) => {
    await next();
    if (c.req.method !== 'GET' && c.res.status < 400) await al.markAlertsPending(c.env);
  })

  /* ───── setup ───── */
  .get('/projects/:id/work/setup', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.workSetup(rctx(c, tx), id(c)))))
  .put('/projects/:id/work/key', async (c) => {
    const b = z.object({ key: z.string().max(10) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.setWorkKey(rctx(c, tx), id(c), b.key)));
  })
  .put('/projects/:id/work/settings', async (c) => {
    const b = z
      .object({ estimation: z.enum(['points', 'hours']).optional(), noCode: z.boolean().optional(), autoTransitions: z.object({ branch: stateKey.nullish(), prOpened: stateKey.nullish(), prMerged: stateKey.nullish(), buildFailed: stateKey.nullish() }).optional() })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveSettings(rctx(c, tx), id(c), b as wk.WorkSettings)));
  })
  .post('/projects/:id/work/workflows', async (c) => {
    const b = workflowSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveWorkflow(rctx(c, tx), id(c), null, b as wk.WorkflowInput)), 201);
  })
  .put('/projects/:id/work/workflows/:wid', async (c) => {
    const b = workflowSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveWorkflow(rctx(c, tx), id(c), id(c, 'wid'), b as wk.WorkflowInput)));
  })
  .delete('/projects/:id/work/workflows/:wid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteWorkflow(rctx(c, tx), id(c), id(c, 'wid')))))
  .post('/projects/:id/work/components', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(1000).nullish(), leadId: uuid.nullish(), assignLead: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveComponent(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/work/components/:cid', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(1000).nullish(), leadId: uuid.nullish(), assignLead: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveComponent(rctx(c, tx), id(c), id(c, 'cid'), b)));
  })
  .delete('/projects/:id/work/components/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteComponent(rctx(c, tx), id(c), id(c, 'cid')))))
  .post('/projects/:id/work/fields', async (c) => {
    const b = z
      .object({
        key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
        label: z.string().trim().min(1).max(80),
        type: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url']),
        options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
        workTypes: z.array(workType).max(8).default([]),
        required: z.boolean().default(false),
        position: z.number().int().min(0).max(1000).optional(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveField(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/work/fields/:fid', async (c) => {
    const b = z
      .object({
        key: z.string().max(40).default('x'),
        label: z.string().trim().min(1).max(80),
        type: z.enum(['text', 'number', 'date', 'select', 'multiselect', 'user', 'checkbox', 'url']),
        options: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
        workTypes: z.array(workType).max(8).default([]),
        required: z.boolean().default(false),
        position: z.number().int().min(0).max(1000).optional(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveField(rctx(c, tx), id(c), id(c, 'fid'), b)));
  })
  .delete('/projects/:id/work/fields/:fid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteField(rctx(c, tx), id(c), id(c, 'fid')))))

  /* ───── items ───── */
  .post('/projects/:id/work/items', async (c) => {
    const b = itemSchema.required({ name: true, workType: true }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.createItem(rctx(c, tx), id(c), b)), 201);
  })
  .get('/projects/:id/work/items/:tid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.getItem(rctx(c, tx), id(c), id(c, 'tid')))))
  .patch('/projects/:id/work/items/:tid', async (c) => {
    const b = itemSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.updateItem(rctx(c, tx), id(c), id(c, 'tid'), b)));
  })
  .post('/projects/:id/work/items/:tid/transition', async (c) => {
    const b = z.object({ to: stateKey, comment: z.string().max(10000).nullish(), resolution: z.string().trim().max(60).nullish(), assignee: uuid.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.transition(rctx(c, tx), id(c), id(c, 'tid'), b)));
  })
  .post('/projects/:id/work/items/:tid/comments', async (c) => {
    const b = z.object({ body: z.string().trim().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.comment(rctx(c, tx), id(c), id(c, 'tid'), b.body)), 201);
  })
  .put('/projects/:id/work/items/:tid/watch', async (c) => {
    const b = z.object({ on: z.boolean(), userId: uuid.optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.setWatching(rctx(c, tx), id(c), id(c, 'tid'), b.on, b.userId)));
  })
  .post('/projects/:id/work/items/:tid/relations', async (c) => {
    const b = z.object({ kind: z.enum(['relates', 'blocks', 'duplicates', 'clones', 'causes', 'tests']), key: z.string().trim().min(1).max(20) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.addRelation(rctx(c, tx), id(c), id(c, 'tid'), b.kind, b.key)), 201);
  })
  .delete('/projects/:id/work/items/:tid/relations/:rid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.removeRelation(rctx(c, tx), id(c), id(c, 'tid'), id(c, 'rid')))))
  .post('/projects/:id/work/bulk', async (c) => {
    const b = z
      .object({
        ids: z.array(uuid).min(1).max(500),
        set: z
          .object({
            state: stateKey, status: z.enum(['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']), assignee: uuid.nullable(), priority, sprintId: uuid.nullable(), releaseId: uuid.nullable(),
            storyPoints: z.number().min(0).max(1000).nullable(), parentId: uuid.nullable(), addLabels: z.array(z.string().trim().min(1).max(40)).max(10), removeLabels: z.array(z.string().max(40)).max(10),
            addComponent: uuid, dueDate: dateStr.nullable(),
          })
          .partial()
          .optional(),
        remove: z.boolean().optional(),
        watch: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.bulkEdit(rctx(c, tx), id(c), b)));
  })

  /* ───── queries ───── */
  .get('/projects/:id/work/query', async (c) =>
    c.json(await c.var.db.tx(scope(c), (tx) => wk.runQuery(rctx(c, tx), { projectId: id(c), query: q(c, 'q'), limit: Number(c.req.query('limit') ?? 200), offset: Number(c.req.query('offset') ?? 0) }))),
  )
  .get('/projects/:id/work/query/export', async (c) => {
    const csv = await c.var.db.tx(scope(c), (tx) => wk.exportQuery(rctx(c, tx), id(c), q(c, 'q')));
    return c.body(`﻿${csv}`, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="work-items.csv"' });
  })
  .get('/projects/:id/work/queries', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.listQueries(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/queries', async (c) => {
    const b = querySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveQuery(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/work/queries/:qid', async (c) => {
    const b = querySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveQuery(rctx(c, tx), id(c), id(c, 'qid'), b)));
  })
  .delete('/projects/:id/work/queries/:qid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteQuery(rctx(c, tx), id(c, 'qid')))))

  /* ───── boards ───── */
  .get('/projects/:id/work/boards', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.listBoards(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/boards', async (c) => {
    const b = boardSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveBoard(rctx(c, tx), id(c), null, b as wk.BoardInput)), 201);
  })
  .put('/projects/:id/work/boards/:bid', async (c) => {
    const b = boardSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveBoard(rctx(c, tx), id(c), id(c, 'bid'), b as wk.BoardInput)));
  })
  .delete('/projects/:id/work/boards/:bid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteBoard(rctx(c, tx), id(c), id(c, 'bid')))))
  .get('/projects/:id/work/board', async (c) => {
    const bid = c.req.query('boardId') ? uuid.parse(c.req.query('boardId')) : null;
    const quick = (c.req.query('quick') ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < 20);
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.boardData(rctx(c, tx), id(c), bid, quick, c.req.query('search') ?? null)));
  })
  .post('/projects/:id/work/board/move', async (c) => {
    const b = z.object({ boardId: uuid.nullable(), taskId: uuid, column: z.number().int().min(0).max(20), after: uuid.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.moveCard(rctx(c, tx), id(c), b.boardId, b.taskId, b.column, b.after)));
  })
  /* ───── repositories and the code policy ───── */
  .get('/projects/:id/work/repos', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => cp.listRepos(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/repos', async (c) => {
    const b = z.object({ provider: z.enum(['github', 'azure_repos']), repo: z.string().trim().min(3).max(300), defaultBranch: z.string().trim().max(200).optional(), policy: z.enum(['off', 'warn', 'enforce', 'auto_create']).optional(), autoSprint: z.boolean().optional(), installationId: z.string().regex(/^\d{1,15}$/).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cp.addRepo(rctx(c, tx), id(c), b)), 201);
  })
  .patch('/projects/:id/work/repos/:rid', async (c) => {
    const b = z.object({ policy: z.enum(['off', 'warn', 'enforce', 'auto_create']).optional(), defaultBranch: z.string().trim().max(200).optional(), autoSprint: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cp.updateRepo(rctx(c, tx), id(c), id(c, 'rid'), b)));
  })
  .post('/projects/:id/work/repos/:rid/rotate', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cp.rotateRepoToken(rctx(c, tx), id(c), id(c, 'rid')))))
  .delete('/projects/:id/work/repos/:rid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cp.removeRepo(rctx(c, tx), id(c), id(c, 'rid')))))
  .get('/projects/:id/work/repos/:rid/setup', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cp.setupFiles(rctx(c, tx), id(c), id(c, 'rid'), base(c)))))
  .post('/projects/:id/work/code-events/:eid/resolve', async (c) => {
    const b = z.object({ key: z.string().trim().max(24).nullish(), create: z.boolean().optional() }).refine((x) => !!x.key || x.create, 'Give a key or ask to create an item').parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cp.resolveMissing(rctx(c, tx), c.env, id(c), id(c, 'eid'), b)));
  })
  .get('/projects/:id/work/hierarchy', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.hierarchy(rctx(c, tx), id(c), { open: c.req.query('open') === '1' }))))

  /* ───── reports & dashboards ───── */
  .get('/projects/:id/work/reports/cfd', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.cumulativeFlow(rctx(c, tx), id(c), Number(c.req.query('days') ?? 30)))))
  .get('/projects/:id/work/reports/cycle', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.cycleTime(rctx(c, tx), id(c), Number(c.req.query('days') ?? 60)))))
  .get('/projects/:id/work/reports/created-resolved', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.createdResolved(rctx(c, tx), id(c), Number(c.req.query('days') ?? 30)))))
  .get('/projects/:id/work/reports/workload', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.workload(rctx(c, tx), id(c)))))
  .get('/projects/:id/work/dashboards', async (c) => c.json({ dashboards: await c.var.db.tx(scope(c, true), (tx) => wk.listDashboards(rctx(c, tx), id(c))), starter: wk.STARTER_WIDGETS }))
  .post('/projects/:id/work/dashboards', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), widgets: z.array(widgetSchema).max(30), shared: z.boolean().default(true) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveDashboard(rctx(c, tx), id(c), null, b as never)), 201);
  })
  .put('/projects/:id/work/dashboards/:did', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), widgets: z.array(widgetSchema).max(30), shared: z.boolean().default(true) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveDashboard(rctx(c, tx), id(c), id(c, 'did'), b as never)));
  })
  .delete('/projects/:id/work/dashboards/:did', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteDashboard(rctx(c, tx), id(c), id(c, 'did')))))
  .post('/projects/:id/work/widget', async (c) => {
    const b = widgetSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.widgetData(rctx(c, tx), id(c), b as wk.Widget)));
  })

  /* ───── tests ───── */
  .get('/projects/:id/work/tests/cases', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.listCases(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/tests/cases', async (c) => {
    const b = caseSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.saveCase(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/work/tests/cases/:cid', async (c) => {
    const b = caseSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.saveCase(rctx(c, tx), id(c), id(c, 'cid'), b)));
  })
  .delete('/projects/:id/work/tests/cases/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.deleteCase(rctx(c, tx), id(c), id(c, 'cid')))))
  .get('/projects/:id/work/tests/plans', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ts.listPlans(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/tests/plans', async (c) => {
    const b = planSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.savePlan(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/work/tests/plans/:pid', async (c) => {
    const b = planSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.savePlan(rctx(c, tx), id(c), id(c, 'pid'), b)));
  })
  .delete('/projects/:id/work/tests/plans/:pid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.deletePlan(rctx(c, tx), id(c), id(c, 'pid')))))
  .get('/projects/:id/work/tests/plans/:pid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.planDetail(rctx(c, tx), id(c), id(c, 'pid')))))
  .post('/projects/:id/work/tests/plans/:pid/cases', async (c) => {
    const b = z.object({ caseIds: z.array(uuid).max(1000).default([]), suite: z.string().max(120).nullish(), covering: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.addCases(rctx(c, tx), id(c), id(c, 'pid'), b)));
  })
  .delete('/projects/:id/work/tests/plans/:pid/cases/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.removeCase(rctx(c, tx), id(c), id(c, 'pid'), id(c, 'cid')))))
  .put('/projects/:id/work/tests/plans/:pid/runs/:cid', async (c) => {
    const b = z
      .object({ result: z.enum(['untested', 'passed', 'failed', 'blocked', 'skipped']), notes: z.string().max(4000).nullish(), stepResults: z.array(z.enum(['passed', 'failed']).nullable()).max(100).optional(), createBug: z.boolean().optional(), bugTitle: z.string().max(300).nullish() })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ts.recordRun(rctx(c, tx), id(c), id(c, 'pid'), id(c, 'cid'), b)));
  })
  .get('/projects/:id/work/tests/coverage', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ts.coverage(rctx(c, tx), id(c)))))

  /* ───── automation rules ───── */
  .get('/projects/:id/work/rules', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => rl.listRules(rctx(c, tx), id(c)))))
  .post('/projects/:id/work/rules', async (c) => {
    const b = ruleSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => rl.saveRule(rctx(c, tx), id(c), null, b as rl.RuleInput)), 201);
  })
  .put('/projects/:id/work/rules/:rid', async (c) => {
    const b = ruleSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => rl.saveRule(rctx(c, tx), id(c), id(c, 'rid'), b as rl.RuleInput)));
  })
  .delete('/projects/:id/work/rules/:rid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => rl.deleteRule(rctx(c, tx), id(c), id(c, 'rid')))))
  .post('/projects/:id/work/rules/:rid/run', async (c) => {
    const b = z.object({ key: z.string().trim().max(24).nullish() }).parse(await c.req.json().catch(() => ({})));
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const target = b.key ? await wk.findByKey(ctx, b.key, id(c)) : null;
      if (b.key && !target) throw notFound(`No work item ${b.key}`);
      return rl.runNow(ctx, id(c), id(c, 'rid'), target?.id ?? null);
    });
    await al.markAlertsPending(c.env);
    return c.json(out);
  })

  /* ───── templates ───── */
  .get('/work/templates', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => tpl.listTemplates(rctx(c, tx)))))
  .delete('/work/templates/:tid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => tpl.deleteTemplate(rctx(c, tx), id(c, 'tid')))))
  .post('/projects/:id/work/templates', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => tpl.saveAsTemplate(rctx(c, tx), id(c), b)), 201);
  })
  .post('/projects/:id/work/templates/apply', async (c) => {
    const b = z.object({ templateId: z.string().max(60) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => tpl.applyTemplate(rctx(c, tx), id(c), b.templateId)));
  })

  /* ───── alerts by email ───── */
  .get('/work/alerts/prefs', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => al.getPrefs(rctx(c, tx)))))
  .put('/work/alerts/prefs', async (c) => {
    const m = z.enum(['off', 'instant', 'digest']);
    const b = z.object({ assigned: m.optional(), mentioned: m.optional(), watching: m.optional(), due: z.enum(['off', 'digest']).optional(), digestHour: z.number().int().min(0).max(23).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => al.savePrefs(rctx(c, tx), b)));
  })

  /* ───── live updates, attachments, more reports, roadmap ───── */
  .get('/projects/:id/work/stamp', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.workStamp(rctx(c, tx), id(c)))))
  .get('/projects/:id/work/items/:tid/files', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.itemFiles(rctx(c, tx), c.env, id(c), id(c, 'tid')))))
  .post('/projects/:id/work/items/:tid/files', async (c) => {
    const name = z.string().trim().min(1).max(200).parse(c.req.query('name') ?? 'file');
    if (Number(c.req.header('content-length') ?? 0) > MAX_ATTACHMENT) throw badRequest('Attachments can be at most 25 MB');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.attachToItem(rctx(c, tx), c.env, id(c), id(c, 'tid'), name, bytes)), 201);
  })
  .delete('/projects/:id/work/items/:tid/files/:fid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.removeItemFile(rctx(c, tx), id(c), id(c, 'tid'), id(c, 'fid')))))
  .get('/projects/:id/work/reports/time-in-status', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.timeInStatus(rctx(c, tx), id(c), Number(c.req.query('days') ?? 60)))))
  .get('/projects/:id/work/reports/sprint', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.sprintReport(rctx(c, tx), id(c), c.req.query('sprintId') ? uuid.parse(c.req.query('sprintId')) : null))))
  .get('/projects/:id/work/reports/release-burnup', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.releaseBurnup(rctx(c, tx), id(c), c.req.query('releaseId') ? uuid.parse(c.req.query('releaseId')) : null))))
  .get('/work/roadmap', async (c) => {
    const ids = (c.req.query('projects') ?? '').split(',').filter((x) => uuid.safeParse(x).success);
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.roadmap(rctx(c, tx), { projectIds: ids })));
  })

  /* ───── GitHub App: repositories, required check, branches ───── */
  .get('/work/github/repos', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ghapp.listAppRepos(rctx(c, tx), c.env))))
  .post('/projects/:id/work/repos/:rid/require-check', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ghapp.requireCheck(rctx(c, tx), c.env, id(c), id(c, 'rid')))))
  .post('/projects/:id/work/items/:tid/branch', async (c) => {
    const b = z.object({ repoId: uuid, name: z.string().trim().min(3).max(200) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ghapp.createBranch(rctx(c, tx), c.env, id(c), id(c, 'tid'), b.repoId, b.name)), 201);
  })
  /* ───── across projects ───── */
  .get('/work/query', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.runQuery(rctx(c, tx), { projectId: null, query: q(c, 'q'), limit: Number(c.req.query('limit') ?? 200), offset: Number(c.req.query('offset') ?? 0) }))))
  .get('/work/query/export', async (c) => {
    const csv = await c.var.db.tx(scope(c), (tx) => wk.exportQuery(rctx(c, tx), null, q(c, 'q')));
    return c.body(`﻿${csv}`, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="work-items.csv"' });
  })
  .get('/work/mine', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.myWork(rctx(c, tx)))))
  .get('/work/queries', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => wk.listQueries(rctx(c, tx), null))))
  .post('/work/queries', async (c) => {
    const b = querySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveQuery(rctx(c, tx), null, null, b)), 201);
  })
  .put('/work/queries/:qid', async (c) => {
    const b = querySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.saveQuery(rctx(c, tx), null, id(c, 'qid'), b)));
  })
  .delete('/work/queries/:qid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.deleteQuery(rctx(c, tx), id(c, 'qid')))));

/* ───── code connections (admin) ───── */
export const workAdminRoutes = new Hono<AppEnv>()
  .use('/work/dev-connections', requireAdmin('developers'))
  .use('/work/dev-connections/*', requireAdmin('developers'))
  .use('/work/github', requireAdmin('developers'))
  .use('/work/github/*', requireAdmin('developers'))
  .use('/work/policy', requireAdmin('projects'))
  .get('/work/policy', async (c) => c.json({ requireRepo: await c.var.db.tx(scope(c, true), (tx) => wk.repoRule(rctx(c, tx))) }))
  .put('/work/policy', async (c) => {
    const b = z.object({ requireRepo: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.setRepoRule(rctx(c, tx), b.requireRepo)));
  })
  .get('/work/github', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ghapp.listInstallations(rctx(c, tx), c.env))))
  .post('/work/github/install', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ghapp.installUrl(c.env, rctx(c, tx), base(c)))))
  .delete('/work/github/:gid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ghapp.removeInstallation(rctx(c, tx), id(c, 'gid')))))
  .get('/work/dev-connections', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => dev.listDevConnections(rctx(c, tx), base(c)))))
  .post('/work/dev-connections', async (c) => {
    const b = z.object({ provider: z.enum(['github', 'azure_repos']), label: z.string().trim().min(1).max(120) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dev.createDevConnection(rctx(c, tx), c.env, base(c), b)), 201);
  })
  .delete('/work/dev-connections/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => dev.deleteDevConnection(rctx(c, tx), id(c, 'cid')))));

/* ───── webhooks and the CI check ───── */
const MAX_DEV_HOOK = 2 * 1024 * 1024;
const checkSchema = z.object({
  event: z.string().max(40).optional(),
  branch: z.string().max(300).nullish(),
  title: z.string().max(1000).nullish(),
  body: z.string().max(20000).nullish(),
  pr: z.coerce.number().int().min(1).nullish(),
  url: z.string().max(1000).nullish(),
  author: z.string().max(200).nullish(),
  commits: z.array(z.object({ sha: z.string().max(64), message: z.string().max(20000).default(''), author: z.string().max(200).nullish(), email: z.string().max(320).nullish(), url: z.string().max(1000).nullish() })).max(200).default([]),
});
export const workPublicRoutes = new Hono<AppEnv>()
  .post('/dev/check', async (c) => {
    const tok = /^Bearer\s+([a-f0-9]{32})\.([A-Za-z0-9_-]{16,80})$/.exec(c.req.header('authorization') ?? '');
    if (!tok) throw new ApiError(401, 'bad_token', 'Send the repository token as Authorization: Bearer <token> (the SYNAPSE_TOKEN secret)');
    const route = await resolveRoute(c, 'repo', tok[1]!).catch(() => null);
    const repo = route ? await cp.repoByToken(c.var.db, route, tok[2]!) : null;
    if (!repo) throw new ApiError(401, 'bad_token', 'Unknown or revoked repository token');
    const raw = await c.req.text();
    if (raw.length > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
    const b = checkSchema.parse(JSON.parse(raw || '{}'));
    return c.json(await cp.runCheck(c.env, c.var.db, repo, b));
  })
  .get('/github/setup', async (c) => {
    const inst = c.req.query('installation_id') ?? '';
    if (!inst) return c.redirect('/projects?github=cancelled', 302);
    const r = await ghapp.completeInstall(c.env, c.var.db, inst, c.req.query('state'));
    return c.redirect(`${r.origin}/projects?github=${encodeURIComponent(r.account)}`, 302);
  })
  .post('/github/app', async (c) => {
    const raw = await c.req.text();
    if (raw.length > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
    if (!(await ghapp.verifyAppHook(c.env, c.req.header('x-hub-signature-256'), raw))) throw new ApiError(401, 'bad_signature', 'Invalid signature');
    const event = c.req.header('x-github-event') ?? '';
    const body = JSON.parse(raw);
    if (event === 'ping') return c.json({ ok: true });
    const instId = body.installation?.id;
    if (!instId) return c.json({ ok: true, ignored: true });
    const route = await resolveRoute(c, 'github_app', ghapp.appRouteKey(instId)).catch(() => null);
    if (!route) return c.json({ ok: true, ignored: 'installation not connected to a workspace' });
    if (event === 'installation' && ['deleted', 'suspend', 'unsuspend'].includes(body.action)) {
      await c.var.db.tx({ tenantId: route.tenant_id }, (tx) =>
        body.action === 'deleted'
          ? tx.query(`delete from github_installations where tenant_id = $1 and installation_id = $2`, [route.tenant_id, instId])
          : tx.query(`update github_installations set suspended_at = $3 where tenant_id = $1 and installation_id = $2`, [route.tenant_id, instId, body.action === 'suspend' ? new Date().toISOString() : null]),
      );
      return c.json({ ok: true });
    }
    const events = dev.githubEvents(event, body);
    const origin = base(c);
    const check = await c.var.db.tx({ tenantId: route.tenant_id }, async (tx) => {
      await dev.applyDevEvents(c.env, tx, route.tenant_id, 'github', events);
      return ghapp.checksFor(tx, route.tenant_id, event, body, origin);
    });
    if (check) await ghapp.postCheck(c.env, check.installationId, check.repo, check.check).catch((e) => console.error(JSON.stringify({ level: 'warn', job: 'github-check', msg: (e as Error).message })));
    return c.json({ ok: true, checked: !!check });
  })
  .post('/hooks/dev/:key', async (c) => {
  const route = await resolveRoute(c, 'integration', c.req.param('key'));
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
  const raw = await c.req.text();
  if (raw.length > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
  const r = await dev.handleDevHook(c.env, c.var.db, route.tenant_id, route.target_id, (n) => c.req.header(n), raw);
  if (!r.ok) throw new ApiError(401, 'bad_signature', 'Invalid signature');
  return c.json({ ok: true, linked: r.linked ?? 0 });
  });
