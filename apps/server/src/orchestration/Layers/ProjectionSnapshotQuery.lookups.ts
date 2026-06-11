// Purpose: Targeted single-row / lightweight projection lookups (counts, sequence,
//   project + checkpoint + diff context) that read without a snapshot transaction.
// Layer: orchestration projection read path. Pure over SnapshotQueries.
// Exports: makeSnapshotLookups(queries).
import type { OrchestrationCheckpointSummary, OrchestrationProject } from "@t3tools/contracts";
import { Effect, Option } from "effect";

import {
  type ProjectionFullThreadDiffContext,
  type ProjectionSnapshotCounts,
  type ProjectionSnapshotSequence,
  type ProjectionSnapshotQueryShape,
  type ProjectionThreadCheckpointContext,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  toPersistenceSqlOrDecodeError,
  decodeProjectionProjectOption,
} from "./ProjectionSnapshotQuery.decode.ts";
import {
  computeSnapshotSequence,
  toProjectedProjectShell,
} from "./ProjectionSnapshotQuery.mappers.ts";
import { type SnapshotQueries } from "./ProjectionSnapshotQuery.queries.ts";

export const makeSnapshotLookups = (queries: SnapshotQueries) => {
  const {
    readProjectionCounts,
    listProjectionStateRows,
    getActiveProjectRowByWorkspaceRoot,
    getProjectRowById,
    getFirstActiveThreadIdByProject,
    getThreadCheckpointContextThreadRow,
    listCheckpointRowsByThread,
    getFullThreadDiffContextRow,
  } = queries;

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map(
        (stateRows): ProjectionSnapshotSequence => ({
          snapshotSequence: computeSnapshotSequence(stateRows),
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          decodeProjectionProjectOption(
            option,
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeModelSelection",
          ),
        ),
        Effect.map((option) =>
          Option.map(
            option,
            (row): OrchestrationProject => ({
              id: row.projectId,
              kind: row.kind,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection: row.defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            }),
          ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        decodeProjectionProjectOption(
          option,
          "ProjectionSnapshotQuery.getProjectShellById:decodeModelSelection",
        ),
      ),
      Effect.map((option) => Option.map(option, (row) => toProjectedProjectShell(row))),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        envMode: threadRow.value.envMode,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getFullThreadDiffContext: ProjectionSnapshotQueryShape["getFullThreadDiffContext"] = (
    threadId,
    toTurnCount,
  ) =>
    Effect.gen(function* () {
      const row = yield* getFullThreadDiffContextRow({
        threadId,
        checkpointTurnCount: toTurnCount,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFullThreadDiffContext:query",
            "ProjectionSnapshotQuery.getFullThreadDiffContext:decodeRow",
          ),
        ),
      );
      if (Option.isNone(row)) {
        return Option.none<ProjectionFullThreadDiffContext>();
      }

      return Option.some({
        threadId: row.value.threadId,
        projectId: row.value.projectId,
        workspaceRoot: row.value.workspaceRoot,
        envMode: row.value.envMode,
        worktreePath: row.value.worktreePath,
        latestCheckpointTurnCount: row.value.latestCheckpointTurnCount ?? 0,
        toCheckpointRef: row.value.toCheckpointRef,
      });
    });

  return {
    getCounts,
    getSnapshotSequence,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getFullThreadDiffContext,
  };
};

export type SnapshotLookups = ReturnType<typeof makeSnapshotLookups>;
