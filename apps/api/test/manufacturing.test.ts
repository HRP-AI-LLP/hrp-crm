import { beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, PW } from './harness';

const today = new Date().toISOString().slice(0, 10);
const fyStart = `${Number(today.slice(5, 7)) >= 4 ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}-04-01`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let floor: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tech: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const sysAcc: Record<string, string> = {};

async function product(name: string, sku: string, extra: Record<string, unknown> = {}) {
  const r = await api('POST', '/api/v1/records/product', { name, sku, product_type: 'goods', track_inventory: true, tax_rate: 18, hsn_sac: '9403', unit: 'Nos', ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.id as string;
}
async function balanceOf(key: string) {
  const r = await api('GET', `/api/v1/books/reports/general-ledger?accountId=${sysAcc[key]}&from=${fyStart}&to=${today}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.closing as number;
}
async function tbBalanced() {
  const r = await api('GET', `/api/v1/books/reports/trial-balance?to=${today}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json.totals.balanced, JSON.stringify(r.json.totals)).toBe(true);
}
async function onHand(productId: string | undefined) {
  const r = await api('GET', `/api/v1/inventory/products/${productId}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.levels ?? r.json.stock ?? []).reduce((s: number, l: any) => s + Number(l.on_hand), 0) as number;
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_mfg');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  expect((await api('GET', '/api/v1/mfg/overview')).status).toBe(404); // app off
  for (const a of ['orders', 'delivery', 'inventory', 'purchasing', 'billing', 'books', 'manufacturing']) {
    const r = await api('POST', `/api/admin/apps/${a}/enable`);
    expect(r.status, `${a} ${JSON.stringify(r.json)}`).toBe(200);
  }
  expect((await api('PUT', '/api/v1/books/settings', { enabled: true, booksOfRecord: 'synapse', startDate: fyStart })).status).toBe(200);
  for (const a of (await api('GET', '/api/v1/books/accounts')).json as any[]) if (a.system_key) sysAcc[a.system_key] = a.id;
  await api('PATCH', '/api/admin/tenant', { settings: { company: { legalName: 'Elvm Craft LLP', state: 'Maharashtra' } } });
  for (const [email, role] of [
    ['floor@acme.test', 'shop_floor'],
    ['rep@acme.test', 'sales_rep'],
    ['tech@acme.test', 'technician'],
  ] as const) {
    const u = await api('POST', '/api/admin/users', { email, fullName: role, password: PW, roles: [role] });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
  }
  floor = h.as('acme', (await h.login('acme', 'floor@acme.test')).token);
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  tech = h.as('acme', (await h.login('acme', 'tech@acme.test')).token);

  ids.board = await product('Plywood board', 'PLY', { cost_price: 1000 });
  ids.hinge = await product('Hinge', 'HNG', { cost_price: 50 });
  ids.top = await product('Table top', 'TOP', { make_or_buy: 'make' });
  ids.table = await product('Dining table', 'TBL', { make_or_buy: 'make', batch_tracked: true, shelf_life_days: 365, safety_stock: 2 });
  ids.offcut = await product('Offcuts', 'OFC');
  ids.polish = await product('Polished board', 'PLB');
  ids.vendor = (await api('POST', '/api/v1/records/vendor', { name: 'Shree Polish Works', gstin: '27ABCDE1234F1Z5', state: 'Maharashtra' })).json.id;
  const os = await api('POST', '/api/v1/inventory/opening-stock', { rows: [{ sku: 'PLY', quantity: 100, unitCost: 1000 }, { sku: 'HNG', quantity: 400, unitCost: 50 }] });
  expect(os.status, JSON.stringify(os.json)).toBe(200);
}, 120_000);

describe('work centres and bills of materials', () => {
  it('only the manufacturing admin sets up work centres and BOMs', async () => {
    expect((await rep('POST', '/api/v1/mfg/work-centers', { code: 'X', name: 'X', hoursPerDay: 8, daysPerWeek: 6, parallelUnits: 1, costPerHour: 1 })).status).toBe(403);
    const wc = await api('POST', '/api/v1/mfg/work-centers', { code: 'CNC', name: 'CNC router', hoursPerDay: 8, daysPerWeek: 6, parallelUnits: 1, costPerHour: 600 });
    expect(wc.status, JSON.stringify(wc.json)).toBe(201);
    ids.cnc = wc.json.id;
    ids.asm = (await api('POST', '/api/v1/mfg/work-centers', { code: 'ASM', name: 'Assembly', hoursPerDay: 8, daysPerWeek: 6, parallelUnits: 2, costPerHour: 300 })).json.id;
    expect((await api('POST', '/api/v1/mfg/work-centers', { code: 'CNC', name: 'dupe', hoursPerDay: 8, daysPerWeek: 6, parallelUnits: 1, costPerHour: 1 })).status).toBe(400);
  });

  it('multi-level BOMs with routing, scrap and by-products; loops are refused; cost rolls up', async () => {
    // table top: 1 board (5% scrap) + 30 min on the CNC, gives offcuts worth 10% of the cost
    const top = await api('POST', '/api/v1/mfg/boms', {
      productId: ids.top, name: 'Top', quantity: 1,
      lines: [{ productId: ids.board, quantity: 1, scrapPct: 5 }, { kind: 'byproduct', productId: ids.offcut, quantity: 2, costSharePct: 10 }],
      operations: [{ seq: 10, name: 'Cut', workCenterId: ids.cnc, setupMinutes: 0, runMinutes: 30 }],
    });
    expect(top.status, JSON.stringify(top.json)).toBe(201);
    ids.topBom = top.json.id;
    expect((await api('POST', `/api/v1/mfg/boms/${ids.topBom}/status`, { action: 'activate' })).status).toBe(200);
    const tbl = await api('POST', '/api/v1/mfg/boms', {
      productId: ids.table, name: 'Table', quantity: 1, requiresQc: true,
      lines: [{ productId: ids.top, quantity: 1, operationSeq: 10 }, { productId: ids.hinge, quantity: 4 }],
      operations: [{ seq: 10, name: 'Assemble', workCenterId: ids.asm, setupMinutes: 0, runMinutes: 60 }],
    });
    expect(tbl.status, JSON.stringify(tbl.json)).toBe(201);
    ids.tableBom = tbl.json.id;
    expect((await api('POST', `/api/v1/mfg/boms/${ids.tableBom}/status`, { action: 'activate' })).status).toBe(200);
    // a top made from tables would loop
    const loop = await api('POST', '/api/v1/mfg/boms', { productId: ids.top, name: 'Loop', quantity: 1, lines: [{ productId: ids.table, quantity: 1 }], operations: [] });
    expect(loop.status).toBe(400);
    expect((await api('POST', '/api/v1/mfg/boms', { productId: ids.top, name: 'Self', quantity: 1, lines: [{ productId: ids.top, quantity: 1 }], operations: [] })).status).toBe(400);
    // active BOMs are not edited in place
    expect((await api('PUT', `/api/v1/mfg/boms/${ids.tableBom}`, { productId: ids.table, name: 'x', quantity: 1, lines: [{ productId: ids.hinge, quantity: 1 }], operations: [] })).status).toBe(400);
    const g = await api('GET', `/api/v1/mfg/boms/${ids.tableBom}`);
    expect(g.status).toBe(200);
    // top: (1000/0.95 + 300) × 0.9 = 1217.37; table: 1217.37 + 200 + 300 = 1717.37
    expect(g.json.cost.perUnit).toBeCloseTo(1717.37, 1);
    const ex = (await api('GET', `/api/v1/mfg/boms/${ids.tableBom}/explode?qty=10`)).json;
    expect(ex.find((x: any) => x.productId === ids.board).qty).toBeCloseTo(10.526, 2);
    expect(ex.find((x: any) => x.productId === ids.hinge).qty).toBe(40);
    expect((await api('GET', `/api/v1/mfg/where-used/${ids.hinge}`)).json).toHaveLength(1);
    // a new version is a draft copy
    const cp = await api('POST', `/api/v1/mfg/boms/${ids.tableBom}/copy`);
    expect(cp.json.version).toBe(2);
  });
});

describe('work orders', () => {
  it('a sub-assembly order: issue, operation, output with by-product, close; journals balance', async () => {
    const wo = await api('POST', '/api/v1/records/work_order', { name: 'Tops batch', product_id: ids.top, quantity: 4 });
    expect(wo.status, JSON.stringify(wo.json)).toBe(201);
    expect(wo.json).toMatchObject({ status: 'draft' });
    expect(wo.json.wo_number).toMatch(/^WO/);
    ids.woTop = wo.json.id;
    // cannot issue before release; the floor cannot create orders
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTop}/issue`, { remaining: true })).status).toBe(400);
    expect((await floor('POST', '/api/v1/records/work_order', { name: 'x', product_id: ids.top, quantity: 1 })).status).toBe(403);
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTop}/release`)).status).toBe(200);
    let d = (await floor('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).json;
    expect(d.workOrder.status).toBe('released');
    expect(d.materials[0].required_qty).toBeCloseTo(4.211, 2);
    expect(d.operations[0].planned_minutes).toBe(120);
    // the floor issues, records time and output
    const iss = await floor('POST', `/api/v1/mfg/work-orders/${ids.woTop}/issue`, { items: [{ productId: ids.board, qty: 5 }] });
    expect(iss.status, JSON.stringify(iss.json)).toBe(200);
    expect(await onHand(ids.board)).toBe(95);
    expect((await floor('POST', `/api/v1/mfg/work-orders/${ids.woTop}/return`, { items: [{ productId: ids.board, qty: 1 }] })).status).toBe(200);
    expect((await floor('POST', `/api/v1/mfg/work-orders/${ids.woTop}/return`, { items: [{ productId: ids.board, qty: 9 }] })).status).toBe(400);
    expect(await onHand(ids.board)).toBe(96);
    expect((await floor('POST', `/api/v1/mfg/work-orders/${ids.woTop}/operations/${d.operations[0].id}`, { minutes: 120, qtyDone: 4, status: 'done' })).status).toBe(200);
    expect(await balanceOf('wip')).toBeCloseTo(4000 + 1200, 2);
    const p = await floor('POST', `/api/v1/mfg/work-orders/${ids.woTop}/produce`, { qty: 4 });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    d = (await api('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).json;
    expect(d.workOrder.status).toBe('completed');
    expect(d.costs.wip).toBe(0);
    expect(await onHand(ids.top)).toBe(4);
    expect(await onHand(ids.offcut)).toBe(8);
    expect(await balanceOf('wip')).toBeCloseTo(0, 2);
    // 5200 relieved: offcuts take 10%
    expect(await balanceOf('overhead_absorbed')).toBeCloseTo(-1200, 2);
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTop}/close`)).status).toBe(200);
    // closed orders cannot be cancelled or deleted
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTop}/cancel`)).status).toBe(400);
    expect((await api('DELETE', `/api/v1/records/work_order/${ids.woTop}`)).status).toBe(400);
    await tbBalanced();
  });

  it('a finished-goods order needs final QC, makes a lot linked to its inputs, and books a variance on close', async () => {
    const wo = await api('POST', '/api/v1/records/work_order', { name: 'Tables', product_id: ids.table, quantity: 2, planned_start: today, planned_end: addDays(today, 3) });
    ids.woTable = wo.json.id;
    expect(wo.json.bom_id ?? ids.tableBom).toBe(ids.tableBom);
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTable}/release`)).status).toBe(200);
    // product and quantity are frozen after release
    expect((await api('PATCH', `/api/v1/records/work_order/${ids.woTable}`, { quantity: 5 })).status).toBe(400);
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTable}/issue`, { remaining: true })).status).toBe(200);
    expect(await onHand(ids.top)).toBe(2);
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTable}/produce`, { qty: 1 })).status).toBe(400); // QC first
    const qc = await api('POST', '/api/v1/mfg/quality', { stage: 'final', productId: ids.table, workOrderId: ids.woTable, qtyInspected: 2, result: 'pass', parameters: [{ name: 'Wobble', spec: '< 1 mm', value: '0.5 mm', ok: true }] });
    expect(qc.status, JSON.stringify(qc.json)).toBe(201);
    const pr = await api('POST', `/api/v1/mfg/work-orders/${ids.woTable}/produce`, { qty: 1, lotNumber: 'TBL-A1' });
    expect(pr.status, JSON.stringify(pr.json)).toBe(200);
    let d = (await api('GET', `/api/v1/mfg/work-orders/${ids.woTable}`)).json;
    expect(d.workOrder.status).toBe('in_progress');
    expect(d.costs.wip).toBeGreaterThan(0); // half still in WIP
    const lots = (await api('GET', `/api/v1/mfg/lots?productId=${ids.table}`)).json;
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ lot_number: 'TBL-A1', on_hand: 1 });
    expect(String(lots[0].expiry_date).slice(0, 10)).toBe(addDays(today, 365));
    // close with one unmade: what is left in WIP goes to variance
    expect((await api('POST', `/api/v1/mfg/work-orders/${ids.woTable}/close`)).status).toBe(200);
    d = (await api('GET', `/api/v1/mfg/work-orders/${ids.woTable}`)).json;
    expect(d.workOrder.status).toBe('closed');
    expect(d.costs.variance).toBeGreaterThan(0);
    expect(await balanceOf('wip')).toBeCloseTo(0, 2);
    await tbBalanced();
    // reports
    const ov = (await api('GET', '/api/v1/mfg/overview')).json;
    expect(ov.output_month).toBeGreaterThanOrEqual(5);
    const prod = (await api('GET', '/api/v1/mfg/reports/production')).json;
    expect(prod.length).toBe(2);
    expect(prod[0].standard_unit_cost).toBeTruthy();
    expect((await api('GET', '/api/v1/mfg/reports/load')).status).toBe(200);
  });

  it('lots trace through orders, follow first-expiry-first-out, and a failed check rejects a lot', async () => {
    // board becomes batch tracked: two lots registered against the stock on hand
    expect((await api('POST', '/api/v1/mfg/lots', { productId: ids.board, warehouseId: (await api('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).json.workOrder.warehouse_id, lotNumber: 'B-LATE', qty: 50, expiryDate: addDays(today, 200) })).status).toBe(201);
    const wh = (await api('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).json.workOrder.warehouse_id;
    expect((await api('POST', '/api/v1/mfg/lots', { productId: ids.board, warehouseId: wh, lotNumber: 'B-SOON', qty: 40, expiryDate: addDays(today, 20) })).status).toBe(201);
    expect((await api('POST', '/api/v1/mfg/lots', { productId: ids.board, warehouseId: wh, lotNumber: 'B-TOO-MUCH', qty: 50 })).status).toBe(400);
    const wo = (await api('POST', '/api/v1/records/work_order', { name: 'Tops 2', product_id: ids.top, quantity: 2, lot_number: 'TOP-2' })).json.id;
    await api('POST', `/api/v1/mfg/work-orders/${wo}/release`);
    expect((await api('POST', `/api/v1/mfg/work-orders/${wo}/issue`, { items: [{ productId: ids.board, qty: 2 }] })).status).toBe(200);
    const boardLots = (await api('GET', `/api/v1/mfg/lots?productId=${ids.board}`)).json;
    expect(boardLots.find((l: any) => l.lot_number === 'B-SOON').on_hand).toBe(38);
    expect(boardLots.find((l: any) => l.lot_number === 'B-LATE').on_hand).toBe(50);
    expect((await api('POST', `/api/v1/mfg/work-orders/${wo}/produce`, { qty: 2 })).status).toBe(200);
    const topLot = (await api('GET', `/api/v1/mfg/lots?productId=${ids.top}`)).json[0];
    expect(topLot.lot_number).toBe('TOP-2');
    const tr = (await api('GET', `/api/v1/mfg/lots/${topLot.id}/trace`)).json;
    expect(tr.inputs.map((x: any) => x.lot_number)).toEqual(['B-SOON']);
    const fwd = (await api('GET', `/api/v1/mfg/lots/${boardLots.find((l: any) => l.lot_number === 'B-SOON').id}/trace`)).json;
    expect(fwd.usedIn.map((x: any) => x.lot_number)).toContain('TOP-2');
    // incoming inspection fails a lot: it cannot be issued by name any more
    const late = boardLots.find((l: any) => l.lot_number === 'B-LATE').id;
    expect((await api('POST', '/api/v1/mfg/quality', { stage: 'incoming', productId: ids.board, lotId: late, qtyInspected: 5, qtyRejected: 3, result: 'fail' })).status).toBe(201);
    const wo3 = (await api('POST', '/api/v1/records/work_order', { name: 'Tops 3', product_id: ids.top, quantity: 1 })).json.id;
    await api('POST', `/api/v1/mfg/work-orders/${wo3}/release`);
    expect((await api('POST', `/api/v1/mfg/work-orders/${wo3}/issue`, { items: [{ productId: ids.board, qty: 1, lotId: late }] })).status).toBe(400);
    expect((await api('GET', '/api/v1/mfg/quality?result=fail')).json).toHaveLength(1);
    // the draft-only cancel works when nothing was used
    expect((await api('POST', `/api/v1/mfg/work-orders/${wo3}/cancel`)).status).toBe(200);
  });

  it('people outside manufacturing see orders read-only', async () => {
    expect((await rep('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).status).toBe(200);
    expect((await rep('POST', `/api/v1/mfg/work-orders/${ids.woTop}/close`)).status).toBe(403);
    expect((await rep('POST', '/api/v1/mfg/mrp/run', { horizonDays: 30, includeReorder: false })).status).toBe(403);
  });
});

describe('review hardening', () => {
  it('production screens need work order access; costs need cost access', async () => {
    for (const path of ['/api/v1/mfg/overview', '/api/v1/mfg/reports/production', '/api/v1/mfg/work-centers', `/api/v1/mfg/boms/${ids.tableBom}`, '/api/v1/mfg/lots', '/api/v1/mfg/quality', '/api/v1/mfg/reports/load'])
      expect((await tech('GET', path)).status, path).toBe(403);
    const wo = (await rep('GET', `/api/v1/mfg/work-orders/${ids.woTable}`)).json;
    expect(wo.costs).toBeNull();
    const rec = (await rep('GET', `/api/v1/records/work_order/${ids.woTable}`)).json;
    expect(rec.material_cost).toBeUndefined();
    expect(wo.materials[0].issued_value).toBeNull();
    expect((await rep('GET', `/api/v1/mfg/boms/${ids.tableBom}`)).json.cost).toBeNull();
    expect((await rep('GET', '/api/v1/mfg/reports/production')).json[0].material).toBeNull();
    expect((await rep('GET', '/api/v1/mfg/work-centers')).json[0].cost_per_hour).toBeNull();
    expect((await api('GET', `/api/v1/mfg/work-orders/${ids.woTable}`)).json.costs).not.toBeNull();
  });

  it('the shop floor cannot release, close or cancel, certify final QC, or touch unrelated batches', async () => {
    const id = (await api('POST', '/api/v1/records/work_order', { name: 'Floor test', product_id: ids.top, quantity: 1 })).json.id;
    expect((await floor('POST', `/api/v1/mfg/work-orders/${id}/release`)).status).toBe(403);
    expect((await floor('POST', `/api/v1/mfg/work-orders/${id}/cancel`)).status).toBe(403);
    expect((await api('POST', `/api/v1/mfg/work-orders/${id}/release`)).status).toBe(200);
    // output needs material first
    expect((await floor('POST', `/api/v1/mfg/work-orders/${id}/produce`, { qty: 1 })).status).toBe(400);
    expect((await floor('POST', '/api/v1/mfg/quality', { stage: 'final', productId: ids.top, workOrderId: id, qtyInspected: 1, result: 'pass' })).status).toBe(403);
    const tableLot = (await api('GET', `/api/v1/mfg/lots?productId=${ids.table}`)).json[0];
    const bad = await floor('POST', '/api/v1/mfg/quality', { stage: 'incoming', productId: ids.table, lotId: tableLot.id, workOrderId: id, qtyInspected: 1, result: 'fail' });
    expect(bad.status).toBe(400);
    expect((await api('GET', `/api/v1/mfg/lots?productId=${ids.table}`)).json[0].status).toBe('available');
    expect((await floor('POST', `/api/v1/mfg/lots/${tableLot.id}/status`, { status: 'rejected' })).status).toBe(403);
    expect((await floor('POST', `/api/v1/mfg/work-orders/${id}/close`)).status).toBe(403);
    expect((await api('POST', `/api/v1/mfg/work-orders/${id}/cancel`)).status).toBe(200);
  });

  it('batches on hold are never used, and stock leaving another way comes off the batches', async () => {
    const wh = (await api('GET', `/api/v1/mfg/work-orders/${ids.woTop}`)).json.workOrder.warehouse_id;
    const lots = (await api('GET', `/api/v1/mfg/lots?productId=${ids.board}`)).json as any[];
    const soon = lots.find((l) => l.lot_number === 'B-SOON');
    const lvl = (await api('GET', `/api/v1/inventory/products/${ids.board}`)).json.levels.find((l: any) => l.warehouse_id === wh).on_hand as number;
    const inLots = lots.reduce((s, l) => s + l.on_hand, 0);
    const untracked = lvl - inLots;
    // put the only usable batch on hold: production may use only stock outside batches
    expect((await api('POST', `/api/v1/mfg/lots/${soon.id}/status`, { status: 'quarantine' })).status).toBe(200);
    const id = (await api('POST', '/api/v1/records/work_order', { name: 'Hold test', product_id: ids.top, quantity: 50 })).json.id;
    await api('POST', `/api/v1/mfg/work-orders/${id}/release`);
    expect((await api('POST', `/api/v1/mfg/work-orders/${id}/issue`, { items: [{ productId: ids.board, qty: untracked + 1 }] })).status).toBe(400);
    expect((await api('GET', `/api/v1/inventory/products/${ids.board}`)).json.levels.find((l: any) => l.warehouse_id === wh).on_hand).toBe(lvl);
    await api('POST', `/api/v1/mfg/lots/${soon.id}/status`, { status: 'available' });
    // an adjustment that takes stock below the batches trims them
    const adj = await api('POST', '/api/v1/inventory/movements', { productId: ids.board, warehouseId: wh, type: 'adjust', quantity: -(untracked + 5), reason: 'Count' });
    expect([200, 201], JSON.stringify(adj.json)).toContain(adj.status);
    const after = (await api('GET', `/api/v1/mfg/lots?productId=${ids.board}&all=1`)).json as any[];
    expect(after.reduce((s, l) => s + l.on_hand, 0)).toBeCloseTo(inLots - 5, 3);
    await api('POST', `/api/v1/mfg/work-orders/${id}/cancel`);
  });
});

describe('job work', () => {
  it('sends goods under a challan, receives them processed, values them with the charges and reports ITC-04', async () => {
    const jw = await api('POST', '/api/v1/records/job_work', { name: 'Polishing', vendor_id: ids.vendor, process: 'PU polish', output_product_id: ids.polish, output_qty: 10, rate: 120 });
    expect(jw.status, JSON.stringify(jw.json)).toBe(201);
    ids.jw = jw.json.id;
    expect(jw.json.jw_number).toMatch(/^JW/);
    expect((await api('POST', `/api/v1/mfg/job-works/${ids.jw}/send`, {})).status).toBe(400); // no lines
    expect((await api('PUT', `/api/v1/mfg/job-works/${ids.jw}/lines`, { lines: [{ productId: ids.board, quantity: 10 }] })).status).toBe(200);
    const s = await api('POST', `/api/v1/mfg/job-works/${ids.jw}/send`, { date: today });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    let g = (await api('GET', `/api/v1/mfg/job-works/${ids.jw}`)).json;
    expect(g.jobWork.status).toBe('sent');
    expect(g.jobWork.challan_number).toMatch(/^DC\//);
    expect(g.jobWork.material_value).toBe(10000);
    expect(await balanceOf('job_work_stock')).toBeCloseTo(10000, 2);
    // lines are frozen once sent
    expect((await api('PUT', `/api/v1/mfg/job-works/${ids.jw}/lines`, { lines: [{ productId: ids.board, quantity: 1 }] })).status).toBe(400);
    // 6 come back polished (consuming 6 boards), 1 board comes back as is
    const r = await api('POST', `/api/v1/mfg/job-works/${ids.jw}/receive`, { outputQty: 6, returned: [{ productId: ids.board, qty: 1 }], challanRef: 'SPW/88' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    g = (await api('GET', `/api/v1/mfg/job-works/${ids.jw}`)).json;
    expect(g.jobWork.status).toBe('partially_received');
    expect(g.lines[0]).toMatchObject({ consumed_qty: 6, returned_qty: 1 });
    expect(await onHand(ids.polish)).toBe(6);
    expect(await balanceOf('job_work_stock')).toBeCloseTo(3000, 2);
    // more than expected (plus 10%) is refused; so is changing the expected quantity once sent
    expect((await api('POST', `/api/v1/mfg/job-works/${ids.jw}/receive`, { outputQty: 100 })).status).toBe(400);
    expect((await api('PATCH', `/api/v1/records/job_work/${ids.jw}`, { output_qty: 1000 })).status).toBe(400);
    // too much back is refused; then close writes the rest off as process loss
    expect((await api('POST', `/api/v1/mfg/job-works/${ids.jw}/receive`, { outputQty: 0, returned: [{ productId: ids.board, qty: 5 }] })).status).toBe(400);
    expect((await api('POST', `/api/v1/mfg/job-works/${ids.jw}/close`, { reason: 'Breakage at the job worker' })).status).toBe(200);
    expect(await balanceOf('job_work_stock')).toBeCloseTo(0, 2);
    await tbBalanced();
    const itc = (await api('GET', `/api/v1/mfg/reports/itc04?from=${fyStart}&to=${today}`)).json;
    expect(itc.sent).toHaveLength(1);
    expect(itc.sent[0]).toMatchObject({ qty: 10, taxable: 10000, gstin: '27ABCDE1234F1Z5' });
    expect(itc.received[0]).toMatchObject({ qty: 6, job_worker_challan: 'SPW/88' });
    expect((await rep('GET', '/api/v1/mfg/reports/itc04')).status).toBe(403);
    expect((await rep('GET', `/api/v1/mfg/job-works/${ids.jw}`)).status).toBe(403);
  });
});

describe('MRP', () => {
  it('nets demand level by level and turns suggestions into purchase and work orders', async () => {
    await api('PATCH', `/api/v1/records/product/${ids.hinge}`, { preferred_vendor_id: ids.vendor, lead_time_days: 5, min_order_qty: 100 });
    const acct = (await api('POST', '/api/v1/records/account', { name: 'Hotel Blue', state: 'Maharashtra' })).json.id;
    const so = await api('POST', '/api/v1/records/sales_order', { name: 'Hotel tables', account_id: acct, expected_delivery_date: addDays(today, 20) });
    expect(so.status, JSON.stringify(so.json)).toBe(201);
    expect((await api('PUT', `/api/v1/orders/${so.json.id}/lines`, { lines: [{ productId: ids.table, name: 'Dining table', quantity: 120, unitPrice: 9000, taxRate: 18 }] })).status).toBe(200);
    const conf = await api('POST', `/api/v1/orders/${so.json.id}/confirm`, {});
    expect([200, 201], JSON.stringify(conf.json)).toContain(conf.status);
    const run = await api('POST', '/api/v1/mfg/mrp/run', { horizonDays: 60, includeReorder: false });
    expect(run.status, JSON.stringify(run.json)).toBe(201);
    const plan = (await api('GET', '/api/v1/mfg/mrp')).json;
    const line = (pid: string | undefined) => plan.lines.find((l: any) => l.product_id === pid);
    // tables: 120 needed + 2 safety − 1 on hand → make 121
    expect(line(ids.table)).toMatchObject({ action: 'make', suggested_qty: 121 });
    // tops: 121 − 4 on hand → make 117
    expect(line(ids.top)).toMatchObject({ action: 'make', suggested_qty: 117 });
    // hinges: 484 for tables − 392 on hand → buy 92, raised to the minimum order of 100
    expect(line(ids.hinge)).toMatchObject({ action: 'buy', suggested_qty: 100 });
    expect(line(ids.hinge).order_by.slice(0, 10)).toBe(addDays(line(ids.hinge).need_by.slice(0, 10), -5));
    expect(line(ids.board).action).toBe('buy');
    const act = await api('POST', `/api/v1/mfg/mrp/${plan.run.id}/act`, { lineIds: [line(ids.hinge).id, line(ids.table).id] });
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    expect(act.json.created.map((x: any) => x.object).sort()).toEqual(['purchase_order', 'work_order']);
    const po = (await api('GET', `/api/v1/purchase-orders/${act.json.created.find((x: any) => x.object === 'purchase_order').id}`)).json;
    expect(po.lines?.[0]?.quantity ?? po.lines?.[0]?.qty).toBe(100);
    // done lines cannot be acted on twice; a buy line with no vendor asks for one
    expect((await api('POST', `/api/v1/mfg/mrp/${plan.run.id}/act`, { lineIds: [line(ids.hinge).id] })).status).toBe(400);
    expect((await api('POST', `/api/v1/mfg/mrp/${plan.run.id}/act`, { lineIds: [line(ids.board).id] })).status).toBe(400);
    expect((await api('POST', `/api/v1/mfg/mrp/${plan.run.id}/ignore`, { lineIds: [line(ids.board).id] })).status).toBe(200);
    // the next run sees the draft table order as supply and still plans its components
    await api('POST', '/api/v1/mfg/mrp/run', { horizonDays: 60, includeReorder: false });
    const again = (await api('GET', '/api/v1/mfg/mrp')).json;
    const l2 = (pid: string | undefined) => again.lines.find((l: any) => l.product_id === pid);
    expect(l2(ids.table).action).toBe('none');
    expect(l2(ids.top)).toMatchObject({ action: 'make', suggested_qty: 117 });
  });
});
