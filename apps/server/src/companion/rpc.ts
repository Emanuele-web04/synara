import {
  ApprovalRequestId,
  COMPANION_PROTOCOL_VERSION,
  COMPANION_RPC_METHODS,
  COMPANION_WS_PROTOCOL,
  CommandId,
  CompanionRpcGroup,
  MessageId,
  type CompanionError as CompanionErrorType,
  type CompanionMessage,
  type CompanionShellEvent,
  type CompanionListThreadsInput,
  type CompanionProject,
  type CompanionThreadEvent,
  type CompanionThreadSummary,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProviderKind,
} from "@synara/contracts";
import { DateTime, Effect, Layer, Option, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import { authErrorResponse, makeEffectAuthRequest } from "../auth/effectHttp";
import { ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { CheckpointDiffQuery } from "../checkpointing/Services/CheckpointDiffQuery";
import { ServerConfig } from "../config";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { ProviderDiscoveryService } from "../provider/Services/ProviderDiscoveryService";
import { ProviderHealth } from "../provider/Services/ProviderHealth";
import { ServerRuntimeStartup } from "../serverRuntimeStartup";
import {
  attachmentPrincipalForSession,
  CurrentManagedAttachmentPrincipal,
} from "../managedAttachmentPrincipal";
import { shouldRejectUntrustedRequestOrigin } from "../trustedOrigins";
import { shouldPublishThreadShellForEvent } from "../orchestration/threadShellEvents";
import {
  bufferLiveUiStream,
  type LiveUiStreamDropReport,
} from "../wsStreamBackpressure";
import { CompanionAttachmentStore } from "./AttachmentStore";
import {
  deriveCompanionApprovals,
  deriveCompanionUserInputRequests,
  toCompanionActivity,
  toCompanionProject,
  toCompanionShellSnapshot,
  toCompanionThreadDetail,
  toCompanionThreadSummary,
} from "./projection";
import { version as serverVersion } from "../../package.json" with { type: "json" };

const CAPABILITIES = [
  "projects.read",
  "threads.read",
  "threads.create",
  "turns.send",
  "turns.interrupt",
  "approvals.respond",
  "user-input.respond",
  "diffs.read",
  "attachments.write",
  "notifications.push",
] as const;

const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  antigravity: "Antigravity",
  grok: "Grok",
  droid: "Droid",
  kilo: "Kilo",
  opencode: "OpenCode",
  pi: "Pi",
};

const COMPANION_ERROR_TAGS = new Set<CompanionErrorType["_tag"]>([
  "Unauthenticated",
  "SessionExpired",
  "Forbidden",
  "ProtocolMismatch",
  "NotFound",
  "Conflict",
  "ValidationFailed",
  "PayloadTooLarge",
  "RateLimited",
  "ProviderUnavailable",
  "HostUnavailable",
  "InternalError",
]);

type CompanionShellEventBuilder = (sequence: number) => CompanionShellEvent;
type CompanionThreadEventBuilder = (sequence: number) => CompanionThreadEvent;

interface PreparedSnapshotEventStream<A, E, R> {
  readonly snapshot: A;
  readonly events: Stream.Stream<OrchestrationEvent, E, R>;
}

function companionError(
  tag: CompanionErrorType["_tag"],
  message: string,
  retryable = false,
): CompanionErrorType {
  return { _tag: tag, message: message.slice(0, 500), retryable };
}

function safeRpc<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: string,
  tag: CompanionErrorType["_tag"] = "InternalError",
) {
  return effect.pipe(
    Effect.mapError((cause) => {
      if (cause && typeof cause === "object" && "_tag" in cause) {
        const candidate = cause as { readonly _tag?: string; readonly message?: string };
        if (
          candidate._tag &&
          COMPANION_ERROR_TAGS.has(candidate._tag as CompanionErrorType["_tag"])
        ) {
          return cause as unknown as CompanionErrorType;
        }
        if (
          candidate._tag === "CompanionAttachmentStoreError" ||
          candidate._tag === "CheckpointUnavailableError"
        ) {
          return companionError("Conflict", candidate.message ?? fallback);
        }
      }
      return companionError(tag, fallback);
    }),
  );
}

function modelSelection(provider: ProviderKind, model: string): ModelSelection {
  return { provider, model } as ModelSelection;
}

