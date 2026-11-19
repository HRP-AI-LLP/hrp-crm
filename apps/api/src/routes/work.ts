/**
 * Work management API (Jira / Azure DevOps style), mounted at /api/v1; code-link webhooks at /api/public;
 * code connections at /api/admin. See services/it/work.ts, devlinks.ts and tests.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { enabledApps } from '../services/apps';
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
  type: z.enum(['count', 'breakdown', 'list', 'cfd', 'cycle', 'created_resolved', 'workload', 'velocity', 'burndown']),
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

export const workRoutes = new Hono<AppEnv>()
  .use('/projects/:id/work/*', needProjects)
  .use('/work/*', needProjects)

  /* ───── setup ───── */
  .get('/projects/:id/work/setup', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => wk.workSetup(rctx(c, tx), id(c)))))
  .put('/projects/:id/work/key', async (c) => {
    const b = z.object({ key: z.string().max(10) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => wk.setWorkKey(rctx(c, tx), id(c), b.key)));
  })
  .put('/projects/:id/work/settings', async (c) => {
    const b = z
      .object({ estimation: z.enum(['points', 'hours']).optional(), autoTransitions: z.object({ branch: stateKey.nullish(), prOpened: stateKey.nullish(), prMerged: stateKey.nullish(), buildFailed: stateKey.nullish() }).optional() })
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
  .get('/work/dev-connections', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => dev.listDevConnections(rctx(c, tx), base(c)))))
  .post('/work/dev-connections', async (c) => {
    const b = z.object({ provider: z.enum(['github', 'azure_repos']), label: z.string().trim().min(1).max(120) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dev.createDevConnection(rctx(c, tx), c.env, base(c), b)), 201);
  })
  .delete('/work/dev-connections/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => dev.deleteDevConnection(rctx(c, tx), id(c, 'cid')))));

/* ───── webhooks ───── */
const MAX_DEV_HOOK = 2 * 1024 * 1024;
export const workPublicRoutes = new Hono<AppEnv>().post('/hooks/dev/:key', async (c) => {
  const route = await resolveRoute(c, 'integration', c.req.param('key'));
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
  const raw = await c.req.text();
  if (raw.length > MAX_DEV_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
  const r = await dev.handleDevHook(c.env, c.var.db, route.tenant_id, route.target_id, (n) => c.req.header(n), raw);
  if (!r.ok) throw new ApiError(401, 'bad_signature', 'Invalid signature');
  return c.json({ ok: true, linked: r.linked ?? 0 });
});
