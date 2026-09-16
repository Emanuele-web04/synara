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
  OrchestrationPendingInteraction,
  OrchestrationThreadActivity,
  OrchestrationSession,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import { CommandId, EventId } from "@synara/contracts";
import { createStalePendingInteractionMatcher } from "@synara/shared/pendingInteractions";
import {
  buildStalePendingRequestFailureDetail,
  derivePendingThreadRequestIds,
  type PendingThreadRequestKind,
} from "@synara/shared/threadSummary";
import { Array as Arr, Effect, Option } from "effect";
import { ProjectionPendingInteractionRepository } from "../persistence/Services/ProjectionPendingInteractions.ts";

import {
  CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND,
  threadHasCheckpointRevertInProgress,
  threadHasInFlightTurn,
} from "./commandInvariants.ts";
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

/** Minimal persisted thread shape the planner inspects (a superset is fine). */
export interface ReconcilableThread {
  readonly id: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly session: OrchestrationSession | null;
  readonly latestTurn: { readonly state: "running" | "interrupted" | "completed" | "error" } | null;
  readonly activities?: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "createdAt" | "id" | "kind" | "payload" | "sequence">
  >;
  readonly pendingInteractions?:
    | ReadonlyArray<
        Pick<
          OrchestrationPendingInteraction,
          "interactionKind" | "requestId" | "lifecycleGeneration" | "status" | "createdAt"
        >
      >
    | undefined;
}

/**
 * True when a thread's persisted state implies a turn that only a now-dead
 * in-process runtime could ever advance. A clean session (idle/ready/interrupted/
 * stopped/error with no active turn and no open turn) is left untouched.
 */
function needsRestartReconciliation(thread: ReconcilableThread): boolean {
  return threadHasInFlightTurn(thread) || hasDanglingActiveTurn(thread);
}

/**
 * A session that already reports a terminal status while still naming an active
 * turn is invisible to `threadHasInFlightTurn` (its turn has been settled), but
 * the dangling `activeTurnId` keeps every "is this thread busy?" check true, so
 * the composer stays blocked and Stop stays armed with nothing to stop.
 */
function hasDanglingActiveTurn(thread: ReconcilableThread): boolean {
  return thread.session?.activeTurnId != null && !threadHasInFlightTurn(thread);
}

