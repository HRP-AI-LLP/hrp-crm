/** Roles only reach their work areas: a project team member sees their projects and nothing else. */
import { ALWAYS, areaOfPath } from '@synapse/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { Db } from '../src/lib/db';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let owner: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};

async function sql(q: string, p: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, p));
  } finally {
    await db.close();
  }
}

async function person(email: string, role: string | null) {
  const r = await owner('POST', '/api/admin/users/invite', { email, fullName: email.split('@')[0], ...(role ? { roles: [role] } : {}), invite: true });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const token = new URL(r.json.inviteUrl).searchParams.get('token');
  const a = await h.call('POST', '/api/auth/invite/accept', { body: { token, password: PW }, headers: { 'x-tenant': 'areas' } });
  expect(a.status, JSON.stringify(a.json)).toBeLessThan(300);
  return { id: r.json.id as string, api: h.as('areas', (await h.login('areas', email)).token) };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_role_areas');
  await h.signup('areas', 'owner@areas.test');
  owner = h.as('areas', (await h.login('areas', 'owner@areas.test')).token);
  ids.tenant = (await owner('GET', '/api/auth/me')).json.tenant.id;
  for (const a of ['projects', 'billing', 'purchasing', 'books']) {
    const r = await owner('POST', `/api/admin/apps/${a}/enable`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  ids.mine = (await owner('POST', '/api/v1/records/project', { name: 'Fleet app' })).json.id;
  ids.other = (await owner('POST', '/api/v1/records/project', { name: 'Secret bid' })).json.id;
  ids.lead = (await owner('POST', '/api/v1/records/lead', { name: 'Big client lead', company: 'Tata' })).json.id;
}, 120_000);

describe('work areas', () => {
  it('maps every signed-in API route to an area (new routes must be listed)', () => {
    const app = createApp() as unknown as { routes: { method: string; path: string }[] };
    const unknown = new Set<string>();
    for (const r of app.routes) {
      const m = /^\/api\/(v1|ai)(\/.*)$/.exec(r.path);
      if (!m || r.method === 'ALL') continue;
      if (areaOfPath(m[2]!) === null) unknown.add(`${r.method} ${r.path}`);
    }
    expect([...unknown]).toEqual([]);
    expect(areaOfPath('/books/ledger')).toBe('books');
    expect(areaOfPath('/projects/x/sdlc')).toBe('projects');
    expect(areaOfPath('/records/lead')).toBe(ALWAYS);
    expect(areaOfPath('/something-new')).toBeNull();
  });

  it('a project team member works only on their project', async () => {
    const roles = (await owner('GET', '/api/admin/roles')).json.items as Json[];
    expect(roles.find((r) => r.key === 'project_member')?.permissions.apps).toEqual(['projects', 'calls', 'knowledge']);
    expect(roles.find((r) => r.key === 'project_manager')?.permissions.objects['*'].read).toBe('none');
    const m = await person('dev@areas.test', null); // no role chosen: the least one
    expect((await sql(`select r.key from user_roles ur join roles r on r.id = ur.role_id where ur.user_id = $1`, [m.id])).map((x) => x.key)).toEqual(['project_member']);
    const add = await owner('PUT', `/api/v1/projects/${ids.mine}/members`, { members: [{ userId: m.id, role: 'member' }] });
    expect(add.status, JSON.stringify(add.json)).toBeLessThan(300);

    const me = (await m.api('GET', '/api/auth/me')).json;
    expect(me.permissions.apps).toEqual(['calls', 'knowledge', 'projects']);
    // a sales rep on a project's team opens that project, not others
    // their project, not the other one
    const list = await m.api('GET', '/api/v1/projects');
    expect(list.status).toBe(200);
    expect((list.json.items ?? list.json).map((p: Json) => p.name)).toEqual(['Fleet app']);
    expect((await m.api('GET', `/api/v1/projects/${ids.mine}`)).status).toBe(200);
    expect((await m.api('GET', `/api/v1/projects/${ids.other}`)).status).toBe(404);
    // nothing of CRM, billing, books, GST, intake, insights
    for (const path of ['/api/v1/books/accounts', '/api/v1/invoices', '/api/v1/gst/returns', '/api/v1/intake/documents', '/api/v1/dashboards', '/api/v1/inbox', '/api/v1/forecast', '/api/v1/quotes']) {
      const r = await m.api('GET', path);
      expect(r.status, path).toBe(403);
    }
    expect((await m.api('GET', '/api/v1/books/accounts')).json.error.message).toMatch(/does not include Books/);
    for (const obj of ['lead', 'account', 'invoice', 'bill', 'deal']) expect((await m.api('GET', `/api/v1/records/${obj}`)).status, obj).toBe(403);
    expect((await m.api('GET', `/api/v1/records/lead/${ids.lead}`)).status).toBeGreaterThanOrEqual(403);
    expect((await m.api('POST', '/api/v1/records/lead', { name: 'x' })).status).toBe(403);
    // search finds nothing outside their areas
    const s = await m.api('GET', '/api/v1/search?q=Tata');
    expect(JSON.stringify(s.json)).not.toContain('Big client lead');
    // always there: home, tasks, their own expenses
    expect((await m.api('GET', '/api/v1/home/today')).status).toBe(200);
    expect((await m.api('GET', '/api/v1/records/expense')).status).toBe(200);
  });

  it('a sales rep stays out of books, billing and projects they are not on', async () => {
    const rep = await person('rep@areas.test', 'sales_rep');
    expect((await rep.api('GET', '/api/v1/records/lead')).status).toBe(200);
    expect((await rep.api('GET', '/api/v1/books/accounts')).status).toBe(403);
    expect((await rep.api('GET', '/api/v1/records/invoice')).status).toBe(403);
    expect((await rep.api('GET', `/api/v1/projects/${ids.mine}`)).status).toBe(403);
    // added to a project's team: that project opens, the other stays closed
    const members = (await owner('GET', `/api/v1/projects/${ids.mine}`)).json.members.map((x: Json) => ({ userId: x.user_id, role: x.role }));
    expect((await owner('PUT', `/api/v1/projects/${ids.mine}/members`, { members: [...members, { userId: rep.id, role: 'member' }] })).status).toBe(200);
    expect((await rep.api('GET', `/api/v1/projects/${ids.mine}`)).status).toBe(200);
    expect((await rep.api('GET', `/api/v1/projects/${ids.other}`)).status).toBe(404);
    expect((await rep.api('GET', '/api/v1/books/accounts')).status).toBe(403);
  });

  it('administrators give a role areas; edits that leave areas out keep them', async () => {
    const roles = (await owner('GET', '/api/admin/roles')).json.items as Json[];
    const pm = roles.find((r) => r.key === 'project_member')!;
    await owner('PATCH', `/api/admin/roles/${pm.id}`, { permissions: { objects: pm.permissions.objects } });
    expect(((await owner('GET', '/api/admin/roles')).json.items as Json[]).find((r) => r.key === 'project_member')!.permissions.apps).toEqual(['projects', 'calls', 'knowledge']);
    const c = await owner('POST', '/api/admin/roles', { key: 'auditor', name: 'Auditor', permissions: { objects: { '*': { read: 'all' } }, apps: ['books', 'gst'] } });
    expect(c.json.permissions.apps).toEqual(['books', 'gst']);
    await owner('PATCH', `/api/admin/roles/${pm.id}`, { permissions: { ...pm.permissions, apps: ['projects', 'calls', 'knowledge', 'crm'] } });
    const m2 = await person('dev2@areas.test', 'project_member');
    // the area opens; object rights still apply
    expect(JSON.stringify((await m2.api('GET', '/api/v1/forecast')).json)).not.toMatch(/does not include/);
  });
});
