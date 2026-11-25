// FILE: Diffs.ts
// Purpose: Parses unified diffs into checkpoint file summaries.
// Layer: Server checkpointing helper
// Exports: checkpoint file parser used by capture and provider live-diff ingestion

import { parsePatchFiles } from "@pierre/diffs";
import type { OrchestrationCheckpointFile } from "@synara/contracts";
import { Effect } from "effect";

type ParsedPatches = ReturnType<typeof parsePatchFiles>;

function checkpointKindFromParsedFile(
  type: ParsedPatches[number]["files"][number]["type"],
): string {
  switch (type) {
    case "deleted":
      return "deleted";
    case "new":
      return "added";
    case "rename-pure":
    case "rename-changed":
      return "renamed";
    case "change":
      return "modified";
  }
}

function summarizeParsedPatches(parsedPatches: ParsedPatches): OrchestrationCheckpointFile[] {
  const filesByPath = new Map<string, OrchestrationCheckpointFile>();
  for (const patch of parsedPatches) {
    for (const file of patch.files) {
      const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
      const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
      const existing = filesByPath.get(file.name);
      filesByPath.set(file.name, {
        path: file.name,
        kind: checkpointKindFromParsedFile(file.type),
        additions: (existing?.additions ?? 0) + additions,
        deletions: (existing?.deletions ?? 0) + deletions,
      });
    }
  }

  return Array.from(filesByPath.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/**
 * Parses unified diffs into checkpoint file summaries. `parsePatchFiles` is
 * bundled and tree-shaken into the server output so Shiki grammars/themes do
 * not ship in server or desktop runtime dependencies.
 */
export function parseCheckpointFilesFromUnifiedDiff(
  diff: string,
): Effect.Effect<OrchestrationCheckpointFile[]> {
  return Effect.sync(() => {
    const normalized = diff.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) {
      return [];
    }
    return summarizeParsedPatches(parsePatchFiles(normalized));
  });
}
