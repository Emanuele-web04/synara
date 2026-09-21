import { ProjectId, type ProjectImportProject } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  buildProjectImportQueue,
  projectImportItemKey,
  selectableProjectImportKeys,
} from "./logic";

const project: ProjectImportProject = {
  key: "folder:/code/synara",
  title: "Synara",
  workspaceRoot: "/code/synara",
  directoryExists: true,
  existingProjectId: ProjectId.makeUnsafe("existing"),
  providers: ["codex", "claudeAgent"],
  threads: [
    {
      key: "codex:one",
      provider: "codex",
      title: "One",
      cwd: "/code/synara",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
      alreadyImported: false,
    },
    {
      key: "claude:two",
      provider: "claudeAgent",
      title: "Two",
      cwd: "/code/synara",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: true,
      alreadyImported: false,
    },
    {
      key: "codex:three",
      provider: "codex",
      title: "Three",
      cwd: "/code/synara",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archived: false,
      alreadyImported: true,
    },
  ],
};

describe("project import selection", () => {
  it("skips duplicates and archived selections when the archive filter is off", () => {
    const selected = new Set(
      project.threads.map((thread) => projectImportItemKey(project.key, thread.key)),
    );
    const queue = buildProjectImportQueue({
      projects: [project],
      selected,
      includeArchived: false,
      workspaceRoots: {},
    });
    expect(queue.map((item) => item.input)).toEqual([
      { projectKey: project.key, threadKey: "codex:one", spaceId: null },
    ]);
    expect(
      buildProjectImportQueue({
        projects: [project],
        selected,
        includeArchived: true,
        workspaceRoots: {},
      }),
    ).toHaveLength(2);
  });

  it("links empty folders once and passes explicit moved-folder destinations", () => {
    const empty = { ...project, threads: [], existingProjectId: null };
    const selected = new Set(selectableProjectImportKeys(empty, false));
    expect(
      buildProjectImportQueue({
        projects: [empty],
        selected,
        includeArchived: false,
        workspaceRoots: { [empty.key]: " /code/moved " },
      }),
    ).toMatchObject([
      { workspaceRoot: "/code/moved", input: { threadKey: null, workspaceRoot: "/code/moved" } },
    ]);
    expect(
      selectableProjectImportKeys(
        { ...empty, existingProjectId: project.existingProjectId },
        false,
      ),
    ).toEqual([]);
  });

  it("does not conflate provider conversation ids or delimiter-containing project keys", () => {
    expect(projectImportItemKey("a:b", "c")).not.toBe(projectImportItemKey("a", "b:c"));
    expect(projectImportItemKey(project.key, "codex:one")).not.toBe(
      projectImportItemKey(project.key, "claude:one"),
    );
  });
});
