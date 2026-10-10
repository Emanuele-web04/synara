# live-cert livecert-mu6qfkr2

- date: 2026-09-18T09:04:40.799Z
- elapsed: 6799ms
- verdict: **PASS** — 1 pass / 0 fail / 0 skipped

| Row               | Verdict | Detail                                                                                       |
| ----------------- | ------- | -------------------------------------------------------------------------------------------- |
| locked-use-reauth | pass    | grant=true pausedRefused=true reauth=true declineHeld=true pendingSurvived=true resumed=true |

## Speed budget (driver-call wall clock, ms)

| Tool             | n   | p50   | p95    | max    |
| ---------------- | --- | ----- | ------ | ------ |
| get_window_state | 2   | 125.3 | 208.9  | 208.9  |
| list_windows     | 4   | 4.9   | 64.9   | 64.9   |
| set_value        | 2   | 1.1   | 1152.7 | 1152.7 |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
