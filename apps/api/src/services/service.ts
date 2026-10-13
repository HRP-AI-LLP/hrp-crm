/**
 * Service desk: SLA breach sweep (cron), service metrics, and the customer's ticket status page.
 * Ticket SLA clocks themselves are set in hooks.ts when tickets are created or re-prioritised.
 */
import type { Tx } from '../lib/db';
import { ApiError, badRequest, notFound } from '../lib/errors';
import type { RecordCtx, RecordEvent } from './records';
import { Params, visibilityWhere } from './records';

/** Marks breached tickets and notifies the assignee and their manager once. */
export async function sweepSla(tx: Tx, tenantId: string): Promise<Date | null> {
  const breached = await tx.query<{ id: string; ticket_number: string; name: string; owner_id: string | null; priority: string; kind: string }>(
    `update tickets t set sla_breached = true, breach_notified_at = now()
      where t.tenant_id = $1 and t.deleted_at is null and t.breach_notified_at is null and t.resolved_at is null
        and ((t.first_responded_at is null and t.first_response_due <= now()) or t.resolution_due <= now())
      returning t.id, t.ticket_number, t.name, t.owner_id, t.priority,
                case when t.first_responded_at is null and t.first_response_due <= now() then 'first response' else 'resolution' end as kind`,
    [tenantId],
  );
  for (const t of breached) {
    const to = new Set<string>();
    if (t.owner_id) {
      to.add(t.owner_id);
      const m = await tx.one<{ manager_id: string | null }>(`select manager_id from users where tenant_id = $1 and id = $2`, [tenantId, t.owner_id]);
      if (m?.manager_id) to.add(m.manager_id);
    } else {
      const o = await tx.one<{ id: string }>(`select id from users where tenant_id = $1 and is_owner limit 1`, [tenantId]);
      if (o) to.add(o.id);
    }
    for (const u of to) {
      await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'sla',$3,$4,$5)`, [
        tenantId, u, `SLA breached: ${t.ticket_number}`, `${t.name} · ${t.priority} · ${t.kind} overdue`, `/o/ticket/${t.id}`,
      ]);
    }
  }
  const next = await tx.one<{ t: Date | null }>(
    `select min(least(case when first_responded_at is null then first_response_due end, resolution_due)) as t
       from tickets where tenant_id = $1 and deleted_at is null and breach_notified_at is null and resolved_at is null`,
    [tenantId],
  );
  return next?.t ?? null;
}

/** Service dashboard numbers (permission-scoped like any list). */
export async function serviceInsights(ctx: RecordCtx, days: number) {
  const p = new Params();
  const where = visibilityWhere(ctx, 'ticket', p).join(' and ');
  const d = p.add(days);
  const r = await ctx.tx.one<Record<string, unknown>>(
    `select count(*) filter (where r.status not in ('resolved', 'closed'))::int as open,
            count(*) filter (where r.status not in ('resolved', 'closed') and r.sla_breached)::int as breached_open,
            count(*) filter (where r.status not in ('resolved', 'closed') and r.priority in ('high', 'urgent'))::int as high_open,
            count(*) filter (where r.created_at > now() - make_interval(days => ${d}::int))::int as created,
            count(*) filter (where r.resolved_at > now() - make_interval(days => ${d}::int))::int as resolved,
            round(avg(extract(epoch from r.first_responded_at - r.created_at) / 60) filter (where r.created_at > now() - make_interval(days => ${d}::int) and r.first_responded_at is not null))::int as avg_first_response_min,
            round((avg(extract(epoch from r.resolved_at - r.created_at) / 3600) filter (where r.resolved_at > now() - make_interval(days => ${d}::int)))::numeric, 1)::float8 as avg_resolution_hours,
            round(100.0 * count(*) filter (where r.resolved_at > now() - make_interval(days => ${d}::int) and not r.sla_breached)
                  / nullif(count(*) filter (where r.resolved_at > now() - make_interval(days => ${d}::int)), 0))::int as sla_met_pct,
            round(avg(r.satisfaction) filter (where r.satisfaction is not null and r.created_at > now() - make_interval(days => ${d}::int))::numeric, 1)::float8 as csat
       from tickets r where ${where}`,
    p.values,
  );
  const p2 = new Params();
  const w2 = visibilityWhere(ctx, 'ticket', p2).join(' and ');
  const byCategory = await ctx.tx.query(
    `select coalesce(r.category, 'other') as category, count(*)::int as n, count(*) filter (where r.status not in ('resolved', 'closed'))::int as open
       from tickets r where ${w2} and r.created_at > now() - make_interval(days => ${p2.add(days)}::int) group by 1 order by 2 desc`,
    p2.values,
  );
  const p3 = new Params();
  const w3 = visibilityWhere(ctx, 'ticket', p3).join(' and ');
  const byOwner = await ctx.tx.query(
    `select r.owner_id, u.full_name as owner_name, count(*)::int as open, count(*) filter (where r.sla_breached)::int as breached
       from tickets r left join users u on u.tenant_id = r.tenant_id and u.id = r.owner_id
      where ${w3} and r.status not in ('resolved', 'closed') group by r.owner_id, u.full_name order by open desc limit 25`,
    p3.values,
  );
  return { days, ...r, byCategory, byOwner };
}

// ---------------------------------------------------------------------------------- customer page
export async function publicTicket(ctx: RecordCtx, id: string) {
  const t = await ctx.tx.one<Record<string, any>>(`select * from tickets where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!t) throw notFound();
  const company = await ctx.tx.one<{ name: string; settings: Record<string, any> }>(`select name, settings from tenants where id = $1`, [ctx.tenantId]);
  // only the customer's own messages and replies explicitly logged as outbound emails/WhatsApp are shown
  const updates = await ctx.tx.query(
    `select kind, subject, body, direction, occurred_at from activities
      where tenant_id = $1 and related_object = 'ticket' and related_id = $2 and (direction = 'in' or kind in ('email', 'whatsapp', 'sms') or (kind = 'stage_change'))
      order by occurred_at asc limit 100`,
    [ctx.tenantId, id],
  );
  return {
    number: t.ticket_number,
    subject: t.name,
    status: t.status,
    priority: t.priority,
    createdAt: t.created_at,
    resolvedAt: t.resolved_at,
    resolution: ['resolved', 'closed'].includes(t.status) ? t.resolution : null,
    satisfaction: t.satisfaction,
    company: company?.settings?.company?.legalName || company?.name,
    updates: updates.map((u) => ({ from: u.direction === 'in' ? 'you' : 'us', text: u.kind === 'stage_change' ? u.subject : (u.body ?? u.subject), at: u.occurred_at })),
  };
}

