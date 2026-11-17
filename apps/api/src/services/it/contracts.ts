/**
 * IT services: contracts (retainers, AMC, time & materials, fixed-bid SOWs, support, enterprise licences)
 * with hours included per period, overage, SLA and renewals; contract billing each period; change requests
 * on projects with their impact and client approval; resource allocation and capacity planning; estimates
 * against actuals.
 */
import { hasAdmin } from '@synapse/shared';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors';
import { projectAccess } from '../projects';
import type { RecordCtx, RecordEvent } from '../records';
import { addDays, addMonths, assertManager, assertReader, fyNumber, MONTHS, r2, raiseInvoice, today } from './common';

/* ───────────────────────── contracts ───────────────────────── */

export interface ContractInput {
  name: string;
  accountId: string;
  projectId?: string | null;
  kind: 'retainer' | 'amc' | 'time_materials' | 'fixed_bid' | 'support' | 'enterprise_licence';
  startDate: string;
  endDate?: string | null;
  value?: number;
  billingFrequency: 'monthly' | 'quarterly' | 'half_yearly' | 'yearly' | 'milestone' | 'one_time';
  periodFee?: number | null;
  hoursPerPeriod?: number | null;
  overageRate?: number | null;
  slaResponseHours?: number | null;
  slaResolutionHours?: number | null;
  autoRenew?: boolean;
  renewalNoticeDays?: number;
  taxRate?: number;
  hsnSac?: string | null;
  terms?: string | null;
  ownerId?: string | null;
}

const C_COLS = `c.id, c.contract_number, c.name, c.account_id, a.name as account_name, c.project_id, p.name as project_name, c.kind, c.status, c.start_date::text, c.end_date::text,
  c.value::float8 as value, c.billing_frequency, c.period_fee::float8 as period_fee, c.hours_per_period::float8 as hours_per_period, c.overage_rate::float8 as overage_rate,
  c.sla_response_hours::float8 as sla_response_hours, c.sla_resolution_hours::float8 as sla_resolution_hours, c.auto_renew, c.renewal_notice_days,
  c.next_invoice_date::text, c.tax_rate::float8 as tax_rate, c.hsn_sac, c.terms, c.owner_id, u.full_name as owner_name, c.terminated_at::text, c.created_at`;
const C_FROM = `service_contracts c join accounts a on a.tenant_id = c.tenant_id and a.id = c.account_id
  left join projects p on p.tenant_id = c.tenant_id and p.id = c.project_id left join users u on u.tenant_id = c.tenant_id and u.id = c.owner_id`;

/** The billing period a date falls in (from the contract start, by its frequency). */
export function periodOf(c: { start_date: string; billing_frequency: string; end_date: string | null }, date: string) {
  const m = MONTHS[c.billing_frequency];
  if (!m) return { start: c.start_date, end: c.end_date ?? addDays(addMonths(c.start_date, 12), -1) };
  let s = c.start_date;
  for (let i = 0; i < 600 && addMonths(s, m) <= date; i++) s = addMonths(s, m);
  let e = addDays(addMonths(s, m), -1);
  if (c.end_date && e > c.end_date) e = c.end_date;
  return { start: s, end: e };
}

async function hoursUsed(ctx: RecordCtx, projectId: string | null, from: string, to: string) {
  if (!projectId) return 0;
  const r = await ctx.tx.one<{ h: number }>(`select coalesce(sum(minutes), 0)::float8 / 60 as h from time_entries where tenant_id = $1 and project_id = $2 and work_date between $3::date and $4::date and status <> 'rejected'`, [
    ctx.tenantId, projectId, from, to,
  ]);
  return r2(r!.h);
}

