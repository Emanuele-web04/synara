// FILE: terminalRuntimeRegistry.ts
// Purpose: Keep a stable runtime map and delegate terminal lifecycle work to terminalRuntime.ts.
// Layer: Terminal runtime infrastructure
// Depends on: terminalRuntime.ts for lifecycle, terminalRuntimeTypes.ts for stable ids and contracts.

import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";

import {
  attachRuntimeToContainer,
  createRuntimeEntry,
  detachRuntimeFromContainer,
  disposeRuntimeEntry,
  syncRuntimeConfig,
  updateRuntimeViewState,
} from "./terminalRuntime";
import type {
  TerminalRuntimeConfig,
  TerminalRuntimeEntry,
  TerminalRuntimeViewState,
} from "./terminalRuntimeTypes";
import { buildTerminalRuntimeKey } from "./terminalRuntimeTypes";

export { buildTerminalRuntimeKey, type TerminalRuntimeCallbacks } from "./terminalRuntimeTypes";

// --- Registry orchestration -------------------------------------------------

class TerminalRuntimeRegistry {
  private entries = new Map<string, TerminalRuntimeEntry>();

  attach(
    config: TerminalRuntimeConfig,
    viewState: TerminalRuntimeViewState,
    container: HTMLDivElement,
  ): { terminal: Terminal; searchAddon: SearchAddon } {
    let entry = this.entries.get(config.runtimeKey);
    if (!entry) {
      entry = createRuntimeEntry(config);
      this.entries.set(config.runtimeKey, entry);
    } else {
      syncRuntimeConfig(entry, config);
    }

    attachRuntimeToContainer(entry, viewState, container);
    return {
      terminal: entry.terminal,
      searchAddon: entry.searchAddon,
    };
  }

  syncConfig(runtimeKey: string, config: TerminalRuntimeConfig): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    syncRuntimeConfig(entry, config);
  }

  setViewState(runtimeKey: string, viewState: TerminalRuntimeViewState): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    updateRuntimeViewState(entry, viewState);
  }

  detach(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    detachRuntimeFromContainer(entry);
  }

  dispose(runtimeKey: string): void {
    const entry = this.entries.get(runtimeKey);
    if (!entry) return;
    disposeRuntimeEntry(entry);
    this.entries.delete(runtimeKey);
  }

  disposeTerminal(threadId: string, terminalId: string): void {
    this.dispose(buildTerminalRuntimeKey(threadId, terminalId));
  }

  disposeThread(threadId: string): void {
    for (const runtimeKey of [...this.entries.keys()]) {
      if (runtimeKey.startsWith(`${threadId}::`)) {
        this.dispose(runtimeKey);
      }
    }
  }

  focus(runtimeKey: string): void {
    this.entries.get(runtimeKey)?.terminal.focus();
  }
}

export const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
