/**
 * SaaS subscriptions: plans (monthly to yearly, seats, metered usage, trials), customer subscriptions with
 * add-ons and discounts, upgrades / downgrades / seat changes, pause, cancel (now or at period end),
 * automatic renewal and GST invoicing in advance (usage in arrears), and the subscription metrics
 * (MRR, ARR, ARPA, churn, MRR movements) from the subscription history.
 */
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { RecordCtx, RecordEvent } from '../records';
import { addDays, addMonths, assertManager, assertReader, fyNumber, MONTHS, r2, raiseInvoice, today, type InvLine } from './common';

type Interval = 'month' | 'quarter' | 'half_year' | 'year';

export interface PlanInput {
  name: string;
  code?: string | null;
  product?: string | null;
  description?: string | null;
  interval: Interval;
  price: number;
  includedSeats?: number;
  seatPrice?: number;
  usageUnit?: string | null;
  includedUsage?: number;
  usagePrice?: number;
  trialDays?: number;
  taxRate?: number;
  hsnSac?: string | null;
  active?: boolean;
}

const PLAN_COLS = `id, name, code, product, description, interval, price::float8 as price, included_seats, seat_price::float8 as seat_price, usage_unit,
  included_usage::float8 as included_usage, usage_price::float8 as usage_price, trial_days, tax_rate::float8 as tax_rate, hsn_sac, active, created_at`;

export async function listPlans(ctx: RecordCtx) {
  assertReader(ctx);
  return ctx.tx.query(
    `select ${PLAN_COLS}, (select count(*)::int from saas_subscriptions s where s.tenant_id = p.tenant_id and s.plan_id = p.id and s.status in ('trial','active','past_due','paused')) as subscribers
       from saas_plans p where tenant_id = $1 order by active desc, product nulls last, price`,
    [ctx.tenantId],
  );
}

export async function savePlan(ctx: RecordCtx, id: string | null, input: PlanInput) {
  assertManager(ctx, 'subscription plans');
  const vals = [
    input.name, input.code ?? null, input.product ?? null, input.description ?? null, input.interval, input.price, input.includedSeats ?? 1, input.seatPrice ?? 0, input.usageUnit ?? null,
    input.includedUsage ?? 0, input.usagePrice ?? 0, input.trialDays ?? 0, input.taxRate ?? 18, input.hsnSac || '998315', input.active ?? true,
  ];
  if (id) {
    const r = await ctx.tx.one(
      `update saas_plans set name = $3, code = $4, product = $5, description = $6, interval = $7, price = $8, included_seats = $9, seat_price = $10, usage_unit = $11,
              included_usage = $12, usage_price = $13, trial_days = $14, tax_rate = $15, hsn_sac = $16, active = $17 where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals],
    );
    if (!r) throw notFound('Plan not found');
    // what subscribers pay changes from their next period; keep MRR current
    for (const s of await ctx.tx.query<{ id: string }>(`select id from saas_subscriptions where tenant_id = $1 and plan_id = $2 and status in ('active','past_due')`, [ctx.tenantId, id])) await refreshMrr(ctx, s.id);
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(
    `insert into saas_plans (tenant_id, name, code, product, description, interval, price, included_seats, seat_price, usage_unit, included_usage, usage_price, trial_days, tax_rate, hsn_sac, active)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [ctx.tenantId, ...vals],
  );
  return { id: r!.id };
}

/* ───────────── pricing ───────────── */

interface SubRow {
  id: string;
  sub_number: string;
  account_id: string;
  plan_id: string;
  status: string;
  seats: number;
  price_override: string | null;
  discount_pct: string;
  current_period_start: string;
  current_period_end: string;
  trial_end: string | null;
  cancel_at_period_end: boolean;
  auto_invoice: boolean;
  auto_issue: boolean;
  mrr: string;
}

async function loadSub(ctx: RecordCtx, id: string, lock = false) {
  const s = await ctx.tx.one<SubRow>(
    `select id, sub_number, account_id, plan_id, status, seats, price_override, discount_pct, current_period_start::text, current_period_end::text, trial_end::text,
            cancel_at_period_end, auto_invoice, auto_issue, mrr from saas_subscriptions where tenant_id = $1 and id = $2${lock ? ' for update' : ''}`,
    [ctx.tenantId, id],
  );
  if (!s) throw notFound('Subscription not found');
  return s;
}

async function loadPlan(ctx: RecordCtx, id: string) {
  const p = await ctx.tx.one<{ id: string; name: string; interval: Interval; price: number; included_seats: number; seat_price: number; usage_unit: string | null; included_usage: number; usage_price: number; trial_days: number; tax_rate: number; hsn_sac: string; active: boolean }>(
    `select ${PLAN_COLS} from saas_plans where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id],
  );
  if (!p) throw badRequest('Plan not found');
  return p;
}

/** What one period costs before GST: plan (or override), extra seats, add-ons, less the discount. */
async function periodCharges(ctx: RecordCtx, s: SubRow) {
  const p = await loadPlan(ctx, s.plan_id);
  const base = s.price_override != null ? Number(s.price_override) : p.price;
  const extraSeats = Math.max(0, s.seats - p.included_seats);
  const addons = await ctx.tx.query<{ name: string; quantity: number; unit_price: number }>(`select name, quantity::float8 as quantity, unit_price::float8 as unit_price from saas_sub_addons where tenant_id = $1 and subscription_id = $2 order by name`, [ctx.tenantId, s.id]);
  const gross = base + extraSeats * p.seat_price + addons.reduce((a, x) => a + x.quantity * x.unit_price, 0);
  const amount = r2(gross * (1 - Number(s.discount_pct) / 100));
  return { plan: p, base, extraSeats, addons, amount, mrr: r2(amount / MONTHS[p.interval]!) };
}

async function refreshMrr(ctx: RecordCtx, id: string) {
  const s = await loadSub(ctx, id);
  const mrr = ['active', 'past_due'].includes(s.status) ? (await periodCharges(ctx, s)).mrr : 0;
  await ctx.tx.query(`update saas_subscriptions set mrr = $3, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, mrr]);
  return mrr;
}

