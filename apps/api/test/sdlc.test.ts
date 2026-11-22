/** AI delivery: diagrams (Mermaid + draw.io), documents with figures, agents run step by step with people reviewing. */
import { DIAGRAM_TYPES, parseSpec, toDrawio, toMermaid } from '@synapse/shared/diagrams';
import { beforeAll, describe, expect, it } from 'vitest';
import { Db } from '../src/lib/db';
import { guessDiagramType } from '../src/services/sdlc';
import { type Json, makeHarness } from './harness';

let h: Awaited<ReturnType<typeof makeHarness>>;
let api: ReturnType<typeof h.as>;
const ids = {} as Record<string, string> & { run: string; diagram: string; project: string; tenant: string };
const prompts: string[] = [];
let down = false;
let plan: unknown = null;
let evaluations = 0;

const SPECS: Record<string, Json> = {
  architecture: {
    type: 'architecture', title: 'Fleet tracking', groups: [{ id: 'cloud', label: 'Cloudflare', kind: 'zone' }],
    nodes: [
      { id: 'app', label: 'Driver app', shape: 'client', tech: 'React Native' },
      { id: 'api', label: 'API', shape: 'service', group: 'cloud', tech: 'Workers' },
      { id: 'db', label: 'Trips DB', shape: 'database', group: 'cloud', tech: 'Postgres' },
      { id: 'gps', label: 'GPS vendor', shape: 'external' },
      { id: 'bad', label: 'Weird', shape: 'hologram' },
    ],
    edges: [{ from: 'app', to: 'api', label: 'HTTPS' }, { from: 'api', to: 'db' }, { from: 'gps', to: 'api', label: 'webhook', style: 'dashed' }, { from: 'api', to: 'ghost' }],
  },
  er: {
    type: 'er', entities: [{ name: 'Vehicle', attributes: [{ name: 'id', type: 'uuid', key: 'PK' }, { name: 'reg_no', type: 'text', key: 'UK' }] }, { name: 'Trip', attributes: [{ name: 'id', type: 'uuid', key: 'PK' }, { name: 'vehicle_id', type: 'uuid', key: 'FK' }] }],
    relations: [{ from: 'Vehicle', to: 'Trip', card: '1-n', label: 'makes' }],
  },
  sequence: {
    type: 'sequence', participants: [{ id: 'driver', label: 'Driver', kind: 'actor' }, { id: 'api', label: 'API' }, { id: 'db', label: 'DB', kind: 'database' }],
    steps: [
      { from: 'driver', to: 'api', label: 'Start trip' }, { from: 'api', to: 'db', label: 'insert trip' }, { from: 'db', to: 'api', label: 'ok', kind: 'reply' },
      { group: 'alt', label: 'GPS on', steps: [{ from: 'api', to: 'driver', label: 'tracking', kind: 'reply' }], else: [{ label: 'GPS off', steps: [{ from: 'api', to: 'driver', label: 'turn on GPS', kind: 'reply' }] }] },
      { note: 'every 30 s', over: ['driver', 'api'] },
    ],
  },
  user_journey: { type: 'user_journey', actor: 'Fleet manager', stages: [{ name: 'Plan', steps: [{ task: 'Assign vehicle', score: 4 }] }, { name: 'Track', steps: [{ task: 'Watch live map', score: 2, pain: 'Laggy' }] }] },
  class: { type: 'class', classes: [{ name: 'Trip', attributes: ['+id: UUID'], methods: ['+close()'] }, { name: 'Entity', stereotype: 'abstract' }], relations: [{ from: 'Trip', to: 'Entity', kind: 'inheritance' }] },
  state: { type: 'state', nodes: [{ id: 's', label: 'start', shape: 'initial' }, { id: 'open', label: 'Open', shape: 'state' }, { id: 'closed', label: 'Closed', shape: 'state' }, { id: 'e', label: 'end', shape: 'final' }], edges: [{ from: 's', to: 'open' }, { from: 'open', to: 'closed', label: 'close' }, { from: 'closed', to: 'e' }] },
  mindmap: { type: 'mindmap', nodes: [{ id: 'r', label: 'Fleet' }, { id: 'a', label: 'Trips' }, { id: 'b', label: 'Fuel' }], edges: [{ from: 'r', to: 'a' }, { from: 'r', to: 'b' }] },
  gantt: { type: 'gantt', mermaid: 'gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  API :a1, 2026-01-05, 10d' },
};

