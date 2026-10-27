// FILE: revealFolder.ts
// Purpose: Shared "reveal in folder" action — open a path in the OS file manager
//          through the desktop shell bridge, with a toast on failure.
// Layer: lib

import { t } from "~/i18n";
import { toastManager } from "~/components/ui/toast";
import { readNativeApi } from "~/nativeApi";

export function revealFolderInShell(input: { path: string; onRevealed?: () => void }): void {
  const api = readNativeApi();
  if (!api) {
    toastManager.add({
      type: "error",
      title: t("workspace:revealFolderFailed"),
      description: t("workspace:desktopConnectionUnavailable"),
    });
    return;
  }
  void api.shell
    .showInFolder(input.path)
    .then(() => input.onRevealed?.())
    .catch((error) => {
      toastManager.add({
        type: "error",
        title: t("workspace:revealFolderFailed"),
        description: error instanceof Error ? error.message : t("workspace:anUnknownErrorOccurred"),
      });
    });
}
