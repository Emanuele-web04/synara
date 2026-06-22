// FILE: GitCore.parsing.ts
// Purpose: Pure parsers and formatters for git porcelain, numstat, ref, remote, and stash output.
// Layer: Server Git service (pure)
// Exports: parse/normalize/summarize helpers consumed by the GitCore service implementation.
import type { StashEntry, WorkingTreeFileStat, WorkingTreeStatSummary } from "./GitCore.types.ts";

export function parseBranchAb(value: string): { ahead: number; behind: number } {
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

export function normalizeNumstatPath(rawPath: string): string {
  const renameArrowIndex = rawPath.indexOf(" => ");
  if (renameArrowIndex < 0) return rawPath;

  const compactRenameMatch = /^(.*)\{[^{}]* => ([^{}]*)\}(.*)$/.exec(rawPath);
  if (compactRenameMatch) {
    const [, prefix = "", targetSegment = "", suffix = ""] = compactRenameMatch;
    const normalized = `${prefix}${targetSegment}${suffix}`.trim();
    return normalized.length > 0 ? normalized : rawPath;
  }

  const normalized = rawPath.slice(renameArrowIndex + " => ".length).trim();
  return normalized.length > 0 ? normalized : rawPath;
}

export function parseNumstatEntries(stdout: string): Array<WorkingTreeFileStat> {
  const entries: Array<WorkingTreeFileStat> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const normalizedPath = normalizeNumstatPath(rawPath);
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

export function summarizeNumstatEntries(
  entries: ReadonlyArray<WorkingTreeFileStat>,
): WorkingTreeStatSummary {
  const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
  for (const entry of entries) {
    const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
    existing.insertions += entry.insertions;
    existing.deletions += entry.deletions;
    fileStatMap.set(entry.path, existing);
  }

  let insertions = 0;
  let deletions = 0;
  const files = Array.from(fileStatMap.entries())
    .map(([filePath, stat]) => {
      insertions += stat.insertions;
      deletions += stat.deletions;
      return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));

  return { files, insertions, deletions };
}

export function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  if (!(line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u "))) {
    return null;
  }

  const tabIndex = line.indexOf("\t");
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split("\t");
    return filePath?.trim().length ? filePath.trim() : null;
  }

  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? "";
  return filePath.length > 0 ? filePath : null;
}

export function countTextLines(contents: Uint8Array): number {
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

export function joinPatchSegments(segments: ReadonlyArray<string>): string {
  let combined = "";
  for (const segment of segments) {
    if (segment.length === 0) continue;
    if (combined.length > 0 && !combined.endsWith("\n")) {
      combined += "\n";
    }
    combined += segment;
    if (!combined.endsWith("\n")) {
      combined += "\n";
    }
  }
  return combined;
}

export function parseBranchLine(line: string): { name: string; current: boolean } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const name = trimmed.replace(/^[*+]\s+/, "");
  // Exclude symbolic refs like: "origin/HEAD -> origin/main".
  // Exclude detached HEAD pseudo-refs like: "(HEAD detached at origin/main)".
  if (name.includes(" -> ") || name.startsWith("(")) return null;

  return {
    name,
    current: trimmed.startsWith("* "),
  };
}

export function parseRemoteNames(stdout: string): ReadonlyArray<string> {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .toSorted((a, b) => b.length - a.length);
}

export function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

export function normalizeRemoteUrl(value: string): string {
  const normalized = stripRemoteUrlDecorators(value.trim()).toLowerCase();

  try {
    const parsed = new URL(normalized);
    const host = parsed.port.length > 0 ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    const pathname = stripRemoteUrlDecorators(parsed.pathname.replace(/^\/+/g, ""));
    return pathname.length > 0 ? `${host}/${pathname}` : host;
  } catch {
    const scpLikeUrl = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(normalized);
    if (scpLikeUrl) {
      const [, host = "", pathname = ""] = scpLikeUrl;
      return stripRemoteUrlDecorators(`${host}/${pathname}`);
    }
    return normalized;
  }
}

function stripRemoteUrlDecorators(value: string): string {
  return value
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "");
}

export function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

export function parseRemoteRefWithRemoteNames(
  branchName: string,
  remoteNames: ReadonlyArray<string>,
): { remoteRef: string; remoteName: string; localBranch: string } | null {
  const trimmedBranchName = branchName.trim();
  if (trimmedBranchName.length === 0) return null;

  for (const remoteName of remoteNames) {
    const remotePrefix = `${remoteName}/`;
    if (!trimmedBranchName.startsWith(remotePrefix)) {
      continue;
    }
    const localBranch = trimmedBranchName.slice(remotePrefix.length).trim();
    if (localBranch.length === 0) {
      return null;
    }
    return {
      remoteRef: trimmedBranchName,
      remoteName,
      localBranch,
    };
  }

  return null;
}

export function parseTrackingBranchByUpstreamRef(
  stdout: string,
  upstreamRef: string,
): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const upstreamBranch = upstreamBranchRaw.trim();
    if (branchName.length === 0 || upstreamBranch.length === 0) {
      continue;
    }
    if (upstreamBranch === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

export function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

export function parseDefaultBranchFromRemoteHeadRef(
  value: string,
  remoteName: string,
): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const branch = trimmed.slice(prefix.length).trim();
  return branch.length > 0 ? branch : null;
}

const DIRTY_WORKTREE_PATTERN =
  /Your local changes to the following files would be overwritten by (?:checkout|merge):\s*([\s\S]*?)Please commit your changes or stash them/;
const UNTRACKED_OVERWRITE_PATTERN =
  /The following untracked working tree files would be overwritten by (?:checkout|merge):\s*([\s\S]*?)Please move or remove them/;

export function parseDirtyWorktreeFiles(stderr: string): string[] | null {
  const match = DIRTY_WORKTREE_PATTERN.exec(stderr) ?? UNTRACKED_OVERWRITE_PATTERN.exec(stderr);
  if (!match?.[1]) return null;
  const files = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return files.length > 0 ? files : null;
}

export function parseNonEmptyLineList(input: string): string[] {
  return input
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseStashEntries(input: string): StashEntry[] {
  return parseNonEmptyLineList(input).flatMap((line) => {
    const [ref, hash] = line.split(" ");
    return ref && hash ? [{ ref, hash }] : [];
  });
}

export function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}
