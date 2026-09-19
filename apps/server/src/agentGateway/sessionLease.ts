import type { ProviderKind, ThreadId } from "@synara/contracts";
import { Effect, Exit } from "effect";

import type {
  AgentGatewayCredentialsShape,
  AgentGatewayMcpConnection,
} from "./Services/AgentGatewayCredentials.ts";
import type { AgentGatewayCapability } from "./Services/AgentGatewaySessionRegistry.ts";

export interface AgentGatewaySessionLeaseOptions {
  readonly additionalCapabilities?: readonly AgentGatewayCapability[];
}

/**
 * The session-start facts that decide what a gateway credential may do.
 *
 * Adapters never assemble capability lists. Every lease site hands the start
 * input it already has (or the subset it captured for a later re-lease) to
 * `acquireAgentGatewaySessionLease`, and this module derives the capabilities.
 *
 * What this guarantees, exactly: every capability fact is a *required* field,
 * enforced below by `NoOptionalCapabilityFacts`, and every field is listed in
 * `AGENT_GATEWAY_CAPABILITY_FACTS`, enforced by `EveryCapabilityFactIsListed`.
 * Adding a fact therefore fails to compile in three places at once — the keys
 * tuple, `AGENT_GATEWAY_NO_CAPABILITIES`, and every call site that builds a
 * capability input without it — instead of leasing a credential whose tools
 * are quietly missing. It does not (and cannot) stop a caller passing a
 * structurally wider object; it stops a caller passing an incomplete one.
 *
 * The interface is empty until a layer adds the first optional capability.
 */
export interface AgentGatewayCapabilityInput {}

/**
 * Every field of `AgentGatewayCapabilityInput`, as a tuple, so the derivation
 * and the capture projection can be checked against one list.
 */
export const AGENT_GATEWAY_CAPABILITY_FACTS =
  [] as const satisfies readonly (keyof AgentGatewayCapabilityInput)[];

type AssertNever<Key extends never> = Key;
/** Fails to compile when a field is added without listing it above. */
export type EveryCapabilityFactIsListed = AssertNever<
  Exclude<keyof AgentGatewayCapabilityInput, (typeof AGENT_GATEWAY_CAPABILITY_FACTS)[number]>
>;
/**
 * Fails to compile when a field is optional. An optional fact is exactly the
 * silent omission this module exists to prevent: call sites keep compiling
 * while the capability is never requested.
 */
export type NoOptionalCapabilityFacts = AssertNever<
  {
    [Key in keyof AgentGatewayCapabilityInput]-?: Record<string, never> extends Pick<
      AgentGatewayCapabilityInput,
      Key
    >
      ? Key
      : never;
  }[keyof AgentGatewayCapabilityInput]
>;

/** Lease no optional capabilities. Spelled out so an omission reads as a choice. */
export const AGENT_GATEWAY_NO_CAPABILITIES: AgentGatewayCapabilityInput = {};

/** The single derivation from session-start facts to gateway capabilities. */
export function agentGatewayCapabilitiesFor(
  input: AgentGatewayCapabilityInput,
): readonly AgentGatewayCapability[] {
  void input;
  return [];
}

export function agentGatewaySessionLeaseOptionsFor(
  input: AgentGatewayCapabilityInput,
): AgentGatewaySessionLeaseOptions | undefined {
  const additionalCapabilities = agentGatewayCapabilitiesFor(input);
  return additionalCapabilities.length === 0 ? undefined : { additionalCapabilities };
}

/**
 * Narrow a start input to the fields a later re-lease needs.
 *
 * Adapters that re-lease from a stored session context (Antigravity mints its
 * credential per turn; Pi rotates the credential when a turn completes) no
 * longer hold the start input by then. They keep this projection instead of a
 * hand-picked flag, so the set of capability facts stays defined in one place.
 */
export function captureAgentGatewayCapabilityInput(
  input: AgentGatewayCapabilityInput,
): AgentGatewayCapabilityInput {
  void input;
  return {};
}

type AgentGatewaySessionLeaseCredentials = Pick<
  AgentGatewayCredentialsShape,
  "connectionForThread" | "revokeSessionToken"
> &
  Partial<
    Pick<
      AgentGatewayCredentialsShape,
      "cancelSessionTurnRequests" | "issueStdioBootstrapToken" | "retireSessionTurn"
    >
  >;

export const AGENT_GATEWAY_CREDENTIAL_ROTATION_REQUIRED = "agentGatewayCredentialRotationRequired";
export const AGENT_GATEWAY_TURN_AUTHORITY_RETIRED = "synaraGatewayTurnAuthorityRetired";

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
  /** Mint a fresh one-shot proxy credential for a provider turn. */
  readonly issueStdioBootstrapToken?: () => string | null;
  readonly cancelTurn: (turnId: string) => Promise<void>;
  /**
   * Permanently retire write authority for a terminal turn while leaving the
   * provider runtime available to drain background work. The admission fence
   * is synchronous; the promise represents only request drainage.
   */
  readonly retireTurn: (turnId: string) => Promise<void>;
  readonly release: () => void;
}

