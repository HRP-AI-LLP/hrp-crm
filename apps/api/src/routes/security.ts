/**
 * Security & admin: workspace security policy, invitations and reset links, MFA resets,
 * teams, sharing rules, API keys and a usage overview. Mounted under /api/admin.
 */
import { KEY_PATTERN, type SecurityPolicy, valueSchema, valueType } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { networkRefusal, parseCidr, requestIp } from '../lib/ip';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { Waiter } from '../services/jobs';
import { backupStream, deleteBackup, listBackups, startBackup } from '../services/backup';
import { requireAdmin, scope } from '../middleware';
import { actionEmail, appOrigin, sendPlatformMail } from '../services/mailer';
import { invalidatePrincipal } from '../services/tenancy';
import { createUserToken } from './auth';

const uuid = z.string().uuid();
const RULE_OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'in', 'is_null', 'not_null'] as const;
const criteriaSchema = z.array(z.object({ field: z.string().regex(KEY_PATTERN), op: z.enum(RULE_OPS), value: z.unknown().optional() })).max(10);

export async function sendInvite(c: { env: AppEnv['Bindings']; req: { url: string }; var: AppEnv['Variables'] }, user: { email: string; full_name: string }, token: string) {
  const url = `${appOrigin(c.env, c.req.url)}/accept-invite?workspace=${c.var.tenant.slug}&token=${token}`;
  const mail = actionEmail({
    heading: `Join ${c.var.tenant.name} on HRP Synapse`,
    intro: `Hi ${user.full_name}, ${c.var.principal.user.fullName} invited you to the ${c.var.tenant.name} workspace.`,
    cta: 'Accept the invitation',
    url,
    footer: 'The invitation is valid for 7 days.',
  });
  const emailed = await sendPlatformMail(c.env, { to: user.email, subject: `You're invited to ${c.var.tenant.name} on HRP Synapse`, ...mail });
  return { url, emailed };
}

function ownerOnly(c: { var: AppEnv['Variables'] }) {
  if (!c.var.principal.user.isOwner) throw forbidden('Only the workspace owner can manage backups');
}
function waiterOf(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): Waiter | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

