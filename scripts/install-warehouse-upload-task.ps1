param(
  [string]$At = "20:00",
  [string]$TaskName = "WeeklyReviewDashboard_LocalNetlifyUpload"
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installerPath = Join-Path $scriptDir "install-local-review-netlify-upload-task.ps1"

if (-not (Test-Path $installerPath)) {
  throw "未找到新版上传任务安装脚本：$installerPath"
}

& $installerPath -At $At -TaskName $TaskName
