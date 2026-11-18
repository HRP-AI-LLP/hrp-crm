/**
 * The statutory compliance calendar: every filing the business owes in a financial year, worked out
 * from what it is (LLP, company, proprietorship), whether it has a GSTIN, a TAN and staff on PF / ESI /
 * professional tax, and its turnover (audits). Each item is tracked to filed, with the SRN / ARN /
 * acknowledgement, the amount paid and the papers; the people responsible are reminded a week before
 * and the day before. Due dates are the statutory ones — extensions notified by MCA / CBDT / CBIC are
 * set on the item by hand.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { systemCtxFor } from '../system';
import { assertBooksAdmin } from './ledger';

export interface Due {
  key: string;
  period: string;
  name: string;
  authority: 'MCA' | 'GST' | 'Income tax' | 'TDS' | 'EPFO' | 'ESIC' | 'State' | 'Other';
  due: string;
  description: string;
  personId?: string | null;
}

export const complianceSettingsSchema = z.object({
  gstReturns: z.enum(['monthly', 'qrmp', 'none']).default('monthly'),
  audit: z.enum(['auto', 'yes', 'no']).default('auto'),
  taxAudit: z.enum(['auto', 'yes', 'no']).default('auto'),
  defaultAssigneeId: z.string().uuid().nullish(),
});
export type ComplianceSettings = z.infer<typeof complianceSettingsSchema>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The months of financial year starting April `y`: [year, month] */
const fyMonths = (y: number) => Array.from({ length: 12 }, (_, i) => (i < 9 ? [y, i + 4] : [y + 1, i - 8]) as [number, number]);
const next = (y: number, m: number) => (m === 12 ? [y + 1, 1] : [y, m + 1]) as [number, number];

export interface Facts {
  fyStart: number; // 2026 for FY 2026-27
  constitution: string; // llp, private_limited, …
  gst: boolean;
  tds: boolean;
  pf: boolean;
  esi: boolean;
  pt: boolean;
  payroll: boolean;
  partners: { id: string; name: string }[]; // designated partners / directors with a DIN
  turnover: number; // last year's
  settings: ComplianceSettings;
}

