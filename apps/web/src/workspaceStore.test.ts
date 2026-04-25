// FILE: workspaceStore.test.ts
// Purpose: Verifies persisted workspace page state and home-directory hydration behavior.
// Layer: Web state tests

import { afterEach, describe, expect, it, vi } from "vitest";

function installMemoryLocalStorage() {
  const entries = new Map<string, string>();

  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      entries.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      entries.delete(key);
    }),
    clear: vi.fn(() => {
      entries.clear();
    }),
    key: vi.fn((index: number) => Array.from(entries.keys())[index] ?? null),
    get length() {
      return entries.size;
    },
  });
}

describe("workspaceStore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the current home directory while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspaceStore } = await import("./workspaceStore");

    useWorkspaceStore.getState().setHomeDir("/Users/tester");
    useWorkspaceStore.getState().setHomeDir(undefined);

    expect(useWorkspaceStore.getState().homeDir).toBe("/Users/tester");
  });

  it("still allows explicitly clearing the home directory", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspaceStore } = await import("./workspaceStore");

    useWorkspaceStore.getState().setHomeDir("/Users/tester");
    useWorkspaceStore.getState().setHomeDir(null);

    expect(useWorkspaceStore.getState().homeDir).toBeNull();
  });
});
