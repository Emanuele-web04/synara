// FILE: threadWorkspace.test.ts
// Purpose: Verifies workspace-root containment used to attribute dev servers to projects.
// Layer: Shared runtime utility tests
// Depends on: Vitest and threadWorkspace helpers

import { describe, expect, it } from "vitest";
import { isWorkspaceRootWithin } from "./threadWorkspace";

describe("isWorkspaceRootWithin", () => {
  it("treats an identical root as contained", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app", "/Users/dev/app")).toBe(true);
  });

  it("treats a nested path as contained", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app/apps/web", "/Users/dev/app")).toBe(true);
  });

  it("ignores trailing slashes and separator style", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app/apps/web/", "/Users/dev/app/")).toBe(true);
  });

  it("does not match a sibling that shares a name prefix", () => {
    expect(isWorkspaceRootWithin("/Users/dev/app-extra", "/Users/dev/app")).toBe(false);
  });

  it("does not match an unrelated path", () => {
    expect(isWorkspaceRootWithin("/Users/dev/other", "/Users/dev/app")).toBe(false);
  });

  it("does not match when the candidate is an ancestor of the root", () => {
    expect(isWorkspaceRootWithin("/Users/dev", "/Users/dev/app")).toBe(false);
  });

  it("returns false for empty inputs", () => {
    expect(isWorkspaceRootWithin("", "/Users/dev/app")).toBe(false);
    expect(isWorkspaceRootWithin("/Users/dev/app", "")).toBe(false);
  });
});
