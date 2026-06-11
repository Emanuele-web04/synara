// FILE: composerDraft/draftMutations.ts
// Purpose: Shared per-thread composer-draft builders and the commit helper that drops empty drafts.
// Layer: Web state store (pure helpers)
// Exports: createEmptyThreadDraft, buildTransferredComposerDraft, commitDraft

import type { ThreadId } from "@t3tools/contracts";
import { normalizeAssistantSelections, normalizeTerminalContextsForThread } from "./normalize";
import { shouldRemoveDraft } from "./cleanup";
import type { ComposerDraftStoreState, ComposerThreadDraftState } from "../composerDraftStore";

export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    assistantSelections: [],
    terminalContexts: [],
    queuedTurns: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

export function buildTransferredComposerDraft(input: {
  sourceDraft: ComposerThreadDraftState;
  targetDraft: ComposerThreadDraftState | undefined;
  targetThreadId: ThreadId;
}): ComposerThreadDraftState {
  const { sourceDraft, targetDraft, targetThreadId } = input;
  const base = targetDraft ?? createEmptyThreadDraft();
  return {
    ...base,
    prompt: sourceDraft.prompt,
    assistantSelections: normalizeAssistantSelections(sourceDraft.assistantSelections),
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
