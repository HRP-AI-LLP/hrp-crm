/** Work management (Jira / Azure DevOps style): keys, hierarchy, workflows, fields, components, queries, boards, history, watchers, bulk, code links, tests, dashboards. */
import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { compileWql } from '../src/services/it/wql';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let pm: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
let qa: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const keys: Record<string, string> = {};
const P = () => `/api/v1/projects/${ids.project}/work`;

async function item(who: typeof pm, body: Json) {
  const r = await who('POST', `${P()}/items`, body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; key: string };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_work');
  await h.signup('acme', 'owner@acme.test');
  pm = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await pm('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.pm = (await pm('GET', '/api/auth/me')).json.user.id;
  ids.dev = (await pm('POST', '/api/admin/users', { email: 'dev@acme.test', fullName: 'Dev Kumar', password: PW, roles: ['sales_rep'] })).json.id;
  ids.qa = (await pm('POST', '/api/admin/users', { email: 'qa@acme.test', fullName: 'Quinn Tester', password: PW, roles: ['sales_rep'] })).json.id;
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  qa = h.as('acme', (await h.login('acme', 'qa@acme.test')).token);
  ids.project = (await pm('POST', '/api/v1/records/project', { name: 'Fleet portal', project_code: 'FLEET' })).json.id;
  expect((await pm('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member' }, { userId: ids.qa, role: 'member' }] })).status).toBe(200);
}, 120_000);

describe('keys and hierarchy', () => {
  it('builds epic → feature → story → sub-task with keys and refuses bad parents', async () => {
    const setup = (await pm('GET', `${P()}/setup`)).json;
    expect(setup.key).toBe('FLEET');
    const epic = await item(pm, { name: 'Fleet tracking', workType: 'epic' });
    expect(epic.key).toBe('FLEET-1');
    const feat = await item(pm, { name: 'Live map', workType: 'feature', parentId: epic.id });
    const story = await item(dev, { name: 'Show trucks on a map', workType: 'story', parentId: feat.id, storyPoints: 5, priority: 'high' });
    const sub = await item(dev, { name: 'Map tiles API', workType: 'subtask', parentId: story.id });
    Object.assign(ids, { epic: epic.id, feat: feat.id, story: story.id, sub: sub.id });
    Object.assign(keys, { epic: epic.key, story: story.key, sub: sub.key });
    expect((await dev('POST', `${P()}/items`, { name: 'x', workType: 'story', parentId: story.id })).status).toBe(400);
    expect((await dev('POST', `${P()}/items`, { name: 'x', workType: 'subtask' })).status).toBe(400);
    expect((await dev('POST', `${P()}/items`, { name: 'x', workType: 'feature', parentId: story.id })).status).toBe(400);
    const s = (await dev('GET', `${P()}/items/${sub.id}`)).json;
    expect(s.item.epicId).toBe(epic.id);
    expect(s.parent.key).toBe(story.key);
    expect(s.branchName).toMatch(/^feature\/FLEET-4-map-tiles-api$/);
    // an item cannot move under its own child
    expect((await pm('PATCH', `${P()}/items/${story.id}`, { parentId: sub.id })).status).toBe(400);
    const tree = (await pm('GET', `${P()}/hierarchy`)).json.roots;
    expect(tree[0]).toMatchObject({ key: 'FLEET-1', rollPoints: 5, rollItems: 3 });
    expect(tree[0].children[0].children[0].children[0].key).toBe(sub.key);
  });
});

