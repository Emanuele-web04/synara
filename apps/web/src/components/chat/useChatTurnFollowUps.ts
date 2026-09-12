import {
  MessageId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
  type ProviderKind,
  type ProviderStartOptions,
} from "@synara/contracts";
import { resolveTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import { useNavigate } from "@tanstack/react-router";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { newCommandId, newMessageId, newThreadId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { type DraftThreadEnvMode, type QueuedComposerPlanFollowUp } from "../../composerDraftStore";
import { formatOutgoingComposerPrompt } from "../../lib/composerSend";
import { reconcileDeletedThreadFromClient } from "../../lib/deletedThreadClientReconciliation";
import { armQueuedComposerSteerGate } from "../../lib/queuedComposerDrain";
import { appendOriginalComposerPromptBlocks } from "../../lib/terminalContext";
import { clearPendingTurnDispatch, markPendingTurnDispatch } from "../../pendingTurnDispatch";
import {
  buildPlanImplementationPrompt,
  buildPlanImplementationThreadTitle,
} from "../../proposedPlan";
import type { LatestProposedPlanState } from "../../session-logic";
import { buildSourceProposedPlanReference } from "../../session-logic";
import { useStore } from "../../store";
import { truncateTitle } from "../../truncateTitle";
import type { Project } from "../../types";
import { type Thread } from "../../types";
import { type QueuedSteerGate } from "../ChatView.logic";
import { buildWorkflowResumePrompt } from "./WorkflowRunCard.logic";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatLocalDispatch } from "./useChatLocalDispatch";
import { useChatProviderModels } from "./useChatProviderModels";
import { useChatProviderStatus } from "./useChatProviderStatus";
import { useChatRuntimeModes } from "./useChatRuntimeModes";
import { useChatTimelineMessages } from "./useChatTimelineMessages";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import { useChatWorkLog } from "./useChatWorkLog";
import { toastManager } from "../ui/toast";

import type { LateComposerSendHandlers } from "./chatSendTypes";
interface ChatTurnFollowUpsInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isConnecting: boolean;
  sendInFlightRef: RefObject<boolean>;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  setTailAnchor: Dispatch<SetStateAction<{ threadId: ThreadId; messageId: MessageId } | null>>;
  runtimeMode: RuntimeMode;
  activeProposedPlan: LatestProposedPlanState | null;
  assistantDeliveryMode: "streaming" | "buffered";
  setQueuedSteerGate: Dispatch<SetStateAction<QueuedSteerGate | null>>;
  planSidebarDismissedForTurnRef: RefObject<string | null>;
  setPlanSidebarOpen: Dispatch<SetStateAction<boolean>>;
  isRevertingCheckpoint: boolean;
  setIsRevertingCheckpoint: Dispatch<SetStateAction<boolean>>;
  interactionMode: ProviderInteractionMode;
  isSendBusy: ReturnType<typeof useChatLocalDispatch>["isSendBusy"];
  beginLocalDispatch: ReturnType<typeof useChatLocalDispatch>["beginLocalDispatch"];
  armLocalDispatchAckFallback: ReturnType<
    typeof useChatLocalDispatch
  >["armLocalDispatchAckFallback"];
  resetLocalDispatch: ReturnType<typeof useChatLocalDispatch>["resetLocalDispatch"];
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedPromptEffort: ReturnType<typeof useChatProviderModels>["selectedPromptEffort"];
  selectedModelSelection: ModelSelection;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
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
  envMode: DraftThreadEnvMode;
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
  runtimeMode,
  activeProposedPlan,
  assistantDeliveryMode,
  setQueuedSteerGate,
  planSidebarDismissedForTurnRef,
  setPlanSidebarOpen,
  isRevertingCheckpoint,
  setIsRevertingCheckpoint,
  interactionMode,
  isSendBusy,
  beginLocalDispatch,
  armLocalDispatchAckFallback,
  resetLocalDispatch,
  selectedProvider,
  selectedModel,
  selectedPromptEffort,
  selectedModelSelection,
  providerOptionsForDispatch,
  setOptimisticUserMessages,
  armTranscriptAutoFollow,
  tailAnchorScrollInFlightRef,
  persistThreadSettingsForNextTurn,
  setComposerDraftInteractionMode,
  rememberCustomBinaryPathForDispatch,
  workflowRunState,
  lateComposerSendHandlersRef,
  envMode,
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
  }: {
    text: string;
    interactionMode: "default" | "plan";
    dispatchMode: "queue" | "steer";
    queuedTurn?: QueuedComposerPlanFollowUp;
  }): Promise<boolean> {
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
    tailAnchorScrollInFlightRef.current = true;
    setTailAnchor({ threadId: threadIdForSend, messageId: messageIdForSend });

    // Nested function so the `try` body holds no value blocks — see the comment on
    // `deleteEmptyTerminalThread` above for why React Compiler requires this shape.
    const dispatchPlanFollowUpTurn = async () => {
      await persistThreadSettingsForNextTurn({
        threadId: threadIdForSend,
        createdAt: messageCreatedAt,
        modelSelection: queuedTurn?.modelSelection ?? selectedModelSelection,
        runtimeMode: queuedTurn?.runtimeMode ?? runtimeMode,
        interactionMode: nextInteractionMode,
      });

      // Keep the mode toggle and plan-follow-up banner in sync immediately
      // while the same-thread implementation turn is starting.
      setComposerDraftInteractionMode(threadIdForSend, nextInteractionMode);

      const providerOptionsForPlanDispatch =
        queuedTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch;
      const modelSelectionForPlanDispatch = queuedTurn?.modelSelection ?? selectedModelSelection;
      const sourceProposedPlan =
        nextInteractionMode === "default"
          ? buildSourceProposedPlanReference({
              threadId: activeThread.id,
              proposedPlan: activeProposedPlan,
            })
          : undefined;
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: modelSelectionForPlanDispatch.provider,
        providerOptions: providerOptionsForPlanDispatch,
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
        modelSelection: modelSelectionForPlanDispatch,
        ...(providerOptionsForPlanDispatch
          ? {
              providerOptions: providerOptionsForPlanDispatch,
            }
          : {}),
        assistantDeliveryMode,
        dispatchMode,
        runtimeMode: queuedTurn?.runtimeMode ?? runtimeMode,
        interactionMode: nextInteractionMode,
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
        createdAt: messageCreatedAt,
      });
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
          threadId: activeThread.id,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelection,
          runtimeMode,
          interactionMode,
        });
        await api.orchestration.dispatchCommand({
          type: "thread.message.edit-and-resend",
          commandId: newCommandId(),
          threadId: activeThread.id,
          messageId,
          text: outgoingMessageText,
          modelSelection: selectedModelSelection,
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode,
          runtimeMode,
          interactionMode,
          createdAt: messageCreatedAt,
        });
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
      interactionMode,
      persistThreadSettingsForNextTurn,
      providerOptionsForDispatch,
      runtimeMode,
      selectedModel,
      selectedModelSelection,
      selectedPromptEffort,
      selectedProvider,
      setThreadError,
      assistantDeliveryMode,
    ],
  );
  // Resuming a workflow is a normal composer turn instructing the agent to
  // re-invoke the Workflow tool against the persisted script; completed agent()
  // calls replay from cache, so a paused run picks up where it stopped. Sent as
  // a pre-built chat turn so it takes the exact send path a queued turn does.

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
      modelSelection: selectedModelSelection,
      ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
      runtimeMode,
      interactionMode,
      envMode,
    });
    if (sent && activeThreadId) {
      markWorkflowRunDismissed(activeThreadId, workflowTaskId);
    }
  }, [
    lateComposerSendHandlersRef,
    activeThreadId,
    envMode,
    interactionMode,
    markWorkflowRunDismissed,
    providerOptionsForDispatch,
    runtimeMode,
    selectedModel,
    selectedModelSelection,
    selectedPromptEffort,
    selectedProvider,
    workflowRunState,
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
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;
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
        modelSelection: nextThreadModelSelection,
        runtimeMode,
        interactionMode: "default",
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
          provider: selectedModelSelection.provider,
          providerOptions: providerOptionsForDispatch,
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
          modelSelection: selectedModelSelection,
          ...(providerOptionsForDispatch ? { providerOptions: providerOptionsForDispatch } : {}),
          assistantDeliveryMode,
          dispatchMode: "queue",
          runtimeMode,
          interactionMode: "default",
          ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
          createdAt,
        });
      })
      .then(() => {
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
    runtimeMode,
    selectedPromptEffort,
    selectedModelSelection,
    providerOptionsForDispatch,
    rememberCustomBinaryPathForDispatch,
    selectedProvider,
    assistantDeliveryMode,
    syncServerShellSnapshot,
    selectedModel,
  ]);
  return {
    onSubmitPlanFollowUp,
    onEditUserMessage,
    onResumeWorkflowRun,
    onImplementPlanInNewThread,
  };
}
