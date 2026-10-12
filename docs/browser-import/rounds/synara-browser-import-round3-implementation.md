# Synara browser import — Round 3 implementation

## Slice

Preserve verified cookie-transfer counts when the later secure session-restoration checkpoint fails. The import result remains a failure, but distinguishes a transfer that landed from an unknown/failed transfer. The UI reports imported and skipped cookie counts and warns that sessions might require signing in again after restarting Synara.

## Changes

- Added `imported` and `skipped` counts to the `persistence_failed` result variant in `packages/contracts/src/browserVault.ts`.
- Return those counts from `BrowserCookieImport` only after the cookie sync succeeded and `flushStore()` completed, when session checkpointing then failed.
- Updated the UI message to keep the checkpoint failure visible alongside the measured transfer counts.
- Updated the desktop test to assert the exact counts and the web test harness/UI case to cover the disclosure.

## Verification

- `bun run --cwd apps/desktop test -- src/browserAutomation/browserCookieImport.test.ts`: 23 passed.
- `bun run --cwd apps/web typecheck`: passed; pre-existing Effect suggestions remain.
- `bun run --cwd apps/web test:browser -- src/components/BrowserVault.browser.tsx`: could not launch because the required Playwright Chromium headless executable is absent at `/Users/user/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- `bun run --cwd apps/desktop typecheck`: blocked by missing installed `undici` types imported at `apps/desktop/src/httpRuntime.ts:6`.
- `bunx oxfmt --check` on the five changed source/test files: passed.
- `git diff --check`: passed.

## Review result

The fresh-context critic accepted this slice. Its report is in `synara-browser-import-round3-critic.md`.

## Remaining gap

This reporting correction does not fix the no-keyring checkpoint failure, large-profile transfer failure, password import, or incomplete browser/platform coverage. The browser import is still not integrated into onboarding and Settings. No full end-to-end success is claimed.
