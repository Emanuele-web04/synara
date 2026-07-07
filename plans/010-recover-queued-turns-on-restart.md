# Plan 010: Recover queued-but-unstarted turns across a server restart

> **Executor instructions**: This plan is **investigate-first**. Phase 1 produces
> a short written design note and ends with a mandatory STOP-and-report. Do NOT
> begin Phase 2 implementation until the operator confirms the approach. Run every
> verification command and confirm the expected result before moving on. When
> done with an approved phase, update the status row for this plan in
> `plans/README.md`.
>
> **Drift check (run first)**:
> `git diff --stat d94f416d9..HEAD -- apps/server/src/orchestration/Layers/ProviderCommandReactor.ts apps/server/src/orchestration/startupTurnReconciliation.ts apps/server/src/orchestration/decider.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d94f416d9`, 2026-07-07

## Why this matters

When a thread already has an active turn running, additional user messages are
**queued** to dispatch afterward. That queue lives exclusively in an in-memory
`Map` in the reactor (`queuedTurnStartsByThread`), populated from the live-only
`thread.turn-queued` intent event. It is never persisted, and startup
reconciliation only heals turns that were already _running_ at crash time — not
merely queued ones. So if the server restarts (deploy, crash, update) while a
thread has queued turns behind an active turn, those queued turns vanish forever:
the underlying user message stays durably persisted and visible in the UI, but
nothing ever dispatches it. The thread is silently "stuck" and the user must
notice and manually resend. This violates the "reliability first" / "predictable
behavior during failures (session restarts)" priorities in `CLAUDE.md`.

## Current state

### The in-memory queue (no persistence)

`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:293-295`:

```ts
const queuedTurnStartsByThread = new Map<
  ThreadId,
  Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
>();
```

Mutated only by plain `Effect.sync` Map operations
(`ProviderCommandReactor.ts:447-499`): `enqueueQueuedTurnStart`,
`dequeueQueuedTurnStart`, `removeQueuedTurnStart`, `hasQueuedTurnStart`. No
persistence, no rehydration (`grep -n "rehydrat\|restoreQueued\|bootstrapQueued"
apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` → no matches).

### Where the queue decision is made

`apps/server/src/orchestration/decider.ts:1146` emits
`thread.turn-queued` (vs `thread.turn-start-requested`) when a turn should queue.

**Premise correction (2026-07-07, after Phase 1 investigation — supersedes the
original claim that this event is intent-only):** `thread.turn-queued` IS a
durably persisted event. It appears at `packages/contracts/src/orchestration.ts:1365`
inside `OrchestrationEventType` (the persisted event union), and
`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:398` appends every
decided event — including `thread.turn-queued` — to the event store via
`eventStore.append`. HOWEVER, `apps/server/src/orchestration/projector.ts` has a
`case "thread.turn-start-requested"` (line 648) but **no case for
`thread.turn-queued`** — it falls through to the no-op `default` (line 1057). A
user message's `turnId` is set to `null` at creation and is never stamped
afterward. **Consequence**: the durable event exists in the log, but the
projection cannot today distinguish "queued but never dispatched" from
"dispatched" — so a pure planner over projection state (Option A) would risk
double-dispatch. This makes **Option B the approved approach** (see Phase 2).

The reactor still consumes the live intent via `Stream.fromPubSub(eventPubSub)`
(live-only, no replay) into the in-memory map — that is why a restart loses the
queue even though the event is in the log.

### The existing restart-heal pattern to mirror

`apps/server/src/orchestration/startupTurnReconciliation.ts` runs once at boot,
after projection bootstrap and before accepting client commands. It is built as a
**pure planner** — `planRestartTurnReconciliation({ threads, now })` returns an
array of `OrchestrationCommand`s — with focused unit tests in
`startupTurnReconciliation.test.ts` (the planner is tested in complete isolation
using `makeThread`/`makeSession` fixtures). `needsRestartReconciliation`
(lines ~81-87) decides which threads need healing based purely on persisted
projection state. This is exactly the shape a queued-turn recovery should take:
a pure planner over durable projection state that emits commands to re-enqueue or
re-dispatch orphaned queued turns.

