# Synara browser import — Round 12 report review

## Fresh test reports read

- Linux Devin Lite session `693d1e6e5a9b4e53939db7c20e95eaa6`, latest `REPORT.md` v4. Its appended Round 5 section records the tested head as `eb068d6ea7078621f8080c909e67aeb92eb94903`; the top-level report heading still names stale metadata `ed3fbe58f`.
- Windows Devin Lite session `14831145dc76420da16ed29535e3f341`, report `report-eb068d6ea.md`, tested head `eb068d6ea7078621f8080c909e67aeb92eb94903`.
- All saved browser-import round reports in this directory through Round 11, including the implementation and critic verdicts. Current worktree edits are not present in either Devin report.

## Failures and gaps found in the reports

| Platform | Case                                  | Reported result                                                                                                                                                                                                                                       |
| -------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | Existing-user announcement            | FAIL on two clean launches; acknowledgment key absent, no competing visible sheet, and IPC probes returned two sources and three Chrome profiles. Cause not recorded.                                                                                 |
| Linux    | 12,001-cookie Chrome profile          | FAIL/unreliable; verification failed in about one second. A 3,000-row retry retagged entirely to `localhost` also landed none, but that fixture is subject to Chromium's per-domain target quota and does not establish a general 3,000-cookie limit. |
| Linux    | Small Chrome/Edge imports and restart | PASS for the tested persistent partition cookies; guest remained signed in after app restart. This does not prove OS-protected storage or session-only restoration.                                                                                   |
| Linux    | Passwords                             | Unsupported; vault login count stayed zero. The old empty state incorrectly implied browsers were absent.                                                                                                                                             |
| Linux    | Browser coverage                      | Only Chrome and Edge passed the runtime source gate; native-reader entries for Brave, Chromium, Opera, and Vivaldi were filtered out.                                                                                                                 |
| Linux    | Other matrix rows                     | Locked-vault discovery and cancel UI failed/weren't available; Snap and custom paths were unsupported; Flatpak, KWallet, and onboarding were not run/verified.                                                                                        |
| Windows  | Chrome/Edge cookies                   | FAIL for tested profiles: 0 imported, 0 skipped, 1 could not transfer. Disk evidence identified v20 App-Bound encrypted rows. The report proves failure for those profiles, not all Windows profiles.                                                 |
| Windows  | Browser and password coverage         | Vivaldi was installed but filtered out; its test cookie was v10. Password import was unsupported and the report did not verify a successful signed-in browser import.                                                                                 |

## What the current code does and does not establish

- Round 10 already preserves typed `source_too_large`, target-capacity, eviction, and target-failure results. A critic initially missed the installed BetterWright `normalizeCookieSnapshot` 10,000-selected-cookie pre-dispatch cap, then corrected that claim: the cap maps to `source_too_large` before target dispatch. The report does not include the selected/deduplicated count or raw failure envelope, so the 12,001-row live failure's internal cause remains unknown; it must not be attributed to that cap without evidence.
- Round 10's onboarding gate change prevents a known completed-installation marker from waiting on unrelated project hydration. The Linux report did not capture gate state, so this is a plausible suppression path addressed in code, not a confirmed root cause or a live pass.
- Round 11 preserves cookie counts when only the optional secure session-restoration checkpoint is unavailable and adds reachable cancellation through the UI and IPC. No Devin report tests those uncommitted changes.
- Round 12 expands the contract gate for Brave, Chromium, Opera, and Vivaldi because the native Linux reader lists them. Unit evidence does not prove their profile discovery, decryption, or transfer on a real Linux host.
- Windows App-Bound v20 remains unresolved; no claim that a decrypt warning was shown is supported by the report's raw result envelope. BetterWright documents an opt-in injection recovery path, but its security review requires a separate, explicit UI opt-in and endpoint-security disclosure. The current import checkbox does not authorize that mechanism, so it remains disabled pending the user's decision.

## Immediate code action

The password-import section now explicitly says Linux and Windows do not support saved-password import yet, instead of implying the browsers or profiles are missing. A critic found that the locked/unset-vault controls still implied setup or unlock would enable import. The follow-up now skips inventory/vault inspection and hides those controls off macOS. Password import itself remains unimplemented on those platforms.

## Verification in this worktree

- Linux/Windows live reports: prior PR head only, not current uncommitted code.
- Focused browser UI run for `BrowserVault.browser.tsx`: blocked before tests by `listen EPERM 127.0.0.1:51100`; zero tests executed.
- Native web TypeScript check: passed with existing Effect suggestions; contracts check passed with existing Effect suggestions.
- Desktop native TypeScript check: blocked because this worktree cannot resolve `undici` from `apps/desktop/src/httpRuntime.ts`.
- Browser UI run: blocked before test execution by `listen EPERM 127.0.0.1:51100`; zero tests ran.
- Root `fmt:check`: passed after formatting changed tests and Round 12 reports; final `git diff --check` is recorded in the implementation report.

## Biggest remaining gap

No successful Windows signed-in import was verified, and the tested Chrome/Edge v20 App-Bound cookie rows all failed. Linux also has a reproducible large-profile failure and a two-launch announcement failure whose internal causes were not captured. Password import, broad platform/browser support, macOS Cedar comparison, and required matrix rows remain open.
