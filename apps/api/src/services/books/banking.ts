/**
 * Banking: bank, cash, card and wallet accounts; statement import; matching statement lines to
 * the ledger; categorising the rest (manually or by rules); transfers; reconciliation.
 *
 * A statement line is either matched to an existing ledger line on that account (a payment,
 * receipt or expense already posted), categorised (a new journal against another account), or
 * excluded. Reconciling marks ledger lines as cleared up to a statement date and only completes
 * when the cleared balance equals the statement's closing balance.
 */
import { badRequest, notFound } from '../../lib/errors';
import { sha256Hex } from '../../lib/crypto';
import type { RecordCtx } from '../records';
import { r2, postJournal, sys, voidSource, d10 } from './ledger';


export async function bankAccount(ctx: RecordCtx, id: string) {
  const b = await ctx.tx.one<{ id: string; gl_account_id: string; kind: string; name: string; is_active: boolean }>(
    `select b.id, b.gl_account_id, b.kind, a.name, b.is_active from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where b.tenant_id = $1 and b.id = $2`,
    [ctx.tenantId, id],
  );
  if (!b) throw notFound('Bank account not found');
  return b;
}

/** Every bank / cash / card account has a bank_accounts row (created for system ones on demand). */
export async function listBankAccounts(ctx: RecordCtx) {
  await ctx.tx.query(
    `insert into bank_accounts (tenant_id, gl_account_id, kind)
     select a.tenant_id, a.id, case a.subtype when 'cash' then 'cash' when 'credit_card' then 'credit_card' else 'bank' end
       from gl_accounts a where a.tenant_id = $1 and a.subtype in ('bank','cash','credit_card') and a.is_active
        and not exists (select 1 from bank_accounts b where b.tenant_id = a.tenant_id and b.gl_account_id = a.id)`,
    [ctx.tenantId],
  );
  return ctx.tx.query(
    `select b.id, b.gl_account_id, b.kind, b.bank_name, b.account_last4, b.ifsc, b.is_active, b.last_statement_date, a.name, a.code,
            coalesce((select sum(l.debit - l.credit) from journal_lines l where l.tenant_id = b.tenant_id and l.account_id = b.gl_account_id and l.posted), 0)::float8 as book_balance,
            coalesce((select sum(l.debit - l.credit) from journal_lines l where l.tenant_id = b.tenant_id and l.account_id = b.gl_account_id and l.posted and l.reconciliation_id is not null), 0)::float8 as cleared_balance,
            (select count(*)::int from bank_transactions t where t.tenant_id = b.tenant_id and t.bank_account_id = b.id and t.status = 'unmatched') as unmatched,
            (select t.balance::float8 from bank_transactions t where t.tenant_id = b.tenant_id and t.bank_account_id = b.id and t.balance is not null order by t.txn_date desc, t.created_at desc limit 1) as statement_balance,
            (select max(r.statement_date) from bank_reconciliations r where r.tenant_id = b.tenant_id and r.bank_account_id = b.id and r.status = 'completed') as reconciled_to
       from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id
      where b.tenant_id = $1 order by b.kind, a.name`,
    [ctx.tenantId],
  );
}

