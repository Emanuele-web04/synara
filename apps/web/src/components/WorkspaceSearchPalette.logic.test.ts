import { describe, expect, it } from "vitest";

import {
  isWorkspaceSearchFilesystemPathQuery,
  resolveWorkspaceSearchFilesystemPath,
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

describe("resolveWorkspaceSearchFilesystemPath", () => {
  const cwd = "/Users/tester/project";

  it("maps in-workspace absolute paths to workspace-relative form", () => {
    expect(resolveWorkspaceSearchFilesystemPath(`${cwd}/src/app.ts:42`, cwd, "/Users/tester")).toBe(
      "src/app.ts",
    );
  });

  it("keeps out-of-workspace absolute paths absolute", () => {
    expect(
      resolveWorkspaceSearchFilesystemPath("/Users/tester/notes/todo.md", cwd, "/Users/tester"),
    ).toBe("/Users/tester/notes/todo.md");
  });

  it("expands home-relative paths using the explicit server home", () => {
    expect(resolveWorkspaceSearchFilesystemPath("~/notes/todo.md", cwd, "/Users/tester")).toBe(
      "/Users/tester/notes/todo.md",
    );
    expect(resolveWorkspaceSearchFilesystemPath("~/project/src/app.ts", cwd, "/Users/tester")).toBe(
      "src/app.ts",
    );
  });

  it("supports custom homes that cannot be inferred from cwd", () => {
    expect(
      resolveWorkspaceSearchFilesystemPath(
        "~/notes/todo.md",
        "/srv/synara/workspace",
        "/srv/synara-user",
      ),
    ).toBe("/srv/synara-user/notes/todo.md");
  });

  it("returns null when a home-relative path has no server home", () => {
    expect(resolveWorkspaceSearchFilesystemPath("~/notes/todo.md", cwd, null)).toBeNull();
  });

  it("delegates Windows path normalization to the shared dock resolver", () => {
    expect(
      resolveWorkspaceSearchFilesystemPath(
        "~\\notes\\todo.md:12",
        "C:\\Users\\tester\\project",
        "C:\\Users\\tester",
      ),
    ).toBe("C:\\Users\\tester\\notes\\todo.md");
  });

  it("returns null for non-path queries", () => {
    expect(resolveWorkspaceSearchFilesystemPath("Composer", cwd, "/Users/tester")).toBeNull();
  });
});
