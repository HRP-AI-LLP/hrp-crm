/**
 * Delivery & installation, service desk.
 *   fieldRoutes        → /api/v1
 *   serviceAdminRoutes → /api/admin  (SLA policies, installation checklist template)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { enabledApps } from '../services/apps';
import {
  cancelJob,
  cancelShipment,
  completeJob,
  deliverShipment,
  dispatchShipment,
  failShipment,
  getInstallation,
  getShipment,
  holdJob,
  packShipment,
  planShipment,
  saveChecklist,
  scheduleInstallation,
  setCrew,
  startJob,
} from '../services/delivery';
import { enqueue, eventJobs } from '../services/jobs';
import { listRecords, loadRow, type RecordCtx, type RecordEvent } from '../services/records';
import { serviceInsights } from '../services/service';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
function requireApp(c: { var: AppEnv['Variables'] }, app: string) {
  if (!enabledApps(c.var.meta).has(app)) throw notFound('This app is switched off for the workspace');
}
async function emit(c: Parameters<typeof safeCtx>[0] & { env: AppEnv['Bindings']; var: AppEnv['Variables'] }, events: RecordEvent[]) {
  await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}

const ISSUES = ['site_not_ready', 'customer_unavailable', 'missing_parts', 'damaged_item', 'measurement_mismatch', 'other'] as const;

export const fieldRoutes = new Hono<AppEnv>()
  // ============================================================================ deliveries
  .get('/shipments/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getShipment(rctx(c, tx), c.req.param('id')))))
  .post('/orders/:id/shipments', async (c) => {
    requireApp(c, 'delivery');
    const b = z
      .object({
        lines: z.array(z.object({ orderLineId: uuid, quantity: z.number().positive() })).max(300).nullish(),
        plannedDate: dateStr.nullish(),
        carrier: z.string().max(120).nullish(),
        vehicleNo: z.string().max(30).nullish(),
        driverName: z.string().max(120).nullish(),
        driverPhone: z.string().max(30).nullish(),
        notes: z.string().max(2000).nullish(),
        ownerId: uuid.nullish(),
      })
      .parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => planShipment(rctx(c, tx), c.req.param('id'), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .post('/shipments/:id/pack', async (c) => {
    await emit(c, await c.var.db.tx(scope(c), (tx) => packShipment(rctx(c, tx), c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/shipments/:id/dispatch', async (c) => {
    const b = z.object({ vehicleNo: z.string().max(30).nullish(), driverName: z.string().max(120).nullish(), driverPhone: z.string().max(30).nullish(), trackingRef: z.string().max(120).nullish() }).parse(await c.req.json().catch(() => ({})));
    await emit(c, await c.var.db.tx(scope(c), (tx) => dispatchShipment(rctx(c, tx), c.req.param('id'), b)));
    return c.json({ ok: true });
  })
  .post('/shipments/:id/deliver', async (c) => {
    const b = z.object({ receivedBy: z.string().trim().max(120).nullish(), notes: z.string().max(2000).nullish() }).parse(await c.req.json().catch(() => ({})));
    await emit(c, await c.var.db.tx(scope(c), (tx) => deliverShipment(rctx(c, tx), c.req.param('id'), b.receivedBy ?? null, b.notes ?? null)));
    return c.json({ ok: true });
  })
  .post('/shipments/:id/fail', async (c) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => failShipment(rctx(c, tx), c.req.param('id'), b.reason)));
    return c.json({ ok: true });
  })
  .post('/shipments/:id/cancel', async (c) => {
    await emit(c, await c.var.db.tx(scope(c), (tx) => cancelShipment(rctx(c, tx), c.req.param('id'))));
    return c.json({ ok: true });
  })

  // ============================================================================ installations
  .get('/installations/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getInstallation(rctx(c, tx), c.req.param('id')))))
  .post('/installations', async (c) => {
    requireApp(c, 'delivery');
    const b = z
      .object({
        orderId: uuid.nullish(),
        shipmentId: uuid.nullish(),
        name: z.string().trim().max(200).nullish(),
        start: iso,
        end: iso.nullish(),
        technicianId: uuid,
        crewIds: z.array(uuid).max(10).default([]),
        siteAddress: z.string().max(1000).nullish(),
        contactPhone: z.string().max(30).nullish(),
        checklist: z.array(z.string().trim().min(1).max(200)).max(30).nullish(),
      })
      .parse(await c.req.json());
    if (b.end && b.end < b.start) throw badRequest('The job cannot end before it starts');
    const r = await c.var.db.tx(scope(c), (tx) => scheduleInstallation(rctx(c, tx), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .put('/installations/:id/crew', async (c) => {
    const b = z.object({ crewIds: z.array(uuid).max(10) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setCrew(rctx(c, tx), c.req.param('id'), b.crewIds)));
  })
  .put('/installations/:id/checklist', async (c) => {
    const b = z.object({ items: z.array(z.object({ label: z.string().trim().min(1).max(200), done: z.boolean() })).max(30) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => saveChecklist(rctx(c, tx), c.req.param('id'), b.items)));
  })
  .post('/installations/:id/start', async (c) => {
    await emit(c, await c.var.db.tx(scope(c), (tx) => startJob(rctx(c, tx), c.req.param('id'))));
    return c.json({ ok: true });
  })
  .post('/installations/:id/hold', async (c) => {
    const b = z.object({ issueType: z.enum(ISSUES), notes: z.string().trim().min(3).max(2000) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => holdJob(rctx(c, tx), c.req.param('id'), b.issueType, b.notes)));
    return c.json({ ok: true });
  })
  .post('/installations/:id/complete', async (c) => {
    const b = z.object({ notes: z.string().max(4000).nullish() }).parse(await c.req.json().catch(() => ({})));
    await emit(c, await c.var.db.tx(scope(c), (tx) => completeJob(rctx(c, tx), c.req.param('id'), b.notes ?? null)));
    return c.json({ ok: true });
  })
  .post('/installations/:id/cancel', async (c) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => cancelJob(rctx(c, tx), c.req.param('id'), b.reason)));
    return c.json({ ok: true });
  })

  /** Field schedule: installations and deliveries in a date range (each list permission-scoped). */
  .get('/field/schedule', async (c) => {
    const q = z.object({ from: iso, to: iso, owner: uuid.optional() }).parse(c.req.query());
    const apps = enabledApps(c.var.meta);
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const own = q.owner ? [{ field: 'owner_id', op: 'eq', value: q.owner }] : [];
      const jobs = apps.has('delivery')
        ? (await listRecords(ctx, 'installation', { filters: [{ field: 'scheduled_start', op: 'gte', value: q.from }, { field: 'scheduled_start', op: 'lt', value: q.to }, ...own], sort: 'scheduled_start', dir: 'asc', limit: 200 })).items
        : [];
      const drops = apps.has('delivery')
        ? (await listRecords(ctx, 'shipment', { filters: [{ field: 'planned_date', op: 'gte', value: q.from.slice(0, 10) }, { field: 'planned_date', op: 'lte', value: q.to.slice(0, 10) }, ...own], sort: 'planned_date', dir: 'asc', limit: 200 })).items
        : [];
      return { installations: jobs, shipments: drops };
    });
    return c.json(out);
  })

  // ============================================================================ service
  .get('/insights/service', async (c) => {
    requireApp(c, 'service');
    const days = z.coerce.number().int().min(7).max(365).default(30).parse(c.req.query('days') ?? 30);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => serviceInsights(rctx(c, tx), days)));
  })
  .get('/tickets/:id/link', async (c) => {
    const r = await c.var.db.tx(scope(c, true), async (tx) => (await loadRow(rctx(c, tx), 'ticket', c.req.param('id'), 'read')).row);
    return c.json({ link: `${new URL(c.req.url).origin}/t/${r.share_token}` });
  });