/** Everything due for the financial year starting April `fyStart`. Pure, so it can be tested. */
export function dueList(f: Facts): Due[] {
  const y = f.fyStart;
  const fy = `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
  const out: Due[] = [];
  const llp = f.constitution === 'llp';
  const company = ['private_limited', 'public_limited', 'opc', 'section_8'].includes(f.constitution);
  const audit = f.settings.audit === 'yes' || (f.settings.audit === 'auto' && (company || (llp && f.turnover > 40_00_000)));
  const taxAudit = f.settings.taxAudit === 'yes' || (f.settings.taxAudit === 'auto' && f.turnover > 1_00_00_000);
  const itrDue = audit || taxAudit || company ? ymd(y + 1, 10, 31) : ymd(y + 1, 7, 31);

  // ── MCA ──
  if (llp) {
    out.push({ key: 'llp_form11', period: fy, name: 'LLP Form 11 — Annual return', authority: 'MCA', due: ymd(y + 1, 5, 30), description: 'Details of partners and contribution as on 31 March, filed within 60 days of the year end. Late fee ₹100 a day.' });
    if (audit) out.push({ key: 'llp_audit', period: fy, name: 'Statutory audit of LLP accounts', authority: 'MCA', due: ymd(y + 1, 9, 30), description: 'Required when turnover exceeds ₹40 lakh or contribution exceeds ₹25 lakh; Form 8 is then certified by the auditor.' });
    out.push({ key: 'llp_form8', period: fy, name: 'LLP Form 8 — Statement of account and solvency', authority: 'MCA', due: ymd(y + 1, 10, 30), description: 'Statement of assets, liabilities, income and expenditure with the solvency declaration, signed by the designated partners. Late fee ₹100 a day.' });
    out.push({ key: 'llp_form3_4', period: fy, name: 'LLP Form 3 / Form 4 — any change in the agreement or partners', authority: 'MCA', due: ymd(y + 1, 3, 31), description: 'Event-based: within 30 days of changing the LLP agreement (Form 3) or admitting / removing a partner (Form 4). Mark not applicable if nothing changed this year.' });
  }
  if (company) {
    out.push({ key: 'agm', period: fy, name: 'Annual general meeting', authority: 'MCA', due: ymd(y + 1, 9, 30), description: 'Within six months of the year end; adopts the audited accounts.' });
    out.push({ key: 'aoc4', period: fy, name: 'AOC-4 — Financial statements', authority: 'MCA', due: ymd(y + 1, 10, 30), description: 'Within 30 days of the AGM.' });
    out.push({ key: 'mgt7', period: fy, name: 'MGT-7 / MGT-7A — Annual return', authority: 'MCA', due: ymd(y + 1, 11, 29), description: 'Within 60 days of the AGM.' });
    out.push({ key: 'dpt3', period: fy, name: 'DPT-3 — Return of deposits', authority: 'MCA', due: ymd(y + 1, 6, 30), description: 'Outstanding loans and money received that are not deposits, as on 31 March.' });
    out.push({ key: 'msme1_h2', period: `${fy} H2`, name: 'MSME-1 — Dues to micro and small enterprises (Oct–Mar)', authority: 'MCA', due: ymd(y + 1, 4, 30), description: 'Only if payments to MSME vendors were pending over 45 days.' });
    out.push({ key: 'msme1_h1', period: `${fy} H1`, name: 'MSME-1 — Dues to micro and small enterprises (Apr–Sep)', authority: 'MCA', due: ymd(y, 10, 31), description: 'Only if payments to MSME vendors were pending over 45 days.' });
  }
  for (const p of f.partners)
    out.push({ key: `dir3kyc:${p.id}`, period: fy, name: `DIR-3 KYC — ${p.name}`, authority: 'MCA', due: ymd(y + 1, 9, 30), description: 'Annual KYC of every DIN / DPIN holder. Late fee ₹5,000 and the DIN is deactivated.', personId: p.id });

  // ── Income tax ──
  if (taxAudit) out.push({ key: 'tax_audit', period: fy, name: 'Tax audit report — Form 3CB-3CD', authority: 'Income tax', due: ymd(y + 1, 9, 30), description: 'When turnover exceeds ₹1 crore (₹10 crore if 95% of receipts and payments are digital), or ₹50 lakh of professional receipts.' });
  out.push({ key: 'itr', period: fy, name: `Income tax return — ${llp ? 'ITR-5' : company ? 'ITR-6' : 'ITR'}`, authority: 'Income tax', due: itrDue, description: audit || taxAudit || company ? 'Due 31 October where accounts are audited.' : 'Due 31 July where no audit applies.' });
  for (const [m, d, pct] of [[6, 15, 15], [9, 15, 45], [12, 15, 75], [3, 15, 100]] as const) {
    const yy = m === 3 ? y + 1 : y;
    out.push({ key: 'advance_tax', period: `${fy} ${MONTHS[m - 1]}`, name: `Advance tax — ${pct}% of the year's tax`, authority: 'Income tax', due: ymd(yy, m, d), description: 'Payable when the tax for the year exceeds ₹10,000 (challan ITNS 280). Interest under 234B / 234C if short.' });
  }

  // ── GST ──
  if (f.gst && f.settings.gstReturns !== 'none') {
    for (const [yy, m] of fyMonths(y)) {
      const [ny, nm] = next(yy, m);
      const per = `${yy}-${String(m).padStart(2, '0')}`;
      const label = `${MONTHS[m - 1]} ${yy}`;
      if (f.settings.gstReturns === 'monthly') {
        out.push({ key: 'gstr1', period: per, name: `GSTR-1 — ${label}`, authority: 'GST', due: ymd(ny, nm, 11), description: 'Outward supplies of the month.' });
        out.push({ key: 'gstr3b', period: per, name: `GSTR-3B — ${label}`, authority: 'GST', due: ymd(ny, nm, 20), description: 'Summary return and tax payment.' });
      } else if (m % 3 === 0) {
        const q = `Q${((m - 4 + 12) % 12) / 3 + 1}`;
        out.push({ key: 'gstr1', period: `${fy} ${q}`, name: `GSTR-1 (QRMP) — ${q} ${fy}`, authority: 'GST', due: ymd(ny, nm, 13), description: 'Quarterly outward supplies.' });
        out.push({ key: 'gstr3b', period: `${fy} ${q}`, name: `GSTR-3B (QRMP) — ${q} ${fy}`, authority: 'GST', due: ymd(ny, nm, 22), description: 'Quarterly summary return (22nd or 24th by state).' });
      } else out.push({ key: 'gst_pmt06', period: per, name: `PMT-06 — GST payment for ${label}`, authority: 'GST', due: ymd(ny, nm, 25), description: 'Monthly tax payment under QRMP.' });
    }
    out.push({ key: 'gstr9', period: fy, name: 'GSTR-9 — Annual return', authority: 'GST', due: ymd(y + 1, 12, 31), description: 'Optional below ₹2 crore turnover; GSTR-9C (reconciliation) above ₹5 crore.' });
  }

  // ── TDS ──
  if (f.tds) {
    for (const [yy, m] of fyMonths(y)) {
      const [ny, nm] = next(yy, m);
      out.push({ key: 'tds_deposit', period: `${yy}-${String(m).padStart(2, '0')}`, name: `TDS deposit — ${MONTHS[m - 1]} ${yy}`, authority: 'TDS', due: m === 3 ? ymd(yy, 4, 30) : ymd(ny, nm, 7), description: 'Tax deducted in the month, by challan ITNS 281. Interest 1.5% a month when late.' });
    }
    const qs: [string, number, number, number, number][] = [['Q1', y, 7, 31, 8], ['Q2', y, 10, 31, 11], ['Q3', y + 1, 1, 31, 2], ['Q4', y + 1, 5, 31, 6]];
    for (const [q, yy, m, d, certM] of qs) {
      out.push({ key: 'tds_26q', period: `${fy} ${q}`, name: `TDS return 26Q — ${q} ${fy}`, authority: 'TDS', due: ymd(yy, m, d), description: 'Non-salary TDS (194C, 194J, 194I, 194H …). Late fee ₹200 a day (234E).' });
      out.push({ key: 'form16a', period: `${fy} ${q}`, name: `Form 16A to vendors — ${q} ${fy}`, authority: 'TDS', due: ymd(yy, certM, 15), description: 'TDS certificates from TRACES, within 15 days of the return due date.' });
      if (f.payroll) out.push({ key: 'tds_24q', period: `${fy} ${q}`, name: `TDS return 24Q — ${q} ${fy}`, authority: 'TDS', due: ymd(yy, m, d), description: 'TDS on salaries (192).' });
    }
    if (f.payroll) out.push({ key: 'form16', period: fy, name: 'Form 16 to employees', authority: 'TDS', due: ymd(y + 1, 6, 15), description: 'Annual salary TDS certificate.' });
  }

  // ── Payroll ──
  for (const [yy, m] of fyMonths(y)) {
    const [ny, nm] = next(yy, m);
    const per = `${yy}-${String(m).padStart(2, '0')}`;
    const label = `${MONTHS[m - 1]} ${yy}`;
    if (f.pf) out.push({ key: 'pf_ecr', period: per, name: `PF — ECR and payment for ${label}`, authority: 'EPFO', due: ymd(ny, nm, 15), description: 'Employee and employer contribution through the unified portal.' });
    if (f.esi) out.push({ key: 'esi', period: per, name: `ESI — contribution for ${label}`, authority: 'ESIC', due: ymd(ny, nm, 15), description: 'Employee 0.75% and employer 3.25% of wages up to ₹21,000.' });
    if (f.pt) out.push({ key: 'pt', period: per, name: `Professional tax — ${label}`, authority: 'State', due: ymd(ny, nm, lastDay(ny, nm)), description: 'Deducted from salaries; the due date and return differ by state.' });
  }
  return out.sort((a, b) => a.due.localeCompare(b.due));
}

