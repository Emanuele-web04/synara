import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  type ModelSelection,
  type ProjectScript,
  type ModelSlug,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderAgentDescriptor,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  type ProviderStartOptions,
  type ProviderUserInputAnswers,
  type PinnedMessage,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  ThreadId,
  ThreadMarkerId,
  type ThreadMarker,
  type ThreadMarkerColor,
  type ThreadMarkerStyle,
  type TurnId,
  type EditorId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { getModelCapabilities, normalizeModelSlug } from "@t3tools/shared/model";
import { resolveTailUserMessageEditTarget } from "@t3tools/shared/conversationEdit";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import {
  buildPromptThreadTitleFallback,
  GENERIC_CHAT_THREAD_TITLE,
} from "@t3tools/shared/chatThreads";
import {
  resolveThreadWorkspaceState,
  resolveThreadBranchSourceCwd,
  resolveThreadWorkspaceCwd as resolveSharedThreadWorkspaceCwd,
} from "@t3tools/shared/threadEnvironment";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { GoTasklist } from "react-icons/go";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Debouncer, useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate } from "@tanstack/react-router";
import { type LegendListRef } from "@legendapp/list/react";
import {
  GIT_WORKING_TREE_DIFF_LIVE_REFETCH_INTERVAL_MS,
  gitCreateWorktreeMutationOptions,
  gitGithubRepositoryQueryOptions,
  gitBranchesQueryOptions,
} from "~/lib/gitReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  providerAgentsQueryOptions,
  providerComposerCapabilitiesQueryOptions,
  providerCommandsQueryOptions,
  providerModelsQueryOptions,
  providerPluginsQueryOptions,
  providerSkillsQueryOptions,
  supportsNativeSlashCommandDiscovery,
  supportsPluginDiscovery,
  supportsSkillDiscovery,
  supportsThreadCompaction,
} from "~/lib/providerDiscoveryReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import {
  formatComposerMentionToken,
  filterPromptProviderMentionReferences,
  filterPromptSkillReferences,
  providerMentionReferencesEqual,
  providerSkillReferencesEqual,
  skillMentionPrefix,
} from "~/lib/composerMentions";
import { getLocalFolderBrowseRootPath, isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import {
  findProviderStatus,
  isProviderUsable,
  normalizeCustomBinaryPath,
  normalizeProviderStatusForLocalConfig,
  resolveProviderSendAvailability,
} from "~/lib/providerAvailability";
import {
  loadConfirmedCustomBinaryPaths,
  saveConfirmedCustomBinaryPaths,
} from "../confirmedCustomBinaryPathStore";
import { isElectron } from "../env";
import { stripDiffSearchParams } from "../diffRouteSearch";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { resolveFirstSendTarget } from "../lib/chatFirstSend";
import {
  maybeResolveBrowserPromptAttachment,
  type BrowserPromptAttachmentResolution,
} from "../lib/browserPromptContext";
import { deriveComposerSuggestions, type ComposerSuggestion } from "../lib/composerSuggestions";
import {
  IMAGE_SIZE_LIMIT_LABEL,
  buildComposerImageAttachmentsFromFiles,
  buildUploadComposerAttachments,
  cloneComposerImageAttachment,
  formatOutgoingComposerPrompt,
  readFileAsDataUrl,
} from "../lib/composerSend";
import { dispatchThreadRename } from "../lib/threadRename";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useComposerDropzone } from "../hooks/useComposerDropzone";
import { useDiffRouteSearch } from "../hooks/useDiffRouteSearch";
import {
  buildThreadBreadcrumbs,
  enrichSubagentWorkEntries,
  resolveActiveThreadTitle,
  resolveActiveTurnLiveDiffState,
  resolveCommittedProviderModel,
  resolveDefaultEnvironmentPanelOpen,
  resolveEnvironmentPanelVisible,
  resolveProjectScriptTerminalTarget,
  shouldConsumePendingCustomBinaryConfirmation,
  shouldShowComposerModelBootstrapSkeleton,
} from "./ChatView.logic";
import {
  createRelevantWorkLogThreadsSelector,
  createThreadLineageSelector,
} from "./ChatView.selectors";
import {
  clampCollapsedComposerCursor,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
  stripComposerTriggerText,
} from "../composer-logic";
import {
  ensureLeadingSpaceForReplacement,
  extendReplacementRangeForTrailingSpace,
} from "../composerTriggerInsertion";
import {
  createAllThreadsSelector,
  createProjectSelector,
  createThreadSelector,
} from "../storeSelectors";
import {
  canOfferForkSlashCommand,
  canOfferSideSlashCommand,
  canOfferReviewSlashCommand,
  hasProviderNativeSlashCommand,
  resolveComposerSlashRootBranch,
} from "../composerSlashCommands";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  derivePhase,
  deriveTimelineEntries,
  deriveActiveWorkStartedAt,
  deriveActiveTaskListState,
  deriveActiveBackgroundTasksState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  buildSourceProposedPlanReference,
  hasActionableProposedPlan,
  hasLiveTurnTailWork,
  isLatestTurnSettled,
  type ActiveTaskListState,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  hasCompletePendingUserInputAnswers,
  omitNullPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { selectRightDockState, useRightDockStore } from "../rightDockStore";
import { useStore } from "../store";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { getThreadFromState } from "../threadDerivation";
import { useWorkspaceStore } from "../workspaceStore";
import {
  buildPlanImplementationThreadTitle,
  buildPlanImplementationPrompt,
  proposedPlanTitle,
  resolvePlanFollowUpSubmission,
} from "../proposedPlan";
import { truncateTitle } from "../truncateTitle";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ChatMessage,
  type Thread,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useThreadWorkspaceHandoff } from "../hooks/useThreadWorkspaceHandoff";
import { useComposerCommandMenuItems } from "../hooks/useComposerCommandMenuItems";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar, { RuntimeUsageControls } from "./BranchToolbar";
import { SynaraLogo } from "./SynaraLogo";
import { ThreadWorktreeHandoffDialog } from "./ThreadWorktreeHandoffDialog";
import {
  formatShortcutLabel,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import PlanSidebar from "./PlanSidebar";
import TerminalWorkspaceTabs from "./TerminalWorkspaceTabs";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ComposerSendArrowIcon,
  LayoutSidebarIcon,
  RefreshCwIcon,
  XIcon,
} from "~/lib/icons";
import { ComposerQueuedHeader } from "./chat/ComposerQueuedHeader";
import { ComposerLiveChangesHeader } from "./chat/ComposerLiveChangesHeader";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { disposeAndCloseTerminalSession, randomTerminalId } from "./terminal/terminalSession";
import { cn, isMacPlatform, randomUUID } from "~/lib/utils";
import { toastManager } from "./ui/toast";
import { decodeProjectScriptKeybindingRule } from "~/lib/projectScriptKeybindings";
import { type NewProjectScriptInput } from "./ProjectScriptsControl";
import {
  commandForProjectScript,
  nextProjectScriptId,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "~/projectScripts";
import { runProjectCommandInTerminal } from "~/projectTerminalRunner";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
  shouldPromptForTerminalClose,
} from "~/lib/terminalCloseConfirmation";
import { promoteThreadCreate } from "~/lib/threadCreatePromotion";
import {
  getAppModelOptions,
  getCustomBinaryPathForProvider,
  getCustomModelsByProvider,
  getProviderStartOptions,
  resolveAppModelSelection,
  resolveAssistantDeliveryMode,
  useAppSettings,
} from "../appSettings";
import { resolveTerminalNewAction } from "../lib/terminalNewAction";
import { isTerminalFocused } from "../lib/terminalFocus";
import { compareProvidersByOrder } from "../providerOrdering";
import {
  type ComposerImageAttachment,
  type ComposerAssistantSelectionAttachment,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  type QueuedComposerChatTurn,
  type QueuedComposerPlanFollowUp,
  type QueuedComposerTurn,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../composerDraftStore";
import { useComposerFocusRequestStore } from "../composerFocusRequestStore";
import { appendComposerPromptText } from "../lib/chatReferences";
import {
  appendOriginalTerminalContextBlock,
  appendTerminalContextsToPrompt,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  formatTerminalContextLabel,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
  type TerminalContextDraft,
  type TerminalContextSelection,
} from "../lib/terminalContext";
import {
  appendAssistantSelectionsToPrompt,
  formatAssistantSelectionQueuePreview,
  formatAssistantSelectionTitleSeed,
} from "../lib/assistantSelections";
import {
  appendFileCommentsToPrompt,
  formatFileCommentLabel,
  formatFileCommentTitleSeed,
  type FileCommentDraft,
} from "../lib/fileComments";
import {
  deriveContextWindowSelectionStatus,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowSnapshot,
  deriveSelectedContextWindowSnapshot,
} from "../lib/contextWindow";
import { formatVoiceRecordingDuration, useVoiceRecorder } from "../lib/voiceRecorder";
import {
  composerFooterPlanForTier,
  resolveNextComposerFooterTier,
  shouldUseCompactComposerFooter,
} from "./composerFooterLayout";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { collectTerminalIdsFromLayout } from "../terminalPaneLayout";
import {
  resolveSplitViewFocusedThreadId,
  selectSplitView,
  type SplitViewPanePanelState,
  useSplitViewStore,
} from "../splitViewStore";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { ChatHeader } from "./chat/ChatHeader";
import { dispatchThreadNotes } from "~/pinnedMessages";
import {
  mergeProjectInstructionsIntoThreadNotes,
  useProjectInstructionsStore,
} from "~/projectInstructionsStore";
import {
  ENVIRONMENT_DOCKED_CONTENT_INSET_PX,
  EnvironmentPanel,
  type EnvironmentPanelProps,
} from "./chat/environment/EnvironmentPanel";
import { usePinnedMessageActions } from "./chat/environment/usePinnedMessageActions";
import { useIsDisposableThread } from "~/hooks/useIsDisposableThread";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
} from "./chat/chatHeaderControls";
import { SidebarHeaderNavigationControls } from "./SidebarHeaderNavigationControls";
import { SidebarHeaderTrigger } from "./ui/sidebar";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useThreadRecap } from "~/hooks/useThreadRecap";
import { useRepoDiffTotals } from "~/hooks/useRepoDiffTotals";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import type { MessagesTimelineController } from "./chat/MessagesTimeline";
import { buildTurnDiffSummaryByAssistantMessageId } from "./chat/MessagesTimeline.logic";
import { deriveAgentActivityTimelineState } from "./chat/agentActivity.logic";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import {
  AVAILABLE_PROVIDER_OPTIONS,
  ProviderModelPicker,
  resolveProviderModelLabel,
} from "./chat/ProviderModelPicker";
import { ComposerModelEffortPicker } from "./chat/ComposerModelEffortPicker";
import { resolveTraitsTriggerSummary, TraitsPicker } from "./chat/TraitsPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { ContextWindowMeter } from "./chat/ContextWindowMeter";
import { ComposerInputBanners } from "./chat/ComposerInputBanners";
import { ComposerVoiceButton } from "./chat/ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./chat/ComposerVoiceRecorderBar";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { ComposerSuggestions } from "./chat/ComposerSuggestions";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { ComposerActiveTaskListCard } from "./chat/ComposerActiveTaskListCard";
import { ComposerColumnFrame } from "./chat/ComposerColumnFrame";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import { resolveTranscriptMarkerRange } from "./chat/chatSelectionActions";
import {
  dispatchThreadMarkerAdd,
  dispatchThreadMarkerDoneSet,
  dispatchThreadMarkerLabelSet,
  dispatchThreadMarkerRemove,
} from "../threadMarkers";
import { getComposerProviderState } from "./chat/composerProviderRegistry";
import {
  COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME,
  CHAT_BACKGROUND_CLASS_NAME,
  CHAT_COLUMN_FRAME_CLASS_NAME,
  CHAT_COLUMN_GUTTER_CLASS_NAME,
  ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
} from "./chat/composerPickerStyles";
import { getComposerTraitSelection } from "./chat/composerTraits";
import { resolveRuntimeModelDescriptor } from "./chat/runtimeModelCapabilities";
import { ProjectPicker } from "./chat/ProjectPicker";
import { FolderClosed } from "./FolderClosed";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import {
  RateLimitBanner,
  deriveLatestRateLimitStatus,
  type RateLimitStatus,
} from "./chat/RateLimitBanner";
import {
  ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS,
  appendVoiceTranscriptToPrompt,
  describeVoiceRecordingStartError,
  isVoiceAuthExpiredMessage,
  sanitizeVoiceErrorMessage,
  shouldStartActiveTurnLayoutGrace,
  shouldAutoDeleteTerminalThreadOnLastClose,
  buildExpiredTerminalContextToastCopy,
  buildLocalDraftThread,
  DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
  DismissedProviderHealthBannersSchema,
  shouldRenderTerminalWorkspace,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  filterSidechatTranscriptMessages,
  hasServerAcknowledgedLocalDispatch,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  shouldRenderProviderHealthBanner,
  resolveRuntimeModeAfterApprovalDecision,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
import { useFeatureFlags } from "../featureFlags";
import { mergeCursorModelVariantsWithBaseControls } from "../cursorModelVariants";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  canCreateThreadHandoff,
  resolveAvailableHandoffTargetProviders,
  resolveThreadHandoffBadgeLabel,
} from "../lib/threadHandoff";
import {
  resolveDiffEnvironmentState,
  resolveThreadEnvironmentMode,
} from "../lib/threadEnvironment";
import {
  buildModelSelection,
  buildNextProviderOptions,
  mergeDynamicModelOptions,
  type ProviderModelOption,
} from "../providerModelOptions";
import {
  isDuplicateProjectCreateError,
  waitForRecoverableProjectForDuplicateCreate,
} from "../lib/projectCreateRecovery";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_PINNED_MESSAGES: readonly PinnedMessage[] = [];
const EMPTY_THREAD_MARKERS: readonly ThreadMarker[] = [];
const EMPTY_PINNED_TEXT: ReadonlyMap<MessageId, string> = new Map();
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
const EMPTY_COMPOSER_SUGGESTIONS: ComposerSuggestion[] = [];
const EMPTY_SUGGESTION_SOURCE_THREADS: Thread[] = [];
const selectEmptyComposerSuggestionThreads: ReturnType<typeof createAllThreadsSelector> = () =>
  EMPTY_SUGGESTION_SOURCE_THREADS;

function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
  if (previewUrls.length === 0 || typeof window === "undefined") {
    return;
  }
  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }, 0);
  });
}

function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

function canHandleComposerPickerShortcut(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  if (eventTargetsComposer(event, composerForm)) return true;
  const target = event.target;
  return (
    target === document.body ||
    target === document.documentElement ||
    document.activeElement === document.body ||
    document.activeElement === document.documentElement
  );
}
const EMPTY_AVAILABLE_EDITORS: EditorId[] = [];
const EMPTY_PROVIDER_STATUSES: ServerProviderStatus[] = [];
const EMPTY_PROVIDER_AGENTS: readonly ProviderAgentDescriptor[] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
const MAX_DISMISSED_PROVIDER_HEALTH_BANNERS = 50;

function getThreadProviderCustomBinaryPathKey(threadId: Thread["id"], provider: ProviderKind) {
  return `${threadId}:${provider}`;
}

function getConfirmedCustomBinarySessionKey(
  thread: Thread | null | undefined,
  provider: ProviderKind,
): string | null {
  const session = thread?.session;
  if (!thread || session?.provider !== provider) {
    return null;
  }
  if (session.status !== "ready" && session.status !== "running") {
    return null;
  }
  return getThreadProviderCustomBinaryPathKey(thread.id, provider);
}

function getProviderStartOptionsCustomBinaryPath(
  providerOptions: ProviderStartOptions | undefined,
  provider: ProviderKind,
): string | null {
  switch (provider) {
    case "codex":
      return normalizeCustomBinaryPath(providerOptions?.codex?.binaryPath);
    case "claudeAgent":
      return normalizeCustomBinaryPath(providerOptions?.claudeAgent?.binaryPath);
    case "gemini":
      return normalizeCustomBinaryPath(providerOptions?.gemini?.binaryPath);
    case "grok":
      return normalizeCustomBinaryPath(providerOptions?.grok?.binaryPath);
    case "kilo":
      return normalizeCustomBinaryPath(providerOptions?.kilo?.binaryPath);
    case "opencode":
      return normalizeCustomBinaryPath(providerOptions?.opencode?.binaryPath);
    case "cursor":
      return normalizeCustomBinaryPath(providerOptions?.cursor?.binaryPath);
    case "pi":
      return normalizeCustomBinaryPath(providerOptions?.pi?.binaryPath);
  }
}

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

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];

function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  assistantSelections: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  fileComments: ReadonlyArray<FileCommentDraft>;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  const firstImage = input.images[0];
  if (firstImage) {
    return `Image: ${firstImage.name}`;
  }
  if (input.assistantSelections.length > 0) {
    return formatAssistantSelectionQueuePreview(input.assistantSelections.length);
  }
  const firstTerminalContext = input.terminalContexts[0];
  if (firstTerminalContext) {
    return formatTerminalContextLabel(firstTerminalContext);
  }
  const firstFileComment = input.fileComments[0];
  if (firstFileComment) {
    return formatFileCommentLabel(firstFileComment);
  }
  return "Queued follow-up";
}

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
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

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

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
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  presentationMode?: "default" | "editor";
  isFocusedPane?: boolean;
  panelState?: SplitViewPanePanelState;
  onToggleDiffPanel?: () => void;
  onToggleBrowserPanel?: () => void;
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

