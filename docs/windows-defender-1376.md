# Windows Defender investigation: issue #1376

Evidence collected on 2026-09-30 for [issue #1376](https://github.com/Emanuele-web04/synara/issues/1376), from main `529ad049cb106c998010f5400189515008997aa4`. The original installer detection was independently reproduced on disposable GitHub-hosted Windows Server 2022 runners. This is not a confirmed malware verdict, false-positive determination, or shipped artifact fix; Windows 11 browser behavior remains unqualified.

## Verified evidence

The reporter's screenshot shows `Trojan:Win32/Kepavl!rfn`, status **Removed**, on `Synara-0.9.2-x64.exe.crdownload` on 2026-09-29. The reported environment is Windows 11 24H2 build 26100.9457 with Helium. The screenshot does not provide the downloaded bytes' hash, Defender engine/definition versions, or a detected inner component. The browser version is also missing.

Both complete installers were downloaded from the official releases, hashed locally, and matched against GitHub's asset digest and the corresponding Windows provenance. The release source's `bun.lock` hashes also match provenance. This establishes which public artifacts were inspected; it does not prove the reporter received identical complete bytes or establish their safety.

| Artifact                                                                                                       | Source commit                              | Bytes     | SHA-256                                                            |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------- | ------------------------------------------------------------------ |
| [Synara-0.9.2-x64.exe](https://github.com/Emanuele-web04/synara/releases/download/v0.9.2/Synara-0.9.2-x64.exe) | `a33435c18474eb7816582004e45f87382965ac8d` | 225688617 | `fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb` |
| [Synara-0.9.1-x64.exe](https://github.com/Emanuele-web04/synara/releases/download/v0.9.1/Synara-0.9.1-x64.exe) | `eaa61eded31b6755d4f30ba8eabc5d905cf817cb` | 225595797 | `893438647667a4f6aeb2929897a0131dd95e5c0686ec2958e5968cdb75f3496b` |

Both [v0.9.2 provenance](https://github.com/Emanuele-web04/synara/releases/download/v0.9.2/artifact-win-x64.provenance.json) and [v0.9.1 provenance](https://github.com/Emanuele-web04/synara/releases/download/v0.9.1/artifact-win-x64.provenance.json) record `unsigned-explicit-release`. Both installers have an empty PE certificate directory. Lack of signing is not new in v0.9.2 and does not establish the cause of this antivirus detection. The matched Defender comparison below independently passed v0.9.1 and quarantined v0.9.2.

The [v0.9.2 Windows release job](https://github.com/Emanuele-web04/synara/actions/runs/36159536991/job/108154522199) passed packaging, provenance, and packaged startup. It did not record a Defender scan. These checks do not qualify the installer against the reported detection. Current release tooling already supports Azure Trusted Signing and verifies the expected publisher, certificate subject, signature status, and timestamp when signing is enabled. No credential or signing-policy change was made for this investigation.

## Independently reproduced detection

The [runtime evidence index](evidence/windows-defender-1376-runtime.json) records exact hashes, engine/definition versions, and diagnostic run links. The diagnostic harnesses are preserved in those runs’ source commits; they are not recurring release jobs.

The [matched release-guard run](https://github.com/Emanuele-web04/synara/actions/runs/36739468968) used Defender engine `1.1.26080.3` and security intelligence `1.459.485.0`. Both official files were hash-verified before protection was enabled. The ephemeral runner's inherited drive exclusions were removed; real-time, archive, download, behavior, and script protection were enabled. Each actual sample path was independently confirmed outside exclusions before scanning. Cloud participation and automatic sample submission were unchanged.

- **0.9.1:** explicit `found no threats`, exit 0, and the same complete SHA-256 afterward.
- **0.9.2:** explicit threat detection, events 1116/1117, and quarantine as `Trojan:Win32/Kepavll!rfn`. The observed family spelling contains two lowercase `l` characters. The installer was never executed.

The [component isolation run](https://github.com/Emanuele-web04/synara/actions/runs/36739469057) separately scanned 107 extracted samples across both versions, including all inventoried PE files, `app.asar`, and each complete inner `app-64.7z`. Every sample was confirmed outside exclusions, explicitly scanned clean, and retained its expected hash. This narrows the observed detection to the complete NSIS installer context; it does not establish which bytes or heuristic cause the classification, or prove every JavaScript file is safe.

The hosted Windows image had disabled protection and excluded its working drives by default. Consequently, the earlier green packaging/startup job could not establish Defender acceptance. The release workflow now verifies active protection and current intelligence, confirms the actual installer is not excluded, and requires both an explicit clean scan and unchanged bytes before startup and artifact upload. Detection, quarantine, scan failure, or inability to qualify the scanner blocks publication and preserves evidence.

## Qualified packaging remedy

A [controlled rebuild](https://github.com/Emanuele-web04/synara/actions/runs/36740232673) used the existing electron-builder `26.15.3`, standard NSIS compression, and Stable's existing installer GUID. It repackaged the already released application without changing dependencies or application code. Static extraction of the new installer verified all **340 embedded application files** against the original payload by SHA-256. The resulting experimental installer is `f48ef644748694f9538ec313e998bfa0def5b3776858d41537cae07261a18387`.

The [decisive paired comparison](https://github.com/Emanuele-web04/synara/actions/runs/36742048832) staged the exact official installer and rebuilt installer with the same canonical filename, then enabled protection and updated definitions once. Engine `1.1.26080.3` and definitions `1.459.486.0` remained unchanged across both scans. Both actual paths were outside exclusions:

| Installer                | Result                                                                           |
| ------------------------ | -------------------------------------------------------------------------------- |
| Original `fee21f…928dcb` | Explicitly found one threat and remediated it; original bytes no longer survived |
| Rebuilt `f48ef6…18387`   | Explicitly found no threats, exit 0, complete expected hash survived             |

This establishes that rebuilding the installer container resolves this reproducible detection for the tested bytes and Defender versions. It does not identify Microsoft's underlying heuristic or establish a general false-positive verdict. The earlier standalone rebuild used newer definitions than the first reproduction; only this matched pair supports the packaging remedy. Compression alternatives and dependency downgrades are unnecessary based on this evidence.

The [installed-runtime qualification](https://github.com/Emanuele-web04/synara/actions/runs/36744320200) passed silent installation of official 0.9.1 followed by upgrade to the rebuilt 0.9.2, then ran the existing isolated dependency and app/backend startup smoke against the **actually installed x64 tree**. Defender remained active with engine `1.1.26080.3`, definitions `1.459.486.0`, and no detections after startup.

The installed tree contains **334 matching application files**, not 340. Six ARM64 node-pty helpers are absent in both the official 0.9.1 installation and the rebuilt 0.9.2 installation. All six use the ARM64 filter in the inner 7z archives, which suggests a pre-existing NSIS decompressor compatibility issue; that cause is not proven. The x64 dependency/startup checks passed, and no other payload difference was accepted. This investigation does not qualify Windows on ARM or repair those existing omissions.

The rebuilt file is retained as [qualified-experimental-installer-normal](https://github.com/Emanuele-web04/synara/actions/runs/36740232673/artifacts/11109114425), expiring 2026-10-14. It is an experimental repair candidate, not a published replacement or a new official release. Any distributed release must pass the new guard on its own final bytes, signing/provenance policy, startup checks, and authorized release process. No release asset or update feed was changed.

## Static comparison

7-Zip 24.09 extracted NSIS and its `$PLUGINSDIR/app-64.7z` payload without running either installer. The extraction tool archive SHA-256 was `496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1`, matching electron-builder's pinned Darwin toolset checksum. The comparison covers extracted `.exe`, `.dll`, and `.node` files with PE magic, including NSIS plugins and the uninstaller. All such entries in `app.asar` are marked unpacked. It is not a malware scan or an audit of every JavaScript file.

There are 49 extracted PE files in v0.9.1 and 48 in v0.9.2: 37 identical hashes, nine changed hashes, two added paths, and three removed paths. The [comparison manifest](evidence/windows-defender-1376.json) records those differences and selected unchanged component hashes.

| Component                                                                                       | Observed difference                                                                                 |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Electron 43.4.1, electron-builder 26.15.3, node-pty 1.1.0, Claude SDK 0.3.259                   | Versions unchanged in release lockfiles                                                             |
| NSIS plugins, Electron DLLs, Claude executable, node-pty prebuilt helpers, rookie-cookies addon | Byte-identical at matching paths                                                                    |
| `Synara.exe`, uninstaller, six locally built native addon/helper files                          | Hashes changed; hash differences alone do not establish functional differences or a detection cause |
| Bundled `@esbuild/win32-x64/esbuild.exe`                                                        | Version changed from 0.28.1 to 0.28.2                                                               |
| pi-tui Windows addons                                                                           | Two `win32-console-mode.node` paths replaced by two `win32-platform.node` paths, for x64 and arm64  |
| Clipboard addon                                                                                 | `@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node` removed                      |

The screenshot only names the outer download. It cannot distinguish an installer/container heuristic, an inner executable/addon, or a definition/cloud-classification change. The subsequent matched scan demonstrates acceptance of a rebuilt container with unchanged application bytes. It does not justify removing runtime helpers, downgrading dependencies, or switching compression.

## Qualification on an isolated Windows VM

Use a disposable Windows 11 VM with Defender active, no production data, and no exclusions covering the samples or scanning tools. Do not execute either installer during this investigation, restore quarantined samples, allow the threat, disable protection, or add exclusions. If Defender removes a sample during download, retain the detection evidence and stop that attempt; a missing file is not a clean result.

Run an elevated PowerShell session. Record the original definition versions and attempt the browser download first, so that an update does not erase the initial conditions. Then update security intelligence normally and repeat, recording both results. Record the exact Windows and browser versions, download URL, UTC time, Defender status, and threat details. Compare v0.9.1, v0.9.2, and any candidate using the same engine/definitions and VM conditions; a definition update is a separate experiment from a packaging change.

The following commands collect evidence locally. They do not submit files or change security policy. Choose a new evidence directory per attempt. Review logs before sharing because they can contain local paths and machine identifiers.

```powershell
$ErrorActionPreference = 'Stop'
$evidence = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ('synara-defender-' + [guid]::NewGuid()))
$started = Get-Date
(Get-Date).ToUniversalTime().ToString('o') | Out-File (Join-Path $evidence 'started-utc.txt')
Get-ComputerInfo -Property WindowsProductName, WindowsVersion, OsBuildNumber |
    ConvertTo-Json | Set-Content (Join-Path $evidence 'windows.json')
Get-MpComputerStatus | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'defender-before.json')
Get-MpPreference | Select-Object DisableArchiveScanning, MAPSReporting, SubmitSamplesConsent, ExclusionPath, ExclusionExtension, ExclusionProcess |
    ConvertTo-Json -Depth 4 | Set-Content (Join-Path $evidence 'scan-settings.json')
```

After the browser attempt, capture its result and the detection records even if download failed:

```powershell
Get-MpThreatDetection | ConvertTo-Json -Depth 6 |
    Set-Content (Join-Path $evidence 'detections.json')
Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $started } |
    Select-Object TimeCreated, Id, Message | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'events.json')
```

If the complete v0.9.2 file survives, set its actual path below and verify the hash before scanning. Find the newest installed Defender platform's `MpCmdRun.exe` (fall back to `%ProgramFiles%\Windows Defender\MpCmdRun.exe` only if no platform copy exists). Verify that the sample path is not excluded with `-CheckExclusion -Path`; retain its output and check the result before scanning.

```powershell
$sample = 'C:\samples\Synara-0.9.2-x64.exe'
$expected = 'fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb'
if ((Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash -ne $expected) {
    throw 'The sample does not match the official v0.9.2 installer.'
}
Get-AuthenticodeSignature -LiteralPath $sample | Format-List * |
    Out-File (Join-Path $evidence 'signature.txt')
# Replace this with the actual newest installed platform directory.
$mpcmd = 'C:\ProgramData\Microsoft\Windows Defender\Platform\<version>\MpCmdRun.exe'
& $mpcmd -CheckExclusion -Path $sample 2>&1 |
    Out-File (Join-Path $evidence 'exclusion-check.txt')
# Continue only after verifying the path is not excluded.
& $mpcmd -Scan -ScanType 3 -File $sample 2>&1 |
    Out-File (Join-Path $evidence 'scan.txt')
$scanExit = $LASTEXITCODE
$scanExit | Set-Content (Join-Path $evidence 'scan-exit.txt')
Get-MpComputerStatus | ConvertTo-Json -Depth 4 |
    Set-Content (Join-Path $evidence 'defender-after.json')
if (Test-Path -LiteralPath $sample) {
    Get-FileHash -LiteralPath $sample -Algorithm SHA256 |
        ConvertTo-Json | Set-Content (Join-Path $evidence 'hash-after.json')
}
```

Recapture detections and events after the scan. Microsoft documents that exit code **0 can also mean a threat was found and remediated**, and code **2 can mean a detection or a scan error**. Do not interpret either in isolation. A qualified result needs active antivirus/real-time protection, no applicable exclusion, completed scan output, the surviving expected hash, and no relevant detection/remediation. Archive scanning settings must be recorded; a scan which omits the embedded payload does not qualify its components. A complete-file scan still needs a separate browser-download reproduction of the `.crdownload` path.

If the outer installer is detected and the sample remains available, extract it with a trusted archive tool in the VM, without running its stub. Inventory and scan the NSIS plugins, `$PLUGINSDIR/app-64.7z`, extracted application, and unpacked native helpers separately. Hash components before scans and retain removals as detections. If quarantine prevents extraction, use the static inventory to plan independent component scans; do not bypass Defender to recover the file. Scan `app.asar` separately from executable/addon files and report its archive-format coverage as unverified unless established. Record the exact detected relative path and hash; do not infer it from the outer filename. Retain the current definitions for the baseline/candidate pair.

Commands and interpretation follow Microsoft's [MpCmdRun reference](https://learn.microsoft.com/en-us/defender-endpoint/command-line-arguments-microsoft-defender-antivirus), [Get-MpComputerStatus](https://learn.microsoft.com/en-us/powershell/module/defender/get-mpcomputerstatus), and [Get-MpThreatDetection](https://learn.microsoft.com/en-us/powershell/module/defender/get-mpthreatdetection). The automated release guard and diagnostic comparisons exercised these Defender APIs on disposable Windows Server 2022 runners; the manual Windows 11 browser procedure remains unexecuted. If evidence collection fails, retain the error as an unqualified attempt rather than treating missing records as a clean result.

## Prepared Microsoft analysis request

Submission requires separate authorization. Use the [Microsoft Security Intelligence submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission) as **Software developer**, selecting **Microsoft Defender Antivirus (Windows 11)**. The portal currently states a 50 MB file limit and asks for specific files rather than large installers. This installer is 225688617 bytes: do not assume it can be uploaded directly. First identify a detected component small enough to submit, or obtain Microsoft's approved route for the larger sample. Do not submit an unrelated small file as a substitute.

Prepared context, to supplement with actual engine/definition versions, detected component hash, reproduction output, and contact/company details:

> A user reports Microsoft Defender Antivirus removing Synara-0.9.2-x64.exe.crdownload as Trojan:Win32/Kepavl!rfn on Windows 11 24H2 build 26100.9457 while downloading the official release in Helium. The complete official installer is 225688617 bytes, SHA-256 fee21f614136df8ff0a1e97649886060625c843d34e724b62410164634928dcb, source a33435c18474eb7816582004e45f87382965ac8d. The official installer and Windows provenance are linked in this dossier. Both v0.9.1 and v0.9.2 were published unsigned. We independently reproduced quarantine of the exact official 0.9.2 installer with engine 1.1.26080.3 and definitions 1.459.485.0 on Windows Server 2022 while 0.9.1 passed. Extracted components and the inner app-64.7z passed individually. The detected context is the complete NSIS installer; the underlying classification trigger remains unidentified. Please analyze the classification. We are not claiming a confirmed false positive. No sample has been submitted yet.

## Remaining acceptance evidence

Independent Windows/Defender reproduction and matched repair-candidate scanning are complete. The original classification trigger and Windows 11 browser-download behavior remain unresolved. Repeat the browser download with Defender active on Windows 11 before claiming that surface is qualified. Signed-artifact qualification, if selected, must use the existing Azure signing/provenance path; signing alone is not an antivirus acceptance result. A repair is not delivered to users until the qualified artifact is released through the authorized release workflow.
