/** App-store publishing: connect Google Play, link a project to its app, read track status, and let CI record a submission. */
import { beforeAll, describe, expect, it } from 'vitest';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;

async function serviceAccountJson() {
  const kp = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  let b = '';
  for (const x of pkcs8) b += String.fromCharCode(x);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b).replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({ type: 'service_account', client_email: 'play@hrpai.iam.gserviceaccount.com', private_key: pem, token_uri: 'https://oauth2.googleapis.com/token' });
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_stores');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'PLAY_TOKEN', expires_in: 3600 });
    if (url.includes('/edits/') && url.includes('/tracks')) return Response.json({ tracks: [{ track: 'production', releases: [{ name: '1.0.0', versionCodes: ['3'], status: 'completed', userFraction: null }] }, { track: 'internal', releases: [{ name: '1.1.0-rc1', versionCodes: ['4'], status: 'draft' }] }] });
    if (url.endsWith('/edits') && (init?.method ?? 'GET') === 'POST') return Response.json({ id: 'EDIT1' });
    if (url.includes('/edits/') && (init?.method ?? 'GET') === 'DELETE') return new Response('', { status: 204 });
    return realFetch(input, init);
  }) as typeof fetch;

  await h.signup('ludo', 'owner@ludo.test');
  api = h.as('ludo', (await h.login('ludo', 'owner@ludo.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'LudoVerse', project_kind: 'in_house', product_type: 'mobile_game', billing_method: 'non_billable' })).json.id;
  await api('PATCH', `/api/v1/records/project/${ids.project}`, { status: 'active' });
  ids.release = (await api('POST', `/api/v1/projects/${ids.project}/agile/releases`, { name: '1.1.0', version: '1.1.0', releaseType: 'minor' })).json.id;
}, 120_000);

describe('Google Play', () => {
  it('connects a service account (validating it), and keeps the JSON secret', async () => {
    const bad = await api('POST', '/api/v1/stores', { kind: 'google_play', label: 'HRP Play', secret: '{"type":"service_account"}' });
    expect(bad.status).toBe(400);
    const r = await api('POST', '/api/v1/stores', { kind: 'google_play', label: 'HRP Play', secret: await serviceAccountJson() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.store = r.json.id;
    expect(r.json).toMatchObject({ kind: 'google_play', clientEmail: 'play@hrpai.iam.gserviceaccount.com' });
    const list = (await api('GET', '/api/v1/stores')).json.items as Json[];
    expect(list.find((s) => s.id === ids.store)).toMatchObject({ label: 'HRP Play' });
    expect(JSON.stringify(list)).not.toContain('private_key'); // the secret never comes back
  });

  it('links the project to its package and reads the live track status', async () => {
    const bad = await api('PUT', `/api/v1/projects/${ids.project}/store`, { connectionId: ids.store, appId: '', track: 'production' });
    expect(bad.status).toBe(400); // needs a package name
    const link = await api('PUT', `/api/v1/projects/${ids.project}/store`, { connectionId: ids.store, appId: 'in.hrpai.ludoverse', track: 'production' });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    expect(link.json).toMatchObject({ appId: 'in.hrpai.ludoverse', track: 'production', kind: 'google_play' });

    const st = (await api('GET', `/api/v1/projects/${ids.project}/store/status`)).json;
    expect(st.app).toBe('in.hrpai.ludoverse');
    expect(st.tracks.find((t: Json) => t.track === 'production')).toMatchObject({ versionName: '1.0.0', status: 'live', versionCodes: ['3'] });
    expect(st.tracks.find((t: Json) => t.track === 'internal')).toMatchObject({ versionName: '1.1.0-rc1', status: 'draft' });
  });

  it('CI records a store submission through the project key', async () => {
    const ch = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels`, { platform: 'android', method: 'play_store', target: 'production' });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const key = (await api('POST', `/api/v1/projects/${ids.project}/agent/keys`, { name: 'CI' })).json.key as string;
    const r = await h.call('POST', '/api/v1/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'store_submit', arguments: { channelId: ch.json.id, track: 'production', version: '1.1.0', versionCode: '5', status: 'in_review' } } },
      headers: { authorization: `Bearer ${key}` },
    });
    expect(r.status).toBe(200);
    expect(r.json.result.structuredContent).toMatchObject({ ok: true, status: 'in_review' });
    const saved = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}`)).json.channels.find((c: Json) => c.id === ch.json.id);
    expect(saved).toMatchObject({ store_status: 'in_review', store_version: '1.1.0', store_version_code: '5', store_track: 'production' });
  });
});
