# Home composer and working-state polish

## Summary

- The empty home keeps the hero and composer centered as one stack.
- On the first send, the composer card now slides from the center into the bottom dock (FLIP with WAAPI, 480ms, `cubic-bezier(0.22, 1, 0.36, 1)`), based on Monocode's `useComposerDockMotion`. It replaces the old 300ms opacity fade. Reduced motion skips it.
- The optimistic send now happens before workspace prep, so the slide starts right after Enter (about 90 to 230ms, down from 420 to 500ms). Prep failures roll back like a rejected dispatch. The composer is only restored if the user has not started a new draft. Queued turns never touch the live composer.
- The working indicator no longer flickers. Before: `Loading` → `Starting Codex…` → blank → `Working for 0s` + `Thinking`, with a layout jump, and another blank at the draft→server promotion. Now the header and `Thinking` show up together at dispatch and stay mounted, and the counter never resets. `Starting <provider>…` only shows after 1.2s of continuous connecting.
  - Root cause: `hasLiveTurnTakenOver` treated `connecting` as takeover. That released the local dispatch bridge in the normal connecting → ready → running gap.
  - A bare reconnect with no pending turn no longer shows the indicator or the Stop button.
- Stop:
  - The button, Ctrl+C, and the new Esc shortcut all show `Stopping…` right away and disable Stop until the turn settles.
  - Stop stays visible for the whole working span (the server honors interrupts during startup), except during pre-session worktree setup.
  - Stopped turns read `Stopped after Xs` in the collapsed header, or `Stopped` in the reply's meta row.
- The empty home placeholder uses the new-chat copy. It stays `Ask for follow-up changes` for the whole working span.
- Consecutive provider retry warnings (`Reconnecting... n/5`) collapse into one row that updates in place. They are identified by a new optional `RuntimeWarningPayload.willRetry` field (Codex, Pi, OpenCode retry events), not by matching message text.

## Verification

- `bun run --cwd apps/web typecheck`, server typecheck: pass.
- `bun run lint`: 0 errors (existing warnings only).
- `bunx oxfmt --check` on changed files: pass.
- `bun run --cwd apps/web test`: 5245 passed, 3 skipped.
- `bun run --cwd apps/web test:browser -- src/components/ChatView.browser.tsx`: 161/161.
- Server: `providerRuntimeActivityProjection.test.ts` 28, `CodexAdapter.test.ts` 48.
- `chatHotPath` compiler test: 39/39 (ChatView and the submission hook stay compiler-eligible).
- Live, on the normal dev instance (web :5733, server :3773), using Playwright with a DOM mutation timeline:
  - First send from the empty home.
  - Draft→server promotion.
  - Stop by button and by Esc.
  - A retry storm on a degraded Codex gateway.
- Two independent code reviews. All findings were fixed.

## Known gaps

- The provider environment was degraded during live testing. The Codex gateway rejected upgrades, and OpenCode was slow to start. The settled `Stopped` states are covered by browser tests and one live plain-reply capture.
- The last part of the send-to-slide latency is the React commit that mounts the transcript. Removing it would mean keeping the composer mounted across the transition. I did not attempt that.