describe('workflow, fields, components', () => {
  it('runs a bug workflow with role and field rules; direct status changes follow it', async () => {
    const wf = await pm('POST', `${P()}/workflows`, {
      name: 'Bug flow',
      workTypes: ['bug'],
      states: [
        { key: 'new', label: 'New', category: 'todo' },
        { key: 'triaged', label: 'Triaged', category: 'todo' },
        { key: 'fixing', label: 'Fixing', category: 'in_progress' },
        { key: 'verify', label: 'Ready for QA', category: 'review' },
        { key: 'closed', label: 'Closed', category: 'done' },
      ],
      transitions: [
        { from: 'new', to: 'triaged' },
        { from: 'triaged', to: 'fixing', require: ['assignee'] },
        { from: 'fixing', to: 'verify' },
        { from: 'verify', to: 'fixing', name: 'Reopen' },
        { from: 'verify', to: 'closed', roles: ['manager'], require: ['resolution'] },
      ],
    });
    expect(wf.status, JSON.stringify(wf.json)).toBe(201);
    // a required custom field on bugs
    expect((await pm('POST', `${P()}/fields`, { key: 'browser', label: 'Browser', type: 'select', options: ['Chrome', 'Safari', 'Edge'], workTypes: ['bug'], required: true })).status).toBe(201);
    expect((await dev('POST', `${P()}/items`, { name: 'Map blank on Safari', workType: 'bug' })).status).toBe(400);
    expect((await dev('POST', `${P()}/items`, { name: 'Map blank on Safari', workType: 'bug', custom: { browser: 'Firefox' } })).status).toBe(400);
    // a component whose lead takes new items
    const comp = await pm('POST', `${P()}/components`, { name: 'Maps', leadId: ids.dev, assignLead: true });
    ids.maps = comp.json.id;
    const bug = await item(qa, { name: 'Map blank on Safari', workType: 'bug', custom: { browser: 'Safari' }, componentIds: [ids.maps], severity: 'critical' });
    ids.bug = bug.id;
    keys.bug = bug.key;
    let b = (await qa('GET', `${P()}/items/${bug.id}`)).json;
    expect(b.item).toMatchObject({ state: 'new', stateLabel: 'New', assignees: [ids.dev] });
    expect(b.workflow.moves.map((m: Json) => m.to)).toEqual(['triaged']);
    expect((await qa('POST', `${P()}/items/${bug.id}/transition`, { to: 'fixing' })).status).toBe(400);
    for (const to of ['triaged', 'fixing', 'verify']) expect((await dev('POST', `${P()}/items/${bug.id}/transition`, { to })).status).toBe(200);
    expect((await dev('POST', `${P()}/items/${bug.id}/transition`, { to: 'closed', resolution: 'Fixed' })).status).toBe(403);
    expect((await pm('POST', `${P()}/items/${bug.id}/transition`, { to: 'closed' })).status).toBe(400);
    // a task-list style status change follows the workflow: review → open has no move
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${bug.id}`, { status: 'open' })).status).toBe(400);
    expect((await pm('POST', `${P()}/items/${bug.id}/transition`, { to: 'closed', resolution: 'Fixed' })).status).toBe(200);
    b = (await qa('GET', `${P()}/items/${bug.id}`)).json;
    expect(b.item).toMatchObject({ status: 'done', state: 'closed', resolution: 'Fixed' });
    expect(b.history.filter((x: Json) => x.field === 'state').map((x: Json) => x.to)).toEqual(['Closed', 'Ready for QA', 'Fixing', 'Triaged']);
    // QA (the reporter) watched it and heard about the moves
    const n = (await qa('GET', '/api/v1/notifications')).json.items as Json[];
    expect(n.some((x) => /FLEET-\d+ Map blank on Safari → Closed/.test(x.title))).toBe(true);
  });

  it('notifies @mentions and watchers on comments', async () => {
    const r = await pm('POST', `${P()}/items/${ids.story}/comments`, { body: `@[Quinn Tester](${ids.qa}) can you write test cases for this?` });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.mentioned).toEqual([ids.qa]);
    const n = (await qa('GET', '/api/v1/notifications')).json.items as Json[];
    expect(n[0]!.title).toMatch(/mentioned you on FLEET-3/);
    const s = (await qa('GET', `${P()}/items/${ids.story}`)).json;
    expect(s.watching).toBe(true);
  });
});

describe('queries', () => {
  it('compiles the query language to parameters only', () => {
    const c = compileWql(`type = bug AND (priority >= high OR labels = "x'); drop table users; --") ORDER BY priority DESC, created`, { userId: 'u', customFields: [], stateLabels: new Map() }, ['t', []]);
    expect(c.where).not.toMatch(/drop table/);
    expect(c.params).toContain("x'); drop table users; --");
    expect(c.order).toMatch(/desc/);
    expect(() => compileWql('colour = red', { userId: 'u', customFields: [], stateLabels: new Map() }, [])).toThrow(/Unknown field/);
    expect(() => compileWql('type = ', { userId: 'u', customFields: [], stateLabels: new Map() }, [])).toThrow();
  });

  it('runs, saves and exports queries', async () => {
    await item(dev, { name: 'Driver login', workType: 'story', storyPoints: 3, tags: ['auth'], assignees: [ids.dev] });
    const run = async (who: typeof pm, q: string) => {
      const r = await who('GET', `${P()}/query?q=${encodeURIComponent(q)}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json;
    };
    expect((await run(dev, 'type = story ORDER BY points DESC')).items.map((i: Json) => i.name)).toEqual(['Show trucks on a map', 'Driver login']);
    expect((await run(dev, 'assignee = currentUser() AND labels = auth')).total).toBe(1);
    expect((await run(dev, 'state = "Ready for QA" OR state = closed')).items.map((i: Json) => i.key)).toEqual([keys.bug]);
    expect((await run(dev, 'browser = Safari')).total).toBe(1);
    expect((await run(dev, `epic = ${keys.epic}`)).total).toBe(3);
    expect((await run(dev, 'component = Maps AND severity = critical')).total).toBe(1);
    expect((await run(dev, 'text ~ "tiles" AND created >= -1d')).items[0].key).toBe(keys.sub);
    expect((await run(dev, 'sprint is empty AND status != done')).total).toBeGreaterThan(3);
    expect((await dev('GET', `${P()}/query?q=${encodeURIComponent('colour = red')}`)).status).toBe(400);
    const s = await dev('POST', `${P()}/queries`, { name: 'My open', query: 'assignee = currentUser() AND status != done', shared: true });
    expect(s.status).toBe(201);
    expect((await pm('GET', `${P()}/queries`)).json.map((x: Json) => x.name)).toContain('My open');
    expect((await pm('DELETE', `${P()}/queries/${s.json.id}`)).status).toBe(404);
    const csv = await h.app.request(`http://synapse.test${P()}/query/export?q=${encodeURIComponent('type = story')}`, { headers: { 'x-tenant': 'acme', authorization: (await h.login('acme', 'dev@acme.test')).token ? `Bearer ${(await h.login('acme', 'dev@acme.test')).token}` : '' } }, h.env);
    expect(await csv.text()).toMatch(/Key,Type,Summary[\s\S]*FLEET-3,story,Show trucks on a map/);
    // across projects
    expect((await dev('GET', `/api/v1/work/query?q=${encodeURIComponent('project = FLEET AND type = epic')}`)).json.total).toBe(1);
    expect((await dev('GET', '/api/v1/work/mine')).json.total).toBeGreaterThan(0);
  });
});

