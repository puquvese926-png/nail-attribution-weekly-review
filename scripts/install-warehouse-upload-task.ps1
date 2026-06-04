param(
  [string]$TaskName = "WeeklyDashboardWarehouseUpload",
  [string]$At = "08:30",
  [int]$Days = 14,
  [switch]$Full
)

$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Script = Join-Path $Root "scripts\upload-warehouse-cache.js"
$EnvFile = Join-Path $Root ".env.local"

if (-not (Test-Path $EnvFile)) {
  throw "Missing $EnvFile. Copy .env.local.example to .env.local and fill the values before installing the task."
}

$Arguments = if ($Full) { "`"$Script`" --full" } else { "`"$Script`" --incremental --days $Days" }
$Action = New-ScheduledTaskAction -Execute $Node -Argument $Arguments -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($At, "HH:mm", $null))
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Upload weekly dashboard warehouse cache to Netlify Blobs" -Force | Out-Null
Write-Host "Scheduled task installed: $TaskName at $At"
