import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../src/lib/crypto';
import { takeToken } from '../src/lib/ratelimit';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const hits: { url: string; headers: Headers; body: string }[] = [];
let failNext = false;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  h = await makeHarness('synapse_test_developers');
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://hooks.example.com/')) {
      hits.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? '') });
      if (failNext) {
        failNext = false;
        return new Response('nope', { status: 500 });
      }
      return new Response('ok');
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('devco', 'owner@devco.test');
  api = h.as('devco', (await h.login('devco', 'owner@devco.test')).token);
  await api('POST', '/api/admin/users', { email: 'rep@devco.test', fullName: 'Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('devco', (await h.login('devco', 'rep@devco.test')).token);
  await api('PUT', '/api/admin/objects/lead/fields/budget_band', { label: 'Budget', type: 'picklist', options: { choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] } });
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('OpenAPI', () => {
  it("describes this workspace's objects with their custom fields", async () => {
    const r = await api('GET', '/api/v1/openapi.json');
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe('3.1.0');
    expect(r.json.components.schemas.Lead.properties.budget_band.enum).toEqual(['low', 'high']);
    expect(r.json.paths['/records/lead'].post.operationId).toBe('create_lead');
    expect(r.json.servers[0].url).toMatch(/\/api\/v1$/);
    const ev = await api('GET', '/api/v1/webhook-events');
    expect(ev.json.items.map((e: Json) => e.event)).toEqual(expect.arrayContaining(['lead.created', 'deal.stage_changed', 'contact.deleted']));
    expect(ev.json.items.map((e: Json) => e.event)).not.toContain('contact.stage_changed');
  });
});

describe('webhooks', () => {
  let hook = '';
  let secret = '';
  it('subscribes over the API (REST hooks), only for permitted people and public HTTPS hosts', async () => {
    expect((await rep('POST', '/api/v1/hooks', { url: 'https://hooks.example.com/a', events: ['lead.created'] })).status).toBe(403);
    expect((await api('POST', '/api/v1/hooks', { url: 'http://hooks.example.com/a', events: ['lead.created'] })).status).toBe(400);
    expect((await api('POST', '/api/v1/hooks', { url: 'https://10.0.0.5/a', events: ['lead.created'] })).status).toBe(400);
    expect((await api('POST', '/api/v1/hooks', { url: 'https://hooks.example.com/a', events: ['lead.exploded'] })).status).toBe(400);
    const r = await api('POST', '/api/v1/hooks', { url: 'https://hooks.example.com/a', events: ['lead.created'], name: 'Zap' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    hook = r.json.id;
    secret = r.json.secret;
  });

  it('delivers the record itself, signed with a timestamp, and logs the attempt', async () => {
    await api('POST', '/api/v1/records/lead', { last_name: 'Hook', email: 'hook@x.test', budget_band: 'high' });
    const hit = hits.at(-1)!;
    const body = JSON.parse(hit.body);
    expect(body.event).toBe('lead.created');
    expect(body.data.record).toMatchObject({ last_name: 'Hook', budget_band: 'high' });
    const ts = hit.headers.get('x-synapse-timestamp')!;
    expect(hit.headers.get('x-synapse-signature-v2')).toBe(`t=${ts},v1=${await hmacSha256Hex(secret, `${ts}.${hit.body}`)}`);
    const d = await api('GET', `/api/v1/hooks/${hook}/deliveries`);
    expect(d.json.items[0]).toMatchObject({ event: 'lead.created', ok: true, status_code: 200 });
  });

  it('records failures and redelivers on request', async () => {
    failNext = true;
    await api('POST', '/api/v1/records/lead', { last_name: 'Second' });
    const d = await api('GET', `/api/v1/hooks/${hook}/deliveries`);
    const failed = (d.json.items as Json[]).find((x) => !x.ok)!;
    expect(failed).toMatchObject({ status_code: 500, error: 'HTTP 500' });
    const n = hits.length;
    expect((await api('POST', `/api/v1/webhook-deliveries/${failed.id}/redeliver`)).status).toBe(200);
    expect(hits.length).toBe(n + 1);
    expect(JSON.parse(hits.at(-1)!.body).deliveryId).toBe(failed.id);
    const after = await api('GET', `/api/v1/hooks/${hook}/deliveries`);
    expect((after.json.items as Json[])[0]).toMatchObject({ ok: true, redelivery_of: failed.id });
    expect((await api('POST', `/api/v1/hooks/${hook}/test`)).status).toBe(200);
    expect(JSON.parse(hits.at(-1)!.body).event).toBe('ping');
  });
});

describe('API keys', () => {
  it('carry a per-minute rate limit with standard headers', async () => {
    const k = await api('POST', '/api/admin/api-keys', { name: 'Script', scopes: ['read'], rateLimitPerMin: 10 });
    expect(k.status, JSON.stringify(k.json)).toBe(201);
    const call = () => h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${k.json.key}` } });
    const first = await call();
    expect(first.status).toBe(200);
    expect(first.headers.get('x-ratelimit-limit')).toBe('10');
    let last = first;
    for (let i = 0; i < 10; i++) last = await call();
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });
  it('counts in one-minute windows', () => {
    const t = Date.UTC(2026, 9, 19, 10, 0, 30);
    for (let i = 0; i < 3; i++) expect(takeToken('k', 3, t).ok).toBe(true);
    expect(takeToken('k', 3, t).ok).toBe(false);
    expect(takeToken('k', 3, t + 31_000).ok).toBe(true);
  });
});
