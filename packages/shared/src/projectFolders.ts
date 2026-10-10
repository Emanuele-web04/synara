// FILE: projectFolders.ts
// Purpose: Validate, label, and describe the source folders of a multi-folder project.
// Layer: Shared util (server decider/provider wiring and the web Create project dialog)
// Exports: findProjectFolderProblem, deriveProjectFolderLabels, buildProjectFoldersPreamble,
//          projectFoldersSessionIssue, PROJECT_FOLDERS_WORKTREE_ISSUE

import type { ProviderKind } from "@synara/contracts";

import { PROVIDER_DESCRIPTOR_BY_KIND } from "./providerMetadata";
import { isWorkspaceRootWithin, normalizeWorkspaceRootForComparison } from "./threadWorkspace";

/** Providers that can grant extra folders natively: Codex writable roots, Claude additional directories. */
const MULTI_FOLDER_PROVIDERS: ReadonlySet<string> = new Set(["codex", "claudeAgent"]);

/** Worktree mode would isolate only the primary folder while the others are edited live. */
export const PROJECT_FOLDERS_WORKTREE_ISSUE =
  "Worktree mode supports only single-folder projects. Use Local mode for this multi-folder project.";

/**
 * Why a chat in a multi-folder project cannot run, or null when it can. Worktree chats
 * would isolate only the primary folder while editing the others live, and other
 * providers cannot be granted the extra folders, so both are refused instead of
 * silently dropping folders.
 */
export function projectFoldersSessionIssue(input: {
  readonly provider: string;
  readonly worktree: boolean;
}): string | null {
  if (input.worktree) return PROJECT_FOLDERS_WORKTREE_ISSUE;
  if (!MULTI_FOLDER_PROVIDERS.has(input.provider)) {
    const name = PROVIDER_DESCRIPTOR_BY_KIND[input.provider as ProviderKind]?.displayName;
    return `${name ?? input.provider} cannot access a project's additional folders. Use Codex or Claude for this multi-folder project.`;
  }
  return null;
}

function isAbsoluteFolderPath(path: string): boolean {
  return /^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path.trim());
}

function folderName(path: string): string {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? path;
}

/**
 * Checks an ordered folder list whose first entry is the primary folder. Returns a
 * user-facing problem, or null when every folder is absolute, distinct, and not nested
 * inside another one (a nested folder adds no access its parent does not already grant).
 */
export function findProjectFolderProblem(
  paths: ReadonlyArray<string>,
  options?: { readonly platform?: string },
): string | null {
  if (paths.length === 0) return "Add at least one folder.";
  for (const path of paths) {
    if (!isAbsoluteFolderPath(path)) return `Use an absolute path: ${path}`;
  }
  for (let outer = 0; outer < paths.length; outer += 1) {
    for (let inner = outer + 1; inner < paths.length; inner += 1) {
      const left = paths[outer]!;
      const right = paths[inner]!;
      if (
        normalizeWorkspaceRootForComparison(left, options) ===
        normalizeWorkspaceRootForComparison(right, options)
      ) {
        return `${folderName(right)} is already in this project.`;
      }
      if (isWorkspaceRootWithin(right, left, options)) {
        return `${folderName(right)} is inside ${folderName(left)}. Add only one of them.`;
      }
      if (isWorkspaceRootWithin(left, right, options)) {
        return `${folderName(left)} is inside ${folderName(right)}. Add only one of them.`;
      }
    }
  }
  return null;
}

/** Shortest distinct trailing path for each folder: `api`, or `server/api` when two are named `api`. */
export function deriveProjectFolderLabels(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  const segments = paths.map((path) => path.replace(/\\/g, "/").split("/").filter(Boolean));
  const labels = segments.map((parts, index) => parts.at(-1) ?? paths[index]!);
  for (let depth = 2; depth <= 8; depth += 1) {
    const counts = new Map<string, number>();
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    let changed = false;
    labels.forEach((label, index) => {
      const parts = segments[index]!;
      if ((counts.get(label) ?? 0) > 1 && parts.length >= depth) {
        labels[index] = parts.slice(-depth).join("/");
        changed = true;
      }
    });
    if (!changed) break;
  }
  return labels;
}

/**
 * Ambient context for a multi-folder project, prefixed to the provider input like the
 * project packet. Null for a single-folder project.
 */
export function buildProjectFoldersPreamble(input: {
  readonly primaryFolder: string;
  readonly additionalFolders: ReadonlyArray<string>;
}): string | null {
  if (input.additionalFolders.length === 0) return null;
  const paths = [input.primaryFolder, ...input.additionalFolders];
  const labels = deriveProjectFolderLabels(paths);
  return [
    "<project_folders>",
    "This project spans several folders. You can read and edit all of them:",
    ...paths.map((path, index) => `- ${labels[index]}: ${path}${index === 0 ? " (primary)" : ""}`),
    "Use absolute paths for files outside the primary folder.",
    "</project_folders>",
  ].join("\n");
}