const slaSchema = z.object({
  name: z.string().trim().min(1).max(120),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).nullish(),
  category: z.string().max(40).nullish(),
  firstResponseMinutes: z.number().int().min(5).max(525_600),
  resolutionMinutes: z.number().int().min(15).max(525_600),
  isActive: z.boolean().default(true),
});

export const serviceAdminRoutes = new Hono<AppEnv>()
  .get('/sla-policies', requireAdmin('workflows'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select * from sla_policies where tenant_id = $1 order by priority nulls last, category nulls last, name`, [c.var.tenant.id])) }),
  )
  .post('/sla-policies', requireAdmin('workflows'), async (c) => {
    const b = slaSchema.parse(await c.req.json());
    if (b.resolutionMinutes < b.firstResponseMinutes) throw badRequest('Resolution time must be at least the first-response time');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into sla_policies (tenant_id, name, priority, category, first_response_minutes, resolution_minutes, is_active) values ($1,$2,$3,$4,$5,$6,$7) returning *`, [
        c.var.tenant.id, b.name, b.priority ?? null, b.category ?? null, b.firstResponseMinutes, b.resolutionMinutes, b.isActive,
      ]),
    );
    return c.json(row, 201);
  })
  .put('/sla-policies/:id', requireAdmin('workflows'), async (c) => {
    const b = slaSchema.parse(await c.req.json());
    if (b.resolutionMinutes < b.firstResponseMinutes) throw badRequest('Resolution time must be at least the first-response time');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update sla_policies set name=$3, priority=$4, category=$5, first_response_minutes=$6, resolution_minutes=$7, is_active=$8 where tenant_id=$1 and id=$2 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), b.name, b.priority ?? null, b.category ?? null, b.firstResponseMinutes, b.resolutionMinutes, b.isActive,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/sla-policies/:id', requireAdmin('workflows'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from sla_policies where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })
  .get('/installation-checklist', requireAdmin('workflows'), async (c) =>
    c.json({ items: (await c.var.db.tx(scope(c, true), (tx) => tx.one<{ c: string[] | null }>(`select settings -> 'installation' -> 'checklist' as c from tenants where id = $1`, [c.var.tenant.id])))?.c ?? null }),
  )
  .put('/installation-checklist', requireAdmin('workflows'), async (c) => {
    const b = z.object({ items: z.array(z.string().trim().min(1).max(200)).max(30) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`update tenants set settings = jsonb_set(settings, '{installation}', coalesce(settings -> 'installation', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify({ checklist: b.items })]));
    return c.json(b);
  });

