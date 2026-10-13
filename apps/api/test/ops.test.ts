import { beforeAll, describe, expect, it } from 'vitest';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let mgr: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

const stockOf = async (productId: string | undefined) => {
  const r = (await api('GET', `/api/v1/inventory/products/${productId}`)).json;
  return Object.fromEntries(r.levels.map((l: Json) => [l.code, { onHand: l.on_hand, reserved: l.reserved, available: l.available }]));
};

beforeAll(async () => {
  h = await makeHarness('synapse_test_ops');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const m = await api('POST', '/api/admin/users', { email: 'mgr@acme.test', fullName: 'Mona Manager', password: PW, roles: ['sales_manager'] });
  ids.mgr = m.json.id;
  const r = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep One', password: PW, roles: ['sales_rep'] });
  ids.rep = r.json.id;
  await api('PATCH', `/api/admin/users/${ids.rep}`, { managerId: ids.mgr });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  mgr = h.as('acme', (await h.login('acme', 'mgr@acme.test')).token);
}, 90_000);

describe('apps', () => {
  it('are off until switched on; switching off hides their objects', async () => {
    expect((await api('GET', '/api/v1/records/sales_order')).status).toBe(404);
    expect((await api('GET', '/api/v1/inventory/stock')).status).toBe(404);
    expect((await rep('POST', '/api/admin/apps/orders/enable')).status).toBe(403);
    for (const a of ['orders', 'inventory', 'purchasing']) {
      const r = await api('POST', `/api/admin/apps/${a}/enable`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const meta = (await api('GET', '/api/v1/meta')).json;
    expect(meta.objects.map((o: Json) => o.key)).toEqual(expect.arrayContaining(['sales_order', 'vendor', 'purchase_order']));
    const apps = (await api('GET', '/api/admin/apps')).json.items;
    expect(apps.filter((a: Json) => a.enabled).map((a: Json) => a.key).sort()).toEqual(['inventory', 'orders', 'purchasing']);
    // a default warehouse exists and shows up as a choice on orders
    const wh = (await api('GET', '/api/v1/warehouses')).json.items;
    expect(wh[0]).toMatchObject({ code: 'MAIN', is_default: true });
    ids.main = wh[0].id;
    expect(meta.objects.find((o: Json) => o.key === 'sales_order').fields.find((f: Json) => f.key === 'warehouse_id').options.choices[0].value).toBe(ids.main);
    // roles for the apps were added
    const roles = (await api('GET', '/api/admin/roles')).json.items.map((x: Json) => x.key);
    expect(roles).toEqual(expect.arrayContaining(['inventory_manager', 'operations']));

    expect((await api('POST', '/api/admin/apps/purchasing/disable')).status).toBe(200);
    expect((await api('GET', '/api/v1/meta')).json.objects.some((o: Json) => o.key === 'vendor')).toBe(false);
    expect((await api('POST', '/api/admin/apps/purchasing/enable')).status).toBe(200);
  });
});

describe('catalogue and stock', () => {
  it('categories feed the product picklist; variants are generated', async () => {
    const furn = await api('POST', '/api/v1/product-categories', { name: 'Furniture' });
    const sofas = await api('POST', '/api/v1/product-categories', { name: 'Sofas', parentId: furn.json.id });
    expect(sofas.status).toBe(201);
    expect((await api('PATCH', `/api/v1/product-categories/${furn.json.id}`, { parentId: sofas.json.id })).status).toBe(400); // no cycles
    expect((await rep('POST', '/api/v1/product-categories', { name: 'Nope' })).status).toBe(403);
    const meta = (await api('GET', '/api/v1/meta')).json;
    const choices = meta.objects.find((o: Json) => o.key === 'product').fields.find((f: Json) => f.key === 'category_id').options.choices;
    expect(choices.map((c: Json) => c.label)).toEqual(['Furniture', 'Furniture / Sofas']);

    const p = await api('POST', '/api/v1/records/product', { name: 'Sofa Luxe', sku: 'SOFA', list_price: 60000, tax_rate: 18, category_id: sofas.json.id, track_inventory: true, reorder_level: 5, cost_price: 35000 });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    ids.sofa = p.json.id;
    expect((await api('POST', '/api/v1/records/product', { name: 'Bad', category_id: '00000000-0000-0000-0000-000000000001' })).status).toBe(400);
    const v = await api('POST', `/api/v1/products/${ids.sofa}/variants`, { attributes: [{ name: 'Finish', values: ['Teak', 'Walnut'] }, { name: 'Size', values: ['2 seater', '3 seater'] }] });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    expect(v.json).toEqual({ created: 4, skipped: 0 });
    expect((await api('POST', `/api/v1/products/${ids.sofa}/variants`, { attributes: [{ name: 'Finish', values: ['Teak'] }, { name: 'Size', values: ['2 seater'] }] })).json).toEqual({ created: 0, skipped: 1 });
    const vars = (await api('GET', `/api/v1/products/${ids.sofa}/variants`)).json.items;
    expect(vars.map((x: Json) => x.variant_options)).toEqual(['Teak / 2 seater', 'Teak / 3 seater', 'Walnut / 2 seater', 'Walnut / 3 seater']);
    expect(vars[0].sku).toBe('SOFA-TEAK-2SEA');
    const svc = await api('POST', '/api/v1/records/product', { name: 'Installation', product_type: 'service', list_price: 2500, tax_rate: 18 });
    ids.install = svc.json.id;
  });

  it('stock in / out / adjust / transfer, with a ledger and no negative stock', async () => {
    const show = await api('POST', '/api/v1/warehouses', { code: 'show', name: 'Showroom' });
    expect(show.status, JSON.stringify(show.json)).toBe(201);
    ids.show = show.json.id;
    const mv = (body: Json) => api('POST', '/api/v1/inventory/movements', body);
    expect((await mv({ type: 'in', productId: ids.sofa, warehouseId: ids.main, quantity: 10, unitCost: 35000, reason: 'Opening stock' })).status).toBe(201);
    expect((await mv({ type: 'out', productId: ids.sofa, warehouseId: ids.main, quantity: 2, reason: 'Display damage' })).json).toMatchObject({ onHand: 8, available: 8 });
    expect((await mv({ type: 'adjust', productId: ids.sofa, warehouseId: ids.main, quantity: -1 })).status).toBe(400); // reason required
    expect((await mv({ type: 'adjust', productId: ids.sofa, warehouseId: ids.main, quantity: -1, reason: 'Stock count' })).json.onHand).toBe(7);
    const tooMuch = await mv({ type: 'out', productId: ids.sofa, warehouseId: ids.main, quantity: 50 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.json.error.message).toMatch(/Not enough stock of Sofa Luxe/);
    expect((await mv({ type: 'in', productId: ids.install, warehouseId: ids.main, quantity: 1 })).status).toBe(400); // services carry no stock
    const tr = await api('POST', '/api/v1/inventory/transfers', { productId: ids.sofa, from: ids.main, to: ids.show, quantity: 3 });
    expect(tr.status, JSON.stringify(tr.json)).toBe(201);
    expect(await stockOf(ids.sofa)).toMatchObject({ MAIN: { onHand: 4 }, SHOW: { onHand: 3 } });
    // reps cannot move stock
    expect((await rep('POST', '/api/v1/inventory/movements', { type: 'in', productId: ids.sofa, warehouseId: ids.main, quantity: 1 })).status).toBe(403);
    const led = (await api('GET', `/api/v1/inventory/movements?product=${ids.sofa}`)).json.items;
    expect(led.map((m: Json) => m.movement_type)).toEqual(['transfer_in', 'transfer_out', 'adjust', 'out', 'in']);
    const ov = (await api('GET', '/api/v1/inventory/stock')).json;
    expect(ov.items.find((i: Json) => i.id === ids.sofa)).toMatchObject({ on_hand: 7, available: 7 });
    expect(ov.totals.stockValue).toBe(7 * 35000);
  });
});

describe('sales orders', () => {
  let quoteId: string;
  let orderId: string;

  it('an accepted quote becomes a draft order with the same lines', async () => {
    const acc = await api('POST', '/api/v1/records/account', { name: 'Kapoor Residence', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5' });
    expect(acc.status, JSON.stringify(acc.json)).toBe(201);
    ids.acc = acc.json.id;
    expect((await api('POST', '/api/v1/records/account', { name: 'Bad GST', gstin: 'nope' })).status).toBe(400);
    const deal = await api('POST', '/api/v1/records/deal', { name: 'Kapoor living room', account_id: ids.acc, amount: 150000 });
    ids.deal = deal.json.id;
    quoteId = (await api('POST', `/api/v1/quotes/from-deal/${ids.deal}`)).json.id;
    await api('PUT', `/api/v1/quotes/${quoteId}/lines`, {
      lines: [
        { productId: ids.sofa, name: 'Sofa Luxe', quantity: 3, unitPrice: 60000, discountPct: 5, taxRate: 18 },
        { productId: ids.install, name: 'Installation', quantity: 1, unitPrice: 2500, taxRate: 18 },
      ],
      billTo: { state: 'Maharashtra', address: 'Flat 12, Sea View, Mumbai' },
    });
    expect((await api('POST', `/api/v1/orders/from-quote/${quoteId}`)).status).toBe(400); // not accepted yet
    const sent = await api('POST', `/api/v1/quotes/${quoteId}/send`, {});
    await h.call('POST', `/api/public/quotes/${sent.json.link.split('/q/')[1]}/respond`, { body: { accept: true, name: 'Mr Kapoor' } });
    const o = await api('POST', `/api/v1/orders/from-quote/${quoteId}`);
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    orderId = o.json.id;
    expect((await api('POST', `/api/v1/orders/from-quote/${quoteId}`)).status).toBe(409);
    const full = (await api('GET', `/api/v1/orders/${orderId}`)).json;
    expect(full.order).toMatchObject({ status: 'draft', quote_id: quoteId, account_id: ids.acc, warehouse_id: ids.main, site_address: 'Flat 12, Sea View, Mumbai' });
    expect(full.order.order_number).toMatch(/^SO-\d{4}-0001$/);
    expect(full.lines.map((l: Json) => [l.name, l.quantity])).toEqual([['Sofa Luxe', 3], ['Installation', 1]]);
    const q = (await api('GET', `/api/v1/quotes/${quoteId}`)).json.quote;
    expect(full.order.grand_total).toBe(q.grand_total);
  });

  it('milestones split the total and must not exceed it', async () => {
    expect((await api('PUT', `/api/v1/orders/${orderId}/milestones`, { milestones: [{ name: 'Advance', percent: 60, trigger: 'on_confirmation' }, { name: 'Rest', percent: 50, trigger: 'on_delivery' }] })).status).toBe(400);
    expect((await api('PUT', `/api/v1/orders/${orderId}/milestones`, { milestones: [{ name: 'Advance', percent: 50, trigger: 'on_date' }] })).status).toBe(400); // date needed
    const r = await api('PUT', `/api/v1/orders/${orderId}/milestones`, { milestones: [{ name: 'Advance 50%', percent: 50, trigger: 'on_confirmation' }, { name: 'On delivery', percent: 50, trigger: 'on_delivery' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });

  it('confirming reserves stock, wins the deal and makes the advance due', async () => {
    const c = await api('POST', `/api/v1/orders/${orderId}/confirm`);
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(await stockOf(ids.sofa)).toMatchObject({ MAIN: { onHand: 4, reserved: 3, available: 1 } });
    const full = (await api('GET', `/api/v1/orders/${orderId}`)).json;
    expect(full.order.status).toBe('confirmed');
    expect(full.lines[0].reservedQty).toBe(3);
    expect(full.milestones.map((m: Json) => m.status)).toEqual(['due', 'pending']);
    const deal = (await api('GET', `/api/v1/records/deal/${ids.deal}`)).json;
    expect(deal.closed_at).toBeTruthy();
    // falling to the reorder level (5) alerted the owner once
    const low = (await api('GET', '/api/v1/notifications')).json.items.filter((n: Json) => n.kind === 'stock');
    expect(low.length).toBe(1);
    expect(low[0].title).toBe('Low stock: Sofa Luxe');
    // locked fields and deletion
    expect((await api('PATCH', `/api/v1/records/sales_order/${orderId}`, { warehouse_id: ids.show })).status).toBe(400);
    expect((await api('PUT', `/api/v1/orders/${orderId}/lines`, { lines: [] })).status).toBe(400);
    expect((await api('DELETE', `/api/v1/records/sales_order/${orderId}`)).status).toBe(400);
    expect((await api('POST', `/api/v1/orders/${orderId}/status`, { status: 'delivered' })).status).toBe(400);
  });

  it('payments against milestones roll up to the order', async () => {
    const ms = (await api('GET', `/api/v1/orders/${orderId}`)).json.milestones;
    expect((await api('POST', `/api/v1/orders/${orderId}/milestones/${ms[0].id}/payments`, { amount: ms[0].amount + 1 })).status).toBe(400);
    const p = await api('POST', `/api/v1/orders/${orderId}/milestones/${ms[0].id}/payments`, { amount: ms[0].amount, note: 'UPI ref 123' });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const o = (await api('GET', `/api/v1/records/sales_order/${orderId}`)).json;
    expect(o).toMatchObject({ payment_status: 'partially_paid', amount_paid: ms[0].amount });
    expect(o.balance_due).toBeCloseTo(o.grand_total - ms[0].amount, 2);
  });

  it('delivering from stock consumes the reservation and completes the flow', async () => {
    expect((await api('POST', `/api/v1/orders/${orderId}/status`, { status: 'ready' })).status).toBe(200);
    const d = await api('POST', `/api/v1/orders/${orderId}/deliver`);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(await stockOf(ids.sofa)).toMatchObject({ MAIN: { onHand: 1, reserved: 0, available: 1 } });
    const full = (await api('GET', `/api/v1/orders/${orderId}`)).json;
    expect(full.order).toMatchObject({ status: 'delivered', fulfilment_status: 'delivered' });
    expect(full.milestones[1].status).toBe('due');
    expect((await api('POST', `/api/v1/orders/${orderId}/status`, { status: 'cancelled', reason: 'x' })).status).toBe(400);
    expect((await api('POST', `/api/v1/orders/${orderId}/status`, { status: 'installed' })).status).toBe(200);
    expect((await api('POST', `/api/v1/orders/${orderId}/status`, { status: 'completed' })).status).toBe(200);
    const tl = (await api('GET', `/api/v1/records/sales_order/${orderId}/timeline`)).json.items.map((a: Json) => a.subject);
    expect(tl).toEqual(expect.arrayContaining(['Order confirmed', 'Order delivered', 'Order completed']));
  });

  it('cancelling releases reserved stock; reopening goes back to draft', async () => {
    const o = await api('POST', '/api/v1/records/sales_order', { name: 'Walk-in sale', account_id: ids.acc });
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    await api('PUT', `/api/v1/orders/${o.json.id}/lines`, { lines: [{ productId: ids.sofa, name: 'Sofa Luxe', quantity: 1, unitPrice: 60000, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/orders/${o.json.id}/confirm`)).status).toBe(200);
    expect((await stockOf(ids.sofa)).MAIN.reserved).toBe(1);
    expect((await api('POST', `/api/v1/orders/${o.json.id}/reopen`)).status).toBe(200);
    expect((await stockOf(ids.sofa)).MAIN.reserved).toBe(0);
    expect((await api('POST', `/api/v1/orders/${o.json.id}/confirm`)).status).toBe(200);
    expect((await api('POST', `/api/v1/orders/${o.json.id}/status`, { status: 'cancelled' })).status).toBe(400); // reason required
    expect((await api('POST', `/api/v1/orders/${o.json.id}/status`, { status: 'cancelled', reason: 'Customer changed mind' })).status).toBe(200);
    expect((await stockOf(ids.sofa)).MAIN.reserved).toBe(0);
    // a second confirmed order cannot reserve more than is available
    const big = await api('POST', '/api/v1/records/sales_order', { name: 'Big order', account_id: ids.acc });
    await api('PUT', `/api/v1/orders/${big.json.id}/lines`, { lines: [{ productId: ids.sofa, name: 'Sofa Luxe', quantity: 5, unitPrice: 60000, taxRate: 18 }] });
    const nope = await api('POST', `/api/v1/orders/${big.json.id}/confirm`);
    expect(nope.status).toBe(400);
    expect(nope.json.error.message).toMatch(/Not enough stock of Sofa Luxe to reserve/);
    ids.bigOrder = big.json.id;
  });

  it('reps work on their own orders only', async () => {
    const mine = await rep('POST', '/api/v1/records/sales_order', { name: 'Rep order' });
    expect(mine.status).toBe(201);
    expect((await rep('GET', '/api/v1/records/sales_order')).json.items.map((x: Json) => x.name)).toEqual(['Rep order']);
    expect((await rep('GET', `/api/v1/orders/${orderId}`)).status).toBe(404);
  });
});

describe('purchasing', () => {
  let poId: string;
  let lineIds: string[];

  it('a PO above the limit needs approval before it is issued', async () => {
    const v = await api('POST', '/api/v1/records/vendor', { name: 'WoodCraft Industries', vendor_type: 'manufacturer', gstin: '27AAACW1234F1Z5', lead_time_days: 10 });
    expect(v.status, JSON.stringify(v.json)).toBe(201);
    ids.vendor = v.json.id;
    expect((await api('POST', '/api/v1/records/vendor', { name: 'Bad', pan: '123' })).status).toBe(400);
    expect((await api('POST', '/api/v1/records/purchase_order', { name: 'No vendor' })).status).toBe(400);
    const rule = await api('POST', '/api/admin/rules/approval', { objectKey: 'purchase_order', name: 'POs over 1 lakh', criteria: [{ field: 'grand_total', op: 'gt', value: 100000 }], approverType: 'owner' });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    const po = await mgr('POST', '/api/v1/records/purchase_order', { name: 'Sofa restock', vendor_id: ids.vendor, expected_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10) });
    expect(po.status, JSON.stringify(po.json)).toBe(201);
    poId = po.json.id;
    expect(po.json.po_number).toMatch(/^PO-\d{4}-0001$/);
    const l = await mgr('PUT', `/api/v1/purchase-orders/${poId}/lines`, { lines: [{ productId: ids.sofa, name: 'Sofa Luxe', quantity: 6, unitPrice: 34000, taxRate: 18 }] });
    expect(l.status, JSON.stringify(l.json)).toBe(200);
    expect(l.json.po.approval_status).toBe('required');
    lineIds = l.json.lines.map((x: Json) => x.id);
    expect((await mgr('POST', `/api/v1/purchase-orders/${poId}/issue`)).status).toBe(400);
    expect((await mgr('POST', `/api/v1/approvals/submit/purchase_order/${poId}`, {})).status).toBe(200);
    const inbox = (await api('GET', '/api/v1/approvals?status=pending')).json.items;
    expect((await api('POST', `/api/v1/approvals/${inbox[0].id}/decide`, { approve: true })).status).toBe(200);
    const iss = await mgr('POST', `/api/v1/purchase-orders/${poId}/issue`);
    expect(iss.status, JSON.stringify(iss.json)).toBe(200);
    expect((await mgr('PUT', `/api/v1/purchase-orders/${poId}/lines`, { lines: [] })).status).toBe(400);
  });

  it('goods receipts bring accepted stock in and track rejections', async () => {
    const before = (await stockOf(ids.sofa)).MAIN.onHand;
    const r1 = await api('POST', `/api/v1/purchase-orders/${poId}/receive`, { vendorInvoice: 'WC/889', lines: [{ poLineId: lineIds[0], received: 4, rejected: 1, reason: 'Torn fabric' }] });
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    expect(r1.json.receiptNumber).toMatch(/^GRN-\d{4}-0001$/);
    expect((await stockOf(ids.sofa)).MAIN.onHand).toBe(before + 4);
    expect((await api('GET', `/api/v1/records/purchase_order/${poId}`)).json.status).toBe('partially_received');
    expect((await api('POST', `/api/v1/purchase-orders/${poId}/receive`, { lines: [{ poLineId: lineIds[0], received: 3 }] })).status).toBe(400); // only 2 open
    expect((await rep('POST', `/api/v1/purchase-orders/${poId}/receive`, { lines: [{ poLineId: lineIds[0], received: 1 }] })).status).toBe(403);
    const r2 = await api('POST', `/api/v1/purchase-orders/${poId}/receive`, { lines: [{ poLineId: lineIds[0], received: 2 }] });
    expect(r2.status).toBe(201);
    const full = (await api('GET', `/api/v1/purchase-orders/${poId}`)).json;
    expect(full.po.status).toBe('received');
    expect(full.receipts.length).toBe(2);
    expect(full.lines[0]).toMatchObject({ receivedQty: 6, rejectedQty: 1 });
    expect((await api('GET', `/api/v1/records/product/${ids.sofa}`)).json.cost_price).toBe(34000);
    // the big order can be confirmed now
    expect((await api('POST', `/api/v1/orders/${ids.bigOrder}/confirm`)).status).toBe(200);
    // the low-stock flag reset once stock recovered above the level, so a new dip alerts again later
    const perf = (await api('GET', `/api/v1/vendors/${ids.vendor}/performance`)).json;
    expect(perf).toMatchObject({ orders: 1, open_orders: 0, onTimePct: 100, rejectionPct: 14.3 });
    expect(perf.rating).toBeGreaterThan(3);
  });

  it('back-to-back POs copy sales order lines at cost', async () => {
    const r = await api('POST', `/api/v1/purchase-orders/from-order/${ids.bigOrder}`, { vendorId: ids.vendor });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const po = (await api('GET', `/api/v1/purchase-orders/${r.json.id}`)).json;
    expect(po.po).toMatchObject({ sales_order_id: ids.bigOrder, vendor_id: ids.vendor, status: 'draft' });
    expect(po.lines[0]).toMatchObject({ name: 'Sofa Luxe', quantity: 5, unitPrice: 34000 });
    expect(po.po.expected_date).toBeTruthy();
    expect((await api('POST', `/api/v1/purchase-orders/${r.json.id}/close`, { cancel: true, reason: 'Not needed' })).status).toBe(200);
  });
});
