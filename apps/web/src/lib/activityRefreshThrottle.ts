// FILE: activityRefreshThrottle.ts
// Purpose: Per-workspace throttle for query refreshes driven by agent activity.
// Layer: Web data-fetching helpers
// Why: Agent tool calls complete several times a second per running thread, and each one
//      used to refetch the affected workspace's Git and file queries. With parallel threads
//      that kept the client's RPC lanes and the server's git processes busy for the whole
//      turn. Activity-driven refreshes now start at most once per window per workspace; a
//      trailing pass always follows the last event, so the final state is still read.

import type { QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";

export const ACTIVITY_REFRESH_MIN_INTERVAL_MS = 2_000;

export function createActivityRefreshThrottle(
  refresh: (queryClient: QueryClient, cwd: string) => void,
): (queryClient: QueryClient, cwds: Iterable<string>) => void {
  const throttlersByClient = new WeakMap<QueryClient, Map<string, Throttler<() => void>>>();
  return (queryClient, cwds) => {
    let throttlers = throttlersByClient.get(queryClient);
    if (!throttlers) {
      throttlers = new Map();
      throttlersByClient.set(queryClient, throttlers);
    }
    for (const cwd of new Set(cwds)) {
      if (cwd.length === 0) continue;
      let throttler = throttlers.get(cwd);
      if (!throttler) {
        throttler = new Throttler(() => refresh(queryClient, cwd), {
          wait: ACTIVITY_REFRESH_MIN_INTERVAL_MS,
          leading: true,
          trailing: true,
        });
        throttlers.set(cwd, throttler);
      }
      throttler.maybeExecute();
    }
  };
}
