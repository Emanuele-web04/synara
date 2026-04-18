import {
  CODEX_REASONING_EFFORT_OPTIONS,
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  type GeminiThinkingBudget,
  type GeminiThinkingLevel,
  type ModelSlug,
  ModelSelection,
  ProjectId,
  ProviderMentionReference,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  ProviderSkillReference,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import { DeepMutable } from "effect/Types";
import {
  getDefaultModel,
  normalizeModelSlug,
  resolveModelSlugForProvider,
} from "@t3tools/shared/model";
import { useMemo } from "react";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { resolveAppModelSelection } from "./appSettings";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatImageAttachment,
  type ThreadPrimarySurface,
} from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import { buildModelSelection } from "./providerModelOptions";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 4;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;
const DraftThreadEntryPointSchema = Schema.Literals(["chat", "terminal"]);

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;
const TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX = "::terminal";

const composerDebouncedStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  COMPOSER_PERSIST_DEBOUNCE_MS,
);

// Flush pending composer draft writes before page unload to prevent data loss.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    composerDebouncedStorage.flush();
  });
}

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.String,
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export interface QueuedComposerChatTurn {
  id: string;
  kind: "chat";
  createdAt: string;
  previewText: string;
  prompt: string;
  images: ComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedPromptEffort: string | null;
  modelSelection: ModelSelection;
  providerOptionsForDispatch?: ProviderStartOptions | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
}

export interface QueuedComposerPlanFollowUp {
  id: string;
  kind: "plan-follow-up";
  createdAt: string;
  previewText: string;
  text: string;
  interactionMode: "default" | "plan";
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedPromptEffort: string | null;
  modelSelection: ModelSelection;
  providerOptionsForDispatch?: ProviderStartOptions | undefined;
  runtimeMode: RuntimeMode;
}

export type QueuedComposerTurn = QueuedComposerChatTurn | QueuedComposerPlanFollowUp;

const PersistedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
});
type PersistedTerminalContextDraft = typeof PersistedTerminalContextDraft.Type;

const PersistedQueuedTerminalContextDraft = Schema.Struct({
  id: Schema.String,
  threadId: ThreadId,
  createdAt: Schema.String,
  terminalId: Schema.String,
  terminalLabel: Schema.String,
  lineStart: Schema.Number,
  lineEnd: Schema.Number,
  text: Schema.String,
});
type PersistedQueuedTerminalContextDraft = typeof PersistedQueuedTerminalContextDraft.Type;

const PersistedQueuedComposerChatTurn = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("chat"),
  createdAt: Schema.String,
  previewText: Schema.String,
  prompt: Schema.String,
  images: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.Array(PersistedQueuedTerminalContextDraft),
  skills: Schema.Array(ProviderSkillReference),
  mentions: Schema.Array(ProviderMentionReference),
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  envMode: DraftThreadEnvModeSchema,
});
type PersistedQueuedComposerChatTurn = typeof PersistedQueuedComposerChatTurn.Type;

const PersistedQueuedComposerPlanFollowUp = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("plan-follow-up"),
  createdAt: Schema.String,
  previewText: Schema.String,
  text: Schema.String,
  interactionMode: ProviderInteractionMode,
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  runtimeMode: RuntimeMode,
});
type PersistedQueuedComposerPlanFollowUp = typeof PersistedQueuedComposerPlanFollowUp.Type;

const PersistedQueuedComposerTurn = Schema.Union([
  PersistedQueuedComposerChatTurn,
  PersistedQueuedComposerPlanFollowUp,
]);
type PersistedQueuedComposerTurn = typeof PersistedQueuedComposerTurn.Type;

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  attachments: Schema.Array(PersistedComposerImageAttachment),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  queuedTurns: Schema.optionalKey(Schema.Array(PersistedQueuedComposerTurn)),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  codexFastMode: Schema.optionalKey(Schema.Boolean),
  serviceTier: Schema.optionalKey(Schema.String),
});
type LegacyCodexFields = typeof LegacyCodexFields.Type;

