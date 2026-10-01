import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  EnvironmentId,
  ThreadId,
  TurnId,
  type ExecutionEnvironmentDescriptor,
  type HostConnection,
  type RemoteAgentCall,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { makeRemoteAwareTools, receiveRemoteTool } from "./remoteTools";
import { GatewayToolError, type ToolContext, type ToolEntry } from "./toolRuntime";
import { mcpToolResultJson, type McpToolCallResult } from "./protocol";

export const remoteTestEnvironment = (id = "mini", enabled = true) => ({
  getDescriptor: Effect.succeed({
    environmentId: EnvironmentId.makeUnsafe(id),
    label: id,
    channel: "dev",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "test",
    capabilities: {
      remoteConnections: enabled,
      remoteResources: enabled,
      repositoryIdentity: true,
    },
  } satisfies ExecutionEnvironmentDescriptor),
});
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "same-id",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "same-id",
  callerThreadLabel: null,
  callerTurnId: "turn",
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
const connection: HostConnection = {
  environmentId: "mini",
  hostId: "paired-mini",
  hostName: "Mini",
  state: "connected",
  transport: "cloudflare",
  startedAt: "2026-01-01T00:00:00.000Z",
  credentialExpiresAt: "2026-01-01T01:00:00.000Z",
  wsPath: "/unused",
  executionScope: {
    environmentId: "mini",
    accountAuthority: "https://example.invalid",
    userId: "user",
    organizationId: "org",
    channel: "dev",
  },
};
const call: RemoteAgentCall = {
  environmentId: EnvironmentId.makeUnsafe("mini"),
  caller: {
    environmentId: EnvironmentId.makeUnsafe("book"),
    threadId: ThreadId.makeUnsafe("same-id"),
    turnId: TurnId.makeUnsafe("turn"),
    provider: "codex",
    runtimeMode: "approval-required",
    envMode: "worktree",
    capabilities: ["thread:read", "thread:write"],
  },
  tool: "synara_read_thread",
  arguments: { threadId: "same-id" },
};
const payload = (result: McpToolCallResult) =>
  JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "{}");
function tool(name = "synara_read_thread", write = false): ToolEntry {
  return {
    definition: { name, description: "test", inputSchema: { type: "object", properties: {} } },
    requiredCapability: write ? "thread:write" : "thread:read",
    requiresActiveTurn: write,
    handler: vi.fn(() => Effect.succeed(mcpToolResultJson({ threadId: "same-id", side: "local" }))),
  };
}
function setup(entry = tool()) {
  const lifetime = new AbortController();
  const connections = {
    connectionSignal: () => lifetime.signal,
    lifecycleGeneration: 0,
    list: () => [connection],
    get: (_id: string) => connection as HostConnection | undefined,
    call: vi.fn(async () => mcpToolResultJson({ threadId: "same-id", side: "remote" })),
  };
  const tools = makeRemoteAwareTools({
    tools: [entry],
    assertRemoteWriteAllowed: () => Effect.void,
    environment: remoteTestEnvironment("book"),
    connections,
    requireThreadShell: () =>
      Effect.succeed({
        runtimeMode: "approval-required",
        envMode: "worktree",
      } as OrchestrationThreadShell),
  });
  return {
    entry,
    connections,
    lifetime,
    run: (args: Record<string, unknown>, ctx = context) =>
      Effect.runPromise(tools[1]!.handler(args, ctx)),
    tools,
  };
}

