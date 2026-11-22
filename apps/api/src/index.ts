/**
 * SanchalanOS edge gateway (Cloudflare Worker).
 *   fetch     → Hono app: tenant resolution, auth, API, SPA assets
 *   queue     → background jobs (workflows, AI scoring, KB indexing, messaging, webhooks)
 *   scheduled → a 5-minute tick that wakes the database only when something is due (cron-plan.ts),
 *               daily housekeeping
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
import { withPlatformKeys, withTenantKeys } from './services/connection-keys';
import { cronPlan } from './services/cron-plan';
import { chatSweep } from './services/project-chats';
import { autoTimeSweep } from './services/autotime';

const app = createApp();

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch<Job>, rawEnv: Env, ctx: ExecutionContext): Promise<void> {
    // keys saved in Settings → Connection keys (platform, then the job's workspace)
    // (Db connects lazily: no query, no connection)
    const keysDb = Db.fromEnv(rawEnv);
    const platformEnv = await withPlatformKeys(rawEnv, keysDb);
    for (const msg of batch.messages) {
      try {
        const env = msg.body.tenantId ? await withTenantKeys(platformEnv, keysDb, msg.body.tenantId) : platformEnv;
        await processJob(env, msg.body, ctx);
        msg.ack();
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', job: msg.body.type, tenant: msg.body.tenantId, attempt: msg.attempts, msg: (e as Error).message }));
        msg.retry({ delaySeconds: Math.min(300, 10 * 2 ** msg.attempts) });
      }
    }
    await keysDb.close();
  },

  async scheduled(controller: ScheduledController, rawEnv: Env): Promise<void> {
    // the 5-minute tick decides from KV alone; most ticks end here without touching the database
    const plan = controller.cron === '*/5 * * * *' ? await cronPlan(rawEnv, new Date(controller.scheduledTime)) : null;
    if (plan && !plan.wake) return;
    // Platform housekeeping runs per tenant under RLS (no bypass role exists).
    const db = Db.fromEnv(rawEnv);
    // keys saved in Settings → Connection keys take the place of the .env values
    const env = await withPlatformKeys(rawEnv, db);
    const log = (job: string) => (e: unknown) => console.error(JSON.stringify({ level: 'error', job, msg: (e as Error).message }));
    try {
      if (plan) {
        // reminders: each sweep also stores when the next one is due
        if (plan.reminders) await reminderSweep(env, db).catch(log('reminders'));
        if (plan.poll) {
          // connected Gmail / Outlook mailboxes (each at most every ~15 minutes, 07:00–21:00 IST)
          await mailSweep(env, db).catch(log('mail-sweep'));
          // Zoom / Meet / Teams calls that ended: transcript fetched, then analysed into minutes and actions
          await meetingSweep(env, db, (t, e, o) => analyseAsOwner(env, db, t, e, o)).catch(log('meeting-sweep'));
          // mailboxes read for GeM alerts, bills and invoices
          await intakeSweep(env, db).catch(log('intake-sweep'));
          // followed GeM bids: details and bid documents read from GeM's public pages
          await gemDetailsSweep(env, db).catch(log('gem-details'));
          // statements that came by mail: opened with the saved passwords, imported, handed to the desk
          await statementSweep(env, db).catch(log('statement-mail'));
        }
        // campaigns send in batches while one is running
        if (plan.campaigns) await campaignSweep(env, db).catch(log('campaign-sweep'));
        if (plan.digests) await digestSweep(env, db).catch(log('digest-sweep'));
        // revenue intelligence: scores, insights, auto meeting prep, search index (at most hourly)
        if (plan.intel) await intelSweep(env, db).catch(log('intel-sweep'));
        // work items: scheduled automation rules (hourly), then watcher / assignee emails and chat posts
        if (plan.rules) await scheduledRulesSweep(env, db).catch(log('work-rules'));
        if (plan.workMail) await workMailSweep(env, db).catch(log('work-mail'));
        // WhatsApp chats on projects that went quiet: read by the AI into suggestions / work
        if (plan.chats) await chatSweep(env, db).catch(log('project-chats'));
        return;
      }
      await reminderSweep(env, db, true);
      const tenants = await db.platform<{ tenant_id: string }>(`select t as tenant_id from app.list_active_tenant_ids() t`);
      for (const t of tenants) {
        // the workspace's own keys (e.g. its own GSP account) for its jobs
        const tenv = await withTenantKeys(env, db, t.tenant_id);
        await db.tx({ tenantId: t.tenant_id }, async (tx) => {
          await tx.query(`delete from sessions where tenant_id = $1 and (expires_at < now() - interval '7 days' or revoked_at < now() - interval '7 days')`, [t.tenant_id]);
          await tx.query(`delete from ai_usage where tenant_id = $1 and created_at < now() - interval '90 days'`, [t.tenant_id]);
          await tx.query(`delete from webhook_deliveries where tenant_id = $1 and created_at < now() - interval '30 days'`, [t.tenant_id]);
        });
        // privacy: request deadlines and the workspace's own retention rules
        await privacyDailySweep(tenv, db, t.tenant_id, async (tx) => (await systemCtxFor(tenv, tx, t.tenant_id))!).catch((e) =>
          console.error(JSON.stringify({ level: 'error', job: 'privacy-sweep', tenant: t.tenant_id, msg: (e as Error).message })),
        );
        // books: recurring invoices, bills, expenses and journals that are due
        await booksDailySweep(tenv, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'books-sweep', tenant: t.tenant_id, msg: (e as Error).message })));
        // IT: contract billing and renewals, subscription renewals and invoices
        await itDailySweep(tenv, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'it-sweep', tenant: t.tenant_id, msg: (e as Error).message })));
        // client IT: warranty and licence renewals coming up
        await assetRenewalSweep(tenv, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'asset-renewals', tenant: t.tenant_id, msg: (e as Error).message })));
        // email sequences: follow-ups that are due
        await sequenceSweep(tenv, db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'sequences', tenant: t.tenant_id, msg: (e as Error).message })));
        // work items due tomorrow or overdue go into each assignee's morning digest
        await queueDueSoon(db, t.tenant_id).catch((e) => console.error(JSON.stringify({ level: 'error', job: 'work-due', tenant: t.tenant_id, msg: (e as Error).message })));
      }
      // automatic timesheets: yesterday's empty working days, from assignments and allocations
      await autoTimeSweep(env, db).catch(log('auto-time'));
      // automatic backups are off unless the platform turns them on (Settings → Connection keys → Options)
      if (env.AUTO_BACKUPS === 'true') await dailyBackups(env, db).catch(log('daily-backups'));
    } finally {
      await db.close();
    }
  },
} satisfies ExportedHandler<Env, Job>;
