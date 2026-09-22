# Release build optimization evidence

Baseline: [v0.9.0 run 35659929299](https://github.com/Emanuele-web04/synara/actions/runs/35659929299),
source `f04341a67bc4941d1b2e91e0b23bbe782dfbc727`. One successful run, not an average.
The original timestamped logs and job API response were rechecked for this change.

| Critical-path phase        |            Baseline | Optimized cold CI                            | Optimized warm CI |
| -------------------------- | ------------------: | -------------------------------------------- | ----------------- |
| Initial workflow queue     |               7m25s | Not measured                                 | Not measured      |
| Preflight                  | 9m42s (tests 8m25s) | Not measured                                 | Not measured      |
| Icon job                   |                 25s | Not measured                                 | Not measured      |
| Intel desktop job          |              36m11s | Not measured                                 | Not measured      |
| Serialized server tarball  |               2m17s | Runs alongside desktops; duration unmeasured | Unmeasured        |
| Publication                |                 47s | Not run                                      | Not run           |
| Inter-job gaps             |                 19s | Not measured                                 | Not measured      |
| Execution span             |          **49m41s** | **Not measured**                             | **Not measured**  |
| Trigger through completion |          **57m06s** | **Not measured**                             | **Not measured**  |

Parallel desktop job durations must not be added. The earlier failed/cancelled
runs overlapped; their durations are not additive either.

| Repeated work                          | Original macOS arm64 | Original macOS x64 | Original Linux x64 | New measurement                                                 |
| -------------------------------------- | -------------------: | -----------------: | -----------------: | --------------------------------------------------------------- |
| JS build through staging transition    |                2m16s |              3m58s |        about 1m53s | Shared once; CI transfer unmeasured                             |
| Cua source setup through staged driver |            6m25.245s |          9m44.589s |          6m04.434s | Trusted exact-key reuse implemented; warm CI hit unmeasured     |
| Cargo compilation within that interval |                6m17s |              9m35s |              5m58s | Cold and warm CI unmeasured                                     |
| App signing through app acceptance     |                8m49s |              8m33s |                N/A | Separated into preparation/signing, upload, wait and validation |
| DMG notarization/final validation      |                6m46s |              4m02s |                N/A | Live progress and resumable exact-payload submission            |

Windows originally spent 1m21s installing workspace dependencies, about 1m22s
installing staged production dependencies and 4m08s in NSIS packaging. No
measured evidence justifies changing installer compression or adding generic
dependency/download caches in this patch. Cargo output reuse targets the larger
measured delay; Cargo registry/intermediate caches are not needed for a valid
artifact hit. No cache speedup is claimed before a real Actions hit.

## Local measurements

2026-09-22, macOS 27 arm64, 18 available CPUs, 48 GiB RAM, Node 24.13.1, Bun 1.4.2.
Same worktree; no native compilation or Apple service call was included. The
build had installed dependencies and no Turbo hits. Import samples followed
one warm-up import, sequentially, using the same local archive.

| Workload                                   | Samples | Wall time / size                      |
| ------------------------------------------ | ------: | ------------------------------------- |
| `bun run build:desktop`                    |       1 | 42.307s; 0/4 Turbo hits               |
| Manifest generation                        |       1 | 83ms                                  |
| Verify, unpack and import portable outputs |       3 | 1.671s, 1.642s, 1.627s; median 1.642s |
| Uncompressed portable tar                  |       1 | 47,443,968 bytes (45.2 MiB)           |

These are different workloads on a different host from CI. They establish local
import overhead, not a paired release speedup. Artifact upload/download costs,
default-branch Cua cache hit/restore timings, cold native builds and optimized
critical-path wall time remain unmeasured. No percentage savings is asserted.
This machine has Xcode 27, not the required Xcode 16.4/macOS 15 SDK, so it cannot
qualify the pinned native release path. Signed app/DMG/update-ZIP behavior,
Windows packaging and Linux native startup require targeted CI qualification.

Reproduce local output validation after `bun run build:desktop`:

```bash
mkdir -p /tmp/synara-portable-measurement
node scripts/portable-build.ts create /tmp/synara-portable-measurement/manifest.json "$(git rev-parse HEAD)"
tar -cf /tmp/synara-portable-measurement/outputs.tar apps/desktop/dist-electron apps/server/dist
node scripts/import-portable-build.ts /tmp/synara-portable-measurement "$(git rev-parse HEAD)"
```

Use the [targeted build-only commands](release.md#1-build-only-native-ci-validation)
for CI measurements. Compare the same source, platform and runner image with an
empty cache and an exact hit; record the action's `cache-hit` and complete key.
Preserve workflow queue separately from job execution. The new runner-capacity
step prints available CPU/RAM and image identity instead of assuming capacity
from a runner label. Existing logs did not capture CPU/RAM, so historical
resource saturation is unknown.

`[build-timing]` records carry ISO timestamps, status and wall duration. `local`
can include disk I/O or nested downloads; it is not measured CPU utilization.
Cua source fetch is labelled `download`; Apple's upload/status/wait are external
operations. `app-signing-and-preparation` includes electron-builder's sanity and
fuse preparation between `afterPack` and `afterSign`. Dependency installation,
artifact transfers and startup smoke also have separate Actions step timings.

## Notarization and cost boundaries

Local verification passed the full workspace suite (14,729 tests, 30 skipped),
formatting, lint (727 warnings, zero errors), all seven package typechecks,
release smoke and the Windows runtime boundary check. Subsequent digest/state
directory fixes passed focused packaging/provenance tests and script typecheck.
All four workflow/action YAML files parsed successfully. These are source-level
checks; hosted Actions execution and signed/platform packaging remain unverified.
The verified shared outputs also produced a local `synara-server-0.9.0.tar.gz`
(18,033,407 bytes); archive inspection confirmed version/name, both CLI entrypoints,
the bundled client and device-helper sources. No package was published.

The pinned electron-builder's `afterSign` used to occur after its buffered app
notarization. The mandatory repository hook now notarizes and staples the signed
app before either container is created; only the duplicate built-in notarizer is
disabled. DMG acceptance/stapling and the final stapled-app update ZIP remain
required. `notarytool submit` records an ID; human-readable `wait` streams progress;
authenticated `info` must say `Accepted`. Resume state binds the exact submitted
bytes and, after stapling, the resulting bytes. No acceptance shortcut is taken.

This follows Apple's [custom notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
and [distribution packaging requirements](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution).
No signed build has yet qualified the new hook. App and DMG service waits remain
sequential; overlapping ZIP work was considered but deferred to avoid changing
artifact finalization ordering without signed-platform evidence.

No larger/paid runners or infrastructure were enabled. Existing runner classes
remain unchanged. The default-branch producer consumes three native jobs when
relevant inputs change or an operator dispatches it; the portable build adds one
Ubuntu job and an artifact transfer. Actual billed cost/savings depends on cache
reuse, repository entitlements and transfer overhead and has not been measured.
GitHub's [cache scope rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
require the default-branch producer for reuse across distinct release tags.
