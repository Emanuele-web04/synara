import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProject,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadRuntime,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../../persistence/Errors.ts";
import { ProjectionThreadRuntimeRepository } from "../../persistence/Services/ProjectionThreadRuntime.ts";
import { ProjectionThreadRuntimeRepositoryLive } from "../../persistence/Layers/ProjectionThreadRuntime.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  decodeReadModel,
  decodeShellSnapshot,
  decodeThreadDetail,
  decodeThreadDetailSnapshot,
} from "./ProjectionSnapshotQuery.schemas.ts";
import { makeSnapshotQueries } from "./ProjectionSnapshotQuery.queries.ts";
import { makeSnapshotLookups } from "./ProjectionSnapshotQuery.lookups.ts";
import {
  decodeProjectionProjectRows,
  decodeProjectionThreadOption,
  decodeProjectionThreadRows,
  toPersistenceSqlOrDecodeError,
} from "./ProjectionSnapshotQuery.decode.ts";
import {
  computeSnapshotSequence,
  maxIso,
  toProjectedActivity,
  toProjectedCheckpoint,
  toProjectedLatestTurn,
  toProjectedMessage,
  toProjectedProjectShell,
  toProjectedProposedPlan,
  toProjectedSession,
  toProjectedThread,
  toProjectedThreadShellFromStoredSummary,
  toThreadRuntime,
} from "./ProjectionSnapshotQuery.mappers.ts";

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectionThreadRuntimeRepository = yield* ProjectionThreadRuntimeRepository;

  const queries = makeSnapshotQueries(sql);
  const {
    listProjectRows,
    listThreadRows,
    listThreadMessageRows,
    listThreadProposedPlanRows,
    listThreadActivityRows,
    listThreadSessionRows,
    listCheckpointRows,
    listLatestTurnRows,
    listProjectionStateRows,
    getThreadRowById,
    getSyntheticSubagentParentThreadRow,
    listThreadMessageRowsByThread,
    listThreadProposedPlanRowsByThread,
    listThreadActivityRowsByThread,
    getThreadSessionRowByThread,
    getLatestTurnRowByThread,
    listCheckpointRowsByThread,
  } = queries;

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadMessageRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listCheckpointRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                  "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                  "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const runtimeRows = yield* projectionThreadRuntimeRepository.listReadModels();

          const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
          const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
          const runtimeByThread = new Map<string, OrchestrationThreadRuntime>();

          for (const row of runtimeRows) {
            runtimeByThread.set(row.threadId, toThreadRuntime(row));
          }

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          for (const row of messageRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadMessages = messagesByThread.get(row.threadId) ?? [];
            threadMessages.push(toProjectedMessage(row));
            messagesByThread.set(row.threadId, threadMessages);
          }

          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push(toProjectedProposedPlan(row));
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }

          for (const row of activityRows) {
            updatedAt = maxIso(updatedAt, row.createdAt);
            const threadActivities = activitiesByThread.get(row.threadId) ?? [];
            threadActivities.push(toProjectedActivity(row));
            activitiesByThread.set(row.threadId, threadActivities);
          }

          for (const row of checkpointRows) {
            updatedAt = maxIso(updatedAt, row.completedAt);
            const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
            threadCheckpoints.push(toProjectedCheckpoint(row));
            checkpointsByThread.set(row.threadId, threadCheckpoints);
          }

          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }

          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            kind: row.kind,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              messages: messagesByThread.get(row.threadId) ?? [],
              proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
              activities: activitiesByThread.get(row.threadId) ?? [],
              checkpoints: checkpointsByThread.get(row.threadId) ?? [],
              session: sessionsByThread.get(row.threadId) ?? null,
              runtime: runtimeByThread.get(row.threadId) ?? null,
            }),
          );

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeReadModel(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [
            projectRows,
            threadRows,
            proposedPlanRows,
            sessionRows,
            latestTurnRows,
            stateRows,
          ] = yield* Effect.all([
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionProjectRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeModelSelections",
                ),
              ),
            ),
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
                ),
              ),
              Effect.flatMap((rows) =>
                decodeProjectionThreadRows(
                  rows,
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeModelSelections",
                ),
              ),
            ),
            listThreadProposedPlanRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
                ),
              ),
            ),
            listThreadSessionRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
                ),
              ),
            ),
            listLatestTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
                ),
              ),
            ),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                  "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);

          const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of proposedPlanRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
            threadProposedPlans.push(toProjectedProposedPlan(row));
            proposedPlansByThread.set(row.threadId, threadProposedPlans);
          }
          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }
          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }

          const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
            id: row.projectId,
            kind: row.kind,
            title: row.title,
            workspaceRoot: row.workspaceRoot,
            defaultModelSelection: row.defaultModelSelection,
            scripts: row.scripts,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            deletedAt: row.deletedAt,
          }));

          const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) =>
            toProjectedThread({
              threadRow: row,
              latestTurn: latestTurnByThread.get(row.threadId) ?? null,
              messages: [],
              proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
              activities: [],
              checkpoints: [],
              session: sessionsByThread.get(row.threadId) ?? null,
              // The command read model is a lightweight decider input (no
              // messages/activities); runtime is hydrated at the read APIs.
              runtime: null,
            }),
          );

          return yield* decodeReadModel({
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects,
            threads,
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          }).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:decodeReadModel",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [projectRows, threadRows, sessionRows, latestTurnRows, stateRows] =
            yield* Effect.all([
              listProjectRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionProjectRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeModelSelections",
                  ),
                ),
              ),
              listThreadRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
                  ),
                ),
                Effect.flatMap((rows) =>
                  decodeProjectionThreadRows(
                    rows,
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeModelSelections",
                  ),
                ),
              ),
              listThreadSessionRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
                  ),
                ),
              ),
              listLatestTurnRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
                  ),
                ),
              ),
              listProjectionStateRows(undefined).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                    "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
                  ),
                ),
              ),
            ]);

          const runtimeRows = yield* projectionThreadRuntimeRepository.listReadModels();

          const sessionsByThread = new Map<string, OrchestrationSession>();
          const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
          const runtimeByThread = new Map<string, OrchestrationThreadRuntime>();

          for (const row of runtimeRows) {
            runtimeByThread.set(row.threadId, toThreadRuntime(row));
          }

          let updatedAt: string | null = null;

          for (const row of projectRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of threadRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of stateRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
          }
          for (const row of latestTurnRows) {
            updatedAt = maxIso(updatedAt, row.requestedAt);
            if (row.startedAt !== null) {
              updatedAt = maxIso(updatedAt, row.startedAt);
            }
            if (row.completedAt !== null) {
              updatedAt = maxIso(updatedAt, row.completedAt);
            }
            if (latestTurnByThread.has(row.threadId)) {
              continue;
            }
            latestTurnByThread.set(row.threadId, toProjectedLatestTurn(row));
          }
          for (const row of sessionRows) {
            updatedAt = maxIso(updatedAt, row.updatedAt);
            sessionsByThread.set(row.threadId, toProjectedSession(row));
          }

          const snapshot = {
            snapshotSequence: computeSnapshotSequence(stateRows),
            projects: projectRows
              .filter((row) => row.deletedAt === null)
              .map((row) => toProjectedProjectShell(row)),
            threads: threadRows
              .filter((row) => row.deletedAt === null)
              .map((row) =>
                toProjectedThreadShellFromStoredSummary({
                  threadRow: row,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  session: sessionsByThread.get(row.threadId) ?? null,
                  runtime: runtimeByThread.get(row.threadId) ?? null,
                }),
              ),
            updatedAt: updatedAt ?? new Date(0).toISOString(),
          };

          return yield* decodeShellSnapshot(snapshot).pipe(
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const {
    getCounts,
    getSnapshotSequence,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
  } = makeSnapshotLookups(queries);

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const threadRow = yield* getThreadRowById({ threadId }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
              ),
            ),
            Effect.flatMap((option) =>
              decodeProjectionThreadOption(
                option,
                "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeModelSelection",
              ),
            ),
          );
          if (Option.isNone(threadRow)) {
            return Option.none<OrchestrationThreadShell>();
          }

          const [latestTurnRow, sessionRow, runtimeRow] = yield* Effect.all([
            getLatestTurnRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
                ),
              ),
            ),
            getThreadSessionRowByThread({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
                  "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
                ),
              ),
            ),
            projectionThreadRuntimeRepository.getReadModelByThreadId({ threadId }),
          ]);

          return Option.some(
            toProjectedThreadShellFromStoredSummary({
              threadRow: threadRow.value,
              latestTurn: Option.match(latestTurnRow, {
                onNone: () => null,
                onSome: (row) => toProjectedLatestTurn(row),
              }),
              session: Option.match(sessionRow, {
                onNone: () => null,
                onSome: (row) => toProjectedSession(row),
              }),
              runtime: Option.match(runtimeRow, {
                onNone: () => null,
                onSome: (row) => toThreadRuntime(row),
              }),
            }),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadShellById:query")(error);
        }),
      );

  const findSyntheticSubagentParentThread: ProjectionSnapshotQueryShape["findSyntheticSubagentParentThread"] =
    (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const parentRow = yield* getSyntheticSubagentParentThreadRow({ threadId }).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:query",
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeRow",
                ),
              ),
              Effect.flatMap((option) =>
                decodeProjectionThreadOption(
                  option,
                  "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:getThread:decodeModelSelection",
                ),
              ),
            );
            if (Option.isNone(parentRow)) {
              return Option.none<OrchestrationThread>();
            }
            return yield* loadThreadDetail(parentRow.value.threadId);
          }),
        )
        .pipe(
          Effect.mapError((error) => {
            if (isPersistenceError(error)) {
              return error;
            }
            return toPersistenceSqlError(
              "ProjectionSnapshotQuery.findSyntheticSubagentParentThread:query",
            )(error);
          }),
        );

  // Hydrate a full thread detail projection without opening its own transaction.
  const loadThreadDetail = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadRowById({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionThreadOption(
            option,
            "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeModelSelection",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const [
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        runtimeRow,
      ] = yield* Effect.all([
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
        projectionThreadRuntimeRepository.getReadModelByThreadId({ threadId }),
      ]);

      const thread = toProjectedThread({
        threadRow: threadRow.value,
        latestTurn: Option.match(latestTurnRow, {
          onNone: () => null,
          onSome: (row) => toProjectedLatestTurn(row),
        }),
        messages: messageRows.map((row) => toProjectedMessage(row)),
        proposedPlans: proposedPlanRows.map((row) => toProjectedProposedPlan(row)),
        activities: activityRows.map((row) => toProjectedActivity(row)),
        checkpoints: checkpointRows.map((row) => toProjectedCheckpoint(row)),
        session: Option.match(sessionRow, {
          onNone: () => null,
          onSome: (row) => toProjectedSession(row),
        }),
        runtime: Option.match(runtimeRow, {
          onNone: () => null,
          onSome: (row) => toThreadRuntime(row),
        }),
      });

      return yield* decodeThreadDetail(thread).pipe(
        Effect.map((decodedThread) => Option.some(decodedThread)),
        Effect.mapError(
          toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    sql.withTransaction(loadThreadDetail(threadId)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailById:query")(error);
      }),
    );

  // Capture the projection cursor and thread detail in one transaction so the
  // snapshot fence cannot advance past the detail payload the client receives.
  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const [threadDetail, stateRows] = yield* Effect.all([
            loadThreadDetail(threadId),
            listProjectionStateRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:query",
                  "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:decodeRows",
                ),
              ),
            ),
          ]);
          if (Option.isNone(threadDetail)) {
            return Option.none<OrchestrationThreadDetailSnapshot>();
          }

          return yield* decodeThreadDetailSnapshot({
            snapshotSequence: computeSnapshotSequence(stateRows),
            thread: threadDetail.value,
          }).pipe(
            Effect.map((snapshot) => Option.some(snapshot)),
            Effect.mapError(
              toPersistenceDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeSnapshot",
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getCounts,
    getSnapshotSequence,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
    getThreadShellById,
    findSyntheticSubagentParentThread,
    getThreadDetailById,
    getThreadDetailSnapshotById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
).pipe(Layer.provideMerge(ProjectionThreadRuntimeRepositoryLive));
