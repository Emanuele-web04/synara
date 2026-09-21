// FILE: libraryStore.ts
// Purpose: Filesystem surface of the per-group Library — a plain directory under
//          the state dir (or `config.libraryPath`) versioned as a git repo. This
//          module owns path resolution/containment and entry listing; git history
//          operations live in libraryGit.ts.
// Layer: Server domain helper
// Exports: resolveLibraryRoot, normalizeLibraryRelativePath, resolveLibraryDir,
//          resolveLibraryTarget, resolveLibraryCreateTarget, resolveLibraryWriteTarget,
//          listLibraryEntries, ensureLibraryRepo, moveLibraryRoot

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LibraryEntry, ProjectId } from "@synara/contracts";
import { normalizeProjectDocumentPath } from "@synara/shared/projectAgent";
import { Effect } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { GitCommandError } from "../git/Errors.ts";
import {
  prepareRealPathForWriteWithinRoot,
  resolveRealPathForCreateWithinRoot,
  resolveRealPathWithinRoot,
} from "../workspace/realPathContainment.ts";
import { LibraryError } from "./Errors.ts";
import { commitLibraryChange, initLibraryRepo } from "./libraryGit.ts";
import { projectContextRoot } from "./materializer.ts";

const fail = (message: string, code: "not-found" | "forbidden" | "invalid" | "conflict") =>
  new LibraryError({ message, code });

// The repo metadata is never addressable through library paths; a stray ".git"
// segment would hand callers raw control over history plumbing.
const GIT_DIR_SEGMENT = ".git";
// Mirrored in the seeded .gitignore (plus the keep file that lands Artifacts/
// in the initial commit); they are noise rather than artifacts.
const IGNORED_ENTRY_NAMES = new Set([
  GIT_DIR_SEGMENT,
  ".DS_Store",
  "Thumbs.db",
  ".gitkeep",
  ".gitignore",
  ".gitattributes",
]);

export function resolveLibraryRoot(input: {
  readonly stateDir: string;
  readonly projectId: ProjectId;
  readonly libraryPath?: string | undefined;
}): Effect.Effect<string, LibraryError> {
  return Effect.suspend(() => {
    if (input.libraryPath === undefined) {
      return Effect.succeed(
        path.join(projectContextRoot(input.stateDir, input.projectId), "library"),
      );
    }
    if (!path.isAbsolute(input.libraryPath) || input.libraryPath.split(/[\\/]/).includes("..")) {
      return Effect.fail(
        fail("libraryPath must be an absolute path without '..' segments.", "invalid"),
      );
    }
    return Effect.succeed(path.normalize(input.libraryPath));
  });
}

// Caller-supplied relative path -> normalized forward-slash form, or a typed
// failure for empty/absolute/traversal/NUL inputs.
export function normalizeLibraryRelativePath(rawPath: string) {
  return Effect.try({
    try: () => normalizeProjectDocumentPath(rawPath),
    catch: () => fail(`Library path "${rawPath}" is not a valid relative path.`, "invalid"),
  }).pipe(
    Effect.flatMap((normalized) =>
      normalized.split("/").includes(GIT_DIR_SEGMENT)
        ? Effect.fail(fail("Library paths cannot address repository metadata.", "forbidden"))
        : Effect.succeed(normalized),
    ),
  );
}

const toPathError = (message: string) => (cause: unknown) =>
  new LibraryError({ message, code: "invalid", cause });

// Existing directory inside the root (or the root itself when relativePath is
// omitted). Symlink escapes resolve to null -> forbidden.
export function resolveLibraryDir(
  root: string,
  relativePath?: string | undefined,
): Effect.Effect<string, LibraryError> {
  return Effect.gen(function* () {
    const normalized =
      relativePath === undefined || relativePath === ""
        ? ""
        : yield* normalizeLibraryRelativePath(relativePath);
    const candidate = path.resolve(root, ...normalized.split("/").filter(Boolean));
    const resolved = yield* Effect.tryPromise({
      try: () => resolveRealPathWithinRoot(root, candidate),
      catch: toPathError(`Could not resolve "${normalized || "."}" inside the library.`),
    });
    if (resolved === null) {
      return yield* fail(
        `Library path "${normalized || "."}" escapes the library root.`,
        "forbidden",
      );
    }
    const stat = yield* Effect.tryPromise({
      try: () => fs.stat(resolved),
      catch: () => fail(`Library path "${normalized || "."}" was not found.`, "not-found"),
    });
    if (!stat.isDirectory()) {
      return yield* fail(`Library path "${normalized}" is not a directory.`, "invalid");
    }
    return resolved;
  });
}

