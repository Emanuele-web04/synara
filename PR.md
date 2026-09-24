# Empty home composer polish

## Summary

- Centered the empty-chat hero and composer in one responsive landing stack.
- Reduced the Synara logo and heading scale and tightened the spacing to match the Monocode reference.
- Added staged landing motion using only opacity and transform, with a reduced-motion override.
- Added a home-specific browser geometry regression and send-only handoff coverage.

## Reference findings

The supplied recordings were decoded frame by frame before implementation.

- Synara reference: `Screen Recording 2026-09-24 at 14.06.58.mov` — 1,038 decoded frames (1,039 in container metadata), about 20.27 seconds.
- Monocode reference: `VcmDJi_9rOeYPF0Y.mp4` — 1,504 frames, about 25.07 seconds.
- Monocode keeps the empty title and composer close together near the vertical center.
- Monocode's first-send composer handoff takes about 300ms.
- The previous Synara layout kept the title high and the composer near the bottom.

## Verification

### Passed

- `bun install --frozen-lockfile`
- `bun run typecheck` — all 7 packages passed; existing suggestions remain.
- `bun run lint` — 0 errors and 728 existing warnings.
- `bunx oxfmt --check apps/web/src/components/ChatView.tsx apps/web/src/components/ChatView.browser.tsx apps/web/src/index.css`
- `bun run --cwd apps/web test -- --testTimeout=15000` — 399 files passed, 5,225 tests passed, 3 skipped.
- `bun run --cwd apps/web test:browser -- src/components/ChatView.browser.tsx -t 'centers the home landing stack|keeps the first sent message|preserves a new-chat draft'` — 4 passed, 137 skipped.
- `bun run build` — all 5 build tasks passed; existing chunk-size and build-plugin warnings remain.
- `git diff --check`

The browser suite emitted an existing `ResizeObserver loop completed with undelivered notifications` warning. It did not fail the run.

### Manual flow checks

The isolated app was exercised with DOM-only checks, without screenshots, visual comparison, or CUA-driver.

- Empty home: passed.
- Short input: passed; send became enabled.
- Long multiline input: passed on desktop and at `390x700`; the editor capped at 200px and scrolled internally without clipping the shell.
- Send: passed; the optimistic user message and transcript appeared.
- Return home: passed.
- Reduced motion: passed; landing animations computed as `none`.

Live provider streaming was not completed. The isolated default provider retried through reconnect steps `2/5` to `5/5`, then reported a provider runtime error and turn failure. Fixture-based streaming scenarios in the browser suite passed.

## Known verification gaps

The full `ChatView.browser.tsx` browser suite passed all 140 tests before the final send-only handoff refinement. A post-refinement full-suite rerun stalled during browser startup, so the refinement has fresh targeted coverage but no fresh full-suite result.

The root `bun run fmt:check` still reports existing formatting problems in `.mind/*`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `docs/computer-use-cua/handoffs/codex-parity-handoff-2026-09-23.md`. Those user-owned files were not reformatted or included in the change.

## Scope and commits

Only these task files are included:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/ChatView.browser.tsx`
- `apps/web/src/components/chat/chatSendTypes.ts`
- `apps/web/src/components/chat/useChatTurnSubmission.ts`
- `apps/web/src/index.css`
- `PR.md`

No dependencies or lockfiles changed. Changes remain local; nothing was pushed or opened as a remote PR. The local commit split is:

- `dc64a9571` `feat(web): center empty chat landing`
- `a7ac69a3e` `docs: record home polish verification`
- `87c73c6d8` `fix(web): scope landing handoff to first send`
