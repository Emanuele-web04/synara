// FILE: groupWorkspaceScaffold.ts
// Purpose: Owns the managed Group workspace layout — mkdir of the group folder and the
//          agent-facing instruction files (AGENTS.md/CLAUDE.md). Instructions are only
//          written when missing so user edits are never clobbered.
// Layer: Server workspace helper
// Exports: slugifyGroupTitle, ensureGroupWorkspaceInstructionsFiles, prepareGroupWorkspaceRoot

import { Effect, FileSystem, Path } from "effect";

const FALLBACK_GROUP_SLUG = "group";
const MAX_GROUP_SLUG_LENGTH = 72;

const GROUP_WORKSPACE_INSTRUCTIONS = `# Group workspace

This folder is the coordinator's scratch space for this Synara Group.

The group's instructions live in Synara Group settings (Memory → Instructions).
Do not treat this folder as the source of those instructions.

Keep working files here. Do not create Studio-style Inbox/Context/Logs/Skills/Outbox
directories — those belong to Studio, not Groups.
`;

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

export function slugifyGroupTitle(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  const truncated = normalized.slice(0, MAX_GROUP_SLUG_LENGTH).replace(/-+$/g, "");
  return truncated || FALLBACK_GROUP_SLUG;
}

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
