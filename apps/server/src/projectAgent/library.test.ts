import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId } from "@synara/contracts";
import { Effect, Exit, FileSystem, Layer } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { GitCore } from "../git/Services/GitCore.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import { GitCoreLive } from "../git/Layers/GitCore.ts";
import { GitCommandError } from "../git/Errors.ts";
import { LibraryError } from "./Errors.ts";
import {
  commitLibraryChange,
  libraryHistory,
  pushLibraryIfConfigured,
  readLibraryPushStatus,
  restoreLibraryEntry,
  withLibraryQueue,
} from "./libraryGit.ts";
import {
  assertLibraryRootLocation,
  ensureLibraryRepo,
  listLibraryEntries,
  moveLibraryRoot,
  normalizeLibraryRelativePath,
  renameLibraryEntry,
  resolveLibraryCreateTarget,
  resolveLibraryRoot,
  resolveLibraryTarget,
  resolveLibraryWriteTarget,
} from "./libraryStore.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "synara-library-test-",
});
const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  GitCoreLive.pipe(Layer.provide(ServerConfigLayer), Layer.provide(NodeServices.layer)),
);

const makeTmpDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix: "synara-library-" });
});

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.flip(effect);

describe("normalizeLibraryRelativePath", () => {
  it("rejects parent traversal and absolute paths", () => {
    for (const raw of ["..", "../outside.txt", "..\\outside.txt", "/abs/file.txt", "a/../../b"]) {
      const exit = Effect.runSync(Effect.exit(normalizeLibraryRelativePath(raw)));
      expect(Exit.isFailure(exit), raw).toBe(true);
    }
  });

  it("rejects .git addressing and accepts nested forward-slash paths", () => {
    const exit = Effect.runSync(Effect.exit(normalizeLibraryRelativePath(".git/config")));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Effect.runSync(normalizeLibraryRelativePath("Artifacts\\note.md"))).toBe(
      "Artifacts/note.md",
    );
  });

  it("rejects case-variant .git segments on case-insensitive filesystems", () => {
    // On macOS/Windows ".GIT/config" resolves onto ".git/config", so the
    // segment check must compare case-folded.
    for (const raw of [".GIT/config", ".Git/objects/x", "sub/.GIT/config", ".git"]) {
      const exit = Effect.runSync(Effect.exit(normalizeLibraryRelativePath(raw)));
      expect(Exit.isFailure(exit), raw).toBe(true);
    }
  });
});

describe("resolveLibraryRoot", () => {
  it("defaults to the project context dir and validates custom paths", () => {
    const projectId = ProjectId.makeUnsafe("group-1");
    const defaultRoot = Effect.runSync(resolveLibraryRoot({ stateDir: "/state", projectId }));
    expect(defaultRoot).toBe(path.join("/state", "project-context", projectId, "library"));
    const custom = Effect.runSync(
      resolveLibraryRoot({ stateDir: "/state", projectId, libraryPath: "/opt/library" }),
    );
    expect(custom).toBe(path.normalize("/opt/library"));
    for (const bad of ["relative/path", "/opt/../escape"]) {
      const exit = Effect.runSync(
        Effect.exit(resolveLibraryRoot({ stateDir: "/state", projectId, libraryPath: bad })),
      );
      expect(Exit.isFailure(exit), bad).toBe(true);
    }
  });
});

