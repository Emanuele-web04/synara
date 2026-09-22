# live-cert livecert-mu6qbjgb

- date: 2026-09-18T09:01:30.752Z
- elapsed: 5058ms
- verdict: **FAIL** — 0 pass / 1 fail / 0 skipped

| Row               | Verdict | Detail                                                                                        |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| locked-use-reauth | fail    | grant=true pausedRefused=true reauth=false declineHeld=true pendingSurvived=true resumed=true |

## Speed budget (driver-call wall clock, ms)

| Tool             | n   | p50   | p95    | max    |
| ---------------- | --- | ----- | ------ | ------ |
| get_window_state | 2   | 104.2 | 175.9  | 175.9  |
| list_windows     | 4   | 5.1   | 63.2   | 63.2   |
| set_value        | 2   | 0.6   | 1111.7 | 1111.7 |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
