/**
 * Developer platform.
 *   developerRoutes      → /api/v1     OpenAPI for this workspace, event catalog, REST hooks (for Zapier / Make / n8n / code)
 *   developerAdminRoutes → /api/admin  webhook delivery log, redelivery, test ping
 */
import { hasAdmin } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enqueue } from '../services/jobs';
import { appOrigin } from '../services/mailer';
import { eventCatalog, openApi } from '../services/openapi';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const canHooks = (c: { var: AppEnv['Variables'] }) => hasAdmin(c.var.principal.permissions, 'developers') || hasAdmin(c.var.principal.permissions, 'channels');
function requireHooks(c: { var: AppEnv['Variables'] }) {
  if (!canHooks(c)) throw forbidden('Managing webhooks needs the developers (or channels) admin permission');
}
/** Webhook targets must be public HTTPS hosts (no private networks or this platform). */
export function assertHookUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('Enter a valid URL');
  }
  if (u.protocol !== 'https:') throw badRequest('Webhook URLs must use https');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(\d+\.){3}\d+$/.test(h) || h.includes(':') || h.endsWith('hrpai.in')) throw badRequest('Use a public host name for webhooks');
  return u.toString();
}

export const developerRoutes = new Hono<AppEnv>()
  .get('/openapi.json', (c) => c.json(openApi(c.var.meta, c.var.principal.permissions, appOrigin(c.env, c.req.url))))
  .get('/webhook-events', (c) => c.json({ items: eventCatalog(c.var.meta) }))
  .get('/hooks', async (c) => {
    requireHooks(c);
    return c.json({
      items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select id, name, url, events, is_enabled, failure_count, last_delivery_at, last_status, created_at from webhook_subscriptions where tenant_id = $1 order by created_at desc`, [c.var.tenant.id])),
    });
  })
  .post('/hooks', async (c) => {
    requireHooks(c);
    const b = z.object({ url: z.string().max(2000), events: z.array(z.string().regex(/^(\*|[a-z_]{2,40}\.(created|updated|stage_changed|deleted))$/)).min(1).max(50), name: z.string().trim().max(120).optional() }).parse(await c.req.json());
    const url = assertHookUrl(b.url);
    const known = new Set(eventCatalog(c.var.meta).map((e) => e.event));
    const bad = b.events.filter((e) => e !== '*' && !known.has(e));
    if (bad.length) throw badRequest(`Unknown events: ${bad.join(', ')}`);
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const n = await tx.one<{ n: number }>(`select count(*)::int as n from webhook_subscriptions where tenant_id = $1`, [c.var.tenant.id]);
      if ((n?.n ?? 0) >= 50) throw badRequest('At most 50 webhook subscriptions per workspace');
      return tx.one(`insert into webhook_subscriptions (tenant_id, url, events, name) values ($1,$2,$3,$4) returning id, url, events, name, secret`, [c.var.tenant.id, url, b.events, b.name ?? null]);
    });
    // the signing secret is shown once
    return c.json(row, 201);
  })
  .delete('/hooks/:id', async (c) => {
    requireHooks(c);
    const r = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from webhook_subscriptions where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!r.length) throw notFound();
    return c.json({ ok: true });
  })
  .patch('/hooks/:id', async (c) => {
    requireHooks(c);
    const b = z.object({ enabled: z.boolean() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`update webhook_subscriptions set is_enabled = $3, failure_count = case when $3 then 0 else failure_count end where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id')), b.enabled]));
    return c.json({ ok: true });
  })
  .get('/hooks/:id/deliveries', async (c) => {
    requireHooks(c);
    return c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(`select id, event, status_code, ok, duration_ms, error, attempt, redelivery_of, created_at, payload from webhook_deliveries where tenant_id = $1 and subscription_id = $2 order by created_at desc limit 100`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]),
      ),
    });
  })
  .post('/hooks/:id/test', async (c) => {
    requireHooks(c);
    const id = uuid.parse(c.req.param('id'));
    const sub = await c.var.db.tx(scope(c, true), (tx) => tx.one(`select 1 from webhook_subscriptions where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]));
    if (!sub) throw notFound();
    await enqueue(c.env, safeCtx(c), [{ type: 'webhook.deliver', tenantId: c.var.tenant.id, subscriptionId: id, event: 'ping', payload: { message: 'Test delivery from HRP Synapse' }, redeliveryOf: id }]);
    return c.json({ ok: true });
  })
  .post('/webhook-deliveries/:id/redeliver', async (c) => {
    requireHooks(c);
    const id = uuid.parse(c.req.param('id'));
    const d = await c.var.db.tx(scope(c, true), (tx) => tx.one<{ subscription_id: string; event: string; payload: unknown; attempt: number }>(`select subscription_id, event, payload, attempt from webhook_deliveries where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]));
    if (!d) throw notFound();
    await enqueue(c.env, safeCtx(c), [{ type: 'webhook.deliver', tenantId: c.var.tenant.id, subscriptionId: d.subscription_id, event: d.event, payload: d.payload, redeliveryOf: id, deliveryId: id, attempt: d.attempt }]);
    return c.json({ ok: true });
  });
