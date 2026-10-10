# live-cert livecert-mu6q4adg

- date: 2026-09-18T08:55:52.783Z
- elapsed: 5449ms
- verdict: **FAIL** — 0 pass / 1 fail / 0 skipped

| Row               | Verdict | Detail                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------- |
| recording-privacy | fail    | TypeError: undefined is not an object (evaluating 'recordingId.length') |

## Speed budget (driver-call wall clock, ms)

| Tool             | n   | p50    | p95    | max    |
| ---------------- | --- | ------ | ------ | ------ |
| get_window_state | 2   | 113.8  | 174.1  | 174.1  |
| list_windows     | 3   | 4.9    | 63.4   | 63.4   |
| set_value        | 1   | 1112.9 | 1112.9 | 1112.9 |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
