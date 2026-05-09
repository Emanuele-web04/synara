// FILE: localImageFiles.ts
// Purpose: Resolves local image preview/download requests without exposing arbitrary files.
// Layer: Server HTTP utility
// Exports: local image route constants and allowlisted path resolver
// Depends on: fs realpath/stat, Codex generated image roots, safe image extensions

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { LOCAL_IMAGE_ROUTE_PATH, isSupportedLocalImagePath } from "@t3tools/shared/localImage";

import { resolveCodexGeneratedImagesRoot } from "./codexGeneratedImages.ts";

export { LOCAL_IMAGE_ROUTE_PATH };

export interface ResolvedLocalImageFile {
  readonly path: string;
  readonly fileName: string;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function realpathOrNull(candidate: string | undefined): Promise<string | null> {
  if (!candidate) {
    return null;
  }
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function findGitRoot(startPath: string): Promise<string | null> {
  let current = path.resolve(startPath);
  while (true) {
    try {
      const stat = await fs.stat(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Keep walking until we hit the filesystem root.
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function temporaryImageRoots(): Promise<string[]> {
  const candidates = [
    os.tmpdir(),
    process.env.TMPDIR,
    process.platform === "darwin" ? "/tmp" : undefined,
  ];
  const roots = await Promise.all(Array.from(new Set(candidates)).map(realpathOrNull));
  return Array.from(new Set(roots.filter((root): root is string => root !== null)));
}

async function resolveWorkspaceRoot(cwd: string | null): Promise<string | null> {
  if (!cwd) {
    return null;
  }
  const realCwd = await realpathOrNull(cwd);
  if (!realCwd) {
    return null;
  }
  const gitRoot = await findGitRoot(realCwd);
  return (gitRoot ? await realpathOrNull(gitRoot) : realCwd) ?? null;
}

export async function resolveAllowedLocalImageFile(input: {
  readonly requestedPath: string | null;
  readonly cwd: string | null;
  readonly codexHomePath?: string;
}): Promise<ResolvedLocalImageFile | null> {
  const requestedPath = input.requestedPath?.trim();
  if (!requestedPath || requestedPath.includes("\0") || !isSupportedLocalImagePath(requestedPath)) {
    return null;
  }

  const resolvedRequestedPath = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(input.cwd ?? process.cwd(), requestedPath);
  const realImagePath = await realpathOrNull(resolvedRequestedPath);
  if (!realImagePath || !isSupportedLocalImagePath(realImagePath)) {
    return null;
  }

  const stat = await fs.stat(realImagePath).catch(() => null);
  if (!stat?.isFile()) {
    return null;
  }

  const [workspaceRoot, generatedImagesRoot, tempRoots] = await Promise.all([
    resolveWorkspaceRoot(input.cwd),
    realpathOrNull(resolveCodexGeneratedImagesRoot(input.codexHomePath)),
    temporaryImageRoots(),
  ]);
  const allowed =
    (workspaceRoot !== null && isPathInside(realImagePath, workspaceRoot)) ||
    (generatedImagesRoot !== null && isPathInside(realImagePath, generatedImagesRoot)) ||
    tempRoots.some((root) => isPathInside(realImagePath, root));
  if (!allowed) {
    return null;
  }

  return {
    path: realImagePath,
    fileName: path.basename(realImagePath),
  };
}
