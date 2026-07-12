// FILE: dockPaneActivation.ts
// Purpose: Decide when a persisted right-dock pane should hydrate its expensive runtime.
// Layer: Web UI lifecycle helper
// Depends on: rightDockStore pane kind taxonomy

import type { ThreadId } from "@synara/contracts";

import type { RightDockPaneKind } from "~/rightDockStore.logic";

export type DockPaneActivationReason = "explicit" | "restore";
export type DockPaneRuntimeMode = "live" | "preview";

export const DOCK_PANE_DEFERRED_HYDRATION_FRAMES = 2;

const DEFERRED_RUNTIME_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set<RightDockPaneKind>([
  "browser",
  "sidechat",
  "terminal",
]);

// Pane kinds whose React subtree must stay mounted while inactive instead of
// being torn down when another tab is selected. Unmounting a terminal detaches
// its xterm DOM (terminalRuntime.detach -> wrapper.remove) and re-running attach
// triggers a double FitAddon pass, which the user sees as a slow open plus a
// multi-line reflow flicker. Keeping it mounted and toggling visibility makes
// tab switches instant and flicker-free while preserving scrollback/runtime.
// The explorer pane keeps its browse state (selected file, expanded directories,
// search query, sidebar visibility) in local component state, so keep it mounted
// while another tab is active — otherwise switching tabs would tear the subtree
// down and reset the explorer to its workspace root on return.
const KEEP_MOUNTED_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set<RightDockPaneKind>([
  "terminal",
  "explorer",
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

export function isKeepMountedPaneKind(kind: RightDockPaneKind): boolean {
  return KEEP_MOUNTED_PANE_KINDS.has(kind);
}

export const EMPTY_PANE_ID_SET: ReadonlySet<string> = new Set<string>();

// Compute the next set of pane ids that must stay mounted in the dock: every
// previously kept-mounted pane that still exists, plus the active pane when it is
// a keep-mounted kind. Pure (no React) so the keep-mount policy is unit-testable
// and the caller can persist the result across renders via a ref.
export function reconcileKeepMountedPaneIds(input: {
  previous: ReadonlySet<string>;
  panes: readonly { id: string; kind: RightDockPaneKind }[];
  activePaneId: string | null;
  activePaneKind: RightDockPaneKind | null;
}): ReadonlySet<string> {
  const livePaneIds = new Set(input.panes.map((pane) => pane.id));
  const next = new Set<string>();
  for (const paneId of input.previous) {
    if (livePaneIds.has(paneId)) {
      next.add(paneId);
    }
  }
  if (
    input.activePaneId !== null &&
    input.activePaneKind !== null &&
    isKeepMountedPaneKind(input.activePaneKind) &&
    livePaneIds.has(input.activePaneId)
  ) {
    next.add(input.activePaneId);
  }
  return next;
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
