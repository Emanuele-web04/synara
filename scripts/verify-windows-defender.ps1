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
function Save-DefenderState($name) {
    Get-MpComputerStatus | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties |
        ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-status.json"
    Get-MpPreference | Select-Object * -ExcludeProperty CimClass, CimInstanceProperties, CimSystemProperties |
        ConvertTo-Json -Depth 6 | Set-Content "$evidence/$name-preferences.json"
    ConvertTo-Json -InputObject @(Get-MpThreatDetection) -Depth 8 | Set-Content "$evidence/$name-detections.json"
}
Save-DefenderState 'before'
$results = @()
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
    Update-MpSignature
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
    if (-not $status.AntivirusSignatureLastUpdated -or $status.AntivirusSignatureLastUpdated -lt (Get-Date).AddDays(-1)) {
        throw 'Defender security intelligence is more than 24 hours old after updating.'
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
    Save-DefenderState 'after'
    ConvertTo-Json -InputObject $results -Depth 6 | Set-Content "$evidence/results.json"
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started })
    $events | Select-Object TimeCreated, Id, Message | ConvertTo-Json -Depth 6 | Set-Content "$evidence/events.json"
}
if (@($events | Where-Object { $_.Id -in @(1116, 1117, 1118, 1119) }).Count -gt 0) {
    throw 'Defender recorded detection/remediation during qualification.'
}
$after = Get-MpComputerStatus
if (-not $after.AntivirusEnabled -or -not $after.RealTimeProtectionEnabled) {
    throw 'Defender protection became inactive during qualification.'
}
Write-Output 'Final installer bytes passed this Defender engine/definition scan. Windows 11 browser download behavior still requires separate qualification.'
