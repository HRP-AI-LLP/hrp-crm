/**
 * Industry packs API (mounted at /api/v1, public parts at /api/public): customer hierarchy,
 * profitability, win/loss, credit control, RFQs and pricing, availability, rebates, after-sales
 * (warranties, spares, CAPA, escalation), dealers, client IT (assets, vault, docs), sequences,
 * the public help centre, sales analytics and connectors.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, notFound } from '../lib/errors';
import { takeToken } from '../lib/ratelimit';
import { scope } from '../middleware';
import * as as from '../services/industry/aftersales';
import * as an from '../services/industry/analytics';
import * as ch from '../services/industry/channel';
import * as cn from '../services/industry/connectors';
import * as core from '../services/industry/core';
import * as dc from '../services/industry/deal-contract';
import * as it from '../services/industry/itops';
import * as kb from '../services/industry/kb';
import * as pr from '../services/industry/pricing';
import * as sq from '../services/industry/sequences';
import { enqueue, eventJobs } from '../services/jobs';
import type { RecordCtx, RecordEvent } from '../services/records';
import { systemCtxFor } from '../services/system';
import { resolveRoute, safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().min(0).max(1e12);
const opt = <T extends z.ZodTypeAny>(s: T) => s.nullish();

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
type C = { var: AppEnv['Variables']; env: AppEnv['Bindings'] } & Parameters<typeof safeCtx>[0];
async function emit(c: C, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
const period = (c: { req: { query: (k: string) => string | undefined } }) => {
  const to = dateStr.safeParse(c.req.query('to')).success ? c.req.query('to')! : core.todayIst();
  const from = dateStr.safeParse(c.req.query('from')).success ? c.req.query('from')! : core.fyStart(to);
  return { from, to };
};
const q = (c: { req: { query: (k: string) => string | undefined } }, k: string) => c.req.query(k) || null;
const qUuid = (c: { req: { query: (k: string) => string | undefined } }, k: string) => {
  const v = c.req.query(k);
  return v && uuid.safeParse(v).success ? v : null;
};

const rebateSchema = z.object({
  accountId: uuid,
  name: z.string().trim().min(1).max(150),
  startsOn: dateStr,
  endsOn: dateStr,
  basis: z.enum(['value', 'quantity']),
  productId: opt(uuid),
  slabs: z.array(z.object({ from: z.number().min(0).max(1e13), pct: z.number().min(0).max(100) })).min(1).max(10),
  status: z.enum(['active', 'settled', 'cancelled']).optional(),
  notes: opt(z.string().max(2000)),
});
const capaSchema = z.object({
  title: z.string().trim().min(1).max(200),
  ticketId: opt(uuid),
  accountId: opt(uuid),
  productId: opt(uuid),
  severity: z.enum(['minor', 'major', 'critical']).optional(),
  rootCauseCategory: opt(z.enum(['man', 'machine', 'method', 'material', 'measurement', 'environment', 'design', 'supplier', 'other'])),
  rootCause: opt(z.string().max(4000)),
  containment: opt(z.string().max(4000)),
  correctiveAction: opt(z.string().max(4000)),
  preventiveAction: opt(z.string().max(4000)),
  ownerId: opt(uuid),
  dueOn: opt(dateStr),
  status: z.enum(['open', 'investigating', 'action', 'verifying', 'closed']).optional(),
  effective: z.boolean().nullish(),
});
const warrantySchema = z.object({
  accountId: uuid,
  productId: opt(uuid),
  serialNo: opt(z.string().trim().max(80)),
  quantity: z.number().positive().max(1e9).optional(),
  startsOn: dateStr,
  endsOn: opt(dateStr),
  months: opt(z.number().int().min(0).max(240)),
  status: z.enum(['active', 'void']).optional(),
  notes: opt(z.string().max(2000)),
});
const schemeSchema = z.object({
  name: z.string().trim().min(1).max(150),
  startsOn: dateStr,
  endsOn: dateStr,
  basis: z.enum(['won_deals', 'invoices']),
  dealerTier: opt(z.string().trim().max(40)),
  ratePct: z.number().min(0).max(100),
  minValue: money.optional(),
  status: z.enum(['active', 'closed']).optional(),
});
const assetSchema = z.object({
  accountId: uuid,
  contactId: opt(uuid),
  kind: z.enum(['laptop', 'desktop', 'server', 'network', 'printer', 'mobile', 'peripheral', 'software', 'license', 'cloud', 'domain', 'certificate', 'other']),
  name: z.string().trim().min(1).max(150),
  make: opt(z.string().trim().max(80)),
  model: opt(z.string().trim().max(120)),
  serialNo: opt(z.string().trim().max(120)),
  assetTag: opt(z.string().trim().max(60)),
  location: opt(z.string().trim().max(150)),
  vendorName: opt(z.string().trim().max(150)),
  purchasedOn: opt(dateStr),
  cost: opt(money),
  warrantyEndsOn: opt(dateStr),
  renewsOn: opt(dateStr),
  seats: opt(z.number().int().min(0).max(1e7)),
  seatsUsed: opt(z.number().int().min(0).max(1e7)),
  status: z.enum(['in_use', 'in_stock', 'repair', 'retired']).optional(),
  notes: opt(z.string().max(4000)),
});
const secretSchema = z.object({
  accountId: uuid,
  title: z.string().trim().min(1).max(150),
  url: opt(z.string().trim().max(500)),
  username: opt(z.string().trim().max(200)),
  secret: opt(z.string().max(4000)),
  notes: opt(z.string().max(2000)),
});
const docSchema = z.object({ accountId: uuid, projectId: opt(uuid), kind: z.enum(['runbook', 'architecture', 'configuration', 'sop', 'network', 'other']), title: z.string().trim().min(1).max(200), body: opt(z.string().max(200000)) });
const seqSchema = z.object({
  name: z.string().trim().min(1).max(150),
  steps: z.array(z.object({ day: z.number().int().min(0).max(365), subject: z.string().trim().min(1).max(250), body: z.string().trim().min(1).max(20000) })).min(1).max(12),
  stopOnReply: z.boolean().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const industryRoutes = new Hono<AppEnv>()
  /* ───── customers: hierarchy, profitability, credit ───── */
  .get('/accounts/:id/family', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => core.accountFamily(rctx(c, tx), id(c)))))
  .get('/accounts/:id/credit', async (c) => c.json(await c.var.db.tx(scope(c, true), async (tx) => {
    core.assertAccountRead(rctx(c, tx));
    return { ...(await core.creditStatus(rctx(c, tx), id(c))), canApprove: core.canApproveCredit(rctx(c, tx)) };
  })))
  .get('/accounts/:id/profitability', async (c) => {
    const p = period(c);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => core.profitability(rctx(c, tx), { ...p, accountId: id(c), includeChildren: c.req.query('children') !== '0' })));
  })
  .get('/insights/profitability', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => core.profitability(rctx(c, tx), period(c)))))
  .get('/insights/win-loss', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => core.winLoss(rctx(c, tx), { ...period(c), ownerId: qUuid(c, 'owner'), pipelineId: qUuid(c, 'pipeline') }))))
  .get('/deals-loss-reasons', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => core.lossReasons(rctx(c, tx))) }))
  .post('/deals/:id/lost', async (c) => {
    const b = z.object({ reason: z.string().trim().min(1).max(80), lostTo: opt(z.string().trim().max(120)), note: opt(z.string().max(2000)) }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => core.markLost(rctx(c, tx), id(c), b));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/deals/:id/contract', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => dc.contractForWonDeal(rctx(c, tx), id(c), true));
    if (!r) throw notFound('The deal needs a customer');
    return c.json(r, 201);
  })
  .get('/credit-watch', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => core.creditWatch(rctx(c, tx)))))
  .get('/sales-orders/:id/credit', async (c) =>
    c.json(
      await c.var.db.tx(scope(c, true), async (tx) => {
        const o = await tx.one<{ account_id: string | null; grand_total: string; credit_approved_at: string | null; credit_note: string | null; status: string }>(
          `select account_id, grand_total, credit_approved_at, credit_note, status from sales_orders where tenant_id = $1 and id = $2 and deleted_at is null`,
          [c.var.tenant.id, id(c)],
        );
        if (!o) throw notFound();
        const s = o.account_id ? await core.creditStatus(rctx(c, tx), o.account_id, id(c)) : null;
        const total = Number(o.grand_total);
        return { ...s, orderTotal: total, needsApproval: !!s && o.status === 'draft' && (s.hold || (s.limit != null && s.exposure + total > s.limit + 0.005)), approvedAt: o.credit_approved_at, note: o.credit_note, canApprove: core.canApproveCredit(rctx(c, tx)) };
      }),
    ),
  )
  .post('/sales-orders/:id/credit-approve', async (c) => {
    const b = z.object({ note: opt(z.string().max(1000)) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => core.approveCredit(rctx(c, tx), id(c), b.note ?? null)));
  })
  .post('/sales-orders/:id/credit-request', async (c) => {
    const b = z.object({ note: opt(z.string().max(1000)) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => core.requestCredit(rctx(c, tx), id(c), b.note ?? null)));
  })

  /* ───── RFQs, price lists, quote costing, availability ───── */
  .get('/rfqs', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => pr.listRfqs(rctx(c, tx), { open: c.req.query('open') === '1' })) }))
  .post('/rfqs', async (c) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(200), accountId: uuid, contactId: opt(uuid), dealId: opt(uuid), rfqNumber: opt(z.string().trim().max(80)), receivedOn: opt(dateStr), dueOn: opt(dateStr), customerRef: opt(z.string().trim().max(120)), notes: opt(z.string().max(5000)) })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pr.createRfq(rctx(c, tx), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .post('/quotes/:id/rfq-to-quote', async (c) => {
    const events = await c.var.db.tx(scope(c), (tx) => pr.rfqToQuote(rctx(c, tx), id(c)));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/quotes/:id/reprice', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => pr.repriceQuote(rctx(c, tx), id(c)));
    await emit(c, r.events);
    return c.json({ changed: r.changed });
  })
  .get('/quotes/:id/costing', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pr.quoteCosting(rctx(c, tx), id(c)))))
  .get('/price-lists', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => pr.priceLists(rctx(c, tx))) }))
  .put('/price-lists/:id/scope', async (c) => {
    const b = z.object({ accountId: opt(uuid), validFrom: opt(dateStr), validTo: opt(dateStr) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pr.savePriceListScope(rctx(c, tx), id(c), b)));
  })
  .get('/products/:id/tiers', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => pr.tiersOf(rctx(c, tx), id(c))) }))
  .put('/price-lists/:id/tiers/:pid', async (c) => {
    const b = z.object({ tiers: z.array(z.object({ minQty: z.number().positive().max(1e9), unitPrice: money })).max(20) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pr.saveTiers(rctx(c, tx), id(c), id(c, 'pid'), b.tiers)));
  })
  .get('/price-for', async (c) => {
    const p = z.object({ product: uuid, account: uuid.optional(), qty: z.coerce.number().positive().max(1e9).default(1) }).parse(c.req.query());
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pr.priceFor(tx, c.var.tenant.id, { productId: p.product, accountId: p.account ?? null, qty: p.qty })));
  })
  .get('/products/:id/availability', async (c) => {
    const qty = z.coerce.number().positive().max(1e9).default(1).parse(c.req.query('qty') ?? '1');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pr.availability(rctx(c, tx), id(c), qty, { warehouseId: qUuid(c, 'warehouse') })));
  })
  .get('/sales-orders/:id/promise', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pr.promiseOrder(rctx(c, tx), id(c), false))))
  .post('/sales-orders/:id/promise', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pr.promiseOrder(rctx(c, tx), id(c), true))))
  .get('/rebates', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pr.rebates(rctx(c, tx), { accountId: qUuid(c, 'account') }))))
  .post('/rebates', async (c) => c.json(await c.var.db.tx(scope(c), async (tx) => pr.saveRebate(rctx(c, tx), null, rebateSchema.parse(await c.req.json()))), 201))
  .put('/rebates/:id', async (c) => {
    const b = rebateSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pr.saveRebate(rctx(c, tx), id(c), b)));
  })
  .delete('/rebates/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pr.deleteRebate(rctx(c, tx), id(c)))))

  /* ───── after-sales ───── */
  .get('/after-sales/overview', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => as.afterSalesOverview(rctx(c, tx)))))
  .get('/warranties', async (c) => {
    const days = c.req.query('expiring') ? Math.min(3650, Math.max(1, Number(c.req.query('expiring')) || 60)) : null;
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => as.listWarranties(rctx(c, tx), { accountId: qUuid(c, 'account'), productId: qUuid(c, 'product'), serial: q(c, 'serial'), expiringDays: days, status: q(c, 'status') })) });
  })
  .post('/warranties', async (c) => {
    const b = warrantySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.saveWarranty(rctx(c, tx), null, b)), 201);
  })
  .put('/warranties/:id', async (c) => {
    const b = warrantySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.saveWarranty(rctx(c, tx), id(c), b)));
  })
  .get('/tickets/:id/warranty', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => as.ticketWarranty(rctx(c, tx), id(c)))))
  .get('/tickets/:id/parts', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => as.ticketParts(rctx(c, tx), id(c))) }))
  .post('/tickets/:id/parts', async (c) => {
    const b = z.object({ productId: uuid, quantity: z.number().positive().max(1e6), warehouseId: opt(uuid), chargeable: z.boolean().nullish(), unitPrice: opt(money) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.issuePart(rctx(c, tx), id(c), b)), 201);
  })
  .delete('/tickets/:id/parts/:pid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => as.returnPart(rctx(c, tx), id(c), id(c, 'pid')))))
  .post('/tickets/:id/bill-parts', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => as.billParts(rctx(c, tx), id(c)));
    await emit(c, r.events);
    return c.json({ invoiceId: r.invoiceId }, 201);
  })
  .post('/tickets/:id/escalate', async (c) => {
    const b = z.object({ note: opt(z.string().max(1000)) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => as.escalateNow(rctx(c, tx), id(c), b.note ?? null)));
  })
  .get('/spares', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => as.sparesFor(rctx(c, tx), qUuid(c, 'for') ?? '')) }))
  .get('/capas', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => as.listCapas(rctx(c, tx), { status: q(c, 'status'), accountId: qUuid(c, 'account'), ticketId: qUuid(c, 'ticket'), productId: qUuid(c, 'product') })) }))
  .post('/capas', async (c) => {
    const b = capaSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.saveCapa(rctx(c, tx), null, b)), 201);
  })
  .put('/capas/:id', async (c) => {
    const b = capaSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.saveCapa(rctx(c, tx), id(c), b)));
  })
  .delete('/capas/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => as.deleteCapa(rctx(c, tx), id(c)))))
  .get('/quality-stats', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => as.qualityStats(rctx(c, tx), Math.min(730, Math.max(7, Number(c.req.query('days')) || 180))))))
  .get('/escalation-matrix', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => as.escalationSettings(tx, c.var.tenant.id))))
  .put('/escalation-matrix', async (c) => {
    const b = z
      .object({ enabled: z.boolean(), levels: z.array(z.object({ afterHours: z.number().min(0).max(24 * 60), userIds: z.array(uuid).max(20), notifyManager: z.boolean().optional(), priorities: z.array(z.string().max(20)).max(10).optional() })).max(5) })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => as.saveEscalation(rctx(c, tx), b)));
  })

  /* ───── dealers ───── */
  .get('/channel/overview', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ch.channelOverview(rctx(c, tx), period(c)))))
  .get('/channel/schemes', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => ch.listSchemes(rctx(c, tx))) }))
  .post('/channel/schemes', async (c) => {
    const b = schemeSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ch.saveScheme(rctx(c, tx), null, b)), 201);
  })
  .put('/channel/schemes/:id', async (c) => {
    const b = schemeSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ch.saveScheme(rctx(c, tx), id(c), b)));
  })
  .delete('/channel/schemes/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => ch.deleteScheme(rctx(c, tx), id(c)))))
  .post('/accounts/:id/dealer-portal', async (c) => {
    const b = z.object({ on: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ch.setDealerPortal(rctx(c, tx), id(c), b.on)));
  })

  /* ───── client IT ───── */
  .get('/client-assets', async (c) => {
    const days = c.req.query('renewing') ? Math.min(365, Math.max(1, Number(c.req.query('renewing')) || 30)) : null;
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => it.listAssets(rctx(c, tx), { accountId: qUuid(c, 'account'), kind: q(c, 'kind'), status: q(c, 'status'), search: q(c, 'q'), renewingDays: days })) });
  })
  .post('/client-assets', async (c) => {
    const b = assetSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveAsset(rctx(c, tx), null, b)), 201);
  })
  .put('/client-assets/:id', async (c) => {
    const b = assetSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveAsset(rctx(c, tx), id(c), b)));
  })
  .delete('/client-assets/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => it.deleteAsset(rctx(c, tx), id(c)))))
  .get('/client-assets/:id/history', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => it.assetHistory(rctx(c, tx), id(c))) }))
  .post('/client-assets/:id/notes', async (c) => {
    const b = z.object({ note: z.string().trim().min(1).max(1000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.addAssetNote(rctx(c, tx), id(c), b.note)));
  })
  .get('/client-vault', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => it.listSecrets(rctx(c, tx), qUuid(c, 'account'))) }))
  .post('/client-vault', async (c) => {
    const b = secretSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveSecret(rctx(c, tx), c.env, null, b)), 201);
  })
  .put('/client-vault/:id', async (c) => {
    const b = secretSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveSecret(rctx(c, tx), c.env, id(c), b)));
  })
  .post('/client-vault/:id/reveal', async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await c.var.db.tx(scope(c), (tx) => it.revealSecret(rctx(c, tx), c.env, id(c))));
  })
  .delete('/client-vault/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => it.deleteSecret(rctx(c, tx), id(c)))))
  .get('/tech-docs', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => it.listDocs(rctx(c, tx), { accountId: qUuid(c, 'account'), kind: q(c, 'kind'), search: q(c, 'q') })) }))
  .get('/tech-docs/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => it.getDoc(rctx(c, tx), id(c)))))
  .post('/tech-docs', async (c) => {
    const b = docSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveDoc(rctx(c, tx), null, b)), 201);
  })
  .put('/tech-docs/:id', async (c) => {
    const b = docSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => it.saveDoc(rctx(c, tx), id(c), b)));
  })
  .delete('/tech-docs/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => it.deleteDoc(rctx(c, tx), id(c)))))

  /* ───── sequences ───── */
  .get('/sequences', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => sq.listSequences(rctx(c, tx))) }))
  .post('/sequences', async (c) => {
    const b = seqSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => sq.saveSequence(rctx(c, tx), null, b)), 201);
  })
  .put('/sequences/:id', async (c) => {
    const b = seqSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => sq.saveSequence(rctx(c, tx), id(c), b)));
  })
  .delete('/sequences/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => sq.deleteSequence(rctx(c, tx), id(c)))))
  .post('/sequences/:id/enroll', async (c) => {
    const b = z.object({ object: z.enum(['lead', 'contact']), ids: z.array(uuid).min(1).max(500) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => sq.enroll(rctx(c, tx), id(c), b.object, b.ids)));
  })
  .get('/sequence-enrollments', async (c) => c.json({ items: await c.var.db.tx(scope(c, true), (tx) => sq.enrollments(rctx(c, tx), { sequenceId: qUuid(c, 'sequence'), object: q(c, 'object'), recordId: qUuid(c, 'record') })) }))
  .post('/sequence-enrollments/:id/stop', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => sq.stopEnrollment(rctx(c, tx), id(c)))))
  .post('/sequences-run', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => sq.runSequences(c.env, tx, c.var.tenant.id))))

  /* ───── help centre ───── */
  .get('/help-centre', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => kb.kbSite(rctx(c, tx)))))
  .put('/help-centre', async (c) => {
    const b = z.object({ title: z.string().trim().min(1).max(120).optional(), on: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => kb.saveKbSite(rctx(c, tx), b)));
  })
  .put('/help-centre/articles/:id', async (c) => {
    const b = z.object({ isPublic: z.boolean().optional(), category: z.string().trim().max(80).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => kb.publishArticle(rctx(c, tx), id(c), b)));
  })

  /* ───── sales analytics ───── */
  .get('/analytics/products', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => an.salesByProduct(rctx(c, tx), period(c)))))
  .get('/analytics/regions', async (c) => {
    const by = z.enum(['state', 'city', 'territory']).catch('state').parse(c.req.query('by'));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => an.salesByRegion(rctx(c, tx), { ...period(c), by })));
  })
  .get('/analytics/fulfilment', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => an.fulfilment(rctx(c, tx), period(c)))))
  .get('/analytics/repeat', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => an.repeatOrders(rctx(c, tx), period(c)))))
  .get('/analytics/seasonality', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => an.seasonality(rctx(c, tx), Math.min(5, Math.max(1, Number(c.req.query('years')) || 3))))))
  .get('/analytics/forecast', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => an.forecastVsActual(rctx(c, tx), Math.min(24, Math.max(3, Number(c.req.query('months')) || 12))))))

  /* ───── connectors ───── */
  .get('/connectors', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => cn.listConnectors(rctx(c, tx)))))
  .post('/connectors/:kind', async (c) => {
    const kind = z.enum(cn.CONNECTORS).parse(c.req.param('kind'));
    const b = z.object({ label: opt(z.string().trim().max(80)), values: z.record(z.string(), z.string().max(4000)), alerts: z.array(z.string()).max(10).optional(), minDeal: opt(money) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cn.saveConnector(rctx(c, tx), c.env, null, kind, b)), 201);
  })
  .put('/connectors/:kind/:id', async (c) => {
    const kind = z.enum(cn.CONNECTORS).parse(c.req.param('kind'));
    const b = z.object({ label: opt(z.string().trim().max(80)), values: z.record(z.string(), z.string().max(4000)), alerts: z.array(z.string()).max(10).optional(), minDeal: opt(money) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cn.saveConnector(rctx(c, tx), c.env, id(c), kind, b)));
  })
  .delete('/connectors/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cn.deleteConnector(rctx(c, tx), id(c)))))
  .post('/connectors/:id/test', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cn.testConnector(rctx(c, tx), c.env, id(c)))))
  .post('/connectors/:id/erp-pull', async (c) => {
    const b = z.object({ customers: z.boolean().default(true), items: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => cn.erpPull(rctx(c, tx), c.env, id(c), b)));
  })
  .post('/connectors/:id/erp-order/:oid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cn.erpPushOrder(rctx(c, tx), c.env, id(c), id(c, 'oid')))))
  .get('/projects/:id/tracker', async (c) => c.json(await c.var.db.tx(scope(c, true), async (tx) => (await tx.one<{ external: unknown }>(`select external from projects where tenant_id = $1 and id = $2`, [c.var.tenant.id, id(c)]))?.external ?? null)))
  .get('/accounts/:id/dealer-portal', async (c) => c.json(await c.var.db.tx(scope(c, true), async (tx) => ({ token: (await tx.one<{ t: string | null }>(`select public_token as t from accounts where tenant_id = $1 and id = $2`, [c.var.tenant.id, id(c)]))?.t ?? null }))))
  .put('/projects/:id/tracker', async (c) => {
    const b = z.object({ integrationId: uuid, key: z.string().trim().min(1).max(120) }).nullable().parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => cn.linkProject(rctx(c, tx), id(c), b)));
  })
  .post('/projects/:id/tracker-sync', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cn.syncProject(rctx(c, tx), c.env, id(c)))))
  .post('/files/:id/sharepoint', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => cn.fileToSharePoint(rctx(c, tx), c.env, id(c)))));

