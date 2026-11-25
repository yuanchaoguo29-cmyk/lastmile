# Watchdog: keep the local app alive and tell you when the public URL goes dark.
#
#   one check:   powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1
#   keep looping: powershell -ExecutionPolicy Bypass -File scripts\watchdog.ps1 -Loop
#
# It does NOT silently rotate the public URL: students may already have the old link.
# If the tunnel is down it prints a loud warning and the command to re-create it.
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
$cfUrlFile = Join-Path $root 'data\cf.url'

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  Add-Content -Path $logFile -Value $line -Encoding UTF8
}

function Test-Local {
  try {
    $h = Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 6
    return $h
  } catch {
    return $null
  }
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

function Get-PublicUrl {
  $envFile = Join-Path $root '.env'
  if (-not (Test-Path $envFile)) { return $null }
  foreach ($line in (Get-Content $envFile -Encoding UTF8)) {
    if ($line -match '^\s*PUBLIC_BASE_URL\s*=\s*(\S+)') { return $Matches[1].TrimEnd('/') }
  }
  return $null
}

function Test-Public {
  $u = Get-PublicUrl
  if (-not $u) { return 'unknown' }
  try {
    Invoke-RestMethod ("$u/api/health") -TimeoutSec 15 | Out-Null
    return 'up'
  } catch {
    return 'down'
  }
}

function Check-Once {
  $h = Test-Local
  if (-not $h) {
    Log 'LOCAL DOWN -> restarting app'
    Start-App
    $h = Test-Local
    if ($h) { Log ("LOCAL UP (notices={0} students={1})" -f $h.notices, $h.students) }
    else { Log 'LOCAL STILL DOWN - check data\srv.err'; return }
  }

  $pub = Test-Public
  switch ($pub) {
    'up' { }
    'down' {
      Log 'PUBLIC URL DOWN - the tunnel died'
      $u = Get-PublicUrl
      Write-Host ''
      Write-Host "  Current public URL ($u) is not answering." -ForegroundColor Red
      Write-Host '  Re-create the tunnel, then repoint the app:' -ForegroundColor Red
      Write-Host '    cpolar http 3000        (or)  powershell -ExecutionPolicy Bypass -File scripts\tunnel.ps1'
      Write-Host '    powershell -ExecutionPolicy Bypass -File scripts\set-public-url.ps1 -Url <new url>'
      Write-Host ''
    }
    default { Log 'PUBLIC_BASE_URL not set in .env - start a tunnel and run set-public-url.ps1' }
  }
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
