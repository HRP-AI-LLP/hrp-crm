/**
 * Operations API: apps on/off, inventory (stock, movements, warehouses, categories, variants),
 * sales orders (lines, confirm, status, milestones, delivery from stock), purchasing.
 *   opsRoutes      → /api/v1
 *   appsAdminRoutes → /api/admin
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { metaWrite, requireAdmin, scope } from '../middleware';
import { disableApp, enabledApps, enableApp, listApps } from '../services/apps';
import { assertCanMoveStock, createVariants, movements, moveStock, productStock, stockOverview, transferStock } from '../services/inventory';
import { enqueue, eventJobs } from '../services/jobs';
import { changeStatus, confirmOrder, getOrder, orderFromQuote, recordMilestonePayment, reopenOrder, saveOrderLines, setMilestones, shipLines } from '../services/orders';
import { closePo, getPurchaseOrder, issuePo, poFromOrder, receiveGoods, savePoLines, vendorPerformance } from '../services/purchasing';
import { lineSchema } from '../services/quotes';
import { loadRow, type RecordCtx, type RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}

function requireApp(c: { var: AppEnv['Variables'] }, app: string) {
  if (!enabledApps(c.var.meta).has(app)) throw notFound('This app is switched off for the workspace');
}

async function emit(c: Parameters<typeof safeCtx>[0] & { env: AppEnv['Bindings']; var: AppEnv['Variables'] }, events: RecordEvent[]) {
  await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}

function canConfigureCatalogue(c: { var: AppEnv['Variables'] }) {
  const p = c.var.principal.permissions;
  if (!hasAdmin(p, 'operations') && objectPerm(p, 'product').update !== 'all') throw forbidden();
}

const movementSchema = z.object({
  type: z.enum(['in', 'out', 'adjust']),
  productId: uuid,
  warehouseId: uuid,
  quantity: z.number().finite().refine((x) => x !== 0, 'Quantity must not be zero'),
  reason: z.string().trim().max(300).nullish(),
  unitCost: z.number().min(0).max(1e12).nullish(),
});

export const opsRoutes = new Hono<AppEnv>()
  .use('/warehouses/*', metaWrite)
  .use('/warehouses', metaWrite)
  .use('/product-categories/*', metaWrite)
  .use('/product-categories', metaWrite)
  // ============================================================================ inventory
  .get('/inventory/stock', async (c) => {
    requireApp(c, 'inventory');
    const q = z.object({ q: z.string().max(100).optional(), warehouse: uuid.optional(), low: z.enum(['1']).optional(), category: uuid.optional() }).parse(c.req.query());
    return c.json(await c.var.db.tx(scope(c, true), (tx) => stockOverview(rctx(c, tx), { q: q.q, warehouseId: q.warehouse, lowOnly: !!q.low, categoryId: q.category })));
  })
  .get('/inventory/movements', async (c) => {
    requireApp(c, 'inventory');
    const q = z.object({ product: uuid.optional(), warehouse: uuid.optional() }).parse(c.req.query());
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => movements(rctx(c, tx), { productId: q.product, warehouseId: q.warehouse })) });
  })
  .post('/inventory/movements', async (c) => {
    requireApp(c, 'inventory');
    const b = movementSchema.parse(await c.req.json());
    if (b.type !== 'adjust' && b.quantity < 0) throw badRequest('Use a positive quantity');
    if (b.type === 'adjust' && !b.reason) throw badRequest('Say why the stock is adjusted');
    const r = await c.var.db.tx(scope(c), (tx) => {
      const ctx = rctx(c, tx);
      assertCanMoveStock(ctx);
      return moveStock(ctx, { productId: b.productId, warehouseId: b.warehouseId, type: b.type, qty: b.type === 'out' ? -b.quantity : b.quantity, reason: b.reason ?? null, unitCost: b.unitCost ?? null });
    });
    return c.json(r, 201);
  })
  .post('/inventory/transfers', async (c) => {
    requireApp(c, 'inventory');
    const b = z.object({ productId: uuid, from: uuid, to: uuid, quantity: z.number().positive(), reason: z.string().max(300).nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => {
      const ctx = rctx(c, tx);
      assertCanMoveStock(ctx);
      return transferStock(ctx, b.productId, b.from, b.to, b.quantity, b.reason ?? null);
    });
    return c.json(r, 201);
  })
  .get('/inventory/products/:id', async (c) => {
    requireApp(c, 'inventory');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => productStock(rctx(c, tx), uuid.parse(c.req.param('id')))));
  })
  .put('/inventory/settings', async (c) => {
    if (!hasAdmin(c.var.principal.permissions, 'operations')) throw forbidden();
    const b = z.object({ allowNegative: z.boolean() }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => tx.query(`update tenants set settings = jsonb_set(settings, '{inventory}', coalesce(settings -> 'inventory', '{}'::jsonb) || $2::jsonb) where id = $1`, [c.var.tenant.id, JSON.stringify(b)]));
    return c.json(b);
  })
  .get('/inventory/settings', async (c) =>
    c.json((await c.var.db.tx(scope(c, true), (tx) => tx.one<{ s: Record<string, unknown> | null }>(`select settings -> 'inventory' as s from tenants where id = $1`, [c.var.tenant.id])))?.s ?? { allowNegative: false }),
  )

  // ---------------------------------------------------------------- warehouses
  .get('/warehouses', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select w.*, (select count(*) from stock_levels s where s.tenant_id = w.tenant_id and s.warehouse_id = w.id and s.on_hand <> 0)::int as products
             from warehouses w where w.tenant_id = $1 order by w.is_default desc, w.name`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/warehouses', async (c) => {
    canConfigureCatalogue(c);
    const b = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{1,20}$/), name: z.string().trim().min(1).max(120), address: z.string().max(500).nullish(), state: z.string().max(120).nullish(), isDefault: z.boolean().default(false) }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.isDefault) await tx.query(`update warehouses set is_default = false where tenant_id = $1`, [c.var.tenant.id]);
      return tx.one(`insert into warehouses (tenant_id, code, name, address, state, is_default) values ($1,upper($2),$3,$4,$5,$6) returning *`, [c.var.tenant.id, b.code, b.name, b.address ?? null, b.state ?? null, b.isDefault]);
    });
    return c.json(row, 201);
  })
  .patch('/warehouses/:id', async (c) => {
    canConfigureCatalogue(c);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), address: z.string().max(500).nullish(), state: z.string().max(120).nullish(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.isDefault) await tx.query(`update warehouses set is_default = false where tenant_id = $1 and id <> $2`, [c.var.tenant.id, id]);
      if (b.isActive === false) {
        const st = await tx.one<{ n: string }>(`select count(*) n from stock_levels where tenant_id = $1 and warehouse_id = $2 and (on_hand <> 0 or reserved <> 0)`, [c.var.tenant.id, id]);
        if (Number(st?.n)) throw badRequest('Move the stock out of this warehouse before deactivating it');
      }
      return tx.one(
        `update warehouses set name = coalesce($3, name), address = case when $4::boolean then $5 else address end, state = case when $6::boolean then $7 else state end,
                is_default = coalesce($8, is_default), is_active = coalesce($9, is_active) where tenant_id = $1 and id = $2 returning *`,
        [c.var.tenant.id, id, b.name ?? null, b.address !== undefined, b.address ?? null, b.state !== undefined, b.state ?? null, b.isDefault ?? null, b.isActive ?? null],
      );
    });
    if (!row) throw notFound();
    return c.json(row);
  })

  // ---------------------------------------------------------------- categories + variants
  .get('/product-categories', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select pc.*, (select count(*) from products p where p.tenant_id = pc.tenant_id and p.category_id = pc.id and p.deleted_at is null)::int as products
             from product_categories pc where pc.tenant_id = $1 order by pc.position, pc.name`,
          [c.var.tenant.id],
        ),
      ),
    }),
  )
  .post('/product-categories', async (c) => {
    canConfigureCatalogue(c);
    const b = z.object({ name: z.string().trim().min(1).max(120), parentId: uuid.nullish() }).parse(await c.req.json());
    const row = await c.var.db.tx(scope(c), (tx) => tx.one(`insert into product_categories (tenant_id, name, parent_id) values ($1,$2,$3) returning *`, [c.var.tenant.id, b.name, b.parentId ?? null]));
    return c.json(row, 201);
  })
  .patch('/product-categories/:id', async (c) => {
    canConfigureCatalogue(c);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), parentId: uuid.nullish() }).parse(await c.req.json());
    const id = uuid.parse(c.req.param('id'));
    if (b.parentId === id) throw badRequest('A category cannot be its own parent');
    const row = await c.var.db.tx(scope(c), async (tx) => {
      if (b.parentId) {
        // refuse cycles: the new parent must not be a descendant
        const cyc = await tx.one(
          `with recursive d as (select id from product_categories where tenant_id = $1 and parent_id = $2 union all select pc.id from product_categories pc join d on pc.parent_id = d.id where pc.tenant_id = $1) select 1 from d where id = $3`,
          [c.var.tenant.id, id, b.parentId],
        );
        if (cyc) throw badRequest('That would put the category inside itself');
      }
      return tx.one(`update product_categories set name = coalesce($3, name), parent_id = case when $4::boolean then $5::uuid else parent_id end where tenant_id = $1 and id = $2 returning *`, [
        c.var.tenant.id, id, b.name ?? null, b.parentId !== undefined, b.parentId ?? null,
      ]);
    });
    if (!row) throw notFound();
    return c.json(row);
  })
  .delete('/product-categories/:id', async (c) => {
    canConfigureCatalogue(c);
    await c.var.db.tx(scope(c), (tx) => tx.query(`delete from product_categories where tenant_id = $1 and id = $2`, [c.var.tenant.id, uuid.parse(c.req.param('id'))]));
    return c.json({ ok: true });
  })
  .post('/products/:id/variants', async (c) => {
    if (objectPerm(c.var.principal.permissions, 'product').create !== true) throw forbidden();
    const b = z.object({ attributes: z.array(z.object({ name: z.string().trim().min(1).max(40), values: z.array(z.string().trim().min(1).max(40)).min(1).max(20) })).min(1).max(3) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => createVariants(rctx(c, tx), uuid.parse(c.req.param('id')), b.attributes)), 201);
  })
  .get('/products/:id/variants', async (c) =>
    c.json({
      items: await c.var.db.tx(scope(c, true), (tx) =>
        tx.query(
          `select p.id, p.name, p.sku, p.variant_options, p.list_price::float8 as list_price,
                  coalesce((select sum(on_hand - reserved) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0)::float8 as available
             from products p where p.tenant_id = $1 and p.variant_of = $2 and p.deleted_at is null order by p.variant_options`,
          [c.var.tenant.id, uuid.parse(c.req.param('id'))],
        ),
      ),
    }),
  )

  // ============================================================================ sales orders
  .get('/orders/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getOrder(rctx(c, tx), c.req.param('id')))))
  .put('/orders/:id/lines', async (c) => {
    const b = z.object({ lines: z.array(lineSchema).max(300) }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => saveOrderLines(rctx(c, tx), c.req.param('id'), b.lines));
    await emit(c, events);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getOrder(rctx(c, tx), c.req.param('id'))));
  })
  .post('/orders/from-quote/:quoteId', async (c) => {
    requireApp(c, 'orders');
    const b = z.object({ allowUnaccepted: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    const r = await c.var.db.tx(scope(c), (tx) => orderFromQuote(rctx(c, tx), c.req.param('quoteId'), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .post('/orders/:id/confirm', async (c) => {
    const events = await c.var.db.tx(scope(c), (tx) => confirmOrder(rctx(c, tx), c.req.param('id')));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/orders/:id/status', async (c) => {
    const b = z.object({ status: z.enum(['confirmed', 'in_production', 'ready', 'dispatched', 'delivered', 'installed', 'completed', 'cancelled']), reason: z.string().max(500).nullish() }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => changeStatus(rctx(c, tx), c.req.param('id'), b.status, b.reason ?? null));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/orders/:id/reopen', async (c) => {
    const events = await c.var.db.tx(scope(c), (tx) => reopenOrder(rctx(c, tx), c.req.param('id')));
    await emit(c, events);
    return c.json({ ok: true });
  })
  /** Ships everything still open straight from stock (when deliveries are not tracked separately). */
  .post('/orders/:id/deliver', async (c) => {
    const id = c.req.param('id');
    const events = await c.var.db.tx(scope(c), async (tx) => {
      const ctx = rctx(c, tx);
      const { row } = await loadRow(ctx, 'sales_order', id, 'update', true);
      return shipLines(ctx, id, null, { object: 'sales_order', id, label: `Order ${row.order_number} delivered` });
    });
    await emit(c, events);
    return c.json({ ok: true });
  })
  .put('/orders/:id/milestones', async (c) => {
    const b = z
      .object({
        milestones: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(120),
              percent: z.number().positive().max(100).nullish(),
              amount: z.number().min(0).max(1e12).nullish(),
              trigger: z.enum(['on_confirmation', 'before_dispatch', 'on_delivery', 'on_installation', 'on_date']),
              dueDate: dateStr.nullish(),
              notes: z.string().max(500).nullish(),
            }),
          )
          .max(12),
      })
      .parse(await c.req.json());
    for (const m of b.milestones) if (!m.percent && m.amount == null) throw badRequest(`“${m.name}” needs a percentage or an amount`);
    return c.json(await c.var.db.tx(scope(c), (tx) => setMilestones(rctx(c, tx), c.req.param('id'), b.milestones)));
  })
  .post('/orders/:id/milestones/:mid/payments', async (c) => {
    const b = z.object({ amount: z.number().positive().max(1e12), note: z.string().max(500).nullish() }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => recordMilestonePayment(rctx(c, tx), c.req.param('id'), uuid.parse(c.req.param('mid')), b.amount, b.note ?? null));
    await emit(c, events);
    return c.json({ ok: true });
  })

  // ============================================================================ purchasing
  .get('/purchase-orders/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => getPurchaseOrder(rctx(c, tx), c.req.param('id')))))
  .put('/purchase-orders/:id/lines', async (c) => {
    const b = z.object({ lines: z.array(lineSchema).max(300) }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => savePoLines(rctx(c, tx), c.req.param('id'), b.lines));
    await emit(c, events);
    return c.json(await c.var.db.tx(scope(c, true), (tx) => getPurchaseOrder(rctx(c, tx), c.req.param('id'))));
  })
  .post('/purchase-orders/:id/issue', async (c) => {
    const events = await c.var.db.tx(scope(c), (tx) => issuePo(rctx(c, tx), c.req.param('id')));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/purchase-orders/:id/close', async (c) => {
    const b = z.object({ cancel: z.boolean().default(false), reason: z.string().max(500).nullish() }).parse(await c.req.json());
    const events = await c.var.db.tx(scope(c), (tx) => closePo(rctx(c, tx), c.req.param('id'), b.cancel, b.reason ?? null));
    await emit(c, events);
    return c.json({ ok: true });
  })
  .post('/purchase-orders/:id/receive', async (c) => {
    requireApp(c, 'purchasing');
    const b = z
      .object({
        warehouseId: uuid.nullish(),
        receivedOn: dateStr.nullish(),
        vendorInvoice: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
        lines: z.array(z.object({ poLineId: uuid, received: z.number().min(0), rejected: z.number().min(0).optional(), reason: z.string().max(300).nullish() })).min(1).max(300),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => receiveGoods(rctx(c, tx), c.req.param('id'), b));
    await emit(c, r.events);
    return c.json({ receiptId: r.receiptId, receiptNumber: r.receiptNumber }, 201);
  })
  .post('/purchase-orders/from-order/:orderId', async (c) => {
    requireApp(c, 'purchasing');
    const b = z.object({ vendorId: uuid, lineIds: z.array(uuid).max(300).nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => poFromOrder(rctx(c, tx), c.req.param('orderId'), b.vendorId, b.lineIds ?? null));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })
  .get('/vendors/:id/performance', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => vendorPerformance(rctx(c, tx), c.req.param('id')))))

  // ============================================================================ apps (read)
  .get('/apps', (c) => c.json({ items: listApps(c.var.meta) }));

export const appsAdminRoutes = new Hono<AppEnv>()
  .get('/apps', requireAdmin('modules'), (c) => c.json({ items: listApps(c.var.meta) }))
  .post('/apps/:key/enable', requireAdmin('modules'), async (c) => c.json(await c.var.db.tx(scope(c), (tx) => enableApp(rctx(c, tx), c.req.param('key')))))
  .post('/apps/:key/disable', requireAdmin('modules'), async (c) => c.json(await c.var.db.tx(scope(c), (tx) => disableApp(rctx(c, tx), c.req.param('key')))));

