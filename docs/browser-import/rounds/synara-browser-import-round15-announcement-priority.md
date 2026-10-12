# Synara browser import — Round 15 announcement priority

## Finding and change

Linux Round 5/6 reports show that the existing-user browser prompt did not appear, although its source/profile probes succeeded. The Round 5 DOM snapshot also mentions an inline sidebar coachmark. `OneTimeCoachmark` and announcement sheets use the same startup slot, and the slot gave both equal priority. This is a plausible starvation path, not a confirmed cause: the report did not record `startupGateSettled`, installation identity, or slot ownership.

Startup sheets now claim the shared slot at priority 1 and passive coachmarks at priority 0. A sheet can preempt a coachmark already holding the slot. Coachmarks persist their seen marker only after the full eight-second display, so a preempted hint can appear after the sheet is dismissed.

## Verification

| Check                                       | Result                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Browser announcement UI, installed Chrome   | 11/11 passed, including sheet priority, coachmark deferral, and post-dismissal display |
| Announcement slot unit tests                | 3/3 passed                                                                             |
| Web native TypeScript check                 | Passed; existing Effect suggestion diagnostics only                                    |
| `oxfmt --check`                             | Passed for the repository (4,645 files)                                                |
| `oxlint --report-unused-disable-directives` | 0 errors; 886 existing warnings                                                        |
| `git diff --check`                          | Passed                                                                                 |

The standard Bun launcher stopped at the local SFW cache `EPERM`; the targeted Vitest, formatter, lint, and TypeScript binaries were run directly. The first browser regression attempt omitted the `startupSettled` fixture and failed its post-dismissal coachmark assertion; the fixture was corrected and the full browser file then passed. The temporary installed-Chrome override in `vitest.browser.config.ts` was reverted.

## Remaining evidence gap

The Linux real-app announcement has not been rerun at this source state. The slot-priority fix addresses the report-observed coachmark interaction but does not prove that it was the Linux suppressor. Windows/Linux password import, Windows Chrome/Edge v20 App-Bound recovery, macOS Synara import and populated Cedar comparison, and the remaining cross-platform browser matrix are still open.
