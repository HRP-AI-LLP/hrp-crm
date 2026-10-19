/**
 * Web Push from Workers with WebCrypto only:
 *   - VAPID (RFC 8292): ES256 JWT signed with the platform key pair
 *   - payload encryption aes128gcm (RFC 8188 / RFC 8291)
 *
 * Config: VAPID_PUBLIC_KEY (base64url, 65-byte uncompressed P-256 point), VAPID_PRIVATE_KEY
 * (base64url, 32-byte scalar) and VAPID_SUBJECT (mailto:…). Without them push is simply off.
 *
 * Delivery: notifications are written by SQL all over the code base; `dispatchPush` picks up the
 * fresh, unpushed ones for a workspace (after writes and on the 5-minute cron) and sends them.
 */
import type { Env } from '../env';
import { fcmEnabled, sendNative } from './fcm';
import type { Db, Tx } from '../lib/db';

const enc = new TextEncoder();

export function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export function b64uEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** Browser push services (the only hosts a subscription may point at). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/, /^updates\.push\.services\.mozilla\.com$/, /(^|\.)push\.services\.mozilla\.com$/];
export function isPushEndpoint(url: string, env?: Env): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
    if (env?.APP_ENV !== 'production' && u.hostname.endsWith('.example.test')) return true; // tests
    return PUSH_HOSTS.some((r) => r.test(u.hostname));
  } catch {
    return false;
  }
}

export function pushEnabled(env: Env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** ECDH params: workerd's types spell the peer key `$public`, the runtime (and Node) read `public`. */
const ecdh = (peer: CryptoKey) => ({ name: 'ECDH', public: peer, $public: peer }) as unknown as SubtleCryptoDeriveKeyAlgorithm;

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

/** aes128gcm-encrypts `payload` for one subscription (RFC 8291). */
export async function encryptPayload(payload: Uint8Array, p256dh: string, authSecret: string, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const uaPublic = b64uDecode(p256dh);
  const auth = b64uDecode(authSecret);
  const local = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', local.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh(uaKey), local.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // single record: payload followed by the 0x02 "last record" delimiter
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, ct);
}

