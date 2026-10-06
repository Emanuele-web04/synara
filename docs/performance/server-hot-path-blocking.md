# Server hot-path filesystem profiling

Measured on macOS / 10 CPU cores, Node 24.21.0, against upstream `a83a6248b`.
This report covers Codex callback filesystem work. Orchestration lanes, checkpoint
scheduling, provider process priority and the event-loop watchdog are separate work.

## Root cause and change

| Profile finding                                                          | Evidence                                                                                                                                                         | Action                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex stdout callback scans every live session and revalidates disk auth | `CodexAdapter.listener` → `listSessions` → `pruneStaleAuthSessions` → `contextAuthStalenessMessage`; then `getSessionCodexOptions` revalidates the emitter again | Bind immutable origin metadata without I/O; asynchronously revalidate only the emitter                                                                                            |
| Main-thread synchronous filesystem chains                                | Fresh loaded upstream `pruneStaleAuthSessions` subtree: 6,919 ms inclusive; `realpathSync`, `lstatSync`, `openSync`, `readFileSync` underneath it                | One shared security algorithm with synchronous compatibility and asynchronous filesystem interpreters                                                                             |
| Serial asynchronous validation can reduce streaming throughput           | Two pre-review captures dropped 1,444–1,469 events under 40 CPU workers despite responsive HTTP/RPCs                                                             | Coalesce pending checks per session origin; at most one running and one pending check per origin, eight native checks globally; preserve serial publication and admission budgets |
| Large SQLite history                                                     | Actual hot SQL tested against 304,388 events and 10,016 projected messages in a 1,302,536,192-byte synthetic database                                            | Existing event indexes work; no schema migration justified by the measured tail latency                                                                                           |
| Checkpoint/provider starts under load                                    | Inline checkpoint/Studio baseline work is inside the global reactor delivery lock; slow starts and reconciliation persist in the load fixture                    | Evidence for the orchestration sibling; no orchestration/checkpoint files changed                                                                                                 |

Auth results are never cached. The shared algorithm retains logical/canonical home
identity, symlink rejection, `O_NOFOLLOW`, descriptor identity/mode/size/timestamps,
pre/post read checks, content fingerprints and descriptor closure. A stale-auth fence
belongs to the originating context, including synchronous pruning, cancellation,
replacement and preparations that finish out of order. Same-account token rotation
keeps its existing fingerprint behavior. A `file-changed` snapshot retries the full
security algorithm up to three total attempts; other failures do not retry.

Each admitted event uses a check that starts after its admission. Events arriving
while that check runs join the next pending check for the same immutable context.
Results are shared only among that check's already-admitted events; there is no
cross-check auth cache. Replacements have different keys. Publication remains one
ordered consumer and checks the originating context's rejection fence again.

The five-second revalidation deadline includes waiting for a native I/O lease.
A timeout rejects that origin and releases its queued publication work. Native fs
promises cannot be cancelled, so started reads retain their semaphore permits until
settlement and descriptor cleanup. Timed-out lease waiters are removed. Eight
permanently hung reads can exhaust the native-read budget; subsequent origins then
fail closed at their own deadlines rather than accumulating more native reads.
This bounds server work but does not make an unavailable filesystem healthy.

Unexpected inspector errors also reject the original origin and emit a fixed error
message with its thread ID, without the error or credentials. They cannot silently
publish without auth validation. The generic ingress logs failed preparations and
skips the affected item; the Codex adapter handles inspector errors explicitly.
Trusted manager-authored session closes remain deliverable. Provider stdout cannot
forge that exception. Dropped/evicted events now produce warnings at totals 1, 2, 4,
8, etc., avoiding both silent loss and a warning for every delta.

Startup/private permission checks and the manager's synchronous lifecycle APIs remain
synchronous. They no longer run for every stdout event: the largest remaining
`pruneStaleAuthSessions` loaded profile subtree is 481–502 ms inclusive versus
6,919 ms at the base (including startup/shutdown). Other legacy filesystem sites not implicated by this profile are unchanged;
their references are frozen in
`scripts/server-sync-fs-budget.json`. `bun run lint` runs the AST-based guard, which
scans server and shared runtime sources. It requires exact per-method budgets:
removing a reference also requires reducing its budget. It tracks simple namespace
alias chains and rejects direct namespace arguments, dynamic access, re-exports and
non-static/import-equals fs imports. Each existing exception has a reason.

This is a syntax guard, not interprocedural analysis: object wrappers, reassignment
and indirect calls can hide references, and moving an existing call into a hot path
within the same file still requires review/profiling. This narrowly targets blocking filesystem APIs rather than banning harmless
Node builtins throughout the server.

