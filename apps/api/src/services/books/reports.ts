/**
 * Financial reports straight from the ledger (posted lines only).
 *
 * Profit and loss accounts (income, expense) reset every financial year: the balance sheet shows
 * this year's profit as "current year earnings" and everything earlier as retained earnings, so
 * no year-end closing entry is needed and the balance sheet always balances.
 */
import { financialYear } from '@synapse/shared';
import type { RecordCtx } from '../records';
import { DEBIT_NORMAL, r2 } from './ledger';

interface Acc {
  id: string;
  code: string | null;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  subtype: string;
  system_key: string | null;
}

export const fyStart = (date: string) => `${financialYear(date).slice(0, 4)}-04-01`;
const prevDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

async function accounts(ctx: RecordCtx): Promise<Acc[]> {
  return ctx.tx.query<Acc>(`select id, code, name, type, subtype, system_key from gl_accounts where tenant_id = $1 order by code nulls last, name`, [ctx.tenantId]);
}

/** Net movement per account (debit − credit) between two dates (inclusive; null = open). */
async function movements(ctx: RecordCtx, from: string | null, to: string | null, projectId?: string | null) {
  const rows = await ctx.tx.query<{ account_id: string; d: string; c: string }>(
    `select account_id, sum(debit) as d, sum(credit) as c from journal_lines
      where tenant_id = $1 and posted and ($2::date is null or entry_date >= $2::date) and ($3::date is null or entry_date <= $3::date) and ($4::uuid is null or project_id = $4)
      group by account_id`,
    [ctx.tenantId, from, to, projectId ?? null],
  );
  return new Map(rows.map((r) => [r.account_id, { d: Number(r.d), c: Number(r.c) }]));
}

/** Natural-sign balance: positive for a debit asset/expense or a credit liability/equity/income. */
const natural = (a: Acc, m: { d: number; c: number } | undefined) => (m ? r2(DEBIT_NORMAL.has(a.type) ? m.d - m.c : m.c - m.d) : 0);

export async function trialBalance(ctx: RecordCtx, asOf: string) {
  const accs = await accounts(ctx);
  const start = fyStart(asOf);
  const bs = await movements(ctx, null, asOf);
  const pl = await movements(ctx, start, asOf);
  const prior = await movements(ctx, null, prevDay(start));
  const rows: { id: string; code: string | null; name: string; type: string; debit: number; credit: number }[] = [];
  let retained = 0;
  for (const a of accs) {
    const isPl = a.type === 'income' || a.type === 'expense';
    const m = isPl ? pl.get(a.id) : bs.get(a.id);
    if (isPl) {
      const p = prior.get(a.id);
      if (p) retained += p.c - p.d;
    }
    if (!m) continue;
    const net = r2(m.d - m.c);
    if (!net) continue;
    rows.push({ id: a.id, code: a.code, name: a.name, type: a.type, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 });
  }
  retained = r2(retained);
  if (retained) rows.push({ id: 'retained', code: null, name: 'Profit of earlier years (retained earnings)', type: 'equity', debit: retained < 0 ? -retained : 0, credit: retained > 0 ? retained : 0 });
  const debit = r2(rows.reduce((s, r) => s + r.debit, 0));
  const credit = r2(rows.reduce((s, r) => s + r.credit, 0));
  return { asOf, rows, totals: { debit, credit, balanced: Math.abs(debit - credit) < 0.01 } };
}

interface Section {
  key: string;
  label: string;
  accounts: { id: string; code: string | null; name: string; amount: number; compare?: number }[];
  total: number;
  compare?: number;
}

function section(key: string, label: string, accs: Acc[], cur: Map<string, { d: number; c: number }>, cmp?: Map<string, { d: number; c: number }>): Section {
  const rows = accs
    .map((a) => ({ id: a.id, code: a.code, name: a.name, amount: natural(a, cur.get(a.id)), ...(cmp ? { compare: natural(a, cmp.get(a.id)) } : {}) }))
    .filter((r) => r.amount || r.compare);
  return { key, label, accounts: rows, total: r2(rows.reduce((s, r) => s + r.amount, 0)), ...(cmp ? { compare: r2(rows.reduce((s, r) => s + (r.compare ?? 0), 0)) } : {}) };
}

