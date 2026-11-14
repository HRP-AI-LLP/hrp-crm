/**
 * Expenses and employee claims.
 *
 *  company-paid:  draft ──record──▶ recorded                     (posts at once)
 *  claim:         draft ──submit──▶ submitted ──approve──▶ approved ──reimburse──▶ reimbursed
 *                                       └──reject──▶ rejected (editable, resubmit)
 *  any posted one ──void──▶ void
 *
 * Tax and total follow the amount in the database (expenses_totals trigger); posted expenses
 * cannot be edited there either. Approval needs the books admin permission or edit-all on
 * expenses, and nobody approves their own claim.
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden } from '../../lib/errors';
import { nextFyNumber } from '../numbering';
import { loadRow, type RecordCtx, type RecordEvent } from '../records';
import { d10 } from './ledger';
import { repost } from './posting';


/** Books admins approve anything; otherwise edit rights over the claim (all or team) — loadRow checks the row is in reach. */
function canApprove(ctx: RecordCtx) {
  return hasAdmin(ctx.principal.permissions, 'books') || ['all', 'team'].includes(objectPerm(ctx.principal.permissions, 'expense').update);
}

async function number(ctx: RecordCtx, id: string, date: unknown) {
  const cur = await ctx.tx.one<{ expense_number: string | null }>(`select expense_number from expenses where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  if (cur?.expense_number) return;
  const n = await nextFyNumber(ctx, 'expense', d10(date), 'EXP');
  await ctx.tx.query(`update expenses set expense_number = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, n.number]);
}

async function assertAccounts(ctx: RecordCtx, row: Record<string, any>) {
  if (row.account_id) {
    const a = await ctx.tx.one<{ type: string; is_active: boolean }>(`select type, is_active from gl_accounts where tenant_id = $1 and id = $2`, [ctx.tenantId, row.account_id]);
    if (!a || !a.is_active || !['expense', 'asset'].includes(a.type)) throw badRequest('Choose an expense category (an expense or asset account)');
  }
  if (!row.is_claim && row.paid_through_id) {
    const a = await ctx.tx.one<{ subtype: string }>(`select subtype from gl_accounts where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, row.paid_through_id]);
    if (!a || !['bank', 'cash', 'credit_card'].includes(a.subtype)) throw badRequest('"Paid through" must be a bank, cash or card account');
  }
}

/** Sets the books fields the record form does not carry (category and paid-through accounts). */
export async function setExpenseAccounts(ctx: RecordCtx, id: string, accountId: string | null, paidThroughId: string | null) {
  const { row } = await loadRow(ctx, 'expense', id, 'update', true);
  if (!['draft', 'rejected'].includes(String(row.status))) throw badRequest('Only draft or rejected expenses can change');
  await assertAccounts(ctx, { ...row, account_id: accountId, paid_through_id: paidThroughId });
  await ctx.tx.query(`update expenses set account_id = $3, paid_through_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, accountId, paidThroughId]);
}

