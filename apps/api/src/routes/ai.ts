import { objectPerm } from '@synapse/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ApiError, forbidden, notFound } from '../lib/errors';
import { requireAdmin, scope } from '../middleware';
import { type AiCtx, analyzeSentiment, askKnowledgeBase, draftEmail, nextBestActions, scoreLead, summarizeRecord } from '../services/ai/features';
import { AiUnavailableError, availableProviders } from '../services/ai/router';
import { tenantAiSettings } from '../services/ai/tenant-providers';
import { enqueue } from '../services/jobs';
import { getRecord } from '../services/records';
import { safeCtx } from './public';

function aiCtx(c: { env: AppEnv['Bindings']; var: AppEnv['Variables'] }): AiCtx {
  return { env: c.env, db: c.var.db, tenantId: c.var.tenant.id, userId: c.var.principal.user.id, requestId: c.var.requestId, meta: c.var.meta };
}

/** Confirms the caller may read the record before any AI feature touches it. */
async function assertReadable(c: { var: AppEnv['Variables'] }, objectKey: string, id: string) {
  await c.var.db.tx(scope(c, true), (tx) => getRecord({ tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id }, objectKey, id));
}

const mapAiError = (e: unknown) => {
  if (e instanceof AiUnavailableError) return new ApiError(503, 'ai_unavailable', 'AI is temporarily unavailable. Configure Workers AI, Groq or Gemini, or try again later.');
  return e;
};

export const aiRoutes = new Hono<AppEnv>()
  .get('/status', async (c) => {
    const { own, settings } = await c.var.db.tx(scope(c, true), async (tx) => ({
      own: await tx.query<{ provider: string; model: string; allow_pii: boolean }>(
        `select provider, model, allow_pii from tenant_ai_providers where tenant_id = $1 and is_enabled order by priority`,
        [c.var.tenant.id],
      ),
      settings: await tenantAiSettings(tx, c.var.tenant.id),
    }));
    return c.json({
      workspaceProviders: own,
      platformFallback: settings.platformFallback,
      platformProviders: settings.platformFallback ? availableProviders(c.env, false) : [],
      vectorSearch: !!c.env.VECTORIZE,
    });
  })
  .post('/score/lead/:id', async (c) => {
    const id = c.req.param('id');
    if (objectPerm(c.var.principal.permissions, 'lead').update === 'none') throw forbidden();
    await assertReadable(c, 'lead', id);
    return c.json(await scoreLead(aiCtx(c), id).catch((e) => Promise.reject(mapAiError(e))));
  })
  .post('/summarize/:object/:id', async (c) => {
    const { object, id } = c.req.param();
    await assertReadable(c, object, id);
    return c.json(await summarizeRecord(aiCtx(c), object, id).catch((e) => Promise.reject(mapAiError(e))));
  })
  .post('/next-actions/:object/:id', async (c) => {
    const { object, id } = c.req.param();
    await assertReadable(c, object, id);
    return c.json(await nextBestActions(aiCtx(c), object, id).catch((e) => Promise.reject(mapAiError(e))));
  })
  .post('/draft-email/:object/:id', async (c) => {
    const { object, id } = c.req.param();
    const b = z.object({ intent: z.string().min(3).max(500), incoming: z.string().max(10_000).optional() }).parse(await c.req.json());
    await assertReadable(c, object, id);
    return c.json(await draftEmail(aiCtx(c), object, id, b.intent, b.incoming).catch((e) => Promise.reject(mapAiError(e))));
  })
  .post('/sentiment', async (c) => {
    const b = z.object({ text: z.string().min(1).max(10_000) }).parse(await c.req.json());
    return c.json(await analyzeSentiment(aiCtx(c), b.text).catch((e) => Promise.reject(mapAiError(e))));
  })

  // ---------------------------------------------------------------- knowledge base (RAG)
  .get('/kb/documents', async (c) =>
    c.json({ items: await c.var.db.tx(scope(c, true), (tx) => tx.query(`select id, title, source, status, chunk_count, error, created_at from kb_documents where tenant_id = $1 order by created_at desc`, [c.var.tenant.id])) }),
  )
  .post('/kb/documents', requireAdmin('ai'), async (c) => {
    const b = z.object({ title: z.string().min(1).max(200), content: z.string().min(1).max(500_000), source: z.string().max(500).optional() }).parse(await c.req.json());
    const doc = await c.var.db.tx(scope(c), (tx) =>
      tx.one<{ id: string }>(`insert into kb_documents (tenant_id, title, source, content) values ($1,$2,$3,$4) returning id`, [c.var.tenant.id, b.title, b.source ?? null, b.content]),
    );
    await enqueue(c.env, safeCtx(c), [{ type: 'kb.index', tenantId: c.var.tenant.id, documentId: doc!.id }]);
    return c.json({ id: doc!.id, status: 'pending' }, 202);
  })
  .delete('/kb/documents/:id', requireAdmin('ai'), async (c) => {
    const id = z.string().uuid().parse(c.req.param('id'));
    const chunkIds = await c.var.db.tx(scope(c), async (tx) => {
      const ids = await tx.query<{ id: string }>(`select id from kb_chunks where tenant_id = $1 and document_id = $2`, [c.var.tenant.id, id]);
      const del = await tx.query(`delete from kb_documents where tenant_id = $1 and id = $2 returning id`, [c.var.tenant.id, id]);
      if (!del.length) throw notFound();
      return ids.map((r) => r.id);
    });
    if (c.env.VECTORIZE && chunkIds.length) await c.env.VECTORIZE.deleteByIds(chunkIds).catch(() => undefined);
    return c.json({ ok: true });
  })
  .post('/kb/ask', async (c) => {
    const b = z.object({ question: z.string().min(3).max(1000) }).parse(await c.req.json());
    return c.json(await askKnowledgeBase(aiCtx(c), b.question).catch((e) => Promise.reject(mapAiError(e))));
  });
