# Synara browser import — Round 9 live reports

**Tested head:** `eb068d6ea7078621f8080c909e67aeb92eb94903` (PR #1830). The Devin sessions fetched the PR branch and verified the head. Both used Lite, disposable browser profiles and a local test site; neither made code changes or pushed commits.

**Evidence sources:**

- Linux Devin Lite session `693d1e6e5a9b4e53939db7c20e95eaa6`, latest attachment `REPORT.md` v4 (`evidence-round5.tgz`, `eb-panel-import.png`).
- Windows Devin Lite session `14831145dc76420da16ed29535e3f341`, latest attachment `report-eb068d6ea.md` (three screenshots and cookie database evidence).

## Linux — observed results

| Case                                           | Result                                                                                                                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General Settings import panel                  | PASS. Chrome (three profiles) and Edge (one profile) shown; counts honestly unavailable on Linux.                                                                                                                                 |
| Small Chrome/Edge imports                      | PASS transfer with persistence warning. One cookie imported per selected profile; guest reached signed-in test page.                                                                                                              |
| Restart                                        | PASS for the tested persistent partition cookie. Guest remained signed in after app restart; vault was locked after restart and `osProtected:false`. This does not prove OS-protected storage or session-only cookie restoration. |
| Existing-user announcement                     | FAIL. Missing on two clean launches despite absent acknowledgment key, no competing sheet, and healthy IPC probes (two sources, three Chrome profiles). Cause was not established.                                                |
| 12,001-cookie Chrome profile                   | FAIL/UNRELIABLE. First attempt imported one cookie but returned persistence failure; second attempt failed verification in about one second and landed none of the 3,000 retagged test rows.                                      |
| Linux password UI                              | Unsupported by the import implementation; vault login count remained zero. The observed text incorrectly said no supported browser was installed even though Chrome and Edge were present.                                        |
| Locked vault                                   | Import panel hidden, with no explanation that unlocking restores it.                                                                                                                                                              |
| Cancel mid-import                              | Not available through the UI; API interrupt was unreachable from this dialog.                                                                                                                                                     |
| No-browser state                               | Reader-level check only; UI state not exercised.                                                                                                                                                                                  |
| Flatpak / Snap / custom profile path / KWallet | Not run or unsupported as detailed in the Devin report; not passes.                                                                                                                                                               |
| Stable/Beta home separation                    | PASS in the tested design/live check; browser profiles were shared while vault homes differed.                                                                                                                                    |
| Linux browser support                          | Runtime gate exposes only Chrome and Edge although the catalog lists more Linux browsers. Vivaldi, Brave, Chromium, Opera and other listed entries are not importable through this gate.                                          |

## Windows — observed results

| Case                           | Result                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing-user announcement     | PASS on first launch; confirmation navigated to General Settings.                                                                                         |
| Settings panel                 | PASS. Arc, Chrome and Edge rows were shown, with Chrome/Edge selected; cookie counts unavailable.                                                         |
| Chrome and Edge cookie imports | FAIL. Each returned `0 imported, 0 skipped, 1 could not be transferred`. Disk evidence showed the selected Chrome/Edge rows were v20 App-Bound encrypted. |
| Vivaldi                        | Installed but excluded by the source gate; its test cookie was v10.                                                                                       |
| Password import                | Unsupported on Windows and represented by a misleading “No supported installed Chromium browsers” empty state.                                            |
| Biggest remaining gap          | No v20/App-Bound decryption path. The report did not verify any successful signed-in Windows browser import.                                              |

## Verdict

The onboarding/settings UI is not enough to pass the objective. Linux announcement, large-profile transfer, Linux platform copy, locked-vault discoverability and cancelability remain failures or gaps. Windows selected-browser imports fail for the tested v20 cookies. Several required matrix rows are explicitly unrun. The reports do not establish the announcement's root cause or prove the entire Windows browser population uses v20.

The current follow-up patch addresses the Linux announcement's retry/gating paths, Linux password empty-state wording, typed transfer failures, persistence messaging and Windows decrypt-warning copy. These are source changes only; the Devin reports above tested the prior exact head and do not validate the patch.