const LegacyThreadModelFields = Schema.Struct({
  provider: Schema.optionalKey(ProviderKind),
  model: Schema.optionalKey(Schema.String),
  modelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyThreadModelFields = typeof LegacyThreadModelFields.Type;

type LegacyV2ThreadDraftFields = {
  modelSelection?: ModelSelection | null;
  modelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerThreadDraftState = PersistedComposerThreadDraftState &
  LegacyCodexFields &
  LegacyThreadModelFields &
  LegacyV2ThreadDraftFields;

const LegacyStickyModelFields = Schema.Struct({
  stickyProvider: Schema.optionalKey(ProviderKind),
  stickyModel: Schema.optionalKey(Schema.String),
  stickyModelOptions: Schema.optionalKey(Schema.NullOr(ProviderModelOptions)),
});
type LegacyStickyModelFields = typeof LegacyStickyModelFields.Type;

type LegacyV2StoreFields = {
  stickyModelSelection?: ModelSelection | null;
  stickyModelOptions?: ProviderModelOptions | null;
};

type LegacyPersistedComposerDraftStoreState = PersistedComposerDraftStoreState &
  LegacyStickyModelFields &
  LegacyV2StoreFields;

const PersistedDraftThreadState = Schema.Struct({
  projectId: ProjectId,
  createdAt: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  entryPoint: DraftThreadEntryPointSchema.pipe(Schema.withDecodingDefault(() => "chat")),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  envMode: DraftThreadEnvModeSchema,
  isTemporary: Schema.optionalKey(Schema.Boolean),
});
type PersistedDraftThreadState = typeof PersistedDraftThreadState.Type;

const PersistedComposerDraftStoreState = Schema.Struct({
  draftsByThreadId: Schema.Record(ThreadId, PersistedComposerThreadDraftState),
  draftThreadsByThreadId: Schema.Record(ThreadId, PersistedDraftThreadState),
  projectDraftThreadIdByProjectId: Schema.Record(ProjectId, ThreadId),
  stickyModelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  stickyActiveProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
});
type PersistedComposerDraftStoreState = typeof PersistedComposerDraftStoreState.Type;

const PersistedComposerDraftStoreStorage = Schema.Struct({
  version: Schema.Number,
  state: PersistedComposerDraftStoreState,
});

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  queuedTurns: QueuedComposerTurn[];
  modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  activeProvider: ProviderKind | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

export interface DraftThreadState {
  projectId: ProjectId;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  entryPoint: ThreadPrimarySurface;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  isTemporary?: boolean;
}

interface ProjectDraftThread extends DraftThreadState {
  threadId: ThreadId;
}

export interface ComposerDraftStoreState {
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
  stickyActiveProvider: ProviderKind | null;
  getDraftThreadByProjectId: (
    projectId: ProjectId,
    entryPoint?: ThreadPrimarySurface,
  ) => ProjectDraftThread | null;
  getDraftThread: (threadId: ThreadId) => DraftThreadState | null;
  setProjectDraftThreadId: (
    projectId: ProjectId,
    threadId: ThreadId,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      entryPoint?: ThreadPrimarySurface;
      isTemporary?: boolean;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectId?: ProjectId;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      entryPoint?: ThreadPrimarySurface;
      isTemporary?: boolean;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId, entryPoint?: ThreadPrimarySurface) => void;
  clearProjectDraftThreads: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadId: ThreadId,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  setModelOptions: (
    threadId: ThreadId,
    modelOptions: ProviderModelOptions | null | undefined,
  ) => void;
  applyStickyState: (threadId: ThreadId) => void;
  setProviderModelOptions: (
    threadId: ThreadId,
    provider: ProviderKind,
    nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
    options?: {
      model?: string | null;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode | null | undefined) => void;
  setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  enqueueQueuedTurn: (threadId: ThreadId, queuedTurn: QueuedComposerTurn) => void;
  insertQueuedTurn: (threadId: ThreadId, queuedTurn: QueuedComposerTurn, index: number) => void;
  removeQueuedTurn: (threadId: ThreadId, queuedTurnId: string) => void;
  addImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  addImages: (threadId: ThreadId, images: ComposerImageAttachment[]) => void;
  removeImage: (threadId: ThreadId, imageId: string) => void;
  insertTerminalContext: (
    threadId: ThreadId,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadId: ThreadId, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadId: ThreadId, contextId: string) => void;
  clearTerminalContexts: (threadId: ThreadId) => void;
  clearPersistedAttachments: (threadId: ThreadId) => void;
  syncPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  copyTransferableComposerState: (sourceThreadId: ThreadId, targetThreadId: ThreadId) => void;
  clearComposerContent: (threadId: ThreadId) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: ModelSlug;
  modelOptions: ProviderModelOptions | null;
}

function providerModelOptionsFromSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderModelOptions | null {
  if (!modelSelection?.options) {
    return null;
  }

  return {
    [modelSelection.provider]: modelSelection.options,
  };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<ProviderKind, ModelSelection>> | null | undefined,
): ProviderModelOptions | null {
  if (!map) return null;
  const result: Record<string, unknown> = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

const EMPTY_PERSISTED_DRAFT_STORE_STATE = Object.freeze<PersistedComposerDraftStoreState>({
  draftsByThreadId: {},
  draftThreadsByThreadId: {},
  projectDraftThreadIdByProjectId: {},
  stickyModelSelectionByProvider: {},
  stickyActiveProvider: null,
});

function projectDraftThreadMappingKey(
  projectId: ProjectId,
  entryPoint: ThreadPrimarySurface = "chat",
): string {
  return entryPoint === "terminal"
    ? `${projectId}${TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX}`
    : projectId;
}

function projectDraftThreadEntryPointFromKey(key: string): ThreadPrimarySurface {
  return key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX) ? "terminal" : "chat";
}

function projectIdFromDraftThreadMappingKey(key: string): ProjectId {
  return (
    key.endsWith(TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX)
      ? key.slice(0, -TERMINAL_DRAFT_THREAD_MAPPING_SUFFIX.length)
      : key
  ) as ProjectId;
}

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_QUEUED_TURNS: QueuedComposerTurn[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_QUEUED_TURNS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  queuedTurns: EMPTY_QUEUED_TURNS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    queuedTurns: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function composerImageDedupKey(image: ComposerImageAttachment): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function buildTransferredComposerDraft(input: {
  sourceDraft: ComposerThreadDraftState;
  targetDraft: ComposerThreadDraftState | undefined;
  targetThreadId: ThreadId;
}): ComposerThreadDraftState {
  const { sourceDraft, targetDraft, targetThreadId } = input;
  const base = targetDraft ?? createEmptyThreadDraft();
  return {
    ...base,
    prompt: sourceDraft.prompt,
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      sourceDraft.terminalContexts,
    ),
  };
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.queuedTurns.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" || value === "gemini" ? value : null;
}

function normalizeProviderModelOptions(
  value: unknown,
  provider?: ProviderKind | null,
  legacy?: LegacyCodexFields,
): ProviderModelOptions | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const codexCandidate =
    candidate?.codex && typeof candidate.codex === "object"
      ? (candidate.codex as Record<string, unknown>)
      : null;
  const claudeCandidate =
    candidate?.claudeAgent && typeof candidate.claudeAgent === "object"
      ? (candidate.claudeAgent as Record<string, unknown>)
      : null;
  const geminiCandidate =
    candidate?.gemini && typeof candidate.gemini === "object"
      ? (candidate.gemini as Record<string, unknown>)
      : null;

  const codexReasoningEffort: CodexReasoningEffort | undefined =
    codexCandidate?.reasoningEffort === "low" ||
    codexCandidate?.reasoningEffort === "medium" ||
    codexCandidate?.reasoningEffort === "high" ||
    codexCandidate?.reasoningEffort === "xhigh"
      ? codexCandidate.reasoningEffort
      : provider === "codex" &&
          (legacy?.effort === "low" ||
            legacy?.effort === "medium" ||
            legacy?.effort === "high" ||
            legacy?.effort === "xhigh")
        ? legacy.effort
        : undefined;
  const codexFastMode =
    codexCandidate?.fastMode === true
      ? true
      : codexCandidate?.fastMode === false
        ? false
        : (provider === "codex" && legacy?.codexFastMode === true) ||
            (typeof legacy?.serviceTier === "string" && legacy.serviceTier === "fast")
          ? true
          : undefined;
  const codex =
    codexReasoningEffort !== undefined || codexFastMode !== undefined
      ? {
          ...(codexReasoningEffort !== undefined ? { reasoningEffort: codexReasoningEffort } : {}),
          ...(codexFastMode !== undefined ? { fastMode: codexFastMode } : {}),
        }
      : undefined;

  const claudeThinking =
    claudeCandidate?.thinking === true
      ? true
      : claudeCandidate?.thinking === false
        ? false
        : undefined;
  const claudeEffort: ClaudeCodeEffort | undefined =
    claudeCandidate?.effort === "low" ||
    claudeCandidate?.effort === "medium" ||
    claudeCandidate?.effort === "high" ||
    claudeCandidate?.effort === "xhigh" ||
    claudeCandidate?.effort === "max" ||
    claudeCandidate?.effort === "ultrathink"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claudeContextWindow =
    typeof claudeCandidate?.contextWindow === "string" && claudeCandidate.contextWindow.length > 0
      ? claudeCandidate.contextWindow
      : undefined;
  const claude =
    claudeThinking !== undefined ||
    claudeEffort !== undefined ||
    claudeFastMode !== undefined ||
    claudeContextWindow !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(claudeContextWindow !== undefined ? { contextWindow: claudeContextWindow } : {}),
        }
      : undefined;

  const geminiThinkingLevel: GeminiThinkingLevel | undefined =
    geminiCandidate?.thinkingLevel === "LOW" || geminiCandidate?.thinkingLevel === "HIGH"
      ? geminiCandidate.thinkingLevel
      : undefined;
  const rawGeminiThinkingBudget =
    typeof geminiCandidate?.thinkingBudget === "number"
      ? geminiCandidate.thinkingBudget
      : typeof geminiCandidate?.thinkingBudget === "string"
        ? Number(geminiCandidate.thinkingBudget)
        : undefined;
  const geminiThinkingBudget: GeminiThinkingBudget | undefined =
    rawGeminiThinkingBudget === -1 ||
    rawGeminiThinkingBudget === 0 ||
    rawGeminiThinkingBudget === 512
      ? rawGeminiThinkingBudget
      : undefined;
  const gemini =
    geminiThinkingLevel !== undefined || geminiThinkingBudget !== undefined
      ? {
          ...(geminiThinkingLevel !== undefined ? { thinkingLevel: geminiThinkingLevel } : {}),
          ...(geminiThinkingBudget !== undefined ? { thinkingBudget: geminiThinkingBudget } : {}),
        }
      : undefined;

  if (!codex && !claude && !gemini) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(gemini ? { gemini } : {}),
  };
}

function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
    legacyCodex?: LegacyCodexFields;
  },
): ModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const provider = normalizeProviderKind(candidate?.provider ?? legacy?.provider);
  if (provider === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  const inferredClaudeContextWindow =
    provider === "claudeAgent" && /\[1m\]$/iu.test(rawModel) ? "1m" : undefined;
  const model = normalizeModelSlug(rawModel, provider);
  if (!model) {
    return null;
  }
  const modelOptions = normalizeProviderModelOptions(
    candidate?.options ? { [provider]: candidate.options } : legacy?.modelOptions,
    provider,
    provider === "codex" ? legacy?.legacyCodex : undefined,
  );
  const options =
    provider === "codex"
      ? modelOptions?.codex
      : provider === "claudeAgent"
        ? inferredClaudeContextWindow !== undefined
          ? {
              ...modelOptions?.claudeAgent,
              contextWindow:
                modelOptions?.claudeAgent?.contextWindow ?? inferredClaudeContextWindow,
            }
          : modelOptions?.claudeAgent
        : modelOptions?.gemini;
  return buildModelSelection(provider, model, options);
}

// ── Legacy sync helpers (used only during migration from v2 storage) ──

function legacySyncModelSelectionOptions(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): ModelSelection | null {
  if (modelSelection === null) {
    return null;
  }
  const options = modelOptions?.[modelSelection.provider];
  return buildModelSelection(modelSelection.provider, modelSelection.model, options);
}

function legacyMergeModelSelectionIntoProviderModelOptions(
  modelSelection: ModelSelection | null,
  currentModelOptions: ProviderModelOptions | null | undefined,
): ProviderModelOptions | null {
  if (modelSelection?.options === undefined) {
    return normalizeProviderModelOptions(currentModelOptions);
  }
  return legacyReplaceProviderModelOptions(
    normalizeProviderModelOptions(currentModelOptions),
    modelSelection.provider,
    modelSelection.options,
  );
}

