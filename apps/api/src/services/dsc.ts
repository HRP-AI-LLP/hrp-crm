/**
 * Digital signature certificates (DSC) for signing documents from Synapse only.
 *
 *  .pfx file   uploaded once with its password; both are kept encrypted with the deployment key and are
 *              never handed back. Synapse signs the document's PDF itself (CMS / PAdES, readable by
 *              Adobe Reader), keeps the signed PDF on the record and records the signature.
 *  USB token   the key never leaves the token. A small signer on the computer with the token (see
 *              tools/dsc-signer) is paired with this workspace; it signs only when given a ticket that
 *              Synapse made for that exact PDF, with the pairing secret. Synapse then checks the signed
 *              PDF (the certificate is the registered one, the signature is valid, the original document
 *              is unchanged inside it) before keeping it.
 *
 * Who may sign: the people named on the certificate. Who may add or remove certificates and signers:
 * the organisation profile's managers.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { decryptSecret, encryptSecret, hmacSha256Hex, randomToken } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type forge from 'node-forge';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { bin, certFromPem, certInfo, cmsDigestToSign, cmsWithSignature, embedCms, placeBox, placeholders, preparePdf, readPfx, sha256Bytes, sha256DigestInfo, signPdf, type StampPosition, verifyPdf } from '../lib/pdf-sign';
import { requireEncryptionKey } from './ai/tenant-providers';
import { canChangeFileRecord, readFileBytes, saveFile, signedFileUrl } from './files';
import { assertOrgManager, canManageOrg, docHash, listSignatures, SIGNABLE, verifyCode } from './organisation';
import { loadRow, type RecordCtx } from './records';

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
const bytesToB64 = (u: Uint8Array) => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

interface CertRow {
  id: string;
  label: string;
  kind: 'pfx' | 'token';
  subject_cn: string;
  subject: string | null;
  issuer: string | null;
  serial: string;
  thumbprint: string;
  valid_from: Date;
  valid_to: Date;
  pfx_enc: string | null;
  pass_enc: string | null;
  cert_pem: string | null;
  signature_id: string | null;
  user_ids: string[];
  is_active: boolean;
}

/* ───────────────────────── certificates ───────────────────────── */

export const pfxSchema = z.object({
  label: z.string().trim().min(1).max(120),
  pfx: z.string().min(100).max(200_000),
  password: z.string().max(200),
  userIds: z.array(z.string().uuid()).max(20).default([]),
  signatureId: z.string().uuid().nullish(),
});

