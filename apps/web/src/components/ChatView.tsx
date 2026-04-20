import {
  type ApprovalRequestId,
  DEFAULT_MODEL_BY_PROVIDER,
  type ClaudeCodeEffort,
  MessageId,
  type ModelSelection,
  type ProjectScript,
  type ModelSlug,
  type ProviderKind,
  type ProjectEntry,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderMentionReference,
  type ProviderNativeCommandDescriptor,
  type ProviderPluginDescriptor,
  type ProviderSkillDescriptor,
  type ProviderSkillReference,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ResolvedKeybindingsConfig,
  type ServerProviderStatus,
  ThreadId,
  type TurnId,
  type EditorId,
  type KeybindingCommand,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  normalizeModelSlug,
} from "@t3tools/shared/model";
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
import { deriveTerminalCommandIdentity } from "@t3tools/shared/terminalThreads";
import { deriveAssociatedWorktreeMetadata } from "@t3tools/shared/threadWorkspace";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GoTasklist } from "react-icons/go";
import { FiThumbsUp } from "react-icons/fi";
import { HiOutlineHandRaised } from "react-icons/hi2";
import { PiArrowBendDownRight } from "react-icons/pi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { gitCreateWorktreeMutationOptions, gitBranchesQueryOptions } from "~/lib/gitReactQuery";
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
} from "~/lib/providerDiscoveryReactQuery";
import { projectSearchEntriesQueryOptions } from "~/lib/projectReactQuery";
import { serverConfigQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import {
  formatComposerMentionToken,
  createComposerMentionTokenRegex,
} from "~/lib/composerMentions";
import { getLocalFolderBrowseRootPath, isLocalFolderMentionQuery } from "~/lib/localFolderMentions";
import {
  isProviderUsable,
  normalizeProviderStatusForLocalConfig,
  providerUnavailableReason,
} from "~/lib/providerAvailability";
import { isElectron } from "../env";
import { parseDiffRouteSearch, stripDiffSearchParams } from "../diffRouteSearch";
import { resolveSubagentPresentationForThread } from "../lib/subagentPresentation";
import { isHomeChatContainerProject } from "../lib/chatProjects";
import { resolveFirstSendTarget } from "../lib/chatFirstSend";
import {
  maybeResolveBrowserPromptAttachment,
  type BrowserPromptAttachmentResolution,
} from "../lib/browserPromptContext";
import { dispatchThreadRename } from "../lib/threadRename";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import {
  buildThreadBreadcrumbs,
  enrichSubagentWorkEntries,
  resolveActiveThreadTitle,
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
import { createProjectSelector, createThreadSelector } from "../storeSelectors";
import {
  canOfferForkSlashCommand,
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
  deriveActivePlanState,
  deriveActiveBackgroundTasksState,
  findSidebarProposedPlan,
  findLatestProposedPlan,
  deriveWorkLogEntries,
  hasActionableProposedPlan,
  hasLiveTurnTailWork,
  hasToolActivityForTurn,
  isLatestTurnSettled,
  formatElapsed,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
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
  type TurnDiffSummary,
} from "../types";
import { useTheme } from "../hooks/useTheme";
import { useThreadWorkspaceHandoff } from "../hooks/useThreadWorkspaceHandoff";
import { useComposerCommandMenuItems } from "../hooks/useComposerCommandMenuItems";
import { useThreadHandoff } from "../hooks/useThreadHandoff";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import BranchToolbar from "./BranchToolbar";
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
  EllipsisIcon,
  QueueArrow,
  Trash2,
  XIcon,
} from "~/lib/icons";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { terminalRuntimeRegistry } from "./terminal/terminalRuntimeRegistry";
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
import { SidebarHeaderTrigger } from "./ui/sidebar";
import { newCommandId, newMessageId, newProjectId, newThreadId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  confirmTerminalTabClose,
  resolveTerminalCloseTitle,
} from "~/lib/terminalCloseConfirmation";
import {
  getCustomModelOptionsByProvider,
  getCustomModelsByProvider,
  getProviderStartOptions,
  resolveAppModelSelection,
  useAppSettings,
} from "../appSettings";
import { resolveTerminalNewAction } from "../lib/terminalNewAction";
import { isTerminalFocused } from "../lib/terminalFocus";
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
import {
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
  deriveContextWindowSelectionStatus,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowSnapshot,
} from "../lib/contextWindow";
import { formatVoiceRecordingDuration, useVoiceRecorder } from "../lib/voiceRecorder";
import { shouldUseCompactComposerFooter } from "./composerFooterLayout";
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
import { ChatTranscriptPane } from "./chat/ChatTranscriptPane";
import { ComposerSlashStatusDialog } from "./chat/ComposerSlashStatusDialog";
import { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { AVAILABLE_PROVIDER_OPTIONS, ProviderModelPicker } from "./chat/ProviderModelPicker";
import { ComposerCommandItem, ComposerCommandMenu } from "./chat/ComposerCommandMenu";
import {
  ComposerLocalDirectoryMenu,
  type ComposerLocalDirectoryMenuHandle,
} from "./chat/ComposerLocalDirectoryMenu";
import { ComposerPendingApprovalActions } from "./chat/ComposerPendingApprovalActions";
import { ComposerExtrasMenu } from "./chat/ComposerExtrasMenu";
import { ComposerPendingApprovalPanel } from "./chat/ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./chat/ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./chat/ComposerPlanFollowUpBanner";
import { ComposerVoiceButton } from "./chat/ComposerVoiceButton";
import { ComposerVoiceRecorderBar } from "./chat/ComposerVoiceRecorderBar";
import { ComposerReferenceAttachments } from "./chat/ComposerReferenceAttachments";
import { TranscriptSelectionActionLayer } from "./chat/TranscriptSelectionActionLayer";
import { ActivePlanCard } from "./chat/ActivePlanCard";
import { useChatAutoScrollController } from "./chat/useChatAutoScrollController";
import { useTranscriptAssistantSelectionAction } from "./chat/useTranscriptAssistantSelectionAction";
import {
  getComposerProviderState,
  renderProviderTraitsPicker,
} from "./chat/composerProviderRegistry";
import { getComposerTraitSelection } from "./chat/composerTraits";
import { ProjectPicker } from "./chat/ProjectPicker";
import { ProviderHealthBanner } from "./chat/ProviderHealthBanner";
import { ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { RateLimitBanner, deriveLatestRateLimitStatus } from "./chat/RateLimitBanner";
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
  shouldRenderTerminalWorkspace,
  cloneComposerImageForRetry,
  collectUserMessageBlobPreviewUrls,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  hasServerAcknowledgedLocalDispatch,
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
  LastInvokedScriptByProjectSchema,
  type LocalDispatchSnapshot,
  PullRequestDialogState,
  readFileAsDataUrl,
  revokeBlobPreviewUrl,
  revokeUserMessagePreviewUrls,
} from "./ChatView.logic";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useComposerSlashCommands } from "../hooks/useComposerSlashCommands";
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
import { buildModelSelection, buildNextProviderOptions } from "../providerModelOptions";
import { waitForRecoverableProjectForDuplicateCreate } from "../lib/projectCreateRecovery";

const ATTACHMENT_PREVIEW_HANDOFF_TTL_MS = 5000;
const IMAGE_SIZE_LIMIT_LABEL = `${Math.round(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024))}MB`;
const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_PROJECT_ENTRIES: ProjectEntry[] = [];
const EMPTY_PROVIDER_NATIVE_COMMANDS: ProviderNativeCommandDescriptor[] = [];
const EMPTY_PROVIDER_SKILLS: ProviderSkillDescriptor[] = [];
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
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};

type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

const EMPTY_COMPOSER_PLUGIN_SUGGESTIONS: ComposerPluginSuggestion[] = [];

function formatOutgoingPrompt(params: {
  provider: ProviderKind;
  model: string | null;
  effort: string | null;
  text: string;
}): string {
  const caps = getModelCapabilities(params.provider, params.model);
  if (params.effort && caps.promptInjectedEffortLevels.includes(params.effort)) {
    return applyClaudePromptEffortPrefix(params.text, params.effort as ClaudeCodeEffort | null);
  }
  return params.text;
}

function buildQueuedComposerPreviewText(input: {
  trimmedPrompt: string;
  images: ReadonlyArray<ComposerImageAttachment>;
  assistantSelections: ReadonlyArray<{ id: string }>;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
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
  return "Queued follow-up";
}

const COMPOSER_PATH_QUERY_DEBOUNCE_MS = 120;
const SCRIPT_TERMINAL_COLS = 120;
const SCRIPT_TERMINAL_ROWS = 30;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Turn a raw model slug like "gpt-5.3-codex-spark" into "GPT-5.3 Codex Spark". */
function formatModelSlug(slug: string): string {
  return slug
    .replace(/^gpt-/i, "GPT-")
    .replace(/^claude-/i, "Claude ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    const withoutContextSuffix = slug.replace(/\[[^\]]+\]$/u, "");
    return normalizeModelSlug(withoutContextSuffix, provider) ?? withoutContextSuffix;
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<{
    slug: string;
    name: string;
    isCustom?: boolean;
  }>;
  dynamicModels: ReadonlyArray<{ slug: string; name?: string | null }>;
}): ReadonlyArray<{ slug: string; name: string; isCustom?: boolean }> {
  const staticNameBySlug = new Map(input.staticOptions.map((model) => [model.slug, model.name]));
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: Array<{ slug: string; name: string }> = [];

  for (const dynamicModel of input.dynamicModels) {
    const rawName = dynamicModel.name?.trim() ?? "";
    const isClaudeDefaultAlias =
      input.provider === "claudeAgent" &&
      (rawName.toLowerCase() === "default (recommended)" ||
        rawName.toLowerCase() === "default recommended" ||
        dynamicModel.slug.trim().toLowerCase() === "default");
    if (isClaudeDefaultAlias) {
      continue;
    }

    const normalizedSlug = normalizeDynamicModelSlug(input.provider, dynamicModel.slug);
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        staticNameBySlug.get(normalizedSlug) ??
        dynamicModel.name ??
        formatModelSlug(normalizedSlug),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) => "isCustom" in model && model.isCustom && !dynamicNormalizedSlugs.has(model.slug),
  );
  const staticBuiltInModels = input.staticOptions.filter(
    (model) => !("isCustom" in model) || model.isCustom !== true,
  );
  const missingStaticBuiltIns = staticBuiltInModels.filter(
    (model) => !dynamicNormalizedSlugs.has(model.slug),
  );

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}

function skillMentionPrefix(provider: string): string {
  return provider === "claudeAgent" ? "/" : "$";
}

function promptIncludesSkillMention(prompt: string, skillName: string, provider: string): boolean {
  const prefix = escapeRegExp(skillMentionPrefix(provider));
  const pattern = new RegExp(`(^|\\s)${prefix}${escapeRegExp(skillName)}(?=\\s|$)`, "i");
  return pattern.test(prompt);
}

const PROMPT_MENTION_NAME_REGEX = createComposerMentionTokenRegex({
  includeTrailingTokenAtEnd: true,
});

