/**
 * Reminders without keeping the database awake.
 *
 * The 5-minute cron first reads one KV key holding the earliest pending reminder across all
 * workspaces. Only when that time has passed does it touch Postgres (so Neon can scale to zero
 * between reminders). Each sweep turns due task/event reminders into in-app notifications,
 * lead follow-ups, expires overdue quotes, and writes the next due time back to KV. Creating or moving a
 * reminder earlier than the stored time updates the key.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { sweepSla } from './service';

const KEY = 'p:reminders:next';
const ist = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const IDLE_RECHECK_MS = 6 * 3600_000; // with nothing scheduled, re-check a few times a day anyway

export async function noteReminder(env: Env, at: Date | string | null | undefined): Promise<void> {
  if (!at || !env.CACHE_KV) return;
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return;
  try {
    const cur = await env.CACHE_KV.get(KEY);
    if (cur && Date.parse(cur) <= t) return;
    await env.CACHE_KV.put(KEY, new Date(t).toISOString());
  } catch {
    /* KV is best effort: the next sweep re-derives the value */
  }
}

/** Processes one workspace; returns the earliest still-pending reminder there. */
export async function sweepTenant(tx: Tx, tenantId: string): Promise<Date | null> {
  const tasks = await tx.query<{ id: string; title: string; assignee_id: string | null; related_object: string | null; related_id: string | null; due_at: Date | null }>(
    `update tasks set reminded_at = now()
      where tenant_id = $1 and remind_at <= now() and reminded_at is null and status in ('open', 'in_progress')
      returning id, title, assignee_id, related_object, related_id, due_at`,
    [tenantId],
  );
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'task',$3,$4,$5)`, [
      tenantId, t.assignee_id, `Reminder: ${t.title}`, t.due_at ? `Due ${ist(t.due_at)}` : null, t.related_object && t.related_id ? `/o/${t.related_object}/${t.related_id}` : '/tasks',
    ]);
  }
  const events = await tx.query<{ id: string; title: string; owner_id: string | null; attendees: { userId?: string }[]; starts_at: Date; location: string | null }>(
    `update events set reminded_at = now()
      where tenant_id = $1 and remind_at <= now() and reminded_at is null and status = 'scheduled'
      returning id, title, owner_id, attendees, starts_at, location`,
    [tenantId],
  );
  for (const e of events) {
    const users = new Set([e.owner_id, ...(e.attendees ?? []).map((a) => a.userId)].filter((x): x is string => !!x));
    for (const u of users) {
      await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'event',$3,$4,$5)`, [
        tenantId, u, `Starting soon: ${e.title}`, `${ist(e.starts_at)}${e.location ? ` · ${e.location}` : ''}`, `/calendar?event=${e.id}`,
      ]);
    }
  }
  const followUps = await tx.query<{ id: string; full_name: string; owner_id: string | null; next_follow_up_at: Date }>(
    `update leads set follow_up_reminded_at = now()
      where tenant_id = $1 and next_follow_up_at <= now() and follow_up_reminded_at is null and deleted_at is null and converted_at is null
      returning id, full_name, owner_id, next_follow_up_at`,
    [tenantId],
  );
  for (const l of followUps) {
    if (!l.owner_id) continue;
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'follow_up',$3,$4,$5)`, [
      tenantId, l.owner_id, `Follow up with ${l.full_name}`, `Planned for ${ist(l.next_follow_up_at)}`, `/o/lead/${l.id}`,
    ]);
  }
  const slaNext = await sweepSla(tx, tenantId);
  await tx.query(`update quotes set status = 'expired' where tenant_id = $1 and status = 'sent' and valid_until < current_date and deleted_at is null`, [tenantId]);
  const next = await tx.one<{ t: Date | null }>(
    `select least(
       (select min(remind_at) from tasks  where tenant_id = $1 and reminded_at is null and remind_at is not null and status in ('open', 'in_progress')),
       (select min(remind_at) from events where tenant_id = $1 and reminded_at is null and remind_at is not null and status = 'scheduled'),
       (select min(next_follow_up_at) from leads where tenant_id = $1 and follow_up_reminded_at is null and next_follow_up_at is not null and deleted_at is null and converted_at is null)
     ) as t`,
    [tenantId],
  );
  const n = next?.t ?? null;
  if (!slaNext) return n;
  return !n || slaNext < n ? slaNext : n;
}

export async function reminderSweep(env: Env, db: Db, force = false): Promise<{ ran: boolean; next: string | null }> {
  const now = Date.now();
  if (!force && env.CACHE_KV) {
    const next = await env.CACHE_KV.get(KEY).catch(() => null);
    if (next && Date.parse(next) > now) return { ran: false, next };
  }
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let earliest: number | null = null;
  for (const t of tenants) {
    const n = await db.tx({ tenantId: t.tenant_id }, (tx) => sweepTenant(tx, t.tenant_id));
    if (n && (earliest === null || n.getTime() < earliest)) earliest = n.getTime();
  }
  const nextIso = new Date(earliest ?? now + IDLE_RECHECK_MS).toISOString();
  if (env.CACHE_KV) await env.CACHE_KV.put(KEY, nextIso).catch(() => undefined);
  return { ran: true, next: nextIso };
}
