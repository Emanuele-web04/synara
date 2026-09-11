// FILE: showInFileManager.ts
// Purpose: Body of the desktop:show-in-folder IPC handler, kept free of ipcMain
//          so the file-vs-folder branch is unit-testable. Folders are opened in
//          the platform file manager (shell.openPath); files are selected inside
//          their parent folder (shell.showItemInFolder) rather than launched.
// Layer: Desktop main-process helper
// Exports: FileManagerShell, showPathInFileManager

import * as FS from "node:fs";
import * as Path from "node:path";
import type { Shell } from "electron";

export type FileManagerShell = Pick<Shell, "openPath" | "showItemInFolder">;

export async function showPathInFileManager(
  rawPath: unknown,
  shell: FileManagerShell,
): Promise<void> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error("Missing file or folder path.");
  }
  const resolvedPath = Path.resolve(rawPath);

  let stats: FS.Stats;
  try {
    stats = await FS.promises.stat(resolvedPath);
  } catch {
    throw new Error(`File or folder not found: ${resolvedPath}`);
  }

  if (stats.isDirectory()) {
    // shell.openPath resolves with an empty string on success and a
    // platform-specific message on failure; surface that message verbatim.
    const errorMessage = await shell.openPath(resolvedPath);
    if (errorMessage.length > 0) {
      throw new Error(errorMessage);
    }
    return;
  }

  shell.showItemInFolder(resolvedPath);
}
