/**
 * Business health (KPIs against targets) and industry solutions.
 *   insightsRoutes      → /api/v1     KPIs and trends for the signed-in person
 *   insightsAdminRoutes → /api/admin  KPI targets, industry solutions (modules permission)
 */
import { KPI_BY_KEY } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { requestIp } from '../lib/ip';
import { takeToken } from '../lib/ratelimit';
import { badRequest, forbidden, notFound, tooMany } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { businessHealth, kpiTrend, PERIODS } from '../services/kpis';
import type { RecordCtx } from '../services/records';
import { installSolution, listSolutions } from '../services/solutions';
import { assertTarget, nextRun, renderDigest, sendSchedule, wakeDigests } from '../services/digests';
import { appOrigin } from '../services/mailer';
import { actAs } from '../services/system';
import { resolveRoute } from './public';
import { reportDefinitionSchema, runReport } from './sales';

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

// ------------------------------------------------------------------------------ digests & sharing

const uuid = z.string().uuid();
const scheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['health', 'dashboard', 'report']),
  targetId: uuid.nullish(),
  frequency: z.enum(['daily', 'weekly', 'monthly']),
  sendHour: z.number().int().min(0).max(23),
  weekday: z.number().int().min(1).max(7).nullish(),
  monthday: z.number().int().min(1).max(28).nullish(),
  recipients: z.array(uuid).min(1).max(50),
  isEnabled: z.boolean().default(true),
});
const manager = (c: { var: AppEnv['Variables'] }) => c.var.principal.permissions.admin.some((a) => a === '*' || a === 'users' || a === 'reports');

