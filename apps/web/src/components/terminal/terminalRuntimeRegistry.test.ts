import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  create: vi.fn((config) => ({
    ...config,
    container: null as HTMLDivElement | null,
    lastDetachedAt: null as number | null,
    terminal: { focus: vi.fn() },
    searchAddon: {},
    runtimeStatus: "ready",
  })),
  dispose: vi.fn(),
  attach: vi.fn((entry, _viewState, container) => {
    entry.container = container;
    entry.lastDetachedAt = null;
  }),
  detach: vi.fn((entry) => {
    entry.container = null;
    entry.lastDetachedAt = Date.now();
  }),
}));

vi.mock("./terminalRuntime", () => ({
  createRuntimeEntry: runtime.create,
  disposeRuntimeEntry: runtime.dispose,
  attachRuntimeToContainer: runtime.attach,
  detachRuntimeFromContainer: runtime.detach,
  syncRuntimeConfig: vi.fn(),
  updateRuntimeViewState: vi.fn(),
}));

import { removeOrphanedTerminalRuntimes } from "../../lib/terminalStateCleanup";
import {
  buildTerminalRuntimeKey,
  MAX_PARKED_TERMINAL_RUNTIMES,
  terminalRuntimeRegistry,
} from "./terminalRuntimeRegistry";

function attach(threadId: string, providerAuthInstanceId?: string) {
  const runtimeKey = buildTerminalRuntimeKey(threadId, "terminal-1");
  terminalRuntimeRegistry.attach(
    {
      runtimeKey,
      threadId,
      terminalId: "terminal-1",
      terminalLabel: "Terminal",
      cwd: "/tmp",
      ...(providerAuthInstanceId ? { providerAuthInstanceId } : {}),
      callbacks: {
        onSessionExited: vi.fn(),
        onTerminalMetadataChange: vi.fn(),
        onTerminalActivityChange: vi.fn(),
      },
    },
    { autoFocus: false, isVisible: false },
    {} as HTMLDivElement,
  );
  terminalRuntimeRegistry.detach(runtimeKey);
}

afterEach(() => {
  vi.useRealTimers();
  terminalRuntimeRegistry.setMaxParkedRuntimesForTests(MAX_PARKED_TERMINAL_RUNTIMES);
  terminalRuntimeRegistry.disposeOrphanedThreads(new Set());
  vi.clearAllMocks();
});

describe("terminal runtime memory ownership", () => {
  it("returns detached runtimes to baseline across repeated host and dock deletion", () => {
    // Allow 4 parked runtimes in this test so LRU eviction doesn't preempt orphan cleanup.
    terminalRuntimeRegistry.setMaxParkedRuntimesForTests(4);
    const active = new Set(["keep", "dock-terminal:keep"]);
    for (const id of active) attach(id);
    for (let index = 0; index < 20; index += 1) {
      attach(`removed-${index}`);
      attach(`dock-terminal:removed-${index}`);
      removeOrphanedTerminalRuntimes(active);
      expect(runtime.create.mock.calls.length - runtime.dispose.mock.calls.length).toBe(2);
    }
    // Hidden, still-owned terminals reuse their original xterm instances.
    const created = runtime.create.mock.calls.length;
    for (const id of active) attach(id);
    expect(runtime.create).toHaveBeenCalledTimes(created);
    removeOrphanedTerminalRuntimes(new Set());
    expect(runtime.dispose).toHaveBeenCalledTimes(created);
  });

  it("keeps settings-owned authentication terminals alive when unrelated chats are removed", () => {
    attach("provider-auth:work", "codex_work");
    attach("removed-chat");
    removeOrphanedTerminalRuntimes(new Set());
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual(["removed-chat"]);
    terminalRuntimeRegistry.disposeTerminal("provider-auth:work", "terminal-1");
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual([
      "removed-chat",
      "provider-auth:work",
    ]);
  });

  it("disposes only the exact scope when ids contain the runtime key separator", () => {
    attach("host");
    attach("host::nested");
    terminalRuntimeRegistry.disposeThread("host");
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.dispose.mock.calls[0]?.[0].threadId).toBe("host");
  });

  it("caps parked detached runtimes via LRU and re-attaches evicted threads cleanly", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    terminalRuntimeRegistry.setMaxParkedRuntimesForTests(2);

    attach("thread-1");
    vi.advanceTimersByTime(10);
    attach("thread-2");
    vi.advanceTimersByTime(10);
    attach("thread-3");
    vi.advanceTimersByTime(10);
    attach("thread-4");

    // Only the 2 most recently detached runtimes stay parked; oldest 2 were disposed.
    expect(terminalRuntimeRegistry.getParkedRuntimeCount()).toBe(2);
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual([
      "thread-1",
      "thread-2",
    ]);

    // Switching back to an evicted thread recreates a fresh runtime (server PTY stays alive)
    // and keeps parked count bounded when detached again.
    vi.advanceTimersByTime(10);
    attach("thread-1");
    expect(terminalRuntimeRegistry.getParkedRuntimeCount()).toBe(2);
    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual([
      "thread-1",
      "thread-2",
      "thread-3",
    ]);
  });

  it("does not evict settings-owned provider auth terminals under parked LRU cap", () => {
    vi.useFakeTimers();
    terminalRuntimeRegistry.setMaxParkedRuntimesForTests(1);

    attach("provider-auth:work", "codex_work");
    vi.advanceTimersByTime(10);
    attach("thread-a");
    vi.advanceTimersByTime(10);
    attach("thread-b");

    expect(runtime.dispose.mock.calls.map(([entry]) => entry.threadId)).toEqual(["thread-a"]);
    terminalRuntimeRegistry.disposeTerminal("provider-auth:work", "terminal-1");
  });
});
