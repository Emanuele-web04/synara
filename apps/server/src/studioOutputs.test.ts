import { Effect, FileSystem, Layer, Path } from "effect";
import { describe, expect, it } from "vitest";

import {
  collectFileChangeActivityPathCandidates,
  collectThreadOutputRelativePaths,
  diffStudioWorkspaceScans,
  listStudioThreadOutputs,
  MAX_SCAN_ENTRIES,
  MAX_THREAD_OUTPUT_FILES,
  scanStudioWorkspaceFiles,
  STAT_CONCURRENCY,
} from "./studioOutputs";

function checkpoint(paths: readonly string[]) {
  return { files: paths.map((path) => ({ path })) };
}

describe("collectThreadOutputRelativePaths", () => {
  it("keeps files anywhere under the root except managed input/infra subtrees", () => {
    const relativePaths = collectThreadOutputRelativePaths([
      checkpoint([
        "Outbox/Content/post.md",
        "output/pdf/report.pdf",
        "notes.md",
        "Inbox/task.md",
        "Context/reference.md",
        "Skills/skill.md",
        "tmp/scratch.py",
        "Logs/run.log",
        "AGENTS.md",
        "CLAUDE.md",
      ]),
    ]);

    expect(relativePaths).toEqual(["Outbox/Content/post.md", "output/pdf/report.pdf", "notes.md"]);
  });

  it("excludes managed subtrees case-insensitively", () => {
    const relativePaths = collectThreadOutputRelativePaths([
      checkpoint(["TMP/scratch.py", "logs/run.log", "Output/kept.pdf"]),
    ]);

    expect(relativePaths).toEqual(["Output/kept.pdf"]);
  });

  it("deduplicates across checkpoints, preferring newest-first order", () => {
    const relativePaths = collectThreadOutputRelativePaths([
      checkpoint(["Outbox/Content/old.md"]),
      checkpoint(["Outbox/Content/new.md", "Outbox/Content/old.md"]),
    ]);

    expect(relativePaths).toEqual(["Outbox/Content/new.md", "Outbox/Content/old.md"]);
  });

  it("rejects unsafe segments so no path can escape the workspace root", () => {
    const relativePaths = collectThreadOutputRelativePaths([
      checkpoint([
        "../secrets.md",
        "Outbox/../secrets.md",
        "Outbox/./file.md",
        "Outbox//double.md",
        "Outbox/Content/kept.md",
      ]),
    ]);

    expect(relativePaths).toEqual(["Outbox/Content/kept.md"]);
  });

  it("skips hidden files and node_modules anywhere under the root", () => {
    const relativePaths = collectThreadOutputRelativePaths([
      checkpoint([
        "Outbox/Content/.DS_Store",
        ".hidden/post.md",
        "site/node_modules/pkg/index.js",
        "Outbox/Content/kept.md",
      ]),
    ]);

    expect(relativePaths).toEqual(["Outbox/Content/kept.md"]);
  });

  it("caps the collected paths, dropping the oldest turns' files first", () => {
    const oldest = checkpoint(
      Array.from({ length: 5 }, (_unused, index) => `Outbox/Content/old-${index}.md`),
    );
    const newest = checkpoint(
      Array.from(
        { length: MAX_THREAD_OUTPUT_FILES },
        (_u, index) => `Outbox/Daily/new-${index}.md`,
      ),
    );

    const relativePaths = collectThreadOutputRelativePaths([oldest, newest]);

    expect(relativePaths).toHaveLength(MAX_THREAD_OUTPUT_FILES);
    expect(relativePaths[0]).toBe("Outbox/Daily/new-0.md");
    expect(relativePaths).not.toContain("Outbox/Content/old-0.md");
  });
});

describe("collectFileChangeActivityPathCandidates", () => {
  it("extracts provider-specific nested path fields newest first", () => {
    const paths = collectFileChangeActivityPathCandidates([
      {
        status: "completed",
        data: { item: { changes: [{ path: "Outbox/Daily/new.md" }] } },
      },
      {
        status: "completed",
        data: { input: { file_path: "Outbox/Content/post.md" } },
      },
    ]);

    expect(paths).toEqual(["Outbox/Daily/new.md", "Outbox/Content/post.md"]);
  });

  it("ignores failed activities and deduplicates repeated path fields", () => {
    const paths = collectFileChangeActivityPathCandidates([
      {
        status: "failed",
        data: { input: { filePath: "Outbox/Content/failed.md" } },
      },
      {
        status: "completed",
        data: {
          input: { path: "Outbox/Content/kept.md" },
          result: { path: "Outbox/Content/kept.md" },
        },
      },
    ]);

    expect(paths).toEqual(["Outbox/Content/kept.md"]);
  });
});

