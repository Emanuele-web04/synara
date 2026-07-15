// FILE: dockTerminalScope.ts
// Purpose: Derive a stable, isolated terminal scope id for right-dock terminals.
// Layer: Terminal scope helpers
// Exports: dock terminal scope prefix + id factory shared by the dock pane and cleanup.

import type { ThreadId } from "@synara/contracts";

// Right-dock terminals run as an independent session set from the bottom drawer.
// They reuse the per-thread terminal store/runtime keyed by this synthetic scope so
// xterm instances never collide with the host thread's drawer terminals.
export const DOCK_TERMINAL_SCOPE_PREFIX = "dock-terminal:";

export function dockTerminalThreadId(hostThreadId: ThreadId): ThreadId {
  return `${DOCK_TERMINAL_SCOPE_PREFIX}${hostThreadId}` as ThreadId;
}
