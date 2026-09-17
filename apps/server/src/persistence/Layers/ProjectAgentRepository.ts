import {
  ProjectActivity,
  ProjectAgentConfig,
  ProjectAgentLimits,
  ProjectAgentWorkerRouting,
  ProjectDigest,
  ProjectDigestFocusItem,
  ProjectDocumentHead,
  ProjectDocumentRevision,
  ProjectDocumentSource,
  ProjectEvidence,
  ProjectGoal,
  ProjectGoalId,
  ProjectId,
  ProjectInboxEvent,
  ProjectTask,
  ProjectTaskAttempt,
  ProjectTaskId,
  ProjectThreadIndexEntry,
  ModelSelection,
  ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  toPersistenceSqlOrDecodeError,
} from "../Errors.ts";
import {
  ProjectAgentReceipt,
  ProjectAgentRepository,
  type ProjectAgentRepositoryShape,
} from "../Services/ProjectAgentRepository.ts";

const ConfigRow = Schema.Struct({
  projectId: ProjectId,
  coordinatorThreadId: ThreadId,
  coordinatorName: ProjectAgentConfig.fields.coordinatorName,
  coordinatorModelSelection: Schema.fromJsonString(ModelSelection),
  coordinatorProviderOptions: Schema.NullOr(Schema.fromJsonString(ProviderStartOptions)),
  workerRouting: Schema.NullOr(Schema.fromJsonString(ProjectAgentWorkerRouting)),
  limits: Schema.fromJsonString(ProjectAgentLimits),
  captureEnabled: Schema.Number,
  enabled: Schema.Number,
  automationId: ProjectAgentConfig.fields.automationId,
  revision: ProjectAgentConfig.fields.revision,
  createdAt: ProjectAgentConfig.fields.createdAt,
  updatedAt: ProjectAgentConfig.fields.updatedAt,
  disabledAt: ProjectAgentConfig.fields.disabledAt,
});

const GoalRow = Schema.Struct({
  id: ProjectGoal.fields.id,
  projectId: ProjectId,
  objective: ProjectGoal.fields.objective,
  authorizationSource: ProjectGoal.fields.authorizationSource,
  scopeVersion: ProjectGoal.fields.scopeVersion,
  acceptanceCriteria: ProjectGoal.fields.acceptanceCriteria,
  limits: Schema.fromJsonString(ProjectAgentLimits),
  status: ProjectGoal.fields.status,
  continuationCount: ProjectGoal.fields.continuationCount,
  workerCreationCount: ProjectGoal.fields.workerCreationCount,
  authorizedAt: ProjectGoal.fields.authorizedAt,
  revision: ProjectGoal.fields.revision,
  createdAt: ProjectGoal.fields.createdAt,
  updatedAt: ProjectGoal.fields.updatedAt,
});

const TaskRow = Schema.Struct({
  id: ProjectTask.fields.id,
  projectId: ProjectId,
  goalId: ProjectGoalId,
  title: ProjectTask.fields.title,
  description: ProjectTask.fields.description,
  acceptanceCriteria: ProjectTask.fields.acceptanceCriteria,
  status: ProjectTask.fields.status,
  assignedThreadId: ProjectTask.fields.assignedThreadId,
  repairCount: ProjectTask.fields.repairCount,
  archivedAt: ProjectTask.fields.archivedAt,
  revision: ProjectTask.fields.revision,
  createdAt: ProjectTask.fields.createdAt,
  updatedAt: ProjectTask.fields.updatedAt,
});

const DependencyRow = Schema.Struct({
  taskId: ProjectTaskId,
  dependsOnTaskId: ProjectTaskId,
});

const ChangedRow = Schema.Struct({ changed: Schema.Number });

function toConfig(row: typeof ConfigRow.Type): ProjectAgentConfig {
  return {
    projectId: row.projectId,
    coordinatorThreadId: row.coordinatorThreadId,
    coordinatorName: row.coordinatorName,
    coordinatorModelSelection: row.coordinatorModelSelection,
    ...(row.coordinatorProviderOptions
      ? { coordinatorProviderOptions: row.coordinatorProviderOptions }
      : {}),
    ...(row.workerRouting ? { workerRouting: row.workerRouting } : {}),
    limits: row.limits,
    captureEnabled: row.captureEnabled === 1,
    enabled: row.enabled === 1,
    automationId: row.automationId,
    revision: row.revision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    disabledAt: row.disabledAt,
  };
}

function toGoal(row: typeof GoalRow.Type): ProjectGoal {
  return { ...row };
}

const makeProjectAgentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getConfigRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: ConfigRow,
    execute: ({ projectId }) => sql`
      SELECT
        project_id AS "projectId",
        coordinator_thread_id AS "coordinatorThreadId",
        coordinator_name AS "coordinatorName",
        coordinator_model_selection_json AS "coordinatorModelSelection",
        coordinator_provider_options_json AS "coordinatorProviderOptions",
        worker_routing_json AS "workerRouting",
        limits_json AS "limits",
        capture_enabled AS "captureEnabled",
        enabled,
        automation_id AS "automationId",
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        disabled_at AS "disabledAt"
      FROM project_agent_configs
      WHERE project_id = ${projectId}
    `,
  });

  const getConfigByCoordinatorRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: ConfigRow,
    execute: ({ threadId }) => sql`
      SELECT
        project_id AS "projectId",
        coordinator_thread_id AS "coordinatorThreadId",
        coordinator_name AS "coordinatorName",
        coordinator_model_selection_json AS "coordinatorModelSelection",
        coordinator_provider_options_json AS "coordinatorProviderOptions",
        worker_routing_json AS "workerRouting",
        limits_json AS "limits",
        capture_enabled AS "captureEnabled",
        enabled,
        automation_id AS "automationId",
        revision,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        disabled_at AS "disabledAt"
      FROM project_agent_configs
      WHERE coordinator_thread_id = ${threadId}
    `,
  });

  const insertConfig = SqlSchema.void({
    Request: ConfigRow,
    execute: (row) => sql`
      INSERT INTO project_agent_configs (
        project_id, coordinator_thread_id, coordinator_name,
        coordinator_model_selection_json, coordinator_provider_options_json,
        worker_routing_json, limits_json, capture_enabled, enabled, automation_id,
        revision, created_at, updated_at, disabled_at
      ) VALUES (
        ${row.projectId}, ${row.coordinatorThreadId}, ${row.coordinatorName},
        ${row.coordinatorModelSelection}, ${row.coordinatorProviderOptions},
        ${row.workerRouting}, ${row.limits}, ${row.captureEnabled}, ${row.enabled},
        ${row.automationId}, ${row.revision}, ${row.createdAt}, ${row.updatedAt}, ${row.disabledAt}
      )
    `,
  });

  const updateConfig = SqlSchema.findOne({
    Request: Schema.Struct({ row: ConfigRow, expectedRevision: Schema.Number }),
    Result: ChangedRow,
    execute: ({ row, expectedRevision }) => sql`
      UPDATE project_agent_configs SET
        coordinator_thread_id = ${row.coordinatorThreadId},
        coordinator_name = ${row.coordinatorName},
        coordinator_model_selection_json = ${row.coordinatorModelSelection},
        coordinator_provider_options_json = ${row.coordinatorProviderOptions},
        worker_routing_json = ${row.workerRouting},
        limits_json = ${row.limits},
        capture_enabled = ${row.captureEnabled},
        enabled = ${row.enabled},
        automation_id = ${row.automationId},
        revision = ${row.revision},
        updated_at = ${row.updatedAt},
        disabled_at = ${row.disabledAt}
      WHERE project_id = ${row.projectId} AND revision = ${expectedRevision}
      RETURNING changes() AS changed
    `,
  });

  const getActiveGoalRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: GoalRow,
    execute: ({ projectId }) => sql`
      SELECT
        goal_id AS "id", project_id AS "projectId", objective,
        authorization_source AS "authorizationSource", scope_version AS "scopeVersion",
        acceptance_criteria AS "acceptanceCriteria", limits_json AS "limits", status,
        continuation_count AS "continuationCount", worker_creation_count AS "workerCreationCount",
        authorized_at AS "authorizedAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_agent_goals
      WHERE project_id = ${projectId} AND status IN ('active', 'paused')
      ORDER BY updated_at DESC, goal_id DESC
      LIMIT 1
    `,
  });

  const getGoalRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ goalId: ProjectGoalId }),
    Result: GoalRow,
    execute: ({ goalId }) => sql`
      SELECT
        goal_id AS "id", project_id AS "projectId", objective,
        authorization_source AS "authorizationSource", scope_version AS "scopeVersion",
        acceptance_criteria AS "acceptanceCriteria", limits_json AS "limits", status,
        continuation_count AS "continuationCount", worker_creation_count AS "workerCreationCount",
        authorized_at AS "authorizedAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_agent_goals
      WHERE goal_id = ${goalId}
    `,
  });

  const insertGoal = SqlSchema.void({
    Request: GoalRow,
    execute: (row) => sql`
      INSERT INTO project_agent_goals (
        goal_id, project_id, objective, authorization_source, scope_version,
        acceptance_criteria, limits_json, status, continuation_count, worker_creation_count,
        authorized_at, revision, created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.projectId}, ${row.objective}, ${row.authorizationSource}, ${row.scopeVersion},
        ${row.acceptanceCriteria}, ${row.limits}, ${row.status}, ${row.continuationCount},
        ${row.workerCreationCount}, ${row.authorizedAt}, ${row.revision}, ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const updateGoal = SqlSchema.findOne({
    Request: Schema.Struct({ row: GoalRow, expectedRevision: Schema.Number }),
    Result: ChangedRow,
    execute: ({ row, expectedRevision }) => sql`
      UPDATE project_agent_goals SET
        objective = ${row.objective},
        scope_version = ${row.scopeVersion},
        acceptance_criteria = ${row.acceptanceCriteria},
        limits_json = ${row.limits},
        status = ${row.status},
        continuation_count = ${row.continuationCount},
        worker_creation_count = ${row.workerCreationCount},
        revision = ${row.revision},
        updated_at = ${row.updatedAt}
      WHERE goal_id = ${row.id} AND revision = ${expectedRevision}
      RETURNING changes() AS changed
    `,
  });

  const getTaskRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: TaskRow,
    execute: ({ taskId }) => sql`
      SELECT
        task_id AS "id", project_id AS "projectId", goal_id AS "goalId", title, description,
        acceptance_criteria AS "acceptanceCriteria", status,
        assigned_thread_id AS "assignedThreadId", repair_count AS "repairCount",
        archived_at AS "archivedAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_agent_tasks
      WHERE task_id = ${taskId}
    `,
  });

  const getTaskByThreadRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId }),
    Result: TaskRow,
    execute: ({ threadId }) => sql`
      SELECT
        task_id AS "id", project_id AS "projectId", goal_id AS "goalId", title, description,
        acceptance_criteria AS "acceptanceCriteria", status,
        assigned_thread_id AS "assignedThreadId", repair_count AS "repairCount",
        archived_at AS "archivedAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM project_agent_tasks
      WHERE assigned_thread_id = ${threadId}
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  });

  const insertTask = SqlSchema.void({
    Request: TaskRow,
    execute: (row) => sql`
      INSERT INTO project_agent_tasks (
        task_id, project_id, goal_id, title, description, acceptance_criteria, status,
        assigned_thread_id, repair_count, archived_at, revision, created_at, updated_at
      ) VALUES (
        ${row.id}, ${row.projectId}, ${row.goalId}, ${row.title}, ${row.description},
        ${row.acceptanceCriteria}, ${row.status}, ${row.assignedThreadId}, ${row.repairCount},
        ${row.archivedAt}, ${row.revision}, ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const updateTask = SqlSchema.findOne({
    Request: Schema.Struct({ row: TaskRow, expectedRevision: Schema.Number }),
    Result: ChangedRow,
    execute: ({ row, expectedRevision }) => sql`
      UPDATE project_agent_tasks SET
        title = ${row.title},
        description = ${row.description},
        acceptance_criteria = ${row.acceptanceCriteria},
        status = ${row.status},
        assigned_thread_id = ${row.assignedThreadId},
        repair_count = ${row.repairCount},
        archived_at = ${row.archivedAt},
        revision = ${row.revision},
        updated_at = ${row.updatedAt}
      WHERE task_id = ${row.id} AND revision = ${expectedRevision}
      RETURNING changes() AS changed
    `,
  });

  const replaceDependencies = (
    taskId: ProjectTaskId,
    projectId: ProjectId,
    dependsOn: ReadonlyArray<ProjectTaskId>,
  ) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM project_agent_task_dependencies WHERE task_id = ${taskId}`.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.replaceDependencies:delete")),
      );
      for (const dependsOnTaskId of dependsOn) {
        yield* sql`
          INSERT INTO project_agent_task_dependencies (task_id, depends_on_task_id, project_id)
          VALUES (${taskId}, ${dependsOnTaskId}, ${projectId})
        `.pipe(
          Effect.mapError(
            toPersistenceSqlError("ProjectAgentRepository.replaceDependencies:insert"),
          ),
        );
      }
    });

  const listDependencyRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId }),
    Result: DependencyRow,
    execute: ({ projectId }) => sql`
      SELECT task_id AS "taskId", depends_on_task_id AS "dependsOnTaskId"
      FROM project_agent_task_dependencies
      WHERE project_id = ${projectId}
    `,
  });

  const listTaskDependencies = SqlSchema.findAll({
    Request: Schema.Struct({ taskId: ProjectTaskId }),
    Result: Schema.Struct({ dependsOnTaskId: ProjectTaskId }),
    execute: ({ taskId }) => sql`
      SELECT depends_on_task_id AS "dependsOnTaskId"
      FROM project_agent_task_dependencies
      WHERE task_id = ${taskId}
    `,
  });

  const withTaskDeps = (row: typeof TaskRow.Type) =>
    listTaskDependencies({ taskId: row.id }).pipe(
      Effect.map(
        (deps): ProjectTask => ({
          ...row,
          dependsOnTaskIds: deps.map((dep) => dep.dependsOnTaskId),
        }),
      ),
      Effect.mapError(toPersistenceSqlOrDecodeError("ProjectAgentRepository.taskDeps", "taskDeps")),
    );

  const toConfigRow = (config: ProjectAgentConfig): typeof ConfigRow.Type => ({
    projectId: config.projectId,
    coordinatorThreadId: config.coordinatorThreadId,
    coordinatorName: config.coordinatorName,
    coordinatorModelSelection: config.coordinatorModelSelection,
    coordinatorProviderOptions: config.coordinatorProviderOptions ?? null,
    workerRouting: config.workerRouting ?? null,
    limits: config.limits,
    captureEnabled: config.captureEnabled ? 1 : 0,
    enabled: config.enabled ? 1 : 0,
    automationId: config.automationId,
    revision: config.revision,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    disabledAt: config.disabledAt,
  });

  const revisionMismatch = (operation: string) =>
    new (class extends Error {
      override readonly message = `${operation}: revision mismatch`;
    })();

  const impl: ProjectAgentRepositoryShape = {
    getConfig: (projectId) =>
      getConfigRow({ projectId }).pipe(
        Effect.map(Option.map(toConfig)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.getConfig", "config"),
        ),
      ),
    listConfigs: () =>
      SqlSchema.findAll({
        Request: Schema.Struct({}),
        Result: ConfigRow,
        execute: () => sql`
          SELECT
            project_id AS "projectId",
            coordinator_thread_id AS "coordinatorThreadId",
            coordinator_name AS "coordinatorName",
            coordinator_model_selection_json AS "coordinatorModelSelection",
            coordinator_provider_options_json AS "coordinatorProviderOptions",
            worker_routing_json AS "workerRouting",
            limits_json AS "limits",
            capture_enabled AS "captureEnabled",
            enabled,
            automation_id AS "automationId",
            revision,
            created_at AS "createdAt",
            updated_at AS "updatedAt",
            disabled_at AS "disabledAt"
          FROM project_agent_configs
        `,
      })({}).pipe(
        Effect.map((rows) => rows.map(toConfig)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.listConfigs", "config"),
        ),
      ),
    getConfigByCoordinatorThread: (threadId) =>
      getConfigByCoordinatorRow({ threadId }).pipe(
        Effect.map(Option.map(toConfig)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectAgentRepository.getConfigByCoordinatorThread",
            "config",
          ),
        ),
      ),
    saveConfig: (config, expectedRevision) => {
      const row = toConfigRow(config);
      if (expectedRevision === null) {
        return insertConfig(row).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveConfig:insert")),
          Effect.as(config),
        );
      }
      return updateConfig({ row, expectedRevision }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.saveConfig:update", "changed"),
        ),
        Effect.flatMap((result) =>
          result.changed === 1
            ? Effect.succeed(config)
            : Effect.fail(
                toPersistenceSqlError("ProjectAgentRepository.saveConfig")(
                  revisionMismatch("config"),
                ),
              ),
        ),
      );
    },
    getActiveGoal: (projectId) =>
      getActiveGoalRow({ projectId }).pipe(
        Effect.map(Option.map(toGoal)),
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.getActiveGoal", "goal"),
        ),
      ),
    getGoal: (goalId) =>
      getGoalRow({ goalId }).pipe(
        Effect.map(Option.map(toGoal)),
        Effect.mapError(toPersistenceSqlOrDecodeError("ProjectAgentRepository.getGoal", "goal")),
      ),
    saveGoal: (goal, expectedRevision) => {
      if (expectedRevision === null) {
        return insertGoal(goal).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveGoal:insert")),
          Effect.as(goal),
        );
      }
      return updateGoal({ row: goal, expectedRevision }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.saveGoal:update", "changed"),
        ),
        Effect.flatMap((result) =>
          result.changed === 1
            ? Effect.succeed(goal)
            : Effect.fail(
                toPersistenceSqlError("ProjectAgentRepository.saveGoal")(revisionMismatch("goal")),
              ),
        ),
      );
    },
    listTasks: (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<typeof TaskRow.Type>`
          SELECT
            task_id AS "id", project_id AS "projectId", goal_id AS "goalId", title, description,
            acceptance_criteria AS "acceptanceCriteria", status,
            assigned_thread_id AS "assignedThreadId", repair_count AS "repairCount",
            archived_at AS "archivedAt", revision, created_at AS "createdAt", updated_at AS "updatedAt"
          FROM project_agent_tasks
          WHERE project_id = ${input.projectId}
            AND (${input.goalId ?? null} IS NULL OR goal_id = ${input.goalId ?? null})
            AND (${input.includeArchived ? 1 : 0} = 1 OR archived_at IS NULL)
            AND (
              ${input.cursor?.createdAt ?? null} IS NULL
              OR created_at < ${input.cursor?.createdAt ?? ""}
              OR (created_at = ${input.cursor?.createdAt ?? ""} AND task_id < ${input.cursor?.id ?? ""})
            )
          ORDER BY created_at DESC, task_id DESC
          LIMIT ${input.limit}
        `.pipe(Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listTasks")));
        const decoded = yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(TaskRow)(row).pipe(
            Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.listTasks")),
            Effect.flatMap(withTaskDeps),
          ),
        );
        return decoded;
      }),
    getTask: (taskId) =>
      getTaskRow({ taskId }).pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () => Effect.succeed(Option.none<ProjectTask>()),
            onSome: (row) => withTaskDeps(row).pipe(Effect.map(Option.some)),
          }),
        ),
        Effect.mapError(toPersistenceSqlOrDecodeError("ProjectAgentRepository.getTask", "task")),
      ),
    saveTask: (task, expectedRevision) => {
      const row: typeof TaskRow.Type = {
        id: task.id,
        projectId: task.projectId,
        goalId: task.goalId,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        status: task.status,
        assignedThreadId: task.assignedThreadId,
        repairCount: task.repairCount,
        archivedAt: task.archivedAt,
        revision: task.revision,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      };
      const persistDeps = replaceDependencies(task.id, task.projectId, task.dependsOnTaskIds);
      if (expectedRevision === null) {
        return insertTask(row).pipe(
          Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveTask:insert")),
          Effect.andThen(persistDeps),
          Effect.as(task),
        );
      }
      return updateTask({ row, expectedRevision }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.saveTask:update", "changed"),
        ),
        Effect.flatMap((result) =>
          result.changed === 1
            ? persistDeps.pipe(Effect.as(task))
            : Effect.fail(
                toPersistenceSqlError("ProjectAgentRepository.saveTask")(revisionMismatch("task")),
              ),
        ),
      );
    },
    listTaskEdges: (projectId) =>
      listDependencyRows({ projectId }).pipe(
        Effect.map((rows) => {
          const edges = new Map<ProjectTaskId, ProjectTaskId[]>();
          for (const row of rows) {
            const current = edges.get(row.taskId) ?? [];
            current.push(row.dependsOnTaskId);
            edges.set(row.taskId, current);
          }
          return edges as ReadonlyMap<ProjectTaskId, ReadonlyArray<ProjectTaskId>>;
        }),
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.listTaskEdges", "deps"),
        ),
      ),
    saveAttempt: (attempt) =>
      sql`
        INSERT INTO project_agent_task_attempts (
          attempt_id, project_id, task_id, worker_thread_id, gateway_operation_id, request_id,
          attempt_number, outcome, error, created_at, finished_at
        ) VALUES (
          ${attempt.id}, ${attempt.projectId}, ${attempt.taskId}, ${attempt.workerThreadId},
          ${attempt.gatewayOperationId}, ${attempt.requestId}, ${attempt.attemptNumber},
          ${attempt.outcome}, ${attempt.error}, ${attempt.createdAt}, ${attempt.finishedAt}
        )
        ON CONFLICT (request_id) DO UPDATE SET
          outcome = excluded.outcome,
          error = excluded.error,
          finished_at = excluded.finished_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveAttempt")),
        Effect.as(attempt),
      ),
    getAttemptByRequestId: (requestId) =>
      sql<ProjectTaskAttempt>`
        SELECT
          attempt_id AS "id", project_id AS "projectId", task_id AS "taskId",
          worker_thread_id AS "workerThreadId", gateway_operation_id AS "gatewayOperationId",
          request_id AS "requestId", attempt_number AS "attemptNumber", outcome, error,
          created_at AS "createdAt", finished_at AS "finishedAt"
        FROM project_agent_task_attempts
        WHERE request_id = ${requestId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.getAttemptByRequestId")),
        Effect.flatMap((rows) =>
          rows[0]
            ? Schema.decodeUnknownEffect(ProjectTaskAttempt)(rows[0]).pipe(
                Effect.map(Option.some),
                Effect.mapError(
                  toPersistenceDecodeError("ProjectAgentRepository.getAttemptByRequestId"),
                ),
              )
            : Effect.succeed(Option.none()),
        ),
      ),
    listAttemptsForTask: (taskId) =>
      sql<ProjectTaskAttempt>`
        SELECT
          attempt_id AS "id", project_id AS "projectId", task_id AS "taskId",
          worker_thread_id AS "workerThreadId", gateway_operation_id AS "gatewayOperationId",
          request_id AS "requestId", attempt_number AS "attemptNumber", outcome, error,
          created_at AS "createdAt", finished_at AS "finishedAt"
        FROM project_agent_task_attempts
        WHERE task_id = ${taskId}
        ORDER BY attempt_number DESC
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listAttemptsForTask")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ProjectTaskAttempt)(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProjectAgentRepository.listAttemptsForTask"),
              ),
            ),
          ),
        ),
      ),
    saveEvidence: (evidence) =>
      sql`
        INSERT INTO project_agent_evidence (
          evidence_id, project_id, task_id, attempt_id, kind, classification, author_kind,
          author_thread_id, source_thread_id, source_message_id, source_turn_id, summary, created_at
        ) VALUES (
          ${evidence.id}, ${evidence.projectId}, ${evidence.taskId}, ${evidence.attemptId},
          ${evidence.kind}, ${evidence.classification}, ${evidence.authorKind},
          ${evidence.authorThreadId}, ${evidence.sourceThreadId}, ${evidence.sourceMessageId},
          ${evidence.sourceTurnId}, ${evidence.summary}, ${evidence.createdAt}
        )
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveEvidence")),
        Effect.as(evidence),
      ),
    listEvidenceForTask: (taskId) =>
      sql<ProjectEvidence>`
        SELECT
          evidence_id AS "id", project_id AS "projectId", task_id AS "taskId", attempt_id AS "attemptId",
          kind, classification, author_kind AS "authorKind", author_thread_id AS "authorThreadId",
          source_thread_id AS "sourceThreadId", source_message_id AS "sourceMessageId",
          source_turn_id AS "sourceTurnId", summary, created_at AS "createdAt"
        FROM project_agent_evidence
        WHERE task_id = ${taskId}
        ORDER BY created_at DESC
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listEvidenceForTask")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ProjectEvidence)(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProjectAgentRepository.listEvidenceForTask"),
              ),
            ),
          ),
        ),
      ),
    getDocumentHead: (projectId, logicalPath) =>
      sql<typeof ProjectDocumentHead.Type>`
        SELECT
          project_id AS "projectId", logical_path AS "logicalPath", revision,
          content_hash AS "contentHash", disk_hash AS "diskHash",
          conflict_pending AS "conflictPending", updated_at AS "updatedAt"
        FROM project_agent_document_heads
        WHERE project_id = ${projectId} AND logical_path = ${logicalPath}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.getDocumentHead")),
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed(Option.none());
          return Schema.decodeUnknownEffect(ProjectDocumentHead)({
            ...row,
            conflictPending: row.conflictPending === true || row.conflictPending === 1,
          }).pipe(
            Effect.map(Option.some),
            Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.getDocumentHead")),
          );
        }),
      ),
    listDocumentHeads: (projectId) =>
      sql<Record<string, unknown>>`
        SELECT
          project_id AS "projectId", logical_path AS "logicalPath", revision,
          content_hash AS "contentHash", disk_hash AS "diskHash",
          conflict_pending AS "conflictPending", updated_at AS "updatedAt"
        FROM project_agent_document_heads
        WHERE project_id = ${projectId}
        ORDER BY logical_path ASC
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listDocumentHeads")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ProjectDocumentHead)({
              ...row,
              conflictPending: row.conflictPending === true || row.conflictPending === 1,
            }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.listDocumentHeads")),
            ),
          ),
        ),
      ),
    readDocumentRevision: (input) =>
      sql<ProjectDocumentRevision>`
        SELECT
          revision_id AS "id", project_id AS "projectId", logical_path AS "logicalPath", revision,
          content, content_hash AS "contentHash", author_kind AS "authorKind",
          author_thread_id AS "authorThreadId", sources_json AS "sources", created_at AS "createdAt"
        FROM project_agent_documents
        WHERE project_id = ${input.projectId}
          AND logical_path = ${input.logicalPath}
          AND (${input.revision ?? null} IS NULL OR revision = ${input.revision ?? 0})
        ORDER BY revision DESC
        LIMIT 1
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.readDocumentRevision")),
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed(Option.none());
          const sources =
            typeof (row as { sources?: unknown }).sources === "string"
              ? JSON.parse((row as { sources: string }).sources)
              : (row as { sources?: unknown }).sources;
          return Schema.decodeUnknownEffect(ProjectDocumentRevision)({ ...row, sources }).pipe(
            Effect.map(Option.some),
            Effect.mapError(
              toPersistenceDecodeError("ProjectAgentRepository.readDocumentRevision"),
            ),
          );
        }),
      ),
    listDocumentHistory: (input) =>
      sql<Pick<ProjectDocumentRevision, "revision" | "contentHash" | "authorKind" | "createdAt">>`
        SELECT revision, content_hash AS "contentHash", author_kind AS "authorKind", created_at AS "createdAt"
        FROM project_agent_documents
        WHERE project_id = ${input.projectId} AND logical_path = ${input.logicalPath}
        ORDER BY revision DESC
        LIMIT 50
      `.pipe(Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listDocumentHistory"))),
    writeDocument: (input) =>
      Effect.gen(function* () {
        const { revision, expectedRevision } = input;
        if (expectedRevision !== null && expectedRevision !== revision.revision - 1) {
          return yield* Effect.fail(
            toPersistenceSqlError("ProjectAgentRepository.writeDocument")(
              revisionMismatch("document"),
            ),
          );
        }
        if (expectedRevision !== null) {
          const head = yield* impl.getDocumentHead(revision.projectId, revision.logicalPath);
          if (Option.isNone(head) || head.value.revision !== expectedRevision) {
            return yield* Effect.fail(
              toPersistenceSqlError("ProjectAgentRepository.writeDocument")(
                revisionMismatch("document"),
              ),
            );
          }
        }
        yield* sql`
          INSERT INTO project_agent_documents (
            revision_id, project_id, logical_path, revision, content, content_hash,
            author_kind, author_thread_id, sources_json, created_at
          ) VALUES (
            ${revision.id}, ${revision.projectId}, ${revision.logicalPath}, ${revision.revision},
            ${revision.content}, ${revision.contentHash}, ${revision.authorKind},
            ${revision.authorThreadId}, ${JSON.stringify(revision.sources)}, ${revision.createdAt}
          )
        `.pipe(
          Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.writeDocument:insert")),
        );
        yield* sql`
          INSERT INTO project_agent_document_heads (
            project_id, logical_path, revision, content_hash, disk_hash, conflict_pending, updated_at
          ) VALUES (
            ${revision.projectId}, ${revision.logicalPath}, ${revision.revision}, ${revision.contentHash},
            ${input.diskHash ?? revision.contentHash}, ${input.conflictPending ? 1 : 0}, ${revision.createdAt}
          )
          ON CONFLICT (project_id, logical_path) DO UPDATE SET
            revision = excluded.revision,
            content_hash = excluded.content_hash,
            disk_hash = excluded.disk_hash,
            conflict_pending = excluded.conflict_pending,
            updated_at = excluded.updated_at
        `.pipe(Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.writeDocument:head")));
        return revision;
      }),
    nextActivitySequence: (projectId) =>
      sql<{ readonly next: number }>`
        SELECT COALESCE(MAX(sequence), 0) + 1 AS next
        FROM project_agent_activity
        WHERE project_id = ${projectId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.nextActivitySequence")),
        Effect.map((rows) => rows[0]?.next ?? 1),
      ),
    appendActivity: (activity) =>
      sql`
        INSERT INTO project_agent_activity (
          activity_id, project_id, sequence, kind, actor_kind, actor_thread_id, goal_id, task_id,
          source_json, summary, created_at
        ) VALUES (
          ${activity.id}, ${activity.projectId}, ${activity.sequence}, ${activity.kind},
          ${activity.actorKind}, ${activity.actorThreadId}, ${activity.goalId}, ${activity.taskId},
          ${JSON.stringify(activity.source)}, ${activity.summary}, ${activity.createdAt}
        )
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.appendActivity")),
        Effect.as(activity),
      ),
    listActivity: (input) =>
      sql<ProjectActivity>`
        SELECT
          activity_id AS "id", project_id AS "projectId", sequence, kind,
          actor_kind AS "actorKind", actor_thread_id AS "actorThreadId",
          goal_id AS "goalId", task_id AS "taskId", source_json AS "source",
          summary, created_at AS "createdAt"
        FROM project_agent_activity
        WHERE project_id = ${input.projectId}
          AND (
            ${input.cursor?.createdAt ?? null} IS NULL
            OR created_at < ${input.cursor?.createdAt ?? ""}
            OR (created_at = ${input.cursor?.createdAt ?? ""} AND activity_id < ${input.cursor?.id ?? ""})
          )
        ORDER BY sequence DESC
        LIMIT ${input.limit}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listActivity")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => {
            const source =
              typeof (row as { source?: unknown }).source === "string"
                ? JSON.parse((row as { source: string }).source)
                : (row as { source?: unknown }).source;
            return Schema.decodeUnknownEffect(ProjectActivity)({ ...row, source }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.listActivity")),
            );
          }),
        ),
      ),
    getDigest: (projectId) =>
      sql<Record<string, unknown>>`
        SELECT
          project_id AS "projectId", summary, focus_items_json AS "focusItems",
          coverage_from_sequence AS "coverageFromSequence", coverage_to_sequence AS "coverageToSequence",
          historical_coverage AS "historicalCoverage", summarized_thread_count AS "summarizedThreadCount",
          pending_thread_count AS "pendingThreadCount", generation_state AS "generationState",
          generated_at AS "generatedAt", last_good_at AS "lastGoodAt", last_error AS "lastError"
        FROM project_agent_digests
        WHERE project_id = ${projectId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.getDigest")),
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed(Option.none());
          const focusItems =
            typeof row.focusItems === "string" ? JSON.parse(row.focusItems) : row.focusItems;
          return Schema.decodeUnknownEffect(ProjectDigest)({ ...row, focusItems }).pipe(
            Effect.map(Option.some),
            Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.getDigest")),
          );
        }),
      ),
    saveDigest: (digest) =>
      sql`
        INSERT INTO project_agent_digests (
          project_id, summary, focus_items_json, coverage_from_sequence, coverage_to_sequence,
          historical_coverage, summarized_thread_count, pending_thread_count, generation_state,
          generated_at, last_good_at, last_error, pinned_focus_json
        ) VALUES (
          ${digest.projectId}, ${digest.summary}, ${JSON.stringify(digest.focusItems)},
          ${digest.coverageFromSequence}, ${digest.coverageToSequence}, ${digest.historicalCoverage},
          ${digest.summarizedThreadCount}, ${digest.pendingThreadCount}, ${digest.generationState},
          ${digest.generatedAt}, ${digest.lastGoodAt}, ${digest.lastError},
          ${JSON.stringify(digest.focusItems.filter((item) => item.pinned))}
        )
        ON CONFLICT (project_id) DO UPDATE SET
          summary = excluded.summary,
          focus_items_json = excluded.focus_items_json,
          coverage_from_sequence = excluded.coverage_from_sequence,
          coverage_to_sequence = excluded.coverage_to_sequence,
          historical_coverage = excluded.historical_coverage,
          summarized_thread_count = excluded.summarized_thread_count,
          pending_thread_count = excluded.pending_thread_count,
          generation_state = excluded.generation_state,
          generated_at = excluded.generated_at,
          last_good_at = excluded.last_good_at,
          last_error = excluded.last_error,
          pinned_focus_json = excluded.pinned_focus_json
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveDigest")),
        Effect.as(digest),
      ),
    upsertThreadIndex: (entry) =>
      sql`
        INSERT INTO project_agent_thread_index (
          project_id, thread_id, excluded, archived, summary_status, last_updated_at, last_summarized_at
        ) VALUES (
          ${entry.projectId}, ${entry.threadId}, ${entry.excluded ? 1 : 0}, ${entry.archived ? 1 : 0},
          ${entry.summaryStatus}, ${entry.lastUpdatedAt}, ${entry.lastSummarizedAt}
        )
        ON CONFLICT (project_id, thread_id) DO UPDATE SET
          excluded = excluded.excluded,
          archived = excluded.archived,
          summary_status = excluded.summary_status,
          last_updated_at = excluded.last_updated_at,
          last_summarized_at = excluded.last_summarized_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.upsertThreadIndex")),
        Effect.asVoid,
      ),
    listThreadIndex: (projectId) =>
      sql<Record<string, unknown>>`
        SELECT
          project_id AS "projectId", thread_id AS "threadId", excluded, archived,
          summary_status AS "summaryStatus", last_updated_at AS "lastUpdatedAt",
          last_summarized_at AS "lastSummarizedAt"
        FROM project_agent_thread_index
        WHERE project_id = ${projectId}
        ORDER BY last_updated_at DESC
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listThreadIndex")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ProjectThreadIndexEntry)({
              ...row,
              excluded: row.excluded === 1 || row.excluded === true,
              archived: row.archived === 1 || row.archived === true,
            }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.listThreadIndex")),
            ),
          ),
        ),
      ),
    insertInboxEvent: (event) =>
      sql<{ readonly inbox_id: string }>`
        INSERT INTO project_agent_event_inbox (
          inbox_id, project_id, source_thread_id, source_event_id, event_type, task_id, eligible_wake, created_at
        ) VALUES (
          ${event.id}, ${event.projectId}, ${event.sourceThreadId}, ${event.sourceEventId},
          ${event.eventType}, ${event.taskId}, ${event.eligibleWake ? 1 : 0}, ${event.createdAt}
        )
        ON CONFLICT (source_event_id) DO NOTHING
        RETURNING inbox_id
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.insertInboxEvent")),
        Effect.map((rows) => ({ inserted: rows.length > 0, event })),
      ),
    listInboxAfter: (input) =>
      sql<Record<string, unknown>>`
        SELECT
          inbox_id AS "id", project_id AS "projectId", source_thread_id AS "sourceThreadId",
          source_event_id AS "sourceEventId", event_type AS "eventType", task_id AS "taskId",
          eligible_wake AS "eligibleWake", created_at AS "createdAt"
        FROM project_agent_event_inbox
        WHERE project_id = ${input.projectId}
          AND (${input.afterId ?? null} IS NULL OR inbox_id > ${input.afterId ?? ""})
        ORDER BY created_at ASC, inbox_id ASC
        LIMIT ${input.limit}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.listInboxAfter")),
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknownEffect(ProjectInboxEvent)({
              ...row,
              eligibleWake: row.eligibleWake === 1 || row.eligibleWake === true,
            }).pipe(
              Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.listInboxAfter")),
            ),
          ),
        ),
      ),
    getCursor: (projectId) =>
      sql<{
        readonly processedThroughInboxId: string | null;
        readonly frozenFromInboxId: string | null;
        readonly frozenToInboxId: string | null;
        readonly coordinatorBusy: number;
      }>`
        SELECT
          processed_through_inbox_id AS "processedThroughInboxId",
          frozen_from_inbox_id AS "frozenFromInboxId",
          frozen_to_inbox_id AS "frozenToInboxId",
          coordinator_busy AS "coordinatorBusy"
        FROM project_agent_cursors
        WHERE project_id = ${projectId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.getCursor")),
        Effect.map((rows) => {
          const row = rows[0];
          return {
            processedThroughInboxId: row?.processedThroughInboxId ?? null,
            frozenFromInboxId: row?.frozenFromInboxId ?? null,
            frozenToInboxId: row?.frozenToInboxId ?? null,
            coordinatorBusy: row?.coordinatorBusy === 1,
          };
        }),
      ),
    saveCursor: (input) =>
      sql`
        INSERT INTO project_agent_cursors (
          project_id, processed_through_inbox_id, frozen_from_inbox_id, frozen_to_inbox_id,
          coordinator_busy, updated_at
        ) VALUES (
          ${input.projectId}, ${input.processedThroughInboxId}, ${input.frozenFromInboxId},
          ${input.frozenToInboxId}, ${input.coordinatorBusy ? 1 : 0}, ${input.updatedAt}
        )
        ON CONFLICT (project_id) DO UPDATE SET
          processed_through_inbox_id = excluded.processed_through_inbox_id,
          frozen_from_inbox_id = excluded.frozen_from_inbox_id,
          frozen_to_inbox_id = excluded.frozen_to_inbox_id,
          coordinator_busy = excluded.coordinator_busy,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveCursor")),
        Effect.asVoid,
      ),
    getReceipt: (requestId) =>
      sql<ProjectAgentReceipt>`
        SELECT request_id AS "requestId", project_id AS "projectId", operation,
          result_json AS "resultJson", created_at AS "createdAt"
        FROM project_agent_receipts
        WHERE request_id = ${requestId}
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.getReceipt")),
        Effect.flatMap((rows) =>
          rows[0]
            ? Schema.decodeUnknownEffect(ProjectAgentReceipt)(rows[0]).pipe(
                Effect.map(Option.some),
                Effect.mapError(toPersistenceDecodeError("ProjectAgentRepository.getReceipt")),
              )
            : Effect.succeed(Option.none()),
        ),
      ),
    saveReceipt: (receipt) =>
      sql`
        INSERT INTO project_agent_receipts (request_id, project_id, operation, result_json, created_at)
        VALUES (${receipt.requestId}, ${receipt.projectId}, ${receipt.operation}, ${receipt.resultJson}, ${receipt.createdAt})
        ON CONFLICT (request_id) DO NOTHING
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.saveReceipt")),
        Effect.asVoid,
      ),
    countRunningWorkers: (projectId) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count
        FROM project_agent_tasks
        WHERE project_id = ${projectId} AND status = 'running' AND archived_at IS NULL
      `.pipe(
        Effect.mapError(toPersistenceSqlError("ProjectAgentRepository.countRunningWorkers")),
        Effect.map((rows) => rows[0]?.count ?? 0),
      ),
    findTaskByAssignedThread: (threadId) =>
      getTaskByThreadRow({ threadId }).pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () => Effect.succeed(Option.none<ProjectTask>()),
            onSome: (row) => withTaskDeps(row).pipe(Effect.map(Option.some)),
          }),
        ),
        Effect.mapError(
          toPersistenceSqlOrDecodeError("ProjectAgentRepository.findTaskByAssignedThread", "task"),
        ),
      ),
  };

  return impl;
});

export const ProjectAgentRepositoryLive = Layer.effect(
  ProjectAgentRepository,
  makeProjectAgentRepository,
);
