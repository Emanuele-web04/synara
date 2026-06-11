// FILE: serverWorkspacePaths.ts
// Purpose: Normalize server-provided home and general-chat workspace paths.
// Layer: Web domain helper
// Exports: ServerWorkspacePaths plus normalization and fallback helpers.

export interface ServerWorkspacePaths {
  readonly homeDir: string | null | undefined;
  readonly chatWorkspaceRoot?: string | null | undefined;
}

export interface NormalizedServerWorkspacePaths {
  readonly homeDir: string | null;
  readonly chatWorkspaceRoot: string | null;
}

export function normalizeServerWorkspacePaths(
  paths: ServerWorkspacePaths,
): NormalizedServerWorkspacePaths {
  return {
    homeDir: paths.homeDir?.trim() || null,
    chatWorkspaceRoot: paths.chatWorkspaceRoot?.trim() || null,
  };
}

export function resolveServerChatWorkspaceRoot(paths: ServerWorkspacePaths): string | null {
  const normalized = normalizeServerWorkspacePaths(paths);
  return normalized.chatWorkspaceRoot || normalized.homeDir;
}
