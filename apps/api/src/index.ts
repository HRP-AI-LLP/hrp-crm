/**
 * HRP Synapse edge gateway (Cloudflare Worker).
 *   fetch     → Hono app: tenant resolution, auth, API, SPA assets
 *   queue     → background jobs (workflows, AI scoring, KB indexing, messaging, webhooks)
 *   scheduled → housekeeping (expired sessions, stale AI usage rows)
 */
import { createApp } from './app';
import type { Env } from './env';
import { Db } from './lib/db';
import type { Job } from './services/jobs';
import { processJob } from './services/worker';

const app = createApp();

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<Job>, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      try {
        await processJob(env, msg.body, ctx);
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', job: msg.body.type, tenant: msg.body.tenantId, attempt: msg.attempts, msg: (e as Error).message }));
        msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** msg.attempts) });
      }
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Platform housekeeping runs per tenant under RLS (no bypass role exists).
    const db = Db.fromEnv(env);
    try {
      const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
      for (const t of tenants) {
        await db.tx({ tenantId: t.tenant_id }, async (tx) => {
          await tx.query(`delete from sessions where tenant_id = $1 and (expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days')`, [t.tenant_id]);
          await tx.query(`delete from ai_usage where tenant_id = $1 and created_at < now() - interval '90 days'`, [t.tenant_id]);
        });
      }
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env, Job>;
