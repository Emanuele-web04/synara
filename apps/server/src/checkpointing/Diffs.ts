import type { OrchestrationCheckpointFile } from "@synara/contracts";
import { Effect } from "effect";

import { lazyModule } from "../lazyModule.ts";

type PierreDiffsModule = typeof import("@pierre/diffs");
type ParsedPatches = ReturnType<PierreDiffsModule["parsePatchFiles"]>;

// @pierre/diffs pulls in Shiki's grammar/theme tables (~38ms per boot) — imported lazily on first parse
const loadPierreDiffs: () => Promise<PierreDiffsModule> = lazyModule(() => import("@pierre/diffs"));

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

/** effectful because the parser imports lazily; a malformed patch still surfaces as a defect */
export function parseCheckpointFilesFromUnifiedDiff(
  diff: string,
): Effect.Effect<OrchestrationCheckpointFile[]> {
  return Effect.suspend(() => {
    const normalized = diff.replace(/\r\n/g, "\n").trim();
    if (normalized.length === 0) {
      return Effect.succeed<OrchestrationCheckpointFile[]>([]);
    }
    return Effect.map(
      Effect.promise(() => loadPierreDiffs()),
      ({ parsePatchFiles }) => summarizeParsedPatches(parsePatchFiles(normalized)),
    );
  });
}
