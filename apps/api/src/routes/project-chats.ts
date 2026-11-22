/** WhatsApp chats on projects: link, import, read with AI, turn suggestions into work. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { notFound } from '../lib/errors';
import { scope } from '../middleware';
import * as pc from '../services/project-chats';
import type { RecordCtx } from '../services/records';

const uuid = z.string().uuid();
function rctx(c: { var: AppEnv['Variables'] }, tx: RecordCtx['tx']): RecordCtx {
  return { tx, meta: c.var.meta, principal: c.var.principal, tenantId: c.var.tenant.id };
}
const id = (c: { req: { param: (k: string) => string } }, k = 'id') => {
  const v = c.req.param(k);
  if (!uuid.safeParse(v).success) throw notFound();
  return v;
};

export const projectChatRoutes = new Hono<AppEnv>()
  .get('/projects/:id/chats', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pc.listChats(rctx(c, tx), id(c)))))
  .get('/projects/:id/chats/choices', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pc.chatChoices(rctx(c, tx), id(c)))))
  .post('/projects/:id/chats', async (c) => {
    const b = pc.linkSchema.parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pc.linkChat(rctx(c, tx), id(c), b)), 201);
  })
  .post('/projects/:id/chats/import', async (c) => {
    const b = pc.importSchema.parse(await c.req.json());
    const r = await c.var.db.tx(scope(c), (tx) => pc.importExport(rctx(c, tx), id(c), b));
    if (r.added) await pc.flagPending(c.env);
    return c.json(r);
  })
  .post('/projects/:id/chats/group', async (c) => {
    const b = z.object({ channelAccountId: uuid, subject: z.string().trim().min(1).max(128), description: z.string().max(2048).nullish(), mode: z.enum(['suggest', 'auto', 'off']).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pc.createProjectGroup(rctx(c, tx), c.env, id(c), b)), 201);
  })
  .post('/projects/:id/chats/groups/:gid/invite', async (c) => {
    const b = z.object({ reset: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    return c.json(
      await c.var.db.tx(scope(c), async (tx) => {
        const ctx = rctx(c, tx);
        await pc.listChats(ctx, id(c)); // project access
        return pc.refreshInvite(ctx, c.env, id(c, 'gid'), b.reset);
      }),
    );
  })
  .patch('/projects/:id/chats/:cid', async (c) => {
    const b = z.object({ title: z.string().trim().min(1).max(200).optional(), mode: z.enum(['suggest', 'auto', 'off']).optional() }).parse(await c.req.json());
    return c.json(await c.var.db.tx(scope(c), (tx) => pc.updateChat(rctx(c, tx), id(c), id(c, 'cid'), b)));
  })
  .delete('/projects/:id/chats/:cid', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pc.unlinkChat(rctx(c, tx), id(c), id(c, 'cid')))))
  .get('/projects/:id/chats/:cid/messages', async (c) => c.json(await c.var.db.tx(scope(c, true), (tx) => pc.chatMessages(rctx(c, tx), id(c), id(c, 'cid'), c.req.query('before') || null))))
  .post('/projects/:id/chats/:cid/analyse', async (c) => {
    const who = await c.var.db.tx(scope(c, true), (tx) => pc.analyseNow(c.env, c.var.db, rctx(c, tx), id(c), id(c, 'cid')));
    return c.json(await pc.analyseChat(c.env, c.var.db, who.tenantId, id(c, 'cid'), who.userId));
  })
  .post('/projects/:id/chat-proposals/:pid/accept', async (c) => {
    const b = pc.acceptSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await c.var.db.tx(scope(c), (tx) => pc.acceptProposal(rctx(c, tx), c.env, id(c), id(c, 'pid'), b)));
  })
  .post('/projects/:id/chat-proposals/:pid/dismiss', async (c) => c.json(await c.var.db.tx(scope(c), (tx) => pc.dismissProposal(rctx(c, tx), id(c), id(c, 'pid')))));
