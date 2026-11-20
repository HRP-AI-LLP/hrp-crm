/**
 * Integrations backbone: connected accounts, encrypted credentials, signed OAuth state, OAuth
 * token exchange/refresh for Google, Microsoft and Meta, idempotency refs and outbound HTTP with
 * timeouts. Provider-specific behaviour lives in mail.ts, payments-online.ts, leadads.ts and
 * telephony.ts.
 */
import type { Env } from '../env';
import { b64url, decryptSecret, encryptSecret, hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Tx } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';

export type Provider = 'google' | 'microsoft' | 'razorpay' | 'exotel' | 'meta_leads' | 'google_leads' | 'tally' | 'teams' | 'slack' | 'gchat' | 'jira' | 'azure_devops' | 'asana' | 'dynamics_bc' | 'sap_b1' | 'netsuite' | 'zoom_meet' | 'google_meet' | 'ms_teams_meet' | 'github' | 'azure_repos';
export type OAuthProvider = 'google' | 'microsoft' | 'meta' | 'zoom' | 'gmeet' | 'msmeet';
/** Meeting apps a person connects with their own accounts (several each). */
export const MEETING_OAUTH = { zoom: 'zoom_meet', gmeet: 'google_meet', msmeet: 'ms_teams_meet' } as const;

export interface Integration {
  id: string;
  tenant_id: string;
  provider: Provider;
  user_id: string | null;
  label: string | null;
  account_ref: string;
  config: Record<string, any>;
  secret_ciphertext: string | null;
  status: 'active' | 'error' | 'disabled';
  route_key: string;
  sync_state: Record<string, any>;
  last_sync_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  error_count: number;
  created_by: string | null;
  created_at: string;
}

/** What the API may show about an integration (never secrets or the route key). */
export function publicView(i: Integration) {
  return {
    id: i.id,
    provider: i.provider,
    userId: i.user_id,
    label: i.label,
    account: i.account_ref,
    config: i.config,
    status: i.status,
    lastSyncAt: i.last_sync_at,
    lastEventAt: i.last_event_at,
    lastError: i.last_error,
    createdAt: i.created_at,
  };
}

export const META_GRAPH = 'https://graph.facebook.com/v21.0';

// ---------------------------------------------------------------------------------- secrets
export async function readSecret<T = Record<string, any>>(env: Env, i: Pick<Integration, 'secret_ciphertext' | 'tenant_id'>): Promise<T> {
  if (!i.secret_ciphertext) return {} as T;
  if (!env.DATA_ENCRYPTION_KEY) throw new Error('DATA_ENCRYPTION_KEY is not configured');
  return JSON.parse(await decryptSecret(env.DATA_ENCRYPTION_KEY, i.secret_ciphertext, i.tenant_id)) as T;
}
export async function sealSecret(env: Env, tenantId: string, value: Record<string, unknown>): Promise<string> {
  if (!env.DATA_ENCRYPTION_KEY) throw badRequest('This server has no DATA_ENCRYPTION_KEY, so credentials cannot be stored');
  return encryptSecret(env.DATA_ENCRYPTION_KEY, JSON.stringify(value), tenantId);
}

export async function getIntegration(tx: Tx, tenantId: string, id: string): Promise<Integration> {
  const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [tenantId, id]);
  if (!i) throw notFound('Integration not found');
  return i;
}
export async function activeOf(tx: Tx, tenantId: string, provider: Provider): Promise<Integration | null> {
  return tx.one<Integration>(`select * from integrations where tenant_id = $1 and provider = $2 and status = 'active' order by created_at limit 1`, [tenantId, provider]);
}
export async function mailboxOf(tx: Tx, tenantId: string, userId: string): Promise<Integration | null> {
  return tx.one<Integration>(
    `select * from integrations where tenant_id = $1 and user_id = $2 and provider in ('google', 'microsoft') and status = 'active' order by created_at limit 1`,
    [tenantId, userId],
  );
}

/** Records a provider failure; after repeated failures the integration is flagged for attention. */
export async function markError(tx: Tx, i: Integration, message: string, fatal = false) {
  await tx.query(
    `update integrations set last_error = $3, error_count = error_count + 1, status = case when $4 or error_count + 1 >= 10 then 'error' else status end where tenant_id = $1 and id = $2`,
    [i.tenant_id, i.id, message.slice(0, 1000), fatal],
  );
}
export async function markOk(tx: Tx, i: Integration, fields: { sync?: boolean; event?: boolean } = {}) {
  await tx.query(
    `update integrations set last_error = null, error_count = 0, status = case when status = 'error' then 'active' else status end,
            last_sync_at = case when $3 then now() else last_sync_at end, last_event_at = case when $4 then now() else last_event_at end
      where tenant_id = $1 and id = $2`,
    [i.tenant_id, i.id, !!fields.sync, !!fields.event],
  );
}

