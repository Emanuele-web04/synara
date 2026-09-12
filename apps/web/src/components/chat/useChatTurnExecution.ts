import {
  type TurnDispatchSettings,
  threadSettingsDispatchFields,
  turnStartDispatchFields,
} from "../ChatView.logic";
import type {
  ProjectId,
  ProjectScript,
  ProviderMentionReference,
  ProviderSkillReference,
} from "@synara/contracts";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type ModelSelection,
  type ProviderStartOptions,
} from "@synara/contracts";
import { buildTemporaryWorktreeBranchName } from "@synara/shared/git";
import { getDefaultModel } from "@synara/shared/model";
import { providerSupportsNativeTurnSteering } from "@synara/shared/providerMetadata";
import { useCallback } from "react";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import { dispatchThreadGoal } from "~/threadGoal";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import { type DraftThreadEnvMode, type QueuedComposerChatTurn } from "../../composerDraftStore";
import {
  cloneComposerImageAttachment,
  stageUploadComposerAttachments,
} from "../../lib/composerSend";
import { armQueuedComposerSteerGate } from "../../lib/queuedComposerDrain";
import { clearPendingTurnDispatch } from "../../pendingTurnDispatch";
import { buildModelSelection } from "../../providerModelOptions";
import { type Thread } from "../../types";
import {
  WorktreeSetupCancelledError,
  createWorktreeSetupResolution,
  revokeUserMessagePreviewUrls,
  runWorktreeCreationFlow,
} from "../ChatView.logic";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";
import { waitForSetupScriptTerminalActivity } from "./projectScriptRuntime";
interface PreparedChatTurn {
  dispatchSettingsForSend: TurnDispatchSettings;
  nextThreadEnvMode: DraftThreadEnvMode;
  nextThreadBranch: string | null;
  nextThreadWorktreePath: string | null;
  nextAssociatedWorktreePath: string | null;
  nextAssociatedWorktreeBranch: string | null;
  nextAssociatedWorktreeRef: string | null;
  api: NonNullable<ReturnType<typeof readNativeApi>>;
  targetProjectCwdForSend: string;
  threadIdForSend: ThreadId;
  worktreeSetupResolution: ReturnType<typeof createWorktreeSetupResolution> | null;
  baseBranchForWorktree: string | null;
  worktreeCopiesLocalChanges: boolean;
  worktreeSetupScriptName: string | null;
  selectedModelSelectionForSend: ModelSelection;
  selectedModelForSend: string;
  targetProjectDefaultModelSelectionForSend: ModelSelection | null;
  targetProjectIdForSend: ProjectId;
  title: string;
  nextRuntimeModeForSend: RuntimeMode;
  interactionModeForSend: ProviderInteractionMode;
  nextThreadWorkingDirectory: string | null;
  activeThread: Thread;
  targetProjectKindForSend: "project" | "chat" | "studio";
  setupScriptForWorktree: ProjectScript | null;
  messageCreatedAt: string;
  turnAttachmentsPromise: ReturnType<typeof stageUploadComposerAttachments>;
  messageIdForSend: MessageId;
  providerOptionsForDispatchForSend: ProviderStartOptions | undefined;
  outgoingMessageText: string;
  mentionedSkillsForSend: ProviderSkillReference[];
  mentionedPluginMentionsForSend: ProviderMentionReference[];
  dispatchMode: "queue" | "steer";
  sourceProposedPlanForSend: QueuedComposerChatTurn["sourceProposedPlan"];
  shouldResumeSettledLocalThread: boolean;
  currentActiveGitBranchForSend: string | null;
  queuedChatTurn: QueuedComposerChatTurn | null;
  promptForSend: string;
  composerImagesSnapshot: ChatTurnSubmissionInput["composerImages"];
  composerFilesSnapshot: ChatTurnSubmissionInput["composerFiles"];
  composerAssistantSelectionsSnapshot: ChatTurnSubmissionInput["composerAssistantSelections"];
  composerBrowserAnnotationsSnapshot: ChatTurnSubmissionInput["composerBrowserAnnotations"];
  composerFileCommentsSnapshot: ChatTurnSubmissionInput["composerFileComments"];
  composerTerminalContextsSnapshot: ChatTurnSubmissionInput["composerTerminalContexts"];
  composerPastedTextsSnapshot: ChatTurnSubmissionInput["composerPastedTexts"];
  composerPullRequestContextsSnapshot: ChatTurnSubmissionInput["composerPullRequestContexts"];
  composerSkillsSnapshot: ProviderSkillReference[];
  composerMentionsSnapshot: ProviderMentionReference[];
}
type ChatTurnExecutionInput = Pick<
  ChatTurnSubmissionInput,
  | "isServerThread"
  | "setStoreThreadWorkspace"
  | "clearLocalDispatchWorktreeSetup"
  | "createWorktreeMutation"
  | "beginLocalDispatch"
  | "isLocalDraftThread"
  | "threadNotes"
  | "runProjectScript"
  | "persistThreadSettingsForNextTurn"
  | "rememberCustomBinaryPathForDispatch"
  | "assistantDeliveryMode"
  | "setSettledThreadBranchWarningDismissedThreadId"
  | "armLocalDispatchAckFallback"
  | "setQueuedSteerGate"
  | "threadId"
  | "planSidebarDismissedForTurnRef"
  | "setPlanSidebarOpen"
  | "setRestoredQueuedSourceProposedPlan"
  | "failLocalDispatchWorktreeSetup"
  | "setOptimisticUserMessages"
  | "promptRef"
  | "composerImagesRef"
  | "composerFilesRef"
  | "composerAssistantSelectionsRef"
  | "composerBrowserAnnotationsRef"
  | "composerFileCommentsRef"
  | "composerTerminalContextsRef"
  | "composerPastedTextsRef"
  | "composerPullRequestContextsRef"
  | "setPrompt"
  | "setComposerCursor"
  | "addComposerImagesToDraft"
  | "addComposerFilesToDraft"
  | "addComposerAssistantSelectionToDraft"
  | "addComposerDraftBrowserAnnotations"
  | "addComposerFileCommentToDraft"
  | "addComposerTerminalContextsToDraft"
  | "addComposerPastedTextsToDraft"
  | "addComposerPullRequestContextsToDraft"
  | "updateSelectedComposerSkills"
  | "updateSelectedComposerMentions"
  | "setComposerTrigger"
  | "setThreadError"
  | "sendInFlightRef"
  | "worktreeSetupResolutionRef"
  | "scheduleFailedWorktreeSetupDispatchReset"
  | "resetLocalDispatch"
