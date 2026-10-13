import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { sweepTenant } from '../src/services/reminders';
import { fakeR2, type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let tech: ReturnType<typeof h.as>;
let crew: ReturnType<typeof h.as>;
let other: ReturnType<typeof h.as>;
let agent: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let tenantId = '';
let r2: ReturnType<typeof fakeR2>;

const level = async (pid: string) => (await api('GET', `/api/v1/inventory/products/${pid}`)).json.levels[0];
const order = async () => (await api('GET', `/api/v1/orders/${ids.order}`)).json;
const PNG_URL = `data:image/png;base64,${btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13))}`;

async function sweep() {
  const db = Db.fromEnv(h.env);
  try {
    await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
  } finally {
    await db.close();
  }
}
async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_field');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  tenantId = me.tenant.id;
  ids.owner = me.user.id;
}, 90_000);

describe('setup', () => {
  it('delivery needs the orders app; roles arrive with the apps', async () => {
    const early = await api('POST', '/api/admin/apps/delivery/enable');
    expect(early.status).toBe(400);
    expect(early.json.error.message).toMatch(/Sales orders first/);
    for (const a of ['orders', 'inventory', 'delivery', 'service']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
    expect((await api('POST', '/api/admin/apps/orders/disable')).status).toBe(400);
    const mk = async (email: string, name: string, roles: string[]) => {
      const u = await api('POST', '/api/admin/users', { email, fullName: name, password: PW, roles });
      expect(u.status, JSON.stringify(u.json)).toBe(201);
      ids[email] = u.json.id;
      return h.as('acme', (await h.login('acme', email)).token);
    };
    tech = await mk('tech@acme.test', 'Tara Tech', ['technician']);
    crew = await mk('crew@acme.test', 'Chetan Crew', ['technician']);
    other = await mk('other@acme.test', 'Omar Other', ['technician']);
    agent = await mk('agent@acme.test', 'Asha Agent', ['service_agent']);

    const wh = (await api('GET', '/api/v1/warehouses')).json.items[0].id;
    const p = await api('POST', '/api/v1/records/product', { name: 'Wardrobe', list_price: 50000, tax_rate: 18, track_inventory: true });
    ids.product = p.json.id;
    await api('POST', '/api/v1/inventory/movements', { type: 'in', productId: ids.product, warehouseId: wh, quantity: 5 });
    ids.acc = (await api('POST', '/api/v1/records/account', { name: 'Mehta Home', state: 'Gujarat' })).json.id;
    ids.contact = (await api('POST', '/api/v1/records/contact', { last_name: 'Mehta', first_name: 'Raj', phone: '+91 98200 11111', account_id: ids.acc })).json.id;
    const o = await api('POST', '/api/v1/records/sales_order', { name: 'Mehta bedroom', account_id: ids.acc, site_address: '22 Ring Road, Surat', installation_required: true });
    ids.order = o.json.id;
    await api('PUT', `/api/v1/orders/${ids.order}/lines`, { lines: [{ productId: ids.product, name: 'Wardrobe', quantity: 2, unitPrice: 50000, taxRate: 18 }] });
    await api('PUT', `/api/v1/orders/${ids.order}/milestones`, { milestones: [{ name: 'Advance', percent: 90, trigger: 'on_confirmation' }, { name: 'After installation', percent: 10, trigger: 'on_installation' }] });
    expect((await api('POST', `/api/v1/orders/${ids.order}/confirm`)).status).toBe(200);
    expect(await level(ids.product!)).toMatchObject({ on_hand: 5, reserved: 2 });
  });
});

describe('deliveries', () => {
  it('are planned against what is still unshipped', async () => {
    const lineId = (await order()).lines[0].id;
    ids.line = lineId;
    expect((await api('POST', `/api/v1/orders/${ids.order}/shipments`, { lines: [{ orderLineId: lineId, quantity: 3 }] })).status).toBe(400);
    const s1 = await api('POST', `/api/v1/orders/${ids.order}/shipments`, { lines: [{ orderLineId: lineId, quantity: 1 }], plannedDate: '2026-10-20', carrier: 'Own tempo', ownerId: ids['tech@acme.test'] });
    expect(s1.status, JSON.stringify(s1.json)).toBe(201);
    ids.s1 = s1.json.id;
    const s2 = await api('POST', `/api/v1/orders/${ids.order}/shipments`, {});
    expect(s2.status).toBe(201);
    ids.s2 = s2.json.id;
    expect((await api('POST', `/api/v1/orders/${ids.order}/shipments`, {})).status).toBe(400); // nothing left
    const sh = (await api('GET', `/api/v1/shipments/${ids.s1}`)).json;
    expect(sh.shipment).toMatchObject({ status: 'planned', sales_order_id: ids.order, delivery_address: '22 Ring Road, Surat', carrier: 'Own tempo' });
    expect(sh.shipment.shipment_number).toMatch(/^DL-\d{4}-0001$/);
    expect(sh.lines).toEqual([expect.objectContaining({ name: 'Wardrobe', quantity: 1 })]);
    // the public link only works once the goods are on their way
    expect((await h.call('GET', `/api/public/jobs/shipment/${sh.shipment.share_token}`)).status).toBe(404);
    ids.s1token = sh.shipment.share_token;
  });

  it('dispatch takes stock out of the reservation; the customer confirms with a signature', async () => {
    expect((await api('POST', `/api/v1/shipments/${ids.s1}/deliver`, {})).status).toBe(400); // not dispatched
    const d = await api('POST', `/api/v1/shipments/${ids.s1}/dispatch`, { vehicleNo: 'GJ05 AB 1234', driverName: 'Ramesh', driverPhone: '+91 90000 00000' });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(await level(ids.product!)).toMatchObject({ on_hand: 4, reserved: 1 });
    let o = await order();
    expect(o.order.status).toBe('dispatched');
    expect(o.lines[0]).toMatchObject({ shippedQty: 1, deliveredQty: 0 });

    const pub = await h.call('GET', `/api/public/jobs/shipment/${ids.s1token}`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(pub.json).toMatchObject({ kind: 'shipment', status: 'dispatched', vehicleNo: 'GJ05 AB 1234', items: [{ name: 'Wardrobe', quantity: 1, unit: null }] });
    expect(pub.json).not.toHaveProperty('owner_id');
    const conf = await h.call('POST', `/api/public/jobs/shipment/${ids.s1token}/confirm`, { body: { name: 'Raj Mehta', rating: 5, feedback: 'On time', signature: PNG_URL } });
    expect(conf.status, JSON.stringify(conf.json)).toBe(200);
    expect((await h.call('POST', `/api/public/jobs/shipment/${ids.s1token}/confirm`, { body: { name: 'Again' } })).status).toBe(400);
    const sh = (await api('GET', `/api/v1/shipments/${ids.s1}`)).json.shipment;
    expect(sh).toMatchObject({ status: 'delivered', received_by: 'Raj Mehta', customer_rating: 5, confirmed_by: 'Raj Mehta' });
    const files = (await api('GET', `/api/v1/files?object=shipment&id=${ids.s1}`)).json.items;
    expect(files[0]).toMatchObject({ kind: 'signature', contentType: 'image/png' });
    o = await order();
    expect(o.order).toMatchObject({ fulfilment_status: 'partially_delivered', status: 'dispatched' });
    expect(o.lines[0]).toMatchObject({ shippedQty: 1, deliveredQty: 1 });
  });

  it('a failed delivery returns the goods to stock and they can go again', async () => {
    await api('POST', `/api/v1/shipments/${ids.s2}/pack`);
    await api('POST', `/api/v1/shipments/${ids.s2}/dispatch`, {});
    expect(await level(ids.product!)).toMatchObject({ on_hand: 3, reserved: 0 });
    expect((await api('POST', `/api/v1/shipments/${ids.s2}/fail`, { reason: 'x' })).status).toBe(400);
    const f = await api('POST', `/api/v1/shipments/${ids.s2}/fail`, { reason: 'Customer not at home' });
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(await level(ids.product!)).toMatchObject({ on_hand: 4, reserved: 1 });
    expect((await order()).lines[0]).toMatchObject({ shippedQty: 1, deliveredQty: 1, reservedQty: 1 });
    expect((await api('DELETE', `/api/v1/records/shipment/${ids.s1}`)).status).toBe(400);
    const again = await api('POST', `/api/v1/orders/${ids.order}/shipments`, {});
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    await api('POST', `/api/v1/shipments/${again.json.id}/dispatch`, {});
    expect((await api('POST', `/api/v1/shipments/${again.json.id}/deliver`, { receivedBy: 'Security guard' })).status).toBe(200);
    const o = await order();
    expect(o.order).toMatchObject({ status: 'delivered', fulfilment_status: 'delivered' });
    expect(await level(ids.product!)).toMatchObject({ on_hand: 3, reserved: 0 });
  });
});

describe('installations', () => {
  it('technicians see their own jobs; the crew sees shared jobs', async () => {
    const start = new Date(Date.now() + 86_400_000).toISOString();
    const bad = await api('POST', '/api/v1/installations', { orderId: ids.order, start, end: new Date(Date.now()).toISOString(), technicianId: ids['tech@acme.test'] });
    expect(bad.status).toBe(400);
    const r = await api('POST', '/api/v1/installations', { orderId: ids.order, start, technicianId: ids['tech@acme.test'], crewIds: [ids['crew@acme.test']], checklist: ['Assemble', 'Fix to wall'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.job = r.json.id;
    const j = (await tech('GET', `/api/v1/installations/${ids.job}`)).json.installation;
    expect(j).toMatchObject({ status: 'scheduled', owner_id: ids['tech@acme.test'], site_address: '22 Ring Road, Surat' });
    expect(j.job_number).toMatch(/^INS-/);
    expect(j.checklist).toEqual([{ label: 'Assemble', done: false }, { label: 'Fix to wall', done: false }]);
    expect(j.crew.map((x: Json) => x.full_name)).toEqual(['Chetan Crew']);
    expect((await crew('GET', `/api/v1/installations/${ids.job}`)).status).toBe(200);
    expect((await other('GET', `/api/v1/installations/${ids.job}`)).status).toBe(404);
    expect((await tech('GET', '/api/v1/records/installation')).json.items.length).toBe(1);
    expect((await other('GET', '/api/v1/records/installation')).json.items.length).toBe(0);
    expect((await crew('GET', '/api/v1/notifications')).json.items.some((n: Json) => n.kind === 'assignment')).toBe(true);
    const sched = (await tech('GET', `/api/v1/field/schedule?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 86_400_000).toISOString())}`)).json;
    expect(sched.installations.map((x: Json) => x.id)).toEqual([ids.job]);
  });

  it('runs start → hold → complete with the checklist; the order becomes installed', async () => {
    expect((await tech('POST', `/api/v1/installations/${ids.job}/complete`, {})).status).toBe(400);
    expect((await tech('POST', `/api/v1/installations/${ids.job}/start`)).status).toBe(200);
    const hold = await tech('POST', `/api/v1/installations/${ids.job}/hold`, { issueType: 'missing_parts', notes: 'Hinges missing from the box' });
    expect(hold.status, JSON.stringify(hold.json)).toBe(200);
    // the order owner hears about the exception
    expect((await api('GET', '/api/v1/notifications')).json.items.some((n: Json) => /on hold/.test(n.title))).toBe(true);
    expect((await crew('POST', `/api/v1/installations/${ids.job}/start`)).status).toBe(200);
    const incomplete = await tech('POST', `/api/v1/installations/${ids.job}/complete`, {});
    expect(incomplete.status).toBe(400);
    expect(incomplete.json.error.message).toMatch(/Assemble, Fix to wall/);
    expect((await tech('PUT', `/api/v1/installations/${ids.job}/checklist`, { items: [{ label: 'Assemble', done: true }, { label: 'Fix to wall', done: true }] })).status).toBe(200);
    expect((await tech('POST', `/api/v1/installations/${ids.job}/complete`, { notes: 'All good' })).status).toBe(200);
    const o = await order();
    expect(o.order.status).toBe('installed');
    expect(o.milestones.find((m: Json) => m.trigger === 'on_installation').status).toBe('due');
    const tok = (await api('GET', `/api/v1/installations/${ids.job}`)).json.installation.share_token;
    const pub = await h.call('GET', `/api/public/jobs/installation/${tok}`);
    expect(pub.json).toMatchObject({ status: 'completed', technician: 'Tara Tech', notes: 'All good' });
    expect((await h.call('POST', `/api/public/jobs/installation/${tok}/confirm`, { body: { name: 'Raj Mehta', rating: 4 } })).status).toBe(200);
    expect((await api('GET', `/api/v1/records/installation/${ids.job}`)).json.customer_rating).toBe(4);
  });
});

describe('service tickets', () => {
  it('SLA policies set due times; reporters are matched to contacts', async () => {
    expect((await api('POST', '/api/admin/sla-policies', { name: 'Bad', firstResponseMinutes: 60, resolutionMinutes: 30 })).status).toBe(400);
    expect((await api('POST', '/api/admin/sla-policies', { name: 'Urgent', priority: 'urgent', firstResponseMinutes: 30, resolutionMinutes: 240 })).status).toBe(201);
    expect((await api('POST', '/api/admin/sla-policies', { name: 'Standard', firstResponseMinutes: 240, resolutionMinutes: 2880 })).status).toBe(201);
    const t = await agent('POST', '/api/v1/records/ticket', { name: 'Wardrobe door misaligned', priority: 'urgent', category: 'installation', channel: 'phone', customer_phone: '98200 11111', sales_order_id: ids.order });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    ids.ticket = t.json.id;
    expect(t.json).toMatchObject({ status: 'new', contact_id: ids.contact, account_id: ids.acc });
    expect(t.json.ticket_number).toMatch(/^TK-/);
    const due = new Date(t.json.first_response_due).getTime();
    expect(Math.abs(due - (Date.now() + 30 * 60_000))).toBeLessThan(60_000);
    // lowering the priority moves the clock to the standard policy
    const u = await agent('PATCH', `/api/v1/records/ticket/${ids.ticket}`, { priority: 'normal' });
    expect(new Date(u.json.resolution_due).getTime() - new Date(t.json.created_at).getTime()).toBeCloseTo(2880 * 60_000, -4);
    expect((await agent('PATCH', `/api/v1/records/ticket/${ids.ticket}`, { first_response_due: new Date().toISOString() })).status).toBe(400);
  });

  it('a reply counts as first response; overdue tickets escalate once', async () => {
    await agent('POST', `/api/v1/records/ticket/${ids.ticket}/activities`, { kind: 'call', subject: 'Called customer', body: 'Visit booked for tomorrow' });
    const t = (await agent('GET', `/api/v1/records/ticket/${ids.ticket}`)).json;
    expect(t.first_responded_at).toBeTruthy();
    expect(t.status).toBe('open');
    // a second ticket nobody touches, already past its resolution time
    const late = await agent('POST', '/api/v1/records/ticket', { name: 'Billing question', category: 'billing' });
    await sql(`update tickets set first_response_due = now() - interval '1 minute' where id = $1`, [late.json.id]);
    await sweep();
    await sweep();
    const n = (await agent('GET', '/api/v1/notifications')).json.items.filter((x: Json) => x.kind === 'sla');
    expect(n.length).toBe(1);
    expect(n[0].title).toMatch(/^SLA breached: TK-/);
    expect((await agent('GET', `/api/v1/records/ticket/${late.json.id}`)).json.sla_breached).toBe(true);
  });

  it('the customer follows the ticket by link, replies and rates it', async () => {
    const link = (await agent('GET', `/api/v1/tickets/${ids.ticket}/link`)).json.link as string;
    const token = link.split('/t/')[1]!;
    const pub = await h.call('GET', `/api/public/tickets/${token}`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(pub.json).toMatchObject({ subject: 'Wardrobe door misaligned', status: 'open', resolution: null });
    expect((await h.call('POST', `/api/public/tickets/${token}`, { body: { rating: 5 } })).status).toBe(400); // not resolved yet
    await agent('PATCH', `/api/v1/records/ticket/${ids.ticket}`, { status: 'resolved', resolution: 'Door re-hung and aligned' });
    const resolved = (await agent('GET', `/api/v1/records/ticket/${ids.ticket}`)).json;
    expect(resolved.resolved_at).toBeTruthy();
    expect((await h.call('GET', `/api/public/tickets/${token}`)).json.resolution).toBe('Door re-hung and aligned');
    expect((await h.call('POST', `/api/public/tickets/${token}`, { body: { rating: 5, comment: 'Quick fix' } })).status).toBe(200);
    expect((await h.call('POST', `/api/public/tickets/${token}`, { body: { rating: 4 } })).status).toBe(400);
    // a reply after resolution reopens the ticket and pings the assignee
    expect((await h.call('POST', `/api/public/tickets/${token}`, { body: { message: 'The handle is loose now' } })).status).toBe(200);
    const re = (await agent('GET', `/api/v1/records/ticket/${ids.ticket}`)).json;
    expect([re.status, re.resolved_at, re.satisfaction]).toEqual(['open', null, 5]);
    expect((await agent('GET', '/api/v1/notifications')).json.items.some((x: Json) => /Customer replied/.test(x.title))).toBe(true);
    const ins = (await agent('GET', '/api/v1/insights/service')).json;
    expect(ins).toMatchObject({ open: 2, csat: 5 });
    expect(ins.byCategory.length).toBe(2);
  });

  it('web forms can raise tickets and hand back a status link', async () => {
    const f = await api('POST', '/api/admin/forms', { name: 'Complaints', objectKey: 'ticket', kind: 'public', layout: { sections: [{ fields: ['name', 'description', 'customer_name', 'customer_phone'] }] } });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    const sub = await h.call('POST', `/api/public/forms/${f.json.public_key}`, { body: { name: 'Sofa fabric torn', description: 'Seam opened after a week', customer_name: 'Raj', customer_phone: '9820011111' } });
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    expect(sub.json.statusUrl).toMatch(/^\/t\/[A-Za-z0-9_-]+$/);
    const t = (await api('GET', '/api/v1/records/ticket?q=Sofa')).json.items[0];
    expect(t).toMatchObject({ contact_id: ids.contact, status: 'new' });
  });
});
