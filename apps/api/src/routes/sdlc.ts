/** AI delivery (mounted at /api/v1): runs of specialist agents, documents and diagrams. */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import type { AiCtx } from '../services/ai/features';
import { enqueue } from '../services/jobs';
import type { RecordCtx } from '../services/records';
import * as sd from '../services/sdlc';
import { safeCtx } from './public';

const uuid = z.string().uuid();
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};
function run<T>(c: Context<AppEnv>, fn: (ctx: RecordCtx) => Promise<T>, readOnly = false) {
  return c.var.db.tx(scope(c, readOnly), (tx) => fn({ tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id }));
}
const ai = (c: Context<AppEnv>): AiCtx => ({ env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, meta: c.var.meta, requestId: c.var.requestId });
const advance = (c: Context<AppEnv>, runId: string) => enqueue(c.env, safeCtx(c), [{ type: 'sdlc.advance', tenantId: c.var.tenant.id, runId }]);

export const sdlcRoutes = new Hono<AppEnv>()
  .get('/sdlc/catalogue', (c) => c.json(sd.catalogue()))
  .get('/sdlc/runs', async (c) => {
    const p = c.req.query('projectId');
    return c.json({ items: await run(c, (ctx) => sd.listRuns(ctx, p && uuid.safeParse(p).success ? p : null), true) });
  })
  .post('/sdlc/runs', async (c) => {
    const body = sd.createRunSchema.parse(await c.req.json());
    const r = await run(c, (ctx) => sd.createRun(ctx, body));
    if (r.advance) await advance(c, r.id);
    return c.json({ id: r.id }, 201);
  })
  .get('/sdlc/runs/:id', async (c) => c.json(await run(c, (ctx) => sd.getRun(ctx, id(c)), true)))
  .put('/sdlc/runs/:id/plan', async (c) => {
    const body = sd.planSchema.parse(await c.req.json());
    return c.json(await run(c, (ctx) => sd.savePlan(ctx, id(c), body)));
  })
  .post('/sdlc/runs/:id/start', async (c) => {
    await run(c, (ctx) => sd.startRun(ctx, id(c)));
    await advance(c, id(c));
    return c.json({ ok: true });
  })
  .post('/sdlc/runs/:id/cancel', async (c) => c.json(await run(c, (ctx) => sd.cancelRun(ctx, id(c)))))
  .delete('/sdlc/runs/:id', async (c) => c.json(await run(c, (ctx) => sd.deleteRun(ctx, id(c)))))
  .post('/sdlc/steps/:id/review', async (c) => {
    const body = sd.reviewSchema.parse(await c.req.json());
    const r = await run(c, async (ctx) => {
      const out = await sd.reviewStep(ctx, id(c), body);
      const s = await ctx.tx.one<{ run_id: string }>(`select run_id from sdlc_steps where tenant_id = $1 and id = $2`, [ctx.tenantId, id(c)]);
      return { ...out, runId: s!.run_id };
    });
    if (r.advance) await advance(c, r.runId);
    return c.json({ ok: true, output: r.output ?? null });
  })
  .get('/sdlc/artifacts', async (c) => {
    const p = c.req.query('projectId');
    const kind = c.req.query('kind');
    return c.json({
      items: await run(
        c,
        (ctx) => sd.listArtifacts(ctx, { projectId: p && uuid.safeParse(p).success ? p : null, kind: kind === 'document' || kind === 'diagram' ? kind : null, q: c.req.query('q') ?? null, approved: c.req.query('approved') === '1' }),
        true,
      ),
    });
  })
  .post('/sdlc/artifacts', async (c) => {
    const body = sd.newArtifactSchema.parse(await c.req.json());
    return c.json(await run(c, (ctx) => sd.createArtifact(ctx, body)), 201);
  })
  .get('/sdlc/artifacts/:id', async (c) => c.json(await run(c, (ctx) => sd.getArtifact(ctx, id(c)), true)))
  .put('/sdlc/artifacts/:id', async (c) => {
    const body = sd.saveArtifactSchema.parse(await c.req.json());
    return c.json(await run(c, (ctx) => sd.saveArtifact(ctx, id(c), body)));
  })
  .delete('/sdlc/artifacts/:id', async (c) => c.json(await run(c, (ctx) => sd.deleteArtifact(ctx, id(c)))))
  .get('/sdlc/artifacts/:id/versions/:v', async (c) => {
    const v = z.coerce.number().int().min(1).parse(c.req.param('v'));
    return c.json(await run(c, (ctx) => sd.artifactVersion(ctx, id(c), v), true));
  })
  .put('/sdlc/artifacts/:id/drawio', async (c) => {
    const b = z.object({ xml: z.string().min(20).max(2_000_000) }).parse(await c.req.json());
    return c.json(await run(c, (ctx) => sd.saveDrawio(ctx, id(c), b.xml)));
  })
  .post('/sdlc/diagrams/generate', async (c) => {
    const body = sd.diagramSchema.parse(await c.req.json());
    const context = await run(c, (ctx) => sd.diagramContext(ctx, body.projectId), true);
    const d = await sd.generateDiagram(ai(c), body, context);
    const saved = body.save ? await run(c, (ctx) => sd.saveGenerated(ctx, body.projectId, d)) : null;
    return c.json({ ...d, id: saved?.id ?? null });
  })
  .post('/sdlc/diagrams/render', async (c) => c.json(sd.renderDiagram(sd.renderSchema.parse(await c.req.json()).spec)))
  .post('/sdlc/documents/generate', async (c) => {
    const b = z
      .object({ prompt: z.string().trim().min(5).max(20000), docType: z.string().max(40).default('custom'), title: z.string().trim().max(200).nullish(), projectId: z.string().uuid().nullish() })
      .parse(await c.req.json());
    const dt = sd.DOC_TYPES[b.docType] ?? sd.DOC_TYPES.custom!;
    const title = b.title?.trim() || (b.docType === 'custom' ? b.prompt.split('\n')[0]!.slice(0, 100) : dt.label);
    const r = await run(c, (ctx) =>
      sd.createRun(ctx, {
        goal: b.prompt,
        title,
        projectId: b.projectId ?? null,
        template: 'custom',
        reviewMode: 'none',
        autoStart: true,
        steps: [{ agent: dt.agent, kind: 'document', title, docType: sd.DOC_TYPES[b.docType] ? b.docType : 'custom' }],
      }),
    );
    await advance(c, r.id);
    return c.json({ runId: r.id }, 201);
  });
