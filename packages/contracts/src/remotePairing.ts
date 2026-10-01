import { Schema } from "effect";
import { boundedTrimmedNonEmptyString, EnvironmentId, IsoDateTime } from "./baseSchemas";
import { DevicePublicKeyJwk } from "./hostAuth";

export const RemoteTrustScope = Schema.Struct({
  environmentId: EnvironmentId,
  rootFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  accountAuthority: boundedTrimmedNonEmptyString(2048),
  userId: boundedTrimmedNonEmptyString(256),
  organizationId: boundedTrimmedNonEmptyString(256),
});
export type RemoteTrustScope = typeof RemoteTrustScope.Type;

export const RemotePairingBundle = Schema.Struct({
  v: Schema.Literal(2),
  ...RemoteTrustScope.fields,
  channel: Schema.Literals(["stable", "beta", "canary", "dev"]),
  rootCertificate: boundedTrimmedNonEmptyString(8192),
  hostId: boundedTrimmedNonEmptyString(256),
  label: boundedTrimmedNonEmptyString(128),
  inviteId: Schema.String.check(Schema.isUUID(4)),
  secret: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/)),
  expiresAt: IsoDateTime,
});
export type RemotePairingBundle = typeof RemotePairingBundle.Type;

export const RemotePairingDevice = Schema.Struct({
  deviceJkt: boundedTrimmedNonEmptyString(128),
  publicKey: DevicePublicKeyJwk,
  label: boundedTrimmedNonEmptyString(128),
});
export type RemotePairingDevice = typeof RemotePairingDevice.Type;

export const RemotePairingStatus = Schema.Struct({
  inviteId: Schema.String,
  expiresAt: IsoDateTime,
  pendingDevice: Schema.NullOr(RemotePairingDevice),
  approved: Schema.Boolean,
  revoked: Schema.Boolean,
});
export type RemotePairingStatus = typeof RemotePairingStatus.Type;

export const RemoteTrustedDevice = Schema.Struct({
  ...RemotePairingDevice.fields,
  generation: Schema.Int.check(Schema.isGreaterThan(0)),
  approvedAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type RemoteTrustedDevice = typeof RemoteTrustedDevice.Type;

export const RemoteAccessRequest = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("revoke-account-sessions"),
    deviceId: Schema.String.check(Schema.isUUID(undefined)),
  }),
  Schema.Struct({ operation: Schema.Literal("device-info") }),
  Schema.Struct({ operation: Schema.Literal("reset-identity"), environmentId: EnvironmentId }),
  Schema.Struct({ operation: Schema.Literal("create-invitation") }),
  Schema.Struct({ operation: Schema.Literal("create-code") }),
  Schema.Struct({
    operation: Schema.Literal("redeem-code"),
    code: boundedTrimmedNonEmptyString(32),
  }),
  Schema.Struct({
    operation: Schema.Literal("confirm-code"),
    inviteId: Schema.String,
    rootFingerprint: Schema.String,
  }),
  Schema.Struct({ operation: Schema.Literal("list") }),
  Schema.Struct({
    operation: Schema.Literal("approve"),
    inviteId: Schema.String,
    deviceJkt: boundedTrimmedNonEmptyString(128),
  }),
  Schema.Struct({ operation: Schema.Literal("cancel-invitation"), inviteId: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("revoke-device"),
    deviceJkt: boundedTrimmedNonEmptyString(128),
  }),
  Schema.Struct({ operation: Schema.Literal("pair"), bundle: RemotePairingBundle }),
  Schema.Struct({ operation: Schema.Literal("forget-host"), environmentId: EnvironmentId }),
]);
export type RemoteAccessRequest = typeof RemoteAccessRequest.Type;
export const RemoteAccessInput = Schema.Struct({ request: RemoteAccessRequest });

export const RemoteAccessResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pairing-code"),
    code: Schema.String,
    inviteId: Schema.String,
    expiresAt: IsoDateTime,
    rootFingerprint: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("pairing-preview"),
    inviteId: Schema.String,
    environmentId: EnvironmentId,
    label: Schema.String,
    rootFingerprint: Schema.String,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    kind: Schema.Literal("account-sessions-revoked"),
    confirmed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    kind: Schema.Literal("device-info"),
    deviceJkt: boundedTrimmedNonEmptyString(128),
    label: boundedTrimmedNonEmptyString(128),
  }),
  Schema.Struct({ kind: Schema.Literal("invitation"), bundle: RemotePairingBundle }),
  Schema.Struct({
    kind: Schema.Literal("host-state"),
    invitations: Schema.Array(RemotePairingStatus),
    devices: Schema.Array(RemoteTrustedDevice),
    rootFingerprint: Schema.optional(Schema.String),
    rootExpiresAt: Schema.NullOr(IsoDateTime),
    rootNeedsRepair: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("paired"),
    environmentId: EnvironmentId,
    hostId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("done") }),
]);
export type RemoteAccessResult = typeof RemoteAccessResult.Type;

/** Rendezvous only: the short code is not the host invitation secret. */
export const RemotePairingCode = Schema.String.check(
  Schema.isPattern(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
);
export const RemotePairingCodeResult = Schema.Struct({
  code: RemotePairingCode,
  inviteId: Schema.String,
  expiresAt: IsoDateTime,
});
export const RedeemRemotePairingCode = Schema.Struct({
  code: RemotePairingCode,
  deviceJkt: boundedTrimmedNonEmptyString(128),
  proof: boundedTrimmedNonEmptyString(4096),
});
