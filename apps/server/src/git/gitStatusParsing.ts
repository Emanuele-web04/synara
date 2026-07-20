type GitWorkingTreeFileStat = {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
};

type GitWorkingTreeStatSummary = {
  readonly files: ReadonlyArray<GitWorkingTreeFileStat>;
  readonly insertions: number;
  readonly deletions: number;
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

function parseNumstatEntries(stdout: string): Array<GitWorkingTreeFileStat> {
  const entries: Array<GitWorkingTreeFileStat> = [];
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
    if (filePath.length === 0) {
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
    });
  }
  return entries;
}

export function summarizeGitNumstatOutputs(
  outputs: ReadonlyArray<string>,
): GitWorkingTreeStatSummary {
  const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
  for (const output of outputs) {
    for (const entry of parseNumstatEntries(output)) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }
  }

  let insertions = 0;
  let deletions = 0;
  const files = Array.from(fileStatMap.entries())
    .map(([filePath, stat]) => {
      insertions += stat.insertions;
      deletions += stat.deletions;
      return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
    })
    .toSorted((left, right) => left.path.localeCompare(right.path));

  return { files, insertions, deletions };
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

    hasWorkingTreeChanges = true;
    const statusCode =
      record.startsWith("1 ") || record.startsWith("2 ") ? record.slice(2, 4) : "";
    if (statusCode.includes("D")) {
      hasTrackedDeletion = true;
    }
    if (!path) {
      continue;
    }
    changedFilesWithoutNumstat.add(path);
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
