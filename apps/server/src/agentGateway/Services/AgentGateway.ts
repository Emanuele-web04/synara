import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface AgentGatewayHttpResult {
  readonly status: number;
  /** omitted for empty (202/405) responses */
  readonly body?: unknown;
}

export interface AgentGatewayShape {
  /** failures fold into JSON-RPC errors or HTTP status — the effect never fails */
  readonly handleMcpPost: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<AgentGatewayHttpResult>;
}

export class AgentGateway extends ServiceMap.Service<AgentGateway, AgentGatewayShape>()(
  "synara/agentGateway/Services/AgentGateway",
) {}
