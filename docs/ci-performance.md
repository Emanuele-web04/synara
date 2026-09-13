# CI architecture and performance

## Evidence

Baseline: successful main run [34754198860](https://github.com/Emanuele-web04/synara/actions/runs/34754198860), commit `939d93c35c8d748c6a52ac17bb4f7423a43c8ddb`, September 13, 2026. This is one measured sample, not a latency distribution or dollar-cost estimate.

Workflow lifecycle was 513 seconds. Summed job execution was 2,334 seconds (38.9 runner-minutes), including 492 seconds on Windows. There were 16 jobs and 13 dependency installations. Queue/start overhead was generally 1-3 seconds per job.

The Windows Bun package-cache archive was 559,235,326 bytes. Restoring it took 331.465 seconds, including about 326 seconds extracting. Commit `81c64f0ab9bd86443d0ca27bf3cb0c2da7abb080` removed only that restore. All 16 jobs passed in [34778199136](https://github.com/Emanuele-web04/synara/actions/runs/34778199136). Workflow lifecycle fell to 344 seconds (32.9% lower); Windows setup fell from 393 to 173 seconds and its complete job from 492 to 224 seconds. A cold install costs more than a warm install, but the measured net result is better.

Linux has different evidence: the static lane's 774,322,955-byte node_modules archive restored in 15.785 seconds, followed by a 1.694-second frozen install. The Bun package cache restored in 2.069 seconds. Keep these until an equivalent cold install, including lifecycle scripts, demonstrates a win. Release smoke's 17-second `--ignore-scripts` install is not a comparable benchmark.

Static-fast restored an unused Turbo snapshot in 1.623 seconds and saved essentially identical content in 1.677 seconds. Windows ran no Turbo tasks and attempted to save an absent cache path. Turbo caching is now opt-in for build-producing lanes. Tests and typechecks remain non-cacheable.

Browser test steps took 149, 264, 149 and 230 seconds; Playwright setup took only 11-13 seconds per runner. Keep all four lanes. Server test steps took 123 and 221 seconds across two serial-worker shards. One sample does not justify replacing Vitest's deterministic sharding with a maintained timing manifest.

## Graph and job decisions

Planning and migration lineage share one full-history, Node-only checkout. The migration command is unchanged; CI additionally requires its explicit success output, so missing or unreadable release history cannot become a green warning. This cheap guard also runs on prose PRs.

Static-fast remains independent of planning. It owns the single brand scan, single platform-independent Windows boundary scan, formatting, lint and release smoke. The smoke reuses the existing installation instead of another checkout/install. Formatting failures print the required diff without changing the failed outcome.

Typecheck and the short core unit group share setup. The baseline's 26-second typecheck plus 35-second core suite stay off the long-test critical path. Core still includes contracts, shared, scripts and desktop, and runs for every code change, including marketing, because repository-script tests have cross-app fixtures.

Web unit tests and both server shards stay separate. Linux PTY smoke runs once, on server 1/2. Package scripts and Turbo build prerequisites are preserved. Every actual Windows execution command remains; only the duplicate platform-independent source scanner leaves that lane.

The four stable browser lanes and geometry quarantine are unchanged. Playwright verifies the pinned browser and OS dependencies even on cache hits. Electron remains exclusive to desktop build. The quality job only aggregates and preserves the required name `Format, Lint, Typecheck, Test, Browser Test, Build`.

Structural full-run counts are 13 jobs and 11 installations, versus 16 and 13. Turbo-cache users fall from 12 to 5; nightly also stops restoring unused Turbo outputs. These are structural counts, not measured final elapsed times. PR #1172 records final candidate results.

## Dependency-aware selection

The planner reads workspace manifests and follows reverse dependencies, including dev, optional and peer dependencies. CLI's web dependency and desktop's implicit packaged-CLI dependency propagate web edits through build and Windows validation. Contracts, shared and repository tooling always select the full graph. Unknown files/workspaces, manifests, lockfiles, patches and CI changes also select full validation.

Git supplies a NUL-delimited merge-base diff with rename detection disabled, so both deletion and addition count. There is no API file-list truncation or shell evaluation of filenames. Missing refs and malformed metadata fail planning. Main always runs everything; affected selection is PR-only. Narrow prose exclusions never hide executable application `docs/`, `assets/` or MDX source.

Every PR runs planning/lineage, static-fast/release smoke and the quality gate. Additional selected work is:

- Markdown-only and marketing-content-only: no heavy main-CI lanes. Marketing content still triggers its independent validation workflow.
- Web or browser tests: typecheck/core, web unit, both server shards, all four browser lanes, desktop build and Windows.
- Desktop only: typecheck/core, desktop build and Windows; unit matrix and browser skip.
- Server/CLI, server process/runtime or server migration: typecheck/core, both server shards, desktop build and Windows; web unit and browser skip.
- Shared, contracts, dependency/lockfile, CI workflow or release tooling: the entire graph.
- Marketing executable source: typecheck/core plus the independent marketing workflow; main unit matrix, stable app browser, desktop build and Windows skip.

Shared process/recovery edits use the broad shared-package rule, not the narrower server rule. Mixed changes take the union. Package-level rather than per-test pruning is intentional: browser-test-only PRs still get broad web fan-out. Runtime images remain code inputs.

`node --test .github/scripts/*.test.mjs` checks all 13 requested representative PR scenarios, additional workspace/dependency edges, cycles, renames, unusual filenames and missing refs. CI also checks minimum fan-out against real manifests. Tests execute the production aggregate gate verbatim, rejecting failures, cancellation, missing outputs and unexpected skips rather than treating every skipped job as success.

## Boundaries and follow-up experiments

Nightly keeps the existing non-blocking geometry quarantine; no stable test moves there. Release preflight, signed platform builds, provenance, packaged-startup smoke, publication and source-finalization boundaries are unchanged. These validate different artifacts and authority boundaries, not redundant PR work.

The weekly/manual device-helper matrix remains distinct Xcode/OS compatibility coverage without ordinary PR cost. Marketing keeps both builds: visual tests need deterministic fixture data while performance smoke needs production data. Its deferred browser-step failures remain enforced by its final check.

PR-size and PR-vouch remain trusted-event, metadata-only automation; their write-capable contexts never execute PR source. Their small configuration/label jobs are outside the CI critical path. Permission consolidation is deliberately excluded. A successful timing sample cannot establish independent defect-detection frequency, so no job was removed on that basis.

Next experiments should compare matched cold/warm Linux installations and collect multi-run per-file server/browser timings. Do not add shared build-artifact barriers, reduce browser shards, enable test caching or change release publishing solely to improve elapsed time. Compare both summed runner execution and developer feedback latency.
