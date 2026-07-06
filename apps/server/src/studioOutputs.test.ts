import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  listRecentStudioOutputs,
  MAX_SCANNED_OUTBOX_ENTRIES,
  rankStudioOutputEntries,
  type StudioOutputCandidate,
} from "./studioOutputs";

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

/**
 * Builds a fake `FileSystem` (+ real `Path`) layer whose `readDirectory` returns exactly the
 * given relative paths (in that order, mirroring an arbitrary directory-walk order that has no
 * relationship to mtime) and whose `stat` looks up mtimes from `mtimesByRelativePath`. This lets
 * the scan/rank flow be exercised deterministically without touching the real filesystem.
 */
function makeFakeOutboxLayer(input: {
  readonly relativePaths: readonly string[];
  readonly mtimesByRelativePath: ReadonlyMap<string, number>;
  readonly outboxRoot: string;
  readonly unstattablePaths?: ReadonlySet<string>;
}) {
  const fileSystemLayer = FileSystem.layerNoop({
    readDirectory: () => Effect.succeed([...input.relativePaths]),
    stat: (fullPath: string) => {
      const relativePath = fullPath.slice(input.outboxRoot.length + 1);
      if (input.unstattablePaths?.has(relativePath)) {
        return Effect.fail(new Error("simulated stat failure") as never);
      }
      const modifiedAtMs = input.mtimesByRelativePath.get(relativePath) ?? 0;
      return Effect.succeed({
        type: "File",
        mtime: new Date(modifiedAtMs),
        atime: undefined,
        birthtime: undefined,
        dev: 0,
        ino: undefined,
        mode: 0,
        nlink: undefined,
        uid: undefined,
        gid: undefined,
        rdev: undefined,
        size: FileSystem.Size(0),
        blksize: undefined,
        blocks: undefined,
      } satisfies FileSystem.File.Info);
    },
  });
  return Layer.merge(fileSystemLayer, Path.layer);
}

describe("listRecentStudioOutputs", () => {
  it("ranks by mtime across every scanned entry instead of dropping entries past the old fixed cap position", async () => {
    // The historical bug truncated the raw (mtime-unaware) directory listing to a fixed cap
    // *before* stat/rank ran, so a recently modified file positioned past that cap in walk
    // order was silently dropped. Build a listing well past the old 2,000-entry cap with the
    // single most-recently-modified file placed near the end, and prove it still surfaces.
    const outboxRoot = "/studio/Outbox";
    const oldFixedCap = 2_000;
    const entryCount = oldFixedCap + 5;
    const relativePaths = Array.from(
      { length: entryCount },
      (_unused, index) => `Content/file-${index}.md`,
    );
    const mtimesByRelativePath = new Map<string, number>(
      relativePaths.map((relativePath, index) => [relativePath, index]),
    );
    const mostRecentRelativePath = relativePaths[entryCount - 2] as string;
    mtimesByRelativePath.set(mostRecentRelativePath, entryCount * 1_000);

    const layer = makeFakeOutboxLayer({ relativePaths, mtimesByRelativePath, outboxRoot });

    const result = await Effect.runPromise(
      listRecentStudioOutputs({ outboxRoot, limit: 1 }).pipe(Effect.provide(layer)),
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.relativePath).toBe(mostRecentRelativePath);
  });

  it("keeps the per-file error-tolerance semantics: a failed stat is skipped, not fatal", async () => {
    const outboxRoot = "/studio/Outbox";
    const relativePaths = ["Content/broken.md", "Content/kept.md"];
    const mtimesByRelativePath = new Map<string, number>([["Content/kept.md", 5]]);
    const layer = makeFakeOutboxLayer({
      relativePaths,
      mtimesByRelativePath,
      outboxRoot,
      unstattablePaths: new Set(["Content/broken.md"]),
    });

    const result = await Effect.runPromise(
      listRecentStudioOutputs({ outboxRoot, limit: 10 }).pipe(Effect.provide(layer)),
    );

    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["Content/kept.md"]);
  });

  it("exposes the safety cap as a much larger bound than the historical fixed truncation point", () => {
    expect(MAX_SCANNED_OUTBOX_ENTRIES).toBeGreaterThan(2_000);
  });
});
