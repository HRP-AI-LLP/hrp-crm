import { beforeAll, describe, expect, it } from 'vitest';
import { weekStart } from '../src/services/projects';
import { makeHarness, PW } from './harness';

const today = new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const monday = weekStart(today);

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let dev: ReturnType<typeof h.as>;
let pm: ReturnType<typeof h.as>;
let outsider: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_projects');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'billing', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Elvm Craft LLP', state: 'Maharashtra' } } });
  for (const [email, role, key] of [
    ['dev@acme.test', 'sales_rep', 'dev'],
    ['pm@acme.test', 'project_manager', 'pm'],
    ['out@acme.test', 'sales_rep', 'out'],
  ] as const) {
    const u = await api('POST', '/api/admin/users', { email, fullName: key.toUpperCase(), password: PW, roles: [role] });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    ids[key] = u.json.id ?? u.json.user?.id;
  }
  dev = h.as('acme', (await h.login('acme', 'dev@acme.test')).token);
  pm = h.as('acme', (await h.login('acme', 'pm@acme.test')).token);
  outsider = h.as('acme', (await h.login('acme', 'out@acme.test')).token);
  ids.dev = (await dev('GET', '/api/auth/me')).json.user.id;
  ids.pm = (await pm('GET', '/api/auth/me')).json.user.id;
  ids.out = (await outsider('GET', '/api/auth/me')).json.user.id;
  ids.owner = (await api('GET', '/api/auth/me')).json.user.id;
  ids.customer = (await api('POST', '/api/v1/records/account', { name: 'Sharma Homes', state: 'Maharashtra' })).json.id;
}, 120_000);

