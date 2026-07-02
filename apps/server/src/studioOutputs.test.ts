import { describe, expect, it } from "vitest";

import { rankStudioOutputEntries, type StudioOutputCandidate } from "./studioOutputs";

function candidate(overrides: Partial<StudioOutputCandidate>): StudioOutputCandidate {
  return {
    name: "file.md",
    relativePath: "Content/file.md",
    fullPath: "/studio/Outbox/Content/file.md",
    modifiedAtMs: 0,
    ...overrides,
  };
}

describe("rankStudioOutputEntries", () => {
  it("sorts by most recently modified and applies the limit", () => {
    const entries = rankStudioOutputEntries(
      [
        candidate({ name: "old.md", relativePath: "Content/old.md", modifiedAtMs: 1_000 }),
        candidate({ name: "newest.md", relativePath: "Daily/newest.md", modifiedAtMs: 3_000 }),
        candidate({ name: "middle.md", relativePath: "YouTube/middle.md", modifiedAtMs: 2_000 }),
      ],
      2,
    );

    expect(entries.map((entry) => entry.name)).toEqual(["newest.md", "middle.md"]);
    expect(entries[0]?.modifiedAt).toBe(new Date(3_000).toISOString());
  });

  it("drops hidden files anywhere in the relative path", () => {
    const entries = rankStudioOutputEntries(
      [
        candidate({ name: ".DS_Store", relativePath: "Content/.DS_Store", modifiedAtMs: 9_000 }),
        candidate({ name: "post.md", relativePath: ".hidden/post.md", modifiedAtMs: 8_000 }),
        candidate({ name: "kept.md", relativePath: "Content/kept.md", modifiedAtMs: 1_000 }),
      ],
      10,
    );

    expect(entries.map((entry) => entry.name)).toEqual(["kept.md"]);
  });

  it("preserves relative and full paths on the returned entries", () => {
    const entries = rankStudioOutputEntries(
      [
        candidate({
          name: "post.md",
          relativePath: "TikTok/post.md",
          fullPath: "/studio/Outbox/TikTok/post.md",
          modifiedAtMs: 42,
        }),
      ],
      10,
    );

    expect(entries).toEqual([
      {
        name: "post.md",
        relativePath: "TikTok/post.md",
        fullPath: "/studio/Outbox/TikTok/post.md",
        modifiedAt: new Date(42).toISOString(),
      },
    ]);
  });
});
