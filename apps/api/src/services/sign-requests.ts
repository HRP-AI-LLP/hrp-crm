/**
 * Signature requests. A professional (accountant/CA) uploads a document they need digitally signed;
 * an admin signs it with the company's soft (.pfx) certificate and the signed PDF comes back for
 * download. Signing reuses the DSC machinery (dsc.signPdfWithPfx).
 */
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest, notFound } from '../lib/errors';
import { signPdfWithPfx } from './dsc';
import { readFileBytes, saveFile, signedFileUrl } from './files';
import { assertManage, requireSelf } from './professionals';
import type { RecordCtx } from './records';

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));

export const raiseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
  pdf: z.string().min(100).max(20_000_000), // base64 PDF
});

/** A professional uploads a PDF and asks for it to be signed. */
export async function raiseSignRequest(ctx: RecordCtx, env: Env, input: z.infer<typeof raiseSchema>) {
  const professionalId = await requireSelf(ctx);
  const bytes = b64ToBytes(input.pdf);
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) throw badRequest('Upload a PDF to be signed');
  const reqId = crypto.randomUUID();
  const file = await saveFile(ctx, env, { objectKey: 'sign_request', recordId: reqId, name: `${input.name}.pdf`.replace(/\.pdf\.pdf$/i, '.pdf'), bytes, kind: 'document', description: 'For digital signature' }, { system: true });
  await ctx.tx.query(`insert into sign_requests (id, tenant_id, professional_id, name, note, source_file_id) values ($1,$2,$3,$4,$5,$6)`, [reqId, ctx.tenantId, professionalId, input.name, input.note ?? null, file.id]);
  return { id: reqId, status: 'pending' };
}

/** The current professional's own signature requests, with download links. */
export async function myRequests(ctx: RecordCtx, env: Env) {
  const professionalId = await requireSelf(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select id, name, note, status, decision_note, decided_at, created_at, source_file_id, signed_file_id from sign_requests where tenant_id = $1 and professional_id = $2 order by created_at desc limit 100`,
    [ctx.tenantId, professionalId],
  );
  return { items: await Promise.all(rows.map((r) => view(env, ctx.tenantId, r))) };
}

/** Admin: pending (and recently decided) signature requests, with requester + source file. */
export async function listSignRequests(ctx: RecordCtx, env: Env) {
  assertManage(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select s.id, s.name, s.note, s.status, s.decision_note, s.decided_at, s.created_at, s.source_file_id, s.signed_file_id, u.full_name, u.email
       from sign_requests s
       join professionals p on p.tenant_id = s.tenant_id and p.id = s.professional_id
       join users u on u.tenant_id = p.tenant_id and u.id = p.user_id
      where s.tenant_id = $1 and (s.status = 'pending' or s.decided_at > now() - interval '30 days')
      order by (s.status = 'pending') desc, s.created_at desc limit 100`,
    [ctx.tenantId],
  );
  return { items: await Promise.all(rows.map(async (r) => ({ ...(await view(env, ctx.tenantId, r)), requestedBy: r.full_name, email: r.email }))) };
}

async function view(env: Env, tenantId: string, r: Record<string, any>) {
  return {
    id: r.id,
    name: r.name,
    note: r.note,
    status: r.status,
    decisionNote: r.decision_note,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
    sourceUrl: r.source_file_id ? await signedFileUrl(env, tenantId, r.source_file_id, false, 900) : null,
    signedUrl: r.signed_file_id ? await signedFileUrl(env, tenantId, r.signed_file_id, false, 900) : null,
  };
}

export const signSchema = z.object({ certificateId: z.string().uuid() });

/** Admin: sign a pending request with a soft certificate, producing the signed PDF. */
export async function signRequest(ctx: RecordCtx, env: Env, id: string, input: z.infer<typeof signSchema>) {
  assertManage(ctx);
  const s = await ctx.tx.one<{ status: string; source_file_id: string; name: string }>(`select status, source_file_id, name from sign_requests where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!s) throw notFound('Request not found');
  if (s.status !== 'pending') throw badRequest('This request has already been handled');
  const { bytes } = await readFileBytes(ctx, env, s.source_file_id, 'read');
  const { signed, cert } = await signPdfWithPfx(ctx, env, input.certificateId, bytes, { reason: `Signature request: ${s.name}` });
  const file = await saveFile(ctx, env, { objectKey: 'sign_request', recordId: id, name: `${s.name} - signed.pdf`, bytes: signed, kind: 'document', description: `Digitally signed by ${cert.subject_cn}` }, { system: true });
  await ctx.tx.query(`update sign_requests set status = 'signed', signed_file_id = $3, certificate_id = $4, decided_by = app.current_user_id(), decided_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, file.id, input.certificateId]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'sign_request',$3)`, [ctx.tenantId, `Signed an uploaded document for a professional (${cert.subject_cn})`, id]);
  return { ok: true, signedUrl: await signedFileUrl(env, ctx.tenantId, file.id, false, 900) };
}

export const rejectSchema = z.object({ note: z.string().trim().max(2000).optional() });

export async function rejectSignRequest(ctx: RecordCtx, id: string, input: z.infer<typeof rejectSchema>) {
  assertManage(ctx);
  const r = await ctx.tx.one<{ id: string }>(`update sign_requests set status = 'rejected', decision_note = $3, decided_by = app.current_user_id(), decided_at = now() where tenant_id = $1 and id = $2 and status = 'pending' returning id`, [ctx.tenantId, id, input.note ?? null]);
  if (!r) throw badRequest('This request has already been handled');
  return { ok: true };
}
