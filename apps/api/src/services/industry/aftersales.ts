/**
 * After-sales for manufacturers: warranties by serial (started automatically when an order is
 * delivered), spare parts issued against tickets (stock out, under warranty or chargeable, billed
 * in one go), complaints with root cause and corrective / preventive actions (CAPA), and the ticket
 * escalation matrix that climbs level by level while a breached ticket stays unresolved.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { Tx } from '../../lib/db';
import { defaultWarehouse, moveStock } from '../inventory';
import { fyNumber, raiseInvoice } from '../it/common';
import type { RecordCtx, RecordEvent } from '../records';
import { r2, todayIst } from './core';

const num = (v: unknown) => Number(v ?? 0) || 0;
const addMonths = (d: string, n: number) => {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
};

function assertServiceRead(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'quality') || hasAdmin(p, 'operations') || objectPerm(p, 'ticket').read !== 'none') return;
  throw forbidden('You need access to tickets');
}
function assertServiceWrite(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'quality') || hasAdmin(p, 'operations') || objectPerm(p, 'ticket').update !== 'none') return;
  throw forbidden('You cannot change tickets');
}

/* ───────────── warranties ───────────── */

export async function listWarranties(ctx: RecordCtx, q: { accountId?: string | null; productId?: string | null; serial?: string | null; expiringDays?: number | null; status?: string | null }) {
  assertServiceRead(ctx);
  return ctx.tx.query(
    `select w.id, w.serial_no, w.quantity::float8 as quantity, w.starts_on::text, w.ends_on::text, w.status, w.notes, w.account_id, a.name as account, w.product_id, p.name as product,
            w.sales_order_id, o.order_number, (w.ends_on >= current_date and w.status = 'active') as in_warranty, (w.ends_on - current_date) as days_left
       from warranties w left join accounts a on a.tenant_id = w.tenant_id and a.id = w.account_id
       left join products p on p.tenant_id = w.tenant_id and p.id = w.product_id
       left join sales_orders o on o.tenant_id = w.tenant_id and o.id = w.sales_order_id
      where w.tenant_id = $1 and ($2::uuid is null or w.account_id = $2) and ($3::uuid is null or w.product_id = $3)
        and ($4::text is null or lower(w.serial_no) like '%' || lower($4) || '%')
        and ($5::int is null or (w.status = 'active' and w.ends_on between current_date and current_date + $5))
        and ($6::text is null or ($6 = 'active' and w.status = 'active' and w.ends_on >= current_date) or ($6 = 'expired' and w.ends_on < current_date) or ($6 = 'void' and w.status = 'void'))
      order by w.ends_on limit 500`,
    [ctx.tenantId, q.accountId ?? null, q.productId ?? null, q.serial?.trim() || null, q.expiringDays ?? null, q.status ?? null],
  );
}