export async function listContracts(ctx: RecordCtx, q: { accountId?: string | null; status?: string | null; projectId?: string | null } = {}) {
  assertReader(ctx);
  const rows = await ctx.tx.query<Record<string, any>>(
    `select ${C_COLS} from ${C_FROM} where c.tenant_id = $1 and ($2::uuid is null or c.account_id = $2) and ($3::text is null or c.status = $3) and ($4::uuid is null or c.project_id = $4)
      order by case c.status when 'active' then 0 when 'draft' then 1 else 2 end, c.end_date nulls last limit 1000`,
    [ctx.tenantId, q.accountId ?? null, q.status ?? null, q.projectId ?? null],
  );
  const now = today();
  for (const c of rows) {
    const p = periodOf(c as never, now);
    c.period = p;
    c.hours_used = await hoursUsed(ctx, c.project_id, p.start, p.end);
    c.hours_left = c.hours_per_period != null ? r2(c.hours_per_period - c.hours_used) : null;
    c.renewal_due = c.status === 'active' && c.end_date && addDays(c.end_date, -c.renewal_notice_days) <= now;
  }
  return rows;
}

export async function getContract(ctx: RecordCtx, id: string) {
  assertReader(ctx);
  const c = await ctx.tx.one<Record<string, any>>(`select ${C_COLS} from ${C_FROM} where c.tenant_id = $1 and c.id = $2`, [ctx.tenantId, id]);
  if (!c) throw notFound('Contract not found');
  const invoices = await ctx.tx.query(
    `select ci.period_start::text, ci.period_end::text, ci.hours_used::float8 as hours_used, ci.overage_hours::float8 as overage_hours, ci.invoice_id, i.invoice_number, i.status, i.grand_total::float8 as total
       from service_contract_invoices ci left join invoices i on i.tenant_id = ci.tenant_id and i.id = ci.invoice_id
      where ci.tenant_id = $1 and ci.contract_id = $2 order by ci.period_start desc`,
    [ctx.tenantId, id],
  );
  const p = periodOf(c as never, today());
  c.period = p;
  c.hours_used = await hoursUsed(ctx, c.project_id, p.start, p.end);
  // support tickets of the customer in this period, against the SLA
  const tickets = await ctx.tx.query(
    `select count(*)::int as n, count(*) filter (where status in ('resolved','closed'))::int as resolved from tickets where tenant_id = $1 and account_id = $2 and created_at::date between $3::date and $4::date and deleted_at is null`,
    [ctx.tenantId, c.account_id, p.start, p.end],
  );
  return { contract: c, invoices, tickets: tickets[0] };
}