describe("diffStudioWorkspaceScans", () => {
  it("reports new and changed files, ignoring deletions and unchanged files", () => {
    const before = new Map([
      ["Outbox/kept.md", { mtimeMs: 1, size: 10 }],
      ["Outbox/touched.md", { mtimeMs: 1, size: 10 }],
      ["Outbox/resized.md", { mtimeMs: 1, size: 10 }],
      ["Outbox/deleted.md", { mtimeMs: 1, size: 10 }],
    ]);
    const after = new Map([
      ["Outbox/kept.md", { mtimeMs: 1, size: 10 }],
      ["Outbox/touched.md", { mtimeMs: 2, size: 10 }],
      ["Outbox/resized.md", { mtimeMs: 1, size: 11 }],
      ["output/pdf/new.pdf", { mtimeMs: 3, size: 99 }],
    ]);

    expect(diffStudioWorkspaceScans(before, after)).toEqual([
      "Outbox/touched.md",
      "Outbox/resized.md",
      "output/pdf/new.pdf",
    ]);
  });
});

function fakeFileInfo(type: "Directory" | "File"): FileSystem.File.Info {
  return {
    type,
    mtime: undefined,
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
  };
}

describe("scanStudioWorkspaceFiles", () => {
  it("bounds traversal by total directory entries, not only discovered files", async () => {
    const workspaceRoot = "/studio";
    const rootEntries = Array.from(
      { length: MAX_SCAN_ENTRIES + 5 },
      (_unused, index) => `directory-${index}`,
    );
    let statCallCount = 0;
    const fileSystemLayer = FileSystem.layerNoop({
      readDirectory: (directoryPath: string) =>
        Effect.succeed(directoryPath === workspaceRoot ? rootEntries : []),
      readLink: () => Effect.fail(new Error("EINVAL") as never),
      stat: () => {
        statCallCount += 1;
        return Effect.succeed(fakeFileInfo("Directory"));
      },
    });

    const result = await Effect.runPromise(
      scanStudioWorkspaceFiles({ workspaceRoot }).pipe(
        Effect.provide(Layer.merge(fileSystemLayer, Path.layer)),
      ),
    );

    expect(result.size).toBe(0);
    expect(statCallCount).toBe(MAX_SCAN_ENTRIES);
  });

  it("stats workspace entries with bounded concurrency", async () => {
    const workspaceRoot = "/studio";
    const outputEntries = Array.from({ length: 32 }, (_unused, index) => `file-${index}.md`);
    const rootEntries = [...outputEntries, "AGENTS.md", "CLAUDE.md"];
    let activeStatCount = 0;
    let maxActiveStatCount = 0;
    const fileSystemLayer = FileSystem.layerNoop({
      readDirectory: (directoryPath: string) =>
        Effect.succeed(directoryPath === workspaceRoot ? rootEntries : []),
      stat: () =>
        Effect.gen(function* () {
          activeStatCount += 1;
          maxActiveStatCount = Math.max(maxActiveStatCount, activeStatCount);
          yield* Effect.sleep("2 millis");
          activeStatCount -= 1;
          return fakeFileInfo("File");
        }),
    });

    const result = await Effect.runPromise(
      scanStudioWorkspaceFiles({ workspaceRoot }).pipe(
        Effect.provide(Layer.merge(fileSystemLayer, Path.layer)),
      ),
    );

    expect(result.size).toBe(outputEntries.length);
    expect(result.has("AGENTS.md")).toBe(false);
    expect(result.has("CLAUDE.md")).toBe(false);
    expect(maxActiveStatCount).toBeGreaterThan(1);
    expect(maxActiveStatCount).toBeLessThanOrEqual(STAT_CONCURRENCY);
  });
});

