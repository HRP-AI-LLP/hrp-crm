/** Code policy: projects linked to repositories; every commit / PR names a work item, or one is created from it. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { classify, codeKeys } from '../src/services/it/codepolicy';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let pm: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const P = () => `/api/v1/projects/${ids.project}/work`;

async function check(token: string, body: Json) {
  const res = await h.app.request('http://synapse.test/api/public/dev/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }, h.env);
  return { status: res.status, json: (await res.json()) as Json };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_codepolicy');
  await h.signup('acme', 'owner@acme.test');
  pm = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await pm('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.dev = (await pm('POST', '/api/admin/users', { email: 'dev@acme.test', fullName: 'Dev Kumar', password: PW, roles: ['sales_rep'] })).json.id;
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  ids.project = (await pm('POST', '/api/v1/records/project', { name: 'Fleet portal', project_code: 'FLEET' })).json.id;
  await pm('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member' }] });
  ids.story = (await pm('POST', `${P()}/items`, { name: 'Truck map', workType: 'story' })).json.id; // FLEET-1
  await pm('POST', `${P()}/components`, { name: 'Maps' });
  const sp = await pm('POST', `/api/v1/projects/${ids.project}/agile/sprints`, { name: 'Sprint 1', startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10) });
  ids.sprint = sp.json.id;
  await pm('PATCH', `${P()}/items/${ids.story}`, { sprintId: ids.sprint });
  expect((await pm('POST', `/api/v1/projects/${ids.project}/agile/sprints/${ids.sprint}/start`)).status).toBe(200);
}, 120_000);

describe('reading commit messages', () => {
  it('classifies conventional commits and finds keys', () => {
    expect(classify('fix(maps)!: tiles vanish at zoom 3\n\nOnly on Safari')).toEqual({ type: 'bug', scope: 'maps', title: 'Tiles vanish at zoom 3', body: 'Only on Safari' });
    expect(classify('feat: driver login').type).toBe('story');
    expect(classify('cr: export trips to Excel').type).toBe('cr');
    expect(classify('epic: billing').type).toBe('epic');
    expect(classify('Fixed crash on login').type).toBe('bug');
    expect(classify('update readme').type).toBe('task');
    expect(codeKeys(['FLEET-12 map, fleet-cr-3 export', 'feature/FLEET-7-x'])).toEqual({ items: [{ key: 'FLEET', number: 12 }, { key: 'FLEET', number: 7 }], crs: [{ key: 'FLEET', number: 3 }] });
  });
});

describe('repositories and the CI check', () => {
  it('links a repository to the project (managers only) and hands out its token once', async () => {
    expect((await dev('POST', `${P()}/repos`, { provider: 'github', repo: 'acme/fleet' })).status).toBe(403);
    const r = await pm('POST', `${P()}/repos`, { provider: 'github', repo: 'https://github.com/Acme/Fleet.git', policy: 'enforce' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.token).toMatch(/^[a-f0-9]{32}\.[A-Za-z0-9_-]+$/);
    ids.repo = r.json.id;
    ids.token = r.json.token;
    expect((await pm('POST', `${P()}/repos`, { provider: 'github', repo: 'acme/fleet' })).status).toBe(400);
    const list = (await dev('GET', `${P()}/repos`)).json;
    expect(list.repos[0]).toMatchObject({ repo: 'acme/fleet', policy: 'enforce' });
    expect(((await pm("GET", "/api/v1/projects")).json as Json[])[0]!.repos).toBe(1);
  });

  it('fails the check for a commit without a work item and links the one with a key', async () => {
    expect((await check('0'.repeat(32) + '.nopenopenopenope', { commits: [] })).status).toBe(401);
    expect((await check(ids.token!.replace(/\.(.+)$/, '.wrongwrongwrongwrong'), { commits: [] })).status).toBe(401);
    const r = await check(ids.token!, {
      event: 'push', branch: 'main',
      commits: [
        { sha: 'a'.repeat(40), message: 'FLEET-1 draw the map', author: 'Dev', email: 'dev@acme.test' },
        { sha: 'b'.repeat(40), message: 'quick tweak', author: 'Dev', email: 'dev@acme.test' },
        { sha: 'c'.repeat(40), message: 'Merge pull request #3 from acme/x', author: 'Dev' },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.ok).toBe(false);
    expect(r.json.results.map((x: Json) => x.status)).toEqual(['linked', 'missing', 'skipped']);
    expect(r.json.lines.join('\n')).toMatch(/✗ 1 without a work item/);
    const item = (await pm('GET', `${P()}/items/${ids.story}`)).json;
    expect(item.links[0]).toMatchObject({ kind: 'commit', source: 'github', url: `https://github.com/acme/fleet/commit/${'a'.repeat(40)}` });
    const missing = (await pm('GET', `${P()}/repos`)).json.missing as Json[];
    expect(missing.map((m) => m.title)).toEqual(['quick tweak']);
    ids.missing = missing[0]!.id;
    // linking it by hand clears it
    expect((await dev('POST', `${P()}/code-events/${ids.missing}/resolve`, { key: 'FLEET-1' })).status).toBe(200);
    expect((await pm('GET', `${P()}/repos`)).json.missing).toHaveLength(0);
  });

  it('creates the right item from the message when the policy is auto-create, once per commit', async () => {
    expect((await pm('PATCH', `${P()}/repos/${ids.repo}`, { policy: 'auto_create' })).status).toBe(200);
    const body = {
      event: 'push', branch: 'main',
      commits: [
        { sha: 'd'.repeat(40), message: 'fix(maps): tiles vanish at zoom 3\n\nSafari only', author: 'Dev Kumar', email: 'DEV@acme.test' },
        { sha: 'e'.repeat(40), message: 'cr: export trips to Excel', author: 'Client ask', email: 'someone@client.test' },
      ],
    };
    const r = await check(ids.token!, body);
    expect(r.json.ok).toBe(true);
    expect(r.json.results.map((x: Json) => x.status)).toEqual(['created', 'created']);
    expect(r.json.results[0].created).toBe('FLEET-2');
    expect(r.json.results[1].created).toBe('FLEET-CR-1');
    const again = await check(ids.token!, body);
    expect(again.json.results.map((x: Json) => x.created)).toEqual([null, null]);
    expect(again.json.results.map((x: Json) => x.keys)).toEqual([['FLEET-2'], ['FLEET-CR-1']]);
    const bug = (await pm('GET', `${P()}/query?q=${encodeURIComponent('labels = from-git')}`)).json.items as Json[];
    expect(bug).toHaveLength(1);
    expect(bug[0]).toMatchObject({ workType: 'bug', name: 'Tiles vanish at zoom 3', assignees: [ids.dev], sprintId: ids.sprint, priority: 'high' });
    const comps = (await pm('GET', `${P()}/setup`)).json.components as Json[];
    expect(bug[0]!.componentIds).toEqual([comps.find((c) => c.name === 'Maps')!.id]);
    const crs = (await pm('GET', `/api/v1/projects/${ids.project}/agile/change-requests`)).json;
    expect((Array.isArray(crs) ? crs : crs.items ?? crs.changeRequests).some((c: Json) => c.title === 'Export trips to Excel')).toBe(true);
  });

  it('passes a pull request through the items its branch commits named', async () => {
    await pm('PATCH', `${P()}/repos/${ids.repo}`, { policy: 'enforce' });
    await check(ids.token!, { event: 'push', branch: 'feature/map-zoom', commits: [{ sha: 'f'.repeat(40), message: 'FLEET-1 zoom levels' }] });
    const pr = await check(ids.token!, { event: 'pull_request', branch: 'feature/map-zoom', title: 'Zoom levels', pr: 9 });
    expect(pr.json.ok).toBe(true);
    expect(pr.json.results[0]).toMatchObject({ status: 'linked', keys: ['FLEET-1'] });
    const bad = await check(ids.token!, { event: 'pull_request', branch: 'tweaks', title: 'Misc', pr: 10 });
    expect(bad.json.ok).toBe(false);
  });

  it('applies the policy to webhook pushes too', async () => {
    await pm('PATCH', `${P()}/repos/${ids.repo}`, { policy: 'auto_create' });
    const c = await pm('POST', '/api/admin/work/dev-connections', { provider: 'github', label: 'acme' });
    const raw = JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'Acme/Fleet', html_url: 'https://github.com/acme/fleet' }, commits: [{ id: '1'.repeat(40), message: 'docs: deployment guide', url: 'https://github.com/acme/fleet/commit/1111', author: { name: 'Dev', email: 'dev@acme.test' } }] });
    const res = await h.app.request(`http://synapse.test${new URL(c.json.webhookUrl).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'push', 'x-hub-signature-256': `sha256=${await hmacSha256Hex(c.json.secret, raw)}` }, body: raw }, h.env);
    expect(res.status).toBe(200);
    const items = (await pm('GET', `${P()}/query?q=${encodeURIComponent('summary ~ "Deployment guide"')}`)).json.items as Json[];
    expect(items[0]).toMatchObject({ workType: 'task', tags: ['from-git'] });
  });
});

describe('setup files', () => {
  it('generates a workflow whose payload builds from a GitHub event, and a commit hook that works', async () => {
    const f = (await pm('GET', `${P()}/repos/${ids.repo}/setup`)).json;
    expect(f.githubWorkflow).toMatch(/SYNAPSE_TOKEN/);
    // the jq program of the workflow, run on a sample push event
    const jqProg = /payload=\$\(jq -c --arg ev "\$GITHUB_EVENT_NAME" --arg ref "\$GITHUB_REF_NAME" '([\s\S]+?)' "\$GITHUB_EVENT_PATH"\)/.exec(f.githubWorkflow)![1]!;
    const dir = mkdtempSync(join(tmpdir(), 'synapse-hook-'));
    writeFileSync(join(dir, 'event.json'), JSON.stringify({ pusher: { name: 'dev' }, compare: 'https://x', commits: [{ id: 'abc1234', message: 'FLEET-1 x', author: { name: 'Dev', email: 'd@x' }, url: 'https://u' }] }));
    const out = JSON.parse(execFileSync('jq', ['-c', '--arg', 'ev', 'push', '--arg', 'ref', 'main', jqProg, join(dir, 'event.json')]).toString());
    expect(out).toMatchObject({ event: 'push', branch: 'main', commits: [{ sha: 'abc1234', message: 'FLEET-1 x', email: 'd@x' }] });
    // the Azure pipeline's commit parser
    const azJq = /jq -Rs '([^']+)'/.exec(f.azurePipeline)![1]!;
    const az = JSON.parse(execFileSync('jq', ['-Rs', azJq], { input: `${'a'.repeat(40)}\u001fDev\u001fd@x\u001fFLEET-1 fix\n\u001e\n${'b'.repeat(40)}\u001fQ\u001fq@x\u001fsecond\u001e` }).toString());
    expect(az.map((c: Json) => c.sha)).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    // commit hook: enforce on a keyless branch refuses; a keyed branch adds the key
    await pm('PATCH', `${P()}/repos/${ids.repo}`, { policy: 'enforce' });
    const hook = (await pm('GET', `${P()}/repos/${ids.repo}/setup`)).json.commitMsgHook as string;
    writeFileSync(join(dir, 'hook.sh'), hook);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const run = (msg: string, branch: string) => {
      execFileSync('git', ['-C', dir, 'checkout', '-q', '-B', branch]);
      writeFileSync(join(dir, 'MSG'), msg);
      const r = spawnSync('sh', [join(dir, 'hook.sh'), join(dir, 'MSG')], { cwd: dir });
      return { code: r.status, msg: execFileSync('cat', [join(dir, 'MSG')]).toString() };
    };
    expect(run('quick tweak', 'main').code).toBe(1);
    expect(run('FLEET-1 tweak', 'main').code).toBe(0);
    const keyed = run('tweak', 'feature/FLEET-1-map');
    expect(keyed.code).toBe(0);
    expect(keyed.msg).toMatch(/FLEET-1\n$/);
  });
});
