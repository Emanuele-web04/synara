import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
  type AgentGatewayWriteAuthority,
} from "../Services/AgentGatewaySessionRegistry.ts";

const PROVIDER_SESSION_CAPABILITIES = [
  "thread:read",
  "thread:write",
  "automation:write",
  "diagnostics:read",
  "browser:control",
  "device:control",
] as const;

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  interface RegisteredSession {
    readonly identity: AgentGatewaySessionIdentity;
    retiredWriteTurnId: string | undefined;
  }
  const sessions = new Map<string, RegisteredSession>();
  const sessionsByKey = new Map<string, RegisteredSession>();

  return {
    issue: (threadId, provider) => {
      // every runtime owns an independent credential — reusing a token would let old-session cleanup invalidate its replacement
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        capabilities: new Set(PROVIDER_SESSION_CAPABILITIES),
      };
      const registered: RegisteredSession = {
        identity,
        retiredWriteTurnId: undefined,
      };
      sessions.set(token, registered);
      sessionsByKey.set(sessionKey, registered);
      return { token, ...identity };
    },
    verify: (token) => sessions.get(token)?.identity ?? null,
    bindWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered || registered.retiredWriteTurnId !== undefined) return null;
      const { identity } = registered;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const registered = sessionsByKey.get(authority.sessionKey);
      const identity = registered?.identity;
      return (
        identity !== undefined &&
        registered?.retiredWriteTurnId === undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider
      );
    },
    retireWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered) return false;
      if (registered.retiredWriteTurnId !== undefined) {
        return registered.retiredWriteTurnId === turnId;
      }
      // record A even if it never called a tool — a detached request from A must not arrive during B and bind the credential
      registered.retiredWriteTurnId = turnId;
      return true;
    },
    revoke: (token) => {
      const registered = sessions.get(token);
      if (!registered) return;
      sessions.delete(token);
      sessionsByKey.delete(registered.identity.sessionKey);
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
