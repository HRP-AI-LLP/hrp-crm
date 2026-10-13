import type { MiddlewareHandler } from 'hono';
import type { AdminArea } from '@synapse/shared';
import { hasAdmin } from '@synapse/shared';
import type { AppEnv } from './env';
import { Db } from './lib/db';
import { ApiError, forbidden, unauthorized } from './lib/errors';
import { verifyAccessToken } from './lib/jwt';
import { invalidateTenantCache, loadMeta, loadPrincipal, resolveTenant } from './services/tenancy';

/** Request id + per-request DB handle (closed after the response is produced). */
export const requestContext: MiddlewareHandler<AppEnv> = async (c, next) => {
  const rid = c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', rid);
  // Db connects lazily on first query, so requests that never touch Postgres cost nothing.
  const db = Db.fromEnv(c.env);
  c.set('db', db);
  try {
    await next();
  } finally {
    const closing = db.close();
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
  const tenant = await resolveTenant(c.env, c.var.db, host, c.req.header('x-tenant') ?? null);
  if (!tenant) throw new ApiError(404, 'tenant_not_found', 'Unknown workspace');
  if (tenant.status !== 'active') throw new ApiError(403, 'tenant_inactive', 'This workspace is not active');
  c.set('tenant', tenant);
  await next();
};

/** Bearer JWT → principal. The token audience must equal the tenant resolved from the host. */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = c.req.header('authorization');
  if (!auth?.startsWith('Bearer ')) throw unauthorized();
  const tenant = c.var.tenant;
  let claims;
  try {
    claims = await verifyAccessToken(c.env.JWT_SECRET, auth.slice(7), tenant.id);
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { meta, principal } = await c.var.db.tx({ tenantId: tenant.id, userId: claims.sub, readOnly: true }, async (tx) => {
    const meta = await loadMeta(c.env, tx, tenant);
    const principal = await loadPrincipal(c.env, tx, tenant, meta, claims.sub, claims.sid);
    return { meta, principal };
  });
  if (!principal || principal.user.status !== 'active') throw unauthorized('Account is not active');
  c.set('meta', meta);
  c.set('principal', principal);
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

/** Convenience: run a tenant-scoped transaction as the current user. */
export function scope(c: { var: { tenant: { id: string }; principal?: { user: { id: string } }; requestId: string } }, readOnly = false) {
  return { tenantId: c.var.tenant.id, userId: c.var.principal?.user.id ?? null, requestId: c.var.requestId, readOnly };
}
