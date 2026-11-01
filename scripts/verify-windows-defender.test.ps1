param([string]$GuardPath = "$PSScriptRoot/verify-windows-defender.ps1")

# Contract tests only: Defender commands and native scans are mocked. This never
# changes host protection and does not qualify an installer against real Defender.
$ErrorActionPreference = 'Stop'
$GuardPath = (Resolve-Path -LiteralPath $GuardPath).Path
$root = Join-Path ([System.IO.Path]::GetTempPath()) ('synara-defender-test-' + [guid]::NewGuid())
$originalEnvironment = @{}
foreach ($name in @('GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'ProgramData')) {
    $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$failures = @()
$cases = @(
    @{ name = 'cloud-enabled clean scan'; fault = ''; error = $null; scans = 1 },
    @{ name = 'cloud policy remains disabled'; fault = 'maps-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'sample submission remains blocked'; fault = 'samples-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'block at first sight remains disabled'; fault = 'first-sight-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'missing cloud preference fails closed'; fault = 'missing-preference'; error = 'cloud protection'; scans = 0 },
    @{ name = 'MAPS connection fails'; fault = 'maps-unreachable'; error = 'MAPS connection'; scans = 0 },
    @{ name = 'cloud policy changes during scan'; fault = 'cloud-drift'; error = 'cloud protection'; scans = 1 },
    @{ name = 'detection blocks qualification'; fault = 'detection'; error = 'detection/remediation'; scans = 1 },
    @{ name = 'changed installer blocks qualification'; fault = 'changed-bytes'; error = 'did not qualify'; scans = 1 },
    @{ name = 'excluded installer blocks qualification'; fault = 'excluded'; error = 'outside exclusions'; scans = 0 }
)
try {
    New-Item -ItemType Directory -Path $root | Out-Null
    $env:GITHUB_ACTIONS = 'true'
    $env:RUNNER_ENVIRONMENT = 'github-hosted'
    $env:ProgramData = $root
    New-Item -ItemType Directory -Path "$root/Microsoft/Windows Defender/Platform/test" -Force | Out-Null
    $mockScanner = "$root/MpCmdRun.ps1"
    @'
param([switch]$ValidateMapsConnection, [switch]$CheckExclusion, [switch]$Scan, [int]$ScanType, [string]$Path, [string]$File)
if ($ValidateMapsConnection) {
    $state.calls.Add('maps')
    if ($state.fault -eq 'maps-unreachable') { 'ValidateMapsConnection failed to establish a connection to MAPS'; exit 1 }
    'ValidateMapsConnection successfully established a connection to MAPS'
    exit 0
}
if ($CheckExclusion) {
    if ($state.fault -eq 'excluded') { 'Path is excluded'; exit 0 }
    'Path is not excluded'
    exit 1
}
if ($Scan) {
    $state.calls.Add('scan')
    if ($state.fault -eq 'changed-bytes') { Add-Content -LiteralPath $File -Value 'changed' }
    if ($state.fault -eq 'cloud-drift') { $state.preferences.MAPSReporting = 0 }
    'Scan finished. found no threats.'
    exit 0
}
throw 'Unexpected scanner command.'
'@ | Set-Content -LiteralPath $mockScanner
    foreach ($case in $cases) {
        try {
            & {
                $caseRoot = New-Item -ItemType Directory -Path "$root/$($case.fault)-case"
                $assets = New-Item -ItemType Directory -Path "$caseRoot/assets"
                'benign fixture, not an executable' | Set-Content "$assets/installer.exe"
                $evidence = "$caseRoot/evidence"
                $state = @{
                    fault = $case.fault
                    calls = [System.Collections.Generic.List[string]]::new()
                    preferences = [pscustomobject]@{
                        MAPSReporting = 0; SubmitSamplesConsent = 2; DisableBlockAtFirstSeen = $true
                        DisableArchiveScanning = $true; DisableIOAVProtection = $true
                        DisableBehaviorMonitoring = $true; DisableScriptScanning = $true
                        ExclusionPath = @($root); ExclusionExtension = @(); ExclusionProcess = @()
                    }
                }
                function Get-MpPreference {
                    if ($state.fault -eq 'missing-preference') { return $state.preferences | Select-Object * -ExcludeProperty DisableBlockAtFirstSeen }
                    $state.preferences
                }
                function Get-MpComputerStatus {
                    [pscustomobject]@{ AntivirusEnabled = $true; RealTimeProtectionEnabled = $true; AntivirusSignatureLastUpdated = Get-Date; DefenderSignaturesOutOfDate = $false }
                }
                function Get-MpThreatDetection {}
                function Update-MpSignature {}
                function Start-Sleep {}
                function Get-WinEvent {
                    [pscustomobject]@{ Id = $(if ($state.fault -eq 'detection') { 1116 } else { 5007 }); Message = 'fixture'; TimeCreated = Get-Date }
                }
                function Remove-MpPreference($ExclusionPath, $ExclusionExtension, $ExclusionProcess) {
                    foreach ($key in $PSBoundParameters.Keys) { $state.preferences.$key = @() }
                }
                function Set-MpPreference($DisableRealtimeMonitoring, $DisableArchiveScanning, $DisableIOAVProtection, $DisableBehaviorMonitoring, $DisableScriptScanning, $MAPSReporting, $SubmitSamplesConsent, $DisableBlockAtFirstSeen) {
                    foreach ($key in $PSBoundParameters.Keys) {
                        if ($key -eq 'DisableRealtimeMonitoring') { continue }
                        $state.preferences.$key = switch ($key) {
                            'MAPSReporting' { if ($MAPSReporting -eq 'Advanced') { 2 } else { $MAPSReporting } }
                            'SubmitSamplesConsent' { if ($SubmitSamplesConsent -eq 'SendSafeSamples') { 1 } else { $SubmitSamplesConsent } }
                            default { $PSBoundParameters[$key] }
                        }
                    }
                    switch ($state.fault) {
                        'maps-disabled' { $state.preferences.MAPSReporting = 0 }
                        'samples-disabled' { $state.preferences.SubmitSamplesConsent = 2 }
                        'first-sight-disabled' { $state.preferences.DisableBlockAtFirstSeen = $true }
                    }
                }
                # Substitute only the native scanner boundary; run the real guard
                # and its file hashing, evidence writes, and qualification checks.
                function Join-Path($Path, $ChildPath) {
                    if ($ChildPath -eq 'MpCmdRun.exe') { return $mockScanner }
                    Microsoft.PowerShell.Management\Join-Path @PSBoundParameters
                }
                $caught = $null
                try { & $GuardPath -AssetsDirectory $assets -EvidenceDirectory $evidence | Out-Null }
                catch { $caught = $_.Exception.Message }
                if ($case.error) {
                    if (-not $caught -or $caught -notlike "*$($case.error)*") { throw "Expected '$($case.error)', got '$caught'." }
                } elseif ($caught) { throw $caught }
                if (@($state.calls | Where-Object { $_ -eq 'scan' }).Count -ne $case.scans) { throw 'Unexpected scan count.' }
                if (-not $case.error) {
                    if (($state.calls -join ',') -ne 'maps,scan') { throw 'Clean qualification must validate MAPS before scanning.' }
                    $ready = Get-Content "$evidence/ready-preferences.json" -Raw | ConvertFrom-Json
                    if ($ready.MAPSReporting -ne 2 -or $ready.SubmitSamplesConsent -ne 1 -or $ready.DisableBlockAtFirstSeen -ne $false) { throw 'Clean qualification lacks cloud protection evidence.' }
                }
                if ($case.fault -eq 'maps-unreachable' -and (Get-Content "$evidence/maps-connection-exit.txt" -Raw).Trim() -ne '1') { throw 'Failed MAPS exit code was not preserved.' }
                if (-not (Test-Path "$evidence/after-preferences.json")) { throw 'Final Defender state was not preserved.' }
            }
            Write-Output "PASS $($case.name)"
        } catch {
            $failures += "$($case.name): $($_.Exception.Message)"
            Write-Output "FAIL $($failures[-1])"
        }
    }
} finally {
    foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name]) }
    Remove-Item -LiteralPath $root -Recurse -Force
}
if ($failures.Count -gt 0) { throw "$($failures.Count) Defender guard contract test(s) failed." }
Write-Output "$($cases.Count) Defender guard contract tests passed (mocked Defender; no live Windows qualification)."
