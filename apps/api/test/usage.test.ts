/** Usage & costs: outside calls, requests, queries and tokens counted per workspace and day, priced, next to the bills in Books. */
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { classify, flushMeter, installMeter, meter, metered, takeCounts } from '../src/lib/meter';
import { vendorService } from '../src/services/usage';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await makeHarness('synapse_test_usage');
  // the outside world answers ok; the meter wraps whatever fetch is in place
  globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  installMeter();
  await h.signup('useco', 'owner@useco.test');
  api = h.as('useco', (await h.login('useco', 'owner@useco.test')).token);
  ids.tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
}, 120_000);

describe('usage metering', () => {
  it('knows the services by their address and what kind of call it is', () => {
    expect(classify('https://graph.facebook.com/v21.0/123/messages', JSON.stringify({ type: 'template' }))).toEqual({ provider: 'meta', kind: 'whatsapp_template' });
    expect(classify('https://graph.facebook.com/v21.0/123/messages', JSON.stringify({ type: 'text' }))).toEqual({ provider: 'meta', kind: 'whatsapp_message' });
    expect(classify('https://api.resend.com/emails')).toEqual({ provider: 'resend', kind: 'email' });
    expect(classify('https://api.razorpay.com/v1/transactions?count=10')).toEqual({ provider: 'razorpay', kind: 'bank_feed' });
    expect(classify('https://api.whitebooks.in/public/search')).toEqual({ provider: 'gst_api', kind: 'call' });
    expect(classify('https://cache.synapse.internal/x')).toBeNull();
    expect(vendorService('GitHub, Inc.')).toBe('github');
    expect(vendorService('Cloudflare, Inc.')).toBe('cloudflare');
  });

  it('counts a workspace’s calls, requests, queries and tokens, and prices them', async () => {
    const db = Db.fromEnv(h.env);
    try {
      const rows = await metered(ids.tenant!, async () => {
        await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: JSON.stringify({ type: 'template', template: { name: 'update' } }) });
        await fetch('https://graph.facebook.com/v21.0/123/messages', { method: 'POST', body: JSON.stringify({ type: 'template', template: { name: 'update' } }) });
        await fetch('https://api.resend.com/emails', { method: 'POST', body: '{}' });
        meter('ai:groq', 'input_tokens', { calls: 0, units: 2_000_000 });
        meter('ai:groq', 'output_tokens', { calls: 0, units: 1_000_000 });
        return takeCounts();
      });
      await flushMeter(db, rows);
    } finally {
      await db.close();
    }
    // some requests of its own
    await api('GET', '/api/v1/records/lead');
    const r = await api('GET', '/api/admin/costs?scope=workspace&months=3');
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    expect(r.json.services, JSON.stringify(r.json).slice(0, 600)).toBeTruthy();
    const svc = (k: string) => (r.json.services as Json[]).find((s) => s.key === k)!;
    expect(svc('meta').thisMonth).toMatchObject({ calls: 2, units: { whatsapp_template: 2 } });
    // ₹0.80 × 2 template messages
    expect(svc('meta').thisMonth.cost).toBeCloseTo(1.6, 5);
    // 2M input × $0.59 + 1M output × $0.79 = $1.97 × 88
    expect(svc('ai:groq').thisMonth.cost).toBeCloseTo(1.97 * 88, 5);
    expect(svc('workers').thisMonth.calls).toBeGreaterThan(2);
    expect(svc('neon').thisMonth.calls).toBeGreaterThan(5);
    expect(r.json.byMonth).toHaveLength(3);
  });

  it('platform admins see the whole platform and set the price list; bills come from Books', async () => {
    for (const a of ['orders', 'billing', 'purchasing', 'books']) await api('POST', `/api/admin/apps/${a}/enable`);
    const v = (await api('POST', '/api/v1/records/vendor', { name: 'GitHub, Inc.' })).json.id;
    const b = await api('POST', '/api/v1/records/bill', { name: 'GitHub Team', vendor_id: v, vendor_ref: 'GH-1', bill_date: new Date().toISOString().slice(0, 10) });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    await api('PUT', `/api/v1/books/bills/${b.json.id}/lines`, { lines: [{ name: 'GitHub Team (2 seats)', hsnSac: '998315', quantity: 1, unitPrice: 704, taxRate: 0 }] });
    const p = await api('GET', '/api/admin/costs?scope=platform');
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.platformAdmin).toBe(true);
    expect(p.json.bills.map((x: Json) => [x.vendor, x.service])).toEqual([['GitHub, Inc.', 'github']]);
    expect(p.json.workspaces.find((w: Json) => w.tenant_key === ids.tenant).calls).toBeGreaterThanOrEqual(3);
    // the Workers plan fee is in every month's estimate
    expect(p.json.byMonth[0].estimate).toBeGreaterThanOrEqual(440);
    const prices = p.json.prices;
    prices.services.meta.units.whatsapp_template.price = 0.12;
    prices.services.neon.monthly = 19;
    expect((await api('PUT', '/api/admin/costs/prices', prices)).status).toBe(200);
    const p2 = (await api('GET', '/api/admin/costs?scope=platform')).json;
    expect((p2.services as Json[]).find((s) => s.key === 'meta')!.thisMonth.cost).toBeCloseTo(0.24, 5);
    expect((p2.services as Json[]).find((s) => s.key === 'neon')!.thisMonth.cost).toBeGreaterThanOrEqual(19 * 88);
  });
});
