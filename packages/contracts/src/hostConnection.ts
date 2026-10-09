// FILE: hostConnection.ts
// Purpose: The client-side view of an outbound session to another host — what
//          the shell opened, over which transport, and how a renderer reaches
//          it. Schema-only.
// Layer: contracts (schema-only)

import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * The transport the outbound session actually won (ADR 0007 preference
 * order). Mirrors `TransportKind` in @synara/shared/transportRace, which is
 * runtime code and cannot be imported here.
 */
export const HostConnectionTransport = Schema.Literals([
  "loopback",
  "lan",
  "tailscale",
  "ssh",
  "cloudflare",
  "relay",
]);
export type HostConnectionTransport = typeof HostConnectionTransport.Type;

/**
 * An open outbound session this shell holds to another host.
 *
 * `wsPath` is the local upgrade path a renderer connects to in order to be
 * bridged onto that session: the shell owns the device key and the minted
 * credential, so the renderer never handles either. Everything past the
 * handshake is the ordinary Synara WebSocket protocol, spoken to the remote
 * host as if it were local.
 */
export const HostConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "idle",
  "reconnecting",
  "needs-sign-in",
  "revoked",
  "incompatible",
  "stopped",
]);
export type HostConnectionState = typeof HostConnectionState.Type;

export const RemoteExecutionScope = Schema.Struct({
  environmentId: TrimmedNonEmptyString,
  accountAuthority: TrimmedNonEmptyString,
  userId: TrimmedNonEmptyString,
  organizationId: TrimmedNonEmptyString,
  channel: Schema.Literals(["stable", "beta", "canary", "dev"]),
});
export type RemoteExecutionScope = typeof RemoteExecutionScope.Type;

export const HostConnection = Schema.Struct({
  executionScope: Schema.optional(RemoteExecutionScope),
  state: Schema.optional(HostConnectionState),
  environmentId: Schema.optional(TrimmedNonEmptyString),
  hostId: TrimmedNonEmptyString,
  hostName: TrimmedNonEmptyString,
  transport: HostConnectionTransport,
  startedAt: IsoDateTime,
  /** When the minted session credential expires; the shell re-mints before then. */
  credentialExpiresAt: IsoDateTime,
  /** Local path a renderer upgrades on to reach this session. */
  wsPath: TrimmedNonEmptyString,
});
export type HostConnection = typeof HostConnection.Type;

export const HostsConnectInput = Schema.Struct({
  hostId: TrimmedNonEmptyString,
});
export type HostsConnectInput = typeof HostsConnectInput.Type;

export const HostsDisconnectInput = Schema.Struct({
  hostId: TrimmedNonEmptyString,
});
export type HostsDisconnectInput = typeof HostsDisconnectInput.Type;

export const DesiredHostConnection = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  state: Schema.optional(HostConnectionState),
  nextRetryAt: Schema.optional(IsoDateTime),
});
export type DesiredHostConnection = typeof DesiredHostConnection.Type;

/** Confirmed trust on this controller, including intentionally disconnected hosts. */
export const PairedHost = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
});
export type PairedHost = typeof PairedHost.Type;

export const ListHostConnectionsResponse = Schema.Struct({
  pairedHosts: Schema.optional(Schema.Array(PairedHost)),
  desiredHosts: Schema.optional(Schema.Array(DesiredHostConnection)),
  connections: Schema.Array(HostConnection),
});
export type ListHostConnectionsResponse = typeof ListHostConnectionsResponse.Type;
