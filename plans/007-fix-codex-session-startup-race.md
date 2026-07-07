# Plan 007: Stop concurrent Codex session starts from tearing down a different healthy session

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- apps/server/src/codexAppServerManager.ts`
> If the file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

Codex session startup and thread-forking are keyed by `threadId` in a shared
`this.sessions` map. Cleanup (both the error path and re-entrant "existing
session" teardown) looks the session up **by threadId**, not by the identity of
the context the current call created. Under concurrent `startSession`/`forkThread`
calls for the same thread — which happen on rapid reconnect/resume and during
restart reconciliation double-dispatch — a losing call's cleanup can kill a
_different, healthy, already-running_ session that a winning call installed. The
result is user-visible session death (child process killed, in-flight requests
rejected) with no legitimate cause. The OpenCode adapter already solved exactly
this with a "race winner" re-check; this plan mirrors that pattern for Codex.

## Current state

File: `apps/server/src/codexAppServerManager.ts` (~3,400 lines). The session map
is `this.sessions: Map<threadId, CodexSessionContext>` (search `this.sessions`
for the declaration).

`startSession` (around lines 760-974) does, in order:

1. Reads `const existing = this.sessions.get(threadId)`; if present, calls
   `this.stopSession(threadId)` to replace it.
2. Builds a fresh `context` object and registers it:

```ts
// apps/server/src/codexAppServerManager.ts:801-821
context = {
  session,
  account: { type: "unknown", planType: null, sparkEnabled: true },
  child,
  output,
  pending: new Map(),
  pendingApprovals: new Map(),
  pendingUserInputs: new Map(),
  collabReceiverTurns: new Map(),
  collabReceiverParents: new Map(),
  reviewTurnIds: new Set(),
  nextRequestId: 1,
  stopping: false,
};

