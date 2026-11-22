/** Work calendar and automatic timesheets: hours a day, working days, holidays, people's exceptions, filling from assignments. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { autoTimeSweep } from '../src/services/autotime';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}
const mine = (from: string, to: string) =>
  sql(`select work_date::text as d, minutes, notes, auto, project_id, task_id from time_entries where user_id = $1 and work_date between $2 and $3 order by work_date, minutes desc`, [ids.owner, from, to]);
const byDay = (rows: Json[]) => rows.reduce<Record<string, number>>((m, r) => ((m[r.d] = (m[r.d] ?? 0) + r.minutes), m), {});

beforeAll(async () => {
  h = await makeHarness('synapse_test_autotime');
  await h.signup('atco', 'owner@atco.test');
  api = h.as('atco', (await h.login('atco', 'owner@atco.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ids.tenant = me.tenant.id;
  ids.owner = me.user.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.fleet = (await api('POST', '/api/v1/records/project', { name: 'Fleet app' })).json.id;
  ids.portal = (await api('POST', '/api/v1/records/project', { name: 'Client portal' })).json.id;
  const t = await api('POST', `/api/v1/projects/${ids.fleet}/tasks`, { name: 'Trip sheet export', assignees: [ids.owner], priority: 'high' });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  ids.task = t.json.id;
  await sql(`update projects set status = 'active' where id = any($1::uuid[])`, [[ids.fleet, ids.portal]]);
  // the task existed before the weeks filled below; the person is also planned 16 h a week on the portal
  await sql(`update project_tasks set created_at = '2026-10-01' where id = $1`, [ids.task]);
  await sql(`insert into resource_allocations (tenant_id, user_id, project_id, start_date, end_date, hours_per_week, role) values ($1,$2,$3,'2026-11-01','2026-11-30',16,'Designer')`, [ids.tenant, ids.owner, ids.portal]);
}, 120_000);

describe('work calendar and automatic timesheets', () => {
  it('starts at 8 hours, Monday to Friday, automatic entries off', async () => {
    const c = (await api('GET', '/api/v1/timesheet/calendar?year=2026')).json;
    expect(c.calendar).toMatchObject({ hours_per_day: 8, work_days: [1, 2, 3, 4, 5], auto_fill: false });
    expect(c.canEdit).toBe(true);
    // with automatic entries off, the nightly job adds nothing
    await autoTimeSweep(h.env, Db.fromEnv(h.env));
    expect(await sql(`select 1 from time_entries`)).toEqual([]);
  });

  it('holidays: add the national ones and the company’s own', async () => {
    expect((await api('POST', '/api/v1/timesheet/holidays/national', { year: 2026 })).json).toEqual({ added: 3 });
    const d = await api('POST', '/api/v1/timesheet/holidays', { day: '2026-11-11', name: 'Company offsite', kind: 'company' });
    expect(d.status).toBe(201);
    const opt = await api('POST', '/api/v1/timesheet/holidays', { day: '2026-11-12', name: 'Guru Nanak Jayanti (optional)', kind: 'optional' });
    const c = (await api('GET', '/api/v1/timesheet/calendar?year=2026')).json;
    expect(c.holidays.map((x: Json) => x.day)).toEqual(['2026-01-26', '2026-08-15', '2026-10-02', '2026-11-11', '2026-11-12']);
    expect((await api('DELETE', `/api/v1/timesheet/holidays/${opt.json.id}`)).status).toBe(200);
  });

  it('fills empty working days from allocations and assigned tasks, skipping holidays, weekends and days with time', async () => {
    await api('PUT', '/api/v1/timesheet/calendar', { autoFill: true, autoFrom: '2026-11-01' });
    // Tuesday already has an hour logged by hand: left alone
    expect((await api('POST', '/api/v1/time', { projectId: ids.fleet, date: '2026-11-10', minutes: 60, notes: 'Client call' })).status).toBe(201);
    const r = await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-11-09', to: '2026-11-15' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ days: 3 });
    const rows = await mine('2026-11-09', '2026-11-15');
    // Mon, Thu, Fri filled to 8 h; Tue keeps its hour; Wed is the offsite; the weekend stays empty
    expect(byDay(rows)).toEqual({ '2026-11-09': 480, '2026-11-10': 60, '2026-11-12': 480, '2026-11-13': 480 });
    const monday = rows.filter((x) => x.d === '2026-11-09');
    // 16 h a week over 5 days = 3 h 15 m (quarter hours) on the portal, the rest on the assigned task
    expect(monday.map((x) => [x.project_id === ids.portal ? 'portal' : 'fleet', x.minutes, x.auto])).toEqual([
      ['fleet', 285, true],
      ['portal', 195, true],
    ]);
    expect(monday[0]!.notes).toMatch(/^Auto · Trip sheet export \(task, open, high priority\) — from the task assignment$/);
    expect(monday[1]!.notes).toBe('Auto · allocated to Client portal as Designer (16 h a week)');
    // the week grid shows them as automatic drafts
    const wk = (await api('GET', '/api/v1/timesheet?date=2026-11-09')).json;
    expect(wk.entries.filter((e: Json) => e.auto).length).toBe(6);
    // running it again adds nothing
    expect((await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-11-09', to: '2026-11-15' })).json).toMatchObject({ days: 0, entries: 0 });
  });

  it('follows a person’s own hours and days, and the global settings', async () => {
    await api('PUT', `/api/v1/timesheet/people/${ids.owner}`, { hoursPerDay: 4, workDays: [1, 2, 3], autoFill: null });
    await api('PUT', '/api/v1/timesheet/calendar', { useAllocations: false });
    const r = await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-11-16', to: '2026-11-22' });
    expect(r.json).toMatchObject({ days: 3 });
    const rows = await mine('2026-11-16', '2026-11-22');
    expect(byDay(rows)).toEqual({ '2026-11-16': 240, '2026-11-17': 240, '2026-11-18': 240 });
    expect(rows.every((x) => x.task_id === ids.task)).toBe(true);
    // turned off for them: nothing more, unless they fill their own week
    await api('PUT', `/api/v1/timesheet/people/${ids.owner}`, { hoursPerDay: null, workDays: null, autoFill: false });
    expect((await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-11-02', to: '2026-11-08' })).json).toMatchObject({ days: 0 });
    const w = await api('POST', '/api/v1/timesheet/fill-week', { date: '2026-11-04' });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    expect(w.json).toMatchObject({ days: 5 });
    expect(byDay(await mine('2026-11-02', '2026-11-08'))).toEqual({ '2026-11-02': 480, '2026-11-03': 480, '2026-11-04': 480, '2026-11-05': 480, '2026-11-06': 480 });
  });

  it('never touches a submitted week, and finished tasks stop counting after they were done', async () => {
    await api('PUT', `/api/v1/timesheet/people/${ids.owner}`, { hoursPerDay: null, workDays: null, autoFill: null });
    await sql(`insert into timesheets (tenant_id, user_id, week_start, status, submitted_at) values ($1,$2,'2026-10-26','submitted',now())`, [ids.tenant, ids.owner]);
    expect((await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-10-26', to: '2026-11-01' })).json).toMatchObject({ days: 0 });
    await sql(`update project_tasks set status = 'done', completed_at = '2026-10-20' where id = $1`, [ids.task]);
    expect((await api('POST', '/api/v1/timesheet/fill-everyone', { from: '2026-10-19', to: '2026-10-25' })).json).toMatchObject({ days: 2 });
    expect(Object.keys(byDay(await mine('2026-10-19', '2026-10-25')))).toEqual(['2026-10-19', '2026-10-20']);
  });

  it('only administrators change the calendar', async () => {
    expect((await api('PUT', '/api/v1/timesheet/calendar', { hoursPerDay: 0 })).status).toBe(400);
  });
});
