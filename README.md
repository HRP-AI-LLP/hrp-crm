# HRP Synapse

Multi-tenant, metadata-driven CRM by **HRP AI LLP**. It runs on free tiers: Cloudflare Workers at the edge, Neon Postgres with Row Level Security, and Workers AI / Groq / Gemini for the AI features.

```
apps/
  api/        Edge gateway Worker (Hono): tenant routing, auth, RBAC/ABAC/FLS, CRM API,
              queue consumer, cron. Also serves the SPA through Workers Static Assets.
  web/        React 19 + Vite SPA (dashboard, records, pipeline board, tasks, knowledge base, settings)
packages/
  db/         SQL migrations (RLS, audit, EAV index, platform functions), runner, seed, RLS tests
  shared/     Field types and validation, standard objects, permission engine, industry modules
scripts/
  setup.ps1               Windows entry point for first-time setup
  setup/provision.mjs     Idempotent Neon + Cloudflare provisioning and deployment
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
| `pnpm dev` | Vite on http://localhost:5173 plus the Worker on :8787 (uses `apps/api/.dev.vars`, which points at the Neon dev branch) |
| `pnpm test` | RLS isolation tests and API end-to-end tests. They need a local Postgres; set `TEST_ADMIN_DATABASE_URL` |
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

## Branching and CI/CD

- **Pull requests** into `dev` or `prod`: type-check, RLS + API tests against Postgres 17, SPA build, Worker bundle, and a Neon `preview/pr-N` branch with migrations applied. The preview branch is deleted when the PR closes.
- **Push to `dev`**: CI, then migrate the Neon `dev` branch, then deploy `synapse-dev`.
- **Push to `prod`**: CI, then snapshot `main` to `backup/pre-deploy-<sha>`, migrate `main`, and deploy `synapse-prod`. Add required reviewers to the GitHub `production` environment to gate releases.

Repository secrets: `NEON_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Repository variable: `NEON_PROJECT_ID` (printed by setup).

## Where to read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): diagrams, request lifecycle, data model, metadata engine
- [docs/SECURITY.md](docs/SECURITY.md): tenant isolation layers, auth, RBAC/ABAC/FLS, AI data handling
- [docs/FREE-TIER.md](docs/FREE-TIER.md): current free-tier limits and how the platform stays inside them
- [docs/ROADMAP.md](docs/ROADMAP.md): what is built and what comes next
