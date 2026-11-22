/**
 * Connection keys set in the app (Settings → Connection keys) rather than in the server's .env.
 *
 * Every request, background job and scheduled run gets an env where the keys saved here take the
 * place of the .env values (.env stays a fallback): `withPlatformKeys` for the whole platform,
 * `withTenantKeys` for keys a workspace may set for itself (GST provider). The env object is copied,
 * never changed, so one workspace's keys never reach another request.
 *
 * Secret values are encrypted with DATA_ENCRYPTION_KEY — that key, JWT_SECRET and the database
 * address are the only things that have to stay in the server's environment.
 */
import { ALL_KEYS, groupOfKey, KEY_GROUPS, type KeyGroup, keyField, requiredKeys } from '@synapse/shared';
import type { Env, Principal, TenantInfo } from '../env';
import type { Db, Tx } from '../lib/db';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { badRequest, forbidden } from '../lib/errors';

const PLATFORM_AAD = 'platform-settings';
const TTL = 30_000;
const RAW = Symbol.for('synapse.rawEnv');

type Row = { key: string; value_enc: string | null; value_plain: string | null };
let platformCache: { at: number; values: Record<string, string> } | null = null;
const tenantCache = new Map<string, { at: number; values: Record<string, string> }>();

/** The env as the server started it (without keys from the database). */
export const rawEnv = (env: Env): Env => ((env as unknown as Record<symbol, Env>)[RAW] ?? env);

function overlay(env: Env, values: Record<string, string>): Env {
  const base = rawEnv(env);
  if (!Object.keys(values).length) return env;
  const out = { ...(env as unknown as Record<string, unknown>), ...values } as unknown as Env;
  Object.defineProperty(out, RAW, { value: base, enumerable: false });
  return out;
}

async function decode(env: Env, rows: Row[], aad: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!ALL_KEYS.includes(r.key)) continue;
    if (r.value_plain !== null) out[r.key] = r.value_plain;
    else if (r.value_enc && env.DATA_ENCRYPTION_KEY) {
      try {
        out[r.key] = await decryptSecret(env.DATA_ENCRYPTION_KEY, r.value_enc, aad);
      } catch {
        console.error(JSON.stringify({ level: 'error', job: 'connection-keys', msg: `cannot decrypt ${r.key} (DATA_ENCRYPTION_KEY changed?)` }));
      }
    }
  }
  return out;
}

export async function platformValues(env: Env, db: Db): Promise<Record<string, string>> {
  if (platformCache && Date.now() - platformCache.at < TTL) return platformCache.values;
  try {
    const rows = await db.platform<Row>(`select key, value_enc, value_plain from platform_settings`);
    platformCache = { at: Date.now(), values: await decode(env, rows, PLATFORM_AAD) };
  } catch (e) {
    // before the migration, or the database is down: the .env values still work
    if (!platformCache) console.error(JSON.stringify({ level: 'warn', job: 'connection-keys', msg: (e as Error).message }));
    platformCache = { at: Date.now(), values: platformCache?.values ?? {} };
  }
  return platformCache.values;
}

/** env with the platform keys saved in Settings in place of the .env values. */
export async function withPlatformKeys(env: Env, db: Db): Promise<Env> {
  return overlay(env, await platformValues(rawEnv(env), db));
}

/** env with this workspace's own keys (only keys of groups a workspace may set). */
export async function withTenantKeys(env: Env, db: Db, tenantId: string): Promise<Env> {
  let hit = tenantCache.get(tenantId);
  if (!hit || Date.now() - hit.at > TTL) {
    const rows = await db.tx({ tenantId, readOnly: true }, (tx) => tx.query<Row>(`select key, value_enc, value_plain from tenant_keys where tenant_id = $1`, [tenantId])).catch(() => [] as Row[]);
    const values = await decode(rawEnv(env), rows, tenantId);
    for (const k of Object.keys(values)) if (groupOfKey(k)?.scope !== 'both') delete values[k];
    hit = { at: Date.now(), values };
    tenantCache.set(tenantId, hit);
    if (tenantCache.size > 500) tenantCache.delete(tenantCache.keys().next().value!);
  }
  if (!Object.keys(hit.values).length) return env;
  // a workspace that brings its own GSP account uses it alone (no mix of its keys and the platform's)
  const base = { ...hit.values };
  const gst = KEY_GROUPS.find((g) => g.id === 'gst')!;
  if (gst.fields.some((f) => base[f.key] !== undefined && f.key !== 'GST_PROVIDER')) for (const f of gst.fields) base[f.key] ??= '';
  return overlay(env, base);
}

