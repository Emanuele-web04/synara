import type { LibraryEntry } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPANDED_DIRECTORIES,
  compareLibraryEntries,
  entryMatchesLibraryFilters,
  flattenLibraryRows,
  libraryEntryTypeBucket,
  librarySearchRows,
  nextLibrarySort,
  sortLibraryEntries,
  toggleLibraryDirectory,
} from "./libraryPanel.logic";

const entry = (
  name: string,
  relativePath: string,
  kind: LibraryEntry["kind"],
  modifiedAt: string,
): LibraryEntry => ({ name, relativePath, kind, sizeBytes: 1, modifiedAt });

describe("libraryEntryTypeBucket", () => {
  it("buckets by file-icon name", () => {
    expect(
      libraryEntryTypeBucket(entry("spec.md", "spec.md", "file", "2026-01-01T00:00:00Z")),
    ).toBe("documents");
    expect(
      libraryEntryTypeBucket(entry("doc.pdf", "doc.pdf", "file", "2026-01-01T00:00:00Z")),
    ).toBe("documents");
    expect(
      libraryEntryTypeBucket(entry("shot.png", "shot.png", "file", "2026-01-01T00:00:00Z")),
    ).toBe("images");
    expect(
      libraryEntryTypeBucket(entry("tool.ts", "tool.ts", "file", "2026-01-01T00:00:00Z")),
    ).toBe("code");
    expect(
      libraryEntryTypeBucket(entry("blob.bin", "blob.bin", "file", "2026-01-01T00:00:00Z")),
    ).toBe("other");
  });
});

describe("sortLibraryEntries", () => {
  const entries = [
    entry("zeta.md", "zeta.md", "file", "2026-01-03T00:00:00Z"),
    entry("Beta", "Beta", "directory", "2026-01-01T00:00:00Z"),
    entry("alpha.md", "alpha.md", "file", "2026-01-02T00:00:00Z"),
    entry("Alpha", "Alpha", "directory", "2026-01-04T00:00:00Z"),
  ];

  it("keeps directories first and sorts by name ascending", () => {
    expect(
      sortLibraryEntries(entries, { key: "name", direction: "asc" }).map((e) => e.name),
    ).toEqual(["Alpha", "Beta", "alpha.md", "zeta.md"]);
  });

  it("sorts by date descending while keeping directories first", () => {
    expect(
      sortLibraryEntries(entries, { key: "modifiedAt", direction: "desc" }).map((e) => e.name),
    ).toEqual(["Alpha", "Beta", "zeta.md", "alpha.md"]);
  });

  it("flips direction on repeat key and resets ascending on a new key", () => {
    const asc = { key: "name", direction: "asc" } as const;
    expect(nextLibrarySort(asc, "name")).toEqual({ key: "name", direction: "desc" });
    expect(nextLibrarySort(asc, "modifiedAt")).toEqual({
      key: "modifiedAt",
      direction: "asc",
    });
    expect(nextLibrarySort({ key: "name", direction: "desc" }, "name")).toEqual({
      key: "name",
      direction: "asc",
    });
  });

  it("falls back to name order on equal dates", () => {
    const tied = [
      entry("b.txt", "b.txt", "file", "2026-01-01T00:00:00Z"),
      entry("a.txt", "a.txt", "file", "2026-01-01T00:00:00Z"),
    ];
    expect(
      compareLibraryEntries(tied[0]!, tied[1]!, { key: "modifiedAt", direction: "asc" }),
    ).toBeGreaterThan(0);
  });
});

describe("entryMatchesLibraryFilters", () => {
  const note = entry("note.md", "docs/note.md", "file", "2026-01-01T00:00:00Z");

  it("matches the relative path case-insensitively", () => {
    expect(entryMatchesLibraryFilters(note, { typeFilter: "all", query: "DOCS/NO" })).toBe(true);
    expect(entryMatchesLibraryFilters(note, { typeFilter: "all", query: "missing" })).toBe(false);
  });

  it("applies the type filter to files but keeps directories", () => {
    const dir = entry("docs", "docs", "directory", "2026-01-01T00:00:00Z");
    expect(entryMatchesLibraryFilters(note, { typeFilter: "images", query: "" })).toBe(false);
    expect(entryMatchesLibraryFilters(note, { typeFilter: "documents", query: "" })).toBe(true);
    expect(entryMatchesLibraryFilters(dir, { typeFilter: "images", query: "" })).toBe(true);
  });
});

