/**
 * Deposits and guarantees given to customers: EMD for a bid, performance security (bank guarantee,
 * ePBG, FDR, DD, insurance surety bond), retention money withheld from bills, and other security
 * deposits. Each records the customer, project or order, instrument details, expiry and claim period,
 * and how much has been released or forfeited.
 *
 * Postings (when SanchalanOS keeps the books; every movement is its own journal, source "deposit"):
 *   placed  (online / DD / FDR / cash)    Dr EMD and performance security (customer)   Cr bank
 *   placed  (bank guarantee, with margin)  Dr Margin money against bank guarantees      Cr bank
 *   retention withheld on a receipt        posted with the receipt (Dr Retention money with customers)
 *   released                               Dr bank   Cr the deposit account (BG: the margin comes back)
 *   forfeited (LD recovered, BG invoked)   Dr Liquidated damages and penalties   Cr the deposit account
 *                                          (BG: the margin first, then the bank pays the rest)
 * A bank guarantee itself is a contingent liability: it is listed here, not in the ledger.
 *
 * Access: the books or billing admin area.
 */
import { hasAdmin } from '@synapse/shared';
import type { Tx } from '../../lib/db';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import type { RecordCtx } from '../records';
import { postingOn, postJournal, r2, sys, voidSource, type JLine } from './ledger';

export const DEPOSIT_KINDS = ['emd', 'performance_security', 'retention', 'security_deposit', 'other'] as const;
export const INSTRUMENTS = ['online', 'dd', 'fdr', 'cash', 'bank_guarantee', 'epbg', 'insurance_bond', 'withheld', 'exempt'] as const;
type Instrument = (typeof INSTRUMENTS)[number];

/** money actually with the customer */
const CASH: Instrument[] = ['online', 'dd', 'fdr', 'cash'];
/** a guarantee: no money with the customer, only (optionally) margin blocked by our bank */
const GUARANTEE: Instrument[] = ['bank_guarantee', 'epbg', 'insurance_bond'];

export function assertDepositAdmin(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (!hasAdmin(p, 'books') && !hasAdmin(p, 'billing')) throw forbidden('Deposits and guarantees need the books or billing permission');
}

/** Changes post journals when SanchalanOS keeps the books: then they are for books admins only. */
async function assertDepositWriter(ctx: RecordCtx) {
  assertDepositAdmin(ctx);
  if ((await postingOn(ctx.tx, ctx.tenantId)) && !hasAdmin(ctx.principal.permissions, 'books')) throw forbidden('SanchalanOS keeps the books: changing deposits needs the books permission');
}

function notBefore(date: string, issued: unknown) {
  if (date < String(issued).slice(0, 10)) throw badRequest('That date is before the deposit was given');
}

const today = () => new Date().toISOString().slice(0, 10);

async function bankAccount(tx: Tx, tenantId: string, id: string | null | undefined, required: boolean) {
  if (!id) {
    if (required) throw badRequest('Choose the bank or cash account');
    return null;
  }
  const a = await tx.one<{ subtype: string }>(`select subtype from gl_accounts where tenant_id = $1 and id = $2 and is_active`, [tenantId, id]);
  if (!a || !['bank', 'cash'].includes(a.subtype)) throw badRequest('Choose a bank or cash account');
  return id;
}

/** The ledger account a deposit sits in. */
async function depositLedger(tx: Tx, tenantId: string, instrument: string) {
  if (instrument === 'withheld') return sys(tx, tenantId, 'retention_receivable');
  if (GUARANTEE.includes(instrument as Instrument)) return sys(tx, tenantId, 'bg_margin');
  return sys(tx, tenantId, 'emd_deposits');
}

async function post(ctx: RecordCtx, eventId: string, date: string, reference: string, narration: string, lines: JLine[]) {
  if (!(await postingOn(ctx.tx, ctx.tenantId))) return;
  await postJournal(ctx.tx, ctx.tenantId, { date, sourceType: 'deposit', sourceId: eventId, reference, narration, lines });
}

