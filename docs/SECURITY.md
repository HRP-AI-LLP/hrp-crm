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

### Fifth-round review fixes

An independent review of the fifth round found no cross-tenant leaks; these were fixed before release:

- **Privacy requests**: a portal request links only to a record with the verified email; completing an erasure or exporting data needs that match or a staff verification note. Request numbering takes a per-workspace lock.
- **Campaigns send exactly once**: rows are claimed and committed before sending, each send is recorded in its own short transaction, a row left mid-send by a crash is marked failed (never resent), and a paused or cancelled campaign stops between messages. The creator must still hold the campaigns permission. Campaigns honour a channel opt-out even for utility templates.
- **Tally**: only new or changed vouchers are offered (no 2,000-row ceiling), edits go out as `Alter`, receipts from Tally take a per-voucher lock and a savepoint each, so one bad receipt is reported instead of undoing the batch.
- **Webhooks** carry the record as the hook's creator sees it (record visibility and field security); otherwise only the event and id.
- **Erasure** also removes the person's chat threads and their messages, campaign addresses (hashed), plain-text opt-out rows, notifications and stored webhook copies.
- **Business health**: money KPIs are blank when the amount field is hidden from the viewer; payment-link totals cover only visible payments.
- **Shared dashboards**: charts and summaries only (no row tables), cached five minutes per link, rate-limited per visitor and per link; expiry and revocation take effect immediately.
- Smaller: FCM forgets a device only on `UNREGISTERED`/404; WhatsApp status lookups check record access; re-linking a conversation moves only its unlinked messages; digests are claimed before sending and switch off when no recipient can sign in; public order pages omit internal milestone notes.

### Sixth round (Nov 2026): revenue intelligence

- **Context and agents run as the person asking.** Records, fields, tasks (task permission), calendar events (owner, attendee or deal read "all") and score factors (object and field security) are filtered before anything reaches a model or a screen.
- **Agent results are personal.** A brief, debrief or analysis is shown only to the person who ran it, since it reflects what they can see. Each attendee prepares their own brief; the organiser's is the one recorded on the meeting.
- **Writes need the right access.** Meeting notes, recordings and debriefs need write access to the meeting. Timeline entries and competitor tags on a record need edit access to it. Field changes are only suggestions until someone with edit access applies them, and the timeline records which field changed, not its values. AI-extracted action items go to the person who ran the debrief. Competitor tags need an exact name or alias match.
- **Prompt injection:** CRM text, transcripts and website text are wrapped as data. The worst a malicious text can do is shape the output and the requester's own action items.
- **Website research** reads public https sites only, rejecting IP literals, local names and credentials. It re-checks every redirect, caps size and time, and runs outside any database transaction.
- **Recording transcription** is capped at 20 MB while streaming, counts against the workspace's daily AI allowance, and keeps no audio.
- **Insights** show only deal-level and conversation factors. Standing risks resurface weekly after a dismissal. Stale insights about closed or deleted records are removed.
- **The sweep** is queued per workspace and per part (detect, auto-prep, index), with batched writes.
- **Erasure** also removes search-index entries and their vectors, agent runs about the person, citing them, or built from their meetings and calls, plus suggestions, action items, insights, scores and meeting notes.

### Seventh round (Nov 2026): Books

- **The ledger is enforced by the database.**
  - Journals must balance (a deferred constraint).
  - Lines go only into a posted journal, on its date.
  - Posted lines never change and leave the balances only when their journal is voided.
  - The application role cannot delete journals.
  - The lock date applies to posting and voiding.
  - There is one live journal per document.
- **Documents and journals stay in step.**
  - Posted bills, vendor payments and submitted expenses can only be changed through their services (database guards and field locks).
  - Payments and vendor payments cannot be created, imported or merged as plain records.
  - Financial documents are never merged.
  - A change that would alter a bank-reconciled entry is refused.
- **Who can post.**
  - Ledger, banking, reports, settings, write-offs and reimbursements need the `books` admin area.
  - Sales roles cannot raise bills or pay vendors.
  - Expenses filed by non-accountants go through approval and post only to expense or non-system asset categories.
  - Nobody approves an expense they own or filed.
  - TDS, bank charges, deposit accounts and currency on receipts need the billing or books permission. Deposits go only to bank or cash.
  - A foreign-currency payment settles only documents in that currency, at a rate within 25% of theirs.
- **GST set-off follows Section 49 and Rule 88A.** Reverse-charge tax is always shown as payable in cash.
- **Bounds.** Dates are validated. Statement and GSTR-2B imports are size-capped. Depreciation runs at most to next month end. Recurring profiles start at most a year back and catch up at most 12 runs a day. CSV exports are formula-safe.

### Seventh round: Projects and timesheets

- **Access follows the project.**
  - Who can do what:
    - Managers (the owner, members with the manager role, people who may edit every project, and `projects` admins) can plan, approve and bill.
    - Members work on tasks.
    - Viewers look.
  - Ids from another project are refused everywhere.
  - Members reach the project from its own page even without the record permission.
