// FILE: useProviderDetection.ts
// Purpose: Provider detection for the welcome tour. Probes as soon as the tour opens so
//          the agents step has results by the time the user reaches it, and reports
//          whether a probe is still running so missing statuses are not shown as
//          "not installed" while detection is in flight.
// Layer: Web hook
// Exports: useProviderDetection, PROVIDER_DETECTION_TIMEOUT_MS

import { useCallback, useEffect, useRef, useState } from "react";

import {
  type RefreshProviderStatusesOptions,
  useRefreshProviderStatusesNow,
} from "~/hooks/useProviderStatusRefresh";

// Longer than the slowest server-side provider probe (20s), so the loading state only
// gives up on a refresh that is stuck, not one that is slow. A refresh that settles
// later still lands in the server-config cache.
export const PROVIDER_DETECTION_TIMEOUT_MS = 30_000;

export interface ProviderDetection {
  readonly detecting: boolean;
  readonly detect: (options?: RefreshProviderStatusesOptions) => Promise<void>;
}

export function useProviderDetection(): ProviderDetection {
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  const [pendingProbes, setPendingProbes] = useState(0);

  const detect = useCallback(
    async (options?: RefreshProviderStatusesOptions) => {
      setPendingProbes((count) => count + 1);
      let timeoutId: number | undefined;
      try {
        await Promise.race([
          refreshProviderStatuses(options),
          new Promise<void>((resolve) => {
            timeoutId = window.setTimeout(resolve, PROVIDER_DETECTION_TIMEOUT_MS);
          }),
        ]);
      } finally {
        window.clearTimeout(timeoutId);
        setPendingProbes((count) => count - 1);
      }
    },
    [refreshProviderStatuses],
  );

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void detect({ silent: true });
  }, [detect]);

  return { detecting: pendingProbes > 0, detect };
}