The critical open question: **queued turns leave no durable "queued" marker**, so
recovery must derive "this user message was accepted but never dispatched" from
whatever durable state DOES exist (persisted messages/turns), without
double-dispatching anything that actually did run.

## Commands you will need

| Purpose              | Command                                                                                  | Expected on success |
| -------------------- | ---------------------------------------------------------------------------------------- | ------------------- |
| Reactor tests        | `cd apps/server && bun run test src/orchestration/Layers/ProviderCommandReactor.test.ts` | all pass            |
| Reconciliation tests | `cd apps/server && bun run test src/orchestration/startupTurnReconciliation.test.ts`     | all pass            |
| Typecheck            | `cd apps/server && bun run typecheck`                                                    | exit 0, no errors   |
| Full suite           | `bun run test`                                                                           | all pass            |

Repo rule (`AGENTS.md`): use `bun run test`, never `bun test`.

## Scope

**In scope (Phase 2, Option B approved)**:

- `apps/server/src/orchestration/projector.ts` — add a `case "thread.turn-queued"`
  and clear-on-start logic.
- The projected-thread-shell schema file that defines the per-thread projection
  shape (find it from where the projector writes the shell / where
  `ProjectionSnapshotQuery` reads it) — add the safely-defaulted queued-turns field.
- `apps/server/src/orchestration/startupTurnReconciliation.ts` — add the sibling
  `planQueuedTurnRecovery` planner, and wire it into the same boot stage. Update
  `startupTurnReconciliation.test.ts`.
- Whatever boot wiring invokes `planRestartTurnReconciliation` (so the new planner
  runs alongside it).
- No brand-new durable event or table is needed — the `thread.turn-queued` event
  already exists; this only adds projection state derived from it.

**Out of scope**:

- Changing the queueing _policy_ in `decider.ts` (when to queue vs start). This
  plan recovers existing queued turns; it does not change queue semantics.
- The `startupTurnReconciliation` running-turn healing behavior — do not alter how
  already-running orphaned turns are reconciled.
- Any UI change. Recovery is server-side; the UI already shows the durable message.

## Phase 1 — Investigation (do this first, then STOP)

Answer these questions by reading code and existing tests, and write the answers
into a new file `plans/010-design-note.md`:

1. **What durable state exists for a queued-but-unstarted user message?** Trace a
   user message from acceptance through the decider. When `decider.ts:1146` emits
   `thread.turn-queued`, what durable event(s)/projection row(s) are written for
   that message (if any)? Is the message persisted with a turn id, or with no turn
   at all? Read the projection tables / event handlers to determine what a booted
   projection would show for a message that was queued but never dispatched.

2. **Can "queued but never dispatched" be distinguished from "dispatched and
   completed/failed" using only durable state?** Identify the exact predicate. If
   yes, this is a pure-planner problem like `startupTurnReconciliation`. If no, a
   durable queue marker must be added (option B below).

3. **Idempotency**: what prevents re-enqueuing a message that actually did run
   after restart? Note the existing `hasQueuedTurnStart`/`removeQueuedTurnStart`
   guards and how a recovery path would avoid double-dispatch.

Based on the answers, the design is one of:

- **Option A (preferred, if Q2 = yes)**: a pure planner
  `planQueuedTurnRecovery({ threads, now })` alongside
  `planRestartTurnReconciliation`, run at the same boot point, emitting the same
  `thread.turn-start-requested`/enqueue commands for messages that are durably
  "accepted but never dispatched." No new persistence. Mirrors the existing
  tested planner pattern exactly.
- **Option B (if Q2 = no)**: persist queued-turn intents durably (append a
  `thread.turn-queued` domain event to the log, or a small queue table) so the
  reactor can rehydrate `queuedTurnStartsByThread` at boot. Higher blast radius;
  needs a schema/migration decision.

