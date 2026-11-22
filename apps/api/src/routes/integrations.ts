/**
 * Integrations API.
 *   integrationRoutes        → /api/v1     mailbox connect/sync, click-to-call, payment links, my phone
 *   integrationAdminRoutes   → /api/admin  Razorpay, Exotel, Facebook pages, Google Ads lead forms
 *   integrationPublicRoutes  → /api/public OAuth callbacks and provider webhooks
 */
import { hasAdmin } from '@synapse/shared';
import { connectMeetingAccount, importRecent, markMeetingsPresent, myMeetingAccounts, removeMeetingAccount, updateMeetingAccount } from '../services/meetings';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { hmacSha256Hex, randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import {
  activeOf,
  authorizeUrl,
  exchangeCode,
  getIntegration,
  type Integration,
  mailboxesOf,
  mailboxOf,
  markPreferred,
  type OAuthProvider,
  oauthConfigured,
  providerFetch,
  publicView,
  readSecret,
  redirectUri,
  revokeTokens,
  sealSecret,
  signState,
  verifyState,
} from '../services/integrations';
import { enqueue } from '../services/jobs';
import { connectMetaPages } from '../services/leadads';
import { markMailboxesPresent, syncMailbox } from '../services/mail';
import { cancelPaymentLink, createPaymentLink, listPaymentLinks, verifyRazorpayKeys, verifyRazorpayWebhook } from '../services/payments-online';
import type { RecordCtx } from '../services/records';
import { applyExotelStatus, clickToCall, verifyExotel } from '../services/telephony';
import { invalidatePrincipal, resolveTenant } from '../services/tenancy';
import { resolveRoute, safeCtx } from './public';
import { actAs } from '../services/system';

const uuid = z.string().uuid();
const OAUTH_COOKIE = '__Host-synapse_oauth';

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const origin = (c: { req: { url: string } }) => new URL(c.req.url).origin;
const hookBase = (c: { req: { url: string }; env: AppEnv['Bindings'] }) => (c.env.APP_HOST ? `https://${c.env.APP_HOST}` : origin(c));

/** Webhook addresses an admin pastes into the provider's dashboard. */
function hookUrls(c: { req: { url: string }; env: AppEnv['Bindings'] }, i: Integration) {
  const b = `${hookBase(c)}/api/public/hooks`;
  if (i.provider === 'razorpay') return { webhook: `${b}/razorpay/${i.route_key}` };
  if (i.provider === 'exotel') return { incoming: `${b}/exotel/${i.route_key}/incoming`, status: `${b}/exotel/${i.route_key}/status` };
  if (i.provider === 'google_leads') return { webhook: `${b}/google-leads/${i.route_key}` };
  if (i.provider === 'meta_leads') return { webhook: `${b}/meta-leads` };
  return {};
}

async function myMailbox(tx: RecordCtx['tx'], tenantId: string, userId: string, id: string) {
  const mb = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and user_id = $3 and provider in ('google','microsoft')`, [tenantId, id, userId]);
  if (!mb) throw notFound('Mailbox not found');
  return mb;
}

export const integrationRoutes = new Hono<AppEnv>()
  /** What this person can use: their mailbox, and whether calling / online payments are available. */
  .get('/integrations/status', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const boxes = await mailboxesOf(tx, c.var.tenant.id, c.var.principal.user.id);
      const mb = boxes[0] ?? null;
      const exotel = await activeOf(tx, c.var.tenant.id, 'exotel');
      const rzp = await activeOf(tx, c.var.tenant.id, 'razorpay');
      const me = await tx.one<{ phone: string | null }>(`select phone from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, c.var.principal.user.id]);
      return {
        mailbox: mb ? { ...publicView(mb), primary: true } : null,
        mailboxes: boxes.map((b, i) => ({ ...publicView(b), primary: i === 0 })),
        available: { google: oauthConfigured(c.env, 'google'), microsoft: oauthConfigured(c.env, 'microsoft'), meta: oauthConfigured(c.env, 'meta'), zoom: oauthConfigured(c.env, 'zoom'), gmeet: oauthConfigured(c.env, 'gmeet'), msmeet: oauthConfigured(c.env, 'msmeet') },
        telephony: !!exotel,
        payments: !!rzp,
        myPhone: me?.phone ?? null,
      };
    });
    return c.json(out);
  })
  .post('/integrations/oauth/:provider/start', async (c) => {
    const provider = z.enum(['google', 'microsoft', 'meta', 'zoom', 'gmeet', 'msmeet']).parse(c.req.param('provider'));
    if (provider === 'meta' && !hasAdmin(c.var.principal.permissions, 'channels')) throw forbidden('Connecting Facebook pages needs the Channels admin permission');
    const { returnTo } = z.object({ returnTo: z.enum(['/account', '/settings', '/calls']).default('/account') }).parse(await c.req.json().catch(() => ({})));
    // the callback only completes in the browser that started the flow: a link forwarded to someone
    // else cannot attach their mailbox (or pages) to this account
    const binding = randomToken(24);
    c.header('set-cookie', `${OAUTH_COOKIE}=${binding}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const state = await signState(c.env, { t: c.var.tenant.id, u: c.var.principal.user.id, p: provider, o: origin(c), r: returnTo, h: await sha256Hex(binding) });
    return c.json({ url: authorizeUrl(c.env, provider, redirectUri(c.env, c.req.url, provider), state) });
  })
  .patch('/integrations/mailbox', async (c) => {
    const b = z.object({ calendar: z.boolean().optional(), invites: z.boolean().optional(), ignore: z.array(z.string().trim().toLowerCase().max(200)).max(200).optional() }).parse(await c.req.json());
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const mb = await mailboxOf(tx, c.var.tenant.id, c.var.principal.user.id, true);
      if (!mb) throw notFound('No mailbox connected');
      const r = await tx.one<Integration>(`update integrations set config = config || $3::jsonb where tenant_id = $1 and id = $2 returning *`, [c.var.tenant.id, mb.id, JSON.stringify(b)]);
      return publicView(r!);
    });
    return c.json(out);
  })
  .post('/integrations/mailbox/sync', async (c) => {
    const mb = await c.var.db.tx(scope(c, true), (tx) => mailboxOf(tx, c.var.tenant.id, c.var.principal.user.id, true));
    if (!mb) throw notFound('No mailbox connected');
    const r = await syncMailbox(c.env, c.var.db, c.var.tenant.id, mb.id);
    return c.json(r);
  })
  .delete('/integrations/mailbox', async (c) => {
    await c.var.db.tx(scope(c), async (tx) => {
      const rows = await tx.query<Integration>(`delete from integrations where tenant_id = $1 and user_id = $2 and provider in ('google','microsoft') returning *`, [c.var.tenant.id, c.var.principal.user.id]);
      for (const r of rows) await revokeTokens(c.env, r);
    });
    return c.body(null, 204);
  })
  /* ───── one of my mailboxes (several Gmail / Outlook accounts per person) ───── */
  .patch('/integrations/mailboxes/:id', async (c) => {
    const b = z
      .object({ calendar: z.boolean().optional(), invites: z.boolean().optional(), ignore: z.array(z.string().trim().toLowerCase().max(200)).max(200).optional(), primary: z.literal(true).optional() })
      .parse(await c.req.json());
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const mb = await myMailbox(tx, c.var.tenant.id, c.var.principal.user.id, uuid.parse(c.req.param('id')));
      const { primary, ...cfg } = b;
      if (primary) await markPreferred(tx, c.var.tenant.id, mb);
      const r = await tx.one<Integration>(`update integrations set config = config || $3::jsonb where tenant_id = $1 and id = $2 returning *`, [c.var.tenant.id, mb.id, JSON.stringify(cfg)]);
      return publicView(r!);
    });
    return c.json(out);
  })
  .post('/integrations/mailboxes/:id/sync', async (c) => {
    const mb = await c.var.db.tx(scope(c, true), (tx) => myMailbox(tx, c.var.tenant.id, c.var.principal.user.id, uuid.parse(c.req.param('id'))));
    if (mb.status === 'disabled') throw badRequest('This mailbox is switched off');
    return c.json(await syncMailbox(c.env, c.var.db, c.var.tenant.id, mb.id));
  })
  .delete('/integrations/mailboxes/:id', async (c) => {
    await c.var.db.tx(scope(c), async (tx) => {
      const mb = await myMailbox(tx, c.var.tenant.id, c.var.principal.user.id, uuid.parse(c.req.param('id')));
      await tx.query(`delete from integrations where tenant_id = $1 and id = $2`, [c.var.tenant.id, mb.id]);
      await revokeTokens(c.env, mb);
      // the next one becomes primary
      if (mb.config?.primary) {
        const next = (await mailboxesOf(tx, c.var.tenant.id, c.var.principal.user.id))[0];
        if (next) await markPreferred(tx, c.var.tenant.id, next);
      }
    });
    return c.body(null, 204);
  })
  /* ───── my meeting apps (Zoom / Google Meet / Teams, several accounts each) ───── */
  .get('/meeting-accounts', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => myMeetingAccounts(rctx(c, tx), c.env))))
  .patch('/meeting-accounts/:id', async (c) => {
    const b = z.object({ autoFetch: z.boolean().optional(), autoAnalyse: z.boolean().optional(), importAll: z.boolean().optional(), createTasks: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => updateMeetingAccount(rctx(c, tx), uuid.parse(c.req.param('id')), b)));
  })
  .delete('/meeting-accounts/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => removeMeetingAccount(rctx(c, tx), c.env, uuid.parse(c.req.param('id'))))))
  .post('/meeting-accounts/:id/import', async (c) => {
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and user_id = $3 and provider in ('zoom_meet','google_meet','ms_teams_meet')`, [
        c.var.tenant.id, uuid.parse(c.req.param('id')), c.var.principal.user.id,
      ]);
      if (!i) throw notFound('Meeting account not found');
      try {
        const r = await importRecent(c.env, tx, i, 7);
        await tx.query(`update integrations set last_sync_at = now(), status = 'active', last_error = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, i.id]);
        return r;
      } catch (e) {
        throw badRequest(`Could not read meetings: ${(e as Error).message}`);
      }
    });
    await markMeetingsPresent(c.env);
    return c.json(out);
  })
  .put('/me/phone', async (c) => {
    const { phone } = z.object({ phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,20}$/, 'Use digits, e.g. +91 98100 00000').nullable() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`update users set phone = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, c.var.principal.user.id, phone]));
    await invalidatePrincipal(c.env, c.var.tenant, c.var.principal.user.id);
    return c.json({ phone });
  })

  // ---------------------------------------------------------------- telephony
  .post('/telephony/call', async (c) => {
    const b = z.object({ object: z.string().max(60), id: uuid }).parse(await c.req.json());
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const i = await activeOf(tx, c.var.tenant.id, 'exotel');
      if (!i) throw badRequest('Calling is not set up — an admin can connect Exotel in Settings → Integrations');
      return clickToCall(c.env, rctx(c, tx), i, b, `${hookBase(c)}/api/public/hooks/exotel/${i.route_key}`);
    });
    return c.json(out, 201);
  })

  // ---------------------------------------------------------------- payment links
  .get('/payment-links', async (c) => {
    const q = z.object({ invoiceId: uuid.optional(), salesOrderId: uuid.optional() }).parse(c.req.query());
    if (!q.invoiceId && !q.salesOrderId) throw badRequest('invoiceId or salesOrderId is required');
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => listPaymentLinks(rctx(c, tx), q)) });
  })
  .post('/payment-links', async (c) => {
    const b = z
      .object({
        invoiceId: uuid.nullish(),
        salesOrderId: uuid.nullish(),
        milestoneId: uuid.nullish(),
        amount: z.number().positive().max(1e10).nullish(),
        notifySms: z.boolean().default(true),
        notifyEmail: z.boolean().default(true),
        expireInDays: z.number().int().min(1).max(180).nullish(),
      })
      .parse(await c.req.json());
    const out = await c.var.db.tx(scope(c), (tx) => createPaymentLink(c.env, rctx(c, tx), b, hookBase(c)));
    return c.json(out, 201);
  })
  .post('/payment-links/:id/cancel', async (c) => {
    await c.var.db.tx(scope(c), (tx) => cancelPaymentLink(c.env, rctx(c, tx), uuid.parse(c.req.param('id'))));
    return c.json({ ok: true });
  });

