import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { mcpConnectorsRouteLayer, renderConnectorCallbackPage } from "./httpRoute.ts";
import type { McpConnectorForwardRequest } from "./runtime.ts";
import { McpConnectors, type McpConnectorsShape } from "./Services/McpConnectors.ts";

const VALID_TOKEN = "sagw_session_connector_route_test";

async function withConnectorServer(
  options: { readonly enabled: boolean },
  run: (input: {
    readonly origin: string;
    readonly forwarded: ReadonlyArray<{ connectorId: string; request: McpConnectorForwardRequest }>;
    readonly callbacks: ReadonlyArray<Record<string, string | undefined>>;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const forwarded: Array<{ connectorId: string; request: McpConnectorForwardRequest }> = [];
  const callbacks: Array<Record<string, string | undefined>> = [];
  let nodeServer: http.Server | null = null;
  try {
    const threadId = ThreadId.makeUnsafe("thread-connector-route-test");
    const credentials = {
      canUseConnector: (token: string, connectorId: string) =>
        token === VALID_TOKEN && connectorId === "mcp_conn_1",
      verifySession: (token: string) =>
        token === VALID_TOKEN
          ? {
              sessionKey: "session-connector-route-test",
              threadId,
              provider: "claudeAgent",
              issuedAt: 1,
              capabilities: new Set(),
            }
          : null,
    } as unknown as AgentGatewayCredentialsShape;
    const connectors: McpConnectorsShape = {
      enabled: options.enabled,
      list: () => Effect.succeed([]),
      connect: () => Effect.die("unused"),
      disconnect: () => Effect.succeed(false),
      setup: () => Effect.succeed({ redirectUrl: "http://127.0.0.1/oauth/mcp/callback" }),
      completeAuthorization: (query) => {
        callbacks.push(query);
        return Effect.succeed(
          query.code === "good"
            ? { ok: true as const, name: "<Acme>" }
            : { ok: false as const, title: "Nope", message: "It failed." },
        );
      },
      forward: (connectorId, request) => {
        forwarded.push({ connectorId, request });
        return Effect.succeed({
          status: 200,
          sessionId: "upstream-session",
          body: { kind: "json" as const, value: { jsonrpc: "2.0", id: 1, result: {} } },
        });
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
          const httpApp = yield* HttpRouter.toHttpEffect(mcpConnectorsRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(McpConnectors, connectors),
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
      throw new Error("Expected connector test server to expose an address");
    }
    await run({ origin: `http://127.0.0.1:${address.port}`, forwarded, callbacks });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

const call = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("mcpConnectorsRouteLayer", () => {
  it("answers 404 everywhere when connectors are disabled", async () => {
    await withConnectorServer({ enabled: false }, async ({ origin, forwarded, callbacks }) => {
      const post = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify(call),
      });
      expect(post.status).toBe(404);
      const callback = await fetch(`${origin}/oauth/mcp/callback?state=s&code=good`);
      expect(callback.status).toBe(404);
      expect(forwarded).toHaveLength(0);
      expect(callbacks).toHaveLength(0);
    });
  });

  it("requires a live session bearer and forwards MCP session headers both ways", async () => {
    await withConnectorServer({ enabled: true }, async ({ origin, forwarded }) => {
      const unauthorized = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: JSON.stringify(call),
      });
      expect(unauthorized.status).toBe(401);
      expect(forwarded).toHaveLength(0);

      const response = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VALID_TOKEN}`,
          "Content-Type": "application/json",
          "Mcp-Session-Id": "client-session",
          "Mcp-Protocol-Version": "2025-06-18",
        },
        body: JSON.stringify(call),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe("upstream-session");
      expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      expect(forwarded).toEqual([
        {
          connectorId: "mcp_conn_1",
          request: {
            method: "POST",
            body: call,
            sessionId: "client-session",
            protocolVersion: "2025-06-18",
          },
        },
      ]);
    });
  });

  it("refuses connectors the session was not given", async () => {
    await withConnectorServer({ enabled: true }, async ({ origin, forwarded }) => {
      const response = await fetch(`${origin}/mcp/connectors/mcp_conn_other`, {
        method: "POST",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
        body: JSON.stringify(call),
      });
      expect(response.status).toBe(404);
      expect(forwarded).toHaveLength(0);
    });
  });

  it("offers no standalone stream and needs a session to end one", async () => {
    await withConnectorServer({ enabled: true }, async ({ origin, forwarded }) => {
      const get = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(get.status).toBe(405);
      const deleteWithoutSession = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${VALID_TOKEN}` },
      });
      expect(deleteWithoutSession.status).toBe(400);
      const deleted = await fetch(`${origin}/mcp/connectors/mcp_conn_1`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${VALID_TOKEN}`, "Mcp-Session-Id": "client-session" },
      });
      expect(deleted.status).toBe(204);
      expect(forwarded.map((entry) => entry.request.method)).toEqual(["DELETE"]);
    });
  });

  it("renders the OAuth callback outcome as a locked-down page", async () => {
    await withConnectorServer({ enabled: true }, async ({ origin, callbacks }) => {
      const response = await fetch(
        `${origin}/oauth/mcp/callback?state=abc&code=good&error_description=ignored`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("&lt;Acme&gt; is connected");
      expect(html).not.toContain("<Acme>");
      expect(callbacks).toEqual([
        { state: "abc", code: "good", error: undefined, errorDescription: "ignored" },
      ]);

      const failed = await fetch(`${origin}/oauth/mcp/callback?state=abc&error=access_denied`);
      expect(failed.status).toBe(400);
      expect(await failed.text()).toContain("It failed. You can close this tab.");
    });
  });
});

describe("renderConnectorCallbackPage", () => {
  it("escapes vendor-controlled text", () => {
    const html = renderConnectorCallbackPage({
      ok: false,
      title: "Bad",
      message: `<script>alert("x")</script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });
});
