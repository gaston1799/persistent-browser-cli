[CmdletBinding()]
param(
  [switch]$BuildExe
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  Write-Host "[pbc] Relinking global CLI shims from $repoRoot"
  npm link
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm link failed with exit code $code." }

  Write-Host "[pbc] Verifying the linked command"
  pbc --help
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "pbc --help failed with exit code $code." }

  pbc doctor
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "pbc doctor failed with exit code $code." }

  if ($BuildExe) {
    Write-Host "[pbc] Building the standalone executable"
    npm run build:exe
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "npm run build:exe failed with exit code $code." }

    & .\dist\pbc.exe --help
    $code = $LASTEXITCODE
    if ($code -ne 0) { throw "dist\pbc.exe --help failed with exit code $code." }
  }

  Write-Host "[pbc] Rebuild complete."
}
finally {
  Pop-Location
}
