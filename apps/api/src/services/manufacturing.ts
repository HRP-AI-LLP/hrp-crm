/**
 * Manufacturing: work centres, bills of materials (multi-level, with routing and by-products),
 * work orders, batches / lots with expiry and traceability, quality checks, job work under GST
 * challans, and MRP.
 *
 * Costing (perpetual, at moving average): issuing material moves its value from stock to work in
 * progress; recorded operation time absorbs labour and overhead at the work centre's hourly cost;
 * output relieves WIP into finished stock (by-products take their cost share, scrap goes to the
 * scrap account); closing an order books what is left in WIP as a variance. When SanchalanOS keeps the
 * books, each step posts a journal (source "work_order" / "job_work").
 *
 * Access: bills of materials, work centres and MRP need the "manufacturing" admin area; actions on
 * a work order need edit access to it; on a job work, edit access to the job work.
 */
import { fieldAccess, hasAdmin, objectPerm } from '@synapse/shared';
import type { Tx } from '../lib/db';
import { badRequest, forbidden, notFound } from '../lib/errors';
import { postingOn, postJournal, r2, sys, type JLine } from './books/ledger';
import { defaultWarehouse, moveStock } from './inventory';
import { nextFyNumber } from './numbering';
import { savePoLines } from './purchasing';
import { letterhead } from './quotes';
import { createRecord, loadRow, type RecordCtx, type RecordEvent } from './records';

const n3 = (x: unknown) => Math.round(Number(x ?? 0) * 1000) / 1000;
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function assertMfgAdmin(ctx: RecordCtx) {
  if (!hasAdmin(ctx.principal.permissions, 'manufacturing')) throw forbidden('Requires the "manufacturing" admin permission');
}

const isMfgOrOps = (ctx: RecordCtx) => hasAdmin(ctx.principal.permissions, 'manufacturing') || hasAdmin(ctx.principal.permissions, 'operations');

/** Production screens (overview, lots, quality, BOMs, reports): manufacturing / operations admins or anyone who may read work orders. */
export function assertMfgRead(ctx: RecordCtx) {
  if (isMfgOrOps(ctx) || objectPerm(ctx.principal.permissions, 'work_order').read !== 'none') return;
  throw forbidden('You need access to work orders');
}

/** Costs (material, labour, standard cost, rates) follow the product's cost price: hidden unless the person may see and edit costs. */
export function canSeeCost(ctx: RecordCtx) {
  const p = ctx.principal.permissions;
  if (hasAdmin(p, 'manufacturing') || hasAdmin(p, 'operations') || hasAdmin(p, 'books')) return true;
  return fieldAccess(p, 'product', 'cost_price') !== 'hidden' && objectPerm(p, 'product').update === 'all';
}

/** Release, close and cancel decide what is made and what is booked: planners only, not the shop floor. */
function assertPlanner(ctx: RecordCtx) {
  if (hasAdmin(ctx.principal.permissions, 'manufacturing') || objectPerm(ctx.principal.permissions, 'work_order').create) return;
  throw forbidden('Releasing, closing and cancelling work orders is for planners');
}

/** Moving-average cost of a product (falls back to the last purchase / cost price). */
async function unitCostOf(tx: Tx, tenantId: string, productId: string) {
  const p = await tx.one<{ avg_cost: string | null; cost_price: string | null; purchase_price: string | null }>(`select avg_cost, cost_price, purchase_price from products where tenant_id = $1 and id = $2`, [tenantId, productId]);
  return Number(p?.avg_cost ?? 0) || Number(p?.purchase_price ?? 0) || Number(p?.cost_price ?? 0) || 0;
}

/** Updates a product's moving-average cost for stock coming in at unitCost (call before moving the stock). */
async function averageIn(tx: Tx, tenantId: string, productId: string, qty: number, unitCost: number) {
  await tx.query(
    `update products p set avg_cost = case when coalesce((select sum(on_hand) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0) <= 0 or coalesce(p.avg_cost, 0) = 0 then round($4::numeric, 4)
                                          else round((greatest(coalesce((select sum(on_hand) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0), 0) * p.avg_cost + $3::numeric * $4::numeric)
                                                     / (greatest(coalesce((select sum(on_hand) from stock_levels s where s.tenant_id = p.tenant_id and s.product_id = p.id), 0), 0) + $3::numeric), 4) end
      where p.tenant_id = $1 and p.id = $2`,
    [tenantId, productId, qty, unitCost],
  );
}

async function post(ctx: RecordCtx, sourceType: 'work_order' | 'job_work', sourceId: string, date: string, reference: string, narration: string, lines: JLine[]) {
  if (!(await postingOn(ctx.tx, ctx.tenantId))) return null;
  if (!lines.some((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0)) return null;
  return postJournal(ctx.tx, ctx.tenantId, { date, sourceType, sourceId, reference, narration, lines });
}

/* ───────────────────────── lots ───────────────────────── */

/** Takes qty out of a batch-tracked product's lots, the given lot or first-expiry-first-out. Returns the lots used. */
async function consumeLots(ctx: RecordCtx, productId: string, warehouseId: string, qty: number, lotId?: string | null) {
  const p = await ctx.tx.one<{ batch_tracked: boolean }>(`select batch_tracked from products where tenant_id = $1 and id = $2`, [ctx.tenantId, productId]);
  if (!p?.batch_tracked) return [];
  const lots = await ctx.tx.query<{ id: string; on_hand: string; lot_number: string }>(
    `select id, on_hand, lot_number from stock_lots where tenant_id = $1 and product_id = $2 and warehouse_id = $3 and on_hand > 0 and status = 'available' and ($4::uuid is null or id = $4)
      order by expiry_date nulls last, created_at for update`,
    [ctx.tenantId, productId, warehouseId, lotId ?? null],
  );
  if (lotId && !lots.length) throw badRequest('That lot has no available stock here');
  const used: { lotId: string; qty: number }[] = [];
  let left = qty;
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, Number(l.on_hand));
    await ctx.tx.query(`update stock_lots set on_hand = on_hand - $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, take]);
    used.push({ lotId: l.id, qty: n3(take) });
    left = n3(left - take);
  }
  if (lotId && left > 0) throw badRequest('Not enough in that lot');
  if (left > 0) {
    // stock not (yet) in any lot may be used; stock in quarantined or rejected lots may not
    const r = await ctx.tx.one<{ free: string }>(
      `select coalesce((select on_hand from stock_levels where tenant_id = $1 and product_id = $2 and warehouse_id = $3), 0)
              - coalesce((select sum(on_hand) from stock_lots where tenant_id = $1 and product_id = $2 and warehouse_id = $3), 0) as free`,
      [ctx.tenantId, productId, warehouseId],
    );
    if (left > n3(Math.max(0, Number(r?.free ?? 0))) + 1e-9) throw badRequest(`Only ${n3(qty - left + Math.max(0, Number(r?.free ?? 0)))} can be used: the rest is in batches on hold or rejected`);
  }
  return used;
}

async function addToLot(ctx: RecordCtx, input: { productId: string; warehouseId: string; lotNumber: string; qty: number; mfgDate?: string | null; expiryDate?: string | null; source: string; sourceId?: string | null }) {
  const existing = await ctx.tx.one<{ status: string }>(`select status from stock_lots where tenant_id = $1 and product_id = $2 and warehouse_id = $3 and lot_number = $4 for update`, [ctx.tenantId, input.productId, input.warehouseId, input.lotNumber]);
  if (existing && existing.status !== 'available') throw badRequest(`Batch ${input.lotNumber} is ${existing.status}; use another batch number`);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into stock_lots (tenant_id, product_id, warehouse_id, lot_number, mfg_date, expiry_date, on_hand, source, source_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (tenant_id, product_id, warehouse_id, lot_number) do update set on_hand = stock_lots.on_hand + excluded.on_hand, expiry_date = coalesce(stock_lots.expiry_date, excluded.expiry_date)
     returning id`,
    [ctx.tenantId, input.productId, input.warehouseId, input.lotNumber, input.mfgDate ?? today(), input.expiryDate ?? null, input.qty, input.source, input.sourceId ?? null],
  );
  return r!.id;
}

export async function listLots(ctx: RecordCtx, q: { productId?: string | null; expiringDays?: number | null; includeEmpty?: boolean }) {
  assertMfgRead(ctx);
  return ctx.tx.query(
    `select l.id, l.lot_number, l.product_id, p.name as product, l.warehouse_id, w.name as warehouse, l.mfg_date, l.expiry_date, l.on_hand::float8 as on_hand, l.status, l.source, l.source_id,
            case when l.expiry_date is not null then l.expiry_date - current_date end as days_left
       from stock_lots l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id join warehouses w on w.tenant_id = l.tenant_id and w.id = l.warehouse_id
      where l.tenant_id = $1 and ($2::uuid is null or l.product_id = $2) and ($3::boolean or l.on_hand > 0)
        and ($4::int is null or l.expiry_date <= current_date + $4::int)
      order by l.expiry_date nulls last, l.created_at desc limit 1000`,
    [ctx.tenantId, q.productId ?? null, !!q.includeEmpty, q.expiringDays ?? null],
  );
}

/** Registers a lot for stock already received (goods receipt, opening stock): lots never exceed the stock on hand. */
export async function registerLot(ctx: RecordCtx, input: { productId: string; warehouseId: string; lotNumber: string; qty: number; mfgDate?: string | null; expiryDate?: string | null }) {
  if (!isMfgOrOps(ctx)) throw forbidden('Registering lots needs the manufacturing or operations permission');
  const lvl = await ctx.tx.one<{ on_hand: string }>(`select on_hand from stock_levels where tenant_id = $1 and product_id = $2 and warehouse_id = $3 for update`, [ctx.tenantId, input.productId, input.warehouseId]);
  const inLots = await ctx.tx.one<{ v: string }>(`select coalesce(sum(on_hand), 0) as v from stock_lots where tenant_id = $1 and product_id = $2 and warehouse_id = $3`, [ctx.tenantId, input.productId, input.warehouseId]);
  if (n3(Number(inLots!.v) + input.qty) > n3(Number(lvl?.on_hand ?? 0))) throw badRequest(`Only ${n3(Number(lvl?.on_hand ?? 0) - Number(inLots!.v))} of this product is not yet in a lot here`);
  await ctx.tx.query(`update products set batch_tracked = true where tenant_id = $1 and id = $2`, [ctx.tenantId, input.productId]);
  return { id: await addToLot(ctx, { ...input, source: 'receipt' }) };
}

