# AgentOS up — ONE command to bring the whole local stack up: infra (Postgres/Redis/MinIO) + API + web,
# then a health check + the doctor verdict. Idempotent: skips anything already running.
#   Usage:  powershell -ExecutionPolicy Bypass -File scripts\up.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
function Listening($p) { $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) }

Write-Host "AgentOS up`n=========" -ForegroundColor Cyan

# 1) Docker + infra
docker ps 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Docker engine is down. Start Docker Desktop, then re-run. (If it crash-loops: scripts\doctor.ps1 prints the ghost-socket fix.)" -ForegroundColor Red
  exit 2
}
Write-Host "Starting infra (Postgres/Redis/MinIO)..."
docker compose -f infra/compose.yaml up -d 2>&1 | Out-Null
for ($i = 0; $i -lt 30; $i++) { if ((docker inspect --format '{{.State.Health.Status}}' agentos-postgres-1 2>$null) -eq 'healthy') { break }; Start-Sleep 2 }
Write-Host "  infra up."

# 2) load .env into this process (the API + serve children inherit it)
if (-not (Test-Path (Join-Path $root '.env'))) { Write-Host ".env missing — see scripts\doctor.ps1" -ForegroundColor Red; exit 2 }
Get-Content (Join-Path $root '.env') | ForEach-Object {
  $l = $_.Trim(); if ($l -and -not $l.StartsWith('#')) { $i = $l.IndexOf('='); if ($i -ge 1) { Set-Item -Path "Env:$($l.Substring(0,$i).Trim())" -Value $l.Substring($i + 1).Trim() } }
}

# 3) builds present?
if (-not (Test-Path (Join-Path $root 'services\api\dist\main.js'))) { Write-Host "api not built — running build..." ; pnpm --filter @agentos/api build | Out-Null }
if (-not (Test-Path (Join-Path $root 'apps\web\out\index.html')))   { Write-Host "web not built — running build..." ; pnpm --filter @agentos/web build | Out-Null }

# 4) API (:4000) — start in its own window if not already up
if (Listening 4000) { Write-Host "  API already on :4000." } else {
  Write-Host "Starting API on :$($env:API_PORT)..."
  Start-Process node -ArgumentList 'services/api/dist/main.js' -WorkingDirectory $root -WindowStyle Minimized
}
# 5) Web (:3000)
if (Listening 3000) { Write-Host "  Web already on :3000." } else {
  Write-Host "Starting web on :3000..."
  Start-Process node -ArgumentList 'scripts/serve-web.cjs', 'apps/web/out', '3000' -WorkingDirectory $root -WindowStyle Minimized
}

# 6) wait for health
$apiOk = $false
for ($i = 0; $i -lt 15; $i++) { try { Invoke-RestMethod -Uri 'http://localhost:4000/health' -TimeoutSec 2 | Out-Null; $apiOk = $true; break } catch { Start-Sleep 2 } }
$webOk = $false
for ($i = 0; $i -lt 8; $i++) { try { Invoke-WebRequest -Uri 'http://localhost:3000' -TimeoutSec 2 -UseBasicParsing | Out-Null; $webOk = $true; break } catch { Start-Sleep 1 } }

Write-Host ""
Write-Host ("  API  : " + $(if ($apiOk) { 'UP   http://localhost:4000' } else { 'not ready yet' })) -ForegroundColor $(if ($apiOk) { 'Green' } else { 'Yellow' })
Write-Host ("  Web  : " + $(if ($webOk) { 'UP   http://localhost:3000' } else { 'not ready yet' })) -ForegroundColor $(if ($webOk) { 'Green' } else { 'Yellow' })
Write-Host "`nRunning doctor for the full verdict...`n" -ForegroundColor DarkGray
& (Join-Path $PSScriptRoot 'doctor.ps1')
