/**
 * Per-API-key rate limit: a fixed one-minute window counted in this isolate, plus the optional
 * Workers rate-limiting binding (API_RATE_LIMITER) as a shared ceiling across isolates. The
 * in-isolate count is approximate when traffic spreads over many isolates; it still stops a
 * runaway script, which is what it is for.
 */
const windows = new Map<string, { start: number; count: number }>();

export interface RateResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export function takeToken(key: string, limit: number, now = Date.now()): RateResult {
  const w = windows.get(key);
  const start = Math.floor(now / 60_000) * 60_000;
  if (!w || w.start !== start) {
    windows.set(key, { start, count: 1 });
    if (windows.size > 5000) for (const [k, v] of windows) if (v.start !== start) windows.delete(k);
    return { ok: true, limit, remaining: limit - 1, resetSeconds: Math.ceil((start + 60_000 - now) / 1000) };
  }
  w.count++;
  return { ok: w.count <= limit, limit, remaining: Math.max(0, limit - w.count), resetSeconds: Math.ceil((start + 60_000 - now) / 1000) };
}