function collectPromptMentionNames(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(PROMPT_MENTION_NAME_REGEX)) {
    const mentionName = (match[2] ?? match[3] ?? "").trim();
    if (mentionName.length > 0) {
      names.push(mentionName);
    }
  }
  return names;
}

function normalizeMentionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function resolvePromptPluginMentions(params: {
  prompt: string;
  existingMentions: ReadonlyArray<ProviderMentionReference>;
  providerPlugins: ReadonlyArray<ComposerPluginSuggestion>;
}): ProviderMentionReference[] {
  const promptMentionNames = collectPromptMentionNames(params.prompt);
  if (promptMentionNames.length === 0) {
    return [];
  }

  const uniquePromptMentionNames: string[] = [];
  const seenPromptMentionNames = new Set<string>();
  for (const mentionName of promptMentionNames) {
    const key = normalizeMentionNameKey(mentionName);
    if (seenPromptMentionNames.has(key)) {
      continue;
    }
    seenPromptMentionNames.add(key);
    uniquePromptMentionNames.push(mentionName);
  }

  const existingMentionsByName = new Map<string, ProviderMentionReference[]>();
  for (const mention of params.existingMentions) {
    const key = normalizeMentionNameKey(mention.name);
    const bucket = existingMentionsByName.get(key);
    if (bucket) {
      bucket.push(mention);
    } else {
      existingMentionsByName.set(key, [mention]);
    }
  }

  const providerMentionsByName = new Map<string, ProviderMentionReference[]>();
  for (const suggestion of params.providerPlugins) {
    const key = normalizeMentionNameKey(suggestion.plugin.name);
    const bucket = providerMentionsByName.get(key);
    if (bucket) {
      bucket.push(suggestion.mention);
    } else {
      providerMentionsByName.set(key, [suggestion.mention]);
    }
  }

  const resolvedMentions: ProviderMentionReference[] = [];
  const seenPaths = new Set<string>();

  for (const mentionName of uniquePromptMentionNames) {
    const key = normalizeMentionNameKey(mentionName);
    const existingMention = (existingMentionsByName.get(key) ?? []).find(
      (candidate) => !seenPaths.has(candidate.path),
    );
    if (existingMention) {
      seenPaths.add(existingMention.path);
      resolvedMentions.push(existingMention);
      continue;
    }

    const discoveredMentions = providerMentionsByName.get(key) ?? [];
    if (discoveredMentions.length === 1) {
      const discoveredMention = discoveredMentions[0]!;
      seenPaths.add(discoveredMention.path);
      resolvedMentions.push(discoveredMention);
    }
  }

  return resolvedMentions;
}

const providerMentionReferencesEqual = (
  left: ReadonlyArray<ProviderMentionReference>,
  right: ReadonlyArray<ProviderMentionReference>,
): boolean =>
  left.length === right.length &&
  left.every(
    (mention, index) => mention.path === right[index]?.path && mention.name === right[index]?.name,
  );

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

interface ChatViewProps {
  threadId: ThreadId;
  paneScopeId?: string;
  surfaceMode?: "single" | "split";
  isFocusedPane?: boolean;
  panelState?: SplitViewPanePanelState;
  onToggleDiffPanel?: () => void;
  onToggleBrowserPanel?: () => void;
  onOpenTurnDiffPanel?: (turnId: TurnId, filePath?: string) => void;
  onSplitSurface?: () => void;
  onMaximizeSurface?: () => void;
}

