# HRP Synapse

Multi-tenant, metadata-driven CRM by **HRP AI LLP**. It runs on free tiers: Cloudflare Workers at the edge, Neon Postgres with Row Level Security, and Workers AI / Groq / Gemini for the AI features.

```
apps/
  api/        Edge gateway Worker (Hono): tenant routing, auth, RBAC/ABAC/FLS, CRM API,
              queue consumer, cron. Also serves the SPA through Workers Static Assets.
  web/        React 19 + Vite SPA (records, views, builders, quotes, orders, inventory, delivery,
              service desk, GST billing, My day, role dashboards, settings) in the hrpai.in brand;
              installable (PWA) with push and an offline outbox
mobile/       Android (Trusted Web Activity) and Capacitor shells for the store apps — see mobile/README.md
packages/
  db/         SQL migrations (RLS, audit, EAV index, platform functions), runner, seed, RLS tests
  shared/     Field types and validation, standard objects, permission engine, industry modules
scripts/
  setup.ps1               Windows entry point for first-time setup
  setup/provision.mjs     Idempotent Neon + Cloudflare provisioning and deployment (also VAPID push keys)
  setup/enable-r2.mjs     `pnpm setup:r2` — creates the R2 buckets and adds the FILES binding
.github/workflows/        ci.yml (PRs), deploy-dev.yml (dev branch), deploy-prod.yml (prod branch)
docs/                     Architecture, security model, free-tier budget, roadmap
```

## First-time setup (Windows, VS Code terminal)

1. Install **Node.js 22 LTS** and **Git**. If you want the script to set your GitHub Actions secrets for you, also install the GitHub CLI (`gh auth login`).
2. Make sure **hrpai.in** is a zone on your Cloudflare account, and that there are **no existing DNS records** for `hrpsynapse.hrpai.in` or `hrpsynapse-dev.hrpai.in`. Setup attaches both hostnames to the Workers, and Cloudflare creates the DNS records and certificates itself.
3. Create a Cloudflare API token (*My Profile → API Tokens → Create custom token*) with these permissions:
   - Account: **Workers Scripts – Edit**, **Workers KV Storage – Edit**, **Queues – Edit**, **Hyperdrive – Edit**, **Vectorize – Edit**, **Account Settings – Read**
   - Zone **hrpai.in**: **Zone – Read**, **DNS – Edit**, **Workers Routes – Edit**, **SSL and Certificates – Edit**
3. In the VS Code terminal, from this folder:

   ```powershell
   $env:NEON_API_KEY="napi_..."
   $env:CLOUDFLARE_API_TOKEN="..."
   $env:CLOUDFLARE_ACCOUNT_ID="..."
   # optional (these are the defaults)
   $env:ZONE_NAME="hrpai.in"
   $env:DEV_APP_HOST="hrpsynapse-dev.hrpai.in"
   $env:PROD_APP_HOST="hrpsynapse.hrpai.in"
   # optional platform-wide AI fallbacks (workspaces can also add their own keys in Settings → AI models)
   $env:GROQ_API_KEY="..."
   $env:GEMINI_API_KEY="..."              # receives PII-free prompts only (see docs/SECURITY.md)

   .\scripts\setup.ps1
   ```

The script is safe to re-run. It:

- creates the Neon project `hrp-synapse` (Postgres 17, Singapore) with the `main` branch for prod and a `dev` branch
- runs all migrations and creates the least-privilege runtime role `synapse_app` (NOBYPASSRLS)
- creates KV, Queues and a dead-letter queue, a Vectorize index and Hyperdrive (query cache **off**) for both environments
- renders `apps/api/wrangler.jsonc`, builds the SPA, and deploys `synapse-dev` at **https://hrpsynapse-dev.hrpai.in** and `synapse-prod` at **https://hrpsynapse.hrpai.in**
- sets the Worker secrets and seeds a **demo** workspace on dev
- sets the GitHub repository secrets if `gh` is logged in

Generated passwords and keys are written to `infra/.local/secrets.json`, which is git-ignored and never printed. The demo admin password is stored there under `dev.DEMO_ADMIN_PASSWORD`.

> **Execution policy:** if PowerShell blocks the script, run `Set-ExecutionPolicy -Scope Process Bypass` in the same terminal first.