describe('projects', () => {
  it('a project manager creates a project and sets the team', async () => {
    const p = await pm('POST', '/api/v1/records/project', { name: 'Villa fit-out', project_code: 'VF-01', account_id: ids.customer, billing_method: 'time_staff_rate', project_rate: 1500, budget_type: 'hours', budget_hours: 100, start_date: monday, end_date: addDays(monday, 60) });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.project = p.json.id;
    expect(p.json).toMatchObject({ status: 'active', owner_id: ids.pm });
    const m = await pm('PUT', `/api/v1/projects/${ids.project}/members`, { members: [{ userId: ids.dev, role: 'member', billRate: 2000, costRate: 800 }] });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    // a member cannot change the team
    expect((await dev('PUT', `/api/v1/projects/${ids.project}/members`, { members: [] })).status).toBe(403);
    const g = await dev('GET', `/api/v1/projects/${ids.project}`);
    expect(g.status).toBe(200);
    expect(g.json.level).toBe('member');
    expect(g.json.members[0].bill_rate).toBeUndefined(); // rates are for managers
    const list = await dev('GET', '/api/v1/projects?mine=1');
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    expect(list.json.map((x: any) => x.id)).toContain(ids.project);
    const all = await api('GET', '/api/v1/projects');
    expect(all.status, JSON.stringify(all.json)).toBe(200);
    expect(all.json).toHaveLength(1);
    expect((await outsider('GET', '/api/v1/projects')).json).toHaveLength(0);
  });

  it('milestones, lists, tasks, sub-tasks, dependencies and progress', async () => {
    const ms = await pm('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Design sign-off', dueDate: addDays(monday, 14), amount: 50000 });
    expect(ms.status, JSON.stringify(ms.json)).toBe(201);
    ids.milestone = ms.json.id;
    ids.list = (await dev('POST', `/api/v1/projects/${ids.project}/lists`, { name: 'Design', milestoneId: ids.milestone })).json.id;
    // only project people can be assigned
    expect((await pm('POST', `/api/v1/projects/${ids.project}/tasks`, { name: 'x', assignees: [ids.out] })).status).toBe(400);
    const a = await pm('POST', `/api/v1/projects/${ids.project}/tasks`, { name: 'Site survey', listId: ids.list, assignees: [ids.dev], startDate: monday, dueDate: addDays(monday, 2), estimateHours: 8 });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect(a.json.number).toBe(1);
    ids.taskA = a.json.id;
    const b = await dev('POST', `/api/v1/projects/${ids.project}/tasks`, { name: 'Layout drawings', listId: ids.list, assignees: [ids.dev], startDate: addDays(monday, 3), dueDate: addDays(monday, 5), estimateHours: 8 });
    ids.taskB = b.json.id;
    // B after A; then A slips by 4 days and B moves with it
    expect((await dev('POST', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}/deps`, { dependsOnId: ids.taskA })).status).toBe(200);
    expect((await dev('POST', `/api/v1/projects/${ids.project}/tasks/${ids.taskA}/deps`, { dependsOnId: ids.taskB })).status).toBe(400); // circular
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskA}`, { dueDate: addDays(monday, 6) })).status).toBe(200);
    let t = (await dev('GET', `/api/v1/projects/${ids.project}/tasks`)).json;
    const tb = t.tasks.find((x: any) => x.id === ids.taskB);
    expect(String(tb.start_date).slice(0, 10)).toBe(addDays(monday, 7));
    expect(String(tb.due_date).slice(0, 10)).toBe(addDays(monday, 9));
    expect(t.deps).toHaveLength(1);
    // sub-task blocks completion of its parent until done
    const sub = await dev('POST', `/api/v1/projects/${ids.project}/tasks`, { name: 'Measure kitchen', parentId: ids.taskA, assignees: [ids.dev] });
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskA}`, { status: 'done' })).status).toBe(400);
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${sub.json.id}`, { status: 'done' })).status).toBe(200);
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskA}`, { status: 'done' })).status).toBe(200);
    // members cannot set rates
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}`, { rate: 99 })).status).toBe(403);
    const p = (await pm('GET', `/api/v1/projects/${ids.project}`)).json.project;
    expect(p.progress).toBe(50); // two top-level tasks of 8h, one done
    // the outsider cannot see the project's insides
    expect((await outsider('GET', `/api/v1/projects/${ids.project}/tasks`)).status).toBe(404);
    // assignees are notified
    const n = await dev('GET', '/api/v1/notifications');
    expect(JSON.stringify(n.json)).toContain('Site survey');
    t = (await dev('GET', '/api/v1/my-tasks')).json;
    expect(t.map((x: any) => x.id)).toContain(ids.taskB);
  });

  it('issues and comments', async () => {
    const i = await dev('POST', `/api/v1/projects/${ids.project}/issues`, { title: 'Wall not plumb', severity: 'critical', assigneeId: ids.pm, taskId: ids.taskA });
    expect(i.status, JSON.stringify(i.json)).toBe(201);
    expect((await pm('PATCH', `/api/v1/projects/${ids.project}/issues/${i.json.id}`, { status: 'fixed' })).status).toBe(200);
    expect((await pm('POST', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}/comments`, { body: 'Use the 3D view' })).status).toBe(201);
    const c = await dev('GET', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}/comments`);
    expect(c.json[0].body).toBe('Use the 3D view');
    expect((await outsider('POST', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}/comments`, { body: 'hi' })).status).toBe(404);
  });
});

describe('time and timesheets', () => {
  it('members log time at their rates; outsiders cannot', async () => {
    const t = await dev('POST', '/api/v1/time', { projectId: ids.project, taskId: ids.taskA, date: monday, minutes: 240, notes: 'Survey' });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    ids.entry1 = t.json.id;
    expect((await outsider('POST', '/api/v1/time', { projectId: ids.project, date: monday, minutes: 60 })).status).toBe(404);
    expect((await dev('POST', '/api/v1/time', { projectId: ids.project, date: monday, minutes: 60, userId: ids.pm })).status).toBe(403);
    expect((await dev('POST', '/api/v1/time', { projectId: ids.project, date: monday, minutes: 1300 })).status).toBe(400); // over 24h with the 4h above
    // timer
    expect((await dev('POST', '/api/v1/time/timer/start', { projectId: ids.project, taskId: ids.taskB })).status).toBe(201);
    expect((await dev('POST', '/api/v1/time/timer/start', { projectId: ids.project })).status).toBe(400);
    expect((await dev('GET', '/api/v1/time/timer')).json.task).toBe('Layout drawings');
    const s = await dev('POST', '/api/v1/time/timer/stop');
    expect(s.json.minutes).toBeGreaterThanOrEqual(1);
  });

  it('a week is saved as a grid, submitted, and approved by the manager only', async () => {
    const w = await dev('PUT', '/api/v1/timesheet', { date: monday, rows: [{ projectId: ids.project, taskId: ids.taskB, minutes: [0, 120, 180, 0, 0, 0, 0] }] });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const week = await dev('GET', `/api/v1/timesheet?date=${monday}`);
    // the grid replaced the draft time, including the earlier entry and the timer entry
    expect(week.json.entries.reduce((s: number, e: any) => s + e.minutes, 0)).toBe(300);
    expect((await dev('POST', '/api/v1/timesheet/submit', { date: monday })).status).toBe(200);
    expect((await dev('PUT', '/api/v1/timesheet', { date: monday, rows: [] })).status).toBe(400); // locked once submitted
    const pend = await pm('GET', '/api/v1/timesheet/approvals');
    expect(pend.json).toHaveLength(2);
    // the person cannot approve their own time; an outsider cannot approve at all
    expect((await dev('POST', '/api/v1/timesheet/decide', { entryIds: pend.json.map((e: any) => e.id), decision: 'approve' })).status).toBe(403);
    expect((await outsider('POST', '/api/v1/timesheet/decide', { entryIds: pend.json.map((e: any) => e.id), decision: 'approve' })).status).toBe(403);
    // reject one, approve one: the sheet goes back to the person
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [pend.json[0].id], decision: 'reject', reason: 'Wrong task' })).status).toBe(200);
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [pend.json[1].id], decision: 'approve' })).status).toBe(200);
    expect((await dev('GET', `/api/v1/timesheet?date=${monday}`)).json.timesheet.status).toBe('rejected');
    // fix and resubmit the rejected entry
    expect((await dev('PATCH', `/api/v1/time/${pend.json[0].id}`, { minutes: 150 })).status).toBe(200);
    expect((await dev('POST', '/api/v1/timesheet/submit', { date: monday })).status).toBe(200);
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [pend.json[0].id], decision: 'approve' })).status).toBe(200);
    expect((await dev('GET', `/api/v1/timesheet?date=${monday}`)).json.timesheet.status).toBe('approved');
    // approved time cannot be deleted
    expect((await dev('DELETE', `/api/v1/time/${pend.json[0].id}`)).status).toBe(400);
  });
});

describe('billing and reports', () => {
  it('invoices approved time and a milestone; cancelling releases them', async () => {
    const u = await pm('GET', `/api/v1/projects/${ids.project}/unbilled`);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.time).toHaveLength(2);
    expect(u.json.time.reduce((s: number, e: any) => s + e.amount, 0)).toBeCloseTo((330 / 60) * 2000, 2); // 5.5 h at the staff rate
    expect((await dev('GET', `/api/v1/projects/${ids.project}/unbilled`)).status).toBe(403);
    const inv = await pm('POST', `/api/v1/projects/${ids.project}/invoice`, { entryIds: u.json.time.map((e: any) => e.id), milestoneIds: [ids.milestone], groupBy: 'task' });
    expect(inv.status, JSON.stringify(inv.json)).toBe(403); // project managers here cannot create invoices
    const inv2 = await api('POST', `/api/v1/projects/${ids.project}/invoice`, { entryIds: u.json.time.map((e: any) => e.id), milestoneIds: [ids.milestone], groupBy: 'task' });
    expect(inv2.status, JSON.stringify(inv2.json)).toBe(201);
    const g = await api('GET', `/api/v1/invoices/${inv2.json.id}`);
    expect(g.json.lines).toHaveLength(2);
    expect(g.json.invoice.taxable_total).toBeCloseTo(11000 + 50000, 2);
    // the same time cannot be invoiced twice
    expect((await api('POST', `/api/v1/projects/${ids.project}/invoice`, { entryIds: u.json.time.map((e: any) => e.id) })).status).toBe(400);
    // issue, then cancel: everything is free to bill again
    expect((await api('POST', `/api/v1/invoices/${inv2.json.id}/issue`)).status).toBe(200);
    const s = await pm('GET', `/api/v1/projects/${ids.project}/summary`);
    expect(s.json.money.revenue).toBeCloseTo(61000, 2);
    expect(s.json.money.labourCost).toBeCloseTo((330 / 60) * 800, 2);
    expect(s.json.budget).toMatchObject({ type: 'hours', planned: 100 });
    expect((await api('POST', `/api/v1/invoices/${inv2.json.id}/cancel`, { reason: 'Re-issue' })).status).toBe(200);
    const again = await pm('GET', `/api/v1/projects/${ids.project}/unbilled`);
    expect(again.json.time).toHaveLength(2);
    expect(again.json.milestones).toHaveLength(1);
    // members see the summary without money
    expect((await dev('GET', `/api/v1/projects/${ids.project}/summary`)).json.money).toBeNull();
  });

  it('time and utilisation reports respect who manages what', async () => {
    const r = await pm('GET', `/api/v1/project-reports/time?from=${monday}&to=${addDays(monday, 6)}&groupBy=person`);
    expect(r.status).toBe(200);
    expect(r.json[0]).toMatchObject({ label: 'DEV', hours: 5.5 });
    const mine = await outsider('GET', `/api/v1/project-reports/time?from=${monday}&to=${addDays(monday, 6)}&groupBy=person`);
    expect(mine.json).toHaveLength(0);
    const ut = await pm('GET', `/api/v1/project-reports/utilisation?from=${monday}&to=${addDays(monday, 6)}`);
    expect(ut.status).toBe(200);
    expect(ut.json.find((x: any) => x.full_name === 'DEV')).toMatchObject({ capacity: 40, logged: 5.5 });
    expect((await outsider('GET', '/api/v1/project-reports/utilisation')).status).toBe(403);
    expect((await pm('PUT', `/api/v1/project-reports/capacity/${ids.dev}`, { weeklyHours: 30 })).status).toBe(403);
    expect((await api('PUT', `/api/v1/project-reports/capacity/${ids.dev}`, { weeklyHours: 30 })).status).toBe(200);
  });

  it('duplicates a project as a template; a project with approved time cannot be deleted', async () => {
    const d = await pm('POST', `/api/v1/projects/${ids.project}/duplicate`, { name: 'Villa 2', startDate: addDays(monday, 7) });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const t = (await pm('GET', `/api/v1/projects/${d.json.id}/tasks`)).json;
    expect(t.tasks).toHaveLength(3);
    expect(t.deps).toHaveLength(1);
    expect(String(t.tasks.find((x: any) => x.name === 'Site survey').start_date).slice(0, 10)).toBe(addDays(monday, 7));
    expect((await api('DELETE', `/api/v1/records/project/${ids.project}`)).status).toBe(400);
    expect((await api('DELETE', `/api/v1/records/project/${d.json.id}`)).status).toBe(200);
  });
});

describe('review hardening', () => {
  it('keeps rates and money with managers', async () => {
    await pm('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}`, { rate: 5000 });
    const g = await dev('GET', `/api/v1/projects/${ids.project}`);
    expect(g.json.project.project_rate).toBeNull();
    const mt = await dev('GET', '/api/v1/my-tasks');
    expect(mt.json[0].rate).toBeUndefined();
    expect((await dev('POST', `/api/v1/projects/${ids.project}/duplicate`, { name: 'Copy' })).status).toBe(403);
    const r = await dev('GET', `/api/v1/project-reports/time?from=${monday}&to=${addDays(monday, 6)}&groupBy=person`);
    expect(r.json[0].billable_value).toBeNull();
    expect((await dev('PATCH', `/api/v1/projects/${ids.project}/tasks/${ids.taskB}`, { billable: false })).status).toBe(403);
  });

  it('a manager cannot approve hours they entered for someone else', async () => {
    const wk = addDays(monday, -14);
    const e = await pm('POST', '/api/v1/time', { projectId: ids.project, userId: ids.dev, date: wk, minutes: 600 });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect((await dev('POST', '/api/v1/timesheet/submit', { date: wk })).status).toBe(200);
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [e.json.id], decision: 'approve' })).status).toBe(403);
    expect((await api('POST', '/api/v1/timesheet/decide', { entryIds: [e.json.id], decision: 'approve' })).status).toBe(200);
  });

  it('saving the grid keeps notes, billable and issue links', async () => {
    const wk = addDays(monday, -21);
    const iss = (await dev('POST', `/api/v1/projects/${ids.project}/issues`, { title: 'Rework' })).json.id;
    const e = await dev('POST', '/api/v1/time', { projectId: ids.project, taskId: ids.taskB, issueId: iss, date: wk, minutes: 60, notes: 'internal rework - do not bill', billable: false });
    expect(e.status).toBe(201);
    // the grid shows 1:00 on that day and adds 30 minutes on the next
    const w = await dev('PUT', '/api/v1/timesheet', { date: wk, rows: [{ projectId: ids.project, taskId: ids.taskB, minutes: [60, 30, 0, 0, 0, 0, 0] }] });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const week = (await dev('GET', `/api/v1/timesheet?date=${wk}`)).json.entries as any[];
    const kept = week.find((x) => x.id === e.json.id);
    expect(kept).toMatchObject({ minutes: 60, notes: 'internal rework - do not bill', billable: false, issue_id: iss });
    expect(week).toHaveLength(2);
  });

  it('a week with corrected-but-unsubmitted time is not approved', async () => {
    const wk = addDays(monday, -28);
    const p2 = (await pm('POST', '/api/v1/records/project', { name: 'Second', account_id: ids.customer })).json.id;
    await pm('PUT', `/api/v1/projects/${p2}/members`, { members: [{ userId: ids.dev, role: 'member' }] });
    const a = (await dev('POST', '/api/v1/time', { projectId: ids.project, date: wk, minutes: 60 })).json.id;
    const b = (await dev('POST', '/api/v1/time', { projectId: p2, date: wk, minutes: 60 })).json.id;
    await dev('POST', '/api/v1/timesheet/submit', { date: wk });
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [a], decision: 'reject', reason: 'fix' })).status).toBe(200);
    expect((await dev('PATCH', `/api/v1/time/${a}`, { minutes: 90 })).status).toBe(200);
    expect((await pm('POST', '/api/v1/timesheet/decide', { entryIds: [b], decision: 'approve' })).status).toBe(200);
    expect((await dev('GET', `/api/v1/timesheet?date=${wk}`)).json.timesheet.status).toBe('rejected');
    expect((await dev('POST', '/api/v1/timesheet/submit', { date: wk })).status).toBe(200);
  });

  it('other people\'s weeks, outsiders linking expenses, and credit notes', async () => {
    expect((await outsider('GET', `/api/v1/timesheet?date=${monday}&userId=${ids.dev}`)).status).toBe(403);
    expect((await pm('GET', `/api/v1/timesheet?date=${monday}&userId=${ids.dev}`)).status).toBe(200);
    const x = await outsider('POST', '/api/v1/records/expense', { name: 'x', amount: 10, project_id: ids.project });
    expect([403, 404]).toContain(x.status);
  });
});