export async function setLotStatus(ctx: RecordCtx, lotId: string, status: 'available' | 'quarantine' | 'rejected') {
  if (!isMfgOrOps(ctx)) throw forbidden('Changing a batch status needs the manufacturing or operations permission');
  const r = await ctx.tx.one(`update stock_lots set status = $3 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, lotId, status]);
  if (!r) throw notFound('Lot not found');
}

/** Where a lot came from (its inputs, recursively) and where it went (lots made from it). */
export async function traceLot(ctx: RecordCtx, lotId: string) {
  assertMfgRead(ctx);
  const lot = await ctx.tx.one(
    `select l.id, l.lot_number, l.product_id, p.name as product, l.mfg_date, l.expiry_date, l.on_hand::float8 as on_hand, l.status, l.source, l.source_id
       from stock_lots l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.id = $2`,
    [ctx.tenantId, lotId],
  );
  if (!lot) throw notFound('Lot not found');
  const walk = (dir: 'up' | 'down') =>
    ctx.tx.query(
      `with recursive t(id, depth) as (select $2::uuid, 0
          union select ${dir === 'up' ? 'k.parent_lot_id' : 'k.child_lot_id'}, t.depth + 1 from lot_links k join t on ${dir === 'up' ? 'k.child_lot_id' : 'k.parent_lot_id'} = t.id where k.tenant_id = $1 and t.depth < 20)
       select distinct t.depth, l.id, l.lot_number, p.name as product, l.expiry_date, l.status,
              (select w.wo_number from lot_links k join work_orders w on w.tenant_id = k.tenant_id and w.id = k.work_order_id where k.tenant_id = $1 and ${dir === 'up' ? 'k.parent_lot_id = l.id' : 'k.child_lot_id = l.id'} limit 1) as work_order
         from t join stock_lots l on l.tenant_id = $1 and l.id = t.id join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where t.depth > 0 order by t.depth limit 500`,
      [ctx.tenantId, lotId],
    );
  return { lot, inputs: await walk('up'), usedIn: await walk('down') };
}

/* ───────────────────────── work centres ───────────────────────── */

export async function listWorkCenters(ctx: RecordCtx) {
  assertMfgRead(ctx);
  return ctx.tx.query(`select id, code, name, hours_per_day::float8 as hours_per_day, days_per_week, parallel_units, ${canSeeCost(ctx) ? 'cost_per_hour::float8' : 'null::float8'} as cost_per_hour, is_active from work_centers where tenant_id = $1 order by code`, [ctx.tenantId]);
}

export async function saveWorkCenter(ctx: RecordCtx, id: string | null, input: { code: string; name: string; hoursPerDay: number; daysPerWeek: number; parallelUnits: number; costPerHour: number; isActive?: boolean }) {
  assertMfgAdmin(ctx);
  const vals = [input.code, input.name, input.hoursPerDay, input.daysPerWeek, input.parallelUnits, input.costPerHour, input.isActive ?? true];
  const dupe = await ctx.tx.one(`select 1 from work_centers where tenant_id = $1 and code = $2 and ($3::uuid is null or id <> $3)`, [ctx.tenantId, input.code, id]);
  if (dupe) throw badRequest('A work centre with that code exists');
  if (id) {
    const r = await ctx.tx.one(`update work_centers set code = $3, name = $4, hours_per_day = $5, days_per_week = $6, parallel_units = $7, cost_per_hour = $8, is_active = $9 where tenant_id = $1 and id = $2 returning id`, [ctx.tenantId, id, ...vals]);
    if (!r) throw notFound('Work centre not found');
    return { id };
  }
  return ctx.tx.one<{ id: string }>(`insert into work_centers (tenant_id, code, name, hours_per_day, days_per_week, parallel_units, cost_per_hour, is_active) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`, [ctx.tenantId, ...vals]);
}

/* ───────────────────────── bills of materials ───────────────────────── */

export interface BomInput {
  productId: string;
  name: string;
  kind?: 'manufacture' | 'process' | 'kit';
  quantity: number;
  yieldPct?: number;
  requiresQc?: boolean;
  notes?: string | null;
  lines: { kind?: 'component' | 'byproduct'; productId: string; quantity: number; scrapPct?: number; costSharePct?: number; operationSeq?: number | null }[];
  operations: { seq: number; name: string; workCenterId?: string | null; setupMinutes?: number; runMinutes?: number; subcontract?: boolean; instructions?: string | null }[];
}

export async function listBoms(ctx: RecordCtx, productId?: string | null) {
  assertMfgRead(ctx);
  return ctx.tx.query(
    `select b.id, b.product_id, p.name as product, p.sku, b.name, b.revision as version, b.kind, b.quantity::float8 as quantity, b.yield_pct::float8 as yield_pct, b.status, b.is_default, b.requires_qc, b.updated_at,
            (select count(*)::int from bom_lines l where l.tenant_id = b.tenant_id and l.bom_id = b.id and l.line_kind = 'component') as components,
            (select count(*)::int from bom_operations o where o.tenant_id = b.tenant_id and o.bom_id = b.id) as operations
       from boms b join products p on p.tenant_id = b.tenant_id and p.id = b.product_id where b.tenant_id = $1 and ($2::uuid is null or b.product_id = $2) order by p.name, b.revision desc limit 2000`,
    [ctx.tenantId, productId ?? null],
  );
}

export async function getBom(ctx: RecordCtx, id: string) {
  assertMfgRead(ctx);
  const b = await ctx.tx.one<Record<string, any>>(
    `select b.*, b.revision as version, b.quantity::float8 as quantity, b.yield_pct::float8 as yield_pct, p.name as product, p.unit from boms b join products p on p.tenant_id = b.tenant_id and p.id = b.product_id where b.tenant_id = $1 and b.id = $2`,
    [ctx.tenantId, id],
  );
  if (!b) throw notFound('Bill of materials not found');
  b.lines = await ctx.tx.query(
    `select l.id, l.line_kind, l.product_id, p.name as product, p.sku, p.unit, l.quantity::float8 as quantity, l.scrap_pct::float8 as scrap_pct, l.cost_share_pct::float8 as cost_share_pct, l.operation_seq, l.position,
            exists (select 1 from boms c where c.tenant_id = l.tenant_id and c.product_id = l.product_id and c.status = 'active') as has_bom
       from bom_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.bom_id = $2 order by l.line_kind, l.position`,
    [ctx.tenantId, id],
  );
  b.operations = await ctx.tx.query(
    `select o.id, o.seq, o.name, o.work_center_id, w.name as work_center, o.setup_minutes::float8 as setup_minutes, o.run_minutes::float8 as run_minutes, o.subcontract, o.instructions
       from bom_operations o left join work_centers w on w.tenant_id = o.tenant_id and w.id = o.work_center_id where o.tenant_id = $1 and o.bom_id = $2 order by o.seq`,
    [ctx.tenantId, id],
  );
  b.cost = canSeeCost(ctx) ? await bomCost(ctx.tx, ctx.tenantId, id) : null;
  return b;
}

/** Products a BOM's components reach through their default BOMs (to refuse cycles). */
async function reaches(tx: Tx, tenantId: string, fromProducts: string[], target: string) {
  const r = await tx.one(
    `with recursive t(pid, depth) as (select unnest($2::uuid[]), 0
       union select l.product_id, t.depth + 1 from t join boms b on b.tenant_id = $1 and b.product_id = t.pid and b.status = 'active'
              join bom_lines l on l.tenant_id = b.tenant_id and l.bom_id = b.id and l.line_kind = 'component' where t.depth < 25)
     select 1 from t where pid = $3 limit 1`,
    [tenantId, fromProducts, target],
  );
  return !!r;
}

async function checkBom(ctx: RecordCtx, input: BomInput) {
  const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, input.productId]);
  if (!p || p.product_type !== 'goods') throw badRequest('A bill of materials is for a goods product');
  if (!input.lines.some((l) => (l.kind ?? 'component') === 'component')) throw badRequest('Add at least one component');
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const found = await ctx.tx.query<{ id: string; product_type: string }>(`select id, product_type from products where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, ids]);
  if (found.length !== ids.length) throw badRequest('A component no longer exists');
  if (found.some((f) => f.product_type !== 'goods')) throw badRequest('Components and by-products must be goods; put services in the routing');
  if (ids.includes(input.productId)) throw badRequest('A product cannot be its own component');
  const comps = input.lines.filter((l) => (l.kind ?? 'component') === 'component').map((l) => l.productId);
  if (await reaches(ctx.tx, ctx.tenantId, comps, input.productId)) throw badRequest('A component is made from this product: that would be a loop');
  const seqs = input.operations.map((o) => o.seq);
  if (new Set(seqs).size !== seqs.length) throw badRequest('Operation numbers must be unique');
  for (const l of input.lines) if (l.operationSeq != null && !seqs.includes(l.operationSeq)) throw badRequest('A line refers to an operation that is not in the routing');
  const share = input.lines.filter((l) => l.kind === 'byproduct').reduce((s, l) => s + (l.costSharePct ?? 0), 0);
  if (share >= 100) throw badRequest('By-products cannot take all of the cost');
  const wcs = [...new Set(input.operations.map((o) => o.workCenterId).filter((x): x is string => !!x))];
  if (wcs.length) {
    const w = await ctx.tx.query(`select id from work_centers where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, wcs]);
    if (w.length !== wcs.length) throw badRequest('Work centre not found');
  }
}

async function writeBomParts(ctx: RecordCtx, bomId: string, input: BomInput) {
  await ctx.tx.query(`delete from bom_lines where tenant_id = $1 and bom_id = $2`, [ctx.tenantId, bomId]);
  await ctx.tx.query(`delete from bom_operations where tenant_id = $1 and bom_id = $2`, [ctx.tenantId, bomId]);
  for (const o of input.operations)
    await ctx.tx.query(
      `insert into bom_operations (tenant_id, bom_id, seq, name, work_center_id, setup_minutes, run_minutes, subcontract, instructions) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, bomId, o.seq, o.name, o.workCenterId ?? null, o.setupMinutes ?? 0, o.runMinutes ?? 0, !!o.subcontract, o.instructions ?? null],
    );
  let pos = 0;
  for (const l of input.lines)
    await ctx.tx.query(
      `insert into bom_lines (tenant_id, bom_id, line_kind, product_id, quantity, scrap_pct, cost_share_pct, operation_seq, position) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ctx.tenantId, bomId, l.kind ?? 'component', l.productId, l.quantity, l.scrapPct ?? 0, l.kind === 'byproduct' ? l.costSharePct ?? 0 : 0, l.operationSeq ?? null, pos++],
    );
}

/** Creates a BOM (draft), or replaces a draft's contents. An active BOM is changed by saving a new version. */
export async function saveBom(ctx: RecordCtx, id: string | null, input: BomInput) {
  assertMfgAdmin(ctx);
  await checkBom(ctx, input);
  if (id) {
    const cur = await ctx.tx.one<{ status: string; product_id: string }>(`select status, product_id from boms where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
    if (!cur) throw notFound('Bill of materials not found');
    if (cur.status !== 'draft') throw badRequest('Active bills of materials are not edited; save a new version instead');
    if (cur.product_id !== input.productId) throw badRequest('The product of a bill of materials cannot change');
    await ctx.tx.query(`update boms set name = $3, kind = $4, quantity = $5, yield_pct = $6, requires_qc = $7, notes = $8 where tenant_id = $1 and id = $2`, [
      ctx.tenantId, id, input.name, input.kind ?? 'manufacture', input.quantity, input.yieldPct ?? 100, !!input.requiresQc, input.notes ?? null,
    ]);
    await writeBomParts(ctx, id, input);
    return { id };
  }
  const v = await ctx.tx.one<{ v: number }>(`select coalesce(max(revision), 0) + 1 as v from boms where tenant_id = $1 and product_id = $2`, [ctx.tenantId, input.productId]);
  const b = await ctx.tx.one<{ id: string }>(
    `insert into boms (tenant_id, product_id, name, revision, kind, quantity, yield_pct, requires_qc, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
    [ctx.tenantId, input.productId, input.name, v!.v, input.kind ?? 'manufacture', input.quantity, input.yieldPct ?? 100, !!input.requiresQc, input.notes ?? null],
  );
  await writeBomParts(ctx, b!.id, input);
  return { id: b!.id, version: v!.v };
}

export async function setBomStatus(ctx: RecordCtx, id: string, action: 'activate' | 'archive' | 'make_default') {
  assertMfgAdmin(ctx);
  const b = await ctx.tx.one<{ status: string; product_id: string }>(`select status, product_id from boms where tenant_id = $1 and id = $2 for update`, [ctx.tenantId, id]);
  if (!b) throw notFound('Bill of materials not found');
  if (action === 'archive') {
    await ctx.tx.query(`update boms set status = 'archived', is_default = false where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    return;
  }
  if (b.status === 'archived') throw badRequest('Archived bills of materials stay archived; copy it as a new version');
  const comps = await ctx.tx.query<{ product_id: string }>(`select product_id from bom_lines where tenant_id = $1 and bom_id = $2 and line_kind = 'component'`, [ctx.tenantId, id]);
  if (await reaches(ctx.tx, ctx.tenantId, comps.map((c) => c.product_id), b.product_id)) throw badRequest('A component is made from this product: that would be a loop');
  const hasDefault = await ctx.tx.one(`select 1 from boms where tenant_id = $1 and product_id = $2 and is_default and status = 'active' and id <> $3`, [ctx.tenantId, b.product_id, id]);
  if (action === 'make_default' || !hasDefault) await ctx.tx.query(`update boms set is_default = false where tenant_id = $1 and product_id = $2 and id <> $3`, [ctx.tenantId, b.product_id, id]);
  await ctx.tx.query(`update boms set status = 'active', is_default = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, action === 'make_default' || !hasDefault]);
  await ctx.tx.query(`update products set make_or_buy = case when make_or_buy = 'buy' then 'make' else make_or_buy end where tenant_id = $1 and id = $2`, [ctx.tenantId, b.product_id]);
}

export async function copyBom(ctx: RecordCtx, id: string) {
  const b = await getBom(ctx, id);
  return saveBom(ctx, null, {
    productId: b.product_id,
    name: b.name,
    kind: b.kind,
    quantity: b.quantity,
    yieldPct: b.yield_pct,
    requiresQc: b.requires_qc,
    notes: b.notes,
    lines: (b.lines as any[]).map((l) => ({ kind: l.line_kind, productId: l.product_id, quantity: l.quantity, scrapPct: l.scrap_pct, costSharePct: l.cost_share_pct, operationSeq: l.operation_seq })),
    operations: (b.operations as any[]).map((o) => ({ seq: o.seq, name: o.name, workCenterId: o.work_center_id, setupMinutes: o.setup_minutes, runMinutes: o.run_minutes, subcontract: o.subcontract, instructions: o.instructions })),
  });
}

/**
 * Standard cost per unit of a BOM's product: components at their rolled-up cost (their own default
 * BOM when they are made, else moving-average / purchase cost), plus routing time at work-centre
 * rates, less the by-products' share; divided by output and yield.
 */
type BomCost = { material: number; operations: number; perUnit: number; batch: number };
/** memo: one costing per BOM per call; also caps the work for a deep or wide structure */
export async function bomCost(tx: Tx, tenantId: string, bomId: string, depth = 0, memo: Map<string, BomCost> = new Map()): Promise<BomCost> {
  const known = memo.get(bomId);
  if (known) return known;
  if (depth > 12 || memo.size > 2000) return { material: 0, operations: 0, perUnit: 0, batch: 0 };
  const res = await bomCostOnce(tx, tenantId, bomId, depth, memo);
  memo.set(bomId, res);
  return res;
}

async function bomCostOnce(tx: Tx, tenantId: string, bomId: string, depth: number, memo: Map<string, BomCost>): Promise<BomCost> {
  const b = await tx.one<{ quantity: string; yield_pct: string }>(`select quantity, yield_pct from boms where tenant_id = $1 and id = $2`, [tenantId, bomId]);
  if (!b) return { material: 0, operations: 0, perUnit: 0, batch: 0 };
  const qty = Number(b.quantity);
  const lines = await tx.query<{ line_kind: string; product_id: string; quantity: string; scrap_pct: string; cost_share_pct: string; make: boolean; sub_bom: string | null }>(
    `select l.line_kind, l.product_id, l.quantity, l.scrap_pct, l.cost_share_pct, p.make_or_buy <> 'buy' as make,
            (select id from boms c where c.tenant_id = l.tenant_id and c.product_id = l.product_id and c.status = 'active' and c.is_default limit 1) as sub_bom
       from bom_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.bom_id = $2`,
    [tenantId, bomId],
  );
  let material = 0;
  let share = 0;
  for (const l of lines) {
    if (l.line_kind === 'byproduct') {
      share += Number(l.cost_share_pct);
      continue;
    }
    const unit = l.make && l.sub_bom ? (await bomCost(tx, tenantId, l.sub_bom, depth + 1, memo)).perUnit : await unitCostOf(tx, tenantId, l.product_id);
    material += (Number(l.quantity) * unit) / (1 - Number(l.scrap_pct) / 100);
  }
  const ops = await tx.one<{ v: string }>(
    `select coalesce(sum((o.setup_minutes + o.run_minutes * $3::numeric) / 60.0 * coalesce(w.cost_per_hour, 0)), 0) as v
       from bom_operations o left join work_centers w on w.tenant_id = o.tenant_id and w.id = o.work_center_id where o.tenant_id = $1 and o.bom_id = $2`,
    [tenantId, bomId, qty],
  );
  const operations = Number(ops!.v);
  const batch = (material + operations) * (1 - share / 100);
  const perUnit = batch / (qty * (Number(b.yield_pct) / 100));
  return { material: r2(material), operations: r2(operations), batch: r2(batch), perUnit: Math.round(perUnit * 10000) / 10000 };
}

/** Everything needed for qty of a product, exploded through made components (for planning screens). */
export async function explode(ctx: RecordCtx, bomId: string, qty: number) {
  assertMfgRead(ctx);
  const out = new Map<string, { productId: string; product: string; qty: number; level: number; make: boolean }>();
  let nodes = 0;
  const walk = async (id: string, mult: number, level: number) => {
    if (level > 12 || ++nodes > 1000) return;
    const b = await ctx.tx.one<{ quantity: string; yield_pct: string }>(`select quantity, yield_pct from boms where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    if (!b) return;
    const rows = await ctx.tx.query<{ product_id: string; name: string; quantity: string; scrap_pct: string; sub_bom: string | null; make: boolean }>(
      `select l.product_id, p.name, l.quantity, l.scrap_pct, p.make_or_buy <> 'buy' as make,
              (select id from boms c where c.tenant_id = l.tenant_id and c.product_id = l.product_id and c.status = 'active' and c.is_default limit 1) as sub_bom
         from bom_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.bom_id = $2 and l.line_kind = 'component'`,
      [ctx.tenantId, id],
    );
    for (const r of rows) {
      const need = (Number(r.quantity) / Number(b.quantity)) * (mult / (Number(b.yield_pct) / 100)) / (1 - Number(r.scrap_pct) / 100);
      const k = `${r.product_id}`;
      const e = out.get(k) ?? { productId: r.product_id, product: r.name, qty: 0, level, make: r.make && !!r.sub_bom };
      e.qty = n3(e.qty + need);
      e.level = Math.max(e.level, level);
      out.set(k, e);
      if (r.make && r.sub_bom) await walk(r.sub_bom, need, level + 1);
    }
  };
  await walk(bomId, qty, 1);
  return [...out.values()].sort((a, b) => a.level - b.level || a.product.localeCompare(b.product));
}

