import type { ReviewChangedFile } from "@t3tools/contracts";
import { gitDiffHeaderMatchesPath, parseGitDiffHeaderPath } from "@t3tools/shared/gitDiffPaths";

export interface ReviewDiffFileRow {
  path: string;
  renderKey: string;
  patchText: string;
}

interface PatchSection {
  path: string;
  text: string;
  headerLine: string;
}

const DIFF_HEADER_PREFIX = "diff --git ";

function sectionPathForFile(section: PatchSection, filePath: string): boolean {
  return gitDiffHeaderMatchesPath(section.headerLine, filePath);
}

export function splitUnifiedDiffByFile(patch: string): PatchSection[] {
  const sections: PatchSection[] = [];
  let sectionStart = -1;
  let sectionPath: string | null = null;
  let sectionHeaderLine: string | null = null;
  let lineStart = 0;

  while (lineStart < patch.length) {
    const lineEnd = patch.indexOf("\n", lineStart);
    const nextLineStart = lineEnd === -1 ? patch.length : lineEnd + 1;
    const line = patch.slice(lineStart, lineEnd === -1 ? patch.length : lineEnd);

    if (line.startsWith(DIFF_HEADER_PREFIX)) {
      if (sectionStart >= 0 && sectionPath !== null) {
        sections.push({
          path: sectionPath,
          text: patch.slice(sectionStart, lineStart).trimEnd(),
          headerLine: sectionHeaderLine ?? "",
        });
      }
      sectionStart = lineStart;
      sectionPath = parseGitDiffHeaderPath(line);
      sectionHeaderLine = line;
    }

    if (lineEnd === -1) {
      break;
    }
    lineStart = nextLineStart;
  }

  if (sectionStart >= 0 && sectionPath !== null) {
    sections.push({
      path: sectionPath,
      text: patch.slice(sectionStart).trimEnd(),
      headerLine: sectionHeaderLine ?? "",
    });
  }

  return sections;
}

export function buildReviewDiffFileRows(
  files: ReadonlyArray<ReviewChangedFile>,
  patch: string | undefined,
): ReviewDiffFileRow[] {
  if (!patch || patch.trim().length === 0 || files.length === 0) {
    return [];
  }

  const sectionsByPath = new Map<string, string>();
  const filesByPath = new Map(files.map((file) => [file.path, file] as const));
  const unresolvedSections: PatchSection[] = [];
  for (const section of splitUnifiedDiffByFile(patch)) {
    if (filesByPath.has(section.path)) {
      sectionsByPath.set(section.path, section.text);
    } else {
      unresolvedSections.push(section);
    }
  }

  for (const section of unresolvedSections) {
    for (const file of files) {
      if (!sectionsByPath.has(file.path) && sectionPathForFile(section, file.path)) {
        sectionsByPath.set(file.path, section.text);
        break;
      }
    }
  }

  const rows: ReviewDiffFileRow[] = [];
  for (const file of files) {
    const patchText = sectionsByPath.get(file.path);
    if (!patchText) {
      continue;
    }
    rows.push({
      path: file.path,
      renderKey: `${file.path}:${patchText.length}`,
      patchText,
    });
  }
  return rows;
}
