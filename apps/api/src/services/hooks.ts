/**
 * Object-specific rules applied inside createRecord / updateRecord (tickets' SLA clock and
 * customer matching, installations' technician). Kept free of runtime imports from records.ts.
 */
import type { Tx } from '../lib/db';

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

export async function beforeCreate(ctx: HookCtx, objectKey: string, cols: Record<string, unknown>) {
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
}

export async function beforeUpdate(ctx: HookCtx, objectKey: string, row: Record<string, unknown>, cols: Record<string, unknown>) {
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
}