async function event(ctx: RecordCtx, subId: string, kind: string, before: number, after: number, note: string | null = null, date = today(), invoiceId: string | null = null) {
  await ctx.tx.query(`insert into saas_events (tenant_id, subscription_id, kind, event_date, mrr_before, mrr_after, note, invoice_id) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [
    ctx.tenantId, subId, kind, date, before, after, note, invoiceId,
  ]);
}

/* ───────────── subscriptions ───────────── */

const SUB_COLS = `s.id, s.sub_number, s.account_id, a.name as account_name, s.plan_id, p.name as plan_name, p.interval, s.status, s.start_date::text, s.trial_end::text,
  s.current_period_start::text, s.current_period_end::text, s.seats, s.price_override::float8 as price_override, s.discount_pct::float8 as discount_pct, s.auto_invoice, s.auto_issue,
  s.cancel_at_period_end, s.cancelled_at::text, s.cancel_reason, s.mrr::float8 as mrr, s.owner_id, s.notes, s.created_at`;
const SUB_FROM = `saas_subscriptions s join accounts a on a.tenant_id = s.tenant_id and a.id = s.account_id join saas_plans p on p.tenant_id = s.tenant_id and p.id = s.plan_id`;

export async function listSubscriptions(ctx: RecordCtx, q: { status?: string | null; accountId?: string | null; planId?: string | null } = {}) {
  assertReader(ctx);
  return ctx.tx.query(
    `select ${SUB_COLS} from ${SUB_FROM} where s.tenant_id = $1 and ($2::text is null or s.status = $2) and ($3::uuid is null or s.account_id = $3) and ($4::uuid is null or s.plan_id = $4)
      order by case s.status when 'past_due' then 0 when 'trial' then 1 when 'active' then 2 when 'paused' then 3 else 4 end, s.current_period_end limit 2000`,
    [ctx.tenantId, q.status ?? null, q.accountId ?? null, q.planId ?? null],
  );
}

export async function getSubscription(ctx: RecordCtx, id: string) {
  assertReader(ctx);
  const s = await ctx.tx.one(`select ${SUB_COLS} from ${SUB_FROM} where s.tenant_id = $1 and s.id = $2`, [ctx.tenantId, id]);
  if (!s) throw notFound('Subscription not found');
  // one connection: queries run one after another
  const addons = await ctx.tx.query(`select id, name, quantity::float8 as quantity, unit_price::float8 as unit_price from saas_sub_addons where tenant_id = $1 and subscription_id = $2 order by name`, [ctx.tenantId, id]);
  const usage = await ctx.tx.query(`select id, usage_date::text, quantity::float8 as quantity, note, invoice_id from saas_usage where tenant_id = $1 and subscription_id = $2 order by usage_date desc limit 200`, [ctx.tenantId, id]);
  const events = await ctx.tx.query(`select kind, event_date::text, mrr_before::float8 as mrr_before, mrr_after::float8 as mrr_after, note, invoice_id, created_at from saas_events where tenant_id = $1 and subscription_id = $2 order by created_at desc limit 200`, [ctx.tenantId, id]);
  const invoices = await ctx.tx.query(
      `select i.id, i.invoice_number, i.invoice_date::text, i.status, i.grand_total::float8 as total, i.balance_due::float8 as balance_due
         from saas_events e join invoices i on i.tenant_id = e.tenant_id and i.id = e.invoice_id where e.tenant_id = $1 and e.subscription_id = $2 and e.kind = 'invoiced' order by e.created_at desc`,
      [ctx.tenantId, id],
    );
  const charges = await periodCharges(ctx, await loadSub(ctx, id));
  return { subscription: s, addons, usage, events, invoices, charges: { base: charges.base, extraSeats: charges.extraSeats, amount: charges.amount, mrr: charges.mrr } };
}

export interface SubInput {
  accountId: string;
  planId: string;
  startDate: string;
  seats?: number;
  priceOverride?: number | null;
  discountPct?: number;
  trial?: boolean;
  autoInvoice?: boolean;
  autoIssue?: boolean;
  notes?: string | null;
  addons?: { name: string; quantity: number; unitPrice: number }[];
}

export async function createSubscription(ctx: RecordCtx, input: SubInput) {
  assertManager(ctx, 'subscriptions');
  if (!(await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.accountId]))) throw badRequest('Customer not found');
  const plan = await loadPlan(ctx, input.planId);
  if (!plan.active) throw badRequest('That plan is no longer sold');
  const trial = (input.trial ?? plan.trial_days > 0) && plan.trial_days > 0;
  const trialEnd = trial ? addDays(input.startDate, plan.trial_days - 1) : null;
  const periodEnd = trialEnd ?? addDays(addMonths(input.startDate, MONTHS[plan.interval]!), -1);
  const number = await fyNumber(ctx, 'SUB', input.startDate);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into saas_subscriptions (tenant_id, sub_number, account_id, plan_id, status, start_date, trial_end, current_period_start, current_period_end, seats, price_override, discount_pct, auto_invoice, auto_issue, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$6,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      ctx.tenantId, number, input.accountId, input.planId, trial ? 'trial' : 'active', input.startDate, trialEnd, periodEnd, input.seats ?? Math.max(1, plan.included_seats), input.priceOverride ?? null,
      input.discountPct ?? 0, input.autoInvoice ?? true, input.autoIssue ?? false, input.notes ?? null,
    ],
  );
  const id = r!.id;
  for (const a of input.addons ?? []) await ctx.tx.query(`insert into saas_sub_addons (tenant_id, subscription_id, name, quantity, unit_price) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, a.name, a.quantity, a.unitPrice]);
  const mrr = await refreshMrr(ctx, id);
  await event(ctx, id, trial ? 'trial_started' : 'created', 0, mrr, trial ? `Trial until ${trialEnd}` : null, input.startDate);
  return { id, number, status: trial ? 'trial' : 'active' };
}

