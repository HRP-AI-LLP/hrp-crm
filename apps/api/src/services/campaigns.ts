/**
 * Campaigns: one WhatsApp template (or email) to an audience of leads or contacts.
 *
 *  - The audience is resolved when the campaign starts, under the creator's own permissions,
 *    so nobody can message records they cannot see. At most 5,000 people per campaign.
 *  - Each person is checked against consent and the do-not-contact list, at snapshot time and
 *    again just before sending. Duplicates (same number / email) get one message.
 *  - Sending runs in small batches (the 5-minute cron and the start request), so a campaign
 *    never holds a long transaction and stays within WhatsApp's per-number rate limits.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest, notFound } from '../lib/errors';
import { appOrigin } from './mailer';
import { type ChannelAccount, sendViaChannel } from './channels';
import { addressKey, canContact, type ConsentState, unsubscribeToken } from './privacy';
import { getObject, listRecords, type RecordCtx } from './records';
import { recountCampaign, renderTemplate, sendWa, templatePayload, type TemplateRow, upsertConversation, waNumber } from './whatsapp';
import { actAs } from './system';

export const MAX_RECIPIENTS = 5000;
const KV_KEY = 'campaigns:active';

export type VarSpec = { source: 'field'; field: string; fallback?: string } | { source: 'text'; value: string };
export interface Audience {
  object: 'lead' | 'contact';
  filters: { field: string; op: string; value?: unknown }[];
  q?: string;
}

const TABLE = { lead: 'leads', contact: 'contacts' } as const;

function fieldValue(rec: Record<string, unknown>, field: string): string {
  const v = rec[field];
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export function fillVars(specs: VarSpec[], rec: Record<string, unknown>): string[] {
  return specs.map((s) => (s.source === 'text' ? s.value : fieldValue(rec, s.field).trim() || (s.fallback ?? '')));
}

export function fillMerge(text: string, rec: Record<string, unknown>) {
  return text.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*(?:\|\s*([^}]*))?\}\}/g, (_, k: string, fb?: string) => fieldValue(rec, k).trim() || (fb ?? '').trim());
}

/** Walks the audience the caller can see (filters as in list views). */
async function* audienceRecords(ctx: RecordCtx, a: Audience, cap: number) {
  getObject(ctx.meta, a.object);
  let cursor: string | null = null;
  let n = 0;
  do {
    const page: { items: Record<string, unknown>[]; nextCursor?: string | null } = await listRecords(ctx, a.object, { filters: a.filters, q: a.q, limit: 200, cursor });
    for (const r of page.items) {
      if (n++ >= cap) return;
      yield r;
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);
}

async function consentOf(tx: Tx, tenantId: string, object: 'lead' | 'contact', ids: string[]) {
  const rows = await tx.query<{ id: string; consent: ConsentState }>(`select id, consent from ${TABLE[object]} where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, ids]);
  return new Map(rows.map((r) => [r.id, r.consent]));
}

async function campaignOf(tx: Tx, tenantId: string, id: string) {
  const c = await tx.one<Record<string, any>>(`select * from campaigns where tenant_id = $1 and id = $2`, [tenantId, id]);
  if (!c) throw notFound();
  return c;
}

async function templateOf(tx: Tx, tenantId: string, id: string | null) {
  if (!id) return null;
  return tx.one<TemplateRow>(`select * from wa_templates where tenant_id = $1 and id = $2`, [tenantId, id]);
}

/** Validates the message part of a campaign and works out whether it is marketing. */
export async function checkContent(tx: Tx, tenantId: string, c: { channel: string; channel_account_id: string; template_id: string | null; variables: VarSpec[]; subject: string | null; body: string | null }) {
  const acc = await tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2 and status = 'active'`, [tenantId, c.channel_account_id]);
  if (!acc || acc.channel !== c.channel) throw badRequest(`Choose an active ${c.channel === 'whatsapp' ? 'WhatsApp' : 'email'} channel`);
  if (c.channel === 'whatsapp') {
    const t = await templateOf(tx, tenantId, c.template_id);
    if (!t || t.channel_account_id !== acc.id) throw badRequest('Choose a template of this WhatsApp number');
    if (t.status !== 'APPROVED') throw badRequest(`Template "${t.name}" is not approved yet`);
    if (c.variables.length < t.variable_count) throw badRequest(`Map all ${t.variable_count} template variables`);
    if (t.header_type && t.header_type !== 'TEXT') throw badRequest('Templates with an image, video or document header are not supported in campaigns yet');
    return { acc, tpl: t, purpose: t.category === 'MARKETING' ? ('marketing' as const) : ('transactional' as const) };
  }
  if (!c.subject?.trim() || !c.body?.trim()) throw badRequest('Write a subject and a message');
  return { acc, tpl: null, purpose: 'marketing' as const };
}

/** Counts who would receive the campaign and why the others would not (nothing is saved). */
export async function previewAudience(ctx: RecordCtx, channel: 'whatsapp' | 'email', a: Audience, purpose: 'marketing' | 'transactional') {
  const reasons: Record<string, number> = {};
  const seen = new Set<string>();
  let eligible = 0;
  let total = 0;
  const sample: { name: string; address: string }[] = [];
  const batch: Record<string, unknown>[] = [];
  const flush = async () => {
    const consent = await consentOf(ctx.tx, ctx.tenantId, a.object, batch.map((r) => String(r.id)));
    for (const r of batch) {
      const addr = channel === 'whatsapp' ? waNumber(r.phone as string | null) : ((r.email as string | null) ?? null);
      const key = addressKey(addr);
      let reason: string | null = null;
      if (!addr || !key) reason = channel === 'whatsapp' ? 'no_mobile' : 'no_email';
      else if (seen.has(key)) reason = 'duplicate';
      else {
        const ok = await canContact(ctx.tx, ctx.tenantId, channel, addr, { marketing: purpose === 'marketing', consent: consent.get(String(r.id)) });
        if (!ok.ok) reason = ok.reason;
      }
      if (key) seen.add(key);
      if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
      else {
        eligible++;
        if (sample.length < 5) sample.push({ name: String(r.title ?? r.full_name ?? ''), address: addr! });
      }
    }
    batch.length = 0;
  };
  for await (const r of audienceRecords(ctx, a, MAX_RECIPIENTS + 1)) {
    total++;
    batch.push(r);
    if (batch.length >= 200) await flush();
  }
  await flush();
  return { total: Math.min(total, MAX_RECIPIENTS), capped: total > MAX_RECIPIENTS, eligible, skipped: reasons, sample };
}

/** Snapshots the audience into recipients and starts (or schedules) sending. */
export async function startCampaign(env: Env, ctx: RecordCtx, id: string, scheduleAt: string | null) {
  const c = await campaignOf(ctx.tx, ctx.tenantId, id);
  if (c.status !== 'draft') throw badRequest('This campaign has already been started');
  const { purpose } = await checkContent(ctx.tx, ctx.tenantId, c as never);
  const a = c.audience as Audience;
  const seen = new Set<string>();
  const batch: Record<string, unknown>[] = [];
  let n = 0;
  const flush = async () => {
    const consent = await consentOf(ctx.tx, ctx.tenantId, a.object, batch.map((r) => String(r.id)));
    for (const r of batch) {
      const addr = c.channel === 'whatsapp' ? waNumber(r.phone as string | null) : ((r.email as string | null)?.trim() ?? null);
      const key = addressKey(addr);
      if (!addr || !key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      const ok = await canContact(ctx.tx, ctx.tenantId, c.channel, addr, { marketing: purpose === 'marketing', consent: consent.get(String(r.id)) });
      await ctx.tx.query(
        `insert into campaign_recipients (tenant_id, campaign_id, subject_object, subject_id, address, address_key, status, skip_reason) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [ctx.tenantId, id, a.object, r.id, addr, key, ok.ok ? 'queued' : 'skipped', ok.ok ? null : ok.reason],
      );
      n++;
    }
    batch.length = 0;
  };
  for await (const r of audienceRecords(ctx, a, MAX_RECIPIENTS)) {
    batch.push(r);
    if (batch.length >= 200) await flush();
  }
  await flush();
  if (!n) throw badRequest('Nobody in this audience has a usable number or email');
  const when = scheduleAt ? new Date(scheduleAt) : null;
  if (when && when.getTime() < Date.now() - 60_000) throw badRequest('Choose a time in the future');
  await ctx.tx.query(`update campaigns set status = $3, scheduled_at = $4, started_at = case when $3 = 'sending' then now() else null end, purpose = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId,
    id,
    when ? 'scheduled' : 'sending',
    when,
    purpose,
  ]);
  await recountCampaign(ctx.tx, ctx.tenantId, id);
  await env.CACHE_KV?.put(KV_KEY, '1', { expirationTtl: 7 * 86400 }).catch(() => undefined);
  return { recipients: n, status: when ? 'scheduled' : 'sending' };
}

/**
 * Sends the next `budget` queued messages of one campaign. Runs as the campaign's creator, so
 * the merge fields they could not see stay empty and nothing they could not reach is sent.
 */
export async function campaignStep(env: Env, db: Db, tenantId: string, id: string, budget: number, origin: string) {
  const work = await db.tx({ tenantId }, async (tx) => {
    const c = await tx.one<Record<string, any>>(`select * from campaigns where tenant_id = $1 and id = $2 and status = 'sending' for update skip locked`, [tenantId, id]);
    if (!c) return null;
    const rows = await tx.query<{ id: string; subject_object: 'lead' | 'contact'; subject_id: string; address: string }>(
      `select id, subject_object, subject_id, address from campaign_recipients where tenant_id = $1 and campaign_id = $2 and status = 'queued' order by id limit $3 for update skip locked`,
      [tenantId, id, budget],
    );
    return { c, rows };
  });
  if (!work) return { sent: 0, done: false };
  const { c, rows } = work;
  let sent = 0;
  await db.tx({ tenantId, userId: c.created_by }, async (tx) => {
    const ctx = c.created_by ? await actAs(env, tx, tenantId, c.created_by, 'campaign') : null;
    if (!ctx) {
      await tx.query(`update campaigns set status = 'failed', last_error = 'The person who created this campaign can no longer sign in', finished_at = now() where tenant_id = $1 and id = $2`, [tenantId, id]);
      return;
    }
    const { acc, tpl, purpose } = await checkContent(tx, tenantId, c as never).catch(async (e) => {
      await tx.query(`update campaigns set status = 'failed', last_error = $3, finished_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, (e as Error).message.slice(0, 500)]);
      return { acc: null, tpl: null, purpose: 'marketing' as const };
    });
    if (!acc) return;
    const ids = rows.map((r) => r.subject_id);
    const object = (c.audience as Audience).object;
    const visible = new Map<string, Record<string, unknown>>();
    if (ids.length) for (const r of (await listRecords(ctx, object, { ids, limit: ids.length })).items) visible.set(String(r.id), r);
    const consent = await consentOf(tx, tenantId, object, ids);
    for (const r of rows) {
      const rec = visible.get(r.subject_id);
      const ok = rec ? await canContact(tx, tenantId, c.channel, r.address, { marketing: purpose === 'marketing', consent: consent.get(r.subject_id) }) : { ok: false, reason: 'not_visible' };
      if (!ok.ok) {
        await tx.query(`update campaign_recipients set status = 'skipped', skip_reason = $3 where tenant_id = $1 and id = $2`, [tenantId, r.id, ok.reason]);
        continue;
      }
      let preview: string;
      let subject: string | null = null;
      try {
        let externalId: string | null;
        if (c.channel === 'whatsapp') {
          const values = fillVars(c.variables as VarSpec[], rec!);
          preview = renderTemplate(tpl!, values);
          externalId = await sendWa(env, acc, r.address, { type: 'template', template: templatePayload(tpl!, values) });
        } else {
          subject = fillMerge(String(c.subject), rec!);
          const unsub = `${origin}/unsubscribe/${await unsubscribeToken(env, tenantId, 'email', r.address)}`;
          preview = `${fillMerge(String(c.body), rec!)}\n\n—\nTo stop these emails: ${unsub}`;
          externalId = (await sendViaChannel(env, acc, { to: r.address, subject, body: preview })).externalId;
        }
        const conv = c.channel === 'whatsapp' ? await upsertConversation(tx, tenantId, acc, r.address, { direction: 'out', preview, related: { object, id: r.subject_id }, owner: (rec!.owner_id as string | null) ?? null }) : null;
        const m = await tx.one<{ id: string }>(
          `insert into messages (tenant_id, channel_account_id, channel, direction, to_addr, subject, body, status, external_id, related_object, related_id, conversation_id, template_id, campaign_id, purpose, sent_by)
           values ($1,$2,$3,'out',$4,$5,$6,'sent',$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
          [tenantId, acc.id, c.channel, r.address, subject, preview, externalId, object, r.subject_id, conv?.id ?? null, tpl?.id ?? null, id, purpose, c.created_by],
        );
        await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, actor_id, metadata) values ($1,$2,$3,$4,'out',$5,$6,$7,$8)`, [
          tenantId,
          c.channel === 'whatsapp' ? 'whatsapp' : 'email',
          `Campaign: ${c.name}`.slice(0, 200),
          preview.slice(0, 4000),
          object,
          r.subject_id,
          c.created_by,
          JSON.stringify({ messageId: m!.id, campaignId: id }),
        ]);
        await tx.query(`update campaign_recipients set status = 'sent', message_id = $3, sent_at = now() where tenant_id = $1 and id = $2`, [tenantId, r.id, m!.id]);
        sent++;
      } catch (e) {
        await tx.query(`update campaign_recipients set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [tenantId, r.id, (e as Error).message.slice(0, 500)]);
        // a broken token or a paused number fails every message: stop instead of burning through the list
        if (/access token|\(#?131031\)|#?131042|#?131056|paused|disabled/i.test((e as Error).message)) {
          await tx.query(`update campaigns set status = 'failed', last_error = $3, finished_at = now() where tenant_id = $1 and id = $2`, [tenantId, id, (e as Error).message.slice(0, 500)]);
          break;
        }
      }
    }
    const left = await tx.one<{ n: number }>(`select count(*)::int as n from campaign_recipients where tenant_id = $1 and campaign_id = $2 and status = 'queued'`, [tenantId, id]);
    if (!left?.n) await tx.query(`update campaigns set status = 'sent', finished_at = now() where tenant_id = $1 and id = $2 and status = 'sending'`, [tenantId, id]);
    await recountCampaign(tx, tenantId, id);
  });
  return { sent, done: rows.length < budget };
}

/** Every 5 minutes while any campaign is active: start due scheduled ones, send the next batch. */
export async function campaignSweep(env: Env, db: Db, budget = 80) {
  if (env.CACHE_KV && (await env.CACHE_KV.get(KV_KEY).catch(() => null)) !== '1') return;
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let active = 0;
  const origin = env.APP_HOST ? `https://${env.APP_HOST}` : `https://${env.BASE_DOMAIN}`;
  for (const t of tenants) {
    const ids = await db.tx({ tenantId: t.tenant_id }, async (tx) => {
      await tx.query(`update campaigns set status = 'sending', started_at = now() where tenant_id = $1 and status = 'scheduled' and scheduled_at <= now()`, [t.tenant_id]);
      return tx.query<{ id: string }>(`select id from campaigns where tenant_id = $1 and status = 'sending' order by started_at limit 5`, [t.tenant_id]);
    });
    const left = await db.tx({ tenantId: t.tenant_id, readOnly: true }, (tx) => tx.one<{ n: number }>(`select count(*)::int as n from campaigns where tenant_id = $1 and status in ('sending', 'scheduled')`, [t.tenant_id]));
    active += left?.n ?? 0;
    for (const c of ids) await campaignStep(env, db, t.tenant_id, c.id, budget, origin).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'campaign', id: c.id, msg: (e as Error).message })));
  }
  if (!active) await env.CACHE_KV?.put(KV_KEY, '0', { expirationTtl: 7 * 86400 }).catch(() => undefined);
}

