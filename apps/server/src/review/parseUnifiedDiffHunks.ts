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

function unquoteGitPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch));
      continue;
    }
    const next = inner[++i];
    if (next === "t") bytes.push(9);
    else if (next === "n") bytes.push(10);
    else if (next === "r") bytes.push(13);
    else if (next !== undefined && next >= "0" && next <= "7") {
      const oct = inner.slice(i, i + 3);
      i += oct.length - 1;
      bytes.push(parseInt(oct, 8) & 0xff);
    } else bytes.push(...new TextEncoder().encode(next ?? ""));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function stripPathPrefix(raw: string): string {
  const value = unquoteGitPath(raw);
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
      file = {
        path: "",
        oldPath: null,
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
      const oldStart = Number(hunkMatch[1]);
      const oldLines = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      const newStart = Number(hunkMatch[3]);
      const newLines = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      const valid =
        Number.isSafeInteger(oldStart) &&
        oldStart >= 0 &&
        Number.isSafeInteger(oldLines) &&
        oldLines >= 0 &&
        Number.isSafeInteger(newStart) &&
        newStart >= 0 &&
        Number.isSafeInteger(newLines) &&
        newLines >= 0;
      if (!valid) {
        hunk = null;
        continue;
      }
      hunk = { oldStart, oldLines, newStart, newLines, header: line, lines: [] };
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
      file.oldPath = unquoteGitPath(line.slice("rename from ".length).trim());
    } else if (line.startsWith("rename to ")) {
      file.status = "renamed";
      file.path = unquoteGitPath(line.slice("rename to ".length).trim());
    } else if (line.startsWith("copy from ")) {
      file.status = "copied";
      file.oldPath = unquoteGitPath(line.slice("copy from ".length).trim());
    } else if (line.startsWith("copy to ")) {
      file.status = "copied";
      file.path = unquoteGitPath(line.slice("copy to ".length).trim());
    } else if (line.startsWith("--- ")) {
      const src = stripPathPrefix(line.slice(4).trim());
      if (src !== "/dev/null" && src.length > 0) {
        file.oldPath = src;
        if (file.path.length === 0) file.path = src;
      }
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
// preserving file order and each file's header lines so it renders standalone.
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
  return out.length > 0 ? `${out.join("\n")}\n` : "";
}
