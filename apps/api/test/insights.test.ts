import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { periodRange } from '../src/services/kpis';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let repId = '';

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_insights');
  await h.signup('kitch', 'owner@kitch.test');
  api = h.as('kitch', (await h.login('kitch', 'owner@kitch.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  repId = (await api('POST', '/api/admin/users', { email: 'rep@kitch.test', fullName: 'Rina Rep', password: PW, roles: ['sales_rep'] })).json.id;
  rep = h.as('kitch', (await h.login('kitch', 'rep@kitch.test')).token);
});

describe('industry solutions', () => {
  it('lists the solutions', async () => {
    const r = await api('GET', '/api/admin/solutions');
    expect(r.json.items.map((s: Json) => s.key)).toEqual(['interiors', 'modular', 'solar', 'fabrication', 'signage']);
    expect((await rep('GET', '/api/admin/solutions')).status).toBe(403);
  });

  it('installs modular kitchens: fields, pipeline, apps, payment plan, checklist and targets', async () => {
    const r = await api('POST', '/api/admin/solutions/modular/install', {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.appsSwitchedOn).toEqual(expect.arrayContaining(['orders', 'delivery', 'billing', 'service', 'inventory', 'purchasing']));
    expect(r.json.appsSwitchedOn.indexOf('orders')).toBeLessThan(r.json.appsSwitchedOn.indexOf('delivery'));
    const meta = (await api('GET', '/api/v1/meta')).json;
    const lead = meta.objects.find((o: Json) => o.key === 'lead');
    expect(lead.fields.map((f: Json) => f.key)).toEqual(expect.arrayContaining(['kitchen_layout', 'finish', 'budget_band']));
    expect(meta.pipelines.some((p: Json) => p.name === 'Modular orders')).toBe(true);
    const st = (await sql(`select settings from tenants where id = $1`, [tenantId]))[0]!.settings;
    expect(st.industry).toBe('modular');
    expect(st.orders.milestonePlan.map((m: Json) => m.percent)).toEqual([50, 40, 10]);
    expect(st.installation.checklist.length).toBe(7);
    expect((await sql(`select count(*)::int as n from kpi_targets`))[0]!.n).toBeGreaterThan(5);
    // installing again keeps customisations
    await sql(`update tenants set settings = jsonb_set(settings, '{orders,milestonePlan}', '[{"name":"Full","percent":100,"trigger":"on_confirmation"}]') where id = $1`, [tenantId]);
    expect((await api('POST', '/api/admin/solutions/modular/install', {})).json.milestonePlan).toBe(false);
    expect((await api('POST', '/api/admin/solutions/modular/install', { overwrite: true })).json.milestonePlan).toBe(true);
    const list = await api('GET', '/api/admin/solutions');
    expect(list.json.items.find((s: Json) => s.key === 'modular').installed).toBe(true);
  });

  it('applies the payment plan to new orders', async () => {
    const acc = (await api('POST', '/api/v1/records/account', { name: 'Mehta Home', state: 'Gujarat' })).json.id;
    const deal = (await api('POST', '/api/v1/records/deal', { name: 'Mehta kitchen', account_id: acc, amount: 300000 })).json.id;
    const quote = (await api('POST', `/api/v1/quotes/from-deal/${deal}`)).json.id;
    await api('PUT', `/api/v1/quotes/${quote}/lines`, { lines: [{ name: 'L-shaped kitchen', quantity: 1, unitPrice: 254237, taxRate: 18 }], billTo: { state: 'Gujarat' } });
    const sent = await api('POST', `/api/v1/quotes/${quote}/send`, {});
    await h.call('POST', `/api/public/quotes/${sent.json.link.split('/q/')[1]}/respond`, { body: { accept: true, name: 'Mr Mehta' } });
    const o = await api('POST', `/api/v1/orders/from-quote/${quote}`);
    expect(o.status, JSON.stringify(o.json)).toBe(201);
    const full = (await api('GET', `/api/v1/orders/${o.json.id}`)).json;
    expect(full.milestones.map((m: Json) => [m.name, m.percent, m.trigger])).toEqual([
      ['Advance', 50, 'on_confirmation'],
      ['Before dispatch', 40, 'before_dispatch'],
      ['After installation', 10, 'on_installation'],
    ]);
    expect(full.milestonePlan).toHaveLength(3);
  });
});

describe('business health', () => {
  it('computes lead, sales and engagement KPIs over what the viewer can see', async () => {
    const mk = async (body: Json, minutesToTouch: number | null) => {
      const id = (await api('POST', '/api/v1/records/lead', body)).json.id;
      if (minutesToTouch !== null) {
        await sql(`insert into activities (tenant_id, kind, subject, direction, related_object, related_id, occurred_at) select $1, 'call', 'Called', 'out', 'lead', id, created_at + make_interval(mins => $3) from leads where id = $2`, [tenantId, id, minutesToTouch]);
      }
      return id;
    };
    await mk({ last_name: 'A', source: 'referral' }, 10);
    await mk({ last_name: 'B', source: 'website' }, 20);
    await mk({ last_name: 'C', source: 'architect' }, 30);
    await mk({ last_name: 'D', source: 'website', owner_id: repId }, null);
    const stages = (await api('GET', '/api/v1/meta')).json.pipelines.find((p: Json) => p.objectKey === 'deal' && p.isDefault).stages as Json[];
    const won = stages.find((s) => s.category === 'won')!.id;
    const lost = stages.find((s) => s.category === 'lost')!.id;
    for (const [amt, stage] of [[100000, won], [300000, won], [50000, lost]] as const) {
      const d = (await api('POST', '/api/v1/records/deal', { name: `Deal ${amt}`, amount: amt })).json.id;
      expect((await api('PATCH', `/api/v1/records/deal/${d}`, { stage_id: stage })).status).toBe(200);
    }
    const r = await api('GET', '/api/v1/kpis?period=this_month');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const k = Object.fromEntries((r.json.items as Json[]).map((i) => [i.key, i]));
    expect(k.leads_new.value).toBe(4);
    expect(k.lead_response_minutes.value).toBe(20);
    expect(k.referral_share.value).toBe(50);
    expect(k.win_rate.value).toBe(66.7);
    expect(k.revenue_won.value).toBe(400000);
    expect(k.avg_deal_size.value).toBe(200000);
    // the solution's targets are judged
    expect(k.win_rate.target).toBe(30);
    expect(k.win_rate.status).toBe('good');
    expect(k.lead_response_minutes).toMatchObject({ target: 10, status: 'bad' });
    expect(r.json.value.find((v: Json) => v.key === 'auto_leads').value).toBe(2);
    // a rep sees their own numbers only
    const mine = Object.fromEntries(((await rep('GET', '/api/v1/kpis')).json.items as Json[]).map((i) => [i.key, i]));
    expect(mine.leads_new.value).toBe(1);
  });

  it('trends six months and lets admins change targets', async () => {
    const t = await api('GET', '/api/v1/kpis/trend?keys=leads_new,win_rate,bogus');
    expect(t.json.months).toHaveLength(6);
    expect(Object.keys(t.json.series)).toEqual(['leads_new', 'win_rate']);
    expect(t.json.series.leads_new.at(-1)).toBe(4);
    expect((await rep('PUT', '/api/admin/kpis/targets', { targets: { win_rate: 50 } })).status).toBe(403);
    expect((await api('PUT', '/api/admin/kpis/targets', { targets: { win_rate: 80, lead_response_minutes: null } })).status).toBe(200);
    const k = Object.fromEntries(((await api('GET', '/api/v1/kpis')).json.items as Json[]).map((i) => [i.key, i]));
    expect(k.win_rate).toMatchObject({ target: 80, status: 'bad' });
    expect(k.lead_response_minutes.target).toBeNull();
  });

  it('works out Indian financial periods', () => {
    const at = new Date('2026-02-10T12:00:00+05:30');
    expect(periodRange('this_quarter', at).label).toBe('Q4 FY25-26');
    expect(periodRange('this_fy', at).label).toBe('FY 2025-26');
    expect(periodRange('this_fy', at).from.toISOString()).toBe('2025-03-31T18:30:00.000Z');
    expect(periodRange('this_quarter', new Date('2026-05-02T09:00:00+05:30')).label).toBe('Q1 FY26-27');
    expect(periodRange('last_month', at).label).toMatch(/January 2026/);
  });
});
