# CI setup and execution

The required check remains **Format, Lint, Typecheck, Test, Browser Test, Build**.
It aggregates results only. Static checks start independently. Normal code
changes run typechecking, five unit partitions, six stable browser partitions,
desktop build, native Windows regression and migration lineage. Docs-only
detection and nightly geometry ownership are unchanged.

After workspace setup and CI contract validation, `static-fast` uses GitHub
Actions' native `parallel` group for identity, Windows boundary, formatting,
lint and release smoke. These checks read the installed workspace; release
smoke writes only to its own temporary fixture directory. Each check retains
separate step logs, and the group waits for all checks and fails the lane if any
check fails. Installation stays sequential, including the shared lifecycle
patches. This overlaps work on one runner; it does not add runner capacity or
establish an overall CI speedup without hosted measurements. See the
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel).

The Linux PTY dependency smoke runs once, on the first server shard; the Windows
PTY smoke remains a separate native check. The desktop lifecycle smoke exercises
the real Electron browser integration. The synthetic Energy Cloud A/B benchmark
runs only through its dedicated workflow, not on every PR build: it measures
copied baseline/candidate algorithms and adds no application regression assertion.
This removes twelve ten-second measurement waits from the blocking build lane.

The desktop build lane also runs the composer-focus Electron regression under
Xvfb. It covers navigation in previews, visible native views and renderer guests,
plus popup opener/POST/close behavior and deliberate browser input. The test
disables host focus emulation and checks focus, draft text and selection before
sending synthetic input. Run it locally with
`bun run --cwd apps/web test:electron:e2e visibleBrowserMcp.e2e.ts --grep 'preserves composer keyboard ownership'`
from an unlocked graphical session. It does not certify physical keyboard or IME
delivery on macOS or Windows.

Windows checks are grouped by package, removing six separate Vitest startups
while keeping the same runtime, lifecycle and migration test files. The credential
reader's filtered compilation test and native Bun PTY probe remain separate.

## Install scopes and caches

The shared setup action defaults to `full`. Typecheck, Linux unit/browser and
desktop build jobs keep the entire workspace. Only verified consumers opt into
smaller installs:

- `static`: root and `@synara/scripts`, including its workspace dependencies.
  Identity, Windows boundary, formatting, lint, release smoke and CI contract
  tests all run. Root-only or root + shared installs cannot own release smoke.
- `runtime`: all workspaces except marketing. Windows runs every existing native
  PTY/process/filesystem/shutdown/recovery test with lifecycle scripts enabled.
- Native release artifact builders exclude marketing with `--ignore-scripts`
  exactly as before. macOS device jobs select `@synara/scripts`, retaining their
  existing `--ignore-scripts`, Xcode pairs, probe, simulator smoke and diagnostics.
- Intel startup qualification (`qualify_intel`) selects `@synara/scripts` and
  `@synara/cli` with `--ignore-scripts`. The smoke also imports the server's
  supervised process teardown, so `@synara/scripts` alone cannot resolve `effect`.

Filtered scopes never restore/save a full `node_modules` archive. Windows
installs cold rather than extracting the pathological Bun package cache. Its
install cache lives under `RUNNER_TEMP`, on the hosted checkout's drive, matching
the measured install layout and allowing Bun to hardlink package files. Full
Linux installs restore their modules cache in every lane, but only one job per
key saves it after a miss (`save-modules`): `static-typecheck` owns the shared
Linux key, Desktop Build owns the `electron: true` key, and the macOS
editor-integration job owns its macOS key. Every other lane is restore-only, so a
miss is archived once instead of by a dozen parallel lanes racing to reserve the
same key. There is no separate Bun package archive: it hashed the same files as
the modules key, so it could only miss when modules missed. Frozen installation
and lifecycle patches still run on cache hits. Lifecycle scripts use `--concurrent-scripts=1` in every
scope: multiple workspace `prepare` hooks patch the same TypeScript files, and
parallel hooks can read a partially written compiler file. Scripts and dependency
patches remain enabled. The September measurements below predate this serialization.
Turbo persistence is opt-in (Desktop Build). Pull requests restore the newest
main entry and never save; only pushes to `main` save a per-commit entry, so PR
runs stop adding PR-scoped archives that no other branch can read.
OS, architecture and lockfile boundaries prevent incompatible archive reuse.
Test and typecheck task results remain uncached.

