import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly capabilities: ReadonlySet<"thread:read" | "thread:write" | "automation:write">;
}

export interface AgentGatewayIssuedSession extends AgentGatewaySessionIdentity {
  readonly token: string;
}

export interface AgentGatewaySessionRegistryShape {
  readonly issue: (threadId: ThreadId, provider: ProviderKind) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("synara/agentGateway/Services/AgentGatewaySessionRegistry") {}