function reply(messages: Json[]) {
  const u = String(messages[messages.length - 1]!.content);
  prompts.push(u);
  if (down) throw new Error('model down');
  if (u.startsWith('Plan how the team')) return JSON.stringify(plan);
  if (u.startsWith('Draw a')) {
    const type = Object.keys(SPECS).find((k) => u.includes(`"type":"${k}"`)) ?? 'architecture';
    // the first ER attempt is broken: the agent is asked again with the error
    if (type === 'er' && !u.includes('could not be used') && !prompts.some((p) => p.includes('could not be used'))) return '{"type":"er","entities":[]}';
    return JSON.stringify(SPECS[type]);
  }
  if (u.startsWith('Write the "')) {
    const title = /Write the "([^"]+)"/.exec(u)![1];
    const changed = u.includes('The reviewer asked for changes') ? '\n\nNow with GST e-invoicing.' : '';
    return `# ${title}\n\n## Purpose\nTrack every vehicle.${changed}\n\n[[diagram: architecture | Solution overview | apps, API, DB]]\n\n## Data\n[[diagram: er | Data model | vehicles and trips]]\n`;
  }
  if (u.startsWith('Break this into a backlog'))
    return JSON.stringify({
      epics: [{ name: 'Live tracking', description: 'See vehicles on a map', stories: [{ name: 'As a manager I want a live map', acceptance: ['Given a trip when GPS pings then the map moves'], points: 5, priority: 'high', tasks: [{ name: 'Backend: positions API', hours: 6 }] }, { name: 'As a driver I want to start a trip', points: 3 }] }],
    });
  if (u.startsWith('Evaluate each output')) {
    evaluations++;
    return JSON.stringify(evaluations === 1 ? { score: 5, summary: 'The design misses e-invoicing.', findings: [{ step: 'High-level design (HLD)', severity: 'high', issue: 'No GST IRP integration', fix: 'Add the IRP flow' }, { step: 'User journey', severity: 'low', issue: 'Could show the driver too', fix: '' }] } : { score: 9, summary: 'Good.', findings: [] });
  }
  if (u.startsWith('Validate consistency'))
    return JSON.stringify({ score: 8, summary: 'Consistent.', findings: [{ step: 'Unit test cases', severity: 'low', issue: 'Add a boundary | case', fix: 'zero km trip' }], matrix: [{ requirement: 'BR-1 Live map', design: 'HLD §2', backlog: 'FLEET-2', tests: 'TC-1', status: 'covered' }] });
  if (/^Write \w+ test cases/.test(u)) {
    const key = /(\w+-\d+) — As a manager/.exec(u)?.[1] ?? 'X-1';
    return JSON.stringify({ cases: [{ title: 'Map moves on GPS ping', suite: 'Tracking', steps: [{ action: 'Send a ping', expected: 'Marker moves' }], covers: [key] }, { title: 'Invalid vehicle number', steps: [{ action: 'Enter MH12', expected: 'Rejected' }] }] });
  }
  return 'ok';
}