describe('boards, bulk, reports', () => {
  it('moves cards between columns and shows WIP', async () => {
    const b = await pm('POST', `${P()}/boards`, {
      name: 'Delivery', kind: 'kanban', swimlane: 'assignee',
      columns: [{ name: 'Backlog', categories: ['todo'] }, { name: 'Doing', categories: ['in_progress', 'blocked'], wip: 1 }, { name: 'QA', categories: ['review'] }, { name: 'Done', categories: ['done'] }],
      quickFilters: [{ name: 'Bugs', query: 'type = bug' }],
    });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    ids.board = b.json.id;
    const story2 = (await dev('GET', `${P()}/query?q=${encodeURIComponent('summary ~ "Driver login"')}`)).json.items[0];
    ids.story2 = story2.id;
    keys.story2 = story2.key;
    for (const t of [ids.story, ids.story2]) expect((await dev('POST', `${P()}/board/move`, { boardId: ids.board, taskId: t, column: 1 })).status).toBe(200);
    const d = (await dev('GET', `${P()}/board?boardId=${ids.board}`)).json;
    expect(d.columns[1]).toMatchObject({ name: 'Doing', count: 2, over: true });
    expect(d.items.find((i: Json) => i.id === ids.story).status).toBe('in_progress');
    expect((await dev('GET', `${P()}/board?boardId=${ids.board}&quick=0`)).json.items.every((i: Json) => i.workType === 'bug')).toBe(true);
    // a bug in "Closed" cannot be dragged back to Backlog: the bug flow has no such move
    expect((await dev('POST', `${P()}/board/move`, { boardId: ids.board, taskId: ids.bug, column: 0 })).status).toBe(400);
  });

  it('bulk edits and reports what it could not do', async () => {
    const sprint = await pm('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 1', startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10) });
    expect(sprint.status, JSON.stringify(sprint.json)).toBe(201);
    const r = await pm('POST', `${P()}/bulk`, { ids: [ids.story, ids.story2, ids.bug], set: { priority: 'urgent', sprintId: sprint.json.id, addLabels: ['q4'] } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.done).toBe(3);
    const s = await pm('POST', `${P()}/bulk`, { ids: [ids.story2, ids.bug], set: { status: 'review' } });
    expect(s.json.done).toBe(1);
    expect(s.json.failed[0].key).toBe(keys.bug);
    const q = (await pm('GET', `${P()}/query?q=${encodeURIComponent('sprint in openSprints() AND labels = q4 AND priority = urgent')}`)).json;
    expect(q.total).toBe(3);
  });

  it('draws cumulative flow, cycle time, workload and dashboard widgets from the history', async () => {
    const cfd = (await pm('GET', `${P()}/reports/cfd?days=7`)).json;
    expect(cfd.days).toHaveLength(7);
    const today = (s: string) => cfd.series.find((x: Json) => x.status === s).values.at(-1);
    expect(today('done')).toBe(1);
    expect(today('in_progress')).toBe(1);
    expect(today('review')).toBe(1);
    const cyc = (await pm('GET', `${P()}/reports/cycle?days=30`)).json;
    expect(cyc.items.map((i: Json) => i.key)).toEqual([keys.bug]);
    expect((await pm('GET', `${P()}/reports/workload`)).json.find((w: Json) => w.person === 'Dev Kumar').items).toBeGreaterThan(0);
    const w = await pm('POST', `${P()}/widget`, { id: 'a', type: 'breakdown', title: 'By type', query: 'status != cancelled', groupBy: 'type' });
    expect(w.json.groups.find((g: Json) => g.label === 'story').count).toBe(2);
    const dash = await pm('POST', `${P()}/dashboards`, { name: 'Team', widgets: (await pm('GET', `${P()}/dashboards`)).json.starter, shared: true });
    expect(dash.status, JSON.stringify(dash.json)).toBe(201);
  });
});

