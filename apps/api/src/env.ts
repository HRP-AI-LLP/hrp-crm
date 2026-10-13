import type { EffectivePermissions, TenantMeta } from '@synapse/shared';
import type { Db } from './lib/db';
import type { Job } from './services/jobs';

/** Worker bindings. Optional bindings degrade gracefully (see docs/free-tier.md). */
export interface Env {
  // --- config vars (wrangler.jsonc "vars") ---
  APP_ENV: 'local' | 'dev' | 'production';
  /** the shared app hostname, e.g. hrpsynapse.hrpai.in (dev: hrpsynapse-dev.hrpai.in).
   *  On this host the workspace is chosen at sign-in and sent as X-Tenant. */
  APP_HOST?: string;
  /** parent for optional per-workspace vanity hosts: <slug>.<BASE_DOMAIN> (normally = APP_HOST) */
  BASE_DOMAIN: string;
  /** non-prod only: also accept X-Tenant on any host (workers.dev / localhost) */
  ALLOW_TENANT_HEADER?: string;
  /** vanity subdomains via Workers Custom Domains (each gets its own free certificate) */
  CF_ACCOUNT_ID?: string;
  CF_ZONE_NAME?: string;
  WORKER_NAME?: string;
  /** CNAME target customers point their own domains at (Cloudflare for SaaS) */
  SAAS_CNAME_TARGET?: string;
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
  /** optional: token allowed to attach Workers Custom Domains (enables <slug>.<BASE_DOMAIN>) */
  CF_TENANT_DOMAINS_TOKEN?: string;
  /** optional: Resend API key for invitations and password resets (free tier: 3,000 mails/month) */
  RESEND_API_KEY?: string;
  /** sender for platform mail, e.g. "HRP Synapse <no-reply@hrpai.in>" (domain verified in Resend) */
  MAIL_FROM?: string;

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
    mfaEnabled?: boolean;
  };
  permissions: EffectivePermissions;
  sessionId: string;
  /** teams the user belongs to / leads (team-scoped access and sharing) */
  teams?: string[];
  leads?: string[];
  /** sharing rules that apply to this user */
  shares?: { objectKey: string; criteria: { field: string; op: string; value?: unknown }[]; access: 'read' | 'edit' }[];
  /** set when the request is authenticated with an API key */
  apiKey?: { id: string; scopes: string[] };
}

export interface AppVariables {
  requestId: string;
  db: Db;
  tenant: TenantInfo;
  principal: Principal;
  meta: TenantMeta;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };
