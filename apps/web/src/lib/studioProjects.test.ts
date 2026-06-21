// FILE: studioProjects.test.ts
// Purpose: Verifies hidden Studio container detection and creation dispatches.
// Layer: Web orchestration tests

import { type ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useStore } from "../store";
import type { Project } from "../types";
import {
  ensureStudioProject,
  findStudioContainerProject,
  isStudioContainerProject,
} from "./studioProjects";

const nativeApiMock = vi.hoisted(() => ({
  dispatchedCommands: [] as unknown[],
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    orchestration: {
      dispatchCommand: async (command: unknown) => {
        nativeApiMock.dispatchedCommands.push(command);
      },
    },
  }),
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-studio" as ProjectId,
    kind: "studio",
    name: "Studio",
    remoteName: "Studio",
    folderName: "Studio",
    localName: null,
    cwd: "/Users/tester/Documents/Synara/Studio",
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
    ...overrides,
  };
}

describe("studioProjects", () => {
  beforeEach(() => {
    nativeApiMock.dispatchedCommands = [];
    useStore.setState({
      projects: [],
      threads: [],
      sidebarThreadSummaryById: {},
      threadIds: [],
      threadsHydrated: true,
    });
  });

  it("matches the configured Studio root and nested Studio paths", () => {
    const paths = {
      homeDir: "/Users/tester",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    };

    expect(isStudioContainerProject(makeProject(), paths)).toBe(true);
    expect(
      isStudioContainerProject(
        makeProject({ cwd: "/Users/tester/Documents/Synara/Studio/Outbox" }),
        paths,
      ),
    ).toBe(true);
  });

  it("rejects non-Studio project kinds and missing server Studio roots", () => {
    expect(
      isStudioContainerProject(makeProject({ kind: "project" }), {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(false);
    expect(isStudioContainerProject(makeProject(), { homeDir: "/Users/tester" })).toBe(false);
  });

  it("finds an existing Studio container project", () => {
    const ordinaryProject = makeProject({
      id: "project-app" as ProjectId,
      kind: "project",
      name: "App",
      cwd: "/Users/tester/Developer/app",
    });
    const studioProject = makeProject();

    expect(
      findStudioContainerProject([ordinaryProject, studioProject], {
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).toBe(studioProject);
  });

  it("creates the hidden Studio project with the real Studio root", async () => {
    const projectId = await ensureStudioProject({
      homeDir: "/Users/tester",
      chatWorkspaceRoot: "/Users/tester/Documents/Synara",
      studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
    });

    expect(projectId).toBeTruthy();
    expect(nativeApiMock.dispatchedCommands).toHaveLength(1);
    expect(nativeApiMock.dispatchedCommands[0]).toMatchObject({
      type: "project.create",
      projectId,
      kind: "studio",
      title: "Studio",
      workspaceRoot: "/Users/tester/Documents/Synara/Studio",
      createWorkspaceRootIfMissing: true,
    });
  });

  it("reuses the existing Studio project without dispatching create", async () => {
    const existingProject = makeProject({ id: "project-existing-studio" as ProjectId });
    useStore.setState({ projects: [existingProject] });

    await expect(
      ensureStudioProject({
        homeDir: "/Users/tester",
        studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
      }),
    ).resolves.toBe(existingProject.id);
    expect(nativeApiMock.dispatchedCommands).toEqual([]);
  });
});
