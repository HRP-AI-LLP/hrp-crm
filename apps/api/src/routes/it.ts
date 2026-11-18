/**
 * IT company suite API (mounted at /api/v1): agile delivery inside projects, service contracts, change
 * requests, capacity planning, SaaS subscriptions and product management. Needs the Projects app.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import * as ag from '../services/it/agile';
import * as ci from '../services/it/contract-import';
import * as ct from '../services/it/contracts';
import * as pm from '../services/it/product';
import * as ss from '../services/it/saas';
import { enqueue, eventJobs } from '../services/jobs';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && s >= '1990-01-01' && s <= '2100-12-31', 'Not a valid date');
const money = z.number().min(0).max(1e12);
const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
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
const needProjects = async (c: { var: AppEnv['Variables'] }, next: () => Promise<void>) => {
  if (!enabledApps(c.var.meta).has('projects')) throw notFound('Projects is switched off for the workspace');
  await next();
};

const sprintSchema = z.object({ name: z.string().trim().min(1).max(120), goal: z.string().max(2000).nullish(), startDate: dateStr, endDate: dateStr, capacityPoints: z.number().min(0).max(100000).nullish() });
const releaseSchema = z.object({
  name: z.string().trim().min(1).max(120),
  version: z.string().trim().max(40).nullish(),
  targetDate: dateStr.nullish(),
  status: z.enum(['planned', 'in_progress', 'cancelled']).optional(),
  notes: z.string().max(50000).nullish(),
});
const agileSchema = z
  .object({
    workType: z.enum(['task', 'story', 'bug', 'epic', 'spike', 'chore']),
    storyPoints: z.number().min(0).max(1000).nullish(),
    sprintId: uuid.nullish(),
    releaseId: uuid.nullish(),
    epicId: uuid.nullish(),
    backlogRank: z.number().int().min(0).max(100000000),
  })
  .partial();
const contractSchema = z.object({
  name: z.string().trim().min(1).max(200),
  accountId: uuid,
  projectId: uuid.nullish(),
  kind: z.enum(['retainer', 'amc', 'time_materials', 'fixed_bid', 'support', 'enterprise_licence', 'nda', 'msa', 'other']),
  startDate: dateStr,
  endDate: dateStr.nullish(),
  value: money.optional(),
  billingFrequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly', 'milestone', 'one_time', 'none']),
  periodFee: money.nullish(),
  hoursPerPeriod: z.number().min(0).max(100000).nullish(),
  overageRate: money.nullish(),
  slaResponseHours: z.number().min(0).max(10000).nullish(),
  slaResolutionHours: z.number().min(0).max(10000).nullish(),
  autoRenew: z.boolean().optional(),
  renewalNoticeDays: z.number().int().min(0).max(365).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  hsnSac: z.string().trim().max(10).nullish(),
  terms: z.string().max(20000).nullish(),
  ownerId: uuid.nullish(),
});
const crSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).nullish(),
  reason: z.string().max(2000).nullish(),
  requestedBy: z.string().trim().max(200).nullish(),
  impactHours: z.number().min(0).max(100000).optional(),
  impactAmount: money.optional(),
  impactDays: z.number().int().min(0).max(3650).optional(),
});
const planSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(40).nullish(),
  product: z.string().trim().max(120).nullish(),
  description: z.string().max(4000).nullish(),
  interval: z.enum(['month', 'quarter', 'half_year', 'year']),
  price: money,
  includedSeats: z.number().int().min(0).max(1000000).optional(),
  seatPrice: money.optional(),
  usageUnit: z.string().trim().max(40).nullish(),
  includedUsage: money.optional(),
  usagePrice: z.number().min(0).max(1e9).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  taxRate: z.number().min(0).max(100).optional(),
  hsnSac: z.string().trim().max(10).nullish(),
  active: z.boolean().optional(),
});
const addon = z.object({ name: z.string().trim().min(1).max(120), quantity: z.number().positive().max(1e7), unitPrice: money });
const itemSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).nullish(),
  kind: z.enum(['feature', 'improvement', 'bug', 'tech_debt', 'integration']).optional(),
  status: z.enum(['idea', 'under_review', 'planned', 'in_progress', 'released', 'declined']).optional(),
  quarter: z.string().regex(/^\d{4}-Q[1-4]$/).nullish(),
  reach: z.number().int().min(0).max(1e9).nullish(),
  impact: z.union([z.literal(0.25), z.literal(0.5), z.literal(1), z.literal(2), z.literal(3)]).nullish(),
  confidence: z.number().int().min(0).max(100).nullish(),
  effort: z.number().positive().max(10000).nullish(),
  releaseId: uuid.nullish(),
  public: z.boolean().optional(),
});
const requestSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).nullish(),
  accountId: uuid.nullish(),
  contactName: z.string().trim().max(200).nullish(),
  source: z.enum(['sales', 'support', 'email', 'call', 'portal', 'internal']).optional(),
  importance: z.enum(['nice_to_have', 'important', 'critical']).optional(),
  itemId: uuid.nullish(),
});

export const itRoutes = new Hono<AppEnv>()
  .use('/projects/:id/agile/*', needProjects)
  .use('/projects/:id/agile', needProjects)
  .use('/it/*', needProjects)

  /* ───── agile ───── */
  .get('/projects/:id/agile', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.agileBoard(rctx(c, tx), id(c)))))
  .put('/projects/:id/agile/tasks/:tid', async (c) => {
    const b = agileSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => ag.setAgile(rctx(c, tx), id(c), id(c, 'tid'), b));
    return c.json({ ok: true });
  })
  .put('/projects/:id/agile/backlog', async (c) => {
    const b = z.object({ ids: z.array(uuid).max(3000) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => ag.rankBacklog(rctx(c, tx), id(c), b.ids));
    return c.json({ ok: true });
  })
  .get('/projects/:id/agile/next-sprint', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.nextSprintDraft(rctx(c, tx), id(c)))))
  .post('/projects/:id/agile/sprints', async (c) => {
    const b = sprintSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.saveSprint(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/agile/sprints/:sid', async (c) => {
    const b = sprintSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.saveSprint(rctx(c, tx), id(c), id(c, 'sid'), b)));
  })
  .delete('/projects/:id/agile/sprints/:sid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => ag.deleteSprint(rctx(c, tx), id(c), id(c, 'sid')));
    return c.json({ ok: true });
  })
  .post('/projects/:id/agile/sprints/:sid/start', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ag.startSprint(rctx(c, tx), id(c), id(c, 'sid')))))
  .post('/projects/:id/agile/sprints/:sid/close', async (c) => {
    const b = z.object({ moveTo: uuid.nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.closeSprint(rctx(c, tx), id(c), id(c, 'sid'), b.moveTo ?? null)));
  })
  .get('/projects/:id/agile/sprints/:sid/burndown', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.burndown(rctx(c, tx), id(c), id(c, 'sid')))))
  .get('/projects/:id/agile/velocity', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.velocity(rctx(c, tx), id(c)))))
  .post('/projects/:id/agile/releases', async (c) => {
    const b = releaseSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.saveRelease(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/agile/releases/:rid', async (c) => {
    const b = releaseSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.saveRelease(rctx(c, tx), id(c), id(c, 'rid'), b)));
  })
  .delete('/projects/:id/agile/releases/:rid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => ag.deleteRelease(rctx(c, tx), id(c), id(c, 'rid')));
    return c.json({ ok: true });
  })
  .get('/projects/:id/agile/releases/:rid/notes', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.draftReleaseNotes(rctx(c, tx), id(c), id(c, 'rid')))))
  .post('/projects/:id/agile/releases/:rid/release', async (c) => {
    const b = z.object({ date: dateStr.nullish(), notes: z.string().max(50000).nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.markReleased(rctx(c, tx), id(c), id(c, 'rid'), b)));
  })
  .get('/projects/:id/agile/tasks/:tid/links', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ag.listLinks(rctx(c, tx), id(c), id(c, 'tid')))))
  .post('/projects/:id/agile/tasks/:tid/links', async (c) => {
    const b = z
      .object({ url: z.string().trim().url().max(1000).regex(/^https?:\/\//), title: z.string().trim().max(300).nullish(), kind: z.enum(['pr', 'commit', 'branch', 'doc', 'design', 'other']).nullish(), status: z.enum(['open', 'merged', 'closed', 'draft']).nullish() })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ag.addLink(rctx(c, tx), id(c), id(c, 'tid'), b)), 201);
  })
  .put('/projects/:id/agile/links/:lid', async (c) => {
    const b = z.object({ status: z.enum(['open', 'merged', 'closed', 'draft']) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => ag.updateLink(rctx(c, tx), id(c), id(c, 'lid'), b.status));
    return c.json({ ok: true });
  })
  .delete('/projects/:id/agile/links/:lid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => ag.deleteLink(rctx(c, tx), id(c), id(c, 'lid')));
    return c.json({ ok: true });
  })

  /* ───── change requests, estimates, client portal ───── */
  .get('/projects/:id/agile/change-requests', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ct.listChangeRequests(rctx(c, tx), id(c)))))
  .post('/projects/:id/agile/change-requests', async (c) => {
    const b = crSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveChangeRequest(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/agile/change-requests/:cid', async (c) => {
    const b = crSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveChangeRequest(rctx(c, tx), id(c), id(c, 'cid'), b)));
  })
  .post('/projects/:id/agile/change-requests/:cid/:action{submit|approve|reject|implemented|reopen}', async (c) => {
    const b = z.object({ note: z.string().trim().max(2000).nullish() }).parse(await c.req.json().catch(() => ({})));
    const action = c.req.param('action') as 'submit';
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.changeRequestAction(rctx(c, tx), id(c), id(c, 'cid'), action, { note: b.note ?? null })));
  })
  .get('/projects/:id/agile/estimates', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ct.estimateVsActual(rctx(c, tx), id(c)))))
  .post('/projects/:id/agile/portal', async (c) => {
    const b = z.object({ on: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.sharePortal(rctx(c, tx), id(c), b.on)));
  })

  /* ───── capacity planning ───── */
  .get('/it/capacity', async (c) => {
    const from = dateStr.parse(c.req.query('from') ?? today());
    const to = dateStr.parse(c.req.query('to') ?? new Date(Date.parse(`${from}T00:00:00Z`) + 83 * 86_400_000).toISOString().slice(0, 10));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => ct.listAllocations(rctx(c, tx), from, to)));
  })
  .post('/it/allocations', async (c) => {
    const b = z.object({ userId: uuid, projectId: uuid, startDate: dateStr, endDate: dateStr, hoursPerWeek: z.number().positive().max(80), role: z.string().trim().max(80).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveAllocation(rctx(c, tx), null, b)), 201);
  })
  .put('/it/allocations/:id', async (c) => {
    const b = z.object({ userId: uuid, projectId: uuid, startDate: dateStr, endDate: dateStr, hoursPerWeek: z.number().positive().max(80), role: z.string().trim().max(80).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveAllocation(rctx(c, tx), id(c), b)));
  })
  .delete('/it/allocations/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => ct.deleteAllocation(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })

  /* ───── contracts ───── */
  .get('/it/contracts', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => ct.listContracts(rctx(c, tx), { accountId: c.req.query('account') || null, status: c.req.query('status') || null, projectId: c.req.query('project') || null }))),
  )
  .get('/it/contracts/:id', async (c) =>
    c.json(
      await c.var.db.tx(scope(c, true), async (tx) => ({ ...(await ct.getContract(rctx(c, tx), id(c))), files: await ci.contractFiles(rctx(c, tx), c.env, id(c)) })),
    ),
  )
  // existing contracts (NDA, MSA, SoW…): read the uploaded files, then save what was checked
  .post('/it/contracts/read', async (c) => {
    const b = ci.uploadSchema.parse(await c.req.json());
    const deps = {
      run: <T,>(fn: (ctx: RecordCtx) => Promise<T>) => c.var.db.tx(scope(c), (tx) => fn(rctx(c, tx))),
      ai: { env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, requestId: c.var.requestId, meta: c.var.meta },
    };
    return c.json(await ci.readUploaded(deps, b));
  })
  .post('/it/contracts/upload', async (c) => {
    const b = ci.saveSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => ci.saveUploaded(rctx(c, tx), c.env, b));
    await emit(c, r.events);
    return c.json({ id: r.id, number: r.number, status: r.status, accountId: r.accountId, projectId: r.projectId, nextInvoiceDate: r.nextInvoiceDate, files: r.files }, 201);
  })
  .post('/it/contracts', async (c) => {
    const b = contractSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveContract(rctx(c, tx), null, b)), 201);
  })
  .put('/it/contracts/:id', async (c) => {
    const b = contractSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.saveContract(rctx(c, tx), id(c), b)));
  })
  .post('/it/contracts/:id/:action{activate|terminate|renew}', async (c) => {
    const b = z.object({ date: dateStr.nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => ct.contractAction(rctx(c, tx), id(c), c.req.param('action') as 'activate', b)));
  })
  .post('/it/contracts/:id/invoice', async (c) => {
    const b = z.object({ periodStart: dateStr.nullish(), issue: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => ct.invoiceContract(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ invoiceId: r.invoiceId, number: r.number }, 201);
  })
  .post('/it/contracts-run', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => ct.runContracts(rctx(c, tx)));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })

  /* ───── SaaS subscriptions ───── */
  .get('/it/plans', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ss.listPlans(rctx(c, tx)))))
  .post('/it/plans', async (c) => {
    const b = planSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.savePlan(rctx(c, tx), null, b)), 201);
  })
  .put('/it/plans/:id', async (c) => {
    const b = planSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.savePlan(rctx(c, tx), id(c), b)));
  })
  .get('/it/subscriptions', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => ss.listSubscriptions(rctx(c, tx), { status: c.req.query('status') || null, accountId: c.req.query('account') || null, planId: c.req.query('plan') || null }))),
  )
  .get('/it/subscriptions/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ss.getSubscription(rctx(c, tx), id(c)))))
  .post('/it/subscriptions', async (c) => {
    const b = z
      .object({
        accountId: uuid,
        planId: uuid,
        startDate: dateStr,
        seats: z.number().int().min(0).max(1000000).optional(),
        priceOverride: money.nullish(),
        discountPct: z.number().min(0).max(100).optional(),
        trial: z.boolean().optional(),
        autoInvoice: z.boolean().optional(),
        autoIssue: z.boolean().optional(),
        notes: z.string().max(4000).nullish(),
        addons: z.array(addon).max(50).optional(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.createSubscription(rctx(c, tx), b)), 201);
  })
  .put('/it/subscriptions/:id', async (c) => {
    const b = z
      .object({
        planId: uuid.optional(),
        seats: z.number().int().min(0).max(1000000).optional(),
        priceOverride: money.nullish(),
        discountPct: z.number().min(0).max(100).optional(),
        autoInvoice: z.boolean().optional(),
        autoIssue: z.boolean().optional(),
        notes: z.string().max(4000).nullish(),
        addons: z.array(addon).max(50).optional(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.changeSubscription(rctx(c, tx), id(c), b)));
  })
  .post('/it/subscriptions/:id/:action{cancel_at_period_end|pause|resume|cancel|reactivate|activate}', async (c) => {
    const b = z.object({ reason: z.string().trim().max(1000).nullish(), date: dateStr.nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.subscriptionAction(rctx(c, tx), id(c), c.req.param('action') as 'pause', b)));
  })
  .post('/it/subscriptions/:id/usage', async (c) => {
    const b = z.object({ date: dateStr, quantity: z.number().min(0).max(1e12), note: z.string().trim().max(300).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ss.recordUsage(rctx(c, tx), id(c), b)), 201);
  })
  .post('/it/subscriptions/:id/invoice', async (c) => {
    const b = z.object({ issue: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => ss.invoiceSubscription(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ invoiceId: r.invoiceId, number: r.number }, 201);
  })
  .post('/it/subscriptions-run', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => ss.runSubscriptions(rctx(c, tx)));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  .get('/it/saas-metrics', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ss.saasMetrics(rctx(c, tx)))))

  /* ───── product management ───── */
  .get('/it/products', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pm.listProducts(rctx(c, tx)))))
  .post('/it/products', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/).nullish(), description: z.string().max(4000).nullish(), vision: z.string().max(4000).nullish(), ownerId: uuid.nullish(), projectId: uuid.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveProduct(rctx(c, tx), null, b)), 201);
  })
  .put('/it/products/:id', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120), key: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/).nullish(), description: z.string().max(4000).nullish(), vision: z.string().max(4000).nullish(), ownerId: uuid.nullish(), projectId: uuid.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveProduct(rctx(c, tx), id(c), b)));
  })
  .post('/it/products/:id/share', async (c) => {
    const b = z.object({ on: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.shareRoadmap(rctx(c, tx), id(c), b.on)));
  })
  .get('/it/products/:id/roadmap', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pm.roadmap(rctx(c, tx), id(c)))))
  .post('/it/products/:id/items', async (c) => {
    const b = itemSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveItem(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/it/products/:id/items/:iid', async (c) => {
    const b = itemSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveItem(rctx(c, tx), id(c), id(c, 'iid'), b)));
  })
  .delete('/it/products/:id/items/:iid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pm.deleteItem(rctx(c, tx), id(c), id(c, 'iid')));
    return c.json({ ok: true });
  })
  .post('/it/products/:id/items/:iid/to-work', async (c) => {
    const b = z.object({ epic: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.itemToWork(rctx(c, tx), id(c), id(c, 'iid'), b.epic ?? false)), 201);
  })
  .post('/it/products/:id/requests', async (c) => {
    const b = requestSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveRequest(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/it/products/:id/requests/:qid', async (c) => {
    const b = requestSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.saveRequest(rctx(c, tx), id(c), id(c, 'qid'), b)));
  })
  .post('/it/products/:id/requests/:qid/triage', async (c) => {
    const b = z.object({ itemId: uuid.nullish(), newItem: z.boolean().optional(), decline: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pm.triageRequest(rctx(c, tx), id(c), id(c, 'qid'), b)));
  });
