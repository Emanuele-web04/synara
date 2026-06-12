import { describe, expect, it } from "vitest";

import { resolveWorkspaceFileOpenTarget } from "./workspaceFileOpener";

describe("resolveWorkspaceFileOpenTarget", () => {
  it("passes workspace-relative paths through unchanged", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("README.md", null)).toBe("README.md");
  });

  it("strips :line and :line:col position suffixes", () => {
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("src/page.tsx:42:7", "/repo/app")).toBe("src/page.tsx");
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx:10:2", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("maps absolute paths inside the workspace to relative form", () => {
    expect(resolveWorkspaceFileOpenTarget("/repo/app/src/page.tsx", "/repo/app")).toBe(
      "src/page.tsx",
    );
  });

  it("returns null for paths outside the workspace", () => {
    expect(resolveWorkspaceFileOpenTarget("/elsewhere/file.ts", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("/repo/app/file.ts", null)).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("../outside.ts", "/repo/app")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(resolveWorkspaceFileOpenTarget("", "/repo/app")).toBeNull();
    expect(resolveWorkspaceFileOpenTarget("   ", "/repo/app")).toBeNull();
  });
});
