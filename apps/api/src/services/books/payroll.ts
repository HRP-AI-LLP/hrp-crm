/**
 * Payroll: employees with their monthly salary, a run per month that works out each payslip —
 * earnings for the days paid, PF (12% employee, 12% + 1% admin/EDLI employer, on basic up to
 * ₹15,000 unless set to full basic), ESI (0.75% / 3.25% while gross ≤ ₹21,000), professional tax by
 * state, and TDS on salary (section 192) from the projected annual income — then posts the run to the
 * ledger and records the salary paid from a bank account.
 */
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { assertBooksAdmin, postJournal, r2, sys, voidSource } from './ledger';

export const employeeSchema = z.object({
  code: z.string().trim().max(20).nullish(),
  name: z.string().trim().min(1).max(150),
  userId: z.string().uuid().nullish(),
  email: z.union([z.literal(''), z.string().trim().toLowerCase().pipe(z.email())]).nullish(),
  phone: z.string().trim().max(25).nullish(),
  pan: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'PAN looks like ABCDE1234F')]).nullish(),
  uan: z.union([z.literal(''), z.string().trim().regex(/^[0-9]{12}$/, 'UAN is 12 digits')]).nullish(),
  esicNo: z.string().trim().max(20).nullish(),
  designation: z.string().trim().max(120).nullish(),
  department: z.string().trim().max(120).nullish(),
  joinedOn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).nullish(),
  leftOn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).nullish(),
  state: z.string().trim().max(60).nullish(),
  taxRegime: z.enum(['new', 'old']).default('new'),
  bankName: z.string().trim().max(120).nullish(),
  bankAccount: z.string().trim().max(30).nullish(),
  ifsc: z.union([z.literal(''), z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'IFSC looks like HDFC0001234')]).nullish(),
  basic: z.number().min(0).max(10_000_000),
  hra: z.number().min(0).max(10_000_000).default(0),
  special: z.number().min(0).max(10_000_000).default(0),
  otherAllowances: z.array(z.object({ name: z.string().trim().min(1).max(60), amount: z.number().min(0).max(10_000_000) })).max(10).default([]),
  pfEnabled: z.boolean().default(true),
  pfOnFullBasic: z.boolean().default(false),
  esiEnabled: z.boolean().default(true),
  ptEnabled: z.boolean().default(false),
  annualDeductions: z.number().min(0).max(10_000_000).default(0),
  status: z.enum(['active', 'left']).default('active'),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

const nz = (v: string | null | undefined) => (v === '' || v === undefined ? null : v);

export async function listEmployees(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  return ctx.tx.query(
    `select id, code, name, user_id, email, phone, pan, uan, esic_no, designation, department, to_char(joined_on, 'YYYY-MM-DD') as joined_on, to_char(left_on, 'YYYY-MM-DD') as left_on, state, tax_regime,
            bank_name, bank_account, ifsc, basic::float8 as basic, hra::float8 as hra, special::float8 as special, other_allowances, pf_enabled, pf_on_full_basic, esi_enabled, pt_enabled,
            annual_deductions::float8 as annual_deductions, status
       from employees where tenant_id = $1 order by status, name`,
    [ctx.tenantId],
  );
}

