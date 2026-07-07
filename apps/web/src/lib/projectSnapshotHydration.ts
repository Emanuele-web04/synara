// FILE: projectSnapshotHydration.ts
// Purpose: Wait for the first shell snapshot before container ensure/prewarm flows decide
//          whether to create a project — an unhydrated (empty) local store must never be
//          mistaken for "the container doesn't exist yet".
// Layer: Web orchestration helper
// Exports: waitForProjectSnapshotHydration, shared by the chat and Studio container flows.

import { useStore } from "../store";

// Bounds how long ensureHomeChatProject/ensureStudioProject will wait for hydration before
// giving up and returning null (never deciding to create against an unhydrated store). Callers
// surface a user-visible error on null rather than hanging "new chat" forever.
export const PROJECT_SNAPSHOT_HYDRATION_TIMEOUT_MS = 15_000;

export function waitForProjectSnapshotHydration(options?: {
  readonly timeoutMs?: number;
}): Promise<boolean> {
  if (useStore.getState().threadsHydrated) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const finish = (hydrated: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
      }
      resolve(hydrated);
    };

    unsubscribe = useStore.subscribe((state) => {
      if (state.threadsHydrated) {
        finish(true);
      }
    });
    if (useStore.getState().threadsHydrated) {
      finish(true);
      return;
    }

    if (options?.timeoutMs !== undefined) {
      timeoutId = setTimeout(() => finish(false), options.timeoutMs);
    }
  });
}
