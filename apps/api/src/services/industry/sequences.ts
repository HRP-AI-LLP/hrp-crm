/**
 * Email sequences: a few personal follow-up emails on a schedule (day 0, day 3, day 7 …) sent from
 * the enrolling person's own connected mailbox (or the platform mailer with their address to reply
 * to). A reply from the person stops the sequence; the do-not-contact list is honoured.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import type { Env } from '../../env';
import type { Db, Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { mailboxOf } from '../integrations';
import { sendFromMailbox } from '../mail';
import { sendPlatformMail } from '../mailer';
import { canContact } from '../privacy';
import type { RecordCtx } from '../records';

export interface Step {
  day: number;
  subject: string;
  body: string;
}

function assertSequenceAdmin(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'campaigns') || objectPerm(p, 'lead').update === 'all') return;
  throw forbidden('Building sequences needs the campaigns permission');
}

export async function listSequences(ctx: RecordCtx) {
  return ctx.tx.query(
    `select s.id, s.name, s.steps, s.stop_on_reply, s.status, s.created_at, u.full_name as created_by,
            (select count(*)::int from sequence_enrollments e where e.tenant_id = s.tenant_id and e.sequence_id = s.id and e.status = 'active') as active,
            (select count(*)::int from sequence_enrollments e where e.tenant_id = s.tenant_id and e.sequence_id = s.id and e.status = 'replied') as replied,
            (select count(*)::int from sequence_enrollments e where e.tenant_id = s.tenant_id and e.sequence_id = s.id and e.status = 'completed') as completed,
            (select count(*)::int from sequence_enrollments e where e.tenant_id = s.tenant_id and e.sequence_id = s.id) as enrolled
       from email_sequences s left join users u on u.tenant_id = s.tenant_id and u.id = s.created_by where s.tenant_id = $1 order by s.status, s.name`,
    [ctx.tenantId],
  );
}

export async function saveSequence(ctx: RecordCtx, id: string | null, input: { name: string; steps: Step[]; stopOnReply?: boolean; status?: 'active' | 'paused' }) {
  assertSequenceAdmin(ctx);
  if (!input.steps.length) throw badRequest('Add at least one email');
  const steps = [...input.steps].sort((a, b) => a.day - b.day);
  if (id) {
    const r = await ctx.tx.one(`update email_sequences set name = $3, steps = $4::jsonb, stop_on_reply = $5, status = $6 where tenant_id = $1 and id = $2 returning id`, [
      ctx.tenantId, id, input.name, JSON.stringify(steps), input.stopOnReply ?? true, input.status ?? 'active',
    ]);
    if (!r) throw notFound('Sequence not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into email_sequences (tenant_id, name, steps, stop_on_reply, status) values ($1,$2,$3::jsonb,$4,$5) returning id`, [
    ctx.tenantId, input.name, JSON.stringify(steps), input.stopOnReply ?? true, input.status ?? 'active',
  ]);
  return { id: r!.id };
}

export async function deleteSequence(ctx: RecordCtx, id: string) {
  assertSequenceAdmin(ctx);
  await ctx.tx.query(`delete from email_sequences where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

const TABLE = { lead: 'leads', contact: 'contacts' } as const;

/** Puts leads or contacts on a sequence; the first email goes on its day (day 0 = with the next run). */
export async function enroll(ctx: RecordCtx, sequenceId: string, object: 'lead' | 'contact', ids: string[]) {
  if (objectPerm(ctx.principal.permissions, object).read === 'none') throw forbidden();
  const s = await ctx.tx.one<{ steps: Step[]; status: string }>(`select steps, status from email_sequences where tenant_id = $1 and id = $2`, [ctx.tenantId, sequenceId]);
  if (!s) throw notFound('Sequence not found');
  if (s.status !== 'active') throw badRequest('This sequence is paused');
  const rows = await ctx.tx.query<{ id: string; email: string | null }>(`select id, email from ${TABLE[object]} where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, ids]);
  let added = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const r of rows) {
    if (!r.email) {
      skipped.push({ id: r.id, reason: 'no email' });
      continue;
    }
    const ok = await ctx.tx.query(
      `insert into sequence_enrollments (tenant_id, sequence_id, object, record_id, email, next_at, sender_id) values ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7)
       on conflict (tenant_id, sequence_id, object, record_id) do nothing returning id`,
      [ctx.tenantId, sequenceId, object, r.id, r.email, s.steps[0]?.day ?? 0, ctx.principal.user.id],
    );
    if (ok.length) added++;
    else skipped.push({ id: r.id, reason: 'already on it' });
  }
  return { added, skipped };
}

export async function enrollments(ctx: RecordCtx, q: { sequenceId?: string | null; object?: string | null; recordId?: string | null }) {
  return ctx.tx.query(
    `select e.id, e.sequence_id, s.name as sequence, e.object, e.record_id, e.email, e.step, e.next_at, e.status, e.last_error, e.created_at,
            coalesce(l.full_name, c.full_name) as name, jsonb_array_length(s.steps) as steps
       from sequence_enrollments e join email_sequences s on s.tenant_id = e.tenant_id and s.id = e.sequence_id
       left join leads l on e.object = 'lead' and l.tenant_id = e.tenant_id and l.id = e.record_id
       left join contacts c on e.object = 'contact' and c.tenant_id = e.tenant_id and c.id = e.record_id
      where e.tenant_id = $1 and ($2::uuid is null or e.sequence_id = $2) and ($3::text is null or e.object = $3) and ($4::uuid is null or e.record_id = $4)
      order by e.created_at desc limit 500`,
    [ctx.tenantId, q.sequenceId ?? null, q.object ?? null, q.recordId ?? null],
  );
}

export async function stopEnrollment(ctx: RecordCtx, id: string) {
  await ctx.tx.query(`update sequence_enrollments set status = 'stopped', next_at = null where tenant_id = $1 and id = $2 and status = 'active'`, [ctx.tenantId, id]);
  return { ok: true };
}

function merge(text: string, v: Record<string, string>) {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => v[k.toLowerCase()] ?? '');
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Sends every step that is due. Runs on the schedule and from "Send due emails now". */
export async function runSequences(env: Env, tx: Tx, tenantId: string, limit = 100) {
  const due = await tx.query<{ id: string; sequence_id: string; object: 'lead' | 'contact'; record_id: string; email: string; step: number; sender_id: string | null; steps: Step[]; stop_on_reply: boolean; created_at: string; seq_status: string }>(
    `select e.id, e.sequence_id, e.object, e.record_id, e.email, e.step, e.sender_id, s.steps, s.stop_on_reply, e.created_at, s.status as seq_status
       from sequence_enrollments e join email_sequences s on s.tenant_id = e.tenant_id and s.id = e.sequence_id
      where e.tenant_id = $1 and e.status = 'active' and e.next_at <= now() order by e.next_at limit $2`,
    [tenantId, limit],
  );
  let sent = 0;
  let stopped = 0;
  for (const e of due) {
    if (e.seq_status !== 'active') continue;
    // a reply from them ends it
    if (e.stop_on_reply) {
      const replied = await tx.one(
        `select 1 from activities where tenant_id = $1 and related_object = $2 and related_id = $3 and kind = 'email' and direction = 'in' and occurred_at > $4::timestamptz limit 1`,
        [tenantId, e.object, e.record_id, e.created_at],
      );
      if (replied) {
        await tx.query(`update sequence_enrollments set status = 'replied', next_at = null where tenant_id = $1 and id = $2`, [tenantId, e.id]);
        stopped++;
        continue;
      }
    }
    const step = e.steps[e.step];
    if (!step) {
      await tx.query(`update sequence_enrollments set status = 'completed', next_at = null where tenant_id = $1 and id = $2`, [tenantId, e.id]);
      continue;
    }
    const allowed = await canContact(tx, tenantId, 'email', e.email, { marketing: false });
    if (!allowed.ok) {
      await tx.query(`update sequence_enrollments set status = 'stopped', next_at = null, last_error = $3 where tenant_id = $1 and id = $2`, [tenantId, e.id, `Not contacted: ${allowed.reason}`]);
      stopped++;
      continue;
    }
    const rec = await tx.one<{ first_name: string | null; full_name: string | null; company: string | null }>(
      e.object === 'lead'
        ? `select first_name, full_name, company from leads where tenant_id = $1 and id = $2`
        : `select c.first_name, c.full_name, a.name as company from contacts c left join accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id where c.tenant_id = $1 and c.id = $2`,
      [tenantId, e.record_id],
    );
    const sender = e.sender_id ? await tx.one<{ full_name: string; email: string | null }>(`select full_name, email from users where tenant_id = $1 and id = $2`, [tenantId, e.sender_id]) : null;
    const vars = { first_name: rec?.first_name ?? rec?.full_name?.split(' ')[0] ?? 'there', name: rec?.full_name ?? '', company: rec?.company ?? '', sender: sender?.full_name ?? '' };
    const subject = merge(step.subject, vars);
    const body = merge(step.body, vars);
    let ok = false;
    let error: string | null = null;
    try {
      const mb = e.sender_id ? await mailboxOf(tx, tenantId, e.sender_id) : null;
      if (mb) {
        await sendFromMailbox(env, tx, mb, { to: e.email, subject, body });
        ok = true;
      } else {
        ok = await sendPlatformMail(env, { to: e.email, subject, text: body, html: `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.55">${esc(body).replace(/\n/g, '<br>')}</div>`, replyTo: sender?.email ?? null, fromName: sender?.full_name ?? null });
        if (!ok) error = 'No mailbox connected and the platform mailer is not set up';
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 400);
    }
    if (!ok) {
      await tx.query(`update sequence_enrollments set status = 'failed', next_at = null, last_error = $3 where tenant_id = $1 and id = $2`, [tenantId, e.id, error]);
      continue;
    }
    sent++;
    await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, actor_id, metadata) values ($1,'email',$2,$3,'out',$4,$5,$6,$7)`, [
      tenantId, subject, body, e.object, e.record_id, e.sender_id, JSON.stringify({ sequenceId: e.sequence_id, step: e.step + 1 }),
    ]);
    const nextStep = e.steps[e.step + 1];
    if (nextStep) {
      await tx.query(`update sequence_enrollments set step = step + 1, next_at = created_at + make_interval(days => $3), last_error = null where tenant_id = $1 and id = $2`, [tenantId, e.id, nextStep.day]);
    } else {
      await tx.query(`update sequence_enrollments set step = step + 1, status = 'completed', next_at = null where tenant_id = $1 and id = $2`, [tenantId, e.id]);
    }
  }
  return { sent, stopped };
}

export async function sequenceSweep(env: Env, db: Db, tenantId: string) {
  return db.tx({ tenantId }, (tx) => runSequences(env, tx, tenantId));
}