export async function expenseAction(ctx: RecordCtx, id: string, action: 'submit' | 'approve' | 'reject' | 'record' | 'reimburse' | 'void', opts: { reason?: string; throughId?: string | null; date?: string | null } = {}): Promise<RecordEvent[]> {
  const { row } = await loadRow(ctx, 'expense', id, 'update', true);
  const me = ctx.principal.user.id;
  const from = String(row.status);
  let to = from;
  if (action === 'submit') {
    if (!row.is_claim) throw badRequest('Only claims are submitted for approval; record company-paid expenses directly');
    if (!['draft', 'rejected'].includes(from)) throw badRequest('Only draft or rejected claims can be submitted');
    await assertAccounts(ctx, row);
    to = 'submitted';
    await number(ctx, id, row.expense_date);
  } else if (action === 'approve' || action === 'reject') {
    if (!canApprove(ctx)) throw forbidden('Approving expenses needs the books permission');
    if (from !== 'submitted') throw badRequest('Only submitted claims can be approved or rejected');
    if (row.owner_id === me && action === 'approve') throw forbidden('You cannot approve your own claim');
    if (action === 'reject' && !opts.reason?.trim()) throw badRequest('Say why the claim is rejected');
    to = action === 'approve' ? 'approved' : 'rejected';
  } else if (action === 'record') {
    if (row.is_claim) throw badRequest('Claims are submitted for approval');
    if (!['draft'].includes(from)) throw badRequest('Only draft expenses can be recorded');
    await assertAccounts(ctx, row);
    to = 'recorded';
    await number(ctx, id, row.expense_date);
  } else if (action === 'reimburse') {
    if (!canApprove(ctx)) throw forbidden('Reimbursing needs the books permission');
    if (from !== 'approved' || !row.is_claim) throw badRequest('Only approved claims can be reimbursed');
    if (opts.throughId) {
      const a = await ctx.tx.one<{ subtype: string }>(`select subtype from gl_accounts where tenant_id = $1 and id = $2 and is_active`, [ctx.tenantId, opts.throughId]);
      if (!a || !['bank', 'cash'].includes(a.subtype)) throw badRequest('Reimburse from a bank or cash account');
    }
    to = 'reimbursed';
  } else if (action === 'void') {
    if (!canApprove(ctx) && !(row.owner_id === me && from === 'recorded')) throw forbidden('Voiding needs the books permission');
    if (!['approved', 'recorded', 'reimbursed'].includes(from)) throw badRequest('Only posted expenses can be voided');
    to = 'void';
  }
  await ctx.tx.query(
    `update expenses set status = $3,
            approved_by = case when $3 = 'approved' then $4::uuid else approved_by end, approved_at = case when $3 = 'approved' then now() else approved_at end,
            reject_reason = case when $3 = 'rejected' then $5 else reject_reason end,
            reimbursed_at = case when $3 = 'reimbursed' then coalesce($7::date, current_date) else reimbursed_at end,
            reimbursed_through_id = case when $3 = 'reimbursed' then $6::uuid else reimbursed_through_id end
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, to, me, opts.reason ?? null, opts.throughId ?? null, opts.date ?? null],
  );
  await repost(ctx.tx, ctx.tenantId, 'expense', id);
  await repost(ctx.tx, ctx.tenantId, 'reimbursement', id);
  if (to !== from && row.owner_id && row.owner_id !== me && ['approved', 'rejected', 'reimbursed'].includes(to)) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'expense',$3,$4,$5)`, [
      ctx.tenantId, row.owner_id, `Your claim "${String(row.name).slice(0, 80)}" was ${to}`, to === 'rejected' ? opts.reason ?? null : null, `/o/expense/${id}`,
    ]);
  }
  return [{ objectKey: 'expense', recordId: id, kind: 'updated', changes: { status: [from, to] } }];
}

/** The books side of an expense the record form does not show (category, paid-through, approval trail). */
export async function expenseBooks(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'expense', id, 'read');
  const names = await ctx.tx.query<{ id: string; name: string }>(`select id, name from gl_accounts where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, [row.account_id, row.paid_through_id, row.reimbursed_through_id].filter(Boolean)]);
  const nameOf = (v: unknown) => names.find((n) => n.id === v)?.name ?? null;
  const approver = row.approved_by ? await ctx.tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [ctx.tenantId, row.approved_by]) : null;
  return {
    accountId: row.account_id ?? null,
    account: nameOf(row.account_id),
    paidThroughId: row.paid_through_id ?? null,
    paidThrough: nameOf(row.paid_through_id),
    rejectReason: row.reject_reason ?? null,
    approvedBy: approver?.full_name ?? null,
    approvedAt: row.approved_at ?? null,
    reimbursedAt: row.reimbursed_at ?? null,
    reimbursedThrough: nameOf(row.reimbursed_through_id),
  };
}
