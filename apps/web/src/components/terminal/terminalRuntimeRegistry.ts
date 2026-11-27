// FILE: terminalRuntimeRegistry.ts
// Purpose: Keep a stable runtime map and delegate terminal lifecycle work to terminalRuntime.ts.
// Layer: Terminal runtime infrastructure
// Depends on: terminalRuntime.ts for lifecycle, terminalRuntimeTypes.ts for stable ids and contracts.

import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { registerTerminalRuntimeCleanup } from "../../lib/terminalStateCleanup";

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
  TerminalRuntimeStatus,
  TerminalRuntimeViewState,
} from "./terminalRuntimeTypes";
import { buildTerminalRuntimeKey } from "./terminalRuntimeTypes";

export { buildTerminalRuntimeKey, type TerminalRuntimeCallbacks } from "./terminalRuntimeTypes";

// --- Registry orchestration -------------------------------------------------

export const MAX_PARKED_TERMINAL_RUNTIMES = 2;

class TerminalRuntimeRegistry {
  private entries = new Map<string, TerminalRuntimeEntry>();
  private maxParkedRuntimes = MAX_PARKED_TERMINAL_RUNTIMES;

  attach(
    config: TerminalRuntimeConfig,
    viewState: TerminalRuntimeViewState,
    container: HTMLDivElement,
  ): { terminal: Terminal; searchAddon: SearchAddon; runtimeStatus: TerminalRuntimeStatus } {
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
      runtimeStatus: entry.runtimeStatus,
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
    this.evictExcessParkedRuntimes();
  }

  evictExcessParkedRuntimes(maxRetained = this.maxParkedRuntimes): number {
    const limit = Math.max(0, maxRetained);
    const parked: Array<[string, TerminalRuntimeEntry]> = [];
    for (const pair of this.entries) {
      const entry = pair[1];
      if (entry.container === null && !entry.providerAuthInstanceId) {
        parked.push(pair);
      }
    }
    if (parked.length <= limit) return 0;
    parked.sort((a, b) => (a[1].lastDetachedAt ?? 0) - (b[1].lastDetachedAt ?? 0));
    const toEvict = parked.length - limit;
    for (let i = 0; i < toEvict; i += 1) {
      this.dispose(parked[i]![0]);
    }
    return toEvict;
  }

  setMaxParkedRuntimesForTests(limit: number): void {
    this.maxParkedRuntimes = Math.max(0, limit);
  }

  getRuntimeCount(): number {
    return this.entries.size;
  }

  getParkedRuntimeCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.container === null) count += 1;
    }
    return count;
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
    for (const [runtimeKey, entry] of this.entries) {
      if (entry.threadId === threadId) {
        this.dispose(runtimeKey);
      }
    }
  }

  disposeOrphanedThreads(activeThreadIds: ReadonlySet<string>): void {
    for (const [runtimeKey, entry] of this.entries) {
      if (!entry.providerAuthInstanceId && !activeThreadIds.has(entry.threadId)) {
        this.dispose(runtimeKey);
      }
    }
  }

  focus(runtimeKey: string): void {
    this.entries.get(runtimeKey)?.terminal.focus();
  }
}

export const terminalRuntimeRegistry = new TerminalRuntimeRegistry();
registerTerminalRuntimeCleanup((activeThreadIds) =>
  terminalRuntimeRegistry.disposeOrphanedThreads(activeThreadIds),
);
