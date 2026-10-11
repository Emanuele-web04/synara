import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { normalizeWorkspaceRootForComparison } from "@synara/shared/threadWorkspace";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";

export function projectImportKey(...parts: ReadonlyArray<string>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// Codex on Windows can store extended-length paths. Resolve their ordinary
// drive/UNC equivalents so a missing child's parent remains a valid root.
export function normalizeWindowsImportPath(value: string): string {
  if (!value.startsWith("\\\\?\\")) return value;
  const rest = value.slice(4);
  if (/^UNC\\/i.test(rest)) return `\\\\${rest.slice(4)}`;
  return /^[a-z]:\\/i.test(rest) ? rest : value;
}

export async function canonicalImportPath(value: string): Promise<string> {
  const absolute = path.resolve(
    process.platform === "win32" ? normalizeWindowsImportPath(value) : value,
  );
  try {
    const physical = await realpath(absolute);
    return process.platform === "win32" ? normalizeWindowsImportPath(physical) : physical;
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

// Read Git's local pointer only; discovery never runs hooks, fetches, or changes a checkout.
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
