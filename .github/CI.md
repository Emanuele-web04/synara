# CI architecture and measured optimization

## Contract

`ci.yml` runs for every pull request and main push. The required check remains
**Format, Lint, Typecheck, Test, Browser Test, Build**. It is an aggregator, not
another execution lane. Main always receives the complete graph. Stale PR runs
are cancelled; main runs are not. All CI jobs have read-only repository access;
the aggregate job has no token permissions.

`changes` uses Node and a two-parent checkout, without a workspace installation.
It tests the planner and the exact inline quality gate, then compares the tested
PR merge tree with its first parent. NUL-delimited `git diff --no-renames` includes
deletions and both sides of moves, with no PR-files API pagination limit. A missing
merge base, unsupported workspace layout, unreadable graph or unknown path selects
the complete graph. Failure to execute planning itself fails the required gate.

Static checks start independently: identity, Windows source-boundary policy,
formatting, lint and release smoke share one installed workspace. Typechecking
remains independent and whole-workspace. Unit tests retain their existing Turbo
build prerequisites, core grouping and two serial-worker server shards. The core
selection excludes the dedicated web/CLI lanes rather than enumerating packages,
so a newly added workspace's test script is included by the broad fallback.

Browser tests retain all four stable partitions and their existing Playwright
runtime installation. Desktop builds retain both desktop and CLI build targets
and preload assertions. The Windows lane retains every native test, PTY smoke,
process/shutdown and migration recovery check. Migration lineage stays a separate
Node-only lane with full release history and an explicit missing-tag failure.

The gate requires success for planned lanes and skipped for unplanned lanes.
Failure, cancellation, missing/invalid planning outputs and unexpected skips all
fail. Tests execute this exact gate from the YAML, not a separate approximation.

## Affected execution

The planner reads every workspace manifest and computes reverse dependencies
across dependencies, devDependencies, peerDependencies and optionalDependencies.
Desktop additionally depends on the CLI because packaging embeds it. The CLI
already declares a dependency on web, so web changes also validate CLI, desktop
and Windows. Core tests run for every runtime surface because release/script
tests inspect files outside declared package imports.

Contracts, shared, scripts/release tooling, any package manifest, lockfiles,
patches, root/toolchain configuration, CI and unclassified changes run all lanes.
Only explicitly identified documentation is exempt: arbitrary runtime Markdown,
MDX and assets are not assumed inert. Marketing content still participates in the
dependency graph; its independent marketing workflow retains its existing checks.
New dependency edges automatically expand validation. New workspace/layout
inventory falls back to full CI until ownership is explicitly reviewed.

Every row below also runs **changes, static-fast and quality**. “All units” means
core, web and both CLI shards. “Browser” means all four stable runners. The
separate marketing validation workflow runs for marketing changes; scheduled
geometry/device checks and release publication triggers are unchanged.

| Representative PR | Typecheck | Unit runners | Browser | Desktop build | Windows | Lineage |
| --- | --- | --- | --- | --- | --- | --- |
| Root Markdown / documentation | Skip | Skip | Skip | Skip | Skip | Skip |
| Marketing content only | Skip | Skip | Skip | Skip | Skip | Skip |
| Web code | Run | All units | Run | Run | Run | Skip |
| Browser test/config | Run | All units | Run | Run | Run | Skip |
| Desktop code | Run | Core | Skip | Run | Run | Skip |
| Server/CLI code | Run | Core + both CLI | Skip | Run | Run | Skip |
| Shared Windows/process runtime | Run | All units | Run | Run | Run | Run |
| Server persistence/migration | Run | Core + both CLI | Skip | Run | Run | Run |
| packages/shared | Run | All units | Run | Run | Run | Run |
| packages/contracts | Run | All units | Run | Run | Run | Run |
| Dependency/lockfile | Run | All units | Run | Run | Run | Run |
| CI workflow/action/planner | Run | All units | Run | Run | Run | Run |
| Release tooling | Run | All units | Run | Run | Run | Run |

