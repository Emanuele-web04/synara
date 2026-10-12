# Synara browser-import round 2 builder report

## Result

Implemented a separate macOS Chromium-family browser/profile inventory API for the round 2 candidate set. It reports cookie-row and non-empty saved-password-row counts from SQLite before decryption and never calls Keychain. The existing `BrowserCookieSource`, cookie source/profile APIs, and actual import checks remain unchanged. No UI was changed, and no commit or push was made.

The inventory includes Chrome stable/Beta/Dev/Canary, Edge, Brave, Arc, Dia, Vivaldi, Opera, Opera GX, Chromium, Helium, Comet, and Aside. It returns no candidates on non-macOS. Presence requires an application bundle in `/Applications` or `~/Applications`. An installed app with absent profile data is returned with `profileStatus: "no_profiles"`; a malformed or inaccessible profile root / enumeration failure reports `profileStatus: "unavailable"` instead of disappearing from the result.

## Files changed

- `apps/desktop/src/browserAutomation/chromiumProfileInventory.ts` — installed app/profile discovery, Chromium `Local State` display/default metadata, cookie/password row counts, read-only SQLite handling, and explicit `available` / `no_profiles` / `unavailable` discovery states plus locked/unavailable store statuses.
- `apps/desktop/src/browserAutomation/chromiumProfileInventory.test.ts` — fixture-only coverage of exact candidate order, per-source counts, profile labels/defaults, missing profiles versus invalid roots, malformed stores, locked stores, non-macOS behavior, and result-schema validation.
- `packages/contracts/src/browserVault.ts` — inventory candidate/result schemas and typed `BrowserVaultMethods` method. Candidate IDs are separate from `BrowserCookieSource`.
- `apps/desktop/src/browserAutomation/browserCookieImport.ts` — exposes the inventory method without changing import gates.
- `apps/desktop/src/browserVaultIpc.ts`, `apps/desktop/src/ipcChannels.ts`, `apps/desktop/src/preload.ts` — wires the typed inventory method to the desktop renderer bridge; no UI uses it yet.

## Test coverage notes

- Chrome stable, Beta, Dev, and Canary each have fixture app bundles, profile stores, exact discovery IDs, and non-decryption cookie counts asserted.
- Opera and Opera GX each exercise their single profile stored directly at the browser data root; tests assert the root profile ID and default marker.
- The suite uses a fixture-only application root and temporary home. It does not inspect real `/Applications`, browser profiles, or Keychain.
- Six focused tests pass. No live browser, keychain, signed-app permission, or end-to-end claim is made.

## Checks

| Command                                                                                                                                                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/desktop test -- src/browserAutomation/chromiumProfileInventory.test.ts`                                                                                                                                                                                                                                                              | Passed: 1 file, 6 tests. Fixtures only.                                                                                                                                                                                       |
| `bun run --filter @synara/desktop typecheck`                                                                                                                                                                                                                                                                                                             | Blocked by the worktree dependency install: `apps/desktop/src/httpRuntime.ts(6,44): Cannot find module 'undici' or its corresponding type declarations.` No diagnostics from the inventory or contract changes were reported. |
| `bunx oxfmt --check apps/desktop/src/browserAutomation/chromiumProfileInventory.ts apps/desktop/src/browserAutomation/chromiumProfileInventory.test.ts apps/desktop/src/browserAutomation/browserCookieImport.ts apps/desktop/src/browserVaultIpc.ts apps/desktop/src/preload.ts apps/desktop/src/ipcChannels.ts packages/contracts/src/browserVault.ts` | Passed.                                                                                                                                                                                                                       |
| `git diff --check`                                                                                                                                                                                                                                                                                                                                       | Passed.                                                                                                                                                                                                                       |

Vitest and typecheck needed elevated execution because this environment blocked their localhost listener. The focused inventory test passes after that escalation.

## Assumptions and remaining gaps

- App bundle names and Application Support roots mirror the existing Cedar `Sources/Search/Import.swift` discovery map; discovery/count behavior was not tested against real installed browsers.
- Profiles are recognized when they have `Cookies`, `Network/Cookies`, or `Login Data`; Guest/System profiles are excluded. Opera and Opera GX use their browser data root as the single profile.
- Cookie count is `COUNT(*)` from the available Cookies database. Password count is rows where `blacklisted_by_user = 0` and `length(password_value) > 0`, matching Cedar's pre-decryption preview filter. Missing/malformed stores report `null`/`unavailable`; SQLite busy/locked errors report `null`/`locked`.
- Store reads are read-only. No keychain API, decryption, profile import support, unsupported OS support, or live provider behavior was added.
- `git status` also showed an untracked `THIRD_PARTY_NOTICES.md` that was absent from the initial clean worktree status. It was not inspected or modified and is excluded from this change.
- The project memory runtime `.mind/runtime.py` is absent from this PR worktree. I did not write into the separate `/Users/user/synara` checkout because the task explicitly restricted work to this PR worktree.

## Worktree state

- Worktree: `/Users/user/.codex/worktrees/browser-cookie-import/synara`
- Branch: `codex/browser-cookie-import`
- No commit or push.
