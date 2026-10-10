import { describe, expect, it } from "vitest";

import {
  isWorkspaceSearchFilesystemPathQuery,
  resolveWorkspaceSearchFilesystemTarget,
} from "./WorkspaceSearchPalette.logic";

describe("isWorkspaceSearchFilesystemPathQuery", () => {
  it("detects absolute and home-relative paths, including position suffixes", () => {
    expect(isWorkspaceSearchFilesystemPathQuery("/Users/dev/notes/todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("~/notes/todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("~\\notes\\todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("C:\\Users\\dev\\notes\\todo.md")).toBe(true);
    expect(isWorkspaceSearchFilesystemPathQuery("/Users/dev/notes/todo.md:12:3")).toBe(true);
  });

  it("rejects fuzzy search queries and bare home", () => {
    expect(isWorkspaceSearchFilesystemPathQuery("Composer")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("src/app.ts")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("~")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("")).toBe(false);
    expect(isWorkspaceSearchFilesystemPathQuery("   ")).toBe(false);
  });
});

describe("resolveWorkspaceSearchFilesystemTarget", () => {
  const cwd = "/Users/tester/project";
  it.each([
    [
      "workspace absolute with position",
      `${cwd}/src/app.ts:42`,
      cwd,
      "/Users/tester",
      "src/app.ts",
    ],
    [
      "outside workspace",
      "/Users/tester/notes/todo.md",
      cwd,
      "/Users/tester",
      "/Users/tester/notes/todo.md",
    ],
    ["home relative", "~/notes/todo.md", cwd, "/Users/tester", "/Users/tester/notes/todo.md"],
    ["home inside workspace", "~/project/src/app.ts", cwd, "/Users/tester", "src/app.ts"],
    [
      "custom server home",
      "~/notes/todo.md",
      "/srv/synara/workspace",
      "/srv/synara-user",
      "/srv/synara-user/notes/todo.md",
    ],
    [
      "Windows home and position",
      "~\\notes\\todo.md:12",
      "C:\\Users\\tester\\project",
      "C:\\Users\\tester",
      "C:\\Users\\tester\\notes\\todo.md",
    ],
  ])("resolves %s", (_name, query, root, home, expected) => {
    expect(resolveWorkspaceSearchFilesystemTarget(query!, root!, home!)).toEqual({
      kind: "file",
      path: expected,
    });
  });

  it("returns null when a home-relative path has no server home", () => {
    expect(resolveWorkspaceSearchFilesystemTarget("~/notes/todo.md", cwd, null)).toBeNull();
  });
  it("returns null for non-path queries", () => {
    expect(resolveWorkspaceSearchFilesystemTarget("Composer", cwd, "/Users/tester")).toBeNull();
  });
});
