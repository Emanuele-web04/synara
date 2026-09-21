import { describe, expect, it } from "vitest";

import { providerWorkspaceChanged, relocateProjectPath } from "./projectRelocationPaths";

describe("relocateProjectPath", () => {
  it("relinks the root and descendants without needing the old disk", () => {
    expect(
      relocateProjectPath("/Volumes/old/repo", "/Volumes/old/repo", "/home/new/repo", "darwin"),
    ).toBe("/home/new/repo");
    expect(
      relocateProjectPath("/Volumes/old/repo/src", "/Volumes/old/repo", "/home/new/repo", "darwin"),
    ).toBe("/home/new/repo/src");
  });

  it("does not rewrite siblings, outside directories, relative paths, or unset paths", () => {
    for (const value of [
      "/old/repository",
      "/old/repo/../outside",
      "/worktrees/feature",
      "src",
      null,
      undefined,
    ]) {
      expect(relocateProjectPath(value, "/old/repo", "/new/repo", "linux")).toBe(value);
    }
  });

  it("handles drive changes, mixed separators, case-insensitive roots, and UNC shares", () => {
    expect(
      relocateProjectPath(
        "E:\\Projects\\Repo\\src",
        "e:/projects/repo",
        "C:\\restored\\repo",
        "win32",
      ),
    ).toBe("C:\\restored\\repo\\src");
    expect(
      relocateProjectPath(
        "\\\\disk\\share\\repo\\src",
        "\\\\disk\\share\\repo",
        "D:\\repo",
        "win32",
      ),
    ).toBe("D:\\repo\\src");
    expect(relocateProjectPath("F:\\other", "E:\\repo", "D:\\repo", "win32")).toBe("F:\\other");
  });

  it("handles macOS private-path aliases without the old folder existing", () => {
    expect(
      relocateProjectPath("/tmp/old/repo/src", "/private/tmp/old/repo", "/new/repo", "darwin"),
    ).toBe("/new/repo/src");
    expect(providerWorkspaceChanged("/tmp/repo", "/private/tmp/repo", "darwin")).toBe(false);
  });

  it("does not make POSIX path comparisons case insensitive", () => {
    expect(relocateProjectPath("/old/Repo/src", "/old/repo", "/new/repo", "linux")).toBe(
      "/old/Repo/src",
    );
  });
});

describe("providerWorkspaceChanged", () => {
  it("restarts only for a known different workspace", () => {
    expect(providerWorkspaceChanged("/old/repo", "/new/repo", "linux")).toBe(true);
    expect(providerWorkspaceChanged(undefined, "/new/repo", "linux")).toBe(false);
  });

  it("does not restart for the same normalized workspace or an unspecified target", () => {
    expect(providerWorkspaceChanged("/repo/", "/repo", "linux")).toBe(false);
    expect(providerWorkspaceChanged("E:\\Repo", "e:/repo/", "win32")).toBe(false);
    expect(providerWorkspaceChanged("/repo", undefined, "linux")).toBe(false);
  });
});
