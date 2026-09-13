# CI architecture and cross-platform evidence

Tracks #1184 / PR #1185. No main write, release publication, signing-policy change,
new paid service or test-framework replacement is part of this change.

## Job graph

Planning and fast static checks start independently. The dependency-free Node
planner selects whole-workspace typechecking, unit partitions, stable browser
partitions, desktop build, native Windows regression and migration lineage.
These lanes remain parallel. The final job only aggregates their results and
retains the branch-protection name:
**Format, Lint, Typecheck, Test, Browser Test, Build**.

| Existing responsibility   | Decision                                    | Reason                                                                                            |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Change detection          | Replace                                     | Tested merge-tree diff plus workspace reverse dependencies; unknown input runs more validation.   |
| Fast static               | Keep                                        | Immediate format/lint/boundary feedback, even when planning fails.                                |
| Typecheck                 | Keep separate; conditional                  | Whole-workspace checking stays uncached and does not delay fast feedback.                         |
| Core unit group           | Keep                                        | Short suites share setup; script tests inspect sources outside package imports.                   |
| Web units                 | Keep; conditional                           | Independent useful work; no suite removed.                                                        |
| Server unit shards        | Keep two; balance by measured file duration | Preserve serial execution inside each runner and every discovered file.                           |
| Stable browsers           | Keep all four; conditional                  | Test execution dominates setup; no evidence for replacing the provider or cutting shards.         |
| Desktop build             | Keep; conditional                           | CLI includes web; packaging has an implicit desktop-to-CLI dependency. Preload assertions remain. |
| Windows process/recovery  | Keep; conditional                           | Every native command remains. Remove only the duplicate platform-independent source scanner.      |
| Migration lineage         | Keep Node-only; conditional                 | Full release history is necessary; missing tags now fail closed.                                  |
| Release smoke runner      | Merge into fast static                      | Its unique command shares an installed workspace; no second brand check or install.               |
| Aggregate quality         | Keep and harden                             | Planned lanes must succeed; only deliberately unplanned lanes may skip.                           |
| Nightly geometry          | Keep nightly                                | Existing quarantine only. No stable correctness test moved here.                                  |
| Release artifacts         | Keep all four native targets                | Filter Windows artifact installation only; preserve all provenance/startup/signing checks.        |
| macOS device matrix       | Keep all toolchains; narrow installation    | Scripts and their shared/contracts dependencies suffice; native probe/simulator commands remain.  |
| Marketing and PR metadata | Keep separate                               | Existing path triggers and permission boundaries serve different contracts.                       |

Full main CI uses 15 runners instead of 16, and 12 workspace installations
instead of 13. Docs-only remains three runners (one workspace installation).
These counts exclude independent marketing and PR-metadata workflows.
No new automatic benchmark jobs remain after the investigation.

## Dependency installation and caches

`.github/scripts/install-workspace.mjs` owns the frozen installation profiles.
Bun's `workspace...` syntax includes the workspace's transitive dependencies,
including CLI's declared web dependency. The root filter retains root tools.

| Profile   | Consumers                                             | Lifecycle policy                                                         |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `full`    | Static, whole-workspace typecheck and core unit group | Existing complete frozen install, scripts enabled.                       |
| `product` | Web/server units, browser, desktop build, Windows     | Root + CLI/desktop/scripts dependency closures; scripts enabled.         |
| `release` | Windows release artifact job                          | Same product closure; existing `--ignore-scripts` policy retained.       |
| `device`  | macOS device-helper matrix                            | Root + scripts dependency closure; existing `--ignore-scripts` retained. |

The product profile excludes the unrelated marketing dependency tree. It is not
an unsafe hand-picked list of third-party packages. The install helper rejects
unknown profiles and passes arguments directly to Bun without a shell.

Windows dependency archives stay disabled: earlier actual archive extraction
was slower than a cold frozen install. Linux retains the exact-match modules
cache; its Bun download cache restores only on a modules miss. Frozen installs
and lifecycle patches still execute on hits. Module keys include OS, architecture,
resolved Node, installation profile, Electron mode, manifests, lockfile and patches.
No incompatible module-archive fallback is used.

Only unit/build consumers persist Turbo artifacts. Tests and typechecking remain
`cache: false`. Turbo archive restore prefixes are isolated by OS, architecture,
Node, lockfile and patches; there is no shared Linux/macOS/Windows binary cache.
Electron runtime installation stays isolated to the desktop lane. Playwright's
browser cache is retained, and required OS dependencies still install on hits.

## Affected-change contract

The planner reads normal, development, optional and peer workspace dependencies,
adds desktop's implicit packaging dependency on CLI, and traverses dependents.
It reads the complete NUL-delimited diff from the tested PR merge to its base
parent. Deletions and both sides of moves count. It does not rely on a truncated
PR-files API or just the last commit. Changed workspace inventory, unknown paths,
missing history, manifests, lockfiles, root configuration, scripts, shared,
contracts and CI changes all select full validation. Main always selects full CI.

