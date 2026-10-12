# Synara browser import — Round 10 report-backed fixes

**Base/tested by Devin:** `eb068d6ea7078621f8080c909e67aeb92eb94903`. The Linux and Windows Lite reports in Devin tested this base; they did not validate the changes below.

## Findings addressed in the worktree

- Added browser and platform fields to successful cookie-import results and updated exact desktop expectations.
- Kept password-import empty state from falsely claiming no Chromium browser is installed when that platform cannot import passwords.
- Distinguished secure session-only restoration failure from the persistent Chromium partition cookie. The Linux Lite report confirmed its disposable persistent cookie remained signed in after restart, while vault `osProtected` stayed false.
- Preserved separate source-size and target-capacity/eviction error codes through the BetterWright patch, desktop contract and UI status text.
- Added Windows Chrome/Edge decrypt-warning copy for the case where the runtime returns `decrypt_failed`; the Windows report did not expose the raw result envelope, so this condition remains unverified against that test.
- Allowed a scoped onboarding-completion marker to settle the gate without unrelated thread hydration; profile-probe rejection is retained and retried, with a Settings-review fallback. The Linux report confirmed the announcement absence, but did not identify its cause.
- Prevented retry scheduling after announcement-hook cleanup and added a regression that rejects `cookieSources` after unmount and checks after the retry delay.

## Critic verdict

**ACCEPT for the corrected paths.** Fresh critic review found no remaining confirmed defect in the paths reviewed. It verified source/target capacity mappings, checked the BetterWright patch against pristine cached 2.7.3 (`git apply --unidiff-zero`; seven patched files byte-match the installed package), and directly probed both oversized-source messages as `source_too_large`.

## Verification results

| Check                                 | Result                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Desktop importer + IPC focused tests  | 32/32 passed (critic run)                                                                                    |
| Onboarding logic focused tests        | 22/22 passed (critic run)                                                                                    |
| Browser announcement UI suite         | 10/10 passed in installed Chrome with isolated context (critic run)                                          |
| `git diff --check`                    | Passed (critic run)                                                                                          |
| Local desktop focused test invocation | Blocked before tests by SFW cache `EPERM` opening `/opt/homebrew/lib/node_modules/sfw/.sfw-cache/next-check` |
| Local `bun run fmt:check`             | Blocked before formatter by the same SFW cache `EPERM`                                                       |
| Root lint and typecheck               | Not run; local Bun commands stop at the same SFW initialization error                                        |

## Verdict and remaining gaps

The unit/component checks cover the source edits, not the live desktop report failures. Re-run the announcement and 12,001-cookie cases in the real Linux app before claiming they are fixed. Verify the Windows result envelope before claiming the App-Bound copy was exercised. The broader browser/platform matrix, macOS real app, Cedar visual comparison, locked-vault discoverability, and UI cancellation remain open.