export async function saveWarranty(ctx: RecordCtx, id: string | null, input: { accountId: string; productId?: string | null; serialNo?: string | null; quantity?: number; startsOn: string; endsOn?: string | null; months?: number | null; status?: 'active' | 'void'; notes?: string | null; salesOrderId?: string | null }) {
  assertServiceWrite(ctx);
  let ends = input.endsOn ?? null;
  if (!ends) {
    let months = input.months ?? null;
    if (months == null && input.productId) months = (await ctx.tx.one<{ m: number | null }>(`select warranty_months as m from products where tenant_id = $1 and id = $2`, [ctx.tenantId, input.productId]))?.m ?? null;
    if (months == null) throw badRequest('Give the warranty period or an end date');
    ends = addMonths(input.startsOn, months);
  }
  if (ends < input.startsOn) throw badRequest('The warranty ends before it starts');
  const vals = [input.accountId, input.productId ?? null, input.serialNo?.trim() || null, input.quantity ?? 1, input.startsOn, ends, input.status ?? 'active', input.notes ?? null];
  if (id) {
    const r = await ctx.tx.one(`update warranties set account_id = $3, product_id = $4, serial_no = $5, quantity = $6, starts_on = $7, ends_on = $8, status = $9, notes = $10 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, ...vals]);
    if (!r) throw notFound('Warranty not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into warranties (tenant_id, account_id, product_id, serial_no, quantity, starts_on, ends_on, status, notes, sales_order_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, ...vals, input.salesOrderId ?? null],
  );
  return { id: r!.id };
}

/** Delivered orders start warranties for products that carry one (once per order line product). */
export async function startWarranties(tx: Tx, tenantId: string, orderId: string, on?: string) {
  const starts = on ?? todayIst();
  const lines = await tx.query<{ product_id: string; account_id: string; quantity: string; months: number }>(
    `select l.product_id, o.account_id, sum(l.delivered_qty) as quantity, p.warranty_months as months
       from sales_order_lines l join sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = $1 and l.order_id = $2 and o.account_id is not null and coalesce(p.warranty_months, 0) > 0 and l.delivered_qty > 0
      group by l.product_id, o.account_id, p.warranty_months`,
    [tenantId, orderId],
  );
  let made = 0;
  for (const l of lines) {
    const r = await tx.query(
      `insert into warranties (tenant_id, account_id, product_id, sales_order_id, quantity, starts_on, ends_on) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict do nothing returning id`,
      [tenantId, l.account_id, l.product_id, orderId, num(l.quantity), starts, addMonths(starts, l.months)],
    );
    made += r.length;
  }
  return made;
}

/** Is this ticket's product still under warranty for the customer (by serial when the ticket has one)? */
export async function ticketWarranty(ctx: RecordCtx, ticketId: string) {
  assertServiceRead(ctx);
  const t = await ctx.tx.one<{ account_id: string | null; product_id: string | null; serial: string | null; sales_order_id: string | null }>(
    `select account_id, product_id, nullif(custom ->> 'serial_no', '') as serial, sales_order_id from tickets where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, ticketId],
  );
  if (!t) throw notFound('Ticket not found');
  if (!t.account_id) return { covered: false, warranty: null, reason: 'No customer on the ticket' };
  const w = await ctx.tx.one<{ id: string; serial_no: string | null; ends_on: string; product: string | null; starts_on: string }>(
    `select w.id, w.serial_no, w.ends_on::text, w.starts_on::text, p.name as product from warranties w left join products p on p.tenant_id = w.tenant_id and p.id = w.product_id
      where w.tenant_id = $1 and w.account_id = $2 and w.status = 'active' and ($3::uuid is null or w.product_id = $3) and ($4::text is null or lower(w.serial_no) = lower($4))
      order by (w.sales_order_id = $5) desc nulls last, w.ends_on desc limit 1`,
    [ctx.tenantId, t.account_id, t.product_id, t.serial, t.sales_order_id],
  );
  if (!w) return { covered: false, warranty: null, reason: 'No warranty on record' };
  return { covered: w.ends_on >= todayIst(), warranty: w, reason: w.ends_on >= todayIst() ? null : `Expired on ${w.ends_on}` };
}

/* ───────────── spare parts on tickets ───────────── */

export async function sparesFor(ctx: RecordCtx, productId: string) {
  return ctx.tx.query(
    `select p.id, p.name, p.sku, p.list_price::float8 as list_price, p.unit,
            (select coalesce(sum(on_hand - reserved), 0)::float8 from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id) as available
       from products p where p.tenant_id = $1 and p.deleted_at is null and p.is_spare and (p.spare_for_id = $2 or $2::uuid is null) order by p.name limit 300`,
    [ctx.tenantId, productId || null],
  );
}

