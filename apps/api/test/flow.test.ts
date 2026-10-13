import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { sweepTenant } from '../src/services/reminders';
import { type Json, makeHarness, PW } from './harness';

/** In-memory stand-in for an R2 bucket (put / get / delete are all the API uses). */
export function fakeR2() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    async put(key: string, value: Uint8Array) {
      store.set(key, new Uint8Array(value));
      return { key };
    },
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      return { body: new Blob([v]).stream() };
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3, 4]);

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep1: ReturnType<typeof h.as>;
let rep2: ReturnType<typeof h.as>;
let manager: ReturnType<typeof h.as>;
let ids: Record<string, string> = {};
let tenantId: string;
let r2: ReturnType<typeof fakeR2>;

async function upload(caller: ReturnType<typeof h.as>, object: string, id: string, name: string, bytes: Uint8Array, kind?: string) {
  const res = await h.app.request(
    `http://synapse.test/api/v1/files?object=${object}&id=${id}&name=${encodeURIComponent(name)}${kind ? `&kind=${kind}` : ''}`,
    { method: 'POST', headers: { 'x-tenant': 'acme', authorization: `Bearer ${(caller as unknown as { token: string }).token}`, 'content-type': 'application/octet-stream' }, body: bytes },
    h.env,
  );
  return { status: res.status, json: (await res.json()) as Json };
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_flow');
  r2 = fakeR2();
  h.env.FILES = r2 as unknown as R2Bucket;
  await h.signup('acme', 'owner@acme.test');
  const ownerTok = (await h.login('acme', 'owner@acme.test')).token;
  api = Object.assign(h.as('acme', ownerTok), { token: ownerTok });
  const mk = async (email: string, name: string, roles: string[]) => {
    const u = await api('POST', '/api/admin/users', { email, fullName: name, password: PW, roles });
    expect(u.status, JSON.stringify(u.json)).toBe(201);
    ids[email] = u.json.id;
    const tok = (await h.login('acme', email)).token;
    return Object.assign(h.as('acme', tok), { token: tok });
  };
  manager = await mk('mgr@acme.test', 'Mona Manager', ['sales_manager']);
  rep1 = await mk('rep1@acme.test', 'Ravi Rep', ['sales_rep']);
  rep2 = await mk('rep2@acme.test', 'Rita Rep', ['sales_rep']);
  for (const r of ['rep1@acme.test', 'rep2@acme.test']) await api('PATCH', `/api/admin/users/${ids[r]}`, { managerId: ids['mgr@acme.test'] });
  const me = (await api('GET', '/api/auth/me')).json;
  ids.owner = me.user.id;
  tenantId = me.tenant.id;
}, 90_000);

