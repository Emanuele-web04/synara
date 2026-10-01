import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AuthPairingLinkRepositoryError } from "../Errors";
import type { RemotePairingDevice, RemoteTrustScope } from "@synara/contracts";

export interface RemotePairingRecord {
  readonly id: string;
  readonly credentialHash: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly revokedAt: string | null;
  readonly pendingDevice: RemotePairingDevice | null;
}

export interface RemotePairingRepositoryShape {
  readonly create: (input: {
    id: string;
    credentialHash: string;
    scope: RemoteTrustScope;
    createdAt: string;
    expiresAt: string;
  }) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
  readonly get: (
    scope: RemoteTrustScope,
    id: string,
  ) => Effect.Effect<RemotePairingRecord | undefined, AuthPairingLinkRepositoryError>;
  readonly list: (
    scope: RemoteTrustScope,
  ) => Effect.Effect<readonly RemotePairingRecord[], AuthPairingLinkRepositoryError>;
  readonly requestApproval: (
    scope: RemoteTrustScope,
    id: string,
    device: RemotePairingDevice,
    now: string,
  ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
  readonly approve: (
    scope: RemoteTrustScope,
    id: string,
    exactDeviceJkt: string,
    now: string,
  ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
  readonly revoke: (
    scope: RemoteTrustScope,
    id: string,
    now: string,
  ) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
}

export const AuthPairingLinkRecord = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  role: Schema.Literals(["owner", "client"]),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  consumedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  revokedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
});
export type AuthPairingLinkRecord = typeof AuthPairingLinkRecord.Type;

export const CreateAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  credential: Schema.String,
  method: Schema.Literals(["desktop-bootstrap", "one-time-token"]),
  role: Schema.Literals(["owner", "client"]),
  subject: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateAuthPairingLinkInput = typeof CreateAuthPairingLinkInput.Type;

export const ConsumeAuthPairingLinkInput = Schema.Struct({
  credential: Schema.String,
  consumedAt: Schema.DateTimeUtcFromString,
  now: Schema.DateTimeUtcFromString,
});
export type ConsumeAuthPairingLinkInput = typeof ConsumeAuthPairingLinkInput.Type;

export const ListActiveAuthPairingLinksInput = Schema.Struct({
  now: Schema.DateTimeUtcFromString,
});
export type ListActiveAuthPairingLinksInput = typeof ListActiveAuthPairingLinksInput.Type;

export const RevokeAuthPairingLinkInput = Schema.Struct({
  id: Schema.String,
  revokedAt: Schema.DateTimeUtcFromString,
});
export type RevokeAuthPairingLinkInput = typeof RevokeAuthPairingLinkInput.Type;

export const GetAuthPairingLinkByCredentialInput = Schema.Struct({
  credential: Schema.String,
});
export type GetAuthPairingLinkByCredentialInput = typeof GetAuthPairingLinkByCredentialInput.Type;

export interface AuthPairingLinkRepositoryShape {
  readonly remote: RemotePairingRepositoryShape;
  readonly create: (
    input: CreateAuthPairingLinkInput,
  ) => Effect.Effect<void, AuthPairingLinkRepositoryError>;
  readonly consumeAvailable: (
    input: ConsumeAuthPairingLinkInput,
  ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
  readonly listActive: (
    input: ListActiveAuthPairingLinksInput,
  ) => Effect.Effect<ReadonlyArray<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
  readonly revoke: (
    input: RevokeAuthPairingLinkInput,
  ) => Effect.Effect<boolean, AuthPairingLinkRepositoryError>;
  readonly getByCredential: (
    input: GetAuthPairingLinkByCredentialInput,
  ) => Effect.Effect<Option.Option<AuthPairingLinkRecord>, AuthPairingLinkRepositoryError>;
}

export class AuthPairingLinkRepository extends ServiceMap.Service<
  AuthPairingLinkRepository,
  AuthPairingLinkRepositoryShape
>()("synara/persistence/Services/AuthPairingLinks/AuthPairingLinkRepository") {}
