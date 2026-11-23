/**
 * A milestone's money: the invoice raised for it and the money received against that invoice.
 *
 * Invoices are often raised before (or outside) the project's "Create draft invoice" button, so
 * SanchalanOS looks for them: invoices of the project or its customer whose value matches the
 * milestone, or whose number appears in the milestone's kept mail thread ("Submission of Invoice
 * INV-2026000008 for 30% Milestone Payment"). If the invoice is only a PDF in that thread, it can be
 * imported. Then the money: open receipts of the customer and bank credits not yet booked, the
 * closest to the balance first (government buyers deduct TDS: the gap is offered as TDS). Nothing is
 * linked or booked until someone approves it, and any other receipts or bank lines can be added.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { z } from 'zod';
import type { Env } from '../env';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { allocatePayment } from './billing';
import { bookReceiptFromBank } from './books/desk';
import { projectAccess } from './projects';
import type { RecordCtx, RecordEvent } from './records';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const near = (a: number, b: number, pct = 0.01) => b > 0 && Math.abs(a - b) <= Math.max(1, b * pct);

export type Inv = {
  id: string;
  invoice_number: string | null;
  invoice_date: string;
  status: string;
  account_id: string | null;
  account: string | null;
  project_id: string | null;
  taxable_total: number;
  grand_total: number;
  amount_paid: number;
  balance_due: number;
  milestone: string | null;
  lines: string | null;
};

export const INV_COLS = `i.id, i.invoice_number, i.invoice_date::text as invoice_date, i.status, i.account_id, a.name as account, i.project_id,
  i.taxable_total::float8 as taxable_total, i.grand_total::float8 as grand_total, i.amount_paid::float8 as amount_paid, i.balance_due::float8 as balance_due,
  (select m.name from project_milestones m where m.tenant_id = i.tenant_id and m.invoice_id = i.id limit 1) as milestone,
  (select string_agg(l.name, ' · ') from invoice_lines l where l.tenant_id = i.tenant_id and l.order_id = i.id) as lines`;

async function load(ctx: RecordCtx, projectId: string, milestoneId: string) {
  const { project } = await projectAccess(ctx, projectId, 'manage');
  if (objectPerm(ctx.principal.permissions, 'invoice').read === 'none') throw forbidden('You cannot see invoices');
  const ms = await ctx.tx.one<{ id: string; name: string; amount: number | null; invoice_id: string | null; due_date: string | null }>(
    `select id, name, amount::float8 as amount, invoice_id, due_date::text as due_date from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`,
    [ctx.tenantId, milestoneId, projectId],
  );
  if (!ms) throw notFound('Milestone not found');
  return { project, ms };
}

async function invoiceRow(ctx: RecordCtx, id: string) {
  return ctx.tx.one<Inv>(`select ${INV_COLS} from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id where i.tenant_id = $1 and i.id = $2 and i.deleted_at is null`, [ctx.tenantId, id]);
}

/** The words of the milestone's kept emails (subjects and bodies), where invoice numbers are named. */
export async function mailText(ctx: RecordCtx, projectId: string, milestoneId: string) {
  const rows = await ctx.tx.query<{ t: string }>(
    `select coalesce(a.subject, '') || ' ' || left(coalesce(a.body, ''), 20000) as t from activities a
      where a.tenant_id = $1 and a.related_object = 'project' and a.related_id = $2 and (a.metadata ->> 'milestoneId' = $3
         or a.id in (select activity_id from milestone_attachments where tenant_id = $1 and milestone_id = $4::uuid))
      limit 50`,
    [ctx.tenantId, projectId, milestoneId, milestoneId],
  );
  return rows.map((r) => r.t).join('\n');
}

