/**
 * startupTurnReconciliation - heal restart-orphaned turns at server boot.
 *
 * Provider runtimes (Codex app-server, ACP children, etc.) are purely
 * in-memory: every one of them dies with the server process. A turn only
 * leaves the "running" state when its runtime emits a terminal event, so any
 * turn that was still in flight when the process exited has no surviving runtime
 * to ever complete it. After a restart its persisted projection rows still say
 * `session.status = "running"` / `activeTurnId != null` / `latestTurn = running`,
 * and the UI shows "Working" forever (observed in the wild as multi-hour stuck
 * turns).
 *
 * `projectionPipeline.bootstrap` faithfully replays the event log into the
 * projection tables, so it restores that stale "running" state verbatim — it is
 * not its job to second-guess history. This module runs once, immediately after
 * bootstrap and before the server starts accepting client commands, and emits
 * stale pending-request failure activities plus a terminal
 * `thread.session.set { status: "interrupted", activeTurnId: null }` for each
 * orphaned thread. That reuses the normal event-sourced path: activity handlers
 * resolve dead approval/user-input requests, and the projection's session-set
 * handler closes the newest still-open turn (`finalizeTurnStateFromSessionStatus`
 * → "interrupted", with `completedAt`), so the UI clears blocked composers and
 * spinners instead of hanging.
 *
 * The runtime idle watchdog (AcpTurnIdleWatchdog) only protects turns started in
 * the *current* process; this is its restart-time counterpart for turns
 * orphaned by a process boundary the watchdog never saw.
 *
 * @module startupTurnReconciliation
 */
import type {
  OrchestrationCommand,
  OrchestrationQueuedTurn,
  OrchestrationThreadActivity,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { CommandId, EventId } from "@t3tools/contracts";
import {
  buildStalePendingRequestFailureDetail,
  derivePendingThreadRequestIds,
  type PendingThreadRequestKind,
} from "@t3tools/shared/threadSummary";
import { Effect, Option } from "effect";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/** The `thread.session.set` variant of the internal orchestration command union. */
type ThreadSessionSetCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.session.set" }
>;
type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;
type RestartReconciliationCommand = ThreadSessionSetCommand | ThreadActivityAppendCommand;
type ThreadDispatchQueuedTurnCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.turn.dispatch-queued" }
>;

/** Minimal persisted thread shape the planner inspects (a superset is fine). */
export interface ReconcilableThread {
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: { readonly state: "running" | "interrupted" | "completed" | "error" } | null;
  readonly activities?: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
  readonly queuedTurns?: ReadonlyArray<OrchestrationQueuedTurn> | undefined;
}

/**
 * True when a thread's persisted state implies a turn that only a now-dead
 * in-process runtime could ever advance:
 *  - the session still points at an active turn,
 *  - the session itself is mid-lifecycle ("starting"/"running"), or
 *  - the latest turn projection is still open ("running").
 *
 * A clean session (idle/ready/interrupted/stopped/error with no active turn and
 * no open turn) is left untouched — it is not showing "Working".
 */
function needsRestartReconciliation(thread: ReconcilableThread): boolean {
  const session = thread.session;
  const hasActiveTurn = session?.activeTurnId != null;
  const sessionInFlight = session?.status === "running" || session?.status === "starting";
  const latestTurnRunning = thread.latestTurn?.state === "running";
  return hasActiveTurn || sessionInFlight || latestTurnRunning;
}

function planStalePendingRequestCommands(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ReadonlyArray<ThreadActivityAppendCommand> {
  const pendingRequestIds = derivePendingThreadRequestIds({
    activities: input.thread.activities ?? [],
  });
  const commands: ThreadActivityAppendCommand[] = [];
  for (const requestId of pendingRequestIds.approvalRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "approval",
        requestId,
      }),
    );
  }

  for (const requestId of pendingRequestIds.userInputRequestIds) {
    commands.push(
      buildStalePendingRequestCommand({
        threadId: input.thread.id,
        now: input.now,
        requestKind: "user-input",
        requestId,
      }),
    );
  }

  return commands;
}

