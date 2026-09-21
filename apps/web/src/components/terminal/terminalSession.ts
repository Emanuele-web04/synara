// the id factory lives in terminalIds.ts so eager consumers can import it without anchoring xterm into the initial bundle

import { type NativeApi } from "@synara/contracts";

// the terminal runtime pulls in xterm + addons (~223 KB gzip); a static import anchored the whole stack into the eager router graph — dynamic import resolves from the module cache in practice
async function disposeTerminalRuntime(threadId: string, terminalId: string): Promise<void> {
  try {
    const { terminalRuntimeRegistry } = await import("./terminalRuntimeRegistry");
    terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
  } catch (error) {
    // a failed chunk fetch must not strand the server-side terminal — fall through to the close call, the half that frees the PTY
    console.error("Failed to dispose terminal runtime", { threadId, terminalId, error });
  }
}

// tear down everywhere: drop the local xterm, then server-close with a best-effort `exit` fallback for transports lacking a structured close
export function disposeAndCloseTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  clearHistoryBeforeClose?: boolean;
  processAlreadyExited?: boolean;
}): void {
  const { api, threadId, terminalId } = input;

  const fallbackExitWrite = () => {
    if (input.processAlreadyExited) {
      return Promise.resolve();
    }
    return api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
  };

  // local disposal stays ordered before the server close, as when the registry was statically imported
  void (async () => {
    await disposeTerminalRuntime(threadId, terminalId);

    if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
      try {
        if (input.clearHistoryBeforeClose) {
          await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
        }
        await api.terminal.close({ threadId, terminalId, deleteHistory: true });
      } catch {
        await fallbackExitWrite();
      }
      return;
    }

    await fallbackExitWrite();
  })();
}
