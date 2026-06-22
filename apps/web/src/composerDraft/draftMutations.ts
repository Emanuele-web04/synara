// FILE: composerDraft/draftMutations.ts
// Purpose: Shared per-thread composer-draft builders and the commit helper that drops empty drafts.
// Layer: Web state store (pure helpers)
// Exports: createEmptyThreadDraft, buildTransferredComposerDraft, commitDraft

import type { ThreadId } from "@t3tools/contracts";
import { normalizeAssistantSelections, normalizeTerminalContextsForThread } from "./normalize";
import { shouldRemoveDraft } from "./cleanup";
import type {
  ComposerDraftStoreState,
  ComposerImageAttachment,
  ComposerThreadDraftState,
} from "../composerDraftStore";

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    fileComments: [],
    skills: [],
    mentions: [],
    queuedTurns: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function copyComposerImage(image: ComposerImageAttachment): ComposerImageAttachment {
  const previewUrl =
    typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
      ? URL.createObjectURL(image.file)
      : image.previewUrl;
  return {
    ...image,
    previewUrl,
  };
}

export function buildTransferredComposerDraft(input: {
  sourceDraft: ComposerThreadDraftState;
  targetDraft: ComposerThreadDraftState | undefined;
  targetThreadId: ThreadId;
}): ComposerThreadDraftState {
  const { sourceDraft, targetDraft, targetThreadId } = input;
  const base = targetDraft ?? createEmptyThreadDraft();
  const images = sourceDraft.images.map(copyComposerImage);
  const imageIds = new Set(images.map((image) => image.id));
  return {
    ...base,
    prompt: sourceDraft.prompt,
    images,
    nonPersistedImageIds: sourceDraft.nonPersistedImageIds.filter((imageId) =>
      imageIds.has(imageId),
    ),
    persistedAttachments: sourceDraft.persistedAttachments.filter((attachment) =>
      imageIds.has(attachment.id),
    ),
    assistantSelections: normalizeAssistantSelections(sourceDraft.assistantSelections),
    fileComments: sourceDraft.fileComments.map((comment) => ({ ...comment })),
    skills: [...sourceDraft.skills],
    mentions: [...sourceDraft.mentions],
    terminalContexts: normalizeTerminalContextsForThread(
      targetThreadId,
      sourceDraft.terminalContexts,
    ),
  };
}

// Store the next draft, or drop the thread entry entirely when the draft is empty.
export function commitDraft(
  state: ComposerDraftStoreState,
  threadId: ThreadId,
  nextDraft: ComposerThreadDraftState,
): Pick<ComposerDraftStoreState, "draftsByThreadId"> {
  const nextDraftsByThreadId = { ...state.draftsByThreadId };
  if (shouldRemoveDraft(nextDraft)) {
    delete nextDraftsByThreadId[threadId];
  } else {
    nextDraftsByThreadId[threadId] = nextDraft;
  }
  return { draftsByThreadId: nextDraftsByThreadId };
}
