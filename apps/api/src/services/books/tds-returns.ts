/**
 * TDS deposits and quarterly returns. Challans record the tax deposited each month (BSR code, challan
 * serial, CIN) and post the payment from the bank. The quarter's return worksheet lists every deduction —
 * 26Q from vendor bills, 24Q from payslips — against what was deposited for its month, flags missing PANs
 * (206AA: 20%), short or late deposits with the 1.5%-a-month interest, and exports the rows for the
 * return-preparation utility. The Form 16A register sums each vendor's deductions for the certificates.
 */
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { assertBooksAdmin, postJournal, r2, sys, voidSource } from './ledger';

export const challanSchema = z.object({
  nature: z.enum(['non_salary', 'salary']).default('non_salary'),
  section: z.string().trim().toUpperCase().regex(/^[0-9A-Z()]{3,12}$/).nullish(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'The month the tax was deducted (YYYY-MM)'),
  depositedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tax: z.number().min(0),
  interest: z.number().min(0).default(0),
  lateFee: z.number().min(0).default(0),
  bsrCode: z.union([z.literal(''), z.string().regex(/^\d{7}$/, 'BSR code is 7 digits')]).nullish(),
  challanNo: z.union([z.literal(''), z.string().regex(/^\d{1,5}$/, 'Challan serial is up to 5 digits')]).nullish(),
  cin: z.string().trim().max(40).nullish(),
  bankAccountId: z.string().uuid().nullish(),
  notes: z.string().trim().max(500).nullish(),
});

export async function listChallans(ctx: RecordCtx, from?: string, to?: string) {
  await assertBooksAdmin(ctx);
  return ctx.tx.query(
    `select c.id, c.nature, c.section, c.period, to_char(c.deposited_on, 'YYYY-MM-DD') as deposited_on, c.tax::float8 as tax, c.interest::float8 as interest, c.late_fee::float8 as late_fee,
            c.bsr_code, c.challan_no, c.cin, c.bank_account_id, c.journal_id, c.notes
       from tds_challans c where c.tenant_id = $1 and ($2::text is null or c.period >= $2) and ($3::text is null or c.period <= $3) order by c.period desc, c.deposited_on desc`,
    [ctx.tenantId, from ?? null, to ?? null],
  );
}

