import type {
  ProjectId,
  ProjectKind,
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
import { waitForDraftThreadDispatchToSettle } from "~/lib/draftThreadDispatch";
import { runComposerSendOnce } from "~/lib/composerSendOwnership";
import { newCommandId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import { dispatchThreadGoal } from "~/threadGoal";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import {
  useComposerDraftStore,
  type DraftThreadEnvMode,
  type QueuedComposerChatTurn,
} from "../../composerDraftStore";
import {
  cloneComposerImageAttachment,
  stageUploadComposerAttachments,
} from "../../lib/composerSend";
import { armQueuedComposerSteerGate } from "../../lib/queuedComposerDrain";
import { clearPendingTurnDispatch } from "../../pendingTurnDispatch";
import { useStore } from "../../store";
import { getThreadFromState } from "../../threadDerivation";
import { buildModelSelection } from "../../providerModelOptions";
import { type Thread } from "../../types";
import {
  WorktreeSetupCancelledError,
  createWorktreeSetupResolution,
  resolveQueuedTurnDispatchSettings,
  revokeUserMessagePreviewUrls,
  runWorktreeCreationFlow,
  threadSettingsDispatchFields,
  threadHasProviderLockingActivity,
  turnStartDispatchFields,
  type TurnDispatchSettings,
} from "../ChatView.logic";
import type { ChatTurnSubmissionInput } from "./chatSendTypes";
import { waitForSetupScriptTerminalActivity } from "./projectScriptRuntime";
interface PreparedChatTurn {
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
  targetProjectKindForSend: ProjectKind;
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
  turnDispatchSettings: TurnDispatchSettings;
  computerControlSequenceForSend: number;
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
  | "prepareProviderHandoffForSend"
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
  | "computerControlChangeSequence"
  | "setComposerDraftComputerControlMode"
  | "setSettledThreadBranchWarningDismissedThreadId"
  | "armLocalDispatchAckFallback"
  | "setQueuedSteerGate"
  | "threadId"
  | "planSidebarDismissedForTurnRef"
  | "setPlanSidebarOpen"
  | "setRestoredQueuedSourceProposedPlan"
  | "failLocalDispatchWorktreeSetup"
  | "setOptimisticUserMessages"
  | "activeThreadIdRef"
  | "promptRef"
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
  prepareProviderHandoffForSend,
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
  computerControlChangeSequence,
  setComposerDraftComputerControlMode,
  setSettledThreadBranchWarningDismissedThreadId,
  armLocalDispatchAckFallback,
  setQueuedSteerGate,
  threadId,
  planSidebarDismissedForTurnRef,
  setPlanSidebarOpen,
  setRestoredQueuedSourceProposedPlan,
  failLocalDispatchWorktreeSetup,
  setOptimisticUserMessages,
  activeThreadIdRef,
  promptRef,
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
  const execute = useCallback(
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
        turnDispatchSettings: preparedTurnDispatchSettings,
        computerControlSequenceForSend,
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

      const dispatchSettings = resolveQueuedTurnDispatchSettings(
        preparedTurnDispatchSettings,
        queuedChatTurn,
      );
      const settledDraftDispatch = await waitForDraftThreadDispatchToSettle(threadIdForSend);
      if (
        (settledDraftDispatch?.kind === "error" && settledDraftDispatch.outcomeUnknown) ||
        (!queuedChatTurn &&
          settledDraftDispatch?.kind === "dispatched" &&
          !settledDraftDispatch.deferred)
      ) {
        await turnAttachmentsPromise.then(
          (staged) => staged.cleanup(),
          () => undefined,
        );
        // Submission already armed local UI state and added an optimistic row.
        // The shared draft dispatch owns the real message; release this attempt.
        sendInFlightRef.current = false;
        worktreeSetupResolutionRef.current = null;
        resetLocalDispatch();
        if (activeThreadIdRef.current === threadIdForSend) {
          setOptimisticUserMessages((messages) =>
            messages.filter((message) => message.id !== messageIdForSend),
          );
        }
        return false;
      }
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

        // Register the task before slow git work so the sidebar can show it
        // and navigation can leave preparation running on its original thread.
        const threadCreateModelSelection: ModelSelection =
          selectedModelSelectionForSend.provider === "external"
            ? selectedModelSelectionForSend
            : buildModelSelection(
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
                { instanceId: selectedModelSelectionForSend.instanceId },
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
              // The draft timestamp records when the composer opened. The durable
              // thread is created by this first send, so order it at the message's
              // send time just like the turn itself.
              createdAt: messageCreatedAt,
            },
            api,
          );
          createdServerThreadForLocalDraft = true;
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
        }

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
            if (isServerThread || createdServerThreadForLocalDraft) {
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
                threadId: setupTerminal.threadId,
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

        const needsProviderHandoff =
          isServerThread &&
          queuedChatTurn === null &&
          threadHasProviderLockingActivity(activeThread) &&
          dispatchSettings.modelSelection.provider !== activeThread.modelSelection.provider;
        if (isServerThread) {
          await persistThreadSettingsForNextTurn({
            // The explicit handoff owns a provider switch. An ordinary metadata
            // update first would erase its source and make the server reject it.
            ...(needsProviderHandoff
              ? {
                  runtimeMode: dispatchSettings.runtimeMode,
                  interactionMode: dispatchSettings.interactionMode,
                }
              : threadSettingsDispatchFields(dispatchSettings)),
            threadId: threadIdForSend,
            createdAt: messageCreatedAt,
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
        // A provider picked over the thread's own one: hand off in place while
        // the message already shows. A failure throws into the rollback below,
        // which returns the message to the composer.
        if (needsProviderHandoff && prepareProviderHandoffForSend) {
          await prepareProviderHandoffForSend(activeThread, dispatchSettings.modelSelection);
          // The optimistic row predates provider startup. Position this send
          // after its completed handoff, including when the server clock is ahead.
          const handoffCreatedAt = getThreadFromState(
            useStore.getState(),
            threadIdForSend,
          )?.activities.findLast((activity) => activity.kind === "provider.handoff")?.createdAt;
          messageCreatedAt = new Date(
            Math.max(Date.now(), Date.parse(handoffCreatedAt ?? messageCreatedAt) + 1),
          ).toISOString();
          if (activeThreadIdRef.current === threadIdForSend) {
            setOptimisticUserMessages((messages) =>
              messages.map((message) =>
                message.id === messageIdForSend
                  ? { ...message, createdAt: messageCreatedAt }
                  : message,
              ),
            );
          }
        }
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
          provider: dispatchSettings.modelSelection.provider,
          providerInstanceId:
            dispatchSettings.modelSelection.instanceId ?? dispatchSettings.modelSelection.provider,
          providerOptions: dispatchSettings.providerOptions,
        });
        await stagedTurnAttachments.runWithDispatch(async (turnAttachments) => {
          if (getThreadFromState(useStore.getState(), threadIdForSend)?.claudeCacheReview != null) {
            throw new Error(
              "Choose how to resume the held message before sending another message.",
            );
          }
          await api.orchestration
            .dispatchCommand({
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
              ...turnStartDispatchFields(dispatchSettings, dispatchMode),
              ...(sourceProposedPlanForSend
                ? { sourceProposedPlan: sourceProposedPlanForSend }
                : {}),
              createdAt: messageCreatedAt,
            })
            .catch((error: unknown) => {
              if (
                getThreadFromState(useStore.getState(), threadIdForSend)?.claudeCacheReview
                  ?.messageId !== messageIdForSend
              ) {
                throw error;
              }
            });
        });
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
          (activeThreadIdRef.current === threadIdForSend
            ? setRestoredQueuedSourceProposedPlan
            : useComposerDraftStore.getState().setRestoredSourceProposedPlan)(
            threadIdForSend,
            null,
          );
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
        if (createdServerThreadForLocalDraft && !turnStartSucceeded && !baseBranchForWorktree) {
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
          if (removed && (isServerThread || createdServerThreadForLocalDraft)) {
            await api.orchestration
              .dispatchCommand({
                type: "thread.meta.update",
                commandId: newCommandId(),
                threadId: threadIdForSend,
                envMode: switchedToLocalCheckout ? "local" : "worktree",
                branch: switchedToLocalCheckout ? null : baseBranchForWorktree,
                worktreePath: null,
                associatedWorktreePath: null,
                associatedWorktreeBranch: null,
                associatedWorktreeRef: null,
              })
              .then(
                () =>
                  setStoreThreadWorkspace(threadIdForSend, {
                    envMode: switchedToLocalCheckout ? "local" : "worktree",
                    branch: switchedToLocalCheckout ? null : baseBranchForWorktree,
                    worktreePath: null,
                    associatedWorktreePath: null,
                    associatedWorktreeBranch: null,
                    associatedWorktreeRef: null,
                  }),
                () => undefined,
              );
          }
        }
        const isFocusedSend = activeThreadIdRef.current === threadIdForSend;
        if (
          queuedChatTurn !== null &&
          !turnStartSucceeded &&
          activeThreadIdRef.current === threadIdForSend
        ) {
          // The queued snapshot remains available for retry/edit after a rejected
          // dispatch. Drop only this attempt's optimistic transcript row; its
          // attachment preview URLs still belong to the queued snapshot.
          if (isFocusedSend)
            setOptimisticUserMessages((existing) => {
              const next = existing.filter((message) => message.id !== messageIdForSend);
              return next.length === existing.length ? existing : next;
            });
        }
        const retryDraft = useComposerDraftStore.getState().draftsByThreadId[threadIdForSend];
        if (
          queuedChatTurn === null &&
          !turnStartSucceeded &&
          (!retryDraft ||
            (retryDraft.prompt.length === 0 &&
              retryDraft.images.length === 0 &&
              retryDraft.files.length === 0 &&
              retryDraft.assistantSelections.length === 0 &&
              retryDraft.browserAnnotations.length === 0 &&
              retryDraft.fileComments.length === 0 &&
              retryDraft.terminalContexts.length === 0 &&
              retryDraft.pastedTexts.length === 0 &&
              retryDraft.pullRequestContexts.length === 0))
        ) {
          if (isFocusedSend)
            setOptimisticUserMessages((existing) => {
              const removed = existing.filter((message) => message.id === messageIdForSend);
              for (const message of removed) {
                revokeUserMessagePreviewUrls(message);
              }
              const next = existing.filter((message) => message.id !== messageIdForSend);
              return next.length === existing.length ? existing : next;
            });
          if (isFocusedSend) promptRef.current = promptForSend;
          setPrompt(promptForSend);
          if (sourceProposedPlanForSend) {
            (isFocusedSend
              ? setRestoredQueuedSourceProposedPlan
              : useComposerDraftStore.getState().setRestoredSourceProposedPlan)(threadIdForSend, {
              threadId: threadIdForSend,
              restoredPrompt: promptForSend,
              sourceProposedPlan: sourceProposedPlanForSend,
            });
          }
          if (isFocusedSend)
            setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
          (isFocusedSend
            ? addComposerImagesToDraft
            : (value: Parameters<typeof addComposerImagesToDraft>[0]) =>
                useComposerDraftStore.getState().addImages(threadIdForSend, value))(
            composerImagesSnapshot.map(cloneComposerImageAttachment),
          );
          (isFocusedSend
            ? addComposerFilesToDraft
            : (value: Parameters<typeof addComposerFilesToDraft>[0]) =>
                useComposerDraftStore.getState().addFiles(threadIdForSend, value))(
            composerFilesSnapshot,
          );
          for (const selection of composerAssistantSelectionsSnapshot) {
            (isFocusedSend
              ? addComposerAssistantSelectionToDraft
              : (value: Parameters<typeof addComposerAssistantSelectionToDraft>[0]) =>
                  useComposerDraftStore.getState().addAssistantSelection(threadIdForSend, value))(
              selection,
            );
          }
          addComposerDraftBrowserAnnotations(threadIdForSend, composerBrowserAnnotationsSnapshot);
          for (const comment of composerFileCommentsSnapshot) {
            (isFocusedSend
              ? addComposerFileCommentToDraft
              : (value: Parameters<typeof addComposerFileCommentToDraft>[0]) =>
                  useComposerDraftStore.getState().addFileComment(threadIdForSend, value))(comment);
          }
          (isFocusedSend
            ? addComposerTerminalContextsToDraft
            : (value: Parameters<typeof addComposerTerminalContextsToDraft>[0]) =>
                useComposerDraftStore.getState().addTerminalContexts(threadIdForSend, value))(
            composerTerminalContextsSnapshot,
          );
          (isFocusedSend
            ? addComposerPastedTextsToDraft
            : (value: Parameters<typeof addComposerPastedTextsToDraft>[0]) =>
                useComposerDraftStore.getState().addPastedTexts(threadIdForSend, value))(
            composerPastedTextsSnapshot,
          );
          (isFocusedSend
            ? addComposerPullRequestContextsToDraft
            : (value: Parameters<typeof addComposerPullRequestContextsToDraft>[0]) =>
                value.forEach((context) =>
                  useComposerDraftStore.getState().addPullRequestContext(threadIdForSend, context),
                ))(composerPullRequestContextsSnapshot);
          if (isFocusedSend) {
            updateSelectedComposerSkills(composerSkillsSnapshot);
            updateSelectedComposerMentions(composerMentionsSnapshot);
          } else {
            useComposerDraftStore.getState().setSkills(threadIdForSend, composerSkillsSnapshot);
            useComposerDraftStore.getState().setMentions(threadIdForSend, composerMentionsSnapshot);
          }
          if (isFocusedSend)
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
      activeThreadIdRef,
      promptRef,
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
      prepareProviderHandoffForSend,
    ],
  );
  return useCallback(
    (preparedTurn: PreparedChatTurn) =>
      runComposerSendOnce(preparedTurn.threadIdForSend, () => execute(preparedTurn)),
    [execute],
  );
}