const AGENT_GATEWAY_TURN_CANCELLATION_TIMEOUT = "2 seconds";

function awaitAgentGatewayTurnCancellation(
  turnId: string,
  cancellation: Promise<void>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => cancellation,
    catch: (cause) => cause,
  }).pipe(
    Effect.timeoutOrElse({
      duration: AGENT_GATEWAY_TURN_CANCELLATION_TIMEOUT,
      onTimeout: () =>
        Effect.logWarning("agent_gateway.turn_cancellation_timeout", {
          turnId,
          timeout: AGENT_GATEWAY_TURN_CANCELLATION_TIMEOUT,
        }),
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("agent_gateway.turn_cancellation_failed", { turnId, cause }),
    ),
    Effect.asVoid,
  );
}

function startAgentGatewayTurnCancellation(
  lease: AgentGatewaySessionLease,
  turnId: string,
): Effect.Effect<Promise<void>> {
  return Effect.try({
    try: () => lease.cancelTurn(turnId),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("agent_gateway.turn_cancellation_failed", { turnId, cause }).pipe(
        Effect.as(Promise.resolve()),
      ),
    ),
  );
}

/**
 * Tombstone one exact gateway turn and wait for every matching MCP request to
 * observe its AbortSignal. Cleanup failures are deliberately logged instead
 * of replacing the provider-native interrupt result.
 */
export function cancelAgentGatewayTurn(
  lease: AgentGatewaySessionLease | undefined,
  turnId: string | undefined,
): Effect.Effect<void> {
  if (lease === undefined || turnId === undefined) return Effect.void;

  return startAgentGatewayTurnCancellation(lease, turnId).pipe(
    Effect.flatMap((cancellation) => awaitAgentGatewayTurnCancellation(turnId, cancellation)),
  );
}

/**
 * Run the provider-native stop and gateway stop concurrently, but do not let
 * an early provider failure interrupt the gateway cleanup. The caller gets the
 * original provider result only after the gateway cancellation barrier settles.
 */
export function withAgentGatewayTurnCancellation<A, E, R>(
  lease: AgentGatewaySessionLease | undefined,
  turnId: string | undefined,
  providerInterrupt: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  if (lease === undefined) return providerInterrupt;

  return Effect.gen(function* () {
    // Tombstone synchronously before the provider side can release the lease;
    // the returned promise then drains concurrently with the native interrupt.
    const cancellation =
      turnId === undefined ? undefined : yield* startAgentGatewayTurnCancellation(lease, turnId);
    // The bearer is session-scoped and cannot prove whether a late MCP call
    // originated in this interrupted turn or a later one. Revoke it before
    // the native interrupt starts; ProviderService retires this runtime and
    // lazily resumes it with a fresh lease before the next main turn. A
    // background child may outlive its parent turn; without an exact turn id,
    // session revocation is still required and drains every in-flight request.
    const releaseExit = yield* Effect.exit(Effect.sync(lease.release));
    const [providerExit] = yield* Effect.all(
      [
        Effect.exit(providerInterrupt),
        turnId === undefined || cancellation === undefined
          ? Effect.void
          : awaitAgentGatewayTurnCancellation(turnId, cancellation),
      ] as const,
      { concurrency: "unbounded" },
    );
    if (Exit.isFailure(providerExit)) {
      return yield* Effect.failCause(providerExit.cause);
    }
    if (Exit.isFailure(releaseExit)) {
      return yield* Effect.failCause(releaseExit.cause);
    }
    return providerExit.value;
  });
}

/**
 * The capability input is a required parameter on purpose: a lease that
 * forgets it fails silently (the credential is issued, the tools are just
 * missing), so the type checker refuses the omission at every call site. The
 * completeness of the input itself is enforced by the assertions on
 * `AgentGatewayCapabilityInput`.
 */
export function acquireAgentGatewaySessionLease(
  credentials: AgentGatewaySessionLeaseCredentials | undefined,
  threadId: ThreadId,
  provider: ProviderKind,
  capabilityInput: AgentGatewayCapabilityInput,
): AgentGatewaySessionLease | undefined {
  if (credentials === undefined) return undefined;

  const options = agentGatewaySessionLeaseOptionsFor(capabilityInput);
  const connection =
    options === undefined
      ? credentials.connectionForThread(threadId, provider)
      : credentials.connectionForThread(threadId, provider, options);
  let released = false;

  return {
    connection,
    issueStdioBootstrapToken: () => {
      if (released) return null;
      return credentials.issueStdioBootstrapToken?.(connection.bearerToken) ?? null;
    },
    cancelTurn: (turnId) => {
      if (released) return Promise.resolve();
      return (
        credentials.cancelSessionTurnRequests?.(connection.bearerToken, turnId) ?? Promise.resolve()
      );
    },
    retireTurn: (turnId) => {
      if (released) return Promise.resolve();
      return (
        credentials.retireSessionTurn?.(connection.bearerToken, turnId) ??
        credentials.cancelSessionTurnRequests?.(connection.bearerToken, turnId) ??
        Promise.resolve()
      );
    },
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