export async function whereUsed(ctx: RecordCtx, productId: string) {
  assertMfgRead(ctx);
  return ctx.tx.query(
    `select b.id, b.name, b.revision as version, b.status, p.name as product, l.quantity::float8 as quantity, l.line_kind from bom_lines l join boms b on b.tenant_id = l.tenant_id and b.id = l.bom_id
       join products p on p.tenant_id = b.tenant_id and p.id = b.product_id where l.tenant_id = $1 and l.product_id = $2 order by p.name, b.revision desc limit 500`,
    [ctx.tenantId, productId],
  );
}

/* ───────────────────────── work orders ───────────────────────── */

async function wo(ctx: RecordCtx, id: string, action: 'read' | 'update' = 'update') {
  const { row } = await loadRow(ctx, 'work_order', id, action, action === 'update');
  return row as Record<string, any>;
}

export async function getWorkOrder(ctx: RecordCtx, id: string) {
  const w = await wo(ctx, id, 'read');
  const materials = await ctx.tx.query(
    `select m.id, m.product_id, p.name as product, p.sku, p.unit, p.batch_tracked, m.required_qty::float8 as required_qty, m.issued_qty::float8 as issued_qty, m.issued_value::float8 as issued_value, m.operation_seq,
            coalesce((select on_hand - reserved from stock_levels s where s.tenant_id = m.tenant_id and s.product_id = m.product_id and s.warehouse_id = $3), 0)::float8 as available
       from work_order_materials m join products p on p.tenant_id = m.tenant_id and p.id = m.product_id where m.tenant_id = $1 and m.work_order_id = $2 order by m.position`,
    [ctx.tenantId, id, w.warehouse_id],
  );
  const operations = await ctx.tx.query(
    `select o.id, o.seq, o.name, o.work_center_id, c.name as work_center, o.planned_minutes::float8 as planned_minutes, o.actual_minutes::float8 as actual_minutes, o.cost_per_hour::float8 as cost_per_hour,
            o.absorbed_cost::float8 as absorbed_cost, o.qty_done::float8 as qty_done, o.status, o.operator_id, u.full_name as operator, o.started_at, o.completed_at, o.subcontract
       from work_order_operations o left join work_centers c on c.tenant_id = o.tenant_id and c.id = o.work_center_id left join users u on u.tenant_id = o.tenant_id and u.id = o.operator_id
      where o.tenant_id = $1 and o.work_order_id = $2 order by o.seq`,
    [ctx.tenantId, id],
  );
  const logs = await ctx.tx.query(
    `select g.id, g.kind, g.product_id, p.name as product, g.quantity::float8 as quantity, g.value::float8 as value, g.lot_id, l.lot_number, g.minutes::float8 as minutes, g.note, g.created_at, u.full_name as by
       from production_logs g left join products p on p.tenant_id = g.tenant_id and p.id = g.product_id left join stock_lots l on l.tenant_id = g.tenant_id and l.id = g.lot_id
       left join users u on u.tenant_id = g.tenant_id and u.id = g.created_by where g.tenant_id = $1 and g.work_order_id = $2 order by g.created_at desc limit 500`,
    [ctx.tenantId, id],
  );
  const qc = await ctx.tx.query(`select id, qc_number, stage, result, qty_inspected::float8 as qty_inspected, qty_rejected::float8 as qty_rejected, created_at from quality_checks where tenant_id = $1 and work_order_id = $2 order by created_at desc`, [ctx.tenantId, id]);
  const product = w.product_id ? await ctx.tx.one(`select id, name, sku, unit, batch_tracked, shelf_life_days from products where tenant_id = $1 and id = $2`, [ctx.tenantId, w.product_id]) : null;
  const bom = w.bom_id ? await ctx.tx.one(`select id, name, revision as version, kind, requires_qc, quantity::float8 as quantity from boms where tenant_id = $1 and id = $2`, [ctx.tenantId, w.bom_id]) : null;
  const cost = canSeeCost(ctx);
  if (!cost) {
    for (const m of materials as Record<string, unknown>[]) m.issued_value = null;
    for (const o of operations as Record<string, unknown>[]) o.cost_per_hour = o.absorbed_cost = null;
    for (const g of logs as Record<string, unknown>[]) g.value = null;
  }
  const standard = cost && w.bom_id ? await bomCost(ctx.tx, ctx.tenantId, w.bom_id) : null;
  const wip = r2(Number(w.material_cost) + Number(w.operation_cost) - Number(w.relieved_cost));
  return {
    workOrder: { id: w.id, wo_number: w.wo_number, name: w.name, status: w.status, quantity: Number(w.quantity), produced_qty: Number(w.produced_qty), scrapped_qty: Number(w.scrapped_qty), warehouse_id: w.warehouse_id, lot_number: w.lot_number, planned_start: w.planned_start, planned_end: w.planned_end },
    product,
    bom,
    materials,
    operations,
    logs,
    qc,
    costs: !cost ? null : { material: Number(w.material_cost), operations: Number(w.operation_cost), relieved: Number(w.relieved_cost), wip, variance: Number(w.variance), standardPerUnit: standard?.perUnit ?? null, actualPerUnit: Number(w.produced_qty) ? r2(Number(w.relieved_cost) / Number(w.produced_qty)) : null },
  };
}

/** Builds the order's materials and routing from its BOM (draft only) and releases it to the floor. */
export async function releaseWorkOrder(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  assertPlanner(ctx);
  const w = await wo(ctx, id);
  if (w.status !== 'draft') throw badRequest('Only draft work orders are released');
  let bomId = w.bom_id as string | null;
  if (!bomId) bomId = (await ctx.tx.one<{ id: string }>(`select id from boms where tenant_id = $1 and product_id = $2 and status = 'active' order by is_default desc, revision desc limit 1`, [ctx.tenantId, w.product_id]))?.id ?? null;
  if (!bomId) throw badRequest('This product has no active bill of materials');
  let b = await ctx.tx.one<{ quantity: string; yield_pct: string; status: string; product_id: string }>(`select quantity, yield_pct, status, product_id from boms where tenant_id = $1 and id = $2`, [ctx.tenantId, bomId]);
  if (b && b.product_id !== w.product_id) {
    // the product changed while in draft: fall back to the new product's default
    bomId = (await ctx.tx.one<{ id: string }>(`select id from boms where tenant_id = $1 and product_id = $2 and status = 'active' order by is_default desc, revision desc limit 1`, [ctx.tenantId, w.product_id]))?.id ?? null;
    b = bomId ? await ctx.tx.one<{ quantity: string; yield_pct: string; status: string; product_id: string }>(`select quantity, yield_pct, status, product_id from boms where tenant_id = $1 and id = $2`, [ctx.tenantId, bomId]) : null;
  }
  if (!bomId || !b || b.status !== 'active' || b.product_id !== w.product_id) throw badRequest('Choose an active bill of materials for this product');
  const qty = Number(w.quantity);
  const factor = qty / Number(b.quantity) / (Number(b.yield_pct) / 100);
  await ctx.tx.query(`delete from work_order_materials where tenant_id = $1 and work_order_id = $2`, [ctx.tenantId, id]);
  await ctx.tx.query(`delete from work_order_operations where tenant_id = $1 and work_order_id = $2`, [ctx.tenantId, id]);
  const lines = await ctx.tx.query<{ product_id: string; quantity: string; scrap_pct: string; operation_seq: number | null; position: number }>(
    `select product_id, sum(quantity) as quantity, max(scrap_pct) as scrap_pct, min(operation_seq) as operation_seq, min(position) as position from bom_lines where tenant_id = $1 and bom_id = $2 and line_kind = 'component' group by product_id`,
    [ctx.tenantId, bomId],
  );
  for (const l of lines)
    await ctx.tx.query(`insert into work_order_materials (tenant_id, work_order_id, product_id, required_qty, operation_seq, position) values ($1,$2,$3,$4,$5,$6)`, [
      ctx.tenantId, id, l.product_id, n3((Number(l.quantity) * factor) / (1 - Number(l.scrap_pct) / 100)), l.operation_seq, l.position,
    ]);
  await ctx.tx.query(
    `insert into work_order_operations (tenant_id, work_order_id, seq, name, work_center_id, planned_minutes, cost_per_hour, subcontract)
     select $1, $2, o.seq, o.name, o.work_center_id, round(o.setup_minutes + o.run_minutes * $4::numeric, 2), coalesce(w.cost_per_hour, 0), o.subcontract
       from bom_operations o left join work_centers w on w.tenant_id = o.tenant_id and w.id = o.work_center_id where o.tenant_id = $1 and o.bom_id = $3`,
    [ctx.tenantId, id, bomId, qty],
  );
  const wh = (w.warehouse_id as string | null) ?? (await defaultWarehouse(ctx));
  await ctx.tx.query(`update work_orders set status = 'released', bom_id = $3, warehouse_id = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, bomId, wh]);
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated', changes: { status: ['draft', 'released'] } }];
}

async function log(ctx: RecordCtx, w: Record<string, any>, kind: string, fields: { productId?: string | null; quantity?: number; value?: number; lotId?: string | null; operationId?: string | null; minutes?: number | null; note?: string | null }) {
  const r = await ctx.tx.one<{ id: string }>(
    `insert into production_logs (tenant_id, work_order_id, kind, product_id, quantity, value, lot_id, operation_id, minutes, note) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
    [ctx.tenantId, w.id, kind, fields.productId ?? null, fields.quantity ?? 0, r2(fields.value ?? 0), fields.lotId ?? null, fields.operationId ?? null, fields.minutes ?? null, fields.note?.slice(0, 500) ?? null],
  );
  return r!.id;
}

