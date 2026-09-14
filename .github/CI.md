# CI setup and execution

The required check remains **Format, Lint, Typecheck, Test, Browser Test, Build**.
It aggregates results only. Static checks start independently; all normal code
changes still run typechecking, four unit partitions, four stable browser
partitions, desktop build, native Windows regression and migration lineage.
Docs-only detection and nightly geometry ownership are unchanged.

## Install scopes and cache ownership

`setup-workspace` defaults to the complete workspace. Only proven consumers opt
into a smaller dependency graph:

| Consumer | Install scope | What still runs |
| --- | --- | --- |
| Static checks | Root + `@synara/scripts` | Identity, Windows boundary, format, lint, release smoke, CI contract tests |
| Windows regression | Everything except marketing | Every existing native PTY/process/filesystem/shutdown/recovery test |
| Typecheck, Linux unit/browser, desktop build | Full workspace | Existing commands and build prerequisites |
| Native release artifact builders | Everything except marketing, `--ignore-scripts` as before | All four packages, provenance and packaged-startup checks |
| macOS device matrix | `@synara/scripts`, `--ignore-scripts` as before | Same Xcode pairs, native probe, simulator smoke and diagnostics |

Filtered installs never restore/save a full `node_modules` archive. Windows
installs cold rather than extracting the pathological Bun package cache. Full
Linux installs retain their modules cache; the Bun package archive is restored
only when modules are not an exact hit. Frozen installation and lifecycle patches
still run on cache hits. Turbo persistence is opt-in for unit/build consumers;
OS, architecture and lockfile boundaries prevent incompatible archive reuse.
Test and typecheck task results remain uncached.

Release smoke shares the static runner, removing one checkout/install/runner and
one duplicate identity scan. The platform-independent Windows boundary scanner
runs there once; native Windows validation is not removed. Release preflight
still installs the full workspace and runs all tests. Signing, notarization,
source provenance, publication and production dependency staging are unchanged.

## Measurements (September 14, 2026)

Application baseline: `70f5ed0e4757c0f69891b258171da80d324f0e18`. The successful
[baseline main CI](https://github.com/Emanuele-web04/synara/actions/runs/34792874548)
took 323 seconds and 2,158 raw runner-seconds across 16 jobs. This is one observed
full run, not a controlled multi-run median. The new full graph has 15 jobs;
docs-only retains three. No percentage below describes an entire signed release.

[Cross-platform install experiment](https://github.com/Emanuele-web04/synara/actions/runs/34822416944):
three observations per variant on each runner; every observation uses a fresh
worktree and dedicated empty `BUN_INSTALL_CACHE_DIR`. Variant order reverses on
the middle repetition. Bun is pinned by the lock/toolchain. Linux/Windows include
lifecycle scripts; both macOS control and candidate use the release workflow's
existing `--ignore-scripts`. Frozen lockfile hashes remained identical.

| Runner / install | Full median | Scoped median | Median reduction |
| --- | --- | --- | --- |
| Windows runtime | 42.33 s | 32.90 s | 22.3% |
| Linux runtime (measured; full Linux caching retained) | 27.85 s | 24.08 s | 13.5% |
| Linux static, including release smoke dependencies | 27.85 s | 7.55 s | 72.9% |
| macOS ARM64 release dependencies | 23.27 s | 11.48 s | 50.7% |
| macOS Intel release dependencies | 61.12 s | 42.69 s | 30.2% |
| macOS ARM64 device dependencies | 23.27 s | 2.07 s | 91.1% |
| macOS Intel device dependencies | 61.12 s | 7.02 s | 88.5% |

The corrected static scope was measured in a
[separate same-source Ubuntu job](https://github.com/Emanuele-web04/synara/actions/runs/34823971221):
7.55 / 7.47 / 7.68 seconds. Its comparison is not paired on the same machine as the
full-workspace control. Intel release measurements were noisy: full
61.12 / 269.19 / 54.96 seconds, scoped 29.68 / 42.69 / 106.97 seconds. The median
improved but not every Intel pair did; do not promise a fixed 30% improvement.
The device result was consistently smaller on both architectures.

[Native artifact validation](https://github.com/Emanuele-web04/synara/actions/runs/34822950006)
passed Linux AppImage, Windows NSIS, macOS ARM64 DMG and Intel DMG builds plus
packaged-startup smoke with the filtered install. Both macOS native device probes
also passed. These were **unsigned build-only checks**, not signed publication or
all Xcode/simulator combinations.

## Browser distribution

The four blocking runners are preserved. Complementary ChatView name patterns
move project/worktree/Space/approval cases into the shorter follow partition;
unknown new stable cases always fall into exactly one partition. Both retain
the existing geometry exclusion. No test bodies, assertions, retries or timeouts
were changed.

[Paired browser experiment](https://github.com/Emanuele-web04/synara/actions/runs/34823613671)
ran control/candidate three times each per partition on the same runner, reversing
order in the middle. Median test-command durations changed from
146.77 / 222.28 seconds to 200.91 / 178.20 seconds. The larger median is **9.6%
shorter**; combined medians are **2.7% higher**. This is a latency tradeoff, not a
browser compute reduction. Exact executed-name unions remained 126 stable cases,
with no overlap or omissions, on all repetitions. Candidate runs all passed;
one unchanged baseline follow case failed, and its failure remains in the logs.

## Negative results and limits

- Root-only installation measured 2.07 seconds but cannot own release smoke.
  Root + shared also failed because Bun's isolated scripts links were absent.
  The accepted static scope includes the scripts workspace and passed every
  static command, including release smoke. Those failed scopes were not adopted.
- Linux ARM64 browser commands took 276.63 / 277.68 seconds versus x64
  272.35 / 270.92 seconds. No browser runner architecture switch was adopted.
  Full server tests were somewhat faster on ARM in two samples, but one x64
  baseline repeat had a pre-existing model-discovery timing failure; this is not
  sufficient evidence to change the native architecture contract.
- Stagehand is not a drop-in provider for this Vitest Browser Mode suite. No
  Stagehand/Browserbase speedup is claimed and no deterministic test was replaced
  with semantic AI success. Remote Turbo caching needs a configured service,
  credentials and cross-platform artifact-input review; no remote cache or paid
  runner service is silently enabled.

Raw JSON, exact commands and failure logs are attached to the experiment runs.
The temporary branch-push benchmark workflows are removed from the final change;
immutable experiment commits preserve the harness for reproduction. Compare
cold and warm runs separately and never add install-segment percentages together.

## Verification and rollback

`node --test .github/scripts/ci-contracts.test.mjs` executes the actual aggregate
shell for successful code/docs runs and rejects failures, cancellations, invalid
change outputs and unexpected skips. It also guards install scopes, native
Windows test inventory, cacheability and complementary browser partitions.

After editing CI, run `bun run fmt:check`, `bun run lint`, `bun run typecheck`,
`bun run test`, the CI contract tests and workflow syntax/expression validation.
Retain full-history `bun run migrations:check` and Windows boundary/native checks.
A dependency-scope rollback is simply the original full frozen install; it must
not change test commands, required-check identity, signing policy or publication.