function legacyReplaceProviderModelOptions(
  currentModelOptions: ProviderModelOptions | null | undefined,
  provider: ProviderKind,
  nextProviderOptions: ProviderModelOptions[ProviderKind] | null | undefined,
): ProviderModelOptions | null {
  const { [provider]: _discardedProviderModelOptions, ...otherProviderModelOptions } =
    currentModelOptions ?? {};
  const normalizedNextProviderOptions = normalizeProviderModelOptions(
    { [provider]: nextProviderOptions },
    provider,
  );

  return normalizeProviderModelOptions({
    ...otherProviderModelOptions,
    ...(normalizedNextProviderOptions ? normalizedNextProviderOptions : {}),
  });
}

// ── New helpers for the consolidated representation ────────────────────

function legacyToModelSelectionByProvider(
  modelSelection: ModelSelection | null,
  modelOptions: ProviderModelOptions | null | undefined,
): Partial<Record<ProviderKind, ModelSelection>> {
  const result: Partial<Record<ProviderKind, ModelSelection>> = {};
  // Add entries from the options bag (for non-active providers)
  if (modelOptions) {
    for (const provider of ["codex", "claudeAgent", "gemini"] as const) {
      const options = modelOptions[provider];
      if (options && Object.keys(options).length > 0) {
        result[provider] = buildModelSelection(
          provider,
          modelSelection?.provider === provider ? modelSelection.model : getDefaultModel(provider),
          options,
        );
      }
    }
  }
  // Add/overwrite the active selection (it's authoritative for its provider)
  if (modelSelection) {
    result[modelSelection.provider] = modelSelection;
  }
  return result;
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
}): EffectiveComposerModelState {
  const baseModel = resolveModelSlugForProvider(
    input.selectedProvider,
    input.threadModelSelection?.model ??
      input.projectModelSelection?.model ??
      getDefaultModel(input.selectedProvider),
  );
  const activeSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const selectedModel = activeSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.customModelsByProvider,
        activeSelection.model,
      )
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerModelOptionsFromSelection(input.threadModelSelection) ??
    providerModelOptionsFromSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

// Resolve the model we should persist for a draft-backed thread promotion.
// This keeps terminal-first thread creation aligned with the composer precedence.
export function resolvePreferredComposerModelSelection(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  defaultProvider?: ProviderKind | null | undefined;
}): ModelSelection {
  const draftProviderWithSelection =
    (["codex", "claudeAgent", "gemini"] as const).find(
      (provider) => input.draft?.modelSelectionByProvider?.[provider] !== undefined,
    ) ?? null;
  const preferredProvider =
    input.draft?.activeProvider ??
    draftProviderWithSelection ??
    input.threadModelSelection?.provider ??
    input.projectModelSelection?.provider ??
    input.defaultProvider ??
    "codex";

  return (
    input.draft?.modelSelectionByProvider?.[preferredProvider] ??
    (input.threadModelSelection?.provider === preferredProvider
      ? input.threadModelSelection
      : null) ??
    (input.projectModelSelection?.provider === preferredProvider
      ? input.projectModelSelection
      : null) ?? {
      provider: preferredProvider,
      model: getDefaultModel(preferredProvider),
    }
  );
}

function revokeObjectPreviewUrl(previewUrl: string): void {
  if (typeof URL === "undefined") {
    return;
  }
  if (!previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

function revokeQueuedTurnPreviewUrls(queuedTurn: QueuedComposerTurn): void {
  if (queuedTurn.kind !== "chat") {
    return;
  }
  for (const image of queuedTurn.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
}

// Release any preview URLs still owned by this draft before we drop it from the store.
function revokeDraftPreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
  for (const queuedTurn of draft.queuedTurns) {
    revokeQueuedTurnPreviewUrls(queuedTurn);
  }
}

function normalizePersistedAttachment(value: unknown): PersistedComposerImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const name = candidate.name;
  const mimeType = candidate.mimeType;
  const sizeBytes = candidate.sizeBytes;
  const dataUrl = candidate.dataUrl;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    typeof dataUrl !== "string" ||
    id.length === 0 ||
    dataUrl.length === 0
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    dataUrl,
  };
}

function normalizePersistedTerminalContextDraft(
  value: unknown,
): PersistedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = candidate.id;
  const threadId = candidate.threadId;
  const createdAt = candidate.createdAt;
  const lineStart = candidate.lineStart;
  const lineEnd = candidate.lineEnd;
  if (
    typeof id !== "string" ||
    id.length === 0 ||
    typeof threadId !== "string" ||
    threadId.length === 0 ||
    typeof createdAt !== "string" ||
    createdAt.length === 0 ||
    typeof lineStart !== "number" ||
    !Number.isFinite(lineStart) ||
    typeof lineEnd !== "number" ||
    !Number.isFinite(lineEnd)
  ) {
    return null;
  }
  const terminalId = typeof candidate.terminalId === "string" ? candidate.terminalId.trim() : "";
  const terminalLabel =
    typeof candidate.terminalLabel === "string" ? candidate.terminalLabel.trim() : "";
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const normalizedLineStart = Math.max(1, Math.floor(lineStart));
  const normalizedLineEnd = Math.max(normalizedLineStart, Math.floor(lineEnd));
  return {
    id,
    threadId: threadId as ThreadId,
    createdAt,
    terminalId,
    terminalLabel,
    lineStart: normalizedLineStart,
    lineEnd: normalizedLineEnd,
  };
}

function normalizePersistedQueuedTerminalContextDraft(
  value: unknown,
): PersistedQueuedTerminalContextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const base = normalizePersistedTerminalContextDraft(candidate);
  if (!base) {
    return null;
  }
  const text =
    typeof candidate.text === "string" ? normalizeTerminalContextText(candidate.text) : "";
  return {
    ...base,
    text,
  };
}

function persistImageAttachmentFromDataUrl(input: {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}): PersistedComposerImageAttachment | null {
  return normalizePersistedAttachment(input);
}

function persistQueuedComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  return images.flatMap((image) => {
    if (!image.previewUrl.startsWith("data:")) {
      return [];
    }
    const normalized = persistImageAttachmentFromDataUrl({
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: image.previewUrl,
    });
    return normalized ? [normalized] : [];
  });
}

function normalizePersistedQueuedTurns(
  rawQueuedTurns: unknown,
): DeepMutable<NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>> | undefined {
  if (!Array.isArray(rawQueuedTurns)) {
    return undefined;
  }
  const normalizedTurns: DeepMutable<
    NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>
  > = [];
  const seenIds = new Set<string>();
  for (const entry of rawQueuedTurns) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const kind = candidate.kind;
    const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
    const previewText = typeof candidate.previewText === "string" ? candidate.previewText : "";
    const selectedProvider = normalizeProviderKind(candidate.selectedProvider);
    const selectedModel =
      candidate.selectedModel === null
        ? null
        : typeof candidate.selectedModel === "string"
          ? candidate.selectedModel
          : null;
    const selectedPromptEffort =
      candidate.selectedPromptEffort === null
        ? null
        : typeof candidate.selectedPromptEffort === "string"
          ? candidate.selectedPromptEffort
          : null;
    const modelSelection = normalizeModelSelection(candidate.modelSelection);
    const providerOptionsForDispatch = Schema.is(ProviderStartOptions)(
      candidate.providerOptionsForDispatch,
    )
      ? candidate.providerOptionsForDispatch
      : undefined;
    const runtimeMode =
      candidate.runtimeMode === "approval-required" || candidate.runtimeMode === "full-access"
        ? candidate.runtimeMode
        : null;
    if (
      id.length === 0 ||
      createdAt.length === 0 ||
      previewText.length === 0 ||
      selectedProvider === null ||
      modelSelection === null ||
      runtimeMode === null ||
      seenIds.has(id)
    ) {
      continue;
    }
    if (kind === "chat") {
      const prompt = typeof candidate.prompt === "string" ? candidate.prompt : "";
      const images = Array.isArray(candidate.images)
        ? candidate.images.flatMap((image) => {
            const normalized = normalizePersistedAttachment(image);
            return normalized ? [normalized] : [];
          })
        : [];
      const terminalContexts = Array.isArray(candidate.terminalContexts)
        ? candidate.terminalContexts.flatMap((context) => {
            const normalized = normalizePersistedQueuedTerminalContextDraft(context);
            return normalized ? [normalized] : [];
          })
        : [];
      const skills = Array.isArray(candidate.skills)
        ? candidate.skills.filter(Schema.is(ProviderSkillReference))
        : [];
      const mentions = Array.isArray(candidate.mentions)
        ? candidate.mentions.filter(Schema.is(ProviderMentionReference))
        : [];
      const interactionMode =
        candidate.interactionMode === "default" || candidate.interactionMode === "plan"
          ? candidate.interactionMode
          : null;
      const envMode =
        candidate.envMode === "local" || candidate.envMode === "worktree"
          ? candidate.envMode
          : null;
      if (interactionMode === null || envMode === null) {
        continue;
      }
      normalizedTurns.push({
        id,
        kind: "chat",
        createdAt,
        previewText,
        prompt,
        images,
        terminalContexts,
        skills: [...skills],
        mentions: [...mentions],
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        modelSelection,
        ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
        runtimeMode,
        interactionMode,
        envMode,
      });
      seenIds.add(id);
      continue;
    }
    if (kind === "plan-follow-up") {
      const text = typeof candidate.text === "string" ? candidate.text : "";
      const interactionMode =
        candidate.interactionMode === "default" || candidate.interactionMode === "plan"
          ? candidate.interactionMode
          : null;
      if (interactionMode === null) {
        continue;
      }
      normalizedTurns.push({
        id,
        kind: "plan-follow-up",
        createdAt,
        previewText,
        text,
        interactionMode,
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        modelSelection,
        ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
        runtimeMode,
      });
      seenIds.add(id);
    }
  }
  return normalizedTurns.length > 0 ? normalizedTurns : undefined;
}

