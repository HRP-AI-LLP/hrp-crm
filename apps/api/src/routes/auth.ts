import { hashPassword, passwordPolicyError, verifyPassword } from '@synapse/shared';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from '../lib/crypto';
import { newTotpSecret, otpauthUri, recoveryCodes, verifyTotp } from '../lib/totp';
import { actionEmail, appOrigin, mailerConfigured, sendPlatformMail } from '../services/mailer';
import { ApiError, badRequest, forbidden, unauthorized } from '../lib/errors';
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, signAccessToken } from '../lib/jwt';
import { authenticate, scope } from '../middleware';
import { invalidatePrincipal } from '../services/tenancy';

/** One refresh cookie per workspace, so several workspaces can be signed in on the shared app host. */
const refreshCookie = (slug: string) => `__Host-synapse_rt_${slug}`;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

const loginSchema = z.object({ email: z.string().trim().toLowerCase().min(3).max(254), password: z.string().min(1).max(200) });

function clientIp(c: { req: { header(n: string): string | undefined } }) {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

function setRefreshCookie(c: Context<AppEnv>, token: string) {
  setCookie(c, refreshCookie(c.var.tenant.slug), token, { path: '/', secure: true, httpOnly: true, sameSite: 'Strict', maxAge: REFRESH_TTL_SECONDS });
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

const mfaAad = (tenantId: string, userId: string) => `${tenantId}:${userId}:mfa`;

/** One-time token (invite / reset / pending MFA sign-in); only its hash is stored. */
export async function createUserToken(tx: import('../lib/db').Tx, tenantId: string, userId: string, kind: 'invite' | 'reset' | 'mfa', ttlSeconds: number): Promise<string> {
  const token = randomToken(32);
  // one live token per kind and user
  await tx.query(`update user_tokens set used_at = now() where tenant_id = $1 and user_id = $2 and kind = $3 and used_at is null`, [tenantId, userId, kind]);
  await tx.query(`insert into user_tokens (tenant_id, user_id, kind, token_hash, expires_at) values ($1,$2,$3,$4, now() + make_interval(secs => $5))`, [tenantId, userId, kind, await sha256Hex(token), ttlSeconds]);
  return token;
}

async function findToken(tx: import('../lib/db').Tx, tenantId: string, token: string, kind: string, lock = false) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  return tx.one<{ id: string; user_id: string; attempts: number }>(
    `select id, user_id, attempts from user_tokens where tenant_id = $1 and token_hash = $2 and kind = $3 and used_at is null and expires_at > now()${lock ? ' for update' : ''}`,
    [tenantId, await sha256Hex(token), kind],
  );
}

async function checkSecondFactor(c: Context<AppEnv>, tx: import('../lib/db').Tx, userId: string, code?: string | null, recovery?: string | null): Promise<boolean> {
  const u = await tx.one<{ mfa_secret_ciphertext: string | null; mfa_recovery_hashes: string[]; mfa_last_step: string | null }>(
    `select mfa_secret_ciphertext, mfa_recovery_hashes, mfa_last_step from users where tenant_id = $1 and id = $2 for update`,
    [c.var.tenant.id, userId],
  );
  if (!u?.mfa_secret_ciphertext || !c.env.DATA_ENCRYPTION_KEY) return false;
  if (code) {
    const secret = await decryptSecret(c.env.DATA_ENCRYPTION_KEY, u.mfa_secret_ciphertext, mfaAad(c.var.tenant.id, userId));
    const step = await verifyTotp(secret, code);
    // a code is valid once: reject replays inside its time window
    if (step === null || (u.mfa_last_step !== null && step <= Number(u.mfa_last_step))) return false;
    await tx.query(`update users set mfa_last_step = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, userId, step]);
    return true;
  }
  if (recovery) {
    const h = await sha256Hex(recovery.trim().toLowerCase());
    if (!u.mfa_recovery_hashes.includes(h)) return false;
    await tx.query(`update users set mfa_recovery_hashes = array_remove(mfa_recovery_hashes, $3) where tenant_id = $1 and id = $2`, [c.var.tenant.id, userId, h]);
    await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id) values ($1,$2,'mfa_recovery_code_used','user',$2)`, [c.var.tenant.id, userId]);
    return true;
  }
  return false;
}

const sessionResponse = (c: Context<AppEnv>, r: { accessToken: string; user: { id: string; email: string; full_name?: string; fullName?: string } }) =>
  c.json({
    accessToken: r.accessToken,
    expiresIn: ACCESS_TTL_SECONDS,
    user: { id: r.user.id, email: r.user.email, fullName: r.user.fullName ?? r.user.full_name },
    tenant: { id: c.var.tenant.id, slug: c.var.tenant.slug, name: c.var.tenant.name },
  });

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const body = loginSchema.parse(await c.req.json());
    const tenant = c.var.tenant;
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const user = await tx.one<{ id: string; password_hash: string | null; status: string; locked_until: Date | null; failed_logins: number; full_name: string; email: string; mfa: boolean }>(
        `select id, password_hash, status, locked_until, failed_logins, full_name, email, (mfa_enabled_at is not null) as mfa from users where tenant_id = $1 and lower(email) = $2`,
        [tenant.id, body.email],
      );
      if (user?.locked_until && new Date(user.locked_until) > new Date()) {
        // same answer as a wrong password, so the lock does not reveal that the account exists
        return { error: unauthorized(`Invalid email or password. After ${MAX_FAILED} failed attempts sign-in is paused for ${LOCK_MINUTES} minutes.`) };
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
        return { error: unauthorized(`Invalid email or password. After ${MAX_FAILED} failed attempts sign-in is paused for ${LOCK_MINUTES} minutes.`) };
      }
      if (user.mfa) {
        // password is right; the session is issued only after the second factor
        await tx.query(`update users set failed_logins = 0, locked_until = null where tenant_id = $1 and id = $2`, [tenant.id, user.id]);
        return { mfaChallenge: await createUserToken(tx, tenant.id, user.id, 'mfa', 300) };
      }
      await tx.query(`update users set failed_logins = 0, locked_until = null, last_login_at = now() where tenant_id = $1 and id = $2`, [tenant.id, user.id]);
      const s = await issueSession(c, tx, tenant.id, user.id, null);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip, user_agent) values ($1,$2,'login','user',$2,$3,$4)`, [tenant.id, user.id, clientIp(c), c.req.header('user-agent')?.slice(0, 300) ?? null]);
      return { user, ...s };
    });
    // failed-login bookkeeping must commit, so the error is thrown after the transaction
    if ('error' in result) throw result.error;
    if ('mfaChallenge' in result) return c.json({ mfaRequired: true, challenge: result.mfaChallenge });
    return c.json({
      accessToken: result.accessToken,
      expiresIn: ACCESS_TTL_SECONDS,
      user: { id: result.user.id, email: result.user.email, fullName: result.user.full_name },
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
    });
  })

  // ------------------------------------------------------------------ two-factor sign-in
  .post('/mfa/verify', async (c) => {
    const b = z.object({ challenge: z.string().max(100), code: z.string().max(10).nullish(), recoveryCode: z.string().max(20).nullish() }).parse(await c.req.json());
    const tenant = c.var.tenant;
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const t = await findToken(tx, tenant.id, b.challenge, 'mfa', true);
      if (!t) return { error: unauthorized('The sign-in expired. Enter your password again.') };
      const locked = await tx.one(`select 1 from users where tenant_id = $1 and id = $2 and locked_until > now()`, [tenant.id, t.user_id]);
      if (locked) {
        await tx.query(`update user_tokens set used_at = now() where id = $1`, [t.id]);
        return { error: unauthorized(`Too many failed attempts. Sign-in is paused for ${LOCK_MINUTES} minutes.`) };
      }
      // claim one attempt atomically before checking, so parallel guesses cannot exceed the limit
      const claim = await tx.one<{ attempts: number }>(`update user_tokens set attempts = attempts + 1 where id = $1 and attempts < 5 and used_at is null returning attempts`, [t.id]);
      if (!claim) {
        await tx.query(`update user_tokens set used_at = now() where id = $1`, [t.id]);
        return { error: unauthorized('Too many wrong codes. Enter your password again.') };
      }
      const ok = await checkSecondFactor(c, tx, t.user_id, b.code, b.recoveryCode);
      if (!ok) {
        // wrong second factors count toward the same lockout as wrong passwords
        await tx.query(
          `update users set failed_logins = failed_logins + 1,
                  locked_until = case when failed_logins + 1 >= $3 then now() + make_interval(mins => $4) else locked_until end
            where tenant_id = $1 and id = $2`,
          [tenant.id, t.user_id, MAX_FAILED, LOCK_MINUTES],
        );
        await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip) values ($1,$2,'mfa_failed','user',$2,$3)`, [tenant.id, t.user_id, clientIp(c)]);
        return { error: new ApiError(401, 'mfa_invalid', 'That code is not right. Check your authenticator app and try again.') };
      }
      await tx.query(`update user_tokens set used_at = now() where id = $1`, [t.id]);
      const user = await tx.one<{ id: string; email: string; full_name: string; status: string }>(`select id, email, full_name, status from users where tenant_id = $1 and id = $2`, [tenant.id, t.user_id]);
      if (user?.status !== 'active') return { error: unauthorized('Account is not active') };
      await tx.query(`update users set last_login_at = now() where tenant_id = $1 and id = $2`, [tenant.id, user.id]);
      const s = await issueSession(c, tx, tenant.id, user.id, null);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip, user_agent, changes) values ($1,$2,'login','user',$2,$3,$4,'{"mfa":true}')`, [tenant.id, user.id, clientIp(c), c.req.header('user-agent')?.slice(0, 300) ?? null]);
      return { ...s, user };
    });
    if ('error' in result) throw result.error;
    return sessionResponse(c, result);
  })
  .post('/mfa/setup', authenticate, async (c) => {
    if (c.var.principal.apiKey) throw forbidden();
    if (!c.env.DATA_ENCRYPTION_KEY) throw badRequest('Two-factor sign-in needs DATA_ENCRYPTION_KEY to be configured');
    const p = c.var.principal;
    if (p.user.mfaEnabled) throw badRequest('Two-factor sign-in is already on');
    const secret = newTotpSecret();
    const ciphertext = await encryptSecret(c.env.DATA_ENCRYPTION_KEY, secret, mfaAad(c.var.tenant.id, p.user.id));
    // pending until confirmed with a code (mfa_enabled_at stays null)
    const rows = await c.var.db.tx(scope(c), (tx) =>
      tx.query(`update users set mfa_secret_ciphertext = $3, mfa_last_step = null where tenant_id = $1 and id = $2 and mfa_enabled_at is null returning id`, [c.var.tenant.id, p.user.id, ciphertext]),
    );
    if (!rows.length) throw badRequest('Two-factor sign-in is already on');
    return c.json({ secret, uri: otpauthUri(secret, p.user.email, `HRP Synapse (${c.var.tenant.slug})`) });
  })
  .post('/mfa/enable', authenticate, async (c) => {
    if (c.var.principal.apiKey) throw forbidden();
    const b = z.object({ code: z.string().max(10) }).parse(await c.req.json());
    const p = c.var.principal;
    const codes = recoveryCodes();
    await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ mfa_enabled_at: Date | null; mfa_secret_ciphertext: string | null }>(`select mfa_enabled_at, mfa_secret_ciphertext from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id]);
      if (u?.mfa_enabled_at) throw badRequest('Two-factor sign-in is already on');
      if (!u?.mfa_secret_ciphertext) throw badRequest('Start the setup first');
      if (!(await checkSecondFactor(c, tx, p.user.id, b.code))) throw badRequest('That code is not right. Make sure the time on your phone is correct.');
      await tx.query(`update users set mfa_enabled_at = now(), mfa_recovery_hashes = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id, await Promise.all(codes.map((x) => sha256Hex(x)))]);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id) values ($1,$2,'mfa_enabled','user',$2)`, [c.var.tenant.id, p.user.id]);
    });
    await invalidatePrincipal(c.env, c.var.tenant, p.user.id);
    return c.json({ ok: true, recoveryCodes: codes });
  })
  .post('/mfa/disable', authenticate, async (c) => {
    if (c.var.principal.apiKey) throw forbidden();
    const b = z.object({ password: z.string().max(200), code: z.string().max(10).nullish(), recoveryCode: z.string().max(20).nullish() }).parse(await c.req.json());
    if (c.var.meta.tenant.security?.requireMfa) throw badRequest('Your workspace requires two-factor sign-in');
    const p = c.var.principal;
    await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ password_hash: string }>(`select password_hash from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id]);
      if (!(await verifyPassword(b.password, u?.password_hash))) throw badRequest('Password is incorrect');
      if (!(await checkSecondFactor(c, tx, p.user.id, b.code, b.recoveryCode))) throw badRequest('That code is not right');
      await tx.query(`update users set mfa_enabled_at = null, mfa_secret_ciphertext = null, mfa_recovery_hashes = '{}', mfa_last_step = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id]);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id) values ($1,$2,'mfa_disabled','user',$2)`, [c.var.tenant.id, p.user.id]);
    });
    await invalidatePrincipal(c.env, c.var.tenant, p.user.id);
    return c.json({ ok: true });
  })
  .post('/mfa/recovery-codes', authenticate, async (c) => {
    if (c.var.principal.apiKey) throw forbidden();
    const b = z.object({ code: z.string().max(10) }).parse(await c.req.json());
    const p = c.var.principal;
    const codes = recoveryCodes();
    await c.var.db.tx(scope(c), async (tx) => {
      if (!p.user.mfaEnabled || !(await checkSecondFactor(c, tx, p.user.id, b.code))) throw badRequest('That code is not right');
      await tx.query(`update users set mfa_recovery_hashes = $3 where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id, await Promise.all(codes.map((x) => sha256Hex(x)))]);
    });
    return c.json({ recoveryCodes: codes });
  })

  // ------------------------------------------------------------------ invitations + password reset
  .get('/invite/:token', async (c) => {
    const out = await c.var.db.tx(scope(c, true), async (tx) => {
      const t = await findToken(tx, c.var.tenant.id, c.req.param('token'), 'invite');
      if (!t) return null;
      return tx.one<{ email: string; full_name: string }>(`select email, full_name from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, t.user_id]);
    });
    if (!out) throw new ApiError(404, 'invite_invalid', 'This invitation has expired or was already used. Ask your administrator for a new one.');
    return c.json({ email: out.email, fullName: out.full_name, workspace: c.var.tenant.name });
  })
  .post('/invite/accept', async (c) => {
    const b = z.object({ token: z.string().max(100), password: z.string().max(200), fullName: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const hash = await hashPassword(b.password);
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const t = await findToken(tx, c.var.tenant.id, b.token, 'invite', true);
      if (!t) throw new ApiError(404, 'invite_invalid', 'This invitation has expired or was already used.');
      await tx.query(`update user_tokens set used_at = now() where id = $1`, [t.id]);
      const user = await tx.one<{ id: string; email: string; full_name: string }>(
        `update users set password_hash = $3, status = 'active', password_changed_at = now(), full_name = coalesce($4, full_name), last_login_at = now()
          where tenant_id = $1 and id = $2 and status = 'invited' returning id, email, full_name`,
        [c.var.tenant.id, t.user_id, hash, b.fullName ?? null],
      );
      if (!user) throw new ApiError(404, 'invite_invalid', 'This invitation is no longer valid. Sign in instead, or ask your administrator for help.');
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip) values ($1,$2,'invite_accepted','user',$2,$3)`, [c.var.tenant.id, user.id, clientIp(c)]);
      return { ...(await issueSession(c, tx, c.var.tenant.id, user.id, null)), user };
    });
    await invalidatePrincipal(c.env, c.var.tenant, result.user.id);
    return sessionResponse(c, result);
  })
  .post('/password/forgot', async (c) => {
    const b = z.object({ email: z.string().trim().toLowerCase().max(254) }).parse(await c.req.json());
    const emailed = mailerConfigured(c.env);
    if (emailed) {
      const found = await c.var.db.tx(scope(c), async (tx) => {
        const u = await tx.one<{ id: string; full_name: string; email: string }>(`select id, full_name, email from users where tenant_id = $1 and lower(email) = $2 and status = 'active'`, [c.var.tenant.id, b.email]);
        if (!u) return null;
        // at most 3 reset mails per hour per person
        const recent = await tx.one<{ n: number }>(`select count(*)::int n from user_tokens where tenant_id = $1 and user_id = $2 and kind = 'reset' and created_at > now() - interval '1 hour'`, [c.var.tenant.id, u.id]);
        if ((recent?.n ?? 0) >= 3) return null;
        return { ...u, token: await createUserToken(tx, c.var.tenant.id, u.id, 'reset', 3600) };
      });
      if (found) {
        const url = `${appOrigin(c.env, c.req.url)}/reset-password?workspace=${c.var.tenant.slug}&token=${found.token}`;
        const mail = actionEmail({ heading: 'Reset your password', intro: `Hi ${found.full_name}, someone asked to reset the password for your ${c.var.tenant.name} account on HRP Synapse.`, cta: 'Choose a new password', url, footer: 'The link works for one hour. If you did not ask for this, you can ignore this email.' });
        const sending = sendPlatformMail(c.env, { to: found.email, subject: 'Reset your HRP Synapse password', ...mail });
        try {
          c.executionCtx.waitUntil(sending);
        } catch {
          await sending;
        }
      }
    }
    // same answer whether or not the address exists
    return c.json({ ok: true, emailed });
  })
  .post('/password/reset', async (c) => {
    const b = z.object({ token: z.string().max(100), password: z.string().max(200) }).parse(await c.req.json());
    const policy = passwordPolicyError(b.password);
    if (policy) throw badRequest(policy);
    const hash = await hashPassword(b.password);
    const userId = await c.var.db.tx(scope(c), async (tx) => {
      const t = await findToken(tx, c.var.tenant.id, b.token, 'reset', true);
      if (!t) throw new ApiError(404, 'reset_invalid', 'This reset link has expired or was already used. Ask for a new one.');
      await tx.query(`update user_tokens set used_at = now() where id = $1`, [t.id]);
      await tx.query(`update users set password_hash = $3, password_changed_at = now(), failed_logins = 0, locked_until = null where tenant_id = $1 and id = $2`, [c.var.tenant.id, t.user_id, hash]);
      // every existing session ends
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null`, [c.var.tenant.id, t.user_id]);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id, ip) values ($1,$2,'password_reset','user',$2,$3)`, [c.var.tenant.id, t.user_id, clientIp(c)]);
      return t.user_id;
    });
    await invalidatePrincipal(c.env, c.var.tenant, userId);
    return c.json({ ok: true });
  })

  // ------------------------------------------------------------------ my sessions
  .get('/sessions', authenticate, async (c) => {
    const p = c.var.principal;
    const rows = await c.var.db.tx(scope(c, true), (tx) =>
      tx.query<{ family_id: string; created_at: string; last_seen: string; user_agent: string | null; ip: string | null; current: boolean }>(
        `select family_id, min(created_at) as created_at, max(created_at) as last_seen,
                (array_agg(user_agent order by created_at desc))[1] as user_agent, (array_agg(ip order by created_at desc))[1] as ip,
                bool_or(id = $3) as current
           from sessions where tenant_id = $1 and user_id = $2 and expires_at > now()
          group by family_id having bool_or(revoked_at is null) order by max(created_at) desc limit 50`,
        [c.var.tenant.id, p.user.id, p.sessionId],
      ),
    );
    return c.json({ items: rows });
  })
  .post('/sessions/revoke', authenticate, async (c) => {
    const b = z.object({ familyId: z.string().uuid().optional(), others: z.boolean().optional() }).parse(await c.req.json());
    const p = c.var.principal;
    await c.var.db.tx(scope(c), (tx) =>
      b.others
        ? tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and revoked_at is null and family_id <> (select family_id from sessions where tenant_id = $1 and id = $3)`, [c.var.tenant.id, p.user.id, p.sessionId])
        : tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and family_id = $3 and revoked_at is null`, [c.var.tenant.id, p.user.id, b.familyId ?? '00000000-0000-0000-0000-000000000000']),
    );
    return c.json({ ok: true });
  })

  .post('/refresh', async (c) => {
    requireCsrfHeader(c);
    const token = getCookie(c, refreshCookie(c.var.tenant.slug));
    if (!token) throw unauthorized('No session');
    const tenant = c.var.tenant;
    const hash = await sha256Hex(token);
    const result = await c.var.db.tx(scope(c), async (tx) => {
      const s = await tx.one<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date }>(
        `select id, user_id, family_id, revoked_at, expires_at from sessions where tenant_id = $1 and refresh_hash = $2 for update`,
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
      deleteCookie(c, refreshCookie(c.var.tenant.slug), { path: '/', secure: true });
      throw unauthorized('Session expired');
    }
    return c.json({ accessToken: result.accessToken, expiresIn: ACCESS_TTL_SECONDS, user: result.user, tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name } });
  })

  .post('/logout', async (c) => {
    requireCsrfHeader(c);
    const token = getCookie(c, refreshCookie(c.var.tenant.slug));
    if (token) {
      const hash = await sha256Hex(token);
      await c.var.db.tx(scope(c), (tx) =>
        tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and family_id = (select family_id from sessions where tenant_id = $1 and refresh_hash = $2)`, [c.var.tenant.id, hash]),
      );
    }
    deleteCookie(c, refreshCookie(c.var.tenant.slug), { path: '/', secure: true });
    return c.json({ ok: true });
  })

  .get('/me', authenticate, (c) => {
    const p = c.var.principal;
    return c.json({
      user: { ...p.user },
      tenant: { id: c.var.tenant.id, slug: c.var.tenant.slug, name: c.var.tenant.name },
      permissions: p.permissions,
      security: { mfaEnabled: !!p.user.mfaEnabled, mfaRequired: !!c.var.meta.tenant.security?.requireMfa },
    });
  })

  .post('/change-password', authenticate, async (c) => {
    const body = z.object({ currentPassword: z.string(), newPassword: z.string() }).parse(await c.req.json());
    const policy = passwordPolicyError(body.newPassword);
    if (policy) throw badRequest(policy);
    const p = c.var.principal;
    await c.var.db.tx(scope(c), async (tx) => {
      const u = await tx.one<{ password_hash: string }>(`select password_hash from users where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id]);
      if (!(await verifyPassword(body.currentPassword, u?.password_hash))) throw badRequest('Current password is incorrect');
      await tx.query(`update users set password_hash = $3, password_changed_at = now() where tenant_id = $1 and id = $2`, [c.var.tenant.id, p.user.id, await hashPassword(body.newPassword)]);
      // sign out every other session
      await tx.query(`update sessions set revoked_at = now() where tenant_id = $1 and user_id = $2 and id <> $3 and revoked_at is null`, [c.var.tenant.id, p.user.id, p.sessionId]);
      await tx.query(`insert into audit_logs (tenant_id, actor_id, action, object_key, record_id) values ($1,$2,'password_changed','user',$2)`, [c.var.tenant.id, p.user.id]);
    });
    await invalidatePrincipal(c.env, c.var.tenant, p.user.id);
    return c.json({ ok: true });
  });
