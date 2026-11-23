/** Coding agents over MCP: items queue, the agent claims, reports, asks for review; nothing is pushed before a person approves. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let key = '';
let rpcId = 1;

async function mcp(method: string, params: Json = {}) {
  const r = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: rpcId++, method, params }, headers: { authorization: `Bearer ${key}` } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}
async function tool(name: string, args: Json = {}) {
  const r = await mcp('tools/call', { name, arguments: args });
  const res = r.result;
  return { error: !!res.isError, text: res.content[0].text as string, data: res.isError ? null : (res.structuredContent as Json) };
}
async function sql(q: string, p: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, p));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_codingagent');
  await h.signup('cagent', 'owner@cagent.test');
  api = h.as('cagent', (await h.login('cagent', 'owner@cagent.test')).token);
  ids.tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'Fleet app' })).json.id;
  await sql(`update projects set status = 'active', work_key = 'FLEET' where id = $1`, [ids.project]);
  const k = await api('POST', '/api/admin/api-keys', { name: 'Claude Code', scopes: ['read', 'write'], rateLimitPerMin: 600 });
  expect(k.status, JSON.stringify(k.json)).toBe(201);
  key = k.json.key;
}, 120_000);

describe('coding agent over MCP', () => {
  it('speaks MCP', async () => {
    const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'sanchalanos' }, capabilities: { tools: {} } });
    const n = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, headers: { authorization: `Bearer ${key}` } });
    expect(n.status).toBe(202);
    const list = await mcp('tools/list');
    expect(list.result.tools.map((t: Json) => t.name)).toEqual(expect.arrayContaining(['next_work', 'request_review', 'review_status', 'complete', 'setup_project']));
    expect((await mcp('nope')).error.code).toBe(-32601);
    // no key, or a key of no workspace: "add your key", not "not found"
    const bare = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: 9, method: 'initialize', params: {} } });
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toMatch(/Bearer/);
    expect(bare.json.error).toMatchObject({ code: 'api_key_required', message: expect.stringMatching(/Authorization: Bearer syn_/) });
    // MCP clients look for OAuth metadata first: a JSON "not found", never the web page
    for (const p of ['/.well-known/oauth-protected-resource/api/v1/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const wk = await h.call('GET', p);
      expect(wk.status, p).toBe(404);
      expect(wk.headers.get('content-type')).toMatch(/json/);
    }
    const wrong = await h.call('POST', '/api/v1/mcp', { body: {}, headers: { authorization: `Bearer syn_nosuchplace_${'x'.repeat(40)}` } });
    expect(wrong.json.error.message).toMatch(/does not belong/);
  });

  it('queues items once switched on, and hands the next one to the agent with the project setup', async () => {
    // these items are not given to HRP AI by default (that queues them: see the HRP AI test)
    expect((await api('PUT', `/api/v1/projects/${ids.project}/default-assignee`, { value: 'none' })).status).toBe(200);
    // off: nothing queued
    await api('POST', `/api/v1/projects/${ids.project}/work/items`, { name: 'Ignored before switching on', workType: 'story' });
    expect(await sql(`select 1 from coding_agent_jobs`)).toEqual([]);
    const s = await api('PUT', `/api/v1/projects/${ids.project}/agent/settings`, { enabled: true, workTypes: ['story', 'bug'], onCreate: true, onUpdate: true, autoPush: false, instructions: 'pnpm test', localFolder: 'fleet-app' });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const it1 = await api('POST', `/api/v1/projects/${ids.project}/work/items`, { name: 'Export trip sheets to Excel', workType: 'story', description: 'As a fleet manager I want…' });
    expect(it1.status, JSON.stringify(it1.json)).toBe(201);
    ids.item = it1.json.id;
    await api('POST', `/api/v1/projects/${ids.project}/work/items`, { name: 'An epic is not queued', workType: 'epic' });
    expect((await api('GET', `/api/v1/projects/${ids.project}/agent`)).json.jobs.map((j: Json) => [j.name, j.status, j.reason])).toEqual([['Export trip sheets to Excel', 'queued', 'created']]);

    const none = await tool('next_work', { agent: 'claude-code@laptop', project: 'NOPE' });
    expect(none.data).toEqual({ job: null });
    const w = await tool('next_work', { agent: 'claude-code@laptop' });
    expect(w.error, w.text).toBe(false);
    ids.job = w.data!.job.jobId;
    expect(w.data!.job.item).toMatchObject({ key: 'FLEET-2', type: 'story', title: 'Export trip sheets to Excel', description: 'As a fleet manager I want…' });
    expect(w.data!.job.setup).toMatchObject({ localFolder: 'fleet-app', instructions: 'pnpm test', project: { key: 'FLEET' } });
    // the agent's own move to "in progress" does not queue it again
    expect((await sql(`select status from project_tasks where id = $1`, [ids.item]))[0]!.status).toBe('in_progress');
    expect((await sql(`select count(*)::int as n from coding_agent_jobs`))[0]!.n).toBe(1);
    expect((await tool('next_work', { agent: 'other' })).data).toEqual({ job: null });
  });

  it('reports, sees edits, waits for review; pushing needs approval', async () => {
    expect((await tool('report_progress', { jobId: ids.job, stage: 'working', message: 'Branch created', branch: 'sanchalan/FLEET-2-export' })).data).toMatchObject({ ok: true, itemChanged: null });
    // a person edits the story meanwhile
    await api('PATCH', `/api/v1/projects/${ids.project}/work/items/${ids.item}`, { description: 'As a fleet manager I want… (also PDF)' });
    expect((await tool('report_progress', { jobId: ids.job, stage: 'tests_passed', message: '42 passed' })).data!.itemChanged).toMatch(/edited/);
    const rv = await tool('request_review', { jobId: ids.job, summary: 'Added Excel and PDF export', branch: 'sanchalan/FLEET-2-export', testReport: '42 passed', howToVerify: 'Open Trips → Export' });
    expect(rv.data).toMatchObject({ status: 'awaiting_review' });
    expect((await sql(`select status from project_tasks where id = $1`, [ids.item]))[0]!.status).toBe('review');
    const early = await tool('complete', { jobId: ids.job, stage: 'pushed' });
    expect(early.error).toBe(true);
    expect(early.text).toMatch(/approve/i);
    expect((await tool('review_status', { jobId: ids.job })).data).toMatchObject({ status: 'awaiting_review' });
    // the person asks for a change, then approves
    expect((await api('POST', `/api/v1/agent/jobs/${ids.job}/review`, { verdict: 'changes' })).status).toBe(400);
    expect((await api('POST', `/api/v1/agent/jobs/${ids.job}/review`, { verdict: 'changes', note: 'Name the file trips-<month>.xlsx' })).json.status).toBe('changes_requested');
    const again = await tool('next_work', { agent: 'claude-code@laptop' });
    expect(again.data!.job).toMatchObject({ jobId: ids.job, reason: 'changes_requested', reviewNote: 'Name the file trips-<month>.xlsx', branch: 'sanchalan/FLEET-2-export' });
    await tool('request_review', { jobId: ids.job, summary: 'Renamed the file', branch: 'sanchalan/FLEET-2-export' });
    expect((await api('POST', `/api/v1/agent/jobs/${ids.job}/review`, { verdict: 'approve' })).json.status).toBe('approved');
    expect((await tool('review_status', { jobId: ids.job })).data).toMatchObject({ status: 'approved' });
    expect((await tool('complete', { jobId: ids.job, stage: 'pushed', commitSha: 'abc1234def', prUrl: 'https://github.com/hrp/fleet/pull/7', branch: 'sanchalan/FLEET-2-export' })).data).toMatchObject({ status: 'pushed' });
    expect((await tool('complete', { jobId: ids.job, stage: 'released', message: 'Deployed' })).data).toMatchObject({ status: 'released' });
    expect((await sql(`select status from project_tasks where id = $1`, [ids.item]))[0]!.status).toBe('done');
    const d = (await api('GET', `/api/v1/agent/jobs/${ids.job}`)).json;
    expect(d.events.map((e: Json) => e.stage)).toEqual(['claimed', 'working', 'tests_passed', 'review_requested', 'changes_requested', 'claimed', 'review_requested', 'approved', 'pushed', 'released']);
    const links = await sql(`select kind, url from project_task_links where task_id = $1`, [ids.item]);
    expect(links).toEqual([{ kind: 'pr', url: 'https://github.com/hrp/fleet/pull/7' }]);
    // the comments the people see — and they are shown as HRP AI, not the key's owner
    const rows = await sql(`select c.body, u.is_agent, u.full_name from project_comments c join users u on u.id = c.user_id where c.task_id = $1 order by c.created_at`, [ids.item]);
    expect(rows.some((b) => b.body.includes('ready for review'))).toBe(true);
    const review = rows.find((b) => b.body.includes('ready for review'))!;
    expect(review.is_agent).toBe(true);
  });

  it('re-queues when a person changes or reopens an item, and lets the agent file bugs and comment', async () => {
    // a done item renamed: left alone; an open one changed: queued
    await api('PATCH', `/api/v1/projects/${ids.project}/work/items/${ids.item}`, { name: 'Export trip sheets to Excel and PDF' });
    const older = (await sql(`select id from project_tasks where name = 'Ignored before switching on'`))[0]!.id;
    await api('PATCH', `/api/v1/projects/${ids.project}/work/items/${older}`, { description: 'Now with details' });
    const jobs = (await api('GET', `/api/v1/projects/${ids.project}/agent`)).json.jobs as Json[];
    expect(jobs.filter((j) => j.status === 'queued').map((j) => j.reason)).toEqual(['updated']);
    const b = await tool('create_work_item', { project: 'FLEET', type: 'bug', title: 'Export fails for empty months' });
    expect(b.error, b.text).toBe(false);
    // filed by the agent: not sent back to it
    expect((await sql(`select count(*)::int as n from coding_agent_jobs where status = 'queued'`))[0]!.n).toBe(1);
    expect((await tool('add_comment', { key: 'FLEET-2', body: 'Should the PDF be landscape?' })).error).toBe(false);
    expect((await tool('get_work_item', { key: 'FLEET-2' })).data!.comments.at(-1).body).toMatch(/landscape/);
    expect((await tool('setup_project', { project: 'fleet' })).data).toMatchObject({ localFolder: 'fleet-app', repos: [] });
  });

  it('queues the open items of the board on request, bugs first, each once', async () => {
    const q = await tool('queue_board', { project: 'FLEET', workTypes: ['bug', 'task', 'story'] });
    expect(q.error, q.text).toBe(false);
    // the bug the agent filed was not queued by itself; asked for, it goes first; items already queued are left alone
    expect(q.data!.items[0]).toMatchObject({ type: 'bug', title: 'Export fails for empty months' });
    expect(q.data!.items.map((i: Json) => i.title)).not.toContain('Ignored before switching on');
    expect((await tool('queue_board', { project: 'FLEET' })).data!.queued).toBe(0);
    const web = await api('POST', `/api/v1/projects/${ids.project}/agent/queue-open`, {});
    expect(web.json.queued).toBe(0);
    expect((await tool('next_work', { agent: 'claude-code@test', project: 'FLEET' })).data!.job).toBeTruthy();
  });

  it('ties a repository to one project: its key or X-Sanchalan-Project limits every tool to that project', async () => {
    const other = (await api('POST', '/api/v1/records/project', { name: 'Billing portal' })).json.id;
    await sql(`update projects set status = 'active', work_key = 'BILL' where id = $1`, [other]);
    await api('PUT', `/api/v1/projects/${other}/agent/settings`, { enabled: true, workTypes: ['bug', 'task', 'story'], onCreate: true, onUpdate: true, autoPush: false });
    const billBug = await api('POST', `/api/v1/projects/${other}/work/items`, { name: 'Invoice total off by one paisa', workType: 'bug' });
    expect(billBug.status, JSON.stringify(billBug.json)).toBeLessThan(300);

    // a key made for FLEET's repository
    const made = await api('POST', `/api/v1/projects/${ids.project}/agent/keys`, { name: 'Laptop' });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const repoKey = made.json.key as string;
    const as = async (name: string, args: Json = {}, headers: Record<string, string> = {}) => {
      const r = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${repoKey}`, ...headers } });
      const res = r.json.result;
      return { error: !!res?.isError, text: res?.content?.[0]?.text as string, data: res?.isError ? null : (res?.structuredContent as Json) };
    };
    expect((await as('list_projects')).data!.result.map((p: Json) => p.project.key)).toEqual(['FLEET']);
    // no project named: FLEET
    expect((await as('setup_project')).data!.project.key).toBe('FLEET');
    // another project's items, jobs and queue are out of reach
    expect((await as('get_work_item', { key: 'BILL-1' })).text).toMatch(/linked to the project “Fleet app” only/);
    expect((await as('queue_board', { project: 'BILL' })).error).toBe(true);
    expect((await as('create_work_item', { project: 'BILL', type: 'bug', title: 'x' })).error).toBe(true);
    const job = await as('next_work', { agent: 'claude-code@laptop' });
    expect(job.data!.job === null || job.data!.job.item.key.startsWith('FLEET-')).toBe(true);
    // the key is for the coding agent only
    expect((await h.call('GET', '/api/v1/projects', { headers: { authorization: `Bearer ${repoKey}` } })).status).toBe(403);
    // a header naming another project is refused
    expect((await as('list_projects', {}, { 'x-sanchalan-project': 'BILL' })).text).toMatch(/This key is for the project/);

    // the person's general key, tied by the repository's settings
    const r = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }, headers: { authorization: `Bearer ${key}`, 'x-sanchalan-project': 'BILL' } });
    expect(r.json.result.structuredContent.result.map((p: Json) => p.project.key)).toEqual(['BILL']);
    const own = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'get_work_item', arguments: { key: 'FLEET-1' } } }, headers: { authorization: `Bearer ${key}`, 'x-sanchalan-project': 'BILL' } });
    expect(own.json.result.isError).toBe(true);

    // one repository per project
    expect((await api('POST', `/api/v1/projects/${other}/work/repos`, { provider: 'github', repo: 'hrp/billing-portal' })).status).toBeLessThan(300);
    const second = await api('POST', `/api/v1/projects/${other}/work/repos`, { provider: 'github', repo: 'hrp/billing-admin' });
    expect(second.status).toBe(400);
    expect(second.json.error.message).toMatch(/linked to hrp\/billing-portal/);

    // revoked: it stops working
    expect((await api('DELETE', `/api/v1/projects/${ids.project}/agent/keys/${made.json.id}`)).status).toBe(200);
    expect((await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { authorization: `Bearer ${repoKey}` } })).status).toBe(401);
  });

  it('HRP AI: new work goes to the coding agent by default; assigning it queues the item', async () => {
    const pid = (await api('POST', '/api/v1/records/project', { name: 'Driver app' })).json.id;
    await sql(`update projects set status = 'active', work_key = 'DRV' where id = $1`, [pid]);
    const g = (await api('GET', `/api/v1/projects/${pid}`)).json;
    expect(g.agent).toMatchObject({ name: 'HRP AI' });
    expect(g.defaultAssignee).toBe('agent');
    // nobody chosen: HRP AI, and it is queued (the project's agent switched on with it)
    const it = await api('POST', `/api/v1/projects/${pid}/work/items`, { name: 'Login with OTP', workType: 'story' });
    expect(it.status, JSON.stringify(it.json)).toBe(201);
    expect((await sql(`select assignees from project_tasks where id = $1`, [it.json.id]))[0]!.assignees).toEqual([g.agent.id]);
    expect((await sql(`select reason, status from coding_agent_jobs where task_id = $1`, [it.json.id]))[0]).toMatchObject({ reason: 'assigned', status: 'queued' });
    expect((await sql(`select enabled from coding_agent_settings where project_id = $1`, [pid]))[0]!.enabled).toBe(true);
    // an epic is not coding work
    const ep = await api('POST', `/api/v1/projects/${pid}/work/items`, { name: 'Onboarding', workType: 'epic' });
    expect((await sql(`select assignees from project_tasks where id = $1`, [ep.json.id]))[0]!.assignees).toEqual([]);
    // assigning an existing item to HRP AI queues it
    await api('PUT', `/api/v1/projects/${pid}/default-assignee`, { value: 'none' });
    const mine = await api('POST', `/api/v1/projects/${pid}/work/items`, { name: 'Profile photo upload', workType: 'task' });
    expect((await sql(`select assignees from project_tasks where id = $1`, [mine.json.id]))[0]!.assignees).toEqual([]);
    // (the agent is on for this project now, so it was queued as created; assigning marks it as given to HRP AI)
    expect((await sql(`select reason from coding_agent_jobs where task_id = $1`, [mine.json.id]))[0]!.reason).toBe('created');
    const upd = await api('PATCH', `/api/v1/projects/${pid}/tasks/${mine.json.id}`, { assignees: [g.agent.id] });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect((await sql(`select reason from coding_agent_jobs where task_id = $1`, [mine.json.id]))[0]!.reason).toBe('assigned');
    // no notifications or mail for it; not among the people an admin manages
    expect(await sql(`select 1 from notifications where user_id = $1`, [g.agent.id])).toEqual([]);
    expect(((await api('GET', '/api/admin/users')).json.items as Json[]).some((u) => u.id === g.agent.id)).toBe(false);
    expect(((await api('GET', '/api/v1/users')).json.items as Json[]).find((u) => u.id === g.agent.id)).toMatchObject({ is_agent: true });
    // a person as the default instead
    expect((await api('PUT', `/api/v1/projects/${pid}/default-assignee`, { value: g.agent.id === 'x' ? 'none' : '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
  });

  it('all at once: takes every waiting item, then one review round; approve all in one go', async () => {
    const pid = (await api('POST', '/api/v1/records/project', { name: 'Batch app' })).json.id;
    await sql(`update projects set status = 'active', work_key = 'BAT' where id = $1`, [pid]);
    const s = await api('PUT', `/api/v1/projects/${pid}/agent/settings`, { enabled: true, workTypes: ['story', 'bug', 'task'], onCreate: true, onUpdate: true, autoPush: false, workMode: 'batch', batchSize: 10 });
    expect(s.json).toMatchObject({ workMode: 'batch', batchSize: 10 });
    for (const n of ['Login', 'Signup', 'Logout']) expect((await api('POST', `/api/v1/projects/${pid}/work/items`, { name: n, workType: 'story' })).status).toBe(201);
    // the project works in batches: next_work hands over all three
    const b = await tool('next_work', { agent: 'claude-code@batch', project: 'BAT' });
    expect(b.error, b.text).toBe(false);
    expect(b.data!.jobs.map((j: Json) => j.item.title)).toEqual(['Login', 'Signup', 'Logout']);
    expect(b.data!.setup.workMode).toBe('batch');
    expect(b.data!.next).toMatch(/review_status_all/);
    for (const j of b.data!.jobs) expect((await tool('request_review', { jobId: j.jobId, summary: `Did ${j.item.title}`, branch: 'agent/batch' })).error).toBe(false);
    let all = await tool('review_status_all', { project: 'BAT' });
    expect(all.data).toMatchObject({ awaiting: 3 });
    // the person approves them all at once
    const ok = await api('POST', `/api/v1/projects/${pid}/agent/approve-all`, {});
    expect(ok.json).toEqual({ approved: 3 });
    all = await tool('review_status_all', { project: 'BAT' });
    expect(all.data!.awaiting).toBe(0);
    expect(all.data!.jobs.map((j: Json) => j.status)).toEqual(['approved', 'approved', 'approved']);
    // nothing left: an empty batch
    expect((await tool('next_work', { agent: 'claude-code@batch', project: 'BAT' })).data).toMatchObject({ job: null, jobs: [] });
    // one-at-a-time projects can still be asked for everything
    await api('PUT', `/api/v1/projects/${pid}/agent/settings`, { enabled: true, workTypes: ['story', 'bug', 'task'], onCreate: true, onUpdate: true, autoPush: false, workMode: 'one' });
    await api('POST', `/api/v1/projects/${pid}/work/items`, { name: 'Forgot password', workType: 'story' });
    await api('POST', `/api/v1/projects/${pid}/work/items`, { name: 'Change password', workType: 'story' });
    expect((await tool('next_work', { agent: 'claude-code@batch', project: 'BAT', all: true })).data!.jobs).toHaveLength(2);
  });
});