describe('files', () => {
  let leadId: string;
  let fileId: string;

  it('upload to a record, list with signed links, download through the link', async () => {
    leadId = (await rep1('POST', '/api/v1/records/lead', { last_name: 'Kapoor', company: 'Kapoor Villa' })).json.id;
    const up = await upload(rep1, 'lead', leadId, 'site photo.png', PNG);
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    expect(up.json).toMatchObject({ name: 'site photo.png', contentType: 'image/png', size: PNG.length, kind: 'photo', inline: true });
    fileId = up.json.id;
    expect([...r2.store.keys()][0]).toBe(`${tenantId}/lead/${leadId}/${fileId}`);

    const list = await rep1('GET', `/api/v1/files?object=lead&id=${leadId}`);
    expect(list.json.items.length).toBe(1);
    const url: string = list.json.items[0].url;
    expect(url).toMatch(new RegExp(`^/api/public/files/${tenantId}/${fileId}\\?e=\\d+&d=1&s=[0-9a-f]{40}$`));
    const dl = await h.app.request(`http://synapse.test${url}`, {}, h.env);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('image/png');
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(PNG);
    // tampered or foreign links are refused
    expect((await h.app.request(`http://synapse.test${url.slice(0, -1) + (url.endsWith('a') ? 'b' : 'a')}`, {}, h.env)).status).toBe(403);
    expect((await h.app.request(`http://synapse.test${url.replace(/e=\d+/, 'e=1')}`, {}, h.env)).status).toBe(403);
  });

  it('refuses executable or unknown types, and follows record permissions', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect((await upload(rep1, 'lead', leadId, 'x.svg', svg)).status).toBe(400);
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>');
    expect((await upload(rep1, 'lead', leadId, 'notes.txt', html)).status).toBe(400);
    // a PNG renamed .html is stored as image/png (detected type wins)
    const renamed = await upload(rep1, 'lead', leadId, 'evil.html', PNG);
    expect(renamed.json.contentType).toBe('image/png');
    const pdf = await upload(rep1, 'lead', leadId, 'brochure.pdf', new TextEncoder().encode('%PDF-1.4\n%fake'));
    expect(pdf.json).toMatchObject({ contentType: 'application/pdf', kind: 'attachment' });
    // rep2 cannot see rep1's lead, so neither its files
    expect((await rep2('GET', `/api/v1/files?object=lead&id=${leadId}`)).status).toBe(404);
    expect((await upload(rep2, 'lead', leadId, 'p.png', PNG)).status).toBe(404);
    expect((await rep2('DELETE', `/api/v1/files/${fileId}`)).status).toBe(404);
    expect((await rep1('DELETE', `/api/v1/files/${fileId}`)).status).toBe(200);
    expect(r2.store.has(`${tenantId}/lead/${leadId}/${fileId}`)).toBe(false);
    expect((await rep1('GET', `/api/v1/files?object=lead&id=${leadId}`)).json.items.length).toBe(2);
    const usage = (await api('GET', '/api/v1/files/usage')).json;
    expect(usage.files).toBe(2);
  });

  it('reports storage as unavailable without the R2 binding', async () => {
    const saved = h.env.FILES;
    h.env.FILES = undefined;
    try {
      expect((await upload(rep1, 'lead', leadId, 'p.png', PNG)).status).toBe(503);
      expect((await rep1('GET', `/api/v1/files?object=lead&id=${leadId}`)).json.enabled).toBe(false);
    } finally {
      h.env.FILES = saved;
    }
  });
});