describe('code links', () => {
  it('links GitHub pull requests and moves items on merge; refuses bad signatures', async () => {
    expect((await dev('POST', '/api/admin/work/dev-connections', { provider: 'github', label: 'acme/fleet' })).status).toBe(403);
    const c = await pm('POST', '/api/admin/work/dev-connections', { provider: 'github', label: 'acme/fleet' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    expect((await pm('PUT', `${P()}/settings`, { autoTransitions: { prOpened: 'review', prMerged: 'done' } })).status).toBe(200);
    const path = new URL(c.json.webhookUrl).pathname;
    const send = async (event: string, body: Json, secret = c.json.secret) => {
      const raw = JSON.stringify(body);
      return h.app.request(`http://synapse.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${await hmacSha256Hex(secret, raw)}` }, body: raw }, h.env);
    };
    const pr = (action: string, merged: boolean) => ({
      action, repository: { full_name: 'acme/fleet', html_url: 'https://github.com/acme/fleet' },
      pull_request: { number: 7, title: `${keys.story2} driver login`, body: 'Also touches fleet-4', html_url: 'https://github.com/acme/fleet/pull/7', state: merged ? 'closed' : 'open', merged, draft: false, user: { login: 'devk' }, head: { ref: `feature/${keys.story2}-login` } },
    });
    expect((await send('pull_request', pr('opened', false), 'wrong')).status).toBe(401);
    const r1 = await send('pull_request', pr('opened', false));
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as Json).linked).toBe(2);
    let s = (await dev('GET', `${P()}/items/${ids.story2}`)).json;
    expect(s.links[0]).toMatchObject({ kind: 'pr', status: 'open', source: 'github', author: 'devk' });
    expect(s.item.status).toBe('review');
    await send('pull_request', pr('closed', true));
    s = (await dev('GET', `${P()}/items/${ids.story2}`)).json;
    expect(s.links).toHaveLength(1);
    expect(s.links[0].status).toBe('merged');
    expect(s.item.status).toBe('done');
    await send('push', { ref: 'refs/heads/main', repository: { full_name: 'acme/fleet', html_url: 'https://github.com/acme/fleet' }, commits: [{ id: 'abc123', message: `${keys.sub} tile cache`, url: 'https://github.com/acme/fleet/commit/abc123', author: { name: 'Dev' } }] });
    expect((await dev('GET', `${P()}/items/${ids.sub}`)).json.links[0]).toMatchObject({ kind: 'commit', title: `${keys.sub} tile cache` });
  });

  it('accepts Azure DevOps service hooks with basic authentication', async () => {
    const c = await pm('POST', '/api/admin/work/dev-connections', { provider: 'azure_repos', label: 'Azure' });
    const path = new URL(c.json.webhookUrl).pathname;
    const body = JSON.stringify({ eventType: 'build.complete', resource: { id: 55, result: 'failed', buildNumber: '20261119.1', sourceBranch: `refs/heads/feature/${keys.sub}`, definition: { name: 'CI' }, _links: { web: { href: 'https://dev.azure.com/acme/fleet/_build/results?buildId=55' } } } });
    const bad = await h.app.request(`http://synapse.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${btoa('synapse:nope')}` }, body }, h.env);
    expect(bad.status).toBe(401);
    const ok = await h.app.request(`http://synapse.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${btoa(`synapse:${c.json.secret}`)}` }, body }, h.env);
    expect(ok.status).toBe(200);
    const links = (await dev('GET', `${P()}/items/${ids.sub}`)).json.links as Json[];
    expect(links.find((l) => l.kind === 'build')).toMatchObject({ status: 'failed', source: 'azure' });
  });
});