describe("flattenLibraryRows", () => {
  const entriesByDir = new Map<string, readonly LibraryEntry[]>([
    [
      "",
      [
        entry("Artifacts", "Artifacts", "directory", "2026-01-01T00:00:00Z"),
        entry("readme.md", "readme.md", "file", "2026-01-02T00:00:00Z"),
      ],
    ],
    ["Artifacts", [entry("plan.pdf", "Artifacts/plan.pdf", "file", "2026-01-03T00:00:00Z")]],
  ]);
  const base = {
    entriesByDir,
    sort: { key: "name", direction: "asc" } as const,
    typeFilter: "all" as const,
    query: "",
  };

  it("expands directories on the expanded set only", () => {
    const collapsed = flattenLibraryRows({ ...base, expandedDirectories: new Set<string>() });
    expect(collapsed.map((row) => row.entry.relativePath)).toEqual(["Artifacts", "readme.md"]);

    const expanded = flattenLibraryRows({
      ...base,
      expandedDirectories: DEFAULT_EXPANDED_DIRECTORIES,
    });
    expect(expanded.map((row) => row.entry.relativePath)).toEqual([
      "Artifacts",
      "Artifacts/plan.pdf",
      "readme.md",
    ]);
    expect(expanded[1]?.depth).toBe(1);
  });

  it("searches every loaded directory even when collapsed", () => {
    const found = flattenLibraryRows({
      ...base,
      expandedDirectories: new Set<string>(),
      query: "plan",
    });
    // The matching child surfaces with its parent directory for context.
    expect(found.map((row) => row.entry.relativePath)).toEqual(["Artifacts", "Artifacts/plan.pdf"]);
  });

  it("hides directories with no loaded matches when a type filter is active", () => {
    const filtered = flattenLibraryRows({
      ...base,
      expandedDirectories: new Set<string>(),
      typeFilter: "images",
    });
    // Artifacts only holds a .pdf (documents), so the folder drops too.
    expect(filtered.map((row) => row.entry.relativePath)).toEqual([]);

    const withImage = new Map<string, readonly LibraryEntry[]>(entriesByDir);
    withImage.set("Images", [entry("shot.png", "Images/shot.png", "file", "2026-01-04T00:00:00Z")]);
    withImage.set("", [
      entry("Artifacts", "Artifacts", "directory", "2026-01-01T00:00:00Z"),
      entry("Images", "Images", "directory", "2026-01-01T00:00:00Z"),
      entry("readme.md", "readme.md", "file", "2026-01-02T00:00:00Z"),
    ]);
    const rows = flattenLibraryRows({
      ...base,
      entriesByDir: withImage,
      expandedDirectories: new Set<string>(),
      typeFilter: "images",
    });
    expect(rows.map((row) => row.entry.relativePath)).toEqual(["Images", "Images/shot.png"]);
  });
});

describe("librarySearchRows", () => {
  const results = [
    entry("Reports", "Reports", "directory", "2026-01-01T00:00:00Z"),
    entry("roadmap.md", "Reports/2026/Q3/roadmap.md", "file", "2026-01-02T00:00:00Z"),
    entry("shot.png", "Images/shot.png", "file", "2026-01-03T00:00:00Z"),
  ];
  const sort = { key: "name", direction: "asc" } as const;

  it("keeps directories first and applies the panel type filter", () => {
    const all = librarySearchRows({ results, typeFilter: "all", sort });
    expect(all.map((row) => row.entry.relativePath)).toEqual([
      "Reports",
      "Reports/2026/Q3/roadmap.md",
      "Images/shot.png",
    ]);
    // Directories sort above files; files then compare by name.
    expect(all[0]?.entry.kind).toBe("directory");
    // Search rows are flat paths: a match from an unopened folder has no indent.
    expect(all.every((row) => row.depth === 0)).toBe(true);

    // The type filter narrows files but keeps directories, as in the flat listing:
    // a folder is a container, and the image inside it stays reachable.
    const images = librarySearchRows({ results, typeFilter: "images", sort });
    expect(images.map((row) => row.entry.relativePath)).toEqual(["Reports", "Images/shot.png"]);
  });

  // A rename or delete drops the old path; a page already in flight may still
  // name it, and that must never render as a row.
  it("drops paths a rename or delete removed", () => {
    const dropped = librarySearchRows({
      results,
      typeFilter: "all",
      sort,
      droppedPaths: new Set(["Reports/2026/Q3/roadmap.md"]),
    });
    expect(dropped.map((row) => row.entry.relativePath)).toEqual(["Reports", "Images/shot.png"]);
  });

  it("honors the modifiedAt sort", () => {
    const recent = librarySearchRows({
      results,
      typeFilter: "all",
      sort: { key: "modifiedAt", direction: "desc" },
    });
    expect(recent.map((row) => row.entry.relativePath)).toEqual([
      "Reports",
      "Images/shot.png",
      "Reports/2026/Q3/roadmap.md",
    ]);
  });
});

describe("toggleLibraryDirectory", () => {
  it("adds and removes paths without mutating the input", () => {
    const initial = new Set(["Artifacts"]);
    const collapsed = toggleLibraryDirectory(initial, "Artifacts");
    expect(collapsed.has("Artifacts")).toBe(false);
    expect(initial.has("Artifacts")).toBe(true);
    expect(toggleLibraryDirectory(collapsed, "Artifacts").has("Artifacts")).toBe(true);
  });
});
