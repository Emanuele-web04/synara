/**
 * AgentGatewayCredentialsLive - Live layer for agent gateway credentials.
 *
 * Issues opaque in-memory credentials. Tokens live for the provider session,
 * can be revoked independently, and intentionally do not survive a Synara
 * restart.
 *
 * @module agentGateway/Layers/AgentGatewayCredentials
 */
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config";
import { formatHostForUrl, isWildcardHost } from "../../startupAccess";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../Services/AgentGatewayCredentials";
import { ensureAgentGatewayStdioProxyScript } from "../stdioProxyScript";
import { AgentGatewaySessionRegistry } from "../Services/AgentGatewaySessionRegistry.ts";
import { AgentGatewaySessionRegistryLive } from "./AgentGatewaySessionRegistry.ts";

export const AGENT_GATEWAY_MCP_PATH = "/mcp";

// Providers run as local child processes, so they must target a host the HTTP
// server actually listens on. Wildcard binds cover loopback; an explicit host
// (e.g. `::1` or a LAN address) does not, so reuse it verbatim.
export function resolveAgentGatewayEndpointHost(configHost: string | undefined): string {
  if (configHost === undefined || isWildcardHost(configHost)) {
    return "127.0.0.1";
  }
  return formatHostForUrl(configHost);
}

export function makeAgentGatewayEndpoint(configHost: string | undefined, initialPort: number) {
  const endpointHost = resolveAgentGatewayEndpointHost(configHost);
  let port = initialPort;
  return {
    get url() {
      return `http://${endpointHost}:${port}${AGENT_GATEWAY_MCP_PATH}`;
    },
    setListeningPort: (listeningPort: number) => {
      port = listeningPort;
    },
  };
}

export const makeAgentGatewayCredentials = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const sessionRegistry = yield* AgentGatewaySessionRegistry;

  const endpoint = makeAgentGatewayEndpoint(config.host, config.port);
  const stdioProxyScriptPath = yield* ensureAgentGatewayStdioProxyScript(config.stateDir);

  const issueSessionToken: AgentGatewayCredentialsShape["issueSessionToken"] = (
    threadId,
    provider,
  ) => sessionRegistry.issue(threadId, provider).token;

  const verifySessionToken: AgentGatewayCredentialsShape["verifySessionToken"] = (token) =>
    sessionRegistry.verify(token)?.threadId ?? null;

  return {
    get mcpEndpointUrl() {
      return endpoint.url;
    },
    setListeningPort: endpoint.setListeningPort,
    issueSessionToken,
    verifySessionToken,
    verifySession: sessionRegistry.verify,
    revokeSessionToken: sessionRegistry.revoke,
    connectionForThread: (threadId, provider) => ({
      url: endpoint.url,
      bearerToken: issueSessionToken(threadId, provider),
    }),
    stdioProxy: {
      command: process.execPath,
      args: [stdioProxyScriptPath],
    },
  } satisfies AgentGatewayCredentialsShape;
});

export const AgentGatewayCredentialsLive = Layer.effect(
  AgentGatewayCredentials,
  makeAgentGatewayCredentials,
).pipe(Layer.provide(AgentGatewaySessionRegistryLive));

// Single shared composition so every consumer (HTTP gateway, provider
// adapters) reuses the same memoized in-memory session registry.
export const AgentGatewayCredentialsWithSecretsLive = AgentGatewayCredentialsLive.pipe(Layer.orDie);
