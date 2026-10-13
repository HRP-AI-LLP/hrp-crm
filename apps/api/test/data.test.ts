import { beforeAll, describe, expect, it } from 'vitest';
import { normaliseDate } from '../src/services/data';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let other: ReturnType<typeof h.as>;
let repId: string;

beforeAll(async () => {
  h = await makeHarness('synapse_test_data');
  await h.signup('acme', 'owner@acme.test');
  await h.signup('globex', 'owner@globex.test');
  api = h.as('acme', (await h.login('acme', 'owner@acme.test')).token);
  other = h.as('globex', (await h.login('globex', 'owner@globex.test')).token);
  const u = await api('POST', '/api/admin/users', { email: 'rep@acme.test', fullName: 'Rep One', password: PW, roles: ['sales_rep'] });
  repId = u.json.id;
  rep = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
}, 90_000);

describe('saved views', () => {
  it('personal views are private; shared views need admin and are visible to all', async () => {
    const mine = await rep('POST', '/api/v1/views/lead', { name: 'My hot leads', filters: [{ field: 'owner_id', op: 'eq', value: '$me' }], columns: ['company', 'email'] });
    expect(mine.status, JSON.stringify(mine.json)).toBe(201);
    expect((await rep('POST', '/api/v1/views/lead', { name: 'Team', isShared: true })).status).toBe(403);
    const shared = await api('POST', '/api/v1/views/lead', { name: 'Website leads', isShared: true, filters: [{ field: 'source', op: 'eq', value: 'website' }] });
    expect(shared.status).toBe(201);
    const repViews = (await rep('GET', '/api/v1/views/lead')).json.items.map((v: Json) => v.name);
    expect(repViews.sort()).toEqual(['My hot leads', 'Website leads']);
    const adminViews = (await api('GET', '/api/v1/views/lead')).json.items.map((v: Json) => v.name);
    expect(adminViews).toEqual(['Website leads']);
    expect((await other('GET', '/api/v1/views/lead')).json.items).toEqual([]);
  });

  it('$me in a filter resolves to the signed-in user, and count returns totals', async () => {
    await rep('POST', '/api/v1/records/lead', { last_name: 'Mine-1' });
    await rep('POST', '/api/v1/records/lead', { last_name: 'Mine-2' });
    await api('POST', '/api/v1/records/lead', { last_name: 'Not-mine' });
    const f = encodeURIComponent(JSON.stringify([{ field: 'owner_id', op: 'eq', value: '$me' }]));
    const r = await api('GET', `/api/v1/records/lead?filters=${f}&count=1`);
    expect(r.json.items.map((i: Json) => i.last_name)).toEqual(['Not-mine']);
    expect(r.json.total).toBe(1);
  });
});

describe('bulk actions', () => {
  it('updates and deletes many records, reporting per-record failures', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await api('POST', '/api/v1/records/lead', { last_name: `Bulk-${i}` })).json.id);
    const up = await api('POST', '/api/v1/records/lead/bulk', { action: 'update', ids, patch: { source: 'event', owner_id: repId } });
    expect(up.json).toEqual({ succeeded: 4, failed: [] });
    // the rep owns them now, but sales_rep has delete "none"
    const del = await rep('POST', '/api/v1/records/lead/bulk', { action: 'delete', ids });
    expect(del.json.succeeded).toBe(0);
    expect(del.json.failed).toHaveLength(4);
    const ok = await api('POST', '/api/v1/records/lead/bulk', { action: 'delete', ids: [ids[0], ids[1]] });
    expect(ok.json.succeeded).toBe(2);
    const bad = await api('POST', '/api/v1/records/lead/bulk', { action: 'update', ids: [ids[2]], patch: { email: 'not-an-email' } });
    expect(bad.json.failed[0].error).toMatch(/Validation/);
  });

  it("cannot touch another workspace's records", async () => {
    const id = (await api('POST', '/api/v1/records/lead', { last_name: 'Private' })).json.id;
    const r = await other('POST', '/api/v1/records/lead/bulk', { action: 'delete', ids: [id] });
    expect(r.json.succeeded).toBe(0);
    expect((await api('GET', `/api/v1/records/lead/${id}`)).status).toBe(200);
  });
});

