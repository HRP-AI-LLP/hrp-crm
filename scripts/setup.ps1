<#
  HRP Synapse - first-time setup for Windows (PowerShell 5.1+ / 7+).

  Run from the repository root in the VS Code terminal AFTER setting:
     $env:NEON_API_KEY="napi_..."
     $env:CLOUDFLARE_API_TOKEN="..."
     $env:CLOUDFLARE_ACCOUNT_ID="..."
  Optional:
     $env:ZONE_NAME="hrpai.in"            # defaults: hrpsynapse-dev.hrpai.in (dev), hrpsynapse.hrpai.in (prod)
     $env:GROQ_API_KEY="..."; $env:GEMINI_API_KEY="..."

  Then:  .\scripts\setup.ps1
#>
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($msg) { Write-Host "`n$msg" -ForegroundColor Red; exit 1 }

foreach ($v in 'NEON_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID') {
  if (-not [Environment]::GetEnvironmentVariable($v)) { Fail "Set `$env:$v first (see the comment at the top of this script)." }
}

# Node 22+
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail 'Node.js 22+ is required: https://nodejs.org/en/download (LTS), then reopen VS Code.' }
$major = [int]((node -v).TrimStart('v').Split('.')[0])
if ($major -lt 22) { Fail "Node.js 22+ is required (found $(node -v))." }

# pnpm via corepack (ships with Node)
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  Write-Host 'Enabling pnpm through corepack...'
  corepack enable 2>$null
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { npm install -g pnpm@10 | Out-Null }
}

# git repository (CI/CD expects dev + prod branches)
if (-not (Test-Path .git)) {
  git init -b main | Out-Null
  Write-Host 'Initialised a git repository.'
}

Write-Host "`nInstalling dependencies..." -ForegroundColor Cyan
pnpm install
if ($LASTEXITCODE -ne 0) { Fail 'pnpm install failed.' }

Write-Host "`nProvisioning Neon + Cloudflare and deploying..." -ForegroundColor Cyan
node scripts/setup/provision.mjs
if ($LASTEXITCODE -ne 0) { Fail 'Provisioning failed. Fix the error above and run this script again (it is safe to re-run).' }

Write-Host "`nAll set. Next: commit, create the dev and prod branches, and push:" -ForegroundColor Green
Write-Host '  git add -A; git commit -m "HRP Synapse bootstrap"'
Write-Host '  git branch dev; git branch prod'
Write-Host '  git remote add origin https://github.com/<you>/hrp-crm.git'
Write-Host '  git push -u origin main dev prod'
