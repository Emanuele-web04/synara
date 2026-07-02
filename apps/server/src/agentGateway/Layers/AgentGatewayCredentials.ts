/**
 * AgentGatewayCredentialsLive - Live layer for agent gateway credentials.
 *
 * Loads (or creates) the per-install signing secret and derives stateless
 * per-thread bearer tokens from it. Tokens survive restarts because they are
 * re-derivable from the persisted secret; nothing else is stored.
 *
 * @module agentGateway/Layers/AgentGatewayCredentials
 */
import { Effect, Layer } from "effect";

import { ServerConfig } from "../../config";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../Services/AgentGatewayCredentials";
import { ensureAgentGatewayStdioProxyScript } from "../stdioProxyScript";
import { signAgentSessionToken, verifyAgentSessionToken } from "../tokens";

const AGENT_GATEWAY_SECRET_NAME = "agent-gateway-token";
const AGENT_GATEWAY_SECRET_BYTES = 32;

export const AGENT_GATEWAY_MCP_PATH = "/mcp";

// Providers run as local child processes, so they must target a host the HTTP
// server actually listens on. Wildcard binds cover loopback; an explicit host
// (e.g. `::1` or a LAN address) does not, so reuse it verbatim.
export function resolveAgentGatewayEndpointHost(configHost: string | undefined): string {
  if (configHost === undefined || configHost === "0.0.0.0" || configHost === "::") {
    return "127.0.0.1";
  }
  return configHost.includes(":") ? `[${configHost}]` : configHost;
}

export const makeAgentGatewayCredentials = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const secret = yield* secretStore.getOrCreateRandom(
    AGENT_GATEWAY_SECRET_NAME,
    AGENT_GATEWAY_SECRET_BYTES,
  );

  const endpointHost = resolveAgentGatewayEndpointHost(config.host);
  const mcpEndpointUrl = `http://${endpointHost}:${config.port}${AGENT_GATEWAY_MCP_PATH}`;
  const stdioProxyScriptPath = yield* ensureAgentGatewayStdioProxyScript(config.stateDir);

  const issueSessionToken: AgentGatewayCredentialsShape["issueSessionToken"] = (threadId) =>
    signAgentSessionToken({ secret, threadId });

  const verifySessionToken: AgentGatewayCredentialsShape["verifySessionToken"] = (token) =>
    verifyAgentSessionToken({ secret, token });

  return {
    mcpEndpointUrl,
    issueSessionToken,
    verifySessionToken,
    connectionForThread: (threadId) => ({
      url: mcpEndpointUrl,
      bearerToken: issueSessionToken(threadId),
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
);

// Single shared composition so every consumer (HTTP gateway, provider
// adapters) reuses the same memoized layer instance and thus the same secret.
// Secret-store or proxy-script IO failures are unrecoverable startup defects.
export const AgentGatewayCredentialsWithSecretsLive = AgentGatewayCredentialsLive.pipe(
  Layer.provide(ServerSecretStoreLive),
  Layer.orDie,
);
