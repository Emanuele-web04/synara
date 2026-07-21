/**
 * AgentGateway - Synara app-control tool surface for provider agents.
 *
 * Serves the `synara_*` MCP tools that let any provider session (Codex,
 * Claude, Grok, ...) inspect and control Synara itself: list projects and
 * threads, read thread status, spawn child threads, send messages, and manage
 * heartbeat automations. The HTTP route delegates every `POST /mcp` request
 * here; authentication and JSON-RPC handling both live behind this interface.
 *
 * @module agentGateway/Services/AgentGateway
 */
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface AgentGatewayHttpResult {
  readonly status: number;
  /** JSON body; omitted for empty (202/405) responses. */
  readonly body?: unknown;
}

export interface AgentGatewayShape {
  /**
   * Handle one MCP streamable-HTTP POST. All failures are folded into
   * JSON-RPC error responses or HTTP status codes; the effect never fails.
   */
  readonly handleMcpPost: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<AgentGatewayHttpResult>;
}

export class AgentGateway extends ServiceMap.Service<AgentGateway, AgentGatewayShape>()(
  "synara/agentGateway/Services/AgentGateway",
) {}