Planning, static (including release smoke), and the aggregate run in every row.
`All` units means core, web, server 1/2 and server 2/2. `Browser` means all four
stable partitions. The separate marketing workflow still owns marketing checks.

| Representative PR               | Typecheck | Units                     | Browser | Desktop | Windows | Lineage | Main-CI runners |
| ------------------------------- | --------- | ------------------------- | ------- | ------- | ------- | ------- | --------------- |
| Root Markdown / docs prose only | Skip      | Skip                      | Skip    | Skip    | Skip    | Skip    | 3               |
| Marketing content only          | Skip      | Skip                      | Skip    | Skip    | Skip    | Skip    | 3               |
| Web source                      | Run       | All                       | Run     | Run     | Run     | Skip    | 14              |
| Browser test/config             | Run       | All                       | Run     | Run     | Run     | Skip    | 14              |
| Desktop source                  | Run       | Core                      | Skip    | Run     | Run     | Skip    | 7               |
| Server/CLI source               | Run       | Core + both server shards | Skip    | Run     | Run     | Skip    | 9               |
| Shared Windows/process runtime  | Run       | All                       | Run     | Run     | Run     | Run     | 15              |
| Server persistence/migration    | Run       | Core + both server shards | Skip    | Run     | Run     | Run     | 10              |
| `packages/shared`               | Run       | All                       | Run     | Run     | Run     | Run     | 15              |
| `packages/contracts`            | Run       | All                       | Run     | Run     | Run     | Run     | 15              |
| Dependencies / lockfile         | Run       | All                       | Run     | Run     | Run     | Run     | 15              |
| CI workflow / action / planner  | Run       | All                       | Run     | Run     | Run     | Run     | 15              |
| Release tooling                 | Run       | All                       | Run     | Run     | Run     | Run     | 15              |

Server/desktop process changes retain Windows even without a Windows-specific
filename. Runtime Markdown, prompts, fixtures and application images are not
blanket-exempted. Mixed changes take the union; foundational changes are broad.
Marketing application code additionally receives whole-workspace typechecking.
The planner tests execute the actual inline aggregator, including invalid flags,
missing jobs, unexpected skips, cancellation and detection failure.

## Measured installation results

Raw samples, source identities and experiment limitations are committed in
[ci-benchmark-results.json](ci-benchmark-results.json). Install trials used the
same source and toolchain within each runner, separate empty cache/worktree paths,
and full/filtered/filtered/full order. Values below are means of two trials per
condition (also the two-point median), **not whole-job speedups**. Small samples
are directional evidence, not a statistical guarantee. Lifecycle policy matches
within each comparison; product and release timings must not be conflated.

| Native runner / workload        | Full install | Filtered install | Observed reduction |
| ------------------------------- | ------------ | ---------------- | ------------------ |
| Windows x64, product            | 42.46s       | 34.21s           | 19.4%              |
| Linux x64, product              | 31.62s       | 24.37s           | 23.0%              |
| Linux ARM64, product experiment | 26.16s       | 16.20s           | 38.1%              |
| macOS ARM64, device             | 24.36s       | 3.86s            | 84.2%              |
| macOS Intel, device experiment  | 63.74s       | 9.46s            | 85.2%              |

