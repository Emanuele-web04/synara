// Purpose: Assembles the ProviderCommandReactor — yields the orchestration/provider services,
//   builds the shared mutable reactor state, wires the extracted session / dispatch / handler
//   clusters via deps objects, then runs the domain-event and queue-drain streams through a
//   drainable worker. Provider intents (turn start/queue/interrupt, approvals, edits, session
//   lifecycle, runtime actions) are projected into provider-service calls here.
// Layer: orchestration server reactor (Layer.effect over ProviderCommandReactor).
// Exports: ProviderCommandReactorLive plus the normalizeSkillMentionTextForProvider re-export.

import {
  type ModelSelection,
  type ProviderStartOptions,
  type RuntimeMode,
} from "@t3tools/contracts";
import { Cache, Cause, Effect, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ExecutionRuntimeService } from "../../executionRuntime/Services/ExecutionRuntimeService.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import {
  HANDLED_TURN_START_KEY_MAX,
  HANDLED_TURN_START_KEY_TTL,
} from "./ProviderCommandReactor.config.ts";
import type {
  ProviderIntentEvent,
  ProviderQueueDrainEvent,
} from "./ProviderCommandReactor.types.ts";
import { type ReactorCoreDeps, makeReactorSession } from "./ProviderCommandReactor.session.ts";
import { makeReactorDispatch } from "./ProviderCommandReactor.dispatch.ts";
import { makeReactorHandlers } from "./ProviderCommandReactor.handlers.ts";

export { normalizeSkillMentionTextForProvider } from "./ProviderCommandReactor.helpers.ts";

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const executionRuntimeService = yield* ExecutionRuntimeService;
  const checkpointStore = yield* CheckpointStore;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  const threadModelSelections = new Map<string, ModelSelection>();
  const recentlyEnsuredSessionThreads = new Map<
    string,
    {
      readonly ensuredAt: number;
      readonly modelSelection?: ModelSelection;
      readonly runtimeMode?: RuntimeMode;
    }
  >();
  const queuedTurnStartsByThread = new Map<
    string,
    Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
  >();
  const editResendTurnStartKeys = new Set<string>();
  const drainingQueuedTurns = new Set<string>();
  const sidechatContextBootstrapThreadIds = new Set<string>();

  const coreDeps: ReactorCoreDeps = {
    orchestrationEngine,
    projectionSnapshotQuery,
    providerService,
    executionRuntimeService,
    serverSettings,
    threadProviderOptions,
    threadModelSelections,
    recentlyEnsuredSessionThreads,
    sidechatContextBootstrapThreadIds,
  };

  const session = makeReactorSession(coreDeps);
  const dispatch = makeReactorDispatch({
    ...coreDeps,
    checkpointStore,
    git,
    textGeneration,
    session,
    queuedTurnStartsByThread,
    editResendTurnStartKeys,
  });
  const handlers = makeReactorHandlers({
    ...coreDeps,
    session,
    dispatch,
    handledTurnStartKeys,
    queuedTurnStartsByThread,
    editResendTurnStartKeys,
    drainingQueuedTurns,
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    handlers.processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const processQueueDrainEventSafely = (event: ProviderQueueDrainEvent) =>
    handlers.processQueueDrainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to drain queued turn", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.all([
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (
        event.type !== "thread.created" &&
        event.type !== "thread.meta-updated" &&
        event.type !== "thread.runtime-mode-set" &&
        event.type !== "thread.turn-queued" &&
        event.type !== "thread.turn-start-requested" &&
        event.type !== "thread.turn-interrupt-requested" &&
        event.type !== "thread.approval-response-requested" &&
        event.type !== "thread.user-input-response-requested" &&
        event.type !== "thread.conversation-rollback-requested" &&
        event.type !== "thread.message-edit-resend-requested" &&
        event.type !== "thread.session-stop-requested" &&
        event.type !== "thread.session-ensure-requested" &&
        event.type !== "thread.runtime-action-requested"
      ) {
        return Effect.void;
      }

      return worker.enqueue(event);
    }).pipe(Effect.forkScoped),
    Stream.runForEach(providerService.streamEvents, (event) => {
      if (event.type !== "turn.completed" && event.type !== "turn.aborted") {
        return Effect.void;
      }
      return processQueueDrainEventSafely(event);
    }).pipe(Effect.forkScoped),
  ]).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
