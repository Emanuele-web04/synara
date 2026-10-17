import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountStatus,
  ExecutionEnvironmentDescriptor,
  ListHostConnectionsResponse,
} from "@synara/contracts";

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
const signedIn = {
  state: "signed-in",
  accountAuthority: "https://account.example",
  me: { id: "alice", organization: { id: "org" } },
} as AccountStatus;
const connections = (...environments: string[]): ListHostConnectionsResponse => ({
  pairedHosts: environments.map((environmentId) => ({
    hostId: `host-${environmentId}`,
    environmentId,
  })),
  connections: environments.map((environmentId) =>
    Object.assign(host(environmentId), {
      state: "idle" as const,
      transport: "cloudflare" as const,
      startedAt: "2026-10-07T10:00:00.000Z",
      credentialExpiresAt: "2026-10-07T10:10:00.000Z",
    }),
  ),
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
  (await import("./controlQueryScope")).adoptControlAccountScope(signedIn);
  return import("./workspaceSessions");
}

describe("connected workspace recovery", () => {
  it("restores idle paired computers in an empty window without replacing frames on polling", async () => {
    const api = await registry();
    api.restoreWorkspaceSessions();
    expect(api.readWorkspaceSessions()).toEqual([]);
    api.restoreConnectedWorkspaces(connections("one", "two"), signedIn);
    expect(api.readWorkspaceSessions().map((session) => session.host.hostId)).toEqual([
      "host-one",
      "host-two",
    ]);
    const restored = api.readWorkspaceSessions();
    api.restoreConnectedWorkspaces(connections("one", "two"), signedIn);
    expect(api.readWorkspaceSessions()).toBe(restored);
    api.restoreConnectedWorkspaces({ connections: [] }, signedIn);
    expect(api.readWorkspaceSessions()).toBe(restored);
  });

  it("only restores verified, usable remote identities for the current account", async () => {
    const api = await registry();
    const response = connections("local", "valid", "unpaired", "foreign", "revoked", "unsigned");
    api.restoreConnectedWorkspaces(
      {
        ...response,
        pairedHosts: response.pairedHosts!.filter((pair) => pair.hostId !== "host-unpaired"),
        connections: response.connections.map((connection) => {
          if (connection.hostId === "host-foreign")
            return Object.assign(connection, {
              executionScope: { ...connection.executionScope!, userId: "bob" },
            });
          if (connection.hostId === "host-revoked")
            return Object.assign(connection, { state: "revoked" as const });
          if (connection.hostId === "host-unsigned")
            return Object.assign(connection, { executionScope: undefined });
          return connection;
        }),
      },
      signedIn,
    );
    expect(api.readWorkspaceSessions().map((session) => session.host.hostId)).toEqual([
      "host-valid",
    ]);
    api.restoreConnectedWorkspaces(connections("late"), { state: "signed-out" } as AccountStatus);
    (await import("./controlQueryScope")).adoptControlAccountScope({
      state: "signed-out",
    } as AccountStatus);
    api.restoreConnectedWorkspaces(connections("stale"), signedIn);
    expect(api.readWorkspaceSessions()).toHaveLength(1);
  });
});

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
        createChat: vi.fn(),
        openTerminal: vi.fn(),
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
      createChat: vi.fn(),
      openTerminal: vi.fn(),
      openProject: vi.fn(),
      navigate: vi.fn(),
      recover: vi.fn(),
    };
    const second = {
      browseFolders: vi.fn(),
      createProject: vi.fn(),
      newChat: vi.fn(),
      createChat: vi.fn(),
      openTerminal: vi.fn(),
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
        createChat: vi.fn(),
        openTerminal: vi.fn(),
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

describe("selected workspace commands", () => {
  const navigation = () => ({
    browseFolders: vi.fn(),
    createProject: vi.fn(),
    newChat: vi.fn(),
    createChat: vi.fn().mockResolvedValue(undefined),
    openTerminal: vi.fn(),
    openProject: vi.fn(),
    navigate: vi.fn(),
    recover: vi.fn(),
  });
  const summary = { state: "open" as const, path: "/thread", projects: [], threads: [] };

  it.each(["loading", "offline", "removed"] as const)(
    "refuses creation while the selected owner is %s instead of falling back locally",
    async (state) => {
      const api = await registry();
      const commands = await import("./workspaceCommands");
      api.addWorkspaceSession(host("one"));
      const remote = navigation();
      if (state !== "loading") api.updateWorkspaceSession("one", { navigation: remote, summary });
      if (state === "offline")
        api.updateWorkspaceSession("one", { summary: { ...summary, state: "closed" } });
      if (state === "removed") api.removeWorkspaceSession("host-one");
      await expect(
        commands.dispatchSelectedWorkspaceChatCreation("chat.newChat", "/remote?environment=one"),
      ).rejects.toThrow("Reconnect this computer");
      expect(() =>
        commands.dispatchSelectedWorkspaceTerminalCreation("/remote?environment=one"),
      ).toThrow("Reconnect this computer");
      expect(remote.createChat).not.toHaveBeenCalled();
      expect(remote.openTerminal).not.toHaveBeenCalled();
    },
  );
});
