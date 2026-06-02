# Goal feature — port from pi-goal / Codex into Synara

Status: in progress (branch `features/goal`).

## What this is

An agent-agnostic "goal" feature: a user sets a persisted objective on a thread and
Synara keeps driving turns toward it until the objective is achieved (or paused /
budget-limited / cleared). This is a faithful port of:

- **Codex** `thread_goals` (`codex-rs/core/src/goals.rs`, `templates/goals/continuation.md`)
- **pi-goal** (`@ramarivera/pi-goal`, `src/index.ts`) — itself a faithful Codex clone

## Canonical completion design (Codex / pi-goal = Design A)

Both Codex and pi-goal use **self-audit, same-model completion** (Design A): the working
model decides it is done after a baked-in completion audit, then signals completion
(Codex/pi via an `update_goal` tool call). There is **no separate evaluator model**.

### Faithful adaptation for Synara

Synara _drives_ 8 provider runtimes; it does **not** own the model's tool surface
uniformly (there is no cross-provider tool injection — verified in
`ProviderRuntimeIngestion`). So the `update_goal` tool call can't be the cross-provider
completion signal. The faithful adaptation that preserves Design A (same model still
decides) is a **completion sentinel in the model's output**: the continuation prompt
instructs the model to emit a sentinel line once its completion audit passes, and a
server-side reactor detects it. Same self-audit semantics; signal is text instead of a
tool call because that is the only channel every provider exposes.

(An optional future Design B — a separate fast-model evaluator — is a deliberate
divergence from Codex canon and is intentionally _not_ part of v1.)

## Mapping onto Synara's event-sourced orchestration

| pi-goal / Codex                                              | Synara                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `GoalState` custom session entry                             | `OrchestrationGoal` on `OrchestrationThread.goal` (one per thread)                   |
| `/goal` command + `create_goal`/`update_goal` tools          | `thread.goal.*` orchestration commands                                               |
| hidden `pi-goal-continuation` user message (`display:false`) | `thread.turn.start` with `inputSource: "goal-continuation"` (the new contract field) |
| `turn_end` accounting                                        | folded on `thread.turn-diff-completed` while a goal is active                        |
| `scheduleContinuation` after `agent_end`                     | `GoalContinuationReactor` reacting to turn completion                                |
| completion audit in `continuation.md`                        | ported verbatim into the continuation prompt; completion via sentinel                |

### The "small contract field"

`OrchestrationMessageSource` gains `"goal-continuation"` (alongside
`native | handoff-import | fork-import`). `ThreadTurnStartCommand` gains optional
`inputSource`; the decider stamps it onto `thread.message-sent.source`. The web hides /
dims messages with `source === "goal-continuation"`, mirroring pi's `display:false`.

## Commands / events / state

- Commands: `thread.goal.create | pause | resume | clear | complete`.
- Events: `thread.goal-created | paused | resumed | cleared | completed`.
- `thread.goal.complete` is dispatched by the reactor on sentinel detection, and is also
  available to the user (`/goal complete`). Per Codex/pi, `complete` is the only
  model-assertable transition; pause/resume/clear stay user-controlled.
- State: `OrchestrationGoal { id, objective, status, tokenBudget, tokensUsed, usage,
  turnCount, continuationCount, timeUsedSeconds, createdAt, updatedAt }`. The no-activity
  suppression heuristic lives in the reactor (computed from thread activities), not as
  persisted goal state.

## Continuation loop & guardrails (ported from pi-goal)

`GoalContinuationReactor` observes turn-completion domain events. For a thread with an
`active` goal it reads the snapshot and:

1. If the latest assistant message contains the completion sentinel → dispatch
   `thread.goal.complete`.
2. Else, if guardrails pass → dispatch a `thread.turn.start` continuation
   (`inputSource: "goal-continuation"`, the ported continuation/audit prompt as text).

Guardrails (faithful to pi-goal):

- only continue while status is `active`;
- suppress continuation after a continuation turn that produced no tool/file activity,
  until fresh user input;
- do not continue while the thread is in plan mode (`interactionMode === "plan"`);
- budget exhaustion → `budget_limited` (terminal), no further continuation;
- never continue while a turn is already running or user input is pending.

## Fidelity notes / known gaps

- Codex injects continuation as a `developer`-role message; Synara uses a `user`-role
  message tagged `inputSource: "goal-continuation"` (closest cross-provider analog;
  better than pi's untagged user message because the UI can hide it).
- Token accounting is best-effort from provider-reported usage (same caveat pi-goal
  documents), surfaced via the turn-completion fold.
