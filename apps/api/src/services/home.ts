/**
 * Role dashboards ("home" for each persona): owner, sales head, operations, inventory, service.
 * Every figure is computed over the records the caller can see (same visibility rules as lists),
 * so a rep's "sales" view shows their own numbers and a sales head's shows the team's.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { Params, type RecordCtx, visibilityWhere } from './records';
import { enabledApps } from './apps';

export const PERSONAS = ['owner', 'sales', 'operations', 'inventory', 'service'] as const;
export type Persona = (typeof PERSONAS)[number];

type Row = Record<string, unknown>;
export interface Tile {
  key: string;
  label: string;
  value: number;
  format: 'money' | 'number' | 'percent' | 'hours';
  tone?: 'good' | 'bad' | 'warn';
  link?: string;
  hint?: string;
}
export interface HomeData {
  persona: Persona;
  tiles: Tile[];
  series?: { label: string; points: { period: string; a: number; b: number }[]; a: string; b: string };
  lists: { key: string; title: string; columns: { key: string; label: string; format?: Tile['format'] | 'date' | 'text' }[]; rows: Row[]; link?: string }[];
}

const can = (ctx: RecordCtx, o: string) => ctx.meta.objects.some((x) => x.key === o) && objectPerm(ctx.principal.permissions, o).read !== 'none';
const num = (v: unknown) => Number(v ?? 0) || 0;

/** Personas this person can open, best fit first (their own role decides the default). */
export function availablePersonas(ctx: RecordCtx): Persona[] {
  const apps = enabledApps(ctx.meta);
  const roles = new Set(ctx.principal.user.roles);
  const out: Persona[] = [];
  const fit: Partial<Record<Persona, boolean>> = {
    owner: ctx.principal.user.isOwner || roles.has('admin') || roles.has('owner') || roles.has('accounts'),
    operations: roles.has('operations') || roles.has('technician'),
    inventory: roles.has('inventory_manager'),
    service: roles.has('service_agent'),
  };
  const ok: Record<Persona, boolean> = {
    owner: can(ctx, 'deal') || can(ctx, 'sales_order') || can(ctx, 'invoice'),
    sales: can(ctx, 'lead') || can(ctx, 'deal'),
    operations: (apps.has('orders') && can(ctx, 'sales_order')) || (apps.has('delivery') && can(ctx, 'shipment')),
    // stock value is at cost: only people who run the stock (or the operations admin) get this view
    inventory: apps.has('inventory') && can(ctx, 'product') && (hasAdmin(ctx.principal.permissions, 'operations') || objectPerm(ctx.principal.permissions, 'product').update === 'all'),
    service: apps.has('service') && can(ctx, 'ticket'),
  };
  for (const p of PERSONAS) if (ok[p] && fit[p]) out.push(p);
  for (const p of PERSONAS) if (ok[p] && !out.includes(p)) out.push(p);
  // owners land on the owner view; everyone else on their function, then sales
  if (!fit.owner) out.sort((a, b) => (a === 'owner' ? 1 : b === 'owner' ? -1 : 0));
  return out;
}

async function scalar(ctx: RecordCtx, object: string, table: string, select: string, extra: string[] = [], bind: (p: Params) => void = () => undefined): Promise<Row> {
  if (!can(ctx, object)) return {};
  const p = new Params();
  bind(p);
  const where = [...visibilityWhere(ctx, object, p), ...extra];
  return (await ctx.tx.one<Row>(`select ${select} from ${table} r where ${where.join(' and ')}`, p.values)) ?? {};
}

async function rows(ctx: RecordCtx, object: string, sql: (where: string, p: Params) => string, bind: (p: Params) => void = () => undefined): Promise<Row[]> {
  if (!can(ctx, object)) return [];
  const p = new Params();
  bind(p);
  const where = visibilityWhere(ctx, object, p).join(' and ');
  return ctx.tx.query<Row>(sql(where, p), p.values);
}

const MONTH = `date_trunc('month', (now() at time zone 'Asia/Kolkata'))::date`;
const TODAY = `(now() at time zone 'Asia/Kolkata')::date`;
const OPEN_STAGE = `coalesce((select st.category from pipeline_stages st where st.tenant_id = r.tenant_id and st.id = r.stage_id), 'open')`;

