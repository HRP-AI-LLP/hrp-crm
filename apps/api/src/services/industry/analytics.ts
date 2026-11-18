/**
 * Sales analytics for management: sales by product and by region / territory, order fulfilment
 * (on time, in full), repeat-order behaviour, seasonality (month by month across years) and
 * forecast against actual. Figures are invoiced value before GST, net of credit notes.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { forbidden } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { r2 } from './core';

const num = (v: unknown) => Number(v ?? 0) || 0;

export function assertAnalytics(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'analytics') || hasAdmin(p, 'books') || hasAdmin(p, 'billing') || objectPerm(p, 'invoice').read === 'all') return;
  throw forbidden('Sales analytics needs the "Sales analytics" permission');
}

const SALES = `from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.order_id
  where l.tenant_id = $1 and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date between $2::date and $3::date`;
const SIGN = `case when i.doc_type = 'credit_note' then -1 else 1 end`;

export async function salesByProduct(ctx: RecordCtx, q: { from: string; to: string }) {
  assertAnalytics(ctx);
  const rows = await ctx.tx.query<{ key: string; family: string | null; qty: string; value: string; customers: number; orders: number }>(
    `select coalesce(p.name, l.name) as key, p.family, sum(${SIGN} * l.quantity) as qty, sum(${SIGN} * l.line_subtotal * coalesce(i.exchange_rate, 1)) as value,
            count(distinct i.account_id)::int as customers, count(distinct i.id)::int as orders
       ${SALES.replace('where', 'left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where')}
      group by 1, 2 order by value desc limit 200`,
    [ctx.tenantId, q.from, q.to],
  );
  const total = rows.reduce((s, r) => s + num(r.value), 0);
  const fam = new Map<string, number>();
  for (const r of rows) fam.set(r.family ?? '(no family)', (fam.get(r.family ?? '(no family)') ?? 0) + num(r.value));
  return {
    total: r2(total),
    rows: rows.map((r) => ({ product: r.key, family: r.family, qty: num(r.qty), value: r2(num(r.value)), share: total ? Math.round((num(r.value) / total) * 1000) / 10 : 0, customers: r.customers, invoices: r.orders })),
    byFamily: [...fam.entries()].map(([family, value]) => ({ family, value: r2(value) })).sort((a, b) => b.value - a.value),
  };
}

export async function salesByRegion(ctx: RecordCtx, q: { from: string; to: string; by: 'state' | 'city' | 'territory' }) {
  assertAnalytics(ctx);
  const col = q.by === 'city' ? 'a.city' : q.by === 'territory' ? 'a.territory' : `coalesce(nullif(i.buyer_state, ''), a.state)`;
  const rows = await ctx.tx.query<{ key: string | null; value: string; customers: number; invoices: number }>(
    `select ${col} as key, sum(${SIGN} * i.taxable_total * coalesce(i.exchange_rate, 1)) as value, count(distinct i.account_id)::int as customers, count(*)::int as invoices
       from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date between $2::date and $3::date
      group by 1 order by value desc limit 200`,
    [ctx.tenantId, q.from, q.to],
  );
  const total = rows.reduce((s, r) => s + num(r.value), 0);
  return { by: q.by, total: r2(total), rows: rows.map((r) => ({ region: r.key || '(not set)', value: r2(num(r.value)), share: total ? Math.round((num(r.value) / total) * 1000) / 10 : 0, customers: r.customers, invoices: r.invoices })) };
}

/** On time = delivered on or before the expected date; in full = every line fully delivered. */
export async function fulfilment(ctx: RecordCtx, q: { from: string; to: string }) {
  assertAnalytics(ctx);
  const rows = await ctx.tx.query<{ id: string; order_number: string; account: string | null; order_date: string; expected: string | null; delivered: string | null; qty: string; done: string; lines: number; full_lines: number; status: string }>(
    `select o.id, o.order_number, a.name as account, o.order_date::text, o.expected_delivery_date::text as expected,
            (select max(s.delivered_at)::date::text from shipments s where s.tenant_id = o.tenant_id and s.sales_order_id = o.id and s.deleted_at is null and s.delivered_at is not null) as delivered,
            coalesce((select sum(quantity) from sales_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id), 0) as qty,
            coalesce((select sum(least(delivered_qty, quantity)) from sales_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id), 0) as done,
            (select count(*)::int from sales_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id) as lines,
            (select count(*)::int from sales_order_lines l where l.tenant_id = o.tenant_id and l.order_id = o.id and l.delivered_qty >= l.quantity) as full_lines, o.status
       from sales_orders o left join accounts a on a.tenant_id = o.tenant_id and a.id = o.account_id
      where o.tenant_id = $1 and o.deleted_at is null and o.status not in ('draft','cancelled') and o.order_date between $2::date and $3::date`,
    [ctx.tenantId, q.from, q.to],
  );
  const today = new Date().toISOString().slice(0, 10);
  let onTime = 0;
  let inFull = 0;
  let otif = 0;
  let late = 0;
  let measured = 0;
  const leadDays: number[] = [];
  const lateList = [];
  for (const r of rows) {
    const full = r.lines > 0 && r.full_lines === r.lines;
    if (full) inFull++;
    if (!r.expected) continue;
    if (r.delivered) {
      measured++;
      const ok = r.delivered <= r.expected;
      if (ok) onTime++;
      else late++;
      if (ok && full) otif++;
      leadDays.push(Math.round((Date.parse(r.delivered) - Date.parse(r.order_date)) / 86_400_000));
    } else if (r.expected < today) {
      measured++;
      late++;
      lateList.push({ id: r.id, number: r.order_number, account: r.account, expected: r.expected, daysLate: Math.round((Date.parse(today) - Date.parse(r.expected)) / 86_400_000), fillPct: num(r.qty) ? Math.round((num(r.done) / num(r.qty)) * 100) : 0 });
    }
  }
  const qty = rows.reduce((s, r) => s + num(r.qty), 0);
  const done = rows.reduce((s, r) => s + num(r.done), 0);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    orders: rows.length,
    measured,
    onTimePct: pct(onTime, measured),
    inFullPct: pct(inFull, rows.length),
    otifPct: pct(otif, measured),
    fillRatePct: pct(done, qty),
    avgLeadDays: leadDays.length ? Math.round(leadDays.reduce((a, b) => a + b, 0) / leadDays.length) : null,
    late,
    lateOpen: lateList.sort((a, b) => b.daysLate - a.daysLate).slice(0, 30),
  };
}

