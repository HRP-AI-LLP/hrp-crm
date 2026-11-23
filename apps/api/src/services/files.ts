/**
 * Record attachments in Cloudflare R2 (binding FILES). Metadata lives in `files` (RLS), bytes at
 * <tenant>/<object>/<record>/<file id>. Access follows the parent record: reading a file needs
 * read access to the record, uploading or deleting needs edit access.
 *
 * Uploads are sniffed from their first bytes; the detected type wins over what the client claims,
 * and anything that could execute in a browser (HTML, SVG, scripts) is refused.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import type { Env } from '../env';
import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto';
import { ApiError, badRequest, forbidden, notFound } from '../lib/errors';
import { loadRow, type RecordCtx } from './records';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_QUOTA_MB = 1024;
export const FILE_KINDS = ['attachment', 'photo', 'proof', 'signature', 'document'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export class StorageUnavailableError extends ApiError {
  constructor() {
    super(503, 'storage_unavailable', 'File storage is not enabled for this deployment yet (Cloudflare R2).');
  }
}

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** Content type from magic bytes, or null when the file is not an allowed kind. */
export function sniffType(bytes: Uint8Array, name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].includes(brand)) return 'image/heic';
    if (['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V ', 'qt  '].includes(brand)) return brand === 'qt  ' ? 'video/quicktime' : ext === 'm4a' ? 'audio/mp4' : 'video/mp4';
    if (['M4A ', 'M4B ', 'dash'].includes(brand)) return 'audio/mp4';
  }
  // call recordings
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0 && ext === 'mp3')) return 'audio/mpeg';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(bytes, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'audio/flac';
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return ext === 'weba' ? 'audio/webm' : 'video/webm';
  if (ascii(bytes, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const office: Record<string, string> = {
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip',
    };
    // release artifacts that are really ZIP containers (Android / iOS packages) — download-only
    if (['apk', 'aab', 'ipa', 'jar', 'appx', 'msix'].includes(ext)) return 'application/octet-stream';
    return office[ext] ?? null;
  }
  // Word / Excel 97–2003 (OLE container) — .msi is the same container, kept as a download-only installer
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    return ({ doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint', msi: 'application/octet-stream' } as Record<string, string>)[ext] ?? null;
  // release artifacts (installers / packages): stored for distribution, always downloaded, never run or shown inline
  if (startsWith(bytes, [0x4d, 0x5a]) && ['exe', 'msi', 'dll'].includes(ext)) return 'application/octet-stream'; // Windows PE
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46]) && ['appimage', 'bin', 'run', 'so'].includes(ext)) return 'application/octet-stream'; // Linux ELF
  if (ascii(bytes, 0, 7) === '!<arch>' && ext === 'deb') return 'application/octet-stream'; // Debian package
  if (ascii(bytes, 0, 4) === 'xar!' && ['pkg', 'xar'].includes(ext)) return 'application/octet-stream'; // macOS .pkg
  if (['dmg'].includes(ext) && bytes.length > 512) return 'application/octet-stream'; // macOS disk image (trailer-based; accept by extension)
  // a saved email (.eml, kept from a mailbox): never shown inline, only downloaded
  if (ext === 'eml') {
    // header lines first (after an optional BOM, blank lines or an mbox "From " line), no binary in the headers
    const head = new TextDecoder().decode(bytes.slice(0, 2048)).replace(/^\uFEFF/, '').replace(/^\s+/, '').replace(/^From [^\n]*\n/, '');
    if (head.includes('\u0000')) return null;
    return /^[\x21-\x39\x3b-\x7e]+:/.test(head) ? 'message/rfc822' : null;
  }
  // plain text: CSV / TXT only (no markup), and no binary bytes in the first 4 KB
  if (['csv', 'txt'].includes(ext)) {
    const head = bytes.slice(0, 4096);
    if (head.some((x) => x === 0)) return null;
    const text = new TextDecoder().decode(head).toLowerCase();
    if (/<(script|html|svg|iframe)/.test(text)) return null;
    return ext === 'csv' ? 'text/csv' : 'text/plain';
  }
  return null;
}

export const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'video/webm']);

function safeName(name: string): string {
  const n = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 200);
  return n || 'file';
}

export interface FileRow {
  id: string;
  object_key: string;
  record_id: string;
  name: string;
  content_type: string;
  size_bytes: string | number;
  storage_key: string;
  kind: FileKind;
  description: string | null;
  uploaded_by: string | null;
  uploader_name?: string | null;
  created_at: string;
}

export const fileDto = (f: FileRow) => ({
  id: f.id,
  objectKey: f.object_key,
  recordId: f.record_id,
  name: f.name,
  contentType: f.content_type,
  size: Number(f.size_bytes),
  kind: f.kind,
  description: f.description,
  uploadedBy: f.uploaded_by,
  uploaderName: f.uploader_name ?? null,
  createdAt: f.created_at,
  inline: INLINE_TYPES.has(f.content_type),
});

/** Files on things the books keep (filings, staff, payroll, challans): for the people who keep the books. */
const BOOKS_OWNED: Record<string, string> = { compliance_item: 'compliance_items', employee: 'employees', payroll_run: 'payroll_runs', tds_challan: 'tds_challans' };

