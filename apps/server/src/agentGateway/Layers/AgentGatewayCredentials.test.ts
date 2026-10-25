import { describe, expect, it } from "vitest";

import {
  makeAgentGatewayConnectorRegistry,
  makeAgentGatewayEndpoint,
  makeAgentGatewayStdioBootstrapRegistry,
  resolveAgentGatewayEndpointHost,
} from "./AgentGatewayCredentials.ts";

describe("resolveAgentGatewayEndpointHost", () => {
  it("falls back to IPv4 loopback for default and wildcard binds", () => {
    expect(resolveAgentGatewayEndpointHost(undefined)).toBe("127.0.0.1");
    expect(resolveAgentGatewayEndpointHost("0.0.0.0")).toBe("127.0.0.1");
    expect(resolveAgentGatewayEndpointHost("::")).toBe("127.0.0.1");
    expect(resolveAgentGatewayEndpointHost("[::]")).toBe("127.0.0.1");
  });

  it("reuses an explicit bind host so child processes can reach the listener", () => {
    expect(resolveAgentGatewayEndpointHost("localhost")).toBe("localhost");
    expect(resolveAgentGatewayEndpointHost("192.168.1.20")).toBe("192.168.1.20");
  });

  it("brackets IPv6 hosts for URL use", () => {
    expect(resolveAgentGatewayEndpointHost("::1")).toBe("[::1]");
    expect(resolveAgentGatewayEndpointHost("[::1]")).toBe("[::1]");
  });

  it("updates connections after a dynamic listen port is resolved", () => {
    const endpoint = makeAgentGatewayEndpoint(undefined, 0);
    expect(endpoint.url).toBe("http://127.0.0.1:0/mcp");
    endpoint.setListeningPort(48123);
    expect(endpoint.url).toBe("http://127.0.0.1:48123/mcp");
  });
});

describe("makeAgentGatewayStdioBootstrapRegistry", () => {
  it("consumes bootstrap credentials once and invalidates them with their session", () => {
    const liveSessions = new Set(["session-a", "session-b"]);
    let sequence = 0;
    const registry = makeAgentGatewayStdioBootstrapRegistry({
      sessionIsActive: (token) => liveSessions.has(token),
      randomId: () => String(++sequence),
    });

    const first = registry.issue("session-a");
    expect(first).toBe("sagw_bootstrap_1");
    expect(registry.exchange(first!)).toBe("session-a");
    expect(registry.exchange(first!)).toBeNull();

    const revoked = registry.issue("session-b");
    expect(revoked).toBe("sagw_bootstrap_2");
    registry.revokeSession("session-b");
    expect(registry.exchange(revoked!)).toBeNull();

    liveSessions.delete("session-a");
    expect(registry.issue("session-a")).toBeNull();
  });

  it("rejects an unconsumed bootstrap after its short startup lifetime", () => {
    let now = 1_000;
    const registry = makeAgentGatewayStdioBootstrapRegistry({
      sessionIsActive: () => true,
      randomId: () => "expiring",
      now: () => now,
      ttlMs: 50,
    });

    const bootstrap = registry.issue("session-a");
    now += 50;

    expect(registry.exchange(bootstrap!)).toBeNull();
  });
});

describe("makeAgentGatewayConnectorRegistry", () => {
  const supabase = { name: "supabase_connector", connectorId: "mcp_conn_1" };
  const linear = { name: "linear_connector", connectorId: "mcp_conn_2" };

  it("lets a bearer reach only the connectors it was issued with", () => {
    const live = new Set(["early", "late", "pi"]);
    const registry = makeAgentGatewayConnectorRegistry({ sessionIsActive: (t) => live.has(t) });

    registry.set([supabase]);
    expect(registry.grant("early", "codex")).toEqual([supabase]);
    registry.set([supabase, linear]);
    expect(registry.grant("late", "claudeAgent")).toEqual([supabase, linear]);

    // A session keeps the set it started with.
    expect(registry.canUse("early", "mcp_conn_1")).toBe(true);
    expect(registry.canUse("early", "mcp_conn_2")).toBe(false);
    expect(registry.canUse("late", "mcp_conn_2")).toBe(true);
  });

  it("gives providers without connector support no grant", () => {
    const registry = makeAgentGatewayConnectorRegistry({ sessionIsActive: () => true });
    registry.set([supabase]);
    expect(registry.grant("pi", "pi")).toEqual([]);
    expect(registry.canUse("pi", "mcp_conn_1")).toBe(false);
  });

  it("refuses revoked and inactive bearers", () => {
    const live = new Set(["a", "b"]);
    const registry = makeAgentGatewayConnectorRegistry({ sessionIsActive: (t) => live.has(t) });
    registry.set([supabase]);
    registry.grant("a", "codex");
    registry.grant("b", "codex");
    registry.revokeSession("a");
    expect(registry.canUse("a", "mcp_conn_1")).toBe(false);
    live.delete("b");
    expect(registry.canUse("b", "mcp_conn_1")).toBe(false);
  });
});