export async function createBankAccount(ctx: RecordCtx, input: { name: string; kind: 'bank' | 'cash' | 'credit_card' | 'wallet'; bankName?: string | null; last4?: string | null; ifsc?: string | null; code?: string | null }) {
  const subtype = input.kind === 'cash' ? 'cash' : input.kind === 'credit_card' ? 'credit_card' : 'bank';
  const type = input.kind === 'credit_card' ? 'liability' : 'asset';
  if (await ctx.tx.one(`select 1 from gl_accounts where tenant_id = $1 and lower(name) = lower($2)`, [ctx.tenantId, input.name])) throw badRequest('An account with this name already exists');
  const a = await ctx.tx.one<{ id: string }>(`insert into gl_accounts (tenant_id, code, name, type, subtype) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, input.code ?? null, input.name, type, subtype]);
  const b = await ctx.tx.one<{ id: string }>(`insert into bank_accounts (tenant_id, gl_account_id, kind, bank_name, account_last4, ifsc) values ($1,$2,$3,$4,$5,$6) returning id`, [
    ctx.tenantId, a!.id, input.kind, input.bankName ?? null, input.last4 ?? null, input.ifsc ?? null,
  ]);
  return { id: b!.id, glAccountId: a!.id };
}

export interface StatementRow {
  date: string;
  description: string;
  reference?: string | null;
  amount: number;
  balance?: number | null;
}

/** Imports statement lines; the same line imported twice is skipped. */
export async function importStatement(ctx: RecordCtx, bankAccountId: string, rows: StatementRow[]) {
  const b = await bankAccount(ctx, bankAccountId);
  if (rows.length > 5000) throw badRequest('Import at most 5,000 lines at a time');
  const batch = new Date().toISOString();
  const seen = new Map<string, number>();
  let added = 0;
  let skipped = 0;
  for (const r of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !Number.isFinite(r.amount) || !r.amount) {
      skipped++;
      continue;
    }
    const base = `${r.date}|${r.amount.toFixed(2)}|${r.description.trim().toLowerCase()}|${(r.reference ?? '').trim()}`;
    const k = (seen.get(base) ?? 0) + 1;
    seen.set(base, k);
    const hash = (await sha256Hex(`${base}|${k}`)).slice(0, 40);
    const ins = await ctx.tx.one<{ id: string }>(
      `insert into bank_transactions (tenant_id, bank_account_id, txn_date, description, reference, amount, balance, import_batch, dedupe_hash)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (tenant_id, bank_account_id, dedupe_hash) do nothing returning id`,
      [ctx.tenantId, b.id, r.date, r.description.slice(0, 500) || '(no description)', r.reference?.slice(0, 120) ?? null, r2(r.amount), r.balance ?? null, batch, hash],
    );
    if (ins) added++;
    else skipped++;
  }
  await ctx.tx.query(`update bank_accounts set last_statement_date = greatest(coalesce(last_statement_date, '1900-01-01'), (select max(txn_date) from bank_transactions where tenant_id = $1 and bank_account_id = $2)) where tenant_id = $1 and id = $2`, [ctx.tenantId, b.id]);
  const auto = await applyRules(ctx, b.id);
  return { added, skipped, autoCategorized: auto.categorized, autoMatched: (await autoMatch(ctx, b.id)).matched };
}

export async function transactions(ctx: RecordCtx, bankAccountId: string, status: string, limit = 200) {
  await bankAccount(ctx, bankAccountId);
  return ctx.tx.query(
    `select t.*, t.amount::float8 as amount, t.balance::float8 as balance, j.number as journal_number, j.source_type, j.source_id
       from bank_transactions t left join journals j on j.tenant_id = t.tenant_id and j.id = t.journal_id
      where t.tenant_id = $1 and t.bank_account_id = $2 and ($3 = 'all' or t.status = $3) order by t.txn_date desc, t.created_at desc limit $4`,
    [ctx.tenantId, bankAccountId, status, limit],
  );
}

/** Ledger lines on the account with the same amount and direction, near the date, not yet matched. */
export async function suggestions(ctx: RecordCtx, txnId: string) {
  const t = await ctx.tx.one<{ bank_account_id: string; txn_date: Date; amount: string }>(`select bank_account_id, txn_date, amount from bank_transactions where tenant_id = $1 and id = $2`, [ctx.tenantId, txnId]);
  if (!t) throw notFound();
  const b = await bankAccount(ctx, t.bank_account_id);
  const amt = Number(t.amount);
  return ctx.tx.query(
    `select l.id as line_id, l.entry_date, l.debit::float8 as debit, l.credit::float8 as credit, j.id as journal_id, j.number, j.source_type, j.source_id, j.reference, j.narration,
            abs(l.entry_date - $5::date) as days
       from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      where l.tenant_id = $1 and l.account_id = $2 and l.posted and l.bank_txn_id is null and l.reconciliation_id is null
        and (case when $3::numeric > 0 then l.debit else l.credit end) = $4::numeric and abs(l.entry_date - $5::date) <= 15
      order by days, l.entry_date limit 10`,
    [ctx.tenantId, b.gl_account_id, amt, Math.abs(amt), d10(t.txn_date)],
  );
}

export async function matchTxn(ctx: RecordCtx, txnId: string, lineId: string) {
  const t = await ctx.tx.one<{ bank_account_id: string; amount: string; status: string }>(`select bank_account_id, amount, status from bank_transactions where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, txnId]);
  if (!t) throw notFound();
  if (t.status !== 'unmatched') throw badRequest('This statement line is already handled');
  const b = await bankAccount(ctx, t.bank_account_id);
  const l = await ctx.tx.one<{ journal_id: string; account_id: string; debit: string; credit: string; bank_txn_id: string | null; posted: boolean }>(
    `select journal_id, account_id, debit, credit, bank_txn_id, posted from journal_lines where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, lineId],
  );
  if (!l || !l.posted || l.account_id !== b.gl_account_id) throw badRequest('That ledger line is not on this account');
  if (l.bank_txn_id) throw badRequest('That ledger line is already matched');
  const amt = Number(t.amount);
  if ((amt > 0 ? Number(l.debit) : Number(l.credit)) !== Math.abs(amt)) throw badRequest('The amounts do not match');
  await ctx.tx.query(`update journal_lines set bank_txn_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, lineId, txnId]);
  await ctx.tx.query(`update bank_transactions set status = 'matched', journal_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, txnId, l.journal_id]);
}

/** Posts the statement line against another account (bank charges, interest, a receipt from a customer…). */
export async function categorize(ctx: RecordCtx, txnId: string, input: { accountId: string; partyType?: 'customer' | 'vendor' | null; partyId?: string | null; description?: string | null }) {
  const t = await ctx.tx.one<{ bank_account_id: string; amount: string; status: string; txn_date: Date; description: string; reference: string | null }>(
    `select bank_account_id, amount, status, txn_date, description, reference from bank_transactions where tenant_id = $1 and id = $2 for update`,
    [ctx.tenantId, txnId],
  );
  if (!t) throw notFound();
  if (t.status !== 'unmatched') throw badRequest('This statement line is already handled');
  const b = await bankAccount(ctx, t.bank_account_id);
  const acc = await ctx.tx.one<{ subtype: string; is_active: boolean }>(`select subtype, is_active from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.accountId]);
  if (!acc || !acc.is_active) throw badRequest('Account not found');
  if (input.accountId === b.gl_account_id) throw badRequest('Choose a different account');
  if (['accounts_receivable', 'accounts_payable'].includes(acc.subtype) && !input.partyId) throw badRequest('Choose the customer or vendor for a receivable / payable');
  if (input.partyId) {
    const table = input.partyType === 'vendor' ? 'vendors' : 'accounts';
    if (!(await ctx.tx.one(`select 1 from ${table} where tenant_id = $1 and id = $2`, [ctx.tenantId, input.partyId]))) throw badRequest('Customer or vendor not found');
  }
  const amt = Math.abs(Number(t.amount));
  const inflow = Number(t.amount) > 0;
  const party = input.partyId ? { partyType: input.partyType ?? 'customer', partyId: input.partyId } : {};
  const jid = await postJournal(ctx.tx, ctx.tenantId, {
    date: d10(t.txn_date),
    sourceType: 'bank',
    sourceId: txnId,
    reference: t.reference,
    narration: (input.description ?? t.description).slice(0, 500),
    lines: inflow
      ? [{ accountId: b.gl_account_id, debit: amt }, { accountId: input.accountId, credit: amt, ...party }]
      : [{ accountId: input.accountId, debit: amt, ...party }, { accountId: b.gl_account_id, credit: amt }],
  });
  await ctx.tx.query(`update journal_lines set bank_txn_id = $3 where tenant_id = $1 and journal_id = $2 and account_id = $4`, [ctx.tenantId, jid, txnId, b.gl_account_id]);
  await ctx.tx.query(`update bank_transactions set status = 'categorized', journal_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, txnId, jid]);
  return { journalId: jid };
}

/** Undoes a match, a categorisation or an exclusion (categorised entries are voided). */
export async function undoTxn(ctx: RecordCtx, txnId: string) {
  const t = await ctx.tx.one<{ status: string; journal_id: string | null }>(`select status, journal_id from bank_transactions where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, txnId]);
  if (!t) throw notFound();
  const cleared = await ctx.tx.one(
    `select 1 from journal_lines where tenant_id = $1 and reconciliation_id is not null and (bank_txn_id = $2 or ($3::text = 'categorized' and journal_id = $4::uuid)) limit 1`,
    [ctx.tenantId, txnId, t.status, t.journal_id],
  );
  if (cleared) throw badRequest('This line is reconciled; undo the reconciliation first');
  await ctx.tx.query(`update journal_lines set bank_txn_id = null where tenant_id = $1 and bank_txn_id = $2`, [ctx.tenantId, txnId]);
  if (t.status === 'categorized') await voidSource(ctx.tx, ctx.tenantId, 'bank', txnId, 'Statement line un-categorised');
  await ctx.tx.query(`update bank_transactions set status = 'unmatched', journal_id = null where tenant_id = $1 and id = $2`, [ctx.tenantId, txnId]);
}

