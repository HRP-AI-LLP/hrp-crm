/**
 * Inventory: warehouses, stock levels per (product, warehouse) and an append-only movement ledger.
 *
 *   on_hand    physical quantity in the warehouse
 *   reserved   promised to confirmed sales orders (not yet shipped)
 *   available  on_hand − reserved
 *
 * Every change locks the stock row, writes one ledger row and re-checks the reorder level.
 * Stock can't go negative unless the workspace allows it (settings.inventory.allowNegative).
 */
import { hasAdmin, objectPerm } from '@synapse/shared';
import { badRequest, forbidden, notFound } from '../lib/errors';
import type { RecordCtx } from './records';

export type MovementType = 'in' | 'out' | 'adjust' | 'transfer_in' | 'transfer_out' | 'reserve' | 'release';

export interface Movement {
  productId: string;
  warehouseId: string;
  type: MovementType;
  /** signed change of on_hand */
  qty?: number;
  /** signed change of reserved */
  reserved?: number;
  reason?: string | null;
  unitCost?: number | null;
  ref?: { object: string; id: string; label: string } | null;
}

const n3 = (x: unknown) => Math.round(Number(x ?? 0) * 1000) / 1000;

/** Stock changes need product edit rights for every product, or the operations admin area. */
export function assertCanMoveStock(ctx: RecordCtx) {
  if (ctx.principal.sessionId === 'system') return;
  if (hasAdmin(ctx.principal.permissions, 'operations')) return;
  if (objectPerm(ctx.principal.permissions, 'product').update === 'all') return;
  throw forbidden('You need inventory access to change stock');
}

export async function defaultWarehouse(ctx: RecordCtx): Promise<string> {
  const wh = await ctx.tx.one<{ id: string }>(`select id from warehouses where tenant_id = $1 and is_active order by is_default desc, created_at limit 1`, [ctx.tenantId]);
  if (wh) return wh.id;
  const created = await ctx.tx.one<{ id: string }>(`insert into warehouses (tenant_id, code, name, is_default) values ($1, 'MAIN', 'Main warehouse', true) returning id`, [ctx.tenantId]);
  return created!.id;
}

async function allowNegative(ctx: RecordCtx): Promise<boolean> {
  const r = await ctx.tx.one<{ v: string | null }>(`select settings -> 'inventory' ->> 'allowNegative' as v from tenants where id = $1`, [ctx.tenantId]);
  return r?.v === 'true';
}