describe('CSV import', () => {
  it('normalises Indian date formats', () => {
    expect(normaliseDate('31/12/2026')).toBe('2026-12-31');
    expect(normaliseDate('5-1-2027')).toBe('2027-01-05');
    expect(normaliseDate('2026-03-09')).toBe('2026-03-09');
  });

  it('creates records with friendly values (labels, yes/no, ₹ amounts, owner email, stage label) and reports bad rows', async () => {
    await api('PUT', '/api/admin/objects/lead/fields/budget', { label: 'Budget', type: 'currency', indexed: true });
    await api('PUT', '/api/admin/objects/lead/fields/vip', { label: 'VIP', type: 'boolean' });
    const job = await api('POST', '/api/v1/import/lead/jobs', { fileName: 'leads.csv', totalRows: 3 });
    expect(job.status, JSON.stringify(job.json)).toBe(201);
    const rows = [
      { first_name: 'Asha', last_name: 'Rao', email: 'asha@rao.test', source: 'Referral', budget: '₹12,50,000', vip: 'Yes', owner_id: 'rep@acme.test', stage_id: 'Qualified' },
      { last_name: 'Bad', email: 'nope' },
      { first_name: 'Vikram', last_name: 'Shah', email: 'vikram@shah.test', budget: '5000' },
    ];
    const r = await api('POST', `/api/v1/import/lead/jobs/${job.json.id}/rows`, { startRow: 2, rows });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.created).toBe(2);
    expect(r.json.failed).toHaveLength(1);
    expect(r.json.failed[0].row).toBe(3);
    const fin = await api('POST', `/api/v1/import/lead/jobs/${job.json.id}/finish`);
    expect(fin.json).toMatchObject({ status: 'completed', created: 2, failed: 1 });
    const f = encodeURIComponent(JSON.stringify([{ field: 'email', op: 'eq', value: 'asha@rao.test' }]));
    const asha = (await api('GET', `/api/v1/records/lead?filters=${f}`)).json.items[0];
    expect(asha).toMatchObject({ source: 'referral', budget: 1250000, vip: true, owner_id: repId });
    const meta = (await api('GET', '/api/v1/meta')).json;
    const stage = meta.pipelines.flatMap((p: Json) => p.stages).find((s: Json) => s.id === asha.stage_id);
    expect(stage.label).toBe('Qualified');
  });

  it('upsert updates existing records matched by email', async () => {
    const job = await api('POST', '/api/v1/import/lead/jobs', { totalRows: 2, mode: 'upsert', matchField: 'email' });
    const r = await api('POST', `/api/v1/import/lead/jobs/${job.json.id}/rows`, { startRow: 2, rows: [{ email: 'asha@rao.test', last_name: 'Rao', company: 'Rao Infra' }, { email: 'new@one.test', last_name: 'New' }] });
    expect(r.json).toMatchObject({ created: 1, updated: 1 });
  });

  it("only the user who started an import can add rows to it", async () => {
    const job = await api('POST', '/api/v1/import/lead/jobs', { totalRows: 1 });
    expect((await rep('POST', `/api/v1/import/lead/jobs/${job.json.id}/rows`, { startRow: 2, rows: [{ last_name: 'x' }] })).status).toBe(403);
    expect((await other('POST', `/api/v1/import/lead/jobs/${job.json.id}/rows`, { startRow: 2, rows: [{ last_name: 'x' }] })).status).toBe(404);
  });
});

describe('CSV export', () => {
  it('exports visible fields with names instead of ids, guards formulas, and is audited', async () => {
    await api('POST', '/api/v1/records/lead', { last_name: '=HYPERLINK("http://evil")', company: 'Formula Co' });
    const r = await api('GET', '/api/v1/export/lead', undefined, { raw: true });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');
    const lines = r.text.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toContain('Last name');
    expect(r.text).toContain("'=HYPERLINK");
    expect(r.text).toContain('Rep One');
    const audit = await api('GET', '/api/admin/audit?action=export');
    expect(audit.json.items.length).toBeGreaterThan(0);
  });

  it('respects field-level security', async () => {
    await api('POST', '/api/admin/roles', {
      key: 'no_budget', name: 'No budget',
      permissions: { objects: { '*': { read: 'all', create: true, update: 'own', delete: 'none' } }, fields: { lead: { budget: 'hidden' } } },
    });
    const users = (await api('GET', '/api/admin/users')).json.items;
    await api('PATCH', `/api/admin/users/${users.find((u: Json) => u.email === 'rep@acme.test').id}`, { roles: ['no_budget'] });
    const repNow = h.as('acme', (await h.login('acme', 'rep@acme.test')).token);
    const r = await repNow('GET', '/api/v1/export/lead', undefined, { raw: true });
    expect(r.text.split('\r\n')[0]).not.toContain('Budget');
    expect(r.text).not.toContain('1250000');
  });
});

