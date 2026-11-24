/**
 * App-store publishing and tracking.
 *
 * SanchalanOS is the control tower: it holds the store credentials, links a project to its store app,
 * and tracks each release's status by reading the store APIs. The actual build (AAB / IPA) and the
 * binary upload run in CI (Fastlane) on a build machine — a Cloudflare Worker can't build a mobile app
 * or hold a 150 MB bundle — and CI reports the submission back here.
 *
 * Google Play is implemented (LudoVerse is live there). App Store Connect stores its key the same way
 * and is read with the same shape; its status reader is added when the first iOS build ships.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';
import { requireEncryptionKey } from './ai/tenant-providers';
import { assertOrgManager } from './organisation';

const PLAY_TRACKS = ['internal', 'closed', 'open', 'production'] as const;
const APPLE_TRACKS = ['testflight', 'appstore'] as const;

export const connectSchema = z.object({
  kind: z.enum(['google_play', 'app_store']),
  label: z.string().trim().min(1).max(120),
  /** Google: the whole service-account JSON. Apple: { keyId, issuerId, privateKey (p8) } */
  secret: z.string().min(10),
});

function parseGoogleKey(secret: string) {
  let j: Record<string, any>;
  try {
    j = JSON.parse(secret);
  } catch {
    throw badRequest('That is not a valid Google service-account JSON file');
  }
  if (j.type !== 'service_account' || !j.client_email || !j.private_key) throw badRequest('That JSON is missing client_email / private_key — download the service-account key from Google Cloud');
  return j as { client_email: string; private_key: string };
}

/* ── Google service-account OAuth (RS256 JWT → access token), done in-Worker with WebCrypto ── */

function b64url(bytes: ArrayBuffer | Uint8Array) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

