# Changelog

## 0.5.1 - 2026-07-13

### Added

- Added Factory Droid as a first-class ACP provider, including runtime model discovery, session import, context-preserving forks and restarts, token multipliers, provider-aware model switching, and Factory branding.
- Added `Alt+]` / `Alt+[` shortcuts for cycling through available models without leaving the conversation.
- Kept unfinished task lists visible in the transcript after a turn completes, so follow-up work is easier to resume.

### Changed

- Changed file undo to restore turn-scoped workspace changes without trimming chat history or rolling back the conversation that explains them.
- Improved cross-platform agent workflows with runtime Codex reasoning options, more reliable Windows CLI launching, platform-aware project folder labels, and graceful Git status checks outside repositories.
- Softened the file-change header treatment so active diffs are easier to scan.
- Removed the Windows process regression job from CI.

### Fixed

- Fixed model cycling and runtime-discovered reasoning options so the active provider's available choices remain consistent while a conversation is open.
- Fixed task-list projection so unfinished work is not hidden when a turn settles.

### Verification

- `bun run fmt:check` passed across 13,086 files.
- `bun run lint` passed with 184 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed after rerunning outside the sandbox; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, unresolved `original-fs`, and large Vite chunk warnings.
- Full `bun run test` passed: 10 Turbo tasks; web passed 201 files / 2,481 tests, CLI passed 161 files / 1,770 tests with 2 skipped files and 7 skipped tests, and the remaining packages passed their suites with 1 skipped shared test.

## 0.5.0 - 2026-07-11

### Added

- Added live Claude context-usage controls, near-window warnings, in-session model/context switching, and resumable context state.
- Added Claude task tracking for TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite, normalized into the shared runtime task list.
- Added shared provider task progress and richer Codex reasoning summaries, compaction events, and runtime task updates for clearer long-running turns.

### Changed

- Completed the Synara identity cutover across desktop packaging, the renderer origin, workspace packages, the public CLI, runtime variables, storage, Git metadata, assets, documentation, and release automation.
- Set the production bundle ID and Windows AUMID to `com.emanueledipietro.synara`, with `.dev` used only for development.
- Published the CLI identity as `@synara/cli` with the `synara` executable and moved all first-party workspaces to `@synara/*`.
- Kept persisted renderer state available through the 0.4.2 origin bridge and retained brand-neutral structural access to existing checkpoint refs and migration lineage.
- Deferred secondary chat dock panels and added a repeatable LCP measurement script so the main conversation can become interactive sooner.
- Hardened the staged updater feed, compatibility-channel checks, and desktop startup around bundle swaps.

### Fixed

- Fixed Claude and Codex resume paths so task progress, context state, reasoning summaries, and streamed runtime events survive reconnects without unnecessary provider restarts.
- Fixed noisy Codex app-server stdout and incomplete reasoning ingestion from obscuring or dropping live transcript activity.
- Fixed deleted-project reconciliation and browser profile migration edge cases by preserving client tombstones and repairing database sidecars transactionally.

### Verification

- `bun run fmt:check` passed across 13,057 files.
- `bun run lint` passed with 178 warnings and 0 errors.
- `bun run typecheck` passed across all 8 packages; only existing TS44 informational JSON/schema-preference messages were reported.
- `bun run release:smoke` passed with Bun temporary staging available; it reported `@pierre/diffs@1.2.12` as newer than the pinned `1.2.8`.
- `bun run build` passed with 6 successful tasks and the existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings.
- Final full `bun run test` passed: 10 Turbo tasks; `@synara/web` passed 200 files / 2,426 tests, and `@synara/cli` passed 152 files / 1,698 tests with 1 skipped file and 6 skipped tests. The initial run was interrupted while waiting on the serial server suite; the final rerun completed cleanly.

### Upgrade note

- Launch Synara 0.4.2 once before upgrading so renderer-local UI state is exported before 0.5.0 adopts the canonical `synara://app` origin.

## 0.4.2 - 2026-07-09

### Added

- Added the Synara identity bridge that exports canonical renderer storage before the packaged origin changes.
- Added per-thread 1M-token context window tracking for Claude sessions, with automatic compaction handling and context-usage warnings near the window limit.
- Added fallback model pinning for Claude after a safeguard reroute, cleared when the user explicitly selects a different model.
- Added a durable desktop update install marker that verifies installs across restarts, plus an install watchdog with recovery and macOS ShipIt/launchctl update diagnostics.
- Added a build-only native release validation mode and a team-bound macOS signing requirement for seamless future updates.
- Added a durable, bounded Codex-overlay suppression marker without modifying the user's source configuration.

### Changed

- Claude model and context-window switches now happen in-session instead of forcing a full session restart, sharply reducing restarts and runaway token usage.
- Canonicalized migration and checkpoint metadata while keeping existing persisted refs readable.
- Enforced the staged Synara update feed end to end, with fail-closed preflight checks in the release pipeline.
- Made Windows code signing optional in the release pipeline and finalized Synara license attribution.

### Fixed

- Fixed the new-chat keyboard shortcut routing inside Studio.
- Repaired incomplete legacy home imports and restored the legacy environment identity from the bridge marker.
- Ordered renderer storage migration before app hydration and guarded renderer bootstrap ordering.
- Preserved composer drafts more reliably through the storage-key migration.

### Verification

- `bun run fmt`, `bun run lint`, `bun run typecheck`, `bun run release:smoke`, `bun run build`, and the full `bun run test` suite (1688 passed, 6 skipped, 0 failed) all passed on the release commit.
- Build-only native validation succeeded for macOS arm64/x64, Linux x64, and Windows x64 prior to tagging; the tagged release pipeline completed with all four platform builds green.

### Upgrade note

- Launch Synara 0.4.2 at least once before installing the next release. This preserves drafts, pins, theme, browser state, and other local UI state through the identity cutover.
- Earlier command and environment aliases are accepted by 0.4.2 only and are removed by the following release.

## 0.4.1 - 2026-07-09

### Added

- Added Studio: a dedicated workspace for long-running, agent-led work, with its own projects, threads, routes, sidebar entries, and empty-state entry points.
- Added a Studio outputs surface in the Environment panel for agent-produced files, generated images, and related activity.
- Added visible project worktree setup steps so workspace preparation and setup failures are easier to understand.
- Added focused coverage for Studio routing, output projection, worktree setup, restore behavior, project metadata, and transcript/workspace handoffs.

### Changed

- Refined chat and Studio creation, routing, and restore flows to use canonical containers, wait for hydration when needed, and avoid overlapping fresh-chat creation.
- Refined session orchestration and transcript rendering so active work, sidebar visibility, and worktree setup remain predictable across streaming, reconnects, and segment switches.
- Refined Studio scaffolding and project ownership rules to preserve clear workspace boundaries during retries, restores, and partial creation states.
- Bumped Synara release package versions to `0.4.1` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.

### Fixed

- Fixed cross-kind project reuse so regular chats and Studio threads cannot accidentally share an incompatible container or workspace root.
- Fixed several restore and route edge cases involving archived threads, hidden segments, draft targets, startup hydration, and unclassifiable thread kinds.
- Fixed Codex startup ordering by preparing the authentication overlay before dependent paths, and fixed the Codex launcher path on Windows.
- Fixed Studio output display and projection edge cases so generated images and output activity remain discoverable in the Environment panel.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with existing warnings and no errors.
- `bun run typecheck` passed across all 8 packages (with existing TS44 informational JSON/schema-preference messages).
- `bun run release:smoke` passed.
- `bun run build` passed (with existing Astro, tsdown/plugin-timing, desktop module-type, and large Vite chunk warnings).
- `bun run test` passed.

## 0.4.0 - 2026-07-06

### Added

- Added richer pull request snapshot data in the Environment panel, including review/check preview handling and merged-state awareness.
- Added prompt-history navigation support that preserves the current draft's file/image attachments while browsing previous prompts.
- Added graceful Claude usage/rate-limit handling so provider usage limits show as a recoverable user-facing state instead of a generic failure.
- Added focused release coverage around PR snapshot edge cases, prompt-history navigation, provider usage parsing, and desktop restart stderr handling.

### Changed

- Bumped Synara release package versions to `0.4.0` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined prompt history navigation so stale navigation state resets cleanly and optimistic prompt-history entries do not duplicate after sends.
- Refined PR snapshot loading to dedupe GitHub field lists, format merge-head details more consistently, and keep long review previews readable.
- Refined provider usage type handling around Claude summaries and rate-limit responses.

### Fixed

- Fixed prompt-history browsing losing draft attachments while moving through previous prompts.
- Fixed duplicate optimistic prompt-history entries and stale prompt-history navigation state after related sends.
- Fixed desktop restart handling for broken stderr pipes, including the EPIPE path from restarted child processes.
- Fixed PR snapshot follow-up issues around merged PR state, truncated review previews, and merge-head formatting.
- Fixed automation migration lineage assertions and provider usage summary type narrowing uncovered by the recent release work.