export async function addPfx(ctx: RecordCtx, env: Env, input: z.infer<typeof pfxSchema>) {
  await assertOrgManager(ctx);
  const bytes = b64ToBytes(input.pfx);
  let info;
  try {
    info = certInfo(readPfx(bytes, input.password).cert);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  if (info.validTo.getTime() < Date.now()) throw badRequest(`This certificate expired on ${info.validTo.toISOString().slice(0, 10)}`);
  const key = requireEncryptionKey(env);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into dsc_certificates (tenant_id, label, kind, subject_cn, subject, issuer, serial, thumbprint, valid_from, valid_to, pfx_enc, pass_enc, signature_id, user_ids)
     values ($1,$2,'pfx',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     on conflict (tenant_id, thumbprint) do nothing returning id`,
    [ctx.tenantId, input.label, info.subjectCn, info.subject, info.issuer, info.serial, info.thumbprint, info.validFrom, info.validTo, await encryptSecret(key, input.pfx.replace(/^data:[^,]*,/, ''), ctx.tenantId), await encryptSecret(key, input.password, ctx.tenantId), input.signatureId ?? null, input.userIds],
  );
  if (!r) throw conflict('This certificate is already added');
  return { id: r.id, ...info };
}

export const tokenCertSchema = z.object({
  label: z.string().trim().min(1).max(120),
  certPem: z.string().max(20_000),
  userIds: z.array(z.string().uuid()).max(20).default([]),
  signatureId: z.string().uuid().nullish(),
});

/** A USB token's certificate, as the local signer read it (the key stays on the token). */
export async function addTokenCert(ctx: RecordCtx, input: z.infer<typeof tokenCertSchema>) {
  await assertOrgManager(ctx);
  let info;
  try {
    info = certInfo(certFromPem(input.certPem));
  } catch {
    throw badRequest('Not a certificate');
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into dsc_certificates (tenant_id, label, kind, subject_cn, subject, issuer, serial, thumbprint, valid_from, valid_to, cert_pem, signature_id, user_ids)
     values ($1,$2,'token',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (tenant_id, thumbprint) do nothing returning id`,
    [ctx.tenantId, input.label, info.subjectCn, info.subject, info.issuer, info.serial, info.thumbprint, info.validFrom, info.validTo, input.certPem, input.signatureId ?? null, input.userIds],
  );
  if (!r) throw conflict('This certificate is already added');
  return { id: r.id, ...info };
}

export const certUpdateSchema = z.object({ label: z.string().trim().min(1).max(120), userIds: z.array(z.string().uuid()).max(20), signatureId: z.string().uuid().nullish() });
export async function updateCert(ctx: RecordCtx, id: string, input: z.infer<typeof certUpdateSchema>) {
  await assertOrgManager(ctx);
  const r = await ctx.tx.one(`update dsc_certificates set label = $3, user_ids = $4, signature_id = $5 where tenant_id = $1 and id = $2 and is_active returning id`, [ctx.tenantId, id, input.label, input.userIds, input.signatureId ?? null]);
  if (!r) throw notFound();
}

export async function removeCert(ctx: RecordCtx, id: string) {
  await assertOrgManager(ctx);
  // the encrypted key is wiped; signatures already made keep their record
  const r = await ctx.tx.one(`update dsc_certificates set is_active = false, pfx_enc = case when kind = 'pfx' then 'removed' else null end, pass_enc = null where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound();
}

export async function listCerts(ctx: RecordCtx) {
  const rows = await ctx.tx.query<CertRow>(`select * from dsc_certificates where tenant_id = $1 and is_active order by created_at`, [ctx.tenantId]);
  const me = ctx.principal.user.id;
  const manager = await canManageOrg(ctx);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    kind: r.kind,
    subjectCn: r.subject_cn,
    subject: r.subject,
    issuer: r.issuer,
    serial: r.serial,
    thumbprint: r.thumbprint,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    expired: new Date(r.valid_to).getTime() < Date.now(),
    signatureId: r.signature_id,
    userIds: r.user_ids,
    canSign: r.user_ids.includes(me),
    canEdit: manager,
  }));
}

async function certFor(ctx: RecordCtx, id: string, kind: 'pfx' | 'token') {
  const c = await ctx.tx.one<CertRow>(`select * from dsc_certificates where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, id]);
  if (!c || c.kind !== kind) throw notFound('Certificate not found');
  if (!c.user_ids.includes(ctx.principal.user.id)) throw forbidden(`You are not named to sign with ${c.subject_cn}'s certificate`);
  if (new Date(c.valid_to).getTime() < Date.now()) throw badRequest(`${c.subject_cn}'s certificate expired on ${new Date(c.valid_to).toISOString().slice(0, 10)}`);
  return c;
}

/** The document must be readable by the person and in a state that can be signed. */
async function signableDoc(ctx: RecordCtx, objectKey: string, recordId: string) {
  const s = SIGNABLE[objectKey];
  if (!s) throw badRequest('This kind of document cannot be signed');
  const { row } = await loadRow(ctx, objectKey, recordId, 'read');
  if (s.draft && row.status === s.draft) throw badRequest('Issue the document before signing it: a signed draft would change');
  if (row.status === 'cancelled') throw badRequest('This document is cancelled');
  return { row, number: String(row[s.number] ?? '') };
}

const istNow = () => new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const TITLE: Record<string, string> = { invoice: 'Invoice', quote: 'Quotation', sales_order: 'Order', purchase_order: 'Purchase order' };