/** Invoices that may be the milestone's: named in its emails, on the project or its customer, worth its amount. */
export async function invoiceCandidates(ctx: RecordCtx, projectId: string, accountId: string | null, ms: { name: string; amount: number | null }, words: string) {
  const amount = Number(ms.amount ?? 0);
  const rows = await ctx.tx.query<Inv>(
    `select ${INV_COLS} from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status <> 'cancelled'
        and not exists (select 1 from project_milestones m where m.tenant_id = i.tenant_id and m.invoice_id = i.id)
        and (i.project_id = $2 or ($3::uuid is not null and i.account_id = $3) or i.invoice_date >= current_date - 400)
      order by i.invoice_date desc limit 400`,
    [ctx.tenantId, projectId, accountId],
  );
  return rows
    .map((r) => {
      const reasons: string[] = [];
      let score = 0;
      const named = !!r.invoice_number && squash(r.invoice_number).length >= 4 && words.includes(squash(r.invoice_number));
      if (named) (score += 6), reasons.push('its number is in the milestone’s emails');
      if (r.project_id === projectId) (score += 2), reasons.push('on this project');
      if (accountId && r.account_id === accountId) (score += 1), reasons.push('the project’s customer');
      if (amount && near(r.taxable_total, amount)) (score += 5), reasons.push('value before GST equals the milestone amount');
      else if (amount && near(r.grand_total, amount)) (score += 4), reasons.push('total equals the milestone amount');
      if (r.lines && (squash(r.lines).includes(squash(ms.name)) || /milestone/i.test(r.lines))) (score += 1), reasons.push('mentions the milestone');
      return { ...r, score, reasons };
    })
    // a matching value alone, from another customer, is not enough
    .filter((r) => r.score >= 6 || (r.score >= 5 && (r.project_id === projectId || r.account_id === accountId)))
    .sort((a, b) => b.score - a.score || b.invoice_date.localeCompare(a.invoice_date))
    .slice(0, 6);
}

/** What the milestone has, and what may be its invoice and its money. */
export async function milestoneBilling(ctx: RecordCtx, projectId: string, milestoneId: string, opts: { q?: string | null } = {}) {
  const { project, ms } = await load(ctx, projectId, milestoneId);
  const amount = Number(ms.amount ?? 0);
  const invoice = ms.invoice_id ? await invoiceRow(ctx, ms.invoice_id) : null;
  const text = await mailText(ctx, projectId, milestoneId);
  const words = squash(text);

  const candidates = invoice ? [] : await invoiceCandidates(ctx, projectId, project.account_id ?? null, ms, words);

  // invoices only as PDFs in the milestone's kept mail: offered for import when none is in the books
  const pdfs =
    !invoice && !candidates.some((c) => c.score >= 6)
      ? await ctx.tx.query<{ file_id: string; name: string }>(
          `select f.id as file_id, f.name from milestone_attachments x join files f on f.tenant_id = x.tenant_id and f.id = x.file_id
            where x.tenant_id = $1 and x.milestone_id = $2 and x.kind = 'attachment' and f.content_type = 'application/pdf' and f.name ~* '(inv|invoice|bill|tax)'
            order by x.created_at limit 10`,
          [ctx.tenantId, milestoneId],
        )
      : [];

  // the money: what is already applied, and what may be it
  const target = invoice ?? ((candidates[0]?.score ?? 0) >= 6 ? candidates[0]! : null);
  const applied = invoice
    ? await ctx.tx.query(
        `select p.id, p.payment_number as number, p.payment_date::text as date, a.amount::float8 as amount, p.reference, p.mode from payment_allocations a join payments p on p.tenant_id = a.tenant_id and p.id = a.payment_id
          where a.tenant_id = $1 and a.invoice_id = $2 and p.status = 'received' and p.deleted_at is null order by p.payment_date`,
        [ctx.tenantId, invoice.id],
      )
    : [];
  const money = target ? await moneyCandidates(ctx, target, opts.q ?? null) : { receipts: [], bankLines: [] };
  const books = hasAdmin(ctx.principal.permissions, 'books') || ctx.principal.user.isOwner;
  return {
    milestone: { id: ms.id, name: ms.name, amount, dueDate: ms.due_date },
    invoice,
    applied,
    candidates,
    best: !invoice && (candidates[0]?.score ?? 0) >= 6 ? candidates[0]!.id : null,
    pdfs,
    target: target ? { id: target.id, number: target.invoice_number, balance: target.balance_due } : null,
    ...money,
    canBook: books,
  };
}

