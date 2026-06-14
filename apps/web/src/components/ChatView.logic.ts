import {
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ModelSlug,
  type ProviderApprovalDecision,
  type ProviderKind,
  type RuntimeMode,
  type ServerProviderAuthStatus,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { buildSynaraBranchName } from "@t3tools/shared/git";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { isGenericTerminalThreadTitle } from "@t3tools/shared/terminalThreads";
import {
  type ChatAssistantSelectionAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadPrimarySurface,
  type TurnDiffSummary,
} from "../types";
import { type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import {
  humanizeSubagentStatus,
  resolveSubagentPresentationForThread,
} from "../lib/subagentPresentation";
import {
  hasLiveTurnTailWork,
  isProviderFileEditWorkLogEntry,
  type WorkLogEntry,
} from "../session-logic";
import { localSubagentThreadId } from "./ChatView.selectors";
import type { ProviderModelOption } from "../providerModelOptions";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "synara:last-invoked-script-by-project";
export const DISMISSED_PROVIDER_HEALTH_BANNERS_KEY = "synara:dismissed-provider-health-banners";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);
export const DismissedProviderHealthBannersSchema = Schema.Array(Schema.String);

const ALWAYS_ALLOW_RUNTIME_MODE: RuntimeMode = "full-access";

/**
 * "Always allow" (acceptForSession) only auto-approves the live provider turn.
 * Because the client is the source of truth for runtime mode (it sends it with
 * every turn), the choice must also flip the thread to full-access so it survives
 * idle-stop and runtime restarts instead of reverting to approval-required on the
 * next turn. Returns the runtime mode to persist, or null when nothing changes.
 */
export function resolveRuntimeModeAfterApprovalDecision(
  currentRuntimeMode: RuntimeMode,
  decision: ProviderApprovalDecision,
): RuntimeMode | null {
  if (decision === "acceptForSession" && currentRuntimeMode !== ALWAYS_ALLOW_RUNTIME_MODE) {
    return ALWAYS_ALLOW_RUNTIME_MODE;
  }
  return null;
}

export function shouldRenderProviderHealthBanner(input: {
  threadEntryPoint: ThreadPrimarySurface;
  terminalWorkspaceTerminalTabActive: boolean;
}): boolean {
  return input.threadEntryPoint === "chat" && !input.terminalWorkspaceTerminalTabActive;
}

export function buildComposerMenuSelectionKey(input: {
  menuOpen: boolean;
  picker: string | null;
  triggerKind: string | null;
  triggerQuery: string;
  items: readonly { id: string }[];
}): string | null {
  if (!input.menuOpen) {
    return null;
  }
  const sourceKey = input.picker
    ? `picker:${input.picker}`
    : `trigger:${input.triggerKind ?? "none"}:${input.triggerQuery}`;
  return `${sourceKey}\u001f${input.items.map((item) => item.id).join("\u001e")}`;
}

// Default-open policy for the Environment panel; render-time visibility is resolved separately.
export function resolveDefaultEnvironmentPanelOpen(input: {
  environmentEnabled: boolean;
  isCenteredEmptyLanding: boolean;
  isTerminalPrimarySurface: boolean;
}): boolean {
  return (
    input.environmentEnabled && !input.isCenteredEmptyLanding && !input.isTerminalPrimarySurface
  );
}

export function resolveEnvironmentPanelVisible(input: {
  environmentEnabled: boolean;
  environmentPanelOpen: boolean;
}): boolean {
  return input.environmentEnabled && input.environmentPanelOpen;
}

export function resolveActiveTurnLiveDiffState(input: {
  latestTurnId: TurnDiffSummary["turnId"] | null | undefined;
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  workLogEntries?: ReadonlyArray<
    Pick<WorkLogEntry, "changedFiles" | "itemType" | "requestKind" | "turnId">
  >;
}): {
  turnId: TurnDiffSummary["turnId"] | null;
  fileCount: number | null;
  additions: number;
  deletions: number;
  hasChanges: boolean;
} {
  const summary = input.latestTurnId
    ? (input.turnDiffSummaries.find((entry) => entry.turnId === input.latestTurnId) ?? null)
    : null;
  const files = summary?.files ?? [];
  if (summary && files.length > 0) {
    return {
      turnId: summary.turnId,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + (file.additions ?? 0), 0),
      deletions: files.reduce((total, file) => total + (file.deletions ?? 0), 0),
      hasChanges: true,
    };
  }

  const workLogFilePaths = new Set<string>();
  let hasFileEditWork = false;
  if (input.latestTurnId) {
    for (const entry of input.workLogEntries ?? []) {
      if (entry.turnId !== input.latestTurnId || !isProviderFileEditWorkLogEntry(entry)) {
        continue;
      }
      hasFileEditWork = true;
      for (const filePath of entry.changedFiles ?? []) {
        workLogFilePaths.add(filePath);
      }
    }
  }

  if (hasFileEditWork && input.latestTurnId) {
    return {
      turnId: input.latestTurnId,
      fileCount: workLogFilePaths.size > 0 ? workLogFilePaths.size : null,
      additions: 0,
      deletions: 0,
      hasChanges: true,
    };
  }

  return {
    turnId: null,
    fileCount: 0,
    additions: 0,
    deletions: 0,
    hasChanges: false,
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: draftThread.entryPoint === "terminal" ? "New terminal" : "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    latestTurn: null,
    lastVisitedAt: draftThread.createdAt,
    envMode: draftThread.envMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    lastKnownPr: draftThread.lastKnownPr ?? null,
    handoff: null,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function resolveActiveThreadTitle(input: {
  title: string;
  subagentTitle: string | null;
  isHomeChat: boolean;
  isEmpty: boolean;
}): string {
  if (input.subagentTitle) {
    return input.subagentTitle;
  }
  if (input.isHomeChat && input.isEmpty && isGenericChatThreadTitle(input.title)) {
    return "New Chat";
  }
  return input.title;
}

// Sidechats carry imported fork history for provider context, but their transcript should start
// visually clean so only new sidechat turns appear in the pane.
export function filterSidechatTranscriptMessages(
  messages: readonly ChatMessage[],
  isSidechat: boolean,
): ChatMessage[] {
  return isSidechat
    ? messages.filter((message) => message.source !== "fork-import")
    : [...messages];
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export function appendVoiceTranscriptToPrompt(
  currentPrompt: string,
  transcript: string,
): string | null {
  const trimmedTranscript = transcript.trim();
  if (trimmedTranscript.length === 0) {
    return null;
  }
  return currentPrompt.trim().length === 0
    ? trimmedTranscript
    : `${currentPrompt.replace(/\s+$/, "")}\n${trimmedTranscript}`;
}

export function sanitizeVoiceErrorMessage(message: string): string {
  const normalized = message.trim();
  if (normalized.length === 0) {
    return "The voice note could not be transcribed.";
  }

  const firstLine = normalized.split("\n")[0]?.trim() ?? normalized;
  const withoutInlineStack = firstLine.replace(/\s+at file:\/\/.*$/s, "").trim();
  const withoutRemoteMethodPrefix = withoutInlineStack.replace(
    /^Error invoking remote method ['"][^'"]+['"]:\s*/i,
    "",
  );
  const withoutRepeatedErrorPrefix = withoutRemoteMethodPrefix.replace(/^(Error:\s*)+/i, "").trim();

  return withoutRepeatedErrorPrefix.length > 0
    ? withoutRepeatedErrorPrefix
    : "The voice note could not be transcribed.";
}

export function isVoiceAuthExpiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("chatgpt login has expired") || normalized.includes("sign in again");
}

export function describeVoiceRecordingStartError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "The microphone could not be opened.";
  }

  const normalizedMessage = error.message.trim();
  const errorName = typeof error.name === "string" ? error.name : "";

  if (errorName === "NotAllowedError" || errorName === "PermissionDeniedError") {
    return "Microphone access was denied. Enable it in macOS Privacy & Security > Microphone for Synara, then try again.";
  }
  if (errorName === "NotFoundError" || errorName === "DevicesNotFoundError") {
    return "No microphone was found. Connect one and try again.";
  }
  if (errorName === "NotReadableError" || errorName === "TrackStartError") {
    return "The microphone is busy or unavailable right now. Close other audio apps and try again.";
  }
  if (errorName === "SecurityError") {
    return "Microphone access is blocked in this environment.";
  }
  if (normalizedMessage.length > 0) {
    return sanitizeVoiceErrorMessage(normalizedMessage);
  }

  return "The microphone could not be opened.";
}

