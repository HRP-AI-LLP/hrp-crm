import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { hmacSha256Hex } from '../src/lib/crypto';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let me = '';
let repId = '';
const ids: Record<string, string> = {};

// ------------------------------------------------------------------ provider fakes
type Call = { method: string; url: string; headers: Headers; body: string };
const calls: Call[] = [];
type Handler = (c: Call) => Response | Promise<Response>;
const routes: [RegExp, Handler][] = [];
const on = (re: RegExp, fn: Handler) => routes.unshift([re, fn]);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
const sent = (re: RegExp) => calls.filter((c) => re.test(c.url));

const b64u = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const gmailMsg = (id: string, h: Record<string, string>, text: string, labelIds: string[] = ['INBOX']) => ({
  id,
  threadId: `t-${id}`,
  internalDate: String(Date.now() - 60_000),
  labelIds,
  payload: { mimeType: 'multipart/alternative', headers: Object.entries(h).map(([name, value]) => ({ name, value })), parts: [{ mimeType: 'text/plain', body: { data: b64u(text) } }] },
});
let inbox: ReturnType<typeof gmailMsg>[] = [];

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_integrations');
  Object.assign(h.env, {
    GOOGLE_CLIENT_ID: 'gid',
    GOOGLE_CLIENT_SECRET: 'gsecret',
    MS_CLIENT_ID: 'mid',
    MS_CLIENT_SECRET: 'msecret',
    META_APP_ID: 'fbapp',
    META_APP_SECRET: 'fb-app-secret',
    META_VERIFY_TOKEN: 'verify-me',
  });
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const who = (await api('GET', '/api/auth/me')).json;
  tenantId = who.tenant.id;
  me = who.user.id;
  repId = (await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rita Rep', password: PW, roles: ['sales_rep'] })).json.id;
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https:\/\/(oauth2\.googleapis|gmail\.googleapis|www\.googleapis|login\.microsoftonline|graph\.microsoft|graph\.facebook|api\.razorpay|api\.exotel|api\.in\.exotel)\.com/.test(url)) return realFetch(input, init);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === 'string' ? init.body : '';
    const c: Call = { method: init?.method ?? 'GET', url, headers: new Headers(init?.headers), body };
    calls.push(c);
    for (const [re, fn] of routes) if (re.test(`${c.method} ${url}`)) return fn(c);
    return json({ error: { message: `unmocked ${c.method} ${url}` } }, 404);
  });

  // Google
  on(/POST https:\/\/oauth2\.googleapis\.com\/token/, (c) =>
    new URLSearchParams(c.body).get('grant_type') === 'refresh_token' ? json({ access_token: 'g-access-2', expires_in: 3600 }) : json({ access_token: 'g-access', refresh_token: 'g-refresh', expires_in: 3600 }),
  );
  on(/GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/profile/, () => json({ emailAddress: 'Owner@Acme.test' }));
  on(/GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\?/, () => json({ messages: inbox.map((m) => ({ id: m.id, threadId: m.threadId })) }));
  on(/GET https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/[^?]+\?format=full/, (c) => {
    const id = /messages\/([^?]+)/.exec(c.url)![1];
    const m = inbox.find((x) => x.id === id);
    return m ? json(m) : json({}, 404);
  });
  on(/POST https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/, () => json({ id: 'sent-1', threadId: 't-sent' }));
  on(/POST https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/, () => json({ id: 'gcal-1' }));
  on(/PATCH https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/gcal-1/, () => json({ id: 'gcal-1' }));
  on(/DELETE https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events\/gcal-1/, () => new Response(null, { status: 204 }));
  // Razorpay
  on(/GET https:\/\/api\.razorpay\.com\/v1\/payment_links\?count=1/, (c) => (c.headers.get('authorization') === `Basic ${btoa('rzp_test_abcdef123:goodsecret')}` ? json({ items: [] }) : json({ error: { description: 'Authentication failed' } }, 401)));
  on(/POST https:\/\/api\.razorpay\.com\/v1\/payment_links$/, () => json({ id: 'plink_1', short_url: 'https://rzp.io/i/abc', status: 'created' }));
  on(/POST https:\/\/api\.razorpay\.com\/v1\/payment_links\/[^/]+\/cancel/, () => json({ status: 'cancelled' }));
  // Exotel
  on(/GET https:\/\/api\.exotel\.com\/v1\/Accounts\/acmesid\.json/, () => json({ Account: { Sid: 'acmesid' } }));
  on(/POST https:\/\/api\.exotel\.com\/v1\/Accounts\/acmesid\/Calls\/connect\.json/, () => json({ Call: { Sid: 'call-sid-1', Status: 'in-progress' } }));
  // Meta
  on(/GET https:\/\/graph\.facebook\.com\/v21\.0\/oauth\/access_token/, () => json({ access_token: 'fb-user-token', expires_in: 5_000_000 }));
  on(/GET https:\/\/graph\.facebook\.com\/v21\.0\/me\/accounts/, () => json({ data: [{ id: '1122334455667788', name: 'Acme Interiors', access_token: 'page-token' }] }));
  on(/POST https:\/\/graph\.facebook\.com\/v21\.0\/1122334455667788\/subscribed_apps/, () => json({ success: true }));
  on(/GET https:\/\/graph\.facebook\.com\/v21\.0\/lead-77\?/, () =>
    json({
      id: 'lead-77',
      platform: 'ig',
      form_id: 'form-9',
      campaign_name: 'Diwali modular kitchens',
      field_data: [
        { name: 'full_name', values: ['Meera Iyer'] },
        { name: 'email', values: ['MEERA@example.com'] },
        { name: 'phone_number', values: ['+91 98450 11111'] },
        { name: 'city', values: ['Bengaluru'] },
        { name: 'budget', values: ['3-5 lakh'] },
      ],
    }),
  );
  on(/GET https:\/\/graph\.facebook\.com\/v21\.0\/form-9\?/, () => json({ name: 'Kitchen enquiry form' }));
}, 90_000);
afterAll(() => vi.unstubAllGlobals());

