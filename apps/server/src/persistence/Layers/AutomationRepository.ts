import {
  AutomationCompletionPolicy,
  AutomationDefinition,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationSchedule,
  DEFAULT_AUTOMATION_RUNTIME_MODE,
  ModelSelection,
  ProviderStartOptions,
  ProjectId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeCauseError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  AcquireAutomationSchedulerLeaseInput,
  ArchiveAutomationDefinitionInput,
  AutomationRepository,
  type AutomationRepositoryShape,
  CountActiveAutomationRunsByThreadInput,
  CountActiveAutomationRunsInput,
  CountPendingCompletionEvaluationsByThreadInput,
  DisableAutomationDefinitionInput,
  DisableAutomationDefinitionIfUnchangedInput,
  GetEarliestAutomationNextRunAtInput,
  GetAutomationDefinitionInput,
  GetAutomationRunByThreadInput,
  GetAutomationRunInput,
  IncrementAutomationIterationInput,
  ListActiveAutomationRunsForDefinitionInput,
  ListDueAutomationDefinitionsInput,
  ListAutomationRunsNeedingCompletionEvaluationInput,
  ListRecoverableAutomationRunsInput,
  MarkAutomationRunFailedInput,
  MarkAutomationRunInterruptedInput,
  MarkAutomationRunResultInput,
  MarkAutomationRunSkippedInput,
  MarkAutomationRunStartedInput,
  MarkAutomationRunSucceededInput,
  MarkAutomationRunWaitingForApprovalInput,
  RestartAutomationDefinitionLoopInput,
  SetAutomationDefinitionNextRunAtInput,
} from "../Services/AutomationRepository.ts";

const AutomationDefinitionDbRow = Schema.Struct({
  id: AutomationDefinition.fields.id,
  projectId: AutomationDefinition.fields.projectId,
  sourceThreadId: AutomationDefinition.fields.sourceThreadId,
  name: AutomationDefinition.fields.name,
  prompt: AutomationDefinition.fields.prompt,
  schedule: Schema.fromJsonString(AutomationSchedule),
  enabled: Schema.Number,
  nextRunAt: AutomationDefinition.fields.nextRunAt,
  modelSelection: Schema.fromJsonString(ModelSelection),
  providerOptions: Schema.NullOr(Schema.fromJsonString(ProviderStartOptions)),
  runtimeMode: AutomationDefinition.fields.runtimeMode,
  interactionMode: AutomationDefinition.fields.interactionMode,
  worktreeMode: AutomationDefinition.fields.worktreeMode,
  mode: AutomationDefinition.fields.mode,
  targetThreadId: AutomationDefinition.fields.targetThreadId,
  maxIterations: AutomationDefinition.fields.maxIterations,
  stopOnError: Schema.Number,
  completionPolicy: Schema.fromJsonString(AutomationCompletionPolicy),
  completionPolicyVersion: AutomationDefinition.fields.completionPolicyVersion,
  completionPolicyUpdatedAt: AutomationDefinition.fields.completionPolicyUpdatedAt,
  minimumIntervalSeconds: AutomationDefinition.fields.minimumIntervalSeconds,
  maxRuntimeSeconds: AutomationDefinition.fields.maxRuntimeSeconds,
  retryPolicy: Schema.fromJsonString(AutomationDefinition.fields.retryPolicy),
  misfirePolicy: AutomationDefinition.fields.misfirePolicy,
  acknowledgedRisks: Schema.fromJsonString(AutomationDefinition.fields.acknowledgedRisks),
  iterationCount: AutomationDefinition.fields.iterationCount,
  createdAt: AutomationDefinition.fields.createdAt,
  updatedAt: AutomationDefinition.fields.updatedAt,
  archivedAt: AutomationDefinition.fields.archivedAt,
});
type AutomationDefinitionDbRow = typeof AutomationDefinitionDbRow.Type;

const AutomationRunDbRow = Schema.Struct({
  id: AutomationRun.fields.id,
  automationId: AutomationRun.fields.automationId,
  projectId: AutomationRun.fields.projectId,
  threadId: AutomationRun.fields.threadId,
  turnId: Schema.NullOr(TurnId),
  triggerType: Schema.Literals(["manual", "scheduled"]),
  status: AutomationRun.fields.status,
  scheduledFor: AutomationRun.fields.scheduledFor,
  claimedBy: AutomationRun.fields.claimedBy,
  claimedAt: AutomationRun.fields.claimedAt,
  leaseExpiresAt: AutomationRun.fields.leaseExpiresAt,
  startedAt: AutomationRun.fields.startedAt,
  finishedAt: AutomationRun.fields.finishedAt,
  threadCreateCommandId: AutomationRun.fields.threadCreateCommandId,
  turnStartCommandId: AutomationRun.fields.turnStartCommandId,
  messageId: AutomationRun.fields.messageId,
  error: AutomationRun.fields.error,
  result: Schema.NullOr(Schema.fromJsonString(AutomationRun.fields.result)),
  permissionSnapshot: Schema.fromJsonString(AutomationPermissionSnapshot),
  createdAt: AutomationRun.fields.createdAt,
  updatedAt: AutomationRun.fields.updatedAt,
});
type AutomationRunDbRow = typeof AutomationRunDbRow.Type;

function withResultDefaults(run: AutomationRun): NonNullable<AutomationRun["result"]> {
  return (
    run.result ?? {
      outcome: "unknown",
      summary: null,
      unread: true,
      archivedAt: null,
    }
  );
}