export async function profitAndLoss(ctx: RecordCtx, from: string, to: string, opts: { compareFrom?: string; compareTo?: string; projectId?: string | null } = {}) {
  const accs = await accounts(ctx);
  const cur = await movements(ctx, from, to, opts.projectId);
  const cmp = opts.compareFrom && opts.compareTo ? await movements(ctx, opts.compareFrom, opts.compareTo, opts.projectId) : undefined;
  const by = (f: (a: Acc) => boolean) => accs.filter(f);
  const income = section('income', 'Operating income', by((a) => a.type === 'income' && a.subtype === 'income'), cur, cmp);
  const cogs = section('cogs', 'Cost of goods sold', by((a) => a.subtype === 'cost_of_goods_sold'), cur, cmp);
  const expenses = section('expenses', 'Operating expenses', by((a) => a.type === 'expense' && a.subtype === 'expense'), cur, cmp);
  const otherIncome = section('other_income', 'Other income', by((a) => a.subtype === 'other_income'), cur, cmp);
  const otherExpense = section('other_expense', 'Other expenses', by((a) => a.subtype === 'other_expense'), cur, cmp);
  const gross = r2(income.total - cogs.total);
  const operating = r2(gross - expenses.total);
  const net = r2(operating + otherIncome.total - otherExpense.total);
  const c = cmp
    ? {
        gross: r2((income.compare ?? 0) - (cogs.compare ?? 0)),
        operating: r2((income.compare ?? 0) - (cogs.compare ?? 0) - (expenses.compare ?? 0)),
        net: r2((income.compare ?? 0) - (cogs.compare ?? 0) - (expenses.compare ?? 0) + (otherIncome.compare ?? 0) - (otherExpense.compare ?? 0)),
      }
    : undefined;
  return { from, to, sections: [income, cogs, expenses, otherIncome, otherExpense], grossProfit: gross, operatingProfit: operating, netProfit: net, grossMargin: income.total ? r2((gross / income.total) * 100) : null, compare: c };
}

/** Net profit per month for a range (for charts). */
export async function monthlyProfit(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query<{ month: string; income: number; expense: number }>(
    `select to_char(date_trunc('month', l.entry_date), 'YYYY-MM') as month,
            sum(case when a.type = 'income' then l.credit - l.debit else 0 end)::float8 as income,
            sum(case when a.type = 'expense' then l.debit - l.credit else 0 end)::float8 as expense
       from journal_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = $1 and l.posted and l.entry_date between $2::date and $3::date and a.type in ('income','expense')
      group by 1 order by 1`,
    [ctx.tenantId, from, to],
  );
}

const BS_GROUPS: [string, string, (a: Acc) => boolean][] = [
  ['current_assets', 'Current assets', (a) => a.type === 'asset' && ['cash', 'bank', 'accounts_receivable', 'inventory', 'current_asset', 'tax_receivable'].includes(a.subtype)],
  ['fixed_assets', 'Fixed assets', (a) => a.type === 'asset' && ['fixed_asset', 'accumulated_depreciation'].includes(a.subtype)],
  ['other_assets', 'Other assets', (a) => a.type === 'asset' && a.subtype === 'other_asset'],
  ['current_liabilities', 'Current liabilities', (a) => a.type === 'liability' && ['accounts_payable', 'credit_card', 'current_liability', 'tax_payable'].includes(a.subtype)],
  ['long_term_liabilities', 'Long-term liabilities', (a) => a.type === 'liability' && ['long_term_liability', 'other_liability'].includes(a.subtype)],
  ['equity', 'Equity', (a) => a.type === 'equity'],
];