## Day-to-day

| Command | What it does |
|---|---|
| `pnpm local` | **Run everything on this computer, no cloud.** Starts Postgres 17 in Podman (or Docker) — container `synapse-pg`, volume `synapse-pgdata`, 127.0.0.1:54329 — applies migrations, creates a `demo` workspace once (admin@demo.local; password in `infra/.local/local.json`), writes `.dev.vars`, builds the app and starts the API on http://localhost:8787 and Vite on http://localhost:5173 with `apps/api/wrangler.local.jsonc` (no remote bindings). Files, cache and queue are simulated by wrangler; AI uses `GROQ_API_KEY` / `GEMINI_API_KEY` if set, otherwise rule-based fallbacks. On Windows it starts the Podman machine if needed. Flags: `--no-migrate`, `--no-build`, `--reset-db`; `CONTAINER_ENGINE=docker` to prefer Docker |
| `pnpm local:cloud` | The same app against the cloud **dev** environment: migrates only the Neon `dev` branch and uses the real dev AI and knowledge-base resources. Flags: `--no-migrate`, `--no-build` |
| `pnpm local:stop` | Stops a running `pnpm local` / `pnpm local:cloud`; `--db` also stops the local database container (data is kept) |
| `pnpm local:test` | Runs the test suites against a throwaway Postgres container (`synapse-pg-test`, 127.0.0.1:54330, in memory), separate from your local database |
| `pnpm dev` | Vite on http://localhost:5173 plus the Worker on :8787 (uses whatever `apps/api/.dev.vars` the last `pnpm local` or `pnpm local:cloud` wrote) |
| `pnpm test` | RLS isolation tests and API end-to-end tests against the Postgres in `TEST_ADMIN_DATABASE_URL` (or use `pnpm local:test`) |
| `pnpm db:migrate` | Apply migrations (`DATABASE_URL_OWNER` required) |
| `pnpm typecheck` | Type-check every package |
| `pnpm deploy:dev` | Manual deploy of the dev Worker |

## Workspace addresses

| Where | How the workspace is chosen |
|---|---|
| `https://hrpsynapse.hrpai.in` (prod), `https://hrpsynapse-dev.hrpai.in` (dev) | The user types the workspace ID at sign-in, e.g. `acme`. A link like `/login?workspace=acme` pre-fills it. |
| `https://acme.hrpsynapse.hrpai.in` (optional) | From the hostname. Each workspace host is attached as a Workers Custom Domain with its own free certificate (Cloudflare's free certificate covers only one subdomain level, so a wildcard can't be used). To turn this on, set `$env:CF_TENANT_DOMAINS_TOKEN` (a token with the same zone permissions as above plus Workers Scripts – Edit) and re-run setup. Admins then use Settings → Domains. |
| `https://crm.customer.com` | A customer's own domain through Cloudflare for SaaS (Settings → Domains; needs `CF_ZONE_ID` and `CF_SAAS_API_TOKEN`). |

Locally and on dev, sign in with workspace **demo**.

## AI models per workspace

Workspace admins can add their own API keys in **Settings → AI models**. Supported providers are OpenAI (and Azure OpenAI), Anthropic, Google Gemini, Groq, OpenRouter, and any OpenAI-compatible endpoint.

- **Order:** a workspace's own keys are tried first, in the admin's order. The platform models are the backup, and the admin can switch the backup off.
- **Storage:** keys are encrypted at rest and never shown again; only the last four characters are visible.
- **Personal data:** each key has an *allow personal data* switch, so a key whose provider agreement doesn't cover customer data is used only for prompts without personal data.
- **Daily cap:** calls made on a workspace's own keys don't count against the platform's daily AI cap.

## What's inside

