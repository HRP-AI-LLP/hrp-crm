/**
 * Match & reconcile: one place where SanchalanOS proposes how documents and money belong together,
 * and a person approves before anything is saved.
 *
 *   receipt ↔ invoice(s)          a receipt not yet applied, to the customer's open invoices — exact,
 *                                 several adding up, or short by the TDS the customer deducted
 *   receipt → milestone           no open invoice, but a finished milestone of that value: raise it
 *   vendor payment ↔ bill(s)      the same for what we paid
 *   milestone ↔ invoice           the invoice raised for a project milestone
 *   milestone ↔ approval email    every task of the milestone done and the customer's approval in mail
 *   invoice / bill / expense → project   documents that belong to a project but are on none
 *   claim ↔ bank debit            an approved claim reimbursed by a bank payment
 *   bank line ↔ anything          the accounts desk's pending proposals (receipts, payments, matches,
 *                                 categories)
 *
 * Every suggestion has a stable key; rejecting one hides it for good. Approving runs the same service
 * the screens use (allocation, linking, booking), each in its own savepoint, so checks and postings
 * are the usual ones and one failure does not stop the rest.
 */
import { canUseArea, hasAdmin, objectPerm } from '@synapse/shared';
import { z } from 'zod';
import { badRequest, forbidden } from '../lib/errors';
import { allocatePayment } from './billing';
import { matchTxn } from './books/banking';
import { allocateVendorPayment } from './books/bills';
import { decide, listProposals } from './books/desk';
import { expenseAction } from './books/expenses';
import { repost } from './books/posting';
import { invoiceCandidates, mailText, squash } from './milestone-billing';
import { approvalEmails, projectAccess, saveMilestone } from './projects';
import type { RecordCtx, RecordEvent } from './records';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type Kind =
  | 'receipt_invoice'
  | 'receipt_milestone'
  | 'vendor_payment_bill'
  | 'milestone_invoice'
  | 'milestone_done'
  | 'invoice_project'
  | 'bill_project'
  | 'expense_project'
  | 'claim_bank'
  | 'bank';

export const KIND_LABELS: Record<Kind, string> = {
  receipt_invoice: 'Receipts → invoices',
  receipt_milestone: 'Receipts → milestones to invoice',
  vendor_payment_bill: 'Payments made → bills',
  milestone_invoice: 'Milestones → invoices',
  milestone_done: 'Milestones → approval emails',
  invoice_project: 'Invoices → projects',
  bill_project: 'Bills → projects',
  expense_project: 'Expenses → projects',
  claim_bank: 'Claims → bank payments',
  bank: 'Bank lines',
};

export interface Ref {
  type: string;
  id: string;
  label: string;
  sub?: string | null;
  amount?: number | null;
  date?: string | null;
  link?: string | null;
}
export interface Suggestion {
  key: string;
  kind: Kind;
  confidence: number;
  title: string;
  reasons: string[];
  left: Ref;
  right: Ref[];
  /** what approving does; the screen may adjust amounts / TDS before approving */
  action: Record<string, unknown>;
  projectId?: string | null;
  accountId?: string | null;
}

export interface Focus {
  type: 'payment' | 'invoice' | 'project' | 'account' | 'milestone' | 'bill' | 'vendor_payment' | 'expense';
  id: string;
}

/* ───────────────────────── helpers ───────────────────────── */

/** Income-tax TDS (1, 2, 5, 10 %) and GST TDS (2 %) on the value before GST explain a short receipt. */
const TDS_RATES: { rate: number; it: number; gst: number; label: string }[] = [
  { rate: 0.01, it: 0.01, gst: 0, label: 'TDS 1%' },
  { rate: 0.02, it: 0.02, gst: 0, label: 'TDS 2% (or GST TDS 2%)' },
  { rate: 0.05, it: 0.05, gst: 0, label: 'TDS 5%' },
  { rate: 0.1, it: 0.1, gst: 0, label: 'TDS 10%' },
  { rate: 0.03, it: 0.01, gst: 0.02, label: 'TDS 1% + GST TDS 2%' },
  { rate: 0.04, it: 0.02, gst: 0.02, label: 'TDS 2% + GST TDS 2%' },
  { rate: 0.07, it: 0.05, gst: 0.02, label: 'TDS 5% + GST TDS 2%' },
  { rate: 0.12, it: 0.1, gst: 0.02, label: 'TDS 10% + GST TDS 2%' },
];
function tdsFor(gap: number, taxable: number, government: boolean) {
  if (gap <= 0 || taxable <= 0) return null;
  const hit = TDS_RATES.find((t) => Math.abs(taxable * t.rate - gap) <= Math.max(1, taxable * 0.0005));
  if (!hit) return null;
  // a 2% gap from a government buyer is usually GST TDS (section 51)
  if (hit.rate === 0.02 && government) return { tds: 0, gstTds: gap, label: 'GST TDS 2% (section 51)' };
  const gstTds = r2(taxable * hit.gst);
  return { tds: r2(gap - gstTds), gstTds, label: hit.label };
}

/** Subsets of up to three amounts adding up to the target (to the paisa). */
function subsets<T extends { balance: number }>(items: T[], target: number, max = 3): T[][] {
  const out: T[][] = [];
  const list = items.slice(0, 25);
  const walk = (start: number, picked: T[], sum: number) => {
    if (out.length >= 3) return;
    if (picked.length >= 2 && Math.abs(sum - target) <= 0.5) out.push([...picked]);
    if (picked.length >= max) return;
    for (let i = start; i < list.length; i++) {
      if (sum + list[i]!.balance > target + 0.5) continue;
      walk(i + 1, [...picked, list[i]!], sum + list[i]!.balance);
    }
  };
  walk(0, [], 0);
  return out;
}

const books = (ctx: RecordCtx) => hasAdmin(ctx.principal.permissions, 'books') || !!ctx.principal.user.isOwner;
const billingOk = (ctx: RecordCtx) =>
  canUseArea(ctx.principal.permissions.apps, 'billing') && objectPerm(ctx.principal.permissions, 'invoice').read !== 'none' && objectPerm(ctx.principal.permissions, 'payment').update !== 'none';