export async function balanceSheet(ctx: RecordCtx, asOf: string) {
  const accs = await accounts(ctx);
  const all = await movements(ctx, null, asOf);
  const start = fyStart(asOf);
  const pl = await movements(ctx, start, asOf);
  const groups = BS_GROUPS.map(([k, label, f]) => section(k, label, accs.filter(f), all));
  let current = 0;
  let earlier = 0;
  for (const a of accs) {
    if (a.type !== 'income' && a.type !== 'expense') continue;
    const tot = all.get(a.id);
    const cy = pl.get(a.id);
    const cyNet = cy ? cy.c - cy.d : 0;
    current += cyNet;
    earlier += (tot ? tot.c - tot.d : 0) - cyNet;
  }
  const eq = groups.find((g) => g.key === 'equity')!;
  eq.accounts.push({ id: 'retained_prior', code: null, name: 'Retained earnings (earlier years)', amount: r2(earlier) }, { id: 'current_year', code: null, name: 'Current year earnings', amount: r2(current) });
  eq.accounts = eq.accounts.filter((a) => a.amount);
  eq.total = r2(eq.accounts.reduce((s, a) => s + a.amount, 0));
  const assets = r2(groups.filter((g) => g.key.endsWith('assets')).reduce((s, g) => s + g.total, 0));
  const liabilities = r2(groups.filter((g) => g.key.endsWith('liabilities')).reduce((s, g) => s + g.total, 0));
  return { asOf, groups, totals: { assets, liabilities, equity: eq.total, liabilitiesAndEquity: r2(liabilities + eq.total), balanced: Math.abs(assets - liabilities - eq.total) < 0.01 } };
}

/** Indirect-method cash flow: profit, non-cash items, working capital, investing, financing. */
export async function cashFlow(ctx: RecordCtx, from: string, to: string) {
  const accs = await accounts(ctx);
  const mv = await movements(ctx, from, to);
  const net = (f: (a: Acc) => boolean) => r2(accs.filter(f).reduce((s, a) => { const m = mv.get(a.id); return s + (m ? m.d - m.c : 0); }, 0));
  const profit = -net((a) => a.type === 'income' || a.type === 'expense');
  const depreciation = net((a) => a.system_key === 'depreciation');
  const lines = (label: string, f: (a: Acc) => boolean) => ({ label, amount: -net(f) });
  const operating = [
    { label: 'Net profit', amount: r2(profit) },
    { label: 'Add: depreciation', amount: depreciation },
    lines('(Increase) / decrease in receivables', (a) => a.subtype === 'accounts_receivable'),
    lines('(Increase) / decrease in inventory', (a) => a.subtype === 'inventory'),
    lines('(Increase) / decrease in other current assets and taxes', (a) => a.type === 'asset' && ['current_asset', 'tax_receivable'].includes(a.subtype)),
    lines('Increase / (decrease) in payables', (a) => a.subtype === 'accounts_payable'),
    lines('Increase / (decrease) in other current liabilities and taxes', (a) => a.type === 'liability' && ['current_liability', 'tax_payable', 'credit_card'].includes(a.subtype)),
  ];
  // depreciation already moved accumulated depreciation; fixed-asset purchases and sales are investing
  const investing = [lines('Purchase / sale of fixed assets', (a) => a.subtype === 'fixed_asset'), lines('Other investments and deposits', (a) => a.subtype === 'other_asset')];
  const financing = [lines('Loans taken / repaid', (a) => a.type === 'liability' && ['long_term_liability', 'other_liability'].includes(a.subtype)), lines('Capital introduced / drawings', (a) => a.type === 'equity')];
  const sum = (xs: { amount: number }[]) => r2(xs.reduce((s, x) => s + x.amount, 0));
  const cashChange = net((a) => ['cash', 'bank'].includes(a.subtype));
  const opening = await movements(ctx, null, prevDay(from));
  const openingCash = r2(accs.filter((a) => ['cash', 'bank'].includes(a.subtype)).reduce((s, a) => { const m = opening.get(a.id); return s + (m ? m.d - m.c : 0); }, 0));
  // asset sale gains are inside profit and inside the investing line: the residual shows up here
  const totalOps = sum(operating);
  const totalInv = sum(investing);
  const totalFin = sum(financing);
  const unexplained = r2(cashChange - totalOps - totalInv - totalFin);
  return {
    from,
    to,
    operating: { lines: operating.filter((l) => l.amount), total: totalOps },
    investing: { lines: investing.filter((l) => l.amount), total: totalInv },
    financing: { lines: financing.filter((l) => l.amount), total: totalFin },
    other: unexplained,
    netChange: cashChange,
    openingCash,
    closingCash: r2(openingCash + cashChange),
  };
}

