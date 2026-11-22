/**
 * Mail threads for milestone approvals: search every mailbox SanchalanOS can read — the workspace's
 * mail-intake mailboxes (IMAP such as Titan / GoDaddy, Gmail, Outlook) and the person's own connected
 * Gmail / Outlook — with no date limit, and keep a whole thread on a milestone: each message as an
 * .eml file plus an email activity on the project, each attachment as a file.
 *
 * Searching and downloading happen outside any database transaction; one short transaction saves.
 */
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import type { Env } from '../env';
import type { Db } from '../lib/db';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { ImapError, withImap } from '../lib/imap';
import { parseMail } from '../lib/mime';
import { saveFile, sniffType } from './files';
import { type Integration, mailboxToken, providerFetch, readSecret } from './integrations';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';

const MAX_MESSAGES = 60;
const MAX_BYTES = 20 * 1024 * 1024;

export type Source = { kind: 'imap' | 'gmail' | 'outlook'; id: string; label: string; via: 'mailbox' | 'integration'; integrationId: string | null };

export type ThreadHit = {
  source: string; // `${via}:${id}`
  sourceLabel: string;
  key: string; // gmail thread id, outlook conversation id, or the normalised subject (IMAP)
  subject: string;
  from: string | null;
  last: string | null;
  count: number;
};

/** "RE: Fwd: Approval of milestone 1" → "approval of milestone 1" */
export function threadSubject(s: string) {
  let t = s.trim();
  for (let i = 0; i < 6; i++) t = t.replace(/^\s*(re|fw|fwd|aw|wg|sv|antw|tr)\s*(\[\d+\])?\s*:\s*/i, '').replace(/^\s*\[[^\]]{1,40}\]\s*/, '');
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Mailboxes this person may search: intake mailboxes (books / billing / projects admins, or who added it) and their own Gmail / Outlook. */
export async function mailSources(ctx: RecordCtx): Promise<(Source & { row: Record<string, any> })[]> {
  const p = ctx.principal.permissions;
  const intakeAdmin = ['books', 'billing', 'projects', 'metadata'].some((k) => hasAdmin(p, k));
  const boxes = await ctx.tx.query<Record<string, any>>(
    `select * from intake_mailboxes where tenant_id = $1 and status <> 'paused' and ($2 or created_by = $3) order by created_at`,
    [ctx.tenantId, intakeAdmin, ctx.principal.user.id],
  );
  const own = await ctx.tx.query<Record<string, any>>(
    `select * from integrations where tenant_id = $1 and user_id = $2 and provider in ('google','microsoft') and status = 'active' order by created_at`,
    [ctx.tenantId, ctx.principal.user.id],
  );
  const out: (Source & { row: Record<string, any> })[] = [];
  const seen = new Set<string>();
  for (const b of boxes) {
    const kind = b.provider === 'google' ? 'gmail' : b.provider === 'microsoft' ? 'outlook' : 'imap';
    out.push({ kind, id: b.id, label: b.email, via: 'mailbox', integrationId: b.integration_id ?? null, row: b });
    seen.add(String(b.email).toLowerCase());
    if (b.integration_id) seen.add(`i:${b.integration_id}`);
  }
  for (const i of own) {
    if (seen.has(`i:${i.id}`) || (i.account_ref && seen.has(String(i.account_ref).toLowerCase()))) continue;
    out.push({ kind: i.provider === 'google' ? 'gmail' : 'outlook', id: i.id, label: i.account_ref ?? (i.provider === 'google' ? 'Gmail' : 'Outlook'), via: 'integration', integrationId: i.id, row: i });
  }
  return out;
}

async function tokenFor(env: Env, db: Db, tenantId: string, integrationId: string) {
  return db.tx({ tenantId }, async (tx) => {
    const i = await tx.one<Integration>(`select * from integrations where tenant_id = $1 and id = $2`, [tenantId, integrationId]);
    if (!i) throw notFound('The connected mailbox was removed');
    return mailboxToken(env, tx, i);
  });
}