export function forgetCachedKeys(tenantId?: string) {
  platformCache = null;
  if (tenantId) tenantCache.delete(tenantId);
  else tenantCache.clear();
}

/* ───────────────────────── who manages the platform keys ───────────────────────── */

/**
 * Platform admins: the people listed in platform_admins; while nobody is listed, the owners of the
 * first workspace created (on a local server: any workspace owner).
 */
export async function isPlatformAdmin(env: Env, db: Db, tenant: TenantInfo, principal: Principal): Promise<boolean> {
  const listed = await db.platform<{ tenant_id: string; user_id: string }>(`select tenant_id, user_id from platform_admins`);
  if (listed.length) return listed.some((r) => r.tenant_id === tenant.id && r.user_id === principal.user.id);
  if (!principal.user.isOwner) return false;
  if (env.APP_ENV === 'local') return true;
  const first = await db.platform<{ id: string | null }>(`select app.first_tenant_id() as id`);
  return first[0]?.id === tenant.id;
}

export async function assertPlatformAdmin(env: Env, db: Db, tenant: TenantInfo, principal: Principal) {
  if (!(await isPlatformAdmin(env, db, tenant, principal))) throw forbidden('Only platform admins can change the platform’s connection keys');
}

export async function listPlatformAdmins(db: Db, tenantId: string) {
  return db.platform<{ user_id: string; created_at: string }>(`select user_id, created_at from platform_admins where tenant_id = $1 order by created_at`, [tenantId]);
}

export async function setPlatformAdmin(db: Db, tenant: TenantInfo, principal: Principal, userId: string, on: boolean) {
  const rows = await db.tx({ tenantId: tenant.id, readOnly: true }, (tx) => tx.query(`select 1 from users where tenant_id = $1 and id = $2 and status = 'active'`, [tenant.id, userId]));
  if (!rows.length) throw badRequest('That person is not an active user of this workspace');
  if (on) {
    // the first entry also keeps the person adding it
    await db.platform(
      `insert into platform_admins (tenant_id, user_id, added_by) select $1, x, $3 from unnest(array[$2::uuid, $3::uuid]) x on conflict do nothing`,
      [tenant.id, userId, principal.user.id],
    );
  } else {
    const n = await db.platform<{ n: number }>(`select count(*)::int as n from platform_admins`);
    if ((n[0]?.n ?? 0) <= 1) throw badRequest('Keep at least one platform admin');
    await db.platform(`delete from platform_admins where tenant_id = $1 and user_id = $2`, [tenant.id, userId]);
  }
  return { ok: true };
}

/* ───────────────────────── listing and saving ───────────────────────── */

export type Scope = 'platform' | 'workspace';

const hint = (v: string) => (v.length <= 8 ? '•'.repeat(v.length) : `•••• ${v.slice(-4)}`);

