[CmdletBinding()]
param(
    [string]$Match = 'studio.youtube.com',
    [int]$Port = 9223,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\output\state-guard')
)

$ErrorActionPreference = 'Stop'
$pbcCommand = Get-Command pbc -ErrorAction Stop
$runId = Get-Date -Format 'yyyyMMdd-HHmmss'
$runDirectory = Join-Path $OutputDirectory $runId
New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null

function Invoke-PbcJson {
    param([string[]]$Arguments)

    $output = & $pbcCommand.Source @Arguments 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        throw "pbc $($Arguments -join ' ') failed:`n$output"
    }
    return $output | ConvertFrom-Json
}

function Invoke-PbcLogged {
    param(
        [string]$Name,
        [string[]]$Arguments
    )

    $output = & $pbcCommand.Source @Arguments 2>&1 | Out-String
    $output | Set-Content -LiteralPath (Join-Path $runDirectory "$Name.txt")
    if ($LASTEXITCODE -ne 0) {
        throw "pbc $($Arguments -join ' ') failed. See $Name.txt"
    }
}

function Get-Probe {
    $expression = 'JSON.stringify({marker:window.__pbcStateGuardMarker||null,timeOrigin:performance.timeOrigin,url:location.href})'
    $result = Invoke-PbcJson @('tab', 'eval', $Match, $expression, '--json', '--port', "$Port")
    return $result.value | ConvertFrom-Json
}

function Get-SnapshotState {
    $snapshot = Invoke-PbcJson @('tab', 'snapshot', $Match, '--json', '--port', "$Port")
    $items = @($snapshot.items | ForEach-Object {
        [ordered]@{
            ref = $_.ref
            tag = $_.tag
            role = $_.role
            type = $_.type
            id = $_.id
            label = $_.label
            text = $_.text
            value = $_.value
            disabled = $_.disabled
        }
    })
    return [ordered]@{
        tabUrl = $snapshot.tab.url
        frameUrl = $snapshot.frame.url
        items = $items
    }
}

function ConvertTo-RefFingerprint {
    param($State)
    $refs = @($State.items | ForEach-Object {
        [ordered]@{
            ref = $_.ref
            tag = $_.tag
            role = $_.role
            type = $_.type
            id = $_.id
            label = $_.label
        }
    })
    return ($refs | ConvertTo-Json -Depth 5 -Compress)
}

function Stop-OnProbeChange {
    param(
        [string]$Stage,
        $BaselineProbe
    )

    $probe = Get-Probe
    $probe | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDirectory "$Stage-probe.json")
    if ($probe.marker -ne $BaselineProbe.marker -or $probe.timeOrigin -ne $BaselineProbe.timeOrigin -or $probe.url -ne $BaselineProbe.url) {
        Write-Error "STOP: page identity changed at '$Stage'. Results: $runDirectory"
        exit 2
    }
}

$marker = [guid]::NewGuid().ToString()
$markerExpression = "(()=>{window.__pbcStateGuardMarker='$marker';return JSON.stringify({marker:window.__pbcStateGuardMarker,timeOrigin:performance.timeOrigin,url:location.href})})()"
$markerResult = Invoke-PbcJson @('tab', 'eval', $Match, $markerExpression, '--json', '--port', "$Port")
$baselineProbe = $markerResult.value | ConvertFrom-Json
$baselineState = Get-SnapshotState
$baselineFingerprint = ConvertTo-RefFingerprint $baselineState
$baselineProbe | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $runDirectory 'baseline-probe.json')
$baselineState | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory 'baseline-snapshot.json')
Stop-OnProbeChange -Stage 'baseline-after-snapshot' -BaselineProbe $baselineProbe
Start-Sleep -Seconds 1
$baselineConfirmation = Get-SnapshotState
Stop-OnProbeChange -Stage 'baseline-confirmation' -BaselineProbe $baselineProbe
if ((ConvertTo-RefFingerprint $baselineConfirmation) -ne $baselineFingerprint) {
    Write-Error "STOP: snapshot refs were not stable before testing. Results: $runDirectory"
    exit 4
}

$tests = @(
    @{ Name = 'doctor'; Args = @('doctor', '--port', "$Port") },
    @{ Name = 'tab-list-all'; Args = @('tab', 'list', '--all', '--port', "$Port") },
    @{ Name = 'tab-targets'; Args = @('tab', 'targets', '--port', "$Port") },
    @{ Name = 'tab-frames'; Args = @('tab', 'frames', $Match, '--port', "$Port") },
    @{ Name = 'tab-inspect'; Args = @('tab', 'inspect', $Match, '--port', "$Port") },
    @{ Name = 'tab-snapshot'; Args = @('tab', 'snapshot', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-text'; Args = @('tab', 'text', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-eval'; Args = @('tab', 'eval', $Match, 'document.title', '--json', '--port', "$Port") },
    @{ Name = 'tab-classify'; Args = @('tab', 'classify', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-state'; Args = @('tab', 'state', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-headers'; Args = @('tab', 'headers', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-cert'; Args = @('tab', 'cert', $Match, '--json', '--port', "$Port") },
    @{ Name = 'tab-screenshot'; Args = @('tab', 'screenshot', $Match, (Join-Path $runDirectory 'viewport.png'), '--port', "$Port") },
    @{ Name = 'tab-screenshot-full'; Args = @('tab', 'screenshot', $Match, (Join-Path $runDirectory 'full-page.png'), '--full-page', '--port', "$Port") }
)

foreach ($test in $tests) {
    Write-Host "TEST $($test.Name)"
    Invoke-PbcLogged -Name $test.Name -Arguments $test.Args
    Stop-OnProbeChange -Stage "$($test.Name)-after-command" -BaselineProbe $baselineProbe

    $state = Get-SnapshotState
    $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runDirectory "$($test.Name)-snapshot.json")
    Stop-OnProbeChange -Stage "$($test.Name)-after-guard-snapshot" -BaselineProbe $baselineProbe

    if ((ConvertTo-RefFingerprint $state) -ne $baselineFingerprint) {
        Write-Error "STOP: snapshot refs/state changed after '$($test.Name)'. Results: $runDirectory"
        exit 3
    }
}

Write-Host "PASS: all guarded commands preserved page identity and snapshot refs/state. Results: $runDirectory"
