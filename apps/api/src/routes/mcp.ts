/**
 * The MCP server for coding agents (Claude Code, Codex): POST /api/v1/mcp, JSON-RPC 2.0 over
 * Streamable HTTP (JSON responses, no SSE). Sign in with an API key (read + write) of the person the
 * agent works for: `Authorization: Bearer syn_…`.
 *
 *   claude mcp add --transport http sanchalan https://www.sanchalan.hrpai.in/api/v1/mcp --header "Authorization: Bearer syn_…"
 */
import { type Context, Hono } from 'hono';
import { ZodError, z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { scope } from '../middleware';
import * as ag from '../services/coding-agent';
import * as sd from '../services/sdlc';
import { DIAGRAM_TYPES, type DiagramType, specGuide } from '@synapse/shared/diagrams';
import type { RecordCtx } from '../services/records';

const PROTOCOL = '2025-06-18';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wait = z.number().int().min(0).max(25).optional();

type Tool = { name: string; description: string; inputSchema: Record<string, unknown>; run: (c: Context<AppEnv>, a: Record<string, any>) => Promise<unknown> };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });

function run<T>(c: Context<AppEnv>, fn: (ctx: RecordCtx) => Promise<T>, readOnly = false) {
  return c.var.db.tx(scope(c, readOnly), (tx) => fn({ tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id }));
}

