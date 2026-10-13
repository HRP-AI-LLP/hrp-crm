import { gunzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { ipInList, parseCidr } from '../src/lib/ip';
import { fakeR2, type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let r2: ReturnType<typeof fakeR2>;
const NEW_PW = 'An0ther-Str0ng-Pass!';

const from = (ip: string, extra: Record<string, string> = {}) => ({ headers: { 'cf-connecting-ip': ip, ...extra } });

beforeAll(async () => {
  h = await makeHarness('synapse_test_admin10');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  const inv = await api('POST', '/api/admin/users/invite', { email: 'rep@acme.test', fullName: 'Rita Rep', roles: ['sales_rep'] });
  const token = new URL(inv.json.inviteUrl).searchParams.get('token')!;
  await h.call('POST', '/api/auth/invite/accept', { tenant: 'acme', body: { token, password: NEW_PW } });
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test', NEW_PW)).token);
}, 90_000);

describe('CIDR matching', () => {
  it('handles IPv4, IPv6, mapped addresses and junk', () => {
    expect(ipInList('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipInList('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
    expect(ipInList('10.1.2.3', ['10.0.0.0/8', '192.168.0.0/16'])).toBe(true);
    expect(ipInList('::ffff:203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipInList('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(ipInList('2001:db9::5', ['2001:db8::/32'])).toBe(false);
    expect(ipInList('1.2.3.4', ['1.2.3.4'])).toBe(true);
    expect(ipInList('1.2.3.4', ['0.0.0.0/0'])).toBe(true);
    expect(ipInList('not-an-ip', ['0.0.0.0/0'])).toBe(false);
    expect(parseCidr('300.1.1.1/8')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
    expect(parseCidr('fe80::1%eth0')).not.toBeNull();
  });
});

describe('network restrictions', () => {
  it('refuses a policy that would lock the admin out, and bad ranges', async () => {
    const bad = await api('PUT', '/api/admin/security', { ipAllowlist: ['nonsense'] });
    expect(bad.status).toBe(400);
    const lock = await api('PUT', '/api/admin/security', { ipAllowlist: ['198.51.100.0/24'] }, from('203.0.113.9'));
    expect(lock.status).toBe(400);
    expect(lock.json.error.message).toContain('block your own access');
  });

  it('applies to the API, sign-in and API keys; members do not see the list', async () => {
    const key = (await api('POST', '/api/admin/api-keys', { name: 'Sync', scopes: ['read'] })).json.key as string;
    const ok = await api('PUT', '/api/admin/security', { ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] }, from('203.0.113.9'));
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // the admin sees the policy, with their own address
    const pol = await api('GET', '/api/admin/security', undefined, from('203.0.113.9'));
    expect(pol.json.policy.ipAllowlist).toEqual(['203.0.113.0/24', '2001:db8::/32']);
    expect(pol.json.you.ip).toBe('203.0.113.9');

    expect((await rep('GET', '/api/v1/records/lead', undefined, from('203.0.113.50'))).status).toBe(200);
    const blocked = await rep('GET', '/api/v1/records/lead', undefined, from('198.51.100.7'));
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe('network_restricted');
    expect((await rep('GET', '/api/v1/records/lead', undefined, from('2001:db8:5::1'))).status).toBe(200);

    const login = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'rep@acme.test', password: NEW_PW }, ...from('198.51.100.7') });
    expect(login.status).toBe(403);
    const login2 = await h.call('POST', '/api/auth/login', { tenant: 'acme', body: { email: 'rep@acme.test', password: NEW_PW }, ...from('203.0.113.77') });
    expect(login2.status).toBe(200);

    expect((await h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '198.51.100.7' } })).status).toBe(403);
    expect((await h.call('GET', '/api/v1/records/lead', { headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '203.0.113.1' } })).status).toBe(200);

    // the rule list itself stays with admins
    const meta = await rep('GET', '/api/v1/meta', undefined, from('203.0.113.50'));
    expect(JSON.stringify(meta.json)).not.toContain('203.0.113.0/24');
    // public customer pages are never restricted
    expect((await h.call('GET', '/api/public/health', from('198.51.100.7'))).status).toBe(200);
  });

  it('country rules use Cloudflare’s country header', async () => {
    const r = await api('PUT', '/api/admin/security', { countries: ['IN'] }, from('203.0.113.9', { 'cf-ipcountry': 'IN' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await rep('GET', '/api/v1/records/lead', undefined, from('203.0.113.9', { 'cf-ipcountry': 'US' }))).status).toBe(403);
    expect((await rep('GET', '/api/v1/records/lead', undefined, from('203.0.113.9', { 'cf-ipcountry': 'IN' }))).status).toBe(200);
    // clearing the rules opens access again
    const clear = await api('PUT', '/api/admin/security', { ipAllowlist: [], countries: [] }, from('203.0.113.9', { 'cf-ipcountry': 'IN' }));
    expect(clear.status).toBe(200);
    expect((await rep('GET', '/api/v1/records/lead', undefined, from('198.51.100.7', { 'cf-ipcountry': 'US' }))).status).toBe(200);
  });
});