function open(w: Record<string, any>) {
  if (!['released', 'in_progress', 'completed'].includes(w.status)) throw badRequest(w.status === 'draft' ? 'Release the work order first' : `The work order is ${w.status}`);
}

/** Issues material to the order (from its warehouse; batch-tracked items first-expiry-first-out or a chosen lot). */
export async function issueMaterials(ctx: RecordCtx, id: string, items: { productId: string; qty: number; lotId?: string | null }[] | 'remaining'): Promise<RecordEvent[]> {
  const w = await wo(ctx, id);
  open(w);
  if (w.status === 'completed') throw badRequest('The order is completed; close it or record output before issuing more');
  const mats = await ctx.tx.query<{ id: string; product_id: string; required_qty: string; issued_qty: string }>(`select id, product_id, required_qty, issued_qty from work_order_materials where tenant_id = $1 and work_order_id = $2 for update`, [ctx.tenantId, id]);
  const plan = items === 'remaining' ? mats.map((m) => ({ productId: m.product_id, qty: n3(Number(m.required_qty) - Number(m.issued_qty)), lotId: null })).filter((x) => x.qty > 0) : items;
  if (!plan.length) throw badRequest('Nothing to issue');
  let total = 0;
  let lastLog = '';
  const label = `${w.wo_number ?? 'WO'} · ${w.name}`;
  for (const it of plan) {
    if (!(it.qty > 0)) throw badRequest('Quantities must be positive');
    let m = mats.find((x) => x.product_id === it.productId);
    if (!m) {
      const p = await ctx.tx.one<{ product_type: string }>(`select product_type from products where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, it.productId]);
      if (!p || p.product_type !== 'goods') throw badRequest('Only goods can be issued');
      m = (await ctx.tx.one<{ id: string; product_id: string; required_qty: string; issued_qty: string }>(
        `insert into work_order_materials (tenant_id, work_order_id, product_id, required_qty, position) values ($1,$2,$3,0,999) returning id, product_id, required_qty, issued_qty`,
        [ctx.tenantId, id, it.productId],
      ))!;
      mats.push(m);
    }
    if (n3(Number(m.issued_qty) + it.qty) > Math.max(3 * Number(m.required_qty), Number(m.required_qty) + 1000) && Number(m.required_qty) > 0) throw badRequest('That is far more than the order needs');
    const unit = await unitCostOf(ctx.tx, ctx.tenantId, it.productId);
    const value = r2(unit * it.qty);
    // stock reserved for confirmed sales orders is not taken for production
    const lvl = await ctx.tx.one<{ on_hand: string; reserved: string }>(`select on_hand, reserved from stock_levels where tenant_id = $1 and product_id = $2 and warehouse_id = $3`, [ctx.tenantId, it.productId, w.warehouse_id]);
    if (lvl && Number(lvl.reserved) > 0 && n3(Number(lvl.on_hand) - Number(lvl.reserved)) < it.qty) throw badRequest(`Only ${n3(Number(lvl.on_hand) - Number(lvl.reserved))} is free: the rest is reserved for sales orders`);
    const lots = await consumeLots(ctx, it.productId, w.warehouse_id, it.qty, it.lotId);
    await moveStock(ctx, { productId: it.productId, warehouseId: w.warehouse_id, type: 'out', qty: -it.qty, unitCost: unit, reason: 'Issued to production', ref: { object: 'work_order', id, label } });
    await ctx.tx.query(`update work_order_materials set issued_qty = issued_qty + $3, issued_value = issued_value + $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, m.id, it.qty, value]);
    m.issued_qty = String(n3(Number(m.issued_qty) + it.qty));
    for (const l of lots) lastLog = await log(ctx, w, 'issue', { productId: it.productId, quantity: l.qty, value: r2((value * l.qty) / it.qty), lotId: l.lotId });
    const rest = n3(it.qty - lots.reduce((s, l) => s + l.qty, 0));
    if (rest > 0 || !lots.length) lastLog = await log(ctx, w, 'issue', { productId: it.productId, quantity: rest || it.qty, value: lots.length ? r2((value * rest) / it.qty) : value });
    total = r2(total + value);
  }
  await ctx.tx.query(`update work_orders set material_cost = material_cost + $3, status = 'in_progress', actual_start = coalesce(actual_start, now()) where tenant_id = $1 and id = $2`, [ctx.tenantId, id, total]);
  await post(ctx, 'work_order', lastLog, today(), w.wo_number ?? '', `Material issued to ${label}`, [
    { accountId: await sys(ctx.tx, ctx.tenantId, 'wip'), debit: total },
    { accountId: await sys(ctx.tx, ctx.tenantId, 'inventory'), credit: total },
  ]);
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated' }];
}

/** Returns unused material from the order to stock, at the order's average issue cost. */
export async function returnMaterials(ctx: RecordCtx, id: string, items: { productId: string; qty: number }[]): Promise<RecordEvent[]> {
  const w = await wo(ctx, id);
  open(w);
  let total = 0;
  const label = `${w.wo_number ?? 'WO'} · ${w.name}`;
  let lastLog = '';
  for (const it of items) {
    const m = await ctx.tx.one<{ id: string; issued_qty: string; issued_value: string }>(`select id, issued_qty, issued_value from work_order_materials where tenant_id = $1 and work_order_id = $2 and product_id = $3 for update`, [ctx.tenantId, id, it.productId]);
    if (!m || !(it.qty > 0) || it.qty > Number(m.issued_qty) + 1e-9) throw badRequest('You can return at most what was issued');
    const unit = Number(m.issued_value) / Number(m.issued_qty);
    const value = r2(unit * it.qty);
    await moveStock(ctx, { productId: it.productId, warehouseId: w.warehouse_id, type: 'in', qty: it.qty, unitCost: unit, reason: 'Returned from production', ref: { object: 'work_order', id, label } });
    await ctx.tx.query(`update work_order_materials set issued_qty = issued_qty - $3, issued_value = issued_value - $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, m.id, it.qty, value]);
    lastLog = await log(ctx, w, 'return', { productId: it.productId, quantity: it.qty, value });
    total = r2(total + value);
  }
  if (!lastLog) throw badRequest('Nothing to return');
  await ctx.tx.query(`update work_orders set material_cost = material_cost - $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, total]);
  await post(ctx, 'work_order', lastLog, today(), w.wo_number ?? '', `Material returned from ${label}`, [
    { accountId: await sys(ctx.tx, ctx.tenantId, 'inventory'), debit: total },
    { accountId: await sys(ctx.tx, ctx.tenantId, 'wip'), credit: total },
  ]);
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated' }];
}

