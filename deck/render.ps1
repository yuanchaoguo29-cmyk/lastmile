# Render a .pptx to per-slide PNGs using PowerPoint COM (no LibreOffice on this machine).
#   powershell -ExecutionPolicy Bypass -File deck\render.ps1 -Pptx "deck\x.pptx" -OutDir "deck\render"
# ASCII only.

param(
  [Parameter(Mandatory = $true)][string]$Pptx,
  [string]$OutDir = 'deck\render',
  [int]$Width = 1600,
  [int]$Height = 900
)

$ErrorActionPreference = 'Stop'
$pptxPath = (Resolve-Path $Pptx).Path
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$outPath = (Resolve-Path $OutDir).Path
Get-ChildItem $outPath -Filter 'slide-*.png' -ErrorAction SilentlyContinue | Remove-Item -Force

$app = $null
$pres = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  # Open(FileName, ReadOnly, Untitled, WithWindow)
  $pres = $app.Presentations.Open($pptxPath, -1, 0, 0)
  $n = $pres.Slides.Count
  Write-Host "slides: $n"
  for ($i = 1; $i -le $n; $i++) {
    $file = Join-Path $outPath ('slide-{0:D2}.png' -f $i)
    $pres.Slides.Item($i).Export($file, 'PNG', $Width, $Height)
    Write-Host ("  slide {0} -> {1}" -f $i, (Split-Path $file -Leaf))
  }
  Write-Host 'done'
}
finally {
  if ($pres) { try { $pres.Close() } catch {} }
  if ($app) { try { $app.Quit() } catch {} }
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) | Out-Null
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
  [GC]::Collect()
}