async function addEvent(ctx: RecordCtx, depositId: string, e: { kind: string; date: string; amount?: number; margin?: number; bank?: string | null; newExpiry?: string | null; note?: string | null }) {
  const r = await ctx.tx.one<{ id: string }>(
    `insert into security_deposit_events (tenant_id, deposit_id, kind, event_date, amount, margin, bank_account, new_expiry, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, depositId, e.kind, e.date, r2(e.amount ?? 0), r2(e.margin ?? 0), e.bank ?? null, e.newExpiry ?? null, e.note?.slice(0, 500) ?? null],
  );
  return r!.id;
}

/** Margin still blocked with our bank for a guarantee. */
async function marginLeft(tx: Tx, tenantId: string, d: { id: string; margin_amount: string }) {
  const used = await tx.one<{ v: string }>(`select coalesce(sum(margin), 0) as v from security_deposit_events where tenant_id = $1 and deposit_id = $2 and kind in ('release', 'forfeit')`, [tenantId, d.id]);
  return r2(Number(d.margin_amount) - Number(used!.v));
}

export interface DepositInput {
  kind: (typeof DEPOSIT_KINDS)[number];
  instrument: Instrument;
  accountId: string;
  projectId?: string | null;
  salesOrderId?: string | null;
  dealId?: string | null;
  reference?: string | null;
  issuingBank?: string | null;
  amount: number;
  marginAmount?: number;
  issueDate?: string | null;
  expiryDate?: string | null;
  claimUntil?: string | null;
  paidFrom?: string | null;
  notes?: string | null;
  /** an amount from before the books start (or already in the opening balances): recorded, not posted */
  opening?: boolean;
}

export async function listDeposits(ctx: RecordCtx, q: { status?: string | null; accountId?: string | null; projectId?: string | null; expiringDays?: number | null }) {
  assertDepositAdmin(ctx);
  return ctx.tx.query(
    `select d.id, d.deposit_number, d.kind, d.instrument, d.account_id, a.name as customer, d.project_id, p.name as project, d.sales_order_id, o.order_number, d.deal_id,
            d.payment_id, d.reference, d.issuing_bank, d.amount::float8 as amount, d.margin_amount::float8 as margin_amount, d.issue_date, d.expiry_date, d.claim_until,
            d.released_amount::float8 as released_amount, d.forfeited_amount::float8 as forfeited_amount, (d.amount - d.released_amount - d.forfeited_amount)::float8 as held,
            d.status, d.notes, case when d.expiry_date is not null then d.expiry_date - current_date end as days_left
       from security_deposits d join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id
       left join projects p on p.tenant_id = d.tenant_id and p.id = d.project_id left join sales_orders o on o.tenant_id = d.tenant_id and o.id = d.sales_order_id
      where d.tenant_id = $1 and ($2::text is null or d.status = $2) and ($3::uuid is null or d.account_id = $3) and ($4::uuid is null or d.project_id = $4)
        and ($5::int is null or (d.status = 'active' and d.expiry_date <= current_date + $5::int))
      order by (d.status = 'active') desc, d.expiry_date nulls last, d.created_at desc limit 1000`,
    [ctx.tenantId, q.status ?? null, q.accountId ?? null, q.projectId ?? null, q.expiringDays ?? null],
  );
}

export async function getDeposit(ctx: RecordCtx, id: string) {
  assertDepositAdmin(ctx);
  const [d] = (await ctx.tx.query(
    `select d.*, d.amount::float8 as amount, d.margin_amount::float8 as margin_amount, d.released_amount::float8 as released_amount, d.forfeited_amount::float8 as forfeited_amount,
            (d.amount - d.released_amount - d.forfeited_amount)::float8 as held, a.name as customer, p.name as project, o.order_number, g.name as paid_from_name
       from security_deposits d join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id
       left join projects p on p.tenant_id = d.tenant_id and p.id = d.project_id left join sales_orders o on o.tenant_id = d.tenant_id and o.id = d.sales_order_id
       left join gl_accounts g on g.tenant_id = d.tenant_id and g.id = d.paid_from where d.tenant_id = $1 and d.id = $2`,
    [ctx.tenantId, id],
  )) as Record<string, any>[];
  if (!d) throw notFound('Deposit not found');
  const events = await ctx.tx.query(
    `select e.id, e.kind, e.event_date, e.amount::float8 as amount, e.margin::float8 as margin, e.new_expiry, e.note, g.name as bank, u.full_name as by, e.created_at
       from security_deposit_events e left join gl_accounts g on g.tenant_id = e.tenant_id and g.id = e.bank_account left join users u on u.tenant_id = e.tenant_id and u.id = e.created_by
      where e.tenant_id = $1 and e.deposit_id = $2 order by e.created_at`,
    [ctx.tenantId, id],
  );
  return { deposit: d, events, marginLeft: GUARANTEE.includes(d.instrument) ? await marginLeft(ctx.tx, ctx.tenantId, d as never) : 0 };
}

async function checkLinks(ctx: RecordCtx, input: DepositInput) {
  const acc = await ctx.tx.one(`select 1 from accounts where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.accountId]);
  if (!acc) throw badRequest('Customer not found');
  const same = async (table: string, id: string | null | undefined, what: string) => {
    if (!id) return;
    const r = await ctx.tx.one<{ account_id: string | null }>(`select account_id from ${table} where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
    if (!r) throw badRequest(`${what} not found`);
    if (r.account_id && r.account_id !== input.accountId) throw badRequest(`The ${what.toLowerCase()} belongs to another customer`);
  };
  await same('projects', input.projectId, 'Project');
  await same('sales_orders', input.salesOrderId, 'Sales order');
  await same('deals', input.dealId, 'Deal');
}

export async function createDeposit(ctx: RecordCtx, input: DepositInput) {
  await assertDepositWriter(ctx);
  await checkLinks(ctx, input);
  const amount = r2(input.amount);
  const margin = r2(input.marginAmount ?? 0);
  if (!(amount > 0)) throw badRequest('Enter the amount');
  if (margin && !GUARANTEE.includes(input.instrument)) throw badRequest('Margin money applies to bank guarantees only');
  if (margin > amount) throw badRequest('The margin cannot be more than the guarantee');
  if (input.instrument === 'withheld' && !input.opening) throw badRequest('Retention is recorded with the receipt it was withheld from (or tick "already in the opening balances")');
  if (input.expiryDate && input.issueDate && input.expiryDate < input.issueDate) throw badRequest('Expiry is before the issue date');
  if (input.claimUntil && input.expiryDate && input.claimUntil < input.expiryDate) throw badRequest('The claim period ends before expiry');
  const posting = !input.opening && !!(await postingOn(ctx.tx, ctx.tenantId));
  const moves = (CASH.includes(input.instrument) ? amount : margin) > 0 && input.instrument !== 'exempt';
  const paidFrom = await bankAccount(ctx.tx, ctx.tenantId, input.paidFrom, posting && moves);
  const n = await ctx.tx.one<{ n: string }>(`select app.next_counter('deposit') as n`);
  const number = `SD-${String(n!.n).padStart(4, '0')}`;
  const date = input.issueDate ?? today();
  const d = await ctx.tx.one<{ id: string }>(
    `insert into security_deposits (tenant_id, deposit_number, kind, instrument, account_id, project_id, sales_order_id, deal_id, reference, issuing_bank, amount, margin_amount, issue_date, expiry_date, claim_until, paid_from, notes, in_ledger)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
    [
      ctx.tenantId, number, input.kind, input.instrument, input.accountId, input.projectId ?? null, input.salesOrderId ?? null, input.dealId ?? null, input.reference ?? null,
      input.issuingBank ?? null, amount, margin, date, input.expiryDate ?? null, input.claimUntil ?? null, paidFrom, input.notes ?? null,
      // in the ledger: posted now, or the user says it is already in the opening balances
      (posting && moves && !!paidFrom) || (!!input.opening && !!(await postingOn(ctx.tx, ctx.tenantId))),
    ],
  );
  const ev = await addEvent(ctx, d!.id, { kind: 'place', date, amount, margin, bank: paidFrom, note: input.opening ? 'Already in the opening balances' : null });
  if (posting && moves && paidFrom) {
    const value = CASH.includes(input.instrument) ? amount : margin;
    await post(ctx, ev, date, input.reference || number, `${label(input.kind)} ${number}${input.reference ? ` (${input.reference})` : ''}`, [
      { accountId: await depositLedger(ctx.tx, ctx.tenantId, input.instrument), debit: value, partyType: 'customer', partyId: input.accountId, projectId: input.projectId ?? null },
      { accountId: paidFrom, credit: value },
    ]);
  }
  return { id: d!.id, number };
}

