import { Effect } from "effect";

import type { ProjectionSnapshotQueryShape } from "../Services/ProjectionSnapshotQuery.ts";

/** every read dies with `unused` unless overridden — an unexpected read is a loud failure, not silent nonsense */
export function fakeProjectionSnapshotQuery(
  overrides: Partial<ProjectionSnapshotQueryShape> = {},
): ProjectionSnapshotQueryShape {
  const unused = (): never => Effect.die("unused") as never;
  return {
    getCommandReadModel: unused,
    getSnapshot: unused,
    getCounts: unused,
    getSnapshotSequence: unused,
    listStaleInFlightThreadIds: unused,
    listManagedWorktreeThreads: unused,
    getShellSnapshot: unused,
    getActiveProjectByWorkspaceRoot: unused,
    getProjectShellById: unused,
    getSpaceShellById: unused,
    getFirstActiveThreadIdByProjectId: unused,
    getThreadCheckpointContext: unused,
    listGeneratedImageActivitiesByTurn: unused,
    getFullThreadDiffContext: unused,
    getThreadShellById: unused,
    threadIdExistsIncludingDeleted: unused,
    findSyntheticSubagentParentThread: unused,
    getThreadDetailById: unused,
    getThreadDetailForExportById: unused,
    getThreadDetailSnapshotById: unused,
    ...overrides,
  };
}
