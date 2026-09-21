import { useStore } from "../store";

// bounds the hydration wait before returning null — never decide to create against an unhydrated store; callers surface an error on null instead of hanging new chat forever
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
