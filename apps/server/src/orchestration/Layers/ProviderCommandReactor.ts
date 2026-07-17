// FILE: ProviderCommandReactor.ts
// Purpose: Routes orchestration intents into provider sessions and maintains replay-safe context.
// Layer: Orchestration provider reactor

import {
  type ChatAttachment,
  CommandId,
  EventId,
  type ModelSelection,
  MessageId,
  type OrchestrationEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderMentionReference,
  type ProviderRuntimeEvent,
  ProviderKind,
  type ProviderReviewTarget,
  type ProviderStartOptions,
  type ProviderSkillReference,
  type ProviderTurnStartResult,
  type OrchestrationSession,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  TurnId,
} from "@synara/contracts";
import { Cache, Cause, Duration, Effect, Equal, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@synara/shared/DrainableWorker";
import {
  buildPromptThreadTitleFallback,
  isGenericChatThreadTitle,
} from "@synara/shared/chatThreads";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@synara/shared/conversationEdit";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@synara/shared/git";
import { claudeSelectionRequiresRestart } from "@synara/shared/model";
import { buildStalePendingRequestFailureDetail } from "@synara/shared/threadSummary";
import { resolveThreadWorkspaceState } from "@synara/shared/threadEnvironment";

import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { buildInlineSkillInstructions } from "../../provider/skillPromptInjection.ts";
import {
  TextGeneration,
  type BranchNameGenerationInput,
  type ThreadTitleGenerationInput,
} from "../../git/Services/TextGeneration.ts";
import { resolveTextGenerationInputForSelection } from "../../git/textGenerationSelection.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { clearWorkspaceIndexCache } from "../../workspaceEntries.ts";
import {
  buildPriorTranscriptBootstrapText,
  buildForkBootstrapText,
  buildHandoffBootstrapText,
  hasNativeAssistantMessagesBefore,
  listImportedForkMessages,
  listPriorTranscriptMessages,
} from "../handoff.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { StudioOutputReactor } from "../Services/StudioOutputReactor.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.created"
      | "thread.meta-updated"
      | "thread.session-set"
      | "thread.runtime-mode-set"
      | "thread.turn-queued"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.conversation-rollback-requested"
      | "thread.message-edit-resend-requested"
      | "thread.session-stop-requested";
  }
>;

