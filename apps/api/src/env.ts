import type { EffectivePermissions, TenantMeta } from '@synapse/shared';
import type { Db } from './lib/db';
import type { Job } from './services/jobs';

/** Worker bindings. Optional bindings degrade gracefully (see docs/free-tier.md). */
export interface Env {
  // --- config vars (wrangler.jsonc "vars") ---
  APP_ENV: 'local' | 'dev' | 'production';
  BASE_DOMAIN: string; // e.g. hrpsynapse.com
  /** non-prod only: allow selecting the tenant with the X-Tenant header (workers.dev / localhost) */
  ALLOW_TENANT_HEADER?: string;
  SIGNUP_ENABLED?: string;
  CORS_ORIGINS?: string;
  AI_DAILY_LIMIT_PER_TENANT?: string;
  /** comma list of providers allowed to receive PII; default "workers-ai,groq" */
  AI_PII_PROVIDERS?: string;
  AI_MODEL_WORKERS?: string;
  AI_MODEL_GROQ?: string;
  AI_MODEL_GEMINI?: string;
  AI_EMBEDDING_MODEL?: string;
  CF_ZONE_ID?: string;

  // --- secrets (wrangler secret put) ---
  JWT_SECRET: string;
  DATA_ENCRYPTION_KEY?: string; // base64 32 bytes, encrypts channel credentials
  DATABASE_URL?: string; // fallback when Hyperdrive is not bound (local dev / tests)
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  TURNSTILE_SECRET?: string;
  CF_SAAS_API_TOKEN?: string;

  // --- bindings ---
  HYPERDRIVE?: Hyperdrive;
  CACHE_KV?: KVNamespace;
  JOBS?: Queue<Job>;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  ASSETS?: Fetcher;
}

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  status: string;
  metaVersion: number;
}

export interface Principal {
  user: {
    id: string;
    email: string;
    fullName: string;
    isOwner: boolean;
    status: string;
    attributes: Record<string, unknown>;
    roles: string[];
  };
  permissions: EffectivePermissions;
  sessionId: string;
}

export interface AppVariables {
  requestId: string;
  db: Db;
  tenant: TenantInfo;
  principal: Principal;
  meta: TenantMeta;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
