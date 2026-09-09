# Deep provider memory and cleanup audit

## Verdict

**The first OpenCode fix did not cover all providers. This audit found additional defects across multiple adapters, plus shared infrastructure problems. Synara cannot yet be described as leak-free across providers.**

All nine registered providers were inspected: Codex, Claude, Cursor, Devin, Antigravity, Grok, Droid, OpenCode, and Pi. The review traced retained collections, actual history consumers, tool streaming, event admission, stop/retry/replacement, failed startup, and shutdown. Four independent read-only audits supplemented the implementation review. No real provider session, user database, or external process workload was used.

This is an extension of [the crash investigation](report.md). Earlier fixes and measurements remain intact. The findings below concern this checkout; they do not establish what happened inside an affected user's external provider executable.

## Provider coverage

| Provider    | Retained content                                                                                                                                                    | Cleanup finding                                                                                                                                                      | Assessment                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Codex       | History fetched on demand; no ordinary full-history mirror found. 16 MiB frames and 32 MiB queued stdin are bounded. Runtime event queues remain count-based.       | Spontaneous-exit and discovery cleanup failures retain ownership but have no automatic retry. Callback teardown could hang with a full downstream queue; fixed here. | Better bounded history, but not fully qualified.                           |
| Claude      | Complete raw user/assistant/tool-result history grows for the live session; compaction does not prune Synara's copy. Prompt/steering admission is not byte-bounded. | Failed installation could lose process ownership; fixed here. Hung temporary discovery and interruption during asynchronous creation still need ownership work.      | Confirmed remaining memory and process risks.                              |
| Cursor      | Completed prompt history includes image data. Normal finished tool states are evicted by ACP; abandoned ones can remain.                                            | A stopped flag plus one-shot scope closure prevents a failed teardown from being retried.                                                                            | Shared ACP admission fixed; process ownership remains unresolved.          |
| Grok        | Same ACP prompt-history and abandoned-tool exposure.                                                                                                                | Same stopped/scope retry defect as Cursor.                                                                                                                           | Shared ACP admission fixed; process ownership remains unresolved.          |
| Droid       | Same ACP history exposure; several turn-local maps reset correctly.                                                                                                 | Teardown gate reports success even when process cleanup fails and can lose the removed owner.                                                                        | Shared ACP admission fixed; process ownership remains unresolved.          |
| Devin       | Complete prompt parts, including image data, accumulate in retained history. Active tool state generally clears correctly.                                          | Same one-shot scope/retry trap; small recovery-budget registry also grows by historical thread.                                                                      | Shared ACP admission fixed; process ownership remains unresolved.          |
| Pi          | Successive cumulative tool outputs were appended forever; fixed here. SDK history and completed Synara snapshots still grow with conversation length.               | Explicit stop retains failed process owners, but a normally exited shell root is forgotten before background descendants are proven gone.                            | Duplicate streaming snapshots fixed; total session memory is not constant. |
| OpenCode    | Earlier unused turn-history fix is valid. Full historical tool parts and serialized comparison keys still duplicate content.                                        | Interrupted courtesy abort can leave the scope open; the stopped flag makes a retry skip cleanup.                                                                    | Additional retained-history and ownership work required.                   |
| Antigravity | Unbounded stdout/stderr, overlapping transcript copies, and whole unread-file allocations. It uses print mode rather than the ACP SDK.                              | Failed interruption can discard the only active-child reference and permit a replacement.                                                                            | Significant remaining output and ownership risks.                          |

## Implemented and regression-tested in this follow-up

### Pi: keep one tool snapshot per call

`apps/server/src/provider/Layers/PiAdapter.ts` now indexes a turn's tool records by call ID. Start, update, and completion replace the previous snapshot for that call while preserving arguments and final output. Separate tool calls and turns remain distinct; rollback IDs and native leaf IDs remain unchanged.

The installed Pi SDK's Bash tool sends cumulative output snapshots, so the old append behavior retained obsolete copies during long commands. A regression uses the real Pi session/agent lifecycle with mocked model transport and 64 cumulative updates. It asserts one current record, the final 64 KiB output, preserved command arguments, terminal output, cancellation, and a subsequent turn. This measures retained records, not whole-process RSS.

### Shared ACP: bound notification admission before promise creation

