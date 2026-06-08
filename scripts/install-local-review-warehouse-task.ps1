param(
  [string]$At = "09:00",
  [string]$FridayAt = "",
  [string]$TaskName = "WeeklyReviewDashboard_LocalWarehouseSync"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $scriptDir "run-local-review-warehouse-sync.ps1"

if (-not (Test-Path $runnerPath)) {
  throw "未找到任务执行脚本：$runnerPath"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = @(
  New-ScheduledTaskTrigger -Daily -At $At
)
if ($FridayAt) {
  $trigger += New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Friday -At $FridayAt
}
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Sync warehouse post data into local SQLite cache for DataGrip." -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
