/**
 * Projects and timesheets API (mounted at /api/v1). Access inside a project follows from the
 * project (see services/projects.ts); the Projects app must be switched on.
 */
import { Hono } from 'hono';
import { ZodError, z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, badRequest, notFound } from '../lib/errors';
import { scope } from '../middleware';
import { enabledApps } from '../services/apps';
import { enqueue, eventJobs } from '../services/jobs';
import * as at from '../services/autotime';
import * as calls from '../services/calls';
import * as mt from '../services/mail-threads';
import * as mb from '../services/milestone-billing';
import * as docs from '../services/books/doc-import';
import * as pj from '../services/projects';
import type { RecordCtx, RecordEvent } from '../services/records';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && s >= '1990-01-01' && s <= '2100-12-31';
  }, 'Not a valid date');
const today = () => new Date().toISOString().slice(0, 10);

function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
function requireProjects(c: { var: AppEnv['Variables'] }) {
  if (!enabledApps(c.var.meta).has('projects')) throw notFound('Projects is switched off for the workspace');
}
type C = { var: AppEnv['Variables']; env: AppEnv['Bindings'] } & Parameters<typeof safeCtx>[0];
async function emit(c: C, events: RecordEvent[]) {
  if (events.length) await enqueue(c.env, safeCtx(c), eventJobs(c.var.tenant.id, c.var.principal.user.id, events));
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
const qDate = (c: { req: { query: (k: string) => string | undefined } }, k: string, dflt: string) => dateStr.parse(c.req.query(k) ?? dflt);

const milestoneSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startDate: dateStr.nullish(),
  dueDate: dateStr.nullish(),
  amount: z.number().min(0).max(1e12).nullish(),
  ownerId: uuid.nullish(),
  status: z.enum(['open', 'in_progress', 'done']).optional(),
  position: z.number().int().min(0).max(100000).optional(),
  acceptedOn: dateStr.nullish(),
  acceptanceRef: z.string().trim().max(100).nullish(),
  approvalFileId: uuid.nullish(),
  approvalActivityId: uuid.nullish(),
  approvalNote: z.string().trim().max(2000).nullish(),
});
const taskSchema = z
  .object({
    name: z.string().trim().min(1).max(300),
    description: z.string().max(20000).nullish(),
    listId: uuid.nullish(),
    milestoneId: uuid.nullish(),
    parentId: uuid.nullish(),
    status: z.enum(['open', 'in_progress', 'review', 'blocked', 'done', 'cancelled']),
    priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']),
    assignees: z.array(uuid).max(20),
    startDate: dateStr.nullish(),
    dueDate: dateStr.nullish(),
    estimateHours: z.number().min(0).max(100000).nullish(),
    progress: z.number().int().min(0).max(100),
    billable: z.boolean(),
    rate: z.number().min(0).max(1e9).nullish(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
    position: z.number().int().min(0).max(1000000),
  })
  .partial();
const issueSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    description: z.string().max(20000).nullish(),
    severity: z.enum(['minor', 'major', 'critical', 'blocker']),
    status: z.enum(['open', 'in_progress', 'fixed', 'closed', 'reopened', 'wont_fix']),
    assigneeId: uuid.nullish(),
    taskId: uuid.nullish(),
    milestoneId: uuid.nullish(),
    dueDate: dateStr.nullish(),
  })
  .partial();
const timeSchema = z.object({
  projectId: uuid,
  taskId: uuid.nullish(),
  issueId: uuid.nullish(),
  userId: uuid.nullish(),
  date: dateStr,
  minutes: z.number().int().min(1).max(1440),
  notes: z.string().max(2000).nullish(),
  billable: z.boolean().optional(),
});