/** Records time on an operation (absorbing labour and overhead at the work centre's rate) and its progress. */
export async function recordOperation(ctx: RecordCtx, id: string, opId: string, input: { minutes?: number; qtyDone?: number; status?: 'in_progress' | 'done'; operatorId?: string | null }): Promise<RecordEvent[]> {
  const w = await wo(ctx, id);
  open(w);
  const o = await ctx.tx.one<{ id: string; name: string; cost_per_hour: string; status: string; started_at: string | null }>(`select id, name, cost_per_hour, status, started_at from work_order_operations where tenant_id = $1 and id = $2 and work_order_id = $3 for update`, [ctx.tenantId, opId, id]);
  if (!o) throw notFound('Operation not found');
  if (input.operatorId && !(await ctx.tx.one(`select 1 from users where tenant_id = $1 and id = $2 and status = 'active'`, [ctx.tenantId, input.operatorId]))) throw badRequest('Operator not found');
  const minutes = input.minutes ?? 0;
  if (minutes < 0 || minutes > 100000) throw badRequest('Invalid minutes');
  const value = r2((minutes / 60) * Number(o.cost_per_hour));
  await ctx.tx.query(
    `update work_order_operations set actual_minutes = actual_minutes + $3, absorbed_cost = absorbed_cost + $4, qty_done = greatest(qty_done, coalesce($5, qty_done)),
            status = coalesce($6, case when status = 'pending' then 'in_progress' else status end), operator_id = coalesce($7, operator_id),
            started_at = coalesce(started_at, now()), completed_at = case when coalesce($6, status) = 'done' then now() else null end
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, opId, minutes, value, input.qtyDone ?? null, input.status ?? null, input.operatorId ?? null],
  );
  if (minutes || input.status) {
    const lid = await log(ctx, w, 'operation', { operationId: opId, minutes, value, quantity: input.qtyDone ?? 0, note: `${o.name}${input.status === 'done' ? ' (done)' : ''}` });
    if (value) {
      await ctx.tx.query(`update work_orders set operation_cost = operation_cost + $3, status = case when status = 'released' then 'in_progress' else status end, actual_start = coalesce(actual_start, now()) where tenant_id = $1 and id = $2`, [ctx.tenantId, id, value]);
      await post(ctx, 'work_order', lid, today(), w.wo_number ?? '', `${o.name} on ${w.wo_number ?? w.name}: ${minutes} min`, [
        { accountId: await sys(ctx.tx, ctx.tenantId, 'wip'), debit: value },
        { accountId: await sys(ctx.tx, ctx.tenantId, 'overhead_absorbed'), credit: value },
      ]);
    }
  }
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated' }];
}

/**
 * Records output (and optional scrap). WIP is relieved in proportion to the quantity finished, all
 * of it when the order completes; by-products take their BOM cost share; scrap goes to the scrap
 * account. Batch-tracked products get a lot (with expiry from shelf life) linked to the lots consumed.
 */
export async function produce(ctx: RecordCtx, id: string, input: { qty: number; scrapQty?: number; lotNumber?: string | null; expiryDate?: string | null; note?: string | null }): Promise<RecordEvent[]> {
  const w = await wo(ctx, id);
  open(w);
  const qty = n3(input.qty);
  const scrap = n3(input.scrapQty ?? 0);
  if (qty < 0 || scrap < 0 || qty + scrap <= 0) throw badRequest('Enter the quantity made (and any scrap)');
  const remaining = n3(Number(w.quantity) - Number(w.produced_qty) - Number(w.scrapped_qty));
  if (qty + scrap > remaining + 1e-9 && qty + scrap > Number(w.quantity) * 0.1 + remaining) throw badRequest(`Only ${remaining} remain on this order (up to 10% over is allowed)`);
  const bom = w.bom_id ? await ctx.tx.one<{ requires_qc: boolean; quantity: string }>(`select requires_qc, quantity from boms where tenant_id = $1 and id = $2`, [ctx.tenantId, w.bom_id]) : null;
  if (bom?.requires_qc && qty > 0) {
    const passed = await ctx.tx.one<{ v: string }>(`select coalesce(sum(qty_inspected - qty_rejected), 0) as v from quality_checks where tenant_id = $1 and work_order_id = $2 and stage = 'final' and result = 'pass'`, [ctx.tenantId, id]);
    if (Number(passed!.v) + 1e-9 < Number(w.produced_qty) + qty) throw badRequest(`Final inspection has passed ${Number(passed!.v)}; record a passing final quality check for this output first`);
  }
  if (qty > 0 && Number(w.material_cost) <= 0) {
    const needs = await ctx.tx.one(`select 1 from work_order_materials where tenant_id = $1 and work_order_id = $2 and required_qty > 0 limit 1`, [ctx.tenantId, id]);
    if (needs) throw badRequest('Issue the material before recording output (output with no material would come into stock at no cost)');
  }
  const balance = r2(Number(w.material_cost) + Number(w.operation_cost) - Number(w.relieved_cost));
  const completes = qty + scrap >= remaining - 1e-9;
  const relief = completes ? balance : r2((balance * (qty + scrap)) / Math.max(remaining, 1e-9));
  const scrapValue = qty + scrap ? r2((relief * scrap) / (qty + scrap)) : 0;
  let goodValue = r2(relief - scrapValue);
  const label = `${w.wo_number ?? 'WO'} · ${w.name}`;
  const lines: JLine[] = [];
  const inv = await sys(ctx.tx, ctx.tenantId, 'inventory');
  // by-products
  const byp = w.bom_id && qty > 0
    ? await ctx.tx.query<{ product_id: string; quantity: string; cost_share_pct: string }>(`select product_id, quantity, cost_share_pct from bom_lines where tenant_id = $1 and bom_id = $2 and line_kind = 'byproduct'`, [ctx.tenantId, w.bom_id])
    : [];
  const fgValue0 = goodValue;
  for (const b of byp) {
    const bq = n3((Number(b.quantity) / Number(bom!.quantity)) * qty);
    if (!(bq > 0)) continue;
    const bv = r2((fgValue0 * Number(b.cost_share_pct)) / 100);
    goodValue = r2(goodValue - bv);
    await averageIn(ctx.tx, ctx.tenantId, b.product_id, bq, bv / bq);
    await moveStock(ctx, { productId: b.product_id, warehouseId: w.warehouse_id, type: 'in', qty: bq, unitCost: r2(bv / bq), reason: 'By-product', ref: { object: 'work_order', id, label } });
    const lid = await log(ctx, w, 'byproduct', { productId: b.product_id, quantity: bq, value: bv });
    void lid;
    if (bv) lines.push({ accountId: inv, debit: bv, description: 'By-product' });
  }
  let lotId: string | null = null;
  if (qty > 0) {
    const unit = goodValue / qty;
    await averageIn(ctx.tx, ctx.tenantId, w.product_id, qty, unit);
    await moveStock(ctx, { productId: w.product_id, warehouseId: w.warehouse_id, type: 'in', qty, unitCost: r2(unit), reason: 'Produced', ref: { object: 'work_order', id, label } });
    const p = await ctx.tx.one<{ batch_tracked: boolean; shelf_life_days: number | null }>(`select batch_tracked, shelf_life_days from products where tenant_id = $1 and id = $2`, [ctx.tenantId, w.product_id]);
    if (p?.batch_tracked || input.lotNumber || w.lot_number) {
      const lotNumber = (input.lotNumber || w.lot_number || `${w.wo_number ?? 'WO'}-${today().replace(/-/g, '').slice(2)}`).slice(0, 60);
      const expiry = input.expiryDate ?? (p?.shelf_life_days ? addDays(today(), p.shelf_life_days) : null);
      lotId = await addToLot(ctx, { productId: w.product_id, warehouseId: w.warehouse_id, lotNumber, qty, expiryDate: expiry, source: 'production', sourceId: id });
      if (!p?.batch_tracked) await ctx.tx.query(`update products set batch_tracked = true where tenant_id = $1 and id = $2`, [ctx.tenantId, w.product_id]);
      // genealogy: every lot consumed by this order went into this lot
      await ctx.tx.query(
        `insert into lot_links (tenant_id, parent_lot_id, child_lot_id, work_order_id, quantity)
         select $1, g.lot_id, $3, $2, sum(g.quantity) from production_logs g where g.tenant_id = $1 and g.work_order_id = $2 and g.kind = 'issue' and g.lot_id is not null group by g.lot_id
         on conflict (tenant_id, parent_lot_id, child_lot_id) do update set quantity = excluded.quantity`,
        [ctx.tenantId, id, lotId],
      );
    }
    lines.push({ accountId: inv, debit: goodValue, description: 'Finished goods' });
    if (w.sales_order_id) await reserveForOrder(ctx, String(w.sales_order_id), w.product_id, w.warehouse_id, qty, label);
  }
  const pid = await log(ctx, w, qty > 0 ? 'produce' : 'scrap', { productId: w.product_id, quantity: qty > 0 ? qty : scrap, value: qty > 0 ? goodValue : scrapValue, lotId, note: input.note ?? null });
  if (qty > 0 && scrap > 0) await log(ctx, w, 'scrap', { productId: w.product_id, quantity: scrap, value: scrapValue });
  if (scrapValue) lines.push({ accountId: await sys(ctx.tx, ctx.tenantId, 'scrap'), debit: scrapValue, description: 'Scrap' });
  lines.push({ accountId: await sys(ctx.tx, ctx.tenantId, 'wip'), credit: relief });
  const producedAfter = n3(Number(w.produced_qty) + qty);
  const scrappedAfter = n3(Number(w.scrapped_qty) + scrap);
  const done = producedAfter + scrappedAfter >= Number(w.quantity) - 1e-9;
  await ctx.tx.query(
    `update work_orders set produced_qty = $3, scrapped_qty = $4, relieved_cost = relieved_cost + $5, status = case when $6 then 'completed' else 'in_progress' end,
            actual_start = coalesce(actual_start, now()), actual_end = case when $6 then now() else actual_end end
      where tenant_id = $1 and id = $2`,
    [ctx.tenantId, id, producedAfter, scrappedAfter, relief, done],
  );
  if (relief) await post(ctx, 'work_order', pid, today(), w.wo_number ?? '', `Output of ${label}: ${qty}${scrap ? ` (+${scrap} scrap)` : ''}`, lines);
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated', changes: { produced_qty: [Number(w.produced_qty), producedAfter] } }];
}

/** Make-to-order: output is reserved for the sales order it was made for (as much as that order still needs). */
async function reserveForOrder(ctx: RecordCtx, orderId: string, productId: string, warehouseId: string, qty: number, label: string) {
  const l = await ctx.tx.one<{ id: string; open: string }>(
    `select l.id, l.quantity - l.shipped_qty - l.reserved_qty as open from sales_order_lines l join sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
      where l.tenant_id = $1 and l.order_id = $2 and l.product_id = $3 and o.warehouse_id = $4 and o.status in ('confirmed','in_production','ready') and o.deleted_at is null
        and l.quantity - l.shipped_qty - l.reserved_qty > 0 order by l.position limit 1 for update of l`,
    [ctx.tenantId, orderId, productId, warehouseId],
  );
  if (!l) return;
  const q = n3(Math.min(qty, Number(l.open)));
  await moveStock(ctx, { productId, warehouseId, type: 'reserve', reserved: q, reason: 'Made for this order', ref: { object: 'sales_order', id: orderId, label } });
  await ctx.tx.query(`update sales_order_lines set reserved_qty = reserved_qty + $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, q]);
}

/** Closes a completed order: whatever is left in WIP is booked as a production variance. */
export async function closeWorkOrder(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  assertPlanner(ctx);
  const w = await wo(ctx, id);
  if (!['completed', 'in_progress'].includes(w.status)) throw badRequest('Only completed or in-progress orders can be closed');
  if (w.status === 'in_progress' && Number(w.produced_qty) === 0) throw badRequest('Nothing was produced; return the material and cancel the order instead');
  const balance = r2(Number(w.material_cost) + Number(w.operation_cost) - Number(w.relieved_cost));
  const lid = await log(ctx, w, 'close', { value: balance, note: balance ? 'Production variance' : null });
  await ctx.tx.query(`update work_orders set status = 'closed', variance = $3, relieved_cost = relieved_cost + $3, actual_end = coalesce(actual_end, now()) where tenant_id = $1 and id = $2`, [ctx.tenantId, id, balance]);
  await ctx.tx.query(`update work_order_operations set status = 'done', completed_at = coalesce(completed_at, now()) where tenant_id = $1 and work_order_id = $2 and status <> 'done'`, [ctx.tenantId, id]);
  if (balance) {
    const adj = await sys(ctx.tx, ctx.tenantId, 'inventory_adjust');
    const wip = await sys(ctx.tx, ctx.tenantId, 'wip');
    await post(ctx, 'work_order', lid, today(), w.wo_number ?? '', `Production variance on ${w.wo_number ?? w.name}`, balance > 0 ? [{ accountId: adj, debit: balance }, { accountId: wip, credit: balance }] : [{ accountId: wip, debit: -balance }, { accountId: adj, credit: -balance }]);
  }
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated', changes: { status: [w.status, 'closed'] } }];
}