const label = (k: string) => ({ emd: 'EMD', performance_security: 'Performance security', retention: 'Retention', security_deposit: 'Security deposit', other: 'Deposit' })[k] ?? 'Deposit';

async function lockDeposit(ctx: RecordCtx, id: string) {
  const d = await ctx.tx.one<Record<string, any>>(`select * from security_deposits where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!d) throw notFound('Deposit not found');
  if (d.status !== 'active') throw badRequest(`This deposit is ${d.status}`);
  return d;
}

async function settle(ctx: RecordCtx, d: Record<string, any>) {
  const held = r2(Number(d.amount) - Number(d.released_amount) - Number(d.forfeited_amount));
  if (held <= 0) await ctx.tx.query(`update security_deposits set status = 'closed' where tenant_id = $1 and id = $2`, [ctx.tenantId, d.id]);
}

/** Money (or a guarantee) coming back. Cash deposits and retention can come back in parts; a guarantee is released whole. */
export async function releaseDeposit(ctx: RecordCtx, id: string, input: { amount?: number | null; date?: string | null; bankAccountId?: string | null; note?: string | null }) {
  await assertDepositWriter(ctx);
  const d = await lockDeposit(ctx, id);
  const held = r2(Number(d.amount) - Number(d.released_amount) - Number(d.forfeited_amount));
  const guarantee = GUARANTEE.includes(d.instrument);
  const amount = guarantee || d.instrument === 'exempt' ? held : r2(input.amount ?? held);
  if (!(amount > 0) || amount > held + 0.009) throw badRequest(`Up to ${held} can be released`);
  const date = input.date ?? today();
  notBefore(date, d.issue_date);
  const margin = guarantee ? await marginLeft(ctx.tx, ctx.tenantId, d as never) : 0;
  const money = guarantee ? margin : d.instrument === 'exempt' ? 0 : amount;
  // a deposit that never reached the ledger (given before the books, or while Tally kept them) is released without a journal
  const posting = !!(await postingOn(ctx.tx, ctx.tenantId)) && !!d.in_ledger;
  const bank = await bankAccount(ctx.tx, ctx.tenantId, input.bankAccountId, posting && money > 0);
  const ev = await addEvent(ctx, id, { kind: 'release', date, amount, margin, bank, note: input.note });
  await ctx.tx.query(`update security_deposits set released_amount = released_amount + $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, amount]);
  if (posting && money > 0 && bank)
    await post(ctx, ev, date, d.reference || d.deposit_number, `${label(d.kind)} ${d.deposit_number} released`, [
      { accountId: bank, debit: money },
      { accountId: await depositLedger(ctx.tx, ctx.tenantId, d.instrument), credit: money, partyType: 'customer', partyId: d.account_id, projectId: d.project_id },
    ]);
  await settle(ctx, { ...d, released_amount: Number(d.released_amount) + amount });
  return { ok: true };
}

