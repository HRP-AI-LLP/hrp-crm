/**
 * The workspace's own money: owners, partners and directors (with their personal accounts) and the
 * company's own bank accounts. A bank line whose narration names one of them is a transfer:
 *
 *  - a person's mobile number (as UPI prints it), UPI id, account number or name → money in from them /
 *    out to them, booked to their own ledger (partner's current account, loan from director, or the
 *    proprietor's capital and drawings), never to sales, expenses or a new customer or vendor;
 *  - the account number or UPI id of another of the company's bank accounts → a transfer between the
 *    company's own accounts (a contra entry). The line on the other account then matches the same entry.
 *
 * Lines booked some other way before an identifier was added can be re-booked, with approval.
 */
import { z } from 'zod';
import { badRequest, conflict, notFound } from '../../lib/errors';
import { voidPayment } from '../billing';
import type { RecordCtx, RecordEvent } from '../records';
import { undoTxn } from './banking';
import { voidVendorPayment } from './bills';
import { assertBooksAdmin, sys } from './ledger';

export type IdentKind = 'mobile' | 'upi' | 'account' | 'name';
export type Role = 'partner' | 'director' | 'proprietor' | 'other';

export interface OwnIdent {
  id: string;
  person_id: string | null;
  bank_account_id: string | null;
  kind: IdentKind;
  value: string;
  match_key: string;
}
export interface OwnPerson {
  id: string;
  name: string;
  role: Role;
  account_in: string;
  account_out: string;
  is_active: boolean;
}
export interface OwnBank {
  id: string;
  gl_account_id: string;
  name: string;
}
export interface Own {
  persons: OwnPerson[];
  idents: OwnIdent[];
  banks: OwnBank[];
}
export type OwnHit =
  | { type: 'person'; person: OwnPerson; ident: OwnIdent }
  | { type: 'company'; bank: OwnBank; ident: OwnIdent };

/* ───────────────────────── identifiers ───────────────────────── */

