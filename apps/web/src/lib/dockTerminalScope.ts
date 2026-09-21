import type { ThreadId } from "@synara/contracts";
import { dockTerminalScopeId } from "@synara/shared/terminalThreads";

// dock terminals run as an independent session set reusing the per-thread store/runtime keyed by this synthetic scope so xterms never collide with the host thread's drawer terminals
export { DOCK_TERMINAL_SCOPE_PREFIX } from "@synara/shared/terminalThreads";

export function dockTerminalThreadId(hostThreadId: ThreadId): ThreadId {
  return dockTerminalScopeId(hostThreadId) as ThreadId;
}
