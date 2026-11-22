/**
 * Mail intake: the workspace's mailboxes are read every few minutes and the mail that is business —
 * GeM alerts, bills, invoices, statements — is taken in; everything else is never stored.
 *
 *   mailboxes   IMAP (GoDaddy / Titan, Zoho, Gmail with an app password, any host) or a connected
 *               Google / Microsoft account. Headers are read first; only mail that matters is downloaded.
 *               Read-only: nothing is marked read, moved or deleted.
 *   GeM         "New bid(s) published" alerts add the bids to GeM bids; corrigenda and other bid mails
 *               update the bid (count, date, status) and tell whoever follows it.
 *   bills       the PDF / images are kept; the browser reads the PDF text, the rules here read the invoice
 *               (number, date, GSTIN, taxable value, GST, total, lines) and a draft bill is created with
 *               the vendor (found by GSTIN or added) and the document attached.
 */
import { jsonSafe } from '../../lib/json-safe';
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { ImapError, withImap } from '../../lib/imap';
import { htmlText, parseMail, type ParsedMail, toBinary } from '../../lib/mime';
import { saveBillLines } from '../books/bills';
import { parseInvoiceText } from '../books/doc-import';
import { saveFile, signedFileUrl } from '../files';
import { type Integration, mailboxToken, ProviderError, providerFetch, readSecret, sealSecret } from '../integrations';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';
import { systemCtxFor } from '../system';
import { pdfText } from '../../lib/pdf-text';
import { defaultBidOwner, matchBidKeywords } from './gem';
import { readReceipt, whoseDocument } from './receipt';
import { businessTerms, type BusinessTerms, classify, hasDocument, type IntakeKind, namesBusiness, parseCorrigendum, parseGemUpdate, parseNewBids } from './parse';

const MAX_PER_RUN = 300;
const MAX_MAIL_BYTES = 20 * 1024 * 1024;

export function assertIntake(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (!['books', 'billing', 'projects', 'metadata'].some((k) => hasAdmin(p, k))) throw forbidden('Mail intake is for books, billing or projects admins');
}

/* ───────────────────────── mailboxes ───────────────────────── */

export const PRESETS: Record<string, { host: string; port: number; note: string }> = {
  // GoDaddy sells Titan under its own servers; Titan bought elsewhere uses imap.titan.email
  titan: {
    host: 'imap.secureserver.net',
    port: 993,
    note: 'GoDaddy Professional Email (powered by Titan): the mailbox password. In Titan settings turn on access from other apps, and keep two-step verification off (Titan blocks other apps while it is on).',
  },
  titan_direct: { host: 'imap.titan.email', port: 993, note: 'Titan Mail bought from Titan, Hostinger or others: the mailbox password, other-app access on, two-step verification off' },
  gmail: { host: 'imap.gmail.com', port: 993, note: 'Gmail / Google Workspace: turn on 2-step verification and use an app password' },
  zoho: { host: 'imap.zoho.in', port: 993, note: 'Zoho Mail (India): use an app-specific password' },
  outlook: { host: 'outlook.office365.com', port: 993, note: 'Microsoft 365 needs the Microsoft connection (password sign-in is switched off by Microsoft)' },
  outlook_personal: { host: 'outlook.office365.com', port: 993, note: 'Outlook.com / Hotmail: an app password from account.microsoft.com → Security (if Microsoft refuses it, connect the account instead)' },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, note: 'Yahoo Mail: an app password from Account security' },
};

export const mailboxSchema = z.object({
  label: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  provider: z.enum(['imap', 'google', 'microsoft']).default('imap'),
  host: z.string().trim().max(200).regex(/^[a-z0-9.-]+$/i).nullish(),
  port: z.number().int().min(1).max(65535).nullish(),
  tls: z.boolean().default(true),
  username: z.string().trim().max(200).nullish(),
  password: z.string().max(500).nullish(),
  integrationId: z.string().uuid().nullish(),
  folder: z.string().trim().min(1).max(200).default('INBOX'),
  readGem: z.boolean().default(true),
  readBills: z.boolean().default(true),
  businessOnly: z.boolean().default(false),
  firstDays: z.number().int().min(1).max(90).default(7),
  status: z.enum(['active', 'paused']).optional(),
});

const MB_COLS = `id, label, email, provider, host, port, tls, username, integration_id, folder, read_gem, read_bills, business_only, first_days, status, last_error, last_sync_at, last_count, last_uid, created_at,
  (secret_ciphertext is not null) as has_password`;

export async function listMailboxes(ctx: RecordCtx) {
  assertIntake(ctx);
  const rows = await ctx.tx.query(`select ${MB_COLS} from intake_mailboxes where tenant_id = $1 order by created_at`, [ctx.tenantId]);
  const conns = await ctx.tx.query(
    `select i.id, i.provider, i.account_ref, u.full_name from integrations i left join users u on u.tenant_id = i.tenant_id and u.id = i.user_id
      where i.tenant_id = $1 and i.provider in ('google','microsoft') and i.status = 'active' order by i.created_at`,
    [ctx.tenantId],
  );
  return { mailboxes: rows, connections: conns, presets: PRESETS };
}

