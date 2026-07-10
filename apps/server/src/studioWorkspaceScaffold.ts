// FILE: studioWorkspaceScaffold.ts
// Purpose: Owns the managed Studio workspace layout — the scaffolded subdirectory set and
//          the agent-facing instruction files (AGENTS.md/CLAUDE.md) that teach providers
//          where deliverables belong. Instructions are only written when missing so user
//          edits are never clobbered.
// Layer: Server workspace helper
// Exports: STUDIO_WORKSPACE_SUBDIRECTORIES, ensureStudioWorkspaceInstructionsFiles

import { Effect, FileSystem, Path } from "effect";

// Relative subdirectories scaffolded under a freshly created Studio workspace root,
// mirroring the Claude `~/Documents/Claude` Outbox layout so generated content lands in
// predictable folders. `tmp` is scratch space the outputs listing ignores.
export const STUDIO_WORKSPACE_SUBDIRECTORIES = [
  "Inbox",
  "Context",
  "Logs",
  "Skills",
  "tmp",
  "Outbox/Content",
  "Outbox/Daily",
  "Outbox/Images",
  "Outbox/Notion",
  "Outbox/TikTok",
  "Outbox/YouTube",
] as const;

// One source of truth for the instruction text; AGENTS.md is the cross-provider standard
// (Codex, Cursor, ...), CLAUDE.md is what Claude Code actually loads.
const STUDIO_WORKSPACE_INSTRUCTIONS = `# Studio Workspace

This folder is the shared workspace for Synara Studio chats. Keep it organized so the
app can attribute and surface what you produce.

## Where files go

- \`Outbox/<Category>/\` — every final deliverable: documents, PDFs, images, exports,
  anything the user asked you to produce. Use an existing category (Content, Daily,
  Images, Notion, TikTok, YouTube) or create a new one that fits.
- \`tmp/\` — scratch space: helper scripts, intermediate artifacts, downloads you only
  need while working. Anything here may be cleaned up at any time.
- \`Inbox/\` — files the user drops in for you to process. Read from here; do not write.
- \`Context/\` — reference material and background docs. Read-only unless asked.
- \`Logs/\` and \`Skills/\` — managed by Synara; leave them alone.

## Rules

- Never leave a deliverable in \`tmp/\` or loose in this root: move the finished file
  into \`Outbox/<Category>/\` as the last step of your work.
- Prefer descriptive, dated file names, e.g. \`2026-07-08_customer_report.pdf\`.
`;

const INSTRUCTION_FILE_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

/**
 * Writes the Studio instruction files into the workspace root, skipping any that already
 * exist. Callers treat failures as non-fatal: instructions improve agent behavior but must
 * never block creating or using the Studio container.
 */
export const ensureStudioWorkspaceInstructionsFiles = Effect.fnUntraced(function* (
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
    yield* fileSystem.writeFileString(filePath, STUDIO_WORKSPACE_INSTRUCTIONS);
  }
});
