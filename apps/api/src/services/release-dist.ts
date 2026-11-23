/**
 * Publishing a release channel: take the build attached to the channel, upload it to a chosen
 * connected Google Drive account, set who may open it, and send the link to a linked person on
 * WhatsApp.
 *
 * A build that carries client data (the installer bundles the member database) is shared only with
 * the chosen recipient — never "anyone with the link". The database the client runs locally is
 * legitimate; a world-readable public link to those records is not, and the check is enforced here
 * and in the database, not just in the screen.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest, conflict, notFound } from '../lib/errors';
import { mailboxToken, ProviderError } from './integrations';
import { readFileBytes } from './files';
import { projectAccess } from './projects';
import type { RecordCtx } from './records';
import { sendToRecord } from './whatsapp';

const RECIPIENT_OBJECTS = ['contact', 'account', 'lead', 'deal', 'sales_order', 'invoice'] as const;

/** The file id inside a Google Drive link (…/file/d/<id>/…, open?id=<id>, uc?id=<id>). */
function driveIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/file\/d\/([A-Za-z0-9_-]{10,})/) ?? url.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  return m ? m[1]! : null;
}

/** The connected Google accounts a build can be uploaded to, newest usable first. */
export async function driveAccounts(ctx: RecordCtx) {
  const rows = await ctx.tx.query<{ id: string; account_ref: string; label: string | null; config: Record<string, any>; user_id: string | null; full_name: string | null }>(
    `select i.id, i.account_ref, i.label, i.config, i.user_id, u.full_name
       from integrations i left join users u on u.tenant_id = i.tenant_id and u.id = i.user_id
      where i.tenant_id = $1 and i.provider = 'google' and i.status = 'active' order by coalesce((i.config ->> 'primary')::boolean, false) desc, i.created_at`,
    [ctx.tenantId],
  );
  return rows.map((r) => ({ id: r.id, email: r.account_ref, label: r.label, owner: r.full_name, hasDrive: r.config?.drive === true }));
}

async function driveFetch<T = any>(token: string, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body && !init.headers?.['content-type'] ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : init.body instanceof Uint8Array ? init.body : JSON.stringify(init.body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const reason = json?.error?.errors?.[0]?.reason ?? json?.error?.status ?? '';
    if (res.status === 403 && /insufficient|insufficientPermissions|scope/i.test(`${reason} ${json?.error?.message ?? ''}`))
      throw badRequest('This Google account is not allowed to use Drive yet. Reconnect it in My account → Mailboxes to grant Drive access, then try again.');
    if (res.status === 401) throw badRequest('The Google account needs reconnecting (its access expired).');
    throw new ProviderError(`Google Drive: ${json?.error?.message ?? res.statusText}`, res.status);
  }
  return json as T;
}

/** Uploads bytes to Drive (multipart) and returns the file id and the shareable link. */
async function uploadToDrive(token: string, folderId: string | null, name: string, contentType: string, bytes: Uint8Array) {
  const boundary = `sanchalan${crypto.randomUUID().replace(/-/g, '')}`;
  const meta = JSON.stringify({ name, ...(folderId ? { parents: [folderId] } : {}) });
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const enc = new TextEncoder();
  const headB = enc.encode(head);
  const tailB = enc.encode(tail);
  const body = new Uint8Array(headB.length + bytes.length + tailB.length);
  body.set(headB, 0);
  body.set(bytes, headB.length);
  body.set(tailB, headB.length + bytes.length);
  const r = await driveFetch<{ id: string; webViewLink: string; webContentLink?: string }>(
    token,
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,webContentLink&supportsAllDrives=true',
    { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body },
  );
  return r;
}

