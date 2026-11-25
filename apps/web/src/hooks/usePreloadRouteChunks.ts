import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms the programmatic routes that do not get Link intent preloading.
 *  New chat needs its chunk immediately. Settings can warm after startup. */
export function usePreloadRouteChunks() {
  const router = useRouter();

  useEffect(() => {
    const warmChunk = async (routeId: "/_chat/$threadId" | "/_chat/settings") => {
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

    const preloadSettings = () => void warmChunk("/_chat/settings");
    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preloadSettings, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preloadSettings, 1500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
