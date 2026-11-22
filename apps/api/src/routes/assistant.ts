/** The workspace assistant (mounted at /api/v1): chats, and approving or rejecting its proposed changes. */
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { forbidden, notFound } from '../lib/errors';
import * as as from '../services/assistant';

const uuid = z.string().uuid();
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function caller(c: Context<AppEnv, any>): as.Caller {
  if (c.var.principal.apiKey) throw forbidden('The assistant works in the app, not with API keys');
  const headers: Record<string, string> = {};
  for (const h of ['authorization', 'x-tenant', 'x-forwarded-host', 'cf-connecting-ip', 'user-agent', 'origin']) {
    const v = c.req.header(h);
    if (v) headers[h] = v;
  }
  let exec: ExecutionContext | undefined;
  try {
    exec = c.executionCtx as ExecutionContext;
  } catch {
    /* tests */
  }
  return { env: c.env, db: c.var.db, tenantId: c.var.tenant.id, meta: c.var.meta, principal: c.var.principal, origin: new URL(c.req.url).origin, headers, exec, requestId: c.var.requestId };
}

export const assistantRoutes = new Hono<AppEnv>()
  .get('/assistant/threads', async (c) => c.json({ items: await as.listThreads(caller(c)) }))
  .get('/assistant/threads/:id', async (c) => c.json(await as.getThread(caller(c), id(c))))
  .delete('/assistant/threads/:id', async (c) => c.json(await as.deleteThread(caller(c), id(c))))
  .post('/assistant/chat', async (c) => c.json(await as.chat(caller(c), as.chatSchema.parse(await c.req.json()))))
  .post('/assistant/threads/:id/continue', async (c) => {
    const b = z.object({ page: z.string().max(400).nullish() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await as.continueThread(caller(c), id(c), b.page ?? null));
  })
  .post('/assistant/actions/:id/approve', async (c) => {
    const b = z.object({ body: z.unknown().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await as.approveAction(caller(c), id(c), b));
  })
  .post('/assistant/actions/:id/reject', async (c) => c.json(await as.rejectAction(caller(c), id(c))))
  .get('/assistant/fields/:object', async (c) => c.json(as.objectFields(caller(c), c.req.param('object'))));
