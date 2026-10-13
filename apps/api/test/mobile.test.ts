import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { b64uDecode, b64uEncode, encryptPayload } from '../src/services/webpush';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let tenantId = '';
let me = '';

const ec = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function keyPair(alg: 'ECDH' | 'ECDSA') {
  const kp = (await crypto.subtle.generateKey(alg === 'ECDH' ? ec : { name: 'ECDSA', namedCurve: 'P-256' }, true, alg === 'ECDH' ? ['deriveBits'] : ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
  return { kp, pub: b64uEncode(pub), d: jwk.d! };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
const cat = (...a: Uint8Array[]) => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};

/** The browser side of RFC 8291: what a push service hands the service worker. */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, uaPub: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, ec, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, ua.privateKey, 256));
  const te = new TextEncoder();
  const ikm = await hkdf(auth, shared, cat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, k, ct));
  expect(plain[plain.length - 1]).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
let respond = 201;
const realFetch = globalThis.fetch;
let vapid: Awaited<ReturnType<typeof keyPair>>;
let device: Awaited<ReturnType<typeof keyPair>>;
const authSecret = crypto.getRandomValues(new Uint8Array(16));

beforeAll(async () => {
  h = await makeHarness('synapse_test_mobile');
  vapid = await keyPair('ECDSA');
  device = await keyPair('ECDH');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const who = (await api('GET', '/api/auth/me')).json;
  tenantId = who.tenant.id;
  me = who.user.id;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://push.example.test/')) return realFetch(input, init);
    sent.push({ url, headers: new Headers(init?.headers), body: new Uint8Array(init?.body as ArrayBuffer) });
    return new Response(null, { status: respond });
  });
}, 90_000);
afterAll(() => vi.unstubAllGlobals());

describe('web push encryption', () => {
  it('round-trips through the RFC 8291 browser-side decryption', async () => {
    const msg = JSON.stringify({ title: 'Follow up with Ravi', body: 'Due 11:00', link: '/o/lead/1' });
    const body = await encryptPayload(new TextEncoder().encode(msg), device.pub, b64uEncode(authSecret));
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(body, device.kp, b64uDecode(device.pub), authSecret)).toBe(msg);
  });
});