export function deriveComposerVoiceState(input: {
  authStatus: ServerProviderAuthStatus | null | undefined;
  voiceTranscriptionAvailable: boolean | undefined;
  isRecording: boolean;
  isTranscribing: boolean;
}): {
  canRenderVoiceNotes: boolean;
  canStartVoiceNotes: boolean;
  showVoiceNotesControl: boolean;
} {
  const canRenderVoiceNotes = input.authStatus !== "unauthenticated";
  const canStartVoiceNotes = canRenderVoiceNotes && input.voiceTranscriptionAvailable !== false;

  return {
    canRenderVoiceNotes,
    canStartVoiceNotes,
    showVoiceNotesControl: canRenderVoiceNotes || input.isRecording || input.isTranscribing,
  };
}

export function shouldShowComposerModelBootstrapSkeleton(input: {
  selectedProvider: ProviderKind;
  selectedModel: string | null | undefined;
  persistedModelSelection: ModelSelection | null | undefined;
  draftModelSelection: ModelSelection | null | undefined;
  providerModelsLoading: boolean;
  requiresDiscoveredModels?: boolean;
}): boolean {
  if (input.requiresDiscoveredModels === true && input.providerModelsLoading) {
    return true;
  }

  const draftSelection = input.draftModelSelection;
  if (draftSelection && draftSelection.provider === input.selectedProvider) {
    return false;
  }

  const persistedSelection = input.persistedModelSelection;
  if (!persistedSelection) {
    return false;
  }

  if (persistedSelection.provider !== input.selectedProvider) {
    return true;
  }

  if (!input.providerModelsLoading) {
    return false;
  }

  const normalizedSelectedModel =
    normalizeModelSlug(input.selectedModel, input.selectedProvider) ?? input.selectedModel;
  const normalizedPersistedModel =
    normalizeModelSlug(persistedSelection.model, persistedSelection.provider) ??
    persistedSelection.model;

  return normalizedSelectedModel !== normalizedPersistedModel;
}

