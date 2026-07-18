import type { ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import {
  resolveCurrentProjectTargetId,
  resolveLatestProjectTargetId,
  resolveNewThreadTarget,
} from "./projectShortcutTargets";

const CURRENT_PROJECT_ID = "project-current" as ProjectId;
const LATEST_PROJECT_ID = "project-latest" as ProjectId;
const HOME_PROJECT_ID = "project-home" as ProjectId;
const STUDIO_PROJECT_ID = "project-studio" as ProjectId;

function makeProject(id: ProjectId, kind: Project["kind"] = "project"): Project {
  return {
    id,
    kind,
    name: id,
    remoteName: id,
    folderName: id,
    localName: null,
    cwd: `/workspace/${id}`,
    defaultModelSelection: null,
    expanded: false,
    scripts: [],
  };
}

describe("project shortcut targets", () => {
  const projects = [
    makeProject(CURRENT_PROJECT_ID),
    makeProject(LATEST_PROJECT_ID),
    makeProject(HOME_PROJECT_ID, "chat"),
    makeProject(STUDIO_PROJECT_ID, "studio"),
  ];

  it("prefers the focused ordinary project over the latest project", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, CURRENT_PROJECT_ID),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: CURRENT_PROJECT_ID, inheritContext: true });
  });

  it("falls back to the latest ordinary project when Home is focused", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, HOME_PROJECT_ID),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: LATEST_PROJECT_ID, inheritContext: false });
  });

  it("falls back to the latest ordinary project when nothing is focused", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId(projects, null),
        latestUsableProjectId: resolveLatestProjectTargetId(projects, LATEST_PROJECT_ID),
      }),
    ).toEqual({ projectId: LATEST_PROJECT_ID, inheritContext: false });
  });

  it.each([HOME_PROJECT_ID, STUDIO_PROJECT_ID])(
    "rejects a non-ordinary latest project target (%s)",
    (projectId) => {
      expect(resolveLatestProjectTargetId(projects, projectId)).toBeNull();
    },
  );

  it("returns no target for a stale latest project id", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: null,
        latestUsableProjectId: resolveLatestProjectTargetId(
          projects,
          "project-deleted" as ProjectId,
        ),
      }),
    ).toBeNull();
  });

  it("returns no target when no projects exist", () => {
    expect(
      resolveNewThreadTarget({
        currentProjectId: resolveCurrentProjectTargetId([], null),
        latestUsableProjectId: resolveLatestProjectTargetId([], null),
      }),
    ).toBeNull();
  });
});