>;

export function useChatTurnExecution({
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
}: ChatTurnExecutionInput) {
  return useCallback(
    async (preparedTurn: PreparedChatTurn): Promise<boolean> => {
      let {
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
        dispatchSettingsForSend,
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
      } = preparedTurn;

      let createdServerThreadForLocalDraft = false;
      let createdWorktreeForSendPath: string | null = null;
      let switchedToLocalCheckout = false;
      let turnStartSucceeded = false;
      let settledLocalBranchUpdatedForSend = false;
      await (async () => {
        // "Work locally" from the setup card: drop any prepared worktree and
        // point the send (and the thread's metadata) back at the project
        // checkout. Awaited before the turn dispatch so the session resolves the
        // local cwd instead of the abandoned worktree.
        const applyWorkLocallySwitch = async () => {
          switchedToLocalCheckout = true;
          nextThreadEnvMode = "local";
          nextThreadBranch = null;
          nextThreadWorktreePath = null;
          nextAssociatedWorktreePath = null;
          nextAssociatedWorktreeBranch = null;
          nextAssociatedWorktreeRef = null;
          const worktreePathToRemove = createdWorktreeForSendPath;
          createdWorktreeForSendPath = null;
          if (worktreePathToRemove) {
            // Best-effort: a leftover worktree is inert and reclaimable later.
            void api.git
              .removeWorktree({
                cwd: targetProjectCwdForSend,
                path: worktreePathToRemove,
                force: true,
                reclaimTemporaryBranch: true,
              })
              .catch(() => undefined);
          }
          if (isServerThread || createdServerThreadForLocalDraft) {
            await api.orchestration.dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: threadIdForSend,
              envMode: "local",
              branch: null,
              worktreePath: null,
              associatedWorktreePath: null,
              associatedWorktreeBranch: null,
              associatedWorktreeRef: null,
            });
            setStoreThreadWorkspace(threadIdForSend, {
              envMode: "local",
              branch: null,
              worktreePath: null,
              associatedWorktreePath: null,
              associatedWorktreeBranch: null,
              associatedWorktreeRef: null,
            });
          }
          clearLocalDispatchWorktreeSetup();
        };

        // Honors a Cancel / Work locally choice at a step boundary. Cancel
        // unwinds through the shared send-failure path below; the cancelled
        // sentinel keeps that path from painting error state.
        const consumeWorktreeSetupResolution = async () => {
          const action = worktreeSetupResolution?.action ?? null;
          if (action === null || switchedToLocalCheckout) {
            return;
          }
          if (action === "cancel") {
            throw new WorktreeSetupCancelledError();
          }
          await applyWorkLocallySwitch();
        };

        // On first message: lock in branch + create worktree if needed.
        if (baseBranchForWorktree && worktreeSetupResolution) {
          // The server streams each real setup phase (branch → worktree → copy
          // changes); advance the card's rows from those events instead of
          // letting one row spin through the whole creation.
          const worktreeProgressId = randomUUID();
          const creationFlow = await runWorktreeCreationFlow({
            progressId: worktreeProgressId,
            subscribeToProgress: (listener) => api.git.onWorktreeSetupProgress(listener),
            startCreation: () =>
              createWorktreeMutation.mutateAsync({
                cwd: targetProjectCwdForSend,
                ref: baseBranchForWorktree,
                newBranch: buildTemporaryWorktreeBranchName(),
                progressId: worktreeProgressId,
                ...(worktreeCopiesLocalChanges ? { copyChangesFrom: targetProjectCwdForSend } : {}),
              }),
            resolution: worktreeSetupResolution,
            onCreationStep: (stepId) =>
              beginLocalDispatch({
                worktreeSetupStepId: stepId,
                setupScriptName: worktreeSetupScriptName,
                copyLocalChanges: worktreeCopiesLocalChanges,
              }),
            removeWorktree: (worktreePath) =>
              api.git.removeWorktree({
                cwd: targetProjectCwdForSend,
                path: worktreePath,
                force: true,
                reclaimTemporaryBranch: true,
              }),
          });
          if (creationFlow.outcome === "resolved") {
            await consumeWorktreeSetupResolution();
          } else {
            const result = creationFlow.result;
            beginLocalDispatch({
              worktreeSetupStepId: "prepare-thread",
              setupScriptName: worktreeSetupScriptName,
              copyLocalChanges: worktreeCopiesLocalChanges,
            });
            nextThreadBranch = result.worktree.branch;
            nextThreadWorktreePath = result.worktree.path;
            createdWorktreeForSendPath = result.worktree.path;
            const nextAssociatedWorktree = {
              associatedWorktreePath: result.worktree.path,
              associatedWorktreeBranch: result.worktree.branch,
              associatedWorktreeRef: result.worktree.ref,
            };
            nextAssociatedWorktreePath = nextAssociatedWorktree.associatedWorktreePath;
            nextAssociatedWorktreeBranch = nextAssociatedWorktree.associatedWorktreeBranch;
            nextAssociatedWorktreeRef = nextAssociatedWorktree.associatedWorktreeRef;
            if (isServerThread) {
              await api.orchestration.dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: threadIdForSend,
                envMode: "worktree",
                branch: result.worktree.branch,
                worktreePath: result.worktree.path,
                associatedWorktreePath: nextAssociatedWorktree.associatedWorktreePath,
                associatedWorktreeBranch: nextAssociatedWorktree.associatedWorktreeBranch,
                associatedWorktreeRef: nextAssociatedWorktree.associatedWorktreeRef,
              });
              // Keep local thread state in sync immediately so terminal drawer opens
              // with the worktree cwd/env instead of briefly using the project root.
              setStoreThreadWorkspace(threadIdForSend, {
                branch: result.worktree.branch,
                worktreePath: result.worktree.path,
                ...nextAssociatedWorktree,
              });
            }
          }
        }

        const threadCreateModelSelection: ModelSelection = buildModelSelection(
          selectedModelSelectionForSend.provider,
          selectedModelSelectionForSend.model ||
            selectedModelForSend ||
            targetProjectDefaultModelSelectionForSend?.model ||
            getDefaultModel(selectedModelSelectionForSend.provider) ||
            DEFAULT_MODEL_BY_PROVIDER.codex,
          selectedModelSelectionForSend.options,
          selectedModelSelectionForSend.provider === "claudeAgent"
            ? selectedModelSelectionForSend.supportsAutoMode
            : undefined,
        );

        if (isLocalDraftThread) {
          const inheritedProjectInstructions =
            useProjectInstructionsStore.getState().instructionsByProjectId[
              targetProjectIdForSend
            ] ?? "";
          const inheritedThreadNotes = mergeProjectInstructionsIntoThreadNotes({
            threadNotes,
            projectInstructions: inheritedProjectInstructions,
          });
          await promoteThreadCreate(
            {
              type: "thread.create",
              commandId: newCommandId(),
              threadId: threadIdForSend,
              projectId: targetProjectIdForSend,
              title,
              modelSelection: threadCreateModelSelection,
              runtimeMode: nextRuntimeModeForSend,
              interactionMode: interactionModeForSend,
              envMode: nextThreadEnvMode,
              branch: nextThreadBranch,
              worktreePath: nextThreadWorktreePath,
              workingDirectory: nextThreadWorkingDirectory,
              associatedWorktreePath: nextAssociatedWorktreePath,
              associatedWorktreeBranch: nextAssociatedWorktreeBranch,
              associatedWorktreeRef: nextAssociatedWorktreeRef,
              lastKnownPr: activeThread.lastKnownPr ?? null,
              createdAt: activeThread.createdAt,
            },
            api,
          );
          // `thread.create` does not carry notes, so seed the freshly created
          // server thread's notepad with the inherited project instructions via a
          // dedicated meta update. Best-effort: a failure here must not abort the turn.
          if (inheritedThreadNotes !== threadNotes && inheritedThreadNotes.trim().length > 0) {
            try {
              await dispatchThreadNotes(threadIdForSend, inheritedThreadNotes);
            } catch {
              // Seeding is non-critical; project instructions can still be copied
              // into the notepad manually from the Environment panel.
            }
          }
          // Same for a goal staged on the draft via /goal: persist it now so the
          // decider stamps goalStartedAt when the thread actually starts working.
          const draftGoalForSend = activeThread.goal?.trim() ?? "";
          if (draftGoalForSend.length > 0) {
            try {
              await dispatchThreadGoal(threadIdForSend, draftGoalForSend, {
                startBehavior: "defer",
              });
            } catch {
              // Non-critical: the goal can be set again with /goal on the live thread.
            }
          }
          if (targetProjectKindForSend === "chat") {
            await api.orchestration.dispatchCommand({
              type: "project.meta.update",
              commandId: newCommandId(),
              projectId: targetProjectIdForSend,
              title,
            });
          }
          createdServerThreadForLocalDraft = true;
        }

        const setupScript = switchedToLocalCheckout ? null : setupScriptForWorktree;
        if (setupScript) {
          let shouldRunSetupScript = false;
          if (isServerThread) {
            shouldRunSetupScript = true;
          } else {
            if (createdServerThreadForLocalDraft) {
              shouldRunSetupScript = true;
            }
          }
          if (shouldRunSetupScript) {
            beginLocalDispatch({
              worktreeSetupStepId: "run-setup-action",
              setupScriptName: setupScript.name,
              copyLocalChanges: worktreeCopiesLocalChanges,
            });
            const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
              worktreePath: nextThreadWorktreePath,
              rememberAsLastInvoked: false,
              throwOnError: true,
            };
            if (nextThreadWorktreePath) {
              setupScriptOptions.cwd = nextThreadWorktreePath;
            }
            const setupTerminal = await runProjectScript(setupScript, setupScriptOptions);
            if (setupTerminal) {
              const setupActivityAbortController = new AbortController();
              const setupActivityWait = waitForSetupScriptTerminalActivity({
                threadId: threadIdForSend,
                terminalId: setupTerminal.terminalId,
                signal: setupActivityAbortController.signal,
              });
              // Setup scripts can run for minutes; let Cancel / Work locally win
              // the wait. The script itself keeps running — a cancelled worktree
              // is force-removed, a local switch just stops waiting on it.
              await (
                worktreeSetupResolution
                  ? Promise.race([setupActivityWait, worktreeSetupResolution.promise])
                  : setupActivityWait
              ).finally(() => setupActivityAbortController.abort());
            }
          }
        }
        // Covers a resolution set while the thread was linked or the setup
        // script ran (the creation-step race above only guards the first step).
        await consumeWorktreeSetupResolution();

        if (isServerThread) {
          await persistThreadSettingsForNextTurn({
            threadId: threadIdForSend,
            createdAt: messageCreatedAt,
            ...threadSettingsDispatchFields({
              ...dispatchSettingsForSend,
              runtimeMode: nextRuntimeModeForSend,
              interactionMode: interactionModeForSend,
            }),
          });
        }

        const stagedTurnAttachments = await turnAttachmentsPromise;

        if (
          isServerThread &&
          activeThread.settledAt != null &&
          nextThreadEnvMode === "local" &&
          nextThreadWorktreePath === null &&
          nextThreadBranch !== activeThread.branch
        ) {
          await api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            envMode: "local",
            branch: nextThreadBranch,
            worktreePath: null,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
          });
          settledLocalBranchUpdatedForSend = true;
          setStoreThreadWorkspace(threadIdForSend, {
            envMode: "local",
            branch: nextThreadBranch,
            worktreePath: null,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
          });
        }
        // Keep setup resolvable while attachment uploads are still preparing the
        // turn. Once they settle, consume the last possible choice before the
        // card advances to the non-resolvable "Starting session" step.
        await consumeWorktreeSetupResolution();
        // Carry the expected message id so a snapshot rebuilt after an interim
        // reset (thread switch, ack effect) keeps the message-echo ack signal.
        beginLocalDispatch({
          expectedUserMessageId: messageIdForSend,
          ...(baseBranchForWorktree && !switchedToLocalCheckout
            ? {
                worktreeSetupStepId: "start-session" as const,
                setupScriptName: worktreeSetupScriptName,
                copyLocalChanges: worktreeCopiesLocalChanges,
              }
            : {}),
        });
        rememberCustomBinaryPathForDispatch({
          threadId: threadIdForSend,
          provider: selectedModelSelectionForSend.provider,
          providerOptions: providerOptionsForDispatchForSend,
        });
        await stagedTurnAttachments.runWithDispatch((turnAttachments) =>
          api.orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: threadIdForSend,
            message: {
              messageId: messageIdForSend,
              role: "user",
              text: outgoingMessageText,
              attachments: turnAttachments,
              ...(mentionedSkillsForSend.length > 0 ? { skills: mentionedSkillsForSend } : {}),
              ...(mentionedPluginMentionsForSend.length > 0
                ? { mentions: mentionedPluginMentionsForSend }
                : {}),
            },
            ...turnStartDispatchFields(
              {
                ...dispatchSettingsForSend,
                // Both can be rewritten while the send prepares its workspace.
                runtimeMode: nextRuntimeModeForSend,
                interactionMode: interactionModeForSend,
              },
              dispatchMode,
            ),
            ...(sourceProposedPlanForSend ? { sourceProposedPlan: sourceProposedPlanForSend } : {}),
            createdAt: messageCreatedAt,
          }),
        );
        turnStartSucceeded = true;
        if (
          shouldResumeSettledLocalThread &&
          currentActiveGitBranchForSend !== null &&
          nextThreadBranch === currentActiveGitBranchForSend
        ) {
          setSettledThreadBranchWarningDismissedThreadId(threadIdForSend);
        }
        armLocalDispatchAckFallback(threadIdForSend);
        // Steers on providers without native mid-turn steering interrupt the live
        // turn before re-dispatching; hold queued auto-dispatch through that gap
        // so it can't race the steer. The live session provider decides the
        // interrupt path server-side, so the gate keys off it rather than the
        // requested model selection.
        const liveProviderForSteerGate =
          activeThread?.session?.provider ?? selectedModelSelectionForSend.provider;
        if (
          dispatchMode === "steer" &&
          !providerSupportsNativeTurnSteering(liveProviderForSteerGate)
        ) {
          const nextSteerGate = {
            sawInterruptGap: false,
            gapStartedAt: null,
            armedActiveTurnId: activeThread?.session?.activeTurnId ?? null,
          };
          setQueuedSteerGate(nextSteerGate);
          armQueuedComposerSteerGate(threadId, nextSteerGate);
        }
        if (sourceProposedPlanForSend) {
          planSidebarDismissedForTurnRef.current = null;
          setPlanSidebarOpen(true);
        }
        if (queuedChatTurn === null) {
          setRestoredQueuedSourceProposedPlan(threadIdForSend, null);
        }
      })().catch(async (err: unknown) => {
        // A user-cancelled worktree setup unwinds through this same rollback,
        // but silently: no error styling on the step row, no thread error.
        const setupCancelled = err instanceof WorktreeSetupCancelledError;
        // Uploads start in parallel with workspace/session preparation. If any
        // earlier step fails, settle that promise and release every staged blob.
        await turnAttachmentsPromise.then(
          (staged) => staged.cleanup(),
          () => undefined,
        );
        // Surface the failure on whichever setup step was active (no-op for
        // sends without a worktree setup in flight).
        if (!setupCancelled) {
          failLocalDispatchWorktreeSetup();
        }
        if (!turnStartSucceeded) {
          // The turn RPC never resolved, so no server turn exists for the
          // watchdog to recover — drop the marker armed when the dispatch began.
          clearPendingTurnDispatch(threadIdForSend);
        }
        if (settledLocalBranchUpdatedForSend && !turnStartSucceeded) {
          await api.orchestration
            .dispatchCommand({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: threadIdForSend,
              envMode: "local",
              branch: activeThread.branch,
              worktreePath: null,
              associatedWorktreePath: activeThread.associatedWorktreePath ?? null,
              associatedWorktreeBranch: activeThread.associatedWorktreeBranch ?? null,
              associatedWorktreeRef: activeThread.associatedWorktreeRef ?? null,
            })
            .then(
              () =>
                setStoreThreadWorkspace(threadIdForSend, {
                  envMode: "local",
                  branch: activeThread.branch,
                  worktreePath: null,
                  associatedWorktreePath: activeThread.associatedWorktreePath ?? null,
                  associatedWorktreeBranch: activeThread.associatedWorktreeBranch ?? null,
                  associatedWorktreeRef: activeThread.associatedWorktreeRef ?? null,
                }),
              () => undefined,
            );
        }
        if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
          // This rollback cleans up a retryable draft promotion; do not tombstone the draft id.
          await api.orchestration
            .dispatchCommand({
              type: "thread.delete",
              commandId: newCommandId(),
              threadId: threadIdForSend,
            })
            .catch(() => undefined);
        }
        if (createdWorktreeForSendPath && !turnStartSucceeded) {
          const removed = await api.git
            .removeWorktree({
              cwd: targetProjectCwdForSend,
              path: createdWorktreeForSendPath,
              force: true,
              reclaimTemporaryBranch: true,
            })
            .then(
              () => true,
              () => false,
            );
          if (removed && isServerThread) {
            await api.orchestration
              .dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: threadIdForSend,
                envMode: "local",
                branch: null,
                worktreePath: null,
                associatedWorktreePath: null,
                associatedWorktreeBranch: null,
                associatedWorktreeRef: null,
              })
              .then(
                () =>
                  setStoreThreadWorkspace(threadIdForSend, {
                    branch: null,
                    worktreePath: null,
                    associatedWorktreePath: null,
                    associatedWorktreeBranch: null,
                    associatedWorktreeRef: null,
                  }),
                () => undefined,
              );
          }
        }
        if (queuedChatTurn !== null && !turnStartSucceeded) {
          // The queued snapshot remains available for retry/edit after a rejected
          // dispatch. Drop only this attempt's optimistic transcript row; its
          // attachment preview URLs still belong to the queued snapshot.
          setOptimisticUserMessages((existing) => {
            const next = existing.filter((message) => message.id !== messageIdForSend);
            return next.length === existing.length ? existing : next;
          });
        }
        if (
          queuedChatTurn === null &&
          !turnStartSucceeded &&
          promptRef.current.length === 0 &&
          composerImagesRef.current.length === 0 &&
          composerFilesRef.current.length === 0 &&
          composerAssistantSelectionsRef.current.length === 0 &&
          composerBrowserAnnotationsRef.current.length === 0 &&
          composerFileCommentsRef.current.length === 0 &&
          composerTerminalContextsRef.current.length === 0 &&
          composerPastedTextsRef.current.length === 0 &&
          composerPullRequestContextsRef.current.length === 0
        ) {
          setOptimisticUserMessages((existing) => {
            const removed = existing.filter((message) => message.id === messageIdForSend);
            for (const message of removed) {
              revokeUserMessagePreviewUrls(message);
            }
            const next = existing.filter((message) => message.id !== messageIdForSend);
            return next.length === existing.length ? existing : next;
          });
          promptRef.current = promptForSend;
          setPrompt(promptForSend);
          if (sourceProposedPlanForSend) {
            setRestoredQueuedSourceProposedPlan(threadIdForSend, {
              threadId: threadIdForSend,
              restoredPrompt: promptForSend,
              sourceProposedPlan: sourceProposedPlanForSend,
            });
          }
          setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
          addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageAttachment));
          addComposerFilesToDraft(composerFilesSnapshot);
          for (const selection of composerAssistantSelectionsSnapshot) {
            addComposerAssistantSelectionToDraft(selection);
          }
          addComposerDraftBrowserAnnotations(threadIdForSend, composerBrowserAnnotationsSnapshot);
          for (const comment of composerFileCommentsSnapshot) {
            addComposerFileCommentToDraft(comment);
          }
          addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
          addComposerPastedTextsToDraft(composerPastedTextsSnapshot);
          addComposerPullRequestContextsToDraft(composerPullRequestContextsSnapshot);
          updateSelectedComposerSkills(composerSkillsSnapshot);
          updateSelectedComposerMentions(composerMentionsSnapshot);
          setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
        }
        if (!setupCancelled) {
          setThreadError(
            threadIdForSend,
            err instanceof Error ? err.message : "Failed to send message.",
          );
        }
      });
      sendInFlightRef.current = false;
      worktreeSetupResolutionRef.current = null;
      if (!turnStartSucceeded) {
        if (baseBranchForWorktree && (worktreeSetupResolution?.action ?? null) === null) {
          scheduleFailedWorktreeSetupDispatchReset();
        } else {
          // A resolved setup (cancelled, or switched to local and then failed)
          // has no error step to hold on screen — release the marker directly.
          resetLocalDispatch();
        }
      }
      return turnStartSucceeded;
    },
    [
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
    ],
  );
}
