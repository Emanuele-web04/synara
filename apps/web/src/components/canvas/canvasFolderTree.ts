// FILE: canvasFolderTree.ts
// Purpose: The library's folders as a tree in reading order (each folder followed by its
//          subfolders, by title) with each one's depth, and the indent of a folder's row, for
//          the folder pickers (the library's Move to menu, the folder field of the canvas dialog).
// Layer: Canvas UI logic
// Exports: canvasFolderTree, canvasFolderRowIndent

import type { CanvasFolder } from "@synara/contracts";
import type { CSSProperties } from "react";

/**
 * A folder row's start padding: `base`, the row's own (a menu row's picker padding by default),
 * plus 16 px a level.
 */
export const canvasFolderRowIndent = (
  depth: number,
  base = "var(--picker-option-px, 8px)",
): CSSProperties => ({
  paddingInlineStart: `calc(${base} + ${depth * 16}px)`,
});

/**
 * `folders` depth first: roots (and folders whose parent is not listed) at depth 0, each
 * followed by its subfolders one level deeper, siblings by title. A parent loop cannot
 * repeat a folder, nor hide one.
 */
export function canvasFolderTree<F extends Pick<CanvasFolder, "id" | "title" | "folderId">>(
  folders: readonly F[],
): { folder: F; depth: number }[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const children = new Map<string | null, F[]>();
  for (const folder of folders) {
    const parent = folder.folderId && ids.has(folder.folderId) ? folder.folderId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  for (const list of children.values())
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const result: { folder: F; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | null, depth: number) => {
    for (const folder of children.get(parent) ?? []) {
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      result.push({ folder, depth });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  // Folders only reachable through a loop of parents still get a row each.
  for (const folder of folders)
    if (!seen.has(folder.id)) {
      seen.add(folder.id);
      result.push({ folder, depth: 0 });
      visit(folder.id, 1);
    }
  return result;
}
