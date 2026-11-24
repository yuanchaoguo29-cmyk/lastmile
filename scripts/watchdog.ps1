# Keep the local app alive.
#
#   one check:    powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1
#   keep looping: powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1 -Loop
#
# If port 3000 stops answering, this restarts `node server/index.js`.
# It does nothing about networking or tunnels - that is a deployment concern,
# see the README. Once the app is reachable from the outside, use your own
# tunnel / reverse proxy and make sure PUBLIC_BASE_URL is set.
#
# ASCII ONLY (Windows PowerShell 5.1 reads .ps1 in the ANSI codepage).

param(
  [switch]$Loop,
  [int]$IntervalSec = 60
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$pidFile = Join-Path $root 'data\srv.pid'
$logFile = Join-Path $root 'data\watchdog.log'

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Test-Local {
  try { return (Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 6) }
  catch { return $null }
}

function Start-App {
  if (Test-Path $pidFile) {
    Get-Content $pidFile | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 400
  }
  $p = Start-Process -FilePath 'node' `
    -ArgumentList '--env-file-if-exists=.env', 'server/index.js' `
    -PassThru -WindowStyle Hidden -WorkingDirectory $root `
    -RedirectStandardOutput (Join-Path $root 'data\srv.log') `
    -RedirectStandardError (Join-Path $root 'data\srv.err')
  $p.Id | Out-File $pidFile -Encoding ascii
  Start-Sleep -Seconds 3
}

function Check-Once {
  $h = Test-Local
  if ($h) { return }
  Log 'LOCAL DOWN -> restarting app'
  Start-App
  $h = Test-Local
  if ($h) { Log ("LOCAL UP (notices={0} students={1})" -f $h.notices, $h.students) }
  else { Log 'LOCAL STILL DOWN - check data\srv.err' }
}

Log 'watchdog start'
if (-not $Loop) {
  Check-Once
  Log 'watchdog done (single pass)'
  exit 0
}

while ($true) {
  Check-Once
  Start-Sleep -Seconds $IntervalSec
}
