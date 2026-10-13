/**
 * Files, approvals, quote revisions, lead routing / scoring rules and lead insights.
 *   flowRoutes       → /api/v1   (any signed-in user, record permissions apply)
 *   rulesAdminRoutes → /api/admin (workflows admin area)
 */
import { CRITERIA_OPS, KEY_PATTERN, type TenantMeta } from '@synapse/shared';
import { Hono } from 'hono';
import { availablePersonas, homeFor, PERSONAS } from '../services/home';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { APPROVABLE, approvalHistory, decide, listApprovals, recallRequest, submitForApproval } from '../services/approvals';
import { deleteFile, FILE_KINDS, fileHeaders, listFiles, MAX_FILE_BYTES, openFile, saveFile, storageUsage, withLinks } from '../services/files';
import { enqueue, eventJobs } from '../services/jobs';
import { quoteRevisions, reviseQuote } from '../services/quotes';
import { getObject, Params, type RecordCtx, visibilityWhere } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const objKey = z.string().regex(KEY_PATTERN);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

export const flowRoutes = new Hono<AppEnv>()
  // ============================================================================ files
  .get('/files', async (c) => {
    const q = z.object({ object: objKey, id: uuid }).parse(c.req.query());
    const items = await c.var.db.tx(scope(c, true), (tx) => listFiles(rctx(c, tx), q.object, q.id));
    return c.json({ items: await withLinks(c.env, c.var.tenant.id, items), enabled: !!c.env.FILES });
  })
  .post('/files', async (c) => {
    const q = z.object({ object: objKey, id: uuid, kind: z.enum(FILE_KINDS).optional(), name: z.string().min(1).max(255), description: z.string().max(500).optional() }).parse(c.req.query());
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_FILE_BYTES) throw badRequest('Files can be at most 25 MB');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const file = await c.var.db.tx(scope(c), (tx) => saveFile(rctx(c, tx), c.env, { objectKey: q.object, recordId: q.id, name: q.name, bytes, kind: q.kind, description: q.description ?? null }));
    const [linked] = await withLinks(c.env, c.var.tenant.id, [file]);
    return c.json(linked, 201);
  })
  .get('/files/usage', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => storageUsage(rctx(c, tx)))))
  .get('/files/:id/content', async (c) => {
    const r = await c.var.db.tx(scope(c, true), (tx) => openFile(rctx(c, tx), c.env, c.req.param('id')));
    return new Response(r.body, { headers: fileHeaders(r.file, c.req.query('inline') === '1') });
  })
  .delete('/files/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => deleteFile(rctx(c, tx), c.env, c.req.param('id')))))

  // ============================================================================ approvals
  .get('/approvals', async (c) => {
    const q = z.object({ box: z.enum(['inbox', 'mine', 'all']).default('inbox'), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }).parse(c.req.query());
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => listApprovals(rctx(c, tx), q.box, q.status ?? null)) });
  })
  .get('/approvals/count', async (c) => {
    const items = await c.var.db.tx(scope(c, true), (tx) => listApprovals(rctx(c, tx), 'inbox', 'pending'));
    return c.json({ pending: items.filter((i) => i.canDecide).length });
  })
  .post('/approvals/submit/:object/:id', async (c) => {
    const b = z.object({ note: z.string().max(2000).nullish() }).parse(await c.req.json().catch(() => ({})));
    const events = await c.var.db.tx(scope(c), (tx) => submitForApproval(rctx(c, tx), c.req.param('object'), c.req.param('id'), b.note ?? null));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json({ ok: true });
  })
  .post('/approvals/:id/decide', async (c) => {
    const b = z.object({ approve: z.boolean(), comment: z.string().max(2000).nullish() }).parse(await c.req.json());
    if (!b.approve && !b.comment?.trim()) throw badRequest('Say why you are rejecting it');
    const events = await c.var.db.tx(scope(c), (tx) => decide(rctx(c, tx), c.req.param('id'), b.approve, b.comment ?? null));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
    return c.json({ ok: true });
  })
  .post('/approvals/:id/recall', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => recallRequest(rctx(c, tx), c.req.param('id')))))
  .get('/approvals/history/:object/:id', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => approvalHistory(rctx(c, tx), c.req.param('object'), c.req.param('id'))) }))

  // ============================================================================ quote revisions
  .post('/quotes/:id/revise', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => reviseQuote(rctx(c, tx), c.req.param('id')));
    await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, r.events));
    return c.json({ id: r.id }, 201);
  })
  .get('/quotes/:id/revisions', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => quoteRevisions(rctx(c, tx), c.req.param('id'))) }))

  // ============================================================================ lead insights
  /** Open leads by age and by time since the last interaction, overall and per owner. */
  /** Role dashboard: ?persona=owner|sales|operations|inventory|service (default: the caller's best fit). */
  .get('/insights/home', async (c) => {
    const want = z.enum(PERSONAS).optional().parse(c.req.query('persona') || undefined);
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const personas = availablePersonas(ctx);
      const persona = want && personas.includes(want) ? want : personas[0];
      if (!persona) return { personas, data: null };
      return { personas, data: await homeFor(ctx, persona) };
    });
    return c.json(out);
  })
  .get('/insights/lead-aging', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const p = new Params();
      const where = visibilityWhere(ctx, 'lead', p);
      where.push(`r.converted_at is null`, `coalesce((select st.category from pipeline_stages st where st.tenant_id = r.tenant_id and st.id = r.stage_id), 'open') = 'open'`);
      const bucket = (col: string) => `case when ${col} is null then 'never'
            when now() - ${col} < interval '3 days' then '0-2'
            when now() - ${col} < interval '8 days' then '3-7'
            when now() - ${col} < interval '15 days' then '8-14'
            when now() - ${col} < interval '31 days' then '15-30' else '30+' end`;
      const byAge = await tx.query(`select ${bucket('r.created_at')} as bucket, count(*)::int as n from leads r where ${where.join(' and ')} group by 1`, p.values);
      const byIdle = await tx.query(`select ${bucket('r.last_activity_at')} as bucket, count(*)::int as n from leads r where ${where.join(' and ')} group by 1`, p.values);
      const byOwner = await tx.query(
        `select r.owner_id, u.full_name as owner_name, count(*)::int as open,
                count(*) filter (where r.last_activity_at is null or r.last_activity_at < now() - interval '7 days')::int as idle_7d,
                count(*) filter (where r.next_follow_up_at < now())::int as overdue_follow_ups,
                round(avg(extract(epoch from now() - r.created_at) / 86400)::numeric, 1)::float8 as avg_age_days
           from leads r left join users u on u.tenant_id = r.tenant_id and u.id = r.owner_id
          where ${where.join(' and ')} group by r.owner_id, u.full_name order by open desc limit 50`,
        p.values,
      );
      const bySource = await tx.query(
        `select coalesce(r.source, 'unknown') as source, count(*)::int as n from leads r where ${where.join(' and ')} group by 1 order by 2 desc`,
        p.values,
      );
      return { byAge, byIdle, byOwner, bySource };
    });
    return c.json(out);
  })
  /** Lead funnel + conversion by source and by referring partner (architects, dealers…). */
  .get('/insights/lead-sources', async (c) => {
    const days = z.coerce.number().int().min(7).max(730).default(90).parse(c.req.query('days') ?? 90);
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      const p = new Params();
      const where = visibilityWhere(ctx, 'lead', p);
      where.push(`r.created_at > now() - make_interval(days => ${p.add(days)}::int)`);
      const bySource = await tx.query(
        `select coalesce(r.source, 'unknown') as source, count(*)::int as leads, count(r.converted_at)::int as converted,
                count(*) filter (where r.rating = 'hot')::int as hot
           from leads r where ${where.join(' and ')} group by 1 order by 2 desc`,
        p.values,
      );
      const byPartner = await tx.query(
        `select a.id, a.name, a.account_type, count(*)::int as leads, count(r.converted_at)::int as converted
           from leads r join accounts a on a.tenant_id = r.tenant_id and a.id = r.referred_by_id
          where ${where.join(' and ')} group by a.id, a.name, a.account_type order by leads desc limit 25`,
        p.values,
      );
      return { days, bySource, byPartner };
    });
    return c.json(out);
  });