const TOOLS: Tool[] = [
  {
    name: 'list_projects',
    description: 'Projects you can work on, with their linked repositories, where the project lives locally, build/test instructions, and how many items wait for the agent.',
    inputSchema: obj({}),
    run: (c) => run(c, (ctx) => ag.agentProjects(ctx), true),
  },
  {
    name: 'setup_project',
    description: 'How to get a project onto this machine: the repositories to clone (or to create when none is linked), the local folder, build/test instructions and the release command. Call it before working on a project you do not have locally.',
    inputSchema: obj({ project: str('Project id, work key (e.g. FLEET) or name') }, ['project']),
    run: (c, a) => run(c, (ctx) => ag.projectSetup(ctx, String(a.project)), true),
  },
  {
    name: 'next_work',
    description:
      'Claims the next work item (story, task, bug) queued for the coding agent — requested changes first — with everything needed to implement it. Waits up to waitSeconds (max 25) for one to arrive; returns {job: null} when there is none.',
    inputSchema: obj({ agent: str('Who is working, e.g. "claude-code@my-laptop"'), project: str('Only this project (id, key or name)'), waitSeconds: { type: 'integer', minimum: 0, maximum: 25 } }, ['agent']),
    run: async (c, a) => {
      const until = Date.now() + (wait.parse(a.waitSeconds) ?? 0) * 1000;
      for (;;) {
        const job = await run(c, (ctx) => ag.claimNext(ctx, String(a.agent ?? 'agent'), a.project ? String(a.project) : null));
        if (job || Date.now() >= until) return { job };
        await sleep(3000);
      }
    },
  },
  {
    name: 'get_work_item',
    description: 'A work item by key (e.g. FLEET-12): description, acceptance criteria, parent / epic, children, comments, links and test cases.',
    inputSchema: obj({ key: str('Item key, e.g. FLEET-12') }, ['key']),
    run: (c, a) => run(c, async (ctx) => (await ag.itemByKey(ctx, String(a.key))).item, true),
  },
  {
    name: 'report_progress',
    description: 'Tells the people on the project what you are doing (shown on the item and the job): working, testing, tests_passed, tests_failed or a note. Also keeps the job yours (call at least every 30 minutes).',
    inputSchema: obj(
      { jobId: str('From next_work'), stage: { type: 'string', enum: ['working', 'testing', 'tests_passed', 'tests_failed', 'note'] }, message: str('What happened, in a sentence or two (test output summary for tests_*)'), branch: str('The branch you work on') },
      ['jobId', 'stage', 'message'],
    ),
    run: (c, a) => run(c, (ctx) => ag.reportProgress(ctx, ag.progressSchema.parse(a))),
  },
  {
    name: 'request_review',
    description: 'Asks a person to verify the work before anything is committed or pushed: what you changed, the branch, the test results and how to check it.',
    inputSchema: obj(
      {
        jobId: str('From next_work'),
        summary: str('What was implemented and why, for the reviewer (markdown)'),
        branch: str('The branch with the work (not yet pushed is fine)'),
        testReport: str('Tests run and their results'),
        howToVerify: str('Steps for the person to verify it'),
        changedFiles: { type: 'array', items: { type: 'string' } },
      },
      ['jobId', 'summary', 'branch'],
    ),
    run: (c, a) => run(c, (ctx) => ag.requestReview(ctx, ag.reviewRequestSchema.parse(a))),
  },
  {
    name: 'review_status',
    description: 'The person’s verdict: awaiting_review, approved (now commit, push and complete) or changes_requested (the note says what to change). Waits up to waitSeconds (max 25) for a verdict.',
    inputSchema: obj({ jobId: str('From next_work'), waitSeconds: { type: 'integer', minimum: 0, maximum: 25 } }, ['jobId']),
    run: async (c, a) => {
      const until = Date.now() + (wait.parse(a.waitSeconds) ?? 0) * 1000;
      for (;;) {
        const s = await run(c, (ctx) => ag.reviewStatus(ctx, String(a.jobId)));
        if (s.status !== 'awaiting_review' || Date.now() >= until) return s;
        await sleep(3000);
      }
    },
  },
  {
    name: 'complete',
    description: 'After approval: record that the work was committed, pushed (with the pull request URL) or released. "released" closes the item.',
    inputSchema: obj(
      { jobId: str('From next_work'), stage: { type: 'string', enum: ['committed', 'pushed', 'released'] }, message: str('Anything the people should know'), commitSha: str('The commit'), prUrl: str('Pull request URL'), branch: str('Branch') },
      ['jobId', 'stage'],
    ),
    run: (c, a) => run(c, (ctx) => ag.complete(ctx, ag.completeSchema.parse(a))),
  },
  {
    name: 'fail',
    description: 'Gives the job up with the reason (blocked, unclear, cannot build): the item gets a comment and a person decides.',
    inputSchema: obj({ jobId: str('From next_work'), message: str('Why') }, ['jobId', 'message']),
    run: (c, a) => run(c, (ctx) => ag.fail(ctx, String(a.jobId), String(a.message ?? '').slice(0, 8000))),
  },
  {
    name: 'add_comment',
    description: 'Comments on a work item (questions for the team, notes). Mention people with @Full Name.',
    inputSchema: obj({ key: str('Item key, e.g. FLEET-12'), body: str('The comment (markdown)') }, ['key', 'body']),
    run: (c, a) => run(c, (ctx) => ag.agentComment(ctx, String(a.key), String(a.body ?? '').slice(0, 20000))),
  },
  {
    name: 'create_work_item',
    description: 'Files a new story, task, bug, sub-task, spike or improvement (e.g. a bug found while working). It is not sent back to the agent automatically.',
    inputSchema: obj(
      { project: str('Project id, key or name'), type: { type: 'string', enum: ['story', 'task', 'bug', 'subtask', 'spike', 'improvement'] }, title: str('Title'), description: str('Description'), parentKey: str('Parent item key, for a sub-task') },
      ['project', 'type', 'title'],
    ),
    run: (c, a) => run(c, (ctx) => ag.agentCreateItem(ctx, ag.newItemSchema.parse(a))),
  },
  {
    name: 'project_documents',
    description: 'The project\'s documents (BRD, SRS, HLD, LLD, API spec, test plan, runbook …) and diagrams made by the AI delivery agents or people — approved ones first. Read the relevant ones before implementing.',
    inputSchema: obj({ project: str('Project id, key or name') }, ['project']),
    run: (c, a) => run(c, async (ctx) => ({ documents: await sd.projectDocs(ctx, (await ag.projectSetup(ctx, String(a.project))).project.id) }), true),
  },
  {
    name: 'read_document',
    description: 'A document (markdown) or diagram (Mermaid and its spec) by id, from project_documents.',
    inputSchema: obj({ id: str('Document or diagram id') }, ['id']),
    run: (c, a) => run(c, (ctx) => sd.readDoc(ctx, String(a.id)), true),
  },
  {
    name: 'diagram_format',
    description: 'The JSON format for a diagram of one kind, to use with render_diagram / save_diagram. Kinds: flowchart, architecture, data_flow, block, network, deployment, c4_context, c4_container, use_case, mindmap, org_chart, swimlane, state, class, er, sequence, user_journey, and Mermaid-only gantt, timeline, pie, quadrant, gitgraph, sankey, requirement, kanban, mermaid.',
    inputSchema: obj({ type: str('Diagram kind, e.g. er, sequence, architecture') }, ['type']),
    run: async (_c, a) => ({ format: specGuide((DIAGRAM_TYPES as readonly string[]).includes(String(a.type)) ? (String(a.type) as DiagramType) : 'architecture') }),
  },
  {
    name: 'render_diagram',
    description: 'Turns a diagram spec (see diagram_format) into Mermaid source and a draw.io (.drawio) file with laid-out, editable shapes. Write the results into the repository (docs/diagrams/*.mmd, *.drawio) when useful.',
    inputSchema: obj({ spec: { type: 'object', description: 'The diagram spec' } }, ['spec']),
    run: async (_c, a) => sd.renderDiagram(a.spec),
  },
  {
    name: 'save_diagram',
    description: 'Saves a diagram to the project\'s documents (e.g. the architecture you implemented), from a spec or Mermaid source. People see it under AI delivery, with PNG / JPG / SVG / draw.io downloads.',
    inputSchema: obj({ project: str('Project id, key or name'), title: str('Title'), spec: { type: 'object', description: 'Diagram spec (see diagram_format)' }, mermaid: str('Or: Mermaid source') }, ['project', 'title']),
    run: (c, a) =>
      run(c, async (ctx) => sd.createArtifact(ctx, { kind: 'diagram', projectId: (await ag.projectSetup(ctx, String(a.project))).project.id, title: String(a.title).slice(0, 200), subtype: 'custom', spec: a.spec, mermaid: a.mermaid ? String(a.mermaid) : null })),
  },
  {
    name: 'save_document',
    description: 'Saves a markdown document to the project\'s documents (design notes, ADRs, API docs, release notes). Mermaid in ```mermaid blocks is drawn.',
    inputSchema: obj({ project: str('Project id, key or name'), title: str('Title'), markdown: str('The document'), type: str('Kind: hld, lld, api_spec, adr, release_notes, runbook, user_manual, custom') }, ['project', 'title', 'markdown']),
    run: (c, a) =>
      run(c, async (ctx) => sd.createArtifact(ctx, { kind: 'document', projectId: (await ag.projectSetup(ctx, String(a.project))).project.id, title: String(a.title).slice(0, 200), subtype: String(a.type ?? 'custom'), body: String(a.markdown ?? '').slice(0, 400000) })),
  },
];

