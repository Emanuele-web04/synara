// FILE: libraryStore.ts
// Purpose: Filesystem surface of the per-group Library — a plain directory under
//          the state dir (or `config.libraryPath`) versioned as a git repo. This
//          module owns path resolution/containment and entry listing; git history
//          operations live in libraryGit.ts.
// Layer: Server domain helper
// Exports: resolveLibraryRoot, normalizeLibraryRelativePath, resolveLibraryDir,
//          resolveLibraryTarget, resolveLibraryCreateTarget, resolveLibraryWriteTarget,
//          createLibraryDirectory, deleteLibraryEntry, renameLibraryEntry,
//          listLibraryEntries, ensureLibraryRepo, moveLibraryRoot, assertLibraryRootLocation

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { LibraryEntry, ProjectId } from "@synara/contracts";
import { normalizeProjectDocumentPath } from "@synara/shared/projectAgent";
import { Effect } from "effect";

import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { GitCommandError } from "../git/Errors.ts";
import {
  isContainedPath,
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
// Written by ensureLibraryRepo on init and carried over by moveLibraryRoot. The
// first line identifies a Synara library; the optional second line pins the
// owning project id so a custom libraryPath can never be pointed at another
// group's library. Pre-upgrade markers carry no owner line.
const LIBRARY_MARKER_NAME = ".synara-library";
const LIBRARY_MARKER_HEADING = "synara-library";

interface LibraryMarker {
  readonly owner: string | null;
}

const readLibraryMarker = (root: string) =>
  Effect.promise(async (): Promise<LibraryMarker | null> => {
    try {
      const text = await fs.readFile(path.join(root, LIBRARY_MARKER_NAME), "utf8");
      const lines = text.split("\n");
      if (lines[0] !== LIBRARY_MARKER_HEADING) return null;
      return { owner: lines[1]?.trim() || null };
    } catch {
      return null;
    }
  });

const writeLibraryMarker = (root: string, projectId: ProjectId) =>
  Effect.tryPromise({
    try: () =>
      fs.writeFile(
        path.join(root, LIBRARY_MARKER_NAME),
        `${LIBRARY_MARKER_HEADING}\n${projectId}\n`,
        "utf8",
      ),
    catch: toPathError("Could not write the library marker."),
  });
// Mirrored in the seeded .gitignore (plus the keep file that lands Artifacts/
// in the initial commit); they are noise rather than artifacts. `.git` itself
// is skipped case-insensitively so case-insensitive filesystems cannot surface
// a differently-cased repo dir.
const IGNORED_ENTRY_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".gitkeep",
  ".gitignore",
  ".gitattributes",
  LIBRARY_MARKER_NAME,
]);

const isGitDirName = (name: string) => name.toLowerCase() === GIT_DIR_SEGMENT;

// Repo plumbing and marker/keep files are reserved everywhere, not just hidden
// in listings: an upload or rename onto `.gitignore` would rewrite repo policy,
// and on case-insensitive filesystems `.GITIGNORE` resolves onto the same file.
const isReservedEntryName = (name: string) =>
  [...IGNORED_ENTRY_NAMES].some((reserved) => reserved.toLowerCase() === name.toLowerCase());

const hasGitMetadataSegment = (target: string) =>
  target.split(/[\\/]/).some((segment) => isGitDirName(segment));

// After containment resolution, the resolved path must not pass through the
// repo dir: on case-insensitive filesystems `.GIT/config` resolves inside the
// root while still addressing `.git`.
const rejectGitMetadata = (root: string, resolved: string, displayPath: string) =>
  Effect.gen(function* () {
    const realRoot = yield* Effect.tryPromise({
      try: () => fs.realpath(root),
      catch: toPathError(`Could not resolve the library root.`),
    });
    const relative = path.relative(realRoot, resolved);
    if (hasGitMetadataSegment(relative)) {
      return yield* fail(
        `Library path "${displayPath}" addresses repository metadata.`,
        "forbidden",
      );
    }
    return resolved;
  });

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
      normalized.split("/").some(isGitDirName)
        ? Effect.fail(fail("Library paths cannot address repository metadata.", "forbidden"))
        : normalized.split("/").some(isReservedEntryName)
          ? Effect.fail(fail(`Library path "${rawPath}" is reserved for Synara.`, "forbidden"))
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
    yield* rejectGitMetadata(root, resolved, normalized || ".");
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
    return yield* rejectGitMetadata(root, resolved, normalized);
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
    return yield* rejectGitMetadata(root, resolved, normalized);
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
    return yield* rejectGitMetadata(root, resolved, normalized);
  });
}

