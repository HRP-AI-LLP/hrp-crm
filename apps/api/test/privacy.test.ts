import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/lib/crypto';
import { Db } from '../src/lib/db';
import { unsubscribeToken } from '../src/services/privacy';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
let tenantId = '';
let erasedContact = '';
const mails: { to: string; text: string }[] = [];
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
  h = await makeHarness('synapse_test_privacy');
  h.env.RESEND_API_KEY = 're_test';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://api.resend.com/')) {
      const b = JSON.parse(String(init?.body ?? '{}'));
      mails.push({ to: b.to[0], text: b.text });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  await h.signup('privco', 'owner@privco.test');
  api = h.as('privco', (await h.login('privco', 'owner@privco.test')).token);
  tenantId = (await api('GET', '/api/auth/me')).json.tenant.id;
  await api('POST', '/api/admin/users', { email: 'rep@privco.test', fullName: 'Ravi Rep', password: PW, roles: ['sales_rep'] });
  rep = h.as('privco', (await h.login('privco', 'rep@privco.test')).token);
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('consent', () => {
  let leadId = '';
  it('web forms record consent with evidence', async () => {
    const f = await api('POST', '/api/admin/forms', { objectKey: 'lead', name: 'Enquiry', kind: 'public', layout: { sections: [{ fields: ['last_name', 'email', 'phone'] }] }, settings: { consentText: 'Send me offers on WhatsApp and email' } });
    expect(f.status).toBe(201);
    const r = await h.call('POST', `/api/public/forms/${f.json.public_key}`, { body: { last_name: 'Kapoor', email: 'neha@x.test', phone: '+91 98111 22233', consent: true } });
    expect(r.status).toBe(201);
    leadId = (await sql(`select id from leads where email = 'neha@x.test'`))[0]!.id;
    const c = await api('GET', `/api/v1/consent/lead/${leadId}`);
    expect(c.status).toBe(200);
    expect(c.json.state.marketing.granted).toBe(true);
    expect(c.json.events[0]).toMatchObject({ purpose: 'marketing', granted: true, source: 'web_form' });
    expect(c.json.events[0].evidence.text).toBe('Send me offers on WhatsApp and email');
  });

  it('withdrawing consent adds the addresses to the do-not-contact list; opting back in lifts it', async () => {
    const w = await api('POST', `/api/v1/consent/lead/${leadId}`, { purpose: 'whatsapp', granted: false, note: 'Asked on call' });
    expect(w.status).toBe(200);
    expect(w.json.suppressed).toEqual([{ channel: 'whatsapp', reason: 'opt_out' }]);
    const s = await api('GET', '/api/admin/privacy/suppressions?q=9811122233');
    expect(s.json.items).toHaveLength(1);
    const back = await api('POST', `/api/v1/consent/lead/${leadId}`, { purpose: 'whatsapp', granted: true });
    expect(back.json.suppressed).toEqual([]);
    expect(back.json.events).toHaveLength(3);
  });

  it('consent evidence cannot be rewritten', async () => {
    const db = Db.fromEnv(h.env);
    try {
      await expect(db.tx({ tenantId }, (tx) => tx.query(`delete from consent_events`))).rejects.toThrow(/permission/);
    } finally {
      await db.close();
    }
  });

  it('a signed unsubscribe link opts the person out of that channel', async () => {
    const token = await unsubscribeToken(h.env, tenantId, 'email', 'neha@x.test');
    const g = await h.call('GET', `/api/public/unsubscribe/${token}`);
    expect(g.json).toMatchObject({ channel: 'email', address: 'n•••@x.test' });
    expect((await h.call('POST', `/api/public/unsubscribe/${token}`)).status).toBe(200);
    const c = await api('GET', `/api/v1/consent/lead/${leadId}`);
    expect(c.json.state.email.granted).toBe(false);
    expect((await h.call('GET', `/api/public/unsubscribe/${token.slice(0, -2)}xx`)).status).toBe(404);
  });

  it('people without access to the record cannot read or change consent', async () => {
    expect((await rep('GET', `/api/v1/consent/lead/${leadId}`)).status).toBe(404);
    expect((await rep('GET', '/api/admin/privacy')).status).toBe(403);
  });
});

