param(
  [string]$RepoUrl = "https://github.com/gaston1799/persistent-browser-cli.git",
  [string]$InstallRoot = "$env:LOCALAPPDATA\persistent-browser-cli",
  [switch]$LinkGlobal,
  [switch]$CloneStableChromeProfile
)

$ErrorActionPreference = "Stop"

function Write-Step($message) {
  Write-Host "[install] $message"
}

function Normalize-PathEntry([string]$value) {
  if ([string]::IsNullOrWhiteSpace($value)) { return "" }
  return $value.Trim().TrimEnd('\').ToLowerInvariant()
}

function Set-UserPathEntryFirst([string]$entry) {
  $normalizedEntry = Normalize-PathEntry $entry
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $userEntries = @($userPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $updatedUserEntries = @($entry) + @($userEntries | Where-Object { (Normalize-PathEntry $_) -ne $normalizedEntry })
  [Environment]::SetEnvironmentVariable("Path", ($updatedUserEntries -join ';'), "User")

  $processEntries = @($env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $env:Path = (@($entry) + @($processEntries | Where-Object { (Normalize-PathEntry $_) -ne $normalizedEntry })) -join ';'
}

function Remove-StaleManagedPbcShims([string]$managedNodeRoot, [string]$activeNpmPrefix) {
  if (!(Test-Path -LiteralPath $managedNodeRoot)) { return }
  if ((Normalize-PathEntry $managedNodeRoot) -eq (Normalize-PathEntry $activeNpmPrefix)) { return }

  $removed = @()
  foreach ($commandName in @("pbc", "pbc-cli", "persistent-browser-cli")) {
    foreach ($extension in @("", ".cmd", ".ps1")) {
      $candidate = Join-Path $managedNodeRoot "$commandName$extension"
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        Remove-Item -LiteralPath $candidate -Force
        $removed += $candidate
      }
    }
  }
  if ($removed.Count -gt 0) {
    Write-Step "Removed $($removed.Count) stale PBC shim(s) from the inactive bundled Node directory"
  }
}

function Repair-PbcShimPrecedence([string]$installRoot) {
  $npmPrefix = (& npm prefix -g | Select-Object -First 1).Trim()
  if ([string]::IsNullOrWhiteSpace($npmPrefix)) {
    throw "npm did not report a global prefix after linking PBC."
  }

  $managedNodeRoot = Join-Path $installRoot "tools\nodejs"
  Remove-StaleManagedPbcShims -managedNodeRoot $managedNodeRoot -activeNpmPrefix $npmPrefix
  Set-UserPathEntryFirst $npmPrefix

  $expectedShim = Join-Path $npmPrefix "pbc.cmd"
  if (!(Test-Path -LiteralPath $expectedShim -PathType Leaf)) {
    throw "npm link completed, but the expected PBC shim was not created at $expectedShim"
  }

  $resolved = @(Get-Command pbc -All -ErrorAction SilentlyContinue | Where-Object Source | Select-Object -ExpandProperty Source)
  if ($resolved.Count -eq 0) {
    throw "PBC was linked, but pbc is still not resolvable in PATH."
  }
  if ((Normalize-PathEntry (Split-Path -Parent $resolved[0])) -ne (Normalize-PathEntry $npmPrefix)) {
    throw "A stale PBC shim still wins PATH precedence: $($resolved[0]). Expected the npm shim under $npmPrefix."
  }
  Write-Step "Verified PBC shim precedence: $($resolved[0])"
}

if (!(Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required."
}

if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node is required."
}

if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
  throw "npm is required."
}

$repoDir = Join-Path $InstallRoot "persistent-browser-cli"
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

if (!(Test-Path -LiteralPath $repoDir)) {
  Write-Step "Cloning repo into $repoDir"
  git clone $RepoUrl $repoDir
} else {
  Write-Step "Repo already exists at $repoDir"
}

Push-Location $repoDir
try {
  Write-Step "Installing dependencies"
  npm install

  if ($LinkGlobal) {
    Write-Step "Creating global command shims"
    npm link
    if ($LASTEXITCODE -ne 0) { throw "npm link failed with exit code $LASTEXITCODE." }
    Repair-PbcShimPrecedence -installRoot $InstallRoot
  }

  if ($CloneStableChromeProfile) {
    $stableChrome = Join-Path $env:LOCALAPPDATA "Google\Chrome\User Data"
    $targetProfile = Join-Path $InstallRoot "chrome-jobhunt"
    if (!(Test-Path -LiteralPath $stableChrome)) {
      throw "Stable Chrome profile not found at $stableChrome"
    }
    if (Get-Process chrome -ErrorAction SilentlyContinue) {
      throw "Chrome is still running. Close all Chrome windows before copying the stable profile."
    }
    Write-Step "Copying stable Chrome profile to $targetProfile"
    if (Test-Path -LiteralPath $targetProfile) {
      Remove-Item -LiteralPath $targetProfile -Recurse -Force
    }
    Copy-Item -LiteralPath $stableChrome -Destination $targetProfile -Recurse -Force
  }

  Write-Step "Verifying CLI"
  node cli.js doctor
}
finally {
  Pop-Location
}

Write-Step "Done"
Write-Step "Use pbc from any terminal after PATH is set via npm link or your npm global bin."
