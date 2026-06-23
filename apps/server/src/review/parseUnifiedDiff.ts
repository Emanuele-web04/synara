import { normalizeGitPatchPath, parseGitDiffHeaderPath } from "@t3tools/shared/gitDiffPaths";

export interface ParsedDiffFile {
  path: string;
  insertions: number;
  deletions: number;
  status?: string;
}

interface FileAccumulator {
  path: string;
  insertions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
}

function resolveStatus(file: FileAccumulator): string {
  if (file.isDeleted) return "deleted";
  if (file.isNew) return "added";
  if (file.isRename) return "renamed";
  return "modified";
}

export function parseUnifiedDiff(patch: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];
  let current: FileAccumulator | null = null;

  const flush = () => {
    if (!current) return;
    files.push({
      path: current.path,
      insertions: current.insertions,
      deletions: current.deletions,
      status: resolveStatus(current),
    });
    current = null;
  };

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const path = parseGitDiffHeaderPath(line) ?? "";
      current = {
        path,
        insertions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isRename: false,
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDeleted = true;
      continue;
    }
    if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      current.isRename = true;
      if (line.startsWith("rename to ")) {
        current.path = normalizeGitPatchPath(line.slice("rename to ".length).trim());
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = normalizeGitPatchPath(line.slice(4).trim());
      if (target !== "/dev/null" && target.length > 0) {
        current.path = target;
      }
      continue;
    }
    if (line.startsWith("+")) {
      current.insertions += 1;
      continue;
    }
    if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }
  flush();

  return files.filter((file) => file.path.length > 0);
}
