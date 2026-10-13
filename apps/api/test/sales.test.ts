import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { computeLines } from '../src/services/quotes';
import { sweepTenant } from '../src/services/reminders';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let repId: string;
let ownerId: string;
let tenantId: string;
let dealId: string;
let accountId: string;
let contactId: string;
const products: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_sales');
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const u = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep One', password: PW, roles: ['sales_rep'] });
  repId = u.json.id;
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ownerId = me.user.id;
  tenantId = me.tenant.id;
  accountId = (await api('POST', '/api/v1/records/account', { name: 'Skyline Developers' })).json.id;
  contactId = (await api('POST', '/api/v1/records/contact', { first_name: 'Asha', last_name: 'Rao', email: 'asha@skyline.test', account_id: accountId })).json.id;
  dealId = (await api('POST', '/api/v1/records/deal', { name: 'Tower A fit-out', account_id: accountId, contact_id: contactId, amount: 100000 })).json.id;
}, 90_000);

describe('quote maths', () => {
  it('applies line discounts then GST, rounding to paise', () => {
    const c = computeLines([
      { name: 'Licence', quantity: 3, unitPrice: 1000, discountPct: 10, taxRate: 18 },
      { name: 'Setup', quantity: 1, unitPrice: 499.99, discountPct: 0, taxRate: 18 },
    ]);
    expect(c.subtotal).toBe(3499.99);
    expect(c.discountTotal).toBe(300);
    expect(c.lines[0]).toMatchObject({ lineSubtotal: 2700, lineTax: 486, lineTotal: 3186 });
    expect(c.taxTotal).toBe(576);
    expect(c.grandTotal).toBe(3775.99);
  });
});

describe('products and price books', () => {
  it('products are a standard object; price books hold per-product prices', async () => {
    const meta = (await api('GET', '/api/v1/meta')).json;
    expect(meta.objects.map((o: Json) => o.key)).toEqual(expect.arrayContaining(['product', 'quote']));
    for (const [name, price, tax] of [['CRM licence', 1000, 18], ['Onboarding', 25000, 18], ['Training day', 8000, 0]] as const) {
      const p = await api('POST', '/api/v1/records/product', { name, sku: name.toUpperCase().replace(/ /g, '-'), list_price: price, tax_rate: tax, unit: 'Nos' });
      expect(p.status, JSON.stringify(p.json)).toBe(201);
      products[name] = p.json.id;
    }
    // reps can read products but not create them
    expect((await rep('POST', '/api/v1/records/product', { name: 'Nope' })).status).toBe(403);
    expect((await rep('GET', '/api/v1/records/product')).json.items.length).toBe(3);

    const books = (await api('GET', '/api/v1/price-books')).json.items;
    const std = books.find((b: Json) => b.is_default);
    expect(std.name).toBe('Standard');
    const put = await api('PUT', `/api/v1/price-books/${std.id}/entries`, { entries: [{ productId: products['CRM licence'], unitPrice: 950 }, { productId: products['Onboarding'], unitPrice: 22000 }] });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const entries = (await api('GET', `/api/v1/price-books/${std.id}/entries`)).json.items;
    expect(entries.find((e: Json) => e.name === 'CRM licence').unit_price).toBe(950);
    expect(entries.find((e: Json) => e.name === 'Training day').unit_price).toBe(null);
    expect((await rep('PUT', `/api/v1/price-books/${std.id}/entries`, { entries: [] })).status).toBe(403);
    // a second book copied from the standard one
    const partner = await api('POST', '/api/v1/price-books', { name: 'Partner', copyFrom: std.id });
    expect((await api('GET', `/api/v1/price-books/${partner.json.id}/entries`)).json.items.filter((e: Json) => e.unit_price !== null).length).toBe(2);
  });
});

