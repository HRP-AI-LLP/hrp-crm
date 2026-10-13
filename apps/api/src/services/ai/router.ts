/**
 * Serverless LLM router with ordered fallback and PII-aware routing.
 *
 *   Workers AI (binding, free daily allowance)  → Groq (free tier) → Gemini (free tier)
 *
 * PII rule: a request flagged `containsPii` is only sent to providers listed in AI_PII_PROVIDERS
 * (default "workers-ai,groq"). Gemini's free tier may use prompts to improve Google products, so it
 * only receives PII-free prompts unless you add it to the list after moving to a paid plan.
 * Each attempt has a timeout; 429/5xx/timeouts/invalid JSON fall through to the next provider.
 */
import type { Env } from '../../env';

export type AiTask = 'lead_score' | 'sentiment' | 'summary' | 'email_draft' | 'next_best_action' | 'rag_answer';

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

interface Provider {
  name: string;
  model: string;
  available: boolean;
  call(req: ChatRequest, signal: AbortSignal): Promise<Omit<ChatResult, 'provider' | 'model' | 'latencyMs'>>;
}

export class AiUnavailableError extends Error {
  constructor(public attempts: { provider: string; error: string }[]) {
    super(`All AI providers failed: ${attempts.map((a) => `${a.provider}: ${a.error}`).join('; ') || 'none configured'}`);
  }
}

const TIMEOUT_MS = 20_000;

function providers(env: Env): Provider[] {
  const workersModel = env.AI_MODEL_WORKERS ?? '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  const groqModel = env.AI_MODEL_GROQ ?? 'llama-3.3-70b-versatile';
  const geminiModel = env.AI_MODEL_GEMINI ?? 'gemini-2.5-flash';
  return [
    {
      name: 'workers-ai',
      model: workersModel,
      available: !!env.AI,
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
      model: groqModel,
      available: !!env.GROQ_API_KEY,
      async call(req, signal) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          signal,
          headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: groqModel,
            messages: req.messages,
            max_tokens: req.maxTokens ?? 700,
            temperature: req.temperature ?? 0.2,
            ...(req.json ? { response_format: { type: 'json_object' } } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
        return { text: j.choices[0]?.message.content ?? '', inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens };
      },
    },
    {
      name: 'gemini',
      model: geminiModel,
      available: !!env.GEMINI_API_KEY,
      async call(req, signal) {
        const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
        const contents = req.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`, {
          method: 'POST',
          signal,
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY!, 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents,
            generationConfig: {
              maxOutputTokens: req.maxTokens ?? 700,
              temperature: req.temperature ?? 0.2,
              ...(req.json ? { responseMimeType: 'application/json' } : {}),
            },
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
        const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        return { text, inputTokens: j.usageMetadata?.promptTokenCount, outputTokens: j.usageMetadata?.candidatesTokenCount };
      },
    },
  ];
}

export function piiAllowed(env: Env): Set<string> {
  return new Set((env.AI_PII_PROVIDERS ?? 'workers-ai,groq').split(',').map((s) => s.trim()).filter(Boolean));
}

export function availableProviders(env: Env, containsPii: boolean): string[] {
  const allow = piiAllowed(env);
  return providers(env)
    .filter((p) => p.available && (!containsPii || allow.has(p.name)))
    .map((p) => p.name);
}

export async function chat(env: Env, req: ChatRequest, onAttempt?: (r: { provider: string; model: string; ok: boolean; latencyMs: number; inputTokens?: number; outputTokens?: number }) => void): Promise<ChatResult> {
  const allow = piiAllowed(env);
  const attempts: { provider: string; error: string }[] = [];
  for (const p of providers(env)) {
    if (!p.available) continue;
    if (req.containsPii && !allow.has(p.name)) continue;
    const started = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await Promise.race([
        p.call(req, ctrl.signal),
        new Promise<never>((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new Error('timeout')))),
      ]);
      if (!r.text.trim()) throw new Error('empty response');
      if (req.json) extractJson(r.text); // throws → fall through to next provider
      const result: ChatResult = { ...r, provider: p.name, model: p.model, latencyMs: Date.now() - started };
      onAttempt?.({ provider: p.name, model: p.model, ok: true, latencyMs: result.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
      return result;
    } catch (e) {
      attempts.push({ provider: p.name, error: (e as Error).message });
      onAttempt?.({ provider: p.name, model: p.model, ok: false, latencyMs: Date.now() - started });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new AiUnavailableError(attempts);
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
