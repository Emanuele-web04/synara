// FILE: composerDraftStore.ts
// Purpose: Stores composer drafts, model selections, queued turns, and sticky provider choices.
// Layer: Web state store
// Depends on: contracts schemas, app model resolution helpers, and zustand persistence.

import {
  type ClaudeCodeEffort,
  type CodexReasoningEffort,
  type CursorModelOptions,
  type GeminiThinkingBudget,
  type GeminiThinkingLevel,
  GROK_REASONING_EFFORT_OPTIONS,
  type GrokReasoningEffort,
  type ModelSlug,
  OrchestrationProposedPlanId,
  type OrchestrationLatestTurn,
  type PiThinkingLevel,
  ModelSelection,
  OrchestrationThreadPullRequest,
  ProjectId,
  ProviderMentionReference,
  ProviderInteractionMode,
  ProviderKind,
  ProviderModelOptions,
  ProviderSkillReference,
  ProviderStartOptions,
  RuntimeMode,
  ThreadId,
} from "@synara/contracts";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import { DeepMutable } from "effect/Types";
import {
  getDefaultModel,
  normalizeModelSlug,
  resolveSelectableModel,
  resolveModelSlugForProvider,
} from "@synara/shared/model";
import { useMemo } from "react";
import { getLocalStorageItem } from "./hooks/useLocalStorage";
import { resolveAppModelSelection } from "./appSettings";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatAssistantSelectionAttachment,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type ThreadPrimarySurface,
} from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./lib/terminalContext";
import {
  type FileCommentDraft,
  type FileCommentSelection,
  normalizeFileCommentSelection,
} from "./lib/fileComments";
import {
  type PastedTextDraft,
  countPastedTextLines,
  createPastedTextDraft,
  normalizePastedTextContent,
} from "./lib/composerPastedText";
import { normalizeAssistantSelectionAttachment } from "./lib/assistantSelections";
import { cloneComposerImageAttachment } from "./lib/composerSend";
import { deleteComposerImageBlob } from "./lib/composerImageBlobStore";
import {
  type ComposerImageSource,
  normalizeComposerImageSource,
  toPersistedComposerImageSource,
} from "./lib/composerImageSource";
import { buildModelSelection } from "./providerModelOptions";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";

export const COMPOSER_DRAFT_STORAGE_KEY = "synara:composer-drafts:v1";
const COMPOSER_DRAFT_STORAGE_VERSION = 5;
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;
const DraftThreadEntryPointSchema = Schema.Literals(["chat", "terminal"]);
const COMPOSER_PROVIDER_KINDS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
] as const satisfies readonly ProviderKind[];
const isProviderKind = Schema.is(ProviderKind);
const GROK_REASONING_EFFORT_SET = new Set<string>(GROK_REASONING_EFFORT_OPTIONS);

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

const PersistedComposerAppSnapSource = Schema.Struct({
  kind: Schema.Literal("appsnap"),
  captureId: Schema.String,
  capturedAt: Schema.String,
  appName: Schema.NullOr(Schema.String),
  bundleIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  appIconDataUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  windowTitle: Schema.NullOr(Schema.String),
});
const LegacyPersistedComposerAppSnapSource = Schema.Struct({
  kind: Schema.Literal("appshot"),
  captureId: Schema.String,
  capturedAt: Schema.String,
  appName: Schema.NullOr(Schema.String),
  bundleIdentifier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  appIconDataUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  windowTitle: Schema.NullOr(Schema.String),
});

export const PersistedComposerImageAttachment = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  dataUrl: Schema.optionalKey(Schema.String),
  blobKey: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(
    Schema.Union([PersistedComposerAppSnapSource, LegacyPersistedComposerAppSnapSource]),
  ),
});
export type PersistedComposerImageAttachment = typeof PersistedComposerImageAttachment.Type;
export type ComposerAttachmentPersistenceResult = "persisted" | "rejected" | "unverified";

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
  source?: ComposerImageSource | undefined;
}

export interface ComposerFileAttachment extends ChatFileAttachment {
  file: File;
}

export interface ComposerPromptHistorySavedDraft {
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
}

export type ComposerAssistantSelectionAttachment = ChatAssistantSelectionAttachment;

export interface QueuedComposerChatTurn {
  id: string;
  kind: "chat";
  createdAt: string;
  previewText: string;
  prompt: string;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
  selectedProvider: ProviderKind;
  selectedModel: string | null;
  selectedPromptEffort: string | null;
  modelSelection: ModelSelection;
  providerOptionsForDispatch?: ProviderStartOptions | undefined;
  sourceProposedPlan?: NonNullable<OrchestrationLatestTurn["sourceProposedPlan"]> | undefined;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
}

export interface RestoredComposerSourceProposedPlan {
  threadId: ThreadId;
  restoredPrompt: string;
  sourceProposedPlan: NonNullable<OrchestrationLatestTurn["sourceProposedPlan"]>;
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

// File comments always carry their authored text (no live source to re-derive
// from), so a single schema covers both live drafts and queued turns.
const PersistedFileCommentDraft = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  startLine: Schema.Number,
  endLine: Schema.Number,
  text: Schema.String,
});
type PersistedFileCommentDraft = typeof PersistedFileCommentDraft.Type;

// Pasted text always carries its full content (the chip is the only copy), so a
// single schema covers both live drafts and queued turns. Line/char metrics are
// recomputed on hydration, so they are not persisted.
const PersistedPastedTextDraft = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.String,
  text: Schema.String,
});
type PersistedPastedTextDraft = typeof PersistedPastedTextDraft.Type;

const PersistedSourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

const PersistedRestoredSourceProposedPlan = Schema.Struct({
  threadId: ThreadId,
  restoredPrompt: Schema.String,
  sourceProposedPlan: PersistedSourceProposedPlanReference,
});

const PersistedAssistantSelectionDraft = Schema.Struct({
  id: Schema.String,
  assistantMessageId: Schema.String,
  text: Schema.String,
});
type PersistedAssistantSelectionDraft = typeof PersistedAssistantSelectionDraft.Type;

const PersistedQueuedComposerChatTurn = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literal("chat"),
  createdAt: Schema.String,
  previewText: Schema.String,
  prompt: Schema.String,
  images: Schema.Array(PersistedComposerImageAttachment),
  assistantSelections: Schema.optionalKey(Schema.Array(PersistedAssistantSelectionDraft)),
  terminalContexts: Schema.Array(PersistedQueuedTerminalContextDraft),
  fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
  pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
  skills: Schema.Array(ProviderSkillReference),
  mentions: Schema.Array(ProviderMentionReference),
  selectedProvider: ProviderKind,
  selectedModel: Schema.NullOr(Schema.String),
  selectedPromptEffort: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  providerOptionsForDispatch: Schema.optionalKey(ProviderStartOptions),
  sourceProposedPlan: Schema.optionalKey(PersistedSourceProposedPlanReference),
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

const PersistedComposerPromptHistorySavedDraft = Schema.Union([
  Schema.String,
  Schema.Struct({
    prompt: Schema.String,
    attachments: Schema.optionalKey(Schema.Array(PersistedComposerImageAttachment)),
    assistantSelections: Schema.optionalKey(Schema.Array(PersistedAssistantSelectionDraft)),
    terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
    fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
    pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
    skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  }),
]);
type PersistedComposerPromptHistorySavedDraft =
  typeof PersistedComposerPromptHistorySavedDraft.Type;

const PersistedComposerThreadDraftState = Schema.Struct({
  prompt: Schema.String,
  // Set only while composer prompt-history browsing is active: the user's real
  // draft snapshot, kept safe while `prompt` temporarily holds a recalled history entry.
  promptHistorySavedDraft: Schema.optionalKey(PersistedComposerPromptHistorySavedDraft),
  attachments: Schema.Array(PersistedComposerImageAttachment),
  assistantSelections: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        assistantMessageId: Schema.String,
        text: Schema.String,
      }),
    ),
  ),
  terminalContexts: Schema.optionalKey(Schema.Array(PersistedTerminalContextDraft)),
  fileComments: Schema.optionalKey(Schema.Array(PersistedFileCommentDraft)),
  pastedTexts: Schema.optionalKey(Schema.Array(PersistedPastedTextDraft)),
  skills: Schema.optionalKey(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optionalKey(Schema.Array(ProviderMentionReference)),
  queuedTurns: Schema.optionalKey(Schema.Array(PersistedQueuedComposerTurn)),
  restoredSourceProposedPlan: Schema.optionalKey(PersistedRestoredSourceProposedPlan),
  modelSelectionByProvider: Schema.optionalKey(
    Schema.Record(ProviderKind, Schema.optionalKey(ModelSelection)),
  ),
  activeProvider: Schema.optionalKey(Schema.NullOr(ProviderKind)),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
});
type PersistedComposerThreadDraftState = typeof PersistedComposerThreadDraftState.Type;