Marketing application code also receives whole-workspace typechecking. Server or
desktop process changes keep Windows even when the changed file name does not
contain “Windows”. Any mixture takes the union of required validation.

## Baseline: observed, not invented

Source: [successful main run 34754198860](https://github.com/Emanuele-web04/synara/actions/runs/34754198860),
September 13, 2026, commit `939d93c35c8d748c6a52ac17bb4f7423a43c8ddb`.
The workflow ran from 11:20:51 to 11:29:24 UTC: **513 seconds / 8m33s**.
Its 16 runner jobs totalled **2,334 seconds / 38.90 runner-minutes**. These are
execution durations, not billed minutes or OS-price-weighted charges. This is a
single successful full main run, not a statistically representative PR median.

| Job | Runner duration (s) | Workspace/tool setup (s) | Main work (s) |
| --- | --- | --- | --- |
| Changes | 9 | 0 | 1 |
| Static fast | 40 | 24 | 7 |
| Typecheck | 56 | 22 | 26 |
| Migration lineage | 13 | 1 | <1 |
| Release smoke | 29 | 19 | <1 smoke + 1 identity |
| Windows | 492 | 393 | 69 |
| Desktop build | 114 | 20 | 85 |
| Core units | 59 | 17 | 35 |
| Web units | 144 | 24 | 111 |
| Server 1/2 | 158 | 27 | 123 |
| Server 2/2 | 246 | 18 | 221 |
| Browser chat-follow | 188 | 17 | 149 |
| Browser chat-workflows | 321 | 29 | 264 |
| Browser components 1/2 | 189 | 18 | 149 |
| Browser components 2/2 | 272 | 18 | 230 |
| Aggregate gate | 4 | 0 | <1 |

Setup is the composite action or explicit tool/install steps, not checkout,
runner startup, browser runtime installation or post-job cache saves. Columns
therefore do not sum to duration. Individual runner allocation gaps were 1–3s;
the initial planning/startup path was approximately 12s. Windows determined the
critical path; the next-longest lane was browser chat-workflows.

### Cache and shard evidence

Windows job `103715719830`: the exact Bun package-cache hit restored 559,235,326
bytes in **331.465s**, including **325.967s extracting**. Frozen installation
then took **33.808s**. Windows node_modules caching was already disabled because
isolated links cannot be reliably restored. Its unused Turbo cache also incurred
a miss and about 5s of unsuccessful post-job saving. Remove these Windows caches;
retain the Bun executable cache and native validation. Cold installation must be
measured on the PR runner; 331s is removed work, not a promised net improvement.

Linux static job `103715696879`: node_modules restored 774,322,955 bytes in
**15.785s**, then frozen installation took **1.694s**. Its second Bun archive was
19,724,049 bytes / **2.069s**. Restore that package archive only when node_modules
does not match exactly. Retain the Linux tree cache: the observed 17s standalone
release installation used `--ignore-scripts`, so it is not an equivalent cold
benchmark. Do not infer cache ROI from incomparable installations.

Static's Turbo archive was 451,548 bytes, restored in **1.623s** and saved in
**1.677s**, despite no Turbo command running. Turbo persistence is now opt-in for
unit/build lanes only. Tests and typechecks remain `cache: false`; cache hits can
reuse build artifacts, never substitute stale test success. Existing artifact
fingerprinting and frozen dependency installation remain authoritative.

The four browser runners spent **970 runner-seconds**, including **792s testing**.
Playwright runtime installation took 11/13/11/13s and cache restoration 3/5/3/3s.
The longest shard tested for 264s, not a setup-dominated tiny shard. Retain four:
blind consolidation would serialize substantial stable tests. Server shard test
time was 123s versus 221s; per-file repeat measurements are needed before moving
files or changing worker counts. Geometry quarantine remains solely nightly.

## Decisions for every workflow/lane

| Lane/workflow | Decision | Rationale |
| --- | --- | --- |
| Changes | Keep; replace coarse filter | Dependency-aware, tested, conservative merge-tree planning; no install/API permission |
| Static fast | Keep; merge release smoke | Fast independent feedback; one setup and one identity check |
| Typecheck | Keep; conditional | Parallel whole-workspace validation; results stay uncached |
| Core units | Keep; conditional | Already efficiently grouped; script tests have implicit source inputs |
| Web units | Conditional | Keep entire suite whenever web is affected |
| Both server shards | Keep; conditional | Substantial serial test time; no evidence for blind rebalancing |
| All four browser shards | Keep; conditional | Stable correctness unchanged; skip only unrelated dependency surfaces |
| Desktop build | Conditional | Explicit CLI/renderer packaging fan-out; preload verification unchanged |
| Windows regression | Conditional; remove duplicate scanner | Native coverage unchanged; delete measured pathological cache work |
| Migration lineage | Conditional; keep separate | Full tags, no dependency install, explicit missing-history failure |
| Release smoke job | Merge into static | Removes a 29s runner for <1s unique work; no correctness moved to nightly |
| Quality gate | Keep; harden | Required display name unchanged; validate expected results exactly |
| Nightly geometry | Keep | Existing reliability quarantine only; no stable tests moved here |
| Release workflow | Keep | Signing, provenance, native artifacts and publication permissions remain isolated |
| Device helper matrix | Keep | Scheduled/manual compatibility probes are not redundant PR work |
| Marketing validation | Keep | Dedicated builds/browser/accessibility checks and final outcome enforcement |
| PR size / vouch | Keep | Permission-separated metadata automation; do not trade security for fewer YAML jobs |
| Issue labels | Keep | Independent metadata operation, not a duplicate code-validation lane |

## Before/after interpretation

The PR's Actions run supplies the observed after measurement; do not present a
projection as completed-run data. Structural counts below are deterministic from
the graph. Typical code scope matters, so both full and isolated examples are
listed rather than claiming a universal “typical PR” duration.

| Metric | Before | After design | Evidence |
| --- | --- | --- | --- |
| Full critical path | 513s (main sample) | Measure on PR; browser becomes candidate bottleneck | Before measured; after not assumed |
| Full runner time | 38.90 min | Measure on PR | No fabricated after timing |
| Full runner jobs | 16 | 15 | Structural |
| Web-only jobs | 16 | 14 | Structural |
| Server-only jobs | 16 | 9 | Structural |
| Desktop-only jobs | 16 | 7 | Structural |
| Docs-only jobs | 3 | 3 | Structural; still no heavy lanes |
| Frozen workspace installations | 13 full | 12 full; 7 server; 5 desktop | Structural |
| Playwright installations | 4/code PR | 4 affected; 0 server/desktop/docs | Structural |
| Windows jobs | 1/code PR | 1 affected; 0 docs/marketing | Structural; not removed for platform changes |
| Windows Bun package archive | 331.465s restore | Not restored or saved | Measured removed operation; cold install delta unknown |
| Linux redundant Bun archive | 2.069s static sample | Skipped on exact node_modules hit | Measured removed operation |
| Turbo persistence consumers | Every setup lane | Unit/build only | Structural; test cacheability unchanged |

Removing only the measured Windows restore and standalone release runner removes
360s of observed operations, before accounting for replacement cold-download
cost, cache savings or affected skips. The four browser lanes alone account for
16.17 baseline runner-minutes: server/desktop-only plans do not schedule them.
Applying old durations to a new graph is an estimate, not an after benchmark.

Local verification in the constrained editing environment: Node syntax and 22
planner/gate tests passed. Full repository formatting, lint, typecheck, Vitest,
Windows, desktop and browser validation must be reported from the PR checks;
this environment has neither a complete checkout nor Bun/network access. See the
PR verification record for exact execution results and observed after timings.

Deliberately excluded: speculative shard reduction, making test results cacheable,
removing Linux node_modules without a fair cold benchmark, pre-provisioned browser
images for a small measured setup cost, changing release publication, or rewriting
permission-separated metadata workflows. Independent failure-detection rates cannot
be inferred from one successful run and were not used to delete useful checks.
