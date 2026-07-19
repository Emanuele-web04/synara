import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { AgentGateway, type AgentGatewayShape } from "./Services/AgentGateway.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "./Services/AgentGatewayCredentials.ts";
import { AGENT_GATEWAY_MCP_MAX_BODY_BYTES, agentGatewayRouteLayer } from "./httpRoute.ts";

const VALID_TOKEN = "sagw_session_http_route_test";

async function withGatewayServer(
  run: (input: {
    readonly origin: string;
    readonly handledBodies: ReadonlyArray<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const handledBodies: unknown[] = [];
  let nodeServer: http.Server | null = null;
  try {
    const threadId = ThreadId.makeUnsafe("thread-http-route-test");
    const credentials: AgentGatewayCredentialsShape = {
      mcpEndpointUrl: "http://127.0.0.1/mcp",
      setListeningPort: () => undefined,
      issueSessionToken: () => VALID_TOKEN,
      verifySessionToken: (token) => (token === VALID_TOKEN ? threadId : null),
      verifySession: (token) =>
        token === VALID_TOKEN
          ? {
              sessionKey: "session-http-route-test",
              threadId,
              provider: "cursor",
              issuedAt: 1,
              capabilities: new Set(["thread:read", "thread:write", "automation:write"]),
            }
          : null,
      bindWriteAuthority: (token, turnId) =>
        token === VALID_TOKEN
          ? {
              sessionKey: "session-http-route-test",
              threadId,
              provider: "cursor",
              turnId,
            }
          : null,
      verifyWriteAuthority: (authority) => authority.sessionKey === "session-http-route-test",
      revokeSessionToken: () => undefined,
      connectionForThread: () => ({
        url: "http://127.0.0.1/mcp",
        bearerToken: VALID_TOKEN,
      }),
      stdioProxy: { command: process.execPath, args: [] },
    };
    const gateway: AgentGatewayShape = {
      handleMcpPost: (input) => {
        handledBodies.push(input.body);
        return Effect.succeed({ status: 200, body: { ok: true } });
      },
    };

    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(agentGatewayRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(AgentGateway, gateway),
              Layer.succeed(AgentGatewayCredentials, credentials),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );

    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected agent gateway test server to expose an address");
    }
    await run({ origin: `http://127.0.0.1:${address.port}`, handledBodies });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("agentGatewayRouteLayer", () => {
  it("authenticates before reading the body and enforces the 1 MiB limit", async () => {
    await withGatewayServer(async ({ origin, handledBodies }) => {
      const oversizedBody = "x".repeat(AGENT_GATEWAY_MCP_MAX_BODY_BYTES + 1);
      const unauthorized = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer invalid" },
        body: oversizedBody,
      });
      expect(unauthorized.status).toBe(401);

      const oversized = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
      expect(handledBodies).toHaveLength(0);

      const validBody = { jsonrpc: "2.0", id: 1, method: "ping" };
      const valid = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(validBody),
      });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ ok: true });
      expect(handledBodies).toEqual([validBody]);
    });
  });

  it("returns 400 for malformed authenticated JSON", async () => {
    await withGatewayServer(async ({ origin, handledBodies }) => {
      const response = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: "{not-json",
      });
      expect(response.status).toBe(400);
      expect(handledBodies).toHaveLength(0);
    });
  });
});