export async function ticketParts(ctx: RecordCtx, ticketId: string) {
  assertServiceRead(ctx);
  return ctx.tx.query(
    `select tp.id, tp.product_id, p.name, p.sku, tp.quantity::float8 as quantity, tp.unit_price::float8 as unit_price, tp.chargeable, tp.under_warranty, tp.issued_at, u.full_name as issued_by, w.name as warehouse
       from ticket_parts tp join products p on p.tenant_id = tp.tenant_id and p.id = tp.product_id
       left join users u on u.tenant_id = tp.tenant_id and u.id = tp.issued_by left join warehouses w on w.tenant_id = tp.tenant_id and w.id = tp.warehouse_id
      where tp.tenant_id = $1 and tp.ticket_id = $2 order by tp.issued_at`,
    [ctx.tenantId, ticketId],
  );
}

export async function issuePart(ctx: RecordCtx, ticketId: string, input: { productId: string; quantity: number; warehouseId?: string | null; chargeable?: boolean | null; unitPrice?: number | null }) {
  assertServiceWrite(ctx);
  const t = await ctx.tx.one<{ ticket_number: string }>(`select ticket_number from tickets where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, ticketId]);
  if (!t) throw notFound('Ticket not found');
  const p = await ctx.tx.one<{ list_price: string | null; track_inventory: boolean; product_type: string }>(`select list_price, track_inventory, product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.productId]);
  if (!p) throw notFound('Part not found');
  const w = await ticketWarranty(ctx, ticketId);
  const chargeable = input.chargeable ?? !w.covered;
  const wh = input.warehouseId ?? (await defaultWarehouse(ctx));
  if (p.track_inventory && p.product_type === 'goods') {
    await moveStock({ ...ctx, principal: { ...ctx.principal, sessionId: 'system' } } as RecordCtx, { productId: input.productId, warehouseId: wh, type: 'out', qty: -input.quantity, reason: `Spare for ticket ${t.ticket_number}`, ref: { object: 'ticket', id: ticketId, label: `Ticket ${t.ticket_number}` } });
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into ticket_parts (tenant_id, ticket_id, product_id, warehouse_id, quantity, unit_price, chargeable, under_warranty) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, ticketId, input.productId, wh, input.quantity, chargeable ? (input.unitPrice ?? num(p.list_price)) : 0, chargeable, w.covered],
  );
  return { id: r!.id, chargeable, underWarranty: w.covered };
}

export async function returnPart(ctx: RecordCtx, ticketId: string, partId: string) {
  assertServiceWrite(ctx);
  const tp = await ctx.tx.one<{ product_id: string; warehouse_id: string | null; quantity: string; ticket_number: string; billed: boolean }>(
    `select tp.product_id, tp.warehouse_id, tp.quantity, t.ticket_number, (tp.chargeable and exists (select 1 from activities a where a.tenant_id = tp.tenant_id and a.related_object = 'ticket' and a.related_id = tp.ticket_id and a.metadata ->> 'partsInvoice' is not null and (a.metadata -> 'parts') ? tp.id::text)) as billed
       from ticket_parts tp join tickets t on t.tenant_id = tp.tenant_id and t.id = tp.ticket_id where tp.tenant_id = $1 and tp.id = $2 and tp.ticket_id = $3`,
    [ctx.tenantId, partId, ticketId],
  );
  if (!tp) throw notFound('Part not found');
  if (tp.billed) throw badRequest('This part was already billed; raise a credit note instead');
  const p = await ctx.tx.one<{ track_inventory: boolean; product_type: string }>(`select track_inventory, product_type from products where tenant_id = $1 and id = $2`, [ctx.tenantId, tp.product_id]);
  if (p?.track_inventory && p.product_type === 'goods' && tp.warehouse_id) {
    await moveStock({ ...ctx, principal: { ...ctx.principal, sessionId: 'system' } } as RecordCtx, { productId: tp.product_id, warehouseId: tp.warehouse_id, type: 'in', qty: num(tp.quantity), reason: `Returned from ticket ${tp.ticket_number}`, ref: { object: 'ticket', id: ticketId, label: `Ticket ${tp.ticket_number}` } });
  }
  await ctx.tx.query(`delete from ticket_parts where tenant_id = $1 and id = $2`, [ctx.tenantId, partId]);
  return { ok: true };
}

