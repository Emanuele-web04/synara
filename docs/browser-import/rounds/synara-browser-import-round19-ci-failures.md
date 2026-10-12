# Synara browser import — Round 19 CI browser failures

## Evidence read

- PR run `38243557379` tested head `2661991178e91d057e7dcf387355923537d0fc7f`.
- Failed job: `Browser Tests (components 1/3)`, job `114792077830`.
- The complete failed-job log reports 6 failures among 400 tests; 394 passed.

## Findings and corrections

| Failure                                                                                                             | Cause from source and log                                                                                                                                                                                                                                             | Correction                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Four `BrowserPasswordImport` cases could not find the selected profile, unsupported state, or locked-vault controls | The component correctly gates saved-password import to macOS. These cases exercised the macOS path without setting `navigator.platform`, so Linux CI rendered the unsupported-platform state instead. The explicit Linux/Windows cases already override the platform. | The browser-test setup now uses `MacIntel` by default; explicit Linux/Windows cases continue to override it and restore the real platform. |
| Two Activity coachmark cases expected localStorage `seen` immediately when the hint appeared                        | `OneTimeCoachmark` records `seen` only after a full 8-second display or an explicit Activity click. The tests asserted the value too early.                                                                                                                           | Tests now expect no acknowledgment on initial display, then verify the explicit click or full-duration acknowledgment.                     |

## Verification state

- The current PR run `38244981789` is on `0ae853903`, before these test corrections. At last inspection, typecheck, core/web unit tests, Desktop Build, Migration Lineage, Windows Process Regression, and Static Checks passed; three browser jobs and server shard 3 were still in progress.
- The affected browser test command was attempted locally but Vitest could not bind its loopback listener: `listen EPERM: operation not permitted 127.0.0.1`. No local browser tests ran.
- The corrections are in the working tree and require a fresh CI run for behavioral verification.

## Remaining scope

This report fixes CI test setup and stale coachmark assertions only. It does not establish cross-platform password support, Windows App-Bound cookie recovery, the Linux keyring retry's live result, macOS Synara import, the Cedar visual comparison, or the full requested browser/OS matrix.
