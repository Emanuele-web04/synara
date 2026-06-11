// Purpose: Turn-dispatch cluster for the ProviderCommandReactor — queued-turn state ops,
//   provider conversation rollback / workspace restore for edits, dispatchTurnForThread
//   (handoff/sidechat/transcript bootstrap + send/steer/review), and first-turn worktree
//   branch / thread title generation.
// Layer: dependency-parameterized Effect helpers; built once per reactor via makeReactorDispatch(deps).
// Exports: ReactorDispatchDeps, ReactorDispatch, makeReactorDispatch.

import {
  type ChatAttachment,
  type ModelSelection,
  MessageId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ProviderMentionReference,
  ProviderKind,
  type ProviderReviewTarget,
  type ProviderStartOptions,
  type ProviderSkillReference,
  ThreadId,
  type RuntimeMode,
  TurnId,
} from "@t3tools/contracts";
import { Cause, Effect, Fiber } from "effect";
import {
  buildPromptThreadTitleFallback,
  isGenericChatThreadTitle,
} from "@t3tools/shared/chatThreads";
import {
  collectTailTurnIds,
  resolveTailUserMessageEditTarget,
} from "@t3tools/shared/conversationEdit";
import { isTemporaryWorktreeBranch } from "@t3tools/shared/git";

import {
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { type ProviderServiceError } from "../../provider/Errors.ts";
import {
  TextGeneration,
  type BranchNameGenerationInput,
  type ThreadTitleGenerationInput,
} from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { clearWorkspaceIndexCache } from "../../workspaceEntries.ts";
import {
  buildPriorTranscriptBootstrapText,
  buildForkBootstrapText,
  buildHandoffBootstrapText,
  hasNativeAssistantMessagesBefore,
} from "../handoff.ts";
import {
  attachmentTitleSeed,
  buildGeneratedWorktreeBranchName,
  isRollbackStillInProgressError,
  isStaleCodexResumeError,
  normalizeSkillMentionTextForProvider,
  serverCommandId,
  toNonEmptyProviderInput,
  wrapSidechatInput,
} from "./ProviderCommandReactor.helpers.ts";
import {
  HANDOFF_CONTEXT_WRAPPER_OVERHEAD,
  SIDECHAT_BOUNDARY_INSTRUCTION,
} from "./ProviderCommandReactor.config.ts";
import type { ProviderIntentEvent } from "./ProviderCommandReactor.types.ts";
import type { ReactorCoreDeps, ReactorSession } from "./ProviderCommandReactor.session.ts";

export interface ReactorDispatchDeps extends ReactorCoreDeps {
  readonly checkpointStore: typeof CheckpointStore.Service;
  readonly git: typeof GitCore.Service;
  readonly textGeneration: typeof TextGeneration.Service;
  readonly session: ReactorSession;
  readonly queuedTurnStartsByThread: Map<
    string,
    Array<Extract<ProviderIntentEvent, { type: "thread.turn-queued" }>["payload"]>
  >;
  readonly editResendTurnStartKeys: Set<string>;
  readonly sidechatContextBootstrapThreadIds: Set<string>;
}

export type ReactorDispatch = ReturnType<typeof makeReactorDispatch>;

export function makeReactorDispatch(deps: ReactorDispatchDeps) {
  const {
    orchestrationEngine,
    providerService,
    checkpointStore,
    git,
    textGeneration,
    queuedTurnStartsByThread,
    editResendTurnStartKeys,
    sidechatContextBootstrapThreadIds,
    threadProviderOptions,
    threadModelSelections,
    session,
  } = deps;
  const {
    resolveThread,
    resolveProjectedThreadWorkspaceCwd,
    resolveThreadTextGenerationInput,
    ensureSessionForThread,
    clearStaleProviderResumeState,
    joinPendingSessionEnsure,
    joinInFlightSessionEnsure,
  } = session;

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

  const rollbackProviderConversationForEdit = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) {
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

    const captureMessageStartCheckpoint = Effect.gen(function* () {
      if ((input.dispatchMode ?? "queue") === "steer") {
        return;
      }

      const currentThread = yield* resolveThread(input.threadId);
      if (!currentThread) {
        return;
      }
      if (currentThread.reviewChatTarget !== null) {
        return;
      }

      const cwd = yield* resolveProjectedThreadWorkspaceCwd(currentThread);
      if (!cwd || !(yield* checkpointStore.isGitRepository(cwd))) {
        return;
      }

      const checkpointRef = checkpointRefForThreadMessageStart(
        input.threadId,
        MessageId.makeUnsafe(input.messageId),
      );
      const checkpointExists = yield* checkpointStore.hasCheckpointRef({
        cwd,
        checkpointRef,
      });
      if (!checkpointExists) {
        // Capture before provider dispatch so the later turn diff is bounded by
        // the user's submit moment, not an async runtime event.
        yield* checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef,
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to capture provider turn start checkpoint", {
          threadId: input.threadId,
          messageId: input.messageId,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    const messageStartCheckpointFiber =
      input.reviewTarget === undefined && input.dispatchMode !== "steer"
        ? yield* captureMessageStartCheckpoint.pipe(Effect.forkChild)
        : null;

    yield* joinInFlightSessionEnsure(input.threadId);
    const joinedPendingSessionEnsure = yield* joinPendingSessionEnsure(input.threadId);
    const activeSessionBeforeEnsure = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const hasJoinedReusableSession =
      joinedPendingSessionEnsure !== null &&
      (input.runtimeMode === undefined ||
        joinedPendingSessionEnsure.runtimeMode === input.runtimeMode) &&
      (input.modelSelection === undefined ||
        joinedPendingSessionEnsure.modelSelection === undefined ||
        (joinedPendingSessionEnsure.modelSelection.provider === input.modelSelection.provider &&
          joinedPendingSessionEnsure.modelSelection.model === input.modelSelection.model));
    if (!hasJoinedReusableSession) {
      yield* ensureSessionForThread(input.threadId, input.createdAt, {
        ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
        ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
        ...(input.runtimeMode !== undefined ? { runtimeMode: input.runtimeMode } : {}),
      });
    }
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
    const shouldBootstrapSidechatContext =
      thread.sidechatSourceThreadId !== null &&
      sidechatContextBootstrapThreadIds.has(input.threadId) &&
      !hasNativeAssistantMessagesBefore(thread, input.messageId);
    const sidechatBootstrapText =
      shouldBootstrapSidechatContext && availableBootstrapChars > 0
        ? buildForkBootstrapText(thread, availableBootstrapChars)
        : null;
    const selectedProvider =
      input.modelSelection?.provider ??
      threadModelSelections.get(input.threadId)?.provider ??
      thread.session?.providerName ??
      thread.modelSelection.provider;
    const shouldBootstrapPriorTranscriptContext =
      (selectedProvider === "kilo" || selectedProvider === "opencode") &&
      activeSessionBeforeEnsure === undefined &&
      !hasJoinedReusableSession &&
      !handoffBootstrapText &&
      !sidechatBootstrapText;
    const priorTranscriptBootstrapText =
      shouldBootstrapPriorTranscriptContext && availableBootstrapChars > 0
        ? buildPriorTranscriptBootstrapText(thread, input.messageId, availableBootstrapChars)
        : null;
    const boundaryMessageText = thread.sidechatSourceThreadId
      ? wrapSidechatInput(input.messageText, SIDECHAT_BOUNDARY_INSTRUCTION)
      : input.messageText;
    const providerInput = handoffBootstrapText
      ? `<handoff_context>\n${handoffBootstrapText}\n</handoff_context>\n\n<latest_user_message>\n${boundaryMessageText}\n</latest_user_message>`
      : sidechatBootstrapText
        ? `<sidechat_context>\n${sidechatBootstrapText}\n</sidechat_context>\n\n${boundaryMessageText}`
        : priorTranscriptBootstrapText
          ? `<thread_context>\n${priorTranscriptBootstrapText}\n</thread_context>\n\n<latest_user_message>\n${boundaryMessageText}\n</latest_user_message>`
          : boundaryMessageText;
    const normalizedInput = toNonEmptyProviderInput(
      normalizeSkillMentionTextForProvider({
        provider: selectedProvider as ProviderKind,
        messageText: providerInput,
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
    const providerInteractionMode =
      thread.reviewChatTarget !== null && input.interactionMode === "default"
        ? undefined
        : input.interactionMode;

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
        ...(providerInteractionMode !== undefined
          ? { interactionMode: providerInteractionMode }
          : {}),
      });
    } else {
      if (messageStartCheckpointFiber) {
        yield* Fiber.join(messageStartCheckpointFiber);
      }
      yield* providerService.sendTurn({
        threadId: input.threadId,
        ...(normalizedInput ? { input: normalizedInput } : {}),
        ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.mentions !== undefined ? { mentions: input.mentions } : {}),
        ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
        ...(providerInteractionMode !== undefined
          ? { interactionMode: providerInteractionMode }
          : {}),
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
    if (sidechatBootstrapText) {
      sidechatContextBootstrapThreadIds.delete(input.threadId);
    }
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

  return {
    enqueueQueuedTurnStart,
    dequeueQueuedTurnStart,
    removeQueuedTurnStart,
    hasQueuedTurnStart,
    clearEditResendTurnStartKeysForThread,
    removedTurnIdsFromMessage,
    rollbackProviderConversationForEdit,
    restoreWorkspaceBeforeEditReplay,
    dispatchTurnForThread,
    maybeGenerateAndRenameWorktreeBranchForFirstTurn,
    maybeGenerateAndRenameThreadTitleForFirstTurn,
  };
}
