/**
 * Object-specific rules applied inside createRecord / updateRecord (tickets' SLA clock and
 * customer matching, installations' technician). Kept free of runtime imports from records.ts.
 */
import type { Tx } from '../lib/db';
import { badRequest } from '../lib/errors';
import { nextFyNumber } from './numbering';

interface HookCtx {
  tx: Tx;
  tenantId: string;
}

const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 };

/** Most specific active policy: priority + category, then priority, then category, then catch-all. */
async function pickPolicy(ctx: HookCtx, priority: string, category: string | null) {
  const rows = await ctx.tx.query<{ id: string; priority: string | null; category: string | null; first_response_minutes: number; resolution_minutes: number }>(
    `select id, priority, category, first_response_minutes, resolution_minutes from sla_policies where tenant_id = $1 and is_active`,
    [ctx.tenantId],
  );
  const score = (p: { priority: string | null; category: string | null }) =>
    (p.priority && p.priority !== priority) || (p.category && p.category !== category) ? -1 : (p.priority ? 2 : 0) + (p.category ? 1 : 0);
  return rows.map((r) => ({ r, s: score(r) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s)[0]?.r ?? null;
}

async function applySla(ctx: HookCtx, cols: Record<string, unknown>, from: Date, priority: string, category: string | null) {
  const pol = await pickPolicy(ctx, priority, category);
  cols.sla_policy_id = pol?.id ?? null;
  cols.first_response_due = pol ? new Date(from.getTime() + pol.first_response_minutes * 60_000).toISOString() : null;
  cols.resolution_due = pol ? new Date(from.getTime() + pol.resolution_minutes * 60_000).toISOString() : null;
}

/** Due date from payment terms and the invoice date (null for custom terms: the date is set by hand). */
export function dueFromTerms(terms: string | null | undefined, invoiceDate: string): string | null {
  if (!terms || terms === 'custom') return null;
  const d = new Date(`${invoiceDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (terms === 'due_on_receipt') return invoiceDate.slice(0, 10);
  const net = /^net_(\d{1,3})$/.exec(terms);
  if (net) return new Date(d.getTime() + Number(net[1]) * 86_400_000).toISOString().slice(0, 10);
  const months = terms === 'end_of_month' ? 1 : terms === 'end_of_next_month' ? 2 : 0;
  if (!months) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 0)).toISOString().slice(0, 10);
}

const todayIst = () => new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
const asDate = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

/** Invoices: terms default to the customer's; the due date follows the terms. */
async function invoiceTerms(ctx: HookCtx, cols: Record<string, unknown>, row: Record<string, unknown> | null) {
  const accountId = cols.account_id !== undefined ? cols.account_id : row?.account_id;
  if (!row && cols.payment_terms === undefined && accountId) {
    const a = await ctx.tx.one<{ payment_terms: string | null }>(`select payment_terms from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, accountId]);
    if (a?.payment_terms) cols.payment_terms = a.payment_terms;
  }
  const terms = (cols.payment_terms !== undefined ? cols.payment_terms : row?.payment_terms) as string | null | undefined;
  const changed = !row || cols.payment_terms !== undefined || cols.invoice_date !== undefined;
  if (!changed || !terms || terms === 'custom') return;
  if (row && cols.due_date !== undefined && cols.payment_terms === undefined) return; // a due date set by hand wins
  const date = asDate(cols.invoice_date !== undefined ? cols.invoice_date : row?.invoice_date) ?? todayIst();
  const due = dueFromTerms(terms, date);
  if (due) cols.due_date = due;
}

