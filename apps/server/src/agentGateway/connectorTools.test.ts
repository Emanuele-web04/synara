import { Effect, Exit } from "effect";
import { expect, it, vi } from "vitest";
import { makeMcpConnectors } from "../mcpConnectors/Layers/McpConnectors.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "./Services/AgentGatewayCredentials.ts";
import { makeConnectorTools } from "./connectorTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["thread:read", "thread:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

it("chat creates only an inert proposal, rejects forged approval, and keeps secret values out of results", async () => {
  let saved: Uint8Array | null = null;
  const surfaced = vi.fn(() => Effect.void);
  const program = Effect.scoped(
    Effect.gen(function* () {
      const connectors = yield* makeMcpConnectors({ enabled: true });
      const tools = makeConnectorTools({
        connectors,
        surface: surfaced,
        resolveWorkspaceRoot: () => Effect.succeed(process.cwd()),
      });
      const add = tools.find((tool) => tool.definition.name === "synara_add_mcp_connector")!;
      const input = {
        name: "Local",
        command: "nonexistent-fixture-command",
        args: [],
        env: { SERVICE_TOKEN: "hidden-value" },
      };
      const forged = yield* add.handler({ ...input, approved: true }, context);
      expect(forged.isError).toBe(true);
      const publicHttp = yield* add.handler({ url: "http://example.com/mcp" }, context);
      expect(publicHttp.isError).toBe(true);
      expect(JSON.stringify(publicHttp)).toContain("loopback");
      expect(yield* connectors.listProposals()).toEqual([]);
      const result = yield* add.handler(input, context);
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result)).not.toContain("hidden-value");
      expect(JSON.stringify(result)).toContain("new threads");
      expect(yield* connectors.list()).toEqual([]);
      const proposals = yield* connectors.listProposals();
      expect(proposals).toHaveLength(1);
      expect(proposals[0]).toMatchObject({
        state: "pending",
        connector: {
          command: "nonexistent-fixture-command",
          cwd: process.cwd(),
          envKeys: ["SERVICE_TOKEN"],
        },
      });
      expect(JSON.stringify(proposals)).not.toContain("hidden-value");
      expect(surfaced).toHaveBeenCalledOnce();
      expect(new TextDecoder().decode(saved!)).toContain("hidden-value");
    }),
  ).pipe(
    Effect.provideService(ServerSecretStore, {
      get: () => Effect.sync(() => saved),
      set: (_name, value) =>
        Effect.sync(() => {
          saved = value;
        }),
      getOrCreateRandom: () => Effect.die("unused"),
      remove: () => Effect.void,
    }),
    Effect.provideService(AgentGatewayCredentials, {
      mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
      verifySession: () => null,
      setConnectorServers: () => {},
    } as unknown as AgentGatewayCredentialsShape),
  );
  await Effect.runPromise(program);
});

it("a disabled connector service refuses proposals without reading connector secrets", async () => {
  const read = vi.fn(() => Effect.succeed(null));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connectors = yield* makeMcpConnectors({ enabled: false });
        expect(
          Exit.isFailure(
            yield* Effect.exit(
              connectors.proposeAdd(
                { url: "http://localhost:29979/mcp" },
                "thread",
                undefined,
                undefined,
              ),
            ),
          ),
        ).toBe(true);
        expect(Exit.isFailure(yield* Effect.exit(connectors.listProposals()))).toBe(true);
        expect(read).not.toHaveBeenCalled();
      }),
    ).pipe(
      Effect.provideService(ServerSecretStore, {
        get: read,
        set: () => Effect.die("unused"),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: () => Effect.die("unused"),
      }),
      Effect.provideService(AgentGatewayCredentials, {
        mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
      } as unknown as AgentGatewayCredentialsShape),
    ),
  );
});
