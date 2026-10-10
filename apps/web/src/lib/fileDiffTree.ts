import type { FileDiffMetadata } from "@pierre/diffs/react";

import { compareDiffPaths, resolveFileDiffPath } from "./diffRendering";

export interface FileDiffTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  fileDiff: FileDiffMetadata;
}

export interface FileDiffTreeDirectoryNode {
  kind: "directory";
  name: string;
  path: string;
  children: FileDiffTreeNode[];
}

export type FileDiffTreeNode = FileDiffTreeDirectoryNode | FileDiffTreeFileNode;

interface MutableDirectory {
  name: string;
  path: string;
  directories: Map<string, MutableDirectory>;
  files: FileDiffTreeFileNode[];
}

function createDirectory(name: string, path: string): MutableDirectory {
  return { name, path, directories: new Map(), files: [] };
}

// collapse single-child directory chains (server → src becomes server/src) like VS Code/GitHub; children already finalized so one merge per level suffices — the loop is defensive
function compressDirectory(node: FileDiffTreeDirectoryNode): FileDiffTreeDirectoryNode {
  let current = node;
  while (current.children.length === 1) {
    const onlyChild = current.children[0];
    if (!onlyChild || onlyChild.kind !== "directory") {
      break;
    }
    current = {
      kind: "directory",
      name: `${current.name}/${onlyChild.name}`,
      path: onlyChild.path,
      children: onlyChild.children,
    };
  }
  return current;
}

function finalizeDirectory(directory: MutableDirectory): FileDiffTreeNode[] {
  const directories: FileDiffTreeDirectoryNode[] = [];
  for (const child of directory.directories.values()) {
    directories.push(
      compressDirectory({
        kind: "directory",
        name: child.name,
        path: child.path,
        children: finalizeDirectory(child),
      }),
    );
  }
  // Directories first, then files, matching the editor explorer ordering.
  const sortedDirectories = directories.toSorted((left, right) =>
    compareDiffPaths(left.name, right.name),
  );
  const sortedFiles = directory.files.toSorted((left, right) =>
    compareDiffPaths(left.name, right.name),
  );
  return [...sortedDirectories, ...sortedFiles];
}

export function buildFileDiffTree(files: ReadonlyArray<FileDiffMetadata>): FileDiffTreeNode[] {
  const root = createDirectory("", "");
  for (const fileDiff of files) {
    const path = resolveFileDiffPath(fileDiff);
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      continue;
    }
    const fileName = segments[segments.length - 1] as string;
    let directory = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      const childPath = directory.path ? `${directory.path}/${segment}` : segment;
      let child = directory.directories.get(segment);
      if (!child) {
        child = createDirectory(segment, childPath);
        directory.directories.set(segment, child);
      }
      directory = child;
    }
    directory.files.push({ kind: "file", name: fileName, path, fileDiff });
  }
  return finalizeDirectory(root);
}
