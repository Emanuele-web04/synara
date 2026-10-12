# live-cert livecert-mu6qad88

- date: 2026-09-18T09:00:36.097Z
- elapsed: 5127ms
- verdict: **FAIL** — 0 pass / 1 fail / 0 skipped

| Row               | Verdict | Detail                                                                                         |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------- |
| locked-use-reauth | fail    | grant=false pausedRefused=true reauth=true declineHeld=false pendingSurvived=true resumed=true |

## Speed budget (driver-call wall clock, ms)

| Tool             | n   | p50 | p95    | max    |
| ---------------- | --- | --- | ------ | ------ |
| get_window_state | 2   | 115 | 180.6  | 180.6  |
| list_windows     | 4   | 4   | 62.3   | 62.3   |
| set_value        | 2   | 0.4 | 1164.4 | 1164.4 |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
