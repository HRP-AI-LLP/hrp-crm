import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { digestSweep, nextRun } from '../src/services/digests';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let me = '';
let repId = '';
const mails: { to: string; subject: string; html: string }[] = [];
const realFetch = globalThis.fetch;

async function sql(q: string, params: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId }, (tx) => tx.query<Json>(q, params));
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_reporting');
  h.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.resend.com/')) {
      const b = JSON.parse(String(init?.body ?? '{}'));
      mails.push({ to: b.to[0], subject: b.subject, html: b.html });
      return Response.json({ id: 'm' });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('repco', 'owner@repco.test');
  api = h.as('repco', (await h.login('repco', 'owner@repco.test')).token);
  const who = (await api('GET', '/api/auth/me')).json;
  tenantId = who.tenant.id;
  me = who.user.id;
  repId = (await api('POST', '/api/admin/users', { email: 'rep@repco.test', fullName: 'Ravi Rep', password: PW, roles: ['sales_rep'] })).json.id;
  rep = h.as('repco', (await h.login('repco', 'rep@repco.test')).token);
  await api('POST', '/api/v1/records/lead', { last_name: 'Owner lead', source: 'website' });
  await api('POST', '/api/v1/records/lead', { last_name: 'Rep lead', source: 'referral', owner_id: repId });
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('schedules', () => {
  it('works out the next send time in IST', () => {
    const after = new Date('2026-10-19T10:00:00+05:30'); // a Monday
    expect(nextRun({ frequency: 'daily', send_hour: 8 }, after).toISOString()).toBe('2026-10-20T02:30:00.000Z');
    expect(nextRun({ frequency: 'daily', send_hour: 18 }, after).toISOString()).toBe('2026-10-19T12:30:00.000Z');
    expect(nextRun({ frequency: 'weekly', send_hour: 9, weekday: 5 }, after).toISOString()).toBe('2026-10-23T03:30:00.000Z');
    expect(nextRun({ frequency: 'monthly', send_hour: 7, monthday: 1 }, after).toISOString()).toBe('2026-11-01T01:30:00.000Z');
  });
});

describe('digests', () => {
  let id = '';
  it('only managers send digests to other people', async () => {
    const body = { name: 'Morning numbers', kind: 'health', frequency: 'daily', sendHour: 8, recipients: [me, repId] };
    expect((await rep('POST', '/api/v1/digests', body)).status).toBe(403);
    expect((await rep('POST', '/api/v1/digests', { ...body, recipients: [repId] })).status).toBe(201);
    const r = await api('POST', '/api/v1/digests', body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    id = r.json.id;
  });

  it('each recipient gets their own numbers', async () => {
    const r = await api('POST', `/api/v1/digests/${id}/send-now`);
    expect(r.json.sent).toBe(2);
    const owner = mails.find((m) => m.to === 'owner@repco.test')!;
    const repMail = mails.find((m) => m.to === 'rep@repco.test')!;
    expect(owner.subject).toContain('Morning numbers');
    // "New leads" row: owner sees 2, the rep sees only theirs
    expect(owner.html).toMatch(/New leads<\/td><td[^>]*>2</);
    expect(repMail.html).toMatch(/New leads<\/td><td[^>]*>1</);
  });

  it('the cron sends due digests and moves the next run on', async () => {
    mails.length = 0;
    await sql(`update report_schedules set next_run_at = now() - interval '1 minute' where id = $1`, [id]);
    const db = Db.fromEnv(h.env);
    try {
      await digestSweep(h.env, db);
    } finally {
      await db.close();
    }
    expect(mails.length).toBe(2);
    const row = (await sql(`select next_run_at, last_sent_at from report_schedules where id = $1`, [id]))[0]!;
    expect(new Date(row.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(row.last_sent_at).not.toBeNull();
  });

  it('a recipient can leave a digest; only the owner deletes it', async () => {
    expect((await rep('DELETE', `/api/v1/digests/${id}`)).status).toBe(200);
    expect((await sql(`select recipients from report_schedules where id = $1`, [id]))[0]!.recipients).toEqual([me]);
  });
});

describe('dashboard share links', () => {
  let dash = '';
  let url = '';
  it('shares a dashboard read-only, computed as the sharer', async () => {
    const rpt = await api('POST', '/api/v1/reports', { name: 'Leads by source', objectKey: 'lead', definition: { type: 'summary', groupBy: 'source', measure: { agg: 'count' } }, isShared: false });
    expect(rpt.status, JSON.stringify(rpt.json)).toBe(201);
    const d = await api('POST', '/api/v1/dashboards', { name: 'Owner board', widgets: [{ reportId: rpt.json.id, size: 'm' }], isShared: false });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    dash = d.json.id;
    expect((await rep('POST', `/api/v1/dashboards/${dash}/share-link`, { days: 7 })).status).toBe(404);
    const s = await api('POST', `/api/v1/dashboards/${dash}/share-link`, { days: 7 });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    url = s.json.url;
    const token = url.split('/share/d/')[1];
    const pub = await h.call('GET', `/api/public/dashboards/${token}`);
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    expect(pub.json.name).toBe('Owner board');
    const total = pub.json.widgets[0].result.rows.reduce((a: number, r: Json) => a + r.n, 0);
    expect(total).toBe(2);
    expect(pub.json.objects[0].fields.length).toBeGreaterThan(0);
  });
  it('expires and can be revoked', async () => {
    const token = url.split('/share/d/')[1];
    await sql(`update dashboards set share_expires_at = now() - interval '1 minute' where id = $1`, [dash]);
    expect((await h.call('GET', `/api/public/dashboards/${token}`)).status).toBe(404);
    expect((await api('DELETE', `/api/v1/dashboards/${dash}/share-link`)).status).toBe(200);
    expect((await sql(`select count(*)::int as n from dashboards where share_token is not null`))[0]!.n).toBe(0);
  });
});

describe('revenue projection', () => {
  it('projects from history and weighted pipeline', async () => {
    const stages = (await api('GET', '/api/v1/meta')).json.pipelines.find((p: Json) => p.objectKey === 'deal' && p.isDefault).stages as Json[];
    const won = stages.find((s) => s.category === 'won')!.id;
    const open = stages.find((s) => s.category === 'open' && s.probability === 50)!.id;
    const w = (await api('POST', '/api/v1/records/deal', { name: 'Won', amount: 120000 })).json.id;
    await api('PATCH', `/api/v1/records/deal/${w}`, { stage_id: won });
    const close = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
    await api('POST', '/api/v1/records/deal', { name: 'Open', amount: 200000, stage_id: open, close_date: close });
    const p = await api('GET', '/api/v1/forecast/projection');
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.history).toHaveLength(6);
    expect(p.json.next).toHaveLength(3);
    expect(p.json.current.wonSoFar).toBe(120000);
    // the open deal closes this month unless today is one of the last two days of the month
    if (close.slice(0, 7) === p.json.current.month) expect(p.json.current.projected).toBe(220000);
  });
});