function threadStatus(thread: CompanionThreadSummary): NonNullable<CompanionListThreadsInput["status"]> {
  if (thread.archivedAt) return "archived";
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "attention";
  switch (thread.runtime?.status) {
    case "starting":
    case "running":
      return "running";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
  switch (thread.latestTurn?.state) {
    case "completed":
      return "completed";
    case "error":
      return "failed";
    case "interrupted":
      return "interrupted";
    case "running":
      return "running";
    default:
      return "idle";
  }
}

function encodeCursor(thread: CompanionThreadSummary): string {
  return Buffer.from(JSON.stringify([thread.updatedAt, thread.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): readonly [string, string] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string"
      ? [parsed[0], parsed[1]]
      : null;
  } catch {
    return null;
  }
}

function isShellRelevantEvent(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "project.created":
    case "project.meta-updated":
    case "project.deleted":
    case "thread.deleted":
      return true;
    default:
      return event.aggregateKind === "thread" && shouldPublishThreadShellForEvent(event);
  }
}

/**
 * Read an authorized snapshot first, then continuously replay durable events
 * from its projection cursor.
 *
 * A raw hot-stream merge either creates a lost-update window or lets an event
 * beat the snapshot onto the wire. Durable, cursor-based reads avoid both
 * races; debounced hot events wake the reader quickly and a periodic wake closes
 * the final subscription race. Events are held until the projection cursor
 * confirms that lightweight follow-up queries can observe them, and sequence
 * rollback/duplicates are rejected centrally.
 */
export function prepareSnapshotFirstDomainEvents<A, SnapshotError, SnapshotContext, EventError, EventContext>(
  input: {
    readonly loadSnapshot: Effect.Effect<A, SnapshotError, SnapshotContext>;
    readonly snapshotSequence: (snapshot: A) => number;
    readonly replay: (
      sequenceExclusive: number,
    ) => Stream.Stream<OrchestrationEvent, EventError, EventContext>;
    /** Latest sequence fully visible through the projection read model. */
    readonly loadAvailableSequence: Effect.Effect<number, EventError, EventContext>;
    /** Hot events are wake-up hints; durable replay remains authoritative. */
    readonly live: Stream.Stream<OrchestrationEvent>;
    readonly isRelevant: (event: OrchestrationEvent) => boolean;
  },
): Effect.Effect<
  PreparedSnapshotEventStream<A, EventError, EventContext>,
  SnapshotError,
  SnapshotContext
> {
  return Effect.gen(function* () {
    const snapshot = yield* input.loadSnapshot;
    const snapshotSequence = input.snapshotSequence(snapshot);
    const events = Stream.unwrap(
      Effect.sync(() => {
        let lastDomainSequence = snapshotSequence;
        const readNextBatch = Effect.gen(function* () {
          const availableSequence = yield* input.loadAvailableSequence;
          const replayed = yield* input.replay(lastDomainSequence).pipe(Stream.runCollect);
          const eligible = replayed
            .filter(
              (event) =>
                event.sequence > lastDomainSequence && event.sequence <= availableSequence,
            )
            .sort((left, right) => left.sequence - right.sequence);
          const fresh: OrchestrationEvent[] = [];
          let batchSequence = lastDomainSequence;
          for (const event of eligible) {
            if (event.sequence <= batchSequence) continue;
            fresh.push(event);
            batchSequence = event.sequence;
          }
          if (fresh.length === 0) {
            return [];
          }
          lastDomainSequence = batchSequence;
          return fresh.filter(input.isRelevant);
        });
        const liveWakes = input.live.pipe(
          Stream.filter(input.isRelevant),
          // The durable replay below returns every event, so a wake-up can be
          // coalesced safely. Fixed windows keep a continuously streaming
          // response updating while preventing
          // token-level provider events from becoming token-level reads.
          Stream.groupedWithin(256, "100 millis"),
          Stream.map(() => undefined),
        );
        const fallbackWakes = Stream.fromEffectRepeat(Effect.sleep("1 second"));
        const wakes = Stream.merge(
          Stream.succeed(undefined),
          Stream.merge(liveWakes, fallbackWakes),
        );
        return wakes.pipe(
          Stream.mapEffect(() => readNextBatch),
          Stream.flatMap(Stream.fromIterable),
        );
      }),
    );

    return { snapshot, events };
  });
}

function isCompanionThreadRelevantEvent(event: OrchestrationEvent): boolean {
  if (event.aggregateKind !== "thread") return false;
  return (
    shouldPublishThreadShellForEvent(event) ||
    event.type === "thread.message-sent" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.reverted" ||
    event.type === "thread.conversation-rolled-back"
  );
}

const failCompanionLiveStreamForSnapshotResync = (report: LiveUiStreamDropReport) =>
  Effect.fail(
    companionError(
      "HostUnavailable",
      `${report.message}; reconnecting to refresh the authorized snapshot.`,
      true,
    ),
  );

function makeCompanionRpcLayer(session: AuthenticatedSession) {
  return CompanionRpcGroup.toLayer(
    Effect.gen(function* () {
      const attachments = yield* CompanionAttachmentStore;
      const checkpointDiff = yield* CheckpointDiffQuery;
      const engine = yield* OrchestrationEngineService;
      const projections = yield* ProjectionSnapshotQuery;
      const providerDiscovery = yield* ProviderDiscoveryService;
      const providerHealth = yield* ProviderHealth;
      const runtimeStartup = yield* ServerRuntimeStartup;

      const getProject = (projectId: Parameters<typeof projections.getProjectShellById>[0]) =>
        projections.getProjectShellById(projectId).pipe(
          Effect.flatMap((project) =>
            Option.isSome(project)
              ? Effect.succeed(project.value)
              : Effect.fail(companionError("NotFound", "Project not found.")),
          ),
          Effect.mapError((cause) =>
            (cause as CompanionErrorType)._tag === "NotFound"
              ? (cause as CompanionErrorType)
              : companionError("InternalError", "Failed to load project."),
          ),
        );

      const getThreadSnapshot = (threadId: Parameters<typeof projections.getThreadDetailSnapshotById>[0]) =>
        projections.getThreadDetailSnapshotById(threadId).pipe(
          Effect.flatMap((snapshot) =>
            Option.isSome(snapshot)
              ? Effect.succeed(snapshot.value)
              : Effect.fail(companionError("NotFound", "Thread not found.")),
          ),
          Effect.mapError((cause) =>
            (cause as CompanionErrorType)._tag === "NotFound"
              ? (cause as CompanionErrorType)
              : companionError("InternalError", "Failed to load thread."),
          ),
        );

      const listComposerOptions = (projectId: Parameters<typeof projections.getProjectShellById>[0]) =>
        Effect.gen(function* () {
          const project = yield* getProject(projectId);
          const statuses = yield* providerHealth.getStatuses;
          const providers = yield* Effect.forEach(
            statuses.filter((status) => status.available),
            (status) =>
              Effect.all({
                capabilities: providerDiscovery.getComposerCapabilities({ provider: status.provider }),
                models: providerDiscovery.listModels({
                  provider: status.provider,
                  cwd: project.workspaceRoot,
                }),
              }).pipe(
                Effect.map(({ capabilities, models }) => ({
                  provider: status.provider,
                  displayName: PROVIDER_DISPLAY_NAMES[status.provider],
                  models: models.models,
                  capabilities,
                })),
                Effect.catch(() => Effect.succeed(null)),
              ),
            { concurrency: 3 },
          );
          return {
            providers: providers.filter((provider) => provider !== null),
            defaultModelSelection: project.defaultModelSelection,
            runtimeModes: ["approval-required", "full-access"] as const,
            interactionModes: ["default", "plan"] as const,
          };
        });

      const loadThreadUpdatedBuilder = (
        threadId: Parameters<typeof projections.getThreadShellById>[0],
      ): Effect.Effect<CompanionThreadEventBuilder, CompanionErrorType> =>
        safeRpc(projections.getThreadShellById(threadId), "Thread update could not be loaded.").pipe(
          Effect.flatMap((thread) =>
            Option.isSome(thread)
              ? Effect.succeed(
                  (sequence: number): CompanionThreadEvent => ({
                    kind: "thread-updated",
                    sequence,
                    thread: toCompanionThreadSummary(thread.value),
                  }),
                )
              : Effect.fail(companionError("NotFound", "Thread no longer exists.")),
          ),
        );

      const toShellEventBuilders = (
        event: OrchestrationEvent,
      ): Effect.Effect<ReadonlyArray<CompanionShellEventBuilder>, CompanionErrorType> => {
        switch (event.type) {
          case "project.created":
          case "project.meta-updated":
            return safeRpc(
              projections.getProjectShellById(event.payload.projectId),
              "Project update could not be loaded.",
            ).pipe(
              Effect.flatMap((project) =>
                Option.isSome(project)
                  ? Effect.succeed([
                      (sequence: number): CompanionShellEvent => ({
                        kind: "project-upserted",
                        sequence,
                        project: toCompanionProject(project.value),
                      }),
                    ])
                  : Effect.fail(companionError("NotFound", "Project no longer exists.")),
              ),
            );
          case "project.deleted":
            return Effect.succeed([
              (sequence: number): CompanionShellEvent => ({
                kind: "project-removed",
                sequence,
                projectId: event.payload.projectId,
              }),
            ]);
          case "thread.deleted":
            return Effect.succeed([
              (sequence: number): CompanionShellEvent => ({
                kind: "thread-removed",
                sequence,
                threadId: event.payload.threadId,
              }),
            ]);
          default:
            if (event.aggregateKind !== "thread") return Effect.succeed([]);
            return safeRpc(
              projections.getThreadShellById(
                event.aggregateId as Parameters<typeof projections.getThreadShellById>[0],
              ),
              "Thread update could not be loaded.",
            ).pipe(
              Effect.flatMap((thread) =>
                Option.isSome(thread)
                  ? Effect.succeed([
                      (sequence: number): CompanionShellEvent => ({
                        kind: "thread-upserted",
                        sequence,
                        thread: toCompanionThreadSummary(thread.value),
                      }),
                    ])
                  : Effect.fail(companionError("NotFound", "Thread no longer exists.")),
              ),
            );
        }
      };

      const resyncThreadBuilder = (reason: string): CompanionThreadEventBuilder =>
        (sequence) => ({ kind: "resync-required", sequence, reason });

      const toThreadEventBuilders = (
        event: OrchestrationEvent,
      ): Effect.Effect<ReadonlyArray<CompanionThreadEventBuilder>, CompanionErrorType> =>
        Effect.gen(function* () {
          switch (event.type) {
            case "thread.message-sent": {
              const payload = event.payload;
              const message: CompanionMessage = {
                id: payload.messageId,
                role: payload.role,
                text: payload.text,
                ...(payload.attachments ? { attachments: payload.attachments } : {}),
                ...(payload.dispatchMode ? { dispatchMode: payload.dispatchMode } : {}),
                ...(payload.dispatchOrigin ? { dispatchOrigin: payload.dispatchOrigin } : {}),
                turnId: payload.turnId,
                streaming: payload.streaming,
                source: payload.source,
                createdAt: payload.createdAt,
                updatedAt: payload.updatedAt,
              };
              const builders: CompanionThreadEventBuilder[] = [
                (sequence) => ({ kind: "message-upserted", sequence, message }),
              ];
              // Streaming assistant deltas do not alter the shell summary. A
              // completed assistant message or a user message can alter latest
              // turn state and timestamps, so fetch only the lightweight shell.
              if (payload.role === "user" || payload.streaming === false) {
                builders.push(yield* loadThreadUpdatedBuilder(payload.threadId));
              }
              return builders;
            }
            case "thread.activity-appended": {
              const activity = event.payload.activity;
              const builders: CompanionThreadEventBuilder[] = [
                (sequence) => ({
                  kind: "activity-upserted",
                  sequence,
                  activity: toCompanionActivity(activity),
                }),
              ];

              if (activity.kind === "approval.requested") {
                const approval = deriveCompanionApprovals(event.payload.threadId, [activity])[0];
                if (approval) {
                  builders.push((sequence) => ({
                    kind: "approval-upserted",
                    sequence,
                    approval,
                  }));
                }
                builders.push(yield* loadThreadUpdatedBuilder(event.payload.threadId));
              } else if (activity.kind === "approval.resolved") {
                const payload =
                  activity.payload && typeof activity.payload === "object"
                    ? (activity.payload as Record<string, unknown>)
                    : null;
                if (typeof payload?.requestId === "string") {
                  const requestId = ApprovalRequestId.makeUnsafe(payload.requestId);
                  builders.push((sequence) => ({
                    kind: "approval-removed",
                    sequence,
                    requestId,
                  }));
                }
                builders.push(yield* loadThreadUpdatedBuilder(event.payload.threadId));
              } else if (activity.kind === "user-input.requested") {
                const request = deriveCompanionUserInputRequests(
                  event.payload.threadId,
                  [activity],
                )[0];
                if (request) {
                  builders.push((sequence) => ({
                    kind: "user-input-upserted",
                    sequence,
                    request,
                  }));
                }
                builders.push(yield* loadThreadUpdatedBuilder(event.payload.threadId));
              } else if (activity.kind === "user-input.resolved") {
                const payload =
                  activity.payload && typeof activity.payload === "object"
                    ? (activity.payload as Record<string, unknown>)
                    : null;
                if (typeof payload?.requestId === "string") {
                  const requestId = ApprovalRequestId.makeUnsafe(payload.requestId);
                  builders.push((sequence) => ({
                    kind: "user-input-removed",
                    sequence,
                    requestId,
                  }));
                }
                builders.push(yield* loadThreadUpdatedBuilder(event.payload.threadId));
              } else if (
                activity.kind === "provider.approval.respond.failed" ||
                activity.kind === "provider.user-input.respond.failed"
              ) {
                // Whether these failures close a stale request is derived from
                // sanitized activity history. Do not copy the raw payload into
                // the wire event; force one fresh authorized snapshot instead.
                builders.push(
                  resyncThreadBuilder("A pending request changed and needs a fresh snapshot."),
                );
              }
              return builders;
            }
            case "thread.deleted":
              return [resyncThreadBuilder("This thread was deleted.")];
            case "thread.proposed-plan-upserted":
              return [resyncThreadBuilder("The proposed plan changed.")];
            case "thread.reverted":
            case "thread.conversation-rolled-back":
              return [resyncThreadBuilder("Conversation history changed.")];
            default:
              if (event.aggregateKind !== "thread") return [];
              return [
                yield* loadThreadUpdatedBuilder(
                  event.aggregateId as Parameters<typeof projections.getThreadShellById>[0],
                ),
              ];
          }
        });

      const dispatch = (command: OrchestrationCommand) =>
        runtimeStartup.enqueueCommand(engine.dispatch(command));

      return CompanionRpcGroup.of({
        [COMPANION_RPC_METHODS.hello]: (input) =>
          input.protocolVersion !== COMPANION_PROTOCOL_VERSION
            ? Effect.fail(
                companionError(
                  "ProtocolMismatch",
                  `Companion Protocol ${input.protocolVersion} is unsupported. Upgrade the client to Protocol ${COMPANION_PROTOCOL_VERSION}.`,
                ),
              )
            : Effect.succeed({
            protocolVersion: COMPANION_PROTOCOL_VERSION,
            serverVersion,
            capabilities: CAPABILITIES,
            session: {
              id: session.sessionId,
              deviceLabel: session.client.label ?? session.client.browser ?? "Synara Companion",
              accessProfile: "companion" as const,
              expiresAt: DateTime.toUtc(
                session.expiresAt ?? DateTime.makeUnsafe(Date.now() + 5 * 60 * 1_000),
              ),
            },
              }),

        [COMPANION_RPC_METHODS.subscribeShell]: () =>
          Stream.unwrap(
            prepareSnapshotFirstDomainEvents({
              loadSnapshot: safeRpc(
                projections.getShellSnapshot().pipe(Effect.map(toCompanionShellSnapshot)),
                "Failed to load projects.",
              ),
              snapshotSequence: (snapshot) => snapshot.snapshotSequence,
              replay: (sequenceExclusive) =>
                engine.readEvents(sequenceExclusive).pipe(
                  Stream.mapError(() =>
                    companionError("HostUnavailable", "Shell event replay failed.", true),
                  ),
                ),
              loadAvailableSequence: safeRpc(
                projections.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                ),
                "Shell projection cursor could not be loaded.",
              ),
              live: engine.streamDomainEvents,
              isRelevant: isShellRelevantEvent,
            }).pipe(
              Effect.map(({ snapshot, events }) => {
                let nextSequence = snapshot.snapshotSequence;
                const updates = events.pipe(
                  Stream.mapEffect(toShellEventBuilders),
                  Stream.map((builders) =>
                    builders.map((build) => build(++nextSequence)),
                  ),
                  Stream.flatMap(Stream.fromIterable),
                  // Sequence assignment happens before the sliding websocket
                  // buffer. If a slow client loses an event, the stream fails
                  // and reconnects instead of silently accepting a rollback or
                  // an incomplete local projection.
                  (stream) =>
                    bufferLiveUiStream(stream, {
                      label: "companion.shell",
                      onDroppedEvents: failCompanionLiveStreamForSnapshotResync,
                    }),
                );
                return Stream.concat(
                  Stream.succeed({ kind: "snapshot" as const, snapshot }),
                  updates,
                );
              }),
            ),
          ),

        [COMPANION_RPC_METHODS.listProjects]: () =>
          safeRpc(
            projections.getShellSnapshot().pipe(
              Effect.map((snapshot) => ({ projects: snapshot.projects.map(toCompanionProject) })),
            ),
            "Failed to list projects.",
          ),

        [COMPANION_RPC_METHODS.listThreads]: (input) =>
          safeRpc(
            projections.getShellSnapshot().pipe(
              Effect.flatMap((snapshot) => {
                const cursor = decodeCursor(input.cursor);
                if (input.cursor && !cursor) {
                  return Effect.fail(companionError("ValidationFailed", "Invalid thread cursor."));
                }
                const limit = input.limit ?? 30;
                const all = snapshot.threads
                  .map(toCompanionThreadSummary)
                  .filter((thread) => (input.projectId ? thread.projectId === input.projectId : true))
                  .filter((thread) => (input.status ? threadStatus(thread) === input.status : true))
                  .sort(
                    (left, right) =>
                      right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
                  )
                  .filter((thread) =>
                    cursor
                      ? thread.updatedAt < cursor[0] ||
                        (thread.updatedAt === cursor[0] && thread.id < cursor[1])
                      : true,
                  );
                const threads = all.slice(0, limit);
                return Effect.succeed({
                  threads,
                  nextCursor: all.length > limit && threads.length > 0
                    ? encodeCursor(threads[threads.length - 1]!)
                    : null,
                });
              }),
            ),
            "Failed to list threads.",
          ),

        [COMPANION_RPC_METHODS.getThread]: (input) =>
          getThreadSnapshot(input.threadId).pipe(
            Effect.map((snapshot) => toCompanionThreadDetail(snapshot.thread)),
          ),

        [COMPANION_RPC_METHODS.subscribeThread]: (input) =>
          Stream.unwrap(
            prepareSnapshotFirstDomainEvents({
              loadSnapshot: getThreadSnapshot(input.threadId).pipe(
                Effect.map((snapshot) => ({
                  snapshotSequence: snapshot.snapshotSequence,
                  detail: toCompanionThreadDetail(snapshot.thread),
                })),
              ),
              snapshotSequence: (snapshot) => snapshot.snapshotSequence,
              replay: (sequenceExclusive) =>
                engine.readEvents(sequenceExclusive).pipe(
                  Stream.mapError(() =>
                    companionError("HostUnavailable", "Thread event replay failed.", true),
                  ),
                ),
              loadAvailableSequence: safeRpc(
                projections.getSnapshotSequence().pipe(
                  Effect.map(({ snapshotSequence }) => snapshotSequence),
                ),
                "Thread projection cursor could not be loaded.",
              ),
              live: engine.streamDomainEvents,
              isRelevant: (event) =>
                event.aggregateId === input.threadId && isCompanionThreadRelevantEvent(event),
            }).pipe(
              Effect.map(({ snapshot, events }) => {
                let nextSequence = snapshot.snapshotSequence;
                const updates = events.pipe(
                  Stream.mapEffect(toThreadEventBuilders),
                  Stream.map((builders) =>
                    builders.map((build) => build(++nextSequence)),
                  ),
                  Stream.flatMap(Stream.fromIterable),
                  (stream) =>
                    bufferLiveUiStream(stream, {
                      label: `companion.thread.${input.threadId}`,
                      onDroppedEvents: failCompanionLiveStreamForSnapshotResync,
                    }),
                );
                return Stream.concat(
                  Stream.succeed({ kind: "snapshot" as const, snapshot }),
                  updates,
                );
              }),
            ),
          ),

        [COMPANION_RPC_METHODS.listComposerOptions]: (input) =>
          safeRpc(listComposerOptions(input.projectId), "Failed to load composer options."),

        [COMPANION_RPC_METHODS.createThread]: (input) =>
          Effect.gen(function* () {
            if (input.runtimeMode === "full-access" && input.fullAccessConfirmed !== true) {
              return yield* Effect.fail(
                companionError(
                  "ValidationFailed",
                  "Full access requires an explicit confirmation.",
                ),
              );
            }
            yield* getProject(input.projectId);
            const options = yield* listComposerOptions(input.projectId).pipe(
              Effect.mapError(() => companionError("ProviderUnavailable", "Provider discovery failed.")),
            );
            const provider = options.providers.find((entry) => entry.provider === input.providerId);
            if (!provider || !provider.models.some((model) => model.slug === input.modelId)) {
              return yield* Effect.fail(
                companionError("ProviderUnavailable", "Selected provider model is unavailable."),
              );
            }
            const result = yield* dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe(`companion:create:${input.requestId}`),
              threadId: input.threadId,
              projectId: input.projectId,
              title: input.initialTitle ?? "New task",
              modelSelection: modelSelection(input.providerId, input.modelId),
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              envMode: "local",
              branch: null,
              worktreePath: null,
              associatedWorktreePath: null,
              associatedWorktreeBranch: null,
              associatedWorktreeRef: null,
              createBranchFlowCompleted: false,
              isPinned: false,
              parentThreadId: null,
              subagentAgentId: null,
              subagentNickname: null,
              subagentRole: null,
              lastKnownPr: null,
              createdAt: new Date().toISOString(),
            });
            return { requestId: input.requestId, accepted: true as const, sequence: result.sequence };
          }).pipe(Effect.mapError((cause) =>
            (cause as CompanionErrorType)._tag
              ? (cause as CompanionErrorType)
              : companionError("Conflict", "Thread could not be created."),
          )),

        [COMPANION_RPC_METHODS.sendTurn]: (input) =>
          Effect.gen(function* () {
            const snapshot = yield* getThreadSnapshot(input.threadId);
            if (input.text.trim().length === 0 && input.attachmentIds.length === 0) {
              return yield* Effect.fail(
                companionError("ValidationFailed", "A message or attachment is required."),
              );
            }
            if (
              input.delivery === "steer" &&
              !(
                snapshot.thread.session?.status === "running" &&
                snapshot.thread.session.activeTurnId !== null &&
                snapshot.thread.latestTurn?.state === "running"
              )
            ) {
              return yield* Effect.fail(
                companionError(
                  "Conflict",
                  "This task is no longer running. Refresh the thread and queue a new message.",
                ),
              );
            }
            const attachmentReservation = {
              sessionId: session.sessionId,
              threadId: input.threadId,
              requestId: input.requestId,
              uploadIds: input.attachmentIds,
            } as const;
            const persistedAttachments = yield* attachments.consume(attachmentReservation);
            const result = yield* dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`companion:turn:${input.requestId}`),
              threadId: input.threadId,
              message: {
                // Keep server-assigned message identity stable so a retry can
                // resolve through the durable orchestration command receipt.
                messageId: MessageId.makeUnsafe(`companion:message:${input.requestId}`),
                role: "user",
                text: input.text,
                attachments: [...persistedAttachments],
              },
              modelSelection: snapshot.thread.modelSelection,
              dispatchMode: input.delivery,
              runtimeMode: snapshot.thread.runtimeMode,
              interactionMode: snapshot.thread.interactionMode,
              createdAt: new Date().toISOString(),
            }).pipe(
              Effect.tapError(() =>
                attachments.release(attachmentReservation).pipe(
                  // Preserve the dispatch failure. A cleanup failure is logged
                  // by the store and must not turn a retryable command conflict
                  // into a misleading attachment error.
                  Effect.catch(() => Effect.void),
                ),
              ),
            );
            return { requestId: input.requestId, accepted: true as const, sequence: result.sequence };
          }).pipe(Effect.mapError((cause) =>
            (cause as CompanionErrorType)._tag &&
            ["NotFound", "ValidationFailed", "Conflict"].includes(
              (cause as CompanionErrorType)._tag,
            )
              ? (cause as CompanionErrorType)
              : companionError("Conflict", "Message could not be sent."),
          )),

        [COMPANION_RPC_METHODS.interruptTurn]: (input) =>
          safeRpc(
            dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe(`companion:interrupt:${input.requestId}`),
              threadId: input.threadId,
              ...(input.turnId ? { turnId: input.turnId } : {}),
              createdAt: new Date().toISOString(),
            }).pipe(
              Effect.map((result) => ({
                requestId: input.requestId,
                accepted: true as const,
                sequence: result.sequence,
              })),
            ),
            "Turn could not be interrupted.",
            "Conflict",
          ),

        [COMPANION_RPC_METHODS.respondToApproval]: (input) =>
          safeRpc(
            dispatch({
              type: "thread.approval.respond",
              commandId: CommandId.makeUnsafe(`companion:approval:${input.requestId}`),
              threadId: input.threadId,
              requestId: input.approvalRequestId,
              decision: input.decision,
              createdAt: new Date().toISOString(),
            }).pipe(
              Effect.map((result) => ({ requestId: input.requestId, accepted: true as const, sequence: result.sequence })),
            ),
            "Approval response was rejected.",
            "Conflict",
          ),

        [COMPANION_RPC_METHODS.respondToUserInput]: (input) =>
          safeRpc(
            dispatch({
              type: "thread.user-input.respond",
              commandId: CommandId.makeUnsafe(`companion:user-input:${input.requestId}`),
              threadId: input.threadId,
              requestId: input.userInputRequestId,
              answers: input.answers,
              createdAt: new Date().toISOString(),
            }).pipe(
              Effect.map((result) => ({ requestId: input.requestId, accepted: true as const, sequence: result.sequence })),
            ),
            "User input response was rejected.",
            "Conflict",
          ),

        [COMPANION_RPC_METHODS.getTurnDiff]: (input) =>
          Effect.gen(function* () {
            const snapshot = yield* getThreadSnapshot(input.threadId);
            const checkpoint = snapshot.thread.checkpoints.find((entry) => entry.turnId === input.turnId);
            if (!checkpoint) {
              return yield* Effect.fail(companionError("NotFound", "Turn diff is unavailable."));
            }
            return yield* checkpointDiff.getTurnDiff({
              threadId: input.threadId,
              fromTurnCount: Math.max(0, checkpoint.checkpointTurnCount - 1),
              toTurnCount: checkpoint.checkpointTurnCount,
              ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
            }).pipe(Effect.mapError(() => companionError("Conflict", "Turn diff is unavailable.")));
          }),

        [COMPANION_RPC_METHODS.getThreadDiff]: (input) =>
          Effect.gen(function* () {
            const snapshot = yield* getThreadSnapshot(input.threadId);
            const toTurnCount = snapshot.thread.checkpoints.reduce(
              (highest, checkpoint) => Math.max(highest, checkpoint.checkpointTurnCount),
              0,
            );
            return yield* checkpointDiff.getFullThreadDiff({
              threadId: input.threadId,
              toTurnCount,
              ...(input.ignoreWhitespace === undefined ? {} : { ignoreWhitespace: input.ignoreWhitespace }),
            }).pipe(Effect.mapError(() => companionError("Conflict", "Thread diff is unavailable.")));
          }),
      });
    }),
  );
}