describe('Gmail / Outlook mailbox', () => {
  it('connects through OAuth with a signed state and returns to the app', async () => {
    const st = await api('GET', '/api/v1/integrations/status');
    expect(st.json).toMatchObject({ mailbox: null, available: { google: true, microsoft: true, meta: true }, telephony: false, payments: false });
    const start = await api('POST', '/api/v1/integrations/oauth/google/start', { returnTo: '/account' });
    const u = new URL(start.json.url);
    expect(u.host).toBe('accounts.google.com');
    expect(u.searchParams.get('scope')).toContain('gmail.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    const state = u.searchParams.get('state')!;
    // a forged or altered state is refused
    expect((await h.call('GET', `/api/public/oauth/google/callback?code=abc&state=${encodeURIComponent(state.slice(0, -2) + 'aa')}`)).status).toBe(400);
    const cb = await h.call('GET', `/api/public/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { raw: true });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!);
    expect(back.pathname).toBe('/account');
    expect(back.searchParams.get('connected')).toBe('Owner@Acme.test');
    const mb = (await api('GET', '/api/v1/integrations/status')).json.mailbox;
    expect(mb).toMatchObject({ provider: 'google', account: 'owner@acme.test', status: 'active', config: { calendar: true } });
    expect(JSON.stringify(mb)).not.toContain('g-refresh');
    const row = (await sql(`select secret_ciphertext from integrations where provider = 'google'`))[0]!;
    expect(row.secret_ciphertext).toMatch(/^v1\./);
    // a colleague cannot connect the same mailbox
    const s2 = new URL((await rep('POST', '/api/v1/integrations/oauth/google/start', {})).json.url).searchParams.get('state')!;
    const cb2 = await h.call('GET', `/api/public/oauth/google/callback?code=abc&state=${encodeURIComponent(s2)}`, { raw: true });
    expect(new URL(cb2.headers.get('location')!).searchParams.get('error')).toContain('already connected');
  });

  it('logs mail with CRM contacts and leads once, ignoring colleagues and strangers', async () => {
    ids.contact = (await api('POST', '/api/v1/records/contact', { first_name: 'Ravi', last_name: 'Mehta', email: 'ravi@customer.test' })).json.id;
    ids.lead = (await api('POST', '/api/v1/records/lead', { last_name: 'Kapoor', email: 'anita@kapoor.test' })).json.id;
    inbox = [
      gmailMsg('m1', { From: 'Ravi Mehta <ravi@customer.test>', To: 'owner@acme.test', Subject: 'Revised kitchen layout', 'Message-ID': '<m1@customer.test>' }, 'Please share the new quote.\n\nOn Mon, someone wrote:\n> old text'),
      gmailMsg('m2', { From: 'owner@acme.test', To: 'anita@kapoor.test', Subject: 'Site visit on Friday', 'Message-ID': '<m2@acme.test>' }, 'See you at 11.', ['SENT']),
      gmailMsg('m3', { From: 'rep@acme.test', To: 'owner@acme.test', Subject: 'Internal', 'Message-ID': '<m3@acme.test>' }, 'colleague mail'),
      gmailMsg('m4', { From: 'news@shop.test', To: 'owner@acme.test', Subject: 'Sale!', 'Message-ID': '<m4@shop.test>' }, 'spam'),
    ];
    const r = await api('POST', '/api/v1/integrations/mailbox/sync');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ fetched: 4, logged: 2 });
    const tl = (await api('GET', `/api/v1/records/contact/${ids.contact}/timeline`)).json.items;
    const mail = tl.find((a: Json) => a.kind === 'email');
    expect(mail).toMatchObject({ subject: 'Revised kitchen layout', direction: 'in' });
    expect(mail.body).toBe('Please share the new quote.');
    const lt = (await api('GET', `/api/v1/records/lead/${ids.lead}/timeline`)).json.items;
    expect(lt.find((a: Json) => a.kind === 'email')).toMatchObject({ subject: 'Site visit on Friday', direction: 'out' });
    // syncing again logs nothing new
    expect((await api('POST', '/api/v1/integrations/mailbox/sync')).json.logged).toBe(0);
    expect((await sql(`select count(*)::int n from activities where kind = 'email'`))[0]!.n).toBe(2);
  });

  it('sends from the person’s own mailbox and does not log the synced copy twice', async () => {
    const r = await api('POST', `/api/v1/records/contact/${ids.contact}/send-email`, { to: 'ravi@customer.test', subject: 'Quote attached', body: 'Hi Ravi — here it is.' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const send = sent(/messages\/send/).at(-1)!;
    const raw = atob(JSON.parse(send.body).raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(raw).toContain('From: owner@acme.test');
    expect(raw).toContain('To: ravi@customer.test');
    const msgId = /Message-ID: (<[^>]+>)/.exec(raw)![1]!;
    expect((await sql(`select status, mailbox_id is not null as mb, external_id from messages where id = $1`, [r.json.messageId]))[0]).toMatchObject({ status: 'sent', mb: true, external_id: msgId });
    // Gmail later returns the sent message in a sync: recognised by its Message-ID
    inbox = [gmailMsg('s1', { From: 'owner@acme.test', To: 'ravi@customer.test', Subject: 'Quote attached', 'Message-ID': msgId }, 'Hi Ravi — here it is.', ['SENT'])];
    expect((await api('POST', '/api/v1/integrations/mailbox/sync')).json.logged).toBe(0);
    const emails = (await api('GET', `/api/v1/records/contact/${ids.contact}/timeline`)).json.items.filter((a: Json) => a.kind === 'email');
    expect(emails.filter((a: Json) => a.subject === 'Quote attached')).toHaveLength(1);
  });

  it('mirrors CRM events into the owner’s calendar', async () => {
    const start = new Date(Date.now() + 86400_000).toISOString();
    const ev = await api('POST', '/api/v1/events', { title: 'Measurement at Mehta home', kind: 'site_visit', startsAt: start, endsAt: new Date(Date.parse(start) + 3600_000).toISOString(), location: 'Andheri' });
    expect(ev.status, JSON.stringify(ev.json)).toBe(201);
    const create = sent(/calendar\/v3\/calendars\/primary\/events$/).at(-1)!;
    expect(JSON.parse(create.body)).toMatchObject({ summary: 'Measurement at Mehta home', location: 'Andheri' });
    expect((await sql(`select calendar_ref from events where id = $1`, [ev.json.id]))[0]!.calendar_ref).toMatchObject({ id: 'gcal-1' });
    await api('PATCH', `/api/v1/events/${ev.json.id}`, { title: 'Measurement (moved)' });
    expect(JSON.parse(sent(/events\/gcal-1/).at(-1)!.body).summary).toBe('Measurement (moved)');
    await api('DELETE', `/api/v1/events/${ev.json.id}`);
    expect(sent(/events\/gcal-1/).at(-1)!.method).toBe('DELETE');
  });

  it('flags the mailbox when Google revokes access, and disconnecting removes it', async () => {
    on(/POST https:\/\/oauth2\.googleapis\.com\/token/, () => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
    await sql(`update integrations set secret_ciphertext = $1 where provider = 'google'`, [(await sql(`select secret_ciphertext from integrations where provider = 'google'`))[0]!.secret_ciphertext]);
    // force a refresh by expiring the cached access token
    const db = Db.fromEnv(h.env);
    try {
      const { sealSecret } = await import('../src/services/integrations');
      const sealed = await sealSecret(h.env, tenantId, { accessToken: 'old', refreshToken: 'g-refresh', expiresAt: 0 });
      await db.tx({ tenantId }, (tx) => tx.query(`update integrations set secret_ciphertext = $1 where provider = 'google'`, [sealed]));
    } finally {
      await db.close();
    }
    await api('POST', '/api/v1/integrations/mailbox/sync');
    const mb = (await api('GET', '/api/v1/integrations/status')).json.mailbox;
    expect(mb.status).toBe('error');
    expect(mb.lastError).toContain('reconnect');
    expect((await api('DELETE', '/api/v1/integrations/mailbox')).status).toBe(204);
    expect((await api('GET', '/api/v1/integrations/status')).json.mailbox).toBeNull();
    expect(sent(/oauth2\.googleapis\.com\/revoke/).length).toBe(1);
  });
});

describe('Outlook (Microsoft 365)', () => {
  it('connects, syncs Graph mail and sends through a draft so the copy is recognised', async () => {
    on(/POST https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/token/, () => json({ access_token: 'ms-access', refresh_token: 'ms-refresh', expires_in: 3600 }));
    on(/GET https:\/\/graph\.microsoft\.com\/v1\.0\/me\?/, () => json({ mail: 'rita@acme.test', userPrincipalName: 'rita@acme.onmicrosoft.com' }));
    on(/GET https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\?/, (c) => {
      expect(c.headers.get('prefer')).toContain('text');
      return json({
        value: [
          { id: 'g1', conversationId: 'conv1', internetMessageId: '<g1@kapoor.test>', subject: 'Re: Site visit', from: { emailAddress: { address: 'anita@kapoor.test' } }, toRecipients: [{ emailAddress: { address: 'rita@acme.test' } }], receivedDateTime: new Date().toISOString(), body: { contentType: 'text', content: 'Friday works.' } },
          { id: 'g2', isDraft: true, subject: 'draft', from: { emailAddress: { address: 'rita@acme.test' } }, toRecipients: [{ emailAddress: { address: 'anita@kapoor.test' } }] },
        ],
      });
    });
    on(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages$/, () => json({ id: 'draft-1', internetMessageId: '<draft-1@outlook.test>' }, 201));
    on(/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\/draft-1\/send/, () => new Response(null, { status: 202 }));
    await api('PATCH', `/api/v1/records/lead/${ids.lead}`, { owner_id: repId });
    const state = new URL((await rep('POST', '/api/v1/integrations/oauth/microsoft/start', {})).json.url).searchParams.get('state')!;
    const cb = await h.call('GET', `/api/public/oauth/microsoft/callback?code=ms-code&state=${encodeURIComponent(state)}`, { raw: true });
    expect(new URL(cb.headers.get('location')!).searchParams.get('connected')).toBe('rita@acme.test');
    expect((await rep('POST', '/api/v1/integrations/mailbox/sync')).json).toEqual({ fetched: 1, logged: 1 });
    const r = await rep('POST', `/api/v1/records/lead/${ids.lead}/send-email`, { to: 'anita@kapoor.test', subject: 'Re: Site visit', body: 'See you then.' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const draft = JSON.parse(sent(/graph\.microsoft\.com\/v1\.0\/me\/messages$/).at(-1)!.body);
    expect(draft).toMatchObject({ subject: 'Re: Site visit', toRecipients: [{ emailAddress: { address: 'anita@kapoor.test' } }] });
    expect((await sql(`select external_id from messages where id = $1`, [r.json.messageId]))[0]!.external_id).toBe('<draft-1@outlook.test>');
    expect((await sql(`select 1 from external_refs where external_id = '<draft-1@outlook.test>'`)).length).toBe(1);
  });
});

describe('Razorpay payment links', () => {
  it('only admins connect it; bad keys are refused', async () => {
    expect((await rep('POST', '/api/admin/integrations/razorpay', { keyId: 'rzp_test_abcdef123', keySecret: 'goodsecret', webhookSecret: 'whsecret123' })).status).toBe(403);
    const bad = await api('POST', '/api/admin/integrations/razorpay', { keyId: 'rzp_test_abcdef123', keySecret: 'wrongsecret', webhookSecret: 'whsecret123' });
    expect(bad.status).toBe(400);
    const ok = await api('POST', '/api/admin/integrations/razorpay', { keyId: 'rzp_test_abcdef123', keySecret: 'goodsecret', webhookSecret: 'whsecret123' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.label).toBe('Razorpay (test mode)');
    expect(ok.json.urls.webhook).toMatch(/\/api\/public\/hooks\/razorpay\/[0-9a-f]{36}$/);
    ids.rzpHook = new URL(ok.json.urls.webhook).pathname;
    expect(JSON.stringify(ok.json)).not.toContain('goodsecret');
  });

  it('creates a link for an issued invoice and records the receipt from the signed webhook — once', async () => {
    for (const a of ['orders', 'billing']) await api('POST', `/api/admin/apps/${a}/enable`);
    await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Acme Interiors', state: 'Maharashtra' } } });
    await api('PUT', '/api/admin/billing/settings', { upiVpa: 'acme@okhdfcbank', upiPayee: 'Acme Interiors' });
    const acc = (await api('POST', '/api/v1/records/account', { name: 'Mehta Residence', state: 'Maharashtra', phone: '+91 98200 12345' })).json.id;
    await api('POST', '/api/v1/records/contact', { first_name: 'Ravi', last_name: 'M', email: 'ravi2@customer.test', phone: '+91 98200 12345', account_id: acc });
    const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Kitchen', account_id: acc })).json.id;
    await api('PUT', `/api/v1/invoices/${inv}/lines`, { lines: [{ name: 'Modular kitchen', quantity: 1, unitPrice: 10000, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/invoices/${inv}/issue`)).status).toBe(200);
    const full = (await api('GET', `/api/v1/invoices/${inv}`)).json;
    expect(full.upi).toMatchObject({ vpa: 'acme@okhdfcbank', amount: 11800 });

    expect((await api('POST', '/api/v1/payment-links', { invoiceId: inv, amount: 20000 })).status).toBe(400);
    const l = await api('POST', '/api/v1/payment-links', { invoiceId: inv });
    expect(l.status, JSON.stringify(l.json)).toBe(201);
    expect(l.json).toMatchObject({ url: 'https://rzp.io/i/abc', amount: 11800 });
    const req = JSON.parse(sent(/POST https:\/\/api\.razorpay\.com\/v1\/payment_links$/.source ? /api\.razorpay\.com\/v1\/payment_links$/ : /x/).at(-1)!.body);
    expect(req).toMatchObject({ amount: 1180000, currency: 'INR', customer: { name: 'Mehta Residence', contact: '+919820012345' }, notify: { sms: true } });

    const event = {
      event: 'payment_link.paid',
      payload: { payment_link: { entity: { id: 'plink_1', status: 'paid' } }, payment: { entity: { id: 'pay_XYZ', amount: 1180000, method: 'upi', vpa: 'ravi@okicici' } } },
    };
    const raw = JSON.stringify(event);
    // unsigned or wrongly signed deliveries are rejected
    expect((await h.call('POST', ids.rzpHook!, { body: event, headers: { 'x-razorpay-signature': 'nope' } })).status).toBe(401);
    const sig = await hmacSha256Hex('whsecret123', raw);
    const hook = await h.app.request(`http://synapse.test${ids.rzpHook}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig } }, h.env);
    expect(hook.status).toBe(200);
    // Razorpay retries: the same payment is not recorded twice
    await h.app.request(`http://synapse.test${ids.rzpHook}`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig } }, h.env);
    const after = (await api('GET', `/api/v1/invoices/${inv}`)).json;
    expect(after.invoice).toMatchObject({ status: 'paid', balance_due: 0 });
    expect(after.payments).toHaveLength(1);
    expect(after.payments[0]).toMatchObject({ amount: 11800 });
    expect(after.upi).toBeNull();
    const links = (await api('GET', `/api/v1/payment-links?invoiceId=${inv}`)).json.items;
    expect(links[0]).toMatchObject({ status: 'paid', amount_paid: 11800 });
    expect((await api('POST', `/api/v1/payment-links/${links[0].id}/cancel`)).status).toBe(400);
  });
});