function normalizeDraftThreadEnvMode(
  value: unknown,
  fallbackWorktreePath: string | null,
): DraftThreadEnvMode {
  if (value === "local" || value === "worktree") {
    return value;
  }
  return fallbackWorktreePath ? "worktree" : "local";
}

function normalizeDraftThreadEntryPoint(value: unknown, fallback: ThreadPrimarySurface = "chat") {
  return value === "terminal" || value === "chat" ? value : fallback;
}

function normalizePersistedDraftThreads(
  rawDraftThreadsByThreadId: unknown,
  rawProjectDraftThreadIdByProjectId: unknown,
): Pick<
  PersistedComposerDraftStoreState,
  "draftThreadsByThreadId" | "projectDraftThreadIdByProjectId"
> {
  const draftThreadsByThreadId: Record<ThreadId, PersistedDraftThreadState> = {};
  if (rawDraftThreadsByThreadId && typeof rawDraftThreadsByThreadId === "object") {
    for (const [threadId, rawDraftThread] of Object.entries(
      rawDraftThreadsByThreadId as Record<string, unknown>,
    )) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        continue;
      }
      if (!rawDraftThread || typeof rawDraftThread !== "object") {
        continue;
      }
      const candidateDraftThread = rawDraftThread as Record<string, unknown>;
      const projectId = candidateDraftThread.projectId;
      const createdAt = candidateDraftThread.createdAt;
      const branch = candidateDraftThread.branch;
      const worktreePath = candidateDraftThread.worktreePath;
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const isTemporary = candidateDraftThread.isTemporary === true ? true : undefined;
      if (typeof projectId !== "string" || projectId.length === 0) {
        continue;
      }
      draftThreadsByThreadId[threadId as ThreadId] = {
        projectId: projectId as ProjectId,
        createdAt:
          typeof createdAt === "string" && createdAt.length > 0
            ? createdAt
            : new Date().toISOString(),
        runtimeMode:
          candidateDraftThread.runtimeMode === "approval-required" ||
          candidateDraftThread.runtimeMode === "full-access"
            ? candidateDraftThread.runtimeMode
            : DEFAULT_RUNTIME_MODE,
        interactionMode:
          candidateDraftThread.interactionMode === "plan" ||
          candidateDraftThread.interactionMode === "default"
            ? candidateDraftThread.interactionMode
            : DEFAULT_INTERACTION_MODE,
        entryPoint: normalizeDraftThreadEntryPoint(candidateDraftThread.entryPoint),
        branch: typeof branch === "string" ? branch : null,
        worktreePath: normalizedWorktreePath,
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        ...(isTemporary ? { isTemporary: true } : {}),
      };
    }
  }

  const projectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
  if (
    rawProjectDraftThreadIdByProjectId &&
    typeof rawProjectDraftThreadIdByProjectId === "object"
  ) {
    for (const [mappingKey, threadId] of Object.entries(
      rawProjectDraftThreadIdByProjectId as Record<string, unknown>,
    )) {
      const projectId = projectIdFromDraftThreadMappingKey(mappingKey);
      const entryPoint = projectDraftThreadEntryPointFromKey(mappingKey);
      if (
        typeof projectId === "string" &&
        projectId.length > 0 &&
        typeof threadId === "string" &&
        threadId.length > 0
      ) {
        projectDraftThreadIdByProjectId[mappingKey] = threadId as ThreadId;
        if (!draftThreadsByThreadId[threadId as ThreadId]) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            projectId: projectId as ProjectId,
            createdAt: new Date().toISOString(),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            entryPoint,
            branch: null,
            worktreePath: null,
            envMode: "local",
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.projectId !== projectId) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            projectId: projectId as ProjectId,
          };
        } else if (draftThreadsByThreadId[threadId as ThreadId]?.entryPoint !== entryPoint) {
          draftThreadsByThreadId[threadId as ThreadId] = {
            ...draftThreadsByThreadId[threadId as ThreadId]!,
            entryPoint,
          };
        }
      }
    }
  }

  return { draftThreadsByThreadId, projectDraftThreadIdByProjectId };
}

