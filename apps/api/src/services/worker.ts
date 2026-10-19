/**
 * Job processor shared by the Queue consumer and the inline (waitUntil) fallback.
 */
import { mergePermissions, storageFor } from '@synapse/shared';
import type { Env, Principal, TenantInfo } from '../env';
import { hmacSha256Hex } from '../lib/crypto';
import { backupStep } from './backup';
import { claimRef, type Integration, mailboxOf, markError, markOk } from './integrations';
import { fromGoogle, ingestAdLead, processMetaLead } from './leadads';
import { pushCalendarEvent, sendFromMailbox, syncMailbox } from './mail';
import { applyRazorpayEvent } from './payments-online';
import { logIncomingCall } from './telephony';
import { Db } from '../lib/db';
import { analyzeSentiment, indexDocument, scoreLead } from './ai/features';
import { AiUnavailableError } from './ai/router';
import { type ChannelAccount, matchOrCreateSender, parseInbound, parseStatuses, sendViaChannel } from './channels';
import { afterInbound, applyStatuses } from './whatsapp';
import { canContact, type ConsentState, isSuppressed } from './privacy';
import { enqueue, eventJobs, type Job, type Waiter } from './jobs';
import { recomputeRecord } from './computed';
import { routeInserted } from './routing';
import { loadMeta } from './tenancy';
import { runWorkflows } from './workflows';

export { systemPrincipal } from './system';
import { systemPrincipal } from './system';

async function tenantFor(db: Db, tenantId: string): Promise<TenantInfo | null> {
  const r = await db.tx({ tenantId, readOnly: true }, (tx) =>
    tx.one<{ id: string; slug: string; name: string; status: string; meta_version: number }>(`select id, slug, name, status, meta_version from tenants where id = $1`, [tenantId]),
  );
  return r ? { id: r.id, slug: r.slug, name: r.name, status: r.status, metaVersion: r.meta_version } : null;
}

