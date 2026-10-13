import { hashPassword, passwordPolicyError } from '@synapse/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, conflict, notFound } from '../lib/errors';
import type { ChannelAccount } from '../services/channels';
import { verifyMetaSignature, webhookVerifyToken } from '../services/channels';
import { enqueue, eventJobs } from '../services/jobs';
import { createRecord } from '../services/records';
import { attachWorkerDomain, signInUrl, vanityEnabled, vanityHost } from '../services/domains';
import { isAppHost, loadMeta, resolveTenant } from '../services/tenancy';
import { systemPrincipal } from '../services/worker';

const RESERVED_SLUGS = new Set(['www', 'app', 'api', 'admin', 'mail', 'smtp', 'status', 'docs', 'help', 'support', 'billing', 'static', 'assets', 'cdn', 'auth', 'login', 'signup', 'dev', 'staging', 'prod', 'hrp', 'synapse']);

async function verifyTurnstile(secret: string | undefined, token: string | undefined, ip: string | undefined): Promise<boolean> {
  if (!secret) return true; // not configured (dev)
  if (!token) return false;
  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const j = (await res.json()) as { success?: boolean };
  return !!j.success;
}

const signupSchema = z.object({
  workspaceName: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, '3–40 chars: lowercase letters, digits, hyphens'),
  fullName: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string(),
  turnstileToken: z.string().optional(),
});