function normalizePersistedDraftsByThreadId(
  rawDraftMap: unknown,
): PersistedComposerDraftStoreState["draftsByThreadId"] {
  if (!rawDraftMap || typeof rawDraftMap !== "object") {
    return {};
  }

  const nextDraftsByThreadId: DeepMutable<PersistedComposerDraftStoreState["draftsByThreadId"]> =
    {};
  for (const [threadId, draftValue] of Object.entries(rawDraftMap as Record<string, unknown>)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    if (!draftValue || typeof draftValue !== "object") {
      continue;
    }
    const draftCandidate = draftValue as PersistedComposerThreadDraftState;
    const promptCandidate = typeof draftCandidate.prompt === "string" ? draftCandidate.prompt : "";
    const attachments = Array.isArray(draftCandidate.attachments)
      ? draftCandidate.attachments.flatMap((entry) => {
          const normalized = normalizePersistedAttachment(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const terminalContexts = Array.isArray(draftCandidate.terminalContexts)
      ? draftCandidate.terminalContexts.flatMap((entry) => {
          const normalized = normalizePersistedTerminalContextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const queuedTurns = normalizePersistedQueuedTurns(draftCandidate.queuedTurns);
    const runtimeMode =
      draftCandidate.runtimeMode === "approval-required" ||
      draftCandidate.runtimeMode === "full-access"
        ? draftCandidate.runtimeMode
        : null;
    const interactionMode =
      draftCandidate.interactionMode === "plan" || draftCandidate.interactionMode === "default"
        ? draftCandidate.interactionMode
        : null;
    const prompt = ensureInlineTerminalContextPlaceholders(
      promptCandidate,
      terminalContexts.length,
    );
    // If the draft already has the v3 shape, use it directly
    const legacyDraftCandidate = draftValue as LegacyPersistedComposerThreadDraftState;
    let modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
    let activeProvider: ProviderKind | null = null;

    if (
      draftCandidate.modelSelectionByProvider &&
      typeof draftCandidate.modelSelectionByProvider === "object"
    ) {
      // v3 format
      modelSelectionByProvider = draftCandidate.modelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
      activeProvider = normalizeProviderKind(draftCandidate.activeProvider);
    } else {
      // v2 or legacy format: migrate
      const normalizedModelOptions =
        normalizeProviderModelOptions(
          legacyDraftCandidate.modelOptions,
          undefined,
          legacyDraftCandidate,
        ) ?? null;
      const normalizedModelSelection = normalizeModelSelection(
        legacyDraftCandidate.modelSelection,
        {
          provider: legacyDraftCandidate.provider,
          model: legacyDraftCandidate.model,
          modelOptions: normalizedModelOptions ?? legacyDraftCandidate.modelOptions,
          legacyCodex: legacyDraftCandidate,
        },
      );
      const mergedModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
        normalizedModelSelection,
        normalizedModelOptions,
      );
      const modelSelection = legacySyncModelSelectionOptions(
        normalizedModelSelection,
        mergedModelOptions,
      );
      modelSelectionByProvider = legacyToModelSelectionByProvider(
        modelSelection,
        mergedModelOptions,
      );
      activeProvider = modelSelection?.provider ?? null;
    }

    const normalizedQueuedTurns = queuedTurns ?? [];
    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    const hasQueuedTurns = normalizedQueuedTurns.length > 0;
    if (
      promptCandidate.length === 0 &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      !hasQueuedTurns &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      attachments,
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(hasQueuedTurns ? { queuedTurns: normalizedQueuedTurns } : {}),
      ...(hasModelData ? { modelSelectionByProvider, activeProvider } : {}),
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(interactionMode ? { interactionMode } : {}),
    };
  }

  return nextDraftsByThreadId;
}

function migratePersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const candidate = persistedState as LegacyPersistedComposerDraftStoreState;
  const rawDraftMap = candidate.draftsByThreadId;
  const rawDraftThreadsByThreadId = candidate.draftThreadsByThreadId;
  const rawProjectDraftThreadIdByProjectId = candidate.projectDraftThreadIdByProjectId;

  // Migrate sticky state from v2 (dual) to v3 (consolidated)
  const stickyModelOptions = normalizeProviderModelOptions(candidate.stickyModelOptions) ?? {};
  const normalizedStickyModelSelection = normalizeModelSelection(candidate.stickyModelSelection, {
    provider: candidate.stickyProvider ?? "codex",
    model: candidate.stickyModel,
    modelOptions: stickyModelOptions,
  });
  const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
    normalizedStickyModelSelection,
    stickyModelOptions,
  );
  const stickyModelSelection = legacySyncModelSelectionOptions(
    normalizedStickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
    stickyModelSelection,
    nextStickyModelOptions,
  );
  const stickyActiveProvider = normalizeProviderKind(candidate.stickyProvider) ?? null;

  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(rawDraftThreadsByThreadId, rawProjectDraftThreadIdByProjectId);
  const draftsByThreadId = normalizePersistedDraftsByThreadId(rawDraftMap);
  return {
    draftsByThreadId,
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}

function partializeComposerDraftStoreState(
  state: ComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const persistedDraftsByThreadId: DeepMutable<
    PersistedComposerDraftStoreState["draftsByThreadId"]
  > = {};
  for (const [threadId, draft] of Object.entries(state.draftsByThreadId)) {
    if (typeof threadId !== "string" || threadId.length === 0) {
      continue;
    }
    const persistedQueuedTurns: DeepMutable<
      NonNullable<PersistedComposerThreadDraftState["queuedTurns"]>
    > = [];
    for (const queuedTurn of draft.queuedTurns) {
      if (queuedTurn.kind === "chat") {
        const images = persistQueuedComposerImages(queuedTurn.images);
        if (images.length !== queuedTurn.images.length) {
          continue;
        }
        persistedQueuedTurns.push({
          id: queuedTurn.id,
          kind: "chat",
          createdAt: queuedTurn.createdAt,
          previewText: queuedTurn.previewText,
          prompt: queuedTurn.prompt,
          images,
          terminalContexts: queuedTurn.terminalContexts.map((context) => ({
            id: context.id,
            threadId: context.threadId,
            createdAt: context.createdAt,
            terminalId: context.terminalId,
            terminalLabel: context.terminalLabel,
            lineStart: context.lineStart,
            lineEnd: context.lineEnd,
            text: context.text,
          })),
          skills: [...queuedTurn.skills],
          mentions: [...queuedTurn.mentions],
          selectedProvider: queuedTurn.selectedProvider,
          selectedModel: queuedTurn.selectedModel,
          selectedPromptEffort: queuedTurn.selectedPromptEffort,
          modelSelection: queuedTurn.modelSelection,
          ...(queuedTurn.providerOptionsForDispatch
            ? { providerOptionsForDispatch: queuedTurn.providerOptionsForDispatch }
            : {}),
          runtimeMode: queuedTurn.runtimeMode,
          interactionMode: queuedTurn.interactionMode,
          envMode: queuedTurn.envMode,
        });
        continue;
      }
      persistedQueuedTurns.push({
        id: queuedTurn.id,
        kind: "plan-follow-up",
        createdAt: queuedTurn.createdAt,
        previewText: queuedTurn.previewText,
        text: queuedTurn.text,
        interactionMode: queuedTurn.interactionMode,
        selectedProvider: queuedTurn.selectedProvider,
        selectedModel: queuedTurn.selectedModel,
        selectedPromptEffort: queuedTurn.selectedPromptEffort,
        modelSelection: queuedTurn.modelSelection,
        ...(queuedTurn.providerOptionsForDispatch
          ? { providerOptionsForDispatch: queuedTurn.providerOptionsForDispatch }
          : {}),
        runtimeMode: queuedTurn.runtimeMode,
      });
    }
    const hasModelData =
      Object.keys(draft.modelSelectionByProvider).length > 0 || draft.activeProvider !== null;
    const hasQueuedTurns = persistedQueuedTurns.length > 0;
    if (
      draft.prompt.length === 0 &&
      draft.persistedAttachments.length === 0 &&
      draft.terminalContexts.length === 0 &&
      !hasQueuedTurns &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      attachments: draft.persistedAttachments,
      ...(draft.terminalContexts.length > 0
        ? {
            terminalContexts: draft.terminalContexts.map((context) => ({
              id: context.id,
              threadId: context.threadId,
              createdAt: context.createdAt,
              terminalId: context.terminalId,
              terminalLabel: context.terminalLabel,
              lineStart: context.lineStart,
              lineEnd: context.lineEnd,
            })),
          }
        : {}),
      ...(hasQueuedTurns ? { queuedTurns: persistedQueuedTurns } : {}),
      ...(hasModelData
        ? {
            modelSelectionByProvider: draft.modelSelectionByProvider,
            activeProvider: draft.activeProvider,
          }
        : {}),
      ...(draft.runtimeMode ? { runtimeMode: draft.runtimeMode } : {}),
      ...(draft.interactionMode ? { interactionMode: draft.interactionMode } : {}),
    };
    persistedDraftsByThreadId[threadId as ThreadId] = persistedDraft;
  }
  return {
    draftsByThreadId: persistedDraftsByThreadId,
    draftThreadsByThreadId: state.draftThreadsByThreadId,
    projectDraftThreadIdByProjectId: state.projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider: state.stickyModelSelectionByProvider,
    stickyActiveProvider: state.stickyActiveProvider,
  };
}

function normalizeCurrentPersistedComposerDraftStoreState(
  persistedState: unknown,
): PersistedComposerDraftStoreState {
  if (!persistedState || typeof persistedState !== "object") {
    return EMPTY_PERSISTED_DRAFT_STORE_STATE;
  }
  const normalizedPersistedState = persistedState as LegacyPersistedComposerDraftStoreState;
  const { draftThreadsByThreadId, projectDraftThreadIdByProjectId } =
    normalizePersistedDraftThreads(
      normalizedPersistedState.draftThreadsByThreadId,
      normalizedPersistedState.projectDraftThreadIdByProjectId,
    );

  // Handle both v3 (modelSelectionByProvider) and v2/legacy formats
  let stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> = {};
  let stickyActiveProvider: ProviderKind | null = null;
  if (
    normalizedPersistedState.stickyModelSelectionByProvider &&
    typeof normalizedPersistedState.stickyModelSelectionByProvider === "object"
  ) {
    stickyModelSelectionByProvider =
      normalizedPersistedState.stickyModelSelectionByProvider as Partial<
        Record<ProviderKind, ModelSelection>
      >;
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyActiveProvider);
  } else {
    // Legacy migration path
    const stickyModelOptions =
      normalizeProviderModelOptions(normalizedPersistedState.stickyModelOptions) ?? {};
    const normalizedStickyModelSelection = normalizeModelSelection(
      normalizedPersistedState.stickyModelSelection,
      {
        provider: normalizedPersistedState.stickyProvider,
        model: normalizedPersistedState.stickyModel,
        modelOptions: stickyModelOptions,
      },
    );
    const nextStickyModelOptions = legacyMergeModelSelectionIntoProviderModelOptions(
      normalizedStickyModelSelection,
      stickyModelOptions,
    );
    const stickyModelSelection = legacySyncModelSelectionOptions(
      normalizedStickyModelSelection,
      nextStickyModelOptions,
    );
    stickyModelSelectionByProvider = legacyToModelSelectionByProvider(
      stickyModelSelection,
      nextStickyModelOptions,
    );
    stickyActiveProvider = normalizeProviderKind(normalizedPersistedState.stickyProvider);
  }

  return {
    draftsByThreadId: normalizePersistedDraftsByThreadId(normalizedPersistedState.draftsByThreadId),
    draftThreadsByThreadId,
    projectDraftThreadIdByProjectId,
    stickyModelSelectionByProvider,
    stickyActiveProvider,
  };
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): string[] {
  if (threadId.length === 0) {
    return [];
  }
  try {
    const persisted = getLocalStorageItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      PersistedComposerDraftStoreStorage,
    );
    if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) {
      return [];
    }
    return (persisted.state.draftsByThreadId[threadId]?.attachments ?? []).map(
      (attachment) => attachment.id,
    );
  } catch {
    return [];
  }
}