## Before / after (final production behavior)

A fresh control at upstream `a83a6248b` and two final captures use the same synthetic
`auth.json`/`config.toml`, eight sessions, 500 deltas per session and four tool pairs.
Each cell is **upstream control → final range across two captures**, in milliseconds.
The original profile was collected on a much busier shared host; these fresh latency
numbers replace its preliminary latency table.

| Workload          |         Event-loop p99 |         Event-loop max |        Command RPC p99 |        Command RPC max |          `/health` p99 |          `/health` max |
| ----------------- | ---------------------: | ---------------------: | ---------------------: | ---------------------: | ---------------------: | ---------------------: |
| No added CPU load |    26.94 → 16.08–16.55 |    67.50 → 60.10–63.80 |    72.69 → 23.17–25.43 |    94.06 → 44.44–48.53 |     47.19 → 9.15–11.30 |    48.84 → 26.66–28.00 |
| 40 CPU workers    | 220.73 → 118.42–138.67 | 347.60 → 206.70–237.63 | 734.05 → 260.95–348.27 | 734.05 → 289.80–412.93 | 496.97 → 126.88–154.18 | 496.97 → 132.26–180.64 |

| Workload          | Synchronous fs calls: upstream → final | Instrumented fs elapsed: upstream → final | Provider emission → publication p99: upstream → final |
| ----------------- | -------------------------------------: | ----------------------------------------: | ----------------------------------------------------: |
| No added CPU load |              1,127,023 → 24,820–25,688 |                         3900 → 131–134 ms |                              36.00 → 100.00–105.00 ms |
| 40 CPU workers    |                376,182 → 20,548–21,449 |                         5683 → 441–497 ms |                         267.00 → 1,407.00–1,810.00 ms |

Async validation has a streaming latency cost relative to synchronous validation on
a cached local filesystem. The upstream callback validates before ingress admission,
so its admission-to-publication delay alone would misleadingly look almost zero.
The emission timestamps include that pre-admission work. The final version improves
server responsiveness and delivers more events under CPU pressure, while adding fs
pool/ordered-publication waiting. This is not a claim of faster streaming than upstream.

## Review revision: ingress throughput

Compared exact PR commit `3e48382` (one check per event, eight overlapping checks) with
final coalesced validation. Both use the same valid synthetic auth/config and probe.
Paired captures reverse version order on the second pair. No event payload is merged.

| Workload / pair    | Dropped: before → after | Deltas published: before → after | Admission → publication p99: before → after | Publication max: before → after | Queued at boundary: before → after | Native checks started: before → after |
| ------------------ | ----------------------: | -------------------------------: | ------------------------------------------: | ------------------------------: | ---------------------------------: | ------------------------------------: |
| No added load / 1  |                   0 → 0 |                    4,000 → 4,000 |                           391.36 → 98.86 ms |              418.46 → 121.54 ms |                              0 → 0 |                           4,176 → 865 |
| No added load / 2  |                   0 → 0 |                    4,000 → 4,000 |                           267.91 → 96.16 ms |              289.76 → 127.86 ms |                              0 → 0 |                           4,176 → 864 |
| 40 CPU workers / 1 |               1,469 → 0 |                      791 → 4,000 |                     18,271.59 → 1,773.13 ms |         18,495.05 → 1,818.06 ms |                          1,822 → 0 |                             852 → 182 |
| 40 CPU workers / 2 |               1,444 → 0 |                      820 → 4,000 |                     17,804.16 → 1,377.51 ms |         18,022.55 → 1,391.00 ms |                          1,818 → 3 |                             881 → 213 |

Both loaded pre-review captures received 4,000 deltas, filled the 1,984 normal slots
and dropped events. Their queue high-water was 1,985 including reserved terminal work;
only 791/820 deltas had been published at the boundary. The final captures published
all 4,000 deltas, all 40 item starts/completions and all eight turn completions, with
zero drops/terminal overflow. Loaded queue high-water fell to 527/374. The three
remaining queued items in the second final capture were session lifecycle work,
not missing streaming deltas.

The pre-review loaded snapshots each had two running, three interrupted and three
not-started projected turns. Final snapshots had four completed/four not started,
and three completed/one running/four not started, respectively. The provider runtime
journal after isolated shutdown contains 500 deltas and one completion per thread in
the first final capture. Ingress delivery does not prove timely orchestration projection.
The extra delivered work also raised RPC/event-loop p99 relative to the pre-review
version; see the raw per-capture summary rather than comparing unequal delivered work.