export async function generalLedger(ctx: RecordCtx, accountId: string, from: string, to: string, opts: { partyId?: string | null } = {}) {
  const acc = await ctx.tx.one<Acc>(`select id, code, name, type, subtype, system_key from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, accountId]);
  if (!acc) return null;
  const isPl = acc.type === 'income' || acc.type === 'expense';
  const openFrom = isPl ? fyStart(from) : null;
  const open = await ctx.tx.one<{ d: number; c: number }>(
    `select coalesce(sum(debit), 0)::float8 as d, coalesce(sum(credit), 0)::float8 as c from journal_lines
      where tenant_id = $1 and account_id = $2 and posted and entry_date < $3::date and ($4::date is null or entry_date >= $4::date) and ($5::uuid is null or party_id = $5)`,
    [ctx.tenantId, accountId, from, openFrom, opts.partyId ?? null],
  );
  const lines = await ctx.tx.query<Record<string, any>>(
    `select l.id, l.entry_date, l.debit::float8 as debit, l.credit::float8 as credit, l.description, l.party_type, l.party_id, j.id as journal_id, j.number, j.source_type, j.source_id, j.reference, j.narration,
            coalesce((select name from accounts where tenant_id = l.tenant_id and id = l.party_id), (select name from vendors where tenant_id = l.tenant_id and id = l.party_id), (select full_name from users where tenant_id = l.tenant_id and id = l.party_id)) as party
       from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      where l.tenant_id = $1 and l.account_id = $2 and l.posted and l.entry_date between $3::date and $4::date and ($5::uuid is null or l.party_id = $5)
      order by l.entry_date, j.created_at, l.id limit 5000`,
    [ctx.tenantId, accountId, from, to, opts.partyId ?? null],
  );
  const sign = DEBIT_NORMAL.has(acc.type) ? 1 : -1;
  let bal = r2((open!.d - open!.c) * sign);
  const opening = bal;
  for (const l of lines) {
    bal = r2(bal + (l.debit - l.credit) * sign);
    l.balance = bal;
  }
  return { account: acc, from, to, opening, closing: bal, debits: r2(lines.reduce((s, l) => s + l.debit, 0)), credits: r2(lines.reduce((s, l) => s + l.credit, 0)), lines };
}

export async function dayBook(ctx: RecordCtx, from: string, to: string, sourceType?: string | null) {
  const js = await ctx.tx.query<Record<string, any>>(
    `select j.id, j.number, j.entry_date, j.source_type, j.source_id, j.reference, j.narration, j.total::float8 as total, j.status, j.currency
       from journals j where j.tenant_id = $1 and j.entry_date between $2::date and $3::date and ($4::text is null or j.source_type = $4)
      order by j.entry_date, j.created_at limit 2000`,
    [ctx.tenantId, from, to, sourceType ?? null],
  );
  const lines = js.length
    ? await ctx.tx.query<Record<string, any>>(
        `select l.journal_id, l.debit::float8 as debit, l.credit::float8 as credit, a.name as account, a.code, l.description from journal_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
          where l.tenant_id = $1 and l.journal_id = any($2::uuid[]) order by l.debit desc`,
        [ctx.tenantId, js.map((j) => j.id)],
      )
    : [];
  for (const j of js) j.lines = lines.filter((l) => l.journal_id === j.id);
  return { from, to, journals: js };
}

/** A customer's or vendor's statement from the ledger: opening balance, documents, running balance. */
export async function partyStatement(ctx: RecordCtx, party: 'customer' | 'vendor', partyId: string, from: string, to: string) {
  const key = party === 'customer' ? 'ar' : 'ap';
  const acc = await ctx.tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and system_key = $2`, [ctx.tenantId, key]);
  if (!acc) return null;
  const gl = await generalLedger(ctx, acc.id, from, to, { partyId });
  const name = await ctx.tx.one<{ name: string }>(`select name from ${party === 'customer' ? 'accounts' : 'vendors'} where tenant_id = $1 and id = $2`, [ctx.tenantId, partyId]);
  return { party, partyId, name: name?.name ?? '', from, to, opening: gl!.opening, closing: gl!.closing, lines: gl!.lines };
}