async function owner(ctx: RecordCtx): Promise<HomeData> {
  const apps = enabledApps(ctx.meta);
  const so = apps.has('orders') ? await scalar(ctx, 'sales_order', 'sales_orders', `coalesce(sum(r.grand_total) filter (where r.order_date >= ${MONTH}), 0) as booked, count(*) filter (where r.order_date >= ${MONTH})::int as orders, coalesce(sum(r.balance_due) filter (where r.status not in ('draft','cancelled')), 0) as order_due`, [`r.status not in ('draft', 'cancelled')`]) : {};
  const pay = apps.has('billing') ? await scalar(ctx, 'payment', 'payments', `coalesce(sum(r.amount) filter (where r.payment_date >= ${MONTH}), 0) as collected`, [`r.status = 'received'`]) : {};
  const inv = apps.has('billing')
    ? await scalar(ctx, 'invoice', 'invoices', `coalesce(sum(r.balance_due), 0) as receivable, coalesce(sum(r.balance_due) filter (where r.due_date < ${TODAY}), 0) as overdue, count(*) filter (where r.due_date < ${TODAY} and r.balance_due > 0)::int as overdue_n`, [`r.doc_type = 'tax_invoice'`, `r.status in ('issued', 'partially_paid')`])
    : {};
  const deals = await scalar(
    ctx,
    'deal',
    'deals',
    `coalesce(sum(r.amount) filter (where ${OPEN_STAGE} = 'open'), 0) as pipeline,
     coalesce(sum(r.amount) filter (where ${OPEN_STAGE} = 'won' and r.closed_at >= ${MONTH}), 0) as won,
     count(*) filter (where ${OPEN_STAGE} = 'won' and r.closed_at > now() - interval '90 days')::int as won90,
     count(*) filter (where ${OPEN_STAGE} in ('won', 'lost') and r.closed_at > now() - interval '90 days')::int as closed90`,
  );
  const leads = await scalar(ctx, 'lead', 'leads', `count(*) filter (where r.created_at >= ${MONTH})::int as new_leads, count(*) filter (where r.converted_at >= ${MONTH})::int as converted`);
  const tiles: Tile[] = [];
  if (apps.has('orders') && can(ctx, 'sales_order')) tiles.push({ key: 'booked', label: 'Orders booked this month', value: num(so.booked), format: 'money', link: '/o/sales_order', hint: `${num(so.orders)} orders` });
  if (apps.has('billing') && can(ctx, 'payment')) tiles.push({ key: 'collected', label: 'Collected this month', value: num(pay.collected), format: 'money', tone: 'good', link: '/billing' });
  if (apps.has('billing') && can(ctx, 'invoice')) {
    tiles.push({ key: 'receivable', label: 'Receivables', value: num(inv.receivable), format: 'money', link: '/billing' });
    tiles.push({ key: 'overdue', label: 'Overdue', value: num(inv.overdue), format: 'money', tone: num(inv.overdue) > 0 ? 'bad' : undefined, link: '/billing', hint: `${num(inv.overdue_n)} invoices` });
  } else if (apps.has('orders') && can(ctx, 'sales_order')) tiles.push({ key: 'order_due', label: 'Balance due on orders', value: num(so.order_due), format: 'money', link: '/o/sales_order' });
  if (can(ctx, 'deal')) {
    tiles.push({ key: 'pipeline', label: 'Open pipeline', value: num(deals.pipeline), format: 'money', link: '/pipeline/deal' });
    tiles.push({ key: 'won', label: 'Won this month', value: num(deals.won), format: 'money', tone: 'good' });
    tiles.push({ key: 'winrate', label: 'Win rate (90 days)', value: num(deals.closed90) ? Math.round((num(deals.won90) / num(deals.closed90)) * 100) : 0, format: 'percent' });
  }
  if (can(ctx, 'lead')) tiles.push({ key: 'new_leads', label: 'New leads this month', value: num(leads.new_leads), format: 'number', link: '/o/lead', hint: `${num(leads.converted)} converted` });

  // bookings vs collections, last 6 months
  let series: HomeData['series'];
  if (apps.has('orders') && can(ctx, 'sales_order')) {
    const b = await rows(ctx, 'sales_order', (w) => `select to_char(date_trunc('month', r.order_date), 'YYYY-MM') as period, sum(r.grand_total)::float8 as v from sales_orders r where ${w} and r.status not in ('draft','cancelled') and r.order_date >= (${MONTH} - interval '5 months') group by 1`);
    const c = apps.has('billing') && can(ctx, 'payment') ? await rows(ctx, 'payment', (w) => `select to_char(date_trunc('month', r.payment_date), 'YYYY-MM') as period, sum(r.amount)::float8 as v from payments r where ${w} and r.status = 'received' and r.payment_date >= (${MONTH} - interval '5 months') group by 1`) : [];
    const months: string[] = [];
    const d = new Date();
    for (let i = 5; i >= 0; i--) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      months.push(m.toISOString().slice(0, 7));
    }
    series = { label: 'Bookings and collections', a: 'Booked', b: 'Collected', points: months.map((m) => ({ period: m, a: num(b.find((x) => x.period === m)?.v), b: num(c.find((x) => x.period === m)?.v) })) };
  }
  const lists: HomeData['lists'] = [];
  if (apps.has('billing') && can(ctx, 'invoice'))
    lists.push({
      key: 'top_overdue',
      title: 'Largest overdue invoices',
      link: '/billing',
      columns: [
        { key: 'invoice_number', label: 'Invoice' },
        { key: 'buyer_name', label: 'Customer' },
        { key: 'due_date', label: 'Due', format: 'date' },
        { key: 'balance_due', label: 'Balance', format: 'money' },
      ],
      rows: await rows(ctx, 'invoice', (w) => `select r.id, r.invoice_number, r.buyer_name, r.due_date, r.balance_due::float8 as balance_due from invoices r where ${w} and r.doc_type = 'tax_invoice' and r.status in ('issued','partially_paid') and r.due_date < ${TODAY} order by r.balance_due desc limit 5`),
    });
  return { persona: 'owner', tiles, series, lists };
}

