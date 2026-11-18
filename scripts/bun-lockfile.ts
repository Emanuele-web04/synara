// Bun lockfile metadata shared by the install and compiler cache keys.

export function normalizeBunLockfile(contents: string): string {
  try {
    // Bun permits trailing commas. Keep commas inside quoted values intact.
    const lockfile = JSON.parse(
      contents.replace(/"(?:[^"\\]|\\.)*"|,(?=\s*[}\]])/g, (token) => (token === "," ? "" : token)),
    ) as { lockfileVersion?: number; workspaces?: Record<string, { version?: string }> };
    if (lockfile.lockfileVersion !== 3 || !lockfile.workspaces) return contents;
    for (const workspace of Object.values(lockfile.workspaces)) {
      if (typeof workspace.version === "string") delete workspace.version;
    }
    return JSON.stringify(lockfile);
  } catch {
    // Unknown lockfile syntax invalidates on every byte change.
    return contents;
  }
}