/** The catalog with what is set where (secrets only as their last characters). */
export async function describeKeys(env: Env, db: Db, scope: Scope, tenantId: string) {
  const raw = rawEnv(env);
  const saved =
    scope === 'platform'
      ? await platformValues(raw, db)
      : await decode(
          raw,
          await db.tx({ tenantId, readOnly: true }, (tx) => tx.query<Row>(`select key, value_enc, value_plain from tenant_keys where tenant_id = $1`, [tenantId])),
          tenantId,
        );
  const platform = scope === 'workspace' ? await platformValues(raw, db) : {};
  const meta = scope === 'platform' ? await db.platform<{ key: string; updated_at: string }>(`select key, updated_at from platform_settings`) : [];
  const groups = KEY_GROUPS.filter((g) => scope === 'platform' || g.scope === 'both').map((g) => {
    const fields = g.fields.map((f) => {
      const here = saved[f.key];
      const envVal = (raw as unknown as Record<string, string | undefined>)[f.key];
      const inherited = scope === 'workspace' ? (platform[f.key] ?? envVal) : envVal;
      const show = (v: string | undefined) => (v === undefined || v === '' ? null : f.secret ? hint(v) : v);
      return {
        ...f,
        source: here !== undefined && here !== '' ? 'here' : inherited ? (scope === 'workspace' ? 'platform' : 'env') : null,
        value: show(here) ?? (scope === 'platform' ? show(envVal) : f.secret ? null : show(inherited)),
        updatedAt: meta.find((m) => m.key === f.key)?.updated_at ?? null,
      };
    });
    const effective = (k: string) => fields.find((x) => x.key === k)?.source;
    const req = requiredKeys(g);
    const status: 'ready' | 'partial' | 'off' | 'defaults' | 'custom' = g.options
      ? fields.some((x) => x.source === 'here') ? 'custom' : 'defaults'
      : req.length
      ? req.every((k) => effective(k)) ? 'ready' : req.some((k) => effective(k)) ? 'partial' : 'off'
      : fields.some((x) => x.source && x.kind !== 'bool' && x.kind !== 'select') ? 'ready' : 'off';
    return { ...g, fields, status, ownKeys: scope === 'workspace' && fields.some((x) => x.source === 'here') };
  });
  return { scope, encryption: !!raw.DATA_ENCRYPTION_KEY, groups };
}

function check(key: string, value: string) {
  const f = keyField(key);
  if (!f) throw badRequest(`Unknown key ${key}`);
  if (value.length > (f.kind === 'textarea' ? 20_000 : 2_000)) throw badRequest(`${f.label} is too long`);
  if (f.kind === 'bool' && !['true', 'false'].includes(value)) throw badRequest(`${f.label}: true or false`);
  if (f.kind === 'select' && !f.options!.some(([v]) => v === value)) throw badRequest(`${f.label}: not one of the choices`);
  if (f.pattern && !new RegExp(f.pattern).test(value)) throw badRequest(`${f.label} doesn’t look right — check it was copied in full`);
  if (key === 'GITHUB_APP_PRIVATE_KEY' && !/-----BEGIN (RSA )?PRIVATE KEY-----/.test(value.replace(/\\n/g, '\n'))) throw badRequest('Paste the whole .pem file, from -----BEGIN … to -----END …');
  if (key === 'FCM_SERVICE_ACCOUNT') {
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(value);
    } catch {
      throw badRequest('Paste the whole service-account JSON file');
    }
    if (j.type !== 'service_account' || !j.client_email || !j.private_key) throw badRequest('That JSON is not a service-account key');
  }
  if (key === 'MAIL_FROM' && !/^(.{0,100}<)?[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}>?$/i.test(value)) throw badRequest('Send as: an address like SanchalanOS <no-reply@your-domain>');
  if (key === 'VAPID_SUBJECT' && !/^(mailto:|https:\/\/)/.test(value)) throw badRequest('Contact: a mailto: or https:// address');
}

