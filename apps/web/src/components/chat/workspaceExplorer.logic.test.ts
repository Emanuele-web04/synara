import type { ProjectFileSystemEntry } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  compactWorkspaceExplorerDirectory,
  visibleWorkspaceExplorerEntries,
  workspaceExplorerGitIndicators,
} from "./workspaceExplorer.logic";

function entry(
  path: string,
  kind: ProjectFileSystemEntry["kind"] = "directory",
): ProjectFileSystemEntry {
  return { path, kind, name: path.split("/").at(-1)! };
}

describe("visibleWorkspaceExplorerEntries", () => {
  it("sorts directories first in natural alphabetical order without mutating the listing", () => {
    const entries = [entry("z.ts", "file"), entry("src10"), entry("a.ts", "file"), entry("src2")];
    expect(visibleWorkspaceExplorerEntries(entries).map((item) => item.path)).toEqual([
      "src2",
      "src10",
      "a.ts",
      "z.ts",
    ]);
    expect(entries[0]?.path).toBe("z.ts");
  });

  it("excludes generated and internal entries, including worktree .git files", () => {
    const entries = [
      entry(".git", "file"),
      entry(".DS_Store", "file"),
      entry("__pycache__"),
      entry("node_modules"),
      entry("dist"),
      entry("build"),
      entry("coverage"),
      entry(".next"),
      entry(".synara-cache"),
      entry(".github"),
      entry(".env", "file"),
    ];
    expect(visibleWorkspaceExplorerEntries(entries).map((item) => item.path)).toEqual([
      ".github",
      ".env",
    ]);
  });
});

describe("workspaceExplorerGitIndicators", () => {
  it.each([
    ["added", "Added", "text-success"],
    ["untracked", "Untracked", "text-success"],
    ["modified", "Modified", "text-warning"],
    ["deleted", "Deleted", "text-destructive"],
    ["renamed", "Renamed", "text-warning"],
    ["copied", "Copied", "text-warning"],
    ["unmerged", "Unmerged (conflict)", "text-warning"],
    ["type-changed", "Type changed", "text-warning"],
  ] as const)(
    "labels zero-count %s without inferring its type from line counts",
    (changeType, label, textClassName) => {
      const indicators = workspaceExplorerGitIndicators([
        { path: "file", insertions: 0, deletions: 0, changeType },
      ]);
      expect(indicators.get("file")).toMatchObject({ label, textClassName });
    },
  );

  it("keeps old-server changes generic, not falsely added or deleted", () => {
    const indicators = workspaceExplorerGitIndicators([
      { path: "insert-only.txt", insertions: 20, deletions: 0 },
      { path: "delete-only.txt", insertions: 0, deletions: 20 },
    ]);
    for (const indicator of indicators.values())
      expect(indicator).toMatchObject({
        label: "Working tree changes",
        textClassName: "text-warning",
      });
  });

  it("preserves exact path bytes and resolves the trailing slash of an untracked directory", () => {
    const path = " leading\tfile\n.txt ";
    const indicators = workspaceExplorerGitIndicators([
      { path, insertions: 0, deletions: 0, changeType: "untracked" },
      { path: "new dir/", insertions: 0, deletions: 0, changeType: "untracked" },
    ]);
    expect(indicators.get(path)?.label).toBe("Untracked");
    expect(indicators.has(path.trim())).toBe(false);
    expect(indicators.get("new dir")?.label).toBe("Untracked");
  });

  it("keeps conflicting descendants explicit regardless of status ordering", () => {
    const files = [
      { path: "src/ui/conflict.ts", insertions: 0, deletions: 0, changeType: "unmerged" as const },
      { path: "src/ui/added.ts", insertions: 0, deletions: 0, changeType: "added" as const },
    ];
    for (const ordered of [files, files.toReversed()]) {
      const indicators = workspaceExplorerGitIndicators(ordered);
      expect(indicators.get("src")?.label).toBe("Contains unmerged changes");
      expect(indicators.get("src/ui")?.label).toBe("Contains unmerged changes");
      expect(indicators.get("src/ui/conflict.ts")?.label).toBe("Unmerged (conflict)");
    }
  });
});

describe("compactWorkspaceExplorerDirectory", () => {
  it("joins a known chain while keeping all listing keys and the final action path", () => {
    const listings = new Map([
      ["src", [entry("src/components")]],
      ["src/components", [entry("src/components/ui")]],
      ["src/components/ui", [entry("src/components/ui/button.tsx", "file")]],
    ]);
    const compact = compactWorkspaceExplorerDirectory(entry("src"), (path) => listings.get(path));
    expect(compact.paths).toEqual(["src", "src/components", "src/components/ui"]);
    expect(compact.entry).toMatchObject({
      kind: "directory",
      name: "src/components/ui",
      path: "src/components/ui",
    });
  });

  it("stops at the first unloaded directory without probing its descendants", () => {
    const getEntries = vi.fn((path: string) =>
      path === "src" ? [entry("src/components")] : undefined,
    );
    const compact = compactWorkspaceExplorerDirectory(entry("src"), getEntries);
    expect(compact.paths).toEqual(["src", "src/components"]);
    expect(getEntries.mock.calls).toEqual([["src"], ["src/components"]]);
  });

  it.each([
    { entries: [] },
    { entries: [entry("src/readme.md", "file")] },
    { entries: [entry("src/components"), entry("src/readme.md", "file")] },
    { entries: [entry("src/components"), entry("src/lib")] },
  ])("does not compact empty, file-only, or branching listings: $entries", ({ entries }) => {
    expect(compactWorkspaceExplorerDirectory(entry("src"), () => entries).entry.path).toBe("src");
  });

  it("applies the same exclusions before deciding whether a chain is single-child", () => {
    const compact = compactWorkspaceExplorerDirectory(entry("src"), (path) =>
      path === "src"
        ? [entry("src/ui"), entry("src/node_modules"), entry("src/.DS_Store", "file")]
        : [],
    );
    expect(compact.entry.name).toBe("src/ui");
  });

  it.each(["src", "src/../outside", "other/ui", "src/nested/ui"])(
    "rejects a cyclic, escaping, or non-immediate child path: %s",
    (path) => {
      expect(compactWorkspaceExplorerDirectory(entry("src"), () => [entry(path)]).paths).toEqual([
        "src",
      ]);
    },
  );

  it("does not follow a forged directory name containing traversal", () => {
    const child = { ...entry("src/../outside"), name: "../outside" };
    expect(compactWorkspaceExplorerDirectory(entry("src"), () => [child]).paths).toEqual(["src"]);
  });

  it("splits a previously compact chain when a refreshed intermediate listing branches", () => {
    const listings = new Map([
      ["src", [entry("src/components")]],
      ["src/components", [entry("src/components/ui")]],
    ]);
    expect(
      compactWorkspaceExplorerDirectory(entry("src"), (path) => listings.get(path)).entry.name,
    ).toBe("src/components/ui");
    listings.set("src", [entry("src/components"), entry("src/lib")]);
    expect(
      compactWorkspaceExplorerDirectory(entry("src"), (path) => listings.get(path)).entry.name,
    ).toBe("src");
  });
});
