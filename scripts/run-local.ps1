# Loads .env (repo root) into the process environment and starts the AgentOS API.
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1
# The API reads config from process.env (no dotenv), so we inject .env here.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if ($line -eq "" -or $line.StartsWith("#")) { return }
  $idx = $line.IndexOf("=")
  if ($idx -lt 1) { return }
  $key = $line.Substring(0, $idx).Trim()
  $val = $line.Substring($idx + 1).Trim()
  Set-Item -Path "Env:$key" -Value $val
}

Write-Host "Starting AgentOS API on port $($env:API_PORT) (LLM_MODE=$($env:LLM_MODE), EXECUTION_MODE=$($env:EXECUTION_MODE))"
Set-Location $root
node services/api/dist/main.js
