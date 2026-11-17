/**
 * The organisation's own profile, managed by admins with the "organisation" area or the people an
 * admin names as its managers:
 *
 *  - company details (legal name, constitution, PAN, GSTIN, registration numbers, addresses, phones,
 *    emails, website) kept in tenants.settings.company, where invoices and quotes read them from;
 *  - the organisation's own contacts (accounts, HR, support desk …), in tenants.settings.organisation;
 *  - saved signatures and who may sign with each; signing a document records who signed, when, a hash
 *    of what was signed and a code anyone can check on the verification page.
 *
 * Partners / directors with their personal accounts and the company's bank accounts live with the
 * accounts desk (own-accounts.ts) and are managed from the same Organisation page.
 */
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../lib/crypto';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import type { Env } from '../env';
import { signedFileUrl } from './files';
import { loadRow, readRowSystem, type RecordCtx } from './records';

/* ───────────────────────── who manages it ───────────────────────── */

async function orgSettings(ctx: RecordCtx) {
  const r = await ctx.tx.one<{ company: Record<string, any> | null; org: Record<string, any> | null; name: string }>(
    `select name, settings -> 'company' as company, settings -> 'organisation' as org from tenants where id = $1`,
    [ctx.tenantId],
  );
  return { name: r?.name ?? '', company: r?.company ?? {}, org: r?.org ?? {} };
}

export async function canManageOrg(ctx: RecordCtx): Promise<boolean> {
  if (hasAdmin(ctx.principal.permissions, 'organisation')) return true;
  const { org } = await orgSettings(ctx);
  return Array.isArray(org.managers) && org.managers.includes(ctx.principal.user.id);
}

export async function assertOrgManager(ctx: RecordCtx) {
  if (!(await canManageOrg(ctx))) throw forbidden('Only admins and the people they name can change the organisation profile');
}

/* ───────────────────────── profile ───────────────────────── */

const phone = z.object({ label: z.string().trim().max(60).default(''), number: z.string().trim().regex(/^[+0-9 ()\-.]{4,25}$/, 'invalid phone number') });
const email = z.object({ label: z.string().trim().max(60).default(''), email: z.string().trim().toLowerCase().pipe(z.email()) });
const address = z.object({ label: z.string().trim().max(60).default(''), address: z.string().trim().max(500), city: z.string().trim().max(80).default(''), state: z.string().trim().max(60).default(''), pincode: z.string().trim().max(10).default('') });

export const profileSchema = z.object({
  legalName: z.string().trim().min(1).max(200),
  tradeName: z.string().trim().max(200).optional(),
  constitution: z.union([z.literal(''), z.enum(['llp', 'private_limited', 'public_limited', 'partnership', 'proprietorship', 'opc', 'trust', 'society', 'section_8', 'other'])]).optional(),
  pan: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN looks like AASFH6805J')]).optional(),
  tan: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{4}[0-9]{5}[A-Z]$/, 'TAN looks like DELH12345A')]).optional(),
  gstin: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'not a GSTIN')]).optional(),
  registrationNo: z.string().trim().max(60).optional(),
  udyam: z.string().trim().max(40).optional(),
  incorporatedOn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  // Startup India (DPIIT) recognition and the tax exemptions that come with it
  dpiitNumber: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^DIPP\d{3,7}$/, 'A DPIIT recognition number looks like DIPP123456')]).optional(),
  dpiitRecognisedOn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional(),
  startupSector: z.string().trim().max(120).optional(),
  startupIndustry: z.string().trim().max(120).optional(),
  section80IacCertNo: z.string().trim().max(60).optional(),
  section80IacFrom: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}$/)]).optional(),
  section56Exempt: z.boolean().optional(),
  // the organisation's logo (a PNG data URL, resized in the browser): printed on documents and reports
  logo: z.union([z.literal(''), z.string().regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, 'The logo must be a PNG or JPEG image').max(400_000, 'The logo is too large (at most about 300 KB)')]).optional(),
  address: z.string().trim().max(500).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(60).optional(),
  pincode: z.string().trim().max(10).optional(),
  website: z.union([z.literal(''), z.string().trim().max(200)]).optional(),
  phone: z.string().trim().max(25).optional(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email())]).optional(),
  phones: z.array(phone).max(20).default([]),
  emails: z.array(email).max(20).default([]),
  addresses: z.array(address).max(10).default([]),
  contacts: z
    .array(z.object({ name: z.string().trim().min(1).max(120), role: z.string().trim().max(120).default(''), phone: z.string().trim().max(25).default(''), email: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email())]).default('') }))
    .max(50)
    .default([]),
  managers: z.array(z.string().uuid()).max(20).optional(),
});

