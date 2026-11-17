/** Daily books housekeeping for one workspace: recurring documents. */
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { enabledApps } from '../apps';
import { enqueue, eventJobs } from '../jobs';
import { systemCtxFor } from '../system';
import { type DeskDeps, runDesk } from './desk';
import { recurringSweep } from './setup';

export async function booksDailySweep(env: Env, db: Db, tenantId: string) {
  const on = await db.tx({ tenantId, readOnly: true }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    return !!ctx && enabledApps(ctx.meta).has('books');
  });
  if (!on) return { created: 0 };
  const r = await recurringSweep((fn) =>
    db.tx({ tenantId }, async (tx) => {
      const ctx = await systemCtxFor(env, tx, tenantId);
      if (!ctx) throw new Error('workspace not found');
      return fn(ctx);
    }),
  );
  await enqueue(env, null, eventJobs(tenantId, null, r.events));
  const desk = await deskSweep(env, db, tenantId).catch((e) => ({ error: (e as Error).message }));
  return { created: r.created, desk };
}

/**
 * The accounts desk's daily round, for workspaces that use it (desk settings saved or a live feed
 * connected): feeds → bookkeeper → compliance, and in the first week of a month the controller
 * closes the previous month once.
 */
export async function deskSweep(env: Env, db: Db, tenantId: string) {
  const state = await db.tx({ tenantId, readOnly: true }, async (tx) => {
    const s = await tx.one<{ enabled: boolean }>(`select enabled from acct_desk_settings where tenant_id = $1`, [tenantId]);
    const feeds = await tx.one<{ n: number }>(`select count(*)::int as n from bank_feeds where tenant_id = $1 and status <> 'paused'`, [tenantId]);
    const ist = new Date(Date.now() + 5.5 * 3_600_000);
    const prev = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const closed = await tx.one(`select 1 from acct_runs where tenant_id = $1 and agent = 'controller' and period = $2 and finished_at is not null`, [tenantId, prev]);
    return { used: s ? s.enabled : (feeds?.n ?? 0) > 0, closeMonth: ist.getUTCDate() <= 7 && !closed ? prev : null };
  });
  if (!state.used) return { skipped: true };
  const deps: DeskDeps = {
    env,
    db,
    tenantId,
    run: (fn, readOnly = false) =>
      db.tx({ tenantId, readOnly }, async (tx) => {
        const ctx = await systemCtxFor(env, tx, tenantId);
        if (!ctx) throw new Error('workspace not found');
        return fn(ctx);
      }),
    ai: null,
  };
  // the model runs as the workspace (no user), through the workspace's own AI settings
  deps.ai = await db.tx({ tenantId, readOnly: true }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    return ctx ? { env, db, tenantId, userId: null, meta: ctx.meta } : null;
  });
  const agents: ('bank_clerk' | 'bookkeeper' | 'compliance' | 'controller')[] = ['bank_clerk', 'bookkeeper', 'compliance'];
  if (state.closeMonth) agents.push('controller');
  const r = await runDesk(deps, { trigger: 'schedule', agents, period: state.closeMonth });
  await enqueue(env, null, eventJobs(tenantId, null, r.events));
  return { ran: agents };
}
