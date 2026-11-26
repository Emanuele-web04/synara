# Windows Defender investigation: issue #1376

Initial evidence was collected on 2026-09-30 for [issue #1376](https://github.com/Emanuele-web04/synara/issues/1376), from main `529ad049cb106c998010f5400189515008997aa4`. That investigation independently reproduced the 0.9.2 installer detection on disposable GitHub-hosted Windows Server 2022 runners. The 1.0.9 recurrence below is a separate investigation; neither establishes a malware verdict or Microsoft's false-positive determination.

## 2026-11-01: reported recurrence on 1.0.9

The requester supplied a third-party user's screenshot showing exactly
`Synara-1.0.9-x64.exe` and **`Virus detected`**. The affected user is not the
requester. Browser, Windows version, antivirus product/threat name, downloaded
hash, and engine/definition versions remain unknown; the requester cannot obtain
these details. The private screenshot is not included in this repository. Windows
11 is established only for the historical 0.9.2 report, not this recurrence.

The official `Synara-1.0.9-x64.exe` is **260335126 bytes**, SHA-256
`d8a0d6bd3bbc6e9128cbf40d0b63262b3a516221c25e017452bc6b4c94ebabc5`, from tag commit
`ebd0d22b39ce3a0f7c6051dddc6090e9b85dc7c3`.

| Qualification                                                                                           | Engine / definitions          | Cloud settings (MAPS / samples / disable first sight) | Result                                 |
| ------------------------------------------------------------------------------------------------------- | ----------------------------- | ----------------------------------------------------- | -------------------------------------- |
| [1.0.9 release](https://github.com/Emanuele-web04/synara/actions/runs/40203308105)                      | `1.1.26090.9` / `1.461.199.0` | `0 / 2 / true`                                        | Scan passed                            |
| [Fresh default-settings comparison](https://github.com/Emanuele-web04/synara/actions/runs/41331725970)  | `1.1.26100.4` / `1.463.73.0`  | `0 / 2 / true`                                        | Same official hash passed              |
| [Fresh cloud-enabled comparison](https://github.com/Emanuele-web04/synara/actions/runs/41331725970)     | `1.1.26100.4` / `1.463.73.0`  | `2 / 1 / false`                                       | Same official hash passed              |
| [Updated guard with MAPS validation](https://github.com/Emanuele-web04/synara/actions/runs/41333122864) | `1.1.26100.4` / `1.463.76.0`  | `2 / 1 / false`                                       | Same official hash passed; MAPS exit 0 |

These runs expose a release qualification gap: active antivirus and real-time
protection did not require cloud protection. The cloud-enabled comparison verified
preferences but did not run `-ValidateMapsConnection`. The guard now also requires
cloud protection, safe sample submission, block at first sight, and successful MAPS
connectivity before scanning; see the [release policy](release.md#3-azure-trusted-signing-setup-windows).
Automatic safe sample submission applies only to the disposable GitHub-hosted
public-release runner, never the user's machine.

The [native guard run](https://github.com/Emanuele-web04/synara/actions/runs/41333122864)
passed on the exact official installer bytes. `-ValidateMapsConnection` returned
exit 0 and `ValidateMapsConnection successfully established a connection to MAPS`;
the scan explicitly found no threats and the expected hash survived. The ten
mocked guard contract tests also passed on Windows; they remain distinct from this
real Defender scan.

The same run observed a **SmartScreen download reputation warning** in native
Edge `156.0.4314.42` on Windows Server 2022 build `20348.5761`. The official download
URL produced a **260335126-byte `.crdownload`**, while the Downloads page stated
`Synara-1.0.9-x64.exe isn't commonly downloaded`. Inspection of `edge-security.png`
confirmed SmartScreen enabled and the potentially unwanted apps toggle off;
`edge://policy` and the registry capture showed no configured policies. The
probe's automatic `browserSecurityStateVerified=false` field was not used as a
verdict; the security-state conclusion comes from reviewing the captured controls.

No **Keep**, **Unblock**, **Open**, or **Run** action was taken. Closing Edge cancelled
the pending download, leaving no final installer or final-file hash. This does not
establish quarantine, a matching browser-delivered hash, or browser acceptance.
Defender event collection succeeded with no detection/remediation events, and the
post-attempt detection inventory was empty. The [1.0.9 evidence index](evidence/windows-defender-1376-1.0.9.json)
records the separate scanner and browser results and their source artifacts.

The first browser phase of the [native Chrome run](https://github.com/Emanuele-web04/synara/actions/runs/41335794530)
completed the official download in Chrome `156.0.8078.48` on Windows Server 2022
build `20348.5761`. The **260335126-byte** final file matched the official SHA-256
before and after browser closure and retained its Internet-zone marker (`ZoneId=3`).
Download history recorded complete, no danger or interruption, and never opened.
The captured security controls show **Standard protection** selected; the only
configured Chrome policy was `DefaultBrowserSettingEnabled=false`. Defender
remained active with engine `1.1.26100.4` and definitions `1.463.76.0` unchanged,
MAPS validation returned exit 0, and event collection found no detections or
remediations. No protection bypass or execution was attempted. These were the
first observed runner definitions, not reconstructed historical user definitions.

The subsequent guard phase in that run failed at `Update-MpSignature` with
`The remote procedure call failed.`; the later browser phase was skipped. Thus,
the successful initial download does not establish a completed comparison across
definition versions. The recorded guard hash matches the version **before** the
bounded update retry. The guard now allows at most three attempts per source and
falls back to direct MMPC updates after exhausted default-source attempts or stale
definitions. It preserves each error and still requires a successful update call
and every existing qualification check. Nineteen mocked contract tests pass on
Windows in the latest candidate run below; live fallback recovery remains separate
from these contract tests and this Chrome result.

The [earlier build-only candidate run](https://github.com/Emanuele-web04/synara/actions/runs/41336992485)
passed real Defender scanning, MAPS validation, and packaged dependency/startup
smoke. It tested **258686811 bytes**, SHA-256
`51167f9f9e2aea0227581fc80a99bcccbefa86e90be3a0ef992474cb002b55ca`, from source
`df70c58bd713b2f67f8d5394f787782d6b13c6f6`; this is an unpublished candidate,
separate from the official `d8a0d6…abc5` installer above. Definitions advanced from
`1.463.33.0` to `1.463.76.0` without a recorded update error. The run also passed the
then-current 14 mocked contracts, but did not exercise live RPC recovery or the
new direct fallback.

A [second attempt on that same candidate](https://github.com/Emanuele-web04/synara/actions/runs/41337351655)
used the preceding guard and failed before scanning: the first default update
returned an RPC error, and the next two reported that definition updates completed
with errors. All three errors were retained and `results.json` was empty. This
motivated the direct fallback; it is not a failed installer scan.

The [third attempt](https://github.com/Emanuele-web04/synara/actions/runs/41338137765)
still stopped before MMPC or scanning: an intermediate state snapshot failed in
`Get-MpPreference` with `0x800106ba` while the service was unavailable. Commit
`f86ed905b` removes that intervening read after exhausted default updates, so the
guard can reach the mandatory direct update. Its negative control covers
unavailable state APIs until MMPC succeeds.

The [fourth attempt](https://github.com/Emanuele-web04/synara/actions/runs/41338964132)
passed the final guard, all **19 mocked contracts**, and packaged startup on the
same earlier `51167f…b55ca` candidate. Defender platform `4.18.26100.4` was already
installed before qualification; definitions advanced from `1.463.33.0` to
`1.463.76.0` with no update errors. This proves healthy live qualification, not
recovery from a live RPC failure or execution of the direct fallback.

That run also exercised the packaged runtime under Electron `43.4.1` / Node
`24.18.1`: Pi's lazy API/client propagated a **synthetic HTTP 400 with networking
blocked**; Codemode ran its actual worker and QuickJS WASM; Photon used its actual
worker without recorded errors; the MCP child completed initialization/list/call
and exited. The isolated compaction CLI reduced **16805888 → 16384 bytes** with
integrity and cleanup checks. These are offline packaged-runtime checks, not live
provider success.

The [new combined build](https://github.com/Emanuele-web04/synara/actions/runs/41337355328)
completed packaging, quality checks, and all three server shards. Its preceding
guard failed after three default-source update errors, so it preserved a verified
checkpoint rather than qualifying the installer. This new unpublished candidate
is **258698471 bytes**, SHA-256
`be7ceb4a1b128bafafb72f08368a34583d34d9dac49d5b833d95faa05168bc25`, from source
`9dffe5f0581b4b27874763995b46e493334ab577`. It is distinct from both the older
`51167f…b55ca` candidate and the official `d8a0d6…abc5` release.

The [Windows Server 2025 qualification](https://github.com/Emanuele-web04/synara/actions/runs/41340891133)
then exercised the final guard on those exact new bytes and **recovered from real
update failures**. The default source failed three times (one RPC error, then two
definition-update errors); MMPC failed once and succeeded on its second attempt.
All four errors survived in evidence. The platform advanced from `4.18.26090.9`
to `4.18.26100.4` while definitions remained `1.463.76.0`. The 19 mocked contracts,
MAPS validation, clean scan with unchanged hash, packaged startup, and the same
offline Pi worker/MCP/compaction checks all passed. This establishes live fallback
recovery on that Server 2025 runner and candidate; the earlier healthy run alone
did not establish it.

The [matching Windows Server 2022 run](https://github.com/Emanuele-web04/synara/actions/runs/41341037041)
also passed on the same `be7ceb…bc25` bytes: all 19 contracts, MAPS, clean scan,
unchanged installer hash, packaged startup, and the offline Pi/MCP/compaction
checks. Its default update completed without errors, so it did not exercise the
fallback. Platform `4.18.26090.9` remained unchanged; the engine advanced from
`1.1.26090.9` to `1.1.26100.4` and definitions from `1.461.211.0` to `1.463.76.0`.
Cloud settings remained `2 / 1 / false` and the detection inventory was empty.
Thus the Server 2022 production runner is qualified independently, while the
Server 2025 run supplies the observed live recovery. The [candidate evidence index](evidence/windows-defender-1376-candidate-runtime.json)
keeps every artifact, operating-system scope, and historical failure separate.
The candidate source predates later main changes, which were checked separately
in local integration; neither this diagnostic qualification nor those checks are
a published release or a reproduction of the third-party download block.

No current Defender antivirus detection was reproduced. The observed Edge reputation
warning differs from the third-party screenshot's **`Virus detected`** message.
Chrome completed this download without reproducing that message either.
This guard repair therefore remains unconfirmed as a fix for the reported 1.0.9
block; the antivirus or browser component responsible and its cause remain unresolved.
The sections below preserve the separate September 2026 investigation and its
historical results.

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
