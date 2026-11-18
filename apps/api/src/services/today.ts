/**
 * Home: what needs the signed-in person today — their tasks and meetings, deals going quiet or past
 * their close date, GeM bids closing soon and, for the people who keep the books, money to chase,
 * bills to pay and work waiting in the accounts desk. And Customer 360: one customer's whole story.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { forbidden, notFound } from '../lib/errors';
import type { RecordCtx } from './records';

const has = (ctx: RecordCtx, obj: string) => ctx.meta.objects.some((o) => o.key === obj) && objectPerm(ctx.principal.permissions, obj).read !== 'none';

export async function today(ctx: RecordCtx) {
  const me = ctx.principal.user.id;
  const t = ctx.tenantId;
  const p = ctx.principal.permissions;
  const books = hasAdmin(p, 'books');
  const out: Record<string, unknown> = {};

  out.tasks = await ctx.tx.query(
    `select id, title, priority, to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI') as due, related_object, related_id,
            (due_at < now()) as overdue
       from tasks where tenant_id = $1 and assignee_id = $2 and status in ('open','in_progress') and due_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'
      order by due_at limit 12`,
    [t, me],
  );
  out.events = await ctx.tx.query(
    `select id, title, kind, starts_at, ends_at, location, related_object, related_id from events
      where tenant_id = $1 and status = 'scheduled' and (owner_id = $2 or attendees @> jsonb_build_array(jsonb_build_object('userId', $2::text)))
        and starts_at >= date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' and starts_at < (date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '1 day') at time zone 'Asia/Kolkata'
      order by starts_at limit 10`,
    [t, me],
  );
  if (has(ctx, 'deal')) {
    out.deals = await ctx.tx.query(
      `select d.id, d.name, d.amount::float8 as amount, to_char(d.close_date, 'YYYY-MM-DD') as close_date, s.label as stage,
              (select max(a.created_at) from activities a where a.tenant_id = d.tenant_id and a.related_object = 'deal' and a.related_id = d.id) as last_touch,
              case when d.close_date < current_date then 'past_close' else 'quiet' end as why
         from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
        where d.tenant_id = $1 and d.owner_id = $2 and s.category = 'open' and d.deleted_at is null
          and (d.close_date < current_date or coalesce((select max(a.created_at) from activities a where a.tenant_id = d.tenant_id and a.related_object = 'deal' and a.related_id = d.id), d.created_at) < now() - interval '14 days')
        order by d.amount desc nulls last limit 8`,
      [t, me],
    );
  }
  const gemOk = ['books', 'billing', 'projects', 'metadata'].some((k) => hasAdmin(p, k)) || objectPerm(p, 'deal').read !== 'none';
  if (gemOk)
    out.bids = await ctx.tx.query(
      `select id, bid_number, title, end_at, status, emd_amount::float8 as emd, matched_keywords from gem_bids
        where tenant_id = $1 and status in ('new','reviewing','preparing') and end_at between now() and now() + interval '7 days'
        order by end_at limit 8`,
      [t],
    );
  if (books) {
    out.overdue = await ctx.tx.query(
      `select i.id, i.invoice_number as number, coalesce(a.name, i.buyer_name) as party, i.balance_due::float8 as balance, to_char(i.due_date, 'YYYY-MM-DD') as due, (current_date - i.due_date)::int as days
         from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
        where i.tenant_id = $1 and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid') and i.deleted_at is null and i.balance_due > 0 and i.due_date < current_date
        order by i.balance_due desc limit 6`,
      [t],
    );
    out.billsDue = await ctx.tx.query(
      `select b.id, coalesce(v.name, '—') as vendor, b.balance_due::float8 as balance, to_char(b.due_date, 'YYYY-MM-DD') as due
         from bills b left join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
        where b.tenant_id = $1 and b.doc_type = 'bill' and b.status in ('open','partially_paid') and b.deleted_at is null and b.balance_due > 0 and b.due_date <= current_date + 7
        order by b.due_date limit 6`,
      [t],
    );
    out.desk = await ctx.tx.one(
      `select (select count(*)::int from bank_transactions where tenant_id = $1 and status = 'unmatched') as bank_lines,
              (select count(*)::int from doc_import_items where tenant_id = $1 and status in ('pending','failed')) as imports,
              (select count(*)::int from intake_items where tenant_id = $1 and status = 'new' and kind in ('bill','invoice','statement','payment')) as mail,
              (select count(*)::int from acct_proposals where tenant_id = $1 and status = 'pending') as proposals`,
      [t],
    );
  }
  return out;
}

/** Everything about one customer: money, work in progress and a single timeline. */
export async function customer360(ctx: RecordCtx, accountId: string) {
  if (!has(ctx, 'account')) throw forbidden();
  const t = ctx.tenantId;
  const a = await ctx.tx.one<{ id: string; name: string }>(`select id, name from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [t, accountId]);
  if (!a) throw notFound();
  const money = hasAdmin(ctx.principal.permissions, 'books') || hasAdmin(ctx.principal.permissions, 'billing') || has(ctx, 'invoice');
  const out: Record<string, unknown> = { id: a.id, name: a.name };
  if (money) {
    out.money = await ctx.tx.one(
      `select coalesce(sum(grand_total * coalesce(exchange_rate, 1)), 0)::float8 as invoiced,
              coalesce(sum((amount_paid) * coalesce(exchange_rate, 1)), 0)::float8 as received,
              coalesce(sum(balance_due * coalesce(exchange_rate, 1)) filter (where status in ('issued','partially_paid')), 0)::float8 as outstanding,
              coalesce(sum(balance_due * coalesce(exchange_rate, 1)) filter (where status in ('issued','partially_paid') and due_date < current_date), 0)::float8 as overdue,
              count(*)::int as invoices,
              (avg(case when status = 'paid' then (updated_at::date - invoice_date) end))::int as avg_days_to_pay
         from invoices where tenant_id = $1 and account_id = $2 and doc_type = 'tax_invoice' and status not in ('draft','cancelled') and deleted_at is null`,
      [t, accountId],
    );
  }
  out.deals = has(ctx, 'deal')
    ? await ctx.tx.query(
        `select d.id, d.name, d.amount::float8 as amount, s.label as stage, s.category from deals d join pipeline_stages s on s.tenant_id = d.tenant_id and s.id = d.stage_id
          where d.tenant_id = $1 and d.account_id = $2 and d.deleted_at is null order by (s.category = 'open') desc, d.created_at desc limit 10`,
        [t, accountId],
      )
    : [];
  out.projects = await ctx.tx.query(`select id, name, status from projects where tenant_id = $1 and account_id = $2 and deleted_at is null order by created_at desc limit 10`, [t, accountId]);
  out.contracts = await ctx.tx.query(
    `select id, name, kind, status, to_char(end_date, 'YYYY-MM-DD') as end_date, value::float8 as value, currency from service_contracts where tenant_id = $1 and account_id = $2 order by start_date desc limit 10`,
    [t, accountId],
  );
  out.contacts = await ctx.tx.query(
    `select id, trim(concat_ws(' ', first_name, last_name)) as name, email, phone, title from contacts where tenant_id = $1 and account_id = $2 and deleted_at is null order by created_at limit 12`,
    [t, accountId],
  );
  // one timeline: invoices, receipts, deals won or opened, contracts, activities
  out.timeline = await ctx.tx.query(
    `select * from (
       select 'invoice' as kind, i.id, i.invoice_date::timestamptz as at, concat('Invoice ', i.invoice_number) as title, i.grand_total::float8 as amount, i.status as note
         from invoices i where i.tenant_id = $1 and i.account_id = $2 and i.deleted_at is null and i.invoice_number is not null
       union all
       select 'payment', p.id, p.payment_date::timestamptz, concat('Payment received', coalesce(' · ' || p.payment_number, '')), p.amount::float8, p.mode
         from payments p where p.tenant_id = $1 and p.account_id = $2 and p.status <> 'void'
       union all
       select 'deal', d.id, d.created_at, concat('Deal: ', d.name), d.amount::float8, null from deals d where d.tenant_id = $1 and d.account_id = $2 and d.deleted_at is null
       union all
       select 'contract', c.id, c.start_date::timestamptz, concat('Contract: ', c.name), c.value::float8, c.status from service_contracts c where c.tenant_id = $1 and c.account_id = $2
       union all
       select 'activity', a.id, a.created_at, coalesce(a.subject, a.kind), null, a.kind from activities a where a.tenant_id = $1 and a.related_object = 'account' and a.related_id = $2 and a.kind <> 'system'
     ) x order by at desc nulls last limit 40`,
    [t, accountId],
  );
  return out;
}
