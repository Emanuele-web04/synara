import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStatus, ExecutionEnvironmentDescriptor } from "@synara/contracts";

const descriptor = {
  environmentId: "local",
  channel: "dev",
  capabilities: { remoteConnections: true },
} as ExecutionEnvironmentDescriptor;
const host = (environmentId: string) => ({
  hostId: `host-${environmentId}`,
  hostName: "Same name",
  wsPath: `/ws/remote/${environmentId}`,
  executionScope: {
    environmentId,
    accountAuthority: "https://account.example",
    userId: "alice",
    organizationId: "org",
    channel: "dev" as const,
  },
});

beforeEach(() => {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});
afterEach(() => vi.unstubAllGlobals());

async function registry() {
  const context = await import("./executionContext");
  context.initializeExecutionContext({
    controller: descriptor,
    execution: descriptor,
    remote: null,
  });
  return import("./workspaceSessions");
}

describe("workspace ownership", () => {
  it.each(["offline", "removed", "frame replaced", "host replaced"])(
    "rejects captured sidebar actions after the owner is %s",
    async (change) => {
      const api = await registry();
      api.addWorkspaceSession(host("one"));
      const navigation = {
        browseFolders: vi.fn(),
        createProject: vi.fn(),
        newChat: vi.fn(),
        openProject: vi.fn(),
        navigate: vi.fn(),
        recover: vi.fn(),
      };
      const summary = { state: "open" as const, path: "/", projects: [], threads: [] };
      api.updateWorkspaceSession("one", { navigation, summary });
      const captured = api.readWorkspaceSessions()[0]!;
      expect(api.readAvailableWorkspaceNavigation(captured)).toBe(navigation);
      if (change === "offline")
        api.updateWorkspaceSession("one", { summary: { ...summary, state: "closed" } });
      if (change === "removed" || change === "host replaced")
        api.removeWorkspaceSession("host-one");
      if (change === "host replaced") {
        api.addWorkspaceSession(host("one"));
        api.updateWorkspaceSession("one", { navigation, summary });
      }
      if (change === "frame replaced")
        api.updateWorkspaceSession("one", { navigation: { ...navigation } });
      expect(api.readAvailableWorkspaceNavigation(captured)).toBeUndefined();
      if (change !== "removed" && change !== "offline")
        expect(api.readAvailableWorkspaceNavigation(api.readWorkspaceSessions()[0]!)).toBeDefined();
    },
  );

  it("keeps navigation bound to its owner and ignores late updates from a removed host", async () => {
    const api = await registry();
    api.addWorkspaceSession(host("one"));
    api.addWorkspaceSession(host("two"));
    const first = {
      browseFolders: vi.fn(),
      createProject: vi.fn(),
      newChat: vi.fn(),
      openProject: vi.fn(),
      navigate: vi.fn(),
      recover: vi.fn(),
    };
    const second = {
      browseFolders: vi.fn(),
      createProject: vi.fn(),
      newChat: vi.fn(),
      openProject: vi.fn(),
      navigate: vi.fn(),
      recover: vi.fn(),
    };
    api.updateWorkspaceSession("one", { navigation: first });
    api.updateWorkspaceSession("two", { navigation: second });
    const captured = await api.waitForWorkspaceNavigation("one");
    api.updateWorkspaceSession("two", { error: "offline" });
    await captured.newChat("same-id");
    expect(first.newChat).toHaveBeenCalledWith("same-id");
    expect(second.newChat).not.toHaveBeenCalled();
    api.removeWorkspaceSession("host-two");
    api.updateWorkspaceSession("two", { navigation: second });
    expect(api.readWorkspaceSessions()).toHaveLength(1);
    expect(api.readWorkspaceSessions()[0]?.navigation).toBe(first);
  });

  it("does not replace an environment with a different account or restore credentials", async () => {
    const api = await registry();
    api.addWorkspaceSession({ ...host("one"), extraSecret: "must-not-persist" } as ReturnType<
      typeof host
    >);
    expect(() =>
      api.addWorkspaceSession({
        ...host("one"),
        executionScope: { ...host("one").executionScope, userId: "bob" },
      }),
    ).toThrow(/identity changed/);
    expect(JSON.stringify(api.readWorkspaceSessions())).not.toContain("must-not-persist");
    expect(
      api.parseWorkspaceHost({ ...host("bad"), wsPath: "https://other.example/ws" }),
    ).toBeNull();
    expect(api.parseWorkspaceHost({ ...host("bad"), executionScope: undefined })).toBeNull();
  });

  it("removes all remote data on sign-out even when one draft recovery fails", async () => {
    const api = await registry();
    api.addWorkspaceSession(host("one"));
    api.addWorkspaceSession(host("two"));
    api.updateWorkspaceSession("one", {
      navigation: {
        browseFolders: vi.fn(),
        createProject: vi.fn(),
        newChat: vi.fn(),
        openProject: vi.fn(),
        navigate: vi.fn(),
        recover: () => {
          throw new Error("storage unavailable");
        },
      },
    });
    api.reconcileWorkspaceAccount({ state: "signed-out" } as AccountStatus);
    expect(api.readWorkspaceSessions()).toEqual([]);
  });
});
