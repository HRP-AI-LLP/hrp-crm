/** Idea → product: an in-house project, the rules, the files as documents, HRP AI switched on and the full delivery run. */
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeR2, type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
let replies: string[] = [];
const seen: string[] = [];

beforeAll(async () => {
  h = await makeHarness('synapse_test_studio');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  h.env.AI = {
    run: async (_model: string, input: any) => {
      if (input?.image) return { description: 'A hand-drawn sketch of the booking screen: a calendar and a Pay with UPI button.' };
      const all = (input?.messages ?? []).map((m: Json) => String(m.content)).join('\n');
      if (all.includes('<document')) return { response: JSON.stringify({ summary: '- Clinic appointment booking with UPI payments', category: 'requirements' }) };
      seen.push(all);
      return { response: replies.shift() ?? JSON.stringify({ say: 'ok' }) };
    },
  } as unknown as Ai;
  await h.signup('studio', 'owner@studio.test');
  api = h.as('studio', (await h.login('studio', 'owner@studio.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
}, 120_000);

const stage = (name: string, bytes: Uint8Array) => api('POST', `/api/v1/sdlc/studio/files?${new URLSearchParams({ name })}`, undefined, { headers: { 'content-type': 'application/octet-stream' }, bin: bytes });

describe('idea → product', () => {
  it('sets up the project, rules, documents, the coding agent and the full delivery from an idea', async () => {
    const notes = await stage('clinic idea notes.txt', new TextEncoder().encode('Patients book a slot with a doctor, pay the fee by UPI, get WhatsApp reminders.'));
    expect(notes.status, JSON.stringify(notes.json)).toBe(201);
    const sketch = await stage('booking-sketch.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    expect(sketch.status).toBe(201);

    const r = await api('POST', '/api/v1/sdlc/studio/start', {
      idea: 'A mobile app for small clinics in India: patients book appointments, pay by UPI and get WhatsApp reminders; doctors see the day list.',
      name: 'ClinicSlot',
      productType: 'mobile_app',
      audience: 'Clinics in tier-2 cities and their patients',
      stack: 'Flutter, NestJS, PostgreSQL',
      rules: '- Hindi and English UI\n- No patient data leaves India',
      fileIds: [notes.json.id, sketch.json.id],
      start: false,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ids.project = r.json.projectId;
    ids.run = r.json.runId;
    expect(r.json).toMatchObject({ name: 'ClinicSlot', documents: 2, link: `/projects/${ids.project}` });

    const p = (await api('GET', `/api/v1/records/project/${ids.project}`)).json;
    expect(p).toMatchObject({ name: 'ClinicSlot', project_kind: 'in_house', product_type: 'mobile_app', status: 'active' });

    const docs = (await api('GET', `/api/v1/projects/${ids.project}/client-docs`)).json.items as Json[];
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.read_status === 'read')).toBe(true);
    expect(docs.find((d) => d.file_name === 'booking-sketch.png')!.summary).toContain('UPI');

    expect((await api('GET', `/api/v1/projects/${ids.project}/ai-rules`)).json).toMatchObject({ rules: '- Hindi and English UI\n- No patient data leaves India', canEdit: true });
    const s = (await api('GET', `/api/v1/projects/${ids.project}/agent`)).json.settings;
    expect(s).toMatchObject({ enabled: true, workMode: 'batch' });

    const run = (await api('GET', `/api/v1/sdlc/runs/${ids.run}`)).json;
    const titles = (run.steps as Json[]).map((x) => x.title);
    expect(titles[0]).toBe('Product requirements (PRD)');
    expect(titles).toContain('App store release: Play Store / App Store');
    expect(titles).toContain('Implement with the coding agent');
    expect(titles.indexOf('App store release: Play Store / App Store')).toBeLessThan(titles.indexOf('Implement with the coding agent'));
    expect(run.run.goal).toContain('android, ios');
    expect(run.run.goal).toContain('Flutter, NestJS');

    const st = (await api('GET', `/api/v1/sdlc/studio/${ids.project}`)).json;
    expect(st.documents).toMatchObject({ n: 2, read: 2 });
    expect(st.run.run.id).toBe(ids.run);
  });

  it('keeps the rules editable and gives them to the coding agent', async () => {
    const put = await api('PUT', `/api/v1/projects/${ids.project}/ai-rules`, { rules: 'Use Hindi and English. Keep data in India. 90% test coverage.' });
    expect(put.status).toBe(200);
    expect(put.json.rules).toContain('90% test coverage');
    const k = await api('POST', `/api/v1/projects/${ids.project}/agent/keys`, { name: 'Laptop' });
    expect(k.status, JSON.stringify(k.json)).toBe(201);
    const r = await h.call('POST', '/api/v1/mcp', {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'setup_project', arguments: {} } },
      headers: { authorization: `Bearer ${k.json.key}` },
    });
    expect(r.status).toBe(200);
    expect(r.json.result.structuredContent).toMatchObject({ project: { name: 'ClinicSlot' }, rules: 'Use Hindi and English. Keep data in India. 90% test coverage.', workMode: 'batch' });
  });

  it('refuses files that are not the person’s own', async () => {
    const mine = await stage('spec.txt', new TextEncoder().encode('A simple spec for a to-do app with reminders.'));
    await api('POST', '/api/admin/users', { email: 'dev@studio.test', fullName: 'Dev Two', password: PW, roles: ['admin'] });
    const other = h.as('studio', (await h.login('studio', 'dev@studio.test')).token);
    const r = await other('POST', '/api/v1/sdlc/studio/start', { idea: 'A to-do app with reminders for small shop owners in India.', fileIds: [mine.json.id], start: false });
    expect(r.status).toBe(400);
  });

  it('the assistant takes an idea with attachments and proposes starting the product', async () => {
    const f = await stage('brd.txt', new TextEncoder().encode('Kirana store billing app: GST invoices, khata, UPI.'));
    replies = [
      JSON.stringify({
        say: 'I will set up **KhataPro** and start the delivery.',
        propose: [{ method: 'POST', path: '/api/v1/sdlc/studio/start', body: { idea: 'Billing and khata app for kirana stores with GST invoices and UPI.', name: 'KhataPro', productType: 'mobile_app', fileIds: [f.json.id], start: false }, summary: 'Start KhataPro from the idea' }],
      }),
    ];
    const c = await api('POST', '/api/v1/assistant/chat', { message: 'Build me a billing app for kirana stores', attachments: [{ id: f.json.id, name: 'brd.txt' }] });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(seen.at(-1)).toContain(`brd.txt (file id ${f.json.id})`);
    expect(seen.at(-1)).toContain('/api/v1/sdlc/studio/start');
    const user = (c.json.messages as Json[]).find((m) => m.role === 'user')!;
    expect(user.data.attachments[0].name).toBe('brd.txt');
    const card = (c.json.actions as Json[])[0]!;
    const ok = await api('POST', `/api/v1/assistant/actions/${card.id}/approve`, {});
    expect(ok.json, JSON.stringify(ok.json)).toMatchObject({ status: 'done' });
    expect(ok.json.result).toMatchObject({ name: 'KhataPro', documents: 1 });
  });
});
