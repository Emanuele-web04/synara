/**
 * ProjectionThreadSessionRepository - Repository interface for thread sessions.
 *
 * Owns persistence operations for projected provider-session linkage and
 * runtime status for each thread.
 *
 * @module ProjectionThreadSessionRepository
 */
import {
  RuntimeMode,
  IsoDateTime,
  OrchestrationSessionStatus,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  /** Durable last-runtime-activity timestamp of ANY kind (streamed output,
   * tool lifecycle, messages, requests) — fed throttled by provider ingestion.
   * Separate from `updatedAt`, which moves only on session lifecycle events. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  /** Durable last-PROGRESS timestamp: only work-producing events (agent
   * output, tool lifecycle, turn boundaries) — a steer/nudge echo does not
   * count, so the recovery ladder can't be cleared by its own nudge. */
  lastProgressAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});

export type ProjectionThreadSession = typeof ProjectionThreadSession.Type;

export const GetProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadSessionInput = typeof GetProjectionThreadSessionInput.Type;

export const DeleteProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSessionInput = typeof DeleteProjectionThreadSessionInput.Type;

export const TouchLastActivityInput = Schema.Struct({
  threadId: ThreadId,
  activityAt: IsoDateTime,
  /** When true the event produced real work and `lastProgressAt` advances
   * alongside `lastActivityAt`. */
  isProgress: Schema.optional(Schema.Boolean),
});
export type TouchLastActivityInput = typeof TouchLastActivityInput.Type;

export const MarkToolStartedInput = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  startedAt: IsoDateTime,
  startedEventId: Schema.String,
});
export type MarkToolStartedInput = typeof MarkToolStartedInput.Type;

export const MarkToolFinishedInput = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.String,
});
export type MarkToolFinishedInput = typeof MarkToolFinishedInput.Type;

export const ClearActiveToolsInput = Schema.Struct({
  threadId: ThreadId,
  /** When set, only rows for OTHER turns are removed (a new turn starting
   * clears stragglers from the previous one). Omit to drop every row. */
  exceptTurnId: Schema.optional(Schema.NullOr(TurnId)),
});
export type ClearActiveToolsInput = typeof ClearActiveToolsInput.Type;

export const GetToolInFlightInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetToolInFlightInput = typeof GetToolInFlightInput.Type;

export const ToolInFlight = Schema.Struct({
  itemId: Schema.String,
  turnId: Schema.NullOr(TurnId),
  startedAt: IsoDateTime,
});
export type ToolInFlight = typeof ToolInFlight.Type;

/**
 * ProjectionThreadSessionRepositoryShape - Service API for projected thread sessions.
 */
export interface ProjectionThreadSessionRepositoryShape {
  /**
   * Insert or replace a projected thread-session row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (row: ProjectionThreadSession) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected thread-session state by thread id.
   */
  readonly getByThreadId: (
    input: GetProjectionThreadSessionInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * Delete projected thread-session state by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Advance `lastActivityAt` monotonically — never regresses the stored
   * timestamp, so callers may pass event time unconditionally.
   */
  readonly touchLastActivity: (
    input: TouchLastActivityInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Record a tool call starting (idempotent per thread+item — safe across
   * the startup open-turn replay).
   */
  readonly markToolStarted: (
    input: MarkToolStartedInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Record a tool call finishing.
   */
  readonly markToolFinished: (
    input: MarkToolFinishedInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Clear in-flight tool rows — all of a thread's, or all but one turn's
   * (when a new turn starts).
   */
  readonly clearActiveTools: (
    input: ClearActiveToolsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * In-flight tool rows for a thread, oldest first.
   */
  readonly getToolInFlight: (
    input: GetToolInFlightInput,
  ) => Effect.Effect<ReadonlyArray<ToolInFlight>, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadSessionRepository - Service tag for thread-session persistence.
 */
export class ProjectionThreadSessionRepository extends ServiceMap.Service<
  ProjectionThreadSessionRepository,
  ProjectionThreadSessionRepositoryShape
>()("synara/persistence/Services/ProjectionThreadSessions/ProjectionThreadSessionRepository") {}