### Verification

- `bun run fmt:check` passed across 1535 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages in 18.277s with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 16.479s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.477s. `@synara/web` passed 194 files / 2352 tests, and `synara` passed 145 files with 1 skipped file, 1593 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.4.0`, and `npm run lint` passed.

## 0.3.9 - 2026-07-05

### Added

- Added the app-level `/export` slash command for saved, idle threads, producing a streamed ZIP archive with `thread.json` and `transcript.md`.
- Added full-history export hydration, shared export eligibility checks, blocked-export reasons, desktop CORS/error handling, and command-menu support for `/export`.
- Added profile stats archival for purged threads, including migration `050_ProfileStatsArchive`, retained command receipts, checkpoint ref cleanup safeguards, and retention cleanup coverage.
- Added a stable active-turn "Working for" transcript header while preserving the existing pending-setup shimmer row.
- Added a dedicated terminal process-tree killer with SIGTERM-to-SIGKILL escalation and disposal timing coverage.
- Added runtime-discovered OpenCode/Kilo model support for Git writing settings, plus contract/query coverage for selected text-generation backends.

### Changed

- Bumped Synara release package versions to `0.3.9` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined `/export` to stream archive entries incrementally, deflate large entries without buffering the whole ZIP, and avoid offering export while a turn is running or still streaming.
- Refined thread purge behavior so archived profile aggregates continue contributing to profile queries after thread rows are removed.
- Refined terminal shutdown so disposal waits for kill escalation instead of returning while stubborn process trees may still be alive.
- Refined Git action text-generation selection so commit messages, diff summaries, and PR text route through the configured Git-writing provider/model.

### Fixed

- Fixed `/export` menu selections falling through silently and local draft threads offering an export path that would 404.
- Fixed very large thread exports being capped by the UI thread-detail message limit.
- Fixed ACP resumed sessions reusing fallback assistant message IDs across runtime restarts, which could overwrite earlier assistant transcript segments.
- Fixed OpenCode/Kilo Git-writing model selections failing to reach Git actions and falling back to the wrong backend.
- Fixed archived profile stats being lost when thread cleanup purged the underlying messages and command receipts.
- Fixed terminal shutdown paths that could leave stubborn subprocess trees alive after disposal.

### Verification

- `bun run fmt:check` passed across 1528 files.
- `bun run lint` passed with 168 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 18.768s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Full `bun run test` passed: 10 tasks successful in 6m35.955s. `@synara/web` passed 193 files / 2316 tests, and `synara` passed 144 files with 1 skipped file, 1575 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.9`, and `npm run lint` passed.

## 0.3.8 - 2026-07-03

### Added

- Added ACP/Grok resume and compaction hardening so resumed sessions drop unsafe replay before consumers attach, seed quiet windows from response timing, and avoid memory-heavy replay loops.
- Added explicit worktree setup progress/failure state in local dispatch snapshots, transcript rows, and browser coverage.
- Added automation dispatch-origin persistence and a "Sent via Automation" transcript label for scheduled and heartbeat-triggered user turns.
- Added approval panel browser coverage for allow/deny decisions and shared choice-row presentation for pending approvals.
- Added focused tests for collapsed transcript work-duration grouping, failed worktree setup reset behavior, session lifecycle handling, provider/runtime ingestion, and profile/sidebar presentation helpers.

### Changed

- Bumped Synara release package versions to `0.3.8` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Refined ACP session runtime and Grok adapter handling around resume replay, compaction, JSON-RPC ordering, provider runtime ingestion, and provider service session state.
- Refined worktree setup timeline rendering so setup rows expose active/failed/done state more predictably and failed local dispatches clear on the next send.
- Reworked pending approval UI around the shared `ComposerChoiceRow` structure, trimming duplicate action styling and aligning it with pending input panels.
- Gated Claude credential keepalive/startup refresh behavior and refined provider usage/query invalidation paths so app startup does less surprise provider work.
- Refined transcript, sidebar, profile stats, share-card, and timeline-height logic around dispatch origins and folded work rows.

### Fixed

- Fixed Grok/ACP resume replay ordering that could attach replay before the event consumer and make resumed or compacted sessions unstable.
- Fixed failed worktree setup dispatch state lingering into a new local turn instead of resetting when the user sends again.
- Fixed collapsed turn "Worked for" timing so folded transcript segments report a duration spanning the whole folded section.
- Fixed automation-origin turns missing a durable transcript projection marker.
- Fixed a release-gate `exactOptionalPropertyTypes` error in `apps/web/src/components/ChatView.tsx` by omitting the optional dispatch `options` property when there is no worktree setup step.
- Fixed backend Node option handling around unsupported `--js-flags` forwarding while keeping covered desktop startup behavior.

### Verification

- `bun run fmt:check` passed across 1518 files.
- `bun run lint` passed with 162 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.tsx` because `beginLocalDispatch` passed an explicit `options: undefined` into an exact-optional helper; after the targeted fix, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 23.921s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, Rolldown/Babel plugin timing, and large Vite chunk warnings.
- Initial full `bun run test` failed in `@synara/web` with one timeout: `apps/web/src/components/ChatMarkdown.test.tsx > ChatMarkdown > uses the theme foreground token for markdown text`. No stale duplicate test processes were present; the targeted rerun `bun run test src/components/ChatMarkdown.test.tsx -t "uses the theme foreground token for markdown text"` from `apps/web` passed in 1.01s.
- Final full `bun run test` passed: 10 tasks successful in 9m28.476s. `@synara/web` passed 193 files / 2308 tests, `synara` passed 140 files with 1 skipped file, 1547 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.8`, and `npm run lint` passed.

## 0.3.7 - 2026-07-02

### Added

- Added live desktop update download percentages on the sidebar update button, including clamped integer handling and focused edge-case coverage.
- Added single-flight checkpoint capture for matching repo/ref pairs, with a 180s aggregate timeout and first-writer-wins `skipIfExists` baselines.
- Added recovery coverage for missing message-start baselines before turn-start checkpoint aliasing.
- Added pure Claude auth-status parsing and generic provider CLI-output helpers, making provider health behavior easier to test in isolation.
- Added a shared in-process `claude auth status` lock so health probes and macOS credential keepalive ticks do not race the same rotating OAuth refresh token.
- Added CI timeouts and non-interactive browser-runtime install safeguards so hosted quality runs fail fast instead of hanging indefinitely.

### Changed

- Bumped Synara release package versions to `0.3.7` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace metadata.
- Moved the sidebar Chats section into the scrollable sidebar content, added an accessible disclosure state, and reused the shared disclosure chevron.
- Refined the desktop update action styling to use the info color while active downloads show a compact percent pill.
- Refined Claude provider health to retry structured `loggedIn:false` false negatives once, read verified local credential metadata, and preserve subscription/auth labels more reliably.
- Forked the macOS Claude credential keepalive after server startup and passed the configured home dir into the Claude process environment so the best-effort keepalive cannot block boot.
- Moved the CI quality job onto GitHub-hosted runners and switched Playwright installation to the workspace-local binary after `bunx` installs stalled.

### Fixed

- Fixed Claude Agent health checks that could briefly report an authenticated account as logged out when concurrent `claude auth status` calls raced a refresh-token rotation.
- Fixed checkpoint baseline races that could overwrite or miss the original pre-turn snapshot used for transcript diffs and restore points.
- Fixed first-message sends from the empty chat landing opening the Environment panel unexpectedly after the transcript view appears.
- Fixed crowded sidebar footer behavior by keeping chat history rows with the main sidebar list and leaving the footer for account/update controls.
- Fixed release CI being blocked by the unavailable Blacksmith runner queue; Linux browser tests now continue for signal without blocking while geometry parity failures are tracked separately.

### Verification