describe('lead routing and scoring', () => {
  it('assignment rules hand out leads round robin; the assignee is notified', async () => {
    const bad = await api('POST', '/api/admin/rules/assignment', { objectKey: 'lead', name: 'x', strategy: 'round_robin', userIds: [] });
    expect(bad.status).toBe(400);
    expect((await api('POST', '/api/admin/rules/assignment', { objectKey: 'lead', name: 'x', strategy: 'round_robin', userIds: [ids['rep1@acme.test']], criteria: [{ field: 'nope', op: 'eq', value: 1 }] })).status).toBe(400);
    expect((await rep1('POST', '/api/admin/rules/assignment', { objectKey: 'lead', name: 'x', strategy: 'round_robin', userIds: [ids['rep1@acme.test']] })).status).toBe(403);
    const insta = await api('POST', '/api/admin/rules/assignment', {
      objectKey: 'lead', name: 'Instagram to Rita', strategy: 'fixed', userIds: [ids['rep2@acme.test']], criteria: [{ field: 'source', op: 'eq', value: 'instagram' }],
    });
    expect(insta.status, JSON.stringify(insta.json)).toBe(201);
    const rr = await api('POST', '/api/admin/rules/assignment', { objectKey: 'lead', name: 'Everyone else', strategy: 'round_robin', userIds: [ids['rep1@acme.test'], ids['rep2@acme.test']] });
    expect(rr.status).toBe(201);

    const owners: string[] = [];
    for (let i = 0; i < 4; i++) {
      const l = await api('POST', '/api/v1/records/lead?assign=1', { last_name: `Walk-in ${i}`, source: 'walk_in' });
      expect(l.status, JSON.stringify(l.json)).toBe(201);
      owners.push(l.json.owner_id);
    }
    expect(new Set(owners).size).toBe(2);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners[0]).toBe(owners[2]);
    const ig = await api('POST', '/api/v1/records/lead?assign=1', { last_name: 'Insta', source: 'instagram' });
    expect(ig.json.owner_id).toBe(ids['rep2@acme.test']);
    expect(ig.json.assigned_at).toBeUndefined(); // not a field; owner is enough
    // without ?assign the creator keeps the lead
    expect((await api('POST', '/api/v1/records/lead', { last_name: 'Mine', source: 'walk_in' })).json.owner_id).toBe(ids.owner);
    const n = (await rep2('GET', '/api/v1/notifications')).json.items;
    expect(n.some((x: Json) => x.kind === 'assignment' && /Insta/.test(x.title) && /Instagram to Rita/.test(x.body))).toBe(true);
  });

  it('web forms without a fixed owner use the rules too', async () => {
    const f = await api('POST', '/api/admin/forms', { name: 'Website', objectKey: 'lead', kind: 'public', layout: { sections: [{ fields: ['last_name', 'email'] }] } });
    expect(f.status, JSON.stringify(f.json)).toBe(201);
    const sub = await h.call('POST', `/api/public/forms/${f.json.public_key}`, { body: { last_name: 'Formfill', email: 'ff@x.test' } });
    expect(sub.status, JSON.stringify(sub.json)).toBe(201);
    const found = (await api('GET', `/api/v1/records/lead?q=Formfill`)).json.items[0];
    expect([ids['rep1@acme.test'], ids['rep2@acme.test']]).toContain(found.owner_id);
    expect(found.source).toBe('website');
  });

  it('scoring rules score and rate leads on save', async () => {
    expect((await api('POST', '/api/admin/rules/scoring', { name: 'Has email', criteria: [{ field: 'email', op: 'not_empty' }], points: 30 })).status).toBe(201);
    expect((await api('POST', '/api/admin/rules/scoring', { name: 'Architect referral', criteria: [{ field: 'source', op: 'in', value: ['architect', 'interior_designer'] }], points: 50 })).status).toBe(201);
    expect((await api('PUT', '/api/admin/rules/scoring-bands', { hot: 70, warm: 30 })).status).toBe(200);
    const l = await api('POST', '/api/v1/records/lead', { last_name: 'Mehta', source: 'architect' });
    expect([l.json.score, l.json.rating]).toEqual([50, 'warm']);
    const u = await api('PATCH', `/api/v1/records/lead/${l.json.id}`, { email: 'mehta@x.test' });
    expect([u.json.score, u.json.rating]).toEqual([80, 'hot']);
    // score is computed, never written by clients
    expect((await api('PATCH', `/api/v1/records/lead/${l.json.id}`, { score: 5 })).status).toBe(400);
    const res = await api('POST', '/api/admin/rules/scoring/rescore');
    expect(res.status).toBe(200);
    expect(res.json.updated).toBeGreaterThan(0);
  });

  it('partner attribution, aging and last activity', async () => {
    const arch = await api('POST', '/api/v1/records/account', { name: 'Studio Arc', account_type: 'architect' });
    expect(arch.status, JSON.stringify(arch.json)).toBe(201);
    const l = await api('POST', '/api/v1/records/lead', { last_name: 'Shah', source: 'architect', referred_by_id: arch.json.id, next_follow_up_at: new Date(Date.now() - 60_000).toISOString() });
    expect(l.json.referred_by_id).toBe(arch.json.id);
    expect(l.json.last_activity_at).toBeNull();
    await api('POST', `/api/v1/records/lead/${l.json.id}/activities`, { kind: 'visit', subject: 'Showroom visit', location: { lat: 18.52, lng: 73.85, accuracy: 20 }, outcome: 'Liked the sofa range' });
    const after = (await api('GET', `/api/v1/records/lead/${l.json.id}`)).json;
    expect(after.last_activity_at).toBeTruthy();
    const tl = (await api('GET', `/api/v1/records/lead/${l.json.id}/timeline`)).json.items;
    expect(tl[0].metadata.location.lat).toBe(18.52);

    const src = (await api('GET', '/api/v1/insights/lead-sources')).json;
    expect(src.byPartner[0]).toMatchObject({ name: 'Studio Arc', leads: 1 });
    expect(src.bySource.some((s: Json) => s.source === 'walk_in' && s.leads === 5)).toBe(true);
    const aging = (await api('GET', '/api/v1/insights/lead-aging')).json;
    expect(aging.byAge.find((b: Json) => b.bucket === '0-2').n).toBeGreaterThan(5);
    expect(aging.byOwner.length).toBeGreaterThan(0);
    // reps only see their own leads in insights
    const mine = (await rep1('GET', '/api/v1/insights/lead-aging')).json;
    expect(mine.byOwner.every((o: Json) => o.owner_id === ids['rep1@acme.test'])).toBe(true);

    // the reminder sweep notifies the owner about the due follow-up once
    const db = Db.fromEnv(h.env);
    try {
      await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
      await db.tx({ tenantId }, (tx) => sweepTenant(tx, tenantId));
    } finally {
      await db.close();
    }
    const n = (await api('GET', '/api/v1/notifications')).json.items.filter((x: Json) => x.kind === 'follow_up');
    expect(n.length).toBe(1);
    expect(n[0].title).toBe('Follow up with Shah');
  });
});

