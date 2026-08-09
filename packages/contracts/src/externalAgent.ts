import { Schema } from "effect";
import {
  AgentProfileId,
  AgentProfileRevisionId,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "./baseSchemas";

/**
 * External agent connector kinds.
 *
 * Initial support is ACP. Future connector kinds (for example a generic
 * declarative CLI) extend this literal list additively; the launch metadata is
 * connector-shaped so new kinds stay backward-compatible with stored profiles.
 */
export const ConnectorKind = Schema.Literals(["acp"]);
export type ConnectorKind = typeof ConnectorKind.Type;

/**
 * A named credential the profile needs at launch time. A profile stores the
 * reference (name plus destination environment key) and never the secret
 * value; the value lives in the server secret store under a profile-scoped
 * name and is resolved when a session starts.
 */
export const AgentProfileCredentialRef = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  envKey: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  required: Schema.optional(Schema.Boolean),
});
export type AgentProfileCredentialRef = typeof AgentProfileCredentialRef.Type;

const LaunchCommand = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const LaunchArgument = Schema.String.check(Schema.isMaxLength(4096));

const AgentProfileCommandLaunch = Schema.Struct({
  kind: Schema.Literal("command"),
  command: LaunchCommand,
  args: Schema.optional(Schema.Array(LaunchArgument).pipe(Schema.withDecodingDefault(() => []))),
  cwd: Schema.optional(LaunchCommand),
  envRefs: Schema.optional(
    Schema.Array(AgentProfileCredentialRef).pipe(Schema.withDecodingDefault(() => [])),
  ),
});

const AgentProfileEndpointLaunch = Schema.Struct({
  kind: Schema.Literal("endpoint"),
  endpoint: LaunchCommand,
});

/**
 * Exact launch/configuration metadata for one revision: either a resolved
 * executable command (argv plus credential env references) or a remote
 * endpoint. Never raw secrets.
 */
export const AgentProfileLaunch = Schema.Union([
  AgentProfileCommandLaunch,
  AgentProfileEndpointLaunch,
]);
export type AgentProfileLaunch = typeof AgentProfileLaunch.Type;

export const AgentProfileProvenance = Schema.Struct({
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  version: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type AgentProfileProvenance = typeof AgentProfileProvenance.Type;

/**
 * One immutable revision of an external agent profile.
 *
 * The revisionId is derived from the normalized content hash, so identical
 * normalized revisions dedupe to the same revision. Edits insert a new
 * revision and repoint the profile currentRevisionId; historical revisions
 * are never mutated.
 */
export const AgentProfileRevision = Schema.Struct({
  revisionId: AgentProfileRevisionId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  connectorKind: ConnectorKind,
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(
    Schema.Array(AgentProfileCredentialRef).pipe(Schema.withDecodingDefault(() => [])),
  ),
  provenance: AgentProfileProvenance,
  parentRevisionId: Schema.optional(AgentProfileRevisionId),
  createdAt: IsoDateTime,
});
export type AgentProfileRevision = typeof AgentProfileRevision.Type;

export const AgentProfileStatus = Schema.Literals(["active", "tombstoned"]);
export type AgentProfileStatus = typeof AgentProfileStatus.Type;

/**
 * A user-configured external agent connection identified by a stable opaque
 * AgentProfileId. Removal is tombstoning: the row stays so historical threads
 * can still resolve their referenced revision, but new sessions are refused.
 */
export const AgentProfile = Schema.Struct({
  profileId: AgentProfileId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  currentRevisionId: AgentProfileRevisionId,
  status: AgentProfileStatus.pipe(Schema.withDecodingDefault(() => "active")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentProfile = typeof AgentProfile.Type;

// RPC input/result types -------------------------------------------------

export const ExternalAgentProfileListResult = Schema.Struct({
  profiles: Schema.Array(AgentProfile),
});
export type ExternalAgentProfileListResult = typeof ExternalAgentProfileListResult.Type;

export const ExternalAgentProfileGetInput = Schema.Struct({
  profileId: AgentProfileId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileGetInput = typeof ExternalAgentProfileGetInput.Type;

export const ExternalAgentProfileGetResult = Schema.Struct({
  profile: AgentProfile,
  currentRevision: AgentProfileRevision,
  revisions: Schema.Array(AgentProfileRevision),
});
export type ExternalAgentProfileGetResult = typeof ExternalAgentProfileGetResult.Type;

export const ExternalAgentProfileCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  connectorKind: ConnectorKind,
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(Schema.Array(AgentProfileCredentialRef)),
  provenance: Schema.optional(AgentProfileProvenance),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileCreateInput = typeof ExternalAgentProfileCreateInput.Type;

export const ExternalAgentProfileCreateResult = Schema.Struct({
  profile: AgentProfile,
  revision: AgentProfileRevision,
  reused: Schema.Boolean,
});
export type ExternalAgentProfileCreateResult = typeof ExternalAgentProfileCreateResult.Type;

export const ExternalAgentProfileUpdateInput = Schema.Struct({
  profileId: AgentProfileId,
  displayName: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  launch: AgentProfileLaunch,
  credentialRefs: Schema.optional(Schema.Array(AgentProfileCredentialRef)),
  provenance: Schema.optional(AgentProfileProvenance),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileUpdateInput = typeof ExternalAgentProfileUpdateInput.Type;

export const ExternalAgentProfileUpdateResult = Schema.Struct({
  profile: AgentProfile,
  revision: AgentProfileRevision,
  reused: Schema.Boolean,
});
export type ExternalAgentProfileUpdateResult = typeof ExternalAgentProfileUpdateResult.Type;

export const ExternalAgentProfileTombstoneInput = Schema.Struct({
  profileId: AgentProfileId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type ExternalAgentProfileTombstoneInput = typeof ExternalAgentProfileTombstoneInput.Type;

export const ExternalAgentProfileTombstoneResult = Schema.Struct({
  profile: AgentProfile,
});
export type ExternalAgentProfileTombstoneResult = typeof ExternalAgentProfileTombstoneResult.Type;
