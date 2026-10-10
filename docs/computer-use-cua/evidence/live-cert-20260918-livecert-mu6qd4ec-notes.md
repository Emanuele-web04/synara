# live-cert livecert-mu6qd4ec

- date: 2026-09-18T09:02:44.869Z
- elapsed: 5374ms
- verdict: **FAIL** — 0 pass / 1 fail / 0 skipped

| Row               | Verdict | Detail                                                                                        |
| ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| locked-use-reauth | fail    | grant=true pausedRefused=true reauth=false declineHeld=true pendingSurvived=true resumed=true |

## Speed budget (driver-call wall clock, ms)

| Tool             | n   | p50   | p95    | max    |
| ---------------- | --- | ----- | ------ | ------ |
| get_window_state | 2   | 107.8 | 461.1  | 461.1  |
| list_windows     | 4   | 4.9   | 67.1   | 67.1   |
| set_value        | 2   | 3.9   | 1080.2 | 1080.2 |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