async function record(
  ctx: RecordCtx,
  env: Env,
  doc: { objectKey: string; recordId: string; row: Record<string, unknown>; number: string },
  c: CertRow,
  method: 'dsc_pfx' | 'dsc_token',
  signedPdf: Uint8Array,
  code: string,
) {
  const file = await saveFile(ctx, env, { objectKey: doc.objectKey, recordId: doc.recordId, name: `${TITLE[doc.objectKey] ?? 'Document'} ${doc.number || doc.recordId.slice(0, 8)} - signed.pdf`, bytes: signedPdf, kind: 'attachment', description: `Digitally signed by ${c.subject_cn}` }, { system: true });
  const image = c.signature_id ? ((await ctx.tx.one<{ image: string }>(`select image from signatures where tenant_id = $1 and id = $2`, [ctx.tenantId, c.signature_id]))?.image ?? null) : null;
  const r = await ctx.tx.one<{ id: string; signed_at: Date }>(
    `insert into document_signatures (tenant_id, object_key, record_id, signature_id, signer_name, designation, image, doc_hash, verify_code, signed_by, method, certificate_id, cert_subject, cert_serial, file_id, pdf_sha256)
     values ($1,$2,$3,$4,$5,null,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning id, signed_at`,
    [ctx.tenantId, doc.objectKey, doc.recordId, c.signature_id, c.subject_cn, image, await docHash(ctx, doc.objectKey, doc.row), code, ctx.principal.user.id, method, c.id, c.subject, c.serial, file.id, await sha256Bytes(signedPdf)],
  );
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,$3,$4)`, [ctx.tenantId, `Digitally signed by ${c.subject_cn} (DSC)`, doc.objectKey, doc.recordId]);
  return { id: r!.id, fileId: file.id, verifyCode: code, signedAt: r!.signed_at };
}

/* ───────────────────────── signing with a .pfx ───────────────────────── */

export const pfxSignSchema = z.object({ certificateId: z.string().uuid(), pdf: z.string().min(100).max(20_000_000), location: z.string().max(120).nullish() });

export async function signWithPfx(ctx: RecordCtx, env: Env, objectKey: string, recordId: string, input: z.infer<typeof pfxSignSchema>, verifyBase: string | null) {
  const doc = await signableDoc(ctx, objectKey, recordId);
  const c = await certFor(ctx, input.certificateId, 'pfx');
  if (!c.pfx_enc || c.pfx_enc === 'removed' || !c.pass_enc) throw badRequest('This certificate was removed');
  const key = requireEncryptionKey(env);
  const signer = readPfx(b64ToBytes(await decryptSecret(key, c.pfx_enc, ctx.tenantId)), await decryptSecret(key, c.pass_enc, ctx.tenantId));
  const code = verifyCode();
  const pdf = b64ToBytes(input.pdf);
  if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) throw badRequest('Not a PDF');
  const signed = await signPdf(pdf, signer, {
    name: c.subject_cn,
    reason: `${TITLE[objectKey] ?? 'Document'} ${doc.number}`.trim(),
    location: input.location ?? undefined,
    stamp: { text: [`Digitally signed by ${c.subject_cn}`, `Date: ${istNow()} IST`, `Reason: ${TITLE[objectKey] ?? 'Document'} ${doc.number}`.trim(), verifyBase ? `Verify: ${verifyBase}/${code}` : `Verification code: ${code}`] },
  });
  const v = verifyPdf(signed);
  if (!v.ok) throw new Error(`The signed PDF did not verify: ${v.reason}`);
  return record(ctx, env, { objectKey, recordId, ...doc }, c, 'dsc_pfx', signed, code);
}

/* ───────────────────────── USB token through the local signer ───────────────────────── */

export async function pairSigner(ctx: RecordCtx, env: Env, label: string) {
  await assertOrgManager(ctx);
  const secret = randomToken(32);
  const r = await ctx.tx.one<{ id: string }>(`insert into dsc_signers (tenant_id, label, secret_enc) values ($1,$2,$3) returning id`, [ctx.tenantId, label, await encryptSecret(requireEncryptionKey(env), secret, ctx.tenantId)]);
  // the secret is shown once, to be entered in the signer
  return { id: r!.id, secret, pairingCode: `${ctx.tenantId}.${r!.id}.${secret}` };
}

export async function listSigners(ctx: RecordCtx) {
  return ctx.tx.query(`select id, label, created_at, last_used_at from dsc_signers where tenant_id = $1 and revoked_at is null order by created_at`, [ctx.tenantId]);
}

export async function revokeSigner(ctx: RecordCtx, id: string) {
  await assertOrgManager(ctx);
  const r = await ctx.tx.one(`update dsc_signers set revoked_at = now() where tenant_id = $1 and id = $2 and revoked_at is null returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound();
}

export const tokenPrepareSchema = z.object({ certificateId: z.string().uuid(), signerId: z.string().uuid(), pdf: z.string().min(100).max(20_000_000), location: z.string().max(120).nullish() });

const toHex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

/**
 * Signing with a USB token, step 1. Synapse puts the signature field and stamp into the PDF and works out
 * the 32-byte digest the token must sign (it fixes the PDF's bytes and the signing time). The ticket is a
 * one-off permission, sealed with the signer's pairing secret, for the signer on this computer to sign
 * exactly that digest with exactly this certificate within 10 minutes. The token never sees anything else,
 * and the signer needs nothing but Python and the token's driver.
 */
