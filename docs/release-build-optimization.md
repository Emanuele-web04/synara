# Release build optimization evidence

Baseline: [v0.9.0 run 35659929299](https://github.com/Emanuele-web04/synara/actions/runs/35659929299),
source `f04341a67bc4941d1b2e91e0b23bbe782dfbc727`.
Validation: [build-only run 35711485748](https://github.com/Emanuele-web04/synara/actions/runs/35711485748),
source `be6aa59f3beeb03ffb942c2b43bd18c8e01be70e`, 2026-09-22. Both succeeded.
Each column is one observation, not an average or a controlled performance guarantee.
Original logs, new timestamped stage records and both job API responses were checked.

The validation ran `platform=mac-x64`, `stage=artifact`, `publish_release=false`,
with a cold Cua cache and no retries. It retained the complete preflight and signed
Intel packaging gates. Compare the path ending at the Intel job, rather than the
old full release's 57m06s, which also includes server packaging and publication.

| Comparable phase / path                  |               Baseline | Optimized cold CI |         Observed change |
| ---------------------------------------- | ---------------------: | ----------------: | ----------------------: |
| Initial workflow queue                   |                  7m25s |                5s |                  -7m20s |
| Preflight                                |                  9m42s |            11m51s |                  +2m09s |
| Icon job                                 |                    25s |               29s |                     +4s |
| Shared JavaScript job                    | Inside each native job |             2m12s | New shared prerequisite |
| Intel desktop job                        |                 36m11s |            17m59s |        -18m12s (-50.3%) |
| Preflight start through Intel completion |             **46m32s** |        **32m09s** |    **-14m23s (-30.9%)** |
| Trigger through Intel completion         |                 53m57s |            32m14s |        -21m43s (-40.3%) |

The execution comparison includes the new shared job, transfer, slower preflight,
inter-job gaps and final artifact checks. The queue reduction is unrelated to the
code change. The complete multi-platform release and warm-cache path were not run.
Parallel job durations must not be added to estimate elapsed time; the earlier
failed/cancelled runs also overlapped.

Both Intel jobs used `macos-15-intel`, image `20260824.0482.1`, macOS 15.7.9,
Xcode 16.4, Rust 1.97.1, Node 24.19.0 and Bun 1.4.2. The new capacity record
reports four available CPUs and 14 GiB RAM. Historical CPU/RAM and utilization
were not logged, so equal image versions do not establish equal runner load.
The shared JavaScript job used Ubuntu image `20260907.300.1`, four CPUs,
15.61 GiB RAM and Node 24.20.0.

| Intel phase                                           |             Baseline |                    Optimized cold CI | Interpretation                                             |
| ----------------------------------------------------- | -------------------: | -----------------------------------: | ---------------------------------------------------------- |
| Workspace dependency installation                     |                1m12s |                                  26s | Frozen installation retained                               |
| JS build through staging transition                   |                3m58s | Shared job 2m12s + native restore 7s | Shared job includes setup, 1m49s build and upload          |
| Cua source build                                      |                9m45s |                            6m39.514s | Both cold; not a cache speedup                             |
| Cargo within source build                             |                9m35s |                            6m32.464s | Compiler unchanged; variation not attributed to caching    |
| Entire new Cua action                                 | No equivalent action |                                6m56s | Includes toolchain setup, cache lookup and verified import |
| AppSnap helper                                        |            About 20s |                              18.250s | Native helper retained                                     |
| Staged dependency installation                        |               36.64s |                              26.507s | Platform-specific dependencies retained                    |
| App signing start through notarization and validation |            8m33.227s |                            3m43.715s | Historical signing/upload/wait cannot be separated         |
| DMG notarization and final validation                 |             4m01.86s |                            1m44.812s | Apple service time varies                                  |
| Update ZIP repack and validation                      |             1m04.41s |                              33.570s | Stapled app and updater metadata verified                  |
| Artifact provenance                                   |                  24s |                                  12s | Passed                                                     |
| Isolated packaged startup smoke                       |                  28s |                                  12s | Passed                                                     |
| Artifact upload                                       |                  42s |                                  22s | Passed                                                     |

The portable archive uploaded in about three seconds. Native download, extraction
and validation took seven seconds, including 2.200s in the importer. Turbo reported
zero of four build-task cache hits. Sharing these outputs is verified; attributing
the whole 30.9% elapsed reduction to code is not justified. Unchanged cold Cargo,
dependency installation and other local operations also ran faster on this Intel
runner, and Apple's earlier processing time was not separately observable.

The Cua log explicitly reported a miss for
`cua-v1-1bbf147cfac72c3da19a8f2ece1fef635dbaccd9253fe5377a31e7fc57398405`.
Fresh output passed provenance verification and two same-run imports (453ms into
the verified directory, 415ms into the package). These are not cross-run cache hits.
Default-branch production, cache restore time and warm-cache savings remain unmeasured.

The preflight regression is preserved: install 27s → 30s, typecheck 33s → 42s,
tests 8m25s → 10m22s. Server tests remained 500 passing files / 6,982 tests and
took 483.97s → 594.79s; unchanged web/shared/contracts suites also slowed down.
Both preflights used the same image/runtime/dependencies and no Turbo task hits.
The 44 added packaging tests ran in suites that finished well before the server.
This is consistent with runner variability, not proof of its cause.

### New notarization timings

| Phase                   |     App |                             DMG |
| ----------------------- | ------: | ------------------------------: |
| Signing and preparation | 87.939s | Included in container packaging |
| Submission archive      | 25.626s |                Already packaged |
| Upload                  | 16.456s |                         17.183s |
| Apple wait              | 81.780s |                         81.631s |
| Authenticated status    |   478ms |                           480ms |

Both submissions reached `Accepted`; logs were downloaded, tickets stapled and
validated, signatures checked, and the DMG passed Gatekeeper assessment. The final
ZIP was repacked and validated before provenance and isolated startup checks.
The new app hook is qualified for Intel by this run. Resume after an interrupted
submission, Apple Silicon, Linux and Windows packaging were not exercised.

Windows originally spent 1m21s installing workspace dependencies, about 1m22s
installing staged production dependencies and 4m08s in NSIS packaging. No
measured evidence justifies changing installer compression or adding generic
dependency/download caches in this patch. Cargo output reuse targets the larger
measured delay; Cargo registry/intermediate caches are not needed for a valid
artifact hit. No cache speedup is claimed before a real Actions hit.

## SDK-only follow-up attempt

[Run 35717648611](https://github.com/Emanuele-web04/synara/actions/runs/35717648611)
at `e4b3cdc05cd669fb70daaa0dd768c0999503a568` attempted one cold Intel A/B pair
against `d4f3b3107f5b3f1af41034e8b92a24c737c84503`. The candidate removes the
unused SDK `cdylib` output and retains `rlib`, with the same pinned source,
compiler and native protocol revision. No candidate performance or runtime
qualification was obtained.

The benchmark exported an incomplete Synara snapshot: it omitted
`docs/computer-use-cua/CUA-LICENSE.txt`. Baseline Cargo completed in
**943.080 seconds (15m43.080s)**, but the subsequent license copy failed with
`ENOENT`. The candidate compilation and both driver probes never started.
This was a benchmark harness defect, not a candidate compilation failure or an
artifact-storage failure. The baseline log was uploaded successfully (7,091-byte
archive); the compiler HTML report was not preserved by the original harness.

The run consumed 17m12s in the Intel job and 39s in Ubuntu preflight, with no
packaging, publication or automatic retry. The previous 6m32.464s cold Cargo
observation is not a valid before/after comparison with this incomplete pair.
Both used the same Intel image and pinned compiler, but this experiment also
used separate empty Cargo homes and timing instrumentation. Its slowdown cannot
be attributed to the candidate, which was never built.

The harness now exports the license, prepares and checks both snapshots before
compilation, verifies the native probe exists, and preserves compiler timing
reports even if later staging fails. A local preparation-only regression test
passed without Rust or network access. No further Actions run has been launched.
The retained 25-minute benchmark cap would not accommodate two builds at the
observed baseline speed; a future paired measurement needs an explicit time
budget decision. **No additional minute saved is claimed.**

## Preflight quality gates

The two Intel runs above showed the preflight itself getting slower (9m42s →
11m51s) with an unchanged test set. Both preflight logs were re-read step by step.
Turbo ran the six test packages concurrently in one four-CPU Ubuntu job, and the
critical path was the server package: 500 files run serially with
`--maxWorkers=1 --no-file-parallelism`, taking 483.97s and then 594.79s while the
web, desktop, shared, scripts and contracts suites finished within 3m30s. A
25-second contracts build (tsdown with declaration output) also preceded the server
suite because its Turbo test task depended on `@synara/contracts#build`.

Per-file server timings from the optimized run: `ProviderCommandReactor.test.ts`
98.20s (346 tests; 75.48s in the baseline), `AntigravityAdapter.test.ts` 27.21s,
`ProviderRuntimeIngestion.test.ts` 25.34s, `CuaComputerBackend.test.ts` 23.55s.
The 687 per-harness migration runs took 89.4s in total (mean 130ms; 65.0s and
95ms in the baseline), and unchanged files later in the serial order were also
20–40% slower, so the regression is consistent with runner variability rather
than the added tests. Locally the Antigravity, Cua, `computerTools`
(one 10-second `computer_wait` bound) and `authEffectRoute` files take the same
wall time as in CI because they wait on real timers; together about 65s of the
serial path. They were left unchanged: shortening them means rewriting
time-bound assertions, which is a separate, per-test change. The server suite
stays serial: 93 server test files use fixed `tmpdir()` paths and 9 bind fixed
ports, so in-process file parallelism was not attempted.

Changes, validated locally before the one CI measurement:

- `preflight` now resolves policy, scope and source provenance only (no install).
- A `quality` job runs the frozen install, brand check, lint, typecheck and every
  test package except the server; a `server_tests` matrix runs the server package
  in Vitest's native `--shard=1/3`, `2/3`, `3/3` lanes, the same geometry ci.yml
  already uses. Shards are assigned by a hash of each file path, so every file
  runs exactly once; nothing is skipped and no assertion changed.
- Portable, icon and native jobs now require `quality` and every server shard,
  and the smoke test asserts those prerequisites.
- The Turbo test task no longer depends on any build. All packages import
  `@synara/contracts` from source through its ESM `import` export. With the
  contracts build output deleted, the entire workspace suite passed locally under
  Node 24.13.1 (`bunx turbo run test --only --continue`: 500 server files /
  6,987 tests, 399 web files / 5,195 tests, 14,732 tests in total, 4m59s on
  18 CPUs). The same run under the machine's default Node 26 failed 28 web store
  tests on a read-only `localStorage` global, unrelated to the change.
- `stage=preflight` runs only these gates, so they can be measured without
  native builds, packaging or publication.

Measurement: [run 35725031035](https://github.com/Emanuele-web04/synara/actions/runs/35725031035)
at `acd7ddd1e832bec5afad6eae0e8ceca016b07521`, `stage=preflight`,
`publish_release=false`, dispatched from the branch on 2026-09-22. No retry
was run and no other run was triggered. **The run failed**: the `Server tests
(2/3)` job stopped after 27s in `bun install --frozen-lockfile`, before any test,
when the web package's `effect-language-service patch` prepare script crashed with
`TypeError: Cannot read properties of undefined (reading 'ES2022')` right after
logging that the shared TypeScript file was "already patched". Five workspace
packages run that prepare script against one `node_modules/.bun/typescript@5.9.3`
file and Bun runs lifecycle scripts concurrently, so this is a pre-existing race
that four parallel installs per run expose more often than one. The release
installs now pass `--concurrent-scripts=1`; that mitigation has not yet been
exercised in Actions. The other four jobs succeeded.

| Phase                              |            Baseline 35659929299 |           Optimized 35711485748 |                                                                               Sharded 35725031035 |
| ---------------------------------- | ------------------------------: | ------------------------------: | ------------------------------------------------------------------------------------------------: |
| Trigger to preflight start (queue) |                           7m25s |                              5s |                                                                                                3s |
| Preflight job                      |                           9m42s |                          11m51s |                                                                                 12s (policy only) |
| Dependency installation            |                             27s |                             30s |                                                             28s gates; 59s / 16s / 36s shards 1–3 |
| Lint                               |                              1s |                              1s |                                                                                                1s |
| Typecheck                          |                             33s |                             42s |                                                                                               42s |
| Contracts build before tests       |                            ~19s |                             25s |                                                                                              none |
| Non-server tests (web suite)       |      inside test step (141.08s) |      inside test step (182.49s) |                                                                          2m48s step (160.94s web) |
| Server tests                       | 483.97s, 500 files, 6,982 tests | 594.79s, 500 files, 6,982 tests |          1/3: 166.23s, 167 files, 2,598 tests; 3/3: 229.22s, 165 files, 2,840 tests; 2/3: not run |
| Test step (longest)                |                           8m25s |                          10m22s |                                                                                 3m52s (shard 3/3) |
| Gates start to last gate complete  |                           9m42s |                          11m51s |                                                 4m51s observed, but incomplete (shard 2/3 failed) |
| Ubuntu job time consumed           |                           9m42s |                          11m51s | 13m29s (12s + 4m11s + 4m02s + 4m37s + 27s failed); about 16–17m estimated with shard 2/3 complete |

Observed: the longest gate job fell from 11m51s to 4m37s, and every completed
job stayed under five minutes; the two completed shards ran 332 of the 500
server files and 5,438 of the 6,982 server tests with 0 failures. Estimated:
shard 2/3 holds the remaining 168 files (1,544 tests). Its predicted serial
time from the optimized run's per-file timings is about 100s of tests plus
import overhead, and the identical hash shard in ci.yml took 2m23s including a
cached install on 2026-09-21 (run 35659926878), so a complete run would most
likely still finish with shard 3/3 at about 4m40s–5m. That remains unverified.
Runner variability is visible inside this run: the same install command took
16s to 59s across four jobs. Summed Ubuntu time rises by roughly 4–5 minutes
per release because each shard repeats checkout, toolchain setup and the
frozen install; macOS and Windows consumption is unchanged, and the native jobs
still start only after every gate passes.

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
import overhead, not a paired release speedup. This machine has Xcode 27, not the
required Xcode 16.4/macOS 15 SDK. The hosted Intel results above qualify the signed
app/DMG/update-ZIP path; the other native platforms and warm Cua cache remain unverified.

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
All four workflow/action YAML files parsed successfully. These source-level checks
were followed by the successful signed Intel Actions run documented above.
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
App and DMG service waits remain sequential. Overlapping ZIP work was considered
but deferred; the Intel validation preserves the existing finalization ordering.

No larger/paid runners or infrastructure were enabled. Existing runner classes
remain unchanged. The default-branch producer consumes three native jobs when
relevant inputs change or an operator dispatches it; the portable build adds one
Ubuntu job and an artifact transfer. This targeted validation consumed 18m28s of
macOS job time (icon plus Intel) and 14m03s of Ubuntu job time (preflight plus
portable outputs), 32m31s combined. The old matching jobs consumed 36m36s macOS
and 9m42s Ubuntu. These are observed runner durations, not billed credits. The
old complete release consumed 99m30s across all platforms; comparing that total
to this single-platform validation would overstate savings. Actual billed cost
depends on cache reuse and repository entitlements and has not been established.
GitHub's [cache scope rules](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)
require the default-branch producer for reuse across distinct release tags.
