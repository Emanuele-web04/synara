// Exercises the connector's durable sign-in through the real MCP OAuth SDK.
// Only the vendor HTTP responses and MCP transport are substituted.
import { describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ request: vi.fn(), forward: vi.fn() }));
vi.mock("@synara/shared/outboundHttp", () => ({ outboundHttp: { request: network.request } }));
vi.mock("./proxy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./proxy.ts")>()),
  probeMcpConnector: async () => ({ kind: "oauth", scope: "openid" }),
  forwardMcpConnectorRequest: network.forward,
}));

import { McpConnectorRuntime } from "./runtime";

describe("Vercel connector OAuth", () => {
  it("requests renewable access and refreshes the saved grant after a restart", async () => {
    let saved: string | null = null;
    let now = Date.parse("2026-10-16T10:00:00Z");
    let registrationScope: unknown;
    const grants: string[] = [];
    network.request.mockImplementation(async ({ url, body }) => {
      const target = new URL(url);
      let response: unknown;
      if (target.hostname === "mcp.vercel.com") {
        response = {
          resource: "https://mcp.vercel.com/",
          authorization_servers: ["https://auth.example.test"],
          scopes_supported: ["openid"],
        };
      } else if (target.pathname.includes(".well-known")) {
        response = {
          issuer: "https://auth.example.test",
          authorization_endpoint: "https://auth.example.test/authorize",
          token_endpoint: "https://auth.example.test/token",
          registration_endpoint: "https://auth.example.test/register",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["openid", "offline_access"],
        };
      } else if (target.pathname === "/register") {
        const registration = JSON.parse(body);
        registrationScope = registration.scope;
        response = { ...registration, client_id: "fixture-client" };
      } else if (target.pathname === "/token") {
        const grant = new URLSearchParams(body).get("grant_type")!;
        grants.push(grant);
        response = {
          access_token: grant === "refresh_token" ? "fixture-renewed" : "fixture-access",
          token_type: "bearer",
          expires_in: 60,
          refresh_token: "fixture-refresh",
        };
      } else {
        throw new Error(`Unexpected fixture request: ${target.origin}${target.pathname}`);
      }
      return {
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        body: new TextEncoder().encode(JSON.stringify(response)),
      };
    });
    const makeRuntime = () =>
      new McpConnectorRuntime({
        load: async () => saved,
        save: async (value) => {
          saved = value;
        },
        redirectUrl: () => "http://127.0.0.1:3773/oauth/mcp/callback",
        publish: () => {},
        clientVersion: "1.0.6",
        logWarning: () => {},
        now: () => now,
      });
    const runtime = makeRuntime();
    const started = await runtime.connect({ presetId: "vercel" });
    const authorization = new URL(started.authorizationUrl!);
    expect(authorization.searchParams.get("scope")).toBe("openid offline_access");
    expect(registrationScope).toBe("openid offline_access");
    expect(
      await runtime.completeAuthorization({
        state: authorization.searchParams.get("state")!,
        code: "fixture-code",
        error: undefined,
        errorDescription: undefined,
      }),
    ).toEqual({ ok: true, name: "Vercel" });

    now += 120_000;
    const restarted = makeRuntime();
    await restarted.init();
    network.forward.mockResolvedValue({
      status: 200,
      sessionId: null,
      body: { kind: "json", value: { jsonrpc: "2.0", id: 1, result: { tools: [] } } },
    });
    const connector = restarted.list()[0]!;
    const result = await restarted.forward(connector.connectorId, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(result.status).toBe(200);
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
    expect(network.forward.mock.calls[0]?.[0].accessToken).toBe("fixture-renewed");
    expect(restarted.list()[0]?.status).toBe("connected");
  });
});
