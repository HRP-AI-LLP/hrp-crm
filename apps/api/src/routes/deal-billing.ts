/** A deal's charges and setting up its billing; price changes on recurring invoices. */
import { CURRENCIES } from '@synapse/shared';
import { hasAdmin } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { forbidden } from '../lib/errors';
import { scope } from '../middleware';
import { addPriceChange, listRecurring, priceChangeSchema, removePriceChange, runRecurring, setRecurringStatus } from '../services/books/setup';
import { chargeSchema, dealCharges, saveDealCharges, setupDealBilling, setupSchema } from '../services/deal-charges';
import { enqueue, eventJobs } from '../services/jobs';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => z.string().uuid().parse(c.req.param(k));
async function emit(c: Parameters<typeof safeCtx>[0] & { env: AppEnv['Bindings']; var: AppEnv['Variables'] }, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}
/** Recurring invoices are run by billing admins as well as books admins. */
function requireRecurring(c: { var: AppEnv['Variables'] }) {
  const p = c.var.principal.permissions;
  if (!hasAdmin(p, 'billing') && !hasAdmin(p, 'books')) throw forbidden('Recurring invoices need the billing or books admin permission');
}

export const dealBillingRoutes = new Hono<AppEnv>()
  .get('/deals/:id/charges', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => dealCharges(rctx(c, tx), id(c)))))
  .put('/deals/:id/charges', async (c) => {
    const b = z.object({ charges: z.array(chargeSchema).max(100), currency: z.enum(CURRENCIES).nullish() }).parse(await c.req.json());
    await emit(c, await c.var.db.tx(scope(c), (tx) => saveDealCharges(rctx(c, tx), id(c), b.charges, b.currency)));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => dealCharges(rctx(c, tx), id(c))));
  })
  .post('/deals/:id/setup-billing', async (c) => {
    const b = setupSchema.parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => setupDealBilling(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    const { events: _e, ...rest } = r;
    return c.json(rest);
  })
  // recurring invoices (also from GST billing, without books)
  .get('/recurring-invoices', async (c) => {
    requireRecurring(c);
    return c.json((await c.var.db.tx(scope(c, true), (tx) => listRecurring(rctx(c, tx)))).filter((p: any) => p.kind === 'invoice'));
  })
  .post('/recurring-invoices/:id/:action{pause|resume|run}', async (c) => {
    requireRecurring(c);
    if (c.req.param('action') === 'run') {
      const r = await c.var.db.tx(scope(c), (tx) => runRecurring(rctx(c, tx), id(c)));
      await emit(c, r.events);
      return c.json({ id: r.id });
    }
    await c.var.db.tx(scope(c), (tx) => setRecurringStatus(rctx(c, tx), id(c), c.req.param('action') === 'pause' ? 'paused' : 'active'));
    return c.json({ ok: true });
  })
  .post('/recurring-invoices/:id/price-changes', async (c) => {
    requireRecurring(c);
    const b = priceChangeSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => addPriceChange(rctx(c, tx), id(c), b)));
  })
  .delete('/recurring-invoices/:id/price-changes/:from', async (c) => {
    requireRecurring(c);
    const from = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(c.req.param('from'));
    return c.json(await c.var.db.tx(scope(c), (tx) => removePriceChange(rctx(c, tx), id(c), from)));
  });