function planStalePendingRequestCommands(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ReadonlyArray<ThreadActivityAppendCommand> {
  const commands: ThreadActivityAppendCommand[] = [];
  if (input.thread.pendingInteractions !== undefined) {
    const isAlreadyStale = createStalePendingInteractionMatcher(input.thread.activities ?? []);
    for (const interaction of input.thread.pendingInteractions) {
      // A process restart loses every live provider callback. Pending,
      // responding, and previously retryable rows are therefore no longer
      // answerable. Uncertain user-input responses are also retryable unless
      // their callback has already been explicitly invalidated.
      if (
        interaction.status === "confirmed" ||
        isAlreadyStale(interaction) ||
        (interaction.status === "uncertain" && interaction.interactionKind === "approval")
      ) {
        continue;
      }
      commands.push(
        buildStalePendingRequestCommand({
          threadId: input.thread.id,
          now: input.now,
          requestKind: interaction.interactionKind === "approval" ? "approval" : "user-input",
          requestId: interaction.requestId,
          ...(interaction.lifecycleGeneration !== null
            ? { lifecycleGeneration: interaction.lifecycleGeneration }
            : {}),
        }),
      );
    }
    return commands;
  }

  const pendingRequestIds = derivePendingThreadRequestIds({
    activities: input.thread.activities ?? [],
  });
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

function planStaleCheckpointRevertCommand(input: {
  readonly thread: ReconcilableThread;
  readonly now: string;
}): ThreadActivityAppendCommand | null {
  if (!threadHasCheckpointRevertInProgress({ activities: input.thread.activities ?? [] })) {
    return null;
  }
  const commandKey = `restart-reconcile-checkpoint-revert:${input.thread.id}:${input.now}`;
  return {
    type: "thread.activity.append",
    commandId: CommandId.makeUnsafe(commandKey),
    threadId: input.thread.id,
    activity: {
      id: EventId.makeUnsafe(commandKey),
      tone: "error",
      kind: CHECKPOINT_REVERT_FAILED_ACTIVITY_KIND,
      summary: "Checkpoint revert failed",
      payload: { detail: "Checkpoint revert was interrupted by a server restart." },
      turnId: null,
      createdAt: input.now,
    },
    createdAt: input.now,
  };
}

function buildStalePendingRequestCommand(input: {
  readonly threadId: ThreadId;
  readonly now: string;
  readonly requestKind: PendingThreadRequestKind;
  readonly requestId: string;
  readonly lifecycleGeneration?: string;
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
        ...(input.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: input.lifecycleGeneration }
          : {}),
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
    const hasInFlightTurn = threadHasInFlightTurn(thread);
    commands.push(...planStalePendingRequestCommands({ thread, now: input.now }));
    const staleCheckpointRevertCommand = planStaleCheckpointRevertCommand({
      thread,
      now: input.now,
    });
    if (staleCheckpointRevertCommand !== null) {
      commands.push(staleCheckpointRevertCommand);
    }
    if (!hasInFlightTurn) {
      if (!hasDanglingActiveTurn(thread)) {
        continue;
      }
      // Preserve the terminal status (and its banner) - only the stale active
      // turn pointer is wrong here.
      commands.push({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`restart-reconcile-active-turn:${thread.id}:${input.now}`),
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: thread.session?.status ?? "interrupted",
          providerName: thread.session?.providerName ?? null,
          runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
          activeTurnId: null,
          lastError: thread.session?.lastError ?? null,
          updatedAt: input.now,
        },
        createdAt: input.now,
      });
      continue;
    }
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
 * Reconcile restart-orphaned turns once at boot.
 *
 * Reads the engine's in-memory command read model (post-bootstrap projection
 * state, kept current as commands commit), hydrates only stuck thread details to
 * discover stale human requests, and dispatches the resulting cleanup commands.
 * Every failure mode is contained and logged: a failed thread-detail read or a
 * failed individual dispatch must never block the server from coming up.
 *
 * Deliberately not a second `getCommandReadModel()` load. That query costs ~150ms
 * on a large database and this runs on the blocking startup path, after several
 * reactors have already started — so re-reading it would be both slower and
 * staler than the model the engine is already maintaining.
 */
export const reconcileRestartStuckTurns: Effect.Effect<
  void,
  never,
  OrchestrationEngineService | ProjectionSnapshotQuery | ProjectionPendingInteractionRepository
> = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  const readModel = yield* engine.getReadModel();

  const pendingInteractions = yield* ProjectionPendingInteractionRepository;
  const unsettled = yield* pendingInteractions
    .listUnsettled({})
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to read restart-orphaned callbacks", { cause }).pipe(
          Effect.as([]),
        ),
      ),
    );
  const unsettledByThread = new Map(Object.entries(Arr.groupBy(unsettled, (row) => row.threadId)));
  const now = new Date().toISOString();
  const threadsNeedingRestartCleanup = readModel.threads.filter(
    (thread) =>
      needsRestartReconciliation(thread) ||
      threadHasCheckpointRevertInProgress(thread) ||
      thread.hasPendingApprovals ||
      thread.hasPendingUserInput ||
      unsettledByThread.has(thread.id),
  );
  if (threadsNeedingRestartCleanup.length === 0) {
    return;
  }

  const reconcilableThreads = yield* Effect.forEach(
    threadsNeedingRestartCleanup,
    (thread) => {
      const pendingInteractions = unsettledByThread.get(thread.id);
      const fallback = pendingInteractions ? { ...thread, pendingInteractions } : thread;
      return snapshotQuery.getThreadDetailById(thread.id).pipe(
        Effect.map((detail) => Option.getOrElse(detail, () => fallback)),
        Effect.catchCause((cause) =>
          Effect.logWarning("restart turn reconciliation continuing without thread activities", {
            threadId: thread.id,
            cause,
          }).pipe(Effect.as(fallback)),
        ),
      );
    },
    { concurrency: 4 },
  );

  const commands = planRestartTurnReconciliation({ threads: reconcilableThreads, now });
  if (commands.length === 0) {
    return;
  }

  yield* Effect.logInfo("reconciling restart-stuck turns", {
    commandCount: commands.length,
    threadCount: threadsNeedingRestartCleanup.length,
    threadIds: threadsNeedingRestartCleanup.map((thread) => thread.id),
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
