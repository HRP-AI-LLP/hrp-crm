/** The workspace assistant: reads as the person, proposes changes, runs them only on approval, as the person. */
import { beforeAll, describe, expect, it } from 'vitest';
import { findRoutes, matchRoute } from '../src/services/assistant';
import { type Json, makeHarness, PW } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
let rep: ReturnType<typeof h.as>;
const ids: Record<string, string> = {};
// the model's replies, in order, and what it was sent
let replies: (string | ((msgs: Json[]) => string))[] = [];
const seen: Json[][] = [];

beforeAll(async () => {
  h = await makeHarness('synapse_test_assistant');
  h.env.AI = {
    run: async (_model: string, input: { messages: Json[] }) => {
      seen.push(input.messages);
      const r = replies.shift();
      if (r === undefined) throw new Error('model down');
      return { response: typeof r === 'function' ? r(input.messages) : r };
    },
  } as unknown as Ai;
  await h.signup('asco', 'owner@asco.test');
  api = h.as('asco', (await h.login('asco', 'owner@asco.test')).token);
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'Fleet app' })).json.id;
  const u = await api('POST', '/api/admin/users', { email: 'rep@asco.test', fullName: 'Ravi Rep', password: PW, roles: ['sales_rep'] });
  expect(u.status).toBe(201);
  rep = h.as('asco', (await h.login('asco', 'rep@asco.test')).token);
}, 120_000);

