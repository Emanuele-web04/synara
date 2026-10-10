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

describe("findLegacyStudioContainerForAdoption", () => {
  const makeLegacyStudio = (overrides: Partial<Project> = {}): Project =>
    makeProject({
      id: "project-studio" as ProjectId,
      kind: "studio",
      name: "Studio",
      remoteName: "Studio",
      localName: null,
      cwd: "/Users/tester/Documents/Synara/Studio",
      ...overrides,
    });

  it("adopts the default-titled legacy Studio container", () => {
    const studio = makeLegacyStudio();
    expect(findLegacyStudioContainerForAdoption([makeProject(), studio], PATHS)?.id).toBe(
      studio.id,
    );
  });

  it("does not adopt a studio row with a non-Studio title", () => {
    const renamed = makeLegacyStudio({ name: "Ops studio", remoteName: "Ops studio" });
    expect(findLegacyStudioContainerForAdoption([renamed], PATHS)).toBeNull();
  });

  it("does not adopt a row already titled Groups", () => {
    const alreadyGroups = makeLegacyStudio({ name: "Groups", remoteName: "Groups" });
    expect(findLegacyStudioContainerForAdoption([alreadyGroups], PATHS)).toBeNull();
  });

  it("does not adopt a studio row the user renamed locally", () => {
    const userTitled = makeLegacyStudio({ localName: "Studio" });
    expect(findLegacyStudioContainerForAdoption([userTitled], PATHS)).toBeNull();
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
