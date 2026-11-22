/**
 * The working calendar and automatic timesheets.
 *
 * Settings (Timesheet → Work calendar): hours per day (8), working days (Mon–Fri), public / company
 * holidays, per-person exceptions (part-time, other weekly offs, no automatic entries), and whether
 * entries are made automatically. On a working day that has no time yet, a person's day is filled
 * from what they are on:
 *   - resource allocations (person → project, hours a week): that share of the day on the project,
 *     spread over the project's open tasks assigned to them, if any;
 *   - open tasks assigned to them (not epics / features): the rest of the day, split evenly.
 * Entries are drafts marked "auto", with the task's key, name, type, status and priority in the
 * notes; the person adjusts and submits the week as usual. Days already holding time, holidays,
 * days off and weeks already submitted are never touched.
 *
 * The daily job fills up to yesterday (the last 14 days at most); "Fill my week" fills up to today.
 */
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { rates } from './projects';
import type { RecordCtx } from './records';

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const isoDow = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const LOOKBACK_DAYS = 14;

export type Calendar = { hours_per_day: number; work_days: number[]; auto_fill: boolean; auto_from: string | null; use_tasks: boolean; use_allocations: boolean };
const DEFAULT: Calendar = { hours_per_day: 8, work_days: [1, 2, 3, 4, 5], auto_fill: false, auto_from: null, use_tasks: true, use_allocations: true };

const canEdit = (ctx: RecordCtx) => ['projects', 'metadata', 'users'].some((k) => hasAdmin(ctx.principal.permissions, k));

export async function calendarOf(tx: Tx, tenantId: string): Promise<Calendar> {
  const r = await tx.one<Record<string, any>>(`select hours_per_day::float8 as hours_per_day, work_days, auto_fill, auto_from::text as auto_from, use_tasks, use_allocations from work_calendar where tenant_id = $1`, [tenantId]);
  return r ? { ...DEFAULT, ...r, work_days: (r.work_days as number[]).map(Number) } : DEFAULT;
}

export async function getCalendar(ctx: RecordCtx, year?: number) {
  const y = year ?? new Date().getUTCFullYear();
  return {
    calendar: await calendarOf(ctx.tx, ctx.tenantId),
    holidays: await ctx.tx.query(`select id, day::text as day, name, kind from holidays where tenant_id = $1 and day between $2 and $3 order by day`, [ctx.tenantId, `${y}-01-01`, `${y}-12-31`]),
    people: await ctx.tx.query(
      `select u.id, u.full_name, u.email, s.hours_per_day::float8 as hours_per_day, s.work_days, s.auto_fill
         from users u left join user_work_settings s on s.tenant_id = u.tenant_id and s.user_id = u.id
        where u.tenant_id = $1 and u.status = 'active' order by u.full_name`,
      [ctx.tenantId],
    ),
    canEdit: canEdit(ctx),
  };
}

export const calendarSchema = z.object({
  hoursPerDay: z.number().min(0.5).max(24).optional(),
  workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  autoFill: z.boolean().optional(),
  autoFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  useTasks: z.boolean().optional(),
  useAllocations: z.boolean().optional(),
});

export async function saveCalendar(ctx: RecordCtx, input: z.infer<typeof calendarSchema>) {
  if (!canEdit(ctx)) throw forbidden('Only administrators change the work calendar');
  const cur = await calendarOf(ctx.tx, ctx.tenantId);
  const next = {
    hours: input.hoursPerDay ?? cur.hours_per_day,
    days: [...new Set(input.workDays ?? cur.work_days)].sort(),
    auto: input.autoFill ?? cur.auto_fill,
    // switching it on starts today unless a start is given (past days are never filled by surprise)
    from: input.autoFrom !== undefined ? input.autoFrom : input.autoFill && !cur.auto_fill && !cur.auto_from ? today() : cur.auto_from,
    tasks: input.useTasks ?? cur.use_tasks,
    allocs: input.useAllocations ?? cur.use_allocations,
  };
  await ctx.tx.query(
    `insert into work_calendar (tenant_id, hours_per_day, work_days, auto_fill, auto_from, use_tasks, use_allocations, updated_by, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,now())
     on conflict (tenant_id) do update set hours_per_day = excluded.hours_per_day, work_days = excluded.work_days, auto_fill = excluded.auto_fill, auto_from = excluded.auto_from,
       use_tasks = excluded.use_tasks, use_allocations = excluded.use_allocations, updated_by = excluded.updated_by, updated_at = now()`,
    [ctx.tenantId, next.hours, next.days, next.auto, next.from, next.tasks, next.allocs, ctx.principal.user.id],
  );
  return calendarOf(ctx.tx, ctx.tenantId);
}

