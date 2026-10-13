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
2. Create a Cloudflare API token (*My Profile → API Tokens → Create custom token*) with these permissions:
   - Account: **Workers Scripts – Edit**, **Workers KV Storage – Edit**, **Queues – Edit**, **Hyperdrive – Edit**, **Vectorize – Edit**, **Account Settings – Read**
   - Zone (only if you have a domain on Cloudflare): **Zone – Read**, **Workers Routes – Edit**
3. In the VS Code terminal, from this folder:

   ```powershell
   $env:NEON_API_KEY="napi_..."
   $env:CLOUDFLARE_API_TOKEN="..."
   $env:CLOUDFLARE_ACCOUNT_ID="..."
   # optional
   $env:BASE_DOMAIN="hrpsynapse.com"      # only if this zone is on your Cloudflare account
   $env:GROQ_API_KEY="..."                # extra AI fallback
   $env:GEMINI_API_KEY="..."              # receives PII-free prompts only (see docs/SECURITY.md)

   .\scripts\setup.ps1
   ```

The script is safe to re-run. It:

- creates the Neon project `hrp-synapse` (Postgres 17, Singapore) with the `main` branch for prod and a `dev` branch
- runs all migrations and creates the least-privilege runtime role `synapse_app` (NOBYPASSRLS)
- creates KV, Queues and a dead-letter queue, a Vectorize index and Hyperdrive (query cache **off**) for both environments
- renders `apps/api/wrangler.jsonc`, builds the SPA, and deploys `synapse-dev` and `synapse-prod`
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

On localhost and workers.dev, sign in with workspace **demo**. The SPA then sends `X-Tenant: demo`, which the API accepts only outside production. In production, the workspace comes from the hostname (`acme.hrpsynapse.com` or a verified custom domain).

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
