/** Daily IT round for one workspace: contract billing and renewals, subscription renewals and invoices. */
import type { Env } from '../../env';
import type { Db } from '../../lib/db';
import { enabledApps } from '../apps';
import { enqueue, eventJobs } from '../jobs';
import { systemCtxFor } from '../system';
import { runContracts } from './contracts';
import { runSubscriptions } from './saas';

export async function itDailySweep(env: Env, db: Db, tenantId: string) {
  const state = await db.tx({ tenantId, readOnly: true }, async (tx) => {
    const ctx = await systemCtxFor(env, tx, tenantId);
    if (!ctx || !enabledApps(ctx.meta).has('projects')) return null;
    const n = await tx.one<{ c: number; s: number }>(
      `select (select count(*)::int from service_contracts where tenant_id = $1 and status = 'active') as c,
              (select count(*)::int from saas_subscriptions where tenant_id = $1 and status in ('trial','active','past_due')) as s`,
      [tenantId],
    );
    return n;
  });
  if (!state || (!state.c && !state.s)) return { skipped: true };
  const run = <T>(fn: (ctx: NonNullable<Awaited<ReturnType<typeof systemCtxFor>>>) => Promise<T>) =>
    db.tx({ tenantId }, async (tx) => {
      const ctx = await systemCtxFor(env, tx, tenantId);
      if (!ctx) throw new Error('workspace not found');
      return fn(ctx);
    });
  const contracts = state.c ? await run((ctx) => runContracts(ctx)) : null;
  const subs = state.s ? await run((ctx) => runSubscriptions(ctx)) : null;
  await enqueue(env, null, eventJobs(tenantId, null, [...(contracts?.events ?? []), ...(subs?.events ?? [])]));
  return { contracts: contracts && { invoiced: contracts.invoiced, renewed: contracts.renewed, expired: contracts.expired }, subscriptions: subs && { invoiced: subs.invoiced, renewed: subs.renewed, cancelled: subs.cancelled } };
}