- `bun run fmt:check` passed across 1508 files.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON/schema-preference messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It noted an available newer `@pierre/diffs@1.2.12` while keeping the current dependency range unchanged.
- `bun run build` passed: 6 tasks successful in 14.425s. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, Rolldown/Babel plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m23.405s. `@synara/web` passed 191 files / 2274 tests. `effect-acp` passed 3 files / 24 tests. `synara` passed 140 files with 1 skipped file, 1532 passed tests, and 6 skipped tests.
- `bun install` refreshed `bun.lock` after the package-version bump and reported no dependency changes.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.7`, and `npm run lint` passed.

## 0.3.6 - 2026-06-30

### Added

- Added safer Cursor ACP command discovery and launcher fallback coverage for bundled sibling shims, legacy shims, and fallback ordering.
- Added Muxy Open In support through editor metadata, server open handling, and focused tests.
- Added live message trail rendering, shared trail logic, browser coverage, and timeline integration for active transcript updates.
- Added desktop clipboard image sharing for share-card/profile exports.
- Added Claude credential keepalive coverage to keep macOS OAuth credentials fresh across longer sessions.

### Changed

- Bumped Synara release package versions to `0.3.6` across the server, desktop, web, and contracts packages.
- Refined Cursor agent command resolution so fallback launchers prefer known-safe agent paths and reject unsafe editor fallbacks.
- Refined checkpoint and transcript handling around turn completion, live trail rendering, and message timeline integration.
- Refined Sonnet 5 model variant metadata, sidebar status icons, command-row branding, tool-call labels, chat bubble padding, and model effort picker copy.
- Refined task-completion notification logic and share-card export behavior around desktop clipboard support.

### Fixed

- Fixed Cursor ACP CLI path resolution for packaged/bundled Cursor layouts and legacy shim paths.
- Fixed unsafe Cursor editor fallback behavior by rejecting launch paths that do not match the expected agent command shape.
- Fixed Claude sessions becoming stale after long macOS OAuth credential idle periods.
- Fixed file-change checkpoint timing around completed turns so summaries attach after the relevant assistant message is known.
- Fixed formatting drift in ProviderHealth, Cursor ACP, and shared model test files caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/provider/Layers/ProviderHealth.test.ts`, `apps/server/src/provider/Layers/ProviderHealth.ts`, `apps/server/src/provider/acp/CursorAcpCommand.ts`, `apps/server/src/provider/acp/CursorAcpSupport.ts`, and `packages/shared/src/model.test.ts`; after targeted `bunx oxfmt` on those files, the final formatter check passed.
- `bun run lint` passed with 158 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m38.929s. `@synara/web` passed 191 files / 2273 tests. `synara` passed 138 files with 1 skipped file, 1517 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` and `npm run lint` passed.

## 0.3.5 - 2026-06-30

### Added

- Added temporary-thread promotion coverage and renamed disposable-thread helpers around the temporary-thread lifecycle.
- Added undo-toast archive behavior for sidebar thread archive actions, backed by shared thread archive helpers and toast coverage.
- Added macOS desktop icon-cache refresh logic with startup/update integration and focused platform-gated tests.
- Added focused coverage for queued composer headers, timeline work-row grouping, diff rendering, thread archive undo, and desktop update button presentation.

### Changed

- Bumped Synara release package versions to `0.3.5` across the server, desktop, web, and contracts packages, and refreshed `bun.lock` workspace package versions.
- Reworked temporary chat promotion so draft/temporary threads move into durable chat flow more predictably across ChatView, sidebar state, session logic, and route activation.
- Replaced archive confirmation friction with immediate archive plus undo toast, including sidebar row actions, settings primitives, and shared error messaging polish.
- Refined pending user-input panels, queued composer state, work rows, tool details, markdown spacing, composer picker styling, model/traits pickers, and chat timeline presentation.
- Cleaned up activity heatmap export, share cards, diff-rendering helpers, sidebar labels, and several compact toolbar/control labels.

### Fixed

- Fixed dark-mode composer input surface border styling after the recent composer picker polish.
- Fixed stale macOS Dock/Finder icon behavior after app icon changes by refreshing icon caches from the desktop process when needed.
- Fixed archive recovery ergonomics by replacing the blocking confirmation path with a reversible toast action.
- Fixed temporary-thread naming and lifecycle drift left over from disposable-thread terminology.
- Fixed small UI inconsistencies in pending approvals, pending inputs, PDF toolbar, terminal chrome, settings routes, and What's New popout sizing.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state. It reported a slow filesystem warning for the Bun install cache during the final pass.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 6m9.469s. `@synara/web` passed 190 files / 2229 tests. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.5`, and `npm run lint` passed.

## 0.3.4 - 2026-06-29

### Added

- Added assistant streaming as the default for fresh app/server settings so new installs start with live assistant output enabled.
- Added smoother transcript auto-follow coverage for optimistic sends, streaming assistant text, message entry animations, and tool detail interactions.
- Added broader provider-health coverage for Claude local CLI credentials, Cursor ACP/headless probing, OpenCode model/runtime handling, and provider model-probe failures.
- Added focused OpenCode retry-warning ingestion and web session coverage so retry notices stay attached to work-log rows and collapse consistently across turns.
- Added tool-call label coverage and refined central icon usage for agent mentions, task rows, and file-change entries.

### Changed

- Bumped Synara release package versions to `0.3.4` across the server, desktop, web, and contracts packages.
- Refined transcript streaming and session-state handling so live assistant output, tool rows, and bottom-stick behavior stay separated more predictably.
- Made Claude provider health prefer usable local CLI credentials before inheriting direct credential env keys into subprocesses.
- Made Cursor provider probing use a safer headless environment for ACP commands.
- Improved chat card contrast, agent glyph consistency, file-change icon choices, and shared switch sizing/thumb animation.

### Fixed

