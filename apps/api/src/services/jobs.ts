/**
 * Background jobs. With a Queue bound (JOBS) work is durable and retried; without one (or to save
 * the free plan's 10k queue ops/day) jobs run in ctx.waitUntil after the response.
 * Every job carries tenantId and re-establishes tenant context itself; nothing is inherited.
 */
import type { Env } from '../env';
import type { RecordEvent } from './records';

export type Job =
  | { type: 'record.event'; tenantId: string; userId: string | null; event: RecordEvent; depth?: number }
  | { type: 'ai.score_lead'; tenantId: string; leadId: string }
  | { type: 'kb.index'; tenantId: string; documentId: string }
  | { type: 'message.send'; tenantId: string; messageId: string }
  | { type: 'message.inbound'; tenantId: string; channelAccountId: string; payload: unknown }
  | { type: 'webhook.deliver'; tenantId: string; subscriptionId: string; event: string; payload: unknown; redeliveryOf?: string; deliveryId?: string; attempt?: number }
  /** re-evaluate formula / roll-up fields of every record of an object, 200 at a time */
  | { type: 'meta.recompute'; tenantId: string; objectKey: string; after?: string }
  /** one page of one table of a workspace backup (see services/backup.ts) */
  | { type: 'backup.step'; tenantId: string; stamp: string; table: number; after?: string | null }
  | { type: 'intel.sweep'; tenantId: string; part: 'detect' | 'prep' | 'index' }
  /** integrations (services/integrations.ts and friends) */
  | { type: 'mail.sync'; tenantId: string; integrationId: string }
  | { type: 'calendar.push'; tenantId: string; eventId: string; ownerId: string | null; removeRef?: { integrationId: string; id: string } | null }
  | { type: 'leadads.meta'; tenantId: string; integrationId: string; leadgenId: string }
  | { type: 'leadads.google'; tenantId: string; integrationId: string; body: unknown }
  | { type: 'payment.razorpay'; tenantId: string; integrationId: string; event: unknown }
  | { type: 'telephony.incoming'; tenantId: string; integrationId: string; params: Record<string, string> }
  | { type: 'sdlc.advance'; tenantId: string; runId: string }
  /** client documents on a project, read and summarised (services/project-docs.ts) */
  | { type: 'projectdoc.read'; tenantId: string; projectId: string; userId: string | null };

export interface Waiter {
  waitUntil(p: Promise<unknown>): void;
}

export async function enqueue(env: Env, waiter: Waiter | null, jobs: Job[]): Promise<void> {
  if (!jobs.length) return;
  if (env.JOBS) {
    await env.JOBS.sendBatch(jobs.map((body) => ({ body })));
    return;
  }
  // No queue bound (local dev, tests): run inline. Jobs queued from inside a running job are
  // appended to the current drain instead of nesting, so a long chain (a backup is one job per
  // table page) never holds one database connection per step.
  if (draining) {
    pending.push(...jobs.map((j) => ({ env, job: j, waiter })));
    return;
  }
  const { processJob } = await import('./worker');
  pending.push(...jobs.map((j) => ({ env, job: j, waiter })));
  const run = (async () => {
    draining = true;
    try {
      while (pending.length) {
        const p = pending.shift()!;
        await processJob(p.env, p.job, p.waiter).catch((e) => console.error(JSON.stringify({ level: 'error', job: p.job.type, msg: (e as Error).message })));
      }
    } finally {
      draining = false;
    }
  })();
  if (waiter) waiter.waitUntil(run);
  else await run;
}

let draining = false;
const pending: { env: Env; job: Job; waiter: Waiter | null }[] = [];

export function eventJobs(tenantId: string, userId: string | null, events: RecordEvent[]): Job[] {
  return events.map((event) => ({ type: 'record.event', tenantId, userId, event }));
}