/** Plan, seats, price, discount or add-ons change; recorded as an upgrade, downgrade or seat change. */
export async function changeSubscription(ctx: RecordCtx, id: string, input: { planId?: string; seats?: number; priceOverride?: number | null; discountPct?: number; autoInvoice?: boolean; autoIssue?: boolean; notes?: string | null; addons?: { name: string; quantity: number; unitPrice: number }[] }) {
  assertManager(ctx, 'subscriptions');
  const s = await loadSub(ctx, id, true);
  if (['cancelled', 'expired'].includes(s.status)) throw badRequest('Reactivate the subscription first');
  if (input.planId && input.planId !== s.plan_id) {
    const p = await loadPlan(ctx, input.planId);
    if (!p.active) throw badRequest('That plan is no longer sold');
  }
  const before = Number(s.mrr);
  await ctx.tx.query(
    `update saas_subscriptions set plan_id = coalesce($3, plan_id), seats = coalesce($4, seats), price_override = case when $5::boolean then $6::numeric else price_override end,
            discount_pct = coalesce($7, discount_pct), auto_invoice = coalesce($8, auto_invoice), auto_issue = coalesce($9, auto_issue), notes = coalesce($10, notes), updated_at = now()
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, input.planId ?? null, input.seats ?? null, input.priceOverride !== undefined, input.priceOverride ?? null, input.discountPct ?? null, input.autoInvoice ?? null, input.autoIssue ?? null, input.notes ?? null],
  );
  if (input.addons) {
    await ctx.tx.query(`delete from saas_sub_addons where tenant_id = $1 and subscription_id = $2`, [ctx.tenantId, id]);
    for (const a of input.addons) await ctx.tx.query(`insert into saas_sub_addons (tenant_id, subscription_id, name, quantity, unit_price) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, a.name, a.quantity, a.unitPrice]);
  }
  const after = await refreshMrr(ctx, id);
  if (s.status === 'trial') return { mrr: after };
  const kind = input.planId && input.planId !== s.plan_id ? (after >= before ? 'upgraded' : 'downgraded') : input.seats !== undefined && input.seats !== s.seats ? 'seats_changed' : after > before ? 'upgraded' : after < before ? 'downgraded' : null;
  if (kind) await event(ctx, id, kind, before, after, input.seats !== undefined && input.seats !== s.seats ? `Seats ${s.seats} → ${input.seats}` : null);
  return { mrr: after, change: kind };
}

