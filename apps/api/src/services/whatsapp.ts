/**
 * WhatsApp Business on the Cloud API: approved templates, the shared inbox (one conversation per
 * customer number), the 24-hour customer-service window, delivery and read receipts, documents
 * (quotes, invoices, orders) and STOP opt-outs.
 *
 * Every outbound message passes canContact(): marketing templates need recorded consent and no
 * opt-out; service messages are blocked only for erased or fully blocked addresses.
 */
import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Tx } from '../lib/db';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { type ChannelAccount, channelSecret, type InboundItem, type StatusItem } from './channels';
import { canContact, optOutAddress, addressKey, type ConsentState } from './privacy';
import { loadRow, type RecordCtx } from './records';

const WINDOW_MS = 24 * 3600_000;
const STOP_WORDS = /^\s*(stop|unsubscribe|stop promotions|stop all|opt ?out|band karo|बंद करो|बंद)\s*[.!]*\s*$/i;

export class WhatsAppError extends ApiError {
  constructor(message: string, status: 400 | 502 = 502) {
    super(status, 'whatsapp_error', message);
  }
}

/** WhatsApp numbers are digits with country code; Indian 10-digit numbers get 91. */
export function waNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/[^0-9]/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 10 && d.length <= 15 ? d : null;
}

function graph(acc: ChannelAccount) {
  return `https://graph.facebook.com/${String(acc.config.graphVersion ?? 'v21.0')}`;
}

