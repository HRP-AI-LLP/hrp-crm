/**
 * Registration documents of the organisation and of its partners / directors: what it is (PAN, TAN, GST,
 * incorporation, Udyam, Startup India recognition…), its number and dates, and the uploaded copy.
 *
 * Only the organisation's managers (admins with the Organisation area and the people they name) see and
 * change them: these are identity papers. The copies are stored like other files, against the object key
 * `organisation` (which the generic file routes do not serve), and handed out as short-lived signed links.
 */
import { hasAdmin } from '@synapse/shared';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { Env } from '../env';
import { assertOrgManager, canManageOrg } from './organisation';
import { saveFile, signedFileUrl } from './files';
import type { RecordCtx } from './records';

/** The documents an Indian organisation usually keeps on file, and those of a partner or director. */
export const COMPANY_DOCS: [string, string, string][] = [
  ['pan', 'PAN card', 'pan'],
  ['tan', 'TAN allotment', 'tan'],
  ['gst', 'GST registration (REG-06)', 'gstin'],
  ['incorporation', 'Certificate of incorporation / registration', 'registrationNo'],
  ['llp_agreement', 'LLP agreement / partnership deed', ''],
  ['trust_deed', 'Trust deed / society registration', ''],
  ['moa_aoa', 'MoA and AoA', ''],
  ['udyam', 'Udyam (MSME) certificate', 'udyam'],
  ['startup_india', 'Startup India (DPIIT) recognition', 'dpiitNumber'],
  ['section_80iac', 'Section 80-IAC tax exemption', 'section80IacCertNo'],
  ['section_56', 'Section 56 exemption (angel tax)', ''],
  ['iec', 'Import Export Code (IEC)', ''],
  ['shops_establishment', 'Shops and establishment licence', ''],
  ['professional_tax', 'Professional tax registration', ''],
  ['trademark', 'Trademark registration', ''],
  ['address_proof', 'Office address proof / rent agreement', ''],
  ['bank_letter', 'Cancelled cheque / bank letter', ''],
  // asked for in tenders (GeM and others)
  ['turnover_certificate', 'CA certificate of turnover', ''],
  ['audited_financials', 'Audited balance sheet and P&L', ''],
  ['itr', 'Income tax returns (ITR-V)', ''],
  ['experience_certificate', 'Work orders / completion certificates', ''],
  ['oem_authorization', 'OEM authorisation certificate', ''],
  ['iso', 'ISO / quality certificates', ''],
  ['epf_esic', 'EPF / ESIC registration', ''],
  ['gem_registration', 'GeM seller registration', ''],
  ['other', 'Other', ''],
];
export const PERSON_DOCS: [string, string][] = [
  ['pan', 'PAN card'],
  ['aadhaar', 'Aadhaar'],
  ['din', 'DIN / DPIN allotment'],
  ['uan', 'UAN card / EPFO letter'],
  ['pf', 'PF nomination (Form 2 / Form 11)'],
  ['passport', 'Passport'],
  ['address_proof', 'Address proof'],
  ['photo', 'Photograph'],
  ['bank_letter', 'Cancelled cheque / bank letter'],
  ['other', 'Other'],
];

const day = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).nullish().transform((v) => v || null);
export const docSchema = z.object({
  personId: z.string().uuid().nullish(),
  userId: z.string().uuid().nullish(),
  kind: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  label: z.string().trim().max(120).nullish().transform((v) => v || null),
  number: z.string().trim().max(80).nullish().transform((v) => v || null),
  issuedOn: day,
  validUntil: day,
  notes: z.string().trim().max(500).nullish().transform((v) => v || null),
});
export const docUpdateSchema = docSchema.omit({ personId: true, userId: true });

/** Whose documents: the organisation's, a partner's, or a team member's. */
export interface Owner {
  personId?: string | null;
  userId?: string | null;
}

/**
 * The organisation's and partners' papers are for the profile's managers; a team member's are also for
 * admins who manage users (they onboard people).
 */
