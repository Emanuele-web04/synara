import type { GitFileChangeType, GitStatusResult } from "@synara/contracts";

type GitWorkingTreeFileStat = GitStatusResult["workingTree"]["files"][number];
type GitWorkingTreeStatSummary = GitStatusResult["workingTree"];
type GitNumstatEntry = GitWorkingTreeFileStat & { readonly previousPath?: string };
type GitFileStatAccumulator = {
  insertions: number;
  deletions: number;
  changeType?: GitFileChangeType;
};

interface ParsedGitStatusPorcelain {
  readonly branch: string | null;
  readonly upstreamRef: string | null;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly hasWorkingTreeChanges: boolean;
  readonly hasTrackedDeletion: boolean;
  readonly hasUntrackedDirectory: boolean;
  readonly changedFilesWithoutNumstat: ReadonlySet<string>;
  readonly untrackedFilesWithoutNumstat: ReadonlySet<string>;
  readonly changeTypesByPath: ReadonlyMap<string, GitFileChangeType>;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

export function normalizeConfiguredMergeBranch(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const normalized = trimmed.replace(/^refs\/heads\//, "");
  return normalized.length > 0 ? normalized : null;
}

function parseNumstatEntries(stdout: string): Array<GitNumstatEntry> {
  const entries: Array<GitNumstatEntry> = [];
  const records = stdout.split("\0");
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    let previousPath: string | undefined;
    if (filePath.length === 0) {
      previousPath = records[index + 1];
      index += 2;
      filePath = records[index] ?? "";
    }
    if (filePath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    entries.push({
      path: filePath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
      ...(previousPath ? { previousPath } : {}),
    });
  }
  return entries;
}

export function summarizeGitNumstatOutputs(
  outputs: ReadonlyArray<string>,
  changeTypesByPath?: ReadonlyMap<string, GitFileChangeType>,
  retainMissingStatusFiles = false,
): GitWorkingTreeStatSummary {
  const fileStatMap = new Map<string, GitFileStatAccumulator>();
  const renamedSourcePaths = new Set<string>();
  for (const output of outputs) {
    for (const entry of parseNumstatEntries(output)) {
      const existing: GitFileStatAccumulator = fileStatMap.get(entry.path) ?? {
        insertions: 0,
        deletions: 0,
      };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      if (changeTypesByPath) {
        const changeType = resolveGitStatusChangeType(entry.path, changeTypesByPath);
        // Numstat's NUL source/destination pair proves a detected move only
        // when porcelain also reports the source deleted. Do not mistake a
        // copy for a rename, or let temporary-index staging hide a conflict.
        if (
          entry.previousPath &&
          changeTypesByPath.get(entry.previousPath) === "deleted" &&
          changeType !== "unmerged" &&
          changeType !== "deleted" &&
          changeType !== "copied" &&
          changeType !== "type-changed"
        ) {
          existing.changeType = "renamed";
          renamedSourcePaths.add(entry.previousPath);
        } else {
          existing.changeType = changeType ?? existing.changeType;
        }
      }
      fileStatMap.set(entry.path, existing);
    }
  }

  // Temporary staging can cancel staged/worktree diffs, but porcelain still
  // proves the real index is dirty. Keep zero-count metadata, especially for
  // conflicts. Do not reintroduce consumed move sources or aggregate directories.
  for (const [path, changeType] of changeTypesByPath ?? []) {
    if (
      (retainMissingStatusFiles || changeType === "unmerged") &&
      !fileStatMap.has(path) &&
      !renamedSourcePaths.has(path) &&
      !path.endsWith("/")
    ) {
      fileStatMap.set(path, { insertions: 0, deletions: 0, changeType });
    }
  }

  let insertions = 0;
  let deletions = 0;
  const files: Array<GitWorkingTreeFileStat> = [];
  for (const [filePath, stat] of fileStatMap) {
    insertions += stat.insertions;
    deletions += stat.deletions;
    files.push({
      path: filePath,
      insertions: stat.insertions,
      deletions: stat.deletions,
      ...(stat.changeType ? { changeType: stat.changeType } : {}),
    });
  }

  return {
    files: files.toSorted((left, right) => left.path.localeCompare(right.path)),
    insertions,
    deletions,
  };
}

export function resolveGitStatusChangeType(
  path: string,
  changeTypesByPath: ReadonlyMap<string, GitFileChangeType>,
): GitFileChangeType | undefined {
  const direct = changeTypesByPath.get(path);
  if (direct) return direct;
  // Default porcelain aggregates untracked directories as `directory/`.
  // Match complete ancestor segments, never a sibling sharing the prefix.
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    if (changeTypesByPath.get(path.slice(0, slash + 1)) === "untracked") return "untracked";
    slash = path.lastIndexOf("/", slash - 1);
  }
  return undefined;
}

function porcelainChangeType(record: string): GitFileChangeType | undefined {
  if (record.startsWith("u ")) return "unmerged";
  if (record.startsWith("? ")) return "untracked";
  if (!record.startsWith("1 ") && !record.startsWith("2 ")) return undefined;
  const code = record.slice(2, 4);
  if (code.includes("U")) return "unmerged";
  // A deletion on either side wins over an earlier staged addition/rename.
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("A")) return "added";
  if (code.includes("T")) return "type-changed";
  const submodule = record.slice(5, 9);
  if (code.includes("M") || (code === ".." && submodule.startsWith("S") && submodule !== "S..."))
    return "modified";
  return undefined;
}

