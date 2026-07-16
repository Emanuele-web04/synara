// FILE: composerDropPaths.ts
// Purpose: Resolve absolute paths for OS-dropped files on desktop and decide
//          when a drop should become a path mention instead of a byte attachment.
// Layer: Web composer utility (desktop-aware)

/**
 * Best-effort absolute path for a File from a drag/drop or file picker.
 * On Electron, uses `webUtils.getPathForFile` via the desktop bridge.
 */
export function resolveDroppedFileAbsolutePath(file: File): string | null {
  const bridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const getPath = bridge?.getPathForFile;
  if (typeof getPath !== "function") {
    return null;
  }
  try {
    const path = getPath(file);
    if (typeof path !== "string") {
      return null;
    }
    const trimmed = path.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Heuristic for directory drops from Finder/Explorer: empty type, zero size,
 * and an absolute path from the desktop bridge. Real empty files are rare in
 * composer drops; folders cannot be read as attachment blobs (#351).
 */
export function isLikelyDroppedDirectory(file: File, absolutePath: string | null): boolean {
  if (!absolutePath) {
    return false;
  }
  if (file.type.startsWith("image/")) {
    return false;
  }
  // Chromium often reports directories with empty type and size 0.
  if (file.size === 0 && (file.type === "" || file.type === "application/x-directory")) {
    return true;
  }
  // Path ends with a separator (some OS drags).
  if (/[/\\]$/.test(absolutePath)) {
    return true;
  }
  return false;
}

export function splitDroppedComposerFiles(files: Iterable<File>): {
  readonly pathMentions: string[];
  readonly imageFiles: File[];
  readonly genericFiles: File[];
} {
  const pathMentions: string[] = [];
  const imageFiles: File[] = [];
  const genericFiles: File[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    const absolutePath = resolveDroppedFileAbsolutePath(file);
    if (isLikelyDroppedDirectory(file, absolutePath) && absolutePath) {
      if (!seenPaths.has(absolutePath)) {
        seenPaths.add(absolutePath);
        pathMentions.push(absolutePath);
      }
      continue;
    }
    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      genericFiles.push(file);
    }
  }

  return { pathMentions, imageFiles, genericFiles };
}