async function assertRecordAccess(ctx: RecordCtx, objectKey: string, recordId: string, action: 'read' | 'update') {
  // contract documents (bid, award, SOW, NDA…): contract managers keep them; people who see customers read them
  if (objectKey === 'service_contract') {
    const p = ctx.principal.permissions;
    const manager = hasAdmin(p, 'projects') || hasAdmin(p, 'billing') || hasAdmin(p, 'books');
    if (!manager && (action === 'update' || objectPerm(p, 'account').read === 'none')) throw forbidden();
    if (!(await ctx.tx.one(`select 1 from service_contracts where tenant_id = $1 and id = $2`, [ctx.tenantId, recordId]))) throw notFound();
    return;
  }
  // the organisation's own documents (PAN, GST, MSME…) and team members' documents
  if (objectKey === 'organisation') {
    const { assertOwnerAccess, ownerOf } = await import('./org-documents');
    await assertOwnerAccess(ctx, await ownerOf(ctx, recordId));
    return;
  }
  const table = BOOKS_OWNED[objectKey];
  if (table) {
    if (!hasAdmin(ctx.principal.permissions, 'books') && !(objectKey === 'compliance_item' && hasAdmin(ctx.principal.permissions, 'compliance'))) throw forbidden();
    if (!(await ctx.tx.one(`select 1 from ${table} where tenant_id = $1 and id = $2`, [ctx.tenantId, recordId]))) throw notFound();
    return;
  }
  if (action === 'update' && objectPerm(ctx.principal.permissions, objectKey).update === 'none') throw forbidden();
  await loadRow(ctx, objectKey, recordId, action);
}

export async function listFiles(ctx: RecordCtx, objectKey: string, recordId: string) {
  await assertRecordAccess(ctx, objectKey, recordId, 'read');
  const rows = await ctx.tx.query<FileRow>(
    `select f.*, u.full_name as uploader_name from files f left join users u on u.tenant_id = f.tenant_id and u.id = f.uploaded_by
      where f.tenant_id = $1 and f.object_key = $2 and f.record_id = $3 and f.deleted_at is null order by f.created_at desc limit 200`,
    [ctx.tenantId, objectKey, recordId],
  );
  return rows.map(fileDto);
}

export async function storageUsage(ctx: RecordCtx) {
  const r = await ctx.tx.one<{ bytes: string; n: string; quota: string | null }>(
    `select coalesce(sum(size_bytes), 0) as bytes, count(*) as n, (select settings ->> 'storageQuotaMb' from tenants where id = $1) as quota
       from files where tenant_id = $1 and deleted_at is null`,
    [ctx.tenantId],
  );
  return { bytes: Number(r?.bytes ?? 0), files: Number(r?.n ?? 0), quotaBytes: Number(r?.quota ?? DEFAULT_QUOTA_MB) * 1024 * 1024 };
}

/**
 * Stores a file against a record. `system` skips the record permission check (public sign-off
 * pages acting for the customer); callers then must have validated access themselves.
 */
export async function saveFile(
  ctx: RecordCtx,
  env: Env,
  input: { objectKey: string; recordId: string; name: string; bytes: Uint8Array; kind?: FileKind; description?: string | null },
  opts: { system?: boolean; maxBytes?: number; allowBinary?: boolean } = {},
) {
  if (!env.FILES) throw new StorageUnavailableError();
  if (!opts.system) await assertRecordAccess(ctx, input.objectKey, input.recordId, 'update');
  if (!input.bytes.length) throw badRequest('The file is empty');
  const max = opts.maxBytes ?? MAX_FILE_BYTES;
  if (input.bytes.length > max) throw badRequest(`Files can be at most ${Math.round(max / 1024 / 1024)} MB`);
  const name = safeName(input.name);
  const type = sniffType(input.bytes, name);
  if (!type) throw badRequest('This file type is not allowed. Upload images, PDF, Office documents, CSV or text files.');
  // installers/packages are only kept where they belong (release artifacts), never as ordinary documents
  if (type === 'application/octet-stream' && !opts.allowBinary) throw badRequest('Programs and installers can only be attached to a release. Upload images, PDF, Office documents, CSV or text files here.');
  const usage = await storageUsage(ctx);
  if (usage.bytes + input.bytes.length > usage.quotaBytes) throw new ApiError(413, 'quota_exceeded', 'The workspace has used its file storage. Remove old files or ask HRP AI to raise the limit.');

  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input.bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
  const row = await ctx.tx.one<FileRow>(
    `insert into files (tenant_id, object_key, record_id, name, content_type, size_bytes, storage_key, kind, description, sha256, uploaded_by)
     values ($1, $2, $3, $4, $5, $6, '', $7, $8, $9, $10)
     returning *`,
    [ctx.tenantId, input.objectKey, input.recordId, name, type, input.bytes.length, input.kind ?? (type.startsWith('image/') ? 'photo' : 'attachment'), input.description ?? null, digest, ctx.principal.sessionId === 'system' ? null : ctx.principal.user.id],
  );
  const key = `${ctx.tenantId}/${input.objectKey}/${input.recordId}/${row!.id}`;
  await env.FILES.put(key, input.bytes, { httpMetadata: { contentType: type }, customMetadata: { tenant: ctx.tenantId, name } });
  const saved = await ctx.tx.one<FileRow>(`update files set storage_key = $3 where tenant_id = $1 and id = $2 returning *`, [ctx.tenantId, row!.id, key]);
  return fileDto(saved!);
}

