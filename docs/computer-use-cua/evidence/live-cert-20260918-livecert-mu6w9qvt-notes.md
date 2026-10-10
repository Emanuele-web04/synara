# live-cert livecert-mu6w9qvt

- date: 2026-09-18T11:49:20.188Z
- elapsed: 80474ms
- verdict: **FAIL** — 19 pass / 2 fail / 0 skipped

| Row                   | Verdict | Detail                                                                                                                                                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation      | pass    | open -g TextEdit pid 96193; front stayed TextEdit                                                                                                                                                        |
| visible-nonkey-write  | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write          | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write       | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes     | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing       | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| hidden-launch-default | pass    | manager.launchApp(no opts) → pid 98021 on_screen=false front 96165→96165                                                                                                                                 |
| chromium-semantic     | fail    | pid=99580 on_screen=true elements=210 field=Address and search bar readback=exact front 96165→99580                                                                                                      |
| grant-lifecycle       | pass    | prompts=["live-cert-grants-a:Calculator","live-cert-grants-c:Calculator"] minted=2 listed=1 revoked=true                                                                                                 |
| recording-privacy     | pass    | redacted=true secureFloor=true fullOptIn=true replay=1steps listed=3                                                                                                                                     |
| locked-use-reauth     | pass    | grant=true pausedRefused=true reauth=true declineHeld=true pendingSurvived=true resumed=true                                                                                                             |
| space-roundtrip       | pass    | switch 1→3: true; write: true; back: true                                                                                                                                                                |
| off-space-refusal     | pass    | off-space window: elements=50, write=verified, readback=exact                                                                                                                                            |
| screenshot-fresh      | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| hidden-screenshot     | pass    | on_screen=false A=31212b B=95068b changed=true valid=true dimsMatch=true                                                                                                                                 |
| stale-token           | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state          | pass    | {"elapsed_ms":314,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6w9qvt-conc-0\",\"role\":\"AXTextAre |
| masked-activation     | pass    | panel=1 front=13082 (want 13082) masked=1 wrote=true released=true                                                                                                                                       |
| escape-kill-switch    | pass    | baseline=true hostArmed=true immune=true engaged=true refused=true rearmed=true (physical key unverified — VM)                                                                                           |
| cancellation          | pass    | cancelled=true effect=undefined delivered=18/2518 chars                                                                                                                                                  |
| focus-invariant       | fail    | 2 hard + 0 persistent violations (0 blips)                                                                                                                                                               |

## Speed budget (driver-call wall clock, ms)

| Tool                 | n   | p50    | p95    | max    |
| -------------------- | --- | ------ | ------ | ------ |
| bring_to_front       | 1   | 348.7  | 348.7  | 348.7  |
| get_window_state     | 34  | 204.9  | 847.3  | 2052.1 |
| launch_app           | 1   | 2227.9 | 2227.9 | 2227.9 |
| list_windows         | 31  | 10     | 259.5  | 527.3  |
| set_app_visibility   | 1   | 2.8    | 2.8    | 2.8    |
| set_value            | 20  | 1151   | 2268.5 | 3369.3 |
| set_window_minimized | 1   | 553.2  | 553.2  | 553.2  |
| verify_state         | 1   | 319.8  | 319.8  | 319.8  |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
