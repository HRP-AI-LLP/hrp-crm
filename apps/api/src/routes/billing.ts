/**
 * GST billing API: invoices and credit notes, payments, receivables, exports.
 *   billingRoutes      → /api/v1
 *   billingAdminRoutes → /api/admin (billing settings)
 */
import { hasAdmin } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import {
  allocatePayment,
  billingSettings,
  cancelInvoice,
  creditNoteFrom,
  getInvoice,
  getPayment,
  invoiceFromOrder,
  issueInvoice,
  milestoneReceipt,
  receivables,
  recordPayment,
  refreshDraft,
  saveInvoiceLines,
  voidPayment,
} from '../services/billing';
import { eInvoiceJson, gstr1, saveIrn, tallyXml } from '../services/gst-exports';
import { enqueue, eventJobs } from '../services/jobs';
import { lineSchema } from '../services/quotes';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
function requireBilling(c: { var: AppEnv['Variables'] }) {
  if (!enabledApps(c.var.meta).has('billing')) throw notFound('GST billing is switched off for the workspace');
}
function requireAccounts(c: { var: AppEnv['Variables'] }) {
  requireBilling(c);
  if (!hasAdmin(c.var.principal.permissions, 'billing')) throw forbidden('GST exports need the billing (accounts) permission');
}
async function emit(c: Parameters<typeof safeCtx>[0] & { env: AppEnv['Bindings']; var: AppEnv['Variables'] }, events: RecordEvent[]) {
  await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}

const invLineSchema = lineSchema.extend({ orderLineId: uuid.nullish(), isService: z.boolean().optional() });

