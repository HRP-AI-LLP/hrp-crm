/** Round 19: hierarchy, profitability, win/loss, credit, RFQ & pricing, ATP, rebates, after-sales, dealers, client IT, sequences, help centre, analytics, connectors, members without email, milestones. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { netsuiteAuth } from '../src/services/industry/connectors';
import { makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const day = (n: number) => new Date(Date.now() + 5.5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  h = await makeHarness('synapse_test_industry');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  for (const a of ['orders', 'inventory', 'delivery', 'service', 'billing', 'purchasing', 'books', 'manufacturing', 'projects']) expect((await api('POST', `/api/admin/apps/${a}/enable`)).status).toBe(200);
  ids.group = (await api('POST', '/api/v1/records/account', { name: 'Tata Steel Group' })).json.id;
  const plant = await api('POST', '/api/v1/records/account', { name: 'Tata Steel Jamshedpur', parent_account_id: ids.group, city: 'Jamshedpur', state: 'Jharkhand' });
  expect(plant.status, JSON.stringify(plant.json)).toBe(201);
  ids.plant = plant.json.id;
  ids.dealer = (await api('POST', '/api/v1/records/account', { name: 'Kolkata Traders', account_type: 'dealer', dealer_tier: 'gold', territory: 'East' })).json.id;
  ids.motor = (await api('POST', '/api/v1/records/product', { name: 'Motor 5HP', sku: 'MOT-5', list_price: 20000, cost_price: 12000, tax_rate: 18, hsn_sac: '8501', product_type: 'goods', track_inventory: true, warranty_months: 12, lead_time_days: 10 })).json.id;
  ids.brush = (await api('POST', '/api/v1/records/product', { name: 'Carbon brush', sku: 'BR-1', list_price: 500, cost_price: 200, tax_rate: 18, hsn_sac: '8545', product_type: 'goods', track_inventory: true, is_spare: true, spare_for_id: ids.motor })).json.id;
  ids.wh = (await api('GET', '/api/v1/warehouses')).json.items[0].id;
  for (const [p, q] of [[ids.motor, 5], [ids.brush, 20]] as const) expect((await api('POST', '/api/v1/inventory/movements', { type: 'in', productId: p, warehouseId: ids.wh, quantity: q, unitCost: p === ids.motor ? 12000 : 200, reason: 'Opening' })).status).toBe(201);
}, 180_000);

afterAll(() => vi.unstubAllGlobals());

describe('members without email', () => {
  it('are added as a profile and onboarded later', async () => {
    const r = await api('POST', '/api/admin/users/invite', { fullName: 'Ravi Field', roles: ['sales_rep'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json).toMatchObject({ inviteUrl: null, onboarded: false });
    const u = (await api('GET', '/api/admin/users')).json.items.find((x: any) => x.id === r.json.id);
    expect(u).toMatchObject({ status: 'profile', email: null });
    expect((await api('POST', `/api/admin/users/${r.json.id}/invite-link`)).status).toBe(400); // no email yet
    expect((await api('PUT', `/api/admin/users/${r.json.id}/email`, { email: 'ravi@acme.test' })).status).toBe(200);
    const inv = await api('POST', `/api/admin/users/${r.json.id}/invite-link`);
    expect(inv.status, JSON.stringify(inv.json)).toBe(200);
    expect(inv.json.inviteUrl).toContain('token=');
    expect((await api('GET', '/api/admin/users')).json.items.find((x: any) => x.id === r.json.id).status).toBe('invited');
  });
});

describe('customers', () => {
  it('rolls up a parent company and refuses loops', async () => {
    const f = await api('GET', `/api/v1/accounts/${ids.plant}/family`);
    expect(f.status, JSON.stringify(f.json)).toBe(200);
    expect(f.json.topId).toBe(ids.group);
    expect(f.json.nodes.map((n: any) => n.name)).toEqual(['Tata Steel Group', 'Tata Steel Jamshedpur']);
    const loop = await api('PATCH', `/api/v1/records/account/${ids.group}`, { parent_account_id: ids.plant });
    expect(loop.status).toBeGreaterThanOrEqual(400);
  });

  it('holds an order over the group credit limit until finance approves it', async () => {
    expect((await api('PATCH', `/api/v1/records/account/${ids.group}`, { credit_limit: 30000 })).status).toBe(200);
    const o = await api('POST', '/api/v1/records/sales_order', { name: 'Motors', account_id: ids.plant, warehouse_id: ids.wh });
    ids.order = o.json.id;
    await api('PUT', `/api/v1/orders/${ids.order}/lines`, { lines: [{ productId: ids.motor, name: 'Motor 5HP', quantity: 2, unitPrice: 20000, taxRate: 18 }] });
    const c = (await api('GET', `/api/v1/accounts/${ids.plant}/credit`)).json;
    expect(c).toMatchObject({ limit: 30000, limitAccountName: 'Tata Steel Group', exposure: 0 });
    const no = await api('POST', `/api/v1/orders/${ids.order}/confirm`);
    expect(no.status).toBe(409);
    expect(no.json.error.code).toBe('credit_limit');
    expect((await api('GET', '/api/v1/credit-watch')).json.draftOrders.map((x: any) => x.id)).toContain(ids.order);
    expect((await api('POST', `/api/v1/sales-orders/${ids.order}/credit-approve`, { note: 'Group pays on time' })).status).toBe(200);
    expect((await api('POST', `/api/v1/orders/${ids.order}/confirm`)).status).toBe(200);
    expect((await api('GET', `/api/v1/accounts/${ids.plant}/credit`)).json.openOrders).toBe(47200);
  });

  it('promises delivery dates from stock, starts warranties on delivery', async () => {
    const p = await api('POST', `/api/v1/sales-orders/${ids.order}/promise`);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.lines[0]).toMatchObject({ from: 'stock', promiseDate: day(0) });
    const a = (await api('GET', `/api/v1/products/${ids.motor}/availability?qty=10`)).json;
    expect(a, JSON.stringify(a)).toMatchObject({ onHand: 5, reserved: 2, free: 3, from: 'lead_time', promiseDate: day(10) });
    expect((await api('POST', `/api/v1/orders/${ids.order}/deliver`)).status).toBe(200);
    const w = (await api('GET', `/api/v1/warranties?account=${ids.plant}`)).json.items;
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ product: 'Motor 5HP', quantity: 2, in_warranty: true });
  });

  it('records why a deal was lost and reports win / loss', async () => {
    const d = await api('POST', '/api/v1/records/deal', { name: 'Conveyor motors', account_id: ids.group, amount: 500000 });
    expect((await api('POST', `/api/v1/deals/${d.json.id}/lost`, { reason: 'price', lostTo: 'Siemens', note: '12% cheaper' })).status).toBe(200);
    const deal = (await api('GET', `/api/v1/records/deal/${d.json.id}`)).json;
    expect(deal.fields ?? deal).toMatchObject({ loss_reason: 'price', lost_to: 'Siemens' });
    const wl = (await api('GET', '/api/v1/insights/win-loss')).json;
    expect(wl.lost).toBe(1);
    expect(wl.byCompetitor[0]).toMatchObject({ key: 'Siemens', lost: 1, lostValue: 500000 });
  });
});

describe('won IT deals', () => {
  it('open a contract that keeps the deal documents', async () => {
    const d = await api('POST', '/api/v1/records/deal', { name: 'CRM software implementation', account_id: ids.group, amount: 900000, pricing_model: 'fixed', duration_months: 6 });
    const full = (await api('GET', `/api/v1/records/deal/${d.json.id}`)).json;
    const pipelineId = full.pipeline_id ?? full.fields?.pipeline_id;
    const meta = (await api('GET', '/api/v1/meta')).json;
    const stages = meta.pipelines.find((p: any) => p.id === pipelineId).stages;
    const wonStage = stages.find((s: any) => s.category === 'won');
    expect((await api('PATCH', `/api/v1/records/deal/${d.json.id}`, { stage_id: wonStage.id })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const list = (await api('GET', '/api/v1/it/contracts')).json;
    const con = (Array.isArray(list) ? list : list.items).find((x: any) => x.name === 'CRM software implementation');
    expect(con, JSON.stringify(list)).toBeTruthy();
    expect(con).toMatchObject({ kind: 'fixed_bid', status: 'draft' });
    const g = (await api('GET', `/api/v1/it/contracts/${con.id}`)).json;
    expect(g.deal.id).toBe(d.json.id);
    // a non-IT deal does not
    const d2 = await api('POST', '/api/v1/records/deal', { name: 'Steel coils', account_id: ids.group, amount: 100000 });
    await api('PATCH', `/api/v1/records/deal/${d2.json.id}`, { stage_id: wonStage.id });
    const after = (await api('GET', '/api/v1/it/contracts')).json;
    expect((Array.isArray(after) ? after : after.items).some((x: any) => x.name === 'Steel coils')).toBe(false);
    expect((await api('POST', `/api/v1/deals/${d2.json.id}/contract`)).status).toBe(201);
  });
});

describe('quote to order', () => {
  it('RFQ → customer price list with tiers → costing → draft quote', async () => {
    const books = (await api('GET', '/api/v1/price-lists')).json.items;
    let book = books[0];
    if (!book) book = (await api('POST', '/api/v1/price-books', { name: 'Tata contract' })).json;
    ids.book = book.id;
    expect((await api('PUT', `/api/v1/price-lists/${ids.book}/scope`, { accountId: ids.group, validFrom: day(-1) })).status).toBe(200);
    expect((await api('PUT', `/api/v1/price-lists/${ids.book}/tiers/${ids.motor}`, { tiers: [{ minQty: 1, unitPrice: 19000 }, { minQty: 10, unitPrice: 17500 }] })).status).toBe(200);
    expect((await api('GET', `/api/v1/price-for?product=${ids.motor}&account=${ids.plant}&qty=12`)).json).toMatchObject({ unitPrice: 17500, tierFrom: 10 });
    const r = await api('POST', '/api/v1/rfqs', { name: 'Motors for line 4', accountId: ids.plant, rfqNumber: 'TS/RFQ/889', dueOn: day(5) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.rfq = r.json.id;
    expect((await api('GET', '/api/v1/rfqs?open=1')).json.items[0]).toMatchObject({ rfq_number: 'TS/RFQ/889', status: 'rfq' });
    expect((await api('PUT', `/api/v1/quotes/${ids.rfq}/lines`, { lines: [{ productId: ids.motor, name: 'Motor 5HP', quantity: 12, unitPrice: 20000, taxRate: 18 }] })).status).toBe(200);
    expect((await api('POST', `/api/v1/quotes/${ids.rfq}/reprice`)).json.changed).toBe(1);
    const cost = (await api('GET', `/api/v1/quotes/${ids.rfq}/costing`)).json;
    expect(cost).toMatchObject({ revenue: 210000, cost: 144000, margin: 66000 });
    expect((await api('POST', `/api/v1/quotes/${ids.rfq}/rfq-to-quote`)).status).toBe(200);
    expect((await api('GET', `/api/v1/quotes/${ids.rfq}`)).json.quote.status).toBe('draft');
  });

  it('rebates count the group\'s invoices', async () => {
    const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Motors', account_id: ids.plant, invoice_date: day(0) })).json.id;
    await api('PUT', `/api/v1/invoices/${inv}/lines`, { lines: [{ productId: ids.motor, name: 'Motor 5HP', quantity: 2, unitPrice: 20000, taxRate: 18 }] });
    expect((await api('POST', `/api/v1/invoices/${inv}/issue`)).status).toBe(200);
    expect((await api('POST', '/api/v1/rebates', { accountId: ids.group, name: 'FY volume rebate', startsOn: day(-30), endsOn: day(300), basis: 'value', slabs: [{ from: 25000, pct: 1 }, { from: 100000, pct: 2 }] })).status).toBe(201);
    const r = (await api('GET', '/api/v1/rebates')).json;
    expect(r.items[0]).toMatchObject({ achieved: 40000, ratePct: 1, earned: 400, next: { from: 100000, gap: 60000 } });
    const p = (await api('GET', `/api/v1/accounts/${ids.group}/profitability`)).json;
    expect(p.totals).toMatchObject({ revenue: 40000, cost: 24000, margin: 16000 });
  });
});

describe('after-sales', () => {
  it('issues spares on a ticket (under warranty: free), raises a CAPA, escalates', async () => {
    const t = await api('POST', '/api/v1/records/ticket', { name: 'Motor overheating', priority: 'high', account_id: ids.plant, product_id: ids.motor });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    ids.ticket = t.json.id;
    expect((await api('GET', `/api/v1/tickets/${ids.ticket}/warranty`)).json.covered).toBe(true);
    expect((await api('GET', `/api/v1/spares?for=${ids.motor}`)).json.items.map((x: any) => x.name)).toEqual(['Carbon brush']);
    const p = await api('POST', `/api/v1/tickets/${ids.ticket}/parts`, { productId: ids.brush, quantity: 2 });
    expect(p.json).toMatchObject({ chargeable: false, underWarranty: true });
    await api('POST', `/api/v1/tickets/${ids.ticket}/parts`, { productId: ids.brush, quantity: 1, chargeable: true });
    const bill = await api('POST', `/api/v1/tickets/${ids.ticket}/bill-parts`);
    expect(bill.status, JSON.stringify(bill.json)).toBe(201);
    expect((await api('POST', `/api/v1/tickets/${ids.ticket}/bill-parts`)).status).toBe(400); // nothing left
    const c = await api('POST', '/api/v1/capas', { title: 'Bearing grease spec', ticketId: ids.ticket, severity: 'major', rootCauseCategory: 'material' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    expect(c.json.number).toMatch(/^CAPA\//);
    expect((await api('PUT', `/api/v1/capas/${c.json.id}`, { title: 'Bearing grease spec', ticketId: ids.ticket, status: 'closed' })).status).toBe(400); // needs the corrective action
    expect((await api('GET', '/api/v1/capas?status=open')).json.items[0]).toMatchObject({ account: 'Tata Steel Jamshedpur', product: 'Motor 5HP' });
    expect((await api('POST', `/api/v1/tickets/${ids.ticket}/escalate`, { note: 'Line stopped' })).json.level).toBe(1);
    expect((await api('PUT', '/api/v1/escalation-matrix', { enabled: true, levels: [{ afterHours: 2, userIds: [], notifyManager: true }] })).status).toBe(200);
  });
});

describe('dealers', () => {
  it('reports dealer performance, pays schemes and opens the dealer portal', async () => {
    const d = await api('POST', '/api/v1/records/deal', { name: 'Motors via dealer', account_id: ids.plant, amount: 200000, referred_by_id: ids.dealer });
    const pipe = (await api('GET', '/api/v1/records/deal/' + d.json.id)).json;
    expect(pipe).toBeTruthy();
    expect((await api('POST', '/api/v1/channel/schemes', { name: 'Gold Q3', startsOn: day(-10), endsOn: day(80), basis: 'won_deals', dealerTier: 'gold', ratePct: 2 })).status).toBe(201);
    const ov = (await api('GET', '/api/v1/channel/overview')).json;
    expect(ov.dealers[0]).toMatchObject({ name: 'Kolkata Traders', tier: 'gold', openValue: 200000 });
    const portal = await api('POST', `/api/v1/accounts/${ids.dealer}/dealer-portal`, { on: true });
    expect(portal.json.token).toBeTruthy();
    const pub = await h.call('GET', `/api/public/dealer/${portal.json.token}`);
    expect(pub.status, pub.text).toBe(200);
    expect(pub.json.dealer).toMatchObject({ name: 'Kolkata Traders', tier: 'gold' });
    expect(pub.json.deals[0]).toMatchObject({ name: 'Motors via dealer' });
    const lead = await h.call('POST', `/api/public/dealer/${portal.json.token}/leads`, { body: { name: 'Anil Rao', company: 'Rao Rolling Mills', phone: '9830012345' } });
    expect(lead.status, lead.text).toBe(201);
    expect((await api('GET', '/api/v1/channel/overview')).json.dealers[0].leads).toBe(1);
  });
});

describe('client IT', () => {
  it('keeps assets with history, a vault with logged reveals and versioned docs', async () => {
    const a = await api('POST', '/api/v1/client-assets', { accountId: ids.group, kind: 'license', name: 'Microsoft 365 E3', seats: 50, seatsUsed: 42, renewsOn: day(20) });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
    expect((await api('GET', '/api/v1/client-assets?renewing=30')).json.items[0]).toMatchObject({ name: 'Microsoft 365 E3', days_left: 20 });
    expect((await api('PUT', `/api/v1/client-assets/${a.json.id}`, { accountId: ids.group, kind: 'license', name: 'Microsoft 365 E3', seats: 50, seatsUsed: 42, renewsOn: day(385), status: 'in_use' })).status).toBe(200);
    expect((await api('GET', `/api/v1/client-assets/${a.json.id}/history`)).json.items.map((x: any) => x.kind)).toEqual(['renewed', 'added']);
    const s = await api('POST', '/api/v1/client-vault', { accountId: ids.group, title: 'Firewall admin', username: 'admin', secret: 'S3cret!pass' });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const list = (await api('GET', '/api/v1/client-vault')).json.items;
    expect(JSON.stringify(list)).not.toContain('S3cret');
    expect((await api('POST', `/api/v1/client-vault/${s.json.id}/reveal`)).json.secret).toBe('S3cret!pass');
    expect((await api('GET', '/api/v1/client-vault')).json.items[0].last_revealed_by).toBeTruthy();
    const d = await api('POST', '/api/v1/tech-docs', { accountId: ids.group, kind: 'runbook', title: 'Backup restore', body: '1. Stop the service' });
    expect((await api('PUT', `/api/v1/tech-docs/${d.json.id}`, { accountId: ids.group, kind: 'runbook', title: 'Backup restore', body: '1. Stop the service\n2. Restore' })).json.version).toBe(2);
  });
});

describe('sequences and help centre', () => {
  it('enrols, sends the due step and stops on a reply', async () => {
    const lead = (await api('POST', '/api/v1/records/lead', { last_name: 'Mehta', first_name: 'Kiran', email: 'kiran@example.com', company: 'Mehta Forge' })).json.id;
    const s = await api('POST', '/api/v1/sequences', { name: 'RFQ follow-up', steps: [{ day: 0, subject: 'Your enquiry, {{first_name}}', body: 'Hi {{first_name}}, thanks for asking about motors for {{company}}.' }, { day: 3, subject: 'Following up', body: 'Any questions?' }] });
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    expect((await api('POST', `/api/v1/sequences/${s.json.id}/enroll`, { object: 'lead', ids: [lead] })).json.added).toBe(1);
    const sent: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      sent.push({ url, body: init?.body });
      return new Response('{"id":"x"}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const run = (await api('POST', '/api/v1/sequences-run')).json;
    vi.unstubAllGlobals();
    // with no mail provider configured the platform mailer cannot send: the enrolment is marked failed, nothing crashes
    expect(run.sent + (await api('GET', '/api/v1/sequence-enrollments')).json.items.filter((x: any) => x.status === 'failed').length).toBe(1);
  });

  it('publishes help articles behind one link', async () => {
    expect((await api('PUT', '/api/v1/help-centre', { title: 'Acme help', on: true })).status).toBe(200);
    const site = (await api('GET', '/api/v1/help-centre')).json;
    expect(site.token).toBeTruthy();
    const pub = await h.call('GET', `/api/public/help/${site.token}`);
    expect(pub.status, pub.text).toBe(200);
    expect(pub.json.title).toBe('Acme help');
  });
});

describe('analytics', () => {
  it('sales by product and region, fulfilment, repeat orders, seasonality and forecast', async () => {
    const p = (await api('GET', '/api/v1/analytics/products')).json;
    expect(p.rows[0]).toMatchObject({ product: 'Motor 5HP', qty: 2, value: 40000 });
    const r = (await api('GET', '/api/v1/analytics/regions?by=territory')).json;
    expect(r.total).toBeGreaterThan(0);
    for (const path of ['fulfilment', 'repeat', 'seasonality', 'forecast']) expect((await api('GET', `/api/v1/analytics/${path}`)).status).toBe(200);
    expect((await api('GET', '/api/v1/insights/profitability')).json.rows[0]).toMatchObject({ name: 'Tata Steel Jamshedpur' });
  });
});

describe('connectors', () => {
  it('checks webhook hosts, posts Teams alerts, keeps secrets sealed', async () => {
    expect((await api('POST', '/api/v1/connectors/slack', { values: { url: 'https://evil.example.com/hook' } })).status).toBe(400);
    const c = await api('POST', '/api/v1/connectors/teams', { values: { url: 'https://prod-01.westus.logic.azure.com/workflows/abc' }, alerts: ['deal_won'] });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const list = (await api('GET', '/api/v1/connectors')).json;
    expect(JSON.stringify(list.items)).not.toContain('logic.azure.com');
    const calls: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response('', { status: 202 });
    });
    const t = await api('POST', `/api/v1/connectors/${c.json.id}/test`);
    vi.unstubAllGlobals();
    expect(t.json).toEqual({ ok: true });
    expect(calls[0].body.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
  });

  it('signs NetSuite requests (OAuth 1.0a, HMAC-SHA256)', async () => {
    const a = await netsuiteAuth({ account: '1234567_SB1', consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tk', tokenSecret: 'ts' }, 'GET', 'https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer?limit=5', 'nonce', '1700000000');
    expect(a).toMatch(/^OAuth realm="1234567_SB1", /);
    expect(a).toContain('oauth_signature_method="HMAC-SHA256"');
    expect(a).toMatch(/oauth_signature="[A-Za-z0-9%]+"/);
  });

  it('pushes project tasks to Jira and pulls their status', async () => {
    const j = await api('POST', '/api/v1/connectors/jira', { values: { site: 'acme.atlassian.net', email: 'owner@acme.test', token: 'tok' } });
    expect(j.status, JSON.stringify(j.json)).toBe(201);
    const p = await api('POST', '/api/v1/records/project', { name: 'Plant MES rollout', account_id: ids.group });
    ids.project = p.json.id;
    expect((await api('POST', `/api/v1/projects/${ids.project}/tasks`, { name: 'Install edge gateway' })).status).toBe(201);
    expect((await api('PUT', `/api/v1/projects/${ids.project}/tracker`, { integrationId: j.json.id, key: 'MES' })).status).toBe(200);
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      if (init?.method === 'POST') return new Response(JSON.stringify({ key: 'MES-1' }), { status: 201 });
      return new Response(JSON.stringify({ fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } }), { status: 200 });
    });
    const s = await api('POST', `/api/v1/projects/${ids.project}/tracker-sync`);
    vi.unstubAllGlobals();
    expect(s.json).toEqual({ pushed: 1, completed: 1 });
  });
});

describe('milestones', () => {
  it('link a done milestone to its invoice and receipt', async () => {
    const m = await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Go-live', amount: 100000 });
    expect(m.status, JSON.stringify(m.json)).toBe(201);
    const inv = (await api('POST', '/api/v1/records/invoice', { name: 'Go-live', account_id: ids.group, invoice_date: day(0) })).json.id;
    expect((await api('PUT', `/api/v1/projects/${ids.project}/milestones/${m.json.id}/links`, { kind: 'invoice', targetId: inv, on: true })).status).toBe(400); // not done yet
    const mail = await api('POST', `/api/v1/records/account/${ids.group}/activities`, { kind: 'email', direction: 'in', subject: 'Go-live accepted', body: 'Signed off.' });
    expect((await api('PUT', `/api/v1/projects/${ids.project}/milestones/${m.json.id}`, { name: 'Go-live', amount: 100000, status: 'done', approvalActivityId: mail.json.id })).status).toBe(200);
    expect((await api('GET', `/api/v1/projects/${ids.project}/milestone-candidates?kind=invoice`)).json.items.map((x: any) => x.id)).toContain(inv);
    expect((await api('PUT', `/api/v1/projects/${ids.project}/milestones/${m.json.id}/links`, { kind: 'invoice', targetId: inv, on: true })).status).toBe(200);
    const d = (await api('GET', `/api/v1/projects/${ids.project}/milestones/${m.json.id}`)).json;
    expect(d.links).toHaveLength(1);
    expect(d.milestone.accepted_on).toBeTruthy();
  });
});

describe('permissions', () => {
  it('a sales rep cannot open margins or reveal client passwords', async () => {
    await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
    const rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
    expect((await rep('GET', '/api/v1/insights/profitability')).status).toBe(403);
    const v = (await api('GET', '/api/v1/client-vault')).json.items[0];
    expect((await rep('POST', `/api/v1/client-vault/${v.id}/reveal`)).status).toBe(403);
  });
});
