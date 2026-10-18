param(
    [Parameter(Mandatory = $true)][string]$AssetsDirectory,
    [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Defender qualification requires a disposable GitHub-hosted Windows runner.'
}
$started = Get-Date
$evidence = New-Item -ItemType Directory -Path $EvidenceDirectory -Force
$installers = @(Get-ChildItem -LiteralPath $AssetsDirectory -Filter '*.exe' -File)
if ($installers.Count -eq 0) { throw 'No Windows installers found for Defender qualification.' }
# Capture identity before enabling protection: a removed candidate must fail.
$expected = @($installers | ForEach-Object {
    @{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }
})
ConvertTo-Json -InputObject $expected | Set-Content "$evidence/expected-installers.json"
function Save-DefenderError($failure, $name) {
    try {
        $failure | Format-List * -Force | Out-String -Width 4096 | Set-Content "$evidence/$name-error.txt"
        $failure.Exception | Format-List * -Force | Out-String -Width 4096 | Add-Content "$evidence/$name-error.txt"
    } catch { Write-Warning "Could not preserve $name error: $($_.Exception.Message)" }
}
function Save-DefenderState($name, [switch]$BestEffort) {
    $captures = @{
        status = { Get-MpComputerStatus | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties }
        preferences = { Get-MpPreference | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties }
        detections = { @(Get-MpThreatDetection) }
    }
    foreach ($kind in @('status', 'preferences', 'detections')) {
        try {
            $value = if ($kind -eq 'detections') { ,@(& $captures[$kind]) } else { & $captures[$kind] }
            ConvertTo-Json -InputObject $value -Depth 8 | Set-Content "$evidence/$name-$kind.json"
        } catch {
            Save-DefenderError $_ "$name-$kind"
            if (-not $BestEffort) { throw }
            Write-Output "$name-$kind"
        }
    }
}
function Wait-DefenderReady {
    $wait = [Diagnostics.Stopwatch]::StartNew()
    for ($poll = 0; $poll -lt 24 -and $wait.Elapsed.TotalSeconds -lt 120; $poll++) {
        try {
            $service = Get-Service -Name WinDefend
            if ($service.Status -eq 'Stopped') {
                Start-Service -Name WinDefend
                $service.Refresh()
            }
            $status = Get-MpComputerStatus
            if ($service.Status -eq 'Running' -and $status.AMServiceEnabled -and
                $status.AMEngineVersion -and $status.AMEngineVersion -ne '0.0.0.0') { return }
        } catch { Save-DefenderError $_ "readiness-$poll" }
        $remaining = 120000 - $wait.Elapsed.TotalMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([Math]::Min(5000, [int]$remaining)) }
    }
    throw 'WinDefend and its engine did not become ready within 120 seconds.'
}
function Update-DefenderSignatures([string]$UpdateSource) {
    $arguments = @{ ErrorAction = 'Stop' }
    if ($UpdateSource) { $arguments.UpdateSource = $UpdateSource }
    $source = if ($UpdateSource) { $UpdateSource } else { 'configured' }
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            Update-MpSignature @arguments
            return
        } catch {
            $failure = $_
            Save-DefenderError $failure "signature-update-$source-$attempt"
            $status = $null
            try {
                $status = Get-MpComputerStatus
                $status | ConvertTo-Json -Depth 6 | Set-Content "$evidence/signature-update-$source-$attempt-status.json"
            } catch { Save-DefenderError $_ "signature-update-$source-$attempt-status" }
            # A platform replacement can interrupt RPC or report a generic update failure.
            # The latter is retryable only with a changed platform and unhealthy engine/service.
            $rpcInterrupted = $failure.Exception.HResult -eq -2147023170 -or
                $failure.Exception.Message -match '\bThe remote procedure call failed\b'
            $platformRestarting = $status -and $initialPlatformVersion -and $status.AMProductVersion -and
                $status.AMProductVersion -ne $initialPlatformVersion -and
                (-not $status.AMServiceEnabled -or -not $status.AMEngineVersion -or $status.AMEngineVersion -eq '0.0.0.0')
            if ($attempt -eq 3 -or -not ($rpcInterrupted -or $platformRestarting)) { throw $failure }
            Write-Warning "Defender update interrupted; waiting for service/engine before retry $($attempt + 1) of 3."
            Wait-DefenderReady
        }
    }
}
$initialPlatformVersion = (Get-MpComputerStatus).AMProductVersion
Save-DefenderState 'before'
$results = @()
$events = @()
$evidenceFailures = @()
try {
    # Hosted images disable protection and exclude their entire working drives.
    # Strengthen this disposable runner only; cloud/sample consent is unchanged.
    $preferences = Get-MpPreference
    foreach ($kind in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
        $values = @($preferences.$kind | Where-Object { $_ })
        if ($values.Count -gt 0) {
            $arguments = @{ $kind = $values }
            Remove-MpPreference @arguments
        }
    }
    Set-MpPreference -DisableRealtimeMonitoring $false -DisableArchiveScanning $false -DisableIOAVProtection $false -DisableBehaviorMonitoring $false -DisableScriptScanning $false
    Update-DefenderSignatures
    $signatureStatus = Get-MpComputerStatus
    if (-not $signatureStatus.AntivirusSignatureLastUpdated -or $signatureStatus.AntivirusSignatureLastUpdated -lt (Get-Date).AddDays(-1)) {
        # A configured source can successfully return older staged definitions.
        # Retry Microsoft's direct source; the freshness gate below still applies.
        Save-DefenderState 'default-update'
        Write-Output 'Configured update source returned stale definitions; retrying MMPC.'
        Update-DefenderSignatures -UpdateSource MMPC
    }
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        if ((Get-MpComputerStatus).RealTimeProtectionEnabled) { break }
        Start-Sleep -Seconds 5
    }
    Save-DefenderState 'ready'
    $status = Get-MpComputerStatus
    $preferences = Get-MpPreference
    if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled -or
        $preferences.DisableArchiveScanning -or $preferences.DisableIOAVProtection -or
        $preferences.DisableBehaviorMonitoring -or $preferences.DisableScriptScanning) {
        throw 'Defender antivirus, real-time, archive, download, behavior or script protection is not active.'
    }
    if (-not $status.AntivirusSignatureLastUpdated -or $status.DefenderSignaturesOutOfDate) {
        throw 'Defender security intelligence is missing or reported out of date after updating.'
    }
    if ($status.AntivirusSignatureLastUpdated -lt (Get-Date).AddDays(-1)) {
        # LastUpdated can predate publication even for Microsoft's latest release.
        # An older local timestamp requires independent proof of the current version,
        # rather than a wider age allowance. Missing or changed vendor data fails closed.
        $definitionSource = 'https://www.microsoft.com/en-us/wdsi/defenderupdates'
        $definitionPage = Invoke-WebRequest -Uri $definitionSource -Headers @{ 'Cache-Control' = 'no-cache' }
        $versionMatches = [regex]::Matches($definitionPage.Content, '<li>\s*Version:\s*<span>\s*(\d+\.\d+\.\d+\.\d+)\s*</span>\s*</li>')
        if ($versionMatches.Count -ne 1) { throw 'Microsoft latest Defender version could not be verified.' }
        $latestVersion = $versionMatches[0].Groups[1].Value
        @{
            source = $definitionSource
            checkedAt = (Get-Date).ToUniversalTime().ToString('o')
            latestVersion = $latestVersion
            installedVersion = $status.AntivirusSignatureVersion
            signatureLastUpdated = $status.AntivirusSignatureLastUpdated
        } | ConvertTo-Json | Set-Content "$evidence/latest-version.json"
        if ($status.AntivirusSignatureVersion -ne $latestVersion) {
            throw 'Defender definitions are older than 24 hours and do not match Microsoft latest version.'
        }
        Write-Output "Installed Defender definitions match Microsoft latest version ($latestVersion)."
    }
    if (@($preferences.ExclusionPath + $preferences.ExclusionExtension + $preferences.ExclusionProcess | Where-Object { $_ }).Count -gt 0) {
        throw 'Defender exclusions remain on the qualification runner.'
    }
    $platform = Get-ChildItem "$env:ProgramData/Microsoft/Windows Defender/Platform" -Directory |
        Sort-Object Name -Descending | Select-Object -First 1
    $scanner = if ($platform) { Join-Path $platform.FullName 'MpCmdRun.exe' } else { "$env:ProgramFiles/Windows Defender/MpCmdRun.exe" }
    foreach ($sample in $expected) {
        $name = Split-Path $sample.path -Leaf
        for ($attempt = 0; $attempt -lt 12; $attempt++) {
            $exclusion = @(& $scanner -CheckExclusion -Path $sample.path 2>&1)
            $exclusionExit = $LASTEXITCODE
            if ($exclusionExit -eq 1 -and ($exclusion -join "`n") -match 'is not excluded') { break }
            Start-Sleep -Seconds 5
        }
        $exclusion | Set-Content "$evidence/$name-exclusion.txt"
        if ($exclusionExit -ne 1 -or ($exclusion -join "`n") -notmatch 'is not excluded') {
            throw "Defender has not confirmed $name is outside exclusions."
        }
        $output = @(& $scanner -Scan -ScanType 3 -File $sample.path 2>&1)
        $exitCode = $LASTEXITCODE
        $output | Tee-Object "$evidence/$name-scan.txt" | Write-Host
        # Exit zero can also mean a threat was found and remediated. Require the
        # explicit clean result and the complete unchanged artifact as well.
        $hash = (Get-FileHash -LiteralPath $sample.path -Algorithm SHA256).Hash
        $results += @{ name = $name; exitCode = $exitCode; sha256 = $hash }
        if ($exitCode -ne 0 -or ($output -join "`n") -notmatch 'found no threats\.' -or $hash -ne $sample.sha256) {
            throw "Defender did not qualify $name. Inspect the preserved evidence."
        }
    }
} finally {
    Start-Sleep -Seconds 20
    # Evidence failures must not mask the original update/scan failure or stop other captures.
    $evidenceFailures = @(Save-DefenderState 'after' -BestEffort)
    try { ConvertTo-Json -InputObject $results -Depth 6 | Set-Content "$evidence/results.json" } catch {
        Save-DefenderError $_ 'results'
        $evidenceFailures += 'results'
    }
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started })
        ConvertTo-Json -InputObject @($events | Select-Object TimeCreated, Id, Message) -Depth 6 | Set-Content "$evidence/events.json"
    } catch {
        Save-DefenderError $_ 'events'
        $evidenceFailures += 'events'
    }
}
if ($evidenceFailures.Count -gt 0) { throw 'Defender qualification evidence is incomplete. Inspect the preserved errors.' }
if (@($events | Where-Object { $_.Id -in @(1116, 1117, 1118, 1119) }).Count -gt 0) {
    throw 'Defender recorded detection/remediation during qualification.'
}
$after = Get-MpComputerStatus
if (-not $after.AntivirusEnabled -or -not $after.RealTimeProtectionEnabled) {
    throw 'Defender protection became inactive during qualification.'
}
Write-Output 'Final installer bytes passed this Defender engine/definition scan. Windows 11 browser download behavior still requires separate qualification.'