// ================================================================================ rule admin
const criteriaSchema = z.array(z.object({ field: z.string().regex(KEY_PATTERN), op: z.enum(CRITERIA_OPS), value: z.unknown().optional() })).max(10);

function checkCriteria(meta: TenantMeta, objectKey: string, criteria: { field: string; value?: unknown }[]) {
  const obj = getObject(meta, objectKey);
  for (const c of criteria) {
    if (!obj.fields.some((f) => f.key === c.field) && !['created_at', 'updated_at'].includes(c.field)) throw badRequest(`Unknown field "${c.field}" on ${obj.label}`);
    if (c.value !== undefined && JSON.stringify(c.value).length > 500) throw badRequest('Criterion value is too long');
  }
}

const assignmentSchema = z.object({
  objectKey: objKey,
  name: z.string().trim().min(1).max(120),
  criteria: criteriaSchema.default([]),
  strategy: z.enum(['round_robin', 'load_balanced', 'fixed']),
  userIds: z.array(uuid).max(100).default([]),
  teamId: uuid.nullish(),
  isActive: z.boolean().default(true),
});
const scoringSchema = z.object({ objectKey: objKey.default('lead'), name: z.string().trim().min(1).max(120), criteria: criteriaSchema.min(1), points: z.number().int().min(-100).max(100), isActive: z.boolean().default(true) });
const approvalRuleSchema = z
  .object({
    objectKey: objKey,
    name: z.string().trim().min(1).max(120),
    criteria: criteriaSchema.min(1),
    approverType: z.enum(['manager', 'user', 'role', 'owner']),
    approverId: uuid.nullish(),
    approverRole: z.string().max(60).nullish(),
    isActive: z.boolean().default(true),
  })
  .refine((r) => r.approverType !== 'user' || !!r.approverId, { message: 'Choose the approver', path: ['approverId'] })
  .refine((r) => r.approverType !== 'role' || !!r.approverRole, { message: 'Choose the role', path: ['approverRole'] });

