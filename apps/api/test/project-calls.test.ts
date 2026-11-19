/** Project calls: scheduling (pasted link or a Zoom meeting from my own account), transcripts, AI / rule-based minutes, person-wise actions → tasks, auto-fetch. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { parseDue, parseJoinUrl, ruleAnalysis } from '../src/services/calls';
import { captionsToText, meetingSweep } from '../src/services/meetings';
import { analyseAsOwner } from '../src/services/calls';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
let viewer: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const realFetch = globalThis.fetch;
const hits: string[] = [];
let aiReply: unknown = null;

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
    if (!/^https:\/\/(zoom\.us|api\.zoom\.us)\//.test(url)) return realFetch(input, init);
    const m = `${init?.method ?? 'GET'} ${url}`;
    hits.push(m);
    if (m.startsWith('POST https://zoom.us/oauth/token')) return json({ access_token: 'z-access', refresh_token: 'z-refresh', expires_in: 3600 });
    if (m === 'GET https://api.zoom.us/v2/users/me') return json({ id: 'u1', email: 'Owner@Acme.test', first_name: 'Acme', last_name: 'Owner' });
    if (m === 'POST https://api.zoom.us/v2/users/me/meetings') return json({ id: 81234567890, join_url: 'https://us02web.zoom.us/j/81234567890?pwd=x' });
    if (m === 'GET https://api.zoom.us/v2/meetings/81234567890/recordings')
      return json({ recording_files: [{ file_type: 'MP4', download_url: 'https://zoom.us/rec/download/v' }, { file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/rec/download/t' }] });
    if (m === 'GET https://zoom.us/rec/download/t') return new Response(VTT, { status: 200 });
    return json({ message: `unmocked ${m}` }, 404);
  });
  h.env.AI = {
    run: async () => {
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
});