- Fixed OpenCode retry warnings being projected into the wrong conversation surface or failing to collapse consistently across turns.
- Fixed provider-health status handling so model-probe failures can keep an authenticated provider available with a warning instead of degrading it too aggressively.
- Fixed transcript browser test type drift by normalizing `scrollTo` test-helper options without explicit `undefined` optional fields.
- Fixed Claude provider-health type drift by only passing `homeDir` to the Claude env builder when it exists.
- Fixed ProviderHealth test type drift by using the Effect platform `"Unknown"` system error tag supported by this workspace.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on `apps/web/src/components/ChatView.browser.tsx` because a browser `scrollTo` test helper produced explicit `undefined` optional fields; after that fix it failed in `synara` on `apps/server/src/provider/Layers/ProviderHealth.ts` and `ProviderHealth.test.ts` for the same exact-optional pattern and an unsupported Effect platform error tag; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- Initial `bun run test` failed in `@synara/web` on `apps/web/src/appSettings.test.ts` because the persisted-settings decode-default fixture still expected `enableAssistantStreaming: false`; after updating the fixture to the new default, the targeted app settings test passed.
- Final `bun run test` passed: 10 tasks successful in 6m5.217s. `synara` passed 137 files with 1 skipped file, 1492 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.4`, and `npm run lint` passed.

## 0.3.3 - 2026-06-28

### Added

- Added Windows packaged-app editor discovery so VS Code and VS Code Insiders installed from the Microsoft Store can be launched from Synara.
- Added Windows editor URI fallback handling when the normal editor command is unavailable or unsuitable.
- Added a provider update-check preference across server settings, web app settings, settings search, provider health, and update notification filtering.
- Added shared workspace explorer keyboard navigation coverage and a dedicated keyboard shortcuts settings panel.
- Added focused release-gate coverage updates for server settings push payloads and Windows editor launch behavior.

### Changed

- Bumped Synara release package versions to `0.3.3` across the server, desktop, web, and contracts packages.
- Refreshed Synara icon and logo assets across desktop resources, marketing assets, web favicons, app icons, and shared brand assets.
- Corrected macOS app icon packaging after the Ventura rounded-icon pass and removed the temporary literal Dock icon workaround.
- Unified workspace explorer presentation, file row styling, diff stat labels, DockExplorerPane behavior, and shortcut settings navigation.
- Reduced idle local server polling by giving server React Query a calmer idle refresh cadence while preserving active-session refresh behavior.
- Aligned menu checkbox switch styling with the shared switch primitive track/thumb classes so compact switch-shaped controls stay visually consistent.

### Fixed

- Fixed VS Code Store editor launch on Windows by resolving packaged app identities and falling back to URI activation when needed.
- Fixed provider update notification behavior so disabled update checks suppress background notices instead of continuing to surface provider updates.
- Fixed release-blocking server typecheck drift in `apps/server/src/open.ts` by using the Effect error handler API available in this workspace.
- Fixed release-blocking web typecheck drift in `apps/web/src/wsNativeApi.test.ts` by including `enableProviderUpdateChecks` in the mocked server settings payload.
- Fixed formatting drift in `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/editorAppDiscovery.ts`, `apps/server/src/open.test.ts`, and `scripts/build-desktop-artifact.ts`; after targeted `bunx oxfmt` on those files, `bun run fmt:check` passed.
- `bun run lint` passed with 155 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` because `wsNativeApi.test.ts` missed the new `enableProviderUpdateChecks` setting; after that fix it failed in `synara` because `apps/server/src/open.ts` used unavailable `Effect.catchAll`; after both fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m8.962s. `@synara/web` passed 188 files / 2212 tests. `synara` passed 136 files with 1 skipped file, 1475 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.3`, and `npm run lint` passed.

## 0.3.2 - 2026-06-27

### Added

- Added project selection to the branch toolbar so project, branch, and worktree context can be managed from the active chat surface.
- Added preview grants for absolute local files, including local image route coverage, trusted-origin checks, workspace file-system normalization, and web preview/download handling.
- Added a collapsible review file tree for the diff panel, backed by shared file-diff tree logic and shared disclosure motion.
- Added focused coverage for branch toolbar project selection, chat-project container selection, project creation recovery, local file preview grants, review file trees, route inset surfaces, provider availability, and workspace file openers.

### Changed

- Bumped Synara release package versions to `0.3.2` across the server, desktop, web, and contracts packages.
- Refactored transcript scrolling and session-state handling so ChatView owns less browser-specific behavior directly and live transcript/layout state has clearer boundaries.
- Refactored composer chrome measurement, right-dock metadata, workspace preview headers, and the workspace explorer into reusable pieces.
- Made project and home-chat container selection more explicit by sharing project creation/recovery, draft-thread mapping, and chat-container selection helpers across sidebar and toolbar entrypoints.
- Refined provider send readiness by refreshing provider status before chat, Kanban, handoff, and route-driven sends, then returning focus to the composer more consistently.
- Unified explorer icons, working shimmer styles, compact route inset surfaces, composer picker styling, and sidebar visual details.

### Fixed

- Fixed absolute local file previews that could fail to open or download when agent output referenced files outside the immediate workspace preview path.
- Fixed review-heavy diff navigation by adding a tree view instead of forcing users to scan a flat patch list.
- Fixed stale provider availability before send paths that could leave chat or Kanban actions using outdated provider state.
- Fixed release-blocking exact-optional typecheck drift in `apps/web/src/components/Sidebar.tsx`, `apps/web/src/composerDraftStore.ts`, and `apps/web/src/lib/chatProjects.ts`.
- Fixed formatting drift in `apps/web/src/components/RouteInsetSurface.tsx` caught by the release gate.

### Verification

- Initial `bun run fmt:check` failed on `apps/web/src/components/RouteInsetSurface.tsx`; after targeted `bunx oxfmt` on that file, `bun run fmt:check` passed.
- `bun run lint` passed with 154 warnings, 0 errors.
- Initial `bun run typecheck` failed in `@synara/web` on exact optional property handling in `Sidebar.tsx`, `composerDraftStore.ts`, and `chatProjects.ts`; after targeted fixes, `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed. It refreshed install/lockfile state during `bun install`, with no remaining `bun.lock` diff.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m44.64s. `@synara/web` passed 187 files / 2205 tests. `synara` passed 136 files with 1 skipped file, 1464 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.2`, and `npm run lint` passed.

## 0.3.1 - 2026-06-26

### Added

- Added transcript tool-call detail dialogs and formatting helpers for command output, patches, file changes, and tool output so command-heavy turns are easier to inspect.
- Added regression coverage for tool-call labels, tool-call detail formatting, message timeline grouping, sidebar hover-card anchoring, keybindings, Gemini ACP probing, provider runtime ingestion, ProviderService behavior, electron-updater security, and Windows process handling.
- Added a curated central icon asset set and provider/UI icon plumbing used by newer picker, header, sidebar, and preview surfaces.
- Added more explicit project and thread hover-card content, thread pin toggle behavior, recent view switching, and project shortcut targeting.

### Changed

- Bumped Synara release package versions to `0.3.1` across the server, desktop, web, and contracts packages.
- Refined session orchestration and transcript handling so assistant messages, tool/work rows, collapsed turns, runtime activity, and sidechat state stay separated more predictably.
- Improved chat header, recent-view, sidebar, split-chat, and hover-card navigation for multi-pane workflows.
- Tightened keyboard shortcut defaults and persisted keybinding migrations for chat creation, terminal creation, navigation, and duplicate/stale binding rows.
- Expanded provider runtime ingestion for canonical Codex event shapes, generated-image markdown, MCP tool progress, reasoning deltas, proposed-plan events, and synthetic placeholder thread ids.
- Hardened provider management around idle runtime retention, provider health refresh, process cleanup, Cursor/Gemini/Grok adapter paths, OpenCode runtime handling, and Gemini ACP probe parsing.
- Made automation setup/update flows stricter by separating conversational setup prompts, update-only approval paths, approval fallback behavior, prompt filler removal, and risk acknowledgement gating.
- Improved desktop startup/update handling by reducing noisy Node deprecation warnings and tightening electron-updater Windows command construction.
- Refined composer, automation banners, provider/model pickers, Kanban cards, preview cards, tooltip primitives, and project/sidebar icons with smaller consistency fixes.
- Welcomed focused external contributions in the project docs and README while keeping the early-WIP guidance explicit.

### Fixed

- Fixed transcript tool-call inspection gaps where shell command output, patch details, and normalized tool output were hard to review from the UI.
- Fixed session orchestration edge cases around review interrupt retry, compaction progress, runtime event replay, generated image completion replay, and provider-thread placeholder matching.
- Fixed provider runtime warning and ingestion paths that could mishandle missing usage details, auxiliary turn completions, or non-active turn completions in synthetic/runtime tests.
- Fixed automation approval regressions around update-only flows, fallback prompts, conversational setup follow-up text, and dispatch-time risk acknowledgement.
- Fixed desktop updater command-hardening coverage and reduced startup warning noise from desktop Node behavior.
- Fixed formatting drift caught by the release gate in `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`.

### Verification

- Initial `bun run fmt:check` failed on `apps/server/src/keybindings.test.ts` and `apps/web/src/components/chat/ToolCallDetailsDialog.tsx`; after targeted `bunx oxfmt` on those two files, `bun run fmt:check` passed.
- `bun run lint` passed with 156 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left `bun.lock` unchanged.
- `bun run build` passed. The build still reports existing Astro `transformWithEsbuild`, tsdown/plugin timing, desktop typeless-module, and large Vite chunk warnings.
- `bun run test` passed: 10 tasks successful in 5m6s. `@synara/web` passed 182 files / 2164 tests. `synara` passed 135 files with 1 skipped file, 1456 passed tests, and 6 skipped tests.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.1`, and `npm run lint` passed.

## 0.3.0 - 2026-06-24

### Added

- Added first-class Automations as a real Synara workspace surface, including contracts, persistence, scheduler leases, run tracking, RPC methods, sidebar navigation, list/detail routes, Current/Paused views, inline detail editing, previous-run history, and triage actions.
- Added automation scheduler and composer flows so saved prompts can run manually, once, on intervals, daily, on weekdays, weekly, or from cron-like schedules.
- Added heartbeat automations that continue an existing target thread on each scheduled wake while preserving the normal provider/session/approval/worktree pipeline.
- Added AI-evaluated heartbeat stop clauses through completion policies, natural-language stop conditions, completion-evaluation results, and visible stop reasons in run history.
- Added a dedicated background queue for AI stop checks so slow or stuck completion evaluation does not block automation reconciliation.
- Added timeout handling for stop evaluation, recording a visible warning result and keeping the heartbeat alive when the evaluator stalls.
- Added automation recovery and scheduler observability for swallowed recovery failures and scheduler lease contention.
- Added DST and long-downtime scheduler coverage for spring-forward gaps, fall-back duplicate hours, and coalesced missed interval runs.
- Added generic chat file attachments alongside image attachments, with shared contracts, upload storage, composer paste/drop support, provider prompt projection, optimistic timeline rendering, Kanban dispatch, recap/bootstrap support, and reusable file attachment cards/chips.
- Added automation cards in the chat transcript after automation creation, and added thread automation summaries in the Environment panel.
- Added blob-based browser download handling for local image/generated markdown image downloads so failed local-image responses stay inside Synara instead of navigating the app window to an API error page.
- Added OpenCode CLI-only model discovery fallback so the model picker can still discover available models when the managed server or inventory path fails.
- Added profile skill usage counting coverage for retention-hidden threads and repeated slash/dollar skill invocations.

### Changed

- Bumped Synara release package versions to `0.3.0` across the server, desktop, web, and contracts packages.
- Reworked automation UI toward a Codex-style surface, including the sidebar badge, Current/Paused list, centered detail layout, inline rail editing, schedule editing, target-thread display, max-iteration controls, stop-on-error handling, and previous-run actions.
- Expanded automation composer parsing and review so explicit/generated prompts, schedule phrases, stop clauses, bounded fast loops, restored plan source metadata, queued plan follow-ups, and inline composer editing are handled consistently.
- Made generated automation intents require confirmation before creation, while preserving deterministic local auto-submit behavior for explicitly parsed bounded fast loops.
- Tightened automation cache updates by guarding live definition/run upserts with `updatedAt` and handling equal timestamps without letting stale events roll back newer cache rows.
- Consolidated scheduler-critical SQL around pending completion evaluation and run listing, including a shared view and a bounded evaluation backlog.
- Scoped OpenCode/Kilo server startup and CLI discovery to the request/session cwd, avoided cross-cwd warm server reuse, preserved OpenCode resume cwd, and stopped replacing file config with synthetic empty config content.
- Treated omitted Claude interaction mode as the default/base permission so fresh threads do not inherit sticky plan mode from the previously active thread.
- Preserved attachment-bearing plan follow-ups by routing them through the normal send path while keeping source plan metadata, including queued sends.
- Made composer image blob URL ownership clearer by revoking on normal clears while preserving ownership for optimistic handoff.
- Made composer dropzone generic-file support explicit and visibly rejected unsupported Kanban task files.
- Kept Environment panel open/close preference stable across chat switches while defaulting constrained/floating chat layouts to a calmer closed panel.
- Avoided full thread subscription for file previews and reused thread runtime workspace resolution so worktree-backed chat file/PDF links open in the correct right-dock preview root.
- Included retention-hidden threads in profile stats while still excluding manually deleted threads and deleted projects.

