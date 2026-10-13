/**
 * Line items shared by sales orders, purchase orders and invoices (quotes keep their own module).
 * Same arithmetic as quotes: discount per line, then GST on the discounted amount.
 */
import { badRequest } from '../lib/errors';
import { hasRollupParents, refreshParents } from './computed';
import { computeLines, type LineInput } from './quotes';
import { ident, type RecordCtx, type RecordEvent } from './records';

export interface LineDoc {
  objectKey: string;
  header: string;
  table: string;
  /** extra numeric columns carried per line (delivered_qty, received_qty …) */
  extra: string[];
}

export const LINE_DOCS: Record<string, LineDoc> = {
  sales_order: { objectKey: 'sales_order', header: 'sales_orders', table: 'sales_order_lines', extra: ['reserved_qty', 'shipped_qty', 'delivered_qty', 'invoiced_qty'] },
  purchase_order: { objectKey: 'purchase_order', header: 'purchase_orders', table: 'purchase_order_lines', extra: ['received_qty', 'rejected_qty'] },
};

export interface DocLine {
  id: string;
  position: number;
  productId: string | null;
  name: string;
  description: string | null;
  hsnSac: string | null;
  unit: string | null;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
  lineSubtotal: number;
  lineTax: number;
  lineTotal: number;
  [extra: string]: unknown;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function lineDto(row: Record<string, unknown>, extra: string[]): DocLine {
  const out: DocLine = {
    id: String(row.id),
    position: Number(row.position),
    productId: (row.product_id as string | null) ?? null,
    name: String(row.name),
    description: (row.description as string | null) ?? null,
    hsnSac: (row.hsn_sac as string | null) ?? null,
    unit: (row.unit as string | null) ?? null,
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    discountPct: Number(row.discount_pct),
    taxRate: Number(row.tax_rate),
    lineSubtotal: Number(row.line_subtotal),
    lineTax: Number(row.line_tax),
    lineTotal: Number(row.line_total),
  };
  for (const e of extra) out[camel(e)] = Number(row[e] ?? 0);
  return out;
}

export async function readLines(ctx: RecordCtx, doc: LineDoc, id: string): Promise<DocLine[]> {
  const rows = await ctx.tx.query<Record<string, unknown>>(`select * from ${ident(doc.table)} where tenant_id = $1 and order_id = $2 order by position`, [ctx.tenantId, id]);
  return rows.map((r) => lineDto(r, doc.extra));
}

export async function assertProducts(ctx: RecordCtx, input: LineInput[]) {
  const ids = [...new Set(input.map((l) => l.productId).filter((x): x is string => !!x))];
  if (!ids.length) return;
  const found = await ctx.tx.query<{ id: string }>(`select id from products where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, ids]);
  if (found.length !== ids.length) throw badRequest('A product on this document no longer exists');
}

/** Replaces all lines and the header totals; returns update events for automations. */
export async function replaceLines(ctx: RecordCtx, doc: LineDoc, id: string, prior: Record<string, unknown>, input: LineInput[]): Promise<RecordEvent[]> {
  if (input.length > 300) throw badRequest('A document can have at most 300 lines');
  await assertProducts(ctx, input);
  const c = computeLines(input);
  await ctx.tx.query(`delete from ${ident(doc.table)} where tenant_id = $1 and order_id = $2`, [ctx.tenantId, id]);
  for (const l of c.lines) {
    await ctx.tx.query(
      `insert into ${ident(doc.table)} (tenant_id, order_id, position, product_id, name, description, hsn_sac, unit, quantity, unit_price, discount_pct, tax_rate, line_subtotal, line_tax, line_total)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [ctx.tenantId, id, l.position, l.productId ?? null, l.name, l.description ?? null, l.hsnSac ?? null, l.unit ?? null, l.quantity, l.unitPrice, l.discountPct, l.taxRate, l.lineSubtotal, l.lineTax, l.lineTotal],
    );
  }
  const updated = await ctx.tx.one<Record<string, unknown>>(
    `update ${ident(doc.header)} set subtotal = $3, discount_total = $4, tax_total = $5, grand_total = $6, max_discount_pct = $7 where tenant_id = $1 and id = $2 returning *`,
    [ctx.tenantId, id, c.subtotal, c.discountTotal, c.taxTotal, c.grandTotal, Math.max(0, ...c.lines.map((l) => l.discountPct))],
  );
  if (hasRollupParents(ctx.meta, doc.objectKey)) await refreshParents(ctx, doc.objectKey, [prior, updated]);
  const changes: Record<string, [unknown, unknown]> = {};
  for (const k of ['subtotal', 'discount_total', 'tax_total', 'grand_total'] as const) if (Number(prior[k]) !== Number(updated![k])) changes[k] = [Number(prior[k]), Number(updated![k])];
  return Object.keys(changes).length ? [{ objectKey: doc.objectKey, recordId: id, kind: 'updated', changes }] : [];
}
