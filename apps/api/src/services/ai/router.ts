/**
 * Serverless LLM router with ordered fallback and PII-aware routing.
 *
 * Order of attempts for a request:
 *   1. the tenant's own providers (bring-your-own keys, configured by the tenant admin),
 *      in the admin's priority order
 *   2. platform providers, unless the tenant switched platform fallback off:
 *      Workers AI (binding) → Groq → Gemini
 *
 * PII rule: a request flagged `containsPii` only goes to
 *   - tenant providers the admin marked "allow personal data" (their contract, their decision)
 *   - platform providers listed in AI_PII_PROVIDERS (default "workers-ai,groq"). Gemini's free tier
 *     may use prompts to improve Google products, so by default it only sees PII-free prompts.
 * Each attempt has a timeout; 429/5xx/timeouts/invalid JSON fall through to the next provider.
 */
import type { Env } from '../../env';

export type AiTask = 'lead_score' | 'sentiment' | 'summary' | 'email_draft' | 'next_best_action' | 'rag_answer' | 'provider_test';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  task: AiTask;
  messages: ChatMessage[];
  containsPii: boolean;
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ChatResult {
  text: string;
  provider: string;
  model: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

type CallResult = Omit<ChatResult, 'provider' | 'model' | 'latencyMs'>;

export interface Provider {
  /** "workers-ai" | "groq" | "gemini" for platform providers, "tenant:<id>" for tenant keys */
  name: string;
  kind: string;
  model: string;
  available: boolean;
  allowPii: boolean;
  tenantOwned: boolean;
  call(req: ChatRequest, signal: AbortSignal): Promise<CallResult>;
}

export type TenantProviderKind = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'openai_compatible';

/** Decrypted tenant provider configuration (never leaves the Worker). */
export interface TenantProviderConfig {
  id: string;
  provider: TenantProviderKind;
  model: string;
  baseUrl: string | null;
  apiKey: string;
  allowPii: boolean;
}

export const TENANT_PROVIDER_DEFAULTS: Record<TenantProviderKind, { model: string; baseUrl?: string; label: string }> = {
  openai: { model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', label: 'OpenAI' },
  anthropic: { model: 'claude-haiku-5-5', label: 'Anthropic' },
  gemini: { model: 'gemini-2.5-flash', label: 'Google Gemini' },
  groq: { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1', label: 'Groq' },
  openrouter: { model: 'openrouter/auto', baseUrl: 'https://openrouter.ai/api/v1', label: 'OpenRouter' },
  openai_compatible: { model: '', label: 'OpenAI-compatible endpoint' },
};

export class AiUnavailableError extends Error {
  constructor(public attempts: { provider: string; error: string }[]) {
    super(`All AI providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ') || 'none configured'}`);
  }
}

const TIMEOUT_MS = 20_000;

// ------------------------------------------------------------------------------- adapters
async function httpError(res: Response): Promise<Error> {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    detail = (typeof j.error === 'object' ? j.error?.message : j.error) ?? j.message ?? raw;
  } catch {
    /* not JSON */
  }
  const hint = res.status === 401 || res.status === 403 ? 'the API key was rejected' : res.status === 404 ? 'model or endpoint not found' : res.status === 429 ? 'rate limit or quota exceeded' : null;
  // provider messages can echo the key; mask anything key-shaped
  const safe = String(detail).slice(0, 160).replace(/(sk|key|Bearer|AIza)[-_A-Za-z0-9]{8,}/g, '***');
  return new Error(`HTTP ${res.status}${hint ? ` (${hint})` : ''}${safe ? `: ${safe}` : ''}`);
}

function openAiCompatible(baseUrl: string, apiKey: string, model: string, extraHeaders: Record<string, string> = {}) {
  return async (req: ChatRequest, signal: AbortSignal): Promise<CallResult> => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({
        model,
        messages: req.messages,
        max_tokens: req.maxTokens ?? 700,
        temperature: req.temperature ?? 0.2,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    if (!res.ok) throw await httpError(res);
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return { text: j.choices?.[0]?.message?.content ?? '', inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens };
  };
}

function anthropic(apiKey: string, model: string) {
  return async (req: ChatRequest, signal: AbortSignal): Promise<CallResult> => {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 700,
        temperature: req.temperature ?? 0.2,
        ...(system ? { system: req.json ? `${system}\nRespond with a single JSON object only.` : system } : {}),
        messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) throw await httpError(res);
    const j = (await res.json()) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = (j.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return { text, inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens };
  };
}

function gemini(apiKey: string, model: string) {
  return async (req: ChatRequest, signal: AbortSignal): Promise<CallResult> => {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      signal,
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents,
        generationConfig: { maxOutputTokens: req.maxTokens ?? 700, temperature: req.temperature ?? 0.2, ...(req.json ? { responseMimeType: 'application/json' } : {}) },
      }),
    });
    if (!res.ok) throw await httpError(res);
    const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    return { text: j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '', inputTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount };
  };
}

// ------------------------------------------------------------------------------- provider lists
export function piiAllowed(env: Env): Set<string> {
  return new Set((env.AI_PII_PROVIDERS ?? 'workers-ai,groq').split(',').map((s) => s.trim()).filter(Boolean));
}