it.layer(TestLayer)("group library", (it) => {
  it.effect("initializes a git repo with Artifacts/ and an initial commit on first use", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      const libraryRoot = path.join(root, "library");

      yield* ensureLibraryRepo(git, libraryRoot);

      const stat = yield* Effect.promise(() => fs.stat(path.join(libraryRoot, ".git")));
      expect(stat.isDirectory()).toBe(true);
      const entries = yield* listLibraryEntries(libraryRoot);
      expect(entries.map((entry) => entry.name)).toEqual(["Artifacts"]);

      const history = yield* libraryHistory(git, libraryRoot);
      expect(history.map((commit) => commit.message)).toEqual(["Initialize library"]);
      expect(history[0]?.author).toBe("Synara Library");

      // Second call is a no-op: no extra commits.
      yield* ensureLibraryRepo(git, libraryRoot);
      const again = yield* libraryHistory(git, libraryRoot);
      expect(again.length).toBe(1);
    }),
  );

  it.effect("commits each mutation and reports file entries", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);

      const target = yield* resolveLibraryWriteTarget(root, "Artifacts/note.md");
      yield* Effect.promise(() => fs.writeFile(target, "hello library", "utf8"));
      const { commitSha } = yield* commitLibraryChange(git, root, "Add Artifacts/note.md");

      const entries = yield* listLibraryEntries(root, "Artifacts");
      const note = entries.find((entry) => entry.name === "note.md");
      expect(note?.kind).toBe("file");
      expect(note?.relativePath).toBe("Artifacts/note.md");
      expect(note?.sizeBytes).toBe("hello library".length);

      const history = yield* libraryHistory(git, root, "Artifacts/note.md");
      expect(history[0]?.sha).toBe(commitSha);
      expect(history[0]?.message).toBe("Add Artifacts/note.md");
    }),
  );

  it.effect("follows renames in file history", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);

      const source = yield* resolveLibraryWriteTarget(root, "a.md");
      yield* Effect.promise(() => fs.writeFile(source, "one", "utf8"));
      yield* commitLibraryChange(git, root, "Add a.md");
      const renamed = yield* resolveLibraryCreateTarget(root, "b.md");
      yield* Effect.promise(() => fs.rename(source, renamed));
      yield* commitLibraryChange(git, root, "Rename a.md to b.md");

      const history = yield* libraryHistory(git, root, "b.md");
      expect(history.map((commit) => commit.message)).toContain("Add a.md");
      expect(history.map((commit) => commit.message)).toContain("Rename a.md to b.md");
    }),
  );

  it.effect("restores a file to an older commit and records the rollback", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);

      const target = yield* resolveLibraryWriteTarget(root, "doc.md");
      yield* Effect.promise(() => fs.writeFile(target, "version-one", "utf8"));
      const first = yield* commitLibraryChange(git, root, "Add doc.md");
      yield* Effect.promise(() => fs.writeFile(target, "version-two", "utf8"));
      yield* commitLibraryChange(git, root, "Update doc.md");

      yield* restoreLibraryEntry(git, root, "doc.md", first.commitSha);

      const contents = yield* Effect.promise(() => fs.readFile(target, "utf8"));
      expect(contents).toBe("version-one");
      const history = yield* libraryHistory(git, root, "doc.md");
      expect(history[0]?.message).toBe(`Restore doc.md from ${first.commitSha.slice(0, 7)}`);
    }),
  );

  it.effect("restores a renamed file to a pre-rename version in place", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);

      const source = yield* resolveLibraryWriteTarget(root, "a.md");
      yield* Effect.promise(() => fs.writeFile(source, "original", "utf8"));
      const added = yield* commitLibraryChange(git, root, "Add a.md");
      const renamed = yield* resolveLibraryCreateTarget(root, "b.md");
      yield* Effect.promise(() => fs.rename(source, renamed));
      yield* commitLibraryChange(git, root, "Rename a.md to b.md");
      yield* Effect.promise(() => fs.writeFile(renamed, "edited", "utf8"));
      yield* commitLibraryChange(git, root, "Update b.md");

      yield* restoreLibraryEntry(git, root, "b.md", added.commitSha);

      const contents = yield* Effect.promise(() => fs.readFile(renamed, "utf8"));
      expect(contents).toBe("original");
      const names = yield* Effect.promise(() => fs.readdir(root));
      expect(names).not.toContain("a.md");
      const history = yield* libraryHistory(git, root, "b.md");
      expect(history[0]?.message).toBe(`Restore b.md from ${added.commitSha.slice(0, 7)}`);
    }),
  );

  it.effect("serializes concurrent queued mutations into two commits", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      const projectId = "project-serial";
      yield* ensureLibraryRepo(git, root);

      const writeAndCommit = (name: string) =>
        withLibraryQueue(
          projectId,
          Effect.gen(function* () {
            const target = yield* resolveLibraryWriteTarget(root, name);
            yield* Effect.promise(() => fs.writeFile(target, name, "utf8"));
            return yield* commitLibraryChange(git, root, `Add ${name}`);
          }),
        );

      const [first, second] = yield* Effect.all(
        [writeAndCommit("one.txt"), writeAndCommit("two.txt")],
        { concurrency: "unbounded" },
      );
      expect(first.commitSha).not.toBe(second.commitSha);

      const history = yield* libraryHistory(git, root);
      // Init + two serialized mutation commits, no interleaved staging.
      expect(history.length).toBe(3);
      const names = yield* Effect.promise(() => fs.readdir(root));
      expect(names).toEqual(expect.arrayContaining(["one.txt", "two.txt"]));
    }),
  );

  it.effect("rejects symlink escapes from the library root", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const outside = yield* makeTmpDir;
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.txt"), "x", "utf8"));
      yield* Effect.promise(() => fs.symlink(outside, path.join(root, "linked"), "dir"));

      const error = yield* failureOf(resolveLibraryTarget(root, "linked/secret.txt"));
      expect(error).toBeInstanceOf(LibraryError);
      expect(error.code).toBe("forbidden");
    }),
  );

  it.effect("moves the tree including .git and never deletes the source", () =>
    Effect.gen(function* () {
      const base = yield* makeTmpDir;
      const git = yield* GitCore;
      const fromRoot = path.join(base, "old-library");
      const toRoot = path.join(base, "new-library");
      yield* ensureLibraryRepo(git, fromRoot);
      const target = yield* resolveLibraryWriteTarget(fromRoot, "keep.md");
      yield* Effect.promise(() => fs.writeFile(target, "kept", "utf8"));
      yield* commitLibraryChange(git, fromRoot, "Add keep.md");

      const result = yield* moveLibraryRoot({ fromRoot, toRoot });
      expect(result.moved).toBe(true);
      // Source left intact; history travels with the copy.
      const sourceKept = yield* Effect.promise(() => fs.readFile(target, "utf8"));
      expect(sourceKept).toBe("kept");
      const copiedHistory = yield* libraryHistory(git, toRoot);
      expect(copiedHistory.map((commit) => commit.message)).toContain("Add keep.md");

      // Re-running the move is idempotent now that the destination is a repo.
      const again = yield* moveLibraryRoot({ fromRoot, toRoot });
      expect(again.moved).toBe(true);

      // Missing source is a no-op; a non-empty non-repo destination conflicts.
      const missing = yield* moveLibraryRoot({
        fromRoot: path.join(base, "absent"),
        toRoot: path.join(base, "elsewhere"),
      });
      expect(missing.moved).toBe(false);
      const conflictDest = path.join(base, "conflict-dest");
      yield* Effect.promise(() =>
        fs
          .mkdir(conflictDest, { recursive: true })
          .then(() => fs.writeFile(path.join(conflictDest, "user.txt"), "mine", "utf8")),
      );
      const conflict = yield* failureOf(moveLibraryRoot({ fromRoot, toRoot: conflictDest }));
      expect(conflict).toBeInstanceOf(LibraryError);
      expect(conflict.code).toBe("conflict");

      // A destination nested inside the source would copy the tree into itself.
      const nested = yield* failureOf(
        moveLibraryRoot({ fromRoot, toRoot: path.join(fromRoot, "inner") }),
      );
      expect(nested).toBeInstanceOf(LibraryError);
      expect(nested.code).toBe("invalid");
    }),
  );

  it.effect("refuses to rename onto an existing entry", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);
      const a = yield* resolveLibraryWriteTarget(root, "a.md");
      const b = yield* resolveLibraryWriteTarget(root, "b.md");
      yield* Effect.promise(() => fs.writeFile(a, "a", "utf8"));
      yield* Effect.promise(() => fs.writeFile(b, "b", "utf8"));

      const error = yield* failureOf(renameLibraryEntry(root, "a.md", "b.md"));
      expect(error).toBeInstanceOf(LibraryError);
      expect(error.code).toBe("conflict");
      // The destination is untouched.
      expect(yield* Effect.promise(() => fs.readFile(b, "utf8"))).toBe("b");

      // A fresh destination still renames.
      yield* renameLibraryEntry(root, "a.md", "c.md");
      expect(yield* Effect.promise(() => fs.readFile(path.join(root, "c.md"), "utf8"))).toBe("a");
    }),
  );

  it.effect("rejects restore shas that are not 40-hex or not in history", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);
      const target = yield* resolveLibraryWriteTarget(root, "doc.md");
      yield* Effect.promise(() => fs.writeFile(target, "v1", "utf8"));
      const { commitSha } = yield* commitLibraryChange(git, root, "Add doc.md");

      // Abbreviated or option-shaped shas are refused before reaching git argv.
      const short = yield* failureOf(
        restoreLibraryEntry(git, root, "doc.md", commitSha.slice(0, 7)),
      );
      expect(short).toBeInstanceOf(GitCommandError);
      const optionLike = yield* failureOf(
        restoreLibraryEntry(git, root, "doc.md", `-n${"0".repeat(38)}`),
      );
      expect(optionLike).toBeInstanceOf(GitCommandError);

      // A well-formed but unknown commit fails explicitly.
      const unknown = yield* failureOf(restoreLibraryEntry(git, root, "doc.md", "0".repeat(40)));
      expect(unknown).toBeInstanceOf(GitCommandError);
      expect(unknown.detail).toContain("does not exist");
    }),
  );

  it.effect("rejects unsafe remote URLs without running git", () =>
    Effect.gen(function* () {
      const executed: string[] = [];
      const git = {
        execute: (input: { readonly args: readonly string[] }) => {
          executed.push(input.args.join(" "));
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        },
      } as unknown as GitCoreShape;
      const projectId = "project-remote-url";

      // A remote-helper URL would execute on push; it must be rejected before
      // `git remote add` ever runs.
      yield* pushLibraryIfConfigured({
        git,
        root: "/nonexistent",
        projectId,
        libraryRemoteUrl: 'ext::sh -c "echo pwned"',
        libraryPushOnChange: true,
      });
      expect(executed).toEqual([]);
      expect(readLibraryPushStatus(projectId).lastPushError).toContain("https://");

      const leadingOption = "-upload-pack=sh";
      yield* pushLibraryIfConfigured({
        git,
        root: "/nonexistent",
        projectId,
        libraryRemoteUrl: leadingOption,
        libraryPushOnChange: true,
      });
      expect(executed).toEqual([]);

      // A well-formed https remote reaches `git remote add`.
      yield* pushLibraryIfConfigured({
        git,
        root: "/nonexistent",
        projectId,
        libraryRemoteUrl: "https://example.com/library.git",
        libraryPushOnChange: true,
      });
      expect(executed.some((args) => args.includes("remote add"))).toBe(true);
    }),
  );

  it.effect("confines a custom library path to managed roots or clean picks", () =>
    Effect.gen(function* () {
      const base = yield* makeTmpDir;
      const stateDir = path.join(base, "state");
      const groupsRoot = path.join(base, "groups");
      const studioRoot = path.join(base, "studio");
      const allowed = (root: string, isCustomPath = true) =>
        assertLibraryRootLocation({
          root,
          stateDir,
          groupsWorkspaceRoot: groupsRoot,
          studioWorkspaceRoot: studioRoot,
          isCustomPath,
        });

      // Inside a managed root, a fresh empty folder, and a missing path all
      // pass; the default (non-custom) location always passes.
      yield* allowed(path.join(stateDir, "library"));
      yield* allowed(path.join(base, "missing"), true);
      yield* allowed(path.join(base, "anything"), false);
      const emptyDir = path.join(base, "empty");
      yield* Effect.promise(() => fs.mkdir(emptyDir));
      yield* allowed(emptyDir);

      // A foreign git repo and a non-empty user directory are refused.
      const foreignRepo = path.join(base, "foreign");
      yield* Effect.promise(() => fs.mkdir(path.join(foreignRepo, ".git"), { recursive: true }));
      const foreignError = yield* failureOf(allowed(foreignRepo));
      expect(foreignError.code).toBe("forbidden");
      const nonEmpty = path.join(base, "nonempty");
      yield* Effect.promise(() =>
        fs
          .mkdir(nonEmpty, { recursive: true })
          .then(() => fs.writeFile(path.join(nonEmpty, "user.txt"), "x", "utf8")),
      );
      const nonEmptyError = yield* failureOf(allowed(nonEmpty));
      expect(nonEmptyError.code).toBe("forbidden");

      // A Synara-seeded library (marker present) is accepted.
      const seeded = path.join(base, "seeded");
      yield* Effect.promise(() =>
        fs
          .mkdir(path.join(seeded, ".git"), { recursive: true })
          .then(() =>
            fs.writeFile(path.join(seeded, ".synara-library"), "synara-library\n", "utf8"),
          ),
      );
      yield* allowed(seeded);
    }),
  );

  it.effect("backfills the marker onto a pre-marker library repository", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);
      // Libraries created before the marker existed have .git but no marker;
      // ensureLibraryRepo adopts them and lazily writes the marker.
      yield* Effect.promise(() => fs.rm(path.join(root, ".synara-library")));
      yield* ensureLibraryRepo(git, root);
      const marker = yield* Effect.promise(() =>
        fs.readFile(path.join(root, ".synara-library"), "utf8"),
      );
      expect(marker).toBe("synara-library\n");
      const history = yield* libraryHistory(git, root);
      expect(history.length).toBe(1);
    }),
  );

  it.effect("lists directories ahead of files and hides git metadata", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root);
      const file = yield* resolveLibraryWriteTarget(root, "zeta.md");
      yield* Effect.promise(() => fs.writeFile(file, "z", "utf8"));
      const nested = yield* resolveLibraryWriteTarget(root, "Alpha/inner.md");
      yield* Effect.promise(() => fs.writeFile(nested, "a", "utf8"));

      const entries = yield* listLibraryEntries(root);
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["Alpha", "Artifacts", "zeta.md"],
      );
      expect(entries.find((entry) => entry.name === ".git")).toBeUndefined();
      expect(entries.find((entry) => entry.name === ".gitkeep")).toBeUndefined();
    }),
  );
});