/** The customer keeps some or all of it (liquidated damages recovered, EMD forfeited, guarantee invoked). */
export async function forfeitDeposit(ctx: RecordCtx, id: string, input: { amount: number; date?: string | null; bankAccountId?: string | null; reason: string }) {
  await assertDepositWriter(ctx);
  const d = await lockDeposit(ctx, id);
  const held = r2(Number(d.amount) - Number(d.released_amount) - Number(d.forfeited_amount));
  const amount = r2(input.amount);
  if (!(amount > 0) || amount > held + 0.009) throw badRequest(`Up to ${held} can be forfeited`);
  if (d.instrument === 'exempt') throw badRequest('Nothing was paid against an exemption');
  const date = input.date ?? today();
  notBefore(date, d.issue_date);
  const guarantee = GUARANTEE.includes(d.instrument);
  const margin = guarantee ? Math.min(amount, await marginLeft(ctx.tx, ctx.tenantId, d as never)) : 0;
  const fromBank = guarantee ? r2(amount - margin) : 0;
  const books = !!(await postingOn(ctx.tx, ctx.tenantId));
  // a cash deposit that never reached the ledger is forfeited without a journal; a guarantee is always
  // booked (the bank pays the buyer now), its margin from the margin ledger only when that holds it
  const posting = books && (guarantee || !!d.in_ledger);
  const marginFromBank = guarantee && !d.in_ledger ? margin : 0;
  const bank = await bankAccount(ctx.tx, ctx.tenantId, input.bankAccountId, posting && fromBank + marginFromBank > 0);
  const ev = await addEvent(ctx, id, { kind: 'forfeit', date, amount, margin, bank, note: input.reason });
  await ctx.tx.query(`update security_deposits set forfeited_amount = forfeited_amount + $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, amount]);
  if (posting) {
    const lines: JLine[] = [{ accountId: await sys(ctx.tx, ctx.tenantId, 'liquidated_damages'), debit: amount, partyType: 'customer', partyId: d.account_id, projectId: d.project_id, description: input.reason }];
    if (guarantee) {
      if (margin && d.in_ledger) lines.push({ accountId: await sys(ctx.tx, ctx.tenantId, 'bg_margin'), credit: margin, partyType: 'customer', partyId: d.account_id });
      if (fromBank + marginFromBank && bank) lines.push({ accountId: bank, credit: r2(fromBank + marginFromBank), description: 'Guarantee invoked: paid by the bank / insurer' });
    } else lines.push({ accountId: await depositLedger(ctx.tx, ctx.tenantId, d.instrument), credit: amount, partyType: 'customer', partyId: d.account_id, projectId: d.project_id });
    await post(ctx, ev, date, d.reference || d.deposit_number, `${label(d.kind)} ${d.deposit_number} forfeited: ${input.reason}`, lines);
  }
  await settle(ctx, { ...d, forfeited_amount: Number(d.forfeited_amount) + amount });
  return { ok: true };
}

/** A guarantee extended or renewed by the bank. */
export async function extendDeposit(ctx: RecordCtx, id: string, input: { expiryDate: string; claimUntil?: string | null; reference?: string | null; note?: string | null }) {
  await assertDepositWriter(ctx);
  const d = await lockDeposit(ctx, id);
  if (input.expiryDate < String(d.issue_date).slice(0, 10)) throw badRequest('Expiry is before the issue date');
  if (input.claimUntil && input.claimUntil < input.expiryDate) throw badRequest('The claim period ends before expiry');
  await addEvent(ctx, id, { kind: 'extend', date: today(), newExpiry: input.expiryDate, note: input.note ?? null });
  await ctx.tx.query(`update security_deposits set expiry_date = $3, claim_until = coalesce($4, claim_until), reference = coalesce($5, reference), expiry_notice = null where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, input.expiryDate, input.claimUntil ?? null, input.reference ?? null,
  ]);
  return { ok: true };
}