describe('workspace assistant', () => {
  it('knows the routes and their request schemas', () => {
    expect(matchRoute('POST', '/api/v1/projects/0190a3c2-0000-7000-8000-000000000001/tasks')?.p).toBe('/api/v1/projects/:id/tasks');
    expect(matchRoute('POST', '/api/v1/assistant/chat')).toBeNull();
    expect(matchRoute('POST', '/api/auth/login')).toBeNull();
    expect(matchRoute('GET', '/api/v1/developers/keys')).toBeNull();
    const hits = findRoutes('create sprint agile');
    expect(hits.some((e) => e.p === '/api/v1/projects/:id/agile/sprints' && e.m === 'POST')).toBe(true);
  });

  it('looks things up, then proposes a change that waits for approval', async () => {
    replies = [
      JSON.stringify({ find: ['project tasks'], read: ['/api/v1/projects'] }),
      (msgs) => {
        // it saw the route with its schema and the person's projects
        const last = String(msgs.at(-1)!.content);
        expect(last).toContain('POST /api/v1/projects/:id/tasks');
        expect(last).toContain('taskSchema');
        expect(last).toContain('Fleet app');
        return JSON.stringify({
          say: 'I will add the task to **Fleet app**.',
          propose: [{ method: 'POST', path: `/api/v1/projects/${ids.project}/tasks`, body: { name: 'Fix login on Android', priority: 'high' }, summary: 'Create task "Fix login on Android" (high) in Fleet app' }],
          links: [{ label: 'Open Fleet app', to: `/projects/${ids.project}` }],
        });
      },
    ];
    const r = await api('POST', '/api/v1/assistant/chat', { message: 'Add a high priority task to fix login on Android in the fleet project', page: '/projects' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    ids.thread = r.json.thread.id;
    const last = r.json.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'I will add the task to **Fleet app**.' });
    expect(last.data.steps).toEqual([{ kind: 'find', detail: 'project tasks' }, { kind: 'read', detail: '/api/v1/projects', status: 200 }]);
    expect(r.json.actions).toEqual([expect.objectContaining({ status: 'proposed', method: 'POST', summary: 'Create task "Fix login on Android" (high) in Fleet app' })]);
    ids.action = r.json.actions[0].id;
    // nothing happened yet
    expect((await api('GET', `/api/v1/projects/${ids.project}/tasks`)).json.tasks).toEqual([]);
    // the system prompt knew who and where
    expect(String(seen[0]![0]!.content)).toContain('asco Owner');
    expect(String(seen[0]![0]!.content)).toContain('/projects');
  });

  it('runs an approved change as the person and carries on', async () => {
    // someone else cannot approve it
    expect((await rep('POST', `/api/v1/assistant/actions/${ids.action}/approve`, {})).status).toBe(400);
    const a = await api('POST', `/api/v1/assistant/actions/${ids.action}/approve`, {});
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json).toMatchObject({ status: 'done', httpStatus: 201 });
    const tasks = (await api('GET', `/api/v1/projects/${ids.project}/tasks`)).json.tasks;
    expect(tasks.map((t: Json) => [t.name, t.priority])).toEqual([['Fix login on Android', 'high']]);
    // approving twice does nothing
    expect((await api('POST', `/api/v1/assistant/actions/${ids.action}/approve`, {})).status).toBe(400);
    replies = [
      (msgs) => {
        expect(String(msgs.at(-1)!.content)).toContain('Approved and ran "Create task');
        return JSON.stringify({ say: `Done: task #${tasks[0].task_number} is in Fleet app.` });
      },
    ];
    const c = await api('POST', `/api/v1/assistant/threads/${ids.thread}/continue`, {});
    expect(c.status).toBe(200);
    expect(c.json.messages.at(-1).content).toBe(`Done: task #${tasks[0].task_number} is in Fleet app.`);
  });

  it('never proposes calls outside the API it may use, and a rejected card never runs', async () => {
    replies = [
      JSON.stringify({ say: 'ok', propose: [{ method: 'POST', path: '/api/auth/logout', summary: 'sign out' }] }),
      JSON.stringify({ say: 'I can rename the project.', propose: [{ method: 'PATCH', path: `/api/v1/records/project/${ids.project}`, body: { name: 'Fleet app v2' }, summary: 'Rename the project' }] }),
    ];
    const r = await api('POST', '/api/v1/assistant/chat', { threadId: ids.thread, message: 'sign me out, or rename the project' });
    expect(r.json.actions.filter((x: Json) => x.status === 'proposed').map((x: Json) => x.path)).toEqual([`/api/v1/records/project/${ids.project}`]);
    expect(String(seen.at(-1)!.at(-1)!.content)).toContain('not API routes you may use: POST /api/auth/logout');
    const pending = r.json.actions.find((x: Json) => x.status === 'proposed');
    expect((await api('POST', `/api/v1/assistant/actions/${pending.id}/reject`, {})).json.status).toBe('rejected');
    expect((await api('GET', `/api/v1/records/project/${ids.project}`)).json.name).toBe('Fleet app');
  });

  it('works within the person’s own access', async () => {
    replies = [
      JSON.stringify({ read: [`/api/v1/projects/${ids.project}`] }),
      (msgs) => {
        expect(String(msgs.at(-1)!.content)).toMatch(/GET \/api\/v1\/projects\/[0-9a-f-]+ → (403|404)/);
        return JSON.stringify({ say: "You don't have access to that project." });
      },
    ];
    const r = await rep('POST', '/api/v1/assistant/chat', { message: 'what is happening on the fleet project?' });
    expect(r.json.messages.at(-1).content).toBe("You don't have access to that project.");
    // chats are private
    expect((await rep('GET', `/api/v1/assistant/threads/${ids.thread}`)).status).toBe(404);
    expect((await rep('GET', '/api/v1/assistant/threads')).json.items).toHaveLength(1);
    expect((await api('GET', '/api/v1/assistant/fields/lead')).json.fields.some((f: Json) => f.key === 'email')).toBe(true);
  });

  it('says so when no model is available', async () => {
    replies = [];
    const r = await api('POST', '/api/v1/assistant/chat', { message: 'hello' });
    expect(r.status).toBe(200);
    expect(r.json.messages.at(-1)).toMatchObject({ role: 'assistant', data: { error: true } });
  });
});

describe('assistant follow-through', () => {
  it('takes the step it announced instead of stopping, and gets route hints when a read fails', async () => {
    replies = [
      JSON.stringify({ say: 'To count the paid bills I need to read the bills for this month. Let me first find the bills.' }),
      (msgs) => {
        expect(String(msgs.at(-1)!.content)).toContain('take it now');
        return JSON.stringify({ read: ['/api/v1/bills/paid'] });
      },
      (msgs) => {
        expect(String(msgs.at(-1)!.content)).toMatch(/not a readable route|GET \/api\/v1\/bills\/paid → 4/);
        return JSON.stringify({ read: [`/api/v1/records/lead?count=1&filters=${encodeURIComponent(JSON.stringify([{ field: 'email', op: 'not_null' }]))}`] });
      },
      (msgs) => {
        expect(String(msgs.at(-1)!.content)).toMatch(/GET \/api\/v1\/records\/lead\?count=1&filters=.* → 200/);
        return JSON.stringify({ say: 'There are 0 new leads.' });
      },
    ];
    const r = await api('POST', '/api/v1/assistant/chat', { message: 'how many new leads?' });
    expect(r.json.messages.at(-1).content).toBe('There are 0 new leads.');
  });
});