const G = 'https://gmail.googleapis.com/gmail/v1/users/me';
const M = 'https://graph.microsoft.com/v1.0/me';
const head = (hs: { name: string; value: string }[] | undefined, n: string) => hs?.find((x) => x.name.toLowerCase() === n)?.value ?? '';

/** Threads matching the words, in every mailbox this person may search. */
export async function searchThreads(env: Env, db: Db, tenantId: string, sources: Awaited<ReturnType<typeof mailSources>>, q: string) {
  const words = q.trim();
  if (words.length < 3) throw badRequest('Type at least 3 characters');
  const hits: ThreadHit[] = [];
  const errors: { source: string; error: string }[] = [];
  await Promise.all(
    sources.map(async (s) => {
      const src = `${s.via}:${s.id}`;
      try {
        if (s.kind === 'imap') {
          const pass = (await readSecret<{ password?: string }>(env, { secret_ciphertext: s.row.secret_ciphertext, tenant_id: tenantId })).password;
          if (!pass) throw new ImapError('No password saved for this mailbox', true);
          await withImap({ host: s.row.host, port: s.row.port, tls: s.row.tls, user: s.row.username || s.row.email, pass }, async (c) => {
            const folders = await imapFolders(c, s.row.folder || 'INBOX');
            const map = new Map<string, ThreadHit>();
            for (const f of folders) {
              await c.examine(f);
              const uids = (await c.searchText(words, { body: true })).slice(-40);
              for (const h of await c.headers(uids)) {
                const m = parseMail(h.header);
                const key = threadSubject(m.subject || '(no subject)');
                const at = m.date ? new Date(m.date).toISOString() : null;
                const cur = map.get(key);
                if (cur) {
                  cur.count++;
                  if (at && (!cur.last || at > cur.last)) cur.last = at;
                } else map.set(key, { source: src, sourceLabel: s.label, key, subject: m.subject || '(no subject)', from: m.from?.address ?? null, last: at, count: 1 });
              }
            }
            hits.push(...map.values());
          });
        } else if (s.kind === 'gmail') {
          const token = await tokenFor(env, db, tenantId, s.integrationId!);
          const list = await providerFetch<{ messages?: { id: string; threadId: string }[] }>(`${G}/messages?q=${encodeURIComponent(words)}&maxResults=50&includeSpamTrash=false`, { headers: { authorization: `Bearer ${token}` } });
          const byThread = new Map<string, number>();
          for (const m of list.messages ?? []) byThread.set(m.threadId, (byThread.get(m.threadId) ?? 0) + 1);
          for (const [tid] of [...byThread].slice(0, 20)) {
            const t = await providerFetch<{ messages: { internalDate: string; payload: { headers: { name: string; value: string }[] } }[] }>(`${G}/threads/${tid}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`, { headers: { authorization: `Bearer ${token}` } });
            const first = t.messages[0];
            const last = t.messages[t.messages.length - 1];
            hits.push({ source: src, sourceLabel: s.label, key: tid, subject: head(first?.payload.headers, 'subject') || '(no subject)', from: head(last?.payload.headers, 'from') || null, last: last ? new Date(Number(last.internalDate)).toISOString() : null, count: t.messages.length });
          }
        } else {
          const token = await tokenFor(env, db, tenantId, s.integrationId!);
          const list = await providerFetch<{ value: { id: string; subject: string; conversationId: string; receivedDateTime: string; from?: { emailAddress?: { address?: string } } }[] }>(
            `${M}/messages?$search=${encodeURIComponent(`"${words.replace(/"/g, '')}"`)}&$top=50&$select=id,subject,conversationId,receivedDateTime,from`,
            { headers: { authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' } },
          );
          const map = new Map<string, ThreadHit>();
          for (const m of list.value) {
            const cur = map.get(m.conversationId);
            if (cur) {
              cur.count++;
              if (m.receivedDateTime > (cur.last ?? '')) cur.last = m.receivedDateTime;
            } else map.set(m.conversationId, { source: src, sourceLabel: s.label, key: m.conversationId, subject: m.subject || '(no subject)', from: m.from?.emailAddress?.address ?? null, last: m.receivedDateTime, count: 1 });
          }
          hits.push(...map.values());
        }
      } catch (e) {
        errors.push({ source: s.label, error: (e as Error).message.slice(0, 300) });
      }
    }),
  );
  hits.sort((a, b) => (b.last ?? '').localeCompare(a.last ?? ''));
  return { threads: hits.slice(0, 60), sources: sources.map((s) => ({ id: `${s.via}:${s.id}`, label: s.label, kind: s.kind })), errors };
}

