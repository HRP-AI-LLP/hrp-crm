/**
 * Business health: the KPI library (see @synapse/shared KPIS) computed over the records the viewer
 * can see, for a period and the one before it, against the workspace's targets.
 */
import { hasAdmin, KPI_BY_KEY, KPIS, objectPerm } from '@synapse/shared';
import { enabledApps } from './apps';
import { Params, type RecordCtx, visibilityWhere } from './records';

export const PERIODS = ['this_month', 'last_month', 'this_quarter', 'last_90', 'this_fy'] as const;
export type Period = (typeof PERIODS)[number];

const IST = 330 * 60_000;
/** midnight IST of a calendar date, as a UTC instant */
const istMidnight = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d) - IST);

export function periodRange(p: Period, now = new Date()): { from: Date; to: Date; label: string; prev: { from: Date; to: Date } } {
  const local = new Date(now.getTime() + IST);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  let from: Date;
  let to: Date;
  let label: string;
  const monthName = (mm: number, yy: number) => new Date(Date.UTC(yy, mm, 1)).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (p === 'this_month') {
    from = istMidnight(y, m, 1);
    to = istMidnight(y, m, d + 1);
    label = monthName(m, y);
  } else if (p === 'last_month') {
    from = istMidnight(y, m - 1, 1);
    to = istMidnight(y, m, 1);
    label = monthName((m + 11) % 12, m === 0 ? y - 1 : y);
  } else if (p === 'this_quarter') {
    // Indian financial quarters: Apr–Jun (Q1), Jul–Sep, Oct–Dec, Jan–Mar (Q4)
    const fyStart = m >= 3 ? y : y - 1;
    const qi = Math.floor(((m - 3 + 12) % 12) / 3);
    const qMonth = (3 + qi * 3) % 12;
    from = istMidnight(qi === 3 ? fyStart + 1 : fyStart, qMonth, 1);
    to = istMidnight(y, m, d + 1);
    label = `Q${qi + 1} FY${String(fyStart % 100).padStart(2, '0')}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  } else if (p === 'this_fy') {
    const fy = m >= 3 ? y : y - 1;
    from = istMidnight(fy, 3, 1);
    to = istMidnight(y, m, d + 1);
    label = `FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
  } else {
    to = istMidnight(y, m, d + 1);
    from = new Date(to.getTime() - 90 * 86400_000);
    label = 'Last 90 days';
  }
  const len = to.getTime() - from.getTime();
  // the comparison period: the same span right before (a whole previous month for month views)
  const prev =
    p === 'this_month' || p === 'last_month'
      ? { from: istMidnight(new Date(from.getTime() + IST).getUTCFullYear(), new Date(from.getTime() + IST).getUTCMonth() - 1, 1), to: from }
      : { from: new Date(from.getTime() - len), to: from };
  return { from, to, label, prev };
}

type Num = number | null;
interface Range {
  from: Date;
  to: Date;
}

const can = (ctx: RecordCtx, o: string) => ctx.meta.objects.some((x) => x.key === o) && objectPerm(ctx.principal.permissions, o).read !== 'none';