describe('privacy portal and data-principal requests', () => {
  let key = '';
  let statusToken = '';
  let reqId = '';
  let contactId = '';
  it('the portal opens only with a grievance officer and shows the published notice', async () => {
    const cfg = { portalEnabled: true, officerName: 'Asha Iyer', officerEmail: '', officerPhone: '', requestSlaDays: 30, retention: { leadsUnconvertedMonths: 0, lostDealsMonths: 0, messagesMonths: 0, recordingsMonths: 0, recycleBinDays: 0 } };
    expect((await api('PUT', '/api/admin/privacy/config', cfg)).status).toBe(400);
    expect((await api('PUT', '/api/admin/privacy/config', { ...cfg, officerEmail: 'dpo@privco.test' })).status).toBe(200);
    const tpl = await api('GET', '/api/admin/privacy/notice-template');
    expect(tpl.json.body).toContain('Data Protection Board of India');
    const n = await api('POST', '/api/admin/privacy/notices', { title: 'Privacy notice', body: tpl.json.body, purposes: [{ key: 'marketing', label: 'Offers on WhatsApp', required: false }], publish: true });
    expect(n.status).toBe(201);
    const p = await api('GET', '/api/admin/privacy');
    key = new URL(p.json.portalUrl).pathname.split('/').pop()!;
    const pub = await h.call('GET', `/api/public/privacy/${key}`);
    expect(pub.status).toBe(200);
    expect(pub.json.officer.email).toBe('dpo@privco.test');
    expect(pub.json.notices[0].version).toBe(1);
  });

  it('portal requests are verified by email before anyone acts on them', async () => {
    contactId = (await api('POST', '/api/v1/records/contact', { first_name: 'Vikram', last_name: 'Shah', email: 'vikram@x.test', phone: '9822001100' })).json.id;
    await api('POST', `/api/v1/records/contact/${contactId}/activities`, { kind: 'note', subject: 'Visited showroom', body: 'Wants a 3BHK kitchen' });
    const r = await h.call('POST', `/api/public/privacy/${key}/requests`, { body: { kind: 'erasure', name: 'Vikram Shah', email: 'vikram@x.test', details: 'Please delete my data' } });
    expect(r.status).toBe(201);
    expect(r.json.verificationEmailed).toBe(true);
    statusToken = r.json.statusUrl.split('/').pop();
    const link = mails.at(-1)!.text.match(/\/privacy\/verify\/(\S+)/)![1]!;
    expect((await h.call('POST', '/api/public/privacy-verify', { body: { token: `${link.split('.')[0]}.wrongwrongwrongwrongwrong` } })).status).toBe(400);
    const v = await h.call('POST', '/api/public/privacy-verify', { body: { token: link } });
    expect(v.status).toBe(200);
    const list = await api('GET', '/api/admin/privacy/requests');
    reqId = list.json.items[0].id;
    const d = await api('GET', `/api/admin/privacy/requests/${reqId}`);
    // the verified email matched exactly one record, so it is linked automatically
    expect(d.json).toMatchObject({ status: 'in_progress', subject_object: 'contact', subject_id: contactId });
    const st = await h.call('GET', `/api/public/privacy-status/${statusToken}`);
    expect(st.json).toMatchObject({ kind: 'erasure', status: 'in_progress' });
  });

  it('access requests export a machine-readable summary', async () => {
    const r = await api('GET', `/api/admin/privacy/requests/${reqId}/export`, undefined, { raw: true });
    expect(r.status).toBe(200);
    const data = JSON.parse(r.text);
    expect(data.personalData.Email).toBe('vikram@x.test');
    expect(data.timeline.length).toBeGreaterThan(0);
  });

  it('erasure anonymises the person, keeps a hashed block and masks their audit history', async () => {
    expect((await api('POST', `/api/admin/privacy/requests/${reqId}/complete`, { outcome: 'completed', resolution: 'Erased your data' })).status).toBe(400);
    // their WhatsApp thread, a plain-text opt-out and a notification about it
    const acc = (await sql(`insert into channel_accounts (tenant_id, channel, name, provider) values ($1, 'whatsapp', 'WA', 'meta_cloud') returning id`, [tenantId]))[0]!.id;
    const conv = (await sql(`insert into conversations (tenant_id, channel_account_id, channel, address) values ($1, $2, 'whatsapp', '919822001100') returning id`, [tenantId, acc]))[0]!.id;
    await sql(`insert into messages (tenant_id, channel_account_id, channel, direction, from_addr, body, status, conversation_id) values ($1,$2,'whatsapp','in','919822001100','My flat is 4B, Palm Court','received',$3)`, [tenantId, acc, conv]);
    await sql(`insert into suppressions (tenant_id, channel, address_key, reason) values ($1, 'whatsapp', '9822001100', 'opt_out')`, [tenantId]);
    const owner = (await api('GET', '/api/auth/me')).json.user.id;
    await sql(`insert into notifications (tenant_id, user_id, kind, title, link) values ($1, $2, 'message', 'WhatsApp from Vikram', $3)`, [tenantId, owner, `/inbox?c=${conv}`]);
    const done = await api('POST', `/api/admin/privacy/requests/${reqId}/complete`, { outcome: 'completed', resolution: 'We erased your personal data.', erase: true });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.erasure).toMatchObject({ records: 1, activities: 1 });
    erasedContact = contactId;
    const row = (await sql(`select full_name, email, phone, deleted_at from contacts where id = $1`, [contactId]))[0]!;
    expect(row).toMatchObject({ full_name: 'Erased person', email: null, phone: null });
    expect(row.deleted_at).not.toBeNull();
    const sup = await sql(`select address_key, reason from suppressions where reason = 'erasure'`);
    expect(sup.length).toBe(4);
    expect(sup.every((s) => String(s.address_key).startsWith('h:'))).toBe(true);
    expect(JSON.stringify(sup)).not.toContain('vikram');
    expect(await sql(`select 1 from conversations where id = $1`, [conv])).toHaveLength(0);
    expect(await sql(`select 1 from messages where body like '%Palm Court%'`)).toHaveLength(0);
    expect(await sql(`select 1 from suppressions where address_key = '9822001100'`)).toHaveLength(0);
    expect(await sql(`select 1 from notifications where title = 'WhatsApp from Vikram'`)).toHaveLength(0);
    const audit = await api('GET', `/api/admin/audit?record=${contactId}`);
    expect(JSON.stringify(audit.json)).not.toContain('vikram@x.test');
    expect(mails.at(-1)!.text).toContain('We erased your personal data.');
    const st = await h.call('GET', `/api/public/privacy-status/${statusToken}`);
    expect(st.json.status).toBe('completed');
  });

  it('a re-imported erased person is still blocked from marketing', async () => {
    const again = (await api('POST', '/api/v1/records/contact', { last_name: 'Shah', email: 'Vikram@x.test' })).json.id;
    await api('POST', `/api/v1/consent/contact/${again}`, { purpose: 'marketing', granted: true });
    const c = await api('GET', `/api/v1/consent/contact/${again}`);
    expect(c.json.suppressed.map((s: Json) => s.reason)).toContain('erasure');
  });

  it('requests created by staff need manual verification with a note', async () => {
    const r = await api('POST', '/api/admin/privacy/requests', { kind: 'grievance', name: 'Walk-in', phone: '9000000000', details: 'Got too many calls' });
    expect(r.status).toBe(201);
    expect((await api('POST', `/api/admin/privacy/requests/${r.json.id}/complete`, { outcome: 'completed', resolution: 'Spoke to them' })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/privacy/requests/${r.json.id}`, { markVerified: true })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/privacy/requests/${r.json.id}`, { markVerified: true, verificationNote: 'Called back on the number' })).status).toBe(200);
    expect((await api('POST', `/api/admin/privacy/requests/${r.json.id}/complete`, { outcome: 'completed', resolution: 'Removed from call list' })).status).toBe(200);
    const s = await api('GET', '/api/admin/privacy');
    expect(s.json.stats.closed90).toBe(2);
  });
});

