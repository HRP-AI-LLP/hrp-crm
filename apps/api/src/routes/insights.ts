/**
 * Business health (KPIs against targets) and industry solutions.
 *   insightsRoutes      → /api/v1     KPIs and trends for the signed-in person
 *   insightsAdminRoutes → /api/admin  KPI targets, industry solutions (modules permission)
 */
import { KPI_BY_KEY } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { businessHealth, kpiTrend, PERIODS } from '../services/kpis';
import type { RecordCtx } from '../services/records';
import { installSolution, listSolutions } from '../services/solutions';

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

export const insightsRoutes = new Hono<AppEnv>()
  .get('/kpis', async (c) => {
    const period = z.enum(PERIODS).default('this_month').parse(c.req.query('period') ?? 'this_month');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => businessHealth(rctx(c, tx), period)));
  })
  .get('/kpis/trend', async (c) => {
    const keys = (c.req.query('keys') ?? '').split(',').filter((k) => KPI_BY_KEY[k]);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => kpiTrend(rctx(c, tx), keys)));
  });

export const insightsAdminRoutes = new Hono<AppEnv>()
  .put('/kpis/targets', requireAdmin('modules'), async (c) => {
    const b = z.object({ targets: z.record(z.string(), z.number().min(0).max(1e12).nullable()) }).parse(await c.req.json());
    for (const k of Object.keys(b.targets)) if (!KPI_BY_KEY[k]) throw badRequest(`Unknown KPI ${k}`);
    await c.var.db.tx(scope(c), async (tx) => {
      for (const [k, v] of Object.entries(b.targets)) {
        if (v === null) await tx.query(`delete from kpi_targets where tenant_id = $1 and kpi = $2`, [c.var.tenant.id, k]);
        else await tx.query(`insert into kpi_targets (tenant_id, kpi, target) values ($1,$2,$3) on conflict (tenant_id, kpi) do update set target = excluded.target`, [c.var.tenant.id, k, v]);
      }
    });
    return c.json({ ok: true });
  })
  .get('/solutions', requireAdmin('modules'), (c) => c.json({ items: listSolutions({ tx: null as never, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id }) }))
  .post('/solutions/:key/install', requireAdmin('modules'), async (c) => {
    const b = z.object({ overwrite: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const meta = { ...c.var.meta, modules: [...c.var.meta.modules] };
    const r = await c.var.db.tx(scope(c), (tx) => installSolution({ tx, meta, principal: c.var.principal, tenantId: c.var.tenant.id }, c.req.param('key'), b));
    return c.json(r);
  });
