// FILE: showInFileManager.ts
// Purpose: Picks between opening a path in the file manager and revealing it inside its folder.
// Layer: Desktop file-manager dispatch
// Depends on: Electron shell methods and the shared macOS app bundle predicate.

import type { Shell } from "electron";
import { isMacAppBundlePath } from "@synara/shared/filesystemPlatform";

/**
 * Folders open in the file manager and files are revealed inside their folder.
 * `openPath` launches a macOS `.app` directory instead of showing it, so app
 * bundles are revealed like files.
 */
export async function showInFileManager(
  resolvedPath: string,
  isDirectory: boolean,
  platform: NodeJS.Platform,
  shell: Pick<Shell, "openPath" | "showItemInFolder">,
): Promise<void> {
  if (isDirectory && !isMacAppBundlePath(resolvedPath, platform)) {
    const errorMessage = await shell.openPath(resolvedPath);
    if (errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
    return;
  }

  shell.showItemInFolder(resolvedPath);
}
