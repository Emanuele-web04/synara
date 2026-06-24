import type { ReviewHunkRef, ReviewWalkthroughChapter } from "@t3tools/contracts";

import type { ParsedFileDiff } from "./parseUnifiedDiffHunks.ts";

const hunkKey = ({ filePath, oldStart }: { filePath: string; oldStart: number }): string =>
  `${filePath}::${String(oldStart)}`;

const formatHunkRef = (filePath: string, oldStart: number): string =>
  `${JSON.stringify(filePath)} | ${String(oldStart)}`;

// Explicit anchor list fed to the agent so chapters reference real (filePath, oldStart) hunks.
export function formatHunksSummary(files: ReadonlyArray<ParsedFileDiff>): string {
  const lines: string[] = [];
  for (const file of files) {
    for (const hunk of file.hunks) {
      lines.push(formatHunkRef(file.path, hunk.oldStart));
    }
  }
  return lines.join("\n");
}

// The agent is asked to cover every hunk exactly once; reconcile reality against that:
// drop refs that don't exist or repeat, skip emptied chapters, and sweep any uncovered
// hunks into a trailing "Other changes" chapter so the diff stays fully accounted for.
export function reconcileChapterCoverage(
  files: ReadonlyArray<ParsedFileDiff>,
  chapters: ReadonlyArray<ReviewWalkthroughChapter>,
): { chapters: ReviewWalkthroughChapter[]; warnings: string[] } {
  const warnings: string[] = [];
  const allHunks = new Map<string, ReviewHunkRef>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      allHunks.set(hunkKey({ filePath: file.path, oldStart: hunk.oldStart }), {
        filePath: file.path,
        oldStart: hunk.oldStart,
      });
    }
    // Files that parse with no textual hunks (binary, pure rename, mode-only) can never
    // reach allHunks/uncovered/"Other changes", so flag them so coverage stays honest.
    if (file.hunks.length === 0) {
      warnings.push(
        `File ${file.path} (${file.status}) has no textual hunks (e.g. binary, pure rename, or mode-only change) and is not represented in any chapter.`,
      );
    }
  }

  const seen = new Set<string>();
  const cleaned: ReviewWalkthroughChapter[] = [];

  for (const chapter of chapters) {
    const keptRefs: ReviewHunkRef[] = [];
    for (const ref of chapter.hunkRefs) {
      const key = hunkKey(ref);
      if (!allHunks.has(key)) {
        warnings.push(
          `Dropped hunk ${formatHunkRef(ref.filePath, ref.oldStart)} from "${chapter.title}" (not in diff).`,
        );
        continue;
      }
      if (seen.has(key)) {
        warnings.push(
          `Dropped duplicate hunk ${formatHunkRef(ref.filePath, ref.oldStart)} from "${chapter.title}".`,
        );
        continue;
      }
      seen.add(key);
      keptRefs.push({ filePath: ref.filePath, oldStart: ref.oldStart });
    }
    if (keptRefs.length === 0) {
      warnings.push(`Skipped chapter "${chapter.title}" because it covered no valid hunks.`);
      continue;
    }
    cleaned.push({
      ...chapter,
      status: "queued",
      hunkRefs: keptRefs,
      files: [...new Set(keptRefs.map((ref) => ref.filePath))],
    });
  }

  const uncovered = [...allHunks.entries()].filter(([key]) => !seen.has(key)).map(([, ref]) => ref);
  if (uncovered.length > 0) {
    warnings.push(
      `${String(uncovered.length)} hunk(s) were not grouped into a chapter; collected under "Other changes".`,
    );
    cleaned.push({
      id: "chapter-other",
      title: "Other changes",
      summary: "Hunks the walkthrough did not group into a dedicated chapter.",
      intent: "Skim these to confirm nothing important was missed.",
      anchor: "uncovered hunks",
      risk: "minor",
      hunkRefs: uncovered,
      files: [...new Set(uncovered.map((ref) => ref.filePath))],
      status: "queued",
    });
  }

  return { chapters: cleaned, warnings };
}
