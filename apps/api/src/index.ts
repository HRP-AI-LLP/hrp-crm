/**
 * HRP Synapse edge gateway (Cloudflare Worker).
 *   fetch     → Hono app: tenant resolution, auth, API, SPA assets
 *   queue     → background jobs (workflows, AI scoring, KB indexing, messaging, webhooks)
 *   scheduled → reminders every 5 minutes (KV-gated), daily housekeeping
 */
import { createApp } from './app';
import type { Env } from './env';
import { Db } from './lib/db';
import type { Job } from './services/jobs';
import { dailyBackups } from './services/backup';
import { analyseAsOwner } from './services/calls';
import { mailSweep } from './services/mail';
import { meetingSweep } from './services/meetings';
import { statementSweep } from './services/books/statement-mail';
import { gemDetailsSweep } from './services/intake/gem-fetch';
import { intakeSweep } from './services/intake/intake';
import { campaignSweep } from './services/campaigns';
import { digestSweep } from './services/digests';
import { intelSweep } from './services/intel/sweep';
import { reminderSweep } from './services/reminders';
import { privacyDailySweep } from './services/privacy';
import { systemCtxFor } from './services/system';
import { booksDailySweep } from './services/books/sweep';
import { assetRenewalSweep } from './services/industry/itops';
import { sequenceSweep } from './services/industry/sequences';
import { itDailySweep } from './services/it/sweep';
import { queueDueSoon, workMailSweep } from './services/it/alerts';
import { scheduledRulesSweep } from './services/it/rules';
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

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Platform housekeeping runs per tenant under RLS (no bypass role exists).
    const db = Db.fromEnv(env);
    try {
      if (controller.cron === '*/5 * * * *') {
        // reminders: a KV read decides whether the database needs waking at all
        await reminderSweep(env, db);
        // connected Gmail / Outlook mailboxes (each at most every ~15 minutes)
        await mailSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'mail-sweep', msg: (e as Error).message })));
        // Zoom / Meet / Teams calls that ended: transcript fetched, then analysed into minutes and actions
        await meetingSweep(env, db, (t, e, o) => analyseAsOwner(env, db, t, e, o)).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'meeting-sweep', msg: (e as Error).message })));
        // mailboxes read for GeM alerts, bills and invoices (each at most every ~15 minutes)
        await intakeSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'intake-sweep', msg: (e as Error).message })));
        // followed GeM bids: details and bid documents read from GeM's public pages
        await gemDetailsSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'gem-details', msg: (e as Error).message })));
        // statements that came by mail: opened with the saved passwords, imported, handed to the desk
        await statementSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'statement-mail', msg: (e as Error).message })));
        // campaigns send in batches while one is running (a KV flag keeps idle workspaces asleep)
        await campaignSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'campaign-sweep', msg: (e as Error).message })));
        await digestSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'digest-sweep', msg: (e as Error).message })));
        // revenue intelligence: scores, insights, auto meeting prep, search index (hourly, KV-gated)
        await intelSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'intel-sweep', msg: (e as Error).message })));
        // work items: scheduled automation rules (hourly), then watcher / assignee emails and chat posts
        if (new Date().getUTCMinutes() < 5) await scheduledRulesSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'work-rules', msg: (e as Error).message })));
        await workMailSweep(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'work-mail', msg: (e as Error).message })));
        return;
      }
      await reminderSweep(env, db, true);
      const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
      for (const t of tenants) {
        await db.tx({ tenantId: t.tenant_id }, async (tx) => {
          await tx.query(`delete from sessions where tenant_id = $1 and (expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days')`, [t.tenant_id]);
          await tx.query(`delete from ai_usage where tenant_id = $1 and created_at < now() - interval '90 days'`, [t.tenant_id]);
          await tx.query(`delete from webhook_deliveries where tenant_id = $1 and created_at < now() - interval '30 days'`, [t.tenant_id]);
        });
        // privacy: request deadlines and the workspace's own retention rules
        await privacyDailySweep(env, db, t.tenant_id, async (tx) => (await systemCtxFor(env, tx, t.tenant_id))!).catch((e) =>
          console.error(JSON.stringify({ level: 'error', job: 'privacy-sweep', tenant: t.tenant_id, msg: (e as Error).message })),
        );
        // books: recurring invoices, bills, expenses and journals that are due
        await booksDailySweep(env, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'books-sweep', tenant: t.tenant_id, msg: (e as Error).message })));
        // IT: contract billing and renewals, subscription renewals and invoices
        await itDailySweep(env, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'it-sweep', tenant: t.tenant_id, msg: (e as Error).message })));
        // client IT: warranty and licence renewals coming up
        await assetRenewalSweep(env, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'asset-renewals', tenant: t.tenant_id, msg: (e as Error).message })));
        // email sequences: follow-ups that are due
        await sequenceSweep(env, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'sequences', tenant: t.tenant_id, msg: (e as Error).message })));
        // work items due tomorrow or overdue go into each assignee's morning digest
        await queueDueSoon(db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'work-due', tenant: t.tenant_id, msg: (e as Error).message })));
      }
      // workspaces with automatic backups enabled get one a day (kept: newest 7)
      await dailyBackups(env, db).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'daily-backups', msg: (e as Error).message })));
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env, Job>;
