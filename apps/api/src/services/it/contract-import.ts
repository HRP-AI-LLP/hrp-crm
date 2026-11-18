/**
 * Contracts the business already has with its clients: NDA, MSA, SoW, AMC, service agreements, POs.
 * The files are uploaded and read (rules, then the AI model when one is set up); the person checks what
 * was read, and saving creates the contract (dates, value, currency, billing, notice, renewal), the client
 * when new, the project for a SoW with its milestones, links a SoW to its MSA, and keeps the documents.
 * Billing starts from the next period: periods already invoiced elsewhere are not invoiced again.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { badRequest, notFound } from '../../lib/errors';
import { jsonSafe } from '../../lib/json-safe';
import type { AiCtx } from '../ai/features';
import { saveFile, signedFileUrl } from '../files';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';
import { addMonths, assertManager, assertReader, MONTHS, today } from './common';
import { aiReadContract, type ContractRead, docText, readContract } from './contract-read';
import { periodOf, saveContract } from './contracts';

const MAX_FILE = 15 * 1024 * 1024;
export const uploadSchema = z.object({ files: z.array(z.object({ name: z.string().trim().min(1).max(200), data: z.string().max(21_000_000) })).min(1).max(10) });

const bytesOf = (b64: string) => {
  const bin = atob(b64.replace(/^data:[^,]+,/, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (out.length > MAX_FILE) throw badRequest('Files can be at most 15 MB');
  return out;
};

const norm = (s: string) => s.toLowerCase().replace(/&/g, ' and ').replace(/\b(pvt|private|ltd|limited|llp|inc|llc|co|company|the|m\/s)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/** Reads the uploaded contracts (nothing is saved yet) and finds the client, its deals, projects and MSAs. */
export async function readUploaded(deps: { run<T>(fn: (ctx: RecordCtx) => Promise<T>): Promise<T>; ai: AiCtx | null }, input: z.infer<typeof uploadSchema>) {
  const own = await deps.run(async (ctx) => {
    assertManager(ctx, 'contracts');
    const t = await ctx.tx.one<{ n: string; l: string | null; tr: string | null }>(`select name as n, settings -> 'company' ->> 'legalName' as l, settings -> 'company' ->> 'tradeName' as tr from tenants where id = $1`, [ctx.tenantId]);
    return [t?.l, t?.tr, t?.n].filter((x): x is string => !!x);
  });
  const docs: { name: string; read: ContractRead | null; note: string | null; excerpt: string | null }[] = [];
  for (const f of input.files) {
    const text = await docText(f.name, bytesOf(f.data)).catch(() => null);
    if (!text) {
      docs.push({ name: f.name, read: null, note: 'No text could be read (a scan, or an old .doc): fill in the details', excerpt: null });
      continue;
    }
    let read = readContract(text, own);
    let note: string | null = null;
    if (deps.ai)
      try {
        read = await aiReadContract(deps.ai, text, own, read);
      } catch (e) {
        note = `Read by rules only (the AI model was not available: ${(e as Error).message.slice(0, 120)})`;
      }
    docs.push({ name: f.name, read, note, excerpt: text.slice(0, 1500) });
  }
  // the client: by name among the customers
  const client = docs.map((d) => d.read?.client).find(Boolean) ?? null;
  return deps.run(async (ctx) => {
    let account: { id: string; name: string } | null = null;
    if (client) {
      const all = await ctx.tx.query<{ id: string; name: string }>(`select id, name from accounts where tenant_id = $1 and deleted_at is null`, [ctx.tenantId]);
      const want = norm(client);
      account = all.find((a) => norm(a.name) === want) ?? all.find((a) => want.length >= 4 && (norm(a.name).includes(want) || want.includes(norm(a.name))) && norm(a.name).length >= 4) ?? null;
    }
    const related = account
      ? {
          deals: await ctx.tx.query(`select id, name from deals where tenant_id = $1 and account_id = $2 and deleted_at is null order by updated_at desc limit 50`, [ctx.tenantId, account.id]),
          projects: await ctx.tx.query(`select id, name from projects where tenant_id = $1 and account_id = $2 and deleted_at is null order by updated_at desc limit 50`, [ctx.tenantId, account.id]),
          contracts: await ctx.tx.query(`select id, contract_number, name, kind, doc_type, client_ref from service_contracts where tenant_id = $1 and account_id = $2 order by start_date desc limit 50`, [ctx.tenantId, account.id]),
        }
      : { deals: [], projects: [], contracts: [] };
    return { docs, client, account, ...related };
  });
}

