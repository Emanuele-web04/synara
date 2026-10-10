// FILE: terminalIds.ts
// Purpose: Stable id factory for terminal panes/tabs/splits.
// Layer: Web terminal runtime helpers
// Depends on: nothing but the shared uuid helper.
//
// Deliberately a leaf module with no xterm dependency. `randomTerminalId` is
// needed by eagerly-loaded surfaces (ChatView, the terminal controllers) that
// must not drag the xterm runtime (~223 KB gzip) into the initial bundle, so it
// cannot live alongside the registry-touching helpers in `terminalSession.ts`.

import { randomUUID } from "~/lib/utils";

// Stable, collision-resistant id for a new terminal pane/tab/split.
export function randomTerminalId(): string {
  return `terminal-${randomUUID()}`;
}
