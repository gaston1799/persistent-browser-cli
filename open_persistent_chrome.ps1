param(
  [string]$Url = "https://example.com",
  [int]$RemoteDebuggingPort = 9222,
  [string]$ChromeExe,
  [string]$UserDataDir,
  [string]$ChromeFlags = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ChromeExe)) {
  throw "ChromeExe is required."
}

if ([string]::IsNullOrWhiteSpace($UserDataDir)) {
  throw "UserDataDir is required."
}

if (!(Test-Path -LiteralPath $ChromeExe)) {
  throw "Chrome executable not found at: $ChromeExe"
}

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null

$args = @(
  "--remote-debugging-port=$RemoteDebuggingPort",
  "--remote-debugging-address=127.0.0.1",
  "--remote-allow-origins=*",
  "--user-data-dir=`"$UserDataDir`"",
  "--profile-directory=Default",
  "--new-window",
  "--start-maximized",
  "--no-first-run",
  "--no-default-browser-check",
  $Url
)

if (![string]::IsNullOrWhiteSpace($ChromeFlags)) {
  # Respect double-quoted segments so a single flag value may contain spaces, e.g.
  # --host-resolver-rules="MAP ads.example.com ~NOTFOUND,MAP cdn.mxpnl.com ~NOTFOUND".
  # Without this the naive space split chops the value into bogus arguments.
  $args += [regex]::Matches($ChromeFlags.Trim(), '"[^"]*"|\S+') | ForEach-Object { $_.Value }
}

Start-Process -FilePath $ChromeExe -ArgumentList $args | Out-Null

Write-Host "Opened Chrome with persistent profile:"
Write-Host "  chromeExe:   $ChromeExe"
Write-Host "  userDataDir: $UserDataDir"
Write-Host "  url:         $Url"