/** Applies one movement atomically; returns the new level. */
export async function moveStock(ctx: RecordCtx, m: Movement) {
  const qty = n3(m.qty);
  const res = n3(m.reserved);
  if (!qty && !res) throw badRequest('Quantity must not be zero');
  const product = await ctx.tx.one<{ id: string; name: string; track_inventory: boolean; product_type: string }>(
    `select id, name, track_inventory, product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`,
    [ctx.tenantId, m.productId],
  );
  if (!product) throw notFound('Product not found');
  if (product.product_type === 'service') throw badRequest(`${product.name} is a service; services carry no stock`);
  const wh = await ctx.tx.one<{ id: string; is_active: boolean }>(`select id, is_active from warehouses where tenant_id = $1 and id = $2`, [ctx.tenantId, m.warehouseId]);
  if (!wh) throw notFound('Warehouse not found');
  if (!wh.is_active) throw badRequest('This warehouse is inactive');

  await ctx.tx.query(`insert into stock_levels (tenant_id, product_id, warehouse_id) values ($1,$2,$3) on conflict do nothing`, [ctx.tenantId, m.productId, m.warehouseId]);
  const lvl = await ctx.tx.one<{ on_hand: string; reserved: string }>(
    `select on_hand, reserved from stock_levels where tenant_id = $1 and product_id = $2 and warehouse_id = $3 for update`,
    [ctx.tenantId, m.productId, m.warehouseId],
  );
  const onHand = n3(n3(lvl!.on_hand) + qty);
  const reserved = n3(n3(lvl!.reserved) + res);
  if (reserved < 0) throw badRequest(`Cannot release more of ${product.name} than is reserved`);
  if (qty < 0 && onHand < 0 && !(await allowNegative(ctx))) {
    throw badRequest(`Not enough stock of ${product.name}: ${n3(lvl!.on_hand)} on hand`);
  }
  if (res > 0 && onHand - reserved < 0 && !(await allowNegative(ctx))) {
    throw badRequest(`Not enough stock of ${product.name} to reserve: ${n3(n3(lvl!.on_hand) - n3(lvl!.reserved))} available`);
  }
  await ctx.tx.query(`update stock_levels set on_hand = $4, reserved = $5, updated_at = now() where tenant_id = $1 and product_id = $2 and warehouse_id = $3`, [
    ctx.tenantId, m.productId, m.warehouseId, onHand, reserved,
  ]);
  await ctx.tx.query(
    `insert into stock_movements (tenant_id, product_id, warehouse_id, movement_type, qty_delta, reserved_delta, on_hand_after, unit_cost, reason, ref_object, ref_id, ref_label, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [ctx.tenantId, m.productId, m.warehouseId, m.type, qty, res, onHand, m.unitCost ?? null, m.reason ?? null, m.ref?.object ?? null, m.ref?.id ?? null, m.ref?.label ?? null, ctx.principal.sessionId === 'system' ? null : ctx.principal.user.id],
  );
  if (!product.track_inventory) await ctx.tx.query(`update products set track_inventory = true where tenant_id = $1 and id = $2`, [ctx.tenantId, m.productId]);
  // a transfer is checked once both legs are booked
  if (m.type !== 'transfer_out') await checkReorder(ctx, m.productId);
  return { onHand, reserved, available: n3(onHand - reserved) };
}

export async function transferStock(ctx: RecordCtx, productId: string, from: string, to: string, qty: number, reason: string | null) {
  if (from === to) throw badRequest('Choose two different warehouses');
  if (!(qty > 0)) throw badRequest('Quantity must be positive');
  const ref = { object: 'transfer', id: crypto.randomUUID(), label: 'Stock transfer' };
  await moveStock(ctx, { productId, warehouseId: from, type: 'transfer_out', qty: -qty, reason, ref });
  return moveStock(ctx, { productId, warehouseId: to, type: 'transfer_in', qty, reason, ref });
}

/** Available across all warehouses vs. the reorder level; notifies once until stock recovers. */
async function checkReorder(ctx: RecordCtx, productId: string) {
  const r = await ctx.tx.one<{ name: string; reorder_level: string | null; reorder_qty: string | null; reorder_alerted_at: Date | null; available: string }>(
    `select p.name, p.reorder_level, p.reorder_qty, p.reorder_alerted_at,
            coalesce((select sum(on_hand - reserved) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0) as available
       from products p where p.tenant_id = $1 and p.id = $2`,
    [ctx.tenantId, productId],
  );
  if (!r || r.reorder_level === null) return;
  const low = Number(r.available) <= Number(r.reorder_level);
  if (low && !r.reorder_alerted_at) {
    await ctx.tx.query(`update products set reorder_alerted_at = now() where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]);
    const users = await ctx.tx.query<{ id: string }>(
      `select distinct u.id from users u
         left join user_roles ur on ur.tenant_id = u.tenant_id and ur.user_id = u.id
         left join roles ro on ro.tenant_id = ur.tenant_id and ro.id = ur.role_id
        where u.tenant_id = $1 and u.status = 'active' and (u.is_owner or ro.key in ('inventory_manager', 'operations', 'admin'))`,
      [ctx.tenantId],
    );
    for (const u of users) {
      await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'stock',$3,$4,$5)`, [
        ctx.tenantId, u.id, `Low stock: ${r.name}`, `${Number(r.available)} available (reorder level ${Number(r.reorder_level)}${r.reorder_qty ? `, usual order ${Number(r.reorder_qty)}` : ''})`, `/o/product/${productId}`,
      ]);
    }
  } else if (!low && r.reorder_alerted_at) {
    await ctx.tx.query(`update products set reorder_alerted_at = null where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]);
  }
}

