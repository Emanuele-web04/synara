// FILE: temporaryThread.ts
// Purpose: Isolates temporary-thread auto-delete decisions from route lifecycle effects.
// Layer: Web route/domain helpers
// Exports: switch-aware resolver for temporary thread cleanup

import type { ThreadId } from "@synara/contracts";
import type { DraftThreadState } from "../composerDraftStore";

export function resolveTemporaryThreadIdToDelete(input: {
  previousThreadId: ThreadId | null;
  nextThreadId: ThreadId | null;
  previousThreadWasTemporary?: boolean;
  draftThreadsByThreadId: Record<string, DraftThreadState | undefined>;
}): ThreadId | null {
  const previousThreadId = input.previousThreadId;
  if (!previousThreadId || previousThreadId === input.nextThreadId) {
    return null;
  }
  const previousDraftThread = input.draftThreadsByThreadId[previousThreadId];
  if (input.previousThreadWasTemporary !== true && previousDraftThread?.isTemporary !== true) {
    return null;
  }
  return previousThreadId;
}
