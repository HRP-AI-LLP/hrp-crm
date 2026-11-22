/**
 * The general ledger: chart of accounts, journal posting and the books configuration.
 *
 * Rules the database also enforces (0029_books.sql): every journal balances, posted journals are
 * never edited (they are voided and re-posted), and nothing posts on or before the lock date.
 * Documents (invoices, payments, bills, expenses…) post through `repost`, which voids the
 * document's current journal and writes a fresh one, so a document always has exactly one
 * live journal that matches it.
 */
import type { Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  key?: string;
}

/** An Indian SMB chart of accounts (Schedule III friendly). System keys drive auto-posting. */
export const DEFAULT_CHART: SeedAccount[] = [
  // assets
  { code: '1000', name: 'Cash in hand', type: 'asset', subtype: 'cash', key: 'cash' },
  { code: '1010', name: 'Petty cash', type: 'asset', subtype: 'cash', key: 'petty_cash' },
  { code: '1020', name: 'Bank', type: 'asset', subtype: 'bank', key: 'bank' },
  { code: '1030', name: 'UPI / payment gateway clearing', type: 'asset', subtype: 'bank', key: 'gateway_clearing' },
  { code: '1100', name: 'Accounts receivable (debtors)', type: 'asset', subtype: 'accounts_receivable', key: 'ar' },
  { code: '1150', name: 'Advances to vendors', type: 'asset', subtype: 'current_asset', key: 'vendor_advances' },
  { code: '1200', name: 'Inventory', type: 'asset', subtype: 'inventory', key: 'inventory' },
  { code: '1210', name: 'Work in progress', type: 'asset', subtype: 'inventory', key: 'wip' },
  { code: '1220', name: 'Material with job workers', type: 'asset', subtype: 'inventory', key: 'job_work_stock' },
  { code: '1300', name: 'Input CGST', type: 'asset', subtype: 'tax_receivable', key: 'input_cgst' },
  { code: '1301', name: 'Input SGST', type: 'asset', subtype: 'tax_receivable', key: 'input_sgst' },
  { code: '1302', name: 'Input IGST', type: 'asset', subtype: 'tax_receivable', key: 'input_igst' },
  { code: '1310', name: 'TDS receivable', type: 'asset', subtype: 'tax_receivable', key: 'tds_receivable' },
  { code: '1311', name: 'GST TDS receivable (section 51)', type: 'asset', subtype: 'tax_receivable', key: 'gst_tds_receivable' },
  { code: '1320', name: 'Advance tax', type: 'asset', subtype: 'tax_receivable', key: 'advance_tax' },
  { code: '1400', name: 'Prepaid expenses', type: 'asset', subtype: 'current_asset', key: 'prepaid' },
  { code: '1410', name: 'Security deposits', type: 'asset', subtype: 'other_asset', key: 'deposits' },
  { code: '1420', name: 'EMD and performance security with customers', type: 'asset', subtype: 'current_asset', key: 'emd_deposits' },
  { code: '1430', name: 'Retention money with customers', type: 'asset', subtype: 'current_asset', key: 'retention_receivable' },
  { code: '1440', name: 'Margin money against bank guarantees', type: 'asset', subtype: 'current_asset', key: 'bg_margin' },
  { code: '1450', name: 'Fixed deposits', type: 'asset', subtype: 'current_asset', key: 'fixed_deposits' },
  { code: '1500', name: 'Furniture and fixtures', type: 'asset', subtype: 'fixed_asset', key: 'fa_furniture' },
  { code: '1510', name: 'Plant and machinery', type: 'asset', subtype: 'fixed_asset', key: 'fa_machinery' },
  { code: '1520', name: 'Computers', type: 'asset', subtype: 'fixed_asset', key: 'fa_computers' },
  { code: '1530', name: 'Vehicles', type: 'asset', subtype: 'fixed_asset', key: 'fa_vehicles' },
  { code: '1540', name: 'Office equipment', type: 'asset', subtype: 'fixed_asset', key: 'fa_office' },
  { code: '1590', name: 'Accumulated depreciation', type: 'asset', subtype: 'accumulated_depreciation', key: 'accumulated_depreciation' },
  // liabilities
  { code: '2000', name: 'Accounts payable (creditors)', type: 'liability', subtype: 'accounts_payable', key: 'ap' },
  { code: '2050', name: 'Customer advances', type: 'liability', subtype: 'current_liability', key: 'customer_advances' },
  { code: '2100', name: 'Output CGST', type: 'liability', subtype: 'tax_payable', key: 'output_cgst' },
  { code: '2101', name: 'Output SGST', type: 'liability', subtype: 'tax_payable', key: 'output_sgst' },
  { code: '2102', name: 'Output IGST', type: 'liability', subtype: 'tax_payable', key: 'output_igst' },
  { code: '2110', name: 'GST payable on reverse charge', type: 'liability', subtype: 'tax_payable', key: 'rcm_payable' },
  { code: '2120', name: 'TDS payable', type: 'liability', subtype: 'tax_payable', key: 'tds_payable' },
  { code: '2130', name: 'PF payable', type: 'liability', subtype: 'current_liability', key: 'pf_payable' },
  { code: '2131', name: 'ESI payable', type: 'liability', subtype: 'current_liability', key: 'esi_payable' },
  { code: '2132', name: 'Professional tax payable', type: 'liability', subtype: 'tax_payable', key: 'pt_payable' },
  { code: '2200', name: 'Employee reimbursements', type: 'liability', subtype: 'current_liability', key: 'employee_payable' },
  { code: '2210', name: 'Salaries payable', type: 'liability', subtype: 'current_liability', key: 'salaries_payable' },
  { code: '2300', name: 'Credit card', type: 'liability', subtype: 'credit_card', key: 'credit_card' },
  { code: '2400', name: 'Loans', type: 'liability', subtype: 'long_term_liability', key: 'loans' },
  // equity
  { code: '3000', name: "Owner's capital", type: 'equity', subtype: 'equity', key: 'capital' },
  { code: '3100', name: 'Drawings', type: 'equity', subtype: 'equity', key: 'drawings' },
  { code: '3200', name: 'Retained earnings', type: 'equity', subtype: 'retained_earnings', key: 'retained_earnings' },
  { code: '3900', name: 'Opening balance adjustments', type: 'equity', subtype: 'equity', key: 'opening_equity' },
  // income
  { code: '4000', name: 'Sales', type: 'income', subtype: 'income', key: 'sales' },
  { code: '4010', name: 'Service income', type: 'income', subtype: 'income', key: 'service_income' },
  { code: '4100', name: 'Discount received', type: 'income', subtype: 'other_income', key: 'discount_received' },
  { code: '4200', name: 'Interest income', type: 'income', subtype: 'other_income', key: 'interest_income' },
  { code: '4300', name: 'Exchange gain or loss', type: 'income', subtype: 'other_income', key: 'fx_gain_loss' },
  { code: '4400', name: 'Other income', type: 'income', subtype: 'other_income', key: 'other_income' },
  { code: '4500', name: 'Gain or loss on sale of assets', type: 'income', subtype: 'other_income', key: 'asset_gain_loss' },
  // expenses
  { code: '5000', name: 'Cost of goods sold', type: 'expense', subtype: 'cost_of_goods_sold', key: 'cogs' },
  { code: '5010', name: 'Purchases', type: 'expense', subtype: 'cost_of_goods_sold', key: 'purchases' },
  { code: '5020', name: 'Job work charges', type: 'expense', subtype: 'cost_of_goods_sold', key: 'job_work_charges' },
  { code: '5030', name: 'Freight inward', type: 'expense', subtype: 'cost_of_goods_sold', key: 'freight_in' },
  { code: '5040', name: 'Manufacturing overheads absorbed', type: 'expense', subtype: 'cost_of_goods_sold', key: 'overhead_absorbed' },
  { code: '5050', name: 'Scrap and production losses', type: 'expense', subtype: 'cost_of_goods_sold', key: 'scrap' },
  { code: '5060', name: 'Inventory adjustments', type: 'expense', subtype: 'cost_of_goods_sold', key: 'inventory_adjust' },
  { code: '6000', name: 'Salaries and wages', type: 'expense', subtype: 'expense', key: 'salaries' },
  { code: '6005', name: "Employer's PF and ESI contribution", type: 'expense', subtype: 'expense', key: 'employer_contributions' },
  { code: '6010', name: 'Rent', type: 'expense', subtype: 'expense', key: 'rent' },
  { code: '6020', name: 'Electricity and utilities', type: 'expense', subtype: 'expense', key: 'utilities' },
  { code: '6030', name: 'Telephone and internet', type: 'expense', subtype: 'expense', key: 'telephone' },
  { code: '6040', name: 'Travel and conveyance', type: 'expense', subtype: 'expense', key: 'travel' },
  { code: '6050', name: 'Fuel and mileage', type: 'expense', subtype: 'expense', key: 'fuel' },
  { code: '6060', name: 'Office expenses', type: 'expense', subtype: 'expense', key: 'office' },
  { code: '6070', name: 'Printing and stationery', type: 'expense', subtype: 'expense', key: 'stationery' },
  { code: '6080', name: 'Professional fees', type: 'expense', subtype: 'expense', key: 'professional_fees' },
  { code: '6090', name: 'Advertising and marketing', type: 'expense', subtype: 'expense', key: 'marketing' },
  { code: '6100', name: 'Repairs and maintenance', type: 'expense', subtype: 'expense', key: 'repairs' },
  { code: '6110', name: 'Freight outward and delivery', type: 'expense', subtype: 'expense', key: 'freight_out' },
  { code: '6120', name: 'Installation and site expenses', type: 'expense', subtype: 'expense', key: 'site_expenses' },
  { code: '6130', name: 'Software and subscriptions', type: 'expense', subtype: 'expense', key: 'software' },
  { code: '6140', name: 'Insurance', type: 'expense', subtype: 'expense', key: 'insurance' },
  { code: '6150', name: 'Staff welfare', type: 'expense', subtype: 'expense', key: 'staff_welfare' },
  { code: '6160', name: 'Meals and entertainment', type: 'expense', subtype: 'expense', key: 'meals' },
  { code: '6200', name: 'Bank charges', type: 'expense', subtype: 'expense', key: 'bank_charges' },
  { code: '6210', name: 'Interest expense', type: 'expense', subtype: 'other_expense', key: 'interest_expense' },
  { code: '6300', name: 'Depreciation', type: 'expense', subtype: 'expense', key: 'depreciation' },
  { code: '6400', name: 'Bad debts', type: 'expense', subtype: 'other_expense', key: 'bad_debts' },
  { code: '6410', name: 'GST not claimable', type: 'expense', subtype: 'expense', key: 'gst_expense' },
  { code: '6420', name: 'Liquidated damages and penalties', type: 'expense', subtype: 'other_expense', key: 'liquidated_damages' },
  { code: '6500', name: 'Round off', type: 'expense', subtype: 'other_expense', key: 'round_off' },
  { code: '6900', name: 'Uncategorised expense', type: 'expense', subtype: 'expense', key: 'uncategorised' },
];

