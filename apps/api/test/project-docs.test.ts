/** Client documents on a project: uploaded, read and summarised by the AI, sorted, and used by the agents. */
import { beforeAll, describe, expect, it } from 'vitest';
import { fakeR2, type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
const asked: string[] = [];

beforeAll(async () => {
  h = await makeHarness('synapse_test_projectdocs');
  h.env.FILES = fakeR2() as unknown as R2Bucket;
  h.env.AI = {
    run: async (_model: string, input: any) => {
      if (input?.image) return { description: 'A screenshot of the old payroll screen: Member statement, columns CPF No, Name, Balance; a Print button.' };
      const user = String(input?.messages?.[1]?.content ?? '');
      asked.push(user);
      if (user.includes('<document')) return { response: JSON.stringify({ summary: '- Convert CPF data of staff and labour from the old FoxPro system\n- Year-wise summary per member with monthly drill-down', category: 'brd' }) };
      return { response: 'ok' };
    },
  } as unknown as Ai;
  await h.signup('docco', 'owner@docco.test');
  api = h.as('docco', (await h.login('docco', 'owner@docco.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'CPF conversion' })).json.id;
  await api('PATCH', `/api/v1/records/project/${ids.project}`, { status: 'active' });
}, 120_000);

const up = (name: string, bytes: Uint8Array, q: Record<string, string> = {}) =>
  api('POST', `/api/v1/projects/${ids.project}/client-docs?${new URLSearchParams({ name, ...q })}`, undefined, { headers: { 'content-type': 'application/octet-stream' }, bin: bytes });

describe('client documents', () => {
  it('reads what the client shares, summarises it and sorts it when asked', async () => {
    const brd = new TextEncoder().encode('Business requirements: convert the CPF data of staff and labour from FoxPro. Each member needs a year-wise summary; double-click a year to see months.');
    const r = await up('CPF requirements from client.txt', brd, { sharedBy: 'Deepak Verma', sharedOn: '2026-11-20' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const shot = await up('old-screen.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]), { category: 'existing_system', title: 'Old member statement screen' });
    expect(shot.status, JSON.stringify(shot.json)).toBe(201);
    const list = (await api('GET', `/api/v1/projects/${ids.project}/client-docs`)).json;
    const doc = list.items.find((d: Json) => d.id === r.json.id);
    expect(doc).toMatchObject({ category: 'brd', title: 'CPF requirements from client', shared_by: 'Deepak Verma', read_status: 'read', auto_category: false });
    expect(doc.summary).toContain('FoxPro');
    expect(doc.url).toContain('/api/public/files/');
    const img = list.items.find((d: Json) => d.id === shot.json.id);
    expect(img).toMatchObject({ category: 'existing_system', read_status: 'read' });
    expect(img.summary).toMatch(/payroll screen/);
    expect(list.categories.map((c: Json) => c.key)).toContain('requirements');
  });

  it('can be re-sorted, edited, read again and removed', async () => {
    const list = (await api('GET', `/api/v1/projects/${ids.project}/client-docs`)).json.items as Json[];
    const d = list[0]!;
    expect((await api('PATCH', `/api/v1/projects/${ids.project}/client-docs/${d.id}`, { category: 'requirements', notes: 'v2 from the call' })).status).toBe(200);
    expect((await api('POST', `/api/v1/projects/${ids.project}/client-docs/${d.id}/read`)).status).toBe(200);
    const again = (await api('GET', `/api/v1/projects/${ids.project}/client-docs`)).json.items.find((x: Json) => x.id === d.id);
    expect(again).toMatchObject({ category: 'requirements', notes: 'v2 from the call', read_status: 'read' });
    const gone = await api('DELETE', `/api/v1/projects/${ids.project}/client-docs/${d.id}`);
    expect(gone.status).toBe(200);
    expect((await api('GET', `/api/v1/projects/${ids.project}/client-docs`)).json.items.some((x: Json) => x.id === d.id)).toBe(false);
  });

  it('refuses files it should not keep', async () => {
    expect((await up('run.exe', new Uint8Array([0x4d, 0x5a, 1, 2, 3]))).status).toBe(400);
    expect((await up('empty.txt', new Uint8Array([]))).status).toBe(400);
  });
});
