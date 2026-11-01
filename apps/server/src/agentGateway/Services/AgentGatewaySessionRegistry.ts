import type { ProviderKind, ThreadId } from "@synara/contracts";
import { ServiceMap } from "effect";

export type AgentGatewayCapability =
  | "thread:read"
  | "thread:write"
  | "automation:write"
  | "diagnostics:read"
  | "browser:control"
  | "device:control"
  | "computer:control";

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

/**
 * Non-secret authority captured when an MCP HTTP request enters the gateway.
 *
 * Provider-session credentials can survive across turns until their adapter
 * explicitly retires them. Write authority is narrower: one request/batch is
 * pinned to the exact running turn observed at ingress and must never be
 * rebound to a later `latestTurn` while it executes.
 */
export interface AgentGatewayWriteAuthority {
  readonly sessionKey: string;
  readonly threadId: ThreadId;
  readonly provider: ProviderKind;
  readonly turnId: string;
}

/**
 * Read-only view of a live session credential whose write authority was
 * retired by a terminal turn. The bearer still authenticates read-only MCP
 * traffic, but it can never bind write authority to a later turn — which is
 * exactly the state diagnostics needs to surface.
 */
export interface AgentGatewayRetiredWriteAuthority {
  readonly sessionKey: string;
  readonly provider: ProviderKind;
  readonly retiredTurnId: string;
  readonly issuedAt: number;
}

export interface AgentGatewaySessionRegistryShape {
  readonly issue: (
    threadId: ThreadId,
    provider: ProviderKind,
    options?: { readonly additionalCapabilities?: readonly AgentGatewayCapability[] },
  ) => AgentGatewayIssuedSession;
  readonly verify: (token: string) => AgentGatewaySessionIdentity | null;
  readonly bindWriteAuthority: (token: string, turnId: string) => AgentGatewayWriteAuthority | null;
  readonly verifyWriteAuthority: (authority: AgentGatewayWriteAuthority) => boolean;
  /**
   * Permanently retire this credential's authority for one terminal turn.
   *
   * A provider-session bearer may authenticate read-only MCP traffic for the
   * rest of its runtime, but it can never acquire write authority for a later
   * turn after this transition.
   */
  readonly retireWriteAuthority: (token: string, turnId: string) => boolean;
  readonly revoke: (token: string) => void;
  /**
   * Live sessions for one thread whose write authority was already retired.
   * A session stays listed here until its token is revoked, so callers can
   * distinguish "credential retired, rotation pending" from a healthy bearer.
   */
  readonly listRetiredWriteAuthorities: (
    threadId: string,
  ) => ReadonlyArray<AgentGatewayRetiredWriteAuthority>;
  readonly setComputerControlEnabled?: (threadId: string, enabled: boolean) => void;
  readonly computerControlProvisioned?: (threadId: string, provider: ProviderKind) => boolean;
}

export class AgentGatewaySessionRegistry extends ServiceMap.Service<
  AgentGatewaySessionRegistry,
  AgentGatewaySessionRegistryShape
>()("synara/agentGateway/Services/AgentGatewaySessionRegistry") {}
