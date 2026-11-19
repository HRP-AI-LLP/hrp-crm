/**
 * Gmail and Outlook (Microsoft 365) mailbox sync, sending, and calendar mirroring.
 *
 *   sync    every ~15 minutes (and on demand), new mail in a connected mailbox whose sender or
 *           recipients match a CRM contact or open lead is logged on that record's timeline.
 *           Mail between colleagues and unknown senders is ignored. Each message is logged once
 *           per workspace (by its Message-ID), however many colleagues received it.
 *   send    mail written in Synapse goes out through the person's own mailbox, so replies come
 *           back to them and appear in their Sent folder.
 *   events  CRM calendar events are mirrored into the owner's Google or Outlook calendar.
 */
import type { Env } from '../env';
import type { Db, Tx } from '../lib/db';
import { badRequest } from '../lib/errors';
import { objectPerm } from '@synapse/shared';
import { claimRef, type Integration, mailboxToken, markError, markOk, ProviderError, providerFetch } from './integrations';
import { Params, type RecordCtx, visibilityWhere } from './records';
import { actAs } from './system';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0/me';
const MAX_BODY = 20_000;
const FIRST_SYNC_DAYS = 3;

export interface MailItem {
  messageId: string; // RFC 5322 Message-ID (dedupe key across mailboxes)
  providerId: string;
  threadId: string | null;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  date: string;
}

const addr = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();
const splitAddrs = (s: string | undefined | null) =>
  (s ?? '')
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map((x) => addr(x))
    .filter((x) => /^[^@\s]+@[^@\s]+$/.test(x));