/** Plain-text IMAP is allowed only to this machine (a local test server); passwords never travel in the clear. */
function checkTls(host: string, tls: boolean) {
  if (!tls && !/^(localhost|127\.0\.0\.1|::1)$/i.test(host)) throw badRequest('Mail is read over TLS (port 993); plain IMAP is not allowed');
}

export async function saveMailbox(ctx: RecordCtx, env: Env, id: string | null, input: z.infer<typeof mailboxSchema>) {
  assertIntake(ctx);
  if (input.provider === 'imap') {
    if (!input.host || !input.port) throw badRequest('Give the IMAP server and port (e.g. imap.secureserver.net, 993)');
    checkTls(input.host, input.tls);
    if (!id && !input.password) throw badRequest('Give the mailbox password (an app password for Gmail and Zoho)');
  } else {
    if (!input.integrationId) throw badRequest('Choose the connected account');
    const i = await ctx.tx.one(`select 1 from integrations where tenant_id = $1 and id = $2 and provider = $3 and status = 'active'`, [ctx.tenantId, input.integrationId, input.provider]);
    if (!i) throw badRequest('That connection is not active; connect the account first (Settings → Integrations)');
  }
  const secret = input.password ? await sealSecret(env, ctx.tenantId, { password: input.password }) : null;
  const vals = [
    input.label, input.email.toLowerCase(), input.provider, input.provider === 'imap' ? input.host!.toLowerCase() : null, input.provider === 'imap' ? input.port : null, input.tls,
    input.provider === 'imap' ? input.username || input.email : null, input.provider === 'imap' ? null : input.integrationId, input.folder, input.readGem, input.readBills, input.firstDays, input.businessOnly,
  ];
  if (id) {
    const r = await ctx.tx.one<{ id: string }>(
      `update intake_mailboxes set label = $3, email = $4, provider = $5, host = $6, port = $7, tls = $8, username = $9, integration_id = $10, folder = $11, read_gem = $12, read_bills = $13,
              first_days = $14, business_only = $15, secret_ciphertext = coalesce($16, secret_ciphertext), status = coalesce($17, case when status = 'error' then 'active' else status end), last_error = null
        where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals, secret, input.status ?? null],
    );
    if (!r) throw notFound('Mailbox not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into intake_mailboxes (tenant_id, label, email, provider, host, port, tls, username, integration_id, folder, read_gem, read_bills, first_days, business_only, secret_ciphertext)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [ctx.tenantId, ...vals, secret],
  ).catch((e: Error) => {
    if (/unique/i.test(e.message)) throw badRequest('That mailbox and folder are already being read');
    throw e;
  });
  return { id: r!.id };
}

export async function deleteMailbox(ctx: RecordCtx, id: string) {
  assertIntake(ctx);
  await ctx.tx.query(`delete from intake_mailboxes where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

/* ───────────────────────── reading ───────────────────────── */

interface Mailbox {
  id: string;
  label: string;
  email: string;
  provider: 'imap' | 'google' | 'microsoft';
  host: string | null;
  port: number | null;
  tls: boolean;
  username: string | null;
  secret_ciphertext: string | null;
  integration_id: string | null;
  folder: string;
  read_gem: boolean;
  read_bills: boolean;
  business_only: boolean;
  uid_validity: string | null;
  last_uid: string | null;
  first_days: number;
  created_by: string | null;
}

interface Fetched {
  /** where reading got to after this message (UID, or epoch ms for the API providers) */
  cursor: number;
  kind: IntakeKind;
  raw: Uint8Array;
}

const sinceDate = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
const hdr = (raw: Uint8Array) => {
  const m = parseMail(raw);
  const ct = /content-type:\s*([^;\r\n]+)/i.exec(toBinary(raw))?.[1]?.trim() ?? 'text/plain';
  return { from: m.from?.address ?? null, subject: m.subject, contentType: ct };
};

async function readImap(env: Env, mb: Mailbox, ownDomains: string[]) {
  const pass = (await readSecret<{ password?: string }>(env, { secret_ciphertext: mb.secret_ciphertext, tenant_id: (mb as any).tenant_id })).password;
  if (!pass) throw new ImapError('No password is saved for this mailbox', true);
  checkTls(mb.host!, mb.tls);
  return withImap({ host: mb.host!, port: mb.port!, tls: mb.tls, user: mb.username || mb.email, pass }, async (c) => {
    const box = await c.examine(mb.folder);
    const fresh = !mb.last_uid || String(box.uidValidity) !== String(mb.uid_validity ?? '');
    const uids = (fresh ? await c.search({ since: sinceDate(mb.first_days) }) : await c.search({ afterUid: Number(mb.last_uid) })).slice(-MAX_PER_RUN);
    const heads = await c.headers(uids);
    const out: Fetched[] = [];
    let cursor = fresh ? 0 : Number(mb.last_uid);
    for (const h of heads.sort((a, b) => a.uid - b.uid)) {
      cursor = Math.max(cursor, h.uid);
      const kind = classify({ ...hdr(h.header), ownDomains }, { gem: mb.read_gem, bills: mb.read_bills });
      if (!kind || h.size > MAX_MAIL_BYTES) continue;
      const raw = await c.message(h.uid, MAX_MAIL_BYTES);
      if (raw) out.push({ cursor: h.uid, kind, raw });
    }
    // nothing new: the cursor stays at the highest UID seen
    if (!heads.length && uids.length) cursor = Math.max(cursor, ...uids);
    return { uidValidity: box.uidValidity, cursor, mails: out, seen: heads.length };
  });
}

async function readGoogle(env: Env, tx: Parameters<typeof mailboxToken>[1], i: Integration, mb: Mailbox, ownDomains: string[]) {
  const token = await mailboxToken(env, tx, i);
  const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const after = mb.last_uid ? Math.floor(Number(mb.last_uid) / 1000) : Math.floor(Date.parse(`${sinceDate(mb.first_days)}T00:00:00Z`) / 1000);
  const q = encodeURIComponent(`after:${after} in:inbox${mb.read_gem && !mb.read_bills ? ' from:gem.gov.in' : ''}`);
  const list = await providerFetch<{ messages?: { id: string }[] }>(`${G}/messages?q=${q}&maxResults=${MAX_PER_RUN}`, { headers: { authorization: `Bearer ${token}` } });
  const out: Fetched[] = [];
  let cursor = Number(mb.last_uid ?? 0);
  for (const m of (list.messages ?? []).reverse()) {
    const meta = await providerFetch<{ internalDate: string; sizeEstimate: number; payload: { headers: { name: string; value: string }[]; mimeType: string } }>(
      `${G}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const at = Number(meta.internalDate);
    cursor = Math.max(cursor, at);
    const head = (n: string) => meta.payload.headers.find((x) => x.name.toLowerCase() === n)?.value ?? '';
    const kind = classify({ from: (/<([^>]+)>/.exec(head('from'))?.[1] ?? head('from')).toLowerCase(), subject: head('subject'), contentType: meta.payload.mimeType, ownDomains }, { gem: mb.read_gem, bills: mb.read_bills });
    if (!kind || meta.sizeEstimate > MAX_MAIL_BYTES) continue;
    const raw = await providerFetch<{ raw: string }>(`${G}/messages/${m.id}?format=raw`, { headers: { authorization: `Bearer ${token}` } });
    const bin = atob(raw.raw.replace(/-/g, '+').replace(/_/g, '/'));
    out.push({ cursor: at, kind, raw: Uint8Array.from(bin, (ch) => ch.charCodeAt(0)) });
  }
  return { uidValidity: null, cursor, mails: out, seen: list.messages?.length ?? 0 };
}

async function readMicrosoft(env: Env, tx: Parameters<typeof mailboxToken>[1], i: Integration, mb: Mailbox, ownDomains: string[]) {
  const token = await mailboxToken(env, tx, i);
  const since = mb.last_uid ? new Date(Number(mb.last_uid)).toISOString() : `${sinceDate(mb.first_days)}T00:00:00Z`;
  const url = `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$filter=receivedDateTime gt ${since}&$orderby=receivedDateTime asc&$top=${Math.min(MAX_PER_RUN, 100)}&$select=id,subject,from,hasAttachments,receivedDateTime`;
  const list = await providerFetch<{ value: { id: string; subject: string; from?: { emailAddress?: { address?: string } }; hasAttachments: boolean; receivedDateTime: string }[] }>(url, { headers: { authorization: `Bearer ${token}` } });
  const out: Fetched[] = [];
  let cursor = Number(mb.last_uid ?? 0);
  for (const m of list.value) {
    const at = Date.parse(m.receivedDateTime);
    cursor = Math.max(cursor, at);
    const kind = classify({ from: m.from?.emailAddress?.address ?? null, subject: m.subject ?? '', contentType: m.hasAttachments ? 'multipart/mixed' : 'text/html', ownDomains }, { gem: mb.read_gem, bills: mb.read_bills });
    if (!kind) continue;
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${m.id}/$value`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ProviderError(`Outlook answered ${res.status}`, res.status);
    out.push({ cursor: at, kind, raw: new Uint8Array(await res.arrayBuffer()) });
  }
  return { uidValidity: null, cursor, mails: out, seen: list.value.length };
}

/** Reads one mailbox now: new business mail is taken in. */
export async function syncMailbox(env: Env, db: Db, tenantId: string, mailboxId: string) {
  const run = <T>(fn: (ctx: RecordCtx) => Promise<T>) =>
    db.tx({ tenantId }, async (tx) => {
      const ctx = await systemCtxFor(env, tx, tenantId);
      if (!ctx) throw new Error('workspace not found');
      return fn(ctx);
    });
  const { mb, own, integration } = await run(async (ctx) => {
    const mb = await ctx.tx.one<Mailbox>(`select * from intake_mailboxes where tenant_id = $1 and id = $2`, [tenantId, mailboxId]);
    if (!mb) throw notFound('Mailbox not found');
    const t = await ctx.tx.one<{ settings: any }>(`select settings from tenants where id = $1`, [tenantId]);
    const site = String(t?.settings?.company?.website ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const own = [...new Set([mb.email.split('@')[1], site].filter((x): x is string => !!x).map((x) => x.toLowerCase()))];
    const integration = mb.integration_id ? await ctx.tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [tenantId, mb.integration_id]) : null;
    return { mb, own, integration };
  });
  const terms = mb.business_only ? await run((ctx) => termsOf(ctx)) : null;
  let got: { uidValidity: number | null; cursor: number; mails: Fetched[]; seen: number };
  try {
    got =
      mb.provider === 'imap'
        ? await readImap(env, { ...mb, tenant_id: tenantId } as Mailbox, own)
        : await run((ctx) => (mb.provider === 'google' ? readGoogle(env, ctx.tx, integration!, mb, own) : readMicrosoft(env, ctx.tx, integration!, mb, own)));
  } catch (e) {
    const titan = /secureserver|titan/i.test(mb.host ?? '');
    const msg =
      e instanceof ImapError && e.auth
        ? titan
          ? `Sign-in failed. For GoDaddy / Titan mail: use server imap.secureserver.net (GoDaddy) or imap.titan.email (Titan bought elsewhere), the full address and the mailbox password; in Titan settings turn on access from other apps and turn two-step verification off. (${e.message})`
          : `Sign-in failed: check the password (Gmail, Yahoo, Outlook.com and Zoho need an app password). (${e.message})`
        : (e as Error).message;
    await run((ctx) => ctx.tx.query(`update intake_mailboxes set status = 'error', last_error = $3, last_sync_at = now() where tenant_id = $1 and id = $2`, [tenantId, mailboxId, msg.slice(0, 1000)]));
    throw badRequest(msg);
  }
  const events: RecordEvent[] = [];
  let taken = 0;
  let bids = 0;
  for (const m of got.mails) {
    // one mail that cannot be taken in does not hold up the rest
    const r = await run((ctx) => takeIn(ctx, env, mb, m.kind, parseMail(m.raw), terms)).catch(() => null);
    if (r) {
      taken++;
      bids += r.newBids;
      events.push(...r.events);
    }
  }
  await run(async (ctx) => {
    await ctx.tx.query(
      `update intake_mailboxes set last_uid = $3, uid_validity = coalesce($4, uid_validity), last_sync_at = now(), last_count = $5, status = case when status = 'error' then 'active' else status end, last_error = null
        where tenant_id = $1 and id = $2`,
      [tenantId, mailboxId, got.cursor || mb.last_uid, got.uidValidity, taken],
    );
    if (bids && mb.created_by)
      await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'gem',$3,$4,'/intake/gem')`, [
        tenantId, mb.created_by, `${bids} new GeM bid${bids === 1 ? '' : 's'}`, `From ${mb.email}`,
      ]);
  });
  return { seen: got.seen, taken, newBids: bids, events };
}

/* ───────────────────────── taking a mail in ───────────────────────── */

async function upsertBid(ctx: RecordCtx, bidNumber: string, fields: Record<string, unknown>, itemId: string) {
  const cur = await ctx.tx.one<{ id: string }>(`select id from gem_bids where tenant_id = $1 and bid_number = $2`, [ctx.tenantId, bidNumber]);
  if (cur) {
    const sets = Object.entries(fields).filter(([, v]) => v !== null && v !== undefined);
    if (sets.length)
      await ctx.tx.query(`update gem_bids set ${sets.map(([k], i) => `${k} = coalesce(${k}, $${i + 3})`).join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, [
        ctx.tenantId, cur.id, ...sets.map(([, v]) => v),
      ]);
    return { id: cur.id, created: false };
  }
  // a new bid goes to the person the admin chose (else the workspace owner)
  fields = { ...fields, owner_id: fields.owner_id ?? (await defaultBidOwner(ctx)) };
  const keys = Object.keys(fields).filter((k) => fields[k] !== null && fields[k] !== undefined);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into gem_bids (tenant_id, bid_number, source_item_id${keys.map((k) => `, ${k}`).join('')}) values ($1,$2,$3${keys.map((_, i) => `,$${i + 4}`).join('')}) returning id`,
    [ctx.tenantId, bidNumber, itemId, ...keys.map((k) => fields[k])],
  );
  await matchBidKeywords(ctx, r!.id);
  return { id: r!.id, created: true };
}

async function tellFollowers(ctx: RecordCtx, bidId: string, title: string) {
  const b = await ctx.tx.one<{ owner_id: string | null; status: string; bid_number: string }>(`select owner_id, status, bid_number from gem_bids where tenant_id = $1 and id = $2`, [ctx.tenantId, bidId]);
  if (b?.owner_id && ['new', 'reviewing', 'preparing', 'submitted', 'technically_qualified'].includes(b.status))
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, link) values ($1,$2,'gem',$3,$4)`, [ctx.tenantId, b.owner_id, `${b.bid_number}: ${title}`.slice(0, 200), `/intake/gem?bid=${bidId}`]);
}

/** The business's GSTINs, PAN, names and partners: what a personal mailbox's mail must mention. */
export async function termsOf(ctx: RecordCtx): Promise<BusinessTerms> {
  const t = await ctx.tx.one<{ name: string; company: any; org: any }>(`select name, settings -> 'company' as company, settings -> 'organisation' as org from tenants where id = $1`, [ctx.tenantId]);
  const c = { ...(t?.org ?? {}), ...(t?.company ?? {}) };
  const gst = await ctx.tx.query<{ gstin: string }>(`select gstin from gst_connections where tenant_id = $1`, [ctx.tenantId]).catch(() => []);
  const partners = await ctx.tx.query<{ name: string }>(`select name from acct_persons where tenant_id = $1`, [ctx.tenantId]);
  return businessTerms({ gstins: [c.gstin, ...gst.map((g) => g.gstin)], pan: c.pan, names: [c.legalName, c.tradeName, t?.name], partners: partners.map((p) => p.name) });
}

export async function takeIn(ctx: RecordCtx, env: Env, mb: Pick<Mailbox, 'id'>, kind: IntakeKind, m: ParsedMail, terms: BusinessTerms | null = null): Promise<{ id: string; newBids: number; events: RecordEvent[] } | null> {
  const messageId = m.messageId ?? `${m.from?.address ?? ''}|${m.date ?? ''}|${m.subject}`.slice(0, 500);
  if (await ctx.tx.one(`select 1 from intake_items where tenant_id = $1 and message_id = $2`, [ctx.tenantId, messageId])) return null;
  const text = (m.text || (m.html ? htmlText(m.html) : '')).slice(0, 30000);
  const docs = m.attachments.filter((a) => a.bytes.length <= 25 * 1024 * 1024);
  if ((kind === 'bill' || kind === 'invoice' || kind === 'statement') && !hasDocument(docs.map((a) => ({ filename: a.filename, contentType: a.contentType, size: a.bytes.length })))) return null;
  // a personal mailbox: only mail that names the business (in the mail, a file name or the PDF) is kept
  let matched: string | null = null;
  if (terms && !kind.startsWith('gem')) {
    matched = namesBusiness(`${m.subject}\n${text}\n${docs.map((a) => a.filename).join('\n')}`, terms);
    for (const a of docs) {
      if (matched) break;
      if (a.contentType === 'application/pdf' || /\.pdf$/i.test(a.filename)) matched = namesBusiness(await pdfText(a.bytes), terms);
    }
    if (!matched) return null;
  }
  const item = await ctx.tx.one<{ id: string }>(
    `insert into intake_items (tenant_id, mailbox_id, message_id, received_at, from_address, from_name, subject, body, kind, status, matched_on)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, mb.id, messageId, m.date, m.from?.address ?? null, m.from?.name ?? null, m.subject.slice(0, 500), text, kind, kind.startsWith('gem') ? 'done' : 'new', matched],
  );
  const id = item!.id;
  let newBids = 0;
  if (kind === 'gem_new_bids') {
    const bids = parseNewBids(text);
    const ids: string[] = [];
    for (const b of bids) {
      const r = await upsertBid(ctx, b.bidNumber, { title: b.title, category: b.title, quantity: b.quantity, start_at: b.startAt, end_at: b.endAt, organisation: b.organisation }, id);
      if (r.created) newBids++;
      ids.push(b.bidNumber);
    }
    await ctx.tx.query(`update intake_items set data = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe({ bids: ids })]);
  } else if (kind === 'gem_corrigendum') {
    const c = parseCorrigendum(m.subject, text);
    if (c.bidNumber) {
      const r = await upsertBid(ctx, c.bidNumber, { bid_date: c.bidDate }, id);
      await ctx.tx.query(`update gem_bids set corrigenda = corrigenda + 1, last_corrigendum_at = greatest(last_corrigendum_at, $3::timestamptz), updated_at = now() where tenant_id = $1 and id = $2`, [
        ctx.tenantId, r.id, c.corrigendumAt ?? m.date,
      ]);
      await ctx.tx.query(`update intake_items set data = $3, link_object = 'gem_bid', link_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe(c), r.id]);
      await tellFollowers(ctx, r.id, 'corrigendum issued — check the changes on GeM');
    }
  } else if (kind === 'gem_update') {
    const u = parseGemUpdate(m.subject, text);
    if (u.bidNumber) {
      const r = await upsertBid(ctx, u.bidNumber, {}, id);
      if (u.status)
        await ctx.tx.query(`update gem_bids set status = $3, updated_at = now() where tenant_id = $1 and id = $2 and status not in ('won','lost','cancelled','skipped')`, [ctx.tenantId, r.id, u.status]);
      await ctx.tx.query(`update intake_items set data = $3, link_object = 'gem_bid', link_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe(u), r.id]);
      await tellFollowers(ctx, r.id, u.what);
    }
  } else {
    const files = [];
    for (const a of docs) {
      if (!(a.contentType === 'application/pdf' || a.contentType.startsWith('image/') || /\.(pdf|jpe?g|png|webp|xlsx?|csv)$/i.test(a.filename)) || a.bytes.length < 500) continue;
      try {
        const f = await saveFile(ctx, env, { objectKey: 'intake_item', recordId: id, name: a.filename, bytes: a.bytes, kind: 'document' }, { system: true });
        files.push({ fileId: f.id, name: f.name, contentType: f.contentType, size: f.size });
      } catch {
        /* a type the store refuses: skipped */
      }
    }
    await ctx.tx.query(`update intake_items set attachments = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe(files)]);
  }
  return { id, newBids, events: [] };
}

/** Every mailbox due, every ~15 minutes (business hours unless MAIL_SYNC_ALWAYS). */
export async function intakeSweep(env: Env, db: Db) {
  const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
  for (const t of tenants) {
    const due = await db
      .tx({ tenantId: t.tenant_id, readOnly: true }, (tx) =>
        tx.query<{ id: string }>(
          `select id from intake_mailboxes where tenant_id = $1 and status <> 'paused' and (last_sync_at is null or last_sync_at < now() - interval '14 minutes')
              and (status <> 'error' or last_sync_at < now() - interval '2 hours') order by last_sync_at nulls first limit 10`,
          [t.tenant_id],
        ),
      )
      .catch(() => []);
    for (const d of due) await syncMailbox(env, db, t.tenant_id, d.id).catch(() => undefined);
  }
}

/* ───────────────────────── the intake list ───────────────────────── */

export async function listItems(ctx: RecordCtx, env: Env, q: { status?: string | null; kind?: string | null } = {}) {
  assertIntake(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select i.id, i.received_at, i.from_address, i.from_name, i.subject, i.kind, i.status, i.data, i.attachments, i.link_object, i.link_id, i.note, i.matched_on, m.email as mailbox, m.business_only
       from intake_items i left join intake_mailboxes m on m.tenant_id = i.tenant_id and m.id = i.mailbox_id
      where i.tenant_id = $1 and ($2::text is null or i.status = $2) and ($3::text is null or i.kind = $3 or ($3 = 'gem' and i.kind like 'gem%') or ($3 = 'docs' and i.kind not like 'gem%'))
      order by i.received_at desc nulls last limit 500`,
    [ctx.tenantId, q.status ?? null, q.kind ?? null],
  );
  for (const r of rows) for (const a of r.attachments as Record<string, any>[]) a.url = await signedFileUrl(env, ctx.tenantId, a.fileId, true);
  return rows;
}

export async function getItem(ctx: RecordCtx, env: Env, id: string) {
  assertIntake(ctx);
  const r = await ctx.tx.one<Record<string, any>>(`select * from intake_items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!r) throw notFound('Mail not found');
  for (const a of r.attachments as Record<string, any>[]) {
    a.url = await signedFileUrl(env, ctx.tenantId, a.fileId, true);
    a.download = await signedFileUrl(env, ctx.tenantId, a.fileId, false);
  }
  return r;
}

export async function setItemStatus(ctx: RecordCtx, id: string, status: 'new' | 'done' | 'ignored', note?: string | null) {
  assertIntake(ctx);
  const r = await ctx.tx.one(`update intake_items set status = $3, note = coalesce($4, note) where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, status, note ?? null]);
  if (!r) throw notFound('Mail not found');
}

