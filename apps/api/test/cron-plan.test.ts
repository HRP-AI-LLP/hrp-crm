import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { cronPlan, DB_AWAKE_KEY, istHour, markDbAwake, POLL_KEY, resetAwakeMark } from '../src/services/cron-plan';

function kv(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => void m.set(k, v),
    delete: async (k: string) => void m.delete(k),
  };
}
const envWith = (store: ReturnType<typeof kv>) => ({ CACHE_KV: store }) as unknown as Env;
// gates that say "nothing due" for the modules that keep one
const quiet = (at: Date) => ({ 'p:reminders:next': new Date(at.getTime() + 3600_000).toISOString(), 'digests:next': new Date(at.getTime() + 3600_000).toISOString(), 'intel:next': new Date(at.getTime() + 3600_000).toISOString(), 'campaigns:active': '0' });

describe('cron plan (keeps Neon asleep)', () => {
  it('an idle tick between polls does not wake the database', async () => {
    const at = new Date('2026-11-22T06:10:00Z'); // 11:40 IST, not a poll minute
    const p = await cronPlan(envWith(kv(quiet(at))), at);
    expect(p.wake).toBe(false);
  });

  it('polls every 30 minutes by day and every 2 hours at night', async () => {
    const day = new Date('2026-11-22T06:30:00Z'); // 12:00 IST
    expect((await cronPlan(envWith(kv(quiet(day))), day)).poll).toBe(true);
    const night1 = new Date('2026-11-22T19:00:00Z'); // 00:30 IST, minute-of-day 1140 → not a 2-hour mark
    expect((await cronPlan(envWith(kv(quiet(night1))), night1)).wake).toBe(false);
    const night2 = new Date('2026-11-22T20:00:00Z'); // 01:30 IST, minute-of-day 1200 → 2-hour mark
    expect((await cronPlan(envWith(kv(quiet(night2))), night2)).poll).toBe(true);
    expect(istHour(new Date('2026-11-22T01:30:00Z'))).toBe(7);
  });

  it('follows CRON_POLL_MINUTES from KV', async () => {
    const at = new Date('2026-11-22T06:15:00Z');
    expect((await cronPlan(envWith(kv(quiet(at))), at)).poll).toBe(false);
    expect((await cronPlan(envWith(kv({ ...quiet(at), [POLL_KEY]: '15' })), at)).poll).toBe(true);
  });

  it('runs everything every 5 minutes while people use the app', async () => {
    const at = new Date('2026-11-22T06:10:00Z');
    const p = await cronPlan(envWith(kv({ ...quiet(at), [DB_AWAKE_KEY]: String(at.getTime() - 60_000) })), at);
    expect(p.awake && p.poll && p.wake).toBe(true);
  });

  it('wakes for a due reminder, a running campaign or a queued work alert', async () => {
    const at = new Date('2026-11-22T06:10:00Z');
    expect((await cronPlan(envWith(kv({ ...quiet(at), 'p:reminders:next': new Date(at.getTime() - 1000).toISOString() })), at)).reminders).toBe(true);
    expect((await cronPlan(envWith(kv({ ...quiet(at), 'campaigns:active': '1' })), at)).wake).toBe(true);
    expect((await cronPlan(envWith(kv({ ...quiet(at), 'pmmail:any': '1' })), at)).workMail).toBe(true);
  });

  it('marks the database awake at most once every 3 minutes', async () => {
    resetAwakeMark();
    const store = kv();
    markDbAwake(envWith(store), undefined, 1_000_000);
    await Promise.resolve();
    expect(store.m.get(DB_AWAKE_KEY)).toBe('1000000');
    markDbAwake(envWith(store), undefined, 1_060_000);
    await Promise.resolve();
    expect(store.m.get(DB_AWAKE_KEY)).toBe('1000000');
    markDbAwake(envWith(store), undefined, 1_200_000);
    await Promise.resolve();
    expect(store.m.get(DB_AWAKE_KEY)).toBe('1200000');
  });
});
