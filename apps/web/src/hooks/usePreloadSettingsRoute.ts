import { useEffect } from "react";
import { useRouter } from "@tanstack/react-router";

/** Warms the code-split settings route chunk once the browser is idle.
 *
 *  Settings is reached through programmatic `navigate()` calls (sidebar gear,
 *  keyboard shortcut), so the router's intent-based preloading never fires for
 *  it — without this, the first open pays the chunk download/parse cost.
 */
export function usePreloadSettingsRoute() {
  const router = useRouter();

  useEffect(() => {
    const preload = () => {
      router.preloadRoute({ to: "/settings" }).catch(() => {
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
