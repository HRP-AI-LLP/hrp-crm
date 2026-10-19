/**
 * Tally sync.
 *   tallyAdminRoutes  → /api/admin  connect, settings, status, retry (billing permission)
 *   tallyPublicRoutes → /api/public the connector on the accountant's PC (token in Authorization)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { enabledApps } from '../services/apps';
import type { Integration } from '../services/integrations';
import { enqueue, eventJobs } from '../services/jobs';
import { appOrigin } from '../services/mailer';
import { actAs, systemCtxFor } from '../services/system';
import { ackFromTally, connectTally, pendingForTally, receiptsFromTally, tallyStatus, updateTallyConfig, verifyConnector } from '../services/tally';
import { resolveRoute, safeCtx } from './public';

export const tallyAdminRoutes = new Hono<AppEnv>()
  .use('/tally/*', requireAdmin('billing'))
  .use('/tally', requireAdmin('billing'))
  .get('/tally', async (c) => {
    const st = await c.var.db.tx(scope(c, true), (tx) => tallyStatus(tx, c.var.tenant.id));
    return c.json({ connected: !!st, billingOn: enabledApps(c.var.meta).has('billing'), ...(st ? { ...st, connectorUrl: `${appOrigin(c.env, c.req.url)}/api/public/tally/${st.routeKey}` } : {}) });
  })
  .post('/tally/connect', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => connectTally(c.env, tx, c.var.tenant.id));
    return c.json({ token: r.token, connectorUrl: `${appOrigin(c.env, c.req.url)}/api/public/tally/${r.routeKey}` });
  })
  .patch('/tally', async (c) => {
    const b = z
      .object({ syncFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), pushReceipts: z.boolean().optional(), importReceipts: z.boolean().optional(), ledgerParent: z.string().trim().min(1).max(100).optional(), companyName: z.string().trim().max(200).nullish() })
      .parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => updateTallyConfig(tx, c.var.tenant.id, b));
    return c.json({ ok: true });
  })
  .post('/tally/retry', async (c) => {
    const b = z.object({ includeAttention: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const n = await c.var.db.tx(scope(c), (tx) =>
      tx.query(`update tally_sync set status = 'pending', error = null where tenant_id = $1 and status = any($2::text[]) returning 1`, [c.var.tenant.id, b.includeAttention ? ['failed', 'needs_attention'] : ['failed']]),
    );
    return c.json({ requeued: n.length });
  })
  .delete('/tally', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`update integrations set status = 'disabled', secret_ciphertext = null where tenant_id = $1 and provider = 'tally'`, [c.var.tenant.id]));
    return c.json({ ok: true });
  });

/** The connector's calls: the route key finds the workspace, the token proves it is the connector. */
async function connector(c: Parameters<typeof resolveRoute>[0] & { env: AppEnv['Bindings']; req: { param(k: string): string; header(k: string): string | undefined } }) {
  const route = await resolveRoute(c, 'integration', c.req.param('key'));
  const i = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'tally' and status <> 'disabled'`, [route.tenant_id, route.target_id]));
  if (!i) throw notFound();
  await verifyConnector(c.env, i, c.req.header('authorization'));
  return i;
}

/** Work runs as the person who connected Tally (accounts), else the workspace owner. */
async function connectorCtx(env: AppEnv['Bindings'], tx: Parameters<typeof systemCtxFor>[1], i: Integration) {
  const ctx = (i.created_by ? await actAs(env, tx, i.tenant_id, i.created_by, 'tally') : null) ?? (await systemCtxFor(env, tx, i.tenant_id));
  if (!ctx) throw notFound();
  return ctx;
}

export const tallyPublicRoutes = new Hono<AppEnv>()
  .get('/tally/:key/hello', async (c) => {
    const i = await connector(c);
    const out = await c.var.db.tx({ tenantId: i.tenant_id, readOnly: true }, async (tx) => {
      const t = await tx.one<{ name: string }>(`select name from tenants where id = $1`, [i.tenant_id]);
      return { workspace: t?.name, config: i.config };
    });
    return c.json(out);
  })
  .post('/tally/:key/pull', async (c) => {
    const i = await connector(c);
    const b = z.object({ limit: z.number().int().min(1).max(100).default(50) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx({ tenantId: i.tenant_id, userId: i.created_by }, async (tx) => pendingForTally(await connectorCtx(c.env, tx, i), i, b.limit)));
  })
  .post('/tally/:key/ack', async (c) => {
    const i = await connector(c);
    const b = z.object({ results: z.array(z.object({ kind: z.enum(['ledger', 'sales', 'credit_note', 'receipt']), id: z.string().uuid(), ok: z.boolean(), error: z.string().max(1000).nullish() })).max(200) }).parse(await c.req.json());
    return c.json(await c.var.db.tx({ tenantId: i.tenant_id, userId: i.created_by }, (tx) => ackFromTally(tx, i.tenant_id, i, b.results)));
  })
  .post('/tally/:key/receipts', async (c) => {
    const i = await connector(c);
    const b = z
      .object({
        receipts: z
          .array(
            z.object({
              guid: z.string().min(4).max(200),
              remoteId: z.string().max(200).nullish(),
              date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              number: z.string().max(100).nullish(),
              party: z.string().trim().min(1).max(300),
              amount: z.number().positive().max(1e11),
              narration: z.string().max(2000).nullish(),
              bills: z.array(z.object({ name: z.string().max(100), amount: z.number().min(0) })).max(50).optional(),
            }),
          )
          .max(200),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx({ tenantId: i.tenant_id, userId: i.created_by }, async (tx) => receiptsFromTally(await connectorCtx(c.env, tx, i), i, b.receipts));
    await enqueue(c.env, safeCtx(c), eventJobs(i.tenant_id, i.created_by, r.events));
    return c.json({ imported: r.imported, skipped: r.skipped, unmatched: r.unmatched });
  });