export function resolveCommittedProviderModel(input: {
  selectedModel: ModelSlug;
  availableOptions: ReadonlyArray<ProviderModelOption>;
  fallback: () => string;
}): string {
  const directRuntimeOption = input.availableOptions.find(
    (option) => option.slug === input.selectedModel,
  );
  return directRuntimeOption?.slug ?? input.fallback();
}

// Lets a pending custom binary path re-check a session that was already observed ready.
export function shouldConsumePendingCustomBinaryConfirmation(input: {
  sessionAlreadyChecked: boolean;
  pendingCustomBinaryPath: string | null | undefined;
}): boolean {
  return !input.sessionAlreadyChecked || Boolean(input.pendingCustomBinaryPath);
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: Thread["latestTurn"] extends infer T
    ? T extends { turnId: infer U }
      ? U | null
      : null
    : null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: Thread["session"] extends infer T
    ? T extends { orchestrationStatus: infer U }
      ? U | null
      : null
    : null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const nextSessionOrchestrationStatus = session?.orchestrationStatus ?? null;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (latestTurnChanged) {
    return true;
  }

  if (input.localDispatch.sessionOrchestrationStatus !== nextSessionOrchestrationStatus) {
    if (
      input.localDispatch.sessionOrchestrationStatus === null &&
      nextSessionOrchestrationStatus === "ready"
    ) {
      return false;
    }
    return true;
  }

  return false;
}

export const ACTIVE_TURN_LAYOUT_SETTLE_DELAY_MS = 180;

export function shouldStartActiveTurnLayoutGrace(options: {
  previousTurnLayoutLive: boolean;
  currentTurnLayoutLive: boolean;
  latestTurnStartedAt: string | null;
}): boolean {
  return (
    options.previousTurnLayoutLive &&
    !options.currentTurnLayoutLive &&
    options.latestTurnStartedAt !== null
  );
}

