import { type LegendListRef } from "@legendapp/list/react";
import {
  MessageId,
  OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ThreadId,
  type AutomationDefinition,
  type EditorId,
  type ModelSelection,
  type ModelSlug,
  type PinnedMessage,
  type ProjectScript,
  type ProviderKind,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  type ThreadGoalAchievement,
  type TurnId,
} from "@synara/contracts";
import { resolveLatestTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import { getModelCapabilities } from "@synara/shared/model";
import {
  resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceState,
} from "@synara/shared/threadEnvironment";
import { threadExportBlockedReason } from "@synara/shared/threadExport";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { deriveAssociatedWorktreeMetadata } from "@synara/shared/threadWorkspace";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useCopyThreadIdToClipboard } from "~/hooks/useCopyToClipboard";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useRepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { useThreadRecap } from "~/hooks/useThreadRecap";
import { SINGLE_CHAT_PANE_SCOPE_ID } from "~/lib/chatPaneScope";
import { formatComposerMentionToken } from "~/lib/composerMentions";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitBranchesQueryOptions,
  gitCreateDetachedWorktreeMutationOptions,
  gitGithubRepositoryQueryOptions,
  gitStatusQueryOptions,
} from "~/lib/gitReactQuery";
import { LoaderCircleIcon, RefreshCwIcon, TemporaryThreadIcon } from "~/lib/icons";
import { getLocalFolderBrowseRootPath } from "~/lib/localFolderMentions";
import { findProviderStatus } from "~/lib/providerAvailability";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { cn, isMacNavigatorPlatform, newCommandId, newThreadId, randomUUID } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import { projectScriptRuntimeEnv } from "~/projectScripts";
import {
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "../appSettings";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  stripComposerTriggerText,
} from "../composer-logic";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
} from "../composerDraftStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import {
  canExecuteSideSlashCommand,
  canOfferForkSlashCommand,
  canOfferReviewSlashCommand,
  canOfferSideSlashCommand,
  resolveComposerSlashRootBranch,
} from "../composerSlashCommands";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { isElectron } from "../env";
import { useFeatureFlags } from "../featureFlags";
import { useComposerCommandMenuItems } from "../hooks/useComposerCommandMenuItems";
import { splitComposerDropzoneFiles, useComposerDropzone } from "../hooks/useComposerDropzone";
import { useComposerImageIntake } from "../hooks/useComposerImageIntake";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useTheme } from "../hooks/useTheme";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useThreadUnblock } from "../hooks/useThreadUnblock";
import { useThreadWorkspaceHandoff } from "../hooks/useThreadWorkspaceHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { formatShortcutLabel, shortcutLabelForCommand } from "../keybindings";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { appendComposerPromptText } from "../lib/chatReferences";
import { createPastedTextDraft } from "../lib/composerPastedText";
import {
  buildComposerFileAttachmentsFromFiles,
  effectiveComposerAttachmentCount,
} from "../lib/composerSend";
import {
  deriveContextWindowSelectionStatus,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowState,
  deriveSelectedContextWindowSnapshot,
} from "../lib/contextWindow";
import { reconcileDeletedThreadFromClient } from "../lib/deletedThreadClientReconciliation";
import {
  normalizeRuntimeModeForProvider,
  providerModelSupportsAutoRuntimeMode,
} from "../lib/runtimeMode";
import { addSelectionToSide, startSelectionChat } from "../lib/selectionChat";
import { waitForSidechatCreator } from "../lib/sidechatCreatorRegistry";
import { isStudioContainerProject } from "../lib/studioProjects";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import {
  insertInlineTerminalContextPlaceholder,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import { registerTerminalContextComposerTarget } from "../lib/terminalContextComposerRegistry";
import {
  resolveDiffEnvironmentState,
  resolveThreadEnvironmentMode,
} from "../lib/threadEnvironment";
import {
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import { buildDraftThreadRenameCreateInput, dispatchThreadRename } from "../lib/threadRename";
import { useProjectEnvironmentStore } from "../projectEnvironmentStore";
import { proposedPlanTitle } from "../proposedPlan";
import { buildModelSelection, buildNextProviderOptions } from "../providerModelOptions";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { AutomationDialog, automationsForThread } from "../routes/-automations.shared";
import {
  deriveActiveBackgroundTasksState,
  deriveActiveTaskListState,
  deriveActiveWorkStartedAt,
  derivePhase,
  deriveTimelineEntries,
  findLatestProposedPlan,
  findSidebarProposedPlan,
  hasActionableProposedPlan,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  type ActiveTaskListState,
} from "../session-logic";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  useSplitViewStore,
  type SplitViewPanePanelState,
} from "../splitViewStore";
import { useStore } from "../store";
import {
  createComposerThreadMentionSourcesSelector,
  createProjectSelector,
  createSidechatSummariesForSourceSelector,
  createThreadSelector,
} from "../storeSelectors";
import { useTemporaryThreadStore } from "../temporaryThreadStore";
import { useTerminalStateStore } from "../terminalStateStore";
import { getThreadFromState } from "../threadDerivation";
import { buildThreadSubscribeInput } from "../threadDetailResumeCursors";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Thread,
} from "../types";
import { useWorkflowRunUiStore } from "../workflowRunUiStore";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import BranchToolbar, { RuntimeUsageControls } from "./BranchToolbar";
import {
  ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  PullRequestDialogState,
  appendVoiceTranscriptToPrompt,
  buildLocalDraftThread,
  buildThreadBreadcrumbs,
  commitAfterRuntimeModePersistence,
  derivePromptHistoryFromMessages,
  hasFileUndoSettled,
  resolveActiveThreadTitle,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveDefaultEnvironmentPanelOpen,
  resolveDraftFallbackModelSelection,
  resolveEnvironmentPanelOpen,
  resolveEnvironmentPanelPreferenceUpdate,
  resolveEnvironmentPanelVisible,
  resolveGitRepoUiState,
  resolveSettledThreadBranchMismatch,
  resolveThreadArtifactWorkspaceRoot,
  resolveThreadDetailHydration,
  resolveWorkingLabel,
  shouldEnableComposerPastedTextCollapse,
  shouldRenderProviderHealthBanner,
  shouldStartActiveTurnLayoutGrace,
  type PendingFileUndo,
} from "./ChatView.logic";
import { createThreadLineageSelector, localSubagentThreadId } from "./ChatView.selectors";
import { ComposerPromptEditor } from "./ComposerPromptEditor";
import { FolderClosed } from "./FolderClosed";
import PlanSidebar from "./PlanSidebar";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SynaraLogo } from "./SynaraLogo";
import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";
import { ChatComposerFooter } from "./chat/ChatComposerFooter";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatSurfaceHeader } from "./chat/ChatSurfaceHeader";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import { ComposerActiveTaskListCard } from "./chat/ComposerActiveTaskListCard";
import { ComposerBranchMismatchBanner } from "./chat/ComposerBranchMismatchBanner";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import { ComposerExpiredUserInputNotice } from "./chat/ComposerExpiredUserInputNotice";
import { ComposerExtrasPanel } from "./chat/ComposerExtrasPanel";
import { ComposerExtrasTrigger } from "./chat/ComposerExtrasTrigger";
import { ComposerGoalHeader } from "./chat/ComposerGoalHeader";
import { ComposerInputBanners } from "./chat/ComposerInputBanners";
import { ComposerLiveChangesHeader } from "./chat/ComposerLiveChangesHeader";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import { ComposerModelEffortPicker } from "./chat/ComposerModelEffortPicker";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ComposerSubagentStrip } from "./chat/ComposerSubagentStrip";
import {
  collectForegroundRunningSubagentStripItems,
  collectRunningSubagentStripItems,
  type ComposerSubagentStripItem,
} from "./chat/ComposerSubagentStrip.logic";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { ExpandedImageOverlay } from "./chat/ExpandedImageOverlay";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { ExpiredSidechatNotice } from "./chat/ExpiredSidechatNotice";
import type { MessagesTimelineController } from "./chat/MessagesTimeline";
import { buildTurnDiffSummaryByAssistantMessageId } from "./chat/MessagesTimeline.logic";
import { ProjectPicker } from "./chat/ProjectPicker";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ProviderModelPicker, resolveProviderModelLabel } from "./chat/ProviderModelPicker";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import { ThreadDetailHydrationState } from "./chat/ThreadDetailHydrationState";
import { ChatThreadFindHost } from "./chat/ThreadFindBar";
import { TraitsPicker, resolveTraitsTriggerSummary } from "./chat/TraitsPicker";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { WorkflowRunCard } from "./chat/WorkflowRunCard";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "./chat/chatHeaderControls";
import type { LateComposerSendHandlers } from "./chat/chatSendTypes";
import { composerTranscriptBottomInsetPx, useComposerOverlayHeight } from "./chat/composerOverlay";
import {
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
  COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./chat/composerPickerStyles";
import { getComposerTraitSelection } from "./chat/composerTraits";
import {
  ENVIRONMENT_DOCKED_CONTENT_INSET_PX,
  EnvironmentPanel,
  type EnvironmentPanelProps,
} from "./chat/environment/EnvironmentPanel";
import { usePinnedMessageActions } from "./chat/environment/usePinnedMessageActions";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";
import { createThreadFindHighlightStore, type ThreadFindMatch } from "./chat/threadFind.logic";
import { useChatAutomationCreation } from "./chat/useChatAutomationCreation";
import { useChatAutomationSetup } from "./chat/useChatAutomationSetup";
import { useChatComposerCommands } from "./chat/useChatComposerCommands";
import { useChatComposerDraft } from "./chat/useChatComposerDraft";
import { useChatComposerEditing } from "./chat/useChatComposerEditing";
import { useChatKeyboardShortcuts } from "./chat/useChatKeyboardShortcuts";
import { useChatLocalDispatch } from "./chat/useChatLocalDispatch";
import { useChatPendingInteractions } from "./chat/useChatPendingInteractions";
import { useChatProjectScripts } from "./chat/useChatProjectScripts";
import { useChatProviderModels } from "./chat/useChatProviderModels";
import { useChatProviderStatus } from "./chat/useChatProviderStatus";
import { useChatQueuedTurns } from "./chat/useChatQueuedTurns";
import { useChatRuntimeModes } from "./chat/useChatRuntimeModes";
import { useChatTerminalController } from "./chat/useChatTerminalController";
import { useChatTimelineMessages } from "./chat/useChatTimelineMessages";
import { useChatTranscriptScroll } from "./chat/useChatTranscriptScroll";
import { useChatTurnFollowUps } from "./chat/useChatTurnFollowUps";
import { useChatTurnSubmission } from "./chat/useChatTurnSubmission";
import { useChatWorkLog } from "./chat/useChatWorkLog";
import { useChatWorkspaceSelection } from "./chat/useChatWorkspaceSelection";
import { useComposerDiscovery } from "./chat/useComposerDiscovery";
import { useComposerReferences } from "./chat/useComposerReferences";
import { useComposerVoiceController } from "./chat/useComposerVoiceController";
import { useThreadErrorToast } from "./chat/useThreadErrorToast";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import {
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { Button } from "./ui/button";
import { SidebarHeaderTrigger } from "./ui/sidebar";
import { Skeleton } from "./ui/skeleton";
import { toastManager } from "./ui/toast";

// The terminal drawer drags in xterm plus its addons (~223 KB gzip). Both mount points
// are conditional, so loading it lazily keeps the terminal stack out of the initial
// chat bundle and defers the cost to the first time a terminal is actually opened.
const ThreadTerminalDrawer = lazy(() => import("./ThreadTerminalDrawer"));

const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
const EMPTY_GOAL_ACHIEVEMENTS: readonly ThreadGoalAchievement[] = [];
const EMPTY_PINNED_TEXT: ReadonlyMap<MessageId, string> = new Map();
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

/** Ties the composer `+` trigger to the panel it opens above the editor. */
const COMPOSER_EXTRAS_PANEL_ID = "composer-extras-panel";

const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];

const EMPTY_TERMINAL_RUNTIME_ENV: Record<string, string> = {};
const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;

const EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS: ReadonlyArray<string> = [];

function getProviderHealthBannerDismissalKey(status: ServerProviderStatus | null): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("\u001f");
}

function getRateLimitBannerDismissalKey(
  status: RateLimitStatus | null,
  threadId: Thread["id"] | null,
): string | null {
  if (!status || !threadId) {
    return null;
  }
  return [
    threadId,
    status.status,
    status.resetsAt ?? "",
    typeof status.utilization === "number" ? String(Math.round(status.utilization * 100)) : "",
  ].join("\u001f");
}

const VOICE_RECORDER_ACTION_ARM_DELAY_MS = 250;

function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

function ComposerControlSkeleton(props: { widthClassName: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex h-8 shrink-0 items-center rounded-md border border-border/50 px-2",
        props.widthClassName,
      )}
    >
      <Skeleton className="h-3.5 w-full rounded-full" />
    </div>
  );
}

function ComposerModelLoadingControl(props: { widthClassName: string }) {
  return (
    <div
      aria-label="Loading models"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md border border-border/50 px-2 text-muted-foreground",
        props.widthClassName,
      )}
    >
      <RefreshCwIcon aria-hidden="true" className="size-3.5 animate-spin" />
      <span className="truncate text-[length:var(--app-font-size-ui-xs,11px)]">Loading models</span>
    </div>
  );
}

interface ChatViewProps {
  threadId: ThreadId;
  hideHeader?: boolean;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  presentationMode?: "default" | "editor";
  isFocusedPane?: boolean;
  panelState?: SplitViewPanePanelState;
  onToggleDiffPanel?: () => void;
  onToggleRightDock?: () => void;
  onToggleBrowserPanel?: () => void;
  onToggleDevicePanel?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
  viewModeAction?: {
    label: string;
    active: boolean;
    onClick: () => void;
  } | null;
  onChangeThreadInSplitPane?: () => void;
  onCloseThreadPane?: () => void;
}

// Builds an ephemeral transcript bubble for the conversational automation-setup
// exchange. These never reach a provider and are not persisted; they render the
// back-and-forth (user request, Synara's clarifying questions) inline like Codex.