type ProviderQueueDrainEvent = Extract<
  ProviderRuntimeEvent,
  {
    type: "turn.completed" | "turn.aborted";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Codex app-server still expects `$skill` text next to the structured skill item.
export function normalizeSkillMentionTextForProvider(input: {
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
}): string {
  if (input.provider !== "codex" || !input.skills || input.skills.length === 0) {
    return input.messageText;
  }

  let nextText = input.messageText;
  for (const skill of input.skills) {
    const escapedName = escapeRegExp(skill.name);
    nextText = nextText.replace(
      new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)`, "gi"),
      `$1$${skill.name}`,
    );
  }
  return nextText;
}

function attachmentTitleSeed(attachment: ChatAttachment | undefined): string {
  if (!attachment) {
    return "";
  }
  if (attachment.type === "image" || attachment.type === "file") {
    return attachment.name;
  }
  return attachment.text.trim();
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const SIDECHAT_BOUNDARY_INSTRUCTION =
  "You are in a sidechat. Treat all prior conversation as reference-only context. Do not continue any prior task automatically. Do not mutate files, git, or the workspace and do not run workspace-changing commands unless the latest user message explicitly asks you to do so after this boundary. Use this sidechat for focused explanation, safety checks, summaries, and alternatives.";

type ProviderContextTag = "handoff_context" | "sidechat_context" | "thread_context";

function wrapProviderContext(input: {
  readonly tag: ProviderContextTag;
  readonly contextText: string;
  readonly messageText: string;
  readonly wrapLatestUserMessage: boolean;
}): string {
  const messageSection = input.wrapLatestUserMessage
    ? `<latest_user_message>\n${input.messageText}\n</latest_user_message>`
    : input.messageText;
  return `<${input.tag}>\n${input.contextText}\n</${input.tag}>\n\n${messageSection}`;
}

function availableProviderContextChars(input: {
  readonly tag: ProviderContextTag;
  readonly messageText: string;
  readonly wrapLatestUserMessage: boolean;
}): number {
  return Math.max(
    0,
    PROVIDER_SEND_TURN_MAX_INPUT_CHARS - wrapProviderContext({ ...input, contextText: "" }).length,
  );
}

function wrapSidechatInput(messageText: string): string {
  return `<sidechat_boundary>\n${SIDECHAT_BOUNDARY_INSTRUCTION}\n</sidechat_boundary>\n\n<latest_user_message>\n${messageText}\n</latest_user_message>`;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

function isStaleCodexResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

function isStaleClaudeResumeError(error: unknown): boolean {
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return (
      error.provider === "claudeAgent" &&
      error.detail.toLowerCase().includes("no conversation found with session id")
    );
  }
  return String(error).toLowerCase().includes("no conversation found with session id");
}

function isRollbackStillInProgressError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("rollback") &&
    (normalized.includes("turn is in progress") ||
      normalized.includes("turn in progress") ||
      normalized.includes("active turn"))
  );
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.replace(/^synara\//, "");

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore;
  const studioOutputReactor = yield* StudioOutputReactor;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadProviderOptions = new Map<string, ProviderStartOptions>();
  // The selection last applied to each live session. Keep this separate from
  // projected thread metadata so an option changed mid-turn is still compared
  // against the old subprocess configuration before the next turn starts.
  const threadSessionModelSelections = new Map<string, ModelSelection>();
  const seedThreadModelSelections = projectionSnapshotQuery.getCommandReadModel().pipe(
    Effect.tap((snapshot) =>
      Effect.sync(() => {
        for (const thread of snapshot.threads) {
          threadSessionModelSelections.set(thread.id, thread.modelSelection);
        }
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("provider command reactor failed to seed model selections", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const resolveThreadWorkspaceProject = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId">,
  ): Effect.fn.Return<OrchestrationProjectShell | undefined> {
    return Option.getOrUndefined(
      yield* projectionSnapshotQuery
        .getProjectShellById(thread.projectId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    );
  });

  const resolveProjectedThreadWorkspaceCwd = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThread, "projectId" | "envMode" | "worktreePath">,
  ): Effect.fn.Return<string | undefined> {
    const project = yield* resolveThreadWorkspaceProject(thread);
    if (!project) {
      return undefined;
    }
    return resolveThreadWorkspaceCwd({
      thread,
      projects: [project],
    });
  });
  const queuedTurnStartsByThread = new Map<
    string,
    Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
  >();
  const editResendTurnStartKeys = new Set<string>();
  const drainingQueuedTurns = new Set<string>();
  // Provider sessions with a drained queued turn whose promotion is in flight.
  // The reservation survives provider startup and binds to the exact turn that
  // must settle before another queue can drain, preventing late terminal events
  // from promoting overlapping work.
  // Keyed by the session-owning thread id (child subagent threads share the
  // parent session, so per-child keys would allow overlapping promotions on
  // one session); the queued thread + message pair identifies the promoted
  // command, while object identity protects a replacement reservation for a
  // retry of that same command.
  type PendingQueuedDispatch = {
    readonly queuedThreadId: string;
    readonly messageId: string;
    releaseOnTurnId?: TurnId;
    pendingTerminalTurnIds?: Set<TurnId>;
  };
  const pendingQueuedDispatchBySessionThread = new Map<string, PendingQueuedDispatch>();
  const sidechatContextBootstrapThreadIds = new Set<string>();
  // Fresh sessions that cannot inherit native conversation state need one
  // transcript bootstrap (fork fallbacks and non-resumable Droid model changes).
  const freshSessionContextBootstrapThreadIds = new Set<string>();
  // Providers without native rewind restart after rollback and receive the
  // retained projection transcript once on their next prompt.
  const rollbackContextBootstrapThreadIds = new Set<string>();
  type PendingContextBootstrapAttempt = {
    turnId?: TurnId;
    terminalEvent?: ProviderQueueDrainEvent;
    readonly clearSidechat: boolean;
    readonly clearPriorTranscript: boolean;
  };
  const pendingContextBootstrapAttempts = new Map<string, PendingContextBootstrapAttempt>();
  // Explicit stop resets context once: the next successful session start must
  // begin clean even if fork metadata would normally register a bootstrap.
  const suppressContextBootstrapOnNextStartThreadIds = new Set<string>();
  const clearPendingContextBootstraps = (threadId: string) => {
    sidechatContextBootstrapThreadIds.delete(threadId);
    freshSessionContextBootstrapThreadIds.delete(threadId);
    rollbackContextBootstrapThreadIds.delete(threadId);
    pendingContextBootstrapAttempts.delete(threadId);
  };

  const completePendingContextBootstrapAttempt = (
    threadId: string,
    attempt: PendingContextBootstrapAttempt,
    event: ProviderQueueDrainEvent,
  ) => {
    // Keep bootstrap flags after cancellation or failure even though Droid may
    // already have received the prompt. A bounded duplicate on retry is safer
    // than dropping the only model-visible copy of the retained transcript.
    if (event.type !== "turn.completed" || event.payload.state !== "completed") {
      return;
    }
    if (attempt.clearSidechat) {
      sidechatContextBootstrapThreadIds.delete(threadId);
    }
    if (attempt.clearPriorTranscript) {
      freshSessionContextBootstrapThreadIds.delete(threadId);
      rollbackContextBootstrapThreadIds.delete(threadId);
      sidechatContextBootstrapThreadIds.delete(threadId);
    }
  };

  const observePendingContextBootstrapTerminalEvent = (event: ProviderQueueDrainEvent) => {
    const attempt = pendingContextBootstrapAttempts.get(event.threadId);
    if (!attempt) {
      return;
    }
    if (attempt.turnId === undefined) {
      attempt.terminalEvent = event;
      return;
    }
    if (attempt.turnId !== event.turnId) {
      return;
    }
    pendingContextBootstrapAttempts.delete(event.threadId);
    completePendingContextBootstrapAttempt(event.threadId, attempt, event);
  };

  const resolveThreadTextGenerationInput = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly useConfiguredFallback?: boolean;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const modelSelection =
      input.modelSelection ??
      thread?.modelSelection ??
      threadSessionModelSelections.get(input.threadId);
    const providerOptions = input.providerOptions ?? threadProviderOptions.get(input.threadId);
    const threadTextGenerationInput = resolveTextGenerationInputForSelection(
      modelSelection,
      providerOptions,
    );

    if (threadTextGenerationInput || !input.useConfiguredFallback) {
      return threadTextGenerationInput;
    }

    // Non-generating chat providers still get AI titles via the configured git-writing model.
    const settings = yield* serverSettings.getSettings;
    return resolveTextGenerationInputForSelection(
      settings.textGenerationModelSelection,
      providerOptions,
    );
  });

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.makeUnsafe(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const setThreadSessionError = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode?: RuntimeMode;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        threadId: input.threadId,
        status: "error",
        providerName: thread.session?.providerName ?? thread.modelSelection.provider,
        runtimeMode: input.runtimeMode ?? thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: input.detail,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return Option.getOrUndefined(yield* projectionSnapshotQuery.getThreadDetailById(threadId));
  });

  // Recovers the parent thread when older/local-only subagent rows are missing parentThreadId metadata.
  const inferParentThreadFromSyntheticSubagentId = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const rawThreadId = threadId as string;
    if (!rawThreadId.startsWith("subagent:")) {
      return null;
    }

    return Option.getOrNull(
      yield* projectionSnapshotQuery.findSyntheticSubagentParentThread(threadId),
    );
  });

  const resolveProviderSessionThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return null;
    }
    if (!thread.parentThreadId) {
      return (yield* inferParentThreadFromSyntheticSubagentId(thread.id)) ?? thread;
    }
    const parentThread = yield* resolveThread(thread.parentThreadId);
    return parentThread ?? thread;
  });

  const resolveSubagentProviderThreadId = (
    threadId: ThreadId,
    parentThreadId: ThreadId | null | undefined,
  ): string | undefined => {
    if (!parentThreadId) {
      return undefined;
    }

    const prefix = `subagent:${parentThreadId}:`;
    const rawThreadId = threadId as string;
    return rawThreadId.startsWith(prefix) ? rawThreadId.slice(prefix.length) : undefined;
  };

  const enqueueQueuedTurnStart = (
    payload: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"],
  ) =>
    Effect.sync(() => {
      const existing = queuedTurnStartsByThread.get(payload.threadId) ?? [];
      if (payload.dispatchMode === "steer") {
        existing.unshift(payload);
      } else {
        existing.push(payload);
      }
      queuedTurnStartsByThread.set(payload.threadId, existing);
    });

  const dequeueQueuedTurnStart = (threadId: ThreadId) =>
    Effect.sync(() => {
      const existing = queuedTurnStartsByThread.get(threadId);
      if (!existing || existing.length === 0) {
        return null;
      }
      const next = existing.shift() ?? null;
      if (existing.length === 0) {
        queuedTurnStartsByThread.delete(threadId);
      } else {
        queuedTurnStartsByThread.set(threadId, existing);
      }
      return next;
    });

  const removeQueuedTurnStart = (threadId: ThreadId, messageId: string) =>
    Effect.sync(() => {
      const existing = queuedTurnStartsByThread.get(threadId);
      if (!existing || existing.length === 0) {
        return false;
      }
      const next = existing.filter((payload) => payload.messageId !== messageId);
      if (next.length === existing.length) {
        return false;
      }
      if (next.length === 0) {
        queuedTurnStartsByThread.delete(threadId);
      } else {
        queuedTurnStartsByThread.set(threadId, next);
      }
      return true;
    });

  const hasQueuedTurnStart = (threadId: ThreadId, messageId: string) =>
    Effect.sync(
      () =>
        queuedTurnStartsByThread
          .get(threadId)
          ?.some((payload) => payload.messageId === messageId) ?? false,
    );

  // Live provider state, not the projection: the decider routes turn starts
  // from a projected session snapshot that can lag the runtime in both
  // directions (queueing after the turn already settled, or dispatching while
  // a turn is still live). Adapters clear `activeTurnId` synchronously with
  // emitting `turn.completed`/`turn.aborted`, so this check is authoritative.
  // Child subagent threads share their parent's provider session, so the
  // lookup must resolve to the session-owning thread — a raw child-id lookup
  // would always miss and drain queued child messages into a live turn.
  const resolveLiveProviderTurnId = Effect.fnUntraced(function* (threadId: ThreadId) {
    const providerThread = yield* resolveProviderSessionThread(threadId);
    const sessionThreadId = providerThread?.id ?? threadId;
    const session = yield* providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((entry) => entry.threadId === sessionThreadId)));
    return session?.status === "running" ? session.activeTurnId : undefined;
  });
  const hasLiveProviderTurn = (threadId: ThreadId) =>
    resolveLiveProviderTurnId(threadId).pipe(Effect.map((turnId) => turnId !== undefined));

  const editResendTurnStartKey = (threadId: ThreadId, messageId: string) =>
    `${threadId}:${messageId}`;

  const clearEditResendTurnStartKeysForThread = (threadId: ThreadId) =>
    Effect.sync(() => {
      const prefix = `${threadId}:`;
      for (const key of editResendTurnStartKeys) {
        if (key.startsWith(prefix)) {
          editResendTurnStartKeys.delete(key);
        }
      }
    });

  const removedTurnIdsFromMessage = (
    messages: ReadonlyArray<{ readonly id: string; readonly turnId?: TurnId | null }>,
    messageId: string,
  ): TurnId[] => collectTailTurnIds<TurnId>({ messages, messageId });

  const clearStaleProviderResumeState = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cause: ProviderServiceError;
  }) {
    if (providerService.clearSessionResumeCursor) {
      yield* providerService
        .clearSessionResumeCursor({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    } else {
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => Effect.void));
    }
    yield* Effect.logWarning("provider command reactor cleared stale provider resume state", {
      threadId: input.threadId,
      cause: input.cause.message,
    });
  });

  const rollbackProviderConversationForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) {
    const projectedThread = yield* resolveThread(input.threadId);
    const provider = projectedThread
      ? Schema.is(ProviderKind)(projectedThread.session?.providerName)
        ? projectedThread.session?.providerName
        : projectedThread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "restart-session";
    let attempt = 0;
    while (true) {
      let rollbackError: ProviderServiceError | null = null;
      yield* providerService
        .rollbackConversation({
          threadId: input.threadId,
          numTurns: input.numTurns,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              rollbackError = error;
            }),
          ),
        );
      if (rollbackError === null) {
        if (rebuildsContext) {
          rollbackContextBootstrapThreadIds.add(input.threadId);
        }
        return;
      }
      if (isStaleCodexResumeError(rollbackError)) {
        yield* clearStaleProviderResumeState({
          threadId: input.threadId,
          cause: rollbackError,
        });
        return;
      }
      if (isRollbackStillInProgressError(rollbackError) && attempt < 30) {
        attempt += 1;
        yield* Effect.sleep(100);
        continue;
      }
      return yield* Effect.fail(rollbackError);
    }
  });

  const restoreWorkspaceBeforeEditReplay = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly removedTurnIds: ReadonlyArray<TurnId>;
  }) {
    if (input.removedTurnIds.length === 0) {
      return;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const removedTurnIdSet = new Set(input.removedTurnIds);
    const removedCheckpoints = thread.checkpoints.filter((checkpoint) =>
      removedTurnIdSet.has(checkpoint.turnId),
    );
    if (removedCheckpoints.length === 0) {
      return;
    }

    const firstRemovedTurnCount = removedCheckpoints.reduce(
      (minTurnCount, checkpoint) => Math.min(minTurnCount, checkpoint.checkpointTurnCount),
      Number.POSITIVE_INFINITY,
    );
    const targetTurnCount = Math.max(0, firstRemovedTurnCount - 1);
    const cwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    if (!cwd) {
      return;
    }

    const isGitWorkspace = yield* checkpointStore.isGitRepository(cwd);
    if (!isGitWorkspace) {
      return;
    }

    const targetCheckpointRef =
      targetTurnCount === 0
        ? checkpointRefForThreadTurn(input.threadId, 0)
        : thread.checkpoints.find(
            (checkpoint) => checkpoint.checkpointTurnCount === targetTurnCount,
          )?.checkpointRef;
    if (!targetCheckpointRef) {
      return yield* Effect.fail(
        new Error(`Checkpoint ref for edit replay turn ${targetTurnCount} is unavailable.`),
      );
    }

    const restored = yield* checkpointStore.restoreCheckpoint({
      cwd,
      checkpointRef: targetCheckpointRef,
      fallbackToHead: targetTurnCount === 0,
    });
    if (!restored) {
      return yield* Effect.fail(
        new Error(`Filesystem checkpoint is unavailable for edit replay turn ${targetTurnCount}.`),
      );
    }

    clearWorkspaceIndexCache(cwd);
  });

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly providerOptions?: ProviderStartOptions;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${threadId}' was not found in projection state.`),
      );
    }
    const shouldRegisterContextBootstrap =
      thread.session?.status !== "stopped" &&
      !suppressContextBootstrapOnNextStartThreadIds.has(threadId);

    const desiredRuntimeMode = options?.runtimeMode ?? thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const effectiveCwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const workspaceState = resolveThreadWorkspaceState({
      envMode: thread.envMode,
      worktreePath: thread.worktreePath,
    });
    if (workspaceState === "worktree-pending") {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' targets a worktree that has not been created yet.`,
      });
    }

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      providerService.startSession(threadId, {
        threadId,
        ...(preferredProvider ? { provider: preferredProvider } : {}),
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(options?.providerOptions !== undefined
          ? { providerOptions: options.providerOptions }
          : {}),
        ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
        runtimeMode: desiredRuntimeMode,
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    // Only reuse projected session state when the runtime still has a live session to attach to.
    const activeSession = yield* resolveActiveSession(threadId);
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = desiredRuntimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadSessionModelSelections.get(threadId);
      // Claude restarts resume via `--resume`, which replays the whole conversation
      // as uncached input tokens. Only spawn-fixed options (effort/settings) may
      // force that; model and context-window changes switch in-session via setModel.
      // When the dispatch cache has no entry (the session was started by a turn
      // without a selection), compare against the projected thread selection the
      // session was actually spawned from so spawn-fixed changes still restart.
      const shouldRestartForModelSelectionChange =
        requestedModelSelection !== undefined &&
        (currentProvider === "claudeAgent"
          ? claudeSelectionRequiresRestart(
              previousModelSelection ?? thread.modelSelection,
              requestedModelSelection,
            )
          : (currentProvider === "droid" || currentProvider === "grok") &&
            !Equal.equals(previousModelSelection, requestedModelSelection));

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange || runtimeModeChanged
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      if (
        shouldRegisterContextBootstrap &&
        currentProvider === "droid" &&
        !providerChanged &&
        resumeCursor === undefined
      ) {
        freshSessionContextBootstrapThreadIds.add(threadId);
      }
      threadSessionModelSelections.set(threadId, desiredModelSelection);
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
      return restartedSession.threadId;
    }

    if (providerService.forkThread && thread.forkSourceThreadId) {
      const forked = yield* providerService.forkThread({
        sourceThreadId: thread.forkSourceThreadId,
        threadId,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        modelSelection: desiredModelSelection,
        ...(options?.providerOptions !== undefined
          ? { providerOptions: options.providerOptions }
          : {}),
        runtimeMode: desiredRuntimeMode,
      });
      if (forked) {
        if (
          shouldRegisterContextBootstrap &&
          preferredProvider === "droid" &&
          thread.sidechatSourceThreadId
        ) {
          // Droid's ACP fork preserves the native session but does not guarantee
          // that the imported sidechat transcript is model-visible on its first prompt.
          sidechatContextBootstrapThreadIds.add(threadId);
        }
        threadSessionModelSelections.set(threadId, desiredModelSelection);
        const forkedSession =
          (yield* resolveActiveSession(threadId)) ??
          ({
            provider: preferredProvider,
            status: "ready",
            runtimeMode: desiredRuntimeMode,
            ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
            model: desiredModelSelection.model,
            threadId,
            ...(forked.resumeCursor !== undefined ? { resumeCursor: forked.resumeCursor } : {}),
            createdAt,
            updatedAt: createdAt,
          } satisfies ProviderSession);
        yield* bindSessionToThread(forkedSession);
        suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
        return threadId;
      }
      if (shouldRegisterContextBootstrap && !thread.sidechatSourceThreadId) {
        freshSessionContextBootstrapThreadIds.add(threadId);
      }
    }

    if (
      shouldRegisterContextBootstrap &&
      thread.sidechatSourceThreadId &&
      thread.forkSourceThreadId
    ) {
      sidechatContextBootstrapThreadIds.add(threadId);
    }

    const startedSession = yield* startProviderSession(undefined);
    // Record the exact selection the session was spawned with so later
    // restart-necessity checks compare against the live spawn state even when
    // the spawning dispatch carried no explicit model selection.
    threadSessionModelSelections.set(threadId, desiredModelSelection);
    yield* bindSessionToThread(startedSession);
    suppressContextBootstrapOnNextStartThreadIds.delete(threadId);
    return startedSession.threadId;
  });

  const dispatchTurnForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly skills?: ReadonlyArray<ProviderSkillReference>;
    readonly mentions?: ReadonlyArray<ProviderMentionReference>;
    readonly reviewTarget?: ProviderReviewTarget;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: "default" | "plan";
    readonly dispatchMode?: "queue" | "steer";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const activeSessionBeforeEnsure = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
    });
    if (input.providerOptions !== undefined) {
      threadProviderOptions.set(input.threadId, input.providerOptions);
    }
    if (input.modelSelection !== undefined) {
      threadSessionModelSelections.set(input.threadId, input.modelSelection);
    }
    const boundaryMessageText = thread.sidechatSourceThreadId
      ? wrapSidechatInput(input.messageText)
      : input.messageText;
    const shouldBootstrapHandoff =
      thread.handoff?.bootstrapStatus === "pending" &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId);
    const handoffBootstrapAvailableChars = availableProviderContextChars({
      tag: "handoff_context",
      messageText: boundaryMessageText,
      wrapLatestUserMessage: true,
    });
    const handoffBootstrapText =
      shouldBootstrapHandoff && handoffBootstrapAvailableChars > 0
        ? buildHandoffBootstrapText(thread, handoffBootstrapAvailableChars)
        : null;
    const selectedProvider =
      input.modelSelection?.provider ??
      threadSessionModelSelections.get(input.threadId)?.provider ??
      thread.session?.providerName ??
      thread.modelSelection.provider;
    const hasPendingPriorTranscriptBootstrap =
      freshSessionContextBootstrapThreadIds.has(input.threadId) ||
      rollbackContextBootstrapThreadIds.has(input.threadId);
    const shouldBootstrapSidechatContext =
      thread.sidechatSourceThreadId !== null &&
      sidechatContextBootstrapThreadIds.has(input.threadId) &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId) &&
      !shouldBootstrapHandoff &&
      !hasPendingPriorTranscriptBootstrap;
    const sidechatBootstrapAvailableChars = availableProviderContextChars({
      tag: "sidechat_context",
      messageText: boundaryMessageText,
      wrapLatestUserMessage: false,
    });
    const sidechatBootstrapText =
      shouldBootstrapSidechatContext && sidechatBootstrapAvailableChars > 0
        ? buildForkBootstrapText(thread, sidechatBootstrapAvailableChars)
        : null;
    const hasSidechatBootstrapContent =
      shouldBootstrapSidechatContext && listImportedForkMessages(thread).length > 0;
    if (
      input.reviewTarget === undefined &&
      hasSidechatBootstrapContent &&
      sidechatBootstrapAvailableChars === 0
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: selectedProvider as ProviderKind,
        method: "thread.turn.start",
        detail:
          "The latest message is too long to include the sidechat context required by this provider session. Shorten the message and retry.",
      });
    }
    const shouldBootstrapPriorTranscriptContext =
      (((selectedProvider === "kilo" || selectedProvider === "opencode") &&
        activeSessionBeforeEnsure === undefined) ||
        hasPendingPriorTranscriptBootstrap) &&
      !shouldBootstrapHandoff &&
      !shouldBootstrapSidechatContext;
    const hasPriorTranscriptBootstrapContent =
      shouldBootstrapPriorTranscriptContext &&
      listPriorTranscriptMessages(thread, input.messageId).length > 0;
    const priorTranscriptBootstrapAvailableChars = availableProviderContextChars({
      tag: "thread_context",
      messageText: boundaryMessageText,
      wrapLatestUserMessage: true,
    });
    if (
      input.reviewTarget === undefined &&
      hasPendingPriorTranscriptBootstrap &&
      shouldBootstrapPriorTranscriptContext &&
      priorTranscriptBootstrapAvailableChars === 0 &&
      hasPriorTranscriptBootstrapContent
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: selectedProvider as ProviderKind,
        method: "thread.turn.start",
        detail:
          "The latest message is too long to include the transcript context required by the restarted provider session. Shorten the message and retry.",
      });
    }
    const priorTranscriptBootstrapText =
      shouldBootstrapPriorTranscriptContext && priorTranscriptBootstrapAvailableChars > 0
        ? buildPriorTranscriptBootstrapText(
            thread,
            input.messageId,
            priorTranscriptBootstrapAvailableChars,
          )
        : null;
    const providerInput = handoffBootstrapText
      ? wrapProviderContext({
          tag: "handoff_context",
          contextText: handoffBootstrapText,
          messageText: boundaryMessageText,
          wrapLatestUserMessage: true,
        })
      : sidechatBootstrapText
        ? wrapProviderContext({
            tag: "sidechat_context",
            contextText: sidechatBootstrapText,
            messageText: boundaryMessageText,
            wrapLatestUserMessage: false,
          })
        : priorTranscriptBootstrapText
          ? wrapProviderContext({
              tag: "thread_context",
              contextText: priorTranscriptBootstrapText,
              messageText: boundaryMessageText,
              wrapLatestUserMessage: true,
            })
          : boundaryMessageText;
    // Portable skills fallback: providers that cannot load the referenced skill
    // file natively get the skill instructions inlined into the prompt.
    const skillInlineText =
      input.skills !== undefined && input.skills.length > 0
        ? yield* Effect.tryPromise(() =>
            buildInlineSkillInstructions({
              provider: selectedProvider as ProviderKind,
              skills: input.skills ?? [],
              maxChars: Math.max(
                0,
                PROVIDER_SEND_TURN_MAX_INPUT_CHARS - providerInput.length - 1_000,
              ),
            }),
          ).pipe(
            Effect.catch((error) =>
              Effect.logWarning("failed to inline portable skill instructions", {
                threadId: input.threadId,
                error,
              }).pipe(Effect.as("")),
            ),
          )
        : "";
    const providerInputWithSkills = skillInlineText
      ? `${providerInput}\n\n${skillInlineText}`
      : providerInput;
    const normalizedInput = toNonEmptyProviderInput(
      normalizeSkillMentionTextForProvider({
        provider: selectedProvider as ProviderKind,
        messageText: providerInputWithSkills,
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
      }),
    );
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection = input.modelSelection ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : requestedModelSelection;
    const sendQueuedProviderTurn = (messageText: string | undefined) =>
      providerService.sendTurn({
        threadId: input.threadId,
        ...(messageText ? { input: messageText } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      });

    const captureMessageStartCheckpoint = Effect.gen(function* () {
      if ((input.dispatchMode ?? "queue") === "steer") {
        return;
      }

      const currentThread = yield* resolveThread(input.threadId);
      if (!currentThread) {
        return;
      }

      const cwd = yield* resolveProjectedThreadWorkspaceCwd(currentThread);
      if (!cwd || !(yield* checkpointStore.isGitRepository(cwd))) {
        return;
      }

      // Capture before provider dispatch so the later turn diff is bounded by
      // the user's submit moment, not early provider edits. skipIfExists keeps
      // a backup baseline from CheckpointReactor as the first-writer winner.
      yield* checkpointStore.captureCheckpoint({
        cwd,
        checkpointRef: checkpointRefForThreadMessageStart(
          input.threadId,
          MessageId.makeUnsafe(input.messageId),
        ),
        skipIfExists: true,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to capture provider turn start checkpoint", {
          threadId: input.threadId,
          messageId: input.messageId,
          cause: Cause.pretty(cause),
        }),
      ),
    );

    // Both Git and non-Git Studio baselines must finish before provider execution
    // starts. Otherwise a fast command can write a file while the baseline scan is
    // still running and make that output look unchanged at turn completion.
    const capturePreTurnBaselines = Effect.all(
      [
        captureMessageStartCheckpoint,
        studioOutputReactor.captureBaselineBeforeTurn(input.threadId),
      ],
      { concurrency: 2, discard: true },
    );
    const cancelPendingStudioBaseline = studioOutputReactor.cancelPendingTurnBaseline(
      input.threadId,
    );
    let pendingContextBootstrapAttempt: PendingContextBootstrapAttempt | undefined;
    let startedTurn: ProviderTurnStartResult | undefined;

    if (input.reviewTarget !== undefined) {
      yield* capturePreTurnBaselines;
      startedTurn = yield* providerService
        .startReview({
          threadId: input.threadId,
          target: input.reviewTarget,
        })
        .pipe(Effect.onError(() => cancelPendingStudioBaseline));
    } else if (input.dispatchMode === "steer") {
      startedTurn = yield* providerService.steerTurn({
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      });
    } else {
      yield* capturePreTurnBaselines;
      pendingContextBootstrapAttempt =
        activeSession?.provider === "droid" &&
        (sidechatBootstrapText !== null || priorTranscriptBootstrapText !== null)
          ? {
              clearSidechat: sidechatBootstrapText !== null,
              clearPriorTranscript: priorTranscriptBootstrapText !== null,
            }
          : undefined;
      if (pendingContextBootstrapAttempt) {
        pendingContextBootstrapAttempts.set(input.threadId, pendingContextBootstrapAttempt);
      }
      const sentTurn = yield* sendQueuedProviderTurn(normalizedInput).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (selectedProvider !== "claudeAgent" || !isStaleClaudeResumeError(error)) {
              return yield* Effect.fail(error);
            }

            // Claude cannot continue from a missing native session; clear the
            // dead cursor and replay once with Synara transcript context.
            yield* clearStaleProviderResumeState({
              threadId: input.threadId,
              cause: error,
            });
            yield* ensureSessionForThread(input.threadId, input.createdAt, {
              ...(input.modelSelection !== undefined
                ? { modelSelection: input.modelSelection }
                : {}),
              ...(input.providerOptions !== undefined
                ? { providerOptions: input.providerOptions }
                : {}),
              ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
            });

            const retryBootstrapText =
              priorTranscriptBootstrapAvailableChars > 0
                ? buildPriorTranscriptBootstrapText(
                    thread,
                    input.messageId,
                    priorTranscriptBootstrapAvailableChars,
                  )
                : null;
            const retryProviderInput = retryBootstrapText
              ? wrapProviderContext({
                  tag: "thread_context",
                  contextText: retryBootstrapText,
                  messageText: boundaryMessageText,
                  wrapLatestUserMessage: true,
                })
              : boundaryMessageText;
            const retryProviderInputWithSkills = skillInlineText
              ? `${retryProviderInput}\n\n${skillInlineText}`
              : retryProviderInput;
            const retryNormalizedInput = toNonEmptyProviderInput(
              normalizeSkillMentionTextForProvider({
                provider: selectedProvider as ProviderKind,
                messageText: retryProviderInputWithSkills,
                ...(input.skills !== undefined ? { skills: input.skills } : {}),
              }),
            );

            yield* Effect.logWarning(
              "provider command reactor retrying claude turn after stale resume",
              {
                threadId: input.threadId,
                messageId: input.messageId,
                bootstrappedPriorTranscript: retryBootstrapText !== null,
              },
            );
            return yield* sendQueuedProviderTurn(retryNormalizedInput);
          }),
        ),
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => {
              if (
                pendingContextBootstrapAttempt &&
                pendingContextBootstrapAttempts.get(input.threadId) ===
                  pendingContextBootstrapAttempt
              ) {
                pendingContextBootstrapAttempts.delete(input.threadId);
              }
            });
            yield* cancelPendingStudioBaseline;
          }),
        ),
      );
      startedTurn = sentTurn;
      if (pendingContextBootstrapAttempt) {
        pendingContextBootstrapAttempt.turnId = sentTurn.turnId;
        const terminalEvent = pendingContextBootstrapAttempt.terminalEvent;
        if (terminalEvent?.turnId === sentTurn.turnId) {
          pendingContextBootstrapAttempts.delete(input.threadId);
          completePendingContextBootstrapAttempt(
            input.threadId,
            pendingContextBootstrapAttempt,
            terminalEvent,
          );
        }
      }
    }
    if (handoffBootstrapText && thread.handoff !== null && input.reviewTarget === undefined) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("handoff-bootstrap-complete"),
        threadId: input.threadId,
        handoff: {
          ...thread.handoff,
          bootstrapStatus: "completed",
        },
      });
    }
    if (
      shouldBootstrapSidechatContext &&
      input.reviewTarget === undefined &&
      pendingContextBootstrapAttempt === undefined &&
      (sidechatBootstrapText !== null || !hasSidechatBootstrapContent)
    ) {
      sidechatContextBootstrapThreadIds.delete(input.threadId);
    }
    if (
      shouldBootstrapPriorTranscriptContext &&
      input.reviewTarget === undefined &&
      pendingContextBootstrapAttempt === undefined &&
      (priorTranscriptBootstrapText !== null || !hasPriorTranscriptBootstrapContent)
    ) {
      freshSessionContextBootstrapThreadIds.delete(input.threadId);
      rollbackContextBootstrapThreadIds.delete(input.threadId);
      sidechatContextBootstrapThreadIds.delete(input.threadId);
    }
    return startedTurn;
  });

  const renameTemporaryWorktreeBranch = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly oldBranch: string;
    readonly targetBranch: string;
  }) {
    if (input.targetBranch === input.oldBranch) {
      return;
    }

    const renamed = yield* git.renameBranch({
      cwd: input.cwd,
      oldBranch: input.oldBranch,
      newBranch: input.targetBranch,
    });
    yield* git.publishBranch({ cwd: input.cwd, branch: renamed.branch }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to publish renamed branch", {
          threadId: input.threadId,
          cwd: input.cwd,
          branch: renamed.branch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("worktree-branch-rename"),
      threadId: input.threadId,
      branch: renamed.branch,
      worktreePath: input.cwd,
      associatedWorktreePath: input.cwd,
      associatedWorktreeBranch: renamed.branch,
      associatedWorktreeRef: renamed.branch,
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const userMessages = thread.messages.filter(
      (message) => message.role === "user" && message.source === "native",
    );
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    const textGenerationInput = yield* resolveThreadTextGenerationInput({
      threadId: input.threadId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
    });
    if (!textGenerationInput) {
      const targetBranch = buildGeneratedWorktreeBranchName(
        input.messageText.trim() || attachmentTitleSeed(attachments[0]) || "",
      );
      yield* renameTemporaryWorktreeBranch({
        threadId: input.threadId,
        cwd,
        oldBranch,
        targetBranch,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to apply fallback worktree branch name",
            { threadId: input.threadId, cwd, oldBranch, targetBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
      return;
    }
    const branchNameGenerationInput: BranchNameGenerationInput = {
      cwd,
      message: input.messageText,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...("model" in textGenerationInput && typeof textGenerationInput.model === "string"
        ? { model: textGenerationInput.model }
        : {}),
      ...("modelSelection" in textGenerationInput && textGenerationInput.modelSelection
        ? { modelSelection: textGenerationInput.modelSelection }
        : {}),
      ...("providerOptions" in textGenerationInput && textGenerationInput.providerOptions
        ? { providerOptions: textGenerationInput.providerOptions }
        : {}),
    };
    yield* textGeneration.generateBranchName(branchNameGenerationInput).pipe(
      Effect.catch((error) =>
        Effect.logWarning(
          "provider command reactor failed to generate worktree branch name; skipping rename",
          { threadId: input.threadId, cwd, oldBranch, reason: error.message },
        ),
      ),
      Effect.flatMap((generated) => {
        if (!generated) return Effect.void;

        const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
        return renameTemporaryWorktreeBranch({
          threadId: input.threadId,
          cwd,
          oldBranch,
          targetBranch,
        });
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  // Only auto-rename placeholder titles that still reflect the first-turn draft state.
  const maybeGenerateAndRenameThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }

    const userMessages = thread.messages.filter(
      (message) => message.role === "user" && message.source === "native",
    );
    if (userMessages.length !== 1 || userMessages[0]?.id !== input.messageId) {
      return;
    }

    const fallbackTitle = buildPromptThreadTitleFallback(
      input.messageText.trim() || attachmentTitleSeed(input.attachments?.[0]) || "",
    );
    const currentTitle = thread.title.trim();
    if (!isGenericChatThreadTitle(currentTitle) && currentTitle !== fallbackTitle) {
      return;
    }
    const cwd = yield* resolveProjectedThreadWorkspaceCwd(thread);
    const textGenerationInput = yield* resolveThreadTextGenerationInput({
      threadId: input.threadId,
      ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      useConfiguredFallback: true,
    });
    if (!textGenerationInput) {
      if (fallbackTitle !== currentTitle) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-fallback-rename"),
          threadId: input.threadId,
          title: fallbackTitle,
        });
      }
      return;
    }
    const textGenerationSelection =
      "modelSelection" in textGenerationInput ? textGenerationInput.modelSelection : null;
    const textGenerationModel =
      textGenerationSelection?.model ??
      ("model" in textGenerationInput ? textGenerationInput.model : null);
    const textGenerationProviderOptions =
      "providerOptions" in textGenerationInput ? textGenerationInput.providerOptions : undefined;
    yield* Effect.logDebug("provider command reactor generating thread title", {
      threadId: input.threadId,
      cwd,
      threadProvider: thread.modelSelection.provider,
      threadModel: thread.modelSelection.model,
      requestedProvider: input.modelSelection?.provider ?? null,
      requestedModel: input.modelSelection?.model ?? null,
      textGenerationProvider: textGenerationSelection?.provider ?? null,
      textGenerationModel,
      textGenerationOptions: textGenerationSelection?.options ?? null,
      hasProviderOptions: Boolean(textGenerationProviderOptions),
    });
    const titleGenerationInput: ThreadTitleGenerationInput = {
      cwd: cwd ?? process.cwd(),
      message: input.messageText,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...("model" in textGenerationInput && typeof textGenerationInput.model === "string"
        ? { model: textGenerationInput.model }
        : {}),
      ...("modelSelection" in textGenerationInput && textGenerationInput.modelSelection
        ? { modelSelection: textGenerationInput.modelSelection }
        : {}),
      ...("providerOptions" in textGenerationInput && textGenerationInput.providerOptions
        ? { providerOptions: textGenerationInput.providerOptions }
        : {}),
    };
    const nextTitle = yield* textGeneration.generateThreadTitle(titleGenerationInput).pipe(
      Effect.map((generated) => generated.title),
      Effect.catch((error) =>
        Effect.logWarning("provider command reactor failed to generate thread title", {
          threadId: input.threadId,
          cwd,
          reason: error.message,
          threadProvider: thread.modelSelection.provider,
          threadModel: thread.modelSelection.model,
          requestedProvider: input.modelSelection?.provider ?? null,
          requestedModel: input.modelSelection?.model ?? null,
          textGenerationProvider: textGenerationSelection?.provider ?? null,
          textGenerationModel,
          textGenerationOptions: textGenerationSelection?.options ?? null,
        }).pipe(Effect.as(fallbackTitle)),
      ),
    );

    if (nextTitle === currentTitle) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId("thread-title-rename"),
      threadId: input.threadId,
      title: nextTitle,
    });
  });

  const processTurnStartRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.payload.threadId))?.id ?? event.payload.threadId;
    const matchesEvent = (entry: PendingQueuedDispatch | undefined) =>
      entry?.queuedThreadId === (event.payload.threadId as string) &&
      entry.messageId === event.payload.messageId;
    const reservationAtStart = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    const isPendingQueuedDispatch = matchesEvent(reservationAtStart);
    const ownsReservation = (entry: PendingQueuedDispatch | undefined) =>
      isPendingQueuedDispatch && entry === reservationAtStart;
    const clearPendingQueuedDispatch = Effect.sync(() => {
      if (ownsReservation(pendingQueuedDispatchBySessionThread.get(sessionThreadId))) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    });
    const bindPendingQueuedDispatchToTurn = Effect.fnUntraced(function* (turnId: TurnId) {
      const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
      if (reservation === undefined || !ownsReservation(reservation)) {
        return;
      }
      reservation.releaseOnTurnId = turnId;
      const completedBeforeBinding = reservation.pendingTerminalTurnIds?.has(turnId);
      delete reservation.pendingTerminalTurnIds;
      if (completedBeforeBinding) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
        yield* drainQueuedTurnsForSession(event.payload.threadId);
      }
    });
    try {
      const key = turnStartKeyForEvent(event);
      if (yield* hasHandledTurnStartRecently(key)) {
        return;
      }

      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }

      const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
      if (!message || message.role !== "user") {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
          turnId: null,
          createdAt: event.payload.createdAt,
        });
        return;
      }

      // The decider routes turn starts from the projected session, which can lag
      // the runtime: a message dispatched right as another turn begins (e.g. the
      // gap between a steer interrupt and the steered turn's start) would race a
      // live provider turn. Codex steers ride the live turn natively; everything
      // else re-queues and is promoted when the live turn settles.
      const providerName = thread.session?.providerName ?? thread.modelSelection.provider;
      const liveTurnId = yield* resolveLiveProviderTurnId(event.payload.threadId);
      const hasLiveTurn = liveTurnId !== undefined;
      // Steering is only meaningful against a live turn. The projection can
      // lag the runtime in the other direction too (turn already settled but
      // still projected as running), so recheck live state and dispatch a
      // settled codex "steer" as a normal queued turn — the native steer path
      // would skip the turn-start checkpoint.
      const isCodexSteer =
        event.payload.dispatchMode === "steer" && providerName === "codex" && hasLiveTurn;
      if (!isCodexSteer && hasLiveTurn) {
        yield* enqueueQueuedTurnStart(event.payload);
        // The promotion raced another live turn and was re-queued. Release
        // only when that exact blocking turn settles, not on any late
        // terminal event for the shared provider session.
        yield* bindPendingQueuedDispatchToTurn(liveTurnId);
        if (event.payload.dispatchMode === "steer") {
          // Preserve steer semantics: jump the queue (enqueue unshifts steers)
          // and ask the live turn to stop so the steer dispatches next.
          yield* interruptProviderTurn({
            threadId: event.payload.threadId,
            createdAt: event.payload.createdAt,
          });
        }
        return;
      }

      // Surface the upcoming work immediately: provider session init can take
      // seconds (e.g. Cursor), and without an early status the thread reads as
      // idle until the runtime's first event. Mirrors the message-edit-resend
      // path. Never touches a live session — a steer turn on a running Codex
      // session must keep its running state and activeTurnId. Keeps the existing
      // session's runtimeMode: ensureSessionForThread detects mode changes by
      // comparing against it, and adopting the requested mode here would mask
      // the restart.
      if (thread.session?.status !== "running" && thread.session?.status !== "starting") {
        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            threadId: event.payload.threadId,
            status: "starting",
            providerName: thread.session?.providerName ?? thread.modelSelection.provider,
            runtimeMode:
              thread.session?.runtimeMode ?? event.payload.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            activeTurnId: null,
            lastError: null,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
      }

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
      }).pipe(Effect.forkScoped);
      yield* maybeGenerateAndRenameThreadTitleForFirstTurn({
        threadId: event.payload.threadId,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
      }).pipe(Effect.forkScoped);
      // Only a codex steer against a genuinely live turn keeps steer
      // semantics; anything else that reaches direct dispatch runs as a
      // normal queued turn (with its turn-start checkpoint).
      const immediateDispatchMode =
        event.payload.dispatchMode === "steer" && !isCodexSteer
          ? "queue"
          : event.payload.dispatchMode;
      const editResendKey = editResendTurnStartKey(event.payload.threadId, event.payload.messageId);

      const startedTurn = yield* dispatchTurnForThread({
        threadId: event.payload.threadId,
        messageId: message.id,
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(message.skills !== undefined ? { skills: message.skills } : {}),
        ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
        ...(event.payload.modelSelection !== undefined
          ? { modelSelection: event.payload.modelSelection }
          : {}),
        ...(event.payload.providerOptions !== undefined
          ? { providerOptions: event.payload.providerOptions }
          : {}),
        ...(event.payload.runtimeMode !== undefined
          ? { runtimeMode: event.payload.runtimeMode }
          : {}),
        ...(event.payload.reviewTarget !== undefined
          ? { reviewTarget: event.payload.reviewTarget }
          : {}),
        interactionMode: event.payload.interactionMode,
        dispatchMode: immediateDispatchMode,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const detail = Cause.pretty(cause);
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.turn.start.failed",
              summary: "Provider turn start failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
            });
            yield* setThreadSessionError({
              threadId: event.payload.threadId,
              runtimeMode: event.payload.runtimeMode,
              detail,
              createdAt: event.payload.createdAt,
            });
          }),
        ),
        Effect.ensuring(Effect.sync(() => editResendTurnStartKeys.delete(editResendKey))),
      );
      if (startedTurn && isPendingQueuedDispatch) {
        yield* bindPendingQueuedDispatchToTurn(startedTurn.turnId);
      }
    } finally {
      const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
      if (
        isPendingQueuedDispatch &&
        reservation !== undefined &&
        ownsReservation(reservation) &&
        reservation.releaseOnTurnId === undefined &&
        !(yield* hasQueuedTurnStart(event.payload.threadId, event.payload.messageId)) &&
        !(yield* hasLiveProviderTurn(event.payload.threadId))
      ) {
        yield* clearPendingQueuedDispatch;
        yield* drainQueuedTurnsForSession(event.payload.threadId);
      }
    }
  });

  const processTurnQueued = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>,
  ) {
    yield* enqueueQueuedTurnStart(event.payload);
    // Recovery drain: if the provider turn settled between the decider's
    // (stale) running check and this enqueue, the terminal
    // `turn.completed`/`turn.aborted` event has already been consumed and will
    // never drain this queue — the message would be stuck forever. Re-check
    // live provider state and promote immediately.
    if (!(yield* hasLiveProviderTurn(event.payload.threadId))) {
      yield* drainQueuedTurnsForThread(event.payload.threadId);
    }
  });

  // Promote the next queued message only after the active provider turn settles.
  const drainQueuedTurnsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessionThreadId = (yield* resolveProviderSessionThread(threadId))?.id ?? threadId;
    if (
      drainingQueuedTurns.has(threadId) ||
      pendingQueuedDispatchBySessionThread.has(sessionThreadId)
    ) {
      return;
    }
    drainingQueuedTurns.add(threadId);
    try {
      const nextQueuedTurn = yield* dequeueQueuedTurnStart(threadId);
      if (!nextQueuedTurn) {
        return;
      }
      pendingQueuedDispatchBySessionThread.set(sessionThreadId, {
        queuedThreadId: threadId,
        messageId: nextQueuedTurn.messageId,
      });
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.dispatch-queued",
          commandId: serverCommandId("dispatch-queued-turn"),
          threadId,
          messageId: nextQueuedTurn.messageId,
          ...(nextQueuedTurn.modelSelection !== undefined
            ? { modelSelection: nextQueuedTurn.modelSelection }
            : {}),
          ...(nextQueuedTurn.providerOptions !== undefined
            ? { providerOptions: nextQueuedTurn.providerOptions }
            : {}),
          ...(nextQueuedTurn.reviewTarget !== undefined
            ? { reviewTarget: nextQueuedTurn.reviewTarget }
            : {}),
          ...(nextQueuedTurn.assistantDeliveryMode !== undefined
            ? { assistantDeliveryMode: nextQueuedTurn.assistantDeliveryMode }
            : {}),
          dispatchMode: nextQueuedTurn.dispatchMode,
          runtimeMode: nextQueuedTurn.runtimeMode,
          interactionMode: nextQueuedTurn.interactionMode,
          ...(nextQueuedTurn.sourceProposedPlan !== undefined
            ? { sourceProposedPlan: nextQueuedTurn.sourceProposedPlan }
            : {}),
          createdAt: nextQueuedTurn.createdAt,
        })
        .pipe(
          // A failed promotion must not leave the in-flight marker behind, or
          // every future drain for this session would be blocked forever.
          Effect.onError(() =>
            Effect.sync(() => pendingQueuedDispatchBySessionThread.delete(sessionThreadId)),
          ),
        );
    } finally {
      drainingQueuedTurns.delete(threadId);
    }
  });

  const drainQueuedTurnsForSession = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessionThreadId = (yield* resolveProviderSessionThread(threadId))?.id ?? threadId;
    const queuedThreadIds = new Set<ThreadId>([threadId]);
    for (const queuedThreadId of [...queuedTurnStartsByThread.keys()]) {
      const queuedThread = ThreadId.makeUnsafe(queuedThreadId);
      const providerThread = yield* resolveProviderSessionThread(queuedThread);
      const queuedSessionThreadId = providerThread?.id ?? queuedThread;
      if (queuedSessionThreadId === sessionThreadId) {
        queuedThreadIds.add(queuedThread);
      }
    }
    for (const queuedThreadId of queuedThreadIds) {
      yield* drainQueuedTurnsForThread(queuedThreadId);
    }
  });

  const processQueueDrainEvent = Effect.fnUntraced(function* (event: ProviderQueueDrainEvent) {
    observePendingContextBootstrapTerminalEvent(event);
    const sessionThreadId =
      (yield* resolveProviderSessionThread(event.threadId))?.id ?? event.threadId;
    const reservation = pendingQueuedDispatchBySessionThread.get(sessionThreadId);
    if (reservation) {
      if (reservation.releaseOnTurnId === undefined) {
        const terminalTurnIds = reservation.pendingTerminalTurnIds ?? new Set<TurnId>();
        if (event.turnId !== undefined) {
          terminalTurnIds.add(event.turnId);
        }
        reservation.pendingTerminalTurnIds = terminalTurnIds;
        return;
      }
      if (reservation.releaseOnTurnId !== event.turnId) {
        return;
      }
      pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
    }
    // Child subagent threads queue under their own id but share the parent's
    // provider session, and terminal runtime events carry the session-owning
    // thread id — drain every queue bound to this session.
    yield* drainQueuedTurnsForSession(event.threadId);
  });

  const interruptProviderTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId | undefined;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const providerThread = yield* resolveProviderSessionThread(input.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: input.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: input.turnId ?? null,
        createdAt: input.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
    const turnId = input.turnId ?? thread.session?.activeTurnId ?? undefined;
    yield* providerService.interruptTurn({
      threadId: providerThread.id,
      ...(turnId ? { turnId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
    });
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    yield* interruptProviderTurn({
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      createdAt: event.payload.createdAt,
    });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (providerThread?.session?.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }
    const providerThreadId = providerThread?.id ?? event.payload.threadId;

    yield* providerService
      .respondToRequest({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? buildStalePendingRequestFailureDetail("approval", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (providerThread?.session?.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.user-input.respond.failed",
        summary: "Provider user input response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }
    const providerThreadId = providerThread?.id ?? event.payload.threadId;

    yield* providerService
      .respondToUserInput({
        threadId: providerThreadId,
        requestId: event.payload.requestId,
        answers: event.payload.answers,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input response failed",
            detail: isUnknownPendingUserInputRequestError(cause)
              ? buildStalePendingRequestFailureDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  const processConversationRollbackRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.conversation-rollback-requested" }>,
  ) {
    if (event.payload.numTurns === 0) {
      const thread = yield* resolveThread(event.payload.threadId);
      yield* orchestrationEngine.dispatch({
        type: "thread.conversation.rollback.complete",
        commandId: serverCommandId("conversation-rollback-complete"),
        threadId: event.payload.threadId,
        messageId: event.payload.messageId,
        numTurns: event.payload.numTurns,
        removedTurnIds: thread
          ? removedTurnIdsFromMessage(thread.messages, event.payload.messageId)
          : [],
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null
    ) {
      const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
      yield* providerService.interruptTurn({
        threadId: providerThread.id,
        turnId: providerThread.session.activeTurnId,
        ...(providerThreadId ? { providerThreadId } : {}),
      });
    }

    yield* rollbackProviderConversationForEdit({
      threadId: event.payload.threadId,
      numTurns: event.payload.numTurns,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("conversation-rollback-complete"),
      threadId: event.payload.threadId,
      messageId: event.payload.messageId,
      numTurns: event.payload.numTurns,
      removedTurnIds: thread
        ? removedTurnIdsFromMessage(thread.messages, event.payload.messageId)
        : [],
      createdAt: event.payload.createdAt,
    });
  });

  const processMessageEditResendPayload = Effect.fnUntraced(function* (
    payload: Extract<
      ProviderIntentEvent,
      { type: "thread.message-edit-resend-requested" }
    >["payload"],
    options?: {
      readonly skipProviderRollback?: boolean;
      readonly preserveQueuedTurns?: boolean;
      readonly preserveThreadSession?: boolean;
      readonly activeTurnId?: TurnId | null;
    },
  ) {
    if (options?.preserveQueuedTurns !== true) {
      queuedTurnStartsByThread.delete(payload.threadId);
      yield* clearEditResendTurnStartKeysForThread(payload.threadId);
    } else {
      yield* removeQueuedTurnStart(payload.threadId, payload.messageId);
    }
    const originalThread = yield* resolveThread(payload.threadId);
    const originalMessage = originalThread?.messages.find(
      (message) => message.id === payload.messageId,
    );
    if (!originalThread || !originalMessage || originalMessage.role !== "user") {
      return yield* Effect.fail(
        new Error(`Cannot edit missing user message '${payload.messageId}'.`),
      );
    }
    const editTarget =
      payload.removedTurnIds !== undefined && payload.rollbackTurnCount !== undefined
        ? {
            editable: true as const,
            messageId: payload.messageId,
            messageIndex: originalThread.messages.findIndex(
              (message) => message.id === payload.messageId,
            ),
            mode: payload.rollbackTurnCount > 0 ? ("rollback" as const) : ("active" as const),
            rollbackTurnCount: payload.rollbackTurnCount,
            removedTurnIds: payload.removedTurnIds,
          }
        : resolveTailUserMessageEditTarget({
            messages: originalThread.messages,
            messageId: payload.messageId,
            activeTurnId:
              options?.activeTurnId ??
              (originalThread.session?.status === "running"
                ? (originalThread.session.activeTurnId ?? null)
                : null),
          });
    if (!editTarget.editable) {
      return yield* Effect.fail(
        new Error(
          `Cannot edit non-tail user message '${payload.messageId}': ${editTarget.reason}.`,
        ),
      );
    }
    if (options?.skipProviderRollback !== true && editTarget.rollbackTurnCount > 0) {
      yield* rollbackProviderConversationForEdit({
        threadId: payload.threadId,
        numTurns: editTarget.rollbackTurnCount,
      });
    }
    yield* restoreWorkspaceBeforeEditReplay({
      threadId: payload.threadId,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.conversation.rollback.complete",
      commandId: serverCommandId("message-edit-rollback-complete"),
      threadId: payload.threadId,
      messageId: payload.messageId,
      numTurns: editTarget.rollbackTurnCount,
      removedTurnIds: editTarget.removedTurnIds.map((turnId) => TurnId.makeUnsafe(turnId)),
      skipAttachmentPrune: true,
      createdAt: payload.createdAt,
    });

    const thread = yield* resolveThread(payload.threadId);
    if (thread && options?.preserveThreadSession !== true) {
      yield* setThreadSession({
        threadId: payload.threadId,
        session: {
          threadId: payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: payload.createdAt,
        },
        createdAt: payload.createdAt,
      });
    }

    editResendTurnStartKeys.add(editResendTurnStartKey(payload.threadId, payload.messageId));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("message-edit-resend-turn-start"),
      threadId: payload.threadId,
      message: {
        messageId: payload.messageId,
        role: "user",
        text: payload.text,
        attachments: originalMessage.attachments ?? [],
        ...(originalMessage.skills !== undefined ? { skills: originalMessage.skills } : {}),
        ...(originalMessage.mentions !== undefined ? { mentions: originalMessage.mentions } : {}),
      },
      ...(payload.modelSelection !== undefined ? { modelSelection: payload.modelSelection } : {}),
      ...(payload.providerOptions !== undefined
        ? { providerOptions: payload.providerOptions }
        : {}),
      ...(payload.assistantDeliveryMode !== undefined
        ? { assistantDeliveryMode: payload.assistantDeliveryMode }
        : {}),
      dispatchMode: "queue",
      runtimeMode: payload.runtimeMode,
      interactionMode: payload.interactionMode,
      createdAt: payload.createdAt,
    });
  });

  const stopActiveProviderRuntimeForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
  }) {
    const thread = yield* resolveThread(input.threadId);
    const provider = thread
      ? Schema.is(ProviderKind)(thread.session?.providerName)
        ? thread.session?.providerName
        : thread.modelSelection.provider
      : undefined;
    const rebuildsContext =
      provider !== undefined &&
      (yield* providerService.getCapabilities(provider)).conversationRollback === "restart-session";
    if (rebuildsContext && providerService.clearSessionResumeCursor) {
      yield* providerService.clearSessionResumeCursor({ threadId: input.threadId });
      rollbackContextBootstrapThreadIds.add(input.threadId);
      return;
    }
    if (providerService.stopRuntimeSession) {
      yield* providerService.stopRuntimeSession({ threadId: input.threadId });
      return;
    }
    yield* providerService.stopSession({ threadId: input.threadId });
  });

  const processMessageEditResendRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.message-edit-resend-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    const activeTurnId =
      providerThread?.session?.status === "running"
        ? (providerThread.session.activeTurnId ?? null)
        : null;
    const isQueuedMessageEdit = yield* hasQueuedTurnStart(
      event.payload.threadId,
      event.payload.messageId,
    );
    if (thread && !isQueuedMessageEdit) {
      yield* setThreadSession({
        threadId: event.payload.threadId,
        session: {
          threadId: event.payload.threadId,
          status: "starting",
          providerName: thread.session?.providerName ?? thread.modelSelection.provider,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: event.payload.createdAt,
        },
        createdAt: event.payload.createdAt,
      });
    }
    if (
      thread &&
      providerThread?.session?.status === "running" &&
      providerThread.session.activeTurnId !== null &&
      !isQueuedMessageEdit
    ) {
      // Edits should replay from the last stable cursor, not wait for each
      // provider's interrupt lifecycle to settle.
      yield* stopActiveProviderRuntimeForEdit({ threadId: providerThread.id });
      yield* processMessageEditResendPayload(event.payload, {
        skipProviderRollback: true,
        activeTurnId,
      });
      return;
    }

    yield* processMessageEditResendPayload(event.payload, {
      ...(isQueuedMessageEdit ? { skipProviderRollback: true } : {}),
      preserveQueuedTurns: isQueuedMessageEdit,
      preserveThreadSession: isQueuedMessageEdit,
      activeTurnId,
    });
  });

  const processSessionStopRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    queuedTurnStartsByThread.delete(thread.id);
    yield* clearEditResendTurnStartKeysForThread(thread.id);
    drainingQueuedTurns.delete(thread.id);
    // Reservations are keyed by session-owning thread but may belong to a
    // stopping child's queued message; drop both directions.
    for (const [sessionThreadId, reservation] of pendingQueuedDispatchBySessionThread) {
      if (sessionThreadId === (thread.id as string) || reservation.queuedThreadId === thread.id) {
        pendingQueuedDispatchBySessionThread.delete(sessionThreadId);
      }
    }
    clearPendingContextBootstraps(thread.id);
    suppressContextBootstrapOnNextStartThreadIds.add(thread.id);

    const now = event.payload.createdAt;
    const providerThreadId =
      providerThread !== null
        ? resolveSubagentProviderThreadId(thread.id, providerThread.id)
        : undefined;
    const isChildProviderRuntime =
      providerThread !== null && providerThread.id !== thread.id && providerThreadId !== undefined;

    // Child subagents share the parent provider session, so stop requests need
    // to interrupt the child turn rather than terminate the whole session.
    if (
      isChildProviderRuntime &&
      thread.session &&
      thread.session.status === "running" &&
      thread.session.activeTurnId !== null &&
      providerThread.session &&
      providerThread.session.status !== "stopped"
    ) {
      yield* providerService.interruptTurn({
        threadId: providerThread.id,
        turnId: thread.session.activeTurnId,
        providerThreadId,
      });

      yield* setThreadSession({
        threadId: thread.id,
        session: {
          threadId: thread.id,
          status: "interrupted",
          providerName: thread.session.providerName ?? null,
          runtimeMode: thread.session.runtimeMode ?? DEFAULT_RUNTIME_MODE,
          // Preserve the active turn until the provider emits the terminal child event.
          activeTurnId: thread.session.activeTurnId,
          lastError: null,
          updatedAt: now,
        },
        createdAt: now,
      });
      return;
    }

    const ownsProviderSession = providerThread !== null && providerThread.id === thread.id;
    if (thread.session && thread.session.status !== "stopped" && ownsProviderSession) {
      yield* providerService.stopSession({ threadId: providerThread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = (event: ProviderIntentEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.session-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (
            thread &&
            event.payload.session.status !== "stopped" &&
            !threadSessionModelSelections.has(event.payload.threadId)
          ) {
            threadSessionModelSelections.set(event.payload.threadId, thread.modelSelection);
          }
          return;
        }
        case "thread.created":
          threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (event.payload.modelSelection === undefined) {
            return;
          }

          if (!thread?.session || thread.session.status === "stopped") {
            threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
            return;
          }

          if (thread.session.activeTurnId !== null) {
            // The current runtime still owns the previous spawn profile. The
            // projected thread now carries the desired selection; compare them
            // when the next turn ensures the session.
            return;
          }

          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            modelSelection: event.payload.modelSelection,
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
          });
          threadSessionModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        }
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            modelSelection: thread.modelSelection,
            runtimeMode: event.payload.runtimeMode,
          });
          return;
        }
        case "thread.turn-queued":
          yield* processTurnQueued(event);
          return;
        case "thread.turn-start-requested":
          yield* processTurnStartRequested(event);
          return;
        case "thread.turn-interrupt-requested":
          yield* processTurnInterruptRequested(event);
          return;
        case "thread.approval-response-requested":
          yield* processApprovalResponseRequested(event);
          return;
        case "thread.user-input-response-requested":
          yield* processUserInputResponseRequested(event);
          return;
        case "thread.conversation-rollback-requested":
          yield* processConversationRollbackRequested(event);
          return;
        case "thread.message-edit-resend-requested":
          yield* processMessageEditResendRequested(event).pipe(
            Effect.catchCause((cause) =>
              setThreadSessionError({
                threadId: event.payload.threadId,
                runtimeMode: event.payload.runtimeMode,
                detail: Cause.pretty(cause),
                createdAt: event.payload.createdAt,
              }),
            ),
          );
          return;
        case "thread.session-stop-requested":
          yield* processSessionStopRequested(event);
          return;
      }
    });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
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
    processQueueDrainEvent(event).pipe(
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

  const start: ProviderCommandReactorShape["start"] = seedThreadModelSelections.pipe(
    Effect.andThen(
      Effect.all([
        Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
          if (
            event.type !== "thread.created" &&
            event.type !== "thread.meta-updated" &&
            event.type !== "thread.session-set" &&
            event.type !== "thread.runtime-mode-set" &&
            event.type !== "thread.turn-queued" &&
            event.type !== "thread.turn-start-requested" &&
            event.type !== "thread.turn-interrupt-requested" &&
            event.type !== "thread.approval-response-requested" &&
            event.type !== "thread.user-input-response-requested" &&
            event.type !== "thread.conversation-rollback-requested" &&
            event.type !== "thread.message-edit-resend-requested" &&
            event.type !== "thread.session-stop-requested"
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
      ]).pipe(Effect.asVoid),
    ),
  );

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