describe('telephony (Exotel)', () => {
  it('click-to-call rings the agent first and the status callback completes the log', async () => {
    const cfg = await api('POST', '/api/admin/integrations/exotel', { sid: 'acmesid', apiKey: 'k1234', apiToken: 't1234', callerId: '08047112233' });
    expect(cfg.status, JSON.stringify(cfg.json)).toBe(201);
    ids.exoStatus = new URL(cfg.json.urls.status).pathname;
    ids.exoIncoming = new URL(cfg.json.urls.incoming).pathname;
    expect((await api('POST', '/api/v1/telephony/call', { object: 'contact', id: ids.contact })).status).toBe(400); // no own phone yet
    expect((await api('PUT', '/api/v1/me/phone', { phone: '+91 99000 00001' })).status).toBe(200);
    expect((await api('POST', '/api/v1/telephony/call', { object: 'contact', id: ids.contact })).status).toBe(400); // contact has no phone
    await api('PATCH', `/api/v1/records/contact/${ids.contact}`, { phone: '98450 22222' });
    const call = await api('POST', '/api/v1/telephony/call', { object: 'contact', id: ids.contact });
    expect(call.status, JSON.stringify(call.json)).toBe(201);
    const req = new URLSearchParams(sent(/Calls\/connect/).at(-1)!.body);
    expect(req.get('From')).toBe('+919900000001');
    expect(req.get('To')).toBe('09845022222');
    expect(req.get('CallerId')).toBe('08047112233');
    expect(req.get('StatusCallback')).toContain(ids.exoStatus);
    const st = await h.call('POST', ids.exoStatus!, { body: { CallSid: 'call-sid-1', Status: 'completed', ConversationDuration: 125, RecordingUrl: 'https://recordings.exotel.com/x.mp3' } });
    expect(st.status).toBe(200);
    const act = (await api('GET', `/api/v1/records/contact/${ids.contact}/timeline`)).json.items.find((a: Json) => a.kind === 'call');
    expect(act).toMatchObject({ direction: 'out', body: 'Connected · 2m 5s' });
    expect(act.metadata).toMatchObject({ status: 'completed', durationSeconds: 125, recordingUrl: 'https://recordings.exotel.com/x.mp3' });
    // status for a call this workspace did not place is ignored
    await h.call('POST', ids.exoStatus!, { body: { CallSid: 'someone-else', Status: 'completed' } });
  });

  it('logs incoming calls; unknown callers become leads and missed calls create a call-back task', async () => {
    const r = await h.call('GET', `${ids.exoIncoming}?CallSid=in-1&CallFrom=09845022222&CallTo=08047112233&DialCallStatus=completed&DialCallDuration=40`);
    expect(r.status).toBe(200);
    const tl = (await api('GET', `/api/v1/records/contact/${ids.contact}/timeline`)).json.items.filter((a: Json) => a.kind === 'call' && a.direction === 'in');
    expect(tl).toHaveLength(1);
    await h.call('GET', `${ids.exoIncoming}?CallSid=in-2&CallFrom=07700900123&CallTo=08047112233&DialCallStatus=no-answer`);
    await h.call('GET', `${ids.exoIncoming}?CallSid=in-2&CallFrom=07700900123&CallTo=08047112233&DialCallStatus=no-answer`); // retry
    const leads = await sql(`select id, last_name, source, phone from leads where app.phone_key(phone) = '7700900123'`);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ source: 'phone_call', last_name: 'Caller 0123' });
    const tasks = await sql(`select title, priority from tasks where related_id = $1`, [leads[0]!.id]);
    expect(tasks).toEqual([{ title: 'Call back Caller 0123', priority: 'high' }]);
    // a bad route key is a 404
    expect((await h.call('GET', '/api/public/hooks/exotel/0123456789abcdef0123/incoming?CallSid=x&CallFrom=1')).status).toBe(404);
  });
});

