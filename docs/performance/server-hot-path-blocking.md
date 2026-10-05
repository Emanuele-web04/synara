# Server hot-path filesystem profiling

Measured on macOS / 10 CPU cores, Node 24.21.0, against upstream `a83a6248b`.
This report covers Codex callback filesystem work. Orchestration lanes, checkpoint
scheduling, provider process priority and the event-loop watchdog are separate work.

## Root cause and change

| Profile finding                                                          | Evidence                                                                                                                                                         | Action                                                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Codex stdout callback scans every live session and revalidates disk auth | `CodexAdapter.listener` → `listSessions` → `pruneStaleAuthSessions` → `contextAuthStalenessMessage`; then `getSessionCodexOptions` revalidates the emitter again | Bind immutable origin metadata without I/O; asynchronously revalidate only the emitter                                                  |
| Main-thread synchronous filesystem chains                                | Baseline CPU profile's largest `pruneStaleAuthSessions` subtree: 6,073 ms inclusive; `realpathSync`, `lstatSync`, `openSync`, `readFileSync` underneath it       | One shared security algorithm with synchronous compatibility and asynchronous filesystem interpreters                                   |
| Serial asynchronous validation can reduce streaming throughput           | An intermediate implementation left seven turns behind reconciliation at 25 seconds despite lowering synchronous call counts                                     | Overlap at most eight metadata preparations; keep the existing serial publisher, byte/count admission, compaction and terminal reserves |
| Large SQLite history                                                     | Actual hot SQL tested against 304,388 events and 10,016 projected messages in a 1,302,536,192-byte synthetic database                                            | Existing event indexes work; no schema migration justified by the measured tail latency                                                 |
| Checkpoint/provider starts under load                                    | Inline checkpoint/Studio baseline work is inside the global reactor delivery lock; slow starts and reconciliation persist in the load fixture                    | Evidence for the orchestration sibling; no orchestration/checkpoint files changed                                                       |

Auth results are never cached. The shared algorithm retains logical/canonical home
identity, symlink rejection, `O_NOFOLLOW`, descriptor identity/mode/size/timestamps,
pre/post read checks, content fingerprints and descriptor closure. A stale-auth fence
belongs to the originating context, including synchronous pruning, cancellation,
replacement and preparations that finish out of order. Same-account token rotation
keeps its existing fingerprint behavior.

Startup/private permission checks and the manager's synchronous lifecycle APIs remain
synchronous. They no longer run for every stdout event: the largest remaining
`pruneStaleAuthSessions` profile subtree is 100 ms inclusive versus 6,073 ms at the
base. Other legacy filesystem sites not implicated by this profile are unchanged;
their references are frozen in
`scripts/server-sync-fs-budget.json`. `bun run lint` runs the AST-based guard, which
rejects added synchronous API references, new files, dynamic namespace access and
non-static filesystem imports. Each existing exception has a reason and a per-method
budget. This narrowly targets blocking filesystem APIs rather than banning harmless
Node builtins throughout the server.

## Before / after

Each cell is **before → after**, in milliseconds unless specified otherwise.

| Workload                    |  Event-loop p99 |  Event-loop max |   Command RPC p99 |   Command RPC max |   `/health` p99 |   `/health` max |
| --------------------------- | --------------: | --------------: | ----------------: | ----------------: | --------------: | --------------: |
| No added synthetic CPU load |   57.02 → 43.32 |  224.13 → 76.94 |    315.87 → 97.19 |   598.37 → 147.06 |  115.72 → 58.08 |  261.49 → 82.72 |
| 40 CPU worker threads       | 412.35 → 170.00 | 823.13 → 382.99 | 2,000.71 → 416.02 | 2,000.71 → 628.31 | 470.45 → 161.51 | 470.45 → 169.92 |

| Workload       | Synchronous fs calls | Sum of instrumented fs elapsed time | RPC samples | HTTP samples |
| -------------- | -------------------: | ----------------------------------: | ----------: | -----------: |
| No added load  |     899,268 → 23,590 |                      4,874 → 223 ms |   187 → 213 |    170 → 196 |
| 40 CPU workers |      150,489 → 7,979 |                      4,278 → 300 ms |    58 → 129 |     41 → 112 |

Both no-added-load captures completed all eight turns. Under added load, the baseline
had one running turn and seven not started at the snapshot; the final capture had two
running, two interrupted by runtime reconciliation and four not started. These are
25-second observations, not provider completion benchmarks. Improving server
responsiveness does not resolve the remaining orchestration bottleneck.

### Method and limits

