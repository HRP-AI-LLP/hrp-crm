/**
 * Books API (the accounting app).
 *   booksRoutes → /api/v1/books/…   bills, vendor payments and expenses follow object permissions;
 *                                   everything else (ledger, banking, reports, setup) needs the
 *                                   "books" admin permission.
 */
import { setStatementPassword } from '../services/books/statement-mail';
import { hasAdmin } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import * as bank from '../services/books/banking';
import * as ownAcc from '../services/books/own-accounts';
import {
  applyVendorCredit,
  allocateVendorPayment,
  billFromPo,
  billLineSchema,
  getBill,
  getVendorPayment,
  payables,
  postBill,
  recomputeBill,
  recordVendorPayment,
  saveBillLines,
  vendorCreditFrom,
  voidBill,
  voidVendorPayment,
} from '../services/books/bills';
import { expenseAction, expenseBooks, setExpenseAccounts } from '../services/books/expenses';
import * as rep from '../services/books/reports';
import * as desk from '../services/books/desk';
import * as docs from '../services/books/doc-import';
import { attachSourceFiles, keepSourceFiles } from '../services/books/import-files';
import * as dunning from '../services/books/dunning';
import * as feeds from '../services/books/feeds';
import * as g2b from '../services/books/gstr2b';
import * as setup from '../services/books/setup';
import { enqueue, eventJobs } from '../services/jobs';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1990-01-01' && s <= '2100-12-31';
  }, 'Not a valid date');
const money = z.number().finite().min(0).max(1e12);
const signed = z.number().finite().min(-1e12).max(1e12);
const today = () => new Date().toISOString().slice(0, 10);

type C = { var: AppEnv['Variables']; env: AppEnv['Bindings'] } & Parameters<typeof safeCtx>[0];

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
function requireBooks(c: { var: AppEnv['Variables'] }) {
  if (!enabledApps(c.var.meta).has('books')) throw notFound('Books is switched off for the workspace');
}
function requireAdmin(c: { var: AppEnv['Variables'] }) {
  requireBooks(c);
  if (!hasAdmin(c.var.principal.permissions, 'books')) throw forbidden('Requires the "books" admin permission');
}
async function emit(c: C, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}
/** The accounts desk acts as the signed-in user; AI goes through the workspace's own model settings. */
function deskDeps(c: C): desk.DeskDeps {
  return {
    env: c.env,
    db: c.var.db,
    tenantId: c.var.tenant.id,
    run: (fn, readOnly = false) => c.var.db.tx(scope(c, readOnly), (tx) => fn(rctx(c, tx))),
    ai: { env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, requestId: c.var.requestId, meta: c.var.meta },
  };
}
const AGENT = z.enum(['bank_clerk', 'bookkeeper', 'compliance', 'controller']);
const q = (c: { req: { query: (k: string) => string | undefined } }, k: string) => c.req.query(k) || null;
const qDate = (c: { req: { query: (k: string) => string | undefined } }, k: string, dflt: string) => {
  const v = c.req.query(k);
  if (!v) return dflt;
  if (!dateStr.safeParse(v).success) throw badRequest(`${k} must be a date (YYYY-MM-DD)`);
  return v;
};
const qUuid = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed with '). */
export function toCsv(rows: Record<string, unknown>[], columns?: string[]) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    let s = v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((k) => cell(r[k])).join(','))].join('\r\n');
}
function csvResponse(name: string, rows: Record<string, unknown>[], columns?: string[]) {
  return new Response(toCsv(rows, columns), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}.csv"` } });
}

const fyFrom = () => rep.fyStart(today());

const journalLine = z.object({
  accountId: uuid,
  debit: money.optional(),
  credit: money.optional(),
  description: z.string().max(500).nullish(),
  partyType: z.enum(['customer', 'vendor', 'employee']).nullish(),
  partyId: uuid.nullish(),
  projectId: uuid.nullish(),
});
const journalSchema = z.object({ date: dateStr, reference: z.string().max(120).nullish(), narration: z.string().max(2000).nullish(), lines: z.array(journalLine).min(2).max(200) });