async function audit(c: { var: AppEnv['Variables'] }, i: Integration, action: string) {
  await c.var.db.tx(scope(c as never), (tx) =>
    tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1,$2,'integration',$3,$4)`, [c.var.tenant.id, `integration_${action}`, i.id, JSON.stringify({ provider: i.provider, account: i.account_ref })]),
  );
}

// ====================================================================== admin
const razorpaySchema = z.object({
  keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,40}$/, 'A Razorpay Key ID looks like rzp_live_…'),
  keySecret: z.string().trim().min(8).max(200),
  webhookSecret: z.string().trim().min(8).max(200),
});
const exotelSchema = z.object({
  sid: z.string().trim().regex(/^[A-Za-z0-9_-]{2,80}$/),
  apiKey: z.string().trim().min(4).max(200),
  apiToken: z.string().trim().min(4).max(200),
  subdomain: z.enum(['api.exotel.com', 'api.in.exotel.com']).default('api.exotel.com'),
  callerId: z.string().trim().regex(/^\+?[0-9]{6,15}$/, 'The ExoPhone number, digits only'),
  record: z.boolean().default(true),
  createLeads: z.boolean().default(true),
  ownerId: uuid.nullish(),
});

export const integrationAdminRoutes = new Hono<AppEnv>()
  .use('/integrations/*', requireAdmin('channels'))
  .use('/integrations', requireAdmin('channels'))
  .get('/integrations', async (c) => {
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query<Integration & { user_name: string | null }>(
        `select i.*, u.full_name as user_name from integrations i left join users u on u.tenant_id = i.tenant_id and u.id = i.user_id where i.tenant_id = $1 order by i.provider, i.created_at`,
        [c.var.tenant.id],
      ),
    );
    return c.json({
      items: rows.map((r) => ({ ...publicView(r), userName: r.user_name, urls: hookUrls(c, r) })),
      available: { google: oauthConfigured(c.env, 'google'), microsoft: oauthConfigured(c.env, 'microsoft'), meta: oauthConfigured(c.env, 'meta'), zoom: oauthConfigured(c.env, 'zoom'), gmeet: oauthConfigured(c.env, 'gmeet'), msmeet: oauthConfigured(c.env, 'msmeet') },
    });
  })
  .post('/integrations/razorpay', async (c) => {
    const b = razorpaySchema.parse(await c.req.json());
    await verifyRazorpayKeys(b.keyId, b.keySecret);
    const secret = await sealSecret(c.env, c.var.tenant.id, { keySecret: b.keySecret, webhookSecret: b.webhookSecret });
    const row = await c.var.db.tx(scope(c), async (tx) => {
      // several Razorpay accounts may be kept: the first (or the one marked default) takes new payment links
      const first = !(await activeOf(tx, c.var.tenant.id, 'razorpay'));
      const row = await tx.one<Integration>(
        `insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config) values ($1,'razorpay',$2,$3,$4,$5)
         on conflict (tenant_id, provider, account_ref) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'active', config = excluded.config, last_error = null, error_count = 0
         returning *`,
        [c.var.tenant.id, b.keyId.startsWith('rzp_test_') ? 'Razorpay (test mode)' : 'Razorpay', b.keyId, secret, JSON.stringify({ mode: b.keyId.startsWith('rzp_test_') ? 'test' : 'live' })],
      );
      if (first) await markPreferred(tx, c.var.tenant.id, row!);
      return row;
    });
    await audit(c, row!, 'credentials_saved');
    return c.json({ ...publicView(row!), urls: hookUrls(c, row!) }, 201);
  })
  .post('/integrations/exotel', async (c) => {
    const b = exotelSchema.parse(await c.req.json());
    await verifyExotel(b.sid, { apiKey: b.apiKey, apiToken: b.apiToken }, b.subdomain);
    const secret = await sealSecret(c.env, c.var.tenant.id, { apiKey: b.apiKey, apiToken: b.apiToken });
    const row = await c.var.db.tx(scope(c), async (tx) => {
      // several Exotel accounts may be kept: calls go out through the default one; each number's calls come in on its own URL
      const first = !(await activeOf(tx, c.var.tenant.id, 'exotel'));
      const row = await tx.one<Integration>(
        `insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config) values ($1,'exotel','Exotel',$2,$3,$4)
         on conflict (tenant_id, provider, account_ref) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'active', config = excluded.config, last_error = null, error_count = 0
         returning *`,
        [c.var.tenant.id, b.sid, secret, JSON.stringify({ subdomain: b.subdomain, callerId: b.callerId, record: b.record, createLeads: b.createLeads, ownerId: b.ownerId ?? null })],
      );
      if (first) await markPreferred(tx, c.var.tenant.id, row!);
      return row;
    });
    await audit(c, row!, 'credentials_saved');
    return c.json({ ...publicView(row!), urls: hookUrls(c, row!) }, 201);
  })
  .post('/integrations/google-leads', async (c) => {
    const b = z.object({ label: z.string().trim().min(1).max(120).default('Google Ads lead forms'), ownerId: uuid.nullish() }).parse(await c.req.json().catch(() => ({})));
    const key = randomToken(24);
    const row = await c.var.db.tx(scope(c), async (tx) =>
      tx.one<Integration>(
        `insert into integrations (tenant_id, provider, label, account_ref, secret_ciphertext, config) values ($1,'google_leads',$2,$3,$4,$5) returning *`,
        [c.var.tenant.id, b.label, `gads-${randomToken(6)}`, await sealSecret(c.env, c.var.tenant.id, { key }), JSON.stringify({ ownerId: b.ownerId ?? null })],
      ),
    );
    return c.json({ ...publicView(row!), urls: hookUrls(c, row!), key }, 201);
  })
  /** The webhook key for a Google Ads endpoint (admins paste it into the lead form). */
  .get('/integrations/:id/key', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const i = await getIntegration(tx, c.var.tenant.id, uuid.parse(c.req.param('id')));
      if (i.provider !== 'google_leads') throw notFound();
      return { key: (await readSecret<{ key: string }>(c.env, i)).key, urls: hookUrls(c, i) };
    });
    return c.json(out);
  })
  .patch('/integrations/:id', async (c) => {
    const b = z
      .object({
        label: z.string().trim().min(1).max(200).optional(),
        ownerId: uuid.nullish(),
        callerId: z.string().trim().regex(/^\+?[0-9]{6,15}$/).optional(),
        record: z.boolean().optional(),
        createLeads: z.boolean().optional(),
        allowInternational: z.boolean().optional(),
        maxCallsPerHour: z.number().int().min(1).max(500).optional(),
        enabled: z.boolean().optional(),
        makeDefault: z.literal(true).optional(),
      })
      .parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      const i = await getIntegration(tx, c.var.tenant.id, uuid.parse(c.req.param('id')));
      if (i.user_id) throw forbidden('Mailboxes are managed by their owner in My account');
      const { label, enabled, makeDefault, ...cfg } = b;
      if (makeDefault) await markPreferred(tx, c.var.tenant.id, i);
      if (cfg.ownerId) {
        const u = await tx.one(`select 1 from users where tenant_id = $1 and id = $2 and status = 'active'`, [c.var.tenant.id, cfg.ownerId]);
        if (!u) throw badRequest('Choose an active person as the default owner');
      }
      return tx.one<Integration>(
        `update integrations set label = coalesce($3, label), config = config || $4::jsonb, status = case when $5::boolean is null then status when $5 then 'active' else 'disabled' end
          where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, i.id, label ?? null, JSON.stringify(cfg), enabled ?? null],
      );
    });
    return c.json({ ...publicView(row!), urls: hookUrls(c, row!) });
  })
  .delete('/integrations/:id', async (c) => {
    await c.var.db.tx(scope(c), async (tx) => {
      const i = await getIntegration(tx, c.var.tenant.id, uuid.parse(c.req.param('id')));
      await revokeTokens(c.env, i);
      const used = await tx.one(`select 1 from payment_links where tenant_id = $1 and integration_id = $2 limit 1`, [c.var.tenant.id, i.id]);
      // payment history keeps its link to the account; the connection is switched off instead
      if (used) await tx.query(`update integrations set status = 'disabled', secret_ciphertext = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, i.id]);
      else await tx.query(`delete from integrations where tenant_id = $1 and id = $2`, [c.var.tenant.id, i.id]);
    });
    return c.body(null, 204);
  });

// ====================================================================== public: OAuth + webhooks
const MAX_HOOK = 256 * 1024;

/** Reads a webhook body with a hard byte cap (also for chunked requests without content-length). */
async function rawBody(c: { req: { raw: Request; header(n: string): string | undefined } }) {
  const len = Number(c.req.header('content-length') ?? 0);
  if (len > MAX_HOOK) throw new ApiError(413, 'too_large', 'Payload too large');
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HOOK) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(413, 'too_large', 'Payload too large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const ch of chunks) {
    all.set(ch, o);
    o += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const integrationPublicRoutes = new Hono<AppEnv>()
  .get('/oauth/:provider/callback', async (c) => {
    const provider = z.enum(['google', 'microsoft', 'meta', 'zoom', 'gmeet', 'msmeet']).parse(c.req.param('provider')) as OAuthProvider;
    const s = await verifyState(c.env, c.req.query('state'));
    if (s.p !== provider) throw badRequest('Mismatched sign-in');
    const binding = /(?:^|;\s*)__Host-synapse_oauth=([A-Za-z0-9_-]+)/.exec(c.req.header('cookie') ?? '')?.[1];
    if (!binding || !timingSafeEqual(await sha256Hex(binding), s.h)) throw badRequest('Finish connecting in the same browser where you started. Start again from SanchalanOS.');
    c.header('set-cookie', `${OAUTH_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    // each sign-in link works once
    if (c.env.CACHE_KV) {
      const k = `oauth:used:${s.n}`;
      if (await c.env.CACHE_KV.get(k).catch(() => null)) throw badRequest('This sign-in link was already used. Start again from SanchalanOS.');
      await c.env.CACHE_KV.put(k, '1', { expirationTtl: 900 }).catch(() => undefined);
    }
    // the browser is sent back only to this app or one of this workspace's own addresses
    const back = new URL(s.o);
    const sameHost = back.host === new URL(c.req.url).host || back.host === c.env.APP_HOST;
    const tenantHost = sameHost ? null : await resolveTenant(c.env, c.var.db, back.host, null);
    if (!sameHost && tenantHost?.id !== s.t) throw badRequest('Unexpected return address');
    const done = (q: Record<string, string>) => c.redirect(`${back.origin}${s.r}?${new URLSearchParams(q)}`, 302);
    const err = c.req.query('error');
    if (err) return done({ integration: provider, error: c.req.query('error_description') ?? err });
    const code = c.req.query('code');
    if (!code) return done({ integration: provider, error: 'No authorisation code' });
    try {
      const tokens = await exchangeCode(c.env, provider, code, redirectUri(c.env, c.req.url, provider));
      let msAliases: string[] = [];
      const result = await c.var.db.tx({ tenantId: s.t, userId: s.u }, async (tx) => {
        const who = await actAs(c.env, tx, s.t, s.u, 'oauth');
        if (!who) throw forbidden();
        if (provider === 'zoom' || provider === 'gmeet' || provider === 'msmeet') return connectMeetingAccount(c.env, tx, s.t, s.u, provider, tokens);
        if (provider === 'meta') {
          // re-checked now, not only when the flow started
          if (!hasAdmin(who.principal.permissions, 'channels')) throw forbidden('Connecting Facebook pages needs the Channels admin permission');
          return connectMetaPages(c.env, tx, s.t, tokens.accessToken, s.u);
        }
        const address =
          provider === 'google'
            ? (await providerFetch<{ emailAddress: string }>('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${tokens.accessToken}` } })).emailAddress
            : await providerFetch<{ mail?: string; userPrincipalName?: string }>('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', { headers: { authorization: `Bearer ${tokens.accessToken}` } }).then((m) => {
                // the sign-in name (UPN) is tied to a verified domain of the account's directory; `mail`
                // is settable by that directory's admins, so it only counts as an extra own address
                msAliases = m.mail && m.mail.toLowerCase() !== (m.userPrincipalName ?? '').toLowerCase() ? [m.mail.toLowerCase()] : [];
                return /^[^@\s]+@[^@\s]+$/.test(m.userPrincipalName ?? '') ? m.userPrincipalName! : m.mail || '';
              });
        if (!address) throw badRequest('The mailbox address could not be read');
        const taken = await tx.one<{ user_id: string | null }>(`select user_id from integrations where tenant_id = $1 and provider = $2 and account_ref = $3`, [s.t, provider, address.toLowerCase()]);
        if (taken && taken.user_id !== s.u) throw badRequest(`${address} is already connected by a colleague`);
        // several mailboxes per person: the same address reconnects (keeping its settings), a new one is added;
        // the first one is the primary (calendar, invites, default "From")
        const first = !(await mailboxOf(tx, s.t, s.u, true));
        await tx.query(
          `insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config, created_by) values ($1,$2,$3,$4,$5,$6,$7,$3)
           on conflict (tenant_id, provider, account_ref) do update set secret_ciphertext = excluded.secret_ciphertext, status = 'active', last_error = null, error_count = 0,
             config = integrations.config || jsonb_build_object('addresses', excluded.config -> 'addresses')`,
          [s.t, provider, s.u, provider === 'google' ? 'Gmail' : 'Outlook', address.toLowerCase(), await sealSecret(c.env, s.t, tokens as unknown as Record<string, unknown>), JSON.stringify({ calendar: true, ignore: [], addresses: msAliases, ...(first ? { primary: true } : {}) })],
        );
        return { connected: [address], failed: [] as string[] };
      });
      if (provider === 'google' || provider === 'microsoft') await markMailboxesPresent(c.env);
      if (provider === 'zoom' || provider === 'gmeet' || provider === 'msmeet') await markMeetingsPresent(c.env);
      return done({ integration: provider, connected: result.connected.join(', '), ...(result.failed.length ? { failed: result.failed.join('; ') } : {}) });
    } catch (e) {
      return done({ integration: provider, error: (e as Error).message.slice(0, 200) });
    }
  })

  // ---------------------------------------------------------------- Meta lead ads (one URL for all workspaces)
  .get('/hooks/meta-leads', (c) => {
    if (c.req.query('hub.mode') === 'subscribe' && c.env.META_VERIFY_TOKEN && timingSafeEqual(c.req.query('hub.verify_token') ?? '', c.env.META_VERIFY_TOKEN)) {
      return c.text(c.req.query('hub.challenge') ?? '');
    }
    throw new ApiError(403, 'forbidden', 'Verification failed');
  })
  .post('/hooks/meta-leads', async (c) => {
    const raw = await rawBody(c);
    const sig = c.req.header('x-hub-signature-256') ?? '';
    if (!c.env.META_APP_SECRET || !sig.startsWith('sha256=') || !timingSafeEqual(sig.slice(7), await hmacSha256Hex(c.env.META_APP_SECRET, raw))) {
      throw new ApiError(401, 'bad_signature', 'Invalid signature');
    }
    const body = JSON.parse(raw) as { object?: string; entry?: { id: string; changes?: { field: string; value: { leadgen_id?: string; page_id?: string } }[] }[] };
    for (const e of body.entry ?? []) {
      for (const ch of e.changes ?? []) {
        if (ch.field !== 'leadgen' || !ch.value?.leadgen_id) continue;
        const pageId = String(ch.value.page_id ?? e.id);
        if (!/^\d{5,30}$/.test(pageId)) continue;
        const route = await resolveRoute(c, 'meta_page', `fbpage-${pageId}`).catch(() => null);
        if (!route) continue;
        await enqueue(c.env, safeCtx(c), [{ type: 'leadads.meta', tenantId: route.tenant_id, integrationId: route.target_id, leadgenId: String(ch.value.leadgen_id) }]);
      }
    }
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- Google Ads lead forms
  .post('/hooks/google-leads/:key', async (c) => {
    const route = await resolveRoute(c, 'integration', c.req.param('key'));
    const raw = await rawBody(c);
    let body: Record<string, any>;
    try {
      body = JSON.parse(raw);
    } catch {
      throw badRequest('Expected JSON');
    }
    const i = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'google_leads' and status = 'active'`, [route.tenant_id, route.target_id]));
    if (!i) throw notFound();
    const { key } = await readSecret<{ key: string }>(c.env, i);
    if (!key || !timingSafeEqual(String(body.google_key ?? ''), key)) throw new ApiError(401, 'bad_key', 'Invalid google_key');
    if (!body.lead_id) throw badRequest('lead_id is required');
    await enqueue(c.env, safeCtx(c), [{ type: 'leadads.google', tenantId: route.tenant_id, integrationId: i.id, body }]);
    return c.json({});
  })

  // ---------------------------------------------------------------- Razorpay
  .post('/hooks/razorpay/:key', async (c) => {
    const route = await resolveRoute(c, 'integration', c.req.param('key'));
    const raw = await rawBody(c);
    const i = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'razorpay'`, [route.tenant_id, route.target_id]));
    if (!i || !(await verifyRazorpayWebhook(c.env, i, raw, c.req.header('x-razorpay-signature') ?? null))) throw new ApiError(401, 'bad_signature', 'Invalid signature');
    await enqueue(c.env, safeCtx(c), [{ type: 'payment.razorpay', tenantId: route.tenant_id, integrationId: i.id, event: JSON.parse(raw) }]);
    return c.json({ ok: true });
  })

  // ---------------------------------------------------------------- Exotel
  .on(['GET', 'POST'], '/hooks/exotel/:key/:kind', async (c) => {
    const kind = z.enum(['status', 'incoming']).parse(c.req.param('kind'));
    const route = await resolveRoute(c, 'integration', c.req.param('key'));
    const params: Record<string, any> = { ...c.req.query() };
    if (c.req.method === 'POST') {
      const raw = await rawBody(c);
      const type = c.req.header('content-type') ?? '';
      try {
        Object.assign(params, type.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)));
      } catch {
        throw badRequest('Unreadable callback');
      }
    }
    for (const k of Object.keys(params)) if (typeof params[k] === 'string') params[k] = params[k].slice(0, 1000);
    if (kind === 'status') {
      await c.var.db.tx({ tenantId: route.tenant_id }, async (tx) => {
        const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'exotel'`, [route.tenant_id, route.target_id]);
        if (i) await applyExotelStatus(tx, i, params);
      });
    } else {
      const strings = Object.fromEntries(Object.entries(params).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)]));
      await enqueue(c.env, safeCtx(c), [{ type: 'telephony.incoming', tenantId: route.tenant_id, integrationId: route.target_id, params: strings }]);
    }
    return c.text('ok');
  });
