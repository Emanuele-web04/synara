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
import type { ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

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
  /** Mint (or re-derive) the stable bearer token for a thread. */
  readonly issueSessionToken: (threadId: ThreadId) => string;
  /** Resolve a bearer token back to its thread id, or null when invalid. */
  readonly verifySessionToken: (token: string) => string | null;
  /** Convenience bundle used when injecting MCP config into provider sessions. */
  readonly connectionForThread: (threadId: ThreadId) => AgentGatewayMcpConnection;
  /** Spawn spec for the stdio->HTTP proxy used by stdio-only MCP clients. */
  readonly stdioProxy: AgentGatewayStdioProxySpawn;
}

export class AgentGatewayCredentials extends ServiceMap.Service<
  AgentGatewayCredentials,
  AgentGatewayCredentialsShape
>()("t3/agentGateway/Services/AgentGatewayCredentials") {}
