import { Deferred, Effect } from "effect";

import type { RemoteSessionRegistry } from "../remoteSessions/sessionRegistry";
import type { ServerConfigShape } from "../config";
import { isLoopbackHost } from "../startupAccess";
import { AuthError, type AuthenticatedSession } from "./Services/ServerAuth";

/** The current private startup secret is positive local proof; a missing token is not. */
export function isTrustedLocalServerToken(
  config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl">,
  token: string | null | undefined,
): boolean {
  return (
    Boolean(config.authToken?.trim()) &&
    token === config.authToken &&
    isLoopbackHost(config.host) &&
    config.publicUrl === undefined
  );
}

/**
 * Answers with the current billing policy. An idle host refreshes that policy
 * first, but only when the policy can change this answer, so requests it
 * cannot affect never wait on the account service.
 */
export function decideWithBillingPolicy<A extends boolean | string>(
  registry: RemoteSessionRegistry,
  decide: (remoteBillingEnforced: boolean) => A,
): Effect.Effect<A> {
  if (decide(true) === decide(false))
    return Effect.sync(() => decide(registry.remoteBillingEnforced));
  return Effect.promise(() => registry.prepareBillingPolicy()).pipe(
    Effect.map(() => decide(registry.remoteBillingEnforced)),
  );
}

/** A verified session is local only when its trusted issuance recorded that fact. */
export function requireRemoteSessionAdmission<A extends Pick<AuthenticatedSession, "accessOrigin">>(
  registry: RemoteSessionRegistry,
  session: A,
): Effect.Effect<A, AuthError> {
  if (session.accessOrigin === "local") return Effect.succeed(session);
  return Effect.promise(() => registry.prepareRemoteAdmission()).pipe(
    Effect.flatMap(() =>
      registry.canAdmitRemoteSession()
        ? Effect.succeed(session)
        : Effect.fail(new AuthError({ message: "Remote authorization unavailable.", status: 503 })),
    ),
  );
}

/** Pause a remote stream on lease loss without retiring its durable credential or device trust. */
export function runWithRemoteAdmission<A, E, R>(
  registry: RemoteSessionRegistry,
  session: Pick<AuthenticatedSession, "accessOrigin">,
  connection: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | AuthError, R> {
  if (session.accessOrigin === "local") return connection;
  return Effect.scoped(
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      yield* Effect.promise(() => registry.prepareRemoteAdmission());
      const release = registry.registerLegacyConnection(() =>
        Effect.runSync(Deferred.succeed(closed, undefined)),
      );
      if (!release)
        return yield* new AuthError({ message: "Remote authorization unavailable.", status: 503 });
      yield* Effect.addFinalizer(() => Effect.sync(release));
      return yield* connection.pipe(
        Effect.raceFirst(Deferred.await(closed).pipe(Effect.andThen(Effect.interrupt))),
      );
    }),
  );
}
