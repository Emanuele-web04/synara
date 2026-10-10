# live-cert livecert-mu6qg0qn

- date: 2026-09-18T09:06:00.741Z
- elapsed: 66020ms
- verdict: **PASS** — 21 pass / 0 fail / 0 skipped

| Row                   | Verdict | Detail                                                                                                                                                                                                   |
| --------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| launch-isolation      | pass    | open -g TextEdit pid 94661; front stayed TextEdit                                                                                                                                                        |
| visible-nonkey-write  | pass    | effect=confirmed readback=exact                                                                                                                                                                          |
| hidden-write          | pass    | is_on_screen=false readback=exact                                                                                                                                                                        |
| minimized-write       | pass    | minimized=off-screen readback=exact                                                                                                                                                                      |
| concurrent-writes     | pass    | 3 targets, readbacks 3/3 exact                                                                                                                                                                           |
| operator-typing       | pass    | front doc got human-only=true; hidden doc exact=true                                                                                                                                                     |
| hidden-launch-default | pass    | manager.launchApp(no opts) → pid 96579 on_screen=false front 94650→94650                                                                                                                                 |
| chromium-semantic     | pass    | pid=98138 on_screen=false elements=139 field=Address and search bar readback=exact front 94650→94650                                                                                                     |
| grant-lifecycle       | pass    | prompts=["live-cert-grants-a:Calculator","live-cert-grants-c:Calculator"] minted=2 listed=1 revoked=true                                                                                                 |
| recording-privacy     | pass    | redacted=true secureFloor=true fullOptIn=true replay=1steps listed=3                                                                                                                                     |
| locked-use-reauth     | pass    | grant=true pausedRefused=true reauth=true declineHeld=true pendingSurvived=true resumed=true                                                                                                             |
| space-roundtrip       | pass    | switch 1→3: true; write: true; back: true                                                                                                                                                                |
| off-space-refusal     | pass    | off-space window: elements=50, write=verified, readback=exact                                                                                                                                            |
| screenshot-fresh      | pass    | png=true valid=true freshness=captured_current_space                                                                                                                                                     |
| hidden-screenshot     | pass    | on_screen=false A=31212b B=102900b changed=true valid=true dimsMatch=true                                                                                                                                |
| stale-token           | pass    | forged token → {"ok":true,"result":{"content":[{"text":"element_token is stale; call get_window_state again to refresh","type":"text"}],"isError":true,"structuredContent":{"re                          |
| verify-state          | pass    | {"elapsed_ms":247,"predicates":[{"index":0,"observed_json":"{\"element_index\":1,\"frame\":{\"h\":382.0,\"w\":586.0,\"x\":165.0,\"y\":186.0},\"label\":\"livecert-mu6qg0qn-conc-0\",\"role\":\"AXTextAre |
| masked-activation     | pass    | panel=1 front=11557 (want 11557) masked=1 wrote=true released=true                                                                                                                                       |
| escape-kill-switch    | pass    | baseline=true hostArmed=true immune=true engaged=true refused=true rearmed=true (physical key unverified — VM)                                                                                           |
| cancellation          | pass    | cancelled=true effect=undefined delivered=18/2518 chars                                                                                                                                                  |
| focus-invariant       | pass    | theft-free across 2323 samples (0 topWin blips tolerated)                                                                                                                                                |

## Speed budget (driver-call wall clock, ms)

| Tool                 | n   | p50    | p95    | max    |
| -------------------- | --- | ------ | ------ | ------ |
| bring_to_front       | 1   | 294.7  | 294.7  | 294.7  |
| get_window_state     | 34  | 174.9  | 615.6  | 753    |
| launch_app           | 1   | 2745.6 | 2745.6 | 2745.6 |
| list_windows         | 24  | 8      | 66.4   | 115.9  |
| set_app_visibility   | 1   | 96.1   | 96.1   | 96.1   |
| set_value            | 20  | 1131.4 | 2522   | 3610.8 |
| set_window_minimized | 1   | 559.2  | 559.2  | 559.2  |
| verify_state         | 1   | 248.5  | 248.5  | 248.5  |

Skipped rows are honest gaps, not passes. Re-run with a second desktop
Space for the space-\* rows.
