import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AgentGatewayHttpResult } from "../../agentGateway/Services/AgentGateway.ts";
import type { ExternalMcpVerifiedClient } from "./ExternalMcpService.ts";

export interface ExternalMcpGatewayShape {
  readonly handlePost: (input: {
    readonly authorizationHeader: string | undefined;
    readonly body: unknown;
  }) => Effect.Effect<AgentGatewayHttpResult>;
  readonly handleVerifiedPost: (input: {
    readonly client: ExternalMcpVerifiedClient;
    readonly body: unknown;
  }) => Effect.Effect<AgentGatewayHttpResult>;
}

export class ExternalMcpGateway extends ServiceMap.Service<
  ExternalMcpGateway,
  ExternalMcpGatewayShape
>()("synara/externalMcp/Services/ExternalMcpGateway") {}
