# CI architecture and optimization evidence

## Contract

CI minimizes redundant runner work, not validation. The required check remains
**Format, Lint, Typecheck, Test, Browser Test, Build**. It only aggregates outcomes;
it does not check out source, install dependencies, or execute validation again.

```text
Plan affected validation (Node only, tests admission and gate contracts)
  +-- Static Checks and Compatibility (one workspace)
  |     brand + Windows source boundary + format + lint
  |     + conditional typecheck, released migration lineage, release smoke
  +-- Unit: core / web / server 1/2 / server 2/2 (selected matrix)
  +-- Browser: chat-follow / chat-workflows / components 1/2 / components 2/2
  +-- Desktop Build (web + CLI + desktop, Electron only here)
  +-- Windows Process Regression (native PTY + process/recovery/shutdown tests)
  `-- Required quality gate (always evaluates every planned outcome)
```

Main pushes always run full validation. PRs compare the tested merge commit with
the immutable event base. Full history is fetched; an absent base or failed diff
fails admission. NUL-delimited `git diff --no-renames` retains both the deleted
and added paths of a rename. No API file-count limit can truncate the change set.

## Admission and dependency fan-out

`scripts/ci/plan.mjs` reads the root workspace definition and every workspace
manifest. It expands reverse transitive dependencies across runtime, development,
optional and peer dependency sections. Development dependencies matter here:
`@synara/cli` depends on `@synara/web` to package its assets, so a web-only PR still
runs CLI tests, the desktop pipeline and Windows. This is intentionally safer
than a directory-only web/Windows split.

Contracts/shared, any package manifest, dependency locks, patches, CI, scripts,
root configuration, new workspaces and unknown paths select full product
validation. Narrow prose recognition does not exempt arbitrary Markdown/MDX
runtime prompts, fixtures or source files. Desktop bridge/preload changes also
select stable browser tests, an explicit integration edge beyond the manifests.
All product changes retain the short core unit group and full desktop pipeline.
Marketing has no workspace dependencies today and retains its own validation
workflow. Its content is not treated as uncompiled prose: root typechecking and
the marketing workflow validate it.

The planner prints its complete admission decision into the job summary. The
quality gate requires literal boolean outputs, exact success for required jobs,
and exact skipped results for unselected jobs. Failure, cancellation, absent
outputs and unexpected skips fail. Merged typecheck, migration and release
step outcomes are checked too. Independent static steps still report after a
sibling fails, without `continue-on-error` or forgiving the job's failure.

### Representative PR decision matrix

Every row runs **Plan + Static + Quality**. Static always runs brand, the
platform-independent Windows source boundary, formatting and linting. “Core”
means contracts, shared, scripts and desktop unit tests. “Server” means both
unchanged shards. “Browser” means all four unchanged stable lanes. A dash means
an intentional skip; the gate verifies it. Nightly geometry, release publishing
and the scheduled device matrix are never newly triggered by this routing.

| Change                         | Typecheck | Core | Web unit | Server | Browser | Desktop build | Windows | Lineage + release smoke | Main CI jobs |
| ------------------------------ | --------- | ---- | -------- | ------ | ------- | ------------- | ------- | ----------------------- | ------------ |
| Markdown-only prose            | -         | -    | -        | -      | -       | -             | -       | -                       | 3            |
| Marketing content only         | Run       | -    | -        | -      | -       | -             | -       | -                       | 3            |
| Web source only                | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| Browser test only              | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| Desktop only                   | Run       | Run  | -        | -      | Run     | Run           | Run     | Run                     | 10           |
| Server/CLI only                | Run       | Run  | -        | Run    | -       | Run           | Run     | Run                     | 8            |
| Shared Windows/process runtime | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| Server migration               | Run       | Run  | -        | Run    | -       | Run           | Run     | Run                     | 8            |
| packages/shared                | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| packages/contracts             | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| Dependency/lockfile            | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| CI workflow/action             | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |
| Release tooling                | Run       | Run  | Run      | Run    | Run     | Run           | Run     | Run                     | 13           |

Windows/process changes inside server or desktop follow their corresponding rows;
both retain the entire Windows regression lane. Mixed changes use the union plus
transitive fan-out, never the cheapest matching row. The marketing workflow runs
in addition for marketing paths and its dependency-install inputs; PR policy
workflows remain separate and are excluded from these main-CI job counts.

Run `node --test scripts/ci/*.check.mjs` without installing packages to verify the
matrix, actual manifests, reverse/cyclic edges, unknown packages, missing Git
history, rename/deletion paths, malformed outputs and the real inline gate code.
The placeholder core matrix on docs-only changes is never allocated because the
unit job condition is false; it prevents an invalid empty matrix expression.

## Job-by-job audit decisions

| Existing job/workflow | Decision | Reason |
| --- | --- | --- |
| Change detection | Keep, replace coarse matcher | Node-only graph admission, conservative fallbacks, tested gate contract; no PR API permissions needed. |
| Static fast | Merge | Keep all four checks, then reuse its install for types and compatibility checks; failures remain individually visible. |
| Static typecheck | Merge into static | Measured 22s setup for 26s checking; not critical-path work. |
| Unit core/web/server 1/2 + 2/2 | Keep, make conditional | Core is short but useful; web/server parallelism is material. Keep every package test and prerequisite build. |
| Four stable browser lanes | Keep, make conditional | Test steps take 149–264s; collapsing them would lengthen feedback. No stable tests moved to nightly. |
| Desktop build | Keep, make conditional | All product changes retain web/CLI/desktop build and preload-output validation; prose/marketing do not need Electron. |
| Windows process | Keep, make conditional, consolidate commands | Preserve native coverage; remove source-guard duplication and five redundant Vitest startups, not test files. |
| Migration lineage | Merge into static | Less than one second of command time; full release tags are still fetched. Missing release history now fails CI instead of warning and skipping. |
| Release smoke | Merge into static | Less than one second of smoke work after 17s isolated install; duplicate branding is removed. |
| Quality gate | Keep aggregator | Same externally required display name; exact admission and merged-step outcome enforcement. |
| Nightly geometry | Keep, share setup | Existing quarantine policy only; stable suite still blocks every admitted PR. |
| Release preflight/build/publish/tarball/finalize | Keep | Immutable tag/source provenance, platform packaging, signatures and permission isolation are distinct guarantees, not disposable duplicate PR checks. |
| Device matrix discover/probe/smoke | Keep scheduled/manual | Xcode/macOS compatibility is distinct; it already avoids normal PR cost. |
| Marketing validation | Keep conditional | Docs, accessibility, SEO, visual/e2e and performance checks remain. Fixture-enabled and production builds have different inputs and are not redundant. |
| PR size config/sync/label | Keep | Tiny API-only policy runners do not install a workspace; retain permission separation. Not the measured critical path. |
| PR vouch | Keep | Trusted-event security/policy workflow, not a source-validation lane; never combine with untrusted PR checkout. |
| Issue label sync | Keep conditional | Already limited to label/template administration changes or manual runs. |

No claim about a job's historical independent failure rate is made from one
successful sample. Removal decisions use exact duplicate commands or measured
setup amortization, not the absence of observed failures. The recent run listing
was inspected, but no statistically meaningful flaky/independent-failure rate
was established.

## Setup and cache decisions

The Windows Bun package archive is removed. The measured cache *hit* downloaded
533 MiB and spent **325.967s extracting** it, before a **33.49s frozen install**.
The full cache action took 331.465s. Windows continues to reconstruct dependencies
from the frozen lockfile; its native process tests are not removed.

Linux's separate Bun package archive restored another 19 MiB in 2.069s while
`node_modules` already restored 738 MiB in 15.785s. The subsequent install took
1.67s. The duplicate package archive is removed; the installed tree is retained
provisionally, with exact keys incorporating OS, architecture, lockfile, manifests,
patches and setup action. No broad installed-tree restore key survives. Electron
and non-Electron trees remain isolated because the binary lives inside that tree.
Every cache hit still runs `bun install --frozen-lockfile` and lifecycle patches.

The separately measured release-smoke cold `--ignore-scripts` install took 17s.
That is not an apples-to-apples proof that Linux `node_modules` caching is good or
bad: it omits the ordinary postinstall. A cold/warm comparison must retain the
normal lifecycle scripts before removing this cache.

Turbo archives are restored/saved only by unit and desktop build lanes, which
consume cacheable prerequisite builds. Static, browser, Windows and nightly no
longer shuttle unused Turbo snapshots. The actual store is `.turbo`; workflow
text no longer fragments the outer key, while Turbo still verifies task hashes.
Both tests and typechecks remain `cache:false`; no stale test-result assumption
has been introduced. Cross-job build transfer was not added: a new producer job
and artifact dependency could lengthen the critical path, and its ROI is unproven.

The web suite and nightly share one Playwright setup action keyed by the installed
Playwright version, OS and architecture rather than every unrelated lockfile
change. Each admitted browser runner still installs its required OS libraries
with the local binary's `install --with-deps chromium`. Cached browser archives do
not replace apt dependencies. Electron remains exclusive to desktop setup.

## Measurements

Baseline: successful main run
[34754198860](https://github.com/Emanuele-web04/synara/actions/runs/34754198860),
commit `939d93c35c8d748c6a52ac17bb4f7423a43c8ddb`, 2026-09-13.
API job timestamps have one-second resolution. Runner time means the sum of
allocated job durations, not billed minutes or monetary cost; it excludes queue
time and price multipliers. Gate latency is run creation to required-gate job
completion. The run-level update timestamp differs by one second from that job's
completion: 8m33s versus **8m34s**. The latter is the metric used here.

| Baseline job | Runner seconds | Workspace/tool setup seconds | Validation command seconds |
| --- | ---: | ---: | ---: |
| Change detection | 9 | 0 | 1 |
| Static fast | 40 | 24 | 7 |
| Typecheck | 56 | 22 | 26 |
| Migration lineage | 13 | 1 | <1 |
| Release smoke | 29 | 19 | 1 |
| Windows process | 492 | 393 | 69 |
| Desktop build | 114 | 20 | 85 |
| Unit core | 59 | 17 | 35 |
| Unit web | 144 | 24 | 111 |
| Unit server 1/2 | 158 | 27 | 123 |
| Unit server 2/2 | 246 | 18 | 221 |
| Browser chat-follow | 188 | 17 | 149 |
| Browser chat-workflows | 321 | 29 | 264 |
| Browser components 1/2 | 189 | 18 | 149 |
| Browser components 2/2 | 272 | 18 | 230 |
| Quality gate | 4 | 0 | <1 |
| **Total** | **2334 (38.90 minutes)** | | |

Setup columns do not include every checkout, post-action or browser install, so
they are not expected to sum to runner duration. Unit command duration includes
Turbo prerequisites and cannot be called pure Vitest time. Browser cache restores
totaled 14s and browser/OS setup 48s across four runners. The first jobs started
5s after run creation; admitted jobs generally started 1–2s after creation. These
queue observations are a sample, not a future runner availability guarantee.

The Windows cache snapshot was a hit; its Turbo cache was a miss and even its
unused post-cache warning consumed 5.297s. Linux static restored an unused Turbo
snapshot in 1.623s and saved another immutable snapshot in 1.677s. Cache hits are
therefore not, by themselves, evidence of useful acceleration.

### Before/after status

| Metric | Before (measured unless stated) | After | Change / evidence |
| --- | --- | --- | --- |
| Required-gate critical-path latency | 8m34s | Hosted measurement pending | Do not substitute a projection for a passing run. |
| Total raw runner minutes | 38.90 | Hosted measurement pending | Unweighted; no invented billing savings. |
| Full web/foundational PR runner jobs | 16 | 13 | Structurally proven: 3 fewer jobs (18.75%). |
| Server/migration-only PR runner jobs | 16 | 8 | Structurally proven: 50% fewer jobs. |
| Desktop-only PR runner jobs | 16 | 10 | Structurally proven: 37.5% fewer jobs. |
| Docs-only main CI runner jobs | 3 | 3 | Preserves formatting/lint/source guards. |
| Full-run workspace dependency installs | 13 | 11 | Structurally proven: two removed installs. |
| Browser runtime preparations, full run | 4 | 4 | Preserved useful parallelism. |
| Browser runtime preparations, server-only | 4 | 0 | Unrelated stable browser suite not allocated. |
| Windows runner usage, product changes | 1 job, 492s | 1 job; time pending | All native regression coverage retained. |
| Windows Bun archive restore | 331.465s, including 325.967s extraction | 0 | Removed action, not an estimated cache hit. |
| Windows Vitest process invocations | 9 | 4 | Exact same target files and credential test selection. |
| Linux installed-tree restore + install | 15.785s + 1.67s | Cold/warm comparison pending | Cache retained, not claimed faster without evidence. |

The mechanism-based projection is that Windows ceases to dominate and the
approximately 321s browser lane becomes the full-run critical path. That could
reduce gate latency by roughly 30%, but download variance, cold caches and queue
costs must be measured. The expected full-run compute reduction is smaller than
the latency reduction; targeted server/migration PRs have larger structural
savings. No measured 30% performance claim is made until after-run evidence exists.

## Verification and remaining opportunities

Local Node-native tests and YAML parsing validate the planner and gate without
Bun. Local fixture results are not substitutes for the actual workspace or hosted
Linux/Windows/browser toolchains. The PR runs the actual manifest contract tests,
actionlint, repository format/lint/typecheck, the complete admitted Turbo unit
matrix, all stable browser partitions, desktop build, native Windows tests,
migration lineage and release smoke. Formatting failures retain a red job and
attach a repair patch; no check is converted to advisory status.

Further shard rebalancing needs multiple runs with per-test timing, particularly
the 123s/221s server and 149s/264s ChatView imbalance. Reducing or increasing shards
blindly would not be justified. A normal-lifecycle cold/warm Linux cache benchmark
and a provenance-preserving release build artifact reuse design are meaningful
follow-ups. Fixing the underlying Linux geometry quarantine is separate work;
stable correctness tests have not been moved into it.
