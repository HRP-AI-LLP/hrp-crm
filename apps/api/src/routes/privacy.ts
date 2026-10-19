/**
 * Privacy / DPDP API.
 *   privacyRoutes       → /api/v1     consent on a lead or contact
 *   privacyAdminRoutes  → /api/admin  notices, requests, retention, breaches, do-not-contact list
 *   privacyPublicRoutes → /api/public the privacy portal, request verification and status, unsubscribe
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { appOrigin } from '../services/mailer';
import {
  addressKey,
  applyRetention,
  assertSubjectEditable,
  auditChain,
  completeRequest,
  confirmVerification,
  consentHistory,
  CONTACT_CHANNELS,
  createRequest,
  currentNoticeVersion,
  getRequest,
  listRequests,
  noticeTemplate,
  optOutAddress,
  personalDataSummary,
  privacyConfig,
  publicStatus,
  purgeFiles,
  PURPOSES,
  readUnsubscribeToken,
  recordConsent,
  REQUEST_KINDS,
  retentionOf,
  sendVerification,
  setConsentByUser,
  type Subject,
} from '../services/privacy';
import type { RecordCtx } from '../services/records';
import { resolveRoute, verifyTurnstile } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const subjectObject = z.enum(['lead', 'contact']);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

export const privacyRoutes = new Hono<AppEnv>()
  .get('/consent/:object/:id', async (c) => {
    const object = subjectObject.parse(c.req.param('object'));
    const id = uuid.parse(c.req.param('id'));
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) => {
        const ctx = rctx(c, tx);
        assertSubjectEditable(ctx, object);
        return consentHistory(ctx, { object, id });
      }),
    );
  })
  .post('/consent/:object/:id', async (c) => {
    const object = subjectObject.parse(c.req.param('object'));
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ purpose: z.enum(PURPOSES), granted: z.boolean(), note: z.string().trim().max(500).optional() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => setConsentByUser(rctx(c, tx), { object, id }, b.purpose, b.granted, b.note));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => consentHistory(rctx(c, tx), { object, id })));
  });

const retentionSchema = z.object({
  leadsUnconvertedMonths: z.number().int().min(0).max(240),
  lostDealsMonths: z.number().int().min(0).max(240),
  messagesMonths: z.number().int().min(0).max(240),
  recordingsMonths: z.number().int().min(0).max(240),
  recycleBinDays: z.number().int().min(0).max(3650),
});
const purposeSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), label: z.string().trim().min(1).max(200), required: z.boolean().default(false) });

export const privacyAdminRoutes = new Hono<AppEnv>()
  .use('/privacy/*', requireAdmin('privacy'))
  .use('/privacy', requireAdmin('privacy'))
  .get('/privacy', async (c) => {
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const cfg = await privacyConfig(tx, c.var.tenant.id);
      const notices = await tx.query(`select id, version, language, title, published_at, created_at, purposes from privacy_notices where tenant_id = $1 order by version desc, language limit 50`, [c.var.tenant.id]);
      const stats = await tx.one<Record<string, number>>(
        `select (select count(*)::int from data_requests where tenant_id = $1 and status not in ('completed','rejected')) as open,
                (select count(*)::int from data_requests where tenant_id = $1 and status not in ('completed','rejected') and due_at < now()) as overdue,
                (select count(*)::int from data_requests where tenant_id = $1 and status = 'completed' and resolved_at > now() - interval '90 days') as closed90,
                (select count(*)::int from data_requests where tenant_id = $1 and status = 'completed' and resolved_at > now() - interval '90 days' and resolved_at <= due_at) as ontime90,
                (select count(*)::int from data_breaches where tenant_id = $1 and status <> 'closed') as breaches,
                (select count(*)::int from suppressions where tenant_id = $1) as suppressed,
                (select count(distinct subject_id)::int from consent_events where tenant_id = $1 and granted and purpose in ('marketing','whatsapp','email','sms')) as consented`,
        [c.var.tenant.id],
      );
      return { cfg, notices, stats };
    });
    const { portal_key, ...cfg } = out.cfg;
    return c.json({
      config: { ...cfg, retention: retentionOf(out.cfg) },
      portalUrl: cfg.portal_enabled ? `${appOrigin(c.env, c.req.url)}/privacy/${portal_key}` : null,
      notices: out.notices,
      stats: out.stats,
    });
  })
  .put('/privacy/config', async (c) => {
    const b = z
      .object({
        portalEnabled: z.boolean(),
        officerName: z.string().trim().max(200).nullish(),
        officerEmail: z.string().trim().toLowerCase().pipe(z.email()).or(z.literal('')).nullish(),
        officerPhone: z.string().trim().max(40).nullish(),
        officerAddress: z.string().trim().max(500).nullish(),
        requestSlaDays: z.number().int().min(1).max(90),
        retention: retentionSchema,
      })
      .parse(await c.req.json());
    if (b.portalEnabled && !b.officerEmail && !b.officerPhone) throw badRequest('Add the grievance officer’s email or phone before opening the portal');
    await c.var.db.tx(scope(c), async (tx) => {
      await privacyConfig(tx, c.var.tenant.id);
      await tx.query(
        `update privacy_config set portal_enabled = $2, officer_name = $3, officer_email = $4, officer_phone = $5, officer_address = $6, request_sla_days = $7, retention = $8 where tenant_id = $1`,
        [c.var.tenant.id, b.portalEnabled, b.officerName || null, b.officerEmail || null, b.officerPhone || null, b.officerAddress || null, b.requestSlaDays, JSON.stringify(b.retention)],
      );
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'update', 'privacy_config', $2)`, [c.var.tenant.id, JSON.stringify(b)]);
    });
    return c.json({ ok: true });
  })
  .get('/privacy/notice-template', async (c) => {
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const cfg = await privacyConfig(tx, c.var.tenant.id);
      const t = await tx.one<{ name: string; settings: Record<string, any> }>(`select name, settings from tenants where id = $1`, [c.var.tenant.id]);
      return noticeTemplate(t?.settings?.company?.legalName || t?.name || 'We', { name: cfg.officer_name, email: cfg.officer_email, phone: cfg.officer_phone });
    });
    return c.json({ body: r });
  })
  .get('/privacy/notices/:id', async (c) => {
    const n = await c.var.db.tx(scope(c, true), (tx) => tx.one(`select * from privacy_notices where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!n) throw notFound();
    return c.json(n);
  })
  .post('/privacy/notices', async (c) => {
    const b = z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(50).max(40000), language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).default('en'), purposes: z.array(purposeSchema).max(20), publish: z.boolean().default(false) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), async (tx) => {
      // a notice is never edited once published: every change is a new version
      const v = (await tx.one<{ v: number }>(`select coalesce(max(version), 0) + 1 as v from privacy_notices where tenant_id = $1`, [c.var.tenant.id]))!.v;
      return tx.one<{ id: string; version: number }>(
        `insert into privacy_notices (tenant_id, version, language, title, body, purposes, published_at) values ($1,$2,$3,$4,$5,$6,$7) returning id, version`,
        [c.var.tenant.id, v, b.language, b.title, b.body, JSON.stringify(b.purposes), b.publish ? new Date() : null],
      );
    });
    return c.json(r, 201);
  })
  .post('/privacy/notices/:id/publish', async (c) => {
    const n = await c.var.db.tx(scope(c), (tx) => tx.query(`update privacy_notices set published_at = now() where tenant_id = $1 and id = $2 and published_at is null returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!n.length) throw badRequest('Already published (publish a new version to change it)');
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------------------ requests
  .get('/privacy/requests', async (c) => {
    const status = z.enum(['open', 'all']).default('open').parse(c.req.query('status') ?? 'open');
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => listRequests(tx, c.var.tenant.id, status)) });
  })
  .post('/privacy/requests', async (c) => {
    const b = z
      .object({
        kind: z.enum(REQUEST_KINDS),
        source: z.enum(['email', 'phone', 'whatsapp', 'manual']).default('manual'),
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().toLowerCase().pipe(z.email()).nullish(),
        phone: z.string().trim().max(40).nullish(),
        details: z.string().trim().max(5000).nullish(),
        subject: z.object({ object: subjectObject, id: uuid }).nullish(),
        verified: z.boolean().default(false),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => createRequest(tx, c.var.tenant.id, b));
    return c.json({ id: r.id, dueAt: r.due_at }, 201);
  })
  .get('/privacy/requests/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getRequest(tx, c.var.tenant.id, uuid.parse(c.req.param('id'))))))
  .patch('/privacy/requests/:id', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z
      .object({
        assignedTo: uuid.nullish(),
        subject: z.object({ object: subjectObject, id: uuid }).nullish(),
        markVerified: z.literal(true).optional(),
        verificationNote: z.string().trim().max(500).optional(),
      })
      .parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.one<{ status: string }>(`select status from data_requests where tenant_id = $1 and id = $2 for update`, [c.var.tenant.id, id]);
      if (!r) throw notFound();
      if (['completed', 'rejected'].includes(r.status)) throw badRequest('This request is closed');
      if (b.assignedTo !== undefined) await tx.query(`update data_requests set assigned_to = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.assignedTo]);
      if (b.subject !== undefined) {
        if (b.subject) {
          const t = b.subject.object === 'lead' ? 'leads' : 'contacts';
          if (!(await tx.one(`select 1 from ${t} where tenant_id = $1 and id = $2`, [c.var.tenant.id, b.subject.id]))) throw notFound('Record not found');
        }
        await tx.query(`update data_requests set subject_object = $3, subject_id = $4 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.subject?.object ?? null, b.subject?.id ?? null]);
      }
      if (b.markVerified) {
        if (!b.verificationNote) throw badRequest('Say how you verified the requester (for the record)');
        await tx.query(`update data_requests set verified_at = now(), status = 'in_progress', resolution = coalesce(resolution, '') where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
        await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'verify', 'data_request', $2, $3)`, [c.var.tenant.id, id, JSON.stringify({ note: b.verificationNote })]);
      }
    });
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getRequest(tx, c.var.tenant.id, id)));
  })
  .get('/privacy/requests/:id/export', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.one<{ subject_object: Subject['object'] | null; subject_id: string | null; number: string; verified_at: Date | null }>(`select subject_object, subject_id, number, verified_at from data_requests where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!r) throw notFound();
      if (!r.subject_id || !r.subject_object) throw badRequest('Link the request to the person’s record first');
      if (!r.verified_at) throw badRequest('Verify the requester first');
      const data = await personalDataSummary(tx, c.var.meta, c.var.tenant.id, { object: r.subject_object, id: r.subject_id });
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'export', 'data_request', $2, $3)`, [c.var.tenant.id, id, JSON.stringify({ subject: r.subject_id })]);
      return { data, number: r.number };
    });
    return new Response(JSON.stringify(out.data, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="${out.number}-personal-data.json"` } });
  })
  .post('/privacy/requests/:id/complete', async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z.object({ outcome: z.enum(['completed', 'rejected']), resolution: z.string().trim().min(5).max(5000), erase: z.boolean().optional() }).parse(await c.req.json());
    const purge: string[] = [];
    const r = await c.var.db.tx(scope(c), (tx) => completeRequest(c.env, rctx(c, tx), id, b, appOrigin(c.env, c.req.url), purge));
    await purgeFiles(c.env, purge);
    return c.json(r);
  })

  // ----------------------------------------------------------------------------- retention
  .post('/privacy/retention/preview', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => applyRetention(rctx(c, tx), { dryRun: true, limit: 100000 }))))
  .post('/privacy/retention/run', async (c) => {
    const purge: string[] = [];
    const r = await c.var.db.tx(scope(c), (tx) => applyRetention(rctx(c, tx), { dryRun: false }, purge));
    await purgeFiles(c.env, purge);
    return c.json(r);
  })

  // ------------------------------------------------------------------------------ breaches
  .get('/privacy/breaches', async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select b.*, u.full_name as reported_by from data_breaches b left join users u on u.tenant_id = b.tenant_id and u.id = b.created_by where b.tenant_id = $1 order by b.detected_at desc limit 200`, [c.var.tenant.id])) }),
  )
  .post('/privacy/breaches', async (c) => {
    const b = breachSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into data_breaches (tenant_id, title, description, occurred_at, detected_at, severity, data_categories, affected_count, actions) values ($1,$2,$3,$4,coalesce($5, now()),$6,$7,$8,$9) returning id`,
        [c.var.tenant.id, b.title, b.description ?? null, b.occurredAt ?? null, b.detectedAt ?? null, b.severity, b.dataCategories, b.affectedCount ?? null, b.actions ?? null],
      ),
    );
    return c.json(r, 201);
  })
  .patch('/privacy/breaches/:id', async (c) => {
    const b = breachPatchSchema
      .extend({ status: z.enum(['open', 'contained', 'reported', 'closed']).optional(), containedAt: z.string().datetime({ offset: true }).nullish(), boardIntimatedAt: z.string().datetime({ offset: true }).nullish(), boardReportAt: z.string().datetime({ offset: true }).nullish(), principalsNotifiedAt: z.string().datetime({ offset: true }).nullish() })
      .parse(await c.req.json());
    const cols: Record<string, unknown> = {
      title: b.title, description: b.description, occurred_at: b.occurredAt, severity: b.severity, data_categories: b.dataCategories, affected_count: b.affectedCount, actions: b.actions,
      status: b.status, contained_at: b.containedAt, board_intimated_at: b.boardIntimatedAt, board_report_at: b.boardReportAt, principals_notified_at: b.principalsNotifiedAt,
    };
    const set = Object.entries(cols).filter(([, v]) => v !== undefined);
    if (!set.length) return c.json({ ok: true });
    const r = await c.var.db.tx(scope(c), (tx) =>
      tx.query(`update data_breaches set ${set.map(([k], i) => `${k} = $${i + 3}`).join(', ')} where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id')), ...set.map(([, v]) => v)]),
    );
    if (!r.length) throw notFound();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------------- do-not-contact
  .get('/privacy/suppressions', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const key = addressKey(q);
    return c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select channel, case when address_key like 'h:%' then '(erased person)' else address_key end as address, reason, note, created_at from suppressions
            where tenant_id = $1 and ($2::text is null or address_key = $2) order by created_at desc limit 200`,
          [c.var.tenant.id, key],
        ),
      ),
    });
  })
  .post('/privacy/suppressions', async (c) => {
    const b = z.object({ channel: z.enum([...CONTACT_CHANNELS, 'all']), address: z.string().trim().min(3).max(320), note: z.string().trim().max(500).optional() }).parse(await c.req.json());
    const key = addressKey(b.address);
    if (!key) throw badRequest('Enter a phone number or email address');
    await c.var.db.tx(scope(c), (tx) => tx.query(`insert into suppressions (tenant_id, channel, address_key, reason, note) values ($1,$2,$3,'manual',$4) on conflict do nothing`, [c.var.tenant.id, b.channel, key, b.note ?? null]));
    return c.json({ ok: true }, 201);
  })
  .delete('/privacy/suppressions', async (c) => {
    const b = z.object({ channel: z.enum([...CONTACT_CHANNELS, 'all']), address: z.string().trim().min(3).max(320) }).parse(await c.req.json());
    const key = addressKey(b.address);
    // erasure blocks are permanent; consent opt-outs are lifted by the person opting back in
    const r = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from suppressions where tenant_id = $1 and channel = $2 and address_key = $3 and reason in ('manual', 'bounce', 'complaint') returning 1`, [c.var.tenant.id, b.channel, key]));
    if (!r.length) throw badRequest('Only manual, bounce and complaint blocks can be removed here. An opt-out is lifted when the person gives consent again.');
    return c.json({ ok: true });
  });

const breachSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(10000).nullish(),
  occurredAt: z.string().datetime({ offset: true }).nullish(),
  detectedAt: z.string().datetime({ offset: true }).nullish(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  dataCategories: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  affectedCount: z.number().int().min(0).nullish(),
  actions: z.string().trim().max(10000).nullish(),
});

const breachPatchSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().max(10000).nullish(),
  occurredAt: z.string().datetime({ offset: true }).nullish(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  dataCategories: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  affectedCount: z.number().int().min(0).nullish(),
  actions: z.string().trim().max(10000).nullish(),
});

/** Hash-chained audit export (needs the audit permission). */
export const auditExportRoutes = new Hono<AppEnv>().get('/audit/export', requireAdmin('audit'), async (c) => {
  const q = z.object({ from: dateStr, to: dateStr }).parse(c.req.query());
  if (q.from > q.to) throw badRequest('“From” must be before “to”');
  const r = await c.var.db.tx(scope(c), async (tx) => {
    const out = await auditChain(tx, c.var.tenant.id, q.from, q.to);
    await tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1, 'export', 'audit', $2)`, [c.var.tenant.id, JSON.stringify({ from: q.from, to: q.to, count: out.count, head: out.head })]);
    return out;
  });
  return new Response(r.content, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="audit-${q.from}-to-${q.to}.ndjson"`,
      'x-audit-genesis': r.genesis,
      'x-audit-head': r.head,
      'x-audit-count': String(r.count),
    },
  });
});