/** Open receipts of the customer and unbooked bank credits that may pay the invoice, the likeliest first. */
export async function moneyCandidates(ctx: RecordCtx, inv: Inv, q: string | null) {
  const balance = inv.balance_due;
  const words = q?.trim() ? `%${q.trim().replace(/[%_]/g, '')}%` : null;
  const amt = q && /^\s*[\d,]+(\.\d+)?\s*$/.test(q) ? Number(q.replace(/,/g, '')) : null;
  const receipts = inv.account_id
    ? await ctx.tx.query<{ id: string; number: string | null; date: string; unallocated: number; reference: string | null; amount: number }>(
        `select id, payment_number as number, payment_date::text as date, unallocated::float8 as unallocated, amount::float8 as amount, reference from payments
          where tenant_id = $1 and account_id = $2 and status = 'received' and deleted_at is null and unallocated > 0 order by payment_date desc limit 30`,
        [ctx.tenantId, inv.account_id],
      )
    : [];
  const lines = await ctx.tx.query<{ id: string; date: string; amount: number; description: string; reference: string | null; bank: string }>(
    `select t.id, t.txn_date::text as date, t.amount::float8 as amount, t.description, t.reference, g.name as bank
       from bank_transactions t join bank_accounts b on b.tenant_id = t.tenant_id and b.id = t.bank_account_id join gl_accounts g on g.tenant_id = b.tenant_id and g.id = b.gl_account_id
      where t.tenant_id = $1 and t.status = 'unmatched' and t.amount > 0 and t.txn_date >= $2::date - 15
        and ($3::text is null or t.description ilike $3 or t.reference ilike $3) and ($4::numeric is null or t.amount = $4)
      order by t.txn_date limit 300`,
    [ctx.tenantId, inv.invoice_date, words && amt == null ? words : null, amt],
  );
  const name = squash(inv.account ?? '').slice(0, 12);
  const bankLines = lines
    .map((l) => {
      const reasons: string[] = [];
      let score = 0;
      let tds = 0;
      if (balance > 0 && near(l.amount, balance, 0.002)) (score += 6), reasons.push('equals the balance');
      else if (balance > 0 && l.amount < balance && balance - l.amount <= inv.taxable_total * 0.12 + 1) {
        // the buyer kept TDS (income tax 1–10 % and GST TDS 2 % of the value before GST): the gap is offered as TDS
        tds = r2(balance - l.amount);
        score += 4;
        reasons.push(`balance less ${Math.round((tds / Math.max(1, inv.taxable_total)) * 1000) / 10}% of the value (TDS?)`);
      } else if (l.amount <= balance + 1) (score += 1), reasons.push('part of the balance');
      if (name.length >= 4 && squash(l.description).includes(name)) (score += 3), reasons.push('names the customer');
      if (inv.invoice_number && squash(`${l.description} ${l.reference ?? ''}`).includes(squash(inv.invoice_number))) (score += 4), reasons.push('names the invoice');
      return { ...l, score, reasons, suggestedTds: tds };
    })
    .filter((l) => q || l.score >= 2)
    .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
    .slice(0, q ? 40 : 12);
  return {
    receipts: receipts.map((r) => ({ ...r, suggested: near(r.unallocated, balance) })),
    bankLines,
  };
}