/** Bills the chargeable parts (not yet billed) on a ticket as one draft invoice. */
export async function billParts(ctx: RecordCtx, ticketId: string): Promise<{ invoiceId: string; events: RecordEvent[] }> {
  const t = await ctx.tx.one<{ ticket_number: string; account_id: string | null }>(`select ticket_number, account_id from tickets where tenant_id = $1 and id = $2`, [ctx.tenantId, ticketId]);
  if (!t) throw notFound('Ticket not found');
  if (!t.account_id) throw badRequest('Put the customer on the ticket first');
  const billed = await ctx.tx.query<{ ids: string[] }>(
    `select array(select jsonb_array_elements_text(metadata -> 'parts')) as ids from activities where tenant_id = $1 and related_object = 'ticket' and related_id = $2 and metadata ->> 'partsInvoice' is not null`,
    [ctx.tenantId, ticketId],
  );
  const done = new Set(billed.flatMap((b) => b.ids));
  const parts = (await ctx.tx.query<{ id: string; name: string; hsn_sac: string | null; unit: string | null; quantity: string; unit_price: string; tax_rate: string | null }>(
    `select tp.id, p.name, p.hsn_sac, p.unit, tp.quantity, tp.unit_price, p.tax_rate from ticket_parts tp join products p on p.tenant_id = tp.tenant_id and p.id = tp.product_id
      where tp.tenant_id = $1 and tp.ticket_id = $2 and tp.chargeable`,
    [ctx.tenantId, ticketId],
  )).filter((p) => !done.has(p.id));
  if (!parts.length) throw badRequest('No chargeable parts left to bill');
  const inv = await raiseInvoice(ctx, {
    name: `Spares — ticket ${t.ticket_number}`,
    accountId: t.account_id,
    lines: parts.map((p) => ({ name: p.name, hsnSac: p.hsn_sac || '8473', unit: p.unit, quantity: num(p.quantity), unitPrice: num(p.unit_price), taxRate: num(p.tax_rate ?? 18) })),
  });
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id, actor_id, metadata) values ($1,'system',$2,'ticket',$3,$4,$5)`, [
    ctx.tenantId, `Spares billed on invoice`, ticketId, ctx.principal.user.id, JSON.stringify({ partsInvoice: inv.id, parts: parts.map((p) => p.id) }),
  ]);
  return { invoiceId: inv.id, events: inv.events };
}

/* ───────────── complaints and CAPA ───────────── */

export interface CapaInput {
  title: string;
  ticketId?: string | null;
  accountId?: string | null;
  productId?: string | null;
  severity?: 'minor' | 'major' | 'critical';
  rootCauseCategory?: string | null;
  rootCause?: string | null;
  containment?: string | null;
  correctiveAction?: string | null;
  preventiveAction?: string | null;
  ownerId?: string | null;
  dueOn?: string | null;
  status?: 'open' | 'investigating' | 'action' | 'verifying' | 'closed';
  effective?: boolean | null;
}

export async function listCapas(ctx: RecordCtx, q: { status?: string | null; accountId?: string | null; ticketId?: string | null; productId?: string | null }) {
  assertServiceRead(ctx);
  return ctx.tx.query(
    `select c.*, a.name as account, p.name as product, t.ticket_number, u.full_name as owner,
            (c.status <> 'closed' and c.due_on < current_date) as overdue
       from capas c left join accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id left join products p on p.tenant_id = c.tenant_id and p.id = c.product_id
       left join tickets t on t.tenant_id = c.tenant_id and t.id = c.ticket_id left join users u on u.tenant_id = c.tenant_id and u.id = c.owner_id
      where c.tenant_id = $1 and ($2::text is null or ($2 = 'open' and c.status <> 'closed') or c.status = $2) and ($3::uuid is null or c.account_id = $3) and ($4::uuid is null or c.ticket_id = $4) and ($5::uuid is null or c.product_id = $5)
      order by (c.status = 'closed'), case c.severity when 'critical' then 0 when 'major' then 1 else 2 end, c.due_on nulls last, c.created_at desc limit 500`,
    [ctx.tenantId, q.status ?? null, q.accountId ?? null, q.ticketId ?? null, q.productId ?? null],
  );
}

export async function saveCapa(ctx: RecordCtx, id: string | null, input: CapaInput) {
  assertServiceWrite(ctx);
  // a complaint ticket fills in the customer and product
  let accountId = input.accountId ?? null;
  let productId = input.productId ?? null;
  if (input.ticketId && (!accountId || !productId)) {
    const t = await ctx.tx.one<{ account_id: string | null; product_id: string | null }>(`select account_id, product_id from tickets where tenant_id = $1 and id = $2`, [ctx.tenantId, input.ticketId]);
    accountId ??= t?.account_id ?? null;
    productId ??= t?.product_id ?? null;
  }
  if (input.status === 'closed' && !input.correctiveAction?.trim()) throw badRequest('Record the corrective action before closing');
  const vals = [
    input.title, input.ticketId ?? null, accountId, productId, input.severity ?? 'minor', input.rootCauseCategory ?? null, input.rootCause ?? null, input.containment ?? null,
    input.correctiveAction ?? null, input.preventiveAction ?? null, input.ownerId ?? null, input.dueOn ?? null, input.status ?? 'open', input.effective ?? null,
  ];
  if (id) {
    const r = await ctx.tx.one(
      `update capas set title = $3, ticket_id = $4, account_id = $5, product_id = $6, severity = $7, root_cause_category = $8, root_cause = $9, containment = $10, corrective_action = $11,
              preventive_action = $12, owner_id = $13, due_on = $14, status = $15, effective = $16, updated_at = now(),
              verified_on = case when $15 = 'closed' and verified_on is null then current_date when $15 <> 'closed' then null else verified_on end
        where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals],
    );
    if (!r) throw notFound('CAPA not found');
    return { id };
  }
  const number = await fyNumber(ctx, 'CAPA', todayIst());
  const r = await ctx.tx.one<{ id: string }>(
    `insert into capas (tenant_id, title, ticket_id, account_id, product_id, severity, root_cause_category, root_cause, containment, corrective_action, preventive_action, owner_id, due_on, status, effective, number)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.tenantId, ...vals, number],
  );
  if (input.ownerId && input.ownerId !== ctx.principal.user.id) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'assignment',$3,$4,'/after-sales?s_aftersales=capa')`, [ctx.tenantId, input.ownerId, `CAPA ${number} assigned to you`, input.title]);
  }
  return { id: r!.id, number };
}