export const billingRoutes = new Hono<AppEnv>()
  .get('/invoices/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getInvoice(rctx(c, tx), c.req.param('id')))))
  .put('/invoices/:id/lines', async (c) => {
    const b = z.object({ lines: z.array(invLineSchema).max(300) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => saveInvoiceLines(rctx(c, tx), c.req.param('id'), b.lines)));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getInvoice(rctx(c, tx), c.req.param('id'))));
  })
  .post('/invoices/:id/recalculate', async (c) => {
    await c.var.db.tx(scope(c), (tx) => refreshDraft(rctx(c, tx), c.req.param('id')));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getInvoice(rctx(c, tx), c.req.param('id'))));
  })
  .post('/invoices/:id/issue', async (c) => {
    await emit(c, await c.var.db.tx(scope(c), (tx) => issueInvoice(rctx(c, tx), c.req.param('id'))));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getInvoice(rctx(c, tx), c.req.param('id'))));
  })
  .post('/invoices/:id/cancel', async (c) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => cancelInvoice(rctx(c, tx), c.req.param('id'), b.reason)));
    return c.json({ ok: true });
  })
  .post('/invoices/:id/credit-note', async (c) => {
    requireBilling(c);
    const b = z.object({ reason: z.string().trim().min(3).max(500), lines: z.array(z.object({ lineId: uuid, quantity: z.number().positive() })).max(300).nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => creditNoteFrom(rctx(c, tx), c.req.param('id'), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .post('/orders/:id/invoices', async (c) => {
    requireBilling(c);
    const b = z.object({ milestoneId: uuid.nullish() }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => invoiceFromOrder(rctx(c, tx), c.req.param('id'), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .get('/invoices/:id/einvoice', async (c) => {
    requireAccounts(c);
    return c.json(await c.var.db.tx(scope(c), (tx) => eInvoiceJson(rctx(c, tx), c.req.param('id'))));
  })
  .put('/invoices/:id/irn', async (c) => {
    requireAccounts(c);
    const b = z.object({ irn: z.string().trim().regex(/^[0-9a-f]{64}$/i, 'IRN is a 64-character hash'), ackNo: z.string().max(30).nullish(), ackDate: z.string().datetime({ offset: true }).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => saveIrn(rctx(c, tx), c.req.param('id'), b.irn.toLowerCase(), b.ackNo ?? null, b.ackDate ?? null)));
  })

  // ---------------------------------------------------------------- payments
  .post('/payments', async (c) => {
    requireBilling(c);
    const b = z
      .object({
        accountId: uuid.nullish(),
        salesOrderId: uuid.nullish(),
        amount: z.number().positive().max(1e12),
        date: dateStr.nullish(),
        mode: z.enum(['cash', 'upi', 'bank_transfer', 'cheque', 'card', 'other']).nullish(),
        reference: z.string().max(120).nullish(),
        notes: z.string().max(2000).nullish(),
        allocations: z.union([z.literal('auto'), z.array(z.object({ invoiceId: uuid, amount: z.number().positive() })).max(100)]).nullish(),
      })
      .parse(await c.req.json());
    if (!b.accountId && !b.salesOrderId) throw badRequest('Choose the customer or the order');
    const r = await c.var.db.tx(scope(c), (tx) => recordPayment(rctx(c, tx), b));
    await emit(c, r.events);
    return c.json({ id: r.id, number: r.number }, 201);
  })
  .get('/payments/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getPayment(rctx(c, tx), c.req.param('id')))))
  .post('/payments/:id/allocate', async (c) => {
    const b = z.object({ allocations: z.union([z.literal('auto'), z.array(z.object({ invoiceId: uuid, amount: z.number().positive() })).min(1).max(100)]) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => allocatePayment(rctx(c, tx), c.req.param('id'), b.allocations)));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getPayment(rctx(c, tx), c.req.param('id'))));
  })
  .post('/payments/:id/void', async (c) => {
    const b = z.object({ reason: z.string().trim().min(3).max(500) }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => voidPayment(rctx(c, tx), c.req.param('id'), b.reason)));
    return c.json({ ok: true });
  })
  .post('/orders/:id/milestones/:mid/receipt', async (c) => {
    requireBilling(c);
    const b = z.object({ amount: z.number().positive().max(1e12), note: z.string().max(500).nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const { recordMilestonePayment } = await import('../services/orders');
      const ev = await recordMilestonePayment(ctx, c.req.param('id'), uuid.parse(c.req.param('mid')), b.amount, b.note ?? null, { asAccounts: hasAdmin(c.var.principal.permissions, 'billing') });
      const p = await milestoneReceipt(ctx, c.req.param('id'), uuid.parse(c.req.param('mid')), b.amount, b.note ?? null);
      return { events: [...ev, ...p.events], number: p.number, id: p.id };
    });
    await emit(c, r.events);
    return c.json({ id: r.id, number: r.number }, 201);
  })

  // ---------------------------------------------------------------- receivables + exports
  .get('/billing/receivables', async (c) => {
    requireBilling(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => receivables(rctx(c, tx))));
  })
  .get('/billing/gstr1', async (c) => {
    requireAccounts(c);
    const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), section: z.enum(['b2b', 'b2cs', 'cdnr', 'hsn', 'summary']).default('summary') }).parse(c.req.query());
    const r = await c.var.db.tx(scope(c), (tx) => gstr1(rctx(c, tx), q.month, q.section));
    if ('content' in r) {
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="${r.filename}"`);
      c.header('x-row-count', String(r.count));
      return c.body(`﻿${r.content}`);
    }
    return c.json(r);
  })
  .get('/billing/tally', async (c) => {
    requireAccounts(c);
    const q = z.object({ from: dateStr, to: dateStr }).parse(c.req.query());
    const r = await c.var.db.tx(scope(c), (tx) => tallyXml(rctx(c, tx), q.from, q.to));
    c.header('content-type', 'application/xml; charset=utf-8');
    c.header('content-disposition', `attachment; filename="${r.filename}"`);
    return c.body(r.content);
  })
  .get('/billing/settings', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => billingSettings(rctx(c, tx)))));

const settingsSchema = z.object({
  invoicePrefix: z.string().regex(/^[A-Za-z0-9-]{1,5}$/, 'Up to 5 letters, digits or hyphens').optional(),
  creditNotePrefix: z.string().regex(/^[A-Za-z0-9-]{1,5}$/).optional(),
  receiptPrefix: z.string().regex(/^[A-Za-z0-9-]{1,5}$/).optional(),
  dueDays: z.number().int().min(0).max(365).optional(),
  roundOff: z.boolean().optional(),
  bankDetails: z.string().max(1000).optional(),
  ledgers: z.object({ sales: z.string().max(80), cgst: z.string().max(80), sgst: z.string().max(80), igst: z.string().max(80), roundOff: z.string().max(80), bank: z.string().max(80) }).partial().optional(),
});

export const billingAdminRoutes = new Hono<AppEnv>().put('/billing/settings', async (c) => {
  if (!hasAdmin(c.var.principal.permissions, 'billing')) throw forbidden();
  const b = settingsSchema.parse(await c.req.json());
  await c.var.db.tx(scope(c), (tx) => tx.query(`update tenants set settings = jsonb_set(settings, '{billing}', coalesce(settings -> 'billing', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify(b)]));
  return c.json(await c.var.db.tx(scope(c, true), (tx) => billingSettings(rctx(c, tx))));
});