/** The inbox (or the configured folder) and the Sent folder, where the team's replies are. */
async function imapFolders(c: Parameters<Parameters<typeof withImap>[1]>[0], main: string) {
  const out = [main];
  try {
    const all = await c.folders();
    const sent = all.find((f) => f.flags.some((x) => /^\\sent$/i.test(x))) ?? all.find((f) => /^(inbox[./])?sent( items| mail| messages)?$/i.test(f.name));
    if (sent && sent.name !== main) out.push(sent.name);
  } catch {
    /* LIST refused: the main folder only */
  }
  return out;
}

/** Every message of the thread, raw (oldest first). */
export async function fetchThread(env: Env, db: Db, tenantId: string, sources: Awaited<ReturnType<typeof mailSources>>, source: string, key: string): Promise<Uint8Array[]> {
  const [via, id] = source.split(':');
  const s = sources.find((x) => x.via === via && x.id === id);
  if (!s) throw notFound('That mailbox is not available to you');
  try {
    return await readThread(env, db, tenantId, s, key);
  } catch (e) {
    // the mailbox's own complaint, not a bare "Internal error"
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, 'mailbox', `Could not read the thread from ${s.label}: ${(e as Error).message.slice(0, 200)}`);
  }
}

/** The longest stretch of plain ASCII in a subject: IMAP SUBJECT search takes ASCII only, and "Payment – GeM" must not become "Payment GeM". */
export function imapProbe(key: string) {
  return key.split(/[^\x20-\x7e]+/).map((x) => x.trim()).sort((a, b) => b.length - a.length)[0] || key;
}

async function readThread(env: Env, db: Db, tenantId: string, s: Awaited<ReturnType<typeof mailSources>>[number], key: string): Promise<Uint8Array[]> {
  const ctx = { tenantId };
  const raws: Uint8Array[] = [];
  if (s.kind === 'imap') {
    const pass = (await readSecret<{ password?: string }>(env, { secret_ciphertext: s.row.secret_ciphertext, tenant_id: ctx.tenantId })).password;
    if (!pass) throw new ImapError('No password saved for this mailbox', true);
    await withImap({ host: s.row.host, port: s.row.port, tls: s.row.tls, user: s.row.username || s.row.email, pass, timeoutMs: 60_000 }, async (c) => {
      for (const f of await imapFolders(c, s.row.folder || 'INBOX')) {
        await c.examine(f);
        // the subject's words find the candidates; the normalised subject decides
        const uids = await c.searchText(imapProbe(key).slice(0, 120));
        for (const h of await c.headers(uids.slice(-MAX_MESSAGES))) {
          if (threadSubject(parseMail(h.header).subject || '(no subject)') !== key || h.size > MAX_BYTES) continue;
          const raw = await c.message(h.uid, MAX_BYTES);
          if (raw) raws.push(raw);
        }
      }
    });
  } else if (s.kind === 'gmail') {
    const token = await tokenFor(env, db, ctx.tenantId, s.integrationId!);
    const t = await providerFetch<{ messages: { id: string; sizeEstimate?: number }[] }>(`${G}/threads/${encodeURIComponent(key)}?format=minimal`, { headers: { authorization: `Bearer ${token}` } });
    for (const m of t.messages.slice(0, MAX_MESSAGES)) {
      if ((m.sizeEstimate ?? 0) > MAX_BYTES) continue;
      const r = await providerFetch<{ raw: string }>(`${G}/messages/${m.id}?format=raw`, { headers: { authorization: `Bearer ${token}` } });
      const bin = atob(r.raw.replace(/-/g, '+').replace(/_/g, '/'));
      raws.push(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
    }
  } else {
    const token = await tokenFor(env, db, ctx.tenantId, s.integrationId!);
    const list = await providerFetch<{ value: { id: string }[] }>(`${M}/messages?$filter=${encodeURIComponent(`conversationId eq '${key.replace(/'/g, "''")}'`)}&$top=${MAX_MESSAGES}&$select=id`, { headers: { authorization: `Bearer ${token}` } });
    for (const m of list.value) {
      const res = await fetch(`${M}/messages/${m.id}/$value`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) continue;
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length <= MAX_BYTES) raws.push(b);
    }
  }
  return raws;
}