- Built the Node server CLI once at the base and once with the change. Used separate
  homes under `/tmp`, server port 46171, dev URL port 46172 and fixture authentication.
  Checked the dev runner's isolation dry-run. User Stable/Beta homes were not used.
- Reused `scripts/computer-use-fixtures/packaged-client.ts` for the WebSocket owner
  connection and contract-validated command RPCs. A fake Codex JSONL executable
  streams eight sessions, 500 text deltas and four tool start/complete pairs per turn,
  with ordinary orchestration checkpoints on an isolated Git fixture.
- Sampled `monitorEventLoopDelay({ resolution: 10 })` after startup, covering session
  creation plus a 25-second HTTP/metadata-update loop. Node `--cpu-prof` runs in the
  same captures. Commands include project/thread creation, turn requests and metadata
  updates; latency measures the RPC response, not completion of queued provider work.
- CPU workers continuously compute `Math.sin`; the supervisor stops its own workers
  and server. The shared machine has unrelated background load. “No added load” is
  not a verified unloaded-host benchmark. Results are single paired captures with
  variable scheduling, not statistical performance guarantees.
- Lightweight fs/SQLite counters run in both versions. Nested fs timings overlap and
  are not exclusive CPU time. Full `Error().stack` instrumentation was used only to
  identify callers and discarded from latency comparisons. CPU profile subtree time
  includes startup and shutdown; the delay/counter table excludes startup/shutdown.
- These captures precede the final stale-auth closure/teardown edge-case fixes.
  The valid-auth streaming path measured here is unchanged by those fixes.
- The production Stable 30-second total HTTP stall was not reproduced exactly. Live
  providers, packaged Windows and production database contents were not tested.
  This change removes a measured matching synchronous stack, not every possible stall.

Typical isolated capture command (developer probe is a temporary artifact):

```sh
node --require /tmp/synara-perf-hot-path/probe.cjs --cpu-prof \
  --cpu-prof-dir=/tmp/synara-perf-hot-path/evidence \
  apps/server/dist/index.mjs \
  --home-dir /tmp/synara-perf-hot-path/home-fixture \
  --host 127.0.0.1 --port 46171 --dev-url http://localhost:46172 \
  --no-browser --auth-token perf-isolated-token
```

The isolated `dev/settings.json` selects the fake binary and isolated Codex home;
per-command provider options do not override server settings. Raw profiles, the
fixture/probe and measurement JSON are retained in the local task evidence archive.
There is no new runtime telemetry or Stable diagnostics collection.

## Large SQLite measurements

Used Node's production `DatabaseSync` and exact SQL collected by the probe, WAL and
`synchronous=NORMAL`, 21 runs per query (first reported separately; 20 warm samples).
The synthetic event history spans 300 streams of 1,000 events; the projected messages
span eight active threads. This measures query execution/materialization offline,
not Effect/schema decoding or a live recovery over synthetic event payloads.

| Query                         | Rows returned |    First | Warm p50 | Warm max / empirical p99 | Plan                                                |
| ----------------------------- | ------------: | -------: | -------: | -----------------------: | --------------------------------------------------- |
| Thread message preview        |           200 | 29.79 ms |  2.76 ms |                  3.23 ms | Thread index; temporary ranking/order sorts         |
| Global message snapshot       |         1,600 | 57.18 ms | 24.35 ms |                 28.17 ms | Per-thread indexes; ranks message history and sorts |
| Bounded provider event replay |           100 |  1.15 ms | 0.039 ms |                 0.163 ms | Integer primary-key range                           |
| Thread metadata high-water    |             1 | 12.63 ms |  0.99 ms |                  1.99 ms | `idx_orch_events_stream_sequence`                   |

A temporary causal-order expression index reduced the global snapshot median from
24.35 to 15.13 ms, but its measured tail worsened from 28.17 to 42.82 ms; thread preview
tail also worsened (3.23 to 4.54 ms). It was removed from the synthetic DB. These short,
noisy samples do not justify permanent write amplification or a migration.

Global snapshot ranking/materialization still runs synchronously on the main thread.
The 57 ms first-read result deserves follow-up with denser projected histories and
schema decoding. Moving SQLite reads to a worker is not implemented here and is not
proven necessary by this workload. No full scan of the large event table appeared in
the measured read plans.

## Verification

Focused tests cover async-only reads, descriptor races and closure, home replacement,
logical symlink retargeting, symlinked auth/private homes, token rotation, context
replacement, sync/async stale-auth pruning, out-of-order auth invalidation, trusted
manager closure, failed teardown retry, ordered bounded preparation, rejection,
eviction, abort and compact terminal delivery.

The PR records the actual final workspace checks and any failures.
