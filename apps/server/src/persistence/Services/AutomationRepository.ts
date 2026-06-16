import {
  AutomationCancelRunInput,
  AutomationCreateInput,
  AutomationDefinition,
  AutomationId,
  AutomationListInput,
  AutomationListResult,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationRunId,
  AutomationTrigger,
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Option, Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

import type { AutomationRepositoryError } from "../Errors.ts";

export const CreateAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  input: AutomationCreateInput,
  now: Schema.String,
});
export type CreateAutomationDefinitionInput = typeof CreateAutomationDefinitionInput.Type;

export const GetAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
});
export type GetAutomationDefinitionInput = typeof GetAutomationDefinitionInput.Type;

export const ListDueAutomationDefinitionsInput = Schema.Struct({
  now: Schema.String,
  limit: Schema.Number,
});
export type ListDueAutomationDefinitionsInput = typeof ListDueAutomationDefinitionsInput.Type;

export const SetAutomationDefinitionNextRunAtInput = Schema.Struct({
  id: AutomationId,
  nextRunAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type SetAutomationDefinitionNextRunAtInput =
  typeof SetAutomationDefinitionNextRunAtInput.Type;

export const ArchiveAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  archivedAt: Schema.String,
});
export type ArchiveAutomationDefinitionInput = typeof ArchiveAutomationDefinitionInput.Type;

export const CreateAutomationRunInput = Schema.Struct({
  id: AutomationRunId,
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  trigger: AutomationTrigger,
  scheduledFor: Schema.String,
  permissionSnapshot: AutomationPermissionSnapshot,
  now: Schema.String,
});
export type CreateAutomationRunInput = typeof CreateAutomationRunInput.Type;

export const GetAutomationRunInput = Schema.Struct({
  id: AutomationRunId,
});
export type GetAutomationRunInput = typeof GetAutomationRunInput.Type;

export const MarkAutomationRunStartedInput = Schema.Struct({
  id: AutomationRunId,
  threadId: ThreadId,
  messageId: MessageId,
  threadCreateCommandId: Schema.NullOr(CommandId),
  turnStartCommandId: CommandId,
  startedAt: Schema.String,
});
export type MarkAutomationRunStartedInput = typeof MarkAutomationRunStartedInput.Type;

export const MarkAutomationRunFailedInput = Schema.Struct({
  id: AutomationRunId,
  error: Schema.String,
  finishedAt: Schema.String,
});
export type MarkAutomationRunFailedInput = typeof MarkAutomationRunFailedInput.Type;

export const MarkAutomationRunSucceededInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  result: Schema.NullOr(Schema.Unknown),
  finishedAt: Schema.String,
});
export type MarkAutomationRunSucceededInput = typeof MarkAutomationRunSucceededInput.Type;

export const MarkAutomationRunInterruptedInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  finishedAt: Schema.String,
});
export type MarkAutomationRunInterruptedInput = typeof MarkAutomationRunInterruptedInput.Type;

export const MarkAutomationRunWaitingForApprovalInput = Schema.Struct({
  id: AutomationRunId,
  turnId: Schema.NullOr(TurnId),
  updatedAt: Schema.String,
});
export type MarkAutomationRunWaitingForApprovalInput =
  typeof MarkAutomationRunWaitingForApprovalInput.Type;

export const GetAutomationRunByThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetAutomationRunByThreadInput = typeof GetAutomationRunByThreadInput.Type;

export const ListRecoverableAutomationRunsInput = Schema.Struct({
  limit: Schema.Number,
});
export type ListRecoverableAutomationRunsInput = typeof ListRecoverableAutomationRunsInput.Type;

export const CountActiveAutomationRunsInput = Schema.Struct({
  automationId: AutomationId,
});
export type CountActiveAutomationRunsInput = typeof CountActiveAutomationRunsInput.Type;

export const DisableAutomationDefinitionInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
});
export type DisableAutomationDefinitionInput = typeof DisableAutomationDefinitionInput.Type;

export const IncrementAutomationIterationInput = Schema.Struct({
  id: AutomationId,
  now: Schema.String,
});
export type IncrementAutomationIterationInput = typeof IncrementAutomationIterationInput.Type;

export const AcquireAutomationSchedulerLeaseInput = Schema.Struct({
  leaseKey: Schema.String,
  ownerId: Schema.String,
  now: Schema.String,
  leaseExpiresAt: Schema.String,
});
export type AcquireAutomationSchedulerLeaseInput = typeof AcquireAutomationSchedulerLeaseInput.Type;

export interface AutomationRepositoryShape {
  readonly createDefinition: (
    input: CreateAutomationDefinitionInput,
  ) => Effect.Effect<AutomationDefinition, AutomationRepositoryError>;
  readonly saveDefinition: (
    input: AutomationDefinition,
  ) => Effect.Effect<AutomationDefinition, AutomationRepositoryError>;
  readonly getDefinitionById: (
    input: GetAutomationDefinitionInput,
  ) => Effect.Effect<Option.Option<AutomationDefinition>, AutomationRepositoryError>;
  readonly listDueDefinitions: (
    input: ListDueAutomationDefinitionsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationDefinition>, AutomationRepositoryError>;
  readonly setDefinitionNextRunAt: (
    input: SetAutomationDefinitionNextRunAtInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly archiveDefinition: (
    input: ArchiveAutomationDefinitionInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly list: (
    input?: AutomationListInput,
  ) => Effect.Effect<AutomationListResult, AutomationRepositoryError>;
  readonly createRun: (
    input: CreateAutomationRunInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly getRunById: (
    input: GetAutomationRunInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly markRunStarted: (
    input: MarkAutomationRunStartedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunFailed: (
    input: MarkAutomationRunFailedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunSucceeded: (
    input: MarkAutomationRunSucceededInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunInterrupted: (
    input: MarkAutomationRunInterruptedInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly markRunWaitingForApproval: (
    input: MarkAutomationRunWaitingForApprovalInput,
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly cancelRun: (
    input: AutomationCancelRunInput & { readonly now: string },
  ) => Effect.Effect<AutomationRun, AutomationRepositoryError>;
  readonly getRunByThreadId: (
    input: GetAutomationRunByThreadInput,
  ) => Effect.Effect<Option.Option<AutomationRun>, AutomationRepositoryError>;
  readonly listRecoverableRuns: (
    input: ListRecoverableAutomationRunsInput,
  ) => Effect.Effect<ReadonlyArray<AutomationRun>, AutomationRepositoryError>;
  readonly countActiveRunsForDefinition: (
    input: CountActiveAutomationRunsInput,
  ) => Effect.Effect<number, AutomationRepositoryError>;
  readonly disableDefinition: (
    input: DisableAutomationDefinitionInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly incrementDefinitionIterationCount: (
    input: IncrementAutomationIterationInput,
  ) => Effect.Effect<void, AutomationRepositoryError>;
  readonly tryAcquireSchedulerLease: (
    input: AcquireAutomationSchedulerLeaseInput,
  ) => Effect.Effect<boolean, AutomationRepositoryError>;
}

export class AutomationRepository extends ServiceMap.Service<
  AutomationRepository,
  AutomationRepositoryShape
>()("t3/persistence/Services/AutomationRepository") {}