describe("remote Synara agent tools", () => {
  it("discovers both computers without exposing transport credentials", async () => {
    const { tools } = setup();
    const result = payload(await Effect.runPromise(tools[0]!.handler({}, context)));
    expect(result.currentEnvironmentId).toBe("book");
    expect(result.computers.map((host: { environmentId: string }) => host.environmentId)).toEqual([
      "book",
      "mini",
    ]);
    expect(JSON.stringify(result)).not.toContain("wsPath");
  });
  it("keeps identical thread ids separate and never changes the local default", async () => {
    const { run, entry, connections } = setup();
    expect(payload(await run({ threadId: "same-id", environmentId: "mini" }))).toMatchObject({
      side: "remote",
      environmentId: "mini",
    });
    expect(entry.handler).not.toHaveBeenCalled();
    const sent = connections.call.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      RemoteAgentCall,
    ];
    expect(sent[3]).toMatchObject({
      environmentId: "mini",
      caller: { environmentId: "book", runtimeMode: "approval-required", envMode: "worktree" },
    });
    expect(sent[3].arguments).toEqual({ threadId: "same-id" });
    expect(payload(await run({ threadId: "same-id" }))).toMatchObject({
      side: "local",
      environmentId: "book",
    });
  });
  it("does not fall back or replay when a remote call fails", async () => {
    const { run, entry, connections } = setup();
    connections.call.mockRejectedValueOnce(new Error("socket closed"));
    expect((await run({ environmentId: "mini" })).isError).toBe(true);
    expect(connections.call).toHaveBeenCalledTimes(1);
    expect(entry.handler).not.toHaveBeenCalled();
    expect((await run({ environmentId: "missing" })).isError).toBe(true);
    expect(connections.call).toHaveBeenCalledTimes(1);
  });
  it("rejects results from a changed account generation", async () => {
    const { run, connections } = setup();
    connections.call.mockImplementationOnce(async () => {
      connections.lifecycleGeneration++;
      return mcpToolResultJson({ secret: "stale" });
    });
    const result = await run({ environmentId: "mini" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stale");
  });
  it("rejects a reply after disconnect/reconnect to the same account and environment", async () => {
    const { run, connections, lifetime } = setup();
    connections.call.mockImplementationOnce(async () => {
      lifetime.abort();
      connections.connectionSignal = () => new AbortController().signal;
      return mcpToolResultJson({ secret: "stale" });
    });
    const result = await run({ environmentId: "mini" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("stale");
  });
  it("cancels a pending remote write when the original turn loses authority", async () => {
    const { run, connections } = setup(tool("synara_send_message", true));
    let active = true;
    let aborted = false;
    connections.call.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[4] as AbortSignal;
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("cancelled"));
          });
          active = false;
        }),
    );
    const result = await run(
      { environmentId: "mini" },
      {
        ...context,
        assertCallerTurnActive: () =>
          active ? Effect.void : Effect.fail(new GatewayToolError("caller_turn_inactive", "ended")),
      },
    );
    expect(result.isError).toBe(true);
    expect(aborted).toBe(true);
  });
  it("qualifies follow-up reads from waits", async () => {
    const { run, connections } = setup(tool("synara_wait_for_threads"));
    connections.call.mockResolvedValueOnce(
      mcpToolResultJson({
        threads: [
          {
            threadId: "same-id",
            readThread: { tool: "synara_read_thread", arguments: { threadId: "same-id" } },
          },
        ],
      }),
    );
    expect(payload(await run({ environmentId: "mini", threadIds: ["same-id"] }))).toMatchObject({
      environmentId: "mini",
      threads: [
        {
          environmentId: "mini",
          readThread: { arguments: { environmentId: "mini", threadId: "same-id" } },
        },
      ],
    });
  });
  it("never inherits a colliding remote caller's local identity or project", async () => {
    const entry = tool();
    await Effect.runPromise(
      receiveRemoteTool({
        call,
        tools: [entry],
        environment: remoteTestEnvironment(),
        peerOwnerId: "remote-device:approved",
      }),
    );
    const passed = vi.mocked(entry.handler).mock.calls[0]![1];
    expect(passed.callerThreadId).not.toBe("same-id");
    expect(passed.remoteCaller).toEqual({ runtimeMode: "approval-required", envMode: "worktree" });
    expect(passed.callerCapabilities.has("computer:control")).toBe(false);
  });
  it.each([
    ["unpaired local session", { peerOwnerId: "local-loopback" }],
    ["stable", { environment: remoteTestEnvironment("mini", false) }],
    ["wrong destination", { call: { ...call, environmentId: EnvironmentId.makeUnsafe("other") } }],
    ["missing capability", { call: { ...call, caller: { ...call.caller, capabilities: [] } } }],
    ["nested hop", { call: { ...call, arguments: { environmentId: "third" } } }],
    ["computer tool", { call: { ...call, tool: "computer_click" } }],
  ])("denies %s", async (_name, override) => {
    const entry = tool("call" in override ? override.call.tool : call.tool);
    const result = await Effect.runPromise(
      receiveRemoteTool({
        call,
        tools: [entry],
        environment: remoteTestEnvironment(),
        peerOwnerId: "remote-device:approved",
        ...override,
      }),
    );
    expect(result.isError).toBe(true);
    expect(entry.handler).not.toHaveBeenCalled();
  });
  it("rejects remote writes without a running origin turn", async () => {
    const entry = tool("synara_send_message", true);
    const result = await Effect.runPromise(
      receiveRemoteTool({
        call: { ...call, tool: entry.definition.name, caller: { ...call.caller, turnId: null } },
        tools: [entry],
        environment: remoteTestEnvironment(),
        peerOwnerId: "remote-device:approved",
      }),
    );
    expect(payload(result).error.code).toBe("caller_turn_inactive");
    expect(entry.handler).not.toHaveBeenCalled();
  });
});
