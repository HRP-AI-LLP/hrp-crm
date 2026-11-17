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
import { certFromPem, certInfo, cmsDigestToSign, cmsWithSignature, embedCms, placeholders, preparePdf, readPfx, sha256Bytes, sha256DigestInfo, signPdf, verifyPdf } from '../lib/pdf-sign';
import { requireEncryptionKey } from './ai/tenant-providers';
import { saveFile } from './files';
import { assertOrgManager, canManageOrg, docHash, SIGNABLE, verifyCode } from './organisation';
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
