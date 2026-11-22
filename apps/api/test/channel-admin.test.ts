/** Looking after a connected channel: edit, replace one credential, pause, check with Meta / Resend, subscribe, add a number, new inbound address. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const calls: { url: string; method: string; auth: string | null }[] = [];
let subscribed = false;
const realFetch = globalThis.fetch;
let wa = '';
let mail = '';

beforeAll(async () => {
  h = await makeHarness('synapse_test_channel_admin');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const auth = new Headers(init?.headers).get('authorization');
    if (url.startsWith('https://graph.facebook.com/') || url.startsWith('https://api.resend.com/')) calls.push({ url, method: init?.method ?? 'GET', auth });
    if (url.startsWith('https://graph.facebook.com/')) {
      if (auth === 'Bearer EXPIRED') return Response.json({ error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }, { status: 401 });
      if (url.includes('/111?fields=')) return Response.json({ id: '111', display_phone_number: '+91 98765 43210', verified_name: 'HRP AI', quality_rating: 'GREEN', name_status: 'APPROVED', platform_type: 'CLOUD_API' });
      if (url.includes('/222?fields=')) return Response.json({ id: '222', display_phone_number: '+91 90000 00002', verified_name: 'HRP AI Support', platform_type: 'CLOUD_API' });
      if (url.includes('/WABA1/phone_numbers')) return Response.json({ data: [{ id: '111', display_phone_number: '+91 98765 43210', verified_name: 'HRP AI' }, { id: '222', display_phone_number: '+91 90000 00002', verified_name: 'HRP AI Support' }] });
      if (url.endsWith('/WABA1/subscribed_apps')) {
        if (init?.method === 'POST') {
          subscribed = true;
          return Response.json({ success: true });
        }
        return Response.json({ data: subscribed ? [{ whatsapp_business_api_data: { id: 'app' } }] : [] });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    }
    if (url === 'https://api.resend.com/domains') return Response.json({ data: [{ name: 'hrpai.in', status: 'verified' }] });
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('chadm', 'owner@chadm.test');
  api = h.as('chadm', (await h.login('chadm', 'owner@chadm.test')).token);
  wa = (await api('POST', '/api/admin/channels', { channel: 'whatsapp', name: 'HRP WhatsApp Bot', provider: 'meta_cloud', config: { phoneNumberId: '111' }, secrets: { accessToken: 'EXPIRED', appSecret: 'sec', verifyToken: '' } })).json.id;
  mail = (await api('POST', '/api/admin/channels', { channel: 'email', name: 'Sales mail', provider: 'resend', config: { from: 'Sales <sales@hrpai.in>' }, secrets: { apiKey: 're_1' } })).json.id;
}, 120_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

const list = async () => (await api('GET', '/api/admin/channels')).json.items as Json[];
const check = async (id: string) => {
  const r = await api('POST', `/api/admin/channels/${id}/check`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
};

describe('channel upkeep', () => {
  it('shows which credentials are stored (never their values) and explains an expired token', async () => {
    const x = (await list()).find((c) => c.id === wa)!;
    expect(x.secretsSet.sort()).toEqual(['accessToken', 'appSecret']);
    expect(JSON.stringify(x)).not.toContain('EXPIRED');
    expect(x).not.toHaveProperty('secret_ciphertext');
    const r = await check(wa);
    expect(r.ok).toBe(false);
    const labels = Object.fromEntries(r.checks.map((c: Json) => [c.label, c]));
    expect(labels['Phone number']).toMatchObject({ ok: false, fix: 'token', detail: expect.stringContaining('System users') });
    expect(labels['Webhook verify token']).toMatchObject({ ok: false, fix: 'verify_token' });
    expect(labels['WhatsApp Business Account ID']).toMatchObject({ ok: false, fix: 'waba' });
  });

  it('replaces only the credentials given, edits settings, then checks clean after subscribing the app', async () => {
    const u = await api('PATCH', `/api/admin/channels/${wa}`, { name: 'HRP WhatsApp', config: { wabaId: 'WABA1' }, secrets: { accessToken: 'GOOD', appSecret: '', verifyToken: 'vt-1' } });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect((await list()).find((c) => c.id === wa)).toMatchObject({ name: 'HRP WhatsApp', config: { phoneNumberId: '111', wabaId: 'WABA1' }, secretsSet: expect.arrayContaining(['accessToken', 'appSecret', 'verifyToken']) });
    expect((await api('PATCH', `/api/admin/channels/${wa}`, { config: { phoneNumberId: '' } })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/channels/${wa}`, { secrets: { apiKey: 'x' } })).status).toBe(400);

    let r = await check(wa);
    const sub = r.checks.find((c: Json) => c.fix === 'subscribe');
    expect(sub).toBeTruthy();
    expect(r.numbers.map((n: Json) => [n.id, n.connectedAs])).toEqual([['111', 'HRP WhatsApp'], ['222', null]]);
    expect(calls.filter((c) => c.url.includes('graph.facebook.com')).at(-1)!.auth).toBe('Bearer GOOD');
    expect((await api('POST', `/api/admin/channels/${wa}/subscribe`)).status).toBe(200);
    r = await check(wa);
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect(r.info).toMatchObject({ displayPhone: '+91 98765 43210', quality: 'GREEN' });
    expect((await list()).find((c) => c.id === wa)!.config.check).toMatchObject({ ok: true, info: { verifiedName: 'HRP AI' } });
  });

  it('connects the account\'s other number with the same credentials, once', async () => {
    const a = await api('POST', `/api/admin/channels/${wa}/numbers`, { phoneNumberId: '222', name: 'HRP Support' });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect((await api('POST', `/api/admin/channels/${wa}/numbers`, { phoneNumberId: '222', name: 'Again' })).status).toBe(409);
    const r = await check(a.json.id);
    expect(r.ok, JSON.stringify(r.checks)).toBe(true);
    expect((await api('PATCH', `/api/admin/channels/${wa}`, { config: { phoneNumberId: '222' } })).status).toBe(409);
  });

  it('pauses and resumes, gives a new inbound address, and checks email', async () => {
    const before = (await list()).find((c) => c.id === wa)!.inboundUrl;
    expect((await api('PATCH', `/api/admin/channels/${wa}`, { status: 'disabled' })).status).toBe(200);
    expect((await check(wa)).checks.find((c: Json) => c.label === 'Status')).toMatchObject({ ok: false });
    await api('PATCH', `/api/admin/channels/${wa}`, { status: 'active' });
    const n = await api('POST', `/api/admin/channels/${wa}/inbound-address`);
    expect(n.json.inboundUrl).not.toBe(before);
    expect((await list()).find((c) => c.id === wa)!.inboundUrl).toBe(n.json.inboundUrl);
    const m = await check(mail);
    expect(m.checks.map((c: Json) => [c.label, c.ok])).toEqual([['Resend API key', true], ['Sending domain', true]]);
  });
});