const squash = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** The comparable form of an identifier, or an error saying what is wrong with it. */
export function matchKey(kind: IdentKind, value: string): string {
  const v = value.trim();
  switch (kind) {
    case 'mobile': {
      const d = v.replace(/\D/g, '').replace(/^(?:91|0)(?=\d{10}$)/, '');
      if (!/^[6-9]\d{9}$/.test(d)) throw badRequest(`“${v}” is not a 10-digit Indian mobile number`);
      return d;
    }
    case 'upi': {
      const u = v.toLowerCase().replace(/\s+/g, '');
      if (!/^[a-z0-9._-]{2,}@[a-z0-9.]{2,}$/.test(u)) throw badRequest(`“${v}” is not a UPI id (name@bank)`);
      return u;
    }
    case 'account': {
      const d = v.replace(/[\s-]/g, '').toUpperCase();
      if (!/^[0-9]{6,20}$/.test(d)) throw badRequest(`“${v}” is not an account number (6 to 20 digits)`);
      return d;
    }
    case 'name': {
      const n = squash(v);
      if (n.replace(/ /g, '').length < 4) throw badRequest('Give the name as the bank prints it (at least 4 letters)');
      return n;
    }
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does a narration name this identifier? Digits must stand alone (not inside a longer number). */
export function identMatches(ident: Pick<OwnIdent, 'kind' | 'match_key'>, text: string): boolean {
  switch (ident.kind) {
    case 'mobile':
      return new RegExp(`(?<![0-9])(?:\\+?91[\\s-]?|0)?${ident.match_key}(?![0-9])`).test(text);
    case 'upi':
      return text.toLowerCase().replace(/\s+/g, '').includes(ident.match_key);
    case 'account':
      return new RegExp(`(?<![0-9])${escapeRe(ident.match_key)}(?![0-9])`).test(text.replace(/(\d)[\s-](?=\d)/g, '$1'));
    case 'name':
      return ` ${squash(text)} `.includes(` ${ident.match_key} `);
  }
}

/** How sure a match is: numbers and UPI ids are exact, a name could be someone else's. */
export const identConfidence = (kind: IdentKind) => (kind === 'name' ? 0.9 : 0.99);

export async function loadOwn(ctx: RecordCtx): Promise<Own> {
  const persons = await ctx.tx.query<OwnPerson>(`select id, name, role, account_in, account_out, is_active from acct_persons where tenant_id = $1 order by created_at`, [ctx.tenantId]);
  const idents = await ctx.tx.query<OwnIdent>(`select id, person_id, bank_account_id, kind, value, match_key from acct_identifiers where tenant_id = $1 order by created_at`, [ctx.tenantId]);
  const banks = await ctx.tx.query<OwnBank>(
    `select b.id, b.gl_account_id, a.name from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where b.tenant_id = $1 and b.is_active`,
    [ctx.tenantId],
  );
  return { persons, idents, banks };
}

/**
 * The own-account a bank line names, if any. Numbers and UPI ids win over names; a company account
 * naming itself (its own number printed on its own statement) doesn't count.
 */
export function findOwn(own: Own, line: { bank_account_id: string; description: string; reference?: string | null; counterparty?: string | null }): OwnHit | null {
  if (!own.idents.length) return null;
  const text = [line.description, line.reference, line.counterparty].filter(Boolean).join(' ');
  const order: IdentKind[] = ['mobile', 'upi', 'account', 'name'];
  for (const kind of order) {
    for (const ident of own.idents) {
      if (ident.kind !== kind || !identMatches(ident, text)) continue;
      if (ident.person_id) {
        const person = own.persons.find((p) => p.id === ident.person_id && p.is_active);
        if (person) return { type: 'person', person, ident };
      } else if (ident.bank_account_id && ident.bank_account_id !== line.bank_account_id) {
        const bank = own.banks.find((b) => b.id === ident.bank_account_id);
        if (bank) return { type: 'company', bank, ident };
      }
    }
  }
  return null;
}

/* ───────────────────────── people and their ledgers ───────────────────────── */

/** From the PAN (4th letter, also the 6th character of the GSTIN): F firm / LLP, C company, P proprietor. */
async function constitution(ctx: RecordCtx): Promise<'F' | 'C' | 'P' | null> {
  const t = await ctx.tx.one<{ settings: any }>(`select settings from tenants where id = $1`, [ctx.tenantId]);
  const c = t?.settings?.company ?? {};
  const pan = String(c.pan ?? '').toUpperCase();
  const gstin = String(c.gstin ?? '').toUpperCase();
  const ch = /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? pan[3] : /^\d{2}[A-Z]{5}\d{4}[A-Z]/.test(gstin) ? gstin[5] : null;
  return ch === 'F' || ch === 'C' || ch === 'P' ? ch : null;
}

export async function defaultRole(ctx: RecordCtx): Promise<Role> {
  const c = await constitution(ctx);
  return c === 'C' ? 'director' : c === 'P' ? 'proprietor' : 'partner';
}

async function ledgerNamed(ctx: RecordCtx, name: string, type: string, subtype: string, description: string) {
  const ex = await ctx.tx.one<{ id: string }>(`select id from gl_accounts where tenant_id = $1 and lower(name) = lower($2)`, [ctx.tenantId, name]);
  if (ex) return ex.id;
  return (await ctx.tx.one<{ id: string }>(`insert into gl_accounts (tenant_id, name, type, subtype, description) values ($1,$2,$3,$4,$5) returning id`, [ctx.tenantId, name.slice(0, 150), type, subtype, description.slice(0, 500)]))!.id;
}

/** The ledgers a person's money goes to: one running account for a partner or director, capital and drawings for a proprietor. */
async function ledgersFor(ctx: RecordCtx, name: string, role: Role): Promise<{ in: string; out: string }> {
  switch (role) {
    case 'proprietor':
      return { in: await sys(ctx.tx, ctx.tenantId, 'capital'), out: await sys(ctx.tx, ctx.tenantId, 'drawings') };
    case 'partner': {
      const id = await ledgerNamed(ctx, `${name} — partner's current account`, 'equity', 'equity', `Money ${name} brings into and takes out of the firm`);
      return { in: id, out: id };
    }
    case 'director': {
      const id = await ledgerNamed(ctx, `Loan from ${name} (director)`, 'liability', 'other_liability', `Money ${name} lends to and takes back from the company`);
      return { in: id, out: id };
    }
    default: {
      const id = await ledgerNamed(ctx, `${name} — personal account`, 'liability', 'current_liability', `Money moved between the business and ${name}'s personal accounts`);
      return { in: id, out: id };
    }
  }
}

async function assertLedger(ctx: RecordCtx, id: string) {
  const a = await ctx.tx.one<{ subtype: string; is_active: boolean }>(`select subtype, is_active from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (!a || !a.is_active) throw badRequest('Ledger account not found');
  if (['bank', 'cash', 'credit_card', 'accounts_receivable', 'accounts_payable'].includes(a.subtype)) throw badRequest('Choose a capital, current-account or loan ledger, not a bank, receivable or payable');
}

const identInput = z.object({ kind: z.enum(['mobile', 'upi', 'account', 'name']), value: z.string().trim().min(2).max(120) });

export const personSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['partner', 'director', 'proprietor', 'other']).optional(),
  accountIn: z.string().uuid().nullish(),
  accountOut: z.string().uuid().nullish(),
  isActive: z.boolean().optional(),
  identifiers: z.array(identInput).max(30).default([]),
});

export const bankIdentsSchema = z.object({ identifiers: z.array(identInput).max(20) });

async function writeIdents(ctx: RecordCtx, owner: { personId?: string; bankAccountId?: string }, list: z.infer<typeof identInput>[]) {
  const keyed = new Map<string, { kind: IdentKind; value: string; key: string }>();
  for (const i of list) {
    const key = matchKey(i.kind, i.value);
    keyed.set(`${i.kind}:${key}`, { kind: i.kind, value: i.value.trim(), key });
  }
  // an identifier names one owner only
  for (const i of keyed.values()) {
    const other = await ctx.tx.one<{ person: string | null; bank: string | null }>(
      `select p.name as person, a.name as bank from acct_identifiers x
         left join acct_persons p on p.tenant_id = x.tenant_id and p.id = x.person_id
         left join bank_accounts b on b.tenant_id = x.tenant_id and b.id = x.bank_account_id
         left join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id
        where x.tenant_id = $1 and x.kind = $2 and x.match_key = $3
          and x.person_id is distinct from $4::uuid and x.bank_account_id is distinct from $5::uuid`,
      [ctx.tenantId, i.kind, i.key, owner.personId ?? null, owner.bankAccountId ?? null],
    );
    if (other) throw conflict(`${i.value} is already listed for ${other.person ?? other.bank}`);
  }
  await ctx.tx.query(`delete from acct_identifiers where tenant_id = $1 and ${owner.personId ? 'person_id' : 'bank_account_id'} = $2`, [ctx.tenantId, owner.personId ?? owner.bankAccountId]);
  for (const i of keyed.values())
    await ctx.tx.query(`insert into acct_identifiers (tenant_id, person_id, bank_account_id, kind, value, match_key) values ($1,$2,$3,$4,$5,$6)`, [
      ctx.tenantId, owner.personId ?? null, owner.bankAccountId ?? null, i.kind, i.value, i.key,
    ]);
}

/** Pending suggestions on lines an identifier now explains are out of date. */
async function staleProposals(ctx: RecordCtx) {
  const own = await loadOwn(ctx);
  if (!own.idents.length) return;
  const pending = await ctx.tx.query<{ id: string; bank_account_id: string; description: string; reference: string | null; counterparty: string | null; source: string }>(
    `select p.id, t.bank_account_id, t.description, t.reference, t.counterparty, p.source from acct_proposals p join bank_transactions t on t.tenant_id = p.tenant_id and t.id = p.bank_txn_id
      where p.tenant_id = $1 and p.status = 'pending' and t.status = 'unmatched'`,
    [ctx.tenantId],
  );
  const ids = pending.filter((p) => p.source !== 'own' && findOwn(own, p)).map((p) => p.id);
  if (ids.length) await ctx.tx.query(`update acct_proposals set status = 'stale' where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, ids]);
}

export async function savePerson(ctx: RecordCtx, id: string | null, input: z.infer<typeof personSchema>) {
  await assertBooksAdmin(ctx);
  const cur = id ? await ctx.tx.one<OwnPerson>(`select id, name, role, account_in, account_out, is_active from acct_persons where tenant_id = $1 and id = $2`, [ctx.tenantId, id]) : null;
  if (id && !cur) throw notFound();
  const role = input.role ?? cur?.role ?? (await defaultRole(ctx));
  let accIn = input.accountIn ?? null;
  let accOut = input.accountOut ?? null;
  if (accIn) await assertLedger(ctx, accIn);
  if (accOut) await assertLedger(ctx, accOut);
  if (!accIn || !accOut) {
    const roleChanged = !cur || cur.role !== role || cur.name !== input.name;
    const d = roleChanged ? await ledgersFor(ctx, input.name, role) : { in: cur!.account_in, out: cur!.account_out };
    accIn ??= d.in;
    accOut ??= d.out;
  }
  const pid = cur
    ? (await ctx.tx.query(`update acct_persons set name = $3, role = $4, account_in = $5, account_out = $6, is_active = $7 where tenant_id = $1 and id = $2`, [
        ctx.tenantId, cur.id, input.name, role, accIn, accOut, input.isActive ?? cur.is_active,
      ]),
      cur.id)
    : (await ctx.tx.one<{ id: string }>(`insert into acct_persons (tenant_id, name, role, account_in, account_out, is_active) values ($1,$2,$3,$4,$5,$6) returning id`, [
        ctx.tenantId, input.name, role, accIn, accOut, input.isActive ?? true,
      ]))!.id;
  await writeIdents(ctx, { personId: pid }, input.identifiers);
  await staleProposals(ctx);
  return { id: pid };
}

export async function deletePerson(ctx: RecordCtx, id: string) {
  await assertBooksAdmin(ctx);
  const r = await ctx.tx.one(`delete from acct_persons where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id]);
  if (!r) throw notFound();
}

export async function saveBankIdents(ctx: RecordCtx, bankAccountId: string, input: z.infer<typeof bankIdentsSchema>) {
  await assertBooksAdmin(ctx);
  if (!(await ctx.tx.one(`select 1 from bank_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, bankAccountId]))) throw notFound('Bank account not found');
  await writeIdents(ctx, { bankAccountId }, input.identifiers);
  await staleProposals(ctx);
  return { ok: true };
}