// Existing entry (file or directory) inside the root.
export function resolveLibraryTarget(
  root: string,
  relativePath: string,
): Effect.Effect<string, LibraryError> {
  return Effect.gen(function* () {
    const normalized = yield* normalizeLibraryRelativePath(relativePath);
    const candidate = path.resolve(root, ...normalized.split("/"));
    const resolved = yield* Effect.tryPromise({
      try: () => resolveRealPathWithinRoot(root, candidate),
      catch: toPathError(`Could not resolve "${normalized}" inside the library.`),
    });
    if (resolved === null) {
      return yield* fail(`Library path "${normalized}" escapes the library root.`, "forbidden");
    }
    return resolved;
  });
}

// Destination for creates/writes: parents are canonicalized and created as
// needed, existing leaf components must stay inside the root, and dangling
// symlinks are rejected.
export function resolveLibraryCreateTarget(
  root: string,
  relativePath: string,
): Effect.Effect<string, LibraryError> {
  return Effect.gen(function* () {
    const normalized = yield* normalizeLibraryRelativePath(relativePath);
    const candidate = path.resolve(root, ...normalized.split("/"));
    const resolved = yield* Effect.tryPromise({
      try: () => resolveRealPathForCreateWithinRoot(root, candidate),
      catch: toPathError(`Could not resolve "${normalized}" inside the library.`),
    });
    if (resolved === null) {
      return yield* fail(`Library path "${normalized}" escapes the library root.`, "forbidden");
    }
    return resolved;
  });
}

// Write target variant that materializes missing parent directories.
export function resolveLibraryWriteTarget(
  root: string,
  relativePath: string,
): Effect.Effect<string, LibraryError> {
  return Effect.gen(function* () {
    const normalized = yield* normalizeLibraryRelativePath(relativePath);
    const candidate = path.resolve(root, ...normalized.split("/"));
    const resolved = yield* Effect.tryPromise({
      try: () => prepareRealPathForWriteWithinRoot(root, candidate),
      catch: toPathError(`Could not resolve "${normalized}" inside the library.`),
    });
    if (resolved === null) {
      return yield* fail(`Library path "${normalized}" escapes the library root.`, "forbidden");
    }
    return resolved;
  });
}