export async function getProfile(ctx: RecordCtx) {
  const { name, company, org } = await orgSettings(ctx);
  const users = await ctx.tx.query<{ id: string; full_name: string; email: string }>(`select id, full_name, email from users where tenant_id = $1 and status = 'active' order by full_name`, [ctx.tenantId]);
  return {
    workspaceName: name,
    canManage: await canManageOrg(ctx),
    isAdmin: hasAdmin(ctx.principal.permissions, 'organisation'),
    profile: {
      legalName: company.legalName ?? name,
      tradeName: company.tradeName ?? '',
      constitution: company.constitution ?? '',
      pan: company.pan ?? '',
      tan: company.tan ?? '',
      gstin: company.gstin ?? '',
      registrationNo: company.registrationNo ?? '',
      udyam: company.udyam ?? '',
      incorporatedOn: company.incorporatedOn ?? '',
      dpiitNumber: company.dpiitNumber ?? '',
      dpiitRecognisedOn: company.dpiitRecognisedOn ?? '',
      startupSector: company.startupSector ?? '',
      startupIndustry: company.startupIndustry ?? '',
      section80IacCertNo: company.section80IacCertNo ?? '',
      section80IacFrom: company.section80IacFrom ?? '',
      section56Exempt: company.section56Exempt ?? false,
      logo: company.logo ?? '',
      address: company.address ?? '',
      city: company.city ?? '',
      state: company.state ?? '',
      pincode: company.pincode ?? '',
      website: company.website ?? '',
      phone: company.phone ?? '',
      email: company.email ?? '',
      phones: org.phones ?? [],
      emails: org.emails ?? [],
      addresses: org.addresses ?? [],
      contacts: org.contacts ?? [],
      managers: org.managers ?? [],
    },
    users: users.map((u) => ({ id: u.id, name: u.full_name, email: u.email })),
  };
}

export async function saveProfile(ctx: RecordCtx, input: z.infer<typeof profileSchema>) {
  await assertOrgManager(ctx);
  // naming who manages the profile is for admins only
  if (input.managers !== undefined && !hasAdmin(ctx.principal.permissions, 'organisation')) throw forbidden('Only admins choose who manages the organisation profile');
  if (input.gstin && input.pan && input.gstin.slice(2, 12) !== input.pan) throw badRequest('The GSTIN does not contain this PAN');
  const { phones, emails, addresses, contacts, managers, ...company } = input;
  const cur = await orgSettings(ctx);
  const org = { ...cur.org, phones, emails, addresses, contacts, ...(managers !== undefined ? { managers } : {}) };
  // the first phone / email also fill the single fields the documents print
  const merged = { ...cur.company, ...company, phone: company.phone || phones[0]?.number || cur.company.phone || '', email: company.email || emails[0]?.email || cur.company.email || '' };
  await ctx.tx.query(
    `update tenants set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('company', $2::jsonb, 'organisation', $3::jsonb) where id = $1`,
    [ctx.tenantId, JSON.stringify(merged), JSON.stringify(org)],
  );
  return getProfile(ctx);
}

/* ───────────────────────── signatures ───────────────────────── */

export const signatureSchema = z.object({
  signerName: z.string().trim().min(1).max(120),
  designation: z.string().trim().max(120).optional(),
  image: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/, 'Upload a PNG or JPEG of the signature').max(400_000, 'The signature image is too large (keep it under 300 KB)'),
  userIds: z.array(z.string().uuid()).max(20).default([]),
});

interface SigRow {
  id: string;
  signer_name: string;
  designation: string | null;
  image: string;
  user_ids: string[];
  is_active: boolean;
  created_at: Date;
}

export async function listSignatures(ctx: RecordCtx) {
  const rows = await ctx.tx.query<SigRow>(`select id, signer_name, designation, image, user_ids, is_active, created_at from signatures where tenant_id = $1 and is_active order by signer_name`, [ctx.tenantId]);
  const me = ctx.principal.user.id;
  const manager = await canManageOrg(ctx);
  return rows.map((r) => ({ id: r.id, signerName: r.signer_name, designation: r.designation, image: r.image, userIds: r.user_ids, canSign: r.user_ids.includes(me), canEdit: manager }));
}