**STOP and report**: write `plans/010-design-note.md` with the answers to Q1–Q3,
the chosen option (A or B) with justification, and the concrete file-level plan
for Phase 2. Do not implement until the operator approves the option — Option B in
particular changes the persistence contract and must not be chosen unilaterally.

## Phase 2 — Implementation (Option B APPROVED 2026-07-07)

**Approved approach — Option B (project the existing durable event):** The
`thread.turn-queued` event is already persisted; the gap is that it is not
projected and cannot be queried at boot. Phase 2:

1. **Add a queued-turns field to the projected thread shell**, defaulted safely
   for old rows (a thread with no field decodes as "no queued turns" — see the
   "decode old JSON safely" guardrail in `plans/README.md`). Model the schema
   addition on how the projection already carries other per-thread lists; keep it
   minimal (enough to re-dispatch: the queued message id(s) and dispatch mode /
   ordering that `enqueueQueuedTurnStart` at `ProviderCommandReactor.ts:452-456`
   encodes).
2. **Teach `projector.ts` to handle `thread.turn-queued`** (add a `case` beside
   the existing `case "thread.turn-start-requested"` at line 648): append the
   queued turn to the new field. It must be **cleared** when the turn is
   withdrawn or actually starts — see the two corrections below for exactly which
   events clear it.
3. **Rehydrate the queue and drain one-at-a-time (NOT fire-all).** See the
   "Correction A" box below — recovery must re-populate the reactor's in-memory
   queue and let the normal single-dispatch gate drain it, rather than emitting a
   dispatch command per queued turn.

> **Correction A (added after PR review — serialization) — comment #4.**
> An earlier draft had `planQueuedTurnRecovery` emit a dispatch/enqueue command
> for **every** queued turn at boot. That is wrong: the reactor promotes queued
> turns strictly one at a time via `dequeueQueuedTurnStart`
> (`ProviderCommandReactor.ts:1531`), only starting the next after the current
> provider turn settles. Firing N dispatch commands at boot bypasses that gate and
> can promote several messages concurrently before the first turn opens its
> provider thread. Instead, recovery must **rehydrate** the in-memory
> `queuedTurnStartsByThread` map from the projected `queuedTurns` (in original
> order, honoring the steer/queue ordering `enqueueQueuedTurnStart` encodes at
> `ProviderCommandReactor.ts:452-456`) and then kick the normal drain so only the
> head dispatches; the rest wait behind it exactly as they would have pre-restart.
> Make the serialization guarantee testable: a restart with 3 queued turns behind
> a killed active turn must result in exactly one provider-turn start, not three.
> If the reactor has no public entry point to rehydrate + drain, add a minimal one
> rather than fanning out dispatch commands.

> **Correction B (added after PR review — do not clear on the request event) —
> comment #6.** Clearing the `queuedTurns` entry when `thread.turn-start-requested`
> is *projected* is premature. `turn-start-requested` is a request; the reactor
> still has to run `processTurnStartRequested` to actually open the provider turn.
> If the server crashes AFTER that event is appended but BEFORE the provider turn
> starts, then on restart: the in-memory queue is empty (rebuilt), no session is
> "running" so `planRestartTurnReconciliation` won't catch it, and if
> `queuedTurns` was already cleared the message vanishes with nothing to recover
> it. Therefore clear the durable `queuedTurns` entry only on a durable event that
> **proves the turn actually started** (the turn-running/turn-started marker — find
> where the projection sets `session.activeTurnId`/marks the latest turn
> `running`), NOT on `thread.turn-start-requested`. Equivalently: a turn that is
> "requested but not yet running" must remain in `queuedTurns` so recovery
> re-drives it. Keep the withdrawal clears (revert / rollback / edit-resend) as
> already specified. Add a test for the crash-between-request-and-start window:
> a thread with `turn-start-requested` projected but no running turn still has its
> entry in `queuedTurns` and is recovered.

