import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

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
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "dpcode-workspace-files-" });
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

  describe("applyTextEdit", () => {
    it.effect("updates a unique rendered text match in source files", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(
          cwd,
          "src/App.tsx",
          "export function App() { return <h1>Original title</h1>; }\n",
        );

        const result = yield* workspaceFileSystem.applyTextEdit({
          cwd,
          originalText: "Original title",
          nextText: "Edited title",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "src/App.tsx"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "src/App.tsx", replacements: 1 });
        expect(saved).toBe("export function App() { return <h1>Edited title</h1>; }\n");
      }),
    );

    it.effect("rejects ambiguous text matches", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/App.tsx", "<button>Save</button>\n<button>Save</button>\n");

        const error = yield* workspaceFileSystem
          .applyTextEdit({
            cwd,
            originalText: "Save",
            nextText: "Publish",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("Selected text appears in multiple source locations.");
      }),
    );

    it.effect("uses selected element metadata to update duplicated text safely", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(
          cwd,
          "src/App.tsx",
          [
            "export function App() {",
            "  return (",
            "    <>",
            '      <h1 id="hero-title">Save</h1>',
            "      <button>Save</button>",
            "    </>",
            "  );",
            "}",
            "",
          ].join("\n"),
        );

        const result = yield* workspaceFileSystem.applyTextEdit({
          cwd,
          originalText: "Save",
          nextText: "Launch",
          element: {
            tagName: "h1",
            text: "Save",
            attributes: { id: "hero-title" },
          },
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "src/App.tsx"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "src/App.tsx", replacements: 1 });
        expect(saved).toContain('<h1 id="hero-title">Launch</h1>');
        expect(saved).toContain("<button>Save</button>");
      }),
    );
  });

  describe("applyStyleEdit", () => {
    it.effect("adds an inline JSX style object to a unique selected element", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeTextFile(
          cwd,
          "src/App.tsx",
          "export function App() { return <h1 id=\"hero-title\">Original title</h1>; }\n",
        );

        const result = yield* workspaceFileSystem.applyStyleEdit({
          cwd,
          element: {
            tagName: "h1",
            text: "Original title",
            attributes: { id: "hero-title" },
          },
          patch: { color: "rgb(17, 19, 24)", fontSize: "72px" },
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "src/App.tsx"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "src/App.tsx", replacements: 1 });
        expect(saved).toContain(
          '<h1 id="hero-title" style={{ color: "rgb(17, 19, 24)", fontSize: "72px" }}>Original title</h1>',
        );
      }),
    );

    it.effect("rejects ambiguous style edit source matches", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/App.tsx", "<h1>Save</h1>\n<h1>Save</h1>\n");

        const error = yield* workspaceFileSystem
          .applyStyleEdit({
            cwd,
            element: { tagName: "h1", text: "Save", attributes: {} },
            patch: { color: "red" },
          })
          .pipe(Effect.flip);

        expect(error.message).toContain("Selected element maps to multiple possible source locations.");
      }),
    );
  });
});