describe('tests', () => {
  it('plans, runs and raises a bug from a failed case; shows coverage', async () => {
    const tc = await qa('POST', `${P()}/tests/cases`, { title: 'Trucks appear on the map', suite: 'Maps', steps: [{ action: 'Open the map', expected: 'Map loads' }, { action: 'Wait 60 s', expected: 'Positions refresh' }], itemIds: [ids.story] });
    expect(tc.status, JSON.stringify(tc.json)).toBe(201);
    const plan = await qa('POST', `${P()}/tests/plans`, { name: 'Sprint 1 regression', suite: 'Maps' });
    expect(plan.status).toBe(201);
    const d = (await qa('GET', `${P()}/tests/plans/${plan.json.id}`)).json;
    expect(d.runs).toHaveLength(1);
    const run = await qa('PUT', `${P()}/tests/plans/${plan.json.id}/runs/${tc.json.id}`, { result: 'failed', stepResults: ['passed', 'failed'], notes: 'Positions froze', createBug: true });
    expect(run.status, JSON.stringify(run.json)).toBe(200);
    expect(run.json.bugKey).toMatch(/^FLEET-\d+$/);
    const bug = (await qa('GET', `${P()}/items/${run.json.bugId}`)).json;
    expect(bug.item).toMatchObject({ workType: 'bug', priority: 'high' });
    expect(bug.item.description).toMatch(/2\. Wait 60 s → expected: Positions refresh {2}✗ FAILED/);
    expect(bug.relations[0].item.id).toBe(ids.story);
    const cov = (await qa('GET', `${P()}/tests/coverage`)).json as Json[];
    expect(cov.find((x) => x.id === ids.story)).toMatchObject({ cases: 1, failed: 1 });
    expect((await qa('GET', `${P()}/items/${ids.story}`)).json.tests[0]).toMatchObject({ last_result: 'failed' });
  });
});