export default function ChatView({
  threadId,
  paneScopeId = "single",
  surfaceMode = "single",
  isFocusedPane = true,
  panelState,
  onToggleDiffPanel,
  onToggleBrowserPanel,
  onOpenTurnDiffPanel,
  onSplitSurface,
  onMaximizeSurface,
}: ChatViewProps) {
  const markThreadVisited = useStore((store) => store.markThreadVisited);
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const setStoreThreadError = useStore((store) => store.setError);
  const setStoreThreadWorkspace = useStore((store) => store.setThreadWorkspace);
  const { settings } = useAppSettings();
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const timestampFormat = settings.timestampFormat;
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { createThreadHandoff } = useThreadHandoff();
  const rawSearch = useSearch({
    strict: false,
    select: (params) => parseDiffRouteSearch(params),
  });
  const activeSplitView = useSplitViewStore(selectSplitView(rawSearch.splitViewId ?? null));
  const removeThreadFromSplitViews = useSplitViewStore((store) => store.removeThreadFromSplitViews);
  const { resolvedTheme } = useTheme();
  const queryClient = useQueryClient();
  const createWorktreeMutation = useMutation(gitCreateWorktreeMutationOptions({ queryClient }));
  const composerDraft = useComposerThreadDraft(threadId);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerAssistantSelections = composerDraft.assistantSelections;
  const composerTerminalContexts = composerDraft.terminalContexts;
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
        terminalContexts: composerTerminalContexts,
      }),
    [composerAssistantSelections.length, composerImages.length, composerTerminalContexts, prompt],
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
  const [localDraftErrorsByThreadId, setLocalDraftErrorsByThreadId] = useState<
    Record<ThreadId, string | null>
  >({});
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const [isConnecting, _setIsConnecting] = useState(false);
  const [isRevertingCheckpoint, setIsRevertingCheckpoint] = useState(false);
  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const [respondingUserInputRequestIds, setRespondingUserInputRequestIds] = useState<
    ApprovalRequestId[]
  >([]);
  const [pendingUserInputAnswersByRequestId, setPendingUserInputAnswersByRequestId] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<Record<string, boolean>>({});
  const [planSidebarOpen, setPlanSidebarOpen] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [composerCommandPicker, setComposerCommandPicker] = useState<
    null | "fork-target" | "review-target"
  >(null);
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
    [],
  );
  const [selectedComposerMentions, setSelectedComposerMentions] = useState<
    ProviderMentionReference[]
  >([]);
  const [lastInvokedScriptByProjectId, setLastInvokedScriptByProjectId] = useLocalStorage(
    LAST_INVOKED_SCRIPT_BY_PROJECT_KEY,
    {},
    LastInvokedScriptByProjectSchema,
  );
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [isTraitsPickerOpen, setIsTraitsPickerOpen] = useState(false);

  useEffect(() => {
    setComposerCommandPicker(null);
    setIsModelPickerOpen(false);
    setIsTraitsPickerOpen(false);
  }, [threadId]);
  useEffect(() => {
    // Thread-bound handoff dialog state is reset by the dedicated hook.
  }, [threadId]);
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
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
  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(threadId, imageId);
    },
    [removeComposerDraftImage, threadId],
  );
  const clearComposerAssistantSelectionsFromDraft = useCallback(() => {
    clearComposerDraftAssistantSelections(threadId);
  }, [clearComposerDraftAssistantSelections, threadId]);
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
  const resolvedBrowserOpen = panelState ? panelState.panel === "browser" : browserOpen;
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
  const latestTurnSettledByProvider = isLatestTurnSettled(
    activeLatestTurn,
    activeThread?.session ?? null,
  );
  const latestTurnSettled = latestTurnSettledByProvider && !hasLiveTurnTail;
  const activeProjectId = activeThread?.projectId ?? draftThread?.projectId ?? null;
  const activeProject = useStore(
    useMemo(() => createProjectSelector(activeProjectId), [activeProjectId]),
  );
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const isHomeChatContainer = isHomeChatContainerProject(activeProject, homeDir);
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
  const voiceTranscriptionRequestIdRef = useRef(0);
  const voiceThreadIdRef = useRef(threadId);
  const voiceProviderRef = useRef<ProviderKind>(selectedProvider);
  const voiceRecordingStartedAtRef = useRef<number | null>(null);
  voiceThreadIdRef.current = threadId;
  voiceProviderRef.current = selectedProvider;
  const customModelsByProvider = useMemo(() => getCustomModelsByProvider(settings), [settings]);
  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId,
    selectedProvider,
    threadModelSelection: activeThread?.modelSelection,
    projectModelSelection: activeProject?.defaultModelSelection,
    customModelsByProvider,
  });
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        prompt,
        modelOptions: composerModelOptions,
      }),
    [composerModelOptions, prompt, selectedModel, selectedProvider],
  );
  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  const selectedModelSelection = useMemo<ModelSelection>(
    () => buildModelSelection(selectedProvider, selectedModel, selectedModelOptionsForDispatch),
    [selectedModel, selectedModelOptionsForDispatch, selectedProvider],
  );
  const providerOptionsForDispatch = useMemo(() => getProviderStartOptions(settings), [settings]);
  const selectedModelForPicker = selectedModel;
  const claudeDynamicModelsQuery = useQuery(
    providerModelsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicModelsQuery = useQuery(providerModelsQueryOptions({ provider: "codex" }));
  const geminiModelsQuery = useQuery(
    providerModelsQueryOptions({
      provider: "gemini",
      binaryPath: settings.geminiBinaryPath || null,
      enabled: selectedProvider === "gemini" || lockedProvider === "gemini",
    }),
  );
  const claudeDynamicAgentsQuery = useQuery(
    providerAgentsQueryOptions({ provider: "claudeAgent" }),
  );
  const codexDynamicAgentsQuery = useQuery(providerAgentsQueryOptions({ provider: "codex" }));
  const modelOptionsByProvider = useMemo(() => {
    const staticOptions = getCustomModelOptionsByProvider(settings);
    const result = { ...staticOptions };

    const dynamicSources: Record<ProviderKind, typeof claudeDynamicModelsQuery.data> = {
      claudeAgent: claudeDynamicModelsQuery.data,
      codex: codexDynamicModelsQuery.data,
      gemini: geminiModelsQuery.data,
    };

    for (const provider of ["claudeAgent", "codex", "gemini"] as const) {
      const dynamicModels = dynamicSources[provider]?.models;
      if (dynamicModels && dynamicModels.length > 0) {
        result[provider] = mergeDynamicModelOptions({
          provider,
          staticOptions: staticOptions[provider],
          dynamicModels: dynamicModels.map((model) => ({
            slug: model.slug,
            name: model.name,
          })),
        });
      }
    }

    return result;
  }, [
    settings,
    claudeDynamicModelsQuery.data,
    codexDynamicModelsQuery.data,
    geminiModelsQuery.data,
  ]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByProvider[selectedProvider];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByProvider, selectedModelForPicker, selectedProvider]);
  const searchableModelOptions = useMemo(
    () =>
      AVAILABLE_PROVIDER_OPTIONS.filter(
        (option) => lockedProvider === null || option.value === lockedProvider,
      ).flatMap((option) =>
        modelOptionsByProvider[option.value].map(({ slug, name }) => ({
          provider: option.value,
          providerLabel: option.label,
          slug,
          name,
          searchSlug: slug.toLowerCase(),
          searchName: name.toLowerCase(),
          searchProvider: option.label.toLowerCase(),
        })),
      ),
    [lockedProvider, modelOptionsByProvider],
  );
  const phase = derivePhase(activeThread?.session ?? null);
  const rawWorkLogEntries = useMemo(
    () => deriveWorkLogEntries(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, threadActivities],
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
  const latestTurnHasToolActivity = useMemo(
    () => hasToolActivityForTurn(threadActivities, activeLatestTurn?.turnId),
    [activeLatestTurn?.turnId, threadActivities],
  );
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
  const planSidebarLabel = sidebarProposedPlan || interactionMode === "plan" ? "Plan" : "Tasks";
  const activePlan = useMemo(
    () =>
      latestTurnSettled
        ? null
        : deriveActivePlanState(threadActivities, activeLatestTurn?.turnId ?? undefined),
    [activeLatestTurn?.turnId, latestTurnSettled, threadActivities],
  );
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
  // Keep the active-turn UI alive for buffering/task states, but only treat
  // real assistant text growth as "follow output" for transcript auto-scroll.
  const hasStreamingAssistantText = useMemo(
    () =>
      activeThread?.messages.some((message) => message.role === "assistant" && message.streaming) ??
      false,
    [activeThread?.messages],
  );
  const activeTurnLayoutLive = isWorking || !latestTurnSettled;
  const [keepSettledActiveTurnLayout, setKeepSettledActiveTurnLayout] = useState(false);
  const previousActiveTurnLayoutLiveRef = useRef(activeTurnLayoutLive);
  const previousActiveTurnLayoutKeyRef = useRef<string | null>(null);
  const activeWorkStartedAt = hasLiveTurnTail
    ? (activeLatestTurn?.startedAt ?? localDispatch?.startedAt ?? null)
    : deriveActiveWorkStartedAt(
        activeLatestTurn,
        activeThread?.session ?? null,
        localDispatch?.startedAt ?? null,
      );
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
    for (const previewUrl of previousPreviewUrls) {
      if (!previewUrls.includes(previewUrl)) {
        revokeBlobPreviewUrl(previewUrl);
      }
    }
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
      if (currentPreviewUrls) {
        for (const previewUrl of currentPreviewUrls) {
          revokeBlobPreviewUrl(previewUrl);
        }
      }
      setAttachmentPreviewHandoffByMessageId((existing) => {
        if (!(messageId in existing)) return existing;
        const next = { ...existing };
        delete next[messageId];
        attachmentPreviewHandoffByMessageIdRef.current = next;
        return next;
      });
      delete attachmentPreviewHandoffTimeoutByMessageIdRef.current[messageId];
    }, ATTACHMENT_PREVIEW_HANDOFF_TTL_MS);
  }, []);
  const serverMessages = activeThread?.messages;
  const timelineMessages = useMemo(() => {
    const messages = serverMessages ?? [];
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
  }, [serverMessages, attachmentPreviewHandoffByMessageId, optimisticUserMessages]);
  const timelineEntries = useMemo(
    () =>
      deriveTimelineEntries(timelineMessages, activeThread?.proposedPlans ?? [], workLogEntries),
    [activeThread?.proposedPlans, timelineMessages, workLogEntries],
  );
  // Empty top-level threads render the centered landing composer instead of the transcript pane.
  // Home-scoped chats get the global "What should we work on?" copy plus the project picker,
  // while project-scoped drafts reuse the same centered layout with folder-specific copy.
  const isCenteredEmptyLanding = timelineEntries.length === 0 && !activeThread?.parentThreadId;
  const isEmptyChatLanding =
    isCenteredEmptyLanding && Boolean(homeDir) && activeProject?.cwd === homeDir;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const turnDiffSummaryByAssistantMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, TurnDiffSummary>();
    for (const summary of turnDiffSummaries) {
      if (!summary.assistantMessageId) continue;
      byMessageId.set(summary.assistantMessageId, summary);
    }
    return byMessageId;
  }, [turnDiffSummaries]);
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

  const completionSummary = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!latestTurnHasToolActivity) return null;

    const elapsed = formatElapsed(activeLatestTurn.startedAt, activeLatestTurn.completedAt);
    return elapsed ? `Worked for ${elapsed}` : null;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    latestTurnHasToolActivity,
    latestTurnSettled,
  ]);
  const completionDividerBeforeEntryId = useMemo(() => {
    if (!latestTurnSettled) return null;
    if (!activeLatestTurn?.startedAt) return null;
    if (!activeLatestTurn.completedAt) return null;
    if (!completionSummary) return null;

    const turnStartedAt = Date.parse(activeLatestTurn.startedAt);
    const turnCompletedAt = Date.parse(activeLatestTurn.completedAt);
    if (Number.isNaN(turnStartedAt)) return null;
    if (Number.isNaN(turnCompletedAt)) return null;

    let inRangeMatch: string | null = null;
    let fallbackMatch: string | null = null;
    for (const timelineEntry of timelineEntries) {
      if (timelineEntry.kind !== "message") continue;
      if (timelineEntry.message.role !== "assistant") continue;
      const messageAt = Date.parse(timelineEntry.message.createdAt);
      if (Number.isNaN(messageAt) || messageAt < turnStartedAt) continue;
      fallbackMatch = timelineEntry.id;
      if (messageAt <= turnCompletedAt) {
        inRangeMatch = timelineEntry.id;
      }
    }
    return inRangeMatch ?? fallbackMatch;
  }, [
    activeLatestTurn?.completedAt,
    activeLatestTurn?.startedAt,
    completionSummary,
    latestTurnSettled,
    timelineEntries,
  ]);
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
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const localFolderBrowseRootPath = getLocalFolderBrowseRootPath(
    serverConfigQuery.data?.homeDir ?? null,
    isMacPlatform(platform),
  );
  const isLocalFolderBrowserOpen =
    composerCommandPicker === null &&
    isMentionTrigger &&
    isLocalFolderMentionQuery(mentionTriggerQuery);
  const skillTriggerQuery = composerTrigger?.kind === "skill" ? composerTrigger.query : "";
  const isSkillTrigger = composerTriggerKind === "skill";
  const [debouncedPathQuery, composerPathQueryDebouncer] = useDebouncedValue(
    mentionTriggerQuery,
    { wait: COMPOSER_PATH_QUERY_DEBOUNCE_MS },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const effectiveMentionQuery = mentionTriggerQuery.length > 0 ? debouncedPathQuery : "";
  const composerSkillCwd = resolveProviderDiscoveryCwd({
    activeThreadWorktreePath: resolvedThreadWorktreePath,
    activeProjectCwd: activeProject?.cwd ?? null,
    serverCwd: serverConfigQuery.data?.cwd ?? null,
  });
  const providerComposerCapabilitiesQuery = useQuery(
    providerComposerCapabilitiesQueryOptions(selectedProvider),
  );
  const providerCommandsQuery = useQuery(
    providerCommandsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      query:
        composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model"
          ? (composerTrigger?.query ?? "")
          : "",
      enabled:
        (composerTriggerKind === "slash-command" || composerTriggerKind === "slash-model") &&
        supportsNativeSlashCommandDiscovery(providerComposerCapabilitiesQuery.data) &&
        composerSkillCwd !== null,
    }),
  );
  const providerSkillsQuery = useQuery(
    providerSkillsQueryOptions({
      provider: selectedProvider,
      cwd: composerSkillCwd,
      threadId,
      query: skillTriggerQuery,
      enabled:
        isSkillTrigger &&
        supportsSkillDiscovery(providerComposerCapabilitiesQuery.data) &&
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
  const selectedDynamicAgents = useMemo(
    () =>
      selectedProvider === "claudeAgent"
        ? (claudeDynamicAgentsQuery.data?.agents ?? [])
        : (codexDynamicAgentsQuery.data?.agents ?? []),
    [selectedProvider, claudeDynamicAgentsQuery.data?.agents, codexDynamicAgentsQuery.data?.agents],
  );
  const dynamicAgents = useMemo(
    () =>
      selectedDynamicAgents.map((agent) =>
        agent.description
          ? {
              name: agent.name,
              displayName: agent.displayName,
              description: agent.description,
            }
          : {
              name: agent.name,
              displayName: agent.displayName,
            },
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
      selectedProvider === "codex" &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
    canOfferReviewCommand,
    canOfferForkCommand,
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
  const providerStatuses = useMemo(
    () =>
      (serverConfigQuery.data?.providers ?? EMPTY_PROVIDER_STATUSES)
        .map((status) =>
          normalizeProviderStatusForLocalConfig({
            provider: status.provider,
            status,
            customBinaryPath:
              status.provider === "codex"
                ? settings.codexBinaryPath
                : status.provider === "claudeAgent"
                  ? settings.claudeBinaryPath
                  : settings.geminiBinaryPath,
          }),
        )
        .flatMap((status) => (status ? [status] : [])),
    [
      serverConfigQuery.data?.providers,
      settings.claudeBinaryPath,
      settings.codexBinaryPath,
      settings.geminiBinaryPath,
    ],
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
            (provider) =>
              isProviderUsable(
                providerStatuses.find((status) => status.provider === provider) ?? null,
              ),
          )
        : [],
    [activeThread, providerStatuses],
  );
  const handoffActionLabel = activeThread ? "Hand off thread" : "Create handoff thread";
  const activeProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === selectedProvider) ?? null,
    [selectedProvider, providerStatuses],
  );
  const voiceProviderStatus = useMemo(
    () => providerStatuses.find((status) => status.provider === "codex") ?? null,
    [providerStatuses],
  );
  const refreshVoiceStatus = useCallback(() => {
    const api = readNativeApi();
    if (!api) return;
    void api.server
      .refreshProviders()
      .then((result) => {
        queryClient.setQueryData(serverQueryKeys.config(), (current) =>
          current ? { ...current, providers: result.providers } : current,
        );
      })
      .catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to refresh provider status",
          description:
            error instanceof Error ? error.message : "Unknown error refreshing provider status.",
        });
      });
  }, [queryClient]);
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
  const terminalToggleShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "terminal.toggle"),
    [keybindings],
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
  const browserPanelShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "browser.toggle"),
    [keybindings],
  );
  const chatSplitShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "chat.split"),
    [keybindings],
  );
  // Composer picker shortcuts are hard-coded in the keydown handler below
  // (Mod+Shift+M opens the model picker, Mod+Shift+E opens the reasoning picker).
  // Build their display labels directly so the tooltips match the handler exactly.
  const modelPickerShortcutLabel = useMemo(
    () =>
      formatShortcutLabel({
        key: "m",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [],
  );
  const traitsPickerShortcutLabel = useMemo(
    () =>
      formatShortcutLabel({
        key: "e",
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
        modKey: true,
      }),
    [],
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
    activeProjectExists: activeProject !== undefined,
    presentationMode: terminalState.presentationMode,
    terminalOpen: terminalState.terminalOpen,
  });
  const terminalWorkspaceTerminalTabActive =
    terminalWorkspaceOpen &&
    (terminalState.workspaceLayout === "terminal-only" ||
      terminalState.workspaceActiveTab === "terminal");
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
    composerEditorRef.current?.focusAtEnd();
  }, []);
  const scheduleComposerFocus = useCallback(() => {
    window.requestAnimationFrame(() => {
      focusComposer();
    });
  }, [focusComposer]);
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
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminalRight(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalRight]);
  const splitTerminalLeft = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminalLeft(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalLeft]);
  const splitTerminalDown = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminalDown(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalDown]);
  const splitTerminalUp = useCallback(() => {
    if (!activeThreadId || hasReachedSplitLimit) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeSplitTerminalUp(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, hasReachedSplitLimit, storeSplitTerminalUp]);
  const createNewTerminal = useCallback(() => {
    if (!activeThreadId) return;
    const terminalId = `terminal-${randomUUID()}`;
    storeNewTerminal(activeThreadId, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
  }, [activeThreadId, storeNewTerminal]);
  const createNewTerminalTab = useCallback(
    (targetTerminalId: string) => {
      if (!activeThreadId) return;
      const terminalId = `terminal-${randomUUID()}`;
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
    const terminalId = `terminal-${randomUUID()}`;
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
        enabled: settings.confirmTerminalTabClose,
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
      terminalRuntimeRegistry.disposeTerminal(activeThreadId, terminalId);
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: activeThreadId, terminalId, data: "exit\n" })
          .catch(() => undefined);
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: activeThreadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: activeThreadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }
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
          const snapshot = await api.orchestration.getSnapshot();
          syncServerReadModel(snapshot);
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
      syncServerReadModel,
      settings.confirmTerminalTabClose,
      terminalState.entryPoint,
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
      storeCloseWorkspaceChat(activeThreadId);
      return;
    }
    closeTerminal(terminalState.activeTerminalId);
  }, [
    activeThreadId,
    closeTerminal,
    storeCloseWorkspaceChat,
    terminalState.activeTerminalId,
    terminalState.workspaceActiveTab,
    terminalState.workspaceLayout,
    terminalWorkspaceOpen,
  ]);
  const terminalDrawerProps = useMemo(
    () => ({
      threadId,
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
      const isBaseTerminalBusy = terminalState.runningTerminalIds.includes(baseTerminalId);
      const wantsNewTerminal = Boolean(options?.preferNewTerminal) || isBaseTerminalBusy;
      const shouldCreateNewTerminal = wantsNewTerminal;
      const targetTerminalId = shouldCreateNewTerminal
        ? `terminal-${randomUUID()}`
        : baseTerminalId;

      setTerminalOpen(true);
      if (shouldCreateNewTerminal) {
        storeNewTerminal(activeThreadId, targetTerminalId);
      } else {
        storeSetActiveTerminal(activeThreadId, targetTerminalId);
      }
      setTerminalFocusRequestId((value) => value + 1);

      const runtimeEnv = projectScriptRuntimeEnv({
        project: {
          cwd: activeProject.cwd,
        },
        worktreePath: options?.worktreePath ?? activeThread.worktreePath ?? null,
        ...(options?.env ? { extraEnv: options.env } : {}),
      });
      const openTerminalInput: Parameters<typeof api.terminal.open>[0] = shouldCreateNewTerminal
        ? {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
            cols: SCRIPT_TERMINAL_COLS,
            rows: SCRIPT_TERMINAL_ROWS,
          }
        : {
            threadId: activeThreadId,
            terminalId: targetTerminalId,
            cwd: targetCwd,
            env: runtimeEnv,
          };

      try {
        const terminalCommandIdentity = deriveTerminalCommandIdentity(script.command);
        await api.terminal.open(openTerminalInput);
        if (terminalCommandIdentity) {
          storeSetTerminalMetadata(activeThreadId, targetTerminalId, {
            cliKind: terminalCommandIdentity.cliKind,
            label: terminalCommandIdentity.title,
          });
        }
        await api.terminal.write({
          threadId: activeThreadId,
          terminalId: targetTerminalId,
          data: `${script.command}\r`,
        });
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
    syncServerReadModel,
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
      toastManager,
    ],
  );

  const handleInteractionModeChange = useCallback(
    (mode: ProviderInteractionMode) => {
      if (mode === interactionMode) return;
      setComposerDraftInteractionMode(threadId, mode);
      if (isLocalDraftThread) {
        setDraftThreadContext(threadId, { interactionMode: mode });
      }
      scheduleComposerFocus();
    },
    [
      interactionMode,
      isLocalDraftThread,
      scheduleComposerFocus,
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
          activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? "__dismissed__";
      } else {
        planSidebarDismissedForTurnRef.current = null;
      }
      return !open;
    });
  }, [activePlan?.turnId, sidebarProposedPlan?.turnId]);
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

  // Scroll behavior is isolated in a dedicated controller so the renderer tree only wires events.
  // Count actual transcript messages here so tool/work rows do not retrigger
  // the same "new content arrived" auto-stick behavior during buffering.
  const messageCount = useMemo(
    () => timelineEntries.filter((entry) => entry.kind === "message").length,
    [timelineEntries],
  );
  const {
    messagesScrollElement,
    showScrollToBottom,
    setMessagesBottomAnchorRef,
    setMessagesScrollContainerRef,
    forceStickToBottom,
    onLiveContentHeightChange,
    onComposerHeightChange,
    onMessagesClickCapture: onMessagesClickCaptureBase,
    onMessagesPointerCancel: onMessagesPointerCancelBase,
    onMessagesPointerDown: onMessagesPointerDownBase,
    onMessagesPointerUp: onMessagesPointerUpBase,
    onMessagesScroll: onMessagesScrollBase,
    onMessagesTouchEnd: onMessagesTouchEndBase,
    onMessagesTouchMove: onMessagesTouchMoveBase,
    onMessagesTouchStart: onMessagesTouchStartBase,
    onMessagesWheel: onMessagesWheelBase,
  } = useChatAutoScrollController({
    threadId: activeThread?.id ?? null,
    followLiveOutput: hasStreamingAssistantText,
    messageCount,
  });
  const {
    pendingTranscriptSelectionAction,
    commitTranscriptAssistantSelection,
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
    enabled: Boolean(activeThread) && pendingUserInputs.length === 0 && !isComposerApprovalState,
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

  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;

    composerFormHeightRef.current = composerForm.getBoundingClientRect().height;
    setIsComposerFooterCompact(
      shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      }),
    );
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const [entry] = entries;
      if (!entry) return;

      const nextCompact = shouldUseCompactComposerFooter(measureComposerFormWidth(), {
        hasWideActions: composerFooterHasWideActions,
      });
      setIsComposerFooterCompact((previous) => (previous === nextCompact ? previous : nextCompact));

      const nextHeight = entry.contentRect.height;
      const previousHeight = composerFormHeightRef.current;
      composerFormHeightRef.current = nextHeight;

      onComposerHeightChange(previousHeight, nextHeight);
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThread?.id, composerFooterHasWideActions, onComposerHeightChange]);

  useEffect(() => {
    setExpandedWorkGroups({});
    setPullRequestDialogState(null);
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
    if (!activeThread?.id || terminalState.terminalOpen) return;
    const frame = window.requestAnimationFrame(() => {
      focusComposer();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeThread?.id, focusComposer, terminalState.terminalOpen]);

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

  useEffect(() => {
    setSelectedComposerSkills((existing) =>
      existing.filter((skill) => promptIncludesSkillMention(prompt, skill.name, selectedProvider)),
    );
  }, [prompt, selectedProvider]);

  useEffect(() => {
    setSelectedComposerMentions((existing) => {
      const nextMentions = resolvePromptPluginMentions({
        prompt,
        existingMentions: existing,
        providerPlugins,
      });
      return providerMentionReferencesEqual(existing, nextMentions) ? existing : nextMentions;
    });
  }, [prompt, providerPlugins]);

  // Clear selected skills when switching providers — skills are provider-specific.
  useEffect(() => {
    setSelectedComposerSkills([]);
    setSelectedComposerMentions([]);
  }, [selectedProvider]);

  useEffect(() => {
    voiceTranscriptionRequestIdRef.current += 1;
    voiceRecordingStartedAtRef.current = null;
    void cancelVoiceRecording();
    setIsVoiceTranscribing(false);
    setOptimisticUserMessages((existing) => {
      for (const message of existing) {
        revokeUserMessagePreviewUrls(message);
      }
      return [];
    });
    setLocalDispatch(null);
    setComposerHighlightedItemId(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    setSelectedComposerSkills([]);
    setSelectedComposerMentions([]);
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
      const useMetaForMod = isMacPlatform(navigator.platform);
      const composerPickerShortcutActive =
        !isTerminalFocused() &&
        !isVoiceRecording &&
        !isVoiceTranscribing &&
        !isComposerApprovalState &&
        canHandleComposerPickerShortcut(event, composerFormRef.current);
      if (
        composerPickerShortcutActive &&
        event.shiftKey &&
        !event.altKey &&
        event.metaKey === useMetaForMod &&
        event.ctrlKey === !useMetaForMod
      ) {
        const normalizedKey = event.key.toLowerCase();
        if (normalizedKey === "m") {
          event.preventDefault();
          event.stopPropagation();
          handleModelPickerOpenChange(true);
          scheduleComposerFocus();
          return;
        }
        if (normalizedKey === "e") {
          event.preventDefault();
          event.stopPropagation();
          handleTraitsPickerOpenChange(true);
          scheduleComposerFocus();
          return;
        }
      }
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
  const addComposerImages = (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;

    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }

    const nextImages: ComposerImageAttachment[] = [];
    let nextAttachmentCount =
      composerImagesRef.current.length + composerAssistantSelectionsRef.current.length;
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        error = `'${file.name}' exceeds the ${IMAGE_SIZE_LIMIT_LABEL} attachment limit.`;
        continue;
      }
      if (nextAttachmentCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} references per message.`;
        break;
      }

      const previewUrl = URL.createObjectURL(file);
      nextImages.push({
        type: "image",
        id: randomUUID(),
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl,
        file,
      });
      nextAttachmentCount += 1;
    }

    if (nextImages.length === 1 && nextImages[0]) {
      addComposerImage(nextImages[0]);
    } else if (nextImages.length > 1) {
      addComposerImagesToDraft(nextImages);
    }
    setThreadError(activeThreadId, error);
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) {
      return;
    }
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    addComposerImages(imageFiles);
  };

  const onComposerDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOverComposer(true);
  };

  const onComposerDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOverComposer(true);
  };

  const onComposerDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOverComposer(false);
    }
  };

  const onComposerDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOverComposer(false);
    const files = Array.from(event.dataTransfer.files);
    addComposerImages(files);
    focusComposer();
  };

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
        const targetStatus =
          providerStatuses.find((status) => status.provider === targetProvider) ?? null;
        if (!isProviderUsable(targetStatus)) {
          toastManager.add({
            type: "error",
            title: providerUnavailableReason(targetStatus),
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
      setSelectedComposerSkills([]);
      setSelectedComposerMentions([]);
      setComposerHighlightedItemId(null);
      setComposerCursor(0);
      setComposerTrigger(null);
    },
    [clearComposerDraftContent],
  );

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
      const restoredImages =
        queuedTurn.kind === "chat" ? queuedTurn.images.map(cloneComposerImageForRetry) : [];
      const restoredAssistantSelections =
        queuedTurn.kind === "chat" ? queuedTurn.assistantSelections : [];
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
        if (queuedTurn.terminalContexts.length > 0) {
          addComposerTerminalContextsToDraft(queuedTurn.terminalContexts);
        }
        setSelectedComposerSkills(queuedTurn.skills);
        setSelectedComposerMentions(queuedTurn.mentions);
      } else {
        setSelectedComposerSkills([]);
        setSelectedComposerMentions([]);
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
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      clearComposerDraftContent,
      scheduleComposerFocus,
      setDraftThreadContext,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
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
      onAdvanceActivePendingUserInput();
      return true;
    }
    const queuedChatTurn = queuedTurn ?? null;
    const liveComposerSnapshot =
      queuedChatTurn === null ? (composerEditorRef.current?.readSnapshot() ?? null) : null;
    const promptForSend =
      queuedChatTurn?.prompt ?? liveComposerSnapshot?.value ?? promptRef.current;
    let composerImagesForSend = queuedChatTurn?.images ?? composerImages;
    const composerAssistantSelectionsForSend =
      queuedChatTurn?.assistantSelections ?? composerAssistantSelections;
    const composerTerminalContextsForSend =
      queuedChatTurn?.terminalContexts ?? composerTerminalContexts;
    const selectedComposerSkillsForSend = queuedChatTurn?.skills ?? selectedComposerSkills;
    const selectedComposerMentionsForSend = queuedChatTurn?.mentions ?? selectedComposerMentions;
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
      terminalContexts: composerTerminalContextsForSend,
    });
    if (showPlanFollowUpPrompt && activeProposedPlan) {
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
        }),
        prompt: promptForSend,
        images: queuedImagesForPersistence,
        assistantSelections: composerAssistantSelectionsForSend,
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
    const firstSendTarget = resolveFirstSendTarget({
      activeProject,
      isFirstMessage,
      isHomeChatContainer,
      projects: useStore.getState().projects,
      selectedWorkspaceRoot: isHomeChatContainer ? (resolvedThreadWorktreePath ?? null) : null,
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
        const createdAt = new Date().toISOString();
        try {
          await api.orchestration.dispatchCommand({
            type: "project.create",
            commandId: newCommandId(),
            projectId,
            kind: "project",
            title: firstSendTarget.creation.title,
            workspaceRoot: firstSendTarget.creation.workspaceRoot,
            defaultModelSelection: firstSendTarget.creation.defaultModelSelection,
            createdAt,
          });
          targetProjectIdForSend = projectId;
          targetProjectKindForSend = "project";
          targetProjectCwdForSend = firstSendTarget.creation.workspaceRoot;
          targetProjectScriptsForSend = [];
          targetProjectDefaultModelSelectionForSend =
            firstSendTarget.creation.defaultModelSelection;
        } catch (error) {
          const description =
            error instanceof Error ? error.message : "Failed to create the selected project.";
          // If the server already knows this workspace root, reuse that project and continue.
          const { snapshot, project: recoveredProject } =
            await waitForRecoverableProjectForDuplicateCreate({
              message: description,
              workspaceRoot: firstSendTarget.creation.workspaceRoot,
              loadSnapshot: () => api.orchestration.getSnapshot().catch(() => null),
            });
          if (!snapshot || !recoveredProject) {
            throw error;
          }

          syncServerReadModel(snapshot);
          targetProjectIdForSend = recoveredProject.id;
          targetProjectKindForSend = "project";
          targetProjectCwdForSend = recoveredProject.workspaceRoot;
          targetProjectScriptsForSend = [...recoveredProject.scripts];
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
    const composerTerminalContextsSnapshot = [...sendableComposerTerminalContexts];
    const composerSkillsSnapshot = [...selectedComposerSkillsForSend];
    const composerMentionsSnapshot = [...selectedComposerMentionsForSend];
    const messageTextForSend = appendTerminalContextsToPrompt(
      appendAssistantSelectionsToPrompt(promptForSend, composerAssistantSelectionsSnapshot),
      composerTerminalContextsSnapshot,
    );
    const messageIdForSend = newMessageId();
    const messageCreatedAt = new Date().toISOString();
    const outgoingMessageText = formatOutgoingPrompt({
      provider: selectedProviderForSend,
      model: selectedModelForSend,
      effort: selectedPromptEffortForSend,
      text: messageTextForSend || IMAGE_ONLY_BOOTSTRAP_PROMPT,
    });
    const mentionedSkillsForSend = selectedComposerSkillsForSend.filter((skill) =>
      promptIncludesSkillMention(outgoingMessageText, skill.name, selectedProviderForSend),
    );
    const mentionedPluginMentionsForSend = resolvePromptPluginMentions({
      prompt: outgoingMessageText,
      existingMentions: selectedComposerMentionsForSend,
      providerPlugins,
    });
    const turnAttachmentsPromise = Promise.all([
      ...composerAssistantSelectionsSnapshot.map((selection) =>
        Promise.resolve({
          type: "assistant-selection" as const,
          assistantMessageId: MessageId.makeUnsafe(selection.assistantMessageId),
          text: selection.text,
        }),
      ),
      ...composerImagesSnapshot.map(async (image) => ({
        type: "image" as const,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
        dataUrl: await readFileAsDataUrl(image.file),
      })),
    ]);
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
        createdAt: messageCreatedAt,
        streaming: false,
        source: "native",
      },
    ]);
    // Sending a message should always bring the latest user turn into view.
    forceStickToBottom();

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

      let firstComposerImageName: string | null = null;
      if (composerImagesSnapshot.length > 0) {
        const firstComposerImage = composerImagesSnapshot[0];
        if (firstComposerImage) {
          firstComposerImageName = firstComposerImage.name;
        }
      }
      let titleSeed = trimmed;
      if (!titleSeed) {
        if (firstComposerImageName) {
          titleSeed = `Image: ${firstComposerImageName}`;
        } else if (composerAssistantSelectionsSnapshot.length > 0) {
          titleSeed = formatAssistantSelectionTitleSeed(composerAssistantSelectionsSnapshot.length);
        } else if (composerTerminalContextsSnapshot.length > 0) {
          titleSeed = formatTerminalContextLabel(composerTerminalContextsSnapshot[0]!);
        } else {
          titleSeed = GENERIC_CHAT_THREAD_TITLE;
        }
      }
      // Keep the optimistic label short while the server asks Codex for a better summary.
      const title = buildPromptThreadTitleFallback(titleSeed);
      const threadCreateModelSelection: ModelSelection = buildModelSelection(
        selectedProviderForSend,
        selectedModelForSend ||
          targetProjectDefaultModelSelectionForSend?.model ||
          DEFAULT_MODEL_BY_PROVIDER.codex,
        selectedModelSelectionForSend.options,
      );

      if (isLocalDraftThread) {
        await api.orchestration.dispatchCommand({
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
        });
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
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
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
        addComposerImagesToDraft(composerImagesSnapshot.map(cloneComposerImageForRetry));
        for (const selection of composerAssistantSelectionsSnapshot) {
          addComposerAssistantSelectionToDraft(selection);
        }
        addComposerTerminalContextsToDraft(composerTerminalContextsSnapshot);
        setSelectedComposerSkills(composerSkillsSnapshot);
        setSelectedComposerMentions(composerMentionsSnapshot);
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
    [activeThreadId, setStoreThreadError],
  );

  const onRespondToUserInput = useCallback(
    async (requestId: ApprovalRequestId, answers: Record<string, unknown>) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;

      setRespondingUserInputRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      await api.orchestration
        .dispatchCommand({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          answers,
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
        return;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return;
      }
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: togglePendingUserInputOptionSelection(
            question,
            existing[activePendingUserInput.requestId]?.[questionId],
            optionLabel,
          ),
        },
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
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
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInput.requestId]: {
          ...existing[activePendingUserInput.requestId],
          [questionId]: setPendingUserInputCustomAnswer(
            existing[activePendingUserInput.requestId]?.[questionId],
            value,
          ),
        },
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [activePendingUserInput],
  );

  const onAdvanceActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || !activePendingProgress) {
      return;
    }
    if (activePendingProgress.isLastQuestion) {
      if (activePendingResolvedAnswers) {
        void onRespondToUserInput(activePendingUserInput.requestId, activePendingResolvedAnswers);
      }
      return;
    }
    setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingUserInput,
    onRespondToUserInput,
    setActivePendingUserInputQuestionIndex,
  ]);

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
    const outgoingMessageText = formatOutgoingPrompt({
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
    forceStickToBottom();

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
        modelSelection: queuedTurn?.modelSelection ?? selectedModelSelection,
        ...((queuedTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch)
          ? {
              providerOptions: queuedTurn?.providerOptionsForDispatch ?? providerOptionsForDispatch,
            }
          : {}),
        assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
        dispatchMode,
        runtimeMode: queuedTurn?.runtimeMode ?? runtimeMode,
        interactionMode: nextInteractionMode,
        ...(nextInteractionMode === "default" && activeProposedPlan
          ? {
              sourceProposedPlan: {
                threadId: activeThread.id,
                planId: activeProposedPlan.id,
              },
            }
          : {}),
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
    const outgoingImplementationPrompt = formatOutgoingPrompt({
      provider: selectedProvider,
      model: selectedModel,
      effort: selectedPromptEffort,
      text: implementationPrompt,
    });
    const nextThreadTitle = truncateTitle(buildPlanImplementationThreadTitle(planMarkdown));
    const nextThreadModelSelection: ModelSelection = selectedModelSelection;

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
          assistantDeliveryMode: settings.enableAssistantStreaming ? "streaming" : "buffered",
          dispatchMode: "queue",
          runtimeMode,
          interactionMode: "default",
          createdAt,
        });
      })
      .then(() => api.orchestration.getSnapshot())
      .then((snapshot) => {
        syncServerReadModel(snapshot);
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
          .getSnapshot()
          .then((snapshot) => {
            syncServerReadModel(snapshot);
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
    selectedProvider,
    settings.enableAssistantStreaming,
    syncServerReadModel,
    selectedModel,
  ]);

  const onProviderModelSelect = useCallback(
    (provider: ProviderKind, model: ModelSlug) => {
      if (!activeThread) return;
      if (lockedProvider !== null && provider !== lockedProvider) {
        scheduleComposerFocus();
        return;
      }
      const resolvedModel = resolveAppModelSelection(provider, customModelsByProvider, model);
      const nextModelSelection: ModelSelection = {
        provider,
        model: resolvedModel,
      };
      setComposerDraftModelSelection(activeThread.id, nextModelSelection);
      setStickyComposerModelSelection(nextModelSelection);
      scheduleComposerFocus();
    },
    [
      activeThread,
      lockedProvider,
      scheduleComposerFocus,
      setComposerDraftModelSelection,
      setStickyComposerModelSelection,
      customModelsByProvider,
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
  );
  const contextWindowSelectionStatus = useMemo(
    () =>
      deriveContextWindowSelectionStatus({
        activeSnapshot: activeContextWindow,
        selectedValue:
          selectedProvider === "claudeAgent" ? composerTraitSelection.contextWindow : null,
      }),
    [activeContextWindow, composerTraitSelection.contextWindow, selectedProvider],
  );
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    threadId,
    model: selectedModel,
    modelOptions: selectedProviderModelOptions,
    prompt,
    includeFastMode: false,
    open: isTraitsPickerOpen,
    onOpenChange: handleTraitsPickerOpenChange,
    shortcutLabel: traitsPickerShortcutLabel,
    onPromptChange: setPromptFromTraits,
  });
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
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInput.requestId]: {
            ...existing[activePendingUserInput.requestId],
            [activePendingQuestion.id]: setPendingUserInputCustomAnswer(
              existing[activePendingUserInput.requestId]?.[activePendingQuestion.id],
              next.text,
            ),
          },
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
      selectedProvider === "codex" &&
      isServerThread &&
      activeThread?.session !== null &&
      activeThread?.session?.status !== "closed",
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
    syncServerReadModel,
    navigateToThread: (nextThreadId) =>
      navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
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
            setSelectedComposerSkills((existing) => {
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
          base: `@${item.plugin.name} `,
          onApplied: () => {
            setSelectedComposerMentions((existing) => {
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
      setSelectedComposerMentions,
      setSelectedComposerSkills,
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
      (providerCommandsQuery.isLoading || providerCommandsQuery.isFetching));

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
        clearComposerSlashDraft();
        return true;
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
  const onToggleWorkGroup = useCallback((groupId: string) => {
    setExpandedWorkGroups((existing) => ({
      ...existing,
      [groupId]: !existing[groupId],
    }));
  }, []);
  const onExpandTimelineImage = useCallback((preview: ExpandedImagePreview) => {
    setExpandedImage(preview);
  }, []);
  const expandedImageItem = expandedImage ? expandedImage.images[expandedImage.index] : null;
  const onScrollToBottom = useCallback(() => {
    forceStickToBottom("smooth");
  }, [forceStickToBottom]);
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
  const onNavigateToThread = useCallback(
    (nextThreadId: ThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: nextThreadId },
        search: (previous) => stripDiffSearchParams(previous),
      });
    },
    [navigate],
  );
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

  // Empty state: no active thread
  if (!activeThread) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-muted-foreground/40">
        {!isElectron && (
          <header className="border-b border-border px-3 py-2 md:hidden">
            <div className="flex items-center gap-2">
              <SidebarHeaderTrigger className="size-7 shrink-0" />
              <span className="text-sm font-medium text-foreground">Threads</span>
            </div>
          </header>
        )}
        {isElectron && (
          <div
            className={cn(
              "drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5",
              settings.sidebarSide === "right" && "pl-[90px]",
            )}
          >
            <SidebarHeaderTrigger className="size-7 shrink-0" />
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

  const branchToolbarProps = {
    threadId: activeThread.id,
    onEnvModeChange,
    envLocked,
    runtimeMode,
    onRuntimeModeChange: handleRuntimeModeChange,
    onHandoffToWorktree,
    onHandoffToLocal,
    handoffBusy,
    onComposerFocusRequest: scheduleComposerFocus,
    contextWindow: activeContextWindow,
    cumulativeCostUsd: activeCumulativeCostUsd,
    activeContextWindowLabel: contextWindowSelectionStatus.activeLabel,
    pendingContextWindowLabel: contextWindowSelectionStatus.pendingSelectedLabel,
    ...(canCheckoutPullRequestIntoThread
      ? { onCheckoutPullRequestRequest: openPullRequestDialog }
      : {}),
  };

  const accessModeToggleButton =
    !showPlanFollowUpPrompt &&
    !activePendingProgress &&
    !isVoiceRecording &&
    !isVoiceTranscribing ? (
      <button
        type="button"
        className="inline-flex h-7 shrink-0 self-center items-center gap-1 rounded px-1.5 py-0.5 text-[length:var(--app-font-size-ui-xs,10px)] font-normal text-muted-foreground/70 transition-colors hover:text-foreground/80 disabled:opacity-50 sm:h-8"
        onClick={() =>
          handleRuntimeModeChange(
            runtimeMode === "full-access" ? "approval-required" : "full-access",
          )
        }
        disabled={isConnecting || isSendBusy || phase === "running"}
        title={
          runtimeMode === "full-access"
            ? "Full access — click to require approvals"
            : "Ask every action"
        }
      >
        {runtimeMode === "full-access" ? (
          <FiThumbsUp className="size-3 shrink-0" />
        ) : (
          <HiOutlineHandRaised className="size-3 shrink-0" />
        )}
        <span className="leading-none">
          {runtimeMode === "full-access" ? "Full access" : "Default permissions"}
        </span>
      </button>
    ) : null;

  const planCardAboveComposer = Boolean(activePlan && !planSidebarOpen);

  const composerSection = (
    <>
      {activePlan && !planSidebarOpen ? (
        <div className="mx-auto w-full max-w-3xl">
          <div className="mx-auto w-11/12">
            <ActivePlanCard
              activePlan={activePlan}
              backgroundTaskCount={activeBackgroundTasks?.activeCount ?? 0}
              onOpenSidebar={() => setPlanSidebarOpen(true)}
            />
          </div>
        </div>
      ) : null}
      <form
        ref={composerFormRef}
        onSubmit={onSend}
        className="relative z-10 mx-auto w-full min-w-0 max-w-3xl"
        data-chat-composer-form="true"
        data-chat-pane-scope={paneScopeId}
      >
        {queuedComposerTurns.length > 0 ? (
          <div className="mx-auto flex w-11/12 flex-col">
            {queuedComposerTurns.map((queuedTurn, queuedTurnIndex) => (
              <div
                key={queuedTurn.id}
                data-testid="queued-follow-up-row"
                className={cn(
                  "chat-composer-surface flex items-center gap-2 border border-b-0 border-border/75 bg-card px-2.5 py-2 text-[12px]",
                  queuedTurnIndex === 0 && !planCardAboveComposer
                    ? "rounded-t-2xl"
                    : "rounded-none",
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <QueueArrow className="size-3 shrink-0 text-muted-foreground/70" />
                  <span className="truncate text-[12px] font-medium text-foreground/85">
                    {queuedTurn.previewText}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-0">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-lg bg-muted/80 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                    onClick={() => void onSteerQueuedComposerTurn(queuedTurn)}
                  >
                    <PiArrowBendDownRight className="size-3" />
                    <span>Steer</span>
                  </button>
                  <button
                    type="button"
                    className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                    aria-label="Delete queued follow-up"
                    onClick={() => removeQueuedComposerTurn(queuedTurn.id)}
                  >
                    <Trash2 className="size-3" />
                  </button>
                  <Menu>
                    <MenuTrigger
                      render={
                        <button
                          type="button"
                          className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                          aria-label="Queued follow-up actions"
                        />
                      }
                    >
                      <EllipsisIcon className="size-3" />
                    </MenuTrigger>
                    <MenuPopup align="end" side="top">
                      <MenuItem onClick={() => onEditQueuedComposerTurn(queuedTurn)}>
                        Edit queued prompt
                      </MenuItem>
                      <MenuItem onClick={() => removeQueuedComposerTurn(queuedTurn.id)}>
                        Delete queued prompt
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        <div
          className={cn(
            "group rounded-3xl p-px transition-colors duration-200",
            composerProviderState.composerFrameClassName,
          )}
          onDragEnter={onComposerDragEnter}
          onDragOver={onComposerDragOver}
          onDragLeave={onComposerDragLeave}
          onDrop={onComposerDrop}
        >
          <div
            className={cn(
              "chat-composer-surface rounded-2xl border bg-card transition-colors duration-200 focus-within:border-neutral-500/15",
              isDragOverComposer ? "border-primary/50 bg-accent/20" : "border-border/75",
              composerProviderState.composerSurfaceClassName,
            )}
          >
            {activePendingApproval ? (
              <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
              </div>
            ) : pendingUserInputs.length > 0 ? (
              <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onToggleActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
              </div>
            ) : showPlanFollowUpPrompt && activeProposedPlan ? (
              <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                <ComposerPlanFollowUpBanner
                  key={activeProposedPlan.id}
                  planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                />
              </div>
            ) : null}
            <div className={cn("relative px-3.5 pb-1 pt-3")}>
              {composerMenuOpen && !isComposerApprovalState && (
                <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
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
              )}

              {!isComposerApprovalState &&
                pendingUserInputs.length === 0 &&
                (composerAssistantSelections.length > 0 || composerImages.length > 0) && (
                  <ComposerReferenceAttachments
                    assistantSelections={composerAssistantSelections}
                    images={composerImages}
                    nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                    onExpandImage={setExpandedImage}
                    onRemoveAssistantSelections={clearComposerAssistantSelectionsFromDraft}
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
                onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                onChange={onPromptChange}
                onCommandKeyDown={onComposerCommandKey}
                onPaste={onComposerPaste}
                placeholder={
                  isComposerApprovalState
                    ? "Resolve this approval request to continue"
                    : activePendingProgress
                      ? "Type your own answer, or leave this blank to use the selected option"
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
              <div className="flex items-center justify-end gap-2 px-3 pb-2">
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
                  "flex items-end justify-between px-2.5 pb-2",
                  isComposerFooterCompact ? "gap-1.5" : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                )}
              >
                <div
                  className={cn(
                    "flex items-center",
                    isVoiceRecording || isVoiceTranscribing
                      ? "min-w-0 shrink-0 gap-1"
                      : isComposerFooterCompact
                        ? "min-w-0 flex-1 gap-1 overflow-hidden"
                        : "-m-1 min-w-0 flex-1 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                  )}
                >
                  <ComposerExtrasMenu
                    interactionMode={interactionMode}
                    supportsFastMode={composerTraitSelection.caps.supportsFastMode}
                    fastModeEnabled={composerTraitSelection.fastModeEnabled}
                    onAddPhotos={addComposerImages}
                    onToggleFastMode={toggleFastMode}
                    onSetPlanMode={setPlanMode}
                  />

                  {!isVoiceRecording && !isVoiceTranscribing ? (
                    <>
                      <ProviderModelPicker
                        compact={isComposerFooterCompact}
                        provider={selectedProvider}
                        model={selectedModelForPickerWithCustomFallback}
                        lockedProvider={lockedProvider}
                        providers={providerStatuses}
                        modelOptionsByProvider={modelOptionsByProvider}
                        open={isModelPickerOpen}
                        onOpenChange={handleModelPickerOpenChange}
                        shortcutLabel={modelPickerShortcutLabel}
                        {...(composerProviderState.modelPickerIconClassName
                          ? {
                              activeProviderIconClassName:
                                composerProviderState.modelPickerIconClassName,
                            }
                          : {})}
                        onProviderModelChange={onProviderModelSelect}
                      />

                      {providerTraitsPicker ? (
                        <>
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />
                          {providerTraitsPicker}
                        </>
                      ) : null}

                      {interactionMode === "plan" ? (
                        <>
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-blue-400 hover:text-blue-300 sm:px-3"
                            size="sm"
                            type="button"
                            onClick={toggleInteractionMode}
                            title="Plan mode — click to return to normal chat mode"
                          >
                            <GoTasklist className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">Plan</span>
                          </Button>
                        </>
                      ) : null}

                      {activePlan || sidebarProposedPlan || planSidebarOpen ? (
                        <>
                          <Separator
                            orientation="vertical"
                            className="mx-0.5 hidden h-4 sm:block"
                          />
                          <Button
                            variant="ghost"
                            className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                            size="sm"
                            type="button"
                            onClick={togglePlanSidebar}
                            title={
                              planSidebarOpen
                                ? `Hide ${planSidebarLabel.toLowerCase()} sidebar`
                                : `Show ${planSidebarLabel.toLowerCase()} sidebar`
                            }
                          >
                            <GoTasklist className="size-3.5" />
                            <span className="sr-only sm:not-sr-only">
                              {planSidebarOpen ? `Hide ${planSidebarLabel}` : planSidebarLabel}
                            </span>
                          </Button>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>

                <div
                  data-chat-composer-actions="right"
                  className={cn(
                    "flex gap-2",
                    isVoiceRecording || isVoiceTranscribing ? "items-center" : "items-end",
                    isVoiceRecording || isVoiceTranscribing ? "min-w-0 flex-1" : "shrink-0",
                  )}
                >
                  {isPreparingWorktree ? (
                    <span className="text-muted-foreground/70 text-xs">Preparing worktree...</span>
                  ) : null}
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
                    <button
                      type="button"
                      className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-all duration-150 hover:scale-105 sm:h-[26px] sm:w-[26px]"
                      onClick={() => void onInterrupt()}
                      aria-label="Stop generation"
                      title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                    >
                      <span aria-hidden="true" className="block size-2 rounded-[2px] bg-current" />
                    </button>
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
                        {accessModeToggleButton}
                        {showVoiceNotesControl ? (
                          <ComposerVoiceButton
                            disabled={isComposerApprovalState || isConnecting || isSendBusy}
                            isRecording={isVoiceRecording}
                            isTranscribing={isVoiceTranscribing}
                            durationLabel={voiceRecordingDurationLabel}
                            onClick={toggleComposerVoiceRecording}
                          />
                        ) : null}
                        <button
                          type="submit"
                          className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background transition-all duration-150 hover:scale-105 disabled:opacity-20 disabled:hover:scale-100 sm:h-8 sm:w-8"
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
                              width="14"
                              height="14"
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
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </button>
                      </>
                    )
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </div>
      </form>
      {isEmptyChatLanding ? (
        <div className="mt-2 flex w-full items-center justify-start px-3">
          <ProjectPicker
            align="start"
            side="top"
            showResetToHome={Boolean(resolvedThreadWorktreePath)}
            selectedWorkspaceRoot={resolvedThreadWorktreePath}
            onSelectWorkspaceRoot={handleSelectWorkspaceRoot}
            onResetToHome={handleResetWorkspaceToHome}
          />
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Top bar */}
      <header
        className={cn(
          "border-b border-border px-3 sm:px-5",
          isElectron ? "drag-region flex h-[52px] items-center" : "py-2 sm:py-3",
          isElectron && settings.sidebarSide === "right" && "pl-[90px] sm:pl-[90px]",
        )}
      >
        <ChatHeader
          activeThreadId={activeThread.id}
          activeThreadTitle={activeThreadDisplayTitle}
          activeProjectName={activeProjectDisplayName}
          threadBreadcrumbs={threadBreadcrumbs}
          hideHandoffControls={terminalWorkspaceTerminalTabActive}
          isGitRepo={isGitRepo}
          openInCwd={threadWorkspaceCwd}
          activeProjectScripts={activeProjectScripts}
          preferredScriptId={
            activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
          }
          keybindings={keybindings}
          availableEditors={availableEditors}
          terminalAvailable={activeProject !== undefined}
          terminalOpen={terminalState.terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          browserToggleShortcutLabel={browserPanelShortcutLabel}
          diffToggleShortcutLabel={diffPanelShortcutLabel}
          handoffBadgeLabel={handoffBadgeLabel}
          handoffActionLabel={handoffActionLabel}
          handoffDisabled={handoffDisabled}
          handoffActionTargetProviders={handoffTargetProviders}
          handoffBadgeSourceProvider={handoffBadgeSourceProvider}
          handoffBadgeTargetProvider={handoffBadgeTargetProvider}
          browserOpen={resolvedBrowserOpen}
          gitCwd={threadWorkspaceCwd}
          showGitActions={showGitActions}
          diffOpen={resolvedDiffOpen}
          diffDisabledReason={diffDisabledReason}
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
          onRunProjectScript={onRunProjectScriptFromHeader}
          onAddProjectScript={saveProjectScript}
          onUpdateProjectScript={updateProjectScript}
          onDeleteProjectScript={deleteProjectScript}
          onToggleTerminal={toggleTerminalVisibility}
          onToggleDiff={onToggleDiff}
          onToggleBrowser={onToggleBrowser}
          onCreateHandoff={onCreateHandoffThread}
          onNavigateToThread={onNavigateToThread}
          onRenameThread={() => setRenameDialogOpen(true)}
        />
      </header>

      <RenameThreadDialog
        open={renameDialogOpen}
        currentTitle={activeThread.title}
        onOpenChange={setRenameDialogOpen}
        onSave={handleRenameActiveThread}
      />

      {/* Error banner */}
      <ProviderHealthBanner status={activeProviderStatus} />
      <ThreadErrorBanner error={activeThread.error} onDismiss={dismissActiveThreadError} />
      <RateLimitBanner rateLimitStatus={activeRateLimitStatus} />
      {terminalWorkspaceOpen ? (
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
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div
            aria-hidden={terminalWorkspaceTerminalTabActive}
            className={cn(
              "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              terminalWorkspaceTerminalTabActive ? "pointer-events-none invisible" : "",
            )}
          >
            {isCenteredEmptyLanding ? (
              <div className="chat-pane-enter flex flex-1 items-center justify-center px-3 sm:px-5">
                <div className="flex w-full max-w-3xl flex-col justify-center">
                  <div className="flex flex-col items-center gap-4 px-6 pb-5 text-center select-none">
                    <img
                      alt="DP Code logo"
                      className="size-12 rounded-lg object-contain"
                      draggable={false}
                      height={96}
                      src="/dpcode-hero.png"
                      width={96}
                    />
                    <h2 className="text-[26px] font-normal leading-[1.15] tracking-[-0.015em] text-foreground/95 sm:text-[30px]">
                      {isEmptyChatLanding ? (
                        "What should we work on?"
                      ) : (
                        <>
                          What should we do in{" "}
                          <span className="text-muted-foreground/45">
                            {activeProjectDisplayName ?? "this folder"}
                          </span>
                          ?
                        </>
                      )}
                    </h2>
                  </div>
                  {composerSection}
                </div>
              </div>
            ) : (
              <ChatTranscriptPane
                activeThreadId={activeThread.id}
                hasMessages={timelineEntries.length > 0}
                isWorking={isWorking}
                activeTurnInProgress={activeTurnInProgress}
                activeTurnStartedAt={activeWorkStartedAt}
                messagesScrollElement={messagesScrollElement}
                setMessagesBottomAnchorRef={setMessagesBottomAnchorRef}
                setMessagesScrollContainerRef={setMessagesScrollContainerRef}
                timelineEntries={timelineEntries}
                completionDividerBeforeEntryId={completionDividerBeforeEntryId}
                completionSummary={completionSummary}
                turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
                expandedWorkGroups={expandedWorkGroups}
                onToggleWorkGroup={onToggleWorkGroup}
                onOpenTurnDiff={onOpenTurnDiff}
                onOpenThread={onNavigateToThread}
                revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
                onRevertUserMessage={onRevertUserMessage}
                isRevertingCheckpoint={isRevertingCheckpoint}
                onExpandTimelineImage={onExpandTimelineImage}
                followLiveOutput={hasStreamingAssistantText}
                onLiveContentHeightChange={onLiveContentHeightChange}
                markdownCwd={threadWorkspaceCwd ?? undefined}
                resolvedTheme={resolvedTheme}
                chatFontSizePx={settings.chatFontSizePx}
                timestampFormat={timestampFormat}
                workspaceRoot={activeProject?.cwd ?? undefined}
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
                scrollButtonVisible={showScrollToBottom}
                onScrollToBottom={onScrollToBottom}
              />
            )}

            {/* Input bar */}
            {!isCenteredEmptyLanding ? (
              <>
                <div
                  className={cn(
                    "chat-pane-enter px-3 pt-0 sm:px-5 sm:pt-0",
                    isGitRepo ? "pb-1" : "pb-2.5 sm:pb-3",
                  )}
                >
                  {activePlan && !planSidebarOpen ? (
                    <div className="mx-auto w-full max-w-3xl">
                      <div className="mx-auto w-11/12">
                        <ActivePlanCard
                          activePlan={activePlan}
                          backgroundTaskCount={activeBackgroundTasks?.activeCount ?? 0}
                          onOpenSidebar={() => setPlanSidebarOpen(true)}
                        />
                      </div>
                    </div>
                  ) : null}
                  <form
                    ref={composerFormRef}
                    onSubmit={onSend}
                    className="relative z-10 mx-auto w-full min-w-0 max-w-3xl"
                    data-chat-composer-form="true"
                    data-chat-pane-scope={paneScopeId}
                  >
                    {queuedComposerTurns.length > 0 ? (
                      <div className="mx-auto flex w-11/12 flex-col">
                        {queuedComposerTurns.map((queuedTurn, queuedTurnIndex) => (
                          <div
                            key={queuedTurn.id}
                            data-testid="queued-follow-up-row"
                            className={cn(
                              "chat-composer-surface flex items-center gap-2 border border-b-0 border-border/75 bg-card px-2.5 py-2 text-[12px]",
                              queuedTurnIndex === 0 && !planCardAboveComposer
                                ? "rounded-t-2xl"
                                : "rounded-none",
                            )}
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-1.5">
                              <QueueArrow className="size-3 shrink-0 text-muted-foreground/70" />
                              <span className="truncate text-[12px] font-medium text-foreground/85">
                                {queuedTurn.previewText}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-0">
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-lg bg-muted/80 px-2 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
                                onClick={() => void onSteerQueuedComposerTurn(queuedTurn)}
                              >
                                <PiArrowBendDownRight className="size-3" />
                                <span>Steer</span>
                              </button>
                              <button
                                type="button"
                                className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                                aria-label="Delete queued follow-up"
                                onClick={() => removeQueuedComposerTurn(queuedTurn.id)}
                              >
                                <Trash2 className="size-3" />
                              </button>
                              <Menu>
                                <MenuTrigger
                                  render={
                                    <button
                                      type="button"
                                      className="inline-flex size-6 items-center justify-center rounded-lg text-muted-foreground/70 transition-colors hover:bg-muted/60 hover:text-foreground"
                                      aria-label="Queued follow-up actions"
                                    />
                                  }
                                >
                                  <EllipsisIcon className="size-3" />
                                </MenuTrigger>
                                <MenuPopup align="end" side="top">
                                  <MenuItem onClick={() => onEditQueuedComposerTurn(queuedTurn)}>
                                    Edit queued prompt
                                  </MenuItem>
                                  <MenuItem onClick={() => removeQueuedComposerTurn(queuedTurn.id)}>
                                    Delete queued prompt
                                  </MenuItem>
                                </MenuPopup>
                              </Menu>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <div
                      className={cn(
                        "group rounded-3xl p-px transition-colors duration-200",
                        composerProviderState.composerFrameClassName,
                      )}
                      onDragEnter={onComposerDragEnter}
                      onDragOver={onComposerDragOver}
                      onDragLeave={onComposerDragLeave}
                      onDrop={onComposerDrop}
                    >
                      <div
                        className={cn(
                          "chat-composer-surface rounded-2xl border bg-card transition-colors duration-200 focus-within:border-neutral-500/15",
                          isDragOverComposer
                            ? "border-primary/50 bg-accent/20"
                            : "border-border/75",
                          composerProviderState.composerSurfaceClassName,
                        )}
                      >
                        {activePendingApproval ? (
                          <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                            <ComposerPendingApprovalPanel
                              approval={activePendingApproval}
                              pendingCount={pendingApprovals.length}
                            />
                          </div>
                        ) : pendingUserInputs.length > 0 ? (
                          <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                            <ComposerPendingUserInputPanel
                              pendingUserInputs={pendingUserInputs}
                              respondingRequestIds={respondingRequestIds}
                              answers={activePendingDraftAnswers}
                              questionIndex={activePendingQuestionIndex}
                              onToggleOption={onToggleActivePendingUserInputOption}
                              onAdvance={onAdvanceActivePendingUserInput}
                            />
                          </div>
                        ) : showPlanFollowUpPrompt && activeProposedPlan ? (
                          <div className="rounded-t-[23px] border-b border-border/65 bg-muted/20">
                            <ComposerPlanFollowUpBanner
                              key={activeProposedPlan.id}
                              planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
                            />
                          </div>
                        ) : null}
                        <div className={cn("relative px-3.5 pb-1 pt-3")}>
                          {composerMenuOpen && !isComposerApprovalState && (
                            <div className="absolute inset-x-0 bottom-full z-20 mb-2 px-1">
                              {isLocalFolderBrowserOpen ? (
                                <ComposerLocalDirectoryMenu
                                  mentionQuery={mentionTriggerQuery}
                                  rootLabel={
                                    localFolderBrowseRootPath ?? "Local folders unavailable"
                                  }
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
                          )}

                          {!isComposerApprovalState &&
                            pendingUserInputs.length === 0 &&
                            (composerAssistantSelections.length > 0 ||
                              composerImages.length > 0) && (
                              <ComposerReferenceAttachments
                                assistantSelections={composerAssistantSelections}
                                images={composerImages}
                                nonPersistedImageIdSet={nonPersistedComposerImageIdSet}
                                onExpandImage={setExpandedImage}
                                onRemoveAssistantSelections={
                                  clearComposerAssistantSelectionsFromDraft
                                }
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
                            onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                            onChange={onPromptChange}
                            onCommandKeyDown={onComposerCommandKey}
                            onPaste={onComposerPaste}
                            placeholder={
                              isComposerApprovalState
                                ? "Resolve this approval request to continue"
                                : activePendingProgress
                                  ? "Type your own answer, or leave this blank to use the selected option"
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
                          <div className="flex items-center justify-end gap-2 px-3 pb-2">
                            <ComposerPendingApprovalActions
                              requestId={activePendingApproval.requestId}
                              isResponding={respondingRequestIds.includes(
                                activePendingApproval.requestId,
                              )}
                              onRespondToApproval={onRespondToApproval}
                            />
                          </div>
                        ) : (
                          <div
                            data-chat-composer-footer="true"
                            className={cn(
                              "flex items-end justify-between px-2.5 pb-2",
                              isComposerFooterCompact
                                ? "gap-1.5"
                                : "flex-wrap gap-1.5 sm:flex-nowrap sm:gap-0",
                            )}
                          >
                            <div
                              className={cn(
                                "flex items-center",
                                isVoiceRecording || isVoiceTranscribing
                                  ? "min-w-0 shrink-0 gap-1"
                                  : isComposerFooterCompact
                                    ? "min-w-0 flex-1 gap-1 overflow-hidden"
                                    : "-m-1 min-w-0 flex-1 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:min-w-max sm:overflow-visible",
                              )}
                            >
                              <ComposerExtrasMenu
                                interactionMode={interactionMode}
                                supportsFastMode={composerTraitSelection.caps.supportsFastMode}
                                fastModeEnabled={composerTraitSelection.fastModeEnabled}
                                onAddPhotos={addComposerImages}
                                onToggleFastMode={toggleFastMode}
                                onSetPlanMode={setPlanMode}
                              />

                              {!isVoiceRecording && !isVoiceTranscribing ? (
                                <>
                                  {/* Provider/model picker */}
                                  <ProviderModelPicker
                                    compact={isComposerFooterCompact}
                                    provider={selectedProvider}
                                    model={selectedModelForPickerWithCustomFallback}
                                    lockedProvider={lockedProvider}
                                    providers={providerStatuses}
                                    modelOptionsByProvider={modelOptionsByProvider}
                                    open={isModelPickerOpen}
                                    onOpenChange={handleModelPickerOpenChange}
                                    shortcutLabel={modelPickerShortcutLabel}
                                    {...(composerProviderState.modelPickerIconClassName
                                      ? {
                                          activeProviderIconClassName:
                                            composerProviderState.modelPickerIconClassName,
                                        }
                                      : {})}
                                    onProviderModelChange={onProviderModelSelect}
                                  />

                                  {providerTraitsPicker ? (
                                    <>
                                      <Separator
                                        orientation="vertical"
                                        className="mx-0.5 hidden h-4 sm:block"
                                      />
                                      {providerTraitsPicker}
                                    </>
                                  ) : null}

                                  {interactionMode === "plan" ? (
                                    <>
                                      <Separator
                                        orientation="vertical"
                                        className="mx-0.5 hidden h-4 sm:block"
                                      />
                                      <Button
                                        variant="ghost"
                                        className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal text-blue-400 hover:text-blue-300 sm:px-3"
                                        size="sm"
                                        type="button"
                                        onClick={toggleInteractionMode}
                                        title="Plan mode — click to return to normal chat mode"
                                      >
                                        <GoTasklist className="size-3.5" />
                                        <span className="sr-only sm:not-sr-only">Plan</span>
                                      </Button>
                                    </>
                                  ) : null}

                                  {activePlan || sidebarProposedPlan || planSidebarOpen ? (
                                    <>
                                      <Separator
                                        orientation="vertical"
                                        className="mx-0.5 hidden h-4 sm:block"
                                      />
                                      <Button
                                        variant="ghost"
                                        className="shrink-0 whitespace-nowrap px-2 text-[length:var(--app-font-size-ui-sm,11px)] sm:text-[length:var(--app-font-size-ui-sm,11px)] font-normal sm:px-3"
                                        size="sm"
                                        type="button"
                                        onClick={togglePlanSidebar}
                                        title={
                                          planSidebarOpen
                                            ? `Hide ${planSidebarLabel.toLowerCase()} sidebar`
                                            : `Show ${planSidebarLabel.toLowerCase()} sidebar`
                                        }
                                      >
                                        <GoTasklist className="size-3.5" />
                                        <span className="sr-only sm:not-sr-only">
                                          {planSidebarOpen
                                            ? `Hide ${planSidebarLabel}`
                                            : planSidebarLabel}
                                        </span>
                                      </Button>
                                    </>
                                  ) : null}
                                </>
                              ) : null}
                            </div>

                            {/* Right side: send / stop button */}
                            <div
                              data-chat-composer-actions="right"
                              className={cn(
                                "flex gap-2",
                                isVoiceRecording || isVoiceTranscribing
                                  ? "items-center"
                                  : "items-end",
                                isVoiceRecording || isVoiceTranscribing
                                  ? "min-w-0 flex-1"
                                  : "shrink-0",
                              )}
                            >
                              {isPreparingWorktree ? (
                                <span className="text-muted-foreground/70 text-xs">
                                  Preparing worktree...
                                </span>
                              ) : null}
                              {showVoiceNotesControl &&
                              (isVoiceRecording || isVoiceTranscribing) ? (
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
                                <button
                                  type="button"
                                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-all duration-150 hover:scale-105 sm:h-[26px] sm:w-[26px]"
                                  onClick={() => void onInterrupt()}
                                  aria-label="Stop generation"
                                  title="Stop the current response. On Mac, press Ctrl+C to interrupt."
                                >
                                  <span
                                    aria-hidden="true"
                                    className="block size-2 rounded-[2px] bg-current"
                                  />
                                </button>
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
                                    {accessModeToggleButton}
                                    {showVoiceNotesControl ? (
                                      <ComposerVoiceButton
                                        disabled={
                                          isComposerApprovalState || isConnecting || isSendBusy
                                        }
                                        isRecording={isVoiceRecording}
                                        isTranscribing={isVoiceTranscribing}
                                        durationLabel={voiceRecordingDurationLabel}
                                        onClick={toggleComposerVoiceRecording}
                                      />
                                    ) : null}
                                    <button
                                      type="submit"
                                      className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground text-background transition-all duration-150 hover:scale-105 disabled:opacity-20 disabled:hover:scale-100 sm:h-8 sm:w-8"
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
                                          width="14"
                                          height="14"
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
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 14 14"
                                          fill="none"
                                          aria-hidden="true"
                                        >
                                          <path
                                            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                            stroke="currentColor"
                                            strokeWidth="1.8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                          />
                                        </svg>
                                      )}
                                    </button>
                                  </>
                                )
                              ) : null}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </form>
                </div>
                {isGitRepo ? <BranchToolbar {...branchToolbarProps} /> : null}
              </>
            ) : null}

            {pullRequestDialogState ? (
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
        </div>
        {/* end chat column */}

        {/* Plan sidebar */}
        {planSidebarOpen ? (
          <PlanSidebar
            activePlan={activePlan}
            activeProposedPlan={sidebarProposedPlan}
            markdownCwd={threadWorkspaceCwd ?? undefined}
            workspaceRoot={activeProject?.cwd ?? undefined}
            timestampFormat={timestampFormat}
            onClose={() => {
              setPlanSidebarOpen(false);
              // Track that the user explicitly dismissed for this turn so auto-open won't fight them.
              const turnKey = activePlan?.turnId ?? sidebarProposedPlan?.turnId ?? null;
              if (turnKey) {
                planSidebarDismissedForTurnRef.current = turnKey;
              }
            }}
          />
        ) : null}
      </div>
      {/* end horizontal flex container */}

      {(() => {
        if (!terminalState.terminalOpen || !activeProject || terminalWorkspaceOpen) {
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
      <TranscriptSelectionActionLayer
        action={pendingTranscriptSelectionAction}
        onAddToChat={commitTranscriptAssistantSelection}
      />

      {expandedImage && expandedImageItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-6 [-webkit-app-region:no-drag]"
          role="dialog"
          aria-modal="true"
          aria-label="Expanded image preview"
        >
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
              className="max-h-[86vh] max-w-[92vw] select-none rounded-lg border border-border/70 bg-background object-contain shadow-2xl"
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