export async function waFetch<T = any>(env: Env, acc: ChannelAccount, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const secret = await channelSecret(env, acc);
  if (!secret.accessToken) throw new WhatsAppError('The WhatsApp channel has no access token', 400);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(path.startsWith('https://') ? path : `${graph(acc)}${path}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${secret.accessToken}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
      redirect: 'manual',
    });
    const text = await res.text();
    let j: any = {};
    try {
      j = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = j?.error;
      const detail = e?.error_data?.details ?? e?.error_user_msg ?? e?.message ?? `HTTP ${res.status}`;
      throw new WhatsAppError(`WhatsApp: ${String(detail).slice(0, 300)}`, res.status === 401 || res.status === 403 ? 400 : 502);
    }
    return j as T;
  } catch (e) {
    if (e instanceof WhatsAppError) throw e;
    throw new WhatsAppError(`WhatsApp is not reachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function whatsappAccount(tx: Tx, tenantId: string, id?: string | null): Promise<ChannelAccount> {
  const acc = id
    ? await tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2 and channel = 'whatsapp' and status = 'active'`, [tenantId, id])
    : await tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and channel = 'whatsapp' and status = 'active' order by created_at limit 1`, [tenantId]);
  if (!acc) throw badRequest('Connect a WhatsApp number first (Settings → Channels)');
  return acc;
}

// ---------------------------------------------------------------------------------- templates

export interface TemplateRow {
  id: string;
  channel_account_id: string;
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  status: string;
  components: any[];
  body_text: string | null;
  variable_count: number;
  header_type: string | null;
}

function describe(components: any[]) {
  const body = components.find((c) => c.type === 'BODY')?.text ?? '';
  const header = components.find((c) => c.type === 'HEADER');
  const nums = [...String(body).matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return { body: String(body), vars: nums.length ? Math.max(...nums) : 0, header: header ? String(header.format ?? 'TEXT').toUpperCase() : null };
}

export async function syncTemplates(env: Env, tx: Tx, tenantId: string, acc: ChannelAccount) {
  const waba = String(acc.config.wabaId ?? '');
  if (!/^\d{5,25}$/.test(waba)) throw badRequest('Add the WhatsApp Business Account ID to this channel first');
  const seen: string[] = [];
  let url: string | null = `/${waba}/message_templates?fields=id,name,language,status,category,components,rejected_reason&limit=100`;
  for (let page = 0; url && page < 20; page++) {
    const j: { data?: any[]; paging?: { next?: string } } = await waFetch(env, acc, url);
    for (const t of j.data ?? []) {
      const d = describe(t.components ?? []);
      const r = await tx.one<{ id: string }>(
        `insert into wa_templates (tenant_id, channel_account_id, name, language, category, status, components, body_text, variable_count, header_type, external_id, rejected_reason, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (tenant_id, channel_account_id, name, language) do update set category = excluded.category, status = excluded.status, components = excluded.components,
           body_text = excluded.body_text, variable_count = excluded.variable_count, header_type = excluded.header_type, external_id = excluded.external_id,
           rejected_reason = excluded.rejected_reason, synced_at = now()
         returning id`,
        [tenantId, acc.id, t.name, t.language, ['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(t.category) ? t.category : 'UTILITY', normStatus(t.status), JSON.stringify(t.components ?? []), d.body, d.vars, d.header, t.id ?? null, t.rejected_reason && t.rejected_reason !== 'NONE' ? t.rejected_reason : null],
      );
      seen.push(r!.id);
    }
    const next: string | undefined = j.paging?.next;
    url = next && next.startsWith('https://graph.facebook.com/') ? next : null;
  }
  // templates deleted in WhatsApp Manager stay for history (campaigns reference them) but cannot be used
  await tx.query(`update wa_templates set status = 'DELETED' where tenant_id = $1 and channel_account_id = $2 and not (id = any($3::uuid[])) and status <> 'DELETED'`, [tenantId, acc.id, seen]);
  return { count: seen.length };
}

const normStatus = (s: string) => (['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL'].includes(s) ? s : 'PENDING');

export interface NewTemplate {
  name: string;
  language: string;
  category: 'MARKETING' | 'UTILITY';
  header?: string | null;
  body: string;
  footer?: string | null;
  examples: string[];
  buttons: ({ type: 'QUICK_REPLY'; text: string } | { type: 'URL'; text: string; url: string } | { type: 'PHONE_NUMBER'; text: string; phone: string })[];
}

/** Submits a template to Meta for approval. Marketing templates get a "Stop promotions" button. */
export async function createTemplate(env: Env, tx: Tx, tenantId: string, acc: ChannelAccount, t: NewTemplate) {
  const waba = String(acc.config.wabaId ?? '');
  if (!/^\d{5,25}$/.test(waba)) throw badRequest('Add the WhatsApp Business Account ID to this channel first');
  const nums = [...t.body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  const max = nums.length ? Math.max(...nums) : 0;
  for (let i = 1; i <= max; i++) if (!nums.includes(i)) throw badRequest(`Variables must be numbered {{1}} to {{${max}}} without gaps`);
  if (t.examples.length < max) throw badRequest('Give an example value for every variable (Meta reviews them)');
  const buttons = [...t.buttons];
  if (t.category === 'MARKETING' && !buttons.some((b) => b.type === 'QUICK_REPLY' && /stop/i.test(b.text))) buttons.push({ type: 'QUICK_REPLY', text: 'Stop promotions' });
  const components: any[] = [];
  if (t.header) components.push({ type: 'HEADER', format: 'TEXT', text: t.header });
  components.push({ type: 'BODY', text: t.body, ...(max ? { example: { body_text: [t.examples.slice(0, max)] } } : {}) });
  if (t.footer) components.push({ type: 'FOOTER', text: t.footer });
  if (buttons.length)
    components.push({
      type: 'BUTTONS',
      buttons: buttons.slice(0, 10).map((b) => (b.type === 'URL' ? { type: 'URL', text: b.text, url: b.url } : b.type === 'PHONE_NUMBER' ? { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone } : { type: 'QUICK_REPLY', text: b.text })),
    });
  const j = await waFetch<{ id?: string; status?: string; category?: string }>(env, acc, `/${waba}/message_templates`, { body: { name: t.name, language: t.language, category: t.category, components } });
  const d = describe(components);
  const r = await tx.one<{ id: string }>(
    `insert into wa_templates (tenant_id, channel_account_id, name, language, category, status, components, body_text, variable_count, header_type, external_id, synced_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     on conflict (tenant_id, channel_account_id, name, language) do update set status = excluded.status, components = excluded.components, body_text = excluded.body_text,
       variable_count = excluded.variable_count, external_id = excluded.external_id, synced_at = now()
     returning id`,
    [tenantId, acc.id, t.name, t.language, j.category === 'UTILITY' || j.category === 'MARKETING' ? j.category : t.category, normStatus(j.status ?? 'PENDING'), JSON.stringify(components), d.body, d.vars, d.header, j.id ?? null],
  );
  return { id: r!.id, status: normStatus(j.status ?? 'PENDING') };
}

export function renderTemplate(tpl: Pick<TemplateRow, 'body_text' | 'components'>, values: string[]) {
  const header = tpl.components.find((c: any) => c.type === 'HEADER' && (c.format ?? 'TEXT') === 'TEXT')?.text;
  const body = String(tpl.body_text ?? '').replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => values[Number(n) - 1] ?? '');
  const footer = tpl.components.find((c: any) => c.type === 'FOOTER')?.text;
  return [header ? `*${header}*` : null, body, footer ? `_${footer}_` : null].filter(Boolean).join('\n');
}

export function templatePayload(tpl: TemplateRow, values: string[], headerMedia?: { type: 'document' | 'image' | 'video'; link: string; filename?: string } | null) {
  if (tpl.status !== 'APPROVED') throw badRequest(`Template "${tpl.name}" is not approved by WhatsApp yet (${tpl.status.toLowerCase()})`);
  if (values.length < tpl.variable_count || values.slice(0, tpl.variable_count).some((v) => !String(v ?? '').trim())) throw badRequest(`Fill all ${tpl.variable_count} variables of "${tpl.name}"`);
  const components: any[] = [];
  if (tpl.header_type && tpl.header_type !== 'TEXT') {
    if (!headerMedia) throw badRequest(`Template "${tpl.name}" needs a ${tpl.header_type.toLowerCase()} in its header`);
    components.push({ type: 'header', parameters: [{ type: headerMedia.type, [headerMedia.type]: { link: headerMedia.link, ...(headerMedia.filename ? { filename: headerMedia.filename } : {}) } }] });
  }
  if (tpl.variable_count) components.push({ type: 'body', parameters: values.slice(0, tpl.variable_count).map((v) => ({ type: 'text', text: String(v).slice(0, 1024) })) });
  return { name: tpl.name, language: { code: tpl.language }, ...(components.length ? { components } : {}) };
}

export type WaContent =
  | { type: 'text'; text: string }
  | { type: 'template'; template: ReturnType<typeof templatePayload> }
  | { type: 'document'; link: string; filename: string; caption?: string };

export async function sendWa(env: Env, acc: ChannelAccount, to: string, content: WaContent, replyTo?: string | null): Promise<string | null> {
  // a group thread's address is "group:<id>" (WhatsApp Groups API)
  const group = to.startsWith('group:');
  const body: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: group ? 'group' : 'individual', to: group ? to.slice(6) : to };
  if (replyTo) body.context = { message_id: replyTo };
  if (content.type === 'text') Object.assign(body, { type: 'text', text: { body: content.text.slice(0, 4096), preview_url: /https?:\/\//.test(content.text) } });
  else if (content.type === 'template') Object.assign(body, { type: 'template', template: content.template });
  else Object.assign(body, { type: 'document', document: { link: content.link, filename: content.filename, ...(content.caption ? { caption: content.caption.slice(0, 1024) } : {}) } });
  const j = await waFetch<{ messages?: { id: string }[] }>(env, acc, `/${acc.config.phoneNumberId}/messages`, { body });
  return j.messages?.[0]?.id ?? null;
}

// ------------------------------------------------------------------------------- conversations

export async function upsertConversation(
  tx: Tx,
  tenantId: string,
  acc: ChannelAccount,
  address: string,
  ev: { direction: 'in' | 'out'; preview: string; at?: string; name?: string | null; related?: { object: string; id: string } | null; owner?: string | null },
) {
  const at = ev.at ?? new Date().toISOString();
  const row = await tx.one<{ id: string; assigned_to: string | null; unread: number; status: string }>(
    `insert into conversations (tenant_id, channel_account_id, channel, address, display_name, related_object, related_id, assigned_to, status, last_inbound_at, last_message_at, last_preview, last_direction, unread)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13)
     on conflict (tenant_id, channel_account_id, address) do update set
       display_name = coalesce(excluded.display_name, conversations.display_name),
       related_object = coalesce(conversations.related_object, excluded.related_object),
       related_id = coalesce(conversations.related_id, excluded.related_id),
       assigned_to = coalesce(conversations.assigned_to, excluded.assigned_to),
       status = case when $12 = 'in' then 'open' else conversations.status end,
       last_inbound_at = case when $12 = 'in' then greatest(coalesce(conversations.last_inbound_at, $10), $10) else conversations.last_inbound_at end,
       last_message_at = greatest(conversations.last_message_at, $10),
       last_preview = excluded.last_preview, last_direction = excluded.last_direction,
       unread = case when $12 = 'in' then conversations.unread + 1 else 0 end,
       first_response_at = case when $12 = 'out' and conversations.first_response_at is null and conversations.last_inbound_at is not null then now() else conversations.first_response_at end
     returning id, assigned_to, unread, status`,
    [
      tenantId,
      acc.id,
      acc.channel,
      address,
      ev.name ?? null,
      ev.related?.object ?? null,
      ev.related?.id ?? null,
      ev.owner ?? null,
      ev.direction === 'in' ? at : null,
      at,
      ev.preview.replace(/\s+/g, ' ').slice(0, 200),
      ev.direction,
      ev.direction === 'in' ? 1 : 0,
    ],
  );
  return row!;
}

export const windowOpen = (lastInbound: string | Date | null | undefined) => !!lastInbound && Date.now() - new Date(lastInbound).getTime() < WINDOW_MS;

/** Delivery receipts move a message forward (sent → delivered → read), and its campaign recipient. */
export async function applyStatuses(tx: Tx, tenantId: string, items: StatusItem[]) {
  const rank: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 4, received: 0 };
  const campaigns = new Set<string>();
  for (const s of items) {
    const m = await tx.one<{ id: string; status: string; campaign_id: string | null }>(`select id, status, campaign_id from messages where tenant_id = $1 and external_id = $2 and direction = 'out' limit 1`, [tenantId, s.externalId]);
    if (!m) continue;
    if (s.status !== 'failed' && (rank[s.status] ?? 0) <= (rank[m.status] ?? 0)) continue;
    await tx.query(
      `update messages set status = $3, error = coalesce($4, error),
              delivered_at = case when $3 in ('delivered','read') then coalesce(delivered_at, $5::timestamptz) else delivered_at end,
              read_at = case when $3 = 'read' then coalesce(read_at, $5::timestamptz) else read_at end
        where tenant_id = $1 and id = $2`,
      [tenantId, m.id, s.status, s.error ?? null, s.at],
    );
    if (m.campaign_id) {
      campaigns.add(m.campaign_id);
      await tx.query(
        `update campaign_recipients set status = case when status = 'replied' then status else $3 end, error = coalesce($4, error)
          where tenant_id = $1 and message_id = $2`,
        [tenantId, m.id, s.status, s.error ?? null],
      );
    }
  }
  for (const c of campaigns) await recountCampaign(tx, tenantId, c);
}

export async function recountCampaign(tx: Tx, tenantId: string, id: string) {
  await tx.query(
    `update campaigns c set
       total = x.total, skipped = x.skipped, failed = x.failed, replied = x.replied,
       sent = x.sent, delivered = x.delivered, read = x.read
     from (select count(*)::int as total,
                  count(*) filter (where status = 'skipped')::int as skipped,
                  count(*) filter (where status = 'failed')::int as failed,
                  count(*) filter (where status = 'replied')::int as replied,
                  count(*) filter (where status in ('sent','delivered','read','replied'))::int as sent,
                  count(*) filter (where status in ('delivered','read','replied'))::int as delivered,
                  count(*) filter (where status in ('read','replied'))::int as read
             from campaign_recipients where tenant_id = $1 and campaign_id = $2) x
     where c.tenant_id = $1 and c.id = $2`,
    [tenantId, id],
  );
}

/**
 * After an inbound WhatsApp message has been stored: thread it, honour STOP, credit the campaign
 * that prompted the reply and tell the conversation owner.
 */
export async function afterInbound(
  tx: Tx,
  tenantId: string,
  acc: ChannelAccount,
  item: InboundItem,
  saved: { msgId: string; target: { objectKey: string; id: string } },
) {
  if (acc.channel !== 'whatsapp' && acc.channel !== 'instagram') return;
  const ownerTable = ({ lead: 'leads', contact: 'contacts', account: 'accounts' } as Record<string, string>)[saved.target.objectKey];
  const owner = ownerTable ? await tx.one<{ owner_id: string | null }>(`select owner_id from ${ownerTable} where tenant_id = $1 and id = $2`, [tenantId, saved.target.id]) : null;
  const conv = await upsertConversation(tx, tenantId, acc, item.from, {
    direction: 'in',
    preview: item.text,
    at: item.at,
    name: item.name ?? null,
    related: { object: saved.target.objectKey, id: saved.target.id },
    owner: owner?.owner_id ?? null,
  });
  await tx.query(`update messages set conversation_id = $3, media = $4 where tenant_id = $1 and id = $2`, [tenantId, saved.msgId, conv.id, item.media ? JSON.stringify(item.media) : null]);
  if (acc.channel === 'whatsapp' && STOP_WORDS.test(item.text)) {
    await optOutAddress(tx, tenantId, 'whatsapp', item.from, 'reply_stop', { message: saved.msgId });
    await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id) values ($1,'note','Opted out of WhatsApp offers',$2,'in',$3,$4)`, [
      tenantId,
      `Replied "${item.text.trim().slice(0, 40)}". Marketing messages on WhatsApp are now blocked for this number.`,
      saved.target.objectKey,
      saved.target.id,
    ]);
  }
  // the most recent campaign message to this number in the last 7 days gets the reply
  const key = addressKey(item.from);
  if (key) {
    const r = await tx.one<{ id: string; campaign_id: string }>(
      `select id, campaign_id from campaign_recipients where tenant_id = $1 and address_key = $2 and status in ('sent','delivered','read') and sent_at > now() - interval '7 days' order by sent_at desc limit 1`,
      [tenantId, key],
    );
    if (r) {
      await tx.query(`update campaign_recipients set status = 'replied' where tenant_id = $1 and id = $2`, [tenantId, r.id]);
      await recountCampaign(tx, tenantId, r.campaign_id);
    }
  }
  // the first unread message of a quiet conversation notifies its owner (not every message)
  if (conv.assigned_to && conv.unread === 1) {
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'message',$3,$4,$5)`, [
      tenantId,
      conv.assigned_to,
      `${acc.channel === 'whatsapp' ? 'WhatsApp' : 'Instagram'} from ${item.name ?? item.from}`.slice(0, 200),
      item.text.slice(0, 300),
      `/inbox?c=${conv.id}`,
    ]);
  }
}

// --------------------------------------------------------------------------------- sending

export type OutboundInput = {
  text?: string | null;
  templateId?: string | null;
  values?: string[];
  /** attach a document link: a quote, invoice or order */
  doc?: { kind: 'quote' | 'invoice' | 'sales_order'; id: string } | null;
  replyTo?: string | null;
};

async function docFor(env: Env, ctx: RecordCtx, origin: string, doc: NonNullable<OutboundInput['doc']>) {
  if (doc.kind === 'quote') {
    const { row } = await loadRow(ctx, 'quote', doc.id, 'read');
    if (!['sent', 'accepted', 'rejected'].includes(String(row.status)) || !row.share_token) throw badRequest('Mark the quote as sent first; customers open it from its link');
    return { url: `${origin}/q/${row.share_token}`, label: `Quotation ${row.quote_number ?? ''}`.trim(), name: String(row.quote_number ?? 'quote') };
  }
  const object = doc.kind;
  const { row } = await loadRow(ctx, object, doc.id, 'read');
  if (object === 'invoice' && !['issued', 'partially_paid', 'paid'].includes(String(row.status))) throw badRequest('Issue the invoice before sending it');
  if (object === 'sales_order' && ['draft', 'cancelled'].includes(String(row.status))) throw badRequest('Confirm the order before sending it');
  const token = await docToken(env, ctx.tenantId, object, doc.id);
  const number = object === 'invoice' ? row.invoice_number : row.order_number;
  return { url: `${origin}/doc/${token}`, label: `${object === 'invoice' ? 'Invoice' : 'Order'} ${number ?? ''}`.trim(), name: String(number ?? object) };
}

/**
 * Sends one WhatsApp message to a record's number (or an existing conversation) as the signed-in
 * person, and logs it on the timeline. Free text needs the customer to have written in the last
 * 24 hours; otherwise an approved template is required.
 */
export async function sendToRecord(env: Env, ctx: RecordCtx, origin: string, target: { object: string; id: string } | { conversationId: string }, input: OutboundInput) {
  const { tx, tenantId } = ctx;
  let acc: ChannelAccount;
  let to: string;
  let related: { object: string; id: string } | null = null;
  let consent: ConsentState | null = null;
  let lastInbound: Date | null = null;
  let owner: string | null = null;
  if ('conversationId' in target) {
    const conv = await tx.one<{ id: string; channel_account_id: string; address: string; related_object: string | null; related_id: string | null; last_inbound_at: Date | null; assigned_to: string | null; channel: string }>(
      `select * from conversations where tenant_id = $1 and id = $2`,
      [tenantId, target.conversationId],
    );
    if (!conv) throw notFound();
    await assertConversationAccess(ctx, conv);
    if (conv.channel !== 'whatsapp') return sendInstagram(env, ctx, conv, input);
    acc = await whatsappAccount(tx, tenantId, conv.channel_account_id);
    to = conv.address;
    related = conv.related_object && conv.related_id ? { object: conv.related_object, id: conv.related_id } : null;
    lastInbound = conv.last_inbound_at;
  } else {
    if (!['lead', 'contact', 'account', 'deal', 'quote', 'sales_order', 'invoice', 'ticket'].includes(target.object)) throw badRequest('WhatsApp is not available for this record');
    const { row } = await loadRow(ctx, target.object, target.id, 'read');
    const phone = (row.phone ?? row.customer_phone ?? row.buyer_phone ?? null) as string | null;
    const resolved = phone ? null : await phoneOfRelated(tx, tenantId, target.object, row);
    to = waNumber(phone ?? resolved?.phone) ?? '';
    if (!to) throw badRequest('This record has no mobile number');
    related = resolved?.related ?? { object: target.object, id: target.id };
    acc = await whatsappAccount(tx, tenantId, null);
    const conv = await tx.one<{ last_inbound_at: Date | null }>(`select last_inbound_at from conversations where tenant_id = $1 and channel_account_id = $2 and address = $3`, [tenantId, acc.id, to]);
    lastInbound = conv?.last_inbound_at ?? null;
    owner = (row.owner_id as string | null) ?? null;
  }
  if (related && (related.object === 'lead' || related.object === 'contact')) {
    consent = (await tx.one<{ consent: ConsentState }>(`select consent from ${related.object === 'lead' ? 'leads' : 'contacts'} where tenant_id = $1 and id = $2`, [tenantId, related.id]))?.consent ?? null;
  }

  let content: WaContent;
  let preview: string;
  let purpose: 'marketing' | 'transactional' = 'transactional';
  let templateId: string | null = null;
  const doc = input.doc ? await docFor(env, ctx, origin, input.doc) : null;
  if (input.templateId) {
    const tpl = await tx.one<TemplateRow>(`select * from wa_templates where tenant_id = $1 and id = $2 and channel_account_id = $3`, [tenantId, input.templateId, acc.id]);
    if (!tpl) throw notFound('Template not found');
    const values = [...(input.values ?? [])];
    // a document link fills the first empty variable
    if (doc) {
      const empty = values.findIndex((v, i) => i < tpl.variable_count && !String(v ?? '').trim());
      if (empty >= 0) values[empty] = doc.url;
    }
    content = { type: 'template', template: templatePayload(tpl, values) };
    preview = renderTemplate(tpl, values);
    purpose = tpl.category === 'MARKETING' ? 'marketing' : 'transactional';
    templateId = tpl.id;
  } else {
    if (!windowOpen(lastInbound)) throw badRequest('The customer has not written in the last 24 hours. WhatsApp only allows an approved template now.');
    const text = [input.text?.trim(), doc ? `${doc.label}: ${doc.url}` : null].filter(Boolean).join('\n\n');
    if (!text) throw badRequest('Write a message');
    content = { type: 'text', text };
    preview = text;
  }
  // a group (people joined it through its invite link) has no single number to check; marketing never goes to groups
  if (to.startsWith('group:') && purpose === 'marketing') throw badRequest('Marketing templates are not sent to groups');
  const allowed = to.startsWith('group:') ? ({ ok: true } as const) : await canContact(tx, tenantId, 'whatsapp', to, { marketing: purpose === 'marketing', consent });
  if (!allowed.ok) throw badRequest(allowed.reason === 'no_consent' ? 'No WhatsApp marketing consent is recorded for this person. Use a utility template, or record their consent first.' : allowed.reason === 'opted_out' ? 'This number opted out of WhatsApp offers' : 'This number must not be contacted');

  const conv = await upsertConversation(tx, tenantId, acc, to, { direction: 'out', preview, related, owner: owner ?? ctx.principal.user.id });
  const msg = await tx.one<{ id: string }>(
    `insert into messages (tenant_id, channel_account_id, channel, direction, to_addr, body, status, related_object, related_id, conversation_id, template_id, purpose)
     values ($1,$2,'whatsapp','out',$3,$4,'queued',$5,$6,$7,$8,$9) returning id`,
    [tenantId, acc.id, to, preview, related?.object ?? null, related?.id ?? null, conv.id, templateId, purpose],
  );
  let externalId: string | null = null;
  try {
    externalId = await sendWa(env, acc, to, content, input.replyTo ?? null);
    await tx.query(`update messages set status = 'sent', external_id = $3 where tenant_id = $1 and id = $2`, [tenantId, msg!.id, externalId]);
  } catch (e) {
    await tx.query(`update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [tenantId, msg!.id, (e as Error).message.slice(0, 500)]);
    // the failure is visible in the thread; the caller still sees the reason
    if (related) await logActivity(tx, tenantId, related, preview, msg!.id, ctx.principal.user.id, true);
    return { messageId: msg!.id, conversationId: conv.id, status: 'failed' as const, error: (e as Error).message };
  }
  if (related) await logActivity(tx, tenantId, related, preview, msg!.id, ctx.principal.user.id, false);
  // our side of a chat a project follows: the AI reads replies too
  const { afterOutbound, flagPending } = await import('./project-chats');
  if (await afterOutbound(tx, tenantId, conv.id, msg!.id, preview, ctx.principal.user.fullName ?? 'Us')) await flagPending(env);
  return { messageId: msg!.id, conversationId: conv.id, status: 'sent' as const, externalId };
}

async function logActivity(tx: Tx, tenantId: string, related: { object: string; id: string }, body: string, messageId: string, actor: string, failed: boolean) {
  await tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, actor_id, metadata) values ($1,'whatsapp',$2,$3,'out',$4,$5,$6,$7)`, [
    tenantId,
    failed ? 'WhatsApp message failed' : 'WhatsApp message',
    body.slice(0, 4000),
    related.object,
    related.id,
    actor === '00000000-0000-0000-0000-000000000000' ? null : actor,
    JSON.stringify({ messageId, ...(failed ? { failed: true } : {}) }),
  ]);
}

/** Documents and orders belong to an account / contact: their number is the one to message. */
async function phoneOfRelated(tx: Tx, tenantId: string, object: string, row: Record<string, any>) {
  const contactId = row.contact_id as string | null;
  if (contactId) {
    const c = await tx.one<{ phone: string | null }>(`select phone from contacts where tenant_id = $1 and id = $2 and deleted_at is null`, [tenantId, contactId]);
    if (c?.phone) return { phone: c.phone, related: { object: 'contact', id: contactId } };
  }
  const accountId = (row.account_id ?? (object === 'account' ? row.id : null)) as string | null;
  if (accountId) {
    const c = await tx.one<{ id: string; phone: string | null }>(`select id, phone from contacts where tenant_id = $1 and account_id = $2 and deleted_at is null and phone is not null order by created_at limit 1`, [tenantId, accountId]);
    if (c?.phone) return { phone: c.phone, related: { object: 'contact', id: c.id } };
    const a = await tx.one<{ phone: string | null }>(`select phone from accounts where tenant_id = $1 and id = $2`, [tenantId, accountId]);
    if (a?.phone) return { phone: a.phone, related: { object: 'account', id: accountId } };
  }
  return null;
}

async function sendInstagram(env: Env, ctx: RecordCtx, conv: { id: string; channel_account_id: string; address: string; related_object: string | null; related_id: string | null; last_inbound_at: Date | null }, input: OutboundInput) {
  if (!windowOpen(conv.last_inbound_at)) throw badRequest('Instagram only allows replies within 24 hours of the customer’s last message');
  if (!input.text?.trim()) throw badRequest('Write a message');
  const acc = await ctx.tx.one<ChannelAccount>(`select * from channel_accounts where tenant_id = $1 and id = $2 and status = 'active'`, [ctx.tenantId, conv.channel_account_id]);
  if (!acc) throw badRequest('The Instagram channel is disconnected');
  const { sendViaChannel } = await import('./channels');
  const msg = await ctx.tx.one<{ id: string }>(
    `insert into messages (tenant_id, channel_account_id, channel, direction, to_addr, body, status, related_object, related_id, conversation_id) values ($1,$2,'instagram','out',$3,$4,'queued',$5,$6,$7) returning id`,
    [ctx.tenantId, acc.id, conv.address, input.text, conv.related_object, conv.related_id, conv.id],
  );
  try {
    const r = await sendViaChannel(env, acc, { to: conv.address, body: input.text });
    await ctx.tx.query(`update messages set status = 'sent', external_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, msg!.id, r.externalId]);
  } catch (e) {
    await ctx.tx.query(`update messages set status = 'failed', error = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, msg!.id, (e as Error).message.slice(0, 500)]);
    return { messageId: msg!.id, conversationId: conv.id, status: 'failed' as const, error: (e as Error).message };
  }
  await upsertConversation(ctx.tx, ctx.tenantId, acc, conv.address, { direction: 'out', preview: input.text });
  return { messageId: msg!.id, conversationId: conv.id, status: 'sent' as const };
}

// ------------------------------------------------------------------------------ inbox access

/** Inbox admins (channels) see everything; others see conversations assigned to them or about records they can see. */
export async function assertConversationAccess(ctx: RecordCtx, conv: { assigned_to: string | null; related_object: string | null; related_id: string | null }) {
  if (isInboxAdmin(ctx)) return;
  if (conv.assigned_to === ctx.principal.user.id) return;
  if (conv.related_object && conv.related_id) {
    try {
      await loadRow(ctx, conv.related_object, conv.related_id, 'read');
      return;
    } catch {
      /* fall through */
    }
  }
  throw notFound();
}

export function isInboxAdmin(ctx: RecordCtx) {
  const a = ctx.principal.permissions.admin;
  return a.includes('*') || a.includes('channels');
}

// ------------------------------------------------------------------------------ public documents

const DOC_TTL_DAYS = 30;

/** A signed, expiring link a customer opens without signing in (invoice or order view). */
export async function docToken(env: Env, tenantId: string, kind: 'invoice' | 'sales_order', id: string) {
  const exp = Math.floor(Date.now() / 1000) + DOC_TTL_DAYS * 86400;
  const body = `${tenantId}.${kind === 'invoice' ? 'i' : 'o'}.${id}.${exp.toString(36)}`;
  return `${body}.${(await hmacSha256Hex(`${env.JWT_SECRET}:doclink`, body)).slice(0, 32)}`;
}

export async function readDocToken(env: Env, token: string) {
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [tenantId, k, id, exp, sig] = parts as [string, string, string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !/^[0-9a-f-]{36}$/.test(id) || (k !== 'i' && k !== 'o')) return null;
  const want = (await hmacSha256Hex(`${env.JWT_SECRET}:doclink`, `${tenantId}.${k}.${id}.${exp}`)).slice(0, 32);
  if (!timingSafeEqual(sig, want)) return null;
  if (parseInt(exp, 36) * 1000 < Date.now()) return null;
  return { tenantId, kind: k === 'i' ? ('invoice' as const) : ('sales_order' as const), id };
}

export async function fetchMedia(env: Env, acc: ChannelAccount, mediaId: string) {
  if (!/^\d{5,30}$/.test(mediaId)) throw notFound();
  const meta = await waFetch<{ url?: string; mime_type?: string }>(env, acc, `/${mediaId}`);
  if (!meta.url || !/^https:\/\/[a-z0-9.-]+\.(fbsbx|facebook|whatsapp)\.(com|net)\//.test(meta.url)) throw notFound();
  const secret = await channelSecret(env, acc);
  const res = await fetch(meta.url, { headers: { authorization: `Bearer ${secret.accessToken}` }, redirect: 'manual' });
  if (!res.ok || !res.body) throw new WhatsAppError('Could not download the attachment');
  return { body: res.body, type: meta.mime_type ?? res.headers.get('content-type') ?? 'application/octet-stream' };
}

export { forbidden };