export const projectRoutes = new Hono<AppEnv>()
  .use('/projects/*', async (c, next) => (requireProjects(c), next()))
  .use('/projects', async (c, next) => (requireProjects(c), next()))
  .use('/time/*', async (c, next) => (requireProjects(c), next()))
  .use('/timesheet/*', async (c, next) => (requireProjects(c), next()))
  .use('/timesheet', async (c, next) => (requireProjects(c), next()))
  .use('/project-reports/*', async (c, next) => (requireProjects(c), next()))
  .use('/my-tasks', async (c, next) => (requireProjects(c), next()))
  .use('/calls/*', async (c, next) => (requireProjects(c), next()))
  .use('/calls', async (c, next) => (requireProjects(c), next()))

  /* ───── project calls: schedule, transcript, analysis ───── */
  .get('/projects/:id/calls', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => calls.listProjectCalls(rctx(c, tx), id(c)))))
  .post('/projects/:id/calls', async (c) => {
    const b = calls.callSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.scheduleProjectCall(rctx(c, tx), c.env, id(c), b)), 201);
  })
  .get('/calls', async (c) => {
    const s = z.enum(['upcoming', 'recent', 'unassigned']).parse(c.req.query('scope') ?? 'upcoming');
    return c.json(await c.var.db.tx(scope(c, true), (tx) => calls.listMyCalls(rctx(c, tx), { scope: s })));
  })
  .get('/calls/meeting-accounts', async (c) => c.json({ accounts: await c.var.db.tx(scope(c, true), (tx) => calls.myMeetingChoices(rctx(c, tx))) }))
  .get('/calls/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => calls.getCall(rctx(c, tx), id(c)))))
  .patch('/calls/:id', async (c) => {
    const b = z
      .object({
        title: z.string().trim().min(1).max(200).optional(),
        startsAt: z.string().datetime({ offset: true }).optional(),
        endsAt: z.string().datetime({ offset: true }).optional(),
        agenda: z.string().max(5000).nullish(),
        status: z.enum(['scheduled', 'done', 'cancelled']).optional(),
        notes: z.string().max(20000).nullish(),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.updateCall(rctx(c, tx), id(c), b)));
  })
  .delete('/calls/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => calls.deleteCall(rctx(c, tx), id(c)))))
  .put('/calls/:id/transcript', async (c) => {
    const b = z.object({ text: z.string().min(1).max(1_000_000), fileName: z.string().max(200).nullish(), source: z.enum(['pasted', 'upload', 'typed']).default('pasted') }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.saveTranscript(rctx(c, tx), id(c), b)));
  })
  .post('/calls/invites/sync', async (c) => {
    const { syncMyInvites } = await import('../services/invites');
    return c.json(await syncMyInvites(c.env, c.var.db, c.var.tenant.id, c.var.principal.user.id));
  })
  .get('/calls/:id/recordings', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => calls.listRecordings(rctx(c, tx), c.env, id(c)))))
  .post('/calls/:id/recording', async (c) => {
    const name = z.string().trim().min(1).max(200).parse(c.req.query('name') ?? 'recording');
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > calls.MAX_RECORDING_BYTES) throw badRequest('Recordings can be at most 95 MB — upload an audio-only file');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > calls.MAX_RECORDING_BYTES) throw badRequest('Recordings can be at most 95 MB — upload an audio-only file');
    return c.json(
      await calls.uploadRecording({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, principal: c.var.principal, meta: c.var.meta, requestId: c.var.requestId }, id(c), name, bytes, {
        transcribe: c.req.query('transcribe') !== '0',
        analyse: c.req.query('analyse') === '1',
        speakers: c.req.query('speakers') !== '0',
      }),
      201,
    );
  })
  .post('/calls/:id/recordings/:fid/transcribe', async (c) => {
    const b = z.object({ analyse: z.boolean().default(false), speakers: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await calls.transcribeRecordingFile({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, principal: c.var.principal, meta: c.var.meta, requestId: c.var.requestId }, id(c), id(c, 'fid'), b));
  })
  .post('/calls/:id/recordings/:fid/parts', async (c) => {
    const n = (k: string) => Number(c.req.query(k));
    const p = z.object({ index: z.number().int().min(0).max(499), total: z.number().int().min(1).max(500), offset: z.number().min(0).max(86_400) }).parse({ index: n('index'), total: n('total'), offset: n('offset') });
    if (p.index >= p.total) throw badRequest('Part number out of range');
    if (Number(c.req.header('content-length') ?? 0) > calls.MAX_PART_BYTES) throw badRequest('Each part can be at most 24 MB');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > calls.MAX_PART_BYTES || bytes.length < 100) throw badRequest('Each part must be WAV audio up to 24 MB');
    return c.json(
      await calls.transcribePart({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, principal: c.var.principal, meta: c.var.meta, requestId: c.var.requestId }, id(c), id(c, 'fid'), {
        ...p,
        bytes,
        speakers: c.req.query('speakers') !== '0',
        analyse: c.req.query('analyse') === '1',
      }),
    );
  })
  .put('/calls/:id/speakers', async (c) => {
    const b = z.object({ names: z.record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(60).regex(/^[^:\[\]\n]+$/, 'Names cannot contain : [ or ]')) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.nameSpeakers(rctx(c, tx), id(c), b.names)));
  })
  .post('/calls/:id/analyse', async (c) => {
    const b = z.object({ createTasks: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await calls.analyseCall({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, principal: c.var.principal, meta: c.var.meta, requestId: c.var.requestId }, id(c), b));
  })
  .patch('/calls/:id/actions/:index', async (c) => {
    const index = z.coerce.number().int().min(0).max(100).parse(c.req.param('index'));
    const b = z.object({ owner: z.string().trim().max(80).optional(), task: z.string().trim().min(1).max(280).optional(), due: dateStr.nullish(), done: z.boolean().optional(), makeTask: z.boolean().optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.updateAction(rctx(c, tx), id(c), index, b)));
  })
  .post('/calls/:id/assign', async (c) => {
    const b = z.object({ projectId: uuid.nullable() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => calls.assignCall(rctx(c, tx), id(c), b.projectId)));
  })

  /* ───── projects ───── */
  .get('/projects', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listProjects(rctx(c, tx), { status: c.req.query('status') || null, search: c.req.query('q') || null, mine: c.req.query('mine') === '1' }))),
  )
  .get('/projects/:id', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.getProject(rctx(c, tx), id(c)))))
  .get('/projects/:id/summary', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.projectSummary(rctx(c, tx), id(c)))))
  .put('/projects/:id/members', async (c) => {
    const b = z
      .object({
        members: z
          .array(
            z.object({
              userId: uuid,
              role: z.enum(['manager', 'member', 'viewer']),
              billRate: z.number().min(0).max(1e9).nullish(),
              costRate: z.number().min(0).max(1e9).nullish(),
              payBasis: z.enum(['hourly', 'daily', 'monthly', 'fixed', 'commission', 'none']).optional(),
              payAmount: z.number().min(0).max(1e12).nullish(),
              commissionPct: z.number().min(0).max(100).nullish(),
              commissionOn: z.enum(['invoiced', 'collected', 'gross_profit', 'net_profit', 'profit_after_all']).optional(),
            }),
          )
          .max(200),
      })
      .parse(await c.req.json());
    const before = await c.var.db.tx(scope(c), async (tx) => {
      const was = await tx.query<{ user_id: string }>(`select user_id from project_members where tenant_id = $1 and project_id = $2`, [c.var.tenant.id, id(c)]);
      await pj.setMembers(rctx(c, tx), id(c), b.members);
      return was.map((w) => w.user_id);
    });
    // joining or leaving a team opens or closes Projects for them right away
    const { invalidatePrincipal } = await import('../services/tenancy');
    for (const u of new Set([...before, ...b.members.map((m) => m.userId)])) await invalidatePrincipal(c.env, c.var.tenant, u).catch(() => undefined);
    return c.json({ ok: true });
  })
  .post('/projects/:id/duplicate', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), startDate: dateStr.nullish(), accountId: uuid.nullish() }).parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pj.duplicateProject(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })

  /* ───── milestones and lists ───── */
  .post('/projects/:id/milestones', async (c) => {
    const b = milestoneSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveMilestone(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/milestones/:mid', async (c) => {
    const b = milestoneSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveMilestone(rctx(c, tx), id(c), id(c, 'mid'), b)));
  })
  .get('/projects/:id/milestones/:mid', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.milestoneDetail(rctx(c, tx), id(c), id(c, 'mid')))))
  .get('/projects/:id/milestone-candidates', async (c) => {
    const kind = z.enum(['invoice', 'payment', 'bill', 'vendor_payment']).parse(c.req.query('kind'));
    return c.json({ items: await c.var.db.tx(scope(c, true), (tx) => pj.milestoneCandidates(rctx(c, tx), id(c), kind)) });
  })
  .put('/projects/:id/milestones/:mid/links', async (c) => {
    const b = z.object({ kind: z.enum(['invoice', 'payment', 'bill', 'vendor_payment']), targetId: uuid, on: z.boolean() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.linkMilestone(rctx(c, tx), id(c), id(c, 'mid'), b.kind, b.targetId, b.on)));
  })
  .get('/projects/:id/approval-emails', async (c) => {
    const q = z.object({ milestone: uuid.optional(), q: z.string().max(200).optional(), scan: z.enum(['1', '0']).optional() }).parse(c.req.query());
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pj.approvalEmails(rctx(c, tx), id(c), { milestoneId: q.milestone ?? null, search: q.q ?? null, scan: q.scan === '1' })));
  })
  // every mailbox this person may search (mail intake, own Gmail / Outlook), any date; then the whole thread kept on the milestone
  .get('/projects/:id/mail-search', async (c) => {
    const q = z.object({ q: z.string().trim().min(3).max(200) }).parse(c.req.query());
    const sources = await c.var.db.tx(scope(c, true), async (tx) => {
      await pj.projectAccess(rctx(c, tx), id(c));
      return mt.mailSources(rctx(c, tx));
    });
    return c.json(await mt.searchThreads(c.env, c.var.db, c.var.tenant.id, sources, q.q));
  })
  .post('/projects/:id/milestones/:mid/mail-thread', async (c) => {
    const b = mt.attachSchema.parse(await c.req.json());
    const sources = await c.var.db.tx(scope(c, true), async (tx) => {
      await pj.projectAccess(rctx(c, tx), id(c), 'manage');
      return mt.mailSources(rctx(c, tx));
    });
    const raws = await mt.fetchThread(c.env, c.var.db, c.var.tenant.id, sources, b.source, b.key);
    if (!raws.length) throw badRequest('No messages found in that thread');
    try {
      return c.json(await c.var.db.tx(scope(c), (tx) => mt.saveThread(rctx(c, tx), c.env, id(c), id(c, 'mid'), b.key, raws)));
    } catch (e) {
      if (e instanceof ApiError || e instanceof ZodError) throw e;
      console.error(JSON.stringify({ level: 'error', msg: 'keeping a mail thread failed', error: (e as Error).message, stack: (e as Error).stack?.split('\n').slice(0, 5) }));
      throw new ApiError(500, 'internal', `Could not keep the thread: ${(e as Error).message.slice(0, 200)}`);
    }
  })
  /* ───── a milestone's invoice and money: found, approved, mapped ───── */
  .get('/projects/:id/milestones/:mid/billing', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => mb.milestoneBilling(rctx(c, tx), id(c), id(c, 'mid'), { q: c.req.query('q')?.slice(0, 100) ?? null }))),
  )
  .post('/projects/:id/milestones/:mid/billing/link', async (c) => {
    const b = z.object({ invoiceId: uuid }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => mb.linkInvoice(rctx(c, tx), id(c), id(c, 'mid'), b.invoiceId)));
  })
  .post('/projects/:id/milestones/:mid/billing/unlink', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => mb.unlinkInvoice(rctx(c, tx), id(c), id(c, 'mid')))))
  .post('/projects/:id/milestones/:mid/billing/map', async (c) => {
    const b = mb.mapSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => mb.mapMoney(rctx(c, tx), id(c), id(c, 'mid'), b));
    await emit(c, r.events);
    return c.json({ results: r.results, invoice: r.invoice });
  })
  .post('/projects/:id/milestones/:mid/billing/import', async (c) => {
    // an invoice that exists only as a PDF in the milestone's mail: read it into the books, approve it, link it
    const b = z.object({ fileId: uuid }).parse(await c.req.json());
    const file = await c.var.db.tx(scope(c, true), (tx) => mb.pdfForImport(rctx(c, tx), c.env, id(c), id(c, 'mid'), b.fileId));
    const batch = await c.var.db.tx(scope(c), (tx) => docs.createBatch(rctx(c, tx), `Milestone invoice: ${file.fileName}`));
    const run = <T,>(fn: (ctx: RecordCtx) => Promise<T>) => c.var.db.tx(scope(c), (tx) => fn(rctx(c, tx)));
    const ai = { env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, requestId: c.var.requestId, meta: c.var.meta };
    const staged = await docs.stageFile({ run, ai }, batch.id, { fileName: file.fileName, pdf: file.pdf });
    if (!staged.ids.length) throw badRequest(staged.note ?? 'No invoice could be read from that PDF');
    const out = await c.var.db.tx(scope(c), async (tx) => {
      const r = await docs.approveMany(rctx(c, tx), staged.ids);
      const invoiceId = r.results.map((x) => (x.created?.invoice as { id?: string } | undefined)?.id).find(Boolean) ?? null;
      if (!invoiceId) return { ok: false, error: r.results.find((x) => !x.ok)?.error ?? 'The invoice could not be created', batchId: batch.id };
      await mb.linkInvoice(rctx(c, tx), id(c), id(c, 'mid'), invoiceId);
      return { ok: true, invoiceId, events: r.events };
    });
    if ('events' in out && out.events) await emit(c, out.events as RecordEvent[]);
    return c.json({ ok: out.ok, invoiceId: 'invoiceId' in out ? out.invoiceId : null, error: 'error' in out ? out.error : null, batchId: 'batchId' in out ? out.batchId : null });
  })
  .get('/projects/:id/milestones/:mid/mail', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => mt.milestoneMail(rctx(c, tx), id(c), id(c, 'mid')))))
  .delete('/projects/:id/milestones/:mid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteMilestone(rctx(c, tx), id(c), id(c, 'mid')));
    return c.json({ ok: true });
  })
  .post('/projects/:id/lists', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), milestoneId: uuid.nullish(), position: z.number().int().min(0).max(100000).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveList(rctx(c, tx), id(c), null, b)), 201);
  })
  .put('/projects/:id/lists/:lid', async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(200), milestoneId: uuid.nullish(), position: z.number().int().min(0).max(100000).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveList(rctx(c, tx), id(c), id(c, 'lid'), b)));
  })
  .delete('/projects/:id/lists/:lid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteList(rctx(c, tx), id(c), id(c, 'lid')));
    return c.json({ ok: true });
  })

  /* ───── tasks ───── */
  .get('/projects/:id/tasks', async (c) =>
    c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        pj.listTasks(rctx(c, tx), id(c), { assignee: c.req.query('assignee') ? uuid.parse(c.req.query('assignee')) : null, status: c.req.query('status') || null, listId: c.req.query('listId') ? uuid.parse(c.req.query('listId')) : null }),
      ),
    ),
  )
  .post('/projects/:id/tasks', async (c) => {
    const b = taskSchema.required({ name: true }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.createTask(rctx(c, tx), id(c), b)), 201);
  })
  .patch('/projects/:id/tasks/:tid', async (c) => {
    const b = taskSchema.strict().parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.updateTask(rctx(c, tx), id(c), id(c, 'tid'), b));
    return c.json({ ok: true });
  })
  .delete('/projects/:id/tasks/:tid', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteTask(rctx(c, tx), id(c), id(c, 'tid')));
    return c.json({ ok: true });
  })
  .post('/projects/:id/tasks/:tid/deps', async (c) => {
    const b = z.object({ dependsOnId: uuid, kind: z.enum(['fs', 'ss', 'ff', 'sf']).default('fs'), lagDays: z.number().int().min(-365).max(365).default(0) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.addDependency(rctx(c, tx), id(c), id(c, 'tid'), b.dependsOnId, b.kind, b.lagDays));
    return c.json({ ok: true });
  })
  .delete('/projects/:id/tasks/:tid/deps/:did', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.removeDependency(rctx(c, tx), id(c), id(c, 'tid'), id(c, 'did')));
    return c.json({ ok: true });
  })
  .get('/projects/:id/tasks/:tid/comments', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listComments(rctx(c, tx), id(c), { taskId: id(c, 'tid') }))))
  .post('/projects/:id/tasks/:tid/comments', async (c) => {
    const b = z.object({ body: z.string().trim().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.addComment(rctx(c, tx), id(c), { taskId: id(c, 'tid') }, b.body)), 201);
  })

  /* ───── issues ───── */
  .get('/projects/:id/issues', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listIssues(rctx(c, tx), id(c), c.req.query('status') || null))))
  .post('/projects/:id/issues', async (c) => {
    const b = issueSchema.required({ title: true }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveIssue(rctx(c, tx), id(c), null, b)), 201);
  })
  .patch('/projects/:id/issues/:iid', async (c) => {
    const b = issueSchema.strict().parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveIssue(rctx(c, tx), id(c), id(c, 'iid'), b)));
  })
  .get('/projects/:id/issues/:iid/comments', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.listComments(rctx(c, tx), id(c), { issueId: id(c, 'iid') }))))
  .post('/projects/:id/issues/:iid/comments', async (c) => {
    const b = z.object({ body: z.string().trim().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.addComment(rctx(c, tx), id(c), { issueId: id(c, 'iid') }, b.body)), 201);
  })

  .get('/projects/:id/costs', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.projectCosts(rctx(c, tx), id(c)))))

  /* ───── billing ───── */
  .get('/projects/:id/unbilled', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.unbilled(rctx(c, tx), id(c), qDate(c, 'upTo', today())))))
  .post('/projects/:id/invoice', async (c) => {
    const b = z
      .object({
        entryIds: z.array(uuid).max(5000).optional(),
        expenseIds: z.array(uuid).max(500).optional(),
        milestoneIds: z.array(uuid).max(200).optional(),
        groupBy: z.enum(['task', 'person', 'project', 'entry']).optional(),
        fixedAmount: z.number().min(0).max(1e12).nullish(),
        fixedLabel: z.string().max(300).nullish(),
      })
      .parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pj.invoiceProject(rctx(c, tx), id(c), b));
    await emit(c, r.events);
    return c.json({ id: r.id }, 201);
  })

  /* ───── time ───── */
  .post('/time', async (c) => {
    const b = timeSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.logTime(rctx(c, tx), b)), 201);
  })
  .patch('/time/:id', async (c) => {
    const b = timeSchema.omit({ projectId: true, userId: true }).partial().strict().parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.updateTime(rctx(c, tx), id(c), b));
    return c.json({ ok: true });
  })
  .delete('/time/:id', async (c) => {
    await c.var.db.tx(scope(c), (tx) => pj.deleteTime(rctx(c, tx), id(c)));
    return c.json({ ok: true });
  })
  .get('/time/timer', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.runningTimer(rctx(c, tx)))))
  .post('/time/timer/start', async (c) => {
    const b = z.object({ projectId: uuid, taskId: uuid.nullish(), issueId: uuid.nullish(), notes: z.string().max(2000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.startTimer(rctx(c, tx), b)), 201);
  })
  .post('/time/timer/stop', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pj.stopTimer(rctx(c, tx)))))
  .get('/timesheet', async (c) =>
    c.json(await c.var.db.tx(scope(c, true), (tx) => pj.getWeek(rctx(c, tx), qDate(c, 'date', today()), c.req.query('userId') ? uuid.parse(c.req.query('userId')) : null))),
  )
  .put('/timesheet', async (c) => {
    const b = z
      .object({
        date: dateStr,
        rows: z.array(z.object({ projectId: uuid, taskId: uuid.nullish(), billable: z.boolean().optional(), notes: z.string().max(2000).nullish(), minutes: z.array(z.number().int().min(0).max(1440)).length(7) })).max(100),
      })
      .parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.saveWeek(rctx(c, tx), b.date, b.rows)));
  })
  .post('/timesheet/submit', async (c) => {
    const b = z.object({ date: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.submitWeek(rctx(c, tx), b.date)));
  })
  /* ───── work calendar & automatic timesheets ───── */
  .get('/timesheet/calendar', async (c) => {
    const y = c.req.query('year') ? z.coerce.number().int().min(2000).max(2100).parse(c.req.query('year')) : undefined;
    return c.json(await c.var.db.tx(scope(c, true), (tx) => at.getCalendar(rctx(c, tx), y)));
  })
  .put('/timesheet/calendar', async (c) => {
    const b = at.calendarSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.saveCalendar(rctx(c, tx), b)));
  })
  .post('/timesheet/holidays', async (c) => {
    const b = at.holidaySchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.addHoliday(rctx(c, tx), b)), 201);
  })
  .post('/timesheet/holidays/national', async (c) => {
    const b = z.object({ year: z.number().int().min(2000).max(2100) }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.addNationalHolidays(rctx(c, tx), b.year)));
  })
  .delete('/timesheet/holidays/:id', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => at.deleteHoliday(rctx(c, tx), id(c)))))
  .put('/timesheet/people/:id', async (c) => {
    const b = at.personSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.savePerson(rctx(c, tx), id(c), b)));
  })
  .post('/timesheet/fill-week', async (c) => {
    const b = z.object({ date: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.fillMyWeek(rctx(c, tx), b.date)));
  })
  .post('/timesheet/fill-everyone', async (c) => {
    const b = z.object({ from: dateStr, to: dateStr }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => at.fillEveryone(rctx(c, tx), b.from, b.to)));
  })
  .get('/timesheet/approvals', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.pendingApprovals(rctx(c, tx)))))
  .post('/timesheet/decide', async (c) => {
    const b = z.object({ entryIds: z.array(uuid).min(1).max(2000), decision: z.enum(['approve', 'reject']), reason: z.string().trim().max(1000).nullish() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pj.decideTime(rctx(c, tx), b.entryIds, b.decision, b.reason)));
  })

  /* ───── reports ───── */
  .get('/my-tasks', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pj.myTasks(rctx(c, tx)))))
  .get('/project-reports/time', async (c) => {
    const groupBy = z.enum(['person', 'project', 'task', 'day']).parse(c.req.query('groupBy') ?? 'person');
    const from = qDate(c, 'from', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    return c.json(
      await c.var.db.tx(scope(c, true), (tx) =>
        pj.timeReport(rctx(c, tx), { from, to: qDate(c, 'to', today()), groupBy, projectId: c.req.query('projectId') ? uuid.parse(c.req.query('projectId')) : null, userId: c.req.query('userId') ? uuid.parse(c.req.query('userId')) : null }),
      ),
    );
  })
  .get('/project-reports/utilisation', async (c) => {
    const from = qDate(c, 'from', new Date(Date.now() - 27 * 86_400_000).toISOString().slice(0, 10));
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pj.utilisation(rctx(c, tx), from, qDate(c, 'to', today()))));
  })
  .get('/projects/:id/time-entries', async (c) => {
    const from = qDate(c, 'from', new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
    const userId = c.req.query('userId') ? uuid.parse(c.req.query('userId')) : null;
    return c.json(await c.var.db.tx(scope(c, true), (tx) => pj.projectTimeEntries(rctx(c, tx), id(c), { from, to: qDate(c, 'to', today()), userId })));
  })
  .put('/project-reports/capacity/:id', async (c) => {
    const b = z.object({ weeklyHours: z.number().min(0).max(100) }).parse(await c.req.json());
    await c.var.db.tx(scope(c), (tx) => pj.setCapacity(rctx(c, tx), id(c), b.weeklyHours));
    return c.json({ ok: true });
  });
