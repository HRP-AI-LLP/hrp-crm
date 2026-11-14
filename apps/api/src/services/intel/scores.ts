/**
 * Deterministic scores: deal risk and account health, from signals in the CRM (no AI needed).
 * Each factor names the object it comes from, so a viewer who cannot read invoices never sees
 * an invoice-based factor. Signals are computed set-wise so the hourly sweep stays cheap.
 */
import type { Tx } from '../../lib/db';

export interface Factor {
  label: string;
  impact: number;
  object: string;
}

export interface Score {
  objectKey: 'deal' | 'account';
  recordId: string;
  kind: 'deal_risk' | 'account_health';
  score: number;
  band: 'good' | 'watch' | 'bad';
  factors: Factor[];
  ownerId: string | null;
  title: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const TOUCH = `('call','email','whatsapp','sms','meeting')`;

interface DealSignals {
  id: string;
  name: string;
  owner_id: string | null;
  category: string;
  probability: number | null;
  close_date: Date | null;
  amount: string | null;
  created_at: Date;
  last_touch: Date | null;
  last_inbound: Date | null;
  stage_since: Date | null;
  next_step: boolean;
  has_contact: boolean;
  quotes: number;
  quote_accepted: boolean;
  quote_expired: boolean;
  competitors: number;
  negative: number;
}

export async function dealSignals(tx: Tx, tenantId: string, ids?: string[], limit = 400): Promise<DealSignals[]> {
  return tx.query<DealSignals>(
    `with d as (
       select r.* , coalesce(st.category, 'open') as category, coalesce(r.probability, st.probability) as prob
         from deals r left join pipeline_stages st on st.tenant_id = r.tenant_id and st.id = r.stage_id
        where r.tenant_id = $1 and r.deleted_at is null and ($2::uuid[] is null or r.id = any($2::uuid[]))
          and ($2::uuid[] is not null or coalesce(st.category, 'open') = 'open')
        order by r.updated_at desc limit $3)
     select d.id, d.name, d.owner_id, d.category, d.prob as probability, d.close_date, d.amount, d.created_at,
            (select max(a.occurred_at) from activities a where a.tenant_id = d.tenant_id and a.kind in ${TOUCH}
               and ((a.related_object = 'deal' and a.related_id = d.id) or (a.related_object = 'contact' and a.related_id = d.contact_id) or (a.related_object = 'account' and a.related_id = d.account_id))) as last_touch,
            (select max(a.occurred_at) from activities a where a.tenant_id = d.tenant_id and a.kind in ${TOUCH} and a.direction = 'in'
               and ((a.related_object = 'deal' and a.related_id = d.id) or (a.related_object = 'contact' and a.related_id = d.contact_id) or (a.related_object = 'account' and a.related_id = d.account_id))) as last_inbound,
            (select max(a.occurred_at) from activities a where a.tenant_id = d.tenant_id and a.kind = 'stage_change' and a.related_object = 'deal' and a.related_id = d.id) as stage_since,
            (exists (select 1 from events e where e.tenant_id = d.tenant_id and e.status = 'scheduled' and e.starts_at > now() and e.related_object in ('deal','account','contact') and e.related_id in (d.id, d.account_id, d.contact_id))
              or exists (select 1 from tasks t where t.tenant_id = d.tenant_id and t.status not in ('done','cancelled') and t.related_object = 'deal' and t.related_id = d.id)
              or exists (select 1 from action_items i where i.tenant_id = d.tenant_id and i.status in ('open','in_progress') and i.related_object = 'deal' and i.related_id = d.id)) as next_step,
            d.contact_id is not null as has_contact,
            (select count(*)::int from quotes q where q.tenant_id = d.tenant_id and q.deal_id = d.id and q.deleted_at is null) as quotes,
            exists (select 1 from quotes q where q.tenant_id = d.tenant_id and q.deal_id = d.id and q.status = 'accepted') as quote_accepted,
            exists (select 1 from quotes q where q.tenant_id = d.tenant_id and q.deal_id = d.id and q.status in ('sent','expired') and q.valid_until < current_date) as quote_expired,
            (select count(*)::int from deal_competitors c where c.tenant_id = d.tenant_id and c.deal_id = d.id and c.status = 'active') as competitors,
            (select count(*)::int from activities a where a.tenant_id = d.tenant_id and a.sentiment = 'negative' and a.occurred_at > now() - interval '30 days'
               and ((a.related_object = 'deal' and a.related_id = d.id) or (a.related_object = 'contact' and a.related_id = d.contact_id))) as negative
       from d`,
    [tenantId, ids ?? null, limit],
  );
}

const days = (d: Date | null, now: number) => (d ? Math.floor((now - new Date(d).getTime()) / 86_400_000) : null);

export function dealRisk(s: DealSignals, now = Date.now(), stalledDays = 14): Score {
  const f: Factor[] = [];
  const add = (label: string, impact: number, object = 'deal') => f.push({ label, impact, object });
  const touch = days(s.last_touch, now) ?? days(s.created_at, now) ?? 0;
  if (touch > stalledDays * 2) add(`No contact with the customer for ${touch} days`, 30, 'activity');
  else if (touch > stalledDays) add(`No contact with the customer for ${touch} days`, 18, 'activity');
  if (s.close_date) {
    const late = days(s.close_date, now)!;
    if (late > 0) add(`Expected close date passed ${late} day${late === 1 ? '' : 's'} ago`, 22);
    else if (late > -7 && (s.probability ?? 0) < 50) add('Closing this week but still early in the pipeline', 10);
  } else add('No expected close date', 6);
  const inStage = days(s.stage_since ?? s.created_at, now) ?? 0;
  if (inStage > 45) add(`In the same stage for ${inStage} days`, 14);
  else if (inStage > 25) add(`In the same stage for ${inStage} days`, 7);
  if (!s.next_step) add('No next step planned (meeting, task or action item)', 12);
  if (!s.has_contact) add('No contact person on the deal', 5, 'contact');
  if ((s.probability ?? 0) >= 50 && s.quotes === 0) add('Late stage but no quote sent', 10, 'quote');
  if (s.quote_expired && !s.quote_accepted) add('Quote has expired', 10, 'quote');
  if (s.competitors > 0) add(`Competing against ${s.competitors} other supplier${s.competitors > 1 ? 's' : ''}`, 8);
  if (s.negative > 0) add('Negative tone in recent conversations', 14, 'activity');
  const inbound = days(s.last_inbound, now);
  if (inbound !== null && inbound <= 7) add('Customer replied in the last week', -12, 'activity');
  if (s.quote_accepted) add('Quote accepted', -18, 'quote');
  const score = clamp(10 + f.reduce((a, x) => a + x.impact, 0));
  return { objectKey: 'deal', recordId: s.id, kind: 'deal_risk', score, band: score < 35 ? 'good' : score < 60 ? 'watch' : 'bad', factors: f.sort((a, b) => b.impact - a.impact), ownerId: s.owner_id, title: s.name };
}

interface AccountSignals {
  id: string;
  name: string;
  owner_id: string | null;
  open_tickets: number;
  breached: number;
  csat: string | null;
  overdue_invoices: number;
  last_touch: Date | null;
  won_12m: number;
  negative: number;
  orders: number;
}

export async function accountSignals(tx: Tx, tenantId: string, ids?: string[], limit = 400): Promise<AccountSignals[]> {
  return tx.query<AccountSignals>(
    `with a as (
       select r.* from accounts r where r.tenant_id = $1 and r.deleted_at is null and ($2::uuid[] is null or r.id = any($2::uuid[]))
          and ($2::uuid[] is not null or exists (select 1 from sales_orders o where o.tenant_id = r.tenant_id and o.account_id = r.id and o.deleted_at is null)
               or exists (select 1 from deals dd join pipeline_stages st on st.tenant_id = dd.tenant_id and st.id = dd.stage_id where dd.tenant_id = r.tenant_id and dd.account_id = r.id and st.category = 'won'))
        order by r.updated_at desc limit $3)
     select a.id, a.name, a.owner_id,
            (select count(*)::int from tickets t where t.tenant_id = a.tenant_id and t.account_id = a.id and t.deleted_at is null and t.status not in ('resolved','closed')) as open_tickets,
            (select count(*)::int from tickets t where t.tenant_id = a.tenant_id and t.account_id = a.id and t.deleted_at is null and t.sla_breached and t.created_at > now() - interval '90 days') as breached,
            (select avg(t.satisfaction)::numeric(4,2) from tickets t where t.tenant_id = a.tenant_id and t.account_id = a.id and t.satisfaction is not null and t.created_at > now() - interval '365 days') as csat,
            (select count(*)::int from invoices i where i.tenant_id = a.tenant_id and i.account_id = a.id and i.deleted_at is null and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid') and i.due_date < current_date and i.balance_due > 0) as overdue_invoices,
            (select max(x.occurred_at) from activities x where x.tenant_id = a.tenant_id and x.kind in ${TOUCH}
               and ((x.related_object = 'account' and x.related_id = a.id) or (x.related_object = 'contact' and x.related_id in (select c.id from contacts c where c.tenant_id = a.tenant_id and c.account_id = a.id))
                    or (x.related_object = 'deal' and x.related_id in (select d.id from deals d where d.tenant_id = a.tenant_id and d.account_id = a.id)))) as last_touch,
            (select count(*)::int from deals d join pipeline_stages st on st.tenant_id = d.tenant_id and st.id = d.stage_id where d.tenant_id = a.tenant_id and d.account_id = a.id and st.category = 'won' and d.closed_at > now() - interval '365 days') as won_12m,
            (select count(*)::int from activities x where x.tenant_id = a.tenant_id and x.sentiment = 'negative' and x.occurred_at > now() - interval '60 days' and x.related_object = 'account' and x.related_id = a.id) as negative,
            (select count(*)::int from sales_orders o where o.tenant_id = a.tenant_id and o.account_id = a.id and o.deleted_at is null) as orders
       from a`,
    [tenantId, ids ?? null, limit],
  );
}

export function accountHealth(s: AccountSignals, now = Date.now()): Score {
  const f: Factor[] = [];
  const add = (label: string, impact: number, object: string) => f.push({ label, impact, object });
  if (s.open_tickets) add(`${s.open_tickets} open service ticket${s.open_tickets > 1 ? 's' : ''}`, -Math.min(20, s.open_tickets * 6), 'ticket');
  if (s.breached) add(`${s.breached} ticket${s.breached > 1 ? 's' : ''} missed the SLA in 90 days`, -Math.min(20, s.breached * 10), 'ticket');
  if (s.csat !== null) {
    const c = Number(s.csat);
    if (c < 3) add(`Low satisfaction (${c}/5)`, -18, 'ticket');
    else if (c >= 4.5) add(`Very satisfied (${c}/5)`, 6, 'ticket');
  }
  if (s.overdue_invoices) add(`${s.overdue_invoices} overdue invoice${s.overdue_invoices > 1 ? 's' : ''}`, -Math.min(25, s.overdue_invoices * 10), 'invoice');
  const touch = days(s.last_touch, now);
  if (touch === null) add('No conversations recorded', -10, 'activity');
  else if (touch > 120) add(`No contact for ${touch} days`, -22, 'activity');
  else if (touch > 60) add(`No contact for ${touch} days`, -12, 'activity');
  if (s.won_12m) add(`${s.won_12m} deal${s.won_12m > 1 ? 's' : ''} won in the last year`, 6, 'deal');
  if (s.negative) add('Negative tone in recent conversations', -10, 'activity');
  const score = clamp(80 + f.reduce((a, x) => a + x.impact, 0));
  return { objectKey: 'account', recordId: s.id, kind: 'account_health', score, band: score >= 70 ? 'good' : score >= 45 ? 'watch' : 'bad', factors: f.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)), ownerId: s.owner_id, title: s.name };
}

export async function saveScores(tx: Tx, tenantId: string, scores: Score[]) {
  for (const s of scores) {
    await tx.query(
      `insert into record_scores (tenant_id, object_key, record_id, kind, score, band, factors, computed_at) values ($1,$2,$3,$4,$5,$6,$7, now())
       on conflict (tenant_id, object_key, record_id, kind) do update set score = excluded.score, band = excluded.band, factors = excluded.factors, computed_at = now()`,
      [tenantId, s.objectKey, s.recordId, s.kind, s.score, s.band, JSON.stringify(s.factors)],
    );
  }
}
