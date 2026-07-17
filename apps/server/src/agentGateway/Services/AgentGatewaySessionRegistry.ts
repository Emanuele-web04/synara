import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
  readonly capabilities: ReadonlySet<"thread:read" | "thread:write" | "automation:write">;
}

export interface AgentGatewayIssuedSession extends AgentGatewaySessionIdentity {
  readonly token: string;
}

/**
 * Non-secret authority captured when an MCP HTTP request enters the gateway.
 *
 * Provider-session credentials intentionally survive across turns so native
 * sessions can resume without rebuilding their MCP client. Write authority is
 * narrower: one request/batch is pinned to the exact running turn observed at
 * ingress and must never be rebound to a later `latestTurn` while it executes.
 */
export interface AgentGatewayWriteAuthority {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly turnId: string;
}

export interface AgentGatewaySessionRegistryShape {
  readonly issue: (threadId: ThreadId, provider: ProviderKind) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly bindWriteAuthority: (token: string, turnId: string) => AgentGatewayWriteAuthority | null;
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("synara/agentGateway/Services/AgentGatewaySessionRegistry") {}
