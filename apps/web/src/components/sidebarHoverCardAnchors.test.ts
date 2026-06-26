import { describe, expect, it } from "vitest";

import { abbreviateHomePath } from "./sidebarHoverCardAnchors";

describe("abbreviateHomePath", () => {
  it("collapses the home directory to a tilde", () => {
    expect(abbreviateHomePath("/Users/me/project", "/Users/me")).toBe("~/project");
    expect(abbreviateHomePath("/Users/me", "/Users/me")).toBe("~");
  });

  it("leaves unrelated paths unchanged", () => {
    expect(abbreviateHomePath("/Volumes/work/project", "/Users/me")).toBe("/Volumes/work/project");
    expect(abbreviateHomePath("/Users/me-other/project", "/Users/me")).toBe(
      "/Users/me-other/project",
    );
  });
});
