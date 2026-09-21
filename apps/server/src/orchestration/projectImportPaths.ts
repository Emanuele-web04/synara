import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";

export function projectImportKey(...parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function canonicalImportPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(absolute);
    return parent === absolute
      ? absolute
      : path.join(await canonicalImportPath(parent), path.basename(absolute));
  }
}

export function importPathIdentity(value: string): string {
  return normalizeWorkspaceRootForComparison(value, { platform: process.platform });
}

export async function importDirectoryExists(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// read Git's local pointer only — discovery never runs hooks, fetches, or changes a checkout
export async function findImportGitWorkspace(
  cwd: string,
): Promise<{ root: string; worktree: string | null } | null> {
  let current = cwd;
  while (true) {
    const gitPath = path.join(current, ".git");
    try {
      const info = await stat(gitPath);
      if (info.isDirectory()) return { root: current, worktree: null };
      if (info.isFile()) {
        const pointer = info.size <= 8192 ? await readFile(gitPath, "utf8") : "";
        const root = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents: pointer,
          path,
          worktreePath: current,
        });
        if (root) return { root: await canonicalImportPath(root), worktree: current };
        return { root: current, worktree: null };
      }
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      )
        throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
