# CI setup and execution

The required check remains **Format, Lint, Typecheck, Test, Browser Test, Build**.
It aggregates results only. Static checks start independently. Normal code
changes run typechecking, five unit partitions, six stable browser partitions,
desktop build, native Windows regression and migration lineage. Docs-only
detection and nightly geometry ownership are unchanged.

The Linux PTY dependency smoke runs once, on the first server shard; the Windows
PTY smoke remains a separate native check. The desktop lifecycle smoke exercises
the real Electron browser integration. The synthetic Energy Cloud A/B benchmark
runs only through its dedicated workflow, not on every PR build: it measures
copied baseline/candidate algorithms and adds no application regression assertion.
This removes twelve ten-second measurement waits from the blocking build lane.

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

Filtered scopes never restore/save a full `node_modules` archive. Windows
installs cold rather than extracting the pathological Bun package cache. Its
install cache lives under `RUNNER_TEMP`, on the hosted checkout's drive, matching
the measured install layout and allowing Bun to hardlink package files. Full
Linux installs retain their modules cache; the Bun package archive is restored
only when modules are not an exact hit. Frozen installation and lifecycle patches
still run on cache hits. Turbo persistence is opt-in for unit/build consumers.
OS, architecture and lockfile boundaries prevent incompatible archive reuse.
Test and typecheck task results remain uncached.

Release smoke shares the static runner, removing one checkout/install/runner and
one duplicate identity scan. The platform-independent Windows boundary scanner
runs there once; native Windows validation is not removed. Release quality lanes
still install the full workspace and run the audited test suite while unsigned
preparation proceeds in parallel. Packaging waits for every quality gate. Signing, notarization,
source provenance, publication and production dependency staging are unchanged.

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

## Rejected experiments and external-service limits

Intra-runner component `fileParallelism` with four workers failed in all three
repetitions of [run 34832610297](https://github.com/Emanuele-web04/synara/actions/runs/34832610297).
The candidate was also slower than the individual baseline shards in the completed
sample. It is not enabled. Native file sharding above keeps each browser process
serial instead.

An earlier [timing-aware server sequencer](https://github.com/Emanuele-web04/synara/actions/runs/34825744944)
was also rejected. It preserved the then-collected suite but worsened slower-shard
time 9.9% and combined time 2.1%. The prototype/timing hints remain removed. The
accepted server change uses Vitest's native shard assignment instead.

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
test inventory, three-way server/component distribution, browser preparation and
complementary ChatView ownership.

After editing CI, run `bun run fmt:check`, `bun run lint`, `bun run typecheck`,
`bun run test`, the CI contract tests and workflow syntax/expression validation.
Retain full-history `bun run migrations:check` and Windows boundary/native checks.
Rollback is mechanical: restore the prior two-way shard matrices and/or
`--with-deps` stable browser preparation without changing test commands, required
check identity, signing policy or publication.

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
