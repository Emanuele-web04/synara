import type { ThreadId } from "@synara/contracts";

import type { RightDockPaneKind } from "~/rightDockStore.logic";

export type DockPaneActivationReason = "explicit" | "restore";
export type DockPaneRuntimeMode = "live" | "preview";

export const DOCK_PANE_DEFERRED_HYDRATION_FRAMES = 2;
// rAF is suspended by Chromium for hidden/offscreen documents — a route transition can commit a restored dock while its subtree is still offscreen, so frame-only promotion could leave a heavy pane in preview forever; cap it with a task-based fallback
export const DOCK_PANE_DEFERRED_HYDRATION_TIMEOUT_MS = 250;

export interface DeferredDockPaneHydrationScheduler {
  readonly requestFrame: (callback: () => void) => number;
  readonly cancelFrame: (frameId: number) => void;
  readonly setTimer: (callback: () => void, delayMs: number) => number;
  readonly clearTimer: (timerId: number) => void;
}

export function scheduleDeferredDockPaneHydration(input: {
  readonly onHydrate: () => void;
  readonly scheduler: DeferredDockPaneHydrationScheduler;
  readonly frames?: number;
  readonly timeoutMs?: number;
}): () => void {
  const frames = Math.max(0, input.frames ?? DOCK_PANE_DEFERRED_HYDRATION_FRAMES);
  const timeoutMs = Math.max(0, input.timeoutMs ?? DOCK_PANE_DEFERRED_HYDRATION_TIMEOUT_MS);
  let completed = false;
  let frameId: number | null = null;
  let timerId: number | null = null;
  let framesRemaining = frames;

  function clearScheduledWork(): void {
    if (frameId !== null) {
      input.scheduler.cancelFrame(frameId);
      frameId = null;
    }
    if (timerId !== null) {
      input.scheduler.clearTimer(timerId);
      timerId = null;
    }
  }

  const finish = () => {
    if (completed) return;
    completed = true;
    clearScheduledWork();
    input.onHydrate();
  };

  const tick = () => {
    frameId = null;
    if (completed) return;
    framesRemaining -= 1;
    if (framesRemaining <= 0) {
      finish();
      return;
    }
    frameId = input.scheduler.requestFrame(tick);
  };

  timerId = input.scheduler.setTimer(finish, timeoutMs);
  if (framesRemaining <= 0) {
    finish();
  } else {
    frameId = input.scheduler.requestFrame(tick);
  }

  return () => {
    if (completed) return;
    completed = true;
    clearScheduledWork();
  };
}

// the device pane holds a WebCodecs decoder + frame socket — a restored tab must stay in preview until the user actually looks at it
const DEFERRED_RUNTIME_PANE_KINDS: ReadonlySet<RightDockPaneKind> = new Set<RightDockPaneKind>([
  "browser",
  "device",
  "sidechat",
  "terminal",
]);

// unmounting a terminal detaches xterm DOM and re-running attach triggers a double FitAddon pass (slow open + reflow flicker); staying mounted keeps tab switches instant and preserves scrollback
// the explorer keeps browse state in component state — unmounting on tab switch would reset it to workspace root on return
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

// next keep-mounted set: previously kept panes that still exist, plus the active pane when it is a keep-mounted kind; pure so the policy is unit-testable and persistable via ref
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
