# live-cert livecert-mu6o1m5y

- date: 2026-09-18T07:58:40.563Z
- elapsed: 57146ms
- verdict: **PASS** — 18 pass / 0 fail / 0 skipped

| Row                   | Verdict | Detail                                                                                                                                                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation      | pass    | open -g TextEdit pid 56419; front stayed TextEdit                                                                                                                                                        |
| visible-nonkey-write  | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write          | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write       | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes     | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing       | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| hidden-launch-default | pass    | manager.launchApp(no opts) → pid 58423 on_screen=false front 56407→56407                                                                                                                                 |
| chromium-semantic     | pass    | pid=59982 on_screen=false elements=139 field=Address and search bar readback=exact front 56407→56407                                                                                                     |
| space-roundtrip       | pass    | switch 1→3: true; write: true; back: true                                                                                                                                                                |
| off-space-refusal     | pass    | off-space window: elements=50, write=verified, readback=exact                                                                                                                                            |
| screenshot-fresh      | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| hidden-screenshot     | pass    | on_screen=false A=31212b B=98868b changed=true valid=true dimsMatch=true                                                                                                                                 |
| stale-token           | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state          | pass    | {"elapsed_ms":301,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6o1m5y-conc-0\",\"role\":\"AXTextAre |
| masked-activation     | pass    | panel=1 front=60238 (want 60238) masked=1 wrote=true released=true                                                                                                                                       |
| escape-kill-switch    | pass    | baseline=true hostArmed=true immune=true engaged=true refused=true rearmed=true (physical key unverified — VM)                                                                                           |
| cancellation          | pass    | cancelled=true effect=undefined delivered=18/2518 chars                                                                                                                                                  |
| focus-invariant       | pass    | theft-free across 1895 samples (0 topWin blips tolerated)                                                                                                                                                |

## Speed budget (driver-call wall clock, ms)

| Tool                 | n   | p50    | p95    | max    |
| -------------------- | --- | ------ | ------ | ------ |
| bring_to_front       | 1   | 226.6  | 226.6  | 226.6  |
| get_window_state     | 30  | 266.7  | 1075.1 | 1126.8 |
| launch_app           | 1   | 2707.6 | 2707.6 | 2707.6 |
| list_windows         | 21  | 16.5   | 129.9  | 146.3  |
| set_app_visibility   | 1   | 64.6   | 64.6   | 64.6   |
| set_value            | 17  | 1138.4 | 3582.1 | 3582.1 |
| set_window_minimized | 1   | 561.8  | 561.8  | 561.8  |
| verify_state         | 1   | 302.3  | 302.3  | 302.3  |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
