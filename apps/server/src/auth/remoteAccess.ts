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

/** A verified session is local only when its trusted issuance recorded that fact. */
export function requireRemoteSessionAdmission<A extends Pick<AuthenticatedSession, "accessOrigin">>(
  registry: RemoteSessionRegistry,
  session: A,
): Effect.Effect<A, AuthError> {
  return session.accessOrigin === "local" || registry.canAdmitRemoteSession()
    ? Effect.succeed(session)
    : Effect.fail(new AuthError({ message: "Remote authorization unavailable.", status: 503 }));
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
