import { type ObjectMeta, fieldAccess, objectPerm, type TenantMeta } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv, Principal } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enqueue, eventJobs } from '../services/jobs';
import {
  convertLead,
  createRecord,
  dashboardStats,
  deleteRecord,
  getRecord,
  type ListQuery,
  listRecords,
  type RecordCtx,
  updateRecord,
} from '../services/records';
import { safeCtx } from './public';

/** Metadata trimmed to what this user may see (hidden fields and unreadable objects removed). */
export function visibleMeta(meta: TenantMeta, principal: Principal): TenantMeta {
  const p = principal.permissions;
  const objects: ObjectMeta[] = meta.objects
    .filter((o) => objectPerm(p, o.key).read !== 'none')
    .map((o) => ({
      ...o,
      fields: o.fields
        .filter((f) => fieldAccess(p, o.key, f.key) !== 'hidden')
        .map((f) => ({ ...f, readOnly: f.readOnly || fieldAccess(p, o.key, f.key) === 'read' })),
    }));
  const keys = new Set(objects.map((o) => o.key));
  return { ...meta, objects, pipelines: meta.pipelines.filter((pl) => keys.has(pl.objectKey)) };
}

const listQuerySchema = z.object({
  q: z.string().max(200).optional(),
  filters: z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return undefined;
      try {
        return z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })).max(20).parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'filters must be a JSON array of {field, op, value}' });
        return z.NEVER;
      }
    }),
  sort: z.string().max(60).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(40).optional(),
  stage: z.string().uuid().optional(),
  pipeline: z.string().uuid().optional(),
});

const activitySchema = z.object({
  kind: z.enum(['note', 'call', 'email', 'meeting', 'whatsapp', 'sms']),
  subject: z.string().max(300).optional(),
  body: z.string().max(20_000).optional(),
  direction: z.enum(['in', 'out']).optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
});

const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).nullish(),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  dueAt: z.string().datetime({ offset: true }).nullish(),
  assigneeId: z.string().uuid().nullish(),
  relatedObject: z.string().max(60).nullish(),
  relatedId: z.string().uuid().nullish(),
});

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