async function checkRefs(ctx: RecordCtx, input: ContractInput) {
  if (!(await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.accountId]))) throw badRequest('Customer not found');
  if (input.projectId && !(await ctx.tx.one(`select 1 from projects where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.projectId]))) throw badRequest('Project not found');
  if (input.endDate && input.endDate < input.startDate) throw badRequest('The contract ends before it starts');
  if (['retainer', 'amc', 'support', 'enterprise_licence'].includes(input.kind) && !MONTHS[input.billingFrequency] && input.billingFrequency !== 'one_time')
    throw badRequest('Choose how often this contract is billed');
}

export async function saveContract(ctx: RecordCtx, id: string | null, input: ContractInput) {
  assertManager(ctx, 'contracts');
  await checkRefs(ctx, input);
  const vals = [
    input.name, input.accountId, input.projectId ?? null, input.kind, input.startDate, input.endDate ?? null, input.value ?? 0, input.billingFrequency, input.periodFee ?? null,
    input.hoursPerPeriod ?? null, input.overageRate ?? null, input.slaResponseHours ?? null, input.slaResolutionHours ?? null, input.autoRenew ?? false, input.renewalNoticeDays ?? 30,
    input.taxRate ?? 18, input.hsnSac || '998313', input.terms ?? null, input.ownerId ?? ctx.principal.user.id,
  ];
  if (id) {
    const cur = await ctx.tx.one<{ status: string }>(`select status from service_contracts where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
    if (!cur) throw notFound('Contract not found');
    if (cur.status === 'terminated') throw badRequest('A terminated contract cannot change');
    await ctx.tx.query(
      `update service_contracts set name = $3, account_id = $4, project_id = $5, kind = $6, start_date = $7, end_date = $8, value = $9, billing_frequency = $10, period_fee = $11,
              hours_per_period = $12, overage_rate = $13, sla_response_hours = $14, sla_resolution_hours = $15, auto_renew = $16, renewal_notice_days = $17, tax_rate = $18,
              hsn_sac = $19, terms = $20, owner_id = $21, updated_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id, ...vals],
    );
    return { id };
  }
  const number = await fyNumber(ctx, 'CON', input.startDate);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into service_contracts (tenant_id, contract_number, name, account_id, project_id, kind, start_date, end_date, value, billing_frequency, period_fee, hours_per_period, overage_rate,
       sla_response_hours, sla_resolution_hours, auto_renew, renewal_notice_days, tax_rate, hsn_sac, terms, owner_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) returning id`,
    [ctx.tenantId, number, ...vals],
  );
  return { id: r!.id, number };
}

export async function contractAction(ctx: RecordCtx, id: string, action: 'activate' | 'terminate' | 'renew', opts: { date?: string | null } = {}) {
  assertManager(ctx, 'contracts');
  const c = await ctx.tx.one<Record<string, any>>(`select *, start_date::text as s, end_date::text as e from service_contracts where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!c) throw notFound('Contract not found');
  if (action === 'activate') {
    if (c.status !== 'draft') throw badRequest('Only a draft contract can be activated');
    // billed in advance from the start of the contract
    const next = MONTHS[c.billing_frequency] || c.billing_frequency === 'one_time' ? c.s : null;
    await ctx.tx.query(`update service_contracts set status = 'active', next_invoice_date = $3, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, next]);
  } else if (action === 'terminate') {
    if (!['active', 'draft'].includes(c.status)) throw badRequest('This contract is not running');
    await ctx.tx.query(`update service_contracts set status = 'terminated', terminated_at = $3, next_invoice_date = null, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, opts.date ?? today()]);
  } else {
    if (!['active', 'expired'].includes(c.status) || !c.e) throw badRequest('Only a contract with an end date can be renewed');
    const term = Math.max(1, Math.round((Date.parse(c.e) - Date.parse(c.s)) / (30.44 * 86_400_000)));
    const end = addDays(addMonths(addDays(c.e, 1), term), -1);
    await ctx.tx.query(
      `update service_contracts set status = 'active', end_date = $3, next_invoice_date = coalesce(next_invoice_date, case when billing_frequency in ('milestone') then null else $4::date end), updated_at = now() where tenant_id = $1 and id = $2`,
      [ctx.tenantId, id, end, addDays(c.e, 1)],
    );
    return { endDate: end };
  }
  return {};
}

/** Invoices one period of a contract: the period fee and hours beyond what is included. */
export async function invoiceContract(ctx: RecordCtx, id: string, opts: { periodStart?: string | null; issue?: boolean } = {}): Promise<{ invoiceId: string; number: string | null; events: RecordEvent[] }> {
  assertManager(ctx, 'contracts');
  const c = await ctx.tx.one<Record<string, any>>(
    `select *, start_date::text as s, end_date::text as e, next_invoice_date::text as nid from service_contracts where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, id],
  );
  if (!c) throw notFound('Contract not found');
  if (c.status !== 'active') throw badRequest('Only an active contract is billed');
  const at = opts.periodStart ?? c.nid ?? today();
  const p = periodOf({ start_date: c.s, billing_frequency: c.billing_frequency, end_date: c.e }, at);
  if (await ctx.tx.one(`select 1 from service_contract_invoices where tenant_id = $1 and contract_id = $2 and period_start = $3`, [ctx.tenantId, id, p.start])) throw conflict('This period is already invoiced');
  const fmt = (d: string) => d.split('-').reverse().join('-');
  const lines = [];
  const fee = Number(c.period_fee ?? 0) || (c.billing_frequency === 'one_time' ? Number(c.value) : 0);
  if (fee > 0)
    lines.push({ name: `${c.name} — ${c.billing_frequency === 'one_time' ? 'contract fee' : `${fmt(p.start)} to ${fmt(p.end)}`}`, description: c.contract_number, hsnSac: c.hsn_sac, quantity: 1, unitPrice: fee, taxRate: Number(c.tax_rate) });
  // overage for the previous full period of time logged (billed in arrears)
  let used = 0;
  let over = 0;
  if (c.hours_per_period != null && c.overage_rate && c.project_id) {
    const prev = periodOf({ start_date: c.s, billing_frequency: c.billing_frequency, end_date: c.e }, addDays(p.start, -1));
    if (prev.start < p.start) {
      used = await hoursUsed(ctx, c.project_id, prev.start, prev.end);
      over = r2(Math.max(0, used - Number(c.hours_per_period)));
      if (over > 0) lines.push({ name: `Hours beyond the ${Number(c.hours_per_period)} included (${fmt(prev.start)} to ${fmt(prev.end)})`, description: c.contract_number, hsnSac: c.hsn_sac, quantity: over, unitPrice: Number(c.overage_rate), taxRate: Number(c.tax_rate), unit: 'Hrs' });
    }
  }
  if (!lines.length) throw badRequest('Nothing to bill for this period: set the period fee (or the overage rate and hours)');
  const inv = await raiseInvoice(ctx, { name: `${c.name} (${c.contract_number})`, accountId: c.account_id, projectId: c.project_id, lines, issue: opts.issue });
  await ctx.tx.query(`insert into service_contract_invoices (tenant_id, contract_id, period_start, period_end, invoice_id, hours_used, overage_hours) values ($1,$2,$3,$4,$5,$6,$7)`, [
    ctx.tenantId, id, p.start, p.end, inv.id, used, over,
  ]);
  const m = MONTHS[c.billing_frequency];
  const next = m ? addMonths(p.start, m) : null;
  await ctx.tx.query(`update service_contracts set next_invoice_date = case when $3::date is null or ($4::date is not null and $3::date > $4::date) then null else $3::date end, updated_at = now() where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, next, c.e,
  ]);
  return { invoiceId: inv.id, number: inv.number, events: inv.events };
}

/** Bills every active contract that is due, expires ended ones and renews auto-renewing ones. */
export async function runContracts(ctx: RecordCtx, on = today()) {
  assertManager(ctx, 'contracts');
  const out = { invoiced: 0, renewed: 0, expired: 0, failed: [] as { contract: string; error: string }[], events: [] as RecordEvent[] };
  const ended = await ctx.tx.query<{ id: string; auto_renew: boolean }>(`select id, auto_renew from service_contracts where tenant_id = $1 and status = 'active' and end_date < $2::date`, [ctx.tenantId, on]);
  for (const c of ended) {
    if (c.auto_renew) {
      await contractAction(ctx, c.id, 'renew');
      out.renewed++;
    } else {
      await ctx.tx.query(`update service_contracts set status = 'expired', next_invoice_date = null where tenant_id = $1 and id = $2`, [ctx.tenantId, c.id]);
      out.expired++;
    }
  }
  const due = await ctx.tx.query<{ id: string; contract_number: string }>(
    `select id, contract_number from service_contracts where tenant_id = $1 and status = 'active' and next_invoice_date <= $2::date order by next_invoice_date limit 500`,
    [ctx.tenantId, on],
  );
  for (const c of due) {
    await ctx.tx.query('savepoint contract_bill');
    try {
      const r = await invoiceContract(ctx, c.id);
      out.events.push(...r.events);
      out.invoiced++;
      await ctx.tx.query('release savepoint contract_bill');
    } catch (e) {
      await ctx.tx.query('rollback to savepoint contract_bill');
      out.failed.push({ contract: c.contract_number, error: (e as Error).message });
    }
  }
  return out;
}

/* ───────────────────────── change requests ───────────────────────── */

export interface CrInput {
  title: string;
  description?: string | null;
  reason?: string | null;
  requestedBy?: string | null;
  impactHours?: number;
  impactAmount?: number;
  impactDays?: number;
}

export async function listChangeRequests(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId);
  return ctx.tx.query(
    `select c.id, c.cr_number, c.title, c.description, c.reason, c.requested_by, c.impact_hours::float8 as impact_hours, c.impact_amount::float8 as impact_amount, c.impact_days,
            c.status, c.decided_by, c.decided_at, c.decision_note, c.applied, c.created_at, u.full_name as raised_by_name
       from change_requests c left join users u on u.tenant_id = c.tenant_id and u.id = c.raised_by
      where c.tenant_id = $1 and c.project_id = $2 order by c.cr_number desc`,
    [ctx.tenantId, projectId],
  );
}

export async function saveChangeRequest(ctx: RecordCtx, projectId: string, id: string | null, input: CrInput) {
  await projectAccess(ctx, projectId, 'member');
  if (id) {
    const r = await ctx.tx.one(
      `update change_requests set title = $4, description = $5, reason = $6, requested_by = $7, impact_hours = $8, impact_amount = $9, impact_days = $10
        where tenant_id = $1 and id = $2 and project_id = $3 and status = 'draft' returning id`,
      [ctx.tenantId, id, projectId, input.title, input.description ?? null, input.reason ?? null, input.requestedBy ?? null, input.impactHours ?? 0, input.impactAmount ?? 0, input.impactDays ?? 0],
    );
    if (!r) throw badRequest('Only a draft change request can be edited');
    return { id };
  }
  await ctx.tx.query(`select 1 from projects where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, projectId]);
  const n = (await ctx.tx.one<{ n: number }>(`select coalesce(max(cr_number), 0) + 1 as n from change_requests where tenant_id = $1 and project_id = $2`, [ctx.tenantId, projectId]))!.n;
  const r = await ctx.tx.one<{ id: string }>(
    `insert into change_requests (tenant_id, project_id, cr_number, title, description, reason, requested_by, impact_hours, impact_amount, impact_days) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, projectId, n, input.title, input.description ?? null, input.reason ?? null, input.requestedBy ?? null, input.impactHours ?? 0, input.impactAmount ?? 0, input.impactDays ?? 0],
  );
  return { id: r!.id, number: n };
}

/**
 * Moves a change request on. Approval (by the project manager, or by the client from the portal) adds its
 * impact to the project: budget hours, the fixed fee (or budget amount) and the end date.
 */
export async function changeRequestAction(ctx: RecordCtx | null, projectId: string, id: string, action: 'submit' | 'approve' | 'reject' | 'implemented' | 'reopen', opts: { by?: string | null; note?: string | null; tx?: RecordCtx['tx']; tenantId?: string } = {}) {
  const tx = ctx?.tx ?? opts.tx!;
  const tenantId = ctx?.tenantId ?? opts.tenantId!;
  if (ctx) await projectAccess(ctx, projectId, action === 'submit' || action === 'reopen' ? 'member' : 'manage');
  const cr = await tx.one<Record<string, any>>(`select * from change_requests where tenant_id = $1 and id = $2 and project_id = $3 for update`, [tenantId, id, projectId]);
  if (!cr) throw notFound('Change request not found');
  const from = cr.status as string;
  const allowed: Record<string, string[]> = { submit: ['draft'], approve: ['submitted'], reject: ['submitted'], implemented: ['approved'], reopen: ['rejected'] };
  if (!allowed[action]!.includes(from)) throw badRequest(`A ${from} change request cannot be ${action === 'implemented' ? 'marked implemented' : `${action}d`}`);
  const to = { submit: 'submitted', approve: 'approved', reject: 'rejected', implemented: 'implemented', reopen: 'draft' }[action];
  if (action === 'reject' && !opts.note?.trim()) throw badRequest('Say why it is rejected');
  const who = opts.by ?? (ctx ? (await tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [tenantId, ctx.principal.user.id]))?.full_name : null);
  await tx.query(
    `update change_requests set status = $3, decided_by = case when $3 in ('approved','rejected') then $4 else decided_by end, decided_at = case when $3 in ('approved','rejected') then now() else decided_at end,
            decision_note = case when $3 in ('approved','rejected') then $5 else decision_note end where tenant_id = $1 and id = $2`,
    [tenantId, id, to, who ?? null, opts.note ?? null],
  );
  if (action === 'approve' && !cr.applied) {
    await tx.query(
      `update projects set budget_hours = case when budget_hours is not null or $3 > 0 then coalesce(budget_hours, 0) + $3 else budget_hours end,
              fixed_fee = case when billing_method = 'fixed_price' and $4 > 0 then coalesce(fixed_fee, 0) + $4 else fixed_fee end,
              budget_amount = case when billing_method <> 'fixed_price' and budget_amount is not null then budget_amount + $4 else budget_amount end,
              end_date = case when end_date is not null and $5 > 0 then end_date + $5 else end_date end, updated_at = now()
        where tenant_id = $1 and id = $2`,
      [tenantId, projectId, Number(cr.impact_hours), Number(cr.impact_amount), Number(cr.impact_days)],
    );
    await tx.query(`update change_requests set applied = true where tenant_id = $1 and id = $2`, [tenantId, id]);
  }
  return { status: to };
}

/* ───────────────────────── capacity planning ───────────────────────── */

export async function listAllocations(ctx: RecordCtx, from: string, to: string) {
  if (!hasAdmin(ctx.principal.permissions, 'projects')) {
    const m = await ctx.tx.one(`select 1 from project_members where tenant_id = $1 and user_id = $2 and role = 'manager' limit 1`, [ctx.tenantId, ctx.principal.user.id]);
    const own = await ctx.tx.one(`select 1 from projects where tenant_id = $1 and owner_id = $2 limit 1`, [ctx.tenantId, ctx.principal.user.id]);
    if (!m && !own) throw forbidden('Capacity planning is for project managers');
  }
  const weeks: string[] = [];
  // weeks start on Monday
  const d0 = new Date(`${from}T00:00:00Z`);
  let w = addDays(from, -((d0.getUTCDay() + 6) % 7));
  for (let i = 0; i < 26 && w <= to; i++, w = addDays(w, 7)) weeks.push(w);
  const people = await ctx.tx.query<{ id: string; full_name: string; capacity: number }>(
    `select u.id, u.full_name, coalesce(c.weekly_hours, 40)::float8 as capacity from users u left join resource_capacity c on c.tenant_id = u.tenant_id and c.user_id = u.id
      where u.tenant_id = $1 and u.status = 'active' order by u.full_name`,
    [ctx.tenantId],
  );
  const allocs = await ctx.tx.query<{ id: string; user_id: string; project_id: string; project: string; start_date: string; end_date: string; hours_per_week: number; role: string | null }>(
    `select a.id, a.user_id, a.project_id, p.name as project, a.start_date::text, a.end_date::text, a.hours_per_week::float8 as hours_per_week, a.role
       from resource_allocations a join projects p on p.tenant_id = a.tenant_id and p.id = a.project_id and p.deleted_at is null
      where a.tenant_id = $1 and a.end_date >= $2::date and a.start_date <= $3::date order by a.start_date`,
    [ctx.tenantId, weeks[0] ?? from, to],
  );
  const logged = await ctx.tx.query<{ user_id: string; week: string; h: number }>(
    `select user_id, to_char(date_trunc('week', work_date), 'YYYY-MM-DD') as week, sum(minutes)::float8 / 60 as h from time_entries
      where tenant_id = $1 and work_date between $2::date and $3::date group by 1, 2`,
    [ctx.tenantId, weeks[0] ?? from, addDays(weeks[weeks.length - 1] ?? to, 6)],
  );
  const grid = people.map((p) => ({
    userId: p.id,
    name: p.full_name,
    capacity: p.capacity,
    weeks: weeks.map((wk) => {
      const end = addDays(wk, 6);
      const mine = allocs.filter((a) => a.user_id === p.id && a.start_date <= end && a.end_date >= wk);
      const planned = r2(mine.reduce((s, a) => s + a.hours_per_week, 0));
      return { week: wk, planned, logged: r2(logged.find((l) => l.user_id === p.id && l.week === wk)?.h ?? 0), load: p.capacity ? Math.round((planned / p.capacity) * 100) : 0, projects: mine.map((a) => a.project) };
    }),
  }));
  return { weeks, people: grid, allocations: allocs };
}

export async function saveAllocation(ctx: RecordCtx, id: string | null, input: { userId: string; projectId: string; startDate: string; endDate: string; hoursPerWeek: number; role?: string | null }) {
  await projectAccess(ctx, input.projectId, 'manage');
  if (input.endDate < input.startDate) throw badRequest('The allocation ends before it starts');
  if (!(await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2 and status = 'active'`, [ctx.tenantId, input.userId]))) throw badRequest('Person not found');
  if (id) {
    const r = await ctx.tx.one(`update resource_allocations set user_id = $3, project_id = $4, start_date = $5, end_date = $6, hours_per_week = $7, role = $8 where tenant_id = $1 and id = $2 returning id`, [
      ctx.tenantId, id, input.userId, input.projectId, input.startDate, input.endDate, input.hoursPerWeek, input.role ?? null,
    ]);
    if (!r) throw notFound('Allocation not found');
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into resource_allocations (tenant_id, user_id, project_id, start_date, end_date, hours_per_week, role) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [
    ctx.tenantId, input.userId, input.projectId, input.startDate, input.endDate, input.hoursPerWeek, input.role ?? null,
  ]);
  return { id: r!.id };
}

