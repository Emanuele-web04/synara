/**
 * HubOutputReactorLive - Per-turn Hub output capture layer.
 *
 * Git checkpoints attribute produced files precisely, but the Hub root is
 * typically not a Git repository, and file-change tool activities miss files
 * created by shell subprocesses (scripts, converters, downloads). This reactor
 * closes that gap: it snapshots the Hub workspace tree before provider turn
 * execution, rescans when the turn settles, and persists the diff as a thread activity
 * (`studio.outputs.captured`) that the Hub outputs listing reads back.
 * The activity kind retains its legacy name for persisted-history compatibility.
 *
 * Codex-generated images live under the Codex home, outside the Hub root, so
 * this scan never sees them; ProviderRuntimeIngestion owns copying those into
 * the workspace (with their own direct attribution) as image items complete.
 *
 * Concurrent Hub chats share one root, so overlapping turns may both claim
 * a file; attribution is deliberately generous rather than lossy.
 *
 * @module HubOutputReactorLive
 */
import {
  CommandId,
  EventId,
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  ThreadId,
  type ProviderRuntimeEvent,
  type TurnId,
} from "@synara/contracts";
import { Cause, Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { isGroupContainerKind } from "@synara/shared/projectContainers";

import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurnStart,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { isGitRepository } from "../../git/isRepo.ts";
import {
  scanStudioWorkspaceFiles,
  studioOutputsCapturedActivityPayload,
  type StudioWorkspaceScan,
} from "../../studioOutputs.ts";
import { diffStudioWorkspaceScans } from "../../studioOutputs.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { HubOutputReactor, type HubOutputReactorShape } from "../Services/HubOutputReactor.ts";

// Baselines whose terminal event never arrives must not accumulate forever; one
// entry per active turn stays far below this.
const MAX_TRACKED_TURN_BASELINES = 128;
const HUB_OUTPUT_REACTOR_CAPACITY = 128;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

// Keyed by thread + turn so concurrent turns on one thread (e.g. subagent runs)
// never clobber each other's baseline.
const baselineKey = (threadId: ThreadId, turnId: string) => `${threadId}\0${turnId}`;

interface HubTurnBaseline {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly files: StudioWorkspaceScan;
}

interface ActiveHubTurnBaseline extends HubTurnBaseline {
  readonly turnId: TurnId;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scanWorkspaceFiles = (workspaceRoot: string) =>
    scanStudioWorkspaceFiles({ workspaceRoot }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  // ProviderCommandReactor writes this map before invoking sendTurn/startReview.
  // The subsequent runtime turn.started event promotes the prepared entry into
  // baselineByTurn without rescanning after provider execution has begun.
  const pendingBaselineByThread = new Map<ThreadId, HubTurnBaseline>();
  const baselineByTurn = new Map<string, ActiveHubTurnBaseline>();

  // Resolves the Hub workspace root to scan for a thread, or null when this
  // reactor should stay out of the way: non-Hub projects, unresolvable cwds,
  // and Git roots (checkpoint capture already attributes those precisely).
  // Shell reads keep this cheap: it runs on every turn boundary of every thread.
  const resolveHubScanRoot = Effect.fnUntraced(function* (threadId: ThreadId) {
    const threadOption = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    const thread = Option.getOrUndefined(threadOption);
    if (!thread) {
      return null;
    }
    const projectOption = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.catch(() => Effect.succeed(Option.none())));
    const project = Option.getOrUndefined(projectOption);
    if (!project || !isGroupContainerKind(project.kind)) {
      return null;
    }
    const cwd = resolveThreadWorkspaceCwd({ thread, projects: [project] });
    if (!cwd || isGitRepository(cwd)) {
      return null;
    }
    return cwd;
  });

  const evictOldestBaseline = () => {
    const oldestActiveKey = baselineByTurn.keys().next().value;
    if (oldestActiveKey !== undefined) {
      baselineByTurn.delete(oldestActiveKey);
      return;
    }
    const oldestPendingThreadId = pendingBaselineByThread.keys().next().value;
    if (oldestPendingThreadId !== undefined) {
      pendingBaselineByThread.delete(oldestPendingThreadId);
    }
  };

  const makeRoomForBaseline = () => {
    if (baselineByTurn.size + pendingBaselineByThread.size >= MAX_TRACKED_TURN_BASELINES) {
      evictOldestBaseline();
    }
  };

  const captureBaselineBeforeTurnUnsafe = Effect.fnUntraced(function* (threadId: ThreadId) {
    // A retry replaces an earlier preparation for this thread. Remove it before
    // scanning so a failed fresh capture cannot leave a stale baseline behind.
    pendingBaselineByThread.delete(threadId);
    const workspaceRoot = yield* resolveHubScanRoot(threadId);
    if (!workspaceRoot) {
      return { status: "not-applicable" as const };
    }
    const files = yield* scanWorkspaceFiles(workspaceRoot);
    makeRoomForBaseline();
    pendingBaselineByThread.set(threadId, { threadId, workspaceRoot, files });
    return { status: "completed" as const };
  });

  const captureBaselineBeforeTurn: HubOutputReactorShape["captureBaselineBeforeTurn"] = (
    threadId,
  ) =>
    captureBaselineBeforeTurnUnsafe(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("hub output reactor failed to capture pre-turn baseline", {
          threadId,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ status: "failed" as const, detail: Cause.pretty(cause) }));
      }),
    );

  const cancelPendingTurnBaseline: HubOutputReactorShape["cancelPendingTurnBaseline"] = (
    threadId,
  ) => Effect.sync(() => pendingBaselineByThread.delete(threadId)).pipe(Effect.asVoid);

  const associateTurnStartBaseline = (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) =>
    Effect.gen(function* () {
      if (event.turnId === undefined) {
        return;
      }
      const key = baselineKey(event.threadId, event.turnId);
      if (baselineByTurn.has(key)) {
        return;
      }
      const prepared = pendingBaselineByThread.get(event.threadId);
      pendingBaselineByThread.delete(event.threadId);
      if (prepared) {
        baselineByTurn.set(key, { ...prepared, turnId: event.turnId });
        return;
      }

      // An absent preparation may have timed out or been cancelled. Never scan
      // at turn.started: provider edits could already be part of that baseline.
      // Only Hub workspaces need this feedback. Resolve their identity, but
      // never scan files to reconstruct a provider-native turn's initial state.
      if (!(yield* resolveHubScanRoot(event.threadId))) return;
      const threadOption = yield* projectionSnapshotQuery
        .getThreadDetailById(event.threadId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const thread = Option.getOrUndefined(threadOption);
      const turn = yield* projectionTurnRepository
        .getByTurnId({ threadId: event.threadId, turnId: event.turnId })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      const messageId =
        Option.getOrNull(turn)?.pendingMessageId ??
        thread?.messages.find(
          (message) => message.role === "user" && message.turnId === event.turnId,
        )?.id;
      if (thread?.parentThreadId && messageId === undefined) return;
      if (
        thread?.activities.some(
          (activity) =>
            activity.kind === "checkpoint.baseline.skipped" &&
            (activity.turnId === event.turnId ||
              (messageId !== undefined &&
                typeof activity.payload === "object" &&
                activity.payload !== null &&
                "messageId" in activity.payload &&
                activity.payload.messageId === messageId)),
        )
      )
        return;
      const activityId = EventId.makeUnsafe(
        `checkpoint-baseline-skipped:${
          messageId === undefined
            ? checkpointRefForThreadTurnStart(event.threadId, event.turnId)
            : checkpointRefForThreadMessageStart(event.threadId, messageId)
        }`,
      );
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: serverCommandId("studio-baseline-unavailable"),
        threadId: event.threadId,
        activity: {
          id: activityId,
          tone: "info",
          kind: "checkpoint.baseline.skipped",
          summary: "Hub output baseline unavailable for this turn",
          payload: {
            detail:
              "The initial Hub workspace state is unavailable for this turn, so its output changes cannot be indexed. Files are not rescanned after edits to invent a baseline.",
            ...(messageId === undefined ? {} : { messageId }),
          },
          turnId: event.turnId,
          createdAt: event.createdAt,
        },
        createdAt: event.createdAt,
      });
    });

  const persistBaselineOutputs = Effect.fnUntraced(function* (input: {
    readonly baseline: HubTurnBaseline;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) {
    const after = yield* scanWorkspaceFiles(input.baseline.workspaceRoot);
    const changedRelativePaths = diffStudioWorkspaceScans(input.baseline.files, after);
    if (changedRelativePaths.length === 0) {
      return;
    }

    // The payload mirrors the provider file-change activity shape (itemType + data
    // holding `path` entries) so the Hub outputs listing extracts paths through
    // the same collector that already handles provider payloads.
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("studio-outputs-captured"),
      threadId: input.baseline.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: STUDIO_OUTPUTS_ACTIVITY_KIND,
        summary: "Hub outputs captured",
        payload: studioOutputsCapturedActivityPayload(changedRelativePaths),
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Runs on turn.completed AND turn.aborted: files produced before an interruption
  // are still real outputs the panel should list. A pending entry covers providers
  // that terminate without first emitting turn.started.
  const captureTurnOutputs = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  ) {
    let baseline: HubTurnBaseline | undefined;
    if (event.turnId !== undefined) {
      const key = baselineKey(event.threadId, event.turnId);
      baseline = baselineByTurn.get(key);
      baselineByTurn.delete(key);
    }
    baseline ??= pendingBaselineByThread.get(event.threadId);
    pendingBaselineByThread.delete(event.threadId);
    if (!baseline) {
      return;
    }
    yield* persistBaselineOutputs({
      baseline,
      turnId: event.turnId ?? null,
      createdAt: event.createdAt,
    });
  });

  // A provider process can exit or error without a matching turn.aborted. Drain
  // every baseline for that thread so real files produced before the failure are
  // still attributed and stale in-memory entries do not accumulate.
  const captureTerminatedSessionOutputs = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "session.exited" | "runtime.error" }>,
  ) {
    const baselines: Array<{ baseline: HubTurnBaseline; turnId: TurnId | null }> = [];
    const pending = pendingBaselineByThread.get(event.threadId);
    pendingBaselineByThread.delete(event.threadId);
    if (pending) {
      baselines.push({ baseline: pending, turnId: event.turnId ?? null });
    }
    for (const [key, baseline] of baselineByTurn) {
      if (baseline.threadId !== event.threadId) {
        continue;
      }
      baselineByTurn.delete(key);
      baselines.push({ baseline, turnId: baseline.turnId });
    }
    yield* Effect.forEach(
      baselines,
      ({ baseline, turnId }) =>
        persistBaselineOutputs({ baseline, turnId, createdAt: event.createdAt }),
      { concurrency: 1, discard: true },
    );
  });

  const processEvent = (event: ProviderRuntimeEvent) => {
    if (event.type === "turn.started") {
      return associateTurnStartBaseline(event);
    }
    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      return captureTurnOutputs(event);
    }
    if (event.type === "session.exited" || event.type === "runtime.error") {
      return captureTerminatedSessionOutputs(event);
    }
    return Effect.void;
  };

  const processEventSafely = (event: ProviderRuntimeEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("hub output reactor failed to process event", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely, {
    capacity: HUB_OUTPUT_REACTOR_CAPACITY,
  });

  const start: HubOutputReactorShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, (event) =>
          event.type === "turn.started" ||
          event.type === "turn.completed" ||
          event.type === "turn.aborted" ||
          event.type === "session.exited" ||
          event.type === "runtime.error"
            ? worker.enqueue(event)
            : Effect.void,
        ),
      );
    }),
  );

  return {
    captureBaselineBeforeTurn,
    cancelPendingTurnBaseline,
    start,
    drain: worker.drain,
  } satisfies HubOutputReactorShape;
});

export const HubOutputReactorLive = Layer.effect(HubOutputReactor, make).pipe(
  Layer.provide(ProjectionTurnRepositoryLive),
);