// Creates a directory (and missing parents) inside the root. Git tracks no
// empty directories, so a fresh folder gets a `.gitkeep` — it persists in the
// commit and stays hidden from listings.
export function createLibraryDirectory(
  root: string,
  relativePath: string,
): Effect.Effect<{ readonly dir: string }, LibraryError> {
  return Effect.gen(function* () {
    const target = yield* resolveLibraryCreateTarget(root, relativePath);
    yield* Effect.tryPromise({
      try: async () => {
        await fs.mkdir(target, { recursive: true });
        if ((await fs.readdir(target)).length === 0) {
          await fs.writeFile(path.join(target, ".gitkeep"), "", "utf8");
        }
      },
      catch: toPathError(`Could not create library directory "${relativePath}".`),
    });
    return { dir: target };
  });
}

// Deletes the entry itself, never its target: the parent dir is resolved inside
// the root, then the leaf is inspected with lstat so a symlink is unlinked
// rather than followed into whatever it points at.
export function deleteLibraryEntry(
  root: string,
  relativePath: string,
): Effect.Effect<void, LibraryError> {
  return Effect.gen(function* () {
    const normalized = yield* normalizeLibraryRelativePath(relativePath);
    const parentRelative = path.posix.dirname(normalized);
    const leaf = path.posix.basename(normalized);
    const parentDir = yield* resolveLibraryDir(
      root,
      parentRelative === "." ? undefined : parentRelative,
    );
    const target = path.join(parentDir, leaf);
    const stat = yield* Effect.tryPromise({
      try: () => fs.lstat(target),
      catch: () => fail(`Library path "${normalized}" was not found.`, "not-found"),
    });
    yield* Effect.tryPromise({
      try: () =>
        stat.isDirectory() && !stat.isSymbolicLink()
          ? fs.rm(target, { recursive: true })
          : fs.rm(target),
      catch: toPathError(`Could not delete library entry "${normalized}".`),
    });
  });
}

