import type { ProviderKind, ThreadId } from "@synara/contracts";
import { Effect } from "effect";

import type {
  AgentGatewayCredentialsShape,
  AgentGatewayMcpConnection,
} from "./Services/AgentGatewayCredentials.ts";

type AgentGatewaySessionLeaseCredentials = Pick<
  AgentGatewayCredentialsShape,
  "connectionForThread" | "revokeSessionToken"
>;

/**
 * One provider runtime's ownership of one gateway credential.
 *
 * Release is intentionally idempotent. Provider startup and teardown have
 * overlapping cleanup paths (scope finalizers, process exits, explicit stops,
 * and replacement sessions); whichever path wins revokes the credential once
 * and every later path becomes a no-op.
 */
export interface AgentGatewaySessionLease {
  readonly connection: AgentGatewayMcpConnection;
  readonly release: () => void;
}

export function acquireAgentGatewaySessionLease(
  credentials: AgentGatewaySessionLeaseCredentials | undefined,
  threadId: ThreadId,
  provider: ProviderKind,
): AgentGatewaySessionLease | undefined {
  if (credentials === undefined) return undefined;

  const connection = credentials.connectionForThread(threadId, provider);
  let released = false;

  return {
    connection,
    release: () => {
      if (released) return;
      released = true;
      credentials.revokeSessionToken(connection.bearerToken);
    },
  };
}

/**
 * Revoke a lease when a provider process exits even if its adapter receives no
 * final protocol event. The watcher is detached because adapter-owned scopes
 * are themselves closed by normal teardown; the idempotent lease reconciles
 * whichever signal (explicit stop or process exit) arrives first.
 */
export function startAgentGatewaySessionLeaseExitWatcher(
  lease: AgentGatewaySessionLease | undefined,
  awaitProviderExit: Effect.Effect<void>,
): Effect.Effect<void> {
  if (lease === undefined) return Effect.void;
  return awaitProviderExit.pipe(
    Effect.andThen(Effect.sync(lease.release)),
    Effect.forkDetach,
    Effect.asVoid,
  );
}

/** Guard provider startup awaits until the lease has an installed session owner. */
export function releaseAgentGatewaySessionLeaseOnInterrupt<A, E, R>(
  lease: AgentGatewaySessionLease | undefined,
  startup: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (lease === undefined) return startup;
  return startup.pipe(Effect.onInterrupt(() => Effect.sync(lease.release)));
}
