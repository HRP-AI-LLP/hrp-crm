/**
 * Books administration: settings, chart of accounts, manual journals, opening balances,
 * invoice write-off, exchange rates, budgets, fixed assets and depreciation, GSTR-2B matching
 * and recurring documents.
 */
import { financialYear } from '@synapse/shared';
import { z } from 'zod';
import type { Tx } from '../../lib/db';
import { badRequest, notFound } from '../../lib/errors';
import { issueInvoice, refreshInvoicePaid, saveInvoiceLines } from '../billing';
import { nextFyNumber } from '../numbering';
import { createRecord, loadRow, type RecordCtx, type RecordEvent } from '../records';
import { postBill, saveBillLines } from './bills';
import { expenseAction } from './expenses';
import { accountById, assertBooksAdmin, booksConfig, ensureBooks, postJournal, postingOn, r2, sys, voidSource, type JLine, d10 } from './ledger';
import { postHistory, repost } from './posting';

const today = () => new Date().toISOString().slice(0, 10);

/* ───────────── settings ───────────── */

export async function getSettings(ctx: RecordCtx) {
  const cfg = await booksConfig(ctx.tx, ctx.tenantId);
  const counts = await ctx.tx.one<{ accounts: number; journals: number }>(
    `select (select count(*)::int from gl_accounts where tenant_id = $1) as accounts, (select count(*)::int from journals where tenant_id = $1 and status = 'posted') as journals`,
    [ctx.tenantId],
  );
  return { config: cfg ?? { enabled: false, books_of_record: 'synapse', start_date: `${financialYear(today()).slice(0, 4)}-04-01`, lock_date: null, base_currency: 'INR', tds_enabled: true, tan: null, pan: null, inventory_on: 'bill' }, ...counts };
}

export interface SettingsInput {
  enabled?: boolean;
  booksOfRecord?: 'synapse' | 'tally';
  startDate?: string;
  lockDate?: string | null;
  tdsEnabled?: boolean;
  tan?: string | null;
  pan?: string | null;
  inventoryOn?: 'bill' | 'none';
}

/**
 * Saves settings. Switching posting on (enabled + synapse) creates the chart and posts every
 * document from the start date. Moving the start date once journals exist is refused.
 */
export async function saveSettings(ctx: RecordCtx, input: SettingsInput) {
  await assertBooksAdmin(ctx);
  await ensureBooks(ctx.tx, ctx.tenantId);
  const before = await postingOn(ctx.tx, ctx.tenantId);
  const cur = (await booksConfig(ctx.tx, ctx.tenantId))!;
  let earlier = false;
  if (input.startDate && input.startDate !== cur.start_date) {
    // moving the start back only brings more documents in; moving it forward would orphan posted ones
    earlier = input.startDate < cur.start_date;
    const j = await ctx.tx.one<{ n: number; o: number }>(
      `select count(*) filter (where source_type <> 'opening')::int as n, count(*) filter (where source_type = 'opening')::int as o from journals where tenant_id = $1 and status = 'posted'`,
      [ctx.tenantId],
    );
    if (j?.o) throw badRequest('Opening balances are entered as at the current start date; void them before moving the start date');
    if (j?.n && !earlier) throw badRequest('The books start date can only move back once documents are posted (to an earlier financial year)');
  }
  await ctx.tx.query(
    `update books_config set enabled = coalesce($2, enabled), books_of_record = coalesce($3, books_of_record), start_date = coalesce($4::date, start_date),
            lock_date = case when $5::boolean then $6::date else lock_date end, tds_enabled = coalesce($7, tds_enabled),
            tan = case when $8::boolean then $9 else tan end, pan = case when $10::boolean then $11 else pan end, inventory_on = coalesce($12, inventory_on), updated_at = now()
      where tenant_id = $1`,
    [
      ctx.tenantId, input.enabled ?? null, input.booksOfRecord ?? null, input.startDate ?? null,
      input.lockDate !== undefined, input.lockDate ?? null, input.tdsEnabled ?? null,
      input.tan !== undefined, input.tan ? input.tan.toUpperCase() : null, input.pan !== undefined, input.pan ? input.pan.toUpperCase() : null, input.inventoryOn ?? null,
    ],
  );
  let posted = 0;
  if ((!before || earlier) && (await postingOn(ctx.tx, ctx.tenantId))) posted = (await postHistory(ctx.tx, ctx.tenantId)).posted;
  return { ...(await getSettings(ctx)), posted };
}

/* ───────────── chart of accounts ───────────── */

export async function listAccounts(ctx: RecordCtx, opts: { includeInactive?: boolean } = {}) {
  await ensureBooks(ctx.tx, ctx.tenantId);
  return ctx.tx.query(
    `select a.id, a.code, a.name, a.type, a.subtype, a.system_key, a.parent_id, a.description, a.is_active, a.currency,
            coalesce(sum(l.debit) filter (where l.posted), 0)::float8 as debit, coalesce(sum(l.credit) filter (where l.posted), 0)::float8 as credit
       from gl_accounts a left join journal_lines l on l.tenant_id = a.tenant_id and l.account_id = a.id
      where a.tenant_id = $1 and ($2::boolean or a.is_active)
      group by a.id order by a.code nulls last, a.name`,
    [ctx.tenantId, !!opts.includeInactive],
  );
}

const TYPE_OF: Record<string, string> = {
  cash: 'asset', bank: 'asset', credit_card: 'liability', accounts_receivable: 'asset', inventory: 'asset', current_asset: 'asset', fixed_asset: 'asset', accumulated_depreciation: 'asset',
  other_asset: 'asset', tax_receivable: 'asset', accounts_payable: 'liability', current_liability: 'liability', long_term_liability: 'liability', tax_payable: 'liability', other_liability: 'liability',
  equity: 'equity', retained_earnings: 'equity', income: 'income', other_income: 'income', cost_of_goods_sold: 'expense', expense: 'expense', other_expense: 'expense',
};

export interface AccountInput {
  code?: string | null;
  name: string;
  subtype: string;
  parentId?: string | null;
  description?: string | null;
  currency?: string | null;
}

