/**
 * Privacy and DPDP Act 2023 tooling.
 *
 *  - Consent: an append-only evidence ledger (consent_events) plus the current state on the record
 *    (leads.consent / contacts.consent). Withdrawing consent also adds the address to the
 *    do-not-contact list (suppressions), which survives merges, deletions and re-imports.
 *  - Data-principal requests: access, correction, erasure, grievance, nomination and consent
 *    withdrawal, with a deadline, email verification for portal requests and a status link.
 *  - Erasure anonymises the person's record, messages, timeline and files. Tax documents
 *    (invoices, payments) are kept because GST law requires it; the response says so.
 *  - Retention rules erase stale personal data automatically (daily).
 *  - Breach register, and a hash-chained audit export so tampering with an exported trail shows.
 */
import { objectPerm, type FieldDef } from '@synapse/shared';
import type { Env } from '../env';
import { hmacSha256Hex, randomToken, sha256Hex, timingSafeEqual } from '../lib/crypto';
import type { Db, Tx } from '../lib/db';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { actionEmail, sendPlatformMail } from './mailer';
import { getObject, loadRow, type RecordCtx } from './records';

export const PURPOSES = ['marketing', 'whatsapp', 'email', 'sms', 'calls', 'processing'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const CONTACT_CHANNELS = ['whatsapp', 'email', 'sms', 'calls'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export type Subject = { object: 'lead' | 'contact'; id: string };

const TABLE = { lead: 'leads', contact: 'contacts' } as const;

/** Phone numbers match on their last 10 digits, email addresses case-insensitively. */
export function addressKey(address: string | null | undefined): string | null {
  if (!address) return null;
  const a = address.trim();
  if (a.includes('@')) return a.toLowerCase();
  const d = a.replace(/[^0-9]/g, '');
  return d.length >= 6 ? d.slice(-10) : null;
}
/** Erased people stay on the do-not-contact list without their address being kept. */
export async function hashedKey(key: string) {
  return `h:${(await sha256Hex(`synapse-suppression:${key}`)).slice(0, 40)}`;
}

// ------------------------------------------------------------------------------------- consent

export type ConsentState = Partial<Record<Purpose, { granted: boolean; at: string; source: string }>>;

/** Whether a marketing message may go to this person on this channel. */
export function consentAllows(state: ConsentState | null | undefined, channel: ContactChannel): boolean {
  const s = state ?? {};
  const own = s[channel];
  if (own) return own.granted;
  return !!s.marketing?.granted;
}

export async function isSuppressed(tx: Tx, tenantId: string, channel: ContactChannel, address: string | null | undefined): Promise<string | null> {
  const key = addressKey(address);
  if (!key) return null;
  const r = await tx.one<{ reason: string }>(
    `select reason from suppressions where tenant_id = $1 and channel in ($2, 'all') and address_key in ($3, $4) limit 1`,
    [tenantId, channel, key, await hashedKey(key)],
  );
  return r?.reason ?? null;
}

/**
 * The single check every outbound message goes through.
 *  marketing: needs consent for the channel (or general marketing consent) and no suppression.
 *  transactional (quotes, invoices, replies, service updates): only an erasure or an "all
 *  channels" block stops it, unless respectOptOut (campaigns) is set.
 */
export async function canContact(tx: Tx, tenantId: string, channel: ContactChannel, address: string | null | undefined, opts: { marketing: boolean; consent?: ConsentState | null; respectOptOut?: boolean }) {
  const key = addressKey(address);
  if (!key) return { ok: false, reason: 'no_address' as const };
  const rows = await tx.query<{ channel: string; reason: string }>(
    `select channel, reason from suppressions where tenant_id = $1 and channel in ($2, 'all') and address_key in ($3, $4)`,
    [tenantId, channel, key, await hashedKey(key)],
  );
  if (rows.some((r) => r.channel === 'all' || r.reason === 'erasure')) return { ok: false, reason: 'blocked' as const };
  // bulk sends (campaigns) honour a channel opt-out even for utility templates
  if (rows.length && (opts.marketing || opts.respectOptOut)) return { ok: false, reason: 'opted_out' as const };
  if (!opts.marketing) return { ok: true, reason: null };
  if (!consentAllows(opts.consent, channel)) return { ok: false, reason: 'no_consent' as const };
  return { ok: true, reason: null };
}

async function subjectRow(tx: Tx, tenantId: string, s: Subject) {
  return tx.one<{ id: string; email: string | null; phone: string | null; consent: ConsentState; full_name: string | null }>(
    `select id, email, phone, consent, full_name from ${TABLE[s.object]} where tenant_id = $1 and id = $2`,
    [tenantId, s.id],
  );
}

/** Records consent given or withdrawn, with evidence. Used by people, forms, WhatsApp STOP, the portal and the API. */
export async function recordConsent(
  tx: Tx,
  tenantId: string,
  s: Subject,
  change: { purpose: Purpose; granted: boolean; source: string; evidence?: Record<string, unknown>; noticeVersion?: number | null },
) {
  const row = await subjectRow(tx, tenantId, s);
  if (!row) throw notFound();
  const notice = change.noticeVersion ?? (await currentNoticeVersion(tx, tenantId));
  await tx.query(
    `insert into consent_events (tenant_id, subject_object, subject_id, purpose, granted, source, notice_version, evidence) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tenantId, s.object, s.id, change.purpose, change.granted, change.source, notice, JSON.stringify(change.evidence ?? {})],
  );
  const at = new Date().toISOString();
  await tx.query(`update ${TABLE[s.object]} set consent = coalesce(consent, '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb) where tenant_id = $1 and id = $2`, [
    tenantId,
    s.id,
    change.purpose,
    JSON.stringify({ granted: change.granted, at, source: change.source, ...(notice ? { notice } : {}) }),
  ]);
  // withdrawing marketing consent puts the person's addresses on the do-not-contact list
  const channels: ContactChannel[] = change.purpose === 'marketing' ? [...CONTACT_CHANNELS] : (CONTACT_CHANNELS as readonly string[]).includes(change.purpose) ? [change.purpose as ContactChannel] : [];
  for (const ch of channels) {
    const addr = ch === 'email' ? row.email : row.phone;
    const key = addressKey(addr);
    if (!key) continue;
    if (!change.granted) {
      await tx.query(`insert into suppressions (tenant_id, channel, address_key, reason, note) values ($1,$2,$3,'opt_out',$4) on conflict do nothing`, [tenantId, ch, key, `${change.source}`]);
    } else {
      // opting back in lifts an earlier opt-out (never an erasure, bounce or complaint block)
      await tx.query(`delete from suppressions where tenant_id = $1 and channel = $2 and address_key = $3 and reason = 'opt_out'`, [tenantId, ch, key]);
    }
  }
  return { ok: true };
}

/** Opt-out by address (a WhatsApp "STOP", an unsubscribe link): every matching lead and contact is updated. */
export async function optOutAddress(tx: Tx, tenantId: string, channel: ContactChannel, address: string, source: string, evidence: Record<string, unknown> = {}) {
  const key = addressKey(address);
  if (!key) return { subjects: 0 };
  await tx.query(`insert into suppressions (tenant_id, channel, address_key, reason, note) values ($1,$2,$3,'opt_out',$4) on conflict do nothing`, [tenantId, channel, key, source]);
  const match = key.includes('@') ? `lower(email) = $2` : `app.phone_key(phone) = $2`;
  let n = 0;
  for (const object of ['lead', 'contact'] as const) {
    const rows = await tx.query<{ id: string }>(`select id from ${TABLE[object]} where tenant_id = $1 and ${match} and deleted_at is null limit 50`, [tenantId, key]);
    for (const r of rows) {
      await recordConsent(tx, tenantId, { object, id: r.id }, { purpose: channel, granted: false, source, evidence });
      n++;
    }
  }
  return { subjects: n };
}

export async function consentHistory(ctx: RecordCtx, s: Subject) {
  await loadRow(ctx, s.object, s.id, 'read');
  const row = await subjectRow(ctx.tx, ctx.tenantId, s);
  const events = await ctx.tx.query(
    `select e.id, e.purpose, e.granted, e.source, e.notice_version, e.evidence, e.created_at, u.full_name as actor
       from consent_events e left join users u on u.tenant_id = e.tenant_id and u.id = e.actor_id
      where e.tenant_id = $1 and e.subject_object = $2 and e.subject_id = $3 order by e.created_at desc limit 100`,
    [ctx.tenantId, s.object, s.id],
  );
  const blocks: { channel: string; reason: string }[] = [];
  for (const ch of CONTACT_CHANNELS) {
    const reason = await isSuppressed(ctx.tx, ctx.tenantId, ch, ch === 'email' ? row?.email : row?.phone);
    if (reason) blocks.push({ channel: ch, reason });
  }
  return { state: row?.consent ?? {}, events, suppressed: blocks };
}

export async function setConsentByUser(ctx: RecordCtx, s: Subject, purpose: Purpose, granted: boolean, note?: string) {
  await loadRow(ctx, s.object, s.id, 'update');
  return recordConsent(ctx.tx, ctx.tenantId, s, { purpose, granted, source: 'manual', evidence: note ? { note } : {} });
}

// ------------------------------------------------------------------------------- config, notices

export async function privacyConfig(tx: Tx, tenantId: string) {
  const cur = await tx.one<Record<string, any>>(`select * from privacy_config where tenant_id = $1`, [tenantId]);
  if (cur) return cur;
  if (tx.scope.readOnly) return { tenant_id: tenantId, portal_enabled: false, portal_key: '', request_sla_days: 30, retention: {} } as Record<string, any>;
  await tx.query(`insert into privacy_config (tenant_id) values ($1) on conflict do nothing`, [tenantId]);
  return (await tx.one<Record<string, any>>(`select * from privacy_config where tenant_id = $1`, [tenantId]))!;
}

export async function currentNoticeVersion(tx: Tx, tenantId: string): Promise<number | null> {
  const r = await tx.one<{ v: number }>(`select max(version) as v from privacy_notices where tenant_id = $1 and published_at is not null`, [tenantId]);
  return r?.v ?? null;
}

export const DEFAULT_RETENTION = { leadsUnconvertedMonths: 0, lostDealsMonths: 0, messagesMonths: 0, recordingsMonths: 0, recycleBinDays: 0 };
export type Retention = typeof DEFAULT_RETENTION;

export function retentionOf(cfg: { retention?: Partial<Retention> | null }): Retention {
  return { ...DEFAULT_RETENTION, ...(cfg.retention ?? {}) };
}

/** A starting notice the workspace edits: itemised purposes, rights, the grievance officer and the Board. */
export function noticeTemplate(company: string, officer: { name?: string | null; email?: string | null; phone?: string | null }) {
  return [
    `# How ${company} uses your personal data`,
    '',
    `${company} ("we") collects your name, phone number, email address and the details of your enquiry or order. We use them only for the purposes below.`,
    '',
    '## Why we use your data',
    '- **To respond to your enquiry** and prepare quotes, orders, deliveries, installations and invoices.',
    '- **To provide after-sales service** and keep you updated about your order or complaint.',
    '- **To meet legal obligations**, for example keeping tax invoices as GST law requires.',
    '- **To send you offers and updates** on WhatsApp, email or SMS, only if you agree. You can withdraw this at any time, as easily as you gave it.',
    '',
    '## Your rights',
    'You can ask us for a summary of the personal data we hold about you, ask us to correct, complete or update it, ask us to erase it, withdraw your consent, nominate someone to exercise your rights, and raise a grievance. Use the request form on this page.',
    '',
    '## Grievances',
    `Contact our grievance officer${officer.name ? `, ${officer.name}` : ''}${officer.email ? `, at ${officer.email}` : ''}${officer.phone ? ` or ${officer.phone}` : ''}. If you are not satisfied with our response, you may complain to the Data Protection Board of India.`,
  ].join('\n');
}

// ----------------------------------------------------------------------------------- requests

export const REQUEST_KINDS = ['access', 'correction', 'erasure', 'grievance', 'nomination', 'withdraw_consent'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export async function createRequest(
  tx: Tx,
  tenantId: string,
  input: { kind: RequestKind; source: string; name: string; email?: string | null; phone?: string | null; details?: string | null; subject?: Subject | null; verified?: boolean },
) {
  const cfg = await privacyConfig(tx, tenantId);
  // numbers are handed out one at a time per workspace
  await tx.query(`select pg_advisory_xact_lock(hashtext('dpr:' || $1::text))`, [tenantId]);
  const n = await tx.one<{ c: number }>(`select count(*)::int + 1 as c from data_requests where tenant_id = $1`, [tenantId]);
  const r = await tx.one<{ id: string; status_token: string; due_at: string }>(
    `insert into data_requests (tenant_id, number, kind, source, requester_name, requester_email, requester_phone, details, subject_object, subject_id, status, verified_at, due_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() + make_interval(days => $13)) returning id, status_token, due_at`,
    [
      tenantId,
      `DPR-${String(n!.c).padStart(4, '0')}`,
      input.kind,
      input.source,
      input.name,
      input.email?.toLowerCase() ?? null,
      input.phone ?? null,
      input.details ?? null,
      input.subject?.object ?? null,
      input.subject?.id ?? null,
      input.verified ? 'in_progress' : 'received',
      input.verified ? new Date() : null,
      cfg.request_sla_days,
    ],
  );
  // privacy admins hear about every new request
  await notifyPrivacyAdmins(tx, tenantId, `New privacy request: ${input.kind.replace('_', ' ')}`, `${input.name}${input.email ? ` (${input.email})` : ''}`, `/settings#privacy`);
  return r!;
}

async function notifyPrivacyAdmins(tx: Tx, tenantId: string, title: string, body: string, link: string) {
  const admins = await tx.query<{ id: string }>(
    `select distinct u.id from users u
       left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
       left join roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
      where u.tenant_id = $1 and u.status = 'active'
        and (u.is_owner or r.permissions -> 'admin' ? '*' or r.permissions -> 'admin' ? 'privacy')
      limit 20`,
    [tenantId],
  );
  for (const a of admins) await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'privacy',$3,$4,$5)`, [tenantId, a.id, title.slice(0, 200), body.slice(0, 500), link]);
}

/** Portal requests are verified by a link sent to the requester's email before anyone acts on them. */
export async function sendVerification(env: Env, tx: Tx, tenantId: string, requestId: string, origin: string, company: string) {
  const r = await tx.one<{ requester_email: string | null; kind: string; number: string; status_token: string }>(`select requester_email, kind, number, status_token from data_requests where tenant_id = $1 and id = $2`, [tenantId, requestId]);
  if (!r?.requester_email) return false;
  const token = randomToken(24);
  await tx.query(`update data_requests set status = 'verifying', verify_hash = $3, verify_expires = now() + interval '48 hours' where tenant_id = $1 and id = $2`, [tenantId, requestId, await sha256Hex(token)]);
  const url = `${origin}/privacy/verify/${r.status_token}.${token}`;
  const mail = actionEmail({
    heading: `Confirm your request to ${company}`,
    intro: `We received a ${r.kind.replace('_', ' ')} request (${r.number}) for your personal data. Confirm that it was you so we can act on it.`,
    cta: 'Confirm my request',
    url,
    footer: 'If you did not make this request, ignore this email. The link expires in 48 hours.',
  });
  return sendPlatformMail(env, { to: r.requester_email, subject: `Confirm your privacy request ${r.number}`, ...mail });
}

export async function confirmVerification(tx: Tx, tenantId: string, requestId: string, token: string) {
  const r = await tx.one<{ verify_hash: string | null; verify_expires: Date | null; status: string }>(`select verify_hash, verify_expires, status from data_requests where tenant_id = $1 and id = $2 for update`, [tenantId, requestId]);
  if (!r || !r.verify_hash || r.status !== 'verifying' || !r.verify_expires || new Date(r.verify_expires) < new Date()) return false;
  if (r.verify_hash !== (await sha256Hex(token))) return false;
  await tx.query(`update data_requests set status = 'in_progress', verified_at = now(), verify_hash = null where tenant_id = $1 and id = $2`, [tenantId, requestId]);
  // match the requester to their record when the address identifies exactly one
  await autoLinkSubject(tx, tenantId, requestId);
  return true;
}

/**
 * Acting on a record needs proof the requester is that person. A request verified by email may
 * act only on a record with that email; anything else needs a staff verification (recorded with
 * a note), where someone checked the person against the record.
 */
export async function assertIdentityMatches(tx: Tx, tenantId: string, r: { id: string; subject_object: string | null; subject_id: string | null; requester_email: string | null }) {
  if (!r.subject_id || !r.subject_object) return;
  const staff = await tx.one(`select 1 from audit_logs where tenant_id = $1 and action = 'verify' and object_key = 'data_request' and record_id = $2 limit 1`, [tenantId, r.id]);
  if (staff) return;
  const rec = await tx.one<{ email: string | null }>(`select email from ${TABLE[r.subject_object as Subject['object']]} where tenant_id = $1 and id = $2`, [tenantId, r.subject_id]);
  if (!r.requester_email || !rec?.email || rec.email.toLowerCase() !== r.requester_email.toLowerCase()) {
    throw badRequest('The confirmed email does not belong to the linked record. Verify the person yourself (Mark verified, with how you checked) before acting on it.');
  }
}

async function autoLinkSubject(tx: Tx, tenantId: string, requestId: string) {
  const r = await tx.one<{ requester_email: string | null; requester_phone: string | null; subject_id: string | null }>(`select requester_email, requester_phone, subject_id from data_requests where tenant_id = $1 and id = $2`, [tenantId, requestId]);
  if (!r || r.subject_id) return;
  // only the address the requester proved they own links a record; a phone match is a suggestion for staff
  if (!r.requester_email) return;
  const found = await findSubjects(tx, tenantId, r.requester_email, null);
  if (found.length === 1) await tx.query(`update data_requests set subject_object = $3, subject_id = $4 where tenant_id = $1 and id = $2`, [tenantId, requestId, found[0]!.object, found[0]!.id]);
}

export async function findSubjects(tx: Tx, tenantId: string, email: string | null, phone: string | null) {
  const out: { object: 'lead' | 'contact'; id: string; name: string; email: string | null; phone: string | null }[] = [];
  const e = email?.toLowerCase() ?? null;
  const p = addressKey(phone);
  if (!e && !p) return out;
  for (const object of ['contact', 'lead'] as const) {
    const rows = await tx.query<{ id: string; full_name: string; email: string | null; phone: string | null }>(
      `select id, full_name, email, phone from ${TABLE[object]} where tenant_id = $1 and deleted_at is null and (($2::text is not null and lower(email) = $2) or ($3::text is not null and app.phone_key(phone) = $3)) limit 10`,
      [tenantId, e, p],
    );
    for (const r of rows) out.push({ object, id: r.id, name: r.full_name, email: r.email, phone: r.phone });
  }
  return out;
}

export async function listRequests(tx: Tx, tenantId: string, status: 'open' | 'all') {
  return tx.query(
    `select r.id, r.number, r.kind, r.status, r.source, r.requester_name, r.requester_email, r.requester_phone, r.subject_object, r.subject_id, r.due_at, r.created_at, r.resolved_at,
            u.full_name as assignee, (r.due_at < now() and r.status not in ('completed','rejected')) as overdue
       from data_requests r left join users u on u.tenant_id = r.tenant_id and u.id = r.assigned_to
      where r.tenant_id = $1 ${status === 'open' ? `and r.status not in ('completed', 'rejected')` : ''}
      order by (r.status in ('completed','rejected')), r.due_at limit 300`,
    [tenantId],
  );
}

export async function getRequest(tx: Tx, tenantId: string, id: string) {
  const r = await tx.one<Record<string, any>>(`select * from data_requests where tenant_id = $1 and id = $2`, [tenantId, id]);
  if (!r) throw notFound();
  delete r.verify_hash;
  const matches = r.subject_id ? [] : await findSubjects(tx, tenantId, r.requester_email, r.requester_phone);
  return { ...r, matches };
}

/** A machine-readable summary of everything held about one person (DPDP s.11 right to information). */
export async function personalDataSummary(tx: Tx, meta: RecordCtx['meta'], tenantId: string, s: Subject) {
  const row = await tx.one<Record<string, any>>(`select * from ${TABLE[s.object]} where tenant_id = $1 and id = $2`, [tenantId, s.id]);
  if (!row) throw notFound();
  const obj = getObject(meta, s.object);
  const fields: Record<string, unknown> = {};
  for (const f of obj.fields) {
    if (f.type === 'formula' || f.type === 'rollup') continue;
    const v = f.standard ? row[f.key] : row.custom?.[f.key];
    if (v !== null && v !== undefined && v !== '') fields[f.label] = v;
  }
  const ids = [s.id];
  if (s.object === 'lead' && row.converted_contact_id) ids.push(row.converted_contact_id);
  const consents = await tx.query(`select purpose, granted, source, notice_version, created_at from consent_events where tenant_id = $1 and subject_id = any($2::uuid[]) order by created_at`, [tenantId, ids]);
  const messages = await tx.query(`select channel, direction, subject, body, status, created_at from messages where tenant_id = $1 and related_id = any($2::uuid[]) order by created_at limit 2000`, [tenantId, ids]);
  const activities = await tx.query(`select kind, subject, body, direction, occurred_at from activities where tenant_id = $1 and related_id = any($2::uuid[]) order by occurred_at limit 2000`, [tenantId, ids]);
  const files = await tx.query(`select name, content_type, size_bytes, created_at from files where tenant_id = $1 and record_id = any($2::uuid[]) and deleted_at is null`, [tenantId, ids]);
  const contactId = s.object === 'contact' ? s.id : (row.converted_contact_id as string | null);
  const docs = contactId
    ? {
        quotes: await tx.query(`select quote_number, status, grand_total, created_at from quotes where tenant_id = $1 and contact_id = $2 and deleted_at is null`, [tenantId, contactId]),
        invoices: await tx.query(`select invoice_number, invoice_date, grand_total, status from invoices where tenant_id = $1 and contact_id = $2 and deleted_at is null`, [tenantId, contactId]),
      }
    : {};
  return {
    generatedAt: new Date().toISOString(),
    subject: { type: s.object, name: row.full_name },
    personalData: fields,
    consents,
    communications: messages,
    timeline: activities,
    files,
    documents: docs,
    purposes: ['Responding to enquiries and fulfilling orders', 'After-sales service', 'Legal obligations (tax records)', 'Marketing, only with consent'],
  };
}

// ------------------------------------------------------------------------------------ erasure

const KEEP_TYPES = new Set<FieldDef['type']>(['picklist', 'multipicklist', 'number', 'currency', 'percent', 'boolean', 'date', 'lookup', 'user']);

/**
 * Erases one person: identity and contact details on the record, their messages and timeline
 * entries, attached files and consent state. The record itself stays (deleted, anonymised) so
 * deals and reports keep their history. Tax invoices and payments are retained as GST law
 * requires, and the summary says so.
 */
export async function eraseSubject(ctx: RecordCtx, s: Subject, requestId: string | null, purge: string[]) {
  const { tx, tenantId } = ctx;
  const row = await tx.one<Record<string, any>>(`select * from ${TABLE[s.object]} where tenant_id = $1 and id = $2 for update`, [tenantId, s.id]);
  if (!row) throw notFound();
  const already = await tx.one(`select 1 from erasures where tenant_id = $1 and object_key = $2 and record_id = $3`, [tenantId, s.object, s.id]);
  if (already) return { alreadyErased: true };
  const ids: Subject[] = [s];
  if (s.object === 'lead' && row.converted_contact_id) ids.push({ object: 'contact', id: row.converted_contact_id });
  if (s.object === 'contact') {
    for (const l of await tx.query<{ id: string }>(`select id from leads where tenant_id = $1 and converted_contact_id = $2`, [tenantId, s.id])) ids.push({ object: 'lead', id: l.id });
  }
  const summary: Record<string, number | string> = { records: 0, messages: 0, activities: 0, files: 0 };
  const r2Keys: string[] = [];
  for (const sub of ids) {
    const cur = await tx.one<Record<string, any>>(`select * from ${TABLE[sub.object]} where tenant_id = $1 and id = $2`, [tenantId, sub.id]);
    if (!cur) continue;
    // the address stays on the do-not-contact list, hashed
    for (const [ch, addr] of [['email', cur.email], ['whatsapp', cur.phone], ['sms', cur.phone], ['calls', cur.phone]] as const) {
      const k = addressKey(addr);
      if (k) await tx.query(`insert into suppressions (tenant_id, channel, address_key, reason) values ($1,$2,$3,'erasure') on conflict (tenant_id, channel, address_key) do update set reason = 'erasure'`, [tenantId, ch, await hashedKey(k)]);
    }
    const obj = getObject(ctx.meta, sub.object);
    const keep: Record<string, unknown> = {};
    for (const f of obj.fields) if (!f.standard && !f.pii && KEEP_TYPES.has(f.type) && cur.custom?.[f.key] !== undefined) keep[f.key] = cur.custom[f.key];
    if (sub.object === 'lead') {
      await tx.query(
        `update leads set first_name = null, last_name = 'Erased person', company = null, email = null, phone = null, source_detail = null,
                consent = '{}'::jsonb, custom = $3, ai_score_reasons = null, deleted_at = coalesce(deleted_at, now()) where tenant_id = $1 and id = $2`,
        [tenantId, sub.id, JSON.stringify(keep)],
      );
    } else {
      await tx.query(
        `update contacts set first_name = null, last_name = 'Erased person', email = null, phone = null, title = null,
                consent = '{}'::jsonb, custom = $3, deleted_at = coalesce(deleted_at, now()) where tenant_id = $1 and id = $2`,
        [tenantId, sub.id, JSON.stringify(keep)],
      );
    }
    summary.records = Number(summary.records) + 1;
    const m = await tx.query(`update messages set body = null, subject = null, from_addr = null, to_addr = null where tenant_id = $1 and related_object = $2 and related_id = $3 returning id`, [tenantId, sub.object, sub.id]);
    summary.messages = Number(summary.messages) + m.length;
    const a = await tx.query(`update activities set subject = '[erased]', body = null, metadata = '{}'::jsonb where tenant_id = $1 and related_object = $2 and related_id = $3 returning id`, [tenantId, sub.object, sub.id]);
    // chat threads with the person's number: their messages and the thread itself
    const phoneKey = addressKey(cur.phone);
    const emailKey = addressKey(cur.email);
    const convs = await tx.query<{ id: string }>(
      `select id from conversations where tenant_id = $1 and ((related_object = $2 and related_id = $3) or ($4::text is not null and app.phone_key(address) = $4))`,
      [tenantId, sub.object, sub.id, phoneKey],
    );
    const convIds = convs.map((x) => x.id);
    if (convIds.length) {
      const cm = await tx.query(`update messages set body = null, subject = null, from_addr = null, to_addr = null, media = null where tenant_id = $1 and conversation_id = any($2::uuid[]) returning id`, [tenantId, convIds]);
      summary.messages = Number(summary.messages) + cm.length;
      await tx.query(`delete from notifications where tenant_id = $1 and link = any($2::text[])`, [tenantId, convIds.map((c) => `/inbox?c=${c}`)]);
      await tx.query(`delete from conversations where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, convIds]);
    }
    // campaign lists, the plain-text do-not-contact rows (the hashed ones stay), notifications and webhook copies
    for (const k of [phoneKey, emailKey].filter((x): x is string => !!x)) {
      const h = await hashedKey(k);
      await tx.query(`update campaign_recipients set address = $3, address_key = $3 where tenant_id = $1 and address_key = $2`, [tenantId, k, h]);
      await tx.query(`delete from suppressions where tenant_id = $1 and address_key = $2`, [tenantId, k]);
    }
    await tx.query(`update campaign_recipients set address = '[erased]' where tenant_id = $1 and subject_id = $2 and address not like 'h:%'`, [tenantId, sub.id]);
    await tx.query(`delete from notifications where tenant_id = $1 and link like '%' || $2::text || '%'`, [tenantId, sub.id]);
    await tx.query(`delete from webhook_deliveries where tenant_id = $1 and payload ->> 'recordId' = $2::text`, [tenantId, sub.id]);
    // intelligence: search index entries, AI outputs and suggestions about the person
    const ix = await tx.query<{ source_kind: string; source_id: string }>(
      `delete from interaction_index where tenant_id = $1 and related_object = $2 and related_id = $3 returning source_kind, source_id`,
      [tenantId, sub.object, sub.id],
    );
    r2Keys.push(...ix.map((x) => `vec:${x.source_kind[0]}:${x.source_id}`));
    await tx.query(`delete from agent_runs where tenant_id = $1 and subject_object = $2 and subject_id = $3`, [tenantId, sub.object, sub.id]);
    await tx.query(`delete from agent_runs where tenant_id = $1 and citations @> jsonb_build_array(jsonb_build_object('id', $2::text))`, [tenantId, sub.id]);
    await tx.query(`delete from agent_suggestions where tenant_id = $1 and object_key = $2 and record_id = $3`, [tenantId, sub.object, sub.id]);
    await tx.query(`delete from action_items where tenant_id = $1 and related_object = $2 and related_id = $3`, [tenantId, sub.object, sub.id]);
    await tx.query(`delete from insights where tenant_id = $1 and related_object = $2 and related_id = $3`, [tenantId, sub.object, sub.id]);
    await tx.query(`delete from record_scores where tenant_id = $1 and object_key = $2 and record_id = $3`, [tenantId, sub.object, sub.id]);
    // meetings and calls with the person: their notes, transcripts and the debriefs built from them
    const evs = (await tx.query<{ id: string }>(`select id from events where tenant_id = $1 and related_object = $2 and related_id = $3`, [tenantId, sub.object, sub.id])).map((x) => x.id);
    if (evs.length) {
      await tx.query(`update meeting_notes set notes = null, transcript = null where tenant_id = $1 and event_id = any($2::uuid[])`, [tenantId, evs]);
      await tx.query(`delete from agent_runs where tenant_id = $1 and subject_object = 'event' and subject_id = any($2::uuid[])`, [tenantId, evs]);
    }
    await tx.query(`delete from agent_runs where tenant_id = $1 and subject_object = 'call' and subject_id = any($2::uuid[])`, [tenantId, a.map((x) => String(x.id))]);
    // conversation messages wiped above leave their search vectors behind otherwise
    if (convIds.length) {
      const mx = await tx.query<{ source_id: string }>(
        `delete from interaction_index where tenant_id = $1 and source_kind = 'message' and source_id in (select id from messages where tenant_id = $1 and conversation_id = any($2::uuid[])) returning source_id`,
        [tenantId, convIds],
      );
      r2Keys.push(...mx.map((x) => `vec:m:${x.source_id}`));
    }
    summary.activities = Number(summary.activities) + a.length;
    const f = await tx.query<{ storage_key: string }>(`update files set deleted_at = now(), name = 'erased' where tenant_id = $1 and object_key = $2 and record_id = $3 and deleted_at is null returning storage_key`, [tenantId, sub.object, sub.id]);
    summary.files = Number(summary.files) + f.length;
    r2Keys.push(...f.map((x) => x.storage_key));
    await tx.query(`insert into erasures (tenant_id, object_key, record_id, request_id, summary) values ($1,$2,$3,$4,$5) on conflict do nothing`, [tenantId, sub.object, sub.id, requestId, JSON.stringify(summary)]);
  }
  const contactIds = ids.filter((x) => x.object === 'contact').map((x) => x.id);
  if (contactIds.length) {
    const kept = await tx.one<{ n: number }>(`select count(*)::int as n from invoices where tenant_id = $1 and contact_id = any($2::uuid[]) and status <> 'draft'`, [tenantId, contactIds]);
    if (kept?.n) summary.retained = `${kept.n} tax invoice(s) kept as GST law requires`;
  }
  await tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'erase', $2, $3, $4)`, [tenantId, s.object, s.id, JSON.stringify({ request: requestId, ...summary })]);
  // stored objects are removed by the caller once the transaction has committed
  purge.push(...r2Keys);
  return { alreadyErased: false, ...summary };
}

/** Removes erased files from storage (after the erasing transaction committed). */
export async function purgeFiles(env: Env, keys: string[]) {
  // "vec:" entries are conversation embeddings in the search index (ids only, no text)
  const vectors = keys.filter((k) => k.startsWith('vec:')).map((k) => k.slice(4));
  if (env.VECTORIZE && vectors.length) await env.VECTORIZE.deleteByIds(vectors).catch(() => undefined);
  const files = keys.filter((k) => !k.startsWith('vec:'));
  if (!env.FILES || !files.length) return;
  await Promise.all(files.map((k) => env.FILES!.delete(k).catch(() => undefined)));
}

/** Audit entries of erased records are shown without their old values. */
export async function maskErased<T extends { object_key: string | null; record_id: string | null; changes: unknown }>(tx: Tx, tenantId: string, rows: T[]): Promise<T[]> {
  const ids = [...new Set(rows.filter((r) => r.record_id).map((r) => r.record_id!))];
  if (!ids.length) return rows;
  const erased = new Set((await tx.query<{ k: string }>(`select object_key || ':' || record_id as k from erasures where tenant_id = $1 and record_id = any($2::uuid[])`, [tenantId, ids])).map((r) => r.k));
  return rows.map((r) => (erased.has(`${r.object_key}:${r.record_id}`) && r.changes && !(r.changes as Record<string, unknown>).request ? { ...r, changes: { redacted: 'personal data erased' } } : r));
}

// --------------------------------------------------------------------------- completing requests

export async function completeRequest(
  env: Env,
  ctx: RecordCtx,
  id: string,
  input: { outcome: 'completed' | 'rejected'; resolution: string; erase?: boolean },
  origin: string,
  purge: string[],
) {
  const r = await ctx.tx.one<Record<string, any>>(`select * from data_requests where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!r) throw notFound();
  if (['completed', 'rejected'].includes(r.status)) throw badRequest('This request is already closed');
  if (input.outcome === 'completed' && !r.verified_at) throw badRequest('Verify the requester first (portal requests are verified by email; mark manual ones verified)');
  const s: Subject | null = r.subject_id ? { object: r.subject_object, id: r.subject_id } : null;
  const result: Record<string, unknown> = {};
  if (input.outcome === 'completed' && s) await assertIdentityMatches(ctx.tx, ctx.tenantId, r as never);
  if (input.outcome === 'completed') {
    if (r.kind === 'erasure') {
      if (!s) throw badRequest('Link the request to the person’s record first');
      if (!input.erase) throw badRequest('Confirm the erasure');
      result.erasure = await eraseSubject(ctx, s, id, purge);
    }
    if (r.kind === 'withdraw_consent') {
      if (!s) throw badRequest('Link the request to the person’s record first');
      await recordConsent(ctx.tx, ctx.tenantId, s, { purpose: 'marketing', granted: false, source: 'request', evidence: { request: r.number } });
    }
  }
  await ctx.tx.query(`update data_requests set status = $3, resolution = $4, resolved_at = now(), resolved_by = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId,
    id,
    input.outcome,
    input.resolution,
    ctx.principal.user.id,
  ]);
  if (r.requester_email) {
    const company = (await ctx.tx.one<{ name: string }>(`select name from tenants where id = $1`, [ctx.tenantId]))?.name ?? 'The company';
    const mail = actionEmail({
      heading: `Your request ${r.number} has been ${input.outcome === 'completed' ? 'completed' : 'closed'}`,
      intro: input.resolution.slice(0, 1500),
      cta: 'View the status',
      url: `${origin}/privacy/status/${r.status_token}`,
      footer: `${company}. If you are not satisfied, you may raise a grievance or complain to the Data Protection Board of India.`,
    });
    result.emailed = await sendPlatformMail(env, { to: r.requester_email, subject: `Privacy request ${r.number}`, ...mail });
  }
  return result;
}

export async function publicStatus(tx: Tx, tenantId: string, requestId: string) {
  const r = await tx.one<Record<string, any>>(`select number, kind, status, created_at, due_at, resolved_at, resolution from data_requests where tenant_id = $1 and id = $2`, [tenantId, requestId]);
  if (!r) throw notFound();
  const t = await tx.one<{ name: string }>(`select name from tenants where id = $1`, [tenantId]);
  return { ...r, company: t?.name ?? '' };
}

// ----------------------------------------------------------------------------------- retention

/**
 * Daily: erase personal data the workspace no longer needs, by its own retention rules.
 * At most `limit` people a day per rule, so a first run on a large workspace spreads out.
 */
export async function applyRetention(ctx: RecordCtx, opts: { dryRun: boolean; limit?: number }, purge: string[] = []) {
  const cfg = await privacyConfig(ctx.tx, ctx.tenantId);
  const r = retentionOf(cfg);
  const limit = opts.limit ?? 200;
  const out: Record<string, number> = {};
  const pick = async (sql: string, args: unknown[]) => ctx.tx.query<{ id: string }>(sql, args);
  const notErased = (o: string) => `not exists (select 1 from erasures e where e.tenant_id = r.tenant_id and e.object_key = '${o}' and e.record_id = r.id)`;
  if (r.leadsUnconvertedMonths > 0) {
    const rows = await pick(
      `select r.id from leads r where r.tenant_id = $1 and r.converted_at is null and r.created_at < now() - make_interval(months => $2) and coalesce(r.last_activity_at, r.created_at) < now() - make_interval(months => $2) and ${notErased('lead')} order by r.created_at limit $3`,
      [ctx.tenantId, r.leadsUnconvertedMonths, limit],
    );
    out.leads = rows.length;
    if (!opts.dryRun) for (const x of rows) await eraseSubject(ctx, { object: 'lead', id: x.id }, null, purge);
  }
  if (r.recycleBinDays > 0) {
    let n = 0;
    for (const o of ['lead', 'contact'] as const) {
      const rows = await pick(`select r.id from ${TABLE[o]} r where r.tenant_id = $1 and r.deleted_at < now() - make_interval(days => $2) and ${notErased(o)} limit $3`, [ctx.tenantId, r.recycleBinDays, limit]);
      n += rows.length;
      if (!opts.dryRun) for (const x of rows) await eraseSubject(ctx, { object: o, id: x.id }, null, purge);
    }
    out.deleted = n;
  }
  if (r.messagesMonths > 0) {
    const q = opts.dryRun
      ? `select count(*)::int as n from messages where tenant_id = $1 and created_at < now() - make_interval(months => $2) and body is not null`
      : `with x as (update messages set body = null where tenant_id = $1 and created_at < now() - make_interval(months => $2) and body is not null returning 1) select count(*)::int as n from x`;
    out.messages = (await ctx.tx.one<{ n: number }>(q, [ctx.tenantId, r.messagesMonths]))?.n ?? 0;
  }
  if (r.recordingsMonths > 0) {
    const q = opts.dryRun
      ? `select count(*)::int as n from activities where tenant_id = $1 and kind = 'call' and occurred_at < now() - make_interval(months => $2) and metadata ? 'recordingUrl'`
      : `with x as (update activities set metadata = metadata - 'recordingUrl' where tenant_id = $1 and kind = 'call' and occurred_at < now() - make_interval(months => $2) and metadata ? 'recordingUrl' returning 1) select count(*)::int as n from x`;
    out.recordings = (await ctx.tx.one<{ n: number }>(q, [ctx.tenantId, r.recordingsMonths]))?.n ?? 0;
  }
  if (r.lostDealsMonths > 0) {
    // lost deals keep their numbers for win-rate reports; only the free-text story goes
    const q = opts.dryRun
      ? `select count(*)::int as n from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id where d.tenant_id = $1 and s.category = 'lost' and d.closed_at < now() - make_interval(months => $2) and d.custom <> '{}'::jsonb`
      : `with x as (update deals d set custom = '{}'::jsonb from pipeline_stages s where s.tenant_id = d.tenant_id and s.id = d.stage_id and d.tenant_id = $1 and s.category = 'lost' and d.closed_at < now() - make_interval(months => $2) and d.custom <> '{}'::jsonb returning 1) select count(*)::int as n from x`;
    out.lostDeals = (await ctx.tx.one<{ n: number }>(q, [ctx.tenantId, r.lostDealsMonths]))?.n ?? 0;
  }
  if (!opts.dryRun) await ctx.tx.query(`update privacy_config set retention_last_run = now() where tenant_id = $1`, [ctx.tenantId]);
  return out;
}

/** Daily reminders for requests close to (or past) their deadline. */
export async function remindDueRequests(tx: Tx, tenantId: string) {
  const due = await tx.query<{ id: string; number: string; kind: string; assigned_to: string | null; overdue: boolean }>(
    `select id, number, kind, assigned_to, due_at < now() as overdue from data_requests
      where tenant_id = $1 and status not in ('completed', 'rejected') and due_at < now() + interval '3 days' limit 50`,
    [tenantId],
  );
  for (const d of due) {
    const title = `${d.overdue ? 'Overdue' : 'Due soon'}: privacy request ${d.number}`;
    if (d.assigned_to) await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'privacy',$3,$4,'/settings#privacy')`, [tenantId, d.assigned_to, title, d.kind.replace('_', ' ')]);
    else await notifyPrivacyAdmins(tx, tenantId, title, d.kind.replace('_', ' '), '/settings#privacy');
  }
  return due.length;
}