### Fixed

- Fixed automation lifecycle bugs around crash replay, failed-run rollback, duplicate scheduled occurrences, in-flight guards, terminal run transitions, cancellation behavior, and failed update rollback.
- Fixed automation worktree cleanup when standalone thread creation fails or cancellation wins before durable thread ownership exists.
- Fixed automation approval-wait reconciliation so a heartbeat run re-checks turn ownership before leaving `waiting-for-approval`, avoiding resurrection after a different turn takes over the target thread.
- Fixed a completion-evaluation race where a background stop check could clobber a user's archived/read state on the same automation run.
- Fixed stale completion-evaluation results being accepted after an automation changed before evaluation finished.
- Fixed automation review regressions around draft-thread promotion, restored source-thread metadata, source plan persistence, reruns, triage/detail actions, and provider start options.
- Fixed local image downloads so failed `/api/local-image` responses cannot replace the desktop renderer with a plain `Not Found` page.
- Fixed deleted chats staying visible by removing successful deletes from client projections immediately, adding client tombstones, and keeping archived bulk deletes responsive.
- Fixed worktree-backed file/PDF previews from chat links so absolute paths under a materialized worktree do not fall back to the default editor/main surface.
- Fixed OpenCode model discovery fallback so a failed server/inventory path no longer leaves the UI looking like only static GPT-5 is available.
- Fixed OpenCode provider config and sticky plan-mode behavior around cwd-scoped discovery, resume cwd, and fresh-thread bootstrap.
- Fixed attachment handling issues around attachment caps, server normalization rollback, unsupported files, plan follow-ups, image URL cleanup, and attachment drag/drop audit findings.
- Fixed profile skill counts so repeated `/skill` or `$skill` tokens in one prompt count correctly without double-counting structured skill references.
- Fixed release-blocking typecheck drift in automation worktree cleanup tests by asserting the created worktree branch before using it.
- Fixed formatting drift in the automation service test and local image preview download error description.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 151 warnings, 0 errors.
- `bun run typecheck` passed across all 8 packages with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed install/lockfile state.
- `bun run build` passed. The build still reports existing large web chunk/plugin timing warnings, the Astro `transformWithEsbuild` deprecation warning, and the desktop `tsdown.config.ts` typeless-module warning.
- `bun run test` passed: 10 tasks successful in 8m53s. `@synara/web` passed 180 files / 2102 tests. `synara` passed 135 files with 1 skipped file, 1418 passed tests, and 6 skipped tests. The server suite was long-running but completed cleanly without a teardown stall.
- Website changelog mirror checks passed in `/Users/emanueledipietro/Developer/synara-website`: `npm run build` prerendered `/changelog/v0.3.0`, and `npm run lint` passed.

## 0.2.41 - 2026-06-17

### Added

- Added a compact chat-header handoff menu so handoff threads can be created directly from the active chat header again.
- Added provider-target filtering for the handoff menu so only currently usable handoff destinations are offered.

### Changed

- Bumped Synara release package versions to `0.2.41` across the server, desktop, web, and contracts packages.
- Kept the shared project-action dialog path mounted while hiding the visible inline project script runner from the chat header.
- Improved header handoff failure handling by checking provider send availability before creating a handoff and showing a toast when the target is unavailable.

### Fixed

- Fixed the missing header handoff action after the previous chat-header cleanup.
- Fixed chat-header crowding from the project script runner while preserving the project action dialog plumbing used by other header actions.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and left the worktree unchanged.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Root `bun run test` did not complete cleanly in two attempts: both runs reached a green `@synara/web` suite (169 files / 1954 tests), then stalled in the `apps/server` Vitest tail. The stale duplicate root/Vitest processes were stopped before continuing verification.
- Direct `bun run test` from `apps/server` also stalled before reporting test-file progress, only printing Node SQLite experimental warnings, so it is not counted as passed.
- Direct package tests passed for the release-relevant and non-server packages: `apps/web` 169 files / 1954 tests, `packages/contracts` 9 files / 90 tests, `packages/shared` 24 files / 228 tests, `packages/effect-acp` 3 files / 24 tests, `apps/desktop` 19 files / 149 tests, and `scripts` 5 files / 36 tests.
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.41`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.4 - 2026-06-17

### Added

- Added focused route-restore recovery coverage so remembered chat routes wait for a fresh snapshot before falling back after restart.
- Added disabled-provider re-enable regression coverage for provider health refreshes.

### Changed

- Bumped Synara release package versions to `0.2.4` across the server, desktop, web, and contracts packages.
- Improved remembered chat route restore so stale empty startup snapshots do not immediately send users to the empty chat route.
- Removed the old handoff shortcut from the chat header to keep primary conversation controls quieter.

### Fixed

- Fixed app restart/chat restore behavior where a valid remembered thread could briefly appear missing while orchestration state was still loading.
- Fixed provider health refresh behavior around re-enabling disabled providers so availability state is less likely to remain stale.
- Fixed formatting drift in `apps/web/src/chatRouteRestore.ts` caught by `bun run fmt:check`.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/chatRouteRestore.ts`; after formatting that file, `bun run fmt:check` passed.
- `bun run lint` passed with 149 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 169 files / 1954 tests and `synara` 129 files passed / 1 skipped with 1255 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.4`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.3 - 2026-06-16

### Added

- Added richer local profile statistics, including most-worked project, skill/agent usage, active hours, provider/model mix, reasoning usage, and token/activity heatmap data.
- Added compact pasted-text cards for large composer pastes, with line/character metadata, remove controls, restore-to-editor behavior, and expandable sent-message echoes.
- Added shared pasted-text parsing/serialization helpers and focused coverage for composer drafts, pasted text, assistant selections, terminal context, and transcript height handling.

### Changed

- Bumped Synara release package versions to `0.2.3` across the server, desktop, web, and contracts packages.
- Improved profile skill usage counting by combining structured skill references, mentions, agent references, and legacy text-token backfill while filtering obvious non-skill slash/dollar tokens.
- Kept large pasted prompt content out of the visible composer body by storing it as structured prompt context, making long prompts easier to scan and refine.

### Fixed

- Fixed message editing so pasted text blocks remain intact when a user edits a previous message.
- Fixed draft/edit preservation for structured prompt context so pasted text, terminal context, and assistant selections are less likely to be dropped or flattened across composer lifecycle changes.
- Fixed profile stats so prompt-block markup like pasted text, file comments, terminal context, and assistant selections does not pollute skill counting.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- `bun run test` passed: 10 tasks successful, including `@synara/web` 168 files / 1949 tests and `synara` 129 files passed / 1 skipped with 1246 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.3`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.2 - 2026-06-14

### Added

- Added richer profile and personalization surfaces, including profile stats, activity heatmap polish, profile editing updates, and settings panel refinements.
- Added soft-delete thread retention coverage so deleted thread data has clearer cleanup behavior during early WIP usage.
- Added release-test stability safeguards for child-process ACP fixtures and the server Vitest runner.

### Changed

- Improved live composer edit visibility so per-turn composer changes stay attached to the active turn lifecycle.
- Refined curated app/profile UI details across the settings, profile dialog, activity heatmap, and chat route.
- Changed the server test script to run Vitest files serially, avoiding Turbo teardown stalls caused by lingering server Vitest workers after otherwise-passing test runs.

### Fixed

- Fixed flaky `effect-acp` child-process fixture tests by giving slow process-backed assertions an explicit timeout.
- Fixed full root `bun run test` release validation getting stuck after green server test output by making the server package test runner deterministic under Turbo.
- Fixed formatting drift in the profile, retention, and chat-route files that had reached `main`.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/threadRetention.test.ts`, `apps/web/src/components/profile/ActivityHeatmap.tsx`, `apps/web/src/components/profile/EditProfileDialog.tsx`, `apps/web/src/components/settings/ProfileSettingsPanel.tsx`, and `apps/web/src/routes/_chat.tsx`; after formatting those files, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- Initial full `bun run test` failed in `packages/effect-acp` on 5000ms child-process fixture timeouts, then repeated with timeouts in `packages/effect-acp/src/client.test.ts` and `packages/effect-acp/src/protocol.test.ts`. Targeted reruns passed after adding explicit fixture timeouts.
- A subsequent root `bun run test` reached green server test output but did not return because the server Vitest process kept worker forks alive during Turbo teardown. Direct server testing showed the suite exits cleanly with `--maxWorkers=1 --no-file-parallelism`, so the server test script was updated accordingly.
- Final `bun run test` passed: 10 tasks successful, including `@synara/web` 167 files / 1935 tests, `effect-acp` 3 files / 24 tests, and `synara` 129 files passed / 1 skipped with 1241 passed / 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.2`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.1 - 2026-06-14

