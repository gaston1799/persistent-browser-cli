param(
  [string]$SourceDir,
  [string]$BackupRoot,
  [switch]$KillChrome
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SourceDir)) {
  throw "SourceDir is required."
}

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  throw "BackupRoot is required."
}

if (!(Test-Path -LiteralPath $SourceDir)) {
  throw "Source profile not found: $SourceDir"
}

New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null

if ($KillChrome) {
  $escapedSource = $SourceDir.Replace('\', '\\')
  $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object {
    ($_.CommandLine -ne $null) -and ($_.CommandLine -like "*--user-data-dir=$escapedSource*")
  }
  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
  }
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$destDir = Join-Path $BackupRoot "profile-$stamp"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

& robocopy $SourceDir $destDir /MIR /R:1 /W:1 /NP /NFL /NDL | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) {
  throw "Robocopy failed with exit code $rc"
}

Write-Host "Backed up persistent Chrome profile to:"
Write-Host "  $destDir"
