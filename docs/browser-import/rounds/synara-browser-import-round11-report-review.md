# Synara browser import — Round 11 report review

## Reports inspected

- Linux Lite session `693d1e6e5a9b4e53939db7c20e95eaa6`, latest attachment `REPORT.md` v4, viewed in Safari on 2026-10-12. The session's completion message says it retested `eb068d6ea7078621f8080c909e67aeb92eb94903`. The report's top-level environment table still says `ed3fbe58f`; its appended Round 5 section explicitly records a fetch/reset to and test at `eb068d6ea7078621f8080c909e67aeb92eb94903`. Treat the Round 5 section as the tested head and the header as stale metadata.
- Windows Lite session `14831145dc76420da16ed29535e3f341`, attachment `report-eb068d6ea.md`, tested head `eb068d6ea7078621f8080c909e67aeb92eb94903`.
- Local Round 9 and Round 10 summaries, cross-checked against both session responses.

Both Devin sessions used Lite, throwaway profiles/site, built and ran the real desktop app, and made no code changes or pushes. These reports test the base commit, not the current uncommitted worktree changes.

## Linux report — Round 5 findings at `eb068d6`

| Case                        | Reported result                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings panel              | PASS; Chrome has three profiles and Edge one; Linux cookie counts unavailable.                                                                                                                                                                                     |
| Small imports               | PASS transfer for Chrome/Edge; persistent partition cookies worked and survived a full Electron restart.                                                                                                                                                           |
| Session restoration warning | Every import showed `persistence_failed` even after cookies landed; report attributes it to an OS keyring absent when the vault envelope was created. Later adding gnome-keyring did not re-wrap the existing envelope.                                            |
| Large whole-profile import  | FAIL/unreliable; the 12,001-cookie profile failed verification in about one second. A second run with 3,000 test rows retagged to `localhost` landed none of those rows. The report itself notes this retagging is not evidence about general per-domain capacity. |
| Existing-user announcement  | FAIL on two clean launches despite profiles and healthy IPC probes; the cause was not established.                                                                                                                                                                 |
| Cancel                      | NOT VERIFIABLE from UI; no cancel control existed.                                                                                                                                                                                                                 |
| Password import             | Not implemented by this feature; vault login count stayed zero. The UI's “No supported installed Chromium browsers were found” wording was false on Linux where Chrome and Edge were installed.                                                                    |
| Locked vault                | Import UI disappeared without explaining that unlocking restores it.                                                                                                                                                                                               |
| Browser coverage            | Effective Linux import gate was Chrome and Edge. Several catalog entries were informational only, not importable.                                                                                                                                                  |
| Matrix                      | Flatpak and KWallet not run; Snap and custom/relocated profile paths unsupported; no-browser UI only partially checked; onboarding step not verified; Stable/Beta homes separated in the tested design/live check.                                                 |

The report does not establish that adding a keyring after vault creation makes the existing vault protected. It distinguishes persistent partition-cookie survival from secure restoration of session-only cookies. Its biggest stated gap was that `persistence_failed` masked the real transfer counts; the current worktree change addresses that reporting defect but has not had a live retest.

## Windows report — `eb068d6`

| Case                           | Reported result                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Existing-user announcement     | PASS once; confirmation navigated to General Settings.                                                      |
| Settings panel                 | PASS; Arc/Chrome/Edge shown, Chrome and Edge selected.                                                      |
| Chrome and Edge cookie imports | FAIL; each returned 0 imported, 0 skipped, 1 transfer failure. Disk inspection found v20 App-Bound cookies. |
| Vivaldi                        | Installed but excluded from the picker; its test row was v10.                                               |
| Password import                | Unsupported on Windows; old empty-state wording incorrectly implied no browsers were installed.             |
| Biggest gap                    | No v20/App-Bound decryption path and no successful signed-in Windows import was verified.                   |

## Round 11 action based on these reports

- Preserve verified cookie transfer counts as success when only the optional session-restoration checkpoint fails; surface restoration availability separately.
- Add an in-progress cancel control and make the pre-import wait settle on cancellation. The critic caught that the first cancellation test resumed the waiter too soon and therefore did not prove prompt cancellation; Round 11 fixes the wait and test assertion.
- Keep unresolved live gaps explicit. No report above tests the uncommitted fixes; Windows App-Bound cookies, large-profile transfer, Linux announcement, broad browser/platform support, actual password import on non-macOS, locked-vault discovery, and unrun matrix rows remain open.