export const booksRoutes = new Hono<AppEnv>()
  /* ───── payables: bills, vendor credits, vendor payments ───── */
  .get('/books/bills/:id', async (c) => {
    requireBooks(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getBill(rctx(c, tx), qUuid(c))));
  })
  .put('/books/bills/:id/lines', async (c) => {
    requireBooks(c);
    const b = z.object({ lines: z.array(billLineSchema).max(300), taxInclusive: z.boolean().optional() }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => saveBillLines(rctx(c, tx), qUuid(c), b.lines, b.taxInclusive)));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getBill(rctx(c, tx), qUuid(c))));
  })
  .post('/books/bills/:id/recalculate', async (c) => {
    requireBooks(c);
    await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const { loadRow } = await import('../services/records');
      const { row } = await loadRow(ctx, 'bill', qUuid(c), 'update', true);
      if (row.status !== 'draft') throw badRequest('Only drafts recalculate');
      await recomputeBill(ctx, qUuid(c));
    });
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getBill(rctx(c, tx), qUuid(c))));
  })
  .post('/books/bills/:id/post', async (c) => {
    requireBooks(c);
    await emit(c, await c.var.db.tx(scope(c), (tx) => postBill(rctx(c, tx), qUuid(c))));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getBill(rctx(c, tx), qUuid(c))));
  })
  .post('/books/bills/:id/void', async (c) => {
    requireBooks(c);
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => voidBill(rctx(c, tx), qUuid(c), b.reason)));
    return c.json({ ok: true });
  })
  .post('/books/bills/:id/vendor-credit', async (c) => {
    requireBooks(c);
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => vendorCreditFrom(rctx(c, tx), qUuid(c), b.reason)), 201);
  })
  .post('/books/bills/:id/apply-credit', async (c) => {
    requireBooks(c);
    const b = z.object({ plan: z.array(z.object({ billId: uuid, amount: money.positive() })).min(1).max(100) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => applyVendorCredit(rctx(c, tx), qUuid(c), b.plan)));
    return c.json({ ok: true });
  })
  .post('/books/purchase-orders/:id/bill', async (c) => {
    requireBooks(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => billFromPo(rctx(c, tx), qUuid(c))), 201);
  })
  .get('/books/payables', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => payables(rctx(c, tx), qDate(c, 'asOf', today()))));
  })
  .post('/books/vendor-payments', async (c) => {
    requireBooks(c);
    const b = z
      .object({
        vendorId: uuid,
        amount: money.positive(),
        date: dateStr.nullish(),
        mode: z.enum(['cash', 'cheque', 'bank_transfer', 'upi', 'card', 'other']).nullish(),
        paidThroughId: uuid.nullish(),
        reference: z.string().max(120).nullish(),
        notes: z.string().max(2000).nullish(),
        currency: z.string().regex(/^[A-Z]{3}$/).optional(),
        exchangeRate: z.number().positive().max(1e6).optional(),
        allocations: z.union([z.literal('auto'), z.array(z.object({ billId: uuid, amount: money.positive() })).max(200)]).nullish(),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => recordVendorPayment(rctx(c, tx), b));
    await emit(c, r.events);
    return c.json({ id: r.id, number: r.number }, 201);
  })
  .get('/books/vendor-payments/:id', async (c) => {
    requireBooks(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getVendorPayment(rctx(c, tx), qUuid(c))));
  })
  .post('/books/vendor-payments/:id/allocate', async (c) => {
    requireBooks(c);
    const b = z.object({ allocations: z.union([z.literal('auto'), z.array(z.object({ billId: uuid, amount: money }).strict()).max(200)]) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => allocateVendorPayment(rctx(c, tx), qUuid(c), b.allocations)));
    return c.json({ ok: true });
  })
  .post('/books/vendor-payments/:id/void', async (c) => {
    requireBooks(c);
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => voidVendorPayment(rctx(c, tx), qUuid(c), b.reason)));
    return c.json({ ok: true });
  })

  /* ───── expenses and claims ───── */
  .get('/books/expenses/:id', async (c) => {
    requireBooks(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => expenseBooks(rctx(c, tx), qUuid(c))));
  })
  .put('/books/expenses/:id/accounts', async (c) => {
    requireBooks(c);
    const b = z.object({ accountId: uuid.nullable(), paidThroughId: uuid.nullable() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => setExpenseAccounts(rctx(c, tx), qUuid(c), b.accountId, b.paidThroughId));
    return c.json({ ok: true });
  })
  .post('/books/expenses/:id/:action{submit|approve|reject|record|reimburse|void}', async (c) => {
    requireBooks(c);
    const b = z.object({ reason: z.string().trim().max(500).optional(), throughId: uuid.nullish(), date: dateStr.nullish() }).parse(await c.req.json().catch(() => ({})));
    const action = c.req.param('action') as 'submit';
    await emit(c, await c.var.db.tx(scope(c), (tx) => expenseAction(rctx(c, tx), qUuid(c), action, b)));
    return c.json({ ok: true });
  })
  .get('/books/expense-categories', async (c) => {
    requireBooks(c);
    // what anyone filing an expense may pick: active expense and asset accounts, and payment accounts
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select id, code, name, type, subtype from gl_accounts where tenant_id = $1 and is_active and (type = 'expense' or subtype in ('fixed_asset','current_asset','bank','cash','credit_card')) order by type desc, code nulls last, name`,
          [c.var.tenant.id],
        ),
      ),
    );
  })

  /* ───── settings ───── */
  .get('/books/settings', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.getSettings(rctx(c, tx))));
  })
  .put('/books/settings', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        enabled: z.boolean().optional(),
        booksOfRecord: z.enum(['synapse', 'tally']).optional(),
        startDate: dateStr.optional(),
        lockDate: dateStr.nullable().optional(),
        tdsEnabled: z.boolean().optional(),
        tan: z.string().regex(/^[A-Za-z]{4}[0-9]{5}[A-Za-z]$/).nullable().optional(),
        pan: z.string().regex(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/).nullable().optional(),
        inventoryOn: z.enum(['bill', 'none']).optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveSettings(rctx(c, tx), b)));
  })

  /* ───── chart of accounts ───── */
  .get('/books/accounts', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.listAccounts(rctx(c, tx), { includeInactive: c.req.query('all') === '1' })));
  })
  .post('/books/accounts', async (c) => {
    requireAdmin(c);
    const b = z.object({ code: z.string().regex(/^[A-Za-z0-9.\-]{1,20}$/).nullish(), name: z.string().trim().min(1).max(150), subtype: z.string().max(40), parentId: uuid.nullish(), description: z.string().max(500).nullish(), currency: z.string().regex(/^[A-Z]{3}$/).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.createAccount(rctx(c, tx), b)), 201);
  })
  .patch('/books/accounts/:id', async (c) => {
    requireAdmin(c);
    const b = z.object({ code: z.string().regex(/^[A-Za-z0-9.\-]{1,20}$/).nullable().optional(), name: z.string().trim().min(1).max(150).optional(), subtype: z.string().max(40).optional(), parentId: uuid.nullable().optional(), description: z.string().max(500).nullable().optional(), isActive: z.boolean().optional() }).strict().parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => setup.updateAccount(rctx(c, tx), qUuid(c), b));
    return c.json({ ok: true });
  })
  .delete('/books/accounts/:id', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => setup.deleteAccount(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  })

  /* ───── journals and opening balances ───── */
  .get('/books/journals', async (c) => {
    requireAdmin(c);
    const r = await c.var.db.tx(scope(c, true), (tx) =>
      setup.listJournals(rctx(c, tx), { from: q(c, 'from'), to: q(c, 'to'), sourceType: q(c, 'source'), status: q(c, 'status'), search: q(c, 'q'), limit: Math.max(1, Math.min(500, Math.trunc(Number(c.req.query('limit') ?? 100)) || 100)), offset: Math.max(0, Math.min(100_000, Math.trunc(Number(c.req.query('offset') ?? 0)) || 0)) }),
    );
    return c.json(r);
  })
  .post('/books/journals', async (c) => {
    requireAdmin(c);
    const b = journalSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.createManualJournal(rctx(c, tx), b)), 201);
  })
  .get('/books/journals/:id', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.getJournal(rctx(c, tx), qUuid(c))));
  })
  .post('/books/journals/:id/void', async (c) => {
    requireAdmin(c);
    const b = z.object({ reason: z.string().trim().min(3).max(300) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => setup.voidJournal(rctx(c, tx), qUuid(c), b.reason));
    return c.json({ ok: true });
  })
  .post('/books/journals/:id/reverse', async (c) => {
    requireAdmin(c);
    const b = z.object({ date: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.reverseJournal(rctx(c, tx), qUuid(c), b.date)), 201);
  })
  .get('/books/opening-balances', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.getOpeningBalances(rctx(c, tx))));
  })
  .put('/books/opening-balances', async (c) => {
    requireAdmin(c);
    const party = z.object({ partyId: uuid, amount: signed });
    const b = z.object({ accounts: z.array(z.object({ accountId: uuid, debit: money.optional(), credit: money.optional() })).max(500), customers: z.array(party).max(5000).optional(), vendors: z.array(party).max(5000).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveOpeningBalances(rctx(c, tx), b)));
  })

  /* ───── receivables extras ───── */
  .post('/books/invoices/:id/write-off', async (c) => {
    requireAdmin(c);
    const b = z.object({ amount: money.nullish(), date: dateStr.nullish(), reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => setup.writeOffInvoice(rctx(c, tx), qUuid(c), b)));
    return c.json({ ok: true });
  })

  /* ───── banking ───── */
  .get('/books/bank-accounts', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.listBankAccounts(rctx(c, tx))));
  })
  .post('/books/bank-accounts', async (c) => {
    requireAdmin(c);
    const b = z.object({ name: z.string().trim().min(1).max(150), kind: z.enum(['bank', 'cash', 'credit_card', 'wallet']), bankName: z.string().max(120).nullish(), last4: z.string().regex(/^\d{4}$/).nullish(), ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).nullish(), code: z.string().regex(/^[A-Za-z0-9.\-]{1,20}$/).nullish() }).merge(bank.cardFields).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.createBankAccount(rctx(c, tx), b)), 201);
  })
  .put('/books/bank-accounts/:id', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        bankName: z.string().max(120).nullish(),
        last4: z.string().regex(/^\d{4}$/).nullish(),
        ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).nullish(),
        statementPassword: z.string().max(100).nullish(),
        statementSenders: z.string().max(500).nullish(),
      })
      .merge(bank.cardFields)
      .parse(await c.req.json());
    await c.var.db.tx(scope(c), async (tx) => {
      await bank.updateBankAccount(rctx(c, tx), qUuid(c), b);
      if (b.statementPassword !== undefined || b.statementSenders !== undefined) await setStatementPassword(rctx(c, tx), c.env, qUuid(c), { password: b.statementPassword, senders: b.statementSenders });
    });
    return c.json({ ok: true });
  })
  .post('/books/bank-accounts/:id/settle', async (c) => {
    requireAdmin(c);
    const b = z.object({ amount: z.number().positive().max(1e10), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().max(300).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.settlePersonalCard(rctx(c, tx), qUuid(c), b)));
  })
  .post('/books/bank-accounts/:id/statement', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        rows: z.array(z.object({ date: dateStr, description: z.string().trim().min(1).max(500), reference: z.string().max(120).nullish(), amount: signed.refine((v) => v !== 0, 'Amount cannot be zero'), balance: signed.nullish() })).min(1).max(5000),
        /** hand the new lines to the accounts desk's bookkeeper instead of applying rules here */
        toDesk: z.boolean().optional(),
      })
      .parse(await c.req.json());
    if (!b.toDesk) return c.json(await c.var.db.tx(scope(c), (tx) => bank.importStatement(rctx(c, tx), qUuid(c), b.rows)));
    const r = await c.var.db.tx(scope(c), (tx) => bank.importStatement(rctx(c, tx), qUuid(c), b.rows, { auto: false }));
    const k = r.added ? await desk.runBookkeeper(deskDeps(c), { trigger: 'import', bankAccountId: qUuid(c) }) : null;
    if (k) await emit(c, k.events);
    return c.json({ ...r, bookkeeper: k ? { ...k, events: undefined } : null });
  })
  .get('/books/bank-accounts/:id/transactions', async (c) => {
    requireAdmin(c);
    const status = z.enum(['unmatched', 'matched', 'categorized', 'excluded', 'all']).parse(c.req.query('status') ?? 'unmatched');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => bank.transactions(rctx(c, tx), qUuid(c), status)));
  })
  .post('/books/bank-accounts/:id/auto', async (c) => {
    requireAdmin(c);
    return c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const ctx = rctx(c, tx);
        const m = await bank.autoMatch(ctx, qUuid(c));
        const r = await bank.applyRules(ctx, qUuid(c));
        return { ...m, ...r };
      }),
    );
  })
  .get('/books/bank-accounts/:id/unreconciled', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => bank.unreconciled(rctx(c, tx), qUuid(c), qDate(c, 'upTo', today()))));
  })
  .post('/books/bank-accounts/:id/reconcile', async (c) => {
    requireAdmin(c);
    const b = z.object({ statementDate: dateStr, closingBalance: signed, lineIds: z.array(uuid).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.reconcile(rctx(c, tx), qUuid(c), b)));
  })
  .post('/books/bank-accounts/:id/undo-reconciliation', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.undoReconciliation(rctx(c, tx), qUuid(c))));
  })
  .get('/books/bank-transactions/:id/suggestions', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => bank.suggestions(rctx(c, tx), qUuid(c))));
  })
  .post('/books/bank-transactions/:id/match', async (c) => {
    requireAdmin(c);
    const b = z.object({ lineId: uuid }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => bank.matchTxn(rctx(c, tx), qUuid(c), b.lineId));
    return c.json({ ok: true });
  })
  .post('/books/bank-transactions/:id/categorize', async (c) => {
    requireAdmin(c);
    const b = z.object({ accountId: uuid, partyType: z.enum(['customer', 'vendor']).nullish(), partyId: uuid.nullish(), description: z.string().max(500).nullish() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => bank.categorize(rctx(c, tx), qUuid(c), b));
    return c.json({ ok: true });
  })
  .post('/books/bank-transactions/:id/undo', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => bank.undoTxn(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  })
  .post('/books/bank-transactions/:id/exclude', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => bank.excludeTxn(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  })
  .post('/books/transfers', async (c) => {
    requireAdmin(c);
    const b = z.object({ fromId: uuid, toId: uuid, amount: money.positive(), date: dateStr, reference: z.string().max(120).nullish(), narration: z.string().max(2000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.transfer(rctx(c, tx), b)), 201);
  })
  .get('/books/bank-rules', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => bank.listRules(rctx(c, tx))));
  })
  .post('/books/bank-rules', async (c) => {
    requireAdmin(c);
    const b = ruleSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.saveRule(rctx(c, tx), null, b)), 201);
  })
  .put('/books/bank-rules/:id', async (c) => {
    requireAdmin(c);
    const b = ruleSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => bank.saveRule(rctx(c, tx), qUuid(c), b)));
  })
  .delete('/books/bank-rules/:id', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => bank.deleteRule(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  })

  /* ───── reports ───── */
  .get('/books/overview', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => rep.booksOverview(rctx(c, tx))));
  })
  .get('/books/cash-forecast', async (c) => {
    requireAdmin(c);
    const weeks = Math.min(26, Math.max(4, Number(c.req.query('weeks') ?? 13) || 13));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => rep.cashForecast(rctx(c, tx), weeks)));
  })
  .get('/books/reminders', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => dunning.reminderSettings(rctx(c, tx))));
  })
  .put('/books/reminders', async (c) => {
    requireAdmin(c);
    const b = dunning.reminderSettingsSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dunning.saveReminderSettings(rctx(c, tx), b)));
  })
  .get('/books/invoices/:id/reminders', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => dunning.remindersOf(rctx(c, tx), qUuid(c))));
  })
  .post('/books/invoices/:id/remind', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => dunning.remindNow(rctx(c, tx), c.env, qUuid(c))));
  })
  .get('/books/reports/:report', async (c) => {
    requireAdmin(c);
    const report = c.req.param('report');
    const from = qDate(c, 'from', fyFrom());
    const to = qDate(c, 'to', today());
    const csv = c.req.query('format') === 'csv';
    const data = await c.var.db.tx(scope(c, true), async (tx) => {
      const ctx = rctx(c, tx);
      switch (report) {
        case 'trial-balance':
          return rep.trialBalance(ctx, to);
        case 'profit-and-loss': {
          const cf = c.req.query('compareFrom');
          const ct = c.req.query('compareTo');
          return rep.profitAndLoss(ctx, from, to, { compareFrom: cf && dateStr.parse(cf), compareTo: ct && dateStr.parse(ct), projectId: c.req.query('projectId') ? uuid.parse(c.req.query('projectId')) : null });
        }
        case 'monthly-profit':
          return rep.monthlyProfit(ctx, from, to);
        case 'balance-sheet':
          return rep.balanceSheet(ctx, to);
        case 'cash-flow':
          return rep.cashFlow(ctx, from, to);
        case 'general-ledger':
          return rep.generalLedger(ctx, uuid.parse(c.req.query('accountId')), from, to, { partyId: c.req.query('partyId') ? uuid.parse(c.req.query('partyId')) : null });
        case 'day-book':
          return rep.dayBook(ctx, from, to, q(c, 'source'));
        case 'customer-statement':
          return rep.partyStatement(ctx, 'customer', uuid.parse(c.req.query('partyId')), from, to);
        case 'vendor-statement':
          return rep.partyStatement(ctx, 'vendor', uuid.parse(c.req.query('partyId')), from, to);
        case 'sales-by-customer':
          return rep.salesByCustomer(ctx, from, to);
        case 'sales-by-item':
          return rep.salesByItem(ctx, from, to);
        case 'purchases-by-vendor':
          return rep.purchasesByVendor(ctx, from, to);
        case 'purchases-by-item':
          return rep.purchasesByItem(ctx, from, to);
        case 'expenses-by-category':
          return rep.expensesByCategory(ctx, from, to);
        case 'payables':
          return payables(ctx, to);
        case 'gstr-3b':
          return rep.gstr3b(ctx, z.string().regex(/^\d{4}-\d{2}$/).parse(c.req.query('month') ?? today().slice(0, 7)));
        case 'tds':
          return rep.tdsReport(ctx, from, to);
        case 'budget-vs-actual':
          return rep.budgetVsActual(ctx, uuid.parse(c.req.query('budgetId')));
        case 'gstr-2b':
          return setup.gstr2bReport(ctx, z.string().regex(/^\d{6}$/).parse(c.req.query('period')));
        default:
          throw notFound('Unknown report');
      }
    });
    if (data == null) throw notFound();
    if (!csv) return c.json(data);
    return csvResponse(`${report}-${from}-${to}`, flatten(report, data));
  })

  /* ───── exchange rates, budgets, assets, GSTR-2B, recurring ───── */
  .get('/books/exchange-rates', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.listRates(rctx(c, tx), q(c, 'currency'))));
  })
  .put('/books/exchange-rates', async (c) => {
    requireAdmin(c);
    const b = z.object({ currency: z.string().regex(/^[A-Z]{3}$/), date: dateStr, rate: z.number().positive().max(1e6) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => setup.saveRate(rctx(c, tx), b.currency, b.date, b.rate));
    return c.json({ ok: true });
  })
  .get('/books/budgets', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.listBudgets(rctx(c, tx))));
  })
  .post('/books/budgets', async (c) => {
    requireAdmin(c);
    const b = budgetSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveBudget(rctx(c, tx), null, b)), 201);
  })
  .put('/books/budgets/:id', async (c) => {
    requireAdmin(c);
    const b = budgetSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveBudget(rctx(c, tx), qUuid(c), b)));
  })
  .delete('/books/budgets/:id', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => setup.deleteBudget(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  })
  .get('/books/assets', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.listAssets(rctx(c, tx))));
  })
  .post('/books/assets', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        name: z.string().trim().min(1).max(150),
        assetAccountId: uuid.nullish(),
        purchaseDate: dateStr,
        inServiceDate: dateStr.nullish(),
        cost: money.positive(),
        salvageValue: money.optional(),
        method: z.enum(['slm', 'wdv']),
        ratePct: z.number().positive().max(100).nullish(),
        lifeMonths: z.number().int().positive().max(1200).nullish(),
        location: z.string().max(200).nullish(),
        serialNo: z.string().max(120).nullish(),
        billId: uuid.nullish(),
        paidThroughId: uuid.nullish(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.createAsset(rctx(c, tx), b)), 201);
  })
  .post('/books/assets/depreciate', async (c) => {
    requireAdmin(c);
    const b = z.object({ upTo: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.runDepreciation(rctx(c, tx), b.upTo)));
  })
  .post('/books/assets/:id/dispose', async (c) => {
    requireAdmin(c);
    const b = z.object({ date: dateStr, amount: money, depositToId: uuid.nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.disposeAsset(rctx(c, tx), qUuid(c), b)));
  })
  .post('/books/gstr-2b', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        period: z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/),
        rows: z
          .array(
            z.object({
              supplierGstin: z.string().regex(/^[0-9]{2}[A-Za-z0-9]{13}$/),
              supplierName: z.string().max(200).nullish(),
              docNumber: z.string().trim().min(1).max(60),
              docDate: dateStr.nullish(),
              docType: z.string().max(20).nullish(),
              taxable: signed,
              igst: signed.optional(),
              cgst: signed.optional(),
              sgst: signed.optional(),
              itcAvailable: z.boolean().optional(),
            }),
          )
          .max(20000),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.importGstr2b(rctx(c, tx), b.period, b.rows)));
  })
  // ── the accounts desk: agents that keep the books, people approve what matters ──
  .get('/books/desk', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.deskOverview(rctx(c, tx))));
  })
  .put('/books/desk/settings', async (c) => {
    requireAdmin(c);
    const b = desk.settingsSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => desk.saveSettings(rctx(c, tx), b)));
  })
  // ── own accounts: owners / partners and their personal accounts, the company's other accounts ──
  .get('/books/desk/own', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => ownAcc.listOwn(rctx(c, tx))));
  })
  .post('/books/desk/own/persons', async (c) => {
    requireAdmin(c);
    const b = ownAcc.personSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => ownAcc.savePerson(rctx(c, tx), null, b));
    const k = await desk.runBookkeeper(deskDeps(c), { trigger: 'manual' }).catch(() => null);
    if (k) await emit(c, k.events);
    return c.json({ ...r, proposed: k?.proposed ?? 0, applied: k?.applied ?? 0 });
  })
  .put('/books/desk/own/persons/:id', async (c) => {
    requireAdmin(c);
    const b = ownAcc.personSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => ownAcc.savePerson(rctx(c, tx), qUuid(c), b));
    const k = await desk.runBookkeeper(deskDeps(c), { trigger: 'manual' }).catch(() => null);
    if (k) await emit(c, k.events);
    return c.json({ ...r, proposed: k?.proposed ?? 0, applied: k?.applied ?? 0 });
  })
  .delete('/books/desk/own/persons/:id', async (c) => {
    requireAdmin(c);
    const r = await c.var.db.tx(scope(c), (tx) => ownAcc.deletePerson(rctx(c, tx), qUuid(c)));
    if (c.env.FILES) await Promise.all(r.storageKeys.map((k) => c.env.FILES!.delete(k).catch(() => undefined)));
    return c.json({ ok: true });
  })
  .put('/books/desk/own/banks/:id', async (c) => {
    requireAdmin(c);
    const b = ownAcc.bankIdentsSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => ownAcc.saveBankIdents(rctx(c, tx), qUuid(c), b));
    const k = await desk.runBookkeeper(deskDeps(c), { trigger: 'manual' }).catch(() => null);
    if (k) await emit(c, k.events);
    return c.json({ ok: true, proposed: k?.proposed ?? 0, applied: k?.applied ?? 0 });
  })
  .get('/books/desk/own/misbooked', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => ownAcc.misbooked(rctx(c, tx))));
  })
  .post('/books/desk/own/rebook', async (c) => {
    requireAdmin(c);
    const b = z.object({ txnIds: z.array(z.string().uuid()).min(1).max(500) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => ownAcc.unbookForOwn(rctx(c, tx), b.txnIds));
    await emit(c, r.events);
    const k = r.undone ? await desk.runBookkeeper(deskDeps(c), { trigger: 'manual' }).catch(() => null) : null;
    if (k) await emit(c, k.events);
    return c.json({ undone: r.undone, skipped: r.skipped, proposed: k?.proposed ?? 0, applied: k?.applied ?? 0 });
  })
  .post('/books/desk/run', async (c) => {
    requireAdmin(c);
    const b = z.object({ agents: z.array(AGENT).min(1).max(4).optional(), period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullish() }).parse(await c.req.json().catch(() => ({})));
    const r = await desk.runDesk(deskDeps(c), { trigger: 'manual', agents: b.agents, period: b.period ?? null });
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  .get('/books/desk/runs', async (c) => {
    requireAdmin(c);
    const a = c.req.query('agent');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.listRuns(rctx(c, tx), a ? AGENT.parse(a) : null)));
  })
  .get('/books/desk/proposals', async (c) => {
    requireAdmin(c);
    const st = z.enum(['pending', 'applied', 'rejected', 'failed', 'stale', 'done', 'all']).parse(c.req.query('status') ?? 'pending');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.listProposals(rctx(c, tx), st)));
  })
  .post('/books/desk/proposals/approve', async (c) => {
    requireAdmin(c);
    const b = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => desk.approveMany(rctx(c, tx), b.ids));
    await emit(c, r.events);
    return c.json({ results: r.results, approved: r.approved });
  })
  .post('/books/desk/proposals/:id', async (c) => {
    requireAdmin(c);
    const b = desk.decideSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => desk.decide(rctx(c, tx), qUuid(c), b));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  .get('/books/desk/open-documents', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.openDocuments(rctx(c, tx))));
  })
  .get('/books/desk/findings', async (c) => {
    requireAdmin(c);
    const st = z.enum(['open', 'done', 'dismissed', 'all']).parse(c.req.query('status') ?? 'open');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.listFindings(rctx(c, tx), st)));
  })
  .post('/books/desk/findings/:id/fix', async (c) => {
    requireAdmin(c);
    const b = z.object({ action: z.string().min(1).max(40) }).parse(await c.req.json());
    const r = await desk.fixFinding(deskDeps(c), qUuid(c), b.action);
    await emit(c, r.events);
    return c.json({ message: r.message, cleared: r.cleared });
  })
  .get('/books/desk/unbooked', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => desk.unbookedGroups(rctx(c, tx))));
  })
  .post('/books/desk/unbooked/book', async (c) => {
    requireAdmin(c);
    const b = desk.bookGroupSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => desk.bookGroup(rctx(c, tx), b));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  .post('/books/desk/findings/:id', async (c) => {
    requireAdmin(c);
    const b = z.object({ status: z.enum(['done', 'dismissed', 'open']) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => desk.resolveFinding(rctx(c, tx), qUuid(c), b.status)));
  })
  // ── importing invoices raised elsewhere (approved one by one, nothing created before that) ──
  .get('/books/imports', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => docs.listBatches(rctx(c, tx))));
  })
  .post('/books/imports', async (c) => {
    requireAdmin(c);
    const b = z.object({ name: z.string().trim().max(200).nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => docs.createBatch(rctx(c, tx), b.name ?? null)), 201);
  })
  .get('/books/imports/:id', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => docs.batchItems(rctx(c, tx), qUuid(c))));
  })
  .post('/books/imports/:id/files', async (c) => {
    requireAdmin(c);
    const b = docs.fileSchema.parse(await c.req.json());
    const d = deskDeps(c);
    const r = await docs.stageFile({ run: (fn) => d.run(fn), ai: d.ai }, qUuid(c), b);
    // the file itself is kept with what was read from it, for the invoice it becomes
    await c.var.db.tx(scope(c), (tx) => keepSourceFiles(rctx(c, tx), c.env, r.ids, b)).catch(() => undefined);
    return c.json(r);
  })
  .patch('/books/imports/items/:id', async (c) => {
    requireAdmin(c);
    const b = z.object({ data: docs.invoiceDataSchema.optional(), choices: docs.choicesSchema.optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => docs.updateItem(rctx(c, tx), qUuid(c), b)));
  })
  .post('/books/imports/items/:id/ai', async (c) => {
    requireAdmin(c);
    const d = deskDeps(c);
    return c.json(await docs.rereadWithAi({ run: (fn) => d.run(fn), ai: d.ai }, qUuid(c)));
  })
  .post('/books/imports/items/:id/reject', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => docs.rejectItem(rctx(c, tx), qUuid(c))));
  })
  .post('/books/imports/reject-waiting', async (c) => {
    requireAdmin(c);
    const b = z.object({ importId: uuid.nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => docs.rejectWaiting(rctx(c, tx), b.importId ?? null)));
  })
  .post('/books/imports/items/approve', async (c) => {
    requireAdmin(c);
    const b = z.object({ ids: z.array(uuid).min(1).max(500) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => docs.approveMany(rctx(c, tx), b.ids));
    await emit(c, r.events);
    await c.var.db.tx(scope(c), (tx) => attachSourceFiles(rctx(c, tx), c.env, r.results)).catch(() => undefined);
    // receipts not tied to a bank line yet, and everything else in the bank, go to the bookkeeper
    const k = r.approved ? await desk.runBookkeeper(deskDeps(c), { trigger: 'import' }).catch(() => null) : null;
    if (k) await emit(c, k.events);
    return c.json({ results: r.results, approved: r.approved, bookkeeper: k ? { applied: k.applied, waiting: k.waiting, summary: k.summary } : null });
  })
  // live bank feeds (the bank clerk's sources)
  .get('/books/feeds', async (c) => {
    requireAdmin(c);
    return c.json({ providers: feeds.feedProviders(), feeds: await c.var.db.tx(scope(c, true), (tx) => feeds.listFeeds(rctx(c, tx))) });
  })
  .post('/books/feeds', async (c) => {
    requireAdmin(c);
    const b = z
      .object({
        bankAccountId: uuid,
        provider: z.enum(['razorpayx']),
        accountRef: z.string().trim().regex(/^[A-Za-z0-9_-]{3,40}$/, 'Enter the account number shown in RazorpayX'),
        keyId: z.string().trim().min(8).max(100),
        keySecret: z.string().trim().min(8).max(200),
        label: z.string().trim().max(120).nullish(),
        syncFrom: dateStr.nullish(),
      })
      .parse(await c.req.json());
    return c.json(await feeds.connectFeed(deskDeps(c), b), 201);
  })
  .patch('/books/feeds/:id', async (c) => {
    requireAdmin(c);
    const b = z.object({ status: z.enum(['active', 'paused']) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => feeds.updateFeed(rctx(c, tx), qUuid(c), b)));
  })
  .delete('/books/feeds/:id', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => feeds.deleteFeed(rctx(c, tx), qUuid(c))));
  })
  .post('/books/feeds/:id/sync', async (c) => {
    requireAdmin(c);
    const r = await feeds.syncFeed(deskDeps(c), qUuid(c));
    // new lines go straight to the bookkeeper
    const k = r.added ? await desk.runBookkeeper(deskDeps(c), { trigger: 'feed', bankAccountId: r.bankAccountId }) : null;
    if (k) await emit(c, k.events);
    return c.json({ ...r, bookkeeper: k ? { ...k, events: undefined } : null });
  })
  // GSTR-2B documents not in the books: match again, link by hand, or enter as bills (no GST provider call)
  .post('/books/gstr-2b/:period/rematch', async (c) => {
    requireAdmin(c);
    const period = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/).parse(c.req.param('period'));
    return c.json(await c.var.db.tx(scope(c), (tx) => g2b.rematchGstr2b(rctx(c, tx), period)));
  })
  .get('/books/gstr-2b/lines/:id/candidates', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => g2b.gstr2bCandidates(rctx(c, tx), qUuid(c))));
  })
  .post('/books/gstr-2b/lines/:id/link', async (c) => {
    requireAdmin(c);
    const b = z.object({ billId: uuid }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => g2b.linkGstr2b(rctx(c, tx), qUuid(c), b.billId)));
  })
  .delete('/books/gstr-2b/lines/:id/link', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => g2b.unlinkGstr2b(rctx(c, tx), qUuid(c))));
  })
  .post('/books/gstr-2b/add-to-books', async (c) => {
    requireAdmin(c);
    const b = z.object({ lineIds: z.array(uuid).min(1).max(500), accountId: uuid.nullish(), post: z.boolean().default(true) }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => g2b.addGstr2bToBooks(rctx(c, tx), b));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  .get('/books/recurring', async (c) => {
    requireAdmin(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => setup.listRecurring(rctx(c, tx))));
  })
  .post('/books/recurring', async (c) => {
    requireAdmin(c);
    const b = recurringSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveRecurring(rctx(c, tx), null, b)), 201);
  })
  .put('/books/recurring/:id', async (c) => {
    requireAdmin(c);
    const b = recurringSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => setup.saveRecurring(rctx(c, tx), qUuid(c), b)));
  })
  .post('/books/recurring/:id/:action{pause|resume|run}', async (c) => {
    requireAdmin(c);
    const action = c.req.param('action');
    if (action === 'run') {
      const r = await c.var.db.tx(scope(c), (tx) => setup.runRecurring(rctx(c, tx), qUuid(c)));
      await emit(c, r.events);
      return c.json({ id: r.id });
    }
    await c.var.db.tx(scope(c), (tx) => setup.setRecurringStatus(rctx(c, tx), qUuid(c), action === 'pause' ? 'paused' : 'active'));
    return c.json({ ok: true });
  })
  .delete('/books/recurring/:id', async (c) => {
    requireAdmin(c);
    await c.var.db.tx(scope(c), (tx) => setup.deleteRecurring(rctx(c, tx), qUuid(c)));
    return c.json({ ok: true });
  });

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  bankAccountId: uuid.nullish(),
  direction: z.enum(['in', 'out', 'any']),
  contains: z.string().trim().min(2).max(120),
  accountId: uuid,
  partyType: z.enum(['customer', 'vendor']).nullish(),
  partyId: uuid.nullish(),
  priority: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
});
const budgetSchema = z.object({ name: z.string().trim().min(1).max(120), financialYear: z.string().regex(/^\d{4}-\d{2}$/), projectId: uuid.nullish(), lines: z.array(z.object({ accountId: uuid, months: z.array(signed).length(12) })).max(500) });
const recurringSchema = z.object({
  name: z.string().trim().min(1).max(150),
  kind: z.enum(['invoice', 'bill', 'expense', 'journal']),
  template: z.record(z.string(), z.unknown()).refine((t) => JSON.stringify(t).length <= 100_000, 'Template too large'),
  frequency: z.enum(['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']),
  every: z.number().int().min(1).max(12).optional(),
  startDate: dateStr,
  endDate: dateStr.nullish(),
  autoIssue: z.boolean().optional(),
});

/** Turns a report into flat rows for CSV. */
function flatten(report: string, data: any): Record<string, unknown>[] {
  if (Array.isArray(data)) return data;
  switch (report) {
    case 'trial-balance':
      return data.rows;
    case 'profit-and-loss':
      return [
        ...data.sections.flatMap((s: any) => [...s.accounts.map((a: any) => ({ section: s.label, code: a.code, account: a.name, amount: a.amount, compare: a.compare })), { section: s.label, account: `Total ${s.label}`, amount: s.total, compare: s.compare }]),
        { account: 'Gross profit', amount: data.grossProfit },
        { account: 'Operating profit', amount: data.operatingProfit },
        { account: 'Net profit', amount: data.netProfit },
      ];
    case 'balance-sheet':
      return data.groups.flatMap((g: any) => [...g.accounts.map((a: any) => ({ group: g.label, code: a.code, account: a.name, amount: a.amount })), { group: g.label, account: `Total ${g.label}`, amount: g.total }]);
    case 'cash-flow':
      return ['operating', 'investing', 'financing'].flatMap((k) => [...data[k].lines.map((l: any) => ({ activity: k, line: l.label, amount: l.amount })), { activity: k, line: 'Total', amount: data[k].total }]);
    case 'general-ledger':
    case 'customer-statement':
    case 'vendor-statement':
      return [{ entry_date: data.from, description: 'Opening balance', balance: data.opening }, ...data.lines.map((l: any) => ({ entry_date: l.entry_date, number: l.number, source: l.source_type, reference: l.reference, party: l.party, description: l.description ?? l.narration, debit: l.debit, credit: l.credit, balance: l.balance }))];
    case 'day-book':
      return data.journals.flatMap((j: any) => j.lines.map((l: any) => ({ date: j.entry_date, number: j.number, source: j.source_type, reference: j.reference, status: j.status, account: l.account, debit: l.debit, credit: l.credit })));
    case 'payables':
      return data.rows ?? data.vendors ?? [];
    case 'tds':
      return data.payable;
    case 'gstr-2b':
      return data.lines;
    case 'budget-vs-actual':
      return data.rows.map((r: any) => ({ account: r.name, budget: r.budgetTotal, actual: r.actualTotal, variance: r.actualTotal - r.budgetTotal }));
    case 'gstr-3b':
      return [
        { table: '3.1(a) Outward taxable', ...data.outward },
        { table: '3.1(b) Zero rated', ...data.zeroRated },
        { table: '3.1(c) Nil / exempt', taxable: data.nilExempt },
        { table: '3.1(d) Inward reverse charge', ...data.inwardReverseCharge },
        { table: '4(A) ITC available', ...data.itc.total },
        { table: 'Tax payable in cash', ...data.payableInCash },
      ];
    default:
      return [data];
  }
}