export async function customerReply(ctx: RecordCtx, id: string, input: { message?: string | null; rating?: number | null; comment?: string | null }): Promise<RecordEvent[]> {
  const t = await ctx.tx.one<Record<string, any>>(`select * from tickets where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, id]);
  if (!t) throw notFound();
  const events: RecordEvent[] = [];
  if (input.rating) {
    if (!['resolved', 'closed'].includes(t.status)) throw badRequest('You can rate the service once the ticket is resolved');
    if (t.satisfaction) throw badRequest('Thanks — you already rated this ticket');
    await ctx.tx.query(`update tickets set satisfaction = $3, satisfaction_comment = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, input.rating, input.comment ?? null]);
    events.push({ objectKey: 'ticket', recordId: id, kind: 'updated', changes: { satisfaction: [null, input.rating] } });
  }
  if (input.message?.trim()) {
    // the status link is public: cap replies so a leaked link cannot flood the team
    const recent = await ctx.tx.one<{ n: number }>(
      `select count(*)::int as n from activities where tenant_id = $1 and related_object = 'ticket' and related_id = $2 and direction = 'in' and subject = 'Customer reply' and created_at > now() - interval '1 hour'`,
      [ctx.tenantId, id],
    );
    if ((recent?.n ?? 0) >= 10) throw new ApiError(429, 'rate_limited', 'Too many messages on this ticket — please wait a while or call us.');
    await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id) values ($1,'note','Customer reply',$3,'in','ticket',$2)`, [ctx.tenantId, id, input.message.trim()]);
    // a reply on a resolved ticket reopens it; waiting-on-customer goes back to the team
    if (['resolved', 'closed', 'waiting_customer'].includes(t.status)) {
      await ctx.tx.query(`update tickets set status = 'open', resolved_at = null, closed_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      events.push({ objectKey: 'ticket', recordId: id, kind: 'updated', changes: { status: [t.status, 'open'] } });
    }
    if (t.owner_id) {
      await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'ticket',$3,$4,$5)`, [
        ctx.tenantId, t.owner_id, `Customer replied on ${t.ticket_number}`, input.message.trim().slice(0, 200), `/o/ticket/${id}`,
      ]);
    }
  }
  return events;
}
