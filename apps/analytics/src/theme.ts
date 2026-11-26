// FILE: src/theme.ts
// Purpose: Follows the OS color scheme and mirrors it into `data-theme` on
// the root element before render so charts and tokens read the right values.
// There is no manual theme switch.

import { useSyncExternalStore } from "react";

export type ResolvedMode = "light" | "dark";

const media =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function applySystemTheme(): void {
  document.documentElement.dataset.theme = media?.matches ? "dark" : "light";
  // Attach the OS listener at init so every page follows theme changes, not
  // just pages whose charts subscribe.
  if (!watching && media) {
    watching = true;
    media.addEventListener("change", () => {
      document.documentElement.dataset.theme = media.matches ? "dark" : "light";
      for (const fn of listeners) fn();
    });
  }
}

export function getMode(): ResolvedMode {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const listeners = new Set<() => void>();
let watching = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Resolved mode, re-rendering when the OS theme changes. */
export function useResolvedMode(): ResolvedMode {
  return useSyncExternalStore(subscribe, getMode);
}
