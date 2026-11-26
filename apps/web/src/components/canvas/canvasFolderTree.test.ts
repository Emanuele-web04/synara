import { describe, expect, it } from "vitest";
import { canvasFolderTree } from "./canvasFolderTree";

const folder = (id: string, title: string, folderId: string | null = null) => ({
  id,
  title,
  folderId,
});

describe("canvasFolderTree", () => {
  it("lists each folder before its subfolders, one level deeper, siblings by title", () => {
    const tree = canvasFolderTree([
      folder("mobile", "Mobile", "client"),
      folder("brand", "Brand"),
      folder("archive", "Archive 2026", "mobile"),
      folder("client", "Client work"),
      folder("app", "App", "client"),
    ]);
    expect(tree.map(({ folder: item, depth }) => `${"  ".repeat(depth)}${item.title}`)).toEqual([
      "Brand",
      "Client work",
      "  App",
      "  Mobile",
      "    Archive 2026",
    ]);
  });

  it("puts folders whose parent is not listed at the top, and survives a parent loop", () => {
    const tree = canvasFolderTree([
      folder("a", "A", "b"),
      folder("b", "B", "a"),
      folder("orphan", "Orphan", "missing"),
    ]);
    expect(tree.map(({ folder: item, depth }) => `${depth}:${item.id}`)).toEqual([
      "0:orphan",
      "0:a",
      "1:b",
    ]);
  });
});
