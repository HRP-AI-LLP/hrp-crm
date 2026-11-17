/** Works a draft document's lines out again after a header change ("Prices include GST"). */
import { saveBillLines } from './books/bills';
import { LINE_DOCS, readLines } from './lines';
import { saveOrderLines } from './orders';
import { savePoLines } from './purchasing';
import { getQuote, saveLines } from './quotes';
import type { RecordCtx } from './records';

const pick = (l: Record<string, any>) => ({
  productId: l.productId ?? null,
  name: l.name,
  description: l.description ?? null,
  hsnSac: l.hsnSac ?? null,
  unit: l.unit ?? null,
  quantity: Number(l.quantity),
  unitPrice: Number(l.unitPrice),
  discountPct: Number(l.discountPct ?? 0),
  taxRate: Number(l.taxRate ?? 0),
});

export async function recalcLines(ctx: RecordCtx, objectKey: string, id: string) {
  if (objectKey === 'quote') {
    const q = await getQuote(ctx, id);
    if (q.quote.status === 'draft') await saveLines(ctx, id, (q.lines as Record<string, any>[]).map(pick));
  } else if (objectKey === 'sales_order' || objectKey === 'purchase_order') {
    const lines = (await readLines(ctx, LINE_DOCS[objectKey]!, id)).map(pick);
    const st = await ctx.tx.one<{ status: string }>(`select status from ${objectKey === 'sales_order' ? 'sales_orders' : 'purchase_orders'} where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (st?.status !== 'draft') return;
    if (objectKey === 'sales_order') await saveOrderLines(ctx, id, lines);
    else await savePoLines(ctx, id, lines);
  } else if (objectKey === 'bill') {
    const st = await ctx.tx.one<{ status: string }>(`select status from bills where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (st?.status !== 'draft') return;
    const rows = await ctx.tx.query<Record<string, any>>(`select * from bill_lines where tenant_id = $1 and order_id = $2 order by position`, [ctx.tenantId, id]);
    await saveBillLines(
      ctx,
      id,
      rows.map((r) => ({ ...pick({ productId: r.product_id, name: r.name, description: r.description, hsnSac: r.hsn_sac, unit: r.unit, quantity: r.quantity, unitPrice: r.unit_price, discountPct: r.discount_pct, taxRate: r.tax_rate }), accountId: r.account_id ?? null, projectId: r.project_id ?? null, poLineId: r.po_line_id ?? null })),
    );
  }
}
