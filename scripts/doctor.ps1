# AgentOS doctor — one-glance health + diagnosis of the whole local stack. Prints OK/FAIL per check with a
# FIX command when something is wrong, then a final verdict line: READY / DEGRADED / BLOCKED.
#   Usage:  powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'

$fails = 0      # BLOCKED-level (stack can't run)
$warns = 0      # DEGRADED-level (runs, but not at full quality)
function Ok($m)   { Write-Host ("  [OK]   " + $m) -ForegroundColor Green }
function Warn($m, $fix) { Write-Host ("  [WARN] " + $m) -ForegroundColor Yellow; if ($fix) { Write-Host ("         fix: " + $fix) -ForegroundColor DarkGray }; $script:warns++ }
function Fail($m, $fix) { Write-Host ("  [FAIL] " + $m) -ForegroundColor Red;    if ($fix) { Write-Host ("         fix: " + $fix) -ForegroundColor DarkGray }; $script:fails++ }
function Test-Port($p) { $null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1) }

Write-Host "`nAgentOS doctor`n==============" -ForegroundColor Cyan

# 1) toolchain
Write-Host "Toolchain:"
$node = (Get-Command node -ErrorAction SilentlyContinue); if ($node) { Ok ("node " + (node -v)) } else { Fail "node not found" "install Node.js 20+" }
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue); if ($pnpm) { Ok ("pnpm " + (pnpm -v)) } else { Fail "pnpm not found" "npm i -g pnpm" }

# 2) Docker engine + AgentOS infra
Write-Host "Infra (Docker):"
$dockerUp = $false
try { docker ps 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $dockerUp = $true } } catch {}
if (-not $dockerUp) {
  Fail "Docker engine unreachable" 'Start Docker Desktop. If it crash-loops (ghost sockets), see docs/HANDOFF + memory docker-ghost-sockets: rename %LOCALAPPDATA%\Docker\run + docker-secrets-engine, then relaunch.'
} else {
  Ok "Docker engine up"
  foreach ($c in @('agentos-postgres-1','agentos-redis-1','agentos-minio-1')) {
    $st = (docker inspect --format '{{.State.Status}}' $c 2>$null)
    if ($st -eq 'running') { Ok ("$c running") } else { Fail "$c not running ($st)" 'docker compose -f infra/compose.yaml up -d' }
  }
}

# 3) ports (DB 5432, agentos redis 6380, minio 9000)
Write-Host "Ports:"
foreach ($pp in @(@(5432,'postgres'), @(6380,'redis'), @(9000,'minio'))) {
  if (Test-Port $pp[0]) { Ok ("$($pp[1]) :$($pp[0]) listening") } else { Warn "$($pp[1]) :$($pp[0]) not listening" 'powershell -File scripts\up.ps1' }
}

# 4) .env + required keys
Write-Host "Config (.env):"
if (-not (Test-Path $envFile)) { Fail ".env missing" 'copy .env.example .env (then set DATABASE_URL/REDIS_URL/MASTER_ENCRYPTION_KEY)' }
else {
  $env = Get-Content $envFile -Raw
  foreach ($k in @('API_PORT','DATABASE_URL','REDIS_URL','MASTER_ENCRYPTION_KEY','LLM_MODE','EXECUTION_MODE')) {
    if ($env -match "(?m)^\s*$k\s*=") { Ok "$k set" } else { Warn "$k not set in .env" "add $k=..." }
  }
  if ($env -match '(?m)^\s*EXECUTION_MODE\s*=\s*inline') {
    Warn "EXECUTION_MODE=inline -> tasks are NOT durable (lost on crash) + automations never fire" "set EXECUTION_MODE=queue (the BullMQ worker is in-process in the API - just needs Redis, no separate process)"
  } elseif ($env -match '(?m)^\s*EXECUTION_MODE\s*=\s*queue') {
    Ok "EXECUTION_MODE=queue -> durable runtime (in-process worker + automations fire)"
    if ($env -notmatch '(?m)^\s*RESUME_ENABLED\s*=\s*true') { Warn "RESUME_ENABLED not true -> a recovered/stalled job restarts from scratch instead of its checkpoint" "add RESUME_ENABLED=true" }
    if ($env -notmatch '(?m)^\s*AUTOMATION_RUNS_ENABLED\s*=\s*true') { Warn "AUTOMATION_RUNS_ENABLED not true -> automation fires are legacy (no durable run history / overlap-skip / retry)" "add AUTOMATION_RUNS_ENABLED=true" }
  }
  if ($env -notmatch '(?m)^\s*ARTIFACT_PERSISTENCE_ENABLED\s*=\s*true') {
    Warn "ARTIFACT_PERSISTENCE_ENABLED not true -> deliverables are sandbox-only (no durable store, no version history/rollback)" "add ARTIFACT_PERSISTENCE_ENABLED=true (+ ARTIFACT_STORE_ROOT outside the sandbox)"
  } else { Ok "ARTIFACT_PERSISTENCE_ENABLED=true -> durable versioned artifacts" }
}

# 5) builds present
Write-Host "Builds:"
if (Test-Path (Join-Path $root 'services\api\dist\main.js')) { Ok "api/dist built" } else { Fail "api not built" 'pnpm --filter @agentos/api build' }
if (Test-Path (Join-Path $root 'apps\web\out\index.html')) { Ok "web/out built" } else { Fail "web not built" 'pnpm --filter @agentos/web build' }

# 6) Playwright Chromium (browser tools)
Write-Host "Browser:"
$pw = Join-Path $env:LOCALAPPDATA 'ms-playwright'
if ((Test-Path $pw) -and (Get-ChildItem $pw -Filter 'chromium-*' -ErrorAction SilentlyContinue)) { Ok "Playwright Chromium installed" } else { Warn "Chromium not installed -> browser tasks fail" 'pnpm --filter @agentos/tools exec playwright install chromium' }

# 7) live services
Write-Host "Services:"
try { $h = Invoke-RestMethod -Uri 'http://localhost:4000/health' -TimeoutSec 3; Ok ("API :4000 healthy (" + $h.service + ")") } catch { Warn "API :4000 down" 'powershell -File scripts\up.ps1' }
try { Invoke-WebRequest -Uri 'http://localhost:3000' -TimeoutSec 3 -UseBasicParsing | Out-Null; Ok "Web :3000 up" } catch { Warn "Web :3000 down" 'powershell -File scripts\up.ps1' }

# verdict
Write-Host ""
if ($fails -gt 0) { Write-Host "VERDICT: BLOCKED  ($fails blocking, $warns warnings) - fix the [FAIL] items above." -ForegroundColor Red; exit 2 }
elseif ($warns -gt 0) { Write-Host "VERDICT: DEGRADED ($warns warnings) - runs, but not at full quality. See [WARN] fixes." -ForegroundColor Yellow; exit 1 }
else { Write-Host "VERDICT: READY - open http://localhost:3000" -ForegroundColor Green; exit 0 }
