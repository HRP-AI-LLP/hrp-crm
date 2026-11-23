/**
 * Round 24: automation rules, email alerts, templates, live stamp, attachments, more reports, the
 * portfolio roadmap, the workspace repository rule, and the GitHub App (install, repository picker,
 * check runs on pull requests, required check, branches).
 */
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { Db } from '../src/lib/db';
import { queueDueSoon, workMailSweep } from '../src/services/it/alerts';
import { scheduledRulesSweep } from '../src/services/it/rules';
import { fakeR2, type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let pm: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
let tenantId = '';
const ids: Record<string, string> = {};
const P = (p = ids.project) => `/api/v1/projects/${p}/work`;
const realFetch = globalThis.fetch;
const gh: string[] = [];
const ghBodies: Record<string, Json> = {};
let protection: Json | null = null;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}
async function item(who: typeof pm, body: Json, project = ids.project) {
  const r = await who('POST', `${P(project)}/items`, body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; key: string };
}
const getItem = async (id: string | undefined) => (await pm('GET', `${P()}/items/${id}`)).json;

beforeAll(async () => {
  h = await makeHarness('synapse_test_work_automation');
  await h.signup('acme', 'owner@acme.test');
  pm = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await pm('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  const me = (await pm('GET', '/api/auth/me')).json;
  tenantId = me.tenant.id;
  ids.pm = me.user.id;
  ids.dev = (await pm('POST', '/api/admin/users', { email: 'dev@acme.test', fullName: 'Dev Kumar', password: PW, roles: ['sales_rep'] })).json.id;
  ids.qa = (await pm('POST', '/api/admin/users', { email: 'qa@acme.test', fullName: 'Quinn Tester', password: PW, roles: ['sales_rep'] })).json.id;
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  ids.project = (await pm('POST', '/api/v1/records/project', { name: 'Fleet portal', project_code: 'FLEET' })).json.id;
  await pm('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member' }, { userId: ids.qa, role: 'member' }] });
  h.env.FILES = fakeR2() as unknown as R2Bucket;

  // the GitHub App, with a throwaway key
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  Object.assign(h.env, { GITHUB_APP_ID: '424242', GITHUB_APP_SLUG: 'synapse-test', GITHUB_APP_PRIVATE_KEY: forge.pki.privateKeyToPem(keys.privateKey), GITHUB_APP_WEBHOOK_SECRET: 'app-hook-secret' });
  const json = (o: unknown, status = 200) => new Response(o === null ? '' : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://api.github.com/')) return realFetch(input, init);
    const m = `${init?.method ?? 'GET'} ${url.slice('https://api.github.com'.length)}`;
    gh.push(m);
    if (init?.body) ghBodies[m] = JSON.parse(String(init.body));
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? '');
    if (m === 'GET /app/installations/777') {
      // the app's JWT: three parts, RS256, issued by the app id
      const [head, body] = auth.replace('Bearer ', '').split('.');
      expect(JSON.parse(atob(head!.replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ alg: 'RS256' });
      expect(JSON.parse(atob(body!.replace(/-/g, '+').replace(/_/g, '/'))).iss).toBe('424242');
      return json({ id: 777, account: { login: 'acme-org', type: 'Organization' } });
    }
    if (m === 'POST /app/installations/777/access_tokens') return json({ token: 'ghs_install', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    expect(auth).toBe('Bearer ghs_install');
    if (m.startsWith('GET /installation/repositories')) return json({ total_count: 2, repositories: [{ full_name: 'acme-org/fleet', private: true, default_branch: 'main', archived: false }, { full_name: 'acme-org/website', private: false, default_branch: 'master', archived: false }] });
    if (m === 'POST /repos/acme-org/fleet/check-runs') return json({ id: 1 }, 201);
    if (m === 'GET /repos/acme-org/fleet/branches/main/protection') return protection ? json(protection) : json({ message: 'Branch not protected' }, 404);
    if (m === 'PUT /repos/acme-org/fleet/branches/main/protection') return (protection = { required_status_checks: { strict: false, checks: ghBodies[m]!.required_status_checks.checks } }), json(protection);
    if (m === 'PATCH /repos/acme-org/fleet/branches/main/protection/required_status_checks') return json({});
    if (m === 'GET /repos/acme-org/fleet/git/ref/heads/main') return json({ object: { sha: 'abc123' } });
    if (m === 'POST /repos/acme-org/fleet/git/refs') return ghBodies[m]!.ref === 'refs/heads/taken' ? json({ message: 'Reference already exists' }, 422) : json({ ref: ghBodies[m]!.ref }, 201);
    return json({ message: `unmocked ${m}` }, 404);
  });
}, 120_000);