export async function excludeTxn(ctx: RecordCtx, txnId: string) {
  const r = await ctx.tx.one(`update bank_transactions set status = 'excluded' where tenant_id = $1 and id = $2 and status = 'unmatched' returning id`, [ctx.tenantId, txnId]);
  if (!r) throw badRequest('Only unmatched lines can be excluded');
}

/** Rules: description contains text (and direction) → categorise against an account. */
export async function applyRules(ctx: RecordCtx, bankAccountId: string) {
  const rules = await ctx.tx.query<{ id: string; contains: string; direction: string; account_id: string; party_type: 'customer' | 'vendor' | null; party_id: string | null; name: string }>(
    `select id, contains, direction, account_id, party_type, party_id, name from bank_rules where tenant_id = $1 and is_active and (bank_account_id is null or bank_account_id = $2) order by priority, created_at`,
    [ctx.tenantId, bankAccountId],
  );
  if (!rules.length) return { categorized: 0 };
  const open = await ctx.tx.query<{ id: string; description: string; amount: string }>(`select id, description, amount from bank_transactions where tenant_id = $1 and bank_account_id = $2 and status = 'unmatched' order by txn_date limit 1000`, [ctx.tenantId, bankAccountId]);
  let categorized = 0;
  for (const t of open) {
    const desc = t.description.toLowerCase();
    const rule = rules.find((r) => desc.includes(r.contains.toLowerCase()) && (r.direction === 'any' || (r.direction === 'in') === Number(t.amount) > 0));
    if (!rule) continue;
    await categorize(ctx, t.id, { accountId: rule.account_id, partyType: rule.party_type, partyId: rule.party_id, description: `${t.description} (rule: ${rule.name})` });
    categorized++;
  }
  return { categorized };
}