export const holidaySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(1).max(120), kind: z.enum(['public', 'company', 'optional']).default('public') });

export async function addHoliday(ctx: RecordCtx, input: z.infer<typeof holidaySchema>) {
  if (!canEdit(ctx)) throw forbidden('Only administrators change the holidays');
  const r = await ctx.tx.one<{ id: string }>(`insert into holidays (tenant_id, day, name, kind) values ($1,$2,$3,$4) on conflict (tenant_id, day, name) do update set kind = excluded.kind returning id`, [ctx.tenantId, input.day, input.name, input.kind]);
  return { id: r!.id };
}

export async function deleteHoliday(ctx: RecordCtx, id: string) {
  if (!canEdit(ctx)) throw forbidden('Only administrators change the holidays');
  const r = await ctx.tx.one(`delete from holidays where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound('Holiday not found');
  return { ok: true };
}

/** India's fixed-date national holidays for a year (festival dates change every year: add them yourself). */
export async function addNationalHolidays(ctx: RecordCtx, year: number) {
  if (!canEdit(ctx)) throw forbidden('Only administrators change the holidays');
  const list: [string, string][] = [
    [`${year}-01-26`, 'Republic Day'],
    [`${year}-08-15`, 'Independence Day'],
    [`${year}-10-02`, 'Gandhi Jayanti'],
  ];
  for (const [day, name] of list) await ctx.tx.query(`insert into holidays (tenant_id, day, name, kind) values ($1,$2,$3,'public') on conflict do nothing`, [ctx.tenantId, day, name]);
  return { added: list.length };
}

export const personSchema = z.object({ hoursPerDay: z.number().min(0.5).max(24).nullable(), workDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable(), autoFill: z.boolean().nullable() });

export async function savePerson(ctx: RecordCtx, userId: string, input: z.infer<typeof personSchema>) {
  if (!canEdit(ctx)) throw forbidden('Only administrators change people’s working hours');
  if (input.hoursPerDay === null && input.workDays === null && input.autoFill === null) {
    await ctx.tx.query(`delete from user_work_settings where tenant_id = $1 and user_id = $2`, [ctx.tenantId, userId]);
    return { ok: true };
  }
  await ctx.tx.query(
    `insert into user_work_settings (tenant_id, user_id, hours_per_day, work_days, auto_fill, updated_at) values ($1,$2,$3,$4,$5,now())
     on conflict (tenant_id, user_id) do update set hours_per_day = excluded.hours_per_day, work_days = excluded.work_days, auto_fill = excluded.auto_fill, updated_at = now()`,
    [ctx.tenantId, userId, input.hoursPerDay, input.workDays ? [...new Set(input.workDays)].sort() : null, input.autoFill],
  );
  return { ok: true };
}

/* ───────────────────────── filling days ───────────────────────── */

type Planned = { projectId: string; taskId: string | null; minutes: number; notes: string };

/** What a person's working day would hold: allocations first, then their open tasks, in quarter hours. */
export async function planDay(tx: Tx, tenantId: string, cal: Calendar, userId: string, day: string, hoursPerDay: number, workDayCount: number): Promise<Planned[]> {
  const tasks = cal.use_tasks
    ? await tx.query<{ id: string; project_id: string; name: string; key: string | null; work_type: string; status: string; priority: string }>(
        `select t.id, t.project_id, t.name, case when p.work_key is not null then p.work_key || '-' || t.task_number end as key, t.work_type, t.status, t.priority
           from project_tasks t join projects p on p.tenant_id = t.tenant_id and p.id = t.project_id
          where t.tenant_id = $1 and $2 = any(t.assignees) and p.deleted_at is null and p.status in ('active','planning')
            and t.work_type not in ('epic','feature') and t.status <> 'cancelled'
            and t.created_at::date <= $3::date and (t.start_date is null or t.start_date <= $3::date)
            and (t.completed_at is null or t.completed_at::date >= $3::date) and (t.status <> 'done' or t.completed_at is not null)
          order by p.name, t.task_number limit 40`,
        [tenantId, userId, day],
      )
    : [];
  const allocs = cal.use_allocations
    ? await tx.query<{ project_id: string; project: string; hours_per_week: number; role: string | null }>(
        `select a.project_id, p.name as project, a.hours_per_week::float8 as hours_per_week, a.role from resource_allocations a join projects p on p.tenant_id = a.tenant_id and p.id = a.project_id
          where a.tenant_id = $1 and a.user_id = $2 and $3::date between a.start_date and a.end_date and p.deleted_at is null and p.status in ('active','planning')`,
        [tenantId, userId, day],
      )
    : [];
  if (!tasks.length && !allocs.length) return [];
  const day15 = Math.round(hoursPerDay * 4) * 15;
  const q15 = (m: number) => Math.max(0, Math.round(m / 15) * 15);
  const taskNote = (t: (typeof tasks)[number]) => `Auto · ${t.key ? `${t.key} ` : ''}${t.name} (${t.work_type}, ${t.status.replace(/_/g, ' ')}, ${t.priority} priority) — from the task assignment`;
  const out: Planned[] = [];
  let used = 0;
  const allocated = new Set<string>();
  for (const a of allocs) {
    const budget = q15(Math.min((a.hours_per_week * 60) / Math.max(1, workDayCount), day15 - used));
    if (budget <= 0) continue;
    allocated.add(a.project_id);
    const mine = tasks.filter((t) => t.project_id === a.project_id);
    if (!mine.length) out.push({ projectId: a.project_id, taskId: null, minutes: budget, notes: `Auto · allocated to ${a.project}${a.role ? ` as ${a.role}` : ''} (${a.hours_per_week} h a week)` });
    else {
      const each = q15(budget / mine.length);
      mine.forEach((t, i) => out.push({ projectId: t.project_id, taskId: t.id, minutes: i === mine.length - 1 ? budget - each * (mine.length - 1) : each, notes: taskNote(t) }));
    }
    used += budget;
  }
  const rest = tasks.filter((t) => !allocated.has(t.project_id));
  const left = day15 - used;
  if (rest.length && left > 0) {
    const each = q15(left / rest.length);
    if (each >= 15) rest.forEach((t, i) => out.push({ projectId: t.project_id, taskId: t.id, minutes: i === rest.length - 1 ? left - each * (rest.length - 1) : each, notes: taskNote(t) }));
    else rest.slice(0, Math.floor(left / 15)).forEach((t) => out.push({ projectId: t.project_id, taskId: t.id, minutes: 15, notes: taskNote(t) }));
  }
  return out.filter((p) => p.minutes > 0);
}

/**
 * Fills one person's empty working days in [from, to]. Returns the entries made. `force` fills even
 * when automatic entries are off for them (a person pressing "Fill my week").
 */
export async function fillPerson(tx: Tx, tenantId: string, userId: string, from: string, to: string, opts: { force?: boolean; enteredBy?: string | null } = {}) {
  const cal = await calendarOf(tx, tenantId);
  const mine = await tx.one<{ hours_per_day: number | null; work_days: number[] | null; auto_fill: boolean | null }>(
    `select hours_per_day::float8 as hours_per_day, work_days, auto_fill from user_work_settings where tenant_id = $1 and user_id = $2`,
    [tenantId, userId],
  );
  if (!opts.force && (mine?.auto_fill ?? cal.auto_fill) === false) return { days: 0, entries: 0 };
  const hours = mine?.hours_per_day ?? cal.hours_per_day;
  const days = (mine?.work_days ?? cal.work_days).map(Number);
  const holidays = new Set((await tx.query<{ day: string }>(`select day::text as day from holidays where tenant_id = $1 and kind <> 'optional' and day between $2 and $3`, [tenantId, from, to])).map((h) => h.day));
  const busy = new Set((await tx.query<{ d: string }>(`select distinct work_date::text as d from time_entries where tenant_id = $1 and user_id = $2 and work_date between $3 and $4`, [tenantId, userId, from, to])).map((r) => r.d));
  const closed = new Set((await tx.query<{ w: string }>(`select week_start::text as w from timesheets where tenant_id = $1 and user_id = $2 and status in ('submitted','approved') and week_start between $3::date - 6 and $4`, [tenantId, userId, from, to])).map((r) => r.w));
  let filled = 0;
  let entries = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!days.includes(isoDow(d)) || holidays.has(d) || busy.has(d) || closed.has(addDays(d, 1 - isoDow(d)))) continue;
    const plan = await planDay(tx, tenantId, cal, userId, d, hours, days.length);
    if (!plan.length) continue;
    for (const p of plan) {
      const project = await tx.one<Record<string, any>>(`select * from projects where tenant_id = $1 and id = $2`, [tenantId, p.projectId]);
      const r = await rates(tx, tenantId, project!, userId, p.taskId);
      await tx.query(
        `insert into time_entries (tenant_id, project_id, task_id, user_id, work_date, minutes, notes, billable, bill_rate, cost_rate, auto, entered_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)`,
        [tenantId, p.projectId, p.taskId, userId, d, p.minutes, p.notes.slice(0, 2000), r.billableDefault, r.bill, r.cost, opts.enteredBy ?? null],
      );
      entries++;
    }
    filled++;
  }
  return { days: filled, entries };
}

/** "Fill my week": the person's empty working days of the week, up to today. */
export async function fillMyWeek(ctx: RecordCtx, date: string) {
  const weekStart = addDays(date, 1 - isoDow(date));
  const to = [addDays(weekStart, 6), today()].sort()[0]!;
  if (to < weekStart) throw badRequest('That week has not started yet');
  return fillPerson(ctx.tx, ctx.tenantId, ctx.principal.user.id, weekStart, to, { force: true, enteredBy: ctx.principal.user.id });
}

/** Administrators: everyone's empty working days in a range (at most 62 days, not past today). */
export async function fillEveryone(ctx: RecordCtx, from: string, to: string) {
  if (!canEdit(ctx)) throw forbidden('Only administrators fill timesheets for everyone');
  const end = [to, today()].sort()[0]!;
  if (from > end) throw badRequest('Choose days up to today');
  if (Date.parse(end) - Date.parse(from) > 62 * 86_400_000) throw badRequest('At most two months at a time');
  const users = await ctx.tx.query<{ id: string }>(`select id from users where tenant_id = $1 and status = 'active'`, [ctx.tenantId]);
  let days = 0;
  let entries = 0;
  for (const u of users) {
    const r = await fillPerson(ctx.tx, ctx.tenantId, u.id, from, end, { force: false, enteredBy: ctx.principal.user.id });
    days += r.days;
    entries += r.entries;
  }
  return { people: users.length, days, entries };
}

/** The daily job: every workspace with automatic entries on, everyone's days up to yesterday. */
export async function autoTimeSweep(env: Env, db: Db) {
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  const yesterday = addDays(today(), -1);
  for (const t of tenants) {
    await db
      .tx({ tenantId: t.tenant_id }, async (tx) => {
        const cal = await calendarOf(tx, t.tenant_id);
        const anyone = await tx.one(`select 1 from user_work_settings where tenant_id = $1 and auto_fill limit 1`, [t.tenant_id]);
        if (!cal.auto_fill && !anyone) return;
        const from = [cal.auto_from ?? yesterday, addDays(yesterday, -LOOKBACK_DAYS + 1)].sort().pop()!;
        if (from > yesterday) return;
        const users = await tx.query<{ id: string }>(`select id from users where tenant_id = $1 and status = 'active'`, [t.tenant_id]);
        for (const u of users) await fillPerson(tx, t.tenant_id, u.id, from, yesterday);
      })
      .catch((e) => console.error(JSON.stringify({ level: 'error', job: 'auto-time', tenant: t.tenant_id, msg: (e as Error).message })));
  }
}
