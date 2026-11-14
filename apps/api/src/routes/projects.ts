/**
 * Projects and timesheets API (mounted at /api/v1). Access inside a project follows from the
 * project (see services/projects.ts); the Projects app must be switched on.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import { enqueue, eventJobs } from '../services/jobs';
import * as pj from '../services/projects';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1990-01-01' && s <= '2100-12-31';
  }, 'Not a valid date');
const today = () => new Date().toISOString().slice(0, 10);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
function requireProjects(c: { var: AppEnv['Variables'] }) {
  if (!enabledApps(c.var.meta).has('projects')) throw notFound('Projects is switched off for the workspace');
}
type C = { var: AppEnv['Variables']; env: AppEnv['Bindings'] } & Parameters<typeof safeCtx>[0];
async function emit(c: C, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
const qDate = (c: { req: { query: (k: string) => string | undefined } }, k: string, dflt: string) => dateStr.parse(c.req.query(k) ?? dflt);

const milestoneSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startDate: dateStr.nullish(),
  dueDate: dateStr.nullish(),
  amount: z.number().min(0).max(1e12).nullish(),
  ownerId: uuid.nullish(),
  status: z.enum(['open', 'done']).optional(),
  position: z.number().int().min(0).max(100000).optional(),
});
const taskSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().max(20000).nullish(),
    listId: uuid.nullish(),
    milestoneId: uuid.nullish(),
    parentId: uuid.nullish(),
    status: z.enum(['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
    assignees: z.array(uuid).max(20),
    startDate: dateStr.nullish(),
    dueDate: dateStr.nullish(),
    estimateHours: z.number().min(0).max(100000).nullish(),
    progress: z.number().int().min(0).max(100),
    billable: z.boolean(),
    rate: z.number().min(0).max(1e9).nullish(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    position: z.number().int().min(0).max(1000000),
  })
  .partial();
const issueSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20000).nullish(),
    severity: z.enum(['minor', 'major', 'critical', 'blocker']),
    status: z.enum(['open', 'in_progress', 'fixed', 'closed', 'reopened', 'wont_fix']),
    assigneeId: uuid.nullish(),
    taskId: uuid.nullish(),
    milestoneId: uuid.nullish(),
    dueDate: dateStr.nullish(),
  })
  .partial();
const timeSchema = z.object({
  projectId: uuid,
  taskId: uuid.nullish(),
  issueId: uuid.nullish(),
  userId: uuid.nullish(),
  date: dateStr,
  minutes: z.number().int().min(1).max(1440),
  notes: z.string().max(2000).nullish(),
  billable: z.boolean().optional(),
});

export const projectRoutes = new Hono<AppEnv>()
  .use('/projects/*', async (c, next) => (requireProjects(c), next()))
  .use('/projects', async (c, next) => (requireProjects(c), next()))
  .use('/time/*', async (c, next) => (requireProjects(c), next()))
  .use('/timesheet/*', async (c, next) => (requireProjects(c), next()))
  .use('/timesheet', async (c, next) => (requireProjects(c), next()))
  .use('/project-reports/*', async (c, next) => (requireProjects(c), next()))
  .use('/my-tasks', async (c, next) => (requireProjects(c), next()))

  /* ───── projects ───── */
  .get('/projects', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listProjects(rctx(c, tx), { status: c.req.query('status') || null, search: c.req.query('q') || null, mine: c.req.query('mine') === '1' }))),
  )
  .get('/projects/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.getProject(rctx(c, tx), id(c)))))
  .get('/projects/:id/summary', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.projectSummary(rctx(c, tx), id(c)))))
  .put('/projects/:id/members', async (c) => {
    const b = z
      .object({ members: z.array(z.object({ userId: uuid, role: z.enum(['manager', 'member', 'viewer']), billRate: z.number().min(0).max(1e9).nullish(), costRate: z.number().min(0).max(1e9).nullish() })).max(200) })
      .parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.setMembers(rctx(c, tx), id(c), b.members));
    return c.json({ ok: true });
  })
  .post('/projects/:id/duplicate', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), startDate: dateStr.nullish(), accountId: uuid.nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pj.duplicateProject(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })

  /* ───── milestones and lists ───── */
  .post('/projects/:id/milestones', async (c) => {
    const b = milestoneSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveMilestone(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/milestones/:mid', async (c) => {
    const b = milestoneSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveMilestone(rctx(c, tx), id(c), id(c, 'mid'), b)));
  })
  .delete('/projects/:id/milestones/:mid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteMilestone(rctx(c, tx), id(c), id(c, 'mid')));
    return c.json({ ok: true });
  })
  .post('/projects/:id/lists', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), milestoneId: uuid.nullish(), position: z.number().int().min(0).max(100000).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveList(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/lists/:lid', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), milestoneId: uuid.nullish(), position: z.number().int().min(0).max(100000).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveList(rctx(c, tx), id(c), id(c, 'lid'), b)));
  })
  .delete('/projects/:id/lists/:lid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteList(rctx(c, tx), id(c), id(c, 'lid')));
    return c.json({ ok: true });
  })

  /* ───── tasks ───── */
  .get('/projects/:id/tasks', async (c) =>
    c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        pj.listTasks(rctx(c, tx), id(c), { assignee: c.req.query('assignee') ? uuid.parse(c.req.query('assignee')) : null, status: c.req.query('status') || null, listId: c.req.query('listId') ? uuid.parse(c.req.query('listId')) : null }),
      ),
    ),
  )
  .post('/projects/:id/tasks', async (c) => {
    const b = taskSchema.required({ name: true }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.createTask(rctx(c, tx), id(c), b)), 201);
  })
  .patch('/projects/:id/tasks/:tid', async (c) => {
    const b = taskSchema.strict().parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.updateTask(rctx(c, tx), id(c), id(c, 'tid'), b));
    return c.json({ ok: true });
  })
  .delete('/projects/:id/tasks/:tid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteTask(rctx(c, tx), id(c), id(c, 'tid')));
    return c.json({ ok: true });
  })
  .post('/projects/:id/tasks/:tid/deps', async (c) => {
    const b = z.object({ dependsOnId: uuid, kind: z.enum(['fs', 'ss', 'ff', 'sf']).default('fs'), lagDays: z.number().int().min(-365).max(365).default(0) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.addDependency(rctx(c, tx), id(c), id(c, 'tid'), b.dependsOnId, b.kind, b.lagDays));
    return c.json({ ok: true });
  })
  .delete('/projects/:id/tasks/:tid/deps/:did', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.removeDependency(rctx(c, tx), id(c), id(c, 'tid'), id(c, 'did')));
    return c.json({ ok: true });
  })
  .get('/projects/:id/tasks/:tid/comments', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listComments(rctx(c, tx), id(c), { taskId: id(c, 'tid') }))))
  .post('/projects/:id/tasks/:tid/comments', async (c) => {
    const b = z.object({ body: z.string().trim().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.addComment(rctx(c, tx), id(c), { taskId: id(c, 'tid') }, b.body)), 201);
  })

  /* ───── issues ───── */
  .get('/projects/:id/issues', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listIssues(rctx(c, tx), id(c), c.req.query('status') || null))))
  .post('/projects/:id/issues', async (c) => {
    const b = issueSchema.required({ title: true }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveIssue(rctx(c, tx), id(c), null, b)), 201);
  })
  .patch('/projects/:id/issues/:iid', async (c) => {
    const b = issueSchema.strict().parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveIssue(rctx(c, tx), id(c), id(c, 'iid'), b)));
  })
  .get('/projects/:id/issues/:iid/comments', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listComments(rctx(c, tx), id(c), { issueId: id(c, 'iid') }))))
  .post('/projects/:id/issues/:iid/comments', async (c) => {
    const b = z.object({ body: z.string().trim().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.addComment(rctx(c, tx), id(c), { issueId: id(c, 'iid') }, b.body)), 201);
  })

  /* ───── billing ───── */
  .get('/projects/:id/unbilled', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.unbilled(rctx(c, tx), id(c), qDate(c, 'upTo', today())))))
  .post('/projects/:id/invoice', async (c) => {
    const b = z
      .object({
        entryIds: z.array(uuid).max(5000).optional(),
        expenseIds: z.array(uuid).max(500).optional(),
        milestoneIds: z.array(uuid).max(200).optional(),
        groupBy: z.enum(['task', 'person', 'project', 'entry']).optional(),
        fixedAmount: z.number().min(0).max(1e12).nullish(),
        fixedLabel: z.string().max(300).nullish(),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pj.invoiceProject(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })

  /* ───── time ───── */
  .post('/time', async (c) => {
    const b = timeSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.logTime(rctx(c, tx), b)), 201);
  })
  .patch('/time/:id', async (c) => {
    const b = timeSchema.omit({ projectId: true, userId: true }).partial().strict().parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.updateTime(rctx(c, tx), id(c), b));
    return c.json({ ok: true });
  })
  .delete('/time/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteTime(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .get('/time/timer', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.runningTimer(rctx(c, tx)))))
  .post('/time/timer/start', async (c) => {
    const b = z.object({ projectId: uuid, taskId: uuid.nullish(), issueId: uuid.nullish(), notes: z.string().max(2000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.startTimer(rctx(c, tx), b)), 201);
  })
  .post('/time/timer/stop', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pj.stopTimer(rctx(c, tx)))))
  .get('/timesheet', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => pj.getWeek(rctx(c, tx), qDate(c, 'date', today()), c.req.query('userId') ? uuid.parse(c.req.query('userId')) : null))),
  )
  .put('/timesheet', async (c) => {
    const b = z
      .object({
        date: dateStr,
        rows: z.array(z.object({ projectId: uuid, taskId: uuid.nullish(), billable: z.boolean().optional(), notes: z.string().max(2000).nullish(), minutes: z.array(z.number().int().min(0).max(1440)).length(7) })).max(100),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveWeek(rctx(c, tx), b.date, b.rows)));
  })
  .post('/timesheet/submit', async (c) => {
    const b = z.object({ date: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.submitWeek(rctx(c, tx), b.date)));
  })
  .get('/timesheet/approvals', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.pendingApprovals(rctx(c, tx)))))
  .post('/timesheet/decide', async (c) => {
    const b = z.object({ entryIds: z.array(uuid).min(1).max(2000), decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.decideTime(rctx(c, tx), b.entryIds, b.decision, b.reason)));
  })

  /* ───── reports ───── */
  .get('/my-tasks', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.myTasks(rctx(c, tx)))))
  .get('/project-reports/time', async (c) => {
    const groupBy = z.enum(['person', 'project', 'task', 'day']).parse(c.req.query('groupBy') ?? 'person');
    const from = qDate(c, 'from', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        pj.timeReport(rctx(c, tx), { from, to: qDate(c, 'to', today()), groupBy, projectId: c.req.query('projectId') ? uuid.parse(c.req.query('projectId')) : null, userId: c.req.query('userId') ? uuid.parse(c.req.query('userId')) : null }),
      ),
    );
  })
  .get('/project-reports/utilisation', async (c) => {
    const from = qDate(c, 'from', new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pj.utilisation(rctx(c, tx), from, qDate(c, 'to', today()))));
  })
  .put('/project-reports/capacity/:id', async (c) => {
    const b = z.object({ weeklyHours: z.number().min(0).max(100) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.setCapacity(rctx(c, tx), id(c), b.weeklyHours));
    return c.json({ ok: true });
  });