export async function cancelWorkOrder(ctx: RecordCtx, id: string): Promise<RecordEvent[]> {
  assertPlanner(ctx);
  const w = await wo(ctx, id);
  if (!['draft', 'released', 'in_progress'].includes(w.status)) throw badRequest(`A ${w.status} order cannot be cancelled`);
  const used = await ctx.tx.one<{ issued: string }>(`select coalesce(sum(issued_qty), 0) as issued from work_order_materials where tenant_id = $1 and work_order_id = $2`, [ctx.tenantId, id]);
  if (Number(used!.issued) > 0 || Number(w.produced_qty) > 0 || Number(w.operation_cost) > 0) throw badRequest('Material, time or output is recorded on this order; return the material and close it instead');
  await ctx.tx.query(`update work_orders set status = 'cancelled' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  return [{ objectKey: 'work_order', recordId: id, kind: 'updated', changes: { status: [w.status, 'cancelled'] } }];
}

/* ───────────────────────── quality ───────────────────────── */

export interface QcInput {
  stage: 'incoming' | 'in_process' | 'final';
  productId: string;
  workOrderId?: string | null;
  purchaseOrderId?: string | null;
  lotId?: string | null;
  qtyInspected: number;
  qtyRejected?: number;
  result: 'pass' | 'fail' | 'hold';
  parameters?: { name: string; spec?: string | null; value?: string | null; ok?: boolean }[];
  notes?: string | null;
}

export async function recordQualityCheck(ctx: RecordCtx, input: QcInput) {
  const admin = isMfgOrOps(ctx);
  // final inspections release output, so they are for quality / production managers, not the people making it
  if (input.stage === 'final' && !admin) throw forbidden('Final inspections need the manufacturing or operations permission');
  if (input.workOrderId) {
    const w = await wo(ctx, input.workOrderId);
    if (w.product_id !== input.productId && input.stage === 'final') throw badRequest('A final inspection is of the order\'s product');
    if (!admin) {
      // on the floor: only the order's own product and materials, and only lots that went into or came out of it
      const ok = w.product_id === input.productId || (await ctx.tx.one(`select 1 from work_order_materials where tenant_id = $1 and work_order_id = $2 and product_id = $3`, [ctx.tenantId, w.id, input.productId]));
      if (!ok) throw badRequest('That product is not used or made on this work order');
      if (input.lotId) {
        const linked = await ctx.tx.one(
          `select 1 where exists (select 1 from production_logs where tenant_id = $1 and work_order_id = $2 and lot_id = $3)
                       or exists (select 1 from stock_lots where tenant_id = $1 and id = $3 and source = 'production' and source_id = $2)`,
          [ctx.tenantId, w.id, input.lotId],
        );
        if (!linked) throw badRequest('That batch was not used or made on this work order');
      }
    }
  } else if (!admin) throw forbidden('Quality checks need the manufacturing or operations permission');
  if (input.purchaseOrderId) await loadRow(ctx, 'purchase_order', input.purchaseOrderId, 'read');
  if ((input.qtyRejected ?? 0) > input.qtyInspected) throw badRequest('Rejected cannot exceed inspected');
  if (input.lotId) {
    const l = await ctx.tx.one<{ product_id: string }>(`select product_id from stock_lots where tenant_id = $1 and id = $2`, [ctx.tenantId, input.lotId]);
    if (!l || l.product_id !== input.productId) throw badRequest('That lot is of another product');
  }
  const n = await ctx.tx.one<{ n: string }>(`select app.next_counter('qc') as n`);
  const r = await ctx.tx.one<{ id: string }>(
    `insert into quality_checks (tenant_id, qc_number, stage, product_id, work_order_id, purchase_order_id, lot_id, qty_inspected, qty_rejected, result, parameters, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [ctx.tenantId, Number(n!.n), input.stage, input.productId, input.workOrderId ?? null, input.purchaseOrderId ?? null, input.lotId ?? null, input.qtyInspected, input.qtyRejected ?? 0, input.result, JSON.stringify(input.parameters ?? []), input.notes ?? null],
  );
  // a failed or held lot cannot be used until someone releases it
  if (input.lotId && input.result !== 'pass') await ctx.tx.query(`update stock_lots set status = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, input.lotId, input.result === 'fail' ? 'rejected' : 'quarantine']);
  return { id: r!.id, number: Number(n!.n) };
}

export async function listQualityChecks(ctx: RecordCtx, q: { from: string; to: string; result?: string | null }) {
  assertMfgRead(ctx);
  return ctx.tx.query(
    `select q.id, q.qc_number, q.stage, q.product_id, p.name as product, q.work_order_id, w.wo_number, q.lot_id, l.lot_number, q.qty_inspected::float8 as qty_inspected, q.qty_rejected::float8 as qty_rejected,
            q.result, q.parameters, q.notes, q.created_at, u.full_name as inspector
       from quality_checks q join products p on p.tenant_id = q.tenant_id and p.id = q.product_id left join work_orders w on w.tenant_id = q.tenant_id and w.id = q.work_order_id
       left join stock_lots l on l.tenant_id = q.tenant_id and l.id = q.lot_id left join users u on u.tenant_id = q.tenant_id and u.id = q.inspector_id
      where q.tenant_id = $1 and q.created_at::date between $2::date and $3::date and ($4::text is null or q.result = $4) order by q.created_at desc limit 1000`,
    [ctx.tenantId, q.from, q.to, q.result ?? null],
  );
}

/* ───────────────────────── job work ───────────────────────── */

async function jw(ctx: RecordCtx, id: string, action: 'read' | 'update' = 'update') {
  const { row } = await loadRow(ctx, 'job_work', id, action, action === 'update');
  return row as Record<string, any>;
}

export async function getJobWork(ctx: RecordCtx, id: string) {
  const j = await jw(ctx, id, 'read');
  const lines = await ctx.tx.query(
    `select l.id, l.product_id, p.name as product, p.sku, p.hsn_sac, p.unit, p.tax_rate::float8 as tax_rate, l.quantity::float8 as quantity, l.sent_qty::float8 as sent_qty, l.returned_qty::float8 as returned_qty,
            l.consumed_qty::float8 as consumed_qty, l.unit_cost::float8 as unit_cost, round(l.sent_qty * l.unit_cost, 2)::float8 as value
       from job_work_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = $1 and l.job_work_id = $2 order by l.position`,
    [ctx.tenantId, id],
  );
  const logs = await ctx.tx.query(`select id, kind, log_date, output_qty::float8 as output_qty, value::float8 as value, details, challan_ref, created_at from job_work_logs where tenant_id = $1 and job_work_id = $2 order by created_at`, [ctx.tenantId, id]);
  const vendor = j.vendor_id ? await ctx.tx.one(`select id, name, gstin, address, city, state from vendors where tenant_id = $1 and id = $2`, [ctx.tenantId, j.vendor_id]) : null;
  const output = j.output_product_id ? await ctx.tx.one(`select id, name, unit from products where tenant_id = $1 and id = $2`, [ctx.tenantId, j.output_product_id]) : null;
  return { company: await letterhead(ctx), jobWork: { ...j, rate: Number(j.rate), output_qty: j.output_qty == null ? null : Number(j.output_qty), received_qty: Number(j.received_qty), material_value: Number(j.material_value) }, lines, logs, vendor, output };
}

export async function saveJobWorkLines(ctx: RecordCtx, id: string, lines: { productId: string; quantity: number }[]) {
  const j = await jw(ctx, id);
  if (j.status !== 'draft') throw badRequest('Only draft job work can change');
  const ids = [...new Set(lines.map((l) => l.productId))];
  if (ids.length !== lines.length) throw badRequest('Each product once');
  const found = await ctx.tx.query<{ id: string; product_type: string }>(`select id, product_type from products where tenant_id = $1 and id = any($2::uuid[]) and deleted_at is null`, [ctx.tenantId, ids]);
  if (found.length !== ids.length || found.some((f) => f.product_type !== 'goods')) throw badRequest('Send goods only');
  await ctx.tx.query(`delete from job_work_lines where tenant_id = $1 and job_work_id = $2`, [ctx.tenantId, id]);
  let pos = 0;
  for (const l of lines) await ctx.tx.query(`insert into job_work_lines (tenant_id, job_work_id, product_id, quantity, position) values ($1,$2,$3,$4,$5)`, [ctx.tenantId, id, l.productId, l.quantity, pos++]);
}

/** Sends the goods under a delivery challan (DC/yy-yy/nnnn): stock leaves the warehouse and is held at the job worker. */
export async function sendJobWork(ctx: RecordCtx, id: string, input: { date?: string | null }): Promise<RecordEvent[]> {
  const j = await jw(ctx, id);
  if (j.status !== 'draft') throw badRequest('This job work was already sent');
  if (!j.vendor_id) throw badRequest('Choose the job worker');
  const lines = await ctx.tx.query<{ id: string; product_id: string; quantity: string }>(`select id, product_id, quantity from job_work_lines where tenant_id = $1 and job_work_id = $2 for update`, [ctx.tenantId, id]);
  if (!lines.length) throw badRequest('Add the goods being sent');
  const out = await ctx.tx.query<{ c: number }>(`select count(*)::int as c from job_work_lines where tenant_id = $1 and job_work_id = $2`, [ctx.tenantId, id]);
  if (!j.output_product_id && (out[0]?.c ?? 0) > 1) throw badRequest('When several items are sent, say what comes back ("Comes back as")');
  const date = input.date ?? today();
  const wh = (j.warehouse_id as string | null) ?? (await defaultWarehouse(ctx));
  const challan = await nextFyNumber(ctx, 'challan', date, 'DC');
  let total = 0;
  const details: { productId: string; qty: number; value: number }[] = [];
  for (const l of lines) {
    const qty = Number(l.quantity);
    const unit = await unitCostOf(ctx.tx, ctx.tenantId, l.product_id);
    await consumeLots(ctx, l.product_id, wh, qty);
    await moveStock(ctx, { productId: l.product_id, warehouseId: wh, type: 'out', qty: -qty, unitCost: unit, reason: 'Sent for job work', ref: { object: 'job_work', id, label: `${challan.number} · ${j.name}` } });
    await ctx.tx.query(`update job_work_lines set sent_qty = $3, unit_cost = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, qty, unit]);
    const value = r2(unit * qty);
    total = r2(total + value);
    details.push({ productId: l.product_id, qty, value });
  }
  await ctx.tx.query(`update job_works set status = 'sent', challan_number = $3, sent_date = $4, warehouse_id = $5, material_value = $6 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, challan.number, date, wh, total]);
  const lg = await ctx.tx.one<{ id: string }>(`insert into job_work_logs (tenant_id, job_work_id, kind, log_date, value, details, challan_ref) values ($1,$2,'send',$3,$4,$5,$6) returning id`, [ctx.tenantId, id, date, total, JSON.stringify(details), challan.number]);
  await post(ctx, 'job_work', lg!.id, date, challan.number, `Goods sent for job work: ${j.name}`, [
    { accountId: await sys(ctx.tx, ctx.tenantId, 'job_work_stock'), debit: total, partyType: 'vendor', partyId: j.vendor_id },
    { accountId: await sys(ctx.tx, ctx.tenantId, 'inventory'), credit: total },
  ]);
  return [{ objectKey: 'job_work', recordId: id, kind: 'updated', changes: { status: ['draft', 'sent'] } }];
}

/**
 * Receives processed goods back. The material consumed (default: in proportion to the output) moves
 * out of "material with job workers" into the output's cost, plus the job work charge (rate × qty),
 * which the vendor's bill later settles. Unprocessed material can come back as is.
 */
export async function receiveJobWork(
  ctx: RecordCtx,
  id: string,
  input: { outputQty: number; consumed?: { productId: string; qty: number }[]; returned?: { productId: string; qty: number }[]; date?: string | null; lotNumber?: string | null; challanRef?: string | null },
): Promise<RecordEvent[]> {
  const j = await jw(ctx, id);
  if (!['sent', 'partially_received'].includes(j.status)) throw badRequest('Send the goods first');
  const lines = await ctx.tx.query<{ id: string; product_id: string; sent_qty: string; returned_qty: string; consumed_qty: string; unit_cost: string }>(
    `select id, product_id, sent_qty, returned_qty, consumed_qty, unit_cost from job_work_lines where tenant_id = $1 and job_work_id = $2 for update`,
    [ctx.tenantId, id],
  );
  const outQty = n3(input.outputQty);
  if (outQty < 0) throw badRequest('Invalid quantity');
  const date = input.date ?? today();
  const outputProduct = (j.output_product_id as string | null) ?? lines[0]!.product_id;
  const expected = Number(j.output_qty ?? lines.reduce((s, l) => s + Number(l.sent_qty), 0));
  // up to 10% over what was expected (and never output without material still out with the job worker)
  if (n3(Number(j.received_qty) + outQty) > n3(expected * 1.1) + 1e-9) throw badRequest(`Expected ${expected} back in all; ${Number(j.received_qty)} already received`);
  if (outQty > 0 && !lines.some((l) => Number(l.sent_qty) - Number(l.returned_qty) - Number(l.consumed_qty) > 0)) throw badRequest('Nothing is still with the job worker');
  let consumedValue = 0;
  let returnedValue = 0;
  const details: Record<string, unknown>[] = [];
  for (const l of lines) {
    const pending = n3(Number(l.sent_qty) - Number(l.returned_qty) - Number(l.consumed_qty));
    const c = input.consumed?.find((x) => x.productId === l.product_id)?.qty ?? (outQty && expected ? n3(Math.min(pending, (Number(l.sent_qty) * outQty) / expected)) : 0);
    const back = input.returned?.find((x) => x.productId === l.product_id)?.qty ?? 0;
    if (c < 0 || back < 0 || c + back > pending + 1e-9) throw badRequest(`Only ${pending} of a sent item is still with the job worker`);
    const unit = Number(l.unit_cost);
    if (back > 0) {
      await moveStock(ctx, { productId: l.product_id, warehouseId: j.warehouse_id, type: 'in', qty: back, unitCost: unit, reason: 'Returned unprocessed from job work', ref: { object: 'job_work', id, label: j.challan_number ?? j.name } });
      returnedValue = r2(returnedValue + unit * back);
    }
    consumedValue = r2(consumedValue + unit * c);
    await ctx.tx.query(`update job_work_lines set consumed_qty = consumed_qty + $3, returned_qty = returned_qty + $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, c, back]);
    details.push({ productId: l.product_id, consumed: c, returned: back });
  }
  const charges = r2(Number(j.rate) * outQty);
  const outValue = r2(consumedValue + charges);
  if (outQty > 0) {
    await averageIn(ctx.tx, ctx.tenantId, outputProduct, outQty, outValue / outQty);
    await moveStock(ctx, { productId: outputProduct, warehouseId: j.warehouse_id, type: 'in', qty: outQty, unitCost: r2(outValue / outQty), reason: 'Received from job work', ref: { object: 'job_work', id, label: j.challan_number ?? j.name } });
    const p = await ctx.tx.one<{ batch_tracked: boolean; shelf_life_days: number | null }>(`select batch_tracked, shelf_life_days from products where tenant_id = $1 and id = $2`, [ctx.tenantId, outputProduct]);
    if (p?.batch_tracked || input.lotNumber)
      await addToLot(ctx, { productId: outputProduct, warehouseId: j.warehouse_id, lotNumber: (input.lotNumber || `${j.challan_number ?? 'JW'}`).slice(0, 60), qty: outQty, expiryDate: p?.shelf_life_days ? addDays(date, p.shelf_life_days) : null, source: 'job_work', sourceId: id });
  } else if (consumedValue) throw badRequest('Record the quantity that came back for the material used');
  const received = n3(Number(j.received_qty) + outQty);
  const allBack = (await ctx.tx.one<{ open: string }>(`select coalesce(sum(sent_qty - returned_qty - consumed_qty), 0) as open from job_work_lines where tenant_id = $1 and job_work_id = $2`, [ctx.tenantId, id]))!;
  const status = Number(allBack.open) <= 1e-9 || received + 1e-9 >= expected ? 'received' : 'partially_received';
  await ctx.tx.query(`update job_works set received_qty = $3, status = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, received, status]);
  const lg = await ctx.tx.one<{ id: string }>(`insert into job_work_logs (tenant_id, job_work_id, kind, log_date, output_qty, value, details, challan_ref) values ($1,$2,'receive',$3,$4,$5,$6,$7) returning id`, [
    ctx.tenantId, id, date, outQty, r2(outValue + returnedValue), JSON.stringify(details), input.challanRef ?? null,
  ]);
  if (j.work_order_id && j.operation_seq != null && outQty > 0)
    await ctx.tx.query(
      `update work_order_operations set qty_done = qty_done + $4, status = case when qty_done + $4 >= (select quantity from work_orders w where w.tenant_id = $1 and w.id = $2) then 'done' else 'subcontracted' end
        where tenant_id = $1 and work_order_id = $2 and seq = $3`,
      [ctx.tenantId, j.work_order_id, j.operation_seq, outQty],
    );
  const inv = await sys(ctx.tx, ctx.tenantId, 'inventory');
  const jws = await sys(ctx.tx, ctx.tenantId, 'job_work_stock');
  await post(ctx, 'job_work', lg!.id, date, j.challan_number ?? '', `Received from job work: ${j.name}`, [
    { accountId: inv, debit: r2(outValue + returnedValue) },
    { accountId: jws, credit: r2(consumedValue + returnedValue), partyType: 'vendor', partyId: j.vendor_id },
    { accountId: await sys(ctx.tx, ctx.tenantId, 'job_work_charges'), credit: charges, description: 'Job work charges (settled by the vendor bill)' },
  ]);
  return [{ objectKey: 'job_work', recordId: id, kind: 'updated', changes: { status: [j.status, status] } }];
}

/** Closes a job work: anything still with the job worker is written off as process loss. */
export async function closeJobWork(ctx: RecordCtx, id: string, reason: string): Promise<RecordEvent[]> {
  const j = await jw(ctx, id);
  if (!['sent', 'partially_received', 'received'].includes(j.status)) throw badRequest('Only sent job work can be closed');
  const lines = await ctx.tx.query<{ id: string; pending: string; unit_cost: string }>(`select id, sent_qty - returned_qty - consumed_qty as pending, unit_cost from job_work_lines where tenant_id = $1 and job_work_id = $2 for update`, [ctx.tenantId, id]);
  let loss = 0;
  for (const l of lines) {
    if (Number(l.pending) <= 0) continue;
    loss = r2(loss + Number(l.pending) * Number(l.unit_cost));
    await ctx.tx.query(`update job_work_lines set consumed_qty = consumed_qty + $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, l.pending]);
  }
  await ctx.tx.query(`update job_works set status = 'closed' where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
  const lg = await ctx.tx.one<{ id: string }>(`insert into job_work_logs (tenant_id, job_work_id, kind, value, details) values ($1,$2,'close',$3,$4) returning id`, [ctx.tenantId, id, loss, JSON.stringify([{ reason: reason.slice(0, 300) }])]);
  if (loss)
    await post(ctx, 'job_work', lg!.id, today(), j.challan_number ?? '', `Process loss at job worker: ${j.name}`, [
      { accountId: await sys(ctx.tx, ctx.tenantId, 'scrap'), debit: loss },
      { accountId: await sys(ctx.tx, ctx.tenantId, 'job_work_stock'), credit: loss, partyType: 'vendor', partyId: j.vendor_id },
    ]);
  return [{ objectKey: 'job_work', recordId: id, kind: 'updated', changes: { status: [j.status, 'closed'] } }];
}

/**
 * ITC-04 for a period: challans sent to job workers and goods received back. Inputs not back within
 * a year (capital goods: three) are deemed supplied on the day they went out (rule 45).
 */
export async function itc04(ctx: RecordCtx, from: string, to: string) {
  if (!hasAdmin(ctx.principal.permissions, 'manufacturing') && !hasAdmin(ctx.principal.permissions, 'books') && !hasAdmin(ctx.principal.permissions, 'billing')) throw forbidden();
  const sent = await ctx.tx.query(
    `select j.challan_number, g.log_date, v.name as job_worker, v.gstin, v.state, p.name as product, p.hsn_sac, p.unit, l.sent_qty::float8 as qty, round(l.sent_qty * l.unit_cost, 2)::float8 as taxable, p.tax_rate::float8 as tax_rate
       from job_work_logs g join job_works j on j.tenant_id = g.tenant_id and j.id = g.job_work_id join vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id
       join job_work_lines l on l.tenant_id = j.tenant_id and l.job_work_id = j.id join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where g.tenant_id = $1 and g.kind = 'send' and g.log_date between $2::date and $3::date order by g.log_date, j.challan_number`,
    [ctx.tenantId, from, to],
  );
  const received = await ctx.tx.query(
    `select j.challan_number as original_challan, g.challan_ref as job_worker_challan, g.log_date, v.name as job_worker, v.gstin, coalesce(op.name, p0.name) as product, g.output_qty::float8 as qty, g.value::float8 as value
       from job_work_logs g join job_works j on j.tenant_id = g.tenant_id and j.id = g.job_work_id join vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id
       left join products op on op.tenant_id = j.tenant_id and op.id = j.output_product_id
       left join lateral (select p.name from job_work_lines l join products p on p.tenant_id = l.tenant_id and p.id = l.product_id where l.tenant_id = j.tenant_id and l.job_work_id = j.id limit 1) p0 on true
      where g.tenant_id = $1 and g.kind = 'receive' and g.log_date between $2::date and $3::date order by g.log_date`,
    [ctx.tenantId, from, to],
  );
  const overdue = await ctx.tx.query(
    `select j.id, j.challan_number, j.sent_date, v.name as job_worker, p.name as product, (l.sent_qty - l.returned_qty - l.consumed_qty)::float8 as pending_qty,
            round((l.sent_qty - l.returned_qty - l.consumed_qty) * l.unit_cost, 2)::float8 as pending_value, (current_date - j.sent_date) as days_out
       from job_works j join vendors v on v.tenant_id = j.tenant_id and v.id = j.vendor_id join job_work_lines l on l.tenant_id = j.tenant_id and l.job_work_id = j.id
       join products p on p.tenant_id = l.tenant_id and p.id = l.product_id
      where j.tenant_id = $1 and j.status in ('sent','partially_received') and l.sent_qty - l.returned_qty - l.consumed_qty > 0 and j.sent_date < current_date - 300 order by j.sent_date`,
    [ctx.tenantId],
  );
  return { from, to, sent, received, nearingOneYear: overdue };
}

/* ───────────────────────── MRP ───────────────────────── */

interface Need {
  qty: number;
  date: string;
  source: string;
}

/**
 * Material requirements planning. Demand: open sales order lines in the horizon and material still
 * to issue on released work orders; plus safety stock (and reorder levels if asked). Supply: stock on
 * hand, open purchase orders and work orders still to finish. Made items are netted level by level
 * and their planned quantity explodes into component demand. The result is a list of buy and make
 * suggestions with need-by and order-by dates.
 */
export async function runMrp(ctx: RecordCtx, input: { horizonDays: number; includeReorder: boolean }) {
  assertMfgAdmin(ctx);
  const horizon = addDays(today(), input.horizonDays);
  const products = await ctx.tx.query<{ id: string; name: string; make_or_buy: string; lead_time_days: number | null; safety_stock: string | null; reorder_level: string | null; reorder_qty: string | null; min_order_qty: string | null; preferred_vendor_id: string | null; bom_id: string | null }>(
    `select p.id, p.name, p.make_or_buy, p.lead_time_days, p.safety_stock, p.reorder_level, p.reorder_qty, p.min_order_qty, p.preferred_vendor_id,
            (select id from boms b where b.tenant_id = p.tenant_id and b.product_id = p.id and b.status = 'active' order by b.is_default desc, b.revision desc limit 1) as bom_id
       from products p where p.tenant_id = $1 and p.deleted_at is null and p.product_type = 'goods' and coalesce(p.is_active, true)`,
    [ctx.tenantId],
  );
  const byId = new Map(products.map((p) => [p.id, p]));
  const demand = new Map<string, Need[]>();
  const add = (pid: string, n: Need) => {
    if (!byId.has(pid) || !(n.qty > 0)) return;
    demand.set(pid, [...(demand.get(pid) ?? []), n]);
  };
  for (const r of await ctx.tx.query<{ product_id: string; qty: string; need: string; order_number: string | null }>(
    `select l.product_id, l.quantity - l.shipped_qty as qty, coalesce(o.expected_delivery_date, o.order_date + 7)::text as need, o.order_number
       from sales_order_lines l join sales_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
      where l.tenant_id = $1 and o.status in ('confirmed','in_production','ready') and o.deleted_at is null and l.product_id is not null and l.quantity > l.shipped_qty
        and coalesce(o.expected_delivery_date, o.order_date + 7) <= $2::date`,
    [ctx.tenantId, horizon],
  ))
    add(r.product_id, { qty: Number(r.qty), date: r.need, source: `SO ${r.order_number ?? ''}`.trim() });
  for (const r of await ctx.tx.query<{ product_id: string; qty: string; need: string; wo_number: string | null }>(
    `select m.product_id, m.required_qty - m.issued_qty as qty, coalesce(w.planned_start, current_date)::text as need, w.wo_number
       from work_order_materials m join work_orders w on w.tenant_id = m.tenant_id and w.id = m.work_order_id
      where m.tenant_id = $1 and w.status in ('released','in_progress') and w.deleted_at is null and m.required_qty > m.issued_qty`,
    [ctx.tenantId],
  ))
    add(r.product_id, { qty: Number(r.qty), date: r.need, source: `WO ${r.wo_number ?? ''}`.trim() });
  // draft orders have no material list yet: their components come from the BOM they will be released with
  for (const r of await ctx.tx.query<{ product_id: string; qty: string; need: string; wo_number: string | null }>(
    `select l.product_id, sum((l.quantity / b.quantity) * ((w.quantity - w.produced_qty - w.scrapped_qty) / (b.yield_pct / 100)) / (1 - l.scrap_pct / 100)) as qty,
            min(coalesce(w.planned_start, current_date))::text as need, min(w.wo_number) as wo_number
       from work_orders w
       join boms b on b.tenant_id = w.tenant_id and b.id = coalesce(w.bom_id, (select id from boms d where d.tenant_id = w.tenant_id and d.product_id = w.product_id and d.status = 'active' order by d.is_default desc, d.revision desc limit 1))
       join bom_lines l on l.tenant_id = b.tenant_id and l.bom_id = b.id and l.line_kind = 'component'
      where w.tenant_id = $1 and w.status = 'draft' and w.deleted_at is null and w.quantity > w.produced_qty + w.scrapped_qty
      group by l.product_id`,
    [ctx.tenantId],
  ))
    add(r.product_id, { qty: Number(r.qty), date: r.need, source: `Draft ${r.wo_number ?? 'WO'}` });
  const onHand = new Map((await ctx.tx.query<{ product_id: string; v: string }>(`select product_id, sum(on_hand) as v from stock_levels where tenant_id = $1 group by product_id`, [ctx.tenantId])).map((r) => [r.product_id, Number(r.v)]));
  const onOrder = new Map<string, number>();
  for (const r of await ctx.tx.query<{ product_id: string; v: string }>(
    `select l.product_id, sum(l.quantity - l.received_qty) as v from purchase_order_lines l join purchase_orders o on o.tenant_id = l.tenant_id and o.id = l.order_id
      where l.tenant_id = $1 and o.status in ('draft','sent','partially_received') and o.deleted_at is null and l.product_id is not null and l.quantity > l.received_qty group by l.product_id`,
    [ctx.tenantId],
  ))
    onOrder.set(r.product_id, Number(r.v));
  for (const r of await ctx.tx.query<{ product_id: string; v: string }>(
    `select product_id, sum(quantity - produced_qty - scrapped_qty) as v from work_orders where tenant_id = $1 and status in ('draft','released','in_progress') and deleted_at is null and quantity > produced_qty + scrapped_qty group by product_id`,
    [ctx.tenantId],
  ))
    onOrder.set(r.product_id, (onOrder.get(r.product_id) ?? 0) + Number(r.v));
  // low-level codes: a component is planned after everything that uses it
  const comps = await ctx.tx.query<{ parent: string; child: string; qty: string; scrap: string; bom_qty: string; yield_pct: string; bom_id: string }>(
    `select b.product_id as parent, l.product_id as child, l.quantity as qty, l.scrap_pct as scrap, b.quantity as bom_qty, b.yield_pct, b.id as bom_id
       from boms b join bom_lines l on l.tenant_id = b.tenant_id and l.bom_id = b.id and l.line_kind = 'component' where b.tenant_id = $1 and b.status = 'active'`,
    [ctx.tenantId],
  );
  const level = new Map<string, number>(products.map((p) => [p.id, 0]));
  for (let pass = 0; pass < 25; pass++) {
    let changed = false;
    for (const c of comps) {
      const want = (level.get(c.parent) ?? 0) + 1;
      if ((level.get(c.child) ?? 0) < want) {
        level.set(c.child, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const run = await ctx.tx.one<{ id: string }>(`insert into mrp_runs (tenant_id, horizon_days, include_reorder) values ($1,$2,$3) returning id`, [ctx.tenantId, input.horizonDays, input.includeReorder]);
  const order = [...products].sort((a, b) => (level.get(a.id) ?? 0) - (level.get(b.id) ?? 0));
  let count = 0;
  for (const p of order) {
    const needs = demand.get(p.id) ?? [];
    const gross = n3(needs.reduce((s, x) => s + x.qty, 0));
    const have = n3((onHand.get(p.id) ?? 0) + (onOrder.get(p.id) ?? 0));
    const target = Math.max(Number(p.safety_stock ?? 0), input.includeReorder ? Number(p.reorder_level ?? 0) : 0);
    let net = n3(Math.max(0, gross + target - have));
    if (!gross && !net) continue;
    let suggested = 0;
    if (net > 0) suggested = n3(Math.max(net, Number(p.min_order_qty ?? 0), input.includeReorder && target > 0 && have - gross < target ? Number(p.reorder_qty ?? 0) : 0));
    const make = p.make_or_buy !== 'buy' && !!p.bom_id;
    const needBy = needs.length ? needs.map((x) => x.date).sort()[0]! : today();
    const orderBy = addDays(needBy, -(p.lead_time_days ?? 0));
    if (make && suggested > 0) {
      for (const c of comps.filter((x) => x.bom_id === p.bom_id))
        add(c.child, { qty: n3((Number(c.qty) / Number(c.bom_qty)) * (suggested / (Number(c.yield_pct) / 100)) / (1 - Number(c.scrap) / 100)), date: orderBy, source: `Make ${p.name}` });
    }
    if (net < 0) net = 0;
    await ctx.tx.query(
      `insert into mrp_lines (tenant_id, run_id, product_id, level, gross_req, on_hand, on_order, safety_stock, net_req, suggested_qty, action, need_by, order_by, vendor_id, bom_id, sources)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        ctx.tenantId, run!.id, p.id, level.get(p.id) ?? 0, gross, onHand.get(p.id) ?? 0, onOrder.get(p.id) ?? 0, target, net, suggested,
        suggested > 0 ? (make ? 'make' : 'buy') : 'none', needBy, orderBy, make ? null : p.preferred_vendor_id, make ? p.bom_id : null, JSON.stringify(needs.slice(0, 50)),
      ],
    );
    count++;
  }
  await ctx.tx.query(`update mrp_runs set lines = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, run!.id, count]);
  return { id: run!.id, lines: count };
}

export async function getMrpRun(ctx: RecordCtx, runId: string | null) {
  assertMfgAdmin(ctx);
  const run = runId
    ? await ctx.tx.one<Record<string, any>>(`select * from mrp_runs where tenant_id = $1 and id = $2`, [ctx.tenantId, runId])
    : await ctx.tx.one<Record<string, any>>(`select * from mrp_runs where tenant_id = $1 order by created_at desc limit 1`, [ctx.tenantId]);
  if (!run) return null;
  const lines = await ctx.tx.query(
    `select m.id, m.product_id, p.name as product, p.sku, p.unit, m.level, m.gross_req::float8 as gross_req, m.on_hand::float8 as on_hand, m.on_order::float8 as on_order, m.safety_stock::float8 as safety_stock,
            m.net_req::float8 as net_req, m.suggested_qty::float8 as suggested_qty, m.action, m.need_by, m.order_by, m.vendor_id, v.name as vendor, m.bom_id, m.sources, m.status, m.ref_object, m.ref_id
       from mrp_lines m join products p on p.tenant_id = m.tenant_id and p.id = m.product_id left join vendors v on v.tenant_id = m.tenant_id and v.id = m.vendor_id
      where m.tenant_id = $1 and m.run_id = $2 order by case m.action when 'none' then 1 else 0 end, m.order_by, m.level, p.name`,
    [ctx.tenantId, run.id],
  );
  return { run, lines };
}

/** Turns MRP buy lines into draft purchase orders (one per vendor) and make lines into draft work orders. */
export async function actOnMrp(ctx: RecordCtx, runId: string, lineIds: string[], overrides: Record<string, { qty?: number; vendorId?: string | null }> = {}) {
  assertMfgAdmin(ctx);
  const lines = await ctx.tx.query<{ id: string; product_id: string; action: string; suggested_qty: string; vendor_id: string | null; bom_id: string | null; need_by: string; order_by: string; status: string; name: string; tax_rate: string | null; hsn_sac: string | null; unit: string | null; price: string | null }>(
    `select m.id, m.product_id, m.action, m.suggested_qty, m.vendor_id, m.bom_id, m.need_by::text as need_by, m.order_by::text as order_by, m.status, p.name, p.tax_rate, p.hsn_sac, p.unit,
            coalesce(p.purchase_price, p.cost_price, p.avg_cost) as price
       from mrp_lines m join products p on p.tenant_id = m.tenant_id and p.id = m.product_id where m.tenant_id = $1 and m.run_id = $2 and m.id = any($3::uuid[]) for update of m`,
    [ctx.tenantId, runId, lineIds],
  );
  if (lines.length !== new Set(lineIds).size) throw notFound('Some lines are not in this plan');
  if (lines.some((l) => l.status !== 'open' || l.action === 'none')) throw badRequest('Some lines are already handled or need nothing');
  const events: RecordEvent[] = [];
  const created: { object: string; id: string }[] = [];
  const buys = new Map<string, typeof lines>();
  for (const l of lines.filter((x) => x.action === 'buy')) {
    const vendor = overrides[l.id]?.vendorId ?? l.vendor_id;
    if (!vendor) throw badRequest(`Choose a vendor for ${l.name} (or set its preferred vendor)`);
    buys.set(vendor, [...(buys.get(vendor) ?? []), l]);
  }
  for (const [vendorId, ls] of buys) {
    const po = await createRecord(ctx, 'purchase_order', { name: `Planned purchase (${ls.length} item${ls.length > 1 ? 's' : ''})`, vendor_id: vendorId, expected_date: ls.map((l) => l.need_by).sort()[0] });
    const poId = String(po.record.id);
    events.push(...po.events, ...(await savePoLines(ctx, poId, ls.map((l) => ({ productId: l.product_id, name: l.name, hsnSac: l.hsn_sac, unit: l.unit, quantity: overrides[l.id]?.qty ?? Number(l.suggested_qty), unitPrice: Number(l.price ?? 0), discountPct: 0, taxRate: Number(l.tax_rate ?? 18) })))));
    for (const l of ls) await ctx.tx.query(`update mrp_lines set status = 'done', ref_object = 'purchase_order', ref_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, poId]);
    created.push({ object: 'purchase_order', id: poId });
  }
  for (const l of lines.filter((x) => x.action === 'make')) {
    const w = await createRecord(ctx, 'work_order', { name: `${l.name} (planned)`, product_id: l.product_id, quantity: overrides[l.id]?.qty ?? Number(l.suggested_qty), planned_start: l.order_by < today() ? today() : l.order_by, planned_end: l.need_by < today() ? today() : l.need_by });
    await ctx.tx.query(`update work_orders set bom_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, w.record.id, l.bom_id]);
    await ctx.tx.query(`update mrp_lines set status = 'done', ref_object = 'work_order', ref_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, l.id, w.record.id]);
    events.push(...w.events);
    created.push({ object: 'work_order', id: String(w.record.id) });
  }
  return { created, events };
}

