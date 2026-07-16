/**
 * AgentGatewayCredentials - Per-session credentials for the Synara agent
 * gateway.
 *
 * Small service split out from the gateway itself so provider adapters can
 * mint MCP connection details (endpoint URL + bearer token) at session start
 * without depending on the full tool surface.
 *
 * @module agentGateway/Services/AgentGatewayCredentials
 */
import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";
import type { AgentGatewaySessionIdentity } from "./AgentGatewaySessionRegistry.ts";

export interface AgentGatewayMcpConnection {
  /** Loopback streamable-HTTP MCP endpoint, e.g. `http://127.0.0.1:3773/mcp`. */
  readonly url: string;
  /** Bearer token bound to the calling thread. */
  readonly bearerToken: string;
}

export interface AgentGatewayStdioProxySpawn {
  /** Interpreter (the server's own node/bun binary). */
  readonly command: string;
  /** Script arguments (path to the generated proxy script). */
  readonly args: ReadonlyArray<string>;
}

export interface AgentGatewayCredentialsShape {
  /** Streamable-HTTP MCP endpoint served by this Synara instance. */
  readonly mcpEndpointUrl: string;
  /** Mint a new opaque bearer token for one provider session. */
  readonly issueSessionToken: (threadId: ThreadId, provider: ProviderKind) => string;
  /** Resolve a live bearer token back to its thread id, or null when invalid. */
  readonly verifySessionToken: (token: string) => string | null;
  /** Resolve the complete non-secret invocation scope. */
  readonly verifySession: (token: string) => AgentGatewaySessionIdentity | null;
  /** Revoke exactly one provider session credential. */
  readonly revokeSessionToken: (token: string) => void;
  /** Convenience bundle used when injecting MCP config into provider sessions. */
  readonly connectionForThread: (
    threadId: ThreadId,
    provider: ProviderKind,
  ) => AgentGatewayMcpConnection;
  /** Spawn spec for the stdio->HTTP proxy used by stdio-only MCP clients. */
  readonly stdioProxy: AgentGatewayStdioProxySpawn;
}

export class AgentGatewayCredentials extends ServiceMap.Service<
  AgentGatewayCredentials,
  AgentGatewayCredentialsShape
>()("t3/agentGateway/Services/AgentGatewayCredentials") {}