/** values: key → new value ('' or null = remove, so the .env / platform value applies again). */
export async function saveKeys(env: Env, db: Db, scope: Scope, tenantId: string, userId: string, values: Record<string, string | null>) {
  const raw = rawEnv(env);
  const entries = Object.entries(values);
  if (!entries.length) return { saved: 0 };
  for (const [k, v] of entries) {
    const g = groupOfKey(k);
    if (!g) throw badRequest(`Unknown key ${k}`);
    if (scope === 'workspace' && g.scope !== 'both') throw forbidden(`${k} is set for the whole platform`);
    if (v !== null && v !== '') check(k, k === 'GITHUB_APP_PRIVATE_KEY' ? v.replace(/\\n/g, '\n') : v.trim());
  }
  const anySecret = entries.some(([k, v]) => v && keyField(k)!.secret);
  if (anySecret && !raw.DATA_ENCRYPTION_KEY) throw badRequest('This server has no DATA_ENCRYPTION_KEY, so secrets cannot be stored');
  const aad = scope === 'platform' ? PLATFORM_AAD : tenantId;
  const rows: { key: string; enc: string | null; plain: string | null; secret: boolean }[] = [];
  for (const [k, v0] of entries) {
    const f = keyField(k)!;
    const v = v0 === null ? null : k === 'GITHUB_APP_PRIVATE_KEY' ? v0.replace(/\\n/g, '\n').trim() : v0.trim();
    rows.push({ key: k, enc: v && f.secret ? await encryptSecret(raw.DATA_ENCRYPTION_KEY!, v, aad) : null, plain: v && !f.secret ? v : null, secret: !!f.secret });
  }
  const write = async (q: (sql: string, p: unknown[]) => Promise<unknown>) => {
    const table = scope === 'platform' ? 'platform_settings' : 'tenant_keys';
    for (const r of rows) {
      if (!r.enc && !r.plain) {
        await q(scope === 'platform' ? `delete from platform_settings where key = $1` : `delete from tenant_keys where tenant_id = $2 and key = $1`, scope === 'platform' ? [r.key] : [r.key, tenantId]);
        continue;
      }
      await q(
        scope === 'platform'
          ? `insert into ${table} (key, value_enc, value_plain, is_secret, updated_by, updated_at) values ($1,$2,$3,$4,$5, now())
             on conflict (key) do update set value_enc = excluded.value_enc, value_plain = excluded.value_plain, is_secret = excluded.is_secret, updated_by = excluded.updated_by, updated_at = now()`
          : `insert into ${table} (tenant_id, key, value_enc, value_plain, is_secret, updated_by, updated_at) values ($6,$1,$2,$3,$4,$5, now())
             on conflict (tenant_id, key) do update set value_enc = excluded.value_enc, value_plain = excluded.value_plain, is_secret = excluded.is_secret, updated_by = excluded.updated_by, updated_at = now()`,
        scope === 'platform' ? [r.key, r.enc, r.plain, r.secret, userId] : [r.key, r.enc, r.plain, r.secret, userId, tenantId],
      );
    }
  };
  if (scope === 'platform') await write((sql, p) => db.platform(sql, p));
  else await db.tx({ tenantId, userId }, (tx: Tx) => write((sql, p) => tx.query(sql, p)));
  forgetCachedKeys(tenantId);
  return { saved: rows.length };
}

/* ───────────────────────── generate and test ───────────────────────── */

