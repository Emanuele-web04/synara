# Synara browser import — Round 18 Linux key-store retry

## Report-backed change

The Linux Lite report found that imports on a machine without an OS key store reported `persistence_failed`. The browser-session restorer could cache an unwrapped in-memory key while the key store was unavailable, then could not recover when the key store became available later.

- `VaultKeyProtection.provide()` now creates or upgrades the OS-protected envelope when its already-loaded key is first requested after OS storage becomes available.
- Failed session checkpoints retain only imported-domain metadata in memory, discard the unusable key-protection instance, and retry on a later explicit import. Cookie values are not checkpointed before the key has a verified OS-protected envelope.
- Updated the import guide to distinguish successful cookie transfer from optional secure session restoration.

## Verification

| Check                                                                                | Result                                                                                             |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Browser session restore, vault key protection, cookie import and browser vault tests | 66/66 passed                                                                                       |
| `bun run fmt:check`                                                                  | Passed across 4,647 files                                                                          |
| `bun run lint`                                                                       | Passed; 886 warnings, 0 errors; server sync filesystem check passed                                |
| `bun run typecheck`                                                                  | Passed in all 7 packages; Turbo emitted a bun.lock parsing warning and existing Effect suggestions |
| `git diff --check`                                                                   | Passed on the final diff                                                                           |

An initial focused run found that a call after shutdown still queried OS storage. The disposed-state guard was restored; the final affected suite passed.

## Still unverified

- The real Linux Lite app has not yet rerun the no-keyring → keyring-available → subsequent import sequence on this code.
- Linux and Windows password import remain unsupported; Windows Chrome/Edge v20 App-Bound cookies remain unreadable.
- The broader browser/OS matrix, macOS Synara import and populated Cedar visual comparison remain outstanding. PR #1830 stays draft; #1856 and #1212 stay open.
