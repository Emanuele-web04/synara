// FILE: useLiveThreadModelSelection.ts
// Purpose: Connects a chat composer to the shared thread model-selection sync, so
//          its model, effort and speed and the phone's stay in step live.
// Layer: Chat composer hook
// Exports: useLiveThreadModelSelection

import type { ModelSelection, ThreadId } from "@synara/contracts";
import { useEffect, useLayoutEffect, useMemo } from "react";

import { hasActiveComposerSend, subscribeComposerSends } from "~/lib/composerSendOwnership";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { onComposerModelSelectionCommitted } from "../../composerModelSelectionCommits";
import { toastManager } from "../ui/toast";
import { createThreadModelSelectionSync } from "./threadModelSelectionSync";

// One sync for every pane, so two panes on one chat share a single pending write.
const threadModelSelectionSync = createThreadModelSelectionSync({
  persist: async (threadId, modelSelection) => {
    const api = readNativeApi();
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId,
      modelSelection,
    });
  },
  showSelection: (threadId, modelSelection) =>
    useComposerDraftStore.getState().syncDraftWithThreadModelSelection(threadId, modelSelection),
  reportFailure: (error) =>
    toastManager.add({
      type: "error",
      title: "Could not change the model",
      description: error instanceof Error ? error.message : "An unexpected error occurred.",
    }),
  isSending: hasActiveComposerSend,
  subscribeSends: subscribeComposerSends,
});

export function useLiveThreadModelSelection(input: {
  threadId: ThreadId;
  /** The selection stored on the server thread; absent for a chat not created yet. */
  serverModelSelection: ModelSelection | null | undefined;
  /** What a send would store: the composer's normalized selection. */
  composerModelSelection: ModelSelection;
}) {
  const { threadId, serverModelSelection, composerModelSelection } = input;
  const queuedTurns = useComposerDraftStore(
    (state) => state.draftsByThreadId[threadId]?.queuedTurns,
  );
  const queuedModelSelections = useMemo(
    () => (queuedTurns ?? []).map((turn) => turn.modelSelection),
    [queuedTurns],
  );

  useLayoutEffect(() => {
    threadModelSelectionSync.updateView({
      threadId,
      serverModelSelection,
      composerModelSelection,
      queuedModelSelections,
    });
  }, [composerModelSelection, queuedModelSelections, serverModelSelection, threadId]);

  useEffect(() => {
    const stopListening = onComposerModelSelectionCommitted((committedThreadId) => {
      if (committedThreadId === threadId) threadModelSelectionSync.committed(threadId);
    });
    return () => {
      stopListening();
      // Leaving the chat stores a pick still waiting out its pause instead of dropping it.
      threadModelSelectionSync.flush(threadId);
    };
  }, [threadId]);

  useEffect(() => {
    threadModelSelectionSync.serverChanged(threadId);
  }, [serverModelSelection, threadId]);
}
