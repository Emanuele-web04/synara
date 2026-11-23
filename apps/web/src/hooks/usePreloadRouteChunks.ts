import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms code-split route chunks once the browser is idle.
 *
 *  Settings and thread routes are reached through programmatic `navigate()`
 *  calls (sidebar gear, keyboard shortcut, the "New thread" button), so the
 *  router's intent-based preloading never fires for them — without this, the
 *  first open pays the chunk download/parse cost. For a brand-new thread that
 *  cost lands right on the draft-landing paint, so warming the thread chunk is
 *  the largest single lever for new-chat startup time.
 */
export function usePreloadRouteChunks() {
  const router = useRouter();

  useEffect(() => {
    // Defer thread-route warming until the browser is idle so it never competes
    // with initial paint, WebSocket hydration, or landing-page interactivity.
    // Settings relies on TanStack Router's `defaultPreload: "intent"` on hover/focus
    // instead of downloading ~450 KB unconditionally on every cold boot.
    const preloadThreadRoute = () => {
      router.preloadRoute({ to: "/$threadId", params: { threadId: "chunk-preload" } }).catch(() => {
        // Preloading is best-effort; navigation falls back to loading on demand.
      });
    };

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preloadThreadRoute, { timeout: 4000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preloadThreadRoute, 2500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
