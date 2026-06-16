import {
  AutomationDefinition,
  AutomationPermissionSnapshot,
  AutomationRun,
  AutomationSchedule,
  DEFAULT_AUTOMATION_RUNTIME_MODE,
  ModelSelection,
  ProviderStartOptions,
  ProjectId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type AutomationRepositoryError,
} from "../Errors.ts";
import {
  AcquireAutomationSchedulerLeaseInput,
  ArchiveAutomationDefinitionInput,
  AutomationRepository,
  type AutomationRepositoryShape,
  CreateAutomationDefinitionInput,
  CreateAutomationRunInput,
  GetAutomationDefinitionInput,
  GetAutomationRunInput,
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
  result: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  permissionSnapshot: Schema.fromJsonString(AutomationPermissionSnapshot),
  createdAt: AutomationRun.fields.createdAt,
  updatedAt: AutomationRun.fields.updatedAt,
});
type AutomationRunDbRow = typeof AutomationRunDbRow.Type;

const decodeDefinition = Schema.decodeUnknownEffect(AutomationDefinition);
const decodeRun = Schema.decodeUnknownEffect(AutomationRun);

function toDefinition(row: AutomationDefinitionDbRow) {
  return decodeDefinition({
    ...row,
    enabled: row.enabled === 1,
    providerOptions: row.providerOptions ?? undefined,
  }).pipe(
    Effect.mapError(toPersistenceDecodeError("AutomationRepository.definitionRowToDomain")),
  );
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
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE automation_id = ${id}
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
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt"
        FROM automation_definitions
        WHERE (${projectId ?? null} IS NULL OR project_id = ${projectId ?? null})
          AND (${includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
        ORDER BY updated_at DESC, automation_id ASC
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
        VALUES (
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

  const createDefinition: AutomationRepositoryShape["createDefinition"] = ({ id, input, now }) => {
    const definition: AutomationDefinition = {
      id,
      projectId: input.projectId,
      sourceThreadId: input.sourceThreadId ?? null,
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      nextRunAt: input.schedule.type === "manual" ? null : now,
      modelSelection: input.modelSelection,
      ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      runtimeMode: input.runtimeMode ?? DEFAULT_AUTOMATION_RUNTIME_MODE,
      interactionMode: input.interactionMode ?? "default",
      worktreeMode: input.worktreeMode ?? "auto",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    return insertDefinition({
      ...definition,
      enabled: definition.enabled ? 1 : 0,
      providerOptions: definition.providerOptions ?? null,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.createDefinition:query")),
      Effect.as(definition),
    );
  };

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
      threadCreateCommandId: null,
      turnStartCommandId: null,
      messageId: null,
      error: null,
      result: null,
      permissionSnapshot: input.permissionSnapshot,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return insertRun({
      ...run,
      turnId: null,
      triggerType: run.trigger.type,
    }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:insert")),
      Effect.flatMap(() =>
        getRunRowByOccurrence({
          automationId: input.automationId,
          scheduledFor: input.scheduledFor,
        }).pipe(
          Effect.mapError(toPersistenceSqlError("AutomationRepository.createRun:select")),
          Effect.flatMap((rowOption) =>
            Option.match(rowOption, {
              onNone: () =>
                Effect.fail(
                  toPersistenceSqlError("AutomationRepository.createRun:missingRow")(
                    new Error("Automation run was not inserted or found."),
                  ),
                ),
              onSome: toRun,
            }),
          ),
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

  const cancelRun: AutomationRepositoryShape["cancelRun"] = ({ runId, now }) =>
    cancelRunRow({ id: runId, now }).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.cancelRun:update")),
      Effect.flatMap(() => getRunById({ id: runId })),
      Effect.flatMap((runOption) =>
        Option.match(runOption, {
          onNone: () =>
            Effect.fail(
              toPersistenceSqlError("AutomationRepository.cancelRun:missingRow")(
                new Error("Automation run was not found after cancellation."),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const tryAcquireSchedulerLease: AutomationRepositoryShape["tryAcquireSchedulerLease"] = (
    input,
  ) =>
    acquireLease(input).pipe(
      Effect.mapError(toPersistenceSqlError("AutomationRepository.tryAcquireLease:query")),
      Effect.map((rows) => rows.length > 0),
    );

  return {
    createDefinition,
    getDefinitionById,
    archiveDefinition,
    list,
    createRun,
    getRunById,
    cancelRun,
    tryAcquireSchedulerLease,
  } satisfies AutomationRepositoryShape;
});

export const AutomationRepositoryLive = Layer.effect(
  AutomationRepository,
  makeAutomationRepository,
);
