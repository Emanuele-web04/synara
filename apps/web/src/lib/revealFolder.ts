// FILE: revealFolder.ts
// Purpose: Shared "reveal in folder" action — open a path in the OS file manager
//          through the desktop shell bridge, with a toast on failure.
// Layer: lib

import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";

export function revealFolderInShell(input: { path: string; onRevealed?: () => void }): void {
  const api = readNativeApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: "Unable to open folder",
      description: "The desktop connection is not available yet.",
    });
    return;
  }
  void api.shell
    .showInFolder(input.path)
    .then(() => input.onRevealed?.())
    .catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to open folder",
        description: error instanceof Error ? error.message : "An unknown error occurred.",
      });
    });
}