### Added

- Added inline file comments from composer and preview surfaces, including line comment boxes, comment summary chips, draft persistence, reference attachment support, chat timeline rendering, and file-comment parsing helpers.
- Added startup turn reconciliation for provider restarts so Synara can recover unfinished turns from persisted runtime state instead of leaving stale active work behind.
- Added an ACP idle watchdog used by ACP-backed providers so quiet turns can complete or fail more predictably when runtime events stop flowing.
- Added partial workspace reference lookup helpers and tests so shortened file references can resolve to the intended workspace entry.

### Changed

- Scoped live changed-file activity to the active turn by carrying active turn identity through provider runtime ingestion, Codex/Claude adapter events, checkpoint handling, chat selectors, and composer live-change headers.
- Improved workspace file opening from chat and preview references so missing prefixes or partial paths are handled through shared workspace file-system logic.
- Refined provider restart recovery across Cursor, Grok, OpenCode, runtime ingestion, command cleanup, and shared thread summaries so session state is less likely to drift after reconnects.
- Extended comment and reference handling through kanban dispatch, terminal context, composer attachments, editor workspace, dock preview, and compact composer controls.

### Fixed

- Fixed stale live changed-files panels that could show file edits from a previous or inactive turn.
- Fixed partial file references failing to open when assistant output did not include the full workspace-relative path.
- Fixed restart and idle-watchdog paths that could leave turns hanging after provider interruption, reconnect, or quiet ACP runtime behavior.
- Fixed composer/file-preview context loss when attaching line comments to a prompt or preserving them across draft updates.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 146 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not complete cleanly: visible server integration and checkpoint suites passed, including `integration/orchestrationEngine.integration.test.ts` and `src/orchestration/Layers/CheckpointReactor.test.ts`, but the root Turbo/Vitest run stopped producing output during teardown with two server Vitest worker forks still alive. The stale `bun`/`turbo`/Vitest process group was interrupted, so this run is not counted as a full pass.
- Final `bun run test` from `apps/web` passed: 165 files passed, 1909 tests passed.
- Final `bun run test` from `packages/effect-acp` passed: 3 files passed, 24 tests passed.
- Final direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 128 files passed, 1 skipped; 1238 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.1`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.2.0 - 2026-06-13

### Added

- Added a secure in-app PDF previewer backed by pdf.js, including page rendering, toolbar controls, zoom helpers, page navigation state, container sizing, document loading, page render cancellation, and PDF link normalization.
- Added `PdfFilePreview`, `WorkspaceFilePreview`, and a shared preview header so the right dock and editor workspace can render source files, images, markdown, and PDFs through one consistent preview path.
- Added authenticated local preview route coverage for image/PDF files, including workspace and scratch-workspace allowlists for generated local artifacts.
- Added Pi plugin/ACP startup prompt handling, model discovery support, cwd/session routing, provider service safeguards, and a mock ACP agent for focused provider tests.
- Added Cmd+L composer focus support across keybinding metadata, server/web keybinding definitions, shortcut-sheet data, and tests.
- Added markdown task-list parsing/rendering so checklist-style assistant output displays as task lists instead of plain bracket text.
- Added workspace file opener helpers, local preview URL helpers, file reference context-menu helpers, PDF zoom/link/navigation tests, chat view selector coverage, session logic tests, and extra right-dock runtime activation coverage.

### Changed

- Reworked file preview ownership by moving large preview behavior out of `EditorWorkspaceView` and into reusable preview components shared with the dock pane.
- Replaced the older nested changed-files tree/turn-diff-tree path with a flatter changed-files UI and simpler file-list behavior.
- Optimized chat startup and timeline derivation by tightening chat view selectors, route state handling, timeline ordering, collapsed settled-turn behavior, and timeline height calculations.
- Refined right-dock pane metadata and activation so file preview, PDF preview, and dock pane lifecycle state stay more predictable across chat/editor surfaces.
- Improved composer/user-input polish around inline mention chips, composer banners, pending user input panels, provider model picker state, and shortcut labels.
- Refined local preview file handling by renaming the shared helper from local image-only logic to broader local preview-file logic.
- Updated open-in target launcher prop naming and editor launcher hooks to match the newer workspace/dock preview surfaces.

### Fixed

- Fixed unsafe PDF preview behavior by sanitizing annotation links, rejecting unsafe URL schemes, resetting navigation when a new document loads, and avoiding stale page proxies after switching PDFs.
- Fixed local preview exposure risks by tightening preview response CORS/auth behavior and ensuring local file access stays scoped to allowed workspace/scratch paths.
- Fixed scratch workspace path generation so thread-derived scratch folders cannot smuggle path separators or traversal segments.
- Fixed Pi plugin UI routing, startup prompt delivery, model discovery for extensions, and cwd handling for provider-backed sessions.
- Fixed Cursor message id handling and stale changed-files presentation cases.
- Fixed duplicate plan mode icons, stale plan sidebar state, and noisy inline project actions in the chat header.
- Fixed settled-turn collapse fallback and timeline tail behavior when visible turn ids are empty or transcript rows update during long-running work.
- Fixed local image/PDF preview cleanup cases so loaded PDF documents and text layers are destroyed or cancelled when switching files, pages, or zoom levels.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 144 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed and refreshed release install/lockfile state.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; marketing still reports the `transformWithEsbuild` deprecation warning; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First full `bun run test` before release-note edits did not pass: `apps/server/integration/orchestrationEngine.integration.test.ts` failed `runs a single turn end-to-end and persists checkpoint state in sqlite + git`, and `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` failed `captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed`. The run then hung during teardown and was stopped after identifying and killing the stale `bun`/`turbo`/Vitest worker processes.
- Targeted rerun `bun run test src/orchestration/Layers/CheckpointReactor.test.ts -t "captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed"` from `apps/server` passed: 1 test passed, 15 skipped.
- Targeted rerun `bun run test integration/orchestrationEngine.integration.test.ts -t "runs a single turn end-to-end and persists checkpoint state in sqlite + git"` from `apps/server` could not reproduce the live integration test because the file uses `it.live`; the standard targeted Vitest command skipped all 12 tests.
- Final full `bun run test` after version and release-note edits did not pass: `packages/effect-acp/src/client.test.ts` timed out in `returns formatted invalid params when a typed extension request payload is wrong`, and `packages/effect-acp/src/protocol.test.ts` timed out in `does not emit a second process-exit error after a decode failure`. Turbo reported 7 successful tasks, canceled `synara:test` and `@synara/web:test` with code 130, and exited with `effect-acp#test` failed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong"` from `packages/effect-acp` passed: 1 test passed, 4 skipped.
- Targeted rerun `bun run test src/protocol.test.ts -t "does not emit a second process-exit error after a decode failure"` from `packages/effect-acp` passed: 1 test passed, 16 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 164 files passed, 1894 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 126 files passed, 1 skipped; 1214 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.2.0`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.9 - 2026-06-12

### Added

- Added Codex-style chat workspace folder creation and associated workspace/worktree metadata so generated chat files are easier to isolate per conversation.
- Added settings sidebar search deep links and related project/settings navigation polish.
- Added a World Cup soccer ball physics playground as a self-contained interactive visual surface.
- Added file-only workspace search refinements and stronger provider probe handling around Gemini-backed paths.

### Changed

- Reworked transcript turn collapse and live-tail behavior so collapsed work rows, latest-turn fallback, and active transcript scrolling stay calmer during long or partially visible turns.
- Improved browser session handling and copy-link flow behavior for in-app browsing and chat reference movement.
- Refined UI density controls, sidebar spacing, composer spacing, and settings page opening performance.
- Replaced bespoke editor project menu behavior with the shared `ProjectMenuPicker` path.
- Split kanban composer menu discovery from editor logic so each surface owns less unrelated state.
- Shared local image preview state and error-card handling across chat and editor views.

### Fixed

- Fixed server typecheck and formatting drift that reached `main` after the soccer playground merge.
- Fixed transcript turn collapse and tail jitter cases where visible turn ids could be empty while a latest turn still had active work.
- Fixed browser/copy-link edge cases that could leave stale browser session state or awkward link movement.
- Fixed editor mode production feedback and local image preview duplication between chat and editor surfaces.
- Fixed settings page re-render churn caused by streaming ticks while opening settings.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 143 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt visibly completed the long web/server/integration suites without an assertion failure, then hung during final server Vitest teardown with two workers still alive; it was interrupted and is not counted as a full pass.
- Final full `bun run test` after release-note and version edits failed in `packages/effect-acp/src/client.test.ts` on two 5000ms timeouts: `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`. Turbo canceled `synara:test` with code 130 after the `effect-acp` failure, so the full run is not counted as passed.
- Targeted rerun `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed: 2 tests passed, 3 skipped.
- Full `packages/effect-acp` rerun passed: 3 files passed, 24 tests passed.
- Full `apps/web` rerun passed: 160 files passed, 1838 tests passed.
- Direct server rerun `bun run test -- --maxWorkers=1` from `apps/server` passed: 125 files passed, 1 skipped; 1197 tests passed, 6 skipped.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.9`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.8 - 2026-06-11

### Added

- Added an editor workspace view beside chat, including file browsing, workspace view state, syntax highlighting, file reference selection, code selection actions, and focused tests around editor metadata, workspace file-system APIs, workspace entries, chat references, and route state.
- Added native editor app discovery and icon caching, with authenticated editor icon routes, shared editor icon path constants, icon rendering in the web app, and broader launcher coverage for Ghostty, Terminal, JetBrains, Xcode, Zed, Cursor, VS Code, and platform-specific fallbacks.
- Added a unified provider skills catalog with provider-root awareness, shared skill ownership display, provider skill prompt injection, skills settings UI/model state, and coverage for Codex/Cursor/native-discovery fallbacks.
- Added provider status/auth refresh plumbing on focus and root orchestration events so Codex auth overlays and provider discovery state recover without stale UI.
- Added composer footer layout helpers, file reference parsing helpers, relative time utilities, syntax highlighting helpers, diff route search, and extra web tests for composer layout, file icons, provider updates, and root invalidation.

### Changed

- Refined the chat header, chat view, composer controls, model/trait/open-in pickers, inline chips, transcript selection actions, and code-selection flows so references and controls stay easier to scan during active work.
- Reworked the diff panel toolbar, file list, and patch viewport behavior to make large diffs easier to navigate from both repository and turn contexts.
- Reworked provider skill discovery so provider-native skill lists can merge with Synara's catalog and fall back cleanly when a provider cannot answer.
- Reconciled legacy migration trackers before running migrations and tightened older sidechat/pinned-thread migration paths.
- Updated desktop stage dependency overrides to keep `@pierre/diffs` pinned to `1.2.8`.
- Tightened terminal environment propagation, terminal manager behavior, workspace path containment, and provider command/runtime plumbing around recent server contracts.

### Fixed

- Fixed stale Codex auth overlay behavior so installed/authenticated Codex states refresh more reliably.
- Fixed skill settings provider display so only providers that actually own a skill are shown for shared skill entries.
- Fixed Ghostty/open-in behavior and native icon sizing so editor launchers open the intended project path and render consistently with other picker icons.
- Fixed file reference selection and mention/chip rendering edge cases across composer text, sent user bubbles, and markdown/code selection surfaces.
- Fixed migration startup edge cases for early installs that still had legacy tracker state.
- Fixed several provider discovery and skill catalog edge cases around missing native provider binaries, invalid provider responses, and provider-root normalization.

### Verification

- `bun run fmt:check` passed.
- `bun run lint` passed with 159 warnings, 0 errors.
- `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings; desktop build still reports the existing typeless `tsdown.config.ts` module warning.
- First `bun run test` attempt was interrupted by SIGTERM after partial success; no assertion failure was reported before termination, and `@synara/web:test` had already passed 152 files / 1740 tests.
- Final rerun `bun run test` after version and release-note edits passed: 10 tasks successful; scripts 5 files / 36 tests, desktop 19 files / 149 tests, contracts 9 files / 90 tests, shared 22 files / 188 tests, effect-acp 3 files / 24 tests, web 152 files / 1740 tests, server 123 files passed / 1 skipped with 1187 passed / 6 skipped.
- The rerun still logged expected test-harness WARN/ERROR lines from failure-path coverage and native binding/provider-binary mocks.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.8`.
- `npm run lint` in `/Users/emanueledipietro/Developer/synara-website` passed.

## 0.1.7 - 2026-06-10

### Added

- Added Claude Fable 5 to the Claude and Cursor model surfaces, including the shared model contract, Cursor model variants, keybinding metadata, provider discovery invalidation, and focused model-picker coverage.
- Added Cursor ACP model discovery and refresh handling so Cursor-backed sessions can recover from stale, partial, or invalid model state more reliably.
- Added provider usage infrastructure for Codex, Claude, Cursor, and Gemini, including credential discovery, provider-specific parsers, shared display helpers, SQLite-backed snapshot caching, server RPC routes, and client snapshot normalization.
- Added provider usage UI in chat and settings: Environment panel usage rows, compact usage menu controls, progress tracks, line lists, limit rows, rate-limit opening helpers, and provider usage settings navigation.
- Added desktop backend Node option handling and tests, memory diagnostics, WebSocket stream backpressure guards, and provider runtime ingestion buffer coverage.
- Added centralized Windows desktop caption controls, top-bar gutter support, preload IPC wiring, and focused browser/unit coverage for sidebar, keybinding, composer, usage, and provider discovery paths.

### Changed

- Reworked the composer model/options picker flow so split pickers are used where they help, empty threads stay focused, and stacked composer panels share steadier sizing/content helpers.
- Refined Cursor provider integration around ACP capability checks, model support parsing, discovery refreshes, provider health, and adapter behavior.
- Unified provider usage display and pacing logic across server snapshots, shared helpers, React hooks, settings panels, and in-chat usage sections.
- Tightened Codex app-server recovery, backend memory limits, and streaming behavior so reconnects, partial streams, and live provider updates stay more predictable.
- Refined Windows desktop chrome to keep native-style controls in one fixed cluster and avoid custom titlebar paths outside Windows.
- Updated Linux download metadata to use the current `-x64` AppImage asset naming.

### Fixed

- Fixed plugin mention icons in sent user bubbles so selected plugin/file identity is preserved after sending.
- Fixed provider discovery invalidation so refreshed model lists can update the UI without stale model state lingering.
- Fixed usage parsing/display edge cases for provider-specific quota and pacing data.
- Fixed composer stacked panel sizing, queued/live-change header alignment, and trait-picker behavior around compact controls.
- Fixed sidebar/search palette state and route metadata edge cases covered by new tests.
- Fixed WebSocket backpressure and buffered provider-runtime ingestion cases that could otherwise leave live updates stale under load.

### Verification

- `bun run fmt:check` initially failed on `apps/web/src/routes/__root.tsx`; after formatting that file with `bunx oxfmt apps/web/src/routes/__root.tsx`, `bun run fmt:check` passed.
- `bun run lint` passed with 148 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/web/src/components/chat/TraitsPicker.browser.tsx`, `apps/web/src/store.ts`, `apps/server/src/provider/Layers/CursorAdapter.ts`, and `apps/server/src/wsRpc.ts`; after targeted fixes, `bun run typecheck` passed with the existing TS44 informational JSON messages.
- `bun run release:smoke` passed.
- `bun run build` passed. Vite still warns about large web chunks and plugin timings.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `returns formatted invalid params when a typed extension request payload is wrong` and `replays buffered notifications to handlers registered after they arrive`, both with 5000ms timeouts; Turbo then canceled `synara:test` and `@synara/web:test` with code 130.
- `bun run test src/client.test.ts -t "returns formatted invalid params when a typed extension request payload is wrong|replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (2 tests passed, 3 skipped).
- `bun run test` from `packages/effect-acp` passed (3 files passed; 24 tests passed).
- `bun run test` from `apps/server` passed (118 files passed, 1 skipped; 1136 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (147 files passed; 1690 tests passed).
- Final `bun run fmt:check` passed.
- Final `bun run lint` passed with 148 warnings, 0 errors.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.7`.