/** People, the company's bank accounts, and what identifies each. */
export async function listOwn(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  const own = await loadOwn(ctx);
  const names = new Map(
    (await ctx.tx.query<{ id: string; name: string }>(`select id, name from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, own.persons.flatMap((p) => [p.account_in, p.account_out])])).map((a) => [a.id, a.name]),
  );
  const banks = await ctx.tx.query<{ id: string; name: string; bank_name: string | null; account_last4: string | null; kind: string }>(
    `select b.id, a.name, b.bank_name, b.account_last4, b.kind from bank_accounts b join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id where b.tenant_id = $1 and b.is_active and b.kind in ('bank','wallet') order by a.name`,
    [ctx.tenantId],
  );
  const pick = (i: OwnIdent) => ({ id: i.id, kind: i.kind, value: i.value });
  return {
    defaultRole: await defaultRole(ctx),
    persons: own.persons.map((p) => ({ ...p, account_in_name: names.get(p.account_in) ?? null, account_out_name: names.get(p.account_out) ?? null, identifiers: own.idents.filter((i) => i.person_id === p.id).map(pick) })),
    banks: banks.map((b) => ({ ...b, identifiers: own.idents.filter((i) => i.bank_account_id === b.id).map(pick) })),
  };
}

/* ───────────────────────── lines booked another way ───────────────────────── */

const ownLedgers = (own: Own, hit: OwnHit, inflow: boolean) => (hit.type === 'person' ? [inflow ? hit.person.account_in : hit.person.account_out] : [hit.bank.gl_account_id]);

/**
 * Lines that name an own account but were booked to something else (before the identifier was added,
 * or by hand). Lines matched to a customer receipt or a vendor payment the desk recorded as an advance
 * can be re-booked (the advance is voided); other matches and reconciled lines are only listed.
 */
export async function misbooked(ctx: RecordCtx) {
  await assertBooksAdmin(ctx);
  const own = await loadOwn(ctx);
  if (!own.idents.length) return { lines: [] };
  const rows = await ctx.tx.query<{ id: string; bank_account_id: string; bank: string; txn_date: string; description: string; reference: string | null; counterparty: string | null; amount: number; status: string; journal_id: string | null }>(
    `select t.id, t.bank_account_id, a.name as bank, to_char(t.txn_date, 'YYYY-MM-DD') as txn_date, t.description, t.reference, t.counterparty, t.amount::float8 as amount, t.status, t.journal_id
       from bank_transactions t join bank_accounts b on b.tenant_id = t.tenant_id and b.id = t.bank_account_id join gl_accounts a on a.tenant_id = b.tenant_id and a.id = b.gl_account_id
      where t.tenant_id = $1 and t.status in ('categorized', 'matched', 'excluded') order by t.txn_date desc limit 20000`,
    [ctx.tenantId],
  );
  const out = [];
  for (const t of rows) {
    const hit = findOwn(own, t);
    if (!hit) continue;
    const inflow = t.amount > 0;
    const want = ownLedgers(own, hit, inflow);
    // where the line went: the other side of the entry that holds it
    const other = await ctx.tx.query<{ account_id: string; name: string; source_type: string; source_id: string | null; reconciled: boolean }>(
      `select l2.account_id, g.name, j.source_type, j.source_id::text as source_id,
              exists (select 1 from journal_lines r where r.tenant_id = j.tenant_id and r.journal_id = j.id and r.reconciliation_id is not null) as reconciled
         from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
         join journal_lines l2 on l2.tenant_id = j.tenant_id and l2.journal_id = j.id and l2.id <> l.id
         join gl_accounts g on g.tenant_id = l2.tenant_id and g.id = l2.account_id
        where l.tenant_id = $1 and j.status = 'posted' and (l.bank_txn_id = $2 or ($3::uuid is not null and j.id = $3::uuid and l.account_id = (select gl_account_id from bank_accounts where tenant_id = $1 and id = $4)))`,
      [ctx.tenantId, t.id, t.status === 'categorized' ? t.journal_id : null, t.bank_account_id],
    );
    if (t.status !== 'excluded' && other.length && other.every((o) => want.includes(o.account_id))) continue;
    const src = other[0];
    const advance =
      t.status === 'matched' && src && (src.source_type === 'payment' || src.source_type === 'vendor_payment')
        ? await ctx.tx.one<{ number: string | null; allocated: number }>(
            src.source_type === 'payment'
              ? `select payment_number as number, amount_allocated::float8 as allocated from payments where tenant_id = $1 and id = $2 and status <> 'void'`
              : `select payment_number as number, amount_allocated::float8 as allocated from vendor_payments where tenant_id = $1 and id = $2 and status <> 'void'`,
            [ctx.tenantId, src.source_id],
          )
        : null;
    let can = true;
    let why: string | null = null;
    if (other.some((o) => o.reconciled)) [can, why] = [false, 'Reconciled: undo that reconciliation first'];
    else if (t.status === 'matched' && !advance) [can, why] = [false, src ? `Matched to a ${src.source_type.replace(/_/g, ' ')} entry: check it by hand` : 'Matched to an entry: check it by hand'];
    else if (advance && advance.allocated > 0.005) [can, why] = [false, `${advance.number ?? 'The payment'} is applied to ${src!.source_type === 'payment' ? 'invoices' : 'bills'}: check it by hand`];
    out.push({
      id: t.id,
      bank: t.bank,
      date: t.txn_date,
      description: t.description,
      amount: t.amount,
      status: t.status,
      bookedTo: t.status === 'excluded' ? 'Excluded' : advance ? `${src!.source_type === 'payment' ? 'Customer receipt' : 'Vendor payment'} ${advance.number ?? ''}`.trim() : [...new Set(other.map((o) => o.name))].join(', ') || '—',
      owner: hit.type === 'person' ? hit.person.name : hit.bank.name,
      ownerType: hit.type,
      identifier: hit.ident.value,
      canRebook: can,
      why,
    });
  }
  return { lines: out };
}

/** Undoes how each chosen line was booked (voiding the desk's advance, if that was it) so the bookkeeper books it as an own transfer. */
export async function unbookForOwn(ctx: RecordCtx, txnIds: string[]) {
  await assertBooksAdmin(ctx);
  const ok = new Set(((await misbooked(ctx)).lines as { id: string; canRebook: boolean }[]).filter((l) => l.canRebook).map((l) => l.id));
  const events: RecordEvent[] = [];
  let undone = 0;
  const skipped: { id: string; error: string }[] = [];
  for (const id of txnIds) {
    if (!ok.has(id)) {
      skipped.push({ id, error: 'Not a line that can be re-booked' });
      continue;
    }
    await ctx.tx.query('savepoint own_unbook');
    try {
      const t = (await ctx.tx.one<{ status: string }>(`select status from bank_transactions where tenant_id = $1 and id = $2`, [ctx.tenantId, id]))!;
      if (t.status === 'excluded') await ctx.tx.query(`update bank_transactions set status = 'unmatched' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
      else {
        const src = await ctx.tx.one<{ source_type: string; source_id: string }>(
          `select j.source_type, j.source_id::text as source_id from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id where l.tenant_id = $1 and l.bank_txn_id = $2 and j.status = 'posted' limit 1`,
          [ctx.tenantId, id],
        );
        await undoTxn(ctx, id);
        if (t.status === 'matched' && src?.source_type === 'payment') events.push(...(await voidPayment(ctx, src.source_id, 'Money from our own account, not a customer receipt')));
        if (t.status === 'matched' && src?.source_type === 'vendor_payment') events.push(...(await voidVendorPayment(ctx, src.source_id, 'Money to our own account, not a vendor payment')));
      }
      await ctx.tx.query(`update acct_proposals set status = 'stale' where tenant_id = $1 and bank_txn_id = $2 and status = 'pending'`, [ctx.tenantId, id]);
      await ctx.tx.query('release savepoint own_unbook');
      undone++;
    } catch (e) {
      await ctx.tx.query('rollback to savepoint own_unbook');
      skipped.push({ id, error: (e as Error).message });
    }
  }
  return { undone, skipped, events };
}
