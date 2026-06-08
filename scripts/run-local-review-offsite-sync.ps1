$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$logDir = Join-Path "C:\Users\HP\DataGripProjects" "weekly_review_cache_logs"
$logPath = Join-Path $logDir "weekly-offsite-sync.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Push-Location $projectDir
try {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Encoding utf8 -Value "[$timestamp] start offsite-only full sync"
  node --no-warnings .\scripts\sync-local-review-db.js --full --offsite-only 2>&1 | Out-File -FilePath $logPath -Encoding utf8 -Append
  if ($LASTEXITCODE -ne 0) {
    throw "offsite-only full sync failed with exit code $LASTEXITCODE"
  }
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Encoding utf8 -Value "[$timestamp] completed offsite-only full sync"
} finally {
  Pop-Location
}
