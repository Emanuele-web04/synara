# CI setup and execution

The required check remains **Format, Lint, Typecheck, Test, Browser Test, Build**.
It aggregates results only. Static checks start independently. Normal code
changes run typechecking, five unit partitions, nine stable browser jobs,
desktop build, native Windows regression and migration lineage. Nightly geometry
ownership is unchanged.

No lane waits on another. Each heavy lane runs
`.github/scripts/detect-code-changes.mjs` right after checkout and skips its
remaining steps on a docs-only change. The script lists the pull request's files
(or the pushed commit range) through the GitHub API and applies the same
code-free rules as before: Markdown/MDX, the root `docs/` tree, marketing content
and images under `.github/`. A renamed file counts under both names. An API
error, an empty or possibly truncated list, a forced or first push and any other
event run every lane. The gate requires every lane to succeed and to report the
same decision.

The separate `Detect code changes` job this replaces held every heavy lane back
until it had been scheduled and finished. In the 59 first-attempt runs on the
current workflow (November 18–21) the heavy lanes were created 13 s after the run
at the median and 58 s at p95. `Static Checks (fast)`, which never waited, was
created after 1 s and 29 s.

## Job budgets

Every execution lane records its start right after checkout and ends with
`.github/scripts/job-budget.mjs`, which fails the job when it took longer than
its budget. Only a job that passed everything else reaches that step, so a
budget failure always means "green but too slow". `timeout-minutes` sits one to
four minutes above the budget and only catches a hang.

The initial budgets use 58 runs from November 18–21 before the browser
lanes were redistributed (successful jobs): the larger of 1.25 × p95 and 1.1 × the slowest
observed job, rounded up to 15 s. They hold today's speed; they are not the
targets. Lower a budget in the same change that makes its job faster. Raise one
only with a new measurement from `ci-audit.mjs`.

```text
Job                           p50   p95   max   Budget   Target
Static Checks (fast)           42    50    58       75
Static Checks (typecheck)      88    99   106      135
Unit Tests (core)             148   182   193      240       35
Unit Tests (web)              147   184   191      240       35
Unit Tests (server, each)     134   164   174      210       35
Browser (chat-follow)         135   226   253      285       35
Browser (chat-projects)       175   250   267      315       35
Browser (chat-workflows)      174   258   356      405       35
Browser (components, each)    178   261   288      330       35
Desktop Build                 120   196   254      285       35
Windows Process Regression    104   150   171      195       35
```