async function loadFile(ctx: RecordCtx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  const f = await ctx.tx.one<FileRow>(`select * from files where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!f) throw notFound();
  return f;
}

export async function openFile(ctx: RecordCtx, env: Env, id: string) {
  if (!env.FILES) throw new StorageUnavailableError();
  const f = await loadFile(ctx, id);
  await assertRecordAccess(ctx, f.object_key, f.record_id, 'read');
  const obj = await env.FILES.get(f.storage_key);
  if (!obj) throw notFound('The file content is missing');
  return { file: f, body: obj.body };
}

/** A file's row and bytes, for someone who may read (or change) the record it is on. */
export async function readFileBytes(ctx: RecordCtx, env: Env, id: string, action: 'read' | 'update') {
  if (!env.FILES) throw new StorageUnavailableError();
  const f = await loadFile(ctx, id);
  await assertRecordAccess(ctx, f.object_key, f.record_id, action);
  const obj = await env.FILES.get(f.storage_key);
  if (!obj) throw notFound('The file content is missing');
  return { file: f, bytes: new Uint8Array(await new Response(obj.body).arrayBuffer()) };
}

/** Whether the person may change the record a file is on (to offer signing). */
export async function canChangeFileRecord(ctx: RecordCtx, id: string) {
  const f = await loadFile(ctx, id);
  try {
    await assertRecordAccess(ctx, f.object_key, f.record_id, 'update');
    return true;
  } catch {
    return false;
  }
}

export async function deleteFile(ctx: RecordCtx, env: Env, id: string) {
  const f = await loadFile(ctx, id);
  await assertRecordAccess(ctx, f.object_key, f.record_id, 'update');
  await ctx.tx.query(`update files set deleted_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  // a chat's photo attached to work made from it shares the stored file: keep it while one still uses it
  const shared = f.storage_key ? await ctx.tx.one(`select 1 from files where tenant_id = $1 and storage_key = $2 and deleted_at is null limit 1`, [ctx.tenantId, f.storage_key]) : null;
  if (env.FILES && f.storage_key && !shared) await env.FILES.delete(f.storage_key).catch(() => undefined);
  return { ok: true };
}

/** Response headers that keep a downloaded file inert in the browser. */
export function fileHeaders(f: { name: string; content_type: string; size_bytes: string | number }, inline: boolean): Record<string, string> {
  const disp = inline && INLINE_TYPES.has(f.content_type) ? 'inline' : 'attachment';
  return {
    'content-type': f.content_type,
    'content-length': String(f.size_bytes),
    'content-disposition': `${disp}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff',
    // PDFs need the browser's viewer (blocked inside a sandbox); everything else is fully sandboxed
    'content-security-policy': f.content_type === 'application/pdf' ? "default-src 'none'; object-src 'self'" : "default-src 'none'; img-src 'self' data:; media-src 'self'; sandbox",
    'cache-control': 'private, max-age=300',
  };
}

// ------------------------------------------------------------------------------------------------
// Signed, expiring links: <img>/<a> tags cannot send the bearer token, so the API hands out URLs
// bound to (tenant, file, expiry, disposition) and signed with a key derived from JWT_SECRET.
// ------------------------------------------------------------------------------------------------
const LINK_TTL_S = 3600;

async function linkSig(env: Env, tenantId: string, fileId: string, exp: number, inline: boolean) {
  return (await hmacSha256Hex(`${env.JWT_SECRET}:files`, `${tenantId}:${fileId}:${exp}:${inline ? 1 : 0}`)).slice(0, 40);
}

export async function signedFileUrl(env: Env, tenantId: string, fileId: string, inline: boolean, ttl = LINK_TTL_S) {
  // round the expiry so repeated listings produce cacheable URLs
  const exp = Math.ceil((Date.now() / 1000 + ttl) / 300) * 300;
  return `/api/public/files/${tenantId}/${fileId}?e=${exp}&d=${inline ? 1 : 0}&s=${await linkSig(env, tenantId, fileId, exp, inline)}`;
}

export async function verifyFileLink(env: Env, tenantId: string, fileId: string, q: { e?: string; d?: string; s?: string }) {
  const exp = Number(q.e);
  if (!Number.isInteger(exp) || exp * 1000 < Date.now() || !q.s) return false;
  return timingSafeEqual(q.s, await linkSig(env, tenantId, fileId, exp, q.d === '1'));
}

export async function withLinks(env: Env, tenantId: string, files: ReturnType<typeof fileDto>[]) {
  return Promise.all(
    files.map(async (f) => ({ ...f, url: await signedFileUrl(env, tenantId, f.id, f.inline), downloadUrl: await signedFileUrl(env, tenantId, f.id, false) })),
  );
}