export async function assertOwnerAccess(ctx: RecordCtx, owner: Owner) {
  if (owner.userId && hasAdmin(ctx.principal.permissions, 'users')) return;
  if (!(await canManageOrg(ctx))) throw forbidden(owner.userId ? 'Only admins who manage users, and the organisation profile managers, see team members\' documents' : 'Only admins and the people they name can see the organisation\'s documents');
}

export async function ownerOf(ctx: RecordCtx, id: string): Promise<Owner> {
  const r = await ctx.tx.one<{ person_id: string | null; user_id: string | null }>(`select person_id, user_id from org_documents where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!r) throw notFound('No such document');
  return { personId: r.person_id, userId: r.user_id };
}

interface DocRow {
  id: string;
  person_id: string | null;
  user_id: string | null;
  person_name: string | null;
  user_name: string | null;
  kind: string;
  label: string | null;
  number: string | null;
  issued_on: string | null;
  valid_until: string | null;
  notes: string | null;
  file_id: string | null;
  file_name: string | null;
  content_type: string | null;
  size_bytes: string | null;
  created_at: string;
  updated_at: string;
}

const kindName = (kind: string, person: boolean) => (person ? PERSON_DOCS.find((k) => k[0] === kind)?.[1] : COMPANY_DOCS.find((k) => k[0] === kind)?.[1]) ?? kind;

async function dto(env: Env, tenantId: string, r: DocRow) {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    id: r.id,
    personId: r.person_id,
    userId: r.user_id,
    personName: r.person_name ?? r.user_name,
    kind: r.kind,
    kindName: kindName(r.kind, !!(r.person_id || r.user_id)),
    label: r.label,
    number: r.number,
    issuedOn: r.issued_on,
    validUntil: r.valid_until,
    status: !r.valid_until ? null : r.valid_until < today ? 'expired' : r.valid_until <= soon ? 'expiring' : 'valid',
    notes: r.notes,
    file: r.file_id
      ? {
          id: r.file_id,
          name: r.file_name,
          contentType: r.content_type,
          size: Number(r.size_bytes ?? 0),
          url: await signedFileUrl(env, tenantId, r.file_id, true, 900),
          downloadUrl: await signedFileUrl(env, tenantId, r.file_id, false, 900),
        }
      : null,
    updatedAt: r.updated_at,
  };
}

const SELECT = `select d.*, p.name as person_name, u.full_name as user_name, f.name as file_name, f.content_type, f.size_bytes
  from org_documents d
  left join acct_persons p on p.tenant_id = d.tenant_id and p.id = d.person_id
  left join users u on u.tenant_id = d.tenant_id and u.id = d.user_id
  left join files f on f.tenant_id = d.tenant_id and f.id = d.file_id and f.deleted_at is null`;

export async function listDocuments(ctx: RecordCtx, env: Env) {
  await assertOrgManager(ctx);
  const rows = await ctx.tx.query<DocRow>(`${SELECT} where d.tenant_id = $1 order by d.person_id nulls first, d.user_id nulls first, d.kind, d.created_at`, [ctx.tenantId]);
  return {
    companyKinds: COMPANY_DOCS.map(([key, name, profileField]) => ({ key, name, profileField: profileField || null })),
    personKinds: PERSON_DOCS.map(([key, name]) => ({ key, name })),
    documents: await Promise.all(rows.map((r) => dto(env, ctx.tenantId, r))),
  };
}

async function one(ctx: RecordCtx, env: Env, id: string) {
  const r = await ctx.tx.one<DocRow>(`${SELECT} where d.tenant_id = $1 and d.id = $2`, [ctx.tenantId, id]);
  if (!r) throw notFound('No such document');
  return dto(env, ctx.tenantId, r);
}

/** One person's documents (a partner or a team member), for their identity panel. */
export async function documentsOf(ctx: RecordCtx, env: Env, owner: Owner) {
  await assertOwnerAccess(ctx, owner);
  const rows = owner.userId
    ? await ctx.tx.query<DocRow>(`${SELECT} where d.tenant_id = $1 and d.user_id = $2 order by d.kind, d.created_at`, [ctx.tenantId, owner.userId])
    : await ctx.tx.query<DocRow>(`${SELECT} where d.tenant_id = $1 and d.person_id = $2 order by d.kind, d.created_at`, [ctx.tenantId, owner.personId]);
  return Promise.all(rows.map((r) => dto(env, ctx.tenantId, r)));
}

export async function createDocument(ctx: RecordCtx, env: Env, input: z.infer<typeof docSchema>) {
  if (input.personId && input.userId) throw badRequest('A document belongs to one person');
  await assertOwnerAccess(ctx, input);
  const person = !!(input.personId || input.userId);
  if (input.personId) {
    const p = await ctx.tx.one(`select 1 from acct_persons where tenant_id = $1 and id = $2`, [ctx.tenantId, input.personId]);
    if (!p) throw notFound('No such partner or director');
  }
  if (input.userId) {
    const u = await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2`, [ctx.tenantId, input.userId]);
    if (!u) throw notFound('No such team member');
  }
  if (!(person ? PERSON_DOCS : COMPANY_DOCS).some((k) => k[0] === input.kind)) throw badRequest('Unknown kind of document');
  if (input.kind === 'other' && !input.label) throw badRequest('Name the document');
  const number = checkNumber(input.kind, input.number);
  if (input.issuedOn && input.validUntil && input.validUntil < input.issuedOn) throw badRequest('It cannot expire before it was issued');
  const r = await ctx.tx.one<{ id: string }>(
    `insert into org_documents (tenant_id, person_id, user_id, kind, label, number, issued_on, valid_until, notes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [ctx.tenantId, input.personId ?? null, input.userId ?? null, input.kind, input.label, number, input.issuedOn, input.validUntil, input.notes],
  );
  return one(ctx, env, r!.id);
}

/**
 * Catches the usual typing slips in numbers whose shape is fixed, and returns what is kept: an Aadhaar
 * number is kept masked to its last four digits here (the full number lives encrypted in the identity).
 */
function checkNumber(kind: string, n: string | null): string | null {
  if (!n) return null;
  const v = n.toUpperCase().replace(/\s/g, '');
  if (kind === 'aadhaar') {
    if (/^\d{12}$/.test(v) && !verhoeffOk(v)) throw badRequest('This Aadhaar number has a typing mistake (its check digit does not match)');
    if (!/^(\d{4}|X{4}){2}\d{4}$/.test(v)) throw badRequest('Aadhaar has 12 digits (you may mask the first 8 as XXXXXXXX)');
    return `XXXXXXXX${v.slice(-4)}`;
  }
  if (kind === 'uan' && !/^\d{12}$/.test(v)) throw badRequest('A UAN has 12 digits');
  if (kind === 'pf') return normalPf(v);
  const shapes: Record<string, [RegExp, string]> = {
    pan: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN looks like AASFH6805J'],
    tan: [/^[A-Z]{4}[0-9]{5}[A-Z]$/, 'A TAN looks like DELH12345A'],
    gst: [/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a GSTIN'],
    udyam: [/^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/, 'A Udyam number looks like UDYAM-UP-28-0012345'],
    startup_india: [/^DIPP\d{3,7}$/, 'A DPIIT recognition number looks like DIPP123456'],
    din: [/^\d{8}$/, 'A DIN has 8 digits'],
  };
  const s = shapes[kind];
  if (s && !s[0].test(v)) throw badRequest(s[1]);
  return s ? v : n.trim();
}

/** Aadhaar's last digit is a Verhoeff check digit. */
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeffOk(num: string) {
  let c = 0;
  const d = num.split('').reverse().map(Number);
  for (let i = 0; i < d.length; i++) c = VD[c]![VP[i % 8]![d[i]!]!]!;
  return c === 0;
}

/**
 * A PF (EPF member) number: region (2 letters), office (3), establishment (up to 7 digits), extension
 * (up to 3) and member (up to 7), e.g. MH/BAN/0012345/000/0001234. Kept with slashes.
 */
export function normalPf(raw: string) {
  const v = raw.toUpperCase().replace(/[\s-]/g, '');
  const m = /^([A-Z]{2})\/?([A-Z]{3})\/?(\d{1,7})\/?(?:(\d{1,3})\/)?(\d{1,7})$/.exec(v) ?? /^([A-Z]{2})([A-Z]{3})(\d{7})(\d{3})(\d{7})$/.exec(v);
  if (!m) throw badRequest('A PF number looks like MH/BAN/0012345/000/0001234');
  return [m[1], m[2], m[3], m[4] ?? '000', m[5]].join('/');
}

export async function updateDocument(ctx: RecordCtx, env: Env, id: string, input: z.infer<typeof docUpdateSchema>) {
  const owner = await ownerOf(ctx, id);
  await assertOwnerAccess(ctx, owner);
  if (!(owner.personId || owner.userId ? PERSON_DOCS : COMPANY_DOCS).some((k) => k[0] === input.kind)) throw badRequest('Unknown kind of document');
  if (input.kind === 'other' && !input.label) throw badRequest('Name the document');
  const number = checkNumber(input.kind, input.number);
  if (input.issuedOn && input.validUntil && input.validUntil < input.issuedOn) throw badRequest('It cannot expire before it was issued');
  await ctx.tx.query(
    `update org_documents set kind = $3, label = $4, number = $5, issued_on = $6, valid_until = $7, notes = $8, updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, input.kind, input.label, number, input.issuedOn, input.validUntil, input.notes],
  );
  return one(ctx, env, id);
}

