// FILE: groupProjects.test.ts
// Purpose: Verifies Group container detection for group rows, legacy Studio, and boot-time roots.
// Layer: Web orchestration tests

import { type ProjectId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { Project } from "../types";
import {
  collectGroupProjectIds,
  findLegacyStudioContainerForAdoption,
  isGroupContainerProject,
} from "./groupProjects";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-group" as ProjectId,
    kind: "group",
    name: "Alpha",
    remoteName: "Alpha",
    folderName: "alpha",
    localName: null,
    cwd: "/Users/tester/Documents/Synara/Groups/alpha",
    defaultModelSelection: null,
    expanded: false,
    spaceId: null,
    scripts: [],
    ...overrides,
  };
}

const PATHS = {
  homeDir: "/Users/tester",
  chatWorkspaceRoot: "/Users/tester/Documents/Synara",
  studioWorkspaceRoot: "/Users/tester/Documents/Synara/Studio",
  groupsWorkspaceRoot: "/Users/tester/Documents/Synara/Groups",
};

describe("isGroupContainerProject", () => {
  it("matches a group under the Groups root", () => {
    expect(isGroupContainerProject(makeProject(), PATHS)).toBe(true);
  });

  it("matches a legacy Studio row under the Studio root", () => {
    expect(
      isGroupContainerProject(
        makeProject({
          id: "project-studio" as ProjectId,
          kind: "studio",
          name: "Studio",
          cwd: "/Users/tester/Documents/Synara/Studio",
        }),
        PATHS,
      ),
    ).toBe(true);
  });

  it("rejects an ordinary project", () => {
    expect(
      isGroupContainerProject(
        makeProject({
          kind: "project",
          cwd: "/Users/tester/Developer/app",
        }),
        PATHS,
      ),
    ).toBe(false);
  });

  it("trusts kind alone before welcome delivers roots", () => {
    expect(isGroupContainerProject(makeProject(), { homeDir: "/Users/tester" })).toBe(true);
    expect(
      isGroupContainerProject(
        makeProject({
          kind: "studio",
          cwd: "/Users/tester/Documents/Synara/Studio",
        }),
        { homeDir: "/Users/tester" },
      ),
    ).toBe(true);
  });
});

describe("collectGroupProjectIds", () => {
  it("collects group and legacy studio ids", () => {
    const group = makeProject();
    const studio = makeProject({
      id: "project-studio" as ProjectId,
      kind: "studio",
      cwd: "/Users/tester/Documents/Synara/Studio",
    });
    const ordinary = makeProject({
      id: "project-app" as ProjectId,
      kind: "project",
      cwd: "/Users/tester/Developer/app",
    });
    expect(collectGroupProjectIds([group, studio, ordinary], PATHS)).toEqual(
      new Set([group.id, studio.id]),
    );
  });
});

describe("findLegacyStudioContainerForAdoption", () => {
  const legacyStudio = () =>
    makeProject({
      id: "project-studio" as ProjectId,
      kind: "studio",
      name: "Studio",
      cwd: "/Users/tester/Documents/Synara/Studio",
    });

  it("adopts the Studio container by title", () => {
    expect(findLegacyStudioContainerForAdoption([legacyStudio()], PATHS)?.id).toBe(
      "project-studio",
    );
  });

  it("does not adopt a studio row the user renamed away from 'Studio'", () => {
    // `localName` folds into `project.name`, so a user-retitled container no longer
    // carries the adoption title — that is the only user-edited signal Project has.
    expect(
      findLegacyStudioContainerForAdoption(
        [
          makeProject({
            id: "project-renamed" as ProjectId,
            kind: "studio",
            name: "Team pods",
            localName: "Team pods",
            cwd: "/Users/tester/Documents/Synara/Studio",
          }),
        ],
        PATHS,
      ),
    ).toBeNull();
  });

  it("does not adopt a container already titled 'Groups'", () => {
    expect(
      findLegacyStudioContainerForAdoption(
        [
          makeProject({
            id: "project-groups" as ProjectId,
            kind: "studio",
            name: "Groups",
            cwd: "/Users/tester/Documents/Synara/Studio",
          }),
        ],
        PATHS,
      ),
    ).toBeNull();
    expect(
      findLegacyStudioContainerForAdoption(
        [makeProject({ id: "project-groups" as ProjectId, kind: "group", name: "Groups" })],
        PATHS,
      ),
    ).toBeNull();
  });
});
