import type { Context, MiddlewareHandler } from 'hono';
import type { AdminArea } from '@synapse/shared';
import { takeToken } from './lib/ratelimit';
import { areaOfPath, canUseArea, hasAdmin, type SecurityPolicy, WORK_AREAS } from '@synapse/shared';
import { assertNetworkAllowed } from './lib/ip';
import type { AppEnv } from './env';
import { Db } from './lib/db';
import { ApiError, forbidden, unauthorized } from './lib/errors';
import { sha256Hex } from './lib/crypto';
import { verifyAccessToken } from './lib/jwt';
import { dispatchPush, pushEnabled } from './services/webpush';
import { withTenantKeys } from './services/connection-keys';
import { invalidateTenantCache, loadMeta, loadPrincipal, resolveTenant } from './services/tenancy';
import { flushMeter, meter, meterTenant, metered, takeCounts } from './lib/meter';

/** Request id + per-request DB handle (closed after the response is produced). */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rid = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', rid);
  // Db connects lazily on first query, so requests that never touch Postgres cost nothing.
  const db = Db.fromEnv(c.env);
  c.set('db', db);
  // the request's calls to outside services and database queries, counted for Usage & costs
  let counts: ReturnType<typeof takeCounts> = [];
  try {
    await metered(null, async () => {
      try {
        await next();
      } finally {
        meterTenant(c.var.tenant?.id ?? null);
        meter('workers', 'request', { errors: c.res.status >= 500 ? 1 : 0 });
        counts = takeCounts();
      }
    });
  } finally {
    // writes may have produced notifications: push them to the users' devices on the same connection
    const tenant = c.var.tenant;
    const pushAfter = tenant && pushEnabled(c.env) && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.res.status < 400;
    const closing = flushMeter(db, counts)
      .catch(() => undefined)
      .then(() => (pushAfter ? dispatchPush(c.env, db, tenant.id).catch(() => 0) : 0))
      .then(() => db.close());
    try {
      c.executionCtx.waitUntil(closing);
    } catch {
      await closing; // no ExecutionContext (tests / node)
    }
  }
  c.header('x-request-id', rid);
};

/** Hostname / header → tenant. Rejects unknown or suspended tenants before any tenant query. */
export const tenantResolver: MiddlewareHandler<AppEnv> = async (c, next) => {
  const host = c.req.header('x-forwarded-host') && c.env.APP_ENV !== 'production' ? c.req.header('x-forwarded-host')! : new URL(c.req.url).host;
  // integrations may omit X-Tenant: API keys carry the workspace slug (syn_<slug>_<secret>)
  const key = apiKeyFrom(c);
  const tenant = await resolveTenant(c.env, c.var.db, host, c.req.header('x-tenant') ?? (key ? key.split('_')[1]! : null));
  if (!tenant) {
    // coding agents (Claude Code, Codex) on the shared host: the workspace comes from the key, so
    // a missing or mistyped key is an authentication problem, not a missing endpoint
    if (/^\/api\/v1\/(mcp|agent)(\/|$)/.test(new URL(c.req.url).pathname)) {
      c.header('www-authenticate', 'Bearer realm="SanchalanOS"');
      throw new ApiError(
        401,
        'api_key_required',
        key || c.req.header('authorization')
          ? 'This API key does not belong to a SanchalanOS workspace. Create one in SanchalanOS under Settings → API keys (it starts with syn_<your-workspace>_).'
          : 'Send your SanchalanOS API key: claude mcp add --transport http sanchalan https://www.sanchalan.hrpai.in/api/v1/mcp --header "Authorization: Bearer syn_<workspace>_<secret>"',
      );
    }
    throw new ApiError(404, 'tenant_not_found', 'Unknown workspace');
  }
  if (tenant.status !== 'active') throw new ApiError(403, 'tenant_inactive', 'This workspace is not active');
  c.set('tenant', tenant);
  // a workspace's own keys (its own GSP account) for this request only
  c.env = await withTenantKeys(c.env, c.var.db, tenant.id);
  // sign-in, token refresh and two-factor steps honour the workspace network policy too
  if (c.req.method === 'POST' && new URL(c.req.url).pathname.startsWith('/api/auth/') && !new URL(c.req.url).pathname.endsWith('/logout')) {
    const row = await c.var.db.tx({ tenantId: tenant.id, readOnly: true }, (tx) => tx.one<{ security: SecurityPolicy | null }>(`select settings -> 'security' as security from tenants where id = $1`, [tenant.id]));
    assertNetworkAllowed(c.env, row?.security ?? undefined, (n) => c.req.header(n));
  }
  await next();
};

