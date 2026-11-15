import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionEnvironmentDescriptor, HostConnection } from "@synara/contracts";

const descriptor = {
  environmentId: "local",
  channel: "dev",
  capabilities: { remoteConnections: true },
} as ExecutionEnvironmentDescriptor;
const scope = {
  environmentId: "mini",
  accountAuthority: "https://account.example",
  userId: "alice",
  organizationId: "org",
  channel: "dev" as const,
};
const host = {
  hostId: "host-mini",
  hostName: "Mini",
  wsPath: "/ws/remote/mini",
  executionScope: scope,
};
const connect = vi.fn<(input: { hostId: string }) => Promise<HostConnection>>();

beforeEach(() => {
  vi.resetModules();
  connect.mockReset();
  vi.doMock("./api", () => ({ ensureHostsApi: () => ({ connect }) }));
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
});

async function setup() {
  (await import("./executionContext")).initializeExecutionContext({
    controller: descriptor,
    execution: descriptor,
    remote: null,
  });
  const sessions = await import("./workspaceSessions");
  const { reconnectWorkspaceComputer } = await import("./workspaceReconnect");
  sessions.addWorkspaceSession(host);
  return { sessions, reconnectWorkspaceComputer };
}

const connection = (executionScope = scope) =>
  ({ ...host, executionScope, transport: "lan" }) as unknown as HostConnection;

describe("reconnectWorkspaceComputer", () => {
  it("redials through the controller, then resumes a parked frame", async () => {
    const { sessions, reconnectWorkspaceComputer } = await setup();
    const resumeConnection = vi.fn();
    sessions.updateWorkspaceSession("mini", { resumeConnection });
    connect.mockResolvedValue(connection());
    await reconnectWorkspaceComputer("mini");
    expect(connect).toHaveBeenCalledWith({ hostId: "host-mini" });
    expect(resumeConnection).toHaveBeenCalledOnce();
    expect(resumeConnection.mock.calls[0]).toEqual([undefined]);
  });

  it("remounts a frame whose bootstrap failed", async () => {
    const { sessions, reconnectWorkspaceComputer } = await setup();
    sessions.updateWorkspaceSession("mini", { error: "This computer is unavailable." });
    connect.mockResolvedValue(connection());
    await reconnectWorkspaceComputer("mini");
    expect(sessions.readWorkspaceSessions()[0]).toMatchObject({ frameGeneration: 1 });
    expect(sessions.readWorkspaceSessions()[0]?.error).toBeUndefined();
  });

  it("refuses a changed identity without touching the frame", async () => {
    const { sessions, reconnectWorkspaceComputer } = await setup();
    const resumeConnection = vi.fn();
    sessions.updateWorkspaceSession("mini", { resumeConnection });
    connect.mockResolvedValue(connection({ ...scope, userId: "bob" }));
    await expect(reconnectWorkspaceComputer("mini")).rejects.toThrow(/identity changed/);
    expect(resumeConnection).not.toHaveBeenCalled();
    await expect(reconnectWorkspaceComputer("unknown")).rejects.toThrow(/no longer connected/);
  });
});