## 0.1.6 - 2026-06-09

### Added

- Added transcript text markers with orchestration events, projection persistence, migration `042_ProjectionThreadsMarkers`, shared marker validation, transcript selection actions, marker-aware scrolling, and an Environment panel marker section.
- Added website favicon support for markdown links, composer/user-bubble link chips, and bare-domain link parsing, backed by a server-side favicon cache and authenticated favicon image route.
- Added local server monitoring, project-run tracking, local-server Environment panel rows, sidebar/project-run controls, and WebSocket/RPC contracts for listing and stopping tracked dev servers.
- Added terminal/project visual identity helpers and project-run target/running helpers so local server and terminal surfaces can share clearer labels and icons.
- Added focused tests for marker round-trips, marker scrolling, local server monitoring, project run targets, terminal visual identity, favicon parsing/cache behavior, and link chip parsing.

### Changed

- Refined transcript rendering and timeline behavior so marker navigation, markdown highlights, collapsed work disclosures, and auto-scroll follow logic are less likely to fight each other.
- Unified link rendering across AI responses, composer chips, and sent user bubbles so site identity, favicon fallback, alignment, and medium-weight text stay consistent.
- Reworked local-server discovery around listener address-family metadata, project ownership matching, and tracked PTY/dev-server state.
- Refined recent view switching, browser panel identity, terminal chrome sizing, and local server display state around project-aware surfaces.
- Tightened orchestration projection and provider/runtime handling around markers, thread updates, local server state, and terminal/runtime cleanup.

