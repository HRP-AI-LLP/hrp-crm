/**
 * End-to-end API tests: the real Hono app against a real Postgres (RLS on, runtime role),
 * with no Cloudflare bindings (jobs run inline, AI falls back to rule-based scoring).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { clearL1 } from '../src/lib/cache';
import { createTestDatabase } from '../../../packages/db/test/helpers';

let env: Env;
const app = createApp();

type Json = Record<string, any>;

async function call(method: string, path: string, opts: { tenant?: string; token?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.tenant) headers['x-tenant'] = opts.tenant;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  const res = await app.request(`http://synapse.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env);
  const text = await res.text();
  let json: Json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function login(tenant: string, email: string, password: string) {
  const r = await call('POST', '/api/auth/login', { tenant, body: { email, password } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  return { token: r.json.accessToken as string, cookie };
}

const PW = 'Str0ng-Passw0rd!';
let acme: { token: string; cookie: string };
let globex: { token: string; cookie: string };

beforeAll(async () => {
  const { appUrl } = await createTestDatabase('synapse_test_api');
  env = {
    APP_ENV: 'local',
    BASE_DOMAIN: 'synapse.test',
    ALLOW_TENANT_HEADER: 'true',
    SIGNUP_ENABLED: 'true',
    JWT_SECRET: 'test-secret-test-secret-test-secret-1234567890',
    DATA_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    DATABASE_URL: appUrl,
  };
  clearL1();
  for (const [slug, name, email] of [['acme', 'Acme Corp', 'owner@acme.test'], ['globex', 'Globex', 'owner@globex.test']]) {
    const r = await call('POST', '/api/public/signup', { body: { workspaceName: name, slug, fullName: `${name} Owner`, email, password: PW } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }
  acme = await login('acme', 'owner@acme.test', PW);
  globex = await login('globex', 'owner@globex.test', PW);
}, 90_000);

afterAll(() => clearL1());

describe('public + auth', () => {
  it('health', async () => {
    expect((await call('GET', '/api/public/health')).json.ok).toBe(true);
  });
  it('rejects duplicate and reserved slugs and weak passwords', async () => {
    expect((await call('POST', '/api/public/signup', { body: { workspaceName: 'Xco', slug: 'acme', fullName: 'X', email: 'x@x.test', password: PW } })).status).toBe(409);
    expect((await call('POST', '/api/public/signup', { body: { workspaceName: 'Xco', slug: 'admin', fullName: 'X', email: 'x@x.test', password: PW } })).status).toBe(400);
    expect((await call('POST', '/api/public/signup', { body: { workspaceName: 'Xco', slug: 'newco', fullName: 'X', email: 'x@x.test', password: 'short' } })).status).toBe(400);
  });
  it('unknown workspace → 404 before any tenant query', async () => {
    expect((await call('POST', '/api/auth/login', { tenant: 'nope', body: { email: 'a@b.test', password: 'x' } })).status).toBe(404);
  });
  it('wrong password → 401; lockout after repeated failures', async () => {
    await call('POST', '/api/public/signup', { body: { workspaceName: 'Lock', slug: 'lockco', fullName: 'L', email: 'l@lock.test', password: PW } });
    for (let i = 0; i < 5; i++) expect((await call('POST', '/api/auth/login', { tenant: 'lockco', body: { email: 'l@lock.test', password: 'wrong' } })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { tenant: 'lockco', body: { email: 'l@lock.test', password: PW } })).status).toBe(429);
  });
  it('me returns owner permissions', async () => {
    const r = await call('GET', '/api/auth/me', { tenant: 'acme', token: acme.token });
    expect(r.status).toBe(200);
    expect(r.json.permissions.admin).toContain('*');
  });
  it('refresh rotates the token; reusing the old one kills the family', async () => {
    const s = await login('acme', 'owner@acme.test', PW);
    const r1 = await call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: s.cookie, headers: { 'x-requested-with': 'synapse' } });
    expect(r1.status).toBe(200);
    const newCookie = (r1.headers.get('set-cookie') ?? '').split(';')[0]!;
    expect(newCookie).not.toBe(s.cookie);
    // replay the old token → reuse detected
    expect((await call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: s.cookie, headers: { 'x-requested-with': 'synapse' } })).status).toBe(401);
    // ...and the rotated one is now revoked too
    expect((await call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: newCookie, headers: { 'x-requested-with': 'synapse' } })).status).toBe(401);
  });
  it('refresh requires the CSRF header', async () => {
    expect((await call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: acme.cookie })).status).toBe(403);
  });
});

describe('tenant isolation at the API', () => {
  let leadId: string;
  beforeAll(async () => {
    const r = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { first_name: 'Wile', last_name: 'Coyote', company: 'Acme Rockets', email: 'wile@acme.test', source: 'referral' } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    leadId = r.json.id;
  });
  it('a token from tenant A is rejected on tenant B (audience binding)', async () => {
    expect((await call('GET', '/api/v1/records/lead', { tenant: 'globex', token: acme.token })).status).toBe(401);
  });
  it("tenant B cannot read tenant A's record even with its id", async () => {
    expect((await call('GET', `/api/v1/records/lead/${leadId}`, { tenant: 'globex', token: globex.token })).status).toBe(404);
    expect((await call('PATCH', `/api/v1/records/lead/${leadId}`, { tenant: 'globex', token: globex.token, body: { company: 'pwned' } })).status).toBe(404);
  });
  it('list only returns own tenant rows', async () => {
    const r = await call('GET', '/api/v1/records/lead', { tenant: 'globex', token: globex.token });
    expect(r.json.items).toEqual([]);
  });
});

describe('records, pipelines, metadata', () => {
  it('serves metadata with standard objects and pipelines', async () => {
    const r = await call('GET', '/api/v1/meta', { tenant: 'acme', token: acme.token });
    expect(r.json.objects.map((o: Json) => o.key).sort()).toEqual(['account', 'contact', 'deal', 'lead']);
    expect(r.json.pipelines.find((p: Json) => p.objectKey === 'deal').stages.length).toBe(6);
  });

  it('validates input against field metadata', async () => {
    const r = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { email: 'not-an-email', bogus: 1 } });
    expect(r.status).toBe(400);
    const fields = r.json.error.details.map((d: Json) => d.field).sort();
    expect(fields).toEqual(['bogus', 'email', 'last_name']);
  });

  it('custom field (indexed) round-trips and filters via the EAV index', async () => {
    expect((await call('PUT', '/api/admin/objects/lead/fields/budget', { tenant: 'acme', token: acme.token, body: { label: 'Budget', type: 'currency', indexed: true } })).status).toBe(200);
    expect((await call('PUT', '/api/admin/objects/lead/fields/city', { tenant: 'acme', token: acme.token, body: { label: 'City', type: 'text', indexed: true } })).status).toBe(200);
    for (const [n, b, c] of [['Big', 900000, 'Pune'], ['Small', 1000, 'Mumbai'], ['Mid', 50000, 'Pune']] as const) {
      const r = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { last_name: n, budget: b, city: c } });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      expect(r.json.budget).toBe(b);
    }
    const f = encodeURIComponent(JSON.stringify([{ field: 'budget', op: 'gte', value: 40000 }, { field: 'city', op: 'eq', value: 'Pune' }]));
    const r = await call('GET', `/api/v1/records/lead?filters=${f}&sort=budget&dir=desc`, { tenant: 'acme', token: acme.token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.items.map((i: Json) => i.last_name)).toEqual(['Big', 'Mid']);
  });

  it('rejects reserved custom field keys', async () => {
    expect((await call('PUT', '/api/admin/objects/lead/fields/email', { tenant: 'acme', token: acme.token, body: { label: 'E', type: 'text' } })).status).toBe(400);
  });

  it('deal stage moves log a timeline entry, set probability and close date', async () => {
    const meta = (await call('GET', '/api/v1/meta', { tenant: 'acme', token: acme.token })).json;
    const stages = meta.pipelines.find((p: Json) => p.objectKey === 'deal' && p.isDefault).stages;
    const d = await call('POST', '/api/v1/records/deal', { tenant: 'acme', token: acme.token, body: { name: 'Rocket skates', amount: 125000 } });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(d.json.probability).toBe(10);
    const won = stages.find((s: Json) => s.category === 'won');
    const u = await call('PATCH', `/api/v1/records/deal/${d.json.id}`, { tenant: 'acme', token: acme.token, body: { stage_id: won.id }, headers: { 'if-match': String(d.json.version) } });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json.probability).toBe(100);
    expect(u.json.closed_at).not.toBeNull();
    // stale version → 409
    expect((await call('PATCH', `/api/v1/records/deal/${d.json.id}`, { tenant: 'acme', token: acme.token, body: { amount: 1 }, headers: { 'if-match': String(d.json.version) } })).status).toBe(409);
    const t = await call('GET', `/api/v1/records/deal/${d.json.id}/timeline`, { tenant: 'acme', token: acme.token });
    expect(t.json.items[0].kind).toBe('stage_change');
  });

  it('converts a lead into contact + account + deal', async () => {
    const l = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { first_name: 'Road', last_name: 'Runner', company: 'Beep Inc', email: 'rr@beep.test' } });
    const r = await call('POST', `/api/v1/records/lead/${l.json.id}/convert`, { tenant: 'acme', token: acme.token, body: { createDeal: true, amount: 5000 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.contactId && r.json.accountId && r.json.dealId).toBeTruthy();
    const lead = await call('GET', `/api/v1/records/lead/${l.json.id}`, { tenant: 'acme', token: acme.token });
    expect(lead.json.converted_at).not.toBeNull();
    expect((await call('POST', `/api/v1/records/lead/${l.json.id}/convert`, { tenant: 'acme', token: acme.token, body: {} })).status).toBe(409);
  });

  it('installs a domain module (Real Estate) and uses its custom object', async () => {
    const r = await call('POST', '/api/admin/modules/real_estate/install', { tenant: 'acme', token: acme.token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const again = await call('POST', '/api/admin/modules/real_estate/install', { tenant: 'acme', token: acme.token });
    expect(again.status).toBe(200); // idempotent
    const p = await call('POST', '/api/v1/records/property', { tenant: 'acme', token: acme.token, body: { name: 'Sea View 3BHK', bhk: 3, price: 25000000, property_type: 'apartment', city: 'Mumbai' } });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const f = encodeURIComponent(JSON.stringify([{ field: 'bhk', op: 'eq', value: 3 }]));
    const list = await call('GET', `/api/v1/records/property?filters=${f}`, { tenant: 'acme', token: acme.token });
    expect(list.json.items.length).toBe(1);
    // custom objects are invisible to other tenants entirely
    expect((await call('GET', '/api/v1/records/property', { tenant: 'globex', token: globex.token })).status).toBe(404);
  });

  it('custom lookup must reference a record in the same tenant', async () => {
    const otherLead = await call('POST', '/api/v1/records/lead', { tenant: 'globex', token: globex.token, body: { last_name: 'Outsider' } });
    const r = await call('POST', '/api/v1/records/site_visit', { tenant: 'acme', token: acme.token, body: { name: 'Visit', visit_at: new Date().toISOString(), lead: otherLead.json.id } });
    expect(r.status).toBe(400);
  });
});

describe('RBAC, ABAC and field-level security', () => {
  let rep: { token: string };
  let rep2: { token: string };
  beforeAll(async () => {
    const roleRes = await call('POST', '/api/admin/roles', {
      tenant: 'acme',
      token: acme.token,
      body: {
        key: 'west_rep',
        name: 'West Rep',
        permissions: {
          objects: { '*': { read: 'all', create: true, update: 'own', delete: 'none' }, lead: { read: 'all', create: true, update: 'own', delete: 'none' } },
          fields: { lead: { budget: 'hidden', email: 'read' } },
          conditions: { lead: [{ field: 'city', op: 'eq', value: '$user.region' }] },
        },
      },
    });
    expect(roleRes.status, JSON.stringify(roleRes.json)).toBe(201);
    const u1 = await call('POST', '/api/admin/users', { tenant: 'acme', token: acme.token, body: { email: 'rep@acme.test', fullName: 'Rep One', password: PW, roles: ['west_rep'], attributes: { region: 'Pune' } } });
    expect(u1.status, JSON.stringify(u1.json)).toBe(201);
    await call('POST', '/api/admin/users', { tenant: 'acme', token: acme.token, body: { email: 'rep2@acme.test', fullName: 'Rep Two', password: PW, roles: ['sales_rep'] } });
    rep = await login('acme', 'rep@acme.test', PW);
    rep2 = await login('acme', 'rep2@acme.test', PW);
  });

  it('ABAC: rep only sees leads in their region', async () => {
    const r = await call('GET', '/api/v1/records/lead', { tenant: 'acme', token: rep.token });
    expect(r.status).toBe(200);
    expect(r.json.items.length).toBeGreaterThan(0);
    expect(r.json.items.every((i: Json) => i.city === 'Pune')).toBe(true);
  });

  it('FLS: hidden fields are absent and cannot be filtered or sorted on', async () => {
    const r = await call('GET', '/api/v1/records/lead', { tenant: 'acme', token: rep.token });
    expect(r.json.items.every((i: Json) => !('budget' in i))).toBe(true);
    const f = encodeURIComponent(JSON.stringify([{ field: 'budget', op: 'gt', value: 0 }]));
    expect((await call('GET', `/api/v1/records/lead?filters=${f}`, { tenant: 'acme', token: rep.token })).status).toBe(400);
    expect((await call('GET', '/api/v1/records/lead?sort=budget', { tenant: 'acme', token: rep.token })).status).toBe(400);
    const meta = (await call('GET', '/api/v1/meta', { tenant: 'acme', token: rep.token })).json;
    expect(meta.objects.find((o: Json) => o.key === 'lead').fields.some((f: Json) => f.key === 'budget')).toBe(false);
  });

  it('FLS: read-only fields cannot be written', async () => {
    const r = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: rep.token, body: { last_name: 'Mine', city: 'Pune', email: 'x@y.test' } });
    expect(r.status).toBe(400);
    const ok = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: rep.token, body: { last_name: 'Mine', city: 'Pune' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
  });

  it("RBAC own-scope: rep cannot update someone else's lead", async () => {
    const owners = await call('GET', '/api/v1/records/lead', { tenant: 'acme', token: rep.token });
    const notMine = owners.json.items.find((i: Json) => i.last_name !== 'Mine');
    expect((await call('PATCH', `/api/v1/records/lead/${notMine.id}`, { tenant: 'acme', token: rep.token, body: { company: 'x' } })).status).toBe(404);
  });

  it('sales_rep (own read scope on leads) sees only own leads; admin APIs are forbidden', async () => {
    const r = await call('GET', '/api/v1/records/lead', { tenant: 'acme', token: rep2.token });
    expect(r.json.items).toEqual([]);
    expect((await call('GET', '/api/admin/users', { tenant: 'acme', token: rep2.token })).status).toBe(403);
    expect((await call('DELETE', `/api/v1/records/account/00000000-0000-0000-0000-000000000000`, { tenant: 'acme', token: rep2.token })).status).toBe(403);
  });

  it('disabling a user blocks refresh immediately', async () => {
    const users = (await call('GET', '/api/admin/users', { tenant: 'acme', token: acme.token })).json.items;
    const u = users.find((x: Json) => x.email === 'rep2@acme.test');
    const s = await login('acme', 'rep2@acme.test', PW);
    expect((await call('PATCH', `/api/admin/users/${u.id}`, { tenant: 'acme', token: acme.token, body: { status: 'disabled' } })).status).toBe(200);
    expect((await call('POST', '/api/auth/refresh', { tenant: 'acme', cookie: s.cookie, headers: { 'x-requested-with': 'synapse' } })).status).toBe(401);
  });
});

describe('automation, forms, AI fallbacks, audit', () => {
  it('workflow: lead created with referral source → follow-up task', async () => {
    const w = await call('POST', '/api/admin/workflows', {
      tenant: 'acme',
      token: acme.token,
      body: { name: 'Referral follow-up', objectKey: 'lead', triggerEvent: 'created', conditions: [{ field: 'source', op: 'eq', value: 'referral' }], actions: [{ type: 'create_task', title: 'Call {{full_name}} today', dueInHours: 4, priority: 'high' }] },
    });
    expect(w.status, JSON.stringify(w.json)).toBe(201);
    const l = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { first_name: 'Bugs', last_name: 'Bunny', source: 'referral' } });
    expect(l.status).toBe(201);
    const t = await call('GET', `/api/v1/tasks?relatedObject=lead&relatedId=${l.json.id}`, { tenant: 'acme', token: acme.token });
    expect(t.json.items.map((x: Json) => x.title)).toContain('Call Bugs Bunny today');
  });

  it('new leads get an automatic rule-based score when no AI provider is configured', async () => {
    const l = await call('POST', '/api/v1/records/lead', { tenant: 'acme', token: acme.token, body: { first_name: 'Daffy', last_name: 'Duck', email: 'd@duck.test', phone: '+91 90000 00000', company: 'Duck Co', source: 'referral' } });
    const r = await call('GET', `/api/v1/records/lead/${l.json.id}`, { tenant: 'acme', token: acme.token });
    expect(r.json.ai_score).toBeGreaterThan(30);
    expect(r.json.ai_insights.baseReasons).toContain('Source: referral');
  });

  it('public web-to-lead form creates a lead only with whitelisted fields', async () => {
    const f = await call('POST', '/api/admin/forms', { tenant: 'acme', token: acme.token, body: { objectKey: 'lead', name: 'Website', kind: 'public', layout: { sections: [{ fields: ['first_name', 'last_name', 'email', 'city'] }] } } });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    const key = f.json.public_key;
    const def = await call('GET', `/api/public/forms/${key}`);
    expect(def.json.fields.map((x: Json) => x.key).sort()).toEqual(['city', 'email', 'first_name', 'last_name']);
    const sub = await call('POST', `/api/public/forms/${key}`, { body: { first_name: 'Web', last_name: 'Visitor', email: 'web@visitor.test', city: 'Pune', ai_score: 100, owner_id: '00000000-0000-0000-0000-000000000000', consent: true } });
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    const list = await call('GET', `/api/v1/records/lead?q=Visitor`, { tenant: 'acme', token: acme.token });
    expect(list.json.items.length).toBe(1);
    expect(list.json.items[0].source).toBe('website');
    expect(list.json.items[0].owner_id).not.toBe('00000000-0000-0000-0000-000000000000');
  });

  it('AI endpoints report unavailability cleanly with no providers', async () => {
    const l = await call('GET', '/api/v1/records/lead?limit=1', { tenant: 'acme', token: acme.token });
    const r = await call('POST', `/api/ai/summarize/lead/${l.json.items[0].id}`, { tenant: 'acme', token: acme.token });
    expect(r.status).toBe(503);
  });

  it('knowledge base keyword fallback works without Vectorize', async () => {
    const d = await call('POST', '/api/ai/kb/documents', { tenant: 'acme', token: acme.token, body: { title: 'Pricing', content: 'Our premium plan costs 4999 rupees per seat per month.\n\nRefunds are processed within 7 days.' } });
    expect(d.status).toBe(202);
    const docs = await call('GET', '/api/ai/kb/documents', { tenant: 'acme', token: acme.token });
    expect(docs.json.items[0].chunk_count).toBeGreaterThan(0);
  });

  it('audit log captures record changes with the acting user', async () => {
    const r = await call('GET', '/api/admin/audit?object=lead&limit=200', { tenant: 'acme', token: acme.token });
    expect(r.status).toBe(200);
    expect(r.json.items.some((a: Json) => a.action === 'create' && a.actor_name === 'Acme Corp Owner')).toBe(true);
    expect((await call('GET', '/api/admin/audit', { tenant: 'globex', token: globex.token })).json.items.every((a: Json) => a.tenant_id !== r.json.items[0].tenant_id)).toBe(true);
  });

  it('dashboard aggregates respect permissions', async () => {
    const r = await call('GET', '/api/v1/dashboard', { tenant: 'acme', token: acme.token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.leads.open).toBeGreaterThan(0);
  });
});