function verifyPersistedAttachments(
  threadId: ThreadId,
  attachments: PersistedComposerImageAttachment[],
  set: (
    partial:
      | ComposerDraftStoreState
      | Partial<ComposerDraftStoreState>
      | ((
          state: ComposerDraftStoreState,
        ) => ComposerDraftStoreState | Partial<ComposerDraftStoreState>),
    replace?: false,
  ) => void,
): void {
  let persistedIdSet = new Set<string>();
  try {
    composerDebouncedStorage.flush();
    persistedIdSet = new Set(readPersistedAttachmentIdsFromStorage(threadId));
  } catch {
    persistedIdSet = new Set();
  }
  set((state) => {
    const current = state.draftsByThreadId[threadId];
    if (!current) {
      return state;
    }
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const persistedAttachments = attachments.filter(
      (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
    );
    const nonPersistedImageIds = current.images
      .map((image) => image.id)
      .filter((imageId) => !persistedIdSet.has(imageId));
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      persistedAttachments,
      nonPersistedImageIds,
    };
    const nextDraftsByThreadId = { ...state.draftsByThreadId };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadId[threadId];
    } else {
      nextDraftsByThreadId[threadId] = nextDraft;
    }
    return { draftsByThreadId: nextDraftsByThreadId };
  });
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  const commaIndex = attachment.dataUrl.indexOf(",");
  const header = commaIndex === -1 ? attachment.dataUrl : attachment.dataUrl.slice(0, commaIndex);
  const payload = commaIndex === -1 ? "" : attachment.dataUrl.slice(commaIndex + 1);
  if (payload.length === 0) {
    return null;
  }
  try {
    const isBase64 = header.includes(";base64");
    if (!isBase64) {
      const decodedText = decodeURIComponent(payload);
      const inferredMimeType =
        header.startsWith("data:") && header.includes(";")
          ? header.slice("data:".length, header.indexOf(";"))
          : attachment.mimeType;
      return new File([decodedText], attachment.name, {
        type: inferredMimeType || attachment.mimeType,
      });
    }
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new File([bytes], attachment.name, { type: attachment.mimeType });
  } catch {
    return null;
  }
}

function hydrateImagesFromPersisted(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): ComposerImageAttachment[] {
  return attachments.flatMap((attachment) => {
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl: attachment.dataUrl,
        file,
      } satisfies ComposerImageAttachment,
    ];
  });
}

function hydrateQueuedTurnsFromPersisted(
  threadId: ThreadId,
  queuedTurns: ReadonlyArray<PersistedQueuedComposerTurn> | undefined,
): QueuedComposerTurn[] {
  if (!queuedTurns || queuedTurns.length === 0) {
    return [];
  }
  return queuedTurns.map((queuedTurn) => {
    if (queuedTurn.kind === "chat") {
      return {
        ...queuedTurn,
        images: hydrateImagesFromPersisted(queuedTurn.images),
        terminalContexts: normalizeTerminalContextsForThread(threadId, queuedTurn.terminalContexts),
        skills: [...queuedTurn.skills],
        mentions: [...queuedTurn.mentions],
      };
    }
    return { ...queuedTurn };
  });
}

function toHydratedThreadDraft(
  threadId: ThreadId,
  persistedDraft: PersistedComposerThreadDraftState,
): ComposerThreadDraftState {
  // The persisted draft is already in v3 shape (migration handles older formats)
  const modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>> =
    persistedDraft.modelSelectionByProvider ?? {};
  const activeProvider = normalizeProviderKind(persistedDraft.activeProvider) ?? null;

  return {
    prompt: persistedDraft.prompt,
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    queuedTurns: hydrateQueuedTurnsFromPersisted(threadId, persistedDraft.queuedTurns),
    modelSelectionByProvider,
    activeProvider,
    runtimeMode: persistedDraft.runtimeMode ?? null,
    interactionMode: persistedDraft.interactionMode ?? null,
  };
}