Sources: [five-runner benchmark 34785503156](https://github.com/Emanuele-web04/synara/actions/runs/34785503156)
and [bounded Windows trials 34786076507](https://github.com/Emanuele-web04/synara/actions/runs/34786076507).
Product package counts fell from 1,625 to 1,152 on Linux and 1,603 to 1,141 on
Windows. macOS device installs fell from 1,608 to 455 packages. Intel is an
additional compatibility/measurement target, not a new weekly device runner.

[Native artifact comparison 34785599845](https://github.com/Emanuele-web04/synara/actions/runs/34785599845)
used the same tested source for full/filtered installations and the existing
artifact build, provenance and packaged-startup commands. Windows passed both:
install 129.72s versus 63.17s; combined measured commands 651.38s versus 559.21s.
That is one native artifact pair, not a multi-run release median, and no signed
release was published. Linux passed both variants but did not justify a release
installation change. macOS packaging/provenance passed, but packaged startup
failed on both installation variants; macOS release setup is deliberately unchanged.

## Server scheduling and failure safety

The sequencer uses recorded slow-file timings and a default estimate for every
new/unrecorded test. Long files go to the least-loaded shard with deterministic
ties. It operates on Vitest's discovered specifications, not a fixed allowlist.
Deleting or adding a test cannot silently remove coverage. It does not increase
runner count, file parallelism, workers, retries or caching. Missing/invalid timing
data runs the **complete suite on each shard** rather than mixing two different
partitioning algorithms and potentially omitting files.

The pure scheduling tests exercise discovery-order changes, new tests, duplicates,
invalid estimates and every shard count 1–8 for suite sizes 0–49. The native
comparison in [34789252609](https://github.com/Emanuele-web04/synara/actions/runs/34789252609)
runs baseline and balanced scheduling twice each, counterbalancing order across
the same two runners with identical installed dependencies. File identities and
test totals are recorded as well as time. The matched result was:

| Command duration (mean of two trials per runner) | Baseline | Balanced |
| ------------------------------------------------ | -------- | -------- |
| Server shard 1                                   | 158.68s  | 193.18s  |
| Server shard 2                                   | 224.40s  | 185.55s  |
| Slower shard                                     | 224.40s  | 193.18s  |
| Sum across both runners                          | 383.08s  | 378.74s  |

The slowest server command decreased **13.9%** while combined test-command time
fell **1.1%**, with the same two runners. All eight commands passed. Each variant
covered the identical 417-file union, 4,939 passing tests and 24 existing pending
tests; file assignment was disjoint and assertion identities/statuses matched.
This push-workflow source differs from the earlier PR-merge ARM experiment;
its test counts and timings are compared only within this matched experiment.
These are command-duration observations, not a claimed full-CI speedup.

## macOS signal improvement

The native smoke exposed a fixed-delay assumption: Home can return before
SpringBoard has a frontmost accessibility application. A bounded monotonic
readiness check replaces the fixed 1.2s delay. Only that exact transient error
is polled; missing capabilities, helper timeouts, other errors and invalid/empty
trees still fail. Every frame/NAL, input, accessibility, screenshot and stream-stop
assertion remains. Assertion failures now unwind through the existing cleanup
before exiting. Seven deterministic regression tests cover immediate readiness,
transient startup, exhausted budgets, unrelated failures and malformed results.
Native verification uses the existing sandboxed helper and real simulator, not mocks.
Both `macos-14` and `macos-15` passed probe plus full simulator smoke in run
34789252609 at `ad9df877f1f4fbfa473363eb6ad9387c7e72b8b5`. This proves the
device-helper path; it does not turn the separate packaged-release startup
baseline failures into passes.

## Alternative technologies evaluated

**Linux ARM64:** all 5,003 server tests and 108 selected stable ChatView cases
passed on both architectures, with the same existing skip counts. The JSON report
span was 421.77s / 413.52s for x64 / ARM server and 281.44s / 287.57s for the
browser workload; these spans exclude outer command/setup overhead. This mixed,
single-sample result does not justify migrating the default x64 blocking lanes.
ARM64 remains available in the manual benchmark, not extra per-PR consumption.

**Stagehand 4.1.0:** the local, credential-free deterministic pilot actually ran.
Twenty fill/click/exact-assertion cycles took 0.784s and 0.778s with Playwright,
versus 0.754s and 0.489s with Stagehand. Browser startup was strongly order-sensitive.
This synthetic fixture is **not** a port of Synara's React/Vitest/MSW workload,
and does not establish an end-to-end CI improvement or equal defect detection.
No existing test or provider is replaced, and no Stagehand dependency is added.
The saved pilot code/lockfile in run 34789252609 makes the limited result reproducible.
Stagehand's [migration contract](https://docs.stagehand.dev/v4/migrations/playwright)
also requires rebuilding auto-waiting, strict locators, interception and assertions.

**Turbo Remote Cache / Browserbase:** the presence-only CI probe found no
`TURBO_TOKEN`, `TURBO_TEAM`, or Browserbase API key configured. No credentials were
printed, service provisioned or speculative cloud saving claimed. Existing
build-only Turbo caching remains. Remote cache requires a separate credential/trust
configuration (particularly for fork PRs and native OS/architecture outputs).
Local Stagehand did not require these credentials and was evaluated separately.

## Verification and repeatability

The PR verification record identifies the final tested commit and hosted runs.
Local checks include actionlint 1.7.12 (syntax/expressions; optional ShellCheck and
Pyflakes integrations disabled), Node 24 planner/install/shard tests, the focused
Vitest readiness tests, repository formatting, lint, brand and Windows boundary.
Full installed-workspace typechecking, all unit/browser partitions, desktop build,
release smoke, release-history lineage and native Windows validation run in CI.
A failed native baseline is not reported as a successful release validation.

`ci-benchmark.yml` is manual-only. It uses isolated worktrees/cache directories,
frozen installs and the existing test commands, retains logs/JSON on failure,
and has bounded job/command timeouts. Temporary branch-push investigation workflows
are removed before completion. Do not sum cold-install savings across warm-cache
jobs, add microbenchmark percentages together or equate raw minutes with billed cost.
