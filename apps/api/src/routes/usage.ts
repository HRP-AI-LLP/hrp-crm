/**
 * Settings → Usage & costs (mounted at /api/admin).
 *   scope=workspace — this workspace's usage (workspace admins)
 *   scope=platform  — the whole platform, the price list and the busiest workspaces (platform admins)
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireAdmin } from '../middleware';
import { assertPlatformAdmin, isPlatformAdmin } from '../services/connection-keys';
import * as us from '../services/usage';

const q = z.object({ scope: z.enum(['platform', 'workspace']).default('workspace'), months: z.coerce.number().int().min(1).max(24).default(6) });

async function report(c: Context<AppEnv>) {
  const o = q.parse({ scope: c.req.query('scope') ?? undefined, months: c.req.query('months') ?? undefined });
  if (o.scope === 'platform') await assertPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal);
  // the bills are this workspace's (the company running the platform records its suppliers' bills in its own books)
  const bills = await c.var.db.tx({ tenantId: c.var.tenant.id, userId: c.var.principal.user.id, readOnly: true }, (tx) => us.booksBills(tx, c.var.tenant.id, o.months)).catch(() => []);
  const r = await us.usageReport(c.var.db, { tenantKey: o.scope === 'platform' ? null : c.var.tenant.id, months: o.months, bills });
  return { o, r };
}

export const usageRoutes = new Hono<AppEnv>()
  .use('/costs', requireAdmin('metadata'))
  .use('/costs/*', requireAdmin('metadata'))
  .get('/costs', async (c) => {
    const { o, r } = await report(c);
    const platformAdmin = await isPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal);
    return c.json({ scope: o.scope, platformAdmin, ...r, workspaces: o.scope === 'platform' ? await us.topWorkspaces(c.var.db) : [] });
  })
  .get('/costs/export.csv', async (c) => {
    const { o, r } = await report(c);
    return c.body(us.reportCsv(r), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="usage-${o.scope}-${r.current}.csv"` });
  })
  .put('/costs/prices', async (c) => {
    await assertPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal);
    const b = us.pricesSchema.parse(await c.req.json());
    return c.json(await us.savePrices(c.var.db, c.var.principal.user.id, b));
  })
  .delete('/costs/prices', async (c) => {
    // back to the default price list
    await assertPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal);
    await c.var.db.platform(`delete from usage_prices where id = 1`);
    return c.json(await us.getPrices(c.var.db));
  });
