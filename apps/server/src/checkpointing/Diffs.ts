import { parsePatchFiles } from "@pierre/diffs";

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalized);
  const filesByPath = new Map<string, TurnDiffFileSummary>();
  for (const patch of parsedPatches) {
    for (const file of patch.files) {
      const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
      const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
      const existing = filesByPath.get(file.name);
      filesByPath.set(file.name, {
        path: file.name,
        additions: (existing?.additions ?? 0) + additions,
        deletions: (existing?.deletions ?? 0) + deletions,
      });
    }
  }

  return Array.from(filesByPath.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}
