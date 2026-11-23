/** Match & reconcile (mounted at /api/v1): suggestions, approve, reject. */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { scope } from '../middleware';
import type { RecordCtx } from '../services/records';
import * as rc from '../services/reconcile';
import { enqueue, eventJobs } from '../services/jobs';
import type { RecordEvent } from '../services/records';
import { safeCtx } from './public';

async function emit(c: Context<AppEnv>, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}

function run<T>(c: Context<AppEnv>, fn: (ctx: RecordCtx) => Promise<T>, readOnly = false) {
  return c.var.db.tx(scope(c, readOnly), (tx) => fn({ tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id }));
}

const focusQ = z
  .string()
  .regex(/^(payment|invoice|project|account|milestone|bill|vendor_payment|expense):[0-9a-f-]{36}$/i)
  .transform((v) => ({ type: v.split(':')[0] as rc.Focus['type'], id: v.split(':')[1]! }));

export const reconcileRoutes = new Hono<AppEnv>()
  .get('/reconcile', async (c) => {
    const kind = c.req.query('kind');
    const focus = c.req.query('focus');
    return c.json(
      await run(c, (ctx) => rc.suggestions(ctx, { kind: kind && kind in rc.KIND_LABELS ? (kind as rc.Kind) : null, focus: focus ? focusQ.parse(focus) : null })),
    );
  })
  .post('/reconcile/apply', async (c) => {
    const b = rc.applySchema.parse(await c.req.json());
    const r = await run(c, (ctx) => rc.apply(ctx, b));
    await emit(c, r.events);
    return c.json({ results: r.results });
  })
  .post('/reconcile/reject', async (c) => {
    const b = z.object({ keys: z.array(z.string().max(300)).min(1).max(200) }).parse(await c.req.json());
    return c.json(await run(c, (ctx) => rc.reject(ctx, b.keys)));
  });