export async function processJob(env: Env, job: Job, waiter: Waiter | null): Promise<void> {
  const db = Db.fromEnv(env);
  try {
    const tenant = await tenantFor(db, job.tenantId);
    if (!tenant || tenant.status !== 'active') return;
    const meta = await db.tx({ tenantId: tenant.id, readOnly: true }, (tx) => loadMeta(env, tx, tenant));
    const userId = job.type === 'record.event' ? job.userId : null;
    const principal = systemPrincipal(userId, meta.objects.map((o) => o.key));
    const base = { meta, principal, tenantId: tenant.id };
    const sc = { tenantId: tenant.id, userId, requestId: null };

    switch (job.type) {
      case 'record.event': {
        const followUps = await runWorkflows(env, db, base, job.event, null);
        followUps.push(...(await outboundWebhookJobs(db, sc, job)));
        // new leads are scored automatically (cheap rule-based score even without AI keys)
        if (job.event.objectKey === 'lead' && job.event.kind === 'created') followUps.push({ type: 'ai.score_lead', tenantId: tenant.id, leadId: job.event.recordId });
        await enqueue(env, waiter, followUps);
        return;
      }
      case 'ai.score_lead':
        await scoreLead({ env, db, tenantId: tenant.id, userId: null, meta }, job.leadId).catch((e) => {
          if (!(e instanceof AiUnavailableError)) throw e;
        });
        return;
      case 'kb.index': {
        const doc = await db.tx({ ...sc, readOnly: true }, (tx) =>
          tx.one<{ id: string; body: string | null }>(`select d.id, d.content as body from kb_documents d where d.tenant_id = $1 and d.id = $2`, [tenant.id, job.documentId]),
        );
        if (!doc?.body) return;
        await indexDocument({ env, db, tenantId: tenant.id, userId: null, meta }, doc.id, doc.body);
        return;
      }
      case 'message.send': {
        const m = await db.tx(sc, (tx) =>
          tx.one<{ id: string; to_addr: string; subject: string | null; body: string; channel_account_id: string | null; mailbox_id: string | null; thread_ref: string | null; status: string }>(
            `select id, to_addr, subject, body, channel_account_id, mailbox_id, thread_ref, status from messages where tenant_id = $1 and id = $2 for update`,
            [tenant.id, job.messageId],
          ),
        );
        if (!m || m.status !== 'queued') return;
        if (m.mailbox_id) {
          // the person's own Gmail / Outlook: replies come back to them and are synced
          await db.tx(sc, async (tx) => {
            const mb = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and status = 'active'`, [tenant.id, m.mailbox_id]);
            try {
              if (!mb) throw new Error('The mailbox was disconnected');
              const r = await sendFromMailbox(env, tx, mb, { to: m.to_addr, subject: m.subject ?? '', body: m.body, threadRef: m.thread_ref });
              await tx.query(`update messages set status = 'sent', external_id = $3 where tenant_id = $1 and id = $2`, [tenant.id, m.id, r.messageId]);
              const act = await tx.one<{ id: string }>(`select id from activities where tenant_id = $1 and metadata ->> 'messageId' = $2::text limit 1`, [tenant.id, m.id]);
              // the synced copy of this message is recognised and not logged twice
              if (act) await claimRef(tx, tenant.id, 'email-msgid', r.messageId, 'activity', act.id);
            } catch (e) {
              await tx.query(`update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [tenant.id, m.id, (e as Error).message.slice(0, 500)]);
            }
          });
          return;
        }
        if (!m.channel_account_id) return;
        const acc = await db.tx({ ...sc, readOnly: true }, (tx) => tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2`, [tenant.id, m.channel_account_id]));
        if (!acc) return;
        // automations respect opt-outs and erasures like every other send
        if (acc.channel === 'whatsapp' || acc.channel === 'email' || acc.channel === 'sms') {
          const block = await db.tx({ ...sc, readOnly: true }, async (tx) => {
            const meta2 = await tx.one<{ purpose: string; related_object: string | null; related_id: string | null }>(`select purpose, related_object, related_id from messages where tenant_id = $1 and id = $2`, [tenant.id, m.id]);
            const t = meta2?.related_object === 'lead' ? 'leads' : meta2?.related_object === 'contact' ? 'contacts' : null;
            const consent = t && meta2?.related_id ? ((await tx.one<{ consent: ConsentState }>(`select consent from ${t} where tenant_id = $1 and id = $2`, [tenant.id, meta2.related_id]))?.consent ?? null) : null;
            const ok = await canContact(tx, tenant.id, acc.channel as 'whatsapp' | 'email' | 'sms', m.to_addr, { marketing: meta2?.purpose === 'marketing', consent });
            // an opt-out of a channel also stops automated messages on it
            if (ok.ok && meta2?.purpose !== 'marketing' && (await isSuppressed(tx, tenant.id, acc.channel as 'whatsapp' | 'email' | 'sms', m.to_addr))) return 'opted_out';
            return ok.ok ? null : ok.reason;
          });
          if (block) {
            await db.tx(sc, (tx) => tx.query(`update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [tenant.id, m.id, `Not sent: recipient ${block.replace('_', ' ')}`]));
            return;
          }
        }
        try {
          const r = await sendViaChannel(env, acc, { to: m.to_addr, subject: m.subject, body: m.body });
          await db.tx(sc, (tx) => tx.query(`update messages set status = 'sent', external_id = $3 where tenant_id = $1 and id = $2`, [tenant.id, m.id, r.externalId]));
        } catch (e) {
          await db.tx(sc, (tx) => tx.query(`update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [tenant.id, m.id, (e as Error).message.slice(0, 500)]));
        }
        return;
      }
      case 'mail.sync':
        await syncMailbox(env, db, tenant.id, job.integrationId);
        return;
      case 'calendar.push': {
        await db.tx(sc, async (tx) => {
          const ev = await tx.one<Record<string, any>>(`select id, title, description, location, starts_at, ends_at, all_day, status, owner_id, calendar_ref from events where tenant_id = $1 and id = $2`, [tenant.id, job.eventId]);
          // removals act on the previous owner's calendar; everything else on the event owner's
          const ownerId = job.removeRef ? job.ownerId : ((ev?.owner_id as string | null) ?? null);
          if (!ownerId) return;
          const mb = await mailboxOf(tx, tenant.id, ownerId);
          if (!mb) return;
          if (job.removeRef) {
            if (job.removeRef.integrationId !== mb.id) return;
            try {
              await pushCalendarEvent(env, tx, mb, null, job.removeRef);
            } catch (e) {
              await markError(tx, mb, `Calendar: ${(e as Error).message}`);
            }
            return;
          }
          if (!ev || mb.config.calendar === false) return;
          try {
            const out = await pushCalendarEvent(env, tx, mb, ev as never, null);
            await tx.query(`update events set calendar_ref = $3 where tenant_id = $1 and id = $2`, [tenant.id, ev.id, out ? JSON.stringify({ integrationId: mb.id, id: out.id }) : null]);
          } catch (e) {
            await markError(tx, mb, `Calendar: ${(e as Error).message}`);
          }
        });
        return;
      }
      case 'leadads.meta': {
        const events = await db.tx(sc, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'meta_leads' and status <> 'disabled'`, [tenant.id, job.integrationId]);
          if (!i) return [];
          return (await processMetaLead(env, { tx, meta, tenantId: tenant.id }, i, job.leadgenId)).events;
        });
        await enqueue(env, waiter, eventJobs(tenant.id, null, events));
        return;
      }
      case 'leadads.google': {
        const events = await db.tx(sc, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'google_leads' and status <> 'disabled'`, [tenant.id, job.integrationId]);
          if (!i) return [];
          const r = await ingestAdLead({ tx, meta, tenantId: tenant.id }, i, fromGoogle(job.body));
          await markOk(tx, i, { event: true });
          return r.events;
        });
        await enqueue(env, waiter, eventJobs(tenant.id, null, events));
        return;
      }
      case 'payment.razorpay': {
        const events = await db.tx(sc, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'razorpay'`, [tenant.id, job.integrationId]);
          if (!i) return [];
          return applyRazorpayEvent({ ...base, tx }, i, job.event);
        });
        await enqueue(env, waiter, eventJobs(tenant.id, null, events));
        return;
      }
      case 'telephony.incoming': {
        const events = await db.tx(sc, async (tx) => {
          const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2 and provider = 'exotel' and status <> 'disabled'`, [tenant.id, job.integrationId]);
          if (!i) return [];
          const r = await logIncomingCall({ tx, meta, tenantId: tenant.id }, i, job.params);
          await markOk(tx, i, { event: true });
          return r;
        });
        await enqueue(env, waiter, eventJobs(tenant.id, null, events));
        return;
      }
      case 'message.inbound': {
        const acc = await db.tx({ ...sc, readOnly: true }, (tx) => tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2`, [tenant.id, job.channelAccountId]));
        if (!acc) return;
        const defaultOwner = (acc.config.defaultOwnerId as string | undefined) ?? null;
        const events: Job[] = [];
        const statuses = parseStatuses(acc, job.payload);
        if (statuses.length) await db.tx(sc, (tx) => applyStatuses(tx, tenant.id, statuses));
        for (const item of parseInbound(acc, job.payload)) {
          const saved = await db.tx(sc, async (tx) => {
            if (item.externalId) {
              const dup = await tx.one(`select 1 from messages where tenant_id = $1 and channel = $2 and external_id = $3`, [tenant.id, acc.channel, item.externalId]);
              if (dup) return null;
            }
            const target = await matchOrCreateSender(tx, tenant.id, acc.channel, item, defaultOwner);
            const msg = await tx.one<{ id: string }>(
              `insert into messages (tenant_id, channel_account_id, channel, direction, from_addr, subject, body, status, external_id, related_object, related_id)
               values ($1,$2,$3,'in',$4,$5,$6,'received',$7,$8,$9) returning id`,
              [tenant.id, acc.id, acc.channel, item.from, item.subject ?? null, item.text, item.externalId ?? null, target.objectKey, target.id],
            );
            const act = await tx.one<{ id: string }>(
              `insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata)
               values ($1,$2,$3,$4,'in',$5,$6,$7) returning id`,
              [tenant.id, acc.channel === 'whatsapp' || acc.channel === 'instagram' ? acc.channel : 'email', item.subject ?? `Message from ${item.name ?? item.from}`, item.text, target.objectKey, target.id, JSON.stringify({ messageId: msg!.id })],
            );
            // leads created from a message go through assignment (unless the channel names an owner) and scoring
            if (target.created) await routeInserted({ ...base, tx }, 'lead', target.id, !defaultOwner);
            // shared inbox thread, STOP opt-outs, campaign replies, owner notification
            await afterInbound(tx, tenant.id, acc, item, { msgId: msg!.id, target });
            return { target, msgId: msg!.id, activityId: act!.id };
          });
          if (!saved) continue;
          if (saved.target.created) events.push({ type: 'record.event', tenantId: tenant.id, userId: null, event: { objectKey: 'lead', recordId: saved.target.id, kind: 'created' } });
          try {
            const s = await analyzeSentiment({ env, db, tenantId: tenant.id, userId: null, meta }, item.text);
            await db.tx(sc, async (tx) => {
              await tx.query(`update messages set sentiment = $3 where tenant_id = $1 and id = $2`, [tenant.id, saved.msgId, s.sentiment]);
              await tx.query(`update activities set sentiment = $3 where tenant_id = $1 and id = $2`, [tenant.id, saved.activityId, s.sentiment]);
              if (saved.target.objectKey === 'lead') await tx.query(`update leads set sentiment = $3 where tenant_id = $1 and id = $2`, [tenant.id, saved.target.id, s.sentiment]);
            });
          } catch {
            /* sentiment is best effort */
          }
        }
        await enqueue(env, waiter, events);
        return;
      }
      case 'meta.recompute': {
        const obj = meta.objects.find((o) => o.key === job.objectKey);
        if (!obj) return;
        const st = storageFor(job.objectKey);
        const BATCH = 200;
        const ids = await db.tx(sc, async (tx) => {
          const rows = await tx.query<{ id: string }>(
            `select id from ${st.table} where tenant_id = $1 and deleted_at is null and id > $2::uuid${st.discriminated ? ' and object_key = $4' : ''} order by id limit $3`,
            st.discriminated ? [tenant.id, job.after ?? '00000000-0000-0000-0000-000000000000', BATCH, job.objectKey] : [tenant.id, job.after ?? '00000000-0000-0000-0000-000000000000', BATCH],
          );
          const ctx = { ...base, tx };
          for (const r of rows) await recomputeRecord(ctx, job.objectKey, r.id);
          return rows.map((r) => r.id);
        });
        if (ids.length === BATCH) await enqueue(env, waiter, [{ ...job, after: ids[ids.length - 1] }]);
        return;
      }
      case 'backup.step':
        await backupStep(env, db, waiter, job);
        return;
      case 'webhook.deliver': {
        const sub = await db.tx({ ...sc, readOnly: true }, (tx) => tx.one<{ url: string; secret: string; is_enabled: boolean }>(`select url, secret, is_enabled from webhook_subscriptions where tenant_id = $1 and id = $2`, [tenant.id, job.subscriptionId]));
        if (!sub?.is_enabled) return;
        const body = JSON.stringify({ event: job.event, tenantId: tenant.id, data: job.payload, sentAt: new Date().toISOString() });
        const res = await fetch(sub.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'HRP-Synapse-Webhook/1', 'x-synapse-event': job.event, 'x-synapse-signature': `sha256=${await hmacSha256Hex(sub.secret, body)}` },
          body,
        }).catch(() => null);
        await db.tx(sc, (tx) =>
          tx.query(
            `update webhook_subscriptions set failure_count = case when $3 then 0 else failure_count + 1 end,
                    is_enabled = case when not $3 and failure_count + 1 >= 50 then false else is_enabled end
              where tenant_id = $1 and id = $2`,
            [tenant.id, job.subscriptionId, !!res?.ok],
          ),
        );
        if (!res?.ok) throw new Error(`webhook delivery failed (${res?.status ?? 'network'})`);
        return;
      }
    }
  } finally {
    await db.close();
  }
}

async function outboundWebhookJobs(db: Db, sc: { tenantId: string; userId: string | null; requestId: null }, job: Extract<Job, { type: 'record.event' }>): Promise<Job[]> {
  const name = `${job.event.objectKey}.${job.event.kind}`;
  const subs = await db.tx({ ...sc, readOnly: true }, (tx) =>
    tx.query<{ id: string }>(`select id from webhook_subscriptions where tenant_id = $1 and is_enabled and ($2 = any(events) or '*' = any(events))`, [sc.tenantId, name]),
  );
  return subs.map((s) => ({ type: 'webhook.deliver', tenantId: sc.tenantId, subscriptionId: s.id, event: name, payload: { recordId: job.event.recordId, changes: job.event.changes ?? {} } }));
}