export const publicRoutes = new Hono<AppEnv>()
  .get('/health', (c) => c.json({ ok: true, env: c.env.APP_ENV, time: new Date().toISOString() }))

  /** Lets the SPA know whether the current hostname maps to a workspace. */
  .get('/tenant', async (c) => {
    const tenant = await resolveTenant(c.env, c.var.db, new URL(c.req.url).host, c.req.header('x-tenant') ?? null);
    return c.json({
      tenant: tenant && tenant.status === 'active' ? { slug: tenant.slug, name: tenant.name } : null,
      signupEnabled: c.env.SIGNUP_ENABLED === 'true',
      tenantHeaderAllowed: isAppHost(c.env, new URL(c.req.url).host),
      appHost: c.env.APP_HOST ?? null,
      vanityDomains: vanityEnabled(c.env) ? c.env.BASE_DOMAIN : null,
    });
  })

  .post('/signup', async (c) => {
    if (c.env.SIGNUP_ENABLED !== 'true') throw new ApiError(403, 'signup_disabled', 'Self-service signup is disabled');
    const body = signupSchema.parse(await c.req.json());
    if (RESERVED_SLUGS.has(body.slug)) throw badRequest('That workspace address is reserved');
    const policy = passwordPolicyError(body.password);
    if (policy) throw badRequest(policy);
    if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, body.turnstileToken, c.req.header('cf-connecting-ip')))) throw badRequest('Bot check failed');
    const existing = await c.var.db.platform(`select 1 from app.resolve_tenant_by_slug($1)`, [body.slug]);
    if (existing.length) throw conflict('That workspace address is taken');
    const hash = await hashPassword(body.password);
    const vanity = vanityEnabled(c.env);
    const rows = await c.var.db.platform<{ id: string }>(`select app.create_tenant($1,$2,$3,$4,$5,$6) as id`, [body.slug, body.workspaceName, vanity ? c.env.BASE_DOMAIN : null, body.email, body.fullName, hash]);
    const tenantId = rows[0]!.id;
    let hasVanity = false;
    if (vanity) {
      const r = await attachWorkerDomain(c.env, vanityHost(c.env, body.slug));
      hasVanity = r.ok;
      if (!r.ok) {
        await c.var.db.tx({ tenantId }, (tx) => tx.query(`select app.set_domain_status($1, 'failed', $2)`, [vanityHost(c.env, body.slug), JSON.stringify({ error: r.error })]));
      }
    }
    // a freshly issued certificate can take a minute; the shared app host works immediately
    return c.json({ tenant: { id: tenantId, slug: body.slug }, url: signInUrl(c.env, body.slug, false), vanityUrl: hasVanity ? signInUrl(c.env, body.slug, true) : null }, 201);
  })

  // ---------------------------------------------------------------------------------------------
  // Public web-to-lead forms (embeddable on any website → open CORS, no credentials)
  // ---------------------------------------------------------------------------------------------
  .use('/forms/*', cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], credentials: false }))
  .get('/forms/:key', async (c) => {
    const route = await resolveRoute(c, 'form', c.req.param('key'));
    const out = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, async (tx) => {
      const form = await tx.one<{ name: string; object_key: string; layout: { sections: { title?: string; fields: string[] }[] }; settings: Record<string, unknown> }>(
        `select name, object_key, layout, settings from forms where tenant_id = $1 and id = $2`,
        [route.tenant_id, route.target_id],
      );
      if (!form) throw notFound();
      const tenant = await tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select * from tenants where id = $1`, [route.tenant_id]);
      const meta = await loadMeta(c.env, tx, { id: tenant!.id, slug: tenant!.slug, name: tenant!.name, status: tenant!.status, metaVersion: tenant!.meta_version });
      const obj = meta.objects.find((o) => o.key === form.object_key);
      const keys = new Set(form.layout.sections.flatMap((s) => s.fields));
      return {
        name: form.name,
        sections: form.layout.sections,
        fields: (obj?.fields ?? []).filter((f) => keys.has(f.key)).map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, options: f.options })),
        consentText: form.settings.consentText ?? null,
      };
    });
    return c.json(out);
  })
  .post('/forms/:key', async (c) => {
    const route = await resolveRoute(c, 'form', c.req.param('key'));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (body._hp) return c.json({ ok: true }); // honeypot: pretend success for bots
    const result = await c.var.db.tx({ tenantId: route.tenant_id }, async (tx) => {
      const form = await tx.one<{ object_key: string; layout: { sections: { fields: string[] }[] }; settings: { ownerId?: string; successMessage?: string; requireTurnstile?: boolean; source?: string } }>(
        `select object_key, layout, settings from forms where tenant_id = $1 and id = $2 and is_active`,
        [route.tenant_id, route.target_id],
      );
      if (!form) throw notFound();
      if (form.settings.requireTurnstile && !(await verifyTurnstile(c.env.TURNSTILE_SECRET, String(body.turnstileToken ?? ''), c.req.header('cf-connecting-ip')))) {
        throw badRequest('Bot check failed');
      }
      const tenant = await tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select * from tenants where id = $1`, [route.tenant_id]);
      const meta = await loadMeta(c.env, tx, { id: tenant!.id, slug: tenant!.slug, name: tenant!.name, status: tenant!.status, metaVersion: tenant!.meta_version });
      // only fields placed on the form are accepted
      const allowed = new Set(form.layout.sections.flatMap((s) => s.fields));
      const input: Record<string, unknown> = {};
      for (const k of allowed) if (body[k] !== undefined) input[k] = body[k];
      if (form.object_key === 'lead' && !input.source) input.source = form.settings.source ?? 'website';
      const ownerId = form.settings.ownerId ?? (await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [route.tenant_id]))?.id ?? null;
      input.owner_id = ownerId;
      const principal = systemPrincipal(ownerId, meta.objects.map((o) => o.key));
      const { record, events } = await createRecord({ tx, meta, principal, tenantId: route.tenant_id }, form.object_key, input, { bypassPermissions: true });
      if (form.object_key === 'lead' && body.consent === true) {
        await tx.query(`update leads set consent = $3 where tenant_id = $1 and id = $2`, [route.tenant_id, record.id, JSON.stringify({ marketing: { granted: true, at: new Date().toISOString(), source: 'web_form', ip: c.req.header('cf-connecting-ip') ?? null } })]);
      }
      return { events, message: form.settings.successMessage ?? 'Thank you! We will be in touch shortly.' };
    });
    await enqueue(c.env, safeCtx(c), eventJobs(route.tenant_id, null, result.events));
    return c.json({ ok: true, message: result.message }, 201);
  })

  // ---------------------------------------------------------------------------------------------
  // Inbound channel webhooks (WhatsApp Cloud API, email relays, generic JSON)
  // ---------------------------------------------------------------------------------------------
  .get('/inbound/:key', async (c) => {
    // Meta webhook verification handshake
    const route = await resolveRoute(c, 'channel', c.req.param('key'));
    const acc = await loadChannel(c, route.tenant_id, route.target_id);
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const expected = await webhookVerifyToken(c.env, acc);
    if (mode === 'subscribe' && expected && token === expected) return c.text(c.req.query('hub.challenge') ?? '');
    throw new ApiError(403, 'forbidden', 'Verification failed');
  })
  .post('/inbound/:key', async (c) => {
    const route = await resolveRoute(c, 'channel', c.req.param('key'));
    const acc = await loadChannel(c, route.tenant_id, route.target_id);
    const raw = await c.req.text();
    if (raw.length > 512_000) throw badRequest('Payload too large');
    if (acc.channel === 'whatsapp' && !(await verifyMetaSignature(c.env, acc, raw, c.req.header('x-hub-signature-256') ?? null))) {
      throw new ApiError(401, 'bad_signature', 'Invalid signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw badRequest('Expected JSON');
    }
    await enqueue(c.env, safeCtx(c), [{ type: 'message.inbound', tenantId: route.tenant_id, channelAccountId: acc.id, payload }]);
    return c.json({ ok: true });
  });

async function resolveRoute(c: { var: AppEnv['Variables'] }, kind: 'form' | 'channel', key: string) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw notFound();
  const rows = await c.var.db.platform<{ tenant_id: string; target_id: string; tenant_status: string }>(`select * from app.resolve_public_route($1, $2)`, [kind, key]);
  const r = rows[0];
  if (!r || r.tenant_status !== 'active') throw notFound();
  return r;
}

async function loadChannel(c: { var: AppEnv['Variables'] }, tenantId: string, id: string) {
  const acc = await c.var.db.tx({ tenantId, readOnly: true }, (tx) => tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2 and status = 'active'`, [tenantId, id]));
  if (!acc) throw notFound();
  return acc;
}

export function safeCtx(c: { executionCtx: { waitUntil(p: Promise<unknown>): void } }): { waitUntil(p: Promise<unknown>): void } | null {
  try {
    return c.executionCtx;
  } catch {
    return null;
  }
}