/** How often customers come back: repeat rate, gaps between orders, customers going quiet. */
export async function repeatOrders(ctx: RecordCtx, q: { from: string; to: string }) {
  assertAnalytics(ctx);
  const rows = await ctx.tx.query<{ account_id: string; name: string; orders: number; value: string; first: string; last: string; avg_gap: string | null }>(
    `with o as (
       select i.account_id, i.invoice_date, i.taxable_total * coalesce(i.exchange_rate, 1) as v,
              i.invoice_date - lag(i.invoice_date) over (partition by i.account_id order by i.invoice_date) as gap
         from invoices i where i.tenant_id = $1 and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status not in ('draft','cancelled') and i.invoice_date between $2::date and $3::date and i.account_id is not null)
     select o.account_id, a.name, count(*)::int as orders, sum(o.v) as value, min(o.invoice_date)::text as first, max(o.invoice_date)::text as last, avg(o.gap) as avg_gap
       from o join accounts a on a.tenant_id = $1 and a.id = o.account_id group by o.account_id, a.name order by orders desc, value desc`,
    [ctx.tenantId, q.from, q.to],
  );
  const repeat = rows.filter((r) => r.orders > 1);
  const total = rows.reduce((s, r) => s + num(r.value), 0);
  const repeatValue = repeat.reduce((s, r) => s + num(r.value), 0);
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  // usually buys every N days but has not for twice that
  const quiet = repeat
    .filter((r) => r.avg_gap && today - Date.parse(r.last) > 2 * num(r.avg_gap) * 86_400_000)
    .map((r) => ({ accountId: r.account_id, name: r.name, last: r.last, usualGapDays: Math.round(num(r.avg_gap)), daysSince: Math.round((today - Date.parse(r.last)) / 86_400_000), value: r2(num(r.value)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 25);
  const buckets = [1, 2, 3, 5, 10].map((n, i, a) => ({ label: i === a.length - 1 ? `${n}+` : a[i + 1]! - n === 1 ? `${n}` : `${n}–${a[i + 1]! - 1}`, n: rows.filter((r) => r.orders >= n && (i === a.length - 1 || r.orders < a[i + 1]!)).length }));
  return {
    customers: rows.length,
    repeatCustomers: repeat.length,
    repeatRatePct: rows.length ? Math.round((repeat.length / rows.length) * 1000) / 10 : null,
    repeatValueSharePct: total ? Math.round((repeatValue / total) * 1000) / 10 : null,
    avgGapDays: repeat.length ? Math.round(repeat.reduce((s, r) => s + num(r.avg_gap), 0) / repeat.length) : null,
    distribution: buckets,
    top: rows.slice(0, 20).map((r) => ({ accountId: r.account_id, name: r.name, orders: r.orders, value: r2(num(r.value)), last: r.last, avgGapDays: r.avg_gap ? Math.round(num(r.avg_gap)) : null })),
    goingQuiet: quiet,
  };
}

/** Month-by-month sales for each of the last few financial years (April to March). */
export async function seasonality(ctx: RecordCtx, years: number) {
  assertAnalytics(ctx);
  const rows = await ctx.tx.query<{ fy: number; m: number; value: string }>(
    `select (extract(year from invoice_date)::int - case when extract(month from invoice_date) < 4 then 1 else 0 end) as fy, extract(month from invoice_date)::int as m,
            sum(case when doc_type = 'credit_note' then -1 else 1 end * taxable_total * coalesce(exchange_rate, 1)) as value
       from invoices where tenant_id = $1 and deleted_at is null and doc_type <> 'proforma' and status not in ('draft','cancelled')
        and invoice_date >= make_date((extract(year from current_date)::int - case when extract(month from current_date) < 4 then 1 else 0 end) - $2 + 1, 4, 1)
      group by 1, 2`,
    [ctx.tenantId, years],
  );
  const months = [4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3];
  const fys = [...new Set(rows.map((r) => r.fy))].sort();
  const series = fys.map((fy) => ({ fy: `FY ${String(fy).slice(2)}-${String((fy + 1) % 100).padStart(2, '0')}`, values: months.map((m) => r2(num(rows.find((r) => r.fy === fy && r.m === m)?.value))) }));
  // seasonal index: each month's share against an even year (100 = average month)
  const avgByMonth = months.map((_, i) => series.reduce((s, x) => s + x.values[i]!, 0) / Math.max(1, series.length));
  const mean = avgByMonth.reduce((a, b) => a + b, 0) / 12;
  return {
    months: months.map((m) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })),
    series,
    index: avgByMonth.map((v) => (mean ? Math.round((v / mean) * 100) : 0)),
  };
}

/** Each month: what the pipeline said (weighted, expected to close then) against what was won and billed. */
export async function forecastVsActual(ctx: RecordCtx, months: number) {
  assertAnalytics(ctx);
  const rows = await ctx.tx.query<{ m: string; weighted: string; best: string; won: string; billed: string }>(
    `with m as (select to_char(d, 'YYYY-MM') as m, d::date as start, (d + interval '1 month' - interval '1 day')::date as stop
                  from generate_series(date_trunc('month', current_date) - make_interval(months => $2 - 1), date_trunc('month', current_date) + interval '2 months', interval '1 month') d)
     select m.m,
            (select coalesce(sum(d.amount * coalesce(d.probability, s.probability, 0) / 100.0), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
              where d.tenant_id = $1 and d.deleted_at is null and d.close_date between m.start and m.stop and (s.category = 'open' or (s.category = 'won' and d.closed_at::date between m.start and m.stop))) as weighted,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
              where d.tenant_id = $1 and d.deleted_at is null and d.close_date between m.start and m.stop and s.category <> 'lost') as best,
            (select coalesce(sum(d.amount), 0) from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
              where d.tenant_id = $1 and d.deleted_at is null and s.category = 'won' and d.closed_at::date between m.start and m.stop) as won,
            (select coalesce(sum(case when i.doc_type = 'credit_note' then -1 else 1 end * i.taxable_total * coalesce(i.exchange_rate, 1)), 0) from invoices i
              where i.tenant_id = $1 and i.deleted_at is null and i.doc_type <> 'proforma' and i.status not in ('draft','cancelled') and i.invoice_date between m.start and m.stop) as billed
       from m order by m.m`,
    [ctx.tenantId, months],
  );
  const cur = new Date().toISOString().slice(0, 7);
  const past = rows.filter((r) => r.m < cur && num(r.weighted) > 0);
  const accuracy = past.length ? Math.round((past.reduce((s, r) => s + Math.min(num(r.won), num(r.weighted)) / Math.max(num(r.won), num(r.weighted)), 0) / past.length) * 1000) / 10 : null;
  return { rows: rows.map((r) => ({ month: r.m, forecast: r2(num(r.weighted)), bestCase: r2(num(r.best)), won: r2(num(r.won)), billed: r2(num(r.billed)), future: r.m > cur })), accuracyPct: accuracy };
}
