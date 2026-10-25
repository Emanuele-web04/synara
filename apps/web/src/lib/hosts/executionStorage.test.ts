import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentId, ProjectId, ThreadId, type RemoteExecutionScope } from "@synara/contracts";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
    clear: () => data.clear(),
  };
}
async function windowStorage(
  storage: Storage,
  environmentId: string,
  remote: RemoteExecutionScope | null = null,
) {
  vi.resetModules();
  const { initializeExecutionContext } = await import("./executionContext");
  const descriptor = {
    environmentId: EnvironmentId.makeUnsafe(environmentId),
    label: environmentId,
    platform: { os: "darwin" as const, arch: "arm64" as const },
    serverVersion: "1",
    capabilities: { repositoryIdentity: true },
  };
  initializeExecutionContext({ controller: descriptor, execution: descriptor, remote });
  return (await import("./executionStorage")).createExecutionStorage(storage);
}
afterEach(() => vi.resetModules());
describe("execution persistence", () => {
  it("isolates the new open-tab and hub stores between connected computers", async () => {
    const disk = memoryStorage();
    vi.stubGlobal("localStorage", disk);
    vi.stubGlobal("window", Object.assign(new EventTarget(), { localStorage: disk }));
    const readStores = async (environmentId: string) => {
      await windowStorage(disk, environmentId);
      const { useOpenThreadTabsStore } = await import("../../openThreadTabsStore");
      const { usePinnedProjectAgentsStore } = await import("../../pinnedProjectAgentsStore");
      const { useGroupPanelClosedStore } = await import("../../groupPanelClosedStore");
      return {
        tabs: useOpenThreadTabsStore.getState(),
        pins: usePinnedProjectAgentsStore.getState(),
        panels: useGroupPanelClosedStore.getState(),
      };
    };
    try {
      const local = await readStores("book");
      local.tabs.openThreadTab(ThreadId.makeUnsafe("same-thread"));
      local.pins.pinProjectAgent(ProjectId.makeUnsafe("same-project"));
      local.panels.setGroupPanelClosed(ProjectId.makeUnsafe("same-project"), true);
      const other = await readStores("mini");
      expect(other.tabs.threadIds).toEqual([]);
      expect(other.pins.pinnedProjectAgentIds).toEqual([]);
      expect(other.panels.closedProjectIds).toEqual([]);
      other.tabs.openThreadTab(ThreadId.makeUnsafe("remote-thread"));
      const restored = await readStores("book");
      expect(restored.tabs.threadIds).toEqual(["same-thread"]);
      expect(restored.pins.pinnedProjectAgentIds).toEqual(["same-project"]);
      expect(restored.panels.closedProjectIds).toEqual(["same-project"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("copies legacy only to its verified local owner and never resurrects a removed draft", async () => {
    const disk = memoryStorage();
    disk.setItem("draft", "legacy-local");
    const local = await windowStorage(disk, "local-a");
    expect(local.getItem("draft")).toBe("legacy-local");
    local.removeItem("draft");
    expect((await windowStorage(disk, "local-a")).getItem("draft")).toBeNull();
    expect(disk.getItem("draft")).toBe("legacy-local");
    expect((await windowStorage(disk, "different-local")).getItem("draft")).toBeNull();
  });
  it("separates identical thread keys by host and account, including scoped cleanup", async () => {
    const disk = memoryStorage();
    const local = await windowStorage(disk, "controller");
    local.setItem("thread-same", "local draft");
    const a: RemoteExecutionScope = {
      environmentId: "mini",
      accountAuthority: "https://account.test",
      userId: "a",
      organizationId: "org",
      channel: "beta",
    };
    const remoteA = await windowStorage(disk, "mini", a);
    expect(remoteA.getItem("thread-same")).toBeNull();
    remoteA.setItem("thread-same", "private A");
    const remoteB = await windowStorage(disk, "mini", { ...a, userId: "b" });
    expect(remoteB.getItem("thread-same")).toBeNull();
    remoteB.setItem("thread-same", "private B");
    remoteB.clear();
    expect((await windowStorage(disk, "mini", a)).getItem("thread-same")).toBe("private A");
    expect((await windowStorage(disk, "controller")).getItem("thread-same")).toBe("local draft");
  });
});

it("exports recovered remote drafts from the local view only for their verified account", async () => {
  const disk = memoryStorage();
  const remote: RemoteExecutionScope = {
    environmentId: "mini",
    accountAuthority: "https://account.test",
    userId: "a",
    organizationId: "org",
    channel: "beta",
  };
  (await windowStorage(disk, "mini", remote)).setItem(
    "editor-recovery:draft-a",
    JSON.stringify([{ relativePath: "same.ts", text: "private A" }]),
  );
  (await windowStorage(disk, "mini", { ...remote, userId: "b" })).setItem(
    "editor-recovery:draft-b",
    JSON.stringify([{ relativePath: "same.ts", text: "private B" }]),
  );
  await windowStorage(disk, "controller");
  vi.stubGlobal("localStorage", disk);
  try {
    const { adoptControlAccountScope } = await import("./controlQueryScope");
    const { readRecoverableEditorDrafts } = await import("./editorRecovery");
    const status = (id: string) =>
      ({
        state: "signed-in",
        accountAuthority: remote.accountAuthority,
        me: { id, organization: { id: "org" } },
      }) as Parameters<typeof adoptControlAccountScope>[0];
    adoptControlAccountScope(status("a"));
    expect(JSON.stringify(readRecoverableEditorDrafts())).toContain("private A");
    expect(JSON.stringify(readRecoverableEditorDrafts())).not.toContain("private B");
    adoptControlAccountScope(status("b"));
    expect(JSON.stringify(readRecoverableEditorDrafts())).not.toContain("private A");
    expect(JSON.stringify(readRecoverableEditorDrafts())).toContain("private B");
    adoptControlAccountScope({ state: "signed-out" } as Parameters<
      typeof adoptControlAccountScope
    >[0]);
    expect(readRecoverableEditorDrafts()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