describe('retention, breaches and the audit chain', () => {
  it('retention rules preview, then erase stale unconverted leads', async () => {
    const old = (await api('POST', '/api/v1/records/lead', { last_name: 'Stale', email: 'stale@x.test' })).json.id;
    await sql(`update leads set created_at = now() - interval '30 months' where id = $1`, [old]);
    await api('PUT', '/api/admin/privacy/config', { portalEnabled: true, officerEmail: 'dpo@privco.test', requestSlaDays: 30, retention: { leadsUnconvertedMonths: 24, lostDealsMonths: 0, messagesMonths: 0, recordingsMonths: 0, recycleBinDays: 0 } });
    const p = await api('POST', '/api/admin/privacy/retention/preview');
    expect(p.json.leads).toBe(1);
    expect((await sql(`select email from leads where id = $1`, [old]))[0]!.email).toBe('stale@x.test');
    const r = await api('POST', '/api/admin/privacy/retention/run');
    expect(r.json.leads).toBe(1);
    expect((await sql(`select email from leads where id = $1`, [old]))[0]!.email).toBeNull();
  });

  it('records breaches', async () => {
    const b = await api('POST', '/api/admin/privacy/breaches', { title: 'Laptop stolen', severity: 'high', dataCategories: ['contact details'], affectedCount: 120 });
    expect(b.status).toBe(201);
    expect((await api('PATCH', `/api/admin/privacy/breaches/${b.json.id}`, { status: 'reported', boardIntimatedAt: new Date().toISOString() })).status).toBe(200);
    const l = await api('GET', '/api/admin/privacy/breaches');
    expect(l.json.items[0]).toMatchObject({ status: 'reported', affected_count: 120 });
  });

  it('exports a hash chain that detects tampering', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const r = await api('GET', `/api/admin/audit/export?from=${today}&to=${today}`, undefined, { raw: true });
    expect(r.status).toBe(200);
    const lines = r.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBe(Number(r.headers.get('x-audit-count')));
    let prev = r.headers.get('x-audit-genesis')!;
    for (const l of lines) {
      const { prev: p, hash, ...entry } = l;
      expect(p).toBe(prev);
      expect(hash).toBe(await sha256Hex(prev + JSON.stringify(entry)));
      prev = hash;
    }
    expect(prev).toBe(r.headers.get('x-audit-head'));
    // entries about the erased contact carry no personal data
    expect(lines.filter((l) => l.record === erasedContact && l.action !== 'erase').every((l) => l.changes === null || l.changes.redacted)).toBe(true);
  });
});
