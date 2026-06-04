// FILE: useProviderAuthRefreshOnFocus.ts
// Purpose: Re-probe provider auth status when the window regains focus/visibility,
//   so account changes made outside the app (e.g. `claude login` / logout / adding
//   an account in a terminal) reflect without restarting the app.
// Layer: Web UI hooks
// Exports: useProviderAuthRefreshOnFocus

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerConfig } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";

// Minimum gap between window-focus-triggered provider auth re-probes, so rapid
// focus/visibility changes can't spawn redundant CLI probes on the server.
const PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS = 15_000;

export function useProviderAuthRefreshOnFocus(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return;
    }
    let disposed = false;
    let lastRefreshAtMs = 0;
    const refreshProviderAuth = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const nowMs = Date.now();
      if (nowMs - lastRefreshAtMs < PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      lastRefreshAtMs = nowMs;
      const api = readNativeApi();
      if (!api) {
        return;
      }
      void api.server
        .refreshProviders()
        .then((result) => {
          if (disposed) {
            return;
          }
          queryClient.setQueryData<ServerConfig>(serverQueryKeys.config(), (current) =>
            current ? { ...current, providers: result.providers } : current,
          );
        })
        .catch(() => undefined);
    };
    window.addEventListener("focus", refreshProviderAuth);
    document.addEventListener("visibilitychange", refreshProviderAuth);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshProviderAuth);
      document.removeEventListener("visibilitychange", refreshProviderAuth);
    };
  }, [queryClient]);
}
