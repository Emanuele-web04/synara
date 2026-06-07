# Changelog

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
- `npm run build` in `/Users/emanueledipietro/Developer/dpcode-website`

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
