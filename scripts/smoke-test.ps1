# End-to-end smoke test against a running API (default :4000).
# Registers a user, creates a workspace, runs a task, polls to terminal, prints events.
$ErrorActionPreference = "Stop"
$base = "http://localhost:4000"
function Body($e) { if ($e.Exception.Response) { try { $sr = New-Object IO.StreamReader($e.Exception.Response.GetResponseStream()); $sr.ReadToEnd() } catch { $e.Exception.Message } } else { $e.Exception.Message } }

$rand = Get-Random -Maximum 999999
$email = "smoke$rand@local.test"
Write-Host "1) register $email"
$reg = Invoke-RestMethod -Uri "$base/auth/register" -Method Post -ContentType "application/json" -SessionVariable sess -Body (@{ email=$email; password="password123"; displayName="Smoke Tester" } | ConvertTo-Json)
Write-Host "   user id: $($reg.user.id)"

Write-Host "2) create workspace"
$ws = Invoke-RestMethod -Uri "$base/workspaces" -Method Post -ContentType "application/json" -WebSession $sess -Body (@{ name="Smoke WS"; slug="smoke-$rand" } | ConvertTo-Json)
$wsId = $ws.id
Write-Host "   workspace id: $wsId"

Write-Host "3) create task"
$task = Invoke-RestMethod -Uri "$base/workspaces/$wsId/tasks" -Method Post -ContentType "application/json" -WebSession $sess -Body (@{ title="Smoke task"; prompt="Say hello and give a one-sentence summary of what you can do." } | ConvertTo-Json)
$taskId = $task.id
Write-Host "   task id: $taskId  status: $($task.status)"

Write-Host "4) poll task to terminal..."
$terminal = @("completed","failed","cancelled")
$status = $task.status
for ($i=1; $i -le 40; $i++) {
  Start-Sleep 2
  $t = Invoke-RestMethod -Uri "$base/workspaces/$wsId/tasks/$taskId" -WebSession $sess
  if ($t.status -ne $status) { Write-Host "   ~$($i*2)s status: $($t.status)"; $status = $t.status }
  if ($terminal -contains $t.status -or $t.status -eq "waiting_for_approval") { break }
}
Write-Host "   FINAL status: $status"
if ($t.result) { Write-Host "   result: $($t.result | ConvertTo-Json -Compress)" }

Write-Host "5) events:"
try {
  $ev = Invoke-RestMethod -Uri "$base/workspaces/$wsId/tasks/$taskId/events" -WebSession $sess
  $list = if ($ev.events) { $ev.events } else { $ev }
  foreach ($e in $list) { Write-Host ("   [{0}] {1} {2}" -f $e.seq, $e.type, (($e | ConvertTo-Json -Compress -Depth 4))) }
} catch { Write-Host "   events fetch failed: $(Body $_)" }