| Area | Highlights |
|---|---|
| Records & views | Leads, contacts, accounts, deals, products, quotes and your own objects; saved/shared views, filters, columns, bulk edit, CSV import/export, duplicates & merge, related lists |
| Builders | Custom fields incl. formulas and roll-ups, validation rules, dependent picklists, conditional fields, drag-and-drop page layouts, visual automations with branches |
| Selling | Pipeline board, GST quotes with PDF and accept links, price books, email templates, calendar & reminders, notifications, forecast vs quota, reports & dashboards |
| AI | Lead scoring, summaries, next best actions, email drafts, knowledge-base answers; workspace-owned model keys |
| Revenue intelligence | **Copilot** workspace (today's meetings with brief/debrief status, "do these first", action items, insights feed); 11 agents that cite their sources — account research, outreach, meeting prep and debrief (notes, transcripts or recordings), call debrief, deal risk, competitive coach, account health, growth opportunities, my focus, pipeline review; AI-suggested field updates applied only with approval; competitors and battlecards; Ask Synapse across the CRM — see [docs/INTELLIGENCE.md](docs/INTELLIGENCE.md) |
| Leads | Sources incl. walk-in, WhatsApp, Instagram, referral, architect, dealer, campaign; assignment rules (round-robin / least-loaded), scoring rules, follow-up reminders, lead aging and source conversion |
| Quotations | Revisions with history, discount approval rules, PDF/print, customer accept links, convert to order |
| Apps (switch on per workspace) | **Orders** (milestones, advances, reservations), **Inventory** (SKUs, categories, variants, warehouses, in/out/adjust/transfer, reorder alerts, opening stock import), **Purchasing** (vendors, POs, goods receipts), **Delivery & installation** (dispatch, crews, checklists, customer sign-off with signature), **Service desk** (tickets, SLA policies, CSAT, customer status page), **GST billing** (tax invoices, credit notes, receipts, receivables, e-invoice JSON, GSTR-1 CSV, Tally XML) |
| Books (accounting) | Double-entry ledger posted automatically from invoices, receipts, bills, vendor payments and expenses; chart of accounts, manual journals, opening balances, lock date; vendor bills and credits with TDS, reverse charge and ITC; expenses and employee claims with approval; bank statement import, rules, matching and reconciliation; P&L, balance sheet, cash flow, trial balance, ledgers, day book, GSTR-3B, GSTR-2B matching, TDS; budgets, fixed assets and depreciation, recurring transactions, multi-currency. Synapse or Tally as the books of record — see [docs/BOOKS.md](docs/BOOKS.md) |
| Projects & timesheets | Projects with team rates, milestones, task lists, sub-tasks and dependencies; list, board and Gantt views; issues and comments; timers and weekly timesheets with manager approval; billing of approved time, milestones and expenses to GST invoices; budgets, profitability, utilisation; projects as templates — see [docs/PROJECTS.md](docs/PROJECTS.md) |
| Manufacturing | Multi-level bills of materials with routings, scrap, yield, by-products and versions; work centres and capacity; work orders (release, issue, operations, output, close) costed through WIP into the books; make-to-order reservations; batches with expiry, FEFO and full traceability; incoming, in-process and final quality checks; job work under GST delivery challans with ITC-04; MRP that suggests and raises purchase and work orders — see [docs/MANUFACTURING.md](docs/MANUFACTURING.md) |
| Government contracts | GeM / tender bids on deals; EMD, performance security (ePBG, bank guarantee, FDR) and retention register with expiry reminders, release and forfeiture, posted to the books; contract number on invoices; milestone acceptance (CRAC); receipts net of TDS, GST TDS, liquidated damages and retention — see [docs/GOVERNMENT.md](docs/GOVERNMENT.md) |
| GST portal (GSP) | Through gstinapi.in (credits; paid answers kept in the database and refreshed on request), India Compliance or WhiteBooks: connect a GSTIN by OTP; filing calendar; cash, ITC and liability ledgers, notices and challans; GSTR-1, GSTR-3B (with offset), ITC-04, GSTR-2X, GSTR-9 and more saved and filed with EVC or DSC; GSTR-2B into reconciliation; e-invoice IRN with signed QR and e-way bills from the invoice — see [docs/GST-PORTAL.md](docs/GST-PORTAL.md) |
| Approvals | One inbox for quotes, orders, purchase orders and invoices; criteria-based rules; approver by user, role or manager |
| Phone | Installable app with **My day** (GPS check-in, walk-in leads, tasks, follow-ups, jobs), Web Push reminders, offline outbox; Android TWA and Capacitor shells with native Android notifications (FCM) |
| Dashboards | Role views for owner, sales head, operations, inventory and service — always scoped to what the viewer may see; custom report & dashboard builder |
| Integrations | Gmail / Outlook mail + calendar sync and send-as-yourself, Razorpay payment links and a UPI QR on invoices, Facebook / Instagram and Google Ads lead forms, Exotel click-to-call with recordings and missed-call follow-ups — see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) |
| Industry solutions | One-click setups for **interior fit-out, modular kitchens, rooftop solar, fabrication and signage**: lead fields, pipeline, apps, payment plan, installation checklist and KPI targets |
| Business health | 24 KPIs (response time, conversion, win rate, enquiry-to-quote, sales cycle, velocity, on-time delivery, first-time-right installs, DSO, collection efficiency, SLA, CSAT…) against targets with trends; measured value delivered; revenue projection |
| WhatsApp & campaigns | Approved templates, shared inbox with the 24-hour window and read receipts, STOP opt-outs, quotes/invoices/orders sent as links; consent-checked WhatsApp and email campaigns with funnel and attributed revenue |
| Privacy (DPDP Act) | Consent ledger and do-not-contact list, versioned privacy notices, public request portal with email verification, access exports and erasure, retention rules, breach register, tamper-evident audit export |
| Tally | Two-way sync through a connector on the accountant's PC: ledgers, invoices, credit notes and receipts with bill references; receipts entered in Tally come back |
| Developers | Per-workspace OpenAPI, REST hooks for Zapier/Make/n8n, webhook delivery log and redelivery, signed timestamps, per-key rate limits |
| Reporting | Scheduled email digests (each recipient sees their own numbers), expiring dashboard share links |
| Files | Attachments on any record in Cloudflare R2 with type sniffing, quotas and signed expiring links |
| Security | RLS isolation, RBAC/ABAC/FLS, teams & sharing rules, TOTP two-factor (optionally required), IP / country restrictions, invitations, session control, scoped API keys, audit log, owner-only workspace backups |