export const DEBIT_NORMAL = new Set<AccountType>(['asset', 'expense']);

export interface BooksConfig {
  enabled: boolean;
  books_of_record: 'synapse' | 'tally';
  start_date: string;
  lock_date: string | null;
  base_currency: string;
  tds_enabled: boolean;
  tan: string | null;
  pan: string | null;
  inventory_on: 'bill' | 'none';
}

export async function booksConfig(tx: Tx, tenantId: string): Promise<BooksConfig | null> {
  const r = await tx.one<Record<string, any>>(`select enabled, books_of_record, start_date::text, lock_date::text, base_currency, tds_enabled, tan, pan, inventory_on from books_config where tenant_id = $1`, [tenantId]);
  return (r as BooksConfig | null) ?? null;
}

/** Books are switched on and SanchalanOS (not Tally) is the books of record: documents post journals. */
export async function postingOn(tx: Tx, tenantId: string): Promise<BooksConfig | null> {
  const c = await booksConfig(tx, tenantId);
  return c?.enabled && c.books_of_record === 'synapse' ? c : null;
}

/** Creates the configuration row and the default chart (idempotent). */
export async function ensureBooks(tx: Tx, tenantId: string) {
  await tx.query(`insert into books_config (tenant_id) values ($1) on conflict do nothing`, [tenantId]);
  const have = await tx.one<{ n: number }>(`select count(*)::int as n from gl_accounts where tenant_id = $1`, [tenantId]);
  if (have?.n) {
    // later versions add system accounts: create any that are missing
    for (const a of DEFAULT_CHART) {
      if (a.key && (await tx.one(`select 1 from gl_accounts where tenant_id = $1 and system_key = $2`, [tenantId, a.key]))) continue;
      // an account of the same name and type that the workspace made itself becomes the system account
      if (a.key) {
        const same = await tx.one<{ id: string }>(
          `update gl_accounts set system_key = $4 where id = (select id from gl_accounts where tenant_id = $1 and lower(name) = lower($2) and type = $3 and system_key is null limit 1) returning id`,
          [tenantId, a.name, a.type, a.key],
        );
        if (same) continue;
      } else if (await tx.one(`select 1 from gl_accounts where tenant_id = $1 and lower(name) = lower($2)`, [tenantId, a.name])) continue;
      // the code may be taken by the workspace's own account: use the next free one
      let code = Number(a.code);
      while (await tx.one(`select 1 from gl_accounts where tenant_id = $1 and code = $2`, [tenantId, String(code)])) code++;
      const taken = await tx.one(`select 1 from gl_accounts where tenant_id = $1 and lower(name) = lower($2)`, [tenantId, a.name]);
      await tx.query(`insert into gl_accounts (tenant_id, code, name, type, subtype, system_key) values ($1,$2,$3,$4,$5,$6)`, [tenantId, String(code), taken ? `${a.name} (system)` : a.name, a.type, a.subtype, a.key ?? null]);
    }
    return;
  }
  for (const a of DEFAULT_CHART) await tx.query(`insert into gl_accounts (tenant_id, code, name, type, subtype, system_key) values ($1,$2,$3,$4,$5,$6)`, [tenantId, a.code, a.name, a.type, a.subtype, a.key ?? null]);
}