### Fixed

- Fixed retired model picker keybindings so shortcuts keep working when hidden/retired model entries are present.
- Fixed collapsed work disclosures retriggering tail-scroll behavior after output had already settled.
- Fixed formatter drift in `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`.
- Fixed the local-server test fixture to include the required listener address `family` field.
- Fixed bare domains such as `linear.app/...` being ignored by composer/user-bubble link chip parsing while full `https://...` links worked.

### Verification

- `bun run fmt:check` initially failed on `apps/server/src/wsRpc.ts` and `apps/web/src/lib/serverReactQuery.ts`; both files were formatted and the rerun passed.
- `bun run lint` passed with 145 warnings, 0 errors.
- `bun run typecheck` initially failed in `apps/server/src/devServerManager.test.ts` because a `ServerLocalServerProcess` fixture lacked `family`; after the fixture fix, `bun run typecheck` passed.
- `bun run release:smoke` passed.
- `bun run build` passed.
- `bun run test` failed in `packages/effect-acp/src/client.test.ts` on `replays buffered notifications to handlers registered after they arrive` with a 5000ms timeout; Turbo canceled the server test package afterward with code 130.
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` passed (1 test passed, 4 skipped).
- `bun run --cwd apps/server test -- --reporter verbose --maxWorkers=1` passed (112 files passed, 1 skipped; 1108 tests passed, 6 skipped).
- `bun run test` from `apps/web` passed (140 files passed; 1657 tests passed).
- `bun run test` from `packages/contracts` passed (9 files passed; 90 tests passed).
- `bun run test` from `packages/shared` passed (21 files passed; 183 tests passed).
- `bun run test` from `apps/desktop` passed (18 files passed; 141 tests passed).
- `bun run test` from `scripts` passed (5 files passed; 36 tests passed).
- `apps/marketing` has no `test` script.
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website` passed and generated `/changelog/v0.1.6`.

## 0.1.5 - 2026-06-08

### Added

- Added macOS update artifact smoke tooling, zip finalization helpers, and boolean environment parsing tests for the desktop release path.
- Added focused diff panel components for the toolbar, file jump menu, file list, patch viewport, and selector helpers.
- Added browser/unit coverage for queued turn auto-dispatch, plan-mode queued chat turns, composer stacked panel framing, diff view-source logic, provider discovery, markdown rendering, and mention/file icon behavior.

### Changed

- Refreshed README/release messaging and Synara desktop update flow documentation around the current app positioning.
- Reworked the diff panel around explicit repo-vs-turn state, searchable file filtering, and smaller view components.
- Unified composer stacked panels above the input so plan activity, queued follow-ups, and live file-change rows share width, border, radius, and dark-mode opacity.
- Refined chat markdown spacing, composer command menu selection, provider/plugin discovery normalization, and file/plugin icon rendering in sent messages.

### Fixed

- Fixed queued chat dispatch so queued turns preserve their own interaction mode, attachments, and prompt while a plan follow-up is pending.
- Fixed live file-change composer chrome so it appears only for active turns with actual provider file edits.
- Fixed draft/reference handling so selected plugin and file mentions keep their structured references and icons after navigation or reload.
- Removed the older update-feed cache path in favor of the newer resumable update download coverage.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 145 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (failed once: `packages/effect-acp/src/client.test.ts` timed out in `replays buffered notifications to handlers registered after they arrive`)
- `bun run test src/client.test.ts -t "replays buffered notifications to handlers registered after they arrive"` from `packages/effect-acp` (targeted rerun passed: 1 test passed, 4 skipped)
- `bun run test src/whatsNew/logic.test.ts` from `apps/web`
- `bun run test src/components/ChatMarkdown.test.tsx` from `apps/web`
- `bun run test` from `apps/web` (132 test files passed; 1588 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.4 - 2026-06-07

### Added

- Added project, thread, and message pinning across the orchestration projection, persistence layer, shared pin helpers, sidebar state, environment panel, and focused web stores.
- Added environment-panel pinned-message management and autosaved thread notes so durable context can live beside the transcript without being mixed into the chat stream.
- Added a recent-view switcher with keyboard navigation, keycap hints, route activation logic, persistent recent-view tracking, and browser/unit coverage.
- Added resumable desktop update download infrastructure with dedicated tests for partial files, persisted metadata, retry behavior, and interrupted download recovery.
- Added pull-availability data to the Git contract/server/web path so Git action controls can reflect whether pull is actually safe and useful for the current branch.
- Added broader tests for keybindings, composer mentions, composer drafts, pinned projects/threads/messages, thread detail prewarming, recent views, migrations, and release browser flows.

### Changed

- Reworked the sidebar/project/thread pinning model around shared logic so pinned state is projected consistently after reloads, legacy migration reconciliation, and snapshot refreshes.
- Expanded the chat environment surface with dedicated pinned and notes sections, tighter environment row styling, and shared action hooks for pin/unpin flows.
- Tightened composer behavior around mention icons, draft references, queued headers, picker styling, compact controls, and empty-chat controls.
- Improved runtime resilience around external Claude shutdowns, terminal manager cleanup, websocket RPC error flow, and provider session recovery.
- Refined projection snapshot queries and pipeline behavior so pinned messages, notes, and project pins are present in thread detail and orchestration snapshots.
- Updated release/browser tests and mocks around the recent switcher, keybindings, and app release surfaces.

### Fixed

- Fixed pinned-state migrations and legacy reconciliation so older projected thread data can upgrade cleanly.
- Fixed composer mention icon rendering and draft reference handling.
- Fixed release browser tests by adding switcher keycap coverage and the needed test mock.
- Fixed Git action availability checks that previously had to infer pull state too late in the UI.
- Fixed external Claude SIGTERM handling so an outside shutdown is treated as a benign suspended session instead of a failed turn.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with 138 warnings, 0 errors)
- `bun run typecheck` (passes with TS44 informational messages about JSON usage in tests/protocol files)
- `bun run release:smoke`
- `bun run build` (passes; Vite still warns about large web chunks and plugin timings)
- `bun run test` (109 test files passed, 1 skipped; 1068 tests passed, 6 skipped; 6m13s)
- `bun install` after version bump to update `bun.lock`
- `bun run test src/whatsNew/logic.test.ts` from `apps/web` after release-note edits (12 tests passed)
- `npm run build` in `/Users/emanueledipietro/Developer/synara-website`

## 0.1.3 - 2026-06-05

### Added

- Added in-app thread recap support with provider-backed generation, cached recap state, current-state context, and tests around recap assembly.
- Added richer agent activity detail surfaces so subagent/task rows can be opened and inspected from the transcript flow.
- Added release notes for `0.1.3` to the built-in What's New / Release History data.

### Changed

- Reworked transcript, chat header, environment panel, Git action, branch toolbar, and queued composer rendering so busy sessions remain easier to scan.
- Computed repo diff totals once in `ChatView` and reused them across the header and environment panel, avoiding duplicate large-patch parsing during live updates.
- Streamlined archived-thread deletion through shared client helpers, including optimistic local removal, batched worktree-linked cleanup, and a single shell snapshot reconciliation.
- Made desktop update UI quieter during background polling and kept production web/server/desktop sourcemaps disabled by default unless explicitly enabled for diagnostics.
- Tightened terminal runtime cleanup, shell summary handling, provider activity ingestion, and session handoff safeguards.
- Refined composer attachment, reference chip, queued row, and compact control spacing for a cleaner release build.

### Fixed

- Fixed TypeScript exact-optional-property failures in optional callback pass-throughs.
- Fixed recap generation test doubles to use the shared `ThreadRecapGenerationInput` contract.
- Updated image attachment chip tests to match the current compact thumbnail UI.
- Preserved the final archived-thread and diff-total behavior with focused tests.

### Verification

- `bun run fmt:check`
- `bun run lint` (passes with existing warnings)
- `bun run typecheck`
- `bun run release:smoke`
- `bun run build`
- `bun run test`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "reverts to an earlier checkpoint and trims checkpoint projections"`
- `bun run test integration/orchestrationEngine.integration.test.ts -t "forwards thread.turn.interrupt to claudeAgent provider sessions"`
- `bun run test -- src/lib/archivedThreadDelete.test.ts src/components/chat/ComposerImageAttachmentChip.test.tsx src/whatsNew/logic.test.ts`
- `bun run test -- src/git/Layers/GitManager.test.ts -t "thread recap|commit message|status"`
