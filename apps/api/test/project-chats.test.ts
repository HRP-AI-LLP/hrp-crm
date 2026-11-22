/** WhatsApp chats on projects: live 1:1 and group messages, exported chats, AI suggestions → work. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { Db } from '../src/lib/db';
import { chatSweep, parseChatExport, ruleProposals } from '../src/services/project-chats';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let viewer: ReturnType<typeof h.as>;
let tenantId = '';
let inboundKey = '';
const APP_SECRET = 'wa-app-secret';
const ids: Record<string, string> = {};
const graph: { url: string; body: any }[] = [];
let aiReply: string | null = null;
const realFetch = globalThis.fetch;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}
async function inbound(payload: unknown) {
  const raw = JSON.stringify(payload);
  const r = await h.call('POST', `/api/public/inbound/${inboundKey}`, { body: payload, headers: { 'x-hub-signature-256': `sha256=${await hmacSha256Hex(APP_SECRET, raw)}` } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
let n = 1;
const ts = () => String(Math.floor(Date.now() / 1000));
const waText = (from: string, text: string, name = 'Ravi Client') => ({ entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, profile: { name } }], messages: [{ from, id: `wamid.in${n++}`, type: 'text', timestamp: ts(), text: { body: text } }] } }] }] });
const groupText = (group: string, from: string, text: string, name: string) => ({
  entry: [{ changes: [{ field: 'messages', value: { contacts: [{ wa_id: from, user_id: `IN.${from}`, profile: { name } }], messages: [{ from, from_user_id: `IN.${from}`, group_id: group, id: `wamid.g${n++}`, type: 'text', timestamp: ts(), text: { body: text } }] } }] }],
});
const P = () => `/api/v1/projects/${ids.project}`;

beforeAll(async () => {
  h = await makeHarness('synapse_test_projectchats');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://graph.facebook.com/')) {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      graph.push({ url, body });
      if (url.endsWith('/123456/groups')) return Response.json({ messaging_product: 'whatsapp', request_id: 'req-1' });
      if (url.endsWith('/GRP1/invite_link')) return Response.json({ messaging_product: 'whatsapp', invite_link: 'https://chat.whatsapp.com/NEWLINK' });
      if (url.endsWith('/messages')) return Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.out${n++}` }] });
      return Response.json({ error: { message: 'unexpected' } }, { status: 404 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  h.env.AI = {
    run: async () => {
      if (!aiReply) throw new Error('model down');
      return { response: aiReply };
    },
  } as unknown as Ai;
  await h.signup('chatco', 'owner@chatco.test');
  api = h.as('chatco', (await h.login('chatco', 'owner@chatco.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  const v = await api('POST', '/api/admin/users', { email: 'viewer@chatco.test', fullName: 'Vik Viewer', password: PW, roles: ['sales_rep'] });
  ids.viewer = v.json.id;
  viewer = h.as('chatco', (await h.login('chatco', 'viewer@chatco.test')).token);
  // a team member whose phone shows up in the group
  await sql(`update users set phone = '+91 98111 22222' where email = 'owner@chatco.test'`);
  const ch = await api('POST', '/api/admin/channels', { channel: 'whatsapp', name: 'Support WhatsApp', provider: 'meta_cloud', config: { phoneNumberId: '123456', wabaId: '99887766' }, secrets: { accessToken: 'EAAtoken', appSecret: APP_SECRET, verifyToken: 'vt' } });
  expect(ch.status).toBe(201);
  ids.acc = ch.json.id;
  inboundKey = ch.json.inbound_key;
  const p = await api('POST', '/api/v1/records/project', { name: 'Fleet portal' });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  ids.project = p.json.id;
  await sql(`update projects set work_key = 'FLEET' where id = $1`, [ids.project]);
  expect((await api('PUT', `${P()}/members`, { members: [{ userId: ids.viewer, role: 'viewer' }] })).status).toBe(200);
}, 120_000);
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('reading exported chats', () => {
  it('reads Android and iPhone exports, joins wrapped lines, skips system lines', () => {
    const android = [
      '22/11/2026, 10:15 am - Messages and calls are end-to-end encrypted.',
      '22/11/2026, 10:15 am - Ravi Client: The login page crashes on Safari',
      'when I tap Sign in',
      '22/11/2026, 10:20 pm - Prashant: Checking',
      '22/11/2026, 10:21 pm - Ravi Client: <Media omitted>',
    ].join('\n');
    const a = parseChatExport(android);
    expect(a.map((x) => x.sender)).toEqual(['Ravi Client', 'Prashant', 'Ravi Client']);
    expect(a[0]!.body).toBe('The login page crashes on Safari\nwhen I tap Sign in');
    expect(a[0]!.at.toISOString()).toBe('2026-11-22T04:45:00.000Z');
    expect(a[1]!.at.toISOString()).toBe('2026-11-22T16:50:00.000Z');
    expect(a[2]!.body).toBe('[media]');
    const ios = parseChatExport('[22/11/26, 9:05:12 AM] Ravi Client: Please add an export to Excel\n[22/11/26, 9:06:00 AM] Prashant: Noted');
    expect(ios.map((x) => [x.sender, x.at.toISOString()])).toEqual([
      ['Ravi Client', '2026-11-22T03:35:12.000Z'],
      ['Prashant', '2026-11-22T03:36:00.000Z'],
    ]);
    // month-first when a "day" is over 12
    expect(parseChatExport('11/22/26, 10:00 - A: hi there')[0]!.at.toISOString()).toBe('2026-11-22T04:30:00.000Z');
  });

  it('finds the obvious items without AI', () => {
    const r = ruleProposals([
      { sender: 'Ravi', side: 'client', body: 'The invoice PDF is not working since morning', at: '2026-11-22T04:00:00Z' },
      { sender: 'Ravi', side: 'client', body: 'We need a dashboard for fuel costs', at: '2026-11-22T04:01:00Z' },
      { sender: 'Us', side: 'team', body: 'The build failed, fixing', at: '2026-11-22T04:02:00Z' },
      { sender: 'Ravi', side: 'client', body: 'Thanks!', at: '2026-11-22T04:03:00Z' },
    ]);
    expect(r.map((x) => x.kind)).toEqual(['bug', 'requirement']);
  });
});

describe('a customer chat on a project', () => {
  it('links the thread, reads it with AI, and turns suggestions into work', async () => {
    await inbound(waText('919820011111', 'Hi, the trip report crashes when I pick last month'));
    await inbound(waText('919820011111', 'Also we need GPS tracking for every truck. And can we change the invoice layout to show the vehicle number instead of the route? Can we talk tomorrow at 4 pm?'));
    // no lead for... the customer is a lead in the CRM, as before; the project links the thread
    const choices = (await api('GET', `${P()}/chats/choices`)).json;
    const conv = choices.conversations.find((x: Json) => x.address === '919820011111');
    expect(conv).toBeTruthy();
    expect((await viewer('POST', `${P()}/chats`, { conversationId: conv.id })).status).toBe(403);
    const l = await api('POST', `${P()}/chats`, { conversationId: conv.id, mode: 'suggest' });
    expect(l.status, JSON.stringify(l.json)).toBe(201);
    expect(l.json).toMatchObject({ kind: 'contact', copied: 2 });
    ids.chat = l.json.id;

    aiReply = JSON.stringify({
      summary: 'A crash on the trip report, GPS tracking asked for, an invoice layout change and a call tomorrow.',
      items: [
        { type: 'bug', title: 'Trip report crashes for last month', detail: 'Picking last month crashes the report', priority: 'high', quote: 'the trip report crashes when I pick last month', message: 0, confidence: 0.9 },
        { type: 'requirement', title: 'GPS tracking for every truck', priority: 'medium', message: 1, confidence: 0.85 },
        { type: 'change_request', title: 'Invoice shows vehicle number instead of route', priority: 'medium', message: 1, confidence: 0.8 },
        { type: 'call', title: 'Call with Ravi', when: '2026-11-23T16:00:00+05:30', message: 1, confidence: 0.8 },
        { type: 'bug', title: 'Trip report crashes for last month', message: 0, confidence: 0.9 },
      ],
    });
    const r = await api('POST', `${P()}/chats/${ids.chat}/analyse`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ proposals: 4, created: 0, ai: true });
    const list = (await viewer('GET', `${P()}/chats`)).json;
    expect(list.canManage).toBe(false);
    const props = list.proposals as Json[];
    expect(props.map((p) => p.kind).sort()).toEqual(['bug', 'call', 'change_request', 'requirement']);
    expect(list.chats[0]).toMatchObject({ title: 'Ravi Client', messages: 2, open_proposals: 4 });
    const by = (k: string) => props.find((p) => p.kind === k)!;
    expect(by('bug')).toMatchObject({ requested_by: 'Ravi Client', priority: 'high' });

    // viewers can't act; members and managers can
    expect((await viewer('POST', `${P()}/chat-proposals/${by('bug').id}/accept`, {})).status).toBe(403);
    const bug = await api('POST', `${P()}/chat-proposals/${by('bug').id}/accept`, {});
    expect(bug.status, JSON.stringify(bug.json)).toBe(200);
    expect(bug.json).toMatchObject({ object: 'task', key: 'FLEET-1' });
    const task = (await sql(`select name, work_type, tags, priority, description from project_tasks where id = $1`, [bug.json.id]))[0]!;
    expect(task).toMatchObject({ name: 'Trip report crashes for last month', work_type: 'bug', priority: 'high' });
    expect(task.tags).toContain('whatsapp');
    expect(task.description).toMatch(/From WhatsApp · Ravi Client/);
    const req = await api('POST', `${P()}/chat-proposals/${by('requirement').id}/accept`, { title: 'GPS tracking for all trucks' });
    expect((await sql(`select work_type, tags, name from project_tasks where id = $1`, [req.json.id]))[0]).toMatchObject({ work_type: 'story', name: 'GPS tracking for all trucks', tags: ['whatsapp', 'requirement'] });
    const cr = await api('POST', `${P()}/chat-proposals/${by('change_request').id}/accept`, {});
    expect(cr.json).toMatchObject({ object: 'change_request', key: 'FLEET-CR-1' });
    expect((await sql(`select status, requested_by from change_requests where id = $1`, [cr.json.id]))[0]).toMatchObject({ status: 'draft', requested_by: 'Ravi Client' });
    const call = await api('POST', `${P()}/chat-proposals/${by('call').id}/accept`, {});
    expect(call.status, JSON.stringify(call.json)).toBe(200);
    expect((await sql(`select title, starts_at from events where id = $1`, [call.json.id]))[0]!.title).toBe('Call with Ravi');
    // handled once
    expect((await api('POST', `${P()}/chat-proposals/${by('bug').id}/accept`, {})).status).toBe(400);
    expect((await api('POST', `${P()}/chat-proposals/${by('bug').id}/dismiss`)).status).toBe(404);
  });

  it('in auto mode creates the work when the chat goes quiet; nothing twice', async () => {
    expect((await api('PATCH', `${P()}/chats/${ids.chat}`, { mode: 'auto' })).status).toBe(200);
    await inbound(waText('919820011111', 'The trip report still crashes for last month. Also the driver app logs out every hour.'));
    expect((await sql(`select pending_since is not null as p from project_chats where id = $1`, [ids.chat]))[0]!.p).toBe(true);
    aiReply = JSON.stringify({
      summary: 'Two problems.',
      items: [
        { type: 'bug', title: 'Trip report crashes for last month', message: 0, confidence: 0.9 },
        { type: 'bug', title: 'Driver app logs out every hour', priority: 'high', message: 0, confidence: 0.85 },
        { type: 'question', title: 'Is the export ready?', message: 0, confidence: 0.4 },
      ],
    });
    // not yet quiet: the sweep waits
    const db = Db.fromEnv(h.env);
    try {
      await chatSweep(h.env as never, db);
      expect((await sql(`select count(*)::int as n from project_chat_proposals where chat_id = $1`, [ids.chat]))[0]!.n).toBe(4);
      await sql(`update project_chats set last_message_at = now() - interval '11 minutes' where id = $1`, [ids.chat]);
      await chatSweep(h.env as never, db);
    } finally {
      await db.close();
    }
    const rows = await sql(`select kind, title, status, created_key from project_chat_proposals where chat_id = $1 order by created_at`, [ids.chat]);
    // the repeated crash isn't proposed again; the new bug is created; the unsure question waits
    expect(rows.slice(4).map((r) => [r.kind, r.status, r.created_key])).toEqual([
      ['bug', 'created', 'FLEET-3'],
      ['question', 'proposed', null],
    ]);
    expect((await sql(`select pending_since from project_chats where id = $1`, [ids.chat]))[0]!.pending_since).toBeNull();
    // the owner heard about it
    expect((await sql(`select title from notifications where title like 'WhatsApp%' order by created_at desc limit 1`))[0]!.title).toMatch(/1 created, 1 to review/);
  });

  it('our replies from the inbox are part of the chat', async () => {
    const conv = (await sql(`select id from conversations where address = '919820011111'`))[0]!.id;
    const s = await api('POST', `/api/v1/inbox/${conv}/messages`, { text: 'Fixed the trip report, please check' });
    expect(s.status, JSON.stringify(s.json)).toBeLessThan(300);
    const last = (await api('GET', `${P()}/chats/${ids.chat}/messages`)).json[0];
    expect(last).toMatchObject({ side: 'team', body: 'Fixed the trip report, please check' });
  });
});

describe('a project group', () => {
  it('creates the group, gets its link by webhook, and reads group messages without making leads', async () => {
    const g = await api('POST', `${P()}/chats/group`, { channelAccountId: ids.acc, subject: 'Fleet portal — HRP AI' });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    expect(g.json.pending).toBe(true);
    expect(graph.find((x) => x.url.endsWith('/123456/groups'))!.body).toMatchObject({ subject: 'Fleet portal — HRP AI', join_approval_mode: 'auto_approve' });
    await inbound({ entry: [{ changes: [{ field: 'group_lifecycle_update', value: { messaging_product: 'whatsapp', groups: [{ timestamp: ts(), group_id: 'GRP1', type: 'group_create', request_id: 'req-1', subject: 'Fleet portal — HRP AI', invite_link: 'https://chat.whatsapp.com/LINK1' }] } }] }] });
    const chats = (await api('GET', `${P()}/chats`)).json.chats as Json[];
    const gc = chats.find((c) => c.kind === 'group')!;
    expect(gc).toMatchObject({ group_id: 'GRP1', invite_link: 'https://chat.whatsapp.com/LINK1', group_pending: false });
    const leadsBefore = (await sql(`select count(*)::int as n from leads`))[0]!.n;
    await inbound(groupText('GRP1', '919811122222', 'I will share the API spec by Friday', 'Owner'));
    await inbound(groupText('GRP1', '919830033333', 'Reports page is very slow', 'Anita Client'));
    expect((await sql(`select count(*)::int as n from leads`))[0]!.n).toBe(leadsBefore);
    const msgs = (await api('GET', `${P()}/chats/${gc.id}/messages`)).json as Json[];
    expect(msgs.map((m) => [m.sender, m.side])).toEqual([
      ['Anita Client', 'client'],
      ['chatco Owner', 'team'],
    ]);
    // the group's thread is in the inbox, on the project; a reply goes to the group
    const conv = (await sql(`select id, related_object from conversations where address = 'group:GRP1'`))[0]!;
    expect(conv.related_object).toBe('project');
    const gs = await api('POST', `/api/v1/inbox/${conv.id}/messages`, { text: 'Looking into the reports page' });
    expect(gs.status, JSON.stringify(gs.json)).toBeLessThan(300);
    expect(graph.filter((x) => x.url.endsWith('/messages')).pop()!.body).toMatchObject({ recipient_type: 'group', to: 'GRP1' });
    const inv = await api('POST', `${P()}/chats/groups/${(await sql(`select id from wa_groups where group_id = 'GRP1'`))[0]!.id}/invite`, {});
    expect(inv.json.inviteLink).toBe('https://chat.whatsapp.com/NEWLINK');
  });
});

describe('an exported chat', () => {
  it('imports, adds only new lines on re-upload, and falls back to rules without AI', async () => {
    const text = ['20/11/2026, 11:00 am - Meena (Client): Hello team', '20/11/2026, 11:02 am - Meena (Client): The PDF export is not working on the reports page', '20/11/2026, 11:05 am - Owner: Will check'].join('\n');
    const r = await api('POST', `${P()}/chats/import`, { title: 'Client group (personal WhatsApp)', text, teamNames: ['Owner'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ read: 3, added: 3, skipped: 0 });
    const again = await api('POST', `${P()}/chats/import`, { chatId: r.json.chatId, text: `${text}\n21/11/2026, 9:00 am - Meena (Client): Please add a fuel report as well` });
    expect(again.json).toMatchObject({ read: 4, added: 1, skipped: 3 });
    aiReply = null;
    const a = await api('POST', `${P()}/chats/${r.json.chatId}/analyse`);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.ai).toBe(false);
    const kinds = (await sql(`select kind from project_chat_proposals where chat_id = $1 order by created_at`, [r.json.chatId])).map((x) => x.kind);
    expect(kinds).toEqual(['bug', 'requirement']);
    expect((await sql(`select side from project_chat_messages where chat_id = $1 and sender = 'Owner'`, [r.json.chatId]))[0]!.side).toBe('team');
    expect((await api('POST', `${P()}/chats/import`, { text: 'nothing that looks like a chat here' })).status).toBe(400);
  });
});