export function buildSuggestedWorktreeName(input: {
  associatedWorktreeBranch?: string | null;
  title?: string | null;
}): string {
  return buildSynaraBranchName(input.associatedWorktreeBranch ?? input.title);
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  assistantSelectionCount: number;
  fileCommentCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      options.assistantSelectionCount > 0 ||
      options.fileCommentCount > 0 ||
      sendableTerminalContexts.length > 0,
  };
}

export function collectUserMessageAssistantSelections(
  message: ChatMessage,
): ChatAssistantSelectionAttachment[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  return message.attachments.filter(
    (attachment): attachment is ChatAssistantSelectionAttachment =>
      attachment.type === "assistant-selection",
  );
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function shouldRenderTerminalWorkspace(options: {
  presentationMode: "drawer" | "workspace";
  terminalOpen: boolean;
}): boolean {
  // The workspace shell should paint immediately; the terminal viewport gates the
  // backend attach until a valid cwd is available.
  return options.terminalOpen && options.presentationMode === "workspace";
}

export function resolveProjectScriptTerminalTarget(options: {
  baseTerminalId: string;
  createTerminalId: () => string;
  hasRunningTerminal: boolean;
  preferNewTerminal?: boolean | undefined;
  terminalOpen: boolean;
}): { shouldCreateNewTerminal: boolean; terminalId: string } {
  // Project scripts require their requested cwd/env before the command write;
  // live PTYs keep their launch context, so visible or running terminals get a new tab.
  const shouldCreateNewTerminal =
    Boolean(options.preferNewTerminal) || options.terminalOpen || options.hasRunningTerminal;

  return {
    shouldCreateNewTerminal,
    terminalId: shouldCreateNewTerminal ? options.createTerminalId() : options.baseTerminalId,
  };
}

export function shouldAutoDeleteTerminalThreadOnLastClose(options: {
  isLastTerminal: boolean;
  isServerThread: boolean;
  terminalEntryPoint: ThreadPrimarySurface;
  thread:
    | Pick<Thread, "activities" | "latestTurn" | "messages" | "proposedPlans" | "session" | "title">
    | null
    | undefined;
}): boolean {
  const { thread } = options;
  if (
    !options.isLastTerminal ||
    !options.isServerThread ||
    options.terminalEntryPoint !== "terminal" ||
    !thread
  ) {
    return false;
  }
  return (
    isGenericTerminalThreadTitle(thread.title) &&
    thread.messages.length === 0 &&
    thread.latestTurn === null &&
    thread.session === null &&
    thread.activities.length === 0 &&
    thread.proposedPlans.length === 0
  );
}

export interface ThreadBreadcrumb {
  threadId: ThreadIdType;
  title: string;
}

type ThreadBreadcrumbSource = Pick<
  Thread,
  "id" | "title" | "parentThreadId" | "subagentAgentId" | "subagentNickname" | "subagentRole"
> & {
  activities?: Thread["activities"];
};

export function buildThreadBreadcrumbs(
  threads: ReadonlyArray<ThreadBreadcrumbSource>,
  thread: Pick<Thread, "id" | "parentThreadId"> | null | undefined,
): ThreadBreadcrumb[] {
  if (!thread?.parentThreadId) {
    return [];
  }

  const threadById = new Map(threads.map((entry) => [entry.id, entry] as const));
  const breadcrumbs: ThreadBreadcrumb[] = [];
  const visited = new Set<ThreadIdType>();
  let currentParentId: ThreadIdType | null = thread.parentThreadId ?? null;

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parentThread = threadById.get(currentParentId);
    if (!parentThread) {
      break;
    }
    breadcrumbs.unshift({
      threadId: parentThread.id,
      title: parentThread.parentThreadId
        ? resolveSubagentPresentationForThread({ thread: parentThread, threads }).fullLabel
        : parentThread.title,
    });
    currentParentId = parentThread.parentThreadId ?? null;
  }

  return breadcrumbs;
}

