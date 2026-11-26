// FILE: canvasFolderTree.ts
// Purpose: The library's folders as a tree in reading order (each folder followed by its
//          subfolders, by title) with each one's depth, for the Move to menu's indented rows.
// Layer: Canvas UI logic
// Exports: canvasFolderTree

import type { CanvasFolder } from "@synara/contracts";

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
