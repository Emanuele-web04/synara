import type { ReviewCommentSide, ReviewInlineComment } from "@t3tools/contracts";

interface FileLineSets {
  readonly rightLines: ReadonlySet<number>;
  readonly leftLines: ReadonlySet<number>;
}

interface MutableFileLineSets {
  readonly right: Set<number>;
  readonly left: Set<number>;
}

interface CurrentFileLines {
  readonly rightTargets: ReadonlyArray<Set<number>>;
  readonly leftTargets: ReadonlyArray<Set<number>>;
}

function stripPathPrefix(value: string): string {
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
}

function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!match) {
    return null;
  }
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function indexDiffLines(patch: string): Map<string, FileLineSets> {
  const files = new Map<string, MutableFileLineSets>();
  let current: CurrentFileLines | null = null;
  let oldPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      oldPath = null;
      continue;
    }
    if (line.startsWith("--- ")) {
      const source = stripPathPrefix(line.slice(4).trim());
      oldPath = source === "/dev/null" || source.length === 0 ? null : source;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = stripPathPrefix(line.slice(4).trim());
      const newPath = target === "/dev/null" || target.length === 0 ? null : target;
      if (oldPath === null && newPath === null) {
        current = null;
        continue;
      }
      const rightFile =
        newPath !== null
          ? (files.get(newPath) ?? { right: new Set<number>(), left: new Set<number>() })
          : null;
      const leftFile =
        oldPath !== null
          ? oldPath === newPath && rightFile !== null
            ? rightFile
            : (files.get(oldPath) ?? { right: new Set<number>(), left: new Set<number>() })
          : null;
      if (newPath !== null && rightFile !== null) {
        files.set(newPath, rightFile);
      }
      if (oldPath !== null && leftFile !== null) {
        files.set(oldPath, leftFile);
      }
      current = {
        rightTargets: rightFile !== null ? [rightFile.right] : [],
        leftTargets: leftFile !== null ? [leftFile.left] : [],
      };
      continue;
    }
    if (line.startsWith("+++")) {
      continue;
    }
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (header) {
        oldLine = header.oldStart;
        newLine = header.newStart;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith("+")) {
      for (const target of current.rightTargets) {
        target.add(newLine);
      }
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      for (const target of current.leftTargets) {
        target.add(oldLine);
      }
      oldLine += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      continue;
    }
    // Context line counts on both sides.
    for (const target of current.rightTargets) {
      target.add(newLine);
    }
    for (const target of current.leftTargets) {
      target.add(oldLine);
    }
    newLine += 1;
    oldLine += 1;
  }

  return new Map(
    Array.from(files.entries()).map(([path, sets]) => [
      path,
      { rightLines: sets.right, leftLines: sets.left },
    ]),
  );
}

function isCommentValid(
  index: Map<string, FileLineSets>,
  comment: { path: string; line: number; side: ReviewCommentSide },
): boolean {
  const fileLines = index.get(comment.path);
  if (!fileLines) {
    return false;
  }
  return comment.side === "RIGHT"
    ? fileLines.rightLines.has(comment.line)
    : fileLines.leftLines.has(comment.line);
}

export interface ValidatedInlineComments {
  readonly valid: ReadonlyArray<ReviewInlineComment>;
  readonly skipped: ReadonlyArray<ReviewInlineComment>;
}

export function validateInlineComments(
  patch: string,
  comments: ReadonlyArray<ReviewInlineComment>,
): ValidatedInlineComments {
  const index = indexDiffLines(patch);
  const valid: ReviewInlineComment[] = [];
  const skipped: ReviewInlineComment[] = [];
  for (const comment of comments) {
    if (isCommentValid(index, comment)) {
      valid.push(comment);
    } else {
      skipped.push(comment);
    }
  }
  return { valid, skipped };
}