export async function subscriptionAction(ctx: RecordCtx, id: string, action: 'pause' | 'resume' | 'cancel' | 'cancel_at_period_end' | 'reactivate' | 'activate', opts: { reason?: string | null; date?: string | null } = {}) {
  assertManager(ctx, 'subscriptions');
  const s = await loadSub(ctx, id, true);
  const before = Number(s.mrr);
  const on = opts.date ?? today();
  const set = async (status: string, extra = '') => ctx.tx.query(`update saas_subscriptions set status = $3${extra}, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, status]);
  if (action === 'pause') {
    if (s.status !== 'active' && s.status !== 'past_due') throw badRequest('Only an active subscription can be paused');
    await set('paused');
  } else if (action === 'resume') {
    if (s.status !== 'paused') throw badRequest('The subscription is not paused');
    await set('active');
  } else if (action === 'activate') {
    if (s.status !== 'trial') throw badRequest('Only a trial is converted');
    const p = await loadPlan(ctx, s.plan_id);
    await ctx.tx.query(`update saas_subscriptions set status = 'active', trial_end = $3, current_period_start = $4, current_period_end = $5, updated_at = now() where tenant_id = $1 and id = $2`, [
      ctx.tenantId, id, addDays(on, -1), on, addDays(addMonths(on, MONTHS[p.interval]!), -1),
    ]);
  } else if (action === 'cancel_at_period_end') {
    if (!['active', 'past_due', 'trial'].includes(s.status)) throw badRequest('The subscription is not running');
    await ctx.tx.query(`update saas_subscriptions set cancel_at_period_end = true, cancel_reason = $3, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, opts.reason ?? null]);
    return { status: s.status, cancelsOn: s.current_period_end };
  } else if (action === 'cancel') {
    if (['cancelled', 'expired'].includes(s.status)) throw badRequest('Already cancelled');
    await ctx.tx.query(`update saas_subscriptions set status = 'cancelled', cancelled_at = $3, cancel_reason = coalesce($4, cancel_reason), cancel_at_period_end = false, updated_at = now() where tenant_id = $1 and id = $2`, [
      ctx.tenantId, id, on, opts.reason ?? null,
    ]);
  } else {
    if (!['cancelled', 'expired'].includes(s.status) && !s.cancel_at_period_end) throw badRequest('The subscription is running');
    if (s.cancel_at_period_end && !['cancelled', 'expired'].includes(s.status)) {
      await ctx.tx.query(`update saas_subscriptions set cancel_at_period_end = false, cancel_reason = null, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      return { status: s.status };
    }
    const p = await loadPlan(ctx, s.plan_id);
    await ctx.tx.query(
      `update saas_subscriptions set status = 'active', cancelled_at = null, cancel_reason = null, current_period_start = $3, current_period_end = $4, updated_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id, on, addDays(addMonths(on, MONTHS[p.interval]!), -1)],
    );
  }
  const after = await refreshMrr(ctx, id);
  const kind = { pause: 'paused', resume: 'resumed', cancel: 'cancelled', reactivate: 'reactivated', activate: 'activated' }[action as 'pause'];
  await event(ctx, id, kind, before, after, opts.reason ?? null, on);
  return { status: (await loadSub(ctx, id)).status };
}

