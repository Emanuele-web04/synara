// FILE: composerDraftStore.ts
// Purpose: Stores composer drafts, model selections, queued turns, and sticky provider choices.
// Layer: Web state store
// Depends on: contracts schemas, app model resolution helpers, and zustand persistence.

import {
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
} from "@t3tools/contracts";
import { getDefaultModel, normalizeModelSlug } from "@t3tools/shared/model";
import { useMemo } from "react";
import {
  type ChatAssistantSelectionAttachment,
  type ChatImageAttachment,
  type ThreadPrimarySurface,
} from "./types";
import { type TerminalContextDraft } from "./lib/terminalContext";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createDebouncedStorage, createMemoryStorage } from "./lib/storage";
import {
  revokeDraftPreviewUrls,
  revokeObjectPreviewUrl,
  revokeQueuedTurnPreviewUrls,
} from "./composerDraft/cleanup";
import { normalizeTerminalContextsForThread } from "./composerDraft/normalize";
import {
  type EffectiveComposerModelState,
  deriveEffectiveComposerModelState,
  normalizeModelSelection,
  normalizeProviderKind,
  normalizeProviderModelOptions,
  resolvePreferredComposerModelSelection,
} from "./composerDraft/modelSelection";
import { toHydratedThreadDraft } from "./composerDraft/hydration";
import { commitDraft } from "./composerDraft/draftMutations";
import {
  type SetDraftThreadContextOptions,
  type SetProjectDraftThreadOptions,
  clearDraftThreadReducer,
  clearProjectDraftThreadByIdReducer,
  clearProjectDraftThreadIdReducer,
  clearProjectDraftThreadsReducer,
  markDraftThreadPromotingReducer,
  setDraftThreadContextReducer,
  setProjectDraftThreadIdReducer,
} from "./composerDraft/draftThreads";
import {
  applyStickyStateReducer,
  setModelOptionsReducer,
  setModelSelectionReducer,
  setProviderModelOptionsReducer,
  setStickyModelSelectionReducer,
} from "./composerDraft/modelActions";
import {
  addAssistantSelectionReducer,
  addImagesReducer,
  addTerminalContextsReducer,
  clearAssistantSelectionsReducer,
  clearComposerContentReducer,
  clearPersistedAttachmentsReducer,
  clearTerminalContextsReducer,
  copyTransferableComposerStateReducer,
  enqueueQueuedTurnReducer,
  insertQueuedTurnReducer,
  insertTerminalContextReducer,
  removeAssistantSelectionReducer,
  removeImageReducer,
  removeQueuedTurnReducer,
  removeTerminalContextReducer,
  setInteractionModeReducer,
  setPromptReducer,
  setRuntimeModeReducer,
  setTerminalContextsReducer,
  syncPersistedAttachmentsReducer,
} from "./composerDraft/composerContent";
import { projectDraftThreadMappingKey } from "./composerDraft/draftThreadKeys";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  type DraftThreadEnvMode,
  type LegacyCodexFields,
  PersistedComposerImageAttachment,
} from "./composerDraft/persistedSchema";
import {
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  normalizeDraftThreadEntryPoint,
  partializeComposerDraftStoreState,
  readPersistedAttachmentIdsFromStorage,
} from "./composerDraft/persistence";

export { COMPOSER_DRAFT_STORAGE_KEY };

export { deriveEffectiveComposerModelState, resolvePreferredComposerModelSelection };
export type { EffectiveComposerModelState };
export type { DraftThreadEnvMode };
export { PersistedComposerImageAttachment };
export type { LegacyCodexFields };

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

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

export interface ComposerImageAttachment extends Omit<ChatImageAttachment, "previewUrl"> {
  previewUrl: string;
  file: File;
}

export type ComposerAssistantSelectionAttachment = ChatAssistantSelectionAttachment;

