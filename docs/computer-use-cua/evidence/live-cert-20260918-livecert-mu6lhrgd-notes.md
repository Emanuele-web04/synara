# live-cert livecert-mu6lhrgd

- date: 2026-09-18T06:46:53.129Z
- elapsed: 35196ms
- verdict: **FAIL** — 11 pass / 1 fail / 3 skipped

| Row                  | Verdict | Detail                                                                                                                                                                                                   |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation     | pass    | open -g TextEdit pid 2274; front stayed TextEdit                                                                                                                                                         |
| visible-nonkey-write | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write         | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write      | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes    | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing      | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| space-roundtrip      | skipped | space-ctl build failed                                                                                                                                                                                   |
| off-space-refusal    | skipped | space-ctl missing                                                                                                                                                                                        |
| screenshot-fresh     | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| stale-token          | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state         | pass    | {"elapsed_ms":217,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6lhrgd-conc-0\",\"role\":\"AXTextAre |
| masked-activation    | fail    | panel=0 front=2602 (want 2602) masked=0 wrote=true released=true                                                                                                                                         |
| escape-kill-switch   | pass    | baseline=true hostArmed=true immune=true engaged=true refused=true rearmed=true (physical key unverified — VM)                                                                                           |
| cancellation         | pass    | cancelled=true effect=refused delivered=0/2518 chars                                                                                                                                                     |
| focus-invariant      | skipped | probe unavailable — no theft coverage                                                                                                                                                                    |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