async function sales(ctx: RecordCtx): Promise<HomeData> {
  const leads = await scalar(
    ctx,
    'lead',
    'leads',
    `count(*) filter (where r.created_at >= ${MONTH})::int as new_leads,
     count(*) filter (where r.converted_at is null and r.next_follow_up_at < now())::int as overdue,
     count(*) filter (where r.converted_at is null and r.next_follow_up_at >= now() and r.next_follow_up_at < now() + interval '1 day')::int as due_today,
     count(*) filter (where r.converted_at is null and r.last_activity_at is null and r.created_at < now() - interval '1 day')::int as untouched`,
  );
  const deals = await scalar(ctx, 'deal', 'deals', `count(*) filter (where ${OPEN_STAGE} = 'open' and r.close_date <= (date_trunc('month', now()) + interval '1 month - 1 day')::date)::int as closing, coalesce(sum(r.amount) filter (where ${OPEN_STAGE} = 'open' and r.close_date <= (date_trunc('month', now()) + interval '1 month - 1 day')::date), 0) as closing_value`);
  const quotes = await scalar(ctx, 'quote', 'quotes', `count(*) filter (where r.status = 'sent')::int as awaiting, count(*) filter (where r.approval_status = 'pending')::int as pending_approval`);
  const tiles: Tile[] = [];
  if (can(ctx, 'lead')) {
    tiles.push({ key: 'new_leads', label: 'New leads this month', value: num(leads.new_leads), format: 'number', link: '/o/lead' });
    tiles.push({ key: 'overdue', label: 'Overdue follow-ups', value: num(leads.overdue), format: 'number', tone: num(leads.overdue) ? 'bad' : 'good' });
    tiles.push({ key: 'due_today', label: 'Follow-ups due today', value: num(leads.due_today), format: 'number', tone: 'warn' });
    tiles.push({ key: 'untouched', label: 'Leads never contacted', value: num(leads.untouched), format: 'number', tone: num(leads.untouched) ? 'warn' : undefined });
  }
  if (can(ctx, 'deal')) tiles.push({ key: 'closing', label: 'Deals closing this month', value: num(deals.closing_value), format: 'money', hint: `${num(deals.closing)} deals`, link: '/pipeline/deal' });
  if (can(ctx, 'quote')) tiles.push({ key: 'quotes', label: 'Quotes awaiting customer', value: num(quotes.awaiting), format: 'number', hint: num(quotes.pending_approval) ? `${num(quotes.pending_approval)} waiting for approval` : undefined, link: '/o/quote' });
  const lists: HomeData['lists'] = [];
  if (can(ctx, 'lead'))
    lists.push({
      key: 'team',
      title: 'Team follow-up health',
      columns: [
        { key: 'owner_name', label: 'Owner' },
        { key: 'open', label: 'Open leads', format: 'number' },
        { key: 'new_month', label: 'New this month', format: 'number' },
        { key: 'overdue', label: 'Overdue', format: 'number' },
        { key: 'converted', label: 'Converted (month)', format: 'number' },
      ],
      rows: await rows(
        ctx,
        'lead',
        (w) => `select coalesce(u.full_name, 'Unassigned') as owner_name,
                  count(*) filter (where r.converted_at is null)::int as open,
                  count(*) filter (where r.created_at >= ${MONTH})::int as new_month,
                  count(*) filter (where r.converted_at is null and r.next_follow_up_at < now())::int as overdue,
                  count(*) filter (where r.converted_at >= ${MONTH})::int as converted
             from leads r left join users u on u.tenant_id = r.tenant_id and u.id = r.owner_id
            where ${w} group by 1 order by overdue desc, open desc limit 15`,
      ),
    });
  if (can(ctx, 'lead'))
    lists.push({
      key: 'sources',
      title: 'Leads by source this month',
      columns: [
        { key: 'source', label: 'Source', format: 'text' },
        { key: 'n', label: 'Leads', format: 'number' },
        { key: 'converted', label: 'Converted', format: 'number' },
      ],
      rows: await rows(ctx, 'lead', (w) => `select coalesce(r.source, 'unknown') as source, count(*)::int as n, count(*) filter (where r.converted_at is not null)::int as converted from leads r where ${w} and r.created_at >= ${MONTH} group by 1 order by 2 desc limit 12`),
    });
  return { persona: 'sales', tiles, lists };
}