export async function recordUsage(ctx: RecordCtx, id: string, input: { date: string; quantity: number; note?: string | null }) {
  assertManager(ctx, 'subscriptions');
  await loadSub(ctx, id);
  const r = await ctx.tx.one<{ id: string }>(`insert into saas_usage (tenant_id, subscription_id, usage_date, quantity, note) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, id, input.date, input.quantity, input.note ?? null]);
  return { id: r!.id };
}

/* ───────────── billing ───────────── */

/** Invoices the current period in advance, with metered usage of the period before (in arrears). */
export async function invoiceSubscription(ctx: RecordCtx, id: string, opts: { issue?: boolean } = {}): Promise<{ invoiceId: string; number: string | null; events: RecordEvent[] }> {
  assertManager(ctx, 'subscriptions');
  const s = await loadSub(ctx, id, true);
  if (!['active', 'past_due'].includes(s.status)) throw badRequest('Only an active subscription is invoiced');
  if (await ctx.tx.one(`select 1 from saas_events where tenant_id = $1 and subscription_id = $2 and kind = 'invoiced' and event_date = $3`, [ctx.tenantId, id, s.current_period_start])) throw conflict('This period is already invoiced');
  const c = await periodCharges(ctx, s);
  const p = c.plan;
  const fmt = (d: string) => d.split('-').reverse().join('-');
  const span = `${fmt(s.current_period_start)} to ${fmt(s.current_period_end)}`;
  const disc = Number(s.discount_pct);
  const lines: InvLine[] = [{ name: `${p.name} subscription`, description: `${s.sub_number} · ${span}`, hsnSac: p.hsn_sac, quantity: 1, unitPrice: c.base, taxRate: p.tax_rate, discountPct: disc }];
  if (c.extraSeats > 0 && p.seat_price > 0) lines.push({ name: `Additional seats (${p.name})`, description: span, hsnSac: p.hsn_sac, quantity: c.extraSeats, unitPrice: p.seat_price, taxRate: p.tax_rate, unit: 'Seats', discountPct: disc });
  for (const a of c.addons) lines.push({ name: a.name, description: span, hsnSac: p.hsn_sac, quantity: a.quantity, unitPrice: a.unit_price, taxRate: p.tax_rate, discountPct: disc });
  // usage before this period that is not yet billed
  const usage = await ctx.tx.query<{ id: string; quantity: number }>(
    `select id, quantity::float8 as quantity from saas_usage where tenant_id = $1 and subscription_id = $2 and invoice_id is null and usage_date < $3::date for update`,
    [ctx.tenantId, id, s.current_period_start],
  );
  const used = usage.reduce((a, u) => a + u.quantity, 0);
  const billable = r2(Math.max(0, used - p.included_usage));
  if (billable > 0 && p.usage_price > 0) lines.push({ name: `${p.usage_unit ?? 'Usage'} beyond the ${p.included_usage} included`, hsnSac: p.hsn_sac, quantity: billable, unitPrice: p.usage_price, taxRate: p.tax_rate, unit: (p.usage_unit ?? 'Units').slice(0, 20) });
  const issue = opts.issue ?? s.auto_issue;
  const inv = await raiseInvoice(ctx, { name: `${p.name} — ${s.sub_number}`, accountId: s.account_id, lines, issue });
  if (usage.length) await ctx.tx.query(`update saas_usage set invoice_id = $3 where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, usage.map((u) => u.id), inv.id]);
  await event(ctx, id, 'invoiced', Number(s.mrr), Number(s.mrr), `${inv.number ?? 'Draft invoice'} · ${span}`, s.current_period_start, inv.id);
  return { invoiceId: inv.id, number: inv.number, events: inv.events };
}

