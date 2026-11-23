<#
.SYNOPSIS
  Build a client installer and ship it: upload to Google Drive, share with the recipient, and send the
  link on WhatsApp — in one command, on the Windows build machine.

.DESCRIPTION
  The installer is built and signed here (it cannot be built in the cloud). This script then talks to
  SanchalanOS, which holds the Google Drive and WhatsApp connections, to upload the build straight to
  Drive, set who can open it, and message the recipient. Nothing but this machine needs Google
  credentials — SanchalanOS uses the account you connected in the app.

  The release channel (Google account, folder, recipient, and whether the build carries client data) is
  configured once in SanchalanOS under the release. This script just needs the release version and the
  channel id (both shown in the release's "Run on your machine" box).

.PARAMETER Version
  The release version, e.g. 1.1.0.

.PARAMETER ChannelId
  The Google Drive channel id from the release (SanchalanOS → the release → Run on your machine).

.PARAMETER SkipDatabase
  Build without bundling the member database (a small, data-free installer that may be shared publicly).
  Omit it to build the full installer with the database (shared only with the recipient).

.PARAMETER Installer
  Optional explicit path to an already-built installer. If given, the build step is skipped.

.ENVIRONMENT
  SANCHALAN_URL   e.g. https://www.sanchalan.hrpai.in
  SANCHALAN_KEY   your project's coding-agent key (SanchalanOS → the project → Coding agent → keys)

.EXAMPLE
  $env:SANCHALAN_URL = "https://www.sanchalan.hrpai.in"
  $env:SANCHALAN_KEY = "syn_..."
  pwsh ./scripts/Publish-Release.ps1 -Version 1.1.0 -ChannelId 7f1e...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$ChannelId,
  [switch]$SkipDatabase,
  [string]$Installer,
  [string]$BuildScript = "./scripts/Build-ClientPackage.ps1"
)

$ErrorActionPreference = "Stop"

$BaseUrl = $env:SANCHALAN_URL
$ApiKey  = $env:SANCHALAN_KEY
if (-not $BaseUrl -or -not $ApiKey) { throw "Set SANCHALAN_URL and SANCHALAN_KEY in the environment first (see the release's 'Run on your machine' box)." }
$BaseUrl = $BaseUrl.TrimEnd("/")

function Invoke-Mcp {
  param([string]$Name, [hashtable]$Arguments)
  $body = @{ jsonrpc = "2.0"; id = 1; method = "tools/call"; params = @{ name = $Name; arguments = $Arguments } } | ConvertTo-Json -Depth 8
  $res = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/mcp" -Headers @{ Authorization = "Bearer $ApiKey" } -ContentType "application/json" -Body $body
  if ($res.error) { throw "SanchalanOS: $($res.error.message)" }
  $content = $res.result.structuredContent
  if ($content -and $content.isError) { throw "SanchalanOS: $($content.message)" }
  # a tool error is returned as text content
  if ($res.result.isError) { throw "SanchalanOS: $($res.result.content[0].text)" }
  return $content
}

# 1. Build the installer (unless one was given)
if (-not $Installer) {
  Write-Host "==> Building the installer$([bool]$SkipDatabase ? ' (without the database)' : ' (with the database)')..." -ForegroundColor Cyan
  if (-not (Test-Path $BuildScript)) { throw "Build script not found at $BuildScript. Pass -Installer <path> or -BuildScript <path>." }
  $buildArgs = @{}
  if ($SkipDatabase) { $buildArgs["SkipDatabase"] = $true }
  & $BuildScript @buildArgs
  # the newest installer produced
  $Installer = Get-ChildItem -Path "." -Recurse -Include *.exe, *.msi |
    Where-Object { $_.Name -match [regex]::Escape($Version) -or $_.Name -match "setup|install" } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  if (-not $Installer) { throw "Build finished but no installer (.exe/.msi) was found. Pass -Installer <path>." }
}
if (-not (Test-Path $Installer)) { throw "Installer not found: $Installer" }
$fileName = Split-Path $Installer -Leaf
$sizeMB = [math]::Round((Get-Item $Installer).Length / 1MB, 1)
Write-Host "==> Installer: $fileName ($sizeMB MB)" -ForegroundColor Green

# 2. Ask SanchalanOS for a direct-to-Drive upload URL (the file never passes through the app)
Write-Host "==> Starting the upload to Google Drive..." -ForegroundColor Cyan
$session = Invoke-Mcp -Name "release_upload_url" -Arguments @{ channelId = $ChannelId; fileName = $fileName }
$uploadUrl = $session.uploadUrl
if (-not $uploadUrl) { throw "Could not start the Drive upload. Check the channel has a Google account set." }

# 3. Upload the bytes straight to Google (handles any size)
Write-Host "==> Uploading $sizeMB MB to Google Drive..." -ForegroundColor Cyan
$uploaded = Invoke-RestMethod -Method Put -Uri $uploadUrl -InFile $Installer -ContentType "application/octet-stream"
$driveFileId = $uploaded.id
if (-not $driveFileId) { throw "Upload finished but Google did not return a file id." }
Write-Host "==> Uploaded (Drive file $driveFileId)" -ForegroundColor Green

# 4. Share it with the recipient and WhatsApp them the link
Write-Host "==> Sharing and sending the link on WhatsApp..." -ForegroundColor Cyan
$done = Invoke-Mcp -Name "release_publish" -Arguments @{ channelId = $ChannelId; driveFileId = $driveFileId }
Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  Link:        $($done.link)"
Write-Host "  Shared with: $($done.sharedWith)"
Write-Host "  WhatsApp:    $($done.whatsapp)"
if ($done.whatsappError) { Write-Warning "WhatsApp: $($done.whatsappError)" }