export async function salesByCustomer(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query(
    `select i.account_id, a.name as customer, count(*) filter (where i.doc_type = 'tax_invoice')::int as invoices,
            sum(case when i.doc_type = 'credit_note' then -i.taxable_total else i.taxable_total end)::float8 as sales,
            sum(case when i.doc_type = 'credit_note' then -i.tax_total else i.tax_total end)::float8 as tax,
            sum(case when i.doc_type = 'credit_note' then -i.grand_total else i.grand_total end)::float8 as total
       from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
      where i.tenant_id = $1 and i.doc_type in ('tax_invoice','credit_note') and i.status not in ('draft','cancelled') and i.deleted_at is null and i.invoice_date between $2::date and $3::date
      group by i.account_id, a.name order by sales desc nulls last limit 1000`,
    [ctx.tenantId, from, to],
  );
}

export async function salesByItem(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query(
    `select coalesce(l.product_id::text, l.name) as key, max(l.name) as item, max(l.hsn_sac) as hsn,
            sum(case when i.doc_type = 'credit_note' then -l.quantity else l.quantity end)::float8 as quantity,
            sum(case when i.doc_type = 'credit_note' then -l.line_subtotal else l.line_subtotal end)::float8 as amount,
            sum(case when i.doc_type = 'credit_note' then -l.quantity * coalesce(p.avg_cost, 0) else l.quantity * coalesce(p.avg_cost, 0) end)::float8 as cost
       from invoice_lines l join invoices i on i.tenant_id = l.tenant_id and i.id = l.order_id left join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where l.tenant_id = $1 and i.doc_type in ('tax_invoice','credit_note') and i.status not in ('draft','cancelled') and i.deleted_at is null and i.invoice_date between $2::date and $3::date
      group by 1 order by amount desc limit 1000`,
    [ctx.tenantId, from, to],
  );
}

export async function purchasesByVendor(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query(
    `select b.vendor_id, v.name as vendor, count(*) filter (where b.doc_type = 'bill')::int as bills,
            sum(case when b.doc_type = 'vendor_credit' then -b.taxable_total else b.taxable_total end)::float8 as purchases,
            sum(case when b.doc_type = 'vendor_credit' then -b.tax_total else b.tax_total end)::float8 as tax,
            sum(case when b.doc_type = 'vendor_credit' then -b.grand_total else b.grand_total end)::float8 as total
       from bills b join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.status not in ('draft','void') and b.deleted_at is null and b.bill_date between $2::date and $3::date
      group by b.vendor_id, v.name order by purchases desc limit 1000`,
    [ctx.tenantId, from, to],
  );
}

export async function purchasesByItem(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query(
    `select coalesce(l.product_id::text, l.name) as key, max(l.name) as item, max(l.hsn_sac) as hsn,
            sum(case when b.doc_type = 'vendor_credit' then -l.quantity else l.quantity end)::float8 as quantity,
            sum(case when b.doc_type = 'vendor_credit' then -l.line_subtotal else l.line_subtotal end)::float8 as amount
       from bill_lines l join bills b on b.tenant_id = l.tenant_id and b.id = l.order_id
      where l.tenant_id = $1 and b.status not in ('draft','void') and b.deleted_at is null and b.bill_date between $2::date and $3::date
      group by 1 order by amount desc limit 1000`,
    [ctx.tenantId, from, to],
  );
}

export async function expensesByCategory(ctx: RecordCtx, from: string, to: string) {
  return ctx.tx.query(
    `select a.id, a.code, a.name, a.subtype, sum(l.debit - l.credit)::float8 as amount
       from journal_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
      where l.tenant_id = $1 and l.posted and a.type = 'expense' and l.entry_date between $2::date and $3::date
      group by a.id, a.code, a.name, a.subtype having sum(l.debit - l.credit) <> 0 order by amount desc`,
    [ctx.tenantId, from, to],
  );
}

type Gst = { igst: number; cgst: number; sgst: number };
/**
 * Section 49 / Rule 88A set-off: IGST credit first (IGST, then CGST and SGST — aimed where their own
 * credit falls short), then CGST credit (CGST, then IGST) and SGST credit (SGST, then IGST). CGST and
 * SGST credit never cross. Returns what is left to pay in cash and the credit carried forward.
 */