export async function ignoreMrpLines(ctx: RecordCtx, runId: string, lineIds: string[]) {
  assertMfgAdmin(ctx);
  await ctx.tx.query(`update mrp_lines set status = 'ignored' where tenant_id = $1 and run_id = $2 and id = any($3::uuid[]) and status = 'open'`, [ctx.tenantId, runId, lineIds]);
}

/* ───────────────────────── overview and reports ───────────────────────── */

export async function overview(ctx: RecordCtx) {
  assertMfgRead(ctx);
  const monthStart = `${today().slice(0, 7)}-01`;
  const r = await ctx.tx.one<Record<string, number>>(
    `select (select count(*)::int from work_orders where tenant_id = $1 and deleted_at is null and status = 'draft') as draft,
            (select count(*)::int from work_orders where tenant_id = $1 and deleted_at is null and status = 'released') as released,
            (select count(*)::int from work_orders where tenant_id = $1 and deleted_at is null and status = 'in_progress') as in_progress,
            (select count(*)::int from work_orders where tenant_id = $1 and deleted_at is null and status in ('released','in_progress') and planned_end < current_date) as late,
            (select coalesce(sum(material_cost + operation_cost - relieved_cost), 0)::float8 from work_orders where tenant_id = $1 and deleted_at is null and status in ('released','in_progress','completed')) as wip_value,
            (select coalesce(sum(quantity) filter (where kind = 'produce'), 0)::float8 from production_logs where tenant_id = $1 and created_at >= $2::date) as output_month,
            (select coalesce(sum(quantity) filter (where kind = 'scrap'), 0)::float8 from production_logs where tenant_id = $1 and created_at >= $2::date) as scrap_month,
            (select coalesce(sum(round((l.sent_qty - l.returned_qty - l.consumed_qty) * l.unit_cost, 2)), 0)::float8 from job_work_lines l join job_works j on j.tenant_id = l.tenant_id and j.id = l.job_work_id
              where l.tenant_id = $1 and j.status in ('sent','partially_received')) as at_job_workers,
            (select count(*)::int from stock_lots where tenant_id = $1 and on_hand > 0 and expiry_date <= current_date + 30) as lots_expiring,
            (select count(*)::int from quality_checks where tenant_id = $1 and created_at >= $2::date and result = 'fail') as qc_failed_month,
            (select count(*)::int from quality_checks where tenant_id = $1 and created_at >= $2::date) as qc_month`,
    [ctx.tenantId, monthStart],
  );
  const lateOrders = await ctx.tx.query(
    `select w.id, w.wo_number, w.name, p.name as product, w.quantity::float8 as quantity, w.produced_qty::float8 as produced_qty, w.planned_end, w.status from work_orders w join products p on p.tenant_id = w.tenant_id and p.id = w.product_id
      where w.tenant_id = $1 and w.deleted_at is null and w.status in ('released','in_progress') and w.planned_end < current_date order by w.planned_end limit 20`,
    [ctx.tenantId],
  );
  if (!canSeeCost(ctx)) Object.assign(r!, { wip_value: null, at_job_workers: null });
  return { ...r, lateOrders };
}

