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
