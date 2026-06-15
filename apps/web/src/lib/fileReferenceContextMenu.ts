// FILE: fileReferenceContextMenu.ts
// Purpose: Right-click menu shared by file rows and file previews (editor
//          explorer, changed-file lists, dock file pane).
// Layer: Web UI helpers
// Exports: showFileReferenceContextMenu

import { formatSelectionLabel, type ChatFileReference } from "~/lib/chatReferences";
import { readNativeApi } from "~/nativeApi";

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
export async function showFileReferenceContextMenu(input: {
  path: string;
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
  const reference: ChatFileReference = {
    path: input.path,
    ...input.selection,
  };
  const rangeLabel = formatSelectionLabel(reference);
  const hasSnippet = typeof reference.snippet === "string" && reference.snippet.trim().length > 0;
  const clicked = await api.contextMenu.show(
    [
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel
                ? `Reference ${rangeLabel} in chat`
                : hasSnippet
                  ? "Reference selection in chat"
                  : "Reference in chat",
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel ? `Ask why ${rangeLabel} changed` : "Ask why this changed",
            },
          ]
        : []),
      { id: "copy-path" as const, label: "Copy path" },
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
  if (clicked === "copy-path") {
    void navigator.clipboard?.writeText(input.path);
  }
}
