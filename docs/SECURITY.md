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
- **Admin areas:** `users`, `roles`, `metadata`, `modules`, `workflows`, `domains`, `audit`, `channels`, `ai`, `operations`, `billing`, `privacy`, `developers` and `campaigns`. The workspace owner always keeps full access, so a tenant can't lock itself out.

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

- No SSO yet (SAML/OIDC). TOTP two-factor is built.
- PBKDF2 is capped at 100k iterations on Workers, below the current OWASP recommendation for SHA-256. The plan is to move hashing to an Argon2id service on Oracle ARM. Hashes are versioned, so they migrate on next login.
- Data residency: everything currently runs in Neon's Singapore region. Per-tenant region pinning needs a separate Neon project per region.

## Second-round additions

- **Two-factor sign-in (TOTP, RFC 6238).** Secrets are encrypted with AES-GCM; the AAD binds them to tenant and user. Codes are accepted once (the last time step is stored), and five wrong codes end the pending sign-in. Recovery codes are stored as SHA-256 hashes and work once. Admins can require two-factor for the whole workspace; until then, members can reach only `/api/auth/*`.
- **Invitations and resets** use single-use tokens (only hashes are stored) that expire after 7 days (invite), 1 hour (self-service reset) or 24 hours (admin link). A reset revokes every session. The "forgot password" endpoint returns the same response whether or not the account exists, and allows at most three mails per hour per person.
- **Teams and sharing.** "Team" access covers direct reports and the members of teams the user leads. Sharing rules (criteria → team or role, read or edit) and per-record shares only ever widen own/team access. They are compiled into the same SQL predicate as lists, reports, exports and record loads.
- **API keys** have the form `syn_<workspace>_<secret>`; only a SHA-256 hash is stored. A key acts as one user with that user's permissions, is limited to `/api/v1`, and is read-only unless it was given write scope. Keys can expire, can be revoked, and record when they were last used.
- **Audit redaction.** Password, MFA, token and key hashes never reach the audit log.

## Third-round additions

- **Files (R2).** The type is sniffed from the bytes; the sniffed type wins over the declared one, and active content is served as an attachment with `X-Content-Type-Options: nosniff`. Download links are HMAC-signed (`JWT_SECRET:files`), bound to tenant, file, expiry and disposition, and compared in constant time. Each workspace has a storage quota.
- **Customer links** (quotes, deliveries, installations, ticket status) use 192-bit random tokens and only work while the record is in a state where the customer should act. Signatures must decode as real PNGs. Ticket replies through the public page are capped at 10 an hour per ticket.
- **Financial integrity.** Issued invoices and their lines are frozen by a database trigger. Payment allocations are merged per invoice and re-checked against the open amount after insert. Credit notes are limited, per line and in value, to what earlier credit notes haven't already credited; this is checked again at issue under a row lock. The stock ledger is append-only (no UPDATE or DELETE grant).
- **Approvals.** A requester can't approve their own request; the workspace owner is the only exception. Approval rule criteria stay on the server.
- **Aggregates follow visibility.** Role dashboards, receivables aging and stock views are computed with the same visibility predicate as lists. Cost and stock value are hidden when the cost field is hidden.
- **Network restrictions.** Workspaces can limit sign-in, the app and API keys to IPv4/IPv6 CIDR ranges and/or countries.
  - Only Cloudflare's `cf-connecting-ip` and `cf-ipcountry` are trusted in production.
  - A policy that would block the admin saving it is refused.
  - Customer pages stay open.
  - Members don't receive the rule list in metadata.
- **Web Push.**
  - Payloads are encrypted end to end (RFC 8291, aes128gcm) and signed with VAPID (ES256).
  - Subscriptions must point at a known browser push service. Delivery has a 5-second timeout.
  - Pushes go only to active users with a live session. Signing out on a device unsubscribes it, and disabling a user or signing them out everywhere drops their devices.
  - Notification links are resolved same-origin before navigating.
- **Offline outbox.** Queued visits, leads and task updates are stored in IndexedDB with their owner (`tenant:user`). Only that person can send them, after signing in again.
- **Service worker.** It never caches `/api/*` responses; only the hashed app shell is cached.
- **Backups.**
  - Only the workspace owner can create, download or delete backups.
  - Backups are stored under a per-tenant R2 prefix, and the stamp is validated.
  - Excluded: sessions, tokens, API keys, push subscriptions and public route keys. Blanked: password, MFA, secret, token and key columns.
  - Every start and download is audited.

## Integrations (Oct 2026)

