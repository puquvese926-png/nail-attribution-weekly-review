$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServerScript = Join-Path $Root "offsite-lark-sync-server.js"
$Dashboard = Join-Path $Root "index.html"
$Mysql2 = Join-Path $Root "node_modules\mysql2"

if (-not (Test-Path $Mysql2)) {
  Push-Location $Root
  try {
    npm install
  } finally {
    Pop-Location
  }
}

$existing = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -like "node*" -and $_.CommandLine -like "*offsite-lark-sync-server.js*"
}

if (-not $existing) {
  Start-Process -FilePath node -ArgumentList $ServerScript -WorkingDirectory $Root -WindowStyle Hidden
}

Start-Process $Dashboard
