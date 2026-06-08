param(
  [string]$At = "20:00",
  [string]$TaskName = "WeeklyReviewDashboard_LocalNetlifyUpload"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$runnerPath = Join-Path $scriptDir "run-local-review-netlify-upload.ps1"

if (-not (Test-Path $runnerPath)) {
  throw "未找到任务执行脚本：$runnerPath"
}

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Friday -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Upload validated local SQLite dashboard cache to Netlify." -Force | Out-Null
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