/* ───────────────────────── bills from mail ───────────────────────── */

/** Bumped when the reading of mailed documents improves: files read before are read again. */
export const READ_VERSION = 5;

export async function ownGstins(ctx: RecordCtx) {
  const t = await ctx.tx.one<{ settings: any }>(`select settings from tenants where id = $1`, [ctx.tenantId]);
  return [t?.settings?.company?.gstin].filter((g): g is string => !!g).map((g) => g.toUpperCase());
}

/** The PDF's text (read by the browser) → the invoice on it. */
export async function readAttachment(ctx: RecordCtx, id: string, fileId: string, pages: string[]) {
  assertIntake(ctx);
  const it = await ctx.tx.one<{ data: Record<string, any>; attachments: { fileId: string }[] }>(`select data, attachments from intake_items where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!it) throw notFound('Mail not found');
  if (!it.attachments.some((a) => a.fileId === fileId)) throw badRequest('That file is not on this mail');
  const own = await ownGstins(ctx);
  const text = pages.join('\n\n');
  const r = text.trim().length > 40 ? parseInvoiceText(text, own) : null;
  // which GSTINs are on it: ours as the buyer → a bill; ours as the seller → our own invoice
  const gstins = [...new Set((text.toUpperCase().match(/\b\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]\b/g) ?? []))];
  const ours = gstins.filter((g) => own.includes(g));
  const party = gstins.find((g) => !own.includes(g)) ?? r?.data.customer?.gstin ?? null;
  // the second reading: foreign currency, full numbers, written-out dates, amount paid, the card
  const names = await ctx.tx.one<{ n: string | null; l: string | null }>(`select name as n, settings -> 'company' ->> 'legalName' as l from tenants where id = $1`, [ctx.tenantId]);
  const receipt = text.trim().length > 40 ? readReceipt(text, [names?.n, names?.l].filter((x): x is string => !!x)) : null;
  // our own invoice (made in Zoho or elsewhere) to a customer, not a supplier's bill
  const whose = text.trim().length > 40 ? whoseDocument(text, own, [names?.n, names?.l].filter((x): x is string => !!x)) : null;
  // (a choice made by hand on this mail — data.whose — always wins over the reading)
  const chosen = it.data.whose as 'ours' | 'theirs' | undefined;
  if (!chosen && whose === 'ours') await ctx.tx.query(`update intake_items set kind = 'invoice' where tenant_id = $1 and id = $2 and kind in ('bill','payment')`, [ctx.tenantId, id]);
  // read again and found to be addressed to us: back to a bill (an earlier reading may have called it ours)
  if (!chosen && whose === 'theirs') await ctx.tx.query(`update intake_items set kind = 'bill' where tenant_id = $1 and id = $2 and kind = 'invoice'`, [ctx.tenantId, id]);
  if (r && receipt && whose !== 'ours') {
    const d = r.data as Record<string, any>;
    // a number read under its heading wins over a heading word or a cut-short one ("INVOICE", "F13F9483")
    if (receipt.number && (!d.number || !/\d/.test(String(d.number)) || receipt.number.startsWith(d.number) || receipt.number.length > String(d.number).length)) d.number = receipt.number;
    d.date ??= receipt.date;
    const lines = receipt.lines.map((l) => ({ description: l.period ? `${l.description} (${l.period})` : l.description, hsn: l.hsn ?? receipt.hsnSac, qty: l.qty, rate: l.unitPrice, amount: l.amount, taxRate: l.taxPct ?? receipt.taxRate ?? 0 }));
    if (receipt.currency !== 'INR') {
      d.currency = receipt.currency;
      if (receipt.subtotal != null) d.taxable = receipt.subtotal;
      if (receipt.total != null) d.total = receipt.total;
      d.cgst = 0;
      d.sgst = 0;
      d.igst = receipt.tax ?? 0;
      if (lines.length) d.lines = lines;
    } else {
      // what the Indian rules missed: lines, values and tax from the headings and table
      if (!d.lines?.length && lines.length) d.lines = lines;
      d.taxable ??= receipt.subtotal;
      d.total ??= receipt.total;
      if (!Number(d.cgst) && !Number(d.sgst) && !Number(d.igst)) {
        d.cgst = receipt.cgst ?? 0;
        d.sgst = receipt.sgst ?? 0;
        d.igst = receipt.igst ?? (receipt.cgst || receipt.sgst ? 0 : (receipt.tax ?? 0));
      }
      if (receipt.reverseCharge != null) d.reverseCharge = receipt.reverseCharge;
      if (receipt.placeOfSupply) d.placeOfSupply = receipt.placeOfSupply;
    }
    if (receipt.paid) d.paid = { ...(d.paid ?? {}), status: 'paid', amount: d.paid?.amount ?? receipt.amountPaid ?? receipt.total, date: d.paid?.date ?? receipt.paidOn };
    // with the number, date, supplier, lines and totals read, it is no longer a guess
    const got = [d.number, d.date, receipt.supplier.name, d.lines?.length, d.total ?? d.taxable].filter(Boolean).length;
    r.confidence = Math.max(r.confidence ?? 0, got / 5);
  }
  const read = r
    ? { ...r, v: READ_VERSION, text: text.slice(0, 30000), whose, receipt, party: { gstin: receipt?.supplier.foreign ? null : party, name: receipt?.supplier.name ?? r.data.customer?.name ?? null }, ours: ours.length > 0, scanned: false }
    : { data: null, v: READ_VERSION, receipt: null, confidence: 0, warnings: ['No text in this file (a scan or photo): enter the bill by hand'], scanned: true };
  const data = { ...it.data, reads: { ...(it.data.reads ?? {}), [fileId]: read } };
  await ctx.tx.query(`update intake_items set data = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, jsonSafe(data)]);
  return read;
}

