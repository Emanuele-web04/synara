# Empty home composer polish

## Summary

- Centered the empty-chat hero and composer in one responsive landing stack.
- Reduced the Synara logo and heading scale and tightened the spacing to match the Monocode reference.
- Added staged landing motion using only opacity and transform, with a reduced-motion override.
- Added a home-specific browser geometry regression, thread-scoped send handoff coverage, and rejected-send recovery coverage.

## Reference findings

The supplied recordings were decoded frame by frame before implementation.

- Synara reference: `Screen Recording 2026-09-24 at 14.06.58.mov` - 1,038 decoded frames (1,039 in container metadata), about 20.27 seconds.
- Monocode reference: `VcmDJi_9rOeYPF0Y.mp4` - 1,504 frames, about 25.07 seconds.
- Monocode keeps the empty title and composer close together near the vertical center.
- Monocode's first-send composer handoff takes about 300ms.
- The previous Synara layout kept the title high and the composer near the bottom.

## Verification

### Passed

- `bun install --frozen-lockfile`
- `bun run typecheck` - all 7 packages passed; existing suggestions remain.
- `bun run --cwd apps/web typecheck` - passed after the final handoff isolation change; existing suggestions remain.
- `bun run lint` - 0 errors and 728 existing warnings.
- `bunx oxfmt --check apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.browser.tsx apps/web/src/components/chat/chatSendTypes.ts apps/web/src/components/chat/useChatTurnSubmission.ts apps/web/src/index.css PR.md`
- `bun run --cwd apps/web test -- --testTimeout=15000` - 399 files passed, 5,225 tests passed, 3 skipped.
- `bun run --cwd apps/web test:browser -- src/components/ChatView.browser.tsx -t 'keeps the first sent message|does not carry the first-send handoff|does not reuse a first-send handoff|centers the home landing stack|preserves a new-chat draft'` - 6 passed, 137 skipped. The run emitted one non-failing TanStack Router stderr warning in the rejected-send case.
- `bun run build` - all 5 build tasks passed before the final handoff isolation change; existing chunk-size and build-plugin warnings remain.
- `git diff --check`

The browser suite emitted an existing `ResizeObserver loop completed with undelivered notifications` warning. It did not fail the run.

### Manual flow checks

The earlier fixture app was exercised with DOM-only checks, without screenshots, visual comparison, or CUA-driver.

- Empty home: passed.
- Short input: passed; send became enabled.
- Long multiline input: passed on desktop and at `390x700`; the editor capped at 200px and scrolled internally without clipping the shell.
- Send: passed; the optimistic user message and transcript appeared.
- Return home: passed.
- Reduced motion: passed; landing animations computed as `none`.

### Dev app

- Started `SYNARA_NO_BROWSER=1 bun run dev` against the normal `/Users/user/.synara` setup.
- Web UI served at `http://localhost:5733`; server served at `http://127.0.0.1:3773`.
- Opened the web UI in the default macOS browser.
- The dev process was left running for inspection.

Live provider streaming was not completed in the earlier isolated fixture run. That provider retried through reconnect steps `2/5` to `5/5`, then reported a provider runtime error and turn failure. Fixture-based streaming scenarios in the browser suite passed.

## Known verification gaps

The full `ChatView.browser.tsx` browser suite passed all 140 tests before the final handoff changes. A post-change full-suite rerun was not completed because browser startup stalled. The final changes have focused browser coverage instead.

Visual comparison was intentionally not run. The request prohibited screenshots and visual comparison; the recording decode and DOM geometry checks are the available evidence.

React Doctor full and changed-lines scans exceeded the 120-second command timeout, so no React Doctor score was produced.

The root `bun run fmt:check` still reports existing formatting problems in `.mind/*`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `docs/computer-use-cua/handoffs/codex-parity-handoff-2026-09-23.md`. Those user-owned files were not reformatted or included in the change.

## Scope and commits

Only these task files are included:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.browser.tsx`
- `apps/web/src/components/chat/chatSendTypes.ts`
- `apps/web/src/components/chat/useChatTurnSubmission.ts`
- `apps/web/src/index.css`
- `PR.md`

No dependencies or lockfiles changed. Changes remain local; nothing was pushed or opened as a remote PR. The implementation commits are:

- `dc64a9571` `feat(web): center empty chat landing`
- `87c73c6d8` `fix(web): scope landing handoff to first send`
- `cd48b0876` `fix(web): isolate landing handoff state`

Documentation updates are separate local commits.