function deriveSubagentStatus(thread: Thread | undefined): {
  isActive: boolean;
  label: string | undefined;
} {
  if (!thread) {
    return {
      isActive: false,
      label: undefined,
    };
  }

  if (thread.error || thread.session?.status === "error") {
    return {
      isActive: false,
      label: "Error",
    };
  }
  if (thread.session?.status === "connecting") {
    return {
      isActive: true,
      label: "Connecting",
    };
  }
  if (
    thread.session?.status === "running" ||
    hasLiveTurnTailWork({
      latestTurn: thread.latestTurn,
      messages: thread.messages,
      activities: thread.activities,
      session: thread.session,
    })
  ) {
    return {
      isActive: true,
      label: "Running",
    };
  }
  if (thread.session?.status === "closed") {
    return {
      isActive: false,
      label: "Closed",
    };
  }

  return {
    isActive: false,
    label: thread.session ? "Idle" : undefined,
  };
}

function humanizeSubagentRawStatus(rawStatus: string | undefined): string | undefined {
  return humanizeSubagentStatus(rawStatus);
}

function resolveTimelineSubagentThread(input: {
  subagent: NonNullable<WorkLogEntry["subagents"]>[number];
  parentThreadId: ThreadIdType | null;
  threadById: ReadonlyMap<ThreadIdType, Thread>;
  threads: ReadonlyArray<Thread>;
}): Thread | undefined {
  const directThreadId = input.subagent.resolvedThreadId ?? input.subagent.threadId;
  if (directThreadId) {
    const directMatch = input.threadById.get(ThreadId.makeUnsafe(directThreadId));
    if (directMatch) {
      return directMatch;
    }
  }

  if (input.parentThreadId) {
    const providerThreadId = input.subagent.providerThreadId ?? input.subagent.threadId;
    const derivedLocalThreadId = localSubagentThreadId(input.parentThreadId, providerThreadId);
    const derivedLocalMatch = input.threadById.get(derivedLocalThreadId);
    if (derivedLocalMatch) {
      return derivedLocalMatch;
    }

    if (input.subagent.agentId) {
      const matchedByAgent = input.threads.find(
        (thread) =>
          thread.parentThreadId === input.parentThreadId &&
          thread.subagentAgentId === input.subagent.agentId,
      );
      if (matchedByAgent) {
        return matchedByAgent;
      }
    }
  }

  if (input.subagent.agentId) {
    return input.threads.find((thread) => thread.subagentAgentId === input.subagent.agentId);
  }

  return undefined;
}

export function enrichSubagentWorkEntries(
  workEntries: ReadonlyArray<WorkLogEntry>,
  threads: ReadonlyArray<Thread>,
  parentThreadId: ThreadIdType | null,
): WorkLogEntry[] {
  if (workEntries.length === 0) {
    return [];
  }

  const threadById = new Map(threads.map((thread) => [thread.id, thread] as const));

  return workEntries.map((entry) => {
    if ((entry.subagents?.length ?? 0) === 0) {
      return entry;
    }

    const subagents = entry.subagents!.map((subagent) => {
      const matchedThread = resolveTimelineSubagentThread({
        subagent,
        parentThreadId,
        threadById,
        threads,
      });
      const status = deriveSubagentStatus(matchedThread);
      const fallbackStatusLabel = humanizeSubagentRawStatus(subagent.rawStatus);
      const matchedPresentation =
        matchedThread !== undefined
          ? resolveSubagentPresentationForThread({ thread: matchedThread, threads })
          : null;
      const nextSubagent = Object.assign({}, subagent);
      if (matchedThread) {
        nextSubagent.resolvedThreadId = matchedThread.id;
      }
      if (matchedPresentation) {
        nextSubagent.title = matchedPresentation.fullLabel;
      }
      if (status.label ?? fallbackStatusLabel) {
        nextSubagent.statusLabel = status.label ?? fallbackStatusLabel;
      }
      if (status.isActive || fallbackStatusLabel === "Running") {
        nextSubagent.isActive = true;
      }
      return nextSubagent;
    });

    return {
      ...entry,
      subagents,
    };
  });
}
