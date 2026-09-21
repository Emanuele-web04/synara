// LOCATES only, never reads — reading an out-of-root file still requires a preview grant

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { isWorkspaceRelativePathSafe } from "@synara/shared/path";

import { isContainedPath } from "./realPathContainment";

// the cap only guards a pathologically deep workspace path from a long stat loop
const MAX_ANCESTOR_WALK_DEPTH = 32;

async function realpathOrNull(candidate: string): Promise<string | null> {
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function statIsFileOrNull(candidate: string): Promise<boolean> {
  const stat = await fs.stat(candidate).catch(() => null);
  return stat?.isFile() ?? false;
}

function isMissingPathError(cause: unknown): boolean {
  const code = (cause as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** nearest-first ancestor candidates up to home; null on unsafe ref, missing/out-of-home root, existing in-root file, or no candidate */
export async function resolveOutOfRootFileReference(input: {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly homeDir: string;
}): Promise<string | null> {
  const relativePath = input.relativePath.trim();
  if (relativePath.includes("\0") || !isWorkspaceRelativePathSafe(relativePath)) {
    return null;
  }
  const [realHome, realRoot] = await Promise.all([
    realpathOrNull(input.homeDir),
    realpathOrNull(input.workspaceRoot),
  ]);
  if (!realHome || !realRoot || !isContainedPath(realHome, realRoot)) {
    return null;
  }

  const segments = relativePath.split(/[\\/]/);
  const inRootCandidate = path.join(realRoot, ...segments);
  const inRootStat = await fs.stat(inRootCandidate).catch((cause: unknown) => {
    // only a genuinely missing path permits ancestor relocation — other fs failures must not silently pick a different file
    if (!isMissingPathError(cause)) {
      return false;
    }
    return null;
  });
  if (inRootStat === false) {
    return null;
  }
  if (inRootStat !== null) {
    return null;
  }

  let ancestor = path.dirname(realRoot);
  for (
    let depth = 0;
    depth < MAX_ANCESTOR_WALK_DEPTH && isContainedPath(realHome, ancestor);
    depth += 1
  ) {
    const candidate = path.join(ancestor, ...segments);
    const realCandidate = await realpathOrNull(candidate);
    if (
      realCandidate !== null &&
      isContainedPath(realHome, realCandidate) &&
      (await statIsFileOrNull(realCandidate))
    ) {
      return realCandidate;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    ancestor = parent;
  }
  return null;
}
