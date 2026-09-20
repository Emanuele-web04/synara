# live-cert livecert-mu6k7grb

- date: 2026-09-18T06:10:53.710Z
- elapsed: 35831ms
- verdict: **PASS** — 14 pass / 0 fail / 0 skipped

| Row                  | Verdict | Detail                                                                                                                                                                                                   |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation     | pass    | open -g TextEdit pid 96021; front stayed TextEdit                                                                                                                                                        |
| visible-nonkey-write | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write         | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write      | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes    | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing      | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| space-roundtrip      | pass    | switch 1→62: true; write: true; back: true                                                                                                                                                               |
| off-space-refusal    | pass    | off-space window: elements=50, write=verified, readback=exact                                                                                                                                            |
| screenshot-fresh     | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| stale-token          | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state         | pass    | {"elapsed_ms":277,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6k7grb-conc-0\",\"role\":\"AXTextAre |
| masked-activation    | pass    | panel=1 front=96392 (want 96392) masked=1 wrote=true released=true                                                                                                                                       |
| cancellation         | pass    | cancelled=true effect=undefined delivered=18/2518 chars                                                                                                                                                  |
| focus-invariant      | pass    | theft-free across 1214 samples (0 topWin blips tolerated)                                                                                                                                                |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