`apps/server/src/provider/acp/AcpNotificationDispatcher.ts` replaces the unbounded notification promise chain used by `AcpSessionRuntime.ts`. Admission synchronously counts both queued and executing notifications, with **2,048 notifications / 32 MiB of serialized payloads** limits. Overflow closes the connection with an explicit transport error and cancels handlers; it does not silently omit updates and pretend the prompt succeeded.

Scope closure also cancels callback execution, shuts queues, and releases pending epoch/tool state. Tests cover byte/count overflow, normal ordering, accounting after failure, actual SDK overflow during a pending prompt, and scope closure while a handler is blocked.

The 32 MiB limit accounts for serialized payload bytes in this callback backlog; JavaScript objects, strings, and allocator overhead can consume more physical memory. It is not a total ACP or Synara memory ceiling.

### Claude: retain ownership after failed installation

`apps/server/src/provider/Layers/ClaudeAdapter.ts` now uses the same retain-on-failure cleanup path when Auto-mode validation fails after spawning but before a session is installed. Explicit stop also retries a failed-start owner when there is no routable session.

The regression rejects installation, fails two teardown attempts, proves no replacement is created, then verifies explicit stop retries successfully and subsequent stops are idempotent.

### Shared callbacks: release blocked buffers during owner shutdown

`boundedCallbackIngress.ts` now distinguishes draining accepted work (`stop`) from cancelling work when the owner closes (`abort`). Scope finalization releases queued references and interrupts a blocked producer. Codex uses this cancellation path during layer teardown. A regression saturates the downstream queue, removes its consumer, and proves scope closure completes.

This is a teardown cancellation fix. It does not establish lossless whole-service shutdown: accepted events may still be discarded when producer/consumer scopes close. A graceful delivery barrier remains separate work.

### Shared callbacks: protect resource-settlement events

`providerRuntimeEventIngress.ts` now reserves capacity for aborted turns, completed tasks, and task updates that settle runtime ownership (completed/failed/killed/paused). Previously these could be dropped under pressure while the service continued believing a background task was live, preventing idle retirement. A saturated-ingress regression covers each status.

## Remaining high-priority work

1. **Unify retryable ACP process ownership before addressing stopped flags individually.** Cursor/Grok/Devin mark stopped before closing a scope; Droid unconditionally succeeds its teardown gate. Re-closing an Effect scope does not rerun failed finalizers. Ownership must be registered immediately after spawn, survive failed startup and scope closure, retain an explicit retryable teardown operation, and block replacement until success. Removing a stopped guard alone is not a fix.
2. **Preserve Antigravity and Pi descendant ownership.** Antigravity must retain interrupted-but-live children separately from logical turn state. Pi must keep process-group ownership after a shell root exits, while preserving intended background-command behavior. Post-exit PPID scanning alone cannot prove descendant cleanup.
3. **Finish OpenCode retention and interruption cleanup.** Fixed-size comparison fingerprints can replace retained JSON strings. Retained tool bodies can be reduced after verifying every replay/watchdog consumer. Keep late text deduplication correct; clearing all text state at turn completion is unsafe without stronger regressions. Courtesy abort must be bounded and cannot own the only path to releasing the scope.
4. **Replace full in-memory history mirrors deliberately.** Claude and ACP snapshots are exposed by adapter `readThread`, even though current production imports mainly use native history APIs. Do not silently truncate these contracts. A native reader with stable turn mapping or persisted history can release raw tool results and base64 images without losing history or rollback behavior. Stopped contexts can release unused payloads separately from retained process proof.
5. **Add end-to-end byte-aware admission.** Most adapter queues and the service event bus permit 2,048 events each without accounting for bytes. A 32 MiB callback limit does not cover data already transferred downstream. Claude prompt/steering queues and optional logging buffers require the same audit. Lifecycle and human-approval events must retain reliable delivery semantics.
6. **Retry spontaneous and discovery cleanup automatically.** The current service preserves a retry already owned by idle cleanup. An unexpected exit without that ownership clears the timer; a retained non-routable Codex context can escape automatic reaping. Discovery processes have an analogous gap. Retry must remain tied to the original lifecycle identity so stale events cannot kill a replacement.
7. **Bound Antigravity and ACP diagnostic reads.** Antigravity accumulates raw output and reads an entire unread transcript range. ACP stderr splits into lines without limiting an unterminated line. Bound diagnostics and file chunks; protocol overflow must fail explicitly rather than truncating JSON into apparent success.

