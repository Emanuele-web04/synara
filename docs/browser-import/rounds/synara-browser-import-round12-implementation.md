# Synara browser import — Round 12 implementation

## Report-backed changes

- Added Linux-native reader IDs `brave`, `chromium`, `opera`, and `vivaldi` to the shared `BrowserCookieSource` contract. The desktop import source list continues to originate from BetterWright's installed native reader, and unsupported IDs such as Firefox remain filtered.
- Added a regression asserting that those native IDs pass through while an unregistered Firefox source is still rejected.
- Changed the saved-password section on Linux and Windows to state that import is unsupported and skip browser inventory/vault inspection. This removes the report-observed setup/unlock prompts that incorrectly implied Saved Logins setup enabled password import. macOS retains profile discovery, vault setup/unlock, consent, and import.
- The critic identified the remaining setup/unlock copy conflict after the first Round 12 patch; this follow-up fixes it and adds a browser regression for both Linux and Windows.
- Read the full current Linux Lite report and the paired Windows report review before continuing. The exact findings and limits are recorded in `synara-browser-import-round12-report-review.md`.

## Verification

| Check                             | Result                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| Desktop cookie importer test file | 33/33 passed before the password-copy change                                                     |
| Contracts browser catalog test    | 2/2 passed                                                                                       |
| Web native TypeScript check       | Passed after the unsupported-platform gate; existing Effect suggestions only                     |
| Contracts native TypeScript check | Passed with existing Effect suggestions                                                          |
| Desktop native TypeScript check   | Blocked: worktree dependency tree cannot resolve `undici` from `apps/desktop/src/httpRuntime.ts` |
| BrowserVault browser test         | Blocked before tests by sandbox `listen EPERM 127.0.0.1:51100`; zero tests executed              |
| `git diff --check`                | Passed after the Round 12 source, test, and documentation edits                                  |
| Full root `fmt:check`             | Passed after formatting changed tests and Round 12 reports via `/private/tmp`                    |
| Live Linux/Windows retest         | Not run; Devin reports test the base PR head `eb068d6`, not this worktree                        |

## Scope limits

The Linux source gate now matches the four additional IDs advertised by the installed native reader, but no live import for those browsers is established. The 12,001-cookie report failure's cause is unknown: the installed BetterWright cap maps oversized selected sets to `source_too_large` before dispatch, but the report lacks the selected deduplicated count and raw envelope. Linux announcement failure, Windows App-Bound v20 import, saved passwords on Linux/Windows, and required matrix rows remain open. BetterWright offers Windows App-Bound recovery through unprivileged process injection, but it remains disabled because it needs a separate unchecked opt-in and endpoint-security disclosure; the existing general import consent is insufficient.
