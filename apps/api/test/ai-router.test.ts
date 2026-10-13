import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { AiUnavailableError, chatWith, platformProviders, tenantProvider } from '../src/services/ai/router';
import { assertSafeBaseUrl } from '../src/services/ai/tenant-providers';

const env = { APP_ENV: 'local', BASE_DOMAIN: 'x', JWT_SECRET: 'x', GROQ_API_KEY: 'platform-groq', GEMINI_API_KEY: 'platform-gemini' } as Env;
const msg = { task: 'summary' as const, messages: [{ role: 'user' as const, content: 'hi' }] };

function mockFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push(String(url));
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('AI router with tenant keys', () => {
  it("uses the tenant's own key before platform providers", async () => {
    const calls = mockFetch((url) => ({ body: url.includes('openai.com') ? { choices: [{ message: { content: 'from tenant' } }] } : { choices: [{ message: { content: 'from platform' } }] } }));
    const list = [tenantProvider({ id: 't1', provider: 'openai', model: 'gpt-x', baseUrl: null, apiKey: 'sk-tenant', allowPii: true }), ...platformProviders(env)];
    const r = await chatWith(list, { ...msg, containsPii: true });
    expect(r.text).toBe('from tenant');
    expect(r.provider).toBe('openai (your key)');
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('falls back to the platform when the tenant provider fails', async () => {
    mockFetch((url) => (url.includes('anthropic') ? { status: 401, body: { error: 'bad key sk-ant-1234567890abc' } } : { body: { choices: [{ message: { content: 'platform ok' } }] } }));
    const attempts: { ok: boolean; error?: string }[] = [];
    const list = [tenantProvider({ id: 't1', provider: 'anthropic', model: 'claude', baseUrl: null, apiKey: 'sk-ant', allowPii: true }), ...platformProviders(env)];
    const r = await chatWith(list, { ...msg, containsPii: true }, (a) => attempts.push(a));
    expect(r.text).toBe('platform ok');
    expect(attempts[0]!.ok).toBe(false);
    expect(attempts[0]!.error).not.toContain('1234567890');
  });

  it('never sends personal data to a tenant provider not cleared for it', async () => {
    const calls = mockFetch(() => ({ body: { choices: [{ message: { content: 'ok' } }] } }));
    const list = [tenantProvider({ id: 't1', provider: 'openrouter', model: 'm', baseUrl: null, apiKey: 'k-12345678', allowPii: false })];
    await expect(chatWith(list, { ...msg, containsPii: true })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(calls).toEqual([]);
    await chatWith(list, { ...msg, containsPii: false });
    expect(calls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
  });

  it('platform Gemini is excluded from PII prompts by default', async () => {
    const calls = mockFetch(() => ({ status: 500, body: {} }));
    await expect(chatWith(platformProviders(env), { ...msg, containsPii: true })).rejects.toBeInstanceOf(AiUnavailableError);
    expect(calls.some((u) => u.includes('googleapis'))).toBe(false);
  });

  it('anthropic adapter sends system prompt separately', async () => {
    let body: Record<string, unknown> = {};
    mockFetch((_u, init) => {
      body = JSON.parse(String(init.body));
      return { body: { content: [{ type: 'text', text: '{"a":1}' }] } };
    });
    const p = tenantProvider({ id: 't', provider: 'anthropic', model: 'claude-haiku-5-5', baseUrl: null, apiKey: 'k-12345678', allowPii: true });
    const r = await chatWith([p], { task: 'summary', containsPii: false, json: true, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }] });
    expect(r.text).toBe('{"a":1}');
    expect(String(body.system)).toContain('sys');
    expect(body.messages).toEqual([{ role: 'user', content: 'u' }]);
  });
});

describe('custom endpoint validation', () => {
  it('accepts public https endpoints and rejects internal targets', () => {
    expect(assertSafeBaseUrl('https://api.together.xyz/v1/')).toBe('https://api.together.xyz/v1');
    for (const bad of ['http://api.example.com', 'https://127.0.0.1/v1', 'https://localhost/v1', 'https://[::1]/v1', 'https://user:pw@api.example.com', 'https://intranet/v1', 'https://svc.internal/v1']) {
      expect(() => assertSafeBaseUrl(bad), bad).toThrow();
    }
  });
});
