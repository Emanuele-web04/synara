import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

export type AgentGatewayCapability =
  | "thread:read"
  | "thread:write"
  | "automation:write"
  | "diagnostics:read"
  | "browser:control"
  | "device:control";

export interface AgentGatewaySessionIdentity {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly issuedAt: number;
  readonly capabilities: ReadonlySet<AgentGatewayCapability>;
}

export interface AgentGatewayIssuedSession extends AgentGatewaySessionIdentity {
  readonly token: string;
}

/** write authority is pinned to the exact running turn observed at ingress — never rebound to a later latestTurn mid-execution */
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
  /** after this the bearer may keep read-only MCP traffic but can never acquire write authority for a later turn */
  readonly retireWriteAuthority: (token: string, turnId: string) => boolean;
  readonly revoke: (token: string) => void;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("synara/agentGateway/Services/AgentGatewaySessionRegistry") {}