async function checkParent(ctx: RecordCtx, parentId: string | null | undefined, type: string, selfId?: string) {
  if (!parentId) return;
  const p = await accountById(ctx.tx, ctx.tenantId, parentId);
  if (p.type !== type) throw badRequest('A sub-account must have the same type as its parent');
  if (selfId) {
    // no cycles
    let cur: string | null = parentId;
    for (let i = 0; cur && i < 20; i++) {
      if (cur === selfId) throw badRequest('An account cannot sit under itself');
      cur = (await ctx.tx.one<{ parent_id: string | null }>(`select parent_id from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, cur]))?.parent_id ?? null;
    }
  }
}

export async function createAccount(ctx: RecordCtx, input: AccountInput) {
  await assertBooksAdmin(ctx);
  const type = TYPE_OF[input.subtype];
  if (!type) throw badRequest('Unknown account type');
  await checkParent(ctx, input.parentId, type);
  const dupe = await ctx.tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and (lower(name) = lower($2) or ($3::text is not null and code = $3))`, [ctx.tenantId, input.name.trim(), input.code || null]);
  if (dupe) throw badRequest('An account with that name or code exists');
  return ctx.tx.one<{ id: string }>(
    `insert into gl_accounts (tenant_id, code, name, type, subtype, parent_id, description, currency) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [ctx.tenantId, input.code || null, input.name.trim(), type, input.subtype, input.parentId ?? null, input.description ?? null, input.currency ?? null],
  );
}

export async function updateAccount(ctx: RecordCtx, id: string, input: Partial<AccountInput> & { isActive?: boolean }) {
  await assertBooksAdmin(ctx);
  const a = await accountById(ctx.tx, ctx.tenantId, id);
  let subtype = a.subtype;
  if (input.subtype && input.subtype !== a.subtype) {
    if (a.system_key) throw badRequest('System accounts keep their type');
    if (TYPE_OF[input.subtype] !== a.type) throw badRequest('An account can only move to a type in the same group (asset, liability, equity, income, expense)');
    subtype = input.subtype;
  }
  if (input.isActive === false) {
    if (a.system_key) throw badRequest('System accounts cannot be deactivated');
    const bal = await ctx.tx.one<{ v: number }>(`select coalesce(sum(debit - credit), 0)::float8 as v from journal_lines where tenant_id = $1 and account_id = $2 and posted`, [ctx.tenantId, id]);
    if (Math.abs(bal?.v ?? 0) >= 0.01) throw badRequest('Move the balance out before deactivating the account');
  }
  if (input.parentId !== undefined) await checkParent(ctx, input.parentId, a.type, id);
  if (input.name || input.code) {
    const dupe = await ctx.tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and id <> $2 and (lower(name) = lower($3) or ($4::text is not null and code = $4))`, [ctx.tenantId, id, (input.name ?? a.name).trim(), input.code || null]);
    if (dupe) throw badRequest('An account with that name or code exists');
  }
  await ctx.tx.query(
    `update gl_accounts set name = coalesce($3, name), code = case when $4::boolean then $5 else code end, subtype = $6, parent_id = case when $7::boolean then $8::uuid else parent_id end,
            description = case when $9::boolean then $10 else description end, is_active = coalesce($11, is_active), updated_at = now() where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, input.name?.trim() ?? null, input.code !== undefined, input.code || null, subtype, input.parentId !== undefined, input.parentId ?? null, input.description !== undefined, input.description ?? null, input.isActive ?? null],
  );
}

export async function deleteAccount(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  const a = await accountById(ctx.tx, ctx.tenantId, id);
  if (a.system_key) throw badRequest('System accounts cannot be deleted');
  const used = await ctx.tx.one<{ n: number }>(
    `select ((select count(*) from journal_lines where tenant_id = $1 and account_id = $2) + (select count(*) from gl_accounts where tenant_id = $1 and parent_id = $2)
            + (select count(*) from bank_accounts where tenant_id = $1 and gl_account_id = $2) + (select count(*) from bill_lines where tenant_id = $1 and account_id = $2)
            + (select count(*) from expenses where tenant_id = $1 and (account_id = $2 or paid_through_id = $2)))::int as n`,
    [ctx.tenantId, id],
  );
  if (used?.n) throw badRequest('The account is in use; deactivate it instead');
  await ctx.tx.query(`delete from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

/* ───────────── manual journals ───────────── */

export interface ManualJournalInput {
  date: string;
  reference?: string | null;
  narration?: string | null;
  lines: { accountId: string; debit?: number; credit?: number; description?: string | null; partyType?: 'customer' | 'vendor' | 'employee' | null; partyId?: string | null; projectId?: string | null }[];
}

async function checkParties(ctx: RecordCtx, lines: ManualJournalInput['lines']) {
  for (const l of lines) {
    if (!l.partyId) continue;
    const table = l.partyType === 'customer' ? 'accounts' : l.partyType === 'vendor' ? 'vendors' : l.partyType === 'employee' ? 'users' : null;
    if (!table) throw badRequest('Say whether the party is a customer, vendor or employee');
    const ok = await ctx.tx.one(`select 1 from ${table} where tenant_id = $1 and id = $2`, [ctx.tenantId, l.partyId]);
    if (!ok) throw badRequest('A party on this entry does not exist');
  }
}

/** Checks the lines of a hand-made journal: exact balance, one side per line, positive amounts, active accounts, parties on AR/AP. */
async function validateManualLines(ctx: RecordCtx, lines: ManualJournalInput['lines']) {
  if (!Array.isArray(lines) || lines.length < 2 || lines.length > 200) throw badRequest('A journal needs between 2 and 200 lines');
  for (const l of lines) {
    if (typeof l.accountId !== 'string' || !/^[0-9a-f-]{36}$/i.test(l.accountId)) throw badRequest('Every line needs an account');
    for (const v of [l.debit, l.credit]) if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12)) throw badRequest('Amounts must be positive numbers');
  }
  const input = { lines };

  const d = r2(input.lines.reduce((s, l) => s + (l.debit ?? 0), 0));
  const c = r2(input.lines.reduce((s, l) => s + (l.credit ?? 0), 0));
  if (d !== c) throw badRequest(`Debits (${d.toFixed(2)}) and credits (${c.toFixed(2)}) must be equal`);
  for (const l of input.lines) if ((l.debit ?? 0) && (l.credit ?? 0)) throw badRequest('A line is either a debit or a credit');
  const accts = await ctx.tx.query<{ id: string; is_active: boolean; subtype: string }>(`select id, is_active, subtype from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, input.lines.map((l) => l.accountId)]);
  if (accts.length !== new Set(input.lines.map((l) => l.accountId)).size) throw badRequest('An account on this entry does not exist');
  if (accts.some((a) => !a.is_active)) throw badRequest('An account on this entry is inactive');
  await checkParties(ctx, input.lines);
  // receivable and payable lines carry the party so statements and ageing stay right
  for (const l of input.lines) {
    const a = accts.find((x) => x.id === l.accountId);
    if (a && ['accounts_receivable', 'accounts_payable'].includes(a.subtype) && !l.partyId) throw badRequest('Lines on receivable or payable accounts need a customer or vendor');
  }
}

export async function createManualJournal(ctx: RecordCtx, input: ManualJournalInput, sourceType: 'manual' | 'opening' = 'manual') {
  await assertBooksAdmin(ctx);
  await ensureBooks(ctx.tx, ctx.tenantId);
  await validateManualLines(ctx, input.lines);
  const id = await postJournal(ctx.tx, ctx.tenantId, { date: input.date, sourceType, reference: input.reference, narration: input.narration, lines: input.lines as JLine[] });
  if (!id) throw badRequest('The entry is empty');
  return { id };
}

export async function listJournals(ctx: RecordCtx, q: { from?: string | null; to?: string | null; sourceType?: string | null; status?: string | null; search?: string | null; limit?: number; offset?: number }) {
  return ctx.tx.query(
    `select j.id, j.number, j.entry_date, j.source_type, j.source_id, j.reference, j.narration, j.status, j.total::float8 as total, j.currency, j.created_at, u.full_name as created_by
       from journals j left join users u on u.tenant_id = j.tenant_id and u.id = j.created_by
      where j.tenant_id = $1 and ($2::date is null or j.entry_date >= $2::date) and ($3::date is null or j.entry_date <= $3::date) and ($4::text is null or j.source_type = $4)
        and ($5::text is null or j.status = $5) and ($6::text is null or j.number ilike '%' || $6 || '%' or j.reference ilike '%' || $6 || '%' or j.narration ilike '%' || $6 || '%')
      order by j.entry_date desc, j.created_at desc limit $7 offset $8`,
    [ctx.tenantId, q.from ?? null, q.to ?? null, q.sourceType ?? null, q.status ?? null, q.search?.replace(/[%_\\]/g, '') || null, Math.min(q.limit ?? 100, 500), q.offset ?? 0],
  );
}

export async function getJournal(ctx: RecordCtx, id: string) {
  const j = await ctx.tx.one<Record<string, any>>(`select id, number, entry_date, source_type, source_id, reference, narration, status, total::float8 as total, currency, exchange_rate::float8 as exchange_rate, void_reason, voided_at, created_at from journals where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!j) throw notFound('Journal not found');
  j.lines = await ctx.tx.query(
    `select l.id, l.account_id, a.code, a.name as account, l.debit::float8 as debit, l.credit::float8 as credit, l.party_type, l.party_id, l.project_id, l.description, l.tax_kind, l.reconciliation_id is not null as reconciled,
            coalesce((select name from accounts where tenant_id = l.tenant_id and id = l.party_id), (select name from vendors where tenant_id = l.tenant_id and id = l.party_id), (select full_name from users where tenant_id = l.tenant_id and id = l.party_id)) as party
       from journal_lines l join gl_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id where l.tenant_id = $1 and l.journal_id = $2 order by l.debit desc, l.credit desc`,
    [ctx.tenantId, id],
  );
  return j;
}

/** Voids a manual or opening journal (document journals are voided through their document). */
export async function voidJournal(ctx: RecordCtx, id: string, reason: string) {
  await assertBooksAdmin(ctx);
  const j = await ctx.tx.one<{ source_type: string; status: string }>(`select source_type, status from journals where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!j) throw notFound('Journal not found');
  if (!['manual', 'opening', 'depreciation'].includes(j.source_type)) throw badRequest('This entry belongs to a document; cancel or void the document instead');
  if (j.status !== 'posted') throw badRequest('Already void');
  const rec = await ctx.tx.one(`select 1 from journal_lines where tenant_id = $1 and journal_id = $2 and reconciliation_id is not null limit 1`, [ctx.tenantId, id]);
  if (rec) throw badRequest('A line of this journal is reconciled; undo the reconciliation first');
  if (j.source_type === 'depreciation') {
    // undo the run on each asset; only the latest run of an asset can be undone
    const rows = await ctx.tx.query<{ id: string; asset_id: string; from_date: string; to_date: string; amount: string; status: string; later: boolean }>(
      `select d.id, d.asset_id, d.from_date, d.to_date, d.amount, f.status,
              exists (select 1 from asset_depreciation x where x.tenant_id = d.tenant_id and x.asset_id = d.asset_id and not x.voided and x.to_date > d.to_date) as later
         from asset_depreciation d join fixed_assets f on f.tenant_id = d.tenant_id and f.id = d.asset_id
        where d.tenant_id = $1 and d.journal_id = $2 and not d.voided for update of f`,
      [ctx.tenantId, id],
    );
    if (rows.some((r) => r.later)) throw badRequest('A later depreciation run exists for these assets; void that one first');
    if (rows.some((r) => r.status === 'disposed')) throw badRequest('An asset in this run has been disposed of');
    for (const r of rows) {
      const prev = new Date(Date.parse(`${d10(r.from_date)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      await ctx.tx.query(
        `update fixed_assets set accumulated = accumulated - $3, depreciated_to = case when $4::date < in_service_date then null else $4::date end, status = 'active', updated_at = now() where tenant_id = $1 and id = $2`,
        [ctx.tenantId, r.asset_id, r.amount, prev],
      );
      await ctx.tx.query(`update asset_depreciation set voided = true where tenant_id = $1 and id = $2`, [ctx.tenantId, r.id]);
    }
  }
  await ctx.tx.query(`update journals set status = 'void', void_reason = $3, voided_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, reason.slice(0, 300)]);
  await ctx.tx.query(`update bank_transactions set status = 'unmatched', journal_id = null where tenant_id = $1 and (journal_id = $2 or id in (select bank_txn_id from journal_lines where tenant_id = $1 and journal_id = $2 and bank_txn_id is not null))`, [ctx.tenantId, id]);
}

/** A new manual journal with debits and credits swapped (e.g. reversing an accrual next month). */
export async function reverseJournal(ctx: RecordCtx, id: string, date: string) {
  const j = await getJournal(ctx, id);
  if (j.status !== 'posted') throw badRequest('Only posted journals can be reversed');
  if (j.source_type !== 'manual') throw badRequest('Only manual journals can be reversed; void the document or the run instead');
  return createManualJournal(ctx, {
    date,
    reference: j.number ? `Reversal of ${j.number}` : 'Reversal',
    narration: `Reverses ${j.number ?? j.source_type} dated ${d10(j.entry_date)}`,
    lines: (j.lines as any[]).map((l) => ({ accountId: l.account_id, debit: l.credit, credit: l.debit, description: l.description, partyType: l.party_type, partyId: l.party_id, projectId: l.project_id })),
  });
}

/* ───────────── opening balances ───────────── */

/**
 * Opening balances as at the day before the books start: one journal, rebuilt on each save.
 * Customer and vendor balances go to receivables / payables per party; the difference goes to
 * opening balance equity.
 */
export async function saveOpeningBalances(
  ctx: RecordCtx,
  input: { accounts: { accountId: string; debit?: number; credit?: number }[]; customers?: { partyId: string; amount: number }[]; vendors?: { partyId: string; amount: number }[] },
) {
  await assertBooksAdmin(ctx);
  await ensureBooks(ctx.tx, ctx.tenantId);
  const cfg = (await booksConfig(ctx.tx, ctx.tenantId))!;
  const date = new Date(Date.parse(`${cfg.start_date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const lines: ManualJournalInput['lines'] = [];
  const ar = await sys(ctx.tx, ctx.tenantId, 'ar');
  const ap = await sys(ctx.tx, ctx.tenantId, 'ap');
  const ob = await sys(ctx.tx, ctx.tenantId, 'opening_equity');
  for (const a of input.accounts) {
    if ([ar, ap, ob].includes(a.accountId)) throw badRequest('Enter receivables and payables per customer and vendor');
    if ((a.debit ?? 0) || (a.credit ?? 0)) lines.push({ accountId: a.accountId, debit: a.debit ?? 0, credit: a.credit ?? 0 });
  }
  for (const p of input.customers ?? []) if (p.amount) lines.push({ accountId: ar, partyType: 'customer', partyId: p.partyId, ...(p.amount > 0 ? { debit: p.amount } : { credit: -p.amount }) });
  for (const p of input.vendors ?? []) if (p.amount) lines.push({ accountId: ap, partyType: 'vendor', partyId: p.partyId, ...(p.amount > 0 ? { credit: p.amount } : { debit: -p.amount }) });
  const accts = await ctx.tx.query<{ id: string; type: string }>(`select id, type from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, lines.map((l) => l.accountId)]);
  if (accts.some((a) => a.type === 'income' || a.type === 'expense')) throw badRequest('Opening balances are for balance-sheet accounts only');
  await checkParties(ctx, lines);
  const diff = r2(lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0));
  if (diff) lines.push({ accountId: ob, ...(diff > 0 ? { credit: diff } : { debit: -diff }) });
  const old = await ctx.tx.query<{ id: string }>(`select id from journals where tenant_id = $1 and source_type = 'opening' and status = 'posted'`, [ctx.tenantId]);
  for (const o of old) await ctx.tx.query(`update journals set status = 'void', void_reason = 'Opening balances re-entered', voided_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, o.id]);
  if (lines.length < 2) return { id: null, date };
  const id = await postJournal(ctx.tx, ctx.tenantId, { date, sourceType: 'opening', reference: 'Opening balances', lines: lines as JLine[] });
  return { id, date };
}

export async function getOpeningBalances(ctx: RecordCtx) {
  const j = await ctx.tx.one<{ id: string }>(`select id from journals where tenant_id = $1 and source_type = 'opening' and status = 'posted' order by created_at desc limit 1`, [ctx.tenantId]);
  return j ? getJournal(ctx, j.id) : null;
}

/* ───────────── write-off ───────────── */

/** Writes off what is left on an invoice as a bad debt (or reverses a write-off with amount 0). */
export async function writeOffInvoice(ctx: RecordCtx, id: string, input: { amount?: number | null; date?: string | null; reason: string }): Promise<RecordEvent[]> {
  await assertBooksAdmin(ctx);
  const { row } = await loadRow(ctx, 'invoice', id, 'update', true);
  if (row.doc_type !== 'tax_invoice' || !['issued', 'partially_paid', 'paid'].includes(String(row.status))) throw badRequest('Only issued invoices can be written off');
  const left = r2(Number(row.grand_total) - Number(row.amount_paid) - Number(row.amount_credited));
  const amount = input.amount == null ? left : r2(input.amount);
  if (amount < 0 || amount > left + 0.005) throw badRequest(`At most ${left.toFixed(2)} can be written off`);
  await ctx.tx.query(`update invoices set amount_written_off = $3, written_off_on = $4::date, notes = left(coalesce(notes || E'\\n', '') || $5, 5000) where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, amount, amount ? (input.date ?? today()) : null, `Written off ${amount.toFixed(2)}: ${input.reason}`,
  ]);
  const events = await refreshInvoicePaid(ctx, id);
  await repost(ctx.tx, ctx.tenantId, 'write_off', id);
  return events;
}

/* ───────────── exchange rates ───────────── */

export async function listRates(ctx: RecordCtx, currency?: string | null) {
  return ctx.tx.query(`select currency, rate_date, rate::float8 as rate from exchange_rates where tenant_id = $1 and ($2::text is null or currency = $2) order by rate_date desc, currency limit 500`, [ctx.tenantId, currency ?? null]);
}

export async function saveRate(ctx: RecordCtx, currency: string, date: string, rate: number) {
  await assertBooksAdmin(ctx);
  if (currency === 'INR') throw badRequest('INR is the base currency');
  await ctx.tx.query(`insert into exchange_rates (tenant_id, currency, rate_date, rate) values ($1,$2,$3,$4) on conflict (tenant_id, currency, rate_date) do update set rate = excluded.rate`, [ctx.tenantId, currency, date, rate]);
}

export async function rateOn(tx: Tx, tenantId: string, currency: string, date: string) {
  if (currency === 'INR') return 1;
  const r = await tx.one<{ rate: number }>(`select rate::float8 as rate from exchange_rates where tenant_id = $1 and currency = $2 and rate_date <= $3::date order by rate_date desc limit 1`, [tenantId, currency, date]);
  return r?.rate ?? null;
}

/* ───────────── budgets ───────────── */

export async function listBudgets(ctx: RecordCtx) {
  return ctx.tx.query(`select b.id, b.name, b.financial_year, b.project_id, b.created_at, (select count(*)::int from budget_lines l where l.tenant_id = b.tenant_id and l.budget_id = b.id) as lines from budgets b where b.tenant_id = $1 order by b.financial_year desc, b.name`, [ctx.tenantId]);
}

export async function saveBudget(ctx: RecordCtx, id: string | null, input: { name: string; financialYear: string; projectId?: string | null; lines: { accountId: string; months: number[] }[] }) {
  await assertBooksAdmin(ctx);
  let bid = id;
  if (bid) {
    const ok = await ctx.tx.one(`update budgets set name = $3, financial_year = $4, project_id = $5 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, bid, input.name, input.financialYear, input.projectId ?? null]);
    if (!ok) throw notFound('Budget not found');
    await ctx.tx.query(`delete from budget_lines where tenant_id = $1 and budget_id = $2`, [ctx.tenantId, bid]);
  } else {
    bid = (await ctx.tx.one<{ id: string }>(`insert into budgets (tenant_id, name, financial_year, project_id) values ($1,$2,$3,$4) returning id`, [ctx.tenantId, input.name, input.financialYear, input.projectId ?? null]))!.id;
  }
  const accts = await ctx.tx.query<{ id: string; type: string }>(`select id, type from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, input.lines.map((l) => l.accountId)]);
  if (accts.length !== new Set(input.lines.map((l) => l.accountId)).size) throw badRequest('An account in the budget does not exist');
  for (const l of input.lines) {
    if (l.months.length !== 12) throw badRequest('Each budget line has 12 months (April to March)');
    await ctx.tx.query(`insert into budget_lines (tenant_id, budget_id, account_id, months) values ($1,$2,$3,$4) on conflict (tenant_id, budget_id, account_id) do update set months = excluded.months`, [ctx.tenantId, bid, l.accountId, l.months.map(r2)]);
  }
  return { id: bid };
}

export async function deleteBudget(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  await ctx.tx.query(`delete from budgets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

/* ───────────── fixed assets ───────────── */

export interface AssetInput {
  name: string;
  assetAccountId?: string | null;
  purchaseDate: string;
  inServiceDate?: string | null;
  cost: number;
  salvageValue?: number;
  method: 'slm' | 'wdv';
  ratePct?: number | null;
  lifeMonths?: number | null;
  location?: string | null;
  serialNo?: string | null;
  billId?: string | null;
  /** Post the purchase (Dr asset, Cr this bank/cash/payable account) — leave empty when a bill already posted it. */
  paidThroughId?: string | null;
}

export async function listAssets(ctx: RecordCtx) {
  return ctx.tx.query(
    `select f.id, f.asset_number, f.name, f.purchase_date, f.in_service_date, f.cost::float8 as cost, f.salvage_value::float8 as salvage_value, f.method, f.rate_pct::float8 as rate_pct, f.life_months,
            f.accumulated::float8 as accumulated, (f.cost - f.accumulated)::float8 as book_value, f.depreciated_to, f.status, f.disposed_on, f.disposal_amount::float8 as disposal_amount, f.location, f.serial_no, a.name as asset_account
       from fixed_assets f join gl_accounts a on a.tenant_id = f.tenant_id and a.id = f.asset_account_id where f.tenant_id = $1 order by f.purchase_date desc`,
    [ctx.tenantId],
  );
}

export async function createAsset(ctx: RecordCtx, input: AssetInput) {
  await assertBooksAdmin(ctx);
  await ensureBooks(ctx.tx, ctx.tenantId);
  const assetAcc = input.assetAccountId ?? (await sys(ctx.tx, ctx.tenantId, 'fa_machinery'));
  const a = await accountById(ctx.tx, ctx.tenantId, assetAcc);
  if (a.subtype !== 'fixed_asset') throw badRequest('Choose a fixed asset account');
  if (input.method === 'wdv' && !input.ratePct) throw badRequest('Written-down value needs a rate');
  if (input.method === 'slm' && !input.lifeMonths && !input.ratePct) throw badRequest('Straight line needs a useful life or a rate');
  if ((input.salvageValue ?? 0) >= input.cost) throw badRequest('Salvage value must be below cost');
  const n = await nextFyNumber(ctx, 'asset', input.purchaseDate, 'FA');
  const row = await ctx.tx.one<{ id: string }>(
    `insert into fixed_assets (tenant_id, name, asset_number, asset_account_id, depreciation_account_id, accumulated_account_id, purchase_date, in_service_date, cost, salvage_value, method, rate_pct, life_months, location, serial_no, bill_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning id`,
    [
      ctx.tenantId, input.name, n.number, assetAcc, await sys(ctx.tx, ctx.tenantId, 'depreciation'), await sys(ctx.tx, ctx.tenantId, 'accumulated_depreciation'),
      input.purchaseDate, input.inServiceDate ?? input.purchaseDate, input.cost, input.salvageValue ?? 0, input.method, input.ratePct ?? null, input.lifeMonths ?? null,
      input.location ?? null, input.serialNo ?? null, input.billId ?? null,
    ],
  );
  if (input.paidThroughId && (await postingOn(ctx.tx, ctx.tenantId))) {
    const p = await accountById(ctx.tx, ctx.tenantId, input.paidThroughId);
    if (!['bank', 'cash', 'credit_card', 'current_liability', 'long_term_liability'].includes(p.subtype)) throw badRequest('Pay for the asset from a bank, cash, card or loan account');
    await postJournal(ctx.tx, ctx.tenantId, {
      date: input.purchaseDate, sourceType: 'manual', reference: n.number, narration: `Purchase of ${input.name}`,
      lines: [{ accountId: assetAcc, debit: input.cost }, { accountId: input.paidThroughId, credit: input.cost }],
    });
  }
  return { id: row!.id, number: n.number };
}

const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);

/** Depreciation for one asset for one month (pro-rata from the in-service date in the first month). */
function monthCharge(a: Record<string, any>, from: string, to: string, accumulated: number) {
  const cost = Number(a.cost);
  const salvage = Number(a.salvage_value);
  const depreciable = r2(cost - salvage - accumulated);
  if (depreciable <= 0) return 0;
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  const monthDays = Number(to.slice(8, 10));
  const frac = Math.min(1, days / monthDays);
  let charge: number;
  if (a.method === 'wdv') charge = ((cost - accumulated) * Number(a.rate_pct)) / 100 / 12;
  else if (a.life_months) charge = (cost - salvage) / Number(a.life_months);
  else charge = (cost * Number(a.rate_pct)) / 100 / 12;
  return r2(Math.min(depreciable, charge * frac));
}

/**
 * Runs depreciation for every active asset up to the end of the given month. Each asset is
 * charged month by month from where it last stopped; one journal per run.
 */
export async function runDepreciation(ctx: RecordCtx, upTo: string, assetId: string | null = null) {
  await assertBooksAdmin(ctx);
  const y = Number(upTo.slice(0, 4));
  const m = Number(upTo.slice(5, 7)) - 1;
  const end = monthEnd(y, m);
  if (end > new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10)) throw badRequest('Depreciation can run at most to the end of next month');
  const assets = await ctx.tx.query<Record<string, any>>(
    `select * from fixed_assets where tenant_id = $1 and status = 'active' and in_service_date <= $2::date and ($3::uuid is null or id = $3) for update`,
    [ctx.tenantId, end, assetId],
  );
  const byAccount = new Map<string, { dep: string; acc: string; amount: number }>();
  const done: { id: string; amount: number; from: string; to: string }[] = [];
  for (const a of assets) {
    let acc = Number(a.accumulated);
    let cur = a.depreciated_to ? new Date(Date.parse(`${d10(a.depreciated_to)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : d10(a.in_service_date);
    let total = 0;
    while (cur <= end) {
      const me = monthEnd(Number(cur.slice(0, 4)), Number(cur.slice(5, 7)) - 1);
      const c = monthCharge(a, cur, me, acc);
      acc = r2(acc + c);
      total = r2(total + c);
      cur = new Date(Date.parse(`${me}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    }
    const fully = r2(Number(a.cost) - Number(a.salvage_value) - acc) <= 0;
    const from = a.depreciated_to ? new Date(Date.parse(`${d10(a.depreciated_to)}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : d10(a.in_service_date);
    await ctx.tx.query(`update fixed_assets set accumulated = $3, depreciated_to = $4, status = $5, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, a.id, acc, end, fully ? 'fully_depreciated' : 'active']);
    if (!total) continue;
    done.push({ id: a.id, amount: total, from, to: end });
    const k = `${a.depreciation_account_id}|${a.accumulated_account_id}`;
    const e = byAccount.get(k) ?? { dep: a.depreciation_account_id, acc: a.accumulated_account_id, amount: 0 };
    e.amount = r2(e.amount + total);
    byAccount.set(k, e);
  }
  let journalId: string | null = null;
  if (byAccount.size && (await postingOn(ctx.tx, ctx.tenantId))) {
    const lines: JLine[] = [];
    for (const e of byAccount.values()) lines.push({ accountId: e.dep, debit: e.amount }, { accountId: e.acc, credit: e.amount });
    journalId = await postJournal(ctx.tx, ctx.tenantId, { date: end, sourceType: 'depreciation', reference: `Depreciation to ${end}`, narration: `Depreciation on ${done.length} asset(s)`, lines });
  }
  for (const d of done)
    await ctx.tx.query(`insert into asset_depreciation (tenant_id, asset_id, journal_id, from_date, to_date, amount) values ($1,$2,$3,$4,$5,$6)`, [ctx.tenantId, d.id, journalId, d.from, d.to, d.amount]);
  return { upTo: end, assets: done.map(({ id, amount }) => ({ id, amount })), total: r2(done.reduce((s, d) => s + d.amount, 0)), journalId };
}

/** Sells or scraps an asset: removes cost and accumulated depreciation, books the gain or loss. */
export async function disposeAsset(ctx: RecordCtx, id: string, input: { date: string; amount: number; depositToId?: string | null }) {
  await assertBooksAdmin(ctx);
  const a = await ctx.tx.one<Record<string, any>>(`select * from fixed_assets where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!a) throw notFound('Asset not found');
  if (a.status === 'disposed') throw badRequest('Already disposed');
  const dMonthEnd = monthEnd(Number(input.date.slice(0, 4)), Number(input.date.slice(5, 7)) - 1);
  if (a.depreciated_to && d10(a.depreciated_to) > dMonthEnd) throw badRequest(`Depreciation is already charged up to ${d10(a.depreciated_to)}; dispose of the asset on or after that month, or void the later depreciation first`);
  // bring depreciation up to the month before disposal
  const prev = new Date(Date.parse(`${input.date.slice(0, 7)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  if (!a.depreciated_to || d10(a.depreciated_to) < prev) await runDepreciation(ctx, prev, id);
  const fresh = (await ctx.tx.one<Record<string, any>>(`select * from fixed_assets where tenant_id = $1 and id = $2`, [ctx.tenantId, id]))!;
  const cost = Number(fresh.cost);
  const accd = Number(fresh.accumulated);
  const gain = r2(input.amount - (cost - accd));
  await ctx.tx.query(`update fixed_assets set status = 'disposed', disposed_on = $3, disposal_amount = $4, updated_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, id, input.date, input.amount]);
  if (await postingOn(ctx.tx, ctx.tenantId)) {
    const lines: JLine[] = [
      { accountId: fresh.accumulated_account_id, debit: accd },
      { accountId: fresh.asset_account_id, credit: cost },
    ];
    if (input.amount) lines.push({ accountId: input.depositToId ?? (await sys(ctx.tx, ctx.tenantId, 'bank')), debit: input.amount });
    if (gain > 0) lines.push({ accountId: await sys(ctx.tx, ctx.tenantId, 'asset_gain_loss'), credit: gain });
    if (gain < 0) lines.push({ accountId: await sys(ctx.tx, ctx.tenantId, 'asset_gain_loss'), debit: -gain });
    await voidSource(ctx.tx, ctx.tenantId, 'asset_disposal', id, 'Re-disposed');
    await postJournal(ctx.tx, ctx.tenantId, { date: input.date, sourceType: 'asset_disposal', sourceId: id, reference: fresh.asset_number, narration: `Disposal of ${fresh.name}`, lines });
  }
  return { gain };
}

/* ───────────── GSTR-2B ───────────── */

export interface Gstr2bRow {
  supplierGstin: string;
  supplierName?: string | null;
  docNumber: string;
  docDate?: string | null;
  docType?: string | null;
  taxable: number;
  igst?: number;
  cgst?: number;
  sgst?: number;
  itcAvailable?: boolean;
}

export const normDoc = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');

/** Imports a GSTR-2B period (replacing an earlier import of it) and matches it against bills. */
export async function importGstr2b(ctx: RecordCtx, period: string, rows: Gstr2bRow[]) {
  await assertBooksAdmin(ctx);
  await ctx.tx.query(`delete from gstr2b_imports where tenant_id = $1 and period = $2`, [ctx.tenantId, period]);
  const imp = (await ctx.tx.one<{ id: string }>(`insert into gstr2b_imports (tenant_id, period, lines) values ($1,$2,$3) returning id`, [ctx.tenantId, period, rows.length]))!;
  for (const r of rows)
    await ctx.tx.query(
      `insert into gstr2b_lines (tenant_id, import_id, supplier_gstin, supplier_name, doc_number, doc_date, doc_type, taxable, igst, cgst, sgst, itc_available) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [ctx.tenantId, imp.id, r.supplierGstin.toUpperCase(), r.supplierName ?? null, r.docNumber, r.docDate ?? null, r.docType ?? null, r.taxable, r.igst ?? 0, r.cgst ?? 0, r.sgst ?? 0, r.itcAvailable ?? true],
    );
  return { id: imp.id, ...(await matchGstr2b(ctx, imp.id)) };
}

export async function matchGstr2b(ctx: RecordCtx, importId: string) {
  const lines = await ctx.tx.query<Record<string, any>>(`select * from gstr2b_lines where tenant_id = $1 and import_id = $2`, [ctx.tenantId, importId]);
  const bills = await ctx.tx.query<Record<string, any>>(
    `select id, vendor_gstin, vendor_ref, bill_date, taxable_total::float8 as taxable, (igst_total + cgst_total + sgst_total)::float8 as tax from bills
      where tenant_id = $1 and doc_type = 'bill' and status not in ('draft','void') and deleted_at is null and vendor_gstin is not null and bill_date >= current_date - interval '24 months'`,
    [ctx.tenantId],
  );
  // links someone made by hand (0035) win over matching by document number
  const links = await ctx.tx.query<{ supplier_gstin: string; doc_key: string; bill_id: string }>(`select supplier_gstin, doc_key, bill_id from gstr2b_links where tenant_id = $1`, [ctx.tenantId]);
  const linked = links.length
    ? await ctx.tx.query<Record<string, any>>(
        `select id, vendor_gstin, vendor_ref, bill_date, taxable_total::float8 as taxable, (igst_total + cgst_total + sgst_total)::float8 as tax from bills
          where tenant_id = $1 and id = any($2::uuid[]) and status not in ('draft','void') and deleted_at is null`,
        [ctx.tenantId, links.map((x) => x.bill_id)],
      )
    : [];
  const used = new Set<string>();
  let matched = 0;
  let mismatch = 0;
  for (const l of lines) {
    const link = links.find((x) => x.supplier_gstin === l.supplier_gstin && x.doc_key === normDoc(l.doc_number));
    const byHand = link ? linked.find((x) => x.id === link.bill_id && !used.has(x.id)) : undefined;
    const b = byHand ?? bills.find((x) => !used.has(x.id) && !links.some((k) => k.bill_id === x.id) && x.vendor_gstin === l.supplier_gstin && x.vendor_ref && normDoc(x.vendor_ref) === normDoc(l.doc_number));
    let status = 'unmatched';
    let note: string | null = null;
    if (b) {
      used.add(b.id);
      const tax = r2(Number(l.igst) + Number(l.cgst) + Number(l.sgst));
      const okTaxable = Math.abs(b.taxable - Number(l.taxable)) <= 1;
      const okTax = Math.abs(b.tax - tax) <= 1;
      status = okTaxable && okTax ? 'matched' : 'mismatch';
      if (status === 'mismatch') note = `Books: taxable ${b.taxable.toFixed(2)}, tax ${b.tax.toFixed(2)}; GSTR-2B: taxable ${Number(l.taxable).toFixed(2)}, tax ${tax.toFixed(2)}`;
      if (byHand) note = note ? `Linked by hand. ${note}` : 'Linked by hand';
    }
    if (status === 'matched') matched++;
    if (status === 'mismatch') mismatch++;
    await ctx.tx.query(`update gstr2b_lines set match_status = $3, bill_id = $4, note = $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, status, b?.id ?? null, note]);
  }
  return { lines: lines.length, matched, mismatch, unmatched: lines.length - matched - mismatch };
}

export async function gstr2bReport(ctx: RecordCtx, period: string) {
  const imp = await ctx.tx.one<{ id: string; created_at: string }>(`select id, created_at from gstr2b_imports where tenant_id = $1 and period = $2`, [ctx.tenantId, period]);
  if (!imp) return null;
  const lines = await ctx.tx.query(
    `select l.id, l.supplier_gstin, l.supplier_name, l.doc_number, l.doc_date, l.doc_type, l.taxable::float8 as taxable, (l.igst + l.cgst + l.sgst)::float8 as tax, l.itc_available, l.match_status, l.note, l.bill_id, b.bill_number, b.status as bill_status
       from gstr2b_lines l left join bills b on b.tenant_id = l.tenant_id and b.id = l.bill_id where l.tenant_id = $1 and l.import_id = $2 order by l.match_status desc, l.supplier_gstin`,
    [ctx.tenantId, imp.id],
  );
  // bills in the books for the period that the supplier has not filed
  const y = Number(period.slice(2, 6));
  const m = Number(period.slice(0, 2));
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const to = monthEnd(y, m - 1);
  const missing = await ctx.tx.query(
    `select b.id, b.bill_number, b.vendor_ref, b.bill_date, b.vendor_gstin, v.name as vendor, b.taxable_total::float8 as taxable, (b.igst_total + b.cgst_total + b.sgst_total)::float8 as tax
       from bills b join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
      where b.tenant_id = $1 and b.doc_type = 'bill' and b.status not in ('draft','void') and b.deleted_at is null and b.itc_eligible and not b.reverse_charge and b.vendor_gstin is not null
        and b.bill_date between $2::date and $3::date and not exists (select 1 from gstr2b_lines l where l.tenant_id = b.tenant_id and l.bill_id = b.id)`,
    [ctx.tenantId, from, to],
  );
  return { period, importedAt: imp.created_at, lines, missingInGstr2b: missing };
}

/* ───────────── recurring documents ───────────── */

export interface RecurringInput {
  name: string;
  kind: 'invoice' | 'bill' | 'expense' | 'journal';
  /** invoice/bill/expense: { values: record fields, lines?: [...] }; journal: ManualJournalInput minus date */
  template: Record<string, any>;
  frequency: 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';
  every?: number;
  startDate: string;
  endDate?: string | null;
  autoIssue?: boolean;
}

export function nextRun(date: string, frequency: RecurringInput['frequency'], every = 1) {
  const d = new Date(`${date}T00:00:00Z`);
  if (frequency === 'weekly') return new Date(d.getTime() + 7 * every * 86_400_000).toISOString().slice(0, 10);
  const months = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 }[frequency] * every;
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

export async function listRecurring(ctx: RecordCtx) {
  return ctx.tx.query(
    `select p.id, p.name, p.kind, p.frequency, p.every, p.start_date, p.end_date, p.next_date, p.last_run_at, p.last_doc_id, p.runs, p.auto_issue, p.status, p.last_error, p.template, p.deal_id, p.project_id, p.account_id,
            (select json_agg(json_build_object('effective_from', c.effective_from, 'lines', c.lines, 'tax_inclusive', c.tax_inclusive, 'note', c.note) order by c.effective_from) from recurring_price_changes c where c.tenant_id = p.tenant_id and c.profile_id = p.id) as price_changes
       from recurring_profiles p where p.tenant_id = $1 order by p.status, p.next_date`,
    [ctx.tenantId],
  );
}

async function checkTemplate(ctx: RecordCtx, kind: RecurringInput['kind'], tpl: Record<string, any>) {
  const objectKey = { invoice: 'invoice', bill: 'bill', expense: 'expense', journal: null }[kind];
  if (objectKey) {
    if (typeof tpl.values !== 'object' || !tpl.values) throw badRequest('The template needs the document fields');
    // creating one later must be allowed for the person setting it up
    const { objectPerm } = await import('@synapse/shared');
    if (!objectPerm(ctx.principal.permissions, objectKey).create) throw badRequest(`You cannot create ${objectKey}s`);
  } else {
    await assertBooksAdmin(ctx);
    await validateManualLines(ctx, tpl.lines);
  }
}

export async function saveRecurring(ctx: RecordCtx, id: string | null, input: RecurringInput) {
  await checkTemplate(ctx, input.kind, input.template);
  if (input.endDate && input.endDate < input.startDate) throw badRequest('The end date is before the start date');
  if (input.startDate < new Date(Date.now() - 366 * 86_400_000).toISOString().slice(0, 10)) throw badRequest('A recurring profile can start at most a year back');
  if (id) {
    const ok = await ctx.tx.one(
      `update recurring_profiles set name = $3, kind = $4, template = $5, frequency = $6, every = $7, start_date = $8, end_date = $9, auto_issue = $10,
              next_date = case when runs = 0 then $8 else next_date end, updated_at = now() where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, input.name, input.kind, JSON.stringify(input.template), input.frequency, input.every ?? 1, input.startDate, input.endDate ?? null, !!input.autoIssue],
    );
    if (!ok) throw notFound('Recurring profile not found');
    return { id };
  }
  return ctx.tx.one<{ id: string }>(
    `insert into recurring_profiles (tenant_id, name, kind, template, frequency, every, start_date, end_date, next_date, auto_issue) values ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9) returning id`,
    [ctx.tenantId, input.name, input.kind, JSON.stringify(input.template), input.frequency, input.every ?? 1, input.startDate, input.endDate ?? null, !!input.autoIssue],
  );
}

export async function setRecurringStatus(ctx: RecordCtx, id: string, status: 'active' | 'paused') {
  const r = await ctx.tx.one(`update recurring_profiles set status = $3, updated_at = now() where tenant_id = $1 and id = $2 and status <> 'ended' returning id`, [ctx.tenantId, id, status]);
  if (!r) throw notFound('Recurring profile not found');
}

export async function deleteRecurring(ctx: RecordCtx, id: string) {
  await ctx.tx.query(`delete from recurring_profiles where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}

/** The price change in force on a date (latest effective on or before it). */
async function priceOn(ctx: RecordCtx, profileId: string, date: string) {
  return ctx.tx.one<{ lines: any[]; tax_inclusive: boolean }>(
    `select lines, tax_inclusive from recurring_price_changes where tenant_id = $1 and profile_id = $2 and effective_from <= $3::date order by effective_from desc limit 1`,
    [ctx.tenantId, profileId, date],
  );
}

export const priceChangeSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  taxInclusive: z.boolean().default(false),
  note: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid().nullish(),
        name: z.string().trim().min(1).max(200),
        description: z.string().max(2000).nullish(),
        hsnSac: z.string().max(20).nullish(),
        unit: z.string().max(20).nullish(),
        quantity: z.coerce.number().positive().max(1e9),
        unitPrice: z.coerce.number().min(0).max(1e12),
        discountPct: z.coerce.number().min(0).max(100).default(0),
        taxRate: z.coerce.number().min(0).max(100).default(0),
      }),
    )
    .min(1)
    .max(100),
});

/**
 * Changes a recurring invoice's price from a date onward (₹3,000 + GST → ₹1,200 including GST from
 * June). Invoices dated before it keep the old price; the history stays on the profile.
 */
export async function addPriceChange(ctx: RecordCtx, profileId: string, input: z.infer<typeof priceChangeSchema>) {
  const p = await ctx.tx.one<{ kind: string; start_date: Date }>(`select kind, start_date from recurring_profiles where tenant_id = $1 and id = $2`, [ctx.tenantId, profileId]);
  if (!p) throw notFound('Recurring profile not found');
  if (p.kind !== 'invoice') throw badRequest('Price changes are for recurring invoices');
  await checkTemplate(ctx, 'invoice', { values: {} });
  await ctx.tx.query(
    `insert into recurring_price_changes (tenant_id, profile_id, effective_from, lines, tax_inclusive, note) values ($1,$2,$3,$4,$5,$6)
     on conflict (tenant_id, profile_id, effective_from) do update set lines = excluded.lines, tax_inclusive = excluded.tax_inclusive, note = excluded.note, created_by = app.current_user_id(), created_at = now()`,
    [ctx.tenantId, profileId, input.effectiveFrom, JSON.stringify(input.lines), input.taxInclusive, input.note ?? null],
  );
  return priceChanges(ctx, profileId);
}

export async function removePriceChange(ctx: RecordCtx, profileId: string, effectiveFrom: string) {
  await checkTemplate(ctx, 'invoice', { values: {} });
  await ctx.tx.query(`delete from recurring_price_changes where tenant_id = $1 and profile_id = $2 and effective_from = $3::date`, [ctx.tenantId, profileId, effectiveFrom]);
  return priceChanges(ctx, profileId);
}

export async function priceChanges(ctx: RecordCtx, profileId: string) {
  return ctx.tx.query(
    `select to_char(effective_from, 'YYYY-MM-DD') as effective_from, lines, tax_inclusive, note, created_at from recurring_price_changes where tenant_id = $1 and profile_id = $2 order by effective_from`,
    [ctx.tenantId, profileId],
  );
}

/** Creates one document from a profile for the given date. */
async function generate(ctx: RecordCtx, p: Record<string, any>, date: string, period = date): Promise<{ id: string; events: RecordEvent[] }> {
  const tpl = p.template as Record<string, any>;
  if (p.kind === 'journal') {
    await validateManualLines(ctx, tpl.lines);
    const r = await postJournal(ctx.tx, ctx.tenantId, { date, sourceType: 'manual', reference: tpl.reference ?? p.name, narration: tpl.narration ?? `Recurring: ${p.name}`, lines: tpl.lines as JLine[] });
    if (!r) throw badRequest('The journal is empty');
    return { id: r, events: [] };
  }
  const objectKey = p.kind as 'invoice' | 'bill' | 'expense';
  const dateField = { invoice: 'invoice_date', bill: 'bill_date', expense: 'expense_date' }[objectKey];
  // a price change in force on this date replaces the template's lines
  // the price of the period being billed (an invoice made early still bills that period)
  const change = objectKey === 'invoice' ? await priceOn(ctx, String(p.id), period) : null;
  const values: Record<string, unknown> = { ...(tpl.values as Record<string, unknown>), [dateField]: date, name: `${(tpl.values as any).name ?? p.name}` };
  if (change) values.tax_inclusive = change.tax_inclusive;
  delete (values as any).due_date;
  const { record, events } = await createRecord(ctx, objectKey, values, { fromAutomation: true });
  const id = String(record.id);
  if (objectKey === 'invoice') {
    // the invoice knows the schedule it came from, and its deal and project
    await ctx.tx.query(`update invoices set recurring_profile_id = $3, deal_id = coalesce(deal_id, $4), project_id = coalesce(project_id, $5) where tenant_id = $1 and id = $2`, [ctx.tenantId, id, p.id, p.deal_id ?? null, p.project_id ?? null]);
    const lines = change ? change.lines : tpl.lines;
    if (Array.isArray(lines)) events.push(...(await saveInvoiceLines(ctx, id, lines)));
    if (p.auto_issue) events.push(...(await issueInvoice(ctx, id)));
  } else if (objectKey === 'bill') {
    if (Array.isArray(tpl.lines)) events.push(...(await saveBillLines(ctx, id, tpl.lines)));
    if (p.auto_issue) events.push(...(await postBill(ctx, id)));
  } else if (objectKey === 'expense') {
    if (tpl.accountId !== undefined || tpl.paidThroughId !== undefined) {
      await ctx.tx.query(`update expenses set account_id = $3, paid_through_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, tpl.accountId ?? null, tpl.paidThroughId ?? null]);
    }
    if (p.auto_issue && !(values as any).is_claim) events.push(...(await expenseAction(ctx, id, 'record')));
  }
  return { id, events };
}