export function gstSetOff(liability: Gst, itc: Gst) {
  const due = { ...liability };
  const cr = { ...itc };
  const use = (from: keyof Gst, to: keyof Gst, cap = Infinity) => {
    const x = r2(Math.max(0, Math.min(cr[from], due[to], cap)));
    cr[from] = r2(cr[from] - x);
    due[to] = r2(due[to] - x);
  };
  use('igst', 'igst');
  use('igst', 'cgst', due.cgst - cr.cgst);
  use('igst', 'sgst', due.sgst - cr.sgst);
  use('igst', 'cgst');
  use('igst', 'sgst');
  use('cgst', 'cgst');
  use('cgst', 'igst');
  use('sgst', 'sgst');
  use('sgst', 'igst');
  return { due, credit: cr };
}

/** GSTR-3B summary for a month (YYYY-MM) from issued invoices, posted bills and expenses. */
export async function gstr3b(ctx: RecordCtx, month: string) {
  const from = `${month}-01`;
  const to = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const out = await ctx.tx.one<{ taxable: number; igst: number; cgst: number; sgst: number; zero_rated: number; zero_rated_igst: number; nil_exempt: number }>(
    `select coalesce(sum(case when supply_type <> 'export' and tax_total > 0 then s * taxable_total * exchange_rate end), 0)::float8 as taxable,
            coalesce(sum(case when supply_type <> 'export' then s * igst_total * exchange_rate end), 0)::float8 as igst,
            coalesce(sum(case when supply_type <> 'export' then s * cgst_total * exchange_rate end), 0)::float8 as cgst,
            coalesce(sum(case when supply_type <> 'export' then s * sgst_total * exchange_rate end), 0)::float8 as sgst,
            coalesce(sum(case when supply_type = 'export' then s * taxable_total * exchange_rate end), 0)::float8 as zero_rated,
            coalesce(sum(case when supply_type = 'export' then s * igst_total * exchange_rate end), 0)::float8 as zero_rated_igst,
            coalesce(sum(case when supply_type <> 'export' and tax_total = 0 then s * taxable_total * exchange_rate end), 0)::float8 as nil_exempt
       from (select *, case when doc_type = 'credit_note' then -1 else 1 end as s from invoices
              where tenant_id = $1 and doc_type in ('tax_invoice','credit_note') and status not in ('draft','cancelled') and deleted_at is null and invoice_date between $2::date and $3::date) x`,
    [ctx.tenantId, from, to],
  );
  const rcm = await ctx.tx.one<{ taxable: number; igst: number; cgst: number; sgst: number }>(
    `select coalesce(sum(s * taxable_total * exchange_rate), 0)::float8 as taxable, coalesce(sum(s * igst_total * exchange_rate), 0)::float8 as igst, coalesce(sum(s * cgst_total * exchange_rate), 0)::float8 as cgst, coalesce(sum(s * sgst_total * exchange_rate), 0)::float8 as sgst
       from (select *, case when doc_type = 'vendor_credit' then -1 else 1 end as s from bills where tenant_id = $1 and reverse_charge and status not in ('draft','void') and deleted_at is null and bill_date between $2::date and $3::date) x`,
    [ctx.tenantId, from, to],
  );
  const itc = await ctx.tx.one<{ igst: number; cgst: number; sgst: number }>(
    `select coalesce(sum(s * igst_total * exchange_rate), 0)::float8 as igst, coalesce(sum(s * cgst_total * exchange_rate), 0)::float8 as cgst, coalesce(sum(s * sgst_total * exchange_rate), 0)::float8 as sgst
       from (select *, case when doc_type = 'vendor_credit' then -1 else 1 end as s from bills where tenant_id = $1 and not reverse_charge and itc_eligible and status not in ('draft','void') and deleted_at is null and bill_date between $2::date and $3::date) x`,
    [ctx.tenantId, from, to],
  );
  const exp = await ctx.tx.one<{ igst: number; cgst: number; sgst: number }>(
    `select coalesce(sum(case when supply_type = 'inter' then tax_amount * exchange_rate end), 0)::float8 as igst, coalesce(sum(case when supply_type = 'intra' then round(tax_amount * exchange_rate / 2, 2) end), 0)::float8 as cgst,
            coalesce(sum(case when supply_type = 'intra' then tax_amount * exchange_rate - round(tax_amount * exchange_rate / 2, 2) end), 0)::float8 as sgst
       from expenses where tenant_id = $1 and itc_eligible and status in ('approved','recorded','reimbursed') and deleted_at is null and expense_date between $2::date and $3::date`,
    [ctx.tenantId, from, to],
  );
  const itcTotal = { igst: r2(itc!.igst + exp!.igst + rcm!.igst), cgst: r2(itc!.cgst + exp!.cgst + rcm!.cgst), sgst: r2(itc!.sgst + exp!.sgst + rcm!.sgst) };
  // reverse-charge tax is paid in cash (Section 49(4)); only forward-charge tax is set off against credit
  const reverseChargeCash = { igst: r2(rcm!.igst), cgst: r2(rcm!.cgst), sgst: r2(rcm!.sgst) };
  const forward = { igst: r2(out!.igst + out!.zero_rated_igst), cgst: r2(out!.cgst), sgst: r2(out!.sgst) };
  const liability = { igst: r2(forward.igst + reverseChargeCash.igst), cgst: r2(forward.cgst + reverseChargeCash.cgst), sgst: r2(forward.sgst + reverseChargeCash.sgst) };
  const { due, credit: cr } = gstSetOff(forward, itcTotal);
  const pay = { igst: r2(due.igst + reverseChargeCash.igst), cgst: r2(due.cgst + reverseChargeCash.cgst), sgst: r2(due.sgst + reverseChargeCash.sgst) };
  return {
    month,
    outward: { taxable: out!.taxable, igst: out!.igst, cgst: out!.cgst, sgst: out!.sgst },
    zeroRated: { taxable: out!.zero_rated, igst: out!.zero_rated_igst },
    nilExempt: out!.nil_exempt,
    inwardReverseCharge: rcm,
    itc: { fromBills: itc, fromExpenses: exp, reverseCharge: { igst: rcm!.igst, cgst: rcm!.cgst, sgst: rcm!.sgst }, total: itcTotal },
    liability,
    reverseChargeCash,
    payableInCash: pay,
    creditCarriedForward: cr,
  };
}