export const securityRoutes = new Hono<AppEnv>()
  // ------------------------------------------------------------------ policy
  .get('/security', requireAdmin('users'), async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const t = await tx.one<{ security: Record<string, unknown> | null }>(`select settings -> 'security' as security from tenants where id = $1`, [c.var.tenant.id]);
      const stats = await tx.one<{ users: number; mfa: number; invited: number }>(
        `select count(*) filter (where status = 'active')::int as users, count(*) filter (where status = 'active' and mfa_enabled_at is not null)::int as mfa,
                count(*) filter (where status = 'invited')::int as invited from users where tenant_id = $1`,
        [c.var.tenant.id],
      );
      const sec = (t?.security ?? {}) as SecurityPolicy;
      return { policy: { requireMfa: sec.requireMfa === true, ipAllowlist: sec.ipAllowlist ?? [], countries: sec.countries ?? [] }, stats };
    });
    return c.json({ ...out, mailer: !!c.env.RESEND_API_KEY, you: { ip: requestIp(c.env, (n) => c.req.header(n)), country: c.req.header('cf-ipcountry') ?? null } });
  })
  .put('/security', requireAdmin('users'), async (c) => {
    const b = z
      .object({
        requireMfa: z.boolean().optional(),
        ipAllowlist: z
          .array(z.string().trim().min(2).max(64))
          .max(100)
          .optional()
          .refine((l) => !l || l.every((x) => parseCidr(x)), 'Use IP addresses or CIDR ranges such as 203.0.113.0/24 or 2001:db8::/32'),
        countries: z
          .array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use two-letter country codes such as IN'))
          .max(60)
          .optional(),
      })
      .parse(await c.req.json());
    if (b.requireMfa && !c.var.principal.user.mfaEnabled) throw badRequest('Turn on two-factor sign-in for your own account first, so you are not locked out');
    // never save a policy that would shut out the admin making the change
    const cur = (c.var.meta.tenant.security ?? {}) as SecurityPolicy;
    const next: SecurityPolicy = { ipAllowlist: b.ipAllowlist ?? cur.ipAllowlist ?? [], countries: b.countries ?? cur.countries ?? [] };
    const lockout = networkRefusal(c.env, next, (n) => c.req.header(n));
    if (lockout) throw badRequest(`This change would block your own access: ${lockout}. Include your current network first.`);
    await c.var.db.tx(scope(c), async (tx) => {
      await tx.query(`update tenants set settings = jsonb_set(settings, '{security}', coalesce(settings -> 'security', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify(b)]);
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1,'security_policy','tenant',$2)`, [c.var.tenant.id, JSON.stringify(b)]);
    });
    return c.json({ ok: true, policy: { ...cur, ...b } });
  })

  // ------------------------------------------------------------------ backups (workspace owner only: they contain everything)
  .get('/backups', async (c) => {
    ownerOnly(c);
    const daily = await c.var.db.tx(scope(c, true), (tx) => tx.one<{ on: boolean }>(`select coalesce((settings -> 'backup' ->> 'daily')::boolean, false) as on from tenants where id = $1`, [c.var.tenant.id]));
    if (!c.env.FILES) return c.json({ available: false, daily: daily?.on ?? false, items: [] });
    return c.json({ available: true, daily: daily?.on ?? false, items: await listBackups(c.env, c.var.tenant.id) });
  })
  .post('/backups', async (c) => {
    ownerOnly(c);
    const m = await startBackup(c.env, c.var.db, waiterOf(c), c.var.tenant.id, c.var.principal.user.id);
    await c.var.db.tx(scope(c), (tx) => tx.query(`insert into audit_logs (tenant_id, action, object_key, changes) values ($1,'backup_started','tenant',$2)`, [c.var.tenant.id, JSON.stringify({ stamp: m.stamp })]));
    return c.json(m, 202);
  })
  .put('/backups/settings', async (c) => {
    ownerOnly(c);
    const b = z.object({ daily: z.boolean() }).parse(await c.req.json());
    if (b.daily && !c.env.FILES) throw badRequest('File storage (R2) is not set up for this server');
    await c.var.db.tx(scope(c), (tx) => tx.query(`update tenants set settings = jsonb_set(settings, '{backup}', coalesce(settings -> 'backup', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify(b)]));
    return c.json(b);
  })
  .get('/backups/:stamp/download', async (c) => {
    ownerOnly(c);
    const { body, m } = await backupStream(c.env, c.var.tenant.id, c.req.param('stamp'));
    await c.var.db.tx(scope(c), (tx) => tx.query(`insert into audit_logs (tenant_id, action, object_key, changes, ip) values ($1,'backup_downloaded','tenant',$2,$3)`, [c.var.tenant.id, JSON.stringify({ stamp: m.stamp }), c.req.header('cf-connecting-ip') ?? null]));
    return new Response(body, {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="synapse-${c.var.tenant.slug}-${m.stamp}.ndjson.gz"`,
        'cache-control': 'no-store',
      },
    });
  })
  .delete('/backups/:stamp', async (c) => {
    ownerOnly(c);
    const stamp = c.req.param('stamp');
    if (!/^[0-9TZ-]{10,40}$/.test(stamp)) throw notFound();
    if (!c.env.FILES) throw notFound();
    await deleteBackup(c.env, c.var.tenant.id, stamp);
    return c.body(null, 204);
  })

  // ------------------------------------------------------------------ invitations, reset links, MFA reset, sign-out
  .post('/users/invite', requireAdmin('users'), async (c) => {
    const b = z
      .object({ email: z.string().trim().toLowerCase().pipe(z.email()), fullName: z.string().trim().min(1).max(120), roles: z.array(z.string()).min(1).default(['sales_rep']), managerId: uuid.nullish(), teamIds: z.array(uuid).max(20).default([]) })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const exists = await tx.one(`select 1 from users where tenant_id = $1 and lower(email) = $2`, [c.var.tenant.id, b.email]);
      if (exists) throw conflict('Someone with this email is already in the workspace');
      const u = await tx.one<{ id: string }>(`insert into users (tenant_id, email, full_name, status, manager_id) values ($1,$2,$3,'invited',$4) returning id`, [c.var.tenant.id, b.email, b.fullName, b.managerId ?? null]);
      const roles = await tx.query<{ id: string }>(`select id from roles where tenant_id = $1 and key = any($2)`, [c.var.tenant.id, b.roles]);
      if (roles.length !== b.roles.length) throw badRequest('Unknown role');
      for (const role of roles) await tx.query(`insert into user_roles (tenant_id, user_id, role_id) values ($1,$2,$3)`, [c.var.tenant.id, u!.id, role.id]);
      for (const t of b.teamIds) await tx.query(`insert into team_members (tenant_id, team_id, user_id) values ($1,$2,$3) on conflict do nothing`, [c.var.tenant.id, t, u!.id]);
      return { id: u!.id, token: await createUserToken(tx, c.var.tenant.id, u!.id, 'invite', 7 * 86_400) };
    });
    const sent = await sendInvite(c, { email: b.email, full_name: b.fullName }, r.token);
    return c.json({ id: r.id, inviteUrl: sent.url, emailed: sent.emailed }, 201);
  })
  .post('/users/:id/invite-link', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ email: string; full_name: string; status: string }>(`select email, full_name, status from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!u) throw notFound();
      if (u.status !== 'invited') throw badRequest('This person has already joined');
      return { u, token: await createUserToken(tx, c.var.tenant.id, id, 'invite', 7 * 86_400) };
    });
    const sent = await sendInvite(c, r.u, r.token);
    return c.json({ inviteUrl: sent.url, emailed: sent.emailed });
  })
  .post('/users/:id/reset-link', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ email: string; full_name: string; status: string; is_owner: boolean }>(`select email, full_name, status, is_owner from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (!u) throw notFound();
      if (u.status !== 'active') throw badRequest('Only active users can reset a password');
      if (u.is_owner && id !== c.var.principal.user.id) throw badRequest('Only the owner can reset the owner’s password');
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id) values ($1,'password_reset_link','user',$2)`, [c.var.tenant.id, id]);
      return { u, token: await createUserToken(tx, c.var.tenant.id, id, 'reset', 24 * 3600) };
    });
    const url = `${appOrigin(c.env, c.req.url)}/reset-password?workspace=${c.var.tenant.slug}&token=${r.token}`;
    const mail = actionEmail({ heading: 'Set a new password', intro: `Hi ${r.u.full_name}, your administrator sent you a link to set a new password for ${c.var.tenant.name}.`, cta: 'Choose a new password', url, footer: 'The link works for 24 hours.' });
    const emailed = await sendPlatformMail(c.env, { to: r.u.email, subject: 'Set a new HRP Synapse password', ...mail });
    return c.json({ resetUrl: url, emailed });
  })
  .post('/users/:id/reset-mfa', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const target = await tx.one<{ is_owner: boolean }>(`select is_owner from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, id]);
      if (target?.is_owner && !c.var.principal.user.isOwner) throw badRequest('Only the owner can reset the owner’s two-factor sign-in');
      const rows = await tx.query(`update users set mfa_enabled_at = null, mfa_secret_ciphertext = null, mfa_recovery_hashes = '{}', mfa_last_step = null where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, id]);
      if (!rows.length) throw notFound();
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null`, [c.var.tenant.id, id]);
      await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id) values ($1,'mfa_reset_by_admin','user',$2)`, [c.var.tenant.id, id]);
    });
    await invalidatePrincipal(c.env, c.var.tenant, id);
    return c.json({ ok: true });
  })
  .post('/users/:id/sign-out', requireAdmin('users'), async (c) => {
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null`, [c.var.tenant.id, id]);
      // their phones stop receiving workspace notifications too
      await tx.query(`delete from push_subscriptions where tenant_id = $1 and user_id = $2`, [c.var.tenant.id, id]);
    });
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ teams
  .get('/teams', requireAdmin('users'), async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select t.id, t.name, t.description, t.lead_id, l.full_name as lead_name,
                  coalesce(array_agg(tm.user_id) filter (where tm.user_id is not null), '{}') as member_ids
             from teams t left join users l on l.tenant_id = t.tenant_id and l.id = t.lead_id
             left join team_members tm on tm.tenant_id = t.tenant_id and tm.team_id = t.id
            where t.tenant_id = $1 group by t.id, l.full_name order by t.name`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/teams', requireAdmin('users'), async (c) => {
    const b = teamSchema.parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const t = await tx.one<{ id: string }>(`insert into teams (tenant_id, name, description, lead_id) values ($1,$2,$3,$4) returning id`, [c.var.tenant.id, b.name, b.description ?? null, b.leadId ?? null]);
      for (const m of b.memberIds) await tx.query(`insert into team_members (tenant_id, team_id, user_id) values ($1,$2,$3) on conflict do nothing`, [c.var.tenant.id, t!.id, m]);
      return t;
    }).catch((e) => {
      if (String((e as Error).message).includes('teams_tenant_id_name_key')) throw conflict('A team with this name already exists');
      throw e;
    });
    return c.json(row, 201);
  })
  .put('/teams/:id', requireAdmin('users'), async (c) => {
    const b = teamSchema.parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    await c.var.db.tx(scope(c), async (tx) => {
      const r = await tx.query(`update teams set name = $3, description = $4, lead_id = $5 where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, id, b.name, b.description ?? null, b.leadId ?? null]);
      if (!r.length) throw notFound();
      await tx.query(`delete from team_members where tenant_id = $1 and team_id = $2 and not (user_id = any($3::uuid[]))`, [c.var.tenant.id, id, b.memberIds]);
      for (const m of b.memberIds) await tx.query(`insert into team_members (tenant_id, team_id, user_id) values ($1,$2,$3) on conflict do nothing`, [c.var.tenant.id, id, m]);
    });
    return c.json({ ok: true });
  })
  .delete('/teams/:id', requireAdmin('users'), async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from teams where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ sharing rules
  .get('/sharing-rules', requireAdmin('roles'), async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select s.*, t.name as team_name from sharing_rules s left join teams t on t.tenant_id = s.tenant_id and t.id = s.team_id where s.tenant_id = $1 order by s.object_key, s.name`, [c.var.tenant.id])) }),
  )
  .post('/sharing-rules', requireAdmin('roles'), async (c) => {
    const b = ruleSchema.parse(await c.req.json());
    checkRule(c.var.meta, b);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`insert into sharing_rules (tenant_id, object_key, name, criteria, team_id, role_key, access, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [
        c.var.tenant.id, b.objectKey, b.name, JSON.stringify(b.criteria), b.teamId ?? null, b.roleKey ?? null, b.access, b.isActive,
      ]),
    );
    return c.json(row, 201);
  })
  .put('/sharing-rules/:id', requireAdmin('roles'), async (c) => {
    const b = ruleSchema.parse(await c.req.json());
    checkRule(c.var.meta, b);
    const row = await c.var.db.tx(scope(c), (tx) =>
      tx.one(`update sharing_rules set object_key=$3, name=$4, criteria=$5, team_id=$6, role_key=$7, access=$8, is_active=$9 where tenant_id=$1 and id=$2 returning *`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), b.objectKey, b.name, JSON.stringify(b.criteria), b.teamId ?? null, b.roleKey ?? null, b.access, b.isActive,
      ]),
    );
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/sharing-rules/:id', requireAdmin('roles'), async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`delete from sharing_rules where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ API keys
  .get('/api-keys', requireAdmin('users'), async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select k.id, k.name, k.prefix, k.scopes, k.rate_limit_per_min, k.expires_at, k.revoked_at, k.last_used_at, k.last_used_ip, k.use_count, k.created_at, k.user_id, u.full_name as user_name
             from api_keys k join users u on u.tenant_id = k.tenant_id and u.id = k.user_id where k.tenant_id = $1 order by k.revoked_at nulls first, k.created_at desc`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/api-keys', requireAdmin('users'), async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(80), userId: uuid.nullish(), scopes: z.array(z.enum(['read', 'write'])).min(1).default(['read']), expiresInDays: z.number().int().min(1).max(730).nullish(), rateLimitPerMin: z.number().int().min(10).max(6000).default(600) }).parse(await c.req.json());
    const userId = b.userId ?? c.var.principal.user.id;
    const secret = randomToken(32);
    const key = `syn_${c.var.tenant.slug}_${secret}`;
    const scopes = b.scopes.includes('write') ? ['read', 'write'] : ['read'];
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ status: string; is_owner: boolean }>(`select status, is_owner from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, userId]);
      if (!u || u.status !== 'active') throw badRequest('The key must act as an active user');
      if (u.is_owner && !c.var.principal.user.isOwner) throw badRequest('Only the owner can create keys that act as the owner');
      return tx.one<{ id: string }>(
        `insert into api_keys (tenant_id, name, prefix, key_hash, user_id, scopes, expires_at, rate_limit_per_min) values ($1,$2,$3,$4,$5,$6, case when $7::int is null then null else now() + make_interval(days => $7::int) end, $8) returning id`,
        [c.var.tenant.id, b.name, `${key.slice(0, 12 + c.var.tenant.slug.length)}…`, await sha256Hex(key), userId, scopes, b.expiresInDays ?? null, b.rateLimitPerMin],
      );
    });
    // the full key is shown exactly once
    return c.json({ id: row!.id, key, scopes }, 201);
  })
  .delete('/api-keys/:id', requireAdmin('users'), async (c) => {
    const rows = await c.var.db.tx(scope(c), (tx) => tx.query(`update api_keys set revoked_at = now() where tenant_id = $1 and id = $2 and revoked_at is null returning id`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    if (!rows.length) throw notFound();
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ usage
  .get('/usage', requireAdmin('users'), async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const t = c.var.tenant.id;
      const one = async (sql: string) => Number((await tx.one<{ n: string }>(sql, [t]))?.n ?? 0);
      const records: Record<string, number> = {};
      for (const [k, sql] of [
        ['lead', `select count(*) n from leads where tenant_id = $1 and deleted_at is null`],
        ['contact', `select count(*) n from contacts where tenant_id = $1 and deleted_at is null`],
        ['account', `select count(*) n from accounts where tenant_id = $1 and deleted_at is null`],
        ['deal', `select count(*) n from deals where tenant_id = $1 and deleted_at is null`],
        ['product', `select count(*) n from products where tenant_id = $1 and deleted_at is null`],
        ['quote', `select count(*) n from quotes where tenant_id = $1 and deleted_at is null`],
      ] as const)
        records[k] = await one(sql);
      for (const r of await tx.query<{ object_key: string; n: string }>(`select object_key, count(*) n from records where tenant_id = $1 and deleted_at is null group by object_key`, [t])) records[r.object_key] = Number(r.n);
      const ai = await tx.query<{ provider: string; calls: string; tokens: string }>(
        `select provider, count(*) calls, coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0) tokens from ai_usage where tenant_id = $1 and created_at >= date_trunc('month', now()) group by provider order by 2 desc`,
        [t],
      );
      const messages = await tx.query<{ channel: string; direction: string; n: string }>(`select channel, direction, count(*) n from messages where tenant_id = $1 and created_at >= date_trunc('month', now()) group by 1, 2`, [t]);
      return {
        users: await tx.one<{ active: number; invited: number; disabled: number }>(`select count(*) filter (where status = 'active')::int active, count(*) filter (where status = 'invited')::int invited, count(*) filter (where status = 'disabled')::int disabled from users where tenant_id = $1`, [t]),
        records,
        totalRecords: Object.values(records).reduce((a, b) => a + b, 0),
        activities: await one(`select count(*) n from activities where tenant_id = $1`),
        tasksOpen: await one(`select count(*) n from tasks where tenant_id = $1 and status in ('open', 'in_progress')`),
        automationsThisMonth: await one(`select count(*) n from workflow_runs where tenant_id = $1 and started_at >= date_trunc('month', now())`),
        aiThisMonth: ai.map((a) => ({ provider: a.provider, calls: Number(a.calls), tokens: Number(a.tokens) })),
        messagesThisMonth: messages.map((m) => ({ channel: m.channel, direction: m.direction, count: Number(m.n) })),
        kbDocuments: await one(`select count(*) n from kb_documents where tenant_id = $1`),
        apiKeys: await tx.one<{ active: number; calls: number }>(`select count(*) filter (where revoked_at is null)::int active, coalesce(sum(use_count), 0)::int calls from api_keys where tenant_id = $1`, [t]),
        storageBytes: await one(
          `select coalesce(sum(pg_column_size(x.*)), 0) n from (
             select custom from leads where tenant_id = $1 union all select custom from contacts where tenant_id = $1
             union all select custom from accounts where tenant_id = $1 union all select custom from deals where tenant_id = $1
             union all select custom from records where tenant_id = $1) x`,
        ),
      };
    });
    return c.json(out);
  });

const teamSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).nullish(), leadId: uuid.nullish(), memberIds: z.array(uuid).max(500).default([]) });
const ruleSchema = z
  .object({
    objectKey: z.string().regex(KEY_PATTERN),
    name: z.string().trim().min(1).max(120),
    criteria: criteriaSchema.default([]),
    teamId: uuid.nullish(),
    roleKey: z.string().regex(KEY_PATTERN).nullish(),
    access: z.enum(['read', 'edit']).default('read'),
    isActive: z.boolean().default(true),
  })
  .refine((r) => !!r.teamId !== !!r.roleKey, { message: 'Share with exactly one team or one role', path: ['teamId'] });

