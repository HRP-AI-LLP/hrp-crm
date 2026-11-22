# SanchalanOS

**The AI operating system for Indian businesses.** Sales, projects, people, accounts and GST in one multi-tenant platform by **HRP AI LLP**, live at **https://www.sanchalan.hrpai.in**.

It is built to run on free tiers (or close to it): Cloudflare Workers at the edge, Neon Postgres with Row Level Security, and Workers AI / Groq / Gemini for the AI features. See [docs/FREE-TIER.md](docs/FREE-TIER.md) for what keeps the bill near zero.

**Two environments:** *dev* runs on your computer (`pnpm local`, Postgres in a container); *prod* runs on Cloudflare + Neon and is deployed from the GitHub `main` branch. Work on the `dev` branch, test locally, merge into `main` to release.

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
  setup/provision.mjs     Idempotent Neon + Cloudflare provisioning and deployment of production (also VAPID push keys)
  setup/enable-r2.mjs     `pnpm setup:r2` — creates the R2 bucket and adds the FILES binding
  setup/import-local.mjs  `pnpm cloud:import` — copies your local database and files into production
  setup/migrate-prod.mjs  applies new migrations to production (used by the deploy workflow)
.github/workflows/        ci.yml (quick check of PRs into main), deploy.yml (push to main → production)
docs/                     Architecture, security model, free-tier budget, roadmap
```

## First-time setup (Windows, VS Code terminal)

1. Install **Node.js 22 LTS** and **Git**. If you want the script to set your GitHub Actions secrets for you, also install the GitHub CLI (`gh auth login`).
2. Make sure **hrpai.in** is a zone on your Cloudflare account, and that there are **no existing DNS records** for `www.sanchalan.hrpai.in` or `sanchalan.hrpai.in`. Setup attaches both hostnames to the Worker, and Cloudflare creates the DNS records and certificates itself (the two-level `www.sanchalan` host included — Workers Custom Domains issue their own certificate). `sanchalan.hrpai.in` redirects to `www`.
3. Create a Cloudflare API token (*My Profile → API Tokens → Create custom token*) with these permissions:
   - Account: **Workers Scripts – Edit**, **Workers KV Storage – Edit**, **Queues – Edit**, **Hyperdrive – Edit**, **Vectorize – Edit**, **Account Settings – Read**
   - Zone **hrpai.in**: **Zone – Read**, **DNS – Edit**, **Workers Routes – Edit**, **SSL and Certificates – Edit**, **Single Redirect – Edit** (for sanchalan.hrpai.in → www; without it setup tells you how to add the rule by hand)
   - Account: **Workers R2 Storage – Edit** too, if you will turn on file storage (`pnpm setup:r2`)
3. In the VS Code terminal, from this folder:

   ```powershell
   $env:NEON_API_KEY="napi_..."
   $env:CLOUDFLARE_API_TOKEN="..."
   $env:CLOUDFLARE_ACCOUNT_ID="..."
   # optional (these are the defaults)
   $env:ZONE_NAME="hrpai.in"
   $env:PROD_APP_HOST="www.sanchalan.hrpai.in"

   .\scripts\setup.ps1      # or: pnpm cloud:setup
   ```

   Note: `pnpm setup` (without `cloud:`) is pnpm's own command — it only edits your PATH.

The script is safe to re-run. It:

- uses (or creates) the Neon project `hrp-synapse` (Postgres 17, Singapore); its `main` branch is production, sized 0.25–1 CU and asleep after 5 idle minutes
- runs all migrations and creates the least-privilege runtime role `synapse_app` (NOBYPASSRLS)
- creates KV, a queue and its dead-letter queue, a Vectorize index and Hyperdrive (query cache **off**)
- renders `apps/api/wrangler.jsonc`, builds the SPA, and deploys the Worker `sanchalanos` at **https://www.sanchalan.hrpai.in**
- sets the Worker secrets and the GitHub repository secrets (if `gh` is logged in)
- with `$env:REMOVE_OLD="true"`: deletes what the earlier two-cloud-environment setup made (Neon branch `dev`, `synapse-dev` Hyperdrive/KV/queues/Worker, and the old `synapse-prod` Worker)

API keys for AI, mail, Google, Microsoft, Zoom, GitHub and the rest are not environment variables any more: set them in the app under **Settings → Connection keys** (each has a step-by-step guide).

Generated passwords and keys are written to `infra/.local/secrets.json`, which is git-ignored and never printed.

### Moving your local data to production

After setup, copy everything from your computer (workspaces, people, records, settings, connection keys, and uploaded files when R2 is on) into production:

```powershell
pnpm local --no-build      # only if the local database isn't running; stop it with Ctrl+C once it's up
pnpm cloud:import          # add --replace if production already has workspaces
```

People sign in at https://www.sanchalan.hrpai.in with the same workspace ID, email and password. Production takes over your local encryption key so saved secrets keep working (the previous one is kept in `infra/.local/secrets.json`).

> **Execution policy:** if PowerShell blocks the script, run `Set-ExecutionPolicy -Scope Process Bypass` in the same terminal first.

## Day-to-day

| Command | What it does |
|---|---|
| `pnpm local` | **Run everything on this computer, no cloud.** Starts Postgres 17 in Podman (or Docker) — container `synapse-pg`, volume `synapse-pgdata`, 127.0.0.1:54329 — applies migrations, creates a `demo` workspace once (admin@demo.local; password in `infra/.local/local.json`), writes `.dev.vars`, builds the app and starts the API on http://localhost:8787 and Vite on http://localhost:5173 with `apps/api/wrangler.local.jsonc` (no remote bindings). Files, cache and queue are simulated by wrangler; AI uses `GROQ_API_KEY` / `GEMINI_API_KEY` if set, otherwise rule-based fallbacks. On Windows it starts the Podman machine if needed. Flags: `--no-migrate`, `--no-build`, `--reset-db`; `CONTAINER_ENGINE=docker` to prefer Docker |
| `pnpm local:stop` | Stops a running `pnpm local`; `--db` also stops the local database container (data is kept) |
| `pnpm local:admin` | Lists workspaces and their people; `reset <workspace> <email>` sets a new password; `platform <workspace> <email>` makes a platform admin. Add `--cloud` for production |
| `pnpm cloud:import` | Copies the local database and files into production (see above) |
| `pnpm local:test` | Runs the test suites against a throwaway Postgres container (`synapse-pg-test`, 127.0.0.1:54330, in memory), separate from your local database |
| `pnpm dev` | Vite on http://localhost:5173 plus the Worker on :8787 (uses the `apps/api/.dev.vars` that `pnpm local` wrote) |
| `pnpm test` | RLS isolation tests and API end-to-end tests against the Postgres in `TEST_ADMIN_DATABASE_URL` (or use `pnpm local:test`) |
| `pnpm db:migrate` | Apply migrations (`DATABASE_URL_OWNER` required) |
| `pnpm typecheck` | Type-check every package |
| `pnpm deploy:prod` | Manual deploy of production (normally a push to `main` does it) |

## Workspace addresses

| Where | How the workspace is chosen |
|---|---|
| `https://www.sanchalan.hrpai.in` (production), `http://localhost:5173` (your computer) | The user types the workspace ID at sign-in, e.g. `acme`. A link like `/login?workspace=acme` pre-fills it. |
| `https://acme.sanchalan.hrpai.in` (optional) | From the hostname. Each workspace host is attached as a Workers Custom Domain with its own free certificate (Cloudflare's free certificate covers only one subdomain level, so a wildcard can't be used). To turn this on, set `$env:CF_TENANT_DOMAINS_TOKEN` (a token with the same zone permissions as above plus Workers Scripts – Edit) and re-run setup. Admins then use Settings → Domains. |
| `https://crm.customer.com` | A customer's own domain through Cloudflare for SaaS (Settings → Domains; needs `CF_ZONE_ID` and `CF_SAAS_API_TOKEN`). |