/** Links an invoice to the milestone (and to the project if it was on none). */
export async function linkInvoice(ctx: RecordCtx, projectId: string, milestoneId: string, invoiceId: string) {
  const { ms } = await load(ctx, projectId, milestoneId);
  if (ms.invoice_id && ms.invoice_id !== invoiceId) throw conflict('This milestone already has an invoice; unlink it first');
  const inv = await invoiceRow(ctx, invoiceId);
  if (!inv || inv.status === 'cancelled') throw notFound('Invoice not found');
  if (inv.milestone && !ms.invoice_id) throw conflict(`That invoice is already on milestone “${inv.milestone}”`);
  if (inv.project_id && inv.project_id !== projectId) throw conflict('That invoice belongs to another project');
  await ctx.tx.query(`update project_milestones set invoice_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, milestoneId, invoiceId]);
  await ctx.tx.query(`update invoices set project_id = $3 where tenant_id = $1 and id = $2 and project_id is null`, [ctx.tenantId, invoiceId, projectId]);
  // the lines of an issued invoice are frozen; the invoice itself carries the project
  if (inv.status === 'draft') await ctx.tx.query(`update invoice_lines set project_id = $3 where tenant_id = $1 and order_id = $2 and project_id is null`, [ctx.tenantId, invoiceId, projectId]);
  return { ok: true };
}

export async function unlinkInvoice(ctx: RecordCtx, projectId: string, milestoneId: string) {
  await load(ctx, projectId, milestoneId);
  await ctx.tx.query(`update project_milestones set invoice_id = null where tenant_id = $1 and id = $2`, [ctx.tenantId, milestoneId]);
  return { ok: true };
}

export const mapSchema = z.object({
  items: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('receipt'), id: z.string().uuid(), amount: z.number().positive().max(1e12).nullish() }),
        z.object({ kind: z.literal('bank'), id: z.string().uuid(), tdsAmount: z.number().min(0).max(1e12).nullish() }),
      ]),
    )
    .min(1)
    .max(50),
});

/** Applies chosen receipts and books chosen bank credits against the milestone's invoice, one by one. */
export async function mapMoney(ctx: RecordCtx, projectId: string, milestoneId: string, input: z.infer<typeof mapSchema>) {
  const { ms } = await load(ctx, projectId, milestoneId);
  if (!ms.invoice_id) throw badRequest('Link the invoice first');
  const events: RecordEvent[] = [];
  const results: { kind: string; id: string; ok: boolean; error?: string }[] = [];
  for (const it of input.items) {
    const inv = await invoiceRow(ctx, ms.invoice_id);
    if (!inv || inv.balance_due <= 0) {
      results.push({ kind: it.kind, id: it.id, ok: false, error: 'The invoice is already fully paid' });
      continue;
    }
    try {
      await ctx.tx.query('savepoint map_one');
      if (it.kind === 'receipt') {
        const p = await ctx.tx.one<{ unallocated: number; account_id: string | null }>(`select unallocated::float8 as unallocated, account_id from payments where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, it.id]);
        if (!p) throw notFound('Receipt not found');
        if (inv.account_id && p.account_id !== inv.account_id) throw badRequest('That receipt is from another customer');
        const a = r2(Math.min(it.amount ?? p.unallocated, p.unallocated, inv.balance_due));
        if (a <= 0) throw badRequest('Nothing left on that receipt');
        events.push(...(await allocatePayment(ctx, it.id, [{ invoiceId: inv.id, amount: a }])));
        await ctx.tx.query(`update payments set project_id = coalesce(project_id, $3) where tenant_id = $1 and id = $2`, [ctx.tenantId, it.id, projectId]);
      } else {
        if (!hasAdmin(ctx.principal.permissions, 'books') && !ctx.principal.user.isOwner) throw forbidden('Booking bank lines needs the books permission');
        const r = await bookReceiptFromBank(ctx, it.id, inv.id, it.tdsAmount ?? 0);
        events.push(...r.events);
        const pid = (r.result as { paymentId?: string }).paymentId;
        if (pid) await ctx.tx.query(`update payments set project_id = coalesce(project_id, $3) where tenant_id = $1 and id = $2`, [ctx.tenantId, pid, projectId]);
      }
      await ctx.tx.query('release savepoint map_one');
      results.push({ kind: it.kind, id: it.id, ok: true });
    } catch (e) {
      await ctx.tx.query('rollback to savepoint map_one');
      results.push({ kind: it.kind, id: it.id, ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }
  return { results, events, invoice: await invoiceRow(ctx, ms.invoice_id) };
}

/** Reads an invoice PDF kept in the milestone's mail (our own invoice to the customer) into the books' import queue. */
export async function pdfForImport(ctx: RecordCtx, env: Env, projectId: string, milestoneId: string, fileId: string) {
  await load(ctx, projectId, milestoneId);
  const f = await ctx.tx.one<{ storage_key: string; name: string }>(
    `select f.storage_key, f.name from milestone_attachments x join files f on f.tenant_id = x.tenant_id and f.id = x.file_id where x.tenant_id = $1 and x.milestone_id = $2 and f.id = $3`,
    [ctx.tenantId, milestoneId, fileId],
  );
  if (!f) throw notFound('That file is not on the milestone');
  const obj = env.FILES ? await env.FILES.get(f.storage_key) : null;
  if (!obj) throw notFound('The file is not in storage');
  const bytes = new Uint8Array(await obj.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { fileName: f.name, pdf: btoa(bin) };
}