function apiKeyFrom(c: { req: { header(n: string): string | undefined } }): string | null {
  const auth = c.req.header('authorization');
  const k = auth?.startsWith('Bearer syn_') ? auth.slice(7) : (c.req.header('x-api-key') ?? null);
  return k && /^syn_[a-z0-9-]{3,40}_[A-Za-z0-9_-]{30,80}$/.test(k) ? k : null;
}

/** API key → principal of the key's user, limited to /api/v1 and to the key's scopes. */
async function authenticateApiKey(c: Context<AppEnv>, key: string) {
  const tenant = c.var.tenant;
  const path = new URL(c.req.url).pathname;
  if (!path.startsWith('/api/v1/')) throw forbidden('API keys can only call /api/v1');
  const hash = await sha256Hex(key);
  const { meta, principal, row } = await c.var.db.tx({ tenantId: tenant.id, readOnly: true }, async (tx) => {
    const row = await tx.one<{ id: string; user_id: string; scopes: string[]; last_used_at: Date | null; rate_limit_per_min: number; project_id: string | null }>(
      `select id, user_id, scopes, last_used_at, rate_limit_per_min, project_id from api_keys where tenant_id = $1 and key_hash = $2 and revoked_at is null and (expires_at is null or expires_at > now())`,
      [tenant.id, hash],
    );
    if (!row) return { meta: null, principal: null, row: null };
    const meta = await loadMeta(c.env, tx, tenant);
    const principal = await loadPrincipal(c.env, tx, tenant, meta, row.user_id, `api-key:${row.id}`);
    return { meta, principal, row };
  });
  if (!row || !principal || !meta || principal.user.status !== 'active') throw unauthorized('Invalid or revoked API key');
  assertNetworkAllowed(c.env, meta.tenant.security, (n) => c.req.header(n));
  if (meta.tenant.security?.requireMfa && !principal.user.mfaEnabled) throw forbidden('The person this key acts as must turn on two-factor sign-in');
  // a key made for one project's repository works only for its coding agent, on that project
  if (row.project_id && !/^\/api\/v1\/mcp\/?$/.test(path)) throw forbidden('This API key is for the coding agent of one project only');
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
  if (write && !row.scopes.includes('write')) throw forbidden('This API key is read-only');
  // per-key rate limit (requests per minute), with the standard headers integrations read
  const rl = takeToken(row.id, row.rate_limit_per_min ?? 600);
  const shared = c.env.API_RATE_LIMITER ? await c.env.API_RATE_LIMITER.limit({ key: `${tenant.id}:${row.id}` }).catch(() => ({ success: true })) : { success: true };
  c.header('x-ratelimit-limit', String(rl.limit));
  c.header('x-ratelimit-remaining', String(rl.remaining));
  c.header('x-ratelimit-reset', String(rl.resetSeconds));
  if (!rl.ok || !shared.success) {
    c.header('retry-after', String(rl.resetSeconds || 60));
    throw new ApiError(429, 'rate_limited', `Too many requests: this API key allows ${rl.limit} a minute`);
  }
  // usage bookkeeping, at most once a minute per key
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    const work = c.var.db
      .tx({ tenantId: tenant.id }, (tx) => tx.query(`update api_keys set last_used_at = now(), last_used_ip = $3, use_count = use_count + 1 where tenant_id = $1 and id = $2`, [tenant.id, row.id, c.req.header('cf-connecting-ip') ?? null]))
      .catch(() => undefined);
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
  }
  c.set('meta', meta);
  c.set('principal', { ...principal, apiKey: { id: row.id, scopes: row.scopes, projectId: row.project_id } });
}