async function dropFile(ctx: RecordCtx, env: Env, fileId: string | null) {
  if (!fileId) return;
  const f = await ctx.tx.one<{ storage_key: string }>(`update files set deleted_at = now() where tenant_id = $1 and id = $2 and deleted_at is null returning storage_key`, [ctx.tenantId, fileId]);
  if (f?.storage_key && env.FILES) await env.FILES.delete(f.storage_key).catch(() => undefined);
}

/** Attaches (or replaces) the copy of a document. */
export async function attachFile(ctx: RecordCtx, env: Env, id: string, name: string, bytes: Uint8Array) {
  await assertOwnerAccess(ctx, await ownerOf(ctx, id));
  const cur = await ctx.tx.one<{ file_id: string | null }>(`select file_id from org_documents where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!cur) throw notFound('No such document');
  const f = await saveFile(ctx, env, { objectKey: 'organisation', recordId: id, name: name || 'document', bytes, kind: 'document' }, { system: true });
  await ctx.tx.query(`update org_documents set file_id = $3, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, f.id]);
  await dropFile(ctx, env, cur.file_id);
  return one(ctx, env, id);
}

export async function removeFile(ctx: RecordCtx, env: Env, id: string) {
  await assertOwnerAccess(ctx, await ownerOf(ctx, id));
  const cur = await ctx.tx.one<{ file_id: string | null }>(`select file_id from org_documents where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!cur) throw notFound('No such document');
  await ctx.tx.query(`update org_documents set file_id = null, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  await dropFile(ctx, env, cur.file_id);
  return one(ctx, env, id);
}

export async function deleteDocument(ctx: RecordCtx, env: Env, id: string) {
  await assertOwnerAccess(ctx, await ownerOf(ctx, id));
  const cur = await ctx.tx.one<{ file_id: string | null }>(`delete from org_documents where tenant_id = $1 and id = $2 returning file_id`, [ctx.tenantId, id]);
  if (!cur) throw notFound('No such document');
  await dropFile(ctx, env, cur.file_id);
  return { ok: true };
}
