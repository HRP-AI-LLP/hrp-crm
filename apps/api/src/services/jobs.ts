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
  | { type: 'webhook.deliver'; tenantId: string; subscriptionId: string; event: string; payload: unknown };

export interface Waiter {
  waitUntil(p: Promise<unknown>): void;
}

export async function enqueue(env: Env, waiter: Waiter | null, jobs: Job[]): Promise<void> {
  if (!jobs.length) return;
  if (env.JOBS) {
    await env.JOBS.sendBatch(jobs.map((body) => ({ body })));
    return;
  }
  const { processJob } = await import('./worker');
  const run = (async () => {
    for (const j of jobs) {
      await processJob(env, j, waiter).catch((e) => console.error(JSON.stringify({ level: 'error', job: j.type, msg: (e as Error).message })));
    }
  })();
  if (waiter) waiter.waitUntil(run);
  else await run;
}

export function eventJobs(tenantId: string, userId: string | null, events: RecordEvent[]): Job[] {
  return events.map((event) => ({ type: 'record.event', tenantId, userId, event }));
}
