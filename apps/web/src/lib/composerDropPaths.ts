// FILE: composerDropPaths.ts
// Purpose: Resolve absolute paths for OS-dropped files on desktop and decide
//          when a drop should become a path mention instead of a byte attachment.
// Layer: Web composer utility (desktop-aware)

export interface ComposerDroppedFileItem {
  readonly kind: string;
  readonly getAsFile: () => File | null;
  readonly webkitGetAsEntry?: (() => { readonly isDirectory?: boolean } | null) | undefined;
}

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
    if (typeof path !== "string" || path.trim().length === 0) {
      return null;
    }
    return path;
  } catch {
    return null;
  }
}

/** Chromium exposes directory identity on the drag item, not reliably on File. */
export function isDroppedComposerDirectory(item: ComposerDroppedFileItem | undefined): boolean {
  if (!item || item.kind !== "file" || typeof item.webkitGetAsEntry !== "function") {
    return false;
  }
  try {
    return item.webkitGetAsEntry()?.isDirectory === true;
  } catch {
    return false;
  }
}

function getDroppedItemFile(item: ComposerDroppedFileItem | undefined): File | null {
  if (!item) {
    return null;
  }
  try {
    return item.getAsFile();
  } catch {
    return null;
  }
}

export function splitDroppedComposerFiles(input: {
  readonly files: Iterable<File>;
  readonly items?: Iterable<ComposerDroppedFileItem>;
}): {
  readonly pathMentions: string[];
  readonly imageFiles: File[];
  readonly genericFiles: File[];
} {
  const fallbackFiles = Array.from(input.files);
  const fileItems = input.items
    ? Array.from(input.items).filter((item) => item.kind === "file")
    : [];
  const pathMentions: string[] = [];
  const imageFiles: File[] = [];
  const genericFiles: File[] = [];
  const seenPaths = new Set<string>();
  const itemCount = Math.max(fallbackFiles.length, fileItems.length);

  for (let index = 0; index < itemCount; index += 1) {
    const item = fileItems[index];
    const file = getDroppedItemFile(item) ?? fallbackFiles[index];
    if (!file) {
      continue;
    }

    if (isDroppedComposerDirectory(item)) {
      const absolutePath = resolveDroppedFileAbsolutePath(file);
      if (absolutePath) {
        if (!seenPaths.has(absolutePath)) {
          seenPaths.add(absolutePath);
          pathMentions.push(absolutePath);
        }
        continue;
      }
    }

    if (file.type.startsWith("image/")) {
      imageFiles.push(file);
    } else {
      genericFiles.push(file);
    }
  }

  return { pathMentions, imageFiles, genericFiles };
}
