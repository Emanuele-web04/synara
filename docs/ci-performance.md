# CI critical path audit — 2026-09-11

The target is a 20–30% reduction in pull-request CI wall time without removing required checks.

## Hosted baseline

Eight successful, first-attempt code-change runs from September 10–11 had a median wall time of **10m 51s**, ranging from **9m 31s to 12m 37s**. Seven are PR runs and one is a main push. Wall time is workflow creation through completion, including runner queueing; job durations below are execution time.

| Run                                                                              | Wall time | Longest job                |
| -------------------------------------------------------------------------------- | --------- | -------------------------- |
| [34601479519](https://github.com/Emanuele-web04/synara/actions/runs/34601479519) | 10m 40s   | Browser Tests (stable 3/3) |
| [34600331685](https://github.com/Emanuele-web04/synara/actions/runs/34600331685) | 10m 03s   | Unit Tests (server)        |
| [34598565030](https://github.com/Emanuele-web04/synara/actions/runs/34598565030) | 11m 16s   | Browser Tests (stable 3/3) |
| [34593171942](https://github.com/Emanuele-web04/synara/actions/runs/34593171942) | 10m 54s   | Browser Tests (stable 3/3) |
| [34589969875](https://github.com/Emanuele-web04/synara/actions/runs/34589969875) | 10m 54s   | Browser Tests (stable 3/3) |
| [34543900804](https://github.com/Emanuele-web04/synara/actions/runs/34543900804) | 10m 48s   | Windows Process Regression |
| [34543102075](https://github.com/Emanuele-web04/synara/actions/runs/34543102075) | 12m 37s   | Browser Tests (stable 3/3) |
| [34599928192](https://github.com/Emanuele-web04/synara/actions/runs/34599928192) | 9m 31s    | Unit Tests (server)        |

| Job                | Median  | Range          |
| ------------------ | ------- | -------------- |
| Browser stable 3/3 | 10m 10s | 8m 07s–10m 57s |
| Server unit tests  | 9m 00s  | 6m 35s–9m 15s  |
| Browser stable 1/3 | 3m 44s  | 3m 13s–3m 59s  |
| Browser stable 2/3 | 3m 16s  | 2m 49s–3m 28s  |
| Windows regression | 3m 39s  | 3m 05s–10m 28s |
| Web unit tests     | 3m 12s  | 2m 58s–3m 28s  |
| Desktop build      | 2m 56s  | 43s–3m 09s     |
| Typecheck          | 1m 12s  | 1m 02s–1m 17s  |
| Fast static        | 39s     | 32s–44s        |

The short jobs usually restore and install their workspace in 20–35 seconds. Faster setup alone cannot deliver the target.

## What dominates

- **Browser file imbalance.** In run 34601479519, shard 3 spent 348.2s running ChatView and 69.6s running EventRouter, plus 128.6s importing modules across its files. Other shards finished much earlier. Vitest's built-in sharding distributes files and cannot subdivide the 133-case ChatView file.
- **Unnecessary server prerequisite.** In run 34600331685, the server test step took 518s, but Vitest itself took 370.4s. Turbo built the web production bundle first because the server declares the web workspace as a development dependency and inherited `test.dependsOn: ^build`. The desktop build job already checks that bundle.
- **Serial server execution.** More than 400 server files run with one worker. This protects integration-test isolation, but it makes one runner responsible for the entire suite.
- **Uncached Windows installation.** Windows installed dependencies from scratch on every run. The sampled install steps ranged from 128s to 511s.
- **Repeated setup for tiny suites.** Four short unit suites each occupied a separate runner and restored the same workspace.

## Changes

1. Give ChatView's parameterized streaming-follow matrix and its remaining tests separate browser projects. Two additional shards cover every other browser file. Tests stay serial within each runner.
2. Keep the Linux geometry quarantine in every project's effective test-name pattern. The patterns for the two ChatView projects are complementary, so new stable cases automatically belong to exactly one project.
3. Split server test files into two hosted jobs while retaining `--maxWorkers=1 --no-file-parallelism`.
4. Replace the server test task's broad build prerequisite with the contracts build. Server tests consume web source and create their own static fixtures; production output remains covered by the required desktop build.
5. Group contracts, shared, scripts, and desktop unit tests into one Turbo invocation. Total workflow jobs decrease from **17 to 16**, despite the extra parallelism on the critical path.
6. Reuse the shared workspace setup on Windows, including OS-scoped caches and the frozen dependency install.

The required aggregate check name, docs-only behavior, failure propagation, and separate desktop build remain intact. Neither tests nor typechecks are cached as passing results.

## Expected impact

**About 7–8 minutes per successful code-change run is a projection**, approximately **26–35% below the 10m 51s baseline**. It is not a measured hosted result.

The latest browser log attributes 86.8s to the streaming-follow matrix. Its other ChatView cases account for about 261.5s. Conservatively retaining the old shard's entire 128.6s import cost, plus setup and scheduling overhead, puts the heavier new ChatView lane near the upper end of that projection. EventRouter and the remaining browser files execute elsewhere.

Removing the redundant ~148s frontend build and dividing server tests removes the second bottleneck. Windows cache hits should reduce install variance; a cold cache, hosted runner queueing, or a failing test can still exceed the projected range. Extra cold browser compilation is a tradeoff, partially offset by fewer setup jobs and the eliminated frontend build.

## Verification

- `actionlint` validates the modified GitHub workflow.
- The real aggregate shell step passes 51 success/failure/cancellation/docs-only scenarios.
- `scripts/browser-ci-partitions.test.ts` resolves actual Vitest configurations, verifies complete file ownership, checks the effective runtime patterns, and preserves serial browser execution.
- All 85 browser files are accounted for: 84 component files plus ChatView.
- The grouped core suites pass locally: 1,779 tests across 182 passing files.
- Both server shards pass locally: 4,902 tests across 406 passing files, with the existing skipped cases retained.
- Both ChatView partitions pass: 105 + 16 active cases. Comparing the actual JSON results to the complete file proves no missing or duplicated active tests; the 12 quarantined cases remain excluded.
- The complete ChatView file took 214.01s locally; the larger final partition took 161.30s and its complement took 96.22s. That is a 24.6% reduction in this local file's critical path, not a measured whole-workflow or hosted improvement.
- Both component shards pass: 42 files / 168 tests and 42 files / 193 tests, with the existing quarantined case retained. All four browser jobs pass locally (482 active cases total).

These are local macOS results. Windows cache behavior and the end-to-end speedup require a hosted run. Full workspace format, lint, and typecheck remain pending because AGENTS.md requires an explicit user request before running them.

## Hosted acceptance

After publication, compare at least three successful first-attempt code-change runs against the baseline. Measure creation-to-gate-completion, individual job duration, cache hits, and runner queue delay separately. Confirm both server shards, all four browser jobs, and the aggregate check succeed. Do not treat a rerun's timestamp or a warm local run as proof of the hosted improvement.

The sharding and project configuration use [Vitest's supported sharding](https://vitest.dev/guide/improving-performance) and [test projects](https://vitest.dev/guide/projects).
