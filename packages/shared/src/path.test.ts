import { describe, expect, it } from "vitest";

import { isWorkspaceRelativePathSafe } from "./path";

describe("isWorkspaceRelativePathSafe", () => {
  it("accepts plain workspace-relative paths", () => {
    expect(isWorkspaceRelativePathSafe("src/app.ts")).toBe(true);
    expect(isWorkspaceRelativePathSafe("docs")).toBe(true);
    expect(isWorkspaceRelativePathSafe("a/b/c.txt")).toBe(true);
  });

  it("rejects traversal segments", () => {
    expect(isWorkspaceRelativePathSafe("..")).toBe(false);
    expect(isWorkspaceRelativePathSafe("../../etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePathSafe("src/../../etc")).toBe(false);
    expect(isWorkspaceRelativePathSafe("..\\windows")).toBe(false);
    expect(isWorkspaceRelativePathSafe("./src")).toBe(false);
  });

  it("rejects absolute paths", () => {
    expect(isWorkspaceRelativePathSafe("/etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePathSafe("C:\\Windows")).toBe(false);
    expect(isWorkspaceRelativePathSafe("\\\\server\\share")).toBe(false);
  });

  it("rejects empty and whitespace-only values", () => {
    expect(isWorkspaceRelativePathSafe("")).toBe(false);
    expect(isWorkspaceRelativePathSafe("   ")).toBe(false);
  });
});