export function platformProviders(env: Env): Provider[] {
  const allow = piiAllowed(env);
  const workersModel = env.AI_MODEL_WORKERS ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const groqModel = env.AI_MODEL_GROQ ?? 'llama-3.3-70b-versatile';
  const geminiModel = env.AI_MODEL_GEMINI ?? 'gemini-2.5-flash';
  return [
    {
      name: 'workers-ai',
      kind: 'workers-ai',
      model: workersModel,
      available: !!env.AI,
      allowPii: allow.has('workers-ai'),
      tenantOwned: false,
      async call(req) {
        const out = (await env.AI!.run(workersModel as keyof AiModels, {
          messages: req.messages,
          max_tokens: req.maxTokens ?? 700,
          temperature: req.temperature ?? 0.2,
          ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        } as never)) as { response?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const text = typeof out.response === 'string' ? out.response : JSON.stringify(out.response ?? '');
        return { text, inputTokens: out.usage?.prompt_tokens, outputTokens: out.usage?.completion_tokens };
      },
    },
    {
      name: 'groq',
      kind: 'groq',
      model: groqModel,
      available: !!env.GROQ_API_KEY,
      allowPii: allow.has('groq'),
      tenantOwned: false,
      call: (req, signal) => openAiCompatible('https://api.groq.com/openai/v1', env.GROQ_API_KEY!, groqModel)(req, signal),
    },
    {
      name: 'gemini',
      kind: 'gemini',
      model: geminiModel,
      available: !!env.GEMINI_API_KEY,
      allowPii: allow.has('gemini'),
      tenantOwned: false,
      call: (req, signal) => gemini(env.GEMINI_API_KEY!, geminiModel)(req, signal),
    },
  ];
}

export function tenantProvider(cfg: TenantProviderConfig): Provider {
  const d = TENANT_PROVIDER_DEFAULTS[cfg.provider];
  let call: Provider['call'];
  switch (cfg.provider) {
    case 'anthropic':
      call = anthropic(cfg.apiKey, cfg.model);
      break;
    case 'gemini':
      call = gemini(cfg.apiKey, cfg.model);
      break;
    case 'openrouter':
      call = openAiCompatible(d.baseUrl!, cfg.apiKey, cfg.model, { 'x-title': 'HRP Synapse' });
      break;
    default:
      call = openAiCompatible(cfg.baseUrl ?? d.baseUrl ?? '', cfg.apiKey, cfg.model);
  }
  return { name: `tenant:${cfg.id}`, kind: cfg.provider, model: cfg.model, available: true, allowPii: cfg.allowPii, tenantOwned: true, call };
}

export function availableProviders(env: Env, containsPii: boolean): string[] {
  return platformProviders(env)
    .filter((p) => p.available && (!containsPii || p.allowPii))
    .map((p) => p.name);
}

export interface AttemptLog {
  provider: string;
  kind: string;
  model: string;
  ok: boolean;
  tenantOwned: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
}

/** Tries each eligible provider in order until one returns a usable answer. */
export async function chatWith(providerList: Provider[], req: ChatRequest, onAttempt?: (a: AttemptLog) => void): Promise<ChatResult> {
  const attempts: { provider: string; error: string }[] = [];
  for (const p of providerList) {
    if (!p.available) continue;
    if (req.containsPii && !p.allowPii) continue;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await Promise.race([p.call(req, ctrl.signal), new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('timeout'))))]);
      if (!r.text.trim()) throw new Error('empty response');
      if (req.json) extractJson(r.text); // throws → fall through to next provider
      const result: ChatResult = { ...r, provider: p.tenantOwned ? `${p.kind} (your key)` : p.name, model: p.model, latencyMs: Date.now() - started };
      onAttempt?.({ provider: p.name, kind: p.kind, model: p.model, ok: true, tenantOwned: p.tenantOwned, latencyMs: result.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      return result;
    } catch (e) {
      const msg = (e as Error).message;
      attempts.push({ provider: p.tenantOwned ? `${p.kind} (your key)` : p.name, error: msg });
      onAttempt?.({ provider: p.name, kind: p.kind, model: p.model, ok: false, tenantOwned: p.tenantOwned, latencyMs: Date.now() - started, error: msg });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AiUnavailableError(attempts);
}

/** Platform-only routing (kept for callers without tenant context). */
export function chat(env: Env, req: ChatRequest, onAttempt?: (a: AttemptLog) => void): Promise<ChatResult> {
  return chatWith(platformProviders(env), req, onAttempt);
}

/** Tolerant JSON extraction (models sometimes wrap JSON in prose or code fences). */
export function extractJson<T = unknown>(text: string): T {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(t) as T;
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1)) as T;
    throw new Error('response was not JSON');
  }
}

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  if (!env.AI) throw new AiUnavailableError([{ provider: 'workers-ai', error: 'AI binding not configured' }]);
  const model = env.AI_EMBEDDING_MODEL ?? '@cf/baai/bge-m3';
  const out = (await env.AI.run(model as keyof AiModels, { text: texts } as never)) as unknown as { data: number[][] };
  return out.data;
}
