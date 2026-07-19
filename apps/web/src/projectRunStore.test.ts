import { ProjectId, WorktreeWorkspaceId, type ProjectDevServer } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  selectProjectRuns,
  selectWorkspaceProjectRun,
  useProjectRunStore,
} from "./projectRunStore";

const projectId = ProjectId.makeUnsafe("project-1");
const workspaceOne = WorktreeWorkspaceId.makeUnsafe("workspace-1");
const workspaceTwo = WorktreeWorkspaceId.makeUnsafe("workspace-2");

function makeRun(workspaceId: WorktreeWorkspaceId, command: string): ProjectDevServer {
  return {
    projectId,
    workspaceId,
    command,
    cwd: `/repo/worktrees/${workspaceId}`,
    pid: 100,
    startedAt: "2026-07-16T00:00:00.000Z",
    status: "running",
  };
}

beforeEach(() => {
  useProjectRunStore.setState({ runsByTargetKey: {}, runsByProjectId: {} });
});

describe("projectRunStore", () => {
  it("retains independent runs for two workspaces in one project", () => {
    const first = makeRun(workspaceOne, "bun dev:first");
    const second = makeRun(workspaceTwo, "bun dev:second");

    useProjectRunStore.getState().replaceAll([first, second]);
    const state = useProjectRunStore.getState();

    expect(selectWorkspaceProjectRun(state.runsByTargetKey, projectId, workspaceOne)).toBe(first);
    expect(selectWorkspaceProjectRun(state.runsByTargetKey, projectId, workspaceTwo)).toBe(second);
    expect(selectProjectRuns(state.runsByTargetKey, projectId)).toEqual([first, second]);
  });

  it("upserts and removes one workspace target without changing its sibling", () => {
    const first = makeRun(workspaceOne, "bun dev:first");
    const second = makeRun(workspaceTwo, "bun dev:second");
    useProjectRunStore.getState().replaceAll([first, second]);

    const updatedFirst = { ...first, pid: 101 };
    useProjectRunStore.getState().upsertRun(updatedFirst);
    useProjectRunStore.getState().removeRun({ projectId, workspaceId: workspaceTwo });
    const state = useProjectRunStore.getState();

    expect(selectProjectRuns(state.runsByTargetKey, projectId)).toEqual([updatedFirst]);
    expect(selectWorkspaceProjectRun(state.runsByTargetKey, projectId, workspaceTwo)).toBeNull();
  });

  it("keeps repository-root and workspace targets distinct", () => {
    const repositoryRoot = { ...makeRun(workspaceOne, "bun dev:root"), workspaceId: null };
    const workspace = makeRun(workspaceOne, "bun dev:workspace");

    useProjectRunStore.getState().replaceAll([repositoryRoot, workspace]);
    useProjectRunStore.getState().removeRun(projectId);
    const state = useProjectRunStore.getState();

    expect(selectProjectRuns(state.runsByTargetKey, projectId)).toEqual([workspace]);
    expect(state.runsByProjectId[projectId]).toBe(workspace);
  });
});