/** Bearer JWT (or API key) → principal. The token audience must equal the tenant resolved from the host. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = apiKeyFrom(c);
  if (key) {
    await authenticateApiKey(c, key);
    await next();
    return;
  }
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) throw unauthorized();
  const tenant = c.var.tenant;
  let claims;
  try {
    claims = await verifyAccessToken(c.env.JWT_SECRET, auth.slice(7), tenant.id);
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { meta, principal, live } = await c.var.db.tx({ tenantId: tenant.id, userId: claims.sub, readOnly: true }, async (tx) => {
    // the session family must still be alive: sign-out, "sign out everywhere", disabling a user,
    // password resets and refresh-token theft detection take effect immediately, not at token expiry
    const live = await tx.one(
      `select 1 from sessions s where s.tenant_id = $1 and s.revoked_at is null and s.expires_at > now()
          and s.family_id = (select family_id from sessions where tenant_id = $1 and id = $2::uuid)`,
      [tenant.id, claims.sid],
    );
    if (!live) return { meta: null, principal: null, live: false };
    const meta = await loadMeta(c.env, tx, tenant);
    const principal = await loadPrincipal(c.env, tx, tenant, meta, claims.sub, claims.sid);
    return { meta, principal, live: true };
  });
  if (!live || !meta) throw unauthorized('Session ended');
  assertNetworkAllowed(c.env, meta.tenant.security, (n) => c.req.header(n));
  if (!principal || principal.user.status !== 'active') throw unauthorized('Account is not active');
  // workspace policy: no data access until two-factor sign-in is set up
  if (meta.tenant.security?.requireMfa && !principal.user.mfaEnabled && !new URL(c.req.url).pathname.startsWith('/api/auth/')) {
    throw new ApiError(403, 'mfa_setup_required', 'Your workspace requires two-factor sign-in. Set it up to continue.');
  }
  c.set('meta', meta);
  c.set('principal', principal);
  await next();
};

/**
 * Work areas: a role only reaches the parts of the product it is given (Settings → Roles → Areas).
 * Runs after authenticate on /api/v1 and /api/ai; admin routes have their own checks.
 */
export const areaGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const apps = c.var.principal?.permissions.apps;
  if (apps && !apps.includes('*')) {
    const path = new URL(c.req.url).pathname.replace(/^\/api\/(v1|ai)/, '');
    const area = areaOfPath(path);
    if (area === null || !canUseArea(apps, area)) {
      const label = WORK_AREAS.find((a) => a.key === area)?.label;
      throw forbidden(label ? `Your role does not include ${label}. Ask an administrator to add it in Settings → Roles.` : 'Your role does not include this part of SanchalanOS');
    }
  }
  await next();
};

export const requireAdmin =
  (area: AdminArea): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!hasAdmin(c.var.principal.permissions, area)) throw forbidden(`Requires the "${area}" admin permission`);
    await next();
    // metadata may have changed: drop this colo's cached tenant resolution so meta_version refreshes
    if (c.req.method !== 'GET' && c.res.status < 400) {
      const work = invalidateTenantCache(c.env, c.var.tenant, new URL(c.req.url).host);
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        await work;
      }
    }
  };

/** Middleware for non-admin writes that change cached metadata (product categories, warehouses). */
export const metaWrite: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  if (c.req.method !== 'GET' && c.res.status < 400) {
    const work = invalidateTenantCache(c.env, c.var.tenant, new URL(c.req.url).host);
    try {
      c.executionCtx.waitUntil(work);
    } catch {
      await work;
    }
  }
};

/** Convenience: run a tenant-scoped transaction as the current user. */
export function scope(c: { var: { tenant: { id: string }; principal?: { user: { id: string } }; requestId: string } }, readOnly = false) {
  return { tenantId: c.var.tenant.id, userId: c.var.principal?.user.id ?? null, requestId: c.var.requestId, readOnly };
}