async function operations(ctx: RecordCtx): Promise<HomeData> {
  const apps = enabledApps(ctx.meta);
  const tiles: Tile[] = [];
  const lists: HomeData['lists'] = [];
  if (apps.has('orders') && can(ctx, 'sales_order')) {
    const o = await scalar(ctx, 'sales_order', 'sales_orders', `count(*) filter (where r.status = 'draft')::int as drafts, count(*) filter (where r.status in ('confirmed','in_production','ready','dispatched') and r.fulfilment_status <> 'delivered')::int as to_fulfil, count(*) filter (where r.status in ('confirmed','in_production','ready','dispatched') and r.expected_delivery_date < ${TODAY} and r.fulfilment_status <> 'delivered')::int as late`);
    tiles.push({ key: 'to_fulfil', label: 'Orders to fulfil', value: num(o.to_fulfil), format: 'number', link: '/o/sales_order' });
    tiles.push({ key: 'late_orders', label: 'Past promised date', value: num(o.late), format: 'number', tone: num(o.late) ? 'bad' : 'good' });
    tiles.push({ key: 'drafts', label: 'Draft orders', value: num(o.drafts), format: 'number' });
    lists.push({
      key: 'late',
      title: 'Orders past their promised date',
      link: '/o/sales_order',
      columns: [
        { key: 'order_number', label: 'Order' },
        { key: 'name', label: 'Name' },
        { key: 'expected_delivery_date', label: 'Promised', format: 'date' },
        { key: 'status', label: 'Status', format: 'text' },
      ],
      rows: await rows(ctx, 'sales_order', (w) => `select r.id, r.order_number, r.name, r.expected_delivery_date, r.status from sales_orders r where ${w} and r.status in ('confirmed','in_production','ready','dispatched') and r.expected_delivery_date < ${TODAY} and r.fulfilment_status <> 'delivered' order by r.expected_delivery_date limit 8`),
    });
  }
  if (apps.has('delivery')) {
    const s = await scalar(ctx, 'shipment', 'shipments', `count(*) filter (where r.planned_date = ${TODAY} and r.status in ('planned','packed','dispatched'))::int as today, count(*) filter (where r.planned_date < ${TODAY} and r.status in ('planned','packed','dispatched'))::int as late, count(*) filter (where r.status = 'failed' and r.updated_at > now() - interval '7 days')::int as failed`);
    const i = await scalar(ctx, 'installation', 'installations', `count(*) filter (where (r.scheduled_start at time zone 'Asia/Kolkata')::date = ${TODAY} and r.status in ('scheduled','in_progress'))::int as today, count(*) filter (where r.status = 'on_hold')::int as on_hold, count(*) filter (where r.status = 'scheduled' and r.scheduled_start < now() - interval '1 day')::int as missed`);
    if (can(ctx, 'shipment')) {
      tiles.push({ key: 'drops_today', label: 'Deliveries today', value: num(s.today), format: 'number', link: '/schedule' });
      tiles.push({ key: 'drops_late', label: 'Late deliveries', value: num(s.late), format: 'number', tone: num(s.late) ? 'bad' : 'good', hint: num(s.failed) ? `${num(s.failed)} failed this week` : undefined });
    }
    if (can(ctx, 'installation')) {
      tiles.push({ key: 'jobs_today', label: 'Installations today', value: num(i.today), format: 'number', link: '/schedule' });
      tiles.push({ key: 'on_hold', label: 'Jobs on hold', value: num(i.on_hold), format: 'number', tone: num(i.on_hold) ? 'warn' : undefined, hint: num(i.missed) ? `${num(i.missed)} not started on time` : undefined });
    }
  }
  if (apps.has('purchasing') && can(ctx, 'purchase_order')) {
    const p = await scalar(ctx, 'purchase_order', 'purchase_orders', `count(*) filter (where r.status in ('sent','partially_received'))::int as open, count(*) filter (where r.status in ('sent','partially_received') and r.expected_date < ${TODAY})::int as late, coalesce(sum(r.grand_total) filter (where r.status in ('sent','partially_received')), 0) as value`);
    tiles.push({ key: 'po_open', label: 'POs awaiting goods', value: num(p.open), format: 'number', hint: num(p.late) ? `${num(p.late)} overdue from vendors` : undefined, tone: num(p.late) ? 'warn' : undefined, link: '/o/purchase_order' });
  }
  return { persona: 'operations', tiles, lists };
}

