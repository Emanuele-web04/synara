import type { TerminalEvent } from "@t3tools/contracts";

import { readNativeApi } from "~/nativeApi";

type TerminalEventListener = (event: TerminalEvent) => void;

function terminalEventKey(threadId: string, terminalId: string): string {
  return `${threadId}::${terminalId}`;
}

class TerminalEventDispatcher {
  private listenersByKey = new Map<string, Set<TerminalEventListener>>();
  private unsubscribeSharedListener: (() => void) | null = null;

  subscribe(threadId: string, terminalId: string, listener: TerminalEventListener): () => void {
    const key = terminalEventKey(threadId, terminalId);
    const listeners = this.listenersByKey.get(key) ?? new Set<TerminalEventListener>();
    listeners.add(listener);
    this.listenersByKey.set(key, listeners);
    this.ensureSharedListener();

    return () => {
      const nextListeners = this.listenersByKey.get(key);
      if (!nextListeners) return;
      nextListeners.delete(listener);
      if (nextListeners.size === 0) {
        this.listenersByKey.delete(key);
      }
      if (this.listenersByKey.size === 0) {
        this.unsubscribeSharedListener?.();
        this.unsubscribeSharedListener = null;
      }
    };
  }

  private ensureSharedListener(): void {
    if (this.unsubscribeSharedListener) return;
    const api = readNativeApi();
    if (!api) return;

    this.unsubscribeSharedListener = api.terminal.onEvent((event) => {
      const listeners = this.listenersByKey.get(terminalEventKey(event.threadId, event.terminalId));
      if (!listeners) return;
      for (const listener of listeners) {
        listener(event);
      }
    });
  }
}

export const terminalEventDispatcher = new TerminalEventDispatcher();