export async function deleteCapa(ctx: RecordCtx, id: string) {
  if (!hasAdmin(ctx.principal.permissions, 'quality')) throw forbidden('Deleting a CAPA needs the quality permission');
  await ctx.tx.query(`delete from capas where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Quality numbers: complaints and CAPAs by cause, product and customer, closure time, effectiveness. */
export async function qualityStats(ctx: RecordCtx, days: number) {
  assertServiceRead(ctx);
  const p = [ctx.tenantId, days];
  const [byCause, byProduct, totals, byCategory] = await Promise.all([
    ctx.tx.query(`select coalesce(root_cause_category, 'not_set') as key, count(*)::int as n from capas where tenant_id = $1 and created_at > now() - make_interval(days => $2) group by 1 order by 2 desc`, p),
    ctx.tx.query(
      `select coalesce(p.name, '(no product)') as key, count(*)::int as n from capas c left join products p on p.tenant_id = c.tenant_id and p.id = c.product_id where c.tenant_id = $1 and c.created_at > now() - make_interval(days => $2) group by 1 order by 2 desc limit 10`,
      p,
    ),
    ctx.tx.one<{ open: number; overdue: number; closed: number; critical: number; avg_days: string | null; effective: number; ineffective: number }>(
      `select count(*) filter (where status <> 'closed')::int as open, count(*) filter (where status <> 'closed' and due_on < current_date)::int as overdue,
              count(*) filter (where status = 'closed' and created_at > now() - make_interval(days => $2))::int as closed,
              count(*) filter (where status <> 'closed' and severity = 'critical')::int as critical,
              avg(verified_on - created_at::date) filter (where status = 'closed' and created_at > now() - make_interval(days => $2)) as avg_days,
              count(*) filter (where effective)::int as effective, count(*) filter (where effective = false)::int as ineffective
         from capas where tenant_id = $1`,
      p,
    ),
    ctx.tx.query(`select coalesce(category, 'other') as key, count(*)::int as n from tickets where tenant_id = $1 and deleted_at is null and created_at > now() - make_interval(days => $2) group by 1 order by 2 desc limit 10`, p),
  ]);
  return { byCause, byProduct, byTicketCategory: byCategory, ...totals!, avgDaysToClose: totals?.avg_days != null ? Math.round(Number(totals.avg_days)) : null };
}

/* ───────────── escalation matrix ───────────── */

export interface EscalationLevel {
  afterHours: number;
  userIds: string[];
  notifyManager?: boolean;
  priorities?: string[];
}

export async function escalationSettings(tx: Tx, tenantId: string): Promise<{ enabled: boolean; levels: EscalationLevel[] }> {
  const r = await tx.one<{ e: any }>(`select settings -> 'escalation' as e from tenants where id = $1`, [tenantId]);
  return { enabled: !!r?.e?.enabled, levels: Array.isArray(r?.e?.levels) ? r!.e.levels : [] };
}

export async function saveEscalation(ctx: RecordCtx, input: { enabled: boolean; levels: EscalationLevel[] }) {
  if (!hasAdmin(ctx.principal.permissions, 'operations') && !hasAdmin(ctx.principal.permissions, 'quality') && !hasAdmin(ctx.principal.permissions, 'workflows')) throw forbidden('Changing escalations needs the operations, quality or automation permission');
  const levels = [...input.levels].sort((a, b) => a.afterHours - b.afterHours).slice(0, 5);
  await ctx.tx.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{escalation}', $2::jsonb) where id = $1`, [ctx.tenantId, JSON.stringify({ enabled: input.enabled, levels })]);
  return { enabled: input.enabled, levels };
}

