// FILE: projectCreation.test.ts
// Purpose: Verifies shared project creation and duplicate-project recovery.
// Layer: Web helper tests
// Depends on: projectCreation helper plus mocked NativeApi orchestration calls.

import { type NativeApi, type OrchestrationShellSnapshot, type ProjectId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrRecoverProjectFromPath } from "./projectCreation";

const NOW_ISO = "2026-06-26T20:00:00.000Z";
const WORKSPACE_ROOT = "/Users/tester/Developer/synara";

function makeProject(id: string, workspaceRoot = WORKSPACE_ROOT) {
  return {
    id: id as ProjectId,
    kind: "project" as const,
    title: "synara",
    workspaceRoot,
    defaultModelSelection: {
      provider: "codex" as const,
      model: "gpt-5",
    },
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function makeSnapshot(
  projects: OrchestrationShellSnapshot["projects"],
): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 2,
    projects,
    threads: [],
    updatedAt: NOW_ISO,
  };
}

function makeApi(dispatchCommand: ReturnType<typeof vi.fn>): NativeApi {
  return {
    orchestration: {
      dispatchCommand,
    },
  } as unknown as NativeApi;
}

describe("createOrRecoverProjectFromPath", () => {
  it("dispatches project.create and returns the synced project", async () => {
    let createdProjectId: ProjectId | null = null;
    const dispatchCommand = vi.fn(async (command: { projectId?: ProjectId }) => {
      createdProjectId = command.projectId ?? null;
      return { sequence: 2 };
    });
    const loadSnapshot = vi.fn(async () =>
      makeSnapshot(createdProjectId ? [makeProject(createdProjectId)] : []),
    );

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "project.create",
        kind: "project",
        title: "synara",
        workspaceRoot: WORKSPACE_ROOT,
        createWorkspaceRootIfMissing: false,
      }),
    );
    expect(createdProjectId).not.toBeNull();
    expect(result).toMatchObject({
      projectId: createdProjectId,
      project: expect.objectContaining({ id: createdProjectId }),
      created: true,
    });
  });

  it("recovers the existing project when project.create reports a duplicate workspace root", async () => {
    const existingProject = makeProject("project-existing");
    const dispatchCommand = vi.fn(async () => {
      throw new Error(
        "Orchestration command invariant failed (project.create): Project 'project-existing' already uses workspace root '/Users/tester/Developer/synara'.",
      );
    });
    const loadSnapshot = vi.fn(async () => makeSnapshot([existingProject]));

    const result = await createOrRecoverProjectFromPath({
      api: makeApi(dispatchCommand),
      workspaceRoot: WORKSPACE_ROOT,
      loadSnapshot,
    });

    expect(result).toMatchObject({
      projectId: existingProject.id,
      project: existingProject,
      created: false,
    });
  });
});
