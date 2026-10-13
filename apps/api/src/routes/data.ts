import { hasAdmin, objectPerm } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { bulkAction, exportCsv, findDuplicates, importBatch, mergeRecords, relatedRecords } from '../services/data';
import { enqueue, eventJobs } from '../services/jobs';
import { getObject, type RecordCtx } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const filterSchema = z.object({ field: z.string().min(1), op: z.string().min(1), value: z.unknown().optional() });
const viewSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filters: z.array(filterSchema).max(20).default([]),
  columns: z.array(z.string().max(60)).max(30).default([]),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).nullable().optional(),
  isShared: z.boolean().default(false),
});

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

export const dataRoutes = new Hono<AppEnv>()
  // ------------------------------------------------------------------ saved views
  .get('/views/:object', async (c) => {
    const items = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(
        `select id, object_key, name, owner_id, is_shared, filters, columns, sort, position, (owner_id = $3) as mine
           from list_views where tenant_id = $1 and object_key = $2 and (is_shared or owner_id = $3)
          order by is_shared desc, position, name`,
        [c.var.tenant.id, c.req.param('object'), c.var.principal.user.id],
      ),
    );
    return c.json({ items });
  })
  .post('/views/:object', async (c) => {
    const object = c.req.param('object');
    getObject(c.var.meta, object);
    const v = viewSchema.parse(await c.req.json());
    if (v.isShared && !hasAdmin(c.var.principal.permissions, 'metadata')) throw forbidden('Only admins can share views with everyone');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into list_views (tenant_id, object_key, name, owner_id, is_shared, filters, columns, sort)
         values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [c.var.tenant.id, object, v.name, c.var.principal.user.id, v.isShared, JSON.stringify(v.filters), v.columns, v.sort ? JSON.stringify(v.sort) : null],
      ),
    );
    return c.json(row, 201);
  })
  .put('/views/:object/:id', async (c) => {
    const v = viewSchema.parse(await c.req.json());
    const admin = hasAdmin(c.var.principal.permissions, 'metadata');
    if (v.isShared && !admin) throw forbidden('Only admins can share views with everyone');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `update list_views set name = $4, is_shared = $5, filters = $6, columns = $7, sort = $8
          where tenant_id = $1 and id = $2 and (owner_id = $3 or $9::boolean) returning *`,
        [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, v.name, v.isShared, JSON.stringify(v.filters), v.columns, v.sort ? JSON.stringify(v.sort) : null, admin],
      ),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/views/:object/:id', async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) =>
      tx.query(`delete from list_views where tenant_id = $1 and id = $2 and (owner_id = $3 or $4::boolean) returning id`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id, hasAdmin(c.var.principal.permissions, 'metadata'),
      ]),
    );
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ related + duplicates + merge
  .get('/records/:object/:id/related', async (c) =>
    c.json({ groups: await c.var.db.tx(scope(c, true), (tx) => relatedRecords(rctx(c, tx), c.req.param('object'), c.req.param('id'))) }),
  )
  .get('/records/:object/:id/duplicates', async (c) => {
    const { object, id } = c.req.param();
    const matches = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const { getRecord } = await import('../services/records');
      const rec = await getRecord(ctx, object, id);
      return findDuplicates(ctx, object, rec, id);
    });
    return c.json({ matches });
  })
  .post('/records/:object/check-duplicates', async (c) => {
    const values = z.record(z.string(), z.unknown()).parse(await c.req.json());
    return c.json({ matches: await c.var.db.tx(scope(c, true), (tx) => findDuplicates(rctx(c, tx), c.req.param('object'), values)) });
  })
  .post('/records/:object/merge', async (c) => {
    const b = z.object({ masterId: uuid, duplicateIds: z.array(uuid).min(1).max(10), choices: z.record(z.string(), uuid).default({}) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => mergeRecords(rctx(c, tx), c.req.param('object'), b.masterId, b.duplicateIds, b.choices));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json({ ok: true, masterId: b.masterId });
  })

  // ------------------------------------------------------------------ bulk
  .post('/records/:object/bulk', async (c) => {
    const b = z
      .object({ action: z.enum(['update', 'delete']), ids: z.array(uuid).min(1).max(500), patch: z.record(z.string(), z.unknown()).default({}) })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => bulkAction(rctx(c, tx), c.req.param('object'), b.ids, b.action, b.patch));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json({ succeeded: r.succeeded, failed: r.failed });
  })

  // ------------------------------------------------------------------ import (client sends parsed, mapped rows in batches)
  .post('/import/:object/jobs', async (c) => {
    const object = c.req.param('object');
    getObject(c.var.meta, object);
    if (!objectPerm(c.var.principal.permissions, object).create) throw forbidden();
    const b = z
      .object({ fileName: z.string().max(200).optional(), mode: z.enum(['create', 'upsert']).default('create'), matchField: z.string().max(60).nullish(), totalRows: z.number().int().min(1).max(50_000) })
      .parse(await c.req.json());
    if (b.mode === 'upsert' && !b.matchField) throw badRequest('Choose the field used to find existing records');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into import_jobs (tenant_id, object_key, file_name, mode, match_field, total_rows) values ($1,$2,$3,$4,$5,$6) returning *`, [
        c.var.tenant.id, object, b.fileName ?? null, b.mode, b.matchField ?? null, b.totalRows,
      ]),
    );
    return c.json(row, 201);
  })
  .post('/import/:object/jobs/:id/rows', async (c) => {
    const object = c.req.param('object');
    const jobId = uuid.parse(c.req.param('id'));
    // small batches keep each request well inside the Workers CPU budget
    const b = z.object({ startRow: z.number().int().min(1), rows: z.array(z.record(z.string(), z.unknown())).min(1).max(50) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const job = await tx.one<{ mode: 'create' | 'upsert'; match_field: string | null; status: string; created_by: string }>(
        `select mode, match_field, status, created_by from import_jobs where tenant_id = $1 and id = $2 and object_key = $3 for update`,
        [c.var.tenant.id, jobId, object],
      );
      if (!job) throw notFound();
      if (job.created_by !== c.var.principal.user.id) throw forbidden();
      if (job.status !== 'running') throw badRequest('This import has finished');
      const res = await importBatch(rctx(c, tx), object, b.rows, b.startRow, job.mode, job.match_field);
      await tx.query(
        `update import_jobs set created = created + $3, updated = updated + $4, failed = failed + $5,
                errors = case when jsonb_array_length(errors) < 500 then errors || $6::jsonb else errors end
          where tenant_id = $1 and id = $2`,
        [c.var.tenant.id, jobId, res.created, res.updated, res.failed.length, JSON.stringify(res.failed.slice(0, 100))],
      );
      return res;
    });
    // automations run for imported records too, but scoring is skipped for big imports by the queue's own limits
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json({ created: r.created, updated: r.updated, failed: r.failed });
  })
  .post('/import/:object/jobs/:id/finish', async (c) => {
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update import_jobs set status = 'completed', finished_at = now() where tenant_id = $1 and id = $2 and created_by = $3 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .get('/import/jobs', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(`select id, object_key, file_name, mode, status, total_rows, created, updated, failed, created_at, finished_at from import_jobs where tenant_id = $1 and created_by = $2 order by created_at desc limit 20`, [
          c.var.tenant.id, c.var.principal.user.id,
        ]),
      ),
    }),
  )
  .get('/import/jobs/:id/errors', async (c) => {
    const row = await c.var.db.tx(scope(c, true), (tx) =>
      tx.one<{ errors: unknown }>(`select errors from import_jobs where tenant_id = $1 and id = $2 and created_by = $3`, [c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id]),
    );
    if (!row) throw notFound();
    return c.json({ errors: row.errors });
  })

  // ------------------------------------------------------------------ export
  .get('/export/:object', async (c) => {
    const object = c.req.param('object');
    const q = z
      .object({ q: z.string().max(200).optional(), filters: z.string().optional(), sort: z.string().max(60).optional(), dir: z.enum(['asc', 'desc']).optional(), columns: z.string().optional(), ids: z.string().optional() })
      .parse(c.req.query());
    let filters;
    try {
      filters = q.filters ? z.array(filterSchema).max(20).parse(JSON.parse(q.filters)) : undefined;
    } catch {
      throw badRequest('filters must be a JSON array');
    }
    const ids = q.ids ? z.array(uuid).max(5000).parse(q.ids.split(',')) : undefined;
    const r = await c.var.db.tx(scope(c), (tx) =>
      exportCsv(rctx(c, tx), object, { q: q.q, filters, sort: q.sort, dir: q.dir, ids }, q.columns ? q.columns.split(',') : undefined),
    );
    const name = `${object}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(r.csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
        'x-export-rows': String(r.rows),
        'x-export-truncated': String(r.truncated),
        'cache-control': 'no-store',
      },
    });
  });