async function sql(q: string, p: unknown[] = []) {
  const db = Db.fromEnv(h.env);
  try {
    return await db.tx({ tenantId: ids.tenant! }, (tx) => tx.query<Json>(q, p));
  } finally {
    await db.close();
  }
}
const getRun = async (id: string) => (await api('GET', `/api/v1/sdlc/runs/${id}`)).json;
const stepOf = (r: Json, title: string) => r.steps.find((s: Json) => s.title === title);
async function review(stepId: string, verdict: string, extra: Json = {}) {
  const r = await api('POST', `/api/v1/sdlc/steps/${stepId}/review`, { verdict, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

beforeAll(async () => {
  h = await makeHarness('synapse_test_sdlc');
  h.env.AI = { run: async (_m: string, input: { messages: Json[] }) => ({ response: reply(input.messages) }) } as unknown as Ai;
  await h.signup('sdlc', 'owner@sdlc.test');
  api = h.as('sdlc', (await h.login('sdlc', 'owner@sdlc.test')).token);
  ids.tenant = (await api('GET', '/api/auth/me')).json.tenant.id;
  expect((await api('POST', '/api/admin/apps/projects/enable')).status).toBe(200);
  ids.project = (await api('POST', '/api/v1/records/project', { name: 'Fleet app' })).json.id;
  await sql(`update projects set status = 'active', work_key = 'FLEET' where id = $1`, [ids.project]);
}, 120_000);

describe('diagrams', () => {
  it('turns every structured kind into Mermaid and an editable draw.io file', () => {
    for (const [type, raw] of Object.entries(SPECS)) {
      const spec = parseSpec(raw);
      const mm = toMermaid(spec);
      const xml = toDrawio(spec);
      expect(mm.length, type).toBeGreaterThan(10);
      if (type === 'gantt') {
        expect(xml).toBeNull();
        continue;
      }
      expect(xml, type).toMatch(/^<mxfile[\s\S]*<\/mxfile>$/);
      // well formed enough: every opened mxCell closes, no raw ampersands or angle brackets in values
      expect((xml!.match(/<mxCell /g) ?? []).length, type).toBe((xml!.match(/<\/mxCell>|<mxCell [^>]*\/>/g) ?? []).length);
      expect(xml!.replace(/&(amp|lt|gt|quot|#xa);/g, ''), type).not.toMatch(/&/);
      expect(xml, type).not.toMatch(/NaN/);
    }
    const arch = parseSpec(SPECS.architecture);
    expect(arch.type === 'architecture' && arch.edges.length).toBe(3); // the edge to a missing node is dropped
    expect(toMermaid(arch)).toContain('flowchart LR');
    expect(toMermaid(arch)).toContain('api@{ shape: rounded, label: "API<br/>[Workers]" }');
    expect(toMermaid(arch)).toContain('subgraph g_cloud');
    expect(toMermaid(arch)).toContain('gps -.->|"webhook"| api');
    expect(toMermaid(parseSpec(SPECS.er))).toContain('Vehicle ||--o{ Trip : "makes"');
    expect(toDrawio(parseSpec(SPECS.er))).toContain('startArrow=ERmandOne;endArrow=ERmany');
    const seq = toMermaid(parseSpec(SPECS.sequence));
    expect(seq).toContain('actor driver as Driver');
    expect(seq).toMatch(/alt GPS on[\s\S]*else GPS off[\s\S]*end/);
    expect(toDrawio(parseSpec(SPECS.sequence))).toContain('shape=umlLifeline');
    expect(toMermaid(parseSpec(SPECS.class))).toContain('Entity <|-- Trip');
    expect(toMermaid(parseSpec(SPECS.state))).toContain('[*] --> open');
    expect(toMermaid(parseSpec(SPECS.mindmap))).toMatch(/mindmap\n\s+root\(\(Fleet\)\)\n\s+Trips/);
    expect(toMermaid(parseSpec(SPECS.user_journey))).toContain('Watch live map: 2: Fleet manager');
    expect(DIAGRAM_TYPES.length).toBeGreaterThanOrEqual(26);
    expect(guessDiagramType('ER diagram for invoices and customers')).toBe('er');
    expect(guessDiagramType('sequence of the OTP login')).toBe('sequence');
    expect(guessDiagramType('deployment on Cloudflare')).toBe('deployment');
    expect(guessDiagramType('our leave approval process')).toBe('flowchart');
  });

  it('draws a diagram from a description, saves it with versions, and renders specs without AI', async () => {
    const r = await api('POST', '/api/v1/sdlc/diagrams/generate', { prompt: 'Sequence of starting a trip', projectId: ids.project });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ type: 'sequence', id: expect.any(String) });
    expect(r.json.drawio).toContain('<mxfile');
    ids.diagram = r.json.id;
    const ed = await api('PUT', `/api/v1/sdlc/artifacts/${ids.diagram}`, { spec: SPECS.architecture, title: 'Fleet architecture' });
    expect(ed.json.version).toBe(2);
    const a = (await api('GET', `/api/v1/sdlc/artifacts/${ids.diagram}`)).json;
    expect(a.artifact).toMatchObject({ subtype: 'architecture', title: 'Fleet architecture', version: 2 });
    expect(a.versions.map((v: Json) => v.version)).toEqual([2, 1]);
    expect((await api('GET', `/api/v1/sdlc/artifacts/${ids.diagram}/versions/1`)).json.body).toContain('sequenceDiagram');
    // Mermaid edited by hand stands alone; the browser supplies the draw.io picture
    const mm = await api('PUT', `/api/v1/sdlc/artifacts/${ids.diagram}`, { mermaid: 'flowchart LR\n  a --> b' });
    expect(mm.status).toBe(200);
    expect((await api('GET', `/api/v1/sdlc/artifacts/${ids.diagram}`)).json.artifact).toMatchObject({ drawio: null, spec: { type: 'mermaid' } });
    expect((await api('PUT', `/api/v1/sdlc/artifacts/${ids.diagram}/drawio`, { xml: '<mxfile><diagram>picture</diagram></mxfile>' })).status).toBe(200);
    const rr = await api('POST', '/api/v1/sdlc/diagrams/render', { spec: SPECS.er });
    expect(rr.json.mermaid).toContain('erDiagram');
    expect((await api('POST', '/api/v1/sdlc/diagrams/render', { spec: { type: 'flowchart', nodes: [] } })).status).toBe(400);
    expect((await api('GET', `/api/v1/sdlc/artifacts?projectId=${ids.project}&kind=diagram`)).json.items).toHaveLength(1);
  });
});

describe('agents delivering a feature', () => {
  it('runs the plan step by step, waits for people on key steps, and redoes a step with the reviewer\'s note', async () => {
    expect((await api('POST', '/api/v1/sdlc/runs', { goal: 'Fleet tracking', template: 'feature' })).status).toBe(400); // backlog / code need a project
    const c = await api('POST', '/api/v1/sdlc/runs', { goal: 'Fleet tracking for our transport clients', template: 'feature', projectId: ids.project, reviewMode: 'key' });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    ids.run = c.json.id;
    let r = await getRun(ids.run);
    expect(r.run.status).toBe('awaiting_plan');
    expect(r.steps.map((s: Json) => [s.kind, s.agent, s.needs_review])).toEqual([
      ['document', 'ba', true], ['diagram', 'ux', false], ['document', 'architect', true], ['document', 'api_designer', false], ['diagram', 'architect', false], ['diagram', 'data_engineer', false],
      ['review', 'evaluator', false], ['backlog', 'po', true], ['test_cases', 'qa', true], ['test_cases', 'unit_tester', true], ['test_cases', 'system_tester', true], ['review', 'validator', false], ['code', 'developer', true],
    ]);
    expect(r.steps.filter((s: Json) => s.kind !== 'document').map((s: Json) => s.doc_type).filter(Boolean)).toEqual(['evaluate', 'functional', 'unit', 'integration', 'validate']);
    // the plan can be changed before starting: drop the API spec, the sequence diagram and the integration tests
    const plan2 = r.steps
      .filter((s: Json) => s.diagram_type !== 'sequence' && s.doc_type !== 'api_spec' && s.doc_type !== 'integration')
      .map((s: Json) => ({ agent: s.agent, kind: s.kind, title: s.title, docType: s.doc_type, diagramType: s.diagram_type, needsReview: s.needs_review }));
    expect((await api('PUT', `/api/v1/sdlc/runs/${ids.run}/plan`, { steps: plan2 })).json.steps).toHaveLength(10);

    expect((await api('POST', `/api/v1/sdlc/runs/${ids.run}/start`)).status).toBe(200);
    r = await getRun(ids.run);
    expect(r.run.status).toBe('awaiting_review');
    const brd = stepOf(r, 'Business requirements (BRD)');
    expect(brd.status).toBe('awaiting_review');
    // the document embeds its two figures, each its own diagram
    const docs = r.artifacts.filter((a: Json) => a.step_id === brd.id);
    expect(docs.map((a: Json) => a.kind).sort()).toEqual(['diagram', 'diagram', 'document']);
    const doc = docs.find((a: Json) => a.kind === 'document');
    const body = (await api('GET', `/api/v1/sdlc/artifacts/${doc.id}`)).json;
    expect(body.artifact.body).toMatch(/\*\*Figure 1 — Solution overview\*\*\n\n```mermaid\nflowchart LR/);
    expect(body.embedded).toHaveLength(2);
    expect(body.artifact.body).not.toContain('[[diagram');
    expect(prompts.some((p) => p.includes('could not be used'))).toBe(true); // the broken ER was asked for again

    // changes: the agent rewrites it with the note
    await review(brd.id, 'changes', { note: 'Add GST e-invoicing' });
    r = await getRun(ids.run);
    const doc2 = (await api('GET', `/api/v1/sdlc/artifacts/${doc.id}`)).json;
    expect(doc2.artifact.version).toBe(2);
    expect(doc2.artifact.body).toContain('Now with GST e-invoicing');
    expect(r.artifacts.filter((a: Json) => a.step_id === brd.id)).toHaveLength(3); // figures replaced, not added
    expect((await api('POST', `/api/v1/sdlc/steps/${brd.id}/review`, { verdict: 'changes' })).status).toBe(400);

    await review(brd.id, 'approve');
    r = await getRun(ids.run);
    // the journey diagram needs no review in "key" mode; the HLD does
    expect(stepOf(r, 'User journey').status).toBe('approved');
    const hld = stepOf(r, 'High-level design (HLD)');
    expect(hld.status).toBe('awaiting_review');
    expect(prompts.find((p) => p.startsWith('Write the "High-level design'))).toContain('Business requirements (BRD)'); // it saw the BRD
    await review(hld.id, 'approve');

    // the evaluator finds a gap in the HLD and sends it back to the architect, with its finding as the note
    r = await getRun(ids.run);
    const redone = stepOf(r, 'High-level design (HLD)');
    expect(redone).toMatchObject({ status: 'awaiting_review', attempts: 2, feedback: expect.stringContaining('Evaluator (round 1): No GST IRP integration → Add the IRP flow') });
    expect(stepOf(r, 'User journey').status).toBe('approved'); // low findings are not sent back
    const evalStep = stepOf(r, 'Evaluator: requirements and design');
    expect(evalStep).toMatchObject({ status: 'pending', output: { rounds: 1, verdict: 'revise', score: 5 } });
    const hldDoc = r.artifacts.find((a: Json) => a.step_id === redone.id && a.kind === 'document');
    expect((await api('GET', `/api/v1/sdlc/artifacts/${hldDoc.id}`)).json.artifact.body).toContain('Now with GST e-invoicing');
    await review(redone.id, 'approve');
    r = await getRun(ids.run);
    expect(stepOf(r, 'Evaluator: requirements and design')).toMatchObject({ status: 'approved', output: { rounds: 2, verdict: 'pass', score: 9 } });
    const report = r.artifacts.find((a: Json) => a.step_id === evalStep.id);
    expect(report).toMatchObject({ subtype: 'review_report' });
    expect(evaluations).toBe(2);

    const backlog = stepOf(r, 'Epics, user stories and tasks');
    expect(backlog.status).toBe('awaiting_review');
    expect(backlog.output.epics[0].stories).toHaveLength(2);
    expect(await sql(`select 1 from project_tasks where project_id = $1`, [ids.project])).toHaveLength(0); // nothing created before approval
    // the reviewer drops the second story
    const edited = { ...backlog.output, epics: [{ ...backlog.output.epics[0], stories: [backlog.output.epics[0].stories[0], { ...backlog.output.epics[0].stories[1], skip: true }] }] };
    const ap = await review(backlog.id, 'approve', { output: edited });
    expect(ap.output.created.map((x: Json) => [x.type, x.key])).toEqual([['epic', 'FLEET-1'], ['story', 'FLEET-2'], ['subtask', 'FLEET-3']]);
    const story = await sql(`select description, story_points, epic_id from project_tasks where project_id = $1 and work_type = 'story'`, [ids.project]);
    expect(story[0]).toMatchObject({ story_points: '5.0', epic_id: expect.any(String) });
    expect(story[0]!.description).toContain('- [ ] Given a trip when GPS pings then the map moves');

    r = await getRun(ids.run);
    const tests = stepOf(r, 'Functional test cases');
    expect(tests.status).toBe('awaiting_review');
    expect(prompts.find((p) => p.startsWith('Write functional test cases'))).toContain('FLEET-2 — As a manager I want a live map');
    await review(tests.id, 'approve');
    r = await getRun(ids.run);
    const unit = stepOf(r, 'Unit test cases');
    expect(unit).toMatchObject({ status: 'awaiting_review', agent: 'unit_tester', output: { level: 'unit' } });
    expect(prompts.some((p) => p.startsWith('Write unit test cases: unit test cases per module'))).toBe(true);
    await review(unit.id, 'approve');
    const cases = await sql(`select title, suite, item_ids from pm_test_cases where project_id = $1 order by case_number`, [ids.project]);
    expect(cases.map((x) => [x.title, x.suite, x.item_ids.length])).toEqual([
      ['Map moves on GPS ping', 'Tracking', 1], ['Invalid vehicle number', null, 0], ['Map moves on GPS ping', 'Unit — Tracking', 1], ['Invalid vehicle number', 'Unit', 0],
    ]);

    // the validator passes; its report has the findings and the traceability matrix as tables
    r = await getRun(ids.run);
    const val = stepOf(r, 'Validation: requirement → design → story → test');
    expect(val).toMatchObject({ status: 'approved', output: { verdict: 'pass', rounds: 1 } });
    expect(prompts.find((p) => p.startsWith('Validate consistency'))).toMatch(/Unit test cases \(test cases, unit\)[\s\S]*covers FLEET-2/);
    const valDoc = (await api('GET', `/api/v1/sdlc/artifacts/${r.artifacts.find((a: Json) => a.step_id === val.id).id}`)).json.artifact.body;
    expect(valDoc).toContain('| Unit test cases | low | Add a boundary \\| case | zero km trip |');
    expect(valDoc).toContain('| BR-1 Live map | HLD §2 | FLEET-2 | TC-1 | covered |');

    const code = stepOf(r, 'Implement with the coding agent');
    expect(code.status).toBe('awaiting_review');
    const done = await review(code.id, 'approve');
    expect(done.output.queued.map((q: Json) => q.key)).toEqual(['FLEET-2']);
    expect(await sql(`select status, reason from coding_agent_jobs`)).toEqual([{ status: 'queued', reason: 'requested' }]);
    r = await getRun(ids.run);
    expect(r.run.status).toBe('done');
    expect((await api('GET', `/api/v1/sdlc/runs?projectId=${ids.project}`)).json.items[0]).toMatchObject({ status: 'done', steps: 10, done: 10 });
    expect((await sql(`select count(*)::int n from notifications where link = $1`, [`/sdlc?run=${ids.run}`]))[0]!.n).toBeGreaterThan(3);
  });

  it('plans with AI (falling back to a ready-made plan), runs unattended, and records a failure that can be retried', async () => {
    plan = { title: 'Leave approvals', steps: [{ agent: 'ba', kind: 'document', title: 'SRS', docType: 'srs' }, { agent: 'architect', kind: 'diagram', title: 'Approval states', diagramType: 'state' }, { agent: 'po', kind: 'backlog', title: 'Backlog' }, { agent: 'nobody', kind: 'document', title: 'x' }] };
    const c = await api('POST', '/api/v1/sdlc/runs', { goal: 'Leave approvals for our staff', reviewMode: 'none' });
    let r = await getRun(c.json.id);
    // no project: the backlog step is left out; the unknown agent too
    expect(r.run).toMatchObject({ title: 'Leave approvals', status: 'done' });
    expect(r.steps.map((s: Json) => [s.title, s.status])).toEqual([['SRS', 'approved'], ['Approval states', 'approved']]);
    expect(r.artifacts.every((a: Json) => a.status === 'approved')).toBe(true);

    down = true;
    const f = await api('POST', '/api/v1/sdlc/runs', { goal: 'Something while the model is down', reviewMode: 'none' });
    r = await getRun(f.json.id);
    expect(r.run.status).toBe('failed'); // planned from the ready-made design pack, then the first step failed
    expect(r.steps[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/./) });
    down = false;
    expect((await api('POST', `/api/v1/sdlc/runs/${f.json.id}/start`)).status).toBe(200);
    expect((await getRun(f.json.id)).run.status).toBe('done');
  });

  it('writes one document on request, and gives coding agents the project documents over MCP', async () => {
    const g = await api('POST', '/api/v1/sdlc/documents/generate', { prompt: 'API for trips', docType: 'api_spec', projectId: ids.project });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const r = await getRun(g.json.runId);
    expect(r.run.status).toBe('done');
    expect(r.artifacts.find((a: Json) => a.kind === 'document')).toMatchObject({ title: 'API specification', status: 'approved' });

    const k = await api('POST', '/api/admin/api-keys', { name: 'Claude Code', scopes: ['read', 'write'], rateLimitPerMin: 600 });
    const call = async (name: string, args: Json) => {
      const res = await h.call('POST', '/api/v1/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers: { authorization: `Bearer ${k.json.key}` } });
      expect(res.json.result.isError, res.json.result.content[0].text).toBeFalsy();
      return res.json.result.structuredContent;
    };
    const list = (await call('project_documents', { project: 'FLEET' })).documents;
    expect(list.length).toBeGreaterThan(5);
    expect(list[0].status).toBe('approved');
    const doc = await call('read_document', { id: list.find((x: Json) => x.kind === 'document').id });
    expect(doc.markdown).toMatch(/^# /);
    expect((await call('diagram_format', { type: 'er' })).format).toContain('"entities"');
    expect((await call('render_diagram', { spec: SPECS.class })).mermaid).toContain('classDiagram');
    const saved = await call('save_diagram', { project: 'FLEET', title: 'As built', spec: SPECS.state });
    expect(saved.id).toEqual(expect.any(String));
    expect((await call('save_document', { project: 'FLEET', title: 'ADR-1 Postgres', markdown: '# ADR-1', type: 'adr' })).version).toBe(1);
  });
});