const decodeDefinition = Schema.decodeUnknownEffect(AutomationDefinition);
const decodeRun = Schema.decodeUnknownEffect(AutomationRun);

/** Upper bound on how many run rows the list query returns to a client snapshot. */
const MAX_RUN_LIST_ROWS = 500;

function toDefinition(row: AutomationDefinitionDbRow) {
  return decodeDefinition({
    ...row,
    enabled: row.enabled === 1,
    stopOnError: row.stopOnError === 1,
    providerOptions: row.providerOptions ?? undefined,
  }).pipe(Effect.mapError(toPersistenceDecodeError("AutomationRepository.definitionRowToDomain")));
}

function toRun(row: AutomationRunDbRow) {
  return decodeRun({
    ...row,
    trigger: { type: row.triggerType },
    turnId: row.turnId,
  }).pipe(Effect.mapError(toPersistenceDecodeError("AutomationRepository.runRowToDomain")));
}

const makeAutomationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertDefinition = SqlSchema.void({
    Request: AutomationDefinitionDbRow,
    execute: (definition) =>
      sql`
        INSERT INTO automation_definitions (
          automation_id,
          project_id,
          source_thread_id,
          name,
          prompt,
          schedule_json,
          enabled,
          next_run_at,
          model_selection_json,
          provider_options_json,
          runtime_mode,
          interaction_mode,
          worktree_mode,
          mode,
          target_thread_id,
          max_iterations,
          stop_on_error,
          completion_policy_json,
          completion_policy_version,
          completion_policy_updated_at,
          minimum_interval_seconds,
          max_runtime_seconds,
          retry_policy_json,
          misfire_policy,
          acknowledged_risks_json,
          iteration_count,
          created_at,
          updated_at,
          archived_at
        )
        VALUES (
          ${definition.id},
          ${definition.projectId},
          ${definition.sourceThreadId},
          ${definition.name},
          ${definition.prompt},
          ${definition.schedule},
          ${definition.enabled},
          ${definition.nextRunAt},
          ${definition.modelSelection},
          ${definition.providerOptions},
          ${definition.runtimeMode},
          ${definition.interactionMode},
          ${definition.worktreeMode},
          ${definition.mode},
          ${definition.targetThreadId},
          ${definition.maxIterations},
          ${definition.stopOnError},
          ${definition.completionPolicy},
          ${definition.completionPolicyVersion},
          ${definition.completionPolicyUpdatedAt},
          ${definition.minimumIntervalSeconds},
          ${definition.maxRuntimeSeconds},
          ${definition.retryPolicy},
          ${definition.misfirePolicy},
          ${definition.acknowledgedRisks},
          ${definition.iterationCount},
          ${definition.createdAt},
          ${definition.updatedAt},
          ${definition.archivedAt}
        )
      `,
  });

  const getDefinitionRow = SqlSchema.findOneOption({
    Request: GetAutomationDefinitionInput,
    Result: AutomationDefinitionDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          automation_id AS "id",
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          name,
          prompt,
          schedule_json AS "schedule",
          enabled,
          next_run_at AS "nextRunAt",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          worktree_mode AS "worktreeMode",
          mode,
          target_thread_id AS "targetThreadId",
          max_iterations AS "maxIterations",
          stop_on_error AS "stopOnError",
          completion_policy_json AS "completionPolicy",
          completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            completion_policy_updated_at,
            updated_at,
            created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          minimum_interval_seconds AS "minimumIntervalSeconds",
          max_runtime_seconds AS "maxRuntimeSeconds",
          retry_policy_json AS "retryPolicy",
          misfire_policy AS "misfirePolicy",
          acknowledged_risks_json AS "acknowledgedRisks",
          iteration_count AS "iterationCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE automation_id = ${id}
      `,
  });

  const updateDefinitionRow = SqlSchema.void({
    Request: AutomationDefinitionDbRow,
    execute: (definition) =>
      sql`
        UPDATE automation_definitions
        SET project_id = ${definition.projectId},
            source_thread_id = ${definition.sourceThreadId},
            name = ${definition.name},
            prompt = ${definition.prompt},
            schedule_json = ${definition.schedule},
            enabled = ${definition.enabled},
            next_run_at = ${definition.nextRunAt},
            model_selection_json = ${definition.modelSelection},
            provider_options_json = ${definition.providerOptions},
            runtime_mode = ${definition.runtimeMode},
            interaction_mode = ${definition.interactionMode},
            worktree_mode = ${definition.worktreeMode},
            mode = ${definition.mode},
            target_thread_id = ${definition.targetThreadId},
            max_iterations = ${definition.maxIterations},
            stop_on_error = ${definition.stopOnError},
            completion_policy_json = ${definition.completionPolicy},
            completion_policy_version = ${definition.completionPolicyVersion},
            completion_policy_updated_at = ${definition.completionPolicyUpdatedAt},
            minimum_interval_seconds = ${definition.minimumIntervalSeconds},
            max_runtime_seconds = ${definition.maxRuntimeSeconds},
            retry_policy_json = ${definition.retryPolicy},
            misfire_policy = ${definition.misfirePolicy},
            acknowledged_risks_json = ${definition.acknowledgedRisks},
            updated_at = ${definition.updatedAt},
            archived_at = ${definition.archivedAt}
        WHERE automation_id = ${definition.id}
      `,
  });

  const listDefinitionRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      includeArchived: Schema.Boolean,
    }),
    Result: AutomationDefinitionDbRow,
    execute: ({ projectId, includeArchived }) =>
      sql`
        SELECT
          automation_id AS "id",
          project_id AS "projectId",
          source_thread_id AS "sourceThreadId",
          name,
          prompt,
          schedule_json AS "schedule",
          enabled,
          next_run_at AS "nextRunAt",
          model_selection_json AS "modelSelection",
          provider_options_json AS "providerOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          worktree_mode AS "worktreeMode",
          mode,
          target_thread_id AS "targetThreadId",
          max_iterations AS "maxIterations",
          stop_on_error AS "stopOnError",
          completion_policy_json AS "completionPolicy",
          completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            completion_policy_updated_at,
            updated_at,
            created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          minimum_interval_seconds AS "minimumIntervalSeconds",
          max_runtime_seconds AS "maxRuntimeSeconds",
          retry_policy_json AS "retryPolicy",
          misfire_policy AS "misfirePolicy",
          acknowledged_risks_json AS "acknowledgedRisks",
          iteration_count AS "iterationCount",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})
          AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        ORDER BY updated_at DESC, automation_id ASC
      `,
  });

  const listDueDefinitionRows = SqlSchema.findAll({
    Request: ListDueAutomationDefinitionsInput,
    Result: AutomationDefinitionDbRow,
    execute: ({ now, limit }) =>
      sql`
        SELECT
          definitions.automation_id AS "id",
          definitions.project_id AS "projectId",
          definitions.source_thread_id AS "sourceThreadId",
          definitions.name,
          definitions.prompt,
          definitions.schedule_json AS "schedule",
          definitions.enabled,
          definitions.next_run_at AS "nextRunAt",
          definitions.model_selection_json AS "modelSelection",
          definitions.provider_options_json AS "providerOptions",
          definitions.runtime_mode AS "runtimeMode",
          definitions.interaction_mode AS "interactionMode",
          definitions.worktree_mode AS "worktreeMode",
          definitions.mode,
          definitions.target_thread_id AS "targetThreadId",
          definitions.max_iterations AS "maxIterations",
          definitions.stop_on_error AS "stopOnError",
          definitions.completion_policy_json AS "completionPolicy",
          definitions.completion_policy_version AS "completionPolicyVersion",
          COALESCE(
            definitions.completion_policy_updated_at,
            definitions.updated_at,
            definitions.created_at,
            '1970-01-01T00:00:00.000Z'
          ) AS "completionPolicyUpdatedAt",
          definitions.minimum_interval_seconds AS "minimumIntervalSeconds",
          definitions.max_runtime_seconds AS "maxRuntimeSeconds",
          definitions.retry_policy_json AS "retryPolicy",
          definitions.misfire_policy AS "misfirePolicy",
          definitions.acknowledged_risks_json AS "acknowledgedRisks",
          definitions.iteration_count AS "iterationCount",
          definitions.created_at AS "createdAt",
          definitions.updated_at AS "updatedAt",
          definitions.archived_at AS "archivedAt"
        FROM automation_definitions definitions
        WHERE definitions.enabled = 1
          AND definitions.archived_at IS NULL
          AND definitions.next_run_at IS NOT NULL
          AND definitions.next_run_at <= ${now}
          AND NOT (
            definitions.mode = 'heartbeat'
            AND definitions.target_thread_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM automation_pending_completion_evaluations pending
              WHERE pending.thread_id = definitions.target_thread_id
            )
          )
        ORDER BY definitions.next_run_at ASC, definitions.automation_id ASC
        LIMIT ${limit}
      `,
  });

  const setDefinitionNextRunAtRow = SqlSchema.void({
    Request: SetAutomationDefinitionNextRunAtInput,
    execute: ({ id, nextRunAt, updatedAt }) =>
      sql`
        UPDATE automation_definitions
        SET next_run_at = ${nextRunAt},
            updated_at = ${updatedAt}
        WHERE automation_id = ${id}
      `,
  });

  const archiveDefinitionRow = SqlSchema.void({
    Request: ArchiveAutomationDefinitionInput,
    execute: ({ id, archivedAt }) =>
      sql`
        UPDATE automation_definitions
        SET archived_at = ${archivedAt}, updated_at = ${archivedAt}, enabled = 0
        WHERE automation_id = ${id}
      `,
  });

  const insertRun = SqlSchema.void({
    Request: AutomationRunDbRow,
    execute: (run) =>
      sql`
        INSERT OR IGNORE INTO automation_runs (
          run_id,
          automation_id,
          project_id,
          thread_id,
          turn_id,
          trigger_type,
          status,
          scheduled_for,
          claimed_by,
          claimed_at,
          lease_expires_at,
          started_at,
          finished_at,
          thread_create_command_id,
          turn_start_command_id,
          message_id,
          error,
          result_json,
          permission_snapshot_json,
          created_at,
          updated_at
        )
        SELECT
          ${run.id},
          ${run.automationId},
          ${run.projectId},
          ${run.threadId},
          ${run.turnId},
          ${run.triggerType},
          ${run.status},
          ${run.scheduledFor},
          ${run.claimedBy},
          ${run.claimedAt},
          ${run.leaseExpiresAt},
          ${run.startedAt},
          ${run.finishedAt},
          ${run.threadCreateCommandId},
          ${run.turnStartCommandId},
          ${run.messageId},
          ${run.error},
          ${run.result},
          ${run.permissionSnapshot},
          ${run.createdAt},
          ${run.updatedAt}
        WHERE ${run.threadId} IS NULL
           OR NOT EXISTS (
             SELECT 1
             FROM automation_runs
             WHERE thread_id = ${run.threadId}
               AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
           )
      `,
  });

  const getRunRowById = SqlSchema.findOneOption({
    Request: GetAutomationRunInput,
    Result: AutomationRunDbRow,
    execute: ({ id }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE run_id = ${id}
      `,
  });

  const getRunRowByOccurrence = SqlSchema.findOneOption({
    Request: Schema.Struct({
      automationId: AutomationRun.fields.automationId,
      scheduledFor: AutomationRun.fields.scheduledFor,
    }),
    Result: AutomationRunDbRow,
    execute: ({ automationId, scheduledFor }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND scheduled_for = ${scheduledFor}
          AND trigger_type = 'scheduled'
      `,
  });

  const listRunRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: Schema.optional(ProjectId),
      includeArchived: Schema.Boolean,
    }),
    Result: AutomationRunDbRow,
    execute: ({ projectId, includeArchived }) =>
      sql`
        SELECT
          runs.run_id AS "id",
          runs.automation_id AS "automationId",
          runs.project_id AS "projectId",
          runs.thread_id AS "threadId",
          runs.turn_id AS "turnId",
          runs.trigger_type AS "triggerType",
          runs.status,
          runs.scheduled_for AS "scheduledFor",
          runs.claimed_by AS "claimedBy",
          runs.claimed_at AS "claimedAt",
          runs.lease_expires_at AS "leaseExpiresAt",
          runs.started_at AS "startedAt",
          runs.finished_at AS "finishedAt",
          runs.thread_create_command_id AS "threadCreateCommandId",
          runs.turn_start_command_id AS "turnStartCommandId",
          runs.message_id AS "messageId",
          runs.error,
          runs.result_json AS "result",
          runs.permission_snapshot_json AS "permissionSnapshot",
          runs.created_at AS "createdAt",
          runs.updated_at AS "updatedAt"
        FROM automation_runs runs
        INNER JOIN automation_definitions definitions
          ON definitions.automation_id = runs.automation_id
        WHERE (${projectId ?? null} IS NULL OR runs.project_id = ${projectId ?? null})
          AND (${includeArchived ? 1 : 0} = 1 OR definitions.archived_at IS NULL)
        ORDER BY runs.scheduled_for DESC, runs.run_id DESC
        LIMIT ${MAX_RUN_LIST_ROWS}
      `,
  });

  const cancelRunRow = SqlSchema.void({
    Request: Schema.Struct({
      id: GetAutomationRunInput.fields.id,
      now: Schema.String,
    }),
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_runs
        SET status = 'cancelled',
            finished_at = ${now},
            updated_at = ${now},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const markRunStartedRow = SqlSchema.void({
    Request: MarkAutomationRunStartedInput,
    execute: ({ id, threadId, messageId, threadCreateCommandId, turnStartCommandId, startedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'running',
            thread_id = ${threadId},
            message_id = ${messageId},
            thread_create_command_id = ${threadCreateCommandId},
            turn_start_command_id = ${turnStartCommandId},
            started_at = ${startedAt},
            updated_at = ${startedAt}
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'waiting-for-approval')
      `,
  });

  const markRunFailedRow = SqlSchema.void({
    Request: MarkAutomationRunFailedInput,
    execute: ({ id, error, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'failed',
            error = ${error},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      `,
  });

  const markRunSkippedRow = SqlSchema.void({
    Request: MarkAutomationRunSkippedInput,
    execute: ({ id, reason, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'skipped',
            error = ${reason},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed')
      `,
  });

  const markRunSucceededRow = SqlSchema.void({
    Request: MarkAutomationRunSucceededInput,
    execute: ({ id, turnId, result, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'succeeded',
            turn_id = COALESCE(${turnId}, turn_id),
            result_json = ${result === null ? null : JSON.stringify(result)},
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      `,
  });

  const markRunResultRow = SqlSchema.void({
    Request: MarkAutomationRunResultInput,
    execute: ({ id, result, updatedAt }) =>
      sql`
        UPDATE automation_runs
        SET result_json = ${result === null ? null : JSON.stringify(result)},
            updated_at = ${updatedAt}
        WHERE run_id = ${id}
      `,
  });

  // Writes a new result but carries the triage fields (archivedAt/unread) over from the
  // existing row atomically, so a background completion evaluation can never clobber a
  // concurrent user archive/mark-read landing between the run reload and this write.
  // unread is round-tripped through json() so it stays a JSON boolean rather than the
  // 0/1 that json_extract yields.
  const markRunCompletionResultRow = SqlSchema.void({
    Request: MarkAutomationRunResultInput,
    execute: ({ id, result, updatedAt }) =>
      result === null
        ? sql`
            UPDATE automation_runs
            SET result_json = NULL, updated_at = ${updatedAt}
            WHERE run_id = ${id}
          `
        : sql`
            UPDATE automation_runs
            SET result_json = CASE
                  WHEN result_json IS NULL THEN ${JSON.stringify(result)}
                  ELSE json_set(
                    json_set(
                      ${JSON.stringify(result)},
                      '$.archivedAt',
                      json_extract(result_json, '$.archivedAt')
                    ),
                    '$.unread',
                    json(
                      CASE
                        -- Existing row has no boolean unread (legacy/null): fall back to the
                        -- incoming result's value rather than implicitly defaulting to unread.
                        WHEN json_extract(result_json, '$.unread') IS NULL THEN
                          CASE WHEN json_extract(${JSON.stringify(result)}, '$.unread') = 0
                            THEN 'false' ELSE 'true' END
                        WHEN json_extract(result_json, '$.unread') = 0 THEN 'false'
                        ELSE 'true'
                      END
                    )
                  )
                END,
                updated_at = ${updatedAt}
            WHERE run_id = ${id}
          `,
  });

  const markRunInterruptedRow = SqlSchema.void({
    Request: MarkAutomationRunInterruptedInput,
    execute: ({ id, turnId, finishedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'interrupted',
            turn_id = COALESCE(${turnId}, turn_id),
            finished_at = ${finishedAt},
            updated_at = ${finishedAt},
            lease_expires_at = NULL,
            claimed_by = NULL
        WHERE run_id = ${id}
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'interrupted')
      `,
  });

  const markRunWaitingForApprovalRow = SqlSchema.void({
    Request: MarkAutomationRunWaitingForApprovalInput,
    execute: ({ id, turnId, updatedAt }) =>
      sql`
        UPDATE automation_runs
        SET status = 'waiting-for-approval',
            turn_id = COALESCE(${turnId}, turn_id),
            updated_at = ${updatedAt}
        WHERE run_id = ${id}
          AND status IN ('pending', 'claimed', 'running')
      `,
  });

  const getRunRowByThread = SqlSchema.findOneOption({
    Request: GetAutomationRunByThreadInput,
    Result: AutomationRunDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE thread_id = ${threadId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
        ORDER BY created_at DESC, run_id DESC
        LIMIT 1
      `,
  });

  const listRecoverableRunRows = SqlSchema.findAll({
    Request: ListRecoverableAutomationRunsInput,
    Result: AutomationRunDbRow,
    execute: ({ limit }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
        ORDER BY created_at ASC, run_id ASC
        LIMIT ${limit}
      `,
  });

  const listRunsNeedingCompletionEvaluationRows = SqlSchema.findAll({
    Request: ListAutomationRunsNeedingCompletionEvaluationInput,
    Result: AutomationRunDbRow,
    execute: ({ limit }) =>
      sql`
        SELECT
          runs.run_id AS "id",
          runs.automation_id AS "automationId",
          runs.project_id AS "projectId",
          runs.thread_id AS "threadId",
          runs.turn_id AS "turnId",
          runs.trigger_type AS "triggerType",
          runs.status,
          runs.scheduled_for AS "scheduledFor",
          runs.claimed_by AS "claimedBy",
          runs.claimed_at AS "claimedAt",
          runs.lease_expires_at AS "leaseExpiresAt",
          runs.started_at AS "startedAt",
          runs.finished_at AS "finishedAt",
          runs.thread_create_command_id AS "threadCreateCommandId",
          runs.turn_start_command_id AS "turnStartCommandId",
          runs.message_id AS "messageId",
          runs.error,
          runs.result_json AS "result",
          runs.permission_snapshot_json AS "permissionSnapshot",
          runs.created_at AS "createdAt",
          runs.updated_at AS "updatedAt"
        FROM automation_runs runs
        INNER JOIN automation_pending_completion_evaluations pending
          ON pending.run_id = runs.run_id
        ORDER BY pending.finished_at ASC, pending.run_id ASC
        LIMIT ${limit}
      `,
  });

  const countActiveRunsRow = SqlSchema.findAll({
    Request: CountActiveAutomationRunsInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ automationId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const countActiveRunsByThreadRow = SqlSchema.findAll({
    Request: CountActiveAutomationRunsByThreadInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_runs
        WHERE thread_id = ${threadId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
      `,
  });

  const countPendingCompletionEvaluationsByThreadRow = SqlSchema.findAll({
    Request: CountPendingCompletionEvaluationsByThreadInput,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ threadId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM automation_pending_completion_evaluations pending
        WHERE pending.thread_id = ${threadId}
      `,
  });

  const listActiveRunsForDefinitionRows = SqlSchema.findAll({
    Request: ListActiveAutomationRunsForDefinitionInput,
    Result: AutomationRunDbRow,
    execute: ({ automationId }) =>
      sql`
        SELECT
          run_id AS "id",
          automation_id AS "automationId",
          project_id AS "projectId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          trigger_type AS "triggerType",
          status,
          scheduled_for AS "scheduledFor",
          claimed_by AS "claimedBy",
          claimed_at AS "claimedAt",
          lease_expires_at AS "leaseExpiresAt",
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          thread_create_command_id AS "threadCreateCommandId",
          turn_start_command_id AS "turnStartCommandId",
          message_id AS "messageId",
          error,
          result_json AS "result",
          permission_snapshot_json AS "permissionSnapshot",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM automation_runs
        WHERE automation_id = ${automationId}
          AND status IN ('pending', 'claimed', 'running', 'waiting-for-approval')
        ORDER BY created_at ASC, run_id ASC
      `,
  });

  const getEarliestNextRunAtRow = SqlSchema.findOneOption({
    Request: GetEarliestAutomationNextRunAtInput,
    Result: Schema.Struct({ nextRunAt: AutomationDefinition.fields.nextRunAt }),
    execute: () =>
      sql`
        SELECT definitions.next_run_at AS "nextRunAt"
        FROM automation_definitions definitions
        WHERE definitions.enabled = 1
          AND definitions.archived_at IS NULL
          AND definitions.next_run_at IS NOT NULL
          AND NOT (
            definitions.mode = 'heartbeat'
            AND definitions.target_thread_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM automation_pending_completion_evaluations pending
              WHERE pending.thread_id = definitions.target_thread_id
            )
          )
        ORDER BY definitions.next_run_at ASC, definitions.automation_id ASC
        LIMIT 1
      `,
  });

  const disableDefinitionRow = SqlSchema.void({
    Request: DisableAutomationDefinitionInput,
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = 0, next_run_at = NULL, updated_at = ${now}
        WHERE automation_id = ${id}
      `,
  });

  const disableDefinitionIfUnchangedRow = SqlSchema.findAll({
    Request: DisableAutomationDefinitionIfUnchangedInput,
    Result: Schema.Struct({ id: AutomationDefinition.fields.id }),
    execute: ({ id, expectedUpdatedAt, now }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = 0, next_run_at = NULL, updated_at = ${now}
        WHERE automation_id = ${id}
          AND enabled = 1
          AND archived_at IS NULL
          AND updated_at = ${expectedUpdatedAt}
        RETURNING automation_id AS "id"
      `,
  });

  const incrementIterationRow = SqlSchema.void({
    Request: IncrementAutomationIterationInput,
    execute: ({ id, now }) =>
      sql`
        UPDATE automation_definitions
        SET iteration_count = iteration_count + 1, updated_at = ${now}
        WHERE automation_id = ${id}
      `,
  });

  const restartDefinitionLoopRow = SqlSchema.void({
    Request: RestartAutomationDefinitionLoopInput,
    execute: ({ id, enabled, nextRunAt, updatedAt }) =>
      sql`
        UPDATE automation_definitions
        SET enabled = ${enabled ? 1 : 0},
            iteration_count = 0,
            next_run_at = ${nextRunAt},
            updated_at = ${updatedAt}
        WHERE automation_id = ${id}
      `,
  });

  const acquireLease = SqlSchema.findAll({
    Request: AcquireAutomationSchedulerLeaseInput,
    Result: Schema.Struct({ changed: Schema.Number }),
    execute: ({ leaseKey, ownerId, now, leaseExpiresAt }) =>
      sql`
        INSERT INTO automation_scheduler_leases (
          lease_key,
          owner_id,
          acquired_at,
          heartbeat_at,
          lease_expires_at
        )
        VALUES (${leaseKey}, ${ownerId}, ${now}, ${now}, ${leaseExpiresAt})
        ON CONFLICT (lease_key)
        DO UPDATE SET
          owner_id = excluded.owner_id,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at
        WHERE automation_scheduler_leases.owner_id = ${ownerId}
           OR automation_scheduler_leases.lease_expires_at <= ${now}
        RETURNING changes() AS changed
      `,
  });

  const createDefinition: AutomationRepositoryShape["createDefinition"] = (request) => {
    const { id, input, now } = request;
    const initialNextRunAt = Object.hasOwn(request, "nextRunAt")
      ? (request.nextRunAt ?? null)
      : input.schedule.type === "manual"
        ? null
        : now;
    const mode = input.mode ?? "standalone";
    const completionPolicy =
      mode === "standalone"
        ? { type: "none" as const }
        : (input.completionPolicy ?? { type: "none" as const });
    const definition: AutomationDefinition = {
      id,
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId ?? null,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      nextRunAt: initialNextRunAt,
      modelSelection: input.modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      runtimeMode: input.runtimeMode ?? DEFAULT_AUTOMATION_RUNTIME_MODE,
      interactionMode: input.interactionMode ?? "default",
      worktreeMode: input.worktreeMode ?? "auto",
      mode,
      targetThreadId: mode === "heartbeat" ? (input.targetThreadId ?? null) : null,
      maxIterations: input.maxIterations ?? null,
      stopOnError: input.stopOnError ?? true,
      completionPolicy,
      completionPolicyVersion: 1,
      completionPolicyUpdatedAt: now,
      minimumIntervalSeconds: input.minimumIntervalSeconds ?? 60,
      maxRuntimeSeconds: input.maxRuntimeSeconds === undefined ? 60 * 60 : input.maxRuntimeSeconds,
      retryPolicy: input.retryPolicy ?? { type: "none" },
      misfirePolicy: input.misfirePolicy ?? "coalesce",
      acknowledgedRisks: input.acknowledgedRisks ?? [],
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    return insertDefinition({
      ...definition,
      enabled: definition.enabled ? 1 : 0,
      stopOnError: definition.stopOnError ? 1 : 0,
      providerOptions: definition.providerOptions ?? null,
      completionPolicy: definition.completionPolicy ?? { type: "none" },
      completionPolicyVersion: definition.completionPolicyVersion ?? 1,
      completionPolicyUpdatedAt: definition.completionPolicyUpdatedAt ?? definition.createdAt,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.createDefinition:query")),
      Effect.as(definition),
    );
  };

  const saveDefinition: AutomationRepositoryShape["saveDefinition"] = (definition) =>
    updateDefinitionRow({
      ...definition,
      enabled: definition.enabled ? 1 : 0,
      stopOnError: definition.stopOnError ? 1 : 0,
      providerOptions: definition.providerOptions ?? null,
      completionPolicy: definition.completionPolicy ?? { type: "none" },
      completionPolicyVersion: definition.completionPolicyVersion ?? 1,
      completionPolicyUpdatedAt: definition.completionPolicyUpdatedAt ?? definition.createdAt,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.saveDefinition:update")),
      Effect.as(definition),
    );

  const getDefinitionById: AutomationRepositoryShape["getDefinitionById"] = (input) =>
    getDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getDefinitionById:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toDefinition(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listDueDefinitions: AutomationRepositoryShape["listDueDefinitions"] = (input) =>
    listDueDefinitionRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listDueDefinitions:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toDefinition, { concurrency: "unbounded" })),
    );

  const setDefinitionNextRunAt: AutomationRepositoryShape["setDefinitionNextRunAt"] = (input) =>
    setDefinitionNextRunAtRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.setDefinitionNextRunAt:update")),
    );

  const archiveDefinition: AutomationRepositoryShape["archiveDefinition"] = (input) =>
    archiveDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.archiveDefinition:query")),
    );

  const list: AutomationRepositoryShape["list"] = (input = {}) => {
    const normalized = {
      projectId: input.projectId,
      includeArchived: input.includeArchived ?? false,
    };
    return Effect.all({
      definitions: listDefinitionRows(normalized).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toDefinition, { concurrency: "unbounded" })),
      ),
      runs: listRunRows(normalized).pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
      ),
    }).pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.list:query")));
  };

  const createRun: AutomationRepositoryShape["createRun"] = (input) => {
    const run: AutomationRun = {
      id: input.id,
      automationId: input.automationId,
      projectId: input.projectId,
      threadId: input.threadId,
      trigger: input.trigger,
      status: "pending",
      scheduledFor: input.scheduledFor,
      claimedBy: null,
      claimedAt: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      threadCreateCommandId: input.threadCreateCommandId ?? null,
      turnStartCommandId: input.turnStartCommandId ?? null,
      messageId: input.messageId ?? null,
      error: null,
      result: null,
      permissionSnapshot: input.permissionSnapshot,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const decodeInserted = (rowOption: Option.Option<AutomationRunDbRow>) =>
      Option.match(rowOption, {
        onNone: () =>
          Effect.fail(
            toPersistenceDecodeCauseError("AutomationRepository.createRun:missingRow")(
              new Error("Automation run was not inserted or found."),
            ),
          ),
        onSome: toRun,
      });
    const decodeInsertedOrActiveThread = (rowOption: Option.Option<AutomationRunDbRow>) =>
      Option.match(rowOption, {
        onSome: toRun,
        onNone: () =>
          input.threadId
            ? getRunRowByThread({ threadId: input.threadId }).pipe(
                Effect.mapError(
                  toPersistenceSqlError("AutomationRepository.createRun:selectActiveThread"),
                ),
                Effect.flatMap(decodeInserted),
              )
            : decodeInserted(rowOption),
      });
    const inserted = insertRun({
      ...run,
      turnId: null,
      triggerType: run.trigger.type,
    }).pipe(Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:insert")));
    // Scheduled runs dedupe on (automationId, scheduledFor) via INSERT OR IGNORE +
    // the partial unique index, so a re-run of the same occurrence returns the existing
    // row. Manual runs are never deduped and are read back by their own run id.
    if (run.trigger.type === "scheduled") {
      return inserted.pipe(
        Effect.flatMap(() =>
          getRunRowByOccurrence({
            automationId: input.automationId,
            scheduledFor: input.scheduledFor,
          }).pipe(
            Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:select")),
            Effect.flatMap(decodeInsertedOrActiveThread),
          ),
        ),
      );
    }
    return inserted.pipe(
      Effect.flatMap(() =>
        getRunRowById({ id: input.id }).pipe(
          Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:select")),
          Effect.flatMap(decodeInsertedOrActiveThread),
        ),
      ),
    );
  };

  const getRunById: AutomationRepositoryShape["getRunById"] = (input) =>
    getRunRowById(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getRunById:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const requireRunById = (id: AutomationRunDbRow["id"], operation: string) =>
    getRunById({ id }).pipe(
      Effect.flatMap((runOption) =>
        Option.match(runOption, {
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError(`${operation}:missingRow`)(
                new Error("Automation run was not found after update."),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const markRunStarted: AutomationRepositoryShape["markRunStarted"] = (input) =>
    markRunStartedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunStarted:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunStarted")),
    );

  const markRunFailed: AutomationRepositoryShape["markRunFailed"] = (input) =>
    markRunFailedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunFailed:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunFailed")),
    );

  const markRunSkipped: AutomationRepositoryShape["markRunSkipped"] = (input) =>
    markRunSkippedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunSkipped:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunSkipped")),
    );

  const markRunSucceeded: AutomationRepositoryShape["markRunSucceeded"] = (input) =>
    markRunSucceededRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunSucceeded:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunSucceeded")),
    );

  const markRunResult: AutomationRepositoryShape["markRunResult"] = (input) =>
    markRunResultRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunResult:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunResult")),
    );

  const markRunCompletionResult: AutomationRepositoryShape["markRunCompletionResult"] = (input) =>
    markRunCompletionResultRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunCompletionResult:update")),
      Effect.flatMap(() =>
        requireRunById(input.id, "AutomationRepository.markRunCompletionResult"),
      ),
    );

  const markRunInterrupted: AutomationRepositoryShape["markRunInterrupted"] = (input) =>
    markRunInterruptedRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.markRunInterrupted:update")),
      Effect.flatMap(() => requireRunById(input.id, "AutomationRepository.markRunInterrupted")),
    );

  const markRunWaitingForApproval: AutomationRepositoryShape["markRunWaitingForApproval"] = (
    input,
  ) =>
    markRunWaitingForApprovalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.markRunWaitingForApproval:update"),
      ),
      Effect.flatMap(() =>
        requireRunById(input.id, "AutomationRepository.markRunWaitingForApproval"),
      ),
    );

  const cancelRun: AutomationRepositoryShape["cancelRun"] = ({ runId, now }) =>
    cancelRunRow({ id: runId, now }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.cancelRun:update")),
      Effect.flatMap(() => requireRunById(runId, "AutomationRepository.cancelRun")),
    );

  const getRunByThreadId: AutomationRepositoryShape["getRunByThreadId"] = (input) =>
    getRunRowByThread(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getRunByThreadId:query")),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => toRun(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listRecoverableRuns: AutomationRepositoryShape["listRecoverableRuns"] = (input) =>
    listRecoverableRunRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.listRecoverableRuns:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const listRunsNeedingCompletionEvaluation: AutomationRepositoryShape["listRunsNeedingCompletionEvaluation"] =
    (input) =>
      listRunsNeedingCompletionEvaluationRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.listRunsNeedingCompletionEvaluation:query"),
        ),
        Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
      );

  const countActiveRunsForDefinition: AutomationRepositoryShape["countActiveRunsForDefinition"] = (
    input,
  ) =>
    countActiveRunsRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.countActiveRunsForDefinition:query"),
      ),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const countActiveRunsForThread: AutomationRepositoryShape["countActiveRunsForThread"] = (input) =>
    countActiveRunsByThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.countActiveRunsForThread:query")),
      Effect.map((rows) => rows[0]?.count ?? 0),
    );

  const countPendingCompletionEvaluationsForThread: AutomationRepositoryShape["countPendingCompletionEvaluationsForThread"] =
    (input) =>
      countPendingCompletionEvaluationsByThreadRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "AutomationRepository.countPendingCompletionEvaluationsForThread:query",
          ),
        ),
        Effect.map((rows) => rows[0]?.count ?? 0),
      );

  const listActiveRunsForDefinition: AutomationRepositoryShape["listActiveRunsForDefinition"] = (
    input,
  ) =>
    listActiveRunsForDefinitionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.listActiveRunsForDefinition:query"),
      ),
      Effect.flatMap((rows) => Effect.forEach(rows, toRun, { concurrency: "unbounded" })),
    );

  const getEarliestNextRunAt: AutomationRepositoryShape["getEarliestNextRunAt"] = (input = {}) =>
    getEarliestNextRunAtRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.getEarliestNextRunAt:query")),
      Effect.map((rowOption) =>
        Option.match(rowOption, {
          onNone: () => null,
          onSome: (row) => row.nextRunAt,
        }),
      ),
    );

  const markRunRead: AutomationRepositoryShape["markRunRead"] = ({ runId, unread, now }) =>
    requireRunById(runId, "AutomationRepository.markRunRead:load").pipe(
      Effect.flatMap((run) =>
        markRunResult({
          id: run.id,
          result: { ...withResultDefaults(run), unread },
          updatedAt: now,
        }),
      ),
    );

  const archiveRun: AutomationRepositoryShape["archiveRun"] = ({ runId, archived, now }) =>
    requireRunById(runId, "AutomationRepository.archiveRun:load").pipe(
      Effect.flatMap((run) =>
        markRunResult({
          id: run.id,
          result: {
            ...withResultDefaults(run),
            unread: archived ? false : withResultDefaults(run).unread,
            archivedAt: archived ? now : null,
          },
          updatedAt: now,
        }),
      ),
    );

  const disableDefinition: AutomationRepositoryShape["disableDefinition"] = (input) =>
    disableDefinitionRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.disableDefinition:update")),
    );

  const disableDefinitionIfUnchanged: AutomationRepositoryShape["disableDefinitionIfUnchanged"] = (
    input,
  ) =>
    disableDefinitionIfUnchangedRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("AutomationRepository.disableDefinitionIfUnchanged:update"),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const incrementDefinitionIterationCount: AutomationRepositoryShape["incrementDefinitionIterationCount"] =
    (input) =>
      incrementIterationRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("AutomationRepository.incrementDefinitionIterationCount:update"),
        ),
      );

  const restartDefinitionLoop: AutomationRepositoryShape["restartDefinitionLoop"] = (input) =>
    restartDefinitionLoopRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.restartDefinitionLoop:update")),
    );

  const tryAcquireSchedulerLease: AutomationRepositoryShape["tryAcquireSchedulerLease"] = (input) =>
    acquireLease(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.tryAcquireLease:query")),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    createDefinition,
    saveDefinition,
    getDefinitionById,
    listDueDefinitions,
    setDefinitionNextRunAt,
    archiveDefinition,
    list,
    createRun,
    getRunById,
    markRunStarted,
    markRunFailed,
    markRunSkipped,
    markRunSucceeded,
    markRunResult,
    markRunCompletionResult,
    markRunInterrupted,
    markRunWaitingForApproval,
    cancelRun,
    getRunByThreadId,
    listRecoverableRuns,
    listRunsNeedingCompletionEvaluation,
    countActiveRunsForDefinition,
    countActiveRunsForThread,
    countPendingCompletionEvaluationsForThread,
    listActiveRunsForDefinition,
    getEarliestNextRunAt,
    markRunRead,
    archiveRun,
    disableDefinition,
    disableDefinitionIfUnchanged,
    incrementDefinitionIterationCount,
    restartDefinitionLoop,
    tryAcquireSchedulerLease,
  } satisfies AutomationRepositoryShape;
});

export const AutomationRepositoryLive = Layer.effect(
  AutomationRepository,
  makeAutomationRepository,
);
