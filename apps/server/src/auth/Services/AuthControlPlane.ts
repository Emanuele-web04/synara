import type {
  AuthClientMetadata,
  AuthClientSession,
  AuthPairingLink,
  AuthSessionId,
  RemotePairingDevice,
  RemotePairingStatus,
  RemoteTrustScope,
} from "@synara/contracts";
import { Data, DateTime, Duration, Effect, ServiceMap } from "effect";
import type { SessionRole } from "./SessionCredentialService";

export const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

export interface IssuedPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly role: SessionRole;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
}

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-session-token";
  readonly role: SessionRole;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

export class AuthControlPlaneError extends Data.TaggedError("AuthControlPlaneError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AuthControlPlaneShape {
  readonly remotePairing: {
    readonly create: (
      scope: RemoteTrustScope,
    ) => Effect.Effect<
      { inviteId: string; secret: string; expiresAt: string },
      AuthControlPlaneError
    >;
    readonly verifyInvitation: (
      scope: RemoteTrustScope,
      inviteId: string,
      secret: string,
    ) => Effect.Effect<RemotePairingStatus, AuthControlPlaneError>;
    readonly requestApproval: (
      scope: RemoteTrustScope,
      inviteId: string,
      device: RemotePairingDevice,
    ) => Effect.Effect<boolean, AuthControlPlaneError>;
    readonly approve: (
      scope: RemoteTrustScope,
      inviteId: string,
      exactDeviceJkt: string,
    ) => Effect.Effect<boolean, AuthControlPlaneError>;
    readonly list: (
      scope: RemoteTrustScope,
    ) => Effect.Effect<readonly RemotePairingStatus[], AuthControlPlaneError>;
    readonly revoke: (
      scope: RemoteTrustScope,
      inviteId: string,
    ) => Effect.Effect<void, AuthControlPlaneError>;
  };
  readonly createPairingLink: (input?: {
    readonly ttl?: Duration.Duration;
    readonly label?: string;
    readonly role?: SessionRole;
    readonly subject?: string;
  }) => Effect.Effect<IssuedPairingLink, AuthControlPlaneError>;
  readonly listPairingLinks: (input?: {
    readonly role?: SessionRole;
    readonly excludeSubjects?: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<AuthPairingLink>, AuthControlPlaneError>;
  readonly revokePairingLink: (id: string) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly issueSession: (input?: {
    readonly ttl?: Duration.Duration;
    readonly subject?: string;
    readonly role?: SessionRole;
    readonly label?: string;
  }) => Effect.Effect<IssuedBearerSession, AuthControlPlaneError>;
  readonly listSessions: () => Effect.Effect<
    ReadonlyArray<AuthClientSession>,
    AuthControlPlaneError
  >;
  readonly revokeSession: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<boolean, AuthControlPlaneError>;
  readonly revokeOtherSessionsExcept: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<number, AuthControlPlaneError>;
}

export class AuthControlPlane extends ServiceMap.Service<AuthControlPlane, AuthControlPlaneShape>()(
  "synara/auth/Services/AuthControlPlane",
) {}
