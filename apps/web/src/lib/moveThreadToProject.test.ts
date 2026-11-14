import { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { makeProject, makeThread } from "~/storeTestFixtures";
import { canMoveThreadToProject, resolveMoveToProjectTargets } from "./moveThreadToProject";

const emptyPaths = {
  homeDir: null,
  chatWorkspaceRoot: null,
  studioWorkspaceRoot: null,
  groupsWorkspaceRoot: null,
};

describe("resolveMoveToProjectTargets", () => {
  it("lists ordinary projects except the current one, sorted by name", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("p-zulu"), name: "Zulu" }),
      makeProject({ id: ProjectId.makeUnsafe("p-alpha"), name: "Alpha" }),
      makeProject({ id: ProjectId.makeUnsafe("p-current"), name: "Current" }),
    ];
    const targets = resolveMoveToProjectTargets({
      projects,
      currentProjectId: ProjectId.makeUnsafe("p-current"),
      workspacePaths: emptyPaths,
    });
    expect(targets.map((project) => project.name)).toEqual(["Alpha", "Zulu"]);
  });

  it("excludes hub, studio, and chat container projects", () => {
    const projects = [
      makeProject({ id: ProjectId.makeUnsafe("p-ordinary"), name: "Ordinary" }),
      makeProject({ id: ProjectId.makeUnsafe("p-hub"), name: "Hub", kind: "group" }),
      makeProject({ id: ProjectId.makeUnsafe("p-studio"), name: "Studio", kind: "studio" }),
      makeProject({ id: ProjectId.makeUnsafe("p-chats"), name: "Chats", kind: "chat" }),
    ];
    const targets = resolveMoveToProjectTargets({
      projects,
      currentProjectId: ProjectId.makeUnsafe("p-elsewhere"),
      workspacePaths: emptyPaths,
    });
    expect(targets.map((project) => project.id)).toEqual([ProjectId.makeUnsafe("p-ordinary")]);
  });
});

describe("canMoveThreadToProject", () => {
  const source = makeProject({ id: ProjectId.makeUnsafe("p-source") });

  it("allows an ordinary top-level thread in an ordinary project", () => {
    expect(
      canMoveThreadToProject({
        thread: makeThread(),
        sourceProject: source,
        workspacePaths: emptyPaths,
        isCoordinatorThread: false,
      }),
    ).toBe(true);
  });

  it("refuses threads inside container projects, coordinator threads, and subagent children", () => {
    const hubSource = makeProject({ id: ProjectId.makeUnsafe("p-hub"), kind: "group" });
    expect(
      canMoveThreadToProject({
        thread: makeThread(),
        sourceProject: hubSource,
        workspacePaths: emptyPaths,
        isCoordinatorThread: false,
      }),
    ).toBe(false);
    expect(
      canMoveThreadToProject({
        thread: makeThread(),
        sourceProject: source,
        workspacePaths: emptyPaths,
        isCoordinatorThread: true,
      }),
    ).toBe(false);
    expect(
      canMoveThreadToProject({
        thread: makeThread({ parentThreadId: makeThread().id }),
        sourceProject: source,
        workspacePaths: emptyPaths,
        isCoordinatorThread: false,
      }),
    ).toBe(false);
  });
});
