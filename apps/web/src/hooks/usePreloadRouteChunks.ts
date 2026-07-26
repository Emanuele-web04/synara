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
    const preload = () => {
      router.preloadRoute({ to: "/settings" }).catch(() => {
        // Preloading is best-effort; navigation falls back to loading on demand.
      });
      // The param value is irrelevant: the route has no loader, so preloading
      // only fetches and evaluates the chunk shared by every thread id.
      router.preloadRoute({ to: "/$threadId", params: { threadId: "chunk-preload" } }).catch(() => {
        // Preloading is best-effort; navigation falls back to loading on demand.
      });
    };

    if (typeof requestIdleCallback === "function") {
      const idleCallbackId = requestIdleCallback(preload, { timeout: 5000 });
      return () => cancelIdleCallback(idleCallbackId);
    }
    const timeoutId = setTimeout(preload, 1500);
    return () => clearTimeout(timeoutId);
  }, [router]);
}
