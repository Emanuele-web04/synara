// FILE: composerDraft/composerContent.ts
// Purpose: Reducers for composer-draft content: prompt, runtime/interaction mode, queued turns, images,
//   assistant selections, and terminal contexts.
// Layer: Web state store (reducers)
// Exports: the content reducers consumed by the composer-draft store actions

import type { ProviderInteractionMode, RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
} from "../lib/terminalContext";
import {
  type FileCommentSelection,
  createFileCommentDraft,
  normalizeFileCommentSelection,
} from "../lib/fileComments";
import { revokeObjectPreviewUrl } from "./cleanup";
import {
  assistantSelectionDedupKey,
  composerImageDedupKey,
  normalizeAssistantSelection,
  normalizeTerminalContextForThread,
  normalizeTerminalContextsForThread,
  terminalContextDedupKey,
} from "./normalize";
import {
  buildTransferredComposerDraft,
  commitDraft,
  createEmptyThreadDraft,
} from "./draftMutations";
import type {
  ComposerAssistantSelectionAttachment,
  ComposerDraftStoreState,
  ComposerImageAttachment,
  ComposerThreadDraftState,
  QueuedComposerTurn,
} from "../composerDraftStore";

type StateChange = ComposerDraftStoreState | Partial<ComposerDraftStoreState>;

export function setPromptReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  prompt: string,
): StateChange {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  return commitDraft(state, threadId, { ...existing, prompt });
}

export function setTerminalContextsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  normalizedContexts: TerminalContextDraft[],
): StateChange {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  const nextDraft: ComposerThreadDraftState = {
    ...existing,
    prompt: ensureInlineTerminalContextPlaceholders(existing.prompt, normalizedContexts.length),
    terminalContexts: normalizedContexts,
  };
  return commitDraft(state, threadId, nextDraft);
}

export function setRuntimeModeReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  nextRuntimeMode: RuntimeMode | null,
): StateChange {
  const existing = state.draftsByThreadId[threadId];
  if (!existing && nextRuntimeMode === null) {
    return state;
  }
  const base = existing ?? createEmptyThreadDraft();
  if (base.runtimeMode === nextRuntimeMode) {
    return state;
  }
  return commitDraft(state, threadId, { ...base, runtimeMode: nextRuntimeMode });
}

export function setInteractionModeReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  nextInteractionMode: ProviderInteractionMode | null,
): StateChange {
  const existing = state.draftsByThreadId[threadId];
  if (!existing && nextInteractionMode === null) {
    return state;
  }
  const base = existing ?? createEmptyThreadDraft();
  if (base.interactionMode === nextInteractionMode) {
    return state;
  }
  return commitDraft(state, threadId, { ...base, interactionMode: nextInteractionMode });
}

export function enqueueQueuedTurnReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  queuedTurn: QueuedComposerTurn,
): StateChange {
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
}

export function insertQueuedTurnReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  queuedTurn: QueuedComposerTurn,
  index: number,
): StateChange {
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
}

export function removeQueuedTurnReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  queuedTurnId: string,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current || current.queuedTurns.every((entry) => entry.id !== queuedTurnId)) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...current,
    queuedTurns: current.queuedTurns.filter((entry) => entry.id !== queuedTurnId),
  };
  return commitDraft(state, threadId, nextDraft);
}

export function addImagesReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  images: ComposerImageAttachment[],
): StateChange {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  const existingIds = new Set(existing.images.map((image) => image.id));
  const existingDedupKeys = new Set(existing.images.map((image) => composerImageDedupKey(image)));
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
}

export function removeImageReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  imageId: string,
): StateChange {
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
  return commitDraft(state, threadId, nextDraft);
}

export function addAssistantSelectionReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  selection: ComposerAssistantSelectionAttachment,
): { change: StateChange; inserted: boolean } {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  const normalizedSelection = normalizeAssistantSelection(selection);
  if (!normalizedSelection) {
    return { change: state, inserted: false };
  }
  const dedupKey = assistantSelectionDedupKey(normalizedSelection);
  if (
    existing.assistantSelections.some((entry) => entry.id === normalizedSelection.id) ||
    existing.assistantSelections.some((entry) => assistantSelectionDedupKey(entry) === dedupKey)
  ) {
    return { change: state, inserted: false };
  }
  return {
    inserted: true,
    change: {
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: {
          ...existing,
          assistantSelections: [...existing.assistantSelections, normalizedSelection],
        },
      },
    },
  };
}

