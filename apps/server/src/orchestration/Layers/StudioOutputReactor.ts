/** Git checkpoints don't run in the typically non-Git Studio root and file-change activities miss shell-created files — this snapshots the workspace before the turn, rescans at settle, and persists the diff as studio.outputs.captured; Codex images live outside the root so ingestion owns those; concurrent Studio chats share one root so attribution is deliberately generous */
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

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
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
import {
  StudioOutputReactor,
  type StudioOutputReactorShape,
} from "../Services/StudioOutputReactor.ts";

// baselines whose terminal event never arrives must not accumulate — one entry per active turn stays far below this
const MAX_TRACKED_TURN_BASELINES = 128;
const STUDIO_OUTPUT_REACTOR_CAPACITY = 128;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

// keyed by thread+turn so concurrent turns on one thread never clobber each other's baseline
const baselineKey = (threadId: ThreadId, turnId: string) => `${threadId}\0${turnId}`;

interface StudioTurnBaseline {
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly files: StudioWorkspaceScan;
}

interface ActiveStudioTurnBaseline extends StudioTurnBaseline {
  readonly turnId: TurnId;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scanWorkspaceFiles = (workspaceRoot: string) =>
    scanStudioWorkspaceFiles({ workspaceRoot }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  // written before sendTurn — the turn.started event promotes the entry into baselineByTurn without rescanning after execution began
  const pendingBaselineByThread = new Map<ThreadId, StudioTurnBaseline>();
  const baselineByTurn = new Map<string, ActiveStudioTurnBaseline>();

  // null when this reactor should stay out of the way — non-Studio projects, unresolvable cwds, Git roots (checkpoints already attribute those)
  const resolveStudioScanRoot = Effect.fnUntraced(function* (threadId: ThreadId) {
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
    if (!project || project.kind !== "studio") {
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
    // a retry replaces an earlier preparation — remove it first so a failed capture can't leave a stale baseline
    pendingBaselineByThread.delete(threadId);
    const workspaceRoot = yield* resolveStudioScanRoot(threadId);
    if (!workspaceRoot) {
      return;
    }
    const files = yield* scanWorkspaceFiles(workspaceRoot);
    makeRoomForBaseline();
    pendingBaselineByThread.set(threadId, { threadId, workspaceRoot, files });
  });

  const captureBaselineBeforeTurn: StudioOutputReactorShape["captureBaselineBeforeTurn"] = (
    threadId,
  ) =>
    captureBaselineBeforeTurnUnsafe(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("studio output reactor failed to capture pre-turn baseline", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const cancelPendingTurnBaseline: StudioOutputReactorShape["cancelPendingTurnBaseline"] = (
    threadId,
  ) => Effect.sync(() => pendingBaselineByThread.delete(threadId)).pipe(Effect.asVoid);

  const associateTurnStartBaseline = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>,
  ) {
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

    // provider-native/subagent turns can bypass ProviderCommandReactor — preserve best-effort capture while user turns use the awaited pre-dispatch baseline
    const workspaceRoot = yield* resolveStudioScanRoot(event.threadId);
    if (!workspaceRoot) {
      return;
    }
    const files = yield* scanWorkspaceFiles(workspaceRoot);
    makeRoomForBaseline();
    baselineByTurn.set(key, {
      threadId: event.threadId,
      turnId: event.turnId,
      workspaceRoot,
      files,
    });
  });

  const persistBaselineOutputs = Effect.fnUntraced(function* (input: {
    readonly baseline: StudioTurnBaseline;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
  }) {
    const after = yield* scanWorkspaceFiles(input.baseline.workspaceRoot);
    const changedRelativePaths = diffStudioWorkspaceScans(input.baseline.files, after);
    if (changedRelativePaths.length === 0) {
      return;
    }

    // mirrors the provider file-change activity shape so the outputs listing extracts paths through the same collector
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("studio-outputs-captured"),
      threadId: input.baseline.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "info",
        kind: STUDIO_OUTPUTS_ACTIVITY_KIND,
        summary: "Studio outputs captured",
        payload: studioOutputsCapturedActivityPayload(changedRelativePaths),
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // runs on completed AND aborted — files produced before an interruption are still real outputs; a pending entry covers providers terminating without turn.started
  const captureTurnOutputs = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
  ) {
    let baseline: StudioTurnBaseline | undefined;
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

  // a provider can exit without a matching turn.aborted — drain every baseline for the thread so real files stay attributed and stale entries don't accumulate
  const captureTerminatedSessionOutputs = Effect.fnUntraced(function* (
    event: Extract<ProviderRuntimeEvent, { type: "session.exited" | "runtime.error" }>,
  ) {
    const baselines: Array<{ baseline: StudioTurnBaseline; turnId: TurnId | null }> = [];
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
        return Effect.logWarning("studio output reactor failed to process event", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely, {
    capacity: STUDIO_OUTPUT_REACTOR_CAPACITY,
  });

  const start: StudioOutputReactorShape["start"] = startDrainableWorkerProducers(
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
  } satisfies StudioOutputReactorShape;
});

export const StudioOutputReactorLive = Layer.effect(StudioOutputReactor, make);
