/**
 * Quotes: line items, GST-aware totals, numbering, public share links and customer acceptance.
 * The quote header is a normal metadata object (lists, views, fields, rules, automations);
 * line items and totals are maintained here.
 */
import { objectPerm, type RecordDto } from '@synapse/shared';
import { z } from 'zod';
import { randomToken } from '../lib/crypto';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { refreshParents, hasRollupParents } from './computed';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, readRowSystem, toDto, updateRecord } from './records';

export const lineSchema = z.object({
  productId: z.string().uuid().nullish(),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullish(),
  hsnSac: z.string().max(20).nullish(),
  unit: z.string().max(20).nullish(),
  quantity: z.coerce.number().positive().max(1e9),
  unitPrice: z.coerce.number().min(0).max(1e12),
  discountPct: z.coerce.number().min(0).max(100).default(0),
  taxRate: z.coerce.number().min(0).max(100).default(0),
});
export type LineInput = z.infer<typeof lineSchema>;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function computeLines(lines: LineInput[]) {
  let subtotal = 0;
  let discount = 0;
  let tax = 0;
  const out = lines.map((l, i) => {
    const gross = r2(l.quantity * l.unitPrice);
    const disc = r2((gross * l.discountPct) / 100);
    const net = r2(gross - disc);
    const lineTax = r2((net * l.taxRate) / 100);
    subtotal += gross;
    discount += disc;
    tax += lineTax;
    return { ...l, position: i + 1, lineSubtotal: net, lineTax, lineTotal: r2(net + lineTax) };
  });
  subtotal = r2(subtotal);
  discount = r2(discount);
  tax = r2(tax);
  return { lines: out, subtotal, discountTotal: discount, taxTotal: tax, grandTotal: r2(subtotal - discount + tax) };
}

interface LineRow {
  id: string;
  position: number;
  product_id: string | null;
  name: string;
  description: string | null;
  hsn_sac: string | null;
  unit: string | null;
  quantity: string;
  unit_price: string;
  discount_pct: string;
  tax_rate: string;
  line_subtotal: string;
  line_tax: string;
  line_total: string;
}

const lineDto = (l: LineRow) => ({
  id: l.id,
  position: l.position,
  productId: l.product_id,
  name: l.name,
  description: l.description,
  hsnSac: l.hsn_sac,
  unit: l.unit,
  quantity: Number(l.quantity),
  unitPrice: Number(l.unit_price),
  discountPct: Number(l.discount_pct),
  taxRate: Number(l.tax_rate),
  lineSubtotal: Number(l.line_subtotal),
  lineTax: Number(l.line_tax),
  lineTotal: Number(l.line_total),
});

async function lines(ctx: RecordCtx, quoteId: string) {
  return (await ctx.tx.query<LineRow>(`select * from quote_lines where tenant_id = $1 and quote_id = $2 order by position`, [ctx.tenantId, quoteId])).map(lineDto);
}

/** Company letterhead for printed quotes (workspace settings → company). */
async function letterhead(ctx: RecordCtx) {
  const t = await ctx.tx.one<{ name: string; settings: Record<string, any> }>(`select name, settings from tenants where id = $1`, [ctx.tenantId]);
  const c = (t?.settings?.company ?? {}) as Record<string, string | undefined>;
  return { name: c.legalName || t?.name || '', address: c.address ?? '', state: c.state ?? '', gstin: c.gstin ?? '', email: c.email ?? '', phone: c.phone ?? '', website: c.website ?? '', terms: c.quoteTerms ?? '' };
}