const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function randomSecret(bytes = 24) {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A VAPID key pair for web push: public = uncompressed P-256 point, private = d (both base64url). */
export async function vapidPair() {
  const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { VAPID_PUBLIC_KEY: b64u(pub), VAPID_PRIVATE_KEY: jwk.d! };
}

type Check = { ok: boolean; message: string };
const ok = (message: string): Check => ({ ok: true, message });
const bad = (message: string): Check => ({ ok: false, message });

async function call(url: string, init?: RequestInit): Promise<{ status: number; json: Record<string, any> }> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: r.status, json };
}
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Checks a group's keys with the service itself (with the values in effect for this request). */
export async function testGroup(env: Env, groupId: string): Promise<{ checks: Check[] }> {
  const g = KEY_GROUPS.find((x) => x.id === groupId);
  if (!g) throw badRequest('Unknown connection');
  const e = env as unknown as Record<string, string | undefined>;
  const missing = requiredKeys(g).filter((k) => !e[k]);
  if (missing.length) return { checks: [bad(`Not set yet: ${missing.map((k) => keyField(k)!.label).join(', ')}`)] };
  const checks: Check[] = [];
  const run = async (label: string, fn: () => Promise<Check>) => {
    try {
      const c = await fn();
      checks.push({ ok: c.ok, message: `${label}: ${c.message}` });
    } catch (x) {
      checks.push(bad(`${label}: could not reach the service (${(x as Error).message.slice(0, 120)})`));
    }
  };
  switch (g.id) {
    case 'google':
      // a made-up code: Google answers invalid_grant when the client is right, invalid_client when not
      await run('Google', async () => {
        const r = await call('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: 'synapse-test', client_id: e.GOOGLE_CLIENT_ID!, client_secret: e.GOOGLE_CLIENT_SECRET!, redirect_uri: 'https://example.invalid/' }) });
        return r.json.error === 'invalid_client' || r.json.error === 'unauthorized_client' ? bad('Google does not accept this client ID and secret') : ok('client ID and secret accepted');
      });
      break;
    case 'microsoft':
      await run('Microsoft', async () => {
        const r = await call('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code: 'synapse-test', client_id: e.MS_CLIENT_ID!, client_secret: e.MS_CLIENT_SECRET!, redirect_uri: 'https://example.invalid/', scope: 'openid' }) });
        const d = String(r.json.error_description ?? '');
        if (/AADSTS700016|AADSTS90002/.test(d)) return bad('no app with this client ID — check the Application (client) ID');
        if (/AADSTS7000215|AADSTS7000222/.test(d)) return bad(/7000222/.test(d) ? 'the client secret has expired — create a new one' : 'wrong client secret — paste the secret’s Value, not its ID');
        return ok('app found and secret accepted');
      });
      break;
    case 'zoom':
      await run('Zoom', async () => {
        const r = await call('https://zoom.us/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${btoa(`${e.ZOOM_CLIENT_ID}:${e.ZOOM_CLIENT_SECRET}`)}` }, body: form({ grant_type: 'authorization_code', code: 'synapse-test', redirect_uri: 'https://example.invalid/' }) });
        return r.json.error === 'invalid_client' ? bad('Zoom does not accept this client ID and secret') : ok('client ID and secret accepted');
      });
      break;
    case 'github_app':
      await run('GitHub', async () => {
        const { appJwt } = await import('./github-app');
        const r = await call('https://api.github.com/app', { headers: { authorization: `Bearer ${appJwt(env)}`, accept: 'application/vnd.github+json', 'user-agent': 'hrp-synapse' } });
        if (r.status !== 200) return bad(`GitHub refused the app ID / private key (${r.json.message ?? r.status})`);
        if (r.json.slug !== e.GITHUB_APP_SLUG) return bad(`the app is “${r.json.slug}”, but the slug here is “${e.GITHUB_APP_SLUG}”`);
        return ok(`app “${r.json.name}” found, installed ${r.json.installations_count ?? 0} times`);
      });
      break;
    case 'meta':
      await run('Meta', async () => {
        const r = await call(`https://graph.facebook.com/oauth/access_token?${form({ client_id: e.META_APP_ID!, client_secret: e.META_APP_SECRET!, grant_type: 'client_credentials' })}`);
        return r.json.access_token ? ok('app ID and secret accepted') : bad(r.json.error?.message ?? 'Meta refused the app ID and secret');
      });
      break;
    case 'mail':
      await run('Resend', async () => {
        const r = await call('https://api.resend.com/domains', { headers: { authorization: `Bearer ${e.RESEND_API_KEY}` } });
        if (r.status === 401 || r.status === 403) {
          // a key with sending access only cannot list domains — still a valid key
          if (/restricted/i.test(String(r.json.message ?? r.json.name ?? ''))) return ok('key accepted (sending access)');
          return bad('Resend does not accept this API key');
        }
        const domain = /@([^>\s]+)>?$/.exec(e.MAIL_FROM ?? '')?.[1]?.toLowerCase();
        const d = ((r.json.data ?? []) as { name: string; status: string }[]).find((x) => x.name.toLowerCase() === domain || domain?.endsWith(`.${x.name.toLowerCase()}`));
        if (!d) return bad(`the domain of “${e.MAIL_FROM}” is not added in Resend`);
        return d.status === 'verified' ? ok(`key accepted, ${d.name} is verified`) : bad(`${d.name} is not verified yet in Resend (${d.status})`);
      });
      break;
    case 'ai':
      if (e.GROQ_API_KEY)
        await run('Groq', async () => {
          const r = await call('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${e.GROQ_API_KEY}` } });
          if (r.status !== 200) return bad('Groq does not accept this key');
          const model = e.AI_MODEL_GROQ ?? 'llama-3.3-70b-versatile';
          return ((r.json.data ?? []) as { id: string }[]).some((m) => m.id === model) ? ok(`key accepted, ${model} available`) : bad(`key accepted, but the model ${model} is not offered`);
        });
      if (e.GEMINI_API_KEY)
        await run('Gemini', async () => {
          const r = await call(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(e.GEMINI_API_KEY!)}&pageSize=200`);
          if (r.status !== 200) return bad(r.json.error?.message ?? 'Google does not accept this key');
          const model = e.AI_MODEL_GEMINI ?? 'gemini-2.5-flash';
          return ((r.json.models ?? []) as { name: string }[]).some((m) => m.name === `models/${model}`) ? ok(`key accepted, ${model} available`) : bad(`key accepted, but the model ${model} is not offered`);
        });
      if (!checks.length) checks.push(bad('Neither key is set'));
      break;
    case 'push':
      await run('Web push', async () => {
        const pub = Uint8Array.from(atob(e.VAPID_PUBLIC_KEY!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        if (pub.length !== 65 || pub[0] !== 4) return bad('the public key is not a P-256 key (use Generate key pair)');
        const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: e.VAPID_PRIVATE_KEY!, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array([1]));
        return ok('the key pair is valid');
      });
      if (e.FCM_SERVICE_ACCOUNT)
        await run('Firebase', async () => {
          const j = JSON.parse(e.FCM_SERVICE_ACCOUNT!);
          return j.type === 'service_account' && j.project_id && j.private_key ? ok(`service account for project ${j.project_id}`) : bad('not a service-account key');
        });
      break;
    case 'turnstile':
      await run('Turnstile', async () => {
        const r = await call('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ secret: e.TURNSTILE_SECRET!, response: 'synapse-test' }) });
        const codes = (r.json['error-codes'] ?? []) as string[];
        return codes.includes('invalid-input-secret') || codes.includes('missing-input-secret') ? bad('Cloudflare does not accept this secret key') : ok('secret key accepted');
      });
      break;
    case 'cloudflare':
      for (const [k, label] of [
        ['CF_TENANT_DOMAINS_TOKEN', 'Workspace addresses token'],
        ['CF_SAAS_API_TOKEN', 'Customer domains token'],
      ] as const) {
        if (!e[k]) continue;
        await run(label, async () => {
          const user = await call('https://api.cloudflare.com/client/v4/user/tokens/verify', { headers: { authorization: `Bearer ${e[k]}` } });
          if (user.json.result?.status === 'active') return ok('active');
          if (e.CF_ACCOUNT_ID) {
            const acct = await call(`https://api.cloudflare.com/client/v4/accounts/${e.CF_ACCOUNT_ID}/tokens/verify`, { headers: { authorization: `Bearer ${e[k]}` } });
            if (acct.json.result?.status === 'active') return ok('active (account token)');
          }
          return bad('Cloudflare says this token is not valid');
        });
      }
      if (!checks.length) checks.push(ok('Nothing to check yet — add a token'));
      break;
    default:
      checks.push(ok('Saved (this connection has no online check)'));
  }
  return { checks };
}

export const groupsForScope = (scope: Scope): KeyGroup[] => KEY_GROUPS.filter((g) => scope === 'platform' || g.scope === 'both');
