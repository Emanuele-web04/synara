/** provider runtimes are in-memory and die with the process — a turn leaves "running" only via a terminal event, so post-restart projections still say running and the UI shows "Working" forever; runs once after bootstrap, before commands are admitted, emitting stale-request failures plus a terminal session.set so the projection's normal path closes each orphaned turn */
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

type ThreadSessionSetCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.session.set" }
>;
type ThreadActivityAppendCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;
type RestartReconciliationCommand = ThreadSessionSetCommand | ThreadActivityAppendCommand;

/** minimal persisted thread shape the planner inspects (a superset is fine) */
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

/** true when persisted state implies a turn only a now-dead in-process runtime could advance; a clean session is left untouched */
function needsRestartReconciliation(thread: ReconcilableThread): boolean {
  return threadHasInFlightTurn(thread) || hasDanglingActiveTurn(thread);
}

/** a terminal-status session still naming an active turn is invisible to threadHasInFlightTurn — but the dangling activeTurnId keeps "busy" checks true, so the composer stays blocked and Stop stays armed with nothing to stop */
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
      // a restart loses every live callback — pending/responding/retryable rows are unanswerable; uncertain user-input responses are retryable unless their callback was explicitly invalidated
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

/** pure planner extracted from the effectful runner so the reliability-critical selection logic is unit-testable without a database/clock/engine; `now` threaded in so a deterministic per-startup commandId lets receipt dedup treat a re-run as no-op */
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
      // preserve the terminal status and its banner — only the stale active turn pointer is wrong
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
        // prefer the session's own mode — fall back to the thread default when no session row materialized
        runtimeMode: thread.session?.runtimeMode ?? thread.runtimeMode,
        activeTurnId: null,
        // "interrupted" is a clean stop, not an error — no lastError banner
        lastError: null,
        updatedAt: input.now,
      },
      createdAt: input.now,
    });
  }
  return commands;
}

/** reads the engine's in-memory model (post-bootstrap, kept current as commands commit) rather than a second getCommandReadModel load — that query costs ~150ms on a large db and this runs on the blocking startup path; every failure contained and logged */
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