/**
 * Runs with the SLA sweep: a ticket past its resolution time climbs to the next level once that
 * level's hours have passed since the breach; each level's people (and the owner's manager's
 * manager when asked) are told. Returns when the next level is due.
 */
export async function escalateTickets(tx: Tx, tenantId: string): Promise<Date | null> {
  const s = await escalationSettings(tx, tenantId);
  if (!s.enabled || !s.levels.length) return null;
  const open = await tx.query<{ id: string; ticket_number: string; name: string; priority: string; owner_id: string | null; escalation_level: number; hours: string }>(
    `select id, ticket_number, name, priority, owner_id, escalation_level, extract(epoch from now() - resolution_due) / 3600 as hours
       from tickets where tenant_id = $1 and deleted_at is null and resolved_at is null and resolution_due is not null and resolution_due < now() and escalation_level < $2`,
    [tenantId, s.levels.length],
  );
  let next: number | null = null;
  for (const t of open) {
    let lvl = t.escalation_level;
    while (lvl < s.levels.length) {
      const L = s.levels[lvl]!;
      if (L.priorities?.length && !L.priorities.includes(t.priority)) {
        lvl++;
        continue;
      }
      if (num(t.hours) < L.afterHours) {
        const due = Date.now() + (L.afterHours - num(t.hours)) * 3_600_000;
        next = next == null ? due : Math.min(next, due);
        break;
      }
      const to = new Set(L.userIds);
      if (L.notifyManager && t.owner_id) {
        const m = await tx.one<{ m: string | null; mm: string | null }>(
          `select u.manager_id as m, (select manager_id from users x where x.tenant_id = u.tenant_id and x.id = u.manager_id) as mm from users u where u.tenant_id = $1 and u.id = $2`,
          [tenantId, t.owner_id],
        );
        const pick = lvl === 0 ? m?.m : (m?.mm ?? m?.m);
        if (pick) to.add(pick);
      }
      for (const u of to) {
        await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'sla',$3,$4,$5)`, [
          tenantId, u, `Escalation level ${lvl + 1}: ${t.ticket_number}`, `${t.name} · ${t.priority} · ${Math.round(num(t.hours))} h past resolution time`, `/o/ticket/${t.id}`,
        ]);
      }
      lvl++;
    }
    if (lvl !== t.escalation_level) {
      await tx.query(`update tickets set escalation_level = $3 where tenant_id = $1 and id = $2`, [tenantId, t.id, lvl]);
      await tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'ticket',$3)`, [tenantId, `Escalated to level ${lvl}`, t.id]);
    }
  }
  return next ? new Date(next) : null;
}

