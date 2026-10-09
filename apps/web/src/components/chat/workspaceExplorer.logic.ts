// FILE: workspaceExplorer.logic.ts
// Purpose: Filter/sort lazy explorer listings and compact already-known directory chains.
// Layer: Chat workspace-browsing utilities

import type { GitFileChangeType, GitStatusResult, ProjectFileSystemEntry } from "@synara/contracts";
import { isWorkspaceRelativePathSafe } from "@synara/shared/path";

import { compareDiffPaths } from "~/lib/diffRendering";

export interface WorkspaceExplorerGitIndicator {
  readonly label: string;
  readonly textClassName: string;
  readonly dotClassName: string;
}

const CHANGED_INDICATOR: WorkspaceExplorerGitIndicator = {
  label: "Working tree changes",
  textClassName: "text-warning",
  dotClassName: "bg-warning",
};
const GIT_FILE_INDICATORS: Record<GitFileChangeType, WorkspaceExplorerGitIndicator> = {
  added: { label: "Added", textClassName: "text-success", dotClassName: "bg-success" },
  untracked: { label: "Untracked", textClassName: "text-success", dotClassName: "bg-success" },
  modified: { ...CHANGED_INDICATOR, label: "Modified" },
  deleted: { label: "Deleted", textClassName: "text-destructive", dotClassName: "bg-destructive" },
  renamed: { ...CHANGED_INDICATOR, label: "Renamed" },
  copied: { ...CHANGED_INDICATOR, label: "Copied" },
  unmerged: { ...CHANGED_INDICATOR, label: "Unmerged (conflict)" },
  "type-changed": { ...CHANGED_INDICATOR, label: "Type changed" },
};

export function workspaceExplorerGitIndicators(
  files: GitStatusResult["workingTree"]["files"],
): ReadonlyMap<string, WorkspaceExplorerGitIndicator> {
  const indicators = new Map<string, WorkspaceExplorerGitIndicator>();
  const filePaths = new Set<string>();
  for (const file of files) {
    // Porcelain may aggregate an untracked directory with a trailing slash.
    const path = file.path.endsWith("/") ? file.path.slice(0, -1) : file.path;
    filePaths.add(path);
    indicators.set(
      path,
      file.changeType ? GIT_FILE_INDICATORS[file.changeType] : CHANGED_INDICATOR,
    );
  }
  for (const file of files) {
    let slash = file.path.lastIndexOf("/");
    while (slash > 0) {
      const parent = file.path.slice(0, slash);
      if (!filePaths.has(parent)) {
        const conflict =
          file.changeType === "unmerged" ||
          indicators.get(parent)?.label === "Contains unmerged changes";
        indicators.set(parent, {
          ...CHANGED_INDICATOR,
          label: conflict ? "Contains unmerged changes" : "Contains working tree changes",
        });
      }
      slash = file.path.lastIndexOf("/", slash - 1);
    }
  }
  return indicators;
}

const EXPLORER_HIDDEN_ENTRY_NAMES = new Set([".git", ".DS_Store"]);
const EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
  "__pycache__",
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

export function visibleWorkspaceExplorerEntries(
  entries: ReadonlyArray<ProjectFileSystemEntry>,
): ProjectFileSystemEntry[] {
  return entries
    .filter(
      (entry) =>
        !EXPLORER_HIDDEN_ENTRY_NAMES.has(entry.name) &&
        (entry.kind !== "directory" ||
          (!entry.name.startsWith(".synara") && !EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name))),
    )
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return compareDiffPaths(left.name, right.name);
    });
}

/**
 * Compact only listings already in the shared cache. The caller observes every
 * path in the chain and loads its next level only while the original row is open.
 * The original path remains the expansion key; actions target the final directory.
 */
export function compactWorkspaceExplorerDirectory(
  entry: ProjectFileSystemEntry,
  getEntries: (path: string) => ReadonlyArray<ProjectFileSystemEntry> | undefined,
): { entry: ProjectFileSystemEntry; paths: string[] } {
  let current = entry;
  const paths = [entry.path];
  while (current.kind === "directory") {
    const entries = getEntries(current.path);
    if (!entries) break;
    const visibleEntries = visibleWorkspaceExplorerEntries(entries);
    const child = visibleEntries[0];
    if (
      visibleEntries.length !== 1 ||
      child?.kind !== "directory" ||
      !isWorkspaceRelativePathSafe(child.path) ||
      child.path !== `${current.path}/${child.name}`
    ) {
      break;
    }
    paths.push(child.path);
    current = { ...child, name: `${current.name}/${child.name}` };
  }
  return { entry: current, paths };
}
