// FILE: terminalSession.ts
// Purpose: Shared terminal teardown with failure-safe structured closes and
//          immediate local cleanup for exited or best-effort sessions.
// Layer: Web terminal runtime helpers
// Depends on: terminalRuntimeRegistry (xterm instances, loaded on demand),
//             NativeApi terminal channel.
// Note: the id factory lives in `terminalIds.ts` so eager consumers can import
//       it without anchoring xterm into the initial bundle.

import { type NativeApi } from "@synara/contracts";

// The terminal runtime pulls in xterm and its addons (~223 KB gzip). Importing
// the registry statically anchored the whole terminal stack into the eager
// router graph via this module's callers, so every page load paid for it.
// Closing a terminal is a rare user action and the chunk is already resident
// whenever a terminal is actually on screen, so this resolves from the module
// cache in practice.
async function disposeTerminalRuntime(threadId: string, terminalId: string): Promise<void> {
  try {
    const { terminalRuntimeRegistry } = await import("./terminalRuntimeRegistry");
    terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
  } catch (error) {
    console.error("Failed to dispose terminal runtime", { threadId, terminalId, error });
  }
}

// Guarded closes must never fall back to `exit`: rejection preserves the session.
export async function disposeAndCloseTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  clearHistoryBeforeClose?: boolean;
  deleteHistory?: boolean;
  processAlreadyExited?: boolean;
  requireStructuredClose?: boolean;
  onlyIfIdle?: boolean;
}): Promise<void> {
  const { api, threadId, terminalId } = input;
  const preserveUntilClosed = input.requireStructuredClose || input.onlyIfIdle;
  // Fire-and-forget callers can reopen this id while the server is closing it.
  // Dispose their old runtime now, so a late reply cannot dispose its replacement.
  if (!preserveUntilClosed) await disposeTerminalRuntime(threadId, terminalId);
  try {
    if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
      if (input.clearHistoryBeforeClose && !input.onlyIfIdle) {
        await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
      }
      await api.terminal.close({
        threadId,
        terminalId,
        deleteHistory: input.deleteHistory ?? true,
        ...(input.onlyIfIdle ? { onlyIfIdle: true } : {}),
      });
    } else {
      throw new Error("Unable to close the terminal: server connection is unavailable.");
    }
  } catch (error) {
    if (preserveUntilClosed) throw error;
    if (!input.processAlreadyExited) {
      await api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
    }
  }
  if (preserveUntilClosed) await disposeTerminalRuntime(threadId, terminalId);
}
