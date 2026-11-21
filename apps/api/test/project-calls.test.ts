/** Project calls: scheduling (pasted link or a Zoom meeting from my own account), transcripts, AI / rule-based minutes, person-wise actions → tasks, auto-fetch. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { parseDue, parseJoinUrl, ruleAnalysis } from '../src/services/calls';
import { captionsToText, meetingSweep } from '../src/services/meetings';
import { analyseAsOwner } from '../src/services/calls';
import { sealSecret } from '../src/services/integrations';
import { expandRrule, parseIcs } from '../src/services/invites';
import { filingKeys, titleKey } from '../src/services/meetings';
import { formatSegments, novaSegments, renameSpeakers, speakersIn, splitMp3, splitWav } from '../src/services/transcribe';
import { fakeR2, type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
let viewer: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
const hits: string[] = [];
let aiReply: unknown = null;
let calendar: Json[] = [];
let mailIcs: string | null = null;
let novaDown = true;
const novaCalls: number[] = [];

const VTT = `WEBVTT

1
00:00:01.000 --> 00:00:05.000
<v Owner>Thanks for joining. Today we finalise the dispatch module scope.</v>

2
00:00:05.500 --> 00:00:09.000
<v Owner>We need GPS tracking for every truck.</v>

3
00:00:10.000 --> 00:00:15.000
<v Anita Desai>The system must send an SMS to the consignee when a truck leaves the depot.</v>

4
00:00:15.500 --> 00:00:20.000
<v Dev Kumar>I will share the API spec by Friday.</v>
`;

beforeAll(async () => {
  h = await makeHarness('synapse_test_calls');
  Object.assign(h.env, { ZOOM_CLIENT_ID: 'zid', ZOOM_CLIENT_SECRET: 'zsecret' });
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.owner = (await api('GET', '/api/auth/me')).json.user.id;
  ids.tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
  ids.dev = (await api('POST', '/api/admin/users', { email: 'dev@acme.test', fullName: 'Dev Kumar', password: PW, roles: ['sales_rep'] })).json.id;
  ids.viewer = (await api('POST', '/api/admin/users', { email: 'view@acme.test', fullName: 'Vera View', password: PW, roles: ['sales_rep'] })).json.id;
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  viewer = h.as('acme', (await h.login('acme', 'view@acme.test')).token);
  ids.acc = (await api('POST', '/api/v1/records/account', { name: 'Konkan Logistics' })).json.id;
  ids.contact = (await api('POST', '/api/v1/records/contact', { first_name: 'Anita', last_name: 'Desai', email: 'anita@konkan.test', account_id: ids.acc })).json.id;
  const p = await api('POST', '/api/v1/records/project', { name: 'Fleet portal', account_id: ids.acc });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  ids.project = p.json.id;
  expect((await api('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member' }, { userId: ids.viewer, role: 'viewer' }] })).status).toBe(200);

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!/^https:\/\/(zoom\.us|api\.zoom\.us|www\.googleapis\.com|gmail\.googleapis\.com)\//.test(url)) return realFetch(input, init);
    const m = `${init?.method ?? 'GET'} ${url}`;
    hits.push(m);
    if (m.startsWith('POST https://zoom.us/oauth/token')) return json({ access_token: 'z-access', refresh_token: 'z-refresh', expires_in: 3600 });
    if (m === 'GET https://api.zoom.us/v2/users/me') return json({ id: 'u1', email: 'Owner@Acme.test', first_name: 'Acme', last_name: 'Owner' });
    if (m === 'POST https://api.zoom.us/v2/users/me/meetings') return json({ id: 81234567890, join_url: 'https://us02web.zoom.us/j/81234567890?pwd=x' });
    if (m === 'GET https://api.zoom.us/v2/meetings/81234567890/recordings')
      return json({ recording_files: [{ file_type: 'MP4', download_url: 'https://zoom.us/rec/download/v' }, { file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/rec/download/t' }] });
    if (m === 'GET https://zoom.us/rec/download/t') return new Response(VTT, { status: 200 });
    if (m.startsWith('GET https://www.googleapis.com/calendar/v3/calendars/primary/events?')) return json({ items: calendar });
    if (m.startsWith('GET https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return json({ messages: mailIcs ? [{ id: 'm1' }] : [] });
    if (m === 'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1?format=full')
      return json({ payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', body: { data: '' } }, { mimeType: 'application/octet-stream', filename: 'invite.ics', body: { attachmentId: 'a1' } }] } });
    if (m === 'GET https://gmail.googleapis.com/gmail/v1/users/me/messages/m1/attachments/a1') return json({ data: btoa(mailIcs ?? '').replace(/\+/g, '-').replace(/\//g, '_') });
    return json({ message: `unmocked ${m}` }, 404);
  });
  h.env.AI = {
    run: async (model: string, input: any) => {
      if (String(model).includes('nova-3')) {
        if (novaDown) throw new Error('nova unavailable');
        // the audio arrives as a stream
        const bytes = new Uint8Array(await new Response(input.audio.body).arrayBuffer());
        novaCalls.push(bytes.length);
        expect(input).toMatchObject({ diarize: true, utterances: true });
        return { results: { utterances: [{ start: 1.2, end: 3, speaker: 0, transcript: 'Shall we fix the dispatch scope?' }, { start: 3.5, end: 6, speaker: 1, transcript: 'Yes. I will send the API spec by Friday.' }, { start: 6.2, end: 8, speaker: 0, transcript: 'Great, thanks.' }] } };
      }
      if (String(model).includes('whisper')) return { text: 'x', segments: [{ start: 0, text: 'Owner: we agreed the dispatch scope today.' }, { start: 4.5, text: 'Dev Kumar will share the API spec by Friday.' }] };
      if (!aiReply) throw new Error('model down');
      return { response: aiReply };
    },
  } as unknown as Ai;
}, 120_000);

afterAll(() => vi.unstubAllGlobals());

describe('helpers', () => {
  it('reads captions, links and due dates', () => {
    expect(captionsToText(VTT).split('\n')).toEqual([
      'Owner: Thanks for joining. Today we finalise the dispatch module scope. We need GPS tracking for every truck.',
      'Anita Desai: The system must send an SMS to the consignee when a truck leaves the depot.',
      'Dev Kumar: I will share the API spec by Friday.',
    ]);
    expect(parseJoinUrl('https://us02web.zoom.us/j/81234567890?pwd=abc')).toMatchObject({ provider: 'zoom_meet', meetingId: '81234567890' });
    expect(parseJoinUrl('https://meet.google.com/abc-defg-hij')).toMatchObject({ provider: 'google_meet', meetingCode: 'abc-defg-hij' });
    expect(parseJoinUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting')).toMatchObject({ provider: 'ms_teams_meet' });
    expect(parseJoinUrl('https://example.com/x')).toBeNull();
    const wed = new Date('2026-11-18T10:00:00Z');
    expect(parseDue('by Friday', wed)).toBe('2026-11-20');
    expect(parseDue('tomorrow', wed)).toBe('2026-11-19');
    expect(parseDue('2026-12-01', wed)).toBe('2026-12-01');
    const r = ruleAnalysis(captionsToText(VTT), wed);
    expect(r.actions).toContainEqual(expect.objectContaining({ owner: 'Dev Kumar', due: '2026-11-20' }));
    expect(r.requirements.map((x) => x.text).join(' ')).toMatch(/SMS to the consignee/);
  });
});

describe('project calls', () => {
  it('schedules a call with a pasted link; viewers cannot', async () => {
    const at = new Date(Date.now() - 3 * 3_600_000);
    const body = { title: 'Scope review', startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 3_600_000).toISOString(), userIds: [ids.dev], contactIds: [ids.contact], meeting: { mode: 'link', joinUrl: 'https://meet.google.com/abc-defg-hij' } };
    expect((await viewer('POST', `/api/v1/projects/${ids.project}/calls`, body)).status).toBe(403);
    const r = await api('POST', `/api/v1/projects/${ids.project}/calls`, body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.call = r.json.id;
    const list = (await viewer('GET', `/api/v1/projects/${ids.project}/calls`)).json;
    expect(list.canSchedule).toBe(false);
    expect(list.calls[0]).toMatchObject({ title: 'Scope review', meeting: { provider: 'google_meet' }, transcriptStatus: 'none', hasTranscript: false });
    // dev hears about it
    expect((await dev('GET', '/api/v1/calls?scope=recent')).json.calls.map((c: Json) => c.id)).toContain(ids.call);
  });

  it('takes an uploaded transcript and analyses it without AI', async () => {
    expect((await viewer('PUT', `/api/v1/calls/${ids.call}/transcript`, { text: VTT, fileName: 'call.vtt', source: 'upload' })).status).toBe(403);
    const t = await dev('PUT', `/api/v1/calls/${ids.call}/transcript`, { text: VTT, fileName: 'call.vtt', source: 'upload' });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    const a = await dev('POST', `/api/v1/calls/${ids.call}/analyse`, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.analysis.ai).toBe(false);
    const act = a.json.analysis.actions.find((x: Json) => x.owner === 'Dev Kumar');
    expect(act).toMatchObject({ side: 'team', userId: ids.dev });
    expect(act.taskId).toBeTruthy();
    const call = (await api('GET', `/api/v1/calls/${ids.call}`)).json;
    expect(call.transcript).toMatch(/^Owner: Thanks/);
    expect(call.people.map((p: Json) => p.name)).toEqual(expect.arrayContaining(['Dev Kumar', 'Anita Desai']));
    expect(call.analysis.actions.find((x: Json) => x.taskId).taskStatus).toBe('open');
  });

  it('re-analyses with AI: person-wise actions, client to-dos, no duplicate tasks', async () => {
    aiReply = {
      summary: 'Dispatch module scope agreed. GPS and consignee SMS are in.',
      discussion: ['Dispatch module scope', 'GPS tracking for trucks'],
      requirements: [{ text: 'GPS tracking for every truck', priority: 'must', area: 'Dispatch' }, { text: 'SMS the consignee on departure', priority: 'must', area: 'Notifications' }],
      decisions: ['Scope of dispatch module frozen'],
      open_questions: ['Which SMS gateway?'],
      risks: [],
      actions: [
        { owner: 'Dev Kumar', task: 'share the API spec by Friday', due: null, priority: 'medium' },
        { owner: 'Anita', task: 'Send the list of depots', due: null, priority: 'high' },
        { owner: 'Us', task: 'Send the revised estimate', due: null, priority: 'medium' },
      ],
      next_meeting: 'Next Tuesday',
      sentiment: 'positive',
    };
    const a = await api('POST', `/api/v1/calls/${ids.call}/analyse`, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.analysis).toMatchObject({ ai: true, sentiment: 'positive', requirements: [{ priority: 'must' }, { priority: 'must' }] });
    const [d, an, us] = a.json.analysis.actions;
    expect(an).toMatchObject({ owner: 'Anita Desai', side: 'client', taskId: null });
    expect(us).toMatchObject({ side: 'team', userId: ids.owner });
    expect(d.userId).toBe(ids.dev);
    const tasks = (await api('GET', `/api/v1/projects/${ids.project}/tasks`)).json.tasks as Json[];
    expect(tasks.filter((t) => /API spec/i.test(t.name))).toHaveLength(1);
    expect(tasks.some((t) => /revised estimate/.test(t.name))).toBe(true);
    expect(tasks.some((t) => /list of depots/.test(t.name))).toBe(false);
    // ticking an action done closes its task
    expect((await dev('PATCH', `/api/v1/calls/${ids.call}/actions/0`, { done: true })).status).toBe(200);
    expect(((await api('GET', `/api/v1/projects/${ids.project}/tasks`)).json.tasks as Json[]).find((t) => /API spec/i.test(t.name))!.status).toBe('done');
  });

  it('connects Zoom, creates the meeting, fetches the transcript after it and analyses it', async () => {
    const start = await api('POST', '/api/v1/integrations/oauth/zoom/start', { returnTo: '/calls' });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0]!;
    const state = new URL(start.json.url).searchParams.get('state')!;
    const cb = await h.call('GET', `/api/public/oauth/zoom/callback?code=abc&state=${encodeURIComponent(state)}`, { raw: true, cookie });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toMatch(/connected=Zoom/);
    const accts = (await api('GET', '/api/v1/meeting-accounts')).json;
    expect(accts.accounts).toHaveLength(1);
    expect(accts.available.zoom_meet).toBe(true);
    ids.zoom = accts.accounts[0].id;
    expect((await dev('PATCH', `/api/v1/meeting-accounts/${ids.zoom}`, { importAll: true })).status).toBe(403);

    const at = new Date(Date.now() - 2 * 3_600_000);
    const r = await api('POST', `/api/v1/projects/${ids.project}/calls`, { title: 'Sprint demo', startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 1_800_000).toISOString(), userIds: [ids.dev], meeting: { mode: 'create', integrationId: ids.zoom } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.meeting).toMatchObject({ provider: 'zoom_meet', joinUrl: expect.stringContaining('zoom.us/j/81234567890') });
    ids.zcall = r.json.id;

    aiReply = null; // model down: rule-based minutes
    const db = Db.fromEnv(h.env);
    try {
      await meetingSweep(h.env, db, (t, e, o) => analyseAsOwner(h.env, db, t, e, o));
    } finally {
      await db.close();
    }
    const call = (await api('GET', `/api/v1/calls/${ids.zcall}`)).json;
    expect(call).toMatchObject({ transcriptStatus: 'fetched', transcriptSource: 'zoom', status: 'done' });
    expect(call.analysis.actions.some((a: Json) => a.owner === 'Dev Kumar')).toBe(true);
    expect(hits).toContain('GET https://zoom.us/rec/download/t');
  });

  it('lists individual time entries (managers: everyone, members: their own)', async () => {
    const day = new Date().toISOString().slice(0, 10);
    expect((await dev('POST', '/api/v1/time', { projectId: ids.project, date: day, minutes: 90, notes: 'API spec draft', billable: true })).status).toBe(201);
    expect((await api('POST', '/api/v1/time', { projectId: ids.project, date: day, minutes: 30, notes: 'Review', billable: false })).status).toBe(201);
    const all = (await api('GET', `/api/v1/projects/${ids.project}/time-entries`)).json as Json[];
    expect(all.map((e) => e.minutes).sort()).toEqual([30, 90]);
    expect(all.every((e) => e.canEdit)).toBe(true);
    const mine = (await dev('GET', `/api/v1/projects/${ids.project}/time-entries`)).json as Json[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ notes: 'API spec draft', person: 'Dev Kumar', canEdit: true });
    expect((await api('GET', `/api/v1/projects/${ids.project}/time-entries?userId=${ids.dev}`)).json).toHaveLength(1);
    expect((await viewer('GET', `/api/v1/projects/${ids.project}/time-entries`)).json).toHaveLength(0);
  });

  it('keeps a recording of a call that already happened, transcribes it and writes the minutes', async () => {
    h.env.FILES = fakeR2() as unknown as R2Bucket;
    const at = new Date(Date.now() - 50 * 3_600_000);
    const call = await api('POST', `/api/v1/projects/${ids.project}/calls`, { title: 'Kick-off (recorded)', startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 3_600_000).toISOString(), userIds: [ids.dev] });
    expect(call.status).toBe(201);
    const mp3 = new Uint8Array(4096);
    mp3.set([0x49, 0x44, 0x33, 0x04]);
    const up = await h.app.request(`http://synapse.test/api/v1/calls/${call.json.id}/recording?name=kickoff.mp3&analyse=1`, { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${(await h.login('acme', 'owner@acme.test')).token}`, 'content-type': 'application/octet-stream' }, body: mp3 }, h.env);
    const body = (await up.json()) as Json;
    expect(up.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ transcribed: true, analysed: true });
    const c = (await api('GET', `/api/v1/calls/${call.json.id}`)).json;
    expect(c).toMatchObject({ transcriptSource: 'audio', recordings: 1, status: 'done' });
    expect(c.transcript).toMatch(/\[00:00:04\] Dev Kumar will share the API spec/);
    expect((await api('GET', `/api/v1/calls/${call.json.id}/recordings`)).json[0]).toMatchObject({ name: 'kickoff.mp3', type: 'audio/mpeg' });
    // not a recording
    const bad = await h.app.request(`http://synapse.test/api/v1/calls/${call.json.id}/recording?name=notes.csv`, { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${(await h.login('acme', 'owner@acme.test')).token}` }, body: new TextEncoder().encode('a,b') }, h.env);
    expect(bad.status).toBe(400);
  });

  it('files call invites from the connected mailbox on the right project', async () => {
    const tenant = (await api('GET', '/api/auth/me')).json.tenant.id as string;
    const db = Db.fromEnv(h.env);
    try {
      await db.tx({ tenantId: tenant }, async (tx) =>
        tx.query(`insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config) values ($1,'google',$2,'Gmail','owner@acme.test',$3,'{"calendar":true}')`, [
          tenant, ids.owner, await sealSecret(h.env, tenant, { accessToken: 'g', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
        ]),
      );
    } finally {
      await db.close();
    }
    const start = new Date(Date.now() + 2 * 86_400_000);
    const end = new Date(start.getTime() + 1_800_000);
    calendar = [
      { id: 'ev1', summary: 'Dispatch review', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, hangoutLink: 'https://meet.google.com/xyz-abcd-efg', attendees: [{ email: 'owner@acme.test', self: true }, { email: 'Anita@konkan.test', displayName: 'Anita Desai' }] },
      { id: 'ev2', summary: 'Team lunch', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, attendees: [{ email: 'owner@acme.test', self: true }, { email: 'dev@acme.test' }] },
      { id: 'ev3', summary: 'Cancelled sync', status: 'cancelled', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, hangoutLink: 'https://meet.google.com/aaa-bbbb-ccc', attendees: [{ email: 'x@other.test' }] },
      { id: 'ev4', summary: 'Intro with a prospect', start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() }, location: 'https://us02web.zoom.us/j/99887766554', attendees: [{ email: 'cto@prospect.test' }] },
    ];
    const r = await api('POST', '/api/v1/calls/invites/sync');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ mailbox: true, added: 2 });
    const onProject = (await api('GET', `/api/v1/projects/${ids.project}/calls`)).json.calls as Json[];
    expect(onProject.find((c) => c.title === 'Dispatch review')).toMatchObject({ meeting: { provider: 'google_meet' } });
    const unfiled = (await api('GET', '/api/v1/calls?scope=unassigned')).json.calls as Json[];
    expect(unfiled.find((c) => c.title === 'Intro with a prospect')).toMatchObject({ meeting: { provider: 'zoom_meet' }, transcriptStatus: 'waiting' });
    // again: updated, not duplicated; a later cancellation follows
    calendar[0] = { ...calendar[0], status: 'cancelled' };
    const again = (await api('POST', '/api/v1/calls/invites/sync')).json;
    expect(again.added).toBe(0);
    expect(((await api('GET', `/api/v1/projects/${ids.project}/calls`)).json.calls as Json[]).find((c) => c.title === 'Dispatch review')!.status).toBe('cancelled');
  });

  it('labels speakers, names them, and transcribes long recordings in parts', async () => {
    const at = new Date(Date.now() - 30 * 3_600_000);
    const call = await api('POST', `/api/v1/projects/${ids.project}/calls`, { title: 'Design review (recorded)', startsAt: at.toISOString(), endsAt: new Date(at.getTime() + 3_600_000).toISOString() });
    const token = (await h.login('acme', 'owner@acme.test')).token;
    const post = (path: string, body: Uint8Array) => h.app.request(`http://synapse.test/api/v1/calls/${call.json.id}${path}`, { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}` }, body }, h.env);
    // speakers: Nova-3 diarises
    novaDown = false;
    const m4a = new Uint8Array(4096);
    m4a.set([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    const up = await post('/recording?name=review.m4a', m4a);
    const body = (await up.json()) as Json;
    expect(up.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ transcribed: true, engine: 'nova-3' });
    let c = (await api('GET', `/api/v1/calls/${call.json.id}`)).json;
    expect(c.transcript.split('\n')[0]).toBe('[00:00:01] Speaker 1: Shall we fix the dispatch scope?');
    expect(c.speakers.map((s: Json) => s.label)).toEqual(['Speaker 1', 'Speaker 2']);
    // naming them rewrites the transcript
    const named = await api('PUT', `/api/v1/calls/${call.json.id}/speakers`, { names: { 'Speaker 1': 'Asha (Acme)', 'Speaker 2': 'Dev Kumar' } });
    expect(named.status, JSON.stringify(named.json)).toBe(200);
    c = (await api('GET', `/api/v1/calls/${call.json.id}`)).json;
    expect(c.transcript).toContain('[00:00:03] Dev Kumar: Yes. I will send the API spec by Friday.');
    expect((await api('PUT', `/api/v1/calls/${call.json.id}/speakers`, { names: { 'Dev Kumar': 'Bad: name' } })).status).toBe(400);

    // a recording Nova cannot take and that is too big for Whisper: the browser cuts it into WAV parts
    novaDown = true;
    const files = (await api('GET', `/api/v1/calls/${call.json.id}/recordings`)).json as Json[];
    const fid = files[0]!.id as string;
    const big = await h.app.request(`http://synapse.test/api/v1/calls/${call.json.id}/recordings/${fid}/transcribe`, { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }, h.env);
    expect(big.status).toBe(200); // small file: Whisper does it
    expect(((await big.json()) as Json).engine).toBe('whisper');
    const wav = (seconds: number) => {
      const rate = 8000;
      const data = rate * 2 * seconds;
      const b = new Uint8Array(44 + data);
      const v = new DataView(b.buffer);
      b.set([82, 73, 70, 70]);
      v.setUint32(4, 36 + data, true);
      b.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
      v.setUint32(16, 16, true);
      v.setUint16(20, 1, true);
      v.setUint16(22, 1, true);
      v.setUint32(24, rate, true);
      v.setUint32(28, rate * 2, true);
      v.setUint16(32, 2, true);
      v.setUint16(34, 16, true);
      b.set([100, 97, 116, 97], 36);
      v.setUint32(40, data, true);
      return b;
    };
    const p1 = await post(`/recordings/${fid}/parts?index=0&total=2&offset=0`, wav(2));
    expect(p1.status, await p1.clone().text()).toBe(200);
    expect(await p1.json()).toMatchObject({ complete: false });
    const p2 = await post(`/recordings/${fid}/parts?index=1&total=2&offset=600&analyse=0`, wav(2));
    const done = (await p2.json()) as Json;
    expect(done).toMatchObject({ complete: true, transcribed: true });
    c = (await api('GET', `/api/v1/calls/${call.json.id}`)).json;
    // part two's lines carry its time offset (10 minutes in)
    expect(c.transcript).toContain('[00:10:04] Dev Kumar will share the API spec by Friday.');
    expect((await post(`/recordings/${fid}/parts?index=3&total=2&offset=0`, wav(1))).status).toBe(400);
  });

  it('splits audio, formats speakers and reads emailed invitations', () => {
    // MP3: cut at frame boundaries (MPEG-1 layer III, 128 kbps, 44.1 kHz → 417/418-byte frames)
    const frame = (pad: number) => {
      const len = Math.floor((144 * 128000) / 44100) + pad;
      const f = new Uint8Array(len);
      f.set([0xff, 0xfb, 0x90 | (pad << 1), 0x64]);
      return f;
    };
    const frames = Array.from({ length: 400 }, (_, i) => frame(i % 3 === 0 ? 1 : 0));
    const mp3 = new Uint8Array(frames.reduce((n, f) => n + f.length, 0) + 10);
    mp3.set([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]);
    let o = 10;
    for (const f of frames) {
      mp3.set(f, o);
      o += f.length;
    }
    const parts = splitMp3(mp3, 50_000)!;
    expect(parts.length).toBe(4);
    for (const p of parts) expect([p.bytes[0], p.bytes[1]]).toEqual([0xff, 0xfb]);
    expect(parts.reduce((n, p) => n + p.bytes.length, 0)).toBe(mp3.length - 10);
    expect(parts[1]!.offset).toBeCloseTo((parts[0]!.bytes.length * 8) / 128000, 3);
    // WAV: each part gets its own header
    const pcm = new Uint8Array(44 + 32000);
    const v = new DataView(pcm.buffer);
    pcm.set([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32]);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true);
    v.setUint32(28, 16000, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    pcm.set([100, 97, 116, 97], 36);
    v.setUint32(40, 32000, true);
    const w = splitWav(pcm, 10_000)!;
    expect(w.map((p) => p.offset)).toEqual([0, 0.625, 1.25, 1.875]);
    expect(String.fromCharCode(...w[3]!.bytes.subarray(0, 4))).toBe('RIFF');

    const segs = novaSegments({ results: { channels: [{ alternatives: [{ words: [
      { word: 'hello', punctuated_word: 'Hello,', start: 0, end: 0.4, speaker: 0 },
      { word: 'team', punctuated_word: 'team.', start: 0.5, end: 0.8, speaker: 0 },
      { word: 'hi', punctuated_word: 'Hi!', start: 1.1, end: 1.3, speaker: 1 },
    ] }] }] } }, 60);
    expect(formatSegments(segs)).toBe('[00:01:00] Speaker 1: Hello, team.\n[00:01:01] Speaker 2: Hi!');
    expect(speakersIn('[00:00:01] Ravi: a\n[00:00:02] Ravi: b\nSee https://x.test/y\n[00:00:03] Speaker 2: c')).toEqual([{ label: 'Ravi', lines: 2 }, { label: 'Speaker 2', lines: 1 }]);
    expect(renameSpeakers('[00:00:01] Speaker 2: we said Speaker 2: is fine', { 'Speaker 2': 'Anita' })).toBe('[00:00:01] Anita: we said Speaker 2: is fine');

    const ics = [
      'BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VTIMEZONE', 'TZID:India Standard Time', 'BEGIN:STANDARD', 'TZOFFSETTO:+0530', 'END:STANDARD', 'END:VTIMEZONE',
      'BEGIN:VEVENT', 'UID:abc-123@webex.test', 'SUMMARY:Dispatch module\\, weekly sync', 'DTSTART;TZID=India Standard Time:20261125T150000', 'DURATION:PT45M',
      'ORGANIZER;CN="Anita Desai":mailto:Anita@Konkan.test', 'ATTENDEE;CN=Owner:mailto:owner@acme.test', 'LOCATION:https://konkan.webex.test/meet/anita',
      'DESCRIPTION:Join Zoom: https://us02web.zoom.us/j/11122233344\\nAgenda: scope', 'END:VEVENT', 'END:VCALENDAR',
    ].join('\r\n');
    const [inv] = parseIcs(ics);
    expect(inv).toMatchObject({ uid: 'abc-123@webex.test', title: 'Dispatch module, weekly sync', startsAt: '2026-11-25T09:30:00.000Z', endsAt: '2026-11-25T10:15:00.000Z', joinUrl: 'https://us02web.zoom.us/j/11122233344', cancelled: false, source: 'email' });
    expect(inv!.attendees).toEqual([{ email: 'anita@konkan.test', name: 'Anita Desai' }, { email: 'owner@acme.test', name: 'Owner' }]);
    expect(parseIcs(ics.replace('METHOD:REQUEST', 'METHOD:CANCEL'))[0]!.cancelled).toBe(true);
    expect(parseIcs(ics.replace('DTSTART;TZID=India Standard Time:20261125T150000', 'DTSTART;TZID=Asia/Kolkata:20261125T150000'))[0]!.startsAt).toBe('2026-11-25T09:30:00.000Z');
    expect(parseIcs(ics.replace('DTSTART;TZID=India Standard Time:20261125T150000', 'DTSTART:20261125T093000Z'))[0]!.startsAt).toBe('2026-11-25T09:30:00.000Z');

    // recurring meetings: each time in the window, exceptions and moved times
    const mon = Date.parse('2026-11-02T04:30:00Z'); // a Monday, 10:00 IST
    const all = (rule: string, ex: number[] = []) => expandRrule(mon, rule, new Set(ex), Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-12-31T00:00:00Z')).map((t) => new Date(t).toISOString().slice(0, 10));
    expect(all('FREQ=WEEKLY;BYDAY=MO,TH;COUNT=5')).toEqual(['2026-11-02', '2026-11-05', '2026-11-09', '2026-11-12', '2026-11-16']);
    expect(all('FREQ=WEEKLY;INTERVAL=2;UNTIL=20261201T000000Z')).toEqual(['2026-11-02', '2026-11-16', '2026-11-30']);
    expect(all('FREQ=DAILY;COUNT=3', [Date.parse('2026-11-03T04:30:00Z')])).toEqual(['2026-11-02', '2026-11-04']);
    expect(all('FREQ=MONTHLY;BYDAY=-1FR')).toEqual(['2026-11-27', '2026-12-25']);
    expect(all('FREQ=MONTHLY;BYMONTHDAY=15')).toEqual(['2026-11-15', '2026-12-15']);
    const series = [
      'BEGIN:VCALENDAR', 'METHOD:REQUEST',
      'BEGIN:VEVENT', 'UID:standup@x.test', 'SUMMARY:Stand-up', 'DTSTART:20261102T043000Z', 'DTEND:20261102T044500Z', 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', 'EXDATE:20261109T043000Z', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:standup@x.test', 'RECURRENCE-ID:20261116T043000Z', 'SUMMARY:Stand-up (moved)', 'DTSTART:20261117T060000Z', 'DTEND:20261117T061500Z', 'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const times = parseIcs(series, { from: Date.parse('2026-11-01T00:00:00Z'), to: Date.parse('2026-12-31T00:00:00Z') });
    expect(times.map((x) => `${x.startsAt.slice(0, 16)} ${x.title}`)).toEqual(['2026-11-02T04:30 Stand-up', '2026-11-17T06:00 Stand-up (moved)', '2026-11-23T04:30 Stand-up']);
    expect(times[1]!.recurrenceId).toBe('2026-11-16T04:30:00.000Z');

    expect(titleKey('Re: Konkan weekly sync – 21 Nov 2026')).toBe(titleKey('Konkan weekly sync (Thu 28th)'));
    expect(filingKeys('Konkan weekly sync', ['a@konkan.test', 'b@gmail.com']).map((k) => `${k.kind}:${k.value}`)).toEqual(['title:konkan weekly sync', 'email:a@konkan.test', 'domain:konkan.test', 'email:b@gmail.com']);
  });

  it('files invitations attached to emails, and learns where calls go', async () => {
    const start = new Date(Date.now() + 3 * 86_400_000);
    const stamp = start.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    mailIcs = ['BEGIN:VCALENDAR', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:webex-777@konkan.test', 'SUMMARY:Konkan steering call', `DTSTART:${stamp}`, 'DURATION:PT1H', 'ORGANIZER;CN=Ravi:mailto:ravi@newco.test', 'LOCATION:https://newco.webex.test/m/1', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    calendar = [];
    const r = (await api('POST', '/api/v1/calls/invites/sync')).json;
    expect(r).toMatchObject({ added: 1, fromEmail: 1 });
    let unfiled = (await api('GET', '/api/v1/calls?scope=unassigned')).json.calls as Json[];
    const call = unfiled.find((c) => c.title === 'Konkan steering call')!;
    expect(call).toBeTruthy();
    // the same invite again: not duplicated
    expect((await api('POST', '/api/v1/calls/invites/sync')).json.added).toBe(0);
    // moving it teaches the filing: the next call with the same people / title lands on the project
    expect((await api('POST', `/api/v1/calls/${call.id}/assign`, { projectId: ids.project })).status).toBe(200);
    const next = new Date(start.getTime() + 7 * 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    mailIcs = mailIcs.replace('UID:webex-777@konkan.test', 'UID:webex-778@konkan.test').replace(`DTSTART:${stamp}`, `DTSTART:${next}`).replace('Konkan steering call', 'Konkan steering call (week 2)');
    expect((await api('POST', '/api/v1/calls/invites/sync')).json.added).toBe(1);
    const onProject = (await api('GET', `/api/v1/projects/${ids.project}/calls`)).json.calls as Json[];
    expect(onProject.map((c) => c.title)).toContain('Konkan steering call (week 2)');
    unfiled = (await api('GET', '/api/v1/calls?scope=unassigned')).json.calls as Json[];
    expect(unfiled.map((c) => c.title)).not.toContain('Konkan steering call (week 2)');
    mailIcs = null;
  });
});
