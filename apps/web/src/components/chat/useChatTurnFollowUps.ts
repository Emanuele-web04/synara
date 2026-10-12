import { MessageId, ThreadId, type ProviderKind, type TurnId } from "@synara/contracts";
import { resolveTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import { useNavigate } from "@tanstack/react-router";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { formatOutgoingComposerPrompt } from "../../lib/composerSend";
import { reconcileDeletedThreadFromClient } from "../../lib/deletedThreadClientReconciliation";
import {
  armQueuedComposerSteerGate,
  prepareQueuedComposerResumeAfterSend,
} from "../../lib/queuedComposerDrain";
import { appendOriginalComposerPromptBlocks } from "../../lib/terminalContext";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../../pendingTurnDispatch";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../proposedPlan";
import type { LatestProposedPlanState } from "../../session-logic";
import { buildSourceProposedPlanReference } from "../../session-logic";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import { truncateTitle } from "../../truncateTitle";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import {
  editAndResendDispatchFields,
  queuedChatTurnDispatchFields,
  planImplementationDispatchSettings,
  resolveQueuedTurnDispatchSettings,
  threadSettingsDispatchFields,
  turnStartDispatchFields,
  type QueuedSteerGate,
  type TurnDispatchSettings,
} from "../ChatView.logic";
import { buildWorkflowResumePrompt } from "./WorkflowRunCard.logic";
import { useRetryEffortVariantStore } from "./retryEffortVariantStore";
import {
  buildRetryConfirmCopy,
  planRetryEffortChange,
  resolveRetryWithDifferentEffortAvailability,
} from "./retryWithDifferentEffort.logic";
import { resolveRuntimeModelDescriptor } from "./runtimeModelCapabilities";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatLocalDispatch } from "./useChatLocalDispatch";
import { useChatProviderModels } from "./useChatProviderModels";
import { useChatProviderStatus } from "./useChatProviderStatus";
import { useChatRuntimeModes } from "./useChatRuntimeModes";
import { useChatTimelineMessages } from "./useChatTimelineMessages";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import { useChatWorkLog } from "./useChatWorkLog";
import { toastManager } from "../ui/toast";

import type { LateComposerSendHandlers, PlanFollowUpSubmission } from "./chatSendTypes";
interface ChatTurnFollowUpsInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isConnecting: boolean;
  sendInFlightRef: RefObject<boolean>;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  setTailAnchor: Dispatch<SetStateAction<{ threadId: ThreadId; messageId: MessageId } | null>>;
  anchorSentMessagesToTop: boolean;
  activeProposedPlan: LatestProposedPlanState | null;
  setQueuedSteerGate: Dispatch<SetStateAction<QueuedSteerGate | null>>;
  planSidebarDismissedForTurnRef: RefObject<string | null>;
  setPlanSidebarOpen: Dispatch<SetStateAction<boolean>>;
  isRevertingCheckpoint: boolean;
  setIsRevertingCheckpoint: Dispatch<SetStateAction<boolean>>;
  isSendBusy: ReturnType<typeof useChatLocalDispatch>["isSendBusy"];
  beginLocalDispatch: ReturnType<typeof useChatLocalDispatch>["beginLocalDispatch"];
  armLocalDispatchAckFallback: ReturnType<
    typeof useChatLocalDispatch
  >["armLocalDispatchAckFallback"];
  resetLocalDispatch: ReturnType<typeof useChatLocalDispatch>["resetLocalDispatch"];
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedPromptEffort: ReturnType<typeof useChatProviderModels>["selectedPromptEffort"];
  runtimeModelsByProvider: ReturnType<typeof useChatProviderModels>["runtimeModelsByProvider"];
  runtimeModelsByProviderInstance: ReturnType<
    typeof useChatProviderModels
  >["runtimeModelsByProviderInstance"];
  turnDispatchSettings: TurnDispatchSettings;
  computerControlChangeSequence: RefObject<number>;
  setComposerDraftComputerControlMode: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftComputerControlMode"];
  setOptimisticUserMessages: ReturnType<
    typeof useChatTimelineMessages
  >["setOptimisticUserMessages"];
  armTranscriptAutoFollow: ReturnType<typeof useChatTranscriptScroll>["armTranscriptAutoFollow"];
  tailAnchorScrollInFlightRef: ReturnType<
    typeof useChatTranscriptScroll
  >["tailAnchorScrollInFlightRef"];
  persistThreadSettingsForNextTurn: ReturnType<
    typeof useChatRuntimeModes
  >["persistThreadSettingsForNextTurn"];
  setComposerDraftInteractionMode: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftInteractionMode"];
  rememberCustomBinaryPathForDispatch: ReturnType<
    typeof useChatProviderStatus
  >["rememberCustomBinaryPathForDispatch"];
  workflowRunState: ReturnType<typeof useChatWorkLog>["workflowRunState"];
  lateComposerSendHandlersRef: RefObject<LateComposerSendHandlers | null>;
  activeThreadId: ThreadId | null;
  markWorkflowRunDismissed: (threadId: ThreadId, workflowTaskId: string) => void;
  activeProject: Project | undefined;
  activeThreadAssociatedWorktree: ReturnType<typeof deriveAssociatedWorktreeMetadata>;
  syncServerShellSnapshot: ReturnType<typeof useStore.getState>["syncServerShellSnapshot"];
  planSidebarOpenOnNextThreadRef: RefObject<boolean>;
  navigate: ReturnType<typeof useNavigate>;
}