export async function complianceSettings(ctx: RecordCtx): Promise<ComplianceSettings> {
  const t = await ctx.tx.one<{ c: any }>(`select settings -> 'compliance' as c from tenants where id = $1`, [ctx.tenantId]);
  return complianceSettingsSchema.parse(t?.c ?? {});
}

export async function saveComplianceSettings(ctx: RecordCtx, s: ComplianceSettings) {
  await assertBooksAdmin(ctx);
  await ctx.tx.query(`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{compliance}', $2::jsonb) where id = $1`, [ctx.tenantId, JSON.stringify(s)]);
  return s;
}

async function facts(ctx: RecordCtx, fyStart: number): Promise<Facts> {
  const t = ctx.tenantId;
  const ten = await ctx.tx.one<{ company: any }>(`select settings -> 'company' as company from tenants where id = $1`, [t]);
  const c = ten?.company ?? {};
  const cfg = await ctx.tx.one<{ tan: string | null; tds_enabled: boolean }>(`select tan, tds_enabled from books_config where tenant_id = $1`, [t]);
  const gstConn = await ctx.tx.one(`select 1 from gst_connections where tenant_id = $1 limit 1`, [t]);
  const emp = await ctx.tx.one<{ n: number; pf: boolean; esi: boolean; pt: boolean }>(
    `select count(*)::int as n, coalesce(bool_or(pf_enabled), false) as pf, coalesce(bool_or(esi_enabled and basic + hra + special <= 21000), false) as esi, coalesce(bool_or(pt_enabled), false) as pt
       from employees where tenant_id = $1 and status = 'active'`,
    [t],
  );
  const partners = await ctx.tx.query<{ id: string; name: string }>(
    `select id, name from acct_persons where tenant_id = $1 and is_active and din is not null and role in ('partner','director') order by name`,
    [t],
  );
  const turn = await ctx.tx.one<{ v: number }>(
    `select coalesce(sum(case when doc_type = 'credit_note' then -taxable_total else taxable_total end), 0)::float8 as v from invoices
      where tenant_id = $1 and deleted_at is null and doc_type in ('tax_invoice','credit_note') and status not in ('draft','cancelled') and invoice_date >= $2::date and invoice_date < $3::date`,
    [t, `${fyStart - 1}-04-01`, `${fyStart}-04-01`],
  );
  return {
    fyStart,
    constitution: String(c.constitution ?? ''),
    gst: !!(c.gstin || gstConn),
    tds: !!(cfg?.tan || cfg?.tds_enabled || c.tan),
    pf: !!emp?.pf,
    esi: !!emp?.esi,
    pt: !!emp?.pt,
    payroll: (emp?.n ?? 0) > 0,
    partners,
    turnover: turn?.v ?? 0,
    settings: await complianceSettings(ctx),
  };
}