export async function beforeCreate(ctx: HookCtx, objectKey: string, cols: Record<string, unknown>) {
  if (objectKey === 'invoice') await invoiceTerms(ctx, cols, null);
  if (objectKey === 'ticket') {
    cols.priority ??= 'normal';
    cols.status ??= 'new';
    if (cols.status === 'resolved') cols.resolved_at = new Date().toISOString();
    // match the reporter to a known contact (and their account) by email or phone
    if (!cols.contact_id && (cols.customer_email || cols.customer_phone)) {
      const email = cols.customer_email ? String(cols.customer_email).toLowerCase() : null;
      const phone = cols.customer_phone ? String(cols.customer_phone).replace(/[^0-9]/g, '').slice(-10) : null;
      const c = await ctx.tx.one<{ id: string; account_id: string | null }>(
        `select id, account_id from contacts where tenant_id = $1 and deleted_at is null
            and (($2::text is not null and lower(email) = $2) or ($3::text is not null and length($3) >= 8 and right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $3))
          order by updated_at desc limit 1`,
        [ctx.tenantId, email, phone],
      );
      if (c) {
        cols.contact_id = c.id;
        if (!cols.account_id && c.account_id) cols.account_id = c.account_id;
      }
    }
    if (!cols.account_id && cols.contact_id) {
      const c = await ctx.tx.one<{ account_id: string | null }>(`select account_id from contacts where tenant_id = $1 and id = $2`, [ctx.tenantId, cols.contact_id]);
      if (c?.account_id) cols.account_id = c.account_id;
    }
    if (!cols.account_id && cols.sales_order_id) {
      const o = await ctx.tx.one<{ account_id: string | null }>(`select account_id from sales_orders where tenant_id = $1 and id = $2`, [ctx.tenantId, cols.sales_order_id]);
      if (o?.account_id) cols.account_id = o.account_id;
    }
    await applySla(ctx, cols, new Date(), String(cols.priority), (cols.category as string | null) ?? null);
  }
  if (objectKey === 'installation') cols.technician_id = cols.owner_id ?? null;
  if (objectKey === 'payment') {
    if (cols.sales_order_id && !cols.account_id) {
      const o = await ctx.tx.one<{ account_id: string | null }>(`select account_id from sales_orders where tenant_id = $1 and id = $2`, [ctx.tenantId, cols.sales_order_id]);
      cols.account_id = o?.account_id ?? null;
    }
    if (!cols.account_id) throw badRequest('Validation failed', [{ field: 'account_id', message: 'is required' }]);
    const date = String(cols.payment_date ?? new Date().toISOString().slice(0, 10));
    const prefix = await ctx.tx.one<{ p: string | null }>(`select settings -> 'billing' ->> 'receiptPrefix' as p from tenants where id = $1`, [ctx.tenantId]);
    const n = await nextFyNumber(ctx, 'payment', date, prefix?.p || 'RCPT');
    cols.payment_number = n.number;
    cols.financial_year = n.fy;
    cols.mode ??= 'bank_transfer';
  }
  if (objectKey === 'vendor_payment') {
    if (!cols.vendor_id) throw badRequest('Validation failed', [{ field: 'vendor_id', message: 'is required' }]);
    const n = await nextFyNumber(ctx, 'vendor_payment', String(cols.payment_date ?? new Date().toISOString().slice(0, 10)), 'PAY');
    cols.payment_number = n.number;
    cols.financial_year = n.fy;
    cols.mode ??= 'bank_transfer';
  }
  if (objectKey === 'bill') {
    if (!cols.vendor_id) throw badRequest('Validation failed', [{ field: 'vendor_id', message: 'is required' }]);
    const v = await ctx.tx.one<{ gstin: string | null; state: string | null; payment_terms_days: number | null }>(`select gstin, state, payment_terms_days from vendors where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, cols.vendor_id]);
    if (!v) throw badRequest('Vendor not found');
    cols.vendor_gstin ??= v.gstin && /^[0-9]{2}[A-Z0-9]{13}$/.test(v.gstin) ? v.gstin : null;
    const date = String(cols.bill_date ?? new Date().toISOString().slice(0, 10));
    if (!cols.due_date && v.payment_terms_days) cols.due_date = new Date(new Date(`${date}T00:00:00Z`).getTime() + v.payment_terms_days * 86_400_000).toISOString().slice(0, 10);
    cols.status = 'draft';
  }
  if (objectKey === 'expense') cols.status = 'draft';
  if (objectKey === 'project') {
    cols.status ??= 'active';
    cols.billing_method ??= 'time_project_rate';
  }
  if (objectKey === 'work_order') {
    cols.status = 'draft';
    if (!cols.product_id) throw badRequest('Validation failed', [{ field: 'product_id', message: 'is required' }]);
    const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, cols.product_id]);
    if (!p || p.product_type !== 'goods') throw badRequest('A work order makes a goods product');
    if (!(Number(cols.quantity) > 0) || Number(cols.quantity) > 10_000_000) throw badRequest('Validation failed', [{ field: 'quantity', message: 'must be between 0 and 10,000,000' }]);
    cols.bom_id ??= (await ctx.tx.one<{ id: string }>(`select id from boms where tenant_id = $1 and product_id = $2 and status = 'active' order by is_default desc, revision desc limit 1`, [ctx.tenantId, cols.product_id]))?.id ?? null;
    cols.warehouse_id ??= (await ctx.tx.one<{ id: string }>(`select id from warehouses where tenant_id = $1 and is_active order by is_default desc, created_at limit 1`, [ctx.tenantId]))?.id ?? null;
    cols.priority ??= 'normal';
  }
  if (objectKey === 'job_work') {
    cols.status = 'draft';
    if (!cols.vendor_id) throw badRequest('Validation failed', [{ field: 'vendor_id', message: 'is required' }]);
    const v = await ctx.tx.one(`select 1 from vendors where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, cols.vendor_id]);
    if (!v) throw badRequest('Vendor not found');
    if (cols.output_product_id) {
      const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, cols.output_product_id]);
      if (!p || p.product_type !== 'goods') throw badRequest('What comes back must be a goods product');
    }
    cols.warehouse_id ??= (await ctx.tx.one<{ id: string }>(`select id from warehouses where tenant_id = $1 and is_active order by is_default desc, created_at limit 1`, [ctx.tenantId]))?.id ?? null;
  }
  if (objectKey === 'invoice' && cols.account_id && cols.place_of_supply === undefined) {
    const a = await ctx.tx.one<{ state: string | null }>(`select state from accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, cols.account_id]);
    if (a?.state) cols.place_of_supply = a.state;
  }
}

export async function beforeUpdate(ctx: HookCtx, objectKey: string, row: Record<string, unknown>, cols: Record<string, unknown>) {
  if (objectKey === 'invoice' && row.status === 'draft') await invoiceTerms(ctx, cols, row);
  if (objectKey === 'ticket') {
    const now = new Date().toISOString();
    const to = cols.status as string | undefined;
    const from = String(row.status);
    if (to && to !== from) {
      if (from === 'new' && !row.first_responded_at) cols.first_responded_at = now;
      if (to === 'resolved') cols.resolved_at = now;
      if (to === 'closed') {
        cols.closed_at = now;
        if (!row.resolved_at) cols.resolved_at = now;
      }
      // reopened: the clock keeps running against the original due time
      if (['new', 'open', 'in_progress', 'waiting_customer'].includes(to) && ['resolved', 'closed'].includes(from)) {
        cols.resolved_at = null;
        cols.closed_at = null;
      }
    }
    const priority = (cols.priority as string | undefined) ?? String(row.priority);
    const category = cols.category !== undefined ? (cols.category as string | null) : ((row.category as string | null) ?? null);
    if ((cols.priority !== undefined && cols.priority !== row.priority) || (cols.category !== undefined && cols.category !== row.category)) {
      if (!row.resolved_at) {
        await applySla(ctx, cols, new Date(String(row.created_at instanceof Date ? (row.created_at as Date).toISOString() : row.created_at)), priority, category);
        // a re-prioritised ticket gets a fresh breach check
        if ((PRIORITY_RANK[priority] ?? 0) !== (PRIORITY_RANK[String(row.priority)] ?? 0)) {
          cols.breach_notified_at = null;
          cols.sla_breached = false;
        }
      }
    }
  }
  if (objectKey === 'installation' && cols.owner_id !== undefined) cols.technician_id = cols.owner_id;
  if (objectKey === 'work_order' && cols.quantity !== undefined && (!(Number(cols.quantity) > 0) || Number(cols.quantity) > 10_000_000))
    throw badRequest('Validation failed', [{ field: 'quantity', message: 'must be between 0 and 10,000,000' }]);
  if (objectKey === 'work_order' && cols.product_id !== undefined && cols.product_id !== row.product_id) cols.bom_id = null;
}
