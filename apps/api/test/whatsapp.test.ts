import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { Db } from '../src/lib/db';
import { docToken, readDocToken, waNumber } from '../src/services/whatsapp';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let accId = '';
let inboundKey = '';
const APP_SECRET = 'wa-app-secret';
type Call = { url: string; body: any };
const calls: Call[] = [];
let nextId = 1;
let failNext: string | null = null;
const realFetch = globalThis.fetch;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}
const sentTo = (to: string) => calls.filter((c) => c.url.endsWith('/123456/messages') && c.body.to === to);

async function inbound(payload: unknown) {
  const raw = JSON.stringify(payload);
  const r = await h.call('POST', `/api/public/inbound/${inboundKey}`, { body: payload, headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex(APP_SECRET, raw)}` } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
const waText = (from: string, id: string, text: string, name = 'Meera') => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id, type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text } }] } }] }],
});
const waStatus = (id: string, status: string, errors?: unknown[]) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '91', ...(errors ? { errors } : {}) }] } }] }] });

beforeAll(async () => {
  h = await makeHarness('synapse_test_whatsapp');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://graph.facebook.com/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body });
      if (url.includes('/message_templates') && (!init?.method || init.method === 'GET')) {
        return Response.json({
          data: [
            { id: 't1', name: 'diwali_offer', language: 'en', status: 'APPROVED', category: 'MARKETING', components: [{ type: 'BODY', text: 'Hi {{1}}, 20% off modular kitchens this Diwali!' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] }] },
            { id: 't2', name: 'order_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}, your order {{2}} is ready.' }] },
            { id: 't3', name: 'pending_one', language: 'hi', status: 'PENDING', category: 'MARKETING', components: [{ type: 'BODY', text: 'Namaste' }] },
          ],
        });
      }
      if (url.includes('/message_templates')) return Response.json({ id: 't9', status: 'PENDING', category: body.category });
      if (url.endsWith('/messages')) {
        if (failNext) {
          const m = failNext;
          failNext = null;
          return Response.json({ error: { message: m, code: 131026 } }, { status: 400 });
        }
        return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${nextId++}` }] });
      }
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('waco', 'owner@waco.test');
  api = h.as('waco', (await h.login('waco', 'owner@waco.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  await api('POST', '/api/admin/users', { email: 'rep@waco.test', fullName: 'Rohan Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('waco', (await h.login('waco', 'rep@waco.test')).token);
  const ch = await api('POST', '/api/admin/channels', { channel: 'whatsapp', name: 'Showroom WhatsApp', provider: 'meta_cloud', config: { phoneNumberId: '123456', wabaId: '99887766' }, secrets: { accessToken: 'EAAtoken', appSecret: APP_SECRET, verifyToken: 'vt' } });
  expect(ch.status).toBe(201);
  accId = ch.json.id;
  inboundKey = ch.json.inbound_key;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('templates', () => {
  it('syncs approved templates from WhatsApp Manager', async () => {
    const s = await api('POST', `/api/admin/whatsapp/${accId}/templates/sync`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.count).toBe(3);
    const t = await api('GET', '/api/v1/whatsapp/templates');
    expect(t.json.items.map((x: Json) => x.name).sort()).toEqual(['diwali_offer', 'order_update']);
    expect(t.json.items.find((x: Json) => x.name === 'order_update').variable_count).toBe(2);
  });
  it('submits new marketing templates with a Stop button and checks variables', async () => {
    expect((await api('POST', `/api/admin/whatsapp/${accId}/templates`, { name: 'bad', language: 'en', category: 'MARKETING', body: 'Hi {{2}}', examples: ['x'] })).status).toBe(400);
    const r = await api('POST', `/api/admin/whatsapp/${accId}/templates`, { name: 'site_visit', language: 'en', category: 'MARKETING', body: 'Hi {{1}}, visit our showroom', examples: ['Asha'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const sent = calls.filter((c) => c.url.endsWith('/99887766/message_templates') && c.body).at(-1)!;
    expect(JSON.stringify(sent.body.components)).toContain('Stop promotions');
  });
});

describe('shared inbox', () => {
  let convId = '';
  let leadId = '';
  it('an inbound message opens a conversation on a new lead, inside the 24-hour window', async () => {
    await inbound(waText('919811100001', 'wamid.in1', 'Do you make wardrobes?'));
    const list = await api('GET', '/api/v1/inbox');
    expect(list.json.items).toHaveLength(1);
    const c = list.json.items[0];
    expect(c).toMatchObject({ address: '919811100001', display_name: 'Meera', unread: 1, windowOpen: true, related_object: 'lead' });
    convId = c.id;
    leadId = c.related_id;
  });

  it('replies with free text inside the window; receipts move the message to read', async () => {
    const r = await api('POST', `/api/v1/inbox/${convId}/messages`, { text: 'Yes! Shall we visit your site?' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(sentTo('919811100001').at(-1)!.body).toMatchObject({ type: 'text', text: { body: 'Yes! Shall we visit your site?' } });
    const ext = (await sql(`select external_id from messages where id = $1`, [r.json.messageId]))[0]!.external_id;
    await inbound(waStatus(ext, 'delivered'));
    await inbound(waStatus(ext, 'read'));
    await inbound(waStatus(ext, 'delivered'));
    const m = (await sql(`select status, read_at from messages where id = $1`, [r.json.messageId]))[0]!;
    expect(m.status).toBe('read');
    expect(m.read_at).not.toBeNull();
    const conv = await api('GET', `/api/v1/inbox/${convId}`);
    expect(conv.json.messages.map((x: Json) => x.direction)).toEqual(['in', 'out']);
    expect(conv.json.first_response_at).not.toBeNull();
    // the reply is on the lead's timeline
    const tl = await api('GET', `/api/v1/records/lead/${leadId}/timeline`);
    expect(JSON.stringify(tl.json)).toContain('Shall we visit your site?');
  });

  it('outside the window only templates go out; marketing needs consent', async () => {
    await sql(`update conversations set last_inbound_at = now() - interval '2 days' where id = $1`, [convId]);
    expect((await api('POST', `/api/v1/inbox/${convId}/messages`, { text: 'Hello again' })).status).toBe(400);
    const tpls = (await api('GET', '/api/v1/whatsapp/templates')).json.items as Json[];
    const mkt = tpls.find((t) => t.name === 'diwali_offer')!;
    const util = tpls.find((t) => t.name === 'order_update')!;
    const noConsent = await api('POST', `/api/v1/inbox/${convId}/messages`, { templateId: mkt.id, values: ['Meera'] });
    expect(noConsent.status).toBe(400);
    expect(noConsent.json.error.message).toMatch(/consent/);
    const u = await api('POST', `/api/v1/inbox/${convId}/messages`, { templateId: util.id, values: ['Meera', 'SO-12'] });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    expect(sentTo('919811100001').at(-1)!.body.template).toMatchObject({ name: 'order_update', language: { code: 'en' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Meera' }, { type: 'text', text: 'SO-12' }] }] });
    await api('POST', `/api/v1/consent/lead/${leadId}`, { purpose: 'whatsapp', granted: true });
    expect((await api('POST', `/api/v1/inbox/${convId}/messages`, { templateId: mkt.id, values: ['Meera'] })).status).toBe(201);
  });

  it('a STOP reply opts the number out of marketing', async () => {
    await inbound(waText('919811100001', 'wamid.in2', 'STOP'));
    const tpls = (await api('GET', '/api/v1/whatsapp/templates')).json.items as Json[];
    const mkt = tpls.find((t) => t.name === 'diwali_offer')!;
    const r = await api('POST', `/api/v1/inbox/${convId}/messages`, { templateId: mkt.id, values: ['Meera'] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/opted out/);
    const consent = await api('GET', `/api/v1/consent/lead/${leadId}`);
    expect(consent.json.state.whatsapp.granted).toBe(false);
    // service messages still reach them while the window is open
    expect((await api('POST', `/api/v1/inbox/${convId}/messages`, { text: 'Understood, no more offers.' })).status).toBe(201);
  });

  it('people see only conversations about records they can see, or assigned to them', async () => {
    expect((await rep('GET', `/api/v1/inbox/${convId}`)).status).toBe(404);
    expect((await rep('GET', '/api/v1/inbox')).json.items).toHaveLength(0);
    const repId = (await sql(`select id from users where email = 'rep@waco.test'`))[0]!.id;
    expect((await rep('PATCH', `/api/v1/inbox/${convId}`, { assignedTo: repId })).status).toBe(404);
    expect((await api('PATCH', `/api/v1/inbox/${convId}`, { assignedTo: repId })).status).toBe(200);
    expect((await rep('GET', `/api/v1/inbox/${convId}`)).status).toBe(200);
    const notes = await sql(`select title from notifications where user_id = $1`, [repId]);
    expect(notes.some((n) => /gave you a conversation/.test(n.title))).toBe(true);
  });

  it('sends from a record and records provider failures in the thread', async () => {
    const lead = (await api('POST', '/api/v1/records/lead', { last_name: 'Iyer', phone: '98200 55555' })).json.id;
    await sql(`insert into conversations (tenant_id, channel_account_id, channel, address, last_inbound_at, related_object, related_id) values ($1,$2,'whatsapp','919820055555', now(), 'lead', $3)`, [tenantId, accId, lead]);
    failNext = 'Message undeliverable';
    const r = await api('POST', '/api/v1/whatsapp/send', { object: 'lead', id: lead, text: 'Hi' });
    expect(r.status).toBe(502);
    expect(r.json.error.message).toMatch(/undeliverable/);
    const st = await api('GET', `/api/v1/whatsapp/status?object=lead&id=${lead}`);
    expect(st.json).toMatchObject({ connected: true, windowOpen: true });
  });
});

describe('campaigns', () => {
  let campaignId = '';
  it('previews the audience with consent and opt-out reasons', async () => {
    const mk = async (name: string, phone: string, consent: boolean) => {
      const id = (await api('POST', '/api/v1/records/lead', { last_name: name, phone, company: 'Diwali list' })).json.id;
      if (consent) await api('POST', `/api/v1/consent/lead/${id}`, { purpose: 'marketing', granted: true });
      return id;
    };
    await mk('Arora', '9811200001', true);
    await mk('Bose', '9811200002', true);
    await mk('Chopra', '9811200003', false);
    await mk('Bose duplicate', '+91 98112 00002', true);
    const optedOut = await mk('Das', '9811200004', true);
    await api('POST', `/api/v1/consent/lead/${optedOut}`, { purpose: 'whatsapp', granted: false });
    const p = await api('POST', '/api/admin/campaigns/preview', { channel: 'whatsapp', audience: { object: 'lead', filters: [{ field: 'company', op: 'eq', value: 'Diwali list' }] } });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json).toMatchObject({ total: 5, eligible: 2, skipped: { no_consent: 1, duplicate: 1, opted_out: 1 } });
  });

  it('starts, sends the first batch and tracks the funnel', async () => {
    const tpl = ((await api('GET', '/api/v1/whatsapp/templates')).json.items as Json[]).find((t) => t.name === 'diwali_offer')!;
    const c = await api('POST', '/api/admin/campaigns', {
      name: 'Diwali 2026',
      channel: 'whatsapp',
      channelAccountId: accId,
      templateId: tpl.id,
      variables: [{ source: 'field', field: 'first_name', fallback: 'there' }],
      audience: { object: 'lead', filters: [{ field: 'company', op: 'eq', value: 'Diwali list' }] },
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    campaignId = c.json.id;
    expect((await rep('GET', '/api/admin/campaigns')).status).toBe(403);
    const s = await api('POST', `/api/admin/campaigns/${campaignId}/start`, {});
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const r = await api('GET', `/api/admin/campaigns/${campaignId}`);
    expect(r.json.campaign).toMatchObject({ status: 'sent', total: 4, sent: 2, skipped: 2 });
    expect(sentTo('919811200001').at(-1)!.body.template.components[0].parameters[0].text).toBe('there');
    const ext = (await sql(`select m.external_id from messages m where m.campaign_id = $1 and m.to_addr = '919811200002'`, [campaignId]))[0]!.external_id;
    await inbound(waStatus(ext, 'read'));
    await inbound(waText('919811200002', 'wamid.in3', 'Interested! Please call', 'Bose'));
    const r2 = await api('GET', `/api/admin/campaigns/${campaignId}`);
    expect(r2.json.campaign).toMatchObject({ delivered: 1, read: 1, replied: 1 });
    expect(r2.json.skipped.map((x: Json) => x.reason).sort()).toEqual(['no_consent', 'opted_out']);
    expect((await api('POST', `/api/admin/campaigns/${campaignId}/start`, {})).status).toBe(400);
  });

  it('utility campaigns still honour a WhatsApp opt-out; an interrupted send is never repeated', async () => {
    const tpl = ((await api('GET', '/api/v1/whatsapp/templates')).json.items as Json[]).find((t) => t.name === 'order_update')!;
    const c = await api('POST', '/api/admin/campaigns', {
      name: 'Order ready',
      channel: 'whatsapp',
      channelAccountId: accId,
      templateId: tpl.id,
      variables: [{ source: 'field', field: 'first_name', fallback: 'there' }, { source: 'text', value: 'SO-1' }],
      audience: { object: 'lead', filters: [{ field: 'company', op: 'eq', value: 'Diwali list' }] },
    });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const before = sentTo('919811200004').length;
    expect((await api('POST', `/api/admin/campaigns/${c.json.id}/start`, {})).status).toBe(200);
    const r = await api('GET', `/api/admin/campaigns/${c.json.id}`);
    // no consent is fine for a utility message, an opt-out is not
    expect(r.json.campaign).toMatchObject({ status: 'sent', sent: 3, skipped: 1 });
    expect(r.json.skipped).toEqual([{ reason: 'opted_out', n: 1 }]);
    expect(sentTo('919811200004').length).toBe(before);

    // a row claimed by a sender that died: failed, not resent
    const lead = (await sql(`select id from leads where phone = '9811200001'`))[0]!.id;
    await sql(`update campaigns set status = 'sending', finished_at = null where id = $1`, [c.json.id]);
    await sql(`delete from campaign_recipients where campaign_id = $1 and address = '919811200001'`, [c.json.id]);
    await sql(`insert into campaign_recipients (tenant_id, campaign_id, subject_object, subject_id, address, address_key, status, updated_at) values ($1,$2,'lead',$3,'919811200001','9811200001','sending', now() - interval '20 minutes')`, [tenantId, c.json.id, lead]);
    const n = sentTo('919811200001').length;
    const { campaignStep } = await import('../src/services/campaigns');
    const db = Db.fromEnv(h.env);
    try {
      await campaignStep(h.env as never, db, tenantId, c.json.id, 10, 'https://x.test');
    } finally {
      await db.close();
    }
    expect(sentTo('919811200001').length).toBe(n);
    const row = (await sql(`select status, error from campaign_recipients where campaign_id = $1 and address = '919811200001'`, [c.json.id]))[0]!;
    expect(row).toMatchObject({ status: 'failed', error: 'Interrupted while sending; not resent' });
    expect((await sql(`select status from campaigns where id = $1`, [c.json.id]))[0]!.status).toBe('sent');
  });
});

describe('documents', () => {
  it('signs expiring customer document links', async () => {
    const t = await docToken(h.env, tenantId, 'invoice', '01a154c8-3d24-744f-aae3-240e2c797055');
    expect(await readDocToken(h.env, t)).toMatchObject({ kind: 'invoice' });
    expect(await readDocToken(h.env, t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBeNull();
    expect((await h.call('GET', `/api/public/docs/${t}`)).status).toBe(404);
  });
  it('normalises Indian numbers for WhatsApp', () => {
    expect(waNumber('98200 55555')).toBe('919820055555');
    expect(waNumber('098200 55555')).toBe('919820055555');
    expect(waNumber('+44 7700 900123')).toBe('447700900123');
    expect(waNumber('123')).toBeNull();
  });
});
