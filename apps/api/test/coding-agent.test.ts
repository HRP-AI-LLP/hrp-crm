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
    const wrong = await h.call('POST', '/api/v1/mcp', { body: {}, headers: { authorization: `Bearer syn_nosuchplace_${'x'.repeat(40)}` } });
    expect(wrong.json.error.message).toMatch(/does not belong/);
  });

  it('queues items once switched on, and hands the next one to the agent with the project setup', async () => {
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
    // the comments the people see
    const comments = (await sql(`select body from project_comments where task_id = $1 order by created_at`, [ids.item])).map((c) => c.body);
    expect(comments.some((b) => b.includes('ready for review'))).toBe(true);
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
});
