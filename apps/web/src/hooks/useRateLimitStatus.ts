// FILE: useRateLimitStatus.ts
// Purpose: Recompute scoped quota state on updates and when its reset time passes.

import type { OrchestrationThreadActivity, ProviderKind } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";
import { deriveLatestRateLimitStatus } from "~/lib/rateLimitStatus";

export function useRateLimitStatus(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  provider: ProviderKind | undefined,
  instanceId: string | undefined,
) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const status = useMemo(
    () =>
      deriveLatestRateLimitStatus(
        activities,
        Math.max(Date.now(), nowMs),
        provider && instanceId ? { provider, instanceId } : undefined,
      ),
    [activities, nowMs, provider, instanceId],
  );
  const resetsAt = status?.resetsAt;
  useEffect(() => {
    if (!resetsAt) return;
    const resetMs = Date.parse(resetsAt);
    if (!Number.isFinite(resetMs)) return;
    const timer = setTimeout(
      () => setNowMs(Date.now()),
      Math.min(2_147_483_647, Math.max(0, resetMs - Date.now()) + 1),
    );
    return () => clearTimeout(timer);
  }, [resetsAt, nowMs]);
  return status;
}