/** Matches lines that have exactly one candidate with the same amount within 3 days. */
export async function autoMatch(ctx: RecordCtx, bankAccountId: string) {
  const open = await ctx.tx.query<{ id: string }>(`select id from bank_transactions where tenant_id = $1 and bank_account_id = $2 and status = 'unmatched' order by txn_date limit 500`, [ctx.tenantId, bankAccountId]);
  let matched = 0;
  for (const t of open) {
    const s = (await suggestions(ctx, t.id)).filter((x) => Number((x as { days: number }).days) <= 3);
    if (s.length === 1) {
      await matchTxn(ctx, t.id, String((s[0] as { line_id: string }).line_id));
      matched++;
    }
  }
  return { matched };
}

/** Moves money between two of your own accounts. */
export async function transfer(ctx: RecordCtx, input: { fromId: string; toId: string; amount: number; date: string; reference?: string | null; narration?: string | null }) {
  if (input.fromId === input.toId) throw badRequest('Choose two different accounts');
  const rows = await ctx.tx.query<{ id: string; subtype: string }>(`select id, subtype from gl_accounts where tenant_id = $1 and id = any($2::uuid[]) and is_active`, [ctx.tenantId, [input.fromId, input.toId]]);
  if (rows.length !== 2 || rows.some((r) => !['bank', 'cash', 'credit_card'].includes(r.subtype))) throw badRequest('Transfers are between bank, cash and card accounts');
  return postJournal(ctx.tx, ctx.tenantId, {
    date: input.date,
    sourceType: 'transfer',
    reference: input.reference ?? null,
    narration: input.narration ?? 'Transfer between accounts',
    lines: [
      { accountId: input.toId, debit: r2(input.amount) },
      { accountId: input.fromId, credit: r2(input.amount) },
    ],
  });
}