/** Runs one profile now (manual "create now"), advancing its schedule. */
export async function runRecurring(ctx: RecordCtx, id: string) {
  const p = await ctx.tx.one<Record<string, any>>(`select * from recurring_profiles where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!p) throw notFound('Recurring profile not found');
  const date = d10(p.next_date) <= today() ? d10(p.next_date) : today();
  const r = await generate(ctx, p, date, d10(p.next_date));
  await advance(ctx.tx, ctx.tenantId, p, r.id, null);
  return r;
}

async function advance(tx: Tx, tenantId: string, p: Record<string, any>, docId: string | null, error: string | null) {
  const next = nextRun(d10(p.next_date), p.frequency, p.every);
  const ended = p.end_date && next > d10(p.end_date);
  await tx.query(
    `update recurring_profiles set next_date = $3, runs = runs + case when $4::uuid is null then 0 else 1 end, last_run_at = now(), last_doc_id = coalesce($4, last_doc_id), last_error = $5,
            status = case when $6 then 'ended' else status end, updated_at = now() where tenant_id = $1 and id = $2`,
    [tenantId, p.id, next, docId, error, !!ended],
  );
}

/**
 * Daily: creates every document that is due. Each profile runs in its own savepoint-free unit:
 * a failure is recorded on the profile (and skips that date) without stopping the others.
 */
export async function recurringSweep(withCtx: <T>(fn: (ctx: RecordCtx) => Promise<T>) => Promise<T>) {
  const due = await withCtx((ctx) => ctx.tx.query<{ id: string }>(`select id from recurring_profiles where tenant_id = $1 and status = 'active' and next_date <= current_date order by next_date limit 200`, [ctx.tenantId]));
  const events: RecordEvent[] = [];
  let created = 0;
  for (const { id } of due) {
    // catch up at most 12 missed runs per day
    for (let i = 0; i < 12; i++) {
      let again = false;
      try {
        await withCtx(async (ctx) => {
          const p = await ctx.tx.one<Record<string, any>>(`select * from recurring_profiles where tenant_id = $1 and id = $2 and status = 'active' and next_date <= current_date for update`, [ctx.tenantId, id]);
          if (!p) return;
          const r = await generate(ctx, p, d10(p.next_date));
          events.push(...r.events);
          created++;
          await advance(ctx.tx, ctx.tenantId, p, r.id, null);
          again = true;
        });
      } catch (e) {
        await withCtx(async (ctx) => {
          const p = await ctx.tx.one<Record<string, any>>(`select * from recurring_profiles where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
          if (p) await advance(ctx.tx, ctx.tenantId, p, null, (e as Error).message.slice(0, 500));
        });
      }
      if (!again) break;
    }
  }
  return { created, events };
}

export { repost };