export const attachSchema = z.object({ source: z.string().regex(/^(mailbox|integration):[0-9a-f-]{36}$/), key: z.string().min(1).max(300) });

/**
 * Keeps the whole thread on the milestone: each message once (by Message-ID) as an .eml file and an
 * email activity on the project, each attachment as a file. Returns the messages, the approval-looking
 * one first, to pick as the approval.
 */
export async function saveThread(ctx: RecordCtx, env: Env, projectId: string, milestoneId: string, key: string, raws: Uint8Array[]) {
  await projectAccess(ctx, projectId, 'manage');
  const ms = await ctx.tx.one<{ name: string }>(`select name from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, milestoneId, projectId]);
  if (!ms) throw notFound('Milestone not found');
  const t = await ctx.tx.one<{ settings: any }>(`select settings from tenants where id = $1`, [ctx.tenantId]);
  const users = await ctx.tx.query<{ email: string }>(`select lower(email) as email from users where tenant_id = $1`, [ctx.tenantId]);
  const ownDomains = new Set(
    [String(t?.settings?.company?.website ?? '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0], ...users.map((u) => u.email.split('@')[1])].filter((x): x is string => !!x).map((x) => x.toLowerCase()),
  );
  const parsed = raws.map((raw) => ({ raw, m: parseMail(raw) })).sort((a, b) => Date.parse(a.m.date ?? '') - Date.parse(b.m.date ?? ''));
  const words = /\b(approv|accept|sign[- ]?off|signed off|complet|crac|inspection|certif|go[- ]?ahead|satisf|confirm|acknowledg)/i;
  const out: { activityId: string; subject: string; from: string | null; date: string | null; direction: 'in' | 'out'; looksLikeApproval: boolean; attachments: number }[] = [];
  let saved = 0;
  let files = 0;
  const skippedFiles: string[] = [];
  // Postgres takes no NUL characters in text: some mailers put them in bodies and names
  const clean = (x: string | null | undefined) => (x ?? '').replace(/\u0000/g, '');
  for (const { raw, m } of parsed) {
    m.subject = clean(m.subject);
    m.text = clean(m.text);
    const msgId = clean(m.messageId).slice(0, 500) || null;
    if (msgId && (await ctx.tx.one(`select 1 from milestone_attachments where tenant_id = $1 and milestone_id = $2 and kind = 'email' and message_id = $3`, [ctx.tenantId, milestoneId, msgId]))) continue;
    const from = m.from?.address?.toLowerCase() ?? null;
    const direction: 'in' | 'out' = from && ownDomains.has(from.split('@')[1] ?? '') ? 'out' : 'in';
    const at = m.date && !Number.isNaN(Date.parse(m.date)) ? new Date(m.date).toISOString() : new Date().toISOString();
    const act = await ctx.tx.one<{ id: string }>(
      `insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, occurred_at, metadata) values ($1,'email',$2,$3,$4,'project',$5,$6,$7) returning id`,
      [ctx.tenantId, (m.subject || '(no subject)').slice(0, 200), (m.text || '').slice(0, 100_000), direction, projectId, at, JSON.stringify({ from: clean(m.from?.address) || null, fromName: clean(m.from?.name) || null, to: m.to.map((x) => clean(x.address)), cc: m.cc.map((x) => clean(x.address)), messageId: msgId, milestoneId, thread: key })],
    );
    const day = at.slice(0, 10);
    const base = `${day} ${(m.subject || 'email').replace(/[^\w\- ]+/g, ' ').trim().slice(0, 80)}`;
    // the email as a file; if it can't be kept (too big, odd bytes) the email itself still is
    const eml = await saveFile(ctx, env, { objectKey: 'project', recordId: projectId, name: `${base || 'email'}.eml`, bytes: raw, kind: 'document', description: `Milestone “${ms.name}”: email from ${m.from?.address ?? 'unknown'}` }, { system: true }).catch(() => null);
    if (!eml) skippedFiles.push(`${base || 'email'}.eml`);
    await ctx.tx.query(`insert into milestone_attachments (tenant_id, milestone_id, file_id, activity_id, kind, message_id, thread_key) values ($1,$2,$3,$4,'email',$5,$6)`, [ctx.tenantId, milestoneId, (eml as { id: string } | null)?.id ?? null, act!.id, msgId, key.slice(0, 300)]);
    saved++;
    let n = 0;
    for (const a of m.attachments) {
      if (a.inline && a.contentType.startsWith('image/') && a.bytes.length < 30_000) continue; // signatures and logos
      if (!sniffType(a.bytes, a.filename)) {
        skippedFiles.push(a.filename);
        continue;
      }
      const f = await saveFile(ctx, env, { objectKey: 'project', recordId: projectId, name: clean(a.filename).slice(0, 200) || 'attachment', bytes: a.bytes, kind: 'document', description: `Milestone “${ms.name}”: attached to “${m.subject}” (${day})` }, { system: true }).catch(() => null);
      if (!f) {
        skippedFiles.push(a.filename);
        continue;
      }
      await ctx.tx.query(`insert into milestone_attachments (tenant_id, milestone_id, file_id, activity_id, kind, message_id, thread_key) values ($1,$2,$3,$4,'attachment',null,$5)`, [ctx.tenantId, milestoneId, (f as { id: string }).id, act!.id, key.slice(0, 300)]);
      n++;
      files++;
    }
    out.push({ activityId: act!.id, subject: m.subject, from: m.from?.address ?? null, date: at, direction, looksLikeApproval: direction === 'in' && words.test(`${m.subject} ${m.text.slice(0, 3000)}`), attachments: n });
  }
  // the customer's approval-looking reply, newest first, then the rest
  out.sort((a, b) => Number(b.looksLikeApproval) - Number(a.looksLikeApproval) || (b.date ?? '').localeCompare(a.date ?? ''));
  return { messages: out, saved, files, skippedFiles, alreadyHere: parsed.length - saved };
}

/** What the milestone keeps: the thread's emails and their attachments. */
export async function milestoneMail(ctx: RecordCtx, projectId: string, milestoneId: string) {
  await projectAccess(ctx, projectId);
  return ctx.tx.query(
    `select x.id, x.kind, x.file_id, x.activity_id, x.created_at, f.name as file_name, f.size_bytes, f.content_type, a.subject, a.occurred_at, a.direction, a.metadata ->> 'from' as from
       from milestone_attachments x left join files f on f.tenant_id = x.tenant_id and f.id = x.file_id left join activities a on a.tenant_id = x.tenant_id and a.id = x.activity_id
      where x.tenant_id = $1 and x.milestone_id = $2 order by a.occurred_at, x.kind desc, x.created_at`,
    [ctx.tenantId, milestoneId],
  );
}