async function inventory(ctx: RecordCtx): Promise<HomeData> {
  if (!availablePersonas(ctx).includes('inventory')) return { persona: 'inventory', tiles: [], lists: [] };
  const p = new Params();
  const where = visibilityWhere(ctx, 'product', p).join(' and ');
  const agg = await ctx.tx.one<Row>(
    `with lv as (select l.product_id, sum(l.on_hand) as on_hand, sum(l.reserved) as reserved from stock_levels l where l.tenant_id = ${p.add(ctx.tenantId)} group by 1)
     select count(*) filter (where r.track_inventory)::int as tracked,
            count(*) filter (where r.track_inventory and r.reorder_level is not null and coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0) <= r.reorder_level)::int as low,
            count(*) filter (where r.track_inventory and coalesce(lv.on_hand, 0) <= 0)::int as out_of_stock,
            coalesce(sum(coalesce(lv.on_hand, 0) * coalesce(r.cost_price, 0)) filter (where r.track_inventory), 0)::float8 as value,
            coalesce(sum(coalesce(lv.reserved, 0)) filter (where r.track_inventory), 0)::float8 as reserved
       from products r left join lv on lv.product_id = r.id where ${where}`,
    p.values,
  );
  const mv = await ctx.tx.one<Row>(`select count(*)::int as n from stock_movements where tenant_id = $1 and created_at > now() - interval '7 days'`, [ctx.tenantId]);
  const p2 = new Params();
  const w2 = visibilityWhere(ctx, 'product', p2).join(' and ');
  const low = await ctx.tx.query<Row>(
    `with lv as (select l.product_id, sum(l.on_hand) as on_hand, sum(l.reserved) as reserved from stock_levels l where l.tenant_id = ${p2.add(ctx.tenantId)} group by 1)
     select r.id, r.name, r.sku, (coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0))::float8 as available, r.reorder_level::float8 as reorder_level, r.reorder_qty::float8 as reorder_qty
       from products r left join lv on lv.product_id = r.id
      where ${w2} and r.track_inventory and r.reorder_level is not null and coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0) <= r.reorder_level
      order by (coalesce(lv.on_hand, 0) - coalesce(lv.reserved, 0)) - r.reorder_level limit 10`,
    p2.values,
  );
  return {
    persona: 'inventory',
    tiles: [
      { key: 'value', label: 'Stock value (at cost)', value: num(agg?.value), format: 'money', link: '/inventory' },
      { key: 'low', label: 'At or below reorder level', value: num(agg?.low), format: 'number', tone: num(agg?.low) ? 'warn' : 'good', link: '/inventory' },
      { key: 'out', label: 'Out of stock', value: num(agg?.out_of_stock), format: 'number', tone: num(agg?.out_of_stock) ? 'bad' : 'good' },
      { key: 'reserved', label: 'Units reserved for orders', value: num(agg?.reserved), format: 'number' },
      { key: 'movements', label: 'Stock movements (7 days)', value: num(mv?.n), format: 'number' },
    ],
    lists: [
      {
        key: 'reorder',
        title: 'Reorder now',
        link: '/inventory',
        columns: [
          { key: 'name', label: 'Product' },
          { key: 'sku', label: 'SKU', format: 'text' },
          { key: 'available', label: 'Available', format: 'number' },
          { key: 'reorder_level', label: 'Reorder at', format: 'number' },
          { key: 'reorder_qty', label: 'Suggested qty', format: 'number' },
        ],
        rows: low,
      },
    ],
  };
}

