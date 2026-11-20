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
  /** speech-to-text for meeting and call recordings */
  AI_MODEL_WHISPER?: string;
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
  /** web push (installable app): VAPID key pair — public as a var, private as a secret */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  /** native push for the Android app: Firebase service-account JSON key (secret) */
  FCM_SERVICE_ACCOUNT?: string;
  /** Gmail + Google Calendar (OAuth app registered by HRP AI) */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Outlook / Microsoft 365 mail + calendar (Entra app registration, multi-tenant) */
  MS_CLIENT_ID?: string;
  /** Zoom OAuth app (General app, user-managed) for meetings and their transcripts */
  ZOOM_CLIENT_ID?: string;
  /** GitHub App (repository picker, check runs, branches from work items) */
  GITHUB_APP_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  ZOOM_CLIENT_SECRET?: string;
  MS_CLIENT_SECRET?: string;
  /** GST portal, e-invoice and e-way bill through the WhiteBooks GSP (developer.whitebooks.in).
   *  WHITEBOOKS_ENV: sandbox (default) or production; the e-invoice / e-way bill keys fall back to the GST API keys. */
  /** Which GST provider: gstinapi, indiacompliance or whitebooks (default: whichever has keys, in that order). */
  GST_PROVIDER?: string;
  /** India Compliance (asp.resilient.tech) API key; INDIA_COMPLIANCE_TEST_MODE=true sends e-invoice and
   *  e-way bill calls to its test servers (returns always go to the live GST portal). */
  /** gstinapi.in API key (gak_…); GSTINAPI_TEST_MODE=true adds test_mode to every call (synthetic, free). */
  GSTINAPI_KEY?: string;
  GSTINAPI_TEST_MODE?: string;
  GSTINAPI_BASE_URL?: string;
  /** bank feeds: RazorpayX API base (tests point it at a fake) */
  RAZORPAYX_BASE_URL?: string;
  INDIA_COMPLIANCE_API_SECRET?: string;
  INDIA_COMPLIANCE_TEST_MODE?: string;
  INDIA_COMPLIANCE_BASE_URL?: string;
  WHITEBOOKS_ENV?: string;
  WHITEBOOKS_BASE_URL?: string;
  WHITEBOOKS_EMAIL?: string;
  WHITEBOOKS_CLIENT_ID?: string;
  WHITEBOOKS_CLIENT_SECRET?: string;
  WHITEBOOKS_EINVOICE_CLIENT_ID?: string;
  WHITEBOOKS_EINVOICE_CLIENT_SECRET?: string;
  WHITEBOOKS_EWAYBILL_CLIENT_ID?: string;
  WHITEBOOKS_EWAYBILL_CLIENT_SECRET?: string;
  /** Meta (Facebook) app for lead ads: app secret signs the leadgen webhook */
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  /** "true" = background mailbox sync around the clock (default: 07:00–21:00 IST) */
  MAIL_SYNC_ALWAYS?: string;
  /** Android app (Trusted Web Activity) for /.well-known/assetlinks.json */
  ANDROID_APP_ID?: string;
  ANDROID_CERT_SHA256?: string;

  // --- bindings ---
  HYPERDRIVE?: Hyperdrive;
  CACHE_KV?: KVNamespace;
  /** optional Workers rate-limiting binding: a shared ceiling for API keys */
  API_RATE_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  JOBS?: Queue<Job>;
  AI?: Ai;
  VECTORIZE?: VectorizeIndex;
  ASSETS?: Fetcher;
  /** Cloudflare R2 bucket for attachments, delivery proofs and documents (optional) */
  FILES?: R2Bucket;
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
