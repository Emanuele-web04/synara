import type {
  AuthAccessProfile,
  AuthClientMetadata,
  AuthClientSession,
  AuthSessionId,
  ServerAuthSessionMethod,
} from "@synara/contracts";
import { Data, DateTime, Duration, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export type SessionRole = "owner" | "client";

export interface IssuedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.DateTime;
  readonly role: SessionRole;
  readonly accessProfile: AuthAccessProfile;
}

export interface VerifiedSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly expiresAt?: DateTime.DateTime;
  readonly subject: string;
  readonly role: SessionRole;
  readonly accessProfile: AuthAccessProfile;
}

export type SessionCredentialChange =
  | {
      readonly type: "clientUpserted";
      readonly clientSession: AuthClientSession;
    }
  | {
      readonly type: "clientRemoved";
      readonly sessionId: AuthSessionId;
    };

export class SessionCredentialError extends Data.TaggedError("SessionCredentialError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class SessionCapacityError extends Data.TaggedError("SessionCapacityError")<{
  readonly message: string;
  readonly scope: "connections" | "websocket-tickets";
  readonly limit: number;
  readonly active: number;
  readonly retryAfterSeconds: number;
}> {}

export interface SessionCredentialServiceShape {
  readonly cookieName: string;
  readonly issue: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly method?: ServerAuthSessionMethod;
    readonly role?: SessionRole;
    readonly accessProfile?: AuthAccessProfile;
    readonly client?: AuthClientMetadata;
  }) => Effect.Effect<IssuedSession, SessionCredentialError>;
  readonly verify: (token: string) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly issueWebSocketToken: (
    sessionId: AuthSessionId,
    input?: { readonly ttl?: Duration.Duration },
  ) => Effect.Effect<
    { readonly token: string; readonly expiresAt: DateTime.DateTime },
    SessionCredentialError | SessionCapacityError
  >;
  readonly verifyWebSocketToken: (
    token: string,
  ) => Effect.Effect<VerifiedSession, SessionCredentialError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    SessionCredentialError
  >;
  readonly streamChanges: Stream.Stream<SessionCredentialChange>;
  readonly revoke: (sessionId: AuthSessionId) => Effect.Effect<boolean, SessionCredentialError>;
  readonly revokeAllExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, SessionCredentialError>;
  readonly updateClientLabel: (
    sessionId: AuthSessionId,
    clientLabel: string,
  ) => Effect.Effect<AuthClientSession, SessionCredentialError>;
  readonly runAuthenticatedConnection: <A, E, R>(
    sessionId: AuthSessionId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | SessionCredentialError | SessionCapacityError, R>;
}

export class SessionCredentialService extends ServiceMap.Service<
  SessionCredentialService,
  SessionCredentialServiceShape
>()("synara/auth/Services/SessionCredentialService") {}
