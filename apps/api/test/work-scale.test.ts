/**
 * Work management at size: one project with 12,000 work items (and ~36,000 history rows), every
 * read the work screens make timed. Budgets are generous for a laptop Postgres; the point is to
 * catch queries that grow badly (missing index, per-row lookups, unbounded lists).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let pm: ReturnType<typeof h.as>;
let tenantId = '';
const ids: Record<string, string> = {};
// the full suite runs a smaller project with loose budgets (other files share the machine);
// WORK_SCALE=1 runs the real size alone: WORK_SCALE=1 npx vitest run test/work-scale.test.ts
const FULL = process.env.WORK_SCALE === '1';
const N = FULL ? 12_000 : 2_000;
const SLACK = FULL ? 1 : 6;
const timings: { what: string; ms: number; size: number }[] = [];

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

async function timed(what: string, path: string, budget = 2500) {
  budget *= SLACK;
  await pm('GET', path); // warm (plans, caches)
  const t = performance.now();
  const r = await pm('GET', path);
  const ms = Math.round(performance.now() - t);
  expect(r.status, `${what}: ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  const size = JSON.stringify(r.json).length;
  timings.push({ what, ms, size });
  expect(ms, `${what} took ${ms} ms`).toBeLessThan(budget);
  // responses stay bounded however big the project is
  expect(size, `${what} returned ${size} bytes`).toBeLessThan(3_000_000);
  return r.json;
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_work_scale');
  await h.signup('acme', 'owner@acme.test');
  pm = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await pm('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.me = (await pm('GET', '/api/auth/me')).json.user.id;
  ids.project = (await pm('POST', '/api/v1/records/project', { name: 'Big platform', project_code: 'BIG' })).json.id;
  tenantId = (await pm('GET', '/api/auth/me')).json.tenant.id;
  const P = `/api/v1/projects/${ids.project}`;
  ids.epic = (await pm('POST', `${P}/work/items`, { name: 'Platform epic', workType: 'epic' })).json.id;
  ids.sprint = (await pm('POST', `${P}/agile/sprints`, { name: 'Sprint 1', startDate: new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10), endDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) })).json.id;
  ids.release = (await pm('POST', `${P}/agile/releases`, { name: 'v1.0', targetDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) })).json.id;

  // 12,000 items spread over types, states, priorities and the last 180 days, in one statement
  await sql(
    `insert into project_tasks (tenant_id, project_id, task_number, name, status, priority, work_type, story_points, assignees, sprint_id, release_id, epic_id, parent_id, created_at, updated_at, completed_at, due_date, tags)
     select $1, $2, 1000 + g, 'Generated item ' || g || ' about ' || (array['billing','search','login','reports','mobile','export'])[1 + g % 6],
            (array['open','in_progress','review','blocked','done','done','done','cancelled'])[1 + g % 8],
            (array['low','medium','high','urgent'])[1 + g % 4],
            (array['story','task','bug','story','spike'])[1 + g % 5],
            case when g % 5 in (0, 3) then (g % 8) + 1 end,
            array[$3::uuid],
            case when g % 10 = 0 then $4::uuid end,
            case when g % 7 = 0 then $5::uuid end,
            case when g % 3 = 0 then $6::uuid end,
            case when g % 3 = 0 then $6::uuid end,
            now() - make_interval(days => g % 180, hours => g % 24),
            now() - make_interval(days => g % 90),
            case when (1 + g % 8) in (5, 6, 7) then now() - make_interval(days => g % 90) end,
            case when g % 4 = 0 then (now() + make_interval(days => (g % 60) - 30))::date end,
            case when g % 9 = 0 then array['customer'] else '{}' end
       from generate_series(1, $7::int) g`,
    [tenantId, ids.project, ids.me, ids.sprint, ids.release, ids.epic, N],
  );
  // three status moves per item
  await sql(
    `insert into project_task_history (tenant_id, project_id, task_id, actor_id, field, old_value, new_value, at)
     select t.tenant_id, t.project_id, t.id, $3, 'status', v.o, v.n, t.created_at + v.d
       from project_tasks t cross join (values ('open','in_progress', interval '1 day'), ('in_progress','review', interval '3 days'), ('review','done', interval '4 days')) v(o, n, d)
      where t.tenant_id = $1 and t.project_id = $2 and t.task_number >= 1000`,
    [tenantId, ids.project, ids.me],
  );
  // no ANALYZE (the app role may not): the screens must cope with a table that has no statistics yet, as after a bulk import
}, 300_000);

afterAll(() => {
  // eslint-disable-next-line no-console
  // a readable table in the test output
  console.log(`\nwork at ${N} items\n${timings.map((t) => `${t.what.padEnd(28)} ${String(t.ms).padStart(6)} ms ${String(Math.round(t.size / 1024)).padStart(7)} KB`).join('\n')}`);
});

describe(`a project with ${N} work items`, { timeout: 180_000 }, () => {
  const P = () => `/api/v1/projects/${ids.project}`;
  const W = () => `${P()}/work`;
  it('list and query screens', async () => {
    const q = await timed('query: open bugs', `${W()}/query?wql=${encodeURIComponent('type = bug and status != done order by priority desc')}`);
    expect(q.total).toBeGreaterThan(N / 25);
    await timed('query: text search', `${W()}/query?wql=${encodeURIComponent('text ~ "billing" order by created desc')}`);
    await timed('query: everything', `${W()}/query?wql=${encodeURIComponent('order by key')}`);
    await timed('my work (all projects)', `/api/v1/work/mine`);
    await timed('project tasks', `${P()}/tasks`);
    await timed('project', `${P()}`);
  });
  it('boards, backlog and hierarchy', async () => {
    await timed('board', `${W()}/board`);
    await timed('agile board / backlog', `${P()}/agile`);
    await timed('hierarchy', `${W()}/hierarchy`);
    await timed('setup', `${W()}/setup`);
    await timed('live stamp', `${W()}/stamp`, 400);
  });
  it('reports', async () => {
    await timed('cumulative flow', `${W()}/reports/cfd`);
    await timed('cycle time', `${W()}/reports/cycle`);
    await timed('created vs resolved', `${W()}/reports/created-resolved`);
    await timed('workload', `${W()}/reports/workload`);
    await timed('time in status', `${W()}/reports/time-in-status`);
    await timed('sprint report', `${W()}/reports/sprint?sprintId=${ids.sprint}`);
    await timed('release burn-up', `${W()}/reports/release-burnup?releaseId=${ids.release}`);
    await timed('velocity', `${P()}/agile/velocity`);
    await timed('burndown', `${P()}/agile/sprints/${ids.sprint}/burndown`);
    await timed('roadmap', `/api/v1/work/roadmap`);
  });
  it('one item in a big project', async () => {
    const one = (await sql(`select id from project_tasks where project_id = $1 and task_number = ${1000 + N / 2}`, [ids.project]))[0]!.id as string;
    await timed('work item view', `${W()}/items/${one}`);
    await timed('epic with a third of the items', `${W()}/items/${ids.epic}`);
  });
});
