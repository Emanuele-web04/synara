// FILE: dockPaneActivation.ts
// Purpose: Decide when a persisted right-dock pane should hydrate its expensive runtime.
// Layer: Web UI lifecycle helper
// Depends on: rightDockStore pane kind taxonomy

import type { ThreadId } from "@t3tools/contracts";

import type { RightDockPaneKind } from "~/rightDockStore.logic";

export type DockPaneActivationReason = "explicit" | "restore";
export type DockPaneRuntimeMode = "live" | "preview";

export const DOCK_PANE_DEFERRED_HYDRATION_FRAMES = 2;

const DEFERRED_RUNTIME_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set<RightDockPaneKind>([
  "browser",
  "sidechat",
  "terminal",
]);

export function dockPaneActivationKey(input: {
  threadId: ThreadId;
  paneId: string;
  kind: RightDockPaneKind;
}): string {
  return `${input.threadId}\u0000${input.paneId}\u0000${input.kind}`;
}

export function isDeferredRuntimePaneKind(kind: RightDockPaneKind): boolean {
  return DEFERRED_RUNTIME_PANE_KINDS.has(kind);
}

export function resolveDockPaneRuntimeMode(input: {
  kind: RightDockPaneKind;
  reason: DockPaneActivationReason;
  hydrated: boolean;
}): DockPaneRuntimeMode {
  if (!isDeferredRuntimePaneKind(input.kind)) {
    return "live";
  }
  if (input.reason === "explicit" || input.hydrated) {
    return "live";
  }
  return "preview";
}