export const rulesAdminRoutes = new Hono<AppEnv>()
  .use('/rules/*', requireAdmin('workflows'))
  .get('/rules', requireAdmin('workflows'), async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => ({
      assignment: await tx.query(`select * from assignment_rules where tenant_id = $1 order by object_key, position, created_at`, [c.var.tenant.id]),
      scoring: await tx.query(`select * from scoring_rules where tenant_id = $1 order by object_key, created_at`, [c.var.tenant.id]),
      approval: await tx.query(`select * from approval_rules where tenant_id = $1 order by object_key, position, created_at`, [c.var.tenant.id]),
      bands: (await tx.one<{ s: { hot?: number; warm?: number } | null }>(`select settings -> 'scoring' as s from tenants where id = $1`, [c.var.tenant.id]))?.s ?? { hot: 70, warm: 40 },
      approvable: [...APPROVABLE].filter((k) => c.var.meta.objects.some((o) => o.key === k)),
    }));
    return c.json(out);
  })
  // ---------------------------------------------------------------- assignment
  .post('/rules/assignment', async (c) => {
    const b = assignmentSchema.parse(await c.req.json());
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    if (!b.userIds.length && !b.teamId) throw badRequest('Pick at least one person or a team');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into assignment_rules (tenant_id, object_key, name, criteria, strategy, user_ids, team_id, is_active, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce((select max(position) + 1 from assignment_rules where tenant_id = $1 and object_key = $2), 0)) returning *`,
        [c.var.tenant.id, b.objectKey, b.name, JSON.stringify(b.criteria), b.strategy, b.userIds, b.teamId ?? null, b.isActive],
      ),
    );
    return c.json(row, 201);
  })
  .put('/rules/assignment/:id', async (c) => {
    const b = assignmentSchema.parse(await c.req.json());
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    if (!b.userIds.length && !b.teamId) throw badRequest('Pick at least one person or a team');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update assignment_rules set name=$3, criteria=$4, strategy=$5, user_ids=$6, team_id=$7, is_active=$8 where tenant_id=$1 and id=$2 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), b.name, JSON.stringify(b.criteria), b.strategy, b.userIds, b.teamId ?? null, b.isActive,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .put('/rules/assignment-order', async (c) => {
    const b = z.object({ ids: z.array(uuid).max(200) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      for (const [i, id] of b.ids.entries()) await tx.query(`update assignment_rules set position = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, i]);
    });
    return c.json({ ok: true });
  })
  .delete('/rules/assignment/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from assignment_rules where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })
  // ---------------------------------------------------------------- scoring
  .post('/rules/scoring', async (c) => {
    const b = scoringSchema.parse(await c.req.json());
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into scoring_rules (tenant_id, object_key, name, criteria, points, is_active) values ($1,$2,$3,$4,$5,$6) returning *`, [
        c.var.tenant.id, b.objectKey, b.name, JSON.stringify(b.criteria), b.points, b.isActive,
      ]),
    );
    return c.json(row, 201);
  })
  .put('/rules/scoring/:id', async (c) => {
    const b = scoringSchema.parse(await c.req.json());
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update scoring_rules set name=$3, criteria=$4, points=$5, is_active=$6 where tenant_id=$1 and id=$2 returning *`, [c.var.tenant.id, uuid.parse(c.req.param('id')), b.name, JSON.stringify(b.criteria), b.points, b.isActive]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/rules/scoring/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from scoring_rules where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })
  .put('/rules/scoring-bands', async (c) => {
    const b = z.object({ hot: z.number().int().min(1).max(100), warm: z.number().int().min(0).max(99) }).refine((x) => x.warm < x.hot, { message: 'Warm must be below hot' }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`update tenants set settings = jsonb_set(settings, '{scoring}', $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify(b)]));
    return c.json(b);
  })
  /** Re-scores every open lead with the current rules (runs in the request; capped). */
  .post('/rules/scoring/rescore', async (c) => {
    const { computeScore } = await import('../services/routing');
    const n = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const rows = await tx.query<Record<string, unknown>>(`select * from leads where tenant_id = $1 and deleted_at is null and converted_at is null order by created_at desc limit 5000`, [c.var.tenant.id]);
      let changed = 0;
      for (const r of rows) {
        const sc = computeScore(ctx, 'lead', { ...r, ...((r.custom as Record<string, unknown>) ?? {}) });
        const score = sc?.score ?? null;
        const rating = sc?.rating ?? null;
        if (score !== r.score || rating !== r.rating) {
          await tx.query(`update leads set score = $3, rating = $4 where tenant_id = $1 and id = $2`, [c.var.tenant.id, r.id, score, rating]);
          changed++;
        }
      }
      return changed;
    });
    return c.json({ updated: n });
  })
  // ---------------------------------------------------------------- approval rules
  .post('/rules/approval', async (c) => {
    const b = approvalRuleSchema.parse(await c.req.json());
    if (!APPROVABLE.has(b.objectKey)) throw badRequest('Approvals are available for quotes, sales orders, purchase orders and invoices');
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into approval_rules (tenant_id, object_key, name, criteria, approver_type, approver_id, approver_role, is_active, position)
         values ($1,$2,$3,$4,$5,$6,$7,$8, coalesce((select max(position) + 1 from approval_rules where tenant_id = $1 and object_key = $2), 0)) returning *`,
        [c.var.tenant.id, b.objectKey, b.name, JSON.stringify(b.criteria), b.approverType, b.approverType === 'user' ? b.approverId : null, b.approverType === 'role' ? b.approverRole : null, b.isActive],
      ),
    );
    return c.json(row, 201);
  })
  .put('/rules/approval/:id', async (c) => {
    const b = approvalRuleSchema.parse(await c.req.json());
    checkCriteria(c.var.meta, b.objectKey, b.criteria);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update approval_rules set name=$3, criteria=$4, approver_type=$5, approver_id=$6, approver_role=$7, is_active=$8 where tenant_id=$1 and id=$2 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), b.name, JSON.stringify(b.criteria), b.approverType, b.approverType === 'user' ? b.approverId : null, b.approverType === 'role' ? b.approverRole : null, b.isActive,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/rules/approval/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from approval_rules where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  });