// ------------------------------------------------------------------------------- public portal

const PORTAL_DAILY_CAP = 50;

export const privacyPublicRoutes = new Hono<AppEnv>()
  .get('/privacy/:key', async (c) => {
    const route = await resolveRoute(c, 'privacy', c.req.param('key'));
    const out = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, async (tx) => {
      const cfg = await tx.one<Record<string, any>>(`select * from privacy_config where tenant_id = $1 and portal_enabled`, [route.tenant_id]);
      if (!cfg) throw notFound();
      const t = await tx.one<{ name: string; settings: Record<string, any> }>(`select name, settings from tenants where id = $1`, [route.tenant_id]);
      const v = await currentNoticeVersion(tx, route.tenant_id);
      const notices = v ? await tx.query(`select language, title, body, purposes, version, published_at from privacy_notices where tenant_id = $1 and version = $2 and published_at is not null`, [route.tenant_id, v]) : [];
      // older language versions remain visible until translated again
      const others = await tx.query(
        `select distinct on (language) language, title, body, purposes, version, published_at from privacy_notices where tenant_id = $1 and published_at is not null order by language, version desc`,
        [route.tenant_id],
      );
      const byLang = new Map<string, unknown>();
      for (const n of [...others, ...notices] as { language: string }[]) byLang.set(n.language, n);
      return {
        company: t?.settings?.company?.legalName || t?.name,
        officer: { name: cfg.officer_name, email: cfg.officer_email, phone: cfg.officer_phone, address: cfg.officer_address },
        slaDays: cfg.request_sla_days,
        notices: [...byLang.values()],
        kinds: REQUEST_KINDS,
      };
    });
    return c.json(out);
  })
  .post('/privacy/:key/requests', async (c) => {
    const route = await resolveRoute(c, 'privacy', c.req.param('key'));
    const b = z
      .object({
        kind: z.enum(REQUEST_KINDS),
        name: z.string().trim().min(1).max(200),
        email: z.string().trim().toLowerCase().pipe(z.email()).or(z.literal('')).optional(),
        phone: z.string().trim().max(40).optional(),
        details: z.string().trim().max(5000).optional(),
        turnstileToken: z.string().optional(),
        _hp: z.string().optional(),
      })
      .parse(await c.req.json());
    if (b._hp) return c.json({ ok: true }, 201);
    if (!b.email && !b.phone) throw badRequest('Give an email address or phone number so we can reach you');
    if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, b.turnstileToken, c.req.header('cf-connecting-ip')))) throw badRequest('Bot check failed');
    const origin = appOrigin(c.env, c.req.url);
    const r = await c.var.db.tx({ tenantId: route.tenant_id }, async (tx) => {
      const cfg = await tx.one(`select 1 from privacy_config where tenant_id = $1 and portal_enabled`, [route.tenant_id]);
      if (!cfg) throw notFound();
      const today = await tx.one<{ n: number }>(`select count(*)::int as n from data_requests where tenant_id = $1 and source = 'portal' and created_at > now() - interval '1 day'`, [route.tenant_id]);
      if ((today?.n ?? 0) >= PORTAL_DAILY_CAP) throw badRequest('Too many requests today. Please email the grievance officer instead.');
      const req = await createRequest(tx, route.tenant_id, { kind: b.kind, source: 'portal', name: b.name, email: b.email || null, phone: b.phone || null, details: b.details || null });
      const t = await tx.one<{ name: string }>(`select name from tenants where id = $1`, [route.tenant_id]);
      const emailed = b.email ? await sendVerification(c.env, tx, route.tenant_id, req.id, origin, t?.name ?? '') : false;
      return { ...req, emailed };
    });
    return c.json({ ok: true, statusUrl: `/privacy/status/${r.status_token}`, verificationEmailed: r.emailed, dueAt: r.due_at }, 201);
  })
  .post('/privacy-verify', async (c) => {
    const b = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,80}\.[A-Za-z0-9_-]{20,80}$/) }).parse(await c.req.json());
    const [statusToken, token] = b.token.split('.') as [string, string];
    const route = await resolveRoute(c, 'privacy_request', statusToken);
    const ok = await c.var.db.tx({ tenantId: route.tenant_id }, (tx) => confirmVerification(tx, route.tenant_id, route.target_id, token));
    if (!ok) throw badRequest('This confirmation link is invalid or has expired');
    return c.json({ ok: true, statusUrl: `/privacy/status/${statusToken}` });
  })
  .get('/privacy-status/:token', async (c) => {
    const route = await resolveRoute(c, 'privacy_request', c.req.param('token'));
    return c.json(await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => publicStatus(tx, route.tenant_id, route.target_id)));
  })
  .get('/unsubscribe/:token', async (c) => {
    const t = await readUnsubscribeToken(c.env, c.req.param('token'));
    if (!t) throw notFound();
    const name = await c.var.db.tx({ tenantId: t.tenantId, readOnly: true }, (tx) => tx.one<{ name: string }>(`select name from tenants where id = $1 and status = 'active'`, [t.tenantId]));
    if (!name) throw notFound();
    const masked = t.address.includes('@') ? t.address.replace(/^(.).*(@.*)$/, '$1•••$2') : `•••${t.address.replace(/[^0-9]/g, '').slice(-4)}`;
    return c.json({ company: name.name, channel: t.channel, address: masked });
  })
  .post('/unsubscribe/:token', async (c) => {
    const t = await readUnsubscribeToken(c.env, c.req.param('token'));
    if (!t) throw notFound();
    await c.var.db.tx({ tenantId: t.tenantId }, (tx) => optOutAddress(tx, t.tenantId, t.channel, t.address, 'unsubscribe_link', { ip: c.req.header('cf-connecting-ip') ?? null }));
    return c.json({ ok: true });
  });

export { recordConsent };
