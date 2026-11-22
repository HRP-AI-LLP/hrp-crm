/**
 * Settings → Connection keys.
 *   scope=platform  — platform admins: the keys every workspace shares (OAuth apps, GitHub App …)
 *   scope=workspace — workspace admins: keys a workspace may set for itself (its own GSP account)
 */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest } from '../lib/errors';
import { requireAdmin } from '../middleware';
import * as ck from '../services/connection-keys';
import { POLL_KEY } from '../services/cron-plan';

const scopeOf = (v: string | undefined) => z.enum(['platform', 'workspace']).parse(v ?? 'platform');

async function guard(c: Context<AppEnv>, scope: ck.Scope) {
  if (scope === 'platform') await ck.assertPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal);
}

async function audit(c: Context<AppEnv>, scope: ck.Scope, what: Record<string, unknown>) {
  await c.var.db
    .tx({ tenantId: c.var.tenant.id, userId: c.var.principal.user.id }, (tx) =>
      tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, changes) values ($1, $2, 'update', $3, $4)`, [c.var.tenant.id, c.var.principal.user.id, scope === 'platform' ? 'platform_keys' : 'connection_keys', JSON.stringify(what)]),
    )
    .catch(() => undefined);
}

export const connectionKeyRoutes = new Hono<AppEnv>()
  .use('/connection-keys', requireAdmin('channels'))
  .use('/connection-keys/*', requireAdmin('channels'))
  .use('/platform-admins', requireAdmin('channels'))
  .use('/platform-admins/*', requireAdmin('channels'))
  .get('/connection-keys/me', async (c) => c.json({ platformAdmin: await ck.isPlatformAdmin(c.env, c.var.db, c.var.tenant, c.var.principal) }))
  .get('/connection-keys', async (c) => {
    const scope = scopeOf(c.req.query('scope'));
    await guard(c, scope);
    return c.json(await ck.describeKeys(c.env, c.var.db, scope, c.var.tenant.id));
  })
  .put('/connection-keys', async (c) => {
    const b = z.object({ scope: z.enum(['platform', 'workspace']), values: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,60}$/), z.string().max(20_000).nullable()) }).parse(await c.req.json());
    await guard(c, b.scope);
    const out = await ck.saveKeys(c.env, c.var.db, b.scope, c.var.tenant.id, c.var.principal.user.id, b.values);
    // the 5-minute cron reads this one from KV, before it decides to wake the database
    if (b.scope === 'platform' && 'CRON_POLL_MINUTES' in b.values) {
      const v = b.values.CRON_POLL_MINUTES;
      await (v ? c.env.CACHE_KV?.put(POLL_KEY, v) : c.env.CACHE_KV?.delete(POLL_KEY))?.catch(() => undefined);
    }
    // never the values themselves
    await audit(c, b.scope, { keys: Object.fromEntries(Object.entries(b.values).map(([k, v]) => [k, v ? 'set' : 'removed'])) });
    return c.json(out);
  })
  .post('/connection-keys/test', async (c) => {
    const b = z.object({ scope: z.enum(['platform', 'workspace']), group: z.string().max(40) }).parse(await c.req.json());
    await guard(c, b.scope);
    // the platform check uses the platform's values only; the workspace check what this workspace uses
    const env = b.scope === 'platform' ? await ck.withPlatformKeys(ck.rawEnv(c.env), c.var.db) : await ck.withTenantKeys(await ck.withPlatformKeys(ck.rawEnv(c.env), c.var.db), c.var.db, c.var.tenant.id);
    return c.json(await ck.testGroup(env, b.group));
  })
  .post('/connection-keys/generate', async (c) => {
    const b = z.object({ kind: z.enum(['vapid', 'random']) }).parse(await c.req.json());
    return c.json(b.kind === 'vapid' ? await ck.vapidPair() : { value: ck.randomSecret() });
  })
  .get('/platform-admins', async (c) => {
    await guard(c, 'platform');
    return c.json({ items: await ck.listPlatformAdmins(c.var.db, c.var.tenant.id) });
  })
  .put('/platform-admins/:uid', async (c) => {
    await guard(c, 'platform');
    const b = z.object({ admin: z.boolean() }).parse(await c.req.json());
    const uid = z.string().uuid().safeParse(c.req.param('uid'));
    if (!uid.success) throw badRequest('Bad user id');
    const out = await ck.setPlatformAdmin(c.var.db, c.var.tenant, c.var.principal, uid.data, b.admin);
    await audit(c, 'platform', { platformAdmin: uid.data, admin: b.admin });
    return c.json(out);
  });