describe('quotes', () => {
  let quoteId: string;
  let token: string;

  it('are created from a deal with numbering, default price book and validity', async () => {
    const q = await api('POST', `/api/v1/quotes/from-deal/${dealId}`);
    expect(q.status, JSON.stringify(q.json)).toBe(201);
    quoteId = q.json.id;
    expect(q.json.quote_number).toMatch(/^Q-\d{4}-0001$/);
    expect(q.json.status).toBe('draft');
    expect(q.json.account_id).toBe(accountId);
    const full = (await api('GET', `/api/v1/quotes/${quoteId}`)).json;
    expect(full.quote.price_book_id).toBeTruthy();
    expect(full.account.name).toBe('Skyline Developers');
    const second = await api('POST', `/api/v1/quotes/from-deal/${dealId}`);
    expect(second.json.quote_number).toMatch(/-0002$/);
  });

  it('saves lines, recalculates totals and protects computed totals', async () => {
    const r = await api('PUT', `/api/v1/quotes/${quoteId}/lines`, {
      lines: [
        { productId: products['CRM licence'], name: 'CRM licence', quantity: 10, unitPrice: 950, discountPct: 5, taxRate: 18 },
        { productId: products['Onboarding'], name: 'Onboarding', quantity: 1, unitPrice: 22000, taxRate: 18 },
      ],
      billTo: { state: 'Karnataka', gstin: '29ABCDE1234F1Z5' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.lines.length).toBe(2);
    expect(r.json.quote.subtotal).toBe(31500);
    expect(r.json.quote.discount_total).toBe(475);
    expect(r.json.quote.tax_total).toBe(5584.5);
    expect(r.json.quote.grand_total).toBe(36609.5);
    expect(r.json.quote.bill_to.state).toBe('Karnataka');
    expect((await api('PATCH', `/api/v1/records/quote/${quoteId}`, { grand_total: 1 })).status).toBe(400);
    // quotes list like any object, filterable by status
    const f = encodeURIComponent(JSON.stringify([{ field: 'status', op: 'eq', value: 'draft' }]));
    expect((await api('GET', `/api/v1/records/quote?filters=${f}`)).json.items.length).toBe(2);
  });

  it('are shared by link; customers can view and accept once', async () => {
    const s = await api('POST', `/api/v1/quotes/${quoteId}/send`, {});
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    token = s.json.link.split('/q/')[1];
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect((await api('GET', `/api/v1/records/quote/${quoteId}`)).json.status).toBe('sent');

    const pub = await h.call('GET', `/api/public/quotes/${token}`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(pub.json.quote.grand_total).toBe(36609.5);
    expect(pub.json.lines[0]).not.toHaveProperty('productId');
    expect(pub.json.quote).not.toHaveProperty('owner_id');
    expect(pub.json.company.name).toBe('acme co');

    const acc = await h.call('POST', `/api/public/quotes/${token}/respond`, { body: { accept: true, name: 'Asha Rao', comment: 'Looks good' } });
    expect(acc.status, JSON.stringify(acc.json)).toBe(200);
    const q = (await api('GET', `/api/v1/records/quote/${quoteId}`)).json;
    expect([q.status, q.accepted_by]).toEqual(['accepted', 'Asha Rao']);
    expect((await h.call('POST', `/api/public/quotes/${token}/respond`, { body: { accept: false, name: 'Someone' } })).status).toBe(400);
    // accepted quotes are frozen; the deal timeline and the owner hear about it
    expect((await api('PUT', `/api/v1/quotes/${quoteId}/lines`, { lines: [] })).status).toBe(400);
    const tl = (await api('GET', `/api/v1/records/deal/${dealId}/timeline`)).json.items.map((x: Json) => x.subject);
    expect(tl.some((s: string) => /accepted by Asha Rao/.test(s))).toBe(true);
    const n = (await api('GET', '/api/v1/notifications')).json;
    expect(n.unread).toBeGreaterThan(0);
    expect(n.items[0].link).toBe(`/o/quote/${quoteId}`);
    // unknown or draft tokens are 404
    expect((await h.call('GET', '/api/public/quotes/nope-nope-nope-nope-nope')).status).toBe(404);
  });

  it('syncs the total to the deal and keeps reps to their own quotes', async () => {
    const r = await api('POST', `/api/v1/quotes/${quoteId}/sync-deal`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.amount).toBe(36609.5);
    expect((await rep('GET', `/api/v1/quotes/${quoteId}`)).status).toBe(404);
    const mine = await rep('POST', '/api/v1/records/quote', { name: 'Rep quote' });
    expect(mine.status).toBe(201);
    expect((await rep('GET', '/api/v1/records/quote')).json.items.map((x: Json) => x.name)).toEqual(['Rep quote']);
    expect((await rep('POST', `/api/v1/quotes/${mine.json.id}/send`, {})).status).toBe(400); // no lines yet
  });
});

describe('email templates', () => {
  it('render merge fields from the record and the sender; sharing needs admin', async () => {
    const list = (await api('GET', '/api/v1/email-templates?object=lead')).json.items.map((t: Json) => t.name);
    expect(list).toEqual(expect.arrayContaining(['First touch', 'Meeting follow-up']));
    expect(list).not.toContain('Quote sent');
    const t = await rep('POST', '/api/v1/email-templates', { name: 'Mine', subject: 'Hi {{first_name}}', body: '{{title}} at {{account_id}} — {{me.full_name}} ({{amount}})' });
    expect(t.status).toBe(201);
    expect((await rep('POST', '/api/v1/email-templates', { name: 'Team', subject: 's', body: 'b', isShared: true })).status).toBe(403);
    const r = await api('POST', '/api/v1/email-templates/render', { subject: 'Hi {{first_name}}', body: '{{name}} worth {{amount}} — {{me.full_name}}', object: 'deal', recordId: dealId });
    expect(r.json.subject).toBe('Hi Asha');
    expect(r.json.body).toBe('Tower A fit-out worth ₹36,609.50 — acme Owner');
    expect(r.json.to).toBe('asha@skyline.test');
    expect((await rep('GET', '/api/v1/email-templates')).json.items.some((x: Json) => x.name === 'Mine')).toBe(true);
    expect((await api('GET', '/api/v1/email-templates')).json.items.some((x: Json) => x.name === 'Mine')).toBe(false);
    const send = await api('POST', `/api/v1/records/deal/${dealId}/send-email`, { to: 'asha@skyline.test', subject: 'x', body: 'y' });
    expect(send.status).toBe(400);
    expect(send.json.error.message).toMatch(/Connect an email channel/);
  });
});

describe('calendar, reminders and notifications', () => {
  it('events are visible to owner and attendees; completing one logs the meeting', async () => {
    const start = new Date(Date.now() + 2 * 3600_000);
    const e = await rep('POST', '/api/v1/events', {
      title: 'Site visit — Tower A', kind: 'site_visit', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600_000).toISOString(),
      relatedObject: 'account', relatedId: accountId, reminderMinutes: 30, attendees: [{ userId: ownerId }, { email: 'asha@skyline.test', name: 'Asha' }],
    });
    expect(e.status, JSON.stringify(e.json)).toBe(201);
    expect(new Date(e.json.remind_at).getTime()).toBe(start.getTime() - 30 * 60_000);
    const range = `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 7 * 86_400_000).toISOString())}`;
    expect((await api('GET', `/api/v1/events?${range}`)).json.items.length).toBe(1);
    expect((await api('PATCH', `/api/v1/events/${e.json.id}`, { endsAt: new Date(start.getTime() - 1).toISOString() })).status).toBe(400);
    const done = await rep('PATCH', `/api/v1/events/${e.json.id}`, { status: 'done', outcome: 'Client approved the layout' });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    const tl = (await api('GET', `/api/v1/records/account/${accountId}/timeline`)).json.items;
    expect(tl.some((x: Json) => x.kind === 'meeting' && x.body === 'Client approved the layout')).toBe(true);
  });

  it('the sweep turns due reminders into notifications exactly once', async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    await api('POST', '/api/v1/events', { title: 'Demo call', startsAt: soon.toISOString(), endsAt: new Date(soon.getTime() + 1800_000).toISOString(), reminderMinutes: 15, attendees: [{ userId: repId }] });
    const t = await api('POST', '/api/v1/tasks', { title: 'Send brochure', assigneeId: repId, remindAt: new Date(Date.now() - 60_000).toISOString() });
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    const db = Db.fromEnv(h.env);
    try {
      const next = await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
      expect(next).toBe(null);
      await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
    } finally {
      await db.close();
    }
    const n = (await rep('GET', '/api/v1/notifications')).json;
    const titles = n.items.map((x: Json) => x.title);
    expect(titles.filter((x: string) => x === 'Reminder: Send brochure').length).toBe(1);
    expect(titles).toContain('Starting soon: Demo call');
    expect((await api('GET', '/api/v1/notifications')).json.items.some((x: Json) => x.title === 'Starting soon: Demo call')).toBe(true);
    await rep('POST', '/api/v1/notifications/read', {});
    expect((await rep('GET', '/api/v1/notifications')).json.unread).toBe(0);
  });
});

describe('forecast and quotas', () => {
  it('buckets deals by category per rep against quota', async () => {
    const meta = (await api('GET', '/api/v1/meta')).json;
    const stages = meta.pipelines.find((p: Json) => p.objectKey === 'deal').stages;
    const st = (k: string) => stages.find((s: Json) => s.key === k).id;
    const month = '2031-02-';
    await api('POST', '/api/v1/records/deal', { name: 'Won', amount: 500, close_date: `${month}10`, stage_id: st('closed_won'), owner_id: repId });
    await api('POST', '/api/v1/records/deal', { name: 'Negotiating', amount: 300, close_date: `${month}11`, stage_id: st('negotiation'), owner_id: repId });
    await api('POST', '/api/v1/records/deal', { name: 'Proposal', amount: 200, close_date: `${month}12`, stage_id: st('proposal'), owner_id: repId });
    await api('POST', '/api/v1/records/deal', { name: 'Early', amount: 100, close_date: `${month}13`, stage_id: st('prospecting'), owner_id: repId, forecast_category: 'commit' });
    await api('POST', '/api/v1/records/deal', { name: 'Lost', amount: 999, close_date: `${month}14`, stage_id: st('closed_lost'), owner_id: repId });
    await api('POST', '/api/v1/records/deal', { name: 'Next quarter', amount: 777, close_date: '2031-04-02', stage_id: st('proposal'), owner_id: repId });
    expect((await rep('PUT', '/api/v1/quotas', { quotas: [{ userId: repId, periodStart: '2031-01-01', amount: 1 }] })).status).toBe(403);
    expect((await api('PUT', '/api/v1/quotas', { quotas: [{ userId: repId, periodStart: '2031-01-01', amount: 1000 }, { userId: repId, periodStart: '2031-02-01', amount: 1000 }] })).status).toBe(200);
    expect((await api('PUT', '/api/v1/quotas', { quotas: [{ userId: repId, periodStart: '2031-02-15', amount: 1 }] })).status).toBe(400);

    const f = (await api('GET', '/api/v1/forecast?period=quarter&start=2031-02-01')).json;
    expect(f.from).toBe('2031-01-01');
    const r = f.reps.find((x: Json) => x.userId === repId);
    expect(r).toMatchObject({ quota: 2000, closed: 500, commit: 400, best_case: 200, pipeline: 0, lost: 999 });
    expect(r.weighted).toBe(500 + 300 * 0.75 + 200 * 0.5 + 100 * 0.1);
    const month2 = (await api('GET', '/api/v1/forecast?period=month&start=2031-04-01')).json;
    expect(month2.reps.find((x: Json) => x.userId === repId).best_case).toBe(777);
    const drill = (await api('GET', `/api/v1/forecast/deals?period=quarter&start=2031-01-01&category=commit&owner=${repId}`)).json.items.map((d: Json) => d.name).sort();
    expect(drill).toEqual(['Early', 'Negotiating']);
  });
});

describe('reports and dashboards', () => {
  it('summaries group, label and respect record visibility', async () => {
    const def = { type: 'summary', groupBy: 'stage_id', measure: { agg: 'sum', field: 'amount' }, filters: [{ field: 'close_date', op: 'gte', value: '2031-01-01' }] };
    const r = await api('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: def });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const byLabel = Object.fromEntries(r.json.rows.map((x: Json) => [r.json.labels.g1[x.g1], x.value]));
    expect(byLabel['Closed Won']).toBe(500);
    expect(byLabel['Proposal']).toBe(977);
    const byMonth = await api('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: { type: 'chart', chart: 'line', groupBy: 'close_date', dateBucket: 'month', measure: { agg: 'count' }, filters: [{ field: 'close_date', op: 'gte', value: '2031-01-01' }] } });
    expect(byMonth.json.rows.map((x: Json) => [x.g1, x.value])).toEqual([['2031-02-01', 5], ['2031-04-01', 1]]);
    const byOwner = await api('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: { type: 'chart', chart: 'pie', groupBy: 'owner_id', measure: { agg: 'count' } } });
    expect(Object.values(byOwner.json.labels.g1)).toEqual(expect.arrayContaining(['Rep One', 'acme Owner']));
    // reps only aggregate what they can read
    const repView = await rep('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: { type: 'summary', measure: { agg: 'count' } } });
    expect(repView.json.rows[0].value).toBe(6);
    expect((await api('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: { type: 'summary', groupBy: 'name', measure: { agg: 'sum', field: 'name' } } })).status).toBe(400);
    const table = await api('POST', '/api/v1/reports/run', { objectKey: 'deal', definition: { type: 'table', columns: ['name', 'amount'], sort: { field: 'amount', dir: 'desc' }, limit: 2 } });
    expect(table.json.items.map((x: Json) => x.name)).toEqual(['Tower A fit-out', 'Lost']);
  });

  it('saved reports and dashboards follow sharing rules', async () => {
    const rp = await api('POST', '/api/v1/reports', { name: 'Pipeline by stage', objectKey: 'deal', isShared: true, definition: { type: 'chart', chart: 'bar', groupBy: 'stage_id', measure: { agg: 'sum', field: 'amount' } } });
    expect(rp.status, JSON.stringify(rp.json)).toBe(201);
    const priv = await rep('POST', '/api/v1/reports', { name: 'My deals', objectKey: 'deal', definition: { type: 'summary', measure: { agg: 'count' } } });
    expect(priv.status).toBe(201);
    expect((await rep('POST', '/api/v1/reports', { name: 'x', objectKey: 'deal', isShared: true, definition: { type: 'summary' } })).status).toBe(403);
    expect((await rep('GET', '/api/v1/reports')).json.items.map((x: Json) => x.name).sort()).toEqual(['My deals', 'Pipeline by stage']);
    expect((await api('GET', '/api/v1/reports')).json.items.map((x: Json) => x.name)).toEqual(['Pipeline by stage']);
    const run = await rep('GET', `/api/v1/reports/${rp.json.id}/run`);
    expect(run.status).toBe(200);
    expect(run.json.result.kind).toBe('aggregate');
    expect((await rep('DELETE', `/api/v1/reports/${rp.json.id}`)).status).toBe(404);

    const d = await api('POST', '/api/v1/dashboards', { name: 'Sales overview', isShared: true, widgets: [{ reportId: rp.json.id, size: 'l' }] });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect((await rep('GET', '/api/v1/dashboards')).json.items.map((x: Json) => x.name)).toEqual(['Sales overview']);
    expect((await rep('PUT', `/api/v1/dashboards/${d.json.id}`, { name: 'Hijack', widgets: [] })).status).toBe(404);
  });
});
