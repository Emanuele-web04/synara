export interface ParsedHunk {
  filePath: string;
  status: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: readonly string[];
}

export interface ParsedFileDiff {
  path: string;
  oldPath: string | null;
  status: string;
  headerLines: readonly string[];
  hunks: readonly ParsedHunk[];
}

export interface HunkRef {
  filePath: string;
  oldStart: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface MutableHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: string[];
}

interface MutableFile {
  path: string;
  oldPath: string | null;
  status: string;
  headerLines: string[];
  hunks: MutableHunk[];
}

function stripPathPrefix(value: string): string {
  if (value === "/dev/null") return value;
  if (value.startsWith("a/") || value.startsWith("b/")) {
    return value.slice(2);
  }
  return value;
}

export function parseUnifiedDiffHunks(patch: string): ParsedFileDiff[] {
  const files: ParsedFileDiff[] = [];
  let file: MutableFile | null = null;
  let hunk: MutableHunk | null = null;

  const flushHunk = (): void => {
    if (file && hunk) {
      file.hunks.push(hunk);
      hunk = null;
    }
  };

  const flushFile = (): void => {
    flushHunk();
    if (!file) return;
    const resolved = file;
    files.push({
      path: resolved.path,
      oldPath: resolved.oldPath,
      status: resolved.status,
      headerLines: resolved.headerLines,
      hunks: resolved.hunks.map((entry) => ({
        filePath: resolved.path,
        status: resolved.status,
        oldStart: entry.oldStart,
        oldLines: entry.oldLines,
        newStart: entry.newStart,
        newLines: entry.newLines,
        header: entry.header,
        lines: entry.lines,
      })),
    });
    file = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flushFile();
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = {
        path: match?.[2] ?? "",
        oldPath: match?.[1] ?? null,
        status: "modified",
        headerLines: [line],
        hunks: [],
      };
      continue;
    }
    if (!file) continue;

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch) {
      flushHunk();
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: line,
        lines: [],
      };
      continue;
    }

    if (hunk) {
      hunk.lines.push(line);
      continue;
    }

    file.headerLines.push(line);
    if (line.startsWith("new file mode")) {
      file.status = "added";
    } else if (line.startsWith("deleted file mode")) {
      file.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = line.slice("rename from ".length).trim();
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = line.slice("rename to ".length).trim();
    } else if (line.startsWith("+++ ")) {
      const target = stripPathPrefix(line.slice(4).trim());
      if (target !== "/dev/null" && target.length > 0) {
        file.path = target;
      }
    }
  }
  flushFile();

  return files.filter((entry) => entry.path.length > 0);
}

// Reconstruct a minimal valid unified patch containing only the referenced hunks,
// preserving file order and each file's preamble so it renders standalone.
export function subPatchForHunks(patch: string, refs: readonly HunkRef[]): string {
  const wanted = new Map<string, Set<number>>();
  for (const ref of refs) {
    const set = wanted.get(ref.filePath) ?? new Set<number>();
    set.add(ref.oldStart);
    wanted.set(ref.filePath, set);
  }

  const out: string[] = [];
  for (const file of parseUnifiedDiffHunks(patch)) {
    const set = wanted.get(file.path);
    if (!set) continue;
    const selected = file.hunks.filter((entry) => set.has(entry.oldStart));
    if (selected.length === 0) continue;
    out.push(...file.headerLines);
    for (const entry of selected) {
      out.push(entry.header, ...entry.lines);
    }
  }
  return out.join("\n");
}
