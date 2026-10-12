# Synara browser import — Round 6 implementation

## Slice

Give confirmed whole-profile cookie import a destination in the shared persistent browser session when launched from onboarding or Settings, while keeping tab-targeted import behavior intact.

## Changes

- Added a destinationless confirmed-profile request variant and strict excess-property decoding, so incomplete tab-targeted payloads cannot be silently reinterpreted as profile-wide imports.
- Added an owner-bound hidden runtime in `persist:synara-browser`. It is acquired before profile discovery, requires a live app window, and is destroyed whenever that owner changes or closes. A destroyed target is rejected after loading.
- Moved target cleanup to the outer `finally`; setup, discovery, reader, and persistence failures all dispose it, release human control, and reset the importer busy flag.
- Added regression coverage for ownerless creation, owner-close destruction, acquisition ordering, malformed targeted requests, and cleanup when setup fails before the reader starts.

## Verification

- Focused desktop Vitest files: 2 files, 80 tests passed.
- Desktop package typecheck: passed.
- Root `bun run fmt:check`, `bun run lint`, and `bun run typecheck`: passed; lint reports existing warnings only. Full typecheck emits existing Effect suggestions and a Turborepo warning about parsing `bun.lock`, but all seven package typechecks pass.
- `git diff --check`: passed.
- Critic verdict: **ACCEPT** for this lifecycle/schema slice; review details are in `synara-browser-import-round6-critic.md`.

## Limits and next slice

The owner-window behavior is covered with mocked BrowserWindows, not a live Electron app; menu and Dock routing during an actual close remain unverified. This runtime seam is not yet called by a shared onboarding/Settings import panel. Browser coverage, platform-specific password readers, Cedar screenshot comparison, real macOS E2E, the Linux/Windows Devin sessions, and the full matrix remain open.