export async function prepareTokenSign(ctx: RecordCtx, env: Env, objectKey: string, recordId: string, input: z.infer<typeof tokenPrepareSchema>, verifyBase: string | null) {
  const doc = await signableDoc(ctx, objectKey, recordId);
  const c = await certFor(ctx, input.certificateId, 'token');
  if (!c.cert_pem) throw badRequest('This certificate has no copy of its public part: add it again from the token');
  const cert = certFromPem(c.cert_pem);
  if (!(cert.publicKey as forge.pki.rsa.PublicKey).n) throw badRequest('Only RSA certificates can sign here');
  const s = await ctx.tx.one<{ secret_enc: string }>(`select secret_enc from dsc_signers where tenant_id = $1 and id = $2 and revoked_at is null`, [ctx.tenantId, input.signerId]);
  if (!s) throw notFound('That signer is not paired with this workspace');
  const secret = await decryptSecret(requireEncryptionKey(env), s.secret_enc, ctx.tenantId);
  const pdf = b64ToBytes(input.pdf);
  if (!(pdf[0] === 0x25 && pdf[1] === 0x50 && pdf[2] === 0x44 && pdf[3] === 0x46)) throw badRequest('Not a PDF');
  const code = verifyCode();
  const reason = `${TITLE[objectKey] ?? 'Document'} ${doc.number}`.trim();
  const prepared = await preparePdf(pdf, {
    name: c.subject_cn,
    reason,
    location: input.location ?? undefined,
    stamp: { text: [`Digitally signed by ${c.subject_cn}`, `Date: ${istNow()} IST`, `Reason: ${reason}`, verifyBase ? `Verify: ${verifyBase}/${code}` : `Verification code: ${code}`] },
  });
  const signingTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  const digest = cmsDigestToSign(prepared.toSign, cert, signingTime);
  const payload = {
    v: 2,
    t: ctx.tenantId,
    s: input.signerId,
    u: ctx.principal.user.id,
    o: objectKey,
    r: recordId,
    c: c.thumbprint,
    d: toHex(digest), // what the token signs (as a SHA-256 DigestInfo)
    p: await sha256Bytes(prepared.pdf), // the prepared PDF the signature will go into
    st: signingTime.toISOString(),
    k: code,
    exp: Math.floor(Date.now() / 1000) + 600,
    reason,
  };
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const mac = await hmacSha256Hex(secret, body);
  await ctx.tx.query(`update dsc_signers set last_used_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, input.signerId]);
  return { ticket: `${body}.${mac}`, prepared: bytesToB64(prepared.pdf), verifyCode: code };
}

export const tokenCompleteSchema = z.object({ ticket: z.string().max(4000), prepared: z.string().min(100).max(25_000_000), signature: z.string().min(40).max(4000) });

/**
 * Step 2: the token's signature comes back. Synapse checks the ticket, puts the signature into the prepared
 * PDF, and verifies it with the registered certificate before keeping it.
 */
export async function completeTokenSign(ctx: RecordCtx, env: Env, objectKey: string, recordId: string, input: z.infer<typeof tokenCompleteSchema>) {
  const [body, mac] = input.ticket.split('.');
  if (!body || !mac) throw badRequest('Bad ticket');
  const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, any>;
  if (payload.v !== 2) throw badRequest('This signing ticket is from an older version: sign again');
  if (payload.t !== ctx.tenantId || payload.o !== objectKey || payload.r !== recordId || payload.u !== ctx.principal.user.id) throw forbidden('This ticket is for another document');
  if (payload.exp < Date.now() / 1000 - 60) throw badRequest('The signing ticket expired: sign again');
  const s = await ctx.tx.one<{ secret_enc: string }>(`select secret_enc from dsc_signers where tenant_id = $1 and id = $2 and revoked_at is null`, [ctx.tenantId, payload.s]);
  if (!s) throw forbidden('That signer is no longer paired');
  if ((await hmacSha256Hex(await decryptSecret(requireEncryptionKey(env), s.secret_enc, ctx.tenantId), body)) !== mac) throw forbidden('The ticket was not made by this workspace');
  if (await ctx.tx.one(`select 1 from document_signatures where tenant_id = $1 and verify_code = $2`, [ctx.tenantId, payload.k])) throw conflict('This ticket was already used');
  const doc = await signableDoc(ctx, objectKey, recordId);
  const c = await ctx.tx.one<CertRow>(`select * from dsc_certificates where tenant_id = $1 and thumbprint = $2 and is_active and kind = 'token'`, [ctx.tenantId, payload.c]);
  if (!c?.cert_pem) throw notFound('The certificate is no longer registered');
  const prepared = b64ToBytes(input.prepared);
  if ((await sha256Bytes(prepared)) !== payload.p) throw badRequest('This is not the PDF that was prepared for signing');
  const place = placeholders(prepared);
  const signature = b64ToBytes(input.signature);
  const cms = cmsWithSignature(place.toSign, certFromPem(c.cert_pem), new Date(payload.st), signature);
  const signed = embedCms(place, cms);
  const v = verifyPdf(signed);
  if (!v.ok) throw badRequest(`The token's signature does not verify (${v.reason}). Is the right certificate chosen on the token?`);
  if (v.cert?.thumbprint !== c.thumbprint || !v.coversWholeFile) throw forbidden('The signed PDF does not match the registered certificate');
  return record(ctx, env, { objectKey, recordId, ...doc }, c, 'dsc_token', signed, String(payload.k));
}

/** The digest the ticket asks the token to sign, as the signer will (for tests and checks). */
export function ticketDigestInfo(ticket: string) {
  const payload = JSON.parse(atob(ticket.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'))) as { d: string };
  return sha256DigestInfo(fromHex(payload.d));
}

/** Anyone can check a PDF: is the signature valid, and is it a document this workspace signed? */
export async function verifyUploadedPdf(ctx: RecordCtx, pdf: Uint8Array) {
  const v = verifyPdf(pdf);
  const hash = await sha256Bytes(pdf);
  const known = await ctx.tx.one<{ verify_code: string; object_key: string; signer_name: string; signed_at: Date; revoked_at: Date | null }>(
    `select verify_code, object_key, signer_name, signed_at, revoked_at from document_signatures where tenant_id = $1 and pdf_sha256 = $2`,
    [ctx.tenantId, hash],
  );
  return {
    signatureValid: v.ok,
    reason: v.reason ?? null,
    certificate: v.cert ? { subject: v.cert.subject, issuer: v.cert.issuer, serial: v.cert.serial, validFrom: v.cert.validFrom, validTo: v.cert.validTo } : null,
    issuedHere: known ? { verifyCode: known.verify_code, type: known.object_key, signer: known.signer_name, signedAt: known.signed_at, withdrawn: !!known.revoked_at } : null,
  };
}

export { bytesToB64 };

/* ───────────────────────── signing any attached file ───────────────────────── */

export const placementSchema = z.object({
  page: z.union([z.enum(['first', 'last', 'all']), z.number().int().min(1).max(5000)]).default('last'),
  position: z.enum(['bottom-right', 'bottom-left', 'bottom-center', 'top-right', 'top-left']).default('bottom-right'),
});
type Placement = z.infer<typeof placementSchema>;

const isPdfBytes = (b: Uint8Array) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46;
const isDigitallySigned = (b: Uint8Array) => bin(b).includes('/ByteRange');
const baseName = (n: string) => n.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/ - signed$/i, '');

/** A photo (JPG / PNG) becomes a one-page A4 PDF so it can be signed. */
async function imageToPdf(bytes: Uint8Array, type: string) {
  const doc = await PDFDocument.create();
  const img = type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const [W, H] = img.width > img.height ? [842, 595] : [595, 842];
  const scale = Math.min((W - 48) / img.width, (H - 48) / img.height, 1);
  const page = doc.addPage([W, H]);
  page.drawImage(img, { x: (W - img.width * scale) / 2, y: (H - img.height * scale) / 2, width: img.width * scale, height: img.height * scale });
  return doc.save();
}

/** The file as a PDF that can be signed (PDF, JPG or PNG; not one already carrying a digital signature). */
async function signableFile(ctx: RecordCtx, env: Env, fileId: string) {
  const { file, bytes } = await readFileBytes(ctx, env, fileId, 'update');
  let pdf: Uint8Array;
  if (isPdfBytes(bytes)) pdf = bytes;
  else if (file.content_type === 'image/png' || file.content_type === 'image/jpeg') pdf = await imageToPdf(bytes, file.content_type);
  else throw badRequest('Only PDFs and photos (JPG / PNG) can be signed here. Save Word, Excel or other files as PDF first.');
  if (isDigitallySigned(pdf)) throw badRequest('This PDF already carries a digital signature: changing it would break that signature. Sign the original file instead, and add any signature image before the digital signature.');
  return { file, pdf };
}

const pagesFor = (count: number, page: Placement['page']) => (page === 'all' ? [...Array(count).keys()] : page === 'first' ? [0] : page === 'last' ? [count - 1] : [Math.min(page, count) - 1]);
const onePage = (count: number, page: Placement['page']) => (page === 'first' ? 0 : page === 'last' || page === 'all' ? count - 1 : Math.min(page, count) - 1);

async function keepSigned(
  ctx: RecordCtx,
  env: Env,
  file: { id: string; name: string; object_key: string; record_id: string },
  signed: Uint8Array,
  sig: { method: 'image' | 'dsc_pfx' | 'dsc_token'; signerName: string; designation?: string | null; image?: string | null; signatureId?: string | null; cert?: CertRow | null; code: string },
) {
  const out = await saveFile(ctx, env, { objectKey: file.object_key, recordId: file.record_id, name: `${baseName(file.name)} - signed.pdf`, bytes: signed, kind: 'document', description: `${sig.method === 'image' ? 'Signed' : 'Digitally signed'} by ${sig.signerName}` }, { system: true });
  const hash = await sha256Bytes(signed);
  const r = await ctx.tx.one<{ id: string; signed_at: Date }>(
    `insert into document_signatures (tenant_id, object_key, record_id, signature_id, signer_name, designation, image, doc_hash, verify_code, signed_by, method, certificate_id, cert_subject, cert_serial, file_id, pdf_sha256)
     values ($1,'file',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$7) returning id, signed_at`,
    [ctx.tenantId, file.id, sig.signatureId ?? null, sig.signerName, sig.designation ?? null, sig.image ?? null, hash, sig.code, ctx.principal.user.id, sig.method, sig.cert?.id ?? null, sig.cert?.subject ?? null, sig.cert?.serial ?? null, out.id],
  );
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,$3,$4)`, [
    ctx.tenantId, `${file.name} ${sig.method === 'image' ? 'signed' : 'digitally signed'} by ${sig.signerName}`, file.object_key, file.record_id,
  ]);
  return { id: r!.id, fileId: out.id, verifyCode: sig.code, signedAt: r!.signed_at };
}

/** What can be done with a file: preview, sign with a saved signature, sign with a DSC; and who signed it already. */
export async function fileSigning(ctx: RecordCtx, env: Env, fileId: string) {
  const { file, bytes } = await readFileBytes(ctx, env, fileId, 'read');
  const pdf = isPdfBytes(bytes);
  const photo = file.content_type === 'image/png' || file.content_type === 'image/jpeg';
  const canChange = await canChangeFileRecord(ctx, fileId);
  let pages = photo ? 1 : 0;
  if (pdf) pages = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true }).then((d) => d.getPageCount()).catch(() => 0);
  const digitallySigned = pdf && isDigitallySigned(bytes);
  // a signed copy carries the signatures of the copies it was made from (image first, then DSC…)
  const chain = [fileId];
  for (let i = 0; i < 8; i++) {
    const up = await ctx.tx.one<{ record_id: string }>(`select record_id from document_signatures where tenant_id = $1 and object_key = 'file' and file_id = $2 limit 1`, [ctx.tenantId, chain[chain.length - 1]]);
    if (!up || chain.includes(up.record_id)) break;
    chain.push(up.record_id);
  }
  const own = await ctx.tx.query<{ id: string; record_id: string; signer_name: string; designation: string | null; image: string | null; method: string; signed_at: Date; verify_code: string; revoked_at: Date | null; revoke_reason: string | null; cert_subject: string | null; file_id: string | null }>(
    `select id, record_id, signer_name, designation, image, method, signed_at, verify_code, revoked_at, revoke_reason, cert_subject, file_id from document_signatures
      where tenant_id = $1 and object_key = 'file' and (record_id = $2 or file_id = any($3::uuid[])) order by signed_at`,
    [ctx.tenantId, fileId, chain],
  );
  const signatures = [];
  for (const r of own) {
    signatures.push({
      id: r.id, signerName: r.signer_name, designation: r.designation, image: r.image, method: r.method, signedAt: r.signed_at, verifyCode: r.verify_code, revoked: !!r.revoked_at, revokeReason: r.revoke_reason,
      certSubject: r.cert_subject, fileId: r.file_id, isThisFile: r.file_id === fileId, fileUrl: r.file_id ? await signedFileUrl(env, ctx.tenantId, r.file_id, true).catch(() => null) : null,
    });
  }
  let digital: { valid: boolean; reason: string | null; signer: string | null; issuer: string | null } | null = null;
  if (digitallySigned) {
    const v = verifyPdf(bytes);
    digital = { valid: v.ok, reason: v.reason ?? null, signer: v.cert?.subject ?? null, issuer: v.cert?.issuer ?? null };
  }
  const me = ctx.principal.user.id;
  const imageSigs = canChange ? ((await listSignatures(ctx)) as { id: string; signerName: string; designation: string | null; canSign: boolean; image: string }[]).filter((x) => x.canSign) : [];
  const certs = canChange ? (await listCerts(ctx)).filter((c) => c.canSign && !c.expired) : [];
  return {
    file: { id: file.id, name: file.name, contentType: file.content_type, size: Number(file.size_bytes), objectKey: file.object_key, recordId: file.record_id, url: await signedFileUrl(env, ctx.tenantId, file.id, true), downloadUrl: await signedFileUrl(env, ctx.tenantId, file.id, false) },
    preview: pdf ? 'pdf' : file.content_type.startsWith('image/') ? 'image' : file.content_type.startsWith('text/') || file.content_type === 'text/csv' ? 'text' : file.content_type.startsWith('video/') ? 'video' : 'none',
    pages,
    canChange,
    canSign: canChange && (pdf || photo) && !digitallySigned,
    whyNot: !canChange ? 'You cannot change the record this file is on' : !(pdf || photo) ? 'Only PDFs and photos can be signed — save it as PDF first' : digitallySigned ? 'Already digitally signed: changing it would break the signature' : null,
    digital,
    signatures,
    imageSignatures: imageSigs.map((x) => ({ id: x.id, signerName: x.signerName, designation: x.designation, image: x.image })),
    certificates: certs.map((c) => ({ id: c.id, kind: c.kind, subjectCn: c.subjectCn, validTo: c.validTo })),
    signers: canChange ? await listSigners(ctx) : [],
    me,
  };
}

export const imageSignFileSchema = placementSchema.extend({ signatureId: z.string().uuid() });

/** Puts a saved signature (image, name, date and verification code) on the file's pages; keeps a signed copy. */
export async function signFileWithImage(ctx: RecordCtx, env: Env, fileId: string, input: z.infer<typeof imageSignFileSchema>, verifyBase: string | null) {
  const { file, pdf } = await signableFile(ctx, env, fileId);
  const sig = await ctx.tx.one<{ id: string; signer_name: string; designation: string | null; image: string; user_ids: string[] }>(`select id, signer_name, designation, image, user_ids from signatures where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, input.signatureId]);
  if (!sig) throw notFound('Signature not found');
  if (!sig.user_ids.includes(ctx.principal.user.id)) throw forbidden(`Only ${sig.signer_name}'s named signers can use this signature`);
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const raw = b64ToBytes(sig.image);
  const img = raw[0] === 0x89 ? await doc.embedPng(raw) : await doc.embedJpg(raw);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const code = verifyCode();
  const lines = [sig.designation, `Signed ${istNow()} IST`, verifyBase ? `Verify: ${verifyBase}/${code}` : `Verification code: ${code}`].filter(Boolean) as string[];
  const size = 7;
  const iw = 120;
  const ih = Math.min(48, (img.height / img.width) * iw);
  const w = Math.max(iw, bold.widthOfTextAtSize(sig.signer_name, 8.5), ...lines.map((t) => font.widthOfTextAtSize(t, size))) + 8;
  const h = ih + 12 + lines.length * (size + 2) + 6;
  for (const i of pagesFor(doc.getPageCount(), input.page)) {
    const page = doc.getPage(i);
    const { x, y } = placeBox(page.getWidth(), page.getHeight(), w, h, input.position as StampPosition);
    page.drawImage(img, { x: x + 4, y: y + h - ih - 2, width: (img.width / img.height) * ih, height: ih });
    page.drawLine({ start: { x: x + 4, y: y + h - ih - 4 }, end: { x: x + w - 4, y: y + h - ih - 4 }, thickness: 0.5, color: rgb(0.6, 0.65, 0.72) });
    page.drawText(sig.signer_name, { x: x + 4, y: y + h - ih - 14, size: 8.5, font: bold, color: rgb(0.06, 0.09, 0.16) });
    lines.forEach((t, k) => page.drawText(t, { x: x + 4, y: y + h - ih - 14 - (k + 1) * (size + 2), size, font, color: rgb(0.28, 0.33, 0.41) }));
  }
  const signed = await doc.save();
  return keepSigned(ctx, env, file, signed, { method: 'image', signerName: sig.signer_name, designation: sig.designation, image: sig.image, signatureId: sig.id, code });
}

