# Synara browser import — Round 5 implementation

## Slice

Connect the macOS Chromium password reader to trusted desktop key acquisition and the existing encrypted BrowserVault, then expose explicit profile selection from Settings.

## Changes

- Added the typed password-import IPC contract and main-process implementation. The renderer passes only an inventory profile ID and explicit confirmation; the main process resolves the profile, acquires the browser secret from macOS Keychain, decrypts a bounded profile snapshot, and writes through the trusted vault owner API.
- Added an owner-only batch vault import to the pinned BetterWright patch. It serializes with vault operations, skips duplicate identities case-insensitively, never overwrites existing entries, caps a batch at 50,000, and returns counts without returning password values.
- Added a Settings panel that discovers installed Chromium-family browsers and profiles, preselects them, requires explicit consent, imports profiles sequentially, and displays a result for each selected profile.
- Added focused unit coverage for importer boundaries, IPC validation, vault duplicate behavior, and the encrypted reader path.

## Verification

- Root `bun run fmt:check`, `bun run lint`, and `bun run typecheck`: passed (lint emitted existing warnings, no errors).
- Focused desktop tests: 4 files, 18 passed.
- Desktop and web typechecks: passed.
- BetterWright patch applicability against the clean cached 2.7.3 package: passed.
- `bun install --frozen-lockfile --dry-run`: passed.
- `git diff --check`: passed after the final formatting change.
- The affected web browser test could not start because the local Playwright Chromium executable is absent at `/Users/user/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`.
- Critic verdict: **ACCEPT** for this slice. Critic reviewed the files listed in `synara-browser-import-round5-critic.md`; its focused test attempt could not start because the sandbox denied binding `127.0.0.1` (`listen EPERM`). No screenshot or running-app comparison was available.

## Limits and next slice

This is not end-to-end completion. Password importing currently supports macOS Chromium-family profiles only; Firefox/Safari and Windows/Linux key acquisition and decryption remain. The Settings panel is not yet shared with onboarding, has no first-run tour step or existing-user one-time prompt, and does not import sessions. Real macOS Keychain/vault restart verification and the complete OS/browser matrix are still outstanding.
