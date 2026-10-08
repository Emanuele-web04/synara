// Purpose: Detect and resolve exact filesystem-path queries in the Cmd+P
//          palette without duplicating the dock file-opening rules.
// Layer: Web UI logic (pure helpers; no React)

import { isLocalAbsolutePath } from "@synara/shared/path";

import { expandProjectHomePath } from "~/lib/projectPaths";
import { resolveDockFileOpenTarget } from "~/lib/workspaceFileOpener";

// Pasted editor references may carry a trailing `:line` or `:line:column`.
// The shared dock resolver owns stripping that suffix before opening.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function stripFilePositionSuffix(path: string): string {
  return path.replace(FILE_POSITION_SUFFIX_PATTERN, "");
}

/** True when a query is an absolute path or a `~/` / `~\\` home-relative path. */
export function isWorkspaceSearchFilesystemPathQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return true;
  }
  return isLocalAbsolutePath(stripFilePositionSuffix(trimmed));
}

/**
 * Resolves an exact filesystem-path query to the same target used by the
 * right-dock file pane. In-workspace paths become workspace-relative; local
 * paths outside the workspace remain absolute so preview-capable files can be
 * opened. The server-reported home directory is required for `~/…` paths.
 */
export function resolveWorkspaceSearchFilesystemPath(
  query: string,
  cwd: string | null,
  homeDir: string | null,
): string | null {
  const trimmed = query.trim();
  if (!isWorkspaceSearchFilesystemPathQuery(trimmed)) {
    return null;
  }

  const withoutPosition = stripFilePositionSuffix(trimmed);
  const expandedPath =
    withoutPosition.startsWith("~/") || withoutPosition.startsWith("~\\")
      ? expandProjectHomePath(withoutPosition, homeDir)
      : withoutPosition;

  if (
    expandedPath === withoutPosition &&
    (withoutPosition.startsWith("~/") || withoutPosition.startsWith("~\\"))
  ) {
    return null;
  }

  // Keep all normalization, containment checks, position stripping, and
  // scratch-preview policy in the existing shared resolver.
  return resolveDockFileOpenTarget(expandedPath, cwd);
}