4. **Add the recovery entry point** (replacing the old "pure planner emits
   commands" step per Correction A): at the same boot stage as
   `planRestartTurnReconciliation` (after projection bootstrap, before accepting
   client commands), read each thread's projected `queuedTurns` and rehydrate +
   drain-head through the reactor. Keep the decision logic (which threads/turns to
   rehydrate, in what order) in a pure, unit-tested function with fixtures, exactly
   like `startupTurnReconciliation.test.ts`; the impure part is only the
   rehydrate+kick call into the reactor.

General requirements regardless of option:

- Reuse the pure-planner + isolated-unit-test pattern of
  `startupTurnReconciliation.ts` / `.test.ts`. Any recovery decision logic must be
  a pure function tested with fixtures (no live runtime in the unit test).
- Recovery must be **idempotent**: running it twice (or a message that actually
  ran) must not double-dispatch. Add an explicit test for this.
- Recovery must run at the same boot stage as `startupTurnReconciliation` (after
  projection bootstrap, before accepting client commands) so recovered turns
  dispatch through the normal path.
- If Option B adds durable state, it MUST decode pre-existing rows/events safely
  (old data with no queue records must not crash boot) — see the "Preserve
  existing automation rows / decode old JSON safely" guardrail in
  `plans/README.md`.

**Verify** (Phase 2): `cd apps/server && bun run test
src/orchestration/startupTurnReconciliation.test.ts
src/orchestration/Layers/ProviderCommandReactor.test.ts` → all pass, including new
recovery + idempotency cases. `cd apps/server && bun run typecheck` → exit 0.

## Test plan

- Phase 2 unit tests, following `startupTurnReconciliation.test.ts` fixtures:
  - A thread with an active turn + one durably-recoverable queued message → plan
    emits exactly one recovery command for that message.
  - A thread whose queued message actually ran (durable state shows dispatch) →
    plan emits nothing (idempotency / no double-dispatch).
  - Multiple queued messages recovered in original order (respecting steer/queue
    ordering that `enqueueQueuedTurnStart` encodes at lines 452-456).
  - Empty/clean thread set → empty plan.
- Structural pattern: `apps/server/src/orchestration/startupTurnReconciliation.test.ts`.

## Done criteria

Phase 1:

- [ ] `plans/010-design-note.md` exists with Q1–Q3 answered and Option A/B chosen with justification.
- [ ] Operator approval recorded before any Phase 2 code change.

Phase 2 (after approval), ALL must hold:

- [ ] `cd apps/server && bun run typecheck` exits 0.
- [ ] `bun run test` exits 0; new recovery + idempotency tests exist and pass.
- [ ] A pure planner function for queued-turn recovery exists and is unit-tested in isolation.
- [ ] Recovery runs at boot before client commands are accepted.
- [ ] `bun run fmt` and `bun run lint` pass (final validation pass).
- [ ] No files outside the approved in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for 010 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- End of Phase 1 (mandatory) — do not implement without approval.
- Q2's answer is "no" (needs durable state) — Option B changes the persistence
  contract; get explicit approval and a migration-safety decision first.
- The excerpts in "Current state" do not match the live code (drift).
- You cannot determine from durable state whether a queued message ran — recovery
  cannot be made idempotent without that; report the gap.
- Recovery would require changing `decider.ts` queue policy — that is out of scope.

## Maintenance notes

- If Option A is chosen, note that it depends on the durable message/turn shape;
  any future change to how queued messages are persisted must revisit the recovery
  predicate.
- If Option B is chosen, the durable queue record becomes part of the event/schema
  contract — document it where other durable orchestration events are documented.
- Reviewer should scrutinize idempotency above all: a recovery that double-runs a
  turn is worse than the bug it fixes.
- Related: `startupTurnReconciliation` handles running-turn orphans; this is its
  queued-turn counterpart. Keep the two planners consistent in style and boot
  ordering.
