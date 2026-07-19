import { describe, expect, it } from "vitest";

import {
  makeAgentGatewayEndpoint,
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