export function removeAssistantSelectionReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  selectionId: string,
): StateChange {
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
  return commitDraft(state, threadId, nextDraft);
}

export function clearAssistantSelectionsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current || current.assistantSelections.length === 0) {
    return state;
  }
  return commitDraft(state, threadId, { ...current, assistantSelections: [] });
}

function fileCommentDedupKey(comment: FileCommentSelection): string {
  return [comment.path, String(comment.startLine), String(comment.endLine), comment.text].join(
    "\u0000",
  );
}

export function addFileCommentReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  selection: FileCommentSelection,
): { change: StateChange; inserted: boolean } {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  const normalizedSelection = normalizeFileCommentSelection(selection);
  if (!normalizedSelection) {
    return { change: state, inserted: false };
  }
  const dedupKey = fileCommentDedupKey(normalizedSelection);
  if (existing.fileComments.some((comment) => fileCommentDedupKey(comment) === dedupKey)) {
    return { change: state, inserted: false };
  }
  const draft = createFileCommentDraft(normalizedSelection);
  if (!draft) {
    return { change: state, inserted: false };
  }
  return {
    inserted: true,
    change: commitDraft(state, threadId, {
      ...existing,
      fileComments: [...existing.fileComments, draft],
    }),
  };
}

export function clearFileCommentsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current || current.fileComments.length === 0) {
    return state;
  }
  return commitDraft(state, threadId, { ...current, fileComments: [] });
}

export function insertTerminalContextReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  prompt: string,
  context: TerminalContextDraft,
  index: number,
): { change: StateChange; inserted: boolean } {
  const existing = state.draftsByThreadId[threadId] ?? createEmptyThreadDraft();
  const normalizedContext = normalizeTerminalContextForThread(threadId, context);
  if (!normalizedContext) {
    return { change: state, inserted: false };
  }
  const dedupKey = terminalContextDedupKey(normalizedContext);
  if (
    existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
    existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
  ) {
    return { change: state, inserted: false };
  }
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
    inserted: true,
    change: {
      draftsByThreadId: {
        ...state.draftsByThreadId,
        [threadId]: nextDraft,
      },
    },
  };
}

export function addTerminalContextsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  contexts: TerminalContextDraft[],
): StateChange {
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
}

export function removeTerminalContextReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  contextId: string,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...current,
    terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
  };
  return commitDraft(state, threadId, nextDraft);
}

export function clearTerminalContextsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current || current.terminalContexts.length === 0) {
    return state;
  }
  return commitDraft(state, threadId, { ...current, terminalContexts: [] });
}

export function clearPersistedAttachmentsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current) {
    return state;
  }
  const nextDraft: ComposerThreadDraftState = {
    ...current,
    persistedAttachments: [],
    nonPersistedImageIds: [],
  };
  return commitDraft(state, threadId, nextDraft);
}

export function syncPersistedAttachmentsReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  attachments: ComposerThreadDraftState["persistedAttachments"],
): StateChange {
  const current = state.draftsByThreadId[threadId];
  if (!current) {
    return state;
  }
  const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
  const nextDraft: ComposerThreadDraftState = {
    ...current,
    // Stage attempted attachments so persist middleware can try writing them.
    persistedAttachments: attachments,
    nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => !attachmentIdSet.has(id)),
  };
  return commitDraft(state, threadId, nextDraft);
}

export function copyTransferableComposerStateReducer(
  state: ComposerDraftStoreState,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
): StateChange {
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
  return commitDraft(state, targetThreadId, nextDraft);
}

export function clearComposerContentReducer(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
): StateChange {
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
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    skills: [],
    mentions: [],
  };
  return commitDraft(state, threadId, nextDraft);
}
