import { Schema, SchemaIssue } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * External provider history contracts.
 *
 * Schema-only descriptors for importing and synchronizing conversations that a
 * provider keeps outside Synara (Devin CLI/Desktop/Cloud, export files). These
 * types are the wire/persistence vocabulary shared by history sources, the
 * importer, and the UI — they carry no orchestration logic.
 */

// ===============================
// Source kinds and capabilities
// ===============================

export const ExternalHistorySourceKind = Schema.Literals([
  "devin-local",
  "devin-cloud",
  "devin-atif",
]);
export type ExternalHistorySourceKind = typeof ExternalHistorySourceKind.Type;

/**
 * What a configured source can actually do, verified by inspecting the real
 * store/API rather than assumed from documentation. `unsupportedReasons` maps a
 * capability flag name ("canList", "canReadHistory", ...) to a human-readable
 * reason when that capability is absent.
 */
export const ExternalHistoryCapabilities = Schema.Struct({
  canList: Schema.Boolean,
  canReadHistory: Schema.Boolean,
  canResumeNative: Schema.Boolean,
  canSyncNew: Schema.Boolean,
  canSyncChanges: Schema.Boolean,
  canReadWhileBusy: Schema.Boolean,
  unsupportedReasons: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type ExternalHistoryCapabilities = typeof ExternalHistoryCapabilities.Type;

/**
 * Where imported threads land. `inboxFallback` sends unmatched sessions to the
 * non-executing Devin imports inbox instead of an arbitrary local directory.
 */
export const ExternalHistoryTargetRules = Schema.Struct({
  projectPath: Schema.optional(TrimmedNonEmptyString),
  repository: Schema.optional(TrimmedNonEmptyString),
  inboxFallback: Schema.Boolean,
});
export type ExternalHistoryTargetRules = typeof ExternalHistoryTargetRules.Type;

/**
 * A configured external history source. `scopeIdentity` is the verified store
 * identity (local: stable host+store id; cloud: normalized API origin+org) and
 * never a credential fingerprint — credentials rotate.
 */
export const ExternalHistorySourceDescriptor = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  kind: ExternalHistorySourceKind,
  scopeIdentity: TrimmedNonEmptyString,
  capabilities: ExternalHistoryCapabilities,
  versionEvidence: Schema.optional(TrimmedNonEmptyString),
  targetRules: Schema.optional(ExternalHistoryTargetRules),
  enabled: Schema.Boolean,
  paused: Schema.Boolean,
  lastDiscoverySuccessAt: Schema.optional(IsoDateTime),
  lastErrorCode: Schema.optional(Schema.String),
});
export type ExternalHistorySourceDescriptor = typeof ExternalHistorySourceDescriptor.Type;

// ===============================
// Normalized sessions and messages
// ===============================

/**
 * One external session as listed by a source, before history is read.
 * Source identifiers stay separate from Synara ids.
 */
export const ExternalHistorySessionDescriptor = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  externalSessionId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  sourceOrigin: Schema.optional(TrimmedNonEmptyString),
  originalCreatedAt: Schema.optional(IsoDateTime),
  originalUpdatedAt: Schema.optional(IsoDateTime),
  workspaceHint: Schema.optional(TrimmedNonEmptyString),
  repositoryHints: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  sourceUrl: Schema.optional(TrimmedNonEmptyString),
  rawStatus: Schema.optional(Schema.String),
  rawStatusDetail: Schema.optional(Schema.String),
});
export type ExternalHistorySessionDescriptor = typeof ExternalHistorySessionDescriptor.Type;

/** Provenance of a timestamp that had to be synthesized or repaired. */
export const ExternalHistoryTimestampProvenance = Schema.Literals([
  "source",
  "fallback-deterministic",
]);
export type ExternalHistoryTimestampProvenance = typeof ExternalHistoryTimestampProvenance.Type;

/**
 * One historical message. `upstreamMessageId` is the stable source identity
 * (Cloud `event_id`, Devin `message_id`); `sourceOrder` is the deterministic
 * order within the session independent of ingestion sequence.
 */
export const ExternalHistoryMessage = Schema.Struct({
  upstreamMessageId: TrimmedNonEmptyString,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  originalTimestamp: Schema.optional(IsoDateTime),
  timestampProvenance: Schema.optional(ExternalHistoryTimestampProvenance),
  sourceOrder: NonNegativeInt,
  contentHash: Schema.optional(Schema.String),
  sourceRevision: Schema.optional(Schema.String),
});
export type ExternalHistoryMessage = typeof ExternalHistoryMessage.Type;

// ===============================
// Lifecycle states
// ===============================

/** Per-transcript import lifecycle for one external link. */
export const ExternalHistoryLinkStatus = Schema.Literals([
  "pending",
  "reading",
  "staged",
  "applying",
  "complete",
  "partial",
  "unavailable",
  "suppressed",
]);
export type ExternalHistoryLinkStatus = typeof ExternalHistoryLinkStatus.Type;

