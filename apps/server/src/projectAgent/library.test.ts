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
  withLibraryQueues,
} from "./libraryGit.ts";
import {
  assertLibraryRootLocation,
  createLibraryDirectory,
  deleteLibraryEntry,
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

const testProjectId = ProjectId.makeUnsafe("group-library-owner");

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

      yield* ensureLibraryRepo(git, libraryRoot, testProjectId);

      const stat = yield* Effect.promise(() => fs.stat(path.join(libraryRoot, ".git")));
      expect(stat.isDirectory()).toBe(true);
      const entries = yield* listLibraryEntries(libraryRoot);
      expect(entries.map((entry) => entry.name)).toEqual(["Artifacts"]);

      const history = yield* libraryHistory(git, libraryRoot);
      expect(history.map((commit) => commit.message)).toEqual(["Initialize library"]);
      expect(history[0]?.author).toBe("Synara Library");

      // Second call is a no-op: no extra commits.
      yield* ensureLibraryRepo(git, libraryRoot, testProjectId);
      const again = yield* libraryHistory(git, libraryRoot);
      expect(again.length).toBe(1);
    }),
  );

  it.effect("commits each mutation and reports file entries", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId);

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
      yield* ensureLibraryRepo(git, root, testProjectId);

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
      yield* ensureLibraryRepo(git, root, testProjectId);

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
      yield* ensureLibraryRepo(git, root, testProjectId);

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

  it.effect(
    "restores a deleted file at an ancestor sha with unrelated commits after the delete",
    () =>
      Effect.gen(function* () {
        const root = yield* makeTmpDir;
        const git = yield* GitCore;
        yield* ensureLibraryRepo(git, root, testProjectId);

        const a = yield* resolveLibraryWriteTarget(root, "a.md");
        yield* Effect.promise(() => fs.writeFile(a, "alpha", "utf8"));
        yield* commitLibraryChange(git, root, "Add a.md");
        const b = yield* resolveLibraryWriteTarget(root, "b.md");
        yield* Effect.promise(() => fs.writeFile(b, "beta", "utf8"));
        const addB = yield* commitLibraryChange(git, root, "Add b.md");

        // Delete a.md, then land commits that never touched a.md — the UI passes
        // the commit right before the delete, which is just some ancestor.
        yield* deleteLibraryEntry(root, "a.md");
        const del = yield* commitLibraryChange(git, root, "Delete a.md");
        const renamedB = yield* resolveLibraryCreateTarget(root, "c.md");
        yield* Effect.promise(() => fs.rename(b, renamedB));
        yield* commitLibraryChange(git, root, "Rename b.md to c.md");

        yield* restoreLibraryEntry(git, root, "a.md", addB.commitSha);

        const contents = yield* Effect.promise(() => fs.readFile(a, "utf8"));
        expect(contents).toBe("alpha");
        const history = yield* libraryHistory(git, root, "a.md");
        expect(history[0]?.message).toBe(`Restore a.md from ${addB.commitSha.slice(0, 7)}`);

        // The delete commit itself and a sha where the path never existed still
        // refuse: no resurrection at a commit that saw the file gone.
        const atDelete = yield* failureOf(restoreLibraryEntry(git, root, "a.md", del.commitSha));
        expect(atDelete).toBeInstanceOf(GitCommandError);
        const init = yield* git.execute({
          operation: "library.testInitSha",
          cwd: root,
          args: ["rev-list", "--max-parents=0", "HEAD"],
          allowNonZeroExit: false,
        });
        const beforeExistence = yield* failureOf(
          restoreLibraryEntry(git, root, "a.md", init.stdout.trim()),
        );
        expect(beforeExistence).toBeInstanceOf(GitCommandError);
        expect(beforeExistence.detail).toContain("did not change");
      }),
  );

  it.effect("serializes concurrent queued mutations into two commits", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      const projectId = "project-serial";
      yield* ensureLibraryRepo(git, root, testProjectId);

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
      yield* ensureLibraryRepo(git, fromRoot, testProjectId);
      const target = yield* resolveLibraryWriteTarget(fromRoot, "keep.md");
      yield* Effect.promise(() => fs.writeFile(target, "kept", "utf8"));
      yield* commitLibraryChange(git, fromRoot, "Add keep.md");

      const result = yield* moveLibraryRoot({ fromRoot, toRoot, projectId: testProjectId });
      expect(result.moved).toBe(true);
      // Source left intact; history travels with the copy.
      const sourceKept = yield* Effect.promise(() => fs.readFile(target, "utf8"));
      expect(sourceKept).toBe("kept");
      const copiedHistory = yield* libraryHistory(git, toRoot);
      expect(copiedHistory.map((commit) => commit.message)).toContain("Add keep.md");

      // Re-running the move is idempotent now that the destination is a repo.
      const again = yield* moveLibraryRoot({ fromRoot, toRoot, projectId: testProjectId });
      expect(again.moved).toBe(true);

      // Missing source is a no-op; a non-empty non-repo destination conflicts.
      const missing = yield* moveLibraryRoot({
        fromRoot: path.join(base, "absent"),
        toRoot: path.join(base, "elsewhere"),
        projectId: testProjectId,
      });
      expect(missing.moved).toBe(false);
      const conflictDest = path.join(base, "conflict-dest");
      yield* Effect.promise(() =>
        fs
          .mkdir(conflictDest, { recursive: true })
          .then(() => fs.writeFile(path.join(conflictDest, "user.txt"), "mine", "utf8")),
      );
      const conflict = yield* failureOf(
        moveLibraryRoot({ fromRoot, toRoot: conflictDest, projectId: testProjectId }),
      );
      expect(conflict).toBeInstanceOf(LibraryError);
      expect(conflict.code).toBe("conflict");

      // A destination nested inside the source would copy the tree into itself.
      const nested = yield* failureOf(
        moveLibraryRoot({
          fromRoot,
          toRoot: path.join(fromRoot, "inner"),
          projectId: testProjectId,
        }),
      );
      expect(nested).toBeInstanceOf(LibraryError);
      expect(nested.code).toBe("invalid");
    }),
  );

  it.effect("refuses to rename onto an existing entry", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId);
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
      yield* ensureLibraryRepo(git, root, testProjectId);
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
      const root = yield* makeTmpDir;
      yield* Effect.promise(() => fs.mkdir(path.join(root, ".git"), { recursive: true }));

      // A remote-helper URL would execute on push; it must be rejected before
      // `git remote add` ever runs.
      yield* pushLibraryIfConfigured({
        git,
        root,
        libraryRemoteUrl: 'ext::sh -c "echo pwned"',
        libraryPushOnChange: true,
      });
      expect(executed).toEqual([]);
      const rejected = yield* readLibraryPushStatus(root);
      expect(rejected.lastPushError).toContain("https://");

      const leadingOption = "-upload-pack=sh";
      yield* pushLibraryIfConfigured({
        git,
        root,
        libraryRemoteUrl: leadingOption,
        libraryPushOnChange: true,
      });
      expect(executed).toEqual([]);

      // A well-formed https remote reaches `git remote add`. The earlier
      // rejections put the push into failure backoff — clear the record first.
      yield* Effect.promise(() =>
        fs.rm(path.join(root, ".git", "synara-push-status.json"), { force: true }),
      );
      yield* pushLibraryIfConfigured({
        git,
        root,
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
          projectId: testProjectId,
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

  it.effect("rejects a git repository that lacks the Synara marker", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId);
      // A .git without our marker is a foreign repository — never adopted at a
      // caller that did not prove ownership.
      yield* Effect.promise(() => fs.rm(path.join(root, ".synara-library")));
      const error = yield* failureOf(ensureLibraryRepo(git, root, testProjectId));
      expect(error).toBeInstanceOf(LibraryError);
      if (error instanceof LibraryError) {
        expect(error.code).toBe("forbidden");
      }

      const foreign = yield* makeTmpDir;
      yield* Effect.promise(() => fs.mkdir(path.join(foreign, ".git"), { recursive: true }));
      const foreignError = yield* failureOf(ensureLibraryRepo(git, foreign, testProjectId));
      expect(foreignError).toBeInstanceOf(LibraryError);
      if (foreignError instanceof LibraryError) {
        expect(foreignError.code).toBe("forbidden");
      }
    }),
  );

  it.effect("adopts a pre-marker repository at the managed default root", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId, { isManaged: true });
      // A library created before the marker existed carries .git but no
      // .synara-library: at the Synara-owned root it is adopted once, not
      // forbidden on every request.
      yield* Effect.promise(() => fs.rm(path.join(root, ".synara-library")));
      yield* ensureLibraryRepo(git, root, testProjectId, { isManaged: true });
      const marker = yield* Effect.promise(() =>
        fs.readFile(path.join(root, ".synara-library"), "utf8"),
      );
      expect(marker).toBe(`synara-library\n${testProjectId}\n`);
      // The default location stays open for the adoption: .git at the managed
      // root is never foreign; the same state at a custom path is refused.
      // The state dir must be a sibling, not nested: a library root that
      // contains the state dir is an ancestor of it and correctly refused.
      const stateDir = path.join(path.dirname(root), "state");
      yield* assertLibraryRootLocation({
        root,
        stateDir,
        groupsWorkspaceRoot: path.join(root, "groups"),
        studioWorkspaceRoot: path.join(root, "studio"),
        isCustomPath: false,
        projectId: testProjectId,
      });
      const foreign = yield* makeTmpDir;
      yield* Effect.promise(() => fs.mkdir(path.join(foreign, ".git"), { recursive: true }));
      const customError = yield* failureOf(
        assertLibraryRootLocation({
          root: foreign,
          stateDir,
          groupsWorkspaceRoot: path.join(root, "groups"),
          studioWorkspaceRoot: path.join(root, "studio"),
          isCustomPath: true,
          projectId: testProjectId,
        }),
      );
      expect(customError).toBeInstanceOf(LibraryError);
      if (customError instanceof LibraryError) {
        expect(customError.code).toBe("forbidden");
      }
    }),
  );

  it.effect("refuses a library owned by another group", () =>
    Effect.gen(function* () {
      const base = yield* makeTmpDir;
      const git = yield* GitCore;
      const stateDir = path.join(base, "state");
      const otherProjectId = ProjectId.makeUnsafe("group-library-other");
      const theirs = path.join(base, "theirs");
      yield* ensureLibraryRepo(git, theirs, otherProjectId);
      // A marker pinning another project makes the path foreign everywhere:
      // the location assert, moveLibraryRoot's destination check, and
      // ensureLibraryRepo itself all refuse it for this group.
      const locationError = yield* failureOf(
        assertLibraryRootLocation({
          root: theirs,
          stateDir,
          groupsWorkspaceRoot: path.join(base, "groups"),
          studioWorkspaceRoot: path.join(base, "studio"),
          isCustomPath: true,
          projectId: testProjectId,
        }),
      );
      expect(locationError).toBeInstanceOf(LibraryError);
      if (locationError instanceof LibraryError) {
        expect(locationError.code).toBe("forbidden");
      }
      const ensureError = yield* failureOf(
        ensureLibraryRepo(git, theirs, testProjectId, { isManaged: true }),
      );
      expect(ensureError).toBeInstanceOf(LibraryError);
      const moveError = yield* failureOf(
        moveLibraryRoot({
          fromRoot: path.join(base, "ours"),
          toRoot: theirs,
          projectId: testProjectId,
        }),
      );
      expect(moveError).toBeInstanceOf(LibraryError);
      if (moveError instanceof LibraryError) {
        expect(moveError.code).toBe("conflict");
      }
      // A custom path resolving inside another group's managed context dir is
      // refused even before the marker is consulted.
      const managedAreaError = yield* failureOf(
        assertLibraryRootLocation({
          root: path.join(stateDir, "project-context", "other-group", "library"),
          stateDir,
          groupsWorkspaceRoot: path.join(base, "groups"),
          studioWorkspaceRoot: path.join(base, "studio"),
          isCustomPath: true,
          projectId: testProjectId,
        }),
      );
      expect(managedAreaError).toBeInstanceOf(LibraryError);
      if (managedAreaError instanceof LibraryError) {
        expect(managedAreaError.code).toBe("forbidden");
      }
      // Pointing the same group at its own managed library dir stays allowed.
      yield* Effect.promise(() =>
        fs.mkdir(path.join(stateDir, "project-context", testProjectId, "library"), {
          recursive: true,
        }),
      );
      yield* assertLibraryRootLocation({
        root: path.join(stateDir, "project-context", testProjectId, "library"),
        stateDir,
        groupsWorkspaceRoot: path.join(base, "groups"),
        studioWorkspaceRoot: path.join(base, "studio"),
        isCustomPath: true,
        projectId: testProjectId,
      });
    }),
  );

  it.effect("moves to the same canonical root are a no-op, not a deadlock", () =>
    Effect.gen(function* () {
      const base = yield* makeTmpDir;
      const git = yield* GitCore;
      const fromRoot = path.join(base, "library");
      yield* ensureLibraryRepo(git, fromRoot, testProjectId);
      // Same literal path, a trailing-slash variant, and a symlink back to
      // the current root all resolve to the one library: the move skips the
      // copy instead of hanging on a second queue acquisition.
      const aliasLink = path.join(base, "library-alias");
      yield* Effect.promise(() => fs.symlink(fromRoot, aliasLink, "dir"));
      for (const toRoot of [fromRoot, `${fromRoot}/`, aliasLink]) {
        const result = yield* moveLibraryRoot({
          fromRoot,
          toRoot,
          projectId: testProjectId,
        });
        expect(result.moved, toRoot).toBe(false);
      }
      // The multi-root queue acquisition dedupes aliases onto one lock: the
      // keyed semaphores are not re-entrant, so taking the same canonical key
      // twice would hang. Completion inside the suite timeout is the
      // assertion; a real move across two distinct roots still serializes.
      const queued = yield* withLibraryQueues(
        [fromRoot, `${fromRoot}/`, aliasLink],
        Effect.succeed("ok"),
      );
      expect(queued).toBe("ok");
      const otherRoot = path.join(base, "elsewhere");
      const order: string[] = [];
      yield* withLibraryQueues(
        [otherRoot, fromRoot],
        Effect.sync(() => {
          order.push("ran");
        }),
      );
      expect(order).toEqual(["ran"]);
    }),
  );

  it.effect("creates empty folders with a hidden .gitkeep that commits", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId);

      const { dir } = yield* createLibraryDirectory(root, "Notes/Inbox");
      yield* commitLibraryChange(git, root, "Add Notes/Inbox");

      const keep = yield* Effect.promise(() => fs.readFile(path.join(dir, ".gitkeep"), "utf8"));
      expect(keep).toBe("");
      const names = yield* Effect.promise(() => fs.readdir(dir));
      expect(names).toEqual([".gitkeep"]);
      // .gitkeep is reserved plumbing: hidden from listings, and the folder
      // itself is tracked by git so it survives clones.
      const history = yield* libraryHistory(git, root, "Notes/Inbox/.gitkeep");
      expect(history[0]?.message).toBe("Add Notes/Inbox");
      const entries = yield* listLibraryEntries(root, "Notes/Inbox");
      expect(entries).toEqual([]);
    }),
  );

  it.effect("deletes a symlink leaf instead of following it", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      const outside = yield* makeTmpDir;
      yield* ensureLibraryRepo(git, root, testProjectId);
      yield* Effect.promise(() => fs.writeFile(path.join(outside, "keep.txt"), "safe", "utf8"));
      yield* Effect.promise(() => fs.symlink(outside, path.join(root, "link"), "dir"));

      yield* deleteLibraryEntry(root, "link");

      const gone = yield* Effect.promise(() =>
        fs.lstat(path.join(root, "link")).then(
          () => false,
          () => true,
        ),
      );
      expect(gone).toBe(true);
      const stillThere = yield* Effect.promise(() =>
        fs.readFile(path.join(outside, "keep.txt"), "utf8"),
      );
      expect(stillThere).toBe("safe");
    }),
  );

  it.effect("rejects reserved plumbing names on mutations", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      for (const reserved of [".gitkeep", ".git/config", ".synara-library"]) {
        const error = yield* failureOf(resolveLibraryWriteTarget(root, reserved));
        expect(error).toBeInstanceOf(LibraryError);
        if (error instanceof LibraryError) {
          expect(error.code).toBe("forbidden");
        }
      }
    }),
  );

  it.effect("lists directories ahead of files and hides git metadata", () =>
    Effect.gen(function* () {
      const root = yield* makeTmpDir;
      const git = yield* GitCore;
      yield* ensureLibraryRepo(git, root, testProjectId);
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