/** Ledger lines on the account not yet reconciled, up to a date. */
export async function unreconciled(ctx: RecordCtx, bankAccountId: string, upTo: string) {
  const b = await bankAccount(ctx, bankAccountId);
  const lines = await ctx.tx.query(
    `select l.id, l.entry_date, l.debit::float8 as debit, l.credit::float8 as credit, l.bank_txn_id, j.number, j.source_type, j.source_id, j.reference, j.narration
       from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
      where l.tenant_id = $1 and l.account_id = $2 and l.posted and l.reconciliation_id is null and l.entry_date <= $3::date order by l.entry_date, l.id limit 2000`,
    [ctx.tenantId, b.gl_account_id, upTo],
  );
  const cleared = await ctx.tx.one<{ v: number }>(`select coalesce(sum(debit - credit), 0)::float8 as v from journal_lines where tenant_id = $1 and account_id = $2 and posted and reconciliation_id is not null`, [ctx.tenantId, b.gl_account_id]);
  return { lines, clearedBalance: cleared?.v ?? 0 };
}

export async function reconcile(ctx: RecordCtx, bankAccountId: string, input: { statementDate: string; closingBalance: number; lineIds: string[] }) {
  const b = await bankAccount(ctx, bankAccountId);
  const sign = b.kind === 'credit_card' ? -1 : 1;
  const prev = await ctx.tx.one<{ v: number }>(`select coalesce(sum(debit - credit), 0)::float8 as v from journal_lines where tenant_id = $1 and account_id = $2 and posted and reconciliation_id is not null`, [ctx.tenantId, b.gl_account_id]);
  const sel = input.lineIds.length
    ? await ctx.tx.query<{ id: string; d: string; c: string; entry_date: Date }>(
        `select id, debit as d, credit as c, entry_date from journal_lines where tenant_id = $1 and account_id = $2 and posted and reconciliation_id is null and id = any($3::uuid[]) for update`,
        [ctx.tenantId, b.gl_account_id, input.lineIds],
      )
    : [];
  if (sel.length !== new Set(input.lineIds).size) throw badRequest('Some lines are not on this account or are already reconciled');
  if (sel.some((l) => d10(l.entry_date) > input.statementDate)) throw badRequest('Lines after the statement date cannot be cleared');
  const cleared = r2((prev?.v ?? 0) + sel.reduce((s, l) => s + Number(l.d) - Number(l.c), 0));
  const target = r2(input.closingBalance * sign);
  if (Math.abs(cleared - target) > 0.009) throw badRequest(`The cleared balance (${(cleared * sign).toFixed(2)}) does not equal the statement balance (${input.closingBalance.toFixed(2)}); difference ${((target - cleared) * sign).toFixed(2)}`);
  const r = await ctx.tx.one<{ id: string }>(`insert into bank_reconciliations (tenant_id, bank_account_id, statement_date, closing_balance, cleared_balance) values ($1,$2,$3,$4,$5) returning id`, [
    ctx.tenantId, b.id, input.statementDate, input.closingBalance, cleared * sign,
  ]);
  if (sel.length) await ctx.tx.query(`update journal_lines set reconciliation_id = $3 where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, sel.map((l) => l.id), r!.id]);
  return { id: r!.id, cleared: sel.length };
}

export async function undoReconciliation(ctx: RecordCtx, bankAccountId: string) {
  const b = await bankAccount(ctx, bankAccountId);
  const last = await ctx.tx.one<{ id: string }>(`select id from bank_reconciliations where tenant_id = $1 and bank_account_id = $2 and status = 'completed' order by statement_date desc, created_at desc limit 1`, [ctx.tenantId, b.id]);
  if (!last) throw badRequest('Nothing to undo');
  await ctx.tx.query(`update journal_lines set reconciliation_id = null where tenant_id = $1 and reconciliation_id = $2`, [ctx.tenantId, last.id]);
  await ctx.tx.query(`update bank_reconciliations set status = 'undone' where tenant_id = $1 and id = $2`, [ctx.tenantId, last.id]);
  return { undone: last.id };
}

export { sys };

/* ───────────── rules ───────────── */

export async function listRules(ctx: RecordCtx) {
  return ctx.tx.query(
    `select r.id, r.name, r.bank_account_id, r.direction, r.contains, r.account_id, a.name as account, r.party_type, r.party_id, r.priority, r.is_active
       from bank_rules r join gl_accounts a on a.tenant_id = r.tenant_id and a.id = r.account_id where r.tenant_id = $1 order by r.priority, r.created_at`,
    [ctx.tenantId],
  );
}

export interface RuleInput {
  name: string;
  bankAccountId?: string | null;
  direction: 'in' | 'out' | 'any';
  contains: string;
  accountId: string;
  partyType?: 'customer' | 'vendor' | null;
  partyId?: string | null;
  priority?: number;
  isActive?: boolean;
}

export async function saveRule(ctx: RecordCtx, id: string | null, input: RuleInput) {
  const acc = await ctx.tx.one<{ subtype: string; is_active: boolean }>(`select subtype, is_active from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, input.accountId]);
  if (!acc || !acc.is_active) throw badRequest('Choose an active account');
  if (input.bankAccountId) await bankAccount(ctx, input.bankAccountId);
  if (input.partyId) {
    const ok = await ctx.tx.one(`select 1 from ${input.partyType === 'vendor' ? 'vendors' : 'accounts'} where tenant_id = $1 and id = $2`, [ctx.tenantId, input.partyId]);
    if (!ok || !input.partyType) throw badRequest('The party does not exist');
  }
  if (['accounts_receivable', 'accounts_payable'].includes(acc.subtype) && !input.partyId) throw badRequest('A rule posting to receivables or payables needs a customer or vendor');
  const vals = [input.name, input.bankAccountId ?? null, input.direction, input.contains.trim(), input.accountId, input.partyType ?? null, input.partyId ?? null, input.priority ?? 100, input.isActive ?? true];
  if (id) {
    const r = await ctx.tx.one<{ id: string }>(
      `update bank_rules set name = $3, bank_account_id = $4, direction = $5, contains = $6, account_id = $7, party_type = $8, party_id = $9, priority = $10, is_active = $11 where tenant_id = $1 and id = $2 returning id`,
      [ctx.tenantId, id, ...vals],
    );
    if (!r) throw notFound('Rule not found');
    return r;
  }
  return ctx.tx.one<{ id: string }>(
    `insert into bank_rules (tenant_id, name, bank_account_id, direction, contains, account_id, party_type, party_id, priority, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, ...vals],
  );
}

export async function deleteRule(ctx: RecordCtx, id: string) {
  await ctx.tx.query(`delete from bank_rules where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
}