The two interrupted turns in the original preliminary capture have durable recovery
activities with this reason: "The live provider session is 'ready', but the projection
is still running." Their journals were partial and had no completed turn at the capture
boundary. The original probe did not measure drops, so it cannot distinguish delayed
or lost events retrospectively. The new captures demonstrate both the ingress loss
mechanism before review and continuing orchestration/projection lag after it is fixed.

### Method and limits

- Separate homes under `/tmp`, unused server port 46171/dev URL port 46172; the dev
  runner's isolation dry-run and IPv4/IPv6 listeners were checked. Provider overlay
  home is also isolated per capture. User Stable/Beta homes were never used.
- Reused `scripts/computer-use-fixtures/packaged-client.ts`, contract-validated owner
  WebSocket RPCs, the fake Codex JSONL provider and Git/checkpoint fixture. The source
  home contains synthetic account/token values only. This is not live provider testing.
- `monitorEventLoopDelay({ resolution: 10 })` and Node `--cpu-prof` run together.
  The latency window starts after server initialization, includes session creation,
  a 25-second health/metadata-command loop, and the final snapshot/connection close.
  Commands measure their RPC response, not completion of provider side effects.
- A temporary probe observes actual `ingress.status()`, offer results, ordered runtime
  publication, queue/byte high-water and check starts. Admission-to-publication timings
  include all mapped native events (mostly text deltas). Child timestamps measure
  emission-to-publication separately. No probe is included in shipped code.
- Each CPU-pressure capture uses 40 finite workers computing `Math.sin`; the supervisor
  stops its own workers and server. The coordinator verified no heavy checks before
  the window (host load about 3); no other heavy suite was started during these captures.
  Host uptime/load samples are in the archive. This is a shared host, not a statistical
  guarantee or an exactly reproduced production load of 80. No-added-load is literal.
- Lightweight fs/SQLite counters use the same 11 fs APIs in all captures. Nested fs
  timings overlap. Stack-string instrumentation is excluded from latency captures.
  CPU profile aggregates include startup/shutdown; delay/counter windows exclude them.
  Started native reads are counted by manager validation entry; lease bounds on timeout
  are verified with gated real fs tests, not inferred from that counter.
- New loaded upstream CPU profiles spend 6,919 ms inclusive in `pruneStaleAuthSessions`
  versus 481–502 ms in final profiles. Remaining raw profiles are dominated by process
  spawning and process-tree capture (including shutdown), plus SQLite event writes.
  Global queue/checkpoint scheduling and process priority remain sibling work.
- Same-account token rotation, retries and timeout failures are regression-tested;
  the benchmark holds auth constant. The production Stable 30-second total HTTP stall
  was not reproduced exactly. Packaged Windows and production database contents are
  unverified. No worker-thread SQLite implementation or schema migration was added.

Typical isolated capture command (temporary developer probe):

```sh
SYNARA_HOME=/tmp/synara-perf-hot-path/home-fixture/dev \
node --require /tmp/synara-perf-hot-path/review-probe.cjs --cpu-prof \
  --cpu-prof-dir=/tmp/synara-perf-hot-path/evidence \
  apps/server/dist/index.mjs \
  --home-dir /tmp/synara-perf-hot-path/home-fixture \
  --host 127.0.0.1 --port 46171 --dev-url http://localhost:46172 \
  --no-browser --auth-token perf-isolated-token
```

The isolated `dev/settings.json` selects the fake binary and isolated Codex source
home; per-command provider options do not override server settings. Probe hooks are
in temporary compiled bundle copies only. Raw profiles, counters, client snapshots,
host samples, harness and summaries are in the PR evidence archive. There is no new
runtime telemetry or Stable diagnostics collection.

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

Focused regressions publish 3,000 ordered deltas through three gated checks with no
loss, verify every coalesced event's check starts after admission, and exercise
count/byte saturation with terminal eviction. A native-read regression holds eight
reads past their deadlines: a ninth times out without starting, then a new context
succeeds after one read settles. Concurrent same-account rewrites succeed on retry;
account changes and three unstable snapshots still reject, closing all descriptors.

Focused tests also cover async-only reads, descriptor races and closure, home replacement,
logical symlink retargeting, symlinked auth/private homes, token rotation, context
replacement, sync/async stale-auth pruning, out-of-order auth invalidation, trusted
manager closure, failed teardown retry, ordered bounded preparation, rejection,
eviction, abort and compact terminal delivery.

The PR records the actual final workspace checks and any failures.