async function vapidKey(env: Env): Promise<CryptoKey> {
  const pub = b64uDecode(env.VAPID_PUBLIC_KEY!);
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64uEncode(pub.slice(1, 33)), y: b64uEncode(pub.slice(33, 65)), d: env.VAPID_PRIVATE_KEY!, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export async function vapidAuthorization(env: Env, endpoint: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64uEncode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || 'mailto:info@hrpai.in' })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidKey(env), enc.encode(`${header}.${body}`));
  return `vapid t=${header}.${body}.${b64uEncode(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export interface PushMessage {
  title: string;
  body?: string | null;
  link?: string | null;
  tag?: string;
}

/** Sends one message; returns 'gone' when the subscription expired (404/410). */
export async function sendPush(env: Env, sub: { endpoint: string; p256dh: string; auth: string }, msg: PushMessage): Promise<'ok' | 'gone' | 'error'> {
  if (!isPushEndpoint(sub.endpoint, env)) return 'gone';
  const body = await encryptPayload(enc.encode(JSON.stringify(msg).slice(0, 3000)), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    signal: AbortSignal.timeout(5000),
    redirect: 'manual',
    method: 'POST',
    headers: { authorization: await vapidAuthorization(env, sub.endpoint), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'normal' },
    body,
  }).catch(() => null);
  if (!res) return 'error';
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'ok' : 'error';
}

/** Sends fresh notifications of one workspace to its users' devices (at most 50 per run). */
export async function dispatchPushTx(env: Env, tx: Tx, tenantId: string): Promise<number> {
  const due = await tx.query<{ id: string; user_id: string; title: string; body: string | null; link: string | null; kind: string }>(
    `update notifications n set pushed_at = now()
      where n.id in (select id from notifications where tenant_id = $1 and pushed_at is null and created_at > now() - interval '30 minutes' order by created_at limit 50)
      returning n.id, n.user_id, n.title, n.body, n.link, n.kind`,
    [tenantId],
  );
  if (!due.length || (!pushEnabled(env) && !fcmEnabled(env))) return 0;
  const users = [...new Set(due.map((d) => d.user_id))];
  let sent = 0;
  if (fcmEnabled(env)) sent += await dispatchNative(env, tx, tenantId, due, users);
  if (!pushEnabled(env)) return sent;
  const subs = await tx.query<{ id: string; user_id: string; endpoint: string; p256dh: string; auth: string }>(
    // only people who are still active and signed in somewhere: disabling someone, "sign out
    // everywhere" and password resets stop their phones from receiving workspace data
    `select s.id, s.user_id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
       join users u on u.tenant_id = s.tenant_id and u.id = s.user_id and u.status = 'active'
      where s.tenant_id = $1 and s.user_id = any($2::uuid[])
        and exists (select 1 from sessions x where x.tenant_id = s.tenant_id and x.user_id = s.user_id and x.revoked_at is null and x.expires_at > now())`,
    [tenantId, users],
  );
  for (const n of due) {
    for (const s of subs.filter((x) => x.user_id === n.user_id)) {
      const r = await sendPush(env, s, { title: n.title, body: n.body, link: n.link, tag: n.kind });
      if (r === 'gone') await tx.query(`delete from push_subscriptions where tenant_id = $1 and id = $2`, [tenantId, s.id]);
      else if (r === 'ok') {
        sent++;
        await tx.query(`update push_subscriptions set failures = 0, last_success_at = now() where tenant_id = $1 and id = $2`, [tenantId, s.id]);
      } else await tx.query(`update push_subscriptions set failures = failures + 1 where tenant_id = $1 and id = $2`, [tenantId, s.id]);
    }
  }
  // devices that keep failing are dropped
  await tx.query(`delete from push_subscriptions where tenant_id = $1 and failures >= 20`, [tenantId]);
  return sent;
}

export async function dispatchPush(env: Env, db: Db, tenantId: string): Promise<number> {
  return db.tx({ tenantId }, (tx) => dispatchPushTx(env, tx, tenantId));
}

/** The same notifications to the Android app (FCM), with the same "still signed in" rule. */
async function dispatchNative(env: Env, tx: Tx, tenantId: string, due: { user_id: string; title: string; body: string | null; link: string | null; kind: string }[], users: string[]) {
  const tokens = await tx.query<{ id: string; user_id: string; token: string }>(
    `select t.id, t.user_id, t.token from native_push_tokens t
       join users u on u.tenant_id = t.tenant_id and u.id = t.user_id and u.status = 'active'
      where t.tenant_id = $1 and t.user_id = any($2::uuid[])
        and exists (select 1 from sessions x where x.tenant_id = t.tenant_id and x.user_id = t.user_id and x.revoked_at is null and x.expires_at > now())`,
    [tenantId, users],
  );
  let sent = 0;
  for (const n of due) {
    for (const t of tokens.filter((x) => x.user_id === n.user_id)) {
      const r = await sendNative(env, t.token, { title: n.title, body: n.body, link: n.link, tag: n.kind });
      if (r === 'gone') await tx.query(`delete from native_push_tokens where tenant_id = $1 and id = $2`, [tenantId, t.id]);
      else if (r === 'ok') {
        sent++;
        await tx.query(`update native_push_tokens set failures = 0, last_success_at = now() where tenant_id = $1 and id = $2`, [tenantId, t.id]);
      } else await tx.query(`update native_push_tokens set failures = failures + 1 where tenant_id = $1 and id = $2`, [tenantId, t.id]);
    }
  }
  await tx.query(`delete from native_push_tokens where tenant_id = $1 and failures >= 20`, [tenantId]);
  return sent;
}
