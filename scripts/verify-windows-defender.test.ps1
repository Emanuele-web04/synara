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
    @{ name = 'transient default update failure recovers'; fault = 'update-transient'; error = $null; scans = 1; updateSource = 'default'; updateFailures = 2 },
    @{ name = 'exhausted default updates recover through direct MMPC'; fault = 'update-fallback'; error = $null; scans = 1; updateSource = 'default'; updateFailures = 3; expectedMmpcCalls = 1 },
    @{ name = 'direct fallback recovers while status RPC is unavailable'; fault = 'update-rpc-transition'; error = $null; scans = 1; updateSource = 'default'; updateFailures = 3; expectedMmpcCalls = 1 },
    @{ name = 'MMPC retry repairs a stopped service before updating'; fault = 'mmpc-service-recovery'; error = $null; scans = 1; updateSource = 'default'; updateFailures = 3; mmpcFailures = 1; expectedMmpcCalls = 2 },
    @{ name = 'both update sources fail despite fresh reported status'; fault = 'update-both-fail'; error = 'remote procedure call failed'; scans = 0; updateSource = 'default'; updateFailures = 3; mmpcFailures = 3; expectedMmpcCalls = 3 },
    @{ name = 'both update sources fail with stale reported status'; fault = 'update-both-stale'; error = 'remote procedure call failed'; scans = 0; updateSource = 'default'; updateFailures = 3; mmpcFailures = 3; expectedMmpcCalls = 3; stale = $true },
    @{ name = 'successful direct fallback still rejects stale definitions'; fault = 'update-fallback-stale'; error = 'do not match Microsoft latest version'; scans = 0; updateSource = 'default'; updateFailures = 3; expectedMmpcCalls = 1; stale = $true },
    @{ name = 'successful direct fallback still rejects out-of-date status'; fault = 'update-fallback-outdated'; error = 'reported out of date'; scans = 0; updateSource = 'default'; updateFailures = 3; expectedMmpcCalls = 1; outOfDate = $true },
    @{ name = 'transient MMPC update failure recovers'; fault = 'mmpc-transient'; error = $null; scans = 1; updateSource = 'MMPC'; updateFailures = 2 },
    @{ name = 'persistent MMPC update failure blocks scan'; fault = 'mmpc-persistent'; error = 'remote procedure call failed'; scans = 0; updateSource = 'MMPC'; updateFailures = 3 },
    @{ name = 'cloud policy remains disabled'; fault = 'maps-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'sample submission remains blocked'; fault = 'samples-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'block at first sight remains disabled'; fault = 'first-sight-disabled'; error = 'cloud protection'; scans = 0 },
    @{ name = 'missing cloud preference fails closed'; fault = 'missing-preference'; error = 'cloud protection'; scans = 0 },
    @{ name = 'MAPS connection fails'; fault = 'maps-unreachable'; error = 'MAPS connection'; scans = 0 },
    @{ name = 'cloud policy changes during scan'; fault = 'cloud-drift'; error = 'cloud protection'; scans = 1 },
    @{ name = 'detection blocks qualification'; fault = 'detection'; error = 'detection/remediation'; scans = 1 },
    @{ name = 'changed installer blocks qualification'; fault = 'changed-bytes'; error = 'did not qualify'; scans = 1 },
    @{ name = 'excluded installer blocks qualification'; fault = 'excluded'; error = 'outside exclusions'; scans = 0 },
    @{ name = 'failed update error capture blocks publication'; fault = 'update-error-evidence'; error = 'evidence is incomplete'; scans = 1; updateSource = 'default'; updateFailures = 2 },
    @{ name = 'unready service engine blocks qualification'; fault = 'engine-not-ready'; error = 'did not become ready within 120 seconds'; scans = 0 },
    @{ name = 'failed final status retains other evidence and blocks qualification'; fault = 'after-status-failure'; error = 'evidence is incomplete'; scans = 1 },
    @{ name = 'final evidence errors do not mask a scan failure'; fault = 'scan-and-after-status-failure'; error = 'did not qualify'; scans = 1 }
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
    if ($state.fault -in @('changed-bytes', 'scan-and-after-status-failure')) { Add-Content -LiteralPath $File -Value 'changed' }
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
                    updateCalls = [System.Collections.Generic.List[string]]::new()
                    mmpcUpdated = $false
                    serviceStarted = $false
                    serviceStarts = 0
                    preferences = [pscustomobject]@{
                        MAPSReporting = 0; SubmitSamplesConsent = 2; DisableBlockAtFirstSeen = $true
                        DisableArchiveScanning = $true; DisableIOAVProtection = $true
                        DisableBehaviorMonitoring = $true; DisableScriptScanning = $true
                        ExclusionPath = @($root); ExclusionExtension = @(); ExclusionProcess = @()
                    }
                }
                function Get-MpPreference {
                    if ($state.fault -eq 'update-rpc-transition' -and $state.updateCalls.Count -ge 3 -and -not $state.mmpcUpdated) { throw 'Operation failed with the following error: 0x800106ba' }
                    if ($state.fault -eq 'missing-preference') { return $state.preferences | Select-Object * -ExcludeProperty DisableBlockAtFirstSeen }
                    $state.preferences
                }
                function Get-MpComputerStatus {
                    if ($state.fault -in @('after-status-failure', 'scan-and-after-status-failure') -and $state.calls.Contains('scan')) { throw 'Synthetic final status unavailable' }
                    if ($state.fault -eq 'update-rpc-transition' -and $state.updateCalls.Count -ge 3 -and -not $state.mmpcUpdated) { throw 'Operation failed with the following error: 0x800106ba' }
                    $updated = if ($case.stale -or ($case.updateSource -eq 'MMPC' -and -not $state.mmpcUpdated)) { (Get-Date).AddDays(-2) } else { Get-Date }
                    $engineReady = $state.fault -ne 'engine-not-ready' -and ($state.fault -ne 'mmpc-service-recovery' -or $state.serviceStarted)
                    [pscustomobject]@{
                        AntivirusEnabled = $true; RealTimeProtectionEnabled = $true
                        AntivirusSignatureLastUpdated = $updated; AntivirusSignatureVersion = '1.0.0.0'
                        DefenderSignaturesOutOfDate = [bool]$case.outOfDate
                        AMServiceEnabled = $engineReady
                        AMEngineVersion = $(if ($engineReady) { '1.0.0.0' } else { '0.0.0.0' })
                    }
                }
                function Get-Service {
                    $status = if ($state.fault -eq 'mmpc-service-recovery' -and -not $state.serviceStarted) { 'Stopped' } else { 'Running' }
                    $service = [pscustomobject]@{ Status = $status }
                    $service | Add-Member -MemberType ScriptMethod -Name Refresh -Value { $this.Status = 'Running' }
                    $service
                }
                function Start-Service([string]$Name) {
                    if ($state.fault -ne 'mmpc-service-recovery' -or $Name -ne 'WinDefend') { throw 'Unexpected service start in mocked qualification.' }
                    $state.serviceStarted = $true
                    $state.serviceStarts += 1
                }
                function Invoke-WebRequest { [pscustomobject]@{ Content = '<li>Version: <span>2.0.0.0</span></li>' } }
                function Get-MpThreatDetection {}
                function Update-MpSignature {
                    [CmdletBinding()]
                    param([string]$UpdateSource)
                    $source = if ($UpdateSource) { $UpdateSource } else { 'default' }
                    $state.updateCalls.Add($source)
                    $attempt = @($state.updateCalls | Where-Object { $_ -eq $source }).Count
                    if ($source -eq 'MMPC' -and $state.fault -eq 'mmpc-service-recovery' -and -not $state.serviceStarted) { throw 'The remote procedure call failed.' }
                    if (($source -eq $case.updateSource -and $attempt -le $case.updateFailures) -or ($source -eq 'MMPC' -and $attempt -le $case.mmpcFailures)) { throw 'The remote procedure call failed.' }
                    if ($source -eq 'MMPC') { $state.mmpcUpdated = $true }
                }
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
                if ($case.fault -eq 'update-error-evidence') {
                    # A real filesystem failure, not a mocked diagnostic command.
                    New-Item -ItemType Directory -Path "$evidence/update-default-attempt-1-error.txt" -Force | Out-Null
                }
                $caught = $null
                try { & $GuardPath -AssetsDirectory $assets -EvidenceDirectory $evidence | Out-Null }
                catch { $caught = $_.Exception.Message }
                if ($case.error) {
                    if (-not $caught -or $caught -notlike "*$($case.error)*") { throw "Expected '$($case.error)', got '$caught'." }
                } elseif ($caught) { throw $caught }
                if (@($state.calls | Where-Object { $_ -eq 'scan' }).Count -ne $case.scans) { throw 'Unexpected scan count.' }
                if ($case.updateSource) {
                    if (@($state.updateCalls | Where-Object { $_ -eq $case.updateSource }).Count -ne 3) { throw 'Signature updates must recover or fail within three attempts.' }
                    $errors = @(Get-ChildItem "$evidence/update-$($case.updateSource)-attempt-*-error.txt")
                    if ($errors.Count -ne $case.updateFailures) { throw 'Every failed update attempt must retain its error.' }
                    foreach ($file in $errors) {
                        if ($case.fault -eq 'update-error-evidence' -and $file.PSIsContainer) { continue }
                        if ((Get-Content -LiteralPath $file.FullName -Raw) -notlike '*remote procedure call failed*') { throw 'Original update error was not retained.' }
                    }
                }
                if ($case.ContainsKey('expectedMmpcCalls')) {
                    if (@($state.updateCalls | Where-Object { $_ -eq 'MMPC' }).Count -ne $case.expectedMmpcCalls) { throw 'Unexpected direct MMPC fallback attempt count.' }
                    if (($state.updateCalls[0..2] -join ',') -ne 'default,default,default') { throw 'Direct fallback must follow all three default attempts.' }
                    $errors = @(Get-ChildItem "$evidence/update-MMPC-attempt-*-error.txt")
                    if ($errors.Count -ne [int]$case.mmpcFailures) { throw 'Every failed direct fallback must retain its error.' }
                    foreach ($file in $errors) {
                        if ((Get-Content -LiteralPath $file.FullName -Raw) -notlike '*remote procedure call failed*') { throw 'Original direct fallback error was not retained.' }
                    }
                }
                if ($case.fault -eq 'mmpc-service-recovery' -and $state.serviceStarts -ne 1) { throw 'MMPC retry did not repair WinDefend exactly once.' }
                if ($case.updateSource -eq 'MMPC' -and -not (Test-Path "$evidence/default-update-preferences.json")) { throw 'A successful but stale default update must retain its intermediate state.' }
                if (-not $case.error) {
                    if (($state.calls -join ',') -ne 'maps,scan') { throw 'Clean qualification must validate MAPS before scanning.' }
                    $ready = Get-Content "$evidence/ready-preferences.json" -Raw | ConvertFrom-Json
                    if ($ready.MAPSReporting -ne 2 -or $ready.SubmitSamplesConsent -ne 1 -or $ready.DisableBlockAtFirstSeen -ne $false) { throw 'Clean qualification lacks cloud protection evidence.' }
                }
                if ($case.fault -eq 'maps-unreachable' -and (Get-Content "$evidence/maps-connection-exit.txt" -Raw).Trim() -ne '1') { throw 'Failed MAPS exit code was not preserved.' }
                if ($state.fault -in @('after-status-failure', 'scan-and-after-status-failure')) {
                    $savedError = Get-Content "$evidence/after-status-error.txt" -Raw
                    if ($savedError -notlike '*Synthetic final status unavailable*') { throw 'Original final status failure was not preserved.' }
                    foreach ($file in @('after-preferences.json', 'after-detections.json', 'results.json', 'events.json')) {
                        if (-not (Test-Path "$evidence/$file")) { throw "A final status failure prevented evidence capture: $file" }
                    }
                }
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
