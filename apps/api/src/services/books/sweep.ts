/** Daily books housekeeping for one workspace: recurring documents. */
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { enabledApps } from '../apps';
import { enqueue, eventJobs } from '../jobs';
import { systemCtxFor } from '../system';
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
  return { created: r.created };
}
