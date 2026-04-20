import {
  type ChatAttachment,
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderMentionReference,
  type ProviderRuntimeEvent,
  ProviderKind,
  type ProviderReviewTarget,
  type ProviderStartOptions,
  type ProviderSkillReference,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { Cache, Cause, Duration, Effect, Equal, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  buildPromptThreadTitleFallback,
  isGenericChatThreadTitle,
} from "@t3tools/shared/chatThreads";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import { resolveThreadWorkspaceState } from "@t3tools/shared/threadEnvironment";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderAdapterRequestError, ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { buildHandoffBootstrapText, hasNativeAssistantMessagesBefore } from "../handoff.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-queued"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
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

function attachmentTitleSeed(attachment: ChatAttachment | undefined): string {
  if (!attachment) {
    return "";
  }
  if (attachment.type === "image") {
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
const HANDOFF_CONTEXT_WRAPPER_OVERHEAD =
  "<handoff_context>\n\n</handoff_context>\n\n<latest_user_message>\n\n</latest_user_message>"
    .length;

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

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

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
  const providerService = yield* ProviderService;
  const git = yield* GitCore;
  const textGeneration = yield* TextGeneration;
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
  const threadModelSelections = new Map<string, ModelSelection>();
  const queuedTurnStartsByThread = new Map<
    string,
    Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
  >();
  const drainingQueuedTurns = new Set<string>();

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

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  // Recovers the parent thread when older/local-only subagent rows are missing parentThreadId metadata.
  const inferParentThreadFromSyntheticSubagentId = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const rawThreadId = threadId as string;
    if (!rawThreadId.startsWith("subagent:")) {
      return null;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const matchingParents = readModel.threads.filter((entry) =>
      rawThreadId.startsWith(`subagent:${entry.id}:`),
    );
    return matchingParents.toSorted((left, right) => right.id.length - left.id.length)[0] ?? null;
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

  const ensureSessionForThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly providerOptions?: ProviderStartOptions;
      readonly runtimeMode?: RuntimeMode;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

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
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
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
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
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
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

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
        desiredRuntimeMode: thread.runtimeMode,
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
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
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
        return threadId;
      }
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
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
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
      ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
    });
    if (input.providerOptions !== undefined) {
      threadProviderOptions.set(input.threadId, input.providerOptions);
    }
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const shouldBootstrapHandoff =
      thread.handoff?.bootstrapStatus === "pending" &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId);
    const availableBootstrapChars = Math.max(
      0,
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS -
        input.messageText.length -
        HANDOFF_CONTEXT_WRAPPER_OVERHEAD,
    );
    const handoffBootstrapText =
      shouldBootstrapHandoff && availableBootstrapChars > 0
        ? buildHandoffBootstrapText(thread, availableBootstrapChars)
        : null;
    const providerInput = handoffBootstrapText
      ? `<handoff_context>\n${handoffBootstrapText}\n</handoff_context>\n\n<latest_user_message>\n${input.messageText}\n</latest_user_message>`
      : input.messageText;
    const normalizedInput = toNonEmptyProviderInput(providerInput);
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
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    if (input.reviewTarget !== undefined) {
      yield* providerService.startReview({
        threadId: input.threadId,
        target: input.reviewTarget,
      });
    } else if (input.dispatchMode === "steer") {
      yield* providerService.steerTurn({
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      });
    } else {
      yield* providerService.sendTurn({
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      });
    }
    if (handoffBootstrapText && thread.handoff !== null) {
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
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
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
    yield* textGeneration
      .generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            "provider command reactor failed to generate worktree branch name; skipping rename",
            { threadId: input.threadId, cwd, oldBranch, reason: error.message },
          ),
        ),
        Effect.flatMap((generated) => {
          if (!generated) return Effect.void;

          const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
          if (targetBranch === oldBranch) return Effect.void;

          return Effect.flatMap(
            git.renameBranch({ cwd, oldBranch, newBranch: targetBranch }),
            (renamed) =>
              orchestrationEngine.dispatch({
                type: "thread.meta.update",
                commandId: serverCommandId("worktree-branch-rename"),
                threadId: input.threadId,
                branch: renamed.branch,
                worktreePath: cwd,
                associatedWorktreePath: cwd,
                associatedWorktreeBranch: renamed.branch,
                associatedWorktreeRef: renamed.branch,
              }),
          );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "provider command reactor failed to generate or rename worktree branch",
            { threadId: input.threadId, cwd, oldBranch, cause: Cause.pretty(cause) },
          ),
        ),
      );
  });

  // Only auto-rename placeholder titles that still reflect the first-turn draft state.
  const maybeGenerateAndRenameThreadTitleForFirstTurn = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
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

    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const nextTitle = yield* textGeneration
      .generateThreadTitle({
        cwd: cwd ?? process.cwd(),
        message: input.messageText,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      })
      .pipe(
        Effect.map((generated) => generated.title),
        Effect.catch((error) =>
          Effect.logWarning("provider command reactor failed to generate thread title", {
            threadId: input.threadId,
            cwd,
            reason: error.message,
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

    yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
      threadId: event.payload.threadId,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);
    yield* maybeGenerateAndRenameThreadTitleForFirstTurn({
      threadId: event.payload.threadId,
      messageId: message.id,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
    }).pipe(Effect.forkScoped);
    const immediateDispatchMode =
      event.payload.dispatchMode === "steer" &&
      (thread.session?.providerName ?? thread.modelSelection.provider) !== "codex"
        ? "queue"
        : event.payload.dispatchMode;

    yield* dispatchTurnForThread({
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
      ...(event.payload.runtimeMode !== undefined ? { runtimeMode: event.payload.runtimeMode } : {}),
      ...(event.payload.reviewTarget !== undefined
        ? { reviewTarget: event.payload.reviewTarget }
        : {}),
      interactionMode: event.payload.interactionMode,
      dispatchMode: immediateDispatchMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail: Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          });
          yield* drainQueuedTurnsForThread(event.payload.threadId);
        }),
      ),
    );
  });

  const processTurnQueued = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>,
  ) {
    yield* enqueueQueuedTurnStart(event.payload);
  });

  // Promote the next queued message only after the active provider turn settles.
  const drainQueuedTurnsForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    if (drainingQueuedTurns.has(threadId)) {
      return;
    }
    drainingQueuedTurns.add(threadId);
    try {
      const nextQueuedTurn = yield* dequeueQueuedTurnStart(threadId);
      if (!nextQueuedTurn) {
        return;
      }
      yield* orchestrationEngine.dispatch({
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
      });
    } finally {
      drainingQueuedTurns.delete(threadId);
    }
  });

  const processQueueDrainEvent = Effect.fnUntraced(function* (event: ProviderQueueDrainEvent) {
    yield* drainQueuedTurnsForThread(event.threadId);
  });

  const processTurnInterruptRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    const providerThreadId = resolveSubagentProviderThreadId(thread.id, providerThread.id);
    const turnId = event.payload.turnId ?? thread.session?.activeTurnId ?? undefined;
    yield* providerService.interruptTurn({
      threadId: providerThread.id,
      ...(turnId ? { turnId } : {}),
      ...(providerThreadId ? { providerThreadId } : {}),
    });
  });

  const processApprovalResponseRequested = Effect.fnUntraced(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
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

    yield* providerService
      .respondToRequest({
        threadId: providerThread.id,
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
                ? stalePendingRequestDetail("approval", event.payload.requestId)
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
    const providerThread = yield* resolveProviderSessionThread(event.payload.threadId);
    if (!thread || !providerThread) {
      return;
    }
    const hasSession = providerThread.session && providerThread.session.status !== "stopped";
    if (!hasSession) {
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

    yield* providerService
      .respondToUserInput({
        threadId: providerThread.id,
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
              ? stalePendingRequestDetail("user-input", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
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
    drainingQueuedTurns.delete(thread.id);

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
        case "thread.meta-updated": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (event.payload.modelSelection === undefined) {
            return;
          }

          if (
            !thread?.session ||
            thread.session.status === "stopped" ||
            thread.session.activeTurnId !== null
          ) {
            threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
            return;
          }

          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            modelSelection: event.payload.modelSelection,
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
          });
          threadModelSelections.set(event.payload.threadId, event.payload.modelSelection);
          return;
        }
        case "thread.runtime-mode-set": {
          const thread = yield* resolveThread(event.payload.threadId);
          if (!thread?.session || thread.session.status === "stopped") {
            return;
          }
          const cachedProviderOptions = threadProviderOptions.get(event.payload.threadId);
          const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
          yield* ensureSessionForThread(event.payload.threadId, event.occurredAt, {
            ...(cachedProviderOptions !== undefined
              ? { providerOptions: cachedProviderOptions }
              : {}),
            ...(cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {}),
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

  const start: ProviderCommandReactorShape["start"] = Effect.all([
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (
        event.type !== "thread.meta-updated" &&
        event.type !== "thread.runtime-mode-set" &&
        event.type !== "thread.turn-queued" &&
        event.type !== "thread.turn-start-requested" &&
        event.type !== "thread.turn-interrupt-requested" &&
        event.type !== "thread.approval-response-requested" &&
        event.type !== "thread.user-input-response-requested" &&
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
  ]).pipe(Effect.asVoid);

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