afterAll(() => vi.unstubAllGlobals());

describe('automation rules', () => {
  it('runs WHEN → IF → THEN on new items, with smart values', async () => {
    const r = await pm('POST', `${P()}/rules`, {
      name: 'Urgent bugs to triage',
      trigger: 'created',
      triggerConfig: { types: ['bug'] },
      condition: 'priority in (high, urgent)',
      actions: [
        { type: 'assign', mode: 'least_busy' },
        { type: 'set', field: 'add_label', value: 'triage' },
        { type: 'comment', body: 'Triage {{key}} ({{priority}}) today' },
        { type: 'notify', to: ['assignee'], title: 'Urgent: {{summary}}' },
        { type: 'create_child', workType: 'subtask', name: 'Write a test for {{key}}', assignToParent: true },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.rule1 = r.json.id;
    // managers only; the condition must be a valid query
    expect((await dev('POST', `${P()}/rules`, { name: 'x', trigger: 'created', actions: [{ type: 'comment', body: 'x' }] })).status).toBe(403);
    expect((await pm('POST', `${P()}/rules`, { name: 'x', trigger: 'created', condition: 'priority ~~ high', actions: [{ type: 'comment', body: 'x' }] })).status).toBe(400);
    expect((await pm('POST', `${P()}/rules`, { name: 'x', trigger: 'scheduled', actions: [{ type: 'comment', body: 'x' }] })).status).toBe(400);

    const bug = await item(dev, { name: 'Map crashes on zoom', workType: 'bug', priority: 'high' });
    ids.bug = bug.id;
    const d = await getItem(bug.id);
    expect(d.item.assignees).toHaveLength(1);
    expect(d.item.tags).toContain('triage');
    expect(d.comments.map((c: Json) => c.body)).toContain(`🤖 Urgent bugs to triage: Triage ${bug.key} (high) today`);
    expect(d.children[0]).toMatchObject({ name: `Write a test for ${bug.key}` });
    expect(d.children[0].assignees).toEqual(d.item.assignees);
    // not a match: no rule
    const low = await item(dev, { name: 'Typo', workType: 'bug', priority: 'low' });
    expect((await getItem(low.id)).item.tags).not.toContain('triage');
    const runs = (await pm('GET', `${P()}/rules`)).json;
    expect(runs.rules[0]).toMatchObject({ run_count: 1, last_error: null });
    expect(runs.runs[0]).toMatchObject({ status: 'done' });
    ids.bug = bug.id;
  });

  it('fires on state changes and field changes, and stops loops', async () => {
    await pm('POST', `${P()}/rules`, { name: 'Done → thank', trigger: 'state_changed', triggerConfig: { toCategory: 'done' }, actions: [{ type: 'comment', body: 'Closed {{key}} in {{state}}' }, { type: 'watch', userIds: [ids.qa] }] });
    // a rule that changes the field it listens to: kept from looping
    await pm('POST', `${P()}/rules`, { name: 'Escalate', trigger: 'field_changed', triggerConfig: { field: 'priority' }, actions: [{ type: 'set', field: 'priority', value: 'urgent' }] });
    const story = await item(pm, { name: 'Driver login', workType: 'story' });
    expect((await pm('PATCH', `${P()}/items/${story.id}`, { priority: 'high' })).status).toBe(200);
    expect((await getItem(story.id)).item.priority).toBe('urgent');
    const moved = await pm('POST', `${P()}/items/${story.id}/transition`, { to: 'done' });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const d = await getItem(story.id);
    expect(d.comments.some((c: Json) => /Closed FLEET-\d+ in Done/.test(c.body))).toBe(true);
    expect(d.watchers.map((w: Json) => w.user_id)).toContain(ids.qa);
    // a failing rule never undoes the change, and is logged
    const bad = (await pm('POST', `${P()}/rules`, { name: 'Bad', trigger: 'commented', actions: [{ type: 'transition', to: 'done' }, { type: 'set', field: 'points', value: -5 }] })).json;
    expect((await pm('POST', `${P()}/items/${ids.bug}/comments`, { body: 'Looking' })).status).toBe(201);
    const rules = (await pm('GET', `${P()}/rules`)).json.rules as Json[];
    expect(rules.find((r) => r.id === bad.id)!.last_error).toBeTruthy();
    expect((await getItem(ids.bug)).comments.map((c: Json) => c.body)).toContain('Looking');
    await pm('DELETE', `${P()}/rules/${bad.id}`);
  });

  it('runs scheduled rules over the items their query finds, and on demand', async () => {
    const s = await pm('POST', `${P()}/rules`, { name: 'Nightly stale check', trigger: 'scheduled', triggerConfig: { hour: 0 }, condition: 'status != done and type = bug', actions: [{ type: 'set', field: 'add_label', value: 'stale-check' }] });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const db = Db.fromEnv(h.env);
    try {
      await scheduledRulesSweep(h.env, db);
      await scheduledRulesSweep(h.env, db); // once a day only
    } finally {
      await db.close();
    }
    expect((await getItem(ids.bug)).item.tags).toContain('stale-check');
    const n = await sql(`select run_count from pm_rules where id = $1`, [s.json.id]);
    expect(n[0]!.run_count).toBeGreaterThanOrEqual(2);
    // "run now" on one item
    const key = (await getItem(ids.bug)).item.key;
    const now = await pm('POST', `${P()}/rules/${ids.rule1}/run`, { key });
    expect(now.status, JSON.stringify(now.json)).toBe(200);
  });
});

describe('email alerts', () => {
  it('keeps preferences and queues mail by them', async () => {
    expect((await dev('GET', '/api/v1/work/alerts/prefs')).json).toMatchObject({ assigned: 'instant', mentioned: 'instant', watching: 'digest', due: 'digest', digestHour: 9 });
    expect((await dev('PUT', '/api/v1/work/alerts/prefs', { watching: 'off', digestHour: 18 })).status).toBe(200);
    expect((await dev('GET', '/api/v1/work/alerts/prefs')).json).toMatchObject({ watching: 'off', digestHour: 18 });
    expect((await dev('PUT', '/api/v1/work/alerts/prefs', { assigned: 'sometimes' })).status).toBe(400);
    await sql(`delete from pm_outbox`);
    const t = await item(pm, { name: 'Export trips', workType: 'story', assignees: [ids.dev] });
    await pm('POST', `${P()}/items/${t.id}/comments`, { body: `@[Dev Kumar](${ids.dev}) please check` });
    const out = await sql(`select user_id, category, mode, title, link from pm_outbox order by created_at`);
    expect(out.filter((o) => o.user_id === ids.dev).map((o) => `${o.category}:${o.mode}`)).toEqual(expect.arrayContaining(['assigned:instant', 'mentioned:instant']));
    expect(out.find((o) => o.category === 'assigned')!.link).toBe(`/projects/${ids.project}?item=${t.id}`);
    // due soon goes to the digest
    await pm('PATCH', `${P()}/items/${t.id}`, { dueDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) });
    const db = Db.fromEnv(h.env);
    try {
      await queueDueSoon(db, tenantId);
      await h.env.CACHE_KV?.put('pmmail:any', '1');
      await workMailSweep(h.env, db);
    } finally {
      await db.close();
    }
    const after = await sql(`select category, mode, sent_at from pm_outbox where user_id = $1`, [ids.dev]);
    expect(after.some((o) => o.category === 'due' && o.mode === 'digest')).toBe(true);
    // instant mail went out (marked sent); the digest waits for 18:00 IST unless it is that hour
    expect(after.filter((o) => o.mode === 'instant').every((o) => o.sent_at)).toBe(true);
  });
});

describe('templates', () => {
  it('applies the built-in Scrum template, saves a project as a template and applies it elsewhere', async () => {
    const list = (await pm('GET', '/api/v1/work/templates')).json as Json[];
    expect(list.map((t) => t.id)).toEqual(expect.arrayContaining(['builtin:scrum', 'builtin:kanban']));
    const p2 = (await pm('POST', '/api/v1/records/project', { name: 'Billing revamp', project_code: 'BILL' })).json.id;
    const a = await pm('POST', `${P(p2)}/templates/apply`, { templateId: 'builtin:scrum' });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json.workflows).toBeGreaterThan(0);
    expect(a.json.rules).toBeGreaterThan(0);
    const setup = (await pm('GET', `${P(p2)}/setup`)).json;
    expect(setup.workflows.length).toBeGreaterThan(0);
    expect(setup.fields.map((f: Json) => f.key)).toContain('acceptance');
    // again: nothing duplicated
    const again = (await pm('POST', `${P(p2)}/templates/apply`, { templateId: 'builtin:scrum' })).json;
    expect(again.workflows).toBe(0);
    expect(again.skipped.length).toBeGreaterThan(0);
    // save as a template, apply to a third project
    const saved = await pm('POST', `${P(p2)}/templates`, { name: 'Our delivery', description: 'Scrum as we run it' });
    expect(saved.status).toBe(201);
    expect((await pm('POST', `${P(p2)}/templates`, { name: 'our delivery' })).status).toBe(400);
    const p3 = (await pm('POST', '/api/v1/records/project', { name: 'Ops tools', project_code: 'OPS' })).json.id;
    const b = (await pm('POST', `${P(p3)}/templates/apply`, { templateId: saved.json.id })).json;
    expect(b.workflows).toBeGreaterThan(0);
    expect((await dev('POST', `${P(p3)}/templates/apply`, { templateId: 'builtin:kanban' })).status).toBeGreaterThanOrEqual(403);
    expect((await pm('DELETE', `/api/v1/work/templates/${saved.json.id}`)).status).toBe(200);
  });
});

describe('live stamp, attachments, reports and the roadmap', () => {
  it('changes the stamp when work changes', async () => {
    const a = (await dev('GET', `${P()}/stamp`)).json.stamp;
    expect((await dev('GET', `${P()}/stamp`)).json.stamp).toBe(a);
    await item(dev, { name: 'Another', workType: 'task' });
    expect((await dev('GET', `${P()}/stamp`)).json.stamp).not.toBe(a);
  });

  it('keeps files on a work item', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(64).fill(0)]);
    const token = (await h.login('acme', 'dev@acme.test')).token;
    const up = await h.app.request(`http://synapse.test${P()}/items/${ids.bug}/files?name=screen.png`, { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${token}` }, body: png }, h.env);
    expect(up.status, await up.clone().text()).toBe(201);
    const f = (await up.json()) as Json;
    const files = (await dev('GET', `${P()}/items/${ids.bug}/files`)).json as Json[];
    expect(files[0]).toMatchObject({ id: f.id, name: 'screen.png', type: 'image/png' });
    expect(files[0]!.url).toMatch(/^\/api\/public\/files\//);
    // the history says so, and the description can show it inline
    expect((await pm('PATCH', `${P()}/items/${ids.bug}`, { description: `Steps:\n1. Zoom in\n\n![screen](file:${f.id})` })).status).toBe(200);
    expect((await getItem(ids.bug)).history.some((x: Json) => x.field === 'attachment' && x.to === 'screen.png')).toBe(true);
    expect((await dev('DELETE', `${P()}/items/${ids.bug}/files/${f.id}`)).status).toBe(200);
    expect((await dev('GET', `${P()}/items/${ids.bug}/files`)).json).toHaveLength(0);
  });

  it('reports time in status, the sprint and the release burn-up; the roadmap lists epics', async () => {
    const tis = (await pm('GET', `${P()}/reports/time-in-status?days=30`)).json;
    expect(tis.states.length).toBeGreaterThan(0);
    const sp = (await pm('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 1', startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10) })).json.id;
    const a = await item(pm, { name: 'Committed', workType: 'story', storyPoints: 3, sprintId: sp });
    expect((await pm('POST', `/api/v1/projects/${ids.project}/agile/sprints/${sp}/start`)).status).toBe(200);
    await item(pm, { name: 'Added later', workType: 'story', storyPoints: 2, sprintId: sp });
    await pm('POST', `${P()}/items/${a.id}/transition`, { to: 'done' });
    const rep = (await pm('GET', `${P()}/reports/sprint?sprintId=${sp}`)).json;
    expect(rep.totals).toMatchObject({ committed: 3, added: 2, completed: 3 });
    const rel = (await pm('POST', `/api/v1/projects/${ids.project}/agile/releases`, { name: 'v1', targetDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10) })).json.id;
    await pm('PATCH', `${P()}/items/${a.id}`, { releaseId: rel });
    const bu = (await pm('GET', `${P()}/reports/release-burnup?releaseId=${rel}`)).json;
    expect(bu.release.id).toBe(rel);
    expect(bu.scope.at(-1)).toBe(3);
    expect(bu.done.at(-1)).toBe(3);
    // widgets for dashboards
    for (const type of ['sprint', 'time_in_status', 'release_burnup']) expect((await pm('POST', `${P()}/widget`, { id: type, title: type, type })).status).toBe(200);
    const epic = await item(pm, { name: 'Fleet tracking', workType: 'epic' });
    await item(pm, { name: 'Live map', workType: 'story', parentId: epic.id, dueDate: new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10) });
    const road = (await dev('GET', '/api/v1/work/roadmap')).json.items as Json[];
    expect(road.find((r) => r.id === epic.id)).toMatchObject({ projectName: 'Fleet portal', total: 1, datesOwn: false });
    expect(road.find((r) => r.id === epic.id)!.due).toBeTruthy();
  });
});

describe('the repository rule', () => {
  it('stops work in projects without a repository when the workspace asks for it', async () => {
    expect((await dev('PUT', '/api/admin/work/policy', { requireRepo: true })).status).toBe(403);
    expect((await pm('PUT', '/api/admin/work/policy', { requireRepo: true })).status).toBe(200);
    expect((await pm('GET', '/api/admin/work/policy')).json.requireRepo).toBe(true);
    const r = await pm('POST', `${P()}/items`, { name: 'Blocked', workType: 'task' });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/repository/i);
    // a project with no code is exempt
    expect((await pm('PUT', `${P()}/settings`, { noCode: true })).status).toBe(200);
    expect((await pm('POST', `${P()}/items`, { name: 'Fine', workType: 'task' })).status).toBe(201);
    await pm('PUT', `${P()}/settings`, { noCode: false });
    await pm('PUT', '/api/admin/work/policy', { requireRepo: false });
  });
});

describe('the GitHub App', () => {
  it('installs on an organisation and lists its repositories', async () => {
    const st = (await pm('GET', '/api/admin/work/github')).json;
    expect(st).toMatchObject({ configured: true, slug: 'synapse-test', installations: [] });
    const u = (await pm('POST', '/api/admin/work/github/install')).json.url as string;
    expect(u).toMatch(/^https:\/\/github\.com\/apps\/synapse-test\/installations\/new\?state=/);
    const state = new URL(u).searchParams.get('state')!;
    // forged state is refused
    expect((await h.app.request('http://synapse.test/api/public/github/setup?installation_id=777&state=nope', {}, h.env)).status).toBeGreaterThanOrEqual(400);
    const back = await h.app.request(`http://synapse.test/api/public/github/setup?installation_id=777&setup_action=install&state=${encodeURIComponent(state)}`, { redirect: 'manual' }, h.env);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toMatch(/\/projects\?github=acme-org$/);
    expect((await pm('GET', '/api/admin/work/github')).json.installations[0]).toMatchObject({ installation_id: '777', account: 'acme-org' });
    const repos = (await dev('GET', '/api/v1/work/github/repos')).json as Json[];
    expect(repos.map((r) => r.fullName)).toEqual(['acme-org/fleet', 'acme-org/website']);
    expect(repos[0]).toMatchObject({ installationId: '777', linkedTo: null, defaultBranch: 'main' });
  });

  it('links a repository through the app and posts a check on pull requests', async () => {
    expect((await pm('POST', `${P()}/repos`, { provider: 'github', repo: 'acme-org/fleet', installationId: '999' })).status).toBe(400);
    const r = await pm('POST', `${P()}/repos`, { provider: 'github', repo: 'acme-org/fleet', policy: 'enforce', installationId: '777' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.repo = r.json.id;
    expect(((await dev('GET', '/api/v1/work/github/repos')).json as Json[])[0]!.linkedTo).toMatchObject({ projectId: ids.project });
    // one project, one repository: the website needs a project of its own
    const web = await pm('POST', `${P()}/repos`, { provider: 'github', repo: 'acme-org/website', policy: 'warn', installationId: '777' });
    expect(web.status).toBe(400);
    expect(web.json.error.message).toMatch(/linked to acme-org\/fleet/);
    const list = (await dev('GET', '/api/v1/work/github/repo-list')).json as Json;
    expect(list.repos.map((x: Json) => [x.fullName, x.linkedTo?.projectId ?? null])).toEqual([
      ['acme-org/fleet', ids.project],
      ['acme-org/website', null],
    ]);
    expect(list.installations[0]).toMatchObject({ account: 'acme-org', repos: 2, error: null });
    expect(list.installations[0].manageUrl).toMatch(/^https:\/\/github\.com\/.*installations\/777$/);
    expect(((await pm('GET', `${P()}/repos`)).json.repos as Json[]).map((x) => x.repo)).toEqual(['acme-org/fleet']);
    const bugKey = (await getItem(ids.bug)).item.key;
    const hook = async (event: string, body: Json, secret = 'app-hook-secret') => {
      const raw = JSON.stringify(body);
      return h.app.request('http://synapse.test/api/public/github/app', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': `sha256=${await hmacSha256Hex(secret, raw)}` }, body: raw }, h.env);
    };
    const pr = (n: number, title: string, ref: string, sha: string) => ({
      action: 'opened',
      number: n,
      installation: { id: 777 },
      repository: { full_name: 'acme-org/fleet' },
      pull_request: { number: n, title, body: '', html_url: `https://github.com/acme-org/fleet/pull/${n}`, state: 'open', merged: false, head: { ref, sha }, base: { ref: 'main' }, user: { login: 'devk' } },
      sender: { login: 'devk' },
    });
    expect((await hook('pull_request', pr(5, 'x', 'y', 'z'), 'wrong')).status).toBe(401);
    gh.length = 0;
    const ok = await hook('pull_request', pr(5, `${bugKey} fix zoom crash`, 'fix/zoom', 'sha-good'));
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect(gh).toContain('POST /repos/acme-org/fleet/check-runs');
    expect(ghBodies['POST /repos/acme-org/fleet/check-runs']).toMatchObject({ name: 'SanchalanOS work items', head_sha: 'sha-good', conclusion: 'success' });
    expect((await getItem(ids.bug)).links.some((l: Json) => l.kind === 'pr' && /pull\/5$/.test(l.url))).toBe(true);
    const bad = await hook('pull_request', pr(6, 'misc tweaks', 'tweaks', 'sha-bad'));
    expect(bad.status).toBe(200);
    expect(ghBodies['POST /repos/acme-org/fleet/check-runs']).toMatchObject({ head_sha: 'sha-bad', conclusion: 'failure' });
    // an installation for no workspace is ignored; ping answers
    expect(await (await hook('pull_request', { ...pr(7, 'x', 'y', 'z'), installation: { id: 31337 } })).json()).toMatchObject({ ignored: expect.any(String) });
    expect((await hook('ping', { zen: 'x' })).status).toBe(200);
  });

  it('makes the check required and creates branches from work items', async () => {
    protection = null;
    const req = await pm('POST', `${P()}/repos/${ids.repo}/require-check`);
    expect(req.status, JSON.stringify(req.json)).toBe(200);
    expect(req.json.already).toBe(false);
    expect(ghBodies['PUT /repos/acme-org/fleet/branches/main/protection']!.required_status_checks.checks).toEqual([{ context: 'SanchalanOS work items', app_id: 424242 }]);
    expect((await pm('POST', `${P()}/repos/${ids.repo}/require-check`)).json.already).toBe(true);
    // an existing rule with other checks: the check is added to them
    protection = { required_status_checks: { strict: true, checks: [{ context: 'ci/build', app_id: null }] } };
    await pm('POST', `${P()}/repos/${ids.repo}/require-check`);
    expect(ghBodies['PATCH /repos/acme-org/fleet/branches/main/protection/required_status_checks']).toEqual({ strict: true, checks: [{ context: 'ci/build', app_id: null }, { context: 'SanchalanOS work items', app_id: 424242 }] });
    // a rule without status checks is left alone
    protection = { enforce_admins: { enabled: true } };
    expect((await pm('POST', `${P()}/repos/${ids.repo}/require-check`)).status).toBe(400);
    expect((await dev('POST', `${P()}/repos/${ids.repo}/require-check`)).status).toBe(403);

    const br = await dev('POST', `${P()}/items/${ids.bug}/branch`, { repoId: ids.repo, name: 'bugfix/FLEET-1-zoom' });
    expect(br.status, JSON.stringify(br.json)).toBe(201);
    expect(br.json.url).toBe('https://github.com/acme-org/fleet/tree/bugfix/FLEET-1-zoom');
    expect(ghBodies['POST /repos/acme-org/fleet/git/refs']).toEqual({ ref: 'refs/heads/bugfix/FLEET-1-zoom', sha: 'abc123' });
    expect((await getItem(ids.bug)).links.some((l: Json) => l.kind === 'branch' && l.title === 'bugfix/FLEET-1-zoom')).toBe(true);
    expect((await dev('POST', `${P()}/items/${ids.bug}/branch`, { repoId: ids.repo, name: 'taken' })).status).toBe(400);
    expect((await dev('POST', `${P()}/items/${ids.bug}/branch`, { repoId: ids.repo, name: '../etc' })).status).toBe(400);

    // uninstalling in GitHub removes it here
    const raw = JSON.stringify({ action: 'deleted', installation: { id: 777, account: { login: 'acme-org' } } });
    const del = await h.app.request('http://synapse.test/api/public/github/app', { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'installation', 'x-hub-signature-256': `sha256=${await hmacSha256Hex('app-hook-secret', raw)}` }, body: raw }, h.env);
    expect(del.status).toBe(200);
    expect((await pm('GET', '/api/admin/work/github')).json.installations).toHaveLength(0);
  });
});