/** TDS deducted on vendor bills (payable, by section) and by customers on receipts (receivable). */
export async function tdsReport(ctx: RecordCtx, from: string, to: string) {
  const payable = await ctx.tx.query(
    `select b.tds_section as section, v.name as vendor, v.pan, b.bill_number, b.vendor_ref, b.bill_date, b.taxable_total::float8 as taxable, b.tds_rate::float8 as rate, b.tds_amount::float8 as tds,
            to_char((date_trunc('month', b.bill_date) + interval '1 month' + interval '6 days')::date, 'YYYY-MM-DD') as deposit_due
       from bills b join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.tds_amount > 0 and b.status not in ('draft','void') and b.deleted_at is null and b.bill_date between $2::date and $3::date order by b.tds_section, b.bill_date`,
    [ctx.tenantId, from, to],
  );
  const receivable = await ctx.tx.query(
    `select a.name as customer, a.gstin, p.payment_number, p.payment_date, p.amount::float8 as amount, p.tds_amount::float8 as tds, p.gst_tds_amount::float8 as gst_tds,
            p.ld_amount::float8 as ld, p.retention_amount::float8 as retention
       from payments p left join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where p.tenant_id = $1 and (p.tds_amount > 0 or p.gst_tds_amount > 0 or p.ld_amount > 0 or p.retention_amount > 0) and p.status = 'received' and p.deleted_at is null and p.payment_date between $2::date and $3::date order by p.payment_date`,
    [ctx.tenantId, from, to],
  );
  const bySection = new Map<string, number>();
  for (const r of payable as { section: string; tds: number }[]) bySection.set(r.section ?? '—', r2((bySection.get(r.section ?? '—') ?? 0) + r.tds));
  return { from, to, payable, receivable, bySection: [...bySection].map(([section, tds]) => ({ section, tds })) };
}

