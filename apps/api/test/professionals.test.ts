/** Accountants & CAs: add people with per-module access (view / download / edit), let them request
 * more, and an admin approves — merging the grant and rebuilding their enforcement role. */
import { beforeAll, describe, expect, it } from 'vitest';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let owner: ReturnType<typeof h.as>;
let caApi: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const CA_EMAIL = 'ca@firm.test';

beforeAll(async () => {
  h = await makeHarness('synapse_test_professionals');
  await h.signup('profs', 'owner@profs.test');
  owner = h.as('profs', (await h.login('profs', 'owner@profs.test')).token);
  // the CA already has a login in the workspace (so we can act as them below)
  const u = await owner('POST', '/api/admin/users', { email: CA_EMAIL, fullName: 'Asha CA', password: 'Sup3r!pass' });
  expect(u.status, JSON.stringify(u.json)).toBe(201);
}, 120_000);

describe('Accountants & CAs', () => {
  it('adds a professional with per-module access and lists it', async () => {
    const r = await owner('POST', '/api/v1/organisation/professionals', {
      email: CA_EMAIL,
      fullName: 'Asha CA',
      kind: 'ca',
      firm: 'Asha & Co',
      membershipNo: '123456',
      modules: { billing: 'download', books: 'view' },
      canFile: false,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.invited).toBe(false); // reused the existing login
    ids.pro = r.json.id;

    const list = await owner('GET', '/api/v1/organisation/professionals');
    expect(list.status).toBe(200);
    const me = (list.json.items as Json[]).find((p) => p.id === ids.pro)!;
    expect(me).toMatchObject({ fullName: 'Asha CA', kind: 'ca', kindLabel: 'Chartered accountant' });
    expect(me.access.modules).toEqual({ billing: 'download', books: 'view' });
    expect(list.json.pendingRequests).toBe(0);
  });

  it('changes what the professional can see', async () => {
    const r = await owner('PUT', `/api/v1/organisation/professionals/${ids.pro}/access`, { modules: { billing: 'edit' }, canFile: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const list = await owner('GET', '/api/v1/organisation/professionals');
    const me = (list.json.items as Json[]).find((p) => p.id === ids.pro)!;
    expect(me.access.modules).toEqual({ billing: 'edit' }); // books dropped, billing promoted to edit
  });

  it('lets the professional see their own access and request more', async () => {
    caApi = h.as('profs', (await h.login('profs', CA_EMAIL, 'Sup3r!pass')).token);
    const mine = await caApi('GET', '/api/v1/professionals/me');
    expect(mine.status).toBe(200);
    expect(mine.json.professional.access.modules).toEqual({ billing: 'edit' });

    const req = await caApi('POST', '/api/v1/professionals/me/requests', { modules: { books: 'download' }, note: 'Need the ledger to reconcile' });
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    ids.req = req.json.id;

    const dup = await caApi('POST', '/api/v1/professionals/me/requests', { modules: { gst: 'edit' } });
    expect(dup.status).toBe(400); // one pending at a time
  });

  it('shows the request to an admin and grants it on approval', async () => {
    const reqs = await owner('GET', '/api/v1/organisation/professional-requests');
    expect(reqs.status).toBe(200);
    const pending = (reqs.json.items as Json[]).find((r) => r.id === ids.req)!;
    expect(pending).toMatchObject({ fullName: 'Asha CA', status: 'pending' });
    expect(pending.requested.modules).toEqual({ books: 'download' });

    const decide = await owner('POST', `/api/v1/organisation/professional-requests/${ids.req}/decide`, { approve: true });
    expect(decide.status, JSON.stringify(decide.json)).toBe(200);
    expect(decide.json.status).toBe('approved');

    // the grant is merged onto what they already had
    const list = await owner('GET', '/api/v1/organisation/professionals');
    const me = (list.json.items as Json[]).find((p) => p.id === ids.pro)!;
    expect(me.access.modules).toEqual({ billing: 'edit', books: 'download' });

    // and the professional sees it
    const mine = await caApi('GET', '/api/v1/professionals/me');
    expect(mine.json.professional.access.modules).toEqual({ billing: 'edit', books: 'download' });
    expect((mine.json.requests as Json[]).find((r) => r.id === ids.req)!.status).toBe('approved');
  });

  it('refuses management to non-admins and removes the professional', async () => {
    const forbidden = await caApi('GET', '/api/v1/organisation/professionals');
    expect(forbidden.status).toBe(403);

    const del = await owner('DELETE', `/api/v1/organisation/professionals/${ids.pro}`);
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(del.json.ok).toBe(true);
    const list = await owner('GET', '/api/v1/organisation/professionals');
    expect((list.json.items as Json[]).find((p) => p.id === ids.pro)).toBeUndefined();
  });
});
