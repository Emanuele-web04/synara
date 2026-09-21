import type { ProjectKind } from "@synara/contracts";

import {
  workspaceRootsEqual,
  type NormalizeWorkspaceRootForComparisonOptions,
} from "./threadWorkspace";

export interface ProjectContainerWorkspacePaths {
  readonly homeDir: string | null | undefined;
  readonly chatWorkspaceRoot?: string | null | undefined;
}

/** the chat container root falls back to the home directory when none is set */
export function resolveChatContainerWorkspaceRoot(
  paths: ProjectContainerWorkspacePaths,
): string | null {
  return paths.chatWorkspaceRoot?.trim() || paths.homeDir?.trim() || null;
}

/** the configured chat root (or its home fallback) or the home directory itself */
export function matchesLegacyHomeChatWorkspaceRoot(
  workspaceRoot: string,
  paths: ProjectContainerWorkspacePaths,
  options?: NormalizeWorkspaceRootForComparisonOptions,
): boolean {
  const homeDir = paths.homeDir?.trim() ?? "";
  const chatWorkspaceRoot = resolveChatContainerWorkspaceRoot(paths);
  if (!homeDir || !chatWorkspaceRoot) {
    return false;
  }
  return (
    workspaceRootsEqual(workspaceRoot, chatWorkspaceRoot, options) ||
    workspaceRootsEqual(workspaceRoot, homeDir, options)
  );
}

export interface LegacyHomeChatContainerRowInput {
  readonly projectTitle: string;
  readonly projectWorkspaceRoot: string;
  readonly paths: ProjectContainerWorkspacePaths;
  readonly comparisonOptions?: NormalizeWorkspaceRootForComparisonOptions;
}

export function isLegacyHomeChatContainerRow(input: LegacyHomeChatContainerRowInput): boolean {
  return (
    input.projectTitle === "Home" &&
    matchesLegacyHomeChatWorkspaceRoot(
      input.projectWorkspaceRoot,
      input.paths,
      input.comparisonOptions,
    )
  );
}

export interface OrdinaryProjectRowInput extends LegacyHomeChatContainerRowInput {
  readonly projectKind: ProjectKind | undefined;
}

/** everything that is neither a managed chat/Studio container nor the legacy Home chat container */
export function isOrdinaryProjectRow(input: OrdinaryProjectRowInput): boolean {
  return (input.projectKind ?? "project") === "project" && !isLegacyHomeChatContainerRow(input);
}