/**
 * Fake `FileSystem` (+ real `Path`) layer whose `stat` looks up mtimes from
 * `mtimesByRelativePath` (relative to the workspace root); unknown paths fail like a
 * missing file would.
 */
function makeFakeStudioRootLayer(input: {
  readonly mtimesByRelativePath: ReadonlyMap<string, number>;
  readonly workspaceRoot: string;
  readonly directoryPaths?: ReadonlySet<string>;
}) {
  const fileSystemLayer = FileSystem.layerNoop({
    stat: (fullPath: string) => {
      const relativePath = fullPath.slice(input.workspaceRoot.length + 1);
      const isDirectory = input.directoryPaths?.has(relativePath) === true;
      const modifiedAtMs = input.mtimesByRelativePath.get(relativePath);
      if (modifiedAtMs === undefined && !isDirectory) {
        return Effect.fail(new Error("ENOENT") as never);
      }
      return Effect.succeed({
        type: isDirectory ? ("Directory" as const) : ("File" as const),
        mtime: new Date(modifiedAtMs ?? 0),
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

describe("listStudioThreadOutputs", () => {
  it("returns existing files most recently modified first, with name and full path", async () => {
    const workspaceRoot = "/studio";
    const layer = makeFakeStudioRootLayer({
      workspaceRoot,
      mtimesByRelativePath: new Map([
        ["Outbox/Content/old.md", 1_000],
        ["output/pdf/new.pdf", 3_000],
      ]),
    });

    const result = await Effect.runPromise(
      listStudioThreadOutputs({
        workspaceRoot,
        checkpoints: [checkpoint(["Outbox/Content/old.md", "output/pdf/new.pdf"])],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.entries).toEqual([
      {
        name: "new.pdf",
        relativePath: "output/pdf/new.pdf",
        fullPath: "/studio/output/pdf/new.pdf",
        modifiedAt: new Date(3_000).toISOString(),
      },
      {
        name: "old.md",
        relativePath: "Outbox/Content/old.md",
        fullPath: "/studio/Outbox/Content/old.md",
        modifiedAt: new Date(1_000).toISOString(),
      },
    ]);
  });

  it("omits files that no longer exist and non-file entries instead of failing", async () => {
    const workspaceRoot = "/studio";
    const layer = makeFakeStudioRootLayer({
      workspaceRoot,
      mtimesByRelativePath: new Map([["Outbox/Content/kept.md", 5]]),
      directoryPaths: new Set(["Outbox/Content/folder"]),
    });

    const result = await Effect.runPromise(
      listStudioThreadOutputs({
        workspaceRoot,
        checkpoints: [
          checkpoint([
            "Outbox/Content/deleted.md",
            "Outbox/Content/folder",
            "Outbox/Content/kept.md",
          ]),
        ],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.entries.map((entry) => entry.relativePath)).toEqual(["Outbox/Content/kept.md"]);
  });

  it("returns no entries for a thread that only touched managed input subtrees", async () => {
    const workspaceRoot = "/studio";
    const layer = makeFakeStudioRootLayer({ workspaceRoot, mtimesByRelativePath: new Map() });

    const result = await Effect.runPromise(
      listStudioThreadOutputs({
        workspaceRoot,
        checkpoints: [checkpoint(["Inbox/task.md", "tmp/scratch.py"])],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.entries).toEqual([]);
  });

  it("attributes outputs from file-change activities when no Git checkpoints exist", async () => {
    const workspaceRoot = "/studio";
    const layer = makeFakeStudioRootLayer({
      workspaceRoot,
      mtimesByRelativePath: new Map([
        ["Outbox/Content/relative.md", 10],
        ["output/pdf/absolute.pdf", 20],
      ]),
    });

    const result = await Effect.runPromise(
      listStudioThreadOutputs({
        workspaceRoot,
        checkpoints: [],
        fileChangeActivityPayloads: [
          {
            status: "completed",
            data: {
              changes: [
                { path: "/studio/output/pdf/absolute.pdf" },
                { file_path: "Outbox/Content/relative.md" },
                { path: "/studio/Inbox/not-an-output.md" },
                { path: "/outside/escape.md" },
              ],
            },
          },
        ],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      "output/pdf/absolute.pdf",
      "Outbox/Content/relative.md",
    ]);
  });
});