function porcelainPathAfterFields(record: string, fieldCount: number): string | null {
  let offset = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    offset = record.indexOf(" ", offset);
    if (offset < 0) return null;
    offset += 1;
  }
  const filePath = record.slice(offset);
  return filePath.length > 0 ? filePath : null;
}

function parsePorcelainV2Records(stdout: string): Array<{ record: string; path: string | null }> {
  const rawRecords = stdout.split("\0");
  const records: Array<{ record: string; path: string | null }> = [];
  for (let index = 0; index < rawRecords.length; index += 1) {
    const record = rawRecords[index] ?? "";
    if (record.length === 0) continue;
    const path =
      record.startsWith("? ") || record.startsWith("! ")
        ? record.slice(2)
        : record.startsWith("1 ")
          ? porcelainPathAfterFields(record, 8)
          : record.startsWith("2 ")
            ? porcelainPathAfterFields(record, 9)
            : record.startsWith("u ")
              ? porcelainPathAfterFields(record, 10)
              : null;
    records.push({ record, path });
    if (record.startsWith("2 ")) index += 1;
  }
  return records;
}

export function parseGitStatusPorcelain(stdout: string): ParsedGitStatusPorcelain {
  let branch: string | null = null;
  let upstreamRef: string | null = null;
  let aheadCount = 0;
  let behindCount = 0;
  let hasWorkingTreeChanges = false;
  let hasTrackedDeletion = false;
  let hasUntrackedDirectory = false;
  const changedFilesWithoutNumstat = new Set<string>();
  const untrackedFilesWithoutNumstat = new Set<string>();
  const changeTypesByPath = new Map<string, GitFileChangeType>();

  for (const { record, path } of parsePorcelainV2Records(stdout)) {
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length).trim();
      branch = value.startsWith("(") ? null : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      const value = record.slice("# branch.upstream ".length).trim();
      upstreamRef = value.length > 0 ? value : null;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const value = record.slice("# branch.ab ".length).trim();
      const parsed = parseBranchAb(value);
      aheadCount = parsed.ahead;
      behindCount = parsed.behind;
      continue;
    }
    if (record.startsWith("#")) {
      continue;
    }
    if (record.startsWith("! ")) continue;

    hasWorkingTreeChanges = true;
    const statusCode = record.startsWith("1 ") || record.startsWith("2 ") ? record.slice(2, 4) : "";
    if (statusCode.includes("D")) {
      hasTrackedDeletion = true;
    }
    if (!path) {
      continue;
    }
    changedFilesWithoutNumstat.add(path);
    const changeType = porcelainChangeType(record);
    if (changeType && changeTypesByPath.get(path) !== "unmerged") {
      changeTypesByPath.set(path, changeType);
    }
    if (record.startsWith("? ")) {
      untrackedFilesWithoutNumstat.add(path);
      if (path.endsWith("/")) {
        hasUntrackedDirectory = true;
      }
    }
  }

  return {
    branch,
    upstreamRef,
    aheadCount,
    behindCount,
    hasWorkingTreeChanges,
    hasTrackedDeletion,
    hasUntrackedDirectory,
    changedFilesWithoutNumstat,
    untrackedFilesWithoutNumstat,
    changeTypesByPath,
  };
}

export function countTextFileLines(contents: Uint8Array): number {
  if (contents.length === 0) return 0;

  let lineFeeds = 0;
  for (const byte of contents) {
    if (byte === 0) {
      return 0;
    }
    if (byte === 10) {
      lineFeeds += 1;
    }
  }

  return contents.at(-1) === 10 ? lineFeeds : lineFeeds + 1;
}
