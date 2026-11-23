import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms code-split route chunks once the browser is idle.
 *
 *  The thread route is reached through programmatic `navigate()` calls (the
 *  "New thread" button, keyboard shortcuts), so warming its chunk avoids paying
 *  the chunk download/parse cost on the draft-landing paint. Settings relies on
 *  TanStack Router's intent-based preloading instead of downloading ~460 KB
 *  unconditionally on every cold boot.
 */
export function usePreloadRouteChunks() {
  const router = useRouter();

  useEffect(() => {
    const warmChunk = async (routeId: "/_chat/$threadId") => {
      try {
        // Preload the code without a speculative route match. Navigation can
        // evict a component-only match while its chunk is still loading.
        await router.loadRouteChunk(router.routesById[routeId]);
      } catch {
        // Warming is best-effort; navigation loads the route on demand.
      }
    };

    // Start before idle callbacks so the first New chat can reuse this load.
    void warmChunk("/_chat/$threadId");
  }, [router]);
}