describe('duplicates and merge', () => {
  let a: string;
  let b: string;
  it('finds duplicates by email, phone and similar name', async () => {
    a = (await api('POST', '/api/v1/records/contact', { first_name: 'Priya', last_name: 'Sharma', email: 'priya@x.test', phone: '+91 98200 00001' })).json.id;
    b = (await api('POST', '/api/v1/records/contact', { first_name: 'Priya', last_name: 'Sharmaa', phone: '098200-00001' })).json.id;
    await api('POST', '/api/v1/records/contact', { first_name: 'Rahul', last_name: 'Verma' });
    const d = await api('GET', `/api/v1/records/contact/${a}/duplicates`);
    expect(d.json.matches).toHaveLength(1);
    expect(d.json.matches[0].id).toBe(b);
    expect(d.json.matches[0].reasons).toEqual(expect.arrayContaining(['Same phone', 'Similar name']));
    const pre = await api('POST', '/api/v1/records/contact/check-duplicates', { email: 'PRIYA@x.test' });
    expect(pre.json.matches.map((m: Json) => m.id)).toContain(a);
    expect((await other('POST', '/api/v1/records/contact/check-duplicates', { email: 'priya@x.test' })).json.matches).toEqual([]);
  });

  it('merges: fills empty fields, re-points children and lookups, soft-deletes the duplicate', async () => {
    await api('PATCH', `/api/v1/records/contact/${b}`, { title: 'CFO' });
    const acc = (await api('POST', '/api/v1/records/account', { name: 'Skyline' })).json.id;
    const deal = (await api('POST', '/api/v1/records/deal', { name: 'Big deal', contact_id: b, account_id: acc })).json.id;
    await api('POST', '/api/v1/tasks', { title: 'Call Priya', relatedObject: 'contact', relatedId: b });
    const m = await api('POST', '/api/v1/records/contact/merge', { masterId: a, duplicateIds: [b] });
    expect(m.status, JSON.stringify(m.json)).toBe(200);
    const master = (await api('GET', `/api/v1/records/contact/${a}`)).json;
    expect(master.title).toBe('CFO');
    expect(master.last_name).toBe('Sharma');
    expect((await api('GET', `/api/v1/records/contact/${b}`)).status).toBe(404);
    expect((await api('GET', `/api/v1/records/deal/${deal}`)).json.contact_id).toBe(a);
    const tasks = await api('GET', `/api/v1/tasks?relatedObject=contact&relatedId=${a}`);
    expect(tasks.json.items.map((t: Json) => t.title)).toContain('Call Priya');
    const tl = await api('GET', `/api/v1/records/contact/${a}/timeline`);
    expect(tl.json.items[0].subject).toBe('Merged 1 duplicate');
  });

  it('a user without delete permission cannot merge', async () => {
    const x = (await rep('POST', '/api/v1/records/contact', { last_name: 'Dup' })).json.id;
    const y = (await rep('POST', '/api/v1/records/contact', { last_name: 'Dup' })).json.id;
    expect((await rep('POST', '/api/v1/records/contact/merge', { masterId: x, duplicateIds: [y] })).status).toBe(403);
  });
});

describe('related records', () => {
  it('lists every object that looks up to the record, including custom objects', async () => {
    await api('POST', '/api/admin/objects', { key: 'project', label: 'Project', plural: 'Projects' });
    await api('PUT', '/api/admin/objects/project/fields/client', { label: 'Client', type: 'lookup', options: { lookupObject: 'account' } });
    const acc = (await api('POST', '/api/v1/records/account', { name: 'Nimbus' })).json.id;
    await api('POST', '/api/v1/records/contact', { last_name: 'Mehta', account_id: acc });
    await api('POST', '/api/v1/records/deal', { name: 'Licence', account_id: acc });
    await api('POST', '/api/v1/records/project', { name: 'Rollout', client: acc });
    const r = await api('GET', `/api/v1/records/account/${acc}/related`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const labels = r.json.groups.map((g: Json) => `${g.object}.${g.field}`).sort();
    expect(labels).toEqual(['contact.account_id', 'deal.account_id', 'project.client']);
    expect(r.json.groups.find((g: Json) => g.object === 'project').items[0].title).toBe('Rollout');
  });
});
