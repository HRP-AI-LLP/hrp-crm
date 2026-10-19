/**
 * Native push to the Android app through Firebase Cloud Messaging (HTTP v1).
 *
 * The Worker holds a Google service account (secret FCM_SERVICE_ACCOUNT, the JSON key file).
 * It signs a short JWT (RS256), trades it for an access token (cached until shortly before it
 * expires) and sends one message per device token.
 */
import type { Env } from '../env';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cached: { token: string; exp: number; email: string } | null = null;

export function fcmEnabled(env: Env) {
  return !!env.FCM_SERVICE_ACCOUNT;
}

function account(env: Env): ServiceAccount {
  const a = JSON.parse(env.FCM_SERVICE_ACCOUNT ?? '{}') as ServiceAccount;
  if (!a.project_id || !a.client_email || !a.private_key) throw new Error('FCM_SERVICE_ACCOUNT is not a service-account key');
  return a;
}

const b64u = (bytes: Uint8Array | string) => {
  const s = typeof bytes === 'string' ? bytes : String.fromCharCode(...bytes);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function signJwt(a: ServiceAccount, now: number) {
  const header = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64u(JSON.stringify({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const pem = a.private_key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (ch) => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`)));
  return `${header}.${claims}.${b64u(sig)}`;
}

async function accessToken(env: Env) {
  const a = account(env);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === a.client_email && cached.exp - 120 > now) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await signJwt(a, now) }),
    signal: AbortSignal.timeout(8000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !j.access_token) throw new Error(`FCM auth failed: ${j.error_description ?? res.status}`);
  cached = { token: j.access_token, exp: now + (j.expires_in ?? 3600), email: a.client_email };
  return cached.token;
}

export interface NativeMessage {
  title: string;
  body?: string | null;
  link?: string | null;
  tag?: string | null;
}

/** 'gone' means the app was uninstalled or the token rotated: forget the token. */
export async function sendNative(env: Env, token: string, msg: NativeMessage): Promise<'ok' | 'gone' | 'error'> {
  let bearer: string;
  try {
    bearer = await accessToken(env);
  } catch {
    return 'error';
  }
  const a = account(env);
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(8000),
    body: JSON.stringify({
      message: {
        token,
        notification: { title: msg.title.slice(0, 200), ...(msg.body ? { body: msg.body.slice(0, 500) } : {}) },
        data: { link: msg.link ?? '/', tag: msg.tag ?? 'synapse' },
        android: { priority: 'HIGH', notification: { channel_id: 'synapse', tag: msg.tag ?? undefined } },
      },
    }),
  }).catch(() => null);
  if (!res) return 'error';
  if (res.ok) return 'ok';
  const j = (await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } };
  const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status;
  // INVALID_ARGUMENT usually means our message was malformed, not that the token is dead: keep it
  return res.status === 404 || code === 'UNREGISTERED' ? 'gone' : 'error';
}

export function resetFcmCache() {
  cached = null;
}
