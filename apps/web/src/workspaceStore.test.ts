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

  it("keeps chat workspace root while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspaceStore } = await import("./workspaceStore");

    useWorkspaceStore.getState().setChatWorkspaceRoot("/Users/tester/Documents/Synara");
    useWorkspaceStore.getState().setChatWorkspaceRoot(undefined);

    expect(useWorkspaceStore.getState().chatWorkspaceRoot).toBe("/Users/tester/Documents/Synara");
  });

  it("keeps studio workspace root while server config is still loading", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspaceStore } = await import("./workspaceStore");

    useWorkspaceStore.getState().setStudioWorkspaceRoot("/Users/tester/Documents/Synara/Studio");
    useWorkspaceStore.getState().setStudioWorkspaceRoot(undefined);

    expect(useWorkspaceStore.getState().studioWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara/Studio",
    );
  });

  it("updates home, chat, and studio workspace roots together from server paths", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    const { useWorkspaceStore } = await import("./workspaceStore");

    useWorkspaceStore.getState().setServerWorkspacePaths({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    expect(useWorkspaceStore.getState().homeDir).toBe("/Users/tester");
    expect(useWorkspaceStore.getState().chatWorkspaceRoot).toBe("/Users/tester/Documents/Synara");
    expect(useWorkspaceStore.getState().studioWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara/Studio",
    );
  });

  it("persists the chat workspace root with the home directory but not the studio root", async () => {
    installMemoryLocalStorage();
    vi.resetModules();

    let workspaceModule = await import("./workspaceStore");
    workspaceModule.useWorkspaceStore.getState().setServerWorkspacePaths({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    vi.resetModules();
    workspaceModule = await import("./workspaceStore");

    expect(workspaceModule.useWorkspaceStore.getState().homeDir).toBe("/Users/tester");
    expect(workspaceModule.useWorkspaceStore.getState().chatWorkspaceRoot).toBe(
      "/Users/tester/Documents/Synara",
    );
    expect(workspaceModule.useWorkspaceStore.getState().studioWorkspaceRoot).toBeNull();
  });
});