function buildStalePendingRequestCommand(input: {
  readonly threadId: ThreadId;
  readonly now: string;
  readonly requestKind: PendingThreadRequestKind;
  readonly requestId: string;
}): ThreadActivityAppendCommand {
  const commandKey = [
    "restart-reconcile",
    input.threadId,
    input.requestKind,
    input.requestId,
    input.now,
  ].join(":");
  const isApproval = input.requestKind === "approval";
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(commandKey),
    threadId: input.threadId,
    activity: {
      id: EventId.makeUnsafe(commandKey),
      tone: "error",
      kind: isApproval ? "provider.approval.respond.failed" : "provider.user-input.respond.failed",
      summary: isApproval
        ? "Provider approval response failed"
        : "Provider user input response failed",
      payload: {
        detail: buildStalePendingRequestFailureDetail(input.requestKind, input.requestId),
        requestId: input.requestId,
      },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

/**
 * Pure planner: maps persisted threads to stale-request resolution commands and
 * terminal `thread.session.set` commands. Extracted from the effectful runner so
 * the reliability-critical selection logic is unit-testable without a database,
 * clock, or engine.
 *
 * `now` is threaded in (rather than read from a clock) so the same inputs always
 * produce the same commands — including a deterministic, per-startup `commandId`
 * that lets the engine's receipt dedup treat a re-run as a no-op.
 */
export function planRestartTurnReconciliation(input: {
  readonly threads: ReadonlyArray<ReconcilableThread>;
  readonly now: string;
}): ReadonlyArray<RestartReconciliationCommand> {
  const commands: RestartReconciliationCommand[] = [];
  for (const thread of input.threads) {
    if (!needsRestartReconciliation(thread)) {
      continue;
    }
    commands.push(...planStalePendingRequestCommands({ thread, now: input.now }));
    commands.push({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(`restart-reconcile:${thread.id}:${input.now}`),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "interrupted",
        providerName: thread.session?.providerName ?? null,
        // Prefer the session's own mode; fall back to the thread default when the
        // thread never had a materialized session row.
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        // "interrupted" is a clean stop, not an error: no lastError banner.
        lastError: null,
        updatedAt: input.now,
      },
      createdAt: input.now,
    });
  }
  return commands;
}

/**
 * Builds the `thread.turn.dispatch-queued` command that re-drives a single
 * durably-queued turn, carrying over every field from the original
 * `thread.turn-queued` payload untouched (same messageId, model selection,
 * provider options, review target, delivery mode, dispatch mode, runtime/
 * interaction mode, source proposed plan). `createdAt` is the recovery run's
 * `now`, not the original queue time, since this is a new command.
 */
function buildQueuedTurnRecoveryCommand(input: {
  readonly threadId: ThreadId;
  readonly queued: OrchestrationQueuedTurn;
  readonly now: string;
}): ThreadDispatchQueuedTurnCommand {
  const { threadId, queued, now } = input;
  const commandKey = ["restart-reconcile-queued-turn", threadId, queued.messageId, now].join(":");
  return {
    type: "thread.turn.dispatch-queued",
    commandId: CommandId.makeUnsafe(commandKey),
    threadId,
    messageId: queued.messageId,
    ...(queued.modelSelection !== undefined ? { modelSelection: queued.modelSelection } : {}),
    ...(queued.providerOptions !== undefined ? { providerOptions: queued.providerOptions } : {}),
    ...(queued.reviewTarget !== undefined ? { reviewTarget: queued.reviewTarget } : {}),
    ...(queued.assistantDeliveryMode !== undefined
      ? { assistantDeliveryMode: queued.assistantDeliveryMode }
      : {}),
    dispatchMode: queued.dispatchMode,
    runtimeMode: queued.runtimeMode,
    interactionMode: queued.interactionMode,
    ...(queued.sourceProposedPlan !== undefined
      ? { sourceProposedPlan: queued.sourceProposedPlan }
      : {}),
    createdAt: now,
  };
}

/**
 * Pure planner: recovers turns that were durably queued (`thread.turn-queued`)
 * but never dispatched (`thread.turn-start-requested` for the same
 * `messageId`) before the process died — otherwise the underlying user
 * message is stuck behind a queue that no in-memory reactor will ever drain
 * again, since `ProviderCommandReactor`'s queue map is rebuilt empty on
 * restart.
 *
 * Idempotent by construction: the projection clears a thread's `queuedTurns`
 * entry the moment the matching `thread.turn-start-requested` is projected
 * (see `ProjectionPipeline.ts` / `projector.ts`), so a queued turn that
 * already dispatched is simply absent here and never re-dispatched. Order is
 * preserved per thread (oldest queued first), matching
 * `enqueueQueuedTurnStart`'s FIFO drain order.
 */
export function planQueuedTurnRecovery(input: {
  readonly threads: ReadonlyArray<ReconcilableThread>;
  readonly now: string;
}): ReadonlyArray<ThreadDispatchQueuedTurnCommand> {
  const commands: ThreadDispatchQueuedTurnCommand[] = [];
  for (const thread of input.threads) {
    for (const queued of thread.queuedTurns ?? []) {
      commands.push(
        buildQueuedTurnRecoveryCommand({ threadId: thread.id, queued, now: input.now }),
      );
    }
  }
  return commands;
}

/**
 * Reconcile restart-orphaned turns once at boot.
 *
 * Reads the command read model (post-bootstrap projection state), hydrates only
 * stuck thread details to discover stale human requests, and dispatches the
 * resulting cleanup commands. Every failure mode is contained and logged: a
 * failed snapshot read or a failed individual dispatch must never block the
 * server from coming up.
 */
export const reconcileRestartStuckTurns: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery
> = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const readModel = yield* snapshotQuery.getCommandReadModel().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("restart turn reconciliation skipped: failed to read command snapshot", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (readModel === null) {
    return;
  }

  const now = new Date().toISOString();
  const stuckThreads = readModel.threads.filter(needsRestartReconciliation);
  if (stuckThreads.length === 0) {
    return;
  }

  const reconcilableThreads = yield* Effect.forEach(
    stuckThreads,
    (thread) =>
      snapshotQuery.getThreadDetailById(thread.id).pipe(
        Effect.map((detail) => Option.getOrElse(detail, () => thread)),
        Effect.catchCause((cause) =>
          Effect.logWarning("restart turn reconciliation continuing without thread activities", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(thread)),
        ),
      ),
    { concurrency: 4 },
  );

  const commands = planRestartTurnReconciliation({ threads: reconcilableThreads, now });
  if (commands.length === 0) {
    return;
  }

  yield* Effect.logInfo("reconciling restart-stuck turns", {
    commandCount: commands.length,
    threadCount: stuckThreads.length,
    threadIds: stuckThreads.map((thread) => thread.id),
  });

  yield* Effect.forEach(
    commands,
    (command) =>
      engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to reconcile restart-stuck turn", {
            threadId: command.threadId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
});

/**
 * Recover durably-queued-but-undispatched turns once at boot.
 *
 * `ProviderCommandReactor`'s in-memory queue (`queuedTurnStartsByThread`) is
 * rebuilt empty on every process start, so a turn that was queued
 * (`thread.turn-queued`) but never reached the front of that queue before the
 * process died would otherwise sit behind its user message forever — no
 * runtime is ever going to drain it. The projection's `queuedTurns` field
 * (cleared the instant a queued turn actually dispatches — see
 * `ProjectionPipeline.ts`) is exactly the durable record needed to recover it:
 * re-dispatching everything still present there is safe to run on every
 * restart, since anything that already dispatched is no longer present.
 *
 * Reads the command read model (post-bootstrap projection state, already
 * carrying `queuedTurns` on every thread) and dispatches one
 * `thread.turn.dispatch-queued` command per still-queued turn, in original
 * per-thread order. Every failure mode is contained and logged: a failed
 * snapshot read or a failed individual dispatch must never block the server
 * from coming up.
 */
export const reconcileQueuedTurnsOnRestart: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery
> = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const readModel = yield* snapshotQuery.getCommandReadModel().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("queued-turn restart recovery skipped: failed to read command snapshot", {
        cause,
      }).pipe(Effect.as(null)),
    ),
  );
  if (readModel === null) {
    return;
  }

  const now = new Date().toISOString();
  const commands = planQueuedTurnRecovery({ threads: readModel.threads, now });
  if (commands.length === 0) {
    return;
  }

  yield* Effect.logInfo("recovering restart-orphaned queued turns", {
    commandCount: commands.length,
  });

  yield* Effect.forEach(
    commands,
    (command) =>
      engine.dispatch(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to recover queued turn on restart", {
            threadId: command.threadId,
            messageId: command.messageId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );
});
