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

# Chrome forwards launches for an already-open profile to its existing process;
# the new --remote-debugging-port is ignored. Detect this before opening a tab
# and waiting for an endpoint that can never appear.
$requestedProfile = [IO.Path]::GetFullPath($UserDataDir).TrimEnd('\', '/')
$browserName = [IO.Path]::GetFileName($ChromeExe).Replace("'", "''")
$profileOwners = @(Get-CimInstance Win32_Process -Filter "Name='$browserName'" -ErrorAction Stop)
foreach ($owner in $profileOwners) {
  $commandLine = [string]$owner.CommandLine
  if ($commandLine -match '(?:^|\s)--type(?:=|\s)') { continue }
  $profileMatch = [regex]::Match($commandLine, '(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]+)"|(\S+))')
  if (!$profileMatch.Success) { continue }
  $ownerProfile = if ($profileMatch.Groups[1].Success) { $profileMatch.Groups[1].Value } else { $profileMatch.Groups[2].Value }
  if ([IO.Path]::GetFullPath($ownerProfile).TrimEnd('\', '/') -ine $requestedProfile) { continue }
  $portMatch = [regex]::Match($commandLine, '(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)')
  if (!$portMatch.Success) {
    throw "PBC profile is already held by browser PID $($owner.ProcessId) without a debugging port. Close that profile before relaunching; no browser was closed."
  }
  $ownerPort = [int]$portMatch.Groups[1].Value
  if ($ownerPort -ne $RemoteDebuggingPort) {
    throw "PBC profile is already held by browser PID $($owner.ProcessId) on port $ownerPort, but port $RemoteDebuggingPort was requested. Use --port $ownerPort or align DEFAULT_CDP_PORT in config.local.json with that port. No tab was opened and no browser was closed."
  }
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
