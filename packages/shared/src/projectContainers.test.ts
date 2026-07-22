import { describe, expect, it } from "vitest";

import {
  isLegacyHomeChatContainerRow,
  isOrdinaryProjectRow,
  matchesLegacyHomeChatWorkspaceRoot,
  resolveChatContainerWorkspaceRoot,
} from "./projectContainers";

const PATHS = {
  homeDir: "/Users/demo",
  chatWorkspaceRoot: "/Users/demo/Documents/Synara",
};

describe("resolveChatContainerWorkspaceRoot", () => {
  it("prefers the configured chat root and falls back to the home directory", () => {
    expect(resolveChatContainerWorkspaceRoot(PATHS)).toBe("/Users/demo/Documents/Synara");
    expect(resolveChatContainerWorkspaceRoot({ homeDir: "/Users/demo" })).toBe("/Users/demo");
    expect(resolveChatContainerWorkspaceRoot({ homeDir: "  ", chatWorkspaceRoot: "" })).toBeNull();
  });
});

describe("matchesLegacyHomeChatWorkspaceRoot", () => {
  it("matches the chat root and the home directory, tolerating trailing slashes", () => {
    expect(matchesLegacyHomeChatWorkspaceRoot("/Users/demo/Documents/Synara/", PATHS)).toBe(true);
    expect(matchesLegacyHomeChatWorkspaceRoot("/Users/demo", PATHS)).toBe(true);
    expect(matchesLegacyHomeChatWorkspaceRoot("/Users/demo/Developer/app", PATHS)).toBe(false);
  });

  it("never matches while the home directory is unknown", () => {
    expect(matchesLegacyHomeChatWorkspaceRoot("/Users/demo", { homeDir: null })).toBe(false);
  });
});

describe("isLegacyHomeChatContainerRow", () => {
  it("requires both the canonical Home title and a reserved workspace root", () => {
    expect(
      isLegacyHomeChatContainerRow({
        projectTitle: "Home",
        projectWorkspaceRoot: "/Users/demo",
        paths: PATHS,
      }),
    ).toBe(true);
    expect(
      isLegacyHomeChatContainerRow({
        projectTitle: "Home",
        projectWorkspaceRoot: "/Users/demo/Developer/app",
        paths: PATHS,
      }),
    ).toBe(false);
    expect(
      isLegacyHomeChatContainerRow({
        projectTitle: "Homework",
        projectWorkspaceRoot: "/Users/demo",
        paths: PATHS,
      }),
    ).toBe(false);
  });
});

describe("isOrdinaryProjectRow", () => {
  const row = {
    projectTitle: "Demo project",
    projectWorkspaceRoot: "/Users/demo/Developer/app",
    paths: PATHS,
  };

  it("accepts plain projects, defaulting an absent kind to project", () => {
    expect(isOrdinaryProjectRow({ ...row, projectKind: "project" })).toBe(true);
    expect(isOrdinaryProjectRow({ ...row, projectKind: undefined })).toBe(true);
  });

  it("rejects managed containers by kind and the legacy Home row by shape", () => {
    expect(isOrdinaryProjectRow({ ...row, projectKind: "chat" })).toBe(false);
    expect(isOrdinaryProjectRow({ ...row, projectKind: "studio" })).toBe(false);
    expect(
      isOrdinaryProjectRow({
        projectKind: "project",
        projectTitle: "Home",
        projectWorkspaceRoot: "/Users/demo",
        paths: PATHS,
      }),
    ).toBe(false);
  });
});
