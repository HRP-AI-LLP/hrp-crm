/**
 * Deposits and guarantees (EMD, performance security, retention): /api/v1/deposits.
 * Needs the GST billing app; access rules live in services/books/deposits.ts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import * as dep from '../services/books/deposits';
import type { RecordCtx } from '../services/records';

const uuid = z.string().uuid();
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1990-01-01' && s <= '2100-12-31';
  }, 'Not a valid date');
const money = z.number().finite().positive().max(1e12);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }) => {
  const v = c.req.param('id');
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
const qUuid = (c: { req: { query: (k: string) => string | undefined } }, k: string) => {
  const v = c.req.query(k);
  return v ? uuid.parse(v) : null;
};

const depositSchema = z.object({
  kind: z.enum(dep.DEPOSIT_KINDS),
  instrument: z.enum(dep.INSTRUMENTS),
  accountId: uuid,
  projectId: uuid.nullish(),
  salesOrderId: uuid.nullish(),
  dealId: uuid.nullish(),
  reference: z.string().trim().max(100).nullish(),
  issuingBank: z.string().trim().max(120).nullish(),
  amount: money,
  marginAmount: z.number().finite().min(0).max(1e12).optional(),
  issueDate: dateStr.nullish(),
  expiryDate: dateStr.nullish(),
  claimUntil: dateStr.nullish(),
  paidFrom: uuid.nullish(),
  notes: z.string().max(2000).nullish(),
  opening: z.boolean().optional(),
});

export const depositRoutes = new Hono<AppEnv>()
  .use('/deposits/*', async (c, next) => {
    if (!enabledApps(c.var.meta).has('billing')) throw notFound('GST billing is switched off for the workspace');
    return next();
  })
  .use('/deposits', async (c, next) => {
    if (!enabledApps(c.var.meta).has('billing')) throw notFound('GST billing is switched off for the workspace');
    return next();
  })
  .get('/deposits', async (c) => {
    const exp = c.req.query('expiringDays');
    const status = c.req.query('status');
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        dep.listDeposits(rctx(c, tx), {
          status: status ? z.enum(['active', 'closed', 'cancelled']).parse(status) : null,
          accountId: qUuid(c, 'accountId'),
          projectId: qUuid(c, 'projectId'),
          expiringDays: exp ? z.coerce.number().int().min(0).max(3650).parse(exp) : null,
        }),
      ),
    );
  })
  .post('/deposits', async (c) => {
    const b = depositSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dep.createDeposit(rctx(c, tx), b)), 201);
  })
  .get('/deposits/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => dep.getDeposit(rctx(c, tx), id(c)))))
  .post('/deposits/:id/release', async (c) => {
    const b = z.object({ amount: money.nullish(), date: dateStr.nullish(), bankAccountId: uuid.nullish(), note: z.string().max(500).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dep.releaseDeposit(rctx(c, tx), id(c), b)));
  })
  .post('/deposits/:id/forfeit', async (c) => {
    const b = z.object({ amount: money, date: dateStr.nullish(), bankAccountId: uuid.nullish(), reason: z.string().trim().min(1).max(300) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dep.forfeitDeposit(rctx(c, tx), id(c), b)));
  })
  .post('/deposits/:id/extend', async (c) => {
    const b = z.object({ expiryDate: dateStr, claimUntil: dateStr.nullish(), reference: z.string().trim().max(100).nullish(), note: z.string().max(500).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dep.extendDeposit(rctx(c, tx), id(c), b)));
  })
  .post('/deposits/:id/cancel', async (c) => {
    const b = z.object({ reason: z.string().trim().min(1).max(300) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => dep.cancelDeposit(rctx(c, tx), id(c), b.reason)));
  });