## Lower-priority retained state and performance findings

- ACP interrupted tools missing terminal updates remain in `toolCallsRef` across prompts; clean payloads at an ownership-safe boundary without losing background-task provenance.
- Shared ACP thread-lock maps retain every historical thread and copy the whole map when adding a lock. Reference-count both holders and waiters, then evict after the last release.
- Devin's recovery timestamps and the service's latest-cursor map retain historical thread keys. Preserve rate-limiting/shutdown semantics when adding expiry.
- Optional native-event logging retains per-thread writers and batched logging fibers for the logger's lifetime. This is configuration-dependent, not evidence about every affected user.
- Claude workflow parsing can repeatedly reread a line larger than its 512 KiB chunk without advancing, even though the file is below its 5 MiB limit. This is allocation/I/O churn and stalled metadata, not an unbounded heap.
- Several caches and tombstone maps are intentionally bounded by count or retained for late-event safety. Their existence alone does not prove a leak, and arbitrary eviction can resurrect completed tasks.

## Reproductions and limits

Independent read-only probes established mechanisms using the installed SDK/Effect library and source helpers:

| Probe                              | Observed behavior                                                                                                                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Original ACP SDK callback dispatch | 128 valid 64 KiB notifications admitted while zero blocked handlers completed.                                                            |
| Effect scope cleanup retry         | First close failed; second close succeeded; finalizer executed only once.                                                                 |
| Droid teardown gate                | Teardown failed, gate disappeared, awaiting stop reported success.                                                                        |
| OpenCode historical tool mirror    | 1,000 completed 64 KiB tool outputs retained 62.5 MiB payload plus 62.71 MiB JSON keys; isolated measured heap increase about 126.15 MiB. |
| OpenCode interrupted stop          | Abort called once; retry finalized zero session scopes.                                                                                   |
| Downstream event queue             | 64 one-MiB deltas occupied about 64.01 MiB while upstream queued-byte accounting was zero.                                                |

These are synthetic mechanism probes, not production memory totals or new before/after whole-app benchmarks. The checked-in regressions cover the implemented changes; unresolved probes are findings requiring their own implementation and regression work.

## Validation

- **1,065 tests passed; 5 skipped** across 44 provider/runtime test files (43 passed, one skipped). All nine adapter suites, shared ACP tests, provider lifecycle tests, Codex manager/transport, and the new regressions were included.
- The separately isolated provider-health refresh test also passed (**1 additional test**).
- **`bun fmt`, `bun lint`, and `bun typecheck` passed.** Lint reported 528 warnings and zero errors; typechecking completed all seven workspace packages. Formatting changed only files from this follow-up.
- The first broad integration run encountered sandbox-denied scratch creation/process inspection and a health-test timeout. It was stopped, its test processes were verified gone, and the relevant suite was rerun with normal process visibility. No source change was needed for those environment failures; the isolated health test passed on rerun.
- Four new regression tests were also exercised against the pre-fix sources: all failed, including the shutdown hang and 65 retained Pi tool records instead of one. The deliberate failing run timed out at its driver; source files were restored in a `finally` block and the remaining test runner subsequently exited. The final successful run uses the restored fixes.
- Raw command/results: [provider-validation.txt](provider-validation.txt); deliberately failing historical regressions: [provider-regressions-before.txt](provider-regressions-before.txt).
- No full app build, packaged-provider soak, commit, push, deployment, or release has been performed.

Passing tests validate the targeted fixes; they do not disprove the unresolved ownership and history findings above. Several existing tests do not model those failures, and one Antigravity test explicitly permits a replacement after failed interruption cleanup.

To establish user-facing reliability after the remaining fixes, run repeated large-tool-output, image, cancellation, failed-startup, reconnect, idle, and shutdown cycles for every provider. Measure post-GC retained memory, owned descendants, queued bytes, and cleanup failures over time. Repeat the affected workload in the packaged Electron/Node runtime on 16 GiB hardware. A source audit and passing mock/in-memory tests cannot establish that external provider binaries never leak.