async function q1(ctx: RecordCtx, object: string, sql: (vis: string, p: Params) => string, bind: (p: Params) => void = () => undefined): Promise<Record<string, unknown> | null> {
  if (!can(ctx, object)) return null;
  const p = new Params();
  bind(p);
  const vis = visibilityWhere(ctx, object, p).join(' and ');
  return ctx.tx.one<Record<string, unknown>>(sql(vis, p), p.values);
}
const n = (v: unknown): Num => (v === null || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pct = (a: unknown, b: unknown): Num => (Number(b) > 0 ? Math.round((Number(a) / Number(b)) * 1000) / 10 : null);
const OPEN = `coalesce((select st.category from pipeline_stages st where st.tenant_id = r.tenant_id and st.id = r.stage_id), 'open')`;
const TOUCH = `('call','email','whatsapp','sms','meeting','instagram')`;
const REFERRAL = `('referral','architect','interior_designer','dealer','partner')`;

type Fn = (ctx: RecordCtx, r: Range) => Promise<Num>;

const span = (p: Params, r: Range) => [p.add(r.from.toISOString()), p.add(r.to.toISOString())] as const;

const FNS: Record<string, Fn> = {
  async leads_new(ctx, r) {
    const row = await q1(ctx, 'lead', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*)::int as v from leads r where ${vis} and r.created_at >= ${a} and r.created_at < ${b}`;
    });
    return row ? n(row.v) : null;
  },
  async lead_response_minutes(ctx, r) {
    const row = await q1(ctx, 'lead', (vis, p) => {
      const [a, b] = span(p, r);
      return `select percentile_cont(0.5) within group (order by extract(epoch from (x.ft - x.created_at)) / 60) as v from (
                select r.created_at, (select min(a.occurred_at) from activities a where a.tenant_id = r.tenant_id and a.related_object = 'lead' and a.related_id = r.id and a.direction = 'out' and a.kind in ${TOUCH}) as ft
                  from leads r where ${vis} and r.created_at >= ${a} and r.created_at < ${b}) x where x.ft is not null and x.ft >= x.created_at`;
    });
    return row && row.v !== null ? Math.round(Number(row.v)) : null;
  },
  async lead_conversion_rate(ctx, r) {
    const row = await q1(ctx, 'lead', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where r.converted_at is not null)::int as c, count(*)::int as t from leads r where ${vis} and r.created_at >= ${a} and r.created_at < ${b}`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async referral_share(ctx, r) {
    const row = await q1(ctx, 'lead', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where r.source in ${REFERRAL})::int as c, count(*)::int as t from leads r where ${vis} and r.created_at >= ${a} and r.created_at < ${b}`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async quote_lead_days(ctx, r) {
    if (!can(ctx, 'quote')) return null;
    const row = await q1(ctx, 'deal', (vis, p) => {
      const [a, b] = span(p, r);
      return `select percentile_cont(0.5) within group (order by extract(epoch from (x.fq - x.created_at)) / 86400) as v from (
                select r.created_at, (select min(qq.created_at) from quotes qq where qq.tenant_id = r.tenant_id and qq.deal_id = r.id and qq.deleted_at is null) as fq from deals r where ${vis}) x
               where x.fq >= ${a} and x.fq < ${b}`;
    });
    return row && row.v !== null ? Math.round(Number(row.v) * 10) / 10 : null;
  },
  async quote_acceptance_rate(ctx, r) {
    const row = await q1(ctx, 'quote', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where r.status = 'accepted' and r.accepted_at >= ${a} and r.accepted_at < ${b})::int as c,
                     count(*) filter (where (r.status = 'accepted' and r.accepted_at >= ${a} and r.accepted_at < ${b}) or (r.status in ('rejected','expired') and r.updated_at >= ${a} and r.updated_at < ${b}))::int as t
                from quotes r where ${vis}`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async win_rate(ctx, r) {
    const row = await q1(ctx, 'deal', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where ${OPEN} = 'won')::int as w, count(*) filter (where ${OPEN} in ('won','lost'))::int as t from deals r where ${vis} and r.closed_at >= ${a} and r.closed_at < ${b}`;
    });
    return row ? pct(row.w, row.t) : null;
  },
  async avg_deal_size(ctx, r) {
    const row = await q1(ctx, 'deal', (vis, p) => {
      const [a, b] = span(p, r);
      return `select avg(r.amount)::float8 as v from deals r where ${vis} and ${OPEN} = 'won' and r.closed_at >= ${a} and r.closed_at < ${b}`;
    });
    return row && row.v !== null ? Math.round(Number(row.v)) : null;
  },
  async sales_cycle_days(ctx, r) {
    const row = await q1(ctx, 'deal', (vis, p) => {
      const [a, b] = span(p, r);
      return `select avg(extract(epoch from (r.closed_at - r.created_at)) / 86400)::float8 as v from deals r where ${vis} and ${OPEN} = 'won' and r.closed_at >= ${a} and r.closed_at < ${b}`;
    });
    return row && row.v !== null ? Math.round(Number(row.v) * 10) / 10 : null;
  },
  async revenue_won(ctx, r) {
    const row = await q1(ctx, 'deal', (vis, p) => {
      const [a, b] = span(p, r);
      return `select coalesce(sum(r.amount), 0)::float8 as v from deals r where ${vis} and ${OPEN} = 'won' and r.closed_at >= ${a} and r.closed_at < ${b}`;
    });
    return row ? n(row.v) : null;
  },
  async pipeline_coverage(ctx, r) {
    const open = await q1(ctx, 'deal', (vis) => `select coalesce(sum(r.amount), 0)::float8 as v from deals r where ${vis} and ${OPEN} = 'open'`);
    if (!open) return null;
    const target = await ctx.tx.one<{ target: string }>(`select target from kpi_targets where tenant_id = $1 and kpi = 'revenue_won'`, [ctx.tenantId]);
    let denom = target ? Number(target.target) : 0;
    if (!denom) {
      // no revenue target: compare with what was actually won in a typical month lately
      const won = await FNS.revenue_won!(ctx, { from: new Date(r.to.getTime() - 90 * 86400_000), to: r.to });
      denom = (won ?? 0) / 3;
    }
    return denom > 0 ? Math.round((Number(open.v) / denom) * 10) / 10 : null;
  },
  async sales_velocity(ctx, r) {
    const back = { from: new Date(r.to.getTime() - 90 * 86400_000), to: r.to };
    // one connection: queries run one after another
    const wr = await FNS.win_rate!(ctx, back);
    const size = await FNS.avg_deal_size!(ctx, back);
    const cycle = await FNS.sales_cycle_days!(ctx, back);
    const open = await q1(ctx, 'deal', (vis) => `select count(*)::int as v from deals r where ${vis} and ${OPEN} = 'open'`);
    if (!open || wr === null || size === null || !cycle) return null;
    return Math.round((Number(open.v) * (wr / 100) * size) / cycle);
  },
  async orders_booked(ctx, r) {
    if (!enabledApps(ctx.meta).has('orders')) return null;
    const row = await q1(ctx, 'sales_order', (vis, p) => {
      const [a, b] = span(p, r);
      return `select coalesce(sum(r.grand_total), 0)::float8 as v from sales_orders r where ${vis} and r.status not in ('draft','cancelled') and r.created_at >= ${a} and r.created_at < ${b}`;
    });
    return row ? n(row.v) : null;
  },
  async on_time_delivery(ctx, r) {
    if (!enabledApps(ctx.meta).has('delivery')) return null;
    const row = await q1(ctx, 'shipment', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where (r.delivered_at at time zone 'Asia/Kolkata')::date <= r.planned_date)::int as c, count(*)::int as t
                from shipments r where ${vis} and r.delivered_at >= ${a} and r.delivered_at < ${b} and r.planned_date is not null`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async install_first_time_right(ctx, r) {
    if (!enabledApps(ctx.meta).has('delivery')) return null;
    const row = await q1(ctx, 'installation', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where not exists (select 1 from tickets t where t.tenant_id = r.tenant_id and t.sales_order_id = r.sales_order_id and t.deleted_at is null
                                                         and t.category in ('installation','defect','damage') and t.created_at between r.completed_at and r.completed_at + interval '30 days'))::int as c,
                     count(*)::int as t
                from installations r where ${vis} and r.status = 'completed' and r.completed_at >= ${a} and r.completed_at < ${b}`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async collected(ctx, r) {
    if (!enabledApps(ctx.meta).has('billing')) return null;
    const row = await q1(ctx, 'payment', (vis, p) => {
      const [a, b] = span(p, r);
      return `select coalesce(sum(r.amount), 0)::float8 as v from payments r where ${vis} and r.status = 'received' and r.payment_date >= (${a}::timestamptz at time zone 'Asia/Kolkata')::date and r.payment_date < (${b}::timestamptz at time zone 'Asia/Kolkata')::date`;
    });
    return row ? n(row.v) : null;
  },
  async dso_days(ctx, r) {
    if (!enabledApps(ctx.meta).has('billing')) return null;
    const row = await q1(ctx, 'invoice', (vis, p) => {
      const b = p.add(r.to.toISOString());
      return `select coalesce(sum(r.balance_due) filter (where r.status in ('issued','partially_paid')), 0)::float8 as ar,
                     coalesce(sum(r.grand_total) filter (where r.status <> 'cancelled' and r.invoice_date >= ((${b}::timestamptz - interval '90 days') at time zone 'Asia/Kolkata')::date and r.invoice_date < (${b}::timestamptz at time zone 'Asia/Kolkata')::date), 0)::float8 as billed
                from invoices r where ${vis} and r.doc_type = 'tax_invoice' and r.status <> 'draft'`;
    });
    return row && Number(row.billed) > 0 ? Math.round((Number(row.ar) / Number(row.billed)) * 90) : null;
  },
  async collection_efficiency(ctx, r) {
    if (!enabledApps(ctx.meta).has('billing')) return null;
    const row = await q1(ctx, 'invoice', (vis, p) => {
      const [a, b] = span(p, r);
      return `select coalesce(sum(r.grand_total - r.balance_due), 0)::float8 as paid, coalesce(sum(r.grand_total), 0)::float8 as due
                from invoices r where ${vis} and r.doc_type = 'tax_invoice' and r.status not in ('draft','cancelled')
                 and r.due_date >= (${a}::timestamptz at time zone 'Asia/Kolkata')::date and r.due_date < (${b}::timestamptz at time zone 'Asia/Kolkata')::date`;
    });
    return row ? pct(row.paid, row.due) : null;
  },
  async overdue_share(ctx) {
    if (!enabledApps(ctx.meta).has('billing')) return null;
    const row = await q1(
      ctx,
      'invoice',
      (vis) => `select coalesce(sum(r.balance_due) filter (where r.due_date < (now() at time zone 'Asia/Kolkata')::date), 0)::float8 as o, coalesce(sum(r.balance_due), 0)::float8 as t
                  from invoices r where ${vis} and r.doc_type = 'tax_invoice' and r.status in ('issued','partially_paid')`,
    );
    return row ? (Number(row.t) > 0 ? pct(row.o, row.t) : 0) : null;
  },
  async sla_compliance(ctx, r) {
    if (!enabledApps(ctx.meta).has('service')) return null;
    const row = await q1(ctx, 'ticket', (vis, p) => {
      const [a, b] = span(p, r);
      return `select count(*) filter (where not r.sla_breached)::int as c, count(*)::int as t from tickets r where ${vis} and r.resolved_at >= ${a} and r.resolved_at < ${b}`;
    });
    return row ? pct(row.c, row.t) : null;
  },
  async ticket_first_response_hours(ctx, r) {
    if (!enabledApps(ctx.meta).has('service')) return null;
    const row = await q1(ctx, 'ticket', (vis, p) => {
      const [a, b] = span(p, r);
      return `select percentile_cont(0.5) within group (order by extract(epoch from (r.first_responded_at - r.created_at)) / 3600) as v from tickets r
               where ${vis} and r.created_at >= ${a} and r.created_at < ${b} and r.first_responded_at is not null`;
    });
    return row && row.v !== null ? Math.round(Number(row.v) * 10) / 10 : null;
  },
  async csat(ctx, r) {
    if (!enabledApps(ctx.meta).has('service')) return null;
    const row = await q1(ctx, 'ticket', (vis, p) => {
      const [a, b] = span(p, r);
      return `select avg(r.satisfaction)::float8 as v from tickets r where ${vis} and r.satisfaction is not null and r.resolved_at >= ${a} and r.resolved_at < ${b}`;
    });
    return row && row.v !== null ? Math.round(Number(row.v) * 10) / 10 : null;
  },
  async chat_response_minutes(ctx, r) {
    const admin = hasAdmin(ctx.principal.permissions, 'channels');
    const row = await ctx.tx.one<{ v: string | null }>(
      `select percentile_cont(0.5) within group (order by extract(epoch from (c.first_response_at - c.created_at)) / 60) as v from conversations c
        where c.tenant_id = $1 and c.created_at >= $2 and c.created_at < $3 and c.first_response_at is not null ${admin ? '' : 'and c.assigned_to = $4'}`,
      admin ? [ctx.tenantId, r.from, r.to] : [ctx.tenantId, r.from, r.to, ctx.principal.user.id],
    );
    return row?.v !== null && row?.v !== undefined ? Math.round(Number(row.v)) : null;
  },
  async campaign_read_rate(ctx, r) {
    if (!hasAdmin(ctx.principal.permissions, 'campaigns')) return null;
    const row = await ctx.tx.one<{ c: number; t: number }>(
      `select count(*) filter (where status = 'read')::int as c, count(*) filter (where status in ('sent','delivered','read'))::int as t from messages where tenant_id = $1 and campaign_id is not null and channel = 'whatsapp' and created_at >= $2 and created_at < $3`,
      [ctx.tenantId, r.from, r.to],
    );
    return row ? pct(row.c, row.t) : null;
  },
};

/** KPIs measured "as of now" (no meaningful previous period). */
const POINT_IN_TIME = new Set(['overdue_share', 'pipeline_coverage', 'sales_velocity']);

function judge(key: string, value: Num, target: Num): 'good' | 'warn' | 'bad' | null {
  if (value === null || target === null) return null;
  const d = KPI_BY_KEY[key];
  if (!d) return null;
  if (d.better === 'higher') return value >= target ? 'good' : value >= target * 0.85 ? 'warn' : 'bad';
  return value <= target ? 'good' : value <= target * 1.25 ? 'warn' : 'bad';
}

export async function kpiTargets(ctx: RecordCtx) {
  const rows = await ctx.tx.query<{ kpi: string; target: string }>(`select kpi, target from kpi_targets where tenant_id = $1`, [ctx.tenantId]);
  return new Map(rows.map((r) => [r.kpi, Number(r.target)]));
}

export async function businessHealth(ctx: RecordCtx, period: Period) {
  const range = periodRange(period);
  const targets = await kpiTargets(ctx);
  const items: { key: string; value: Num; previous: Num; target: Num; status: ReturnType<typeof judge> }[] = [];
  for (const k of KPIS) {
    const fn = FNS[k.key];
    if (!fn) continue;
    const value = await fn(ctx, range);
    if (value === null && !targets.has(k.key)) continue;
    const previous = POINT_IN_TIME.has(k.key) ? null : await fn(ctx, range.prev);
    const target = targets.get(k.key) ?? null;
    items.push({ key: k.key, value, previous, target, status: judge(k.key, value, target) });
  }
  return { period: { key: period, label: range.label, from: range.from, to: range.to, prevFrom: range.prev.from, prevTo: range.prev.to }, items, value: await valueDelivered(ctx, range) };
}

/** Six calendar months of a few KPIs, for sparklines. */
export async function kpiTrend(ctx: RecordCtx, keys: string[]) {
  const local = new Date(Date.now() + IST);
  const months: { label: string; from: Date; to: Date }[] = [];
  for (let i = 5; i >= 0; i--) {
    const y = local.getUTCFullYear();
    const m = local.getUTCMonth() - i;
    const from = istMidnight(y, m, 1);
    const to = i === 0 ? istMidnight(y, local.getUTCMonth(), local.getUTCDate() + 1) : istMidnight(y, m + 1, 1);
    months.push({ label: new Date(from.getTime() + IST).toISOString().slice(0, 7), from, to });
  }
  const series: Record<string, Num[]> = {};
  for (const k of keys.filter((x) => FNS[x] && !POINT_IN_TIME.has(x)).slice(0, 30)) {
    series[k] = [];
    for (const mo of months) series[k]!.push(await FNS[k]!(ctx, mo));
  }
  return { months: months.map((m) => m.label), series };
}

/** What the system did for the business in the period: measured, not estimated. */
async function valueDelivered(ctx: RecordCtx, r: Range) {
  const out: { key: string; label: string; value: number; format: 'number' | 'money' }[] = [];
  const auto = await q1(ctx, 'lead', (vis, p) => {
    const [a, b] = span(p, r);
    return `select count(*) filter (where r.source in ('website','whatsapp','instagram','facebook','google_ads','phone_call'))::int as v from leads r where ${vis} and r.created_at >= ${a} and r.created_at < ${b}`;
  });
  if (auto) out.push({ key: 'auto_leads', label: 'Leads captured automatically (forms, ads, WhatsApp, calls)', value: Number(auto.v), format: 'number' });
  const fu = await q1(ctx, 'lead', (vis, p) => {
    const [a, b] = span(p, r);
    return `select count(*)::int as v from leads r where ${vis} and r.follow_up_reminded_at >= ${a} and r.follow_up_reminded_at < ${b}`;
  });
  if (fu) out.push({ key: 'follow_ups', label: 'Follow-up reminders sent on time', value: Number(fu.v), format: 'number' });
  if (enabledApps(ctx.meta).has('billing') && can(ctx, 'payment')) {
    const online = await ctx.tx.one<{ v: number }>(`select coalesce(sum(amount_paid), 0)::float8 as v from payment_links where tenant_id = $1 and paid_at >= $2 and paid_at < $3`, [ctx.tenantId, r.from, r.to]);
    out.push({ key: 'paid_online', label: 'Collected through payment links', value: Number(online?.v ?? 0), format: 'money' });
  }
  if (hasAdmin(ctx.principal.permissions, 'channels')) {
    const chats = await ctx.tx.one<{ v: number }>(`select count(*)::int as v from messages where tenant_id = $1 and direction = 'in' and channel in ('whatsapp','instagram') and created_at >= $2 and created_at < $3`, [ctx.tenantId, r.from, r.to]);
    out.push({ key: 'chats', label: 'Customer messages handled in the inbox', value: Number(chats?.v ?? 0), format: 'number' });
  }
  const consents = await ctx.tx.one<{ v: number }>(`select count(distinct subject_id)::int as v from consent_events where tenant_id = $1 and granted and created_at >= $2 and created_at < $3`, [ctx.tenantId, r.from, r.to]);
  out.push({ key: 'consents', label: 'People who agreed to hear from you', value: Number(consents?.v ?? 0), format: 'number' });
  return out;
}