export async function stockOverview(ctx: RecordCtx, opts: { q?: string; warehouseId?: string; lowOnly?: boolean; categoryId?: string; limit?: number }) {
  if (objectPerm(ctx.principal.permissions, 'product').read === 'none') throw forbidden();
  const vals: unknown[] = [ctx.tenantId];
  const where = [`p.tenant_id = $1`, `p.deleted_at is null`, `p.product_type = 'goods'`, `(p.track_inventory or exists (select 1 from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id))`];
  if (opts.q) {
    vals.push(`%${opts.q.toLowerCase()}%`);
    where.push(`(lower(p.name) like $${vals.length} or lower(coalesce(p.sku, '')) like $${vals.length} or lower(coalesce(p.barcode, '')) like $${vals.length})`);
  }
  if (opts.categoryId) {
    vals.push(opts.categoryId);
    where.push(`p.category_id = $${vals.length}::uuid`);
  }
  const whFilter = opts.warehouseId ? (vals.push(opts.warehouseId), ` and s.warehouse_id = $${vals.length}::uuid`) : '';
  const rows = await ctx.tx.query<Record<string, unknown>>(
    `select p.id, p.name, p.sku, p.unit, p.variant_options, p.reorder_level::float8 as reorder_level, p.reorder_qty::float8 as reorder_qty, p.cost_price::float8 as cost_price,
            p.category_id,
            coalesce(sum(s.on_hand), 0)::float8 as on_hand, coalesce(sum(s.reserved), 0)::float8 as reserved,
            coalesce(sum(s.on_hand - s.reserved), 0)::float8 as available,
            coalesce(jsonb_object_agg(s.warehouse_id, jsonb_build_object('onHand', s.on_hand, 'reserved', s.reserved)) filter (where s.warehouse_id is not null), '{}'::jsonb) as by_warehouse
       from products p
       left join stock_levels s on s.tenant_id = p.tenant_id and s.product_id = p.id${whFilter}
      where ${where.join(' and ')}
      group by p.id
      ${opts.lowOnly ? 'having p.reorder_level is not null and coalesce(sum(s.on_hand - s.reserved), 0) <= p.reorder_level' : ''}
      order by p.name limit ${Math.min(opts.limit ?? 500, 2000)}`,
    vals,
  );
  const totals = await ctx.tx.one<{ value: string; low: string; skus: string }>(
    `select coalesce(sum(s.on_hand * coalesce(p.cost_price, 0)), 0) as value,
            (select count(*) from products p2 where p2.tenant_id = $1 and p2.deleted_at is null and p2.reorder_level is not null
               and coalesce((select sum(on_hand - reserved) from stock_levels s2 where s2.tenant_id = p2.tenant_id and s2.product_id = p2.id), 0) <= p2.reorder_level) as low,
            (select count(*) from products p3 where p3.tenant_id = $1 and p3.deleted_at is null and p3.track_inventory) as skus
       from stock_levels s join products p on p.tenant_id = s.tenant_id and p.id = s.product_id where s.tenant_id = $1`,
    [ctx.tenantId],
  );
  return { items: rows, totals: { stockValue: Number(totals?.value ?? 0), lowStock: Number(totals?.low ?? 0), trackedProducts: Number(totals?.skus ?? 0) } };
}