- **Money stays with managers.** Bill and cost rates, fixed fees, money budgets, cost and value columns in reports, and copying a project as a template are for managers only.
- **Time approval:**
  - Nobody approves time they logged, or time they entered or last changed for someone else.
  - A week is approved only when none of its time is still awaiting a decision, rejected or being corrected.
- **The database guards time.** Submitted, approved and invoiced time cannot be edited or deleted, and approved or invoiced time never goes back to draft. One timer per person, and a day cannot exceed 24 hours.
- **The weekly grid edits time in place.** Notes, billable flags and issue links are kept.
- **Billing:**
  - Time, expenses and milestones are locked while they are invoiced, and released when the invoice is cancelled or deleted.
  - Credit notes carry the project, so project revenue stays right.
  - An expense can be tagged only to a project the filer works on.

### Seventh round: Manufacturing

- **Who does what:**
  - Bills of materials, work centres and MRP need the `manufacturing` admin area.
  - Releasing, closing and cancelling a work order is for planners: the `manufacturing` admin area, or the right to create work orders. The shop floor issues and returns material, logs time and records output.
  - Production screens (overview, batches, quality, BOMs, reports) need read access to work orders, or the manufacturing or operations admin area.
- **Costs stay with people who may see costs.** Material, labour, WIP, standard and actual cost, variance and work centre rates are returned only to manufacturing, operations and books admins, or to people who can see and edit product cost prices. Work order cost fields are hidden from sales and read-only roles.
- **Quality:**
  - Final inspections, which release QC-gated output, need the manufacturing or operations admin area. Nobody certifies their own output.
  - On the floor, an inspection must be of the order's own product or materials, and of a batch that went into or came out of that order.
  - Only manufacturing or operations admins change a batch's status by hand.
- **Batches:**
  - Quarantined and rejected batches are never used. If usable batches and unbatched stock can't cover a quantity, the request is refused rather than quietly taking held stock.
  - Batches never add up to more than stock on hand. Stock that leaves another way (shipments, adjustments) comes off the batches first-expiry-first-out.
  - Output cannot be added to a batch that is on hold or rejected.
- **Stock and ledger integrity:**
  - Production does not take stock reserved for sales orders.
  - Output needs issued material, so nothing comes into stock at no cost.
  - Job work receipts are capped at the expected quantity plus 10%, and the expected quantity is frozen once goods are sent.
  - Every journal's source is the log row written in the same request.
- **Frozen after draft:** a work order's product, quantity, BOM, warehouse and sales order, and a job work's job worker, output, expected quantity, warehouse and rate. Only drafts and cancelled documents can be deleted, and neither can be merged.
- **Bounds:** costing is computed once per BOM per request and capped at 12 levels and 2,000 BOMs. Explosion is capped at 1,000 nodes and tracing at 20 levels and 500 rows. Work order quantity is at most 10,000,000.
- **The ITC-04 CSV is formula-safe.**


### Eighth round (Nov 2026): GST portal, e-invoice and e-way bill

- **Keys:**
  - The WhiteBooks platform keys (`WHITEBOOKS_*`) live only in the Worker's secrets, or in `apps/api/.dev.vars` locally (written from the git-ignored `.env`). They are never sent to the browser or logged.
  - `pnpm gst:check` prints status codes only and blanks the keys out of any error text.
- **Taxpayer credentials:**
  - The e-invoice and e-way bill API passwords, the GST portal session (txn) and the IRP token are encrypted with `DATA_ENCRYPTION_KEY`, with the tenant id bound in as AAD.
  - None of them is ever returned. The API only says whether a password is saved.
  - Changing the username, password or GSTIN drops the related session.
- **Who:** the GST portal, filing, IRN and e-way bill need the books or billing admin area. Taxpayer search also allows account admins. Each step re-checks this in its own transaction.
- **No calls inside transactions:** each step reads what it needs, calls the GSP outside any database transaction, then records the outcome. Calls time out after 45 seconds.
- **Inputs to the GSP:**
  - Portal views are an allow-list of paths, and every parameter must match a safe pattern.
  - The GSP path itself is checked.
  - Uploaded return JSON must be for the connection's GSTIN and is capped at 5 MB.
  - The base URL must be https, or http only to localhost.
- **Filing:**
  - Filing needs:
    - the summary fetched from the portal;
    - proceed-to-file for GSTR-1 / 1A;
    - the offset for GSTR-3B;
    - the signatory's PAN;
    - an explicit declaration.
  - A filed return cannot be prepared, saved or reset again.
  - Every call is logged in `gst_events` (append-only for the app role), and filing also writes an audit log entry.
- **Sessions:** a session-expired answer from the portal marks the connection expired. The OTP must be verified within 15 minutes of the request.
- **Issued invoices:** the issued-invoice guard was widened only for the IRN's QR code, the IRN cancellation time and the e-way bill fields. Tax content stays frozen.

#### GST provider choice: India Compliance