// ------------------------------------------------------------------------------- audit export

/**
 * NDJSON audit trail where each line carries the SHA-256 of the previous line's hash plus its own
 * content. Recomputing the chain detects any edited, removed or reordered line.
 */
export async function auditChain(tx: Tx, tenantId: string, from: string, to: string) {
  const rows = await tx.query<{ id: string; created_at: Date; actor: string | null; action: string; object_key: string | null; record_id: string | null; changes: unknown; ip: string | null }>(
    `select a.id, a.created_at, u.email as actor, a.action, a.object_key, a.record_id, a.changes, a.ip
       from audit_logs a left join users u on u.tenant_id = a.tenant_id and u.id = a.actor_id
      where a.tenant_id = $1 and a.created_at >= $2::date and a.created_at < ($3::date + 1) order by a.created_at, a.id limit 50001`,
    [tenantId, from, to],
  );
  if (rows.length > 50000) throw badRequest('More than 50,000 entries: choose a shorter period');
  const masked = await maskErased(tx, tenantId, rows);
  let prev = await sha256Hex(`synapse-audit:${tenantId}:${from}:${to}`);
  const genesis = prev;
  const lines: string[] = [];
  let seq = 0;
  for (const r of masked) {
    const entry = { seq: ++seq, id: r.id, at: new Date(r.created_at).toISOString(), actor: r.actor, action: r.action, object: r.object_key, record: r.record_id, ip: r.ip, changes: r.changes };
    const body = JSON.stringify(entry);
    const hash = await sha256Hex(prev + body);
    lines.push(JSON.stringify({ ...entry, prev, hash }));
    prev = hash;
  }
  return { content: lines.join('\n') + (lines.length ? '\n' : ''), count: lines.length, genesis, head: prev };
}