export async function movements(ctx: RecordCtx, opts: { productId?: string; warehouseId?: string; limit?: number }) {
  if (objectPerm(ctx.principal.permissions, 'product').read === 'none') throw forbidden();
  const vals: unknown[] = [ctx.tenantId];
  const where = ['m.tenant_id = $1'];
  if (opts.productId) {
    vals.push(opts.productId);
    where.push(`m.product_id = $${vals.length}::uuid`);
  }
  if (opts.warehouseId) {
    vals.push(opts.warehouseId);
    where.push(`m.warehouse_id = $${vals.length}::uuid`);
  }
  return ctx.tx.query(
    `select m.id, m.movement_type, m.qty_delta::float8 as qty_delta, m.reserved_delta::float8 as reserved_delta, m.on_hand_after::float8 as on_hand_after, m.reason,
            m.ref_object, m.ref_id, m.ref_label, m.created_at, p.name as product_name, p.sku, w.name as warehouse_name, u.full_name as user_name
       from stock_movements m
       join products p on p.tenant_id = m.tenant_id and p.id = m.product_id
       join warehouses w on w.tenant_id = m.tenant_id and w.id = m.warehouse_id
       left join users u on u.tenant_id = m.tenant_id and u.id = m.created_by
      where ${where.join(' and ')} order by m.created_at desc, m.id desc limit ${Math.min(opts.limit ?? 200, 1000)}`,
    vals,
  );
}

/** Product page: per-warehouse levels plus recent movements. */
export async function productStock(ctx: RecordCtx, productId: string) {
  const levels = await ctx.tx.query(
    `select w.id as warehouse_id, w.name, w.code, coalesce(s.on_hand, 0)::float8 as on_hand, coalesce(s.reserved, 0)::float8 as reserved, coalesce(s.on_hand - s.reserved, 0)::float8 as available
       from warehouses w left join stock_levels s on s.tenant_id = w.tenant_id and s.warehouse_id = w.id and s.product_id = $2
      where w.tenant_id = $1 and (w.is_active or s.on_hand <> 0) order by w.is_default desc, w.name`,
    [ctx.tenantId, productId],
  );
  return { levels, movements: await movements(ctx, { productId, limit: 50 }) };
}

/** Creates one variant per combination, e.g. {Finish: [Teak, Walnut], Size: [2-seater, 3-seater]} → 4 products. */
export async function createVariants(ctx: RecordCtx, parentId: string, attributes: { name: string; values: string[] }[]) {
  const parent = await ctx.tx.one<Record<string, unknown>>(`select * from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, parentId]);
  if (!parent) throw notFound();
  if (parent.variant_of) throw badRequest('Create variants from the main product, not from a variant');
  const combos = attributes.reduce<string[][]>((acc, a) => acc.flatMap((c) => a.values.map((v) => [...c, v.trim()])), [[]]).filter((c) => c.length);
  if (!combos.length) throw badRequest('Add at least one value');
  if (combos.length > 100) throw badRequest('At most 100 variants at a time');
  const existing = new Set(
    (await ctx.tx.query<{ v: string }>(`select lower(variant_options) as v from products where tenant_id = $1 and variant_of = $2 and deleted_at is null`, [ctx.tenantId, parentId])).map((r) => r.v),
  );
  const created: string[] = [];
  for (const c of combos) {
    const label = c.join(' / ');
    if (existing.has(label.toLowerCase())) continue;
    const sku = parent.sku ? `${parent.sku}-${c.map((x) => x.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase()).join('-')}` : null;
    const r = await ctx.tx.one<{ id: string }>(
      `insert into products (tenant_id, name, sku, family, unit, description, list_price, tax_rate, hsn_sac, category_id, product_type, track_inventory, reorder_level, reorder_qty, cost_price, mrp, variant_of, variant_options, owner_id)
       select tenant_id, name || ' — ' || $3, $4, family, unit, description, list_price, tax_rate, hsn_sac, category_id, product_type, track_inventory, reorder_level, reorder_qty, cost_price, mrp, id, $3, owner_id
         from products where tenant_id = $1 and id = $2
       on conflict do nothing returning id`,
      [ctx.tenantId, parentId, label, sku],
    );
    if (r) created.push(r.id);
  }
  return { created: created.length, skipped: combos.length - created.length };
}
