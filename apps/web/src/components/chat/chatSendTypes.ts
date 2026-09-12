import type {
  MessageId,
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import type { QueryClient, UseMutationResult } from "@tanstack/react-query";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import type { gitCreateDetachedWorktreeMutationOptions } from "~/lib/gitReactQuery";
import type { AppSettings } from "../../appSettings";
import type {
  DraftThreadEnvMode,
  QueuedComposerChatTurn,
  QueuedComposerPlanFollowUp,
} from "../../composerDraftStore";
import type { useComposerImageIntake } from "../../hooks/useComposerImageIntake";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { LatestProposedPlanState } from "../../session-logic";
import type { useStore } from "../../store";
import type { Project, Thread } from "../../types";
import type { QueuedSteerGate } from "../ChatView.logic";
import type { useChatAutomationCreation } from "./useChatAutomationCreation";
import type { useChatAutomationSetup } from "./useChatAutomationSetup";
import type { useChatComposerDraft } from "./useChatComposerDraft";
import type { useChatLocalDispatch } from "./useChatLocalDispatch";
import type { useChatPendingInteractions } from "./useChatPendingInteractions";
import type { useChatProjectScripts } from "./useChatProjectScripts";
import type { useChatProviderModels } from "./useChatProviderModels";
import type { useChatProviderStatus } from "./useChatProviderStatus";
import type { useChatRuntimeModes } from "./useChatRuntimeModes";
import type { useChatTimelineMessages } from "./useChatTimelineMessages";
import type { useChatTranscriptScroll } from "./useChatTranscriptScroll";
import type { useComposerReferences } from "./useComposerReferences";
import type { useComposerVoiceController } from "./useComposerVoiceController";

export interface PlanFollowUpSubmission {
  text: string;
  interactionMode: "default" | "plan";
  dispatchMode: "queue" | "steer";
  queuedTurn?: QueuedComposerPlanFollowUp;
}

/**
 * Send-path handlers that are declared *after* `onSend` in the component body (they depend on
 * state and callbacks that are set up later) yet have to be reachable from it — and, for
 * `send` itself, from the queued-turn dispatcher that is declared before it.
 *
 * Reading a later-declared binding from an earlier one makes React Compiler bail out on the
 * whole component ("Cannot access variable before it is declared") — silently, since
 * `panicThreshold` is unset — which would drop memoization for the single hottest component in
 * the app. Routing those calls through one latest-value ref keeps every reference well-ordered.
 * The ref is only ever read from user-driven send flows, never during render, and it is
 * refreshed in a layout effect so no passive-effect window can serve a stale handler.
 */

export interface LateComposerSendHandlers {
  readonly send: (
    event?: { preventDefault: () => void },
    dispatchMode?: "queue" | "steer",
    queuedTurn?: QueuedComposerChatTurn,
  ) => Promise<boolean>;
  readonly submitPlanFollowUp: (submission: PlanFollowUpSubmission) => Promise<boolean>;
  readonly advanceActivePendingUserInput: (
    answerOverrides?: Record<string, PendingUserInputDraftAnswer>,
  ) => boolean;
  readonly handleStandaloneSlashCommand: (trimmedPrompt: string) => Promise<boolean>;
}

export interface ChatTurnSubmissionInput {
  threadId: ThreadId;
  hasLiveTurn: boolean;
  lateComposerSendHandlersRef: RefObject<LateComposerSendHandlers | null>;
  activeThread: Thread | undefined;
  isConnecting: boolean;
  sendPreflightInFlightRef: RefObject<boolean>;
  sendInFlightRef: RefObject<boolean>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: LatestProposedPlanState | null;
  hasQueueableLiveTurn: boolean;
  clearComposerInput: (threadId: ThreadId) => void;
  scheduleComposerFocus: () => void;
  activeProject: Project | undefined;
  threadWorkspaceCwd: string | null;
  refreshProviderStatuses: ReturnType<typeof useRefreshProviderStatusesNow>;
  isServerThread: boolean;
  hasNativeUserMessages: boolean;
  chatWorkspaceRoot: string | null;
  isHomeChatContainer: boolean;
  isStudioContainer: boolean;
  resolvedThreadWorktreePath: string | null;
  resolvedThreadWorkingDirectory: string | null;
  currentActiveGitBranch: string | null;
  isContainerLandingProject: boolean;
  syncServerShellSnapshot: ReturnType<typeof useStore.getState>["syncServerShellSnapshot"];
  activeRootBranch: string | null;
  gitBranchSourceCwd: string | null;
  setStoreThreadError: (threadId: ThreadId, error: string | null) => void;
  queryClient: QueryClient;
  isCenteredEmptyLanding: boolean;
  setEnvironmentPanelPreferenceOpen: Dispatch<SetStateAction<boolean | null>>;
  environmentPanelPreferenceOpen: boolean | null;
  setTailAnchor: Dispatch<SetStateAction<{ threadId: ThreadId; messageId: MessageId } | null>>;
  setThreadError: (targetThreadId: ThreadId | null, error: string | null) => void;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
  setStoreThreadWorkspace: ReturnType<typeof useStore.getState>["setThreadWorkspace"];
  createWorktreeMutation: UseMutationResult<
    Awaited<
      ReturnType<
        NonNullable<ReturnType<typeof gitCreateDetachedWorktreeMutationOptions>["mutationFn"]>
      >
    >,
    Error,
    Parameters<
      NonNullable<ReturnType<typeof gitCreateDetachedWorktreeMutationOptions>["mutationFn"]>
    >[0]
  >;
  isLocalDraftThread: boolean;
  threadNotes: string;
  assistantDeliveryMode: "streaming" | "buffered";
  setSettledThreadBranchWarningDismissedThreadId: Dispatch<SetStateAction<ThreadId | null>>;
  setQueuedSteerGate: Dispatch<SetStateAction<QueuedSteerGate | null>>;
  planSidebarDismissedForTurnRef: RefObject<string | null>;
  setPlanSidebarOpen: Dispatch<SetStateAction<boolean>>;
  settings: AppSettings;
  isSendBusy: ReturnType<typeof useChatLocalDispatch>["isSendBusy"];
  worktreeSetupResolutionRef: ReturnType<typeof useChatLocalDispatch>["worktreeSetupResolutionRef"];
  setWorktreeSetupPendingAction: ReturnType<
    typeof useChatLocalDispatch
  >["setWorktreeSetupPendingAction"];
  beginLocalDispatch: ReturnType<typeof useChatLocalDispatch>["beginLocalDispatch"];
  clearLocalDispatchWorktreeSetup: ReturnType<
    typeof useChatLocalDispatch
  >["clearLocalDispatchWorktreeSetup"];
  armLocalDispatchAckFallback: ReturnType<
    typeof useChatLocalDispatch
  >["armLocalDispatchAckFallback"];
  failLocalDispatchWorktreeSetup: ReturnType<
    typeof useChatLocalDispatch
  >["failLocalDispatchWorktreeSetup"];
  scheduleFailedWorktreeSetupDispatchReset: ReturnType<
    typeof useChatLocalDispatch
  >["scheduleFailedWorktreeSetupDispatchReset"];
  resetLocalDispatch: ReturnType<typeof useChatLocalDispatch>["resetLocalDispatch"];
  isVoiceTranscribing: ReturnType<typeof useComposerVoiceController>["isVoiceTranscribing"];
  waitForPendingComposerImages: ReturnType<typeof useComposerImageIntake>["waitForPending"];
  activePendingProgress: ReturnType<typeof useChatPendingInteractions>["activePendingProgress"];
  activePendingUserInputKey: ReturnType<
    typeof useChatPendingInteractions
  >["activePendingUserInputKey"];
  pendingUserInputAnswersByRequestIdRef: ReturnType<
    typeof useChatPendingInteractions
  >["pendingUserInputAnswersByRequestIdRef"];
  setPendingUserInputAnswersByRequestId: ReturnType<
    typeof useChatPendingInteractions
  >["setPendingUserInputAnswersByRequestId"];
  composerEditorRef: ReturnType<typeof useChatComposerDraft>["composerEditorRef"];
  promptRef: ReturnType<typeof useChatComposerDraft>["promptRef"];
  composerImages: ReturnType<typeof useChatComposerDraft>["composerImages"];
  composerFiles: ReturnType<typeof useChatComposerDraft>["composerFiles"];
  composerAssistantSelections: ReturnType<
    typeof useChatComposerDraft
  >["composerAssistantSelections"];
  composerBrowserAnnotations: ReturnType<typeof useChatComposerDraft>["composerBrowserAnnotations"];
  composerFileComments: ReturnType<typeof useChatComposerDraft>["composerFileComments"];
  composerTerminalContexts: ReturnType<typeof useChatComposerDraft>["composerTerminalContexts"];
  composerPastedTexts: ReturnType<typeof useChatComposerDraft>["composerPastedTexts"];
  composerPullRequestContexts: ReturnType<
    typeof useChatComposerDraft
  >["composerPullRequestContexts"];
  restoredQueuedSourceProposedPlanRef: ReturnType<
    typeof useChatComposerDraft
  >["restoredQueuedSourceProposedPlanRef"];
  enqueueQueuedComposerTurn: ReturnType<typeof useChatComposerDraft>["enqueueQueuedComposerTurn"];
  setComposerDraftPrompt: ReturnType<typeof useChatComposerDraft>["setComposerDraftPrompt"];
  setComposerTrigger: ReturnType<typeof useChatComposerDraft>["setComposerTrigger"];
  clearProjectDraftThreadId: ReturnType<typeof useChatComposerDraft>["clearProjectDraftThreadId"];
  setDraftThreadContext: ReturnType<typeof useChatComposerDraft>["setDraftThreadContext"];
  promptHistoryNavigationRef: ReturnType<typeof useChatComposerDraft>["promptHistoryNavigationRef"];
  applyingPromptHistoryNavigationRef: ReturnType<
    typeof useChatComposerDraft
  >["applyingPromptHistoryNavigationRef"];
  expectedPromptHistoryPromptRef: ReturnType<
    typeof useChatComposerDraft
  >["expectedPromptHistoryPromptRef"];
  clearComposerDraftContent: ReturnType<typeof useChatComposerDraft>["clearComposerDraftContent"];
  setComposerDraftInteractionMode: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftInteractionMode"];
  setComposerCursor: ReturnType<typeof useChatComposerDraft>["setComposerCursor"];
  setRestoredQueuedSourceProposedPlan: ReturnType<
    typeof useChatComposerDraft
  >["setRestoredQueuedSourceProposedPlan"];
  composerImagesRef: ReturnType<typeof useChatComposerDraft>["composerImagesRef"];
  composerFilesRef: ReturnType<typeof useChatComposerDraft>["composerFilesRef"];
  composerAssistantSelectionsRef: ReturnType<
    typeof useChatComposerDraft
  >["composerAssistantSelectionsRef"];
  composerBrowserAnnotationsRef: ReturnType<
    typeof useChatComposerDraft
  >["composerBrowserAnnotationsRef"];
  composerFileCommentsRef: ReturnType<typeof useChatComposerDraft>["composerFileCommentsRef"];
  composerTerminalContextsRef: ReturnType<
    typeof useChatComposerDraft
  >["composerTerminalContextsRef"];
  composerPastedTextsRef: ReturnType<typeof useChatComposerDraft>["composerPastedTextsRef"];
  composerPullRequestContextsRef: ReturnType<
    typeof useChatComposerDraft
  >["composerPullRequestContextsRef"];
  setPrompt: ReturnType<typeof useChatComposerDraft>["setPrompt"];
  addComposerImagesToDraft: ReturnType<typeof useChatComposerDraft>["addComposerImagesToDraft"];
  addComposerFilesToDraft: ReturnType<typeof useChatComposerDraft>["addComposerFilesToDraft"];
  addComposerAssistantSelectionToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerAssistantSelectionToDraft"];
  addComposerDraftBrowserAnnotations: ReturnType<
    typeof useChatComposerDraft
  >["addComposerDraftBrowserAnnotations"];
  addComposerFileCommentToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerFileCommentToDraft"];
  addComposerTerminalContextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerTerminalContextsToDraft"];
  addComposerPastedTextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerPastedTextsToDraft"];
  addComposerPullRequestContextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerPullRequestContextsToDraft"];
  selectedComposerSkillsRef: ReturnType<typeof useComposerReferences>["selectedComposerSkillsRef"];
  selectedComposerMentionsRef: ReturnType<
    typeof useComposerReferences
  >["selectedComposerMentionsRef"];
  updateSelectedComposerSkills: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerSkills"];
  updateSelectedComposerMentions: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerMentions"];
  selectedProvider: ProviderKind;
  selectedModel: string;
  selectedPromptEffort: ReturnType<typeof useChatProviderModels>["selectedPromptEffort"];
  selectedModelSelection: ModelSelection;
  providerOptionsForDispatch: ProviderStartOptions | undefined;
  pendingAutomationConversationRef: ReturnType<
    typeof useChatAutomationSetup
  >["pendingAutomationConversationRef"];
  setPendingAutomationConversation: ReturnType<
    typeof useChatAutomationSetup
  >["setPendingAutomationConversation"];
  pendingAutomationConversation: ReturnType<
    typeof useChatAutomationSetup
  >["pendingAutomationConversation"];
  activeThreadIdRef: ReturnType<typeof useChatAutomationSetup>["activeThreadIdRef"];
  hasLiveTurnRef: ReturnType<typeof useChatAutomationSetup>["hasLiveTurnRef"];
  automationProjects: ReturnType<typeof useChatAutomationSetup>["automationProjects"];
  setAutomationDraftWarningContext: ReturnType<
    typeof useChatAutomationSetup
  >["setAutomationDraftWarningContext"];
  setAutomationDraftForm: ReturnType<typeof useChatAutomationSetup>["setAutomationDraftForm"];
  setAutomationDraftWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["setAutomationDraftWarnings"];
  setAcknowledgedAutomationWarnings: ReturnType<
    typeof useChatAutomationSetup
  >["setAcknowledgedAutomationWarnings"];
  setAutomationDraftOpen: ReturnType<typeof useChatAutomationSetup>["setAutomationDraftOpen"];
  armTranscriptAutoFollow: ReturnType<typeof useChatTranscriptScroll>["armTranscriptAutoFollow"];
  tailAnchorScrollInFlightRef: ReturnType<
    typeof useChatTranscriptScroll
  >["tailAnchorScrollInFlightRef"];
  prepareAutomationFormForCreate: ReturnType<
    typeof useChatAutomationCreation
  >["prepareAutomationFormForCreate"];
  createAutomationFromForm: ReturnType<
    typeof useChatAutomationCreation
  >["createAutomationFromForm"];
  providerStatuses: ReturnType<typeof useChatProviderStatus>["providerStatuses"];
  rememberCustomBinaryPathForDispatch: ReturnType<
    typeof useChatProviderStatus
  >["rememberCustomBinaryPathForDispatch"];
  setOptimisticUserMessages: ReturnType<
    typeof useChatTimelineMessages
  >["setOptimisticUserMessages"];
  runProjectScript: ReturnType<typeof useChatProjectScripts>["runProjectScript"];
  persistThreadSettingsForNextTurn: ReturnType<
    typeof useChatRuntimeModes
  >["persistThreadSettingsForNextTurn"];
}