- **OAuth (Google, Microsoft, Meta):**
  - The state is HMAC-signed, carries the workspace, user, provider and return address, expires after 10 minutes, and can be used once (KV).
  - It is also bound to the starting browser through an HttpOnly `__Host-` cookie, so a link forwarded to someone else cannot attach their mailbox or pages to another account.
  - The return address must be this app or the workspace's own domain.
  - Microsoft mailboxes are identified by their sign-in name (a verified domain), not the editable `mail` attribute.
  - Tokens are AES-GCM encrypted with the workspace id as additional authenticated data. They are revoked when someone disconnects or a user is disabled.
- **Mail privacy:**
  - Only mail with contacts and open leads **that the mailbox owner can see** is stored, so a colleague cannot pull someone's mail onto their own record.
  - Mail between colleagues is never stored, each person can exclude addresses and domains, and each message is logged once.
  - Sync never holds a database lock while the provider answers.
- **Webhooks:**
  - Meta is verified by `X-Hub-Signature-256` with the app secret; a page routes to exactly one workspace and needs Manage or Advertise access to connect.
  - Razorpay is verified by an HMAC of the raw body with the workspace's webhook secret.
  - Google Ads is checked against its key in constant time.
  - Exotel callbacks don't arrive signed; they are accepted only at the workspace's unguessable route key, and status updates apply only to calls this workspace placed.
  - Bodies are capped at 256 KB (streamed), and provider ids are processed once (`external_refs`).
- **Payments:**
  - Links need edit rights on the document or the Billing admin permission, and only one link per invoice or milestone can be open at a time.
  - Amounts are capped at what is due, and the receipt is recorded once per Razorpay payment id.
- **Calls:**
  - Only the record's own number can be dialled, only Indian numbers unless an admin allows international calls, and each person has an hourly limit.
  - Recording links are kept only for Exotel storage hosts, matching the CSP `media-src`.
- **Calendar:** only a person's own events are mirrored to their calendar; reassigning an event removes the previous owner's copy.

## Fifth round (Oct 2026): privacy, WhatsApp, Tally, developer platform

- **Consent and opt-outs.** Every consent change is an append-only `consent_events` row (the app role has no UPDATE or DELETE) with source, notice version and evidence. Withdrawals put the address on `suppressions`. Every outbound WhatsApp and email path (1:1 sends, campaigns, automations) goes through `canContact()`: marketing needs consent and no opt-out; service messages are blocked only for erased or fully blocked addresses. Erased people stay blocked through a hashed address, so the address itself is not kept.
- **Data-principal requests.** Portal requests are confirmed through a single-use email link (only its hash is stored, 48-hour expiry) or verified by staff with a recorded note before anyone acts. The portal caps submissions per workspace per day and supports Turnstile. Status links are random keys.
- **Erasure** anonymises the person's record, messages, timeline and files (R2 objects are deleted after the transaction commits). Tax invoices are kept, as GST law requires. The audit trail cannot be rewritten, so entries about erased records are shown and exported masked.
- **Audit export** is hash-chained (each NDJSON line carries the SHA-256 of the previous hash plus its content); the final hash is returned so a later copy can be checked.
- **Signed links.** Unsubscribe links and customer document links (invoice / order, 30 days) are HMAC-signed with a purpose-specific key derived from `JWT_SECRET`; dashboard share links are random tokens with an expiry, run as the person who shared them and can be revoked.
- **Shared inbox.** People see conversations assigned to them or about records they can see; inbox admins (`channels`) see all. Media is proxied from Meta only for allowed hosts and served with a sandboxing CSP.
- **Campaigns** resolve their audience with the creator's permissions (record visibility and field-level security), at most 5,000 people, and re-check consent before each message. A broken token or paused number stops the campaign.
- **Digests** run as each recipient, and only active workspace users can receive them.
- **Tally connector** authenticates with a random token shown once; only its SHA-256 is stored. Vouchers carry a `REMOTEID`, so receipts Synapse sent are not imported back, and every Tally receipt is applied once (by GUID).
- **Webhooks** carry `X-Synapse-Signature-V2: t=…,v1=HMAC(secret, "t.body")` (the v1 header remains). Targets must be public HTTPS hosts; redirects are not followed and deliveries time out after 10 seconds. Every attempt is logged for 30 days.
- **API keys** have a per-minute limit (default 600) with `X-RateLimit-*` headers and 429 + `Retry-After`. An optional Workers rate-limiting binding (`API_RATE_LIMITER`) adds a ceiling shared across isolates.
- **Native push** uses a Firebase service account (secret `FCM_SERVICE_ACCOUNT`); tokens of signed-out, disabled or uninstalled devices are dropped.