const fyOf = (d = new Date(Date.now() + 5.5 * 3_600_000)) => (d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);

/** Creates the year's items that are missing (and drops untouched automatic ones that no longer apply). */
export async function generateYear(ctx: RecordCtx, fyStart = fyOf()) {
  const f = await facts(ctx, fyStart);
  const list = dueList(f);
  let added = 0;
  for (const d of list) {
    const r = await ctx.tx.one(
      `insert into compliance_items (tenant_id, key, period, name, authority, description, due_date, person_id, assignee_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, key, period) do nothing returning id`,
      [ctx.tenantId, d.key, d.period, d.name, d.authority, d.description, d.due, d.personId ?? null, f.settings.defaultAssigneeId ?? null],
    );
    if (r) added++;
  }
  // GST returns already filed through the GST module count as filed here
  await ctx.tx.query(
    `update compliance_items c set status = 'filed', filed_on = g.filed_at::date, reference = coalesce(c.reference, g.arn), updated_at = now()
       from gst_filings g
      where c.tenant_id = $1 and g.tenant_id = c.tenant_id and c.status in ('pending','in_progress') and g.status = 'filed'
        and c.key = lower(replace(g.return_type, 'GSTR', 'gstr')) and c.period = substr(g.period, 3, 4) || '-' || substr(g.period, 1, 2)`,
    [ctx.tenantId],
  );
  return { added, total: list.length, facts: { constitution: f.constitution, gst: f.gst, tds: f.tds, payroll: f.payroll, partners: f.partners.length, turnover: f.turnover } };
}