Release smoke shares the static runner, removing one checkout/install/runner and
one duplicate identity scan. The platform-independent Windows boundary scanner
runs there once; native Windows validation is not removed. Release quality lanes
still install the full workspace and run the audited test suite while unsigned
preparation and packaging proceed in parallel. Packaging waits only for
preflight, the macOS icon catalog, portable JavaScript and Cua preparation;
`quality` and every `server_tests` shard gate GitHub and npm publication directly
(see [the release guide](../docs/release.md)). Signing, notarization, source
provenance, publication and production dependency staging are unchanged.

## Cross-platform setup measurements: September 14, 2026

Application baseline: `70f5ed0e4757c0f69891b258171da80d324f0e18`. The successful
[baseline main CI](https://github.com/Emanuele-web04/synara/actions/runs/34792874548)
took 323 seconds and 2,158 raw runner-seconds across 16 jobs. These are observed
samples, not a promise for every hosted runner. No percentage below describes an
entire signed release.

The [cross-platform install experiment](https://github.com/Emanuele-web04/synara/actions/runs/34822416944)
used three observations per variant on each runner, fresh worktrees and dedicated
empty `BUN_INSTALL_CACHE_DIR` directories. Variant order reversed on the middle
repetition. Linux/Windows included lifecycle scripts; both macOS variants used
the release workflow's existing `--ignore-scripts`.

```text
Install segment                              Full median  Scoped median  Reduction
Windows runtime                              42.33 s      32.90 s        22.3%
Linux static (root + scripts)                 27.85 s       7.55 s        72.9%
macOS ARM64 release dependencies              23.27 s      11.48 s        50.7%
macOS Intel release dependencies              61.12 s      42.69 s        30.2%
macOS ARM64 device dependencies               23.27 s       2.07 s        91.1%
macOS Intel device dependencies               61.12 s       7.02 s        88.5%
```

The corrected static scope was measured in a
[separate same-source Ubuntu job](https://github.com/Emanuele-web04/synara/actions/runs/34823971221):
7.55 / 7.47 / 7.68 seconds. Intel release measurements were noisy: full
61.12 / 269.19 / 54.96 seconds, scoped 29.68 / 42.69 / 106.97 seconds. Its median
improved but not every pair did. Linux runtime filtering measured 27.85 to 24.08
seconds, but full Linux jobs retain their healthy warm modules cache.

[Native artifact validation](https://github.com/Emanuele-web04/synara/actions/runs/34822950006)
passed Linux AppImage, Windows NSIS, macOS ARM64 DMG and Intel DMG builds plus
packaged-startup smoke with filtered installs. Both macOS native device probes
also passed. These were **unsigned build-only checks**, not signed publication or
all Xcode/simulator combinations.

## Critical-path attack

The previous warm confirmation
[run 34829293225](https://github.com/Emanuele-web04/synara/actions/runs/34829293225)
completed in 308 seconds and 1,943 raw runner-seconds (32.38 minutes). The browser
`chat-workflows` job was the critical lane, followed by server and component
partitions. The experiments below target those measured paths rather than adding
generic concurrency.

### Stable browser runtime preparation

The [runtime benchmark](https://github.com/Emanuele-web04/synara/actions/runs/34832610297)
ran three repetitions of Playwright `install --with-deps chromium` and `install
chromium` after the same browser-cache restore. Every browser-only repetition then
launched Chromium, created a page and verified DOM content.

```text
Preparation             Observations (s)         Median
--with-deps chromium     21.24 / 16.86 / 12.38   16.86
chromium only             0.75 /  0.55 /  0.65    0.65
```

That removes **96.1%** of this preparation segment. The hosted Ubuntu image
already contains the shared libraries needed by stable tests; `--with-deps` was
re-running apt and installing rendering fonts on every shard. Stable CI now uses
`playwright install chromium`. Nightly geometry retains `--with-deps` because
fonts/layout are part of that quarantine's purpose. If a future runner image loses
a required system dependency, the blocking browser lane fails rather than silently
reducing coverage.

### ChatView three-way distribution

The same benchmark compared the current two complementary ChatView projects with
three complementary projects. All three paired repetitions preserved exactly 126
executed stable tests with no overlap or omission, and every candidate command
passed.

```text
Metric                         2-way median   3-way median   Change
Slowest test command              213.75 s       170.42 s    -20.3%
Summed test-command time          416.31 s       487.28 s    +17.0%
```

The accepted groups are follow/scroll/tool, project/worktree/approval/queue, and
a complementary fallback that owns every other current or future stable ChatView
case. This is deliberately a feedback-latency tradeoff: one additional runner is
used, while test bodies, assertions, timeouts and quarantine semantics stay intact.

### Server native three-way sharding

The [server benchmark](https://github.com/Emanuele-web04/synara/actions/runs/34833458963)
compared Vitest's existing native two-way shard assignment with native three-way
assignment. Each repetition ran both variants on the same runner and reversed
order in the middle repetition. Exact JSON inventories matched at 5,030 assertion
results (5,025 distinct inventory keys) with no shard overlap; all repetitions
passed. Repeated test titles account for the difference; their multiplicities
also match between variants.

```text
Metric                         2-way median   3-way median   Change
Slowest test command              212.26 s       174.46 s    -17.8%
Summed test-command time          400.41 s       406.44 s     +1.5%
```

The package remains serial internally (`maxWorkers=1`, no file parallelism); only
the number of independent CI shards changes. This is separate from the rejected
custom timing-aware sequencer below.

### Component native three-way sharding

The [component benchmark](https://github.com/Emanuele-web04/synara/actions/runs/34833550200)
compared the existing two native file shards with three native file shards. All
three repetitions preserved exactly 411 assertion results (408 distinct inventory
keys), including repeated-title multiplicities, with no overlap or omission and
passed.

```text
Metric                         2-way median   3-way median   Change
Slowest test command              231.85 s       190.19 s    -18.0%
Summed test-command time          389.11 s       437.00 s    +12.3%
```

Serial browser execution remains enabled inside each runner. One extra shard buys
lower feedback latency; the full-CI measurement decides whether its added compute
is acceptable.

## November 2026 critical-path rebalance

An audit of 150 `ci.yml` runs (November 2–11) measured a median code-PR wall
time of 641 s (p90 788 s). Test execution was about 93% of the slowest job.
Queueing and setup were not the problem. These changes keep every test, the
runner count and serial execution inside each lane unchanged.

### Server pinned shard placement

Vitest's native `--shard` hashes file paths into equal file counts, not equal
time. Native assignment put the three heaviest server files on shard 3, and the
shard medians were 400 / 207 / 559 s. The per-file table of
[run 43021234651](https://github.com/Emanuele-web04/synara/actions/runs/43021234651)
(test plus import time, temporary reporter since reverted) showed:

```text
Shard  Wall (s)  Tests (s)  Import (s)  Heaviest files (s)
1/3     333.9     252.8       62.7     deviceTools 77.8, CheckpointReactor 51.4, AntigravityAdapter 28.6
2/3     176.5      80.7       73.7     ProjectAgentService 15.7, compactDatabase 6.7
3/3     580.5     438.5      112.3     ProviderCommandReactor 167.4, GitCore 50.4, ProviderRuntimeIngestion 47.8,
                                       ProviderService 24.7, accountLiveActivityReporter 22.2
```

`apps/server/vitest.shards.ts` keeps Vitest's native slices and moves two whole
files, `ProviderCommandReactor.test.ts` and `accountLiveActivityReporter.test.ts`,
from shard 3 to shard 2. Every other file keeps its native shard. Averaged over
this run and main's run 42920466967, the projected walls are about 369 / 373 /
373 s. This is not the rejected timing-aware sequencer: there are no timing
hints and nothing is reordered, only two named files move. The order inside a
shard is unchanged and each shard stays serial (`--maxWorkers=1
--no-file-parallelism`). `scripts/server-ci-shards.test.ts` resolves the real
config for every shard and checks the result. Every collected file runs on
exactly one shard, the pinned files land where expected, and every other file
matches native assignment. Native assignment in run 43021234651 executed 677
files and 10,075 tests (10,038 passed, 37 skipped) across the three shards.

The isolated baseline variant of the
[paired benchmark](https://github.com/Emanuele-web04/synara/actions/runs/43023542738)
ran the pinned layout three times per shard on hosted runners. All repetitions
passed and still collected all 677 files (226 / 228 / 223):

```text
Shard  Before (audit median)  After: repetitions (s)   After median
1/3          400 s              377 / 388 / 388           388 s
2/3          207 s              340 / 283 / 339           339 s
3/3          559 s              284 / 388 / 322           322 s
```

The slowest server shard median falls from 559 s to 388 s. Shard 1/3 is now the
slowest; it is unchanged by this commit.

### ChatView group rebalance

Every executed ChatView test is listed in the stable lane logs (all exceed the
300 ms slow-test threshold). In main's
[run 42920466967](https://github.com/Emanuele-web04/synara/actions/runs/42920466967)
each lane paid about 90–110 s of fixed import, then:

```text
Lane            Tests  Test time (s)  Import (s)  Wall (s)
chat-follow        31        219.1        104.3     328.3
chat-projects      67        146.8        108.4     259.9
chat-workflows    170        291.0         88.2     383.0
```

The projects group now also owns titles that contain `sidebar` or `handoff`:
24 tests and 54.4 s of measured time, moved from the workflows fallback.
Projected walls are about 328 / 314 / 329 s. Follow keywords still take
precedence, so `keeps subagents out of the sidebar while navigating (… scroll
takeover …)` stays in chat-follow. The workflows group is still the complement
and owns unknown future cases. The `[geometry:linux]` quarantine and serial
execution are unchanged. `scripts/browser-ci-partitions.test.ts` now names the
lane that each sample title must land in, not only that it lands in exactly one.

[Run 43023542613](https://github.com/Emanuele-web04/synara/actions/runs/43023542613)
measured the result. Every ChatView lane passed, with the same 268 executed tests
(31 + 91 + 146):

```text
Lane            Tests before/after   Wall before (s)   Wall after (s)
chat-follow          31 / 31              328.3            329.7
chat-projects        67 / 91              259.9            260.0
chat-workflows      170 / 146             383.0            281.2
```

chat-projects absorbed 24 tests without a measurable increase. This single run
is noisy: the moved tests were measured at 54 s on main. The slowest ChatView lane
is now chat-follow, which is unchanged. In the same run, components 3/3 (420.9 s)
became the slowest browser lane; its native file sharding is unchanged.

### Cache ownership

In [run 43021234651](https://github.com/Emanuele-web04/synara/actions/runs/43021234651),
the logs of typecheck, Desktop Build and chat-projects show exact-key
`node_modules` hits (994 MB, 20–31 s restore steps, `bun install` 1–2 s
afterwards). The designated savers skipped `Save node_modules` because nothing
missed. Desktop Build restored main's newest Turbo entry through the restore-key
prefix (100 MB, 2.3 s), its build reported FULL TURBO (1 s), and it saved
nothing. The miss path (one designated saver, every other lane restore-only)
follows from the step conditions guarded by `ci-contracts.test.mjs`. It was not
exercised on hosted runners, because this branch does not change `bun.lock`.

## Release pipeline: November 2026

An audit of 20 tag runs (`v1.0.6-remote.31` to `v1.5.2`, October 25 to
November 11) measured a clean Stable release at 21–30 minutes from tag to
publication. The critical path was preflight (15 s), the packaging
prerequisites, the macOS packaging leg (p50 787 s, of which
`Build desktop artifact` took 642 s), Intel qualification on Stable
(135–225 s) and publication (62 s). `quality` and `server_tests` were never on
it: they finished at least 296 s before publication could start, so they are
unchanged. Seven of the 20 releases needed a rerun, losing about 198 minutes. In
five of them GitHub could not acquire a hosted macOS runner: the icon compile on
`macos-26` (3 times), macOS Cua preparation on `macos-15` (3 jobs) and one macOS
packaging leg.

Signing, notarization, stapling, provenance and the quality and publication
gates are unchanged. Two build-only release runs of version 1.5.2
(`publish_release=false`, signed and notarized),
[A1](https://github.com/Emanuele-web04/synara/actions/runs/43120433988) and
[A2](https://github.com/Emanuele-web04/synara/actions/runs/43123721500), measured
the changes against the
[v1.5.2 tag run](https://github.com/Emanuele-web04/synara/actions/runs/43100375555).
Seconds:

```text
Segment                                              v1.5.2     A1     A2
macOS arm64 packaging job                               756    675    721
macOS arm64 Build desktop artifact step                 602    546    574
macOS x64 packaging job                                 755    784    925
macOS x64 Build desktop artifact step                   660    664    699
macOS x64 Install dependencies (unchanged here)          21     31     77
Windows packaging job                                   617    718    670
Windows Build desktop artifact (unchanged; p50 406)     337    418    403
Linux x64 packaging job                                 283    159    156
Linux arm64 packaging job                               177    151    149
Intel qualify job                                       151    110    154
Intel qualify install step                               68     36     43
First packaging leg start after run creation            415    548    490
Whole run (v1.5.2 includes 67 s of publication)        1474   1450   1584
```

The macOS x64 leg did not get faster in these two samples. Hosted-runner
variance on that leg is larger than the expected saving: its install step, which
this work did not change, took 21, 31 and 77 s. The Windows build step, also
unchanged, ranged 337–418 s against a 20-release p50 of 406 s. No overall
release percentage is claimed. A1 and A2 also ran the native-helper overlap that
was then reverted (see the rejected experiments), so their macOS build steps
include it. Packaging started later in both branch runs because they compiled
every Cua driver from source and took the icon miss path (see below).

### Linux arm64 Cua pre-warm

`cua-release-cache.yml` pre-warmed only macOS arm64/x64 and Ubuntu x64. Since
Linux arm64 packaging was added (#2110), every release compiled that driver
from source, and `build` waits for the whole `prepare_cua` matrix. The producer
now also runs `ubuntu-24.04-arm`/`arm64`, the pair the release matrix uses.
`scripts/lib/release-build-scope.test.ts` fails when the producer's runner and
target pairs stop matching the release Cua matrix. The cache key is unchanged
in shape, so the first hit needs one successful producer run on `main`.

The pre-warm is still unmeasured. It takes effect only after the producer has
run on `main`. Both branch runs built Cua from source on all four legs (296–468 s each),
because changing `find-cua-artifact.mjs` changed every Cua key.

### macOS icon catalog

The release compiled `assets/{prod,beta}/Synara.icon` on a `macos-26` runner for
every tag. The default-branch producer now compiles both sources (Stable and
Remote share production) on `macos-26` with Xcode 26.3, saves the exact key to
the Actions cache and retains the catalog for 30 days as an artifact.
`scripts/mac-icon-catalog.ts` owns the key, the compile and the verification for
both the producer and the release, so a cached and a freshly compiled catalog
come from the same source selection (`brand-assets.ts`) and `actool` arguments.

The key hashes every file of the Icon Composer source, the `actool` arguments,
the runner label, the pinned Xcode version and developer directory, and the key
and compile code. It cannot include the `macos-26` image's patch level: the
release computes it on Linux before any install. The producer therefore
recompiles on every run (and daily), and it fails when the runner's
`xcodebuild -version` is not Xcode 26.3. Two local compiles of the same source
produced different `Assets.car` bytes, so verification checks the recorded
digest, not reproducibility.

In `release.yml`, `restore_mac_icon` (Ubuntu, read-only, no secrets) restores the
exact key from the cache or from the trusted producer's artifact
(`find-cua-artifact.mjs`, which now accepts `mac-icon-v1-` keys with unchanged
trust checks). It verifies the key, source, pinned Xcode, catalog magic and
digest, then publishes this run's `mac-icon-catalog`. A corrupt hit fails the
job. `build_mac_icon` compiles on `macos-26` only on a miss; the icon-only
validation stage (`stage=icon`) never restores, so it still exercises the
compile. `build` accepts exactly one source: a successful restore with a hit and
a skipped compile, or a successful restore with a miss and a successful compile.
`release-smoke.ts` evaluates those conditions for hit, miss, failure and
`build_icon == 'false'`. Packaging still
downloads only this run's `mac-icon-catalog` and still fails without
`Assets.car`. The cache path is workspace-relative because the cache version
hashes the literal path, which differs between macOS and Linux `runner.temp`.
The version also hashes the compression method; cross-OS cache restore is
therefore unproven, and if it misses, the 30-day artifact serves the same key.

Changing `find-cua-artifact.mjs` changes every Cua cache key. Its push to `main`
triggers the producer; let that run finish before the next tag, or that release
compiles Cua from source once.

The hit path is still unmeasured: it needs a producer run on `main`. Both branch
runs took the miss path. The Linux restore job took 12–16 s, then the `macos-26`
compile took 38 s after a 130 s queue in A1 and 31 s after a 3 s queue in A2.
Both runs packaged and qualified with the compiled catalog.

### macOS Cua preparation stays on macOS

Running exact-hit macOS Cua restores on Linux was evaluated and rejected. The
key includes `sw_vers`, `xcodebuild -version`, the SDK version and build, the
host compiler and the Rust toolchain, which only the macOS runner can report.
`provision-cua-driver.mjs` refuses Darwin validation off macOS, checks
architectures with `lipo` and re-signs the staged driver with `codesign`.
Packaging recomputes the key on macOS and requires an exact `build-key.txt`
match. Moving the restore would either break that check or move it into the
job that holds the signing secrets.

### macOS packaging overlap

Inside `Build desktop artifact` the stages ran one after another:

```text
Stage (audit, per macOS leg)        Duration
appsnap-helper                       18-24 s
production-dependencies              12-14 s
app-signing-and-preparation          78-154 s
app notarization                    165-220 s
DMG build                            ~40 s
dmg-notary-wait                     119-179 s
update-zip                           40-50 s
```

`scripts/build-desktop-artifact.ts` now runs signed DMG finalization and the
update ZIP concurrently through `scripts/lib/settle-concurrently.ts`. Both sides
always finish before a failure is reported, so no subprocess keeps writing into
the stage. The app is notarized and stapled during packaging; DMG finalization
verifies, notarizes and staples only the disk image, while the ZIP reads that
app and writes its own ZIP and feed. `ditto` and `unzip` now run asynchronously,
so a long archive no longer blocks the event loop that watches
`notarytool wait`; the two short `codesign` checks stay synchronous. Signature
checks, ZIP contents, names and the feed are unchanged. Unsigned builds stay
serial. Running the native helper builds beside the production install was
measured and reverted; see the rejected experiments below.

Each stage keeps its `[build-timing]` line, so those lines now overlap. The new
`dmg-notarization-and-update-zip` line records the pair's wall time.
`update-zip` may include up to the DMG upload (17–24 s) because that upload
still runs synchronously. `mac-update-zip-finalize.test.ts` fails if the ZIP
blocks the event loop again. Before is the serial sum of `dmg-notary-upload`,
`dmg-notary-wait` and `update-zip`; after is the pair's wall time (seconds):

```text
Leg      v1.5.0  v1.5.1  v1.5.2      A1    A2
arm64       234     186     196     155   145
x64           -       -     194     145   178
```

Other macOS stages were noisy and unchanged by this work: `electron-packaging`
took 487 / 434 / 358 s on arm64 before (v1.5.0 / v1.5.1 / v1.5.2) and 355 / 392 s
after, and 425 s on x64 before (v1.5.2) and 475 / 450 s after.
`app-signing-and-preparation` ranged 77–161 s in both periods.

### Intel qualification install

`qualify_intel` installed every workspace except marketing (75 s in the audit).
The startup smoke imports `@synara/scripts` code and
`apps/server/src/platform/supervisedProcessTeardown.ts`. In local throwaway
exports, a `@synara/scripts`-only install failed to resolve `effect` from that
server file. Adding `@synara/cli` resolved the whole import graph:

```text
Install scope (local, warm Bun cache)        Packages  node_modules  Smoke imports
all but marketing (previous)                     1404     2.7 GB      resolve
@synara/scripts + @synara/cli (now)              1129     1.5 GB      resolve
@synara/scripts only                              445     329 MB      fail (effect)
```

The smoke command is unchanged. `release-smoke.ts` rejects a filtered
verification install without both workspaces. On hosted Intel runners the
install step took 68 s in v1.5.2 and 36 and 43 s in A1 and A2; the whole job
took 151, 110 and 154 s.

### Release checkout depth

The packaging legs and `prepare_cua` fetched full history. Packaging reads only
the checked-out commit (`git rev-parse HEAD`, a clean `git status` and file
bytes); provenance and checkpoint scripts use no git history. Packaging now
fetches one commit, like the quality jobs already do. `prepare_cua` keeps full
history only for the paired Cua benchmark, whose script archives an older
baseline commit; `release-smoke.ts` evaluates that expression. Preflight's tag
check, `finalize` and `cut_next_beta` are unchanged. Packaging checkout steps
(seconds):

```text
Leg            v1.5.2   A1   A2
macOS arm64        45    8   10
macOS x64          26   10   20
Windows            39   11   12
Linux x64          50    6    6
Linux arm64        35    5    3
```

## Rejected experiments and external-service limits

Intra-runner component `fileParallelism` with four workers failed in all three
repetitions of [run 34832610297](https://github.com/Emanuele-web04/synara/actions/runs/34832610297).
The candidate was also slower than the individual baseline shards in the completed
sample. It is not enabled. Native file sharding above keeps each browser process
serial instead.

Disabling server Vitest isolation (`isolate: false`, one serial worker reusing
its module graph across files) was rejected in November 2026. The
[paired benchmark](https://github.com/Emanuele-web04/synara/actions/runs/43023542738)
ran each server shard three times, each against `--isolate` on the same runner.
Import time fell from 64–107 s to 9–12 s per shard, but every candidate repetition
that finished failed. Shard 1/3 failed 8–9 files (`GitHubCli`, `processLiveness`,
provider usage, `languageService`). Shard 2/3 failed 11 files
(`providerUsage/index`, `device/helperClient`, `droidSecureStorage`,
`MigrationBackup`, …) and leaked an unhandled `child.kill is not a function`.
Shard 3/3 failed 9 files (`OrchestrationEngine`, `protocolProcessTeardown`,
`DatabaseLifecycleLock`, …), and tests hit the 90 s timeout. Its test time rose to
771–785 s, against 193–251 s for the baseline. Two candidate runs had not
finished after 14 minutes. The isolated baseline passed every repetition.
Server tests rely on per-file module state, mocks and process stubs, so isolation
stays on. It was never applied to the browser configuration.

An earlier [timing-aware server sequencer](https://github.com/Emanuele-web04/synara/actions/runs/34825744944)
was also rejected. It preserved the then-collected suite but worsened slower-shard
time 9.9% and combined time 2.1%. The prototype/timing hints remain removed. The
accepted server change uses Vitest's native shard assignment instead.

Running the macOS AppSnap helper and window-material builds concurrently with the
staged production install was measured in release runs
[A1](https://github.com/Emanuele-web04/synara/actions/runs/43120433988) and
[A2](https://github.com/Emanuele-web04/synara/actions/runs/43123721500) and
reverted in November 2026. The stages share no files, but they contend for CPU
on the hosted runners. Seconds, serial sum of `appsnap-helper`,
`window-material-addon` and `production-dependencies` before, concurrent wall
time after, with the slowed parts in brackets:

```text
Leg     Serial before (v1.5.0 / v1.5.1 / v1.5.2)   Concurrent after (A1 / A2)
arm64   40 / 31 / 38                               25 (24+1+11) / 31 (29+1+15)
x64     - / - / 31                                 38 (36+2+20) / 58 (55+3+31)
```

It gained about 10 s on arm64 and lost 7–27 s on x64, the leg that, with Intel
qualification, is Stable's critical path. The three stages run serially again,
in their original order.

Root-only installation measured 2.07 seconds but cannot own release smoke. Root +
shared also failed because Bun's isolated scripts links were absent. Only the
verified root + scripts static scope is used.

Linux ARM64 browser commands were slower than x64, so no architecture switch was
adopted. Stagehand is not a drop-in provider for this Vitest Browser Mode suite;
no Stagehand/Browserbase speedup is claimed and no deterministic test was replaced
with semantic AI success. Remote Turbo caching needs configured service credentials
and cross-platform artifact-input review. No external service or paid runner is
enabled by this change.

Raw JSON and exact commands remain attached to immutable experiment runs. Temporary
benchmark workflows are removed from the final tree. Full-CI wall time and raw
runner consumption must be evaluated together; per-shard latency reductions are
not added together into an overall percentage.

## Verification and rollback

`node --test .github/scripts/ci-contracts.test.mjs` executes the actual aggregate
shell for successful code/docs runs and rejects failures, cancellations, invalid
change outputs and unexpected skips. It also guards install scopes, native Windows
test inventory, three-way server/component distribution, serial server execution,
cache ownership (restore everywhere, one saver per key, Turbo saves only on main)
and browser preparation. `scripts/server-ci-shards.test.ts` owns the server
shard partition and pinned placement.
`scripts/browser-ci-partitions.test.ts` owns complementary ChatView membership,
complete file ownership, serial execution and geometry exclusion through the
resolved Vitest configuration. Its expected membership is independent of that
configuration, so accidentally relaxing the quarantine fails the test.

After editing CI, run `bun run fmt:check`, `bun run lint`, `bun run typecheck`,
`bun run test`, the CI contract tests and workflow syntax/expression validation.
Retain full-history `bun run migrations:check` and Windows boundary/native checks.
Rollback is mechanical: restore the prior two-way shard matrices and/or
`--with-deps` stable browser preparation without changing test commands, required
check identity, signing policy or publication. Removing the sequencer line from
`apps/server/vitest.config.ts` restores native server sharding, and deleting the
`sidebar|handoff` keywords restores the previous ChatView groups.

### Earlier cross-platform candidate evidence

The first complete PR run
[34828358809](https://github.com/Emanuele-web04/synara/actions/runs/34828358809)
passed all 15 then-current jobs but initialized new caches: 325 seconds and 2,422
runner-seconds. The warm confirmation
[34829293225](https://github.com/Emanuele-web04/synara/actions/runs/34829293225)
passed all 15 jobs in 308 seconds and 1,943 runner-seconds, versus main's 323
seconds / 2,158 runner-seconds. The final critical-path graph is measured again
from scratch in the PR verification record; those earlier numbers are retained so
cache initialization is not hidden.

### Full-workflow follow-up

The final optimization commit `1d27eb0d9` ran twice, first in #1197 and again when
the same branch reopened as #1202. Both completed successfully:

| Run                                                                                              | Workflow elapsed | Raw runner minutes |
| ------------------------------------------------------------------------------------------------ | ---------------: | -----------------: |
| [Reference main](https://github.com/Emanuele-web04/synara/actions/runs/34792874548)              |            5m23s |              35.97 |
| [First final-candidate run](https://github.com/Emanuele-web04/synara/actions/runs/34836521794)   |            4m17s |              33.40 |
| [Reopened PR, same candidate](https://github.com/Emanuele-web04/synara/actions/runs/34851349076) |            6m45s |              38.67 |

The first candidate run was 20.4% faster than the reference and used 7.1% fewer
raw runner minutes. The second was 25.4% slower and used 7.5% more. Raw runner
minutes sum job start-to-completion durations; they are not billed cost.

In the second run, some jobs started up to 182 seconds after their dependency
completed. Windows dependency installation also varied from 101.42 to 223.63
seconds between the two candidate runs. These observations do not establish that
the PR caused the scheduling delays. They do show why the paired test-command
improvements cannot guarantee an overall percentage: the 18-job workflow also
depends on runner availability and installation cost. Compare several full runs
under similar load before treating either overall saving as repeatable.

### Windows install cache placement

The original install benchmark placed both fresh worktrees and empty Bun caches
under `RUNNER_TEMP`. The actual Windows workflow instead used a `D:` checkout
with Bun installed under the runner's `C:` home, without overriding its default
cache location. That topology differed from the benchmark. Bun normally hardlinks
packages from its cache on Windows, and its isolated installer falls back to
copying when the cache and destination are on different volumes. See the
[benchmark setup](https://github.com/Emanuele-web04/synara/blob/c1fb6bca967f9cdc9fbb8226d95d1ef52574a22e/.github/scripts/ci-benchmark.mjs#L48-L55)
and [Bun installer](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/install/isolated_install/Installer.rs#L1339-L1410).

Windows installation now selects and logs `RUNNER_TEMP/bun-install-cache`, matching
the hosted benchmark's volume placement. Other platforms retain their cache
selection. This does not restore a Windows archive, change the install scope, or
disable lifecycle scripts. The original logs did not record the effective cache
or linking backend, so the 101.42- and 223.63-second samples do not isolate copying
as their cause. Fresh native Windows checks and installation timing are recorded
in the PR verification; a same-runner paired comparison is needed to attribute a
repeatable percentage to cache placement alone.