/** Load on each work centre by week: remaining planned minutes of open orders against capacity. */
export async function workCenterLoad(ctx: RecordCtx, weeks = 8) {
  assertMfgRead(ctx);
  const rows = await ctx.tx.query<{ id: string; name: string; code: string; capacity: number; week: string | null; load: number }>(
    `select c.id, c.name, c.code, (c.hours_per_day * c.days_per_week * 60 * c.parallel_units)::float8 as capacity,
            to_char(date_trunc('week', greatest(coalesce(w.planned_start, current_date), current_date)), 'YYYY-MM-DD') as week,
            coalesce(sum(greatest(o.planned_minutes - o.actual_minutes, 0)), 0)::float8 as load
       from work_centers c left join work_order_operations o on o.tenant_id = c.tenant_id and o.work_center_id = c.id and o.status in ('pending','in_progress')
       left join work_orders w on w.tenant_id = o.tenant_id and w.id = o.work_order_id and w.status in ('released','in_progress') and w.deleted_at is null
      where c.tenant_id = $1 and c.is_active and (o.id is null or w.id is not null) and (w.planned_start is null or w.planned_start < current_date + $2::int * 7)
      group by c.id, c.name, c.code, c.hours_per_day, c.days_per_week, c.parallel_units, 5 order by c.code, 5`,
    [ctx.tenantId, weeks],
  );
  return rows;
}

/** Orders finished in a range: output, scrap, actual unit cost against the BOM's standard cost. */
export async function productionReport(ctx: RecordCtx, from: string, to: string) {
  assertMfgRead(ctx);
  const cost = canSeeCost(ctx);
  const memo = new Map<string, BomCost>();
  const rows = await ctx.tx.query<Record<string, any>>(
    `select w.id, w.wo_number, w.name, p.name as product, w.bom_id, w.quantity::float8 as quantity, w.produced_qty::float8 as produced, w.scrapped_qty::float8 as scrapped,
            w.material_cost::float8 as material, w.operation_cost::float8 as operations, w.variance::float8 as variance, w.actual_end, w.status
       from work_orders w join products p on p.tenant_id = w.tenant_id and p.id = w.product_id
      where w.tenant_id = $1 and w.deleted_at is null and w.status in ('completed','closed') and w.actual_end::date between $2::date and $3::date order by w.actual_end desc limit 1000`,
    [ctx.tenantId, from, to],
  );
  for (const r of rows) {
    r.scrap_pct = r.produced + r.scrapped ? r2((r.scrapped / (r.produced + r.scrapped)) * 100) : 0;
    if (!cost) {
      Object.assign(r, { material: null, operations: null, variance: null, standard_unit_cost: null, actual_unit_cost: null });
      continue;
    }
    const std = r.bom_id ? await bomCost(ctx.tx, ctx.tenantId, r.bom_id, 0, memo) : null;
    r.standard_unit_cost = std?.perUnit ?? null;
    r.actual_unit_cost = r.produced ? r2((r.material + r.operations) / r.produced) : null;
  }
  return rows;
}

