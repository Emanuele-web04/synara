// FILE: projectFolders.test.ts
// Purpose: Verifies multi-folder project validation, labels, and the provider preamble.
// Layer: Shared runtime utility tests
// Depends on: Vitest and projectFolders helpers

import { describe, expect, it } from "vitest";
import {
  buildProjectFoldersPreamble,
  deriveProjectFolderLabels,
  findProjectFolderProblem,
  projectFoldersSessionIssue,
} from "./projectFolders";

describe("findProjectFolderProblem", () => {
  it("accepts distinct sibling folders", () => {
    expect(findProjectFolderProblem(["/repos/web", "/repos/api", "/repos/shared"])).toBeNull();
  });

  it("requires at least one folder", () => {
    expect(findProjectFolderProblem([])).toBe("Add at least one folder.");
  });

  it("rejects relative paths", () => {
    expect(findProjectFolderProblem(["/repos/web", "api"])).toBe("Use an absolute path: api");
  });

  it("accepts Windows drive and UNC paths", () => {
    expect(findProjectFolderProblem(["C:\\repos\\web", "\\\\server\\share\\api"])).toBeNull();
  });

  it("rejects the same folder twice, ignoring trailing slashes", () => {
    expect(findProjectFolderProblem(["/repos/web", "/repos/web/"])).toBe(
      "web is already in this project.",
    );
  });

  it("rejects a folder nested inside another, in either order", () => {
    expect(findProjectFolderProblem(["/repos", "/repos/api"])).toBe(
      "api is inside repos. Add only one of them.",
    );
    expect(findProjectFolderProblem(["/repos/api", "/repos"])).toBe(
      "api is inside repos. Add only one of them.",
    );
  });
});

describe("deriveProjectFolderLabels", () => {
  it("uses the folder name when it is unique", () => {
    expect(deriveProjectFolderLabels(["/repos/web", "/repos/api"])).toEqual(["web", "api"]);
  });

  it("adds parent segments until duplicate names differ", () => {
    expect(deriveProjectFolderLabels(["/a/server/api", "/b/client/api", "/c/web"])).toEqual([
      "server/api",
      "client/api",
      "web",
    ]);
  });
});

describe("buildProjectFoldersPreamble", () => {
  it("is null for a single-folder project", () => {
    expect(
      buildProjectFoldersPreamble({ primaryFolder: "/repos/web", additionalFolders: [] }),
    ).toBeNull();
  });

  it("lists every folder and marks the primary one", () => {
    expect(
      buildProjectFoldersPreamble({
        primaryFolder: "/repos/web",
        additionalFolders: ["/repos/api"],
      }),
    ).toBe(
      [
        "<project_folders>",
        "This project spans several folders. You can read and edit all of them:",
        "- web: /repos/web (primary)",
        "- api: /repos/api",
        "Use absolute paths for files outside the primary folder.",
        "</project_folders>",
      ].join("\n"),
    );
  });
});

describe("projectFoldersSessionIssue", () => {
  it("allows local Codex and Claude chats", () => {
    expect(projectFoldersSessionIssue({ provider: "codex", worktree: false })).toBeNull();
    expect(projectFoldersSessionIssue({ provider: "claudeAgent", worktree: false })).toBeNull();
  });

  it("refuses worktree chats", () => {
    expect(projectFoldersSessionIssue({ provider: "codex", worktree: true })).toContain(
      "Use Local mode",
    );
  });

  it("refuses providers that cannot be granted the extra folders", () => {
    expect(projectFoldersSessionIssue({ provider: "opencode", worktree: false })).toBe(
      "OpenCode cannot access a project's additional folders. Use Codex or Claude for this multi-folder project.",
    );
  });
});
