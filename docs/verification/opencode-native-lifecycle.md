# Native OpenCode lifecycle verification

The strengthened acceptance test passed against the actual OpenCode 1.19.0 native CLI and the free `opencode/mimo-v2.6-flash-free` service, twice after workspace isolation. This is a real provider test; no simulated transport, generated events, or response interception is used.

The CLI uses an empty generated workspace and isolated XDG configuration/data/cache/state directories. Only the free OpenCode provider is enabled. Existing credentials and provider configuration are excluded. File, shell, network-fetch and task tools are denied; the only model inputs are synthetic lifecycle prompts.

## Assertions exercised

- Two actual provider sessions have distinct native resume IDs.
- An active first turn emits real model content before cancellation.
- Cancellation produces exactly one `turn.aborted` terminal for that started turn.
- Stopping the first session twice preserves the second session.
- The second session returns `NATIVE_LIFECYCLE_OK` and one successful completion.
- Event observation continues through replacement completion; the first session emits no post-teardown events.
- Repeated `stopAll` leaves the adapter session inventory empty.

The adapter sessions attach to an explicitly external test CLI server. The runner stops its owned server in `finally`. This does not certify the production owned-process receipt or desktop quit path.

## Evidence and reproduction

- [Native acceptance output](opencode-native-lifecycle-check.txt): one test passed, 40.12 seconds.
- [Independent isolated runner output](opencode-native-lifecycle-repro-check.txt): one test passed, 18.94 seconds.
- [Focused regression output](opencode-lifecycle-focused-check.txt): 181 tests passed. These deterministic unit tests supplement the native acceptance; they are not native evidence.
- [Isolated runner](opencode-native-lifecycle-check.py): run from repository root with `python docs/verification/opencode-native-lifecycle-check.py`, Bun and OpenCode on PATH, or specify `OPENCODE_LIVE_BINARY`.

Source blobs tested: native test `2ffb8b50e516e140f3559cc5505e5b2c55efa77d`, interrupted-turn regression `5f62734dbeabf60b46440010d35a7ebe81aea718`. The ordinary regression now collects through the replacement **teardown**, preserving late-event assertions rather than ending at replacement start.

Those outputs record the author revision above. The reproduction runner was subsequently tightened after a process-level control showed that its fixed-port health check could accept an unrelated local server while the owned child had not bound a listener. It now requests an ephemeral port, waits for that owned child's loopback announcement, and shares a fresh local-server password with the test. Startup, test execution, and direct-child cleanup waits are finite; errors remain failures. [Runner controls](opencode-native-lifecycle-check.test.py) use real local HTTP servers and fixture child processes to check that boundary and preserve a failed test exit. They do not establish a new native-provider pass or descendant termination. The earlier raw native outputs remain unchanged.

Earlier isolated attempts failed to reach the external model service because stale per-execution transport settings were reused. Refreshing the current execution's proxy transport while keeping credentials/configuration excluded produced both passes. Transport values are not included in these artifacts. Reproduction requires access to the free model service; a future model outage or retirement must fail visibly rather than substitute an answer.

The repaired ephemeral-endpoint/password runner was executed against the actual native OpenCode 1.19.0 binary after the late-role transcript fix: one native lifecycle test passed in 23.32 seconds. This is native execution of the repaired runner, distinct from its supplemental local HTTP controls. Native binary SHA-256: `135ac3f86c43f2a22328a3554fec5f0bc57d71576077902661bc38dac34871fd`. Raw output is `opencode-native-lifecycle-owned-final-check.txt`. Direct local compilers completed all seven package checks before the upstream release-only changes.

After integrating main `52f06318fdb3c0b4b310a8d55d0083cba0bde1a0`, the same repaired owned-child runner passed again against the actual native CLI: one lifecycle test, 19.82 seconds of native assertions (21.74 seconds total). Raw output: `opencode-native-lifecycle-main52-check.txt`. This repeats real session isolation, active cancellation, replacement completion, teardown fencing, and empty adapter inventory on the combined code; the ownership qualifications above remain.
