// FILE: groupWorkspaceScaffold.ts
// Purpose: Owns the managed Group workspace layout — mkdir of the group folder and the
//          agent-facing instruction files (AGENTS.md/CLAUDE.md). Instructions are only
//          written when missing so user edits are never clobbered.
// Layer: Server workspace helper
// Exports: slugifyGroupTitle, ensureGroupWorkspaceInstructionsFiles, prepareGroupWorkspaceRoot

import { slugifyGroupTitle } from "@synara/shared/groupSlug";
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
