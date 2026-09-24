// FILE: groupWorkspaceScaffold.ts
// Purpose: Owns the managed Group workspace layout — mkdir of the group folder and the
//          agent-facing instruction files (AGENTS.md/CLAUDE.md). Instructions are only
//          written when missing so user edits are never clobbered. Also owns the
//          delete-time cleanup: a group folder is removed only when everything left
//          inside is something Synara generated.
// Layer: Server workspace helper
// Exports: slugifyGroupTitle, ensureGroupWorkspaceInstructionsFiles, prepareGroupWorkspaceRoot,
//          cleanupGroupWorkspaceRoot

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { slugifyGroupTitle } from "@synara/shared/groupSlug";
import { isWorkspaceRootWithin, workspaceRootsEqual } from "@synara/shared/threadWorkspace";
import { Effect, FileSystem, Path } from "effect";

export { slugifyGroupTitle };

const GROUP_WORKSPACE_INSTRUCTIONS = `# Group workspace

This folder is the coordinator's scratch space for this Synara Group.

The group's instructions live in Synara Group settings (Memory → Instructions).
Do not treat this folder as the source of those instructions.

Keep working files here. Do not create Studio-style Inbox/Context/Logs/Skills/Outbox
directories — those belong to Studio, not Groups.
`;

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

// Entries that never count as "user files" when deciding whether a deleted
// group's folder still holds anything worth keeping.
const CLEANUP_IGNORED_ENTRY_NAMES = new Set([".DS_Store"]);
const CLEANUP_GENERATED_FILE_NAMES = new Set<string>(INSTRUCTION_FILE_NAMES);

/**
 * Writes the Group instruction files into the workspace root, skipping any that already
 * exist. Callers treat failures as non-fatal: instructions improve agent behavior but must
 * never block creating or using the Group container.
 */
export const ensureGroupWorkspaceInstructionsFiles = Effect.fnUntraced(function* (
  workspaceRoot: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  for (const fileName of INSTRUCTION_FILE_NAMES) {
    const filePath = path.join(workspaceRoot, fileName);
    const exists = yield* fileSystem.exists(filePath);
    if (exists) {
      continue;
    }
    yield* fileSystem.writeFileString(filePath, GROUP_WORKSPACE_INSTRUCTIONS);
  }
});

export const prepareGroupWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(workspaceRoot, { recursive: true });
  yield* ensureGroupWorkspaceInstructionsFiles(workspaceRoot);
});

export interface GroupWorkspaceCleanupResult {
  /** removed: folder deleted; kept: folder left on disk (has user files); skipped: untouched. */
  readonly status: "removed" | "kept" | "skipped";
  readonly workspaceRoot: string;
}

/**
 * Removes a deleted group's workspace folder only when every top-level entry
 * inside it is something Synara generated (the instruction files with their
 * exact scaffolded contents) or ignorable (.DS_Store). Any other entry —
 * including an edited instruction file — means the user (or an agent) put
 * files there, so the folder is kept and reported.
 *
 * Safety: only folders that are a direct child of `groupsWorkspaceRoot` are
 * ever removed (managed per-group folders — never a linked repository, a
 * custom Library folder, or the shared Groups root itself). Symlinks are
 * never followed: a symlinked root or any symlink entry keeps the folder.
 * Every filesystem error is swallowed into "skipped" — the group is already
 * gone, so cleanup must never fail the delete.
 */
export const cleanupGroupWorkspaceRoot = (input: {
  readonly workspaceRoot: string;
  readonly groupsWorkspaceRoot: string;
}): Effect.Effect<GroupWorkspaceCleanupResult> =>
  Effect.promise(async () => {
    const { workspaceRoot, groupsWorkspaceRoot } = input;
    const skip = (): GroupWorkspaceCleanupResult => ({ status: "skipped", workspaceRoot });
    if (
      !isWorkspaceRootWithin(workspaceRoot, groupsWorkspaceRoot) ||
      !workspaceRootsEqual(path.dirname(workspaceRoot), groupsWorkspaceRoot)
    ) {
      return skip();
    }
    const stat = await fs.lstat(workspaceRoot).catch(() => null);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) {
      return skip();
    }
    const entries = await fs.readdir(workspaceRoot, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      return skip();
    }
    for (const entry of entries) {
      if (CLEANUP_IGNORED_ENTRY_NAMES.has(entry.name)) {
        continue;
      }
      if (CLEANUP_GENERATED_FILE_NAMES.has(entry.name) && entry.isFile()) {
        const contents = await fs
          .readFile(path.join(workspaceRoot, entry.name), "utf8")
          .catch(() => null);
        if (contents === GROUP_WORKSPACE_INSTRUCTIONS) {
          continue;
        }
      }
      return { status: "kept", workspaceRoot };
    }
    const removed = await fs
      .rm(workspaceRoot, { recursive: true, force: true })
      .then(() => true)
      .catch(() => false);
    return { status: removed ? "removed" : "skipped", workspaceRoot };
  });