this.sessions.set(threadId, context);
this.attachProcessListeners(context);
```

3. Runs a long `await` chain: `sendRequest(context, "initialize", …)`,
   `registerSynaraSkillsRoot`, `model/list`, `account/read`, then
   `thread/start` or `thread/resume`.
4. On error, the catch block (lines 952-973) cleans up **by threadId**:

```ts
} catch (error) {
  const message = error instanceof Error ? error.message : "Failed to start Codex session.";
  if (context) {
    this.updateSession(context, { status: "error", lastError: message });
    this.emitErrorEvent(context, "session/startFailed", message);
    this.stopSession(threadId);   // <-- kills whatever is in the map for threadId, not `context`
  } else {
    // ...emit standalone error event...
  }
  throw new Error(message, { cause: error });
}
```

The problem: between the `this.sessions.set(threadId, context)` at step 2 and the
`stopSession(threadId)` in step 4, a concurrent call B can have replaced the map
entry with its own context. Then call A's error cleanup calls
`stopSession(threadId)`, which tears down **B's** context. The same
check-then-act → set → await-chain → catch → `stopSession(threadId)` shape recurs
in `forkThread` (around lines 1366-1503).

The exemplar fix already exists in the OpenCode adapter
(`apps/server/src/provider/Layers/OpenCodeAdapter.ts:3752-3761`): after its
await-chain completes, it re-checks the map and, if another context now owns the
slot, disposes its own freshly-created session and returns the race winner
instead of overwriting:

```ts
const raceWinner = sessions.get(input.threadId);
if (raceWinner) {
  yield *
    runOpenCodeSdk("session.abort", () =>
      started.client.session.abort({ sessionID: started.openCodeSessionId }),
    ).pipe(Effect.ignore);
  yield * Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
  return raceWinner.session;
}
```

Codex uses class methods and promises (not Effect) here, so the shape is
different, but the principle is the same: **operate on the identity of the
context this call created, never blindly on the threadId slot.**

## Commands you will need

| Purpose       | Command                                                            | Expected on success          |
| ------------- | ------------------------------------------------------------------ | ---------------------------- |
| Focused tests | `cd apps/server && bun run test src/codexAppServerManager.test.ts` | all pass (71 existing cases) |
| Typecheck     | `cd apps/server && bun run typecheck`                              | exit 0, no errors            |
| Full suite    | `bun run test`                                                     | all pass                     |

Repo rule (`AGENTS.md`): use `bun run test`, never `bun test`.

## Scope

**In scope**:

- `apps/server/src/codexAppServerManager.ts` — `startSession`, `forkThread`, and
  a small private helper for identity-safe teardown.
- `apps/server/src/codexAppServerManager.test.ts` — add race/identity tests.

**Out of scope** (do NOT touch):

- `apps/server/src/provider/Layers/OpenCodeAdapter.ts` — it is the reference; read
  it, don't change it.
- `stopSession`'s public contract as used by other callers — you may add an
  identity-guarded internal variant, but do not change the behavior of the
  existing `stopSession(threadId)` for its other callers.
- Provider dispatch / orchestration — the race must be fixed inside the manager,
  not by changing who calls it.

## Git workflow

- Branch: `advisor/007-codex-session-race`
- Commit style: match `git log` (short imperative subjects). One commit per step.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add an identity-guarded teardown helper

Add a private method that only tears down a context if it still owns its slot:

```ts
private disposeIfCurrent(threadId: ThreadId, context: CodexSessionContext): void {
  if (this.sessions.get(threadId) === context) {
    this.stopSession(threadId);
  } else {
    // Another start/fork already replaced us; tear down only OUR child/process,
    // never the slot's current (healthy) owner.
    this.disposeContextResources(context);
  }
}
```

You must implement `disposeContextResources(context)` to release exactly what
`stopSession` releases for a single context **without** touching the map entry:
kill `context.child`, close `context.output` (the readline interface), reject any
`context.pending` promises, and mark `context.stopping = true`. Read the current
body of `stopSession` to enumerate precisely what it cleans up, and factor the
per-context cleanup into `disposeContextResources` so both `stopSession` and the
new helper share one implementation (avoid duplicating teardown logic — see the
repo's maintainability rule in `CLAUDE.md`). If `stopSession` already delegates
per-context cleanup to a private method, reuse that method directly.

Use the actual type names from the file for `ThreadId` / `CodexSessionContext`
(read the top of the file / the `this.sessions` declaration for the exact types).

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 2: Guard the error path in `startSession`

In the catch block (lines 952-973), replace the `this.stopSession(threadId)` call
with `this.disposeIfCurrent(threadId, context)`. Keep the surrounding
`updateSession(context, …)` and `emitErrorEvent(context, …)` calls — those act on
`context` directly and are already identity-safe. The `throw` at the end stays.

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 3: Add a race-winner re-check after the successful await chain in `startSession`

Immediately before the success return (`this.emitLifecycleEvent(context,
"session/ready", …); return { ...context.session };` at lines 949-951), add a
re-check mirroring the OpenCode pattern:

```ts
const currentOwner = this.sessions.get(threadId);
if (currentOwner && currentOwner !== context) {
  // A concurrent start won the slot while we were initializing. Tear down only
  // our own context and hand back the winner's session instead of clobbering it.
  this.disposeContextResources(context);
  return await this.awaitSessionReady(threadId, currentOwner);
}
```

Place this **after** all `await this.sendRequest(...)` calls complete and
**before** you emit `session/ready` / return, so a late finisher never overwrites
a newer session. If `context` no longer owns the slot, do not emit
`session/ready` for it.

**CRITICAL (added after PR review) — do NOT return a not-yet-ready winner.**
`startSession`'s contract is that its returned session has completed its
initialize/thread-start chain (its resolve corresponds to `session/ready`). The
race winner `currentOwner` may still be mid-initialization (status
`connecting`/`starting`, no `resumeCursor` yet). Returning `{ ...currentOwner.session }`
verbatim, as an earlier draft did, hands the caller a **half-open, unusable
session** — a follow-up turn dispatched against it fails because the provider
thread has not actually opened. You must instead wait for the winner to reach a
terminal readiness state before returning it. Implement `awaitSessionReady(threadId,
ownerContext)` to resolve with `{ ...ownerContext.session }` once that context's
session status is `ready` (and it still owns the slot), or reject/propagate if the
winner ends in `error`/is torn down. Reuse whatever readiness signal the manager
already exposes — the winner emits `session/ready` via `emitLifecycleEvent`, and
`updateSession` sets `status: "ready"`; await that transition (e.g. a per-context
readiness promise/deferred resolved when the winner sets `status: "ready"`, or a
short polling wait on `this.sessions.get(threadId)?.session.status`). If no
readiness primitive exists yet, add a minimal one on `CodexSessionContext` (e.g. a
`ready: Promise<void>` resolved where the winner currently emits `session/ready`)
and have both the winner's own success path and `awaitSessionReady` use it. STOP
and report if you cannot locate a clean readiness signal rather than returning a
`connecting` session.

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 4: Apply the same two guards to `forkThread`

`forkThread` (around lines 1366-1503) has the identical shape. Apply both:

- Replace its error-path `this.stopSession(threadId)` with
  `this.disposeIfCurrent(threadId, context)`.
- Add the same race-winner re-check before its success return.

Read the actual `forkThread` body first and match its variable names (it may name
the local context differently). If `forkThread` writes to the map under a
_different_ key than the one it cleans up on error, that is a separate bug —
STOP and report rather than guessing.

**Verify**: `cd apps/server && bun run typecheck` → exit 0.

### Step 5: Add tests

In `apps/server/src/codexAppServerManager.test.ts`, add cases (follow the
existing test's setup for constructing a manager with a mocked/faked child
process — reuse whatever spawn/stdio fake the existing 71 cases already use;
do NOT invent a new harness):

1. **Concurrent same-thread start, loser does not kill winner**: start two
   sessions for the same `threadId` where the first's await chain is delayed so
   the second finishes first; assert that after both settle, `this.sessions.get(threadId)`
   is the winner's context and the winner's child is still alive (not killed).
2. **Delayed start failure does not kill a newer session**: start A (delayed,
   then fails), start B (succeeds and installs its context); when A's catch runs,
   assert B's context still owns the slot and B's child is not killed.
3. **Normal single start still emits `session/ready` and returns the session** —
   a regression guard that the re-check does not break the common path.

If the existing harness cannot interleave two starts deterministically, assert
the helper directly instead: call `disposeIfCurrent(threadId, staleContext)`
after setting a different context in the map, and verify the map's current entry
is untouched while the stale context's child is disposed. Record which approach
you used in the test file comments.

**Verify**: `cd apps/server && bun run test src/codexAppServerManager.test.ts` → all pass (existing 71 + new cases).

## Test plan

- New cases in `apps/server/src/codexAppServerManager.test.ts` per Step 5:
  concurrent-start winner preserved, delayed-failure does not kill newer session,
  normal-start regression guard.
- Structural pattern: the existing tests in the same file (they already fake the
  Codex child process and drive `startSession`).
- Verification: `cd apps/server && bun run test src/codexAppServerManager.test.ts` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd apps/server && bun run typecheck` exits 0.
- [ ] `bun run test` exits 0; new race tests exist and pass.
- [ ] `grep -n "stopSession(threadId)" apps/server/src/codexAppServerManager.ts` shows the error-path calls in `startSession`/`forkThread` are replaced by `disposeIfCurrent` (the public `stopSession` may still be called from its own legitimate callsites).
- [ ] Per-context teardown is implemented once and shared (no copy-pasted child-kill/readline-close/pending-reject logic between `stopSession` and the new helper).
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 007 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts in "Current state" do not match the live code (drift).
- `stopSession`'s body cannot be cleanly factored into a per-context
  `disposeContextResources` without changing its behavior for other callers.
- `forkThread` writes and cleans up under mismatched map keys (a distinct bug).
- The test harness cannot fake concurrent starts AND cannot directly exercise the
  helper — report so a human can add integration coverage.

## Maintenance notes

- Any future code path that registers into `this.sessions` and then awaits before
  returning must use the same "re-check ownership by identity before mutating the
  slot" discipline. Consider documenting this invariant at the `this.sessions`
  declaration.
- Reviewer should scrutinize: that `disposeContextResources` releases the child
  process and readline handle (no orphaned processes) and that a losing call
  never emits `session/ready`/lifecycle events for a context it just discarded.
- Deferred: the `ProviderSessionReaper` has a related check-then-act gap
  (CORRECTNESS-07) — not fixed here; tracked separately.