export async function saveEmployee(ctx: RecordCtx, id: string | null, e: EmployeeInput) {
  await assertBooksAdmin(ctx);
  const vals = [
    nz(e.code), e.name, e.userId ?? null, nz(e.email), nz(e.phone), nz(e.pan), nz(e.uan), nz(e.esicNo), nz(e.designation), nz(e.department), nz(e.joinedOn), nz(e.leftOn), nz(e.state), e.taxRegime,
    nz(e.bankName), nz(e.bankAccount), nz(e.ifsc), e.basic, e.hra, e.special, JSON.stringify(e.otherAllowances), e.pfEnabled, e.pfOnFullBasic, e.esiEnabled, e.ptEnabled, e.annualDeductions, e.status,
  ];
  const cols = 'code, name, user_id, email, phone, pan, uan, esic_no, designation, department, joined_on, left_on, state, tax_regime, bank_name, bank_account, ifsc, basic, hra, special, other_allowances, pf_enabled, pf_on_full_basic, esi_enabled, pt_enabled, annual_deductions, status';
  if (id) {
    const r = await ctx.tx.one<{ id: string }>(
      `update employees set (${cols}, updated_at) = (${vals.map((_, i) => `$${i + 3}`).join(',')}, now()) where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals],
    );
    if (!r) throw notFound();
    return { id };
  }
  const r = await ctx.tx.one<{ id: string }>(`insert into employees (tenant_id, ${cols}) values ($1, ${vals.map((_, i) => `$${i + 2}`).join(',')}) returning id`, [ctx.tenantId, ...vals]);
  return { id: r!.id };
}

/* ───────────── the arithmetic ───────────── */

/** Monthly professional tax by state, on the month's gross (February where the state collects more). */
export function professionalTax(state: string | null | undefined, gross: number, month: number): number {
  const s = (state ?? '').toLowerCase();
  if (/maharashtra/.test(s)) return gross <= 7500 ? 0 : gross <= 10000 ? 175 : month === 2 ? 300 : 200;
  if (/karnataka/.test(s)) return gross >= 25000 ? 200 : 0;
  if (/telangana|andhra/.test(s)) return gross > 20000 ? 200 : gross > 15000 ? 150 : 0;
  if (/west bengal/.test(s)) return gross > 40000 ? 200 : gross > 25000 ? 150 : gross > 15000 ? 130 : gross > 10000 ? 110 : 0;
  if (/gujarat/.test(s)) return gross >= 12000 ? 200 : 0;
  if (/madhya pradesh/.test(s)) return gross > 41666 ? (month === 3 ? 212 : 208) : gross > 25000 ? 125 : 0;
  if (/tamil nadu/.test(s)) return gross > 75000 ? 208 : gross > 60000 ? 171 : gross > 45000 ? 115 : gross > 30000 ? 53 : gross > 21000 ? 23 : 0;
  if (/kerala/.test(s)) return gross >= 20000 ? 208 : gross >= 15000 ? 167 : gross >= 12000 ? 125 : 0;
  if (/assam|meghalaya|tripura|sikkim|odisha|bihar|jharkhand|punjab|manipur|mizoram|nagaland/.test(s)) return gross > 25000 ? 208 : 0;
  return 0; // Uttar Pradesh, Delhi, Haryana, Rajasthan and others levy none on salaries
}

/** Income tax on a year's taxable income, with the rebate and 4% cess (FY 2025-26 onwards slabs). */
export function incomeTax(taxable: number, regime: 'new' | 'old'): number {
  const slabs: [number, number][] =
    regime === 'new'
      ? [[400000, 0], [800000, 0.05], [1200000, 0.1], [1600000, 0.15], [2000000, 0.2], [2400000, 0.25], [Infinity, 0.3]]
      : [[250000, 0], [500000, 0.05], [1000000, 0.2], [Infinity, 0.3]];
  let tax = 0;
  let prev = 0;
  for (const [upto, rate] of slabs) {
    if (taxable > prev) tax += (Math.min(taxable, upto) - prev) * rate;
    prev = upto;
  }
  // rebate under section 87A
  if ((regime === 'new' && taxable <= 1200000) || (regime === 'old' && taxable <= 500000)) tax = 0;
  else if (regime === 'new' && taxable <= 1275000) tax = Math.min(tax, taxable - 1200000); // marginal relief
  return Math.round(tax * 1.04);
}

interface Emp {
  id: string;
  name: string;
  basic: number;
  hra: number;
  special: number;
  other_allowances: { name: string; amount: number }[];
  pf_enabled: boolean;
  pf_on_full_basic: boolean;
  esi_enabled: boolean;
  pt_enabled: boolean;
  state: string | null;
  tax_regime: 'new' | 'old';
  annual_deductions: number;
}

export function computePayslip(e: Emp, period: string, paidDays: number, override: { tds?: number | null; other?: number } = {}) {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const f = Math.max(0, Math.min(1, paidDays / daysInMonth));
  const parts = [
    { name: 'Basic', full: e.basic },
    { name: 'HRA', full: e.hra },
    { name: 'Special allowance', full: e.special },
    ...(e.other_allowances ?? []).map((a) => ({ name: a.name, full: Number(a.amount) })),
  ].filter((p) => p.full > 0);
  const earnings = parts.map((p) => ({ name: p.name, amount: r2(p.full * f) }));
  const gross = r2(earnings.reduce((t, x) => t + x.amount, 0));
  const fullGross = parts.reduce((t, p) => t + p.full, 0);
  const basicEarned = earnings.find((x) => x.name === 'Basic')?.amount ?? 0;
  const pfWage = e.pf_enabled ? (e.pf_on_full_basic ? basicEarned : Math.min(basicEarned, 15000)) : 0;
  const employeePf = Math.round(pfWage * 0.12);
  const employerPf = Math.round(pfWage * 0.13);
  const esiOn = e.esi_enabled && fullGross <= 21000;
  const employeeEsi = esiOn ? Math.ceil(gross * 0.0075) : 0;
  const employerEsi = esiOn ? Math.ceil(gross * 0.0325) : 0;
  const pt = e.pt_enabled ? professionalTax(e.state, gross, m) : 0;
  // TDS: the year's tax on this salary, spread evenly over the months
  const annual = fullGross * 12;
  const std = e.tax_regime === 'new' ? 75000 : 50000;
  const fullPfWage = e.pf_enabled ? (e.pf_on_full_basic ? e.basic : Math.min(e.basic, 15000)) : 0;
  const oldDeductions = e.tax_regime === 'old' ? Math.min(150000, Number(e.annual_deductions) + Math.round(fullPfWage * 0.12) * 12) + pt * 12 : 0;
  const taxable = Math.max(0, annual - std - oldDeductions);
  const autoTds = Math.round(incomeTax(taxable, e.tax_regime) / 12);
  const tds = override.tds != null ? r2(override.tds) : autoTds;
  const other = r2(override.other ?? 0);
  const net = r2(gross - employeePf - employeeEsi - pt - tds - other);
  return { daysInMonth, earnings, gross, employeePf, employerPf, employeeEsi, employerEsi, pt, tds, other, net, projectedTaxable: taxable };
}

/* ───────────── runs ───────────── */

const empCols = `id, name, basic::float8 as basic, hra::float8 as hra, special::float8 as special, other_allowances, pf_enabled, pf_on_full_basic, esi_enabled, pt_enabled, state, tax_regime, annual_deductions::float8 as annual_deductions, joined_on, left_on`;

export async function createRun(ctx: RecordCtx, period: string) {
  await assertBooksAdmin(ctx);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw badRequest('Choose the month (YYYY-MM)');
  if (await ctx.tx.one(`select 1 from payroll_runs where tenant_id = $1 and period = $2`, [ctx.tenantId, period])) throw conflict(`Payroll for ${period} already exists`);
  const [y, m] = period.split('-').map(Number) as [number, number];
  const first = `${period}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const emps = await ctx.tx.query<Emp & { joined_on: Date | null; left_on: Date | null }>(
    `select ${empCols} from employees where tenant_id = $1 and (status = 'active' or left_on >= $2::date) and (joined_on is null or joined_on <= $3::date) order by name`,
    [ctx.tenantId, first, last],
  );
  if (!emps.length) throw badRequest('Add the employees first');
  const run = await ctx.tx.one<{ id: string }>(`insert into payroll_runs (tenant_id, period, pay_date) values ($1,$2,$3) returning id`, [ctx.tenantId, period, last]);
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();
  for (const e of emps) {
    // part months for people who joined or left during it
    const from = e.joined_on && e.joined_on.toISOString().slice(0, 10) > first ? Number(e.joined_on.toISOString().slice(8, 10)) : 1;
    const to = e.left_on && e.left_on.toISOString().slice(0, 10) < last ? Number(e.left_on.toISOString().slice(8, 10)) : dim;
    const days = Math.max(0, to - from + 1);
    await writeSlip(ctx, run!.id, e, period, days);
  }
  await totals(ctx, run!.id);
  return getRun(ctx, run!.id);
}

async function writeSlip(ctx: RecordCtx, runId: string, e: Emp, period: string, paidDays: number, override: { tds?: number | null; other?: number; note?: string | null } = {}) {
  const p = computePayslip(e, period, paidDays, override);
  await ctx.tx.query(
    `insert into payslips (tenant_id, run_id, employee_id, days_in_month, paid_days, earnings, gross, employee_pf, employer_pf, employee_esi, employer_esi, pt, tds, other_deductions, net, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     on conflict (tenant_id, run_id, employee_id) do update set paid_days = excluded.paid_days, earnings = excluded.earnings, gross = excluded.gross, employee_pf = excluded.employee_pf,
        employer_pf = excluded.employer_pf, employee_esi = excluded.employee_esi, employer_esi = excluded.employer_esi, pt = excluded.pt, tds = excluded.tds, other_deductions = excluded.other_deductions,
        net = excluded.net, note = excluded.note`,
    [ctx.tenantId, runId, e.id, p.daysInMonth, paidDays, JSON.stringify(p.earnings), p.gross, p.employeePf, p.employerPf, p.employeeEsi, p.employerEsi, p.pt, p.tds, p.other, p.net, override.note ?? null],
  );
}

async function totals(ctx: RecordCtx, runId: string) {
  await ctx.tx.query(
    `update payroll_runs r set gross = s.gross, net = s.net, employer_cost = s.cost, updated_at = now()
       from (select coalesce(sum(gross), 0) as gross, coalesce(sum(net), 0) as net, coalesce(sum(gross + employer_pf + employer_esi), 0) as cost from payslips where tenant_id = $1 and run_id = $2) s
      where r.tenant_id = $1 and r.id = $2`,
    [ctx.tenantId, runId],
  );
}

export async function listRuns(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  return ctx.tx.query(
    `select id, period, status, to_char(pay_date, 'YYYY-MM-DD') as pay_date, gross::float8 as gross, net::float8 as net, employer_cost::float8 as employer_cost,
            (select count(*)::int from payslips p where p.tenant_id = r.tenant_id and p.run_id = r.id) as people
       from payroll_runs r where tenant_id = $1 order by period desc limit 36`,
    [ctx.tenantId],
  );
}

export async function getRun(ctx: RecordCtx, id: string): Promise<Record<string, any>> {
  await assertBooksAdmin(ctx);
  const run = await ctx.tx.one<Record<string, any>>(
    `select id, period, status, to_char(pay_date, 'YYYY-MM-DD') as pay_date, gross::float8 as gross, net::float8 as net, employer_cost::float8 as employer_cost, journal_id, paid_journal_id from payroll_runs where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id],
  );
  if (!run) throw notFound();
  const slips = await ctx.tx.query(
    `select p.id, p.employee_id, e.name, e.code, e.designation, e.pan, e.uan, e.bank_account, e.ifsc, p.days_in_month, p.paid_days::float8 as paid_days, p.earnings, p.gross::float8 as gross,
            p.employee_pf::float8 as employee_pf, p.employer_pf::float8 as employer_pf, p.employee_esi::float8 as employee_esi, p.employer_esi::float8 as employer_esi, p.pt::float8 as pt,
            p.tds::float8 as tds, p.other_deductions::float8 as other_deductions, p.net::float8 as net, p.note
       from payslips p join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id where p.tenant_id = $1 and p.run_id = $2 order by e.name`,
    [ctx.tenantId, id],
  );
  return { ...run, slips };
}

export async function updateSlip(ctx: RecordCtx, runId: string, slipId: string, input: { paidDays: number; tds?: number | null; otherDeductions?: number; note?: string | null }) {
  await assertBooksAdmin(ctx);
  const run = await ctx.tx.one<{ status: string; period: string }>(`select status, period from payroll_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]);
  if (!run) throw notFound();
  if (run.status !== 'draft') throw conflict('This payroll is posted; reopen it to change a payslip');
  const s = await ctx.tx.one<{ employee_id: string; days_in_month: number }>(`select employee_id, days_in_month from payslips where tenant_id = $1 and id = $2 and run_id = $3`, [ctx.tenantId, slipId, runId]);
  if (!s) throw notFound();
  if (input.paidDays < 0 || input.paidDays > s.days_in_month) throw badRequest(`Paid days must be between 0 and ${s.days_in_month}`);
  const e = await ctx.tx.one<Emp>(`select ${empCols} from employees where tenant_id = $1 and id = $2`, [ctx.tenantId, s.employee_id]);
  await writeSlip(ctx, runId, e!, run.period, input.paidDays, { tds: input.tds, other: input.otherDeductions, note: input.note });
  await totals(ctx, runId);
  return getRun(ctx, runId);
}

/** Posts the month's salary: expense and employer's share against what is owed to staff and the authorities. */
export async function postRun(ctx: RecordCtx, runId: string) {
  await assertBooksAdmin(ctx);
  const r = await getRun(ctx, runId);
  if (r.status !== 'draft') throw conflict('Already posted');
  const slips = r.slips as Record<string, number>[];
  const sum = (k: string) => r2(slips.reduce((t, s) => t + Number(s[k] ?? 0), 0));
  const t = ctx.tenantId;
  const [y, m] = String(r.period).split('-').map(Number) as [number, number];
  const date = r.pay_date ?? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const jid = await postJournal(ctx.tx, t, {
    date,
    sourceType: 'payroll',
    sourceId: runId,
    reference: `Payroll ${r.period}`,
    narration: `Salaries for ${r.period}: ${slips.length} employee(s)`,
    lines: [
      { accountId: await sys(ctx.tx, t, 'salaries'), debit: sum('gross') },
      { accountId: await sys(ctx.tx, t, 'employer_contributions'), debit: r2(sum('employer_pf') + sum('employer_esi')) },
      { accountId: await sys(ctx.tx, t, 'salaries_payable'), credit: sum('net'), description: 'Net salary payable' },
      { accountId: await sys(ctx.tx, t, 'pf_payable'), credit: r2(sum('employee_pf') + sum('employer_pf')), description: 'PF: employee and employer' },
      { accountId: await sys(ctx.tx, t, 'esi_payable'), credit: r2(sum('employee_esi') + sum('employer_esi')), description: 'ESI: employee and employer' },
      { accountId: await sys(ctx.tx, t, 'pt_payable'), credit: sum('pt') },
      { accountId: await sys(ctx.tx, t, 'tds_payable'), credit: sum('tds'), taxKind: 'tds', description: 'TDS on salary (192)' },
      // other deductions (advances or loans recovered …): set against what staff owe the business
      { accountId: await sys(ctx.tx, t, 'employee_payable'), credit: sum('other_deductions'), description: 'Recovered from salaries (advances, loans)' },
    ],
  });
  await ctx.tx.query(`update payroll_runs set status = 'posted', journal_id = $3, pay_date = $4, updated_at = now() where tenant_id = $1 and id = $2`, [t, runId, jid, date]);
  return getRun(ctx, runId);
}

/** Takes a posted (not yet paid) run back to draft: its entry is voided. */
export async function reopenRun(ctx: RecordCtx, runId: string) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one<{ status: string }>(`select status from payroll_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]);
  if (!r) throw notFound();
  if (r.status === 'paid') throw conflict('Salaries are already paid: reverse the payment first');
  if (r.status === 'posted') await voidSource(ctx.tx, ctx.tenantId, 'payroll', runId, 'Payroll reopened');
  await ctx.tx.query(`update payroll_runs set status = 'draft', journal_id = null, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]);
  return getRun(ctx, runId);
}

