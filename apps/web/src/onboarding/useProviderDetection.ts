import { useCallback, useEffect, useRef, useState } from "react";

import {
  type RefreshProviderStatusesOptions,
  useRefreshProviderStatusesNow,
} from "~/hooks/useProviderStatusRefresh";

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
      try {
        await refreshProviderStatuses(options);
      } finally {
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
