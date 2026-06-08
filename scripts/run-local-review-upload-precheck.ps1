$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectDir = Split-Path -Parent $scriptDir
$logDir = Join-Path "C:\Users\HP\DataGripProjects" "weekly_review_cache_logs"
$logPath = Join-Path $logDir "pre-upload-validation.log"
$reportPath = Join-Path $logDir "pre-upload-validation-latest.json"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Push-Location $projectDir
try {
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Encoding utf8 -Value "[$timestamp] start pre-upload validation"
  node --no-warnings .\scripts\validate-local-review-upload.js --report-path $reportPath 2>&1 | Out-File -FilePath $logPath -Encoding utf8 -Append
  if ($LASTEXITCODE -ne 0) {
    throw "pre-upload validation failed with exit code $LASTEXITCODE"
  }
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logPath -Encoding utf8 -Value "[$timestamp] completed pre-upload validation"
} finally {
  Pop-Location
}