/** Entered by mistake: only while nothing has been released or forfeited. Retention goes with its receipt. */
export async function cancelDeposit(ctx: RecordCtx, id: string, reason: string) {
  await assertDepositWriter(ctx);
  const d = await lockDeposit(ctx, id);
  if (d.payment_id) throw badRequest('Retention withheld on a receipt is cancelled by voiding the receipt');
  if (Number(d.released_amount) || Number(d.forfeited_amount)) throw badRequest('Part of this deposit was released or forfeited; it cannot be cancelled');
  await cancelEvents(ctx, d, reason);
  return { ok: true };
}

async function cancelEvents(ctx: RecordCtx, d: Record<string, any>, reason: string) {
  const evs = await ctx.tx.query<{ id: string }>(`select id from security_deposit_events where tenant_id = $1 and deposit_id = $2`, [ctx.tenantId, d.id]);
  for (const e of evs) await voidSource(ctx.tx, ctx.tenantId, 'deposit', e.id, reason);
  await addEvent(ctx, d.id, { kind: 'cancel', date: today(), note: reason });
  await ctx.tx.query(`update security_deposits set status = 'cancelled' where tenant_id = $1 and id = $2`, [ctx.tenantId, d.id]);
}

/** Retention withheld on a receipt: a register entry (posted with the receipt itself). */
export async function retentionFromReceipt(ctx: RecordCtx, p: { id: string; number: string; accountId: string; amount: number; date: string; salesOrderId?: string | null; reference?: string | null }) {
  const proj = await ctx.tx.one<{ project_id: string | null }>(
    `select i.project_id from payment_allocations a join invoices i on i.tenant_id = a.tenant_id and i.id = a.invoice_id where a.tenant_id = $1 and a.payment_id = $2 and i.project_id is not null limit 1`,
    [ctx.tenantId, p.id],
  );
  const n = await ctx.tx.one<{ n: string }>(`select app.next_counter('deposit') as n`);
  const number = `SD-${String(n!.n).padStart(4, '0')}`;
  const d = await ctx.tx.one<{ id: string }>(
    `insert into security_deposits (tenant_id, deposit_number, kind, instrument, account_id, project_id, sales_order_id, payment_id, reference, amount, issue_date, notes, in_ledger)
     values ($1,$2,'retention','withheld',$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [ctx.tenantId, number, p.accountId, proj?.project_id ?? null, p.salesOrderId ?? null, p.id, p.reference ?? null, r2(p.amount), p.date, `Withheld from receipt ${p.number}`, !!(await postingOn(ctx.tx, ctx.tenantId))],
  );
  await addEvent(ctx, d!.id, { kind: 'place', date: p.date, amount: p.amount, note: `Receipt ${p.number}` });
}

/** Voiding a receipt cancels its retention entry, unless some of it has already been released or forfeited. */
export async function retentionOnVoid(ctx: RecordCtx, paymentId: string, reason: string) {
  const d = await ctx.tx.one<Record<string, any>>(`select * from security_deposits where tenant_id = $1 and payment_id = $2 and status <> 'cancelled' for update`, [ctx.tenantId, paymentId]);
  if (!d) return;
  if (Number(d.released_amount) || Number(d.forfeited_amount)) throw badRequest(`Retention ${d.deposit_number} from this receipt has been released or forfeited; reverse that first`);
  await cancelEvents(ctx, d, reason);
}

/**
 * Reminders (5-minute sweep): 30 and 7 days before a deposit or guarantee expires, its creator and
 * the project manager are notified once each; an extension resets the reminders.
 */
export async function sweepDepositExpiry(tx: Tx, tenantId: string) {
  // the nearer threshold first, so a deposit already inside 7 days gets one reminder, not two
  for (const days of [7, 30]) {
    const rows = await tx.query<{ id: string; deposit_number: string; kind: string; reference: string | null; expiry_date: string; customer: string; created_by: string | null; manager: string | null }>(
      `update security_deposits d set expiry_notice = $2
         from accounts a
        where d.tenant_id = $1 and a.tenant_id = d.tenant_id and a.id = d.account_id and d.status = 'active' and d.expiry_date is not null
          and d.expiry_date <= current_date + $2::int and (d.expiry_notice is null or d.expiry_notice > $2)
        returning d.id, d.deposit_number, d.kind, d.reference, d.expiry_date::text, a.name as customer, d.created_by,
                  null::uuid as manager`,
      [tenantId, days],
    );
    for (const r of rows)
      for (const u of new Set([r.created_by, r.manager].filter((x): x is string => !!x)))
        await tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'deposit',$3,$4,$5)`, [
          tenantId, u, `${label(r.kind)} ${r.deposit_number} expires ${r.expiry_date.split('-').reverse().join('-')}`,
          `${r.customer}${r.reference ? ` · ${r.reference}` : ''}: extend it or ask for its release`, `/books#deposits`,
        ]);
  }
}

/** Active guarantees and deposits expiring soon, for the overview and reminders. */
export async function expiringDeposits(tx: Tx, tenantId: string, days = 30) {
  return tx.query<{ id: string; deposit_number: string; kind: string; instrument: string; customer: string; reference: string | null; amount: number; expiry_date: string; days_left: number }>(
    `select d.id, d.deposit_number, d.kind, d.instrument, a.name as customer, d.reference, (d.amount - d.released_amount - d.forfeited_amount)::float8 as amount, d.expiry_date::text, (d.expiry_date - current_date) as days_left
       from security_deposits d join accounts a on a.tenant_id = d.tenant_id and a.id = d.account_id
      where d.tenant_id = $1 and d.status = 'active' and d.expiry_date is not null and d.expiry_date <= current_date + $2::int order by d.expiry_date limit 100`,
    [tenantId, days],
  );
}
