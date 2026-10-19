import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { resetFcmCache } from '../src/services/fcm';
import { dispatchPushTx } from '../src/services/webpush';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let tenantId = '';
let me = '';
const calls: { url: string; headers: Headers; body: string }[] = [];
let gone = false;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await makeHarness('synapse_test_native_push');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  h.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: 'synapse-test', client_email: 'push@synapse-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) });
  resetFcmCache();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') {
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      return Response.json({ access_token: 'ya29.test', expires_in: 3600 });
    }
    if (url.startsWith('https://fcm.googleapis.com/')) {
      calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body) });
      if (gone) return Response.json({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }, { status: 404 });
      return Response.json({ name: 'projects/synapse-test/messages/1' });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('pushco', 'owner@pushco.test');
  api = h.as('pushco', (await h.login('pushco', 'owner@pushco.test')).token);
  const who = (await api('GET', '/api/auth/me')).json;
  tenantId = who.tenant.id;
  me = who.user.id;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function dispatch() {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => dispatchPushTx(h.env, tx, tenantId));
  } finally {
    await db.close();
  }
}

describe('Android app notifications (FCM)', () => {
  it('registers the app and sends notifications through FCM HTTP v1', async () => {
    const cfg = await api('GET', '/api/v1/push/config');
    expect(cfg.json.nativeEnabled).toBe(true);
    const r = await api('POST', '/api/v1/push/native', { token: 'fcm-token-abcdefghijklmnopqrstuvwxyz:APA91b', platform: 'android', label: 'Pixel' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const db = Db.fromEnv(h.env);
    await db.tx({ tenantId }, (tx) => tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'task','Call Mr Rao','Follow-up due','/o/lead')`, [tenantId, me]));
    await db.close();
    expect(await dispatch()).toBe(1);
    const auth = calls.find((c) => c.url.includes('oauth2'))!;
    const jwt = new URLSearchParams(auth.body).get('assertion')!;
    expect(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/synapse-test/messages:send');
    expect(send.headers.get('authorization')).toBe('Bearer ya29.test');
    expect(JSON.parse(send.body).message).toMatchObject({ token: 'fcm-token-abcdefghijklmnopqrstuvwxyz:APA91b', notification: { title: 'Call Mr Rao' }, data: { link: '/o/lead' } });
  });

  it('forgets tokens of uninstalled apps', async () => {
    gone = true;
    const t = await api('POST', '/api/v1/push/test');
    expect(t.json).toMatchObject({ devices: 1, sent: 0 });
    const db = Db.fromEnv(h.env);
    await db.tx({ tenantId }, (tx) => tx.query(`insert into notifications (tenant_id, user_id, kind, title) values ($1,$2,'task','Again')`, [tenantId, me]));
    await db.close();
    await dispatch();
    expect(((await api('GET', '/api/v1/push/config')).json.apps as Json[]).length).toBe(0);
  });
});