/** Someone escalates a ticket by hand to the next level. */
export async function escalateNow(ctx: RecordCtx, ticketId: string, note: string | null) {
  assertServiceWrite(ctx);
  const s = await escalationSettings(ctx.tx, ctx.tenantId);
  const t = await ctx.tx.one<{ escalation_level: number; ticket_number: string; name: string; owner_id: string | null }>(`select escalation_level, ticket_number, name, owner_id from tickets where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, ticketId]);
  if (!t) throw notFound('Ticket not found');
  const L = s.levels[t.escalation_level];
  const to = new Set(L?.userIds ?? []);
  if (!to.size) {
    const m = t.owner_id ? await ctx.tx.one<{ m: string | null }>(`select manager_id as m from users where tenant_id = $1 and id = $2`, [ctx.tenantId, t.owner_id]) : null;
    if (m?.m) to.add(m.m);
    else for (const o of await ctx.tx.query<{ id: string }>(`select id from users where tenant_id = $1 and is_owner`, [ctx.tenantId])) to.add(o.id);
  }
  for (const u of to) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'sla',$3,$4,$5)`, [
      ctx.tenantId, u, `Escalated: ${t.ticket_number}`, `${t.name}${note ? ` — ${note}` : ''} (by ${ctx.principal.user.fullName ?? 'a colleague'})`, `/o/ticket/${ticketId}`,
    ]);
  }
  await ctx.tx.query(`update tickets set escalation_level = escalation_level + 1 where tenant_id = $1 and id = $2`, [ctx.tenantId, ticketId]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, related_object, related_id, actor_id) values ($1,'system',$2,$3,'ticket',$4,$5)`, [ctx.tenantId, `Escalated to level ${t.escalation_level + 1}`, note, ticketId, ctx.principal.user.id]);
  return { level: t.escalation_level + 1, notified: to.size };
}

/** Warranties ending soon (for the after-sales overview). */
export async function afterSalesOverview(ctx: RecordCtx) {
  assertServiceRead(ctx);
  const r = await ctx.tx.one<{ active: number; expiring: number; parts_month: number; parts_value: string; escalated: number }>(
    `select (select count(*)::int from warranties where tenant_id = $1 and status = 'active' and ends_on >= current_date) as active,
            (select count(*)::int from warranties where tenant_id = $1 and status = 'active' and ends_on between current_date and current_date + 60) as expiring,
            (select count(*)::int from ticket_parts where tenant_id = $1 and issued_at > date_trunc('month', now())) as parts_month,
            (select coalesce(sum(quantity * unit_price), 0) from ticket_parts where tenant_id = $1 and chargeable and issued_at > date_trunc('month', now())) as parts_value,
            (select count(*)::int from tickets where tenant_id = $1 and deleted_at is null and resolved_at is null and escalation_level > 0) as escalated`,
    [ctx.tenantId],
  );
  return { ...r!, parts_value: r2(num(r?.parts_value)) };
}
