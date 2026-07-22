import { statSync } from "node:fs";

/**
 * Missing project CWDs often surface as spawn ENOENT (Node/Effect access the
 * working directory before the binary). Callers must distinguish that from a
 * missing Codex installation so the UI can prompt relocate/reconnect.
 */
export function formatMissingCodexWorkingDirectoryError(cwd: string): string {
  return `Project working directory no longer exists: ${cwd}. Relocate or reconnect the project in Synara.`;
}

export function assertCodexWorkingDirectoryExists(cwd: string): void {
  try {
    const stats = statSync(cwd);
    if (!stats.isDirectory()) {
      throw new Error(
        `Project working directory is not a directory: ${cwd}. Relocate or reconnect the project in Synara.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(formatMissingCodexWorkingDirectoryError(cwd));
    }
    throw error;
  }
}
