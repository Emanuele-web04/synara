// FILE: useProviderAuthRefreshOnFocus.ts
// Purpose: Re-probe provider auth status when the window regains focus/visibility,
//   so account changes made outside the app (e.g. `claude login` / logout / adding
//   an account in a terminal) reflect without restarting the app.
// Layer: Web UI hooks
// Exports: useProviderAuthRefreshOnFocus

import { useProviderStatusRefresh } from "./useProviderStatusRefresh";

// Minimum gap between window-focus-triggered provider auth re-probes, so rapid
// focus/visibility changes can't spawn redundant CLI probes on the server.
const PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS = 15_000;

export function useProviderAuthRefreshOnFocus(): void {
  useProviderStatusRefresh({
    minIntervalMs: PROVIDER_AUTH_REFRESH_MIN_INTERVAL_MS,
    refreshOnFocus: true,
  });
}