export const billFromMailSchema = z.object({
  fileId: z.string().uuid(),
  vendorId: z.string().uuid().nullish(),
  vendorName: z.string().trim().min(2).max(200).nullish(),
  number: z.string().trim().max(60).nullish(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  taxable: z.number().min(0).max(1e12).nullish(),
  taxRate: z.number().min(0).max(40).nullish(),
});

/** A draft bill from a mailed invoice: the vendor (by GSTIN, or added), the amounts read, the PDF attached. */
export async function billFromMail(ctx: RecordCtx, env: Env, id: string, input: z.infer<typeof billFromMailSchema>) {
  assertIntake(ctx);
  const it = await ctx.tx.one<{ data: Record<string, any>; attachments: { fileId: string; name: string }[]; from_name: string | null; from_address: string | null; subject: string; link_id: string | null }>(
    `select data, attachments, from_name, from_address, subject, link_id from intake_items where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, id],
  );
  if (!it) throw notFound('Mail not found');
  if (it.link_id) throw badRequest('A bill was already made from this mail');
  const att = it.attachments.find((a) => a.fileId === input.fileId);
  if (!att) throw badRequest('That file is not on this mail');
  const read = it.data.reads?.[input.fileId] as { data: any; party?: { gstin: string | null; name: string | null } } | undefined;
  const d = read?.data ?? {};
  const events: RecordEvent[] = [];
  // the vendor: chosen, or by GSTIN, or by name, or added
  let vendorId = input.vendorId ?? null;
  const gstin = read?.party?.gstin ?? null;
  if (!vendorId && gstin) vendorId = (await ctx.tx.one<{ id: string }>(`select id from vendors where tenant_id = $1 and upper(gstin) = $2 and deleted_at is null`, [ctx.tenantId, gstin]))?.id ?? null;
  const name = input.vendorName ?? read?.party?.name ?? it.from_name ?? it.from_address?.split('@')[1]?.split('.')[0] ?? 'Vendor';
  if (!vendorId) vendorId = (await ctx.tx.one<{ id: string }>(`select id from vendors where tenant_id = $1 and lower(name) = lower($2) and deleted_at is null`, [ctx.tenantId, name]))?.id ?? null;
  if (!vendorId) {
    const v = await createRecord(ctx, 'vendor', { name, gstin, email: it.from_address, notes: 'Added from a mailed invoice' });
    vendorId = String(v.record.id);
    events.push(...v.events);
  }
  const number = input.number ?? d.number ?? null;
  const date = input.date ?? d.date ?? null;
  if (number && (await ctx.tx.one(`select 1 from bills where tenant_id = $1 and vendor_id = $2 and vendor_ref = $3 and deleted_at is null and status <> 'void'`, [ctx.tenantId, vendorId, number])))
    throw badRequest(`Bill ${number} of this vendor is already in the books`);
  const b = await createRecord(ctx, 'bill', { name: `${name}${number ? ` — ${number}` : ''}`.slice(0, 200), vendor_id: vendorId, vendor_ref: number, bill_date: date, due_date: d.dueDate ?? null });
  const billId = String(b.record.id);
  events.push(...b.events);
  const taxable = input.taxable ?? d.taxable ?? null;
  const tax = Number(d.cgst ?? 0) + Number(d.sgst ?? 0) + Number(d.igst ?? 0);
  const rate = input.taxRate ?? (taxable ? [0, 5, 12, 18, 28, 40].reduce((best, r) => (Math.abs((taxable * r) / 100 - tax) < Math.abs((taxable * best) / 100 - tax) ? r : best), 18) : 18);
  const lines =
    Array.isArray(d.lines) && d.lines.length && !input.taxable
      ? d.lines.slice(0, 300).map((l: any) => ({ name: String(l.description).slice(0, 200), hsnSac: l.hsn ?? null, quantity: l.qty || 1, unitPrice: l.qty ? l.rate : l.amount, taxRate: l.taxRate ?? rate, discountPct: 0 }))
      : taxable
        ? [{ name: `As per invoice ${number ?? ''}`.trim().slice(0, 200), quantity: 1, unitPrice: taxable, taxRate: rate, discountPct: 0 }]
        : [];
  if (lines.length) events.push(...(await saveBillLines(ctx, billId, lines as never)));
  // the invoice itself goes with the bill
  const obj = await ctx.tx.one<{ storage_key: string; name: string }>(`select storage_key, name from files where tenant_id = $1 and id = $2`, [ctx.tenantId, input.fileId]);
  if (obj && env.FILES) {
    const body = await env.FILES.get(obj.storage_key);
    if (body) await saveFile(ctx, env, { objectKey: 'bill', recordId: billId, name: obj.name, bytes: new Uint8Array(await body.arrayBuffer()), kind: 'document' }, { system: true });
  }
  await ctx.tx.query(`update intake_items set status = 'done', link_object = 'bill', link_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, billId]);
  return { billId, vendorId, lines: lines.length, events };
}

/** Settles by hand whose document a mail is: "theirs" (a bill or receipt we paid) or "ours" (our invoice to a customer). */
export async function setWhose(ctx: RecordCtx, id: string, whose: 'ours' | 'theirs') {
  assertIntake(ctx);
  const it = await ctx.tx.one<{ data: Record<string, any>; status: string }>(`select data, status from intake_items where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!it) throw notFound('Mail not found');
  if (it.status === 'done') throw badRequest('This mail was already imported');
  const data: Record<string, any> = { ...it.data, whose };
  if (whose === 'theirs' && Array.isArray(it.data.importItemIds)) {
    // the sales-invoice import prepared for it is dropped
    await ctx.tx.query(`update doc_import_items set status = 'rejected' where tenant_id = $1 and id = any($2::uuid[]) and status in ('pending','failed')`, [ctx.tenantId, it.data.importItemIds]);
    delete data.importId;
    delete data.importItemIds;
  }
  await ctx.tx.query(`update intake_items set kind = $3, data = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, whose === 'ours' ? 'invoice' : 'bill', jsonSafe(data)]);
  return { ok: true, whose };
}
