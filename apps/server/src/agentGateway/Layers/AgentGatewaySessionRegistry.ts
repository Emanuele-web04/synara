import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
} from "../Services/AgentGatewaySessionRegistry.ts";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000;

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const randomId = options?.randomId ?? randomUUID;
  const sessions = new Map<string, AgentGatewaySessionIdentity>();

  return {
    issue: (threadId, provider) => {
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
        capabilities: new Set(["thread:read", "thread:write", "automation:write"]),
      };
      sessions.set(token, identity);
      return { token, ...identity };
    },
    verify: (token) => {
      const identity = sessions.get(token);
      if (!identity) return null;
      if (identity.expiresAt <= now()) {
        sessions.delete(token);
        return null;
      }
      return identity;
    },
    revoke: (token) => {
      sessions.delete(token);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