export const useComposerDraftStore = create<ComposerDraftStoreState>()(
  persist(
    (set, get) => ({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
      getDraftThreadByProjectId: (projectId, entryPoint = "chat") => {
        if (projectId.length === 0) {
          return null;
        }
        const threadId =
          get().projectDraftThreadIdByProjectId[
            projectDraftThreadMappingKey(projectId, entryPoint)
          ];
        if (!threadId) {
          return null;
        }
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (
          !draftThread ||
          draftThread.projectId !== projectId ||
          normalizeDraftThreadEntryPoint(draftThread.entryPoint) !== entryPoint
        ) {
          return null;
        }
        return {
          threadId,
          ...draftThread,
        };
      },
      getDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return null;
        }
        return get().draftThreadsByThreadId[threadId] ?? null;
      },
      setProjectDraftThreadId: (projectId, threadId, options) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const existingThread = state.draftThreadsByThreadId[threadId];
          const entryPoint = normalizeDraftThreadEntryPoint(
            options?.entryPoint,
            existingThread?.entryPoint ?? "chat",
          );
          const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[mappingKey];
          const nextWorktreePath =
            options?.worktreePath === undefined
              ? (existingThread?.worktreePath ?? null)
              : (options.worktreePath ?? null);
          const nextIsTemporary =
            options?.isTemporary === true
              ? true
              : options?.isTemporary === false
                ? false
                : existingThread?.isTemporary === true;
          const nextDraftThread: DraftThreadState = {
            projectId,
            createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
            runtimeMode:
              options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode:
              options?.interactionMode ??
              existingThread?.interactionMode ??
              DEFAULT_INTERACTION_MODE,
            entryPoint,
            branch:
              options?.branch === undefined
                ? (existingThread?.branch ?? null)
                : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options?.envMode ??
              (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
            ...(nextIsTemporary ? { isTemporary: true } : {}),
          };
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          const hasSameDraftThread =
            existingThread &&
            existingThread.projectId === nextDraftThread.projectId &&
            existingThread.createdAt === nextDraftThread.createdAt &&
            existingThread.runtimeMode === nextDraftThread.runtimeMode &&
            existingThread.interactionMode === nextDraftThread.interactionMode &&
            existingThread.entryPoint === nextDraftThread.entryPoint &&
            existingThread.branch === nextDraftThread.branch &&
            existingThread.worktreePath === nextDraftThread.worktreePath &&
            existingThread.envMode === nextDraftThread.envMode &&
            (existingThread.isTemporary === true) === (nextDraftThread.isTemporary === true);
          if (hasSameProjectMapping && hasSameDraftThread) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
            [mappingKey]: threadId,
          };
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (
            previousThreadIdForProject &&
            previousThreadIdForProject !== threadId &&
            !Object.values(nextProjectDraftThreadIdByProjectId).includes(previousThreadIdForProject)
          ) {
            delete nextDraftThreadsByThreadId[previousThreadIdForProject];
            if (state.draftsByThreadId[previousThreadIdForProject] !== undefined) {
              revokeDraftPreviewUrls(state.draftsByThreadId[previousThreadIdForProject]);
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[previousThreadIdForProject];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextProjectId = options.projectId ?? existing.projectId;
          if (nextProjectId.length === 0) {
            return state;
          }
          const nextWorktreePath =
            options.worktreePath === undefined
              ? existing.worktreePath
              : (options.worktreePath ?? null);
          const nextEntryPoint = normalizeDraftThreadEntryPoint(
            options.entryPoint,
            existing.entryPoint,
          );
          const nextIsTemporary =
            options.isTemporary === true
              ? true
              : options.isTemporary === false
                ? false
                : existing.isTemporary === true;
          const nextDraftThread: DraftThreadState = {
            projectId: nextProjectId,
            createdAt:
              options.createdAt === undefined
                ? existing.createdAt
                : options.createdAt || existing.createdAt,
            runtimeMode: options.runtimeMode ?? existing.runtimeMode,
            interactionMode: options.interactionMode ?? existing.interactionMode,
            entryPoint: nextEntryPoint,
            branch: options.branch === undefined ? existing.branch : (options.branch ?? null),
            worktreePath: nextWorktreePath,
            envMode:
              options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
            ...(nextIsTemporary ? { isTemporary: true } : {}),
          };
          const isUnchanged =
            nextDraftThread.projectId === existing.projectId &&
            nextDraftThread.createdAt === existing.createdAt &&
            nextDraftThread.runtimeMode === existing.runtimeMode &&
            nextDraftThread.interactionMode === existing.interactionMode &&
            nextDraftThread.entryPoint === existing.entryPoint &&
            nextDraftThread.branch === existing.branch &&
            nextDraftThread.worktreePath === existing.worktreePath &&
            nextDraftThread.envMode === existing.envMode &&
            (nextDraftThread.isTemporary === true) === (existing.isTemporary === true);
          if (isUnchanged) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
            ...state.projectDraftThreadIdByProjectId,
          };
          for (const [mappingKey, mappedThreadId] of Object.entries(
            nextProjectDraftThreadIdByProjectId,
          )) {
            if (mappedThreadId === threadId) {
              delete nextProjectDraftThreadIdByProjectId[mappingKey];
            }
          }
          nextProjectDraftThreadIdByProjectId[
            projectDraftThreadMappingKey(nextProjectId, nextEntryPoint)
          ] = threadId;
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      clearProjectDraftThreadId: (projectId, entryPoint = "chat") => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const mappingKey = projectDraftThreadMappingKey(projectId, entryPoint);
          const threadId = state.projectDraftThreadIdByProjectId[mappingKey];
          if (threadId === undefined) {
            return state;
          }
          const { [mappingKey]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearProjectDraftThreads: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => {
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {};
          const removedThreadIds = new Set<ThreadId>();
          for (const [mappingKey, threadId] of Object.entries(
            state.projectDraftThreadIdByProjectId,
          )) {
            if (projectIdFromDraftThreadMappingKey(mappingKey) === projectId) {
              removedThreadIds.add(threadId);
              continue;
            }
            nextProjectDraftThreadIdByProjectId[mappingKey] = threadId;
          }
          if (removedThreadIds.size === 0) {
            return state;
          }
          const retainedThreadIds = new Set(Object.values(nextProjectDraftThreadIdByProjectId));
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          for (const threadId of removedThreadIds) {
            if (retainedThreadIds.has(threadId)) continue;
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
              if (nextDraftsByThreadId === state.draftsByThreadId) {
                nextDraftsByThreadId = { ...state.draftsByThreadId };
              }
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => {
          const matchingMappingKey = Object.entries(state.projectDraftThreadIdByProjectId).find(
            ([mappingKey, mappedThreadId]) =>
              projectIdFromDraftThreadMappingKey(mappingKey) === projectId &&
              mappedThreadId === threadId,
          )?.[0];
          if (!matchingMappingKey) {
            return state;
          }
          const { [matchingMappingKey]: _removed, ...restProjectMappingsRaw } =
            state.projectDraftThreadIdByProjectId;
          const restProjectMappings = restProjectMappingsRaw as Record<string, ThreadId>;
          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
          };
          let nextDraftsByThreadId = state.draftsByThreadId;
          if (!Object.values(restProjectMappings).includes(threadId)) {
            delete nextDraftThreadsByThreadId[threadId];
            if (state.draftsByThreadId[threadId] !== undefined) {
              revokeDraftPreviewUrls(state.draftsByThreadId[threadId]);
              nextDraftsByThreadId = { ...state.draftsByThreadId };
              delete nextDraftsByThreadId[threadId];
            }
          }
          return {
            draftsByThreadId: nextDraftsByThreadId,
            draftThreadsByThreadId: nextDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        revokeDraftPreviewUrls(get().draftsByThreadId[threadId]);
        set((state) => {
          const hasDraftThread = state.draftThreadsByThreadId[threadId] !== undefined;
          const hasProjectMapping = Object.values(state.projectDraftThreadIdByProjectId).includes(
            threadId,
          );
          const hasComposerDraft = state.draftsByThreadId[threadId] !== undefined;
          if (!hasDraftThread && !hasProjectMapping && !hasComposerDraft) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId = Object.fromEntries(
            Object.entries(state.projectDraftThreadIdByProjectId).filter(
              ([, draftThreadId]) => draftThreadId !== threadId,
            ),
          ) as Record<string, ThreadId>;
          const { [threadId]: _removedDraftThread, ...restDraftThreadsByThreadId } =
            state.draftThreadsByThreadId;
          const { [threadId]: _removedComposerDraft, ...restDraftsByThreadId } =
            state.draftsByThreadId;
          return {
            draftsByThreadId: restDraftsByThreadId,
            draftThreadsByThreadId: restDraftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      setStickyModelSelection: (modelSelection) => {
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          if (!normalized) {
            return state;
          }
          const nextMap: Partial<Record<ProviderKind, ModelSelection>> = {
            ...state.stickyModelSelectionByProvider,
            [normalized.provider]: normalized,
          };
          if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
            return state.stickyActiveProvider === normalized.provider
              ? state
              : { stickyActiveProvider: normalized.provider };
          }
          return {
            stickyModelSelectionByProvider: nextMap,
            stickyActiveProvider: normalized.provider,
          };
        });
      },
      applyStickyState: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const stickyMap = state.stickyModelSelectionByProvider;
          const stickyActiveProvider = state.stickyActiveProvider;
          if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
            return state;
          }
          const existing = state.draftsByThreadId[threadId];
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const [provider, selection] of Object.entries(stickyMap)) {
            if (selection) {
              const current = nextMap[provider as ProviderKind];
              nextMap[provider as ProviderKind] = {
                ...selection,
                model: current?.model ?? selection.model,
              };
            }
          }
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === stickyActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: stickyActiveProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt: ensureInlineTerminalContextPlaceholders(
              existing.prompt,
              normalizedContexts.length,
            ),
            terminalContexts: normalizedContexts,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelSelection: (threadId, modelSelection) => {
        if (threadId.length === 0) {
          return;
        }
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalized === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          if (normalized) {
            const current = nextMap[normalized.provider];
            if (normalized.options !== undefined) {
              // Explicit options provided → use them
              nextMap[normalized.provider] = normalized;
            } else {
              // No options in selection → preserve existing options, update provider+model
              nextMap[normalized.provider] = buildModelSelection(
                normalized.provider,
                normalized.model,
                current?.options,
              );
            }
          }
          const nextActiveProvider = normalized?.provider ?? base.activeProvider;
          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            base.activeProvider === nextActiveProvider
          ) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
            activeProvider: nextActiveProvider,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setModelOptions: (threadId, modelOptions) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedOpts = normalizeProviderModelOptions(modelOptions);
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && normalizedOpts === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          const nextMap = { ...base.modelSelectionByProvider };
          for (const provider of ["codex", "claudeAgent", "gemini"] as const) {
            // Only touch providers explicitly present in the input
            if (!normalizedOpts || !(provider in normalizedOpts)) continue;
            const opts = normalizedOpts[provider];
            const current = nextMap[provider];
            if (opts) {
              nextMap[provider] = buildModelSelection(
                provider,
                current?.model ?? getDefaultModel(provider),
                opts,
              );
            } else if (current?.options) {
              // Remove options but keep the selection
              nextMap[provider] = buildModelSelection(provider, current.model);
            }
          }
          if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setProviderModelOptions: (threadId, provider, nextProviderOptions, options) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedProvider = normalizeProviderKind(provider);
        if (normalizedProvider === null) {
          return;
        }
        // Normalize just this provider's options
        const normalizedOpts = normalizeProviderModelOptions(
          { [normalizedProvider]: nextProviderOptions },
          normalizedProvider,
        );
        const providerOpts = normalizedOpts?.[normalizedProvider];
        const fallbackModel =
          normalizeModelSlug(options?.model, normalizedProvider) ??
          getDefaultModel(normalizedProvider);

        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          const base = existing ?? createEmptyThreadDraft();

          // Update the map entry for this provider
          const nextMap = { ...base.modelSelectionByProvider };
          const currentForProvider = nextMap[normalizedProvider];
          if (providerOpts) {
            nextMap[normalizedProvider] = buildModelSelection(
              normalizedProvider,
              currentForProvider?.model ?? fallbackModel,
              providerOpts,
            );
          } else if (currentForProvider?.options) {
            nextMap[normalizedProvider] = buildModelSelection(
              normalizedProvider,
              currentForProvider.model,
            );
          }

          // Handle sticky persistence
          let nextStickyMap = state.stickyModelSelectionByProvider;
          let nextStickyActiveProvider = state.stickyActiveProvider;
          if (options?.persistSticky === true) {
            nextStickyMap = { ...state.stickyModelSelectionByProvider };
            const stickyBase =
              nextStickyMap[normalizedProvider] ??
              base.modelSelectionByProvider[normalizedProvider] ??
              buildModelSelection(normalizedProvider, fallbackModel);
            if (providerOpts) {
              nextStickyMap[normalizedProvider] = buildModelSelection(
                normalizedProvider,
                stickyBase.model,
                providerOpts,
              );
            } else if (stickyBase.options) {
              nextStickyMap[normalizedProvider] = buildModelSelection(
                normalizedProvider,
                stickyBase.model,
              );
            }
            nextStickyActiveProvider = base.activeProvider ?? normalizedProvider;
          }

          if (
            Equal.equals(base.modelSelectionByProvider, nextMap) &&
            Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
            state.stickyActiveProvider === nextStickyActiveProvider
          ) {
            return state;
          }

          const nextDraft: ComposerThreadDraftState = {
            ...base,
            modelSelectionByProvider: nextMap,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }

          return {
            draftsByThreadId: nextDraftsByThreadId,
            ...(options?.persistSticky === true
              ? {
                  stickyModelSelectionByProvider: nextStickyMap,
                  stickyActiveProvider: nextStickyActiveProvider,
                }
              : {}),
          };
        });
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextRuntimeMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.runtimeMode === nextRuntimeMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            runtimeMode: nextRuntimeMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if (!existing && nextInteractionMode === null) {
            return state;
          }
          const base = existing ?? createEmptyThreadDraft();
          if (base.interactionMode === nextInteractionMode) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...base,
            interactionMode: nextInteractionMode,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      // Keep queued follow-ups with the thread draft so route changes do not hide them.
      enqueueQueuedTurn: (threadId, queuedTurn) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                queuedTurns: [...existing.queuedTurns, queuedTurn],
              },
            },
          };
        });
      },
      insertQueuedTurn: (threadId, queuedTurn, index) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const boundedIndex = Math.max(0, Math.min(existing.queuedTurns.length, index));
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                queuedTurns: [
                  ...existing.queuedTurns.slice(0, boundedIndex),
                  queuedTurn,
                  ...existing.queuedTurns.slice(boundedIndex),
                ],
              },
            },
          };
        });
      },
      removeQueuedTurn: (threadId, queuedTurnId) => {
        if (threadId.length === 0 || queuedTurnId.length === 0) {
          return;
        }
        const removedQueuedTurn = get().draftsByThreadId[threadId]?.queuedTurns.find(
          (entry) => entry.id === queuedTurnId,
        );
        if (removedQueuedTurn) {
          revokeQueuedTurnPreviewUrls(removedQueuedTurn);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.queuedTurns.every((entry) => entry.id !== queuedTurnId)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            queuedTurns: current.queuedTurns.filter((entry) => entry.id !== queuedTurnId),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      addImage: (threadId, image) => {
        if (threadId.length === 0) {
          return;
        }
        get().addImages(threadId, [image]);
      },
      addImages: (threadId, images) => {
        if (threadId.length === 0 || images.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.images.map((image) => image.id));
          const existingDedupKeys = new Set(
            existing.images.map((image) => composerImageDedupKey(image)),
          );
          const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
          const dedupedIncoming: ComposerImageAttachment[] = [];
          for (const image of images) {
            const dedupKey = composerImageDedupKey(image);
            if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
              // Avoid revoking a blob URL that's still referenced by an accepted image.
              if (!acceptedPreviewUrls.has(image.previewUrl)) {
                revokeObjectPreviewUrl(image.previewUrl);
              }
              continue;
            }
            dedupedIncoming.push(image);
            existingIds.add(image.id);
            existingDedupKeys.add(dedupKey);
            acceptedPreviewUrls.add(image.previewUrl);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: [...existing.images, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeImage: (threadId, imageId) => {
        if (threadId.length === 0) {
          return;
        }
        const existing = get().draftsByThreadId[threadId];
        if (!existing) {
          return;
        }
        const removedImage = existing.images.find((image) => image.id === imageId);
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            images: current.images.filter((image) => image.id !== imageId),
            nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
            persistedAttachments: current.persistedAttachments.filter(
              (attachment) => attachment.id !== imageId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      insertTerminalContext: (threadId, prompt, context, index) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const normalizedContext = normalizeTerminalContextForThread(threadId, context);
          if (!normalizedContext) {
            return state;
          }
          const dedupKey = terminalContextDedupKey(normalizedContext);
          if (
            existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
            existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            prompt,
            terminalContexts: [
              ...existing.terminalContexts.slice(0, boundedIndex),
              normalizedContext,
              ...existing.terminalContexts.slice(boundedIndex),
            ],
          };
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: nextDraft,
            },
          };
        });
        return inserted;
      },
      addTerminalContext: (threadId, context) => {
        if (threadId.length === 0) {
          return;
        }
        get().addTerminalContexts(threadId, [context]);
      },
      addTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0 || contexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
            ...existing.terminalContexts,
            ...contexts,
          ]).slice(existing.terminalContexts.length);
          if (acceptedContexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  existing.terminalContexts.length + acceptedContexts.length,
                ),
                terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
              },
            },
          };
        });
      },
      removeTerminalContext: (threadId, contextId) => {
        if (threadId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: current.terminalContexts.filter(
              (context) => context.id !== contextId,
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearTerminalContexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.terminalContexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            persistedAttachments: [],
            nonPersistedImageIds: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            // Stage attempted attachments so persist middleware can try writing them.
            persistedAttachments: attachments,
            nonPersistedImageIds: current.nonPersistedImageIds.filter(
              (id) => !attachmentIdSet.has(id),
            ),
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        Promise.resolve().then(() => {
          verifyPersistedAttachments(threadId, attachments, set);
        });
      },
      copyTransferableComposerState: (sourceThreadId, targetThreadId) => {
        if (sourceThreadId.length === 0 || targetThreadId.length === 0) {
          return;
        }
        set((state) => {
          const sourceDraft = state.draftsByThreadId[sourceThreadId];
          if (!sourceDraft) {
            return state;
          }
          const nextDraft = buildTransferredComposerDraft({
            sourceDraft,
            targetDraft: state.draftsByThreadId[targetThreadId],
            targetThreadId,
          });
          const currentTargetDraft = state.draftsByThreadId[targetThreadId];
          if (Equal.equals(currentTargetDraft, nextDraft)) {
            return state;
          }
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[targetThreadId];
          } else {
            nextDraftsByThreadId[targetThreadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            images: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            terminalContexts: [],
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
      },
    }),
    {
      name: COMPOSER_DRAFT_STORAGE_KEY,
      version: COMPOSER_DRAFT_STORAGE_VERSION,
      storage: createJSONStorage(() => composerDebouncedStorage),
      migrate: migratePersistedComposerDraftStoreState,
      partialize: partializeComposerDraftStoreState,
      merge: (persistedState, currentState) => {
        const normalizedPersisted =
          normalizeCurrentPersistedComposerDraftStoreState(persistedState);
        const draftsByThreadId = Object.fromEntries(
          Object.entries(normalizedPersisted.draftsByThreadId).map(([threadId, draft]) => [
            threadId,
            toHydratedThreadDraft(threadId as ThreadId, draft),
          ]),
        );
        return {
          ...currentState,
          draftsByThreadId,
          draftThreadsByThreadId: normalizedPersisted.draftThreadsByThreadId,
          projectDraftThreadIdByProjectId: normalizedPersisted.projectDraftThreadIdByProjectId,
          stickyModelSelectionByProvider: normalizedPersisted.stickyModelSelectionByProvider ?? {},
          stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
        };
      },
    },
  ),
);

export function useComposerThreadDraft(threadId: ThreadId): ComposerThreadDraftState {
  return useComposerDraftStore((state) => state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT);
}

export function useEffectiveComposerModelState(input: {
  threadId: ThreadId;
  selectedProvider: ProviderKind;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  customModelsByProvider: Record<ProviderKind, readonly string[]>;
}): EffectiveComposerModelState {
  const draft = useComposerThreadDraft(input.threadId);

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        selectedProvider: input.selectedProvider,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        customModelsByProvider: input.customModelsByProvider,
      }),
    [
      draft,
      input.customModelsByProvider,
      input.projectModelSelection,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

/**
 * Clear draft threads that have been promoted to server threads.
 *
 * Call this after a snapshot sync so the route guard in `_chat.$threadId`
 * sees the server thread before the draft is removed — avoids a redirect
 * to `/` caused by a gap where neither draft nor server thread exists.
 */
export function clearPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.clearDraftThread(draftId);
    }
  }
}