export const crmRoutes = new Hono<AppEnv>()
  .get('/meta', (c) => {
    c.header('cache-control', 'private, max-age=0');
    return c.json(visibleMeta(c.var.meta, c.var.principal));
  })

  .get('/dashboard', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => dashboardStats(rctx(c, tx)))))

  .get('/users', async (c) => {
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(`select id, full_name, email, status from users where tenant_id = $1 and status <> 'disabled' order by full_name`, [c.var.tenant.id]),
    );
    return c.json({ items: rows });
  })

  .get('/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ results: [] });
    const results = await c.var.db.tx(scope(c, true), async (tx) => {
      const out: { object: string; label: string; items: { id: string; title: string }[] }[] = [];
      for (const o of visibleMeta(c.var.meta, c.var.principal).objects) {
        const r = await listRecords(rctx(c, tx), o.key, { q, limit: 5 });
        if (r.items.length) out.push({ object: o.key, label: o.plural, items: r.items.map((i) => ({ id: i.id, title: i.title })) });
      }
      return out;
    });
    return c.json({ results });
  })

  // ---------------------------------------------------------------- records
  .get('/records/:object', async (c) => {
    const q = listQuerySchema.parse(c.req.query());
    const query: ListQuery = { q: q.q, filters: q.filters, sort: q.sort, dir: q.dir, limit: q.limit, cursor: q.cursor, stageId: q.stage, pipelineId: q.pipeline };
    return c.json(await c.var.db.tx(scope(c, true), (tx) => listRecords(rctx(c, tx), c.req.param('object'), query)));
  })
  .post('/records/:object', async (c) => {
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const { record, events } = await c.var.db.tx(scope(c), (tx) => createRecord(rctx(c, tx), c.req.param('object'), body));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json(record, 201);
  })
  .get('/records/:object/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getRecord(rctx(c, tx), c.req.param('object'), c.req.param('id')))))
  .patch('/records/:object/:id', async (c) => {
    const body = z.record(z.string(), z.unknown()).parse(await c.req.json());
    const ifMatch = c.req.header('if-match');
    const expectedVersion = ifMatch ? Number(ifMatch.replace(/"/g, '')) : undefined;
    if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) throw badRequest('If-Match must be the record version');
    const { record, events } = await c.var.db.tx(scope(c), (tx) => updateRecord(rctx(c, tx), c.req.param('object'), c.req.param('id'), body, { expectedVersion }));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json(record);
  })
  .delete('/records/:object/:id', async (c) => {
    const events = await c.var.db.tx(scope(c), (tx) => deleteRecord(rctx(c, tx), c.req.param('object'), c.req.param('id')));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json({ ok: true });
  })
  .post('/records/lead/:id/convert', async (c) => {
    const body = z.object({ createDeal: z.boolean().default(true), dealName: z.string().max(200).optional(), amount: z.number().min(0).optional(), accountId: z.string().uuid().optional() }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => convertLead(rctx(c, tx), c.req.param('id'), body));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json({ contactId: r.contactId, accountId: r.accountId, dealId: r.dealId });
  })

  // ---------------------------------------------------------------- timeline
  .get('/records/:object/:id/timeline', async (c) => {
    const { object, id } = c.req.param();
    const items = await c.var.db.tx(scope(c, true), async (tx) => {
      await getRecord(rctx(c, tx), object, id); // permission check
      return tx.query(
        `select a.id, a.kind, a.subject, a.body, a.direction, a.sentiment, a.metadata, a.occurred_at, u.full_name as actor_name
           from activities a left join users u on u.tenant_id = a.tenant_id and u.id = a.actor_id
          where a.tenant_id = $1 and a.related_object = $2 and a.related_id = $3
          order by a.occurred_at desc limit 100`,
        [c.var.tenant.id, object, id],
      );
    });
    return c.json({ items });
  })
  .post('/records/:object/:id/activities', async (c) => {
    const { object, id } = c.req.param();
    const body = activitySchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      await getRecord(rctx(c, tx), object, id);
      if (objectPerm(c.var.principal.permissions, object).update === 'none') throw forbidden();
      return tx.one(
        `insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, occurred_at)
         values ($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz, now())) returning *`,
        [c.var.tenant.id, body.kind, body.subject ?? null, body.body ?? null, body.direction ?? null, object, id, body.occurredAt ?? null],
      );
    });
    return c.json(row, 201);
  })

  // ---------------------------------------------------------------- tasks
  .get('/tasks', async (c) => {
    const perm = objectPerm(c.var.principal.permissions, 'task');
    if (perm.read === 'none') throw forbidden();
    const me = c.var.principal.user.id;
    const status = c.req.query('status');
    const mine = c.req.query('mine') === '1' || perm.read === 'own';
    const relObj = c.req.query('relatedObject');
    const relId = c.req.query('relatedId');
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(
        `select t.*, u.full_name as assignee_name from tasks t left join users u on u.tenant_id = t.tenant_id and u.id = t.assignee_id
          where t.tenant_id = $1
            and ($2::boolean is false or t.assignee_id = $3 or t.created_by = $3)
            and ($4::text is null or t.status = any(string_to_array($4, ',')))
            and ($5::text is null or (t.related_object = $5 and t.related_id = $6::uuid))
          order by (t.status in ('done','cancelled')), t.due_at nulls last, t.created_at desc limit 300`,
        [c.var.tenant.id, mine, me, status ?? null, relObj ?? null, relId ?? null],
      ),
    );
    return c.json({ items: rows });
  })
  .post('/tasks', async (c) => {
    if (!objectPerm(c.var.principal.permissions, 'task').create) throw forbidden();
    const b = taskSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into tasks (tenant_id, title, description, status, priority, due_at, assignee_id, related_object, related_id)
         values ($1,$2,$3,coalesce($4,'open'),coalesce($5,'normal'),$6,coalesce($7::uuid,$8::uuid),$9,$10) returning *`,
        [c.var.tenant.id, b.title, b.description ?? null, b.status ?? null, b.priority ?? null, b.dueAt ?? null, b.assigneeId ?? null, c.var.principal.user.id, b.relatedObject ?? null, b.relatedId ?? null],
      ),
    );
    return c.json(row, 201);
  })
  .patch('/tasks/:id', async (c) => {
    const perm = objectPerm(c.var.principal.permissions, 'task');
    if (perm.update === 'none') throw forbidden();
    const b = taskSchema.partial().parse(await c.req.json());
    const me = c.var.principal.user.id;
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `update tasks set
            title = coalesce($4, title), description = case when $5::boolean then $6 else description end,
            status = coalesce($7, status), priority = coalesce($8, priority),
            due_at = case when $9::boolean then $10::timestamptz else due_at end,
            assignee_id = case when $11::boolean then $12::uuid else assignee_id end,
            completed_at = case when coalesce($7, status) = 'done' and completed_at is null then now()
                                when coalesce($7, status) <> 'done' then null else completed_at end
          where tenant_id = $1 and id = $2 and ($3::boolean or assignee_id = $13 or created_by = $13)
          returning *`,
        [c.var.tenant.id, c.req.param('id'), perm.update === 'all' || perm.update === 'team', b.title ?? null, b.description !== undefined, b.description ?? null, b.status ?? null, b.priority ?? null, b.dueAt !== undefined, b.dueAt ?? null, b.assigneeId !== undefined, b.assigneeId ?? null, me],
      ),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/tasks/:id', async (c) => {
    const perm = objectPerm(c.var.principal.permissions, 'task');
    if (perm.delete === 'none') throw forbidden();
    const me = c.var.principal.user.id;
    const rows = await c.var.db.tx(scope(c), (tx) =>
      tx.query(`delete from tasks where tenant_id = $1 and id = $2 and ($3::boolean or assignee_id = $4 or created_by = $4) returning id`, [c.var.tenant.id, c.req.param('id'), perm.delete === 'all' || perm.delete === 'team', me]),
    );
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  });