The nine-lane browser matrix keeps the ceilings for the matching lanes.
The mixed lane inherits the workflow ceiling because it runs workflow and
project slices, and all five component lanes share the component ceiling.
Seven successful runs with the nine-lane matrix, including
[main after #2252](https://github.com/Emanuele-web04/synara/actions/runs/44955553345),
had post-checkout maxima of 133 s for follow, 111 s for projects, 134 s for
workflows, 263 s for mixed and 207 s across the component lanes.

The clock starts after checkout because a clone can stall on GitHub's side: 2 of
2,314 checkout steps in the November 17–21 window took 45 s or more, and one in
this change's own [first run](https://github.com/Emanuele-web04/synara/actions/runs/44937536474)
took 161 s with 119 s of tests behind it. The job timeout still bounds a stalled
clone.

A lane that misses its exact `node_modules` archive (a lockfile or install-input
change) reinstalls from scratch. Setup marks that run `CI_COLD_CACHE`, and the
budget step reports the time without failing: the run measures the install, not
the lane. A missing clock or budget value fails the job.

After workspace setup and CI contract validation, `static-fast` uses GitHub
Actions' native `parallel` group for identity, Windows boundary, formatting,
lint and release smoke. These checks read the installed workspace; release
smoke writes only to its own temporary fixture directory. Each check retains
separate step logs, and the group waits for all checks and fails the lane if any
check fails. Installation stays sequential, including the shared lifecycle
patches. This overlaps work on one runner; it does not add runner capacity or
establish an overall CI speedup without hosted measurements. See the
[workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsparallel).

Static Checks scans localization sources once with `i18n:coverage`. The
combined report includes the catalog errors and UI literals from the former
two commands. Catalog errors still fail the check. The Mac mini scan took
0.80 s, down from 1.77 s for the two calls, with identical findings on the
measured checkout.

PR Size builds its label definitions and updates the PR in one runner job.
The existing per-PR concurrency group now covers all three steps. This
removes two runner allocations per invocation while preserving the label
definitions, line-count rules and manual rollout. On the last draft run,
the two setup jobs each held a runner for 4 s.
[PR Size run](https://github.com/Emanuele-web04/synara/actions/runs/44314109435)

The Linux PTY dependency smoke runs once, on the first server shard; the Windows
PTY smoke remains a separate native check. The desktop lifecycle smoke exercises
the real Electron browser integration. The synthetic Energy Cloud A/B benchmark
runs only through its dedicated workflow, not on every PR build: it measures
copied baseline/candidate algorithms and adds no application regression assertion.
This removes twelve ten-second measurement waits from the blocking build lane.

Typecheck also owns the released migration lineage check. It uses a full
blobless checkout with release tags, and both checks share the same Node
setup. The lineage command still fails on missing tags or a changed
released migration. The required gate waits for both checks through the
Typecheck job. This frees one runner allocation. In the last separate
hosted observation, Migration Lineage ran for 22 s, including 9 s for
checkout and 3 s for Node setup. [Hosted run](https://github.com/Emanuele-web04/synara/actions/runs/44314113710)

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

The shared setup action defaults to `full`. Typecheck, Core Unit, and Desktop
Build install the entire workspace. Other jobs select the dependencies they use.

- `static`: root and `@synara/scripts`, including its workspace dependencies.
  Identity, Windows boundary, formatting, lint, release smoke and CI contract
  tests all run. Root-only or root + shared installs cannot own release smoke.
- `runtime`: all workspaces except marketing. Windows runs every existing native
  PTY/process/filesystem/shutdown/recovery test with lifecycle scripts enabled.
- The `web` scope installs the root and `@synara/web`, including its workspace
  dependencies, for Web Unit and the six stable Browser jobs.
- The `server` scope installs the root, `@synara/cli`, `@synara/desktop` and
  `@synara/analytics`, including their Web and other workspace dependencies,
  for the three server unit shards and Desktop Build. The server host-usage
  tests import the Desktop relay and analytics Worker.
- Native release artifact builders exclude marketing with `--ignore-scripts`
  exactly as before. macOS device jobs select `@synara/scripts`, retaining their
  existing `--ignore-scripts`, Xcode pairs, probe, simulator smoke and diagnostics.
- Intel startup qualification (`qualify_intel`) selects `@synara/scripts` and
  `@synara/cli` with `--ignore-scripts`. The smoke also imports the server's
  supervised process teardown, so `@synara/scripts` alone cannot resolve `effect`.

The `full`, `web`, and `server` scopes use separate exact `node_modules` keys.
The install fingerprint includes the Node ABI, Bun configuration, manifests,
dependency resolutions and patch inputs. A release-only version bump leaves
the fingerprint stable because workspace links read the current checkout's
manifests. The first run with a new key seeds its archive.

After replaying a release bump on the Mac mini, Bun's frozen install took
0.49 s for Web, 0.59 s for Server, and 1.02 s for Full when reusing an installed
tree. With empty trees and a warm Bun download cache, the respective installs
took 3.14 s, 5.69 s, and 8.89 s. Every installed file and symlink matched
within each scope. These times exclude archive transfer and extraction.

Static, runtime, and Windows jobs install directly. On Windows, `RUNNER_TEMP` puts the
Bun package cache on the hosted checkout's drive so Bun can hardlink package
files. Each archive has one writer after a miss. Typecheck owns the full
Linux key, Web Unit owns the Web key, server shard 1/3 owns the server key,
and the macOS editor integration job owns its macOS key. Desktop Build
restores the server archive and extracts Electron from its separate runtime
cache after the frozen install. A cache miss still installs dependencies.
Frozen installation and lifecycle patches run on cache hits. Every scope uses
`--concurrent-scripts=1` to serialize the workspace `prepare` hooks that patch
the same TypeScript files. The September measurements below predate this
serialization.
Turbo persistence is opt-in (Desktop Build). Pull requests restore the newest
main entry and never save; only pushes to `main` save a per-commit entry, so PR
runs stop adding PR-scoped archives that no other branch can read.
OS, architecture and lockfile boundaries prevent incompatible archive reuse.
Test and typecheck task results remain uncached.

On the Mac mini, a frozen install into a fresh dependency tree with a warm Bun
package cache took 17.41 s for the full workspace and 11.69 s for the server
scope. The compressed archive fell from 692 MB to 502 MB. Before the scoped
key, the three server runners each restored the 933 MB full Linux archive
in 16–24 s. The scoped Linux restore remains unmeasured.

The former Desktop dependency archive was 1,058 MB and took 14.8 s to
save in the same run that seeded the 697 MB Server archive. On the Mac
mini with empty dependency trees and warm Bun download caches, Desktop's
frozen install went from 6.93 s to 4.40 s with the shared scope. Both
scopes passed the Desktop build, Worker dry-run and live Electron lifecycle
smoke. The native focus cases were collected and their fixtures built.
[Hosted archive measurements](https://github.com/Emanuele-web04/synara/actions/runs/44353945319)

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
re-running apt and installing rendering fonts on every shard. The current
stable CI setup uses `playwright install chromium --only-shell` with a dedicated
cache. The browser config launches Playwright's default headless Chromium.
Nightly geometry retains `--with-deps` for its font and layout checks.

The stable browser jobs restore Chromium while setting up the workspace and
wait for both before running the Playwright installer. On a miss, only
`chat-follow` saves the original cache key after installation. In the cold
[pilot](https://github.com/Emanuele-web04/synara/actions/runs/44200709891),
all six jobs compressed the same archive and five lost the reservation.
In a [run with a warm Chromium cache](https://github.com/Emanuele-web04/synara/actions/runs/44326104528),
the six serial restores occupied 23 runner-seconds, including 3 seconds on the
critical job. Those durations bound the savings from overlap in that trace.

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

### Component test processes on the same runner

The three component jobs run two Vitest shards each, pairing
`1/6` with `2/6`, `3/6` with `4/6`, and `5/6` with `6/6`. Each Chromium
process still runs its files serially with a separate loopback port and Vite
cache directory. The pair uses the job's existing compiler cache, which writes
complete entries with atomic rename. Any failed process fails the job.

On the Mac mini at `5d41b9585` with Bun 1.4.4 and Node 24.21.0, a single
`components 3/3` invocation took 129.14 s and concurrent `5/6` and `6/6`
invocations took 88.36 s (−31.6%). Both samples started with identical warm
compiler caches and fresh Vite caches. The JSON results matched all 440 case
names, outcomes, and multiplicities across 84 files. Thermal pressure stayed
nominal throughout. Linux runner time and the full hosted gate remain to be
measured in a comparable cohort.

The first hosted [draft run 44190364513](https://github.com/Emanuele-web04/synara/actions/runs/44190364513)
passed the gate in 318 s including queue. Its no-queue critical path was 308 s,
and it used 40.77 runner-minutes. All six browser compiler caches restored. The
three component jobs completed in 171 s, 180 s, and 205 s. The
`chat-workflows` job took 294 s and was the longest job on the critical path.

Across three hosted attempts with the paired layout, the median per-file test
times summed to 34.6 s in `5/6` and 90.6 s in `6/6`. The new placement puts
`EventRouter.browser.tsx` on `5/6` and moves three shorter files to `6/6`.
The other component files keep their native placement. The Vitest partition
contract verifies that each file has exactly one owner.

On the Mac mini, the pair took 89.55 s with native placement and 68.17 s with
the four moves. Both runs used fresh Vite caches and copies of the same warmed
compiler cache. All 440 cases across 84 files matched by full name, outcome and
multiplicity. The rebalanced hosted job passed in 169 s. Its preceding
sample took 211 s. Both restored the browser caches.
[Rebalanced hosted job](https://github.com/Emanuele-web04/synara/actions/runs/44307004109)

With those four pins, components 3/3 was the slowest component job in both
hosted runs that restored their caches, and components 2/3 was the fastest.
In [run 44368935032](https://github.com/Emanuele-web04/synara/actions/runs/44368935032)
the halves took 121 s (`1/6`), 128 s, 129 s, 141 s, 173 s and 171 s (`6/6`).
A trial pinned six short files from `5/6` to `3/6` and two from `6/6` to `4/6`.
On the Mac mini with the main-merged file set, a warm compiler cache and the
three pairs run like CI, the slowest half fell from 66.8 s to 61.2 s, and all
1,426 cases kept their outcomes. Hosted, it overshot. In runs
[44383201899](https://github.com/Emanuele-web04/synara/actions/runs/44383201899)
and [44384792991](https://github.com/Emanuele-web04/synara/actions/runs/44384792991),
`3/6` and `4/6` took 142–147 s while `5/6` and `6/6` took 108–115 s.
Components 2/3 became the slowest component job at 178–179 s, and components
3/3 took 143–148 s. In those runs the moved files took 21 s on `3/6` and 11 s
on `4/6`. The current placement keeps three of them on `3/6`, about 9 s, and
returns the other five to their native shards. In
[run 44389626369](https://github.com/Emanuele-web04/synara/actions/runs/44389626369)
the halves took 121 s (`1/6`), 129 s, 113 s, 118 s, 121 s and 126 s (`6/6`),
and the three component jobs took 154 s, 161 s and 165 s. The required gate
passed 184 s after the run was created and used 32.4 runner-minutes. The
browser, unit and Desktop jobs took 122–165 s. This is one sample. The two earlier runs of the
branch passed the gate in 240 s and 219 s. In the 240 s run, every file in
components 1/3 ran 35–40% slower than in other runs, with an unchanged file
set.

The keybindings warning case shares EventRouter's real route and WebSocket
fixture. The former standalone file mounted the app twice. In two cold hosted
runs that file took 81–83 s, with 1–3 s in the test body. On the Mac mini
with fresh compiler and Vite caches, the first component pair went from
96.18 s to 73.03 s. All 534 remaining cases matched, and EventRouter passed
its original 44 cases plus the moved warning case.

### Chat workflow fixture setup

The draft history test fills its long input in one action and uses real keys for
the caret and history checks. Three model picker tests advance the browser
clock through their original expiry windows while keeping the DOM and focus
assertions. On the same Mac mini with fresh Vite caches and equal warm compiler
caches, the four cases took 12.25 s before and 2.26 s after. The complete
`chat-workflows` job took 116.05 s before and 106.01 s after with identical
results for all 149 assigned cases.

### ChatView name groups on the same runner

Each ChatView lane runs two complementary name filters on its existing runner
in separate Chromium processes. Each process has its own port and Vite cache
directory. The two processes share the job's compiler cache. The stable
geometry quarantine applies to both halves.

In the first paired pilot on the Mac mini, with fresh Vite caches and warm
compiler caches, the
`chat-projects` sample fell from 70.47 s to 42.38 s. The warm
`chat-workflows` sample fell from 106.01 s to 58.01 s. The paired runs
passed all 87 and 149 assigned cases respectively, matching the serial case
names and multiplicities. The test launcher kept Vitest's environment intact
so it reused the compiler cache in both children. On GitHub, projects and
workflows ran in 181 s and 173 s with the paired processes and new Web setup.
The preceding pilot took 254 s and 243 s respectively.
[Paired pilot](https://github.com/Emanuele-web04/synara/actions/runs/44200709891/attempts/1)

On a cold compiler cache, paired browser processes coordinate per entry. The
reader reuses the writer's atomic result or compiles independently if the claim
cannot be used. The test filters, browser profiles and Vite caches stay separate.
On the Mac mini, the complete cold `chat-workflows` pair took 90.54 s before and
85.26 s with the prototype. Toggling coordination in the final code measured
96.65 s disabled and 93.02 s enabled, with process CPU time falling from
331.18 s to 250.37 s. The final runs passed the same 149 cases, and all 1,507
common compiler cache entries were byte-identical. The hosted impact remains
unmeasured.

Each claim directory holds an `owner` file with the process ID and host of
the process compiling the entry. A waiter keeps waiting while that process is
alive and takes the claim over at once when it has exited, belongs to another
host, or never recorded an owner within 2 s. A 5-minute cap bounds anything
else. The first version gave up after 30 s and compiled again. Cold ChatView
compiles took 95–148 s in the hosted compiler guard. With a 35 s fixture
transform, the waiter finished at 65.1 s and the transform ran twice. With
owner checks it finished at 35.1 s and ran once.

A process that exits during a compile leaves its `.lock` claim directory, and
a failed write can leave a `.tmp` staging file. The setup action deletes both
kinds of leftovers from a restored archive before any test process starts. The
CI contract test runs that exact shell against a fixture cache.

The follow lane now runs the streaming-follow matrix in one process and its
other cases in the second. Pane and detached-reading cases join the second
follow process. Editor and tab navigation cases join the projects lane.
With fresh Vite caches and matched warm compiler caches on the Mac mini,
follow took 64.96 s before and 47.78 s after, projects 41.72 s and 51.26 s,
and workflows 55.72 s and 44.36 s. The slowest ChatView lane fell from
64.96 s to 51.26 s. All 265 stable cases passed once per variant. The four
quarantined cases still run in the geometry lane. GitHub schedules six
browser jobs. The final layout has yet to run on hosted Linux.

### Nine browser jobs

The six browser jobs were the slowest lanes of every run: 170–178 s at the
median in the 58 most recent runs, against 147–148 s for the next lanes. In
[run 44935499084](https://github.com/Emanuele-web04/synara/actions/runs/44935499084)
the twelve browser processes took 77–167 s each. A component process spent
47–87 s on per-file module loading and 51–65 s in tests for about 42 files. A
ChatView process spent 60–101 s in tests.

The browser lane is now nine jobs of two processes each. The component files run
as ten native Vitest shards on five runners instead of six shards on three. The six-shard pins are gone because they were
measured for that layout. In the first two runs of the new layout shard 9/10
took 109–110 s beside 51–52 s for 10/10: native placement puts
`EventRouter.browser.tsx` (40 s of tests) on 9. Five files now move from 9 to
10, which evens the estimated load of the pair at about 72 s each. ChatView
keeps its three projects and runs as eight processes instead of six.

Each ChatView project is split by the length of the full test name modulo its
slice count (`VITEST_BROWSER_CHAT_SLICE=2/3`), replacing the keyword pairs. Every
name has exactly one remainder, so the slices of a project are complete and
disjoint by construction and a new case needs no keyword. With the per-test
times of that run the slices hold 56 and 71 s of tests for `chat-follow`,
62, 50 and 56 s for `chat-projects` and 80, 50 and 56 s for `chat-workflows`,
against 60–101 s before. `scripts/browser-ci-partitions.test.ts` checks every
example case against exactly one process and rejects a malformed slice; the CI
contract test checks that the matrix runs each slice and each shard once.

A run now needs 18 runners at once (nine browser jobs and nine other lanes) of
the account's 20, up from 15. Two overlapping runs already queued before; they
queue for longer now. The first three ChatView jobs and the first two component
jobs keep the compiler archive names main already saves. The other four jobs
borrow the component donor archive on a pull request and seed their own on
main.

### Desktop lifecycle smoke during the build

The lifecycle smoke bundles its own fixture. The Desktop Build job verifies it
while the desktop pipeline builds, then waits for a successful build before
running the analytics build, Electron navigation focus smoke, and preload
check. Both Electron smokes run in sequence.

On the Mac mini with cold build outputs and Turbo cache, the build and
lifecycle smoke took 39.09 s and 21.56 s serially. The same build and lifecycle
checks finished in 36.61 s together, and the generated preload passed its CI
check. The separate navigation smoke timed out while acquiring initial macOS
window focus in both the serial run and an isolated reproduction. The local
overlap timing covers the build and lifecycle. Desktop Build finished in 188 s
on Linux with both Xvfb smokes and the preload check green. The earlier pilot
took 227 s. Both restored dependency caches against different base lockfiles,
so the difference includes runner and cache variation.
[Linux pilot](https://github.com/Emanuele-web04/synara/actions/runs/44199353941)

### Web dependency and Chromium archives

Across 56 cache hits in eight hosted runs, restoring the 933 MB full workspace
archive took 21.39 s at the median and 25.80 s at p90 in Web Unit and the six
stable Browser jobs. The pilot Playwright archive was 282 MB and contained both
headed Chromium and its headless shell.

On the Mac mini, a single cold frozen install per scope took 27.96 s for `full`
and 11.60 s for `web`. The resulting trees compressed to 692 MB and 276 MB using
the same tar and zstd settings. With the smaller tree and a separate Playwright
directory containing only the headless shell and FFmpeg, all six stable Browser
jobs passed. They exercised 252 component files exactly once and matched the
265 assigned ChatView cases. Web Unit matched all 6,279 outcomes, including its
three existing skips.

On Linux, GitHub saved a 341 MB Web dependency archive and a 108 MB Chromium
archive. The first run created both caches and passed the gate in 217 s. The
same-head repeat restored both archives in every consumer and failed in a
server reporter test.
[Cold run](https://github.com/Emanuele-web04/synara/actions/runs/44200709891/attempts/1),
[Warm run](https://github.com/Emanuele-web04/synara/actions/runs/44200709891/attempts/2)

The Electron download cache is keyed by the `electron` entry in `bun.lock`.
`.github/scripts/lockfile-package-key.mjs` hashes that line, including nested
resolutions, so a release version bump keeps the cache. Desktop Build computes
the key in 40 ms after Node setup. A miss cost 1.7 s in
[run 44383201899](https://github.com/Emanuele-web04/synara/actions/runs/44383201899).
The Chromium archive keeps its `bun.lock` key. A trial keyed it the same way,
but the extra step ran before workspace setup on the runner's cold Node and
took 0–6 s in each browser job. The miss it avoids once per release cost
2–3 s per job, because Playwright's CDN download is fast. Turbo also keeps its
lockfile key. Turbo task hashes include each package's `package.json`, so a
release bump misses every task whichever archive is restored.

### Web Unit worker-pool trial

Mac mini comparisons through Turbo used three workers with the Vitest result
cache disabled. Each seed was run with both pools, and threads ran first for
seed 7301.

| Shuffle seed |   Forks | Threads |
| ------------ | ------: | ------: |
| 3113         | 62.27 s | 52.21 s |
| 7301         | 56.89 s | 52.77 s |

All 503 files and all 6,279 case names, results and multiplicities matched
across the four runs. The Ubuntu trial then exposed a timezone failure in
`inbox.logic.test.ts`. The test changes `process.env.TZ` to exercise the Rome
daylight-saving transitions. A Mac mini replay launched in UTC reproduced
the failure in threads. All 17 cases passed in forks.
[Hosted Web Unit trial](https://github.com/Emanuele-web04/synara/actions/runs/44307004109/job/134811090010)

The CI config now runs that file in a fork and the rest of the Web Unit
suite in isolated threads. The worker limit is shared across both projects.
With three total workers and the compiler-first schedule, matched Mac mini
comparisons through Turbo measured 53.76 → 49.92 s for seed `1795008673311`
and 60.20 → 54.83 s for seed `7301` (mixed pool first). Both comparisons
matched all 6,279 case outcomes and multiplicities across 503 files.
An initial attempt at seed `7301` also matched coverage, but the fork arm
ran during a host load spike, so its timing was excluded. The mixed pool
has local measurements only.

### Web Unit compiler scheduling

The first scheduling change started the 49-case chat compiler guard in Web
Unit's first worker wave. The other files and individual cases still used
Vitest's seeded shuffle. The full Mac mini suite under seed
`1795006867144` took 64.41 s with its original schedule and 54.85 s with the
guard first. The guard started at 37.21 s and 0.14 s, respectively. Both
runs matched all 6,279 case outcomes and multiplicities across 503 files.
An earlier seed (`2198`) had nearly identical wall times (54.85 s and
54.52 s). The scheduling change targets the late-start tail. The hosted unit
job using seed `1795006867144` reported the compiler guard near the end of the
file results, after 147.48 s of execution. The next hosted Web Unit ran with
the new schedule and reported the guard near the middle. Both jobs passed all
6,276 active cases. Job wall time was 261 s and 262 s respectively, so these
samples establish the earlier completion order but no hosted wall-time saving.
[First hosted run](https://github.com/Emanuele-web04/synara/actions/runs/44309338095),
[Hosted scheduling check](https://github.com/Emanuele-web04/synara/actions/runs/44314113710)

The compiler guard now runs alongside the existing Core tests on their
runner, which already installs the Web dependencies. Web Unit selects the
other two Vitest projects. The compiler command fails when neither guard file
is found, the CI contract test checks that both files exist, and the required
aggregate gate still checks the whole Unit matrix.

Two local comparisons on the Mac mini included the app source at main
`5975b5238` and used three Web Unit workers. Moving the compiler guard
reduced the Web Unit command median from 53.64 s to 40.84 s. The combined
test inventory matched all 6,279 cases by name, outcome and multiplicity.
In the first Core comparison, the runner commands took 74.12 s before
and 71.45 s with the compiler guard. Summed Web and Core command time
fell from 127.76 s to 112.44 s in that comparison. Reversing the Core run
order measured 71.91 s before and 70.79 s with the guard. Placing the compiler
guard alongside warm typechecking instead added about 14 seconds to
the summed time. Hosted timing remains unverified for the new layout.

In a later Mac mini run, `ChatView.tsx` took 26.68 s of the guard's 37.0 s of
compile time, `Sidebar.tsx` 6.71 s, and the other 47 modules 3.6 s together.
Hosted, the single-file guard took 107–139 s on one worker and finished last
in Core. ChatView now has its own `ChatView.compiler.test.ts`. Both guard
files register their cases through `src/test/hotPathCompiler.ts`, and Core
runs them with two workers. On the Mac mini the guard took 32.6 s with two
workers, against 37.8 s for the single file and 44.7 s for both files on one
worker. ChatView's own compile sets the floor. Hosted, the guard took 123 s
and 95 s with two workers in runs 44383201899 and 44384792991, and Core took
170 s and 146 s.

### Hot-path compiler event cache

A CPU profile of the single `ChatView.tsx` compile on the Mac mini spent
about 92% of its time inside React Compiler's `inferMutationAliasingEffects`
fixed-point pass (`merge` and `clone` of its abstract state), plus GC. Parsing,
code generation and the event logger were each under 2%, and skipping code
generation (`code: false`) did not change the time. The guard already passes
the same parser options as the production build, so there is nothing avoidable
on the harness side; the compiler itself was left unpatched.

The guard's result is a pure function of the module's bytes and the
toolchain, so the Core lane now replays it for unchanged modules.
`apps/web/src/test/compilerEventCache.ts` stores the events the guard reads
(kind, function name, bailout reason and description, PipelineError text),
keyed by:

- the transform cache's fingerprint (`compiler-cache-key.ts`: Node version,
  normalized lockfile, patches, compiler plugin definition and its Vite adapter),
- the three harness files,
- the installed `babel-plugin-react-compiler` and `@babel/core` versions and
  entry bytes,
- `BABEL_ENV` and `NODE_ENV`,
- the module's absolute path and exact source.

A fresh compile and a replay both pass through the same projection and JSON
round trip, so a hit returns exactly what the compile it recorded returned.
The cache holds compile results, not verdicts: a recorded bailout fails the
guard again. An entry whose stored key differs from its file name, whose
format is unknown, or whose events do not have the expected types is
recompiled and rewritten. Without `SYNARA_WEB_TRANSFORM_CACHE_DIR` (local runs,
Web Unit) every call compiles. `compilerEventCache.test.ts` covers edits,
plugin version and code changes, malformed entries, and real compiler events.

The Core lane owns the `unit-core-compiler` archive under the existing
ownership rules: pull requests restore the newest matching archive and seed it
only on a miss, and pushes to `main` save one entry per commit.

Mac mini, both guard files, `--maxWorkers=2`:

```text
State                                    Wall (s)   User CPU (s)
No cache directory                         22.60        39.03
Empty cache (compiles, writes 49 entries)  22.63        38.10
Warm cache                                  0.66         1.00
```

With the cache warm, adding a default value to a destructured parameter in
`chat/useChatWorkLog.ts` failed the guard on that run and the next one
(`AssignmentPattern`). Restoring the file passed from the cache. The 49 entries
take 196 KB. A pull request that edits `ChatView.tsx` still compiles it for
real and keeps the old critical path for that step.

### Cua host test teardown

`apps/desktop/src/cuaDriverHost.test.ts` waits on real child processes, and
its fake driver models a 30 ms cleanup acknowledgement and a 150 ms graceful
exit. Every test paid both again in `afterEach` (about 190 ms each), after its
assertions had run. The fixture now writes a teardown flag before
`host.dispose()`, and from then on the fake driver answers and exits without
those delays. Dispose still takes the same cancel, acknowledgement and exit
path, and a dispose error still fails the test. Test bodies keep every modeled
delay, including the exit-before-replacement ordering checks.

Mac mini, same 157 cases: the file took 68.4 s and 51.5 s (three runs:
51.60 / 51.49 / 51.61 s), and the whole Desktop suite 72.7 s and 49.7 s (1,655
passed, 6 skipped both times). The remaining local per-test time is mostly
macOS's first-exec check of each freshly written fake driver (about 0.2 s,
measured with `process.uptime()` in the child), which hosted Linux does not
have. `browserVault.test.ts` deliberately uses the production scrypt cost and
is left as it is.

### Web Unit pre-bundles Effect and contracts

Each Web Unit test file used to evaluate Effect and `@synara/contracts`
module by module. The `web` and `web-local-time` projects now load both from
a Vite optimizer bundle built once per run (`deps.optimizer.ssr`). The
`web-compiler` project in the Core lane is unchanged.
`apps/web/scripts/unit-test-deps.ts` builds the include list on each run from
the contracts `exports` map and every `effect` or `effect/…` path imported
under `apps/web`, `packages/shared` and `packages/profile-ui`.

A module in the bundle must not also load from source, because a second
copy keeps separate module state. The guard plugin fails the importing test
file when an `effect`, `@effect/*` or `@synara/contracts` import would
resolve to source beside the bundle. It also drops Vite's `?v=` query from
bundle entries. Without that, `@synara/contracts/uiLocale` loaded once under
the query URL and once more through the bundled index, which gave two
different `UI_LOCALES` arrays. `scripts/unit-test-deps.test.ts` covers both
failures. With the plugin removed, its three guard cases fail.

Mac mini timings used 4 workers, the CI config and the two projects. Each
row compares runs with the same shuffle seed:

| Shuffle seed    |  Before |   After | Vitest import sum |
| --------------- | ------: | ------: | ----------------: |
| `3113`          | 39.49 s | 28.45 s |   98.6 s → 66.1 s |
| `7301`          | 38.47 s | 28.58 s |   98.0 s → 65.4 s |
| `1795008673311` | 36.44 s | 27.43 s |   93.0 s → 63.2 s |

For each seed, all 6,279 previous cases matched by name, outcome and
multiplicity (6,271 passed, 8 skipped). The 7 new guard cases also passed.

`force: true` rebuilds the bundle on every run, because Vite's optimizer hash
does not cover linked workspace source and could otherwise serve stale
contracts. The two project bundles build at the same time in 83–90 ms each.
Scanning for the include list takes 53–67 ms. Under seed `3113`, two runs that
reused the bundle took 27.51 s and 27.31 s, and two forced runs took 27.58 s
and 28.06 s. That difference is within run-to-run noise, so the measured
saving is net of the rebuild. Hosted timing is unverified.

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

### Server shards use every core

The serial server setting (`--maxWorkers=1 --no-file-parallelism`) dates from
v0.2.2, when parallel worker forks kept a root `bun run test` from exiting under
Turbo. It left three of a hosted runner's four cores idle. The server config now
sets `maxWorkers` to `os.availableParallelism()` and keeps file parallelism on;
every file still runs in its own worker process with its own temp directories
and SQLite databases. Shard placement (`vitest.shards.ts`) is unchanged.

A local 4-worker run of the whole server suite (macOS, 694 files) took 414 s of
wall time for 978 s of test time. Its only failures were four files that also
fail serially on macOS (`accountSession`, `hostConnectivity.integration`,
`remotePairing/management.accountScope`, `DatabaseLifecycleLock`), so none was
caused by parallel execution. A shard's wall time is now bounded by its slowest
file (`ProviderCommandReactor.test.ts`, about 150–167 s serially on hosted
Linux), not by the sum of its files.

## November 16 audit: queueing and cold compiles

An audit of the 150 most recent `ci.yml` runs (November 13–16; 82 successful
first attempts, 81 of them code runs) split every job into waiting (created to
started), setup (checkout, workspace, browser runtime) and running. Seconds:

```text
Lane                         Wait p50/p95   Setup p50/p95   Run p50/p95   Job p50/p95
Unit Tests (server 1/3)         15 / 607       32 / 42       392 / 457     425 / 494
Unit Tests (server 2/3)         25 / 583       31 / 41       378 / 474     414 / 510
Unit Tests (server 3/3)          4 / 457       32 / 40       348 / 424     387 / 455
Browser (components 3/3)        20 / 583       37 / 51       385 / 446     429 / 487
Browser (components 1/3)        10 / 766       37 / 48       335 / 408     376 / 447
Browser (components 2/3)        18 / 542       35 / 47       306 / 368     346 / 409
Browser (chat-workflows)        12 / 728       36 / 49       347 / 438     394 / 478
Browser (chat-follow)           37 / 618       36 / 46       303 / 347     347 / 386
Browser (chat-projects)         22 / 523       35 / 51       283 / 350     326 / 396
Unit Tests (web)                 5 / 499       31 / 41       192 / 249     228 / 280
Desktop Build                    3 / 377       40 / 57       184 / 241     231 / 287
Static Checks (typecheck)        8 / 297       31 / 50        91 / 125     129 / 162
Windows Process Regression       4 / 143       53 / 66        50 /  64     117 / 137
Unit Tests (core)                9 / 543       31 / 44        57 /  71      96 / 107
Migration Lineage                4 / 527       40 / 48         1 /   7      43 /  53
Static Checks (fast)             2 / 169       20 / 27        (parallel)    40 /  46
Detect code changes              2 / 129        8 / 13         0 /   0      11 /  17
```

A code run took 635 s at the median and 1,586 s at p95. Without any waiting the
same runs would have taken 491 s (p95 530 s): the docs filter plus the slowest
lane. The difference is queueing, 133 s at the median and 1,098 s at p95. While a
Linux job had been queued for more than 30 seconds, 55% of the samples had 19 or
20 jobs running, the account's concurrent-job limit. One run needs 17 runners, so
two overlapping runs already queue. Replaying the same runs through a 40-job
limit removes the queue (p95 overhead 21 s); that needs a paid plan and is not
part of this change.

Setup is 31–40 s per Linux lane and is not the bottleneck. Test execution is
about 90% of every slow lane, so the changes below shorten the time each lane
holds a runner, which also shortens the queue behind it.

### React Compiler transform cache

`ci.yml` pins Node to a single patch across its jobs. The compiler fingerprint
includes the full Node version. In [run 44364860754](https://github.com/Emanuele-web04/synara/actions/runs/44364860754),
the runner for Components 3/3 picked 24.22.3 while other runners picked
24.22.2 from the range in `package.json`. The shard missed its existing
compiler archive and spent 123.31 s on imports in its slower half.
Node 24.22.3 includes security fixes and already has archives for
Components 3/3 and Desktop. Bumping the pin gives each lane a fresh key.
On the Mac mini, Components 3/3 with Node 24.22.3 took 98.58 s with an empty
compiler cache and 67.78 s with its own cache. Both runs passed the same 441
cases with fresh Vite optimizer directories.

Each browser lane starts a cold Vite server and compiles every module it loads
with React Compiler. In [run 43857434725](https://github.com/Emanuele-web04/synara/actions/runs/43857434725)
Vitest reported 81 s of import time for `chat-follow` (285 s total) and 146 s
for `components 3/3` (343 s total).

`apps/web/scripts/transform-cache.ts` stores each compiled module on disk. An
entry is keyed by the exact module source, its id, the Vite environment, the
module type and a salt that hashes the dependency graph, Node version, Vite
config, compiler and worker implementations, cache code, patches, and Babel
environment.
A changed module is recompiled. Dependency or config changes use fresh
entries, and malformed entries are recomputed. Vitest enables the test
cache through `SYNARA_WEB_TRANSFORM_CACHE_DIR`. React Compiler runs in
the client environment, so the node unit lanes have nothing to reuse.

Each stable browser lane owns one archive. Pull requests restore the newest
matching archive and save on a miss after a successful job. A lane missing
its own archive can seed from Components 3/3 on the same platform and compiler
fingerprint. That shard mounts the full chat app in EventRouter's tests and
has a broad set of compiled modules. Pushes to `main` save one entry per commit.
The archive and per-module salt use the same fingerprint. For Bun lockfile v3,
the fingerprint omits only each workspace's declared release version. It
retains all dependency resolutions, catalogs, overrides and integrity strings.
Unrecognized lockfile syntax is hashed byte for byte.

On the Mac mini with Node 24.22.3, the two `chat-workflows` groups passed the
same 131 cases in 75.89 s with an empty cache and 48.98 s starting from the
Components 3/3 archive. It already contained 1,421 of the 1,500 cold
transforms. All 1,499 results present in both outputs were byte-identical.
The timing excludes archive download.

Replaying the 1.5.4 to 1.6.2 metadata bump on the Mac mini kept the fingerprint
stable. The bumped Web production build took 35.10 s with an empty compiler
cache and 9.95 s with the previous release's cache. Its 3,194 output files
were byte-identical, including 1,722 compressed sidecars. A single ChatView
browser case took 35.31 s when seeding its cache and 7.27 s after the bump with
that archive reused. Hosted timing for the new keys remains unmeasured.

Local measurements (macOS, one ChatView test, `chat-follow` project):

```text
State                                  Import (s)   Whole command (s)
Cold cache                                51.6            65.0
Warm cache                                 4.4             7.5
Warm cache after editing vite.config.ts   45.2            57.2   (salt changed: full recompile)
```

Hosted measurement: [run 43865513495](https://github.com/Emanuele-web04/synara/actions/runs/43865513495)
ran this change twice on the same commit. Attempt 1 started with no archive
(cold, and saved one 7–8 MB archive per lane); attempt 2 restored them (warm).
Vitest's own figures, seconds:

```text
Lane              Import cold -> warm   Vitest total cold -> warm   Audit p50 (step)   Warm step
chat-follow            86.2 ->   7.8         295.5 -> 192.8               303              195
chat-projects         118.2 ->   7.9         354.7 -> 180.0               283              182
chat-workflows         79.2 ->  12.1         318.9 -> 301.7               347              304
components 1/3        101.3 ->  79.8         314.5 -> 211.1               335              213
components 2/3        216.9 ->  98.9         359.9 -> 248.2               306              251
components 3/3        212.9 ->  73.2         446.4 -> 263.1               385              265
```

The slowest browser test step fell from 385 s (audit p50; 449 s in the cold
attempt) to 304 s, and the six steps together from 1,959 s (sum of audit
medians) to 1,410 s. This is one warm run. `chat-workflows` barely moved: its
import fell by 67 s, but its tests took 284 s against 236 s in the cold
attempt, so it is now the slowest browser lane. The component lanes keep
73–99 s of import because every test file still reloads the page and refetches
its modules. The first ChatView test, which waits for the composer while the
cold server compiles, took 20.1 s cold and 2.5 s warm; that test failed once in
the audit with `Chat composer did not mount` after 20.5 s and passed on rerun.

The server lanes finish at the same time as the browser lanes, so this change
alone does not shorten a run. Projecting the 80 audited code runs onto the
measured lanes, without queueing: 500 s at the median today, 496 s with only
this change, 480 s with only two-or-more workers per server shard (#2164,
measured there at 154 / 234 / 110 s per shard), and 369 s with both (−26%;
p95 539 → 432 s). Runner time per run falls from 4,384 to 3,195 s (−27%), which
also shortens the queue described above.

With the cache warm, renaming `data-chat-scroll-container` in
`MessagesTimeline.tsx` made `settles the scroll-to-bottom arrow at the measured
transcript end` fail, and restoring the file made it pass again: a cached run
still sees a real change. `apps/web/scripts/transform-cache.test.ts` covers the
key, malformed entries and unchanged-module results.

Desktop CI uses its own `desktop-production` archive and opts in only
for the production Web build. Turbo passes the cache directory to that
task without hashing the machine-specific path into its full-build key.
The production entries also include the Node version, source-map setting
and Browserslist environment. Release builds and nightly geometry have
their existing uncached compiler behavior.

A paired Web build on the Mac mini used the app source at main
`5975b5238` and fresh output directories. After seeding the compiler
cache, a one-module edit took 43.99 s with no transform cache and
10.75 s with the cache. All 3,198 emitted files matched byte for byte,
including 1,724 compressed sidecars. The edited module populated one
new cache entry. The integrated Turbo build repeated the result at
37.08 s and 10.52 s with identical file hashes and one new entry.
The populated archive compressed to 8.7 MB locally. Hosted timings
include archive restore and job queue time and remain unverified for
this Desktop layout.

### React Compiler on worker threads

The web bundle is on every release's critical path (`build_portable` gates all
packaging legs) and in the CI Desktop Build lane. A local production build spent
60.0 s of its 63.6 s inside the React Compiler Babel hook, 1,578 calls with
never more than one in flight: Babel runs synchronously on the bundler's single
JavaScript thread. The bundler does issue those calls concurrently (298 in
flight once the hook yields), so the pass can use every core.

`apps/web/scripts/parallel-transform.ts` replaces the hook with one that sends
each module to a pool of worker threads. Every worker builds its own instance
of the same plugin from `scripts/react-compiler-plugin.mjs`, the definition
`vite.config.ts` uses, and calls its unmodified hook. The pool leaves one core
to the bundler (three workers on a four-vCPU runner, at most eight) and starts
on the first transform; `SYNARA_WEB_TRANSFORM_WORKERS=0` keeps the pass on the
main thread. Nothing is retried or skipped: a compile error is reported once
through the bundler, and a worker that crashes or exits fails the modules it
held and every later one. The transform cache sits in front of the pool and is
unaffected by it.

Local production builds (macOS, 18 cores, eight workers), each into an empty
directory:

```text
Variant                    vite "built in"   Output files   SHA-256 over all files
Main thread (workers=0)        67 s             3,192        6f59dba4218fa776...
Worker pool                    33 s             3,192        6f59dba4218fa776...
```

The two outputs are byte-identical, including the precompressed sidecars. A
unit test also compiles one component both ways and requires equal output.

More workers do not help beyond that. One file bounds the pass:
`ChatView.tsx` (304 KB) took 34.5 s to compile on its own and `Sidebar.tsx`
9.7 s, out of 68–75 s of summed compile time. The bundler cannot discover what
`ChatView.tsx` imports until its compile finishes, so 255 of the 1,578 modules
arrive after it. With three workers the same build took 41 s. That single file
is also most of the 80 s of import a cold chat browser lane pays.

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
gates are unchanged. Three build-only release runs of version 1.5.2
(`publish_release=false`, signed and notarized, every platform successful),
[A1](https://github.com/Emanuele-web04/synara/actions/runs/43120433988),
[A2](https://github.com/Emanuele-web04/synara/actions/runs/43123721500) and
[A3](https://github.com/Emanuele-web04/synara/actions/runs/43127538378), measured
the changes against the
[v1.5.2 tag run](https://github.com/Emanuele-web04/synara/actions/runs/43100375555).
A3 is the only run of the final code (`ee6e48eaf`). A1 and A2 also ran the
native-helper overlap that was then reverted (see the rejected experiments), so
their macOS build steps include it; A3 does not. Seconds:

```text
Segment                                              v1.5.2     A1     A2     A3
macOS arm64 packaging job                               756    675    721    821
macOS arm64 Build desktop artifact step                 602    546    574    669
macOS x64 packaging job                                 755    784    925    703
macOS x64 Build desktop artifact step                   660    664    699    595
macOS x64 Install dependencies (unchanged here)          21     31     77     29
Windows packaging job                                   617    718    670    681
Windows Build desktop artifact (unchanged; p50 406)     337    418    403    383
Linux x64 packaging job                                 283    159    156    159
Linux arm64 packaging job                               177    151    149    171
Intel qualify job                                       151    110    154    204
Intel qualify install step                               68     36     43     69
First packaging leg start after run creation            415    548    490    521
Whole run (v1.5.2 includes 67 s of publication)        1474   1450   1584   1456
```

Two changes held in all three runs: the DMG notarization and update ZIP overlap,
and the shallow checkout (both below). The macOS leg totals are not reliably
faster. The arm64 build step took 546, 574 and 669 s against 602 s in v1.5.2;
the x64 step took 664, 699 and 595 s against 660 s. Stages this work did not
touch vary more than the saving: `app-signing-and-preparation` took 77–161 s and
`electron-packaging` 355–487 s across the baseline and branch runs. The x64
install step, also unchanged, took 21, 31, 77 and 29 s, and the Windows build
step ranged 337–418 s against a 20-release p50 of 406 s. No overall release
percentage is claimed. Packaging started later in every branch run because each
compiled every Cua driver from source and took the icon miss path (see below).

### Linux arm64 Cua pre-warm

`cua-release-cache.yml` pre-warmed only macOS arm64/x64 and Ubuntu x64. Since
Linux arm64 packaging was added (#2110), every release compiled that driver
from source, and `build` waits for the whole `prepare_cua` matrix. The producer
now also runs `ubuntu-24.04-arm`/`arm64`, the pair the release matrix uses.
`scripts/lib/release-build-scope.test.ts` fails when the producer's runner and
target pairs stop matching the release Cua matrix. The cache key is unchanged
in shape, so the first hit needs one successful producer run on `main`.

The pre-warm is still unmeasured. It takes effect only after the producer has
run on `main`. All three branch runs built Cua from source on all four legs
(285–468 s each), because changing `find-cua-artifact.mjs` changed every Cua
key.

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

The hit path is still unmeasured: it needs a producer run on `main`. All three
branch runs took the miss path. The Linux restore job took 12–16 s (14 s after a
42 s queue in A3). The `macos-26` compile then took 38 s after a 130 s queue in
A1, 31 s after a 3 s queue in A2 and 38 s after an 82 s queue in A3. Every run
packaged and qualified with the compiled catalog.

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
Leg      v1.5.0  v1.5.1  v1.5.2      A1    A2    A3
arm64       234     186     196     155   145   168
x64           -       -     194     145   178   144
```

The overlap held in all three runs. In A3 its parts were `dmg-notary-upload`
18 s, `dmg-notary-wait` 144 s and `update-zip` 45 s on arm64, and 19, 119 and
51 s on x64. Other macOS stages were noisy and unchanged by this work:
`electron-packaging` took 487 / 434 / 358 s on arm64 before (v1.5.0 / v1.5.1 /
v1.5.2) and 355 / 392 / 437 s after (A1 / A2 / A3), and 425 s on x64 before
(v1.5.2) and 475 / 450 / 406 s after. `app-signing-and-preparation` ranged
77–161 s in both periods (A3: 137 s arm64, 133 s x64). These stages swing by
more than the overlap saves, so the leg totals above did not reliably fall.

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
verification install without both workspaces. The smaller install is not
reliably faster on the hosted Intel runner. The install step took 36, 43 and
69 s in A1, A2 and A3 against 68 s in v1.5.2 (A3 installed 1129 packages in
68.40 s), and the whole job took 110, 154 and 204 s against 151 s. The
package-count reduction from 1404 to 1129 is the only established effect.

### Intel qualification starts with packaging

On a Stable tag the Intel job ran after the macOS x64 packaging leg. Over the
eight clean Stable or Beta runs among the last 30 tags, that leg finished 1,027 s
after the tag at the median and `qualify_intel` 1,194 s after it, later than the
arm64 leg (1,063 s), so it set when publication could start (1,197 s). Its 144 s
were checkout 13 s, dependency install 68 s, artifact download 48 s and the
startup smoke 44 s (medians of each step).

`qualify_intel` no longer has `needs: build`. It starts when the packaging job
starts, checks out and installs, and then runs
`scripts/wait-for-release-job.ts`, which polls this run attempt's job list
until `Build <label> / Package and qualify` has completed successfully. Only
then does it download that job's artifact and run the same smoke. Checkout and
install (about 90 s with job startup) now overlap packaging; the download and
the smoke are unchanged and still follow it.

The wait cannot pass on anything but that job's success. Any other conclusion
(failure, cancelled, skipped, timed out) fails the Intel job, as does an
ambiguous name or the 85-minute deadline, which exceeds the packaging job's own
75-minute timeout. A job that is not listed yet and a failed or malformed
listing are retried, never read as success. The listing is per run attempt and
carries over jobs that a partial rerun did not repeat, so a rerun of only the
Intel job proceeds at once and a rerun of both waits for the new packaging job.
After its smoke passes, Intel records the exact artifact ID it downloaded.
The publisher uses that ID for the Intel archive. A packaging-only rerun that
replaces the archive makes the old receipt unusable. Rerun Intel qualification
to publish the replacement.
`release-smoke.ts` rejects a restored `needs`, a missing or optional wait, a
download before the wait, a renamed packaging job and a wait shorter than the
packaging timeout. `scripts/lib/release-job-wait.test.ts` covers the states.

The helper was run against real runs: it returned at once for the v1.5.4
packaging job, failed for the Windows packaging job of v1.6.0 attempt 1, and
accepted the macOS x64 job that v1.6.0 attempt 2 carried over. The workflow
wiring itself has not run on hosted runners: it needs one build-only release
run (`publish_release=false`) before the next Stable tag. The Intel runner now
idles for the length of the packaging leg; that is not billed on a public
repository, and three macOS jobs run at once instead of two.

### Release checkout depth

The packaging legs and `prepare_cua` fetched full history. Packaging reads only
the checked-out commit (`git rev-parse HEAD`, a clean `git status` and file
bytes); provenance and checkpoint scripts use no git history. Packaging now
fetches one commit, like the quality jobs already do. `prepare_cua` keeps full
history only for the paired Cua benchmark, whose script archives an older
baseline commit; `release-smoke.ts` evaluates that expression. Preflight's tag
check, `finalize` and `cut_next_beta` are unchanged. The shorter checkout held
in all three runs. Packaging checkout steps (seconds):

```text
Leg            v1.5.2   A1   A2   A3
macOS arm64        45    8   10   10
macOS x64          26   10   20    7
Windows            39   11   12   11
Linux x64          50    6    6    6
Linux arm64        35    5    3    6
```

### Web bundle no longer waits for the contracts build

`build_portable` gates every packaging leg (tag to first packaging leg: 267 s at
the median over the last 30 tags). In the
[v1.5.4 run](https://github.com/Emanuele-web04/synara/actions/runs/43640497531)
its `bun run build:desktop` step took 180 s: the contracts `tsdown` build with
declaration output (25 s) ran first, then the web bundle (152 s), then the
server (2 s). The web bundle never reads that output. It compiles
`@synara/contracts`, `@synara/shared` and `@synara/profile-ui` from source
through their `import` exports, and it builds with no `packages/contracts/dist`
present.

`apps/web/turbo.jsonc` now makes the web build depend on `^transit` instead of
`^build`. `transit` is a task with no script in any package: it finishes
immediately and only carries each dependency's source hash into the web build's
cache key. A dry run confirms that editing a contracts or shared source file
still changes the `@synara/web#build` hash, so a restored Turbo entry cannot be
stale. The contracts build now overlaps the web bundle; the server and desktop
builds still wait for it.

A build-only `stage=js` release run of this change
([43867822721](https://github.com/Emanuele-web04/synara/actions/runs/43867822721),
no cache, no signing, nothing published) took 126 s for `bun run
build:desktop`: the contracts build (24 s) finished inside the web bundle, and
Turbo reported 2m05s for all four tasks. The same step took 180 s in v1.5.4 and
145 s at the median over the eight clean Stable or Beta runs of the last 30
tags. The web bundle itself was also faster in this run (106 s against 152 s in
v1.5.4), which is runner variance; only the 24 s that no longer precede it come
from this change.

A clean forced local build (`turbo run build --filter=@synara/desktop
--filter=@synara/cli --force`) produced the same four tasks in 70 s, with the
contracts build (9.6 s) inside the web bundle's 57 s.

### macOS signing skips per-file signatures on `.pak` data

`app-signing-and-preparation` took 73 s (arm64) and 165 s (x64) in the
[v1.5.4 run](https://github.com/Emanuele-web04/synara/actions/runs/43640497531),
and 77–161 s across the runs measured earlier. It is not hashing: the shipped
app has 29 Mach-O files. electron-builder hands the app to `@electron/osx-sign`,
which signs every file it classifies as binary in a serial loop, one
`codesign --timestamp` process and one request to Apple's timestamp server per
file. Its directory walk follows Electron Framework's `Versions/Current` and
top-level symlinks, so each of Chromium's 223 `.pak` files (220 `locale.pak`
plus three resource packs) is signed three times.

`mac.signIgnore` is now `["\\.pak$"]`. Signing a pristine Electron 43 app with
the same `@electron/osx-sign` 1.3.3, ad hoc and without timestamps, while
logging every `codesign` invocation:

```text
Variant              codesign --sign calls   Of which .pak   codesign --verify --deep --strict
Every binary file            724                 669         valid on disk, satisfies its Designated Requirement
.pak files skipped            55                   0         valid on disk, satisfies its Designated Requirement
```

A `.pak` is data inside the framework's `Resources`, not code. The enclosing
framework's signature seals its hash in `CodeResources`, which is what strict
verification, Gatekeeper and notarization check; its own signature added
nothing to that. Every Mach-O file, helper app, framework and the app itself is
signed exactly as before, with the hardened runtime, the same entitlements and
a secure timestamp. `build-desktop-artifact-mac-config.test.ts` pins the single
pattern and checks that no executable, library, helper, bundle or the `asar`
matches it.

A signed build-only [run 43878279502](https://github.com/Emanuele-web04/synara/actions/runs/43878279502)
tested this change together with other release changes. App signing and
preparation took 20.6 s on x64 and 28.4 s on arm64, compared with 164.7 s
and 73.1 s in v1.5.4. Both macOS builds passed signing, notarization,
stapling, provenance verification and packaged startup on their native
architectures. This was a combined run, so these timings do not isolate
the effect of skipping per-file signatures.

### Notarization archive compression

Before uploading the app to Apple, `notarize-mac-app.ts` archives it with
`ditto`. `app-notary-archive` took 40 s (arm64) and 37 s (x64) in the
[v1.5.4 run](https://github.com/Emanuele-web04/synara/actions/runs/43640497531).
Apple reads that archive once and it is then discarded, so it now uses
`--zlibCompressionLevel 1`. Archiving the shipped 1.6.0 app (850 MB) locally:

```text
Level        Time     Archive size
default      18.3 s     337 MB
1             6.8 s     369 MB
0             0.6 s     852 MB
```

Level 1 extracts to a bundle identical to the original (`diff -rq`). The
update ZIP that ships to users keeps the default compression level.

A signed build-only [run 43878279502](https://github.com/Emanuele-web04/synara/actions/runs/43878279502)
tested level 1 together with other release changes. Archive creation took
12.7 s on x64 and 12.6 s on arm64, compared with 37.1 s and 39.6 s in v1.5.4.
Uploads took 23.1 s and 25.5 s, compared with 23.8 s and 22.4 s. Both macOS
legs passed and the unrelated Windows startup smoke stalled, so the run
did not measure a complete release.

## November 21 audit: where a run's time goes

`node .github/scripts/ci-audit.mjs` reads the most recent `ci.yml` runs through
`gh` and splits every job into blocked (run created to job created), waiting
(job created to started), setup (checkout, workspace, caches, browser runtime;
overlapping background steps count once) and running (the rest of the job).
`--runs=N` sets the window, `--steps` adds per-step times and `--json` prints
the raw result. Rerun it before and after any CI change instead of reusing the
tables in this file.

The last 150 runs (November 17–21), seconds at p50 / p95:

```text
Job                                                     n     Blocked     Waiting       Setup     Running       Total
Browser Tests (chat-workflows 1/1)                    130    15 / 166     2 / 158     33 / 62   226 / 418   263 / 460
Browser Tests (components 3/3)                        132    15 / 165     2 / 193     35 / 61   203 / 371   242 / 409
Browser Tests (components 1/3)                        132    15 / 165     2 / 148     34 / 59   200 / 287   234 / 338
Browser Tests (components 2/3)                        131    15 / 166     3 / 197     34 / 60   180 / 542   216 / 587
Browser Tests (chat-projects 1/1)                     131    15 / 166     2 / 151     35 / 59   172 / 267   206 / 306
Unit Tests (web)                                      133    15 / 165     2 / 174     30 / 50   163 / 262   195 / 292
Desktop Build                                         135    15 / 165     2 / 116     43 / 65   140 / 203   186 / 252
Browser Tests (chat-follow 1/1)                       134    15 / 165     2 / 127     35 / 59   113 / 230   160 / 271
Unit Tests (server 2/3)                               136    15 / 164     2 / 184     33 / 49    97 / 179   139 / 222
Unit Tests (server 1/3)                               136    15 / 164     2 / 155     34 / 49    95 / 137   135 / 180
Unit Tests (server 3/3)                               136    15 / 164     2 / 158     35 / 49    91 / 137   132 / 170
Unit Tests (core)                                     136    15 / 164     3 / 163     37 / 50    73 / 133   108 / 171
Windows Process Regression                            138    15 / 164      2 / 34     57 / 80     46 / 63   103 / 138
Static Checks (typecheck)                             138    15 / 164      2 / 82     39 / 59     38 / 58     84 / 96
Static Checks (fast)                                  140      1 / 44      2 / 46     23 / 33     18 / 25     42 / 52
Migration Lineage                                      76    17 / 178     3 / 227     17 / 23     14 / 18     30 / 38
Detect code changes                                   139      1 / 45      2 / 33      7 / 13       4 / 8     11 / 17
Format, Lint, Typecheck, Test, Browser Test, Build    142   313 / 836      2 / 29       0 / 1       4 / 6       4 / 6
```

A successful pull request run took 269 s at the median and 754 s at p95; a
successful run used 2,317 runner-seconds at the median. The window spans three
workflow shapes. The 60 newest runs took 217 s and 303 s for pull requests and
2,021 runner-seconds.

Running is the largest bucket in every lane above `Static Checks`: 113–226 s at
the median in the browser lanes against 33–35 s of setup and 2 s of waiting.
Waiting is 2–3 s at the median in every lane; its p95 comes from overlapping
runs reaching the account's 20 concurrent jobs, as in the November 16 audit.

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
in their original order. In
[A3](https://github.com/Emanuele-web04/synara/actions/runs/43127538378), after the
revert, `appsnap-helper` took 33 s and `production-dependencies` 22 s on arm64,
and 20 s and 16 s on x64. These stage times also vary from run to run.

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

### Independent Cua provisioning during desktop packaging

In v1.6.6 the shared Cua preparation matrix delayed every installer. The
Apple Silicon job was cancelled after 15 minutes without a runner, and even
the completed Linux preparation jobs could not proceed to packaging. The
release now provisions Cua inside each macOS or Linux packaging job after
portable outputs and any required icon catalog are ready. This removes a
runner allocation and the same-run artifact transfer per platform. The
separate native-only workflow stage still supports targeted qualification
and benchmarks. Publication still requires all applicable native jobs and
the full quality and server test gates.

The packaging change in #2288 also invalidated Linux's Cua cache when only
macOS symbol stripping changed. Future edits to the macOS strip script affect
only the macOS key. The refactor changes shared provisioning code once, so it
requires a fresh exact cache for each target before it has warm-run timings.

Build-only dispatches use a separate concurrency group from publication.
Tag-triggered and manual publication continue to share one serialized queue.

The web compiler cache tracks the compiler plugin and its adapter separately
from the rest of the Vite configuration. Packaging and bundling edits can
reuse compiled modules when the compiler input bytes, module identity,
toolchain and mode still match.