export function listLibraryEntries(
  root: string,
  relativePath?: string | undefined,
): Effect.Effect<LibraryEntry[], LibraryError> {
  return Effect.gen(function* () {
    const normalizedParent =
      relativePath === undefined || relativePath === ""
        ? ""
        : yield* normalizeLibraryRelativePath(relativePath);
    const dir = yield* resolveLibraryDir(root, normalizedParent);
    const dirents = yield* Effect.tryPromise({
      try: () => fs.readdir(dir, { withFileTypes: true }),
      catch: toPathError("Failed to list the library directory."),
    });
    const entries: LibraryEntry[] = [];
    for (const dirent of dirents) {
      if (IGNORED_ENTRY_NAMES.has(dirent.name)) continue;
      const absolutePath = path.join(dir, dirent.name);
      const stat = yield* Effect.tryPromise({
        try: () => fs.lstat(absolutePath),
        catch: toPathError(`Failed to inspect library entry "${dirent.name}".`),
      });
      if (stat.isSymbolicLink()) {
        // Links are never followed into the listing; surfacing them as files
        // would let a later preview read escape the root.
        continue;
      }
      const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (kind === null) continue;
      entries.push({
        name: dirent.name,
        // Reported against the caller-supplied (normalized) parent path — the
        // resolved dir may differ from `root` when the state dir is itself a
        // symlink (/var vs /private/var), and entries must stay stable there.
        relativePath: normalizedParent ? `${normalizedParent}/${dirent.name}` : dirent.name,
        kind,
        sizeBytes: kind === "file" ? stat.size : 0,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
    entries.sort((a, b) =>
      a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : a.name.localeCompare(b.name),
    );
    return entries;
  });
}

const LIBRARY_GITIGNORE = ".DS_Store\nThumbs.db\n";
const LIBRARY_GITATTRIBUTES =
  [
    "*.png binary",
    "*.jpg binary",
    "*.jpeg binary",
    "*.gif binary",
    "*.webp binary",
    "*.bmp binary",
    "*.ico binary",
    "*.pdf binary",
    "*.zip binary",
    "*.tar binary",
    "*.gz binary",
    "*.7z binary",
    "*.mp4 binary",
    "*.mp3 binary",
    "*.wav binary",
  ].join("\n") + "\n";

const pathExists = (target: string) =>
  Effect.tryPromise({
    try: async () => {
      await fs.access(target);
      return true;
    },
    catch: () => fail("access failed", "invalid"),
  }).pipe(Effect.catch(() => Effect.succeed(false)));

// Creates the root and, on first use, seeds and initializes the repo:
// `git init`, .gitignore/.gitattributes, an Artifacts/ folder, and the initial
// commit authored as the Synara Library identity.
export function ensureLibraryRepo(
  git: GitCoreShape,
  root: string,
): Effect.Effect<void, LibraryError | GitCommandError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(root, { recursive: true }),
      catch: (cause) => new LibraryError({ message: "Failed to create the library root.", cause }),
    });
    if (yield* pathExists(path.join(root, GIT_DIR_SEGMENT))) {
      return;
    }
    yield* initLibraryRepo(git, root);
    yield* Effect.tryPromise({
      try: async () => {
        await fs.writeFile(path.join(root, ".gitignore"), LIBRARY_GITIGNORE, "utf8");
        await fs.writeFile(path.join(root, ".gitattributes"), LIBRARY_GITATTRIBUTES, "utf8");
        await fs.mkdir(path.join(root, "Artifacts"), { recursive: true });
        // git tracks no empty directories; a keep file makes Artifacts visible
        // in the initial commit and in fresh clones.
        await fs.writeFile(path.join(root, "Artifacts", ".gitkeep"), "", "utf8");
      },
      catch: (cause) =>
        new LibraryError({ message: "Failed to seed the library repository.", cause }),
    });
    yield* commitLibraryChange(git, root, "Initialize library");
  });
}

// Copies a library tree (including .git) to a new root. Used by configure when
// libraryPath changes: the old location is never deleted, so a failed or partial
// move leaves a usable copy behind.
export function moveLibraryRoot(input: {
  readonly fromRoot: string;
  readonly toRoot: string;
}): Effect.Effect<{ readonly moved: boolean }, LibraryError> {
  return Effect.gen(function* () {
    const fromRoot = path.resolve(input.fromRoot);
    const toRoot = path.resolve(input.toRoot);
    if (fromRoot === toRoot) return { moved: false };
    if (!(yield* pathExists(fromRoot))) return { moved: false };
    const destinationExists = yield* pathExists(toRoot);
    if (destinationExists) {
      // Re-running a completed move is safe: a populated .git means the copy
      // already landed; anything else is user content we must not overwrite.
      if (yield* pathExists(path.join(toRoot, GIT_DIR_SEGMENT))) {
        return { moved: true };
      }
      const remaining = yield* Effect.tryPromise({
        try: () => fs.readdir(toRoot),
        catch: (cause) =>
          new LibraryError({ message: "Failed to inspect the destination library.", cause }),
      });
      if (remaining.length > 0) {
        return yield* fail(
          `Library destination "${toRoot}" already exists and is not empty.`,
          "conflict",
        );
      }
    }
    yield* Effect.tryPromise({
      try: () => fs.cp(fromRoot, toRoot, { recursive: true, verbatimSymlinks: true }),
      catch: (cause) =>
        new LibraryError({
          message: `Failed to copy the library to "${toRoot}".`,
          code: "invalid",
          cause,
        }),
    });
    // Verify the move: the copy must carry the repo marker when the source had
    // one so history survives the re-point.
    const sourceHadRepo = yield* pathExists(path.join(fromRoot, GIT_DIR_SEGMENT));
    const destinationHasRepo = yield* pathExists(path.join(toRoot, GIT_DIR_SEGMENT));
    if (sourceHadRepo && !destinationHasRepo) {
      return yield* fail(
        `Library copy at "${toRoot}" is missing its git metadata; the move was not applied.`,
        "invalid",
      );
    }
    return { moved: true };
  });
}