/** The net salaries paid from a bank account (one transfer or many, booked together). */
export async function payRun(ctx: RecordCtx, runId: string, input: { bankAccountId: string; date: string }) {
  await assertBooksAdmin(ctx);
  const r = await getRun(ctx, runId);
  if (r.status !== 'posted') throw conflict(r.status === 'paid' ? 'Already paid' : 'Post the payroll first');
  const b = await ctx.tx.one<{ gl_account_id: string }>(`select gl_account_id from bank_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.bankAccountId]);
  if (!b) throw badRequest('Choose the bank account the salaries were paid from');
  const jid = await postJournal(ctx.tx, ctx.tenantId, {
    date: input.date,
    sourceType: 'payroll_payment',
    sourceId: runId,
    reference: `Salaries ${r.period}`,
    narration: `Net salaries paid for ${r.period}`,
    lines: [
      { accountId: await sys(ctx.tx, ctx.tenantId, 'salaries_payable'), debit: Number(r.net) },
      { accountId: b.gl_account_id, credit: Number(r.net) },
    ],
  });
  await ctx.tx.query(`update payroll_runs set status = 'paid', paid_journal_id = $3, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, runId, jid]);
  return getRun(ctx, runId);
}

export async function deleteRun(ctx: RecordCtx, runId: string) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one<{ status: string }>(`select status from payroll_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]);
  if (!r) throw notFound();
  if (r.status !== 'draft') throw conflict('Only a draft payroll can be deleted');
  await ctx.tx.query(`delete from payroll_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId]);
  return { ok: true };
}