/** Idempotency: true the first time a provider id is seen, false afterwards. */
export async function claimRef(tx: Tx, tenantId: string, provider: string, externalId: string, objectKey: string, recordId: string): Promise<boolean> {
  const r = await tx.query(
    `insert into external_refs (tenant_id, provider, external_id, object_key, record_id) values ($1,$2,$3,$4,$5) on conflict do nothing returning record_id`,
    [tenantId, provider, externalId.slice(0, 400), objectKey, recordId],
  );
  return r.length > 0;
}
export async function refOf(tx: Tx, tenantId: string, provider: string, externalId: string): Promise<{ object_key: string; record_id: string } | null> {
  return tx.one(`select object_key, record_id from external_refs where tenant_id = $1 and provider = $2 and external_id = $3`, [tenantId, provider, externalId.slice(0, 400)]);
}

// ---------------------------------------------------------------------------------- HTTP
export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown = null,
  ) {
    super(message);
  }
}

/** JSON request to a provider with a timeout; errors carry the provider's message (secrets stripped). */
export async function providerFetch<T = any>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 15_000), redirect: 'manual' }).catch((e: Error) => {
    throw new ProviderError(`Could not reach ${new URL(url).hostname}: ${e.message}`, 0);
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      (typeof body === 'object' && body && (body.error_description || body.error?.message || body.error?.description || body.message || (typeof body.error === 'string' ? body.error : null))) ||
      `HTTP ${res.status}`;
    throw new ProviderError(String(msg).replace(/[A-Za-z0-9_-]{32,}/g, '…').slice(0, 300), res.status, body);
  }
  return body as T;
}

export const form = (o: Record<string, string | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) p.set(k, v);
  return p;
};

// ---------------------------------------------------------------------------------- OAuth
export interface OAuthState {
  t: string; // tenant id
  u: string; // user id
  p: OAuthProvider;
  o: string; // origin to return to
  r: string; // path to return to
  h: string; // hash of the browser-binding cookie set when the flow started
  e: number; // expiry (epoch seconds)
  n: string; // nonce
}

const stateKey = (env: Env) => `${env.JWT_SECRET}:oauth-state`;

export async function signState(env: Env, s: Omit<OAuthState, 'e' | 'n'>): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ ...s, e: Math.floor(Date.now() / 1000) + 600, n: crypto.randomUUID() })));
  return `${payload}.${await hmacSha256Hex(stateKey(env), payload)}`;
}
export async function verifyState(env: Env, state: string | undefined): Promise<OAuthState> {
  const [payload, sig] = (state ?? '').split('.');
  if (!payload || !sig || !timingSafeEqual(sig, await hmacSha256Hex(stateKey(env), payload))) throw badRequest('This sign-in link is not valid. Start again from Synapse.');
  const s = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as OAuthState;
  if (s.e < Date.now() / 1000) throw badRequest('This sign-in took too long. Start again from Synapse.');
  return s;
}

export function redirectUri(env: Env, requestUrl: string, provider: OAuthProvider) {
  const origin = env.APP_HOST ? `https://${env.APP_HOST}` : new URL(requestUrl).origin;
  return `${origin}/api/public/oauth/${provider}/callback`;
}