export async function deleteAllocation(ctx: RecordCtx, id: string) {
  const a = await ctx.tx.one<{ project_id: string }>(`select project_id from resource_allocations where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!a) throw notFound('Allocation not found');
  await projectAccess(ctx, a.project_id, 'manage');
  await ctx.tx.query(`delete from resource_allocations where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

/* ───────────────────────── estimates against actuals ───────────────────────── */

export async function estimateVsActual(ctx: RecordCtx, projectId: string) {
  await projectAccess(ctx, projectId);
  const rows = await ctx.tx.query<{ id: string; task_number: number; name: string; status: string; work_type: string; estimate: number | null; story_points: number | null; actual: number }>(
    `select t.id, t.task_number, t.name, t.status, t.work_type, t.estimate_hours::float8 as estimate, t.story_points::float8 as story_points,
            coalesce((select sum(minutes) from time_entries e where e.tenant_id = t.tenant_id and e.task_id = t.id and e.status <> 'rejected'), 0)::float8 / 60 as actual
       from project_tasks t where t.tenant_id = $1 and t.project_id = $2 and t.work_type <> 'epic' order by t.task_number`,
    [ctx.tenantId, projectId],
  );
  const est = rows.filter((r) => r.estimate);
  const done = est.filter((r) => r.status === 'done');
  const accuracy = done.length ? Math.round((done.reduce((s, r) => s + r.estimate!, 0) / Math.max(0.01, done.reduce((s, r) => s + r.actual, 0))) * 100) : null;
  return {
    tasks: rows.map((r) => ({ ...r, actual: r2(r.actual), variance: r.estimate ? r2(r.actual - r.estimate) : null })),
    totals: { estimate: r2(est.reduce((s, r) => s + r.estimate!, 0)), actual: r2(rows.reduce((s, r) => s + r.actual, 0)), unestimated: rows.filter((r) => !r.estimate && r.actual > 0).length },
    // estimated ÷ actual hours on finished work: 100% is spot on, below 100% means work takes longer than estimated
    accuracy,
  };
}
