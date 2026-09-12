import {
  resolveQueuedTurnDispatchSettings,
  queuedChatTurnDispatchFields,
  queuedPlanFollowUpDispatchFields,
} from "../ChatView.logic";
import { useCallback } from "react";
import {
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
} from "~/lib/composerMentions";
import { resolveProviderSendAvailabilityWithRefresh } from "~/lib/providerAvailability";
import { newMessageId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { resolveFollowUpDispatchMode } from "../../appSettings";
import { useComposerDraftStore, type QueuedComposerChatTurn } from "../../composerDraftStore";
import { appendAssistantSelectionsToPrompt } from "../../lib/assistantSelections";
import { appendBrowserAnnotationsToPrompt } from "../../lib/browserAnnotations";
import { appendPastedTextsToPrompt } from "../../lib/composerPastedText";
import {
  findPendingBlobComposerAttachments,
  formatOutgoingComposerPrompt,
  hydratePendingBlobComposerAttachments,
  readFileAsDataUrl,
  stageUploadComposerAttachments,
} from "../../lib/composerSend";
import { appendFileCommentsToPrompt } from "../../lib/fileComments";
import { appendPullRequestContextsToPrompt } from "../../lib/pullRequestContext";
import {
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  appendTerminalContextsToPrompt,
} from "../../lib/terminalContext";
import { setPendingUserInputCustomAnswer } from "../../pendingUserInput";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import { buildSourceProposedPlanReference } from "../../session-logic";
import {
  buildExpiredTerminalContextToastCopy,
  createWorktreeSetupResolution,
  deriveComposerSendState,
  resolveEnvironmentPanelPreferenceAfterFirstSend,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";
import { handleChatAutomationSend } from "./handleChatAutomationSend";
import { prepareChatSendWorkspace } from "./prepareChatSendWorkspace";
import {
  buildQueuedComposerPreviewText,
  composerPromptStillMatchesRestoredQueuedDraft,
} from "./queuedComposerPreview";
import { resolveChatPromptCaptures } from "./resolveChatPromptCaptures";
import { useChatTurnExecution } from "./useChatTurnExecution";

export function useChatTurnSubmission({
  turnDispatchSettings,
  setComposerDraftComputerControl,
  threadId,
  hasLiveTurn,
  lateComposerSendHandlersRef,
  activeThread,
  isConnecting,
  sendPreflightInFlightRef,
  sendInFlightRef,
  runtimeMode,
  interactionMode,
  envMode,
  showPlanFollowUpPrompt,
  activeProposedPlan,
  hasQueueableLiveTurn,
  clearComposerInput,
  scheduleComposerFocus,
  activeProject,
  threadWorkspaceCwd,
  refreshProviderStatuses,
  isServerThread,
  hasNativeUserMessages,
  chatWorkspaceRoot,
  isHomeChatContainer,
  isStudioContainer,
  resolvedThreadWorktreePath,
  resolvedThreadWorkingDirectory,
  currentActiveGitBranch,
  isContainerLandingProject,
  syncServerShellSnapshot,
  activeRootBranch,
  gitBranchSourceCwd,
  setStoreThreadError,
  queryClient,
  isCenteredEmptyLanding,
  setEnvironmentPanelPreferenceOpen,
  environmentPanelPreferenceOpen,
  setTailAnchor,
  setThreadError,
  setComposerHighlightedItemId,
  setStoreThreadWorkspace,
  createWorktreeMutation,
  isLocalDraftThread,
  threadNotes,
  assistantDeliveryMode,
  setSettledThreadBranchWarningDismissedThreadId,
  setQueuedSteerGate,
  planSidebarDismissedForTurnRef,
  setPlanSidebarOpen,
  settings,
  isSendBusy,
  worktreeSetupResolutionRef,
  setWorktreeSetupPendingAction,
  beginLocalDispatch,
  clearLocalDispatchWorktreeSetup,
  armLocalDispatchAckFallback,
  failLocalDispatchWorktreeSetup,
  scheduleFailedWorktreeSetupDispatchReset,
  resetLocalDispatch,
  isVoiceTranscribing,
  waitForPendingComposerImages,
  activePendingProgress,
  activePendingUserInputKey,
  pendingUserInputAnswersByRequestIdRef,
  setPendingUserInputAnswersByRequestId,
  composerEditorRef,
  promptRef,
  composerImages,
  composerFiles,
  composerAssistantSelections,
  composerBrowserAnnotations,
  composerFileComments,
  composerTerminalContexts,
  composerPastedTexts,
  composerPullRequestContexts,
  restoredQueuedSourceProposedPlanRef,
  enqueueQueuedComposerTurn,
  setComposerDraftPrompt,
  setComposerTrigger,
  clearProjectDraftThreadId,
  setDraftThreadContext,
  promptHistoryNavigationRef,
  applyingPromptHistoryNavigationRef,
  expectedPromptHistoryPromptRef,
  clearComposerDraftContent,
  setComposerDraftInteractionMode,
  setComposerCursor,
  setRestoredQueuedSourceProposedPlan,
  composerImagesRef,
  composerFilesRef,
  composerAssistantSelectionsRef,
  composerBrowserAnnotationsRef,
  composerFileCommentsRef,
  composerTerminalContextsRef,
  composerPastedTextsRef,
  composerPullRequestContextsRef,
  setPrompt,
  addComposerImagesToDraft,
  addComposerFilesToDraft,
  addComposerAssistantSelectionToDraft,
  addComposerDraftBrowserAnnotations,
  addComposerFileCommentToDraft,
  addComposerTerminalContextsToDraft,
  addComposerPastedTextsToDraft,
  addComposerPullRequestContextsToDraft,
  selectedComposerSkillsRef,
  selectedComposerMentionsRef,
  updateSelectedComposerSkills,
  updateSelectedComposerMentions,
  selectedProvider,
  selectedModel,
  selectedPromptEffort,
  selectedModelSelection,
  providerOptionsForDispatch,
  pendingAutomationConversationRef,
  setPendingAutomationConversation,
  pendingAutomationConversation,
  activeThreadIdRef,
  hasLiveTurnRef,
  automationProjects,
  setAutomationDraftWarningContext,
  setAutomationDraftForm,
  setAutomationDraftWarnings,
  setAcknowledgedAutomationWarnings,
  setAutomationDraftOpen,
  armTranscriptAutoFollow,
  tailAnchorScrollInFlightRef,
  prepareAutomationFormForCreate,
  createAutomationFromForm,
  providerStatuses,
  rememberCustomBinaryPathForDispatch,
  setOptimisticUserMessages,
  runProjectScript,
  persistThreadSettingsForNextTurn,
}: ChatTurnSubmissionInput) {
  const executePreparedTurn = useChatTurnExecution({
    isServerThread,
    setStoreThreadWorkspace,
    clearLocalDispatchWorktreeSetup,
    createWorktreeMutation,
    beginLocalDispatch,
    isLocalDraftThread,
    threadNotes,
    runProjectScript,
    persistThreadSettingsForNextTurn,
    rememberCustomBinaryPathForDispatch,
    assistantDeliveryMode,
    setSettledThreadBranchWarningDismissedThreadId,
    armLocalDispatchAckFallback,
    setQueuedSteerGate,
    threadId,
    planSidebarDismissedForTurnRef,
    setPlanSidebarOpen,
    setRestoredQueuedSourceProposedPlan,
    failLocalDispatchWorktreeSetup,
    setOptimisticUserMessages,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    composerBrowserAnnotationsRef,
    composerFileCommentsRef,
    composerTerminalContextsRef,
    composerPastedTextsRef,
    composerPullRequestContextsRef,
    setPrompt,
    setComposerCursor,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerDraftBrowserAnnotations,
    addComposerFileCommentToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerPullRequestContextsToDraft,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    setComposerTrigger,
    setThreadError,
    sendInFlightRef,
    worktreeSetupResolutionRef,
    scheduleFailedWorktreeSetupDispatchReset,
    resetLocalDispatch,
  });

  const onSend = useCallback(
    async (
      e?: { preventDefault: () => void },
      requestedDispatchMode?: "queue" | "steer",
      queuedTurn?: QueuedComposerChatTurn,
    ): Promise<boolean> => {
      const dispatchMode =
        requestedDispatchMode ??
        resolveFollowUpDispatchMode({
          behavior: settings.followUpBehavior,
          hasLiveTurn,
        });
      e?.preventDefault();
      const api = readNativeApi();
      const lateSendHandlers = lateComposerSendHandlersRef.current;
      if (
        !api ||
        !lateSendHandlers ||
        !activeThread ||
        activeThread.sidechatExpiredAt ||
        isSendBusy ||
        isConnecting ||
        isVoiceTranscribing ||
        sendPreflightInFlightRef.current ||
        sendInFlightRef.current
      ) {
        return false;
      }
      if (!queuedTurn) {
        sendPreflightInFlightRef.current = true;
        await waitForPendingComposerImages();
        sendPreflightInFlightRef.current = false;
      }
      if (activePendingProgress) {
        const activeQuestion = activePendingProgress.activeQuestion;
        const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
        const livePendingAnswerText = liveComposerSnapshot?.value ?? promptRef.current;
        const currentDraftAnswer =
          activePendingUserInputKey && activeQuestion
            ? pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[
                activeQuestion.id
              ]
            : undefined;
        const answerOverrides =
          activeQuestion && livePendingAnswerText.trim().length > 0
            ? {
                [activeQuestion.id]: setPendingUserInputCustomAnswer(
                  currentDraftAnswer,
                  livePendingAnswerText,
                ),
              }
            : undefined;
        if (activePendingUserInputKey && answerOverrides) {
          const nextRequestAnswers = {
            ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
            ...answerOverrides,
          };
          pendingUserInputAnswersByRequestIdRef.current = {
            ...pendingUserInputAnswersByRequestIdRef.current,
            [activePendingUserInputKey]: nextRequestAnswers,
          };
          setPendingUserInputAnswersByRequestId((existing) => ({
            ...existing,
            [activePendingUserInputKey]: nextRequestAnswers,
          }));
        }
        return lateSendHandlers.advanceActivePendingUserInput(answerOverrides);
      }
      const queuedChatTurn = queuedTurn ?? null;
      const liveComposerSnapshot =
        queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
      let promptForSend =
        queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
      let composerImagesForSend =
        queuedChatTurn?.images ??
        useComposerDraftStore.getState().draftsByThreadId[activeThread.id]?.images ??
        composerImages;
      // AppSnap captures persist as IndexedDB blobs and hydrate into `images`
      // asynchronously (see AppSnapCoordinator). Right after a reload the user can
      // hit send before that hydration finishes; without this, the not-yet-hydrated
      // capture would be silently dropped from the message and then have its blob
      // deleted when the composer clears after send. Live sends only: a queued turn
      // already captured a fully-resolved image snapshot when it was queued.
      if (queuedChatTurn === null) {
        const pendingBlobAttachments = findPendingBlobComposerAttachments({
          persistedAttachments:
            useComposerDraftStore.getState().draftsByThreadId[activeThread.id]
              ?.persistedAttachments ?? [],
          images: composerImagesForSend,
        });
        if (pendingBlobAttachments.length > 0) {
          const hydratedPendingImages =
            await hydratePendingBlobComposerAttachments(pendingBlobAttachments);
          if (hydratedPendingImages.length > 0) {
            composerImagesForSend = [...composerImagesForSend, ...hydratedPendingImages];
          }
        }
      }
      const composerFilesForSend = queuedChatTurn?.files ?? composerFiles;
      const composerAssistantSelectionsForSend =
        queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
      const composerBrowserAnnotationsForSend =
        queuedChatTurn?.browserAnnotations ?? composerBrowserAnnotations;
      const composerFileCommentsForSend = queuedChatTurn?.fileComments ?? composerFileComments;
      const composerTerminalContextsForSend =
        queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
      const composerPastedTextsForSend = queuedChatTurn?.pastedTexts ?? composerPastedTexts;
      const composerPullRequestContextsForSend =
        queuedChatTurn?.pullRequestContexts ?? composerPullRequestContexts;
      const selectedComposerSkillsForSend =
        queuedChatTurn?.skills ?? selectedComposerSkillsRef.current;
      const selectedComposerMentionsForSend =
        queuedChatTurn?.mentions ?? selectedComposerMentionsRef.current;
      const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
      const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
      const selectedPromptEffortForSend =
        queuedChatTurn?.selectedPromptEffort ?? selectedPromptEffort;
      // A queued turn replays the settings it froze when it was queued; a live send
      // uses the composer's current ones.
      const dispatchSettingsForSend = resolveQueuedTurnDispatchSettings(
        turnDispatchSettings,
        queuedChatTurn,
      );
      const selectedModelSelectionForSend = dispatchSettingsForSend.modelSelection;
      const providerOptionsForDispatchForSend = dispatchSettingsForSend.providerOptions;
      const enableComputerControlForSend = dispatchSettingsForSend.enableComputerControl;
      const runtimeModeForSend = dispatchSettingsForSend.runtimeMode;
      let interactionModeForSend = dispatchSettingsForSend.interactionMode;
      const envModeForSend = dispatchSettingsForSend.envMode;
      const {
        trimmedPrompt: trimmed,
        sendableTerminalContexts: sendableComposerTerminalContexts,
        expiredTerminalContextCount,
        sendablePastedTexts: sendableComposerPastedTexts,
        sendablePullRequestContexts: sendableComposerPullRequestContexts,
        hasSendableContent,
      } = deriveComposerSendState({
        prompt: promptForSend,
        imageCount: composerImagesForSend.length,
        fileCount: composerFilesForSend.length,
        assistantSelectionCount: composerAssistantSelectionsForSend.length,
        browserAnnotationCount: composerBrowserAnnotationsForSend.length,
        fileCommentCount: composerFileCommentsForSend.length,
        terminalContexts: composerTerminalContextsForSend,
        pastedTexts: composerPastedTextsForSend,
        pullRequestContexts: composerPullRequestContextsForSend,
      });
      let trimmedPromptForSend = trimmed;
      const restoredQueuedPlanDraftSource =
        queuedChatTurn === null &&
        restoredQueuedSourceProposedPlanRef.current?.threadId === activeThread.id &&
        composerPromptStillMatchesRestoredQueuedDraft(
          restoredQueuedSourceProposedPlanRef.current.restoredPrompt,
          promptForSend,
        )
          ? restoredQueuedSourceProposedPlanRef.current
          : null;
      const isLivePlanFollowUpSubmission =
        queuedChatTurn === null &&
        restoredQueuedPlanDraftSource === null &&
        showPlanFollowUpPrompt &&
        activeProposedPlan !== null;
      const hasStructuredPlanFollowUpContent =
        composerImagesForSend.length > 0 ||
        composerFilesForSend.length > 0 ||
        composerAssistantSelectionsForSend.length > 0 ||
        composerBrowserAnnotationsForSend.length > 0 ||
        composerFileCommentsForSend.length > 0 ||
        sendableComposerTerminalContexts.length > 0 ||
        sendableComposerPastedTexts.length > 0;
      // Queued chat turns already captured their intended mode. Live plan follow-ups
      // with attachments must use the normal send path so references are preserved.
      if (isLivePlanFollowUpSubmission) {
        const followUp = resolvePlanFollowUpSubmission({
          draftText: trimmed,
          planMarkdown: activeProposedPlan.planMarkdown,
        });
        if (hasStructuredPlanFollowUpContent) {
          promptForSend = followUp.text;
          interactionModeForSend = followUp.interactionMode;
          trimmedPromptForSend = followUp.text.trim();
        } else {
          if (hasQueueableLiveTurn && dispatchMode === "queue") {
            clearComposerInput(activeThread.id);
            scheduleComposerFocus();
            enqueueQueuedComposerTurn(activeThread.id, {
              id: randomUUID(),
              kind: "plan-follow-up",
              createdAt: new Date().toISOString(),
              previewText: followUp.text.trim(),
              text: followUp.text,
              interactionMode: followUp.interactionMode,
              selectedProvider,
              selectedModel,
              selectedPromptEffort,
              ...queuedPlanFollowUpDispatchFields(dispatchSettingsForSend),
            });
            return true;
          }
          clearComposerInput(activeThread.id);
          scheduleComposerFocus();
          return lateSendHandlers.submitPlanFollowUp({
            text: followUp.text,
            interactionMode: followUp.interactionMode,
            dispatchMode,
          });
        }
      }
      const hasNoStructuredComposerContext =
        composerImagesForSend.length === 0 &&
        composerFilesForSend.length === 0 &&
        composerAssistantSelectionsForSend.length === 0 &&
        composerBrowserAnnotationsForSend.length === 0 &&
        composerFileCommentsForSend.length === 0 &&
        sendableComposerTerminalContexts.length === 0 &&
        sendableComposerPastedTexts.length === 0 &&
        // Provider mentions are structured turn metadata, and automation definitions persist text only.
        selectedComposerMentionsForSend.length === 0;
      const hasPromptOnlySendableContent = hasNoStructuredComposerContext;
      if (hasPromptOnlySendableContent) {
        const handledSlashCommand =
          await lateSendHandlers.handleStandaloneSlashCommand(trimmedPromptForSend);
        if (handledSlashCommand) {
          // A slash command (e.g. /clear) consumes the composer, so abandon any in-progress
          // automation setup rather than leaving a stale banner/request behind.
          pendingAutomationConversationRef.current = null;
          setPendingAutomationConversation(null);
          return true;
        }
      }
      const sourceProposedPlanForSend =
        queuedChatTurn?.sourceProposedPlan ??
        restoredQueuedPlanDraftSource?.sourceProposedPlan ??
        (isLivePlanFollowUpSubmission && activeProposedPlan && interactionModeForSend === "default"
          ? buildSourceProposedPlanReference({
              threadId: activeThread.id,
              proposedPlan: activeProposedPlan,
            })
          : undefined);
      if (!hasSendableContent) {
        if (expiredTerminalContextCount > 0) {
          const toastCopy = buildExpiredTerminalContextToastCopy(
            expiredTerminalContextCount,
            "empty",
          );
          toastManager.add({
            type: "warning",
            title: toastCopy.title,
            description: toastCopy.description,
          });
        }
        return false;
      }
      if (!activeProject) return false;
      if (queuedChatTurn === null && !isLivePlanFollowUpSubmission) {
        const handled = await handleChatAutomationSend({
          threadId,
          pendingAutomationConversation,
          trimmedPromptForSend,
          threadWorkspaceCwd,
          activeProject,
          api,
          activeThreadIdRef,
          pendingAutomationConversationRef,
          hasLiveTurn,
          hasLiveTurnRef,
          hasPromptOnlySendableContent,
          promptRef,
          setComposerDraftPrompt,
          activeThread,
          setComposerTrigger,
          armTranscriptAutoFollow,
          setPendingAutomationConversation,
          automationProjects,
          selectedModelSelectionForSend,
          setAutomationDraftWarningContext,
          setAutomationDraftForm,
          setAutomationDraftWarnings,
          setAcknowledgedAutomationWarnings,
          setAutomationDraftOpen,
          prepareAutomationFormForCreate,
          createAutomationFromForm,
          providerOptionsForDispatchForSend,
        });
        if (handled) return true;
      }
      sendPreflightInFlightRef.current = true;
      const sendProviderAvailability = await resolveProviderSendAvailabilityWithRefresh({
        provider: selectedModelSelectionForSend.provider,
        statuses: providerStatuses,
        refreshStatuses: () => refreshProviderStatuses({ silent: true }),
      }).finally(() => {
        sendPreflightInFlightRef.current = false;
      });
      if (!sendProviderAvailability.usable) {
        toastManager.add({
          type: "error",
          title: sendProviderAvailability.unavailableReason,
        });
        return false;
      }

      const captures = await resolveChatPromptCaptures({
        api,
        activeThread,
        promptForSend,
        composerImagesForSend,
        composerFilesForSend,
        composerAssistantSelectionsForSend,
      });
      composerImagesForSend = captures.composerImagesForSend;

      if (hasQueueableLiveTurn && dispatchMode === "queue" && queuedChatTurn === null) {
        clearComposerInput(activeThread.id);
        scheduleComposerFocus();
        const queuedImagesForPersistence = await Promise.all(
          composerImagesForSend.map(async (image) => {
            try {
              return {
                ...image,
                previewUrl: await readFileAsDataUrl(image.file),
              };
            } catch {
              return image;
            }
          }),
        );
        enqueueQueuedComposerTurn(activeThread.id, {
          id: randomUUID(),
          kind: "chat",
          createdAt: new Date().toISOString(),
          previewText: buildQueuedComposerPreviewText({
            trimmedPrompt: trimmed,
            images: queuedImagesForPersistence,
            files: composerFilesForSend,
            assistantSelections: composerAssistantSelectionsForSend,
            browserAnnotations: composerBrowserAnnotationsForSend,
            terminalContexts: sendableComposerTerminalContexts,
            fileComments: composerFileCommentsForSend,
            pastedTexts: sendableComposerPastedTexts,
            pullRequestContexts: sendableComposerPullRequestContexts,
          }),
          prompt: promptForSend,
          images: queuedImagesForPersistence,
          files: composerFilesForSend,
          assistantSelections: composerAssistantSelectionsForSend,
          browserAnnotations: composerBrowserAnnotationsForSend,
          fileComments: composerFileCommentsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          pastedTexts: sendableComposerPastedTexts,
          pullRequestContexts: sendableComposerPullRequestContexts,
          skills: selectedComposerSkillsForSend,
          mentions: selectedComposerMentionsForSend,
          selectedProvider: selectedProviderForSend,
          selectedModel: selectedModelForSend,
          selectedPromptEffort: selectedPromptEffortForSend,
          ...queuedChatTurnDispatchFields(
            {
              ...dispatchSettingsForSend,
              // A plan follow-up carrying attachments rewrites the mode mid-send.
              interactionMode: interactionModeForSend,
            },
            sourceProposedPlanForSend,
          ),
        });
        return true;
      }
      const workspace = await prepareChatSendWorkspace({
        activeThread,
        isServerThread,
        hasNativeUserMessages,
        composerImagesForSend,
        trimmedPromptForSend,
        composerFilesForSend,
        composerAssistantSelectionsForSend,
        composerBrowserAnnotationsForSend,
        sendableComposerTerminalContexts,
        composerFileCommentsForSend,
        sendableComposerPastedTexts,
        selectedModelSelectionForSend,
        selectedModelForSend,
        activeProject,
        chatWorkspaceRoot,
        isHomeChatContainer,
        isStudioContainer,
        resolvedThreadWorktreePath,
        runtimeModeForSend,
        envModeForSend,
        resolvedThreadWorkingDirectory,
        currentActiveGitBranch,
        isContainerLandingProject,
        api,
        syncServerShellSnapshot,
        clearProjectDraftThreadId,
        setDraftThreadContext,
        activeRootBranch,
        gitBranchSourceCwd,
        setStoreThreadError,
        queryClient,
      });
      if (workspace === false) return false;
      const {
        threadIdForSend,
        title,
        targetProjectIdForSend,
        targetProjectKindForSend,
        targetProjectCwdForSend,
        targetProjectDefaultModelSelectionForSend,
        nextRuntimeModeForSend,
        nextThreadEnvMode,
        nextThreadBranch,
        nextThreadWorktreePath,
        nextThreadWorkingDirectory,
        nextAssociatedWorktreePath,
        nextAssociatedWorktreeBranch,
        nextAssociatedWorktreeRef,
        shouldResumeSettledLocalThread,
        currentActiveGitBranchForSend,
        baseBranchForWorktree,
        setupScriptForWorktree,
        worktreeSetupScriptName,
        worktreeCopiesLocalChanges,
      } = workspace;
      const messageIdForSend = newMessageId();
      const worktreeSetupResolution = baseBranchForWorktree
        ? createWorktreeSetupResolution()
        : null;
      worktreeSetupResolutionRef.current = worktreeSetupResolution;
      if (worktreeSetupResolution) {
        setWorktreeSetupPendingAction(null);
      }

      sendInFlightRef.current = true;
      beginLocalDispatch({
        expectedUserMessageId: messageIdForSend,
        ...(baseBranchForWorktree
          ? {
              worktreeSetupStepId: "create-branch" as const,
              setupScriptName: worktreeSetupScriptName,
              copyLocalChanges: worktreeCopiesLocalChanges,
            }
          : {}),
      });

      const composerImagesSnapshot = [...composerImagesForSend];
      const composerFilesSnapshot = [...composerFilesForSend];
      const composerAssistantSelectionsSnapshot = [...composerAssistantSelectionsForSend];
      const composerBrowserAnnotationsSnapshot = composerBrowserAnnotationsForSend.map(
        (annotation) => ({ ...annotation, source: { ...annotation.source } }),
      );
      const composerFileCommentsSnapshot = [...composerFileCommentsForSend];
      const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
      const composerPastedTextsSnapshot = [...sendableComposerPastedTexts];
      const composerPullRequestContextsSnapshot = [...sendableComposerPullRequestContexts];
      const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
      const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
      // Trailing blocks are appended innermost-to-outermost: assistant selections,
      // terminal contexts, file comments, pasted text, pull request contexts, then
      // browser annotations (outermost). The display extractors unwrap them in the
      // reverse order.
      const messageTextForSend = appendBrowserAnnotationsToPrompt(
        appendPullRequestContextsToPrompt(
          appendPastedTextsToPrompt(
            appendFileCommentsToPrompt(
              appendTerminalContextsToPrompt(
                appendAssistantSelectionsToPrompt(
                  promptForSend,
                  composerAssistantSelectionsSnapshot,
                ),
                composerTerminalContextsSnapshot,
              ),
              composerFileCommentsSnapshot,
            ),
            composerPastedTextsSnapshot,
          ),
          composerPullRequestContextsSnapshot,
        ),
        composerBrowserAnnotationsSnapshot,
        messageIdForSend,
      );
      const messageCreatedAt = new Date().toISOString();
      const outgoingTextSeed =
        messageTextForSend ||
        (composerImagesSnapshot.length > 0 ? IMAGE_ONLY_BOOTSTRAP_PROMPT : "");
      const outgoingMessageText = formatOutgoingComposerPrompt({
        provider: selectedProviderForSend,
        model: selectedModelForSend,
        effort: selectedPromptEffortForSend,
        text: outgoingTextSeed,
      });
      const mentionedSkillsForSend = filterPromptSkillReferences(
        outgoingMessageText,
        selectedComposerSkillsForSend,
        selectedProviderForSend,
      );
      const mentionedPluginMentionsForSend = filterPromptProviderMentionReferences(
        outgoingMessageText,
        selectedComposerMentionsForSend,
      );
      const turnAttachmentsPromise = stageUploadComposerAttachments({
        threadId: threadIdForSend,
        images: composerImagesSnapshot,
        files: composerFilesSnapshot,
        assistantSelections: composerAssistantSelectionsSnapshot,
      });
      const optimisticAttachments = [
        ...composerAssistantSelectionsSnapshot,
        ...composerImagesSnapshot.map((image) => ({
          type: "image" as const,
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          previewUrl: image.previewUrl,
        })),
        ...composerFilesSnapshot.map((file) => ({
          type: "file" as const,
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        })),
      ];
      // Sending the first message flips the centered empty landing into a normal
      // transcript. Clear session-only landing overrides when default-open is enabled;
      // otherwise keep the transition closed.
      if (isCenteredEmptyLanding) {
        setEnvironmentPanelPreferenceOpen(
          resolveEnvironmentPanelPreferenceAfterFirstSend({
            isCenteredEmptyLanding,
            settingsDefaultOpen: settings.environmentPanelDefaultOpen,
            currentPreferenceOpen: environmentPanelPreferenceOpen,
          }),
        );
      }
      setOptimisticUserMessages((existing) => [
        ...existing,
        {
          id: messageIdForSend,
          role: "user",
          text: outgoingMessageText,
          dispatchMode,
          ...(optimisticAttachments.length > 0 ? { attachments: optimisticAttachments } : {}),
          ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
          ...(mentionedPluginMentionsForSend.length > 0
            ? { mentions: mentionedPluginMentionsForSend }
            : {}),
          createdAt: messageCreatedAt,
          streaming: false,
          source: "native",
        },
      ]);
      // Mark the transcript as anchored before the optimistic row lands. The tail
      // anchor sizes the spacer that lets this message sit at the viewport top,
      // and its hook owns the slide; auto-follow stays armed for bookkeeping but
      // pauses until the in-flight flag clears.
      armTranscriptAutoFollow(threadIdForSend, true);
      tailAnchorScrollInFlightRef.current = true;
      setTailAnchor({ threadId: threadIdForSend, messageId: messageIdForSend });

      setThreadError(threadIdForSend, null);
      if (expiredTerminalContextCount > 0) {
        const toastCopy = buildExpiredTerminalContextToastCopy(
          expiredTerminalContextCount,
          "omitted",
        );
        toastManager.add({
          type: "warning",
          title: toastCopy.title,
          description: toastCopy.description,
        });
      }
      // A chat's first send records the new-chat computer-control default as the
      // chat's own choice, so a later change to the machine-wide setting leaves
      // this chat as it was. Read the store, not the render closure: the draft
      // may have been touched since this send began.
      if (
        enableComputerControlForSend &&
        useComposerDraftStore.getState().draftsByThreadId[threadIdForSend]
          ?.enableComputerControl === undefined
      ) {
        setComposerDraftComputerControl(threadIdForSend, true);
      }
      // Queued turns are dispatched from their captured snapshot, so this send path
      // must not clear a separate live draft the user may already be editing.
      if (queuedChatTurn === null) {
        promptHistoryNavigationRef.current = null;
        applyingPromptHistoryNavigationRef.current = false;
        expectedPromptHistoryPromptRef.current = null;
        promptRef.current = "";
        clearComposerDraftContent(threadIdForSend, { preservePreviewUrls: true });
        if (isLivePlanFollowUpSubmission) {
          setComposerDraftInteractionMode(threadIdForSend, interactionModeForSend);
        }
        setComposerHighlightedItemId(null);
        setComposerCursor(0);
        setComposerTrigger(null);
        // A clicked submit button steals focus; return it after the controlled
        // draft reset so rapid follow-up typing lands in the composer.
        scheduleComposerFocus();
      }

      return executePreparedTurn({
        dispatchSettingsForSend,
        nextThreadEnvMode,
        nextThreadBranch,
        nextThreadWorktreePath,
        nextAssociatedWorktreePath,
        nextAssociatedWorktreeBranch,
        nextAssociatedWorktreeRef,
        api,
        targetProjectCwdForSend,
        threadIdForSend,
        worktreeSetupResolution,
        baseBranchForWorktree,
        worktreeCopiesLocalChanges,
        worktreeSetupScriptName,
        selectedModelSelectionForSend,
        selectedModelForSend,
        targetProjectDefaultModelSelectionForSend,
        targetProjectIdForSend,
        title,
        nextRuntimeModeForSend,
        interactionModeForSend,
        nextThreadWorkingDirectory,
        activeThread,
        targetProjectKindForSend,
        setupScriptForWorktree,
        messageCreatedAt,
        turnAttachmentsPromise,
        messageIdForSend,
        providerOptionsForDispatchForSend,
        outgoingMessageText,
        mentionedSkillsForSend,
        mentionedPluginMentionsForSend,
        dispatchMode,
        sourceProposedPlanForSend,
        shouldResumeSettledLocalThread,
        currentActiveGitBranchForSend,
        queuedChatTurn,
        promptForSend,
        composerImagesSnapshot,
        composerFilesSnapshot,
        composerAssistantSelectionsSnapshot,
        composerBrowserAnnotationsSnapshot,
        composerFileCommentsSnapshot,
        composerTerminalContextsSnapshot,
        composerPastedTextsSnapshot,
        composerPullRequestContextsSnapshot,
        composerSkillsSnapshot,
        composerMentionsSnapshot,
      });
    },
    [
      threadId,
      hasLiveTurn,
      lateComposerSendHandlersRef,
      activeThread,
      isConnecting,
      sendPreflightInFlightRef,
      sendInFlightRef,
      showPlanFollowUpPrompt,
      activeProposedPlan,
      hasQueueableLiveTurn,
      clearComposerInput,
      scheduleComposerFocus,
      activeProject,
      threadWorkspaceCwd,
      refreshProviderStatuses,
      isServerThread,
      hasNativeUserMessages,
      chatWorkspaceRoot,
      isHomeChatContainer,
      isStudioContainer,
      resolvedThreadWorktreePath,
      resolvedThreadWorkingDirectory,
      currentActiveGitBranch,
      isContainerLandingProject,
      syncServerShellSnapshot,
      activeRootBranch,
      gitBranchSourceCwd,
      setStoreThreadError,
      queryClient,
      isCenteredEmptyLanding,
      setEnvironmentPanelPreferenceOpen,
      environmentPanelPreferenceOpen,
      setTailAnchor,
      setThreadError,
      setComposerHighlightedItemId,
      settings,
      isSendBusy,
      worktreeSetupResolutionRef,
      setWorktreeSetupPendingAction,
      beginLocalDispatch,
      isVoiceTranscribing,
      waitForPendingComposerImages,
      activePendingProgress,
      activePendingUserInputKey,
      pendingUserInputAnswersByRequestIdRef,
      setPendingUserInputAnswersByRequestId,
      composerEditorRef,
      promptRef,
      composerImages,
      composerFiles,
      composerAssistantSelections,
      composerBrowserAnnotations,
      composerFileComments,
      composerTerminalContexts,
      composerPastedTexts,
      composerPullRequestContexts,
      restoredQueuedSourceProposedPlanRef,
      turnDispatchSettings,
      setComposerDraftComputerControl,
      enqueueQueuedComposerTurn,
      setComposerDraftPrompt,
      setComposerTrigger,
      clearProjectDraftThreadId,
      setDraftThreadContext,
      promptHistoryNavigationRef,
      applyingPromptHistoryNavigationRef,
      expectedPromptHistoryPromptRef,
      clearComposerDraftContent,
      setComposerDraftInteractionMode,
      setComposerCursor,
      selectedComposerSkillsRef,
      selectedComposerMentionsRef,
      selectedProvider,
      selectedModel,
      selectedPromptEffort,
      pendingAutomationConversationRef,
      setPendingAutomationConversation,
      pendingAutomationConversation,
      activeThreadIdRef,
      hasLiveTurnRef,
      automationProjects,
      setAutomationDraftWarningContext,
      setAutomationDraftForm,
      setAutomationDraftWarnings,
      setAcknowledgedAutomationWarnings,
      setAutomationDraftOpen,
      armTranscriptAutoFollow,
      tailAnchorScrollInFlightRef,
      prepareAutomationFormForCreate,
      createAutomationFromForm,
      providerStatuses,
      setOptimisticUserMessages,
      executePreparedTurn,
    ],
  );
  return { onSend };
}
