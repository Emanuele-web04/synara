// FILE: diffTheme.ts
// Purpose: Pure diff theme, hashing, path, and unified-diff stat helpers with zero heavy runtime imports.
// Layer: Web diff utilities

export const DIFF_THEME_NAMES = {
  // Keep diff syntax highlighting on the bundled GitHub themes for better parity with git tooling.
  light: "github-light",
  dark: "github-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

export type FileDiffStat = { additions: number; deletions: number };

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

// Split a repo-relative path into a trailing-slash directory prefix and a leaf
// name so diff/file rows can dim the directory while emphasizing the file name.
// Intentionally not reusing the directory-browser helpers (projectPaths.ts):
// those carry trailing-separator / Windows-drive semantics meant for browsing.
export function splitRepoRelativePath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return { dir: "", name: path };
  }
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

// Natural-order comparator for parsed file diffs by working-tree path, so file
// lists stay stable and human-friendly (numeric-aware, case-insensitive).
let diffPathCollator: Intl.Collator | undefined;

export function compareDiffPaths(left: string, right: string): number {
  diffPathCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return diffPathCollator.compare(left, right);
}

function normalizeDiffStatPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function diffStatPathsReferToSameFile(left: string, right: string): boolean {
  const normalizedLeft = normalizeDiffStatPath(left);
  const normalizedRight = normalizeDiffStatPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

export function resolveDiffEntryByPath<T>(
  entriesByPath: ReadonlyMap<string, T>,
  changedFilePath: string,
): T | undefined {
  const direct = entriesByPath.get(changedFilePath);
  if (direct) {
    return direct;
  }

  const matches = Array.from(entriesByPath.entries())
    .filter(([path]) => diffStatPathsReferToSameFile(path, changedFilePath))
    .map(([, entry]) => entry);
  return matches.length === 1 ? matches.at(0) : undefined;
}

// Resolve a parsed patch stat for a visible changed-file row. Parsed patch paths are
// usually repo-relative, while work-log changedFiles can be absolute or basename-only.
export function resolveFileDiffStatByChangedPath(
  statsByPath: ReadonlyMap<string, FileDiffStat>,
  changedFilePath: string,
  changedFileCount: number,
): FileDiffStat | undefined {
  if (statsByPath.size === 0) {
    return undefined;
  }

  const match = resolveDiffEntryByPath(statsByPath, changedFilePath);
  if (match) {
    return match;
  }

  if (statsByPath.size === 1 && changedFileCount === 1) {
    return statsByPath.values().next().value;
  }
  return undefined;
}

function stripPatchHeaderPath(rawHeaderValue: string): string | null {
  const tabIndex = rawHeaderValue.indexOf("\t");
  const trimmed = (tabIndex >= 0 ? rawHeaderValue.slice(0, tabIndex) : rawHeaderValue).trim();
  if (trimmed.length === 0 || trimmed === "/dev/null") {
    return null;
  }
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
const PLUS = 43;
const MINUS = 45;
const SPACE = 32;
const BACKSLASH = 92;

// Pure unified-diff line counter so transcript work rows can compute +N/-M stats
// without eagerly importing `@pierre/diffs` into the initial chat bundle.
//
// Hunk bodies are consumed by the line counts in their `@@` header, not by
// prefix: a removed line whose text starts with "-- " reads "--- ..." in the
// patch and an added "++ ..." reads "+++ ...", exactly like file headers.
export function fileDiffStatsByPath(patch: string | undefined): Map<string, FileDiffStat> {
  const stats = new Map<string, FileDiffStat>();
  if (!patch) {
    return stats;
  }
  const trimmed = patch.trim();
  if (trimmed.length === 0) {
    return stats;
  }

  let currentOldPath: string | null = null;
  let currentPath: string | null = null;
  let additions = 0;
  let deletions = 0;
  let sawHunk = false;
  let hasFileEntry = false;
  // Lines the current hunk still owes on each side, from its header.
  let oldRemaining = 0;
  let newRemaining = 0;

  const flushCurrent = () => {
    const resolvedPath = currentPath ?? currentOldPath;
    if (hasFileEntry && resolvedPath && resolvedPath.length > 0) {
      const existing = stats.get(resolvedPath);
      if (existing) {
        existing.additions += additions;
        existing.deletions += deletions;
      } else {
        stats.set(resolvedPath, { additions, deletions });
      }
    }
    currentOldPath = null;
    currentPath = null;
    additions = 0;
    deletions = 0;
    sawHunk = false;
    hasFileEntry = false;
    oldRemaining = 0;
    newRemaining = 0;
  };

  // Returns true when the line belonged to the hunk body the header announced.
  const consumeCountedHunkLine = (line: string): boolean => {
    const marker = line.length === 0 ? SPACE : line.charCodeAt(0);
    if (marker === PLUS && newRemaining > 0) {
      additions += 1;
      newRemaining -= 1;
      return true;
    }
    if (marker === MINUS && oldRemaining > 0) {
      deletions += 1;
      oldRemaining -= 1;
      return true;
    }
    if (marker === BACKSLASH) {
      // "\ No newline at end of file" annotates the previous line.
      return true;
    }
    if (marker === SPACE) {
      if (oldRemaining > 0) oldRemaining -= 1;
      if (newRemaining > 0) newRemaining -= 1;
      return true;
    }
    // The header's counts do not match the body; read the rest by prefix.
    oldRemaining = 0;
    newRemaining = 0;
    return false;
  };

  let lineStart = 0;
  while (lineStart <= trimmed.length) {
    const newlineIndex = trimmed.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? trimmed.length : newlineIndex;
    const rawLine = trimmed.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    const inCountedHunk = oldRemaining > 0 || newRemaining > 0;
    // No hunk line can start with "diff --git " (context lines are indented).
    const consumed =
      inCountedHunk && !line.startsWith("diff --git ") && consumeCountedHunkLine(line);
    if (consumed) {
      // Counted above.
    } else if (line.startsWith("diff --git ")) {
      flushCurrent();
      hasFileEntry = true;
    } else if (line.startsWith("--- ")) {
      if (sawHunk) {
        flushCurrent();
      }
      hasFileEntry = true;
      currentOldPath = stripPatchHeaderPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      hasFileEntry = true;
      currentPath = stripPatchHeaderPath(line.slice(4));
    } else if (line.startsWith("@@ ")) {
      sawHunk = true;
      const counts = HUNK_HEADER_PATTERN.exec(line);
      // A missing count means one line; an unreadable header leaves both at
      // zero, so that hunk is read by prefix below.
      oldRemaining = counts ? Number(counts[1] ?? 1) : 0;
      newRemaining = counts ? Number(counts[2] ?? 1) : 0;
    } else if (sawHunk) {
      // Outside a counted body: an unreadable header, or more lines than the
      // header announced. Headers were ruled out above, so prefix is all we have.
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }

    if (newlineIndex === -1) break;
    lineStart = newlineIndex + 1;
  }

  flushCurrent();
  return stats;
}