describe('backups', () => {
  it('only the owner can run or download them', async () => {
    expect((await rep('GET', '/api/admin/backups')).status).toBe(403);
    expect((await rep('POST', '/api/admin/backups')).status).toBe(403);
  });

  it('exports every business table without credentials', async () => {
    await api('POST', '/api/v1/records/lead', { last_name: 'Backup Person', email: 'b@x.test' });
    const start = await api('POST', '/api/admin/backups');
    expect(start.status, JSON.stringify(start.json)).toBe(202);
    const list = await api('GET', '/api/admin/backups');
    expect(list.json.available).toBe(true);
    const b = list.json.items[0];
    expect(b.status).toBe('complete');
    const names = b.tables.map((t: Json) => t.name);
    expect(names).toContain('leads');
    expect(names).toContain('users');
    for (const t of ['sessions', 'api_keys', 'user_tokens', 'push_subscriptions']) expect(names).not.toContain(t);
    expect(b.tables.find((t: Json) => t.name === 'leads').rows).toBeGreaterThanOrEqual(1);

    const dl = await api('GET', `/api/admin/backups/${b.stamp}/download`, undefined, { raw: true });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('.ndjson.gz');
    // the harness reads bodies as text; fetch the raw bytes through the app directly instead
    const tok = (await h.login('acme', 'owner@acme.test')).token;
    const res = await h.app.request(`http://synapse.test/api/admin/backups/${b.stamp}/download`, { headers: { 'x-tenant': 'acme', authorization: `Bearer ${tok}` } }, h.env);
    const lines = gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.some((l) => l.t === 'leads' && l.r.last_name === 'Backup Person')).toBe(true);
    const owner = lines.find((l) => l.t === 'users' && l.r.email === 'owner@acme.test');
    expect(owner.r.password_hash).toBeNull();
    expect(owner.r.mfa_secret_ciphertext ?? null).toBeNull();
    expect(lines.some((l) => l.t === 'tenants')).toBe(true);
    expect(JSON.stringify(lines)).not.toContain('$argon');
  });

  it('daily setting and deletion', async () => {
    expect((await api('PUT', '/api/admin/backups/settings', { daily: true })).json.daily).toBe(true);
    expect((await api('GET', '/api/admin/backups')).json.daily).toBe(true);
    const b = (await api('GET', '/api/admin/backups')).json.items[0];
    expect((await api('DELETE', `/api/admin/backups/${b.stamp}`)).status).toBe(204);
    expect((await api('GET', '/api/admin/backups')).json.items.find((x: Json) => x.stamp === b.stamp)).toBeUndefined();
    expect((await api('GET', '/api/admin/backups/..%2F..%2Fx/download')).status).toBe(404);
  });
});

describe('opening stock and role dashboards', () => {
  it('sets opening balances by SKU and warehouse, reporting bad rows', async () => {
    expect((await api('POST', '/api/admin/apps/orders/enable')).status).toBe(200);
    expect((await api('POST', '/api/admin/apps/inventory/enable')).status).toBe(200);
    await api('POST', '/api/v1/warehouses', { code: 'SHOW', name: 'Showroom' });
    await api('POST', '/api/v1/records/product', { name: 'Oak Table', sku: 'OAK-1', list_price: 20000, tax_rate: 18, track_inventory: true, reorder_level: 5 });
    await api('POST', '/api/v1/records/product', { name: 'Chair', sku: 'CH-1', list_price: 3000, tax_rate: 18, track_inventory: true });
    const r = await api('POST', '/api/v1/inventory/opening-stock', {
      rows: [
        { sku: 'oak-1', warehouse: 'SHOW', quantity: 3, unitCost: 12000 },
        { sku: 'CH-1', quantity: 40 },
        { sku: 'NOPE', quantity: 1 },
        { sku: 'CH-1', warehouse: 'Mars', quantity: 1 },
      ],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.applied).toBe(2);
    expect(r.json.failed.map((f: Json) => f.row)).toEqual([3, 4]);
    // the same file again changes nothing
    const again = await api('POST', '/api/v1/inventory/opening-stock', { rows: [{ sku: 'CH-1', quantity: 40 }] });
    expect(again.json).toMatchObject({ applied: 0, unchanged: 1 });
    expect((await rep('POST', '/api/v1/inventory/opening-stock', { rows: [{ sku: 'CH-1', quantity: 1 }] })).status).toBe(403);
  });

  it('serves persona dashboards scoped to what the caller can see', async () => {
    const home = await api('GET', '/api/v1/insights/home');
    expect(home.status, JSON.stringify(home.json)).toBe(200);
    expect(home.json.personas[0]).toBe('owner');
    expect(home.json.personas).toEqual(expect.arrayContaining(['owner', 'sales', 'operations', 'inventory']));
    expect(home.json.data.tiles.map((t: Json) => t.key)).toEqual(expect.arrayContaining(['booked', 'pipeline', 'new_leads']));

    const inv = (await api('GET', '/api/v1/insights/home?persona=inventory')).json.data;
    const tile = (k: string) => inv.tiles.find((t: Json) => t.key === k)?.value;
    expect(tile('value')).toBe(36000); // 3 × 12 000 (chair has no cost)
    expect(tile('low')).toBe(1);
    expect(inv.lists[0].rows[0]).toMatchObject({ name: 'Oak Table', available: 3 });

    const sales = (await api('GET', '/api/v1/insights/home?persona=sales')).json.data;
    expect(sales.tiles.find((t: Json) => t.key === 'new_leads').value).toBeGreaterThanOrEqual(1);

    // a rep defaults to the sales view and only counts their own leads
    await rep('POST', '/api/v1/records/lead', { last_name: 'Mine', next_follow_up_at: new Date(Date.now() - 3600_000).toISOString() });
    const mine = (await rep('GET', '/api/v1/insights/home')).json;
    expect(mine.personas[0]).toBe('sales');
    expect(mine.data.tiles.find((t: Json) => t.key === 'overdue').value).toBe(1);
    expect(mine.data.tiles.find((t: Json) => t.key === 'new_leads').value).toBe(1);
    // asking for a view you cannot open falls back to one you can
    const sneaky = (await rep('GET', '/api/v1/insights/home?persona=inventory')).json;
    expect(sneaky.personas).not.toContain('inventory');
    expect(sneaky.data.persona).toBe('sales');
  });
});

void PW;
