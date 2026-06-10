// FILE: useProviderStatusRefresh.ts
// Purpose: Shared provider-status refresh hook for focus and periodic version checks.
// Layer: Web hooks
// Exports: useProviderStatusRefresh

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ServerConfig } from "@t3tools/contracts";
import { readNativeApi } from "../nativeApi";
import { serverQueryKeys } from "../lib/serverReactQuery";

type ProviderStatusRefreshOptions = {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly intervalMs?: number;
  readonly minIntervalMs?: number;
  readonly refreshOnFocus?: boolean;
};

export function useProviderStatusRefresh(options: ProviderStatusRefreshOptions): void {
  const queryClient = useQueryClient();
  const enabled = options.enabled ?? true;
  const initialDelayMs = options.initialDelayMs;
  const intervalMs = options.intervalMs;
  const minIntervalMs = options.minIntervalMs ?? 0;
  const refreshOnFocus = options.refreshOnFocus ?? false;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      return;
    }

    let disposed = false;
    let lastRefreshAtMs = 0;
    const refreshProviderStatuses = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      const nowMs = Date.now();
      if (minIntervalMs > 0 && nowMs - lastRefreshAtMs < minIntervalMs) {
        return;
      }
      const api = readNativeApi();
      if (!api) {
        return;
      }
      lastRefreshAtMs = nowMs;
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

    const initialRefreshId =
      typeof initialDelayMs === "number" && initialDelayMs >= 0
        ? window.setTimeout(refreshProviderStatuses, initialDelayMs)
        : null;
    const refreshIntervalId =
      typeof intervalMs === "number" && intervalMs > 0
        ? window.setInterval(refreshProviderStatuses, intervalMs)
        : null;

    if (refreshOnFocus) {
      window.addEventListener("focus", refreshProviderStatuses);
      document.addEventListener("visibilitychange", refreshProviderStatuses);
    }

    return () => {
      disposed = true;
      if (initialRefreshId !== null) {
        window.clearTimeout(initialRefreshId);
      }
      if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
      }
      if (refreshOnFocus) {
        window.removeEventListener("focus", refreshProviderStatuses);
        document.removeEventListener("visibilitychange", refreshProviderStatuses);
      }
    };
  }, [enabled, initialDelayMs, intervalMs, minIntervalMs, queryClient, refreshOnFocus]);
}
