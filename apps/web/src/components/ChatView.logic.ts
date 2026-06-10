import {
  type ClaudeCodeEffort,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ModelSlug,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderMentionReference,
  type ProviderPluginDescriptor,
  type ProviderStartOptions,
  type RuntimeMode,
  type ServerProviderAuthStatus,
  type ServerProviderStatus,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { normalizeCustomBinaryPath } from "~/lib/providerAvailability";
import type { RateLimitStatus } from "./chat/RateLimitBanner";
import {
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { formatAssistantSelectionQueuePreview } from "../lib/assistantSelections";
import { createComposerMentionTokenRegex } from "~/lib/composerMentions";
import { buildSynaraBranchName } from "@t3tools/shared/git";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { isGenericTerminalThreadTitle } from "@t3tools/shared/terminalThreads";
import {
  type ChatAssistantSelectionAttachment,
  type ChatMessage,
  type SessionPhase,
  type Thread,
  type ThreadPrimarySurface,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import {
  filterTerminalContextsWithText,
  formatTerminalContextLabel,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import {
  humanizeSubagentStatus,
  resolveSubagentPresentationForThread,
} from "../lib/subagentPresentation";
import { hasLiveTurnTailWork, type WorkLogEntry } from "../session-logic";
import { localSubagentThreadId } from "./ChatView.selectors";
import { formatProviderModelOptionName, type ProviderModelOption } from "../providerModelOptions";

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

export function resolveCodexSessionPrewarmKey(input: {
  readonly isServerThread: boolean;
  readonly thread: Pick<Thread, "id" | "modelSelection" | "session"> | undefined;
  readonly modelSelection: ModelSelection;
  readonly providerOptions: ProviderStartOptions;
  readonly runtimeMode: RuntimeMode;
}): string | null {
  if (!input.isServerThread || !input.thread) {
    return null;
  }
  if (
    input.thread.modelSelection.provider !== "codex" ||
    input.modelSelection.provider !== "codex"
  ) {
    return null;
  }
  const sessionStatus = input.thread.session?.status ?? null;
  if (
    sessionStatus === "connecting" ||
    sessionStatus === "ready" ||
    sessionStatus === "running" ||
    sessionStatus === "error"
  ) {
    return null;
  }
  return [
    input.thread.id,
    input.modelSelection.provider,
    input.modelSelection.model,
    JSON.stringify(input.modelSelection.options ?? null),
    input.runtimeMode,
    JSON.stringify(input.providerOptions),
  ].join("\u001f");
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

export function revokeBlobPreviewUrlsAfterPaint(previewUrls: readonly string[]): void {
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

export function eventTargetsComposer(
  event: globalThis.KeyboardEvent,
  composerForm: HTMLFormElement | null,
): boolean {
  if (!composerForm) return false;
  const target = event.target;
  return target instanceof Node ? composerForm.contains(target) : false;
}

export function canHandleComposerPickerShortcut(
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

export function getThreadProviderCustomBinaryPathKey(
  threadId: Thread["id"],
  provider: ProviderKind,
): string {
  return `${threadId}:${provider}`;
}

export function getConfirmedCustomBinarySessionKey(
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

export function getProviderStartOptionsCustomBinaryPath(
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

export function getProviderHealthBannerDismissalKey(
  status: ServerProviderStatus | null,
): string | null {
  if (!status || status.status === "ready") {
    return null;
  }
  return [
    status.provider,
    status.status,
    status.available ? "available" : "unavailable",
    status.authStatus,
    status.message?.trim() ?? "",
  ].join("");
}

export function getRateLimitBannerDismissalKey(
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
  ].join("");
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

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function buildSuggestedWorktreeName(input: {
  associatedWorktreeBranch?: string | null;
  title?: string | null;
}): string {
  return buildSynaraBranchName(input.associatedWorktreeBranch ?? input.title);
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  assistantSelectionCount: number;
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
  activeProjectExists: boolean;
  presentationMode: "drawer" | "workspace";
  terminalOpen: boolean;
}): boolean {
  return (
    options.terminalOpen && options.presentationMode === "workspace" && options.activeProjectExists
  );
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

export function buildThreadBreadcrumbs(
  threads: ReadonlyArray<Thread>,
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

export type ComposerPluginSuggestion = {
  plugin: ProviderPluginDescriptor;
  mention: ProviderMentionReference;
};

export function formatOutgoingPrompt(params: {
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

export function buildQueuedComposerPreviewText(input: {
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

export function warnVoiceGuard(event: string, details?: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    return;
  }
  if (details) {
    console.warn(`[voice] ${event}`, details);
    return;
  }
  console.warn(`[voice] ${event}`);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    const withoutContextSuffix = slug.replace(/\[[^\]]+\]$/u, "");
    return normalizeModelSlug(withoutContextSuffix, provider) ?? withoutContextSuffix;
  }
  if (provider === "grok") {
    return slug.trim();
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

export function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>;
  dynamicModels: ReadonlyArray<{
    slug: string;
    name?: string | null;
    upstreamProviderId?: string | null;
    upstreamProviderName?: string | null;
  }>;
}): ReadonlyArray<ProviderModelOption & { isCustom?: boolean }> {
  const staticNameBySlug = new Map(input.staticOptions.map((model) => [model.slug, model.name]));
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: ProviderModelOption[] = [];

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
    const rawSlug = dynamicModel.slug.trim().toLowerCase();
    const displayNameFallback = formatProviderModelOptionName({
      provider: input.provider,
      slug: normalizedSlug,
    });
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        staticNameBySlug.get(normalizedSlug) ??
        (rawName.length > 0 &&
        rawName.toLowerCase() !== rawSlug &&
        rawName.toLowerCase() !== normalizedSlug.toLowerCase()
          ? rawName
          : displayNameFallback),
      ...(dynamicModel.upstreamProviderId?.trim()
        ? { upstreamProviderId: dynamicModel.upstreamProviderId.trim() }
        : {}),
      ...(dynamicModel.upstreamProviderName?.trim()
        ? { upstreamProviderName: dynamicModel.upstreamProviderName.trim() }
        : {}),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) => "isCustom" in model && model.isCustom && !dynamicNormalizedSlugs.has(model.slug),
  );
  const staticBuiltInModels = input.staticOptions.filter(
    (model) => !("isCustom" in model) || model.isCustom !== true,
  );
  const missingStaticBuiltIns =
    (input.provider === "kilo" || input.provider === "opencode" || input.provider === "cursor") &&
    normalizedDynamicOptions.length > 0
      ? []
      : staticBuiltInModels.filter((model) => !dynamicNormalizedSlugs.has(model.slug));

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}

export function skillMentionPrefix(provider: string): string {
  if (provider === "pi") return "/skill:";
  return "/";
}

export function promptIncludesSkillMention(
  prompt: string,
  skillName: string,
  provider: string,
): boolean {
  const escapedSkillName = escapeRegExp(skillName);
  const prefixes = provider === "pi" ? ["/skill:"] : ["/", "$"];
  return prefixes.some((prefix) => {
    const pattern = new RegExp(`(^|\\s)${escapeRegExp(prefix)}${escapedSkillName}(?=\\s|$)`, "i");
    return pattern.test(prompt);
  });
}

const PROMPT_MENTION_NAME_REGEX = createComposerMentionTokenRegex({
  includeTrailingTokenAtEnd: true,
});

export function collectPromptMentionNames(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(PROMPT_MENTION_NAME_REGEX)) {
    const mentionName = (match[2] ?? match[3] ?? "").trim();
    if (mentionName.length > 0) {
      names.push(mentionName);
    }
  }
  return names;
}

export function normalizeMentionNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function resolvePromptPluginMentions(params: {
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

export const providerMentionReferencesEqual = (
  left: ReadonlyArray<ProviderMentionReference>,
  right: ReadonlyArray<ProviderMentionReference>,
): boolean =>
  left.length === right.length &&
  left.every(
    (mention, index) => mention.path === right[index]?.path && mention.name === right[index]?.name,
  );

export const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

export const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);
