import { Schema } from "effect";

import {
  AutomationId,
  AutomationRunId,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import {
  ModelSelection,
  ProviderInteractionMode,
  ProviderKind,
  ProviderStartOptions,
  RuntimeMode,
} from "./orchestration";

export const DEFAULT_AUTOMATION_RUNTIME_MODE: RuntimeMode = "approval-required";

export const AutomationTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/),
);
export type AutomationTimeOfDay = typeof AutomationTimeOfDay.Type;

export const AutomationSchedule = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({
    type: Schema.Literal("interval"),
    everySeconds: PositiveInt,
  }),
  Schema.Struct({
    type: Schema.Literal("daily"),
    timeOfDay: AutomationTimeOfDay,
  }),
  Schema.Struct({
    type: Schema.Literal("weekly"),
    dayOfWeek: NonNegativeInt.check(Schema.isLessThanOrEqualTo(6)),
    timeOfDay: AutomationTimeOfDay,
  }),
]);
export type AutomationSchedule = typeof AutomationSchedule.Type;

export const AutomationWorktreeMode = Schema.Literals(["auto", "local", "worktree"]);
export type AutomationWorktreeMode = typeof AutomationWorktreeMode.Type;

/**
 * Automation execution model.
 * - `standalone`: every run creates a fresh thread + turn (project task on a schedule).
 * - `heartbeat`: every run continues an existing target thread (a self-resuming loop).
 */
export const AutomationMode = Schema.Literals(["standalone", "heartbeat"]);
export type AutomationMode = typeof AutomationMode.Type;

export const AutomationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({ type: Schema.Literal("scheduled") }),
]);
export type AutomationTrigger = typeof AutomationTrigger.Type;

export const AutomationRunStatus = Schema.Literals([
  "pending",
  "claimed",
  "running",
  "waiting-for-approval",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "skipped",
]);
export type AutomationRunStatus = typeof AutomationRunStatus.Type;

export const AutomationAllowedCapability = Schema.Literals([
  "send-turn",
  "create-worktree",
  "full-access",
]);
export type AutomationAllowedCapability = typeof AutomationAllowedCapability.Type;

export const AutomationPermissionSnapshot = Schema.Struct({
  provider: ProviderKind,
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreeMode: AutomationWorktreeMode,
  allowedCapabilities: Schema.Array(AutomationAllowedCapability),
  createdAt: IsoDateTime,
});
export type AutomationPermissionSnapshot = typeof AutomationPermissionSnapshot.Type;

export const AutomationDefinition = Schema.Struct({
  id: AutomationId,
  projectId: ProjectId,
  sourceThreadId: Schema.NullOr(ThreadId),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  schedule: AutomationSchedule,
  enabled: Schema.Boolean,
  nextRunAt: Schema.NullOr(IsoDateTime),
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  worktreeMode: AutomationWorktreeMode,
  mode: AutomationMode,
  /** Heartbeat target thread continued on each wake. Null for standalone automations. */
  targetThreadId: Schema.NullOr(ThreadId),
  /** Hard cap on total runs before the automation auto-disables. Null = unbounded. */
  maxIterations: Schema.NullOr(PositiveInt),
  /** When true, a failed run disables the automation (stops a runaway loop). */
  stopOnError: Schema.Boolean,
  /** Number of runs created so far; used to enforce maxIterations. */
  iterationCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type AutomationDefinition = typeof AutomationDefinition.Type;

const AutomationDefinitionConfig = Schema.Struct({
  projectId: ProjectId,
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(64_000)),
  schedule: AutomationSchedule,
  enabled: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
  modelSelection: ModelSelection,
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: Schema.optional(RuntimeMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_AUTOMATION_RUNTIME_MODE),
  ),
  interactionMode: Schema.optional(ProviderInteractionMode).pipe(
    Schema.withDecodingDefault(() => "default" as const),
  ),
  worktreeMode: Schema.optional(AutomationWorktreeMode).pipe(
    Schema.withDecodingDefault(() => "auto" as const),
  ),
  mode: Schema.optional(AutomationMode).pipe(
    Schema.withDecodingDefault(() => "standalone" as const),
  ),
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  stopOnError: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => true)),
});

export const AutomationCreateInput = AutomationDefinitionConfig;
export type AutomationCreateInput = typeof AutomationCreateInput.Type;

export const AutomationUpdateInput = Schema.Struct({
  id: AutomationId,
  projectId: Schema.optional(ProjectId),
  sourceThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64_000))),
  schedule: Schema.optional(AutomationSchedule),
  enabled: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  worktreeMode: Schema.optional(AutomationWorktreeMode),
  mode: Schema.optional(AutomationMode),
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  maxIterations: Schema.optional(Schema.NullOr(PositiveInt)),
  stopOnError: Schema.optional(Schema.Boolean),
});
export type AutomationUpdateInput = typeof AutomationUpdateInput.Type;

export const AutomationDeleteInput = Schema.Struct({
  id: AutomationId,
});
export type AutomationDeleteInput = typeof AutomationDeleteInput.Type;

export const AutomationListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  includeArchived: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});
export type AutomationListInput = typeof AutomationListInput.Type;

export const AutomationRunNowInput = Schema.Struct({
  automationId: AutomationId,
});
export type AutomationRunNowInput = typeof AutomationRunNowInput.Type;

export const AutomationCancelRunInput = Schema.Struct({
  runId: AutomationRunId,
});
export type AutomationCancelRunInput = typeof AutomationCancelRunInput.Type;

export const AutomationRun = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.optional(Schema.NullOr(TurnId)),
  trigger: AutomationTrigger,
  status: AutomationRunStatus,
  scheduledFor: IsoDateTime,
  claimedBy: Schema.NullOr(TrimmedNonEmptyString),
  claimedAt: Schema.NullOr(IsoDateTime),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  threadCreateCommandId: Schema.NullOr(CommandId),
  turnStartCommandId: Schema.NullOr(CommandId),
  messageId: Schema.NullOr(MessageId),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  result: Schema.NullOr(Schema.Unknown),
  permissionSnapshot: AutomationPermissionSnapshot,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AutomationRun = typeof AutomationRun.Type;

export const AutomationListResult = Schema.Struct({
  definitions: Schema.Array(AutomationDefinition),
  runs: Schema.Array(AutomationRun),
});
export type AutomationListResult = typeof AutomationListResult.Type;

export const AutomationRunNowResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationRunNowResult = typeof AutomationRunNowResult.Type;

export const AutomationCancelRunResult = Schema.Struct({
  run: AutomationRun,
});
export type AutomationCancelRunResult = typeof AutomationCancelRunResult.Type;

export const AutomationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    definitions: Schema.Array(AutomationDefinition),
    runs: Schema.Array(AutomationRun),
  }),
  Schema.Struct({
    type: Schema.Literal("definition-upserted"),
    definition: AutomationDefinition,
  }),
  Schema.Struct({
    type: Schema.Literal("definition-deleted"),
    automationId: AutomationId,
  }),
  Schema.Struct({
    type: Schema.Literal("run-upserted"),
    run: AutomationRun,
  }),
]);
export type AutomationStreamEvent = typeof AutomationStreamEvent.Type;
