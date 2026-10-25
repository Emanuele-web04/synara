// The default service must restore this app's connectors on Stable, without a gate override.
import { Effect } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  SYNARA_DESKTOP_BUNDLE_ID_ENV,
  SYNARA_PRODUCTION_BUNDLE_ID,
} from "@synara/shared/desktopIdentity";

import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";

afterEach(() => vi.unstubAllEnvs());

it("restores and publishes saved connectors on the Stable server by default", async () => {
  vi.stubEnv(SYNARA_DESKTOP_BUNDLE_ID_ENV, SYNARA_PRODUCTION_BUNDLE_ID);
  const { makeMcpConnectors } = await import("./McpConnectors");
  const connector = {
    connectorId: "saved-connector",
    presetId: null,
    name: "Saved service",
    url: "https://mcp.example.com/mcp",
    serverName: "saved_service_connector",
    authKind: "none",
    status: "connected",
    createdAt: "2026-10-25T12:00:00Z",
    updatedAt: "2026-10-25T12:00:00Z",
    oauth: null,
  };
  const stored = new TextEncoder().encode(JSON.stringify({ version: 1, connectors: [connector] }));
  const setConnectorServers = vi.fn();
  const service = await Effect.runPromise(
    makeMcpConnectors().pipe(
      Effect.provideService(ServerSecretStore, {
        get: () => Effect.succeed(stored),
        set: () => Effect.die("Unexpected write during restore"),
        remove: () => Effect.die("Unexpected removal during restore"),
        getOrCreateRandom: () => Effect.die("Unexpected secret creation during restore"),
      }),
      Effect.provideService(AgentGatewayCredentials, {
        mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
        setConnectorServers,
      } as unknown as AgentGatewayCredentialsShape),
    ),
  );
  expect(service.enabled).toBe(true);
  expect(await Effect.runPromise(service.list())).toMatchObject([
    { connectorId: "saved-connector", status: "connected" },
  ]);
  expect(setConnectorServers).toHaveBeenCalledWith([
    { connectorId: "saved-connector", name: "saved_service_connector" },
  ]);
  expect(await Effect.runPromise(service.setup())).toEqual({
    redirectUrl: "http://127.0.0.1:3773/oauth/mcp/callback",
  });
});