export default function ChatView({
  threadId,
  hideHeader: hideHeaderProp,
  paneScopeId: paneScopeIdProp,
  surfaceMode: surfaceModeProp,
  presentationMode: presentationModeProp,
  isFocusedPane: isFocusedPaneProp,
  panelState,
  onToggleDiffPanel,
  onToggleRightDock,
  onToggleBrowserPanel,
  onToggleDevicePanel,
  onOpenBrowserUrl,
  onOpenTurnDiffPanel,
  onSplitSurface,
  onMaximizeSurface,
  viewModeAction: viewModeActionProp,
  onChangeThreadInSplitPane,
  onCloseThreadPane,
}: ChatViewProps) {
  // Prop defaults are resolved here instead of in the destructuring pattern: an
  // AssignmentPattern in the parameter list makes React Compiler bail out (silently —
  // `panicThreshold` is unset) on this entire component, the hottest one in the app.
  // See chatHotPath.compiler.test.ts.
  const paneScopeId = paneScopeIdProp ?? SINGLE_CHAT_PANE_SCOPE_ID;
  const hideHeader = hideHeaderProp ?? false;
  const surfaceMode = surfaceModeProp ?? "single";
  const presentationMode = presentationModeProp ?? "default";
  const isFocusedPane = isFocusedPaneProp ?? true;
  const viewModeAction = viewModeActionProp ?? null;
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const { settings, updateSettings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const setComposerDraftModelSelectionAndSticky = useComposerDraftStore(
    (store) => store.setModelSelectionAndSticky,
  );
  const timestampFormat = settings.timestampFormat;
  // The composer floats over the transcript; its measured height becomes the
  // transcript's bottom content inset (see composerOverlay.ts).
  const {
    overlayRef: composerOverlayRef,
    overlayHeightPx: composerOverlayHeightPx,
    overlayBottomClearancePx: composerOverlayBottomClearancePx,
  } = useComposerOverlayHeight();
  const composerTranscriptInsetPx = composerTranscriptBottomInsetPx(composerOverlayHeightPx);
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { createThreadHandoff } = useThreadHandoff();
  const rawSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(
    useMemo(() => selectSplitView(rawSearch.splitViewId ?? null), [rawSearch.splitViewId]),
  );
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(
    gitCreateDetachedWorktreeMutationOptions({ queryClient }),
  );
  const isEditorRail = presentationMode === "editor";
  const isInactiveSplitPane = surfaceMode === "split" && !isFocusedPane;
  const {
    composerDraft,
    prompt,
    composerImages,
    composerFiles,
    composerAssistantSelections,
    composerBrowserAnnotations,
    composerFileComments,
    composerTerminalContexts,
    composerPastedTexts,
    composerPullRequestContexts,
    composerSkills,
    composerMentions,
    queuedComposerTurns,
    composerSendState,
    nonPersistedComposerImageIds,
    durablyPersistedComposerImageIds,
    setComposerDraftPrompt,
    setComposerDraftPromptHistorySavedDraft,
    restoreComposerDraftPromptHistorySavedDraft,
    setComposerDraftModelSelection,
    setComposerDraftProviderModelOptions,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    enqueueQueuedComposerTurn,
    insertQueuedComposerTurn,
    removeQueuedComposerTurnFromDraft,
    removeComposerDraftFile,
    addComposerDraftBrowserAnnotations,
    insertComposerDraftTerminalContext,
    addComposerDraftPastedTexts,
    setComposerDraftTerminalContexts,
    clearComposerDraftContent,
    setDraftThreadContext,
    getDraftThreadByProjectId,
    getDraftThread,
    setProjectDraftThreadId,
    clearProjectDraftThreadId,
    promptRef,
    composerAssistantSelectionsRef,
    composerBrowserAnnotationsRef,
    composerTerminalContextsRef,
    composerFileCommentsRef,
    composerPastedTextsRef,
    composerPullRequestContextsRef,
    composerCursor,
    setComposerCursor,
    composerTrigger,
    setComposerTrigger,
    composerEditorRef,
    promptHistoryNavigationRef,
    applyingPromptHistoryNavigationRef,
    expectedPromptHistoryPromptRef,
    promptHistoryAppliedPromptRef,
    composerImagesRef,
    composerFilesRef,
    restoredQueuedSourceProposedPlanRef,
    setRestoredQueuedSourceProposedPlan,
    setPrompt,
    discardPromptHistoryNavigationForComposerMutation,
    addComposerImagesToDraft,
    addComposerFilesToDraft,
    addComposerAssistantSelectionToDraft,
    addComposerTerminalContextsToDraft,
    addComposerPastedTextsToDraft,
    addComposerFileCommentToDraft,
    removeComposerImageFromDraft,
    clearComposerAssistantSelectionsFromDraft,
    clearComposerFileCommentsFromDraft,
    removeComposerTerminalContextFromDraft,
    removeComposerPastedTextFromDraft,
    addComposerPullRequestContextsToDraft,
    removeComposerPullRequestContextFromDraft,
    removeComposerBrowserAnnotationFromDraft,
    showComposerPastedTextInField,
  } = useChatComposerDraft({ threadId });
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const hasTemporaryThreadMarker = useTemporaryThreadStore((store) =>
    threadId ? store.temporaryThreadIds[threadId] === true : false,
  );
  const markTemporaryThread = useTemporaryThreadStore((store) => store.markTemporaryThread);
  const clearTemporaryThread = useTemporaryThreadStore((store) => store.clearTemporaryThread);
  const markWorkflowRunPaused = useWorkflowRunUiStore((store) => store.markPaused);
  const markWorkflowRunDismissed = useWorkflowRunUiStore((store) => store.markDismissed);
  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const sourceThreadSidechats = useStore(
    useMemo(() => createSidechatSummariesForSourceSelector(threadId), [threadId]),
  );
  const threadDetailSyncState = useStore((state) =>
    threadId ? (state.threadDetailSyncById?.[threadId] ?? null) : null,
  );
  const composerThreadSummaries = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const composerThreadProjects = useStore((state) => state.projects);
  const crossTaskSourceThreadId =
    serverThread?.creationSource && serverThread.sourceThreadId
      ? serverThread.sourceThreadId
      : null;
  const crossTaskSourceThread = useStore(
    useMemo(() => createThreadSelector(crossTaskSourceThreadId), [crossTaskSourceThreadId]),
  );
  const crossTaskOrigin = useMemo(
    () =>
      crossTaskSourceThreadId
        ? {
            sourceThreadId: crossTaskSourceThreadId,
            sourceProvider: crossTaskSourceThread?.modelSelection.provider ?? null,
          }
        : null,
    [crossTaskSourceThread?.modelSelection.provider, crossTaskSourceThreadId],
  );
  const forkSourceThreadId = serverThread?.sidechatSourceThreadId
    ? null
    : (serverThread?.forkSourceThreadId ?? null);
  const forkSourceThread = useStore(
    useMemo(() => createThreadSelector(forkSourceThreadId), [forkSourceThreadId]),
  );
  const forkSource = useMemo(
    () =>
      forkSourceThreadId
        ? {
            sourceThreadId: forkSourceThreadId,
            sourceTitle: forkSourceThread?.title ?? "chat",
          }
        : null,
    [forkSourceThread?.title, forkSourceThreadId],
  );
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  const draftFallbackModelSelection = useMemo<ModelSelection>(
    () =>
      resolveDraftFallbackModelSelection({
        projectDefault: fallbackDraftProject?.defaultModelSelection,
        settingsDefaultProvider: settings.defaultProvider,
      }),
    [fallbackDraftProject?.defaultModelSelection, settings.defaultProvider],
  );

  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});

  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [pendingFileUndo, setPendingFileUndo] = useState<PendingFileUndo | null>(null);

  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [activeTaskListCompact, setActiveTaskListCompact] = useState(false);
  const [subagentStripCompact, setSubagentStripCompact] = useState(false);
  const [workflowRunCardCompact, setWorkflowRunCardCompact] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Width-aware visibility for the footer picker cluster (context meter,
  // model name, traits label). Inputs live in a ref so the resize observer
  // can re-plan without re-subscribing; the sync function is exposed via ref
  // so label changes can re-plan without a resize.
  const [composerFooterTier, setComposerFooterTier] = useState(0);
  const composerFooterTierRef = useRef(0);
  const composerFooterDemotionWidthsRef = useRef<ReadonlyArray<number | undefined>>([]);
  const composerFooterLayoutSyncRef = useRef<(() => void) | null>(null);

  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
  // The composer `+` panel shares the floating slot above the editor with the
  // slash/mention command menu, so only one of the two is ever open.
  const [isComposerExtrasPanelOpen, setIsComposerExtrasPanelOpen] = useState(false);
  const [secondaryChromePlaceholderHeight, setSecondaryChromePlaceholderHeight] = useState(88);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);

  const [dismissedProviderHealthBannerKeys, setDismissedProviderHealthBannerKeys] = useLocalStorage(
    DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
    EMPTY_DISMISSED_PROVIDER_HEALTH_BANNERS,
    DismissedProviderHealthBannersSchema,
  );
  const [dismissedRateLimitBannerKey, setDismissedRateLimitBannerKey] = useState<string | null>(
    null,
  );
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const legendListRef = useRef<LegendListRef | null>(null);
  const timelineControllerRef = useRef<MessagesTimelineController | null>(null);
  const [threadFindOpen, setThreadFindOpen] = useState(false);
  const [threadFindFocusNonce, setThreadFindFocusNonce] = useState(0);
  const [threadFindHighlightStore] = useState(() => createThreadFindHighlightStore());
  const handleThreadFindJump = (match: ThreadFindMatch) => {
    timelineControllerRef.current?.scrollToMessage(match.messageId, {
      ...(match.segmentIndex === undefined ? {} : { segmentIndex: match.segmentIndex }),
      fineScrollFind: true,
    });
  };
  const handleThreadFindActiveMatchChange = (match: ThreadFindMatch | null) => {
    threadFindHighlightStore.setActiveMatch(match);
    timelineControllerRef.current?.setActiveFindMatch(match);
  };

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade; the pickers already closed post-commit.
    const settle = window.setTimeout(() => {
      setComposerCommandPicker(null);
      setIsComposerExtrasPanelOpen(false);
      setIsModelPickerOpen(false);
      setIsTraitsPickerOpen(false);
      setThreadFindOpen(false);
      threadFindHighlightStore.set(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    setComposerCommandPicker,
    setIsComposerExtrasPanelOpen,
    setIsModelPickerOpen,
    setIsTraitsPickerOpen,
    setThreadFindOpen,
    threadId,
    threadFindHighlightStore,
  ]);

  const composerFormRef = useRef<HTMLFormElement>(null);
  // Set by whichever mounted GitActionsControl instance (header quick-action or the
  // Environment panel row) last registered — either performs the identical commit &
  // push mutation for this thread's repo, so it doesn't matter which one is "current".
  const commitAndPushTriggerRef = useRef<(() => void) | null>(null);
  const onRegisterCommitAndPushTrigger = useCallback(
    (trigger: (() => void) | null) => {
      commitAndPushTriggerRef.current = trigger;
    },
    [commitAndPushTriggerRef],
  );
  const pendingComposerFocusRef = useRef(false);

  const composerFormHeightRef = useRef(0);

  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);

  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);

  const sendInFlightRef = useRef(false);
  const sendPreflightInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const activatedThreadIdRef = useRef<ThreadId | null>(null);

  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(threadId, draftThread, draftFallbackModelSelection, localDraftError)
        : undefined,
    [draftThread, draftFallbackModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
  // Local threads reconcile their stored branch to the shared checkout as soon as the
  // branch query resolves. Keep the branch seen when a thread becomes active so a settled
  // thread can explain that change before the user's first resumed message.
  const [activeThreadBranchAtActivation, setActiveThreadBranchAtActivation] = useState<{
    threadId: ThreadId;
    branch: string | null;
    isSettled: boolean;
  } | null>(null);
  const [
    settledThreadBranchWarningDismissedThreadId,
    setSettledThreadBranchWarningDismissedThreadId,
  ] = useState<ThreadId | null>(null);
  useEffect(() => {
    if (!activeThread || activeThreadBranchAtActivation?.threadId === activeThread.id) {
      return;
    }
    setActiveThreadBranchAtActivation({
      threadId: activeThread.id,
      branch: activeThread.branch,
      isSettled: activeThread.settledAt != null,
    });
    setSettledThreadBranchWarningDismissedThreadId(null);
  }, [
    setActiveThreadBranchAtActivation,
    setSettledThreadBranchWarningDismissedThreadId,
    activeThread,
    activeThreadBranchAtActivation?.threadId,
  ]);
  const settledThreadBranchAtActivation =
    activeThreadBranchAtActivation !== null &&
    activeThreadBranchAtActivation.threadId === activeThread?.id &&
    activeThreadBranchAtActivation.isSettled
      ? activeThreadBranchAtActivation.branch
      : activeThread?.branch;
  useEffect(() => {
    if (
      !pendingFileUndo ||
      !hasFileUndoSettled({ pending: pendingFileUndo, thread: activeThread ?? null })
    ) {
      return;
    }
    // Async setState (post-paint) keeps this settled-undo cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setPendingFileUndo(null);
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setIsRevertingCheckpoint, setPendingFileUndo, activeThread, pendingFileUndo]);
  const runtimeMode =
    composerDraft.runtimeMode ?? activeThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE;

  const interactionMode =
    composerDraft.interactionMode ?? activeThread?.interactionMode ?? DEFAULT_INTERACTION_MODE;
  const isServerThread = serverThread !== undefined;
  const isLocalDraftThread = !isServerThread && localDraftThread !== undefined;
  const canCheckoutPullRequestIntoThread = isLocalDraftThread;
  const diffOpen = rawSearch.panel === "diff";
  const browserOpen = rawSearch.panel === "browser";
  const resolvedDiffOpen = panelState ? panelState.panel === "diff" : diffOpen;
  const activeThreadId = activeThread?.id ?? null;
  const activeLatestTurn = activeThread?.latestTurn ?? null;
  // Read once here so memo bodies depend on the turn id instead of the turn object: a
  // `foo?.bar` read inside a memo makes React Compiler infer `foo` as the dependency, which
  // no longer matches the hand-written `foo?.bar` dep and bails the whole component out.
  const activeLatestTurnId = activeLatestTurn?.turnId ?? null;
  const activeLatestTurnState = activeLatestTurn?.state ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn: activeLatestTurn,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    activities: threadActivities,
    session: activeThread?.session ?? null,
  });
  const activeContextWindowState = useMemo(
    () => deriveLatestContextWindowState(threadActivities),
    [threadActivities],
  );
  const activeContextWindow = activeContextWindowState.snapshot;
  const activeCumulativeCostUsd = useMemo(
    () => deriveCumulativeCostUsd(threadActivities),
    [threadActivities],
  );
  const activeRateLimitStatus = useMemo(
    () => deriveLatestRateLimitStatus(threadActivities),
    [threadActivities],
  );
  const activeRateLimitBannerDismissalKey = useMemo(
    () => getRateLimitBannerDismissalKey(activeRateLimitStatus, activeThread?.id ?? null),
    [activeRateLimitStatus, activeThread?.id],
  );
  const visibleActiveRateLimitStatus =
    activeRateLimitBannerDismissalKey === dismissedRateLimitBannerKey
      ? null
      : activeRateLimitStatus;
  const latestTurnSettledByProvider = isLatestTurnSettled(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const latestTurnSettled = latestTurnSettledByProvider && !hasLiveTurnTail;
  // `latestTurnSettled` is also false when there is NO started turn (a brand-new
  // chat), because `isLatestTurnSettled` treats a non-existent turn as unsettled.
  // Gate live-turn UI on an actually-started turn so composer chrome cannot
  // appear on a fresh chat just because the repo already has local edits.
  const latestTurnLive = Boolean(activeLatestTurn?.startedAt) && !latestTurnSettled;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const deletePlaceholderTerminalThread = useCallback(
    async (terminalThreadId: ThreadId) => {
      const api = readNativeApi();
      if (!api) return;
      // Body kept in a nested function: React Compiler's BuildHIR cannot lower a value block
      // (`?.`, `??`, ternary) that sits directly inside a `try`, and one of them makes the
      // whole component bail out of compilation. The catch below still sees every rejection.
      const deleteEmptyTerminalThread = async () => {
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: terminalThreadId,
        });
        void reconcileDeletedThreadFromClient({
          threadId: terminalThreadId,
          removeDeletedThreadFromClientState:
            useStore.getState().removeDeletedThreadFromClientState,
        });
        useComposerDraftStore.getState().clearDraftThread(terminalThreadId);
        useTerminalStateStore.getState().clearTerminalState(terminalThreadId);
        removeThreadFromSplitViews(terminalThreadId);
        if (activeSplitView) {
          const nextSplitView = useSplitViewStore.getState().splitViewsById[activeSplitView.id];
          const nextThreadId = nextSplitView
            ? resolveSplitViewFocusedThreadId(nextSplitView)
            : null;
          if (nextSplitView && nextThreadId) {
            await navigate({
              to: "/$threadId",
              params: { threadId: nextThreadId },
              replace: true,
              search: () => ({ splitViewId: nextSplitView.id }),
            });
            return;
          }
        }
        await handleNewChat();
      };

      try {
        await deleteEmptyTerminalThread();
      } catch (error) {
        console.error("Failed to delete empty terminal thread after closing its last terminal", {
          threadId: terminalThreadId,
          error,
        });
      }
    },
    [activeSplitView, handleNewChat, navigate, removeThreadFromSplitViews],
  );
  const {
    terminalState,
    terminalFocusRequestId,
    requestTerminalFocus,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    setTerminalOpen,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
    setTerminalHeight,
    setTerminalMetadataInStore: storeSetTerminalMetadata,
    setTerminalActivityInStore: storeSetTerminalActivity,
    openChatThreadPageInStore: storeOpenChatThreadPage,
    openTerminalThreadPageInStore: storeOpenTerminalThreadPage,
    closeTerminalGroupInStore: storeCloseTerminalGroup,
    resizeTerminalSplitInStore: storeResizeTerminalSplit,
    toggleTerminalVisibility,
    expandTerminalWorkspace,
    collapseTerminalWorkspace,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalDown,
    splitTerminalUp,
    createNewTerminal,
    createNewTerminalTab,
    createTerminalFromShortcut,
    moveTerminalToNewGroup,
    openNewFullWidthTerminal,
    activateTerminal,
    closeTerminal,
    handleTerminalSessionExited,
    closeActiveWorkspaceView,
  } = useChatTerminalController({
    threadId,
    activeThreadId,
    activeThread,
    activeProjectPresent: activeProject !== undefined,
    isFocusedPane,
    isServerThread,
    confirmTerminalClose: settings.confirmTerminalTabClose,
    onDeletePlaceholderThread: deletePlaceholderTerminalThread,
  });
  const projectInstructions = useProjectInstructionsStore((state) =>
    activeProjectId ? (state.instructionsByProjectId[activeProjectId] ?? "") : "",
  );
  const setProjectInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const homeDir = useWorkspacePathsStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((state) => state.studioWorkspaceRoot);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
  });
  const isStudioContainer = isStudioContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  const isContainerLandingProject = isHomeChatContainer || isStudioContainer;
  const activeProjectDisplayName = isHomeChatContainer
    ? activeProject?.folderName
    : activeProject?.name;
  const isChatProject = isContainerLandingProject;
  const activeProjectScripts =
    activeProject?.kind === "project" ? activeProject.scripts : undefined;
  const threadLineageThreads = useStore(
    useMemo(() => createThreadLineageSelector(activeThread?.id ?? null), [activeThread?.id]),
  );
  const threadBreadcrumbs = useMemo(
    () => buildThreadBreadcrumbs(threadLineageThreads, activeThread),
    [activeThread, threadLineageThreads],
  );
  // Studio threads are always local. Their optional "Use a folder" cwd is stored separately
  // from Git worktree metadata; the server migration repairs the legacy mixed representation.
  const resolvedThreadEnvMode = isStudioContainer
    ? "local"
    : isServerThread
      ? (activeThread?.envMode ?? null)
      : (draftThread?.envMode ?? null);
  const resolvedThreadWorktreePath = isStudioContainer
    ? null
    : isServerThread
      ? (activeThread?.worktreePath ?? null)
      : (draftThread?.worktreePath ?? null);
  const resolvedThreadWorkingDirectory = isServerThread
    ? (activeThread?.workingDirectory ?? null)
    : (draftThread?.workingDirectory ?? null);
  const diffEnvironmentState = resolveDiffEnvironmentState({
    projectCwd: activeProject?.cwd ?? null,
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });
  const diffEnvironmentPending = diffEnvironmentState.pending;
  const diffDisabledReason = diffEnvironmentState.disabledReason;
  const repoDiffBadgeRefreshIntervalMs =
    isFocusedPane && latestTurnLive && !diffEnvironmentPending && !resolvedDiffOpen
      ? GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS
      : false;
  const activeThreadAssociatedWorktree = useMemo(
    () =>
      deriveAssociatedWorktreeMetadata({
        branch: activeThread?.branch ?? null,
        worktreePath: activeThread?.worktreePath ?? null,
        ...(activeThread?.associatedWorktreePath !== undefined
          ? { associatedWorktreePath: activeThread.associatedWorktreePath }
          : {}),
        ...(activeThread?.associatedWorktreeBranch !== undefined
          ? { associatedWorktreeBranch: activeThread.associatedWorktreeBranch }
          : {}),
        ...(activeThread?.associatedWorktreeRef !== undefined
          ? { associatedWorktreeRef: activeThread.associatedWorktreeRef }
          : {}),
      }),
    [activeThread],
  );

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
      setComposerHighlightedItemId(null);
    },
    [setComposerHighlightedItemId, setPullRequestDialogState, canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, [setPullRequestDialogState]);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      envMode: DraftThreadEnvMode;
      lastKnownPr?: Thread["lastKnownPr"];
    }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const draftThreadContext = {
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.envMode,
        ...(input.lastKnownPr !== undefined ? { lastKnownPr: input.lastKnownPr } : {}),
      };
      const storedDraftThread = getDraftThreadByProjectId(activeProject.id);
      if (storedDraftThread) {
        setDraftThreadContext(storedDraftThread.threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, storedDraftThread.threadId, draftThreadContext);
        if (storedDraftThread.threadId !== threadId) {
          await navigate({
            to: "/$threadId",
            params: { threadId: storedDraftThread.threadId },
          });
        }
        return;
      }

      const activeDraftThread = getDraftThread(threadId);
      if (
        !isServerThread &&
        activeDraftThread?.projectId === activeProject.id &&
        activeDraftThread.entryPoint === "chat"
      ) {
        setDraftThreadContext(threadId, draftThreadContext);
        setProjectDraftThreadId(activeProject.id, threadId, draftThreadContext);
        return;
      }

      clearProjectDraftThreadId(activeProject.id);
      const nextThreadId = newThreadId();
      setProjectDraftThreadId(activeProject.id, nextThreadId, {
        ...draftThreadContext,
        createdAt: new Date().toISOString(),
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
      });
      await navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
      });
    },
    [
      activeProject,
      clearProjectDraftThreadId,
      getDraftThread,
      getDraftThreadByProjectId,
      isServerThread,
      navigate,
      setDraftThreadContext,
      setProjectDraftThreadId,
      threadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: {
      branch: string;
      worktreePath: string | null;
      pullRequest: NonNullable<Thread["lastKnownPr"]>;
    }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
        lastKnownPr: input.pullRequest,
      });
    },
    [openOrReuseProjectDraftThread],
  );

  useEffect(() => {
    if (!activeThread?.id) return;
    if (!latestTurnSettled) return;
    if (!activeLatestTurn?.completedAt) return;
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnCompletedAt)) return;
    const lastVisitedAt = activeThread.lastVisitedAt ? Date.parse(activeThread.lastVisitedAt) : NaN;
    if (!Number.isNaN(lastVisitedAt) && lastVisitedAt >= turnCompletedAt) return;

    markThreadVisited(activeThread.id);
  }, [
    activeThread?.id,
    activeThread?.lastVisitedAt,
    activeLatestTurn?.completedAt,
    latestTurnSettled,
    markThreadVisited,
  ]);

  const {
    hasThreadStarted,
    lockedProvider,
    serverConfigQuery,
    selectedProvider,
    providerModelDiscoveryCwd,
    customModelsByProvider,
    modelOptionsByProvider,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    dynamicAgents,
    selectedProviderRuntimeModelDiscoveryPending,
    composerModelOptions,
    selectedModel,
    selectedRuntimeModel,
    composerProviderState,
    selectedPromptEffort,
    selectedModelSelection,
    providerOptionsForDispatch,
    selectedModelForPickerWithCustomFallback,
    showComposerModelBootstrapSkeleton,
    searchableModelOptions,
  } = useChatProviderModels({
    threadId,
    activeThread,
    activeProject,
    composerDraft,
    settings,
    isModelPickerOpen,
    resolvedThreadWorktreePath,
  });
  const {
    selectedComposerSkills,
    selectedComposerMentions,
    selectedComposerSkillsRef,
    selectedComposerMentionsRef,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
  } = useComposerReferences({
    threadId,
    selectedProvider,
    prompt,
    composerSkills,
    composerMentions,
  });
  const featureFlags = useFeatureFlags();
  const showDebugTaskBanner = import.meta.env.DEV && featureFlags["show-debug-task-banner"];
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());

  const phase = derivePhase(activeThread?.session ?? null);
  const isConnecting = phase === "connecting";
  const providerDisplayName =
    PROVIDER_DISPLAY_NAMES[activeThread?.session?.provider ?? selectedProvider];
  const { workLogEntries, composerSubagentStripItems, stripSourceThreadId, workflowRunState } =
    useChatWorkLog({
      activeThread,
      latestTurnSettled,
      latestTurnLive,
    });
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const agentActivityTimelineState = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries),
    [workLogEntries],
  );
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setOpenAgentActivityId, activeThread?.id]);
  useEffect(() => {
    if (!openAgentActivityId || agentActivityTimelineState.detailById.has(openAgentActivityId)) {
      return;
    }
    // Async setState (post-paint) keeps this stale-detail cleanup out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setOpenAgentActivityId(null);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setOpenAgentActivityId, agentActivityTimelineState.detailById, openAgentActivityId]);
  const {
    respondingRequestKeys,
    pendingApprovals,
    pendingUserInputs,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    expiredQuestionDrafts,
    activePendingUserInput,
    activePendingUserInputKey,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingQuestion,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingApproval,
    onRespondToApproval,
    userInputSubmissionVersion,
    onCancelActivePendingUserInput,
    onToggleActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  } = useChatPendingInteractions({
    threadId,
    activeThread,
    runtimeMode,
    promptRef,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
  });
  const activeProposedPlan = useMemo(() => {
    if (!latestTurnSettled) {
      return null;
    }
    return findLatestProposedPlan(
      activeThread?.proposedPlans ?? [],
      activeLatestTurn?.turnId ?? null,
    );
  }, [activeLatestTurn?.turnId, activeThread?.proposedPlans, latestTurnSettled]);
  const sidebarPlanSourceThreadId = !latestTurnSettled
    ? (activeLatestTurn?.sourceProposedPlan?.threadId ?? null)
    : null;
  const sidebarPlanSourceThread = useStore(
    useMemo(() => createThreadSelector(sidebarPlanSourceThreadId), [sidebarPlanSourceThreadId]),
  );
  const activeThreadPlanThreadId = activeThread?.id ?? null;
  const activeThreadPlanProposedPlans = activeThread?.proposedPlans;
  const sidebarPlanSourceThreadPlanId = sidebarPlanSourceThread?.id ?? null;
  const sidebarPlanSourceThreadProposedPlans = sidebarPlanSourceThread?.proposedPlans;
  const sidebarProposedPlan = useMemo(
    () =>
      findSidebarProposedPlan({
        threads: [
          ...(activeThreadPlanThreadId
            ? [
                {
                  id: activeThreadPlanThreadId,
                  proposedPlans: activeThreadPlanProposedPlans ?? [],
                },
              ]
            : []),
          ...(sidebarPlanSourceThreadPlanId &&
          sidebarPlanSourceThreadPlanId !== activeThreadPlanThreadId
            ? [
                {
                  id: sidebarPlanSourceThreadPlanId,
                  proposedPlans: sidebarPlanSourceThreadProposedPlans ?? [],
                },
              ]
            : []),
        ],
        latestTurn: activeLatestTurn,
        latestTurnSettled,
        threadId: activeThreadPlanThreadId,
      }),
    [
      activeLatestTurn,
      activeThreadPlanProposedPlans,
      activeThreadPlanThreadId,
      latestTurnSettled,
      sidebarPlanSourceThreadPlanId,
      sidebarPlanSourceThreadProposedPlans,
    ],
  );
  const planSidebarLabel = sidebarProposedPlan ? "Plan details" : "Tasks";
  const planSidebarToggleLabel = planSidebarOpen ? `Hide ${planSidebarLabel}` : planSidebarLabel;
  const planSidebarToggleTitle = `${planSidebarOpen ? "Hide" : "Show"} ${planSidebarLabel.toLowerCase()} sidebar`;
  const activeTaskList = useMemo((): ActiveTaskListState | null => {
    if (showDebugTaskBanner) {
      return {
        createdAt: new Date().toISOString(),
        turnId: activeLatestTurn?.turnId ?? null,
        tasks: [
          {
            task: "Inspect banner layout without overlapping transcript text",
            status: "inProgress",
          },
          {
            task: "Confirm compact task banner width",
            status: "pending",
          },
          {
            task: "Verify sidebar task controls",
            status: "completed",
          },
        ],
      };
    }

    // Only while a turn is live: deriveActiveTaskListState falls back to the latest
    // unfinished prior-turn list (follow-up turns, reloads mid-turn), but once the
    // thread is idle the card must clear — providers routinely end a turn without
    // marking every task completed, and an unfinished list must not linger forever.
    return latestTurnSettled
      ? null
      : deriveActiveTaskListState(threadActivities, activeLatestTurn?.turnId);
  }, [activeLatestTurn?.turnId, latestTurnSettled, showDebugTaskBanner, threadActivities]);
  const activeBackgroundTasks = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActiveBackgroundTasksState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );

  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);

  const {
    localDispatch,
    setLocalDispatch,
    worktreeSetupResolutionRef,
    worktreeSetupPendingAction,
    setWorktreeSetupPendingAction,
    turnTakenOver,
    isSendBusy,
    isAwaitingTurnStart,
    activeWorktreeSetup,
    isPreparingWorktree,
    beginLocalDispatch,
    failLocalDispatchWorktreeSetup,
    resetLocalDispatch,
    clearLocalDispatchWorktreeSetup,
    onResolveWorktreeSetup,
    armLocalDispatchAckFallback,
    scheduleFailedWorktreeSetupDispatchReset,
  } = useChatLocalDispatch({
    phase,
    activeLatestTurn,
    activeThread,
    activePendingApproval,
    activePendingUserInput,
  });
  const hasLiveTurn = phase === "running";
  // Providers that clear `activeTurnId` on every terminal event (Claude) would
  // otherwise leave the transcript with no active turn while work is still in
  // progress, collapsing the newest answer into a closed "Worked for" disclosure.
  // The latest turn is the transcript's own notion of "current", so fall back to it.
  const activeTurnIdForTranscript = activeThread?.session?.activeTurnId ?? activeLatestTurnId;
  // The edit affordance must mirror the exact policy the server decider applies:
  // resolve the editable target from the raw sequence-ordered thread messages and
  // the running-session turn id — never from the createdAt-sorted timeline rows,
  // whose optimistic/filtered entries can surface the button on a message the
  // validators then reject.
  const editableUserMessageId = useMemo(() => {
    if (!activeThread || !isServerThread) {
      return null;
    }
    const editTarget = resolveLatestTailUserMessageEditTarget({
      messages: activeThread.messages,
      activeTurnId:
        activeThread.session?.orchestrationStatus === "running"
          ? (activeThread.session.activeTurnId ?? null)
          : null,
    });
    return editTarget.editable ? (editTarget.messageId as MessageId) : null;
  }, [activeThread, isServerThread]);
  // Defence in depth against a session stuck at "running" with no turn to
  // complete: nothing would ever drain the composer queue, so messages routed
  // into it would be swallowed. Server-side reconciliation settles these
  // sessions; this keeps the composer usable until it does.
  const hasQueueableLiveTurn = hasLiveTurn && activeThread?.session?.activeTurnId != null;
  const {
    automationProjects,
    automationThreads,
    automationData,
    automationDraftForm,
    setAutomationDraftForm,
    automationDraftWarnings,
    setAutomationDraftWarnings,
    setAutomationDraftWarningContext,
    acknowledgedAutomationWarnings,
    setAcknowledgedAutomationWarnings,
    automationDraftOpen,
    setAutomationDraftOpen,
    setAutomationDraftDialogOpen,
    isAutomationDraftSubmitting,
    setIsAutomationDraftSubmitting,
    automationDraftSubmittingRef,
    pendingAutomationConversation,
    setPendingAutomationConversation,
    activeThreadIdRef,
    pendingAutomationConversationRef,
    hasLiveTurnRef,
    isPendingSetupBubbleId,
    cancelAutomationConversation,
    toggleAutomationWarning,
    updateAutomationDraftForm,
    resetAutomationDraftState,
  } = useChatAutomationSetup({
    threadId,
    hasLiveTurn,
    promptRef,
    setComposerDraftPrompt,
  });
  // Keep Thinking through the post-ack gap where the server has the message /
  // turn request but the provider session is not live yet (common on first send).
  const isWorking =
    hasLiveTurn || isSendBusy || isConnecting || isRevertingCheckpoint || isAwaitingTurnStart;
  const hasStreamingAssistantText =
    activeThread?.messages.some((message) => message.role === "assistant" && message.streaming) ??
    false;
  const activeTurnLayoutLive = isWorking || !latestTurnSettled;
  const [keepSettledActiveTurnLayout, setKeepSettledActiveTurnLayout] = useState(false);
  const previousActiveTurnLayoutLiveRef = useRef(activeTurnLayoutLive);
  const previousActiveTurnLayoutKeyRef = useRef<string | null>(null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? null)
    : hasLiveTurn
      ? deriveActiveWorkStartedAt(activeLatestTurn, activeThread?.session ?? null, null)
      : null;
  const activeTurnLayoutKey =
    activeThreadId === null ? null : `${activeThreadId}:${activeLatestTurn?.turnId ?? "idle"}`;
  const activeTurnInProgress = activeTurnLayoutLive || keepSettledActiveTurnLayout;
  const isComposerApprovalState = activePendingApproval !== null;
  const isSidechatExpired = Boolean(activeThread?.sidechatExpiredAt);
  const isComposerEditorDisabled = isConnecting || isComposerApprovalState || isSidechatExpired;
  const canCollapsePastedTextToDraft = shouldEnableComposerPastedTextCollapse({
    isComposerApprovalState,
    hasPendingUserInput: pendingUserInputs.length > 0,
    showPlanFollowUpPrompt,
  });
  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const handoffDisabled = !(
    activeThread &&
    activeProject &&
    isServerThread &&
    canCreateThreadHandoff({
      thread: activeThread,
      isBusy: isWorking,
      hasPendingApprovals: pendingApprovals.length > 0,
      hasPendingUserInput: pendingUserInputs.length > 0,
    })
  );

  useLayoutEffect(() => {
    if (previousActiveTurnLayoutKeyRef.current !== activeTurnLayoutKey) {
      previousActiveTurnLayoutKeyRef.current = activeTurnLayoutKey;
      previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    const shouldStartGrace = shouldStartActiveTurnLayoutGrace({
      previousTurnLayoutLive: previousActiveTurnLayoutLiveRef.current,
      currentTurnLayoutLive: activeTurnLayoutLive,
      latestTurnStartedAt: activeLatestTurn?.startedAt ?? null,
    });
    previousActiveTurnLayoutLiveRef.current = activeTurnLayoutLive;

    if (activeTurnLayoutLive) {
      setKeepSettledActiveTurnLayout(false);
      return;
    }

    if (!shouldStartGrace) {
      return;
    }

    setKeepSettledActiveTurnLayout(true);
    const timeoutId = window.setTimeout(() => {
      setKeepSettledActiveTurnLayout(false);
    }, ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    setKeepSettledActiveTurnLayout,
    previousActiveTurnLayoutLiveRef,
    previousActiveTurnLayoutKeyRef,
    activeLatestTurn?.startedAt,
    activeTurnLayoutKey,
    activeTurnLayoutLive,
  ]);

  const { timelineMessages, optimisticUserMessages, setOptimisticUserMessages } =
    useChatTimelineMessages({
      threadId,
      activeThread,
      pendingAutomationConversation,
    });
  const promptHistory = useMemo(() => {
    const activeMessages = activeThread?.messages ?? EMPTY_MESSAGES;
    // Optimistic messages exist only briefly after a send; skip the full-transcript
    // id Set on the common (streaming-flush) path where there is nothing to reconcile.
    if (optimisticUserMessages.length === 0) {
      return derivePromptHistoryFromMessages(activeMessages);
    }
    const activeMessageIds = new Set(activeMessages.map((message) => message.id));
    const pendingOptimisticMessages = optimisticUserMessages.filter(
      (message) => !activeMessageIds.has(message.id),
    );
    return derivePromptHistoryFromMessages([...activeMessages, ...pendingOptimisticMessages]);
  }, [activeThread?.messages, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        agentActivityTimelineState.timelineWorkEntries,
      ),
    [activeThread?.proposedPlans, agentActivityTimelineState.timelineWorkEntries, timelineMessages],
  );
  const enteringUserMessageIds = useMemo<ReadonlySet<MessageId>>(
    () => new Set(optimisticUserMessages.map((message) => message.id)),
    [optimisticUserMessages],
  );
  // The user message a local send anchored at the top of the transcript viewport.
  // Set at the send sites and kept after the turn settles — collapsing the tail
  // spacer when a turn ends would visibly yank the settled transcript. The next
  // send replaces it, and thread switches reset it via the per-thread timeline
  // remount plus the threadId guard at the render site.
  const [tailAnchor, setTailAnchor] = useState<{
    threadId: ThreadId;
    messageId: MessageId;
  } | null>(null);
  // True from send until the tail-anchor hook finishes sliding the sent message
  // to the viewport top. The auto-follow effect stays quiet while set so the
  // anchored slide has exactly one scroll owner (see useTailAnchorScroll).

  // --- Pinned messages & notes (per-thread, server-synced through sidepanel commands) ---
  const pinnedMessages = activeThread?.pinnedMessages ?? EMPTY_PINNED_MESSAGES;
  const goalAchievements = activeThread?.goalAchievements ?? EMPTY_GOAL_ACHIEVEMENTS;
  const threadNotes = activeThread?.notes ?? "";
  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((pin) => pin.messageId)),
    [pinnedMessages],
  );
  const pinnedMessageTextById = useMemo(() => {
    if (pinnedMessageIds.size === 0) return EMPTY_PINNED_TEXT;
    const textById = new Map<MessageId, string>();
    for (const message of timelineMessages) {
      if (pinnedMessageIds.has(message.id)) textById.set(message.id, message.text);
    }
    return textById;
  }, [pinnedMessageIds, timelineMessages]);
  const {
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  } = usePinnedMessageActions({ activeThreadId, pinnedMessages });
  const handleTogglePinMessageGuarded = useCallback(
    (messageId: MessageId) => {
      // Never pin an ephemeral automation-setup bubble; its id vanishes when setup ends.
      if (isPendingSetupBubbleId(messageId)) {
        return;
      }
      handleTogglePinMessage(messageId);
    },
    [handleTogglePinMessage, isPendingSetupBubbleId],
  );
  // Stable identity: this is forwarded to the memoized MessagesTimeline, so an inline
  // arrow here would defeat its `memo()` and re-derive every row on every keystroke.
  const canPinMessage = useCallback(
    (messageId: MessageId) => !isPendingSetupBubbleId(messageId),
    [isPendingSetupBubbleId],
  );
  const handleCopyProjectInstructionsToNotes = useCallback(() => {
    if (!activeThreadId) {
      return;
    }
    const nextNotes = mergeProjectInstructionsIntoThreadNotes({
      threadNotes,
      projectInstructions,
    });
    if (nextNotes === threadNotes) {
      return;
    }
    void handleNotesChange(activeThreadId, nextNotes)
      .then(() => {
        toastManager.add({
          type: "success",
          title: "Project instructions added to notepad.",
        });
      })
      .catch(() => {
        // `handleNotesChange` already surfaces the save failure through the shared notes toast.
      });
  }, [activeThreadId, handleNotesChange, projectInstructions, threadNotes]);
  const handleJumpToPinnedMessage = useCallback(
    (messageId: MessageId) => {
      timelineControllerRef.current?.scrollToMessage(messageId);
    },
    [timelineControllerRef],
  );

  // Before treating an empty timeline as a genuinely new thread, wait for the
  // detail snapshot: a server thread whose history has not synced yet must show
  // a loading (or failed) transcript state instead of the empty landing.
  const threadDetailHydration = resolveThreadDetailHydration({
    isServerThread,
    hasTimelineEntries: timelineEntries.length > 0,
    detailSyncState: threadDetailSyncState,
  });
  // Turn/session updates can arrive before the first transcript row. An empty
  // synced snapshot during startup must not restore the unstarted landing.
  // Terminal turns can lack start timestamps after restore/import; their state wins.
  const hasPendingThreadWork =
    isWorking || (activeLatestTurnState === "running" && !latestTurnSettled);
  const handleRetryThreadDetailSync = useCallback(() => {
    useStore.getState().clearThreadDetailSyncFailure(threadId);
    const api = readNativeApi();
    void api?.orchestration
      .subscribeThread(buildThreadSubscribeInput(threadId))
      .catch(() => undefined);
  }, [threadId]);
  // Stable identity: this element is forwarded to the memoized MessagesTimeline, so
  // building it inline in JSX would defeat its `memo()` on every keystroke.
  const transcriptEmptyStateContent = useMemo((): ReactNode => {
    if (isEditorRail) {
      return <span aria-hidden="true" />;
    }
    if (threadDetailHydration !== "ready") {
      return (
        <ThreadDetailHydrationState
          onRetry={handleRetryThreadDetailSync}
          state={threadDetailHydration}
        />
      );
    }
    return hasPendingThreadWork ? <span aria-hidden="true" /> : undefined;
  }, [handleRetryThreadDetailSync, hasPendingThreadWork, isEditorRail, threadDetailHydration]);
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Home-scoped chats get the global "What should we work on?" copy plus the project picker,
  // while project-scoped drafts reuse the same centered layout with folder-specific copy.
  const isCenteredEmptyLanding =
    timelineEntries.length === 0 &&
    !hasPendingThreadWork &&
    !activeThread?.parentThreadId &&
    !isEditorRail &&
    threadDetailHydration === "ready";
  const isEmptyChatLanding =
    isCenteredEmptyLanding && Boolean(homeDir) && isContainerLandingProject;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const messagesForDiffAnchoring: {
      id: MessageId;
      role: "user" | "assistant" | "system";
      turnId: TurnId | null;
    }[] = [];
    for (const message of timelineMessages) {
      messagesForDiffAnchoring.push({
        id: message.id,
        role: message.role,
        turnId: message.turnId ?? null,
      });
    }
    return buildTurnDiffSummaryByAssistantMessageId({
      turnDiffSummaries: turnDiffSummaries.map((summary) => ({
        ...summary,
        checkpointTurnCount:
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
      })),
      messages: messagesForDiffAnchoring,
    });
  }, [inferredCheckpointTurnCountByTurnId, turnDiffSummaries, timelineMessages]);
  const revertTurnCountByUserMessageId = useMemo(() => {
    const byUserMessageId = new Map<MessageId, number>();
    for (let index = 0; index < timelineEntries.length; index += 1) {
      const entry = timelineEntries[index];
      if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
        continue;
      }

      for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
        const nextEntry = timelineEntries[nextIndex];
        if (!nextEntry || nextEntry.kind !== "message") {
          continue;
        }
        if (nextEntry.message.role === "user") {
          break;
        }
        const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
        if (!summary) {
          continue;
        }
        const turnCount =
          summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
        if (typeof turnCount !== "number") {
          break;
        }
        byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
        break;
      }
    }

    return byUserMessageId;
  }, [inferredCheckpointTurnCountByTurnId, timelineEntries, turnDiffSummaryByAssistantMessageId]);

  const threadWorkspaceCwd = activeProject
    ? resolveSharedThreadWorkspaceCwd({
        projectCwd: activeProject.cwd,
        envMode: resolvedThreadEnvMode,
        worktreePath: resolvedThreadWorktreePath,
        workingDirectory: resolvedThreadWorkingDirectory,
      })
    : null;
  const threadArtifactWorkspaceRoot = resolveThreadArtifactWorkspaceRoot({
    isStudioContainer,
    projectCwd: activeProject?.cwd ?? null,
    threadWorkspaceCwd,
  });
  const gitCwd = threadWorkspaceCwd;
  const gitBranchSourceCwd = isStudioContainer
    ? threadWorkspaceCwd
    : activeProject
      ? resolveThreadBranchSourceCwd({
          projectCwd: activeProject.cwd,
          worktreePath: resolvedThreadWorktreePath,
        })
      : null;

  const branchesQuery = useQuery(gitBranchesQueryOptions(gitBranchSourceCwd));
  const gitStatusQuery = useQuery(gitStatusQueryOptions(gitBranchSourceCwd));
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacNavigatorPlatform(),
  );
  const {
    mentionTriggerQuery,
    isLocalFolderBrowserOpen,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    effectiveComposerTrigger,
    effectiveComposerTriggerKind,
    supportsTextNativeReviewCommand,
    isComposerMenuLoading,
    canCompactThread,
  } = useComposerDiscovery({
    threadId,
    selectedProvider,
    composerTrigger,
    composerCommandPicker,
    providerModelDiscoveryCwd,
    providerOptionsForDispatch,
    gitCwd,
    piAgentDir: settings.piAgentDir,
  });
  const activeRootBranch = useMemo(
    () =>
      resolveComposerSlashRootBranch({
        branches: branchesQuery.data?.branches,
        activeProjectCwd: activeProject?.cwd,
        activeThreadBranch: activeThread?.branch,
      }),
    [activeProject?.cwd, activeThread?.branch, branchesQuery.data?.branches],
  );
  const currentActiveGitBranch = useMemo(() => {
    if (gitStatusQuery.data !== undefined) {
      return gitStatusQuery.data.branch;
    }

    return (
      branchesQuery.data?.branches.find(
        (branch) =>
          branch.current === true &&
          (branch.worktreePath === null ||
            branch.worktreePath === undefined ||
            branch.worktreePath === activeProject?.cwd),
      )?.name ?? null
    );
  }, [activeProject?.cwd, branchesQuery.data?.branches, gitStatusQuery.data]);
  const settledThreadBranchMismatch = resolveSettledThreadBranchMismatch({
    isSettled:
      activeThread?.settledAt != null &&
      settledThreadBranchWarningDismissedThreadId !== activeThread.id,
    isLocalWorkspace: !isStudioContainer && resolvedThreadWorktreePath === null,
    threadBranch: settledThreadBranchAtActivation,
    currentBranch: currentActiveGitBranch,
  });

  const selectedModelCaps = useMemo(
    () => getModelCapabilities(selectedProvider, selectedModel),
    [selectedModel, selectedProvider],
  );
  const supportsFastSlashCommand = selectedModelCaps.supportsFastMode;
  const currentProviderModelOptions = composerModelOptions?.[selectedProvider];
  const fastModeEnabled =
    supportsFastSlashCommand &&
    (currentProviderModelOptions as { fastMode?: boolean } | undefined)?.fastMode === true;
  const composerPromptWithoutActiveSlashTrigger =
    composerTrigger?.kind === "slash-command"
      ? stripComposerTriggerText(prompt, composerTrigger)
      : prompt;
  const canOfferReviewCommand =
    (branchesQuery.data?.isRepo ?? true) &&
    canOfferReviewSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
    });
  const canOfferForkCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferForkSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
      interactionMode,
    });
  const sideSlashCommandContext = {
    imageCount: composerImages.length,
    terminalContextCount: composerTerminalContexts.length,
    selectedSkillCount: selectedComposerSkills.length,
    selectedMentionCount: selectedComposerMentions.length,
    interactionMode,
    isSidechat: Boolean(activeThread?.sidechatSourceThreadId),
  } as const;
  const canExecuteSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canExecuteSideSlashCommand(sideSlashCommandContext);
  const canOfferSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferSideSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      ...sideSlashCommandContext,
    });
  // Export is hidden while the thread is running so archives cannot capture a
  // partial assistant response. Same shared predicate as the server's 409
  // guard, so the composer and the export route cannot drift.
  const canOfferExportCommand =
    isServerThread &&
    activeThread !== undefined &&
    threadExportBlockedReason(activeThread) === null;
  const normalComposerMenuItems = useComposerCommandMenuItems({
    composerTrigger: effectiveComposerTrigger,
    provider: selectedProvider,
    providerPlugins,
    providerNativeCommands,
    providerSkills,
    workspaceEntries,
    searchableModelOptions,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      canCompactThread &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    canOfferExportCommand,
    dynamicAgents,
    threadMentionSources: {
      threads: composerThreadSummaries,
      projects: composerThreadProjects,
      currentThreadId: threadId,
    },
  });
  const composerMenuItems = useMemo(() => {
    if (composerCommandPicker === "fork-target") {
      return [
        {
          id: "fork-target:worktree",
          type: "fork-target" as const,
          target: "worktree" as const,
          label: "Fork Into New Worktree",
          description: "Continue in a new worktree",
        },
        {
          id: "fork-target:local",
          type: "fork-target" as const,
          target: "local" as const,
          label: "Fork Into Local",
          description:
            activeThread?.worktreePath || activeThread?.envMode === "worktree"
              ? "Continue in this local worktree"
              : "Continue in the current local thread",
        },
      ];
    }
    if (composerCommandPicker === "review-target") {
      return [
        {
          id: "review-target:changes",
          type: "review-target" as const,
          target: "changes" as const,
          label: "Review Uncommitted Changes",
          description: "Review local uncommitted changes",
        },
        {
          id: "review-target:base-branch",
          type: "review-target" as const,
          target: "base-branch" as const,
          label: "Review Against Base Branch",
          description: "Review the current branch diff against its base",
        },
      ];
    }

    return normalComposerMenuItems;
  }, [
    activeThread?.envMode,
    activeThread?.worktreePath,
    composerCommandPicker,
    normalComposerMenuItems,
  ]);
  const composerMenuOpen = Boolean(composerTrigger || composerCommandPicker);
  // The `+` panel yields the floating slot to the slash/mention menu as soon as a
  // trigger is typed, so the two can never render over each other.
  const composerExtrasPanelOpen = isComposerExtrasPanelOpen && !composerMenuOpen;
  const composerOverlayOpen = composerMenuOpen || composerExtrasPanelOpen;
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  // Keydown can fire as soon as the updated menu commits, before passive effects.
  useLayoutEffect(() => {
    composerMenuOpenRef.current = composerMenuOpen;
    composerMenuItemsRef.current = composerMenuItems;
    activeComposerMenuItemRef.current = activeComposerMenuItem;
  }, [
    composerMenuOpenRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    composerMenuOpen,
    composerMenuItems,
    activeComposerMenuItem,
  ]);
  const nonPersistedComposerImageIdSet = useMemo(() => {
    const durableBlobIds = new Set(
      durablyPersistedComposerImageIds
        .filter((attachment) => Boolean(attachment.blobKey))
        .map((attachment) => attachment.id),
    );
    return new Set(nonPersistedComposerImageIds.filter((id) => !durableBlobIds.has(id)));
  }, [durablyPersistedComposerImageIds, nonPersistedComposerImageIds]);
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const { rememberCustomBinaryPathForDispatch, providerStatuses } = useChatProviderStatus({
    activeThread,
    settings,
    configuredProviderStatuses: serverConfigQuery.data?.providers,
  });
  const handoffBadgeLabel = useMemo(
    () => (activeThread ? resolveThreadHandoffBadgeLabel(activeThread) : null),
    [activeThread],
  );
  const handoffBadgeSourceProvider = activeThread?.handoff?.sourceProvider ?? null;
  const handoffBadgeTargetProvider = activeThread?.handoff
    ? activeThread.modelSelection.provider
    : null;
  const handoffTargetProviders = useMemo(
    () =>
      activeThread
        ? resolveAvailableHandoffTargetProviders({
            sourceProvider: activeThread.modelSelection.provider,
            providerSettings: serverSettingsQuery.data?.providers,
            providerStatuses,
          })
        : [],
    [activeThread, providerStatuses, serverSettingsQuery.data?.providers],
  );
  const handoffActionLabel = activeThread ? "Hand off thread" : "Create handoff thread";
  const activeProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, selectedProvider),
    [selectedProvider, providerStatuses],
  );
  const activeProviderHealthBannerDismissalKey = useMemo(
    () => getProviderHealthBannerDismissalKey(activeProviderStatus),
    [activeProviderStatus],
  );
  const visibleActiveProviderStatus =
    activeProviderHealthBannerDismissalKey &&
    dismissedProviderHealthBannerKeys.includes(activeProviderHealthBannerDismissalKey)
      ? null
      : activeProviderStatus;
  const voiceProviderStatus = useMemo(
    () => findProviderStatus(providerStatuses, "codex"),
    [providerStatuses],
  );
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = isStudioContainer ? null : (activeThread?.worktreePath ?? null);
  const hasNativeUserMessages = useMemo(
    () =>
      activeThread?.messages.some(
        (message) => message.role === "user" && message.source === "native",
      ) ?? false,
    [activeThread?.messages],
  );
  // Left to React Compiler instead of a manual `useMemo`: the hand-written dep array could
  // not be preserved (the compiler cannot prove `threadWorkspaceCwd` is never mutated), which
  // bailed the whole component out of compilation. The empty case returns a module-level
  // constant so its identity is stable no matter how the value is memoized.
  const terminalRuntimeProjectCwd = isStudioContainer ? threadWorkspaceCwd : activeProjectCwd;
  const threadTerminalRuntimeEnv = terminalRuntimeProjectCwd
    ? projectScriptRuntimeEnv({
        project: {
          cwd: terminalRuntimeProjectCwd,
        },
        worktreePath: activeThreadWorktreePath,
      })
    : EMPTY_TERMINAL_RUNTIME_ENV;
  const isGitRepo = resolveGitRepoUiState({
    isStudioContainer,
    queriedIsRepo: branchesQuery.data?.isRepo,
  });
  // Studio never offers "Initialize Git": its reference folder is ordinary cwd context,
  // so Git actions appear only when that selected folder is already a repository.
  const showGitActions = isStudioContainer
    ? Boolean(resolvedThreadWorkingDirectory) && isGitRepo
    : !isContainerLandingProject || Boolean(resolvedThreadWorktreePath);
  const repoDiffTotals = useRepoDiffTotals({
    gitCwd: threadWorkspaceCwd,
    isGitRepo,
    refetchInterval: repoDiffBadgeRefreshIntervalMs,
  });
  // The composer live strip is turn-scoped; repoDiffTotals can include unrelated
  // local edits that existed before the active agent turn started.
  const activeTurnLiveDiffState = useMemo(
    () =>
      resolveActiveTurnLiveDiffState({
        latestTurnId: activeLatestTurn?.turnId ?? null,
        turnDiffSummaries,
        workLogEntries,
      }),
    [activeLatestTurn?.turnId, turnDiffSummaries, workLogEntries],
  );
  const splitTerminalShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "terminal.splitRight") ??
      shortcutLabelForCommand(keybindings, "terminal.split"),
    [keybindings],
  );
  const splitTerminalDownShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.splitDown"),
    [keybindings],
  );
  const newTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.new"),
    [keybindings],
  );
  const closeTerminalShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.close"),
    [keybindings],
  );
  const closeWorkspaceShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.workspace.closeActive"),
    [keybindings],
  );
  const diffPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "diff.toggle"),
    [keybindings],
  );
  const chatSplitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.split"),
    [keybindings],
  );
  const modelPickerShortcutLabel = useMemo(
    () =>
      shortcutLabelForCommand(keybindings, "modelPicker.toggle") ??
      formatShortcutLabel({
        key: "m",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [keybindings],
  );
  const traitsPickerShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "traitsPicker.toggle"),
    [keybindings],
  );
  const onToggleDiff = useCallback(() => {
    if (diffEnvironmentPending && !diffOpen) {
      return;
    }
    if (onToggleDiffPanel) {
      onToggleDiffPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return diffOpen
          ? { ...rest, panel: undefined, diff: undefined }
          : { ...rest, panel: "diff", diff: "1" };
      },
    });
  }, [diffEnvironmentPending, diffOpen, navigate, onToggleDiffPanel, threadId]);
  const onToggleBrowser = useCallback(() => {
    if (onToggleBrowserPanel) {
      onToggleBrowserPanel();
      return;
    }
    void navigate({
      to: "/$threadId",
      params: { threadId },
      replace: true,
      search: (previous) => {
        const rest = stripDiffSearchParams(previous);
        return browserOpen ? { ...rest, panel: undefined } : { ...rest, panel: "browser" };
      },
    });
  }, [browserOpen, navigate, onToggleBrowserPanel, threadId]);
  const openBrowserUrl = useCallback(
    (url: string) => {
      const api = readNativeApi();
      void api?.browser.open({ threadId, initialUrl: url }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not open repository",
          description:
            error instanceof Error ? error.message : "The in-app browser could not open GitHub.",
        });
      });
      if (onOpenBrowserUrl) {
        onOpenBrowserUrl(url);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        replace: true,
        search: (previous) => ({
          ...stripDiffSearchParams(previous),
          panel: "browser",
        }),
      });
    },
    [navigate, onOpenBrowserUrl, threadId],
  );

  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "closed")),
  );
  const isTerminalPrimarySurface = terminalState.entryPoint === "terminal";
  const isTerminalEnvironmentContext =
    isTerminalPrimarySurface || terminalWorkspaceTerminalTabActive;
  const shouldShowProviderHealthBanner = shouldRenderProviderHealthBanner({
    threadEntryPoint: terminalState.entryPoint,
    terminalWorkspaceTerminalTabActive,
  });
  // Terminal-only threads should not pay to mount the hidden chat/composer pane.
  const shouldRenderChatPaneContent = !(
    terminalWorkspaceTerminalTabActive && terminalState.workspaceLayout === "terminal-only"
  );
  const secondaryChromeThreadId = activeThread?.id ?? threadId;
  const shouldDeferSecondaryChrome =
    activeThread !== undefined && !isCenteredEmptyLanding && !terminalWorkspaceTerminalTabActive;
  const [secondaryChromeState, setSecondaryChromeState] = useState(() => ({
    threadId: secondaryChromeThreadId,
    ready: true,
  }));
  const secondaryChromeReady =
    !shouldDeferSecondaryChrome ||
    (secondaryChromeState.threadId === secondaryChromeThreadId && secondaryChromeState.ready);

  useEffect(() => {
    if (!shouldDeferSecondaryChrome) {
      setSecondaryChromeState((current) =>
        current.threadId === secondaryChromeThreadId && current.ready
          ? current
          : { threadId: secondaryChromeThreadId, ready: true },
      );
      return;
    }

    setSecondaryChromeState({
      threadId: secondaryChromeThreadId,
      ready: false,
    });
    const frame = window.requestAnimationFrame(() => {
      setSecondaryChromeState({
        threadId: secondaryChromeThreadId,
        ready: true,
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [setSecondaryChromeState, secondaryChromeThreadId, shouldDeferSecondaryChrome]);
  const setThreadError = useCallback(
    (targetThreadId: ThreadId | null, error: string | null) => {
      if (!targetThreadId) return;
      if (getThreadFromState(useStore.getState(), targetThreadId)) {
        setStoreThreadError(targetThreadId, error);
        return;
      }
      setLocalDraftErrorsByThreadId((existing) => {
        if ((existing[targetThreadId] ?? null) === error) {
          return existing;
        }
        return {
          ...existing,
          [targetThreadId]: error,
        };
      });
    },
    [setLocalDraftErrorsByThreadId, setStoreThreadError],
  );
  const composerImageAttachmentCount = useCallback(
    () =>
      effectiveComposerAttachmentCount(useComposerDraftStore.getState().draftsByThreadId[threadId]),
    [threadId],
  );
  const commitPreparedComposerImages = useCallback(
    (images: ComposerImageAttachment[]) => addComposerImagesToDraft(images),
    [addComposerImagesToDraft],
  );
  const setComposerImagePreparationError = useCallback(
    (error: string | null) => setThreadError(threadId, error),
    [setThreadError, threadId],
  );
  const {
    addImages: enqueueComposerImages,
    isPreparingImages: isPreparingComposerImages,
    pendingImageCount: pendingComposerImageCount,
    waitForPending: waitForPendingComposerImages,
  } = useComposerImageIntake({
    threadId,
    existingAttachmentCount: composerImageAttachmentCount,
    commitImages: commitPreparedComposerImages,
    onError: setComposerImagePreparationError,
  });

  const focusComposer = useCallback(() => {
    // Secondary chrome is deferred during thread switches; replay focus once it
    // mounts. A disabled editor (dispatch connecting, pending approval) cannot
    // take focus either, so keep the request pending until it re-enables.
    const editor = composerEditorRef.current;
    if (!secondaryChromeReady || !editor || isComposerEditorDisabled) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
    editor.focusAtEnd();
  }, [composerEditorRef, pendingComposerFocusRef, secondaryChromeReady, isComposerEditorDisabled]);
  const toggleComposerFocus = useCallback(() => {
    const editor = composerEditorRef.current;
    if (secondaryChromeReady && editor?.isFocused()) {
      pendingComposerFocusRef.current = false;
      editor.blur();
      return;
    }
    focusComposer();
  }, [composerEditorRef, pendingComposerFocusRef, focusComposer, secondaryChromeReady]);
  const scheduleComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [pendingComposerFocusRef, focusComposer]);
  // External panels (diff headers, file explorer, preview) bump this nonce after
  // inserting a reference so the composer visibly receives the text.
  const composerFocusRequestNonce = useComposerFocusRequestStore(
    (store) => store.requestsByThreadId[threadId] ?? 0,
  );
  useEffect(() => {
    if (composerFocusRequestNonce > 0) {
      scheduleComposerFocus();
    }
  }, [composerFocusRequestNonce, scheduleComposerFocus]);
  useEffect(() => {
    if (!secondaryChromeReady || !pendingComposerFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pendingComposerFocusRef, focusComposer, secondaryChromeReady, secondaryChromeThreadId]);
  // Keep the two composer picker menus mutually exclusive so shortcuts always open one surface.
  const handleModelPickerOpenChange = useCallback(
    (open: boolean) => {
      setIsModelPickerOpen(open);
      if (open) {
        setIsTraitsPickerOpen(false);
      }
    },
    [setIsModelPickerOpen, setIsTraitsPickerOpen],
  );
  const handleTraitsPickerOpenChange = useCallback(
    (open: boolean) => {
      setIsTraitsPickerOpen(open);
      if (open) {
        setIsModelPickerOpen(false);
      }
    },
    [setIsModelPickerOpen, setIsTraitsPickerOpen],
  );
  const appendVoiceTranscriptToComposer = useCallback(
    (transcript: string) => {
      const nextPrompt = appendVoiceTranscriptToPrompt(promptRef.current, transcript);
      if (!nextPrompt) {
        return;
      }

      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [promptRef, setComposerCursor, setComposerTrigger, scheduleComposerFocus, setPrompt],
  );
  const {
    isVoiceRecording,
    isVoiceTranscribing,
    voiceWaveformLevels,
    voiceRecordingDurationLabel,
    showVoiceNotesControl,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
    cancelComposerVoiceRecording,
  } = useComposerVoiceController({
    activeProject,
    activeThreadId: activeThread?.id ?? null,
    threadId,
    selectedProvider,
    activeProviderStatus: voiceProviderStatus,
    pendingUserInputCount: pendingUserInputs.length,
    onTranscriptReady: appendVoiceTranscriptToComposer,
    refreshVoiceStatus: refreshProviderStatuses,
    actionArmDelayMs: VOICE_RECORDER_ACTION_ARM_DELAY_MS,
    failureCopy: {
      transcriptionFailedTitle: "Couldn't transcribe voice note",
    },
    onGuardWarning: warnVoiceGuard,
  });
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThreadId) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
        selectionCollapsed: true,
        terminalContextIds: composerTerminalContexts.map((context) => context.id),
      };
      const insertion = insertInlineTerminalContextPlaceholder(
        snapshot.value,
        snapshot.expandedCursor,
      );
      const nextCollapsedCursor = collapseExpandedComposerCursor(
        insertion.prompt,
        insertion.cursor,
      );
      const inserted = insertComposerDraftTerminalContext(
        activeThreadId,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThreadId,
          createdAt: new Date().toISOString(),
          ...selection,
        },
        insertion.contextIndex,
      );
      if (!inserted) {
        return;
      }
      promptRef.current = insertion.prompt;
      setComposerCursor(nextCollapsedCursor);
      setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCollapsedCursor);
      });
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      composerEditorRef,
      activeThreadId,
      composerCursor,
      composerTerminalContexts,
      discardPromptHistoryNavigationForComposerMutation,
      insertComposerDraftTerminalContext,
    ],
  );
  // Terminal-only workspaces intentionally have no mounted composer. Do not
  // publish a global-looking action with nowhere to insert the selection.
  const canAddTerminalContextToChat = activeThread !== undefined && shouldRenderChatPaneContent;
  // Keep the published capability stable while cursor and draft state change;
  // dock terminals should not rerender for ordinary composer edits.
  const addTerminalContextToDraftRef = useRef(addTerminalContextToDraft);
  useLayoutEffect(() => {
    addTerminalContextToDraftRef.current = addTerminalContextToDraft;
  }, [addTerminalContextToDraftRef, addTerminalContextToDraft]);
  const addRegisteredTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      addTerminalContextToDraftRef.current(selection);
    },
    [addTerminalContextToDraftRef],
  );
  useLayoutEffect(() => {
    if (!canAddTerminalContextToChat) {
      return;
    }
    return registerTerminalContextComposerTarget(paneScopeId, addRegisteredTerminalContextToDraft);
  }, [addRegisteredTerminalContextToDraft, canAddTerminalContextToChat, paneScopeId]);
  // Collapse an oversized paste into an attachment card above the composer instead
  // of flooding the editor with raw text. The card holds the full content until the
  // user sends or clicks "Show in text field".
  const addPastedTextToDraft = useCallback(
    (text: string) => {
      if (!activeThread) {
        return;
      }
      discardPromptHistoryNavigationForComposerMutation();
      addComposerDraftPastedTexts(activeThread.id, [
        createPastedTextDraft({
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          text,
        }),
      ]);
    },
    [activeThread, addComposerDraftPastedTexts, discardPromptHistoryNavigationForComposerMutation],
  );
  // The terminal's panel toggle mirrors the right dock's collapse control: it shows
  // or hides the side panel only when this thread already has a pane to show.
  const rightDockOpen = useRightDockStore((store) => selectRightDockState(threadId)(store).open);
  const isMobileViewport = useIsMobile();
  // Temporary threads are visually identical to regular chats — they use the same
  // Environment panel + header controls. "Temporary" is purely a sidebar badge +
  // auto-delete-on-leave concern, never a stripped-down chat UI.
  const environmentEnabled = !isEditorRail && !hideHeader;
  const environmentUsesFloatingOverlay =
    isTerminalEnvironmentContext || isMobileViewport || rightDockOpen || surfaceMode === "split";
  const environmentDefaultOpen = resolveDefaultEnvironmentPanelOpen({
    environmentEnabled,
    isCenteredEmptyLanding,
    isTerminalPrimarySurface,
    isConstrainedChatLayout: environmentUsesFloatingOverlay,
    settingsDefaultOpen: settings.environmentPanelDefaultOpen,
  });
  // Every close (header toggle or panel action click) stores the cross-chat preference,
  // so a dismissed panel stays closed when switching threads until it is toggled back on.
  // The same toggle also persists to settings so the preference survives reloads.
  const [environmentPanelPreferenceOpen, setEnvironmentPanelPreferenceOpen] = useState<
    boolean | null
  >(null);
  const updateEnvironmentPanelPreference = useCallback(
    (open: boolean, persist: boolean) => {
      const update = resolveEnvironmentPanelPreferenceUpdate({ open, persist });
      setEnvironmentPanelPreferenceOpen(update.userPreferenceOpen);
      if (update.settingsDefaultOpen !== null) {
        updateSettings({ environmentPanelDefaultOpen: update.settingsDefaultOpen });
      }
    },
    // The state setter is stable, so listing it changes nothing at runtime — but React
    // Compiler infers it as a dependency here and refuses to compile the component when the
    // hand-written array omits it.
    [setEnvironmentPanelPreferenceOpen, updateSettings],
  );
  const setEnvironmentPanelOpenPreference = useCallback(
    (open: boolean) => updateEnvironmentPanelPreference(open, true),
    [updateEnvironmentPanelPreference],
  );
  const closeEnvironmentPanelAfterAction = useCallback(
    () => updateEnvironmentPanelPreference(false, false),
    [updateEnvironmentPanelPreference],
  );
  const environmentPanelOpen = resolveEnvironmentPanelOpen({
    defaultOpen: environmentDefaultOpen,
    userPreferenceOpen: environmentPanelPreferenceOpen,
  });
  const environmentPanelVisible = resolveEnvironmentPanelVisible({
    environmentEnabled,
    environmentPanelOpen,
  });
  const githubRepositoryQuery = useQuery(
    gitGithubRepositoryQueryOptions(gitBranchSourceCwd, environmentPanelVisible),
  );
  const threadRecap = useThreadRecap({
    thread: activeThread,
    cwd: threadWorkspaceCwd,
    enabled: environmentPanelVisible,
    latestTurnSettled,
    codexHomePath: settings.codexHomePath || null,
    providerOptions: providerOptionsForDispatch ?? null,
  });
  const hasRightDockPanes = useRightDockStore(
    (store) => selectRightDockState(threadId)(store).panes.length > 0,
  );
  const setRightDockOpen = useRightDockStore((store) => store.setDockOpen);
  const toggleRightDock = useCallback(() => {
    setRightDockOpen(threadId, !rightDockOpen);
  }, [rightDockOpen, setRightDockOpen, threadId]);
  const terminalDrawerProps = {
    threadId,
    onTogglePanel: hasRightDockPanes ? toggleRightDock : undefined,
    isPanelOpen: hasRightDockPanes ? rightDockOpen : undefined,
    cwd: gitCwd ?? activeProject?.cwd ?? "",
    runtimeEnv: threadTerminalRuntimeEnv,
    height: terminalState.terminalHeight,
    terminalIds: terminalState.terminalIds,
    terminalLabelsById: terminalState.terminalLabelsById,
    terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
    terminalCliKindsById: terminalState.terminalCliKindsById,
    terminalAttentionStatesById: terminalState.terminalAttentionStatesById ?? {},
    runningTerminalIds: terminalState.runningTerminalIds,
    activeTerminalId: terminalState.activeTerminalId,
    terminalGroups: terminalState.terminalGroups,
    activeTerminalGroupId: terminalState.activeTerminalGroupId,
    focusRequestId: terminalFocusRequestId,
    onSplitTerminal: splitTerminalRight,
    onSplitTerminalDown: splitTerminalDown,
    onNewTerminal: createNewTerminal,
    onNewTerminalTab: createNewTerminalTab,
    onMoveTerminalToGroup: moveTerminalToNewGroup,
    splitShortcutLabel: splitTerminalShortcutLabel ?? undefined,
    splitDownShortcutLabel: splitTerminalDownShortcutLabel ?? undefined,
    newShortcutLabel: newTerminalShortcutLabel ?? undefined,
    closeShortcutLabel: closeTerminalShortcutLabel ?? undefined,
    workspaceCloseShortcutLabel: closeWorkspaceShortcutLabel ?? undefined,
    onActiveTerminalChange: activateTerminal,
    onCloseTerminal: closeTerminal,
    onTerminalSessionExited: handleTerminalSessionExited,
    onCloseTerminalGroup: (groupId: string) => {
      if (!activeThreadId) return;
      storeCloseTerminalGroup(activeThreadId, groupId);
    },
    onHeightChange: setTerminalHeight,
    onResizeTerminalSplit: (groupId: string, splitId: string, weights: number[]) => {
      if (!activeThreadId) return;
      storeResizeTerminalSplit(activeThreadId, groupId, splitId, weights);
    },
    onTerminalMetadataChange: (
      terminalId: string,
      metadata: {
        cliKind: "codex" | "claude" | "antigravity" | null;
        label: string;
      },
    ) => {
      if (!activeThreadId) return;
      storeSetTerminalMetadata(activeThreadId, terminalId, metadata);
    },
    onTerminalActivityChange: (
      terminalId: string,
      activity: {
        hasRunningSubprocess: boolean;
        agentState: "running" | "attention" | "review" | null;
      },
    ) => {
      if (!activeThreadId) return;
      storeSetTerminalActivity(activeThreadId, terminalId, activity);
    },
    ...(canAddTerminalContextToChat ? { onAddTerminalContext: addTerminalContextToDraft } : {}),
  };
  const {
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
    lastInvokedScriptByProjectId,
  } = useChatProjectScripts({
    activeThreadId,
    activeThread,
    activeProject,
    gitCwd,
    isStudioContainer,
    terminalState,
    requestTerminalFocus,
    setTerminalOpen,
    setThreadError,
  });
  const stopActiveThreadSession = useCallback(async () => {
    const api = readNativeApi();
    if (
      !api ||
      !isServerThread ||
      !activeThread ||
      activeThread.session === null ||
      activeThread.session.status === "closed"
    ) {
      return;
    }

    await api.orchestration.dispatchCommand({
      type: "thread.session.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, isServerThread]);
  const {
    handoffBusy,
    worktreeHandoffDialogOpen,
    setWorktreeHandoffDialogOpen,
    worktreeHandoffName,
    setWorktreeHandoffName,
    onHandoffToWorktree,
    onHandoffToLocal,
    confirmWorktreeHandoff,
  } = useThreadWorkspaceHandoff({
    activeProject,
    activeThread,
    activeRootBranch,
    activeThreadAssociatedWorktree,
    isServerThread,
    stopActiveThreadSession,
    runProjectScript,
  });

  const {
    persistRuntimeModeChange,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    toggleInteractionMode,
    resetInteractionMode,
    persistThreadSettingsForNextTurn,
  } = useChatRuntimeModes({
    threadId,
    activeThread,
    serverThread,
    isLocalDraftThread,
    runtimeMode,
    interactionMode,
    selectedProvider,
    selectedRuntimeModel,
    selectedModelSelection,
    activeProviderStatus,
    scheduleComposerFocus,
  });
  const togglePlanSidebar = useCallback(() => {
    setPlanSidebarOpen((open) => {
      if (open) {
        planSidebarDismissedForTurnRef.current =
          activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [
    setPlanSidebarOpen,
    planSidebarDismissedForTurnRef,
    activeTaskList?.turnId,
    sidebarProposedPlan?.turnId,
  ]);

  const {
    showScrollToBottom,
    isUserScrollDetached,
    tailAnchorScrollInFlightRef,
    armTranscriptAutoFollow,
    onTranscriptNavigate,
    onIsAtEndChange,
    onScrollToBottom,
    onMessagesClickCaptureBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesPointerCancelBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  } = useChatTranscriptScroll({
    activeThreadId,
    legendListRef,
    timelineEntries,
    hasStreamingAssistantText,
    composerTranscriptInsetPx,
    isInactiveSplitPane,
  });
  const selectionChatEnvMode = useProjectEnvironmentStore((state) =>
    activeProject ? state.envModeByProjectId[activeProject.id] : undefined,
  );
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
    dismissTranscriptSelectionAction,
    onMessagesClickCapture,
    onMessagesMouseUp,
    onMessagesPointerCancel,
    onMessagesPointerDown,
    onMessagesPointerUp,
    onMessagesScroll,
    onMessagesTouchEnd,
    onMessagesTouchMove,
    onMessagesTouchStart,
    onMessagesWheel,
  } = useTranscriptAssistantSelectionAction({
    threadId,
    enabled:
      Boolean(activeThread) &&
      !isInactiveSplitPane &&
      !isSidechatExpired &&
      pendingUserInputs.length === 0 &&
      !isComposerApprovalState,
    composerImagesRef,
    composerFilesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
    canReferenceAssistantSelection: (selection) =>
      !isPendingSetupBubbleId(MessageId.makeUnsafe(selection.assistantMessageId)),
    scheduleComposerFocus,
    onMessagesClickCaptureBase,
    onMessagesPointerCancelBase,
    onMessagesPointerDownBase,
    onMessagesPointerUpBase,
    onMessagesScrollBase,
    onMessagesTouchEndBase,
    onMessagesTouchMoveBase,
    onMessagesTouchStartBase,
    onMessagesWheelBase,
  });

  useLayoutEffect(() => {
    if (isInactiveSplitPane) return;
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const syncComposerFooterLayout = () => {
      const composerFormWidth = measureComposerFormWidth();
      const nextCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));
      // Tier the footer controls by MEASURED overflow: demote one step while
      // the footer row's content is wider than the row, promote back (with
      // hysteresis) when the recorded overflow width is comfortably exceeded.
      const footerRow = composerForm.querySelector<HTMLElement>("[data-chat-composer-footer]");
      if (footerRow) {
        const rowOverflows = footerRow.scrollWidth > footerRow.clientWidth + 1;
        // The leading cluster clips (overflow-hidden) in compact mode instead
        // of growing the row's scrollWidth, so check it directly — a clipped
        // "+"/access-rules cluster must also demote the tier.
        const leadingCluster = footerRow.querySelector<HTMLElement>("[data-chat-composer-leading]");
        const leadingClips =
          nextCompact &&
          leadingCluster !== null &&
          leadingCluster.scrollWidth > leadingCluster.clientWidth + 1;
        const nextStep = resolveNextComposerFooterTier({
          currentTier: composerFooterTierRef.current,
          clientWidth: footerRow.clientWidth,
          isOverflowing: rowOverflows || leadingClips,
          demotionWidths: composerFooterDemotionWidthsRef.current,
        });
        composerFooterDemotionWidthsRef.current = nextStep.demotionWidths;
        if (nextStep.tier !== composerFooterTierRef.current) {
          composerFooterTierRef.current = nextStep.tier;
          setComposerFooterTier(nextStep.tier);
        }
      }
    };
    composerFooterLayoutSyncRef.current = syncComposerFooterLayout;

    const measuredHeight = Math.ceil(composerForm.getBoundingClientRect().height);
    composerFormHeightRef.current = measuredHeight;
    if (measuredHeight > 0) {
      setSecondaryChromePlaceholderHeight((current) =>
        current === measuredHeight ? current : measuredHeight,
      );
    }
    syncComposerFooterLayout();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      syncComposerFooterLayout();

      const nextHeight = entry.contentRect.height;
      composerFormHeightRef.current = nextHeight;
      const roundedNextHeight = Math.ceil(nextHeight);
      if (roundedNextHeight > 0) {
        setSecondaryChromePlaceholderHeight((current) =>
          current === roundedNextHeight ? current : roundedNextHeight,
        );
      }
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [
    setIsComposerFooterCompact,
    setComposerFooterTier,
    composerFooterTierRef,
    composerFooterDemotionWidthsRef,
    composerFooterLayoutSyncRef,
    setSecondaryChromePlaceholderHeight,
    composerFormRef,
    composerFormHeightRef,
    activeThread?.id,
    composerFooterHasWideActions,
    isInactiveSplitPane,
  ]);

  useEffect(() => {
    // Capture the carried sidebar-open intent synchronously (ref reads/writes stay
    // in render->commit order); defer only the setState so this thread-change reset
    // stays out of the render->effect->render cascade.
    const openPlanSidebar = planSidebarOpenOnNextThreadRef.current;
    planSidebarOpenOnNextThreadRef.current = false;
    planSidebarDismissedForTurnRef.current = null;
    const settle = window.setTimeout(() => {
      setPullRequestDialogState(null);
      setRenameDialogOpen(false);

      setPlanSidebarOpen(openPlanSidebar);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    setPlanSidebarOpen,
    planSidebarDismissedForTurnRef,
    planSidebarOpenOnNextThreadRef,
    setPullRequestDialogState,
    setRenameDialogOpen,
    activeThread?.id,
  ]);

  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      return;
    }
    setComposerHighlightedItemId((existing) =>
      existing && composerMenuItems.some((item) => item.id === existing)
        ? existing
        : (composerMenuItems[0]?.id ?? null),
    );
  }, [setComposerHighlightedItemId, composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade.
    const settle = window.setTimeout(() => {
      setIsRevertingCheckpoint(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [setIsRevertingCheckpoint, activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen || isInactiveSplitPane) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isInactiveSplitPane, terminalState.terminalOpen]);

  useLayoutEffect(() => {
    // ChatView stays mounted across thread switches, so clear thread-local overlays before paint.
    setExpandedImage(null);
  }, [setExpandedImage, threadId]);

  useEffect(() => {
    dragDepthRef.current = 0;
    // Async setState (post-paint) keeps this thread-change reset out of the
    // render->effect->render cascade. The expanded image and timeline hook's
    // optimistic messages clear before paint, so these residual resets can wait.
    const settle = window.setTimeout(() => {
      setLocalDispatch(null);
      setComposerHighlightedItemId(null);
      setComposerCursor(
        collapseExpandedComposerCursor(promptRef.current, promptRef.current.length),
      );
      setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
      setIsDragOverComposer(false);
    }, 0);
    return () => window.clearTimeout(settle);
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    setIsDragOverComposer,
    setComposerHighlightedItemId,
    dragDepthRef,
    setLocalDispatch,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, [setExpandedImage]);
  const navigateExpandedImage = useCallback(
    (direction: -1 | 1) => {
      setExpandedImage((existing) => {
        if (!existing || existing.images.length <= 1) {
          return existing;
        }
        const nextIndex =
          (existing.index + direction + existing.images.length) % existing.images.length;
        if (nextIndex === existing.index) {
          return existing;
        }
        return { ...existing, index: nextIndex };
      });
    },
    [setExpandedImage],
  );

  useEffect(() => {
    if (!expandedImage) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeExpandedImage, expandedImage, navigateExpandedImage]);

  useEffect(() => {
    if (!composerMenuOpen) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setComposerCommandPicker(null);
      setComposerHighlightedItemId(null);
      setComposerTrigger(null);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    setComposerTrigger,
    setComposerCommandPicker,
    setComposerHighlightedItemId,
    composerMenuOpen,
  ]);

  const activeWorktreePath = isStudioContainer ? null : activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = isStudioContainer
    ? "local"
    : isServerThread
      ? resolveThreadEnvironmentMode({
          envMode: activeThread?.envMode,
          worktreePath: activeWorktreePath ?? null,
        })
      : (draftThread?.envMode ?? "local");
  const envState = resolveThreadWorkspaceState({
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      requestTerminalFocus();
      return;
    } else if (previous && !current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      const frame = window.requestAnimationFrame(() => {
        focusComposer();
      });
      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    terminalOpenByThreadRef.current[activeThreadId] = current;
  }, [
    terminalOpenByThreadRef,
    activeThreadId,
    focusComposer,
    requestTerminalFocus,
    terminalState.terminalOpen,
  ]);

  useEffect(() => {
    if (!activeThreadId) {
      activatedThreadIdRef.current = null;
      return;
    }
    if (activatedThreadIdRef.current === activeThreadId) {
      return;
    }
    activatedThreadIdRef.current = activeThreadId;
    if (terminalState.entryPoint !== "terminal") {
      return;
    }
    storeOpenTerminalThreadPage(activeThreadId);
  }, [activatedThreadIdRef, activeThreadId, storeOpenTerminalThreadPage, terminalState.entryPoint]);

  useEffect(() => {
    if (!terminalWorkspaceOpen) {
      return;
    }

    if (terminalState.workspaceActiveTab === "terminal") {
      requestTerminalFocus();
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [
    focusComposer,
    requestTerminalFocus,
    terminalState.workspaceActiveTab,
    terminalWorkspaceOpen,
  ]);

  const onInterrupt = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread) return;
    await api.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: activeThread.id,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread]);

  // A rejected interrupt (orchestration dispatch timeout, dead runtime) leaves the
  // UI spinning with no explanation, so the stop affordances report it.
  const onInterruptFromStopControl = useCallback(() => {
    void onInterrupt().catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not stop the current response",
        description:
          error instanceof Error
            ? error.message
            : "The interrupt request failed. Try again in a moment.",
      });
    });
  }, [onInterrupt]);

  const onStopWorkflowRun = useCallback(async () => {
    const api = readNativeApi();
    if (!api || !activeThread || !workflowRunState) return;
    await api.orchestration.dispatchCommand({
      type: "thread.task.stop",
      commandId: newCommandId(),
      threadId: activeThread.id,
      taskId: workflowRunState.workflowTaskId,
      createdAt: new Date().toISOString(),
    });
  }, [activeThread, workflowRunState]);

  const onBackgroundSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      // The Task tool_use lives on the strip source thread (the parent while a
      // subagent thread is open), so route the command there.
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.task.background",
        commandId: newCommandId(),
        threadId: stripSourceThreadId,
        toolUseId: item.providerThreadId,
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop goes through the interrupt seam: on a subagent thread the reactor
  // resolves the tool_use_id and stops that task instead of the whole turn.
  // Target the canonical child id derived from the strip source thread —
  // item.threadId can still be the raw tool_use_id while client-side thread
  // resolution lags, which the server would reject as an unknown thread.
  const onStopSubagentStripItem = useCallback(
    async (item: ComposerSubagentStripItem) => {
      const api = readNativeApi();
      if (!api || !stripSourceThreadId) return;
      await api.orchestration.dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: localSubagentThreadId(stripSourceThreadId, item.providerThreadId),
        createdAt: new Date().toISOString(),
      });
    },
    [stripSourceThreadId],
  );

  // Stop-all fans out through the same per-row stop so both paths share one seam.
  const onStopAllSubagentStripItems = useCallback(async () => {
    const running = collectRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(running.map((item) => onStopSubagentStripItem(item)));
  }, [composerSubagentStripItems, onStopSubagentStripItem]);

  // Ctrl+B parity with the native CLI: send every foreground running subagent to
  // the background at once, fanning through the same per-row background dispatch.
  const onBackgroundAllForegroundSubagentStripItems = useCallback(async () => {
    const foreground = collectForegroundRunningSubagentStripItems(composerSubagentStripItems);
    await Promise.all(foreground.map((item) => onBackgroundSubagentStripItem(item)));
  }, [composerSubagentStripItems, onBackgroundSubagentStripItem]);

  // Pause is the same stop command; the persisted flag makes the settled card
  // read as paused (with a resume affordance) instead of plain stopped, across
  // reloads too.
  const onPauseWorkflowRun = useCallback(async () => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunPaused(activeThreadId, workflowTaskId);
    await onStopWorkflowRun();
  }, [activeThreadId, markWorkflowRunPaused, onStopWorkflowRun, workflowRunState]);

  const onDismissWorkflowRun = useCallback(() => {
    if (!workflowRunState || !activeThreadId) return;
    const { workflowTaskId } = workflowRunState;
    markWorkflowRunDismissed(activeThreadId, workflowTaskId);
  }, [activeThreadId, markWorkflowRunDismissed, workflowRunState]);

  const onProviderModelSelect = useCallback(
    async (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveCommittedProviderModel({
        selectedModel: model,
        availableOptions: modelOptionsByProvider[provider],
        fallback: () => resolveAppModelSelection(provider, customModelsByProvider, model),
      });
      const runtimeModel = resolveRuntimeModelDescriptor({
        provider,
        model: resolvedModel,
        runtimeModels: runtimeModelsByProvider[provider],
      });
      const nextModelSelection = buildModelSelection(
        provider,
        resolvedModel,
        undefined,
        provider === "claudeAgent" ? runtimeModel?.supportsAutoMode : undefined,
      );
      const providerStatus = findProviderStatus(providerStatuses, provider);
      const nextRuntimeMode =
        runtimeMode === "auto" &&
        !providerModelSupportsAutoRuntimeMode(provider, runtimeModel, providerStatus)
          ? "approval-required"
          : normalizeRuntimeModeForProvider(runtimeMode, provider);
      // Commit the canonical downgrade before storing an incompatible model.
      // On failure the Auto draft remains visible so compatibility checks can retry.
      const didCommitSelection = await commitAfterRuntimeModePersistence({
        currentRuntimeMode: runtimeMode,
        nextRuntimeMode,
        persistRuntimeMode: persistRuntimeModeChange,
        commit: () => {
          setComposerDraftModelSelectionAndSticky(activeThread.id, nextModelSelection);
          if (provider === "cursor") {
            setComposerDraftProviderModelOptions(activeThread.id, provider, undefined, {
              persistSticky: true,
              model: resolvedModel,
            });
          }
        },
      });
      if (!didCommitSelection) {
        scheduleComposerFocus();
        return;
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      customModelsByProvider,
      lockedProvider,
      modelOptionsByProvider,
      persistRuntimeModeChange,
      providerStatuses,
      runtimeMode,
      runtimeModelsByProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelectionAndSticky,
      setComposerDraftProviderModelOptions,
    ],
  );

  const copyThreadIdToClipboard = useCopyThreadIdToClipboard();

  useChatKeyboardShortcuts({
    onToggleDevicePanel,
    onSplitSurface,
    surfaceMode,
    isFocusedPane,
    activeThreadId,
    hasLiveTurn,
    composerFormRef,
    onInterruptFromStopControl,
    composerSubagentStripItems,
    onBackgroundAllForegroundSubagentStripItems,
    isVoiceRecording,
    isVoiceTranscribing,
    isComposerApprovalState,
    terminalState,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    terminalWorkspaceChatTabActive,
    keybindings,
    toggleComposerFocus,
    shouldRenderChatPaneContent,
    setThreadFindOpen,
    setThreadFindFocusNonce,
    handleModelPickerOpenChange,
    scheduleComposerFocus,
    modelOptionsByProvider,
    selectedProvider,
    selectedModel,
    onProviderModelSelect,
    handleTraitsPickerOpenChange,
    toggleTerminalVisibility,
    setTerminalOpen,
    splitTerminalRight,
    splitTerminalLeft,
    splitTerminalDown,
    splitTerminalUp,
    closeTerminal,
    createTerminalFromShortcut,
    openNewFullWidthTerminal,
    closeActiveWorkspaceView,
    setTerminalWorkspaceTab,
    onToggleDiff,
    commitAndPushTriggerRef,
    showGitActions,
    isGitRepo,
    onToggleBrowser,
    copyThreadIdToClipboard,
    activeProject,
    runProjectScript,
    activeThread,
  });

  // Preserve the original "single mic button" contract:
  // first click starts recording, the next click submits/transcribes.
  const toggleComposerVoiceRecording = useCallback(() => {
    if (isVoiceTranscribing) {
      return;
    }
    if (isVoiceRecording) {
      void submitComposerVoiceRecording();
      return;
    }
    void startComposerVoiceRecording();
  }, [
    isVoiceRecording,
    isVoiceTranscribing,
    startComposerVoiceRecording,
    submitComposerVoiceRecording,
  ]);

  // --- Composer attachment entry points -------------------------------------
  const addComposerImages = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0 || isSidechatExpired) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      enqueueComposerImages(files);
    },
    [activeThreadId, enqueueComposerImages, isSidechatExpired, pendingUserInputs.length],
  );

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const addComposerFiles = useCallback(
    (files: readonly File[]) => {
      if (!activeThreadId || files.length === 0 || isSidechatExpired) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach files after answering plan questions.",
        });
        return;
      }

      const { files: nextFiles, error } = buildComposerFileAttachmentsFromFiles({
        files,
        existingAttachmentCount: effectiveComposerAttachmentCount(
          useComposerDraftStore.getState().draftsByThreadId[activeThreadId],
        ),
      });

      const insertedCount = nextFiles.length > 0 ? addComposerFilesToDraft(nextFiles) : 0;
      setThreadError(
        activeThreadId,
        insertedCount < nextFiles.length
          ? `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`
          : error,
      );
    },
    [
      activeThreadId,
      addComposerFilesToDraft,
      isSidechatExpired,
      pendingUserInputs.length,
      setThreadError,
    ],
  );

  const addComposerAttachments = useCallback(
    (files: readonly File[]) => {
      const { imageFiles, genericFiles } = splitComposerDropzoneFiles(files);
      if (imageFiles.length > 0) {
        addComposerImages(imageFiles);
      }
      if (genericFiles.length > 0) {
        addComposerFiles(genericFiles);
      }
    },
    [addComposerFiles, addComposerImages],
  );

  const removeComposerFile = (fileId: string) => {
    discardPromptHistoryNavigationForComposerMutation();
    removeComposerDraftFile(threadId, fileId);
  };

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    disabled: isSidechatExpired,
    addImages: addComposerImages,
    fileSupport: {
      genericFiles: "accept",
      addFiles: addComposerFiles,
    },
    appendReferenceText: (referenceText) => appendComposerPromptText(threadId, referenceText),
    appendPathMentions: (paths) => {
      for (const absolutePath of paths) {
        appendComposerPromptText(threadId, formatComposerMentionToken(absolutePath));
      }
    },
    dragDepthRef,
    focusComposer,
    setIsDragOverComposer,
  });

  const onRevertToTurnCount = useCallback(
    async (turnCount: number) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before reverting checkpoints.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          `Revert this thread to checkpoint ${turnCount}?`,
          "This will discard newer messages and turn diffs in this thread.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) {
        return;
      }

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      try {
        await api.orchestration.dispatchCommand({
          type: "thread.checkpoint.revert",
          commandId: newCommandId(),
          threadId: activeThread.id,
          turnCount,
          scope: "thread",
          createdAt: new Date().toISOString(),
        });
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to revert thread state.",
        );
      }
      setIsRevertingCheckpoint(false);
    },
    [
      setIsRevertingCheckpoint,
      activeThread,
      hasLiveTurn,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      setThreadError,
    ],
  );

  const onUndoTurnFiles = useCallback(
    async (turnCounts: readonly number[]) => {
      const api = readNativeApi();
      if (!api || !activeThread || isRevertingCheckpoint || turnCounts.length === 0) return;

      if (hasLiveTurn || isSendBusy || isConnecting) {
        setThreadError(activeThread.id, "Interrupt the current turn before undoing file changes.");
        return;
      }
      const confirmed = await api.dialogs.confirm(
        [
          "Undo the file changes shown in this card?",
          "Earlier file changes will remain available to undo.",
          "Messages and provider conversation history will be kept.",
          "This action cannot be undone.",
        ].join("\n"),
      );
      if (!confirmed) return;

      setIsRevertingCheckpoint(true);
      setThreadError(activeThread.id, null);
      // The card can merge several turns. The server refuses to undo a turn while
      // newer file changes are still applied, so revert newest-first and stop at
      // the first failure rather than leaving the card half-undone silently.
      const orderedTurnCounts = [...new Set(turnCounts)].toSorted((left, right) => right - left);
      const requestedAt = new Date().toISOString();
      setPendingFileUndo({
        threadId: activeThread.id,
        turnCounts: orderedTurnCounts,
        existingFailureActivityIds: activeThread.activities
          .filter((activity) => activity.kind === "checkpoint.revert.failed")
          .map((activity) => activity.id),
      });
      const dispatchReverts = async () => {
        for (const turnCount of orderedTurnCounts) {
          await api.orchestration.dispatchCommand({
            type: "thread.checkpoint.revert",
            commandId: newCommandId(),
            threadId: activeThread.id,
            turnCount,
            scope: "files",
            createdAt: requestedAt,
          });
        }
      };
      await dispatchReverts().catch((err: unknown) => {
        setPendingFileUndo(null);
        setIsRevertingCheckpoint(false);
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to undo file changes.",
        );
      });
    },
    [
      setIsRevertingCheckpoint,
      setPendingFileUndo,
      activeThread,
      hasLiveTurn,
      isConnecting,
      isRevertingCheckpoint,
      isSendBusy,
      setThreadError,
    ],
  );

  const onCreateHandoffThread = useCallback(
    async (targetProvider: ProviderKind) => {
      if (!activeThread || handoffDisabled) {
        return;
      }

      try {
        await createThreadHandoff(activeThread, targetProvider);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not create handoff thread",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the handoff thread.",
        });
      }
    },
    [activeThread, createThreadHandoff, handoffDisabled],
  );

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptHistoryNavigationRef.current = null;
      applyingPromptHistoryNavigationRef.current = false;
      expectedPromptHistoryPromptRef.current = null;
      promptRef.current = "";
      setRestoredQueuedSourceProposedPlan(threadId, null);
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      promptHistoryNavigationRef,
      applyingPromptHistoryNavigationRef,
      expectedPromptHistoryPromptRef,
      setComposerHighlightedItemId,
      clearComposerDraftContent,
      setRestoredQueuedSourceProposedPlan,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const { createAutomationFromForm, prepareAutomationFormForCreate, submitAutomationDraft } =
    useChatAutomationCreation({
      threadId,
      activeProject,
      automationDraftSubmittingRef,
      isServerThread,
      activeThread,
      providerOptionsForDispatch,
      setIsAutomationDraftSubmitting,
      queryClient,
      clearComposerInput,
      resetAutomationDraftState,
      activeThreadAssociatedWorktree,
      threadNotes,
      selectedModelSelection,
      runtimeMode,
      interactionMode,
      automationDraftForm,
      automationDraftWarnings,
      acknowledgedAutomationWarnings,
    });

  const lateComposerSendHandlersRef = useRef<LateComposerSendHandlers | null>(null);
  const {
    setQueuedSteerGate,
    removeQueuedComposerTurn,
    onSteerQueuedComposerTurn,
    onEditQueuedComposerTurn,
  } = useChatQueuedTurns({
    threadId,
    queuedComposerTurns,
    activeThread,
    promptRef,
    clearComposerDraftContent,
    setComposerDraftPrompt,
    setDraftThreadContext,
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
    setRestoredQueuedSourceProposedPlan,
    setComposerDraftModelSelection,
    setComposerDraftRuntimeMode,
    setComposerDraftInteractionMode,
    setComposerCursor,
    setComposerTrigger,
    scheduleComposerFocus,
    removeQueuedComposerTurnFromDraft,
    lateComposerSendHandlersRef,
    insertQueuedComposerTurn,
    phase,
    localDispatch,
    isLocalDraftThread,
    activeLatestTurn,
    isConnecting,
    activePendingApproval,
    activePendingProgress,
    pendingUserInputs,
    sendInFlightRef,
    sendPreflightInFlightRef,
  });

  const { onSend } = useChatTurnSubmission({
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
  });

  const {
    onSubmitPlanFollowUp,
    onEditUserMessage,
    onResumeWorkflowRun,
    onImplementPlanInNewThread,
  } = useChatTurnFollowUps({
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
  });

  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      const currentPrompt = promptRef.current;
      if (nextPrompt === currentPrompt) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [promptRef, setComposerCursor, setComposerTrigger, scheduleComposerFocus, setPrompt],
  );
  const selectedProviderModelOptions = composerModelOptions?.[selectedProvider];
  const composerTraitSelection = getComposerTraitSelection(
    selectedProvider,
    selectedModel,
    prompt,
    selectedProviderModelOptions,
    selectedRuntimeModel,
  );
  const runtimeUsageContextWindow = useMemo(
    () =>
      activeContextWindowState.invalidatedByCompaction
        ? null
        : (activeContextWindow ??
          (selectedProvider === "claudeAgent"
            ? deriveSelectedContextWindowSnapshot(composerTraitSelection.contextWindow)
            : null)),
    [
      activeContextWindow,
      activeContextWindowState.invalidatedByCompaction,
      composerTraitSelection.contextWindow,
      selectedProvider,
    ],
  );
  const contextWindowSelectionStatus = useMemo(
    () =>
      deriveContextWindowSelectionStatus({
        activeSnapshot: runtimeUsageContextWindow,
        selectedValue:
          selectedProvider === "claudeAgent" ? composerTraitSelection.contextWindow : null,
      }),
    [runtimeUsageContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const useSplitComposerPickerControls = isLocalDraftThread && !hasThreadStarted;
  const composerFooterControlsPlan = useMemo(
    () => composerFooterPlanForTier(composerFooterTier, Boolean(runtimeUsageContextWindow)),
    [composerFooterTier, runtimeUsageContextWindow],
  );
  // The displayed labels changed (model switch, effort change, picker layout):
  // recorded overflow widths no longer apply, so reset to the richest tier and
  // let the measured-overflow loop demote again before paint if needed.
  const composerFooterModelLabel = resolveProviderModelLabel({
    provider: selectedProvider,
    lockedProvider,
    model: selectedModelForPickerWithCustomFallback,
    modelOptionsByProvider,
  });
  const composerFooterTraitsSummary = resolveTraitsTriggerSummary({
    provider: selectedProvider,
    model: selectedModelForPickerWithCustomFallback,
    prompt,
    modelOptions: selectedProviderModelOptions,
    ...(selectedRuntimeModel ? { runtimeModel: selectedRuntimeModel } : {}),
    runtimeAgents: dynamicAgents,
  });
  const composerFooterPlanInputsKey = [
    composerFooterModelLabel,
    composerFooterTraitsSummary.summaryText,
    Boolean(runtimeUsageContextWindow),
    useSplitComposerPickerControls,
  ].join(":");
  useLayoutEffect(() => {
    composerFooterDemotionWidthsRef.current = [];
    composerFooterTierRef.current = 0;
    setComposerFooterTier(0);
    composerFooterLayoutSyncRef.current?.();
  }, [
    setComposerFooterTier,
    composerFooterTierRef,
    composerFooterDemotionWidthsRef,
    composerFooterLayoutSyncRef,
    composerFooterPlanInputsKey,
  ]);
  // After a tier renders, re-measure before paint: a still-overflowing footer
  // demotes another step until it fits (bounded by COMPOSER_FOOTER_MAX_TIER).
  useLayoutEffect(() => {
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterLayoutSyncRef, composerFooterTier]);
  const composerModelPickerWidthClassName = isComposerFooterCompact ? "w-32" : "w-36 sm:w-44";
  const composerOptionsPickerWidthClassName = isComposerFooterCompact ? "w-28" : "w-32";
  const composerModelEffortPickerWidthClassName = isComposerFooterCompact ? "w-40" : "w-44 sm:w-52";
  const isComposerModelEffortPickerOpen = isModelPickerOpen || isTraitsPickerOpen;
  const handleComposerModelEffortPickerOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        handleModelPickerOpenChange(true);
      } else {
        setIsModelPickerOpen(false);
        setIsTraitsPickerOpen(false);
      }
    },
    [setIsModelPickerOpen, setIsTraitsPickerOpen, handleModelPickerOpenChange],
  );
  const composerPickerControls = showComposerModelBootstrapSkeleton ? (
    useSplitComposerPickerControls ? (
      <>
        {selectedProviderRuntimeModelDiscoveryPending ? (
          <ComposerModelLoadingControl widthClassName={composerModelPickerWidthClassName} />
        ) : (
          <ComposerControlSkeleton widthClassName={composerModelPickerWidthClassName} />
        )}
        <ComposerControlSkeleton widthClassName={composerOptionsPickerWidthClassName} />
      </>
    ) : selectedProviderRuntimeModelDiscoveryPending ? (
      <ComposerModelLoadingControl widthClassName={composerModelEffortPickerWidthClassName} />
    ) : (
      <ComposerControlSkeleton widthClassName={composerModelEffortPickerWidthClassName} />
    )
  ) : useSplitComposerPickerControls ? (
    <>
      <ProviderModelPicker
        compact={isComposerFooterCompact}
        hideLabel={!composerFooterControlsPlan.showModelLabel}
        provider={selectedProvider}
        model={selectedModelForPickerWithCustomFallback}
        lockedProvider={lockedProvider}
        providers={providerStatuses}
        modelOptionsByProvider={modelOptionsByProvider}
        loadingModelProviders={loadingModelProviders}
        discoveryErrorsByProvider={discoveryErrorsByProvider}
        hiddenProviders={settings.hiddenProviders}
        providerOrder={settings.providerOrder}
        onProviderModelChange={onProviderModelSelect}
        onSelectionCommitted={scheduleComposerFocus}
        open={isModelPickerOpen}
        onOpenChange={handleModelPickerOpenChange}
        shortcutLabel={modelPickerShortcutLabel}
      />
      <TraitsPicker
        provider={selectedProvider}
        threadId={threadId}
        model={selectedModelForPickerWithCustomFallback}
        runtimeModel={selectedRuntimeModel}
        runtimeModels={runtimeModelsByProvider[selectedProvider]}
        runtimeAgents={dynamicAgents}
        modelOptions={selectedProviderModelOptions}
        prompt={prompt}
        onPromptChange={setPromptFromTraits}
        open={isTraitsPickerOpen}
        onOpenChange={handleTraitsPickerOpenChange}
        onSelectionCommitted={scheduleComposerFocus}
        shortcutLabel={traitsPickerShortcutLabel}
        hideLabel={!composerFooterControlsPlan.showTraitsLabel}
      />
    </>
  ) : (
    <ComposerModelEffortPicker
      compact={isComposerFooterCompact}
      hideModelLabel={!composerFooterControlsPlan.showModelLabel}
      hideStatusLabel={!composerFooterControlsPlan.showTraitsLabel}
      effortControl={settings.composerEffortSlider ? "slider" : "menu"}
      provider={selectedProvider}
      model={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={loadingModelProviders}
      discoveryErrorsByProvider={discoveryErrorsByProvider}
      hiddenProviders={settings.hiddenProviders}
      providerOrder={settings.providerOrder}
      threadId={threadId}
      runtimeModel={selectedRuntimeModel}
      runtimeModels={runtimeModelsByProvider[selectedProvider]}
      runtimeAgents={dynamicAgents}
      modelOptions={selectedProviderModelOptions}
      prompt={prompt}
      onPromptChange={setPromptFromTraits}
      onProviderModelChange={onProviderModelSelect}
      onSelectionCommitted={scheduleComposerFocus}
      open={isComposerModelEffortPickerOpen}
      onOpenChange={handleComposerModelEffortPickerOpenChange}
      shortcutLabel={modelPickerShortcutLabel}
    />
  );
  const toggleFastMode = useCallback(() => {
    if (!composerTraitSelection.caps.supportsFastMode) {
      scheduleComposerFocus();
      return;
    }
    setComposerDraftProviderModelOptions(
      threadId,
      selectedProvider,
      buildNextProviderOptions(selectedProvider, selectedProviderModelOptions, {
        fastMode: !composerTraitSelection.fastModeEnabled,
      }),
      { persistSticky: true },
    );
    scheduleComposerFocus();
  }, [
    composerTraitSelection.caps.supportsFastMode,
    composerTraitSelection.fastModeEnabled,
    scheduleComposerFocus,
    selectedProvider,
    selectedProviderModelOptions,
    setComposerDraftProviderModelOptions,
    threadId,
  ]);
  const {
    onEnvModeChange,
    handleResetWorkspaceToHome,
    handleSelectWorkspaceRoot,
    handleSelectProjectForEmptyDraft,
    handleCreateProjectFromPickerPath,
  } = useChatWorkspaceSelection({
    threadId,
    activeThread,
    activeProject,
    activeRootBranch,
    isServerThread,
    isLocalDraftThread,
    isHomeChatContainer,
    isStudioContainer,
    hasNativeUserMessages,
    composerEditorRef,
    scheduleComposerFocus,
    defaultProvider: settings.defaultProvider,
  });

  const {
    applyPromptReplacement,
    resolveActiveComposerTrigger,
    applyComposerTriggerReplacement,
    handleSelectLocalDirectoryMention,
    handleNavigateLocalFolder,
    setComposerPromptValue,
    clearComposerSlashDraft,
  } = useChatComposerEditing({
    threadId,
    promptRef,
    activePendingProgress,
    activePendingUserInputKey,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    setPrompt,
    setComposerCursor,
    setComposerTrigger,
    composerEditorRef,
    composerCursor,
    composerTerminalContexts,
    setComposerHighlightedItemId,
    setRestoredQueuedSourceProposedPlan,
    clearComposerDraftContent,
    scheduleComposerFocus,
  });

  const slashEditorActions = useMemo(
    () => ({
      resolveActiveComposerTrigger,
      applyPromptReplacement,
      clearComposerSlashDraft,
      setComposerPromptValue,
      scheduleComposerFocus,
      setComposerHighlightedItemId,
    }),
    [
      setComposerHighlightedItemId,
      applyPromptReplacement,
      clearComposerSlashDraft,
      resolveActiveComposerTrigger,
      scheduleComposerFocus,
      setComposerPromptValue,
    ],
  );

  const {
    handleForkFromMessage,
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
    clearThreadGoal,
    setThreadGoalPaused,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    isLocalDraftThread,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      canCompactThread &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canExecuteSideCommand,
    sidechatTargetProviders: handoffTargetProviders,
    canOfferExportCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd: providerModelDiscoveryCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
    environmentMode: envMode ?? null,
    runtimeMode,
    interactionMode,
    threadId,
    syncServerShellSnapshot,
    navigateToThread: (nextThreadId, options) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        ...(options?.splitViewId ? { search: () => ({ splitViewId: options.splitViewId }) } : {}),
      }),
    handleClearConversation: async () => {
      if (!activeProject) {
        toastManager.add({
          type: "warning",
          title: "Clear is unavailable",
          description: "Open a project before starting a fresh thread.",
        });
        return;
      }
      await handleNewThread(activeProject.id, { entryPoint: "chat" });
    },
    handleInteractionModeChange,
    openForkTargetPicker: () => {
      setComposerCommandPicker("fork-target");
      setComposerHighlightedItemId("fork-target:worktree");
    },
    openReviewTargetPicker: () => {
      setComposerCommandPicker("review-target");
      setComposerHighlightedItemId("review-target:changes");
    },
    setComposerDraftProviderModelOptions,
    editorActions: slashEditorActions,
  });

  // Prefills "/goal <current text>" so editing reuses the same slash-command path
  // that created the goal, mirroring how queued turns restore into the composer.
  const editThreadGoalInComposer = useCallback(() => {
    const currentGoal = activeThread?.goal?.trim();
    if (!activeThread || !currentGoal) {
      return;
    }
    const nextPrompt = `/goal ${currentGoal}`;
    promptRef.current = nextPrompt;
    clearComposerDraftContent(activeThread.id);
    setComposerDraftPrompt(activeThread.id, nextPrompt);
    setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
    setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
    scheduleComposerFocus();
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    activeThread,
    clearComposerDraftContent,
    scheduleComposerFocus,
    setComposerDraftPrompt,
  ]);

  // Refreshed on every commit, in a layout effect rather than a passive one: the queued
  // dispatcher can run from the same commit's follow-up work, so there must be no window
  // where it sees the previous render's handlers. See `LateComposerSendHandlers`.
  useLayoutEffect(() => {
    lateComposerSendHandlersRef.current = {
      send: onSend,
      submitPlanFollowUp: onSubmitPlanFollowUp,
      advanceActivePendingUserInput: onAdvanceActivePendingUserInput,
      handleStandaloneSlashCommand,
    };
  });

  const {
    onSelectComposerItem,
    onComposerMenuItemHighlighted,
    onPromptChange,
    onComposerCommandKey,
  } = useChatComposerCommands({
    threadId,
    composerSelectLockRef,
    setComposerCommandPicker,
    setComposerHighlightedItemId,
    handleForkTargetSelection,
    handleReviewTargetSelection,
    resolveActiveComposerTrigger,
    applyComposerTriggerReplacement,
    handleNavigateLocalFolder,
    localFolderBrowseRootPath,
    handleSlashCommandSelection,
    selectedProvider,
    scheduleComposerFocus,
    updateSelectedComposerSkills,
    updateSelectedComposerMentions,
    onProviderModelSelect,
    composerMenuItems,
    composerHighlightedItemId,
    activePendingQuestion,
    activePendingUserInput,
    promptHistoryNavigationRef,
    restoreComposerDraftPromptHistorySavedDraft,
    promptRef,
    setPrompt,
    expectedPromptHistoryPromptRef,
    onChangeActivePendingUserInputCustomAnswer,
    setComposerDraftPromptHistorySavedDraft,
    applyingPromptHistoryNavigationRef,
    promptHistory,
    promptHistoryAppliedPromptRef,
    restoredQueuedSourceProposedPlanRef,
    setRestoredQueuedSourceProposedPlan,
    composerCommandPicker,
    composerTerminalContexts,
    setComposerDraftTerminalContexts,
    setComposerCursor,
    setComposerTrigger,
    clearComposerSlashDraft,
    toggleInteractionMode,
    composerMenuOpenRef,
    onSend,
    settings,
    hasLiveTurn,
    isLocalFolderBrowserOpen,
    localDirectoryMenuRef,
    composerMenuItemsRef,
    activeComposerMenuItemRef,
    activePendingProgress,
    isComposerApprovalState,
    pendingUserInputs,
    composerDraft,
  });
  const onExpandTimelineImage = useCallback(
    (preview: ExpandedImagePreview) => {
      setExpandedImage(preview);
    },
    [setExpandedImage],
  );

  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (diffEnvironmentPending) {
        return;
      }
      if (onOpenTurnDiffPanel) {
        onOpenTurnDiffPanel(turnId, filePath);
        return;
      }
      void navigate({
        to: "/$threadId",
        params: { threadId },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return filePath
            ? {
                ...rest,
                panel: "diff",
                diff: "1",
                diffTurnId: turnId,
                diffFilePath: filePath,
              }
            : { ...rest, panel: "diff", diff: "1", diffTurnId: turnId };
        },
      });
    },
    [diffEnvironmentPending, navigate, onOpenTurnDiffPanel, threadId],
  );
  const onReviewComposerLiveChanges = useCallback(() => {
    if (!activeTurnLiveDiffState.turnId) {
      return;
    }
    onOpenTurnDiff(activeTurnLiveDiffState.turnId);
  }, [activeTurnLiveDiffState.turnId, onOpenTurnDiff]);
  const onNavigateToThread = useCallback(
    (nextThreadId: ThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) =>
          isEditorRail
            ? { ...stripDiffSearchParams(previous), view: "editor" }
            : stripDiffSearchParams(previous),
      });
    },
    [isEditorRail, navigate],
  );
  const onOpenAutomation = useCallback(
    (automationId: string) => {
      void navigate({
        to: "/automations/$automationId",
        params: { automationId },
      });
    },
    [navigate],
  );
  const activeProjectIdForNewChat = activeProject?.id ?? null;
  const onNewEditorChat = useCallback(() => {
    if (!activeProjectIdForNewChat) {
      return;
    }
    // Keep the editor workspace view (and any open file) across the new-thread
    // navigation; the default new-thread flow clears all search params.
    void handleNewThread(activeProjectIdForNewChat, undefined, {
      search: (previous) => ({ ...stripDiffSearchParams(previous), view: "editor" }),
    });
  }, [activeProjectIdForNewChat, handleNewThread]);
  const onOpenEditorChat = useCallback(
    (nextThreadId: ThreadId) => {
      storeOpenChatThreadPage(nextThreadId);
      onNavigateToThread(nextThreadId);
    },
    [onNavigateToThread, storeOpenChatThreadPage],
  );
  const onOpenEditorTerminal = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalWorkspaceLayout("terminal-only");
    setTerminalWorkspaceTab("terminal");
    requestTerminalFocus();
  }, [
    activeThreadId,
    requestTerminalFocus,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
  ]);
  const onCloseEditorTerminal = useCallback(() => {
    void closeTerminal(terminalState.activeTerminalId);
  }, [closeTerminal, terminalState.activeTerminalId]);
  const onRevertUserMessage = useCallback(
    (messageId: MessageId) => {
      const targetTurnCount = revertTurnCountByUserMessageId.get(messageId);
      if (typeof targetTurnCount !== "number") {
        return;
      }
      void onRevertToTurnCount(targetTurnCount);
    },
    [onRevertToTurnCount, revertTurnCountByUserMessageId],
  );
  const onRunProjectScriptFromHeader = useCallback(
    (script: ProjectScript) => {
      void runProjectScript(script);
    },
    [runProjectScript],
  );
  const dismissActiveThreadError = useCallback(() => {
    if (!activeThread) return;
    setThreadError(activeThread.id, null);
  }, [activeThread, setThreadError]);
  const clearThreadErrorAfterUnblock = useCallback(
    (unblockedThreadId: ThreadId) => {
      setThreadError(unblockedThreadId, null);
    },
    [setThreadError],
  );
  const { unblockThread: unblockActiveThread, unblocking: unblockingActiveThread } =
    useThreadUnblock({
      threadId: activeThread?.id ?? null,
      onUnblocked: clearThreadErrorAfterUnblock,
    });
  useThreadErrorToast({
    threadId: activeThread?.id ?? null,
    error: activeThread?.error ?? null,
    onDismiss: dismissActiveThreadError,
    onUnblock: unblockActiveThread,
    unblocking: unblockingActiveThread,
  });
  const dismissActiveProviderHealthBanner = useCallback(() => {
    if (!activeProviderHealthBannerDismissalKey) return;
    setDismissedProviderHealthBannerKeys((current) => {
      if (current.includes(activeProviderHealthBannerDismissalKey)) {
        return current;
      }
      return [activeProviderHealthBannerDismissalKey, ...current].slice(
        0,
        MAX_DISMISSED_PROVIDER_HEALTH_BANNERS,
      );
    });
  }, [activeProviderHealthBannerDismissalKey, setDismissedProviderHealthBannerKeys]);
  const dismissActiveRateLimitBanner = useCallback(() => {
    if (!activeRateLimitBannerDismissalKey) return;
    setDismissedRateLimitBannerKey(activeRateLimitBannerDismissalKey);
  }, [setDismissedRateLimitBannerKey, activeRateLimitBannerDismissalKey]);

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col text-[var(--color-text-foreground-secondary)]",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        {!isElectron && (
          <header className={cn(CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME, "px-3 py-2 md:hidden")}>
            <div className="flex items-center gap-2">
              <SidebarHeaderTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-[var(--color-text-foreground)]">
                Threads
              </span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
              "drag-region px-5",
              desktopTopBarTrafficLightGutterClassName,
              desktopTopBarWindowControlsGutterClassName,
            )}
          >
            <SidebarHeaderNavigationControls />
            <span className="text-xs text-muted-foreground/50">No active thread</span>
          </div>
        )}
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm">Select a thread or create a new one to get started.</p>
          </div>
        </div>
      </div>
    );
  }

  const activeThreadDisplayTitle = resolveActiveThreadTitle({
    title: activeThread.title,
    subagentTitle: activeThread.parentThreadId
      ? resolveSubagentPresentationForThread({
          thread: activeThread,
          threads: threadLineageThreads,
        }).fullLabel
      : null,
    isHomeChat: isChatProject,
    isEmpty: timelineEntries.length === 0,
  });

  const handleRenameActiveThread = async (newTitle: string) => {
    const outcome = await dispatchThreadRename({
      threadId: activeThread.id,
      newTitle,
      unchangedTitles: [activeThread.title],
      createIfMissing: isLocalDraftThread
        ? buildDraftThreadRenameCreateInput(activeThread)
        : undefined,
    }).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Failed to rename thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      throw error;
    });

    if (outcome === "empty") {
      toastManager.add({
        type: "warning",
        title: "Thread title cannot be empty",
      });
      return;
    }
    if (outcome === "unchanged" || outcome === "unavailable") {
      return;
    }
  };

  const runtimeUsageControlsProps = {
    provider: selectedProvider,
    runtimeModel: selectedRuntimeModel,
    providerStatus: activeProviderStatus,
    runtimeMode,
    onRuntimeModeChange: handleRuntimeModeChange,
    contextWindow: runtimeUsageContextWindow,
    cumulativeCostUsd: activeCumulativeCostUsd,
    activeContextWindowLabel: contextWindowSelectionStatus.activeLabel,
    pendingContextWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
  };
  // The composer's leading controls (extras "+" menu, access-rules/runtime
  // indicator). At the narrowest footer tier they relocate from the footer to
  // the branch-toolbar row below the input instead of getting clipped; the
  // relocated variant is icon-only since relocation means space is minimal.
  const relocateComposerLeadingControls = composerFooterControlsPlan.relocateLeadingControls;
  const renderComposerLeadingControls = (options: { iconOnly: boolean }) => (
    <>
      <ComposerExtrasTrigger
        open={isComposerExtrasPanelOpen}
        panelId={COMPOSER_EXTRAS_PANEL_ID}
        onToggle={() => {
          setIsComposerExtrasPanelOpen((open) => !open);
          // The panel is keyboard-driven from the editor: keep the caret where the
          // user left it so typing (and Escape) keep working while it is open.
          scheduleComposerFocus();
        }}
      />
      {!isVoiceRecording && !isVoiceTranscribing ? (
        <RuntimeUsageControls
          {...runtimeUsageControlsProps}
          className="shrink-0"
          hideLabel={options.iconOnly}
        />
      ) : null}
    </>
  );
  const branchToolbarProps = {
    threadId: activeThread.id,
    onEnvModeChange,
    envLocked,
    threadDetailReady: threadDetailHydration === "ready",
    onHandoffToWorktree,
    onHandoffToLocal,
    handoffBusy,
    onComposerFocusRequest: scheduleComposerFocus,
    ...(isStudioContainer ? { fixedLocalWorkspaceCwd: threadWorkspaceCwd } : {}),
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
  };
  const showEmptyLandingBranchToolbar =
    isCenteredEmptyLanding && activeProject?.kind === "project" && !isHomeChatContainer;
  // Temporary is chosen while starting a chat. Draft metadata covers local reloads;
  // the in-memory marker keeps the badge + auto-delete alive through promotion.
  const isThreadTemporary = draftThread?.isTemporary === true || hasTemporaryThreadMarker;
  const toggleDraftTemporary = () => {
    const next = !isThreadTemporary;
    setDraftThreadContext(threadId, { isTemporary: next });
    if (next) {
      markTemporaryThread(threadId);
    } else {
      clearTemporaryThread(threadId);
    }
  };
  const showEmptyLandingProjectPicker =
    isCenteredEmptyLanding && isLocalDraftThread && activeProject?.kind === "project";
  const showContainerChatWorkspacePicker =
    isEmptyChatLanding && (isHomeChatContainer || isStudioContainer);
  const emptyLandingProjectChip =
    !showContainerChatWorkspacePicker &&
    !showEmptyLandingProjectPicker &&
    activeProjectDisplayName ? (
      <span
        className={cn(
          "inline-flex min-w-0 max-w-56 shrink items-center gap-2 overflow-hidden rounded-full px-2 py-1 sm:max-w-64",
          COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
        )}
      >
        <FolderClosed className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{activeProjectDisplayName}</span>
      </span>
    ) : null;
  const showEmptyLandingControls =
    isCenteredEmptyLanding &&
    (isEmptyChatLanding ||
      showEmptyLandingProjectPicker ||
      emptyLandingProjectChip !== null ||
      showEmptyLandingBranchToolbar);
  const emptyLandingControls = showEmptyLandingControls ? (
    <div
      data-empty-landing-controls="true"
      // Tray sitting in normal flow directly above the composer, full composer width so
      // the project / environment / branch chips sit near the shell edges. Unfilled in
      // both themes (chips float over the page), rounded on top only and flush against
      // the input shell below. No overlap/underlay tricks — in dark mode a slice tucked
      // behind the composer's translucent corners reads as a visible cut along the seam.
      className="chat-composer-shell mx-auto flex min-h-8 w-full min-w-0 flex-nowrap items-center gap-x-1.5 overflow-hidden !rounded-b-none !rounded-t-[var(--composer-radius)] px-1.5 py-1 transition-colors duration-150 ease-out motion-reduce:transition-none sm:min-h-7"
    >
      {showContainerChatWorkspacePicker ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerVariant="ghost"
          triggerClassName={cn(
            "h-8 px-2 py-1 sm:h-7 sm:px-2.5",
            COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
          )}
          showResetToHome={Boolean(
            isStudioContainer ? resolvedThreadWorkingDirectory : resolvedThreadWorktreePath,
          )}
          selectedWorkspaceRoot={
            isStudioContainer ? resolvedThreadWorkingDirectory : resolvedThreadWorktreePath
          }
          onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
          onResetToHome={handleResetWorkspaceToHome}
          {...(!isStudioContainer
            ? {
                onSelectProject: handleSelectProjectForEmptyDraft,
                onCreateProjectFromPath: handleCreateProjectFromPickerPath,
              }
            : {})}
        />
      ) : showEmptyLandingProjectPicker ? (
        <ProjectPicker
          align="start"
          side="top"
          triggerVariant="ghost"
          triggerClassName={cn(
            "h-8 px-2 py-1 sm:h-7 sm:px-2.5",
            COMPOSER_FOLDER_PICKER_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
          )}
          selectionMode="project"
          selectedProjectId={activeProject.id}
          selectedWorkspaceRoot={activeProject.cwd}
          showResetToHome
          onSelectProject={handleSelectProjectForEmptyDraft}
          onCreateProjectFromPath={handleCreateProjectFromPickerPath}
          onResetToHome={handleResetWorkspaceToHome}
        />
      ) : (
        emptyLandingProjectChip
      )}
      {/* Reserve the Local/branch slot so project selection fades controls in without resizing. */}
      <div
        aria-hidden={showEmptyLandingBranchToolbar ? undefined : true}
        className={cn(
          "flex min-w-0 flex-1 items-center transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
          showEmptyLandingBranchToolbar
            ? "translate-y-0 opacity-100"
            : "pointer-events-none opacity-0",
        )}
      >
        {showEmptyLandingBranchToolbar ? (
          <BranchToolbar
            {...branchToolbarProps}
            className="mx-0 min-w-0 flex-1 !justify-start !px-0 !pb-0 !pt-0"
            showBranchSelector={isGitRepo}
          />
        ) : null}
      </div>
      {showEmptyLandingBranchToolbar ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={isThreadTemporary}
          onClick={toggleDraftTemporary}
          title={
            isThreadTemporary
              ? "Temporary chat — deleted when you leave. Click to keep it."
              : "Make this a temporary chat (deleted when you leave)"
          }
          aria-label="Temporary chat"
          className={cn(
            "ml-auto shrink-0 gap-1.5 whitespace-nowrap px-2 sm:px-2.5",
            COMPOSER_TOOLBAR_CAPSULE_HOVER_CLASS_NAME,
            COMPOSER_TOOLBAR_TRIGGER_TEXT_CLASS_NAME,
            isThreadTemporary &&
              "text-[var(--color-text-accent)] hover:text-[var(--color-text-accent)]",
          )}
        >
          <TemporaryThreadIcon className="size-3.5" />
          <span className="sr-only sm:not-sr-only">Temporary</span>
        </Button>
      ) : null}
    </div>
  ) : null;

  const threadAutomationItems = automationsForThread(
    automationData.definitions,
    activeThread.id,
  ).map((definition) => ({ definition }));

  // Shared inputs for both Environment panel surfaces (the header Popover when the dock is
  // open, and the docked right column when it is closed) so the two never drift.
  const environmentPanelProps: Omit<EnvironmentPanelProps, "open" | "variant"> = {
    gitCwd: threadWorkspaceCwd,
    openInTarget: threadWorkspaceCwd,
    githubRepository: githubRepositoryQuery.data?.repository ?? null,
    githubRepositories: githubRepositoryQuery.data?.repositories ?? [],
    isGitRepo,
    keybindings,
    availableEditors,
    activeThreadId: activeThread.id,
    activeProvider: activeThread.session?.provider ?? activeThread.modelSelection.provider,
    isStudioChat: isStudioContainer,
    studioFolderPath: isStudioContainer ? resolvedThreadWorkingDirectory : null,
    showGitActions,
    diffOpen: resolvedDiffOpen,
    threadAutomations: threadAutomationItems,
    sidechats: activeThread.sidechatSourceThreadId
      ? null
      : sourceThreadSidechats.map((sidechat) => ({
          id: sidechat.id,
          title: sidechat.title,
          expiredAt: sidechat.sidechatExpiredAt ?? null,
        })),
    diffDisabledReason,
    diffTotals: repoDiffTotals,
    branchToolbar: branchToolbarProps,
    recap: threadRecap,
    pinnedMessages,
    pinnedMessageTextById,
    notes: threadNotes,
    activeProjectId,
    projectInstructions,
    canCopyProjectInstructionsToNotes: !isLocalDraftThread,
    onProjectInstructionsChange: setProjectInstructions,
    onCopyProjectInstructionsToNotes: handleCopyProjectInstructionsToNotes,
    onToggleDiff,
    onOpenAutomation: (definition: AutomationDefinition) => onOpenAutomation(definition.id),
    onOpenGithubRepository: openBrowserUrl,
    onJumpToPinnedMessage: handleJumpToPinnedMessage,
    onTogglePinnedMessageDone: handleTogglePinnedMessageDone,
    onUnpinMessage: handleUnpinMessage,
    onRenamePinnedMessage: handleRenamePinnedMessage,
    onNotesChange: handleNotesChange,
    onOpenEditorView: viewModeAction?.onClick ?? null,
    onClose: closeEnvironmentPanelAfterAction,
    onRegisterCommitAndPushTrigger,
  };
  // Full-width single chat: overlay plus transcript/composer inset. Floating overlay when the
  // column is already narrow — right dock open or a split pane (same as header compact mode).
  // Terminal surfaces always float so opening Environment never resizes the terminal workspace.
  const environmentAppliesContentInset = environmentPanelVisible && !environmentUsesFloatingOverlay;
  const environmentOverlayVariant = environmentUsesFloatingOverlay ? "floating" : "docked";
  const environmentHeaderState = environmentEnabled
    ? {
        open: environmentPanelVisible,
        onOpenChange: setEnvironmentPanelOpenPreference,
      }
    : null;

  const showComposerLiveChangesHeader = latestTurnLive && activeTurnLiveDiffState.hasChanges;
  const showComposerActiveTaskListCard = Boolean(activeTaskList && !planSidebarOpen);
  const showComposerWorkflowRunCard = workflowRunState !== null;
  const showComposerSubagentStrip = composerSubagentStripItems.length > 0;
  const activeThreadGoalText = activeThread?.goal?.trim() ?? "";
  const showComposerGoalHeader = activeThreadGoalText.length > 0;
  const startReplacementSidechat = () => {
    const sourceThreadId = activeThread?.sidechatSourceThreadId;
    if (!sourceThreadId) return;
    void waitForSidechatCreator(sourceThreadId)
      .then((createSidechat) => {
        if (!createSidechat) {
          toastManager.add({
            type: "warning",
            title: "Side chat is unavailable",
            description: "Open the parent chat before starting a replacement side chat.",
          });
          return;
        }
        return createSidechat();
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Could not start side chat",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the side chat.",
        });
      });
  };
  // The workflow card already lists its run and member agents, so the generic
  // "N background agents" footer only counts tasks outside the workflow.
  const composerBackgroundTaskCount = workflowRunState
    ? (activeBackgroundTasks?.taskIds.filter((taskId) => !workflowRunState.taskIds.includes(taskId))
        .length ?? 0)
    : (activeBackgroundTasks?.activeCount ?? 0);

  // Composer layout keeps the task list and footer actions in one render path so
  // follow-up prompts and normal chat mode stay visually in sync.
  const renderActiveTaskListCard = (attachedToPrevious: boolean) =>
    activeTaskList && showComposerActiveTaskListCard ? (
      <ComposerActiveTaskListCard
        activeTaskList={activeTaskList}
        backgroundTaskCount={composerBackgroundTaskCount}
        compact={activeTaskListCompact}
        onCompactChange={setActiveTaskListCompact}
        onOpenSidebar={() => setPlanSidebarOpen(true)}
        attachedToPrevious={attachedToPrevious}
      />
    ) : null;

  const composerSection =
    secondaryChromeReady && shouldRenderChatPaneContent ? (
      <div
        className={cn(isCenteredEmptyLanding ? "w-full overflow-visible" : "contents")}
        data-empty-landing-composer-block={isCenteredEmptyLanding ? "true" : undefined}
      >
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 w-full overflow-visible"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
        >
          <ComposerColumnFrame>
            {/* A bare wrapper keeps the normal-flow panels' -mb-px seam onto the input shell
                via margin collapse. */}
            <div>
              {isSidechatExpired ? (
                <ExpiredSidechatNotice onStartNew={startReplacementSidechat} />
              ) : null}
              {showComposerLiveChangesHeader ? (
                <ComposerLiveChangesHeader
                  fileCount={activeTurnLiveDiffState.fileCount}
                  additions={activeTurnLiveDiffState.additions}
                  deletions={activeTurnLiveDiffState.deletions}
                  onReview={
                    activeTurnLiveDiffState.turnId ? onReviewComposerLiveChanges : undefined
                  }
                />
              ) : null}
              {renderActiveTaskListCard(showComposerLiveChangesHeader)}
              {workflowRunState ? (
                <WorkflowRunCard
                  workflowRun={workflowRunState}
                  compact={workflowRunCardCompact}
                  onCompactChange={setWorkflowRunCardCompact}
                  onOpenThread={onNavigateToThread}
                  onStop={onStopWorkflowRun}
                  onPause={onPauseWorkflowRun}
                  onResume={onResumeWorkflowRun}
                  onDismiss={onDismissWorkflowRun}
                  attachedToPrevious={
                    showComposerLiveChangesHeader || showComposerActiveTaskListCard
                  }
                />
              ) : null}
              {showComposerSubagentStrip ? (
                <ComposerSubagentStrip
                  items={composerSubagentStripItems}
                  compact={subagentStripCompact}
                  onCompactChange={setSubagentStripCompact}
                  onOpenThread={onNavigateToThread}
                  onBackgroundItem={onBackgroundSubagentStripItem}
                  onStopItem={onStopSubagentStripItem}
                  onStopAll={onStopAllSubagentStripItems}
                  attachedToPrevious={
                    showComposerLiveChangesHeader ||
                    showComposerActiveTaskListCard ||
                    showComposerWorkflowRunCard
                  }
                />
              ) : null}
              <ComposerQueuedHeader
                queuedTurns={queuedComposerTurns}
                onSteer={onSteerQueuedComposerTurn}
                onRemove={removeQueuedComposerTurn}
                onEdit={onEditQueuedComposerTurn}
                cwd={threadWorkspaceCwd ?? undefined}
                attachedToPrevious={
                  showComposerLiveChangesHeader ||
                  showComposerActiveTaskListCard ||
                  showComposerWorkflowRunCard ||
                  showComposerSubagentStrip
                }
              />
              {showComposerGoalHeader && activeThread ? (
                <ComposerGoalHeader
                  goal={activeThreadGoalText}
                  goalStartedAt={activeThread.goalStartedAt}
                  goalPausedAt={activeThread.goalPausedAt}
                  canPause={isServerThread}
                  onEdit={editThreadGoalInComposer}
                  onSetPaused={async (paused) => {
                    await setThreadGoalPaused(paused);
                  }}
                  onClear={clearThreadGoal}
                  attachedToPrevious={
                    showComposerLiveChangesHeader ||
                    showComposerActiveTaskListCard ||
                    showComposerWorkflowRunCard ||
                    showComposerSubagentStrip ||
                    queuedComposerTurns.length > 0
                  }
                />
              ) : null}
              {settledThreadBranchMismatch ? (
                <div className="pb-2">
                  <ComposerBranchMismatchBanner {...settledThreadBranchMismatch} />
                </div>
              ) : null}
              {/* Pending approvals and AskUserQuestion prompts both render as a detached
                  card floating just above the composer (padding gives the measured gap),
                  instead of a banner fused into the composer surface. An approval takes
                  precedence and suppresses the question card while one is active. */}
              {activePendingApproval ? (
                <div className="pb-2">
                  <ComposerPendingApprovalPanel
                    approval={activePendingApproval}
                    pendingCount={pendingApprovals.length}
                    isResponding={respondingRequestKeys.includes(
                      pendingRequestInstanceKey(
                        activePendingApproval.requestId,
                        activePendingApproval.lifecycleGeneration,
                      ),
                    )}
                    onRespond={onRespondToApproval}
                  />
                </div>
              ) : pendingUserInputs.length > 0 ? (
                <div className="pb-2">
                  <ComposerPendingUserInputPanel
                    pendingUserInputs={pendingUserInputs}
                    submissionVersion={userInputSubmissionVersion}
                    isResponding={activePendingIsResponding}
                    answers={activePendingDraftAnswers}
                    questionIndex={activePendingQuestionIndex}
                    onToggleOption={onToggleActivePendingUserInputOption}
                    onAdvance={onAdvanceActivePendingUserInput}
                    onPrevious={onPreviousActivePendingUserInputQuestion}
                    onCancel={onCancelActivePendingUserInput}
                  />
                </div>
              ) : null}
              {expiredQuestionDrafts[0] &&
              pendingUserInputs.length === 0 &&
              !activePendingApproval ? (
                <ComposerExpiredUserInputNotice
                  threadId={threadId}
                  requestKey={expiredQuestionDrafts[0][0]}
                  draft={expiredQuestionDrafts[0][1]}
                  onRestore={(nextPrompt) => {
                    promptRef.current = nextPrompt;
                    setComposerCursor(
                      collapseExpandedComposerCursor(nextPrompt, nextPrompt.length),
                    );
                    scheduleComposerFocus();
                  }}
                />
              ) : null}
              {emptyLandingControls}
            </div>
            <div
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                isSidechatExpired && "pointer-events-none opacity-60",
              )}
              aria-disabled={isSidechatExpired}
            >
              <div
                className={cn(
                  COMPOSER_INPUT_SURFACE_CLASS_NAME,
                  composerProviderState.composerSurfaceClassName,
                  composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                <ComposerInputBanners
                  roundedTopReset={false}
                  planFollowUp={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    showPlanFollowUpPrompt &&
                    activeProposedPlan
                      ? {
                          id: activeProposedPlan.id,
                          title: proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null,
                        }
                      : null
                  }
                  automationSetup={
                    !activePendingApproval &&
                    pendingUserInputs.length === 0 &&
                    pendingAutomationConversation &&
                    pendingAutomationConversation.threadId === threadId
                      ? { onCancel: cancelAutomationConversation }
                      : null
                  }
                />
                <div
                  className={cn(
                    COMPOSER_EDITOR_PADDING_CLASS_NAME,
                    composerOverlayOpen && !isComposerApprovalState && "overflow-visible",
                  )}
                >
                  {composerOverlayOpen && !isComposerApprovalState ? (
                    <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                      {composerExtrasPanelOpen ? (
                        <ComposerExtrasPanel
                          panelId={COMPOSER_EXTRAS_PANEL_ID}
                          interactionMode={interactionMode}
                          supportsFastMode={composerTraitSelection.caps.supportsFastMode}
                          fastModeEnabled={composerTraitSelection.fastModeEnabled}
                          threadId={threadId}
                          onAddAttachments={addComposerAttachments}
                          onToggleFastMode={toggleFastMode}
                          onInteractionModeChange={handleInteractionModeChange}
                          onClose={() => {
                            setIsComposerExtrasPanelOpen(false);
                            scheduleComposerFocus();
                          }}
                        />
                      ) : isLocalFolderBrowserOpen ? (
                        <ComposerLocalDirectoryMenu
                          mentionQuery={mentionTriggerQuery}
                          rootLabel={localFolderBrowseRootPath ?? "Local folders unavailable"}
                          homeDir={serverConfigQuery.data?.homeDir ?? null}
                          onSelectEntry={(absolutePath) =>
                            handleSelectLocalDirectoryMention(absolutePath)
                          }
                          onNavigateFolder={handleNavigateLocalFolder}
                          handleRef={localDirectoryMenuRef}
                        />
                      ) : (
                        <ComposerCommandMenu
                          items={composerMenuItems}
                          resolvedTheme={resolvedTheme}
                          isLoading={isComposerMenuLoading}
                          triggerKind={
                            composerCommandPicker !== null
                              ? "slash-command"
                              : effectiveComposerTriggerKind
                          }
                          activeItemId={activeComposerMenuItem?.id ?? null}
                          onHighlightedItemChange={onComposerMenuItemHighlighted}
                          onSelect={onSelectComposerItem}
                        />
                      )}
                    </div>
                  ) : null}
                  {!isComposerApprovalState &&
                    pendingUserInputs.length === 0 &&
                    isPreparingComposerImages && (
                      <div
                        className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
                        role="status"
                      >
                        <LoaderCircleIcon className="size-3.5 animate-spin" />
                        Optimizing {pendingComposerImageCount === 1 ? "image" : "images"}…
                      </div>
                    )}
                  {!isComposerApprovalState &&
                    pendingUserInputs.length === 0 &&
                    (composerAssistantSelections.length > 0 ||
                      composerBrowserAnnotations.length > 0 ||
                      composerFileComments.length > 0 ||
                      composerPastedTexts.length > 0 ||
                      composerPullRequestContexts.length > 0 ||
                      composerFiles.length > 0 ||
                      composerImages.length > 0) && (
                      <ComposerReferenceAttachments
                        assistantSelections={composerAssistantSelections}
                        browserAnnotations={composerBrowserAnnotations}
                        fileComments={composerFileComments}
                        pastedTexts={composerPastedTexts}
                        pullRequestContexts={composerPullRequestContexts}
                        files={composerFiles}
                        images={composerImages}
                        nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                        onExpandImage={setExpandedImage}
                        onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                        onRemoveBrowserAnnotation={removeComposerBrowserAnnotationFromDraft}
                        onRemoveFileComments={clearComposerFileCommentsFromDraft}
                        onRemovePastedText={removeComposerPastedTextFromDraft}
                        onShowPastedTextInField={showComposerPastedTextInField}
                        onRemovePullRequestContext={removeComposerPullRequestContextFromDraft}
                        onRemoveFile={removeComposerFile}
                        onRemoveImage={removeComposerImage}
                      />
                    )}
                  <ComposerPromptEditor
                    ref={composerEditorRef}
                    value={
                      isComposerApprovalState
                        ? ""
                        : activePendingProgress
                          ? activePendingProgress.customAnswer
                          : prompt
                    }
                    cursor={composerCursor}
                    terminalContexts={
                      !isComposerApprovalState && pendingUserInputs.length === 0
                        ? composerTerminalContexts
                        : []
                    }
                    mentionReferences={selectedComposerMentions}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPaste={onComposerPaste}
                    {...(canCollapsePastedTextToDraft
                      ? { onCollapsePastedText: addPastedTextToDraft }
                      : {})}
                    placeholder={
                      isComposerApprovalState
                        ? "Resolve this approval request to continue"
                        : activePendingProgress
                          ? activePendingProgress.activeQuestion?.options.length === 0
                            ? "Type your answer to continue"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : activeThread?.parentThreadId
                              ? "Message this subagent while it works"
                              : hasLiveTurn
                                ? "Ask for follow-up changes"
                                : phase === "disconnected"
                                  ? "Ask for follow-up changes or attach images"
                                  : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isComposerEditorDisabled}
                  />
                </div>
                {/* Bottom toolbar — hidden while an approval takes over the composer,
                    since the approve/decline actions live in the detached approval card
                    floating above (see ComposerPendingApprovalPanel). */}
                {activePendingApproval ? null : (
                  <ChatComposerFooter
                    isComposerFooterCompact={isComposerFooterCompact}
                    leadingControls={
                      relocateComposerLeadingControls
                        ? null
                        : renderComposerLeadingControls({ iconOnly: false })
                    }
                    composerPickerControls={composerPickerControls}
                    contextMeter={
                      !isVoiceRecording &&
                      !isVoiceTranscribing &&
                      runtimeUsageContextWindow &&
                      composerFooterControlsPlan.showContextMeter ? (
                        <ContextWindowMeter
                          usage={runtimeUsageContextWindow}
                          {...(activeCumulativeCostUsd != null
                            ? { cumulativeCostUsd: activeCumulativeCostUsd }
                            : {})}
                          {...(contextWindowSelectionStatus.activeLabel !== undefined
                            ? {
                                activeWindowLabel: contextWindowSelectionStatus.activeLabel,
                              }
                            : {})}
                          {...(contextWindowSelectionStatus.pendingSelectedLabel !== undefined
                            ? {
                                pendingWindowLabel:
                                  contextWindowSelectionStatus.pendingSelectedLabel,
                              }
                            : {})}
                        />
                      ) : null
                    }
                    interactionMode={interactionMode}
                    resetInteractionMode={resetInteractionMode}
                    sidebarAction={
                      activeTaskList || sidebarProposedPlan || planSidebarOpen
                        ? {
                            title: planSidebarToggleTitle,
                            label: planSidebarToggleLabel,
                            onClick: togglePlanSidebar,
                          }
                        : null
                    }
                    voice={{
                      enabled: showVoiceNotesControl,
                      recording: isVoiceRecording,
                      transcribing: isVoiceTranscribing,
                      durationLabel: voiceRecordingDurationLabel,
                      waveformLevels: voiceWaveformLevels,
                      onCancel: cancelComposerVoiceRecording,
                      onSubmit: submitComposerVoiceRecording,
                      onToggle: toggleComposerVoiceRecording,
                    }}
                    pendingInput={
                      activePendingProgress
                        ? {
                            progress: activePendingProgress,
                            responding: activePendingIsResponding,
                            answersComplete: Boolean(activePendingResolvedAnswers),
                          }
                        : null
                    }
                    submission={{
                      phase,
                      busy: isSendBusy,
                      connecting: isConnecting,
                      expired: isSidechatExpired,
                      preparingImages: isPreparingComposerImages,
                      preparingWorktree: isPreparingWorktree,
                      hasContent: composerSendState.hasSendableContent,
                      hasPendingUserInputs: pendingUserInputs.length > 0,
                      showPlanFollowUp: showPlanFollowUpPrompt,
                      hasPrompt: prompt.trim().length > 0,
                      onInterrupt: onInterruptFromStopControl,
                      onImplementInNewThread: onImplementPlanInNewThread,
                    }}
                  />
                )}
              </div>
            </div>
          </ComposerColumnFrame>
        </form>
      </div>
    ) : (
      <div
        aria-hidden="true"
        className="w-full overflow-visible"
        data-chat-composer-form="deferred"
      >
        <div
          className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, COMPOSER_COLUMN_FRAME_CLASS_NAME)}
          style={{ height: secondaryChromePlaceholderHeight }}
        />
      </div>
    );

  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      {/* Subtle accent tint over the whole pane while a file is dragged anywhere over it,
          signalling that dropping it will attach the file to the composer. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 z-50 transition-opacity duration-150",
          "bg-info/8 ring-1 ring-inset ring-info/30",
          isDragOverComposer ? "opacity-100" : "opacity-0",
        )}
      />
      <ChatSurfaceHeader
        hidden={hideHeader}
        className={cn(
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          !isEditorRail && CHAT_SURFACE_HEADER_PADDING_X_CLASS,
          "flex items-center",
          isEditorRail ? "h-10" : CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          isElectron && "drag-region",
          // The editor-rail chat header sits in the editor's second row (inside the
          // right-side chat pane), not flush against the window edges — the editor's
          // own top bar already reserves both desktop window-control gutters. Applying
          // them here just leaves redundant empty space on the sides.
          !isEditorRail && desktopTopBarTrafficLightGutterClassName,
          !isEditorRail && desktopTopBarWindowControlsGutterClassName,
        )}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThreadDisplayTitle}
          activeThreadEntryPoint={terminalState.entryPoint}
          activeProvider={activeThread.session?.provider ?? activeThread.modelSelection.provider}
          activeProjectName={isEditorRail ? undefined : activeProjectDisplayName}
          threadBreadcrumbs={threadBreadcrumbs}
          {...(isEditorRail
            ? { className: cn(CHAT_SURFACE_HEADER_PADDING_X_CLASS, "h-full") }
            : {})}
          isSidechat={Boolean(activeThread.sidechatSourceThreadId)}
          hideSidebarControls={isEditorRail}
          hideHandoffControls={terminalWorkspaceTerminalTabActive || isEditorRail}
          minimalChrome={isCenteredEmptyLanding}
          isGitRepo={isGitRepo}
          openInTarget={threadWorkspaceCwd}
          activeProjectScripts={isEditorRail ? undefined : activeProjectScripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          handoffBadgeLabel={handoffBadgeLabel}
          handoffActionLabel={handoffActionLabel}
          handoffDisabled={handoffDisabled}
          handoffActionTargetProviders={handoffTargetProviders}
          handoffBadgeSourceProvider={handoffBadgeSourceProvider}
          handoffBadgeTargetProvider={handoffBadgeTargetProvider}
          gitCwd={threadWorkspaceCwd}
          diffTotals={repoDiffTotals}
          showGitActions={showGitActions && !isEditorRail}
          showDiffToggle={!isEditorRail}
          diffOpen={resolvedDiffOpen}
          diffDisabledReason={diffDisabledReason}
          rightDockOpen={rightDockOpen}
          {...(onToggleRightDock ? { onToggleRightDock } : {})}
          environment={isEditorRail ? null : environmentHeaderState}
          surfaceMode={surfaceMode}
          chatLayoutAction={
            surfaceMode === "single" && onSplitSurface
              ? {
                  kind: "split",
                  label: "Split chat",
                  shortcutLabel: chatSplitShortcutLabel,
                  onClick: onSplitSurface,
                }
              : surfaceMode === "split" && isFocusedPane && onMaximizeSurface
                ? {
                    kind: "maximize",
                    label: "Expand this chat",
                    shortcutLabel: null,
                    onClick: onMaximizeSurface,
                  }
                : null
          }
          editorChatControls={
            isEditorRail && activeProject
              ? {
                  projectId: activeProject.id,
                  activeSurface: terminalWorkspaceTerminalTabActive ? "terminal" : "chat",
                  terminalAvailable: terminalState.terminalOpen,
                  terminalHasRunningActivity: terminalState.runningTerminalIds.length > 0,
                  onNewChat: onNewEditorChat,
                  onNewTerminal: onOpenEditorTerminal,
                  onOpenChat: onOpenEditorChat,
                  onOpenTerminal: onOpenEditorTerminal,
                  onCloseTerminal: onCloseEditorTerminal,
                }
              : null
          }
          changeThreadAction={
            surfaceMode === "split" && isFocusedPane && onChangeThreadInSplitPane
              ? {
                  label: "Change thread",
                  onClick: onChangeThreadInSplitPane,
                }
              : null
          }
          onRunProjectScript={onRunProjectScriptFromHeader}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleDiff={onToggleDiff}
          onRegisterCommitAndPushTrigger={onRegisterCommitAndPushTrigger}
          onCreateHandoff={onCreateHandoffThread}
          onNavigateToThread={onNavigateToThread}
          onRenameThread={() => setRenameDialogOpen(true)}
          {...(onCloseThreadPane ? { onCloseThreadPane } : {})}
        />
      </ChatSurfaceHeader>

      {/* Floating find panel — a root-level overlay so it sits on top of the
          header and the docked Environment panel at the pane's top-right. */}
      {shouldRenderChatPaneContent ? (
        <ChatThreadFindHost
          open={threadFindOpen}
          focusNonce={threadFindFocusNonce}
          timelineEntries={timelineEntries}
          threadId={threadId}
          className={cn(
            terminalWorkspaceTerminalTabActive && "invisible",
            !isEditorRail && desktopTopBarWindowControlsGutterClassName,
          )}
          onClose={() => setThreadFindOpen(false)}
          onJump={handleThreadFindJump}
          onHighlightChange={threadFindHighlightStore.set}
          onActiveMatchChange={handleThreadFindActiveMatchChange}
        />
      ) : null}

      <RenameThreadDialog
        open={renameDialogOpen}
        currentTitle={activeThread.title}
        onOpenChange={setRenameDialogOpen}
        onSave={handleRenameActiveThread}
      />
      {automationDraftForm ? (
        <AutomationDialog
          open={automationDraftOpen}
          form={automationDraftForm}
          projects={automationProjects}
          threads={automationThreads}
          warnings={automationDraftWarnings}
          acknowledgedWarningIds={acknowledgedAutomationWarnings}
          onToggleWarning={toggleAutomationWarning}
          onOpenChange={setAutomationDraftDialogOpen}
          onFormChange={updateAutomationDraftForm}
          onSubmit={submitAutomationDraft}
          busy={isAutomationDraftSubmitting}
        />
      ) : null}

      {/* Thread-level errors render as a toast (see `useThreadErrorToast`) so they
          never displace the transcript. */}
      <ProviderHealthBanner
        status={shouldShowProviderHealthBanner ? visibleActiveProviderStatus : null}
        onDismiss={dismissActiveProviderHealthBanner}
      />
      <RateLimitBanner
        rateLimitStatus={visibleActiveRateLimitStatus}
        onDismiss={dismissActiveRateLimitBanner}
      />
      {terminalWorkspaceOpen && !isEditorRail ? (
        <TerminalWorkspaceTabs
          activeTab={terminalState.workspaceActiveTab}
          isWorking={isWorking}
          terminalHasRunningActivity={terminalState.runningTerminalIds.length > 0}
          terminalCount={terminalState.terminalIds.length}
          workspaceLayout={terminalState.workspaceLayout}
          onSelectTab={setTerminalWorkspaceTab}
        />
      ) : null}
      {/* Main content area with optional plan sidebar */}
      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {/* Chat column */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            aria-hidden={terminalWorkspaceTerminalTabActive}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col",
              terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
            )}
          >
            {shouldRenderChatPaneContent && isCenteredEmptyLanding ? (
              <div
                className={cn(
                  "chat-pane-enter flex min-h-0 flex-1 flex-col",
                  CHAT_COLUMN_GUTTER_CLASS_NAME,
                )}
              >
                {/* The heading floats centered in the space above the composer, which is
                    anchored to the bottom of the pane (with its workspace-tools rail
                    stacked on top of the input) so starting a chat keeps the composer
                    where it lives for the rest of the conversation. */}
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <div
                    className={cn(
                      "flex flex-col items-center gap-4 px-6 text-center select-none",
                      CHAT_COLUMN_FRAME_CLASS_NAME,
                    )}
                  >
                    <SynaraLogo aria-label="Synara logo" className="size-10" />
                    <h2
                      data-testid="empty-landing-heading"
                      className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]"
                    >
                      {isEmptyChatLanding ? (
                        "What should we work on?"
                      ) : (
                        <>
                          What should we do in{" "}
                          {showEmptyLandingProjectPicker ? (
                            <ProjectPicker
                              align="center"
                              side="bottom"
                              selectionMode="project"
                              selectedProjectId={activeProject.id}
                              selectedWorkspaceRoot={activeProject.cwd}
                              showResetToHome
                              onSelectProject={handleSelectProjectForEmptyDraft}
                              onCreateProjectFromPath={handleCreateProjectFromPickerPath}
                              onResetToHome={handleResetWorkspaceToHome}
                              renderTrigger={
                                <button
                                  type="button"
                                  data-testid="empty-landing-heading-project-trigger"
                                  className="cursor-pointer rounded-sm text-inherit underline decoration-dotted decoration-[1.5px] underline-offset-[6px] transition-colors duration-150 ease-out hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
                                >
                                  {activeProjectDisplayName ?? "this folder"}
                                </button>
                              }
                            />
                          ) : (
                            <span className="text-inherit">
                              {activeProjectDisplayName ?? "this folder"}
                            </span>
                          )}
                          ?
                        </>
                      )}
                    </h2>
                  </div>
                </div>
                <div className="w-full shrink-0 pb-3 sm:pb-4">
                  {composerSection}
                  {relocateComposerLeadingControls ? (
                    <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                      <div className="flex w-full items-center gap-1">
                        <div className="flex shrink-0 items-center gap-1 pl-1">
                          {renderComposerLeadingControls({ iconOnly: true })}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {shouldRenderChatPaneContent && !isCenteredEmptyLanding ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatTranscriptPane
                    activeThreadId={activeThread.id}
                    activeTurnId={activeTurnIdForTranscript}
                    agentActivityDetail={openAgentActivityDetail}
                    hasMessages={timelineEntries.length > 0}
                    isWorking={isWorking}
                    workingLabel={resolveWorkingLabel({
                      isSendBusy,
                      turnTakenOver,
                      isConnecting,
                      providerName: providerDisplayName,
                    })}
                    worktreeSetup={activeWorktreeSetup}
                    worktreeSetupPendingAction={worktreeSetupPendingAction}
                    onResolveWorktreeSetup={onResolveWorktreeSetup}
                    activeTurnInProgress={activeTurnInProgress}
                    activeTurnStartedAt={activeWorkStartedAt}
                    listRef={legendListRef}
                    timelineControllerRef={timelineControllerRef}
                    findHighlightStore={threadFindHighlightStore}
                    pinnedMessageIds={pinnedMessageIds}
                    canPinMessage={canPinMessage}
                    onTogglePinMessage={handleTogglePinMessageGuarded}
                    onForkFromMessage={handleForkFromMessage}
                    goalAchievements={goalAchievements}
                    enteringUserMessageIds={enteringUserMessageIds}
                    tailAnchorMessageId={
                      tailAnchor !== null && tailAnchor.threadId === activeThread.id
                        ? tailAnchor.messageId
                        : null
                    }
                    tailAnchorScrollInFlightRef={tailAnchorScrollInFlightRef}
                    crossTaskOrigin={crossTaskOrigin}
                    forkSource={forkSource}
                    isTemporaryThread={isThreadTemporary}
                    timelineEntries={timelineEntries}
                    turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                    onOpenTurnDiff={onOpenTurnDiff}
                    onOpenThread={onNavigateToThread}
                    onOpenAutomation={onOpenAutomation}
                    revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                    onRevertUserMessage={onRevertUserMessage}
                    onUndoTurnFiles={onUndoTurnFiles}
                    onEditUserMessage={onEditUserMessage}
                    editableUserMessageId={editableUserMessageId}
                    isRevertingCheckpoint={isRevertingCheckpoint}
                    onExpandTimelineImage={onExpandTimelineImage}
                    followLiveOutput={hasStreamingAssistantText && !isUserScrollDetached}
                    onIsAtEndChange={onIsAtEndChange}
                    onNavigate={onTranscriptNavigate}
                    markdownCwd={threadWorkspaceCwd ?? undefined}
                    resolvedTheme={resolvedTheme}
                    chatFontSizePx={settings.chatFontSizePx}
                    timestampFormat={timestampFormat}
                    workspaceRoot={threadArtifactWorkspaceRoot ?? undefined}
                    keybindings={keybindings}
                    availableEditors={availableEditors}
                    emptyStateContent={transcriptEmptyStateContent}
                    emptyStateProjectName={activeProjectDisplayName}
                    terminalWorkspaceTerminalTabActive={terminalWorkspaceTerminalTabActive}
                    onMessagesScroll={onMessagesScroll}
                    onMessagesClickCapture={onMessagesClickCapture}
                    onMessagesMouseUp={onMessagesMouseUp}
                    onMessagesWheel={onMessagesWheel}
                    onMessagesPointerDown={onMessagesPointerDown}
                    onMessagesPointerUp={onMessagesPointerUp}
                    onMessagesPointerCancel={onMessagesPointerCancel}
                    onMessagesTouchStart={onMessagesTouchStart}
                    onMessagesTouchMove={onMessagesTouchMove}
                    onMessagesTouchEnd={onMessagesTouchEnd}
                    onOpenAgentActivity={setOpenAgentActivityId}
                    onCloseAgentActivityDetail={() => setOpenAgentActivityId(null)}
                    scrollButtonVisible={showScrollToBottom}
                    onScrollToBottom={onScrollToBottom}
                    contentInsetRightPx={
                      environmentAppliesContentInset
                        ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX
                        : undefined
                    }
                    contentInsetBottomPx={composerTranscriptInsetPx}
                    contentInsetBottomClearancePx={composerOverlayBottomClearancePx}
                  />
                </div>

                {/* Trailing block below the transcript: the composer floats on top of it
                    (`bottom-full`), so the transcript's scroll viewport — and therefore every
                    row scrolling behind the frosted composer — is clipped at the composer's
                    bottom edge. Nothing ever shows through this gutter or the BranchToolbar row. */}
                <div className="relative z-10 w-full shrink-0">
                  <div
                    ref={composerOverlayRef}
                    className={cn(
                      "pointer-events-none absolute inset-x-0 bottom-full w-full overflow-visible",
                      ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
                      CHAT_COLUMN_GUTTER_CLASS_NAME,
                    )}
                    // Match the transcript's right inset so the composer stays aligned with chat
                    // content (and clear of the docked Environment overlay).
                    style={
                      environmentAppliesContentInset
                        ? { paddingRight: ENVIRONMENT_DOCKED_CONTENT_INSET_PX }
                        : undefined
                    }
                  >
                    <div className="pointer-events-auto">{composerSection}</div>
                  </div>
                  {/* A trailing BranchToolbar only renders for legacy git threads; otherwise the
                      composer is the last element, so give it a comfortable bottom margin. */}
                  <div
                    className={cn(isGitRepo && !environmentEnabled ? "pt-0.5" : "pt-3 sm:pt-4")}
                  />
                  {secondaryChromeReady &&
                  ((isGitRepo && !environmentEnabled) || relocateComposerLeadingControls) ? (
                    <div className={CHAT_COLUMN_GUTTER_CLASS_NAME}>
                      <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                        <div className="flex w-full items-center gap-1">
                          {relocateComposerLeadingControls ? (
                            <div className="flex shrink-0 items-center gap-1 pl-1">
                              {renderComposerLeadingControls({ iconOnly: true })}
                            </div>
                          ) : null}
                          {isGitRepo && !environmentEnabled ? (
                            <BranchToolbar {...branchToolbarProps} className="min-w-0 flex-1" />
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {shouldRenderChatPaneContent && secondaryChromeReady && pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                cwd={threadArtifactWorkspaceRoot}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>

          {terminalWorkspaceOpen ? (
            <div
              aria-hidden={!terminalWorkspaceTerminalTabActive}
              className={cn(
                "absolute inset-0 min-h-0 min-w-0 transition-all duration-200 ease-out",
                terminalWorkspaceTerminalTabActive
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none translate-y-1 opacity-0",
              )}
            >
              <Suspense fallback={null}>
                <ThreadTerminalDrawer
                  key={`${activeThread.id}-workspace`}
                  {...terminalDrawerProps}
                  presentationMode="workspace"
                  isVisible={terminalWorkspaceTerminalTabActive}
                  onTogglePresentationMode={
                    terminalState.workspaceLayout === "both" ? collapseTerminalWorkspace : undefined
                  }
                />
              </Suspense>
            </div>
          ) : null}

          {/* Environment overlay — always mounted so open/close can transition in lockstep with inset. */}
          {environmentEnabled ? (
            <EnvironmentPanel
              {...environmentPanelProps}
              open={environmentPanelVisible}
              variant={environmentOverlayVariant}
            />
          ) : null}
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activeTaskList={activeTaskList}
            activeProposedPlan={sidebarProposedPlan}
            markdownCwd={threadWorkspaceCwd ?? undefined}
            workspaceRoot={threadArtifactWorkspaceRoot ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activeTaskList?.turnId ?? sidebarProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {(() => {
        if (!terminalState.terminalOpen || terminalWorkspaceOpen) {
          return null;
        }
        return (
          <Suspense fallback={null}>
            <ThreadTerminalDrawer
              key={activeThread.id}
              {...terminalDrawerProps}
              presentationMode="drawer"
              onTogglePresentationMode={expandTerminalWorkspace}
            />
          </Suspense>
        );
      })()}

      <ComposerSlashStatusDialog
        open={isSlashStatusDialogOpen}
        onOpenChange={setIsSlashStatusDialogOpen}
        selectedModel={selectedModel}
        fastModeEnabled={fastModeEnabled}
        selectedPromptEffort={selectedPromptEffort}
        interactionMode={interactionMode}
        envMode={envMode}
        envState={envState}
        branch={activeThread?.branch ?? activeRootBranch}
        contextWindow={activeContextWindow}
        cumulativeCostUsd={activeCumulativeCostUsd}
        rateLimitStatus={activeRateLimitStatus}
        activeContextWindowLabel={contextWindowSelectionStatus.activeLabel}
        pendingContextWindowLabel={contextWindowSelectionStatus.pendingSelectedLabel}
      />
      <ThreadWorktreeHandoffDialog
        open={worktreeHandoffDialogOpen}
        worktreeName={worktreeHandoffName}
        busy={handoffBusy}
        onWorktreeNameChange={setWorktreeHandoffName}
        onOpenChange={setWorktreeHandoffDialogOpen}
        onConfirm={confirmWorktreeHandoff}
      />
      {!isInactiveSplitPane && activeProject && !isSidechatExpired ? (
        <TranscriptSelectionActionLayer
          key={threadId}
          action={pendingTranscriptSelectionAction}
          defaultEnvMode={selectionChatEnvMode ?? settings.defaultThreadEnvMode}
          canUseWorktree={isGitRepo && !isContainerLandingProject}
          canAddToSide={isServerThread && !activeThread.sidechatSourceThreadId}
          onDismiss={dismissTranscriptSelectionAction}
          onAddToChat={commitTranscriptAssistantSelection}
          onAddToSide={(selection) =>
            addSelectionToSide({
              selection,
              project: activeProject,
              sourceThread: activeThread,
              selectedModelSelection,
            })
          }
          onNewChat={(selection, prompt, envMode, intent) =>
            startSelectionChat({
              selection,
              prompt,
              envMode,
              intent,
              projectId: activeProject.id,
              projectCwd: activeProject.cwd,
              modelSelection: selectedModelSelection,
              selectedPromptEffort,
              providerOptionsForDispatch,
              runtimeMode,
              createThread: handleNewThread,
            })
          }
        />
      ) : null}
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </div>
  );
}