export async function budgetVsActual(ctx: RecordCtx, budgetId: string) {
  const b = await ctx.tx.one<{ id: string; name: string; financial_year: string; project_id: string | null }>(`select id, name, financial_year, project_id from budgets where tenant_id = $1 and id = $2`, [ctx.tenantId, budgetId]);
  if (!b) return null;
  const y = Number(b.financial_year.slice(0, 4));
  const from = `${y}-04-01`;
  const to = `${y + 1}-03-31`;
  const lines = await ctx.tx.query<{ account_id: string; name: string; type: Acc['type']; months: string[] }>(
    `select l.account_id, a.name, a.type, l.months from budget_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id where l.tenant_id = $1 and l.budget_id = $2 order by a.code nulls last, a.name`,
    [ctx.tenantId, budgetId],
  );
  const actual = await ctx.tx.query<{ account_id: string; m: number; v: number }>(
    `select account_id, ((extract(month from entry_date)::int + 8) % 12) as m, sum(debit - credit)::float8 as v from journal_lines
      where tenant_id = $1 and posted and entry_date between $2::date and $3::date and account_id = any($4::uuid[]) and ($5::uuid is null or project_id = $5)
      group by 1, 2`,
    [ctx.tenantId, from, to, lines.map((l) => l.account_id), b.project_id],
  );
  return {
    budget: b,
    rows: lines.map((l) => {
      const sign = DEBIT_NORMAL.has(l.type) ? 1 : -1;
      const act = Array.from({ length: 12 }, (_, m) => r2((actual.find((a) => a.account_id === l.account_id && a.m === m)?.v ?? 0) * sign));
      const bud = l.months.map(Number);
      return { accountId: l.account_id, name: l.name, type: l.type, budget: bud, actual: act, budgetTotal: r2(bud.reduce((s, x) => s + x, 0)), actualTotal: r2(act.reduce((s, x) => s + x, 0)) };
    }),
  };
}

/** Headline numbers for the Books home page. */
export async function booksOverview(ctx: RecordCtx, today = new Date().toISOString().slice(0, 10)) {
  const monthStart = `${today.slice(0, 7)}-01`;
  const pl = await profitAndLoss(ctx, monthStart, today);
  const fy = await profitAndLoss(ctx, fyStart(today), today);
  const cash = await ctx.tx.one<{ v: number }>(
    `select coalesce(sum(l.debit - l.credit), 0)::float8 as v from journal_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id where l.tenant_id = $1 and l.posted and a.subtype in ('cash','bank')`,
    [ctx.tenantId],
  );
  const ar = await ctx.tx.one<{ v: number; overdue: number }>(
    `select coalesce(sum(balance_due), 0)::float8 as v, coalesce(sum(balance_due) filter (where due_date < current_date), 0)::float8 as overdue from invoices where tenant_id = $1 and doc_type = 'tax_invoice' and status in ('issued','partially_paid') and deleted_at is null`,
    [ctx.tenantId],
  );
  const ap = await ctx.tx.one<{ v: number; due_week: number }>(
    `select coalesce(sum(balance_due), 0)::float8 as v, coalesce(sum(balance_due) filter (where due_date <= current_date + 7), 0)::float8 as due_week from bills where tenant_id = $1 and doc_type = 'bill' and status in ('open','partially_paid') and deleted_at is null`,
    [ctx.tenantId],
  );
  const pending = await ctx.tx.one<{ claims: number; unmatched: number; drafts: number }>(
    `select (select count(*)::int from expenses where tenant_id = $1 and status = 'submitted' and deleted_at is null) as claims,
            (select count(*)::int from bank_transactions where tenant_id = $1 and status = 'unmatched') as unmatched,
            (select count(*)::int from bills where tenant_id = $1 and status = 'draft' and deleted_at is null) as drafts`,
    [ctx.tenantId],
  );
  const trend = await monthlyProfit(ctx, new Date(Date.parse(`${monthStart}T00:00:00Z`) - 330 * 86_400_000).toISOString().slice(0, 7) + '-01', today);
  return { today, month: { income: pl.sections[0]!.total + pl.sections[3]!.total, net: pl.netProfit }, year: { income: fy.sections[0]!.total, net: fy.netProfit, grossMargin: fy.grossMargin }, cash: cash?.v ?? 0, receivables: ar, payables: ap, pending, trend };
}
