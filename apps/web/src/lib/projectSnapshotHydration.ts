// FILE: projectSnapshotHydration.ts
// Purpose: Wait for the first shell snapshot before container ensure/prewarm flows decide
//          whether to create a project — an unhydrated (empty) local store must never be
//          mistaken for "the container doesn't exist yet".
// Layer: Web orchestration helper
// Exports: waitForProjectSnapshotHydration, shared by the chat and Studio container flows.

import { useStore } from "../store";

export function waitForProjectSnapshotHydration(): Promise<void> {
  if (useStore.getState().threadsHydrated) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      unsubscribe?.();
      resolve();
    };

    unsubscribe = useStore.subscribe((state) => {
      if (state.threadsHydrated) {
        finish();
      }
    });
    if (useStore.getState().threadsHydrated) {
      finish();
    }
  });
}