/** The id of a system account (ar, ap, output_cgst, …). */
export async function sys(tx: Tx, tenantId: string, key: string): Promise<string> {
  const r = await tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and system_key = $2`, [tenantId, key]);
  if (r) return r.id;
  await ensureBooks(tx, tenantId);
  const again = await tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and system_key = $2`, [tenantId, key]);
  if (!again) throw badRequest(`The books have no "${key}" account`);
  return again.id;
}

export interface JLine {
  accountId: string;
  debit?: number;
  credit?: number;
  partyType?: 'customer' | 'vendor' | 'employee' | null;
  partyId?: string | null;
  projectId?: string | null;
  description?: string | null;
  taxKind?: 'cgst' | 'sgst' | 'igst' | 'cess' | 'tds' | null;
  fcAmount?: number | null;
}

export interface JournalInput {
  date: string;
  sourceType: string;
  sourceId?: string | null;
  reference?: string | null;
  narration?: string | null;
  currency?: string;
  exchangeRate?: number;
  lines: JLine[];
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Posts a journal. Lines with zero amounts are dropped, same-account same-side lines are kept
 * separate (they may carry different parties). Rounding differences of a paisa or two from
 * currency conversion go to round-off so the journal always balances.
 */
export async function postJournal(tx: Tx, tenantId: string, j: JournalInput): Promise<string | null> {
  const lines = j.lines
    // a negative debit is a credit (and the other way round); a line with both sides keeps the net
    .map((l) => {
      const net = r2((l.debit ?? 0) - (l.credit ?? 0));
      if (!Number.isFinite(net)) throw badRequest('Invalid amount on the entry');
      return { ...l, debit: net > 0 ? net : 0, credit: net < 0 ? -net : 0 };
    })
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (!lines.length) return null;
  const d = r2(lines.reduce((a, l) => a + l.debit, 0));
  const c = r2(lines.reduce((a, l) => a + l.credit, 0));
  const diff = r2(d - c);
  if (Math.abs(diff) > 0.05 * Math.max(1, lines.length)) throw badRequest(`The entry does not balance: debits ${d.toFixed(2)}, credits ${c.toFixed(2)}`);
  if (diff !== 0) {
    const ro = await sys(tx, tenantId, 'round_off');
    lines.push(diff > 0 ? { accountId: ro, credit: diff, debit: 0 } : { accountId: ro, debit: -diff, credit: 0 });
  }
  const accounts = await tx.query<{ id: string; is_active: boolean }>(`select id, is_active from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [tenantId, [...new Set(lines.map((l) => l.accountId))]]);
  if (accounts.length !== new Set(lines.map((l) => l.accountId)).size) throw badRequest('An account on this entry does not exist');
  // every entry gets the next voucher number of its financial year (JV/26-27/0001), whatever posted it
  const number = await nextJournalNumber(tx, j.date);
  const jr = await tx.one<{ id: string }>(
    `insert into journals (tenant_id, number, entry_date, source_type, source_id, reference, narration, currency, exchange_rate, total) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [tenantId, number, j.date, j.sourceType, j.sourceId ?? null, j.reference ?? null, j.narration ?? null, j.currency ?? 'INR', j.exchangeRate ?? 1, r2(Math.max(d, c))],
  );
  for (const l of lines) {
    await tx.query(
      `insert into journal_lines (tenant_id, journal_id, account_id, debit, credit, party_type, party_id, project_id, description, tax_kind, fc_amount, entry_date) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [tenantId, jr!.id, l.accountId, l.debit, l.credit, l.partyType ?? null, l.partyId ?? null, l.projectId ?? null, l.description?.slice(0, 500) ?? null, l.taxKind ?? null, l.fcAmount ?? null, j.date],
    );
  }
  return jr!.id;
}

async function nextJournalNumber(tx: Tx, date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  const fy = `${String(y).slice(2)}-${String((y + 1) % 100).padStart(2, '0')}`;
  const n = await tx.one<{ n: string }>(`select app.next_counter($1) as n`, [`journal:${fy}`]);
  return `JV/${fy}/${String(n!.n).padStart(4, '0')}`;
}

/** Voids the live journal(s) of a document. */
export async function voidSource(tx: Tx, tenantId: string, sourceType: string, sourceId: string, reason: string) {
  await tx.query(`update journals set status = 'void', void_reason = $4, voided_at = now() where tenant_id = $1 and source_type = $2 and source_id = $3 and status = 'posted'`, [tenantId, sourceType, sourceId, reason.slice(0, 300)]);
}

export async function assertBooksAdmin(ctx: RecordCtx) {
  const { hasAdmin } = await import('@synapse/shared');
  if (!hasAdmin(ctx.principal.permissions, 'books')) throw forbidden('Requires the "books" admin permission');
}

/** Balance of each account (debit − credit) over a date range, posted lines only. */
export async function balances(tx: Tx, tenantId: string, opts: { from?: string | null; to?: string | null; projectId?: string | null } = {}) {
  return tx.query<{ account_id: string; debit: string; credit: string }>(
    `select account_id, sum(debit) as debit, sum(credit) as credit from journal_lines
      where tenant_id = $1 and posted and ($2::date is null or entry_date >= $2::date) and ($3::date is null or entry_date <= $3::date) and ($4::uuid is null or project_id = $4)
      group by account_id`,
    [tenantId, opts.from ?? null, opts.to ?? null, opts.projectId ?? null],
  );
}

export async function accountById(tx: Tx, tenantId: string, id: string) {
  const a = await tx.one<{ id: string; name: string; type: AccountType; subtype: string; system_key: string | null; is_active: boolean }>(
    `select id, name, type, subtype, system_key, is_active from gl_accounts where tenant_id = $1 and id = $2`,
    [tenantId, id],
  );
  if (!a) throw notFound('Account not found');
  return a;
}

/**
 * A date column as YYYY-MM-DD. node-postgres turns DATE values into a Date at local midnight, so
 * the local calendar parts are the stored date whatever the process time zone is.
 */
export const d10 = (v: unknown): string => {
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  return String(v ?? '').slice(0, 10);
};

/** A foreign-currency payment must be in the documents' currency, at a rate near theirs. */
export function assertSameCurrency(payment: { currency?: unknown; exchange_rate?: unknown }, doc: { currency?: unknown; exchange_rate?: unknown }, what: string) {
  const pc = String(payment.currency ?? 'INR');
  const dc = String(doc.currency ?? 'INR');
  if (pc !== dc) throw badRequest(`The payment is in ${pc} but the ${what} is in ${dc}`);
  if (pc === 'INR') return;
  const pr = Number(payment.exchange_rate ?? 1);
  const dr = Number(doc.exchange_rate ?? 1);
  if (!(pr > 0) || Math.abs(pr - dr) / dr > 0.25) throw badRequest(`The exchange rate ${pr} is more than 25% away from the ${what}'s rate ${dr}`);
}
