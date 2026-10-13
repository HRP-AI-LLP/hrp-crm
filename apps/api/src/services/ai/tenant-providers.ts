/**
 * Tenant bring-your-own AI keys: storage, validation and loading for the router.
 * Keys are encrypted with DATA_ENCRYPTION_KEY (AES-256-GCM, tenant id as AAD) and are never
 * returned by the API — only a short hint like "…a1B2".
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { decryptSecret, encryptSecret } from '../../lib/crypto';
import type { Tx } from '../../lib/db';
import { ApiError, badRequest } from '../../lib/errors';
import { TENANT_PROVIDER_DEFAULTS, type TenantProviderConfig, type TenantProviderKind } from './router';

export const PROVIDER_KINDS = ['openai', 'anthropic', 'gemini', 'groq', 'openrouter', 'openai_compatible'] as const;

/** Public https endpoints only: no IP literals, no localhost / internal names. */
export function assertSafeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('Base URL is not a valid URL');
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:') throw badRequest('Base URL must use https');
  if (u.username || u.password) throw badRequest('Base URL must not contain credentials');
  if (/^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')) {
    throw badRequest('Base URL must be a public hostname');
  }
  return u.toString().replace(/\/$/, '');
}

export const createProviderSchema = z.object({
  provider: z.enum(PROVIDER_KINDS),
  label: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(300).optional(),
  apiKey: z.string().trim().min(8).max(500),
  allowPii: z.boolean().default(false),
  priority: z.number().int().min(1).max(1000).default(100),
});

export const updateProviderSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().max(300).nullable().optional(),
  apiKey: z.string().trim().min(8).max(500).optional(),
  allowPii: z.boolean().optional(),
  priority: z.number().int().min(1).max(1000).optional(),
  isEnabled: z.boolean().optional(),
});

export const hint = (key: string) => `…${key.slice(-4)}`;

export function requireEncryptionKey(env: Env): string {
  if (!env.DATA_ENCRYPTION_KEY) throw new ApiError(500, 'not_configured', 'DATA_ENCRYPTION_KEY secret is not set on this deployment');
  return env.DATA_ENCRYPTION_KEY;
}

export async function encryptKey(env: Env, tenantId: string, apiKey: string) {
  return encryptSecret(requireEncryptionKey(env), apiKey, tenantId);
}

export function normaliseCreate(input: z.infer<typeof createProviderSchema>) {
  const d = TENANT_PROVIDER_DEFAULTS[input.provider];
  const model = input.model || d.model;
  if (!model) throw badRequest('Model is required for this provider');
  let baseUrl: string | null = null;
  if (input.provider === 'openai_compatible') {
    if (!input.baseUrl) throw badRequest('Base URL is required for an OpenAI-compatible endpoint');
    baseUrl = assertSafeBaseUrl(input.baseUrl);
  } else if (input.baseUrl && input.provider === 'openai') {
    // allows Azure OpenAI / regional OpenAI endpoints that speak the same API
    baseUrl = assertSafeBaseUrl(input.baseUrl);
  }
  return { model, baseUrl, label: input.label || d.label };
}

interface Row {
  id: string;
  provider: TenantProviderKind;
  model: string;
  base_url: string | null;
  secret_ciphertext: string;
  allow_pii: boolean;
}

/** Enabled tenant providers, decrypted, in priority order. Rows that fail to decrypt are skipped. */
export async function loadTenantProviders(env: Env, tx: Tx, tenantId: string): Promise<TenantProviderConfig[]> {
  if (!env.DATA_ENCRYPTION_KEY) return [];
  const rows = await tx.query<Row>(
    `select id, provider, model, base_url, secret_ciphertext, allow_pii from tenant_ai_providers
      where tenant_id = $1 and is_enabled order by priority, created_at`,
    [tenantId],
  );
  const out: TenantProviderConfig[] = [];
  for (const r of rows) {
    try {
      out.push({ id: r.id, provider: r.provider, model: r.model, baseUrl: r.base_url, apiKey: await decryptSecret(env.DATA_ENCRYPTION_KEY, r.secret_ciphertext, tenantId), allowPii: r.allow_pii });
    } catch {
      /* key rotated or row tampered with: skip rather than fail the whole request */
    }
  }
  return out;
}

export async function tenantAiSettings(tx: Tx, tenantId: string): Promise<{ platformFallback: boolean }> {
  const r = await tx.one<{ settings: { ai?: { platformFallback?: boolean } } }>(`select settings from tenants where id = $1`, [tenantId]);
  return { platformFallback: r?.settings?.ai?.platformFallback !== false };
}
