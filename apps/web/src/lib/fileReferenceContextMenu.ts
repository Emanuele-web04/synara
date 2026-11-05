// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows, file previews, and chat file
//          links (editor explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu, getRevealInFolderLabel

import { t } from "~/i18n";
import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

export function getRevealInFolderLabel(platform: string): string {
  if (isWindowsPlatform(platform)) {
    return t("workspace:revealExplorer");
  }
  if (isMacPlatform(platform)) {
    return t("workspace:revealFinder");
  }
  return t("workspace:revealFolder");
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(input: {
  path: string;
  /** Absolute path to reveal in the platform file manager. Omit when the
   * surface only knows a repository-relative path. */
  revealPath?: string;
  position: { x: number; y: number };
  /** Line/column range from source views, or a quoted snippet from surfaces
   * without stable source lines (rendered markdown preview). */
  selection?: Omit<ChatFileReference, "path"> | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const revealPath =
    input.revealPath && typeof window !== "undefined" && window.desktopBridge
      ? input.revealPath
      : undefined;
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference, t);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const clicked = await api.contextMenu.show(
    [
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel
                ? t("workspace:referenceRange", { range: rangeLabel })
                : hasSnippet
                  ? t("workspace:referenceSelection")
                  : t("workspace:referenceFile"),
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel
                ? t("workspace:askWhyRangeChanged", { range: rangeLabel })
                : t("workspace:askWhyChanged"),
            },
          ]
        : []),
      ...(revealPath
        ? [
            {
              id: "reveal-in-folder" as const,
              label: getRevealInFolderLabel(getNavigatorPlatform()),
            },
          ]
        : []),
      { id: "copy-path" as const, label: t("common:diff_copyPath") },
    ],
    input.position,
  );
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "reveal-in-folder" && revealPath) {
    try {
      await api.shell.showInFolder(revealPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("workspace:revealFileFailed"),
        description: error instanceof Error ? error.message : t("workspace:revealFileUnknownError"),
      });
    }
    return;
  }
  if (clicked === "copy-path") {
    await copyTextToClipboard(input.path);
  }
}