function checkRule(meta: AppEnv['Variables']['meta'], r: z.infer<typeof ruleSchema>) {
  const obj = meta.objects.find((o) => o.key === r.objectKey);
  if (!obj) throw badRequest('Unknown object');
  for (const c of r.criteria) {
    const f = obj.fields.find((x) => x.key === c.field);
    if (!f) throw badRequest(`Unknown field "${c.field}"`);
    if (c.op === 'is_null' || c.op === 'not_null') continue;
    const vt = valueType(f);
    const numeric = ['number', 'currency', 'percent'].includes(vt);
    const dated = ['date', 'datetime'].includes(vt);
    if (['gt', 'gte', 'lt', 'lte'].includes(c.op) && !numeric && !dated) throw badRequest(`"${f.label}" cannot be compared with greater/less than`);
    if ((c.op === 'contains' || c.op === 'starts_with') && (numeric || dated || vt === 'boolean')) throw badRequest(`"${f.label}" cannot use "${c.op}"`);
    // values must have the field's type, or every query using the rule would fail
    const values = c.op === 'in' ? (Array.isArray(c.value) ? c.value : [c.value]) : [c.value];
    for (const v of values) {
      if (v === undefined || v === null || v === '') throw badRequest(`Give a value for "${f.label}"`);
      if (c.op === 'contains' || c.op === 'starts_with') continue;
      const ok = valueSchema(vt === 'multipicklist' ? { ...f, type: 'picklist' } : f).safeParse(numeric && typeof v === 'string' ? Number(v) : v);
      if (!ok.success) throw badRequest(`"${String(v)}" is not a valid value for "${f.label}"`);
    }
  }
}
