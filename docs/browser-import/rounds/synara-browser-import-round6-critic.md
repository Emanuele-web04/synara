# Synara browser import — Round 6 critic verdict

## Verdict

**ACCEPT** for the owner-bound destinationless runtime, strict request decoding, and cleanup fixes. This does not establish readiness for the full browser-import objective.

## Findings

- Target creation now precedes asynchronous profile discovery. `createProfileCookieImportRuntime()` refuses creation without a live owner and rejects a target destroyed while loading. `setWindow()` destroys tracked import targets whenever the owner identity changes, closing the menu/Dock race identified in the first review.
- The outer `finally` disposes the target, releases the human-browser-operation lease, and resets `busy` even when cleanup throws. Target-creation failures also remove and destroy their partially created window.
- Strict excess-property parsing on every union member rejects partial targeted payloads instead of dropping destination fields and accepting the request as destinationless. The production IPC handler uses this decoder.

## Verification and limits

- Focused Vitest: 2 files, 80 tests passed. `git diff --check` passed.
- The critic inspected the changed contract, importer, manager, and tests; `main.ts` owner-close, menu dispatch, Dock activation, and focus call sites; and `browserVaultIpc.ts` decoding.
- No live Electron app or screenshot was inspected. Mocked window tests do not prove actual menu/Dock routing during closure.
- Biggest remaining gap: a real Electron lifecycle run while a profile import is pending.
