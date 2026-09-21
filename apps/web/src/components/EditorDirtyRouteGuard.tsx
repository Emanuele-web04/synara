// Flush editor drafts before route changes, including changes originating outside the editor. Browser shutdown cannot await an RPC, so retain its native unsaved-changes warning while any buffer is dirty.
import { useBlocker } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { flushWorkspaceEditors, hasUnsavedWorkspaceEditors } from "~/lib/workspaceEditorSession";
import { toastManager } from "./ui/toast";

export function EditorDirtyRouteGuard() {
  const client = useQueryClient();
  useBlocker({
    shouldBlockFn: async () => {
      if (!hasUnsavedWorkspaceEditors(client)) return false;
      const saved = await flushWorkspaceEditors(client);
      if (!saved)
        toastManager.add({
          type: "error",
          title: "Could not save editor changes",
          description:
            "Your draft is preserved. Resolve the save error in the editor before leaving.",
        });
      return !saved;
    },
    enableBeforeUnload: () => hasUnsavedWorkspaceEditors(client),
  });
  return null;
}
