/**
 * Three-tier edge cache, always namespaced by tenant:
 *   L1  isolate memory (free, microseconds, per isolate)
 *   L2  Cache API      (free, per colo; no-op on *.workers.dev)
 *   L3  Workers KV     (global, but the free plan allows ~1k writes/day → used only for
 *                       low-churn data: hostname→tenant and versioned metadata bundles)
 * Keys must start with "t:{tenantId}:" for tenant data or "p:" for platform data.
 */
import type { Env } from '../env';

interface L1Entry {
  value: unknown;
  expires: number;
}

const L1 = new Map<string, L1Entry>();
const L1_MAX = 2_000;

export interface CacheOptions {
  ttlSeconds: number;
  /** also persist in KV (use only for low-write keys) */
  kv?: boolean;
}

const CACHE_ORIGIN = 'https://cache.synapse.internal/';

function assertKey(key: string) {
  if (!/^(t:[0-9a-f-]{36}:|p:)/.test(key)) throw new Error(`cache key must be tenant or platform namespaced: ${key}`);
}

export class EdgeCache {
  constructor(private env: Env) {}

  private cacheApi(): Cache | null {
    try {
      return typeof caches !== 'undefined' ? (caches as unknown as { default: Cache }).default : null;
    } catch {
      return null;
    }
  }

  async get<T>(key: string, opts: { kv?: boolean } = {}): Promise<T | null> {
    assertKey(key);
    const now = Date.now();
    const l1 = L1.get(key);
    if (l1 && l1.expires > now) return l1.value as T;
    if (l1) L1.delete(key);

    const cache = this.cacheApi();
    if (cache) {
      const hit = await cache.match(CACHE_ORIGIN + encodeURIComponent(key)).catch(() => undefined);
      if (hit) {
        const v = (await hit.json()) as T;
        this.setL1(key, v, 30);
        return v;
      }
    }
    if (opts.kv && this.env.CACHE_KV) {
      const v = await this.env.CACHE_KV.get<T>(key, 'json').catch(() => null);
      if (v !== null) {
        this.setL1(key, v, 30);
        return v;
      }
    }
    return null;
  }

  async set(key: string, value: unknown, opts: CacheOptions): Promise<void> {
    assertKey(key);
    this.setL1(key, value, Math.min(opts.ttlSeconds, 60));
    const cache = this.cacheApi();
    const body = JSON.stringify(value);
    const tasks: Promise<unknown>[] = [];
    if (cache) {
      tasks.push(
        cache
          .put(CACHE_ORIGIN + encodeURIComponent(key), new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${opts.ttlSeconds}` } }))
          .catch(() => undefined),
      );
    }
    if (opts.kv && this.env.CACHE_KV) {
      tasks.push(this.env.CACHE_KV.put(key, body, { expirationTtl: Math.max(60, opts.ttlSeconds) }).catch(() => undefined));
    }
    await Promise.all(tasks);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    L1.delete(key);
    const cache = this.cacheApi();
    await Promise.all([
      cache?.delete(CACHE_ORIGIN + encodeURIComponent(key)).catch(() => undefined),
      this.env.CACHE_KV?.delete(key).catch(() => undefined),
    ]);
  }

  async getOrLoad<T>(key: string, opts: CacheOptions, load: () => Promise<T>): Promise<T> {
    const hit = await this.get<T>(key, { kv: opts.kv ?? false });
    if (hit !== null) return hit;
    const v = await load();
    if (v !== null && v !== undefined) await this.set(key, v, opts);
    return v;
  }

  private setL1(key: string, value: unknown, ttl: number) {
    if (L1.size >= L1_MAX) {
      const first = L1.keys().next().value;
      if (first) L1.delete(first);
    }
    L1.set(key, { value, expires: Date.now() + ttl * 1000 });
  }
}

/** Test helper */
export function clearL1() {
  L1.clear();
}