describe('lead ads', () => {
  it('Facebook pages connect through OAuth and leadgen webhooks become leads (signed, once)', async () => {
    expect((await rep('POST', '/api/v1/integrations/oauth/meta/start', {})).status).toBe(403);
    const state = new URL((await api('POST', '/api/v1/integrations/oauth/meta/start', { returnTo: '/settings' })).json.url).searchParams.get('state')!;
    const cb = await h.call('GET', `/api/public/oauth/meta/callback?code=fb-code&state=${encodeURIComponent(state)}`, { raw: true });
    const back = new URL(cb.headers.get('location')!);
    expect(back.pathname).toBe('/settings');
    expect(back.searchParams.get('connected')).toBe('Acme Interiors');
    expect(sent(/1122334455667788\/subscribed_apps/)).toHaveLength(1);

    // webhook verification handshake
    expect((await h.call('GET', '/api/public/hooks/meta-leads?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42')).text).toBe('42');
    expect((await h.call('GET', '/api/public/hooks/meta-leads?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status).toBe(403);
    const payload = JSON.stringify({ object: 'page', entry: [{ id: '1122334455667788', changes: [{ field: 'leadgen', value: { leadgen_id: 'lead-77', page_id: '1122334455667788', form_id: 'form-9' } }] }] });
    expect((await h.app.request('http://synapse.test/api/public/hooks/meta-leads', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': 'sha256=bad' } }, h.env)).status).toBe(401);
    const sig = `sha256=${await hmacSha256Hex('fb-app-secret', payload)}`;
    for (let n = 0; n < 2; n++) {
      const r = await h.app.request('http://synapse.test/api/public/hooks/meta-leads', { method: 'POST', body: payload, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' } }, h.env);
      expect(r.status).toBe(200);
    }
    const leads = await sql(`select id, first_name, last_name, email, phone, source, source_detail from leads where lower(email) = 'meera@example.com'`);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ first_name: 'Meera', last_name: 'Iyer', source: 'instagram', phone: '+91 98450 11111' });
    expect(leads[0]!.source_detail).toContain('Kitchen enquiry form');
    const notes = await sql(`select body from activities where related_id = $1 and kind = 'note'`, [leads[0]!.id]);
    expect(notes[0]!.body).toContain('Budget: 3-5 lakh');
    expect(notes[0]!.body).toContain('City: Bengaluru');
  });

  it('Google Ads lead forms post to a per-workspace URL with a key; repeat enquiries attach to the existing lead', async () => {
    const g = await api('POST', '/api/admin/integrations/google-leads', { label: 'Search campaigns' });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const path = new URL(g.json.urls.webhook).pathname;
    const body = (lead: string, key: string, email = 'meera@example.com', phone = '+919845011111') => ({
      lead_id: lead,
      google_key: key,
      form_id: 123,
      campaign_id: 456,
      is_test: false,
      user_column_data: [
        { column_id: 'FULL_NAME', string_value: 'Meera Iyer' },
        { column_id: 'EMAIL', string_value: email },
        { column_id: 'PHONE_NUMBER', string_value: phone },
        { column_name: 'Which room?', column_id: 'room', string_value: 'Kitchen' },
      ],
    });
    expect((await h.call('POST', path, { body: body('g-1', 'wrong-key') })).status).toBe(401);
    expect((await h.call('POST', path, { body: body('g-1', g.json.key) })).status).toBe(200);
    // same person as the Instagram lead: no duplicate, a note on the existing lead
    expect((await sql(`select count(*)::int n from leads where lower(email) = 'meera@example.com'`))[0]!.n).toBe(1);
    const lead = (await sql(`select id from leads where lower(email) = 'meera@example.com'`))[0]!.id;
    const notes = await sql(`select subject, body from activities where related_id = $1 and subject = 'New ad enquiry'`, [lead]);
    expect(notes[0]!.body).toContain('Which room?: Kitchen');
    // a new person becomes a google_ads lead
    expect((await h.call('POST', path, { body: body('g-2', g.json.key, 'arjun@example.com', '+919811122233') })).status).toBe(200);
    expect((await sql(`select source from leads where email = 'arjun@example.com'`))[0]).toMatchObject({ source: 'google_ads' });
    // the key can be shown again to admins only
    expect((await api('GET', `/api/admin/integrations/${g.json.id}/key`)).json.key).toBe(g.json.key);
    expect((await rep('GET', `/api/admin/integrations/${g.json.id}/key`)).status).toBe(403);
    const list = (await api('GET', '/api/admin/integrations')).json.items;
    expect(list.map((i: Json) => i.provider).sort()).toEqual(['exotel', 'google_leads', 'meta_leads', 'microsoft', 'razorpay']);
    expect(list.find((i: Json) => i.provider === 'microsoft').userName).toBe('Rita Rep');
    expect(JSON.stringify(list)).not.toMatch(/page-token|goodsecret|k1234|t1234|ms-refresh/);
    void me;
    void repId;
  });
});
