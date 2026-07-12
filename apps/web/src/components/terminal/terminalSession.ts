// FILE: terminalSession.ts
// Purpose: Shared terminal-session primitives reused by every terminal surface
//          (chat drawer, workspace page, right-dock pane): a stable id factory and
//          the dispose + server-close + fallback routine that was duplicated verbatim.
// Layer: Web terminal runtime helpers
// Depends on: terminalRuntimeRegistry (xterm instances), NativeApi terminal channel.

import { type NativeApi } from "@synara/contracts";

import { randomUUID } from "~/lib/utils";
import { terminalRuntimeRegistry } from "./terminalRuntimeRegistry";

// Stable, collision-resistant id for a new terminal pane/tab/split.
export function randomTerminalId(): string {
  return `terminal-${randomUUID()}`;
}

// Tear down a terminal everywhere it lives: drop the local xterm instance, then
// ask the server to close it (deleting history) with a best-effort `exit` write
// fallback for transports that lack a structured close. `clearHistoryBeforeClose`
// mirrors the chat surface's behavior when closing the final terminal of a thread.
export function disposeAndCloseTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  clearHistoryBeforeClose?: boolean;
}): void {
  const { api, threadId, terminalId } = input;
  terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);

  const fallbackExitWrite = () =>
    api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);

  if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
    void (async () => {
      if (input.clearHistoryBeforeClose) {
        await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
      }
      await api.terminal.close({ threadId, terminalId, deleteHistory: true });
    })().catch(() => fallbackExitWrite());
  } else {
    void fallbackExitWrite();
  }
}