/** Shares the uploaded file: with just the recipient (restricted), or anyone with the link (public). */
async function shareDrive(token: string, fileId: string, access: 'restricted' | 'public', recipientEmail: string | null) {
  if (access === 'public') {
    await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true`, { method: 'POST', body: { role: 'reader', type: 'anyone' } });
  } else if (recipientEmail) {
    // the recipient opens it signed in as themselves; no one else can
    await driveFetch(token, `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?supportsAllDrives=true&sendNotificationEmail=false`, {
      method: 'POST',
      body: { role: 'reader', type: 'user', emailAddress: recipientEmail },
    });
  }
}

export const publishSchema = z.object({
  /** an approved WhatsApp template to carry the link (needed when the chat's 24h window is closed) */
  templateId: z.string().uuid().nullish(),
  values: z.array(z.string()).max(10).optional(),
  /** the recipient's e-mail for a restricted Drive share, when their record has none */
  recipientEmail: z.string().email().nullish(),
  message: z.string().trim().max(2000).nullish(),
});

/**
 * Runs a Google Drive channel end to end: upload the attached build, set its access, and WhatsApp the
 * link to the channel's linked recipient. Honours the never-public-with-data rule.
 */
export async function publishChannel(ctx: RecordCtx, env: Env, origin: string, projectId: string, releaseId: string, channelId: string, input: z.infer<typeof publishSchema>) {
  await projectAccess(ctx, projectId, 'member');
  const ch = await ctx.tx.one<Record<string, any>>(`select * from project_release_channels where tenant_id = $1 and id = $2 and release_id = $3 and project_id = $4`, [ctx.tenantId, channelId, releaseId, projectId]);
  if (!ch) throw notFound('Channel not found');
  if (ch.method !== 'google_drive') throw badRequest('This channel does not deliver over Google Drive');
  if (ch.contains_client_data && ch.share_access === 'public') throw badRequest('A build that includes client data cannot be shared publicly. Share it with the recipient only, or build without the data to share a public link.');
  if (!ch.drive_account_id) throw badRequest('Choose the Google account to upload to');
  if (!ch.recipient_object || !ch.recipient_id) throw badRequest('Choose the person to send the link to');
  const storedFileId = (ch.file_ids as string[])[0];
  // a big installer the build script already uploaded to Drive: give its link or id instead of attaching it
  const existingDriveId = ch.drive_file_id || driveIdFromUrl(ch.url);
  if (!storedFileId && !existingDriveId) throw badRequest('Attach the build to this channel, or give the Drive link of the already-uploaded build');

  const acc = await ctx.tx.one<{ id: string; tenant_id: string; provider: string; account_ref: string; secret_ciphertext: string | null; config: Record<string, any> }>(
    `select * from integrations where tenant_id = $1 and id = $2 and provider = 'google' and status = 'active'`,
    [ctx.tenantId, ch.drive_account_id],
  );
  if (!acc) throw badRequest('That Google account is no longer connected');

  // the recipient's e-mail (for a restricted share) and that they can be messaged
  if (!(RECIPIENT_OBJECTS as readonly string[]).includes(ch.recipient_object)) throw badRequest('That kind of recipient is not supported');
  const table = ch.recipient_object === 'contact' ? 'contacts' : ch.recipient_object === 'account' ? 'accounts' : ch.recipient_object === 'lead' ? 'leads' : `${ch.recipient_object}s`;
  const row = (await ctx.tx.one<{ r: Record<string, any> }>(`select to_jsonb(t.*) as r from ${table} t where t.tenant_id = $1 and t.id = $2`, [ctx.tenantId, ch.recipient_id]))?.r ?? null;
  const recipient = row
    ? { name: (row.name ?? row.full_name ?? row.title ?? row.company_name ?? '') as string, email: (row.email ?? row.work_email ?? null) as string | null, phone: (row.phone ?? row.mobile ?? row.customer_phone ?? null) as string | null }
    : null;
  const recipientEmail = input.recipientEmail ?? recipient?.email ?? null;
  if (ch.share_access === 'restricted' && !recipientEmail) throw badRequest("The recipient has no e-mail on record, so a restricted Drive share can't reach them. Add their e-mail, or give it here.");

  const token = await mailboxToken(env, ctx.tx, acc as never);
  let driveFileId: string;
  let link: string;
  let name: string;
  if (storedFileId) {
    // upload the build stored on the channel
    const { file, bytes } = await readFileBytes(ctx, env, storedFileId, 'read');
    const up = await uploadToDrive(token, ch.drive_folder_id || null, file.name, file.content_type, bytes);
    driveFileId = up.id;
    link = up.webViewLink;
    name = file.name;
  } else {
    // the build is already in Drive — just set who can open it
    const info = await driveFetch<{ id: string; name: string; webViewLink: string }>(token, `https://www.googleapis.com/drive/v3/files/${existingDriveId}?fields=id,name,webViewLink&supportsAllDrives=true`);
    driveFileId = info.id;
    link = info.webViewLink;
    name = info.name;
  }
  await shareDrive(token, driveFileId, ch.share_access, recipientEmail);
  const file = { name };

  // tell the person on WhatsApp
  const text = `${input.message?.trim() || `${file.name} is ready. Download it here:`}\n${link}`;
  let wa: { messageId: string; status: string; error?: string };
  try {
    const r = await sendToRecord(env, ctx, origin, { object: ch.recipient_object, id: ch.recipient_id }, { text, templateId: input.templateId ?? null, values: input.values });
    wa = { messageId: r.messageId, status: r.status, error: 'error' in r ? (r as { error?: string }).error : undefined };
  } catch (e) {
    // the upload and share succeeded; only the message failed — keep the link and report why
    await ctx.tx.query(
      `update project_release_channels set drive_file_id = $3, url = $4, status = 'in_progress', updated_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, channelId, driveFileId, link],
    );
    throw conflict(`Uploaded and shared, but the WhatsApp message failed: ${(e as Error).message}. The link is saved on the channel — send it to ${recipient?.name || 'the recipient'} by hand.`);
  }

  const done = (ch.checklist as { label: string; done: boolean }[]).map((x) => ({ ...x, done: true }));
  await ctx.tx.query(
    `update project_release_channels set drive_file_id = $3, url = $4, recipients = $5, wa_message_id = $6, delivered_at = now(),
            checklist = $7::jsonb, status = case when $8 = 'sent' then 'done' else 'in_progress' end, done_at = case when $8 = 'sent' then now() else done_at end, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, channelId, driveFileId, link, recipient?.name ?? recipientEmail ?? null, wa.messageId, JSON.stringify(done), wa.status],
  );
  return { link, driveFileId: driveFileId, access: ch.share_access, sharedWith: ch.share_access === 'public' ? 'anyone with the link' : recipientEmail, whatsapp: wa.status, whatsappError: wa.error ?? null };
}

export { RECIPIENT_OBJECTS };
