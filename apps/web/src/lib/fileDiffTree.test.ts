import type { FileDiffMetadata } from "@pierre/diffs/react";
import { describe, expect, it } from "vitest";

import { filterRenderableFilesForSearch } from "~/components/DiffPanel.logic";
import {
  buildFileDiffTree,
  type FileDiffTreeDirectoryNode,
  type FileDiffTreeNode,
} from "./fileDiffTree";

function createFileDiff(path: string): FileDiffMetadata {
  return {
    cacheKey: path,
    name: path,
    prevName: path,
    hunks: [{ additionLines: 1, deletionLines: 0 }],
  } as FileDiffMetadata;
}

function asDirectory(node: FileDiffTreeNode | undefined): FileDiffTreeDirectoryNode {
  if (!node || node.kind !== "directory") {
    throw new Error(`Expected a directory node, received ${node?.kind ?? "undefined"}`);
  }
  return node;
}

function names(nodes: ReadonlyArray<FileDiffTreeNode>): string[] {
  return nodes.map((node) => node.name);
}

describe("buildFileDiffTree", () => {
  it("returns an empty tree for no files", () => {
    expect(buildFileDiffTree([])).toEqual([]);
  });

  it("groups files into nested directories with directories before files", () => {
    const tree = buildFileDiffTree([
      createFileDiff("apps/server/src/a.ts"),
      createFileDiff("apps/server/src/b.ts"),
      createFileDiff("apps/web/src/c.tsx"),
      createFileDiff("README.md"),
    ]);

    expect(names(tree)).toEqual(["apps", "README.md"]);

    const apps = asDirectory(tree[0]);
    expect(names(apps.children)).toEqual(["server/src", "web/src"]);

    const serverSrc = asDirectory(apps.children[0]);
    expect(serverSrc.name).toBe("server/src");
    expect(serverSrc.path).toBe("apps/server/src");
    expect(names(serverSrc.children)).toEqual(["a.ts", "b.ts"]);
  });

  it("compresses a fully unbranched chain into a single directory row", () => {
    const tree = buildFileDiffTree([createFileDiff("components/ui/widgets/button.tsx")]);
    expect(tree).toHaveLength(1);

    const compressed = asDirectory(tree[0]);
    expect(compressed.name).toBe("components/ui/widgets");
    expect(compressed.path).toBe("components/ui/widgets");
    expect(names(compressed.children)).toEqual(["button.tsx"]);
  });

  it("stops compression at branch points", () => {
    const tree = buildFileDiffTree([
      createFileDiff("src/feature/one.ts"),
      createFileDiff("src/feature/nested/two.ts"),
    ]);

    const root = asDirectory(tree[0]);
    expect(root.name).toBe("src/feature");
    expect(names(root.children)).toEqual(["nested", "one.ts"]);
  });

  it("keeps a same-named file and directory as distinct sibling nodes", () => {
    // deleting file `foo` while adding `foo/bar.ts` yields a directory and file sharing path "foo" — both must survive as siblings (panel disambiguates keys by node kind)
    const tree = buildFileDiffTree([createFileDiff("foo"), createFileDiff("foo/bar.ts")]);
    expect(tree).toHaveLength(2);

    const directory = tree.find((node) => node.kind === "directory");
    const file = tree.find((node) => node.kind === "file");
    expect(directory?.path).toBe("foo");
    expect(file?.path).toBe("foo");
    expect(names(asDirectory(directory).children)).toEqual(["bar.ts"]);
  });

  it("sorts entries with natural, case-insensitive ordering", () => {
    const tree = buildFileDiffTree([
      createFileDiff("file10.ts"),
      createFileDiff("file2.ts"),
      createFileDiff("File1.ts"),
    ]);
    expect(names(tree)).toEqual(["File1.ts", "file2.ts", "file10.ts"]);
  });
});

describe("search → tree pipeline", () => {
  const files = [
    createFileDiff("apps/server/src/codex.ts"),
    createFileDiff("apps/web/src/ChatView.tsx"),
    createFileDiff("packages/shared/src/model.ts"),
  ];

  it("filters files by path substring before building the tree", () => {
    const tree = buildFileDiffTree(filterRenderableFilesForSearch(files, "web"));
    expect(names(tree)).toEqual(["apps/web/src"]);

    const matched = asDirectory(tree[0]);
    expect(names(matched.children)).toEqual(["ChatView.tsx"]);
  });

  it("returns an empty tree when nothing matches", () => {
    expect(buildFileDiffTree(filterRenderableFilesForSearch(files, "no-such-file"))).toEqual([]);
  });
});
