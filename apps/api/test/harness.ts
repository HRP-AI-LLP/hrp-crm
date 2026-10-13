/** Shared test harness: real app + real Postgres per test file. */
import { expect } from 'vitest';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { clearL1 } from '../src/lib/cache';
import { createTestDatabase } from '../../../packages/db/test/helpers';

export type Json = Record<string, any>;
export const PW = 'Str0ng-Passw0rd!';

export async function makeHarness(dbName: string) {
  const { appUrl } = await createTestDatabase(dbName);
  const env: Env = {
    APP_ENV: 'local',
    BASE_DOMAIN: 'synapse.test',
    ALLOW_TENANT_HEADER: 'true',
    SIGNUP_ENABLED: 'true',
    JWT_SECRET: 'test-secret-test-secret-test-secret-1234567890',
    DATA_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
    DATABASE_URL: appUrl,
  };
  clearL1();
  const app = createApp();

  async function call(method: string, path: string, opts: { tenant?: string; token?: string; body?: unknown; cookie?: string; headers?: Record<string, string>; raw?: boolean } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (opts.tenant) headers['x-tenant'] = opts.tenant;
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.cookie) headers.cookie = opts.cookie;
    const res = await app.request(`http://synapse.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }, env);
    const text = await res.text();
    let json: Json = {};
    if (!opts.raw) {
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { text };
      }
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  async function signup(slug: string, email: string) {
    const r = await call('POST', '/api/public/signup', { body: { workspaceName: `${slug} co`, slug, fullName: `${slug} Owner`, email, password: PW } });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  }

  async function login(tenant: string, email: string, password = PW) {
    const r = await call('POST', '/api/auth/login', { tenant, body: { email, password } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return { token: r.json.accessToken as string, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  }

  /** authenticated caller bound to one workspace */
  function as(tenant: string, token: string) {
    return (method: string, path: string, body?: unknown, extra: { headers?: Record<string, string>; raw?: boolean } = {}) => call(method, path, { tenant, token, body, ...extra });
  }

  return { env, app, call, signup, login, as };
}

/** In-memory stand-in for an R2 bucket (put / get / delete / list as the API uses them). */
export function fakeR2() {
  const store = new Map<string, Uint8Array>();
  const bytes = (v: unknown) => (typeof v === 'string' ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v as Uint8Array));
  return {
    store,
    async put(key: string, value: unknown) {
      store.set(key, bytes(value));
      return { key };
    },
    async get(key: string) {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: new Blob([v]).stream(),
        arrayBuffer: async () => v.slice().buffer,
        text: async () => new TextDecoder().decode(v),
        json: async () => JSON.parse(new TextDecoder().decode(v)),
      };
    },
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
    async list(o: { prefix?: string; delimiter?: string; cursor?: string } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(o.prefix ?? '')).sort();
      if (o.delimiter) {
        const prefixes = new Set<string>();
        const objects: { key: string }[] = [];
        for (const k of keys) {
          const rest = k.slice((o.prefix ?? '').length);
          const i = rest.indexOf(o.delimiter);
          if (i >= 0) prefixes.add((o.prefix ?? '') + rest.slice(0, i + 1));
          else objects.push({ key: k });
        }
        return { objects, delimitedPrefixes: [...prefixes], truncated: false };
      }
      return { objects: keys.map((key) => ({ key })), delimitedPrefixes: [], truncated: false };
    },
  };
}
