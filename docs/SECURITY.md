# Security model

## Tenant isolation: defence in depth

| Layer | Control | Verified by |
|---|---|---|
| Edge | The hostname is checked first: a workspace host or verified custom domain always decides the tenant. On the shared app host (`hrpsynapse.hrpai.in`) the workspace chosen at sign-in is sent as `X-Tenant`. On any other production host that header is ignored, and unknown hosts get 404 before any tenant query runs. | `api.test.ts` ("shared app host") |
| Token | The JWT audience is `tenant:{id}`. A token minted for tenant A fails verification on tenant B's host. | `api.test.ts` ("token from tenant A is rejected on tenant B") |
| Query | The data layer always filters by `tenant_id`. Identifiers come only from a static registry or regex-validated metadata keys, and values are always bound parameters. | code review, `records.ts` |
| Database | `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant table. The runtime role `synapse_app` is `NOBYPASSRLS`, owns nothing, and gets transaction-scoped context. An empty or malformed context matches nothing or raises an error, so access fails closed. | `rls.test.ts` (21 tests) |
| References | Composite `(tenant_id, id)` foreign keys, so a guessed id from another tenant is rejected. Custom lookups are validated in the API. | `rls.test.ts`, `api.test.ts` |
| Caches | Every key is prefixed `t:{tenant}:` or `p:` (this is asserted in code). Authenticated responses are `no-store`. Hyperdrive caching is off. | `cache.ts` |
| Vectors | One Vectorize namespace per tenant. Chunk text is re-read from Postgres under RLS, so a vector-index mistake can't surface another tenant's text. | `features.ts` |
| Jobs | Every queue message carries `tenantId`, and the consumer sets context itself. Nothing is inherited between messages. | `worker.ts` |
| Platform functions | `SECURITY DEFINER` functions with `search_path` pinned, each doing one narrow thing: resolve a host, resolve a public route, create a tenant, or list tenant ids for housekeeping. | `0008`, `0009` migrations |

## Authentication

Because several workspaces can share one app host, refresh cookies are named per workspace (`__Host-synapse_rt_<workspace>`). Signing in to one workspace never overwrites or exposes another workspace's session.

- Passwords use PBKDF2-SHA256 through WebCrypto, with the iteration count stored in the hash so it can be raised later. Constant-time compare. Unknown users get a dummy hash computation, so response timing doesn't reveal which emails exist.
- After 5 failed attempts the account locks for 15 minutes. Successes, failures and lockouts are all written to the audit log.
- Access JWTs (HS256) last 15 minutes and are held only in memory.
- Refresh tokens are 256-bit random values in a `__Host-` cookie (`HttpOnly; Secure; SameSite=Strict`). Only their SHA-256 hash is stored. They rotate on every use, and reusing an old token revokes the whole token family. Cookie endpoints also require an `X-Requested-With` header as a CSRF guard.
- Disabling a user or resetting a password revokes all of that user's sessions immediately.

## Authorization

- **RBAC:** each role grants per-object `read`, `update` and `delete` scope (`none`, `own`, `team` = me and my direct reports, or `all`) plus `create`. When a user has several roles, the most permissive grant wins.
- **ABAC:** role conditions such as `{"field":"city","op":"eq","value":"$user.region"}` are compiled into SQL. A role with no conditions is unrestricted. Condition groups from different roles are OR-ed.
- **Field-level security:** a field can be `hidden` or `read` per role. Hidden fields are removed from responses and from metadata, and filtering, sorting or searching on them is refused, which prevents inferring their values. Writes to read-only fields are rejected.
- **Admin areas:** `users`, `roles`, `metadata`, `modules`, `workflows`, `domains`, `audit`, `channels` and `ai`. The workspace owner always keeps full access, so a tenant can't lock itself out.

## Data protection (DPDP / GDPR posture)

- Custom fields can be flagged `is_pii`. Standard contact fields are PII by default.
- **AI routing:** prompts containing PII go only to the providers listed in `AI_PII_PROVIDERS` (default `workers-ai,groq`). Gemini's free tier can use prompts to improve Google products, so it receives only PII-free prompts, such as lead scoring, which sends feature flags instead of contact details. Add `gemini` to the list only after moving to a paid Gemini plan.
- **Workspace-owned AI keys (bring your own key):**
  - Encrypted with AES-256-GCM using the tenant id as additional authenticated data (AAD), stored in a table with FORCE RLS, and never returned by the API; only `…last4` is shown.
  - Only workspace admins with the `ai` area can manage them, and every change is audited (the ciphertext is redacted from the audit log).
  - A key is used for personal data only if the admin ticks *allow personal data*.
  - Custom endpoints must be public `https` hostnames: IP literals, localhost, `.internal` and `.local` hosts, and URLs with credentials are rejected. This blocks SSRF.
  - Provider error messages are shortened and key-shaped strings are masked before they're stored or shown.
- Prompt-injection hygiene: CRM data is wrapped in `<crm_data>` tags, and the system prompt tells the model to treat it as data.
- Channel credentials are encrypted with AES-256-GCM, using the tenant id as additional authenticated data (AAD), so a ciphertext copied into another tenant won't decrypt.
- `consent` JSON on leads and contacts records marketing consent, including source, timestamp and IP for web forms.
- The audit log is append-only: the app role has no UPDATE or DELETE on it, and a trigger blocks changes even from the owner. Secrets and password hashes are never written to it.

## Known gaps (tracked in ROADMAP.md)

- No MFA or SSO yet (TOTP, then SAML/OIDC).
- PBKDF2 is capped at 100k iterations on Workers, below the current OWASP recommendation for SHA-256. The plan is to move hashing to an Argon2id service on Oracle ARM. Hashes are versioned, so they migrate on next login.
- The audit log has no hash chain or tamper-evident export yet.
- Data residency: everything currently runs in Neon's Singapore region. Per-tenant region pinning needs a separate Neon project per region.
