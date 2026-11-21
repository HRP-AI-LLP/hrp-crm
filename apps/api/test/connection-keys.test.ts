/**
 * Settings → Connection keys: platform keys and a workspace's own keys set from the app, taking the
 * place of .env values for requests; encryption at rest; who may change them; tests and generators.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { forgetCachedKeys } from '../src/services/connection-keys';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let owner: ReturnType<typeof h.as>;
let other: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const realFetch = globalThis.fetch;
const seen: string[] = [];

async function platformRows() {
  const db = Db.fromEnv(h.env);
  try {
    return await db.platform<Json>(`select key, value_enc, value_plain from platform_settings order by key`);
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_connection_keys');
  // the first workspace is the platform's; the harness is a "local" server, so make it act like a real one
  h.env.APP_ENV = 'dev';
  await h.signup('acme', 'owner@acme.test');
  await h.signup('globex', 'owner@globex.test');
  owner = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  other = h.as('globex', (await h.login('globex', 'owner@globex.test')).token);
  await owner('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rita Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://oauth2.googleapis.com/token') {
      seen.push('google');
      const body = new URLSearchParams(String(init?.body));
      return json({ error: body.get('client_secret') === 'GOCSPX-right' ? 'invalid_grant' : 'invalid_client' }, 400);
    }
    if (url === 'https://api.resend.com/domains') return json({ data: [{ name: 'mail.acme.test', status: 'verified' }] });
    return realFetch(input, init);
  });
}, 120_000);

afterAll(() => vi.unstubAllGlobals());

describe('platform keys', () => {
  it('lets the first workspace’s owner manage them, nobody else', async () => {
    expect((await owner('GET', '/api/admin/connection-keys/me')).json.platformAdmin).toBe(true);
    expect((await other('GET', '/api/admin/connection-keys/me')).json.platformAdmin).toBe(false);
    expect((await other('GET', '/api/admin/connection-keys?scope=platform')).status).toBe(403);
    expect((await other('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GOOGLE_CLIENT_ID: '1-a.apps.googleusercontent.com' } })).status).toBe(403);
    expect((await rep('GET', '/api/admin/connection-keys?scope=workspace')).status).toBe(403);
    const list = (await owner('GET', '/api/admin/connection-keys?scope=platform')).json;
    expect(list.groups.map((g: Json) => g.id)).toEqual(expect.arrayContaining(['google', 'microsoft', 'zoom', 'github_app', 'meta', 'mail', 'ai', 'gst', 'push', 'turnstile', 'cloudflare', 'android']));
    expect(list.groups.find((g: Json) => g.id === 'google').status).toBe('off');
  });

  it('saves keys encrypted, uses them in place of .env, and removes them', async () => {
    expect((await owner('GET', '/api/admin/integrations')).json.available.google).toBe(false);
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GOOGLE_CLIENT_ID: 'not-a-client-id' } })).status).toBe(400);
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { NOT_A_KEY: 'x' } })).status).toBe(400);
    const r = await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-wrong' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const rows = await platformRows();
    expect(rows.find((x) => x.key === 'GOOGLE_CLIENT_ID')).toMatchObject({ value_plain: '1234-abc.apps.googleusercontent.com', value_enc: null });
    const secret = rows.find((x) => x.key === 'GOOGLE_CLIENT_SECRET')!;
    expect(secret.value_plain).toBeNull();
    expect(String(secret.value_enc)).toMatch(/^v1\./);
    expect(String(secret.value_enc)).not.toContain('GOCSPX');
    // now every workspace can connect Gmail (the OAuth start uses the saved client)
    expect((await owner('GET', '/api/admin/integrations')).json.available.google).toBe(true);
    expect((await other('GET', '/api/admin/integrations')).json.available.google).toBe(true);
    const g = (await owner('GET', '/api/admin/connection-keys?scope=platform')).json.groups.find((x: Json) => x.id === 'google');
    expect(g.status).toBe('ready');
    expect(g.fields.find((f: Json) => f.key === 'GOOGLE_CLIENT_SECRET')).toMatchObject({ source: 'here', value: '•••• rong' });
    // the test asks Google
    expect((await owner('POST', '/api/admin/connection-keys/test', { scope: 'platform', group: 'google' })).json.checks[0]).toMatchObject({ ok: false });
    await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GOOGLE_CLIENT_SECRET: 'GOCSPX-right' } });
    expect((await owner('POST', '/api/admin/connection-keys/test', { scope: 'platform', group: 'google' })).json.checks[0]).toMatchObject({ ok: true });
    // the audit trail names keys, never values
    const db = Db.fromEnv(h.env);
    try {
      const tid = (await owner('GET', '/api/auth/me')).json.tenant.id as string;
      const audit = await db.tx({ tenantId: tid }, (tx) => tx.query<Json>(`select changes from audit_logs where object_key = 'platform_keys'`));
      expect(JSON.stringify(audit)).toContain('GOOGLE_CLIENT_SECRET');
      expect(JSON.stringify(audit)).not.toContain('GOCSPX');
    } finally {
      await db.close();
    }
    // removing brings back the .env value (none here)
    await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GOOGLE_CLIENT_ID: null, GOOGLE_CLIENT_SECRET: '' } });
    expect((await owner('GET', '/api/admin/integrations')).json.available.google).toBe(false);
  });

  it('prefers the saved value over .env, and shows where each value comes from', async () => {
    h.env.RESEND_API_KEY = 're_fromenv123';
    h.env.MAIL_FROM = 'Acme <no-reply@mail.acme.test>';
    forgetCachedKeys();
    let mail = (await owner('GET', '/api/admin/connection-keys?scope=platform')).json.groups.find((x: Json) => x.id === 'mail');
    expect(mail.fields.find((f: Json) => f.key === 'RESEND_API_KEY')).toMatchObject({ source: 'env', value: '•••• v123' });
    expect(mail.status).toBe('ready');
    expect((await owner('POST', '/api/admin/connection-keys/test', { scope: 'platform', group: 'mail' })).json.checks[0]).toMatchObject({ ok: true });
    await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { MAIL_FROM: 'Synapse <hello@mail.acme.test>' } });
    mail = (await owner('GET', '/api/admin/connection-keys?scope=platform')).json.groups.find((x: Json) => x.id === 'mail');
    expect(mail.fields.find((f: Json) => f.key === 'MAIL_FROM')).toMatchObject({ source: 'here', value: 'Synapse <hello@mail.acme.test>' });
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { MAIL_FROM: 'nobody' } })).status).toBe(400);
    delete h.env.RESEND_API_KEY;
    delete h.env.MAIL_FROM;
  });

  it('generates VAPID pairs and random secrets, and checks them', async () => {
    const pair = (await owner('POST', '/api/admin/connection-keys/generate', { kind: 'vapid' })).json;
    expect(pair.VAPID_PUBLIC_KEY).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    expect(pair.VAPID_PRIVATE_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { ...pair, VAPID_SUBJECT: 'mailto:ops@acme.test' } })).status).toBe(200);
    expect((await owner('POST', '/api/admin/connection-keys/test', { scope: 'platform', group: 'push' })).json.checks[0]).toMatchObject({ ok: true });
    // web push is now on for everyone
    expect((await rep('GET', '/api/v1/push/config')).json).toMatchObject({ enabled: true, publicKey: pair.VAPID_PUBLIC_KEY });
    expect((await owner('POST', '/api/admin/connection-keys/generate', { kind: 'random' })).json.value).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { FCM_SERVICE_ACCOUNT: '{"type":"user"}' } })).status).toBe(400);
    expect((await owner('PUT', '/api/admin/connection-keys', { scope: 'platform', values: { GITHUB_APP_PRIVATE_KEY: 'hello' } })).status).toBe(400);
  });

  it('lists platform admins; once listed, only they may change keys', async () => {
    const me = (await owner('GET', '/api/auth/me')).json.user.id;
    const repId = (await rep('GET', '/api/auth/me')).json.user.id;
    expect((await owner('PUT', `/api/admin/platform-admins/${repId}`, { admin: true })).status).toBe(200);
    const list = (await owner('GET', '/api/admin/platform-admins')).json.items.map((i: Json) => i.user_id);
    expect(list.sort()).toEqual([me, repId].sort());
    expect((await owner('PUT', `/api/admin/platform-admins/${repId}`, { admin: false })).status).toBe(200);
    expect((await owner('PUT', `/api/admin/platform-admins/${me}`, { admin: false })).status).toBe(400);
    expect((await owner('GET', '/api/admin/connection-keys/me')).json.platformAdmin).toBe(true);
  });
});

describe('a workspace’s own keys', () => {
  it('uses its own GSP account for itself only', async () => {
    expect((await other('PUT', '/api/admin/connection-keys', { scope: 'workspace', values: { GOOGLE_CLIENT_ID: '1234-abc.apps.googleusercontent.com' } })).status).toBe(403);
    const ws = (await other('GET', '/api/admin/connection-keys?scope=workspace')).json;
    expect(ws.groups.map((g: Json) => g.id)).toEqual(['gst']);
    const save = await other('PUT', '/api/admin/connection-keys', { scope: 'workspace', values: { GSTINAPI_KEY: 'gak_globex_own', GSTINAPI_TEST_MODE: 'true' } });
    expect(save.status, JSON.stringify(save.json)).toBe(200);
    const g = (await other('GET', '/api/admin/connection-keys?scope=workspace')).json.groups[0];
    expect(g).toMatchObject({ ownKeys: true });
    expect(g.fields.find((f: Json) => f.key === 'GSTINAPI_KEY')).toMatchObject({ source: 'here' });
    for (const who of [owner, other]) for (const a of ['orders', 'billing']) await who('POST', `/api/admin/apps/${a}/enable`);
    const gsp = (who: typeof owner) => who('GET', '/api/v1/gst/connections');
    const theirs = await gsp(other);
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(200);
    expect(theirs.json.gsp).toMatchObject({ configured: true, id: 'gstinapi' });
    // acme has no GSP (neither platform nor own)
    expect((await gsp(owner)).json.gsp?.configured ?? false).toBe(false);
  });
});
