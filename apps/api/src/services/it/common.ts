/** Helpers shared by the IT suite: who may run it, numbering, raising invoices, period arithmetic. */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden } from '../../lib/errors';
import { issueInvoice, saveInvoiceLines } from '../billing';
import { createRecord, type RecordCtx, type RecordEvent } from '../records';

export const today = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Adds months, keeping the day where the month has it (31 Jan + 1 month → 28/29 Feb). */
export function addMonths(d: string, n: number) {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

export const MONTHS: Record<string, number> = { month: 1, monthly: 1, quarter: 3, quarterly: 3, half_year: 6, half_yearly: 6, year: 12, yearly: 12 };

/** The financial-year counter number, e.g. CON/26-27/0001. */
export async function fyNumber(ctx: RecordCtx, prefix: string, date: string) {
  const y = Number(date.slice(5, 7)) >= 4 ? Number(date.slice(0, 4)) : Number(date.slice(0, 4)) - 1;
  const fy = `${String(y).slice(2)}-${String((y + 1) % 100).padStart(2, '0')}`;
  const n = await ctx.tx.one<{ n: string }>(`select app.next_counter($1) as n`, [`${prefix.toLowerCase()}:${fy}`]);
  return `${prefix}/${fy}/${String(n!.n).padStart(4, '0')}`;
}

/** People who run contracts and subscriptions: projects or billing admins. */
export function assertManager(ctx: RecordCtx, what = 'this') {
  const p = ctx.principal.permissions;
  if (!hasAdmin(p, 'projects') && !hasAdmin(p, 'billing') && !hasAdmin(p, 'books')) throw forbidden(`Managing ${what} needs the projects or billing admin permission`);
}

/** Anyone who may read customers sees contracts and subscriptions. */
export function assertReader(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'projects') || hasAdmin(p, 'billing') || hasAdmin(p, 'books')) return;
  if (objectPerm(p, 'account').read === 'none') throw forbidden();
}

export interface InvLine {
  name: string;
  description?: string | null;
  hsnSac: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  unit?: string | null;
  discountPct?: number;
}

/** A draft GST invoice for a customer (issued too when asked). */
export async function raiseInvoice(ctx: RecordCtx, input: { name: string; accountId: string; projectId?: string | null; lines: InvLine[]; issue?: boolean; notes?: string | null }): Promise<{ id: string; number: string | null; events: RecordEvent[] }> {
  if (!objectPerm(ctx.principal.permissions, 'invoice').create) throw forbidden('You cannot create invoices');
  const lines = input.lines.filter((l) => l.quantity > 0 && l.unitPrice >= 0);
  if (!lines.length) throw badRequest('Nothing to invoice');
  const r = await createRecord(ctx, 'invoice', { name: input.name.slice(0, 200), account_id: input.accountId });
  const id = String(r.record.id);
  if (input.projectId) await ctx.tx.query(`update invoices set project_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, input.projectId]);
  const events = [...r.events, ...(await saveInvoiceLines(ctx, id, lines.map((l) => ({ ...l, discountPct: l.discountPct ?? 0, isService: true })) as never))];
  if (input.issue) events.push(...(await issueInvoice(ctx, id)));
  const n = await ctx.tx.one<{ invoice_number: string | null }>(`select invoice_number from invoices where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { id, number: n?.invoice_number ?? null, events };
}
