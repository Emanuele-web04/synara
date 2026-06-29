import type { OrchestrationEvent } from "@t3tools/contracts";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { PROJECT_METADATA_SNAPSHOT_PROJECTORS } from "../projectMetadataProjection.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadShellSummaries: "projection.thread-shell-summaries",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadProviderItems: "projection.thread-provider-items",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
  threadRuntime: "projection.thread-runtime",
} as const;

export type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

export interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

export interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly phase: "hot" | "deferred";
  readonly shouldApply?: (event: OrchestrationEvent) => boolean;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export const REQUIRED_SNAPSHOT_PROJECTORS = PROJECT_METADATA_SNAPSHOT_PROJECTORS;

export const THREAD_SHELL_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);