export const pfxSignFileSchema = placementSchema.extend({ certificateId: z.string().uuid(), location: z.string().max(120).nullish() });

export async function signFileWithPfx(ctx: RecordCtx, env: Env, fileId: string, input: z.infer<typeof pfxSignFileSchema>, verifyBase: string | null) {
  const { file, pdf } = await signableFile(ctx, env, fileId);
  const c = await certFor(ctx, input.certificateId, 'pfx');
  if (!c.pfx_enc || c.pfx_enc === 'removed' || !c.pass_enc) throw badRequest('This certificate was removed');
  const key = requireEncryptionKey(env);
  const signer = readPfx(b64ToBytes(await decryptSecret(key, c.pfx_enc, ctx.tenantId)), await decryptSecret(key, c.pass_enc, ctx.tenantId));
  const code = verifyCode();
  const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
  const reason = `Signed: ${baseName(file.name)}`.slice(0, 120);
  const signed = await signPdf(pdf, signer, {
    name: c.subject_cn,
    reason,
    location: input.location ?? undefined,
    stamp: { page: onePage(pages, input.page), position: input.position as StampPosition, text: [`Digitally signed by ${c.subject_cn}`, `Date: ${istNow()} IST`, `Reason: ${reason}`, verifyBase ? `Verify: ${verifyBase}/${code}` : `Verification code: ${code}`] },
  });
  const v = verifyPdf(signed);
  if (!v.ok) throw new Error(`The signed PDF did not verify: ${v.reason}`);
  return keepSigned(ctx, env, file, signed, { method: 'dsc_pfx', signerName: c.subject_cn, cert: c, signatureId: c.signature_id, code });
}