/**
 * The daily subscription run: ends trials, renews periods (or cancels those set to end), invoices the
 * new periods, and marks subscriptions with an unpaid invoice older than 15 days past due.
 */
export async function runSubscriptions(ctx: RecordCtx, on = today()) {
  assertManager(ctx, 'subscriptions');
  const out = { renewed: 0, converted: 0, cancelled: 0, invoiced: 0, pastDue: 0, failed: [] as { subscription: string; error: string }[], events: [] as RecordEvent[] };
  const subs = await ctx.tx.query<{ id: string }>(`select id from saas_subscriptions where tenant_id = $1 and status in ('trial','active','past_due') order by current_period_end limit 5000`, [ctx.tenantId]);
  for (const { id } of subs) {
    await ctx.tx.query('savepoint sub_run');
    try {
      let s = await loadSub(ctx, id, true);
      const p = await loadPlan(ctx, s.plan_id);
      const months = MONTHS[p.interval]!;
      for (let i = 0; i < 60 && s.current_period_end < on; i++) {
        if (s.cancel_at_period_end) {
          const before = Number(s.mrr);
          await ctx.tx.query(`update saas_subscriptions set status = 'cancelled', cancelled_at = $3, cancel_at_period_end = false, mrr = 0, updated_at = now() where tenant_id = $1 and id = $2`, [
            ctx.tenantId, id, addDays(s.current_period_end, 1),
          ]);
          await event(ctx, id, 'cancelled', before, 0, 'Cancelled at the end of the period', addDays(s.current_period_end, 1));
          out.cancelled++;
          break;
        }
        const start = addDays(s.current_period_end, 1);
        const end = addDays(addMonths(start, months), -1);
        const wasTrial = s.status === 'trial';
        await ctx.tx.query(`update saas_subscriptions set status = case when status = 'trial' then 'active' else status end, current_period_start = $3, current_period_end = $4, updated_at = now() where tenant_id = $1 and id = $2`, [
          ctx.tenantId, id, start, end,
        ]);
        const mrr = await refreshMrr(ctx, id);
        if (wasTrial) {
          await event(ctx, id, 'activated', 0, mrr, 'Trial ended', start);
          out.converted++;
        } else {
          await event(ctx, id, 'renewed', mrr, mrr, null, start);
          out.renewed++;
        }
        s = await loadSub(ctx, id, true);
      }
      s = await loadSub(ctx, id, true);
      if (['active', 'past_due'].includes(s.status) && s.auto_invoice && s.current_period_start <= on && !(await ctx.tx.one(`select 1 from saas_events where tenant_id = $1 and subscription_id = $2 and kind = 'invoiced' and event_date = $3`, [ctx.tenantId, id, s.current_period_start]))) {
        const r = await invoiceSubscription(ctx, id);
        out.events.push(...r.events);
        out.invoiced++;
      }
      // an invoice left unpaid 15 days after it was raised
      const overdue = await ctx.tx.one(
        `select 1 from saas_events e join invoices i on i.tenant_id = e.tenant_id and i.id = e.invoice_id
          where e.tenant_id = $1 and e.subscription_id = $2 and e.kind = 'invoiced' and i.status in ('issued','partially_paid') and i.balance_due > 0 and coalesce(i.due_date, i.invoice_date) < $3::date - 15 limit 1`,
        [ctx.tenantId, id, on],
      );
      if (overdue && s.status === 'active') {
        await ctx.tx.query(`update saas_subscriptions set status = 'past_due' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
        out.pastDue++;
      } else if (!overdue && s.status === 'past_due') await ctx.tx.query(`update saas_subscriptions set status = 'active' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      await ctx.tx.query('release savepoint sub_run');
    } catch (e) {
      await ctx.tx.query('rollback to savepoint sub_run');
      out.failed.push({ subscription: id, error: (e as Error).message });
    }
  }
  return out;
}

/* ───────────── metrics ───────────── */

/** MRR, ARR, ARPA, customers, churn and the MRR movements of the last 12 months. */
export async function saasMetrics(ctx: RecordCtx, on = today()) {
  assertReader(ctx);
  const now = await ctx.tx.one<{ mrr: number; subs: number; customers: number; trials: number; past_due: number; paused: number }>(
    `select coalesce(sum(mrr) filter (where status in ('active','past_due')), 0)::float8 as mrr, count(*) filter (where status in ('active','past_due'))::int as subs,
            count(distinct account_id) filter (where status in ('active','past_due'))::int as customers, count(*) filter (where status = 'trial')::int as trials,
            count(*) filter (where status = 'past_due')::int as past_due, count(*) filter (where status = 'paused')::int as paused
       from saas_subscriptions where tenant_id = $1`,
    [ctx.tenantId],
  );
  const from = addMonths(`${on.slice(0, 7)}-01`, -11);
  const moves = await ctx.tx.query<{ month: string; kind: string; delta: number; n: number }>(
    `select to_char(event_date, 'YYYY-MM') as month, kind, sum(mrr_after - mrr_before)::float8 as delta, count(*)::int as n
       from saas_events where tenant_id = $1 and event_date >= $2::date and kind not in ('invoiced','renewed','trial_started') group by 1, 2`,
    [ctx.tenantId, from],
  );
  const months: { month: string; new: number; expansion: number; contraction: number; churn: number; net: number }[] = [];
  for (let m = from; m <= on; m = addMonths(m, 1)) {
    const k = m.slice(0, 7);
    const xs = moves.filter((x) => x.month === k);
    const sum = (kinds: string[], sign: 1 | -1 | 0 = 0) => r2(xs.filter((x) => kinds.includes(x.kind) && (sign === 0 || Math.sign(x.delta) === sign)).reduce((a, x) => a + x.delta, 0));
    const row = {
      month: k,
      new: sum(['created', 'activated', 'reactivated', 'resumed']),
      expansion: sum(['upgraded', 'seats_changed'], 1),
      contraction: sum(['downgraded', 'seats_changed'], -1),
      churn: sum(['cancelled', 'expired', 'paused']),
    };
    months.push({ ...row, net: r2(row.new + row.expansion + row.contraction + row.churn) });
  }
  // churn over the last 30 days against MRR 30 days ago (today's MRR less the net change since)
  const last30 = await ctx.tx.one<{ churned: number; lost: number; net: number; added: number }>(
    `select coalesce(sum(mrr_before - mrr_after) filter (where kind in ('cancelled','expired')), 0)::float8 as churned,
            count(distinct subscription_id) filter (where kind in ('cancelled','expired'))::int as lost,
            coalesce(sum(mrr_after - mrr_before) filter (where kind not in ('invoiced','renewed','trial_started')), 0)::float8 as net,
            coalesce(sum(greatest(mrr_after - mrr_before, 0)) filter (where kind not in ('invoiced','renewed','trial_started')), 0)::float8 as added
       from saas_events where tenant_id = $1 and event_date > $2::date - 30`,
    [ctx.tenantId, on],
  );
  // churn against the MRR there was to lose: MRR 30 days ago plus what was added since
  const mrr30 = Math.max(0, now!.mrr - last30!.net) + last30!.added;
  const upcoming = await ctx.tx.query(
    `select s.id, s.sub_number, a.name as account_name, p.name as plan_name, s.status, s.current_period_end::text, s.trial_end::text, s.cancel_at_period_end, s.mrr::float8 as mrr
       from ${SUB_FROM} where s.tenant_id = $1 and s.status in ('trial','active','past_due') and s.current_period_end <= $2::date + 30 order by s.current_period_end limit 50`,
    [ctx.tenantId, on],
  );
  const byPlan = await ctx.tx.query(
    `select p.name, count(*)::int as subs, coalesce(sum(s.mrr), 0)::float8 as mrr from saas_subscriptions s join saas_plans p on p.tenant_id = s.tenant_id and p.id = s.plan_id
      where s.tenant_id = $1 and s.status in ('active','past_due') group by p.name order by 3 desc`,
    [ctx.tenantId],
  );
  return {
    mrr: r2(now!.mrr),
    arr: r2(now!.mrr * 12),
    arpa: now!.customers ? r2(now!.mrr / now!.customers) : 0,
    subscriptions: now!.subs,
    customers: now!.customers,
    trials: now!.trials,
    pastDue: now!.past_due,
    paused: now!.paused,
    revenueChurnPct: mrr30 ? r2((last30!.churned / mrr30) * 100) : 0,
    lostSubscriptions30d: last30!.lost,
    months,
    byPlan,
    upcoming,
  };
}