### Optional email for invitations and password resets

Without email, admins get a link to share. To send them by email, create a free [Resend](https://resend.com) account, verify `hrpai.in` there, and add the key to each Worker:

```powershell
cd apps/api
npx wrangler secret put RESEND_API_KEY --env dev
npx wrangler secret put RESEND_API_KEY --env production
```

The sender is `MAIL_FROM` in `wrangler.jsonc` (default `HRP Synapse <no-reply@hrpai.in>`).

### File storage, backups and push (one-time switches)

- **R2 (attachments, signatures, backups):** enable R2 once in the Cloudflare dashboard (R2 Object Storage → Get started), then run `pnpm setup:r2` and deploy. Until then the app works without uploads.
- **Push notifications:** `pnpm setup` generates a VAPID key pair per environment and stores it as Worker secrets. Nothing else to do; people turn notifications on per device from My day or My account.
- **Play Store app:** follow `mobile/README.md`, then set `ANDROID_APP_ID` and `ANDROID_CERT_SHA256` in the production vars so `/.well-known/assetlinks.json` vouches for the app.

### API for integrations

Settings → API keys creates keys such as `syn_acme_…`. Call `https://hrpsynapse.hrpai.in/api/v1/records/lead` with `Authorization: Bearer <key>`. The workspace is read from the key, and the key acts as the person it was created for. The **Developers** page has the workspace's OpenAPI file, the event list and webhooks.

## Branching and CI/CD

- **Pull requests** into `dev` or `prod`: type-check, RLS + API tests against Postgres 17, SPA build, Worker bundle, and a Neon `preview/pr-N` branch with migrations applied. The preview branch is deleted when the PR closes.
- **Push to `dev`**: CI, then migrate the Neon `dev` branch, then deploy `synapse-dev`.
- **Push to `prod`**: CI, then snapshot `main` to `backup/pre-deploy-<sha>`, migrate `main`, and deploy `synapse-prod`. Add required reviewers to the GitHub `production` environment to gate releases.

Repository secrets: `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repository variable: `NEON_PROJECT_ID` (printed by setup).

## Where to read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diagrams, request lifecycle, data model, metadata engine
- [docs/SECURITY.md](docs/SECURITY.md): tenant isolation layers, auth, RBAC/ABAC/FLS, AI data handling
- [docs/FREE-TIER.md](docs/FREE-TIER.md): current free-tier limits and how the platform stays inside them
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): setting up Gmail/Outlook, Razorpay, lead ads and Exotel
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built and what comes next
