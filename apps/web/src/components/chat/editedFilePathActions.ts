import {
  isLocalAbsolutePath,
  isWorkspaceRelativePathSafe,
  joinWorkspaceRelativePath,
  workspaceRelativePathOf,
} from "@synara/shared/path";

export interface EditedFilePathTargets {
  absolutePath: string | null;
  relativePath: string | null;
}

export function resolveEditedFilePathTargets(
  filePath: string,
  workspaceRoot: string | undefined,
): EditedFilePathTargets {
  const trimmedPath = filePath.trim();
  if (trimmedPath.length === 0) {
    return { absolutePath: null, relativePath: null };
  }

  if (isLocalAbsolutePath(trimmedPath)) {
    return {
      absolutePath: trimmedPath,
      relativePath: workspaceRoot ? workspaceRelativePathOf(trimmedPath, workspaceRoot) : null,
    };
  }

  if (!isWorkspaceRelativePathSafe(trimmedPath)) {
    return { absolutePath: null, relativePath: null };
  }

  const relativePath = trimmedPath.replace(/\\/g, "/");
  return {
    absolutePath: workspaceRoot ? joinWorkspaceRelativePath(workspaceRoot, relativePath) : null,
    relativePath,
  };
}
