import { hashPassword, MODULES, passwordPolicyError, rolePermissionsSchema, fieldSpecSchema, KEY_PATTERN } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { encryptSecret, randomToken } from '../lib/crypto';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { createObject, createPipeline, installModule, objectSpecSchema, pipelineSpecSchema, upsertField } from '../services/metadata-admin';
import { invalidatePrincipal } from '../services/tenancy';
import { attachWorkerDomain, vanityEnabled, vanityHost } from '../services/domains';
import { workflowSchema } from '../services/workflows';
import { chatWith, tenantProvider } from '../services/ai/router';
import { createProviderSchema, encryptKey, hint, loadTenantProviders, normaliseCreate, assertSafeBaseUrl, tenantAiSettings, updateProviderSchema } from '../services/ai/tenant-providers';

const uuid = z.string().uuid();

export const adminRoutes = new Hono<AppEnv>()
  // ------------------------------------------------------------------ tenant
  .patch('/tenant', requireAdmin('metadata'), async (c) => {
    const b = z.object({ name: z.string().min(1).max(120).optional(), settings: z.record(z.string(), z.unknown()).optional() }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update tenants set name = coalesce($2, name), settings = settings || coalesce($3::jsonb, '{}'::jsonb) where id = $1 returning id, slug, name, settings`, [c.var.tenant.id, b.name ?? null, b.settings ? JSON.stringify(b.settings) : null]),
    );
    return c.json(row);
  })

  // ------------------------------------------------------------------ objects & fields
  .get('/objects', requireAdmin('metadata'), (c) => c.json({ items: c.var.meta.objects }))
  .post('/objects', requireAdmin('metadata'), async (c) => {
    const spec = objectSpecSchema.parse(await c.req.json());
    const id = await c.var.db.tx(scope(c), async (tx) => {
      const id = await createObject(tx, c.var.tenant.id, spec);
      if (!id) throw conflict(`Object "${spec.key}" already exists`);
      // custom objects get a default 2-stage pipeline so they can be tracked on a board
      return id;
    });
    return c.json({ id, key: spec.key }, 201);
  })
  .patch('/objects/:key', requireAdmin('metadata'), async (c) => {
    const b = objectSpecSchema.omit({ key: true }).partial().parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `update custom_objects set label = coalesce($3,label), plural_label = coalesce($4,plural_label), icon = coalesce($5,icon), description = coalesce($6,description)
          where tenant_id = $1 and key = $2 returning key`,
        [c.var.tenant.id, c.req.param('key'), b.label ?? null, b.plural ?? null, b.icon ?? null, b.description ?? null],
      ),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/objects/:key', requireAdmin('metadata'), async (c) => {
    const key = c.req.param('key');
    await c.var.db.tx(scope(c), async (tx) => {
      const o = await tx.one<{ is_standard: boolean }>(`select is_standard from custom_objects where tenant_id = $1 and key = $2`, [c.var.tenant.id, key]);
      if (!o) throw notFound();
      if (o.is_standard) throw badRequest('Standard objects cannot be deleted');
      const n = await tx.one<{ n: string }>(`select count(*) n from records where tenant_id = $1 and object_key = $2 and deleted_at is null`, [c.var.tenant.id, key]);
      if (Number(n?.n) > 0) throw conflict('Delete or migrate the records of this object first');
      await tx.query(`delete from custom_objects where tenant_id = $1 and key = $2`, [c.var.tenant.id, key]);
    });
    return c.json({ ok: true });
  })
  .put('/objects/:key/fields/:field', requireAdmin('metadata'), async (c) => {
    const spec = fieldSpecSchema.parse({ ...(await c.req.json()), key: c.req.param('field') });
    const id = await c.var.db.tx(scope(c), (tx) => upsertField(tx, c.var.tenant.id, c.req.param('key'), spec));
    return c.json({ id, key: spec.key });
  })
  .delete('/objects/:key/fields/:field', requireAdmin('metadata'), async (c) => {
    const { key, field } = c.req.param();
    await c.var.db.tx(scope(c), async (tx) => {
      const rows = await tx.query(`delete from custom_fields where tenant_id = $1 and object_key = $2 and key = $3 returning id`, [c.var.tenant.id, key, field]);
      if (!rows.length) throw notFound();
      await tx.query(`delete from record_index where tenant_id = $1 and object_key = $2 and field_key = $3`, [c.var.tenant.id, key, field]);
      // values stay in `custom` jsonb (recoverable); they are no longer exposed through the API
    });
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ pipelines
  .post('/pipelines', requireAdmin('metadata'), async (c) => {
    const spec = pipelineSpecSchema.parse(await c.req.json());
    const id = await c.var.db.tx(scope(c), (tx) => createPipeline(tx, c.var.tenant.id, spec));
    return c.json({ id }, 201);
  })
  .patch('/pipelines/:id', requireAdmin('metadata'), async (c) => {
    const b = z.object({ name: z.string().min(1).max(80).optional(), isDefault: z.boolean().optional() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const p = await tx.one<{ object_key: string }>(`select object_key from pipelines where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!p) throw notFound();
      if (b.isDefault) await tx.query(`update pipelines set is_default = false where tenant_id = $1 and object_key = $2 and id <> $3`, [c.var.tenant.id, p.object_key, id]);
      await tx.query(`update pipelines set name = coalesce($3, name), is_default = coalesce($4, is_default) where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, b.name ?? null, b.isDefault ?? null]);
    });
    return c.json({ ok: true });
  })
  .put('/pipelines/:id/stages', requireAdmin('metadata'), async (c) => {
    // full replace of the stage list (add / rename / reorder); stages in use cannot be removed
    const id = uuid.parse(c.req.param('id'));
    const stages = pipelineSpecSchema.shape.stages.parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      const p = await tx.one<{ object_key: string }>(`select object_key from pipelines where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!p) throw notFound();
      const current = await tx.query<{ id: string; key: string }>(`select id, key from pipeline_stages where tenant_id = $1 and pipeline_id = $2`, [c.var.tenant.id, id]);
      const keep = new Set(stages.map((s) => s.key));
      for (const s of current.filter((s) => !keep.has(s.key))) {
        const used = await tx.one(
          `select 1 from leads where tenant_id = $1 and stage_id = $2 union all select 1 from deals where tenant_id = $1 and stage_id = $2 union all select 1 from records where tenant_id = $1 and stage_id = $2 limit 1`,
          [c.var.tenant.id, s.id],
        );
        if (used) throw conflict(`Stage "${s.key}" still has records; move them before removing it`);
        await tx.query(`delete from pipeline_stages where tenant_id = $1 and id = $2`, [c.var.tenant.id, s.id]);
      }
      let pos = 1;
      for (const s of stages) {
        await tx.query(
          `insert into pipeline_stages (tenant_id, pipeline_id, key, label, position, probability, category, color) values ($1,$2,$3,$4,$5,$6,$7,$8)
           on conflict (pipeline_id, key) do update set label = excluded.label, position = excluded.position, probability = excluded.probability, category = excluded.category, color = excluded.color`,
          [c.var.tenant.id, id, s.key, s.label, pos++, s.probability, s.category, s.color ?? null],
        );
      }
    });
    return c.json({ ok: true });
  })
  .delete('/pipelines/:id', requireAdmin('metadata'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const used = await tx.one(`select 1 from leads where tenant_id = $1 and pipeline_id = $2 union all select 1 from deals where tenant_id = $1 and pipeline_id = $2 union all select 1 from records where tenant_id = $1 and pipeline_id = $2 limit 1`, [c.var.tenant.id, id]);
      if (used) throw conflict('Pipeline still has records');
      await tx.query(`delete from pipelines where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
    });
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ roles
  .get('/roles', requireAdmin('roles'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select r.*, (select count(*)::int from user_roles ur where ur.tenant_id = r.tenant_id and ur.role_id = r.id) as user_count from roles r where r.tenant_id = $1 order by r.is_system desc, r.name`, [c.var.tenant.id])) }),
  )
  .post('/roles', requireAdmin('roles'), async (c) => {
    const b = z.object({ key: z.string().regex(KEY_PATTERN), name: z.string().min(1).max(80), description: z.string().max(300).optional(), permissions: rolePermissionsSchema }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into roles (tenant_id, key, name, description, permissions) values ($1,$2,$3,$4,$5) returning *`, [c.var.tenant.id, b.key, b.name, b.description ?? null, JSON.stringify(b.permissions)]),
    );
    return c.json(row, 201);
  })
  .patch('/roles/:id', requireAdmin('roles'), async (c) => {
    const b = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(300).optional(), permissions: rolePermissionsSchema.optional() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.one<{ key: string }>(`select key from roles where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!r) throw notFound();
      if (r.key === 'admin' && b.permissions) throw badRequest('The Administrator role permissions are fixed');
      const out = await tx.one(
        `update roles set name = coalesce($3,name), description = coalesce($4,description), permissions = coalesce($5::jsonb, permissions) where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, id, b.name ?? null, b.description ?? null, b.permissions ? JSON.stringify(b.permissions) : null],
      );
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1,'permission_change','role',$2,$3)`, [c.var.tenant.id, id, JSON.stringify(b)]);
      return out;
    });
    return c.json(row);
  })
  .delete('/roles/:id', requireAdmin('roles'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.one<{ is_system: boolean }>(`select is_system from roles where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!r) throw notFound();
      if (r.is_system) throw badRequest('System roles cannot be deleted');
      await tx.query(`delete from roles where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
    });
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ users
  .get('/users', requireAdmin('users'), async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select u.id, u.email, u.full_name, u.status, u.is_owner, u.attributes, u.manager_id, u.last_login_at, u.created_at,
                  coalesce(array_agg(r.key) filter (where r.key is not null), '{}') as roles
             from users u left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
             left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
            where u.tenant_id = $1 group by u.id order by u.full_name`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/users', requireAdmin('users'), async (c) => {
    const b = z
      .object({
        email: z.string().trim().toLowerCase().pipe(z.email()),
        fullName: z.string().trim().min(1).max(120),
        password: z.string().optional(),
        roles: z.array(z.string()).min(1).default(['sales_rep']),
        attributes: z.record(z.string(), z.unknown()).default({}),
        managerId: uuid.nullish(),
      })
      .parse(await c.req.json());
    const tempPassword = b.password ?? `${randomToken(9)}Aa1!`;
    const policy = passwordPolicyError(tempPassword);
    if (policy) throw badRequest(policy);
    const hash = await hashPassword(tempPassword);
    const user = await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ id: string }>(
        `insert into users (tenant_id, email, full_name, password_hash, attributes, manager_id) values ($1,$2,$3,$4,$5,$6) returning id`,
        [c.var.tenant.id, b.email, b.fullName, hash, JSON.stringify(b.attributes), b.managerId ?? null],
      );
      const roles = await tx.query<{ id: string }>(`select id from roles where tenant_id = $1 and key = any($2)`, [c.var.tenant.id, b.roles]);
      if (roles.length !== b.roles.length) throw badRequest('Unknown role');
      for (const r of roles) await tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3)`, [c.var.tenant.id, u!.id, r.id]);
      return u!;
    });
    // the temporary password is returned once so the admin can share it securely
    return c.json({ id: user.id, temporaryPassword: b.password ? undefined : tempPassword }, 201);
  })
  .patch('/users/:id', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = z
      .object({
        fullName: z.string().min(1).max(120).optional(),
        status: z.enum(['active', 'disabled']).optional(),
        roles: z.array(z.string()).min(1).optional(),
        attributes: z.record(z.string(), z.unknown()).optional(),
        managerId: uuid.nullish(),
      })
      .parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ is_owner: boolean }>(`select is_owner from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!u) throw notFound();
      if (u.is_owner && b.status === 'disabled') throw badRequest('The workspace owner cannot be disabled');
      if (b.managerId === id) throw badRequest('A user cannot manage themselves');
      await tx.query(
        `update users set full_name = coalesce($3, full_name), status = coalesce($4, status), attributes = coalesce($5::jsonb, attributes),
                manager_id = case when $6::boolean then $7::uuid else manager_id end
          where tenant_id = $1 and id = $2`,
        [c.var.tenant.id, id, b.fullName ?? null, b.status ?? null, b.attributes ? JSON.stringify(b.attributes) : null, b.managerId !== undefined, b.managerId ?? null],
      );
      if (b.status === 'disabled') await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null`, [c.var.tenant.id, id]);
      if (b.roles) {
        const roles = await tx.query<{ id: string }>(`select id from roles where tenant_id = $1 and key = any($2)`, [c.var.tenant.id, b.roles]);
        if (roles.length !== b.roles.length) throw badRequest('Unknown role');
        await tx.query(`delete from user_roles where tenant_id = $1 and user_id = $2`, [c.var.tenant.id, id]);
        for (const r of roles) await tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3)`, [c.var.tenant.id, id, r.id]);
        await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1,'permission_change','user',$2,$3)`, [c.var.tenant.id, id, JSON.stringify({ roles: b.roles })]);
      }
    });
    await invalidatePrincipal(c.env, c.var.tenant, id);
    return c.json({ ok: true });
  })
  .post('/users/:id/reset-password', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const temp = `${randomToken(9)}Aa1!`;
    const hash = await hashPassword(temp);
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.query(`update users set password_hash = $3, failed_logins = 0, locked_until = null where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, id, hash]);
      if (!r.length) throw notFound();
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null`, [c.var.tenant.id, id]);
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id) values ($1,'password_reset','user',$2)`, [c.var.tenant.id, id]);
    });
    return c.json({ temporaryPassword: temp });
  })

  // ------------------------------------------------------------------ modules
  .get('/modules', requireAdmin('modules'), (c) => {
    const installed = new Map(c.var.meta.modules.map((m) => [m.key, m]));
    return c.json({
      items: Object.values(MODULES).map((m) => ({
        key: m.key, name: m.name, version: m.version, description: m.description, industry: m.industry,
        objects: m.objects.map((o) => o.label), installed: installed.has(m.key), installedVersion: installed.get(m.key)?.version ?? null,
      })),
    });
  })
  .post('/modules/:key/install', requireAdmin('modules'), async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => installModule(tx, c.var.tenant.id, c.req.param('key')));
    return c.json(r);
  })

  // ------------------------------------------------------------------ workflows
  .get('/workflows', requireAdmin('workflows'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select * from workflows where tenant_id = $1 order by object_key, name`, [c.var.tenant.id])) }),
  )
  .post('/workflows', requireAdmin('workflows'), async (c) => {
    const w = workflowSchema.parse(await c.req.json());
    if (!c.var.meta.objects.some((o) => o.key === w.objectKey)) throw badRequest('Unknown object');
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into workflows (tenant_id, name, object_key, trigger_event, conditions, actions, is_enabled) values ($1,$2,$3,$4,$5,$6,$7) returning *`, [c.var.tenant.id, w.name, w.objectKey, w.triggerEvent, JSON.stringify(w.conditions), JSON.stringify(w.actions), w.isEnabled]),
    );
    return c.json(row, 201);
  })
  .put('/workflows/:id', requireAdmin('workflows'), async (c) => {
    const w = workflowSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update workflows set name=$3, object_key=$4, trigger_event=$5, conditions=$6, actions=$7, is_enabled=$8 where tenant_id=$1 and id=$2 returning *`, [c.var.tenant.id, uuid.parse(c.req.param('id')), w.name, w.objectKey, w.triggerEvent, JSON.stringify(w.conditions), JSON.stringify(w.actions), w.isEnabled]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/workflows/:id', requireAdmin('workflows'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from workflows where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })
  .get('/workflows/:id/runs', requireAdmin('workflows'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select * from workflow_runs where tenant_id = $1 and workflow_id = $2 order by started_at desc limit 100`, [c.var.tenant.id, uuid.parse(c.req.param('id'))])) }),
  )

  // ------------------------------------------------------------------ forms (builder + web-to-lead)
  .get('/forms', requireAdmin('metadata'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select * from forms where tenant_id = $1 order by name`, [c.var.tenant.id])) }),
  )
  .post('/forms', requireAdmin('metadata'), async (c) => {
    const b = z
      .object({
        objectKey: z.string().regex(KEY_PATTERN),
        name: z.string().min(1).max(120),
        kind: z.enum(['layout', 'public']).default('layout'),
        layout: z.object({ sections: z.array(z.object({ title: z.string().max(120).optional(), columns: z.number().int().min(1).max(3).optional(), fields: z.array(z.string()).max(100) })).max(20) }),
        settings: z.record(z.string(), z.unknown()).default({}),
      })
      .parse(await c.req.json());
    const obj = c.var.meta.objects.find((o) => o.key === b.objectKey);
    if (!obj) throw badRequest('Unknown object');
    const known = new Set(obj.fields.map((f) => f.key));
    const bad = b.layout.sections.flatMap((s) => s.fields).filter((f) => !known.has(f));
    if (bad.length) throw badRequest(`Unknown fields: ${bad.join(', ')}`);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into forms (tenant_id, object_key, name, kind, layout, settings, public_key) values ($1,$2,$3,$4,$5,$6,$7) returning *`, [
        c.var.tenant.id, b.objectKey, b.name, b.kind, JSON.stringify(b.layout), JSON.stringify(b.settings), b.kind === 'public' ? randomToken(24) : null,
      ]),
    );
    return c.json(row, 201);
  })
  .delete('/forms/:id', requireAdmin('metadata'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from forms where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ channels
  .get('/channels', requireAdmin('channels'), async (c) => {
    const origin = new URL(c.req.url).origin;
    const rows = await c.var.db.tx(scope(c, true), (tx) => tx.query<{ inbound_key: string }>(`select id, channel, name, provider, config, status, inbound_key, created_at, (secret_ciphertext is not null) as has_secret from channel_accounts where tenant_id = $1 order by created_at`, [c.var.tenant.id]));
    return c.json({ items: rows.map((r) => ({ ...r, inboundUrl: `${origin}/api/public/inbound/${r.inbound_key}` })) });
  })
  .post('/channels', requireAdmin('channels'), async (c) => {
    const b = z
      .object({
        channel: z.enum(['email', 'whatsapp', 'sms', 'webhook']),
        name: z.string().min(1).max(80),
        provider: z.enum(['resend', 'meta_cloud', 'webhook', 'generic']),
        config: z.record(z.string(), z.unknown()).default({}),
        secrets: z.record(z.string(), z.string()).default({}),
      })
      .parse(await c.req.json());
    if (Object.keys(b.secrets).length && !c.env.DATA_ENCRYPTION_KEY) throw new ApiError(500, 'not_configured', 'DATA_ENCRYPTION_KEY secret is not set');
    const cipher = Object.keys(b.secrets).length ? await encryptSecret(c.env.DATA_ENCRYPTION_KEY!, JSON.stringify(b.secrets), c.var.tenant.id) : null;
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into channel_accounts (tenant_id, channel, name, provider, config, secret_ciphertext) values ($1,$2,$3,$4,$5,$6) returning id, inbound_key`, [c.var.tenant.id, b.channel, b.name, b.provider, JSON.stringify(b.config), cipher]),
    );
    return c.json(row, 201);
  })
  .delete('/channels/:id', requireAdmin('channels'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from channel_accounts where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ outbound webhooks
  .get('/webhooks', requireAdmin('channels'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select id, url, events, is_enabled, failure_count, created_at from webhook_subscriptions where tenant_id = $1`, [c.var.tenant.id])) }),
  )
  .post('/webhooks', requireAdmin('channels'), async (c) => {
    const b = z.object({ url: z.string().url().startsWith('https://'), events: z.array(z.string().regex(/^(\*|[a-z_]+\.(created|updated|stage_changed|deleted))$/)).min(1) }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) => tx.one(`insert into webhook_subscriptions (tenant_id, url, events) values ($1,$2,$3) returning id, url, events, secret`, [c.var.tenant.id, b.url, b.events]));
    return c.json(row, 201); // secret shown once for signature verification
  })
  .delete('/webhooks/:id', requireAdmin('channels'), async (c) => {
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from webhook_subscriptions where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ custom domains (Cloudflare for SaaS)
  .get('/domains', requireAdmin('domains'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select hostname, kind, status, verification, created_at from tenant_domains where tenant_id = $1 order by kind, hostname`, [c.var.tenant.id])) }),
  )
  .post('/domains', requireAdmin('domains'), async (c) => {
    const { hostname } = z.object({ hostname: z.string().toLowerCase().regex(/^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/) }).parse(await c.req.json());
    if (c.env.BASE_DOMAIN && hostname.endsWith(`.${c.env.BASE_DOMAIN}`)) throw badRequest('Use your own domain; platform subdomains are assigned automatically');
    if (!c.env.CF_ZONE_ID || !c.env.CF_SAAS_API_TOKEN) throw new ApiError(501, 'not_configured', 'Custom domains are not configured on this deployment');
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${c.env.CF_ZONE_ID}/custom_hostnames`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.env.CF_SAAS_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hostname, ssl: { method: 'http', type: 'dv', settings: { min_tls_version: '1.2' } } }),
    });
    const j = (await res.json()) as { success: boolean; errors?: { message: string }[]; result?: { id: string; ownership_verification?: unknown; ssl?: { validation_records?: unknown } } };
    if (!j.success || !j.result) throw badRequest(j.errors?.[0]?.message ?? 'Cloudflare rejected the hostname');
    const verification = { ownership: j.result.ownership_verification ?? null, ssl: j.result.ssl?.validation_records ?? null, cname: `Point a CNAME record for ${hostname} to ${c.env.SAAS_CNAME_TARGET ?? c.env.APP_HOST ?? c.env.BASE_DOMAIN}` };
    await c.var.db.tx(scope(c), (tx) => tx.query(`select app.add_custom_domain($1, $2, $3)`, [hostname, j.result!.id, JSON.stringify(verification)]));
    return c.json({ hostname, status: 'pending', verification }, 201);
  })
  .post('/domains/workspace-subdomain', requireAdmin('domains'), async (c) => {
    // enables <slug>.<BASE_DOMAIN> for an existing workspace (Workers Custom Domain, own certificate)
    if (!vanityEnabled(c.env)) throw new ApiError(501, 'not_configured', 'Workspace subdomains are not enabled on this deployment');
    const hostname = vanityHost(c.env, c.var.tenant.slug);
    const r = await attachWorkerDomain(c.env, hostname);
    await c.var.db.tx(scope(c), async (tx) => {
      await tx.query(`select app.add_workspace_subdomain($1)`, [hostname]);
      await tx.query(`select app.set_domain_status($1, $2, $3)`, [hostname, r.ok ? 'active' : 'failed', JSON.stringify(r.ok ? {} : { error: r.error })]);
    });
    if (!r.ok) throw badRequest(`Cloudflare rejected ${hostname}: ${r.error}`);
    return c.json({ hostname, status: 'active' });
  })
  .post('/domains/:hostname/refresh', requireAdmin('domains'), async (c) => {
    const hostname = c.req.param('hostname').toLowerCase();
    const d = await c.var.db.tx(scope(c, true), (tx) => tx.one<{ cf_custom_hostname_id: string }>(`select cf_custom_hostname_id from tenant_domains where tenant_id = $1 and hostname = $2 and kind = 'custom'`, [c.var.tenant.id, hostname]));
    if (!d) throw notFound();
    if (!c.env.CF_ZONE_ID || !c.env.CF_SAAS_API_TOKEN) throw new ApiError(501, 'not_configured', 'Custom domains are not configured');
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${c.env.CF_ZONE_ID}/custom_hostnames/${d.cf_custom_hostname_id}`, { headers: { authorization: `Bearer ${c.env.CF_SAAS_API_TOKEN}` } });
    const j = (await res.json()) as { result?: { status?: string; ssl?: { status?: string; validation_records?: unknown } } };
    const active = j.result?.status === 'active' && j.result?.ssl?.status === 'active';
    await c.var.db.tx(scope(c), (tx) => tx.query(`select app.set_domain_status($1, $2, $3)`, [hostname, active ? 'active' : 'pending', JSON.stringify({ cfStatus: j.result?.status, sslStatus: j.result?.ssl?.status })]));
    return c.json({ hostname, status: active ? 'active' : 'pending' });
  })

  // ------------------------------------------------------------------ AI models (bring your own keys)
  .get('/ai/providers', requireAdmin('ai'), async (c) => {
    const data = await c.var.db.tx(scope(c, true), async (tx) => ({
      items: await tx.query(
        `select id, provider, label, model, base_url, key_hint, allow_pii, priority, is_enabled, last_used_at, last_error, created_at
           from tenant_ai_providers where tenant_id = $1 order by priority, created_at`,
        [c.var.tenant.id],
      ),
      settings: await tenantAiSettings(tx, c.var.tenant.id),
    }));
    return c.json({ ...data, encryptionConfigured: !!c.env.DATA_ENCRYPTION_KEY });
  })
  .post('/ai/providers', requireAdmin('ai'), async (c) => {
    const b = createProviderSchema.parse(await c.req.json());
    const n = normaliseCreate(b);
    const cipher = await encryptKey(c.env, c.var.tenant.id, b.apiKey);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `insert into tenant_ai_providers (tenant_id, provider, label, model, base_url, secret_ciphertext, key_hint, allow_pii, priority)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id, provider, label, model, base_url, key_hint, allow_pii, priority, is_enabled`,
        [c.var.tenant.id, b.provider, n.label, n.model, n.baseUrl, cipher, hint(b.apiKey), b.allowPii, b.priority],
      ),
    );
    return c.json(row, 201);
  })
  .patch('/ai/providers/:id', requireAdmin('ai'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const b = updateProviderSchema.parse(await c.req.json());
    const cipher = b.apiKey ? await encryptKey(c.env, c.var.tenant.id, b.apiKey) : null;
    const baseUrl = b.baseUrl ? assertSafeBaseUrl(b.baseUrl) : null;
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(
        `update tenant_ai_providers set
            label = coalesce($3, label), model = coalesce($4, model),
            base_url = case when $5::boolean then $6 else base_url end,
            secret_ciphertext = coalesce($7, secret_ciphertext), key_hint = coalesce($8, key_hint),
            allow_pii = coalesce($9, allow_pii), priority = coalesce($10, priority), is_enabled = coalesce($11, is_enabled),
            last_error = case when $7 is not null then null else last_error end
          where tenant_id = $1 and id = $2
          returning id, provider, label, model, base_url, key_hint, allow_pii, priority, is_enabled`,
        [c.var.tenant.id, id, b.label ?? null, b.model ?? null, b.baseUrl !== undefined, baseUrl, cipher, b.apiKey ? hint(b.apiKey) : null, b.allowPii ?? null, b.priority ?? null, b.isEnabled ?? null],
      ),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/ai/providers/:id', requireAdmin('ai'), async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from tenant_ai_providers where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })
  .post('/ai/providers/:id/test', requireAdmin('ai'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const cfg = (await c.var.db.tx(scope(c, true), (tx) => loadTenantProviders(c.env, tx, c.var.tenant.id))).find((p) => p.id === id);
    if (!cfg) throw notFound('Provider not found or disabled');
    const started = Date.now();
    try {
      const r = await chatWith([{ ...tenantProvider(cfg), allowPii: true }], {
        task: 'provider_test',
        containsPii: false,
        maxTokens: 20,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      });
      await c.var.db.tx(scope(c), (tx) => tx.query(`update tenant_ai_providers set last_used_at = now(), last_error = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]));
      return c.json({ ok: true, reply: r.text.slice(0, 60), latencyMs: Date.now() - started });
    } catch (e) {
      const msg = (e as Error).message.replace(/^All AI providers failed: /, '').slice(0, 300);
      await c.var.db.tx(scope(c), (tx) => tx.query(`update tenant_ai_providers set last_error = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, id, msg]));
      return c.json({ ok: false, error: msg }, 200);
    }
  })
  .put('/ai/settings', requireAdmin('ai'), async (c) => {
    const b = z.object({ platformFallback: z.boolean() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) =>
      tx.query(`update tenants set settings = jsonb_set(settings, '{ai}', coalesce(settings->'ai', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify({ platformFallback: b.platformFallback })]),
    );
    return c.json({ ok: true, ...b });
  })

  // ------------------------------------------------------------------ audit
  .get('/audit', requireAdmin('audit'), async (c) => {
    const q = z.object({ object: z.string().optional(), record: uuid.optional(), action: z.string().optional(), before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).parse(c.req.query());
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query(
        `select a.*, u.full_name as actor_name from audit_logs a left join users u on u.tenant_id = a.tenant_id and u.id = a.actor_id
          where a.tenant_id = $1 and ($2::text is null or a.object_key = $2) and ($3::uuid is null or a.record_id = $3)
            and ($4::text is null or a.action = $4) and ($5::timestamptz is null or a.created_at < $5)
          order by a.created_at desc limit $6`,
        [c.var.tenant.id, q.object ?? null, q.record ?? null, q.action ?? null, q.before ?? null, q.limit],
      ),
    );
    return c.json({ items: rows });
  });