// Rename with an explicit destination-exists check: POSIX rename would
// silently clobber an existing file, losing an uncommitted entry.
export function renameLibraryEntry(
  root: string,
  from: string,
  to: string,
): Effect.Effect<void, LibraryError> {
  return Effect.gen(function* () {
    const source = yield* resolveLibraryTarget(root, from);
    const destination = yield* resolveLibraryCreateTarget(root, to);
    const existing = yield* Effect.tryPromise({
      try: () => fs.stat(destination),
      catch: () => fail("missing", "invalid"),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (existing !== null) {
      return yield* fail(`A library entry already exists at "${to}".`, "conflict");
    }
    yield* Effect.tryPromise({
      try: () => fs.rename(source, destination),
      catch: toPathError(`Could not rename "${from}" to "${to}".`),
    });
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
      if (IGNORED_ENTRY_NAMES.has(dirent.name) || isGitDirName(dirent.name)) continue;
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
  projectId: ProjectId,
  options?: { readonly isManaged?: boolean | undefined },
): Effect.Effect<void, LibraryError | GitCommandError> {
  return Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.mkdir(root, { recursive: true }),
      catch: (cause) => new LibraryError({ message: "Failed to create the library root.", cause }),
    });
    if (yield* pathExists(path.join(root, GIT_DIR_SEGMENT))) {
      const marker = yield* readLibraryMarker(root);
      if (marker === null) {
        // A pre-marker library at the Synara-owned default root is adopted
        // once by writing the marker with this project's ownership. Custom
        // paths still refuse foreign repos — assertLibraryRootLocation also
        // blocks them before requests ever reach this point.
        if (options?.isManaged !== true) {
          return yield* fail(
            `Library root "${root}" is a git repository that was not created by Synara.`,
            "forbidden",
          );
        }
        yield* writeLibraryMarker(root, projectId);
        return;
      }
      if (marker.owner !== null && marker.owner !== projectId) {
        return yield* fail(`Library root "${root}" already belongs to another group.`, "forbidden");
      }
      // Backfill ownership on pre-upgrade markers lazily.
      if (marker.owner === null) yield* writeLibraryMarker(root, projectId);
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
    yield* writeLibraryMarker(root, projectId);
    yield* commitLibraryChange(git, root, "Initialize library");
  });
}

// Copies a library tree (including .git) to a new root. Used by configure when
// libraryPath changes: the old location is never deleted, so a failed or partial
// move leaves a usable copy behind.
export function moveLibraryRoot(input: {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly projectId: ProjectId;
}): Effect.Effect<{ readonly moved: boolean }, LibraryError> {
  return Effect.gen(function* () {
    const fromRoot = path.resolve(input.fromRoot);
    const toRoot = path.resolve(input.toRoot);
    if (fromRoot === toRoot) return { moved: false };
    // Roots resolving to the same physical folder (a trailing slash, the
    // default path typed explicitly, a symlink to the current root) are the
    // same library — nothing to copy and no second queue to take.
    const [fromReal, toReal] = yield* Effect.all([canonicalize(fromRoot), canonicalize(toRoot)]);
    if (fromReal === toReal) return { moved: false };
    if (isContainedPath(fromRoot, toRoot)) {
      return yield* fail(
        `Library destination "${toRoot}" is nested inside the current library.`,
        "invalid",
      );
    }
    // The destination is validated even when the source root was never
    // created: an early return must not let configure point the library at an
    // occupied or foreign directory.
    const destinationExists = yield* pathExists(toRoot);
    if (destinationExists) {
      // Re-running a completed move is safe: a marker-bearing repo means the
      // copy already landed; anything else is user content we must not touch.
      const destinationHasRepo = yield* pathExists(path.join(toRoot, GIT_DIR_SEGMENT));
      if (destinationHasRepo) {
        const marker = yield* readLibraryMarker(toRoot);
        if (marker !== null) {
          if (marker.owner !== null && marker.owner !== input.projectId) {
            return yield* fail(
              `Library destination "${toRoot}" already belongs to another group.`,
              "conflict",
            );
          }
          return { moved: true };
        }
        return yield* fail(
          `Library destination "${toRoot}" is a git repository that was not created by Synara.`,
          "conflict",
        );
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
    if (!(yield* pathExists(fromRoot))) return { moved: false };
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

const canonicalize = (target: string) =>
  Effect.tryPromise({
    try: () => fs.realpath(target),
    catch: () => fail("unresolvable", "invalid"),
  }).pipe(Effect.catch(() => Effect.succeed(path.resolve(target))));

// Confinement for a `libraryPath` root. Allowed: a not-yet-created or empty
// directory, or an existing library we seeded (marker file present). Refused:
// the state dir itself or any ancestor of it, the groups/studio workspace
// roots, any group/studio workspace folder (a direct child of those roots), a
// foreign git repo, and any other occupied directory — uploads and the
// add-all commit can never write into arbitrary directories. The checks run
// for every root, managed locations included, so a foreign repo squatting
// under the state dir is refused too.
export function assertLibraryRootLocation(input: {
  readonly root: string;
  readonly stateDir: string;
  readonly groupsWorkspaceRoot: string;
  readonly studioWorkspaceRoot: string;
  readonly isCustomPath: boolean;
  readonly projectId: ProjectId;
}): Effect.Effect<void, LibraryError> {
  return Effect.gen(function* () {
    const realRoot = yield* canonicalize(input.root);
    const realStateDir = yield* canonicalize(input.stateDir);
    if (realRoot === realStateDir || isContainedPath(realRoot, realStateDir)) {
      return yield* fail(
        `Library path "${input.root}" cannot be the state directory or one of its ancestors.`,
        "forbidden",
      );
    }
    if (input.isCustomPath) {
      for (const allowed of [input.groupsWorkspaceRoot, input.studioWorkspaceRoot]) {
        const realAllowed = yield* canonicalize(allowed);
        // The workspace root itself, or a direct child — those are the
        // group/studio workspace folders and must stay workspaces, not
        // libraries.
        if (realRoot === realAllowed || path.dirname(realRoot) === realAllowed) {
          return yield* fail(
            `Library path "${input.root}" cannot be a workspace folder.`,
            "forbidden",
          );
        }
      }
      // Another group's managed area (<stateDir>/project-context/<other>) is
      // foreign regardless of what marker it carries.
      const realContextHome = yield* canonicalize(path.join(input.stateDir, "project-context"));
      const relative = path.relative(realContextHome, realRoot);
      const firstSegment = relative.split(path.sep).find((segment) => segment.length > 0);
      if (
        relative === "" ||
        (!relative.startsWith("..") &&
          firstSegment !== undefined &&
          firstSegment !== input.projectId)
      ) {
        return yield* fail(
          `Library path "${input.root}" is inside another group's managed area.`,
          "forbidden",
        );
      }
    }
    const stat = yield* Effect.tryPromise({
      try: () => fs.stat(realRoot),
      catch: () => fail("missing", "invalid"),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (stat === null) return;
    if (!stat.isDirectory()) {
      return yield* fail(`Library path "${input.root}" is not a directory.`, "invalid");
    }
    const marker = yield* readLibraryMarker(realRoot);
    if (marker !== null) {
      if (marker.owner !== null && marker.owner !== input.projectId) {
        return yield* fail(
          `Library path "${input.root}" already belongs to another group.`,
          "forbidden",
        );
      }
      return;
    }
    if (yield* pathExists(path.join(realRoot, GIT_DIR_SEGMENT))) {
      // At the Synara-owned default root a markerless repo is a pre-marker
      // library; ensureLibraryRepo adopts it once by writing the marker.
      if (!input.isCustomPath) return;
      return yield* fail(
        `Library path "${input.root}" is a git repository that was not created by Synara.`,
        "forbidden",
      );
    }
    const remaining = yield* Effect.tryPromise({
      try: () => fs.readdir(realRoot),
      catch: (cause) => new LibraryError({ message: "Failed to inspect the library path.", cause }),
    });
    if (remaining.length > 0) {
      return yield* fail(
        `Library path "${input.root}" is not empty; pick an empty folder or a Synara-managed location.`,
        "forbidden",
      );
    }
  });
}
