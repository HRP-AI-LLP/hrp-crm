/**
 * Identity and statutory numbers of a person the business onboards — a partner / director (acct_persons)
 * or a team member (users): PAN, Aadhaar, UAN and the PF member number, next to the copies kept as
 * documents (org-documents.ts).
 *
 * Aadhaar is stored encrypted (AES-GCM, bound to the workspace) and only its last four digits are ever
 * shown; to change it the full number is typed again. A partner's PAN stays on acct_persons, where the
 * books and the profile read it.
 */
import { z } from 'zod';
import { decryptSecret, encryptSecret } from '../lib/crypto';
import { badRequest, notFound } from '../lib/errors';
import type { Env } from '../env';
import { requireEncryptionKey } from './ai/tenant-providers';
import { assertOwnerAccess, documentsOf, normalPf, verhoeffOk, type Owner } from './org-documents';
import type { RecordCtx } from './records';

export const identitySchema = z.object({
  pan: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'A PAN looks like ABCDE1234F')]).nullish(),
  // undefined / null: keep what is stored; '': remove it; 12 digits: replace it
  aadhaar: z
    .union([z.literal(''), z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^[2-9]\d{11}$/, 'Aadhaar has 12 digits and does not start with 0 or 1'))])
    .nullish(),
  uan: z.union([z.literal(''), z.string().trim().transform((v) => v.replace(/\s/g, '')).pipe(z.string().regex(/^\d{12}$/, 'A UAN has 12 digits'))]).nullish(),
  pfNumber: z.string().trim().max(40).nullish(),
});

export type Subject = 'partner' | 'user';

async function owner(ctx: RecordCtx, subject: Subject, id: string): Promise<Owner & { name: string; pan: string | null }> {
  if (subject === 'partner') {
    const p = await ctx.tx.one<{ name: string; pan: string | null }>(`select name, pan from acct_persons where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (!p) throw notFound('No such partner or director');
    return { personId: id, name: p.name, pan: p.pan };
  }
  const u = await ctx.tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!u) throw notFound('No such team member');
  return { userId: id, name: u.full_name, pan: null };
}

interface Row {
  pan: string | null;
  aadhaar_last4: string | null;
  uan: string | null;
  pf_number: string | null;
  updated_at: string;
}

async function row(ctx: RecordCtx, o: Owner) {
  return o.userId
    ? ctx.tx.one<Row>(`select pan, aadhaar_last4, uan, pf_number, updated_at from person_identity where tenant_id = $1 and user_id = $2`, [ctx.tenantId, o.userId])
    : ctx.tx.one<Row>(`select pan, aadhaar_last4, uan, pf_number, updated_at from person_identity where tenant_id = $1 and person_id = $2`, [ctx.tenantId, o.personId]);
}

export async function getIdentity(ctx: RecordCtx, env: Env, subject: Subject, id: string) {
  const o = await owner(ctx, subject, id);
  await assertOwnerAccess(ctx, o);
  const r = await row(ctx, o);
  return {
    subject,
    id,
    name: o.name,
    pan: (subject === 'partner' ? o.pan : r?.pan) ?? '',
    aadhaar: r?.aadhaar_last4 ? `XXXX XXXX ${r.aadhaar_last4}` : '',
    hasAadhaar: !!r?.aadhaar_last4,
    uan: r?.uan ?? '',
    pfNumber: r?.pf_number ?? '',
    updatedAt: r?.updated_at ?? null,
    documents: await documentsOf(ctx, env, o),
  };
}

export async function saveIdentity(ctx: RecordCtx, env: Env, subject: Subject, id: string, input: z.infer<typeof identitySchema>) {
  const o = await owner(ctx, subject, id);
  await assertOwnerAccess(ctx, o);
  if (input.aadhaar && !verhoeffOk(input.aadhaar)) throw badRequest('This Aadhaar number has a typing mistake (its check digit does not match)');
  const pf = input.pfNumber ? normalPf(input.pfNumber) : input.pfNumber === '' ? null : undefined;
  let aadhaarEnc: string | null | undefined;
  let last4: string | null | undefined;
  if (input.aadhaar) {
    aadhaarEnc = await encryptSecret(requireEncryptionKey(env), input.aadhaar, ctx.tenantId);
    last4 = input.aadhaar.slice(-4);
  } else if (input.aadhaar === '') {
    aadhaarEnc = null;
    last4 = null;
  }
  const pan = input.pan === undefined || input.pan === null ? undefined : input.pan || null;
  if (subject === 'partner' && pan !== undefined) await ctx.tx.query(`update acct_persons set pan = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, pan]);
  const cur = await row(ctx, o);
  const next = {
    pan: subject === 'user' ? (pan !== undefined ? pan : (cur?.pan ?? null)) : null,
    uan: input.uan === undefined || input.uan === null ? (cur?.uan ?? null) : input.uan || null,
    pf: pf !== undefined ? pf : (cur?.pf_number ?? null),
  };
  const col = o.userId ? 'user_id' : 'person_id';
  await ctx.tx.query(
    `insert into person_identity (tenant_id, ${col}, pan, uan, pf_number, aadhaar_enc, aadhaar_last4)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, ${col}) do update set pan = excluded.pan, uan = excluded.uan, pf_number = excluded.pf_number,
       aadhaar_enc = case when $8 then excluded.aadhaar_enc else person_identity.aadhaar_enc end,
       aadhaar_last4 = case when $8 then excluded.aadhaar_last4 else person_identity.aadhaar_last4 end,
       updated_by = app.current_user_id(), updated_at = now()`,
    [ctx.tenantId, id, next.pan, next.uan, next.pf, aadhaarEnc ?? null, last4 ?? null, aadhaarEnc !== undefined],
  );
  return getIdentity(ctx, env, subject, id);
}

/** The full Aadhaar number, for the rare form that needs it; every look is written to the audit log. */
export async function revealAadhaar(ctx: RecordCtx, env: Env, subject: Subject, id: string) {
  const o = await owner(ctx, subject, id);
  await assertOwnerAccess(ctx, o);
  const r = o.userId
    ? await ctx.tx.one<{ aadhaar_enc: string | null }>(`select aadhaar_enc from person_identity where tenant_id = $1 and user_id = $2`, [ctx.tenantId, o.userId])
    : await ctx.tx.one<{ aadhaar_enc: string | null }>(`select aadhaar_enc from person_identity where tenant_id = $1 and person_id = $2`, [ctx.tenantId, o.personId]);
  if (!r?.aadhaar_enc) throw notFound('No Aadhaar number is stored');
  const v = await decryptSecret(requireEncryptionKey(env), r.aadhaar_enc, ctx.tenantId);
  await ctx.tx.query(`insert into audit_logs (tenant_id, action, object_key, record_id, changes) values ($1, 'reveal', 'person_identity', $2, $3)`, [ctx.tenantId, id, JSON.stringify({ field: 'aadhaar', subject })]);
  return { aadhaar: `${v.slice(0, 4)} ${v.slice(4, 8)} ${v.slice(8)}` };
}
