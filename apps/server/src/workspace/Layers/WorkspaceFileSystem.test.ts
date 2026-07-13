import * as NodeFs from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { createLocalPreviewGrant } from "../../localImageFiles";
import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspaceFileSystem } from "../Services/WorkspaceFileSystem";
import { WorkspaceEntriesLive } from "./WorkspaceEntries";
import { WorkspaceFileSystemLive } from "./WorkspaceFileSystem";
import { WorkspacePathsLive } from "./WorkspacePaths";

const WorkspaceLayer = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLive,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(WorkspaceEntriesLive),
  ),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-workspace-files-" });
});

const writeTextFile = Effect.fn(function* (cwd: string, relativePath: string, contents = "") {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("readFile", () => {
    it.effect("reads files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 1;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "src/app.ts",
        });

        expect(result).toEqual({
          relativePath: "src/app.ts",
          contents: "export const value = 1;\n",
          truncated: false,
        });
      }),
    );

    it.effect("returns a truncated prefix for large files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "large.txt", "abcdef");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large.txt",
          maxBytes: 3,
        });

        expect(result).toEqual({
          relativePath: "large.txt",
          contents: "abc",
          truncated: true,
        });
      }),
    );

    it.effect(
      "reads granted absolute local file paths without remapping them to the workspace",
      () =>
        Effect.gen(function* () {
          const workspaceFileSystem = yield* WorkspaceFileSystem;
          const path = yield* Path.Path;
          const cwd = yield* makeTempDir;
          const outside = yield* makeTempDir;
          yield* writeTextFile(outside, "Downloads/report.txt", "local file\n");
          const absolutePath = path.join(outside, "Downloads/report.txt");
          const grant = yield* Effect.promise(() =>
            createLocalPreviewGrant({ requestedPath: absolutePath }),
          );

          const result = yield* workspaceFileSystem.readFile({
            cwd,
            relativePath: absolutePath,
            previewGrant: grant.grant,
          });

          expect(result).toEqual({
            relativePath: absolutePath,
            contents: "local file\n",
            truncated: false,
          });
        }),
    );

    it.effect("rejects absolute local file paths without a preview grant", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "Downloads/report.txt", "local file\n");
        const absolutePath = path.join(outside, "Downloads/report.txt");

        const error = yield* workspaceFileSystem
          .readFile({
            cwd,
            relativePath: absolutePath,
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          `Workspace file path must be relative to the project root: ${absolutePath}`,
        );
      }),
    );

    it.effect("resolves a bare filename to its unique nested file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "apps/web/src/lib/chatReferences.test.ts",
          "export const v = 1;\n",
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "chatReferences.test.ts",
        });

        expect(result).toEqual({
          relativePath: "apps/web/src/lib/chatReferences.test.ts",
          contents: "export const v = 1;\n",
          truncated: false,
        });
      }),
    );

    it.effect("resolves a partial path tail to its unique nested file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "apps/web/src/lib/chatReferences.ts", "export const v = 2;\n");

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "lib/chatReferences.ts",
        });

        expect(result.relativePath).toBe("apps/web/src/lib/chatReferences.ts");
        expect(result.contents).toBe("export const v = 2;\n");
      }),
    );

    it.effect("does not resolve an ambiguous basename to a single file", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "a/index.ts", "export const a = 1;\n");
        yield* writeTextFile(cwd, "b/index.ts", "export const b = 1;\n");

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "index.ts" })
          .pipe(Effect.flip);

        expect(error.message).toContain("ENOENT");
      }),
    );

    it.effect("rejects reads outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "../escape.md" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
      }),
    );

    it.effect("rejects symlinks that escape the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const outside = yield* makeTempDir;
        yield* writeTextFile(outside, "secret.txt", "top secret\n");
        yield* Effect.promise(() =>
          NodeFs.symlink(path.join(outside, "secret.txt"), path.join(cwd, "innocent.txt")),
        );

        const error = yield* workspaceFileSystem
          .readFile({ cwd, relativePath: "innocent.txt" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: innocent.txt",
        );
      }),
    );

    it.effect("follows symlinks that resolve inside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/app.ts", "export const value = 1;\n");
        yield* Effect.promise(() =>
          NodeFs.symlink(path.join(cwd, "src/app.ts"), path.join(cwd, "alias.ts")),
        );

        const result = yield* workspaceFileSystem.readFile({ cwd, relativePath: "alias.ts" });

        expect(result.contents).toBe("export const value = 1;\n");
        expect(result.truncated).toBe(false);
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({ cwd, query: "rpc", limit: 10 });
        expect(beforeWrite).toEqual({ entries: [], truncated: false });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({ cwd, query: "rpc", limit: 10 });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({ cwd, relativePath: "../escape.md", contents: "# nope\n" })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );
        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );
  });
});
