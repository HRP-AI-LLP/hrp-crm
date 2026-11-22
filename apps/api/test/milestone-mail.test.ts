/** Milestone approval threads: search every mailbox, keep the whole thread (emails + attachments), pick the approval. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/lib/db';
import { sealSecret } from '../src/services/integrations';
import { imapProbe, threadSubject } from '../src/services/mail-threads';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;
const files = new Map<string, Uint8Array>();
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_');
const PDF = '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF';

const mail = (o: { id: string; from: string; subject: string; date: string; body: string; pdf?: boolean }) =>
  [
    `From: ${o.from}`,
    'To: harsha.rani@hrpai.in',
    `Subject: ${o.subject}`,
    `Date: ${o.date}`,
    `Message-ID: <${o.id}@mail.test>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    o.body,
    ...(o.pdf ? ['--b1', 'Content-Type: application/pdf; name="CRAC-signed.pdf"', 'Content-Disposition: attachment; filename="CRAC-signed.pdf"', 'Content-Transfer-Encoding: base64', '', btoa(PDF)] : []),
    '--b1--',
    '',
  ].join('\r\n');

const thread = [
  mail({ id: 'm1', from: 'Harsha Rani <harsha.rani@hrpai.in>', subject: 'Request for Acknowledgement of Completion Within the 120-Day ATC Timeline', date: 'Mon, 02 Mar 2026 10:00:00 +0530', body: 'Dear Sir, please acknowledge completion of Milestone 1.' }),
  mail({ id: 'm2', from: 'Ravi Kumar <ravi@client.gov.in>', subject: 'RE: Request for Acknowledgement of Completion Within the 120-Day ATC Timeline', date: 'Thu, 05 Mar 2026 15:30:00 +0530', body: 'We confirm and approve the completion of Milestone 1. Signed CRAC attached.', pdf: true }),
];

beforeAll(async () => {
  h = await makeHarness('synapse_test_msmail');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith('https://gmail.googleapis.com/')) return realFetch(input, init);
    const j = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
    if (url.includes('/messages?q=')) return j({ messages: [{ id: 'g1', threadId: 'T1' }, { id: 'g2', threadId: 'T1' }] });
    if (url.includes('/threads/T1?format=metadata'))
      return j({ messages: [{ internalDate: String(Date.parse('2026-03-02T04:30:00Z')), payload: { headers: [{ name: 'Subject', value: 'Request for Acknowledgement of Completion Within the 120-Day ATC Timeline' }, { name: 'From', value: 'harsha.rani@hrpai.in' }] } }, { internalDate: String(Date.parse('2026-03-05T10:00:00Z')), payload: { headers: [{ name: 'From', value: 'ravi@client.gov.in' }] } }] });
    if (url.includes('/threads/T1?format=minimal')) return j({ messages: [{ id: 'g1' }, { id: 'g2' }] });
    if (url.includes('/messages/g1?format=raw')) return j({ raw: b64url(thread[0]!) });
    if (url.includes('/messages/g2?format=raw')) return j({ raw: b64url(thread[1]!) });
    return j({ error: { message: `unmocked ${url}` } });
  });
  h.env.FILES = {
    put: async (k: string, v: ArrayBuffer | Uint8Array) => void files.set(k, v instanceof Uint8Array ? v : new Uint8Array(v)),
    get: async (k: string) => (files.has(k) ? { body: new Response(files.get(k)).body, arrayBuffer: async () => files.get(k)!.buffer, httpMetadata: {} } : null),
    delete: async (k: string) => void files.delete(k),
    head: async (k: string) => (files.has(k) ? { size: files.get(k)!.length } : null),
  } as never;
  await h.signup('msco', 'owner@msco.test');
  api = h.as('msco', (await h.login('msco', 'owner@msco.test')).token);
  const me = (await api('GET', '/api/auth/me')).json;
  ids.tenant = me.tenant.id;
  ids.owner = me.user.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'Software for Consultancy' })).json.id;
  const ms = await api('POST', `/api/v1/projects/${ids.project}/milestones`, { name: 'Milestone-1' });
  expect(ms.status, JSON.stringify(ms.json)).toBeLessThan(300);
  ids.ms = ms.json.id;
  const db = Db.fromEnv(h.env);
  try {
    // a team member without a sign-in (no email) must not break keeping a thread
    await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query(`insert into users (tenant_id, email, full_name, status) values ($1, null, 'Site supervisor', 'active')`, [ids.tenant]));
    await db.tx({ tenantId: ids.tenant! }, async (tx) =>
      tx.query(`insert into integrations (tenant_id, provider, user_id, label, account_ref, secret_ciphertext, config) values ($1,'google',$2,'Gmail','harsha.rani@hrpai.in',$3,'{}')`, [
        ids.tenant,
        ids.owner,
        await sealSecret(h.env, ids.tenant!, { accessToken: 'g', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 }),
      ]),
    );
  } finally {
    await db.close();
  }
}, 120_000);
afterAll(() => vi.unstubAllGlobals());

describe('milestone approval threads', () => {
  it('normalises thread subjects', () => {
    expect(threadSubject('RE: Fwd: [EXT] Approval of  Milestone 1')).toBe('approval of milestone 1');
    // IMAP searches ASCII only: the longest plain stretch, not the subject with its dash dropped
    expect(imapProbe('submission of invoice inv-2026000008 for 30% milestone payment – gem contract gemc-511687726792354')).toBe('submission of invoice inv-2026000008 for 30% milestone payment');
  });

  it('finds the thread in a mailbox without a date limit and keeps it, attachments included', async () => {
    const s = await api('GET', `/api/v1/projects/${ids.project}/mail-search?q=${encodeURIComponent('Acknowledgement of Completion')}`);
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect(s.json.sources.map((x: Json) => x.label)).toEqual(['harsha.rani@hrpai.in']);
    expect(s.json.threads).toEqual([expect.objectContaining({ key: 'T1', count: 2, subject: 'Request for Acknowledgement of Completion Within the 120-Day ATC Timeline' })]);
    const t = s.json.threads[0];
    const k = await api('POST', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/mail-thread`, { source: t.source, key: t.key });
    expect(k.status, JSON.stringify(k.json)).toBe(200);
    expect(k.json).toMatchObject({ saved: 2, files: 1, alreadyHere: 0 });
    // the customer's approval comes first
    expect(k.json.messages[0]).toMatchObject({ direction: 'in', looksLikeApproval: true, from: 'ravi@client.gov.in', attachments: 1 });
    const kept = (await api('GET', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/mail`)).json as Json[];
    expect(kept.map((x) => [x.kind, x.file_name?.replace(/^\d{4}-\d{2}-\d{2} /, '')])).toEqual([
      ['email', 'Request for Acknowledgement of Completion Within the 120-Day ATC Timeline.eml'],
      ['email', 'RE Request for Acknowledgement of Completion Within the 120-Day ATC Timeline.eml'],
      ['attachment', 'CRAC-signed.pdf'],
    ]);
    // on the project's timeline, so "Browse emails" finds them too
    const listed = (await api('GET', `/api/v1/projects/${ids.project}/approval-emails?scan=1`)).json.items as Json[];
    expect(listed[0]).toMatchObject({ direction: 'in', looksLikeApproval: true });
    // keeping it again adds nothing
    const again = await api('POST', `/api/v1/projects/${ids.project}/milestones/${ids.ms}/mail-thread`, { source: t.source, key: t.key });
    expect(again.json).toMatchObject({ saved: 0, files: 0, alreadyHere: 2 });
  });
});