export const saveSchema = z.object({
  files: uploadSchema.shape.files,
  accountId: z.string().uuid().nullish(),
  newAccountName: z.string().trim().min(2).max(200).nullish(),
  name: z.string().trim().min(1).max(200),
  docType: z.enum(['nda', 'msa', 'sow', 'agreement', 'amendment', 'purchase_order', 'other']),
  kind: z.enum(['retainer', 'amc', 'time_materials', 'fixed_bid', 'support', 'enterprise_licence', 'nda', 'msa', 'other']),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  signedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  value: z.number().min(0).max(1e12).nullish(),
  billingFrequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'yearly', 'milestone', 'one_time', 'none']),
  periodFee: z.number().min(0).max(1e12).nullish(),
  hourlyRate: z.number().min(0).max(1e9).nullish(),
  hoursPerPeriod: z.number().min(0).max(100000).nullish(),
  paymentTermsDays: z.number().int().min(0).max(365).nullish(),
  noticeDays: z.number().int().min(0).max(730).nullish(),
  autoRenew: z.boolean().default(false),
  governingLaw: z.string().trim().max(200).nullish(),
  clientRef: z.string().trim().max(120).nullish(),
  summary: z.string().max(4000).nullish(),
  parentId: z.string().uuid().nullish(),
  projectId: z.string().uuid().nullish(),
  /** a new project for this SoW (with its milestones) */
  newProject: z.boolean().default(false),
  milestones: z.array(z.object({ name: z.string().trim().min(1).max(200), amount: z.number().min(0).nullish(), due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish() })).max(50).default([]),
  /** the first period this system bills (earlier ones were billed elsewhere); default: the next period */
  billFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  taxRate: z.number().min(0).max(100).default(18),
  hsnSac: z.string().trim().max(10).nullish(),
  extracted: z.record(z.string(), z.unknown()).optional(),
});

