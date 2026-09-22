# live-cert livecert-mu6n47uu

- date: 2026-09-18T07:32:38.069Z
- elapsed: 52844ms
- verdict: **FAIL** — 16 pass / 1 fail / 0 skipped

| Row                   | Verdict | Detail                                                                                                                                                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation      | pass    | open -g TextEdit pid 35405; front stayed TextEdit                                                                                                                                                        |
| visible-nonkey-write  | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write          | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write       | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes     | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing       | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| hidden-launch-default | pass    | manager.launchApp(no opts) → pid 37356 on_screen=false front 35395→35395                                                                                                                                 |
| chromium-semantic     | pass    | pid=38915 on_screen=false elements=139 field=Address and search bar readback=exact front 35395→35395                                                                                                     |
| space-roundtrip       | pass    | switch 1→3: true; write: true; back: true                                                                                                                                                                |
| off-space-refusal     | pass    | off-space window: elements=50, write=verified, readback=exact                                                                                                                                            |
| screenshot-fresh      | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| stale-token           | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state          | pass    | {"elapsed_ms":287,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6n47uu-conc-0\",\"role\":\"AXTextAre |
| masked-activation     | pass    | panel=1 front=39121 (want 39121) masked=1 wrote=true released=true                                                                                                                                       |
| escape-kill-switch    | pass    | baseline=true hostArmed=true immune=true engaged=true refused=true rearmed=true (physical key unverified — VM)                                                                                           |
| cancellation          | pass    | cancelled=true effect=undefined delivered=18/2518 chars                                                                                                                                                  |
| focus-invariant       | fail    | 1 hard + 0 persistent violations (0 blips)                                                                                                                                                               |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
