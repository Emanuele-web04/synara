import { isSupportedLocalPreviewFilePath } from "@synara/shared/localPreviewFiles";
import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  localPathsEqual,
  workspaceRelativePathOf,
} from "@synara/shared/path";
import { isScratchWorkspacePath } from "@synara/shared/threadWorkspace";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readNativeApi } from "../nativeApi";
import { projectReadFileQueryOptions } from "./projectReactQuery";

export interface WorkspaceFileOpener {
  openFile: (path: string) => boolean;
  prefetchFile?: (path: string) => void;
}

export const WorkspaceFileOpenerContext = createContext<WorkspaceFileOpener | null>(null);

export function useWorkspaceFileOpener(): WorkspaceFileOpener | null {
  return useContext(WorkspaceFileOpenerContext);
}

// trailing :line/:col from markdown links dropped — the in-app viewer previews whole files
const FILE_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]+$/;
const SYNARA_PUBLIC_ASSET_PATH_PREFIXES = [
  "/central-icons-reversed/",
  "/central-icons-fill/",
] as const;
const SYNARA_WEB_PUBLIC_WORKSPACE_DIR = "apps/web/public";

function resolveSynaraPublicAssetOpenTarget(path: string, workspaceRoot: string | null) {
  if (!workspaceRoot) {
    return null;
  }
  const normalizedPath = path.replace(/\\/g, "/");
  if (!SYNARA_PUBLIC_ASSET_PATH_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))) {
    return null;
  }
  const relativePath = `${SYNARA_WEB_PUBLIC_WORKSPACE_DIR}${normalizedPath}`;
  return isWorkspaceRelativePathSafe(relativePath) ? relativePath : null;
}

/**
 * Maps directory references that can be identified without a filesystem probe
 * to the workspace-relative path expected by the Explorer. The workspace root
 * is always known to be a directory; descendants are treated as directories
 * only when the reference keeps an explicit trailing separator.
 *
 * An empty string means the workspace root itself. Null means the reference is
 * not a known in-workspace directory and should continue through file opening.
 */
export function resolveWorkspaceDirectoryOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  if (!workspaceRoot) {
    return null;
  }
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  // keep ".." intact so containment checks still reject traversal
  const directoryPath = withoutPosition
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
  if (localPathsEqual(directoryPath, workspaceRoot)) {
    return "";
  }
  if (!TRAILING_PATH_SEPARATOR_PATTERN.test(withoutPosition)) {
    return null;
  }
  const withoutTrailingSeparators = directoryPath.replace(TRAILING_PATH_SEPARATOR_PATTERN, "");
  if (isWorkspaceRelativePathSafe(withoutTrailingSeparators)) {
    return withoutTrailingSeparators.replaceAll("\\", "/");
  }
  return workspaceRelativePathOf(withoutTrailingSeparators, workspaceRoot);
}

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
  const workspaceRelativePath = workspaceRelativePathOf(withoutPosition, workspaceRoot);
  if (workspaceRelativePath) {
    return workspaceRelativePath;
  }
  // CentralIcon assets are linked in chat as Vite root URLs (`/central-icons-...`) but the file viewer needs the repo path.
  return resolveSynaraPublicAssetOpenTarget(withoutPosition, workspaceRoot);
}

/**
 * Out-of-workspace fallback for surfaces that can preview binary files: a
 * session that starts before its chat workspace exists runs in a scratch
 * directory under the OS temp dir, and the agent references those files by
 * absolute path. Images and PDFs stream through the allowlisted local-image
 * route (which also serves the scratch root), so they can still open in-app.
 * Anything else returns null — the text file-read RPC only accepts
 * workspace-relative paths, so those references fall back to the external
 * editor.
 */
export function resolveScratchPreviewFileOpenTarget(rawPath: string): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (!isScratchWorkspacePath(withoutPosition)) {
    return null;
  }
  return isSupportedLocalPreviewFilePath(withoutPosition) ? withoutPosition : null;
}

// Right-dock file panes can show workspace files plus absolute local paths. Relative paths still require a workspace; absolute paths are read as-is.
export function resolveDockFileOpenTarget(
  rawPath: string,
  workspaceRoot: string | null,
): string | null {
  const withoutPosition = rawPath.trim().replace(FILE_POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) {
    return null;
  }
  const workspaceTarget = workspaceRoot
    ? resolveWorkspaceFileOpenTarget(rawPath, workspaceRoot)
    : null;
  if (workspaceTarget) {
    return workspaceTarget;
  }
  if (isLocalAbsolutePath(withoutPosition)) {
    return withoutPosition;
  }
  return resolveScratchPreviewFileOpenTarget(rawPath);
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

// the highlighter is imported dynamically so chat-adjacent chunks don't pull Shiki eagerly
export function prefetchWorkspaceFile(
  queryClient: QueryClient,
  workspaceRoot: string,
  relativePath: string,
): void {
  // Images and PDFs stream through the local-image HTTP route, so there is no text read to warm and no syntax highlighter to load.
  if (isSupportedLocalPreviewFilePath(relativePath)) {
    return;
  }
  // bare filenames usually don't exist at the root and make the read RPC build the workspace index — skip warming those so a pointer sweep never triggers repeated index builds; click-to-open still resolves on demand
  if (!relativePath.includes("/")) {
    return;
  }
  void queryClient.prefetchQuery(projectReadFileQueryOptions({ cwd: workspaceRoot, relativePath }));
  void import("./syntaxHighlighting")
    .then((module) =>
      module.getSyntaxHighlighterPromise(module.getSyntaxLanguageForPath(relativePath)),
    )
    .catch(() => undefined);
}
