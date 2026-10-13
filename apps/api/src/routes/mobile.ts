/**
 * Installable app (PWA) support → /api/v1
 *   push/config, push/subscriptions  — Web Push enrolment per device
 *   push/test                        — sends a test notification to the caller's devices
 *   field/today                      — the mobile home: my day in one call
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import { listRecords, type RecordCtx } from '../services/records';
import { isPushEndpoint, pushEnabled, sendPush } from '../services/webpush';

const iso = z.string().datetime({ offset: true });

const subSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(1000)
    .refine((u) => u.startsWith('https://'), 'Push endpoints must be https'),
  keys: z.object({ p256dh: z.string().min(80).max(100), auth: z.string().min(16).max(30) }),
  label: z.string().trim().max(120).nullish(),
});

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

/** Lists that the caller may not read just come back empty (field staff rarely see every object). */
async function maybe<T>(work: () => Promise<T[]>): Promise<T[]> {
  try {
    return await work();
  } catch {
    return [];
  }
}

export const mobileRoutes = new Hono<AppEnv>()
  .get('/push/config', async (c) => {
    const me = c.var.principal.user.id;
    const devices = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query<{ id: string; label: string | null; created_at: string; last_success_at: string | null; endpoint_host: string }>(
        `select id, label, created_at, last_success_at, split_part(split_part(endpoint, '://', 2), '/', 1) as endpoint_host
           from push_subscriptions where tenant_id = $1 and user_id = $2 order by created_at desc`,
        [c.var.tenant.id, me],
      ),
    );
    return c.json({ enabled: pushEnabled(c.env), publicKey: pushEnabled(c.env) ? c.env.VAPID_PUBLIC_KEY : null, devices });
  })
  .post('/push/subscriptions', async (c) => {
    if (!pushEnabled(c.env)) throw badRequest('Push notifications are not configured on this server');
    const body = subSchema.parse(await c.req.json());
    if (!isPushEndpoint(body.endpoint, c.env)) throw badRequest('This is not a browser push service address');
    const ua = (c.req.header('user-agent') ?? '').slice(0, 300);
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const n = await tx.one<{ n: number }>(
        `select count(*)::int as n from push_subscriptions where tenant_id = $1 and user_id = $2 and endpoint <> $3`,
        [c.var.tenant.id, c.var.principal.user.id, body.endpoint],
      );
      if ((n?.n ?? 0) >= 20) throw badRequest('Too many devices registered — remove one first');
      // a device re-subscribing (or a shared device after sign-in by someone else) replaces its row
      return tx.one<{ id: string }>(
        `insert into push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, label, user_agent)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (tenant_id, endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
           label = coalesce(excluded.label, push_subscriptions.label), user_agent = excluded.user_agent, failures = 0
         returning id`,
        [c.var.tenant.id, c.var.principal.user.id, body.endpoint, body.keys.p256dh, body.keys.auth, body.label ?? null, ua],
      );
    });
    return c.json(row, 201);
  })
  .delete('/push/subscriptions/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from push_subscriptions where tenant_id = $1 and user_id = $2 and id = $3::uuid`, [c.var.tenant.id, c.var.principal.user.id, c.req.param('id')]));
    return c.body(null, 204);
  })
  /** Signing out on a device: drop its subscription by endpoint so the next user isn't notified. */
  .post('/push/unsubscribe', async (c) => {
    const { endpoint } = z.object({ endpoint: z.string().max(2000) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from push_subscriptions where tenant_id = $1 and user_id = $2 and endpoint = $3`, [c.var.tenant.id, c.var.principal.user.id, endpoint]));
    return c.body(null, 204);
  })
  .post('/push/test', async (c) => {
    if (!pushEnabled(c.env)) throw badRequest('Push notifications are not configured on this server');
    const subs = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(`select id, endpoint, p256dh, auth from push_subscriptions where tenant_id = $1 and user_id = $2`, [c.var.tenant.id, c.var.principal.user.id]),
    );
    let sent = 0;
    for (const s of subs) if ((await sendPush(c.env, s, { title: 'HRP Synapse', body: 'Notifications are working on this device.', link: '/field', tag: 'test' })) === 'ok') sent++;
    return c.json({ devices: subs.length, sent });
  })

  // ============================================================================ my day
  .get('/field/today', async (c) => {
    const q = z.object({ from: iso, to: iso }).parse(c.req.query());
    if (Date.parse(q.to) - Date.parse(q.from) > 3 * 86400_000 || Date.parse(q.to) <= Date.parse(q.from)) throw badRequest('Pick a range of up to three days');
    const me = c.var.principal.user.id;
    const tid = c.var.tenant.id;
    const apps = enabledApps(c.var.meta);
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const mine = { field: 'owner_id', op: 'eq', value: me };
      const tasks = await tx.query(
        `select id, title, status, priority, due_at, related_object, related_id from tasks
          where tenant_id = $1 and assignee_id = $2 and status in ('open', 'in_progress') and due_at < $3::timestamptz
          order by due_at limit 50`,
        [tid, me, q.to],
      );
      const events = await tx.query(
        `select id, title, kind, starts_at, ends_at, location, status, related_object, related_id from events
          where tenant_id = $1 and owner_id = $2 and status = 'scheduled' and starts_at < $4::timestamptz and ends_at >= $3::timestamptz
          order by starts_at limit 50`,
        [tid, me, q.from, q.to],
      );
      const followUps = (
        await maybe(async () =>
          (await listRecords(ctx, 'lead', { filters: [mine, { field: 'next_follow_up_at', op: 'lt', value: q.to }], sort: 'next_follow_up_at', dir: 'asc', limit: 50 })).items as Record<string, unknown>[],
        )
      ).filter((l) => !l.converted_at);
      const installations = apps.has('delivery')
        ? await maybe(async () =>
            (
              await listRecords(ctx, 'installation', {
                filters: [mine, { field: 'scheduled_start', op: 'lt', value: q.to }, { field: 'status', op: 'in', value: ['scheduled', 'in_progress', 'on_hold'] }],
                sort: 'scheduled_start',
                dir: 'asc',
                limit: 50,
              })
            ).items,
          )
        : [];
      const shipments = apps.has('delivery')
        ? await maybe(async () =>
            (
              await listRecords(ctx, 'shipment', {
                filters: [mine, { field: 'planned_date', op: 'lte', value: q.to.slice(0, 10) }, { field: 'status', op: 'in', value: ['planned', 'packed', 'dispatched'] }],
                sort: 'planned_date',
                dir: 'asc',
                limit: 50,
              })
            ).items,
          )
        : [];
      const tickets = apps.has('service')
        ? await maybe(async () =>
            (await listRecords(ctx, 'ticket', { filters: [mine, { field: 'status', op: 'in', value: ['new', 'open', 'in_progress', 'waiting_customer'] }], sort: 'resolution_due', dir: 'asc', limit: 30 })).items,
          )
        : [];
      const visits = await tx.query(
        `select id, subject, body, related_object, related_id, occurred_at, metadata from activities
          where tenant_id = $1 and actor_id = $2 and kind = 'visit' and occurred_at >= $3::timestamptz and occurred_at < $4::timestamptz
          order by occurred_at desc limit 50`,
        [tid, me, q.from, q.to],
      );
      return { tasks, events, followUps, installations, shipments, tickets, visits };
    });
    return c.json(out);
  });