export function oauthConfigured(env: Env, p: OAuthProvider) {
  if (p === 'google' || p === 'gmeet') return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (p === 'microsoft' || p === 'msmeet') return !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
  if (p === 'zoom') return !!(env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
  return !!(env.META_APP_ID && env.META_APP_SECRET);
}

const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events'];
const MS_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send', 'Calendars.ReadWrite'];
// meetings: create Meet / Teams meetings in the calendar and read their transcripts afterwards
export const GMEET_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/meetings.space.readonly'];
export const MSMEET_SCOPES = ['offline_access', 'openid', 'email', 'User.Read', 'Calendars.ReadWrite', 'OnlineMeetings.ReadWrite', 'OnlineMeetingTranscript.Read.All'];
const META_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_metadata', 'pages_manage_ads', 'leads_retrieval', 'business_management'];

export function authorizeUrl(env: Env, p: OAuthProvider, redirect: string, state: string): string {
  if (!oauthConfigured(env, p)) throw badRequest(`${{ meta: 'Facebook', google: 'Google', gmeet: 'Google', microsoft: 'Microsoft', msmeet: 'Microsoft', zoom: 'Zoom' }[p]} sign-in is not set up on this server yet`);
  if (p === 'gmeet') {
    return `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: GMEET_SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account', state })}`;
  }
  if (p === 'msmeet') {
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${form({ client_id: env.MS_CLIENT_ID, redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: MSMEET_SCOPES.join(' '), prompt: 'select_account', state })}`;
  }
  if (p === 'zoom') {
    return `https://zoom.us/oauth/authorize?${form({ client_id: env.ZOOM_CLIENT_ID, redirect_uri: redirect, response_type: 'code', state })}`;
  }
  if (p === 'google') {
    return `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirect, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state })}`;
  }
  if (p === 'microsoft') {
    return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${form({ client_id: env.MS_CLIENT_ID, redirect_uri: redirect, response_type: 'code', response_mode: 'query', scope: MS_SCOPES.join(' '), prompt: 'select_account', state })}`;
  }
  return `https://www.facebook.com/v21.0/dialog/oauth?${form({ client_id: env.META_APP_ID, redirect_uri: redirect, state, scope: META_SCOPES.join(','), response_type: 'code' })}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // epoch ms
}

export async function exchangeCode(env: Env, p: OAuthProvider, code: string, redirect: string): Promise<TokenSet> {
  if (p === 'zoom') {
    const t = await providerFetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`)}` },
      body: form({ code, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  }
  if (p === 'msmeet') {
    const t = await providerFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      body: form({ code, client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code', scope: MSMEET_SCOPES.join(' ') }),
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  }
  if (p === 'google' || p === 'gmeet') {
    const t = await providerFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: form({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  }
  if (p === 'microsoft') {
    const t = await providerFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      body: form({ code, client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, redirect_uri: redirect, grant_type: 'authorization_code', scope: MS_SCOPES.join(' ') }),
    });
    return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  }
  // Meta: short-lived user token, then a long-lived one (≈60 days); page tokens derived from it don't expire
  const short = await providerFetch(`${META_GRAPH}/oauth/access_token?${form({ client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, redirect_uri: redirect, code })}`);
  const long = await providerFetch(`${META_GRAPH}/oauth/access_token?${form({ grant_type: 'fb_exchange_token', client_id: env.META_APP_ID, client_secret: env.META_APP_SECRET, fb_exchange_token: short.access_token })}`);
  return { accessToken: long.access_token, expiresAt: Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000 };
}

/** A fresh access token for a mailbox, refreshing (and persisting) it when it is about to expire. */
export async function mailboxToken(env: Env, tx: Tx, i: Integration): Promise<string> {
  const s = await readSecret<TokenSet>(env, i);
  if (s.accessToken && s.expiresAt - Date.now() > 120_000) return s.accessToken;
  if (!s.refreshToken) throw new ProviderError('The connection has no refresh token; reconnect the mailbox', 401);
  let t: any;
  try {
    t =
      i.provider === 'google'
        ? await providerFetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            body: form({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: s.refreshToken, grant_type: 'refresh_token' }),
          })
        : await providerFetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
            method: 'POST',
            body: form({ client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, refresh_token: s.refreshToken, grant_type: 'refresh_token', scope: MS_SCOPES.join(' ') }),
          });
  } catch (e) {
    if (e instanceof ProviderError && (e.status === 400 || e.status === 401)) {
      throw new ProviderError('Access was revoked or expired — reconnect this mailbox in My account', 401);
    }
    throw e;
  }
  const next: TokenSet = { accessToken: t.access_token, refreshToken: t.refresh_token ?? s.refreshToken, expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000 };
  await tx.query(`update integrations set secret_ciphertext = $3 where tenant_id = $1 and id = $2`, [i.tenant_id, i.id, await sealSecret(env, i.tenant_id, next as unknown as Record<string, unknown>)]);
  return next.accessToken;
}

/** Best-effort revocation when someone disconnects. */
export async function revokeTokens(env: Env, i: Integration) {
  try {
    const s = await readSecret<TokenSet & { pageToken?: string }>(env, i);
    if (i.provider === 'google' && (s.refreshToken || s.accessToken)) {
      await fetch(`https://oauth2.googleapis.com/revoke?${form({ token: s.refreshToken ?? s.accessToken })}`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    }
    if (i.provider === 'meta_leads' && s.pageToken) {
      await fetch(`${META_GRAPH}/${encodeURIComponent(i.account_ref)}/subscribed_apps?${form({ access_token: s.pageToken })}`, { method: 'DELETE', signal: AbortSignal.timeout(5000) });
    }
  } catch {
    /* the connection is removed on our side regardless */
  }
}
