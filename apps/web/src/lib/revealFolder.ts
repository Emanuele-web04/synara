// FILE: revealFolder.ts
// Purpose: Shared "reveal in folder" action — open a path in the OS file manager
//          through the desktop shell bridge, with a toast on failure.
// Layer: lib

import { showFileManagerErrorToast } from "~/lib/fileManagerErrorToast";
import { readNativeApi } from "~/nativeApi";

export function revealFolderInShell(input: { path: string; onRevealed?: () => void }): void {
  const api = readNativeApi();
  if (!api) {
    showFileManagerErrorToast({
      kind: "folder",
      error: "The desktop connection is not available yet.",
    });
    return;
  }
  void api.shell
    .showInFolder(input.path)
    .then(() => input.onRevealed?.())
    .catch((error) => {
      showFileManagerErrorToast({ kind: "folder", error });
    });
}