Locally, sign in with workspace **demo** (or your own workspaces).

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
| Workspace assistant | The ✦ button on every page (Ctrl+J) and the **Assistant** page: ask about anything you can see, or ask it to do the work — tasks, backlogs, sprints, releases, milestones, gantt dates, timesheets, leads, quotes, invoices, any module. It reads through the same API as you, and every change waits as a card you approve, edit or reject; approved changes run as you, with your permissions and the audit trail. It finds the right call in a catalogue of every route (`apps/api/src/services/assistant-catalogue.generated.ts`; run `pnpm --filter @synapse/api catalogue` after changing routes — a test fails if it is stale). Needs an AI model (Settings → AI models). |
| Coding agent (MCP) | Claude Code or Codex works the project backlog: new and changed stories, tasks and bugs queue for it; it claims an item over MCP (`/api/v1/mcp`), clones or creates the project locally, implements and tests on a branch, and asks for review; a person approves in Project → Coding agent before it commits, pushes, opens the pull request and releases — see [docs/CODING-AGENT.md](docs/CODING-AGENT.md) and `scripts/agent/sanchalan-agent.mjs` |
| AI delivery (SDLC agents) | A goal is planned into steps by specialist agents (business analyst, product owner, architect, UX, security, QA, DevOps, writer, project manager, developer): BRD / PRD / SRS / HLD / LLD / API spec / DB design / threat model / test plan / runbook / user manual / SOW and more, with their diagrams; backlog and test cases created on approval; stories handed to the coding agent. Diagrams of every kind (architecture, data flow, ER, sequence, user journey, block, network, deployment, C4, class, state, swimlane, use case, mind map, gantt, timeline…) in Mermaid and editable draw.io, downloadable as PNG / JPG / SVG; documents as Word / PDF / HTML / Markdown — see [docs/AI-DELIVERY.md](docs/AI-DELIVERY.md) |
| Revenue intelligence | **Copilot** workspace (today's meetings with brief/debrief status, "do these first", action items, insights feed); 11 agents that cite their sources — account research, outreach, meeting prep and debrief (notes, transcripts or recordings), call debrief, deal risk, competitive coach, account health, growth opportunities, my focus, pipeline review; AI-suggested field updates applied only with approval; competitors and battlecards; Ask SanchalanOS across the CRM — see [docs/INTELLIGENCE.md](docs/INTELLIGENCE.md) |
| Leads | Sources incl. walk-in, WhatsApp, Instagram, referral, architect, dealer, campaign; assignment rules (round-robin / least-loaded), scoring rules, follow-up reminders, lead aging and source conversion |
| Quotations | Revisions with history, discount approval rules, PDF/print, customer accept links, convert to order |
| Apps (switch on per workspace) | **Orders** (milestones, advances, reservations), **Inventory** (SKUs, categories, variants, warehouses, in/out/adjust/transfer, reorder alerts, opening stock import), **Purchasing** (vendors, POs, goods receipts), **Delivery & installation** (dispatch, crews, checklists, customer sign-off with signature), **Service desk** (tickets, SLA policies, CSAT, customer status page), **GST billing** (tax invoices, credit notes, receipts, receivables, e-invoice JSON, GSTR-1 CSV, Tally XML) |
| Deals & recurring billing | One-time and recurring charges on deals; a won deal sets up its project, first invoice and recurring invoices; prices including GST; payment terms; price changes from a date; organisation profile; saved signatures with a public check — see [docs/DEALS-BILLING.md](docs/DEALS-BILLING.md) |
| Books (accounting) | Double-entry ledger posted automatically from invoices, receipts, bills, vendor payments and expenses; chart of accounts, manual journals, opening balances, lock date; vendor bills and credits with TDS, reverse charge and ITC; expenses and employee claims with approval; bank statement import, rules, matching and reconciliation; P&L, balance sheet, cash flow, trial balance, ledgers, day book, GSTR-3B, GSTR-2B matching, TDS; budgets, fixed assets and depreciation, recurring transactions, multi-currency. SanchalanOS or Tally as the books of record — see [docs/BOOKS.md](docs/BOOKS.md) |
| Projects & timesheets | Projects with team rates, milestones, task lists, sub-tasks and dependencies; list, board and Gantt views; issues and comments; timers and weekly timesheets with manager approval; billing of approved time, milestones and expenses to GST invoices; budgets, profitability, utilisation; projects as templates — see [docs/PROJECTS.md](docs/PROJECTS.md) |
| Manufacturing | Multi-level bills of materials with routings, scrap, yield, by-products and versions; work centres and capacity; work orders (release, issue, operations, output, close) costed through WIP into the books; make-to-order reservations; batches with expiry, FEFO and full traceability; incoming, in-process and final quality checks; job work under GST delivery challans with ITC-04; MRP that suggests and raises purchase and work orders — see [docs/MANUFACTURING.md](docs/MANUFACTURING.md) |
| Government contracts | GeM / tender bids on deals; EMD, performance security (ePBG, bank guarantee, FDR) and retention register with expiry reminders, release and forfeiture, posted to the books; contract number on invoices; milestone acceptance (CRAC); receipts net of TDS, GST TDS, liquidated damages and retention — see [docs/GOVERNMENT.md](docs/GOVERNMENT.md) |
| GST portal (GSP) | Through gstinapi.in (credits; paid answers kept in the database and refreshed on request), India Compliance or WhiteBooks: connect a GSTIN by OTP; filing calendar; cash, ITC and liability ledgers, notices and challans; GSTR-1, GSTR-3B (with offset), ITC-04, GSTR-2X, GSTR-9 and more saved and filed with EVC or DSC; GSTR-2B into reconciliation; e-invoice IRN with signed QR and e-way bills from the invoice — see [docs/GST-PORTAL.md](docs/GST-PORTAL.md) |
| Accounts desk | Agents that keep the books with you approving: bank clerk (statement uploads in CSV / Excel, RazorpayX feed, Razorpay settlements), bookkeeper (matches, receipts against invoices incl. TDS, bill payments, settlements net of fee and GST, categories from rules, history, narrations and AI), compliance clerk (GSTR-2B, TDS, GST returns due) and controller (month-end checklist, P&L, balance sheet, note) — see [docs/ACCOUNTS-DESK.md](docs/ACCOUNTS-DESK.md) |
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

Without email, admins get a link to share. To send them by email, create a free [Resend](https://resend.com) account, verify `hrpai.in` there, and paste the key in **Settings → Connection keys → Email**.

The sender is `MAIL_FROM` in `wrangler.jsonc` (default `SanchalanOS <no-reply@hrpai.in>`).

### File storage, backups and push (one-time switches)

- **R2 (attachments, signatures, backups):** enable R2 once in the Cloudflare dashboard (R2 Object Storage → Get started), then run `pnpm setup:r2` and deploy. Until then the app works without uploads.
- **Backups:** nightly workspace backups are **off** (Settings → Connection keys → Options → "Nightly backups" turns them on); "Back up now" still works once R2 is on. Deploys take no database snapshot.
- **Push notifications:** `pnpm cloud:setup` generates a VAPID key pair and stores it as Worker secrets. Nothing else to do; people turn notifications on per device from My day or My account.
- **Play Store app:** follow `mobile/README.md`, then set `ANDROID_APP_ID` and `ANDROID_CERT_SHA256` in the production vars so `/.well-known/assetlinks.json` vouches for the app.

### API for integrations

Settings → API keys creates keys such as `syn_acme_…`. Call `https://www.sanchalan.hrpai.in/api/v1/records/lead` with `Authorization: Bearer <key>`. The workspace is read from the key, and the key acts as the person it was created for. The **Developers** page has the workspace's OpenAPI file, the event list and webhooks.

## Branching and CI/CD

Two branches, kept cheap on GitHub Actions minutes:

- **`dev`**: everyday work. Pushing it runs **nothing** — you test on your computer (`pnpm local`, `pnpm local:test`).
- **Pull request `dev` → `main`**: a quick check (type-check, SPA build, Worker bundle) in about 2–3 minutes. The full database and API test suites run on your computer; to run them on GitHub, start the *Check* workflow by hand with **full tests**.
- **Push to `main`**: type-check, build, apply new migrations to Neon, deploy the Worker — about 3–4 minutes. Pushes that change only docs, the mobile shells or local tools don't deploy. You can also merge locally and push `main` directly.

Add required reviewers to the GitHub `production` environment if you want to approve each release.

Repository secrets: `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repository variable: `NEON_PROJECT_ID` (printed by setup).

## Where to read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diagrams, request lifecycle, data model, metadata engine
- [docs/SECURITY.md](docs/SECURITY.md): tenant isolation layers, auth, RBAC/ABAC/FLS, AI data handling
- [docs/FREE-TIER.md](docs/FREE-TIER.md): current free-tier limits and how the platform stays inside them
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md): setting up Gmail/Outlook, Razorpay, lead ads and Exotel
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built and what comes next