export async function saveSignature(ctx: RecordCtx, id: string | null, input: z.infer<typeof signatureSchema>) {
  await assertOrgManager(ctx);
  if (input.userIds.length) {
    const ok = await ctx.tx.query(`select id from users where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, input.userIds]);
    if (ok.length !== new Set(input.userIds).size) throw badRequest('Unknown user');
  }
  if (id) {
    const r = await ctx.tx.one(`update signatures set signer_name = $3, designation = $4, image = $5, user_ids = $6 where tenant_id = $1 and id = $2 and is_active returning id`, [
      ctx.tenantId, id, input.signerName, input.designation ?? null, input.image, input.userIds,
    ]);
    if (!r) throw notFound();
    return { id };
  }
  return (await ctx.tx.one<{ id: string }>(`insert into signatures (tenant_id, signer_name, designation, image, user_ids) values ($1,$2,$3,$4,$5) returning id`, [
    ctx.tenantId, input.signerName, input.designation ?? null, input.image, input.userIds,
  ]))!;
}

export async function removeSignature(ctx: RecordCtx, id: string) {
  await assertOrgManager(ctx);
  const r = await ctx.tx.one(`update signatures set is_active = false where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound();
}

/** Documents that can be signed, and how to read what is signed. */
export const SIGNABLE: Record<string, { number: string; date: string; party: string; lines: { table: string; fk: string } | null; draft?: string }> = {
  invoice: { number: 'invoice_number', date: 'invoice_date', party: 'account_id', lines: { table: 'invoice_lines', fk: 'order_id' }, draft: 'draft' },
  quote: { number: 'quote_number', date: 'created_at', party: 'account_id', lines: { table: 'quote_lines', fk: 'quote_id' } },
  sales_order: { number: 'order_number', date: 'order_date', party: 'account_id', lines: { table: 'sales_order_lines', fk: 'order_id' } },
  purchase_order: { number: 'po_number', date: 'order_date', party: 'vendor_id', lines: { table: 'purchase_order_lines', fk: 'order_id' } },
};

const d10 = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/** A hash of what a reader relies on: number, date, party, totals and every line. */
export async function docHash(ctx: RecordCtx, objectKey: string, row: Record<string, unknown>) {
  const s = SIGNABLE[objectKey]!;
  const lines = s.lines
    ? await ctx.tx.query<Record<string, unknown>>(`select name, hsn_sac, quantity::text, unit_price::text, discount_pct::text, tax_rate::text, line_total::text from ${s.lines.table} where tenant_id = $1 and ${s.lines.fk} = $2 order by position`, [ctx.tenantId, row.id])
    : [];
  const canonical = JSON.stringify({
    t: objectKey,
    n: row[s.number] ?? null,
    d: d10(row[s.date]),
    p: row[s.party] ?? null,
    g: row.buyer_gstin ?? null,
    total: row.grand_total != null ? Number(row.grand_total).toFixed(2) : null,
    tax: row.tax_total != null ? Number(row.tax_total).toFixed(2) : null,
    lines: lines.map((l) => [l.name, l.hsn_sac, Number(l.quantity), Number(l.unit_price), Number(l.discount_pct), Number(l.tax_rate), Number(l.line_total)]),
  });
  return sha256Hex(canonical);
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function verifyCode() {
  const raw = randomToken(24);
  let out = '';
  for (let i = 0; out.length < 12; i++) out += CODE_CHARS[raw.charCodeAt(i % raw.length) % CODE_CHARS.length];
  return out;
}

/**
 * Signs a document with a saved signature. The person must be one of the signature's signers (an
 * automatic signature set by an admin passes `system`). Invoices are signed once issued.
 */
export async function signDocument(ctx: RecordCtx, objectKey: string, recordId: string, signatureId: string, opts: { system?: boolean } = {}) {
  const s = SIGNABLE[objectKey];
  if (!s) throw badRequest('This kind of document cannot be signed');
  const row = opts.system ? await readRowSystem(ctx, objectKey, recordId) : (await loadRow(ctx, objectKey, recordId, 'read')).row;
  if (!row) throw notFound();
  if (s.draft && row.status === s.draft) throw badRequest('Issue the document before signing it: a signed draft would change');
  if (row.status === 'cancelled') throw badRequest('This document is cancelled');
  const sig = await ctx.tx.one<SigRow>(`select id, signer_name, designation, image, user_ids, is_active, created_at from signatures where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, signatureId]);
  if (!sig) throw notFound('Signature not found');
  if (!opts.system && !sig.user_ids.includes(ctx.principal.user.id)) throw forbidden(`Only ${sig.signer_name}'s named signers can sign with this signature`);
  const already = await ctx.tx.one(`select 1 from document_signatures where tenant_id = $1 and object_key = $2 and record_id = $3 and signature_id = $4 and revoked_at is null`, [ctx.tenantId, objectKey, recordId, signatureId]);
  if (already) throw conflict(`${sig.signer_name} has already signed this document`);
  const hash = await docHash(ctx, objectKey, row);
  const r = await ctx.tx.one<{ id: string; verify_code: string; signed_at: Date }>(
    `insert into document_signatures (tenant_id, object_key, record_id, signature_id, signer_name, designation, image, doc_hash, verify_code, signed_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, verify_code, signed_at`,
    [ctx.tenantId, objectKey, recordId, sig.id, sig.signer_name, sig.designation, sig.image, hash, verifyCode(), opts.system ? null : ctx.principal.user.id],
  );
  return r!;
}

export async function revokeSignature(ctx: RecordCtx, objectKey: string, recordId: string, docSigId: string, reason: string) {
  await loadRow(ctx, objectKey, recordId, 'update', true);
  const r = await ctx.tx.one(`update document_signatures set revoked_at = now(), revoke_reason = $5 where tenant_id = $1 and object_key = $2 and record_id = $3 and id = $4 and revoked_at is null returning id`, [
    ctx.tenantId, objectKey, recordId, docSigId, reason,
  ]);
  if (!r) throw notFound();
}

/** Signatures on a document, each checked against the document as it is now. */
export async function documentSignatures(ctx: RecordCtx, objectKey: string, recordId: string, env?: Env) {
  if (!SIGNABLE[objectKey]) return [];
  const rows = await ctx.tx.query<{ id: string; signer_name: string; designation: string | null; image: string | null; doc_hash: string; verify_code: string; signed_at: Date; revoked_at: Date | null; revoke_reason: string | null; method: string; cert_subject: string | null; cert_serial: string | null; file_id: string | null }>(
    `select id, signer_name, designation, image, doc_hash, verify_code, signed_at, revoked_at, revoke_reason, method, cert_subject, cert_serial, file_id from document_signatures where tenant_id = $1 and object_key = $2 and record_id = $3 order by signed_at`,
    [ctx.tenantId, objectKey, recordId],
  );
  if (!rows.length) return [];
  const row = await readRowSystem(ctx, objectKey, recordId);
  const now = row ? await docHash(ctx, objectKey, row) : null;
  const out = rows.map((r) => ({
    id: r.id,
    signerName: r.signer_name,
    designation: r.designation,
    image: r.image,
    signedAt: r.signed_at,
    verifyCode: r.verify_code,
    revoked: !!r.revoked_at,
    revokeReason: r.revoke_reason,
    valid: !r.revoked_at && r.doc_hash === now,
    method: r.method,
    certSubject: r.cert_subject,
    certSerial: r.cert_serial,
    fileId: r.file_id,
  }));
  if (env) for (const o of out) if (o.fileId) (o as Record<string, unknown>).fileUrl = await signedFileUrl(env, ctx.tenantId, o.fileId, false).catch(() => null);
  return out;
}

/** Public check of a signature code (the code printed on the document). */
export async function verifyByCode(ctx: RecordCtx, code: string) {
  const r = await ctx.tx.one<{ object_key: string; record_id: string; signer_name: string; designation: string | null; doc_hash: string; signed_at: Date; revoked_at: Date | null; method: string; cert_subject: string | null; cert_serial: string | null; pdf_sha256: string | null }>(
    `select object_key, record_id, signer_name, designation, doc_hash, signed_at, revoked_at, method, cert_subject, cert_serial, pdf_sha256 from document_signatures where tenant_id = $1 and verify_code = $2`,
    [ctx.tenantId, code.toUpperCase()],
  );
  if (!r) return { found: false as const };
  const s = SIGNABLE[r.object_key]!;
  const row = await readRowSystem(ctx, r.object_key, r.record_id);
  const company = (await orgSettings(ctx)).company;
  const now = row ? await docHash(ctx, r.object_key, row) : null;
  return {
    found: true as const,
    issuer: company.legalName ?? null,
    document: { type: r.object_key, number: row ? (row[s.number] ?? null) : null, date: row ? d10(row[s.date]) : null, total: row?.grand_total != null ? Number(row.grand_total) : null, status: row?.status ?? 'deleted' },
    signer: { name: r.signer_name, designation: r.designation },
    method: r.method,
    certificate: r.cert_subject ? { subject: r.cert_subject, serial: r.cert_serial } : null,
    pdfSha256: r.pdf_sha256,
    signedAt: r.signed_at,
    valid: !!row && !r.revoked_at && now === r.doc_hash && row.status !== 'cancelled',
    revoked: !!r.revoked_at,
  };
}