type RpcReq = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, any> };

async function handle(c: Context<AppEnv>, m: RpcReq) {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const error = (code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sanchalanos', title: 'SanchalanOS', version: '1.0.0' },
        instructions:
          'SanchalanOS work items for coding agents. Loop: next_work → (setup_project if the folder is missing) → implement on a branch, run tests, report_progress → request_review → review_status until approved → commit, push, complete(pushed) → run the release command if any → complete(released). Never commit or push before approval.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === m.params?.name);
      if (!t) return error(-32602, `Unknown tool ${String(m.params?.name)}`);
      try {
        const out = await t.run(c, (m.params?.arguments ?? {}) as Record<string, any>);
        return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], structuredContent: out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out } });
      } catch (e) {
        const msg = e instanceof ZodError ? `Invalid arguments: ${e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` : e instanceof ApiError ? e.message : `Failed: ${(e as Error).message}`;
        if (!(e instanceof ApiError) && !(e instanceof ZodError)) console.error(JSON.stringify({ level: 'error', msg: 'mcp tool failed', tool: t.name, error: (e as Error).message }));
        return reply({ content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    default:
      if (m.method?.startsWith('notifications/')) return null;
      return error(-32601, `Method not found: ${m.method}`);
  }
}

export const mcpRoutes = new Hono<AppEnv>()
  .get('/mcp', (c) => c.json({ error: { code: 'method_not_allowed', message: 'This MCP server answers POST requests (JSON responses, no event stream)' } }, 405))
  .post('/mcp', async (c) => {
    const body = (await c.req.json().catch(() => null)) as RpcReq | RpcReq[] | null;
    if (!body) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    const list = Array.isArray(body) ? body : [body];
    const out = (await Promise.all(list.map((m) => handle(c, m)))).filter((x) => x !== null);
    if (!out.length) return c.body(null, 202);
    return c.json(Array.isArray(body) ? out : out[0]);
  });

/* ───────────────────────── the people's side: settings, queue, review ───────────────────────── */

const uuid = z.string().uuid();
export const agentRoutes = new Hono<AppEnv>()
  .get('/projects/:id/agent', async (c) => {
    const pid = uuid.parse(c.req.param('id'));
    return c.json(await run(c, async (ctx) => ({ settings: await ag.getSettings(ctx, pid), jobs: await ag.listJobs(ctx, pid) }), true));
  })
  .put('/projects/:id/agent/settings', async (c) => {
    const pid = uuid.parse(c.req.param('id'));
    const b = ag.settingsSchema.parse(await c.req.json());
    return c.json(await run(c, (ctx) => ag.saveSettings(ctx, pid, b)));
  })
  .post('/projects/:id/agent/queue', async (c) => {
    const pid = uuid.parse(c.req.param('id'));
    const b = z.object({ taskId: uuid, note: z.string().max(2000).nullish() }).parse(await c.req.json());
    return c.json(await run(c, (ctx) => ag.queueItem(ctx, pid, b.taskId, b.note)));
  })
  .get('/agent/jobs/:id', async (c) => c.json(await run(c, (ctx) => ag.jobDetail(ctx, uuid.parse(c.req.param('id'))), true)))
  .post('/agent/jobs/:id/review', async (c) => {
    const b = ag.reviewSchema.parse(await c.req.json());
    return c.json(await run(c, (ctx) => ag.review(ctx, uuid.parse(c.req.param('id')), b)));
  });
