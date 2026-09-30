// FILE: serverWorkspacePaths.ts
// Purpose: Normalize server-provided home, chat, Studio, and Groups workspace paths.
// Layer: Web domain helper
// Exports: ServerWorkspacePaths plus normalization and fallback helpers.

import { resolveChatContainerWorkspaceRoot } from "@synara/shared/projectContainers";

export interface ServerWorkspacePaths {
  readonly homeDir: string | null | undefined;
  readonly chatWorkspaceRoot?: string | null | undefined;
  readonly studioWorkspaceRoot?: string | null | undefined;
  readonly groupsWorkspaceRoot?: string | null | undefined;
}

export interface NormalizedServerWorkspacePaths {
  readonly homeDir: string | null;
  readonly chatWorkspaceRoot: string | null;
  readonly studioWorkspaceRoot: string | null;
  readonly groupsWorkspaceRoot: string | null;
}

export function normalizeServerWorkspacePaths(
  paths: ServerWorkspacePaths,
): NormalizedServerWorkspacePaths {
  return {
    homeDir: paths.homeDir?.trim() || null,
    chatWorkspaceRoot: paths.chatWorkspaceRoot?.trim() || null,
    studioWorkspaceRoot: paths.studioWorkspaceRoot?.trim() || null,
    groupsWorkspaceRoot: paths.groupsWorkspaceRoot?.trim() || null,
  };
}

export function resolveServerChatWorkspaceRoot(paths: ServerWorkspacePaths): string | null {
  return resolveChatContainerWorkspaceRoot(paths);
}

export function resolveServerStudioWorkspaceRoot(paths: ServerWorkspacePaths): string | null {
  const normalized = normalizeServerWorkspacePaths(paths);
  return normalized.studioWorkspaceRoot;
}

export function resolveServerGroupsWorkspaceRoot(paths: ServerWorkspacePaths): string | null {
  const normalized = normalizeServerWorkspacePaths(paths);
  return normalized.groupsWorkspaceRoot;
}