export function useChatTurnFollowUps({
  threadId,
  activeThread,
  isServerThread,
  isConnecting,
  sendInFlightRef,
  setThreadError,
  setTailAnchor,
  anchorSentMessagesToTop,
  activeProposedPlan,
  setQueuedSteerGate,
  planSidebarDismissedForTurnRef,
  setPlanSidebarOpen,
  isRevertingCheckpoint,
  setIsRevertingCheckpoint,
  isSendBusy,
  beginLocalDispatch,
  armLocalDispatchAckFallback,
  resetLocalDispatch,
  selectedProvider,
  selectedModel,
  selectedPromptEffort,
  runtimeModelsByProvider,
  runtimeModelsByProviderInstance,
  turnDispatchSettings,
  computerControlChangeSequence,
  setComposerDraftComputerControlMode,
  setOptimisticUserMessages,
  armTranscriptAutoFollow,
  tailAnchorScrollInFlightRef,
  persistThreadSettingsForNextTurn,
  setComposerDraftInteractionMode,
  rememberCustomBinaryPathForDispatch,
  workflowRunState,
  lateComposerSendHandlersRef,
  activeThreadId,
  markWorkflowRunDismissed,
  activeProject,
  activeThreadAssociatedWorktree,
  syncServerShellSnapshot,
  planSidebarOpenOnNextThreadRef,
  navigate,
}: ChatTurnFollowUpsInput) {
  async function onSubmitPlanFollowUp({
    text,
    interactionMode: nextInteractionMode,
    dispatchMode,
    queuedTurn,
    resumeQueueAfterSend: preparedQueueResume,
  }: PlanFollowUpSubmission): Promise<boolean> {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return false;
    }

    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const threadIdForSend = activeThread.id;
    const resumeQueueAfterSend =
      preparedQueueResume ??
      (!queuedTurn || dispatchMode === "steer"
        ? prepareQueuedComposerResumeAfterSend(threadIdForSend)
        : undefined);
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: queuedTurn?.selectedProvider ?? selectedProvider,
      model: queuedTurn?.selectedModel ?? selectedModel,
      effort: queuedTurn?.selectedPromptEffort ?? selectedPromptEffort,
      text: trimmed,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch({ expectedUserMessageId: messageIdForSend });
    setThreadError(threadIdForSend, null);
    setOptimisticUserMessages((existing) => [
      ...existing,
      {
        id: messageIdForSend,
        role: "user",
        text: outgoingMessageText,
        dispatchMode,
        createdAt: messageCreatedAt,
        streaming: false,
        source: "native",
      },
    ]);
    armTranscriptAutoFollow(threadIdForSend, true);
    tailAnchorScrollInFlightRef.current = anchorSentMessagesToTop;
    setTailAnchor(
      anchorSentMessagesToTop ? { threadId: threadIdForSend, messageId: messageIdForSend } : null,
    );

    // Nested function so the `try` body holds no value blocks — see the comment on
    // `deleteEmptyTerminalThread` above for why React Compiler requires this shape.
    const planDispatchSettings = {
      ...resolveQueuedTurnDispatchSettings(turnDispatchSettings, queuedTurn),
      interactionMode: nextInteractionMode,
    };
    const modelSelectionForPlanDispatch = planDispatchSettings.modelSelection;
    const computerControlSequenceForSend = computerControlChangeSequence.current;

    const dispatchPlanFollowUpTurn = async () => {
      await persistThreadSettingsForNextTurn({
        ...threadSettingsDispatchFields(planDispatchSettings),
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
      });

      // Keep the mode toggle and plan-follow-up banner in sync immediately
      // while the same-thread implementation turn is starting.
      setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

      const sourceProposedPlan =
        nextInteractionMode === "default"
          ? buildSourceProposedPlanReference({
              threadId: activeThread.id,
              proposedPlan: activeProposedPlan,
            })
          : undefined;
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: planDispatchSettings.modelSelection.provider,
        providerInstanceId:
          planDispatchSettings.modelSelection.instanceId ??
          planDispatchSettings.modelSelection.provider,
        providerOptions: planDispatchSettings.providerOptions,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.turn.start",
        commandId: newCommandId(),
        threadId: threadIdForSend,
        message: {
          messageId: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          attachments: [],
        },
        ...turnStartDispatchFields(planDispatchSettings, dispatchMode),
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
        createdAt: messageCreatedAt,
      });
      if (!queuedTurn && planDispatchSettings.computerControlMode === "request") {
        const draft = useComposerDraftStore.getState().draftsByThreadId[threadIdForSend];
        if (
          draft?.computerControlMode === "request" &&
          computerControlChangeSequence.current === computerControlSequenceForSend
        )
          setComposerDraftComputerControlMode(threadIdForSend, "off");
      }
      // Steers on providers without native mid-turn steering interrupt the live
      // turn before re-dispatching; hold queued auto-dispatch through that gap
      // so it can't race the steer. The live session provider decides the
      // interrupt path server-side, so the gate keys off it rather than the
      // requested model selection.
      const livePlanProviderForSteerGate =
        activeThread?.session?.provider ?? modelSelectionForPlanDispatch.provider;
      if (
        dispatchMode === "steer" &&
        !providerSupportsNativeTurnSteering(livePlanProviderForSteerGate)
      ) {
        const nextSteerGate = {
          sawInterruptGap: false,
          gapStartedAt: null,
          armedActiveTurnId: activeThread?.session?.activeTurnId ?? null,
        };
        setQueuedSteerGate(nextSteerGate);
        armQueuedComposerSteerGate(threadId, nextSteerGate);
      }
      // Optimistically open the plan sidebar when implementing (not refining).
      // "default" mode here means the agent is executing the plan, which produces
      // step-tracking activities that the sidebar will display.
      if (nextInteractionMode === "default") {
        planSidebarDismissedForTurnRef.current = null;
        setPlanSidebarOpen(true);
      }
    };

    try {
      await dispatchPlanFollowUpTurn();
      armLocalDispatchAckFallback(threadIdForSend);
      sendInFlightRef.current = false;
      if (resumeQueueAfterSend) resumeQueueAfterSend();
      return true;
    } catch (err) {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => message.id !== messageIdForSend),
      );
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send plan follow-up.",
      );
      sendInFlightRef.current = false;
      // The turn RPC failed, so no server turn exists for the watchdog to
      // recover — drop the marker armed when the dispatch began.
      clearPendingTurnDispatch(threadIdForSend);
      resetLocalDispatch();
      return false;
    }
  }

  const onEditUserMessage = useCallback(
    async (messageId: MessageId, text: string): Promise<boolean> => {
      const api = readNativeApi();
      if (!api || !activeThread || !isServerThread || isRevertingCheckpoint) {
        return false;
      }
      const editTarget = resolveTailUserMessageEditTarget({
        messages: activeThread.messages,
        messageId,
        activeTurnId:
          activeThread.session?.orchestrationStatus === "running"
            ? (activeThread.session.activeTurnId ?? null)
            : null,
      });
      if (!editTarget.editable) {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      const originalMessage = activeThread.messages[editTarget.messageIndex];
      if (!originalMessage || originalMessage.role !== "user") {
        setThreadError(activeThread.id, "Only the latest rollbackable user message can be edited.");
        return false;
      }
      if (isSendBusy || isConnecting || sendInFlightRef.current) {
        setThreadError(activeThread.id, "Wait for the current send to start before editing.");
        return false;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      const messageCreatedAt = new Date().toISOString();
      const computerControlSequenceForEdit = computerControlChangeSequence.current;
      const editedTextWithOriginalContext = appendOriginalComposerPromptBlocks({
        editedPrompt: text,
        originalPrompt: originalMessage.text,
        messageId,
      });
      const outgoingMessageText = formatOutgoingComposerPrompt({
        provider: selectedProvider,
        model: selectedModel,
        effort: selectedPromptEffort,
        text: editedTextWithOriginalContext,
      });
      return await (async () => {
        await persistThreadSettingsForNextTurn({
          ...threadSettingsDispatchFields(turnDispatchSettings),
          threadId: activeThread.id,
          createdAt: messageCreatedAt,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.message.edit-and-resend",
          commandId: newCommandId(),
          threadId: activeThread.id,
          messageId,
          text: outgoingMessageText,
          ...editAndResendDispatchFields(turnDispatchSettings),
          createdAt: messageCreatedAt,
        });
        useRetryEffortVariantStore.getState().clearGroup({
          threadId: activeThread.id,
          userMessageId: messageId,
        });
        if (
          turnDispatchSettings.computerControlMode === "request" &&
          computerControlChangeSequence.current === computerControlSequenceForEdit
        ) {
          setComposerDraftComputerControlMode(activeThread.id, "off");
        }
        return true;
      })()
        .catch((err: unknown) => {
          setThreadError(
            activeThread.id,
            err instanceof Error ? err.message : "Failed to edit message.",
          );
          return false;
        })
        .finally(() => {
          setIsRevertingCheckpoint(false);
        });
    },
    [
      sendInFlightRef,
      setIsRevertingCheckpoint,
      activeThread,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      isServerThread,
      persistThreadSettingsForNextTurn,
      selectedModel,
      selectedPromptEffort,
      selectedProvider,
      setThreadError,
      turnDispatchSettings,
      computerControlChangeSequence,
      setComposerDraftComputerControlMode,
    ],
  );
  // Resuming a workflow is a normal composer turn instructing the agent to
  // re-invoke the Workflow tool against the persisted script; completed agent()
  // calls replay from cache, so a paused run picks up where it stopped. Sent as
  // a pre-built chat turn so it takes the exact send path a queued turn does.

  const onContinueFailedTurn = useCallback(
    async (turnId: TurnId): Promise<boolean> => {
      const current = getThreadFromState(useStore.getState(), threadId);
      const handlers = lateComposerSendHandlersRef.current;
      if (
        !handlers ||
        !isServerThread ||
        !current ||
        current.latestTurn?.turnId !== turnId ||
        current.latestTurn.state !== "error" ||
        current.session?.status === "running" ||
        current.hasPendingApprovals ||
        current.hasPendingUserInput
      )
        return false;
      const prompt =
        "Continue the interrupted task from the existing conversation and working state. First verify which operations have already completed; avoid repeating them and resume the remaining work.";
      return handlers.send(undefined, "queue", {
        id: randomUUID(),
        kind: "chat",
        createdAt: new Date().toISOString(),
        previewText: prompt,
        prompt,
        images: [],
        files: [],
        assistantSelections: [],
        browserAnnotations: [],
        terminalContexts: [],
        fileComments: [],
        pastedTexts: [],
        pullRequestContexts: [],
        skills: [],
        mentions: [],
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        ...queuedChatTurnDispatchFields(turnDispatchSettings, undefined),
      });
    },
    [
      threadId,
      isServerThread,
      lateComposerSendHandlersRef,
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      turnDispatchSettings,
    ],
  );

  const onResumeWorkflowRun = useCallback(async () => {
    if (!workflowRunState?.scriptPath || !workflowRunState.runId) return;
    const lateSendHandlers = lateComposerSendHandlersRef.current;
    if (!lateSendHandlers) return;
    const { workflowTaskId } = workflowRunState;
    const prompt = buildWorkflowResumePrompt(workflowRunState.scriptPath, workflowRunState.runId);
    const sent = await lateSendHandlers.send(undefined, "queue", {
      id: randomUUID(),
      kind: "chat",
      createdAt: new Date().toISOString(),
      previewText: prompt,
      prompt,
      images: [],
      files: [],
      assistantSelections: [],
      browserAnnotations: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      pullRequestContexts: [],
      skills: [],
      mentions: [],
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      ...queuedChatTurnDispatchFields(turnDispatchSettings, undefined),
    });
    if (sent && activeThreadId) {
      markWorkflowRunDismissed(activeThreadId, workflowTaskId);
    }
  }, [
    lateComposerSendHandlersRef,
    activeThreadId,
    markWorkflowRunDismissed,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
    workflowRunState,
    turnDispatchSettings,
  ]);

  const onImplementPlanInNewThread = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      !activeProject ||
      !activeProposedPlan ||
      !isServerThread ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current
    ) {
      return;
    }

    const createdAt = new Date().toISOString();
    const nextThreadId = newThreadId();
    const planMarkdown = activeProposedPlan.planMarkdown;
    const implementationPrompt = buildPlanImplementationPrompt(planMarkdown);
    const outgoingImplementationPrompt = formatOutgoingComposerPrompt({
      provider: selectedProvider,
      model: selectedModel,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncateTitle(buildPlanImplementationThreadTitle(planMarkdown));
    const computerControlSequenceForImplementation = computerControlChangeSequence.current;
    const implementationDispatchSettings = planImplementationDispatchSettings(turnDispatchSettings);
    const sourceProposedPlan = buildSourceProposedPlanReference({
      threadId: activeThread.id,
      proposedPlan: activeProposedPlan,
    });

    sendInFlightRef.current = true;
    beginLocalDispatch();
    const finish = () => {
      sendInFlightRef.current = false;
      resetLocalDispatch();
    };

    await api.orchestration
      .dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: nextThreadId,
        projectId: activeProject.id,
        title: nextThreadTitle,
        modelSelection: implementationDispatchSettings.modelSelection,
        runtimeMode: implementationDispatchSettings.runtimeMode,
        interactionMode: implementationDispatchSettings.interactionMode,
        envMode: activeThread.envMode ?? (activeThread.worktreePath ? "worktree" : "local"),
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        workingDirectory: activeThread.workingDirectory ?? null,
        lastKnownPr: activeThread.lastKnownPr ?? null,
        associatedWorktreePath: activeThreadAssociatedWorktree.associatedWorktreePath,
        associatedWorktreeBranch: activeThreadAssociatedWorktree.associatedWorktreeBranch,
        associatedWorktreeRef: activeThreadAssociatedWorktree.associatedWorktreeRef,
        createdAt,
      })
      .then(() => {
        rememberCustomBinaryPathForDispatch({
          threadId: nextThreadId,
          provider: implementationDispatchSettings.modelSelection.provider,
          providerInstanceId:
            implementationDispatchSettings.modelSelection.instanceId ??
            implementationDispatchSettings.modelSelection.provider,
          providerOptions: implementationDispatchSettings.providerOptions,
        });
        return api.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: newCommandId(),
          threadId: nextThreadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: outgoingImplementationPrompt,
            attachments: [],
          },
          ...turnStartDispatchFields(implementationDispatchSettings, "queue"),
          ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
          createdAt,
        });
      })
      .then(() => {
        if (implementationDispatchSettings.computerControlMode === "chat") {
          setComposerDraftComputerControlMode(nextThreadId, "chat", {
            generation: implementationDispatchSettings.computerControlGeneration ?? 0,
          });
        } else if (
          implementationDispatchSettings.computerControlMode === "request" &&
          computerControlChangeSequence.current === computerControlSequenceForImplementation
        ) {
          setComposerDraftComputerControlMode(activeThread.id, "off");
        }
        // The turn RPC resolved for a thread this view never made active, so
        // arm the watchdog marker with that exact thread id before navigation.
        markPendingTurnDispatch(nextThreadId);
        return api.orchestration.getShellSnapshot();
      })
      .then((snapshot) => {
        syncServerShellSnapshot(snapshot);
        // Signal that the plan sidebar should open on the new thread.
        planSidebarOpenOnNextThreadRef.current = true;
        return navigate({
          to: "/$threadId",
          params: { threadId: nextThreadId },
        });
      })
      .catch(async (err) => {
        const deletedOnServer = await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .then(() => true)
          .catch(() => false);
        if (deletedOnServer) {
          clearPendingTurnDispatch(nextThreadId);
          void reconcileDeletedThreadFromClient({
            threadId: nextThreadId,
            removeDeletedThreadFromClientState:
              useStore.getState().removeDeletedThreadFromClientState,
          });
        }
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
    planSidebarOpenOnNextThreadRef,
    sendInFlightRef,
    activeProject,
    activeProposedPlan,
    activeThread,
    activeThreadAssociatedWorktree,
    beginLocalDispatch,
    isConnecting,
    isSendBusy,
    isServerThread,
    navigate,
    resetLocalDispatch,
    computerControlChangeSequence,
    selectedPromptEffort,
    selectedModel,
    selectedProvider,
    rememberCustomBinaryPathForDispatch,
    setComposerDraftComputerControlMode,
    syncServerShellSnapshot,
    turnDispatchSettings,
  ]);
  const onRetryAssistantWithDifferentEffort = useCallback(
    async (assistantMessageId: MessageId, nextEffort: string): Promise<boolean> => {
      const api = readNativeApi();
      const sourceThread = getThreadFromState(useStore.getState(), threadId);
      if (!api || !sourceThread || !isServerThread || isRevertingCheckpoint) return false;
      if (isSendBusy || isConnecting || sendInFlightRef.current) {
        setThreadError(threadId, "Wait for the current send to finish before retrying.");
        return false;
      }

      const resolveSource = (thread: Thread) => {
        const assistantMessage = thread.messages.find(
          (message) => message.id === assistantMessageId && message.role === "assistant",
        );
        const assistantMessageUpdatedAt = assistantMessage?.updatedAt;
        if (!assistantMessage || !assistantMessageUpdatedAt) return null;
        const modelSelection = thread.modelSelection;
        const runtimeModel = resolveRuntimeModelDescriptor({
          provider: modelSelection.provider,
          model: modelSelection.model,
          runtimeModels:
            runtimeModelsByProviderInstance[modelSelection.instanceId ?? modelSelection.provider] ??
            runtimeModelsByProvider[modelSelection.provider],
        });
        const turnDiffSummary = thread.turnDiffSummaries.find(
          (summary) => summary.turnId === assistantMessage.turnId,
        );
        const availability = resolveRetryWithDifferentEffortAvailability({
          messages: thread.messages,
          assistantMessageId,
          assistantTurnId: assistantMessage.turnId,
          showAssistantCopyButton: true,
          assistantTurnInProgress: thread.latestTurn?.state === "running",
          runtimeMode: thread.runtimeMode,
          modelSelection,
          modelOptions: modelSelection.options,
          runtimeModel,
          turnDiffSummary,
          activeTurnId:
            thread.session?.orchestrationStatus === "running"
              ? (thread.session.activeTurnId ?? null)
              : null,
          isBusy:
            thread.pendingTurnStartMessageId != null ||
            thread.session?.orchestrationStatus === "starting",
        });
        return {
          assistantMessage,
          assistantMessageUpdatedAt,
          modelSelection,
          runtimeModel,
          turnDiffSummary,
          availability,
        };
      };
      const source = resolveSource(sourceThread);
      if (!source) {
        setThreadError(
          threadId,
          "Assistant turn is not ready for retry. Refresh its latest state.",
        );
        return false;
      }
      if (!source.availability.enabled) {
        setThreadError(threadId, source.availability.detail);
        return false;
      }
      const {
        availability,
        assistantMessage,
        assistantMessageUpdatedAt,
        modelSelection,
        runtimeModel,
      } = source;
      const planned = planRetryEffortChange({
        provider: modelSelection.provider,
        model: modelSelection.model,
        instanceId: modelSelection.instanceId,
        ...(modelSelection.provider === "claudeAgent"
          ? { supportsAutoMode: modelSelection.supportsAutoMode }
          : {}),
        modelOptions: modelSelection.options,
        prompt: availability.userMessageText,
        runtimeModel,
        nextEffort,
      });
      if (!planned) {
        setThreadError(threadId, "Choose a different supported effort for this turn's model.");
        return false;
      }
      const currentEffort = availability.currentEffort;
      const currentEffortLabel =
        availability.effortOptions.find((option) => option.isCurrent)?.label ?? currentEffort;

      // Own local admission before the asynchronous confirmation. A second click
      // or composer send must not race the workspace restore behind this dialog.
      sendInFlightRef.current = true;
      setIsRevertingCheckpoint(true);
      setThreadError(threadId, null);
      return await (async () => {
        const confirmed = await api.dialogs.confirm(
          buildRetryConfirmCopy({
            changedFileCount: availability.changedFileCount,
            checkpointTurnCount: availability.checkpointTurnCount,
            nextEffortLabel: planned.effortLabel,
            currentEffortLabel,
          }),
        );
        if (!confirmed) return false;
        const currentThread = getThreadFromState(useStore.getState(), threadId);
        const current = currentThread ? resolveSource(currentThread) : null;
        if (
          !current ||
          !current.availability.enabled ||
          current.availability.userMessageId !== availability.userMessageId ||
          current.availability.userMessageText !== availability.userMessageText ||
          current.availability.turnId !== availability.turnId ||
          current.availability.checkpointTurnCount !== availability.checkpointTurnCount ||
          current.availability.checkpointRef !== availability.checkpointRef ||
          current.assistantMessage.text !== assistantMessage.text ||
          current.assistantMessageUpdatedAt !== assistantMessageUpdatedAt ||
          JSON.stringify(current.modelSelection) !== JSON.stringify(modelSelection)
        ) {
          setThreadError(
            threadId,
            "This turn changed while confirmation was open. Review it before retrying.",
          );
          return false;
        }

        useRetryEffortVariantStore.getState().archiveVariant({
          threadId,
          userMessageId: availability.userMessageId,
          userMessageText: availability.userMessageText,
          variant: {
            id: `${assistantMessageId}:${assistantMessage.createdAt}`,
            assistantMessageId,
            turnId: assistantMessage.turnId ?? null,
            text: assistantMessage.text,
            effort: currentEffort,
            effortLabel: currentEffortLabel,
            provider: modelSelection.provider,
            model: modelSelection.model,
            createdAt: assistantMessage.createdAt,
            checkpointTurnCount: availability.checkpointTurnCount,
            changedFileCount: availability.changedFileCount,
          },
        });
        const outgoingMessageText = formatOutgoingComposerPrompt({
          provider: modelSelection.provider,
          model: modelSelection.model,
          effort: nextEffort,
          text: planned.nextPrompt,
        });
        // The existing edit command persists the next selection with the resend.
        // Do not change thread metadata or the user's unrelated composer draft
        // before its workspace/provider preflight has succeeded.
        await api.orchestration.dispatchCommand({
          type: "thread.message.edit-and-resend",
          commandId: newCommandId(),
          threadId,
          messageId: availability.userMessageId,
          text: outgoingMessageText,
          modelSelection: planned.nextModelSelection,
          retryFrom: {
            assistantMessageId,
            assistantMessageUpdatedAt,
            turnId: availability.turnId,
            userMessageText: availability.userMessageText,
            modelSelection,
            checkpointTurnCount: availability.checkpointTurnCount,
            checkpointRef: availability.checkpointRef,
          },
          assistantDeliveryMode: turnDispatchSettings.assistantDeliveryMode,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          createdAt: new Date().toISOString(),
        });
        return true;
      })()
        .catch((err: unknown) => {
          setThreadError(
            threadId,
            err instanceof Error ? err.message : "Failed to retry with a different effort.",
          );
          return false;
        })
        .finally(() => {
          sendInFlightRef.current = false;
          setIsRevertingCheckpoint(false);
        });
    },
    [
      threadId,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      isServerThread,
      runtimeModelsByProvider,
      runtimeModelsByProviderInstance,
      sendInFlightRef,
      setIsRevertingCheckpoint,
      setThreadError,
      turnDispatchSettings.assistantDeliveryMode,
    ],
  );

  return {
    onSubmitPlanFollowUp,
    onContinueFailedTurn,
    onEditUserMessage,
    onRetryAssistantWithDifferentEffort,
    onResumeWorkflowRun,
    onImplementPlanInNewThread,
  };
}