async function service(ctx: RecordCtx): Promise<HomeData> {
  if (!can(ctx, 'ticket')) return { persona: 'service', tiles: [], lists: [] };
  const t = await scalar(
    ctx,
    'ticket',
    'tickets',
    `count(*) filter (where r.status not in ('resolved','closed'))::int as open,
     count(*) filter (where r.status not in ('resolved','closed') and r.priority in ('high','urgent'))::int as urgent,
     count(*) filter (where r.status not in ('resolved','closed') and r.resolution_due < now())::int as breached,
     count(*) filter (where r.status = 'new')::int as unanswered,
     count(*) filter (where r.resolved_at > now() - interval '7 days')::int as resolved7,
     round(avg(extract(epoch from r.first_responded_at - r.created_at) / 3600) filter (where r.first_responded_at is not null and r.created_at > now() - interval '30 days')::numeric, 1)::float8 as frt`,
  );
  return {
    persona: 'service',
    tiles: [
      { key: 'open', label: 'Open tickets', value: num(t.open), format: 'number', link: '/o/ticket' },
      { key: 'breached', label: 'Past resolution SLA', value: num(t.breached), format: 'number', tone: num(t.breached) ? 'bad' : 'good' },
      { key: 'unanswered', label: 'Waiting for first reply', value: num(t.unanswered), format: 'number', tone: num(t.unanswered) ? 'warn' : undefined },
      { key: 'urgent', label: 'High / urgent open', value: num(t.urgent), format: 'number' },
      { key: 'resolved7', label: 'Resolved (7 days)', value: num(t.resolved7), format: 'number', tone: 'good' },
      { key: 'frt', label: 'Avg first response (30 days)', value: num(t.frt), format: 'hours' },
    ],
    lists: [
      {
        key: 'breaching',
        title: 'Oldest tickets past SLA',
        link: '/o/ticket',
        columns: [
          { key: 'ticket_number', label: 'Ticket' },
          { key: 'name', label: 'Subject' },
          { key: 'priority', label: 'Priority', format: 'text' },
          { key: 'resolution_due', label: 'Was due', format: 'date' },
        ],
        rows: await rows(ctx, 'ticket', (w) => `select r.id, r.ticket_number, r.name, r.priority, r.resolution_due from tickets r where ${w} and r.status not in ('resolved','closed') and r.resolution_due < now() order by r.resolution_due limit 8`),
      },
    ],
  };
}

export async function homeFor(ctx: RecordCtx, persona: Persona): Promise<HomeData> {
  switch (persona) {
    case 'owner':
      return owner(ctx);
    case 'sales':
      return sales(ctx);
    case 'operations':
      return operations(ctx);
    case 'inventory':
      return inventory(ctx);
    case 'service':
      return service(ctx);
  }
}
