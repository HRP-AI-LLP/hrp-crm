import { hashPassword, passwordPolicyError, verifyPassword } from '@synapse/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { randomToken, sha256Hex } from '../lib/crypto';
import { ApiError, badRequest, unauthorized } from '../lib/errors';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, signAccessToken } from '../lib/jwt';
import { authenticate, scope } from '../middleware';
import { invalidatePrincipal } from '../services/tenancy';

const REFRESH_COOKIE = '__Host-synapse_rt';
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const loginSchema = z.object({ email: z.string().trim().toLowerCase().min(3).max(254), password: z.string().min(1).max(200) });

function clientIp(c: { req: { header(n: string): string | undefined } }) {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

function setRefreshCookie(c: Parameters<typeof setCookie>[0], token: string) {
  setCookie(c, REFRESH_COOKIE, token, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict', maxAge: REFRESH_TTL_SECONDS });
}

/** CSRF guard for cookie-authenticated endpoints: browsers cannot add custom headers cross-site without CORS preflight. */
function requireCsrfHeader(c: { req: { header(n: string): string | undefined } }) {
  if (c.req.header('x-requested-with') !== 'synapse') throw new ApiError(403, 'csrf', 'Missing X-Requested-With header');
}

async function issueSession(c: Context<AppEnv>, tx: import('../lib/db').Tx, tenantId: string, userId: string, familyId: string | null) {
  const refresh = randomToken(32);
  const s = await tx.one<{ id: string }>(
    `insert into sessions (tenant_id, user_id, family_id, refresh_hash, expires_at, user_agent, ip)
     values ($1, $2, coalesce($3::uuid, app.uuidv7()), $4, now() + make_interval(secs => $5), $6, $7) returning id`,
    [tenantId, userId, familyId, await sha256Hex(refresh), REFRESH_TTL_SECONDS, c.req.header('user-agent')?.slice(0, 300) ?? null, clientIp(c)],
  );
  const accessToken = await signAccessToken(c.env.JWT_SECRET, { sub: userId, tid: tenantId, sid: s!.id });
  setRefreshCookie(c, refresh);
  return { sessionId: s!.id, accessToken };
}

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const tenant = c.var.tenant;
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const user = await tx.one<{ id: string; password_hash: string | null; status: string; locked_until: Date | null; failed_logins: number; full_name: string; email: string }>(
        `select id, password_hash, status, locked_until, failed_logins, full_name, email from users where tenant_id = $1 and lower(email) = $2`,
        [tenant.id, body.email],
      );
      if (user?.locked_until && new Date(user.locked_until) > new Date()) {
        return { error: new ApiError(429, 'locked', `Too many failed attempts. Try again after ${LOCK_MINUTES} minutes.`) };
      }
      const ok = await verifyPassword(body.password, user?.password_hash);
      if (!user || !ok || user.status !== 'active') {
        if (user) {
          await tx.query(
            `update users set failed_logins = failed_logins + 1,
                    locked_until = case when failed_logins + 1 >= $3 then now() + make_interval(mins => $4) else locked_until end
              where tenant_id = $1 and id = $2`,
            [tenant.id, user.id, MAX_FAILED, LOCK_MINUTES],
          );
          await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip, user_agent) values ($1,$2,'login_failed','user',$2,$3,$4)`, [tenant.id, user.id, clientIp(c), c.req.header('user-agent')?.slice(0, 300) ?? null]);
        }
        return { error: unauthorized('Invalid email or password') };
      }
      await tx.query(`update users set failed_logins = 0, locked_until = null, last_login_at = now() where tenant_id = $1 and id = $2`, [tenant.id, user.id]);
      const s = await issueSession(c, tx, tenant.id, user.id, null);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip, user_agent) values ($1,$2,'login','user',$2,$3,$4)`, [tenant.id, user.id, clientIp(c), c.req.header('user-agent')?.slice(0, 300) ?? null]);
      return { user, ...s };
    });
    // failed-login bookkeeping must commit, so the error is thrown after the transaction
    if ('error' in result) throw result.error;
    return c.json({
      accessToken: result.accessToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: result.user.id, email: result.user.email, fullName: result.user.full_name },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    });
  })

  .post('/refresh', async (c) => {
    requireCsrfHeader(c);
    const token = getCookie(c, REFRESH_COOKIE);
    if (!token) throw unauthorized('No session');
    const tenant = c.var.tenant;
    const hash = await sha256Hex(token);
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const s = await tx.one<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date }>(
        `select id, user_id, family_id, revoked_at, expires_at from sessions where tenant_id = $1 and refresh_hash = $2`,
        [tenant.id, hash],
      );
      if (!s) return null;
      if (s.revoked_at) {
        // refresh-token reuse → assume theft, kill the whole family
        await tx.query(`update sessions set revoked_at = coalesce(revoked_at, now()) where tenant_id = $1 and family_id = $2`, [tenant.id, s.family_id]);
        await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip) values ($1,$2,'session_reuse_detected','user',$2,$3)`, [tenant.id, s.user_id, clientIp(c)]);
        return null;
      }
      if (new Date(s.expires_at) < new Date()) return null;
      const user = await tx.one<{ status: string; email: string; full_name: string }>(`select status, email, full_name from users where tenant_id = $1 and id = $2`, [tenant.id, s.user_id]);
      if (user?.status !== 'active') return null;
      const next = await issueSession(c, tx, tenant.id, s.user_id, s.family_id);
      await tx.query(`update sessions set revoked_at = now(), replaced_by = $3 where tenant_id = $1 and id = $2`, [tenant.id, s.id, next.sessionId]);
      return { ...next, user: { id: s.user_id, email: user.email, fullName: user.full_name } };
    });
    if (!result) {
      deleteCookie(c, REFRESH_COOKIE, { path: '/', secure: true });
      throw unauthorized('Session expired');
    }
    return c.json({ accessToken: result.accessToken, expiresIn: ACCESS_TTL_SECONDS, user: result.user, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name } });
  })

  .post('/logout', async (c) => {
    requireCsrfHeader(c);
    const token = getCookie(c, REFRESH_COOKIE);
    if (token) {
      const hash = await sha256Hex(token);
      await c.var.db.tx(scope(c), (tx) =>
        tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and family_id = (select family_id from sessions where tenant_id = $1 and refresh_hash = $2)`, [c.var.tenant.id, hash]),
      );
    }
    deleteCookie(c, REFRESH_COOKIE, { path: '/', secure: true });
    return c.json({ ok: true });
  })

  .get('/me', authenticate, (c) => {
    const p = c.var.principal;
    return c.json({ user: { ...p.user }, tenant: { id: c.var.tenant.id, slug: c.var.tenant.slug, name: c.var.tenant.name }, permissions: p.permissions });
  })

  .post('/change-password', authenticate, async (c) => {
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(await c.req.json());
    const policy = passwordPolicyError(body.newPassword);
    if (policy) throw badRequest(policy);
    const p = c.var.principal;
    await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ password_hash: string }>(`select password_hash from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id]);
      if (!(await verifyPassword(body.currentPassword, u?.password_hash))) throw badRequest('Current password is incorrect');
      await tx.query(`update users set password_hash = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id, await hashPassword(body.newPassword)]);
      // sign out every other session
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and id <> $3 and revoked_at is null`, [c.var.tenant.id, p.user.id, p.sessionId]);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id) values ($1,$2,'password_changed','user',$2)`, [c.var.tenant.id, p.user.id]);
    });
    await invalidatePrincipal(c.env, c.var.tenant, p.user.id);
    return c.json({ ok: true });
  });