- **Two providers, one interface:** `services/gst/provider.ts`. India Compliance's key (`INDIA_COMPLIANCE_API_SECRET`) is a Worker secret; `pnpm gst:ic-account` writes it to the git-ignored `.env` and never prints it.
- **GSTN encryption in the app** (`gstn-crypto.ts`): AES-256-ECB, HMAC-SHA256 and RSA PKCS#1 v1.5 with GSTN's public certificate. Tests check them against OpenSSL. Every encrypted response's HMAC is verified before it is used. The session key (sek), auth token and app key live only in the sealed session. A fresh app key is made for every OTP.
- **No returns sandbox** with India Compliance: filing still needs the fetched summary, the proceed/submit step, the GSTR-3B offset, the signatory's PAN, the EVC OTP and the declaration.

#### gstinapi.in and keeping paid answers

- `GSTINAPI_KEY` is a Worker secret (locally the git-ignored `.env` → `.dev.vars`). The e-invoice and e-way bill API passwords are sent to gstinapi.in per call (they say they don't store them) and are kept encrypted here.
- Every provider answer is stored: `gst_api_cache` (latest answer per GSTIN and lookup, read first, refreshed only on request) and `gst_events.data` (each call's answer, capped at 1 MB). Both are tenant-isolated (RLS) and never hold credentials; tests check that the passwords don't appear.

### Ninth round (Nov 2026): the accounts desk

- **Who:** every desk screen and action (runs, the review queue, findings, feeds) needs the books admin area. The daily round runs as the workspace's system principal, only for workspaces that saved desk settings or connected a feed.
- **Bank feed keys:** RazorpayX key id and secret are checked with RazorpayX before they are stored, sealed with `DATA_ENCRYPTION_KEY` (tenant id as AAD) in `bank_feeds.secret_ciphertext`, and never returned; the list shows only the last four digits of the account. Razorpay gateway settlements use the existing Razorpay integration's sealed keys.
- **No calls inside transactions:** feeds, settlements and the model are called between short transactions. Feed calls time out after 30 seconds.
- **What the agents may post:** only through the same functions people use (match, categorise, record receipt, record vendor payment, exclude), each under a savepoint so one failure leaves the rest. In the default mode only bank rules, exact matches (≥ 95%) and consistent history (≥ 90%) are posted; AI and keyword guesses always wait for a person. Every proposal, decision and run is kept (`acct_proposals`, `acct_runs`); everything posted can be undone from Banking.
- **AI:** bank narrations, account names, customer and vendor names and open document numbers are sent to the workspace's own AI model (flagged as containing personal data, so only PII-allowed providers are used), as short refs (T1, A3, I2) so the model cannot invent ids; every answer is validated (direction, open balance, party for receivable/payable accounts) and capped at 85% confidence. The controller's note gets only totals. The model can be switched off in desk settings.
- **Gateway receipts:** with books on, Razorpay payment-link receipts now go to "UPI / payment gateway clearing" instead of the bank; the settlement (net + fee + GST on the fee) clears it.

## Digital signature certificates and document templates (Nov 2026)

- **.pfx keys** are stored only as AES-GCM ciphertext (`dsc_certificates.pfx_enc`, `pass_enc`) bound to the
  workspace as associated data, under the deployment's `DATA_ENCRYPTION_KEY`. No API returns them; signing decrypts
  in memory for the one request. Removing a certificate nulls both columns. Only users listed on the
  certificate may sign with it; managing certificates needs `canManageOrg`.
- **USB tokens**: the private key never leaves the token. The local signer binds to `127.0.0.1`, answers CORS
  and Private Network Access only for the paired origin, and refuses any request without a ticket. A ticket
  is an HMAC (per-signer pairing secret, stored encrypted server-side) over workspace, signer, user, document,
  certificate thumbprint, PDF SHA-256 and length, and a 10-minute expiry. The server then checks the signed
  file is an incremental update of exactly those bytes, verifies the CMS signature, matches the thumbprint and
  requires the signature to cover the whole file. Unpairing revokes the secret at once. The PIN is sent only
  to the local signer.
- **HTML templates** render through Mustache (escaped by default) and DOMPurify, without scripts, event
  handlers or external fetches, inside a shadow root. Letterheads are stored as data URLs (≤ 6 MB).
- New tables (`doc_templates`, `dsc_certificates`, `dsc_signers`) are FORCE RLS with the tenant policy.
- **Identity numbers** (`person_identity`): Aadhaar is AES-GCM encrypted under `DATA_ENCRYPTION_KEY` with the
  workspace as associated data; only the last four digits are stored in clear. Revealing it is a separate
  POST that writes `audit_logs` (`reveal`, `person_identity`). Identity papers (`org_documents`) are stored
  under the `organisation` object key, which the generic file routes refuse, and are served by 15-minute
  signed links to the profile's managers (and, for team members, admins with the users area).
- **CSP and the local signer**: `connect-src` allows `http://127.0.0.1:*` so the page can reach the DSC signer on
  this computer (any loopback port, since the signer's port is configurable), and Google Fonts so the signed
  PDF draws in the app's font. Only loopback is opened; the signer itself answers only paired origins with a
  valid ticket.
