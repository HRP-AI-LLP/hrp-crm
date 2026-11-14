/**
 * Manufacturing API (mounted at /api/v1): bills of materials, work centres, work orders, lots,
 * quality checks, job work, MRP and reports. Needs the Manufacturing app switched on. Access rules
 * live in services/manufacturing.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import { enqueue, eventJobs } from '../services/jobs';
import * as mf from '../services/manufacturing';
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
const qty = z.number().positive().max(1e9);
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 7)}-01`;

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
const qDate = (c: { req: { query: (k: string) => string | undefined } }, k: string, dflt: string) => dateStr.parse(c.req.query(k) ?? dflt);
const qUuid = (c: { req: { query: (k: string) => string | undefined } }, k: string) => {
  const v = c.req.query(k);
  return v ? uuid.parse(v) : null;
};

const workCenterSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  hoursPerDay: z.number().min(0.5).max(24),
  daysPerWeek: z.number().int().min(1).max(7),
  parallelUnits: z.number().int().min(1).max(1000),
  costPerHour: z.number().min(0).max(1e7),
  isActive: z.boolean().optional(),
});
const bomSchema = z.object({
  productId: uuid,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['manufacture', 'process', 'kit']).optional(),
  quantity: qty,
  yieldPct: z.number().min(1).max(100).optional(),
  requiresQc: z.boolean().optional(),
  notes: z.string().max(4000).nullish(),
  lines: z
    .array(
      z.object({
        kind: z.enum(['component', 'byproduct']).optional(),
        productId: uuid,
        quantity: qty,
        scrapPct: z.number().min(0).max(90).optional(),
        costSharePct: z.number().min(0).max(99).optional(),
        operationSeq: z.number().int().min(1).max(9999).nullish(),
      }),
    )
    .min(1)
    .max(300),
  operations: z
    .array(
      z.object({
        seq: z.number().int().min(1).max(9999),
        name: z.string().trim().min(1).max(120),
        workCenterId: uuid.nullish(),
        setupMinutes: z.number().min(0).max(100000).optional(),
        runMinutes: z.number().min(0).max(100000).optional(),
        subcontract: z.boolean().optional(),
        instructions: z.string().max(4000).nullish(),
      }),
    )
    .max(100),
});
const qcSchema = z.object({
  stage: z.enum(['incoming', 'in_process', 'final']),
  productId: uuid,
  workOrderId: uuid.nullish(),
  purchaseOrderId: uuid.nullish(),
  lotId: uuid.nullish(),
  qtyInspected: qty,
  qtyRejected: z.number().min(0).max(1e9).optional(),
  result: z.enum(['pass', 'fail', 'hold']),
  parameters: z.array(z.object({ name: z.string().trim().min(1).max(120), spec: z.string().max(200).nullish(), value: z.string().max(200).nullish(), ok: z.boolean().optional() })).max(50).optional(),
  notes: z.string().max(2000).nullish(),
});
const itemList = z.array(z.object({ productId: uuid, qty })).min(1).max(300);

export const manufacturingRoutes = new Hono<AppEnv>()
  .use('/mfg/*', async (c, next) => {
    if (!enabledApps(c.var.meta).has('manufacturing')) throw notFound('Manufacturing is switched off for the workspace');
    return next();
  })

  /* ───── overview and reports ───── */
  .get('/mfg/overview', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.overview(rctx(c, tx)))))
  .get('/mfg/reports/load', async (c) => {
    const weeks = z.coerce.number().int().min(1).max(26).parse(c.req.query('weeks') ?? 8);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => mf.workCenterLoad(rctx(c, tx), weeks)));
  })
  .get('/mfg/reports/production', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => mf.productionReport(rctx(c, tx), qDate(c, 'from', monthStart()), qDate(c, 'to', today())))),
  )
  .get('/mfg/reports/itc04', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.itc04(rctx(c, tx), qDate(c, 'from', monthStart()), qDate(c, 'to', today())))))

  /* ───── work centres ───── */
  .get('/mfg/work-centers', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.listWorkCenters(rctx(c, tx)))))
  .post('/mfg/work-centers', async (c) => {
    const b = workCenterSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.saveWorkCenter(rctx(c, tx), null, b)), 201);
  })
  .put('/mfg/work-centers/:id', async (c) => {
    const b = workCenterSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.saveWorkCenter(rctx(c, tx), id(c), b)));
  })

  /* ───── bills of materials ───── */
  .get('/mfg/boms', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.listBoms(rctx(c, tx), qUuid(c, 'productId')))))
  .get('/mfg/boms/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.getBom(rctx(c, tx), id(c)))))
  .get('/mfg/boms/:id/explode', async (c) => {
    const q = z.coerce.number().positive().max(1e9).parse(c.req.query('qty') ?? 1);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => mf.explode(rctx(c, tx), id(c), q)));
  })
  .post('/mfg/boms', async (c) => {
    const b = bomSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.saveBom(rctx(c, tx), null, b)), 201);
  })
  .put('/mfg/boms/:id', async (c) => {
    const b = bomSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.saveBom(rctx(c, tx), id(c), b)));
  })
  .post('/mfg/boms/:id/status', async (c) => {
    const b = z.object({ action: z.enum(['activate', 'archive', 'make_default']) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => mf.setBomStatus(rctx(c, tx), id(c), b.action));
    return c.json({ ok: true });
  })
  .post('/mfg/boms/:id/copy', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => mf.copyBom(rctx(c, tx), id(c))), 201))
  .get('/mfg/where-used/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.whereUsed(rctx(c, tx), id(c)))))

  /* ───── work orders ───── */
  .get('/mfg/work-orders/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.getWorkOrder(rctx(c, tx), id(c)))))
  .post('/mfg/work-orders/:id/release', async (c) => {
    const ev = await c.var.db.tx(scope(c), (tx) => mf.releaseWorkOrder(rctx(c, tx), id(c)));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/issue', async (c) => {
    const b = z.object({ remaining: z.boolean().optional(), items: z.array(z.object({ productId: uuid, qty, lotId: uuid.nullish() })).max(300).optional() }).parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.issueMaterials(rctx(c, tx), id(c), b.remaining ? 'remaining' : (b.items ?? [])));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/return', async (c) => {
    const b = z.object({ items: itemList }).parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.returnMaterials(rctx(c, tx), id(c), b.items));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/operations/:op', async (c) => {
    const b = z
      .object({ minutes: z.number().min(0).max(100000).optional(), qtyDone: z.number().min(0).max(1e9).optional(), status: z.enum(['in_progress', 'done']).optional(), operatorId: uuid.nullish() })
      .parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.recordOperation(rctx(c, tx), id(c), id(c, 'op'), b));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/produce', async (c) => {
    const b = z
      .object({ qty: z.number().min(0).max(1e9), scrapQty: z.number().min(0).max(1e9).optional(), lotNumber: z.string().trim().min(1).max(60).nullish(), expiryDate: dateStr.nullish(), note: z.string().max(500).nullish() })
      .parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.produce(rctx(c, tx), id(c), b));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/close', async (c) => {
    const ev = await c.var.db.tx(scope(c), (tx) => mf.closeWorkOrder(rctx(c, tx), id(c)));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/work-orders/:id/cancel', async (c) => {
    const ev = await c.var.db.tx(scope(c), (tx) => mf.cancelWorkOrder(rctx(c, tx), id(c)));
    await emit(c, ev);
    return c.json({ ok: true });
  })

  /* ───── lots and quality ───── */
  .get('/mfg/lots', async (c) => {
    const exp = c.req.query('expiringDays');
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        mf.listLots(rctx(c, tx), { productId: qUuid(c, 'productId'), expiringDays: exp ? z.coerce.number().int().min(0).max(3650).parse(exp) : null, includeEmpty: c.req.query('all') === '1' }),
      ),
    );
  })
  .post('/mfg/lots', async (c) => {
    const b = z.object({ productId: uuid, warehouseId: uuid, lotNumber: z.string().trim().min(1).max(60), qty, mfgDate: dateStr.nullish(), expiryDate: dateStr.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.registerLot(rctx(c, tx), b)), 201);
  })
  .post('/mfg/lots/:id/status', async (c) => {
    const b = z.object({ status: z.enum(['available', 'quarantine', 'rejected']) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => mf.setLotStatus(rctx(c, tx), id(c), b.status));
    return c.json({ ok: true });
  })
  .get('/mfg/lots/:id/trace', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.traceLot(rctx(c, tx), id(c)))))
  .get('/mfg/quality', async (c) => {
    const result = c.req.query('result');
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        mf.listQualityChecks(rctx(c, tx), { from: qDate(c, 'from', monthStart()), to: qDate(c, 'to', today()), result: result ? z.enum(['pass', 'fail', 'hold']).parse(result) : null }),
      ),
    );
  })
  .post('/mfg/quality', async (c) => {
    const b = qcSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.recordQualityCheck(rctx(c, tx), b)), 201);
  })

  /* ───── job work ───── */
  .get('/mfg/job-works/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.getJobWork(rctx(c, tx), id(c)))))
  .put('/mfg/job-works/:id/lines', async (c) => {
    const b = z.object({ lines: z.array(z.object({ productId: uuid, quantity: qty })).min(1).max(100) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => mf.saveJobWorkLines(rctx(c, tx), id(c), b.lines));
    return c.json({ ok: true });
  })
  .post('/mfg/job-works/:id/send', async (c) => {
    const b = z.object({ date: dateStr.nullish() }).parse(await c.req.json().catch(() => ({})));
    const ev = await c.var.db.tx(scope(c), (tx) => mf.sendJobWork(rctx(c, tx), id(c), b));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/job-works/:id/receive', async (c) => {
    const b = z
      .object({
        outputQty: z.number().min(0).max(1e9),
        consumed: z.array(z.object({ productId: uuid, qty: z.number().min(0).max(1e9) })).max(100).optional(),
        returned: z.array(z.object({ productId: uuid, qty: z.number().min(0).max(1e9) })).max(100).optional(),
        date: dateStr.nullish(),
        lotNumber: z.string().trim().min(1).max(60).nullish(),
        challanRef: z.string().trim().max(60).nullish(),
      })
      .parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.receiveJobWork(rctx(c, tx), id(c), b));
    await emit(c, ev);
    return c.json({ ok: true });
  })
  .post('/mfg/job-works/:id/close', async (c) => {
    const b = z.object({ reason: z.string().trim().min(1).max(300) }).parse(await c.req.json());
    const ev = await c.var.db.tx(scope(c), (tx) => mf.closeJobWork(rctx(c, tx), id(c), b.reason));
    await emit(c, ev);
    return c.json({ ok: true });
  })

  /* ───── MRP ───── */
  .get('/mfg/mrp', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mf.getMrpRun(rctx(c, tx), qUuid(c, 'runId')))))
  .post('/mfg/mrp/run', async (c) => {
    const b = z.object({ horizonDays: z.number().int().min(1).max(365), includeReorder: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mf.runMrp(rctx(c, tx), b)), 201);
  })
  .post('/mfg/mrp/:id/act', async (c) => {
    const b = z
      .object({ lineIds: z.array(uuid).min(1).max(500), overrides: z.record(uuid, z.object({ qty: qty.optional(), vendorId: uuid.nullish() })).optional() })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => mf.actOnMrp(rctx(c, tx), id(c), b.lineIds, b.overrides ?? {}));
    await emit(c, r.events);
    return c.json({ created: r.created });
  })
  .post('/mfg/mrp/:id/ignore', async (c) => {
    const b = z.object({ lineIds: z.array(uuid).min(1).max(500) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => mf.ignoreMrpLines(rctx(c, tx), id(c), b.lineIds));
    return c.json({ ok: true });
  });
