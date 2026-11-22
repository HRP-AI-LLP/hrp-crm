/**
 * Keeps the Neon database asleep when nobody needs it.
 *
 * Neon bills compute for every minute the database is awake and puts it to sleep after 5 idle
 * minutes. A 5-minute cron that queries it every time would keep it awake all month (≈180
 * CU-hours at 0.25 CU — more than the free plan's 100). So the 5-minute tick first reads a few KV
 * values (free, no database) and wakes the database only when:
 *   - people are using the app right now (the database is awake anyway, so syncing costs nothing),
 *   - a reminder, digest, campaign batch or work alert is due (each module keeps its own KV mark),
 *   - or it is time for the periodic poll of mailboxes, meetings, GeM bids and statements:
 *     every CRON_POLL_MINUTES (default 30) between 07:00 and 21:00 IST, every 2 hours at night.
 */
import type { Env } from '../env';

/** KV key: when an API request last ran (the database is awake for 5 minutes after it). */
export const DB_AWAKE_KEY = 'db:awake';
/** KV mirror of the platform option CRON_POLL_MINUTES (the cron reads it without the database). */
export const POLL_KEY = 'opt:cron-poll-minutes';
const AWAKE_MS = 4.5 * 60_000;
const MARK_EVERY_MS = 3 * 60_000;
let lastMark = 0;

/** Called after API requests: remembers that the database is awake (at most one KV write per isolate every 3 minutes). */
export function markDbAwake(env: Env, waitUntil?: (p: Promise<unknown>) => void, now = Date.now()) {
  if (!env.CACHE_KV || now - lastMark < MARK_EVERY_MS) return;
  lastMark = now;
  const p = env.CACHE_KV.put(DB_AWAKE_KEY, String(now), { expirationTtl: 600 }).catch(() => undefined);
  if (waitUntil) waitUntil(p);
}

/** For tests: forget the per-isolate throttle. */
export function resetAwakeMark() {
  lastMark = 0;
}

export type CronPlan = {
  /** something needs the database at all */
  wake: boolean;
  awake: boolean;
  /** mailboxes, meetings, intake, GeM, statements */
  poll: boolean;
  reminders: boolean;
  digests: boolean;
  intel: boolean;
  campaigns: boolean;
  workMail: boolean;
  /** scheduled automation rules (hourly, with a poll) */
  rules: boolean;
  /** WhatsApp chats on projects with new messages to read */
  chats: boolean;
};

const due = (v: string | null, now: number) => !v || !(Date.parse(v) > now);

/** IST hour (UTC+05:30) of a moment. */
export const istHour = (d: Date) => Math.floor(((d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440) / 60);

/** Decides what the 5-minute tick does, reading only KV. Without KV (tests, local) everything runs. */
export async function cronPlan(env: Env, nowDate = new Date()): Promise<CronPlan> {
  const now = nowDate.getTime();
  const kv = env.CACHE_KV;
  if (!kv) return { wake: true, awake: true, poll: true, reminders: true, digests: true, intel: true, campaigns: true, workMail: true, rules: nowDate.getUTCMinutes() < 5, chats: true };
  const get = (k: string) => kv.get(k).catch(() => null);
  const [awakeAt, pollOpt, reminders, digests, intel, campaigns, workMail, chats] = await Promise.all([
    get(DB_AWAKE_KEY),
    get(POLL_KEY),
    get('p:reminders:next'),
    get('digests:next'),
    get('intel:next'),
    get('campaigns:active'),
    get('pmmail:any'),
    get('chats:pending'),
  ]);
  const awake = !!awakeAt && now - Number(awakeAt) < AWAKE_MS;
  const day = istHour(nowDate) >= 7 && istHour(nowDate) < 21;
  const every = Math.min(240, Math.max(5, Number(pollOpt) || 30));
  const minuteOfDay = nowDate.getUTCHours() * 60 + nowDate.getUTCMinutes();
  const pollTick = minuteOfDay % (day ? every : Math.max(every, 120)) < 5;
  const poll = awake || pollTick;
  const plan: CronPlan = {
    wake: false,
    awake,
    poll,
    reminders: due(reminders, now),
    digests: due(digests, now),
    intel: poll && due(intel, now),
    campaigns: campaigns === '1',
    // assignee / watcher alerts are flagged when work changes; the hourly catch-up rides on a poll
    workMail: workMail !== null || (poll && nowDate.getUTCMinutes() < 5),
    rules: poll && nowDate.getUTCMinutes() < 5,
    // a followed chat got messages: checked each tick until it has gone quiet and been read
    chats: chats !== null,
  };
  plan.wake = plan.poll || plan.reminders || plan.digests || plan.intel || plan.campaigns || plan.workMail || plan.rules || plan.chats;
  return plan;
}