async function googleToken(secret: string, scope: string) {
  const key = parseGoogleKey(secret);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(new TextEncoder().encode(JSON.stringify({ iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const signingInput = `${header}.${claim}`;
  const cryptoKey = await crypto.subtle.importKey('pkcs8', pemToPkcs8(key.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt = `${signingInput}.${b64url(sig)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!res.ok || !j.access_token) throw badRequest(`Google rejected the service account: ${j.error_description || j.error || res.status}. Check the key and that the Play Developer API is enabled.`);
  return j.access_token;
}

/* ── connections ── */

export async function connectStore(ctx: RecordCtx, env: Env, input: z.infer<typeof connectSchema>) {
  await assertOrgManager(ctx);
  if (input.kind === 'google_play') {
    const key = parseGoogleKey(input.secret);
    await googleToken(input.secret, 'https://www.googleapis.com/auth/androidpublisher'); // validate now
    const r = await ctx.tx.one<{ id: string }>(
      `insert into store_connections (tenant_id, kind, label, secret_enc, meta, created_by) values ($1,'google_play',$2,$3,$4, app.current_user_id()) returning id`,
      [ctx.tenantId, input.label, await encryptSecret(requireEncryptionKey(env), input.secret, ctx.tenantId), JSON.stringify({ clientEmail: key.client_email })],
    );
    return { id: r!.id, kind: 'google_play', label: input.label, clientEmail: key.client_email };
  }
  // App Store Connect: keep the key; the status reader lands with the first iOS build
  const r = await ctx.tx.one<{ id: string }>(
    `insert into store_connections (tenant_id, kind, label, secret_enc, meta, created_by) values ($1,'app_store',$2,$3,'{}', app.current_user_id()) returning id`,
    [ctx.tenantId, input.label, await encryptSecret(requireEncryptionKey(env), input.secret, ctx.tenantId)],
  );
  return { id: r!.id, kind: 'app_store', label: input.label };
}

export async function listStores(ctx: RecordCtx) {
  const rows = await ctx.tx.query<Record<string, any>>(`select id, kind, label, meta, status, created_at from store_connections where tenant_id = $1 and status <> 'deleted' order by created_at`, [ctx.tenantId]);
  return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, clientEmail: r.meta?.clientEmail ?? null, status: r.status }));
}

export async function deleteStore(ctx: RecordCtx, id: string) {
  await assertOrgManager(ctx);
  await ctx.tx.query(`delete from store_connections where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  await ctx.tx.query(`update projects set store_connection_id = null where tenant_id = $1 and store_connection_id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

async function connForProject(ctx: RecordCtx, env: Env, projectId: string) {
  const p = await ctx.tx.one<{ store_connection_id: string | null; store_app_id: string | null }>(`select store_connection_id, store_app_id from projects where tenant_id = $1 and id = $2`, [ctx.tenantId, projectId]);
  if (!p?.store_connection_id || !p.store_app_id) throw badRequest('Link this project to its store app first');
  const c = await ctx.tx.one<{ kind: string; secret_enc: string }>(`select kind, secret_enc from store_connections where tenant_id = $1 and id = $2`, [ctx.tenantId, p.store_connection_id]);
  if (!c) throw notFound('Store connection not found');
  return { kind: c.kind, secret: await decryptSecret(requireEncryptionKey(env), c.secret_enc, ctx.tenantId), appId: p.store_app_id };
}

/* ── project ↔ store app ── */

export const linkSchema = z.object({
  connectionId: z.string().uuid().nullable(),
  appId: z.string().trim().max(200).nullish(),
  track: z.string().trim().max(40).nullish(),
});

export async function linkProject(ctx: RecordCtx, projectId: string, input: z.infer<typeof linkSchema>) {
  await projectAccess(ctx, projectId, 'manage');
  if (input.connectionId) {
    const c = await ctx.tx.one<{ kind: string }>(`select kind from store_connections where tenant_id = $1 and id = $2`, [ctx.tenantId, input.connectionId]);
    if (!c) throw badRequest('That store connection no longer exists');
    const tracks = c.kind === 'google_play' ? PLAY_TRACKS : APPLE_TRACKS;
    if (input.track && !(tracks as readonly string[]).includes(input.track)) throw badRequest(`Track must be one of: ${tracks.join(', ')}`);
    if (!input.appId?.trim()) throw badRequest(c.kind === 'google_play' ? 'Enter the Android package name (e.g. in.hrpai.ludoverse)' : 'Enter the iOS bundle id');
  }
  await ctx.tx.query(`update projects set store_connection_id = $3, store_app_id = $4, store_default_track = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId, projectId, input.connectionId, input.connectionId ? input.appId!.trim() : null, input.connectionId ? input.track ?? 'production' : null,
  ]);
  return storeOf(ctx, projectId);
}

export async function storeOf(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const p = await ctx.tx.one<Record<string, any>>(
    `select p.store_connection_id, p.store_app_id, p.store_default_track, c.kind, c.label
       from projects p left join store_connections c on c.tenant_id = p.tenant_id and c.id = p.store_connection_id
      where p.tenant_id = $1 and p.id = $2`,
    [ctx.tenantId, projectId],
  );
  return {
    connectionId: p?.store_connection_id ?? null,
    appId: p?.store_app_id ?? null,
    track: p?.store_default_track ?? null,
    kind: p?.kind ?? null,
    label: p?.label ?? null,
    tracks: p?.kind === 'app_store' ? APPLE_TRACKS : PLAY_TRACKS,
  };
}

/* ── live status from Google Play (read-only: an edit, read its tracks, abandon it) ── */

async function play(token: string, pkg: string, method: string, path: string) {
  const res = await fetch(`https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(pkg)}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw badRequest(`Google Play: ${json?.error?.message ?? res.status}${res.status === 404 ? ` — is ${pkg} the right package, and is the service account granted access in Play Console?` : ''}`);
  return json;
}

const PLAY_STATE: Record<string, string> = { inProgress: 'live', completed: 'live', halted: 'halted', draft: 'draft' };

/** The current release on each Play track for the project's app: version, rollout and review state. */
export async function playStatus(ctx: RecordCtx, env: Env, projectId: string) {
  await projectAccess(ctx, projectId, 'view');
  const { kind, secret, appId } = await connForProject(ctx, env, projectId);
  if (kind !== 'google_play') throw badRequest('This project is linked to the App Store, not Google Play');
  const token = await googleToken(secret, 'https://www.googleapis.com/auth/androidpublisher');
  const edit = (await play(token, appId, 'POST', '/edits')) as { id: string };
  try {
    const { tracks } = (await play(token, appId, 'GET', `/edits/${edit.id}/tracks`)) as { tracks?: any[] };
    return {
      app: appId,
      tracks: (tracks ?? []).map((t) => {
        const rel = (t.releases ?? [])[0] ?? {};
        return {
          track: t.track,
          versionName: rel.name ?? null,
          versionCodes: rel.versionCodes ?? [],
          status: PLAY_STATE[String(rel.status)] ?? rel.status ?? 'none',
          rolloutPercent: rel.userFraction != null ? Math.round(rel.userFraction * 100) : rel.status === 'completed' ? 100 : null,
        };
      }),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await play(token, appId, 'DELETE', `/edits/${edit.id}`).catch(() => {});
  }
}

/* ── CI reports a submission here (via the project key / MCP) so SanchalanOS tracks it ── */

export const submitSchema = z.object({
  channelId: z.string().uuid(),
  track: z.string().trim().max(40),
  version: z.string().trim().max(60).nullish(),
  versionCode: z.string().trim().max(40).nullish(),
  status: z.enum(['uploaded', 'in_review', 'approved', 'rejected', 'live', 'halted']).default('in_review'),
});

export async function recordSubmission(ctx: RecordCtx, projectId: string, input: z.infer<typeof submitSchema>) {
  await projectAccess(ctx, projectId, 'member');
  const r = await ctx.tx.one<{ id: string }>(
    `update project_release_channels set store_track = $4, store_version = $5, store_version_code = $6, store_status = $7, store_checked_at = now(),
            status = case when $7 in ('live','approved') then 'done' else 'in_progress' end, done_at = case when $7 in ('live','approved') then now() else done_at end, updated_at = now()
      where tenant_id = $1 and project_id = $2 and id = $3 returning id`,
    [ctx.tenantId, projectId, input.channelId, input.track, input.version ?? null, input.versionCode ?? null, input.status],
  );
  if (!r) throw notFound('Release channel not found');
  return { ok: true, channelId: input.channelId, status: input.status };
}

export { PLAY_TRACKS, APPLE_TRACKS };