function b64urlToText(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Drops quoted history ("On … wrote:", "-----Original Message-----") so timelines stay readable. */
export function stripQuoted(text: string): string {
  const cut = text.search(/\n(On .{5,200}wrote:|-----Original Message-----|From: .+\nSent: )/);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}
function gmailBody(p: GmailPart | undefined): string {
  if (!p) return '';
  let plain = '';
  let html = '';
  const walk = (x: GmailPart) => {
    if (x.mimeType === 'text/plain' && x.body?.data && !plain) plain = b64urlToText(x.body.data);
    else if (x.mimeType === 'text/html' && x.body?.data && !html) html = b64urlToText(x.body.data);
    for (const c of x.parts ?? []) walk(c);
  };
  walk(p);
  return plain || htmlToText(html);
}

// ---------------------------------------------------------------------------------- fetch
async function gmailFetch(token: string, since: Date, limit: number): Promise<MailItem[]> {
  const q = `after:${Math.floor(since.getTime() / 1000)} -in:chats -in:spam -in:trash -in:drafts`;
  const list = await providerFetch<{ messages?: { id: string; threadId: string }[] }>(`${GMAIL}/messages?${new URLSearchParams({ q, maxResults: String(limit) })}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const out: MailItem[] = [];
  for (const m of list.messages ?? []) {
    const msg = await providerFetch<{ id: string; threadId: string; internalDate: string; payload: GmailPart & { headers: { name: string; value: string }[] } }>(`${GMAIL}/messages/${m.id}?format=full`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const h = (n: string) => msg.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? '';
    out.push({
      messageId: h('message-id') || `gmail:${msg.id}`,
      providerId: msg.id,
      threadId: msg.threadId,
      from: addr(h('from')),
      to: splitAddrs(h('to')),
      cc: splitAddrs(h('cc')),
      subject: h('subject').slice(0, 300),
      body: gmailBody(msg.payload),
      date: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
    });
  }
  return out;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  body?: { contentType?: string; content?: string };
  isDraft?: boolean;
}
async function graphFetch(token: string, since: Date, limit: number): Promise<MailItem[]> {
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $orderby: 'receivedDateTime desc',
    $top: String(limit),
    $select: 'id,conversationId,internetMessageId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,isDraft',
  });
  const r = await providerFetch<{ value: GraphMessage[] }>(`${GRAPH}/messages?${params}`, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.body-content-type="text"' } });
  return (r.value ?? [])
    .filter((m) => !m.isDraft)
    .map((m) => ({
      messageId: m.internetMessageId || `graph:${m.id}`,
      providerId: m.id,
      threadId: m.conversationId ?? null,
      from: (m.from?.emailAddress?.address ?? '').toLowerCase(),
      to: (m.toRecipients ?? []).map((x) => (x.emailAddress?.address ?? '').toLowerCase()).filter(Boolean),
      cc: (m.ccRecipients ?? []).map((x) => (x.emailAddress?.address ?? '').toLowerCase()).filter(Boolean),
      subject: (m.subject ?? '').slice(0, 300),
      body: m.body?.contentType === 'html' ? htmlToText(m.body.content ?? '') : (m.body?.content ?? ''),
      date: m.sentDateTime ?? m.receivedDateTime ?? new Date().toISOString(),
    }));
}


// ---------------------------------------------------------------------------------- log
interface Match {
  object: 'contact' | 'lead';
  id: string;
  owner_id: string | null;
  name: string;
  email: string;
}

/** CRM people behind these addresses that the mailbox owner may see (contacts first, then open leads). */
async function matchPeople(ctx: RecordCtx, addresses: string[]): Promise<Match[]> {
  if (!addresses.length) return [];
  const out: Match[] = [];
  const known = new Set<string>();
  for (const [object, table, extra] of [
    ['contact', 'contacts', ''],
    ['lead', 'leads', ' and r.converted_at is null'],
  ] as const) {
    if (objectPerm(ctx.principal.permissions, object).read === 'none') continue;
    const rest = addresses.filter((a) => !known.has(a));
    if (!rest.length) break;
    const p = new Params();
    const where = visibilityWhere(ctx, object, p);
    const rows = await ctx.tx.query<Match>(
      `select '${object}' as object, r.id, r.owner_id, r.full_name as name, lower(r.email) as email from ${table} r
        where ${where.join(' and ')}${extra} and lower(r.email) = any(${p.add(rest)}::text[])`,
      p.values,
    );
    for (const r of rows) known.add(r.email);
    out.push(...rows);
  }
  return out;
}

/** Logs one message on the matching record; returns true when it was new and matched someone. */
export async function logMail(ctx: RecordCtx, i: Integration, m: MailItem, colleagues: Set<string>): Promise<boolean> {
  const tx = ctx.tx;
  const ownAddrs = new Set<string>([i.account_ref.toLowerCase(), ...((i.config.addresses as string[] | undefined) ?? []).map((x) => x.toLowerCase())]);
  const own = m.from && ownAddrs.has(m.from) ? m.from : i.account_ref.toLowerCase();
  const ignore = new Set<string>((i.config.ignore ?? []).map((x: string) => x.toLowerCase()));
  const ignored = (a: string) => ignore.has(a) || ignore.has(a.split('@')[1] ?? '') || colleagues.has(a) || ownAddrs.has(a);
  const outbound = ownAddrs.has(m.from);
  const counterparts = [...new Set(outbound ? [...m.to, ...m.cc] : [m.from, ...m.to, ...m.cc])].filter((a) => !ignored(a));
  // only people the mailbox owner may see: a colleague cannot pull someone's mail onto their own record
  const people = await matchPeople(ctx, counterparts);
  if (!people.length) return false;
  // the primary person: the sender of inbound mail, else the first addressee who is in the CRM
  const primary = (outbound ? people.find((p) => m.to.includes(p.email)) : people.find((p) => p.email === m.from)) ?? people[0]!;
  const act = await tx.one<{ id: string }>(
    `insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, actor_id, occurred_at, metadata)
     values ($1,'email',$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [
      i.tenant_id,
      m.subject || '(no subject)',
      stripQuoted(m.body).slice(0, MAX_BODY),
      outbound ? 'out' : 'in',
      primary.object,
      primary.id,
      i.user_id,
      m.date,
      JSON.stringify({ provider: i.provider, mailbox: i.id, messageId: m.messageId, threadId: m.threadId, from: m.from, to: m.to, cc: m.cc, synced: true }),
    ],
  );
  // claimed after the insert inside the same transaction: a parallel sync of a colleague's
  // mailbox that saw the same message rolls back on the primary key instead of logging twice
  if (!(await claimRef(tx, i.tenant_id, 'email-msgid', m.messageId, 'activity', act!.id))) {
    await tx.query(`delete from activities where tenant_id = $1 and id = $2`, [i.tenant_id, act!.id]);
    return false;
  }
  // the record owner hears about customer replies that reached a colleague's mailbox
  if (!outbound && primary.owner_id && primary.owner_id !== i.user_id) {
    await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'email',$3,$4,$5)`, [
      i.tenant_id, primary.owner_id, `Email from ${primary.name}`, m.subject.slice(0, 200), `/o/${primary.object}/${primary.id}`,
    ]);
  }
  return true;
}

/**
 * Syncs one mailbox: fetch since the last run (with overlap), log matching mail.
 * Three short transactions (claim, token, write) so no row lock is held while the provider answers.
 */
export async function syncMailbox(env: Env, db: Db, tenantId: string, integrationId: string): Promise<{ fetched: number; logged: number }> {
  const claimed = await db.tx({ tenantId }, async (tx) => {
    const i = await tx.one<Integration>(
      `update integrations set sync_state = sync_state || jsonb_build_object('lockedUntil', now() + interval '3 minutes')
        where id = (select id from integrations where tenant_id = $1 and id = $2 and provider in ('google','microsoft') and status <> 'disabled'
                      and coalesce((sync_state ->> 'lockedUntil')::timestamptz, '-infinity') < now() for update skip locked)
        returning *`,
      [tenantId, integrationId],
    );
    return i;
  });
  if (!claimed || !claimed.user_id) return { fetched: 0, logged: 0 };
  const i = claimed;
  const started = new Date();
  const since = i.sync_state.since ? new Date(Date.parse(i.sync_state.since) - 5 * 60_000) : new Date(Date.now() - FIRST_SYNC_DAYS * 86400_000);
  const release = (fields: Record<string, unknown>, ok: boolean, err?: Error) =>
    db.tx({ tenantId }, async (tx) => {
      await tx.query(`update integrations set sync_state = (sync_state - 'lockedUntil') || $3::jsonb where tenant_id = $1 and id = $2`, [tenantId, i.id, JSON.stringify(fields)]);
      if (ok) await markOk(tx, i, { sync: true });
      else if (err) await markError(tx, i, err.message, err instanceof ProviderError && err.status === 401);
    });
  let items: MailItem[];
  try {
    const token = await db.tx({ tenantId }, (tx) => mailboxToken(env, tx, i));
    items = i.provider === 'google' ? await gmailFetch(token, since, 50) : await graphFetch(token, since, 50);
  } catch (e) {
    await release({}, false, e as Error);
    return { fetched: 0, logged: 0 };
  }
  const logged = await db.tx({ tenantId, userId: i.user_id }, async (tx) => {
    const ctx = await actAs(env, tx, tenantId, i.user_id!, 'mail-sync');
    if (!ctx) return 0;
    const colleagues = new Set((await tx.query<{ email: string }>(`select lower(email) as email from users where tenant_id = $1`, [tenantId])).map((u) => u.email));
    let n = 0;
    for (const m of items) {
      await tx.query('savepoint mail_item');
      try {
        if (await logMail(ctx, i, m, colleagues)) n++;
        await tx.query('release savepoint mail_item');
      } catch {
        await tx.query('rollback to savepoint mail_item');
      }
    }
    return n;
  });
  // call invites in the calendar become calls on the right project
  await db
    .tx({ tenantId, userId: i.user_id }, async (tx) => (await import('./invites')).syncInvites(env, tx, i))
    .catch((e) => console.error(JSON.stringify({ level: 'warn', job: 'invites', tenant: tenantId, msg: (e as Error).message })));
  await release({ since: started.toISOString() }, true);
  return { fetched: items.length, logged };
}

/** Cron: mailboxes not synced for 15 minutes, a few per workspace per run. */
export async function mailSweep(env: Env, db: Db) {
  if (!(env.GOOGLE_CLIENT_ID || env.MS_CLIENT_ID)) return;
  // background sync runs in Indian business hours (07:00–21:00 IST) so an idle database can sleep
  // overnight on the free tier; opening a customer or "Sync now" still syncs at any hour
  const istHour = (new Date().getUTCHours() + 5 + (new Date().getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
  if (env.MAIL_SYNC_ALWAYS !== 'true' && (istHour < 7 || istHour >= 21)) return;
  // a KV marker avoids waking the database every five minutes when nobody has a mailbox connected
  if (env.CACHE_KV && (await env.CACHE_KV.get('mail:any').catch(() => null)) === '0') return;
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  let total = 0;
  for (const t of tenants) {
    const due = await db.tx({ tenantId: t.tenant_id, readOnly: true }, (tx) =>
      tx.query<{ id: string }>(
        `select id from integrations where tenant_id = $1 and provider in ('google','microsoft') and status = 'active'
            and (last_sync_at is null or last_sync_at < now() - interval '14 minutes') order by last_sync_at nulls first limit 10`,
        [t.tenant_id],
      ),
    );
    total += due.length;
    for (const d of due) await syncMailbox(env, db, t.tenant_id, d.id).catch(() => undefined);
  }
  if (env.CACHE_KV && !total) {
    const any = await countMailboxes(db, tenants.map((t) => t.tenant_id));
    await env.CACHE_KV.put('mail:any', any ? '1' : '0', { expirationTtl: 6 * 3600 }).catch(() => undefined);
  }
}
async function countMailboxes(db: Db, tenants: string[]) {
  let n = 0;
  for (const t of tenants) {
    const r = await db.tx({ tenantId: t, readOnly: true }, (tx) => tx.one<{ n: number }>(`select count(*)::int as n from integrations where tenant_id = $1 and provider in ('google','microsoft') and status = 'active'`, [t]));
    n += r?.n ?? 0;
  }
  return n;
}
export async function markMailboxesPresent(env: Env) {
  await env.CACHE_KV?.put('mail:any', '1', { expirationTtl: 6 * 3600 }).catch(() => undefined);
}

// ---------------------------------------------------------------------------------- send
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
const b64urlBytes = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

export async function sendFromMailbox(env: Env, tx: Tx, i: Integration, msg: { to: string; cc?: string | null; subject: string; body: string; threadRef?: string | null }): Promise<{ messageId: string; providerId: string | null }> {
  const token = await mailboxToken(env, tx, i);
  const to = clean(msg.to);
  const cc = msg.cc ? clean(msg.cc) : '';
  if (i.provider === 'google') {
    const messageId = `<${crypto.randomUUID()}@synapse.hrpai.in>`;
    const raw = [
      `From: ${i.account_ref}`,
      `To: ${to}`,
      ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${encodeHeader(clean(msg.subject))}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      btoa(String.fromCharCode(...new TextEncoder().encode(msg.body))).replace(/.{76}/g, '$&\r\n'),
    ].join('\r\n');
    const r = await providerFetch<{ id: string; threadId: string }>(`${GMAIL}/messages/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: b64urlBytes(raw), ...(msg.threadRef ? { threadId: msg.threadRef } : {}) }),
    });
    return { messageId, providerId: r.id };
  }
  const list = (s: string) =>
    s
      .split(/[,;]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((address) => ({ emailAddress: { address } }));
  const draft = await providerFetch<{ id: string; internetMessageId: string }>(`${GRAPH}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ subject: clean(msg.subject), body: { contentType: 'Text', content: msg.body }, toRecipients: list(to), ccRecipients: cc ? list(cc) : [] }),
  });
  await providerFetch(`${GRAPH}/messages/${encodeURIComponent(draft.id)}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  return { messageId: draft.internetMessageId || `graph:${draft.id}`, providerId: draft.id };
}

// ---------------------------------------------------------------------------------- calendar
interface CalEvent {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string | Date;
  ends_at: string | Date;
  all_day: boolean;
  status: string;
  calendar_ref: { integrationId: string; id: string } | null;
}
const iso = (d: string | Date) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/** Creates, updates or removes the mirror of a CRM event in the owner's calendar. */
export async function pushCalendarEvent(env: Env, tx: Tx, i: Integration, ev: CalEvent | null, removeRef?: { id: string } | null): Promise<{ id: string } | null> {
  const token = await mailboxToken(env, tx, i);
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const google = i.provider === 'google';
  const base = google ? 'https://www.googleapis.com/calendar/v3/calendars/primary/events' : `${GRAPH}/events`;
  const ref = removeRef ?? (ev?.status === 'cancelled' && ev.calendar_ref?.integrationId === i.id ? ev.calendar_ref : null);
  if (!removeRef && ev?.status === 'cancelled' && !ref) return null;
  if (ref?.id) {
    await providerFetch(`${base}/${encodeURIComponent(ref.id)}`, { method: 'DELETE', headers: auth }).catch((e) => {
      if (!(e instanceof ProviderError && (e.status === 404 || e.status === 410))) throw e;
    });
    return null;
  }
  if (!ev) return null;
  const desc = [ev.description ?? '', 'Created in HRP Synapse'].filter(Boolean).join('\n\n');
  const body = google
    ? {
        summary: ev.title,
        description: desc,
        location: ev.location ?? undefined,
        start: ev.all_day ? { date: iso(ev.starts_at).slice(0, 10) } : { dateTime: iso(ev.starts_at) },
        end: ev.all_day ? { date: iso(ev.ends_at).slice(0, 10) } : { dateTime: iso(ev.ends_at) },
      }
    : {
        subject: ev.title,
        body: { contentType: 'text', content: desc },
        location: ev.location ? { displayName: ev.location } : undefined,
        isAllDay: ev.all_day,
        start: { dateTime: iso(ev.starts_at).replace('Z', ''), timeZone: 'UTC' },
        end: { dateTime: iso(ev.ends_at).replace('Z', ''), timeZone: 'UTC' },
      };
  if (ev.calendar_ref?.id && ev.calendar_ref.integrationId === i.id) {
    try {
      await providerFetch(`${base}/${encodeURIComponent(ev.calendar_ref.id)}`, { method: 'PATCH', headers: auth, body: JSON.stringify(body) });
      return { id: ev.calendar_ref.id };
    } catch (e) {
      if (!(e instanceof ProviderError && (e.status === 404 || e.status === 410))) throw e;
      // deleted on the calendar side: create it again
    }
  }
  const created = await providerFetch<{ id: string }>(base, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  return { id: created.id };
}

export function assertMailboxProvider(p: string): asserts p is 'google' | 'microsoft' {
  if (p !== 'google' && p !== 'microsoft') throw badRequest('Unknown mailbox provider');
}