export async function saveChallan(ctx: RecordCtx, input: z.infer<typeof challanSchema>) {
  await assertBooksAdmin(ctx);
  if (input.tax + input.interest + input.lateFee <= 0) throw badRequest('Enter the amount deposited');
  const r = await ctx.tx.one<{ id: string }>(
    `insert into tds_challans (tenant_id, nature, section, period, deposited_on, tax, interest, late_fee, bsr_code, challan_no, cin, bank_account_id, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [ctx.tenantId, input.nature, input.section ?? null, input.period, input.depositedOn, input.tax, input.interest, input.lateFee, input.bsrCode || null, input.challanNo || null, input.cin ?? null, input.bankAccountId ?? null, input.notes ?? null],
  );
  // paid from a bank account in the books: TDS payable goes down, interest and late fee are expenses
  if (input.bankAccountId) {
    const b = await ctx.tx.one<{ gl_account_id: string }>(`select gl_account_id from bank_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.bankAccountId]);
    if (!b) throw badRequest('Choose a bank account in the books');
    const total = r2(input.tax + input.interest + input.lateFee);
    const jid = await postJournal(ctx.tx, ctx.tenantId, {
      date: input.depositedOn,
      sourceType: 'tds_challan',
      sourceId: r!.id,
      reference: input.cin || input.challanNo || null,
      narration: `TDS deposited for ${input.period}${input.section ? ` (${input.section})` : ''}`,
      lines: [
        { accountId: await sys(ctx.tx, ctx.tenantId, 'tds_payable'), debit: input.tax, taxKind: 'tds' },
        { accountId: await sys(ctx.tx, ctx.tenantId, 'interest_expense'), debit: r2(input.interest + input.lateFee), description: 'Interest / late fee on TDS' },
        { accountId: b.gl_account_id, credit: total },
      ],
    });
    await ctx.tx.query(`update tds_challans set journal_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r!.id, jid]);
  }
  return { id: r!.id };
}

export async function deleteChallan(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  const c = await ctx.tx.one<{ journal_id: string | null }>(`select journal_id from tds_challans where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!c) throw notFound();
  if (c.journal_id) await voidSource(ctx.tx, ctx.tenantId, 'tds_challan', id, 'Challan removed');
  await ctx.tx.query(`delete from tds_challans where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Q1 = Apr–Jun of FY starting `fy`. */
export function quarterMonths(fy: number, q: 1 | 2 | 3 | 4) {
  const start = [4, 7, 10, 1][q - 1]!;
  const year = q === 4 ? fy + 1 : fy;
  return [0, 1, 2].map((i) => `${year}-${String(start + i).padStart(2, '0')}`);
}

/** When tax deducted in a month is due: the 7th of the next month (30 April for March). */
export const depositDue = (period: string) => {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return m === 3 ? `${y}-04-30` : new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 7)).toISOString().slice(0, 10);
};

/** Interest under 201(1A): 1.5% for every month or part from deduction to deposit, when deposited late. */
export function lateInterest(amount: number, deductedOn: string, depositedOn: string, period: string) {
  if (depositedOn <= depositDue(period)) return 0;
  const a = new Date(`${deductedOn}T00:00:00Z`);
  const b = new Date(`${depositedOn}T00:00:00Z`);
  const months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + 1;
  return Math.round(amount * 0.015 * Math.max(1, months));
}

export async function quarterReturn(ctx: RecordCtx, fy: number, q: 1 | 2 | 3 | 4, form: '26Q' | '24Q') {
  await assertBooksAdmin(ctx);
  const months = quarterMonths(fy, q);
  const from = `${months[0]}-01`;
  const [ly, lm] = months[2]!.split('-').map(Number) as [number, number];
  const to = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);
  const rows =
    form === '26Q'
      ? await ctx.tx.query<{ id: string; party: string; pan: string | null; section: string | null; date: string; month: string; paid: number; rate: number; tds: number; ref: string | null }>(
          `select b.id, coalesce(v.name, '—') as party, v.pan, b.tds_section as section, to_char(b.bill_date, 'YYYY-MM-DD') as date, to_char(b.bill_date, 'YYYY-MM') as month,
                  b.taxable_total::float8 as paid, b.tds_rate::float8 as rate, b.tds_amount::float8 as tds, coalesce(b.vendor_ref, b.bill_number) as ref
             from bills b left join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
            where b.tenant_id = $1 and b.doc_type = 'bill' and b.tds_amount > 0 and b.status not in ('draft','void') and b.deleted_at is null and b.bill_date between $2::date and $3::date
            order by b.bill_date`,
          [ctx.tenantId, from, to],
        )
      : await ctx.tx.query<{ id: string; party: string; pan: string | null; section: string | null; date: string; month: string; paid: number; rate: number; tds: number; ref: string | null }>(
          `select p.id, e.name as party, e.pan, '192' as section, to_char(coalesce(r.pay_date, (r.period || '-28')::date), 'YYYY-MM-DD') as date, r.period as month,
                  p.gross::float8 as paid, case when p.gross > 0 then round(p.tds / p.gross * 100, 2)::float8 else 0 end as rate, p.tds::float8 as tds, r.period as ref
             from payslips p join payroll_runs r on r.tenant_id = p.tenant_id and r.id = p.run_id join employees e on e.tenant_id = p.tenant_id and e.id = p.employee_id
            where p.tenant_id = $1 and r.status <> 'draft' and r.period = any($2::text[]) order by r.period, e.name`,
          [ctx.tenantId, months],
        );
  const challans = await ctx.tx.query<{ id: string; period: string; section: string | null; deposited_on: string; tax: number; interest: number; late_fee: number; bsr_code: string | null; challan_no: string | null; cin: string | null }>(
    `select id, period, section, to_char(deposited_on, 'YYYY-MM-DD') as deposited_on, tax::float8 as tax, interest::float8 as interest, late_fee::float8 as late_fee, bsr_code, challan_no, cin
       from tds_challans where tenant_id = $1 and nature = $2 and period = any($3::text[]) order by deposited_on`,
    [ctx.tenantId, form === '24Q' ? 'salary' : 'non_salary', months],
  );
  const byMonth = months.map((m) => {
    const deducted = r2(rows.filter((r) => r.month === m).reduce((t, r) => t + r.tds, 0));
    const ch = challans.filter((c) => c.period === m);
    const deposited = r2(ch.reduce((t, c) => t + c.tax, 0));
    const lastDeposit = ch.map((c) => c.deposited_on).sort().pop() ?? null;
    const firstDeduction = rows.filter((r) => r.month === m).map((r) => r.date).sort()[0] ?? `${m}-01`;
    const interestDue = lastDeposit ? lateInterest(Math.min(deducted, deposited), firstDeduction, lastDeposit, m) : 0;
    const interestPaid = r2(ch.reduce((t, c) => t + c.interest, 0));
    return { month: m, due: depositDue(m), deducted, deposited, short: r2(Math.max(0, deducted - deposited)), lastDeposit, interestDue, interestPaid };
  });
  const warnings: string[] = [];
  const noPan = rows.filter((r) => !r.pan);
  if (noPan.length) warnings.push(`${noPan.length} deduction(s) without the deductee's PAN: tax is due at 20% (section 206AA) and the return will show them as PAN not available`);
  for (const b of byMonth) {
    if (b.short > 0) warnings.push(`${b.month}: ₹${b.short.toLocaleString('en-IN')} deducted but not deposited (due ${b.due})`);
    if (b.interestDue > b.interestPaid) warnings.push(`${b.month}: deposited late; interest of about ₹${(b.interestDue - b.interestPaid).toLocaleString('en-IN')} is due under 201(1A)`);
  }
  const fyLabel = `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;
  const dueDates = { 1: `${fy}-07-31`, 2: `${fy}-10-31`, 3: `${fy + 1}-01-31`, 4: `${fy + 1}-05-31` } as const;
  return {
    form,
    fy: fyLabel,
    quarter: `Q${q}`,
    returnDue: dueDates[q],
    rows,
    challans,
    byMonth,
    totals: { paid: r2(rows.reduce((t, r) => t + r.paid, 0)), tds: r2(rows.reduce((t, r) => t + r.tds, 0)), deposited: r2(challans.reduce((t, c) => t + c.tax, 0)) },
    bySection: [...rows.reduce((m, r) => m.set(r.section ?? '—', r2((m.get(r.section ?? '—') ?? 0) + r.tds)), new Map<string, number>())].map(([section, tds]) => ({ section, tds })),
    warnings,
  };
}

export function returnCsv(r: Awaited<ReturnType<typeof quarterReturn>>) {
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Deductee', 'PAN', 'Section', 'Date of payment / credit', 'Amount paid / credited', 'Rate %', 'TDS', 'Reference', 'Challan BSR', 'Challan date', 'Challan serial'];
  const lines = r.rows.map((x) => {
    const c = r.challans.find((c) => c.period === x.month && (!c.section || c.section === x.section)) ?? r.challans.find((c) => c.period === x.month);
    return [x.party, x.pan ?? 'PANNOTAVBL', x.section ?? '', x.date, x.paid.toFixed(2), x.rate, x.tds.toFixed(2), x.ref ?? '', c?.bsr_code ?? '', c?.deposited_on ?? '', c?.challan_no ?? ''];
  });
  return [head, ...lines].map((l) => l.map(esc).join(',')).join('\n');
}

/** Each vendor's deductions in the quarter, for the Form 16A certificates. */
export async function form16aRegister(ctx: RecordCtx, fy: number, q: 1 | 2 | 3 | 4) {
  const r = await quarterReturn(ctx, fy, q, '26Q');
  const by = new Map<string, { party: string; pan: string | null; sections: Set<string>; paid: number; tds: number; count: number }>();
  for (const x of r.rows) {
    const k = `${x.party}|${x.pan ?? ''}`;
    const cur = by.get(k) ?? { party: x.party, pan: x.pan, sections: new Set<string>(), paid: 0, tds: 0, count: 0 };
    cur.sections.add(x.section ?? '—');
    cur.paid = r2(cur.paid + x.paid);
    cur.tds = r2(cur.tds + x.tds);
    cur.count++;
    by.set(k, cur);
  }
  return [...by.values()].map((v) => ({ ...v, sections: [...v.sections].join(', ') })).sort((a, b) => b.tds - a.tds);
}