export interface QueuedComposerChatTurn {
  id: string;
  kind: "chat";
  createdAt: string;
  previewText: string;
  prompt: string;
  images: ComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
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

export interface ComposerThreadDraftState {
  prompt: string;
  images: ComposerImageAttachment[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  assistantSelections: ComposerAssistantSelectionAttachment[];
  terminalContexts: TerminalContextDraft[];
  skills: ProviderSkillReference[];
  mentions: ProviderMentionReference[];
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
  lastKnownPr?: OrchestrationThreadPullRequest | null;
  envMode: DraftThreadEnvMode;
  isTemporary?: boolean;
  promotedTo?: ThreadId;
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
    options?: SetProjectDraftThreadOptions,
  ) => void;
  setDraftThreadContext: (threadId: ThreadId, options: SetDraftThreadContextOptions) => void;
  registerDraftThread: (
    threadId: ThreadId,
    options: Omit<SetDraftThreadContextOptions, "entryPoint"> & {
      projectId: ProjectId;
      entryPoint?: ThreadPrimarySurface;
    },
  ) => void;
  clearProjectDraftThreadId: (projectId: ProjectId, entryPoint?: ThreadPrimarySurface) => void;
  clearProjectDraftThreads: (projectId: ProjectId) => void;
  clearProjectDraftThreadById: (projectId: ProjectId, threadId: ThreadId) => void;
  markDraftThreadPromoting: (threadId: ThreadId, promotedTo?: ThreadId) => void;
  finalizePromotedDraftThread: (threadId: ThreadId) => void;
  clearDraftThread: (threadId: ThreadId) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadId: ThreadId, prompt: string) => void;
  setSkills: (threadId: ThreadId, skills: ProviderSkillReference[]) => void;
  setMentions: (threadId: ThreadId, mentions: ProviderMentionReference[]) => void;
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
  addAssistantSelection: (
    threadId: ThreadId,
    selection: ComposerAssistantSelectionAttachment,
  ) => boolean;
  removeAssistantSelection: (threadId: ThreadId, selectionId: string) => void;
  clearAssistantSelections: (threadId: ThreadId) => void;
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

const EMPTY_IMAGES: ComposerImageAttachment[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_SKILLS: ProviderSkillReference[] = [];
const EMPTY_MENTIONS: ProviderMentionReference[] = [];
const EMPTY_QUEUED_TURNS: QueuedComposerTurn[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_SKILLS);
Object.freeze(EMPTY_MENTIONS);
Object.freeze(EMPTY_QUEUED_TURNS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderKind, ModelSelection>> =
  Object.freeze({});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  assistantSelections: [],
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  skills: EMPTY_SKILLS,
  mentions: EMPTY_MENTIONS,
  queuedTurns: EMPTY_QUEUED_TURNS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

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
    return commitDraft(state, threadId, nextDraft);
  });
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
        set((state) => setProjectDraftThreadIdReducer(state, projectId, threadId, options));
      },
      setDraftThreadContext: (threadId, options) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => setDraftThreadContextReducer(state, threadId, options));
      },
      registerDraftThread: (threadId, options) => {
        if (threadId.length === 0 || options.projectId.length === 0) {
          return;
        }
        set((state) =>
          setDraftThreadContextReducer(state, threadId, {
            ...options,
            entryPoint: options.entryPoint ?? "chat",
          }),
        );
      },
      clearProjectDraftThreadId: (projectId, entryPoint = "chat") => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => clearProjectDraftThreadIdReducer(state, projectId, entryPoint));
      },
      clearProjectDraftThreads: (projectId) => {
        if (projectId.length === 0) {
          return;
        }
        set((state) => clearProjectDraftThreadsReducer(state, projectId));
      },
      clearProjectDraftThreadById: (projectId, threadId) => {
        if (projectId.length === 0 || threadId.length === 0) {
          return;
        }
        set((state) => clearProjectDraftThreadByIdReducer(state, projectId, threadId));
      },
      markDraftThreadPromoting: (threadId, promotedTo) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => markDraftThreadPromotingReducer(state, threadId, promotedTo));
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
        revokeDraftPreviewUrls(get().draftsByThreadId[threadId]);
        set((state) => clearDraftThreadReducer(state, threadId));
      },
      setStickyModelSelection: (modelSelection) => {
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => setStickyModelSelectionReducer(state, normalized));
      },
      applyStickyState: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => applyStickyStateReducer(state, threadId));
      },
      setPrompt: (threadId, prompt) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => setPromptReducer(state, threadId, prompt));
      },
      setSkills: (threadId, skills) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT;
          return commitDraft(state, threadId, { ...existing, skills: [...skills] });
        });
      },
      setMentions: (threadId, mentions) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => {
          const existing = state.draftsByThreadId[threadId] ?? EMPTY_THREAD_DRAFT;
          return commitDraft(state, threadId, { ...existing, mentions: [...mentions] });
        });
      },
      setTerminalContexts: (threadId, contexts) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
        set((state) => setTerminalContextsReducer(state, threadId, normalizedContexts));
      },
      setModelSelection: (threadId, modelSelection) => {
        if (threadId.length === 0) {
          return;
        }
        const normalized = normalizeModelSelection(modelSelection);
        set((state) => setModelSelectionReducer(state, threadId, normalized));
      },
      setModelOptions: (threadId, modelOptions) => {
        if (threadId.length === 0) {
          return;
        }
        const normalizedOpts = normalizeProviderModelOptions(modelOptions);
        set((state) => setModelOptionsReducer(state, threadId, normalizedOpts));
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

        set((state) =>
          setProviderModelOptionsReducer(
            state,
            threadId,
            normalizedProvider,
            providerOpts,
            fallbackModel,
            options?.persistSticky === true,
          ),
        );
      },
      setRuntimeMode: (threadId, runtimeMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextRuntimeMode =
          runtimeMode === "approval-required" || runtimeMode === "full-access" ? runtimeMode : null;
        set((state) => setRuntimeModeReducer(state, threadId, nextRuntimeMode));
      },
      setInteractionMode: (threadId, interactionMode) => {
        if (threadId.length === 0) {
          return;
        }
        const nextInteractionMode =
          interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
        set((state) => setInteractionModeReducer(state, threadId, nextInteractionMode));
      },
      // Keep queued follow-ups with the thread draft so route changes do not hide them.
      enqueueQueuedTurn: (threadId, queuedTurn) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => enqueueQueuedTurnReducer(state, threadId, queuedTurn));
      },
      insertQueuedTurn: (threadId, queuedTurn, index) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => insertQueuedTurnReducer(state, threadId, queuedTurn, index));
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
        set((state) => removeQueuedTurnReducer(state, threadId, queuedTurnId));
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
        set((state) => addImagesReducer(state, threadId, images));
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
        set((state) => removeImageReducer(state, threadId, imageId));
      },
      addAssistantSelection: (threadId, selection) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const result = addAssistantSelectionReducer(state, threadId, selection);
          inserted = result.inserted;
          return result.change;
        });
        return inserted;
      },
      removeAssistantSelection: (threadId, selectionId) => {
        if (threadId.length === 0 || selectionId.length === 0) {
          return;
        }
        set((state) => removeAssistantSelectionReducer(state, threadId, selectionId));
      },
      clearAssistantSelections: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => clearAssistantSelectionsReducer(state, threadId));
      },
      insertTerminalContext: (threadId, prompt, context, index) => {
        if (threadId.length === 0) {
          return false;
        }
        let inserted = false;
        set((state) => {
          const result = insertTerminalContextReducer(state, threadId, prompt, context, index);
          inserted = result.inserted;
          return result.change;
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
        set((state) => addTerminalContextsReducer(state, threadId, contexts));
      },
      removeTerminalContext: (threadId, contextId) => {
        if (threadId.length === 0 || contextId.length === 0) {
          return;
        }
        set((state) => removeTerminalContextReducer(state, threadId, contextId));
      },
      clearTerminalContexts: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => clearTerminalContextsReducer(state, threadId));
      },
      clearPersistedAttachments: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => clearPersistedAttachmentsReducer(state, threadId));
      },
      syncPersistedAttachments: (threadId, attachments) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => syncPersistedAttachmentsReducer(state, threadId, attachments));
        Promise.resolve().then(() => {
          verifyPersistedAttachments(threadId, attachments, set);
        });
      },
      copyTransferableComposerState: (sourceThreadId, targetThreadId) => {
        if (sourceThreadId.length === 0 || targetThreadId.length === 0) {
          return;
        }
        set((state) => copyTransferableComposerStateReducer(state, sourceThreadId, targetThreadId));
      },
      clearComposerContent: (threadId) => {
        if (threadId.length === 0) {
          return;
        }
        set((state) => clearComposerContentReducer(state, threadId));
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
