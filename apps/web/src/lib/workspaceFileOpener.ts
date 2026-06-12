// FILE: workspaceFileOpener.ts
// Purpose: Context + helpers that let file references rendered deep in the
//          chat tree (markdown links, mention chips, work-log rows) open in an
//          in-app workspace file viewer (right-dock file pane or editor pane)
//          instead of an external editor.
// Layer: Web UI helpers
// Exports: WorkspaceFileOpenerContext, useWorkspaceFileOpener,
//          resolveWorkspaceFileOpenTarget, openWorkspaceFileReference,
//          prefetchWorkspaceFile

import { isSupportedLocalImagePath } from "@t3tools/shared/localImage";
import { isWorkspaceRelativePathSafe, workspaceRelativePathOf } from "@t3tools/shared/path";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { projectReadFileQueryOptions } from "./projectReactQuery";

export interface WorkspaceFileOpener {
  /**
   * Opens a file referenced in the chat. Returns true when the reference was
   * handled by an in-app viewer; false tells the caller to fall back to the
   * external editor (path outside the workspace, no viewer on this surface).
   */
  openFile: (path: string) => boolean;
  /** Optional hover warm-up for the file contents + syntax highlighter. */
  prefetchFile?: (path: string) => void;
}

export const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null);

export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext);
}

// Trailing `:line` / `:line:col` suffix carried by resolved markdown file links.
// The in-app viewer previews whole files, so the position is dropped.
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

/**
 * Maps a chat file reference (workspace-relative, or absolute as produced by
 * `resolveMarkdownFileLinkTarget`, optionally with a `:line:col` suffix) to the
 * workspace-relative path the file-read RPC expects. Returns null when the
 * reference points outside the workspace.
 */
export function resolveWorkspaceFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  if (isWorkspaceRelativePathSafe(withoutPosition)) {
    return withoutPosition;
  }
  if (!workspaceRoot) {
    return null;
  }
  return workspaceRelativePathOf(withoutPosition, workspaceRoot);
}

/**
 * Shared activation path for clickable file references: try the surface's
 * in-app viewer first, fall back to the preferred external editor when the
 * reference isn't viewable in-app (path outside the workspace, no opener).
 * Pass a null opener to force the external editor (e.g. meta/ctrl-click).
 */
export function openWorkspaceFileReference(opener: WorkspaceFileOpener | null, path: string): void {
  if (opener?.openFile(path)) {
    return;
  }
  const api = readNativeApi();
  if (api) {
    void openInPreferredEditor(api, path).catch(() => undefined);
  } else {
    console.warn("Native API not found. Unable to open file in editor.");
  }
}

/**
 * Hover warm-up so the file pane opens instantly: file contents go through the
 * shared React Query cache, and the matching Shiki highlighter loads in the
 * background. The highlighter module is imported dynamically so chat-adjacent
 * chunks don't pull Shiki eagerly.
 */
export function prefetchWorkspaceFile(
  queryClient: QueryClient,
  workspaceRoot: string,
  relativePath: string,
): void {
  if (isSupportedLocalImagePath(relativePath)) {
    return;
  }
  void queryClient.prefetchQuery(projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath }));
  void import("./syntaxHighlighting")
    .then((module) =>
      module.getSyntaxHighlighterPromise(module.getSyntaxLanguageForPath(relativePath)),
    )
    .catch(() => undefined);
}