export const tokenPrepareFileSchema = placementSchema.extend({ certificateId: z.string().uuid(), signerId: z.string().uuid(), location: z.string().max(120).nullish() });

export async function prepareFileTokenSign(ctx: RecordCtx, env: Env, fileId: string, input: z.infer<typeof tokenPrepareFileSchema>, verifyBase: string | null) {
  const { file, pdf } = await signableFile(ctx, env, fileId);
  const c = await certFor(ctx, input.certificateId, 'token');
  if (!c.cert_pem) throw badRequest('This certificate has no copy of its public part: add it again from the token');
  const cert = certFromPem(c.cert_pem);
  if (!(cert.publicKey as forge.pki.rsa.PublicKey).n) throw badRequest('Only RSA certificates can sign here');
  const s = await ctx.tx.one<{ secret_enc: string }>(`select secret_enc from dsc_signers where tenant_id = $1 and id = $2 and revoked_at is null`, [ctx.tenantId, input.signerId]);
  if (!s) throw notFound('That signer is not paired with this workspace');
  const secret = await decryptSecret(requireEncryptionKey(env), s.secret_enc, ctx.tenantId);
  const code = verifyCode();
  const reason = `Signed: ${baseName(file.name)}`.slice(0, 120);
  const pages = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
  const prepared = await preparePdf(pdf, {
    name: c.subject_cn,
    reason,
    location: input.location ?? undefined,
    stamp: { page: onePage(pages, input.page), position: input.position as StampPosition, text: [`Digitally signed by ${c.subject_cn}`, `Date: ${istNow()} IST`, `Reason: ${reason}`, verifyBase ? `Verify: ${verifyBase}/${code}` : `Verification code: ${code}`] },
  });
  const signingTime = new Date(Math.floor(Date.now() / 1000) * 1000);
  const digest = cmsDigestToSign(prepared.toSign, cert, signingTime);
  const payload = { v: 2, t: ctx.tenantId, s: input.signerId, u: ctx.principal.user.id, o: 'file', r: fileId, c: c.thumbprint, d: toHex(digest), p: await sha256Bytes(prepared.pdf), st: signingTime.toISOString(), k: code, exp: Math.floor(Date.now() / 1000) + 600, reason };
  const body = btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const mac = await hmacSha256Hex(secret, body);
  await ctx.tx.query(`update dsc_signers set last_used_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, input.signerId]);
  return { ticket: `${body}.${mac}`, prepared: bytesToB64(prepared.pdf), verifyCode: code };
}

export async function completeFileTokenSign(ctx: RecordCtx, env: Env, fileId: string, input: z.infer<typeof tokenCompleteSchema>) {
  const [body, mac] = input.ticket.split('.');
  if (!body || !mac) throw badRequest('Bad ticket');
  const payload = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, any>;
  if (payload.v !== 2 || payload.o !== 'file') throw badRequest('This ticket is not for a file: sign again');
  if (payload.t !== ctx.tenantId || payload.r !== fileId || payload.u !== ctx.principal.user.id) throw forbidden('This ticket is for another file');
  if (payload.exp < Date.now() / 1000 - 60) throw badRequest('The signing ticket expired: sign again');
  const s = await ctx.tx.one<{ secret_enc: string }>(`select secret_enc from dsc_signers where tenant_id = $1 and id = $2 and revoked_at is null`, [ctx.tenantId, payload.s]);
  if (!s) throw forbidden('That signer is no longer paired');
  if ((await hmacSha256Hex(await decryptSecret(requireEncryptionKey(env), s.secret_enc, ctx.tenantId), body)) !== mac) throw forbidden('The ticket was not made by this workspace');
  if (await ctx.tx.one(`select 1 from document_signatures where tenant_id = $1 and verify_code = $2`, [ctx.tenantId, payload.k])) throw conflict('This ticket was already used');
  const { file } = await readFileBytes(ctx, env, fileId, 'update');
  const c = await ctx.tx.one<CertRow>(`select * from dsc_certificates where tenant_id = $1 and thumbprint = $2 and is_active and kind = 'token'`, [ctx.tenantId, payload.c]);
  if (!c?.cert_pem) throw notFound('The certificate is no longer registered');
  const prepared = b64ToBytes(input.prepared);
  if ((await sha256Bytes(prepared)) !== payload.p) throw badRequest('This is not the PDF that was prepared for signing');
  const place = placeholders(prepared);
  const cms = cmsWithSignature(place.toSign, certFromPem(c.cert_pem), new Date(payload.st), b64ToBytes(input.signature));
  const signed = embedCms(place, cms);
  const v = verifyPdf(signed);
  if (!v.ok) throw badRequest(`The token's signature does not verify (${v.reason}). Is the right certificate chosen on the token?`);
  if (v.cert?.thumbprint !== c.thumbprint || !v.coversWholeFile) throw forbidden('The signed PDF does not match the registered certificate');
  return keepSigned(ctx, env, file, signed, { method: 'dsc_token', signerName: c.subject_cn, cert: c, signatureId: c.signature_id, code: String(payload.k) });
}

export async function revokeFileSignature(ctx: RecordCtx, env: Env, fileId: string, sigId: string, reason: string) {
  await readFileBytes(ctx, env, fileId, 'update');
  const r = await ctx.tx.one(`update document_signatures set revoked_at = now(), revoke_reason = $4 where tenant_id = $1 and object_key = 'file' and id = $3 and revoked_at is null and (record_id = $2 or file_id = $2 or file_id in (select record_id from document_signatures where tenant_id = $1 and file_id = $2)) returning id`, [ctx.tenantId, fileId, sigId, reason]);
  if (!r) throw notFound();
}
