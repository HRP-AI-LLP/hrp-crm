/**
 * Mail intake API (mounted at /api/v1): the mailboxes read for business mail, what was taken in
 * (GeM alerts, bills, invoices), bills made from mailed invoices, and GeM bids.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enqueue, eventJobs } from '../services/jobs';
import * as gem from '../services/intake/gem';
import * as ik from '../services/intake/intake';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
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
const pages = z.array(z.string().max(100_000)).max(300);

export const intakeRoutes = new Hono<AppEnv>()
  /* ───── mailboxes ───── */
  .get('/intake/mailboxes', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ik.listMailboxes(rctx(c, tx)))))
  .post('/intake/mailboxes', async (c) => {
    const b = ik.mailboxSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ik.saveMailbox(rctx(c, tx), c.env, null, b)), 201);
  })
  .put('/intake/mailboxes/:id', async (c) => {
    const b = ik.mailboxSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ik.saveMailbox(rctx(c, tx), c.env, id(c), b)));
  })
  .delete('/intake/mailboxes/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => ik.deleteMailbox(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .post('/intake/mailboxes/:id/sync', async (c) => {
    await c.var.db.tx(scope(c, true), async (tx) => ik.assertIntake(rctx(c, tx)));
    const r = await ik.syncMailbox(c.env, c.var.db, c.var.tenant.id, id(c));
    await emit(c, r.events);
    return c.json({ seen: r.seen, taken: r.taken, newBids: r.newBids });
  })

  /* ───── what was taken in ───── */
  .get('/intake/items', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => ik.listItems(rctx(c, tx), c.env, { status: c.req.query('status') || null, kind: c.req.query('kind') || null }))),
  )
  .get('/intake/items/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => ik.getItem(rctx(c, tx), c.env, id(c)))))
  .post('/intake/items/:id/status', async (c) => {
    const b = z.object({ status: z.enum(['new', 'done', 'ignored']), note: z.string().trim().max(1000).nullish() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => ik.setItemStatus(rctx(c, tx), id(c), b.status, b.note));
    return c.json({ ok: true });
  })
  .post('/intake/items/:id/read', async (c) => {
    const b = z.object({ fileId: uuid, pages }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => ik.readAttachment(rctx(c, tx), id(c), b.fileId, b.pages)));
  })
  .post('/intake/items/:id/bill', async (c) => {
    const b = ik.billFromMailSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => ik.billFromMail(rctx(c, tx), c.env, id(c), b));
    await emit(c, r.events);
    return c.json({ billId: r.billId, vendorId: r.vendorId, lines: r.lines }, 201);
  })

  /* ───── GeM bids ───── */
  .get('/intake/gem', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => gem.listBids(rctx(c, tx), { status: c.req.query('status') || null, open: c.req.query('open') === '1' }))))
  .post('/intake/gem', async (c) => {
    const b = z.object({ bidNumber: z.string().trim().max(40), title: z.string().trim().max(1000).nullish(), endAt: z.string().datetime({ offset: true }).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => gem.addBid(rctx(c, tx), b)), 201);
  })
  .put('/intake/gem/:id', async (c) => {
    const b = gem.bidUpdateSchema.parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => gem.updateBid(rctx(c, tx), id(c), b));
    return c.json({ ok: true });
  })
  .get('/intake/gem/:id/check', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => gem.bidCheck(rctx(c, tx), c.env, id(c)))))
  .post('/intake/gem/:id/document', async (c) => {
    const b = z.object({ name: z.string().trim().max(200).default('bid.pdf'), data: z.string().max(20_000_000).nullish(), pages }).parse(await c.req.json());
    const bytes = b.data ? Uint8Array.from(atob(b.data), (ch) => ch.charCodeAt(0)) : null;
    return c.json(await c.var.db.tx(scope(c), (tx) => gem.attachBidDocument(rctx(c, tx), c.env, id(c), { name: b.name, bytes, pages: b.pages })));
  })
  .get('/intake/gem/:id/pack', async (c) => {
    const r = await c.var.db.tx(scope(c, true), (tx) => gem.bidPack(rctx(c, tx), c.env, id(c)));
    return new Response(r.bytes, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${r.name}"`, 'cache-control': 'no-store' } });
  })
  .post('/intake/gem/:id/deal', async (c) => {
    const r = await c.var.db.tx(scope(c), (tx) => gem.bidToDeal(rctx(c, tx), id(c)));
    await emit(c, r.events);
    return c.json({ dealId: r.dealId }, 201);
  });