async function partyName(ctx: RecordCtx, table: 'accounts' | 'contacts', id: unknown) {
  if (!id) return null;
  const col = table === 'accounts' ? 'name' : 'full_name';
  const extra = table === 'accounts' ? ', billing_address, phone' : ', email, phone';
  return ctx.tx.one<Record<string, any>>(`select id, ${col} as name${extra} from ${table} where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
}

/** Quote + lines + parties + letterhead, for the editor and the printable view. */
export async function getQuote(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'quote', id, 'read');
  const quote = toDto(obj, row, ctx.principal.permissions);
  return {
    quote: { ...quote, price_book_id: (row.price_book_id as string | null) ?? null, bill_to: (row.bill_to as Record<string, string> | null) ?? null, share_token: (row.share_token as string | null) ?? null } as RecordDto & { price_book_id: string | null; bill_to: Record<string, string> | null; share_token: string | null },
    lines: await lines(ctx, id),
    account: await partyName(ctx, 'accounts', row.account_id),
    contact: await partyName(ctx, 'contacts', row.contact_id),
    company: await letterhead(ctx),
  };
}

/** Replaces all line items and recalculates totals. */
export async function saveLines(ctx: RecordCtx, id: string, input: LineInput[], opts: { priceBookId?: string | null; billTo?: unknown } = {}): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'quote', id, 'update', true);
  if (row.status === 'accepted') throw badRequest('Accepted quotes cannot be changed. Create a revision instead.');
  if (input.length > 200) throw badRequest('A quote can have at most 200 lines');
  const productIds = [...new Set(input.map((l) => l.productId).filter((x): x is string => !!x))];
  if (productIds.length) {
    const found = await ctx.tx.query<{ id: string }>(`select id from products where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, productIds]);
    if (found.length !== productIds.length) throw badRequest('A product on this quote no longer exists');
  }
  if (opts.priceBookId) {
    const pb = await ctx.tx.one(`select 1 from price_books where tenant_id = $1 and id = $2`, [ctx.tenantId, opts.priceBookId]);
    if (!pb) throw badRequest('Unknown price book');
  }
  const c = computeLines(input);
  await ctx.tx.query(`delete from quote_lines where tenant_id = $1 and quote_id = $2`, [ctx.tenantId, id]);
  for (const l of c.lines) {
    await ctx.tx.query(
      `insert into quote_lines (tenant_id, quote_id, position, product_id, name, description, hsn_sac, unit, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ctx.tenantId, id, l.position, l.productId ?? null, l.name, l.description ?? null, l.hsnSac ?? null, l.unit ?? null, l.quantity, l.unitPrice, l.discountPct, l.taxRate, l.lineSubtotal, l.lineTax, l.lineTotal],
    );
  }
  const updated = await ctx.tx.one<Record<string, unknown>>(
    `update quotes set subtotal = $3, discount_total = $4, tax_total = $5, grand_total = $6,
            price_book_id = case when $7::boolean then $8::uuid else price_book_id end,
            bill_to = case when $9::boolean then $10::jsonb else bill_to end
      where tenant_id = $1 and id = $2 returning *`,
    [ctx.tenantId, id, c.subtotal, c.discountTotal, c.taxTotal, c.grandTotal, opts.priceBookId !== undefined, opts.priceBookId ?? null, opts.billTo !== undefined, opts.billTo === undefined ? null : JSON.stringify(opts.billTo)],
  );
  if (hasRollupParents(ctx.meta, 'quote')) await refreshParents(ctx, 'quote', [row, updated]);
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of ['subtotal', 'discount_total', 'tax_total', 'grand_total'] as const) if (Number(row[k]) !== Number(updated![k])) changes[k] = [Number(row[k]), Number(updated![k])];
  return Object.keys(changes).length ? [{ objectKey: 'quote', recordId: id, kind: 'updated', changes }] : [];
}

/** New quote prefilled from a deal (account, contact, name, default price book). */
export async function quoteFromDeal(ctx: RecordCtx, dealId: string) {
  const { row: deal } = await loadRow(ctx, 'deal', dealId, 'read');
  const pb = await ctx.tx.one<{ id: string; currency: string }>(`select id, currency from price_books where tenant_id = $1 and is_default and is_active`, [ctx.tenantId]);
  const validUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const company = await letterhead(ctx);
  const r = await createRecord(ctx, 'quote', {
    name: String(deal.name),
    deal_id: dealId,
    account_id: deal.account_id ?? null,
    contact_id: deal.contact_id ?? null,
    valid_until: validUntil,
    currency: pb?.currency ?? deal.currency ?? 'INR',
    status: 'draft',
    ...(company.terms ? { terms: company.terms } : {}),
  });
  if (pb) await ctx.tx.query(`update quotes set price_book_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, pb.id]);
  return r;
}

/** Ensures the quote has a share link and marks it sent. */
export async function markSent(ctx: RecordCtx, id: string): Promise<{ token: string; events: RecordEvent[] }> {
  const { row } = await loadRow(ctx, 'quote', id, 'update', true);
  const n = await ctx.tx.one<{ n: string }>(`select count(*) n from quote_lines where tenant_id = $1 and quote_id = $2`, [ctx.tenantId, id]);
  if (!Number(n?.n)) throw badRequest('Add at least one line before sending the quote');
  const token = (row.share_token as string | null) ?? randomToken(24);
  if (!row.share_token) await ctx.tx.query(`update quotes set share_token = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, token]);
  let events: RecordEvent[] = [];
  if (row.status === 'draft') events = (await updateRecord(ctx, 'quote', id, { status: 'sent' })).events;
  else await ctx.tx.query(`update quotes set updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]); // keeps the public route in sync
  return { token, events };
}

/** Customer response from the public link (runs as the system for the quote's owner). */
export async function respondToQuote(ctx: RecordCtx, id: string, accept: boolean, name: string, comment: string | null): Promise<RecordEvent[]> {
  const row = await readRowSystem(ctx, 'quote', id);
  if (!row) throw notFound();
  if (row.status !== 'sent') throw badRequest(row.status === 'accepted' ? 'This quote has already been accepted' : 'This quote can no longer be answered');
  if (row.valid_until && String(row.valid_until instanceof Date ? row.valid_until.toISOString().slice(0, 10) : row.valid_until) < new Date().toISOString().slice(0, 10)) {
    await ctx.tx.query(`update quotes set status = 'expired' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    throw badRequest('This quote has expired. Please ask for a new one.');
  }
  await ctx.tx.query(`update quotes set status = $3, accepted_at = case when $4 then now() else null end, accepted_by = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, accept ? 'accepted' : 'rejected', accept, name,
  ]);
  const subject = accept ? `Quote ${row.quote_number} accepted by ${name}` : `Quote ${row.quote_number} declined by ${name}`;
  for (const [obj, rid] of [['quote', id], ['deal', row.deal_id]] as const) {
    if (!rid) continue;
    await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id) values ($1, 'system', $2, $3, 'in', $4, $5)`, [ctx.tenantId, subject, comment, obj, rid]);
  }
  if (row.owner_id) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'quote',$3,$4,$5)`, [ctx.tenantId, row.owner_id, subject, comment, `/o/quote/${id}`]);
  }
  return [{ objectKey: 'quote', recordId: id, kind: 'updated', changes: { status: ['sent', accept ? 'accepted' : 'rejected'] } }];
}

/** Copies the quote total onto its deal (amount), respecting deal edit rights. */
export async function syncDealAmount(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'quote', id, 'read');
  if (!row.deal_id) throw badRequest('This quote is not linked to a deal');
  if (objectPerm(ctx.principal.permissions, 'deal').update === 'none') throw forbidden();
  return updateRecord(ctx, 'deal', String(row.deal_id), { amount: Number(row.grand_total) });
}