export async function listItems(ctx: RecordCtx, q: { from?: string | null; to?: string | null }) {
  await assertBooksAdmin(ctx);
  const from = q.from ?? `${fyOf()}-04-01`;
  const to = q.to ?? `${fyOf() + 1}-12-31`;
  return ctx.tx.query(
    `select c.id, c.key, c.period, c.name, c.authority, c.description, to_char(c.due_date, 'YYYY-MM-DD') as due_date, c.status, to_char(c.filed_on, 'YYYY-MM-DD') as filed_on,
            c.reference, c.amount_paid::float8 as amount_paid, c.notes, c.assignee_id, u.full_name as assignee, c.source,
            (select count(*)::int from files f where f.tenant_id = c.tenant_id and f.object_key = 'compliance_item' and f.record_id = c.id and f.deleted_at is null) as files
       from compliance_items c left join users u on u.tenant_id = c.tenant_id and u.id = c.assignee_id
      where c.tenant_id = $1 and c.due_date between $2::date and $3::date order by c.due_date, c.name`,
    [ctx.tenantId, from, to],
  );
}

export const itemUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'filed', 'not_applicable']).optional(),
  filedOn: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).nullish(),
  reference: z.string().trim().max(120).nullish(),
  amountPaid: z.number().min(0).nullish(),
  notes: z.string().trim().max(4000).nullish(),
  assigneeId: z.string().uuid().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function updateItem(ctx: RecordCtx, id: string, u: z.infer<typeof itemUpdateSchema>) {
  await assertBooksAdmin(ctx);
  const cur = await ctx.tx.one<{ id: string }>(`select id from compliance_items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!cur) throw notFound();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length + 2}`);
  };
  if (u.status !== undefined) set('status', u.status);
  if (u.filedOn !== undefined) set('filed_on', u.filedOn || null);
  if (u.status === 'filed' && !u.filedOn) sets.push(`filed_on = coalesce(filed_on, current_date)`);
  if (u.reference !== undefined) set('reference', u.reference || null);
  if (u.amountPaid !== undefined) set('amount_paid', u.amountPaid);
  if (u.notes !== undefined) set('notes', u.notes || null);
  if (u.assigneeId !== undefined) set('assignee_id', u.assigneeId);
  if (u.dueDate !== undefined) set('due_date', u.dueDate);
  if (!sets.length) return { id };
  await ctx.tx.query(`update compliance_items set ${sets.join(', ')}, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, ...vals]);
  return { id };
}

export const customItemSchema = z.object({
  name: z.string().trim().min(2).max(200),
  authority: z.enum(['MCA', 'GST', 'Income tax', 'TDS', 'EPFO', 'ESIC', 'State', 'Other']).default('Other'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().max(2000).nullish(),
  assigneeId: z.string().uuid().nullish(),
});

export async function addItem(ctx: RecordCtx, c: z.infer<typeof customItemSchema>) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into compliance_items (tenant_id, key, period, name, authority, description, due_date, assignee_id, source) values ($1,$2,$3,$4,$5,$6,$7,$8,'manual') returning id`,
    [ctx.tenantId, `custom:${crypto.randomUUID().slice(0, 8)}`, c.dueDate, c.name, c.authority, c.description ?? null, c.dueDate, c.assigneeId ?? null],
  );
  return { id: r!.id };
}