describe('quote approvals and revisions', () => {
  let quoteId: string;

  it('a discount rule requires approval before sending', async () => {
    expect((await api('POST', '/api/admin/rules/approval', { objectKey: 'lead', name: 'x', criteria: [{ field: 'source', op: 'eq', value: 'x' }], approverType: 'owner' })).status).toBe(400);
    expect((await api('POST', '/api/admin/rules/approval', { objectKey: 'quote', name: 'x', criteria: [{ field: 'grand_total', op: 'gt', value: 1 }], approverType: 'user' })).status).toBe(400);
    const r = await api('POST', '/api/admin/rules/approval', { objectKey: 'quote', name: 'Discount over 10%', criteria: [{ field: 'max_discount_pct', op: 'gt', value: 10 }], approverType: 'manager' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);

    quoteId = (await rep1('POST', '/api/v1/records/quote', { name: 'Kapoor living room' })).json.id;
    const lines = await rep1('PUT', `/api/v1/quotes/${quoteId}/lines`, { lines: [{ name: 'Sofa set', quantity: 1, unitPrice: 120000, discountPct: 15, taxRate: 18 }] });
    expect(lines.status, JSON.stringify(lines.json)).toBe(200);
    expect(lines.json.quote).toMatchObject({ max_discount_pct: 15, approval_status: 'required' });
    const send = await rep1('POST', `/api/v1/quotes/${quoteId}/send`, {});
    expect(send.status).toBe(400);
    expect(send.json.error.message).toMatch(/needs approval/);

    const sub = await rep1('POST', `/api/v1/approvals/submit/quote/${quoteId}`, { note: 'Festive offer' });
    expect(sub.status, JSON.stringify(sub.json)).toBe(200);
    expect((await rep1('POST', `/api/v1/approvals/submit/quote/${quoteId}`, {})).status).toBe(409);
    expect((await rep1('GET', `/api/v1/records/quote/${quoteId}`)).json.approval_status).toBe('pending');

    // the manager sees it in the inbox; the requester and other reps cannot decide
    const inbox = (await manager('GET', '/api/v1/approvals?status=pending')).json.items;
    expect(inbox.length).toBe(1);
    expect(inbox[0]).toMatchObject({ ruleName: 'Discount over 10%', canDecide: true, requestedByName: 'Ravi Rep' });
    expect(inbox[0].summary.max_discount_pct).toBe(15);
    expect((await manager('GET', '/api/v1/approvals/count')).json.pending).toBe(1);
    const reqId = inbox[0].id;
    expect((await rep1('POST', `/api/v1/approvals/${reqId}/decide`, { approve: true })).status).toBe(403);
    expect((await rep2('POST', `/api/v1/approvals/${reqId}/decide`, { approve: true })).status).toBe(403);
    expect((await manager('POST', `/api/v1/approvals/${reqId}/decide`, { approve: false })).status).toBe(400); // a reason is required
    const n = (await manager('GET', '/api/v1/notifications')).json.items;
    expect(n.some((x: Json) => x.kind === 'approval' && /Kapoor living room/.test(x.title))).toBe(true);

    expect((await manager('POST', `/api/v1/approvals/${reqId}/decide`, { approve: true, comment: 'OK for Diwali' })).status).toBe(200);
    expect((await manager('POST', `/api/v1/approvals/${reqId}/decide`, { approve: true })).status).toBe(409);
    expect((await rep1('GET', `/api/v1/records/quote/${quoteId}`)).json.approval_status).toBe('approved');
    const hist = (await rep1('GET', `/api/v1/approvals/history/quote/${quoteId}`)).json.items;
    expect(hist[0]).toMatchObject({ status: 'approved', decided_by_name: 'Mona Manager', decision_comment: 'OK for Diwali' });
    expect((await rep1('GET', '/api/v1/notifications')).json.items.some((x: Json) => /^Approved: /.test(x.title))).toBe(true);
  });

  it('changing lines after approval needs a fresh approval', async () => {
    const r = await rep1('PUT', `/api/v1/quotes/${quoteId}/lines`, { lines: [{ name: 'Sofa set', quantity: 1, unitPrice: 120000, discountPct: 20, taxRate: 18 }] });
    expect(r.json.quote.approval_status).toBe('required');
    const ok = await rep1('PUT', `/api/v1/quotes/${quoteId}/lines`, { lines: [{ name: 'Sofa set', quantity: 1, unitPrice: 120000, discountPct: 5, taxRate: 18 }] });
    expect(ok.json.quote.approval_status).toBe('not_required');
    expect((await rep1('POST', `/api/v1/quotes/${quoteId}/send`, {})).status).toBe(200);
  });

  it('sent quotes are revised, not edited; revisions keep the family together', async () => {
    expect((await rep1('PUT', `/api/v1/quotes/${quoteId}/lines`, { lines: [] })).status).toBe(400);
    const before = (await rep1('GET', `/api/v1/records/quote/${quoteId}`)).json;
    const rev = await rep1('POST', `/api/v1/quotes/${quoteId}/revise`);
    expect(rev.status, JSON.stringify(rev.json)).toBe(201);
    const r2q = (await rep1('GET', `/api/v1/quotes/${rev.json.id}`)).json;
    expect(r2q.quote).toMatchObject({ quote_number: `${before.quote_number}-R2`, revision: 2, status: 'draft', grand_total: before.grand_total });
    expect(r2q.lines.length).toBe(1);
    expect((await rep1('GET', `/api/v1/records/quote/${quoteId}`)).json.status).toBe('superseded');
    expect((await rep1('POST', `/api/v1/quotes/${quoteId}/revise`)).status).toBe(400);
    expect((await rep1('POST', `/api/v1/quotes/${rev.json.id}/revise`)).status).toBe(400); // drafts are edited directly
    // the old customer link stops resolving
    const token = before.share_token ?? (await rep1('GET', `/api/v1/quotes/${quoteId}`)).json.quote.share_token;
    expect((await h.call('GET', `/api/public/quotes/${token}`)).status).toBe(404);
    await rep1('PUT', `/api/v1/quotes/${rev.json.id}/lines`, { lines: [{ name: 'Sofa set', quantity: 1, unitPrice: 110000, discountPct: 0, taxRate: 18 }] });
    await rep1('POST', `/api/v1/quotes/${rev.json.id}/send`, {});
    const r3 = await rep1('POST', `/api/v1/quotes/${rev.json.id}/revise`);
    const fam = (await rep1('GET', `/api/v1/quotes/${r3.json.id}/revisions`)).json.items;
    expect(fam.map((q: Json) => [q.revision, q.status])).toEqual([[1, 'superseded'], [2, 'superseded'], [3, 'draft']]);
    expect(fam[2].quote_number).toBe(`${before.quote_number}-R3`);
  });
});
