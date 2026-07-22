// FILE: projectContainers.ts
// Purpose: Classify system-managed project containers versus ordinary projects. Managed
//          chat and Studio containers carry their own kind, but the legacy Home chat
//          container kept `kind: "project"` and is recognized by its row shape: the
//          canonical "Home" title plus the reserved chat/home workspace root.
// Layer: Shared domain helper
// Exports: chat-container root resolution, legacy Home row detection, ordinary-project rule

import type { ProjectKind } from "@synara/contracts";

import {
  workspaceRootsEqual,
  type NormalizeWorkspaceRootForComparisonOptions,
} from "./threadWorkspace";

export interface ProjectContainerWorkspacePaths {
  readonly homeDir: string | null | undefined;
  readonly chatWorkspaceRoot?: string | null | undefined;
}

/** The chat container root falls back to the home directory when no dedicated root is set. */
export function resolveChatContainerWorkspaceRoot(
  paths: ProjectContainerWorkspacePaths,
): string | null {
  return paths.chatWorkspaceRoot?.trim() || paths.homeDir?.trim() || null;
}

/**
 * True when a workspace root is one of the reserved legacy Home chat locations: the
 * configured chat root (or its home-directory fallback) or the home directory itself.
 */
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

/**
 * Ordinary projects are the user-visible ones: everything that is neither a managed
 * chat/Studio container (their kind says so) nor the legacy Home chat container.
 */
export function isOrdinaryProjectRow(input: OrdinaryProjectRowInput): boolean {
  return (input.projectKind ?? "project") === "project" && !isLegacyHomeChatContainerRow(input);
}
