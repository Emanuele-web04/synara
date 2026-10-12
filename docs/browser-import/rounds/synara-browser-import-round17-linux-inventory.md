# Synara browser import — Round 17 Linux inventory

## Change

- Added Linux Chromium-family profile roots for Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, and Chromium, including common Flatpak and Snap locations.
- Counted cookie and saved-password rows from SQLite without reading or decrypting secret values.
- Hid runtime catalog sources when profile inspection succeeds but finds no profile; retained entries when profile inspection errors so the UI can report the failure.
- Updated the browser-import guide with Linux inventory behavior and explicit platform limits.

## Verification

| Check | Result |
| --- | --- |
| Chromium profile inventory tests | 19/19 passed, including Flatpak and Snap fixtures |
| BrowserVault browser tests | 27/27 passed on the prior code state; current patch does not change that component |
| `bun run fmt:check` | Passed across 4,646 files |
| `bun run lint` | Passed; 886 warnings, 0 errors; server sync filesystem check passed |
| `bun run typecheck` | Passed in all 7 packages; Turbo emitted a bun.lock parsing warning and existing Effect suggestions |
| `git diff --check` | Passed |

## Report review and remaining gaps

- The latest Linux Lite report on the pushed head records the existing-user announcement as a real-app pass. Earlier Linux results still establish a target-capacity failure for a 12,001-cookie import, not a general small-import failure.
- The latest Windows Lite report verifies a signed-in Vivaldi import, but Chrome and Edge v20 App-Bound cookies remain unreadable. App-Bound recovery injection was not attempted and remains disabled.
- Saved-password import remains macOS-only. Linux counts password rows but does not decrypt or import them.
- These fixtures prove path and row-count logic, not live discovery/import for all browsers or packaged behavior. The required cross-platform matrix, macOS end-to-end Cedar screenshot comparison, and several-profile/no-browser cases remain incomplete.
- PR #1830 remains draft. PRs #1856 and #1212 remain open because the replacement is not ready.