const LegacyCodexFields = Schema.Struct({
  effort: Schema.optionalKey(Schema.String),
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
  lastKnownPr: Schema.optionalKey(Schema.NullOr(OrchestrationThreadPullRequest)),
  envMode: DraftThreadEnvModeSchema,
  isTemporary: Schema.optionalKey(Schema.Boolean),
  promotedTo: Schema.optionalKey(ThreadId),
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

export interface ComposerThreadDraftState {
  prompt: string;
  // Non-null only while composer prompt-history browsing is active: the user's
  // real draft, kept safe while `prompt` temporarily holds a recalled history
  // entry. Restored (and cleared) when a browse is interrupted by a thread
  // switch or reload.
  promptHistorySavedDraft: ComposerPromptHistorySavedDraft | null;
  images: ComposerImageAttachment[];
  files: ComposerFileAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  terminalContexts: TerminalContextDraft[];
  fileComments: FileCommentDraft[];
  pastedTexts: PastedTextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
  queuedTurns: QueuedComposerTurn[];
  restoredSourceProposedPlan?: RestoredComposerSourceProposedPlan | null;
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
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  envMode: DraftThreadEnvMode;
  isTemporary?: boolean;
  promotedTo?: ThreadId;
}

interface DraftThreadMutationOptions {
  branch?: string | null;
  worktreePath?: string | null;
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  createdAt?: string;
  envMode?: DraftThreadEnvMode;
  runtimeMode?: RuntimeMode;
  interactionMode?: ProviderInteractionMode;
  entryPoint?: ThreadPrimarySurface;
  isTemporary?: boolean;
}

type DraftThreadCreatedAtMode = "accept-empty" | "preserve-existing-on-empty";

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
    options?: DraftThreadMutationOptions,
  ) => void;
  /**
   * Registers a standalone draft thread without claiming the project's
   * composer-draft mapping. Unlike setProjectDraftThreadId this never replaces
   * (and therefore never deletes) the mapped draft, so any number of standalone
   * drafts — e.g. kanban tasks — can coexist per project. Create-only: an
   * existing draft thread is left untouched.
   */
  registerDraftThread: (
    threadId: ThreadId,
    options: {
      projectId: ProjectId;
      createdAt?: string;
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      entryPoint?: ThreadPrimarySurface;
      isTemporary?: boolean;
    },
  ) => void;
  setDraftThreadContext: (
    threadId: ThreadId,
    options: DraftThreadMutationOptions & { projectId?: ProjectId },
  ) => void;
  /**
   * Moves an existing draft into a project's primary draft slot while deleting
   * the draft that used to occupy that slot, if no other project still maps it.
   */
  moveDraftThreadToProject: (
    threadId: ThreadId,
    projectId: ProjectId,
    options?: DraftThreadMutationOptions,
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId, entryPoint?: ThreadPrimarySurface) => void;
  clearProjectDraftThreads: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  markDraftThreadPromoting: (threadId: ThreadId, promotedTo?: ThreadId) => void;
  finalizePromotedDraftThread: (threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setPromptHistorySavedDraft: (
    threadId: ThreadId,
    savedDraft: ComposerPromptHistorySavedDraft | null,
  ) => void;
  restorePromptHistorySavedDraft: (threadId: ThreadId) => void;
  addPromptHistorySavedDraftImage: (threadId: ThreadId, image: ComposerImageAttachment) => void;
  syncPromptHistorySavedDraftPersistedAttachments: (
    threadId: ThreadId,
    attachments: PersistedComposerImageAttachment[],
  ) => Promise<ComposerAttachmentPersistenceResult>;
  setTerminalContexts: (threadId: ThreadId, contexts: TerminalContextDraft[]) => void;
  setSkills: (threadId: ThreadId, skills: ProviderSkillReference[]) => void;
  setMentions: (threadId: ThreadId, mentions: ProviderMentionReference[]) => void;
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
  addFiles: (threadId: ThreadId, files: ComposerFileAttachment[]) => void;
  removeFile: (threadId: ThreadId, fileId: string) => void;
  addAssistantSelection: (
    threadId: ThreadId,
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
  removeAssistantSelection: (threadId: ThreadId, selectionId: string) => void;
  clearAssistantSelections: (threadId: ThreadId) => void;
  addFileComment: (threadId: ThreadId, comment: FileCommentDraft) => boolean;
  removeFileComment: (threadId: ThreadId, commentId: string) => void;
  clearFileComments: (threadId: ThreadId) => void;
  addPastedTexts: (threadId: ThreadId, pastedTexts: PastedTextDraft[]) => void;
  removePastedText: (threadId: ThreadId, pastedTextId: string) => void;
  clearPastedTexts: (threadId: ThreadId) => void;
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
  ) => Promise<ComposerAttachmentPersistenceResult>;
  copyTransferableComposerState: (sourceThreadId: ThreadId, targetThreadId: ThreadId) => void;
  setRestoredSourceProposedPlan: (
    threadId: ThreadId,
    source: RestoredComposerSourceProposedPlan | null,
  ) => void;
  clearComposerContent: (
    threadId: ThreadId,
    options?: { readonly preservePreviewUrls?: boolean },
  ) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: ModelSlug;
  modelOptions: ProviderModelOptions | null;
}

function mergeProviderModelOptionsFromSelections(
  ...selections: ReadonlyArray<ModelSelection | null | undefined>
): ProviderModelOptions | null {
  const result: Partial<Record<ProviderKind, ProviderModelOptions[ProviderKind]>> = {};
  for (const selection of selections) {
    if (!selection) continue;
    if (selection.options) {
      result[selection.provider] = selection.options;
    } else {
      delete result[selection.provider];
    }
  }
  return Object.keys(result).length > 0 ? (result as ProviderModelOptions) : null;
}

function deriveEffectiveComposerModelOptions(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
}): ProviderModelOptions | null {
  const baseOptions = mergeProviderModelOptionsFromSelections(
    input.projectModelSelection,
    input.threadModelSelection,
  );
  const draftSelections = input.draft?.modelSelectionByProvider;
  if (!draftSelections) {
    return baseOptions;
  }

  const result: Partial<Record<ProviderKind, ProviderModelOptions[ProviderKind]>> = baseOptions
    ? { ...baseOptions }
    : {};
  for (const [provider, selection] of Object.entries(draftSelections) as Array<
    [ProviderKind, ModelSelection | undefined]
  >) {
    if (!selection) continue;
    if (selection.options) {
      result[provider] = selection.options;
    } else {
      delete result[provider];
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

function resolveDraftThreadCreatedAt(input: {
  createdAt: string | undefined;
  existingThread: DraftThreadState | undefined;
  mode: DraftThreadCreatedAtMode;
}): string {
  if (input.createdAt === undefined) {
    return input.existingThread?.createdAt ?? new Date().toISOString();
  }
  if (input.mode === "preserve-existing-on-empty") {
    return input.createdAt || input.existingThread?.createdAt || new Date().toISOString();
  }
  return input.createdAt;
}

function buildDraftThreadState(input: {
  projectId: ProjectId;
  existingThread?: DraftThreadState | undefined;
  options?: DraftThreadMutationOptions | undefined;
  createdAtMode: DraftThreadCreatedAtMode;
}): DraftThreadState {
  const { existingThread, options } = input;
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextEntryPoint = normalizeDraftThreadEntryPoint(
    options?.entryPoint,
    existingThread?.entryPoint ?? "chat",
  );
  const nextIsTemporary =
    options?.isTemporary === true
      ? true
      : options?.isTemporary === false
        ? false
        : existingThread?.isTemporary === true;
  const nextPromotedTo = existingThread?.promotedTo;

  return {
    projectId: input.projectId,
    createdAt: resolveDraftThreadCreatedAt({
      createdAt: options?.createdAt,
      existingThread,
      mode: input.createdAtMode,
    }),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    entryPoint: nextEntryPoint,
    branch:
      options?.branch === undefined ? (existingThread?.branch ?? null) : (options.branch ?? null),
    worktreePath: nextWorktreePath,
    lastKnownPr:
      options?.lastKnownPr === undefined
        ? (existingThread?.lastKnownPr ?? null)
        : (options.lastKnownPr ?? null),
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    ...(nextIsTemporary ? { isTemporary: true } : {}),
    ...(nextPromotedTo ? { promotedTo: nextPromotedTo } : {}),
  };
}

function draftThreadStatesEqual(
  left: DraftThreadState | undefined,
  right: DraftThreadState,
): boolean {
  if (!left) {
    return false;
  }

  return (
    left.projectId === right.projectId &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.entryPoint === right.entryPoint &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    Equal.equals(left.lastKnownPr ?? null, right.lastKnownPr ?? null) &&
    left.envMode === right.envMode &&
    (left.isTemporary === true) === (right.isTemporary === true) &&
    left.promotedTo === right.promotedTo
  );
}

function removeProjectDraftMappingsForThread(
  projectDraftThreadIdByProjectId: Record<string, ThreadId>,
  threadId: ThreadId,
): Record<string, ThreadId> {
  let nextProjectDraftThreadIdByProjectId = projectDraftThreadIdByProjectId;
  for (const [mappingKey, mappedThreadId] of Object.entries(projectDraftThreadIdByProjectId)) {
    if (mappedThreadId !== threadId) {
      continue;
    }
    if (nextProjectDraftThreadIdByProjectId === projectDraftThreadIdByProjectId) {
      nextProjectDraftThreadIdByProjectId = { ...projectDraftThreadIdByProjectId };
    }
    delete nextProjectDraftThreadIdByProjectId[mappingKey];
  }
  return nextProjectDraftThreadIdByProjectId;
}

// Deletes a displaced draft only when no remaining project slot points at it.
function removeDraftThreadIfUnmapped(input: {
  threadId: ThreadId | undefined;
  projectDraftThreadIdByProjectId: Record<string, ThreadId>;
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
}): {
  draftThreadsByThreadId: Record<ThreadId, DraftThreadState>;
  draftsByThreadId: Record<ThreadId, ComposerThreadDraftState>;
} {
  if (
    !input.threadId ||
    Object.values(input.projectDraftThreadIdByProjectId).includes(input.threadId)
  ) {
    return {
      draftThreadsByThreadId: input.draftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  const nextDraftThreadsByThreadId = { ...input.draftThreadsByThreadId };
  delete nextDraftThreadsByThreadId[input.threadId];
  if (input.draftsByThreadId[input.threadId] === undefined) {
    return {
      draftThreadsByThreadId: nextDraftThreadsByThreadId,
      draftsByThreadId: input.draftsByThreadId,
    };
  }

  const removedDraft = input.draftsByThreadId[input.threadId];
  revokeDraftPreviewUrls(removedDraft);
  deleteDraftComposerImageBlobs(removedDraft);
  const nextDraftsByThreadId = { ...input.draftsByThreadId };
  delete nextDraftsByThreadId[input.threadId];
  return {
    draftThreadsByThreadId: nextDraftThreadsByThreadId,
    draftsByThreadId: nextDraftsByThreadId,
  };
}

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_FILES: ComposerFileAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_PASTED_TEXTS: PastedTextDraft[] = [];
const EMPTY_SKILLS: ProviderSkillReference[] = [];
const EMPTY_MENTIONS: ProviderMentionReference[] = [];
const EMPTY_QUEUED_TURNS: QueuedComposerTurn[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_FILES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_PASTED_TEXTS);
Object.freeze(EMPTY_SKILLS);
Object.freeze(EMPTY_MENTIONS);
Object.freeze(EMPTY_QUEUED_TURNS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  promptHistorySavedDraft: null,
  images: EMPTY_IMAGES,
  files: EMPTY_FILES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  assistantSelections: [],
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  fileComments: [],
  pastedTexts: EMPTY_PASTED_TEXTS,
  skills: EMPTY_SKILLS,
  mentions: EMPTY_MENTIONS,
  queuedTurns: EMPTY_QUEUED_TURNS,
  restoredSourceProposedPlan: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    promptHistorySavedDraft: null,
    images: [],
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    pastedTexts: [],
    skills: [],
    mentions: [],
    queuedTurns: [],
    restoredSourceProposedPlan: null,
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

function mergeComposerImages(
  existingImages: ReadonlyArray<ComposerImageAttachment>,
  incomingImages: ReadonlyArray<ComposerImageAttachment>,
): ComposerImageAttachment[] | null {
  const existingIds = new Set(existingImages.map((image) => image.id));
  const existingDedupKeys = new Set(existingImages.map((image) => composerImageDedupKey(image)));
  const acceptedPreviewUrls = new Set(existingImages.map((image) => image.previewUrl));
  const acceptedIncoming: ComposerImageAttachment[] = [];
  for (const image of incomingImages) {
    const dedupKey = composerImageDedupKey(image);
    if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
      if (!acceptedPreviewUrls.has(image.previewUrl)) {
        revokeObjectPreviewUrl(image.previewUrl);
      }
      continue;
    }
    acceptedIncoming.push(image);
    existingIds.add(image.id);
    existingDedupKeys.add(dedupKey);
    acceptedPreviewUrls.add(image.previewUrl);
  }
  return acceptedIncoming.length > 0 ? [...existingImages, ...acceptedIncoming] : null;
}

function composerFileDedupKey(file: ComposerFileAttachment): string {
  return `${file.mimeType}\u0000${file.sizeBytes}\u0000${file.name}`;
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function assistantSelectionDedupKey(
  selection: Pick<ComposerAssistantSelectionAttachment, "assistantMessageId" | "text">,
): string {
  return `${selection.assistantMessageId}\u0000${selection.text}`;
}

function normalizeAssistantSelection(
  selection: Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">,
): ComposerAssistantSelectionAttachment | null {
  const normalized = normalizeAssistantSelectionAttachment(selection);
  if (!normalized) {
    return null;
  }
  return {
    type: "assistant-selection",
    ...selection,
    assistantMessageId: normalized.assistantMessageId,
    text: normalized.text,
  };
}

function normalizeAssistantSelections(
  selections: ReadonlyArray<
    Pick<ComposerAssistantSelectionAttachment, "id" | "assistantMessageId" | "text">
  >,
): ComposerAssistantSelectionAttachment[] {
  const normalizedSelections: ComposerAssistantSelectionAttachment[] = [];
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();

  for (const selection of selections) {
    const normalizedSelection = normalizeAssistantSelection(selection);
    if (!normalizedSelection) {
      continue;
    }
    const dedupKey = assistantSelectionDedupKey(normalizedSelection);
    if (existingIds.has(normalizedSelection.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedSelections.push(normalizedSelection);
    existingIds.add(normalizedSelection.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedSelections;
}

function fileCommentDedupKey(comment: FileCommentSelection): string {
  return JSON.stringify([comment.path, comment.startLine, comment.endLine, comment.text]);
}

function normalizeFileComment(comment: FileCommentDraft): FileCommentDraft | null {
  const normalized = normalizeFileCommentSelection(comment);
  if (!normalized) {
    return null;
  }
  return {
    id: comment.id,
    ...normalized,
  };
}

function normalizeFileComments(comments: ReadonlyArray<FileCommentDraft>): FileCommentDraft[] {
  const normalizedComments: FileCommentDraft[] = [];
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();

  for (const comment of comments) {
    const normalizedComment = normalizeFileComment(comment);
    if (!normalizedComment) {
      continue;
    }
    const dedupKey = fileCommentDedupKey(normalizedComment);
    if (existingIds.has(normalizedComment.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedComments.push(normalizedComment);
    existingIds.add(normalizedComment.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedComments;
}

function normalizePastedText(pasted: PastedTextDraft): PastedTextDraft | null {
  const text = normalizePastedTextContent(pasted.text);
  if (pasted.id.length === 0 || text.length === 0) {
    return null;
  }
  return {
    id: pasted.id,
    createdAt: pasted.createdAt,
    text,
    lineCount: countPastedTextLines(text),
    charCount: text.length,
  };
}

// Dedupe by id only — two identical pastes are distinct chips at distinct
// positions, so content collisions must not collapse them.
function normalizePastedTexts(pastedTexts: ReadonlyArray<PastedTextDraft>): PastedTextDraft[] {
  const normalizedPastedTexts: PastedTextDraft[] = [];
  const existingIds = new Set<string>();
  for (const pasted of pastedTexts) {
    const normalized = normalizePastedText(pasted);
    if (!normalized || existingIds.has(normalized.id)) {
      continue;
    }
    normalizedPastedTexts.push(normalized);
    existingIds.add(normalized.id);
  }
  return normalizedPastedTexts;
}

function hydratePastedTextsFromPersisted(
  persisted: ReadonlyArray<PersistedPastedTextDraft> | undefined,
): PastedTextDraft[] {
  if (!persisted || persisted.length === 0) {
    return [];
  }
  return normalizePastedTexts(persisted.map((entry) => createPastedTextDraft(entry)));
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

// Moves all sendable composer content into a hidden draft while history text is being browsed.
export function captureComposerPromptHistorySavedDraft(input: {
  threadId: ThreadId;
  draft: ComposerThreadDraftState;
  prompt: string;
}): ComposerPromptHistorySavedDraft {
  const { threadId, draft, prompt } = input;
  return {
    prompt,
    // Keep the same image objects here: ownership moves from visible composer to saved snapshot.
    images: [...draft.images],
    files: [...draft.files],
    nonPersistedImageIds: [...draft.nonPersistedImageIds],
    persistedAttachments: [...draft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(draft.assistantSelections),
    terminalContexts: normalizeTerminalContextsForThread(threadId, draft.terminalContexts),
    fileComments: normalizeFileComments(draft.fileComments),
    pastedTexts: normalizePastedTexts(draft.pastedTexts),
    skills: [...draft.skills],
    mentions: [...draft.mentions],
  };
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
    promptHistorySavedDraft: clonePromptHistorySavedDraft(
      sourceDraft.promptHistorySavedDraft,
      targetThreadId,
    ),
    images: sourceDraft.images.map(cloneComposerImageAttachment),
    files: [...sourceDraft.files],
    nonPersistedImageIds: [...sourceDraft.nonPersistedImageIds],
    persistedAttachments: [...sourceDraft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(sourceDraft.assistantSelections),
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      sourceDraft.terminalContexts,
    ),
    fileComments: normalizeFileComments(sourceDraft.fileComments),
    pastedTexts: normalizePastedTexts(sourceDraft.pastedTexts),
    skills: [...sourceDraft.skills],
    mentions: [...sourceDraft.mentions],
    restoredSourceProposedPlan: null,
  };
}

function clonePromptHistorySavedDraft(
  savedDraft: ComposerPromptHistorySavedDraft | null,
  targetThreadId: ThreadId,
): ComposerPromptHistorySavedDraft | null {
  if (!savedDraft) {
    return null;
  }
  return {
    prompt: savedDraft.prompt,
    images: savedDraft.images.map(cloneComposerImageAttachment),
    files: [...savedDraft.files],
    nonPersistedImageIds: [...savedDraft.nonPersistedImageIds],
    persistedAttachments: [...savedDraft.persistedAttachments],
    assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections),
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      savedDraft.terminalContexts,
    ),
    fileComments: normalizeFileComments(savedDraft.fileComments),
    pastedTexts: normalizePastedTexts(savedDraft.pastedTexts),
    skills: [...savedDraft.skills],
    mentions: [...savedDraft.mentions],
  };
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.promptHistorySavedDraft === null &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.assistantSelections.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.fileComments.length === 0 &&
    draft.pastedTexts.length === 0 &&
    draft.skills.length === 0 &&
    draft.mentions.length === 0 &&
    draft.queuedTurns.length === 0 &&
    draft.restoredSourceProposedPlan == null &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderKind(value: unknown): ProviderKind | null {
  return isProviderKind(value) ? value : null;
}

function trimStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isGrokReasoningEffort(value: unknown): value is GrokReasoningEffort {
  return typeof value === "string" && GROK_REASONING_EFFORT_SET.has(value);
}

function makeModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderModelOptions[ProviderKind],
): ModelSelection {
  switch (provider) {
    case "codex":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "codex" }>["options"] }
          : {}),
      };
    case "claudeAgent":
      return {
        provider,
        model,
        ...(options
          ? {
              options: options as Extract<ModelSelection, { provider: "claudeAgent" }>["options"],
            }
          : {}),
      };
    case "cursor":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "cursor" }>["options"] }
          : {}),
      };
    case "gemini":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "gemini" }>["options"] }
          : {}),
      };
    case "grok":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "grok" }>["options"] }
          : {}),
      };
    case "kilo":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "kilo" }>["options"] }
          : {}),
      };
    case "opencode":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "opencode" }>["options"] }
          : {}),
      };
    case "pi":
      return {
        provider,
        model,
        ...(options
          ? { options: options as Extract<ModelSelection, { provider: "pi" }>["options"] }
          : {}),
      };
  }
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
  const cursorCandidate =
    candidate?.cursor && typeof candidate.cursor === "object"
      ? (candidate.cursor as Record<string, unknown>)
      : null;
  const geminiCandidate =
    candidate?.gemini && typeof candidate.gemini === "object"
      ? (candidate.gemini as Record<string, unknown>)
      : null;
  const grokCandidate =
    candidate?.grok && typeof candidate.grok === "object"
      ? (candidate.grok as Record<string, unknown>)
      : null;
  const openCodeCandidate =
    candidate?.opencode && typeof candidate.opencode === "object"
      ? (candidate.opencode as Record<string, unknown>)
      : null;
  const kiloCandidate =
    candidate?.kilo && typeof candidate.kilo === "object"
      ? (candidate.kilo as Record<string, unknown>)
      : null;
  const piCandidate =
    candidate?.pi && typeof candidate.pi === "object"
      ? (candidate.pi as Record<string, unknown>)
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
    claudeCandidate?.effort === "ultrathink" ||
    claudeCandidate?.effort === "ultracode"
      ? claudeCandidate.effort
      : undefined;
  const claudeFastMode =
    claudeCandidate?.fastMode === true
      ? true
      : claudeCandidate?.fastMode === false
        ? false
        : undefined;
  const claudeAutoCompactWindow =
    trimStringOrUndefined(claudeCandidate?.autoCompactWindow) ??
    trimStringOrUndefined(claudeCandidate?.contextWindow);
  const claude =
    claudeThinking !== undefined ||
    claudeEffort !== undefined ||
    claudeFastMode !== undefined ||
    claudeAutoCompactWindow !== undefined
      ? {
          ...(claudeThinking !== undefined ? { thinking: claudeThinking } : {}),
          ...(claudeEffort !== undefined ? { effort: claudeEffort } : {}),
          ...(claudeFastMode !== undefined ? { fastMode: claudeFastMode } : {}),
          ...(claudeAutoCompactWindow !== undefined
            ? { autoCompactWindow: claudeAutoCompactWindow }
            : {}),
        }
      : undefined;

  const cursorReasoningEffort = trimStringOrUndefined(cursorCandidate?.reasoningEffort);
  const cursorFastMode =
    cursorCandidate?.fastMode === true
      ? true
      : cursorCandidate?.fastMode === false
        ? false
        : undefined;
  const cursorThinking =
    cursorCandidate?.thinking === true
      ? true
      : cursorCandidate?.thinking === false
        ? false
        : undefined;
  const cursorContextWindow = trimStringOrUndefined(cursorCandidate?.contextWindow);
  const cursor: CursorModelOptions | undefined =
    cursorReasoningEffort !== undefined ||
    cursorFastMode !== undefined ||
    cursorThinking !== undefined ||
    cursorContextWindow !== undefined
      ? {
          ...(cursorReasoningEffort !== undefined
            ? { reasoningEffort: cursorReasoningEffort }
            : {}),
          ...(cursorFastMode !== undefined ? { fastMode: cursorFastMode } : {}),
          ...(cursorThinking !== undefined ? { thinking: cursorThinking } : {}),
          ...(cursorContextWindow !== undefined ? { contextWindow: cursorContextWindow } : {}),
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
  const grokReasoningEffort: GrokReasoningEffort | undefined = isGrokReasoningEffort(
    grokCandidate?.reasoningEffort,
  )
    ? grokCandidate.reasoningEffort
    : undefined;
  const grok =
    grokReasoningEffort !== undefined ? { reasoningEffort: grokReasoningEffort } : undefined;
  const openCodeVariant = trimStringOrUndefined(openCodeCandidate?.variant);
  const openCodeAgent = trimStringOrUndefined(openCodeCandidate?.agent);
  const opencode =
    openCodeVariant !== undefined || openCodeAgent !== undefined
      ? {
          ...(openCodeVariant !== undefined ? { variant: openCodeVariant } : {}),
          ...(openCodeAgent !== undefined ? { agent: openCodeAgent } : {}),
        }
      : undefined;
  const kiloVariant = trimStringOrUndefined(kiloCandidate?.variant);
  const kiloAgent = trimStringOrUndefined(kiloCandidate?.agent);
  const kilo =
    kiloVariant !== undefined || kiloAgent !== undefined
      ? {
          ...(kiloVariant !== undefined ? { variant: kiloVariant } : {}),
          ...(kiloAgent !== undefined ? { agent: kiloAgent } : {}),
        }
      : undefined;
  const piThinkingLevel: PiThinkingLevel | undefined =
    piCandidate?.thinkingLevel === "off" ||
    piCandidate?.thinkingLevel === "minimal" ||
    piCandidate?.thinkingLevel === "low" ||
    piCandidate?.thinkingLevel === "medium" ||
    piCandidate?.thinkingLevel === "high" ||
    piCandidate?.thinkingLevel === "xhigh"
      ? piCandidate.thinkingLevel
      : undefined;
  const pi = piThinkingLevel !== undefined ? { thinkingLevel: piThinkingLevel } : undefined;
  if (!codex && !claude && !cursor && !gemini && !grok && !kilo && !opencode && !pi) {
    return null;
  }
  return {
    ...(codex ? { codex } : {}),
    ...(claude ? { claudeAgent: claude } : {}),
    ...(cursor ? { cursor } : {}),
    ...(gemini ? { gemini } : {}),
    ...(grok ? { grok } : {}),
    ...(kilo ? { kilo } : {}),
    ...(opencode ? { opencode } : {}),
    ...(pi ? { pi } : {}),
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
  const inferredClaudeAutoCompactWindow =
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
        ? inferredClaudeAutoCompactWindow !== undefined
          ? {
              ...modelOptions?.claudeAgent,
              autoCompactWindow:
                modelOptions?.claudeAgent?.autoCompactWindow ?? inferredClaudeAutoCompactWindow,
            }
          : modelOptions?.claudeAgent
        : provider === "gemini"
          ? modelOptions?.gemini
          : provider === "grok"
            ? modelOptions?.grok
            : provider === "kilo"
              ? modelOptions?.kilo
              : provider === "cursor"
                ? modelOptions?.cursor
                : provider === "opencode"
                  ? modelOptions?.opencode
                  : provider === "pi"
                    ? modelOptions?.pi
                    : undefined;
  return makeModelSelection(provider, model, options);
}

// ── Sticky selection sanitization ─────────────────────────────────────

// The Claude context window must stay a per-thread choice: a 1M thread can grow far
// beyond the normal 200k compaction point and consume usage limits much faster, so a
// one-off pick must never silently become every future thread's sticky default.
function stripNonStickyModelOptions(selection: ModelSelection): ModelSelection {
  if (
    selection.provider !== "claudeAgent" ||
    (!selection.options?.contextWindow && !selection.options?.autoCompactWindow)
  ) {
    return selection;
  }
  const {
    contextWindow: _contextWindow,
    autoCompactWindow: _autoCompactWindow,
    ...rest
  } = selection.options;
  return makeModelSelection(
    selection.provider,
    selection.model,
    Object.keys(rest).length > 0 ? rest : undefined,
  );
}

function sanitizeStickyModelSelectionMap(
  map: Partial<Record<ProviderKind, ModelSelection>>,
): Partial<Record<ProviderKind, ModelSelection>> {
  const claude = map.claudeAgent;
  if (
    claude?.provider !== "claudeAgent" ||
    (!claude.options?.contextWindow && !claude.options?.autoCompactWindow)
  ) {
    return map;
  }
  return { ...map, claudeAgent: stripNonStickyModelOptions(claude) };
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
  return makeModelSelection(modelSelection.provider, modelSelection.model, options);
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
    for (const provider of COMPOSER_PROVIDER_KINDS) {
      const options = modelOptions[provider];
      if (options && Object.keys(options).length > 0) {
        const model =
          modelSelection?.provider === provider ? modelSelection.model : getDefaultModel(provider);
        if (model) {
          result[provider] = makeModelSelection(provider, model, options);
        }
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
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
}): EffectiveComposerModelState {
  const resolveAvailableModel = (candidate: string | null | undefined): ModelSlug | null => {
    const availableOptions = input.availableModelOptionsByProvider?.[input.selectedProvider];
    if (!availableOptions || availableOptions.length === 0) {
      return null;
    }
    return resolveSelectableModel(input.selectedProvider, candidate, availableOptions);
  };
  const baseModel = resolveModelSlugForProvider(
    input.selectedProvider,
    (input.threadModelSelection?.provider === input.selectedProvider
      ? input.threadModelSelection.model
      : null) ??
      (input.projectModelSelection?.provider === input.selectedProvider
        ? input.projectModelSelection.model
        : null) ??
      getDefaultModel(input.selectedProvider),
  );
  const persistedThreadModel =
    input.threadModelSelection?.provider === input.selectedProvider
      ? (normalizeModelSlug(input.threadModelSelection.model, input.selectedProvider) ??
        input.threadModelSelection.model)
      : null;
  const persistedProjectModel =
    input.projectModelSelection?.provider === input.selectedProvider
      ? (normalizeModelSlug(input.projectModelSelection.model, input.selectedProvider) ??
        input.projectModelSelection.model)
      : null;
  const activeSelection = input.draft?.modelSelectionByProvider?.[input.selectedProvider];
  const selectedDraftModel = activeSelection?.model
    ? resolveAppModelSelection(
        input.selectedProvider,
        input.customModelsByProvider,
        activeSelection.model,
      )
    : null;
  const unlistedDraftModel = input.selectedProvider === "pi" ? selectedDraftModel : null;
  const selectedModel =
    resolveAvailableModel(activeSelection?.model) ??
    resolveAvailableModel(
      input.threadModelSelection?.provider === input.selectedProvider
        ? input.threadModelSelection.model
        : null,
    ) ??
    resolveAvailableModel(
      input.projectModelSelection?.provider === input.selectedProvider
        ? input.projectModelSelection.model
        : null,
    ) ??
    resolveAvailableModel(selectedDraftModel) ??
    persistedThreadModel ??
    persistedProjectModel ??
    unlistedDraftModel ??
    input.availableModelOptionsByProvider?.[input.selectedProvider]?.[0]?.slug ??
    selectedDraftModel ??
    baseModel ??
    getDefaultModel("codex");
  const modelOptions = deriveEffectiveComposerModelOptions(input);

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
    COMPOSER_PROVIDER_KINDS.find(
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
      provider: preferredProvider === "pi" ? "codex" : preferredProvider,
      model: getDefaultModel(preferredProvider === "pi" ? "codex" : preferredProvider),
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

function revokePromptHistorySavedDraftPreviewUrls(
  savedDraft: ComposerPromptHistorySavedDraft | null | undefined,
): void {
  if (!savedDraft) {
    return;
  }
  for (const image of savedDraft.images) {
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
  revokePromptHistorySavedDraftPreviewUrls(draft.promptHistorySavedDraft);
}

function revokeDraftComposerImagePreviewUrls(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) {
    return;
  }
  for (const image of draft.images) {
    revokeObjectPreviewUrl(image.previewUrl);
  }
  revokePromptHistorySavedDraftPreviewUrls(draft.promptHistorySavedDraft);
}

export function isComposerImageBlobReferenced(
  draftsByThreadId: Readonly<Record<string, ComposerThreadDraftState | undefined>>,
  blobKey: string,
): boolean {
  if (blobKey.length === 0) return false;
  for (const draft of Object.values(draftsByThreadId)) {
    if (!draft) continue;
    if (draft.persistedAttachments.some((attachment) => attachment.blobKey === blobKey)) {
      return true;
    }
    if (
      draft.promptHistorySavedDraft?.persistedAttachments.some(
        (attachment) => attachment.blobKey === blobKey,
      )
    ) {
      return true;
    }
  }
  return false;
}

export function findSupersededComposerImageBlobAttachments(
  previousAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
  nextAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
): PersistedComposerImageAttachment[] {
  const nextBlobKeys = new Set(
    nextAttachments.flatMap((attachment) => (attachment.blobKey ? [attachment.blobKey] : [])),
  );
  return previousAttachments.filter((attachment) => {
    const blobKey = attachment.blobKey;
    return Boolean(blobKey && !nextBlobKeys.has(blobKey));
  });
}

function deletePersistedComposerImageBlobs(
  attachments: ReadonlyArray<PersistedComposerImageAttachment>,
): void {
  const candidateBlobKeys = new Set(
    attachments.flatMap((attachment) => (attachment.blobKey ? [attachment.blobKey] : [])),
  );
  if (candidateBlobKeys.size === 0) return;

  // Several product flows copy composer state before the destination is ever
  // mounted. Those drafts temporarily share the source blob key, so ownership
  // must be checked after the current store mutation has committed.
  Promise.resolve().then(() => {
    const draftsByThreadId = useComposerDraftStore.getState().draftsByThreadId;
    for (const blobKey of candidateBlobKeys) {
      if (isComposerImageBlobReferenced(draftsByThreadId, blobKey)) continue;
      void deleteComposerImageBlob(blobKey).catch((error) => {
        console.warn("[composer-images] Could not delete persisted image blob", error);
      });
    }
  });
}

function deleteDraftComposerImageBlobs(draft: ComposerThreadDraftState | undefined): void {
  if (!draft) return;
  deletePersistedComposerImageBlobs(draft.persistedAttachments);
  if (draft.promptHistorySavedDraft) {
    deletePersistedComposerImageBlobs(draft.promptHistorySavedDraft.persistedAttachments);
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
  const blobKey = candidate.blobKey;
  const source = normalizeComposerImageSource(candidate.source);
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof mimeType !== "string" ||
    typeof sizeBytes !== "number" ||
    !Number.isFinite(sizeBytes) ||
    id.length === 0 ||
    !(
      (typeof dataUrl === "string" && dataUrl.length > 0) ||
      (typeof blobKey === "string" && blobKey.length > 0)
    )
  ) {
    return null;
  }
  return {
    id,
    name,
    mimeType,
    sizeBytes,
    ...(typeof dataUrl === "string" && dataUrl.length > 0 ? { dataUrl } : {}),
    ...(typeof blobKey === "string" && blobKey.length > 0 ? { blobKey } : {}),
    ...(source ? { source } : {}),
  };
}

function toStorageSafePersistedAttachment(
  attachment: PersistedComposerImageAttachment,
): PersistedComposerImageAttachment {
  const { source: _source, ...attachmentWithoutSource } = attachment;
  const source = toPersistedComposerImageSource(attachment.source);
  return {
    ...attachmentWithoutSource,
    ...(source ? { source } : {}),
  };
}

function normalizePersistedPromptHistorySavedDraft(
  value: unknown,
): DeepMutable<PersistedComposerPromptHistorySavedDraft> | null {
  if (typeof value === "string") {
    return { prompt: value, attachments: [] };
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const prompt = typeof candidate.prompt === "string" ? candidate.prompt : null;
  if (prompt === null) {
    return null;
  }
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.flatMap((entry) => {
        const normalized = normalizePersistedAttachment(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const assistantSelections = Array.isArray(candidate.assistantSelections)
    ? candidate.assistantSelections.flatMap((entry) => {
        const normalized = normalizePersistedAssistantSelection(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const terminalContexts = Array.isArray(candidate.terminalContexts)
    ? candidate.terminalContexts.flatMap((entry) => {
        const normalized = normalizePersistedTerminalContextDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const fileComments = Array.isArray(candidate.fileComments)
    ? candidate.fileComments.flatMap((entry) => {
        const normalized = normalizePersistedFileCommentDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const pastedTexts = Array.isArray(candidate.pastedTexts)
    ? candidate.pastedTexts.flatMap((entry) => {
        const normalized = normalizePersistedPastedTextDraft(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const skills = Array.isArray(candidate.skills)
    ? candidate.skills.filter(Schema.is(ProviderSkillReference))
    : [];
  const mentions = Array.isArray(candidate.mentions)
    ? candidate.mentions.filter(Schema.is(ProviderMentionReference))
    : [];
  return {
    prompt,
    attachments,
    ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
    ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
    ...(fileComments.length > 0 ? { fileComments } : {}),
    ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
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

function normalizePersistedAssistantSelection(
  value: unknown,
): { id: string; assistantMessageId: string; text: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const assistantMessageId =
    typeof candidate.assistantMessageId === "string" ? candidate.assistantMessageId : "";
  const text = typeof candidate.text === "string" ? candidate.text : "";
  if (id.length === 0) {
    return null;
  }
  const normalized = normalizeAssistantSelectionAttachment({ assistantMessageId, text });
  if (!normalized) {
    return null;
  }
  return { id, assistantMessageId: normalized.assistantMessageId, text: normalized.text };
}

function normalizePersistedFileCommentDraft(value: unknown): PersistedFileCommentDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  if (id.length === 0) {
    return null;
  }
  const path = typeof candidate.path === "string" ? candidate.path : "";
  const text = typeof candidate.text === "string" ? candidate.text : "";
  const startLine = typeof candidate.startLine === "number" ? candidate.startLine : Number.NaN;
  const endLine = typeof candidate.endLine === "number" ? candidate.endLine : Number.NaN;
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }
  const normalized = normalizeFileCommentSelection({ path, startLine, endLine, text });
  if (!normalized) {
    return null;
  }
  return { id, ...normalized };
}

function normalizePersistedPastedTextDraft(value: unknown): PersistedPastedTextDraft | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const createdAt = typeof candidate.createdAt === "string" ? candidate.createdAt : "";
  const text = typeof candidate.text === "string" ? normalizePastedTextContent(candidate.text) : "";
  if (id.length === 0 || text.length === 0) {
    return null;
  }
  return { id, createdAt, text };
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
    const sourceProposedPlan = Schema.is(PersistedSourceProposedPlanReference)(
      candidate.sourceProposedPlan,
    )
      ? candidate.sourceProposedPlan
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
      const assistantSelections = Array.isArray(candidate.assistantSelections)
        ? candidate.assistantSelections.flatMap((selection) => {
            const normalized = normalizePersistedAssistantSelection(selection);
            return normalized ? [normalized] : [];
          })
        : [];
      const fileComments = Array.isArray(candidate.fileComments)
        ? candidate.fileComments.flatMap((comment) => {
            const normalized = normalizePersistedFileCommentDraft(comment);
            return normalized ? [normalized] : [];
          })
        : [];
      const pastedTexts = Array.isArray(candidate.pastedTexts)
        ? candidate.pastedTexts.flatMap((pasted) => {
            const normalized = normalizePersistedPastedTextDraft(pasted);
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
        ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
        terminalContexts,
        ...(fileComments.length > 0 ? { fileComments } : {}),
        ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
        skills: [...skills],
        mentions: [...mentions],
        selectedProvider,
        selectedModel,
        selectedPromptEffort,
        modelSelection,
        ...(providerOptionsForDispatch ? { providerOptionsForDispatch } : {}),
        ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
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
      let lastKnownPr: OrchestrationThreadPullRequest | null = null;
      if (
        candidateDraftThread.lastKnownPr &&
        typeof candidateDraftThread.lastKnownPr === "object"
      ) {
        try {
          lastKnownPr = Schema.decodeUnknownSync(OrchestrationThreadPullRequest)(
            candidateDraftThread.lastKnownPr,
          );
        } catch {
          lastKnownPr = null;
        }
      }
      const normalizedWorktreePath = typeof worktreePath === "string" ? worktreePath : null;
      const isTemporary = candidateDraftThread.isTemporary === true ? true : undefined;
      const promotedTo =
        typeof candidateDraftThread.promotedTo === "string" &&
        candidateDraftThread.promotedTo.length > 0
          ? (candidateDraftThread.promotedTo as ThreadId)
          : undefined;
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
        ...(lastKnownPr ? { lastKnownPr } : {}),
        envMode: normalizeDraftThreadEnvMode(candidateDraftThread.envMode, normalizedWorktreePath),
        ...(isTemporary ? { isTemporary: true } : {}),
        ...(promotedTo ? { promotedTo } : {}),
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
    const promptHistorySavedDraft = normalizePersistedPromptHistorySavedDraft(
      draftCandidate.promptHistorySavedDraft,
    );
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
    const assistantSelections = Array.isArray(draftCandidate.assistantSelections)
      ? draftCandidate.assistantSelections.flatMap((entry) => {
          const normalized = normalizePersistedAssistantSelection(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const fileComments = Array.isArray(draftCandidate.fileComments)
      ? draftCandidate.fileComments.flatMap((entry) => {
          const normalized = normalizePersistedFileCommentDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const pastedTexts = Array.isArray(draftCandidate.pastedTexts)
      ? draftCandidate.pastedTexts.flatMap((entry) => {
          const normalized = normalizePersistedPastedTextDraft(entry);
          return normalized ? [normalized] : [];
        })
      : [];
    const skills = Array.isArray(draftCandidate.skills)
      ? draftCandidate.skills.filter(Schema.is(ProviderSkillReference))
      : [];
    const mentions = Array.isArray(draftCandidate.mentions)
      ? draftCandidate.mentions.filter(Schema.is(ProviderMentionReference))
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
    const restoredSourceProposedPlan = Schema.is(PersistedRestoredSourceProposedPlan)(
      draftCandidate.restoredSourceProposedPlan,
    )
      ? draftCandidate.restoredSourceProposedPlan
      : null;
    const hasModelData =
      Object.keys(modelSelectionByProvider).length > 0 || activeProvider !== null;
    const hasQueuedTurns = normalizedQueuedTurns.length > 0;
    const hasReferenceData = skills.length > 0 || mentions.length > 0;
    if (
      promptCandidate.length === 0 &&
      promptHistorySavedDraft === null &&
      attachments.length === 0 &&
      terminalContexts.length === 0 &&
      assistantSelections.length === 0 &&
      fileComments.length === 0 &&
      pastedTexts.length === 0 &&
      !hasReferenceData &&
      !hasQueuedTurns &&
      restoredSourceProposedPlan === null &&
      !hasModelData &&
      !runtimeMode &&
      !interactionMode
    ) {
      continue;
    }
    nextDraftsByThreadId[threadId as ThreadId] = {
      prompt,
      ...(promptHistorySavedDraft !== null ? { promptHistorySavedDraft } : {}),
      attachments,
      ...(assistantSelections.length > 0 ? { assistantSelections } : {}),
      ...(terminalContexts.length > 0 ? { terminalContexts } : {}),
      ...(fileComments.length > 0 ? { fileComments } : {}),
      ...(pastedTexts.length > 0 ? { pastedTexts } : {}),
      ...(skills.length > 0 ? { skills } : {}),
      ...(mentions.length > 0 ? { mentions } : {}),
      ...(hasQueuedTurns ? { queuedTurns: normalizedQueuedTurns } : {}),
      ...(restoredSourceProposedPlan ? { restoredSourceProposedPlan } : {}),
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
  // Version bumps should sanitize persisted data without forcing users back
  // through the legacy sticky-model fields.
  return normalizeCurrentPersistedComposerDraftStoreState(persistedState);
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
        // File attachments are intentionally in-memory only; persisting the
        // queued turn without them would make a later send incomplete.
        if (queuedTurn.files.length > 0) {
          continue;
        }
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
          assistantSelections: queuedTurn.assistantSelections.map((selection) => ({
            id: selection.id,
            assistantMessageId: selection.assistantMessageId,
            text: selection.text,
          })),
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
          ...(queuedTurn.fileComments.length > 0
            ? {
                fileComments: queuedTurn.fileComments.map((comment) => ({
                  id: comment.id,
                  path: comment.path,
                  startLine: comment.startLine,
                  endLine: comment.endLine,
                  text: comment.text,
                })),
              }
            : {}),
          ...(queuedTurn.pastedTexts.length > 0
            ? {
                pastedTexts: queuedTurn.pastedTexts.map((pasted) => ({
                  id: pasted.id,
                  createdAt: pasted.createdAt,
                  text: pasted.text,
                })),
              }
            : {}),
          skills: [...queuedTurn.skills],
          mentions: [...queuedTurn.mentions],
          selectedProvider: queuedTurn.selectedProvider,
          selectedModel: queuedTurn.selectedModel,
          selectedPromptEffort: queuedTurn.selectedPromptEffort,
          modelSelection: queuedTurn.modelSelection,
          ...(queuedTurn.providerOptionsForDispatch
            ? { providerOptionsForDispatch: queuedTurn.providerOptionsForDispatch }
            : {}),
          ...(queuedTurn.sourceProposedPlan
            ? { sourceProposedPlan: queuedTurn.sourceProposedPlan }
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
    const hasReferenceData = draft.skills.length > 0 || draft.mentions.length > 0;
    if (
      draft.prompt.length === 0 &&
      draft.promptHistorySavedDraft === null &&
      draft.persistedAttachments.length === 0 &&
      draft.assistantSelections.length === 0 &&
      draft.terminalContexts.length === 0 &&
      draft.fileComments.length === 0 &&
      draft.pastedTexts.length === 0 &&
      !hasReferenceData &&
      !hasQueuedTurns &&
      draft.restoredSourceProposedPlan == null &&
      !hasModelData &&
      draft.runtimeMode === null &&
      draft.interactionMode === null
    ) {
      continue;
    }
    const persistedDraft: DeepMutable<PersistedComposerThreadDraftState> = {
      prompt: draft.prompt,
      ...(draft.promptHistorySavedDraft !== null
        ? {
            promptHistorySavedDraft: {
              prompt: draft.promptHistorySavedDraft.prompt,
              attachments: draft.promptHistorySavedDraft.persistedAttachments.map(
                toStorageSafePersistedAttachment,
              ),
              ...(draft.promptHistorySavedDraft.assistantSelections.length > 0
                ? {
                    assistantSelections: draft.promptHistorySavedDraft.assistantSelections.map(
                      (selection) => ({
                        id: selection.id,
                        assistantMessageId: selection.assistantMessageId,
                        text: selection.text,
                      }),
                    ),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.terminalContexts.length > 0
                ? {
                    terminalContexts: draft.promptHistorySavedDraft.terminalContexts.map(
                      (context) => ({
                        id: context.id,
                        threadId: context.threadId,
                        createdAt: context.createdAt,
                        terminalId: context.terminalId,
                        terminalLabel: context.terminalLabel,
                        lineStart: context.lineStart,
                        lineEnd: context.lineEnd,
                      }),
                    ),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.fileComments.length > 0
                ? {
                    fileComments: draft.promptHistorySavedDraft.fileComments.map((comment) => ({
                      id: comment.id,
                      path: comment.path,
                      startLine: comment.startLine,
                      endLine: comment.endLine,
                      text: comment.text,
                    })),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.pastedTexts.length > 0
                ? {
                    pastedTexts: draft.promptHistorySavedDraft.pastedTexts.map((pasted) => ({
                      id: pasted.id,
                      createdAt: pasted.createdAt,
                      text: pasted.text,
                    })),
                  }
                : {}),
              ...(draft.promptHistorySavedDraft.skills.length > 0
                ? { skills: [...draft.promptHistorySavedDraft.skills] }
                : {}),
              ...(draft.promptHistorySavedDraft.mentions.length > 0
                ? { mentions: [...draft.promptHistorySavedDraft.mentions] }
                : {}),
            },
          }
        : {}),
      attachments: draft.persistedAttachments.map(toStorageSafePersistedAttachment),
      ...(draft.assistantSelections.length > 0
        ? {
            assistantSelections: draft.assistantSelections.map((selection) => ({
              id: selection.id,
              assistantMessageId: selection.assistantMessageId,
              text: selection.text,
            })),
          }
        : {}),
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
      ...(draft.fileComments.length > 0
        ? {
            fileComments: draft.fileComments.map((comment) => ({
              id: comment.id,
              path: comment.path,
              startLine: comment.startLine,
              endLine: comment.endLine,
              text: comment.text,
            })),
          }
        : {}),
      ...(draft.pastedTexts.length > 0
        ? {
            pastedTexts: draft.pastedTexts.map((pasted) => ({
              id: pasted.id,
              createdAt: pasted.createdAt,
              text: pasted.text,
            })),
          }
        : {}),
      ...(draft.skills.length > 0 ? { skills: [...draft.skills] } : {}),
      ...(draft.mentions.length > 0 ? { mentions: [...draft.mentions] } : {}),
      ...(hasQueuedTurns ? { queuedTurns: persistedQueuedTurns } : {}),
      ...(draft.restoredSourceProposedPlan
        ? { restoredSourceProposedPlan: draft.restoredSourceProposedPlan }
        : {}),
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
        provider: normalizedPersistedState.stickyProvider ?? "codex",
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
    stickyModelSelectionByProvider: sanitizeStickyModelSelectionMap(stickyModelSelectionByProvider),
    stickyActiveProvider,
  };
}

type PersistedAttachmentIdsRead =
  | { available: true; attachmentIds: string[] }
  | { available: false };

function asUnknownRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readPersistedComposerDraftsRecord(): Record<string, unknown> | null {
  const persisted = asUnknownRecord(
    getLocalStorageItem(COMPOSER_DRAFT_STORAGE_KEY, Schema.Unknown),
  );
  if (!persisted || persisted.version !== COMPOSER_DRAFT_STORAGE_VERSION) return null;
  const state = asUnknownRecord(persisted.state);
  return state ? asUnknownRecord(state.draftsByThreadId) : null;
}

function decodePersistedAttachmentIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const attachmentIds: string[] = [];
  for (const candidate of value) {
    try {
      attachmentIds.push(Schema.decodeUnknownSync(PersistedComposerImageAttachment)(candidate).id);
    } catch {
      // Ignore unrelated malformed entries. The attempted attachment still has
      // to decode successfully and appear below before its native capture is acknowledged.
    }
  }
  return attachmentIds;
}

function readPersistedAttachmentIdsFromStorage(threadId: ThreadId): PersistedAttachmentIdsRead {
  if (threadId.length === 0) {
    return { available: false };
  }
  try {
    const draft = asUnknownRecord(readPersistedComposerDraftsRecord()?.[threadId]);
    if (!draft) return { available: false };
    const attachmentIds = decodePersistedAttachmentIds(draft.attachments);
    if (!attachmentIds) return { available: false };
    return {
      available: true,
      attachmentIds,
    };
  } catch {
    return { available: false };
  }
}

function readPersistedPromptHistoryAttachmentIdsFromStorage(
  threadId: ThreadId,
): PersistedAttachmentIdsRead {
  if (threadId.length === 0) {
    return { available: false };
  }
  try {
    const draft = asUnknownRecord(readPersistedComposerDraftsRecord()?.[threadId]);
    const savedDraft = asUnknownRecord(draft?.promptHistorySavedDraft);
    if (!savedDraft) return { available: false };
    const attachmentIds = decodePersistedAttachmentIds(savedDraft.attachments ?? []);
    if (!attachmentIds) return { available: false };
    return {
      available: true,
      attachmentIds,
    };
  } catch {
    return { available: false };
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
): ComposerAttachmentPersistenceResult {
  let persistedIdsRead: PersistedAttachmentIdsRead = { available: false };
  try {
    composerDebouncedStorage.flush();
    persistedIdsRead = readPersistedAttachmentIdsFromStorage(threadId);
  } catch {
    persistedIdsRead = { available: false };
  }
  const persistedIdSet = new Set(persistedIdsRead.available ? persistedIdsRead.attachmentIds : []);
  let draftPresent = false;
  let verifiedAttachmentIds = new Set<string>();
  let retainedAttachmentIds = new Set<string>();
  set((state) => {
    const current = state.draftsByThreadId[threadId];
    if (!current) {
      return state;
    }
    draftPresent = true;
    const imageIdSet = new Set(current.images.map((image) => image.id));
    const retainedAttachments = attachments.filter((attachment) => imageIdSet.has(attachment.id));
    retainedAttachmentIds = new Set(retainedAttachments.map((attachment) => attachment.id));
    const persistedAttachments = persistedIdsRead.available
      ? retainedAttachments.filter((attachment) => persistedIdSet.has(attachment.id))
      : retainedAttachments;
    verifiedAttachmentIds = new Set(persistedAttachments.map((attachment) => attachment.id));
    const nonPersistedImageIds = persistedIdsRead.available
      ? current.images.map((image) => image.id).filter((imageId) => !persistedIdSet.has(imageId))
      : [...new Set([...current.nonPersistedImageIds, ...retainedAttachmentIds])];
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
  const acceptedAttachmentIds = persistedIdsRead.available
    ? verifiedAttachmentIds
    : retainedAttachmentIds;
  const rejectedAttachments = attachments.filter(
    (attachment) => !acceptedAttachmentIds.has(attachment.id),
  );
  deletePersistedComposerImageBlobs(rejectedAttachments);
  if (!draftPresent || rejectedAttachments.length > 0) return "rejected";
  return persistedIdsRead.available ? "persisted" : "unverified";
}

function verifyPromptHistorySavedDraftPersistedAttachments(
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
): ComposerAttachmentPersistenceResult {
  let persistedIdsRead: PersistedAttachmentIdsRead = { available: false };
  try {
    composerDebouncedStorage.flush();
    persistedIdsRead = readPersistedPromptHistoryAttachmentIdsFromStorage(threadId);
  } catch {
    persistedIdsRead = { available: false };
  }
  const persistedIdSet = new Set(persistedIdsRead.available ? persistedIdsRead.attachmentIds : []);
  let draftPresent = false;
  let verifiedAttachmentIds = new Set<string>();
  let retainedAttachmentIds = new Set<string>();
  set((state) => {
    const current = state.draftsByThreadId[threadId];
    const savedDraft = current?.promptHistorySavedDraft ?? null;
    if (!current || !savedDraft) {
      return state;
    }
    draftPresent = true;
    const imageIdSet = new Set(savedDraft.images.map((image) => image.id));
    const retainedAttachments = attachments.filter((attachment) => imageIdSet.has(attachment.id));
    retainedAttachmentIds = new Set(retainedAttachments.map((attachment) => attachment.id));
    const persistedAttachments = persistedIdsRead.available
      ? retainedAttachments.filter((attachment) => persistedIdSet.has(attachment.id))
      : retainedAttachments;
    verifiedAttachmentIds = new Set(persistedAttachments.map((attachment) => attachment.id));
    const nonPersistedImageIds = persistedIdsRead.available
      ? savedDraft.images.map((image) => image.id).filter((imageId) => !persistedIdSet.has(imageId))
      : [...new Set([...savedDraft.nonPersistedImageIds, ...retainedAttachmentIds])];
    const nextDraft: ComposerThreadDraftState = {
      ...current,
      promptHistorySavedDraft: {
        ...savedDraft,
        persistedAttachments,
        nonPersistedImageIds,
      },
    };
    const nextDraftsByThreadId = { ...state.draftsByThreadId };
    if (shouldRemoveDraft(nextDraft)) {
      delete nextDraftsByThreadId[threadId];
    } else {
      nextDraftsByThreadId[threadId] = nextDraft;
    }
    return { draftsByThreadId: nextDraftsByThreadId };
  });
  const acceptedAttachmentIds = persistedIdsRead.available
    ? verifiedAttachmentIds
    : retainedAttachmentIds;
  const rejectedAttachments = attachments.filter(
    (attachment) => !acceptedAttachmentIds.has(attachment.id),
  );
  deletePersistedComposerImageBlobs(rejectedAttachments);
  if (!draftPresent || rejectedAttachments.length > 0) return "rejected";
  return persistedIdsRead.available ? "persisted" : "unverified";
}

function hydreatePersistedComposerImageAttachment(
  attachment: PersistedComposerImageAttachment,
): File | null {
  if (!attachment.dataUrl) return null;
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
    const previewUrl = attachment.dataUrl;
    if (!previewUrl) return [];
    const file = hydreatePersistedComposerImageAttachment(attachment);
    if (!file) return [];
    const source = normalizeComposerImageSource(attachment.source);

    return [
      {
        type: "image" as const,
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        previewUrl,
        file,
        ...(source ? { source } : {}),
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
        files: [],
        assistantSelections: normalizeAssistantSelections(queuedTurn.assistantSelections ?? []),
        terminalContexts: normalizeTerminalContextsForThread(threadId, queuedTurn.terminalContexts),
        fileComments: normalizeFileComments(queuedTurn.fileComments ?? []),
        pastedTexts: hydratePastedTextsFromPersisted(queuedTurn.pastedTexts),
        skills: [...queuedTurn.skills],
        mentions: [...queuedTurn.mentions],
      };
    }
    return { ...queuedTurn };
  });
}

function hydratePromptHistorySavedDraft(
  savedDraft: PersistedComposerPromptHistorySavedDraft | undefined,
): ComposerPromptHistorySavedDraft | null {
  if (savedDraft === undefined) {
    return null;
  }
  if (typeof savedDraft === "string") {
    return {
      prompt: savedDraft,
      images: [],
      files: [],
      nonPersistedImageIds: [],
      persistedAttachments: [],
      assistantSelections: [],
      terminalContexts: [],
      fileComments: [],
      pastedTexts: [],
      skills: [],
      mentions: [],
    };
  }
  const attachments = savedDraft.attachments ?? [];
  return {
    prompt: savedDraft.prompt,
    images: hydrateImagesFromPersisted(attachments),
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [...attachments],
    assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections ?? []),
    terminalContexts:
      savedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    fileComments: normalizeFileComments(savedDraft.fileComments ?? []),
    pastedTexts: hydratePastedTextsFromPersisted(savedDraft.pastedTexts),
    skills: [...(savedDraft.skills ?? [])],
    mentions: [...(savedDraft.mentions ?? [])],
  };
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
    promptHistorySavedDraft: hydratePromptHistorySavedDraft(persistedDraft.promptHistorySavedDraft),
    images: hydrateImagesFromPersisted(persistedDraft.attachments),
    files: [],
    nonPersistedImageIds: [],
    persistedAttachments: [...persistedDraft.attachments],
    assistantSelections: normalizeAssistantSelections(persistedDraft.assistantSelections ?? []),
    terminalContexts:
      persistedDraft.terminalContexts?.map((context) => ({
        ...context,
        text: "",
      })) ?? [],
    fileComments: normalizeFileComments(persistedDraft.fileComments ?? []),
    pastedTexts: hydratePastedTextsFromPersisted(persistedDraft.pastedTexts),
    skills: [...(persistedDraft.skills ?? [])],
    mentions: [...(persistedDraft.mentions ?? [])],
    queuedTurns: hydrateQueuedTurnsFromPersisted(threadId, persistedDraft.queuedTurns),
    restoredSourceProposedPlan: persistedDraft.restoredSourceProposedPlan ?? null,
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
          normalizeDraftThreadEntryPoint(draftThread.entryPoint) !== entryPoint ||
          draftThread.promotedTo !== undefined
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
          const nextDraftThread = buildDraftThreadState({
            projectId,
            existingThread,
            options,
            createdAtMode: "accept-empty",
          });
          const mappingKey = projectDraftThreadMappingKey(projectId, nextDraftThread.entryPoint);
          const previousThreadIdForProject = state.projectDraftThreadIdByProjectId[mappingKey];
          const hasSameProjectMapping = previousThreadIdForProject === threadId;
          if (hasSameProjectMapping && draftThreadStatesEqual(existingThread, nextDraftThread)) {
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
          const cleanedDrafts =
            previousThreadIdForProject === threadId
              ? {
                  draftThreadsByThreadId: nextDraftThreadsByThreadId,
                  draftsByThreadId: state.draftsByThreadId,
                }
              : removeDraftThreadIfUnmapped({
                  threadId: previousThreadIdForProject,
                  projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                  draftThreadsByThreadId: nextDraftThreadsByThreadId,
                  draftsByThreadId: state.draftsByThreadId,
                });
          return {
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      registerDraftThread: (threadId, options) => {
        if (threadId.length === 0 || options.projectId.length === 0) {
          return;
        }
        set((state) => {
          if (state.draftThreadsByThreadId[threadId]) {
            return state;
          }
          const worktreePath = options.worktreePath ?? null;
          const nextDraftThread: DraftThreadState = {
            projectId: options.projectId,
            createdAt: options.createdAt ?? new Date().toISOString(),
            runtimeMode: options.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: options.interactionMode ?? DEFAULT_INTERACTION_MODE,
            entryPoint: options.entryPoint ?? "chat",
            branch: options.branch ?? null,
            worktreePath,
            lastKnownPr: null,
            envMode: options.envMode ?? (worktreePath ? "worktree" : "local"),
            ...(options.isTemporary ? { isTemporary: true } : {}),
          };
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
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
          const nextDraftThread = buildDraftThreadState({
            projectId: nextProjectId,
            existingThread: existing,
            options,
            createdAtMode: "preserve-existing-on-empty",
          });
          if (draftThreadStatesEqual(existing, nextDraftThread)) {
            return state;
          }
          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
            ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
            [projectDraftThreadMappingKey(nextProjectId, nextDraftThread.entryPoint)]: threadId,
          };
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: nextDraftThread,
            },
            projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
          };
        });
      },
      moveDraftThreadToProject: (threadId, projectId, options) => {
        if (threadId.length === 0 || projectId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextDraftThread = buildDraftThreadState({
            projectId,
            existingThread: existing,
            options,
            createdAtMode: "preserve-existing-on-empty",
          });
          const targetMappingKey = projectDraftThreadMappingKey(
            projectId,
            nextDraftThread.entryPoint,
          );
          const previousThreadIdForProject =
            state.projectDraftThreadIdByProjectId[targetMappingKey];
          const hasOnlyTargetMapping = Object.entries(state.projectDraftThreadIdByProjectId).every(
            ([mappingKey, mappedThreadId]) =>
              mappedThreadId !== threadId || mappingKey === targetMappingKey,
          );
          if (
            previousThreadIdForProject === threadId &&
            hasOnlyTargetMapping &&
            draftThreadStatesEqual(existing, nextDraftThread)
          ) {
            return state;
          }

          const nextProjectDraftThreadIdByProjectId: Record<string, ThreadId> = {
            ...removeProjectDraftMappingsForThread(state.projectDraftThreadIdByProjectId, threadId),
            [targetMappingKey]: threadId,
          };

          const nextDraftThreadsByThreadId: Record<ThreadId, DraftThreadState> = {
            ...state.draftThreadsByThreadId,
            [threadId]: nextDraftThread,
          };
          const cleanedDrafts =
            previousThreadIdForProject === threadId
              ? {
                  draftThreadsByThreadId: nextDraftThreadsByThreadId,
                  draftsByThreadId: state.draftsByThreadId,
                }
              : removeDraftThreadIfUnmapped({
                  threadId: previousThreadIdForProject,
                  projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
                  draftThreadsByThreadId: nextDraftThreadsByThreadId,
                  draftsByThreadId: state.draftsByThreadId,
                });

          return {
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
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
          const cleanedDrafts = removeDraftThreadIfUnmapped({
            threadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            draftsByThreadId: state.draftsByThreadId,
          });
          return {
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
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
          let cleanedDrafts = {
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            draftsByThreadId: state.draftsByThreadId,
          };
          for (const threadId of removedThreadIds) {
            cleanedDrafts = removeDraftThreadIfUnmapped({
              threadId,
              projectDraftThreadIdByProjectId: nextProjectDraftThreadIdByProjectId,
              draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
              draftsByThreadId: cleanedDrafts.draftsByThreadId,
            });
          }
          return {
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
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
          const cleanedDrafts = removeDraftThreadIfUnmapped({
            threadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
            draftThreadsByThreadId: state.draftThreadsByThreadId,
            draftsByThreadId: state.draftsByThreadId,
          });
          return {
            draftsByThreadId: cleanedDrafts.draftsByThreadId,
            draftThreadsByThreadId: cleanedDrafts.draftThreadsByThreadId,
            projectDraftThreadIdByProjectId: restProjectMappings,
          };
        });
      },
      markDraftThreadPromoting: (threadId, promotedTo) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftThreadsByThreadId[threadId];
          if (!existing) {
            return state;
          }
          const nextPromotedTo = promotedTo ?? threadId;
          if (existing.promotedTo === nextPromotedTo) {
            return state;
          }
          return {
            draftThreadsByThreadId: {
              ...state.draftThreadsByThreadId,
              [threadId]: {
                ...existing,
                promotedTo: nextPromotedTo,
              },
            },
          };
        });
      },
      finalizePromotedDraftThread: (threadId) => {
        const draftThread = get().draftThreadsByThreadId[threadId];
        if (!draftThread?.promotedTo) {
          return;
        }
        get().clearDraftThread(threadId);
      },
      clearDraftThread: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        const removedDraft = get().draftsByThreadId[threadId];
        revokeDraftPreviewUrls(removedDraft);
        deleteDraftComposerImageBlobs(removedDraft);
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
        const rawNormalized = normalizeModelSelection(modelSelection);
        const normalized = rawNormalized ? stripNonStickyModelOptions(rawNormalized) : null;
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
      setPromptHistorySavedDraft: (threadId, savedDraft) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId];
          if ((existing?.promptHistorySavedDraft ?? null) === savedDraft) {
            return state;
          }
          if (existing?.promptHistorySavedDraft) {
            revokePromptHistorySavedDraftPreviewUrls(existing?.promptHistorySavedDraft);
            if (savedDraft === null) {
              deletePersistedComposerImageBlobs(
                existing.promptHistorySavedDraft.persistedAttachments,
              );
            }
          }
          const nextDraft: ComposerThreadDraftState = {
            ...(existing ?? createEmptyThreadDraft()),
            promptHistorySavedDraft: savedDraft,
            ...(savedDraft !== null
              ? {
                  images: [],
                  files: [],
                  nonPersistedImageIds: [],
                  persistedAttachments: [],
                  assistantSelections: [],
                  terminalContexts: [],
                  fileComments: [],
                  pastedTexts: [],
                  skills: [],
                  mentions: [],
                }
              : {}),
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
      restorePromptHistorySavedDraft: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          const savedDraft = current?.promptHistorySavedDraft ?? null;
          if (!current || !savedDraft) {
            return state;
          }
          const restoredImageIds = new Set(savedDraft.images.map((image) => image.id));
          for (const image of current.images) {
            if (!restoredImageIds.has(image.id)) {
              revokeObjectPreviewUrl(image.previewUrl);
            }
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: savedDraft.prompt,
            promptHistorySavedDraft: null,
            images: savedDraft.images,
            files: [...savedDraft.files],
            nonPersistedImageIds: [...savedDraft.nonPersistedImageIds],
            persistedAttachments: [...savedDraft.persistedAttachments],
            assistantSelections: normalizeAssistantSelections(savedDraft.assistantSelections),
            terminalContexts: normalizeTerminalContextsForThread(
              threadId,
              savedDraft.terminalContexts,
            ),
            fileComments: normalizeFileComments(savedDraft.fileComments),
            pastedTexts: normalizePastedTexts(savedDraft.pastedTexts),
            skills: [...savedDraft.skills],
            mentions: [...savedDraft.mentions],
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
      addPromptHistorySavedDraftImage: (threadId, image) => {
        if (threadId.length === 0) return;
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          const savedDraft = current?.promptHistorySavedDraft ?? null;
          if (!current || !savedDraft) {
            revokeObjectPreviewUrl(image.previewUrl);
            return state;
          }
          const images = mergeComposerImages(savedDraft.images, [image]);
          if (!images) return state;
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...current,
                promptHistorySavedDraft: {
                  ...savedDraft,
                  images,
                },
              },
            },
          };
        });
      },
      syncPromptHistorySavedDraftPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return Promise.resolve("rejected");
        }
        const previousAttachments =
          get().draftsByThreadId[threadId]?.promptHistorySavedDraft?.persistedAttachments ?? [];
        const supersededBlobAttachments = findSupersededComposerImageBlobAttachments(
          previousAttachments,
          attachments,
        );
        const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          const savedDraft = current?.promptHistorySavedDraft ?? null;
          if (!current || !savedDraft) {
            return state;
          }
          const nextSavedDraft: ComposerPromptHistorySavedDraft = {
            ...savedDraft,
            persistedAttachments: attachments,
            nonPersistedImageIds: savedDraft.images
              .map((image) => image.id)
              .filter((id) => !attachmentIdSet.has(id)),
          };
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            promptHistorySavedDraft: nextSavedDraft,
          };
          const nextDraftsByThreadId = { ...state.draftsByThreadId };
          if (shouldRemoveDraft(nextDraft)) {
            delete nextDraftsByThreadId[threadId];
          } else {
            nextDraftsByThreadId[threadId] = nextDraft;
          }
          return { draftsByThreadId: nextDraftsByThreadId };
        });
        deletePersistedComposerImageBlobs(supersededBlobAttachments);
        return Promise.resolve().then(() =>
          verifyPromptHistorySavedDraftPersistedAttachments(threadId, attachments, set),
        );
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
      setSkills: (threadId, skills) => {
        if (threadId.length === 0) {
          return;
        }
        const nextSkills = [...skills];
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          if (Equal.equals(existing.skills, nextSkills)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            skills: nextSkills,
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
      setMentions: (threadId, mentions) => {
        if (threadId.length === 0) {
          return;
        }
        const nextMentions = [...mentions];
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          if (Equal.equals(existing.mentions, nextMentions)) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...existing,
            mentions: nextMentions,
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
              nextMap[normalized.provider] = makeModelSelection(
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
          for (const provider of COMPOSER_PROVIDER_KINDS) {
            // Only touch providers explicitly present in the input
            if (!normalizedOpts || !(provider in normalizedOpts)) continue;
            const opts = normalizedOpts[provider];
            const current = nextMap[provider];
            if (opts) {
              const model = current?.model ?? getDefaultModel(provider);
              if (!model) continue;
              nextMap[provider] = makeModelSelection(provider, model, opts);
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
            const nextModel = currentForProvider?.model ?? fallbackModel;
            if (!nextModel) {
              return state;
            }
            nextMap[normalizedProvider] = makeModelSelection(
              normalizedProvider,
              nextModel,
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
              (fallbackModel ? makeModelSelection(normalizedProvider, fallbackModel) : null);
            if (!stickyBase) {
              return state;
            }
            if (providerOpts) {
              nextStickyMap[normalizedProvider] = stripNonStickyModelOptions(
                makeModelSelection(normalizedProvider, stickyBase.model, providerOpts),
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
          const mergedImages = mergeComposerImages(existing.images, images);
          if (!mergedImages) return state;
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                images: mergedImages,
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
        const removedPersistedAttachment = existing.persistedAttachments.find(
          (attachment) => attachment.id === imageId,
        );
        if (removedImage) {
          revokeObjectPreviewUrl(removedImage.previewUrl);
        }
        if (removedPersistedAttachment) {
          deletePersistedComposerImageBlobs([removedPersistedAttachment]);
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
      addFiles: (threadId, files) => {
        if (threadId.length === 0 || files.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const existingIds = new Set(existing.files.map((file) => file.id));
          const existingDedupKeys = new Set(
            existing.files.map((file) => composerFileDedupKey(file)),
          );
          const dedupedIncoming: ComposerFileAttachment[] = [];
          for (const file of files) {
            const dedupKey = composerFileDedupKey(file);
            if (existingIds.has(file.id) || existingDedupKeys.has(dedupKey)) {
              continue;
            }
            dedupedIncoming.push(file);
            existingIds.add(file.id);
            existingDedupKeys.add(dedupKey);
          }
          if (dedupedIncoming.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                files: [...existing.files, ...dedupedIncoming],
              },
            },
          };
        });
      },
      removeFile: (threadId, fileId) => {
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
            files: current.files.filter((file) => file.id !== fileId),
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
      addAssistantSelection: (threadId, selection) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const normalizedSelection = normalizeAssistantSelection(selection);
          if (!normalizedSelection) {
            return state;
          }
          const dedupKey = assistantSelectionDedupKey(normalizedSelection);
          if (
            existing.assistantSelections.some((entry) => entry.id === normalizedSelection.id) ||
            existing.assistantSelections.some(
              (entry) => assistantSelectionDedupKey(entry) === dedupKey,
            )
          ) {
            return state;
          }
          inserted = true;
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                assistantSelections: [...existing.assistantSelections, normalizedSelection],
              },
            },
          };
        });
        return inserted;
      },
      removeAssistantSelection: (threadId, selectionId) => {
        if (threadId.length === 0 || selectionId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            assistantSelections: current.assistantSelections.filter(
              (selection) => selection.id !== selectionId,
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
      clearAssistantSelections: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.assistantSelections.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            assistantSelections: [],
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
      addFileComment: (threadId, comment) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const normalizedComment = normalizeFileComment(comment);
          if (!normalizedComment) {
            return state;
          }
          const dedupKey = fileCommentDedupKey(normalizedComment);
          if (
            existing.fileComments.some((entry) => entry.id === normalizedComment.id) ||
            existing.fileComments.some((entry) => fileCommentDedupKey(entry) === dedupKey)
          ) {
            return state;
          }
          inserted = true;
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                fileComments: [...existing.fileComments, normalizedComment],
              },
            },
          };
        });
        return inserted;
      },
      removeFileComment: (threadId, commentId) => {
        if (threadId.length === 0 || commentId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            fileComments: current.fileComments.filter((comment) => comment.id !== commentId),
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
      clearFileComments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.fileComments.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            fileComments: [],
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
      addPastedTexts: (threadId, pastedTexts) => {
        if (threadId.length === 0 || pastedTexts.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const acceptedPastedTexts = normalizePastedTexts([
            ...existing.pastedTexts,
            ...pastedTexts,
          ]).slice(existing.pastedTexts.length);
          if (acceptedPastedTexts.length === 0) {
            return state;
          }
          return {
            draftsByThreadId: {
              ...state.draftsByThreadId,
              [threadId]: {
                ...existing,
                pastedTexts: [...existing.pastedTexts, ...acceptedPastedTexts],
              },
            },
          };
        });
      },
      removePastedText: (threadId, pastedTextId) => {
        if (threadId.length === 0 || pastedTextId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            pastedTexts: current.pastedTexts.filter((pasted) => pasted.id !== pastedTextId),
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
      clearPastedTexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current || current.pastedTexts.length === 0) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            pastedTexts: [],
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
        const existing = get().draftsByThreadId[threadId];
        if (existing) {
          deletePersistedComposerImageBlobs(existing.persistedAttachments);
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
          return Promise.resolve("rejected");
        }
        const previousAttachments = get().draftsByThreadId[threadId]?.persistedAttachments ?? [];
        const supersededBlobAttachments = findSupersededComposerImageBlobAttachments(
          previousAttachments,
          attachments,
        );
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
        deletePersistedComposerImageBlobs(supersededBlobAttachments);
        return Promise.resolve().then(() => verifyPersistedAttachments(threadId, attachments, set));
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
      setRestoredSourceProposedPlan: (threadId, source) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            restoredSourceProposedPlan: source,
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
      clearComposerContent: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        const clearedDraft = get().draftsByThreadId[threadId];
        deleteDraftComposerImageBlobs(clearedDraft);
        if (options?.preservePreviewUrls !== true) {
          revokeDraftComposerImagePreviewUrls(clearedDraft);
        }
        set((state) => {
          const current = state.draftsByThreadId[threadId];
          if (!current) {
            return state;
          }
          const nextDraft: ComposerThreadDraftState = {
            ...current,
            prompt: "",
            promptHistorySavedDraft: null,
            images: [],
            files: [],
            nonPersistedImageIds: [],
            persistedAttachments: [],
            assistantSelections: [],
            terminalContexts: [],
            fileComments: [],
            pastedTexts: [],
            skills: [],
            mentions: [],
            restoredSourceProposedPlan: null,
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
  availableModelOptionsByProvider?: Partial<
    Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>
  >;
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
        ...(input.availableModelOptionsByProvider !== undefined
          ? { availableModelOptionsByProvider: input.availableModelOptionsByProvider }
          : {}),
      }),
    [
      input.availableModelOptionsByProvider,
      draft,
      input.customModelsByProvider,
      input.projectModelSelection,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

// Mark drafts as promoted first; route/composer cleanup happens after the server thread starts.
export function markPromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  const draftThreadIds = Object.keys(store.draftThreadsByThreadId) as ThreadId[];
  for (const draftId of draftThreadIds) {
    if (serverThreadIds.has(draftId)) {
      store.markDraftThreadPromoting(draftId);
    }
  }
}

export function finalizePromotedDraftThreads(serverThreadIds: ReadonlySet<ThreadId>): void {
  const store = useComposerDraftStore.getState();
  for (const threadId of serverThreadIds) {
    store.finalizePromotedDraftThread(threadId);
  }
}