async function managedProjects(ctx: RecordCtx, ids: (string | null | undefined)[]) {
  const ok = new Set<string>();
  for (const id of new Set(ids.filter((x): x is string => !!x))) {
    try {
      await projectAccess(ctx, id, 'manage');
      ok.add(id);
    } catch {
      /* not theirs to manage */
    }
  }
  return ok;
}

/* ───────────────────────── generators ───────────────────────── */

async function receiptsToInvoices(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (!billingOk(ctx)) return [];
  const pays = await ctx.tx.query<{ id: string; number: string | null; date: string; amount: number; unallocated: number; account_id: string; account: string; account_type: string | null; reference: string | null; notes: string | null; milestone_id: string | null; currency: string }>(
    `select p.id, p.payment_number as number, p.payment_date::text as date, p.amount::float8 as amount, p.unallocated::float8 as unallocated, p.account_id, a.name as account, a.account_type,
            p.reference, p.notes, p.milestone_id, coalesce(p.currency, 'INR') as currency
       from payments p join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
      where p.tenant_id = $1 and p.status = 'received' and p.deleted_at is null and p.unallocated > 0.009
        and ($2::text is null or ($2 = 'payment' and p.id = $3::uuid) or ($2 = 'account' and p.account_id = $3::uuid) or ($2 = 'invoice' and p.account_id = (select account_id from invoices where tenant_id = $1 and id = $3::uuid))
             or ($2 = 'project' and (p.project_id = $3::uuid or p.account_id = (select account_id from projects where tenant_id = $1 and id = $3::uuid))))
      order by p.payment_date desc limit 200`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const out: Suggestion[] = [];
  for (const p of pays) {
    const invs = await ctx.tx.query<{ id: string; number: string | null; date: string; due: string | null; balance: number; taxable: number; total: number; paid: number; project_id: string | null; milestone_id: string | null }>(
      `select i.id, i.invoice_number as number, i.invoice_date::text as date, i.due_date::text as due, i.balance_due::float8 as balance, i.taxable_total::float8 as taxable, i.grand_total::float8 as total,
              i.amount_paid::float8 as paid, i.project_id, (select m.id from project_milestones m where m.tenant_id = i.tenant_id and m.invoice_id = i.id limit 1) as milestone_id
         from invoices i where i.tenant_id = $1 and i.account_id = $2 and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid') and i.deleted_at is null and i.currency = $3
        order by i.due_date nulls last, i.invoice_date limit 60`,
      [ctx.tenantId, p.account_id, p.currency],
    );
    const left: Ref = { type: 'payment', id: p.id, label: `Receipt ${p.number ?? ''}`.trim(), sub: `${p.account} · ${p.reference ?? p.notes ?? ''}`.replace(/ · $/, ''), amount: p.unallocated, date: p.date, link: `/o/payment/${p.id}` };
    const ref = squash(`${p.reference ?? ''} ${p.notes ?? ''}`);
    const named = (n: string | null) => !!n && squash(n).length >= 4 && ref.includes(squash(n));
    const gov = /gov|psu|government|public/i.test(p.account_type ?? '') || /corporation of india|ministry|department|government|govt|nagar|nigam|municipal|board|authority/i.test(p.account);
    const iref = (i: (typeof invs)[number], applied: number): Ref => ({ type: 'invoice', id: i.id, label: `Invoice ${i.number ?? '(draft no.)'}`, sub: `balance ${money(i.balance)} of ${money(i.total)}`, amount: applied, date: i.date, link: `/o/invoice/${i.id}` });
    const push = (s: Omit<Suggestion, 'key' | 'kind' | 'left' | 'accountId'>) =>
      out.push({ ...s, key: `receipt_invoice:${p.id}:${(s.action.allocations as { invoiceId: string }[]).map((a) => a.invoiceId).sort().join(',')}`, kind: 'receipt_invoice', left, accountId: p.account_id });
    const amt = p.unallocated;
    let found = false;
    // 1. the milestone the receipt was recorded for
    if (p.milestone_id) {
      const i = invs.find((x) => x.milestone_id === p.milestone_id);
      if (i) {
        const a = r2(Math.min(amt, i.balance));
        const t = amt < i.balance ? tdsFor(r2(i.balance - amt), i.taxable, gov) : null;
        push({ confidence: 0.97, title: `Apply ${money(a)} to ${i.number ?? 'the milestone invoice'}`, reasons: ['the receipt was recorded for this milestone', ...(t ? [`short by ${t.label}`] : [])], right: [iref(i, t ? i.balance : a)], action: { paymentId: p.id, allocations: [{ invoiceId: i.id, amount: t ? r2(i.balance) : a }], tds: t?.tds ?? 0, gstTds: t?.gstTds ?? 0 }, projectId: i.project_id });
        continue;
      }
    }
    // 2. one invoice: exact, or short by TDS
    for (const i of invs) {
      const exact = Math.abs(i.balance - amt) <= 0.5;
      const t = !exact && amt < i.balance ? tdsFor(r2(i.balance - amt), i.taxable, gov) : null;
      if (!exact && !t) continue;
      const reasons = [exact ? 'equals the invoice balance' : `the balance less ${t!.label} of ${money(i.taxable)} (value before GST)`];
      if (named(i.number)) reasons.push('the receipt names the invoice');
      const c = exact ? (named(i.number) ? 0.99 : 0.93) : named(i.number) ? 0.92 : 0.82;
      push({ confidence: c, title: exact ? `Apply to ${i.number}` : `Apply to ${i.number} and record ${money(r2(i.balance - amt))} deducted (${t!.label})`, reasons, right: [iref(i, i.balance)], action: { paymentId: p.id, allocations: [{ invoiceId: i.id, amount: r2(exact ? Math.min(amt, i.balance) : i.balance) }], tds: t?.tds ?? 0, gstTds: t?.gstTds ?? 0 }, projectId: i.project_id });
      found = true;
    }
    if (found) continue;
    // 3. several invoices adding up
    const sets = subsets(invs, amt);
    for (const set of sets) {
      push({ confidence: 0.85, title: `Apply to ${set.length} invoices that add up to ${money(amt)}`, reasons: [`${set.map((s) => s.number).join(' + ')} = ${money(amt)}`], right: set.map((i) => iref(i, i.balance)), action: { paymentId: p.id, allocations: set.map((i) => ({ invoiceId: i.id, amount: r2(i.balance) })), tds: 0, gstTds: 0 }, projectId: set[0]!.project_id });
      found = true;
    }
    if (found) continue;
    // 4. an invoice it names, for part of it
    const namedInv = invs.find((i) => named(i.number));
    if (namedInv) {
      const a = r2(Math.min(amt, namedInv.balance));
      push({ confidence: 0.75, title: `Apply ${money(a)} to ${namedInv.number}`, reasons: ['the receipt names the invoice', a < namedInv.balance ? 'part payment' : 'more than the balance: the rest stays unapplied'], right: [iref(namedInv, a)], action: { paymentId: p.id, allocations: [{ invoiceId: namedInv.id, amount: a }], tds: 0, gstTds: 0 }, projectId: namedInv.project_id });
      continue;
    }
    // 5. oldest first
    if (invs.length) {
      let rest = amt;
      const plan: { invoiceId: string; amount: number }[] = [];
      const refs: Ref[] = [];
      for (const i of invs) {
        if (rest <= 0.009) break;
        const a = r2(Math.min(rest, i.balance));
        plan.push({ invoiceId: i.id, amount: a });
        refs.push(iref(i, a));
        rest = r2(rest - a);
      }
      push({ confidence: 0.5, title: `Apply to the oldest invoices of ${p.account}`, reasons: ['no invoice matches the amount', rest > 0 ? `${money(rest)} stays unapplied` : 'covers them fully'], right: refs, action: { paymentId: p.id, allocations: plan, tds: 0, gstTds: 0 }, projectId: invs[0]!.project_id });
    }
  }
  return out;
}

/** A receipt with no open invoice to take it: a finished milestone of that value has not been invoiced. */
async function receiptsToMilestones(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (!billingOk(ctx)) return [];
  const rows = await ctx.tx.query<{ pid: string; number: string | null; date: string; unallocated: number; account: string; mid: string; mname: string; mamount: number; mstatus: string; project_id: string; project: string }>(
    `select p.id as pid, p.payment_number as number, p.payment_date::text as date, p.unallocated::float8 as unallocated, a.name as account,
            m.id as mid, m.name as mname, m.amount::float8 as mamount, m.status as mstatus, pr.id as project_id, pr.name as project
       from payments p join accounts a on a.tenant_id = p.tenant_id and a.id = p.account_id
       join projects pr on pr.tenant_id = p.tenant_id and pr.account_id = p.account_id and pr.deleted_at is null
       join project_milestones m on m.tenant_id = pr.tenant_id and m.project_id = pr.id and m.invoice_id is null and m.amount > 0
      where p.tenant_id = $1 and p.status = 'received' and p.deleted_at is null and p.unallocated > 0.009
        and not exists (select 1 from invoices i where i.tenant_id = p.tenant_id and i.account_id = p.account_id and i.doc_type = 'tax_invoice' and i.status in ('issued','partially_paid') and i.deleted_at is null)
        and ($2::text is null or ($2 = 'payment' and p.id = $3::uuid) or ($2 = 'project' and pr.id = $3::uuid) or ($2 = 'account' and p.account_id = $3::uuid) or ($2 = 'milestone' and m.id = $3::uuid))
      limit 300`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const ok = await managedProjects(ctx, rows.map((r) => r.project_id));
  const out: Suggestion[] = [];
  for (const r of rows) {
    if (!ok.has(r.project_id)) continue;
    // the receipt is the milestone with GST (18 %), less what the buyer may have deducted
    const withGst = r2(r.mamount * 1.18);
    const gap = r2(withGst - r.unallocated);
    const exact = Math.abs(gap) <= 1 || Math.abs(r.mamount - r.unallocated) <= 1;
    const t = !exact ? tdsFor(gap, r.mamount, true) : null;
    if (!exact && !t) continue;
    out.push({
      key: `receipt_milestone:${r.pid}:${r.mid}`,
      kind: 'receipt_milestone',
      confidence: r.mstatus === 'done' ? 0.8 : 0.6,
      title: `${r.mname} (${r.project}) looks paid but is not invoiced`,
      reasons: [
        exact ? `the receipt equals the milestone ${Math.abs(r.mamount - r.unallocated) <= 1 ? '' : 'with 18% GST'}`.trim() : `the milestone with 18% GST less ${t!.label}`,
        r.mstatus === 'done' ? 'the milestone is done' : 'the milestone is not marked done yet',
        'raise its invoice (or link the one raised outside SanchalanOS), then this receipt can be applied',
      ],
      left: { type: 'payment', id: r.pid, label: `Receipt ${r.number ?? ''}`.trim(), sub: r.account, amount: r.unallocated, date: r.date, link: `/o/payment/${r.pid}` },
      right: [{ type: 'milestone', id: r.mid, label: r.mname, sub: `${r.project} · ${money(r.mamount)} before GST`, amount: r.mamount, link: `/projects/${r.project_id}?s_project=billing` }],
      action: { open: `/projects/${r.project_id}?s_project=billing` },
      projectId: r.project_id,
    });
  }
  return out;
}

async function vendorPaymentsToBills(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (!books(ctx)) return [];
  const pays = await ctx.tx.query<{ id: string; number: string | null; date: string; unallocated: number; vendor_id: string; vendor: string; reference: string | null; currency: string }>(
    `select p.id, p.payment_number as number, p.payment_date::text as date, p.unallocated::float8 as unallocated, p.vendor_id, v.name as vendor, p.reference, p.currency
       from vendor_payments p join vendors v on v.tenant_id = p.tenant_id and v.id = p.vendor_id
      where p.tenant_id = $1 and p.status = 'paid' and p.deleted_at is null and p.unallocated > 0.009
        and ($2::text is null or ($2 = 'vendor_payment' and p.id = $3::uuid) or ($2 = 'bill' and p.vendor_id = (select vendor_id from bills where tenant_id = $1 and id = $3::uuid)))
      order by p.payment_date desc limit 200`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const out: Suggestion[] = [];
  for (const p of pays) {
    const bills = await ctx.tx.query<{ id: string; number: string | null; date: string; balance: number; taxable: number }>(
      `select id, coalesce(bill_number, vendor_ref) as number, bill_date::text as date, balance_due::float8 as balance, taxable_total::float8 as taxable from bills
        where tenant_id = $1 and vendor_id = $2 and doc_type = 'bill' and status in ('open','partially_paid') and deleted_at is null and currency = $3 order by due_date nulls last, bill_date limit 60`,
      [ctx.tenantId, p.vendor_id, p.currency],
    );
    const left: Ref = { type: 'vendor_payment', id: p.id, label: `Payment ${p.number ?? ''}`.trim(), sub: p.vendor, amount: p.unallocated, date: p.date, link: `/o/vendor_payment/${p.id}` };
    const bref = (b: (typeof bills)[number], a: number): Ref => ({ type: 'bill', id: b.id, label: `Bill ${b.number ?? ''}`.trim(), sub: `balance ${money(b.balance)}`, amount: a, date: b.date, link: `/o/bill/${b.id}` });
    const push = (c: number, title: string, reasons: string[], plan: { billId: string; amount: number }[], refs: Ref[]) =>
      out.push({ key: `vendor_payment_bill:${p.id}:${plan.map((x) => x.billId).sort().join(',')}`, kind: 'vendor_payment_bill', confidence: c, title, reasons, left, right: refs, action: { paymentId: p.id, allocations: plan } });
    const exact = bills.filter((b) => Math.abs(b.balance - p.unallocated) <= 0.5);
    if (exact.length) {
      for (const b of exact) push(exact.length === 1 ? 0.93 : 0.7, `Apply to ${b.number ?? 'the bill'}`, ['equals the bill balance', ...(exact.length > 1 ? ['other bills have the same balance'] : [])], [{ billId: b.id, amount: r2(Math.min(b.balance, p.unallocated)) }], [bref(b, b.balance)]);
      continue;
    }
    const sets = subsets(bills, p.unallocated);
    if (sets.length) {
      for (const set of sets) push(0.85, `Apply to ${set.length} bills that add up`, [`${set.map((s) => s.number).join(' + ')} = ${money(p.unallocated)}`], set.map((b) => ({ billId: b.id, amount: r2(b.balance) })), set.map((b) => bref(b, b.balance)));
      continue;
    }
    if (bills.length) {
      let rest = p.unallocated;
      const plan: { billId: string; amount: number }[] = [];
      const refs: Ref[] = [];
      for (const b of bills) {
        if (rest <= 0.009) break;
        const a = r2(Math.min(rest, b.balance));
        plan.push({ billId: b.id, amount: a });
        refs.push(bref(b, a));
        rest = r2(rest - a);
      }
      push(0.5, `Apply to the oldest bills of ${p.vendor}`, ['no bill matches the amount'], plan, refs);
    }
  }
  return out;
}

async function milestonesToInvoices(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (objectPerm(ctx.principal.permissions, 'invoice').read === 'none' && !ctx.principal.user.isOwner) return [];
  const ms = await ctx.tx.query<{ id: string; name: string; amount: number | null; status: string; project_id: string; project: string; account_id: string | null }>(
    `select m.id, m.name, m.amount::float8 as amount, m.status, p.id as project_id, p.name as project, p.account_id from project_milestones m join projects p on p.tenant_id = m.tenant_id and p.id = m.project_id and p.deleted_at is null
      where m.tenant_id = $1 and m.invoice_id is null and coalesce(m.amount, 0) > 0
        and ($2::text is null or ($2 = 'project' and p.id = $3::uuid) or ($2 = 'milestone' and m.id = $3::uuid) or ($2 = 'account' and p.account_id = $3::uuid)
             or ($2 = 'invoice' and p.account_id = (select account_id from invoices where tenant_id = $1 and id = $3::uuid)))
      order by m.due_date nulls last limit 150`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const ok = await managedProjects(ctx, ms.map((m) => m.project_id));
  const out: Suggestion[] = [];
  const taken = new Set<string>();
  for (const m of ms) {
    if (!ok.has(m.project_id)) continue;
    const words = squash(await mailText(ctx, m.project_id, m.id));
    const c = (await invoiceCandidates(ctx, m.project_id, m.account_id, m, words)).filter((x) => !taken.has(x.id));
    const top = c[0];
    if (!top || top.score < 6) continue;
    taken.add(top.id);
    const same = c.filter((x) => x.score === top.score).length > 1;
    out.push({
      key: `milestone_invoice:${m.id}:${top.id}`,
      kind: 'milestone_invoice',
      confidence: same ? 0.55 : top.score >= 10 ? 0.95 : top.score >= 8 ? 0.85 : 0.7,
      title: `${top.invoice_number ?? 'An invoice'} is the invoice of “${m.name}”`,
      reasons: [...top.reasons, ...(same ? ['another invoice scores the same'] : [])],
      left: { type: 'milestone', id: m.id, label: m.name, sub: `${m.project} · ${money(Number(m.amount))} before GST`, amount: m.amount, link: `/projects/${m.project_id}?s_project=billing` },
      right: [{ type: 'invoice', id: top.id, label: `Invoice ${top.invoice_number ?? ''}`.trim(), sub: `${top.account ?? ''} · ${money(top.taxable_total)} before GST · ${top.status}`, amount: top.grand_total, date: top.invoice_date, link: `/o/invoice/${top.id}` }],
      action: { projectId: m.project_id, milestoneId: m.id, invoiceId: top.id },
      projectId: m.project_id,
      accountId: m.account_id,
    });
  }
  return out;
}

/** Milestones whose tasks are all done, with a customer email that reads like the approval. */
async function milestonesDone(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  const ms = await ctx.tx.query<{ id: string; name: string; project_id: string; project: string; tasks: number; done: number; row: Record<string, any> }>(
    `select m.id, m.name, p.id as project_id, p.name as project,
            (select count(*)::int from project_tasks t where t.tenant_id = m.tenant_id and t.milestone_id = m.id and t.status <> 'cancelled') as tasks,
            (select count(*)::int from project_tasks t where t.tenant_id = m.tenant_id and t.milestone_id = m.id and t.status = 'done') as done
       from project_milestones m join projects p on p.tenant_id = m.tenant_id and p.id = m.project_id and p.deleted_at is null
      where m.tenant_id = $1 and m.status <> 'done' and ($2::text is null or ($2 = 'project' and p.id = $3::uuid) or ($2 = 'milestone' and m.id = $3::uuid))
      limit 100`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const ready = ms.filter((m) => m.tasks > 0 && m.done === m.tasks);
  const ok = await managedProjects(ctx, ready.map((m) => m.project_id));
  const out: Suggestion[] = [];
  for (const m of ready) {
    if (!ok.has(m.project_id)) continue;
    const mails = (await approvalEmails(ctx, m.project_id, { milestoneId: m.id, scan: true })).items as { id: string; subject: string | null; occurred_at: string; from: string | null; score: number }[];
    const best = mails.find((x) => x.score >= 4) ?? null;
    if (!best) continue;
    out.push({
      key: `milestone_done:${m.id}:${best.id}`,
      kind: 'milestone_done',
      confidence: best.score >= 6 ? 0.8 : 0.6,
      title: `Close “${m.name}” with the customer’s approval email`,
      reasons: [`all ${m.tasks} tasks are done`, `“${best.subject ?? '(no subject)'}” reads like an approval`],
      left: { type: 'milestone', id: m.id, label: m.name, sub: `${m.project} · ${m.done}/${m.tasks} tasks done`, link: `/projects/${m.project_id}` },
      right: [{ type: 'email', id: best.id, label: best.subject ?? '(no subject)', sub: best.from, date: String(best.occurred_at).slice(0, 10) }],
      action: { projectId: m.project_id, milestoneId: m.id, activityId: best.id },
      projectId: m.project_id,
    });
  }
  return out;
}

/** Invoices, bills and expenses on no project, that belong to one. */
async function toProjects(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  const projects = await ctx.tx.query<{ id: string; name: string; code: string | null; account_id: string | null }>(
    `select id, name, work_key as code, account_id from projects where tenant_id = $1 and deleted_at is null and status in ('planning','active','on_hold') and ($2::text is null or $2 <> 'project' or id = $3::uuid) limit 300`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  if (!projects.length) return [];
  const ok = await managedProjects(ctx, projects.map((p) => p.id));
  const mine = projects.filter((p) => ok.has(p.id));
  if (!mine.length) return [];
  const byAccount = new Map<string, typeof mine>();
  for (const p of mine) if (p.account_id) byAccount.set(p.account_id, [...(byAccount.get(p.account_id) ?? []), p]);
  const mentions = (text: string) => {
    const t = squash(text);
    return mine.filter((p) => (squash(p.name).length >= 5 && t.includes(squash(p.name))) || (p.code && squash(p.code).length >= 3 && new RegExp(`\\b${p.code}\\b`, 'i').test(text)));
  };
  const out: Suggestion[] = [];
  // invoices
  if (billingOk(ctx)) {
    const invs = await ctx.tx.query<{ id: string; number: string | null; date: string; total: number; account_id: string | null; account: string | null; lines: string | null; notes: string | null }>(
      `select i.id, i.invoice_number as number, i.invoice_date::text as date, i.grand_total::float8 as total, i.account_id, a.name as account,
              (select string_agg(l.name, ' · ') from invoice_lines l where l.tenant_id = i.tenant_id and l.order_id = i.id) as lines, i.notes
         from invoices i left join accounts a on a.tenant_id = i.tenant_id and a.id = i.account_id
        where i.tenant_id = $1 and i.project_id is null and i.status not in ('draft','cancelled') and i.deleted_at is null and i.invoice_date >= current_date - 400
          and ($2::text is null or ($2 = 'invoice' and i.id = $3::uuid) or ($2 = 'project' and i.account_id = (select account_id from projects where tenant_id = $1 and id = $3::uuid)))
        order by i.invoice_date desc limit 200`,
      [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
    );
    for (const i of invs) {
      const named = mentions(`${i.lines ?? ''} ${i.notes ?? ''}`);
      const only = i.account_id ? byAccount.get(i.account_id) ?? [] : [];
      const p = named.length === 1 ? named[0]! : only.length === 1 ? only[0]! : null;
      if (!p) continue;
      out.push({
        key: `invoice_project:${i.id}:${p.id}`,
        kind: 'invoice_project',
        confidence: named.length === 1 ? 0.88 : 0.7,
        title: `Put ${i.number ?? 'the invoice'} on project ${p.name}`,
        reasons: [named.length === 1 ? 'the invoice names the project' : `the only open project of ${i.account}`],
        left: { type: 'invoice', id: i.id, label: `Invoice ${i.number ?? ''}`.trim(), sub: i.account, amount: i.total, date: i.date, link: `/o/invoice/${i.id}` },
        right: [{ type: 'project', id: p.id, label: p.name, link: `/projects/${p.id}` }],
        action: { type: 'invoice', id: i.id, projectId: p.id },
        projectId: p.id,
        accountId: i.account_id,
      });
    }
  }
  // bills (their lines carry the project) and expenses
  if (books(ctx)) {
    const bills = await ctx.tx.query<{ id: string; number: string | null; date: string; total: number; vendor: string | null; vendor_id: string | null; text: string | null }>(
      `select b.id, coalesce(b.bill_number, b.vendor_ref) as number, b.bill_date::text as date, b.grand_total::float8 as total, v.name as vendor, b.vendor_id,
              coalesce(b.notes, '') || ' ' || coalesce((select string_agg(l.name || ' ' || coalesce(l.description, ''), ' · ') from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id), '') as text
         from bills b left join vendors v on v.tenant_id = b.tenant_id and v.id = b.vendor_id
        where b.tenant_id = $1 and b.doc_type = 'bill' and b.status not in ('draft','void') and b.deleted_at is null and b.bill_date >= current_date - 400
          and not exists (select 1 from bill_lines l where l.tenant_id = b.tenant_id and l.order_id = b.id and l.project_id is not null)
          and ($2::text is null or ($2 = 'bill' and b.id = $3::uuid) or $2 = 'project')
        order by b.bill_date desc limit 200`,
      [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
    );
    for (const b of bills) {
      const named = mentions(b.text ?? '');
      // a vendor that has only ever billed one project
      const past = b.vendor_id
        ? await ctx.tx.query<{ project_id: string }>(`select distinct l.project_id from bill_lines l join bills x on x.tenant_id = l.tenant_id and x.id = l.order_id where l.tenant_id = $1 and x.vendor_id = $2 and l.project_id is not null limit 3`, [ctx.tenantId, b.vendor_id])
        : [];
      const p = named.length === 1 ? named[0]! : past.length === 1 ? mine.find((x) => x.id === past[0]!.project_id) ?? null : null;
      if (!p) continue;
      out.push({
        key: `bill_project:${b.id}:${p.id}`,
        kind: 'bill_project',
        confidence: named.length === 1 ? 0.85 : 0.65,
        title: `Book bill ${b.number ?? ''} to project ${p.name}`.replace('  ', ' '),
        reasons: [named.length === 1 ? 'the bill names the project' : `${b.vendor} has only billed this project before`],
        left: { type: 'bill', id: b.id, label: `Bill ${b.number ?? ''}`.trim(), sub: b.vendor, amount: b.total, date: b.date, link: `/o/bill/${b.id}` },
        right: [{ type: 'project', id: p.id, label: p.name, link: `/projects/${p.id}` }],
        action: { type: 'bill', id: b.id, projectId: p.id },
        projectId: p.id,
      });
    }
  }
  const exps = await ctx.tx.query<{ id: string; name: string; date: string; total: number; text: string | null; customer_id: string | null }>(
    `select id, name, expense_date::text as date, total::float8 as total, coalesce(name, '') || ' ' || coalesce(notes, '') || ' ' || coalesce(reference, '') as text, customer_id from expenses
      where tenant_id = $1 and project_id is null and status not in ('void','rejected') and deleted_at is null and expense_date >= current_date - 400
        and ($2::text is null or ($2 = 'expense' and id = $3::uuid) or $2 = 'project') ${books(ctx) ? '' : 'and (owner_id = $4 or created_by = $4)'}
      order by expense_date desc limit 200`,
    books(ctx) ? [ctx.tenantId, focus?.type ?? null, focus?.id ?? null] : [ctx.tenantId, focus?.type ?? null, focus?.id ?? null, ctx.principal.user.id],
  );
  for (const e of exps) {
    const named = mentions(e.text ?? '');
    const only = e.customer_id ? byAccount.get(e.customer_id) ?? [] : [];
    const p = named.length === 1 ? named[0]! : only.length === 1 ? only[0]! : null;
    if (!p) continue;
    out.push({
      key: `expense_project:${e.id}:${p.id}`,
      kind: 'expense_project',
      confidence: named.length === 1 ? 0.85 : 0.65,
      title: `Put the expense “${e.name}” on project ${p.name}`,
      reasons: [named.length === 1 ? 'the expense names the project' : 'billed to the project’s customer'],
      left: { type: 'expense', id: e.id, label: e.name, amount: e.total, date: e.date, link: `/o/expense/${e.id}` },
      right: [{ type: 'project', id: p.id, label: p.name, link: `/projects/${p.id}` }],
      action: { type: 'expense', id: e.id, projectId: p.id },
      projectId: p.id,
    });
  }
  return out;
}

/** Approved claims and the bank payment that reimbursed them. */
async function claimsToBank(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (!books(ctx)) return [];
  const claims = await ctx.tx.query<{ id: string; name: string; date: string; total: number; who: string | null; project_id: string | null }>(
    `select e.id, e.name, e.expense_date::text as date, e.total::float8 as total, u.full_name as who, e.project_id from expenses e left join users u on u.tenant_id = e.tenant_id and u.id = coalesce(e.owner_id, e.created_by)
      where e.tenant_id = $1 and e.is_claim and e.status = 'approved' and e.deleted_at is null and ($2::text is null or ($2 = 'expense' and e.id = $3::uuid) or ($2 = 'project' and e.project_id = $3::uuid))
      limit 200`,
    [ctx.tenantId, focus?.type ?? null, focus?.id ?? null],
  );
  const out: Suggestion[] = [];
  for (const c of claims) {
    const lines = await ctx.tx.query<{ id: string; date: string; amount: number; description: string; gl: string; bank: string }>(
      `select t.id, t.txn_date::text as date, t.amount::float8 as amount, t.description, b.gl_account_id as gl, g.name as bank from bank_transactions t join bank_accounts b on b.tenant_id = t.tenant_id and b.id = t.bank_account_id
         join gl_accounts g on g.tenant_id = b.tenant_id and g.id = b.gl_account_id
        where t.tenant_id = $1 and t.status = 'unmatched' and t.amount = $2::numeric * -1 and t.txn_date >= $3::date - 3 and t.txn_date <= $3::date + 60 order by t.txn_date limit 5`,
      [ctx.tenantId, c.total, c.date],
    );
    const first = (c.who ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
    for (const l of lines) {
      const named = first.length >= 3 && l.description.toLowerCase().includes(first);
      out.push({
        key: `claim_bank:${c.id}:${l.id}`,
        kind: 'claim_bank',
        confidence: named ? 0.9 : lines.length === 1 ? 0.7 : 0.5,
        title: `This bank payment reimbursed ${c.who ?? 'the'}’s claim “${c.name}”`,
        reasons: ['same amount', named ? 'the bank line names them' : 'after the claim'],
        left: { type: 'expense', id: c.id, label: c.name, sub: c.who, amount: c.total, date: c.date, link: `/o/expense/${c.id}` },
        right: [{ type: 'bank_line', id: l.id, label: l.description.slice(0, 80), sub: l.bank, amount: l.amount, date: l.date }],
        action: { expenseId: c.id, txnId: l.id, throughId: l.gl, date: l.date },
        projectId: c.project_id,
      });
    }
  }
  return out;
}

/** The accounts desk's pending proposals for bank lines. */
async function bankProposals(ctx: RecordCtx, focus: Focus | null): Promise<Suggestion[]> {
  if (!books(ctx) || (focus && focus.type !== 'invoice' && focus.type !== 'account')) return [];
  const rows = (await listProposals(ctx, 'pending', 300)) as Record<string, any>[];
  return rows
    .filter((p) => !focus || (focus.type === 'invoice' && p.payload?.invoiceId === focus.id))
    .map((p) => ({
      key: `bank:${p.id}`,
      kind: 'bank' as Kind,
      confidence: Number(p.confidence),
      title: String(p.title),
      reasons: String(p.reason ?? '').split('; ').filter(Boolean),
      left: { type: 'bank_line', id: String(p.txn_id), label: String(p.description ?? '').slice(0, 90), sub: `${p.bank_account}${p.reference ? ` · ${p.reference}` : ''}`, amount: Number(p.amount), date: p.txn_date },
      right: [],
      action: { proposalId: p.id },
    }));
}

/* ───────────────────────── list, apply, reject ───────────────────────── */

const GENERATORS: [(ctx: RecordCtx, f: Focus | null) => Promise<Suggestion[]>, Kind[], string][] = [
  [receiptsToInvoices, ['receipt_invoice'], 'Receipts'],
  [receiptsToMilestones, ['receipt_milestone'], 'Receipts and milestones'],
  [vendorPaymentsToBills, ['vendor_payment_bill'], 'Payments made'],
  [milestonesToInvoices, ['milestone_invoice'], 'Milestones'],
  [milestonesDone, ['milestone_done'], 'Milestone approvals'],
  [toProjects, ['invoice_project', 'bill_project', 'expense_project'], 'Projects'],
  [claimsToBank, ['claim_bank'], 'Claims'],
  [bankProposals, ['bank'], 'Bank lines'],
];

export async function suggestions(ctx: RecordCtx, opts: { kind?: Kind | null; focus?: Focus | null } = {}) {
  const rejected = new Set(
    (await ctx.tx.query<{ key: string }>(`select key from reconcile_decisions where tenant_id = $1 and status = 'rejected' and decided_at > now() - interval '365 days'`, [ctx.tenantId])).map((r) => r.key),
  );
  const all: Suggestion[] = [];
  const errors: string[] = [];
  for (const [gen, kinds, label] of GENERATORS) {
    if (opts.kind && !kinds.includes(opts.kind)) continue;
    try {
      await ctx.tx.query('savepoint rc_gen');
      all.push(...(await gen(ctx, opts.focus ?? null)));
      await ctx.tx.query('release savepoint rc_gen');
    } catch (e) {
      await ctx.tx.query('rollback to savepoint rc_gen');
      errors.push(`${label}: ${(e as Error).message}`);
    }
  }
  const items = all.filter((s) => !rejected.has(s.key) && (!opts.kind || s.kind === opts.kind)).sort((a, b) => b.confidence - a.confidence);
  const counts: Record<string, number> = {};
  for (const s of items) counts[s.kind] = (counts[s.kind] ?? 0) + 1;
  return { items, counts, labels: KIND_LABELS, errors };
}

export const applySchema = z.object({
  items: z
    .array(
      z.object({
        key: z.string().max(300),
        kind: z.enum(['receipt_invoice', 'receipt_milestone', 'vendor_payment_bill', 'milestone_invoice', 'milestone_done', 'invoice_project', 'bill_project', 'expense_project', 'claim_bank', 'bank']),
        action: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(200),
});

const id = z.string().uuid();
const allocs = z.array(z.object({ invoiceId: id, amount: z.number().positive().max(1e12) })).min(1).max(50);

/** Records TDS / GST TDS the customer kept: the receipt then settles that much more of the invoice. */
async function addDeductions(ctx: RecordCtx, paymentId: string, tds: number, gstTds: number) {
  if (tds <= 0 && gstTds <= 0) return;
  if (!hasAdmin(ctx.principal.permissions, 'books') && !hasAdmin(ctx.principal.permissions, 'billing') && !ctx.principal.user.isOwner) throw forbidden('Recording TDS needs the billing or books permission');
  const p = await ctx.tx.one<{ currency: string }>(`select coalesce(currency, 'INR') as currency from payments where tenant_id = $1 and id = $2 and status = 'received' for update`, [ctx.tenantId, paymentId]);
  if (!p) throw badRequest('Receipt not found');
  if (p.currency !== 'INR') throw badRequest('TDS is recorded on rupee receipts only');
  await ctx.tx.query(`update payments set amount = amount + $3, tds_amount = tds_amount + $4, gst_tds_amount = gst_tds_amount + $5 where tenant_id = $1 and id = $2`, [ctx.tenantId, paymentId, r2(tds + gstTds), r2(tds), r2(gstTds)]);
  await repost(ctx.tx, ctx.tenantId, 'payment', paymentId);
}

async function applyOne(ctx: RecordCtx, kind: Kind, a: Record<string, unknown>): Promise<RecordEvent[]> {
  switch (kind) {
    case 'receipt_invoice': {
      const b = z.object({ paymentId: id, allocations: allocs, tds: z.number().min(0).max(1e11).default(0), gstTds: z.number().min(0).max(1e11).default(0) }).parse(a);
      await addDeductions(ctx, b.paymentId, b.tds, b.gstTds);
      return allocatePayment(ctx, b.paymentId, b.allocations);
    }
    case 'vendor_payment_bill': {
      const b = z.object({ paymentId: id, allocations: z.array(z.object({ billId: id, amount: z.number().positive() })).min(1).max(50) }).parse(a);
      return allocateVendorPayment(ctx, b.paymentId, b.allocations);
    }
    case 'milestone_invoice': {
      const b = z.object({ projectId: id, milestoneId: id, invoiceId: id }).parse(a);
      const { linkInvoice } = await import('./milestone-billing');
      await linkInvoice(ctx, b.projectId, b.milestoneId, b.invoiceId);
      return [];
    }
    case 'milestone_done': {
      const b = z.object({ projectId: id, milestoneId: id, activityId: id }).parse(a);
      const m = await ctx.tx.one<Record<string, any>>(`select * from project_milestones where tenant_id = $1 and id = $2 and project_id = $3`, [ctx.tenantId, b.milestoneId, b.projectId]);
      if (!m) throw badRequest('Milestone not found');
      await saveMilestone(ctx, b.projectId, b.milestoneId, {
        name: m.name, startDate: m.start_date ? String(m.start_date instanceof Date ? m.start_date.toISOString() : m.start_date).slice(0, 10) : null,
        dueDate: m.due_date ? String(m.due_date instanceof Date ? m.due_date.toISOString() : m.due_date).slice(0, 10) : null,
        amount: m.amount == null ? null : Number(m.amount), ownerId: m.owner_id, status: 'done', approvalActivityId: b.activityId,
      });
      return [];
    }
    case 'invoice_project':
    case 'bill_project':
    case 'expense_project': {
      const b = z.object({ type: z.enum(['invoice', 'bill', 'expense']), id, projectId: id }).parse(a);
      await projectAccess(ctx, b.projectId, 'manage');
      if (b.type === 'invoice') {
        if (!billingOk(ctx)) throw forbidden('You cannot change invoices');
        const r = await ctx.tx.one(`update invoices set project_id = $3 where tenant_id = $1 and id = $2 and project_id is null returning id`, [ctx.tenantId, b.id, b.projectId]);
        if (!r) throw badRequest('The invoice is already on a project');
        await ctx.tx.query(`update invoice_lines set project_id = $3 where tenant_id = $1 and order_id = $2 and project_id is null and exists (select 1 from invoices where tenant_id = $1 and id = $2 and status = 'draft')`, [ctx.tenantId, b.id, b.projectId]);
      } else if (b.type === 'bill') {
        if (!books(ctx)) throw forbidden('Booking bills to projects needs the books permission');
        await ctx.tx.query(`update bill_lines set project_id = $3 where tenant_id = $1 and order_id = $2 and project_id is null`, [ctx.tenantId, b.id, b.projectId]);
      } else {
        const r = await ctx.tx.one(`update expenses set project_id = $3 where tenant_id = $1 and id = $2 and project_id is null and (owner_id = $4 or created_by = $4 or $5) returning id`, [ctx.tenantId, b.id, b.projectId, ctx.principal.user.id, books(ctx)]);
        if (!r) throw badRequest('That expense is already on a project, or not yours');
      }
      return [];
    }
    case 'claim_bank': {
      const b = z.object({ expenseId: id, txnId: id, throughId: id, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(a);
      const ev = await expenseAction(ctx, b.expenseId, 'reimburse', { throughId: b.throughId, date: b.date });
      // the reimbursement's bank line in the ledger is this statement line
      const line = await ctx.tx.one<{ id: string }>(
        `select l.id from journal_lines l join journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
          where l.tenant_id = $1 and j.source_type = 'reimbursement' and j.source_id = $2 and l.account_id = $3 and l.posted and l.bank_txn_id is null limit 1`,
        [ctx.tenantId, b.expenseId, b.throughId],
      );
      if (line) await matchTxn(ctx, b.txnId, line.id);
      return ev;
    }
    case 'bank': {
      const b = z.object({ proposalId: id }).parse(a);
      await decide(ctx, b.proposalId, { decision: 'approve' });
      return [];
    }
    case 'receipt_milestone':
      throw badRequest('Raise the milestone’s invoice first (it opens on the project’s Billing tab)');
  }
}

export async function apply(ctx: RecordCtx, input: z.infer<typeof applySchema>) {
  const results: { key: string; ok: boolean; error?: string }[] = [];
  const events: RecordEvent[] = [];
  for (const it of input.items) {
    try {
      await ctx.tx.query('savepoint rc_apply');
      events.push(...(await applyOne(ctx, it.kind, it.action)));
      await ctx.tx.query(
        `insert into reconcile_decisions (tenant_id, key, kind, status, detail) values ($1,$2,$3,'approved',$4) on conflict (tenant_id, key) do update set status = 'approved', detail = excluded.detail, decided_at = now(), decided_by = app.current_user_id()`,
        [ctx.tenantId, it.key, it.kind, JSON.stringify(it.action)],
      );
      await ctx.tx.query('release savepoint rc_apply');
      results.push({ key: it.key, ok: true });
    } catch (e) {
      await ctx.tx.query('rollback to savepoint rc_apply');
      results.push({ key: it.key, ok: false, error: (e as Error).message.slice(0, 300) });
    }
  }
  return { results, events };
}

export async function reject(ctx: RecordCtx, keys: string[]) {
  for (const key of keys) {
    const kind = key.split(':')[0]!;
    if (kind === 'bank') {
      try {
        await ctx.tx.query('savepoint rc_rej');
        await decide(ctx, key.split(':')[1]!, { decision: 'reject' });
        await ctx.tx.query('release savepoint rc_rej');
      } catch {
        await ctx.tx.query('rollback to savepoint rc_rej');
      }
      continue;
    }
    await ctx.tx.query(
      `insert into reconcile_decisions (tenant_id, key, kind, status) values ($1,$2,$3,'rejected') on conflict (tenant_id, key) do update set status = 'rejected', decided_at = now(), decided_by = app.current_user_id()`,
      [ctx.tenantId, key.slice(0, 300), kind.slice(0, 40)],
    );
  }
  return { ok: true };
}