export const digestRoutes = new Hono<AppEnv>()
  .get('/digests', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select s.*, (select array_agg(u.full_name order by u.full_name) from users u where u.tenant_id = s.tenant_id and u.id = any(s.recipients)) as recipient_names
             from report_schedules s where s.tenant_id = $1 and (s.owner_id = $2 or $2 = any(s.recipients)) order by s.created_at desc`,
          [c.var.tenant.id, c.var.principal.user.id],
        ),
      ),
    }),
  )
  .post('/digests', async (c) => {
    const b = scheduleSchema.parse(await c.req.json());
    if (!manager(c) && b.recipients.some((r) => r !== c.var.principal.user.id)) throw forbidden('Only managers can send digests to other people');
    const r = await c.var.db.tx(scope(c), async (tx) => {
      await assertTarget(tx, c.var.tenant.id, c.var.principal.user.id, b.kind, b.targetId ?? null);
      const n = await tx.one<{ n: number }>(`select count(*)::int as n from users where tenant_id = $1 and id = any($2::uuid[]) and status = 'active'`, [c.var.tenant.id, b.recipients]);
      if (n?.n !== new Set(b.recipients).size) throw forbidden('Digests go to active people in this workspace only');
      const next = nextRun({ frequency: b.frequency, send_hour: b.sendHour, weekday: b.weekday, monthday: b.monthday });
      return tx.one(
        `insert into report_schedules (tenant_id, name, kind, target_id, frequency, send_hour, weekday, monthday, recipients, is_enabled, next_run_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, next_run_at`,
        [c.var.tenant.id, b.name, b.kind, b.targetId ?? null, b.frequency, b.sendHour, b.weekday ?? null, b.monthday ?? null, [...new Set(b.recipients)], b.isEnabled, next],
      );
    });
    await wakeDigests(c.env);
    return c.json(r, 201);
  })
  .put('/digests/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = scheduleSchema.parse(await c.req.json());
    if (!manager(c) && b.recipients.some((r) => r !== c.var.principal.user.id)) throw forbidden('Only managers can send digests to other people');
    await c.var.db.tx(scope(c), async (tx) => {
      await assertTarget(tx, c.var.tenant.id, c.var.principal.user.id, b.kind, b.targetId ?? null);
      const next = nextRun({ frequency: b.frequency, send_hour: b.sendHour, weekday: b.weekday, monthday: b.monthday });
      const r = await tx.query(
        `update report_schedules set name = $3, kind = $4, target_id = $5, frequency = $6, send_hour = $7, weekday = $8, monthday = $9, recipients = $10, is_enabled = $11, next_run_at = $12
          where tenant_id = $1 and id = $2 and owner_id = $13 returning id`,
        [c.var.tenant.id, id, b.name, b.kind, b.targetId ?? null, b.frequency, b.sendHour, b.weekday ?? null, b.monthday ?? null, [...new Set(b.recipients)], b.isEnabled, next, c.var.principal.user.id],
      );
      if (!r.length) throw notFound();
    });
    await wakeDigests(c.env);
    return c.json({ ok: true });
  })
  .delete('/digests/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    // owners delete; a recipient removes only themselves
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.query(`delete from report_schedules where tenant_id = $1 and id = $2 and owner_id = $3 returning id`, [c.var.tenant.id, id, c.var.principal.user.id]);
      if (!r.length) await tx.query(`update report_schedules set recipients = array_remove(recipients, $3::uuid) where tenant_id = $1 and id = $2 and $3 = any(recipients) and cardinality(recipients) > 1`, [c.var.tenant.id, id, c.var.principal.user.id]);
    });
    return c.json({ ok: true });
  })
  .post('/digests/:id/send-now', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const own = await c.var.db.tx(scope(c, true), (tx) => tx.one(`select 1 from report_schedules where tenant_id = $1 and id = $2 and owner_id = $3`, [c.var.tenant.id, id, c.var.principal.user.id]));
    if (!own) throw notFound();
    return c.json(await sendSchedule(c.env, c.var.db, c.var.tenant.id, id, appOrigin(c.env, c.req.url)));
  })
  .get('/digests/preview', async (c) => {
    const q = z.object({ kind: z.enum(['health', 'dashboard', 'report']), targetId: uuid.optional() }).parse(c.req.query());
    const html = await c.var.db.tx(scope(c, true), async (tx) => {
      await assertTarget(tx, c.var.tenant.id, c.var.principal.user.id, q.kind, q.targetId ?? null);
      return renderDigest(rctx(c, tx), { kind: q.kind, target_id: q.targetId ?? null, name: 'Preview' }, appOrigin(c.env, c.req.url));
    });
    return c.json({ html });
  })
  // ------------------------------------------------------------------------- dashboard links
  .post('/dashboards/:id/share-link', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ days: z.number().int().min(1).max(90).default(30) }).parse(await c.req.json().catch(() => ({})));
    const token = randomToken(24);
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const d = await tx.one<{ owner_id: string | null; is_shared: boolean }>(`select owner_id, is_shared from dashboards where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!d || (!d.is_shared && d.owner_id !== c.var.principal.user.id && !manager(c))) throw notFound();
      if (d.owner_id !== c.var.principal.user.id && !manager(c)) throw forbidden('Only the dashboard’s owner or a manager can share it by link');
      const row = await tx.one<{ share_expires_at: string }>(
        `update dashboards set share_token = $3, share_expires_at = now() + make_interval(days => $4), shared_by = $5 where tenant_id = $1 and id = $2 returning share_expires_at`,
        [c.var.tenant.id, id, token, b.days, c.var.principal.user.id],
      );
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'share_link', 'dashboard', $2, $3)`, [c.var.tenant.id, id, JSON.stringify({ days: b.days })]);
      return row;
    });
    return c.json({ url: `${appOrigin(c.env, c.req.url)}/share/d/${token}`, expiresAt: r!.share_expires_at });
  })
  .delete('/dashboards/:id/share-link', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const d = await tx.one<{ owner_id: string | null; shared_by: string | null }>(`select owner_id, shared_by from dashboards where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!d) throw notFound();
      if (d.owner_id !== c.var.principal.user.id && d.shared_by !== c.var.principal.user.id && !manager(c)) throw forbidden();
      await tx.query(`update dashboards set share_token = null, share_expires_at = null, shared_by = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
    });
    return c.json({ ok: true });
  });

/** A shared dashboard, read-only, computed as the person who shared it. */
/**
 * A shared dashboard, as its sharer sees it. Only charts and summaries are shown (row-level
 * tables stay inside the app); answers are cached for five minutes per link and each visitor is
 * rate-limited, so a public link cannot be used to hammer the database.
 */
const shareCache = new Map<string, { at: number; body: unknown }>();
const SHARE_TTL = 300_000;

export const sharePublicRoutes = new Hono<AppEnv>().get('/dashboards/:token', async (c) => {
  const token = c.req.param('token');
  const ip = requestIp(c.env, (n) => c.req.header(n)) ?? 'unknown';
  if (!takeToken(`share:${ip}`, 30).ok || !takeToken(`share-link:${token}`, 120).ok) throw tooMany('Too many requests for this link; try again in a minute');
  // the route registry is checked every time, so a revoked link stops working at once
  const route = await resolveRoute(c, 'dashboard', token);
  c.header('x-robots-tag', 'noindex');
  c.header('cache-control', 'private, max-age=60');
  // a cheap check of the link's expiry on every visit: the heavy part (the reports) is cached
  const live = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) =>
    tx.one<{ exp: Date | null }>(`select share_expires_at as exp from dashboards where tenant_id = $1 and id = $2 and shared_by is not null`, [route.tenant_id, route.target_id]),
  );
  if (!live?.exp || new Date(live.exp) < new Date()) throw notFound('This link has expired');
  const cacheKey = `${token}:${new Date(live.exp).getTime()}`;
  const hit = shareCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SHARE_TTL) return c.json(hit.body as Record<string, unknown>);
  const kvKey = `share:dash:${await sha256Hex(cacheKey)}`;
  if (c.env.CACHE_KV) {
    const cached = await c.env.CACHE_KV.get(kvKey, 'json').catch(() => null);
    if (cached) {
      shareCache.set(cacheKey, { at: Date.now(), body: cached });
      return c.json(cached as Record<string, unknown>);
    }
  }
  const out = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, async (tx) => {
    const d = await tx.one<{ name: string; description: string | null; widgets: { reportId: string; size?: string; title?: string }[]; shared_by: string | null; share_expires_at: Date | null }>(
      `select name, description, widgets, shared_by, share_expires_at from dashboards where tenant_id = $1 and id = $2`,
      [route.tenant_id, route.target_id],
    );
    if (!d || !d.shared_by || !d.share_expires_at || new Date(d.share_expires_at) < new Date()) throw notFound('This link has expired');
    const ctx = await actAs(c.env, tx, route.tenant_id, d.shared_by, 'share-link');
    if (!ctx) throw notFound('This link is no longer valid');
    const company = await tx.one<{ name: string }>(`select name from tenants where id = $1`, [route.tenant_id]);
    const widgets = [];
    const objects = new Map<string, unknown>();
    let omitted = 0;
    for (const w of d.widgets.slice(0, 20)) {
      const r = await tx.one<{ name: string; object_key: string; definition: unknown }>(`select name, object_key, definition from reports where tenant_id = $1 and id = $2 and (is_shared or owner_id = $3)`, [route.tenant_id, w.reportId, d.shared_by]);
      if (!r) continue;
      const parsed = reportDefinitionSchema.safeParse(r.definition);
      if (!parsed.success) continue;
      const def = parsed.data;
      if (def.type === 'table') {
        omitted++;
        continue;
      }
      await tx.query('savepoint share_widget');
      try {
        const result = await runReport(ctx, r.object_key, def);
        await tx.query('release savepoint share_widget');
        widgets.push({ title: w.title ?? r.name, size: w.size ?? 'm', objectKey: r.object_key, definition: def, result });
        const obj = ctx.meta.objects.find((o) => o.key === r.object_key);
        if (obj) objects.set(obj.key, { key: obj.key, label: obj.label, plural: obj.plural, fields: obj.fields.map((f) => ({ key: f.key, label: f.label, type: f.type, standard: f.standard, options: f.options?.choices ? { choices: f.options.choices } : undefined })) });
      } catch {
        /* a report the sharer can no longer run is left out */
        await tx.query('rollback to savepoint share_widget');
      }
    }
    return { company: company?.name ?? '', name: d.name, description: d.description, expiresAt: d.share_expires_at, widgets, omitted, objects: [...objects.values()], pipelines: ctx.meta.pipelines };
  });
  shareCache.set(cacheKey, { at: Date.now(), body: out });
  if (shareCache.size > 500) for (const [k, v] of shareCache) if (Date.now() - v.at > SHARE_TTL) shareCache.delete(k);
  await c.env.CACHE_KV?.put(kvKey, JSON.stringify(out), { expirationTtl: SHARE_TTL / 1000 }).catch(() => undefined);
  return c.json(out);
});