describe('push subscriptions', () => {
  it('is off without VAPID keys', async () => {
    const cfg = await api('GET', '/api/v1/push/config');
    expect(cfg.json).toMatchObject({ enabled: false, publicKey: null });
    const r = await api('POST', '/api/v1/push/subscriptions', { endpoint: 'https://push.example.test/a', keys: { p256dh: device.pub, auth: b64uEncode(authSecret) } });
    expect(r.status).toBe(400);
  });

  it('registers a device once per endpoint and refuses plain http', async () => {
    h.env.VAPID_PUBLIC_KEY = vapid.pub;
    h.env.VAPID_PRIVATE_KEY = vapid.d;
    h.env.VAPID_SUBJECT = 'mailto:ops@acme.test';
    const sub = { endpoint: 'https://push.example.test/a', keys: { p256dh: device.pub, auth: b64uEncode(authSecret) }, label: 'Pixel' };
    const a = await api('POST', '/api/v1/push/subscriptions', sub);
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    const b = await api('POST', '/api/v1/push/subscriptions', { ...sub, label: null });
    expect(b.json.id).toBe(a.json.id);
    expect((await api('POST', '/api/v1/push/subscriptions', { ...sub, endpoint: 'http://push.example.test/b' })).status).toBe(400);
    const cfg = (await api('GET', '/api/v1/push/config')).json;
    expect(cfg).toMatchObject({ enabled: true, publicKey: vapid.pub });
    expect(cfg.devices).toHaveLength(1);
    expect(cfg.devices[0]).toMatchObject({ label: 'Pixel', endpoint_host: 'push.example.test' });
    expect(JSON.stringify(cfg)).not.toContain(b64uEncode(authSecret));
  });

  it('pushes fresh notifications after a write, with a valid VAPID token, exactly once', async () => {
    sent.length = 0;
    await sql(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1, $2, 'task_due', 'Call Ravi', 'Due now', '/tasks')`, [tenantId, me]);
    await api('POST', '/api/v1/tasks', { title: 'anything' });
    expect(sent).toHaveLength(1);
    const p = sent[0]!;
    expect(p.headers.get('content-encoding')).toBe('aes128gcm');
    const payload = JSON.parse(await decrypt(p.body, device.kp, b64uDecode(device.pub), authSecret));
    expect(payload).toMatchObject({ title: 'Call Ravi', body: 'Due now', link: '/tasks', tag: 'task_due' });
    // VAPID: ES256 JWT for the push service origin, signed by the server key
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(p.headers.get('authorization')!)!;
    expect(m[2]).toBe(vapid.pub);
    const [hd, bd, sg] = m[1]!.split('.');
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(bd!)));
    expect(claims).toMatchObject({ aud: 'https://push.example.test', sub: 'mailto:ops@acme.test' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vapid.kp.publicKey, b64uDecode(sg!), new TextEncoder().encode(`${hd}.${bd}`));
    expect(ok).toBe(true);
    // already pushed → the next write sends nothing
    await api('POST', '/api/v1/tasks', { title: 'again' });
    expect(sent).toHaveLength(1);
  });

  it('drops a subscription the push service says is gone', async () => {
    respond = 410;
    await sql(`insert into notifications (tenant_id, user_id, kind, title) values ($1, $2, 'x', 'Gone')`, [tenantId, me]);
    await api('POST', '/api/v1/tasks', { title: 'trigger' });
    respond = 201;
    expect((await api('GET', '/api/v1/push/config')).json.devices).toHaveLength(0);
  });

  it('a user only removes their own devices', async () => {
    const sub = { endpoint: 'https://push.example.test/c', keys: { p256dh: device.pub, auth: b64uEncode(authSecret) } };
    const a = await api('POST', '/api/v1/push/subscriptions', sub);
    await api('POST', '/api/v1/push/unsubscribe', { endpoint: sub.endpoint });
    expect((await api('GET', '/api/v1/push/config')).json.devices).toHaveLength(0);
    expect(a.status).toBe(201);
  });
});

describe('field/today', () => {
  it('collects my tasks, follow-ups and today’s visits', async () => {
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 86400_000);
    await api('POST', '/api/v1/tasks', { title: 'Site measure', dueAt: new Date(start.getTime() + 3600_000).toISOString(), assigneeId: me });
    await api('POST', '/api/v1/tasks', { title: 'Next week', dueAt: new Date(end.getTime() + 5 * 86400_000).toISOString(), assigneeId: me });
    const lead = await api('POST', '/api/v1/records/lead', { last_name: 'Walkin', source: 'walk_in', next_follow_up_at: new Date(start.getTime() + 7200_000).toISOString() });
    expect(lead.status, JSON.stringify(lead.json)).toBe(201);
    const v = await api('POST', `/api/v1/records/lead/${lead.json.id}/activities`, { kind: 'visit', subject: 'Showroom visit', location: { lat: 28.6, lng: 77.2, accuracy: 12 } });
    expect(v.status).toBe(201);
    const r = await api('GET', `/api/v1/field/today?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(end.toISOString())}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.tasks.map((t: Json) => t.title)).toContain('Site measure');
    expect(r.json.tasks.map((t: Json) => t.title)).not.toContain('Next week');
    expect(r.json.followUps.map((l: Json) => l.id)).toContain(lead.json.id);
    expect(r.json.visits[0]).toMatchObject({ subject: 'Showroom visit' });
    expect(r.json.visits[0].metadata.location.lat).toBe(28.6);
    expect(r.json.installations).toEqual([]);
  });

  it('rejects wide ranges', async () => {
    const r = await api('GET', `/api/v1/field/today?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z`);
    expect(r.status).toBe(400);
  });
});

describe('assetlinks', () => {
  it('is empty until an Android app is configured', async () => {
    expect((await h.call('GET', '/.well-known/assetlinks.json')).json).toEqual([]);
    h.env.ANDROID_APP_ID = 'in.hrpai.synapse';
    h.env.ANDROID_CERT_SHA256 = 'AA:BB';
    const r = await h.call('GET', '/.well-known/assetlinks.json');
    expect(r.json[0].target).toEqual({ namespace: 'android_app', package_name: 'in.hrpai.synapse', sha256_cert_fingerprints: ['AA:BB'] });
  });
});
