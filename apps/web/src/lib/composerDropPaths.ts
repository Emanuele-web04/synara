// FILE: composerDropPaths.ts
// Purpose: Resolve absolute paths for OS-dropped files on desktop and decide
//          when a drop should become a path mention instead of a byte attachment.
// Layer: Web composer utility (desktop-aware)

import { isLocalAbsolutePath, localPathsEqual } from "@synara/shared/path";

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
  readonly referencedPaths?: readonly string[];
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
  const representedPaths: string[] = [];
  let canMatchReferencedPaths = true;
  const itemCount = Math.max(fallbackFiles.length, fileItems.length);

  for (let index = 0; index < itemCount; index += 1) {
    const item = fileItems[index];
    const file = getDroppedItemFile(item) ?? fallbackFiles[index];
    if (!file) {
      continue;
    }

    const isDirectory = isDroppedComposerDirectory(item);
    const absolutePath =
      isDirectory || input.referencedPaths?.length ? resolveDroppedFileAbsolutePath(file) : null;
    if (input.referencedPaths?.length) {
      if (absolutePath) representedPaths.push(absolutePath);
      else canMatchReferencedPaths = false;
    }
    if (isDirectory && absolutePath) {
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

  // Editor payloads include both folders and attached files. If a File has no
  // native path, keep its attachment semantics rather than guessing its identity.
  if (canMatchReferencedPaths) {
    for (const path of input.referencedPaths ?? []) {
      if (!representedPaths.some((represented) => localPathsEqual(represented, path))) {
        representedPaths.push(path);
        pathMentions.push(path);
      }
    }
  }

  return { pathMentions, imageFiles, genericFiles };
}

// Editor file trees (VS Code, Cursor, …) attach real `Files` only when dragging
// files; a dragged folder carries just its path, as `codefiles` (a JSON array of
// absolute paths) and/or a `text/uri-list` of `file://` URLs.
export const CODE_FILES_DRAG_TYPE = "codefiles";
const URI_LIST_DRAG_TYPE = "text/uri-list";

/** Desktop drag types that may carry paths, including folders alongside `Files`. */
export function hasDroppedPathReferenceTypes(types: readonly string[]): boolean {
  if (typeof window === "undefined" || !window.desktopBridge) {
    return false;
  }
  return types.includes(CODE_FILES_DRAG_TYPE) || types.includes(URI_LIST_DRAG_TYPE);
}

function fileUrlToAbsolutePath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // `file:///C:/dir` → `C:/dir` on Windows.
  if (/^\/[A-Za-z]:\//.test(path)) {
    path = path.slice(1);
  }
  if (url.host && url.host !== "localhost") {
    path = `//${url.host}${path}`;
  }
  return isLocalAbsolutePath(path) && !path.includes("\0") ? path : null;
}

function readCodeFilesPaths(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && isLocalAbsolutePath(entry) && !entry.includes("\0"),
    );
  } catch {
    return [];
  }
}

/** Local absolute paths from an editor drag, including mixed native File payloads. */
export function readDroppedPathReferences(
  dataTransfer: Pick<DataTransfer, "types" | "getData">,
): string[] {
  const types = Array.from(dataTransfer.types);
  if (!hasDroppedPathReferenceTypes(types)) {
    return [];
  }
  let paths: string[] = [];
  if (types.includes(CODE_FILES_DRAG_TYPE)) {
    paths = readCodeFilesPaths(dataTransfer.getData(CODE_FILES_DRAG_TYPE));
  }
  if (paths.length === 0 && types.includes(URI_LIST_DRAG_TYPE)) {
    paths = dataTransfer
      .getData(URI_LIST_DRAG_TYPE)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map(fileUrlToAbsolutePath)
      .filter((path): path is string => path !== null);
  }
  return Array.from(new Set(paths));
}
