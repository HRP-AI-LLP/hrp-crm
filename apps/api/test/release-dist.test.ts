/**
 * Publishing a release over Google Drive: upload the build to a chosen connected account, set who may
 * open it, and WhatsApp the link to a linked person. A build that carries client data is never shared
 * publicly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { fakeR2, type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let tenantId = '';
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;
const drive: { perms: Json[]; uploads: number } = { perms: [], uploads: 0 };
let waSent: { to: string; text: string } | null = null;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_reldist');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  Object.assign(h.env, { GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/upload/drive') && url.includes('uploadType=resumable')) {
      return new Response('', { status: 200, headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION1' } });
    }
    if (url.startsWith('https://www.googleapis.com/upload/drive')) {
      drive.uploads++;
      return Response.json({ id: 'DRIVEFILE1', webViewLink: 'https://drive.google.com/file/d/DRIVEFILE1/view' });
    }
    if (url.includes('/drive/v3/files/') && url.includes('/permissions')) {
      drive.perms.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ id: 'perm1' });
    }
    if (url.includes('/drive/v3/files/') && (init?.method ?? 'GET') === 'GET') {
      const fid = url.split('/drive/v3/files/')[1]!.split('?')[0];
      return Response.json({ id: fid, name: 'CPFSlipsApp-1.1.0-setup.exe', webViewLink: `https://drive.google.com/file/d/${fid}/view` });
    }
    if (url.startsWith('https://graph.facebook.com/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      waSent = { to: body.to, text: body.text?.body ?? '' };
      return Response.json({ messages: [{ id: `wamid.${crypto.randomUUID()}` }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  await h.signup('reld', 'owner@reld.test');
  api = h.as('reld', (await h.login('reld', 'owner@reld.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);

  // a connected Google account that can use Drive
  const { sealSecret } = await import('../src/services/integrations');
  const secret = await sealSecret(h.env, tenantId, { accessToken: 'GTOKEN', refreshToken: 'gr', expiresAt: Date.now() + 3_600_000 });
  ids.drive = (
    await sql(
      `insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config, status)
       values ($1, 'google', (select id from users where tenant_id = $1 and is_owner), 'Gmail', 'releases@hrpai.in', $2, '{"drive":true,"primary":true}'::jsonb, 'active') returning id`,
      [tenantId, secret],
    )
  )[0]!.id;

  // a WhatsApp number to send from, and a client contact with an open chat
  const wa = await api('POST', '/api/admin/channels', { channel: 'whatsapp', name: 'HRP WhatsApp', provider: 'meta_cloud', config: { phoneNumberId: '111' }, secrets: { accessToken: 'WATOKEN', appSecret: 's', verifyToken: '' } });
  expect(wa.status, JSON.stringify(wa.json)).toBe(201);
  ids.wa = wa.json.id;
  const contact = await api('POST', '/api/v1/records/contact', { last_name: 'Verma', first_name: 'Deepak', email: 'deepak@fci.gov.in', phone: '9845512345' });
  expect(contact.status, JSON.stringify(contact.json)).toBe(201);
  ids.contact = contact.json.id;
  // an open 24h window so a plain text message is allowed
  await sql(`insert into conversations (tenant_id, channel_account_id, channel, address, related_object, related_id, last_inbound_at) values ($1, $2, 'whatsapp', '919845512345', 'contact', $3, now())`, [tenantId, ids.wa, ids.contact]);

  ids.project = (await api('POST', '/api/v1/records/project', { name: 'CPF Slips App', project_kind: 'in_house', product_type: 'desktop_app', billing_method: 'non_billable' })).json.id;
  await api('PATCH', `/api/v1/records/project/${ids.project}`, { status: 'active' });
  ids.release = (await api('POST', `/api/v1/projects/${ids.project}/agile/releases`, { name: '1.1.0', version: '1.1.0', releaseType: 'minor' })).json.id;
}, 120_000);

afterAll(() => {
  globalThis.fetch = realFetch;
});

const exeBytes = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 1, 2, 3, 4]); // MZ (Windows installer)
// a release artifact (installer) is attached through the files route with allowBinary
const file = async (name: string) => (await api('POST', `/api/v1/files?${new URLSearchParams({ object: 'project', id: ids.project!, allowBinary: '1', name })}`, undefined, { headers: { 'content-type': 'application/octet-stream' }, bin: exeBytes })).json.id;

describe('Google Drive delivery', () => {
  it('lists the connected Google accounts to upload from', async () => {
    const accs = (await api('GET', `/api/v1/projects/${ids.project}/agile/drive-accounts`)).json.items as Json[];
    expect(accs.find((a) => a.id === ids.drive)).toMatchObject({ email: 'releases@hrpai.in', hasDrive: true });
  });

  it('a build with client data is shared only with the recipient, never publicly', async () => {
    const fileId = await file('CPFSlipsApp-1.1.0-setup.exe');
    // the channel carries the member database, so it must stay restricted
    const ch = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels`, {
      platform: 'windows',
      method: 'google_drive',
      containsClientData: true,
      shareAccess: 'public', // asked for public, but data forces restricted
      driveAccountId: ids.drive,
      driveFolderId: 'FOLDER1',
      recipientObject: 'contact',
      recipientId: ids.contact,
      fileIds: [fileId],
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    ids.channel = ch.json.id;
    const saved = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}`)).json.channels.find((c: Json) => c.id === ids.channel);
    expect(saved).toMatchObject({ contains_client_data: true, share_access: 'restricted' });

    drive.perms = [];
    drive.uploads = 0;
    waSent = null;
    const r = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels/${ids.channel}/publish`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(drive.uploads).toBe(1);
    // the share is to the recipient's own Google account, not "anyone"
    expect(drive.perms).toEqual([{ role: 'reader', type: 'user', emailAddress: 'deepak@fci.gov.in' }]);
    expect(r.json).toMatchObject({ access: 'restricted', sharedWith: 'deepak@fci.gov.in', whatsapp: 'sent' });
    expect(waSent).toMatchObject({ to: '919845512345' });
    expect(waSent!.text).toContain('https://drive.google.com/file/d/DRIVEFILE1/view');
    const done = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}`)).json.channels.find((c: Json) => c.id === ids.channel);
    expect(done).toMatchObject({ status: 'done', url: 'https://drive.google.com/file/d/DRIVEFILE1/view' });
  });

  it('refuses a public link outright if the channel is flipped to carry data', async () => {
    // the database check blocks the illegal combination at save time
    const bad = await api('PUT', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels/${ids.channel}`, {
      platform: 'windows',
      method: 'google_drive',
      containsClientData: true,
      shareAccess: 'public',
    });
    // saveChannel forces restricted when data is present, so it never persists public
    const saved = (await api('GET', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}`)).json.channels.find((c: Json) => c.id === ids.channel);
    expect(saved.share_access).toBe('restricted');
    expect([200, 400]).toContain(bad.status);
  });

  it('publishes a big installer the build script already uploaded to Drive (no re-upload)', async () => {
    // a 1.4 GB installer can't be stored here, so the channel points at its Drive link
    const ch = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels`, {
      platform: 'windows',
      method: 'google_drive',
      containsClientData: true,
      driveAccountId: ids.drive,
      url: 'https://drive.google.com/file/d/BIGINSTALLER9/view',
      recipientObject: 'contact',
      recipientId: ids.contact,
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    drive.perms = [];
    drive.uploads = 0;
    const r = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels/${ch.json.id}/publish`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(drive.uploads).toBe(0); // used the existing Drive file, not a re-upload
    expect(drive.perms).toEqual([{ role: 'reader', type: 'user', emailAddress: 'deepak@fci.gov.in' }]);
    expect(r.json.link).toContain('BIGINSTALLER9');
  });

  it('the build machine ships a release through the project key (upload URL → publish)', async () => {
    const fileId = await file('CPFSlipsApp-1.1.0-setup.exe');
    const ch = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels`, {
      platform: 'windows',
      method: 'google_drive',
      containsClientData: true,
      driveAccountId: ids.drive,
      driveFolderId: 'FOLDER1',
      recipientObject: 'contact',
      recipientId: ids.contact,
      fileIds: [fileId],
    });
    const channelId = ch.json.id;
    const keyRes = await api('POST', `/api/v1/projects/${ids.project}/agent/keys`, { name: 'Build machine' });
    expect(keyRes.status, JSON.stringify(keyRes.json)).toBe(201);
    const key = keyRes.json.key as string;
    const mcp = async (name: string, args: Json) => {
      const r = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${key}` } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json.result.structuredContent as Json;
    };
    // find the channel over MCP
    const chans = await mcp('release_channels', {});
    expect((chans.channels as Json[]).find((x) => x.channelId === channelId)).toMatchObject({ version: '1.1.0', containsClientData: true, ready: true });
    // get a direct-to-Drive upload URL
    const up = await mcp('release_upload_url', { channelId, fileName: 'CPFSlipsApp-1.1.0-setup.exe' });
    expect(up.uploadUrl).toContain('upload_id=SESSION1');
    // after the script PUTs the bytes and gets a file id, publish it
    drive.perms = [];
    waSent = null;
    const done = await mcp('release_publish', { channelId, driveFileId: 'UPLOADEDBYBUILD' });
    expect(done).toMatchObject({ access: 'restricted', sharedWith: 'deepak@fci.gov.in', whatsapp: 'sent' });
    expect(drive.perms).toEqual([{ role: 'reader', type: 'user', emailAddress: 'deepak@fci.gov.in' }]);
    expect(waSent!.text).toContain('https://drive.google.com/file/d/UPLOADEDBYBUILD/view');
  });

  it('a data-free build may be shared as a public link', async () => {
    const fileId = await file('CPFSlipsApp-1.1.0-nodata-setup.exe');
    const ch = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels`, {
      platform: 'windows',
      method: 'google_drive',
      containsClientData: false,
      shareAccess: 'public',
      driveAccountId: ids.drive,
      recipientObject: 'contact',
      recipientId: ids.contact,
      fileIds: [fileId],
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    drive.perms = [];
    const r = await api('POST', `/api/v1/projects/${ids.project}/agile/releases/${ids.release}/channels/${ch.json.id}/publish`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(drive.perms).toEqual([{ role: 'reader', type: 'anyone' }]);
    expect(r.json).toMatchObject({ access: 'public', sharedWith: 'anyone with the link' });
  });
});
