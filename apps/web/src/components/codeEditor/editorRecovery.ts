import type { QueryClient } from "@tanstack/react-query";
import { flushWorkspaceEditors, hasUnsavedWorkspaceEditors } from "~/lib/workspaceEditorSession";

/** Failed native module imports are cached for the lifetime of the document.
 * A fresh document retries the whole graph, including failed dependencies.
 * Never unload a native editor draft that could not be saved. */
export async function reloadEditorAfterSave(
  client: QueryClient,
  reload: () => void = () => window.location.reload(),
) {
  if (!(await flushWorkspaceEditors(client)) || hasUnsavedWorkspaceEditors(client)) {
    throw new Error(
      "Your draft is preserved. Resolve unsaved-file errors before retrying the editor.",
    );
  }
  reload();
}
