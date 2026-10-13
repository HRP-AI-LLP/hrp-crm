/** Running document numbers (tenant_counters). Kept free of other service imports. */
import { financialYear } from '@synapse/shared';
import type { Tx } from '../lib/db';

interface Ctx {
  tx: Tx;
  tenantId: string;
}

/** Objects whose records get a running number on creation (calendar-year style: Q-2026-0007). */
export const NUMBERED: Record<string, { column: string; prefix: string }> = {
  quote: { column: 'quote_number', prefix: 'Q' },
  sales_order: { column: 'order_number', prefix: 'SO' },
  purchase_order: { column: 'po_number', prefix: 'PO' },
  shipment: { column: 'shipment_number', prefix: 'DL' },
  installation: { column: 'job_number', prefix: 'INS' },
  ticket: { column: 'ticket_number', prefix: 'TK' },
};

/** Next number like Q-2026-0007; prefixes can be changed in Settings (settings.numbering). */
export async function nextDocumentNumber(ctx: Ctx, key: string, fallbackPrefix?: string): Promise<string> {
  const n = await ctx.tx.one<{ n: string; prefix: string | null }>(
    `select app.next_counter($1) as n, (select settings -> 'numbering' ->> $1 from tenants where id = $2) as prefix`,
    [key, ctx.tenantId],
  );
  const prefix = (n?.prefix ?? '').trim() || NUMBERED[key]?.prefix || fallbackPrefix || key.toUpperCase();
  return `${prefix}-${new Date().getFullYear()}-${String(n!.n).padStart(4, '0')}`;
}

/**
 * GST series per financial year, e.g. INV/26-27/0001 (at most 16 characters, unique per FY).
 * The counter is keyed by series and FY, so numbering restarts every April.
 */
export async function nextFyNumber(ctx: Ctx, series: 'invoice' | 'credit_note' | 'proforma' | 'payment', date: string | Date, prefix: string) {
  const fy = financialYear(date);
  const short = `${fy.slice(2, 4)}-${fy.slice(5)}`;
  const n = await ctx.tx.one<{ n: string }>(`select app.next_counter($1) as n`, [`${series}:${fy}`]);
  const p = prefix.replace(/[^A-Za-z0-9-]/g, '').slice(0, 5) || 'INV';
  return { number: `${p}/${short}/${String(n!.n).padStart(4, '0')}`, fy };
}
