# Server event-loop stalls

Synara measures server responsiveness locally in Stable and Beta. A stalled main
thread cannot answer `/health` or report a warning until it resumes; TCP acceptance
alone does not establish application responsiveness.

## Operator status

`/health` includes `eventLoop`; `synara server status --json` exposes the same data.
The text status prints delay p50/p99/max, ELU, stall-window count and last-stall age.
These fields contain numbers/booleans only, with no paths, stacks or identifiers.
`available: false` means monitoring is unavailable, not that the event loop is healthy.
An unreachable status probe cannot distinguish overload from a network failure.

The scoped monitor uses Node `monitorEventLoopDelay` at **20 ms resolution**, reads
it every **1 second**. A second native histogram keeps the full **30 second summary**
window; Node cannot merge interval histograms into recordable histograms.
Reported delay percentiles subtract the 20 ms idle baseline and clamp at zero.
`sampleWindowMs` is actual elapsed time, so a blocked sampling timer can yield a
longer window. Status shows the current sampled window, or the last completed
window before the next sample. Quantization and histogram reset boundaries limit
precision; timer drift supplements the maximum when the native sampling timer
has not yet recorded recovery. Percentiles describe recorded samples, not elapsed
time spent stalled.

A **2 second** delay triggers `server.eventLoop.stall` and a structured warning in
the existing server log. This is perceptible but safely above ordinary jitter.
Each warning includes observed duration, ELU, CPU time/percentage, page faults,
involuntary context switches, RSS/heap/external bytes and system load average.
CPU percentage uses 100% per core and can exceed 100% with worker activity.
ELU measures active versus idle event-loop time; high ELU with low process CPU can
indicate native blocking or scheduling pressure, but does not prove a root cause.
System load is contextual and platform-specific, not a per-process CPU measure.

Warnings are limited to **one per 30 seconds**. Suppressed window count and maximum
are retained in summaries and the next warning. `stallWindowCount` counts sampled
windows with a qualifying stall, not individual operations: several stalls can
share a window. The first sample is discarded to exclude startup work. Samples
whose delay exceeds ELU active time (allowing 20 ms or 0.2% for histogram quantization) are
excluded as possible system sleep and restart the summary window. This is a
best-effort distinction, not proof that every excluded delay was sleep: CPU
starvation while the loop is idle can look the same to ELU. Gaps of at least 2
seconds are retained in cumulative `discardedIdleGapCount` / `discardedIdleGapMs`
status and summary fields and a rate-limited local idle-gap log with ELU, CPU and
load context. They are separate from active stalls and excluded from percentiles.
Wall/monotonic clocks and load alone do not reliably prove suspend across the
supported platforms, so the monitor does not infer a cause from those signals.

Two 20 ms native timers (at most 100 native callbacks/s) and one JavaScript
read/s make stalls close to 2 seconds measurable and notify operators promptly
after recovery.
No worker watchdog or continuous profiler runs in normal operation.

## Client behavior and RPC deadlines

The app does not poll the server for liveness or show a busy notice. An earlier
client sent a `server.getRuntimeStatus` heartbeat every 5 seconds and showed
"Synara server is busy" when one reply took longer than 3 seconds, plus a notice
for any request still pending after 15 seconds. One end-to-end sample cannot tell
a stalled server from a busy renderer, a socket queued behind stream data, or
requests waiting for admission. With several agent threads running in parallel
it fired while the server event loop was healthy, so it was removed. The
authenticated `server.runtime-status` capability and RPC remain for operator
probes and compatibility with older clients; [connection recovery](connection-recovery.md)
still owns reconnects, and the composer still reports a real reconnect.

The default **60 second acknowledgement timeout remains**. Removing it globally
would leave reads and mutations with uncertain external effects waiting indefinitely
on a half-open socket. Command receipts alone do not make every provider/Git action
safe to retry. Synara already handles supported `thread.turn.start` uncertainty
through fingerprint-bound receipt settlement; that path keeps waiting/retrying
settlement until acceptance, rejection, caller cancellation or transport disposal.
Known long operations already opt out of the default timeout in `wsNativeApi.ts`.
Mutations are never retried automatically. Existing cancellation and receipt
settlement remain in charge. Timeout copy asks users to check mutation results
before retrying; reads can be retried once the server responds.

During parallel work, live events suppress redundant replay polls until the stream goes quiet;
pending dispatches still poll. Activity-driven Git and workspace-file refreshes share a
2-second leading/trailing throttle per checkout. Turn-end invalidation remains immediate.
Unary requests wait in FIFO client queues using the server's existing per-class limits.
The capacity wait budget is 3 seconds after the transport has been open for a full window;
cancellation removes waiters, disposal rejects them, and stream-backed actions bypass the queue.
A request whose deadline expires before sending reports capacity rather than uncertain delivery.

## Attribution: measured limitation

A temporary worker probe connected with `inspector.Session.connectToMainThread`,
enabled the profiler, then requested `Profiler.start` 500 ms after readiness while
the main thread was blocked for 3 seconds. No inspector TCP listener or debugger
pause was used. On 2026-10-06 (local date):

| Runtime                                                  | Blocking work                                    | Delay before profiler start |
| -------------------------------------------------------- | ------------------------------------------------ | --------------------------: |
| Node 24.21.0                                             | synchronous native wait (`execFileSync` / sleep) |                     2581 ms |
| Installed packaged Synara Electron 43.4.1 / Node 24.18.1 | same native wait                                 |                     2569 ms |
| Node 24.21.0                                             | JavaScript tight loop                            |                       14 ms |

In native waits, sampling started at recovery and retained an `execFileSync` frame,
but did not capture the preceding blocked interval. This is insufficient evidence
to attribute slow synchronous filesystem calls or CPU starvation reliably. A
post-recovery JavaScript stack is likewise the monitor's stack, not the blocker's.
Continuous profiling could cover that interval, but introduces persistent overhead,
unbounded raw profile/privacy concerns and conflicts with operator profiling.
Therefore automatic stack attribution is deliberately omitted.

For a reproducible local incident, an operator can use Instruments/Activity Monitor
**Sample Process** on the backend while it is blocked, or start a Node CPU profile
before the operation in an isolated CLI test environment. Profiles can contain paths
and function names; they remain local and are never sent through Beta diagnostics.
Do not enable inspector network access or change the packaged app's fuses for this.

References: [Node performance APIs](https://nodejs.org/api/perf_hooks.html),
[worker inspector sessions](https://nodejs.org/api/inspector.html#sessionconnecttomainthread),
[Electron inspector fuses](https://www.electronjs.org/docs/latest/tutorial/fuses#nodecliinspect).
