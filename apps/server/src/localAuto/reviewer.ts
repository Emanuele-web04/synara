import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns";
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeRequestOpenedEvent,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderRuntimeEventRepository } from "../persistence/Services/ProviderRuntimeEvents";
import { ProjectionPendingInteractionRepository } from "../persistence/Services/ProjectionPendingInteractions";
import { LocalAuto } from "./LocalAuto";
import { classifierContext } from "./input";

export const makeLocalAutoReviewer = Effect.gen(function* () {
  const classifier = yield* Effect.serviceOption(LocalAuto);
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const journal = yield* ProviderRuntimeEventRepository;
  const interactions = yield* ProjectionPendingInteractionRepository;
  const turns = yield* ProjectionTurnRepository;
  const scope = yield* Effect.scope;
  const active = new Set<string>();
  const startedAt = new Date().toISOString();

  const review = (request: ProviderRuntimeRequestOpenedEvent, sequence: number) =>
    Effect.gen(function* () {
      if (
        Option.isNone(classifier) ||
        !request.requestId ||
        !request.turnId ||
        !request.lifecycleGeneration
      )
        return;
      const thread = Option.getOrUndefined(
        yield* snapshots.getThreadDetailForExportById(request.threadId),
      );
      if (
        !thread ||
        thread.runtimeMode !== "auto-local" ||
        thread.session?.runtimeMode !== "auto-local" ||
        thread.session.activeTurnId !== request.turnId
      )
        return;
      const identity = {
        threadId: request.threadId,
        interactionKind: "approval" as const,
        requestId: ApprovalRequestId.makeUnsafe(request.requestId),
      };
      const pending = Option.getOrUndefined(yield* interactions.getByIdentity(identity));
      if (
        !pending ||
        pending.status !== "pending" ||
        pending.lifecycleGeneration !== request.lifecycleGeneration
      )
        return;
      const events: ProviderRuntimeEvent[] = [];
      let before = sequence;
      let bytes = 0;
      while (bytes <= 2 * 1024 * 1024) {
        const page = yield* journal.readThreadEvents({
          threadId: request.threadId,
          throughSequenceInclusive: sequence,
          beforeSequenceExclusive: before,
          limit: 201,
        });
        for (const row of page) {
          events.push(row.event);
          bytes += Buffer.byteLength(JSON.stringify(row.event));
        }
        if (page.length < 201) break;
        before = page[page.length - 1]!.sequence;
      }
      const turnHistory = yield* turns.listByThreadId({ threadId: request.threadId });
      const text =
        bytes > 2 * 1024 * 1024
          ? undefined
          : classifierContext({
              request,
              events: events.toReversed(),
              messages: thread.messages,
              turns: turnHistory,
            });
      const result = text ? yield* classifier.value.classify(text) : { decision: "ask" as const };
      // A human response, steering, cancellation, mode change, or a new provider
      // lifecycle while inference ran invalidates this result.
      const current = Option.getOrUndefined(
        yield* snapshots.getThreadDetailForExportById(request.threadId),
      );
      const latest = Option.getOrUndefined(yield* interactions.getByIdentity(identity));
      if (
        !current ||
        current.runtimeMode !== "auto-local" ||
        current.session?.activeTurnId !== request.turnId ||
        current.session.runtimeMode !== "auto-local" ||
        current.session.status !== "running" ||
        !latest ||
        latest.status !== "pending" ||
        latest.lifecycleGeneration !== request.lifecycleGeneration ||
        JSON.stringify(current.messages.filter((m) => m.role === "user")) !==
          JSON.stringify(thread.messages.filter((m) => m.role === "user"))
      )
        return;
      const now = new Date().toISOString();
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`local-auto:${request.eventId}:review`),
        threadId: request.threadId,
        activity: {
          id: EventId.makeUnsafe(`local-auto:${request.eventId}`),
          createdAt: now,
          tone: "info",
          kind: "local-auto.reviewed",
          summary:
            result.decision === "approve"
              ? "Auto (local) approved this tool call"
              : result.decision === "deny"
                ? "Auto (local) left this tool call for your review"
                : "Auto (local) needs manual review",
          payload: {
            requestId: request.requestId,
            decision: result.decision,
            ...(result.pDeny !== undefined ? { pDeny: result.pDeny } : {}),
          },
          turnId: request.turnId,
        },
        createdAt: now,
      });
      // Denials remain visible for the user to inspect/override, as in native
      // Auto modes. Never grant a session-wide exemption or alter the arguments.
      if (result.decision === "approve")
        yield* engine.dispatch({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe(`local-auto:${request.eventId}:approve`),
          ...identity,
          lifecycleGeneration: request.lifecycleGeneration,
          decision: "accept",
          createdAt: now,
        });
    });

  return (event: ProviderRuntimeEvent, sequence: number) => {
    // Old journal replays cannot authorize a callback after a server restart.
    if (
      event.type !== "request.opened" ||
      event.createdAt < startedAt ||
      active.has(event.eventId) ||
      active.size >= 32
    )
      return Effect.void;
    return Effect.gen(function* () {
      active.add(event.eventId);
      yield* review(event, sequence).pipe(
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            active.delete(event.eventId);
          }),
        ),
        Effect.forkIn(scope),
      );
    });
  };
});