/** Dealer portal and help centre, no sign-in (behind their private links). */
export const industryPublicRoutes = new Hono<AppEnv>()
  .get('/dealer/:token', async (c) => {
    const route = await resolveRoute(c, 'dealer', c.req.param('token'));
    const out = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => ch.dealerPortal(tx, route.tenant_id, route.target_id));
    c.header('cache-control', 'no-store');
    c.header('x-robots-tag', 'noindex');
    return c.json(out);
  })
  .post('/dealer/:token/leads', async (c) => {
    const route = await resolveRoute(c, 'dealer', c.req.param('token'));
    if (!takeToken(`dealer:${route.target_id}:${c.req.header('cf-connecting-ip') ?? ''}`, 10).ok) throw new ApiError(429, 'rate_limited', 'Too many requests; try again in a minute');
    const b = z
      .object({ name: z.string().trim().min(2).max(120), company: opt(z.string().trim().max(150)), phone: opt(z.string().trim().max(20)), email: opt(z.string().trim().email().max(200)), city: opt(z.string().trim().max(80)), requirement: opt(z.string().trim().max(1000)) })
      .refine((v) => v.phone || v.email, 'Give a phone number or an email')
      .parse(await c.req.json());
    const r = await c.var.db.tx({ tenantId: route.tenant_id }, async (tx) => {
      const ctx = await systemCtxFor(c.env, tx, route.tenant_id);
      if (!ctx) throw notFound();
      return ch.dealerLead(ctx, route.target_id, b);
    });
    await enqueue(c.env, safeCtx(c), eventJobs(route.tenant_id, null, r.events));
    return c.json({ ok: true }, 201);
  })
  .get('/help/:token', async (c) => {
    const route = await resolveRoute(c, 'kb', c.req.param('token'));
    const article = c.req.query('article');
    const out = await c.var.db.tx({ tenantId: route.tenant_id, readOnly: true }, (tx) => kb.publicKb(tx, route.tenant_id, { search: c.req.query('q') ?? null, articleId: article && uuid.safeParse(article).success ? article : null }));
    c.header('cache-control', 'public, max-age=60');
    return c.json(out);
  });
