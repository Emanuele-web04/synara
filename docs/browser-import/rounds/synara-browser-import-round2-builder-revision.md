# Synara browser-import round 2 builder revision

## Result

Addressed the critic's actionable findings in `/Users/user/.codex/worktrees/browser-cookie-import/synara`, branch `codex/browser-cookie-import`. The inventory uses the OS home instead of BetterWright's engine state directory, preserves modern and legacy Opera profiles, reports path access failures at browser/profile/store scope, and packages/verifies the third-party notice. The runtime `BrowserCookieSource` gate is unchanged. No UI, commit, or push was added.

## Changes

| File                                                                                                    | Change                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop/src/browserAutomation/browserCookieImport.ts`                                             | `inventoryChromiumProfiles()` resolves `homedir()` independently of constructor `home`, which remains the BetterWright engine-state directory.                                                                                                                                                                          |
| `apps/desktop/src/browserAutomation/browserCookieImport.test.ts`                                        | Method-level regression test asserts the inventory receives the OS home and not `/synthetic-home`.                                                                                                                                                                                                                      |
| `apps/desktop/src/browserAutomation/chromiumProfileInventory.ts`                                        | Opera enumerates nested profiles first and uses the root only as legacy fallback; Opera GX stays root-based. App lookup errors become per-browser `unavailable`; enumeration errors preserve discovered profiles; individual profile/store errors become per-profile unavailable counts rather than rejecting the scan. |
| `apps/desktop/src/browserAutomation/chromiumProfileInventory.test.ts`                                   | Adds modern Opera `Default` vs stale root fixture, legacy Opera root, GX root, Network-directory EACCES, inaccessible sibling-profile, and app-lookup EACCES cases. Uses temporary app roots only.                                                                                                                      |
| `packages/contracts/src/browserVault.ts`                                                                | Keeps explicit browser/profile discovery status in the shared inventory shape.                                                                                                                                                                                                                                          |
| `apps/desktop/src/browserVaultIpc.ts`, `apps/desktop/src/ipcChannels.ts`, `apps/desktop/src/preload.ts` | Continues to expose inventory through trusted IPC; import gate unchanged.                                                                                                                                                                                                                                               |
| `THIRD_PARTY_NOTICES.md`                                                                                | Narrows provenance to the adapted macOS profile discovery and pre-decryption row-counting logic from Cedar's `Sources/Search/Import.swift`; explicitly excludes a claim about porting Search's decryption/import-record implementation.                                                                                 |
| `scripts/lib/desktop-platform-build-config.ts`                                                          | Adds the notice as an explicit Electron `extraResources` entry for macOS, Linux, and Windows.                                                                                                                                                                                                                           |
| `scripts/build-desktop-artifact.ts`                                                                     | Copies the notice into the staging app and fails packaging verification if the final packaged app resources do not contain the exact notice bytes.                                                                                                                                                                      |
| `scripts/lib/desktop-artifact-notices.ts`, `scripts/desktop-artifact-notices.test.ts`                   | Implements and fixture-tests packaged-resource verification, including missing/altered notice rejection.                                                                                                                                                                                                                |
| `scripts/build-desktop-artifact-mac-config.test.ts`                                                     | Asserts explicit notice resource staging on all three platforms.                                                                                                                                                                                                                                                        |

The inventory covers Chrome stable/Beta/Dev/Canary, Edge, Brave, Arc, Dia, Vivaldi, Opera, Opera GX, Chromium, Helium, Comet, and Aside. It remains macOS-only and reports stored cookie/password row counts before decryption. No keychain prompt or decryption path was added.

## Coverage

- Chrome stable, Beta, Dev, and Canary: exact fixture discovery IDs and cookie counts.
- Opera current layout: nested `Default` wins over a stale root store; display/default metadata and nested counts checked.
- Opera legacy root fallback and Opera GX root profile checked.
- EACCES isolation: inaccessible Network directory leaves the password result and a healthy sibling browser intact; inaccessible profile sibling leaves the readable Default profile in the result; inaccessible application lookup yields an unavailable browser entry without erasing a discoverable sibling browser.
- Artifact notice: explicit config coverage for Mac/Linux/Windows and fixture checks that packaged resources contain the byte-identical notice or fail verification.
- All inventory tests use synthetic temp directories and SQLite fixtures. No live browser import, keychain, or signed/package build claim is made.

## Checks

| Command                                                                                                                                                                   | Result                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/desktop test -- src/browserAutomation/chromiumProfileInventory.test.ts src/browserAutomation/browserCookieImport.test.ts src/browserVaultIpc.test.ts` | Passed: 3 files, 35 tests.                                                                                                                                                                                    |
| `bun run --cwd scripts test -- build-desktop-artifact-mac-config.test.ts desktop-artifact-notices.test.ts`                                                                | Passed: 2 files, 11 tests.                                                                                                                                                                                    |
| `bun run --filter @synara/scripts typecheck`                                                                                                                              | Passed, exit 0. Existing Effect suggestion diagnostics only.                                                                                                                                                  |
| `bun run --filter @synara/desktop typecheck`                                                                                                                              | Blocked by the worktree dependency install: `apps/desktop/src/httpRuntime.ts(6,44): Cannot find module 'undici' or its corresponding type declarations.` No inventory/import changes were reported as errors. |
| `bunx oxfmt --check` on all changed TS/TSX files                                                                                                                          | Passed.                                                                                                                                                                                                       |
| `git diff --check`                                                                                                                                                        | Passed.                                                                                                                                                                                                       |

Vitest and typecheck required elevated execution because the sandbox blocks their localhost listener. The focused tests passed after approval.

## Remaining limits

- The packaged-artifact verifier is implemented and tested against synthetic app-resource trees; a full desktop package was not built in this pass.
- Browser app discovery still relies on conventional `.app` names in `/Applications` and `~/Applications`; no live machine-wide browser qualification is claimed.
- `git status` includes the expected new `THIRD_PARTY_NOTICES.md` and new inventory/verifier files. No commit or push was made.

## Worktree

- `/Users/user/.codex/worktrees/browser-cookie-import/synara`
- `codex/browser-cookie-import`