const makeCompanionRpcWebSocket = (session: AuthenticatedSession) =>
  RpcServer.toHttpEffectWebsocket(CompanionRpcGroup, {
    spanPrefix: "companion.rpc",
    spanAttributes: { "rpc.transport": "websocket", "rpc.system": "effect-rpc" },
  }).pipe(
    Effect.provide(
      makeCompanionRpcLayer(session).pipe(Layer.provideMerge(RpcSerialization.layerJson)),
    ),
  );

export const companionRpcRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      "/api/companion/v1/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const config = yield* ServerConfig;
        if (!config.companionEnabled) return HttpServerResponse.text("Not Found", { status: 404 });
        const url = HttpServerRequest.toURL(request);
        const protocols = request.headers["sec-websocket-protocol"] ?? "";
        if (
          !url ||
          !protocols.split(",").some((protocol) => protocol.trim() === COMPANION_WS_PROTOCOL) ||
          shouldRejectUntrustedRequestOrigin({
            rawOrigin: request.headers.origin,
            requestOrigin: url?.origin ?? "",
            config,
          })
        ) {
          return HttpServerResponse.text("Forbidden", { status: 403 });
        }
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateCompanionWebSocketUpgrade(
          makeEffectAuthRequest(request),
        );
        if (session.accessProfile !== "companion" && session.role !== "owner") {
          return HttpServerResponse.text("Forbidden", {
            status: 403,
            headers: { "Cache-Control": "no-store" },
          });
        }
        const rpcWebSocket = yield* makeCompanionRpcWebSocket(session);
        return yield* sessions.runAuthenticatedConnection(
          session.sessionId,
          rpcWebSocket.pipe(
            Effect.provideService(
              CurrentManagedAttachmentPrincipal,
              attachmentPrincipalForSession(session.sessionId),
            ),
          ),
        );
      }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
    );
  }),
);
