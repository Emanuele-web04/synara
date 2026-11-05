// FILE: composerModelSelectionCommits.ts
// Purpose: Announces the model, effort and speed choices the user commits in a
//          composer, so a started chat can store them on the server right away.
// Exports: onComposerModelSelectionCommitted, notifyComposerModelSelectionCommitted

import type { ThreadId } from "@synara/contracts";

type ComposerModelSelectionCommitListener = (threadId: ThreadId) => void;

const listeners = new Set<ComposerModelSelectionCommitListener>();

export function onComposerModelSelectionCommitted(
  listener: ComposerModelSelectionCommitListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyComposerModelSelectionCommitted(threadId: ThreadId): void {
  for (const listener of listeners) {
    listener(threadId);
  }
}