/** Outcome of a campaign: delivery funnel, why people were skipped, replies and business won. */
export async function campaignResults(tx: Tx, tenantId: string, id: string) {
  const c = await campaignOf(tx, tenantId, id);
  const skipped = await tx.query<{ reason: string; n: number }>(`select coalesce(skip_reason, 'other') as reason, count(*)::int as n from campaign_recipients where tenant_id = $1 and campaign_id = $2 and status = 'skipped' group by 1 order by 2 desc`, [tenantId, id]);
  const errors = await tx.query<{ error: string; n: number }>(`select coalesce(error, 'unknown') as error, count(*)::int as n from campaign_recipients where tenant_id = $1 and campaign_id = $2 and status = 'failed' group by 1 order by 2 desc limit 5`, [tenantId, id]);
  const since = c.started_at ?? c.created_at;
  // business that followed within 30 days: leads converted, and deals won by the contacts reached
  const outcome = await tx.one<{ converted: number; won_deals: number; won_amount: string }>(
    `with reached as (select subject_object, subject_id from campaign_recipients where tenant_id = $1 and campaign_id = $2 and status in ('sent','delivered','read','replied'))
     select (select count(*)::int from leads l join reached r on r.subject_object = 'lead' and r.subject_id = l.id where l.tenant_id = $1 and l.converted_at between $3 and $3::timestamptz + interval '30 days') as converted,
            (select count(*)::int from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
               where d.tenant_id = $1 and s.category = 'won' and d.closed_at between $3 and $3::timestamptz + interval '30 days'
                 and (d.contact_id in (select subject_id from reached where subject_object = 'contact')
                      or d.contact_id in (select l.converted_contact_id from leads l join reached r on r.subject_object = 'lead' and r.subject_id = l.id where l.tenant_id = $1))) as won_deals,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
               where d.tenant_id = $1 and s.category = 'won' and d.closed_at between $3 and $3::timestamptz + interval '30 days'
                 and (d.contact_id in (select subject_id from reached where subject_object = 'contact')
                      or d.contact_id in (select l.converted_contact_id from leads l join reached r on r.subject_object = 'lead' and r.subject_id = l.id where l.tenant_id = $1))) as won_amount`,
    [tenantId, id, since],
  );
  return { campaign: c, skipped, errors, outcome: { converted: outcome?.converted ?? 0, wonDeals: outcome?.won_deals ?? 0, wonAmount: Number(outcome?.won_amount ?? 0) } };
}

export function originFor(env: Env, url: string) {
  return appOrigin(env, url);
}