export default function ChatView({
  threadId,
  paneScopeId = "single",
  surfaceMode = "single",
  presentationMode = "default",
  isFocusedPane = true,
  panelState,
  onToggleDiffPanel,
  onToggleBrowserPanel,
  onOpenBrowserUrl,
  onOpenTurnDiffPanel,
  onSplitSurface,
  onMaximizeSurface,
  viewModeAction = null,
  onChangeThreadInSplitPane,
  onCloseThreadPane,
}: ChatViewProps) {
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const { settings } = useAppSettings();
  const assistantDeliveryMode = resolveAssistantDeliveryMode(settings);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { createThreadHandoff } = useThreadHandoff();
  const rawSearch = useDiffRouteSearch();
  const activeSplitView = useSplitViewStore(selectSplitView(rawSearch.splitViewId ?? null));
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const isEditorRail = presentationMode === "editor";
  const isInactiveSplitPane = surfaceMode === "split" && !isFocusedPane;
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerAssistantSelections = composerDraft.assistantSelections;
  const composerFileComments = composerDraft.fileComments;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerSkills = composerDraft.skills;
  const composerMentions = composerDraft.mentions;
  const queuedComposerTurns = composerDraft.queuedTurns;
  const {
    isRecording: isVoiceRecording,
    durationMs: voiceRecordingDurationMs,
    waveformLevels: voiceWaveformLevels,
    startRecording: startVoiceRecording,
    stopRecording: stopVoiceRecording,
    cancelRecording: cancelVoiceRecording,
  } = useVoiceRecorder();
  const [isVoiceTranscribing, setIsVoiceTranscribing] = useState(false);
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        assistantSelectionCount: composerAssistantSelections.length,
        fileCommentCount: composerFileComments.length,
        terminalContexts: composerTerminalContexts,
      }),
    [
      composerAssistantSelections.length,
      composerFileComments.length,
      composerImages.length,
      composerTerminalContexts,
      prompt,
    ],
  );
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;
  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftProviderModelOptions = useComposerDraftStore(
    (store) => store.setProviderModelOptions,
  );
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const enqueueQueuedComposerTurn = useComposerDraftStore((store) => store.enqueueQueuedTurn);
  const insertQueuedComposerTurn = useComposerDraftStore((store) => store.insertQueuedTurn);
  const removeQueuedComposerTurnFromDraft = useComposerDraftStore(
    (store) => store.removeQueuedTurn,
  );
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const addComposerDraftAssistantSelection = useComposerDraftStore(
    (store) => store.addAssistantSelection,
  );
  const clearComposerDraftAssistantSelections = useComposerDraftStore(
    (store) => store.clearAssistantSelections,
  );
  const addComposerDraftFileComment = useComposerDraftStore((store) => store.addFileComment);
  const clearComposerDraftFileComments = useComposerDraftStore((store) => store.clearFileComments);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const addComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.addTerminalContexts,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const setComposerDraftSkills = useComposerDraftStore((store) => store.setSkills);
  const setComposerDraftMentions = useComposerDraftStore((store) => store.setMentions);
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const clearComposerDraftContent = useComposerDraftStore((store) => store.clearComposerContent);
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const getDraftThreadByProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByProjectId,
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const setProjectDraftThreadId = useComposerDraftStore((store) => store.setProjectDraftThreadId);
  const clearProjectDraftThreadId = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadId,
  );
  const draftThread = useComposerDraftStore(
    (store) => store.draftThreadsByThreadId[threadId] ?? null,
  );
  const serverThread = useStore(useMemo(() => createThreadSelector(threadId), [threadId]));
  const fallbackDraftProjectId = draftThread?.projectId ?? null;
  const fallbackDraftProject = useStore(
    useMemo(() => createProjectSelector(fallbackDraftProjectId), [fallbackDraftProjectId]),
  );
  const promptRef = useRef(prompt);
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const [optimisticUserMessages, setOptimisticUserMessages] = useState<ChatMessage[]>([]);
  const optimisticUserMessagesRef = useRef(optimisticUserMessages);
  optimisticUserMessagesRef.current = optimisticUserMessages;
  const composerAssistantSelectionsRef = useRef<ComposerAssistantSelectionAttachment[]>(
    composerAssistantSelections,
  );
  const composerTerminalContextsRef = useRef<TerminalContextDraft[]>(composerTerminalContexts);
  const composerFileCommentsRef = useRef<FileCommentDraft[]>(composerFileComments);
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const [isLocalConnecting, _setIsLocalConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const pendingUserInputAnswersByRequestIdRef = useRef(pendingUserInputAnswersByRequestId);
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [activeTaskListCompact, setActiveTaskListCompact] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  // Width-aware visibility for the footer picker cluster (context meter,
  // model name, traits label). Inputs live in a ref so the resize observer
  // can re-plan without re-subscribing; the sync function is exposed via ref
  // so label changes can re-plan without a resize.
  const [composerFooterTier, setComposerFooterTier] = useState(0);
  const composerFooterTierRef = useRef(0);
  const composerFooterDemotionWidthsRef = useRef<ReadonlyArray<number | undefined>>([]);
  const composerFooterLayoutSyncRef = useRef<(() => void) | null>(null);
  const [confirmedCustomBinaryPathsByProvider, setConfirmedCustomBinaryPathsByProvider] = useState<
    Partial<Record<ProviderKind, string>>
  >(loadConfirmedCustomBinaryPaths);
  const confirmedCustomBinarySessionKeysRef = useRef<Set<string>>(new Set());
  const pendingCustomBinaryPathsByThreadProviderRef = useRef<Map<string, string>>(new Map());
  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
  const [secondaryChromePlaceholderHeight, setSecondaryChromePlaceholderHeight] = useState(88);
  // Tracks whether the user explicitly dismissed the sidebar for the active turn.
  const planSidebarDismissedForTurnRef = useRef<string | null>(null);
  // When set, the thread-change reset effect will open the sidebar instead of closing it.
  // Used by "Implement in a new thread" to carry the sidebar-open intent across navigation.
  const planSidebarOpenOnNextThreadRef = useRef(false);
  const [terminalFocusRequestId, setTerminalFocusRequestId] = useState(0);
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [pullRequestDialogState, setPullRequestDialogState] =
    useState<PullRequestDialogState | null>(null);
  const [attachmentPreviewHandoffByMessageId, setAttachmentPreviewHandoffByMessageId] = useState<
    Record<string, string[]>
  >({});
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [selectedComposerSkills, setSelectedComposerSkills] = useState<ProviderSkillReference[]>(
    () => composerSkills,
  );
  const [selectedComposerMentions, setSelectedComposerMentions] = useState<
    ProviderMentionReference[]
  >(() => composerMentions);
  const selectedComposerSkillsRef = useRef<ProviderSkillReference[]>(selectedComposerSkills);
  const selectedComposerMentionsRef = useRef<ProviderMentionReference[]>(selectedComposerMentions);
  selectedComposerSkillsRef.current = selectedComposerSkills;
  selectedComposerMentionsRef.current = selectedComposerMentions;
  const updateSelectedComposerSkills = useCallback(
    (
      next:
        | ProviderSkillReference[]
        | ((existing: ProviderSkillReference[]) => ProviderSkillReference[]),
    ) => {
      const existing = selectedComposerSkillsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerSkillsRef.current = resolved;
      setSelectedComposerSkills(resolved);
      setComposerDraftSkills(threadId, resolved);
    },
    [setComposerDraftSkills, threadId],
  );
  const updateSelectedComposerMentions = useCallback(
    (
      next:
        | ProviderMentionReference[]
        | ((existing: ProviderMentionReference[]) => ProviderMentionReference[]),
    ) => {
      const existing = selectedComposerMentionsRef.current;
      const resolved = typeof next === "function" ? next(existing) : next;
      selectedComposerMentionsRef.current = resolved;
      setSelectedComposerMentions(resolved);
      setComposerDraftMentions(threadId, resolved);
    },
    [setComposerDraftMentions, threadId],
  );
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const [dismissedProviderHealthBannerKeys, setDismissedProviderHealthBannerKeys] = useLocalStorage(
    DISMISSED_PROVIDER_HEALTH_BANNERS_KEY,
    [],
    DismissedProviderHealthBannersSchema,
  );
  const [dismissedRateLimitBannerKey, setDismissedRateLimitBannerKey] = useState<string | null>(
    null,
  );
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);
  const legendListRef = useRef<LegendListRef | null>(null);
  const timelineControllerRef = useRef<MessagesTimelineController | null>(null);
  const isAtEndRef = useRef(true);
  const autoFollowThreadIdRef = useRef<ThreadId | null>(null);
  const pendingInteractionAnchorRef = useRef<{
    element: HTMLElement;
    top: number;
  } | null>(null);
  const pendingInteractionAnchorFrameRef = useRef<number | null>(null);
  const showScrollDebouncer = useRef(
    new Debouncer(() => setShowScrollToBottom(true), { wait: 150 }),
  );

  useEffect(() => {
    setComposerCommandPicker(null);
    setIsModelPickerOpen(false);
    setIsTraitsPickerOpen(false);
  }, [threadId]);
  useEffect(() => {
    const scrollDebouncer = showScrollDebouncer.current;
    return () => {
      scrollDebouncer.cancel();
      const pendingFrame = pendingInteractionAnchorFrameRef.current;
      if (pendingFrame !== null) {
        window.cancelAnimationFrame(pendingFrame);
      }
    };
  }, []);
  useEffect(() => {
    // Thread-bound handoff dialog state is reset by the dedicated hook.
  }, [threadId]);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const pendingComposerFocusRef = useRef(false);
  const composerFormHeightRef = useRef(0);
  const composerImagesRef = useRef<ComposerImageAttachment[]>([]);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const queuedComposerTurnsRef = useRef<QueuedComposerTurn[]>([]);
  const autoDispatchingQueuedTurnRef = useRef(false);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const localDirectoryMenuRef = useRef<ComposerLocalDirectoryMenuHandle | null>(null);
  const attachmentPreviewHandoffByMessageIdRef = useRef<Record<string, string[]>>({});
  const attachmentPreviewHandoffTimeoutByMessageIdRef = useRef<Record<string, number>>({});
  const sendInFlightRef = useRef(false);
  const dragDepthRef = useRef(0);
  const terminalOpenByThreadRef = useRef<Record<string, boolean>>({});
  const activatedThreadIdRef = useRef<ThreadId | null>(null);

  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadId, threadId),
  );
  const storeSetTerminalOpen = useTerminalStateStore((s) => s.setTerminalOpen);
  const storeSetTerminalPresentationMode = useTerminalStateStore(
    (s) => s.setTerminalPresentationMode,
  );
  const storeSetTerminalWorkspaceLayout = useTerminalStateStore(
    (s) => s.setTerminalWorkspaceLayout,
  );
  const storeOpenChatThreadPage = useTerminalStateStore((s) => s.openChatThreadPage);
  const storeOpenTerminalThreadPage = useTerminalStateStore((s) => s.openTerminalThreadPage);
  const storeSetTerminalWorkspaceTab = useTerminalStateStore((s) => s.setTerminalWorkspaceTab);
  const storeSetTerminalHeight = useTerminalStateStore((s) => s.setTerminalHeight);
  const storeSetTerminalMetadata = useTerminalStateStore((s) => s.setTerminalMetadata);
  const storeSetTerminalActivity = useTerminalStateStore((s) => s.setTerminalActivity);
  const storeSplitTerminalLeft = useTerminalStateStore((s) => s.splitTerminalLeft);
  const storeSplitTerminalRight = useTerminalStateStore((s) => s.splitTerminalRight);
  const storeSplitTerminalDown = useTerminalStateStore((s) => s.splitTerminalDown);
  const storeSplitTerminalUp = useTerminalStateStore((s) => s.splitTerminalUp);
  const storeNewTerminal = useTerminalStateStore((s) => s.newTerminal);
  const storeNewTerminalTab = useTerminalStateStore((s) => s.newTerminalTab);
  const storeOpenNewFullWidthTerminal = useTerminalStateStore((s) => s.openNewFullWidthTerminal);
  const storeCloseWorkspaceChat = useTerminalStateStore((s) => s.closeWorkspaceChat);
  const storeSetActiveTerminal = useTerminalStateStore((s) => s.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((s) => s.closeTerminal);
  const storeCloseTerminalGroup = useTerminalStateStore((s) => s.closeTerminalGroup);
  const storeResizeTerminalSplit = useTerminalStateStore((s) => s.resizeTerminalSplit);
  const storeClearTerminalState = useTerminalStateStore((s) => s.clearTerminalState);

  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(threadId, nextPrompt);
    },
    [setComposerDraftPrompt, threadId],
  );
  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(threadId, image);
    },
    [addComposerDraftImage, threadId],
  );
  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(threadId, images);
    },
    [addComposerDraftImages, threadId],
  );
  const addComposerAssistantSelectionToDraft = useCallback(
    (selection: ComposerAssistantSelectionAttachment) =>
      addComposerDraftAssistantSelection(threadId, selection),
    [addComposerDraftAssistantSelection, threadId],
  );
  const addComposerTerminalContextsToDraft = useCallback(
    (contexts: TerminalContextDraft[]) => {
      addComposerDraftTerminalContexts(threadId, contexts);
    },
    [addComposerDraftTerminalContexts, threadId],
  );
  const addComposerFileCommentToDraft = useCallback(
    (comment: FileCommentDraft) => {
      addComposerDraftFileComment(threadId, comment);
    },
    [addComposerDraftFileComment, threadId],
  );
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const clearComposerAssistantSelectionsFromDraft = useCallback(() => {
    clearComposerDraftAssistantSelections(threadId);
  }, [clearComposerDraftAssistantSelections, threadId]);
  const clearComposerFileCommentsFromDraft = useCallback(() => {
    clearComposerDraftFileComments(threadId);
  }, [clearComposerDraftFileComments, threadId]);
  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) {
        return;
      }
      const nextPrompt = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = nextPrompt.prompt;
      setPrompt(nextPrompt.prompt);
      removeComposerDraftTerminalContext(threadId, contextId);
      setComposerCursor(nextPrompt.cursor);
      setComposerTrigger(
        detectComposerTrigger(
          nextPrompt.prompt,
          expandCollapsedComposerCursor(nextPrompt.prompt, nextPrompt.cursor),
        ),
      );
    },
    [composerTerminalContexts, removeComposerDraftTerminalContext, setPrompt, threadId],
  );

  const localDraftError = serverThread ? null : (localDraftErrorsByThreadId[threadId] ?? null);
  const localDraftThread = useMemo(
    () =>
      draftThread
        ? buildLocalDraftThread(
            threadId,
            draftThread,
            fallbackDraftProject?.defaultModelSelection ?? {
              provider: "codex",
              model: DEFAULT_MODEL_BY_PROVIDER.codex,
            },
            localDraftError,
          )
        : undefined,
    [draftThread, fallbackDraftProject?.defaultModelSelection, localDraftError, threadId],
  );
  const activeThread = serverThread ?? localDraftThread;
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
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const hasLiveTurnTail = hasLiveTurnTailWork({
    latestTurn: activeLatestTurn,
    messages: activeThread?.messages ?? EMPTY_MESSAGES,
    activities: threadActivities,
    session: activeThread?.session ?? null,
  });
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(threadActivities),
    [threadActivities],
  );
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
  const projectInstructions = useProjectInstructionsStore((state) =>
    activeProjectId ? (state.instructionsByProjectId[activeProjectId] ?? "") : "",
  );
  const setProjectInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, {
    homeDir,
    chatWorkspaceRoot,
  });
  const activeProjectDisplayName = isHomeChatContainer
    ? activeProject?.folderName
    : activeProject?.name;
  const isChatProject = isHomeChatContainer;
  const activeProjectScripts =
    activeProject?.kind === "project" ? activeProject.scripts : undefined;
  const threadLineageThreads = useStore(
    useMemo(() => createThreadLineageSelector(activeThread?.id ?? null), [activeThread?.id]),
  );
  const threadBreadcrumbs = useMemo(
    () => buildThreadBreadcrumbs(threadLineageThreads, activeThread),
    [activeThread, threadLineageThreads],
  );
  const resolvedThreadEnvMode = isServerThread
    ? (activeThread?.envMode ?? null)
    : (draftThread?.envMode ?? null);
  const resolvedThreadWorktreePath = isServerThread
    ? (activeThread?.worktreePath ?? null)
    : (draftThread?.worktreePath ?? null);
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
        associatedWorktreePath: activeThread?.associatedWorktreePath ?? null,
        associatedWorktreeBranch: activeThread?.associatedWorktreeBranch ?? null,
        associatedWorktreeRef: activeThread?.associatedWorktreeRef ?? null,
      }),
    [
      activeThread?.associatedWorktreeBranch,
      activeThread?.associatedWorktreePath,
      activeThread?.associatedWorktreeRef,
      activeThread?.branch,
      activeThread?.worktreePath,
    ],
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
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

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

  const sessionProvider = activeThread?.session?.provider ?? null;
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.provider ?? activeProject?.defaultModelSelection?.provider ?? null;
  const hasThreadStarted = Boolean(
    activeThread &&
    (activeThread.latestTurn !== null ||
      activeThread.messages.length > 0 ||
      activeThread.session !== null),
  );
  const lockedProvider: ProviderKind | null = hasThreadStarted
    ? (sessionProvider ?? threadProvider ?? selectedProviderByThreadId ?? null)
    : null;
  const selectedProvider: ProviderKind =
    lockedProvider ?? selectedProviderByThreadId ?? threadProvider ?? settings.defaultProvider;
  const previousSelectedProviderRef = useRef<{
    threadId: ThreadId;
    provider: ProviderKind;
  } | null>(null);
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceThreadIdRef = useRef(threadId);
  const voiceProviderRef = useRef<ProviderKind>(selectedProvider);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  voiceThreadIdRef.current = threadId;
  voiceProviderRef.current = selectedProvider;
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const featureFlags = useFeatureFlags();
  const showExpandedCursorModelVariants = featureFlags["show-expanded-cursor-model-variants"];
  const showDebugTaskBanner = import.meta.env.DEV && featureFlags["show-debug-task-banner"];
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const composerModelHintByProvider = useMemo<Record<ProviderKind, string | null>>(() => {
    const threadModelSelection = activeThread?.modelSelection ?? null;
    const projectModelSelection = activeProject?.defaultModelSelection ?? null;
    const draftSelections = composerDraft.modelSelectionByProvider;

    const resolveHint = (provider: ProviderKind): string | null =>
      draftSelections[provider]?.model ??
      (threadModelSelection?.provider === provider ? threadModelSelection.model : null) ??
      (projectModelSelection?.provider === provider ? projectModelSelection.model : null);

    return {
      codex: resolveHint("codex"),
      claudeAgent: resolveHint("claudeAgent"),
      cursor: resolveHint("cursor"),
      gemini: resolveHint("gemini"),
      grok: resolveHint("grok"),
      kilo: resolveHint("kilo"),
      opencode: resolveHint("opencode"),
      pi: resolveHint("pi"),
    };
  }, [
    activeProject?.defaultModelSelection,
    activeThread?.modelSelection,
    composerDraft.modelSelectionByProvider,
  ]);
  const providerModelDiscoveryCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const claudeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicModelsQuery = useQuery(providerModelsQueryOptions({ provider: "codex" }));
  const openCodeModelDiscoveryEnabled =
    selectedProvider === "opencode" || lockedProvider === "opencode" || isModelPickerOpen;
  const kiloModelDiscoveryEnabled =
    selectedProvider === "kilo" || lockedProvider === "kilo" || isModelPickerOpen;
  const piModelDiscoveryEnabled =
    selectedProvider === "pi" || lockedProvider === "pi" || isModelPickerOpen;
  const cursorDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "cursor",
      binaryPath: settings.cursorBinaryPath || null,
      apiEndpoint: settings.cursorApiEndpoint || null,
      enabled: selectedProvider === "cursor" || lockedProvider === "cursor" || isModelPickerOpen,
    }),
  );
  const geminiModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "gemini",
      binaryPath: settings.geminiBinaryPath || null,
      enabled: selectedProvider === "gemini" || lockedProvider === "gemini",
    }),
  );
  const grokDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "grok",
      binaryPath: settings.grokBinaryPath || null,
      enabled: selectedProvider === "grok" || lockedProvider === "grok" || isModelPickerOpen,
    }),
  );
  const openCodeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "opencode",
      binaryPath: settings.openCodeBinaryPath || null,
      enabled: openCodeModelDiscoveryEnabled,
    }),
  );
  const kiloDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "kilo",
      binaryPath: settings.kiloBinaryPath || null,
      enabled: kiloModelDiscoveryEnabled,
    }),
  );
  const piDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "pi",
      binaryPath: settings.piBinaryPath || null,
      agentDir: settings.piAgentDir || null,
      cwd: providerModelDiscoveryCwd,
      enabled: piModelDiscoveryEnabled,
    }),
  );
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "codex" }));
  const openCodeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "opencode", enabled: openCodeModelDiscoveryEnabled }),
  );
  const kiloDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "kilo", enabled: kiloModelDiscoveryEnabled }),
  );
  const cursorRuntimeModels = useMemo(
    () =>
      showExpandedCursorModelVariants
        ? (cursorDynamicModelsQuery.data?.models ?? [])
        : mergeCursorModelVariantsWithBaseControls(cursorDynamicModelsQuery.data?.models ?? []),
    [cursorDynamicModelsQuery.data?.models, showExpandedCursorModelVariants],
  );
  const cursorModelDiscoveryEnabled =
    selectedProvider === "cursor" || lockedProvider === "cursor" || isModelPickerOpen;
  const hasResolvedCursorModelDiscovery =
    (cursorDynamicModelsQuery.data?.source === "cursor.cli" ||
      cursorDynamicModelsQuery.data?.source === "cursor.acp") &&
    (cursorDynamicModelsQuery.data.models.length ?? 0) > 0;
  const cursorModelDiscoveryPending =
    cursorModelDiscoveryEnabled &&
    !hasResolvedCursorModelDiscovery &&
    (cursorDynamicModelsQuery.isLoading || cursorDynamicModelsQuery.isFetching);
  const hasResolvedKiloModelDiscovery =
    (kiloDynamicModelsQuery.data?.source === "kilo-cli" ||
      kiloDynamicModelsQuery.data?.source === "kilo") &&
    (kiloDynamicModelsQuery.data.models.length ?? 0) > 0;
  const kiloModelDiscoveryPending =
    kiloModelDiscoveryEnabled &&
    !hasResolvedKiloModelDiscovery &&
    (kiloDynamicModelsQuery.isLoading || kiloDynamicModelsQuery.isFetching);
  const hasResolvedPiModelDiscovery =
    piDynamicModelsQuery.data?.source?.startsWith("pi.sdk") === true &&
    (piDynamicModelsQuery.data.models.length ?? 0) > 0;
  const piModelDiscoveryPending =
    piModelDiscoveryEnabled &&
    !hasResolvedPiModelDiscovery &&
    (piDynamicModelsQuery.isLoading || piDynamicModelsQuery.isFetching);
  const modelOptionsByProvider = useMemo(() => {
    const staticOptions: Record<ProviderKind, ReturnType<typeof getAppModelOptions>> = {
      codex: getAppModelOptions(
        "codex",
        customModelsByProvider.codex,
        composerModelHintByProvider.codex,
      ),
      claudeAgent: getAppModelOptions(
        "claudeAgent",
        customModelsByProvider.claudeAgent,
        composerModelHintByProvider.claudeAgent,
      ),
      cursor: getAppModelOptions(
        "cursor",
        customModelsByProvider.cursor,
        composerModelHintByProvider.cursor,
      ),
      gemini: getAppModelOptions(
        "gemini",
        customModelsByProvider.gemini,
        composerModelHintByProvider.gemini,
      ),
      grok: getAppModelOptions(
        "grok",
        customModelsByProvider.grok,
        composerModelHintByProvider.grok,
      ),
      kilo: getAppModelOptions(
        "kilo",
        customModelsByProvider.kilo,
        composerModelHintByProvider.kilo,
      ),
      opencode: getAppModelOptions(
        "opencode",
        customModelsByProvider.opencode,
        composerModelHintByProvider.opencode,
      ),
      pi: getAppModelOptions("pi", customModelsByProvider.pi, composerModelHintByProvider.pi),
    };
    const result: Record<
      ProviderKind,
      ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>
    > = { ...staticOptions };

    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      cursor:
        cursorDynamicModelsQuery.data === undefined
          ? undefined
          : { ...cursorDynamicModelsQuery.data, models: cursorRuntimeModels },
      gemini: geminiModelsQuery.data,
      grok: grokDynamicModelsQuery.data,
      kilo: kiloDynamicModelsQuery.data,
      opencode: openCodeDynamicModelsQuery.data,
      pi: piDynamicModelsQuery.data,
    };

    for (const provider of [
      "claudeAgent",
      "codex",
      "cursor",
      "gemini",
      "grok",
      "kilo",
      "opencode",
      "pi",
    ] as const) {
      const dynamicModels = dynamicSources[provider]?.models;
      if (dynamicModels && dynamicModels.length > 0) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels,
        });
      }
    }

    return result;
  }, [
    claudeDynamicModelsQuery.data,
    composerModelHintByProvider,
    codexDynamicModelsQuery.data,
    cursorDynamicModelsQuery.data,
    cursorRuntimeModels,
    customModelsByProvider,
    geminiModelsQuery.data,
    grokDynamicModelsQuery.data,
    kiloDynamicModelsQuery.data,
    openCodeDynamicModelsQuery.data,
    piDynamicModelsQuery.data,
  ]);
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
    availableModelOptionsByProvider: modelOptionsByProvider,
  });
  const runtimeModelsByProvider = useMemo(
    () => ({
      claudeAgent: claudeDynamicModelsQuery.data?.models ?? [],
      codex: codexDynamicModelsQuery.data?.models ?? [],
      cursor: cursorRuntimeModels,
      gemini: geminiModelsQuery.data?.models ?? [],
      grok: grokDynamicModelsQuery.data?.models ?? [],
      kilo: kiloDynamicModelsQuery.data?.models ?? [],
      opencode: openCodeDynamicModelsQuery.data?.models ?? [],
      pi: piDynamicModelsQuery.data?.models ?? [],
    }),
    [
      claudeDynamicModelsQuery.data?.models,
      codexDynamicModelsQuery.data?.models,
      cursorRuntimeModels,
      geminiModelsQuery.data?.models,
      grokDynamicModelsQuery.data?.models,
      kiloDynamicModelsQuery.data?.models,
      openCodeDynamicModelsQuery.data?.models,
      piDynamicModelsQuery.data?.models,
    ],
  );
  const providerModelsQueryByProvider = {
    claudeAgent: claudeDynamicModelsQuery,
    codex: codexDynamicModelsQuery,
    cursor: cursorDynamicModelsQuery,
    gemini: geminiModelsQuery,
    grok: grokDynamicModelsQuery,
    kilo: kiloDynamicModelsQuery,
    opencode: openCodeDynamicModelsQuery,
    pi: piDynamicModelsQuery,
  } as const;
  const selectedRuntimeModel = useMemo(
    () =>
      resolveRuntimeModelDescriptor({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModels: runtimeModelsByProvider[selectedProvider],
      }),
    [runtimeModelsByProvider, selectedModel, selectedProvider],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        runtimeModel: selectedRuntimeModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider, selectedRuntimeModel],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const draftModelSelectionForSelectedProvider =
    composerDraft.modelSelectionByProvider[selectedProvider] ?? null;
  const selectedModelSelection = useMemo<ModelSelection>(() => {
    if (selectedProvider === "pi" && draftModelSelectionForSelectedProvider?.provider === "pi") {
      return buildModelSelection(
        selectedProvider,
        draftModelSelectionForSelectedProvider.model,
        selectedModelOptionsForDispatch ?? draftModelSelectionForSelectedProvider.options,
      );
    }
    return buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch);
  }, [
    draftModelSelectionForSelectedProvider,
    selectedModel,
    selectedModelOptionsForDispatch,
    selectedProvider,
  ]);
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker =
    selectedModelSelection.provider === selectedProvider
      ? selectedModelSelection.model
      : selectedModel;
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const persistedComposerModelSelection =
    sessionProvider && activeThread?.modelSelection.provider !== sessionProvider
      ? activeProject?.defaultModelSelection?.provider === selectedProvider
        ? activeProject.defaultModelSelection
        : null
      : (activeThread?.modelSelection ?? activeProject?.defaultModelSelection ?? null);
  const selectedProviderModelsQuery = providerModelsQueryByProvider[selectedProvider];
  const providerModelsLoading =
    selectedProvider === "cursor"
      ? cursorModelDiscoveryPending
      : selectedProvider === "kilo"
        ? kiloModelDiscoveryPending
        : selectedProvider === "pi"
          ? piModelDiscoveryPending
          : selectedProviderModelsQuery !== undefined &&
            (selectedProviderModelsQuery.isLoading ||
              (selectedProviderModelsQuery.isFetching &&
                selectedProviderModelsQuery.data === undefined));
  const selectedProviderRequiresRuntimeModels =
    selectedProvider === "cursor" || selectedProvider === "kilo" || selectedProvider === "pi";
  const selectedProviderRuntimeModelDiscoveryPending =
    selectedProvider === "cursor"
      ? cursorModelDiscoveryPending
      : selectedProvider === "kilo"
        ? kiloModelDiscoveryPending
        : selectedProvider === "pi"
          ? piModelDiscoveryPending
          : false;
  const showComposerModelBootstrapSkeleton = shouldShowComposerModelBootstrapSkeleton({
    selectedProvider,
    selectedModel,
    persistedModelSelection: persistedComposerModelSelection,
    draftModelSelection: draftModelSelectionForSelectedProvider,
    providerModelsLoading,
    requiresDiscoveredModels: selectedProviderRequiresRuntimeModels,
  });
  const hiddenProviderSet = useMemo(
    () => new Set<ProviderKind>(settings.hiddenProviders),
    [settings.hiddenProviders],
  );
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.toSorted((left, right) =>
        compareProvidersByOrder(settings.providerOrder, left.value, right.value),
      )
        .filter((option) => {
          if (lockedProvider !== null) {
            return option.value === lockedProvider;
          }
          // Always keep the currently selected provider visible in search even if
          // it's hidden in the picker, so the user can still see and switch from
          // its models without first unhiding the provider in settings.
          if (option.value === selectedProvider) {
            return true;
          }
          return !hiddenProviderSet.has(option.value);
        })
        .flatMap((option) =>
          modelOptionsByProvider[option.value].map(
            ({ slug, name, upstreamProviderId, upstreamProviderName }) => ({
              provider: option.value,
              providerLabel: option.label,
              slug,
              name,
              searchSlug: slug.toLowerCase(),
              searchName: name.toLowerCase(),
              searchProvider: option.label.toLowerCase(),
              searchUpstreamProvider: (
                upstreamProviderName ??
                upstreamProviderId ??
                ""
              ).toLowerCase(),
            }),
          ),
        ),
    [
      hiddenProviderSet,
      lockedProvider,
      modelOptionsByProvider,
      selectedProvider,
      settings.providerOrder,
    ],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const isConnecting = isLocalConnecting || phase === "connecting";
  // User messages intentionally have no turn id; assistant messages are the stable
  // bridge for deciding which historical work can fold into visible replies.
  const workLogVisibleTurnIds = useMemo(() => {
    const turnIds = new Set<TurnId>();
    for (const message of activeThread?.messages ?? []) {
      if (message.turnId) {
        turnIds.add(message.turnId);
      }
    }
    if (activeLatestTurn?.turnId) {
      turnIds.add(activeLatestTurn.turnId);
    }
    return turnIds;
  }, [activeLatestTurn?.turnId, activeThread?.messages]);
  const rawWorkLogEntries = useMemo(
    () =>
      deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined, {
        visibleTurnIds: workLogVisibleTurnIds,
      }),
    [activeLatestTurn?.turnId, threadActivities, workLogVisibleTurnIds],
  );
  const hasWorkLogSubagents = useMemo(
    () => rawWorkLogEntries.some((entry) => (entry.subagents?.length ?? 0) > 0),
    [rawWorkLogEntries],
  );
  const relevantWorkLogThreads = useStore(
    useMemo(
      () =>
        createRelevantWorkLogThreadsSelector({
          workEntries: rawWorkLogEntries,
          parentThreadId: activeThread?.id ?? null,
          enabled: hasWorkLogSubagents,
        }),
      [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries],
    ),
  );
  const workLogEntries = useMemo(
    () =>
      hasWorkLogSubagents
        ? enrichSubagentWorkEntries(
            rawWorkLogEntries,
            relevantWorkLogThreads,
            activeThread?.id ?? null,
          )
        : rawWorkLogEntries,
    [activeThread?.id, hasWorkLogSubagents, rawWorkLogEntries, relevantWorkLogThreads],
  );
  const [openAgentActivityId, setOpenAgentActivityId] = useState<string | null>(null);
  const agentActivityTimelineState = useMemo(
    () => deriveAgentActivityTimelineState(workLogEntries),
    [workLogEntries],
  );
  const openAgentActivityDetail = openAgentActivityId
    ? (agentActivityTimelineState.detailById.get(openAgentActivityId) ?? null)
    : null;
  useEffect(() => {
    setOpenAgentActivityId(null);
  }, [activeThread?.id]);
  useEffect(() => {
    if (openAgentActivityId && !agentActivityTimelineState.detailById.has(openAgentActivityId)) {
      setOpenAgentActivityId(null);
    }
  }, [agentActivityTimelineState.detailById, openAgentActivityId]);
  const pendingApprovals = useMemo(
    () => derivePendingApprovals(threadActivities),
    [threadActivities],
  );
  const pendingUserInputs = useMemo(
    () => derivePendingUserInputs(threadActivities),
    [threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInput
        ? (pendingUserInputAnswersByRequestId[activePendingUserInput.requestId] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInput, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInput
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInput.requestId] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInput
    ? respondingUserInputRequestIds.includes(activePendingUserInput.requestId)
    : false;
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
  const [activeTaskListCardHeight, setActiveTaskListCardHeight] = useState(0);
  const activeTaskListCardRef = useRef<HTMLDivElement | null>(null);
  const previousActiveTaskListCardHeightRef = useRef(0);
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

    return latestTurnSettled
      ? null
      : deriveActiveTaskListState(threadActivities, activeLatestTurn?.turnId ?? undefined);
  }, [activeLatestTurn?.turnId, latestTurnSettled, showDebugTaskBanner, threadActivities]);
  const activeBackgroundTasks = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActiveBackgroundTasksState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );
  useLayoutEffect(() => {
    if (!activeTaskList || planSidebarOpen) {
      setActiveTaskListCardHeight(0);
      return;
    }

    const element = activeTaskListCardRef.current;
    if (!element) {
      setActiveTaskListCardHeight(0);
      return;
    }

    const updateHeight = () => {
      setActiveTaskListCardHeight(Math.ceil(element.getBoundingClientRect().height));
    };

    updateHeight();
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(updateHeight);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, [activeTaskList, activeTaskListCompact, planSidebarOpen]);
  const showPlanFollowUpPrompt =
    pendingUserInputs.length === 0 &&
    interactionMode === "plan" &&
    latestTurnSettled &&
    hasActionableProposedPlan(activeProposedPlan);
  const activePendingApproval = pendingApprovals[0] ?? null;
  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const isSendBusy = localDispatch !== null && !serverAcknowledgedLocalDispatch;
  const isPreparingWorktree = localDispatch?.preparingWorktree ?? false;
  const hasLiveTurn = phase === "running";
  const isWorking = hasLiveTurn || isSendBusy || isConnecting || isRevertingCheckpoint;
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
  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);
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
  }, [activeLatestTurn?.startedAt, activeTurnLayoutKey, activeTurnLayoutLive]);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);
  useEffect(() => {
    attachmentPreviewHandoffByMessageIdRef.current = attachmentPreviewHandoffByMessageId;
  }, [attachmentPreviewHandoffByMessageId]);
  const clearAttachmentPreviewHandoffs = useCallback(() => {
    for (const timeoutId of Object.values(attachmentPreviewHandoffTimeoutByMessageIdRef.current)) {
      window.clearTimeout(timeoutId);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current = {};
    for (const previewUrls of Object.values(attachmentPreviewHandoffByMessageIdRef.current)) {
      for (const previewUrl of previewUrls) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
    attachmentPreviewHandoffByMessageIdRef.current = {};
    setAttachmentPreviewHandoffByMessageId({});
  }, []);
  useEffect(() => {
    return () => {
      clearAttachmentPreviewHandoffs();
      for (const message of optimisticUserMessagesRef.current) {
        revokeUserMessagePreviewUrls(message);
      }
    };
  }, [clearAttachmentPreviewHandoffs]);
  const handoffAttachmentPreviews = useCallback((messageId: MessageId, previewUrls: string[]) => {
    if (previewUrls.length === 0) return;

    const previousPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId] ?? [];
    const replacedPreviewUrls = previousPreviewUrls.filter(
      (previewUrl) => !previewUrls.includes(previewUrl),
    );
    revokeBlobPreviewUrlsAfterPaint(replacedPreviewUrls);
    setAttachmentPreviewHandoffByMessageId((existing) => {
      const next = {
        ...existing,
        [messageId]: previewUrls,
      };
      attachmentPreviewHandoffByMessageIdRef.current = next;
      return next;
    });

    const existingTimeout = attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    if (typeof existingTimeout === "number") {
      window.clearTimeout(existingTimeout);
    }
    attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId] = window.setTimeout(() => {
      const currentPreviewUrls = attachmentPreviewHandoffByMessageIdRef.current[messageId];
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
      // Let React swap the transcript back to persisted /attachments URLs before
      // invalidating blob previews that may still be mounted in the old row.
      if (currentPreviewUrls) {
        revokeBlobPreviewUrlsAfterPaint(currentPreviewUrls);
      }
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = filterSidechatTranscriptMessages(
      serverMessages ?? [],
      Boolean(activeThread?.sidechatSourceThreadId),
    );
    const serverMessagesWithPreviewHandoff =
      Object.keys(attachmentPreviewHandoffByMessageId).length === 0
        ? messages
        : // Spread only fires for the few messages that actually changed;
          // unchanged ones early-return their original reference.
          // In-place mutation would break React's immutable state contract.
          // oxlint-disable-next-line no-map-spread
          messages.map((message) => {
            if (
              message.role !== "user" ||
              !message.attachments ||
              message.attachments.length === 0
            ) {
              return message;
            }
            const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
            if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
              return message;
            }

            let changed = false;
            let imageIndex = 0;
            const attachments = message.attachments.map((attachment) => {
              if (attachment.type !== "image") {
                return attachment;
              }
              const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
              imageIndex += 1;
              if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
                return attachment;
              }
              changed = true;
              return {
                ...attachment,
                previewUrl: handoffPreviewUrl,
              };
            });

            return changed ? { ...message, attachments } : message;
          });

    if (optimisticUserMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
    const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
    if (pendingMessages.length === 0) {
      return serverMessagesWithPreviewHandoff;
    }
    return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
  }, [
    activeThread?.sidechatSourceThreadId,
    serverMessages,
    attachmentPreviewHandoffByMessageId,
    optimisticUserMessages,
  ]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(
        timelineMessages,
        activeThread?.proposedPlans ?? [],
        agentActivityTimelineState.timelineWorkEntries,
      ),
    [activeThread?.proposedPlans, agentActivityTimelineState.timelineWorkEntries, timelineMessages],
  );
  // --- Pinned messages & notes (per-thread, server-synced through sidepanel commands) ---
  const pinnedMessages = activeThread?.pinnedMessages ?? EMPTY_PINNED_MESSAGES;
  const threadMarkers = activeThread?.threadMarkers ?? EMPTY_THREAD_MARKERS;
  const threadNotes = activeThread?.notes ?? "";
  const pinnedMessageIds = useMemo(
    () => new Set(pinnedMessages.map((pin) => pin.messageId)),
    [pinnedMessages],
  );
  const markerMessageIds = useMemo(
    () => new Set(threadMarkers.map((marker) => marker.messageId)),
    [threadMarkers],
  );
  // Resolve live text for the Environment panel in one transcript pass.
  const { markerMessageTextById, pinnedMessageTextById } = useMemo(() => {
    const needsPinnedText = pinnedMessageIds.size > 0;
    const needsMarkerText = markerMessageIds.size > 0;
    if (!needsPinnedText && !needsMarkerText) {
      return {
        pinnedMessageTextById: EMPTY_PINNED_TEXT,
        markerMessageTextById: EMPTY_PINNED_TEXT,
      };
    }
    const pinnedTextById = new Map<MessageId, string>();
    const markerTextById = new Map<MessageId, string>();
    for (const message of timelineMessages) {
      if (needsPinnedText && pinnedMessageIds.has(message.id)) {
        pinnedTextById.set(message.id, message.text);
      }
      if (needsMarkerText && markerMessageIds.has(message.id)) {
        markerTextById.set(message.id, message.text);
      }
    }
    return {
      pinnedMessageTextById: needsPinnedText ? pinnedTextById : EMPTY_PINNED_TEXT,
      markerMessageTextById: needsMarkerText ? markerTextById : EMPTY_PINNED_TEXT,
    };
  }, [markerMessageIds, pinnedMessageIds, timelineMessages]);
  const {
    handleTogglePinMessage,
    handleTogglePinnedMessageDone,
    handleUnpinMessage,
    handleRenamePinnedMessage,
    handleNotesChange,
  } = usePinnedMessageActions({ activeThreadId, pinnedMessages });
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
  const handleJumpToPinnedMessage = useCallback((messageId: MessageId) => {
    timelineControllerRef.current?.scrollToMessage(messageId);
  }, []);
  const handleJumpToThreadMarker = useCallback((marker: ThreadMarker) => {
    timelineControllerRef.current?.scrollToMarker(marker);
  }, []);
  const handleRemoveThreadMarker = useCallback(
    (markerId: ThreadMarkerId) => {
      if (!activeThreadId) {
        return;
      }
      void dispatchThreadMarkerRemove(activeThreadId, markerId).catch((error) => {
        console.error("Failed to remove thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not remove marker.",
        });
      });
    },
    [activeThreadId],
  );
  const handleToggleThreadMarkerDone = useCallback(
    (markerId: ThreadMarkerId) => {
      if (!activeThreadId) {
        return;
      }
      const marker = threadMarkers.find((candidate) => candidate.id === markerId);
      if (!marker) {
        return;
      }
      void dispatchThreadMarkerDoneSet(activeThreadId, markerId, !marker.done).catch((error) => {
        console.error("Failed to update thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not update marker.",
        });
      });
    },
    [activeThreadId, threadMarkers],
  );
  const handleRenameThreadMarker = useCallback(
    (markerId: ThreadMarkerId, label: string | null) => {
      if (!activeThreadId) {
        return;
      }
      void dispatchThreadMarkerLabelSet(activeThreadId, markerId, label).catch((error) => {
        console.error("Failed to rename thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not rename marker.",
        });
      });
    },
    [activeThreadId],
  );
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Home-scoped chats get the global "What should we work on?" copy plus the project picker,
  // while project-scoped drafts reuse the same centered layout with folder-specific copy.
  const isCenteredEmptyLanding =
    timelineEntries.length === 0 && !activeThread?.parentThreadId && !isEditorRail;
  const isEmptyChatLanding =
    isCenteredEmptyLanding &&
    Boolean(homeDir) &&
    isHomeChatContainerProject(activeProject, { homeDir, chatWorkspaceRoot });
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
      turnDiffSummaries,
      messages: messagesForDiffAnchoring,
    });
  }, [turnDiffSummaries, timelineMessages]);
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
      })
    : null;
  const gitCwd = threadWorkspaceCwd;
  const showGitActions = !isHomeChatContainer || Boolean(resolvedThreadWorktreePath);
  const gitBranchSourceCwd = activeProject
    ? resolveThreadBranchSourceCwd({
        projectCwd: activeProject.cwd,
        worktreePath: resolvedThreadWorktreePath,
      })
    : null;
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const mentionTriggerQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : "";
  const isMentionTrigger = composerTriggerKind === "mention";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  const branchesQuery = useQuery(gitBranchesQueryOptions(gitBranchSourceCwd));
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacPlatform(platform),
  );
  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = providerModelDiscoveryCwd;
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      binaryPath:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.binaryPath
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.binaryPath
            : null) ?? null,
      serverUrl:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverUrl
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.serverUrl
            : null) ?? null,
      serverPassword:
        (selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.serverPassword
          : selectedProvider === "kilo"
            ? providerOptionsForDispatch?.kilo?.serverPassword
            : null) ?? null,
      experimentalWebSockets:
        selectedProvider === "opencode"
          ? providerOptionsForDispatch?.opencode?.experimentalWebSockets
          : undefined,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const canDiscoverProviderSkills =
    selectedProvider === "pi" || supportsSkillDiscovery(providerComposerCapabilitiesQuery.data);
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      agentDir: selectedProvider === "pi" ? settings.piAgentDir || null : null,
      enabled:
        (isSkillTrigger || composerTriggerKind === "slash-command" || selectedProvider === "pi") &&
        canDiscoverProviderSkills &&
        composerSkillCwd !== null,
    }),
  );
  const providerPluginsQuery = useQuery(
    providerPluginsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      enabled:
        supportsPluginDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const workspaceEntriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: gitCwd,
      query: effectiveMentionQuery,
      enabled: isMentionTrigger && !isLocalFolderBrowserOpen,
      limit: 80,
    }),
  );
  const workspaceEntries = workspaceEntriesQuery.data?.entries ?? EMPTY_PROJECT_ENTRIES;
  const activeRootBranch = useMemo(
    () =>
      resolveComposerSlashRootBranch({
        branches: branchesQuery.data?.branches,
        activeProjectCwd: activeProject?.cwd,
        activeThreadBranch: activeThread?.branch,
      }),
    [activeProject?.cwd, activeThread?.branch, branchesQuery.data?.branches],
  );
  // Keep plugin suggestions referentially stable so prompt-sync effects do not loop on rerender.
  const providerPlugins = useMemo(
    () =>
      providerPluginsQuery.data?.marketplaces.flatMap((marketplace) =>
        marketplace.plugins.map((plugin) => ({
          plugin,
          mention: {
            name: plugin.name,
            path: `plugin://${plugin.name}@${marketplace.name}`,
          } satisfies ProviderMentionReference,
        })),
      ) ?? EMPTY_COMPOSER_PLUGIN_SUGGESTIONS,
    [providerPluginsQuery.data],
  );
  const providerNativeCommands =
    providerCommandsQuery.data?.commands ?? EMPTY_PROVIDER_NATIVE_COMMANDS;
  const providerNativeCommandNames = useMemo(
    () => providerNativeCommands.map((command) => command.name),
    [providerNativeCommands],
  );
  const effectiveComposerTrigger = useMemo(() => {
    if (
      composerTrigger?.kind === "slash-model" &&
      hasProviderNativeSlashCommand(selectedProvider, providerNativeCommandNames, "model")
    ) {
      return {
        ...composerTrigger,
        kind: "slash-command" as const,
        query: "model",
      };
    }
    return composerTrigger;
  }, [composerTrigger, providerNativeCommandNames, selectedProvider]);
  const effectiveComposerTriggerKind = effectiveComposerTrigger?.kind ?? null;
  const supportsTextNativeReviewCommand = useMemo(
    () => providerNativeCommands.some((command) => command.name.toLowerCase() === "review"),
    [providerNativeCommands],
  );
  const providerSkills = providerSkillsQuery.data?.skills ?? EMPTY_PROVIDER_SKILLS;
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
  const canOfferSideCommand =
    isServerThread &&
    activeThread !== undefined &&
    canOfferSideSlashCommand({
      prompt: composerPromptWithoutActiveSlashTrigger,
      imageCount: composerImages.length,
      terminalContextCount: composerTerminalContexts.length,
      selectedSkillCount: selectedComposerSkills.length,
      selectedMentionCount: selectedComposerMentions.length,
      interactionMode,
      isSidechat: Boolean(activeThread.sidechatSourceThreadId),
    });
  const selectedDynamicAgents =
    selectedProvider === "claudeAgent"
      ? (claudeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
      : selectedProvider === "kilo"
        ? (kiloDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
        : selectedProvider === "opencode"
          ? (openCodeDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS)
          : (codexDynamicAgentsQuery.data?.agents ?? EMPTY_PROVIDER_AGENTS);
  const dynamicAgents = useMemo(
    () =>
      selectedDynamicAgents.map((agent) =>
        agent.description
          ? { name: agent.name, displayName: agent.displayName, description: agent.description }
          : { name: agent.name, displayName: agent.displayName },
      ),
    [selectedDynamicAgents],
  );
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
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
    canOfferSideCommand,
    dynamicAgents,
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
  const activeComposerMenuItem = useMemo(
    () =>
      composerMenuItems.find((item) => item.id === composerHighlightedItemId) ??
      composerMenuItems[0] ??
      null,
    [composerHighlightedItemId, composerMenuItems],
  );
  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;
  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;
  const availableEditors = serverConfigQuery.data?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
  const rememberCustomBinaryPathForDispatch = useCallback(
    (input: {
      threadId: Thread["id"];
      provider: ProviderKind;
      providerOptions: ProviderStartOptions | undefined;
    }) => {
      const pendingKey = getThreadProviderCustomBinaryPathKey(input.threadId, input.provider);
      const customBinaryPath = getProviderStartOptionsCustomBinaryPath(
        input.providerOptions,
        input.provider,
      );
      if (!customBinaryPath) {
        pendingCustomBinaryPathsByThreadProviderRef.current.delete(pendingKey);
        return;
      }
      pendingCustomBinaryPathsByThreadProviderRef.current.set(pendingKey, customBinaryPath);
    },
    [],
  );
  useEffect(() => {
    const provider = activeThread?.session?.provider;
    if (!activeThread || !provider) {
      return;
    }

    const sessionKey = getConfirmedCustomBinarySessionKey(activeThread, provider);
    if (!sessionKey) {
      confirmedCustomBinarySessionKeysRef.current.delete(
        getThreadProviderCustomBinaryPathKey(activeThread.id, provider),
      );
      return;
    }
    const customBinaryPath =
      pendingCustomBinaryPathsByThreadProviderRef.current.get(sessionKey) ?? null;
    if (
      !shouldConsumePendingCustomBinaryConfirmation({
        sessionAlreadyChecked: confirmedCustomBinarySessionKeysRef.current.has(sessionKey),
        pendingCustomBinaryPath: customBinaryPath,
      })
    ) {
      return;
    }
    confirmedCustomBinarySessionKeysRef.current.add(sessionKey);

    pendingCustomBinaryPathsByThreadProviderRef.current.delete(sessionKey);
    if (!customBinaryPath) {
      return;
    }

    setConfirmedCustomBinaryPathsByProvider((existing) =>
      existing[provider] === customBinaryPath
        ? existing
        : {
            ...existing,
            [provider]: customBinaryPath,
          },
    );
  }, [
    activeThread,
    activeThread?.id,
    activeThread?.session?.provider,
    activeThread?.session?.status,
  ]);
  // Persist confirmations so a custom binary path that already started a session
  // stays trusted across restarts, instead of re-showing the availability warning.
  useEffect(() => {
    saveConfirmedCustomBinaryPaths(confirmedCustomBinaryPathsByProvider);
  }, [confirmedCustomBinaryPathsByProvider]);
  const providerStatuses = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
        .map((status) => {
          const customBinaryPath = getCustomBinaryPathForProvider(settings, status.provider);
          return normalizeProviderStatusForLocalConfig({
            provider: status.provider,
            status,
            customBinaryPath,
            confirmedCustomBinaryPath: confirmedCustomBinaryPathsByProvider[status.provider],
          });
        })
        .flatMap((status) => (status ? [status] : [])),
    [confirmedCustomBinaryPathsByProvider, serverConfigQuery.data?.providers, settings],
  );
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
        ? resolveAvailableHandoffTargetProviders(activeThread.modelSelection.provider).filter(
            (provider) => isProviderUsable(findProviderStatus(providerStatuses, provider)),
          )
        : [],
    [activeThread, providerStatuses],
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
  const refreshVoiceStatus = useRefreshProviderStatusesNow();
  const voiceRecordingDurationLabel = useMemo(
    () => formatVoiceRecordingDuration(voiceRecordingDurationMs),
    [voiceRecordingDurationMs],
  );
  const canRenderVoiceNotes = voiceProviderStatus?.authStatus !== "unauthenticated";
  const canStartVoiceNotes =
    voiceProviderStatus?.authStatus !== "unauthenticated" &&
    voiceProviderStatus?.voiceTranscriptionAvailable !== false;
  const showVoiceNotesControl = canRenderVoiceNotes || isVoiceRecording || isVoiceTranscribing;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const activeThreadWorktreePath = activeThread?.worktreePath ?? null;
  const hasNativeUserMessages = useMemo(
    () =>
      activeThread?.messages.some(
        (message) => message.role === "user" && message.source === "native",
      ) ?? false,
    [activeThread?.messages],
  );
  const threadTerminalRuntimeEnv = useMemo(() => {
    if (!activeProjectCwd) return {};
    return projectScriptRuntimeEnv({
      project: {
        cwd: activeProjectCwd,
      },
      worktreePath: activeThreadWorktreePath,
    });
  }, [activeProjectCwd, activeThreadWorktreePath]);
  // Default true while loading to avoid toolbar flicker.
  const isGitRepo = branchesQuery.data?.isRepo ?? true;
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
      }),
    [activeLatestTurn?.turnId, turnDiffSummaries],
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
  // Open-only diff action (no toggle): used by affordances like the live-changes
  // "Review" strip where a second click should never close an already-open panel.
  const onOpenDiff = useCallback(() => {
    if (diffEnvironmentPending || resolvedDiffOpen) {
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
      search: (previous) => ({
        ...stripDiffSearchParams(previous),
        panel: "diff",
        diff: "1",
      }),
    });
  }, [diffEnvironmentPending, navigate, onToggleDiffPanel, resolvedDiffOpen, threadId]);
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
  const activeTerminalGroup =
    terminalState.terminalGroups.find(
      (group) => group.id === terminalState.activeTerminalGroupId,
    ) ??
    terminalState.terminalGroups.find((group) =>
      collectTerminalIdsFromLayout(group.layout).includes(terminalState.activeTerminalId),
    ) ??
    null;
  const hasReachedSplitLimit =
    (activeTerminalGroup ? collectTerminalIdsFromLayout(activeTerminalGroup.layout).length : 0) >=
    MAX_TERMINALS_PER_GROUP;
  const terminalWorkspaceOpen = shouldRenderTerminalWorkspace({
    presentationMode: terminalState.presentationMode,
    terminalOpen: terminalState.terminalOpen,
  });
  const terminalWorkspaceTerminalTabActive =
    terminalWorkspaceOpen &&
    (terminalState.workspaceLayout === "terminal-only" ||
      terminalState.workspaceActiveTab === "terminal");
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
  }, [secondaryChromeThreadId, shouldDeferSecondaryChrome]);
  const terminalWorkspaceChatTabActive =
    terminalWorkspaceOpen &&
    terminalState.workspaceLayout === "both" &&
    terminalState.workspaceActiveTab === "chat";
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
    [setStoreThreadError],
  );

  const focusComposer = useCallback(() => {
    // Secondary chrome is deferred during thread switches; replay focus once it mounts.
    const editor = composerEditorRef.current;
    if (!secondaryChromeReady || !editor) {
      pendingComposerFocusRef.current = true;
      return;
    }
    pendingComposerFocusRef.current = false;
    editor.focusAtEnd();
  }, [secondaryChromeReady]);
  const toggleComposerFocus = useCallback(() => {
    const editor = composerEditorRef.current;
    if (secondaryChromeReady && editor?.isFocused()) {
      pendingComposerFocusRef.current = false;
      editor.blur();
      return;
    }
    focusComposer();
  }, [focusComposer, secondaryChromeReady]);
  const scheduleComposerFocus = useCallback(() => {
    pendingComposerFocusRef.current = true;
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
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
  // Context gate is intentionally prompt-independent so the suggestion list stays
  // mounted while the user types — that lets us animate it closed instead of an
  // abrupt unmount (which jolted the centered composer).
  const shouldPrepareComposerSuggestions =
    settings.enableComposerSuggestions &&
    isLocalDraftThread &&
    isCenteredEmptyLanding &&
    draftThread?.entryPoint !== "terminal" &&
    composerImages.length === 0 &&
    composerAssistantSelections.length === 0 &&
    composerTerminalContexts.length === 0 &&
    queuedComposerTurns.length === 0 &&
    !composerMenuOpen &&
    !isComposerApprovalState &&
    pendingUserInputs.length === 0 &&
    !showPlanFollowUpPrompt;

  const selectComposerSuggestionThreads = useMemo(() => {
    if (!shouldPrepareComposerSuggestions) {
      return selectEmptyComposerSuggestionThreads;
    }
    return createAllThreadsSelector();
  }, [shouldPrepareComposerSuggestions]);
  const projectSuggestionSourceThreads = useStore(selectComposerSuggestionThreads);
  const composerSuggestions = useMemo(() => {
    // Suggestions belong only to brand-new empty chats; existing threads should not scan history.
    if (!shouldPrepareComposerSuggestions) {
      return EMPTY_COMPOSER_SUGGESTIONS;
    }
    return deriveComposerSuggestions({
      activeThreadId,
      project: activeProject,
      threads: projectSuggestionSourceThreads,
    });
  }, [
    activeProject,
    activeThreadId,
    projectSuggestionSourceThreads,
    shouldPrepareComposerSuggestions,
  ]);
  // Suggestions stay open for the whole eligible empty-landing context, even
  // while the user types, so they remain a persistent pick list rather than a
  // transient empty-prompt hint.
  const showComposerSuggestions =
    shouldPrepareComposerSuggestions && composerSuggestions.length > 0;
  const composerSuggestionsOpen = showComposerSuggestions;
  const onSelectComposerSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      // Append the picked prompt as a quoted block instead of replacing the
      // composer, so clicking accumulates onto whatever is already typed.
      const quotedPrompt = `"${suggestion.prompt}"`;
      const current = promptRef.current;
      const separator = current.length === 0 ? "" : /\s$/.test(current) ? "" : " ";
      const nextPrompt = `${current}${separator}${quotedPrompt}`;
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [scheduleComposerFocus, setPrompt],
  );
  useEffect(() => {
    if (!secondaryChromeReady || !pendingComposerFocusRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusComposer, secondaryChromeReady, secondaryChromeThreadId]);
  // Keep the two composer picker menus mutually exclusive so shortcuts always open one surface.
  const handleModelPickerOpenChange = useCallback((open: boolean) => {
    setIsModelPickerOpen(open);
    if (open) {
      setIsTraitsPickerOpen(false);
    }
  }, []);
  const handleTraitsPickerOpenChange = useCallback((open: boolean) => {
    setIsTraitsPickerOpen(open);
    if (open) {
      setIsModelPickerOpen(false);
    }
  }, []);
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
    [scheduleComposerFocus, setPrompt],
  );
  const addTerminalContextToDraft = useCallback(
    (selection: TerminalContextSelection) => {
      if (!activeThread) {
        return;
      }
      const snapshot = composerEditorRef.current?.readSnapshot() ?? {
        value: promptRef.current,
        cursor: composerCursor,
        expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
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
        activeThread.id,
        insertion.prompt,
        {
          id: randomUUID(),
          threadId: activeThread.id,
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
    [activeThread, composerCursor, composerTerminalContexts, insertComposerDraftTerminalContext],
  );
  const setTerminalOpen = useCallback(
    (open: boolean) => {
      if (!activeThreadId) return;
      storeSetTerminalOpen(activeThreadId, open);
    },
    [activeThreadId, storeSetTerminalOpen],
  );
  const setTerminalPresentationMode = useCallback(
    (mode: "drawer" | "workspace") => {
      if (!activeThreadId) return;
      storeSetTerminalPresentationMode(activeThreadId, mode);
    },
    [activeThreadId, storeSetTerminalPresentationMode],
  );
  const setTerminalWorkspaceLayout = useCallback(
    (layout: "both" | "terminal-only") => {
      if (!activeThreadId) return;
      storeSetTerminalWorkspaceLayout(activeThreadId, layout);
    },
    [activeThreadId, storeSetTerminalWorkspaceLayout],
  );
  const setTerminalWorkspaceTab = useCallback(
    (tab: "terminal" | "chat") => {
      if (!activeThreadId) return;
      storeSetTerminalWorkspaceTab(activeThreadId, tab);
    },
    [activeThreadId, storeSetTerminalWorkspaceTab],
  );
  const setTerminalHeight = useCallback(
    (height: number) => {
      if (!activeThreadId) return;
      storeSetTerminalHeight(activeThreadId, height);
    },
    [activeThreadId, storeSetTerminalHeight],
  );
  const toggleTerminalVisibility = useCallback(() => {
    if (!activeThreadId) return;
    if (!terminalState.terminalOpen) {
      setTerminalPresentationMode("drawer");
    }
    setTerminalOpen(!terminalState.terminalOpen);
  }, [activeThreadId, setTerminalOpen, setTerminalPresentationMode, terminalState.terminalOpen]);
  const expandTerminalWorkspace = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("workspace");
    setTerminalWorkspaceLayout("both");
    setTerminalWorkspaceTab("terminal");
  }, [
    activeThreadId,
    setTerminalPresentationMode,
    setTerminalWorkspaceLayout,
    setTerminalWorkspaceTab,
  ]);
  const collapseTerminalWorkspace = useCallback(() => {
    if (!activeThreadId) return;
    setTerminalPresentationMode("drawer");
  }, [activeThreadId, setTerminalPresentationMode]);
  const splitTerminalRight = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = randomTerminalId();
    storeSplitTerminalRight(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalRight]);
  const splitTerminalLeft = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = randomTerminalId();
    storeSplitTerminalLeft(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalLeft]);
  const splitTerminalDown = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = randomTerminalId();
    storeSplitTerminalDown(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalDown]);
  const splitTerminalUp = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = randomTerminalId();
    storeSplitTerminalUp(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalUp]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = randomTerminalId();
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const createNewTerminalTab = useCallback(
    (targetTerminalId: string) => {
      if (!activeThreadId) return;
      const terminalId = randomTerminalId();
      storeNewTerminalTab(activeThreadId, targetTerminalId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeNewTerminalTab],
  );
  const createTerminalFromShortcut = useCallback(() => {
    const action = resolveTerminalNewAction({
      terminalOpen: terminalState.terminalOpen,
      activeTerminalId: terminalState.activeTerminalId,
      activeTerminalGroupId: terminalState.activeTerminalGroupId,
      terminalGroups: terminalState.terminalGroups,
    });

    if (action.kind === "new-group") {
      if (!terminalState.terminalOpen) {
        setTerminalOpen(true);
      }
      createNewTerminal();
      return;
    }

    createNewTerminalTab(action.targetTerminalId);
  }, [
    createNewTerminal,
    createNewTerminalTab,
    setTerminalOpen,
    terminalState.activeTerminalGroupId,
    terminalState.activeTerminalId,
    terminalState.terminalGroups,
    terminalState.terminalOpen,
  ]);
  const moveTerminalToNewGroup = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeNewTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeNewTerminal],
  );
  const openNewFullWidthTerminal = useCallback(() => {
    if (!activeThreadId || !activeProject) return;
    const terminalId = randomTerminalId();
    storeOpenNewFullWidthTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeProject, activeThreadId, storeOpenNewFullWidthTerminal]);
  // Desktop accelerators like Cmd+T can be claimed by Electron before the page sees keydown.
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function" || !isFocusedPane) {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "new-terminal-tab") return;
      createTerminalFromShortcut();
    });

    return () => {
      unsubscribe?.();
    };
  }, [createTerminalFromShortcut, isFocusedPane]);
  const activateTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadId) return;
      storeSetActiveTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeThreadId, storeSetActiveTerminal],
  );
  const closeTerminal = useCallback(
    async (terminalId: string) => {
      const api = readNativeApi();
      if (!activeThreadId || !api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const shouldDeletePlaceholderTerminalThread = shouldAutoDeleteTerminalThreadOnLastClose({
        isLastTerminal: isFinalTerminal,
        isServerThread,
        terminalEntryPoint: terminalState.entryPoint,
        thread: activeThread,
      });
      const confirmed = await confirmTerminalTabClose({
        api,
        enabled: shouldPromptForTerminalClose({
          confirmationEnabled: settings.confirmTerminalTabClose,
          runningTerminalIds: terminalState.runningTerminalIds,
          terminalAttentionStatesById: terminalState.terminalAttentionStatesById,
          terminalId,
        }),
        terminalTitle: resolveTerminalCloseTitle({
          terminalId,
          terminalLabelsById: terminalState.terminalLabelsById,
          terminalTitleOverridesById: terminalState.terminalTitleOverridesById,
        }),
        willDeleteThread: shouldDeletePlaceholderTerminalThread,
      });
      if (!confirmed) {
        return;
      }
      disposeAndCloseTerminalSession({
        api,
        threadId: activeThreadId,
        terminalId,
        clearHistoryBeforeClose: isFinalTerminal,
      });
      storeCloseTerminal(activeThreadId, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
      if (!shouldDeletePlaceholderTerminalThread) {
        return;
      }
      void (async () => {
        try {
          await api.orchestration.dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: activeThreadId,
          });
          const snapshot = await api.orchestration.getShellSnapshot();
          syncServerShellSnapshot(snapshot);
          useComposerDraftStore.getState().clearDraftThread(activeThreadId);
          storeClearTerminalState(activeThreadId);
          removeThreadFromSplitViews(activeThreadId);
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
          await handleNewChat({ fresh: true });
        } catch (error) {
          console.error("Failed to delete empty terminal thread after closing its last terminal", {
            threadId: activeThreadId,
            error,
          });
        }
      })();
    },
    [
      activeThread,
      activeThreadId,
      activeSplitView,
      handleNewChat,
      isServerThread,
      navigate,
      removeThreadFromSplitViews,
      storeClearTerminalState,
      storeCloseTerminal,
      syncServerShellSnapshot,
      settings.confirmTerminalTabClose,
      terminalState.entryPoint,
      terminalState.runningTerminalIds,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalIds.length,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
    ],
  );
  const closeActiveWorkspaceView = useCallback(() => {
    if (!activeThreadId || !terminalWorkspaceOpen) {
      return;
    }
    if (terminalState.workspaceLayout === "both" && terminalState.workspaceActiveTab === "chat") {
      // Going terminal-only hides the chat/terminal switcher, leaving chat-backed
      // threads with no mouse path back to chat. For those, collapse the workspace
      // to the normal chat + terminal-drawer layout instead of stranding the user.
      if (terminalState.entryPoint === "chat") {
        collapseTerminalWorkspace();
        return;
      }
      storeCloseWorkspaceChat(activeThreadId);
      return;
    }
    closeTerminal(terminalState.activeTerminalId);
  }, [
    activeThreadId,
    closeTerminal,
    collapseTerminalWorkspace,
    storeCloseWorkspaceChat,
    terminalState.activeTerminalId,
    terminalState.entryPoint,
    terminalState.workspaceActiveTab,
    terminalState.workspaceLayout,
    terminalWorkspaceOpen,
  ]);
  // The terminal's panel toggle mirrors the right dock's collapse control: it shows
  // or hides the side panel only when this thread already has a pane to show.
  const rightDockOpen = useRightDockStore((store) => selectRightDockState(threadId)(store).open);
  const isMobileViewport = useIsMobile();
  // The Environment panel replaces the old header diff toggle + footer pickers for normal
  // threads; disposable (temporary/draft) threads keep the legacy inline controls.
  const isDisposableThread = useIsDisposableThread(threadId);
  const environmentEnabled = !isDisposableThread && !isEditorRail;
  const environmentDefaultOpen = resolveDefaultEnvironmentPanelOpen({
    environmentEnabled,
    isCenteredEmptyLanding,
    isTerminalPrimarySurface,
  });
  const [environmentPanelOpen, setEnvironmentPanelOpen] = useState(() => environmentDefaultOpen);
  useEffect(() => {
    // Terminal threads keep the Environment panel closed by default so the full
    // workspace stays untouched until the user explicitly toggles the overlay.
    // Each normal chat thread starts open; empty/disposable views stay hidden.
    setEnvironmentPanelOpen(environmentDefaultOpen);
  }, [environmentDefaultOpen, threadId]);
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
  const terminalDrawerProps = useMemo(
    () => ({
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
        metadata: { cliKind: "codex" | "claude" | null; label: string },
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
      onAddTerminalContext: addTerminalContextToDraft,
    }),
    [
      activeProject?.cwd,
      activateTerminal,
      addTerminalContextToDraft,
      closeTerminal,
      closeTerminalShortcutLabel,
      closeWorkspaceShortcutLabel,
      createNewTerminal,
      createNewTerminalTab,
      moveTerminalToNewGroup,
      gitCwd,
      activeThreadId,
      newTerminalShortcutLabel,
      setTerminalHeight,
      splitTerminalRight,
      splitTerminalDown,
      splitTerminalShortcutLabel,
      splitTerminalDownShortcutLabel,
      storeCloseTerminalGroup,
      storeResizeTerminalSplit,
      storeSetTerminalActivity,
      storeSetTerminalMetadata,
      terminalFocusRequestId,
      terminalState.activeTerminalGroupId,
      terminalState.activeTerminalId,
      terminalState.terminalAttentionStatesById,
      terminalState.terminalCliKindsById,
      terminalState.terminalGroups,
      terminalState.terminalHeight,
      terminalState.terminalIds,
      terminalState.terminalLabelsById,
      terminalState.terminalTitleOverridesById,
      terminalState.runningTerminalIds,
      threadId,
      threadTerminalRuntimeEnv,
      toggleRightDock,
      rightDockOpen,
      hasRightDockPanes,
    ],
  );
  const runProjectScript = useCallback(
    async (
      script: ProjectScript,
      options?: {
        cwd?: string;
        env?: Record<string, string>;
        worktreePath?: string | null;
        preferNewTerminal?: boolean;
        rememberAsLastInvoked?: boolean;
      },
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId || !activeProject || !activeThread) return;
      if (options?.rememberAsLastInvoked !== false) {
        setLastInvokedScriptByProjectId((current) => {
          if (current[activeProject.id] === script.id) return current;
          return { ...current, [activeProject.id]: script.id };
        });
      }
      const targetCwd = options?.cwd ?? gitCwd ?? activeProject.cwd;
      const baseTerminalId =
        terminalState.activeTerminalId ||
        terminalState.terminalIds[0] ||
        DEFAULT_THREAD_TERMINAL_ID;
      const { shouldCreateNewTerminal, terminalId: targetTerminalId } =
        resolveProjectScriptTerminalTarget({
          baseTerminalId,
          createTerminalId: randomTerminalId,
          hasRunningTerminal: terminalState.runningTerminalIds.length > 0,
          preferNewTerminal: options?.preferNewTerminal,
          terminalOpen: terminalState.terminalOpen,
        });

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      try {
        const { metadata } = await runProjectCommandInTerminal({
          api,
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          project: {
            cwd: activeProject.cwd,
          },
          cwd: targetCwd,
          command: script.command,
          worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
          ...(options?.env ? { env: options.env } : {}),
        });
        if (metadata) {
          storeSetTerminalMetadata(activeThreadId, targetTerminalId, {
            cliKind: metadata.cliKind,
            label: metadata.label,
          });
        }
      } catch (error) {
        setThreadError(
          activeThreadId,
          error instanceof Error ? error.message : `Failed to run script "${script.name}".`,
        );
      }
    },
    [
      activeProject,
      activeThread,
      activeThreadId,
      gitCwd,
      setTerminalOpen,
      setThreadError,
      storeNewTerminal,
      storeSetActiveTerminal,
      storeSetTerminalMetadata,
      setLastInvokedScriptByProjectId,
      terminalState.activeTerminalId,
      terminalState.terminalOpen,
      terminalState.runningTerminalIds,
      terminalState.terminalIds,
    ],
  );
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
    setStoreThreadWorkspace,
    syncServerShellSnapshot,
  });
  const persistProjectScripts = useCallback(
    async (input: {
      projectId: ProjectId;
      projectCwd: string;
      previousScripts: ProjectScript[];
      nextScripts: ProjectScript[];
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }) => {
      const api = readNativeApi();
      if (!api) return;

      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        scripts: input.nextScripts,
      });

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        await api.server.upsertKeybinding(keybindingRule);
        await queryClient.invalidateQueries({ queryKey: serverQueryKeys.all });
      }
    },
    [queryClient],
  );
  const saveProjectScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const nextId = nextProjectScriptId(
        input.name,
        activeProject.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...activeProject.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...activeProject.scripts, nextScript];

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const updateProjectScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!activeProject) return;
      const existingScript = activeProject.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        throw new Error("Script not found.");
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = activeProject.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      await persistProjectScripts({
        projectId: activeProject.id,
        projectCwd: activeProject.cwd,
        previousScripts: activeProject.scripts,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [activeProject, persistProjectScripts],
  );
  const deleteProjectScript = useCallback(
    async (scriptId: string) => {
      if (!activeProject) return;
      const nextScripts = activeProject.scripts.filter((script) => script.id !== scriptId);

      const deletedName = activeProject.scripts.find((s) => s.id === scriptId)?.name;

      try {
        await persistProjectScripts({
          projectId: activeProject.id,
          projectCwd: activeProject.cwd,
          previousScripts: activeProject.scripts,
          nextScripts,
          keybinding: null,
          keybindingCommand: commandForProjectScript(scriptId),
        });
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not delete action",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    },
    [activeProject, persistProjectScripts],
  );

  const handleRuntimeModeChange = useCallback(
    (mode: RuntimeMode) => {
      if (mode === runtimeMode) return;
      setComposerDraftRuntimeMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { runtimeMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.runtime-mode.set",
              commandId: newCommandId(),
              threadId,
              runtimeMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update access mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      isLocalDraftThread,
      runtimeMode,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftRuntimeMode,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      if (serverThread) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration
            .dispatchCommand({
              type: "thread.interaction-mode.set",
              commandId: newCommandId(),
              threadId,
              interactionMode: mode,
              createdAt: new Date().toISOString(),
            })
            .catch((error) => {
              toastManager.add({
                type: "error",
                title: "Could not update plan mode",
                description:
                  error instanceof Error ? error.message : "An unexpected error occurred.",
              });
            });
        }
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
      serverThread,
      setComposerDraftInteractionMode,
      setDraftThreadContext,
      threadId,
    ],
  );
  const toggleInteractionMode = useCallback(() => {
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  }, [handleInteractionModeChange, interactionMode]);
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
  }, [activeTaskList?.turnId, sidebarProposedPlan?.turnId]);
  const setPlanMode = useCallback(
    (enabled: boolean) => {
      handleInteractionModeChange(enabled ? "plan" : "default");
    },
    [handleInteractionModeChange],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }) => {
      if (!serverThread) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }

      if (
        input.modelSelection !== undefined &&
        (input.modelSelection.model !== serverThread.modelSelection.model ||
          input.modelSelection.provider !== serverThread.modelSelection.provider ||
          JSON.stringify(input.modelSelection.options ?? null) !==
            JSON.stringify(serverThread.modelSelection.options ?? null))
      ) {
        await api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: input.threadId,
          modelSelection: input.modelSelection,
        });
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.runtime-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          runtimeMode: input.runtimeMode,
          createdAt: input.createdAt,
        });
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        await api.orchestration.dispatchCommand({
          type: "thread.interaction-mode.set",
          commandId: newCommandId(),
          threadId: input.threadId,
          interactionMode: input.interactionMode,
          createdAt: input.createdAt,
        });
      }
    },
    [serverThread],
  );

  // Scroll helpers stay list-owned so transcript updates stop bouncing through
  // a separate measurement/controller loop during streaming.
  // Guards isAtEndRef from flipping during reflow-induced scroll events that
  // fire immediately after an explicit scrollToEnd.
  const programmaticScrollUntilRef = useRef(0);
  const scrollToEnd = useCallback((animated = false) => {
    programmaticScrollUntilRef.current = performance.now() + 200;
    legendListRef.current?.scrollToEnd?.({ animated });
  }, []);
  const armTranscriptAutoFollow = useCallback((targetThreadId: ThreadId) => {
    autoFollowThreadIdRef.current = targetThreadId;
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
  }, []);
  const clearTranscriptAutoFollow = useCallback(() => {
    autoFollowThreadIdRef.current = null;
  }, []);
  useLayoutEffect(() => {
    const previousHeight = previousActiveTaskListCardHeightRef.current;
    previousActiveTaskListCardHeightRef.current = activeTaskListCardHeight;

    if (previousHeight <= 0 || activeTaskListCardHeight <= 0 || planSidebarOpen) {
      return;
    }

    const delta = activeTaskListCardHeight - previousHeight;
    if (delta <= 0.5) {
      return;
    }
    if (!isAtEndRef.current) {
      return;
    }

    const scrollContainer = legendListRef.current?.getScrollableNode?.();
    if (!(scrollContainer instanceof HTMLElement)) {
      return;
    }

    programmaticScrollUntilRef.current = performance.now() + 200;
    scrollContainer.scrollTop += delta;
  }, [activeTaskListCardHeight, planSidebarOpen]);
  const transcriptMessageCount = useMemo(
    () => timelineEntries.filter((entry) => entry.kind === "message").length,
    [timelineEntries],
  );
  const latestTranscriptMessage = useMemo(() => {
    for (let index = timelineEntries.length - 1; index >= 0; index -= 1) {
      const entry = timelineEntries[index];
      if (entry?.kind === "message") {
        return entry.message;
      }
    }
    return null;
  }, [timelineEntries]);
  const transcriptTailKey = latestTranscriptMessage
    ? [
        latestTranscriptMessage.id,
        latestTranscriptMessage.role,
        latestTranscriptMessage.streaming ? "streaming" : "settled",
        latestTranscriptMessage.text.length > 0 ? "content" : "empty",
        latestTranscriptMessage.completedAt ?? "",
      ].join(":")
    : "empty";
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return;
    if (!isAtEnd && performance.now() < programmaticScrollUntilRef.current) return;
    isAtEndRef.current = isAtEnd;
    if (isAtEnd) {
      showScrollDebouncer.current.cancel();
      setShowScrollToBottom(false);
    } else {
      showScrollDebouncer.current.maybeExecute();
    }
  }, []);
  const cancelPendingInteractionAnchorAdjustment = useCallback(() => {
    const pendingFrame = pendingInteractionAnchorFrameRef.current;
    if (pendingFrame === null) return;
    pendingInteractionAnchorFrameRef.current = null;
    window.cancelAnimationFrame(pendingFrame);
  }, []);
  const onMessagesClickCaptureBase = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const scrollContainer = legendListRef.current?.getScrollableNode?.();
      if (!(scrollContainer instanceof HTMLElement) || !(event.target instanceof Element)) return;

      const trigger = event.target.closest<HTMLElement>(
        "button, summary, [role='button'], [data-scroll-anchor-target]",
      );
      if (!trigger || !scrollContainer.contains(trigger)) return;
      if (trigger.closest("[data-scroll-anchor-ignore]")) return;

      pendingInteractionAnchorRef.current = {
        element: trigger,
        top: trigger.getBoundingClientRect().top,
      };

      cancelPendingInteractionAnchorAdjustment();
      pendingInteractionAnchorFrameRef.current = window.requestAnimationFrame(() => {
        pendingInteractionAnchorFrameRef.current = null;
        const anchor = pendingInteractionAnchorRef.current;
        pendingInteractionAnchorRef.current = null;
        const activeScrollContainer = legendListRef.current?.getScrollableNode?.();
        if (!(activeScrollContainer instanceof HTMLElement) || !anchor) return;
        if (!anchor.element.isConnected || !activeScrollContainer.contains(anchor.element)) return;

        const nextTop = anchor.element.getBoundingClientRect().top;
        const delta = nextTop - anchor.top;
        if (Math.abs(delta) < 0.5) return;

        activeScrollContainer.scrollTop += delta;
      });
    },
    [cancelPendingInteractionAnchorAdjustment],
  );
  const onMessagesPointerCancelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerDownBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesPointerUpBase = useCallback(() => {}, []);
  const onMessagesScrollBase = useCallback(() => {}, []);
  const onMessagesTouchEndBase = useCallback(() => {}, []);
  const onMessagesTouchMoveBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesTouchStartBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  const onMessagesWheelBase = useCallback(() => {
    clearTranscriptAutoFollow();
  }, [clearTranscriptAutoFollow]);
  useLayoutEffect(() => {
    const shouldFollowPendingTurn =
      activeThread?.id !== undefined && autoFollowThreadIdRef.current === activeThread.id;
    if (!isAtEndRef.current && !shouldFollowPendingTurn) {
      return;
    }
    // Re-apply the bottom stick only for real transcript messages; tool/work
    // rows can arrive quickly and should not churn scroll/layout work.
    const frameId = window.requestAnimationFrame(() => {
      scrollToEnd(false);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [
    activeThread?.id,
    activeTurnInProgress,
    scrollToEnd,
    transcriptMessageCount,
    transcriptTailKey,
  ]);
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
      pendingUserInputs.length === 0 &&
      !isComposerApprovalState,
    composerImagesRef,
    composerAssistantSelectionsRef,
    addComposerAssistantSelectionToDraft,
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
  const createMarkerFromPendingSelection = useCallback(
    (style: ThreadMarkerStyle, color: ThreadMarkerColor) => {
      const pendingSelection = pendingTranscriptSelectionAction;
      if (!pendingSelection || !activeThreadId) {
        return;
      }
      const messageId = MessageId.makeUnsafe(pendingSelection.selection.assistantMessageId);
      const message = timelineMessages.find((candidate) => candidate.id === messageId);
      if (!message) {
        toastManager.add({
          type: "warning",
          title: "Could not find the selected message.",
        });
        return;
      }
      const range = resolveTranscriptMarkerRange({
        messageText: message.text,
        selectedText: pendingSelection.selection.text,
      });
      if (!range) {
        toastManager.add({
          type: "warning",
          title: "Select a unique phrase to mark it.",
          description: "Try including a few more words so Synara can find the exact place.",
        });
        return;
      }
      dismissTranscriptSelectionAction();
      window.getSelection()?.removeAllRanges();
      const sameStyleOverlappingMarkers = threadMarkers.filter(
        (marker) =>
          marker.messageId === messageId &&
          marker.style === style &&
          marker.startOffset < range.endOffset &&
          range.startOffset < marker.endOffset,
      );
      if (sameStyleOverlappingMarkers.length > 0) {
        for (const marker of sameStyleOverlappingMarkers) {
          void dispatchThreadMarkerRemove(activeThreadId, marker.id).catch((error) => {
            console.error("Failed to remove thread marker", error);
            toastManager.add({
              type: "error",
              title: "Could not remove marker.",
            });
          });
        }
        return;
      }
      void dispatchThreadMarkerAdd({
        threadId: activeThreadId,
        markerId: ThreadMarkerId.makeUnsafe(crypto.randomUUID()),
        messageId,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
        selectedText: message.text.slice(range.startOffset, range.endOffset),
        style,
        color,
      }).catch((error) => {
        console.error("Failed to create thread marker", error);
        toastManager.add({
          type: "error",
          title: "Could not create marker.",
        });
      });
    },
    [
      activeThreadId,
      dismissTranscriptSelectionAction,
      pendingTranscriptSelectionAction,
      threadMarkers,
      timelineMessages,
    ],
  );
  const createHighlightFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("highlight", "yellow");
  }, [createMarkerFromPendingSelection]);
  const createUnderlineFromPendingSelection = useCallback(() => {
    createMarkerFromPendingSelection("underline", "blue");
  }, [createMarkerFromPendingSelection]);

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
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;
      const roundedNextHeight = Math.ceil(nextHeight);
      if (roundedNextHeight > 0) {
        setSecondaryChromePlaceholderHeight((current) =>
          current === roundedNextHeight ? current : roundedNextHeight,
        );
      }
      if (previousHeight > 0 && Math.abs(nextHeight - previousHeight) < 0.5) {
        return;
      }
      if (!isAtEndRef.current) {
        return;
      }
      window.requestAnimationFrame(() => {
        scrollToEnd(false);
      });
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, isInactiveSplitPane, scrollToEnd]);

  useEffect(() => {
    setPullRequestDialogState(null);
    setRenameDialogOpen(false);
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    if (planSidebarOpenOnNextThreadRef.current) {
      planSidebarOpenOnNextThreadRef.current = false;
      setPlanSidebarOpen(true);
    } else {
      setPlanSidebarOpen(false);
    }
    planSidebarDismissedForTurnRef.current = null;
  }, [activeThread?.id]);

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
  }, [composerMenuItems, composerMenuOpen]);

  useEffect(() => {
    setIsRevertingCheckpoint(false);
  }, [activeThread?.id]);

  useEffect(() => {
    if (!activeThread?.id || terminalState.terminalOpen || isInactiveSplitPane) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, isInactiveSplitPane, terminalState.terminalOpen]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages]);

  useEffect(() => {
    composerAssistantSelectionsRef.current = composerAssistantSelections;
  }, [composerAssistantSelections]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts]);

  useEffect(() => {
    composerFileCommentsRef.current = composerFileComments;
  }, [composerFileComments]);

  useEffect(() => {
    queuedComposerTurnsRef.current = queuedComposerTurns;
  }, [queuedComposerTurns]);

  useEffect(() => {
    autoDispatchingQueuedTurnRef.current = false;
  }, [threadId]);

  useEffect(() => {
    if (!activeThread?.id) return;
    if (activeThread.messages.length === 0) {
      return;
    }
    const serverIds = new Set(activeThread.messages.map((message) => message.id));
    const removedMessages = optimisticUserMessages.filter((message) => serverIds.has(message.id));
    if (removedMessages.length === 0) {
      return;
    }
    const timer = window.setTimeout(() => {
      setOptimisticUserMessages((existing) =>
        existing.filter((message) => !serverIds.has(message.id)),
      );
    }, 0);
    for (const removedMessage of removedMessages) {
      const previewUrls = collectUserMessageBlobPreviewUrls(removedMessage);
      if (previewUrls.length > 0) {
        handoffAttachmentPreviews(removedMessage.id, previewUrls);
        continue;
      }
      revokeUserMessagePreviewUrls(removedMessage);
    }
    return () => {
      window.clearTimeout(timer);
    };
  }, [activeThread?.id, activeThread?.messages, handoffAttachmentPreviews, optimisticUserMessages]);

  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt]);

  useLayoutEffect(() => {
    updateSelectedComposerSkills(composerSkills);
    updateSelectedComposerMentions(composerMentions);
  }, [
    composerMentions,
    composerSkills,
    threadId,
    updateSelectedComposerMentions,
    updateSelectedComposerSkills,
  ]);

  useEffect(() => {
    updateSelectedComposerSkills((existing) => {
      const nextSkills = filterPromptSkillReferences(prompt, existing, selectedProvider);
      return providerSkillReferencesEqual(existing, nextSkills) ? existing : nextSkills;
    });
  }, [prompt, selectedProvider, updateSelectedComposerSkills]);

  useEffect(() => {
    updateSelectedComposerMentions((existing) => {
      const nextMentions = filterPromptProviderMentionReferences(prompt, existing);
      return providerMentionReferencesEqual(existing, nextMentions) ? existing : nextMentions;
    });
  }, [prompt, updateSelectedComposerMentions]);

  // Provider references are provider-specific; keep draft restores from looking like manual switches.
  useEffect(() => {
    const previous = previousSelectedProviderRef.current;
    previousSelectedProviderRef.current = {
      threadId,
      provider: selectedProvider,
    };
    if (!previous || previous.threadId !== threadId || previous.provider === selectedProvider) {
      return;
    }
    updateSelectedComposerSkills([]);
    updateSelectedComposerMentions([]);
  }, [selectedProvider, threadId, updateSelectedComposerMentions, updateSelectedComposerSkills]);

  useLayoutEffect(() => {
    // ChatView stays mounted across thread switches, so clear thread-local overlays before paint.
    setOptimisticUserMessages((existing) => {
      if (existing.length === 0) return existing;
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setExpandedImage(null);
  }, [threadId]);

  useEffect(() => {
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    void cancelVoiceRecording();
    setIsVoiceTranscribing(false);
    setOptimisticUserMessages((existing) => {
      if (existing.length === 0) return existing;
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setLocalDispatch(null);
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    setExpandedImage(null);
  }, [cancelVoiceRecording, threadId]);

  useEffect(() => {
    if (canStartVoiceNotes || !isVoiceRecording) {
      return;
    }
    warnVoiceGuard("cancelled active voice recording because voice became unavailable", {
      authStatus: voiceProviderStatus?.authStatus ?? null,
      voiceTranscriptionAvailable: voiceProviderStatus?.voiceTranscriptionAvailable ?? null,
      isVoiceRecording,
    });
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    void cancelVoiceRecording();
    setIsVoiceTranscribing(false);
  }, [
    canStartVoiceNotes,
    cancelVoiceRecording,
    isVoiceRecording,
    voiceProviderStatus?.authStatus,
    voiceProviderStatus?.voiceTranscriptionAvailable,
  ]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(threadId);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        useComposerDraftStore.getState().draftsByThreadId[threadId]?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) {
          return;
        }
        // Stage attachments in persisted draft state first so persist middleware can write them.
        syncComposerDraftPersistedAttachments(threadId, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds = fallbackPersistedAttachments
          .map((attachment) => attachment.id)
          .filter((id) => currentImageIds.has(id));
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) {
          return;
        }
        syncComposerDraftPersistedAttachments(threadId, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    clearComposerDraftPersistedAttachments,
    composerImages,
    syncComposerDraftPersistedAttachments,
    threadId,
  ]);

  const closeExpandedImage = useCallback(() => {
    setExpandedImage(null);
  }, []);
  const navigateExpandedImage = useCallback((direction: -1 | 1) => {
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
  }, []);

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
  }, [composerMenuOpen]);

  const activeWorktreePath = activeThread?.worktreePath;
  const envMode: DraftThreadEnvMode = isServerThread
    ? resolveThreadEnvironmentMode({
        envMode: activeThread?.envMode,
        worktreePath: activeWorktreePath ?? null,
      })
    : (draftThread?.envMode ?? "local");
  const envState = resolveThreadWorkspaceState({
    envMode: resolvedThreadEnvMode,
    worktreePath: resolvedThreadWorktreePath,
  });

  const beginLocalDispatch = useCallback(
    (options?: { preparingWorktree?: boolean }) => {
      const preparingWorktree = Boolean(options?.preparingWorktree);
      setLocalDispatch((current) => {
        if (current) {
          return current.preparingWorktree === preparingWorktree
            ? current
            : { ...current, preparingWorktree };
        }
        return createLocalDispatchSnapshot(activeThread, options);
      });
    },
    [activeThread],
  );

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, []);

  useEffect(() => {
    if (!serverAcknowledgedLocalDispatch) {
      return;
    }
    resetLocalDispatch();
  }, [resetLocalDispatch, serverAcknowledgedLocalDispatch]);

  useEffect(() => {
    if (!activeThreadId) return;
    const previous = terminalOpenByThreadRef.current[activeThreadId] ?? false;
    const current = Boolean(terminalState.terminalOpen);

    if (!previous && current) {
      terminalOpenByThreadRef.current[activeThreadId] = current;
      setTerminalFocusRequestId((value) => value + 1);
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
  }, [activeThreadId, focusComposer, terminalState.terminalOpen]);

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
  }, [activeThreadId, storeOpenTerminalThreadPage, terminalState.entryPoint]);

  useEffect(() => {
    if (!terminalWorkspaceOpen) {
      return;
    }

    if (terminalState.workspaceActiveTab === "terminal") {
      setTerminalFocusRequestId((value) => value + 1);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusComposer, terminalState.workspaceActiveTab, terminalWorkspaceOpen]);

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

  useEffect(() => {
    if (surfaceMode === "split" && !isFocusedPane) {
      return;
    }

    const handler = (event: globalThis.KeyboardEvent) => {
      if (!activeThreadId || event.defaultPrevented) return;
      // Mirror terminal interrupt semantics without stealing regular copy shortcuts.
      if (
        hasLiveTurn &&
        isMacPlatform(navigator.platform) &&
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c" &&
        eventTargetsComposer(event, composerFormRef.current)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void onInterrupt();
        return;
      }
      const composerPickerShortcutActive =
        !isTerminalFocused() &&
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        !isComposerApprovalState &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      const shortcutContext = {
        terminalFocus: isTerminalFocused(),
        terminalOpen: Boolean(terminalState.terminalOpen),
        terminalWorkspaceOpen,
        terminalWorkspaceTerminalOnly: terminalState.workspaceLayout === "terminal-only",
        terminalWorkspaceTerminalTabActive,
        terminalWorkspaceChatTabActive,
      };

      const command = resolveShortcutCommand(event, keybindings, {
        context: shortcutContext,
      });
      if (!command) return;

      if (command === "composer.focus.toggle") {
        if (isComposerApprovalState || isVoiceRecording || isVoiceTranscribing) return;
        event.preventDefault();
        event.stopPropagation();
        toggleComposerFocus();
        return;
      }

      if (command === "modelPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleModelPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "traitsPicker.toggle") {
        if (!composerPickerShortcutActive) return;
        event.preventDefault();
        event.stopPropagation();
        handleTraitsPickerOpenChange(true);
        scheduleComposerFocus();
        return;
      }

      if (command === "terminal.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility();
        return;
      }

      if (command === "terminal.split" || command === "terminal.splitRight") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalRight();
        return;
      }

      if (command === "terminal.splitLeft") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalLeft();
        return;
      }

      if (command === "terminal.splitDown") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalDown();
        return;
      }

      if (command === "terminal.splitUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) {
          setTerminalOpen(true);
        }
        splitTerminalUp();
        return;
      }

      if (command === "terminal.close") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalState.terminalOpen) return;
        closeTerminal(terminalState.activeTerminalId);
        return;
      }

      if (command === "terminal.new") {
        event.preventDefault();
        event.stopPropagation();
        createTerminalFromShortcut();
        return;
      }

      if (command === "terminal.workspace.newFullWidth") {
        event.preventDefault();
        event.stopPropagation();
        openNewFullWidthTerminal();
        return;
      }

      if (command === "terminal.workspace.closeActive") {
        event.preventDefault();
        event.stopPropagation();
        closeActiveWorkspaceView();
        return;
      }

      if (command === "terminal.workspace.terminal") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("terminal");
        return;
      }

      if (command === "terminal.workspace.chat") {
        event.preventDefault();
        event.stopPropagation();
        if (!terminalWorkspaceOpen) return;
        setTerminalWorkspaceTab("chat");
        return;
      }

      if (command === "diff.toggle") {
        event.preventDefault();
        event.stopPropagation();
        onToggleDiff();
        return;
      }

      if (command === "browser.toggle") {
        event.preventDefault();
        event.stopPropagation();
        if (!isElectron) return;
        onToggleBrowser();
        return;
      }

      if (command === "chat.split") {
        event.preventDefault();
        event.stopPropagation();
        if (surfaceMode === "single" && onSplitSurface) {
          onSplitSurface();
        }
        return;
      }

      const scriptId = projectScriptIdFromCommand(command);
      if (!scriptId || !activeProject) return;
      const script = activeProject.scripts.find((entry) => entry.id === scriptId);
      if (!script) return;
      event.preventDefault();
      event.stopPropagation();
      void runProjectScript(script);
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, [
    activeProject,
    terminalState.terminalOpen,
    terminalState.activeTerminalId,
    terminalState.workspaceLayout,
    activeThreadId,
    closeTerminal,
    closeActiveWorkspaceView,
    createTerminalFromShortcut,
    setTerminalOpen,
    openNewFullWidthTerminal,
    runProjectScript,
    keybindings,
    splitTerminalDown,
    splitTerminalLeft,
    splitTerminalRight,
    splitTerminalUp,
    terminalWorkspaceChatTabActive,
    terminalWorkspaceOpen,
    terminalWorkspaceTerminalTabActive,
    onToggleBrowser,
    onToggleDiff,
    onInterrupt,
    onSplitSurface,
    isFocusedPane,
    hasLiveTurn,
    handleModelPickerOpenChange,
    handleTraitsPickerOpenChange,
    isComposerApprovalState,
    isVoiceRecording,
    isVoiceTranscribing,
    setTerminalWorkspaceTab,
    surfaceMode,
    scheduleComposerFocus,
    toggleComposerFocus,
    toggleTerminalVisibility,
  ]);

  const startComposerVoiceRecording = useCallback(async () => {
    if (!activeProject) {
      return;
    }
    if (voiceProviderStatus?.authStatus === "unauthenticated") {
      toastManager.add({
        type: "error",
        title: "Sign in to ChatGPT in Codex before using voice notes.",
      });
      return;
    }
    if (!canStartVoiceNotes) {
      toastManager.add({
        type: "error",
        title: "Voice notes require a ChatGPT-authenticated Codex session.",
      });
      return;
    }
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Answer plan questions before recording a voice note.",
      });
      return;
    }

    try {
      await startVoiceRecording();
      voiceRecordingStartedAtRef.current = performance.now();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not start recording",
        description: describeVoiceRecordingStartError(error),
      });
    }
  }, [
    activeProject,
    canStartVoiceNotes,
    pendingUserInputs.length,
    startVoiceRecording,
    voiceProviderStatus?.authStatus,
  ]);

  const submitComposerVoiceRecording = useCallback(async () => {
    if (!activeProject || !isVoiceRecording) {
      return;
    }
    const recordedForMs =
      voiceRecordingStartedAtRef.current === null
        ? null
        : Math.round(performance.now() - voiceRecordingStartedAtRef.current);
    if (
      recordedForMs !== null &&
      recordedForMs >= 0 &&
      recordedForMs < VOICE_RECORDER_ACTION_ARM_DELAY_MS
    ) {
      warnVoiceGuard("ignored recorder action immediately after start", {
        recordedForMs,
      });
      return;
    }

    const api = readNativeApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Voice transcription is unavailable right now.",
      });
      void cancelVoiceRecording();
      return;
    }

    setIsVoiceTranscribing(true);
    const requestId = voiceTranscriptionRequestIdRef.current + 1;
    voiceTranscriptionRequestIdRef.current = requestId;
    const requestThreadId = threadId;
    const requestProvider = selectedProvider;
    const isCurrentVoiceRequest = () =>
      voiceTranscriptionRequestIdRef.current === requestId &&
      voiceThreadIdRef.current === requestThreadId &&
      voiceProviderRef.current === requestProvider;

    try {
      const payload = await stopVoiceRecording();
      if (!isCurrentVoiceRequest()) {
        return;
      }
      if (!payload) {
        toastManager.add({
          type: "warning",
          title: "No audio was captured.",
        });
        return;
      }
      const result = await api.server.transcribeVoice({
        provider: "codex",
        cwd: activeProject.cwd,
        ...(activeThread ? { threadId: activeThread.id } : {}),
        ...payload,
      });
      if (!isCurrentVoiceRequest()) {
        return;
      }
      appendVoiceTranscriptToComposer(result.text);
    } catch (error) {
      if (!isCurrentVoiceRequest()) {
        return;
      }
      const description =
        error instanceof Error
          ? sanitizeVoiceErrorMessage(error.message)
          : "The voice note could not be transcribed.";
      const authExpired = isVoiceAuthExpiredMessage(description);
      if (authExpired) {
        refreshVoiceStatus();
      }
      toastManager.add({
        type: "error",
        title: authExpired ? "Sign in to ChatGPT again" : "Couldn't transcribe voice note",
        description: authExpired
          ? "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry."
          : description,
        ...(authExpired
          ? {
              actionProps: {
                children: "Refresh status",
                onClick: refreshVoiceStatus,
              },
            }
          : {}),
      });
    } finally {
      if (isCurrentVoiceRequest()) {
        voiceRecordingStartedAtRef.current = null;
        setIsVoiceTranscribing(false);
      }
    }
  }, [
    activeProject,
    activeThread,
    appendVoiceTranscriptToComposer,
    cancelVoiceRecording,
    isVoiceRecording,
    refreshVoiceStatus,
    selectedProvider,
    stopVoiceRecording,
    threadId,
  ]);

  const cancelComposerVoiceRecording = useCallback(() => {
    const recordedForMs =
      voiceRecordingStartedAtRef.current === null
        ? null
        : Math.round(performance.now() - voiceRecordingStartedAtRef.current);
    if (
      recordedForMs !== null &&
      recordedForMs >= 0 &&
      recordedForMs < VOICE_RECORDER_ACTION_ARM_DELAY_MS
    ) {
      warnVoiceGuard("ignored recorder action immediately after start", {
        recordedForMs,
      });
      return;
    }
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    setIsVoiceTranscribing(false);
    void cancelVoiceRecording();
  }, [cancelVoiceRecording]);

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
      if (!activeThreadId || files.length === 0) return;

      if (pendingUserInputs.length > 0) {
        toastManager.add({
          type: "error",
          title: "Attach images after answering plan questions.",
        });
        return;
      }

      const { images: nextImages, error } = buildComposerImageAttachmentsFromFiles({
        files,
        existingAttachmentCount:
          composerImagesRef.current.length + composerAssistantSelectionsRef.current.length,
      });

      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      setThreadError(activeThreadId, error);
    },
    [
      activeThreadId,
      addComposerImage,
      addComposerImagesToDraft,
      pendingUserInputs.length,
      setThreadError,
    ],
  );

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const {
    onComposerPaste,
    onComposerDragEnter,
    onComposerDragOver,
    onComposerDragLeave,
    onComposerDrop,
  } = useComposerDropzone({
    addImages: addComposerImages,
    appendReferenceText: (referenceText) => appendComposerPromptText(threadId, referenceText),
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
    [activeThread, hasLiveTurn, isConnecting, isRevertingCheckpoint, isSendBusy, setThreadError],
  );

  const onCreateHandoffThread = useCallback(
    async (targetProvider: ProviderKind) => {
      if (!activeThread || handoffDisabled) {
        return;
      }

      try {
        const targetAvailability = resolveProviderSendAvailability({
          provider: targetProvider,
          statuses: providerStatuses,
        });
        if (!targetAvailability.usable) {
          toastManager.add({
            type: "error",
            title: targetAvailability.unavailableReason,
          });
          return;
        }
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
    [activeThread, createThreadHandoff, handoffDisabled, providerStatuses],
  );

  const clearComposerInput = useCallback(
    (threadId: ThreadId) => {
      promptRef.current = "";
      clearComposerDraftContent(threadId);
      updateSelectedComposerSkills([]);
      updateSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [clearComposerDraftContent, updateSelectedComposerMentions, updateSelectedComposerSkills],
  );

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
      const restoredImages =
        queuedTurn.kind === "chat" ? queuedTurn.images.map(cloneComposerImageAttachment) : [];
      const restoredAssistantSelections =
        queuedTurn.kind === "chat" ? queuedTurn.assistantSelections : [];
      const restoredFileComments = queuedTurn.kind === "chat" ? queuedTurn.fileComments : [];
      promptRef.current = nextPrompt;
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
      // Editing a queued turn should recreate the same draft state the user queued.
      setDraftThreadContext(activeThread.id, {
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        ...(queuedTurn.kind === "chat" ? { envMode: queuedTurn.envMode } : {}),
      });
      if (queuedTurn.kind === "chat") {
        if (restoredImages.length > 0) {
          addComposerImagesToDraft(restoredImages);
        }
        for (const selection of restoredAssistantSelections) {
          addComposerAssistantSelectionToDraft(selection);
        }
        for (const comment of restoredFileComments) {
          addComposerFileCommentToDraft(comment);
        }
        if (queuedTurn.terminalContexts.length > 0) {
          addComposerTerminalContextsToDraft(queuedTurn.terminalContexts);
        }
        updateSelectedComposerSkills(queuedTurn.skills);
        updateSelectedComposerMentions(queuedTurn.mentions);
      } else {
        updateSelectedComposerSkills([]);
        updateSelectedComposerMentions([]);
      }
      setComposerDraftModelSelection(activeThread.id, queuedTurn.modelSelection);
      setComposerDraftRuntimeMode(activeThread.id, queuedTurn.runtimeMode);
      setComposerDraftInteractionMode(activeThread.id, queuedTurn.interactionMode);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      activeThread,
      addComposerAssistantSelectionToDraft,
      addComposerFileCommentToDraft,
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      clearComposerDraftContent,
      scheduleComposerFocus,
      setDraftThreadContext,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const removeQueuedComposerTurn = useCallback(
    (queuedTurnId: string) => {
      removeQueuedComposerTurnFromDraft(threadId, queuedTurnId);
    },
    [removeQueuedComposerTurnFromDraft, threadId],
  );

  const onSend = async (
    e?: { preventDefault: () => void },
    dispatchMode: "queue" | "steer" = "queue",
    queuedTurn?: QueuedComposerChatTurn,
  ): Promise<boolean> => {
    e?.preventDefault();
    const api = readNativeApi();
    if (
      !api ||
      !activeThread ||
      isSendBusy ||
      isConnecting ||
      isVoiceTranscribing ||
      sendInFlightRef.current
    ) {
      return false;
    }
    if (activePendingProgress) {
      const activeQuestion = activePendingProgress.activeQuestion;
      const liveComposerSnapshot = composerEditorRef.current?.readSnapshot() ?? null;
      const livePendingAnswerText = liveComposerSnapshot?.value ?? promptRef.current;
      const currentDraftAnswer =
        activePendingUserInput && activeQuestion
          ? pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId]?.[
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
      if (activePendingUserInput && answerOverrides) {
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId],
          ...answerOverrides,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInput.requestId]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: nextRequestAnswers,
        }));
      }
      return onAdvanceActivePendingUserInput(answerOverrides);
    }
    const queuedChatTurn = queuedTurn ?? null;
    const liveComposerSnapshot =
      queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
    const promptForSend =
      queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
    let composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    const composerAssistantSelectionsForSend =
      queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
    const composerFileCommentsForSend = queuedChatTurn?.fileComments ?? composerFileComments;
    const composerTerminalContextsForSend =
      queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
    const selectedComposerSkillsForSend =
      queuedChatTurn?.skills ?? selectedComposerSkillsRef.current;
    const selectedComposerMentionsForSend =
      queuedChatTurn?.mentions ?? selectedComposerMentionsRef.current;
    const selectedProviderForSend = queuedChatTurn?.selectedProvider ?? selectedProvider;
    const selectedModelForSend = queuedChatTurn?.selectedModel ?? selectedModel;
    const selectedPromptEffortForSend =
      queuedChatTurn?.selectedPromptEffort ?? selectedPromptEffort;
    const selectedModelSelectionForSend = queuedChatTurn?.modelSelection ?? selectedModelSelection;
    const providerOptionsForDispatchForSend =
      queuedChatTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch;
    const runtimeModeForSend = queuedChatTurn?.runtimeMode ?? runtimeMode;
    const interactionModeForSend = queuedChatTurn?.interactionMode ?? interactionMode;
    const envModeForSend = queuedChatTurn?.envMode ?? envMode;
    const {
      trimmedPrompt: trimmed,
      sendableTerminalContexts: sendableComposerTerminalContexts,
      expiredTerminalContextCount,
      hasSendableContent,
    } = deriveComposerSendState({
      prompt: promptForSend,
      imageCount: composerImagesForSend.length,
      assistantSelectionCount: composerAssistantSelectionsForSend.length,
      fileCommentCount: composerFileCommentsForSend.length,
      terminalContexts: composerTerminalContextsForSend,
    });
    // Queued chat turns already captured their intended mode; only live composer
    // submissions should be interpreted as plan refinement/implementation.
    if (queuedChatTurn === null && showPlanFollowUpPrompt && activeProposedPlan) {
      const followUp = resolvePlanFollowUpSubmission({
        draftText: trimmed,
        planMarkdown: activeProposedPlan.planMarkdown,
      });
      if (hasLiveTurn && dispatchMode === "queue" && queuedChatTurn === null) {
        clearComposerInput(activeThread.id);
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
          modelSelection: selectedModelSelection,
          ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
          runtimeMode,
        });
        return true;
      }
      clearComposerInput(activeThread.id);
      return onSubmitPlanFollowUp({
        text: followUp.text,
        interactionMode: followUp.interactionMode,
        dispatchMode,
      });
    }
    if (
      composerImagesForSend.length === 0 &&
      composerAssistantSelectionsForSend.length === 0 &&
      composerFileCommentsForSend.length === 0 &&
      sendableComposerTerminalContexts.length === 0
    ) {
      const handledSlashCommand = await handleStandaloneSlashCommand(trimmed);
      if (handledSlashCommand) {
        return true;
      }
    }
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
    const sendProviderAvailability = resolveProviderSendAvailability({
      provider: selectedModelSelectionForSend.provider,
      statuses: providerStatuses,
    });
    if (!sendProviderAvailability.usable) {
      toastManager.add({
        type: "error",
        title: sendProviderAvailability.unavailableReason,
      });
      return false;
    }

    const browserPromptAttachment: BrowserPromptAttachmentResolution =
      await maybeResolveBrowserPromptAttachment({
        api,
        threadId: activeThread.id,
        prompt: promptForSend,
      }).catch(
        (): BrowserPromptAttachmentResolution => ({
          requested: false,
          image: null,
        }),
      );
    if (browserPromptAttachment.image) {
      const nextAttachmentCount =
        composerImagesForSend.length +
        composerAssistantSelectionsForSend.length +
        (browserPromptAttachment.image ? 1 : 0);
      if (nextAttachmentCount <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        composerImagesForSend = [...composerImagesForSend, browserPromptAttachment.image];
      } else {
        toastManager.add({
          type: "warning",
          title: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`,
          description:
            "The current browser screenshot was skipped because this message is already at the attachment limit.",
        });
      }
    } else if (browserPromptAttachment.requested) {
      const description =
        browserPromptAttachment.reason === "no-open-browser"
          ? "Open the in-app browser first, then try again."
          : browserPromptAttachment.reason === "no-active-tab"
            ? "The in-app browser has no active tab to capture yet."
            : browserPromptAttachment.reason === "attachment-too-large"
              ? `The browser screenshot exceeded the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`
              : "The current browser context could not be attached.";
      toastManager.add({
        type: "warning",
        title: "Couldn’t attach the in-app browser context",
        description,
      });
    }

    if (hasLiveTurn && dispatchMode === "queue" && queuedChatTurn === null) {
      clearComposerInput(activeThread.id);
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
          assistantSelections: composerAssistantSelectionsForSend,
          terminalContexts: sendableComposerTerminalContexts,
          fileComments: composerFileCommentsForSend,
        }),
        prompt: promptForSend,
        images: queuedImagesForPersistence,
        assistantSelections: composerAssistantSelectionsForSend,
        fileComments: composerFileCommentsForSend,
        terminalContexts: sendableComposerTerminalContexts,
        skills: selectedComposerSkillsForSend,
        mentions: selectedComposerMentionsForSend,
        selectedProvider: selectedProviderForSend,
        selectedModel: selectedModelForSend,
        selectedPromptEffort: selectedPromptEffortForSend,
        modelSelection: selectedModelSelectionForSend,
        ...(providerOptionsForDispatchForSend
          ? { providerOptionsForDispatch: providerOptionsForDispatchForSend }
          : {}),
        runtimeMode: runtimeModeForSend,
        interactionMode: interactionModeForSend,
        envMode: envModeForSend,
      });
      return true;
    }
    const threadIdForSend = activeThread.id;
    const isFirstMessage = !isServerThread || !hasNativeUserMessages;
    const firstSendCreatedAt = new Date();
    let firstComposerImageNameForTitle: string | null = null;
    if (composerImagesForSend.length > 0) {
      firstComposerImageNameForTitle = composerImagesForSend[0]?.name ?? null;
    }
    let titleSeed = trimmed;
    if (!titleSeed) {
      if (firstComposerImageNameForTitle) {
        titleSeed = `Image: ${firstComposerImageNameForTitle}`;
      } else if (composerAssistantSelectionsForSend.length > 0) {
        titleSeed = formatAssistantSelectionTitleSeed(composerAssistantSelectionsForSend.length);
      } else if (sendableComposerTerminalContexts.length > 0) {
        titleSeed = formatTerminalContextLabel(sendableComposerTerminalContexts[0]!);
      } else if (composerFileCommentsForSend.length > 0) {
        titleSeed = formatFileCommentTitleSeed(composerFileCommentsForSend.length);
      } else {
        titleSeed = GENERIC_CHAT_THREAD_TITLE;
      }
    }
    // Keep the optimistic label short while the server asks Codex for a better summary.
    const title = buildPromptThreadTitleFallback(titleSeed);
    const firstSendTarget = resolveFirstSendTarget({
      activeProject,
      chatWorkspaceRoot,
      createdAt: firstSendCreatedAt,
      isFirstMessage,
      isHomeChatContainer,
      projects: useStore.getState().projects,
      selectedWorkspaceRoot: isHomeChatContainer ? (resolvedThreadWorktreePath ?? null) : null,
      title,
      titleSeed,
    });
    let {
      targetProjectId: targetProjectIdForSend,
      targetProjectKind: targetProjectKindForSend,
      targetProjectCwd: targetProjectCwdForSend,
      targetProjectScripts: targetProjectScriptsForSend,
      targetProjectDefaultModelSelection: targetProjectDefaultModelSelectionForSend,
    } = firstSendTarget.kind === "create-project"
      ? {
          targetProjectId: activeProject.id,
          targetProjectKind: activeProject.kind,
          targetProjectCwd: activeProject.cwd,
          targetProjectScripts: activeProject.kind === "project" ? activeProject.scripts : [],
          targetProjectDefaultModelSelection: activeProject.defaultModelSelection ?? null,
        }
      : firstSendTarget.target;
    let nextRuntimeModeForSend = runtimeModeForSend;
    let nextThreadEnvMode = envModeForSend;
    let nextThreadBranch = activeThread.branch;
    let nextThreadWorktreePath = activeThread.worktreePath;

    if (isFirstMessage && isHomeChatContainer && firstSendTarget.kind !== "current") {
      if (firstSendTarget.kind === "create-project") {
        const projectId = newProjectId();
        const createdAt = firstSendCreatedAt.toISOString();
        try {
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            kind: firstSendTarget.creation.kind,
            title: firstSendTarget.creation.title,
            workspaceRoot: firstSendTarget.creation.workspaceRoot,
            createWorkspaceRootIfMissing: firstSendTarget.creation.createWorkspaceRootIfMissing,
            defaultModelSelection: firstSendTarget.creation.defaultModelSelection,
            createdAt,
          });
          targetProjectIdForSend = projectId;
          targetProjectKindForSend = firstSendTarget.creation.kind;
          targetProjectCwdForSend = firstSendTarget.creation.workspaceRoot;
          targetProjectScriptsForSend = [];
          targetProjectDefaultModelSelectionForSend =
            firstSendTarget.creation.defaultModelSelection;
        } catch (error) {
          const description =
            error instanceof Error ? error.message : "Failed to create the selected project.";
          if (!isDuplicateProjectCreateError(description)) {
            throw error;
          }

          // If the server already knows this workspace root, reuse that project and continue.
          const { snapshot, project: recoveredProject } =
            await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: firstSendTarget.creation.workspaceRoot,
              loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
            });
          if (!snapshot || !recoveredProject) {
            throw error;
          }

          syncServerShellSnapshot(snapshot);
          targetProjectIdForSend = recoveredProject.id;
          targetProjectKindForSend = recoveredProject.kind ?? firstSendTarget.creation.kind;
          targetProjectCwdForSend = recoveredProject.workspaceRoot;
          targetProjectScriptsForSend =
            (recoveredProject.kind ?? firstSendTarget.creation.kind) === "project"
              ? [...recoveredProject.scripts]
              : [];
          targetProjectDefaultModelSelectionForSend =
            recoveredProject.defaultModelSelection ??
            firstSendTarget.creation.defaultModelSelection;
        }
      }

      clearProjectDraftThreadId(targetProjectIdForSend);
      setDraftThreadContext(threadIdForSend, {
        projectId: targetProjectIdForSend,
        envMode: "local",
        worktreePath: null,
        branch: null,
      });
      nextThreadEnvMode = "local";
      nextThreadBranch = null;
      nextThreadWorktreePath = null;
    }

    const baseBranchForWorktree =
      isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath
        ? nextThreadBranch
        : null;

    // In worktree mode, require an explicit base branch so we don't silently
    // fall back to local execution when branch selection is missing.
    const shouldCreateWorktree =
      isFirstMessage && nextThreadEnvMode === "worktree" && !nextThreadWorktreePath;
    if (shouldCreateWorktree && !nextThreadBranch) {
      setStoreThreadError(
        threadIdForSend,
        "Select a base branch before sending in New worktree mode.",
      );
      return false;
    }

    sendInFlightRef.current = true;
    beginLocalDispatch({ preparingWorktree: Boolean(baseBranchForWorktree) });

    const composerImagesSnapshot = [...composerImagesForSend];
    const composerAssistantSelectionsSnapshot = [...composerAssistantSelectionsForSend];
    const composerFileCommentsSnapshot = [...composerFileCommentsForSend];
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
    const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
    // File comments are serialized outermost (after assistant selections and
    // terminal contexts) so the trailing-block extractors unwrap them first.
    const messageTextForSend = appendFileCommentsToPrompt(
      appendTerminalContextsToPrompt(
        appendAssistantSelectionsToPrompt(promptForSend, composerAssistantSelectionsSnapshot),
        composerTerminalContextsSnapshot,
      ),
      composerFileCommentsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingComposerPrompt({
      provider: selectedProviderForSend,
      model: selectedModelForSend,
      effort: selectedPromptEffortForSend,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
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
    const turnAttachmentsPromise = buildUploadComposerAttachments({
      images: composerImagesSnapshot,
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
    ];
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
    // Mark the transcript as anchored before the optimistic row lands so the
    // re-snap effect on row count change pulls us to the new tail.
    armTranscriptAutoFollow(threadIdForSend);

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
    promptRef.current = "";
    clearComposerDraftContent(threadIdForSend);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);

    let createdServerThreadForLocalDraft = false;
    let turnStartSucceeded = false;
    await (async () => {
      // On first message: lock in branch + create worktree if needed.
      if (baseBranchForWorktree) {
        beginLocalDispatch({ preparingWorktree: true });
        const result = await createWorktreeMutation.mutateAsync({
          cwd: targetProjectCwdForSend,
          branch: baseBranchForWorktree,
          newBranch: buildTemporaryWorktreeBranchName(),
        });
        nextThreadBranch = result.worktree.branch;
        nextThreadWorktreePath = result.worktree.path;
        const nextAssociatedWorktree = deriveAssociatedWorktreeMetadata({
          branch: result.worktree.branch,
          worktreePath: result.worktree.path,
        });
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

      const threadCreateModelSelection: ModelSelection = buildModelSelection(
        selectedProviderForSend,
        selectedModelSelectionForSend.provider === selectedProviderForSend
          ? selectedModelSelectionForSend.model
          : selectedModelForSend ||
              targetProjectDefaultModelSelectionForSend?.model ||
              DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelectionForSend.options,
      );

      if (isLocalDraftThread) {
        const inheritedProjectInstructions =
          useProjectInstructionsStore.getState().instructionsByProjectId[targetProjectIdForSend] ??
          "";
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

      let setupScript: ProjectScript | null = null;
      if (baseBranchForWorktree) {
        setupScript = setupProjectScript(targetProjectScriptsForSend);
      }
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
          const setupScriptOptions: Parameters<typeof runProjectScript>[1] = {
            worktreePath: nextThreadWorktreePath,
            rememberAsLastInvoked: false,
          };
          if (nextThreadWorktreePath) {
            setupScriptOptions.cwd = nextThreadWorktreePath;
          }
          await runProjectScript(setupScript, setupScriptOptions);
        }
      }

      if (isServerThread) {
        await persistThreadSettingsForNextTurn({
          threadId: threadIdForSend,
          createdAt: messageCreatedAt,
          modelSelection: selectedModelSelectionForSend,
          runtimeMode: nextRuntimeModeForSend,
          interactionMode: interactionModeForSend,
        });
      }

      beginLocalDispatch();
      const turnAttachments = await turnAttachmentsPromise;
      rememberCustomBinaryPathForDispatch({
        threadId: threadIdForSend,
        provider: selectedModelSelectionForSend.provider,
        providerOptions: providerOptionsForDispatchForSend,
      });
      await api.orchestration.dispatchCommand({
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
        modelSelection: selectedModelSelectionForSend,
        ...(providerOptionsForDispatchForSend
          ? { providerOptions: providerOptionsForDispatchForSend }
          : {}),
        assistantDeliveryMode,
        dispatchMode,
        runtimeMode: nextRuntimeModeForSend,
        interactionMode: interactionModeForSend,
        createdAt: messageCreatedAt,
      });
      turnStartSucceeded = true;
    })().catch(async (err: unknown) => {
      if (createdServerThreadForLocalDraft && !turnStartSucceeded) {
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: threadIdForSend,
          })
          .catch(() => undefined);
      }
      if (
        queuedChatTurn === null &&
        !turnStartSucceeded &&
        promptRef.current.length === 0 &&
        composerImagesRef.current.length === 0 &&
        composerAssistantSelectionsRef.current.length === 0 &&
        composerFileCommentsRef.current.length === 0 &&
        composerTerminalContextsRef.current.length === 0
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
        setComposerCursor(collapseExpandedComposerCursor(promptForSend, promptForSend.length));
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageAttachment));
        for (const selection of composerAssistantSelectionsSnapshot) {
          addComposerAssistantSelectionToDraft(selection);
        }
        for (const comment of composerFileCommentsSnapshot) {
          addComposerFileCommentToDraft(comment);
        }
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        updateSelectedComposerSkills(composerSkillsSnapshot);
        updateSelectedComposerMentions(composerMentionsSnapshot);
        setComposerTrigger(detectComposerTrigger(promptForSend, promptForSend.length));
      }
      setThreadError(
        threadIdForSend,
        err instanceof Error ? err.message : "Failed to send message.",
      );
    });
    sendInFlightRef.current = false;
    if (!turnStartSucceeded) {
      resetLocalDispatch();
    }
    return turnStartSucceeded;
  };

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      // Durably persist "always allow" client-side so the next turn (after an
      // idle-stop or runtime restart) keeps full-access instead of asking again.
      // The server's session override only covers the current live turn.
      const durableRuntimeMode = resolveRuntimeModeAfterApprovalDecision(runtimeMode, decision);
      if (durableRuntimeMode) {
        setComposerDraftRuntimeMode(activeThreadId, durableRuntimeMode);
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit approval decision.",
          );
        });
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, runtimeMode, setComposerDraftRuntimeMode, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const dispatchAnswers = hasCompletePendingUserInputAnswers(answers)
        ? answers
        : omitNullPendingUserInputAnswers(answers);

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers: dispatchAnswers,
          createdAt: new Date().toISOString(),
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            err instanceof Error ? err.message : "Failed to submit user input.",
          );
        });
      setRespondingUserInputRequestIds((existing) => existing.filter((id) => id !== requestId));
    },
    [activeThreadId, setStoreThreadError],
  );

  const onCancelActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingIsResponding) {
      return;
    }
    promptRef.current = "";
    setPrompt("");
    setComposerCursor(0);
    setComposerTrigger(null);
    void onRespondToUserInput(activePendingUserInput.requestId, {});
  }, [activePendingIsResponding, activePendingUserInput, onRespondToUserInput, setPrompt]);

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInput) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextQuestionIndex,
      }));
    },
    [activePendingUserInput],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput) {
        return null;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return null;
      }
      const nextDraftAnswer = togglePendingUserInputOptionSelection(
        question,
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId]?.[
          questionId
        ],
        optionLabel,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInput.requestId]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextRequestAnswers,
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
      return nextDraftAnswer;
    },
    [activePendingUserInput],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInput) {
        return;
      }
      promptRef.current = value;
      const nextDraftAnswer = setPendingUserInputCustomAnswer(
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId]?.[
          questionId
        ],
        value,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInput.requestId]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: nextRequestAnswers,
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(
    (answerOverrides?: Record<string, PendingUserInputDraftAnswer>): boolean => {
      if (!activePendingUserInput || !activePendingProgress) {
        return false;
      }
      const pendingDraftAnswers =
        answerOverrides && Object.keys(answerOverrides).length > 0
          ? {
              ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId],
              ...answerOverrides,
            }
          : (pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId] ??
            activePendingDraftAnswers);
      if (answerOverrides && Object.keys(answerOverrides).length > 0) {
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInput.requestId]: pendingDraftAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: pendingDraftAnswers,
        }));
      }
      const resolvedAnswers = buildPendingUserInputAnswers(
        activePendingUserInput.questions,
        pendingDraftAnswers,
      );
      if (activePendingProgress.isLastQuestion) {
        if (resolvedAnswers) {
          void onRespondToUserInput(activePendingUserInput.requestId, resolvedAnswers);
          return true;
        }
        return false;
      }
      const activeQuestionId = activePendingProgress.activeQuestion?.id ?? null;
      const hasActiveOverride = activeQuestionId
        ? answerOverrides?.[activeQuestionId] !== undefined
        : false;
      if (!activePendingProgress.canAdvance && !hasActiveOverride) {
        return false;
      }
      setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
      return true;
    },
    [
      activePendingDraftAnswers,
      activePendingProgress,
      activePendingUserInput,
      onRespondToUserInput,
      setActivePendingUserInputQuestionIndex,
    ],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);

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
    beginLocalDispatch();
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
    armTranscriptAutoFollow(threadIdForSend);

    try {
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
      // Optimistically open the plan sidebar when implementing (not refining).
      // "default" mode here means the agent is executing the plan, which produces
      // step-tracking activities that the sidebar will display.
      if (nextInteractionMode === "default") {
        planSidebarDismissedForTurnRef.current = null;
        setPlanSidebarOpen(true);
      }
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
      const editedTextWithOriginalContext = appendOriginalTerminalContextBlock({
        editedPrompt: text,
        originalPrompt: originalMessage.text,
      });
      const outgoingMessageText = formatOutgoingComposerPrompt({
        provider: selectedProvider,
        model: selectedModel,
        effort: selectedPromptEffort,
        text: editedTextWithOriginalContext,
      });
      try {
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
      } catch (err) {
        setThreadError(
          activeThread.id,
          err instanceof Error ? err.message : "Failed to edit message.",
        );
        return false;
      } finally {
        setIsRevertingCheckpoint(false);
      }
    },
    [
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

  const onSendRef = useRef(onSend);
  const onSubmitPlanFollowUpRef = useRef(onSubmitPlanFollowUp);
  onSendRef.current = onSend;
  onSubmitPlanFollowUpRef.current = onSubmitPlanFollowUp;

  const dispatchQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn, dispatchMode: "queue" | "steer"): Promise<boolean> => {
      if (queuedTurn.kind === "chat") {
        return onSendRef.current(undefined, dispatchMode, queuedTurn);
      }
      return onSubmitPlanFollowUpRef.current({
        text: queuedTurn.text,
        interactionMode: queuedTurn.interactionMode,
        dispatchMode,
        queuedTurn,
      });
    },
    [],
  );

  const onSteerQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn) => {
      const previousQueue = queuedComposerTurnsRef.current;
      const queuedIndex = previousQueue.findIndex((entry) => entry.id === queuedTurn.id);
      if (queuedIndex < 0) {
        return;
      }
      removeQueuedComposerTurnFromDraft(threadId, queuedTurn.id);
      const succeeded = await dispatchQueuedComposerTurn(queuedTurn, "steer");
      if (succeeded) {
        return;
      }
      insertQueuedComposerTurn(threadId, queuedTurn, queuedIndex);
    },
    [
      dispatchQueuedComposerTurn,
      insertQueuedComposerTurn,
      removeQueuedComposerTurnFromDraft,
      threadId,
    ],
  );

  const onEditQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      removeQueuedComposerTurn(queuedTurn.id);
      restoreQueuedTurnToComposer(queuedTurn);
    },
    [removeQueuedComposerTurn, restoreQueuedTurnToComposer],
  );

  useEffect(() => {
    if (autoDispatchingQueuedTurnRef.current) {
      return;
    }
    if (
      hasLiveTurn ||
      phase === "disconnected" ||
      isSendBusy ||
      isConnecting ||
      sendInFlightRef.current ||
      activePendingApproval !== null ||
      activePendingProgress !== null ||
      pendingUserInputs.length > 0 ||
      queuedComposerTurns.length === 0
    ) {
      return;
    }
    const nextQueuedTurn = queuedComposerTurns[0];
    if (!nextQueuedTurn) {
      return;
    }
    autoDispatchingQueuedTurnRef.current = true;
    void (async () => {
      const succeeded = await dispatchQueuedComposerTurn(nextQueuedTurn, "queue");
      if (succeeded) {
        removeQueuedComposerTurnFromDraft(threadId, nextQueuedTurn.id);
      }
      autoDispatchingQueuedTurnRef.current = false;
    })();
  }, [
    activePendingApproval,
    activePendingProgress,
    dispatchQueuedComposerTurn,
    phase,
    isConnecting,
    isSendBusy,
    pendingUserInputs.length,
    hasLiveTurn,
    queuedComposerTurns,
    removeQueuedComposerTurnFromDraft,
    threadId,
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
      .then(() => api.orchestration.getShellSnapshot())
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
        await api.orchestration
          .dispatchCommand({
            type: "thread.delete",
            commandId: newCommandId(),
            threadId: nextThreadId,
          })
          .catch(() => undefined);
        await api.orchestration
          .getShellSnapshot()
          .then((snapshot) => {
            syncServerShellSnapshot(snapshot);
          })
          .catch(() => undefined);
        toastManager.add({
          type: "error",
          title: "Could not start implementation thread",
          description:
            err instanceof Error ? err.message : "An error occurred while creating the new thread.",
        });
      })
      .then(finish, finish);
  }, [
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

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
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
      const nextModelSelection: ModelSelection = {
        provider,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(activeThread.id, nextModelSelection);
      if (provider === "cursor" && !showExpandedCursorModelVariants) {
        setComposerDraftProviderModelOptions(activeThread.id, provider, undefined, {
          persistSticky: true,
          model: resolvedModel,
        });
      }
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setComposerDraftProviderModelOptions,
      setStickyComposerModelSelection,
      showExpandedCursorModelVariants,
      customModelsByProvider,
      modelOptionsByProvider,
    ],
  );
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
    [scheduleComposerFocus, setPrompt],
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
      activeContextWindow ??
      (selectedProvider === "claudeAgent"
        ? deriveSelectedContextWindowSnapshot(composerTraitSelection.contextWindow)
        : null),
    [activeContextWindow, composerTraitSelection.contextWindow, selectedProvider],
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
  }, [composerFooterPlanInputsKey]);
  // After a tier renders, re-measure before paint: a still-overflowing footer
  // demotes another step until it fits (bounded by COMPOSER_FOOTER_MAX_TIER).
  useLayoutEffect(() => {
    composerFooterLayoutSyncRef.current?.();
  }, [composerFooterTier]);
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
    [handleModelPickerOpenChange],
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
        loadingModelProviders={{
          cursor: cursorModelDiscoveryPending,
          kilo: kiloModelDiscoveryPending,
          pi: piModelDiscoveryPending,
        }}
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
      provider={selectedProvider}
      model={selectedModelForPickerWithCustomFallback}
      lockedProvider={lockedProvider}
      providers={providerStatuses}
      modelOptionsByProvider={modelOptionsByProvider}
      loadingModelProviders={{
        cursor: cursorModelDiscoveryPending,
        kilo: kiloModelDiscoveryPending,
        pi: piModelDiscoveryPending,
      }}
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
  const onEnvModeChange = useCallback(
    (mode: DraftThreadEnvMode) => {
      const nextBranch =
        mode === "worktree"
          ? (activeThread?.branch ?? draftThread?.branch ?? activeRootBranch ?? null)
          : (activeThread?.branch ?? draftThread?.branch ?? null);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: mode,
          ...(mode === "local" ? { worktreePath: null } : {}),
          ...(nextBranch ? { branch: nextBranch } : {}),
        });
      }
      if (isServerThread && activeThread && !hasNativeUserMessages && !activeThread.session) {
        const api = readNativeApi();
        if (api) {
          void api.orchestration.dispatchCommand({
            type: "thread.meta.update",
            commandId: newCommandId(),
            threadId,
            envMode: mode,
            ...(nextBranch ? { branch: nextBranch } : {}),
            ...(mode === "local" ? { worktreePath: null } : {}),
          });
        }
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      activeRootBranch,
      draftThread?.branch,
      hasNativeUserMessages,
      isLocalDraftThread,
      isServerThread,
      scheduleComposerFocus,
      setDraftThreadContext,
      threadId,
    ],
  );

  const handleResetWorkspaceToHome = useCallback(() => {
    if (isLocalDraftThread) {
      setDraftThreadContext(threadId, {
        envMode: "local",
        worktreePath: null,
      });
      scheduleComposerFocus();
      return;
    }

    if (activeThread) {
      setStoreThreadWorkspace(activeThread.id, {
        envMode: "local",
        worktreePath: null,
      });
      const api = readNativeApi();
      if (api && !hasNativeUserMessages && !activeThread.session) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThread.id,
          envMode: "local",
          worktreePath: null,
        });
      }
    }
    scheduleComposerFocus();
  }, [
    activeThread,
    hasNativeUserMessages,
    isLocalDraftThread,
    scheduleComposerFocus,
    setDraftThreadContext,
    setStoreThreadWorkspace,
    threadId,
  ]);

  const handleSelectWorkspaceRoot = useCallback(
    (workspaceRoot: string) => {
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
        scheduleComposerFocus();
        return;
      }

      if (activeThread) {
        setStoreThreadWorkspace(activeThread.id, {
          envMode: "worktree",
          worktreePath: workspaceRoot,
        });
      }
      scheduleComposerFocus();
    },
    [
      activeThread,
      isLocalDraftThread,
      scheduleComposerFocus,
      setDraftThreadContext,
      setStoreThreadWorkspace,
      threadId,
    ],
  );

  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; cursorOffset?: number },
    ): number | false => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      let nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      // Apply cursor offset if specified (e.g., -1 to position inside parentheses)
      if (options?.cursorOffset !== undefined) {
        nextCursor = Math.max(0, nextCursor + options.cursorOffset);
      }
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        const nextDraftAnswer = setPendingUserInputCustomAnswer(
          pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId]?.[
            activePendingQuestion.id
          ],
          next.text,
        );
        const nextRequestAnswers = {
          ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInput.requestId],
          [activePendingQuestion.id]: nextDraftAnswer,
        };
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInput.requestId]: nextRequestAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: nextRequestAnswers,
        }));
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        detectComposerTrigger(next.text, expandCollapsedComposerCursor(next.text, nextCursor)),
      );
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
      return nextCursor;
    },
    [activePendingProgress?.activeQuestion, activePendingUserInput, setPrompt],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  // Shared insertion path for picker selections (mentions, plugins, skills,
  // agents, provider-native commands, local folders). Guarantees the replacement
  // is flanked by a leading space when landing next to a non-whitespace char and
  // absorbs an existing trailing space so we don't end up with double spaces.
  const applyComposerTriggerReplacement = useCallback(
    (params: {
      snapshot: { value: string };
      trigger: ComposerTrigger;
      base: string;
      cursorOffset?: number;
      onApplied?: () => void;
    }): number | false => {
      const { snapshot, trigger, base, cursorOffset, onApplied } = params;
      const replacement = ensureLeadingSpaceForReplacement(
        snapshot.value,
        trigger.rangeStart,
        base,
      );
      const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
        snapshot.value,
        trigger.rangeEnd,
        replacement,
      );
      const options: { expectedText: string; cursorOffset?: number } = {
        expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
      };
      if (cursorOffset !== undefined) {
        options.cursorOffset = cursorOffset;
      }
      const applied = applyPromptReplacement(
        trigger.rangeStart,
        replacementRangeEnd,
        replacement,
        options,
      );
      if (applied !== false) {
        onApplied?.();
        setComposerHighlightedItemId(null);
      }
      return applied;
    },
    [applyPromptReplacement],
  );

  // Replaces the active `@...` token with a completed absolute folder mention.
  const handleSelectLocalDirectoryMention = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      applyComposerTriggerReplacement({
        snapshot,
        trigger,
        base: `${formatComposerMentionToken(absolutePath)} `,
      });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  // Rewrites the active `@...` mention to an absolute folder path with a trailing separator
  // so the local-folder picker stays open and the user can keep browsing by clicking or typing.
  // Paths with whitespace are written as an unclosed `@"...` so detectComposerTrigger keeps
  // matching and the picker stays open while the user descends into folders with spaces.
  const handleNavigateLocalFolder = useCallback(
    (absolutePath: string) => {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      const separator = absolutePath.includes("\\") ? "\\" : "/";
      const withTrailingSeparator = absolutePath.endsWith(separator)
        ? absolutePath
        : `${absolutePath}${separator}`;
      const base = /\s/.test(withTrailingSeparator)
        ? `@"${withTrailingSeparator}`
        : `@${withTrailingSeparator}`;
      applyComposerTriggerReplacement({ snapshot, trigger, base });
    },
    [applyComposerTriggerReplacement, resolveActiveComposerTrigger],
  );

  const setComposerPromptValue = useCallback(
    (nextPrompt: string) => {
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      setComposerHighlightedItemId(null);
      window.requestAnimationFrame(() => {
        composerEditorRef.current?.focusAt(nextCursor);
      });
    },
    [setPrompt],
  );

  const clearComposerSlashDraft = useCallback(() => {
    promptRef.current = "";
    clearComposerDraftContent(threadId);
    setComposerHighlightedItemId(null);
    setComposerCursor(0);
    setComposerTrigger(null);
    scheduleComposerFocus();
  }, [clearComposerDraftContent, scheduleComposerFocus, threadId]);

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
      applyPromptReplacement,
      clearComposerSlashDraft,
      resolveActiveComposerTrigger,
      scheduleComposerFocus,
      setComposerPromptValue,
    ],
  );

  const {
    handleForkTargetSelection,
    handleReviewTargetSelection,
    isSlashStatusDialogOpen,
    setIsSlashStatusDialogOpen,
    handleStandaloneSlashCommand,
    handleSlashCommandSelection,
  } = useComposerSlashCommands({
    activeProject,
    activeThread,
    activeRootBranch,
    isServerThread,
    supportsFastSlashCommand,
    canOfferCompactCommand:
      supportsThreadCompaction(providerComposerCapabilitiesQuery.data) &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferSideCommand,
    supportsTextNativeReviewCommand,
    fastModeEnabled,
    providerNativeCommands,
    providerCommandDiscoveryCwd: composerSkillCwd,
    selectedProvider,
    currentProviderModelOptions,
    selectedModelSelection,
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

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      if (item.type === "fork-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleForkTargetSelection(item.target);
        return;
      }
      if (item.type === "review-target") {
        setComposerCommandPicker(null);
        setComposerHighlightedItemId(null);
        void handleReviewTargetSelection(item.target);
        return;
      }
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.path)} `,
        });
        return;
      }
      if (item.type === "local-root") {
        handleNavigateLocalFolder(localFolderBrowseRootPath ?? "/");
        return;
      }
      if (item.type === "slash-command") {
        handleSlashCommandSelection(item);
        return;
      }
      if (item.type === "provider-native-command") {
        if (selectedProvider === "codex" && item.command.toLowerCase() === "review") {
          setComposerCommandPicker("review-target");
          setComposerHighlightedItemId("review-target:changes");
          scheduleComposerFocus();
          return;
        }
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `/${item.command} `,
        });
        return;
      }
      if (item.type === "skill") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${skillMentionPrefix(selectedProvider)}${item.skill.name} `,
          onApplied: () => {
            updateSelectedComposerSkills((existing) => {
              const nextSkill = {
                name: item.skill.name,
                path: item.skill.path,
              } satisfies ProviderSkillReference;
              return existing.some(
                (skill) => skill.name === nextSkill.name && skill.path === nextSkill.path,
              )
                ? existing
                : [...existing, nextSkill];
            });
          },
        });
        return;
      }
      if (item.type === "plugin") {
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `${formatComposerMentionToken(item.mention.name)} `,
          onApplied: () => {
            updateSelectedComposerMentions((existing) => {
              const nextMention = item.mention;
              const nextWithoutSameName = existing.filter(
                (mention) => mention.name !== nextMention.name,
              );
              return [...nextWithoutSameName, nextMention];
            });
          },
        });
        return;
      }
      if (item.type === "model") {
        onProviderModelSelect(item.provider, item.model);
        applyComposerTriggerReplacement({ snapshot, trigger, base: "" });
        return;
      }
      if (item.type === "agent") {
        // Insert @alias() and position cursor inside the parentheses.
        applyComposerTriggerReplacement({
          snapshot,
          trigger,
          base: `@${item.alias}()`,
          cursorOffset: -1,
        });
      }
    },
    [
      applyComposerTriggerReplacement,
      scheduleComposerFocus,
      handleForkTargetSelection,
      handleNavigateLocalFolder,
      handleReviewTargetSelection,
      handleSlashCommandSelection,
      onProviderModelSelect,
      setComposerCommandPicker,
      localFolderBrowseRootPath,
      selectedProvider,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
      resolveActiveComposerTrigger,
    ],
  );
  const onComposerMenuItemHighlighted = useCallback((itemId: string | null) => {
    setComposerHighlightedItemId(itemId);
  }, []);
  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) {
        return;
      }
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );
  const isComposerMenuLoading =
    (composerTriggerKind === "mention" &&
      ((mentionTriggerQuery.length > 0 && composerPathQueryDebouncer.state.isPending) ||
        workspaceEntriesQuery.isLoading ||
        workspaceEntriesQuery.isFetching ||
        providerPluginsQuery.isLoading ||
        providerPluginsQuery.isFetching)) ||
    (composerTriggerKind === "slash-command" &&
      (providerCommandsQuery.isLoading ||
        providerCommandsQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching)) ||
    (composerTriggerKind === "skill" &&
      (providerComposerCapabilitiesQuery.isLoading ||
        providerComposerCapabilitiesQuery.isFetching ||
        providerSkillsQuery.isLoading ||
        providerSkillsQuery.isFetching));

  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (composerCommandPicker !== null && nextPrompt.trim().length > 0) {
        setComposerCommandPicker(null);
      }
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          threadId,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      composerTerminalContexts,
      composerCommandPicker,
      onChangeActivePendingUserInputCustomAnswer,
      setPrompt,
      setComposerDraftTerminalContexts,
      setComposerCommandPicker,
      threadId,
    ],
  );

  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => {
    if (key === "Slash" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      const slashTriggerText =
        trigger && (trigger.kind === "slash-command" || trigger.kind === "slash-model")
          ? snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd)
          : null;

      if (slashTriggerText === "/" && snapshot.expandedCursor === trigger?.rangeEnd) {
        // Pressing `/` again on a lone `/` dismisses the picker. Only wipe the
        // draft when the slash IS the whole prompt; a mid-line slash (e.g. after
        // an existing chip) must keep surrounding content, so let it type through.
        if (trigger.rangeStart === 0 && trigger.rangeEnd === snapshot.value.length) {
          clearComposerSlashDraft();
          return true;
        }
        return false;
      }
      return false;
    }

    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }

    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;

    if (menuIsActive && isLocalFolderBrowserOpen) {
      if (key === "ArrowDown") {
        localDirectoryMenuRef.current?.moveHighlight("down");
        return true;
      }
      if (key === "ArrowUp") {
        localDirectoryMenuRef.current?.moveHighlight("up");
        return true;
      }
      if (key === "Enter" || key === "Tab") {
        localDirectoryMenuRef.current?.activateHighlighted();
        return true;
      }
    }

    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if (key === "Tab" || key === "Enter") {
        const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
        if (selectedItem) {
          onSelectComposerItem(selectedItem);
          return true;
        }
      }
    }

    if (key === "Enter" && !event.shiftKey) {
      void onSend(undefined, event.metaKey || event.ctrlKey ? "steer" : "queue");
      return true;
    }
    return false;
  };
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onScrollToBottom = useCallback(() => {
    isAtEndRef.current = true;
    showScrollDebouncer.current.cancel();
    setShowScrollToBottom(false);
    scrollToEnd(true);
  }, [scrollToEnd]);
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
      onOpenDiff();
      return;
    }
    onOpenTurnDiff(activeTurnLiveDiffState.turnId);
  }, [activeTurnLiveDiffState.turnId, onOpenDiff, onOpenTurnDiff]);
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
    setTerminalFocusRequestId((value) => value + 1);
  }, [
    activeThreadId,
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
  }, [activeRateLimitBannerDismissalKey]);

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
        ? {
            projectId: activeThread.projectId,
            modelSelection: activeThread.modelSelection,
            runtimeMode: activeThread.runtimeMode,
            interactionMode: activeThread.interactionMode,
            envMode: activeThread.envMode ?? "local",
            branch: activeThread.branch,
            worktreePath: activeThread.worktreePath,
            ...(activeThread.lastKnownPr !== undefined
              ? { lastKnownPr: activeThread.lastKnownPr }
              : {}),
            createdAt: activeThread.createdAt,
          }
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
      <ComposerExtrasMenu
        interactionMode={interactionMode}
        supportsFastMode={composerTraitSelection.caps.supportsFastMode}
        fastModeEnabled={composerTraitSelection.fastModeEnabled}
        onAddPhotos={addComposerImages}
        onToggleFastMode={toggleFastMode}
        onSetPlanMode={setPlanMode}
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
    onHandoffToWorktree,
    onHandoffToLocal,
    handoffBusy,
    onComposerFocusRequest: scheduleComposerFocus,
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
  };
  const showEmptyLandingBranchToolbar =
    isCenteredEmptyLanding && Boolean(activeProject) && !isHomeChatContainer && isGitRepo;
  const emptyLandingProjectChip =
    !isEmptyChatLanding && activeProjectDisplayName ? (
      <span className="inline-flex min-w-0 max-w-56 shrink items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] sm:max-w-64">
        <FolderClosed className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{activeProjectDisplayName}</span>
      </span>
    ) : null;
  const emptyLandingControls =
    isCenteredEmptyLanding &&
    (isEmptyChatLanding || emptyLandingProjectChip || showEmptyLandingBranchToolbar) ? (
      <div
        className={cn(
          "chat-composer-shell relative mt-0 flex flex-wrap items-center gap-x-2 gap-y-1 !rounded-t-none !rounded-b-[var(--composer-radius)] bg-[color-mix(in_srgb,var(--color-background-elevated-secondary)_76%,var(--color-background-surface)_24%)] px-2 pb-1.5 pt-2 shadow-[0_18px_36px_-26px_rgba(0,0,0,0.78)] before:pointer-events-none before:absolute before:inset-x-0 before:-top-3 before:h-3 before:bg-inherit before:content-['']",
          COMPOSER_COLUMN_FRAME_CLASS_NAME,
        )}
      >
        {isEmptyChatLanding ? (
          <ProjectPicker
            align="start"
            side="top"
            showResetToHome={Boolean(resolvedThreadWorktreePath)}
            selectedWorkspaceRoot={resolvedThreadWorktreePath}
            onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
            onResetToHome={handleResetWorkspaceToHome}
          />
        ) : (
          emptyLandingProjectChip
        )}
        {showEmptyLandingBranchToolbar ? (
          <BranchToolbar
            {...branchToolbarProps}
            className="mx-0 !w-auto min-w-0 shrink-0 !justify-start !px-0 !pb-0 !pt-0"
          />
        ) : null}
      </div>
    ) : null;

  // Shared inputs for both Environment panel surfaces (the header Popover when the dock is
  // open, and the docked right column when it is closed) so the two never drift.
  const environmentPanelProps: Omit<EnvironmentPanelProps, "open" | "variant"> = {
    gitCwd: threadWorkspaceCwd,
    openInTarget: threadWorkspaceCwd,
    githubRepository: githubRepositoryQuery.data?.repository ?? null,
    isGitRepo,
    keybindings,
    availableEditors,
    activeThreadId: activeThread.id,
    activeProvider: activeThread.session?.provider ?? activeThread.modelSelection.provider,
    showGitActions,
    diffOpen: resolvedDiffOpen,
    diffDisabledReason,
    diffTotals: repoDiffTotals,
    branchToolbar: branchToolbarProps,
    recap: threadRecap,
    pinnedMessages,
    threadMarkers,
    pinnedMessageTextById,
    markerMessageTextById,
    notes: threadNotes,
    activeProjectId,
    projectInstructions,
    canCopyProjectInstructionsToNotes: !isLocalDraftThread,
    onProjectInstructionsChange: setProjectInstructions,
    onCopyProjectInstructionsToNotes: handleCopyProjectInstructionsToNotes,
    onToggleDiff,
    onOpenGithubRepository: openBrowserUrl,
    onJumpToPinnedMessage: handleJumpToPinnedMessage,
    onTogglePinnedMessageDone: handleTogglePinnedMessageDone,
    onUnpinMessage: handleUnpinMessage,
    onRenamePinnedMessage: handleRenamePinnedMessage,
    onJumpToThreadMarker: handleJumpToThreadMarker,
    onToggleThreadMarkerDone: handleToggleThreadMarkerDone,
    onRemoveThreadMarker: handleRemoveThreadMarker,
    onRenameThreadMarker: handleRenameThreadMarker,
    onNotesChange: handleNotesChange,
    onOpenEditorView: viewModeAction?.onClick ?? null,
    onClose: () => setEnvironmentPanelOpen(false),
  };
  // Full-width single chat: overlay plus transcript/composer inset. Floating overlay when the
  // column is already narrow — right dock open or a split pane (same as header compact mode).
  // Terminal surfaces always float so opening Environment never resizes the terminal workspace.
  const environmentUsesFloatingOverlay =
    isTerminalEnvironmentContext || isMobileViewport || rightDockOpen || surfaceMode === "split";
  const environmentAppliesContentInset = environmentPanelVisible && !environmentUsesFloatingOverlay;
  const environmentOverlayVariant = environmentUsesFloatingOverlay ? "floating" : "docked";
  const environmentHeaderState = environmentEnabled
    ? {
        open: environmentPanelVisible,
        onOpenChange: setEnvironmentPanelOpen,
      }
    : null;

  const showComposerLiveChangesHeader = latestTurnLive && activeTurnLiveDiffState.fileCount > 0;
  const showComposerActiveTaskListCard = Boolean(activeTaskList && !planSidebarOpen);

  // Composer layout keeps the task list and footer actions in one render path so
  // follow-up prompts and normal chat mode stay visually in sync.
  const renderActiveTaskListCard = (attachedToPrevious: boolean) =>
    activeTaskList && showComposerActiveTaskListCard ? (
      <ComposerActiveTaskListCard
        activeTaskList={activeTaskList}
        cardRef={activeTaskListCardRef}
        backgroundTaskCount={activeBackgroundTasks?.activeCount ?? 0}
        compact={activeTaskListCompact}
        onCompactChange={setActiveTaskListCompact}
        onOpenSidebar={() => setPlanSidebarOpen(true)}
        attachedToPrevious={attachedToPrevious}
      />
    ) : null;

  const composerSection =
    secondaryChromeReady && shouldRenderChatPaneContent ? (
      <>
        <form
          ref={composerFormRef}
          onSubmit={onSend}
          className="relative z-10 w-full overflow-visible"
          data-chat-composer-form="true"
          data-chat-pane-scope={paneScopeId}
        >
          <ComposerColumnFrame>
            {showComposerLiveChangesHeader ? (
              <ComposerLiveChangesHeader
                fileCount={activeTurnLiveDiffState.fileCount}
                additions={activeTurnLiveDiffState.additions}
                deletions={activeTurnLiveDiffState.deletions}
                onReview={onReviewComposerLiveChanges}
              />
            ) : null}
            {renderActiveTaskListCard(showComposerLiveChangesHeader)}
            <ComposerQueuedHeader
              queuedTurns={queuedComposerTurns}
              onSteer={onSteerQueuedComposerTurn}
              onRemove={removeQueuedComposerTurn}
              onEdit={onEditQueuedComposerTurn}
              attachedToPrevious={showComposerLiveChangesHeader || showComposerActiveTaskListCard}
            />
            <div
              className={cn(
                COMPOSER_INPUT_SHELL_CLASS_NAME,
                composerProviderState.composerFrameClassName,
                composerMenuOpen && !isComposerApprovalState && "overflow-visible",
              )}
              onDragEnter={onComposerDragEnter}
              onDragOver={onComposerDragOver}
              onDragLeave={onComposerDragLeave}
              onDrop={onComposerDrop}
            >
              <div
                className={cn(
                  COMPOSER_INPUT_SURFACE_CLASS_NAME,
                  isDragOverComposer ? "!bg-[var(--color-background-control)]" : "",
                  composerProviderState.composerSurfaceClassName,
                  composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                )}
              >
                <ComposerInputBanners
                  roundedTopReset={false}
                  activeApproval={activePendingApproval}
                  pendingApprovalCount={pendingApprovals.length}
                  pendingUserInputs={pendingUserInputs}
                  respondingUserInputRequestIds={respondingUserInputRequestIds}
                  pendingUserInputAnswers={activePendingDraftAnswers}
                  pendingUserInputQuestionIndex={activePendingQuestionIndex}
                  onToggleUserInputOption={onToggleActivePendingUserInputOption}
                  onAdvanceUserInput={onAdvanceActivePendingUserInput}
                  onCancelUserInput={onCancelActivePendingUserInput}
                  planFollowUp={
                    showPlanFollowUpPrompt && activeProposedPlan
                      ? {
                          id: activeProposedPlan.id,
                          title: proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null,
                        }
                      : null
                  }
                />
                <div
                  className={cn(
                    COMPOSER_EDITOR_PADDING_CLASS_NAME,
                    composerMenuOpen && !isComposerApprovalState && "overflow-visible",
                  )}
                >
                  {composerMenuOpen && !isComposerApprovalState ? (
                    <div className={COMPOSER_COMMAND_MENU_FLOATING_WRAPPER_CLASS_NAME}>
                      {isLocalFolderBrowserOpen ? (
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
                    (composerAssistantSelections.length > 0 ||
                      composerFileComments.length > 0 ||
                      composerImages.length > 0) && (
                      <ComposerReferenceAttachments
                        assistantSelections={composerAssistantSelections}
                        fileComments={composerFileComments}
                        images={composerImages}
                        nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                        onExpandImage={setExpandedImage}
                        onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
                        onRemoveFileComments={clearComposerFileCommentsFromDraft}
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
                    placeholder={
                      isComposerApprovalState
                        ? "Resolve this approval request to continue"
                        : activePendingProgress
                          ? activePendingProgress.activeQuestion?.options.length === 0
                            ? "Type your answer to continue"
                            : "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : hasLiveTurn
                              ? "Ask for follow-up changes"
                              : phase === "disconnected"
                                ? "Ask for follow-up changes or attach images"
                                : "Ask anything, @tag files/folders, or use / to show available commands"
                    }
                    disabled={isConnecting || isComposerApprovalState}
                  />
                </div>
                {/* Bottom toolbar */}
                {activePendingApproval ? (
                  <div className={COMPOSER_FOOTER_APPROVAL_ROW_CLASS_NAME}>
                    <ComposerPendingApprovalActions
                      requestId={activePendingApproval.requestId}
                      isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                      onRespondToApproval={onRespondToApproval}
                    />
                  </div>
                ) : (
                  <div
                    data-chat-composer-footer="true"
                    className={cn(
                      "@container",
                      COMPOSER_FOOTER_ROW_CLASS_NAME,
                      isComposerFooterCompact
                        ? "gap-1.5"
                        : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                    )}
                  >
                    <div
                      data-chat-composer-leading="true"
                      className={cn(
                        "flex items-center",
                        isVoiceRecording || isVoiceTranscribing
                          ? "min-w-0 shrink-0 gap-1"
                          : isComposerFooterCompact
                            ? "min-w-0 flex-1 gap-1 overflow-hidden"
                            : "min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                      )}
                    >
                      {relocateComposerLeadingControls
                        ? null
                        : renderComposerLeadingControls({ iconOnly: false })}

                      {!isVoiceRecording && !isVoiceTranscribing ? (
                        <>
                          {interactionMode === "plan" ? (
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-[var(--color-text-foreground-secondary)] hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] sm:px-3"
                              size="sm"
                              type="button"
                              onClick={toggleInteractionMode}
                              title="Plan mode — click to return to normal build mode"
                            >
                              <GoTasklist className="size-3.5" />
                              <span className="sr-only sm:not-sr-only">Plan</span>
                            </Button>
                          ) : null}

                          {activeTaskList || sidebarProposedPlan || planSidebarOpen ? (
                            <Button
                              variant="ghost"
                              className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                              size="sm"
                              type="button"
                              onClick={togglePlanSidebar}
                              title={planSidebarToggleTitle}
                              aria-label={planSidebarToggleTitle}
                            >
                              <LayoutSidebarIcon className="size-3.5" />
                              <span className="sr-only sm:not-sr-only">
                                {planSidebarToggleLabel}
                              </span>
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    <div
                      data-chat-composer-actions="right"
                      className={cn(
                        "flex items-center gap-2",
                        isVoiceRecording || isVoiceTranscribing ? "min-w-0 flex-1" : "shrink-0",
                      )}
                    >
                      {isPreparingWorktree ? (
                        <span className="text-[length:var(--app-font-size-ui-xs,10px)] text-[var(--color-text-foreground-secondary)]">
                          Preparing worktree...
                        </span>
                      ) : null}
                      {!isVoiceRecording &&
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
                      ) : null}
                      {!isVoiceRecording && !isVoiceTranscribing ? composerPickerControls : null}
                      {showVoiceNotesControl && (isVoiceRecording || isVoiceTranscribing) ? (
                        <ComposerVoiceRecorderBar
                          disabled={isComposerApprovalState || isConnecting || isSendBusy}
                          isRecording={isVoiceRecording}
                          isTranscribing={isVoiceTranscribing}
                          durationLabel={voiceRecordingDurationLabel}
                          waveformLevels={voiceWaveformLevels}
                          onCancel={() => {
                            if (isVoiceRecording) {
                              void submitComposerVoiceRecording();
                              return;
                            }
                            cancelComposerVoiceRecording();
                          }}
                          onSubmit={() => {
                            void submitComposerVoiceRecording();
                          }}
                        />
                      ) : null}
                      {activePendingProgress ? (
                        <div className="flex items-center gap-2">
                          {activePendingProgress.questionIndex > 0 ? (
                            <Button
                              size="sm"
                              variant="outline"
                              className="rounded-full"
                              onClick={onPreviousActivePendingUserInputQuestion}
                              disabled={activePendingIsResponding}
                            >
                              Previous
                            </Button>
                          ) : null}
                          <Button
                            type="submit"
                            size="sm"
                            className="rounded-full px-4"
                            disabled={
                              activePendingIsResponding ||
                              (activePendingProgress.isLastQuestion
                                ? !activePendingResolvedAnswers
                                : !activePendingProgress.canAdvance)
                            }
                          >
                            {activePendingIsResponding
                              ? "Submitting..."
                              : activePendingProgress.isLastQuestion
                                ? "Submit answers"
                                : "Next question"}
                          </Button>
                        </div>
                      ) : phase === "running" ? (
                        <Button
                          type="button"
                          variant="prominent"
                          size="icon-xs"
                          className="sm:size-[26px]"
                          onClick={() => void onInterrupt()}
                          aria-label="Stop generation"
                          title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                        >
                          <span
                            aria-hidden="true"
                            className="block size-2 rounded-[2px] bg-current"
                          />
                        </Button>
                      ) : pendingUserInputs.length === 0 &&
                        !isVoiceRecording &&
                        !isVoiceTranscribing ? (
                        showPlanFollowUpPrompt ? (
                          prompt.trim().length > 0 ? (
                            <Button
                              type="submit"
                              size="sm"
                              className="h-9 rounded-full px-4 sm:h-8"
                              disabled={isSendBusy || isConnecting}
                            >
                              {isConnecting || isSendBusy ? "Sending..." : "Refine"}
                            </Button>
                          ) : (
                            <div className="flex items-center">
                              <Button
                                type="submit"
                                size="sm"
                                className="h-9 rounded-l-full rounded-r-none px-4 sm:h-8"
                                disabled={isSendBusy || isConnecting}
                              >
                                {isConnecting || isSendBusy ? "Sending..." : "Implement"}
                              </Button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <Button
                                      size="sm"
                                      variant="default"
                                      className="h-9 rounded-l-none rounded-r-full border-l-white/12 px-2 sm:h-8"
                                      aria-label="Implementation actions"
                                      disabled={isSendBusy || isConnecting}
                                    />
                                  }
                                >
                                  <ChevronDownIcon className="size-3.5" />
                                </MenuTrigger>
                                <MenuPopup align="end" side="top">
                                  <MenuItem
                                    disabled={isSendBusy || isConnecting}
                                    onClick={() => void onImplementPlanInNewThread()}
                                  >
                                    Implement in a new thread
                                  </MenuItem>
                                </MenuPopup>
                              </Menu>
                            </div>
                          )
                        ) : (
                          <>
                            {showVoiceNotesControl ? (
                              <ComposerVoiceButton
                                disabled={isComposerApprovalState || isConnecting || isSendBusy}
                                isRecording={isVoiceRecording}
                                isTranscribing={isVoiceTranscribing}
                                durationLabel={voiceRecordingDurationLabel}
                                onClick={toggleComposerVoiceRecording}
                              />
                            ) : null}
                            <Button
                              type="submit"
                              variant="prominent"
                              size="icon-xs"
                              className="size-7 rounded-full sm:size-7"
                              disabled={
                                isSendBusy ||
                                isConnecting ||
                                isVoiceTranscribing ||
                                !composerSendState.hasSendableContent
                              }
                              aria-label={
                                isConnecting
                                  ? "Connecting"
                                  : isVoiceTranscribing
                                    ? "Transcribing voice note"
                                    : isPreparingWorktree
                                      ? "Preparing worktree"
                                      : isSendBusy
                                        ? "Sending"
                                        : "Send message"
                              }
                            >
                              {isConnecting || isSendBusy ? (
                                <svg
                                  width="12"
                                  height="12"
                                  viewBox="0 0 14 14"
                                  fill="none"
                                  className="animate-spin"
                                  aria-hidden="true"
                                >
                                  <circle
                                    cx="7"
                                    cy="7"
                                    r="5.5"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeDasharray="20 12"
                                  />
                                </svg>
                              ) : (
                                <ComposerSendArrowIcon
                                  aria-hidden="true"
                                  className="size-5 shrink-0"
                                />
                              )}
                            </Button>
                          </>
                        )
                      ) : null}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ComposerColumnFrame>
        </form>
        {emptyLandingControls}
      </>
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
        "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
        CHAT_BACKGROUND_CLASS_NAME,
      )}
    >
      {/* Top bar */}
      <header
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
          onCreateHandoff={onCreateHandoffThread}
          onNavigateToThread={onNavigateToThread}
          onRenameThread={() => setRenameDialogOpen(true)}
          {...(onCloseThreadPane ? { onCloseThreadPane } : {})}
        />
      </header>

      <RenameThreadDialog
        open={renameDialogOpen}
        currentTitle={activeThread.title}
        onOpenChange={setRenameDialogOpen}
        onSave={handleRenameActiveThread}
      />

      {/* Error banner */}
      <ProviderHealthBanner
        status={shouldShowProviderHealthBanner ? visibleActiveProviderStatus : null}
        onDismiss={dismissActiveProviderHealthBanner}
      />
      <ThreadErrorBanner error={activeThread.error} onDismiss={dismissActiveThreadError} />
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
                  "chat-pane-enter flex flex-1 items-center justify-center",
                  CHAT_COLUMN_GUTTER_CLASS_NAME,
                )}
              >
                {/* Center the heading, composer, and suggestion list together as a
                    single group: the suggestions live in normal flow so the whole
                    block (composer + suggestions) stays vertically centered in the
                    view instead of the composer being centered with the list hanging
                    below it. */}
                <div className="flex w-full flex-col justify-center">
                  <div
                    className={cn(
                      "flex flex-col items-center gap-4 px-6 pb-5 text-center select-none",
                      CHAT_COLUMN_FRAME_CLASS_NAME,
                    )}
                  >
                    <SynaraLogo aria-label="Synara logo" className="size-10" />
                    <h2 className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]">
                      {isEmptyChatLanding ? (
                        "What should we work on?"
                      ) : (
                        <>
                          What should we do in{" "}
                          <span className={COMPOSER_MUTED_ACCENT_TEXT_CLASS_NAME}>
                            {activeProjectDisplayName ?? "this folder"}
                          </span>
                          ?
                        </>
                      )}
                    </h2>
                  </div>
                  {composerSection}
                  {(isGitRepo && !environmentEnabled && !isCenteredEmptyLanding) ||
                  relocateComposerLeadingControls ? (
                    <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
                      <div className="flex w-full items-center gap-1">
                        {relocateComposerLeadingControls ? (
                          <div className="flex shrink-0 items-center gap-1 pl-1">
                            {renderComposerLeadingControls({ iconOnly: true })}
                          </div>
                        ) : null}
                        {isGitRepo && !environmentEnabled && !isCenteredEmptyLanding ? (
                          <BranchToolbar {...branchToolbarProps} className="min-w-0 flex-1" />
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {showComposerSuggestions ? (
                    <DisclosureRegion
                      open={composerSuggestionsOpen}
                      className={COMPOSER_COLUMN_FRAME_CLASS_NAME}
                      contentClassName="pt-5"
                    >
                      <ComposerSuggestions
                        suggestions={composerSuggestions}
                        onSelectSuggestion={onSelectComposerSuggestion}
                      />
                    </DisclosureRegion>
                  ) : null}
                </div>
              </div>
            ) : null}

            {shouldRenderChatPaneContent && !isCenteredEmptyLanding ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                  <ChatTranscriptPane
                    activeThreadId={activeThread.id}
                    activeTurnId={activeThread.session?.activeTurnId ?? null}
                    agentActivityDetail={openAgentActivityDetail}
                    hasMessages={timelineEntries.length > 0}
                    isWorking={isWorking}
                    activeTurnInProgress={activeTurnInProgress}
                    activeTurnStartedAt={activeWorkStartedAt}
                    listRef={legendListRef}
                    timelineControllerRef={timelineControllerRef}
                    pinnedMessageIds={pinnedMessageIds}
                    onTogglePinMessage={handleTogglePinMessage}
                    threadMarkers={threadMarkers}
                    timelineEntries={timelineEntries}
                    turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                    onOpenTurnDiff={onOpenTurnDiff}
                    onOpenThread={onNavigateToThread}
                    revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                    onRevertUserMessage={onRevertUserMessage}
                    onEditUserMessage={onEditUserMessage}
                    isRevertingCheckpoint={isRevertingCheckpoint}
                    onExpandTimelineImage={onExpandTimelineImage}
                    followLiveOutput={hasStreamingAssistantText}
                    onIsAtEndChange={onIsAtEndChange}
                    markdownCwd={threadWorkspaceCwd ?? undefined}
                    resolvedTheme={resolvedTheme}
                    chatFontSizePx={settings.chatFontSizePx}
                    timestampFormat={timestampFormat}
                    workspaceRoot={activeProject?.cwd ?? undefined}
                    emptyStateContent={isEditorRail ? <span aria-hidden="true" /> : undefined}
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
                    bottomContentInsetPx={
                      activeTaskList && !planSidebarOpen && activeTaskListCardHeight > 0
                        ? activeTaskListCardHeight + 8
                        : undefined
                    }
                    contentInsetRightPx={
                      environmentAppliesContentInset
                        ? ENVIRONMENT_DOCKED_CONTENT_INSET_PX
                        : undefined
                    }
                  />
                </div>

                <div
                  className={cn(
                    "relative z-10 -mt-5 w-full shrink-0 overflow-visible pt-0 sm:pt-0",
                    ENVIRONMENT_CONTENT_INSET_MOTION_CLASS,
                    CHAT_COLUMN_GUTTER_CLASS_NAME,
                    // A trailing BranchToolbar only renders for legacy git threads; otherwise the
                    // composer is the last element, so give it a comfortable bottom margin.
                    isGitRepo && !environmentEnabled ? "pb-0.5" : "pb-3 sm:pb-4",
                  )}
                  // Match the transcript's right inset so the composer stays aligned with chat
                  // content (and clear of the docked Environment overlay).
                  style={
                    environmentAppliesContentInset
                      ? { paddingRight: ENVIRONMENT_DOCKED_CONTENT_INSET_PX }
                      : undefined
                  }
                >
                  {composerSection}
                </div>
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
            ) : null}

            {shouldRenderChatPaneContent && secondaryChromeReady && pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                cwd={activeProject?.cwd ?? null}
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
              <ThreadTerminalDrawer
                key={`${activeThread.id}-workspace`}
                {...terminalDrawerProps}
                presentationMode="workspace"
                isVisible={terminalWorkspaceTerminalTabActive}
                onTogglePresentationMode={
                  terminalState.workspaceLayout === "both" ? collapseTerminalWorkspace : undefined
                }
              />
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
            workspaceRoot={activeProject?.cwd ?? undefined}
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
          <ThreadTerminalDrawer
            key={activeThread.id}
            {...terminalDrawerProps}
            presentationMode="drawer"
            onTogglePresentationMode={expandTerminalWorkspace}
          />
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
      {isInactiveSplitPane ? null : (
        <TranscriptSelectionActionLayer
          action={pendingTranscriptSelectionAction}
          onHighlight={createHighlightFromPendingSelection}
          onUnderline={createUnderlineFromPendingSelection}
          onAddToChat={commitTranscriptAssistantSelection}
        />
      )}

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
          {/* Full-bleed backdrop click target — intentionally a raw <button> because it has no visible chrome. */}
          <button
            type="button"
            className="absolute inset-0 z-0 cursor-zoom-out"
            aria-label="Close image preview"
            onClick={closeExpandedImage}
          />
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute left-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              aria-label="Previous image"
              onClick={() => {
                navigateExpandedImage(-1);
              }}
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
          )}
          <div className="relative isolate z-10 max-h-[92vh] max-w-[92vw]">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              className="absolute right-2 top-2"
              onClick={closeExpandedImage}
              aria-label="Close image preview"
            >
              <XIcon />
            </Button>
            <img
              src={expandedImageItem.src}
              alt={expandedImageItem.name}
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-[color:var(--color-border)] bg-[var(--color-background-elevated-primary-opaque)] object-contain shadow-2xl"
              draggable={false}
            />
            <p className="mt-2 max-w-[92vw] truncate text-center text-xs text-muted-foreground/80">
              {expandedImageItem.name}
              {expandedImage.images.length > 1
                ? ` (${expandedImage.index + 1}/${expandedImage.images.length})`
                : ""}
            </p>
          </div>
          {expandedImage.images.length > 1 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="absolute right-2 top-1/2 z-20 -translate-y-1/2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              aria-label="Next image"
              onClick={() => {
                navigateExpandedImage(1);
              }}
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