/** Saves an existing contract: the client, the project and milestones, the contract and its documents. */
export async function saveUploaded(ctx: RecordCtx, env: Env, input: z.infer<typeof saveSchema>) {
  assertManager(ctx, 'contracts');
  const events: RecordEvent[] = [];
  let accountId = input.accountId ?? null;
  if (!accountId) {
    if (!input.newAccountName) throw badRequest('Choose the client, or name the new one');
    const a = await createRecord(ctx, 'account', { name: input.newAccountName });
    accountId = String(a.record.id);
    events.push(...a.events);
  } else if (!(await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, accountId]))) throw notFound('Client not found');
  if (input.parentId && !(await ctx.tx.one(`select 1 from service_contracts where tenant_id = $1 and id = $2 and account_id = $3`, [ctx.tenantId, input.parentId, accountId])))
    throw badRequest('The MSA must be one of this client’s contracts');
  // the project of a SoW, with its milestones
  let projectId = input.projectId ?? null;
  if (!projectId && input.newProject) {
    const p = await createRecord(ctx, 'project', {
      name: input.name.slice(0, 200),
      account_id: accountId,
      start_date: input.startDate,
      end_date: input.endDate ?? null,
      currency: input.currency,
      billing_method: input.kind === 'time_materials' ? 'time_project_rate' : 'fixed_price',
      project_rate: input.kind === 'time_materials' ? (input.hourlyRate ?? null) : null,
      fixed_fee: input.kind === 'time_materials' ? null : (input.value ?? null),
      customer_ref: input.clientRef ?? null,
      customer_ref_date: input.signedOn ?? input.startDate,
      description: input.summary ?? null,
    });
    projectId = String(p.record.id);
    events.push(...p.events);
    let pos = 0;
    for (const m of input.milestones)
      await ctx.tx.query(`insert into project_milestones (tenant_id, project_id, name, due_date, amount, position) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, projectId, m.name, m.due ?? null, m.amount ?? null, pos++]);
  }
  const billed = input.billingFrequency !== 'none' && !['nda', 'msa', 'other'].includes(input.kind);
  const saved = await saveContract(ctx, null, {
    name: input.name,
    accountId,
    projectId,
    kind: input.kind as never,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    value: input.value ?? 0,
    billingFrequency: (billed ? input.billingFrequency : 'none') as never,
    periodFee: billed ? (input.periodFee ?? null) : null,
    hoursPerPeriod: input.hoursPerPeriod ?? null,
    overageRate: input.kind === 'time_materials' || input.hoursPerPeriod ? (input.hourlyRate ?? null) : null,
    autoRenew: input.autoRenew,
    renewalNoticeDays: Math.min(365, input.noticeDays ?? 30),
    taxRate: input.taxRate,
    hsnSac: input.hsnSac ?? null,
    terms: input.summary ?? null,
  });
  const id = saved.id;
  // where it stands today, and the first period billed here
  const now = today();
  const status = input.endDate && input.endDate < now ? 'expired' : input.startDate > now ? 'draft' : 'active';
  let next: string | null = null;
  if (status === 'active' && billed && MONTHS[input.billingFrequency]) {
    if (input.billFrom) next = input.billFrom;
    else {
      const p = periodOf({ start_date: input.startDate, billing_frequency: input.billingFrequency, end_date: input.endDate ?? null }, now);
      // the current period was billed elsewhere (Zoho, by hand): this system bills from the next one
      next = addMonths(p.start, MONTHS[input.billingFrequency]!);
      if (input.endDate && next > input.endDate) next = null;
    }
  }
  await ctx.tx.query(
    `update service_contracts set status = $3, next_invoice_date = $4, doc_type = $5, parent_id = $6, currency = $7, signed_on = $8, client_ref = $9, governing_law = $10,
            payment_terms_days = $11, notice_days = $12, source = 'uploaded', summary = $13, extracted = $14::jsonb, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [
      ctx.tenantId, id, status, next, input.docType, input.parentId ?? null, input.currency, input.signedOn ?? null, input.clientRef ?? null, input.governingLaw ?? null,
      input.paymentTermsDays ?? null, input.noticeDays ?? null, input.summary ?? null, jsonSafe(input.extracted ?? {}),
    ],
  );
  // the documents, kept with the contract
  const files: string[] = [];
  if (env.FILES)
    for (const f of input.files) {
      const r = await saveFile(ctx, env, { objectKey: 'service_contract', recordId: id, name: f.name, bytes: bytesOf(f.data), kind: 'document', description: `${input.docType.toUpperCase()} — ${input.name}`.slice(0, 200) }, { system: true });
      files.push(r.id);
    }
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'account',$3)`, [
    ctx.tenantId, `Contract added from the signed copy: ${input.name}${input.clientRef ? ` (${input.clientRef})` : ''}`.slice(0, 300), accountId,
  ]);
  return { id, number: saved.number, status, accountId, projectId, nextInvoiceDate: next, files: files.length, events };
}

/** The documents kept with a contract. */
export async function contractFiles(ctx: RecordCtx, env: Env, id: string) {
  assertReader(ctx);
  const rows = await ctx.tx.query<{ id: string; name: string; size_bytes: number; created_at: string }>(
    `select id, name, size_bytes, created_at from files where tenant_id = $1 and object_key = 'service_contract' and record_id = $2 and deleted_at is null order by created_at`,
    [ctx.tenantId, id],
  );
  return Promise.all(rows.map(async (f) => ({ ...f, url: await signedFileUrl(env, ctx.tenantId, f.id, true) })));
}