// --------------------------------------------------------------------------------- permissions

export function assertSubjectEditable(ctx: RecordCtx, object: string) {
  if (object !== 'lead' && object !== 'contact') throw badRequest('Consent applies to leads and contacts');
  if (objectPerm(ctx.principal.permissions, object).read === 'none') throw forbidden();
}

export async function privacyDailySweep(env: Env, db: Db, tenantId: string, build: (tx: Tx) => Promise<RecordCtx>) {
  const purge: string[] = [];
  await db.tx({ tenantId }, async (tx) => {
    const cfg = await tx.one<{ retention: Partial<Retention> | null }>(`select retention from privacy_config where tenant_id = $1`, [tenantId]);
    await remindDueRequests(tx, tenantId);
    if (!cfg) return;
    const r = retentionOf(cfg);
    if (Object.values(r).some((v) => Number(v) > 0)) await applyRetention(await build(tx), { dryRun: false }, purge);
  });
  await purgeFiles(env, purge);
}

// ------------------------------------------------------------------------- unsubscribe links

const enc = (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));

/** A link in every marketing message that opts the recipient out with one click (no sign-in). */
export async function unsubscribeToken(env: Env, tenantId: string, channel: ContactChannel, address: string) {
  const body = `${tenantId}.${channel}.${enc(address)}`;
  return `${body}.${(await hmacSha256Hex(`${env.JWT_SECRET}:unsubscribe`, body)).slice(0, 32)}`;
}

export async function readUnsubscribeToken(env: Env, token: string): Promise<{ tenantId: string; channel: ContactChannel; address: string } | null> {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [tenantId, channel, a, sig] = parts as [string, string, string, string];
  if (!/^[0-9a-f-]{36}$/.test(tenantId) || !(CONTACT_CHANNELS as readonly string[]).includes(channel)) return null;
  const want = (await hmacSha256Hex(`${env.JWT_SECRET}:unsubscribe`, `${tenantId}.${channel}.${a}`)).slice(0, 32);
  if (!timingSafeEqual(sig, want)) return null;
  try {
    return { tenantId, channel: channel as ContactChannel, address: dec(a) };
  } catch {
    return null;
  }
}