/** Per-source discovery/import job lifecycle. */
export const ExternalHistoryJobStatus = Schema.Literals([
  "queued",
  "discovering",
  "importing",
  "complete",
  "paused",
  "retryable-error",
  "blocked-auth",
  "cancelled",
]);
export type ExternalHistoryJobStatus = typeof ExternalHistoryJobStatus.Type;

/** Immutable normalized batch lifecycle inside a job. */
export const ExternalHistoryBatchState = Schema.Literals([
  "persisted",
  "dispatched",
  "accepted",
  "failed",
]);
export type ExternalHistoryBatchState = typeof ExternalHistoryBatchState.Type;

// ===============================
// Source operations
// ===============================

export const ExternalHistoryListSessionsInput = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  scope: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(NonNegativeInt),
});
export type ExternalHistoryListSessionsInput = typeof ExternalHistoryListSessionsInput.Type;

export const ExternalHistoryListSessionsResult = Schema.Struct({
  sessions: Schema.Array(ExternalHistorySessionDescriptor),
  nextCursor: Schema.optional(Schema.String),
  complete: Schema.Boolean,
});
export type ExternalHistoryListSessionsResult = typeof ExternalHistoryListSessionsResult.Type;

export const ExternalHistoryReadHistoryInput = Schema.Struct({
  sourceId: TrimmedNonEmptyString,
  externalSessionId: TrimmedNonEmptyString,
  cursor: Schema.optional(Schema.String),
});
export type ExternalHistoryReadHistoryInput = typeof ExternalHistoryReadHistoryInput.Type;

export const ExternalHistoryReadHistoryResult = Schema.Struct({
  messages: Schema.Array(ExternalHistoryMessage),
  nextCursor: Schema.optional(Schema.String),
  sourceRevision: Schema.optional(Schema.String),
  complete: Schema.Boolean,
});
export type ExternalHistoryReadHistoryResult = typeof ExternalHistoryReadHistoryResult.Type;

// ===============================
// Typed errors
// ===============================

/**
 * Failures surfaced by external history sources and the importer.
 * `retryable` distinguishes transient (network, busy lock) from terminal
 * (unsupported version, auth) failures; callers must not retry terminal errors.
 */
export class ProviderHistoryError extends Schema.TaggedErrorClass<ProviderHistoryError>()(
  "ProviderHistoryError",
  {
    operation: Schema.String,
    code: Schema.Literals([
      "not-configured",
      "unsupported-version",
      "unsupported-capability",
      "auth-failed",
      "busy",
      "not-found",
      "read-failed",
      "rate-limited",
      "payload-too-large",
      "conflict",
    ]),
    detail: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `[${this.code}] ${this.operation}: ${this.detail}`;
  }

  static formatIssue(operation: string, error: Schema.SchemaError): ProviderHistoryError {
    return new ProviderHistoryError({
      operation,
      code: "read-failed",
      detail: SchemaIssue.makeFormatterDefault()(error.issue),
      retryable: false,
      cause: error,
    });
  }
}

// ===============================
// Source discovery and import RPCs
// ===============================

export const ExternalHistoryListSourcesInput = Schema.Struct({});
export type ExternalHistoryListSourcesInput = typeof ExternalHistoryListSourcesInput.Type;

export const ExternalHistoryListSourcesResult = Schema.Struct({
  sources: Schema.Array(ExternalHistorySourceDescriptor),
});
export type ExternalHistoryListSourcesResult = typeof ExternalHistoryListSourcesResult.Type;

/** Counts the normalizer reports for one imported transcript. */
export const ExternalHistoryImportFidelity = Schema.Struct({
  readCount: NonNegativeInt,
  includedCount: NonNegativeInt,
  droppedSystem: NonNegativeInt,
  droppedTool: NonNegativeInt,
  droppedHiddenUser: NonNegativeInt,
  droppedEmpty: NonNegativeInt,
  droppedDuplicate: NonNegativeInt,
});
export type ExternalHistoryImportFidelity = typeof ExternalHistoryImportFidelity.Type;

/**
 * The import RPC payloads live in orchestration.ts beside `ModelSelection`;
 * keeping them there avoids a schema-level import cycle.
 */

export const ExternalHistoryImportResult = Schema.Struct({
  linkId: TrimmedNonEmptyString,
  threadId: ThreadId,
  /** Messages that were already staged when this call started (re-import dedup). */
  alreadyStagedCount: NonNegativeInt,
  importedCount: NonNegativeInt,
  fidelity: ExternalHistoryImportFidelity,
});
export type ExternalHistoryImportResult = typeof ExternalHistoryImportResult.Type;