export async function deleteItem(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one<{ source: string }>(`select source from compliance_items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!r) throw notFound();
  if (r.source !== 'manual') throw badRequest('A statutory item cannot be deleted; mark it not applicable');
  await ctx.tx.query(`delete from compliance_items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return { ok: true };
}

/** Daily: next year's items from March, and reminders a week before and the day before. */
export async function complianceDailySweep(env: Env, db: Db, tenantId: string) {
  return db.tx({ tenantId }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    if (!ctx) return { reminded: 0 };
    const any = await tx.one(`select 1 from compliance_items where tenant_id = $1 limit 1`, [tenantId]);
    if (!any) return { reminded: 0 }; // the workspace has not started using the calendar
    const today = new Date(Date.now() + 5.5 * 3_600_000);
    await generateYear(ctx, fyOf(today));
    if (today.getUTCMonth() >= 2 && today.getUTCMonth() <= 3) await generateYear(ctx, fyOf(today) + 1);
    const due = await tx.query<{ id: string; name: string; due: string; assignee_id: string | null; days: number }>(
      `select id, name, to_char(due_date, 'YYYY-MM-DD') as due, assignee_id, (due_date - current_date)::int as days from compliance_items
        where tenant_id = $1 and status in ('pending','in_progress') and (due_date - current_date) in (7, 1, 0) and (reminded_at is null or reminded_at < current_date)`,
      [tenantId],
    );
    let reminded = 0;
    for (const d of due) {
      const to = d.assignee_id
        ? [d.assignee_id]
        : (await tx.query<{ id: string }>(`select u.id from users u where u.tenant_id = $1 and u.status = 'active' and u.is_owner`, [tenantId])).map((u) => u.id);
      for (const u of to)
        await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'compliance',$3,$4,'/books#compliance')`, [
          tenantId, u, `${d.days === 0 ? 'Due today' : `Due in ${d.days} day${d.days === 1 ? '' : 's'}`}: ${d.name}`.slice(0, 200), `Due ${d.due}`,
        ]);
      await tx.query(`update compliance_items set reminded_at = current_date where tenant_id = $1 and id = $2`, [tenantId, d.id]);
      reminded++;
    }
    return { reminded };
  });
}

/**
 * Working papers for the LLP's annual filings, from the books: Form 11 (partners and their
 * contribution at the year end) and Form 8 (statement of assets and liabilities, income and
 * expenditure, and turnover). The CA checks and files them; Synapse prepares the figures.
 */
export async function llpWorking(ctx: RecordCtx, fyStart: number) {
  await assertBooksAdmin(ctx);
  const { balanceSheet, profitAndLoss } = await import('./reports');
  const end = `${fyStart + 1}-03-31`;
  const start = `${fyStart}-04-01`;
  const bs = await balanceSheet(ctx, end);
  const pl = await profitAndLoss(ctx, start, end);
  const partners = await ctx.tx.query<{ id: string; name: string; role: string; din: string | null; pan: string | null; share_pct: number | null; designation: string | null; contribution: number; drawings: number }>(
    `select p.id, p.name, p.role, p.din, p.pan, p.share_pct::float8 as share_pct, p.designation,
            coalesce((select sum(l.credit - l.debit) from journal_lines l where l.tenant_id = p.tenant_id and l.account_id = p.account_in and l.posted and l.entry_date <= $2::date), 0)::float8 as contribution,
            coalesce((select sum(l.debit - l.credit) from journal_lines l where l.tenant_id = p.tenant_id and l.account_id = p.account_out and p.account_out <> p.account_in and l.posted and l.entry_date between $3::date and $2::date), 0)::float8 as drawings
       from acct_persons p where p.tenant_id = $1 and p.is_active order by p.name`,
    [ctx.tenantId, end, start],
  );
  const turnover = await ctx.tx.one<{ v: number }>(
    `select coalesce(sum(case when doc_type = 'credit_note' then -taxable_total else taxable_total end * coalesce(exchange_rate, 1)), 0)::float8 as v from invoices
      where tenant_id = $1 and deleted_at is null and doc_type in ('tax_invoice','credit_note') and status not in ('draft','cancelled') and invoice_date between $2::date and $3::date`,
    [ctx.tenantId, start, end],
  );
  const contribution = partners.reduce((t, p) => t + p.contribution, 0);
  const t = turnover?.v ?? 0;
  return {
    fy: `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`,
    asOf: end,
    form11: {
      partners: partners.map((p) => ({ name: p.name, designated: !!p.din, din: p.din, pan: p.pan, role: p.role, designation: p.designation, sharePct: p.share_pct, contribution: Math.round(p.contribution * 100) / 100 })),
      totalContribution: Math.round(contribution * 100) / 100,
      designatedPartners: partners.filter((p) => p.din).length,
      warnings: [
        ...(partners.filter((p) => p.din).length < 2 ? ['An LLP needs at least two designated partners with a DPIN / DIN'] : []),
        ...(partners.some((p) => p.share_pct == null) ? ['Profit-sharing ratio missing for some partners (Organisation → Partners & directors)'] : []),
      ],
    },
    form8: {
      turnover: t,
      auditRequired: t > 40_00_000 || contribution > 25_00_000,
      balanceSheet: bs,
      incomeAndExpenditure: { income: pl.sections[0]!.total + pl.sections[3]!.total, expenses: pl.sections[1]!.total + pl.sections[2]!.total + pl.sections[4]!.total, netProfit: pl.netProfit, sections: pl.sections },
      partnersDrawings: partners.map((p) => ({ name: p.name, drawings: p.drawings })),
    },
  };
}
